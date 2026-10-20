/**
 * llm-deepseek.mjs — DeepSeek API 极薄客户端（D-01 方案 C）
 *
 * 设计原则：
 *  1. 只用 Node 内置 fetch，不引入任何三方 SDK（少一个依赖少一个坑）。
 *  2. 模型名**不硬编码**：官方已把 deepseek-chat / deepseek-reasoner 标记弃用，
 *     改为按候选列表探测，命中的写回 state/model-cache.json。
 *  3. 密钥来源优先级：环境变量 DEEPSEEK_API_KEY > config/secrets.local.json。
 *     密钥只在内存里流转，**从不打印、从不写入任何日志或输出文件**。
 *  4. 失败必须显式抛出，不静默返回空串——空串在平台工具里等于"跳过"，会被误读成"风险拦截"。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSecretInMessages } from "./security.mjs";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_CANDIDATES = ["deepseek-flash", "deepseek-v4-flash", "deepseek-chat"];

/**
 * 项目树外的密钥位置（推荐）：不在项目目录内，第三方依赖扫描项目时够不到。
 * DOUYIN_AUTOMATION_HOME 可覆盖该目录（自测沙盒 / 想把密钥放别处的高级用法）。
 */
export const EXTERNAL_SECRETS_FILE = process.env.DOUYIN_AUTOMATION_HOME
  ? path.join(process.env.DOUYIN_AUTOMATION_HOME, "secrets.json")
  : path.join(os.homedir(), ".douyin-automation", "secrets.json");

function tryReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 密钥来源优先级：
 *   1. 环境变量 DEEPSEEK_API_KEY（不落盘，最不易泄漏）
 *   2. 项目树外的 ~/.douyin-automation/secrets.json（推荐落盘位置）
 *   3. 项目内 config/secrets.local.json（方便，但第三方依赖理论上可读）
 */

/**
 * 识别"模板占位值"。
 * 为什么必须做：模板里写着 sk-填你自己的key，如果不识别，它会被当成真实 key
 * 一路传到接口，用户看到的是"调用失败"，而不是"你还没填 key"——
 * 错因指向错误的地方，比直接报错更浪费时间。
 */
const PLACEHOLDER_HINTS = [
  "填你自己的key",
  "填你的",
  "YOUR_API_KEY",
  "your_api_key",
  "changeme",
  "CHANGE_ME",
  "xxxxxx",
  "******",
];

export function looksLikePlaceholder(value) {
  const v = String(value ?? "").trim();
  if (!v) return true;
  if (PLACEHOLDER_HINTS.some((hint) => v.includes(hint))) return true;
  if (/^sk-[*x]+$/i.test(v)) return true;
  if (v.length < 24) return true; // 真实 DeepSeek key 远长于此
  return false;
}

export function readSecrets(projectDir) {
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  const externalFile = EXTERNAL_SECRETS_FILE;
  const internalFile = path.join(projectDir, "config", "secrets.local.json");

  const external = tryReadJson(externalFile);
  const internal = tryReadJson(internalFile);

  const candidates = [
    ["env:DEEPSEEK_API_KEY", fromEnv],
    [`file:${externalFile}`, String(external.deepseek_api_key ?? "").trim()],
    [`file:${internalFile}`, String(internal.deepseek_api_key ?? "").trim()],
  ];

  // 首个「非空且非占位」的来源胜出；全部为空 → none；只有占位 → 记下位置以便明确报错
  const picked = candidates.find(([, v]) => v && !looksLikePlaceholder(v));
  const placeholderSource = picked ? null : (candidates.find(([, v]) => v)?.[0] ?? null);

  return {
    apiKey: picked ? picked[1] : "",
    baseUrl: String(external.deepseek_base_url || internal.deepseek_base_url || DEFAULT_BASE_URL).replace(/[/]+$/, ""),
    model: String(external.deepseek_model ?? internal.deepseek_model ?? "").trim(),
    keySource: picked ? picked[0] : "none",
    /** 非 null 表示「找到的只是模板占位值」，用于把错因指回正确位置 */
    placeholderSource,
    configFile: internalFile,
    externalFile,
    internalFile,
  };
}


