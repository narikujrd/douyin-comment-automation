#!/usr/bin/env node
/**
 * run-batch.mjs — 批量执行入口（你点一次 = 跑一轮）
 *
 * ★ 2026-10-16 性能优化：执行体已换成 scripts/run-session.mjs（单浏览器会话）。
 *   旧实现（works → comments:export → comments:reply 三次独立会话，每步各开一遍
 *   创作者中心、各扫一遍作品列表）备份在 scripts/run-batch.legacy.mjs，仅供应急回退。
 *   本文件保留：参数解析、--dry-run 前置检查、安全剥离说明、子进程管理。
 *
 * 默认 stage 1（只读）：定位 → 采集 → 裁决。**本阶段物理上不会发送任何回复。**
 * stage 2（发送）必须显式指定 `--stage 2`，否则不执行发送环节。
 *
 * 用法：
 *   node scripts/run-batch.mjs                          # 批 1：只读；跑哪些作品由「控制台」决定
 *   node scripts/run-batch.mjs --work "作品标题片段"     # 只处理你指定的那个作品（覆盖控制台设置）
 *   node scripts/run-batch.mjs --all-works              # 全量（覆盖控制台设置）
 *   node scripts/run-batch.mjs --max-works 3            # 配 --all-works 时限制数量
 *   node scripts/run-batch.mjs --stage 2                # 批 2：在批 1 基础上发送
 *   node scripts/run-batch.mjs --stage 2 --reply-dry-run # 批 2 演练：浏览器里真打字，但不点「发送」
 *   node scripts/run-batch.mjs --gen llm|template|auto  # 文案生成方式（默认 auto＝有 key 就用 LLM）
 *   node scripts/run-batch.mjs --risk-llm off           # 关闭 LLM 语义风险判定（省钱）
 *   node scripts/run-batch.mjs --fresh-works            # 强制重新拉取完整作品列表（默认复用本地列表）
 *   node scripts/run-batch.mjs --headless               # 后台运行：不弹出浏览器窗口（自动模式下由控制台开关控制）
 *
 * 运行范围（跑哪些作品）默认读 config/works-switch.json，由控制台页面（3-控制台.bat）维护：
 *   latest   = 只跑最新作品（按发布时间取，不依赖列表顺序）
 *   selected = 只跑页面里勾选的作品（直接复用本地作品列表，不再每次重拉）
 *   all      = 全部作品（强制拉取完整列表）
 * 命令行 --work / --all-works 优先级更高，用于临时覆盖。
 *
 * 容错：单个作品出错只跳过该作品并记录，**不再中断整批**；
 * 但只要有一个作品失败，进程退出码就是 1 —— 前端才能据此说「异常结束」而不是「正常结束」。
 *
 * ★ 启动子脚本一律走「node 直连」：不经 npm/cmd。原因见 tool-runner.mjs 头注释（两次生产事故）。
 *
 * ★ 安全：run-session.mjs 会加载第三方 tool/ 的模块，因此它（及其内部拉的 judge 子进程环境）
 *   一律不注入 DEEPSEEK_API_KEY —— judge 自己按 环境变量 → ~/.douyin-automation/secrets.json
 *   → config/secrets.local.json 的顺序解析密钥（实测来源 = 外部 secrets.json）。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { TOOL_DIR } from "./tool-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const SESSION_SCRIPT = path.join(PROJECT_DIR, "scripts", "run-session.mjs");

const FLAGS = ["verbose", "dry-run", "all-works", "reply-dry-run", "fresh-works", "debug", "headless"];

function parseArgs(argv) {
  const args = { stage: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (FLAGS.includes(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${key} 缺少取值`);
    args[name] = value;
    i += 1;
  }
  if (args.stage) args.stage = Number(args.stage);
  if (args["max-works"]) args.maxWorks = Number(args["max-works"]);
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (![1, 2].includes(args.stage)) throw new Error("--stage 只支持 1 或 2");

/**
 * 2026-10-16 发现：`--ui-timeout-ms` 这个参数**从来没有被 tool 接受过** ——
 * tool 内部的 uiTimeoutMs 只存在于代码默认值（30s），上游仅在报错文案里提过
 * 「Try --ui-timeout-ms 60000」，参数解析里并没有实现。传下去只会得到
 * 「Unknown argument: --ui-timeout-ms」，而且会把「导出超时」这个真正的原因掩盖掉。
 * 这里显式忽略并说明，不搞静默。
 */
if (args["ui-timeout-ms"]) {
  console.log("[!] --ui-timeout-ms 已忽略：tool/ 并不支持该参数（上游未实现）。");
  console.log("    评论区域加载失败会自动原样重试一次；仍失败请看该作品行上方的报错原文。");
  delete args["ui-timeout-ms"];
}
if (args["reply-dry-run"] && args.stage !== 2) {
  console.log("[!] --reply-dry-run 只在 --stage 2 下有效（stage 1 本来就只读、不发送）。");
}

const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
};

