/**
 * 风险评论的「人味」话术（C-26 第二轮，2026-10-17 作者要求）
 *
 * 作者原话：「这些固定话术回复太假没有人味了，用傲娇猫娘、上位御姐、古风小生、皇帝
 * 的人设对应的去设计回复话术，傲娇喵娘的占比 50%，上位御姐 30%、古风小生 10%，皇帝 10%。」
 *
 * 所以这个模块不再按「风险类别」选一句话，而是：
 *   1. 风险类别先归成三组：dodge（装傻）/ tease（调戏）/ retort（接住辱骂）；
 *   2. 按权重抽一个**角色**（喵娘 50 / 御姐 30 / 古风 10 / 皇帝 10）；
 *   3. 从该角色该组的池子里挑一句。
 *
 * 两条稳定性保证：
 *   · seed 相同 → 角色相同（`stableHash(seed) % 总权重`），同一条评论重试也不换人；
 *   · 挑句时优先避开最近用过的（跨角色共享避重窗口），避免同一句连着出现。
 *
 * 本模块只做「挑哪一句」，不碰状态、不调模型、不做出口校验 ——
 * 校验统一留在 judge.mjs，固定话术和模型输出必须过同一道闸。
 */

import fs from "node:fs";
import path from "node:path";
import { stableHash } from "./persona-rotation.mjs";
import { OUTBOUND_PATTERNS } from "./outbound-rules.mjs";

export const RISK_REPLIES_REL_PATH = "config/risk-replies.json";

/**
 * 兜底：配置文件缺失/损坏时用。只留最小可用集，不在这里复制整份文案 ——
 * 那样改文案就得改两处，迟早不一致。
 */
const FALLBACK = {
  categoryGroups: {
    legal: "unclear",
    refund: "dodge",
    personal: "unclear",
    bargain: "dodge",
    platform: "unclear",
    contact: "unclear",
    other: "unclear",
    credential: "tease",
    injection: "tease",
    abuse: "retort",
    /**
     * ★ 2026-10-19 补：政治敏感 / 未成年 / 色情 / 暴力 / 纯表情这 5 类原来**没写分组**，
     *   取组时落到 `?? "dodge"` —— 而 dodge 池是 C-26 给「砍价 / 退款」写的买卖场景
     *   （「本喵不是卖家呀你认错猫了喵」）。结果「台湾是中国的」被当成"你把我当卖家"来回，
     *   牛头不对马嘴（作者 2026-10-19 截图报的正是这个）。
     *   这 5 类统一走 unclear：装听不懂、不接话、不表态，对敏感内容才是安全方向。
     */
    political: "unclear",
    minors: "unclear",
    porn: "unclear",
    violence: "unclear",
    sticker: "unclear",
    default: "unclear",
  },
  roles: [
    {
      id: "fallback",
      name: "默认",
      weight: 1,
      pools: {
        dodge: ["啊？我没太看明白", "你说的这个我真不懂", "这话我接不住"],
        tease: ["这个不能说，换个问法", "你猜？我不告诉你"],
        retort: ["嗯，我听到了", "这话我记下了"],
        unclear: ["啊？我没太看懂", "这话我没接住", "你说啥"],
      },
    },
  ],
};

