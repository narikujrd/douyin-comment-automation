#!/usr/bin/env node
/**
 * fetch-chromium.mjs — 多线程下载 Playwright 的 Chromium 内核
 *
 * 为什么不直接用 `npx playwright install chromium`（2026-10-15 实测）：
 *   · 官方源 `cdn.playwright.dev` 单线程实测 **约 67 KB/s**，而内核要下 173 MB。
 *     它**不会失败，只是极慢**——同一天那一次官方命令在后台账面上跑了
 *     **3 小时 22 分**才结束（不落下任何报错，所以很容易被误判成"中断了"）。
 *   · 国内镜像 `cdn.npmmirror.com` / `registry.npmmirror.com` 的 `builds/cft/`
 *     只覆盖 148–156 版，**没有 Playwright 1.58 需要的 145.0.7632.6** → 镜像用不了。
 *   · 但官方源 **支持 Range 分段**（`Accept-Ranges: bytes`）。
 *     本脚本按 Range 分段并发拉、按序拼接、解压到 Playwright 期望的位置。
 *
 * ⚠️ 关于速率的诚实说明：本项目记录的"10 秒基准 631 KB/s → 长跑 130 KB/s、
 *    全程 26.5 分钟"**不能当作该源的真实速率**。那 26.5 分钟里，上面提到的官方
 *    命令正在并发下载 108.8 MB，两者抢同一条带宽。主因是并发抢带宽，不是"源会降速"。
 *    干净环境应更快；但这个偏保守的数字不影响结论（分段下载仍然远快于官方命令）。
 *
 * 所以：自己按 Range 分段并发拉，再拼接、解压到 Playwright 期望的位置。
 * 关键防线：**每条连接带停滞看门狗**——实测出现过 7 条收完后最后 1 条拖 15 分钟，
 * 没有超时会让整个下载永久挂住。
 *
 * 版本不自创：从 playwright-core/browsers.json 读 revision 与 browserVersion，
 * playwright 升级后本脚本自动跟着走，不需要改代码。
 *
 * 用法：node scripts/fetch-chromium.mjs [--threads 8] [--keep]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const TOOL_DIR = path.join(PROJECT_DIR, "tool");

const argv = process.argv.slice(2);
const threadsIdx = argv.indexOf("--threads");
const THREADS = threadsIdx >= 0 ? Math.max(1, Math.min(16, Number(argv[threadsIdx + 1]) || 8)) : 8;
const KEEP_PARTS = argv.includes("--keep");

const log = (m = "") => console.log(m);

/* ── 1. 从 playwright 自己的清单里读版本，不硬编码 ─────────────── */
/**
 * 注意：`playwright-core/browsers.json` 与 `package.json` 都不在包的 exports 白名单里，
 * 用 require.resolve / createRequire 会被 ERR_PACKAGE_PATH_NOT_EXPORTED 拒掉
 * （2026-10-15 实测踩到）。所以直接按文件路径读。
 */
const CORE_DIR = path.join(TOOL_DIR, "node_modules", "playwright-core");
const browsersJsonPath = path.join(CORE_DIR, "browsers.json");
const corePkgPath = path.join(CORE_DIR, "package.json");
if (!fs.existsSync(browsersJsonPath)) {
  throw new Error(
    `找不到 ${browsersJsonPath}\n请先在 tool 目录执行 npm install（依赖未安装）。`,
  );
}
const browsers = JSON.parse(fs.readFileSync(browsersJsonPath, "utf8"));
const coreVersion = JSON.parse(fs.readFileSync(corePkgPath, "utf8")).version;
const chromium = browsers.browsers.find((b) => b.name === "chromium");
if (!chromium) throw new Error("browsers.json 里找不到 chromium 条目");
const { revision, browserVersion } = chromium;

