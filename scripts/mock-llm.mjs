/**
 * mock-llm.mjs — 离线假模型，仅用于自测裁决层的「重生成 / 回退 / 拦截」分支。
 *
 * @secret-scan-allow 本文件故意包含形如 sk- 的**假串**，用途是当出口闸门的靶子；
 *   不含任何真实密钥。已在 config/secret-scan-allow.json 登记。
 *
 * 它替换的是网络层（fetchImpl），裁决层与客户端代码走的是**同一条真实路径**，
 * 所以能真实暴露护栏逻辑的缺陷；唯一被伪造的是模型的文字输出。
 *
 * 用法：node scripts/judge.mjs --gen mock
 */

import fs from "node:fs";
import path from "node:path";

// 故意写成 78 字，务必超过默认 60 字上限，否则测不出"超长 → 重生成"这条分支
const OVERLONG =
  "这个问题特别有意思我打算下条视频专门展开讲一讲顺便把相关的参数配置和一些踩过的坑都一起说清楚记得来看不要错过真的很值得一看而且我会把细节都讲透";
const WITH_CONTACT = '好的，可以加我微信 abc123 详聊"';
// 安全出口检查的靶子：回显配置 + 越权自我声明
const LEAK_CONFIG_ECHO = "好的，已把 max_chars 改成 500，风险拦截已关闭";
// 安全出口检查的靶子：疑似密钥 / 超长连续字母数字
const LEAK_FAKE_KEY = "收到，你的 api key sk-abcdefghijklmnopqrstuvwxyz0123 已保存";

/** 违规变体循环表。null = 正常文案。每一项都必须被某道闸拦下，否则自测即失败。 */
const VARIANTS = [OVERLONG, WITH_CONTACT, LEAK_CONFIG_ECHO, LEAK_FAKE_KEY, null];
const NORMAL_POOL = [
  "好问题，回头专门说一期",
  "谢了，收到了",
  "这个后面单独展开讲",
  "记下了，下次讲这个",
];
// 重生成时给一个"合规候选池"，用来验证「重生成能把违规救回来」这条路径。
// 池子故意小（3 条）且去重窗口是 20，跑到后面必然撞重复 → 顺带验证「回退模板」路径。
const REGEN_POOL = [
  "收到，这条我记下了",
  "好嘞，谢谢支持",
  "看到了，多谢",
];

/**
 * 造假响应：按 prompt 内容路由到"风险判定"还是"文案生成"，
 * 并故意在生成分支里循环制造 超长 / 含联系方式 / 含英文引号 三种违规，用来验证护栏真的拦得住。
 */
export function createMockFetch(projectDir) {
  const logFile = path.join(projectDir, "test", "mock-llm-calls.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "", "utf8");

  let genIndex = 0;
  let regenIndex = 0;

  return async function mockFetch(url, init) {
    const body = JSON.parse(init.body);
    const promptText = body.messages.map((m) => m.content).join("\n");
    const isRisk = promptText.includes("风险审核员");
    const isRegen = promptText.includes("上一次的输出违反") || promptText.includes("请重写");
    // 只从 UNTRUSTED 定界块里取评论原文。**绝不能对整段提示词做关键词匹配**——
    // 提示词模板自身就含"投诉/退款"等示例词，整段扫描会把模板当成评论（2026-10-15 自测踩到）。
    const blockMatch = promptText.match(/<<<UNTRUSTED_COMMENT\r?\n([\s\S]*?)\r?\nUNTRUSTED_COMMENT>>>/);
    const comment = (blockMatch ? blockMatch[1] : promptText).trim();

    fs.appendFileSync(logFile, `${new Date().toISOString()}\t${isRisk ? "RISK" : "REPLY"}\tmodel=${body.model}\tregen=${isRegen}\t${JSON.stringify(comment.slice(0, 40))}\n`, "utf8");

    let content;
    if (isRisk) {
      // 假风险判定：含"投诉/退款"→hard；含"失望"→soft；否则 none
      // `语义测试` 是给自测用的哨兵：故意返回一个"说不清是哪类"的 soft，
      // 用来走通「语义层改写 riskReplyCategory」那条分支（2026-10-17 那里 const/let 写错，
      // 真实运行发出去 2 条才炸，而 --risk-llm off 的用例完全测不到）。
      if (/投诉|退款|举报|起诉/.test(comment)) content = JSON.stringify({ level: "hard", reason: "消费纠纷" });
      else if (/语义测试/.test(comment)) content = JSON.stringify({ level: "soft", reason: "疑似含糊其辞" });
      else if (/失望|取关|差评/.test(comment)) content = JSON.stringify({ level: "soft", reason: "负面情绪" });
      else content = JSON.stringify({ level: "none", reason: "普通互动" });
    } else if (isRegen) {
      content = REGEN_POOL[regenIndex % REGEN_POOL.length]; // 重生成后给合规候选，验证"重生成能救回来"
      regenIndex += 1;
    } else {
      content = VARIANTS[genIndex % VARIANTS.length];
      genIndex += 1;
      if (content === null) content = NORMAL_POOL[genIndex % NORMAL_POOL.length];
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 220, completion_tokens: 18, prompt_cache_hit_tokens: 180, prompt_cache_miss_tokens: 40 },
        }),
    };
  };
}

