#!/usr/bin/env node
/**
 * run-session.mjs — 单浏览器会话执行器（2026-10-16 性能优化）
 *
 * ── 为什么有这个东西（作者的原话）──
 *   「自动回复要打开我的抖音创作者中心两遍：第一遍先打开然后打开我的作品列表，然后关了；
 *     再打开创作者中心，再打开一次作品列表然后切换到评论回复页面。这个是必要流程吗？」
 *
 * 结论：**不是平台要求，是旧编排方式的副产品。**
 *   旧 run-batch 依次跑三个独立的 tool CLI（works / comments:export / comments:reply），
 *   每个都是独立进程：各自启动一次 Chromium、各自导航到评论页、各自扫描一遍作品侧边栏。
 *   一轮 = 3 次浏览器会话，慢且画面上就是"反复打开创作者中心"。
 *
 * 本脚本把三步压进**同一个浏览器会话**：
 *   启动会话 → 定位作品（同时替代 works 的"拉列表"与 export 的"选作品"两次扫描）
 *            → 采集评论（原 export 的活）
 *            → 裁决（外部 judge 进程，不碰浏览器）
 *            → 发送（直接复用同一个 page，原 reply 的活）
 *   结束时打印分阶段耗时，慢在哪一段一目了然。
 *
 * ── 为什么本脚本 import tool/ 的内部模块，而不是调用它的 CLI ──
 *   tool/ 是外部克隆仓库，**不做任何修改**（保持可被上游替换）。它的 CLI 每次都
 *   独立开会话，天然无法复用；但它的模块把需要的组件全部导出了：
 *     fetchAllWorksWithRetry / findTargetWorkWithRetry / getWorksOutput / getSelectedWorkOutput
 *     collectComments / replyToComments / emitResult / loadReplyCommentsFile
 *     downloadCommentImages / db-ops / reply-ledger
 *   所以这里以"模块调用方"的身份重组流程 —— tool/ 零改动。
 *
 * ── 行为约定（与旧 run-batch 保持一致，改动都要能对上账）──
 *   · 输出文件同路径同格式：comments-output/list-works.json / unreplied-comments.json /
 *     judged-work-NN.json / judge-report-work-NN.json / reply-comments-result.json
 *   · 单个作品失败只跳过并记录，继续下一个；有失败则退出码 = 1
 *   · stage 1 物理上不调用 replyToComments；stage 2 才发送（--reply-dry-run 只打字不点发送）
 *
 * ── 与旧流程唯一的行为差异（有意为之）──
 *   “跑一轮”不再每次都重新拉取完整作品列表：
 *     · mode=selected（控制台勾选）→ 直接用本地 list-works.json 里勾选的作品
 *     · mode=latest → 先检查侧边栏顶部作品与本地列表是否一致；一致就用本地列表，不一致才重拉
 *     · mode=all / --all-works / --fresh-works → 仍然强制拉取完整列表
 *   原因：拉全量列表要滚到底 + 空闲检测，实测每次都花 25-30 秒，而"勾选/最新"的目标
 *   在本地列表里已经有确定答案。需要刷新列表时，用控制台的「刷新作品列表」按钮，
 *   或者给本脚本传 --fresh-works。
 *
 * ★★ cwd 铁律 ★★
 *   tool/ 的模块在**顶层**用 path.resolve() 计算默认路径（.playwright/douyin-profile、
 *   comments-output/、data/douyin-creator.db）。ESM 的静态 import 会被提升到模块体之前
 *   执行，因此必须在**动态 import 之前** process.chdir(tool/)，否则这些默认路径会落到
 *   错误目录 —— 典型症状是"明明登录过却说没登录"（拿错 profile）。
 *   本脚本所有 tool 模块都用 await import() 动态加载，且在 chdir 之后。
 *
 * 用法：
 *   node scripts/run-session.mjs [--stage 1|2] [--work "标题片段"] [--all-works]
 *                                [--max-works N] [--gen auto|llm|template]
 *                                [--risk-llm auto|off] [--reply-dry-run]
 *                                [--fresh-works] [--debug] [--verbose] [--help]
 *   （通常不直接跑它，由 scripts/run-batch.mjs 统一入口调用）
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { loadSwitch, pickLatest, selectWorks } from "./works-switch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const TOOL_DIR = path.join(PROJECT_DIR, "tool");
const OUT_DIR = path.join(TOOL_DIR, "comments-output");
const WORKS_FILE = path.join(OUT_DIR, "list-works.json");
const EXPORT_FILE = path.join(OUT_DIR, "unreplied-comments.json");
const REPLY_FILE = path.join(OUT_DIR, "reply-comments-result.json");

/** 与 tool/src/comment-workflow.mjs 的默认值保持同源（那边改值这边要对账） */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_UI_TIMEOUT_MS = 30000;
const DEFAULT_WORKS_TIMEOUT_MS = 45000;
const DEFAULT_WORKS_IDLE_MS = 5000;
const DEFAULT_COMMENTS_TIMEOUT_MS = 300000;
const DEFAULT_COMMENTS_IDLE_MS = 5000;
const DEFAULT_REPLY_TIMEOUT_MS = 30000;
const DEFAULT_REPLY_SETTLE_MS = 1800;
const DEFAULT_REPLY_TYPE_DELAY_MS = 50;
/** 单轮发送的**物理**上限（只防异常数据拖死浏览器；业务上限在 reply-rules.json 里） */
const MAX_REPLY_LIMIT = 200;
const DEFAULT_EXPORT_LIMIT = 5000;
const MAX_AUTO_REPLY_FLOW_TIMEOUT_MS = 7200000;
const DEFAULT_REPLY_FLOW_TIMEOUT_MS = 1800000;
const REPLY_FLOW_TIMEOUT_BUFFER_MS = 60000;
const REPLY_FLOW_TIMEOUT_PER_PLAN_MS = 20000;