const URL_ZIP = `https://cdn.playwright.dev/builds/cft/${browserVersion}/win64/chrome-win64.zip`;
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const CACHE_DIR = path.join(LOCALAPPDATA, "ms-playwright");
const DEST_DIR = path.join(CACHE_DIR, `chromium-${revision}`);
const EXE_EXPECTED = path.join(DEST_DIR, "chrome-win64", "chrome.exe");

log("");
log("── 下载 Chromium 内核（多线程）──");
log(`  playwright 版本 : ${coreVersion}`);
log(`  内核 revision   : ${revision}（Chrome for Testing ${browserVersion}）`);
log(`  目标目录        : ${DEST_DIR}`);
log(`  并发线程        : ${THREADS}`);
log("");

if (fs.existsSync(EXE_EXPECTED)) {
  log(`  ✅ 内核已存在，无需下载：${EXE_EXPECTED}`);
  log("");
  process.exit(0);
}

/* ── 2. 探出文件大小，确认支持分段 ───────────────────────────── */
log("  正在探测文件大小…");
let totalSize = 0;
{
  const res = await fetch(URL_ZIP, { method: "HEAD", redirect: "follow" });
  if (!res.ok) throw new Error(`HEAD 请求失败：HTTP ${res.status}`);
  totalSize = Number(res.headers.get("content-length") ?? 0);
  const ranges = res.headers.get("accept-ranges");
  if (!totalSize) throw new Error("拿不到 Content-Length，无法分段");
  if (ranges && ranges !== "bytes") {
    log(`  ⚠️  该源似乎不支持分段（accept-ranges=${ranges}），将退化为单线程`);
  }
  log(`  文件大小：${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

/* ── 3. 分段并发下载 ─────────────────────────────────────────── */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-chromium-"));
const partPaths = [];
const chunkSize = Math.ceil(totalSize / THREADS);
let doneBytes = 0;
let lastPrintAt = 0;
let lastPct = -1;

/** 进度条：只在「整百分比变化」或距上次 ≥1 秒时才重画，避免刷屏把日志撑爆 */
function printProgress(force = false) {
  const pct = Math.floor((doneBytes / totalSize) * 100);
  const now = Date.now();
  if (!force && pct === lastPct && now - lastPrintAt < 1000) return;
  lastPrintAt = now;
  lastPct = pct;
  const mb = (doneBytes / 1024 / 1024).toFixed(1);
  const all = (totalSize / 1024 / 1024).toFixed(1);
  const barLen = 28;
  const filled = Math.round((doneBytes / totalSize) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${mb}/${all} MB   `);
}

/** 单条连接「多久没收到任何数据」就判定为停滞并重来 */
const STALL_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

async function fetchRange(index, start, end) {
  const partPath = path.join(tmpDir, `part-${String(index).padStart(3, "0")}`);
  partPaths[index] = partPath;
  const expected = end - start + 1;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /**
     * 必须有停滞看门狗。2026-10-15 实测：8 条连接里 7 条正常收完，
     * 剩下 1 条几乎不动、拖了 15 分钟。没有超时的话，一条卡死的连接
     * 会让整个下载**永久挂住**——而且因为其他分片都已完成，看起来像"快好了"。
     */
    const controller = new AbortController();
    let lastByteAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > STALL_TIMEOUT_MS) controller.abort();
    }, 5000);

    let streamed = 0;
    try {
      const res = await fetch(URL_ZIP, {
        headers: { Range: `bytes=${start}-${end}` },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

      const out = fs.createWriteStream(partPath);
      const src = Readable.fromWeb(res.body);
      src.on("data", (chunk) => {
        streamed += chunk.length;
        doneBytes += chunk.length;
        lastByteAt = Date.now();
        printProgress();
      });
      await pipeline(src, out);

      if (streamed !== expected) throw new Error(`长度不符：收到 ${streamed}，期望 ${expected}`);
      return;
    } catch (error) {
      // 把本次已计入的字节扣回去，重试时重新统计，否则进度会虚高
      doneBytes -= streamed;
      printProgress(true);
      const reason = controller.signal.aborted ? `停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒` : error.message;
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`分段 ${index} 重试 ${MAX_ATTEMPTS} 次仍失败（${reason}）`);
      }
      log("");
      log(`  ⚠️  分段 ${index} ${reason}，第 ${attempt} 次重试…`);
    } finally {
      clearInterval(watchdog);
    }
  }
}