export function loadRiskReplies(projectDir) {
  const file = path.join(projectDir, RISK_REPLIES_REL_PATH);
  let raw = null;
  let error = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    error = e.code === "ENOENT"
      ? `未找到 ${RISK_REPLIES_REL_PATH}，已用内置最小话术集`
      : `${RISK_REPLIES_REL_PATH} 无法解析，已用内置最小话术集：${e.message}`;
  }

  const src = raw && typeof raw === "object" ? raw : FALLBACK;
  const roles = (Array.isArray(src.roles) ? src.roles : FALLBACK.roles)
    .map((role) => ({
      id: String(role?.id ?? "").trim() || "role",
      name: String(role?.name ?? "未命名").trim(),
      /**
       * ★ 2026-10-18（C-27）：绑定的**人设 id**（config/personas.json 里的那套）。
       * 绑了以后，这条评论用哪套人设，就用哪个角色的话术——不再按权重抽到别人。
       * weight 仍保留：只有「没绑定人设」的角色才参与按权重抽的兜底。
       */
      personaId: String(role?.personaId ?? "").trim(),
      /**
       * 生成这套话术时人设的"声音指纹"（C-35）。归一化必须原样带出来，
       * 否则 ui-server 读到的永远是 undefined → 每次保存都判"需要重生成"（白花钱）。
       */
      personaFingerprint: String(role?.personaFingerprint ?? "").trim(),
      /**
       * ★ 2026-10-19：「是否负责回复风险评论」。缺省 true —— 旧配置没有这个字段，
       *   迁移时全部算在岗，再由用户在风险人设库里勾掉。false 的角色仍留着话术，
       *   但不参与抽选（占比按 0 算）。
       */
      active: role?.active !== false,
      weight: Math.max(0, Number(role?.weight ?? 0)),
      note: String(role?.note ?? ""),
      pools: {
        dodge: Array.isArray(role?.pools?.dodge) ? role.pools.dodge.filter((s) => typeof s === "string" && s.trim()) : [],
        tease: Array.isArray(role?.pools?.tease) ? role.pools.tease.filter((s) => typeof s === "string" && s.trim()) : [],
        retort: Array.isArray(role?.pools?.retort) ? role.pools.retort.filter((s) => typeof s === "string" && s.trim()) : [],
        // unclear（2026-10-17）：语义「模糊/说不清是哪类」以及法务/隐私/平台/联系方式用。
        // 与 dodge 分开的原因见 risk-replies.json 的 note —— dodge 里全是「我什么时候卖过东西」，
        // 套在「无语」这种短评上答非所问。
        unclear: Array.isArray(role?.pools?.unclear) ? role.pools.unclear.filter((s) => typeof s === "string" && s.trim()) : [],
      },
    }))
    .filter((role) => role.pools.dodge.length + role.pools.tease.length + role.pools.retort.length + role.pools.unclear.length > 0);

  const categoryGroups = { ...FALLBACK.categoryGroups, ...(src.categoryGroups ?? {}) };

  return {
    file,
    error,
    roles: roles.length ? roles : FALLBACK.roles,
    categoryGroups,
  };
}

/** 按权重抽角色。seed 固定 → 角色固定（同一条评论不会这次猫娘下次皇帝）。 */
function pickRole(roles, seed) {
  const total = roles.reduce((sum, r) => sum + r.weight, 0);
  if (total <= 0) return roles[0];
  let n = stableHash(seed) % total;
  for (const role of roles) {
    if (n < role.weight) return role;
    n -= role.weight;
  }
  return roles[0];
}

function pickFromPool(pool, seed, recent, minChars, maxChars) {
  const usable = pool.filter((s) => s.length >= minChars && s.length <= maxChars);
  if (!usable.length) return null;
  const offset = stableHash(seed) % usable.length;
  for (let i = 0; i < usable.length; i += 1) {
    const candidate = usable[(offset + i) % usable.length];
    if (!recent.includes(candidate)) return candidate;
  }
  // 整池都在最近窗口里 → 退回起点那条。宁可重复一句也别不回：
  // 不回的话这条评论会永远留在「未回复」列表里，下一轮还是它。
  return usable[offset];
}

/**
/**
 * 按人设找到它绑定的角色（judge 与页面共用，避免两边规则漂移）。
 * 匹配顺序：personaId 精确 → 角色 id 与人设 id 同名 → 名字包含（「喵娘」↔「傲娇喵娘」）。
 * 找不到返回 null = 该人设没配专属角色，调用方回退按权重抽。
 */
