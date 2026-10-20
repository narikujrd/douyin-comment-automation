/**
 * works-switch.mjs — 「哪些作品开启自动回复」的唯一真相来源
 *
 * 为什么单独抽一个模块：这份开关同时被两条链路消费——
 *   · scripts/run-batch.mjs  生产：决定这一轮跑哪些作品
 *   · scripts/ui-server.mjs  控制台：页面里勾选 / 展示
 * 匹配逻辑必须只有一份，否则会出现「页面显示已开启，实际没跑」这种错位。
 *
 * ★ 为什么不能用 title 当唯一键：实测作者的 26 个作品里有 4 个标题都叫「2」，
 *   （发布于 2023-07-18 / 07-16 / 08-31 / 08-25）。用 title 做键会导致
 *   「勾了第 13 条，结果第 12、17、18 条一起被打开」——静默跑错作品。
 *   因此主键 = title + 发布时间（组合后实测唯一）。
 */

import fs from "node:fs";
import path from "node:path";

export const SWITCH_REL_PATH = "config/works-switch.json";

export const SWITCH_MODES = ["latest", "selected", "all"];

export const DEFAULT_SWITCH = {
  version: "1.0",
  updated: "",
  /** latest = 只跑最新作品（旧默认行为）；selected = 按下面勾选跑；all = 全量 */
  mode: "latest",
  works: {},
};

export function switchPath(projectDir) {
  return path.join(projectDir, SWITCH_REL_PATH);
}

/** 作品唯一键。title 单独不唯一（实测有 4 条都叫「2」），故拼上发布时间 */
export function workKey(work) {
  const title = String(work?.title ?? "").trim();
  const publish = String(work?.publishText ?? "").trim();
  return publish ? `${title}@${publish}` : title;
}

/** 兼容旧版只按 title 存的键（写入时一律用 workKey） */
function titleOf(key) {
  return String(key).split("@")[0];
}

export function loadSwitch(projectDir) {
  const file = switchPath(projectDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { sw: normalizeSwitch(raw), file, exists: true, error: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      sw: { ...DEFAULT_SWITCH, works: {} },
      file,
      exists: !missing,
      error: missing ? null : `作品开关文件无法解析，已回退默认（只跑最新作品）：${error.message}`,
    };
  }
}

export function normalizeSwitch(input) {
  const src = input && typeof input === "object" ? input : {};
  const mode = SWITCH_MODES.includes(src.mode) ? src.mode : DEFAULT_SWITCH.mode;
  const works = {};
  const rawWorks = src.works && typeof src.works === "object" ? src.works : {};
  for (const [key, value] of Object.entries(rawWorks)) {
    const k = String(key ?? "").trim();
    if (!k) continue;
    works[k] = {
      enabled: value?.enabled === true,
      publishText: String(value?.publishText ?? "").trim(),
      updated: String(value?.updated ?? "").trim(),
    };
  }
  return {
    version: "1.0",
    updated: String(src.updated ?? "").trim(),
    mode,
    works,
  };
}

export function saveSwitch(projectDir, input) {
  const sw = normalizeSwitch({ ...input, updated: new Date().toISOString().slice(0, 10) });
  const file = switchPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sw, null, 2)}\n`, "utf8");
  return { sw, file };
}

/**
 * 某个作品是否已勾选。三级容错，顺序不能变：
 *   1. 精确键（title@发布时间）—— 主路径
 *   2. 标题在本轮列表中唯一时，允许只按 title 匹配（容忍平台改了时间显示格式）
 *   3. 都不中 → 未启用（默认关闭，宁可少跑不可错跑）
 */
export function resolveEnabled(sw, work, allWorks = []) {
  const key = workKey(work);
  const entry = sw.works[key];
  if (entry) return { enabled: entry.enabled === true, matchedBy: "key" };

  const title = String(work?.title ?? "").trim();
  const sameTitle = allWorks.filter((w) => String(w?.title ?? "").trim() === title);
  if (sameTitle.length === 1) {
    const legacy = sw.works[title];
    if (legacy) return { enabled: legacy.enabled === true, matchedBy: "title" };
  } else if (sameTitle.length > 1) {
    // 同名作品 >1 且没有精确键 → 无法安全判定，视为未启用（并在 UI 提示）
    const legacy = sw.works[title];
    if (legacy) return { enabled: false, matchedBy: "ambiguous_title" };
  }
  return { enabled: false, matchedBy: "none" };
}

export function parsePublishTime(work) {
  const m = String(work?.publishText ?? "").match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

export function sortByPublishDesc(works) {
  return [...works].sort((a, b) => {
    const ta = parsePublishTime(a);
    const tb = parsePublishTime(b);
    if (ta && tb) return tb - ta;
    if (ta) return -1;
    if (tb) return 1;
    return 0;
  });
}

/** 取发布时间最新的一个（解析失败则退回列表第一条） */
export function pickLatest(works) {
  const dated = works.filter((w) => parsePublishTime(w));
  if (!dated.length) return works[0] ?? null;
  return dated.sort((a, b) => parsePublishTime(b) - parsePublishTime(a))[0];
}

/**
 * 决定本轮跑哪些作品。优先级：
 *   1. --work "<标题片段>"   手动指定（命令行最高优先，覆盖页面开关）
 *   2. --all-works           命令行要求全量
 *   3. 页面里的 mode：
 *        all      → 全量
 *        selected → 只跑勾选且**当前列表里确实存在**的作品
 *        latest   → 只跑最新
 * 返回值带 reason，便于 run-batch 原样打印给用户 —— 「为什么只跑了这个」必须可见。
 */
export function selectWorks(works, sw, { work, allWorks, maxWorks } = {}) {
  if (work) {
    const matched = works.filter((item) => String(item?.title ?? "").includes(work));
    return { selected: matched, reason: `命令行 --work「${work}」`, source: "cli-work" };
  }
  if (allWorks) {
    const list = works.slice(0, maxWorks ?? works.length);
    return { selected: list, reason: "命令行 --all-works", source: "cli-all" };
  }

  if (sw.mode === "all") {
    const list = works.slice(0, maxWorks ?? works.length);
    return { selected: list, reason: "控制台设置 = 全部作品", source: "ui-all" };
  }

  if (sw.mode === "selected") {
    const selected = works.filter((w) => resolveEnabled(sw, w, works).enabled);
    const limit = maxWorks ?? selected.length;
    return {
      selected: selected.slice(0, limit),
      reason: `控制台设置 = 按勾选（共勾选 ${selected.length} 个）`,
      source: "ui-selected",
    };
  }

  const latest = pickLatest(works);
  return {
    selected: latest ? [latest] : [],
    reason: "控制台设置 = 只跑最新作品",
    source: "ui-latest",
  };
}
