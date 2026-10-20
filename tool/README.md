# douyin-creator-tools

基于 Playwright 的抖音创作者中心自动化工具：**作品列表、评论导出、评论回复、文章与图文发布**。

所有操作都在你自己电脑上的真实浏览器里完成，用的是你扫码登录后的会话，不走任何私有接口。

> ⚠️ 本工具通过浏览器自动化操作抖音创作者中心，属于平台未公开支持的方式，可能触发风控甚至限制账号。请自行评估风险，建议先用小号或低价值作品试跑。作者不对使用后果承担任何责任。

---

## 环境要求

- Node.js **20 或以上**
- 系统里装好 Chrome/Edge（Playwright 也可自行下载 Chromium，见下）

```bash
npm install
npx playwright install chromium   # 若系统已有 Chrome/Edge 可跳过
```

## 首次使用：扫码登录

```bash
npm run auth
```

会弹出一个真实浏览器窗口，用手机抖音扫码。登录态保存在 `.playwright/douyin-profile/`。

**这个目录等于你的账号，别拷给别人、别传网盘、别提交到 git**（已在 `.gitignore` 里）。

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run auth` | 扫码登录，保存会话 |
| `npm run view` | 打开创作者中心页面看看 |
| `npm run works` | 拉作品列表 → `comments-output/list-works.json` |
| `npm run comments:export -- "<作品标题>"` | 导出单个作品的未回复评论 |
| `npm run comments:export-all -- "<作品标题>"` | 导出全部评论（含已回复） |
| `npm run comments:interactive -- --mode smart --limit 10 "<作品标题>"` | 逐条交互决策：每导出一条就输出一行 JSONL，由外部回写决定 |
| `npm run comments:reply -- <comments.json 路径>` | 按 JSON 批量回复 |
| `npm run article:publish -- <json>` | 发布文章 |
| `npm run imagetext:publish -- <json>` | 发布多图图文 |
| `npm run server` | 起一个本地 HTTP 服务（含评论工作台） |
| `npm run wordcloud` | 评论词云 |
| `npm run users` | 用户相关 CLI |

`example/` 下有发布用的 JSON 示例。

### 回复用的 JSON 长什么样

```json
{
  "selectedWork": { "title": "作品标题" },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "imagePaths": [],
      "replyMessage": "你要回复的话"
    }
  ]
}
```

**只改 `replyMessage` 一个字段**，其余原样保留 —— 匹配评论靠它们。`replyMessage` 为空字符串的条目会被跳过；正文按 Unicode 字符最多 400。

---

## 硬约束

1. **同一个登录档案只能串行使用。** 全程最多跑一个抖音命令；上一个进程退出前不要启动下一个。看到 `DOUYIN_BROWSER_BUSY` 就结束本轮，别重试、别杀进程、别删 `.openclaw-browser.lock` 或 Chrome 的 `Singleton*` 文件。
2. **别清空或替换 `.playwright/douyin-profile/`。** 那是在线账号本身。
3. 创作者中心改版后页面选择器会失效，需要跟着改。这是这类工具的常态。

---

## 目录

```
src/            入口脚本（每个 npm run 对应一个）
src/lib/        共享逻辑：浏览器会话、评论流程、回复台账、数据库、作品面板
test/           单元测试（node --test）
example/        发布用 JSON 示例与配图
skills/         给 AI Agent 用的 skills 说明
```

运行产物（`comments-output/`、`comment-images/`、`.playwright/`、`*.db`）都在 `.gitignore` 里，不会入库。

## License

MIT
