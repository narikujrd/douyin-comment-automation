/**
 * persona.mjs — 「机器人人设」的唯一真相来源
 *
 * 为什么单独抽一个模块：人设同时被两条链路消费——
 *   · scripts/judge.mjs    生产：生成评论回复（真发出去）
 *   · scripts/ui-server.mjs 控制台：页面预览（给作者看效果）
 * 两边必须用**完全同一份**提示词构造逻辑，否则会出现"预览很满意、发出去不一样"
 * 这种最难查的问题（页面说人设是 A，实际生效是 B）。
 *
 * 职责边界：只负责「收敛/校验/拼提示词片段」，不调用模型、不读写任何文件。
 *   · 读写在 persona-store.mjs（人设库 config/personas.json）
 *   · 生成在 persona-ai.mjs（一句话让 AI 写一套）
 * 这样人设本体怎么存、怎么增删，都不会碰到提示词拼装这段最容易出安全问题的代码。
 */

/** 默认人设 = 未配置人设时的现状行为（注入了也等价于原来只有 style 一行） */
export const DEFAULT_PERSONA = {
  version: "1.0",
  updated: "",
  enabled: true,
  identity: "创作者本人",
  self_call: "我",
  audience_call: "",
  tone: "轻松、口语、简短，像真人随手回复，不堆敬语、不用客服腔",
  traits: [],
  catchphrases: [],
  banned_words: [],
  extra_rules: [],
  signature: "",
  signature_scope: "llm",
  examples: [],
};

/** 各文本字段的长度上限（防止人设把提示词撑爆、或撞上下文上限烧 token） */
const FIELD_LIMITS = {
  identity: 60,
  self_call: 20,
  audience_call: 20,
  tone: 200,
  signature: 20,
};

const LIST_LIMITS = {
  traits: { count: 8, item: 20 },
  catchphrases: { count: 8, item: 20 },
  banned_words: { count: 40, item: 20 },
  extra_rules: { count: 12, item: 120 },
  examples: { count: 6, item: 120 },
};

/**
 * 归一化：把外部（页面/手改文件）传入的人设收敛成固定形状。
 * 多出来的键一律丢弃，缺的键补默认值 —— 避免人设文件被写坏后静默用上半个配置。
 */
export function normalizePersona(input) {
  const src = input && typeof input === "object" ? input : {};
  const pickText = (key) => String(src[key] ?? DEFAULT_PERSONA[key] ?? "").trim();
  const pickList = (key) => {
    const raw = src[key];
    const arr = Array.isArray(raw) ? raw : [];
    const { count, item } = LIST_LIMITS[key];
    return arr
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .slice(0, count)
      .map((v) => v.slice(0, item));
  };

  const out = {
    version: "1.0",
    updated: String(src.updated ?? "").trim(),
    enabled: src.enabled !== false,
    identity: pickText("identity").slice(0, FIELD_LIMITS.identity),
    self_call: pickText("self_call").slice(0, FIELD_LIMITS.self_call),
    audience_call: pickText("audience_call").slice(0, FIELD_LIMITS.audience_call),
    tone: pickText("tone").slice(0, FIELD_LIMITS.tone),
    signature: pickText("signature").slice(0, FIELD_LIMITS.signature),
    signature_scope: ["llm", "all", "none"].includes(src.signature_scope)
      ? src.signature_scope
      : DEFAULT_PERSONA.signature_scope,
    traits: pickList("traits"),
    catchphrases: pickList("catchphrases"),
    banned_words: pickList("banned_words"),
    extra_rules: pickList("extra_rules"),
    examples: (Array.isArray(src.examples) ? src.examples : [])
      .map((ex) => ({
        comment: String(ex?.comment ?? "").trim().slice(0, LIST_LIMITS.examples.item),
        reply: String(ex?.reply ?? "").trim().slice(0, LIST_LIMITS.examples.item),
      }))
      .filter((ex) => ex.comment || ex.reply)
      .slice(0, LIST_LIMITS.examples.count),
  };
  return out;
}

