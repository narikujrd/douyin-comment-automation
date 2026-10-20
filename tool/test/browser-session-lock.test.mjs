import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireBrowserSessionLock,
  attachBrowserSessionCleanup,
  BrowserSessionBusyError,
  getBrowserSessionLockPath
} from "../src/lib/browser-session-lock.mjs";

function createTemporaryProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-browser-lock-test-"));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return profile;
}

test("同一个登录档案只能取得一个浏览器租约", (t) => {
  const profile = createTemporaryProfile(t);
  const reservation = acquireBrowserSessionLock(profile);

  assert.equal(fs.existsSync(getBrowserSessionLockPath(profile)), true);
  assert.throws(
    () => acquireBrowserSessionLock(profile),
    (error) => error instanceof BrowserSessionBusyError && error.code === "DOUYIN_BROWSER_BUSY"
  );

  reservation.release();
  assert.equal(fs.existsSync(getBrowserSessionLockPath(profile)), false);

  const nextReservation = acquireBrowserSessionLock(profile);
  nextReservation.release();
});

test("进程死亡后自动清理项目锁和 Chromium 陈旧锁", (t) => {
  const profile = createTemporaryProfile(t);
  const lockPath = getBrowserSessionLockPath(profile);
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      token: "stale",
      pid: 99999999,
      processStartTicks: "1",
      acquiredAt: "2020-01-01T00:00:00.000Z"
    })}\n`
  );
  for (const [name, target] of [
    ["SingletonLock", `${os.hostname()}-99999999`],
    ["SingletonSocket", "/tmp/nonexistent-douyin-socket"],
    ["SingletonCookie", "stale-cookie"]
  ]) {
    fs.symlinkSync(target, path.join(profile, name));
  }

  const reservation = acquireBrowserSessionLock(profile);
  assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false);
  assert.equal(fs.existsSync(path.join(profile, "SingletonSocket")), false);
  assert.equal(fs.existsSync(path.join(profile, "SingletonCookie")), false);
  reservation.release();
});

test("浏览器上下文关闭时释放租约并移除信号处理器", (t) => {
  const profile = createTemporaryProfile(t);
  const reservation = acquireBrowserSessionLock(profile);
  const context = new EventEmitter();
  context.close = async () => context.emit("close");

  attachBrowserSessionCleanup(context, reservation);
  context.emit("close");

  assert.equal(fs.existsSync(getBrowserSessionLockPath(profile)), false);
});
