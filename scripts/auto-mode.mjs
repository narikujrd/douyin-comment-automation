/**
 * auto-mode.mjs — 「自动回复」开关的唯一真相来源
 *
 * 用途：控制台页面上有一个总开关。开着的时候，控制台进程自己按间隔
 *      反复跑「采集 → 裁决 → 发送」（stage 2），新评论进来就会被自动回复，
 *      不用人盯着页面点「确认发送」。
 *
 * 2026-10-16 扩了两个能力（作者要求）：
 *   · headless —— 后台运行：自动轮不弹出创作者中心窗口（手动「跑一轮」仍可见，便于排查）；
 *   · schedule —— 定时时段：只在每天设定的时间段内自动回复（支持跨午夜，如 22:00–06:00），
 *     时段外自动挂起、到点自动恢复，不用手动开关。
 *
 * 设计要点：
 *   · 只是一个很小的配置文件（config/auto-reply.json），与 persona.json /
 *     works-switch.json 同级的"一份配置一个模块"约定。
 *   · 开关状态**持久化在磁盘**：控制台窗口关掉再开，开关还是原来的样子
 *     （关窗口期间不会跑 —— 自动模式寄生在控制台进程里，窗口开着才有效）。
 *   · 间隔分钟数有边界钳制：太短会对创作者中心高频开浏览器，太长失去"自动"的意义。
 *     范围 1–360 分钟，默认 10。
 *   · 本模块只负责读/校验/保存 + 时间窗计算，不碰浏览器、不碰子进程 —— 调度在
 *     ui-server.mjs 里做，保持"配置"与"行为"分离（同 persona.mjs 的边界）。
 */

import fs from "node:fs";
import path from "node:path";

export const AUTO_REL_PATH = "config/auto-reply.json";
export const AUTO_INTERVAL_DEFAULT = 10;
export const AUTO_INTERVAL_MIN = 1;
export const AUTO_INTERVAL_MAX = 360;

export const SCHEDULE_DEFAULT = { enabled: false, start: "08:00", end: "23:00" };

export function autoReplyPath(projectDir) {
  return path.join(projectDir, AUTO_REL_PATH);
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTO_INTERVAL_DEFAULT;
  return Math.min(AUTO_INTERVAL_MAX, Math.max(AUTO_INTERVAL_MIN, Math.round(n)));
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "8:05" → "08:05"；非法值返回 null（由调用方回退默认） */
export function normalizeTime(value) {
  const m = TIME_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

export function normalizeSchedule(input) {
  const src = input && typeof input === "object" ? input : {};
  const start = normalizeTime(src.start) ?? SCHEDULE_DEFAULT.start;
  const end = normalizeTime(src.end) ?? SCHEDULE_DEFAULT.end;
  return { enabled: src.enabled === true, start, end };
}

/** "HH:MM" → 当天的分钟数 */
function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/**
 * 现在是否在运行时段内。支持跨午夜：start > end 表示「晚上开始、次日凌晨结束」。
 * 例：22:00–06:00，凌晨 3 点在窗内、中午 12 点在窗外。
 */
export function isWithinSchedule(schedule, now = new Date()) {
  const s = normalizeSchedule(schedule);
  if (!s.enabled) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = minutesOfDay(s.start);
  const to = minutesOfDay(s.end);
  if (from === to) return false; // 零长度窗口 = 永不运行（显式配置，不当成 24 小时）
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

/**
 * 距离下一次「时段开始」还有多少毫秒（只在窗外时使用）。
 * 跨午夜也成立：窗外 07:00、窗口 22:00–06:00 → 等到当天 22:00。
 */
export function msUntilScheduleOpen(schedule, now = new Date()) {
  const s = normalizeSchedule(schedule);
  if (!s.enabled || isWithinSchedule(s, now)) return 0;
  const from = minutesOfDay(s.start);
  const target = new Date(now);
  target.setHours(Math.floor(from / 60), from % 60, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * 读取自动回复配置。文件不存在 = 未配置过（不是错误，返回默认关闭）；
 * 文件存在但坏了必须喊出来，否则用户以为自动模式还开着，实际已经静默失效。
 */
export function loadAuto(projectDir) {
  const file = autoReplyPath(projectDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      enabled: raw.enabled === true,
      intervalMinutes: clampInterval(raw.intervalMinutes),
      headless: raw.headless === true,
      schedule: normalizeSchedule(raw.schedule),
      file,
      error: null,
    };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      enabled: false,
      intervalMinutes: AUTO_INTERVAL_DEFAULT,
      headless: false,
      schedule: { ...SCHEDULE_DEFAULT },
      file,
      error: missing ? null : `自动回复配置无法解析，已按「关闭」处理：${error.message}`,
    };
  }
}

/**
 * 保存自动回复配置。整体写入、先落盘再返回，调用方以返回值为准更新界面。
 */
export function saveAuto(projectDir, { enabled, intervalMinutes, headless, schedule } = {}) {
  const next = {
    enabled: enabled === true,
    intervalMinutes: clampInterval(intervalMinutes),
    headless: headless === true,
    schedule: normalizeSchedule(schedule),
    updated: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
  const file = autoReplyPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { ...next, file };
}
