/**
 * risk-personas.mjs — 风险评论回复人设库（2026-10-19）
 *
 * ── 为什么要有这个模块 ──
 * 以前风险评论的口吻是「跟着链路2 的人设走」：这条评论抽到皇帝，风险话术就用皇帝池。
 * 作者要的是**两条互相独立的链路**：
 *   · 链路2（普通回复）：人设库选中哪套 → 就用哪套回，与风险无关；
 *   · 链路1（风险回复）：风险人设库里「有话术 + 勾了负责」的人，按占比抽一个，
 *     用它的口吻回，与链路2 抽到谁无关。
 * 所以这里把「风险人设库」当成一个独立的选择器，不再从 personaCtx 反查角色。
 *
 * ── 数据存在哪 ──
 * 仍然只有一份配置：config/risk-replies.json 的 roles[]。
 * 每套风险人设 = 一个 role（personaId 绑定人设 + pools 四组话术），另外两个字段决定路由：
 *   · active  是否负责回复风险评论（缺省 true，兼容旧配置）
 *   · weight  占比权重（页面显示为百分比，内部按比例归一）
 * 不另开配置文件的原因：话术本体和路由必须同生同死，分两个文件迟早对不上。
 *
 * ── 两个板是这样派生的（没有第三份状态）──
 *   有话术   = 人设库里有这套人设 && roles 里有绑定它且四个池子非空的 role
 *   未生成   = 人设库里有这套人设 && 没有对应的 role（或池子全空）
 * 人设删了 → role 跟着删（purgePersona）；话术删了 → 人设回到「未生成」（revokeReplies）。
 * 两种删除都会把剩余在用人设的占比重新归一 —— 自动补齐，不需要人再点一次。
 *
 * 边界：本模块只读写配置与算占比，不调模型、不发请求、不碰浏览器。
 */

import fs from "node:fs";
import path from "node:path";
import { loadPersonaLibrary } from "./persona-store.mjs";
import { personaVoiceFingerprint } from "./persona.mjs";
import { RISK_REPLIES_REL_PATH } from "./risk-replies.mjs";
import { stableHash } from "./persona-rotation.mjs";

/** 占比合计按 100 展示；权重本身允许任意正整数，读的时候归一 */
export const RISK_PERSONA_MAX = 8;

/* ---------------- 占比计算 ---------------- */

/**
 * 把一组权重换算成整数百分比，合计正好 100。
 * 用最大余数法：先取整数部分，剩下的百分点按小数部分从大到小补给前面的项。
 * 为什么不直接 Math.round：4 套各 25 时 round 会得到 100，但 3 套 1/3 会得到 99 或 102，
 * 页面上就会显示「合计 99%」，看起来像坏了。
 *
 * 全部权重为 0（旧配置里生成的话术 weight 都是 0）→ 均分，而不是全 0。
 * 这是迁移路径：老用户打开页面看到的是「每套 25%」，而不是「全是 0，谁来都不回」。
 */