const FLAGS = ["verbose", "all-works", "reply-dry-run", "fresh-works", "debug", "help", "headless"];

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
  // 连字符标志同步一份 camelCase 别名：args["all-works"] 与 args.allWorks 同时可用。
  // （2026-10-16 踩过：只写一种拼法时另一种静默读到 undefined —— --fresh-works/--all-works 直接失效，
  //   而且不报错、只是"还是走了缓存"，极易被当成缓存策略本身有问题。）
  for (const name of FLAGS) {
    if (name.includes("-")) {
      const camel = name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (args[name] !== undefined) args[camel] = args[name];
    }
  }
  if (args.stage) args.stage = Number(args.stage);
  if (args["max-works"]) args.maxWorks = Number(args["max-works"]);
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
用法：node scripts/run-session.mjs [--stage 1|2] [--work "标题片段"] [--all-works]
                                    [--max-works N] [--gen auto|llm|template]
                                    [--risk-llm auto|off] [--reply-dry-run]
                                    [--fresh-works] [--debug] [--verbose]

  --stage 1          只读：定位 → 采集 → 裁决，不发送（默认）
  --stage 2          发送：在 stage 1 全部环节之后追加回复
  --work "片段"      只处理标题含该片段的作品（覆盖控制台设置）
  --all-works        处理全部作品（强制拉取完整列表）
  --max-works N      配合 --all-works 限制数量
  --reply-dry-run    stage 2 演练：浏览器里真打字，但不点「发送」
  --fresh-works      强制重新拉取完整作品列表（默认 selected/latest 模式复用本地列表）
  --gen / --risk-llm 透传给 scripts/judge.mjs
  --debug            打开 tool 的回复过滤调试日志
`);
  process.exit(0);
}

if (![1, 2].includes(args.stage)) throw new Error("--stage 只支持 1 或 2");

const t0 = Date.now();

/**
 * 跑一个子进程并原样透传输出（同 run-batch 的 runChild：失败时把"最近输出"带进错误里）。
 * 本脚本只用它跑 judge（本项目脚本，需要完整环境；密钥由 judge 自己按
 * 环境变量 → ~/.douyin-automation/secrets.json → config/secrets.local.json 的顺序解析）。
 */
function runChild({ bin, argv, cwd, env, label }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { cwd, env, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${label} 启动失败：${error.message}\n  命令：${bin} ${argv.join(" ")}`));
      return;
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
      reject(new Error(`${label} 启动失败：${error.message}`));
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
            (tail.length ? `  【最近输出】\n${tail.map((line) => `    ${line}`).join("\n")}\n` : ""),
        ),
      );
    });
  });
}

/**
 * ★ cwd 必须在动态 import 之前切换：见文件头「cwd 铁律」。
 * 之后 tool 模块顶层所有 path.resolve("相对路径") 都会以 tool/ 为基准。
 */
process.chdir(TOOL_DIR);

// ── tool 模块动态加载（chdir 之后）────────────────────────────────────────────
const tool = {};
async function loadTool() {
  tool.browser = await import("../tool/src/douyin-browser.mjs");
  tool.commentPage = await import("../tool/src/lib/comment-page.mjs");
  tool.commentOps = await import("../tool/src/lib/comment-ops.mjs");
  tool.worksPanel = await import("../tool/src/lib/works-panel.mjs");
  tool.replyFlow = await import("../tool/src/lib/reply-flow.mjs");
  tool.dbOps = await import("../tool/src/lib/db-ops.mjs");
  tool.replyLedger = await import("../tool/src/lib/reply-ledger.mjs");
  tool.commentImages = await import("../tool/src/lib/comment-images.mjs");
  tool.resultStore = await import("../tool/src/lib/result-store.mjs");
  tool.common = await import("../tool/src/lib/common.mjs");
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

function readCachedWorks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKS_FILE, "utf8"));
    const works = Array.isArray(parsed?.works) ? parsed.works : [];
    return works.length ? works : null;
  } catch {
    return null;
  }
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveReplyFlowTimeout(replyLimit, replyPlanCount) {
  const targetReplyCount = Math.max(
    1,
    Math.min(replyLimit || replyPlanCount || 1, replyPlanCount || replyLimit || 1),
  );
  return Math.min(
    MAX_AUTO_REPLY_FLOW_TIMEOUT_MS,
    Math.max(
      DEFAULT_REPLY_FLOW_TIMEOUT_MS,
      REPLY_FLOW_TIMEOUT_BUFFER_MS + targetReplyCount * REPLY_FLOW_TIMEOUT_PER_PLAN_MS,
    ),
  );
}

/** 与 tool/src/comment-workflow.mjs 的 syncReplyLedgerFromDatabase 等价（同源复制） */
function syncReplyLedgerFromDatabase() {
  try {
    const rows = tool.dbOps.getRepliedCommentRows();
    const result = tool.replyLedger.backfillReplyLedgerEvents(
      rows.map((row) => ({
        workTitle: row.work_title,
        username: row.username,
        commentText: row.comment_text,
        publishText: row.comment_time,
        replyMessage: row.reply_message,
        status: "db_backfill",
        source: "database_reply_count",
      })),
      {},
    );
    if (result.appendedCount > 0) {
      console.log(`[ledger] 已从数据库回填 ${result.appendedCount} 条历史回复记录`);
    }
  } catch (error) {
    console.warn(`[ledger] 数据库历史回填失败，继续使用现有独立台账: ${error?.message ?? error}`);
  }
}

