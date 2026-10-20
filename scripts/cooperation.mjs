/**
 * cooperation.mjs — 合作意向识别与待办清单
 *
 * 作者要的（2026-10-17）：
 *   「如果判断有合作需求的话，可以整理标记起来这些评论，你先回复了，
 *     后面我根据整理的评论去亲自再回复一遍。」
 *
 * 三条边界：
 *   1. **只标记，不承诺**。命中后仍走自动回复，但话术是中性的一句（config/templates.json 的
 *      cooperation 池），绝不出现「报价」「可以」「一定」这类承诺性表述。
 *   2. **留联系方式的合作评论照样不自动回**（硬红线在前，先拦）。但**仍然记进清单** ——
 *      那正是最需要作者亲自看的一类，不能因为没自动回就消失。
 *   3. **纯追加写**。judge 是"每个作品一个进程"顺序跑的，追加不会互相覆盖；读取时按 id 聚合，
 *      后面的补丁行覆盖前面的（线索 → 已回复文案 → 已处理）。
 *
 * 为什么不喊模型判：合作意向靠关键词就够（商务/接广/报价/寄样…），本地正则零成本、可解释、
 * 漏判的代价远小于"每条评论多花一次 token"。误标也不致命——多一条待办而已。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COOPERATION_REL_PATH = "state/cooperation-inbox.jsonl";

/**
 * 命中即视为合作线索。
 * 故意放宽（「合作」两个字就标）：漏掉一条真商单的代价，远大于待办里多一条误标。
 * 「达人」这类词单独出现容易误伤（夸别人是达人），但也保留——作者扫一眼就能否掉。
 */
export const COOPERATION_KEYWORDS = [
  "商务合作",
  "商务",
  "合作",
  "推广",
  "带货",
  "接广",
  "商单",
  "广告位",
  "植入",
  "寄样",
  "试用装",
  "报价",
  "预算",
  "投放",
  "坑位",
  "佣金",
  "返点",
  "品牌方",
  "甲方",
  "约稿",
];

/** 命中返回具体词（报告里要写清"因为哪个词"），没命中返回空串 */
export function detectCooperation(text) {
  const s = String(text ?? "");
  if (!s.trim()) return "";
  return COOPERATION_KEYWORDS.find((kw) => s.includes(kw)) ?? "";
}

function inboxPath(projectDir) {
  return path.join(projectDir, COOPERATION_REL_PATH);
}

/** 稳定 id：同一作品 + 同一用户 + 同一内容 = 同一条线索（重复跑轮次不会重复记） */
export function cooperationId({ workTitle = "", username = "", comment = "" }) {
  return crypto
    .createHash("sha1")
    .update(`${workTitle}\u0000${username}\u0000${comment}`)
    .digest("hex")
    .slice(0, 12);
}

function readLines(projectDir) {
  try {
    const raw = fs.readFileSync(inboxPath(projectDir), "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendRow(projectDir, row) {
  const file = inboxPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * 记一条线索（首次出现才写）。返回 id。
 * 每轮都会重新采到这些评论，所以必须做「已有就不写」的判断，否则清单会被同一批人刷满。
 */
export function recordCooperationLead(projectDir, { workTitle = "", username = "", comment = "", hit = "" } = {}) {
  const id = cooperationId({ workTitle, username, comment });
  const existing = readLines(projectDir);
  if (existing.some((row) => row.id === id && row.kind === "lead")) return id;
  appendRow(projectDir, {
    id,
    kind: "lead",
    at: new Date().toISOString(),
    workTitle,
    username,
    comment,
    hit,
  });
  return id;
}

/** 自动回复成功后补一行（读取时覆盖 lead 的 reply 字段） */
export function recordCooperationReply(projectDir, { workTitle = "", username = "", comment = "", reply = "" } = {}) {
  if (!reply) return;
  const id = cooperationId({ workTitle, username, comment });
  appendRow(projectDir, { id, kind: "reply", at: new Date().toISOString(), reply });
}

/** 标记已处理 / 撤销 */
export function markCooperationDone(projectDir, id, done = true) {
  const rows = readLines(projectDir);
  if (!rows.some((row) => row.id === id && row.kind === "lead")) {
    throw new Error("没有这条合作线索（可能已被清理）");
  }
  appendRow(projectDir, { id, kind: done ? "done" : "undone", at: new Date().toISOString() });
}

/**
 * ★ C-50（2026-10-19 作者要求）：作者亲自回过这条 → 从待办里**移除**。
 *
 * 为什么不物理删：
 *   · 这个文件是 judge 子进程「只追加」的，页面这边重写整个文件会和追加写打架（可能吞掉刚记的线索）；
 *   · 写一行 removed、读取时过滤掉，效果等同于删除，而且保留"这条我处理过"的痕迹。
 *
 * 删掉之后不会再冒出来：recordCooperationLead 判重看的是「有没有 lead 行」，
 * removed 不会让 lead 行消失；同一个人再发**不同内容**才会生成新线索。
 */
export function removeCooperation(projectDir, id) {
  const rows = readLines(projectDir);
  if (!rows.some((row) => row.id === id && row.kind === "lead")) {
    throw new Error("没有这条合作线索（可能已被清理）");
  }
  appendRow(projectDir, { id, kind: "removed", at: new Date().toISOString() });
}

/**
 * 读清单（按 id 聚合，取最后状态）。
 * 返回按「未处理优先 + 时间倒序」，最多 limit 条 —— 控制台只显示最近的，避免越滚越长的页面。
 */
export function loadCooperationInbox(projectDir, { limit = 60 } = {}) {
  const rows = readLines(projectDir);
  const map = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const cur = map.get(row.id) ?? {
      id: row.id,
      at: "",
      workTitle: "",
      username: "",
      comment: "",
      hit: "",
      reply: "",
      done: false,
      removed: false,
    };
    if (row.kind === "lead") {
      cur.at = row.at ?? cur.at;
      cur.workTitle = row.workTitle ?? "";
      cur.username = row.username ?? "";
      cur.comment = row.comment ?? "";
      cur.hit = row.hit ?? "";
    } else if (row.kind === "reply") {
      cur.reply = row.reply ?? cur.reply;
    } else if (row.kind === "done") {
      cur.done = true;
    } else if (row.kind === "undone") {
      cur.done = false;
    } else if (row.kind === "removed") {
      // C-50：作者已亲自回复并移除 —— 不再出现在清单里
      cur.removed = true;
    }
    map.set(row.id, cur);
  }

  const items = [...map.values()]
    .filter((item) => item.at && !item.removed)
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1; // 未处理在前
      return String(b.at).localeCompare(String(a.at)); // 新线索在前
    });

  return {
    items: items.slice(0, limit),
    total: items.length,
    newCount: items.filter((item) => !item.done).length,
    file: inboxPath(projectDir),
  };
}
