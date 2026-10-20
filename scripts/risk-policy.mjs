/**
 * 风险处置策略（C-26，2026-10-17 作者要求）
 *
 * 背景：以前的逻辑是「hard / soft 一律不回复」——结果这类评论永远留在
 * 抖音的「未回复」列表里，每轮被重新采集、重新花钱判一遍，结论还是不回。
 *
 * 现在改成按**风险类别**分流：
 *   · 政治敏感 / 涉及未成年人 → 不回（并记进「已判定不回」缓存，之后零成本跳过）；
 *   · 其余全部回，但**不顺着对方讲**——用固定话术装傻、调戏、撒娇，零 token。
 *
 * 设计边界：
 *   · 本模块只做「分类 + 查策略表」，不读写任何状态、不调模型；
 *   · 词表与策略全在 config/risk-policy.json，改行为不用改代码；
 *   · 配置文件缺失 / 坏了 → 用内置默认（宁可保守 skip 政治，也不能把政治评论回出去）。
 *
 * ★ 2026-10-19 C-40：关键词从「命中即违规」改成**三层**，治误杀。
 *   作者反馈「有些内容看着像违规、其实没违规，却被限制不能回」，根因是子串匹配：
 *   「白嫖」「肠子都悔青了」「跳楼价」「宗教建筑」这类正常话里都嵌着敏感词。
 *   · strong  强信号 —— 单发就判（如 分裂主张 / 裸照 / 分尸）；
 *   · weak    弱信号 —— 单发只算「疑似」（confidence=low），
 *             由 routeForHit() 降级成「用固定话术回一句」，不再当作违规跳过；
 *             同一类里命中两个以上不同的弱词，才升回「确定」；
 *   · exempt  豁免短语 —— 先把它从正文里挖掉再匹配（「白嫖」挖掉后就没「嫖」了）。
 * 判定顺序也改了：先扫全类别的 strong，再扫 weak。否则「宗教建筑 + 约炮」会被
 *   前面的 weak 政治抢走，把一条确定该跳过的色情评论降级。
 *
 * ★ 2026-10-19 C-45：反向关键词改成**风险词优先**。
 *   同一条评论里既有反向词（allow，表示"这类可以回"）、又有这一类的风险词时，
 *   按风险处理（不回）；只有整句找不到风险词、只剩反向词时才放行。
 */

import fs from "node:fs";
import path from "node:path";

export const RISK_POLICY_REL_PATH = "config/risk-policy.json";
/**
 * 本地覆盖文件（不入库，.gitignore 里挡着）。
 * 为什么要它：公开仓库里不适合放政治类这种敏感词表，但过滤功能本身要留着。
 * 词写在这里，启动时按类别合并进上面的配置 —— 行为和写进主配置完全一样。
 */
export const RISK_POLICY_LOCAL_REL_PATH = "config/risk-policy.local.json";

/** 内置兜底：配置文件读不到时用。只保留最关键的几条，避免代码里维护两份完整词表。 */
const FALLBACK = {
  precedence: ["political", "minors", "porn", "violence", "credential", "contact", "legal", "refund", "abuse", "bargain", "personal", "platform", "other"],
  routes: {
    political: { action: "skip", cache: true, label: "政治敏感" },
    minors: { action: "skip", cache: true, label: "涉及未成年人" },
    porn: { action: "skip", cache: true, label: "色情露骨" },
    violence: { action: "skip", cache: true, label: "血腥暴力" },
    default: { action: "template", pool: "deflect", label: "其他" },
  },
  signals: {
    /**
     * 政治类默认没有词表：词在 config/risk-policy.local.json，代码里也不再内置一份。
     * 这样公开仓库干净，功能也不残缺 —— 配置文件损坏时政治类退化为「只靠模型判」。
     */
    political: { strong: [], weak: [], exempt: [], regexes: [] },
    minors: {
      strong: ["幼女", "萝莉", "儿童色情"],
      weak: ["未成年"],
      exempt: ["未成年的时候", "未成年时", "还未成年", "没成年"],
      regexes: [],
    },
    porn: {
      strong: ["约炮", "裸聊", "裸照", "援交", "成人视频", "福利姬", "嫖娼"],
      weak: ["色情", "包养", "开房", "嫖"],
      exempt: ["白嫖", "开房间"],
      regexes: [],
    },
    violence: {
      strong: ["捅死", "虐杀", "肢解", "爆头", "割喉", "分尸"],
      weak: ["血腥", "砍死", "自杀", "自残", "打死", "肠子", "尸体", "跳楼"],
      exempt: ["打死我也不信", "打死都不", "打死不", "肠子都悔青", "跳楼价", "自杀式", "砍死我"],
      regexes: [],
    },
    credential: { strong: ["密码", "验证码", "银行卡", "身份证", "密钥", "api key", "私钥", "凭据"], weak: [], exempt: [], regexes: ["sk-[A-Za-z0-9]{8,}"] },
  },
  semantic_reasons: [
    { category: "political", regex: "政治|时政|敏感议题|宗教|国家|民族|历史事件|领土|主权" },
    { category: "minors", regex: "未成年|儿童" },
    { category: "porn", regex: "色情|露骨|性暗示|性邀约|裸|约炮|援交|成人内容" },
    { category: "violence", regex: "血腥|暴力|残肢|虐杀|自杀|自残|凶杀|伤亡细节" },
    { category: "credential", regex: "密码|账号|凭据|密钥|key|验证码", flags: "i" },
    { category: "contact", regex: "联系方式|微信|电话|二维码|导流|私聊|站外" },
    { category: "injection", regex: "注入|指令|提示词|身份改写" },
    { category: "abuse", regex: "辱骂|威胁|人肉|人身攻击|地域歧视" },
    { category: "legal", regex: "法务|起诉|律师|投诉|举报|维权|监管|曝光" },
    { category: "refund", regex: "退款|退货|假货|消费|售后|纠纷" },
    { category: "bargain", regex: "砍价|优惠|议价|价格|竞品|对比" },
    { category: "personal", regex: "订单|物流|参数|政策|本人|专属" },
  ],
  skip_cache: { enabled: true, max_age_days: 7, max_entries: 5000 },
};