/** 重复/雷同评论的归一化键：去空白与常见标点、全角转半角、统一小写 */
function normalizeCommentText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfef0))
    .replace(/[，。！？、；：""''（）【】《》…—～·,.!?;:'"()<>[\]{}]/g, "");
}

/**
 * 同一内容（归一化后相同）的评论最多自动回复几条 —— 2026-10-17 改为可配置。
 *
 *   0   = 不限（作者要求：不要因为"重复"就漏回，漏回的会一直堆在未回复列表里）
 *   >0  = 上限（防同一句话被一群人刷屏时全量回复）
 *
 * 配置：`config/reply-rules.json` → `collection.duplicate_reply_cap`（控制台第 3 节）。
 * 真正的「防单账号刷屏」是 `security.budget.per_user_reply_cap`（每轮每用户最多 3 条）；
 * 这里的上限只管「同一句话被不同人重复」这一种场景，两者互补，别搞混。
 */
let duplicateReplyCap = 0;

function loadDuplicateReplyCap() {
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"));
    const v = Number(rules?.collection?.duplicate_reply_cap);
    if (Number.isFinite(v) && v >= 0) duplicateReplyCap = Math.floor(v);
  } catch {
    /* 读不到就沿用默认 0（不限）——宁可多回，也不要因为配置读失败而静默漏回 */
  }
  console.log(
    duplicateReplyCap > 0
      ? `[采集] 同一内容的评论最多回复 ${duplicateReplyCap} 条（超出跳过）`
      : "[采集] 同一内容的评论不限回复条数（同一句被多人重复时也会逐条回复）",
  );
}

/**
 * 构建「归一化评论文本 → 已回复记录」的上下文（限当前作品）。
 * 数据库在这里只做两件事，**不再作为"回复过与否"的否决依据**：
 *   ① 复用：同一内容回复过 → 沿用那条文案（作者规则：重复的评论用已回复过的对应评论回复）；
 *   ② 封顶：同一内容已成功回复满 3 条 → 之后的重复评论跳过。
 * 为什么不以数据库/台账为"是否回复过"的真相：2026-10-16 实测发送确认存在假阳性
 * （线程本来就有回复也会被记成 replied），作者拍板「回复与否以抖音创作者中心显示为准」
 * —— 页面的「未回复」过滤已经在采集层生效，这里只负责复用与封顶。
 */
function buildReplyReuseContext(workTitle) {
  const ctx = new Map();
  let rows = [];
  try {
    rows = tool.dbOps.getRepliedCommentRows().filter((row) => row.work_title === workTitle);
  } catch (error) {
    console.warn(`[db] 查询已回复记录失败（重复评论将按新评论处理）: ${error?.message ?? error}`);
    return ctx;
  }
  for (const row of rows) {
    const key = normalizeCommentText(row.comment_text);
    if (!key) continue;
    const cur = ctx.get(key) ?? { replyMessage: "", sentCount: 0 };
    if (!cur.replyMessage && row.reply_message) cur.replyMessage = String(row.reply_message);
    cur.sentCount += Number(row.reply_count ?? 0);
    ctx.set(key, cur);
  }
  return ctx;
}

function applyReuseAndCap(comments, ctx) {
  const kept = [];
  let reused = 0;
  let capped = 0;
  for (const comment of comments) {
    const hit = ctx.get(normalizeCommentText(comment.commentText));
    // cap=0 表示不限：重复评论照常进裁决（后续由复用上限/话术池控制文案，不会重复同一句）
    if (duplicateReplyCap > 0 && hit && hit.sentCount >= duplicateReplyCap) {
      capped += 1;
      continue;
    }
    if (hit?.replyMessage) {
      comment.priorReplyMessage = hit.replyMessage;
      reused += 1;
    }
    kept.push(comment);
  }
  if (reused > 0) console.log(`[复用] ${reused} 条重复/雷同评论将沿用已回复过的文案（不再重新生成）`);
  if (capped > 0) console.log(`[上限] ${capped} 条重复评论跳过（同一内容已回复满 ${duplicateReplyCap} 条）`);
  return kept;
}

// ── 侧边栏辅助 ───────────────────────────────────────────────────────────────

const SIDE_SHEET_SELECTOR = ".douyin-creator-interactive-sidesheet-body:visible";

function sideSheetLocator(page) {
  return page.locator(SIDE_SHEET_SELECTOR).last();
}

/**
 * 侧边栏若可见且已被滚离顶部，滚回顶部。
 * 为什么需要：同一个会话里"先拉列表、再定位作品"——拉列表结束时侧边栏停在最底部，
 * 而目标（最新/勾选的作品）大概率在顶部；不重置的话定位环节要空转整个空闲检测窗口。
 */
async function resetSideSheetScroll(page) {
  const sideSheet = sideSheetLocator(page);
  if (!(await sideSheet.isVisible().catch(() => false))) return false;
  const before = await sideSheet.evaluate((el) => el.scrollTop).catch(() => 0);
  if (before > 0) {
    await sideSheet.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

/** 打开（或复用）侧边栏并确保停在顶部 */
async function openSideSheetAtTop(page) {
  const sideSheet = sideSheetLocator(page);
  if (!(await sideSheet.isVisible().catch(() => false))) {
    const trigger = page
      .locator('button:has-text("选择作品"):visible, [role="button"]:has-text("选择作品"):visible')
      .last();
    await trigger.waitFor({ state: "visible", timeout: DEFAULT_UI_TIMEOUT_MS });
    await trigger.click();
    await sideSheet.waitFor({ state: "visible", timeout: DEFAULT_UI_TIMEOUT_MS });
  }
  await sideSheet.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(700);
  return sideSheet;
}

/**
 * 读取侧边栏里 DOM 顺序上第一个作品卡片（标题 + 发布时间）。
 * 卡片识别规则与 tool/src/lib/works-panel.mjs 的 inspectWorksInSideSheet 同源复制
 * —— 只有判定规则一致，"顶部第一个"才和 tool 眼里的第一个是同一个东西。
 * 任何解析失败返回 null（调用方按"无法确认"处理，回退到完整拉取）。
 */
async function readFirstWorkFromSideSheet(sideSheet) {
  return sideSheet.evaluate((root) => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const splitLines = (value = "") =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);

    const isCandidate = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const lines = splitLines(node.innerText || node.textContent || "");
      if (lines.length < 2 || lines.length > 8) return false;
      const publishLines = lines.filter((line) => line.includes("发布于"));
      if (publishLines.length !== 1) return false;
      const nonPublishLines = lines.filter((line) => !line.includes("发布于"));
      if (nonPublishLines.length < 1) return false;
      const text = normalize(node.innerText || node.textContent || "");
      if (!text || text.length > 200) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 24) return false;
      return true;
    };

    const rawCandidates = Array.from(root.querySelectorAll("*")).filter(isCandidate);
    const candidates = rawCandidates.filter(
      (candidate) => !rawCandidates.some((other) => other !== candidate && candidate.contains(other)),
    );
    const first = candidates[0];
    if (!first) return null;

    const lines = splitLines(first.innerText || first.textContent || "");
    const publishText = lines.find((line) => line.includes("发布于")) || "";
    const rawTitle = lines.find((line) => line && !line.includes("发布于")) || "";
    const fullCompact = normalize(rawTitle).replace(/\s+/g, "");
    return { title: fullCompact, publishText: normalize(publishText) };
  });
}