/**
 * 安全：run-session 会加载第三方 tool/ 的模块（tool/ 是外部克隆仓库，带 187 个 npm 依赖），
 * 必须从它的环境里剥掉密钥——否则任何一个被投毒的依赖都能 process.env 直接读走。
 * judge 是**本项目脚本**，密钥由它自己从外部 secrets.json 解析（见文件头）。
 */
const stripList = (() => {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"),
    );
    const list = cfg.security?.secrets?.strip_from_child_env;
    return Array.isArray(list) && list.length ? list : ["DEEPSEEK_API_KEY"];
  } catch {
    return ["DEEPSEEK_API_KEY"];
  }
})();
const envForSession = { ...env };
const strippedKeys = [];
for (const key of stripList) {
  if (key in envForSession) {
    delete envForSession[key];
    strippedKeys.push(key);
  }
}
if (strippedKeys.length) {
  console.log(`[安全] 已从子进程环境剥离：${strippedKeys.join(", ")}（judge 走外部 secrets.json，不受影响）`);
}

/**
 * 跑子进程：输出原样透传（控制台页面靠这个实时显示），同时缓存末尾若干行 —— 失败时一起塞进错误信息。
 * 失败信息必须自带现场：真正有用的线索就是子进程最后那几行，不能让用户自己去翻。
 */
function runChild({ bin, argv, cwd, env: childEnv, label }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { cwd, env: childEnv, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${label} 启动失败：${error.message}\n  命令：${bin} ${argv.join(" ")}`));
      return;
    }

    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const tails = { out: "", err: "" };
    const tee = (stream, key) => (buf) => {
      stream.write(buf);
      tails[key] = (tails[key] + decoders[key].write(buf)).slice(-8000);
    };
    child.stdout.on("data", tee(process.stdout, "out"));
    child.stderr.on("data", tee(process.stderr, "err"));

    child.on("error", (error) => {
      reject(new Error(`${label} 启动失败：${error.message}\n  命令：${bin} ${argv.join(" ")}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = `${tails.out}\n${tails.err}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-12);
      reject(
        new Error(
          `${label} 失败（退出码 ${code}）\n` +
            (tail.length ? `  【最近输出】\n${tail.map((line) => `    ${line}`).join("\n")}\n` : "") +
            "  （若上面输出含「需要登录 / 跳转到登录页」→ 请本人重新扫码登录；" +
            "若含 DOUYIN_BROWSER_BUSY → 已有实例在跑，等它结束）",
        ),
      );
    });
  });
}

if (args["dry-run"]) {
  console.log("\n[dry-run] 仅做前置检查与计划打印，不执行任何外部命令、不打开浏览器、不发任何请求。");
  console.log(`  stage=${args.stage}（${args.stage === 1 ? "只读，物理不含发送" : "含发送"})`);
  console.log(`  --gen=${args.gen ?? "auto（有 key 走 llm，无 key 回落模板）"}｜--risk-llm=${args["risk-llm"] ?? "auto"}`);
  console.log(`  作品范围：${args.work ? `--work「${args.work}」` : args["all-works"] ? "--all-works" : "控制台设置（config/works-switch.json）"}`);
  console.log(`  列表策略：${args["fresh-works"] ? "强制重新拉取完整列表" : "selected/latest 优先复用本地列表（更快）"}`);
  console.log(`  密钥是否在当前环境：${process.env.DEEPSEEK_API_KEY ? "是（将被剥离后再传给子进程）" : "否（judge 走外部 secrets.json）"}`);
  console.log("\n[dry-run] 结束。");
  process.exit(0);
}

async function main() {
  const childArgs = [SESSION_SCRIPT];
  if (args.stage === 2) childArgs.push("--stage", "2");
  if (args.work) childArgs.push("--work", String(args.work));
  if (args["all-works"]) childArgs.push("--all-works");
  if (args.maxWorks) childArgs.push("--max-works", String(args.maxWorks));
  if (args.gen) childArgs.push("--gen", String(args.gen));
  if (args["risk-llm"]) childArgs.push("--risk-llm", String(args["risk-llm"]));
  if (args["reply-dry-run"]) childArgs.push("--reply-dry-run");
  if (args["fresh-works"]) childArgs.push("--fresh-works");
  if (args.debug) childArgs.push("--debug");
  if (args.verbose) childArgs.push("--verbose");
  if (args.headless) childArgs.push("--headless");

  const label =
    `单会话（定位→采集→裁决${args.stage === 2 ? "→发送" : ""}）` +
    (args["reply-dry-run"] ? " · 演练（不点发送）" : "");

  console.log(`\n[${label}] node scripts/run-session.mjs ${childArgs.slice(1).join(" ")}`.trimEnd());

  // cwd 给 tool/：run-session 内部还会自行 chdir（双保险），这里给上让 cwd 语义可预期。
  await runChild({
    bin: process.execPath,
    argv: childArgs,
    cwd: TOOL_DIR,
    env: envForSession,
    label,
  });
}

main().catch((error) => {
  console.error(`\n运行中断：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
