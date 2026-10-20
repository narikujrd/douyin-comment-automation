/**
 * gen-risk-roles.mjs — 给「还没有专属风险话术」的人设生成一套，并绑定到该人设
 *
 * 背景（2026-10-18 作者反馈）：
 *   风险类回复（退款/砍价/要密码/注入/辱骂/说不清）走 config/risk-replies.json 的
 *   「角色 → 四个池子」（dodge 装傻 / tease 调戏 / retort 接住 / unclear 没听懂）。
 *   它们原本**按角色权重随机抽**，跟这条评论用的人设没关系 —— 皇帝人设冒出「喵～」。
 *   现在角色可以绑定人设（personaId）：本条评论用哪套人设，就用哪套的话术。
 *   本脚本负责给"还没绑定角色"的人设补齐话术（用的是项目里已有的 AI 生成器，零重复实现）。
 *
 * 用法：
 *   node scripts/gen-risk-roles.mjs                  # 给所有没绑定角色的人设补
 *   node scripts/gen-risk-roles.mjs --id sharp       # 只补某个人设
 *   node scripts/gen-risk-roles.mjs --id sharp --force
 *   node scripts/gen-risk-roles.mjs --dry-run        # 只列出会处理谁
 *
 * 生成的角色 weight = 0：**只在该人设出场时使用**，不参与按权重随机（那是没人设时的兜底）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPersonaLibrary } from "./persona-store.mjs";
import { getBannedWords, personaVoiceFingerprint } from "./persona.mjs";
import { generateRolePools, ROLE_HINT_MAX } from "./risk-replies-ai.mjs";
import { loadRiskReplies } from "./risk-replies.mjs";
import { checkOutputSafe } from "./security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const RISK_FILE = path.join(PROJECT_DIR, "config", "risk-replies.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (["force", "dry-run", "verbose"].includes(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${key} 缺少取值`);
    args[name] = value;
    i += 1;
  }
  return args;
}

/** 把人设压成一句"说话风格说明"喂给生成器（有 120 字上限） */
function personaHint(persona) {
  const parts = [
    persona.identity,
    persona.self_call ? `自称${persona.self_call}` : "",
    persona.tone,
    (persona.traits ?? []).length ? `性格${persona.traits.join("、")}` : "",
    (persona.catchphrases ?? []).length ? `口头禅${persona.catchphrases.join("、")}` : "",
    ...(persona.extra_rules ?? []),
  ].filter(Boolean);
  return parts.join("；").slice(0, ROLE_HINT_MAX);
}

const args = parseArgs(process.argv.slice(2));
const readJson = (abs) => JSON.parse(fs.readFileSync(abs, "utf8"));
const rules = readJson(path.join(PROJECT_DIR, "config", "reply-rules.json"));
/**
 * ★ 2026-10-19：话术文件可以不存在。
 *   仓库可以不带 config/risk-replies.json（话术是可选项），
 *   原实现直接 readFileSync → ENOENT 直接退出，连"给新人设生成话术"都跑不了。
 *   现在缺失就按"空角色表 + 内置分类路由"起步，生成完自然把文件建出来。
 */
let riskRaw;
try {
  riskRaw = readJson(RISK_FILE);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  riskRaw = { version: 1, categoryGroups: loadRiskReplies(PROJECT_DIR).categoryGroups, roles: [] };
  console.log("[角色话术] 没有 config/risk-replies.json，按空角色表起步（首次生成会创建该文件）");
}
const limits = {
  minChars: Number(rules.reply_length?.min_chars ?? 4),
  maxChars: Number(rules.reply_length?.max_chars ?? 40),
  hardKeywords: rules.risk_block_hard?.keywords ?? [],
  outboundKeywords: rules.risk_block_outbound?.keywords ?? [],
};

const lib = loadPersonaLibrary(PROJECT_DIR, { persistMigration: false });
const roles = Array.isArray(riskRaw.roles) ? riskRaw.roles : [];
const boundIds = new Set(roles.map((r) => r.personaId).filter(Boolean));
const roleIds = new Set(roles.map((r) => r.id));

const targets = lib.items.filter((item) => {
  if (args.id) return item.id === args.id;
  if (args.force) return true;
  // 已经有绑定角色、或角色 id 恰好等于人设 id（findRoleForPersona 会按 id 命中）→ 跳过
  return !boundIds.has(item.id) && !roleIds.has(item.id);
});

