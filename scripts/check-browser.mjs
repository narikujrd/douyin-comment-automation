#!/usr/bin/env node
/**
 * check-browser.mjs — 浏览器环境自检（第 2 步开工前跑）
 *
 * 为什么需要它（2026-10-15）：
 *   作者双击 2-扫码登录.bat，看到的是
 *     'npm' is not recognized as an internal or external command
 *   窗口里**没有二维码**。先修了 npm 路径问题，紧接着发现第二个坑：
 *   Chromium 内核其实从来没下载成功（ms-playwright 目录里只有一个 __dirlock）。
 *   两个坑叠在一起，从"没有二维码"这一个现象完全推不出来。
 *
 *   所以把"能不能跑起来浏览器"拆成一个独立的只读自检：不发任何抖音请求，
 *   不开有头窗口，一次性把四个前提条件查清楚并给出**人话结论**。
 *
 * 用法：
 *   node scripts/check-browser.mjs              # 完整自检（会联网打开一次页面）
 *   node scripts/check-browser.mjs --offline    # 只查本地文件，不联网
 *
 * 退出码：0 = 可以扫码；非 0 = 有前置条件没满足（见输出）。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const TOOL_DIR = path.join(PROJECT_DIR, "tool");
const OFFLINE = process.argv.includes("--offline");

const CREATOR_COMMENT_URL =
  "https://creator.douyin.com/creator-micro/content/manage";

let failed = 0;
const say = (msg = "") => console.log(msg);
const ok = (msg) => say(`  ✅ ${msg}`);
const bad = (msg) => {
  failed += 1;
  say(`  ❌ ${msg}`);
};
const warn = (msg) => say(`  ⚠️  ${msg}`);

say("");
say("── 浏览器环境自检（第 2 步：扫码登录）──");
say(`项目目录：${PROJECT_DIR}`);
say("");

/* ── 1. 工具目录 ─────────────────────────────────────────── */
say("【1】第三方工具目录");
if (!fs.existsSync(path.join(TOOL_DIR, "package.json"))) {
  bad(`缺少 ${path.join(TOOL_DIR, "package.json")}`);
  say("     处置：工具仓库没克隆完整，需要重新克隆 wenyg/douyin-creator-tools。");
  say("");
  say(`自检中断：前置条件不满足（${failed} 项失败）。`);
  process.exit(1);
}
ok(`工具目录存在：${TOOL_DIR}`);

if (!fs.existsSync(path.join(TOOL_DIR, "node_modules"))) {
  bad("依赖未安装（没有 node_modules）");
  say("     处置：在 tool 目录跑 npm install（约 187 个包）。");
} else {
  const count = fs.readdirSync(path.join(TOOL_DIR, "node_modules")).length;
  ok(`依赖已安装（node_modules 下 ${count} 个条目）`);
}

/* ── 2. playwright 模块 ──────────────────────────────────── */
say("");
say("【2】playwright 模块");
let playwright = null;
let pwVersion = "?";
try {
  // 从 tool 目录解析，确保用的是工具自己的依赖，而不是别处的
  const requireFromTool = createRequire(path.join(TOOL_DIR, "package.json"));
  playwright = requireFromTool("playwright");
  pwVersion = requireFromTool("playwright/package.json").version;
  ok(`加载成功，版本 ${pwVersion}`);
} catch (error) {
  bad(`无法加载 playwright：${error.message}`);
  say("     处置：依赖没装全，在 tool 目录重跑 npm install。");
}

/* ── 3. 浏览器内核 ───────────────────────────────────────── */
say("");
say("【3】Chromium 内核");
let exePath = null;
if (playwright) {
  try {
    exePath = playwright.chromium.executablePath();
  } catch (error) {
    bad(`取内核路径失败：${error.message}`);
  }
}
if (exePath) {
  if (fs.existsSync(exePath)) {
    const mb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
    ok(`内核已就位：${exePath}（${mb} MB）`);
  } else {
    bad(`内核缺失：${exePath}`);
    say("     这就是「双击后没有二维码」的常见原因之一：浏览器压根起不来。");
    say("     处置（用项目自带的多线程下载器，约 15–30 分钟，视网络而定）：");
    say(`       cd "${PROJECT_DIR}"`);
    say("       node scripts/fetch-chromium.mjs");
    say("     ⚠️ 不要用国内镜像：cdn.npmmirror.com 的 builds/cft/ 只有 148–156 版，");
    say("        没有当前需要的 145.0.7632.6，会直接 404。");
    say("     ⚠️ 也不要用 `npx playwright install chromium`：官方源单线程仅约 67 KB/s，");
    say("        173 MB 要跑 40–60 分钟（而且中途失败过一次）。");
  }
} else if (playwright) {
  warn("无法确定内核路径（playwright 未报错但也没有结果）");
}

