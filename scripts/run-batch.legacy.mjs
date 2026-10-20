#!/usr/bin/env node
/**
 * run-batch.mjs — 批量执行入口（你点一次 = 跑一轮）
 *
 * 默认 stage 1（只读）：works → comments:export → judge。**本阶段物理上不会发送任何回复。**
 * stage 2（发送）必须显式指定 `--stage 2`，否则不执行 comments:reply。
 *
 * 用法：
 *   node scripts/run-batch.mjs                          # 批 1：只读；跑哪些作品由「控制台」决定
 *   node scripts/run-batch.mjs --work "作品标题片段"     # 只处理你指定的那个作品（覆盖控制台设置）
 *   node scripts/run-batch.mjs --all-works              # 全量（覆盖控制台设置）
 *   node scripts/run-batch.mjs --max-works 3            # 配 --all-works 时限制数量
 *   node scripts/run-batch.mjs --stage 2                # 批 2：在批 1 基础上发送
 *   node scripts/run-batch.mjs --stage 2 --reply-dry-run # 批 2 演练：浏览器里真打字，但不点「发送」
 *   node scripts/run-batch.mjs --gen llm|template|auto  # 文案生成方式（默认 auto＝有 key 就用 LLM）
 *   node scripts/run-batch.mjs --risk-llm off           # 关闭 LLM 语义风险判定（省钱）
 *
 * 运行范围（跑哪些作品）默认读 config/works-switch.json，由控制台页面（3-控制台.bat）维护：
 *   latest   = 只跑最新作品（按发布时间取，不依赖列表顺序）
 *   selected = 只跑页面里勾选的作品
 *   all      = 全部作品
 * 命令行 --work / --all-works 优先级更高，用于临时覆盖。
 *
 * 容错：单个作品出错（如评论区域加载超时）只跳过该作品并记录，**不再中断整批**；
 * 但只要有一个作品失败，进程退出码就是 1 —— 前端才能据此说「异常结束」而不是「正常结束」。
 *
 * ★ 启动 tool/ 里的脚本一律走 scripts/tool-runner.mjs（node 直连，不经 npm/cmd）。
 *   2026-10-16 生产事故：`npm run comments:reply -- <judged 路径>` 经 cmd 传递时，
 *   路径里的空格把参数劈成三段，`agent` 变成独立参数 → tool 端报「Unknown argument: agent」，
 *   发送整条链路失败。根因与复现见 tool-runner.mjs 头注释与 变更-C11。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { loadSwitch, parsePublishTime, selectWorks } from "./works-switch.mjs";
import { TOOL_DIR, toolCommand } from "./tool-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const OUT_DIR = path.join(TOOL_DIR, "comments-output");
const NODE_BIN_DIR = path.dirname(process.execPath);

const FLAGS = ["verbose", "dry-run", "all-works", "reply-dry-run"];

function parseArgs(argv) {
  const args = { stage: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (FLAGS.includes(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${key} 缺少取值`);
    args[name] = value;
    i += 1;
  }
  if (args.stage) args.stage = Number(args.stage);
  if (args["max-works"]) args.maxWorks = Number(args["max-works"]);
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (![1, 2].includes(args.stage)) throw new Error("--stage 只支持 1 或 2");

/**
 * 2026-10-16 发现：`--ui-timeout-ms` 这个参数**从来没有被 tool 接受过** ——
 * tool 内部的 uiTimeoutMs 只存在于代码默认值（30s），上游仅在报错文案里提过
 * 「Try --ui-timeout-ms 60000」，参数解析里并没有实现。传下去只会得到
 * 「Unknown argument: --ui-timeout-ms」，而且会把「导出超时」这个真正的原因掩盖掉
 * （旧版的"90s 重试"永远走到这条死路）。这里显式忽略并说明，不搞静默。
 */
if (args["ui-timeout-ms"]) {
  console.log("[!] --ui-timeout-ms 已忽略：tool/ 的 comments:export 并不支持该参数（上游未实现）。");
  console.log("    导出失败会自动原样重试一次；仍失败请看该作品行上方的报错原文。");
  delete args["ui-timeout-ms"];
}
if (args["reply-dry-run"] && args.stage !== 2) {
  console.log("[!] --reply-dry-run 只在 --stage 2 下有效（stage 1 本来就只读、不发送）。");
}

