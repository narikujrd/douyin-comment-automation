#!/usr/bin/env node
/**
 * check-api.mjs — DeepSeek 连通性自检（开工前跑一次）
 *
 * 做三件事：① 找到 key 并脱敏显示来源；② 探测可用模型名；③ 发一条真实的小请求验证端到端。
 * 不做任何发送动作，不碰抖音。耗费 < 100 token。
 *
 * 未配置 key 时（双击 1-验证密钥.bat 的场景）：
 *   会用记事本打开配置文件引导填写，填好保存后按回车即自动重跑，无需重开窗口。
 *
 * 用法：
 *   node scripts/check-api.mjs                # 交互式（推荐，双击 bat 即走这条）
 *   node scripts/check-api.mjs --no-prompt    # 非交互：缺 key 直接退出码 1（自动化用）
 *
 * 日志：logs/check-api.log（只写脱敏内容，绝不含 key 本身）
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient, estimateCost, maskKey, readSecrets, resolveModel } from "./llm-deepseek.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const LOG_DIR = path.join(PROJECT_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "check-api.log");
const NO_PROMPT = process.argv.includes("--no-prompt");
/**
 * 只有真正的控制台才允许交互，管道/重定向下绝不挂起等人按键。
 * CHECK_API_FORCE_TTY=1 是给自动化自测用的开关，绕过 isTTY 判定。
 */
