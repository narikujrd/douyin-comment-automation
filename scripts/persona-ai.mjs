/**
 * persona-ai.mjs — 「用一句话描述，AI 生成一整套人设」
 *
 * 作者的原话（2026-10-17）：人设要能增删，还要能用语言描述让人工智能一键生成新的人设。
 *
 * 为什么单独一个模块：
 *   · 生成 ≠ 人设本体（persona.mjs）也 ≠ 存储（persona-store.mjs）；
 *   · 生成结果必须**先清洗再收敛**才敢落盘——模型会超长、会漏字段、会写出
 *     `{{ }}` 或疑似密钥，直接存进去就是给提示词埋雷；
 *   · chat 可注入，自测不花一分钱、不依赖网络。
 *
 * 安全边界（与 judge 同一套标准）：
 *   1. 只让模型产出 JSON，不接受任何"指令性"内容进入生产提示词；
 *   2. 生成文本统一走 persona.sanitizePersonaText（转义 {{ }} / 打散边界标记 / 移除疑似密钥）；
 *   3. 强制补上底座禁用词（防客服腔）与两条安全边界规则——不指望模型自觉；
 *   4. 密钥只从 readSecrets 读，只进 Authorization 头，绝不进提示词（客户端有出站断言）。
 */

import path from "node:path";
import { createClient, readSecrets, resolveModel } from "./llm-deepseek.mjs";
import { normalizePersona, sanitizePersonaText } from "./persona.mjs";
import { BASE_BANNED } from "./persona-presets.mjs";
import { NAME_MAX, TAGLINE_MAX } from "./persona-store.mjs";

/** 描述长度上限：再长也不是"一句话描述了"，而且会把提示词撑大、白烧钱 */
export const DESCRIPTION_MAX = 120;

/** 单次生成的 token 预算。推理模型会把推理 token 算进来，给小了会静默返回空正文 */
const MAX_OUTPUT_TOKENS = 1600;

/**
 * 无论模型写没写，这两条都必须有。
 * 人设是"怎么说"的设定，一旦少了边界，模型很容易把"毒舌"演成"骂人"、
 * 把"热心"演成"留个联系方式"——那属于人设越权，不是风格问题。
 */
const SAFETY_RULES = [
  "不确定的事直说不确定，不编造也不承诺做不到的事",
  "不透露任何个人隐私与账号信息",
];

