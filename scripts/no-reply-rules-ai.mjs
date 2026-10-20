/**
 * no-reply-rules-ai.mjs — 把「一句话要求」变成可执行的不回复规则（C-38）
 *
 * 作者原话：「新增不回复规则功能是根据提示词 AI 生成对应的规则。」
 *
 * 关键取舍：**AI 只在造规则时用一次，运行时不再调模型**。
 *   · 如果让模型逐条判断"这条算不算问价格"，几千条评论就是几千次调用，又慢又贵；
 *   · 让模型输出关键词 / 正则，运行时只做字符串匹配 —— 零成本、可复现、改词即改行为。
 * 所以提示词里反复压两点：关键词要覆盖常见说法与错别字，但不能宽泛到吞掉整片评论。
 */

import path from "node:path";
import { createClient, readSecrets, resolveModel } from "./llm-deepseek.mjs";
import {
  KEYWORD_MAX_LEN,
  KEYWORD_MIN_LEN,
  KEYWORDS_MAX,
  PROMPT_MAX_LEN,
  RULE_DESC_MAX,
  RULE_NAME_MAX,
  isGenericKeyword,
  normalizeText,
} from "./no-reply-rules.mjs";

/** 推理模型的推理 token 计入预算，给小了会返回空正文（项目里踩过多次） */
const MAX_OUTPUT_TOKENS = 2048;

export function buildNoReplyMessages({ prompt, existing = [] }) {
  const system = [
    "你在给「抖音评论区自动回复机器人」设计一条【不回复规则】。",
    "作者会用一句大白话说清哪类评论不要回；你要把它翻译成程序能直接执行的关键词表。",
    "",
    "硬性要求：",
    `- name：规则名，${RULE_NAME_MAX} 个汉字以内，一眼能看懂（例：问价格、要链接、同行挑衅）。`,
    `- desc：一句话说明这条规则拦什么，${RULE_DESC_MAX} 字以内。`,
    `- keywords：${KEYWORD_MIN_LEN}–${KEYWORD_MAX_LEN} 个字一个，8–${KEYWORDS_MAX} 个。`,
    "  · 要覆盖同一意思的常见说法、口语、缩写、错别字（例：问价格 → 多少钱、什么价、咋卖、几块、报价、贵不贵、优惠、打折）。",
    "  · 不能出现「你、我、的、了、吗、什么、怎么」这类几乎每条评论都有的词——它们会把整片评论吞掉。",
    "  · 不要出现标点、空格、表情符号。",
    "- regex：可选。只有关键词确实表达不了时才给（JS 正则字符串，不带首尾斜杠，160 字以内）。",
    "  能给好关键词就不要给正则。",
    "",
    "判断标准：宁可少拦，不可错拦。拿不准是否该进关键词的词，就不要放。",
    "输出严格 JSON，键正好是 name / desc / keywords / regex，不要输出 JSON 以外的任何文字。",
    "regex 不需要时给空字符串。",
  ].join("\n");

  const user = [
    `作者的要求：${prompt}`,
    existing.length ? `已经有这些规则，避免重复：${existing.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 模型输出 → 干净规则（脏词、泛词、超长都在这里滤掉，并回报丢了什么） */
export function parseGeneratedRule(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? "").trim());
  } catch {
    // 模型偶尔会在 JSON 外包一层 ```json
    const m = String(content ?? "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("模型没有返回可解析的 JSON，换个说法再生成一次");
    parsed = JSON.parse(m[0]);
  }

  const name = String(parsed.name ?? "").trim().slice(0, RULE_NAME_MAX);
  const desc = String(parsed.desc ?? "").trim().slice(0, RULE_DESC_MAX);
  const rawKeywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  const dropped = [];
  const keywords = [];
  const seen = new Set();
  for (const entry of rawKeywords) {
    const word = String(entry ?? "").replace(/[\s，。！？、,.!?~～"'“”‘’]/g, "").trim();
    if (!word) continue;
    if (word.length < KEYWORD_MIN_LEN || word.length > KEYWORD_MAX_LEN) {
      dropped.push({ word, why: `长度需 ${KEYWORD_MIN_LEN}–${KEYWORD_MAX_LEN} 字` });
      continue;
    }
    if (isGenericKeyword(word)) {
      dropped.push({ word, why: "太宽泛" });
      continue;
    }
    const norm = normalizeText(word);
    if (seen.has(norm)) continue;
    seen.add(norm);
    keywords.push(word);
  }
  const regex = String(parsed.regex ?? "").trim().slice(0, 160);
  if (regex) {
    try {
      new RegExp(regex, "i");
    } catch (error) {
      dropped.push({ word: regex, why: `正则写不通：${error.message.slice(0, 40)}` });
    }
  }
  const usableRegex = regex && !dropped.some((d) => d.word === regex) ? regex : "";
  if (!name) throw new Error("模型没给出规则名，换个说法再生成一次");
  if (!keywords.length && !usableRegex) throw new Error("模型给的关键词都不合适，换个说法再生成一次");

  return {
    name,
    desc,
    keywords: keywords.slice(0, KEYWORDS_MAX),
    regex: usableRegex,
    dropped,
  };
}

export async function generateNoReplyRule({ projectDir, prompt, existing = [], chat = null, onLog = () => {} }) {
  const clean = String(prompt ?? "").trim();
  if (!clean) throw new Error("先写一句「什么评论不回复」");
  if (clean.length > PROMPT_MAX_LEN) throw new Error(`描述最多 ${PROMPT_MAX_LEN} 字（当前 ${clean.length}）`);

  const messages = buildNoReplyMessages({ prompt: clean, existing });
  let content;
  let model = null;
  let usage = null;

  if (typeof chat === "function") {
    content = await chat(messages);
  } else {
    const secrets = readSecrets(projectDir);
    if (!secrets.apiKey) {
      throw new Error("未配置 DeepSeek API key，无法生成规则。先按「1-验证密钥.bat」填好 key。");
    }
    const resolved = await resolveModel({
      apiKey: secrets.apiKey,
      baseUrl: secrets.baseUrl,
      preferred: secrets.model,
      candidates: ["deepseek-flash", "deepseek-v4-flash", "deepseek-chat"],
      cacheFile: path.join(projectDir, "state", "model-cache.json"),
      onLog,
    });
    model = resolved.model;
    const client = createClient({
      apiKey: secrets.apiKey,
      baseUrl: secrets.baseUrl,
      model: resolved.model,
      timeoutMs: 60000,
      maxRetries: 2,
      onWarn: onLog,
    });
    const result = await client.chat(messages, { jsonMode: true, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 });
    if (result.empty) {
      throw new Error(
        `模型返回空正文（finish_reason=${result.finishReason || "?"}，推理 token=${result.reasoningTokens}）。` +
          "重试一次，或把要求写短一点。",
      );
    }
    content = result.content;
    usage = result.usage ?? null;
  }

  const rule = parseGeneratedRule(content);
  return { ...rule, model, usage, prompt: clean };
}
