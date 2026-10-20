import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LOCK_INITIALIZATION_GRACE_MS = 10000;
const LOCK_FILE_SUFFIX = ".openclaw-browser.lock";
const CHROMIUM_SINGLETON_NAMES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export class BrowserSessionBusyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BrowserSessionBusyError";
    this.code = "DOUYIN_BROWSER_BUSY";
    this.details = details;
  }
}

export function getBrowserSessionLockPath(userDataDir) {
  return `${path.resolve(userDataDir)}${LOCK_FILE_SUFFIX}`;
}

function readProcessStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) {
      return null;
    }
    const fieldsAfterCommand = stat
      .slice(closingParen + 2)
      .trim()
      .split(/\s+/);
    return fieldsAfterCommand[19] || null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isRecordedOwnerAlive(owner) {
  const pid = Number(owner?.pid);
  if (!isProcessAlive(pid)) {
    return false;
  }

  const currentStartTicks = readProcessStartTicks(pid);
  if (owner?.processStartTicks && currentStartTicks) {
    return String(owner.processStartTicks) === String(currentStartTicks);
  }

  // 无启动时钟时保守认为 PID 仍属于原任务，避免误删活跃锁。
  return true;
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
  } catch {
    return 0;
  }
}

function unlinkIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function getChromiumSingletonOwner(userDataDir) {
  const singletonLockPath = path.join(userDataDir, "SingletonLock");
  let target;
  try {
    target = fs.readlinkSync(singletonLockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return {
      active: true,
      pid: null,
      reason: "unreadable_singleton_lock"
    };
  }

  const pidMatch = target.match(/-(\d+)$/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  if (!pid || !isProcessAlive(pid)) {
    return {
      active: false,
      pid,
      target,
      reason: "stale_or_dead_singleton_owner"
    };
  }

  const command = readProcessCommand(pid);
  if (!command) {
    return {
      active: true,
      pid,
      target,
      reason: "live_singleton_owner_command_unavailable"
    };
  }

  const resolvedProfile = path.resolve(userDataDir);
  const ownsProfile =
    command.includes("chrom") && command.includes(`--user-data-dir=${resolvedProfile}`);
  return {
    active: ownsProfile,
    pid,
    target,
    reason: ownsProfile ? "live_chromium_profile_owner" : "reused_pid_or_stale_singleton"
  };
}

function removeStaleChromiumSingletons(userDataDir) {
  for (const name of CHROMIUM_SINGLETON_NAMES) {
    const singletonPath = path.join(userDataDir, name);
    try {
      const stat = fs.lstatSync(singletonPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(singletonPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function assertChromiumProfileAvailable(userDataDir) {
  const singletonOwner = getChromiumSingletonOwner(userDataDir);
  if (!singletonOwner) {
    return;
  }
  if (singletonOwner.active) {
    throw new BrowserSessionBusyError(
      `DOUYIN_BROWSER_BUSY: Chromium 登录档案正被进程 ${singletonOwner.pid ?? "unknown"} 使用。` +
        " 当前任务必须立即结束，禁止删除 SingletonLock 或自动重试。",
      {
        source: "chromium_singleton",
        userDataDir,
        ...singletonOwner
      }
    );
  }
  removeStaleChromiumSingletons(userDataDir);
}

function buildLockOwner(userDataDir) {
  return {
    version: 1,
    token: crypto.randomUUID(),
    pid: process.pid,
    processStartTicks: readProcessStartTicks(process.pid),
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    userDataDir,
    command: path.basename(process.argv[1] || process.argv[0] || "node")
  };
}

export function acquireBrowserSessionLock(userDataDir) {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const lockPath = getBrowserSessionLockPath(resolvedUserDataDir);
  fs.mkdirSync(path.dirname(resolvedUserDataDir), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = buildLockOwner(resolvedUserDataDir);
    let fileDescriptor;
    try {
      fileDescriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fileDescriptor, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;

      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        process.removeListener("exit", release);
        const currentOwner = readLockOwner(lockPath);
        if (currentOwner?.token === owner.token) {
          unlinkIfPresent(lockPath);
        }
      };
      process.once("exit", release);

      try {
        assertChromiumProfileAvailable(resolvedUserDataDir);
      } catch (error) {
        release();
        throw error;
      }

      return {
        lockPath,
        owner,
        release
      };
    } catch (error) {
      if (fileDescriptor !== undefined) {
        fs.closeSync(fileDescriptor);
      }
      if (error instanceof BrowserSessionBusyError) {
        throw error;
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existingOwner = readLockOwner(lockPath);
      if (existingOwner && isRecordedOwnerAlive(existingOwner)) {
        throw new BrowserSessionBusyError(
          `DOUYIN_BROWSER_BUSY: 另一个抖音任务正在运行（PID ${existingOwner.pid}，` +
            `命令 ${existingOwner.command || "unknown"}，开始于 ${existingOwner.acquiredAt || "unknown"}）。` +
            " 当前任务必须立即结束，不等待、不删除锁、不自动重试。",
          {
            source: "openclaw_browser_lock",
            lockPath,
            owner: existingOwner
          }
        );
      }

      if (!existingOwner && lockAgeMs(lockPath) < LOCK_INITIALIZATION_GRACE_MS) {
        throw new BrowserSessionBusyError(
          "DOUYIN_BROWSER_BUSY: 浏览器锁正在初始化。当前任务必须立即结束，不自动重试。",
          {
            source: "initializing_browser_lock",
            lockPath
          }
        );
      }

      unlinkIfPresent(lockPath);
    }
  }

  throw new BrowserSessionBusyError(
    "DOUYIN_BROWSER_BUSY: 无法取得抖音浏览器单实例锁，当前任务已停止。",
    { lockPath }
  );
}

export function attachBrowserSessionCleanup(context, reservation) {
  let shuttingDown = false;
  const signalHandlers = new Map();

  const cleanup = () => {
    reservation.release();
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };

  context.once("close", cleanup);

  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129]
  ]) {
    const handler = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      const forcedExit = setTimeout(() => {
        reservation.release();
        process.exit(exitCode);
      }, 5000);

      Promise.resolve(context.close())
        .catch(() => {})
        .finally(() => {
          clearTimeout(forcedExit);
          reservation.release();
          process.exit(exitCode);
        });
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}