if (targets.length === 0) {
  console.log("[角色话术] 所有人设都已绑定角色，无需生成（要重写加 --force）。");
  process.exit(0);
}
console.log(`[角色话术] 待生成 ${targets.length} 套人设的话术`);
for (const item of targets) console.log(`  · ${item.name}（${item.id}）`);
if (args["dry-run"]) process.exit(0);

let failed = 0;
for (const item of targets) {
  const banned = [...new Set([...(getBannedWords(item.persona) ?? []), ...(item.persona.banned_words ?? [])])];
  console.log(`\n[角色话术] 生成中：${item.name} …`);
  try {
    const gen = await generateRolePools({
      projectDir: PROJECT_DIR,
      name: item.name,
      hint: personaHint(item.persona),
      limits: { ...limits, hardKeywords: [...limits.hardKeywords, ...banned] },
    });
    /**
     * ★ 再补一道「出口检查」：生成器的校验只管字数/红线/引流，
     *   而生产发出去前还会过 checkOutputSafe（禁「密码」「指令」「密钥」这类回显词）。
     *   不过这道，就会出现"池子里躺着永远发不出去的句子"。
     */
    const cleaned = {};
    let droppedByOutput = 0;
    for (const [key, arr] of Object.entries(gen.pools ?? {})) {
      const kept = arr.filter((line) => {
        const why = checkOutputSafe(line, { apiKey: "" });
        if (why) droppedByOutput += 1;
        return !why;
      });
      if (kept.length) cleaned[key] = kept;
    }
    gen.pools = cleaned;
    const lines = Object.values(cleaned).reduce((n, arr) => n + arr.length, 0);
    if (!lines) {
      console.error("  ✗ 一条合规文案都没拿到，跳过");
      failed += 1;
      continue;
    }
    const fingerprint = personaVoiceFingerprint(item.persona);
    const exist = roles.find((r) => r.personaId === item.id || r.id === item.id);
    if (exist) {
      exist.pools = gen.pools;
      exist.personaId = item.id;
      exist.name = exist.name || item.name;
      // 记下这次是照哪个版本的人设写的 —— 下次保存时比对指纹，没变就不重复花钱
      exist.personaFingerprint = fingerprint;
    } else {
      // weight 0 = 只在该人设出场时用，不参与按权重随机
      roles.push({
        id: item.id,
        name: item.name,
        personaId: item.id,
        weight: 0,
        note: "由人设自动生成（C-34）",
        personaFingerprint: fingerprint,
        pools: gen.pools,
      });
    }
    const droppedTotal = (gen.dropped?.length ?? 0) + droppedByOutput;
    console.log(`  ✓ ${lines} 条${droppedTotal ? `（丢弃 ${droppedTotal} 条不合格）` : ""}`);
    if (args.verbose) for (const [k, v] of Object.entries(gen.pools)) console.log(`    ${k}: ${v.slice(0, 3).join(" / ")}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ 失败：${error.message}`);
  }
}

/**
 * ★ 孤儿角色回收（C-35 实测踩到的竞态）：
 *   删除人设时会顺手删掉它绑定的角色，但如果此刻后台正好在给这套人设生成话术，
 *   生成完成后又会把角色写回去 —— 配置里就留下"绑着已不存在的人设"的孤儿。
 *   所以落盘前统一按当前人设库清一遍：personaId 不在库里、且不是内置角色的，一律丢弃。
 */
const liveIds = new Set(lib.items.map((item) => item.id));
const before = roles.length;
const cleaned = roles.filter((r) => !r.personaId || liveIds.has(r.personaId));
if (cleaned.length !== before) {
  console.log(`[角色话术] 回收 ${before - cleaned.length} 个孤儿角色（绑定的人设已删除）`);
}
riskRaw.roles = cleaned;
roles.length = 0;
roles.push(...cleaned);
riskRaw.updated = new Date().toISOString().slice(0, 16).replace("T", " ");
fs.writeFileSync(RISK_FILE, `${JSON.stringify(riskRaw, null, 2)}\n`, "utf8");
console.log(`\n[角色话术] 已写入 ${path.relative(PROJECT_DIR, RISK_FILE)}（角色 ${roles.length} 个）`);
if (failed > 0) process.exit(1);
