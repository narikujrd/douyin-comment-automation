#!/usr/bin/env node
/**
 * self-test-gen-auto.mjs —— 「`--gen auto` 必须真的走 LLM」的回归测试
 *
 * 背景（2026-10-16 跑真实作品时发现）：
 *   judge.mjs 里 `genMode` 停在字符串 "auto"，而下面
 *     const llmEnabled = Boolean(client) && ["llm", "mock"].includes(genMode);
 *   只认 "llm" / "mock" → **LLM 被静默关掉**。后果三连：
 *     ① 文案全程走模板（"收到，欢迎常来"这类），不是 DeepSeek 生成的；
 *     ② 风险判定从"关键词 + LLM 语义双保险"退回**纯规则**（少了语义那一路）；
 *     ③ 报告里照样写着 `model=deepseek-flash`，还统计出"LLM 直出 N 条"。
 *   症状与 C-04（推理模型空正文）同源：**降级了，但没有任何地方告诉你。**
 *
 * 本测试用**本地假 API 服务器**（真 HTTP，不是假 fetch）跑完整 CLI 链路，锁三件事：
 *   ① `--gen auto` + 有 key → actualMode 必须是 "llm"，且真的发出过请求；
 *   ② `--gen auto` + 无 key → 必须**显式**降级为 template 并在报告里留 note（不得静默）；
 *   ③ 日志/统计不得再用 `replyCount - fallbackCount` 反推"LLM 直出"（会把没走 LLM 的也算上）。
 *
 * 不发任何外部网络请求（只连 127.0.0.1）。
 * 用法：node test/self-test-gen-auto.mjs
 *
 * 本文件含形如 sk- 的假串（写给本地假 API 用的），非真实密钥。@secret-scan-allow
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const JUDGE = path.join(PROJECT_DIR, "scripts", "judge.mjs");
const NODE = process.execPath;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gen-auto-"));
const cleanup = [];
const log = (m) => console.log(m);

/* ---------------- 本地假 DeepSeek API ---------------- */
const seenRequests = [];