/* ── 4. 登录态存档目录 ───────────────────────────────────── */
say("");
say("【4】登录态存档（profile）");
const profileDir = path.join(TOOL_DIR, ".playwright", "douyin-profile");
if (fs.existsSync(profileDir)) {
  const entries = fs.readdirSync(profileDir).length;
  if (entries > 0) {
    ok(`已存在存档：${profileDir}（${entries} 个条目）→ 可能已经登录过`);
  } else {
    warn(`存档目录是空的：${profileDir} → 还没登录过`);
  }
} else {
  warn(`存档目录尚未创建：${profileDir}（第一次扫码后会自动生成）`);
}

/* ── 5. 浏览器能否真正启动 ＋ 目标页面是否可达 ───────────── */
say("");
say("【5】实际启动无头浏览器 ＋ 访问创作者中心");
if (!playwright || !exePath || !fs.existsSync(exePath)) {
  warn("内核不可用，跳过本节（先按上面【3】的处置修好再看）");
} else if (OFFLINE) {
  warn("--offline 模式，跳过网络检查");
} else {
  let browser = null;
  try {
    /**
     * 显式传 executablePath：新版 Playwright 在 headless 模式下默认会去找
     * 单独打包的 "chromium-headless-shell"，那是**另一个 155 MB 的内核**。
     * 本项目只需要有头浏览器（扫码用），不必再多下一个。
     * 指定 executablePath 后，headless 也用这个完整内核跑。
     */
    browser = await playwright.chromium.launch({ headless: true, executablePath: exePath });
    ok(`浏览器启动成功：${browser.version()}`);

    const page = await browser.newPage();
    let status = null;
    try {
      const resp = await page.goto(CREATOR_COMMENT_URL, { timeout: 30000, waitUntil: "domcontentloaded" });
      status = resp?.status() ?? null;
      const title = (await page.title()).slice(0, 60);
      if (status !== null && status < 400) {
        ok(`创作者中心可达（HTTP ${status}）｜页面标题：${title || "(空)"}`);
      } else {
        warn(`页面返回 HTTP ${status}（可能是登录跳转，属正常）｜标题：${title}`);
      }
      ok("网络与目标站点连通 —— 扫码时浏览器能正常加载登录页");
    } catch (error) {
      bad(`访问创作者中心失败：${String(error.message).slice(0, 120)}`);
      say("     处置：检查网络 / 代理；若公司网络拦截了 creator.douyin.com，需放行。");
    }
  } catch (error) {
    bad(`浏览器启动失败：${String(error.message).slice(0, 200)}`);
    say("     处置：内核文件可能不完整，删掉 ms-playwright 缓存后重新 install chromium。");
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ── 6. node 是否在 PATH ─────────────────────────────────── */
say("");
say("【6】node / npm 在 PATH 中的可见性");
const nodeWhich = spawnSync("node", ["-v"], { shell: true, encoding: "utf8" });
if (nodeWhich.status === 0) {
  ok(`PATH 里的 node：${String(nodeWhich.stdout).trim()}`);
} else {
  warn("PATH 里找不到 node（不影响双击 .bat —— 那两个脚本会自己定位绝对路径）");
}
const npmWhich = spawnSync("npm", ["-v"], { shell: true, encoding: "utf8" });
if (npmWhich.status === 0) {
  ok(`PATH 里的 npm：${String(npmWhich.stdout).trim()}`);
} else {
  warn("PATH 里找不到 npm —— 这是原始报错 'npm is not recognized' 的来源。");
  say("     现已修：2-扫码登录.bat 会自己定位 npm 的绝对路径，不再依赖 PATH。");
}

/* ── 结论 ────────────────────────────────────────────────── */
say("");
say("──────────────── 结论 ────────────────");
if (failed === 0) {
  say("✅ 可以扫码：双击 2-扫码登录.bat，浏览器窗口里会出现登录页 / 二维码。");
  say("   你本人扫码，AI 不代劳（登录态泄漏等于账号被劫持，比密钥更值钱）。");
} else {
  say(`❌ 有 ${failed} 项前置条件没满足，先按上面的「处置」逐条修，再跑这一步。`);
}
say("");

process.exit(failed === 0 ? 0 : 1);
