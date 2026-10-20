---
name: douyin-creator
description: "抖音（Douyin）创作者中心作品与评论自动化：获取已发布作品列表、导出指定作品的未回复评论、让模型逐条决策回复或按 JSON 批量回复。当用户提到抖音、创作者中心、作品列表、导出评论、回复评论、逐条回复、未回复评论或批量回复时触发。"
metadata: { "openclaw": { "requires": { "bins": ["node", "npm", "npx"] } } }
---

# douyin-creator

用仓库 `douyin-creator-tools` 的 CLI 完成作品列表、评论导出、逐条模型决策回复和 JSON 批量回复。不要自己用 Playwright 重写。

所有命令共用一个登录档案，必须严格串行。全程最多运行一个抖音命令；前一个进程退出前不得启动下一个。出现 `DOUYIN_BROWSER_BUSY` 时立即结束本轮，不等待、不重试、不杀进程，也不要删除 `.openclaw-browser.lock` 或任何 `Singleton*` 文件。

## 项目根

`$PROJECT_DIR = ~/.openclaw/douyin-creator-tools`（仓库固定 clone 到此位置）。

依赖安装、Chromium 安装、扫码登录等**初始化步骤不在本 skill 范围**，由 `$PROJECT_DIR/README.md` 负责。命令执行时报「需要登录 / 跳转到登录页 / 找不到 chromium / 缺依赖」等环境问题时，**停止执行**并要求用户按 README 完成对应初始化，不要自作主张替用户安装或登录。

## 工作流 1：作品列表

```bash
cd "$PROJECT_DIR" && npm run works
```

输出 `$PROJECT_DIR/comments-output/list-works.json`：

```json
{ "count": 2, "works": [{ "title": "作品标题" }] }
```

## 工作流 2：导出未回复评论

```bash
cd "$PROJECT_DIR" && npm run comments:export -- "<作品标题>"
```

- 位置参数必填：作品标题，从工作流 1 的 `works[].title` 里取，带空格必须加双引号
- 标题匹配规则：页面上作品标题 includes 传入字符串，传完整标题最稳

输出 `$PROJECT_DIR/comments-output/unreplied-comments.json`：

```json
{
  "selectedWork": { "title": "作品标题" },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "imagePaths": ["/abs/path/comment-images/用户A_0_ab12cd34.jpeg"],
      "replyMessage": ""
    }
  ]
}
```

`imagePaths` 仅在评论带图时出现。`replyMessage` 初始为空字符串。

## 工作流 3：逐条模型决策回复（默认）

当前会话同时有 `exec` 与 `process` 工具时，启动非 PTY 后台进程：

```bash
cd "$PROJECT_DIR" && npm run --silent comments:interactive -- --mode smart --limit 10 "<作品标题>"
```

用 `background: true`、`timeout: 0` 启动并保存 `sessionId`。每收到一个 `comment_found` JSONL 事件，只思考当前 `comment`；查看可选 `imagePaths`，把 `history` 仅作背景。再用 `process write` 写回一行：

```json
{ "requestId": "原样返回", "action": "reply", "replyMessage": "不超过400字", "reason": "简短依据" }
```

也可写 `skip` 或 `stop`。必须等待当前 `result` 后再处理下一条；`sent_unconfirmed` 不得重试。用 `--preview` 只生成候选回复、不发送。没有 `process` 工具时不要启动此命令，改用批量流程。

定时巡检必须使用本逐条流程。多个作品使用一次 `comments:interactive --works-file <works.json> --max-works 10 --out-dir <目录> --decision-dir <目录>`，让同一个后台进程自动串行处理；`comment_found` 含 `decisionPath` 时用 `write` 工具把当前决定 JSON 写到该路径，`work_complete` 后继续轮询同一 `sessionId`，最终 `complete` 才结束。不要为每个作品分别调用 `exec`，也不要使用“逐个导出，再批量回复”的旧流程。

## 工作流 4：批量回复

流程：导出 JSON → 在每条 `replyMessage` 填文案 → 把 JSON 路径传给 `comments:reply`。

```bash
cd "$PROJECT_DIR" && npm run comments:reply -- /abs/path/to/comments.json
```

**硬约束**（违反会失败或丢数据）：

1. 只改 `replyMessage`，`username` / `commentText` / `imagePaths` / `selectedWork` 原样保留，内部靠它们匹配评论
2. `replyMessage` 按 Unicode 字符最多 400（中文、英文、标点、emoji 都按 1 算）
3. `replyMessage` 为 `""` 的条目会被跳过
4. 回复文本里的引号用中文 `""`，别用未转义的英文 `"`
5. 不要加 `status` / `appliedReplyMessage` 字段，那是结果字段，执行时会被覆盖

## 浏览器并发约束

- 复用 `.playwright/douyin-profile`，不要清空或替换登录态目录。
- 不删除 `.openclaw-browser.lock` 或 Chrome 的 `SingletonLock` / `SingletonSocket` / `SingletonCookie`；程序只会自动清理可确认失效的残留锁。
- 多作品、导出和回复都必须串行，不能预启动下一个浏览器命令。
