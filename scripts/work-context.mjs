/**
 * work-context.mjs — 「这条视频在讲什么」的唯一真相来源
 *
 * 为什么需要它：风险判定和文案生成原先都**只看评论本身**。后果是两个方向的错：
 *   · 视频是「买瓜」名场面，评论「你这瓜怎么卖的」是玩梗 → 被判成"询问价格"→ 转人工（**该回没回**）；
 *   · 同一条视频下评论「杀人啦」是复述台词 → 被判成"威胁"→ hard（**该回没回**）。
 *   · 反过来：真来维权的「我要退款」如果因为"视频很抽象"被放行 → **该拦没拦**，那才是要命的。
 * 所以本模块只提供**事实性语境**（这视频是什么、在玩什么梗），
 * 而"能不能因此放宽"由提示词里的安全边界严格限定 —— 语境只用于识别**玩梗**，
 * 绝不允许降低真实诉求/纠纷/联系方式/导流等红线的等级。
 *
 * 数据来源三层（能自动的自动，该人工的人工）：
 *   1. 视频标题（平台自动抓，免费）—— 含话题标签，往往已带梗的线索；
 *   2. 话题标签（从标题里解析出来，单独列给模型看，信号更干净）；
 *   3. 「内容说明」（作者在控制台里手填一句，最有效但需要人工）。
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizePersonaText } from "./persona.mjs";

export const WORK_CONTEXT_REL_PATH = "config/work-context.json";

/** 每条视频的说明上限。200 字够描述清一条视频的梗，同时不至于把每条评论的输入 token 撑爆。 */
export const NOTE_MAX = 200;

export const DEFAULT_CONTEXT = {
  version: "1.0",
  updated: "",
  works: {},
};

export function contextPath(projectDir) {
  return path.join(projectDir, WORK_CONTEXT_REL_PATH);
}

export function normalizeContext(input) {
  const src = input && typeof input === "object" ? input : {};
  const works = {};
  const rawWorks = src.works && typeof src.works === "object" ? src.works : {};
  for (const [key, value] of Object.entries(rawWorks)) {
    const k = String(key ?? "").trim();
    if (!k) continue;
    const note = String(value?.note ?? "").trim().slice(0, NOTE_MAX);
    if (!note) continue; // 空说明 = 没填，不占存储
    works[k] = { note, updated: String(value?.updated ?? "").trim() };
  }
  return {
    version: "1.0",
    updated: String(src.updated ?? "").trim(),
    works,
  };
}

export function loadContext(projectDir) {
  const file = contextPath(projectDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ctx: normalizeContext(raw), file, exists: true, error: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      ctx: { ...DEFAULT_CONTEXT, works: {} },
      file,
      exists: !missing,
      // 文件不存在 = 正常（还没填过）；存在但坏了 = 必须喊出来，否则会静默"以为填了"
      error: missing ? null : `视频语境文件无法解析，已按「未填写」处理：${error.message}`,
    };
  }
}