function makeFakeApi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* 探针可能发空体 */
        }
        const system = String(parsed?.messages?.[0]?.content ?? "");
        seenRequests.push({ url: req.url, model: parsed?.model ?? null, systemHead: system.slice(0, 24) });

        // 模型探测走 /models 时也回一个列表
        if (String(req.url).includes("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "fake-flash" }] }));
          return;
        }

        const isRisk = system.includes("风险审核员");
        const content = isRisk ? '{"level":"none","reason":"正常"}' : "谢谢关注呀，欢迎常来";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake-1",
            object: "chat.completion",
            model: parsed?.model ?? "fake-flash",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------- 准备素材 ---------------- */
const fixturePath = path.join(tmpRoot, "fixture.json");
fs.writeFileSync(
  fixturePath,
  JSON.stringify(
    { selectedWork: { title: "自测用", publishText: "发布于2026年1月1日 00:00" }, comments: [{ username: "路人甲", commentText: "这个怎么用呀" }] },
    null,
    2,
  ),
  "utf8",
);

// 备份真实模型缓存：本测试探测的是 localhost，会把缓存里的 baseUrl 覆盖掉
const cachePath = path.join(PROJECT_DIR, "state", "model-cache.json");
const cacheBackup = fs.existsSync(cachePath) ? fs.readFileSync(cachePath) : null;
const restoreCache = () => {
  if (cacheBackup) fs.writeFileSync(cachePath, cacheBackup);
  else if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
};
cleanup.push(restoreCache);

function makeHome(withKey, baseUrl) {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  if (withKey) {
    fs.writeFileSync(
      path.join(home, "secrets.json"),
      JSON.stringify({ deepseek_api_key: "sk-selftest-fake-key-not-real", deepseek_base_url: baseUrl }, null, 2),
      "utf8",
    );
  }
  return home;
}

/**
 * 必须用**异步** spawn：假 API 服务器就跑在本进程里，
 * 若用 spawnSync 会阻塞本进程事件循环 → 服务器无法响应 → 子进程请求全部超时。
 * （2026-10-16 实际踩到：三个候选模型全报 "aborted due to timeout"。）
 */
function runJudge({ home, out, report }) {
  return new Promise((resolve) => {
    const env = { ...process.env, DOUYIN_AUTOMATION_HOME: home };
    delete env.DEEPSEEK_API_KEY; // 确保只从文件读，避免本机真实 env 干扰判定
    const child = spawn(
      NODE,
      [JUDGE, "--in", fixturePath, "--out", out, "--report", report, "--gen", "auto", "--risk-llm", "auto", "--state", path.join(tmpRoot, "state.json")],
      { cwd: PROJECT_DIR, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.on("error", (error) => resolve({ status: -1, stdout, stderr: stderr + String(error) }));
  });
}

/* ---------------- 主流程 ---------------- */
const { server, port } = await makeFakeApi();
cleanup.push(() => server.close());
const baseUrl = `http://127.0.0.1:${port}`;

log("");
log("【一】--gen auto + 有 key ⇒ 必须真的走 LLM");
{
  const home = makeHome(true, baseUrl);
  const out = path.join(tmpRoot, "out1.json");
  const reportPath = path.join(tmpRoot, "report1.json");
  const r = await runJudge({ home, out, report: reportPath });
  check("judge 退出码为 0", r.status === 0, `实际 ${r.status}\n---- stdout ----\n${(r.stdout || "").slice(-1200)}\n---- stderr ----\n${(r.stderr || "").slice(-1200)}`);

  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  check("产出裁决报告", report !== null);
  if (report) {
    const g = report.generation ?? {};
    check(`actualMode 是 llm（不是 auto）`, g.actualMode === "llm", `实际 ${g.actualMode}`);
    check(`风险判定走 LLM 语义（不是 rules_only）`, g.riskSemantic === "llm", `实际 ${g.riskSemantic}`);
    check(`确实发生模型调用`, (report.llm?.calls ?? 0) >= 1, `calls=${report.llm?.calls}`);
    check(`假 API 真的被请求到`, seenRequests.length >= 1, `请求数 ${seenRequests.length}`);
    check("请求打到了 /chat/completions", seenRequests.some((x) => String(x.url).includes("/chat/completions")));
    check(`LLM 直出计数 ≥1（不是虚报）`, (g.llmDirect ?? 0) >= 1, `llmDirect=${g.llmDirect}`);
    check(`模型名被记进报告（有 client 就该记）`, Boolean(g.model), `model=${g.model}`);
  }
}

log("");
log("【二】--gen auto + 无 key ⇒ 必须显式降级，不得静默");
{
  const home = makeHome(false, baseUrl); // 不写 secrets.json
  const out = path.join(tmpRoot, "out2.json");
  const reportPath = path.join(tmpRoot, "report2.json");
  const r = await runJudge({ home, out, report: reportPath });
  check("judge 退出码为 0（不崩）", r.status === 0, `实际 ${r.status}`);
  check("降级时打印了告警（不静默）", /回落模板|未找到 DeepSeek key|占位/.test(`${r.stdout}${r.stderr}`));

  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  if (report) {
    const g = report.generation ?? {};
    check(`actualMode 落到 template`, g.actualMode === "template", `实际 ${g.actualMode}`);
    check(`风险判定标注为 rules_only`, g.riskSemantic === "rules_only", `实际 ${g.riskSemantic}`);
    check(`报告里留了 notes 说明降级`, Array.isArray(g.notes) && g.notes.length > 0);
    check(`无 key 时不得声称有模型`, g.model === null, `model=${g.model}`);
  } else {
    check("产出裁决报告", false, "文件缺失");
  }
}

log("");
log("【三】源码级防回归：不得把 auto 漏在 llmEnabled 之外");
{
  const src = fs.readFileSync(JUDGE, "utf8");
  // 去掉注释再检查：注释里正大光明地写着「不要用 replyCount - fallbackCount 反推」，
  // 直接 grep 源码会把这句话自己当成违规（第一次跑就这么误报了一次）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(
    "存在 auto → llm 的收口（genMode === \"auto\" 被赋成 llm）",
    /if\s*\(\s*genMode\s*===\s*"auto"\s*\)\s*genMode\s*=\s*"llm"/.test(src),
  );
  check(
    "llmEnabled 仍按 llm/mock 判定（收口必须发生在其之前）",
    /llmEnabled\s*=\s*Boolean\(client\)\s*&&\s*\["llm",\s*"mock"\]\.includes\(genMode\)/.test(src),
  );
  check(
    "不再用 replyCount - fallbackCount 反推「LLM 直出」",
    !/replyCount\s*-\s*fallbackCount/.test(code),
    "仍存在该反推表达式",
  );
  check("改用显式计数器 llmDirectCount", src.includes("llmDirectCount"));
  check("报告暴露 llmDirect 字段", /llmDirect\s*:/.test(src));
}

/* ---------------- 收尾 ---------------- */
for (const fn of cleanup) {
  try {
    fn();
  } catch {
    /* 清理失败不影响结论 */
  }
}

log("");
log("================ 结果 ================");
log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
