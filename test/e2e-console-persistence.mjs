/**
 * 端到端：控制台「保存可靠性」验证（需要真实服务 + 本机 Chrome）
 *
 * 为什么单独立一个文件（而不是并进 self-test-console.mjs）：
 *   self-test 是纯 Node 静态断言，秒级、无外部依赖；
 *   这个要开真浏览器、真写盘，成本高一档，但**它是唯一能证明"改动不会静默丢"的测试**。
 *   凡动到 ui/index.html 的保存/渲染逻辑，改完请手动跑一次。
 *
 * 前置：
 *   ① 服务已在跑（双击 3-控制台.bat，或 node scripts/ui-server.mjs）
 *   ② 本机装了 Chrome（默认路径见下，可用环境变量 CHROME_PATH 覆盖）
 *   ③ tool/node_modules 里有 playwright-core（抖音登录那套的依赖，直接用）
 *
 * 跑法（在项目根目录）：
 *   <node> test/e2e-console-persistence.mjs
 *
 * 开场六组场景，对应 2026-10-16 作者报的「改了、保存了，关掉重开又没了」，
 * 以及 2026-10-17（C-23）「保存人设后就应该一直都是改后的那版」：
 *   A 改人设（未保存）→ 点「保存规则」   —— 修复前：人设被静默清掉
 *   B 语境填完直接关窗口（不等失焦）     —— 修复前：一个字都没存
 *   C 语境填完静置 1.8 秒（防抖自动保存）
 *   D 语境失焦立即保存（回归）
 *   E 清空说明（空串 = 显式删除）
 *   F 人设改名 → 保存 → 刷新页面仍是改后的名字
 *
 * 全程备份 + finally 恢复 4 个配置文件，不会留下测试数据。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, "..");
const CFG = path.join(PROJ, "config");
const FILES = ["personas.json", "persona-rotation.json", "reply-rules.json", "works-switch.json", "work-context.json"];

const require = createRequire(path.join(PROJ, "tool", "noop.js")); // 只为解析 playwright-core
const { chromium } = require("playwright-core");

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
/**
 * ★ 2026-10-19 修：默认端口原来写死 5180 —— 那是另一份副本的端口。
 *   本仓库默认 5190（config/instance.json），两份副本常常同时在跑，
 *   结果这个测试连到**另一份副本**的页面上操作，而备份/恢复的却是本项目的 config，
 *   表现为「#pTone 一直不可见」并在第一个用例就超时。
 *   现在从 instance.json 读端口，复制出去的新副本也不会再错。
 */