export function findRoleForPersona(roles, { personaId = "", personaName = "" } = {}) {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  const pid = String(personaId ?? "").trim();
  if (pid) {
    const byPersona = roles.find((role) => role.personaId && role.personaId === pid);
    if (byPersona) return byPersona;
    const byId = roles.find((role) => role.id === pid);
    if (byId) return byId;
  }
  const norm = (s) => String(s ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const name = norm(personaName);
  if (name) {
    const hit = roles.find((role) => {
      const rn = norm(role.name);
      return rn && (rn === name || rn.includes(name) || name.includes(rn));
    });
    if (hit) return hit;
  }
  return null;
}

/** 挑一句风险处置话术。
 *
 * @param {string} category  风险类别（legal / refund / credential / …）
 * @param {string} seed      稳定性种子，约定 `${username}|${commentText}`
 * @param {string[]} recent  最近用过的文案（跨角色共享，防连着重复）
 * @returns {{text:string, roleId:string, roleName:string, group:string} | {text:null, reason:string}}
 */
export function pickRiskReply({ category, seed, recent = [], minChars = 4, maxChars = 40, cfg, roleId = null }) {
  /**
   * ★ 兜底从 dodge 改成 unclear（2026-10-19）：
   *   dodge 池是「我不是卖家 / 我没卖东西」这类**买卖场景**话术（给砍价、退款用）。
   *   任何没配分组的类别落到它头上，就会出现「政治评论被当成问价」这种错位回答。
   *   unclear（装听不懂 / 没接住 / 你换个问法）是中性打岔，对陌生类别才是安全的默认值。
   *   配置文件里有显式分组时以配置为准；这里只接管「配置漏写」的情况。
   */
  const group = cfg.categoryGroups[category] ?? "unclear";

  /**
   * 首选角色：
   *   ① 传了 roleId（= 本条评论用人设绑定/匹配到的角色）→ 就用它 —— 人设是皇帝就绝不冒出喵娘腔；
   *   ② 没传（人设没绑定角色）→ 退回按权重抽，保证"永远有话说"。
   * 它的池子挑不出来时，仍按顺序试其它角色（比如某角色该组句子全超字数，不该让这条评论没人回）。
   */
  const bound = roleId ? cfg.roles.find((role) => role.id === roleId) ?? null : null;
  const primary = bound ?? pickRole(cfg.roles, seed);
  const ordered = [primary, ...cfg.roles.filter((r) => r.id !== primary.id)];

  for (const role of ordered) {
    const text = pickFromPool(role.pools[group] ?? [], seed, recent, minChars, maxChars);
    if (text) return { text, roleId: role.id, roleName: role.name, group };
  }

  return {
    text: null,
    reason: `empty_pool（组 ${group}：${cfg.roles.map((r) => `${r.name} ${r.pools[group]?.length ?? 0} 条`).join("；")}，长度窗口 ${minChars}–${maxChars}）`,
  };
}

/** 给控制台用的纯数据视图：每个角色多少句、占比多少（pools 一并给出，供第 8 节直接编辑）。 */
export function describeRiskReplies(cfg) {
  /** 占比只统计「在岗」的角色：勾掉的留着话术但不算分母，否则页面上的百分比永远合计不满 100 */
  const total = cfg.roles.filter((r) => r.active !== false).reduce((sum, r) => sum + r.weight, 0) || 1;
  return {
    file: RISK_REPLIES_REL_PATH,
    error: cfg.error,
    roles: cfg.roles.map((r) => ({
      id: r.id,
      name: r.name,
      /** 绑定的人设 id（空 = 不绑定，参与按权重抽） */
      personaId: r.personaId ?? "",
      /** 生成时的人设指纹（页面保存原样带回，别把它洗掉） */
      personaFingerprint: r.personaFingerprint ?? "",
      /** 是否负责回复风险评论（false = 留着话术但不参与抽选） */
      active: r.active !== false,
      weight: r.weight,
      percent: r.active === false ? 0 : Math.round((r.weight / total) * 100),
      counts: {
        dodge: r.pools.dodge.length,
        tease: r.pools.tease.length,
        retort: r.pools.retort.length,
        unclear: r.pools.unclear.length,
      },
      total: r.pools.dodge.length + r.pools.tease.length + r.pools.retort.length + r.pools.unclear.length,
      /** 原文，供编辑（只读展示用的是 counts） */
      pools: {
        dodge: [...r.pools.dodge],
        tease: [...r.pools.tease],
        retort: [...r.pools.retort],
        unclear: [...r.pools.unclear],
      },
    })),
    groups: cfg.categoryGroups,
  };
}

/* ---------------- 第 8 节直接编辑（C-32，2026-10-17 作者要求） ---------------- */

export const RISK_POOL_KEYS = ["dodge", "tease", "retort", "unclear"];
export const RISK_POOL_LABEL = {
  dodge: "装傻（退款 / 砍价一类「对方把我当卖家」的场合）",
  tease: "调戏（索要密钥 / 指令注入）",
  retort: "接住（辱骂）",
  unclear: "没听懂（法务 / 隐私 / 平台 / 说不清哪一类）",
};

/**
 * 校验并保存第 8 节的编辑结果。
 *
 * **为什么要在保存时就校验**：judge 运行时确实会再过一遍闸（`validateRiskText`），
 * 但那条路是"不合格就跳过"，用户看到的现象是"我明明写了这句，它就是不用"——
 * 静默丢句子比直接报错糟糕得多。所以这里把同一套硬性规则前移，当场指出是哪一句、为什么。
 *
 * limits 由调用方按当前 reply-rules.json 传入，保证和运行时用同一把尺子。
 */
export function saveRiskReplies(projectDir, incoming, limits = {}) {
  const minChars = Number(limits.minChars ?? 4);
  const maxChars = Number(limits.maxChars ?? 40);
  const hardKeywords = Array.isArray(limits.hardKeywords) ? limits.hardKeywords : [];
  const outboundKeywords = Array.isArray(limits.outboundKeywords) ? limits.outboundKeywords : [];
  const outboundPatterns = limits.outboundPatterns ?? OUTBOUND_PATTERNS;
  const errors = [];

  const file = path.join(projectDir, RISK_REPLIES_REL_PATH);
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    existing = {};
  }

  const rawRoles = Array.isArray(incoming?.roles) ? incoming.roles : [];
  if (!rawRoles.length) return { ok: false, errors: [{ scope: "整体", reason: "至少要保留一套人设" }] };
  if (rawRoles.length > 8) return { ok: false, errors: [{ scope: "整体", reason: `最多 8 套人设（当前 ${rawRoles.length} 套），再多每套被抽到的机会就太低了` }] };

  const roles = [];
  const usedIds = new Set();
  const usedNames = new Set();
  for (const role of rawRoles) {
    let id = String(role?.id ?? "").trim() || `role-${roles.length + 1}`;
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);
    const name = String(role?.name ?? "").trim();
    if (!name) errors.push({ scope: "人设", reason: "有一套人设没有名字" });
    /**
     * ★ 2026-10-19：上限从 12 放宽到 20 —— 风险人设库的角色名直接取人设名，
     *   而人设名允许 20 字（persona-store 的 NAME_MAX）。卡 12 会出现
     *   "在这套人设里能存、在风险人设库里一保存就报名字太长"的自相矛盾。
     */
    if (name.length > 20) errors.push({ scope: `「${name}」`, reason: `名字太长（${name.length} 字，最多 20）` });
    if (name && usedNames.has(name)) errors.push({ scope: `「${name}」`, reason: "有两套人设重名了，分不清谁是谁" });
    usedNames.add(name);

    const weightRaw = Number(role?.weight);
    const weight = Number.isFinite(weightRaw) ? Math.max(0, Math.min(100, Math.round(weightRaw))) : 0;
    /**
     * 占比 0 只对「没绑定人设」的角色是问题（永远抽不到）。
     * 绑定人设的角色 weight=0 是**设计如此**：它只在该人设出场时被使用，不参与随机抽。
     */
    const boundPersonaId = String(role?.personaId ?? "").trim();
    if (weight === 0 && !boundPersonaId) {
      errors.push({ scope: `「${name}」`, reason: "占比是 0 且没绑定人设，这套永远不会被抽到" });
    }

    const pools = {};
    let roleLines = 0;
    for (const key of RISK_POOL_KEYS) {
      const lines = Array.isArray(role?.pools?.[key])
        ? role.pools[key].map((s) => String(s ?? "").trim()).filter(Boolean)
        : [];
      const kept = [];
      for (const line of lines) {
        const why = checkRiskLine(line, { minChars, maxChars, hardKeywords, outboundKeywords, outboundPatterns });
        if (why) {
          errors.push({ scope: `「${name}」/ ${key}`, line: line.slice(0, 30), reason: why });
          continue;
        }
        if (kept.includes(line)) {
          errors.push({ scope: `「${name}」/ ${key}`, line: line.slice(0, 30), reason: "同一池里重复了" });
          continue;
        }
        kept.push(line);
      }
      pools[key] = kept;
      roleLines += kept.length;
    }
    if (!roleLines) errors.push({ scope: `「${name}」`, reason: "四个池子全是空的，这套人设抽到也没话说" });
    const existingRole = (existing.roles ?? []).find((r) => r?.id === id) ?? {};
    const personaId = String(role?.personaId ?? existingRole.personaId ?? "").trim();
    const personaFingerprint = String(role?.personaFingerprint ?? existingRole.personaFingerprint ?? "").trim();
    /** 负责与否：编辑界面传了就用传的，没传沿用文件里的（缺省 true） */
    const active =
      role?.active === undefined
        ? existingRole.active !== false
        : role.active !== false;
    roles.push({
      id,
      name,
      weight,
      active,
      ...(personaId ? { personaId } : {}),
      ...(personaFingerprint ? { personaFingerprint } : {}),
      note: String(role?.note ?? existingRoleNote(existing, id)),
      pools,
    });
  }

  const totalWeight = roles.reduce((s, r) => s + r.weight, 0);
  /**
   * 只有"未绑定人设"的角色才依赖权重被抽到。
   * 如果所有角色都绑定了人设（C-34 之后很常见），总权重 0 是**正常状态**——
   * 它们只在各自的人设出场时使用，不参与随机，不该报错。
   */
  const hasUnbound = roles.some((r) => !r.personaId);
  if (hasUnbound && totalWeight <= 0) {
    errors.push({ scope: "整体", reason: "没绑定人设的角色占比全是 0，抽不出任何一套" });
  }

  if (errors.length) return { ok: false, errors };

  const next = {
    version: existing.version ?? 1,
    updated: new Date().toISOString(),
    // note / categoryGroups 是配置的"另一半"，编辑界面不碰它，原样保留
    ...(existing.note ? { note: existing.note } : {}),
    categoryGroups: existing.categoryGroups ?? {},
    roles,
  };

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能没建出来 */
    }
    return { ok: false, errors: [{ scope: "写文件", reason: error.message }] };
  }
  return { ok: true, file, roles: roles.length, lines: roles.reduce((s, r) => s + RISK_POOL_KEYS.reduce((n, k) => n + r.pools[k].length, 0), 0) };
}

