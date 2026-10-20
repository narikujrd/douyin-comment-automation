/**
 * tool-runner.mjs — 启动 tool/（外部克隆仓库）里脚本的**唯一**入口。
 *
 * 为什么不让 npm/cmd 代劳（两次生产事故，都发生在 2026-10-16）：
 *   ① Node ≥ 20.12 在 Windows 上 `spawn("npm.cmd", …, {shell:false})` 会**同步抛 EINVAL**
 *      （CVE-2024-27980 的修复）→ 任务锁不回滚、永久卡在「运行中」。
 *   ② `spawn("npm", […], {shell:true})` 把参数用空格 join 后整串交给 cmd.exe，
 *      **不做引号保护**。本项目路径含空格（`F:\AI agent workbuddy数据\…`），
 *      `judged-work-01.json` 的完整路径被 cmd 从空格处劈成三段，
 *      tool 端收到 `F:\AI`、`agent`、`workbuddy数据\…`，报 `Unknown argument: agent`，
 *      发送链路整体失败 —— 而且日志里那一行 agent 极易被误判成登录失效/浏览器占用。
 *   `npm run x` 的实质就是 `node <对应 .mjs>`：直连 node 把两个坑一起绕开，
 *   参数按 argv 数组原样传递（含空格 / 中文 / 引号都安全）。
 *
 * ui-server.mjs 的 `/api/refresh-works` 出于同样理由也是直接 node（见那里的注释）。
 *
 * 用法：
 *   import { toolCommand } from "./tool-runner.mjs";
 *   const { bin, argv, cwd, display } = toolCommand("comments:reply", [judgedPath]);
 *   spawn(bin, argv, { cwd, env, stdio: … });
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(HERE, "..", "tool");

/**
 * npm script 名 → tool/ 内的实际脚本（对应 tool/package.json 的 scripts 段）。
 * 新增工具时先把映射记在这里，不要在调用处临时拼 npm 命令。
 */
export const TOOL_SCRIPTS = {
  works: "src/list-douyin-works.mjs",
  "comments:export": "src/export-douyin-comments.mjs",
  "comments:reply": "src/reply-douyin-comments.mjs",
};

/**
 * 构造「用 node 直接跑 tool 脚本」的命令描述。
 * @param {string} scriptName TOOL_SCRIPTS 里的键（= npm script 名）
 * @param {string[]} extraArgs 原样传给脚本的参数（顺序不变，不做任何字符串拼接）
 */
export function toolCommand(scriptName, extraArgs = []) {
  const rel = TOOL_SCRIPTS[scriptName];
  if (!rel) {
    throw new Error(
      `未知的 tool 脚本「${scriptName}」。已知：${Object.keys(TOOL_SCRIPTS).join(" / ")}。` +
        "（要跑新脚本请先在 TOOL_SCRIPTS 登记「npm script 名 → 脚本文件」，不要临时拼 npm 命令。）",
    );
  }
  const displayArgs = extraArgs
    .map((arg) => {
      const text = String(arg);
      return /[ \t]/.test(text) ? `"${text}"` : text;
    })
    .join(" ");
  return {
    bin: process.execPath,
    argv: [path.join(TOOL_DIR, rel), ...extraArgs.map(String)],
    cwd: TOOL_DIR,
    display: `node tool/${rel} ${displayArgs}`.trim(),
  };
}
