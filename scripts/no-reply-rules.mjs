/**
 * no-reply-rules.mjs — 「什么评论不回复」的规则层（C-38，2026-10-19）
 *
 * 作者原话：「回复规则要从选择什么回复改成选择什么不回复……另外加入新增不回复规定功能，
 * 和删除规则功能，然后新增不回复规则功能是根据提示词 AI 生成对应的规则。」
 *
 * 设计要点：
 *   1. **运行时零成本**。AI 只在「造规则」时用一次，造出来的是**关键词 / 正则**；
 *      每条评论判定时只做字符串匹配，不调模型、不花钱、结果可复现。
 *      （如果让模型逐条判断"这条算不算问价格"，一天几千条评论就是几千次调用。）
 *   2. **规则是数据，不是代码**。存在 config/reply-rules.json 的 no_reply_rules.items，
 *      作者在页面上加/删/改，下一轮立即生效，不用改脚本。
 *   3. **优先级**：风险红线（政治 / 未成年）先判；自定义不回复规则排在「风险类别改走固定话术」
 *      之前 —— 作者说这类不回，就不能还回一句装傻话术。
 *   4. 匹配前做归一化（去空格和标点、转小写），所以「多 少 钱」「多少钱?」都能命中「多少钱」。
 */

import fs from "node:fs";
import path from "node:path";

export const NO_REPLY_CFG_KEY = "no_reply_rules";
export const RULE_NAME_MAX = 20;
export const RULE_DESC_MAX = 60;
export const KEYWORD_MIN_LEN = 2;
export const KEYWORD_MAX_LEN = 12;
export const KEYWORDS_MAX = 40;
export const RULES_MAX = 30;
export const REGEX_MAX_LEN = 160;
export const PROMPT_MAX_LEN = 200;

/**
 * 太宽泛的词会把整片评论吞掉（「你」「的」几乎每条都有），
 * 命中后表现为"什么都没回"，而且作者很难自己看出来是关键词写错了。
 */
const GENERIC_KEYWORDS = new Set([
  "你", "我", "他", "她", "它", "您", "咱", "的", "了", "吗", "呢", "吧", "啊", "呀", "哦", "嗯",
  "这", "那", "就", "都", "不", "是", "有", "和", "在", "个", "也", "还", "又", "很", "太",
  "什么", "怎么", "这个", "那个", "一下", "可以", "没有", "不是", "就是", "真的", "感觉",
]);

/** 归一化：去空白、去标点、转小写。中文没有词边界，靠子串匹配就够。 */
const STRIP = /[ \t\r\n\u3000，。！？、；：,.!?;:~～…·\-—_+'"“”‘’（）()【】\[\]《》<>]/g;
export function normalizeText(input) {
  return String(input ?? "").toLowerCase().replace(STRIP, "");
}

export function isGenericKeyword(word) {
  const w = normalizeText(word);
  return w.length < KEYWORD_MIN_LEN || GENERIC_KEYWORDS.has(w);
}

function nowDay() {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix = "nr") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 读 reply-rules.json 里的规则列表（容错：字段缺失 / 脏数据一律跳过，不让页面白屏） */
export function loadNoReplyRules(cfg) {
  const raw = cfg?.[NO_REPLY_CFG_KEY];
  const list = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];
  const errors = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name ?? "").trim();
    if (!name) continue;
    const keywords = (Array.isArray(entry.keywords) ? entry.keywords : [])
      .map((k) => String(k ?? "").trim())
      .filter(Boolean);
    const regex = String(entry.regex ?? "").trim();
    if (!keywords.length && !regex) {
      errors.push(`规则「${name}」没有任何关键词，已跳过`);
      continue;
    }
    items.push({
      id: String(entry.id ?? "").trim() || newId(),
      name,
      desc: String(entry.desc ?? "").trim(),
      keywords,
      regex,
      enabled: entry.enabled !== false,
      source: entry.source === "ai" ? "ai" : "manual",
      created: String(entry.created ?? nowDay()),
      updated: String(entry.updated ?? entry.created ?? nowDay()),
    });
  }
  return { items, errors, exists: Boolean(raw) };
}

