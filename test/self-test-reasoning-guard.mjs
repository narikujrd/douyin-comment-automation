#!/usr/bin/env node
/**
 * self-test-reasoning-guard.mjs — 推理模型空正文护栏的回归测试
 *
 * 背景（2026-10-15 真实翻车）：
 *   deepseek-flash 是**推理模型**，回复前先输出 reasoning_content，且推理 token
 *   计入 max_tokens。裁决层原本硬编码 max_tokens=128，风险提示词的推理链要
 *   350–500 token → 128 被推理链吃光 → content 为空串、finish_reason="length"
 *   → JSON.parse("") 抛错 → 被 catch 成「语义判定返回非 JSON，保守归软拦截」
 *   → **正常提问（"这个参数怎么设置？"）被静默地不回复**。
 *
 *   症状之所以恶劣，是因为它"看起来像正常工作"：报告里写着"软拦截"，
 *   像是模型判定有风险，实际是额度给少了。所以本测试锁三件事：
 *     ① 客户端必须把「空正文 / 被截断」显式带出来，不能当合法返回；
 *     ② 配置里的裁决层额度不得低于安全下限，且不得再被调回硬编码小值；
 *     ③ 客户端不能因为"返回空"就抛错崩掉整轮（要能优雅降级）。
 *
 * 不发任何网络请求（用假 fetch）。用法：node test/self-test-reasoning-guard.mjs
 *
 * @secret-scan-allow 本文件内含形如 sk- 的**假串**，用途是给客户端当入参断言样本；
 *   不含任何真实密钥。已在 config/secret-scan-allow.json 登记。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../scripts/llm-deepseek.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 造一个假响应：可选地返回空正文 + finish_reason=length，并带上推理 token 数 */
function fakeFetch({ content, finishReason = "stop", reasoningTokens = 0 }) {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        id: "x",
        model: "deepseek-flash",
        choices: [
          {
            message: { role: "assistant", content, reasoning_content: reasoningTokens ? "推理链…" : undefined },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: 800,
          completion_tokens: reasoningTokens,
          completion_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      });
    },
  });
}

console.log("【一】客户端必须把「空正文 + 被截断」显式带出来");
{
  const warns = [];
  const client = createClient({
    apiKey: "sk-fake-not-real-000000000000",
    model: "deepseek-flash",
    fetchImpl: fakeFetch({ content: "", finishReason: "length", reasoningTokens: 128 }),
    maxRetries: 1,
    onWarn: (m) => warns.push(m),
  });
  const r = await client.chat([{ role: "user", content: "hi" }], { maxTokens: 128 });
  check("空正文时 empty=true", r.empty === true);
  check("finish_reason=length 时 truncated=true", r.truncated === true, `finishReason=${r.finishReason}`);
  check("带出推理 token 数（用于诊断）", r.reasoningTokens === 128, `reasoningTokens=${r.reasoningTokens}`);
  check("必须发出告警（不允许静默）", warns.some((w) => w.includes("空正文")), `告警 ${warns.length} 条`);
  check(
    "告警里点明原因指向 max_tokens（而不是含糊的「模型出错」）",
    warns.some((w) => w.includes("max_tokens")),
  );
}

console.log("");
console.log("【二】正常返回不得被误报为空");
{
  const warns = [];
  const client = createClient({
    apiKey: "sk-fake-not-real-000000000000",
    model: "deepseek-flash",
    fetchImpl: fakeFetch({ content: '{"level":"none"}', finishReason: "stop", reasoningTokens: 300 }),
    maxRetries: 1,
    onWarn: (m) => warns.push(m),
  });
  const r = await client.chat([{ role: "user", content: "hi" }], { maxTokens: 768 });
  check("empty=false", r.empty === false);
  check("truncated=false", r.truncated === false);
  check("内容原样返回", r.content === '{"level":"none"}');
  check("正常返回不产生告警", warns.length === 0, `告警 ${warns.length} 条`);
}

console.log("");
console.log("【三】空正文不得让整轮崩掉（要能降级）");
{
  const client = createClient({
    apiKey: "sk-fake-not-real-000000000000",
    model: "deepseek-flash",
    fetchImpl: fakeFetch({ content: "", finishReason: "length", reasoningTokens: 64 }),
    maxRetries: 1,
    onWarn: () => {},
  });
  let threw = false;
  try {
    await client.chat([{ role: "user", content: "hi" }], { maxTokens: 64 });
  } catch {
    threw = true;
  }
  check("空正文不抛错（调用方按 empty 自行降级）", threw === false);
}

console.log("");
console.log("【四】配置里的裁决层额度必须够推理链用");
{
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"));
  const gen = cfg.generation ?? {};
  const judgeMax = Number(gen.judge_max_output_tokens ?? 0);
  const genMax = Number(gen.max_output_tokens ?? 0);
  check("存在 generation.judge_max_output_tokens", judgeMax > 0, `当前 ${judgeMax}`);
  check("裁决层额度 ≥ 384（实测安全下限）", judgeMax >= 384, `当前 ${judgeMax}`);
  check("生成额度 ≥ 512", genMax >= 512, `当前 ${genMax}`);
  check("已标注为推理模型（提醒后来者留余量）", gen.reasoning_model === true);
}

console.log("");
console.log("【五】judge.mjs 不得再把裁决层额度写死成小常数");
{
  const src = fs.readFileSync(path.join(PROJECT_DIR, "scripts", "judge.mjs"), "utf8");
  check("从配置读取额度（judge_max_output_tokens）", src.includes("judge_max_output_tokens"));
  const bad = /jsonMode:\s*true\s*,\s*maxTokens:\s*(?:64|128|192|256)\b/.exec(src);
  check("不再出现 jsonMode + 硬编码小额度", bad === null, bad ? `仍存在：${bad[0]}` : "");
  check("有启动期额度体检（低于下限告警）", src.includes("JUDGE_TOKEN_FLOOR"));
  check("语义判定降级会被计数并上报", src.includes("semanticDegraded"));
}

console.log("");
console.log("================ 结果 ================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