function compile(list, flags = "") {
  const out = [];
  for (const src of Array.isArray(list) ? list : []) {
    if (typeof src !== "string" || !src) continue;
    try {
      out.push(new RegExp(src, flags));
    } catch {
      // 正则写错不该让整条链路挂掉：跳过这一条，其余照常
    }
  }
  return out;
}

const isWord = (w) => typeof w === "string" && w.length > 0;

/** 挖掉豁免短语用的占位符：不能是任何关键词的子串，否则挖完又拼出一个新词 */
const MASK = "\u25a1";

/**
 * 把豁免短语从正文里挖掉再匹配。
 * 例：「这价格白嫖都值了」→ 挖掉「白嫖」→「这价格□□都值了」→ 不再命中「嫖」。
 * 注意是**整段替换**，不是删字符：删字符会把「白」和「都」拼到一起，可能拼出新的误判。
 */
function maskExempt(text, exempt) {
  if (!exempt.length) return text;
  let t = text;
  for (const phrase of exempt) {
    if (t.includes(phrase)) t = t.split(phrase).join(MASK);
  }
  return t;
}

/**
 * 把本地覆盖文件合并进主配置。原地改 base，返回 base。
 *
 * 合并口径：
 *   · signals 按**类别**合：strong / weak / exempt / allow / keywords / regexes 都是数组拼接去重，
 *     本地词排在后面 —— 判定顺序不变（长的先挖的 exempt 排序在编译阶段会重排，不受影响）。
 *   · routes / 其它顶层字段整体覆盖（本地写了就以本地为准）。
 *   · 不做深拷贝：调用方传进来的已经是解析后的对象，改它就是目的。
 */
function mergeLocalPolicy(base, local) {
  const lsig = local?.signals;
  if (lsig && typeof lsig === "object") {
    if (!base.signals || typeof base.signals !== "object") base.signals = {};
    for (const [cat, lv] of Object.entries(lsig)) {
      const bv = base.signals[cat] && typeof base.signals[cat] === "object" ? base.signals[cat] : {};
      const next = { ...bv };
      for (const key of ["strong", "weak", "exempt", "allow", "keywords"]) {
        const add = Array.isArray(lv?.[key]) ? lv[key].filter((w) => typeof w === "string" && w.trim()) : [];
        if (!add.length) continue;
        const prev = Array.isArray(bv[key]) ? bv[key] : [];
        next[key] = [...new Set([...prev, ...add])];
      }
      const addRe = Array.isArray(lv?.regexes) ? lv.regexes : [];
      const prevRe = Array.isArray(bv.regexes) ? bv.regexes : [];
      next.regexes = [...new Set([...prevRe, ...addRe])];
      base.signals[cat] = next;
    }
  }
  if (local?.routes && typeof local.routes === "object") {
    base.routes = { ...(base.routes ?? {}), ...local.routes };
  }
  if (local?.skip_cache && typeof local.skip_cache === "object") {
    base.skip_cache = { ...(base.skip_cache ?? {}), ...local.skip_cache };
  }
  return base;
}