function existingRoleNote(existing, id) {
  const hit = Array.isArray(existing?.roles) ? existing.roles.find((r) => String(r?.id) === id) : null;
  return hit?.note ?? "";
}

/**
 * 单句校验 —— 与 judge.mjs 的 `validateRiskText` 同口径（长度 / 中文 / 硬词 / 站外引导）。
 * 唯一的差别：这里**返回原因**给界面看，而不是静默跳过。
 *
 * 导出是因为「AI 生成话术」要用同一把尺子过滤模型输出（risk-replies-ai.mjs）。
 */
export function checkRiskLine(line, {
  minChars = 4,
  maxChars = 40,
  hardKeywords = [],
  outboundKeywords = [],
  outboundPatterns = OUTBOUND_PATTERNS,
} = {}) {
  if (line.length < minChars) return `太短（${line.length} 字，最少 ${minChars}）`;
  if (line.length > maxChars) return `太长（${line.length} 字，最多 ${maxChars}）`;
  if ((line.match(/[\u4e00-\u9fa5]/g) ?? []).length < 2) return "中文不足 2 个字";
  for (const kw of hardKeywords) if (kw && line.includes(kw)) return `含红线词「${kw}」（写死的话术也会被自己的闸拦下）`;
  for (const kw of outboundKeywords) if (kw && line.includes(kw)) return `含站外引导词「${kw}」`;
  for (const re of outboundPatterns) if (re instanceof RegExp && re.test(line)) return "像网址 / 电话 / 二维码，不能出现";
  return null;
}
