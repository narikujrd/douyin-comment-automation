import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveDecisionInbox } from "../src/lib/interactive-decision-inbox.mjs";

test("后台 stdin 关闭后仍可从一次性决策文件接收回调", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-decision-inbox-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const decisionPath = path.join(root, "request.json");
  const closedIterator = {
    next: async () => ({ done: true })
  };
  const inbox = new InteractiveDecisionInbox(closedIterator, { pollIntervalMs: 10 });

  setTimeout(() => {
    fs.writeFileSync(decisionPath, `${JSON.stringify({ requestId: "request", action: "skip" })}\n`);
  }, 30);

  const result = await inbox.next({ decisionPath, timeoutMs: 1000 });
  assert.equal(result.source, "file");
  assert.equal(JSON.parse(result.value).action, "skip");
  assert.equal(fs.existsSync(decisionPath), false);
});

test("没有文件回调时保留原有 stdin 行协议", async () => {
  const values = [JSON.stringify({ requestId: "request", action: "reply" })];
  const iterator = {
    next: async () => (values.length > 0 ? { value: values.shift(), done: false } : { done: true })
  };
  const inbox = new InteractiveDecisionInbox(iterator, { pollIntervalMs: 10 });
  const result = await inbox.next({ timeoutMs: 1000 });
  assert.equal(result.source, "stdin");
  assert.equal(JSON.parse(result.value).action, "reply");
});
