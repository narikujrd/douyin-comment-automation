/**
 * persona-rotation.mjs — 「多套人设」模式配置的唯一真相来源
 *
 * 背景（2026-10-16 作者反馈）：只有一套人设时，每条回复都像一个模子刻出来的。
 * 现在支持：
 *   · single（默认）—— 固定用某一套（保持旧行为：自定义人设）；
 *   · random —— 从勾选的池子里**按评论随机挑一套**：同一条评论固定用同一套
 *     （seed = 用户名|评论内容，重试/复用不会换人），不同评论之间风格会变。
 *
 * 设计要点：
 *   · 只存"选哪几套、怎么切"，不存人设本体——人设本体统一在 config/personas.json
 *     （见 persona-store.mjs），本模块零重复存储；
 *   · 池子至少 1 套；引用不存在的人设 id 一律剔除（删掉一套人设后配置不会崩），
 *     剔除后 single 回退到「库里第一套」、池子回退到 [single]；
 *   · 本模块不碰浏览器、不调模型——配置与行为分离（同 auto-mode.mjs 的边界）。
 */

import fs from "node:fs";
import path from "node:path";

export const ROTATION_REL_PATH = "config/persona-rotation.json";

/**
 * 旧版「自定义人设」的固定 id。
 * 迁移后它仍是库里的第一套（config/personas.json 里 id = "custom"），
 * 所以这里保留它作为「没有任何 validIds 时的兜底」，维持旧配置的兼容。
 */
export const CUSTOM_PERSONA_ID = "custom";

export const ROTATION_DEFAULTS = {
  mode: "single",
  single: CUSTOM_PERSONA_ID,
  pool: [CUSTOM_PERSONA_ID],
};

export function rotationPath(projectDir) {
  return path.join(projectDir, ROTATION_REL_PATH);
}

/**
 * 归一化：收敛任何外部输入（页面/手改文件）。
 * validIds 给定时（= 人设库里现有的人设 id），池子与 fixed 里的未知 id 一律剔除，
 * 剔除后池子为空则回退 [single] —— 配置永远可用，不会因为删了一套人设就崩。
 *
 * ★ 2026-10-17 修：旧实现里 single 兜底写死 CUSTOM_PERSONA_ID，一旦作者把那套
 *   （或全部旧模板）删了，就会留下一个指向不存在人设的 single —— 页面下拉显示空、
 *   判裁层按未知 id 回退，两边行为不一致。现在兜底取 validIds[0]。
 */
export function normalizeRotation(input, { validIds = null } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const ok = (id) => typeof id === "string" && id && (!validIds || validIds.includes(id));

  const mode = src.mode === "random" ? "random" : "single";
  const fallback = validIds && validIds.length ? validIds[0] : CUSTOM_PERSONA_ID;
  const single = ok(src.single) ? src.single : fallback;

  let pool = Array.isArray(src.pool) ? src.pool.filter(ok) : [];
  pool = [...new Set(pool)];
  if (pool.length === 0) pool = [single];

  return { mode, single, pool };
}

export function loadRotation(projectDir, options = {}) {
  const file = rotationPath(projectDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { rotation: normalizeRotation(raw, options), file, error: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      rotation: normalizeRotation(ROTATION_DEFAULTS, options),
      file,
      error: missing ? null : `人设轮换配置无法解析，已回退「固定用一套人设」：${error.message}`,
    };
  }
}

export function saveRotation(projectDir, { mode, single, pool } = {}) {
  const rotation = normalizeRotation({ mode, single, pool });
  const file = rotationPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rotation, null, 2)}\n`, "utf8");
  return { rotation, file };
}

/** 与 judge.mjs 同源的稳定散列：同一 seed 永远得到同一个结果（重试不换人） */
export function stableHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 100000007;
  return hash;
}

/**
 * 按配置决定这条评论用哪套人设。
 * random 模式的稳定性保证：seed 相同 → 选出的 id 相同。
 * （seed 由调用方给 `${username}|${commentText}` —— 同一条评论重试、复用都不换人。）
 */
export function pickPersonaId(rotation, seed) {
  const r = normalizeRotation(rotation);
  if (r.mode === "single") return r.single;
  return r.pool[stableHash(String(seed ?? "")) % r.pool.length];
}
