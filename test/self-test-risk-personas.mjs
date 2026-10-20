#!/usr/bin/env node
/**
 * self-test-risk-personas.mjs — 风险人设库的离线自测（不联网、不花钱、不碰项目配置）
 *
 * 覆盖作者提的六条规则：
 *   ① 人设库 → 风险人设库，分「有话术 / 未生成」两块；
 *   ② 选择谁负责 + 各自占比；
 *   ③ 按占比抽（同一条评论稳定，分布接近占比）；
 *   ④ 删人设 → 风险库对应删除 + 剩余占比自动补齐；
 *   ⑤ 删话术 → 人设回到「未生成」+ 剩余占比自动补齐；
 *   ⑥ 全部取消负责 → 拒绝保存（不能出现"没人回"）。
 *
 * 运行：node test/self-test-risk-personas.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeRiskPersonas,
  distributePercent,
  joinRiskPool,
  pickRiskPersona,
  purgePersonaFromRisk,
  revokeRiskReplies,
  saveRiskRouting,
} from "../scripts/risk-personas.mjs";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risk-personas-test-"));
fs.mkdirSync(path.join(dir, "config"), { recursive: true });

const persona = (id, name, self) => ({
  id,
  name,
  tagline: "",
  persona: {
    version: "1.0",
    enabled: true,
    identity: "测试账号",
    self_call: self,
    tone: "口语",
    traits: [],
    catchphrases: [],
    banned_words: [],
    extra_rules: [],
    signature: "",
    signature_scope: "llm",
    examples: [],
  },
});

const role = (id, name, personaId, weight, active = true) => ({
  id,
  name,
  personaId,
  weight,
  active,
  note: "selftest",
  personaFingerprint: "",
  pools: {
    dodge: [`${name}说没卖过东西`],
    tease: [`${name}说不能讲`],
    retort: [`${name}说听到了`],
    unclear: [`${name}说没听懂`],
  },
});

fs.writeFileSync(
  path.join(dir, "config", "personas.json"),
  JSON.stringify(
    { version: "2.0", updated: "", items: [persona("p1", "喵娘", "本喵"), persona("p2", "御姐", "姐姐"), persona("p3", "皇帝", "朕")] },
    null,
    2,
  ),
);

console.log("【一】空风险库：所有人停在「未生成」");
{
  const v = describeRiskPersonas(dir);
  ok("ready 为 0", v.ready.length === 0);
  ok("pending 覆盖 3 套人设", v.pending.length === 3);
  ok("抽选返回 null（调用方回退）", pickRiskPersona(dir, "u|c") === null);
  ok("给出「库是空的」警告", v.warnings.some((w) => w.text.includes("还是空的")));
}

console.log("\n【二】有话术 / 未生成 分板");
fs.writeFileSync(
  path.join(dir, "config", "risk-replies.json"),
  JSON.stringify({ version: 1, updated: "", roles: [role("r1", "喵娘", "p1", 60), role("r2", "御姐", "p2", 40)] }, null, 2),
);
{
  const v = describeRiskPersonas(dir);
  ok("ready = 2", v.ready.length === 2);
  ok("pending = 1（皇帝没有话术）", v.pending.length === 1 && v.pending[0].personaName === "皇帝");
  ok("占比 60/40", v.ready.map((r) => r.percent).join("/") === "60/40", v.ready.map((r) => `${r.personaName} ${r.percent}%`).join("，"));
  ok("在岗池 2 套", v.pool.length === 2);
}

console.log("\n【三】占比换算（最大余数法，合计正好 100）");
{
  const eq = distributePercent([{ weight: 1 }, { weight: 1 }, { weight: 1 }]);
  ok("三套均分合计 100", eq.reduce((a, b) => a + b, 0) === 100, eq.join("/"));
  const zero = distributePercent([{ weight: 0 }, { weight: 0 }]);
  ok("旧配置权重全 0 → 均分", zero.join("/") === "50/50", zero.join("/"));
  const real = distributePercent([{ weight: 50 }, { weight: 30 }, { weight: 10 }, { weight: 10 }]);
  ok("50/30/10/10 原样保留", real.join("/") === "50/30/10/10");
}

console.log("\n【四】按占比抽：稳定 + 分布接近");
{
  const counts = {};
  for (let i = 0; i < 3000; i += 1) {
    const hit = pickRiskPersona(dir, `user${i}|评论${i}`);
    counts[hit.personaName] = (counts[hit.personaName] ?? 0) + 1;
  }
  const catPct = Math.round((counts["喵娘"] / 3000) * 100);
  ok("同一条评论永远同一套", pickRiskPersona(dir, "same|seed").personaName === pickRiskPersona(dir, "same|seed").personaName);
  ok("喵娘占比落在 55–65%", catPct >= 55 && catPct <= 65, `实测 ${catPct}%`);
  ok("御姐占比落在 35–45%", Math.round((counts["御姐"] / 3000) * 100) >= 35 && Math.round((counts["御姐"] / 3000) * 100) <= 45);
}

console.log("\n【五】保存谁负责 + 占比");
{
  const saved = saveRiskRouting(dir, {
    items: [
      { personaId: "p1", active: true, weight: 70 },
      { personaId: "p2", active: true, weight: 30 },
    ],
  });
  ok("保存成功", saved.ok, saved.error || "");
  ok("读回 70/30", saved.view.ready.map((r) => r.percent).join("/") === "70/30");
  const off = saveRiskRouting(dir, {
    items: [
      { personaId: "p1", active: false, weight: 70 },
      { personaId: "p2", active: true, weight: 30 },
    ],
  });
  ok("取消勾选后剩余人设补到 100%", off.ok && off.view.ready.find((r) => r.personaId === "p2").percent === 100);
  ok("被取消的那套仍在「有话术」板里（只是不参与）", off.view.ready.some((r) => r.personaId === "p1" && !r.active));
  const none = saveRiskRouting(dir, {
    items: [
      { personaId: "p1", active: false },
      { personaId: "p2", active: false },
    ],
  });
  ok("全部取消 → 拒绝保存", !none.ok && none.error.includes("至少要勾一套"), none.error);
}

console.log("\n【六】删话术 → 回「未生成」，剩余占比补齐");
{
  saveRiskRouting(dir, { items: [{ personaId: "p1", active: true, weight: 80 }, { personaId: "p2", active: true, weight: 20 }] });
  const r = revokeRiskReplies(dir, "p2");
  ok("删除成功", r.ok);
  ok("被删的回到「未生成」", r.view.pending.some((p) => p.personaId === "p2"));
  ok("剩余一套补到 100%", r.view.ready.length === 1 && r.view.ready[0].percent === 100);
  ok("标记为已重新分配", r.rebalanced === true);
}

console.log("\n【七】删人设 → 风险库级联 + 再分配");
{
  // 还原成两人在岗，再删掉其中一套人设
  fs.writeFileSync(
    path.join(dir, "config", "risk-replies.json"),
    JSON.stringify({ version: 1, updated: "", roles: [role("r1", "喵娘", "p1", 70), role("r2", "御姐", "p2", 30)] }, null, 2),
  );
  const r = purgePersonaFromRisk(dir, "p2");
  ok("级联删除成功", r.ok);
  ok("喵娘自动补到 100%", r.view.ready.length === 1 && r.view.ready[0].percent === 100);
  ok("没有留下孤儿角色", r.view.legacy.length === 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "config", "risk-replies.json"), "utf8"));
  ok("文件里也确实只剩一条", raw.roles.length === 1);
}

console.log("\n【八】新生成的话术并入在岗池（不会永远 0%）");
{
  fs.writeFileSync(
    path.join(dir, "config", "risk-replies.json"),
    JSON.stringify(
      { version: 1, updated: "", roles: [role("r1", "喵娘", "p1", 100), role("r3", "皇帝", "p3", 0, false)] },
      null,
      2,
    ),
  );
  const joined = joinRiskPool(dir, "p3");
  ok("并入后拿到非 0 占比", joined && joined.percent > 0, `${joined?.percent}%`);
  const v = describeRiskPersonas(dir);
  ok("两人合计 100%", v.totals.percentSum === 100, v.ready.map((r) => `${r.personaName} ${r.percent}%`).join("，"));
  ok("新来的那套已经勾选负责", v.ready.find((r) => r.personaId === "p3").active === true);
}

console.log("\n【九】孤儿角色不参与抽选，但要提示出来");
{
  fs.writeFileSync(
    path.join(dir, "config", "risk-replies.json"),
    JSON.stringify(
      {
        version: 1,
        updated: "",
        roles: [role("r1", "喵娘", "p1", 100), { ...role("ghost", "旧角色", "", 50), personaId: "已删除的人设" }],
      },
      null,
      2,
    ),
  );
  const v = describeRiskPersonas(dir);
  ok("孤儿进 legacy 列表", v.legacy.length === 1 && v.legacy[0].roleName === "旧角色");
  ok("抽选只用活着的", v.pool.every((p) => p.personaId === "p1"));
  ok("给出未绑定提示", v.warnings.some((w) => w.text.includes("没绑定")));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n================ 结果 ================\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
