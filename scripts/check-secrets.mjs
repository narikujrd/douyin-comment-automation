#!/usr/bin/env node
/**
 * check-secrets.mjs — 密钥泄漏自检（每次改动后、每轮批处理前跑一次）
 *
 * 检查 5 件事：
 *   1. 密钥是否出现在**任何**项目文件里（含报告、日志、状态、导出文件）。
 *   2. 是否出现任何 `sk-` 形式的残留（可能是别人的 key，也可能是我方未脱敏）。
 *   3. `.gitignore` 是否确实覆盖了密钥文件。
 *   4. 第三方工具子进程的环境剥离是否已配置（防投毒依赖读环境变量）。
 *   5. 密钥来源与推荐来源是否一致（推荐放到项目树外 / 环境变量）。
 *
 * 退出码非 0 = 发现泄漏，可挂到批处理前置检查。
 * 用法：node scripts/check-secrets.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_SECRETS_FILE, maskKey, readSecrets } from "./llm-deepseek.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".playwright", "tmp-logs"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".exe", ".dll", ".node", ".pdf", ".mp4", ".woff", ".woff2", ".ico", ".db", ".sqlite", ".so", ".dylib"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const secrets = readSecrets(PROJECT_DIR);
const findings = [];
const allowlisted = [];
const scanned = { files: 0, bytes: 0, skipped: 0 };

/** 白名单（仅对"sk- 假串"生效）：必须同时在白名单 + 文件内含标记，缺一不放行 */
const scanAllow = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "secret-scan-allow.json"), "utf8"));
  } catch {
    return { required_marker: "@secret-scan-allow", files: {} };
  }
})();
const marker = scanAllow.required_marker ?? "@secret-scan-allow";

function walk(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth > 8) continue;
      walk(full, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) {
      scanned.skipped += 1;
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      scanned.skipped += 1;
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      scanned.skipped += 1;
      continue;
    }
    scanned.files += 1;
    scanned.bytes += stat.size;

    const rel = path.relative(PROJECT_DIR, full);

    // 密钥文件自身不算泄漏（它就是用来存 key 的）
    const isSecretStore = full === secrets.internalFile || full === secrets.externalFile;
    const isExample = entry.name.includes("example");

    // 真实密钥的检查：白名单不豁免（测试靶子也绝不能含真 key）
    if (secrets.apiKey && content.includes(secrets.apiKey) && !isSecretStore) {
      findings.push({ level: "CRITICAL", file: rel, what: "包含完整密钥" });
      continue;
    }
    if (secrets.apiKey && secrets.apiKey.length >= 10 && content.includes(secrets.apiKey.slice(0, 12)) && !isSecretStore) {
      findings.push({ level: "HIGH", file: rel, what: "包含密钥前缀（疑似脱敏不全）" });
    }

    // sk- 假串检查：白名单 + 标记 双条件才豁免
    if (/sk-[A-Za-z0-9_\-]{16,}/.test(content) && !isSecretStore) {
      if (isExample && /sk-填|sk-xxx|YOUR_|sk-\*\*\*/i.test(content)) continue;
      const normalized = rel.split(path.sep).join("/");
      const allowed = Object.prototype.hasOwnProperty.call(scanAllow.files ?? {}, normalized) && content.includes(marker);
      if (allowed) {
        allowlisted.push({ file: normalized, why: scanAllow.files[normalized] });
      } else {
        findings.push({ level: "HIGH", file: rel, what: "含 sk- 形式的疑似密钥残留" });
      }
    }
  }
}

console.log("── 密钥泄漏自检 ──");
console.log(`密钥来源：${secrets.keySource}`);
console.log(`密钥指纹：${maskKey(secrets.apiKey)}`);
console.log(`推荐落盘位置（项目树外）：${EXTERNAL_SECRETS_FILE}`);
console.log("");

walk(PROJECT_DIR);

console.log(`已扫描 ${scanned.files} 个文本文件（${(scanned.bytes / 1024 / 1024).toFixed(2)} MB），跳过 ${scanned.skipped} 个（二进制/超大）`);

/* ---- 2. .gitignore 覆盖检查 ---- */
const gitignorePath = path.join(PROJECT_DIR, ".gitignore");
let ignoreOk = false;
let ignoreContent = "";
try {
  ignoreContent = fs.readFileSync(gitignorePath, "utf8");
  const lines = ignoreContent.split("\n").map((l) => l.trim());
  ignoreOk = lines.includes("config/secrets.local.json") || lines.some((l) => l === "config/" || l === "secrets.local.json");
} catch {
  ignoreOk = false;
}
if (!ignoreOk) {
  findings.push({ level: "CRITICAL", file: ".gitignore", what: "未覆盖 config/secrets.local.json —— 一旦入库，密钥即刻泄漏" });
}

/* ---- 3. 子进程环境剥离检查 ---- */
let stripOk = false;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"));
  const list = cfg.security?.secrets?.strip_from_child_env;
  stripOk = Array.isArray(list) && list.includes("DEEPSEEK_API_KEY");
} catch {
  stripOk = false;
}
if (!stripOk) {
  findings.push({
    level: "HIGH",
    file: "config/reply-rules.json",
    what: "security.secrets.strip_from_child_env 未含 DEEPSEEK_API_KEY —— 第三方工具的依赖可直接读走环境变量里的密钥",
  });
}

/* ---- 4. 来源建议 ---- */
const sourceAdvice = [];
if (secrets.keySource === "none") {
  sourceAdvice.push("尚未配置密钥（--gen auto 会回落模板模式）");
} else if (secrets.keySource.startsWith("file:") && secrets.keySource.includes("config/secrets.local.json")) {
  sourceAdvice.push("当前密钥存在**项目目录内**。第三方工具的 npm 依赖理论上可遍历到它 → 建议改用环境变量，或把文件移到 " + EXTERNAL_SECRETS_FILE);
}

/* ---- 汇总 ---- */
console.log("");
if (findings.length === 0) {
  console.log("✅ 未发现密钥泄漏");
} else {
  console.log(`❌ 发现 ${findings.length} 项问题：`);
  for (const f of findings) console.log(`   [${f.level}] ${f.file} — ${f.what}`);
}
if (sourceAdvice.length) {
  console.log("");
  for (const a of sourceAdvice) console.log(`ℹ️  ${a}`);
}

const critical = findings.filter((f) => f.level === "CRITICAL" || f.level === "HIGH");
if (allowlisted.length) {
  console.log(`\nℹ️  白名单豁免 ${allowlisted.length} 个测试靶子文件（含标记 ${marker}，非真实密钥）：`);
  for (const a of allowlisted) console.log(`   · ${a.file} — ${a.why}`);
}
process.exit(critical.length > 0 ? 1 : 0);