/** 单条规则校验（保存路径与 AI 生成路径共用同一把尺子） */
export function normalizeRule(input, { existingId = "" } = {}) {
  const errors = [];
  const name = String(input?.name ?? "").trim();
  if (!name) errors.push("规则名字不能为空");
  else if (name.length > RULE_NAME_MAX) errors.push(`规则名字最多 ${RULE_NAME_MAX} 个字（当前 ${name.length}）`);

  const desc = String(input?.desc ?? "").trim().slice(0, RULE_DESC_MAX);
  const rawKeywords = Array.isArray(input?.keywords) ? input.keywords : [];
  const keywords = [];
  const seen = new Set();
  for (const entry of rawKeywords) {
    const word = String(entry ?? "").trim();
    if (!word) continue;
    if (word.length < KEYWORD_MIN_LEN) {
      errors.push(`关键词「${word}」太短（至少 ${KEYWORD_MIN_LEN} 个字）`);
      continue;
    }
    if (word.length > KEYWORD_MAX_LEN) {
      errors.push(`关键词「${word}」太长（最多 ${KEYWORD_MAX_LEN} 个字）`);
      continue;
    }
    if (GENERIC_KEYWORDS.has(normalizeText(word))) {
      errors.push(`关键词「${word}」太宽泛，几乎每条评论都会命中`);
      continue;
    }
    const norm = normalizeText(word);
    if (seen.has(norm)) continue;
    seen.add(norm);
    keywords.push(word);
  }
  if (keywords.length > KEYWORDS_MAX) {
    errors.push(`关键词最多 ${KEYWORDS_MAX} 个（当前 ${keywords.length}）`);
  }

  const regex = String(input?.regex ?? "").trim();
  if (regex) {
    if (regex.length > REGEX_MAX_LEN) errors.push(`正则最多 ${REGEX_MAX_LEN} 个字符`);
    try {
      new RegExp(regex, "i"); // 只验证能编译；运行时才真正使用
    } catch (error) {
      errors.push(`正则写法有问题：${error.message.slice(0, 60)}`);
    }
  }
  if (!keywords.length && !regex && !rawKeywords.some((k) => String(k ?? "").trim())) {
    errors.push("至少要有 1 个关键词，或写一条正则");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    rule: {
      id: String(input?.id ?? "").trim() || existingId || newId(),
      name,
      desc,
      keywords: keywords.slice(0, KEYWORDS_MAX),
      regex,
      enabled: input?.enabled !== false,
      source: input?.source === "ai" ? "ai" : "manual",
      created: String(input?.created ?? "").trim() || nowDay(),
      updated: nowDay(),
    },
  };
}

/** 整表校验（页面一次保存全部规则） */
export function normalizeRules(input) {
  if (!Array.isArray(input)) return { ok: false, errors: ["规则列表格式不对"] };
  if (input.length > RULES_MAX) return { ok: false, errors: [`最多 ${RULES_MAX} 条规则`] };
  const items = [];
  const errors = [];
  const ids = new Set();
  const names = new Set();
  input.forEach((entry, i) => {
    const result = normalizeRule(entry);
    if (!result.ok) {
      errors.push(...result.errors.map((e) => `第 ${i + 1} 条：${e}`));
      return;
    }
    const rule = result.rule;
    if (ids.has(rule.id)) rule.id = newId();
    ids.add(rule.id);
    const key = rule.name.toLowerCase();
    if (names.has(key)) {
      errors.push(`第 ${i + 1} 条：规则名「${rule.name}」重复`);
      return;
    }
    names.add(key);
    items.push(rule);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, items };
}

/**
 * 一条评论命中了哪条「不回复」规则。
 * 返回 { rule, why } 或 null；why 用于页面上解释"为什么这条被拦了"。
 * 正则优先于关键词（正则是更精确的表达），同一规则内命中第一条即可。
 */
export function matchNoReplyRule(text, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const norm = normalizeText(raw);
  for (const rule of list) {
    if (!rule || rule.enabled === false) continue;
    if (rule.regex) {
      try {
        if (new RegExp(rule.regex, "i").test(raw)) {
          return { rule, why: `正则 /${rule.regex}/` };
        }
      } catch {
        /* 保存时已校验；这里再坏就跳过，不影响其余规则 */
      }
    }
    for (const word of rule.keywords ?? []) {
      if (!word) continue;
      if (norm.includes(normalizeText(word))) return { rule, why: `关键词「${word}」` };
    }
  }
  return null;
}

/** 页面用的一句话视图 */
export function describeNoReplyRules(cfg) {
  const loaded = loadNoReplyRules(cfg);
  return {
    items: loaded.items.map((rule) => ({
      ...rule,
      keywordCount: rule.keywords.length,
      /** 给页面显示"这条规则现在拦哪些词" */
      summary: rule.keywords.slice(0, 6).join(" / ") + (rule.keywords.length > 6 ? " …" : ""),
    })),
    count: loaded.items.length,
    enabledCount: loaded.items.filter((r) => r.enabled !== false).length,
    errors: loaded.errors,
    limits: {
      maxRules: RULES_MAX,
      maxKeywords: KEYWORDS_MAX,
      nameMax: RULE_NAME_MAX,
      descMax: RULE_DESC_MAX,
      keywordMaxLen: KEYWORD_MAX_LEN,
      promptMax: PROMPT_MAX_LEN,
    },
  };
}

/**
 * 独立写盘入口（自测 / 脚本用）。
 * 控制台保存走 ui-server 的 patchRules（同一次请求里还要写字数、数量等字段，
 * 分成两次写会互相覆盖），所以那边只调用 normalizeRules。
 */
export function saveNoReplyRules(projectDir, rules, { file = null } = {}) {
  const target = file ?? path.join(projectDir, "config", "reply-rules.json");
  const normalized = normalizeRules(rules);
  if (!normalized.ok) return { ok: false, errors: normalized.errors };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`读不到规则配置：${error.message}`] };
  }
  cfg[NO_REPLY_CFG_KEY] = {
    ...(cfg[NO_REPLY_CFG_KEY] ?? {}),
    note:
      "自定义「不回复」规则。关键词命中即跳过该评论（不调模型、不回复）。" +
      "页面第 3 节「自定义不回复规则」增删改，AI 只负责把一句话变成关键词。",
    updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    items: normalized.items,
  };
  fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return { ok: true, items: normalized.items };
}