/**
 * latest 模式的「顶部一致性检查」：本地列表里的最新作品，是否还是页面上最顶部的那个？
 *   一致   → 本地列表没过期，直接复用（省掉整轮完整拉取的 25-30 秒）
 *   不一致 / 无法确认 → 返回 false，调用方老老实实重新拉完整列表
 * 方向性说明：这个检查只会"误报为不一致"（多花时间），不会"误报为一致"（漏新作品）——
 * 任何解析失败、读不到发布时间、标题对不上，都返回 false。
 */
async function topWorkMatchesCachedLatest(page, expected) {
  try {
    const sideSheet = await openSideSheetAtTop(page);
    const first = await readFirstWorkFromSideSheet(sideSheet);
    if (!first || !first.title) return false;

    // canonicalWorkTitle 归一化（getWorksOutput 与 list-works.json 的写入方是同一个函数）
    const [topWork] = tool.worksPanel.getWorksOutput([first]);
    if (!topWork || !topWork.title) return false;

    if (topWork.title !== expected.title) return false;
    if (expected.publishText) {
      if (!topWork.publishText) return false; // 读不到时间 → 无法确认（同名作品风险）
      if (topWork.publishText !== expected.publishText) return false;
    }
    return true;
  } catch (error) {
    console.log(`[列表] 顶部一致性检查失败（按"无法确认"处理）：${error?.message ?? error}`);
    return false;
  }
}

// ── 列表阶段 ─────────────────────────────────────────────────────────────────

async function fetchAndSaveWorks(page) {
  console.log("[列表] 正在拉取完整作品列表（会滚动加载全部作品）…");
  const startedAt = Date.now();
  const works = await tool.worksPanel.fetchAllWorksWithRetry(page, {
    deadline: null,
    maxRuntimeMs: 0,
    timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
    idleMs: DEFAULT_WORKS_IDLE_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
  });
  const output = tool.worksPanel.getWorksOutput(works);
  await tool.resultStore.emitResult(
    {
      pageUrl: tool.browser.DEFAULT_COMMENT_PAGE_URL,
      count: output.length,
      works: output,
    },
    WORKS_FILE,
  );
  console.log(`[列表] 共 ${output.length} 个作品（耗时 ${seconds(Date.now() - startedAt)}）`);
  return output;
}

async function resolveTargets(page) {
  const swLoad = loadSwitch(PROJECT_DIR);
  if (swLoad.error) console.log(`[!] ${swLoad.error}`);
  const sw = swLoad.sw;
  const cached = args.freshWorks ? null : readCachedWorks();

  // ① --work：命令行指定
  if (args.work) {
    if (cached) {
      const pick = selectWorks(cached, sw, { work: args.work });
      if (pick.selected.length === 0) {
        console.log(`[!] 本地列表里没有标题包含「${args.work}」的作品。可用标题：`);
        cached.forEach((w) => console.log(`    · ${w.title}`));
        console.log("    （列表可能不是最新；点控制台「刷新作品列表」或加 --fresh-works 重新拉取）");
        return { works: [], reason: "" };
      }
      return { works: pick.selected, reason: `${pick.reason}（在本地列表 ${cached.length} 个作品中匹配）` };
    }
    console.log("[列表] 本地暂无作品列表缓存 → 直接把标题片段交给定位环节（不拉全量列表）");
    return {
      works: [{ title: args.work, publishText: "" }],
      reason: `命令行 --work「${args.work}」（未拉列表，直接定位第一个匹配项）`,
    };
  }

  // ② 全量：--all-works 或控制台 mode=all
  if (args.allWorks || sw.mode === "all") {
    const works = await fetchAndSaveWorks(page);
    const pick = selectWorks(works, sw, { allWorks: args.allWorks, maxWorks: args.maxWorks });
    return { works: pick.selected, reason: pick.reason };
  }

  // ③ mode=selected：优先本地列表（勾选的作品在本地列表里有确定答案）
  if (sw.mode === "selected") {
    if (cached) {
      const pick = selectWorks(cached, sw, { maxWorks: args.maxWorks });
      console.log(
        `[列表] 复用本地作品列表（${cached.length} 个作品，未重新拉取；` +
          "需要刷新请点控制台「刷新作品列表」或加 --fresh-works）",
      );
      return { works: pick.selected, reason: `${pick.reason}（本地列表）` };
    }
    console.log("[列表] 本地暂无作品列表 → 拉取一次完整列表（下次跑一轮将直接复用）");
    const works = await fetchAndSaveWorks(page);
    const pick = selectWorks(works, sw, { maxWorks: args.maxWorks });
    return { works: pick.selected, reason: pick.reason };
  }

  // ④ mode=latest：本地列表 + 顶部一致性检查
  if (cached) {
    const latest = pickLatest(cached);
    if (latest && (await topWorkMatchesCachedLatest(page, latest))) {
      console.log("[列表] 页面顶部作品与本地列表一致（未发现新作品）→ 复用本地列表");
      return { works: [latest], reason: "控制台设置 = 只跑最新作品（本地列表）" };
    }
    console.log("[列表] 本地列表可能已过期 → 重新拉取完整列表");
  }
  const works = await fetchAndSaveWorks(page);
  const pick = selectWorks(works, sw, { maxWorks: args.maxWorks });
  return { works: pick.selected, reason: pick.reason };
}

// ── 单作品流程 ────────────────────────────────────────────────────────────────