const env = {
  ...process.env,
  PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
};

/**
 * 安全：调用第三方工具（tool/ 是外部克隆仓库，带 187 个 npm 依赖）时，
 * 必须从子进程环境里剥掉密钥——否则任何一个被投毒的依赖都能 process.env 直接读走。
 * 本项目的脚本（judge.mjs 等）走完整环境；第三方工具走剥离后的环境。
 */
const stripList = (() => {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"),
    );
    const list = cfg.security?.secrets?.strip_from_child_env;
    return Array.isArray(list) && list.length ? list : ["DEEPSEEK_API_KEY"];
  } catch {
    return ["DEEPSEEK_API_KEY"];
  }
})();
const envForTool = { ...env };
const strippedKeys = [];
for (const key of stripList) {
  if (key in envForTool) {
    delete envForTool[key];
    strippedKeys.push(key);
  }
}
if (strippedKeys.length) {
  console.log(`[安全] 已从第三方工具子进程环境剥离：${strippedKeys.join(", ")}（本项目脚本不受影响）`);
}

/**
 * 跑一个子进程：边跑边把输出原样透传到本进程 stdout/stderr（控制台页面靠这个实时显示），
 * 同时缓存末尾若干行 —— 失败时一起塞进错误信息。
 *
 * 为什么必须带"最近输出"（2026-10-16 血的教训）：发送失败时，真正有用的线索是子进程
 * 输出的那行 `Unknown argument: agent`，而旧实现只能给一句「请检查日志里有没有 X」的
 * 通用提示 → 排障被自己的提示带偏（一度疑到"要重新登录""浏览器被占用"）。
 * 失败信息必须自带现场，而不是让用户自己去翻。
 *
 * @param {boolean} [opts.stdinEnter] 子进程若会停下来等 Enter（tool 的 --dry-run 收尾会
 *   提示"按 Enter 关闭浏览器"），提前把一个换行写进它的 stdin，避免在无 TTY 环境下永久悬挂。
 */
function runChild({ bin, argv, cwd, env: childEnv, label, stdinEnter = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd,
        env: childEnv,
        stdio: [stdinEnter ? "pipe" : "inherit", "pipe", "pipe"],
      });
    } catch (error) {
      // Windows 上 spawn 一个 .cmd/.bat + shell:false 会**同步**抛 EINVAL（Node 安全限制）。
      // 兜住它，否则异常里连"哪个命令没跑起来"都没有。
      reject(new Error(`${label} 启动失败：${error.message}\n  命令：${bin} ${argv.join(" ")}`));
      return;
    }

    if (stdinEnter && child.stdin) {
      // 不立即 end()：脚本运行期间 readline 才创建，提前写入的换行会留在管道里被读到。
      child.stdin.write("\n");
    }

    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const tails = { out: "", err: "" };
    const tee = (stream, key) => (buf) => {
      stream.write(buf);
      tails[key] = (tails[key] + decoders[key].write(buf)).slice(-8000);
    };
    child.stdout.on("data", tee(process.stdout, "out"));
    child.stderr.on("data", tee(process.stderr, "err"));

    child.on("error", (error) => {
      reject(new Error(`${label} 启动失败：${error.message}\n  命令：${bin} ${argv.join(" ")}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = `${tails.out}\n${tails.err}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-12);
      reject(
        new Error(
          `${label} 失败（退出码 ${code}）\n` +
            (tail.length ? `  【最近输出】\n${tail.map((line) => `    ${line}`).join("\n")}\n` : "") +
            "  （若上面输出含「需要登录 / 跳转到登录页」→ 请本人重新扫码登录；" +
            "若含 DOUYIN_BROWSER_BUSY → 已有实例在跑，等它结束）",
        ),
      );
    });
  });
}

/** 跑 tool/ 里的脚本：node 直连，不经 npm/cmd（原因见 tool-runner.mjs） */
function runTool(scriptName, extraArgs, label, opts = {}) {
  const cmd = toolCommand(scriptName, extraArgs);
  console.log(`\n[${label}] ${cmd.display}`);
  return runChild({
    bin: cmd.bin,
    argv: cmd.argv,
    cwd: cmd.cwd,
    env: envForTool,
    label,
    stdinEnter: opts.stdinEnter,
  });
}