log("");
log(`  开始并发下载（${THREADS} 段）…`);
const startedAt = Date.now();
const tasks = [];
for (let i = 0; i < THREADS; i += 1) {
  const start = i * chunkSize;
  const end = Math.min(totalSize - 1, start + chunkSize - 1);
  if (start > end) break;
  tasks.push(fetchRange(i, start, end));
}
try {
  await Promise.all(tasks);
} catch (error) {
  printProgress(true);
  log("");
  log(`  ❌ 下载失败：${error.message}`);
  log("     处置：重跑本脚本；若持续失败，改用官方命令（慢）:");
  log(`       cd "${TOOL_DIR}" && npx playwright install chromium`);
  process.exit(1);
}
printProgress(true);
const secs = Number(((Date.now() - startedAt) / 1000).toFixed(0));
const avgKbps = (totalSize / 1024 / Math.max(1, secs)).toFixed(0);
log("");
log(`  ✅ 下载完成：${(totalSize / 1024 / 1024).toFixed(1)} MB，用时 ${secs} 秒（平均 ${avgKbps} KB/s）`);

/* ── 4. 按顺序拼回一个 zip ───────────────────────────────────── */
const zipPath = path.join(tmpDir, "chrome-win64.zip");
log("  正在拼接分片…");
{
  const out = fs.createWriteStream(zipPath);
  for (const p of partPaths) {
    if (!p || !fs.existsSync(p)) continue;
    await pipeline(fs.createReadStream(p), out, { end: false });
  }
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
}
const zipSize = fs.statSync(zipPath).size;
if (zipSize !== totalSize) {
  log(`  ❌ 拼接后大小不符：${zipSize} ≠ ${totalSize}`);
  process.exit(1);
}
log(`  ✅ 拼接完成：${(zipSize / 1024 / 1024).toFixed(1)} MB`);

/* ── 5. 解压到 Playwright 期望的位置 ─────────────────────────── */
fs.mkdirSync(DEST_DIR, { recursive: true });
log(`  正在解压到 ${DEST_DIR} …`);
// Windows 自带的 tar（bsdtar）能直接解 zip，比 PowerShell Expand-Archive 快得多
let extracted = false;
const tarTry = spawnSync("tar", ["-xf", zipPath, "-C", DEST_DIR], { encoding: "utf8" });
if (tarTry.status === 0 && fs.existsSync(EXE_EXPECTED)) {
  extracted = true;
} else {
  log("    （tar 解压未成功，改用 PowerShell Expand-Archive，会慢一些）");
  const psTry = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${DEST_DIR}' -Force`],
    { encoding: "utf8" },
  );
  if (psTry.status === 0 && fs.existsSync(EXE_EXPECTED)) extracted = true;
}

/* ── 6. 校验 ＋ 补安装标记 ───────────────────────────────────── */
if (!extracted || !fs.existsSync(EXE_EXPECTED)) {
  log("  ❌ 解压后仍找不到 chrome.exe，目录结构可能不符预期。");
  log(`     期望：${EXE_EXPECTED}`);
  process.exit(1);
}
fs.writeFileSync(path.join(DEST_DIR, "INSTALLATION_COMPLETE"), "", "utf8");

const exeMb = (fs.statSync(EXE_EXPECTED).size / 1024 / 1024).toFixed(1);
log(`  ✅ 内核就位：${EXE_EXPECTED}（${exeMb} MB）`);

if (!KEEP_PARTS) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

log("");
log("  ✅ 全部完成。下一步：node scripts/check-browser.mjs");
log("");