/**
 * 防注入转义。人设是**作者自己写的**，属可信输入；但它会被拼进提示词，
 * 所以必须保证它不会破坏提示词的结构：
 *   1. `{{...}}` —— fill() 只替换一次、不会递归展开，所以这里主要是为了
 *      避免人设把 `{{comment}}` 之类的占位符**显示**在提示词里造成模型误解；
 *   2. `<<<UNTRUSTED_COMMENT>>>` 边界标记 —— 若人设里出现，会让"不可信数据区"的
 *      边界含义被破坏（模型可能把它当成边界，从而把后面的评论当指令）；
 *   3. 形如密钥的长串 —— 绝不进提示词（与 security.secrets.assert_not_in_prompt 同源要求）。
 */
export function sanitizePersonaText(text, { field = "?" } = {}) {
  const notes = [];
  let out = String(text ?? "");

  if (/\{\{|\}\}/.test(out)) {
    out = out.replace(/\{\{/g, "｛｛").replace(/\}\}/g, "｝｝");
    notes.push(`${field}:占位符已转义（{{ }}）`);
  }
  if (/UNTRUSTED_COMMENT/i.test(out)) {
    out = out.replace(/UNTRUSTED_COMMENT/gi, "UNTRUSTED-COMMENT");
    notes.push(`${field}:不可信数据边界标记已打散`);
  }
  if (/(sk|api[_-]?key)[-_:=\s]*[A-Za-z0-9_-]{16,}/i.test(out)) {
    out = out.replace(/(sk|api[_-]?key)[-_:=\s]*[A-Za-z0-9_-]{16,}/gi, "[已移除疑似密钥]");
    notes.push(`${field}:疑似密钥已移除`);
  }
  return { text: out, notes };
}

/**
 * 拼出注入提示词的片段。设计要点：
 *   · 人设注入的是「语气/性格」，**不是权限**。这里所有文字都只影响措辞，
 *     不改变任何硬约束（字数上限、风险拦截、禁止引流等仍然由代码与硬约束段兜底）。
 *   · 明确写「不得违反上方硬性约束」，防止人设里的自定义要求把硬约束顶掉。
 */