const INTERACTIVE = !NO_PROMPT && (Boolean(process.stdin.isTTY) || process.env.CHECK_API_FORCE_TTY === "1");
/** 打开哪个编辑器：默认记事本；CHECK_API_EDITOR 仅自测用（避免自测时弹出 GUI） */
const EDITOR_CMD = process.env.CHECK_API_EDITOR ?? "";

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFd = fs.openSync(LOG_FILE, "a");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 同时打印到屏幕和日志文件。日志只落脱敏内容。 */
function tee(line = "", isErr = false) {
  const text = String(line);
  if (isErr) console.error(text);
  else console.log(text);
  try {
    fs.writeSync(logFd, text + "\n");
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

/** 输入流意外结束（Ctrl+Z / 窗口被关 / 输入耗尽）时的哨兵值，避免 await 永久挂起 */
const STDIN_CLOSED = "__STDIN_CLOSED__";

/**
 * 复用同一个 readline 实例：每次 ask 新建实例会在关闭时丢掉输入缓冲，
 * 导致"自动化喂了两行输入，第二行读不到"（真实控制台下不易察觉，但行为不可预测）。
 */
let sharedRl = null;
let stdinClosed = false;

function ask(question) {
  return new Promise((resolve) => {
    if (stdinClosed) {
      resolve(STDIN_CLOSED);
      return;
    }
    if (!sharedRl) {
      sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      sharedRl.on("close", () => {
        stdinClosed = true;
      });
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        sharedRl.off("close", onClose);
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    // 关键：输入流若在此之前结束，必须唤醒本次等待，否则 await 永久挂起
    const onClose = () => finish(STDIN_CLOSED);
    sharedRl.once("close", onClose);
    sharedRl.question(question, (answer) => finish(String(answer).trim()));
  });
}

/** 进程结束前调用，否则打开的 readline 会让 Node 挂着不退 */
function closeRl() {
  try {
    sharedRl?.close();
  } catch {
    /* ignore */
  }
}

/**
 * placeholderSource 的形态是 "file:C:\...\secrets.json" 或 "env:DEEPSEEK_API_KEY"，
 * 是给人看的来源标签，**不是可直接使用的路径**。这里取回可编辑的真实文件路径。
 */
function resolveEditableFile(secrets) {
  const src = String(secrets.placeholderSource ?? "");
  if (src.startsWith("file:")) return src.slice("file:".length);
  return secrets.externalFile ?? secrets.internalFile ?? null;
}

/**
 * 兜底：任何未预期异常都翻译成一句人话。
 * 没有这一层，双击运行时窗口里会出现一大段 JS 堆栈，等于"没反应"。
 */
function failSafe(error) {
  const msg = String(error?.message ?? error);
  tee("");
  // 鉴权失败是最常见的"用户填错了"，属于预期内情形，不该甩一段技术错误
  if (/鉴权失败|Authentication Fails|\b401\b/i.test(msg)) {
    tee("❌ 这个 key 被 DeepSeek 拒绝了（HTTP 401：key 不正确或已失效）。");
    tee("   常见原因，按可能性排序：");
    tee("     ① 复制时漏了字符，或多带了空格 / 换行 / 引号；");
    tee("     ② 复制到的不是 DeepSeek 的 key（而是别家服务的）；");
    tee("     ③ 这个 key 已在 platform.deepseek.com 被删除或重置。");
    const target = resolveEditableFile(readSecrets(PROJECT_DIR));
    if (target) tee(`   要去核对的文件：${target}`);
    tee("   改正后重新双击 1-验证密钥.bat 即可。");
  } else {
    tee(`❌ 脚本遇到未预期的错误：${msg}`, true);
  }
  tee(`   日志文件：${LOG_FILE}`);
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }
  process.exit(1);
}
process.on("unhandledRejection", failSafe);
process.on("uncaughtException", failSafe);

/** 外部密钥文件不存在时补一份模板，避免用户对着"文件不存在"发呆 */
function ensureExternalTemplate(file) {
  if (!file || fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const template = {
      _说明: "把 deepseek_api_key 的值换成你的真实 key（以 sk- 开头，约 30 位以上）。保存即可，不要改动其他字段。",
      _改完怎么验证: "回到黑窗口按回车，或双击 1-验证密钥.bat",
      deepseek_api_key: "sk-填你自己的key",
      deepseek_base_url: "https://api.deepseek.com",
      deepseek_model: "",
    };
    fs.writeFileSync(file, JSON.stringify(template, null, 2) + "\n", "utf8");
    return true;
  } catch (error) {
    tee(`⚠️  自动创建模板失败：${error.message}`);
    tee(`     请手动新建该文件并粘贴 config/secrets.example.json 的内容。`);
    return false;
  }
}

function openInNotepad(file) {
  const onError = () => tee(`⚠️  记事本没能自动打开，请手动打开这个文件：${file}`);
  try {
    if (EDITOR_CMD) {
      // 自测钩子：同步等待替代编辑器结束，并把它的输出写进日志，否则失败时无从诊断
      const result = spawnSync(EDITOR_CMD, { shell: true, encoding: "utf8" });
      if (result.stdout?.trim()) tee(result.stdout.trimEnd());
      if (result.stderr?.trim()) tee(result.stderr.trimEnd(), true);
      if (result.error) onError();
      return true;
    }
    const child = spawn("notepad.exe", [file], { stdio: "ignore", detached: false });
    child.on("error", onError);
    return true;
  } catch {
    onError();
    return false;
  }
}

function describeMissing(secrets) {
  const target = resolveEditableFile(secrets);
  tee("");
  tee("❌ 还没读到可用的 API key。");
  if (target) tee(`   位置：${target}`);
  else tee("   现状：环境变量与两个配置文件都没读到 key。");
  if (secrets.placeholderSource) {
    tee("   现状：文件里仍是模板占位文本 → 说明 key 没填进去，或者填了但没有保存。");
    tee("   提示：如果你是在 VS Code 里改的，必须按 Ctrl+S 保存；");
    tee("         标签页标题上的小圆点（●）消失，才算真正写进磁盘。");
  } else {
    tee(`   可选位置：① 环境变量 DEEPSEEK_API_KEY  ② ${secrets.externalFile}（推荐）  ③ ${secrets.internalFile}`);
  }
  return target;
}

tee("");
tee(`════════════════ ${stamp()} ════════════════`);

let secrets = readSecrets(PROJECT_DIR);

// ── 未配置时：引导填写（最多纠正 2 轮） ──────────────────────────────
let rounds = 0;
while (!secrets.apiKey && rounds < 2) {
  const target = describeMissing(secrets);

  if (!INTERACTIVE) {
    tee("");
    tee("   （非交互模式：请手动填写后重跑本脚本）");
    tee(`   日志：${LOG_FILE}`);
    fs.closeSync(logFd);
    process.exit(1);
  }

  rounds += 1;
  tee("");
  tee("   —— 接下来 ——");
  tee("   直接按回车：我用记事本把这个文件打开，你填好后回来再按一次回车");
  tee("   输入 n 再回车：跳过，我自己用别的编辑器弄");
  tee("");
  const choice = await ask("   请选择（回车 = 打开记事本）> ");

  if (choice === STDIN_CLOSED) {
    tee("");
    tee("   窗口的输入已断开，本轮停止。重新双击 1-验证密钥.bat 即可。");
    fs.closeSync(logFd);
    process.exit(1);
  }

  if (choice.toLowerCase() === "n") {
    tee("");
    tee("   已跳过。填好后重新双击 1-验证密钥.bat 即可。");
    tee(`   位置：${target}`);
    fs.closeSync(logFd);
    process.exit(1);
  }

  if (target) {
    if (ensureExternalTemplate(target)) {
      tee(`   已为你新建模板文件：${target}`);
    }
    openInNotepad(target);
  } else {
    tee("   ⚠️  没有可自动打开的文件，请手动创建 config/secrets.local.json 并填入 key。");
    tee("      结构可参照 config/secrets.example.json。");
  }
  tee("");
  tee("   ┌────────────────────────────────────────────────────────┐");
  tee("   │ 记事本已打开，请做三件事：                              │");
  tee("   │   1. 找到 \"sk-填你自己的key\" 这一段，整段删掉           │");
  tee("   │   2. 粘贴你的真实 key（以 sk- 开头）                    │");
  tee("   │   3. 按 Ctrl+S 保存，然后关闭记事本窗口                 │");
  tee("   └────────────────────────────────────────────────────────┘");
  tee("");
  tee("   注意：只替换引号里面的内容，引号和逗号都要保留。");
  tee("");
  const waited = await ask("   填好并保存后，回到这里按回车继续 > ");
  if (waited === STDIN_CLOSED) {
    tee("");
    tee("   窗口的输入已断开，本轮停止。重新双击 1-验证密钥.bat 即可。");
    fs.closeSync(logFd);
    process.exit(1);
  }

  secrets = readSecrets(PROJECT_DIR);
  if (!secrets.apiKey) {
    tee("");
    tee("   ⚠️  还是没读到可用的 key。");
    if (secrets.placeholderSource) {
      tee("       读到的仍是占位文本 —— 大概率是「改了但没保存」，请确认按过 Ctrl+S。");
    } else if (rounds >= 2) {
      tee("       已连续两轮读不到，先停下来。把上面这些提示截图发我即可。");
    }
  }
}

if (!secrets.apiKey) {
  tee("");
  tee("❌ 未能取得可用的 API key，本轮结束。");
  tee(`   日志：${LOG_FILE}`);
  tee("   key 在 platform.deepseek.com → API Keys 页面创建。");
  fs.closeSync(logFd);
  process.exit(1);
}

// ── 已配置：正式验证 ────────────────────────────────────────────────
const cfgPath = path.join(PROJECT_DIR, "config", "reply-rules.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const genCfg = cfg.generation ?? {};
const modelCachePath = path.join(PROJECT_DIR, "state", "model-cache.json");

tee("── DeepSeek 连通性自检 ──");
tee(`密钥来源：${secrets.keySource}`);
tee(`密钥指纹：${maskKey(secrets.apiKey)}`);
tee(`接口地址：${secrets.baseUrl}`);

const resolved = await resolveModel({
  apiKey: secrets.apiKey,
  baseUrl: secrets.baseUrl,
  preferred: secrets.model,
  candidates: [...(genCfg.model_candidates ?? []), "deepseek-flash", "deepseek-v4-flash", "deepseek-chat"],
  cacheFile: modelCachePath,
  onLog: (m) => tee(m),
});

const client = createClient({
  apiKey: secrets.apiKey,
  baseUrl: secrets.baseUrl,
  model: resolved.model,
  maxRetries: 1,
  onWarn: (m) => tee(m, true),
});

tee("");
/**
 * ★ 2026-10-19 修：原来写死 maxTokens=32。
 *   deepseek-flash 是**推理模型**，推理 token 和正文共用 max_tokens：
 *   32 个 token 全被推理链吃光 → finish_reason=length、正文空串，
 *   而脚本仍然打印「✅ 端到端成功」—— 等于把失败当成功，最需要它报警的时候它不报。
 *   512 足够覆盖推理 + 一句正文；仍为空时会明确告警（见下）。
 */
tee("发一条真实请求验证端到端（max_tokens=512）…");
const { content, usage } = await client.chat(
  [
    { role: "system", content: "你是评论回复助理，只输出回复正文，不超过 60 个字符。" },
    { role: "user", content: "评论原文：讲得真好，学到了\n请写一条回复。" },
  ],
  { maxTokens: 512 },
);

const gotBody = Boolean(content && content.trim());
tee("");
tee(gotBody ? "✅ 端到端成功" : "⚠️ 连接成功，但模型没有返回正文");
tee(`   模型：${resolved.model}${resolved.fromCache ? "（读缓存）" : "（本次探测）"}`);
tee(`   返回：${gotBody ? content.trim() : "（空）"}`);
tee(`   用量：入 ${usage.prompt_tokens ?? "?"} / 出 ${usage.completion_tokens ?? "?"} tokens`);
if (!gotBody) {
  tee("");
  tee("   key 本身是有效的（能连上、有 usage），但这次没拿到正文。");
  tee("   最常见原因：推理链把 max_tokens 吃光了。判定/生成链路都有更大的预算");
  tee("   （generation.judge_max_output_tokens=768、max_output_tokens=1024），不受影响。");
}

const cost = estimateCost(
  {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
  },
  genCfg.price_per_1m,
);
tee(`   本次费用 ≈ ¥${cost.cny.toFixed(4)}`);

const perThousand = cost.cny * 1000;
tee("");
tee("粗估：按本项目\"每条评论约 2 次调用（风险判定 + 文案生成）\"的用法，");
tee(`      1000 条评论 ≈ ¥${perThousand.toFixed(2)} 量级（以官方账单为准）。`);
tee("      注意：deepseek-flash 是推理模型，推理 token 也按输出计费；");
tee("      上方为单次小请求的线性外推，实测真实批处理约 ¥0.3 / 1000 条，即比此数高一个量级。");
tee("");
tee("下一步：双击 2-扫码登录.bat（需你本人扫码，AI 不代劳）。");
tee(`日志已写入：${LOG_FILE}`);

closeRl();
fs.closeSync(logFd);
