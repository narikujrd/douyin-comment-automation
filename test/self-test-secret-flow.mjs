#!/usr/bin/env node
/**
 * self-test-secret-flow.mjs — 「填 key → 验证」这条链路的离线回归测试
 *
 * 为什么需要它：这条路是**用户唯一必须亲手操作**的环节，一旦回归，用户只会看到
 * "双击没反应"，而 AI 无从远端诊断。所以把三种典型状态固化成断言：
 *   A. 还是模板占位（用户没保存）→ 必须明确指出"占位/没保存"
 *   B. 已填好 → 必须能读出来（并显示脱敏来源）
 *   C. 交互式引导 → 必须真的调用编辑器、填完后继续，且任何情况下都不挂起
 *
 * 全部在**临时沙盒目录**里跑（DOUYIN_AUTOMATION_HOME 覆盖），
 * 并通过不可达的 baseUrl 避免真实网络请求 —— 绝不触碰用户真实密钥文件。
 *
 * 用法：node test/self-test-secret-flow.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const CHECK_API = path.join(PROJECT_DIR, "scripts", "check-api.mjs");

const PLACEHOLDER = "sk-填你自己的key";
const FAKE_KEY = "sk-" + "sandboxtestkey".repeat(3); // 长 51，非占位

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dy-secret-test-"));
const secretsFile = path.join(sandbox, "secrets.json");
const fakeEditor = path.join(sandbox, "fake-editor.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function writeSecrets(key) {
  fs.writeFileSync(
    secretsFile,
    JSON.stringify(
      { _说明: "回归测试沙盒", deepseek_api_key: key, deepseek_base_url: "http://127.0.0.1:9", deepseek_model: "" },
      null,
      2,
    ),
    "utf8",
  );
}

// 假编辑器：把占位替换成假 key，模拟"用户打开文件、粘贴、Ctrl+S 保存"
fs.writeFileSync(
  fakeEditor,
  `import fs from "node:fs";\nimport path from "node:path";\n` +
    `const file = path.join(process.env.DOUYIN_AUTOMATION_HOME, "secrets.json");\n` +
    `const data = JSON.parse(fs.readFileSync(file, "utf8"));\n` +
    `data.deepseek_api_key = ${JSON.stringify(FAKE_KEY)};\n` +
    `fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");\n` +
    `console.log("[fake-editor] key 已写入");\n`,
  "utf8",
);

function run(args, extraEnv = {}, input = undefined) {
  return spawnSync(process.execPath, [CHECK_API, ...args], {
    env: {
      ...process.env,
      DOUYIN_AUTOMATION_HOME: sandbox,
      DEEPSEEK_API_KEY: "",
      ...extraEnv,
    },
    input,
    encoding: "utf8",
    timeout: 60000,
  });
}

console.log("── 「填 key → 验证」链路回归测试 ──");
console.log(`沙盒：${sandbox}\n`);

// ── A. 还是占位（用户改了没保存） ─────────────────────────────────
writeSecrets(PLACEHOLDER);
const a = run(["--no-prompt"]);
const aOut = `${a.stdout}${a.stderr}`;
check("A1 占位时明确指出「占位文本」", aOut.includes("模板占位文本"));
check("A2 占位时提示「可能没保存」", aOut.includes("没有保存") || aOut.includes("Ctrl+S"));
check("A3 占位时退出码为 1", a.status === 1, `实际 ${a.status}`);
check("A4 占位时不误报成功", !aOut.includes("端到端成功"));

// ── B. 已填好 → 能读出来 ──────────────────────────────────────────
writeSecrets(FAKE_KEY);
const b = run(["--no-prompt"]);
const bOut = `${b.stdout}${b.stderr}`;
check("B1 已填 key 时能识别来源（不再是 none）", bOut.includes(`密钥来源：file:`), bOut.match(/密钥来源：.*/)?.[0] ?? "");
check("B2 显示脱敏指纹，不打印明文 key", bOut.includes("sk-san") && bOut.includes("***") && !bOut.includes(FAKE_KEY));
check("B3 网络不可达时不抛原始堆栈", !bOut.includes("at Object.") && !bOut.includes("Node.js v"));
check("B4 网络失败时仍以退出码 1 结束", b.status === 1, `实际 ${b.status}`);

// ── C. 交互式引导 ────────────────────────────────────────────────
writeSecrets(PLACEHOLDER);
const editCmd = `"${process.execPath}" "${fakeEditor}"`;
const c = run([], { CHECK_API_FORCE_TTY: "1", CHECK_API_EDITOR: editCmd }, "\n");
const cOut = `${c.stdout}${c.stderr}`;
const afterC = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
check("C1 回车后确实调用了编辑器", cOut.includes("fake-editor"), "假编辑器有输出");
check("C2 编辑器写入生效（模拟用户保存）", afterC.deepseek_api_key === FAKE_KEY);
check("C3 输入耗尽时脚本不挂起（有退出码）", typeof c.status === "number" && c.status !== 13 && c.status !== null, `实际 ${c.status}`);
check("C4 提示里给出了「在哪做」的明确路径", cOut.includes(secretsFile));

// ── D. 用户的真实密钥文件绝不能被本测试碰到 ──────────────────────
const realFile = path.join(os.homedir(), ".douyin-automation", "secrets.json");
if (fs.existsSync(realFile)) {
  const real = JSON.parse(fs.readFileSync(realFile, "utf8"));
  check("D1 真实密钥文件未被本测试改写", real.deepseek_api_key !== FAKE_KEY);
} else {
  check("D1 真实密钥文件未被本测试创建", true, "该文件尚不存在");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`沙盒已清理：${sandbox}`);
process.exit(failed.length ? 1 : 0);
