/**
 * 「已判定不回」短期记忆（C-26）
 *
 * 解决一个很具体的浪费：一条评论被判成「政治敏感，不回」之后，它在抖音页面上
 * 仍然是未回复状态 —— 下一轮采集又会把它捞出来，再花一次语义判定的钱，结论照旧。
 * 每 10 分钟一轮，一天 144 次。这个模块把结论记下来，之后直接跳过、零 token。
 *
 * 三条设计红线：
 *   1. **只缓存「不回」这个结论**。不缓存生成失败、不缓存回复文案 ——
 *      那些是偶发故障，缓存下来会变成永久的错。
 *   2. **判据一变，整批作废**。规则词表 / 风险提示词 / 处置策略任一文件内容变了，
 *      指纹就对不上，缓存全部失效。否则会出现「改了规则还按旧结论走」这种最难查的错。
 *   3. **过期自动清**。默认 7 天，最多 5000 条，按时间淘汰。
 *
 * 存储：state/skip-cache.json（纯本地，不进 git）。写入用临时文件 + rename，防写一半断电损坏。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SKIP_CACHE_REL_PATH = "state/skip-cache.json";

/** 参与指纹的三个文件：任何一个改了，之前的判定结论就不再可信 */
const FINGERPRINT_FILES = [
  "config/reply-rules.json",
  "config/prompt-risk.md",
  "config/risk-policy.json",
  /** 本地词表也算判据：改了词不重判，缓存就会拿旧结论套新规则 */
  "config/risk-policy.local.json",
];

/** 与 run-session 的去重归一化保持一致：同一句「！！」和「！！」必须算同一条 */
export function normalizeForCache(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfef0))
    .replace(/[，。！？、；：""''（）【】《》…—～·,.!?;:'"()<>[\]{}]/g, "");
}

/**
 * 指纹 = 三个判据文件的路径 + 内容。
 * 用内容而不是 mtime：改完又改回去（或复制一份相同的配置）不该让缓存白失效。
 */
export function policyFingerprint(projectDir) {
  const hash = crypto.createHash("sha1");
  for (const rel of FINGERPRINT_FILES) {
    hash.update(rel);
    try {
      hash.update(fs.readFileSync(path.join(projectDir, rel)));
    } catch {
      hash.update(":missing");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function cachePath(projectDir) {
  return path.join(projectDir, SKIP_CACHE_REL_PATH);
}

function emptyCache(fingerprint) {
  return { version: 1, updated: "", fingerprint, entries: {} };
}

/** 读缓存。文件不存在 / 坏了 → 空缓存（不抛错：缓存坏了顶多不省钱，不能阻断裁决） */
function readCache(projectDir, fingerprint) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(projectDir), "utf8"));
    const entries = raw && typeof raw.entries === "object" && raw.entries ? raw.entries : {};
    return {
      version: 1,
      updated: typeof raw?.updated === "string" ? raw.updated : "",
      fingerprint: typeof raw?.fingerprint === "string" ? raw.fingerprint : "",
      entries,
      corrupt: false,
    };
  } catch (error) {
    return {
      ...emptyCache(fingerprint),
      corrupt: error.code !== "ENOENT",
    };
  }
}

