import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getInteractiveWorkOutputPath,
  loadInteractiveWorkQueue,
  summarizeInteractiveWorkResults
} from "../src/lib/interactive-work-queue.mjs";

test("多作品队列按顺序限量读取且生成独立输出路径", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-work-queue-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worksFile = path.join(root, "works.json");
  fs.writeFileSync(
    worksFile,
    `${JSON.stringify({
      works: [
        { title: "作品一", publishText: "发布于2026年07月15日 20:00" },
        { title: "作品二", publishText: "发布于2026年07月14日 20:00" },
        { title: "作品三" }
      ]
    })}\n`
  );

  const queue = loadInteractiveWorkQueue(worksFile, 2);
  assert.deepEqual(queue.works, [
    { title: "作品一", publishText: "发布于2026年07月15日 20:00" },
    { title: "作品二", publishText: "发布于2026年07月14日 20:00" }
  ]);
  assert.equal(
    getInteractiveWorkOutputPath(path.join(root, "out"), 0),
    path.join(root, "out/work-01.json")
  );
  assert.equal(
    getInteractiveWorkOutputPath(path.join(root, "out"), 9),
    path.join(root, "out/work-10.json")
  );
});

test("多作品汇总只累计审计计数", () => {
  const summary = summarizeInteractiveWorkResults([
    {
      selectedWork: { title: "作品一" },
      outputPath: "/tmp/01.json",
      exitReason: "done",
      decisionCount: 2,
      repliedCount: 1,
      skippedCount: 1,
      totalProcessed: 2
    },
    {
      selectedWork: { title: "作品二" },
      outputPath: "/tmp/02.json",
      exitReason: "done",
      decisionCount: 1,
      sentUnconfirmedCount: 1,
      totalProcessed: 1
    }
  ]);

  assert.equal(summary.processedWorkCount, 2);
  assert.equal(summary.decisionCount, 3);
  assert.equal(summary.repliedCount, 1);
  assert.equal(summary.sentUnconfirmedCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.totalProcessed, 3);
  assert.equal(summary.works.length, 2);
});
