# Changelog

## 2026-04-20

### OpenClaw Skill

- 新增 AgentSkills 规范 skill `skills/douyin-creator/SKILL.md`（单文件、纯面向 AI），专供 OpenClaw 调用，覆盖获取作品列表、导出未回复评论、批量回复评论
- 固定仓库 clone 位置为 `~/.openclaw/douyin-creator-tools`，skill 加载由 OpenClaw 自动处理（如 `extraDirs`），无需 symlink / 环境变量 / 手工配置
- SKILL.md 中 `$PROJECT_DIR` 硬编码为 `~/.openclaw/douyin-creator-tools`

### 文档

- `README.md` 重写为面向 OpenClaw Agent 的指令文档，覆盖仓库位置、首次初始化（node / 依赖 / chromium / 扫码登录）、能力概览、硬约束；只包含 `auth` / `works` / `comments:export` / `comments:reply` 四个命令，文章/图文发布等其他脚本仍在 `src/` 但文档不再提及

## 2026-04-16

### 评论导出

- 导出评论时自动下载评论中的图片到 `comment-images/` 目录，JSON 中通过 `imagePaths` 字段存储图片的绝对路径；无图片的评论不受影响

### 回复评论

- 回复正文按 Unicode 字符计最长 400，超出自动截断；结果中写入 `appliedReplyMessage`、`replyMessageTruncated`
- 默认打字间隔由 100ms 调整为 50ms/字符，减轻长回复在单次操作超时内未完成输入的情况

## 2026-04-13

### JSON 解析

- 发布文章、发布图文、回复评论读取 JSON 时，自动将 title / subtitle / content / description / replyMessage 字段值内的英文双引号替换为中文引号（`""`），避免因未转义引号导致解析失败

## 2026-04-09

### 发布图文

- 新增 `npm run imagetext:publish`：按 JSON 一次上传多张图片，可填标题、描述与配乐；示例见 `example/publish_imagetext.json`

### 评论导出

- 部分旧作品评论页没有评论类型筛选时，仍可正常导出，不再卡在筛选步骤
- 上述旧页一次最多采集约 10 条评论，并与已有回复记录去重，避免长时间滚动

## 2026-04-08

### 发布文章

- 修复发布时误点「高清发布」的问题，改为只点主「发布」按钮

## 2026-04-04

### 浏览器视口

- 打开浏览器时默认按当前屏幕自适应窗口大小，不再固定为某一分辨率
- `auth`、`view` 支持手动指定窗口大小（宽×高）

### 评论导出

- 导出命令支持跳过用户历史记录，加快执行
- 修复带表情包（如捂脸等）的评论导出不完整的问题

### 发布文章

- 上传封面图时等待更充分，减少因加载未完成导致的失败
- 启动前会校验 JSON 格式、必填项与封面图文件是否存在，错误信息用中文说明

### 回复评论

- 回复 JSON 里常见的中文引号问题会尝试自动修正，并给出提示
- 解析或校验失败时，提示更易读（含出错位置与常见原因）
- 出错时不再刷屏打印技术堆栈，只保留简要说明
