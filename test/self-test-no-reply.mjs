#!/usr/bin/env node
/**
 * self-test-no-reply.mjs — 「自定义不回复规则」的离线自测（不联网、不花钱、不碰项目配置）
 *
 * 覆盖：
 *   ① 关键词匹配（含去空格/标点、英文大小写）
 *   ② 正则匹配、停用规则不参与
 *   ③ 保存校验：太短/太宽泛/无关键词一律拒绝；合法规则可落盘再读回
 *   ④ AI 输出的脏词、泛词、坏正则被过滤
 *
 * 运行：node test/self-test-no-reply.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeNoReplyRules,
  loadNoReplyRules,
  matchNoReplyRule,
  normalizeRule,
  normalizeRules,
  saveNoReplyRules,
} from "../scripts/no-reply-rules.mjs";
import { generateNoReplyRule, parseGeneratedRule } from "../scripts/no-reply-rules-ai.mjs";

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `：${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? `：${detail}` : ""}`);
  }
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-test-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "reply-rules.json"),
    JSON.stringify({ policy: {}, reply_length: { max_chars: 40, min_chars: 4 }, frequency: {} }, null, 2),
    "utf8",
  );
  return dir;
}

console.log("\n=== 一、关键词匹配 ===");
const rules = [
  { id: "a", name: "问价格", desc: "", keywords: ["多少钱", "什么价", "咋卖"], regex: "", enabled: true },
  { id: "b", name: "同行踩", desc: "", keywords: ["别家更好", "智商税"], regex: "", enabled: true },
];
ok("直接命中", matchNoReplyRule("这个多少钱", rules)?.rule.id === "a");
ok("去掉空格也能命中", matchNoReplyRule("多 少 钱 呀", rules)?.rule.id === "a");
ok("带标点也能命中", matchNoReplyRule("多少钱？", rules)?.rule.id === "a");
ok("未命中的放行", matchNoReplyRule("拍得真好", rules) === null);
ok("空评论不命中", matchNoReplyRule("   ", rules) === null);

const english = [{ id: "c", name: "英文", keywords: ["api key"], regex: "", enabled: true }];
ok("英文大小写不敏感", matchNoReplyRule("把你的 API KEY 发我", english)?.rule.id === "c");
ok("英文去空格", matchNoReplyRule("apikey怎么申请", english)?.rule.id === "c");

console.log("\n=== 二、正则与停用 ===");
const regexRule = [{ id: "r", name: "集数", keywords: [], regex: "第[0-9]+集", enabled: true }];
ok("正则命中", matchNoReplyRule("第12集在哪看", regexRule)?.rule.id === "r");
ok("正则不命中", matchNoReplyRule("第一集在哪看", regexRule) === null);
ok("停用的规则不参与", matchNoReplyRule("第12集在哪看", [{ ...regexRule[0], enabled: false }]) === null);
ok("关键词优先返回第一条命中规则", matchNoReplyRule("多少钱，别家更好", rules)?.rule.id === "a", "按列表顺序");

console.log("\n=== 三、保存校验 ===");
ok("空关键词被拒", normalizeRule({ name: "空" }).ok === false);
ok("关键词太短被拒", normalizeRule({ name: "短", keywords: ["钱"] }).ok === false);
ok("关键词太宽泛被拒", normalizeRule({ name: "泛", keywords: ["什么"] }).ok === false);
ok("坏正则被拒", normalizeRule({ name: "坏", regex: "第(集" }).ok === false);
ok("合法规则通过", normalizeRule({ name: "问价", keywords: ["多少钱", "咋卖"] }).ok === true);
const dedup = normalizeRule({ name: "去重", keywords: ["多少钱", "多少钱", "什么价"] });
ok("重复关键词自动去重", dedup.ok && dedup.rule.keywords.length === 2, dedup.ok ? dedup.rule.keywords.join("/") : "");
ok("规则名重复被整表拒绝", normalizeRules([{ name: "同名", keywords: ["多少钱"] }, { name: "同名", keywords: ["咋卖"] }]).ok === false);

console.log("\n=== 四、落盘与读回 ===");
const dir = tempProject();
const saved = saveNoReplyRules(dir, [
  { name: "问价格", desc: "问报价、优惠", keywords: ["多少钱", "咋卖"], source: "ai" },
  { name: "要链接", keywords: ["链接", "小黄车"] },
]);
ok("保存成功", saved.ok === true, saved.ok ? `${saved.items.length} 条` : saved.errors.join("；"));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config", "reply-rules.json"), "utf8"));
ok("写进了 reply-rules.json", Array.isArray(cfg.no_reply_rules?.items), `items=${cfg.no_reply_rules?.items?.length}`);
ok("保留了原有字段", cfg.reply_length?.max_chars === 40);
const loaded = loadNoReplyRules(cfg);
ok("读回两条", loaded.items.length === 2);
ok("读回后可匹配", matchNoReplyRule("多少钱", loaded.items)?.rule.name === "问价格");
const shown = describeNoReplyRules(cfg);
ok("页面视图字段齐全", shown.count === 2 && shown.limits.maxRules > 0 && shown.items[0].keywordCount === 2);
ok("删除一条后只剩一条", saveNoReplyRules(dir, [saved.items[0]]).ok && loadNoReplyRules(JSON.parse(fs.readFileSync(path.join(dir, "config", "reply-rules.json"), "utf8"))).items.length === 1);
fs.rmSync(dir, { recursive: true, force: true });

console.log("\n=== 五、AI 输出清洗 ===");
const parsed = parseGeneratedRule(JSON.stringify({
  name: "问价格",
  desc: "问报价、优惠力度",
  keywords: ["多少钱", "你", "什么", "咋卖", "怎么卖", "x", "多少钱"],
  regex: "",
}));
ok("泛词被过滤", !parsed.keywords.includes("你") && !parsed.keywords.includes("什么"), parsed.keywords.join("/"));
ok("过短词被过滤", !parsed.keywords.includes("x"));
ok("重复词被去重", parsed.keywords.filter((k) => k === "多少钱").length === 1);
ok("保留有效词", parsed.keywords.includes("多少钱") && parsed.keywords.includes("咋卖"));
ok("丢弃原因有记录", parsed.dropped.length >= 3, parsed.dropped.map((d) => d.word).join("/"));
const fenced = parseGeneratedRule('```json\n{"name":"要链接","desc":"","keywords":["链接","小黄车"],"regex":""}\n```');
ok("兼容 ```json 包裹", fenced.name === "要链接" && fenced.keywords.length === 2);
const badRegex = parseGeneratedRule(JSON.stringify({ name: "坏正则", keywords: ["多少钱"], regex: "第(集" }));
ok("坏正则被丢弃但保留关键词", badRegex.regex === "" && badRegex.keywords.length === 1);

console.log("\n=== 六、AI 生成流程（注入假模型，不联网不花钱） ===");
let usedMessages = null;
const aiOut = await generateNoReplyRule({
  projectDir: ".",
  prompt: "问价格和优惠的不回",
  existing: ["要链接"],
  chat: async (messages) => {
    usedMessages = messages;
    return JSON.stringify({ name: "问价格", desc: "问报价、优惠力度", keywords: ["多少钱", "你", "咋卖"], regex: "" });
  },
});
ok("生成结果可用", aiOut.name === "问价格" && aiOut.keywords.length === 2, aiOut.keywords.join("/"));
ok("提示词带上了作者原话", String(usedMessages?.[1]?.content).includes("问价格和优惠的不回"));
ok("提示词带上了已有规则", String(usedMessages?.[1]?.content).includes("要链接"));
ok("系统提示词禁止泛词", String(usedMessages?.[0]?.content).includes("不能出现"));
let rejected = false;
try {
  await generateNoReplyRule({ projectDir: ".", prompt: "", chat: async () => "{}" });
} catch { rejected = true; }
ok("空描述被拒", rejected === true);

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