export function saveContext(projectDir, input) {
  const ctx = normalizeContext({ ...input, updated: new Date().toISOString().slice(0, 10) });
  const file = contextPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ctx, null, 2)}\n`, "utf8");
  return { ctx, file };
}

/** 与 works-switch.mjs 同一个键规则：title 单独不唯一（实测有 4 条都叫「2」）。 */
function workKeyOf(work) {
  const title = String(work?.title ?? "").trim();
  const publish = String(work?.publishText ?? "").trim();
  return publish ? `${title}@${publish}` : title;
}

/**
 * 查某个作品的语境。返回 null = 没填过（不是错误，属正常情况）。
 *
 * 匹配策略：**默认只认精确键**（title@发布时间）。
 * 标题回退**必须显式传 allWorks 才启用**，且仅当该标题在本轮列表中唯一时生效 ——
 * 否则「4 个作品都叫『2』」时会把别人填的语境套到这条视频上，判定参考了错的视频。
 * 生产链路（judge.mjs）不传 allWorks，即走严格模式；控制台手选作品预览时才按标题找。
 */
export function getWorkContext(ctx, work, allWorks = []) {
  const key = workKeyOf(work);
  const entry = ctx.works[key];
  if (entry) return { key, note: entry.note, matchedBy: "key" };

  if (!allWorks.length) return null;
  const title = String(work?.title ?? "").trim();
  const sameTitle = allWorks.filter((w) => String(w?.title ?? "").trim() === title);
  if (sameTitle.length === 1) {
    const legacy = ctx.works[title];
    if (legacy) return { key: title, note: legacy.note, matchedBy: "title" };
  }
  return null;
}

/** 预览模式用：按标题片段找语境（找不到就返回 null，由调用方决定怎么提示） */
export function findContextByTitle(ctx, titlePart) {
  const needle = String(titlePart ?? "").trim();
  if (!needle) return null;
  for (const [key, entry] of Object.entries(ctx.works)) {
    const title = key.split("@")[0];
    if (title.includes(needle) || key.includes(needle)) {
      return { key, note: entry.note, title, matchedBy: "title_part" };
    }
  }
  return null;
}

/**
 * 从标题里解析话题标签。抖音标题形如「字节万家灯火商家bd群面。#面试#bd」，
 * 话题标签在标题里连成一串。单独摘出来给模型，信号比混在标题里干净。
 */
export function extractHashtags(title) {
  const found = String(title ?? "").match(/#[^\s#。，,.！!？?；;：:]+/g);
  if (!found) return [];
  return [...new Set(found.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))].slice(0, 8);
}

/**
 * 拼「视频语境」注入片段。设计要点：
 *   · **永远有输出**（哪怕只拿到标题）——标题本身就是语境，缺了它模型只能盲判；
 *   · 显式写清**语境能做什么**（识别玩梗 / 让回复接得上）与**不能做什么**
 *     （不得降低真实纠纷、退款投诉、联系方式、导流等红线的等级）；
 *   · 素材全部过转义（防提示词结构被破坏），与 persona 同一套。
 */
export function buildWorkContextBlock({ work, note } = {}) {
  const notes = [];
  const title = String(work?.title ?? "").trim();
  const publishText = String(work?.publishText ?? "").trim();
  const tags = extractHashtags(title);

  const push = (field, value) => {
    const r = sanitizePersonaText(value, { field });
    notes.push(...r.notes);
    return r.text;
  };

  const lines = [];

  /**
   * 完全没有语境时的兜底：**必须显式告诉模型"没有语境"**，
   * 否则它会自己脑补"这条大概是在玩梗"→ 把真投诉也放过去。
   * 没有语境时的正确姿态是：只按字面判，保守优先。
   */
  if (!title && !note) {
    return {
      block: [
        "## 本条评论所在的视频",
        "",
        "本轮**未提供视频语境**（没有指定作品）。",
        "→ 请**只按评论字面**判定与回复，**不要假设评论在玩梗**；拿不准一律按更保守的那一档。",
      ].join("\n"),
      title: "",
      tags: [],
      note: "",
      hasContext: false,
      strength: "none",
      notes,
    };
  }

  const t = push("视频标题", title);
  lines.push("## 本条评论所在的视频（判定与回复都要参考）");
  lines.push("");
  lines.push(`- 视频标题：${t}`);
  if (publishText) lines.push(`- 发布时间：${push("发布时间", publishText)}`);
  if (tags.length) lines.push(`- 话题标签：${tags.map((x) => push("话题标签", x)).join("、")}`);
  if (note) lines.push(`- 创作者本人补充的内容说明：${push("内容说明", note)}`);
  lines.push("");
  lines.push("### 这段语境怎么用（两个方向，别用反）");
  lines.push("");
  lines.push(
    "- **可以用**：判断评论是不是在**呼应这条视频的内容或玩梗**（是玩梗就别按字面判风险）；" +
      "以及让回复**接得上这条视频**，而不是答非所问。",
  );
  lines.push(
    "- **绝对不可以**用：拿「这条视频很抽象」当理由，去**降低**涉及真实纠纷、退款投诉、" +
      "辱骂威胁、索要联系方式、站外引流、政治宗教色情赌博等内容的判定等级。" +
      "这类评论**无论视频是什么，一律照常判 hard / soft**。",
  );

  const hasContext = Boolean(note) || tags.length > 0;
  return {
    block: lines.join("\n"),
    title,
    tags,
    note: note ?? "",
    hasContext,
    /** 只有标题时算"弱语境"：能防答非所问，但不足以可靠识别玩梗 */
    strength: note ? "full" : tags.length ? "tags" : "title_only",
    notes,
  };
}