function writeCache(projectDir, cache) {
  const file = cachePath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const payload = { ...cache, updated: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function entryKey(workTitle, text) {
  const basis = `${workTitle ?? ""}\u0000${normalizeForCache(text)}`;
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

function isExpired(entry, maxAgeDays, now) {
  const ts = Number(entry?.ts ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return true;
  return now - ts > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * 查一条评论是否已经被判过「不回」。
 *
 * 返回：
 *   hit        = true 时可直接跳过，调用方**不要再调模型**
 *   invalidated= true 表示判据变了（指纹不一致），旧结论全部作废，本次未命中
 *   stale      = 命中了 key 但已过期，需要重新判
 */
export function lookupSkip(projectDir, { workTitle = "", text = "", maxAgeDays = null } = {}) {
  const fingerprint = policyFingerprint(projectDir);
  const cache = readCache(projectDir, fingerprint);
  const base = { hit: false, invalidated: false, stale: false, entry: null, fingerprint };

  if (cache.corrupt) return { ...base, corrupt: true };

  if (cache.fingerprint && cache.fingerprint !== fingerprint) {
    // 判据变了：整批作废。不在这里写盘（可能是只读调用），交给下一次 record 落盘。
    return { ...base, invalidated: true };
  }

  const key = entryKey(workTitle, text);
  const entry = cache.entries[key];
  if (!entry) return base;

  // 配置里的 TTL 优先（改配置立刻生效），没传就用写入时记下的值
  const ttl = Number(maxAgeDays ?? entry.maxAgeDays ?? 7);
  if (isExpired(entry, ttl, Date.now())) {
    return { ...base, stale: true, entry };
  }
  return { ...base, hit: true, entry };
}

/**
 * 记一条「不回」的结论。命中已存在的 key 则累加 hits（用来看「这条到底被跳过几次」）。
 *
 * 只应由「判定为 skip」的路径调用。写入时会顺手做过期清理与条数截断 ——
 * 放在写入路径上，是为了让读路径保持只读（预览、自测都能安全调用）。
 */
export function recordSkip(projectDir, {
  workTitle = "",
  username = "",
  text = "",
  category = "other",
  reason = "",
  level = "",
  maxAgeDays = 7,
  maxEntries = 5000,
} = {}) {
  const fingerprint = policyFingerprint(projectDir);
  let cache = readCache(projectDir, fingerprint);

  // 判据变了 → 从空开始（旧结论一条都不留）
  if (cache.corrupt || (cache.fingerprint && cache.fingerprint !== fingerprint)) {
    cache = emptyCache(fingerprint);
  }
  cache.fingerprint = fingerprint;

  const now = Date.now();
  // 清理过期，避免文件无限长大
  for (const [k, v] of Object.entries(cache.entries)) {
    if (isExpired(v, Number(v?.maxAgeDays ?? maxAgeDays), now)) delete cache.entries[k];
  }

  const key = entryKey(workTitle, text);
  const prev = cache.entries[key];
  cache.entries[key] = {
    category,
    level,
    reason: String(reason ?? "").slice(0, 120),
    workTitle: String(workTitle ?? "").slice(0, 80),
    username: String(username ?? "").slice(0, 60),
    text: String(text ?? "").slice(0, 120),
    ts: now,
    hits: Number(prev?.hits ?? 0) + 1,
    maxAgeDays: Number(maxAgeDays),
  };

  // 条数上限：按时间保留最新的
  const keys = Object.keys(cache.entries);
  if (keys.length > maxEntries) {
    keys
      .sort((a, b) => Number(cache.entries[a]?.ts ?? 0) - Number(cache.entries[b]?.ts ?? 0))
      .slice(0, keys.length - maxEntries)
      .forEach((k) => delete cache.entries[k]);
  }

  writeCache(projectDir, cache);
  return { ok: true, key, total: Object.keys(cache.entries).length, hits: cache.entries[key].hits };
}

/** 给控制台 / 报告用的统计。纯读，不写盘。 */
export function skipCacheStats(projectDir) {
  const fingerprint = policyFingerprint(projectDir);
  const cache = readCache(projectDir, fingerprint);
  const entries = Object.values(cache.entries);
  const byCategory = {};
  let totalHits = 0;
  let latest = 0;
  let oldest = 0;
  for (const e of entries) {
    const cat = e?.category ?? "other";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    totalHits += Number(e?.hits ?? 0);
    const ts = Number(e?.ts ?? 0);
    if (ts > latest) latest = ts;
    if (!oldest || ts < oldest) oldest = ts;
  }
  return {
    file: SKIP_CACHE_REL_PATH,
    exists: !cache.corrupt && Object.keys(cache.entries).length > 0,
    corrupt: Boolean(cache.corrupt),
    total: entries.length,
    /** 这些条目历史上一共被命中多少次（每次命中都省了一次模型调用） */
    totalHits,
    byCategory,
    latest: latest ? new Date(latest).toISOString() : "",
    oldest: oldest ? new Date(oldest).toISOString() : "",
    /** 判据变过 = 磁盘上的旧结论已不可信，下次裁决会整批重建 */
    invalidated: Boolean(cache.fingerprint) && cache.fingerprint !== fingerprint,
    fingerprint,
  };
}

/** 清空缓存（控制台按钮 / 自测）。返回被清掉的条数。 */
export function clearSkipCache(projectDir) {
  const fingerprint = policyFingerprint(projectDir);
  const cache = readCache(projectDir, fingerprint);
  const removed = Object.keys(cache.entries).length;
  writeCache(projectDir, emptyCache(fingerprint));
  return { ok: true, removed };
}