/**
 * 读并编译策略。返回的结构里 regexes 已变成 RegExp，其余原样。
 * error 非空表示配置文件有问题，调用方应当告警（但流程照常）。
 */
export function loadRiskPolicy(projectDir) {
  const file = path.join(projectDir, RISK_POLICY_REL_PATH);
  let raw = null;
  let error = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    error = e.code === "ENOENT"
      ? `未找到 ${RISK_POLICY_REL_PATH}，已用内置默认策略（政治/未成年不回，其余打马虎眼）`
      : `${RISK_POLICY_REL_PATH} 无法解析，已用内置默认策略：${e.message}`;
  }

  /**
   * 兜底对象每次先复制一份再合并 —— 直接改 FALLBACK 会让下一次调用读到上一轮的本地词，
   * 自测里连跑多个沙盒目录时会串味。
   */
  const src = raw && typeof raw === "object"
    ? raw
    : { ...FALLBACK, signals: { ...FALLBACK.signals }, routes: { ...FALLBACK.routes } };

  /**
   * ★ 开源前（2026-10-20）：本地词表覆盖。
   *   公开仓库的 risk-policy.json 不含政治词表，用户把自己的词写进
   *   config/risk-policy.local.json 即可，这里合并进来。
   *   读不到 = 正常情况（新用户还没建）；解析失败要告警，但不能因此中断整个判定。
   */
  const localFile = path.join(projectDir, RISK_POLICY_LOCAL_REL_PATH);
  let localLoaded = false;
  try {
    const localRaw = JSON.parse(fs.readFileSync(localFile, "utf8"));
    if (localRaw && typeof localRaw === "object") {
      mergeLocalPolicy(src, localRaw);
      localLoaded = true;
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      const msg = `${RISK_POLICY_LOCAL_REL_PATH} 无法解析，已忽略：${e.message}`;
      error = error ? `${error}；${msg}` : msg;
    }
  }
  const signals = src.signals && typeof src.signals === "object" ? src.signals : FALLBACK.signals;

  const compiled = {};
  for (const [cat, sig] of Object.entries(signals)) {
    /**
     * 兼容老配置：只有 keywords 的写法一律当强信号（原来就是"命中即判"）。
     * 这样作者手上的旧 risk-policy.json 不改也能跑，不会因为升级把判定改松。
     */
    const strong = Array.isArray(sig?.strong) ? sig.strong : (Array.isArray(sig?.keywords) ? sig.keywords : []);
    const weak = Array.isArray(sig?.weak) ? sig.weak : [];
    const exempt = Array.isArray(sig?.exempt) ? sig.exempt : [];
    compiled[cat] = {
      strong: strong.filter(isWord),
      weak: weak.filter(isWord),
      // 长的排前面：先挖「打死我也不信」，再挖「打死不」，避免被短短语切碎后漏挖
      exempt: exempt.filter(isWord).sort((a, b) => b.length - a.length),
      /**
       * ★ C-43（2026-10-19 作者要求）：反向关键词 —— 评论里出现这些词就认为「可以回复」。
       *   与 exempt 的区别：exempt 是「把这个词挖掉再匹配」（只影响同一句里的其它词），
       *   allow 是**整类放行**（这一类不再判，后面其它类别照常扫）。
       *   例：色情类配 allow:["人体艺术"] → 「人体艺术展」不再按色情处理。
       */
      allow: (Array.isArray(sig?.allow) ? sig.allow : []).filter(isWord),
      regexes: compile(sig?.regexes),
    };
  }

  const routes = { ...FALLBACK.routes, ...(src.routes ?? {}) };
  const precedence = Array.isArray(src.precedence) && src.precedence.length
    ? src.precedence
    : FALLBACK.precedence;

  const semanticRules = [];
  for (const rule of Array.isArray(src.semantic_reasons) ? src.semantic_reasons : FALLBACK.semantic_reasons) {
    if (!rule?.category || !rule?.regex) continue;
    try {
      semanticRules.push({ category: rule.category, re: new RegExp(rule.regex, rule.flags ?? "") });
    } catch {
      /* 同上：坏的正则跳过 */
    }
  }

  const cacheCfg = { ...FALLBACK.skip_cache, ...(src.skip_cache ?? {}) };

  return {
    file,
    localFile,
    localLoaded,
    error,
    precedence,
    signals: compiled,
    routes,
    semanticRules,
    /**
     * @deprecated 2026-10-20：疑似不再由关键词层决定处置。
     * 现在「单命中弱词」一律标记 deferToLlm 交模型判三档（见 routeForHit）。
     * 字段保留只为兼容旧配置文件，代码里已不再读取。
     */
    suspectMode: src.suspect_policy === "reply" ? "reply" : "deflect",
    cache: {
      enabled: cacheCfg.enabled !== false,
      maxAgeDays: Number(cacheCfg.max_age_days ?? 7),
      maxEntries: Number(cacheCfg.max_entries ?? 5000),
    },
  };
}