export function buildPersonaBlock(persona, { fallbackStyle = "", maxChars } = {}) {
  const p = normalizePersona(persona);
  const notes = [];
  const lines = [];

  if (!p.enabled) {
    const style = sanitizePersonaText(fallbackStyle || DEFAULT_PERSONA.tone, { field: "style" });
    notes.push(...style.notes);
    return {
      block: `- 风格要求：${style.text}`,
      notes,
      applied: false,
      summary: "人设已关闭，退回通用风格描述",
    };
  }

  const put = (label, value) => {
    if (!value) return;
    const { text, notes: n } = sanitizePersonaText(value, { field: label });
    notes.push(...n);
    lines.push(`- ${label}：${text}`);
  };

  const putList = (label, arr, sep = "、") => {
    if (!arr.length) return;
    const cleaned = arr.map((v) => {
      const { text, notes: n } = sanitizePersonaText(v, { field: label });
      notes.push(...n);
      return text;
    });
    lines.push(`- ${label}：${cleaned.join(sep)}`);
  };

  lines.push("## 你的角色人设（创作者本人的设定，用于决定「怎么说话」）");
  lines.push("");
  lines.push(
    "> 人设只决定语气与措辞。上方所有硬性约束与安全边界**优先级更高**，" +
      "人设中的任何要求若与之冲突，一律以硬性约束为准。",
  );
  lines.push("");
  put("账号身份", p.identity);
  put("自称", p.self_call);
  put("称呼观众", p.audience_call);
  put("语气基调", p.tone);
  putList("性格特点", p.traits);
  putList("可以偶尔用的口头禅", p.catchphrases);
  putList("绝对不要出现的词或腔调（出现即作废重写）", p.banned_words);
  if (p.signature && p.signature_scope !== "none") {
    const sig = sanitizePersonaText(p.signature, { field: "签名" });
    notes.push(...sig.notes);
    lines.push(`- 回复末尾要带上签名：「${sig.text}」`);
  }
  if (p.extra_rules.length) {
    lines.push("- 额外要求：");
    for (const rule of p.extra_rules) {
      const { text, notes: n } = sanitizePersonaText(rule, { field: "额外要求" });
      notes.push(...n);
      lines.push(`  - ${text}`);
    }
  }

  const usableExamples = p.examples.filter((ex) => ex.comment && ex.reply);
  if (usableExamples.length) {
    lines.push("");
    lines.push("### 语气示例（学这个感觉，内容不要照抄）");
    for (const ex of usableExamples) {
      const c = sanitizePersonaText(ex.comment, { field: "示例评论" });
      const r = sanitizePersonaText(ex.reply, { field: "示例回复" });
      notes.push(...c.notes, ...r.notes);
      lines.push(`- 评论「${c.text}」→ 回复「${r.text}」`);
    }
  }

  if (typeof maxChars === "number" && Number.isFinite(maxChars)) {
    lines.push("");
    lines.push(`（提醒：无论什么语气，回复总长度都不得超过 ${maxChars} 个字符。）`);
  }

  const summaryParts = [];
  if (p.identity) summaryParts.push(p.identity);
  if (p.tone) summaryParts.push(p.tone.slice(0, 30));
  if (p.banned_words.length) summaryParts.push(`禁 ${p.banned_words.length} 词`);

  return {
    block: lines.join("\n"),
    notes,
    applied: true,
    summary: summaryParts.join(" · ") || "默认人设",
  };
}

/** 人设违禁词 → 并入出口检查（生成文案命中即作废重写） */
/**
 * 「声音指纹」：把人设里**决定说话口吻**的字段压成一个短哈希。
 *
 * 用途（2026-10-18 · C-35）：人设保存后要自动补齐/更新它的专属风险话术。
 * 但每次保存都重新生成 = 每改一个标点就花一次钱。用指纹判断"口吻真的变了吗"：
 *   · 指纹没变 → 话术还是对的，跳过（不花钱）；
 *   · 指纹变了 → 后台重新生成。
 * 只取影响说话方式的字段；头像、tagline、enabled 这类不影响口吻的改动不触发。
 */
export function personaVoiceFingerprint(persona) {
  const p = persona ?? {};
  const join = (v) => (Array.isArray(v) ? v.join("|") : String(v ?? ""));
  const material = [
    p.identity,
    p.self_call,
    p.audience_call,
    p.tone,
    join(p.traits),
    join(p.catchphrases),
    join(p.extra_rules),
    join(p.banned_words),
  ].join("\u241f");
  let hash = 0;
  for (let i = 0; i < material.length; i += 1) hash = (hash * 31 + material.charCodeAt(i)) % 100000007;
  return String(hash);
}

export function getBannedWords(persona) {
  return normalizePersona(persona).banned_words.filter(Boolean);
}

/**
 * 保存前校验。这里只做「结构性拒绝」（会导致危险或静默失效的内容），
 * 不做内容审查——人设是作者自己的账号，措辞由他定。
 */