/** 该视频累计已成功回复的条数（跨所有轮次；数据库 reply_count 合计）。读不到按 0 计 */
function workRepliedTotal(workTitle) {
  try {
    return tool.dbOps
      .getRepliedCommentRows()
      .filter((row) => row.work_title === workTitle)
      .reduce((sum, row) => sum + Number(row.reply_count ?? 0), 0);
  } catch (error) {
    console.warn(`[上限] 查询视频累计回复数失败（按 0 计）: ${error?.message ?? error}`);
    return 0;
  }
}

/** 回复总量上限配置（C-21）：runCap = 本次操作总上限；workCapTotal = 单视频累计上限（0=不限） */
function readFrequencyCaps() {
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"));
    return {
      runCap: Number(rules?.frequency?.max_replies_per_run ?? 30),
      workCapTotal: Number(rules?.frequency?.max_replies_per_work_total ?? 0),
    };
  } catch {
    return { runCap: 30, workCapTotal: 0 };
  }
}

async function runJudge({ inPath, outPath, reportPath, maxReplies }) {
  const argv = [
    path.join(PROJECT_DIR, "scripts", "judge.mjs"),
    "--in", inPath,
    "--out", outPath,
    "--report", reportPath,
  ];
  if (args.gen) argv.push("--gen", String(args.gen));
  if (args["risk-llm"]) argv.push("--risk-llm", String(args["risk-llm"]));
  if (args.verbose) argv.push("--verbose");
  // ★ C-21：本次预算（单轮总上限与视频累计上限的最小值）交给裁决层封顶，
  //   超出的评论在裁决阶段就被跳过（rate_cap），不会再走到发送。
  if (typeof maxReplies === "number" && Number.isFinite(maxReplies)) {
    argv.push("--max-replies", String(Math.max(0, Math.floor(maxReplies))));
  }
  // judge 是本项目脚本：密钥由它自己按 环境变量 → 外部 secrets.json → 项目内 secrets 解析。
  // 本进程（加载了第三方 tool 模块）故意不持有密钥，这里只透传环境。
  await runChild({ bin: process.execPath, argv, cwd: PROJECT_DIR, env: process.env, label: "裁决" });
}

