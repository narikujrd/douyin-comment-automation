#!/usr/bin/env node
/**
 * 一次性脚本：将 comments-output/all-works/ 下已有的导出 JSON 批量导入数据库。
 */

import fs from "node:fs";
import path from "node:path";
import { upsertComments } from "./lib/db-ops.mjs";
import { closeDb } from "./lib/db.mjs";

const WORKS_DIR = path.resolve("comments-output/all-works");

const files = fs.readdirSync(WORKS_DIR).filter((f) => f.endsWith(".json"));
let totalFiles = 0;
let totalInserted = 0;

for (const file of files) {
  const filePath = path.join(WORKS_DIR, file);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`跳过 ${file}（解析失败）: ${err.message}`);
    continue;
  }

  const workTitle = data?.selectedWork?.title;
  const comments = data?.comments;

  if (!workTitle || !Array.isArray(comments) || comments.length === 0) {
    console.warn(`跳过 ${file}（缺少 selectedWork.title 或 comments 为空）`);
    continue;
  }

  const rows = comments.map((c) => ({
    username: c.username,
    commentText: c.commentText,
    replyMessage: null
  }));

  upsertComments(workTitle, rows);

  console.log(`✓ ${workTitle}：插入 ${rows.length} 条`);
  totalFiles += 1;
  totalInserted += rows.length;
}

console.log(`\n完成：共处理 ${totalFiles} 个文件，${totalInserted} 条评论已写入数据库。`);
closeDb();