/**
 * 这一类的「正向关键词」（风险信号）是否命中：强词 / 正则 / 任一弱词都算。
 *
 * ★ C-45（2026-10-19 作者要求）：反向关键词不再是"一票放行"。
 *   同一条评论里既有风险词又有反向词时，**风险词优先**（按不回处理）；
 *   只有整句都找不到风险词、只剩下反向词时，才真的放行。
 *   否则「人体艺术里那些约炮的」这种话配一个宽泛的反向词就能整类漏过去。
 *   返回命中的那个词（供日志/报告用），空串 = 没命中。
 */
function positiveHit(text, category, policy) {
  const sig = policy?.signals?.[category];
  if (!sig) return "";
  const t = maskExempt(String(text ?? ""), sig.exempt ?? []);
  for (const kw of sig.strong ?? []) if (t.includes(kw)) return kw;
  for (const re of sig.regexes ?? []) {
    const m = t.match(re);
    if (m) return m[0];
  }
  for (const kw of sig.weak ?? []) if (t.includes(kw)) return kw;
  return "";
}

/**
 * 按评论正文分类。返回 null = 没有命中任何风险信号（可以走正常流程）。
 *
 * 返回的 confidence：
 *   · "high" —— 强信号，或同类别里命中 ≥2 个不同的弱信号 → 该按策略处置（可能是 skip）
 *   · "low"  —— 只命中一个弱信号 → 只算「疑似」，由 routeForHit() 降级处理，不当违规
 *
 * 两趟扫描是刻意的：第一趟只看强信号。如果按类别一趟扫到低，
 * 「宗教建筑 + 约炮」会因为前面 political 的弱词先命中，把一条确定该跳过的
 * 色情评论降级成"疑似"——等于用误杀换漏杀，方向反了。
 */
export function classifyRisk(text, policy) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;

  const order = policy.precedence.filter((cat) => cat !== "other" && policy.signals[cat]);
  const masked = new Map();
  const maskedFor = (cat) => {
    if (!masked.has(cat)) masked.set(cat, maskExempt(raw, policy.signals[cat].exempt ?? []));
    return masked.get(cat);
  };

  /**
   * ★ C-43：反向关键词 —— 命中即**整类放行**（这一类不判，其它类别照常扫）。
   *   只在「这一类的 allow 命中了」时才放行它自己，不会连带放过别的类别：
   *   一条评论写了「人体艺术」又写了分裂主张，色情被放行，政治照样判。
   *   英文按小写比，避免 Key/key 这种大小写差异漏配。
   *
   * ★ C-45（2026-10-19 作者要求）：**正向关键词优先**。
   *   同一句里既有反向词、又有这一类的风险词（强/弱/正则任一），就不放行 ——
   *   只有「整句只剩反向词、找不到风险词」时才算真的可以回复。
   */
  const lowerRaw = raw.toLowerCase();
  const allowedCats = new Set();
  for (const cat of order) {
    const allow = policy.signals[cat].allow ?? [];
    if (!allow.length) continue;
    if (!allow.some((kw) => lowerRaw.includes(kw.toLowerCase()))) continue;
    if (positiveHit(raw, cat, policy)) continue; // 风险词优先，不放行
    allowedCats.add(cat);
  }

  // 第一趟：强信号 + 正则（单发即定）
  for (const cat of order) {
    if (allowedCats.has(cat)) continue;
    const sig = policy.signals[cat];
    const t = maskedFor(cat);
    for (const kw of sig.strong ?? []) {
      if (t.includes(kw)) return { category: cat, hit: kw, layer: "rules", confidence: "high" };
    }
    for (const re of sig.regexes ?? []) {
      const m = t.match(re);
      if (m) return { category: cat, hit: m[0], layer: "rules", confidence: "high" };
    }
  }

  // 第二趟：弱信号。先看谁凑够两个，再退到「单独一个 = 疑似」
  const weakByCat = new Map();
  for (const cat of order) {
    if (allowedCats.has(cat)) continue;
    const sig = policy.signals[cat];
    if (!sig.weak?.length) continue;
    const t = maskedFor(cat);
    const hits = sig.weak.filter((kw) => t.includes(kw));
    if (hits.length) weakByCat.set(cat, hits);
  }
  for (const cat of order) {
    const hits = weakByCat.get(cat);
    if (hits && hits.length >= 2) {
      return { category: cat, hit: hits.join("+"), layer: "rules", confidence: "high", weakHits: hits };
    }
  }
  for (const cat of order) {
    const hits = weakByCat.get(cat);
    if (hits && hits.length === 1) {
      return { category: cat, hit: hits[0], layer: "rules", confidence: "low", weakHits: hits };
    }
  }
  return null;
}