/** 跑本项目自己的脚本（judge.mjs 等），走完整环境（需要 DEEPSEEK_API_KEY） */
function runNode(scriptArgs, label) {
  console.log(`\n[${label}] node ${scriptArgs.join(" ")}`);
  return runChild({ bin: process.execPath, argv: scriptArgs, cwd: PROJECT_DIR, env, label });
}

fs.mkdirSync(OUT_DIR, { recursive: true });

if (args["dry-run"]) {
  console.log("\n[dry-run] 仅做前置检查与计划打印，不执行任何外部命令、不打开浏览器、不发任何请求。");
  console.log(`  stage=${args.stage}（${args.stage === 1 ? "只读，物理不含发送" : "含发送"})`);
  console.log(`  --gen=${args.gen ?? "auto（有 key 走 llm，无 key 回落模板）"}｜--risk-llm=${args["risk-llm"] ?? "auto"}`);
  console.log(`  密钥是否在当前环境：${process.env.DEEPSEEK_API_KEY ? "是（将被剥离后再传给第三方工具）" : "否"}`);
  console.log("\n[dry-run] 结束。");
  process.exit(0);
}

async function main() {
  await runTool("works", [], "1/4 拉作品列表");

  const worksFile = path.join(OUT_DIR, "list-works.json");
  const works = JSON.parse(fs.readFileSync(worksFile, "utf8")).works ?? [];

  /**
   * 运行范围：优先级 = 命令行 --work / --all-works > 控制台页面里的设置。
   * 选择逻辑全部收敛在 scripts/works-switch.mjs（与控制台页面共用同一份），
   * 这里只负责把「为什么跑这几个」原样打印出来 —— 范围不可见就等于静默跑错。
   */
  const switchLoad = loadSwitch(PROJECT_DIR);
  if (switchLoad.error) console.log(`[!] ${switchLoad.error}`);

  const pick = selectWorks(works, switchLoad.sw, {
    work: args.work,
    allWorks: args.allWorks,
    maxWorks: args.maxWorks,
  });

  if (args.work && pick.selected.length === 0) {
    console.log(`[!] 没有标题包含「${args.work}」的作品。可用标题：`);
    works.forEach((w) => console.log(`    · ${w.title}`));
    process.exit(0);
  }

  const selected = pick.selected;

  if (selected.length === 0) {
    console.log(`[!] 本轮没有要处理的作品（运行范围：${pick.reason}）。`);
    if (switchLoad.sw.mode === "selected") {
      console.log("    控制台里当前没有任何作品被勾选。");
      console.log("    → 双击 3-控制台.bat 去勾选作品，或把「运行范围」改成「只跑最新作品」。");
    }
    process.exit(0);
  }

  console.log(`\n[✓] 运行范围：${pick.reason}`);
  if (pick.source === "ui-latest" && selected[0]) {
    const dated = works.filter((w) => parsePublishTime(w)).length;
    console.log(
      `    [最新作品] ${selected[0].title}（${selected[0].publishText ?? "时间未知"}）` +
        (dated > 1 ? `｜另发现 ${dated - 1} 个更早的作品，本轮不处理` : ""),
    );
  }
  console.log(`    待处理作品 ${selected.length} 个：${selected.map((w) => w.title).join(" / ")}`);

  const summary = [];
  const failures = [];
  for (const [index, work] of selected.entries()) {
    const title = String(work.title ?? "");
    const tag = `2/4 导出评论（${index + 1}/${selected.length}）`;
    const slug = `work-${String(index + 1).padStart(2, "0")}`;
    const judged = path.join(OUT_DIR, `judged-${slug}.json`);
    const report = path.join(OUT_DIR, `judge-report-${slug}.json`);

    /**
     * 单个作品失败不再让整批中断（2026-10-16 修）。
     * 原实现是 `runNpm(...)` 直接抛错 → 26 个作品里第 6 个 UI 超时，
     * 后面 20 个作品根本没跑，而"漏采率"这类核对指标也就无从谈起。
     * 现在：记入 failures、跳过该作品继续；最后单独汇总（并让退出码非 0）。
     */
    try {
      try {
        await runTool("comments:export", [title], tag);
      } catch (firstError) {
        // 评论区域偶发加载慢（tool 的 UI 超时固定 30s，且没有可调参数）。
        // 原样再跑一次——实测多数是瞬时慢，第二次能过。
        console.log(`[!] 「${title}」导出失败（${firstError.message.split("\n")[0]}），原样重试一次…`);
        await runTool("comments:export", [title], `${tag} · 重试`);
      }

      const judgeArgs = [
        path.join(PROJECT_DIR, "scripts", "judge.mjs"),
        "--in", path.join(OUT_DIR, "unreplied-comments.json"),
        "--out", judged,
        "--report", report,
      ];
      if (args.gen) judgeArgs.push("--gen", String(args.gen));
      if (args["risk-llm"]) judgeArgs.push("--risk-llm", String(args["risk-llm"]));
      if (args.verbose) judgeArgs.push("--verbose");
      await runNode(judgeArgs, `3/4 裁决（${index + 1}/${selected.length}）`);

      const reportData = JSON.parse(fs.readFileSync(report, "utf8"));
      summary.push({
        title,
        total: reportData.total,
        replied: reportData.replied,
        skipped: reportData.skipped,
        genMode: reportData.generation?.actualMode ?? "?",
        model: reportData.generation?.model ?? null,
        riskLayer: reportData.generation?.riskSemantic ?? "?",
        llmDirect: reportData.generation?.llmDirect ?? null,
        fallback: reportData.generation?.templateFallback ?? 0,
        costCny: reportData.llm?.estimatedCny ?? 0,
        judged,
        report,
      });

      if (args.stage === 2) {
        if (reportData.replied === 0) {
          console.log(`[stage2] 「${title}」本轮无待回复条目，跳过发送。`);
          continue;
        }
        const replyArgs = [judged];
        if (args["reply-dry-run"]) replyArgs.push("--dry-run");
        await runTool(
          "comments:reply",
          replyArgs,
          `4/4 发送（${index + 1}/${selected.length}）${args["reply-dry-run"] ? " · 演练（不点发送）" : ""}`,
          // 演练模式收尾会提示「按 Enter 关闭浏览器」，没有 TTY 时提前喂一个换行，避免悬挂。
          { stdinEnter: Boolean(args["reply-dry-run"]) },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ title, message });
      console.log(`\n[✗] 「${title}」处理失败，已跳过，继续下一个：${message.split("\n")[0]}`);
    }
  }

  console.log("\n================ 本轮汇总 ================");
  let totalCost = 0;
  for (const row of summary) {
    console.log(`· ${row.title}：共 ${row.total} 条 → 拟回复 ${row.replied} / 留空 ${row.skipped}`);
    console.log(
      `  生成=${row.genMode}${row.model ? `（${row.model}）` : ""}｜风险=${row.riskLayer}｜LLM 直出 ${row.llmDirect ?? "?"} 条｜回退模板 ${row.fallback} 条｜估算费用 ≈ ¥${row.costCny}`,
    );
    console.log(`  裁决：${row.judged}`);
    console.log(`  报告：${row.report}`);
    totalCost += Number(row.costCny) || 0;
  }
  if (summary.length > 1) console.log(`\n本轮合计估算费用 ≈ ¥${totalCost.toFixed(4)}（以官方账单为准）`);
  if (failures.length) {
    console.log(`\n⚠️ 有 ${failures.length} 个作品处理失败（已跳过，其余作品不受影响；本进程退出码 = 1）：`);
    for (const f of failures) {
      console.log(`  · ${f.title}`);
      for (const line of f.message.split("\n")) console.log(`    ${line}`);
    }
  }
  if (args.stage === 1) {
    console.log("\n[stage 1 只读] 未发送任何回复。确认无误后加 --stage 2 执行发送。");
  } else if (args["reply-dry-run"]) {
    console.log("\n[stage 2 演练] 浏览器里已真打字，但**没有点发送**任何一条。去掉 --reply-dry-run 才会真正发送。");
  } else {
    console.log("\n[stage 2 已发送] 发送结果见 tool/comments-output/reply-comments-result.json 与 reply-ledger.jsonl。");
  }

  // 有失败就不能报"正常结束"：前端按退出码分叉提示（2026-10-16 修）。
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n运行中断：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