async function processWork(page, work, index, total, { replyBudget } = {}) {
  const slug = `work-${String(index + 1).padStart(2, "0")}`;
  const judgedPath = path.join(OUT_DIR, `judged-${slug}.json`);
  const reportPath = path.join(OUT_DIR, `judge-report-${slug}.json`);
  const timings = {};
  if (typeof replyBudget === "number" && Number.isFinite(replyBudget)) {
    console.log(`[上限] 本作品本次最多拟回复 ${replyBudget} 条（单轮总上限与视频累计上限的最小值）`);
  }

  // ── ① 定位并选中作品（原 works + export 各扫一次 → 现在共用一个已打开的侧边栏）──
  let startedAt = Date.now();
  await resetSideSheetScroll(page);
  const targetWork = await tool.worksPanel.findTargetWorkWithRetry(page, {
    deadline: null,
    maxRuntimeMs: 0,
    workTitle: work.title,
    workPublishText: work.publishText || "",
    selectWhenMatched: true,
    timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
    idleMs: DEFAULT_WORKS_IDLE_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
  });
  const selectedWork = tool.worksPanel.getSelectedWorkOutput(targetWork) ?? {
    title: work.title,
    publishText: work.publishText || "",
  };
  timings.locateMs = Date.now() - startedAt;
  console.log(`已选中作品：${selectedWork.title}（定位 ${seconds(timings.locateMs)}）`);

  // ── ② 采集评论 ──
  startedAt = Date.now();
  const comments = await tool.commentOps.collectComments(page, {
    deadline: null,
    maxRuntimeMs: 0,
    limit: DEFAULT_EXPORT_LIMIT,
    timeoutMs: DEFAULT_COMMENTS_TIMEOUT_MS,
    idleMs: DEFAULT_COMMENTS_IDLE_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
  });
  timings.collectMs = Date.now() - startedAt;
  console.log(`[采集] 找到 ${comments.length} 条候选评论（${seconds(timings.collectMs)}）`);

  // 空值不静默：0 条评论与"采集失败"是两种事，必须让日志能区分
  if (comments.length === 0) {
    console.log("[采集] 该作品当前没有可处理的评论（未回复列表为空）。");
  }

  // ── ③ 复用 + 封顶（页面「未回复」为准；数据库只提供复用文案与重复计数）──
  const reuseCtx = buildReplyReuseContext(selectedWork.title);
  const exportComments = applyReuseAndCap(comments, reuseCtx);

  let historyMap = new Map();
  try {
    historyMap = tool.dbOps.getUserHistoryMap(exportComments.map((c) => c.username));
  } catch (dbError) {
    console.warn(`[db] 查询历史失败（不影响主流程）: ${dbError?.message ?? dbError}`);
  }

  await tool.commentImages.downloadCommentImages(exportComments, EXPORT_FILE);

  await tool.resultStore.emitResult(
    {
      selectedWork,
      count: exportComments.length,
      comments: exportComments.map((comment) => {
        const entry = {
          username: comment.username,
          commentText: comment.commentText,
          replyMessage: "",
        };
        if (comment.imagePaths?.length > 0) entry.imagePaths = comment.imagePaths;
        if (comment.priorReplyMessage) entry.priorReplyMessage = comment.priorReplyMessage;
        entry.history = historyMap.get(comment.username) ?? [];
        return entry;
      }),
    },
    EXPORT_FILE,
  );

  try {
    tool.dbOps.upsertComments(
      selectedWork.title,
      comments.map((c) => ({
        username: c.username,
        commentText: c.commentText,
        replyMessage: null,
      })),
    );
  } catch (dbError) {
    console.warn(`[db] 写入评论失败（不影响主流程）: ${dbError?.message ?? dbError}`);
  }

  console.log(`[采集] 过滤后待裁决 ${exportComments.length} 条（重复内容${duplicateReplyCap > 0 ? `满 ${duplicateReplyCap} 条封顶` : "不封顶"}）`);

  // ── ④ 裁决（外部 judge 进程；浏览器保持打开，页面停在评论列表上）──
  startedAt = Date.now();
  await runJudge({ inPath: EXPORT_FILE, outPath: judgedPath, reportPath, maxReplies: replyBudget });
  timings.judgeMs = Date.now() - startedAt;

  const reportData = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  // 把「为什么没回」摊开讲清（2026-10-16 作者实测反馈：页面上看到 4 条未回复，
  // 却只回了 1 条，不明白剩下的去了哪 —— 其实是软拦截转人工 + 已回复过滤 + 运行范围三层原因，
  // 不在日志里写明就会被当成"发送环节漏发"）。stage 1 / stage 2 都展示。
  const notReplied = (reportData.decisions ?? []).filter((d) => d.action !== "reply");
  if (notReplied.length) {
    console.log(`[裁决] 本轮不自动回复 ${notReplied.length} 条，逐条原因：`);
    for (const d of notReplied.slice(0, 30)) {
      const text = String(d.commentText ?? "").replace(/\s+/g, " ").slice(0, 40);
      console.log(`  · 「${text}」— ${d.reason || d.action}`);
    }
    console.log("    （软拦截 = 拿不准转人工，请到创作者中心手动处理；其余作品上的未回复评论是否处理取决于本轮运行范围）");
  }

  const summary = {
    title: selectedWork.title,
    total: reportData.total,
    replied: reportData.replied,
    skipped: reportData.skipped,
    genMode: reportData.generation?.actualMode ?? "?",
    model: reportData.generation?.model ?? null,
    riskLayer: reportData.generation?.riskSemantic ?? "?",
    llmDirect: reportData.generation?.llmDirect ?? null,
    fallback: reportData.generation?.templateFallback ?? 0,
    costCny: reportData.llm?.estimatedCny ?? 0,
    judged: judgedPath,
    report: reportPath,
    timings,
  };

  // ── ⑤ 发送（stage 2；在**同一个页面**上继续，不重开会话、不重扫侧边栏）──
  if (args.stage === 2) {
    if (reportData.replied === 0) {
      console.log("[stage2] 本轮无待回复条目，跳过发送。");
      summary.replySummary = null;
      return summary;
    }

    startedAt = Date.now();
    const replySource = await tool.resultStore.loadReplyCommentsFile(judgedPath);
    let plans = replySource.plans ?? [];

    // 二次过滤（2026-10-16 新政策）：数据库/台账不再否决"是否回复过"——以创作者中心为准，
    // 页面「未回复」列表里的评论允许重试；这里只保留同一内容的 3 条上限。
    // 文案复用已在 judge 侧按 priorReplyMessage 完成，这里不再改写计划。
    try {
      const capCtx = buildReplyReuseContext(selectedWork.title);
      const before = plans.length;
      plans = plans.filter((plan) => {
        if (duplicateReplyCap === 0) return true;
        const hit = capCtx.get(normalizeCommentText(plan.commentText));
        return !(hit && hit.sentCount >= duplicateReplyCap);
      });
      if (plans.length < before) {
        console.log(`[上限] 跳过 ${before - plans.length} 条重复评论（同一内容已回复满 ${duplicateReplyCap} 条）`);
      }
    } catch (capError) {
      console.warn(`[上限] 重复封顶检查失败（继续使用全部计划）: ${capError?.message ?? capError}`);
    }

    if (plans.length === 0) {
      console.log("[stage2] 待回复计划在发送前已被过滤为空（都已被回复过），跳过发送。");
      summary.replySummary = null;
      return summary;
    }

    /**
     * ★ 发送上限 = 本轮计划数（2026-10-19 修）。
     *   原来这里写死 DEFAULT_REPLY_LIMIT = 20，而裁决层的「每次操作总上限」默认 30
     *   （C-21 的双层上限）—— 结果每轮固定有 10 条"判了要回、但发送阶段根本没尝试"，
     *   评论就永远躺在未回复里（实测 00:23 那轮：计划 30 → 实发 20 → unmatchedPlanCount=10）。
     *   现在的口径：**判多少发多少**；总量由上层两道闸（单轮总上限 / 单视频累计上限）控制，
     *   这里再兜一个物理上限，防止异常数据把浏览器拖死。
     */
    const replyLimit = Math.max(1, Math.min(plans.length, MAX_REPLY_LIMIT));
    if (plans.length > MAX_REPLY_LIMIT) {
      console.log(`[stage2] ⚠️ 计划 ${plans.length} 条超过单轮物理上限 ${MAX_REPLY_LIMIT}，只发前 ${MAX_REPLY_LIMIT} 条`);
    }
    const replyFlowTimeoutMs = resolveReplyFlowTimeout(replyLimit, plans.length);
    const replySummary = await tool.replyFlow.replyToComments(page, {
      deadline: null,
      maxRuntimeMs: 0,
      replyPlans: plans,
      selectedWork: targetWork,
      replyLimit,
      replyDryRun: Boolean(args["reply-dry-run"]),
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      replySettleMs: DEFAULT_REPLY_SETTLE_MS,
      replyTypeDelayMs: DEFAULT_REPLY_TYPE_DELAY_MS,
      timeoutMs: replyFlowTimeoutMs,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
      skipUnrepliedFilter: replySource.skipUnrepliedFilter,
      // ★ 以创作者中心为准：台账旧记录不得否决重试（重复上限由上层封顶 3 条）。
      //   并发安全不受影响：文件锁仍保证同一时刻只有一个进程能写入台账。
      allowReReply: true,
    });
    timings.replyMs = Date.now() - startedAt;

    await tool.resultStore.emitResult(
      {
        fetchedAt: new Date().toISOString(),
        mode: "reply_comments",
        pageUrl: tool.browser.DEFAULT_COMMENT_PAGE_URL,
        selectedWork,
        replyCommentsFile: judgedPath,
        replyDryRun: Boolean(args["reply-dry-run"]),
        replyLimit,
        ...replySummary,
      },
      REPLY_FILE,
    );

    // DB 记账：写入回复文案 + 对成功回复的评论递增 reply_count（去重的依据）
    try {
      tool.dbOps.upsertComments(
        selectedWork.title,
        plans.map((plan) => ({
          username: plan.username,
          commentText: plan.commentText,
          replyMessage: plan.replyMessage,
        })),
      );
    } catch (dbError) {
      console.warn(`[db] 写入回复失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }
    try {
      const planById = new Map(plans.map((p) => [p.id, p]));
      let updatedRows = 0;
      let missedRows = 0;
      for (const result of replySummary.results.filter((r) => r.status === "replied")) {
        const plan = result.replyPlanId != null ? planById.get(result.replyPlanId) : null;
        const username = plan?.username ?? result.username;
        const commentText = plan?.commentText ?? result.commentText;
        const changes = tool.dbOps.incrementReplyCount(selectedWork.title, username, commentText);
        if (changes > 0) updatedRows += 1;
        else missedRows += 1;
      }
      if (updatedRows > 0) console.log(`[db] 已更新 ${updatedRows} 条评论的回复计数`);
      if (missedRows > 0) {
        console.warn(
          `[db] 有 ${missedRows} 条成功回复未在库中匹配到行（reply_count 未增加），请核对作品标题与导出 plan 是否一致`,
        );
      }
    } catch (dbError) {
      console.warn(`[db] 更新回复计数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    summary.replySummary = replySummary;
    console.log(
      `[发送] 已发送 ${replySummary.repliedCount} 条` +
        (replySummary.sentUnconfirmedCount ? `（${replySummary.sentUnconfirmedCount} 条已点击未确认）` : "") +
        (replySummary.dryRunCount ? `（演练打字 ${replySummary.dryRunCount} 条）` : "") +
        (replySummary.skippedCount ? `，跳过 ${replySummary.skippedCount} 条` : "") +
        (replySummary.errorCount ? `，失败 ${replySummary.errorCount} 条` : "") +
        `（${seconds(timings.replyMs)}）`,
    );

    // 演练模式：把"本来会发出去的内容"逐条列出来。
    // 旧 CLI 靠"保持浏览器打开、按 Enter 关闭"让人肉检查；执行体直接调模块，没有那个交互，
    // 所以把现场搬到日志里 —— 在控制台就能核对每条回复，比盯着浏览器更实际。
    if (args["reply-dry-run"]) {
      const typed = replySummary.results.filter((r) => r.status === "dry_run_typed");
      if (typed.length) {
        console.log("\n[演练] 以下回复已在浏览器里键入（**未点发送**）：");
        for (const item of typed) {
          const plan = plans.find((p) => p.id === item.replyPlanId);
          console.log(`  · @${plan?.username ?? item.username ?? "?"}：「${item.requestedReplyMessage ?? ""}」`);
        }
      }
    }
  }

  return summary;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  // 先读重复上限：applyReuseAndCap 在采集后立刻要用，不能等到后面再读
  loadDuplicateReplyCap();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await loadTool();

  if (args.debug) tool.common.setReplyFilterDebugEnabled(true);

  // 采集边界开关：挂着回复线程（观众互聊）的「未回复」评论是否也处理。
  // 读 config/reply-rules.json 的 collection.allow_threaded_unreplied（控制台第 3 节可调）。
  // 缺省 true —— 2026-10-16 实测：平台「未回复」不管子回复，旧行为会把这类评论静默丢掉。
  let allowThreaded = true;
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "reply-rules.json"), "utf8"));
    if (rules?.collection?.allow_threaded_unreplied === false) allowThreaded = false;
  } catch {
    /* 读不到就用默认（允许），并在下面提示 */
  }
  tool.common.setAllowThreadedUnreplied(allowThreaded);
  console.log(
    `[采集] 有回复线程的未回复评论：${allowThreaded ? "也处理（去重由数据库+台账兜底）" : "跳过（旧行为）"}`,
  );

  console.log(`[会话] 启动浏览器（单会话执行：定位 → 采集 → 裁决${args.stage === 2 ? " → 发送" : ""}）${args.headless ? "（后台模式，不弹窗口）" : ""}…`);
  const sessionStartedAt = Date.now();
  const { context, page } = await tool.browser.launchPersistentPage({
    userDataDir: path.join(TOOL_DIR, ".playwright", "douyin-profile"),
    // ★ 后台模式（2026-10-16 作者要求：自动回复不该弹创作者中心窗口）。
    //   默认仍是可见窗口——出现问题（登录失效/验证码）时页面看得见、好排查；
    //   由控制台「后台运行」开关经 --headless 传进来。
    headless: Boolean(args.headless),
  });

  const timings = { bootMs: 0, listMs: 0, worksMs: 0 };
  const summaries = [];
  const failures = [];

  try {
    context.setDefaultTimeout(DEFAULT_UI_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(DEFAULT_UI_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);

    // 登录失效时快速失败并明确报错，而不是在没有 TTY 的子进程里等 Enter（会永久挂起）
    await tool.commentPage.ensureCommentPageReady(page, tool.browser.DEFAULT_COMMENT_PAGE_URL, {
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
      promptForLogin: false,
    });
    timings.bootMs = Date.now() - sessionStartedAt;
    console.log(`[会话] 就绪（${seconds(timings.bootMs)}）`);

    syncReplyLedgerFromDatabase();

    // ── 列表阶段（按需要拉：selected/latest 优先复用本地列表，见文件头"行为差异"）──
    const listStartedAt = Date.now();
    const { works, reason } = await resolveTargets(page);
    timings.listMs = Date.now() - listStartedAt;

    if (works.length === 0) {
      if (reason) {
        console.log(`\n[!] 本轮没有要处理的作品（运行范围：${reason}）。`);
        const sw = loadSwitch(PROJECT_DIR).sw;
        if (sw.mode === "selected") {
          console.log("    控制台里当前没有任何作品被勾选。");
          console.log("    → 双击 3-控制台.bat 去勾选作品，或把「运行范围」改成「只跑最新作品」。");
        }
      }
      return { summaries, failures, timings };
    }

    console.log(`\n[✓] 运行范围：${reason}`);
    console.log(`    待处理作品 ${works.length} 个：${works.map((w) => w.title).join(" / ")}`);

    // ── 逐作品：定位 → 采集 → 裁决 →（stage2）发送（全程同一个浏览器会话）──
    // ★ C-21 双层回复上限：runCap = 本次操作总上限（跨作品累计）；workCapTotal = 单视频累计上限。
    //   每个作品开工前折算预算 = min(单轮剩余, 视频累计剩余)，交给裁决层封顶；
    //   单轮预算耗尽直接停止整轮，视频累计耗尽只跳过该视频。
    const caps = readFrequencyCaps();
    let runSentTotal = 0;
    if (caps.runCap > 0 || caps.workCapTotal > 0) {
      console.log(
        `[上限] 本次操作总上限 ${caps.runCap > 0 ? `${caps.runCap} 条` : "不限"}` +
          `｜单视频累计上限 ${caps.workCapTotal > 0 ? `${caps.workCapTotal} 条` : "不限"}`,
      );
    }
    for (const [index, work] of works.entries()) {
      const label = `作品 ${index + 1}/${works.length}「${work.title}」`;

      const runRemaining = caps.runCap > 0 ? caps.runCap - runSentTotal : Number.POSITIVE_INFINITY;
      if (runRemaining <= 0) {
        console.log(`\n[上限] 本次操作总上限 ${caps.runCap} 条已到（本轮已发 ${runSentTotal} 条）→ 停止处理剩余作品`);
        break;
      }
      const workCumulative = workRepliedTotal(work.title);
      const workRemaining =
        caps.workCapTotal > 0 ? caps.workCapTotal - workCumulative : Number.POSITIVE_INFINITY;
      if (workRemaining <= 0) {
        console.log(
          `\n[上限] 视频《${work.title}》累计已回复 ${workCumulative} 条 ≥ 上限 ${caps.workCapTotal} → 跳过该视频`,
        );
        continue;
      }
      const replyBudget = Math.min(runRemaining, workRemaining);

      const workStartedAt = Date.now();
      try {
        const summary = await processWork(page, work, index, works.length, { replyBudget });
        summary.totalMs = Date.now() - workStartedAt;
        summaries.push(summary);
        // 本轮已发数：按"确认发送成功 + 已点击未确认"计——这两类都动了发送按钮，要占预算
        runSentTotal +=
          (summary.replySummary?.repliedCount ?? 0) + (summary.replySummary?.sentUnconfirmedCount ?? 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ title: work.title, message });
        console.log(`\n[✗] ${label} 处理失败，已跳过，继续下一个：${message.split("\n")[0]}`);
      }
    }
    if (caps.runCap > 0) {
      console.log(`\n[上限] 本次操作共发送 ${runSentTotal} 条（上限 ${caps.runCap} 条）`);
    }

    return { summaries, failures, timings };
  } finally {
    await context.close().catch(() => {});
  }
}