/**
 * 把语义层的**中文理由**映射回类别。
 * 模型只输出 { level, reason }，没有类别字段 —— 与其改提示词让模型多输出一个
 * 它经常写错的枚举，不如照它的自然语言理由反查，稳且不用动已调好的提示词。
 */
export function classifySemanticReason(reason, policy) {
  const r = String(reason ?? "");
  if (!r) return "other";
  for (const rule of policy.semanticRules) {
    if (rule.re.test(r)) return rule.category;
  }
  return "other";
}

/**
 * 处置只有三种（2026-10-20 作者定）：
 *   · "skip"     不回复
 *   · "template" 用固定话术（打岔 / 装傻 / 撒娇），不经模型生成
 *   · "reply"    正常回复（走模型生成）
 *
 * 除「合作待办」外，**不存在「转人工」这第四种结局** —— 每条评论最后一定落在
 * 这三种之一：回了（模型或模板）、或者没回。
 */
const ROUTE_ACTIONS = new Set(["skip", "template", "reply"]);

/** 查某一类的处置。未知类别按 other 处理，配置里连 other 都没有就用 deflect 兜底。 */
export function routeFor(category, policy) {
  const route = policy.routes[category] ?? policy.routes.other ?? FALLBACK.routes.default;
  /**
   * 配置里写坏 / 缺少 action 时一律按 template 处理：既不会沉默漏回，
   * 也不会让一条本该打岔的评论直接进模型生成（那是更危险的放行方向）。
   */
  const raw = typeof route.action === "string" ? route.action.trim() : "";
  const action = ROUTE_ACTIONS.has(raw) ? raw : "template";
  return {
    category,
    action,
    pool: typeof route.pool === "string" && route.pool ? route.pool : "deflect",
    label: route.label || category,
    cache: route.cache !== false,
    note: route.note ?? "",
  };
}

/**
 * 按「命中结果」查处置。
 *
 * ★ 2026-10-20 改：疑似（只命中一个弱词）**不再由关键词层决定处置**，而是标记
 *   `deferToLlm` 交给模型三档判定 —— 作者的要求是「明确不回复的就回，拿不准的走模型」，
 *   而"只碰上一个弱词"正是最典型的拿不准。
 *   依据：C-40 定的置信度分级（strong/regex/双弱词 = high，单弱词 = low）。
 */
export function routeForHit(hit, policy) {
  if (!hit) return null;
  const route = routeFor(hit.category, policy);
  if (hit.confidence !== "low") return route;
  return {
    ...route,
    deferToLlm: true,
    suspect: true,
    cache: false,
    note: `只是疑似「${route.label}」（单命中弱信号「${hit.hit}」）→ 交模型判断`,
  };
}

/**
 * ★ C-43：这条评论是否被某一类的反向关键词放行。返回命中的词（空串 = 没放行）。
 * 语义层（模型判风险）也要用它 —— 否则「配了反向词、模型还是拦」，
 * 用户看到的现象就是功能没生效（2026-10-19 实测踩到）。
 *
 * ★ C-45：正向关键词优先 —— 这一句里同时有风险词时返回空串（不放行），
 * 让语义层的判断也照常生效；否则关键词层收紧了、模型层却还在放水，两边口径又分裂。
 */
export function allowHitFor(text, category, policy) {
  const allow = policy?.signals?.[category]?.allow ?? [];
  if (!allow.length) return "";
  if (positiveHit(text, category, policy)) return "";
  const t = String(text ?? "").toLowerCase();
  return allow.find((kw) => t.includes(kw.toLowerCase())) || "";
}

/**
 * 给控制台用的纯数据视图：每类一行——标签、怎么处置、缓存不缓存。
 * 只输出能展示的字段，不把 RegExp 序列化出去。
 */
export function describePolicy(policy) {
  const rows = [];
  const seen = new Set();
  for (const cat of [...policy.precedence, "other"]) {
    if (seen.has(cat)) continue;
    seen.add(cat);
    const route = routeFor(cat, policy);
    rows.push({
      category: cat,
      label: route.label,
      action: route.action,
      pool: route.action === "skip" ? "" : route.pool,
      cache: route.cache,
      note: route.note,
    });
  }
  return rows;
}