export function distributePercent(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const weights = list.map((item) => Math.max(0, Number(item?.weight) || 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    const base = Math.floor(100 / list.length);
    const rest = 100 - base * list.length;
    return list.map((_, index) => base + (index < rest ? 1 : 0));
  }
  const exact = weights.map((w) => (w / total) * 100);
  const floors = exact.map((v) => Math.floor(v));
  let left = 100 - floors.reduce((sum, v) => sum + v, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i += 1) {
    floors[order[i].index] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * 把「当前在用人设」的权重按百分比写回（合计 100）。
 * 删除某人之后的自动分配就是靠它：剩下的相对比例不变，绝对数值被拉到合计 100。
 * 例：50 / 30 / 10 / 10 删掉一个 10 → 写回 56 / 33 / 11。
 */
export function normalizeWeights(items) {
  const list = Array.isArray(items) ? items : [];
  const percents = distributePercent(list);
  return list.map((item, index) => ({ ...item, percent: percents[index], weight: percents[index] }));
}

/* ---------------- 读写 ---------------- */

function riskFilePath(projectDir) {
  return path.join(projectDir, RISK_REPLIES_REL_PATH);
}

function readRiskRaw(projectDir) {
  const file = riskFilePath(projectDir);
  try {
    return { raw: JSON.parse(fs.readFileSync(file, "utf8")), file, exists: true, error: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      raw: null,
      file,
      exists: !missing,
      error: missing ? null : `config/risk-replies.json 无法解析：${error.message}`,
    };
  }
}

function writeRiskRaw(projectDir, raw) {
  const file = riskFilePath(projectDir);
  const next = {
    ...raw,
    updated: new Date().toISOString(),
    roles: Array.isArray(raw.roles) ? raw.roles : [],
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/** role 是否绑定了某套人设（兼容「role.id 直接等于人设 id」的旧约定） */
function roleBelongsToPersona(role, personaId) {
  if (!role || !personaId) return false;
  return role.personaId === personaId || (!role.personaId && role.id === personaId);
}

function roleLineCount(role) {
  const pools = role?.pools ?? {};
  return ["dodge", "tease", "retort", "unclear"].reduce(
    (sum, key) => sum + (Array.isArray(pools[key]) ? pools[key].length : 0),
    0,
  );
}

/* ---------------- 视图 ---------------- */

/**
 * 派生风险人设库的完整视图（页面与 judge 共用，避免两边算法漂移）。
 *
 * @returns {{
 *   file:string, exists:boolean, error:string|null,
 *   ready:object[], pending:object[], legacy:object[], pool:object[],
 *   totals:{ready:number,pending:number,active:number,percentSum:number},
 *   warnings:{level:string,text:string}[]
 * }}
 */
export function describeRiskPersonas(projectDir, { personaLib = null } = {}) {
  const lib = personaLib ?? loadPersonaLibrary(projectDir, { persistMigration: false });
  const personas = Array.isArray(lib.items) ? lib.items : [];
  /**
   * ★ 文件不存在时 loadRiskReplies 会返回**内置兜底角色**（一套「默认」）。
   *   那是给 judge 保底"永远有话说"的，不是用户配置 —— 不能当成 legacy 显示出来，
   *   否则页面永远挂着一条「有 1 套话术没绑定人设」的假警告。
   *   配置坏了同理：读不出来就当没有，让用户先修文件。
   */
  const rawRisk = readRiskRaw(projectDir);
  const roles =
    rawRisk.exists && !rawRisk.error && Array.isArray(rawRisk.raw?.roles) ? rawRisk.raw.roles : [];

  const ready = [];
  const pending = [];
  const warnings = [];
  const usedRoleIds = new Set();

  for (const item of personas) {
    const role = roles.find((r) => roleBelongsToPersona(r, item.id)) ?? null;
    if (role) usedRoleIds.add(role.id);
    const lines = role ? roleLineCount(role) : 0;
    const base = {
      personaId: item.id,
      personaName: item.name,
      personaTagline: item.tagline ?? "",
      personaEnabled: item.persona?.enabled !== false,
      roleId: role?.id ?? null,
      roleName: role?.name ?? item.name,
    };
    if (!role || lines === 0) {
      pending.push({ ...base, lines });
      continue;
    }
    const active = role.active !== false && base.personaEnabled;
    ready.push({
      ...base,
      lines,
      active,
      weight: Math.max(0, Number(role.weight) || 0),
      counts: {
        dodge: role.pools?.dodge?.length ?? 0,
        tease: role.pools?.tease?.length ?? 0,
        retort: role.pools?.retort?.length ?? 0,
        unclear: role.pools?.unclear?.length ?? 0,
      },
      pools: {
        dodge: [...(role.pools?.dodge ?? [])],
        tease: [...(role.pools?.tease ?? [])],
        retort: [...(role.pools?.retort ?? [])],
        unclear: [...(role.pools?.unclear ?? [])],
      },
      fingerprintStale: Boolean(
        role.personaFingerprint &&
          item.persona &&
          role.personaFingerprint !== personaVoiceFingerprint(item.persona),
      ),
      note: role.note ?? "",
    });
  }

  // 没绑定任何现存人设的旧角色：不参与抽选，但要显示出来，否则就是「看不见的配置」
  const legacy = roles
    .filter((role) => !usedRoleIds.has(role.id))
    .map((role) => ({
      roleId: role.id,
      roleName: role.name,
      personaId: role.personaId ?? "",
      lines: roleLineCount(role),
      weight: Math.max(0, Number(role.weight) || 0),
    }));

  if (legacy.length) {
    warnings.push({
      level: "warn",
      text: `有 ${legacy.length} 套话术没绑定现存人设（${legacy.map((r) => r.roleName).join("、")}），不参与风险回复。要用人设库里的口吻，请给对应人设重新生成话术。`,
    });
  }

  const activeList = ready.filter((item) => item.active);
  const percents = distributePercent(activeList);
  activeList.forEach((item, index) => {
    item.percent = percents[index];
  });
  for (const item of ready) if (!item.active) item.percent = 0;

  if (ready.length && !activeList.length) {
    warnings.push({
      level: "bad",
      text: "风险人设库里没有任何一套被勾选「负责」→ 风险评论会退回通用口吻。至少勾一套。",
    });
  }
  if (!ready.length) {
    warnings.push({
      level: "warn",
      text: "风险人设库还是空的：没有一套人设生成过话术。风险评论目前用内置最小话术集（中性口吻、不省钱但能跑）。",
    });
  }
  if (activeList.length === 1) {
    warnings.push({
      level: "info",
      text: `风险评论目前 100% 由「${activeList[0].personaName}」回复。想换口吻就再勾一套并分配占比。`,
    });
  }
  const stale = ready.filter((item) => item.fingerprintStale);
  if (stale.length) {
    warnings.push({
      level: "warn",
      text: `${stale.map((i) => `「${i.personaName}」`).join("、")} 的人设口吻改过了，话术可能对不上——点「重新生成」更新。`,
    });
  }

  return {
    file: RISK_REPLIES_REL_PATH,
    exists: rawRisk.exists,
    error: rawRisk.error,
    ready,
    pending,
    legacy,
    /** 真正参与抽选的池子（judge 用这个） */
    pool: activeList
      .filter((item) => item.lines > 0)
      .map((item) => ({
        personaId: item.personaId,
        personaName: item.personaName,
        roleId: item.roleId,
        roleName: item.roleName,
        weight: item.weight,
        percent: item.percent,
      })),
    totals: {
      ready: ready.length,
      pending: pending.length,
      active: activeList.length,
      percentSum: activeList.reduce((sum, item) => sum + item.percent, 0),
    },
    warnings,
  };
}

/* ---------------- 抽选 ---------------- */

/**
 * 按占比抽一套风险人设。seed 约定 `${username}|${commentText}`：
 * 同一条评论永远抽到同一套（预览和真跑结果一致，重试也不换人）。
 *
 * 权重全 0（旧配置）→ 按人数均抽，而不是固定第一套。
 * 池子为空 → 返回 null，调用方回退到「跟随链路2 人设」的旧行为（保证永远有话说）。
 */
export function pickRiskPersona(projectDir, seed, { view = null } = {}) {
  const v = view ?? describeRiskPersonas(projectDir);
  const pool = v.pool;
  if (!pool.length) return null;
  const total = pool.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0) {
    return pool[stableHash(String(seed)) % pool.length];
  }
  let n = stableHash(String(seed)) % total;
  for (const item of pool) {
    const w = Math.max(0, item.weight);
    if (n < w) return item;
    n -= w;
  }
  return pool[pool.length - 1];
}

/* ---------------- 写入 ---------------- */

/**
 * 保存「谁负责 + 各自占比」。
 * items: [{ personaId, active, weight }]，只作用于已存在的 role（没话术的人不在这里）。
 * 保存时会：
 *   1. 把 active 的权重归一成合计 100 的整数（页面显示什么，文件里就是什么）；
 *   2. 未勾选的权重强制为 0（避免"勾掉了但还留着 30"以后再勾回来时占比莫名其妙）；
 *   3. 至少要求一套 active —— 否则风险评论会掉到通用口吻，这是配置错误，不是合法状态。
 */
export function saveRiskRouting(projectDir, input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const { raw, exists, error } = readRiskRaw(projectDir);
  if (error) return { ok: false, error };
  if (!exists || !raw) {
    return { ok: false, error: "还没有任何风险话术，先给一套人设生成话术再来分配占比" };
  }
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  if (!roles.length) {
    return { ok: false, error: "还没有任何风险话术，先给一套人设生成话术再来分配占比" };
  }

  const targets = [];
  for (const item of items) {
    const personaId = String(item?.personaId ?? "").trim();
    if (!personaId) continue;
    const role = roles.find((r) => roleBelongsToPersona(r, personaId));
    if (!role) continue;
    const active = item?.active !== false;
    const weightRaw = Number(item?.weight);
    targets.push({
      role,
      personaId,
      active,
      weight: Number.isFinite(weightRaw) ? Math.max(0, Math.min(100, Math.round(weightRaw))) : 0,
    });
  }
  if (!targets.length) return { ok: false, error: "没有匹配到任何一套风险话术" };

  const activeTargets = targets.filter((t) => t.active);
  if (!activeTargets.length) {
    return { ok: false, error: "至少要勾一套人设负责回复风险评论，否则风险评论没人回" };
  }

  const normalized = normalizeWeights(activeTargets);
  normalized.forEach((entry) => {
    entry.role.active = true;
    entry.role.weight = entry.weight;
  });
  for (const target of targets) {
    if (target.active) continue;
    target.role.active = false;
    target.role.weight = 0;
  }

  writeRiskRaw(projectDir, raw);
  return { ok: true, file: riskFilePath(projectDir), view: describeRiskPersonas(projectDir) };
}

/**
 * 删除某套风险话术 → 该人设回到「未生成话术」板。
 * 人设本身不动（那是链路2 的事）。
 */
export function revokeRiskReplies(projectDir, personaId) {
  const id = String(personaId ?? "").trim();
  if (!id) return { ok: false, error: "缺少人设 id" };
  const { raw, exists, error } = readRiskRaw(projectDir);
  if (error) return { ok: false, error };
  if (!exists || !raw) return { ok: false, error: "风险话术文件不存在，无需删除" };
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  const hit = roles.find((r) => roleBelongsToPersona(r, id));
  if (!hit) return { ok: false, error: "这套人设没有风险话术" };

  raw.roles = roles.filter((r) => !roleBelongsToPersona(r, id));
  // 删掉的如果正在负责，剩余的人按原比例自动补齐到 100
  const remaining = raw.roles.filter((r) => r.active !== false && roleLineCount(r) > 0);
  if (remaining.length) {
    const normalized = normalizeWeights(
      remaining.map((r) => ({ role: r, weight: Math.max(0, Number(r.weight) || 0) })),
    );
    normalized.forEach((entry) => {
      entry.role.weight = entry.weight;
    });
  }
  writeRiskRaw(projectDir, raw);
  return {
    ok: true,
    removed: { roleId: hit.id, roleName: hit.name },
    rebalanced: remaining.length > 0,
    view: describeRiskPersonas(projectDir),
  };
}

/**
 * 人设被删除时的级联：话术一起删，并把剩下的占比补满。
 * 与 revokeRiskReplies 的差别只在语义（调用方不同），实现共用一份，避免两处规则漂移。
 */
export function purgePersonaFromRisk(projectDir, personaId) {
  return revokeRiskReplies(projectDir, personaId);
}

/**
 * 新生成的话术并入「在岗池」。
 * 生成脚本给新角色的 weight 固定是 0（在老逻辑里 0 表示"不参与随机"），
 * 但风险人设库按占比抽人 —— 0 就等于"生成了但永远不用"。所以这里给它一个均分起点，
 * 再把整池归一；用户随后可以自己改。
 */
export function joinRiskPool(projectDir, personaId) {
  const id = String(personaId ?? "").trim();
  if (!id) return null;
  const { raw, exists, error } = readRiskRaw(projectDir);
  if (error || !exists || !raw) return null;
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  const role = roles.find((r) => roleBelongsToPersona(r, id));
  if (!role) return null;

  role.active = true;
  const pool = roles.filter((r) => r.active !== false && roleLineCount(r) > 0);
  if (Number(role.weight) <= 0) {
    /**
     * 起点给「现有在岗者的平均值」而不是 100/n：
     * 只有一人在岗时（100）新来的拿 100 → 归一成 50/50，是"均分"；
     * 已经 60/40 时新来的拿 50 → 约 40/27/33，接近均分又保留原有偏好。
     * 直接给 100 会让新人瞬间吃掉一半，作者会以为占比乱跳。
     */
    const others = pool.filter((r) => r !== role);
    const avg = others.length
      ? others.reduce((sum, r) => sum + Math.max(0, Number(r.weight) || 0), 0) / others.length
      : 100;
    role.weight = Math.max(1, Math.round(avg));
  }
  const normalized = normalizeWeights(
    pool.map((r) => ({ role: r, weight: Math.max(0, Number(r.weight) || 0) })),
  );
  normalized.forEach((entry) => {
    entry.role.weight = entry.weight;
  });
  writeRiskRaw(projectDir, raw);
  return { percent: normalized.find((entry) => entry.role === role)?.percent ?? null };
}

/** 给 judge / 页面用的一句话摘要（日志里能直接读） */
export function describeRouting(view) {
  if (!view?.pool?.length) return "风险人设库为空 → 风险回复走通用口吻";
  return view.pool.map((item) => `${item.personaName} ${item.percent}%`).join(" / ");
}
