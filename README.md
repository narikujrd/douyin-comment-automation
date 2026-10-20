# 抖音评论自动回复控制台

在自己电脑上跑的抖音评论自动回复工具：读取创作者中心未回复的评论 → 本地规则 + 大模型三档判定 → 按人设生成回复 → 在同一个浏览器会话里发出去。

不联网中转、不上传账号、不托管任何数据。判定与文案全部在本机完成。

> Windows 桌面工具。需要 Node.js ≥ 20。用真实浏览器驱动，不是接口挂机。

---

## ⚠️ 先读这一段

- 本工具通过浏览器自动化操作抖音创作者中心，**属于平台未授权的手段**。可能触发验证码、限流、降权，**严重时账号被封**。
- 生成的评论会**以你的账号名义公开发布**。模型可能说出不恰当的话，**发之前请自己看一遍**。
- 涉及他人个人信息、消费纠纷、商业承诺、政治宗教等敏感话题时，**相应风险与法律责任由你本人承担**。
- 本项目按「现状」提供，**不附带任何明示或默示担保**。作者不对使用本工具造成的账号处罚、流量损失、数据丢失、经济损失、名誉损害、法律纠纷或任何其他直接、间接后果承担责任。
- 是否使用、用哪个账号用，**全部由你自行判断并自行承担后果**。不同意以上任何一条，请立即停止使用并删除本项目。

**继续使用即视为你已阅读、理解并接受上述全部条款。**

---

## 一、让 AI 帮你装好（推荐）

把下面整段复制，发给你在用的 AI 编程助手（WorkBuddy / Claude Code / Codex / Cursor 等），它会自己下载、装依赖、告诉你下一步：

```text
帮我把这个项目装到本地，然后告诉我怎么启动：
https://github.com/narikujrd/douyin-comment-automation

1. git clone 不通就改用压缩包：
   https://codeload.github.com/narikujrd/douyin-comment-automation/tar.gz/refs/heads/main
2. 进目录后执行：cd tool && npm install && npx playwright install chromium
3. 装完读 README-首次使用.md，告诉我双击哪个文件启动
4. 需要 Node.js ≥ 20，不够先跟我说

别替我填 API Key，别改配置，别把登录态或密钥外传。
```

---

## 二、或者手动三步

```bash
git clone https://github.com/narikujrd/douyin-comment-automation.git
cd douyin-comment-automation
cd tool && npm install && npx playwright install chromium
```

然后回项目根目录，双击 **`▶ 抖音回复控制台启动器.bat`**。

第一次用还需要两步：双击 `1-验证密钥.bat` 填 API Key → 双击 `2-扫码登录.bat` 扫码。没 Key 也能打开控制台，只是生成不了回复。

---

## 三、完整文档

- **[README-首次使用.md](https://github.com/narikujrd/douyin-comment-automation/blob/main/README-%E9%A6%96%E6%AC%A1%E4%BD%BF%E7%94%A8.md)** —— 安装、每一节管什么、三种结局、排障表、密钥与安全
- `ui/guide.html` —— 控制台内置版使用指南（启动后在设置里能看到入口）

## 四、仓库里有什么、没有什么

| 自带 | 不带 |
|---|---|
| 全部判定与生成逻辑、控制台页面、离线自测 | API Key（存本机 `~/.douyin-automation/`，不进仓库） |
| `tool/` 抓取层（Playwright 驱动真实浏览器） | 登录态与评论数据（`.gitignore` 挡住） |
| 1 套示例人设「小猫」+ 12 类风险档位处置 + 通用打岔模板 | 政治类敏感词表（放在你本地的 `config/risk-policy.local.json`） |

## 五、许可证

MIT。可自由使用、修改、商用、闭源分发，保留版权声明即可，详见 [LICENSE](https://github.com/narikujrd/douyin-comment-automation/blob/main/LICENSE)。

项目按「现状」提供，使用风险自负。作者：[narikujrd](https://github.com/narikujrd)