export function maskKey(key) {
  if (!key) return "(未配置)";
  if (key.length <= 12) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 6)}***${key.slice(-4)}（长度 ${key.length}）`;
}

class FatalApiError extends Error {}

/**
 * 创建客户端。fetchImpl 可注入，用于离线自测（--gen mock）。
 */
export function createClient(options) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model,
    timeoutMs = 40000,
    maxRetries = 3,
    fetchImpl = globalThis.fetch,
    maxOutputTokens = 512,
    temperature = 1.0,
    onWarn = () => {},
  } = options;

  if (!apiKey) throw new Error("缺少 DeepSeek API key：请设置环境变量 DEEPSEEK_API_KEY 或填写 config/secrets.local.json");
  if (!model) throw new Error("缺少模型名：createClient 需要显式传入已探测成功的 model");

  const stats = { calls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

  async function chat(messages, opts = {}) {
    const body = {
      model,
      messages,
      stream: false,
      temperature: opts.temperature ?? temperature,
      max_tokens: opts.maxTokens ?? maxOutputTokens,
    };
    if (opts.jsonMode) body.response_format = { type: "json_object" };

    // 出站前最后一道封口：密钥绝不允许出现在提示词里。
    // 一旦进了上下文，理论上就可能被模型回显到**公开评论**上——代价不可逆，所以宁可硬失败。
    const leak = assertNoSecretInMessages(messages, apiKey);
    if (leak) {
      throw new FatalApiError(`拒绝发送：${leak}。这是安全闸门，不是网络错误——请检查调用方是否把密钥拼进了提示词。`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const raw = await response.text();

        if (!response.ok) {
          const detail = raw.slice(0, 300);
          if (response.status === 401 || response.status === 403) {
            throw new FatalApiError(`鉴权失败（HTTP ${response.status}）：key 不正确、已失效或未开通。${detail}`);
          }
          if (response.status === 400 && /model/i.test(detail)) {
            throw new FatalApiError(`模型名不被接受（HTTP 400）：${detail}`);
          }
          if (response.status === 402) {
            throw new FatalApiError(`余额不足（HTTP 402）：请到 platform.deepseek.com 充值。${detail}`);
          }
          if ([429, 500, 502, 503, 504].includes(response.status)) {
            lastError = new Error(`HTTP ${response.status}：${detail}`);
            const waitMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
            onWarn(`[llm] 第 ${attempt} 次请求失败（${lastError.message.slice(0, 80)}），${waitMs}ms 后重试`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          throw new FatalApiError(`请求失败（HTTP ${response.status}）：${detail}`);
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new FatalApiError(`响应不是合法 JSON（前 200 字）：${raw.slice(0, 200)}`);
        }

        const choice = parsed?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string") {
          throw new FatalApiError(`响应缺少 choices[0].message.content：${raw.slice(0, 200)}`);
        }

        stats.calls += 1;
        const usage = parsed.usage ?? {};
        stats.promptTokens += Number(usage.prompt_tokens ?? 0);
        stats.completionTokens += Number(usage.completion_tokens ?? 0);
        stats.cacheHitTokens += Number(usage.prompt_cache_hit_tokens ?? 0);
        stats.cacheMissTokens += Number(usage.prompt_cache_miss_tokens ?? 0);

        /**
         * ── 推理模型护栏（2026-10-15 实测 deepseek-flash 后补）─────────────────
         * deepseek-flash 回复前先输出 reasoning_content，且**推理 token 计入 max_tokens**。
         * 若 max_tokens 给得太小，token 会被推理链整个吃光 → content 是空串、
         * finish_reason="length"。此时若把空串当成"合法返回"，调用方只会看到
         * "模型说没风险/没话说"，错因（额度给少了）被完全藏起来。
         * 代价实例：裁决层 max_tokens=128 时，正常提问「这个参数怎么设置？」被判软拦截不回复。
         * 因此这里必须把「截断」这个事实显式带出去并在告警里点明，绝不静默。
         */
        const finishReason = String(choice?.finish_reason ?? "");
        const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0);
        const truncated = finishReason === "length";
        const empty = content.trim() === "";
        if (empty) {
          onWarn(
            `[llm] ⚠️ 模型返回空正文（finish_reason=${finishReason || "?"}，推理 token=${reasoningTokens}，` +
              `本次 max_tokens=${body.max_tokens}）。` +
              (truncated
                ? " 原因几乎肯定是 max_tokens 被推理链吃光 → 请调大该值（裁决层见 generation.judge_max_output_tokens）。"
                : " 请检查提示词是否只要求模型输出推理内容。"),
          );
        }

        return { content, usage, model: parsed.model ?? model, finishReason, reasoningTokens, truncated, empty };
      } catch (error) {
        if (error instanceof FatalApiError) throw error;
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          lastError = new Error(`请求超时（>${timeoutMs}ms）`);
        } else {
          lastError = error;
        }
        stats.failedCalls += 1;
        if (attempt === maxRetries) break;
        const waitMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
        onWarn(`[llm] 第 ${attempt} 次请求异常（${String(lastError.message).slice(0, 80)}），${waitMs}ms 后重试`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw new Error(`DeepSeek 请求重试 ${maxRetries} 次仍失败：${lastError?.message ?? "未知错误"}`);
  }

  return { chat, stats, model, baseUrl };
}

/**
 * 探测可用模型名。按候选顺序逐个试（每次只花 1 个 token），命中即返回。
 * 探测结果缓存到 state/model-cache.json，避免每轮都试。
 */
export async function resolveModel(options) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    preferred,
    candidates = DEFAULT_MODEL_CANDIDATES,
    cacheFile,
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch,
    onLog = () => {},
  } = options;

  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (cached?.model && cached?.baseUrl === baseUrl) {
        onLog(`[llm] 使用缓存模型名：${cached.model}（${cached.resolvedAt}）`);
        return { model: cached.model, fromCache: true };
      }
    } catch {
      /* 无缓存，继续探测 */
    }
  }

  const ordered = [...new Set([preferred, ...candidates].filter(Boolean))];
  const tried = [];

  for (const model of ordered) {
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      if (response.ok) {
        onLog(`[llm] 模型探测成功：${model}`);
        if (cacheFile) {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(
            cacheFile,
            `${JSON.stringify({ model, baseUrl, resolvedAt: new Date().toISOString() }, null, 2)}\n`,
            "utf8",
          );
        }
        return { model, fromCache: false, tried };
      }
      if (response.status === 401 || response.status === 403) {
        throw new FatalApiError(`鉴权失败（HTTP ${response.status}）：key 不正确或已失效。${raw.slice(0, 200)}`);
      }
      if (response.status === 402) {
        throw new FatalApiError(`余额不足（HTTP 402）：请到 platform.deepseek.com 充值。${raw.slice(0, 200)}`);
      }
      tried.push(`${model} → HTTP ${response.status}`);
      onLog(`[llm] 模型 ${model} 不可用（HTTP ${response.status}），换下一个`);
    } catch (error) {
      if (error instanceof FatalApiError) throw error;
      tried.push(`${model} → ${String(error.message).slice(0, 60)}`);
      onLog(`[llm] 模型 ${model} 探测异常：${String(error.message).slice(0, 60)}`);
    }
  }

  throw new Error(`全部候选模型均不可用。逐个结果：\n  - ${tried.join("\n  - ")}\n请到 platform.deepseek.com 确认当前可用模型名，并填入 config/secrets.local.json 的 deepseek_model。`);
}

export function estimateCost(stats, price) {
  const p = price ?? {};
  const cacheHit = stats.cacheHitTokens ?? 0;
  const cacheMiss = stats.cacheMissTokens > 0 ? stats.cacheMissTokens : Math.max(0, stats.promptTokens - cacheHit);
  const usd =
    (cacheHit / 1_000_000) * Number(p.input_cache_hit_per_1m ?? 0.0028) +
    (cacheMiss / 1_000_000) * Number(p.input_cache_miss_per_1m ?? 0.14) +
    (stats.completionTokens / 1_000_000) * Number(p.output_per_1m ?? 0.28);
  return { usd, cny: usd * Number(p.usd_to_cny ?? 7.2) };
}
