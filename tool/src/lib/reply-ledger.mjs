import fs from "node:fs";
import path from "node:path";
import { canonicalWorkTitle, normalizeText, normalizeUsername } from "./common.mjs";

export const DEFAULT_REPLY_LEDGER_PATH = path.resolve("comments-output/reply-ledger.jsonl");

const ledgerCache = new Map();
const STALE_LEDGER_LOCK_MS = 5 * 60 * 1000;

function resolveLedgerPath(options = {}) {
  return path.resolve(
    options.replyLedgerPath || process.env.REPLY_LEDGER_PATH || DEFAULT_REPLY_LEDGER_PATH
  );
}

export function buildReplyLedgerKey(workTitle, username, commentText) {
  return JSON.stringify([
    canonicalWorkTitle(workTitle),
    normalizeUsername(username).toLowerCase(),
    normalizeText(commentText)
  ]);
}

function readLedgerState(options = {}) {
  const ledgerPath = resolveLedgerPath(options);
  let stat;
  try {
    stat = fs.statSync(ledgerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ledgerPath,
        entries: new Map()
      };
    }
    throw error;
  }

  const cached = ledgerCache.get(ledgerPath);
  if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) {
    return cached;
  }

  const entries = new Map();
  const raw = fs.readFileSync(ledgerPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const key =
        event.key || buildReplyLedgerKey(event.workTitle, event.username, event.commentText);
      if (!key || event.status === "released") {
        entries.delete(key);
        continue;
      }
      entries.set(key, event);
    } catch {
      // 单行损坏不影响其他追加记录；发送前仍会使用所有可解析的历史记录。
    }
  }

  const state = {
    ledgerPath,
    entries,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
  ledgerCache.set(ledgerPath, state);
  return state;
}

export function getReplyLedgerEntry(workTitle, username, commentText, options = {}) {
  if (!workTitle || !username || !commentText) {
    return null;
  }

  const state = readLedgerState(options);
  return state.entries.get(buildReplyLedgerKey(workTitle, username, commentText)) ?? null;
}

export function getReplyLedgerMatchMap(workTitle, comments, options = {}) {
  if (!workTitle || !Array.isArray(comments) || comments.length === 0) {
    return new Map();
  }

  const state = readLedgerState(options);
  const result = new Map();
  for (const comment of comments) {
    const key = buildReplyLedgerKey(workTitle, comment.username, comment.commentText);
    const event = state.entries.get(key);
    if (event) {
      result.set(`${comment.username}|||${comment.commentText}`, event);
    }
  }
  return result;
}

export function appendReplyLedgerEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  const ledgerPath = resolveLedgerPath(options);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const timestamp = new Date().toISOString();
  const normalizedEvents = events
    .filter((event) => event?.workTitle && event?.username && event?.commentText && event?.status)
    .map((event) => ({
      version: 1,
      recordedAt: event.recordedAt || timestamp,
      key: buildReplyLedgerKey(event.workTitle, event.username, event.commentText),
      workTitle: canonicalWorkTitle(event.workTitle),
      username: normalizeUsername(event.username),
      commentText: normalizeText(event.commentText),
      publishText: normalizeText(event.publishText || ""),
      replyMessage: event.replyMessage == null ? null : String(event.replyMessage),
      status: String(event.status),
      source: String(event.source || "reply_flow")
    }));

  if (normalizedEvents.length === 0) {
    return 0;
  }

  const fd = fs.openSync(ledgerPath, "a");
  try {
    fs.writeSync(fd, `${normalizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  ledgerCache.delete(ledgerPath);
  return normalizedEvents.length;
}

/**
 * 只把台账中尚不存在的历史事件追加进去。用于将数据库中已有的回复记录迁移到
 * 独立 JSONL 台账；重复执行不会不断写入相同评论。
 */
export function backfillReplyLedgerEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      appendedCount: 0,
      existingCount: 0
    };
  }

  const state = readLedgerState(options);
  const pendingKeys = new Set();
  const pendingEvents = [];
  let existingCount = 0;

  for (const event of events) {
    if (!event?.workTitle || !event?.username || !event?.commentText || !event?.status) {
      continue;
    }

    const key = buildReplyLedgerKey(event.workTitle, event.username, event.commentText);
    if (state.entries.has(key) || pendingKeys.has(key)) {
      existingCount += 1;
      continue;
    }

    pendingKeys.add(key);
    pendingEvents.push(event);
  }

  return {
    appendedCount: appendReplyLedgerEvents(pendingEvents, options),
    existingCount
  };
}

export function recordReplyLedgerEvent(event, options = {}) {
  return appendReplyLedgerEvents([event], options);
}

function acquireLedgerLock(ledgerPath) {
  const lockPath = `${ledgerPath}.lock`;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      let stat;
      try {
        stat = fs.statSync(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() - stat.mtimeMs <= STALE_LEDGER_LOCK_MS) {
        return null;
      }

      // 进程被强制结束时可能遗留锁；超过五分钟才视为陈旧锁并清理。
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  return null;
}

/**
 * 原子地为一次发送占位。多个回复进程同时处理同一评论时，只有一个进程能写入
 * send_attempted；其余进程看到已有记录或短暂锁定后必须跳过。
 */
export function reserveReplyLedgerAttempt(event, options = {}) {
  if (!event?.workTitle || !event?.username || !event?.commentText) {
    throw new Error("Cannot reserve reply attempt without workTitle, username and commentText.");
  }

  const ledgerPath = resolveLedgerPath(options);
  const lock = acquireLedgerLock(ledgerPath);
  if (!lock) {
    return {
      reserved: false,
      reason: "ledger_locked",
      existingEntry: null
    };
  }

  try {
    ledgerCache.delete(ledgerPath);
    const existingEntry = getReplyLedgerEntry(
      event.workTitle,
      event.username,
      event.commentText,
      options
    );
    // ★ allowReReply（2026-10-16）：本项目以创作者中心「未回复」为准、同一内容上限 3 条，
    //   旧台账记录不得否决重试。并发保护仍由文件锁承担（同一时刻只有一个进程能进到这里）。
    if (existingEntry && !options?.allowReReply) {
      return {
        reserved: false,
        reason: "existing_entry",
        existingEntry
      };
    }

    recordReplyLedgerEvent(
      {
        ...event,
        status: "send_attempted",
        source: event.source || "reply_flow"
      },
      options
    );
    return {
      reserved: true,
      reason: "reserved",
      existingEntry: null
    };
  } finally {
    fs.closeSync(lock.fd);
    try {
      fs.unlinkSync(lock.lockPath);
    } catch {
      // 清理失败时保留锁；陈旧锁机制会在五分钟后安全回收。
    }
  }
}