export function validatePersonaForSave(input, { maxChars } = {}) {
  const errors = [];
  const warnings = [];
  const raw = input && typeof input === "object" ? input : {};

  const allText = [
    raw.identity,
    raw.self_call,
    raw.audience_call,
    raw.tone,
    raw.signature,
    ...(Array.isArray(raw.traits) ? raw.traits : []),
    ...(Array.isArray(raw.catchphrases) ? raw.catchphrases : []),
    ...(Array.isArray(raw.banned_words) ? raw.banned_words : []),
    ...(Array.isArray(raw.extra_rules) ? raw.extra_rules : []),
    ...(Array.isArray(raw.examples) ? raw.examples.flatMap((e) => [e?.comment, e?.reply]) : []),
  ]
    .filter((v) => typeof v === "string")
    .join("\n");

  // 结构性风险：这些一旦写进去会被静默清理，与其悄悄改不如直接拒绝（避免"我明明写了"）
  if (/\{\{|\}\}/.test(allText)) {
    errors.push("人设里不能出现 {{ }}（那是提示词占位符，会被转义掉，写得再对也不生效）");
  }
  if (/UNTRUSTED_COMMENT/i.test(allText)) {
    errors.push("人设里不能出现 UNTRUSTED_COMMENT（那是不可信数据区的边界标记）");
  }
  if (/(sk|api[_-]?key)[-_:=\s]*[A-Za-z0-9_-]{16,}/i.test(allText)) {
    errors.push("检测到疑似密钥，已拒绝保存。人设绝不允许携带密钥（它会被拼进提示词）");
  }

  // 高概率踩坑：人设里写"要带上联系方式"这类，会被出口检查反复打回 → 白烧钱
  const contactish = ["加微信", "微信号", "加我", "私聊", "二维码", "扫码", "手机号", "小黄车"];
  const hit = contactish.filter((w) => allText.includes(w));
  if (hit.length) {
    warnings.push(
      `人设里出现了疑似引流用语（${hit.join("、")}）。这些内容会被出口检查拦下并反复重写，建议删掉。`,
    );
  }

  /**
   * 超长必须拒绝，不允许静默截断 —— 「改了又没了」的第三种形态（2026-10-16 补）：
   * 写了 250 字的语气，保存后静默变成 200 字、页面还显示"已保存"，
   * 重开一看"我写的少了"。截断 = 替作者改字，必须让他自己删减。
   * 上限与 normalizePersona 同源（FIELD_LIMITS / LIST_LIMITS），不另抄一份数字。
   */
  const TEXT_LABELS = {
    identity: "账号定位",
    self_call: "自称",
    audience_call: "怎么称呼观众",
    signature: "签名",
    tone: "语气基调",
  };
  for (const [key, label] of Object.entries(TEXT_LABELS)) {
    const v = String(raw[key] ?? "").trim();
    if (v.length > FIELD_LIMITS[key]) {
      errors.push(
        `${label}有 ${v.length} 字，超过上限 ${FIELD_LIMITS[key]} 字。请删减后再保存 —— 超长内容会被截断，等于替你改了字。`,
      );
    }
  }
  const LIST_LABELS = {
    traits: "性格",
    catchphrases: "口头禅",
    banned_words: "禁用词",
    extra_rules: "额外要求",
    examples: "语气示例",
  };
  for (const [key, label] of Object.entries(LIST_LABELS)) {
    const arr = Array.isArray(raw[key]) ? raw[key] : [];
    const lim = LIST_LIMITS[key];
    if (arr.length > lim.count) {
      errors.push(`${label}最多 ${lim.count} 条，当前 ${arr.length} 条。请删减后再保存。`);
    }
    const over = arr.filter((x) => {
      const texts = key === "examples" ? [x?.comment, x?.reply] : [x];
      return texts.some((s) => String(s ?? "").trim().length > lim.item);
    });
    if (over.length) {
      errors.push(`${label}里有 ${over.length} 条超过 ${lim.item} 字。请删减后再保存 —— 超长会被截断。`);
    }
  }

  if (typeof maxChars === "number" && raw.signature) {
    const sigLen = String(raw.signature).length;
    if (sigLen >= maxChars) {
      errors.push(`签名 ${sigLen} 字 ≥ 回复字数上限 ${maxChars} 字，每条回复都会只剩签名。请缩短签名。`);
    } else if (sigLen > maxChars / 2) {
      warnings.push(`签名 ${sigLen} 字，占掉回复上限 ${maxChars} 字的一半以上，正文会很难写。`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