const INSTANCE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CFG, "instance.json"), "utf8"));
  } catch {
    return {};
  }
})();
const PORT = Number(INSTANCE.port) || 5190;
const URL = process.env.CONSOLE_URL || `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 备份 ----
const backup = {};
for (const f of FILES) backup[f] = fs.readFileSync(path.join(CFG, f), "utf8");
const restore = () => {
  for (const f of FILES) fs.writeFileSync(path.join(CFG, f), backup[f], "utf8");
  console.log(`\n[恢复] ${FILES.length} 个配置文件已还原到运行前`);
};
const mt = (f) => fs.statSync(path.join(CFG, f)).mtimeMs;
const readCfg = (f) => JSON.parse(fs.readFileSync(path.join(CFG, f), "utf8"));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const open = async () => {
  const p = await browser.newPage();
  p.on("dialog", async (d) => { await d.accept(); }); // beforeunload 确认框：自动接受
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  /**
   * ★ 2026-10-19：设置类章节默认收起（回复规则 / 试一句话 / 运行）。
   *   本测试要直接操作表单控件，先全部展开 —— 否则 #rMax 这类元素
   *   会因 `section.collapsed > *:not(h2){display:none}` 一直不可见（实测超时 30s）。
   */
  await p.evaluate(() => document.querySelectorAll("section").forEach((s) => s.classList.remove("collapsed")));
  await p.waitForTimeout(150);
  return p;
};

const verdicts = [];
try {
  // ═══ A：改人设（未保存）→ 点「保存规则」═══
  console.log("═══ A：改人设后（未保存）点「保存规则」═══");
  {
    const page = await open();
    await page.fill("#pTone", "【e2e-A】没点过保存的人设改动");
    await page.fill("#rMax", "43");
    await page.click("button:has-text('保存规则')");
    await page.waitForTimeout(1800);
    const kept = (await page.inputValue("#pTone")).includes("e2e-A");
    const hint = (await page.innerText("#personaSaved")).trim();
    console.log("  人设改动:", kept ? "✅ 保住了" : "❌ 被清掉");
    console.log("  未保存提示:", JSON.stringify(hint.slice(0, 30)));
    verdicts.push(["A 改人设→保存规则（改动不被清）", kept]);
    await page.close({ runBeforeUnload: true });
  }

  /**
   * ★ 2026-10-19：B~E 依赖第 1 节的作品列表（`.work-ctx input` 来自作品行）。
   *   副本刚建好、还没点过「重新拉取列表」时，这里一个输入框都没有 ——
   *   原实现会 fill 干等 30 秒然后整场崩掉。现在明确跳过并说明原因。
   */
  const hasWorks = await (async () => {
    const p = await open();
    const n = await p.locator(".work-ctx input").count();
    await p.close({ runBeforeUnload: true });
    return n > 0;
  })();
  if (!hasWorks) {
    console.log("⚠️ 第 1 节没有作品，跳过 B~E（先点「重新拉取列表」，再跑这几项）");
  }

  if (hasWorks) {
  // ═══ B：语境填完直接关窗口 ═══
  console.log("\n═══ B：语境框填值后 400ms 内直接关窗口（不等失焦/防抖）═══");
  {
    const page = await open();
    await page.fill(".work-ctx input", "【e2e-B】填完就关窗口");
    await sleep(400);
    const m1 = mt("work-context.json");
    await page.close({ runBeforeUnload: true });
    await sleep(1500);
    const saved = mt("work-context.json") !== m1;
    console.log("  关页后写盘:", saved ? "✅ 写了（keepalive 兜底）" : "❌ 没写");
    verdicts.push(["B 语境填完就关窗口（keepalive 兜底）", saved]);
  }

  // ═══ C：防抖自动保存 ═══
  console.log("\n═══ C：语境填值 → 静置 1.8 秒（防抖自动保存）═══");
  {
    const page = await open();
    const m0 = mt("work-context.json");
    await page.fill(".work-ctx input", "【e2e-C】等自动保存");
    await sleep(1800);
    const saved = mt("work-context.json") !== m0;
    const tag = await page.locator(".ctx-tag").first().innerText();
    console.log("  写盘:", saved ? "✅ 写了" : "❌ 没写", "| 行内标签:", JSON.stringify(tag));
    verdicts.push(["C 防抖自动保存", saved]);
    await page.close({ runBeforeUnload: true });
  }

  // ═══ D：失焦立即保存 ═══
  console.log("\n═══ D：语境框失焦立即保存 ═══");
  {
    const page = await open();
    const m0 = mt("work-context.json");
    await page.fill(".work-ctx input", "【e2e-D】失焦");
    await page.click("h2");
    await sleep(1200);
    const saved = mt("work-context.json") !== m0;
    console.log("  写盘:", saved ? "✅ 写了" : "❌ 没写");
    verdicts.push(["D 失焦保存", saved]);
    await page.close({ runBeforeUnload: true });
  }

  // ═══ E：清空说明（空串 = 显式删除）═══
  console.log("\n═══ E：清空说明 ═══");
  {
    const page = await open();
    await page.fill(".work-ctx input", "");
    await page.click("h2");
    await sleep(1200);
    const cleared = Object.keys(readCfg("work-context.json").works).length === 0;
    console.log("  清空:", cleared ? "✅ 已清" : "❌ 没清掉");
    verdicts.push(["E 清空说明", cleared]);
    await page.close({ runBeforeUnload: true });
  }
  } // ← hasWorks（B~E）
  // ═══ F：人设改名 → 保存 → 刷新 ═══
  console.log("\n═══ F：人设改名 → 点保存 → 刷新页面 ═══");
  {
    const page = await open();
    const renamed = "【e2e-F】改后的人设";
    await page.fill("#pName", renamed);
    await page.waitForTimeout(200);
    await page.click("button:has-text('保存人设')");
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const nameAfter = await page.inputValue("#pName");
    const card = await page.locator("#personaList .pcard", { hasText: renamed }).count();
    const noRestore = (await page.locator("text=恢复上一次保存").count()) === 0;
    console.log("  刷新后表单:", JSON.stringify(nameAfter), "| 卡片:", card ? "有新名字" : "没有新名字");
    verdicts.push(["F 保存后刷新仍是改后的名字", nameAfter === renamed && card === 1]);
    verdicts.push(["F 页面上没有「恢复上一次保存」", noRestore]);
    await page.close({ runBeforeUnload: true });
  }
} finally {
  await browser.close();
  restore();
}

console.log("\n════════ 结论 ════════");
let fail = 0;
for (const [name, ok] of verdicts) {
  console.log("  " + (ok ? "✅" : "❌") + " " + name);
  if (!ok) fail += 1;
}
console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