main()
  .then(({ summaries, failures, timings }) => {
    if (!summaries.length && !failures.length) return;

    console.log("\n================ 本轮汇总 ================");
    let totalCost = 0;
    for (const row of summaries) {
      console.log(`· ${row.title}：共 ${row.total} 条 → 拟回复 ${row.replied} / 留空 ${row.skipped}`);
      console.log(
        `  生成=${row.genMode}${row.model ? `（${row.model}）` : ""}｜风险=${row.riskLayer}｜LLM 直出 ${row.llmDirect ?? "?"} 条｜回退模板 ${row.fallback} 条｜估算费用 ≈ ¥${row.costCny}`,
      );
      if (row.replySummary) {
        const r = row.replySummary;
        console.log(
          `  发送：成功 ${r.repliedCount}｜未确认 ${r.sentUnconfirmedCount}｜跳过 ${r.skippedCount}｜失败 ${r.errorCount}｜未匹配计划 ${r.unmatchedPlanCount}`,
        );
      }
      const t = row.timings ?? {};
      console.log(
        `  耗时：定位 ${seconds(t.locateMs ?? 0)}｜采集 ${seconds(t.collectMs ?? 0)}｜裁决 ${seconds(t.judgeMs ?? 0)}` +
          (t.replyMs != null ? `｜发送 ${seconds(t.replyMs)}` : "") +
          `｜小计 ${seconds(row.totalMs ?? 0)}`,
      );
      console.log(`  裁决：${row.judged}`);
      console.log(`  报告：${row.report}`);
      totalCost += Number(row.costCny) || 0;
    }
    if (summaries.length > 1) console.log(`\n本轮合计估算费用 ≈ ¥${totalCost.toFixed(4)}（以官方账单为准）`);

    console.log(
      `\n[耗时] 会话启动+导航 ${seconds(timings.bootMs)}｜列表 ${seconds(timings.listMs)}｜` +
        `处理 ${seconds(summaries.reduce((sum, row) => sum + (row.totalMs ?? 0), 0))}｜` +
        `本进程合计 ${seconds(Date.now() - t0)}`,
    );

    if (failures.length) {
      console.log(`\n⚠️ 有 ${failures.length} 个作品处理失败（已跳过，其余作品不受影响）：`);
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
      // 收尾语必须反映"到底发没发"：本轮零发送时不许说"已发送"（C-11 的教训：产物措辞要能对上账）
      const sentTotal = summaries.reduce(
        (sum, row) => sum + (row.replySummary?.repliedCount ?? 0) + (row.replySummary?.sentUnconfirmedCount ?? 0),
        0,
      );
      if (sentTotal > 0) {
        console.log(
          "\n[stage 2 已发送] 发送结果见 tool/comments-output/reply-comments-result.json 与 reply-ledger.jsonl。",
        );
      } else {
        console.log(
          "\n[stage 2 未发送] 本轮没有需要发送的回复（无待回复条目，或计划在发送前已被过滤）。",
        );
      }
    }

    // 有失败就不能报"正常结束"：上层（控制台）按退出码分叉提示
    if (failures.length) process.exitCode = 1;
  })
  .catch(async (error) => {
    console.error(`\n运行中断：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