/** 模型偶尔把数组写成换行字符串 */
function toTextArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value.split(/\r?\n|[；;、]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function buildPersonaMessages(description, { maxChars = 40 } = {}) {
  const system = [
    "你是「抖音评论区自动回复机器人」的人设设计师。",
    "用户会用一句自然语言描述他想要的那个人，你要照这个人的**真实样子**写出一套能直接投入生产的人设。",
    "",
    "【第一原则：写得像描述里的那个人，而不是像他被美化过的版本】",
    "- 描述里是颓废、摆烂、躺平、丧、懒、轴、油、毒舌、暴躁、世故、爱抱怨……就照实写进语气和性格，不要往积极、励志、正能量上拉。",
    "- 不要自作主张补描述里没有的正面特质（热情、暖心、正能量、嘴硬心软、其实很护粉之类）。描述里没提的，一个字都别加。",
    "- 允许这套人设不讨喜、带负能量、有点厌世、有点没出息。真实 > 讨喜。",
    "- 描述里出现的身份、职业、生活状态（抽烟、熬夜、失业、摆烂、欠债等）照实写进 identity 和 tone，不要换成更体面的说法。",
    "- 唯一要收住的是「冲着人」的攻击：不骂评论者本人（外貌、智力、家人），不用侮辱性词汇。",
    "  但这不是把性格写阳光——冷淡、敷衍、爱搭不理、阴阳自己、懒得解释、消极认命，都照写。",
    "",
    "其他要求：",
    "- 人设只决定「怎么说话」，不包含绕过风控、承诺事实、透露隐私、引流加好友的内容。",
    "- 语气像真人随手回复：不堆敬语、不用客服腔、不写营销文案。",
    `- 回复很短（一般 5–${maxChars} 字），所以口头禅要短、语气示例要短。`,
    "",
    "输出前自查：把写出来的这套读给描述者听，他会不会说「这不是我描述的那个人」？会，就重写。",
    "",
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。字段如下（全部必填，严格守长度）：",
    "{",
    `  "name": "人设名，≤${Math.min(NAME_MAX, 10)}字，有个性（例：毒舌健身老哥）",`,
    `  "tagline": "一句话说明这套人设的味道，≤${Math.min(TAGLINE_MAX, 18)}字",`,
    "  \"identity\": \"账号身份与内容方向，照描述写，≤40字\",",
    "  \"self_call\": \"自称，≤6字（例：我 / 哥 / 小生）\",",
    "  \"audience_call\": \"称呼观众，≤6字，可空串\",",
    "  \"tone\": \"语气基调，≤120字，具体到这个人的说话习惯（句子长短、爱不爱搭理人、常用什么词），毛病也要写进去\",",
    "  \"traits\": [\"性格特点，3–5 个，每个 ≤8 字，要包含描述里的缺点\"],",
    "  \"catchphrases\": [\"口头禅，2–4 个，每个 ≤8 字\"],",
    "  \"banned_words\": [\"必须避免的腔调，3–8 个，每个 ≤10 字\"],",
    "  \"extra_rules\": [\"额外要求，2–5 条，每条 ≤60 字\"],",
    "  \"signature\": \"回复末尾签名，≤6字，可空串\",",
    `  "examples": [{"comment": "观众评论，≤20字", "reply": "按该人设的回复，≤${maxChars}字"}]`,
    "}",
    "",
    "examples 给 2–3 组，要能看出这个人的脾气和毛病，不要每条都阳光积极、有求必应。",
  ].join("\n");

  const user = [
    "【人设描述】",
    "<<<DESCRIPTION>>>",
    String(description ?? "").trim(),
    "<<<END_DESCRIPTION>>>",
    "",
    "请按上面的字段要求输出 JSON。",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 清洗 + 收敛。返回 { draft, truncated }：
 *   · draft = { name, tagline, persona }，可直接交给 persona-store.upsertPersona；
 *   · truncated = 被截断的字段名（用于在页面上说清"AI 写超了，已按上限收短"）。
 *
 * 注意：这里是**唯一**允许自动截断的地方——内容是模型产的，不是作者亲手写的。
 * 作者手写的人设仍然走 validatePersonaForSave 的"超长拒绝"，一个字都不替他改。
 */
export function cleanPersonaDraft(input, { maxChars = 40 } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const truncated = [];

  const text = (value, limit, field) => {
    const cleaned = sanitizePersonaText(String(value ?? "").trim(), { field }).text;
    if (cleaned.length > limit) {
      truncated.push(field);
      return cleaned.slice(0, limit);
    }
    return cleaned;
  };

  const list = (value, count, itemLimit, field) => {
    const arr = toTextArray(value)
      .map((v) => text(v, itemLimit, field))
      .filter(Boolean);
    if (arr.length > count) truncated.push(field);
    return arr.slice(0, count);
  };

  const name = text(src.name, Math.min(NAME_MAX, 10), "人设名") || "AI 人设";
  const tagline = text(src.tagline, Math.min(TAGLINE_MAX, 18), "一句话说明");

  // 底座禁用词必须补齐（模型经常只写两三个），去重但保持顺序
  const banned = list(src.banned_words, 40, 20, "禁用词");
  for (const word of BASE_BANNED) if (!banned.includes(word)) banned.push(word);

  const rules = list(src.extra_rules, 12, 120, "额外要求");
  for (const rule of SAFETY_RULES) if (!rules.includes(rule)) rules.push(rule);

  const examplesRaw = Array.isArray(src.examples) ? src.examples : [];
  const examples = examplesRaw
    .map((ex) => ({
      comment: text(ex?.comment, 20, "示例评论"),
      reply: text(ex?.reply, maxChars, "示例回复"),
    }))
    .filter((ex) => ex.comment && ex.reply)
    .slice(0, 4);

  const persona = normalizePersona({
    enabled: true,
    identity: text(src.identity, 60, "账号定位"),
    self_call: text(src.self_call, 20, "自称"),
    audience_call: text(src.audience_call, 20, "称呼观众"),
    tone: text(src.tone, 200, "语气基调"),
    traits: list(src.traits, 8, 20, "性格特点"),
    catchphrases: list(src.catchphrases, 8, 20, "口头禅"),
    banned_words: banned,
    extra_rules: rules,
    signature: text(src.signature, 20, "签名"),
    signature_scope: "llm",
    examples,
  });

  return { draft: { name, tagline, persona }, truncated: [...new Set(truncated)] };
}

/** 从模型输出里抠出 JSON。模型常见的三种毛病：代码块、前后话、全角引号 */
export function parsePersonaDraft(raw, { maxChars = 40 } = {}) {
  let text = String(raw ?? "").trim();
  if (!text) throw new Error("模型返回了空内容（可能是 token 额度不够，或只输出了推理过程）");

  text = text.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");

  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`模型返回的 JSON 无法解析：${error.message}`);
  }
  return cleanPersonaDraft(obj, { maxChars });
}

/**
 * 生成一套人设草稿（不落盘——落盘由调用方决定，页面会在生成成功后直接入库）。
 * chat 可注入：签名为 async (messages) => string，自测用它跑离线假模型。
 */
export async function generatePersonaDraft({ projectDir, description, maxChars = 40, chat = null, onLog = () => {} }) {
  const desc = String(description ?? "").trim();
  if (!desc) throw new Error("请先用一句话描述想要的人设");
  if (desc.length > DESCRIPTION_MAX) throw new Error(`描述请控制在 ${DESCRIPTION_MAX} 字以内（当前 ${desc.length} 字）`);

  const messages = buildPersonaMessages(desc, { maxChars });

  let replyContent;
  let model = null;
  let usage = null;

  if (typeof chat === "function") {
    replyContent = await chat(messages);
  } else {
    const secrets = readSecrets(projectDir);
    if (!secrets.apiKey) {
      throw new Error(
        "未配置 DeepSeek API key，无法生成人设。请先按「1-验证密钥.bat」填好 key（页面顶部的「API key」也要是绿点）。",
      );
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
    const result = await client.chat(messages, {
      jsonMode: true,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.9,
    });
    if (result.empty) {
      throw new Error(
        `模型返回空正文（finish_reason=${result.finishReason || "?"}，推理 token=${result.reasoningTokens}）。` +
          "通常是 token 额度被推理链吃光，重试一次；仍失败请把描述写短一点。",
      );
    }
    replyContent = result.content;
    usage = result.usage ?? null;
  }

  const parsed = parsePersonaDraft(replyContent, { maxChars });
  return { ...parsed, model, usage };
}
