#!/usr/bin/env node
/**
 * ui-server.mjs — 本地控制台服务
 *
 * 用途：一个只在**本机**打开的网页，用来设置「哪些作品开自动回复」「机器人人设」
 *      「回复规则」，并当场试跑一条评论看效果。
 *
 * 安全边界（重要，别改）：
 *   · 只 bind 127.0.0.1 —— 不对外网开放，同事/局域网都访问不到。
 *   · 只读写项目内的 config/ 与 state/，不做任何文件系统浏览。
 *   · **绝不把 API key 明文吐给页面**，只给脱敏指纹与"是否已配置"。
 *   · 写操作要求 application/json + 同源校验，挡掉恶意网页用表单偷偷改配置。
 *   · 路径规范化后必须落在 ui/ 目录内，防目录穿越。
 *
 * 为什么需要它：配置散在 5 个 JSON 里（reply-rules / persona / works-switch / templates /
 * secrets），手改容易改错、也看不出"改了到底生效没有"。这个页面把「配置」和
 * 「预览真实效果」放在一起，改完立刻能验证 —— 这是本项目最缺的一环。
 *
 * 启动：node scripts/ui-server.mjs [--port 5190] [--no-open]
 *      端口默认读 config/instance.json 的 port（本副本固定 5190），
 *      --port 仅用于临时排查实例（被占会顺延）。
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { maskKey, readSecrets } from "./llm-deepseek.mjs";
import { apiKeyStatus, clearApiKey, validateApiKey, verifyApiKey, writeApiKey } from "./api-key-store.mjs";
import {
  DEFAULT_PERSONA,
  personaVoiceFingerprint,
  validatePersonaForSave,
} from "./persona.mjs";
import {
  MAX_PERSONAS,
  NAME_MAX,
  PERSONAS_REL_PATH,
  TAGLINE_MAX,
  deletePersona,
  duplicatePersona,
  loadPersonaLibrary,
  upsertPersona,
} from "./persona-store.mjs";
import { DESCRIPTION_MAX, generatePersonaDraft } from "./persona-ai.mjs";
import {
  loadAuto,
  saveAuto,
  isWithinSchedule,
  msUntilScheduleOpen,
  normalizeTime,
  SCHEDULE_DEFAULT,
  AUTO_INTERVAL_DEFAULT,
  AUTO_INTERVAL_MAX,
  AUTO_INTERVAL_MIN,
} from "./auto-mode.mjs";
import { loadRotation, saveRotation } from "./persona-rotation.mjs";
import { loadCooperationInbox, markCooperationDone, removeCooperation } from "./cooperation.mjs";
import { describePolicy, loadRiskPolicy, routeFor } from "./risk-policy.mjs";
import { describeRiskReplies, loadRiskReplies, saveRiskReplies } from "./risk-replies.mjs";
import {
  describeRiskPersonas,
  describeRouting,
  joinRiskPool,
  purgePersonaFromRisk,
  revokeRiskReplies,
  saveRiskRouting,
} from "./risk-personas.mjs";
import { generateRolePools } from "./risk-replies-ai.mjs";
import { describeNoReplyRules, normalizeRules as normalizeNoReplyRules, NO_REPLY_CFG_KEY } from "./no-reply-rules.mjs";
import { generateNoReplyRule } from "./no-reply-rules-ai.mjs";
import { clearSkipCache, skipCacheStats } from "./skip-cache.mjs";
import {
  appendRoundStat,
  consecutiveFailures,
  summarize as summarizeRoundStats,
  summarizeReportsSince,
} from "./round-stats.mjs";
import {
  loadSwitch,
  resolveEnabled,
  saveSwitch,
  SWITCH_MODES,
  workKey,
} from "./works-switch.mjs";
import {
  getWorkContext,
  loadContext,
  NOTE_MAX,
  saveContext,
} from "./work-context.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const UI_DIR = path.join(PROJECT_DIR, "ui");
const TOOL_DIR = path.join(PROJECT_DIR, "tool");
const OUT_DIR = path.join(TOOL_DIR, "comments-output");
const RULES_PATH = path.join(PROJECT_DIR, "config", "reply-rules.json");
/** C-43：固定话术池，第 3 节「查看模板」直接读它（只读，不在这一节改文案） */
const TEMPLATES_PATH = path.join(PROJECT_DIR, "config", "templates.json");
const LOG_DIR = path.join(PROJECT_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "ui-server.log");

const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
/**
 * ★ 实例配置（2026-10-19）：config/instance.json 是「这个副本是谁」的唯一来源。
 *   name  → 黑窗口标题 / 浏览器标签 / 页面大标题
 *   port  → 这个副本固定监听的端口
 *   读不到或字段非法都不影响启动，退回默认值。
 */
const INSTANCE_CFG = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "config", "instance.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
})();

/**
 * 端口优先级：--port 显式指定 > config/instance.json 的 port > 5190。
 *
 * ★ 2026-10-19 改：原先默认 5180，机器上同时跑两份副本就会撞车 —— 谁先启动谁占 5180，
 *   另一个顺延到 5181，于是「控制台到底在哪个地址」每天都不一样，用户每次都得猜。
 *   现在默认固定 5190，同一台机器上的其它副本各配一个端口，地址都稳定，可以同时开。
 *   留 --port 是为了自测和临时排查实例，行为与以前一致（被占就顺延）。
 */
const ARG_PORT = Number(argVal("port"));
const CFG_PORT = Number(INSTANCE_CFG.port);
const BASE_PORT = Number.isFinite(ARG_PORT)
  ? ARG_PORT
  : Number.isFinite(CFG_PORT) && CFG_PORT > 0
    ? CFG_PORT
    : 5190;
/**
 * 端口是不是「写死在 instance.json 里」的。
 * 是 → 被**别的项目**占用时不再静默顺延（否则地址又变了，违背固定的意义），
 *      而是明确报错，让用户去关掉占用者。
 * 否（--port 临时实例）→ 保持原来的顺延行为。
 */
const PORT_PINNED = !Number.isFinite(ARG_PORT) && Number.isFinite(CFG_PORT) && CFG_PORT > 0;
const NO_OPEN = argv.includes("--no-open");

/**
 * ★ 控制台版本号：每次改动 ui-server.mjs 的**接口/行为**时必须同步改这里。
 *
 * 为什么需要（2026-10-16 实测踩到）：页面文件是每次请求从磁盘现读的，而接口路由
 * 在进程内存里 —— 端口上若挂着一个**旧进程**，浏览器拿到的是新页面、打到的却是
 * 旧接口，点保存就报「未知接口」；更糟的是实例探测只认 app 标识不认版本，
 * 新实例发现端口被占会把浏览器指到旧进程上，旧进程永远无法被自然替换。
 * 有版本号后，探测发现新旧不一致就明确报错并拒绝指过去，逼着用户关旧窗口。
 */
const CONSOLE_VERSION = "c60";

/**
 * ★ C-41（2026-10-19 作者要求）：把「哪些评论不回复」和「风险评论怎么处理」合成一张表。
 *
 * 原先是两处：第 3 节勾五个"不回"的类别，第 8 节一张只读表说"剩下的都回"。
 * 两处各管一半，看的时候要在两个区块之间来回对照，容易误判某类到底回不回。
 * 现在第 3 节一张表列全 15 类，每类二选一：**不回复** / **模板回复**（固定话术），
 * 第 8 节只剩「谁来回复」（风险人设库）和缓存。
 *
 * ★ C-42（2026-10-19 作者改判）：政治敏感、涉及未成年人**也放开**成二选一。
 *   原先 C-41 把这两类锁死为"只能不回复"（页面点不到 + 接口拒收 + 判定层硬兜底），
 *   现在三道锁全部拆掉：页面可选、接口可写、判定层不再覆盖。
 *   保留的只有默认值 —— 这两类默认仍是「不回复」，不主动点不会变。
 *
 * 顺序 = 页面顺序：按"最该谨慎 → 最不敏感"往下排，兜底类放最后。
 * 注意这些 key 必须与 config/risk-policy.json 的 routes 对应，别自己造词。
 */
/**
 * 处置只有三种（2026-10-20 作者定）：不回复 / 用模板 / 正常回复。
 * 除了「合作待办」要人亲自谈，其余每条评论最后一定落在这三种之一 —— 没有「转人工」这个第四态。
 */
const HANDLING_ACTIONS = new Set(["skip", "template", "reply"]);

const HANDLING_TYPES = [
  { key: "political", label: "政治敏感", note: "时政、主权、历史事件这类内容。默认不回复；改成「模板回复」也只是用固定话术打岔，不会顺着说。台湾/台海/两岸按弱词处理（只打岔、不判死）；台湾腔、台湾小吃这类日常说法已豁免。" },
  {
    key: "minors",
    label: "涉及未成年人",
    note: "涉及未成年人的自动互动是平台最敏感的一类。默认不回复；改成「模板回复」同样只用固定话术打岔。",
  },
  { key: "sticker", label: "无法识别的纯图片、纯表情评论" },
  { key: "porn", label: "色情露骨" },
  { key: "violence", label: "血腥暴力" },
  { key: "platform", label: "平台内容红线（赌博 / 毒品 / 医美疗效 / 荐股收益）" },
  { key: "personal", label: "要创作者本人才知道的事（订单 / 物流 / 参数 / 售后）" },
  { key: "credential", label: "索要账号 / 密码 / 密钥" },
  { key: "contact", label: "留联系方式 / 站外引导" },
  { key: "abuse", label: "辱骂 / 威胁" },
  { key: "legal", label: "法务 / 投诉 / 维权" },
  { key: "refund", label: "退款 / 退货 / 消费质疑" },
  { key: "bargain", label: "砍价 / 优惠 / 竞品对比" },
  { key: "injection", label: "提示词注入（让我忽略规则的留言）" },
  { key: "other", label: "其他不确定（兜底）" },
];

/**
 * ★ C-43：反向关键词的硬限制。
 *   最短 2 字：单字（「的」「你」）会把整类都放行，等于把开关关掉。
 *   最多 20 字、每类 40 条：再多就不是"个别例外"，该改词表了。
 */
const ALLOW_KEYWORD_MIN = 2;
const ALLOW_KEYWORD_MAX = 20;
const ALLOW_KEYWORD_MAX_COUNT = 40;

/**
 * ★ C-47：通用兜底话术（config/templates.json 的 templates[pool]）的硬限制。
 *   单条 60 字：这话术是「模板回复」直接发出去的，抖音评论一条就这么长，
 *   而且风险类模板本来就不该长篇大论（越长越容易被判成在讲道理）。
 *   最多 200 条：实际每池 10 条，超过就说明该拆池了。
 */
const POOL_LINE_MAX = 60;
const POOL_LINE_MAX_COUNT = 200;

/**
 * ★ 实例显示名（2026-10-19）：一台机器上会同时跑多个项目副本，
 *   每个副本都叫「抖音评论自动回复」的话，黑窗口和浏览器标签根本分不清谁是谁。
 *   读 config/instance.json 的 name；读不到就退回通用名，不影响启动。
 *   只影响显示，不参与任何判定。
 */
const INSTANCE_NAME = (() => {
  const name = String(INSTANCE_CFG?.name ?? "").trim();
  return name || "抖音评论自动回复";
})();

/** 等宽终端里中文占两列，用它算框内留白，否则 ║ 会歪 */
const BOX_INNER = 50;
function boxLine(text) {
  const width = [...text].reduce((n, ch) => n + (/[\u1100-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1), 0);
  return `  ║${text}${" ".repeat(Math.max(0, BOX_INNER - width))}║`;
}

/** 日志只记路径与动作，**绝不记密钥** */
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/* ---------------- 状态探测（只读，全部用于页面顶部的"能不能跑"） ---------------- */

function detectLogin() {
  const cookieFile = path.join(PROJECT_DIR, "tool", ".playwright", "douyin-profile", "Default", "Network", "Cookies");
  if (!fs.existsSync(cookieFile)) return { ok: false, detail: "未找到登录态存档" };
  try {
    const raw = fs.readFileSync(cookieFile).toString("latin1");
    const hasSession = /sessionid/.test(raw);
    const hasDouyin = /douyin\.com/.test(raw);
    const mtime = fs.statSync(cookieFile).mtime;
    if (hasSession && hasDouyin) {
      // 用本地时间显示：原来直接 slice(toISOString()) 是 UTC，作者看到的是"早上 6:56"（实际 14:56）
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`;
      return { ok: true, detail: `存档于 ${stamp}` };
    }
    return { ok: false, detail: "存档里没有抖音登录 Cookie（可能扫码未完成）" };
  } catch (error) {
    return { ok: false, detail: `读取登录态失败：${error.message}` };
  }
}

function detectBrowser() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const cacheDir = path.join(local, "ms-playwright");
  if (!fs.existsSync(cacheDir)) return { ok: false, detail: "尚未安装浏览器内核" };
  const dirs = fs.readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d));
  for (const d of dirs) {
    const exe = path.join(cacheDir, d, "chrome-win64", "chrome.exe");
    if (fs.existsSync(exe)) return { ok: true, detail: `${d} / chrome.exe 已就位` };
  }
  return { ok: false, detail: "内核目录存在但可执行文件缺失" };
}

function detectLastRun() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const reports = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^judge-report-.*\.json$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(OUT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!reports.length) return null;
  const { f, mtime } = reports[0];
  const data = readJsonSafe(path.join(OUT_DIR, f));
  return {
    file: f,
    at: mtime.toISOString(),
    total: data?.total ?? null,
    replied: data?.replied ?? null,
    skipped: data?.skipped ?? null,
    genMode: data?.generation?.actualMode ?? null,
    model: data?.generation?.model ?? null,
    costCny: data?.llm?.estimatedCny ?? null,
    /**
     * 逐条判定结果（C-29）。作者反复问"这还有好多没回是怎么回事"，
     * 原因其实都在这里 —— 直接带给页面，省得每次去翻 JSON。
     * 只带展示需要的字段，最多 40 条（单轮上限就 30 条上下，够用）。
     */
    decisions: Array.isArray(data?.decisions)
      ? data.decisions.slice(0, 40).map((d) => ({
          username: String(d.username ?? ""),
          text: String(d.commentText ?? "").slice(0, 60),
          action: String(d.action ?? ""),
          reason: String(d.reason ?? "").slice(0, 80),
          category: d.category ?? null,
          level: d.level ?? null,
        }))
      : [],
  };
}

/**
 * 今天到底回了多少条 —— 以 `reply-ledger.jsonl` 为准（C-29）。
 *
 * 为什么不直接用 round-stats 里的 replied：那是"从加了这个统计之后"才开始记的，
 * 之前发出去的几百条不在里面，页面会显示"今天回了 0 条"，显然不对。
 * 台账是 append-only 且从第一轮就在写，按 key 去重后就是真实条数（重试同一条不会算两次）。
 */
function countRepliesToday(now = new Date()) {
  const file = path.join(OUT_DIR, "reply-ledger.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = stamp(now);
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const at = j.recordedAt || j.at;
    if (!at) continue;
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || stamp(d) !== today) continue;
    seen.add(j.key || `${j.workTitle}|${j.username}|${j.commentText}`);
  }
  return seen.size;
}

/**
 * 第 3 节那张表的数据：每类现在怎么处理（不回复 / 模板回复）。
 * 数据源是 config/risk-policy.json —— 页面不另存一份，改它就是改真实行为。
 * 15 类一律如实回报配置里的 action，没有任何类别被覆盖（C-42 起）。
 */
function describeNoReplyTypes() {
  let policy = null;
  try {
    policy = loadRiskPolicy(PROJECT_DIR);
  } catch (error) {
    log(`不回复类型读取失败（按全部不回兜底）：${error.message}`);
  }
  /**
   * C-43：这一节要能「打开看模板」，所以顺手把话术一起下发。
   * 取两套，因为实际用哪套取决于风险人设库有没有在岗人设：
   *   · personaTemplates —— 风险人设库在岗人设 × 该类别对应的话术组（真跑优先用这套）
   *   · templates        —— config/templates.json 的通用池（没有在岗人设时兜底）
   */
  let templates = {};
  try {
    templates = readJsonSafe(TEMPLATES_PATH)?.templates ?? {};
  } catch {
    templates = {};
  }
  let riskView = null;
  try {
    riskView = describeRiskReplies(loadRiskReplies(PROJECT_DIR));
  } catch {
    riskView = null;
  }

  return HANDLING_TYPES.map((t) => {
    let route = null;
    try {
      route = policy ? routeFor(t.key, policy) : null;
    } catch {
      route = null;
    }
    const pool = route?.pool || "deflect";
    // 风险话术按「类别 → 话术组」映射（dodge / tease / retort / unclear）
    // ★ 兜底同样是 unclear 不是 dodge：dodge 是买卖场景，只给砍价/退款用（2026-10-19）
    const group = riskView?.groups?.[t.key] ?? "unclear";
    const personaTemplates = (riskView?.roles ?? [])
      .filter((r) => r.active !== false)
      .map((r) => ({
        name: r.name,
        percent: r.percent,
        lines: Array.isArray(r.pools?.[group]) ? [...r.pools[group]] : [],
      }))
      .filter((r) => r.lines.length);

    return {
      key: t.key,
      label: route?.label || t.label,
      // 读不到策略时按「不回复」兜底：保守方向是少回，不是把敏感评论回出去
      /** 三值：skip 不回复 / template 用模板 / reply 正常回复（2026-10-20） */
      action: route ? route.action : "skip",
      /** 兼容旧页面：勾「不回复」等价于 action === "skip" */
      enabled: route ? route.action === "skip" : true,
      note: t.note || route?.note || "",
      /** C-43：反向关键词（命中即认为这一类可以回） */
      allow: Array.isArray(policy?.signals?.[t.key]?.allow) ? [...policy.signals[t.key].allow] : [],
      /** C-43：模板查看用 */
      pool,
      templates: Array.isArray(templates?.[pool]) ? [...templates[pool]] : [],
      personaTemplates,
    };
  });
}

function buildState() {
  const secrets = readSecrets(PROJECT_DIR);
  const personaLib = loadPersonaLibrary(PROJECT_DIR);
  const switchLoad = loadSwitch(PROJECT_DIR);
  const ctxLoad = loadContext(PROJECT_DIR);
  const rules = readJsonSafe(RULES_PATH) ?? {};
  const modelCache = readJsonSafe(path.join(PROJECT_DIR, "state", "model-cache.json"));
  const worksRaw = readJsonSafe(path.join(OUT_DIR, "list-works.json"))?.works ?? [];

  const maxChars = Number(rules.reply_length?.max_chars ?? 60);
  const hardCap = Number(rules.reply_length?.hard_cap ?? 400);

  // 按发布时间倒序展示（跟创作者中心里的直觉一致），并标注"最新"
  const works = worksRaw
    .map((w, i) => {
      const key = workKey(w);
      const resolved = resolveEnabled(switchLoad.sw, w, worksRaw);
      const ctxHit = getWorkContext(ctxLoad.ctx, w, worksRaw);
      return {
        key,
        title: String(w.title ?? ""),
        publishText: String(w.publishText ?? ""),
        enabled: resolved.enabled,
        matchedBy: resolved.matchedBy,
        originalIndex: i,
        /** 控制台里填的"这条视频在玩什么梗"。空串 = 没填过 */
        contextNote: ctxHit?.note ?? "",
      };
    })
    .sort((a, b) => {
      const ta = Date.parse((a.publishText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/) ?? [""])[0].replace(/年|月/g, "-").replace("日", " ")) || 0;
      const tb = Date.parse((b.publishText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/) ?? [""])[0].replace(/年|月/g, "-").replace("日", " ")) || 0;
      return tb - ta;
    });
  if (works.length) works[0].isLatest = true;

  return {
    ok: true,
    /** 固定标识：供"启动时探测端口上是否已有本控制台"用，勿改 */
    app: "douyin-console",
    /** 控制台版本：探测时用于识别端口上的旧版进程（页面新、接口旧 → 「未知接口」） */
    version: CONSOLE_VERSION,
    /** 实例显示名（config/instance.json），页面标签与大标题用它区分副本 */
    instanceName: INSTANCE_NAME,
    projectDir: PROJECT_DIR,
    status: {
      key: secrets.apiKey
        ? { ok: true, detail: `已配置（${maskKey(secrets.apiKey)}）`, source: secrets.keySource }
        : secrets.placeholderSource
          ? { ok: false, detail: `读到的只是模板占位值（${secrets.placeholderSource}）` }
          : { ok: false, detail: "未配置 API key" },
      login: detectLogin(),
      browser: detectBrowser(),
      model: modelCache?.model ? { ok: true, detail: modelCache.model } : { ok: false, detail: "尚未探测（跑一次即会写入）" },
    },
    /**
     * 密钥编辑面板用（2026-10-17）：只回「配置没配置 / 脱敏串 / 从哪来 / 写到哪」。
     * **原文绝不出现在这里** —— 页面拿不到 key，也就不可能被前端脚本读走。
     */
    apiKey: apiKeyStatus(PROJECT_DIR),
    scope: { mode: switchLoad.sw.mode, options: SWITCH_MODES, fileError: switchLoad.error },
    works,
    worksCount: works.length,
    /**
     * 人设库（config/personas.json）：items 里每项都能编辑/删除/复制，
     * 页面第 2 节直接渲染成卡片。这里连 persona 本体一起回传 ——
     * 复制一套人设时页面不用再请求一次。
     */
    personas: {
      items: personaLib.items.map((item) => ({
        id: item.id,
        name: item.name,
        tagline: item.tagline,
        builtin: item.builtin,
        updatedAt: item.updatedAt,
        persona: item.persona,
      })),
      file: PERSONAS_REL_PATH,
      error: personaLib.error,
      /** 每套人设的话术同步状态（页面保存后轮询它显示"生成中/已生成"） */
      roleSync: Object.fromEntries([...roleSync.entries()]),
      max: MAX_PERSONAS,
      nameMax: NAME_MAX,
      taglineMax: TAGLINE_MAX,
      descriptionMax: DESCRIPTION_MAX,
    },
    /**
     * 风险人设库：由「人设库 × 风险话术」派生，不存第三份状态。
     * ready = 有话术（可能没勾负责）；pending = 未生成话术；pool = 真正参与抽选的。
     */
    riskPersonas: describeRiskPersonas(PROJECT_DIR, { personaLib }),
    personaDefaults: DEFAULT_PERSONA,
    /** 多套人设模式：固定一套 / 随机切换（judge 逐条解析，同一条评论固定同一套） */
    rotation: (() => {
      const load = loadRotation(PROJECT_DIR, { validIds: personaLib.items.map((item) => item.id) });
      return {
        mode: load.rotation.mode,
        single: load.rotation.single,
        pool: load.rotation.pool,
        options: personaLib.items.map((item) => ({ id: item.id, name: item.name })),
        fileError: load.error,
      };
    })(),
    workContext: {
      noteMax: NOTE_MAX,
      fileError: ctxLoad.error,
      filledCount: Object.keys(ctxLoad.ctx.works).length,
    },
    rules: {
      maxChars,
      hardCap,
      effectiveMax: Math.min(maxChars, hardCap),
      minChars: Number(rules.reply_length?.min_chars ?? 4),
      maxRepliesPerRun: Number(rules.frequency?.max_replies_per_run ?? 30),
      /** 单视频累计回复上限（跨所有轮次）；0 = 不限（C-21） */
      maxRepliesPerWorkTotal: Number(rules.frequency?.max_replies_per_work_total ?? 0),
      policy: {
        reply_to_question: rules.policy?.reply_to_question !== false,
        reply_to_praise: rules.policy?.reply_to_praise !== false,
        reply_to_thanks: rules.policy?.reply_to_thanks !== false,
        reply_to_neutral: rules.policy?.reply_to_neutral !== false,
        reply_to_trivial: rules.policy?.reply_to_trivial === true,
        // ★ 2026-10-16 实测踩到：这两个键是 C-14/C-15 新加的类别开关，页面有渲染、
        //   保存也能写进文件，但这里**漏了回传** → 保存后重新渲染时读不到值 → 永远显示未勾选
        //   （作者报"勾选保存后立马就消失"）。新增类别开关时必须同步加到这里，
        //   自测「页面类别开关 vs 服务端回传」的集合比对会拦住遗漏。
        reply_to_negative: rules.policy?.reply_to_negative !== false,
        reply_to_emotion: rules.policy?.reply_to_emotion !== false,
      },
      style: rules.generation?.style ?? "",
      /** 采集边界：挂着回复线程的「未回复」评论是否也处理（run-session 读取） */
      allowThreaded: rules.collection?.allow_threaded_unreplied !== false,
      /** 同一内容的评论最多回几条；0 = 不限（run-session 读取，C-25） */
      duplicateReplyCap: Number(rules.collection?.duplicate_reply_cap ?? 0),
      /** C-38：自定义「不回复」规则（AI 生成关键词，运行时零成本匹配） */
      noReply: describeNoReplyRules(rules),
      /** C-39：第 3 节「不回复哪些评论」五类，勾选状态直接来自 risk-policy.json */
      noReplyTypes: describeNoReplyTypes(),
    },
    lastRun: detectLastRun(),
    /**
     * 今日概览（C-29）：今天跑了几轮、回了几条、花了多少钱。
     * 数据来自 state/round-stats.jsonl（每轮追加一行）；裁决报告是覆盖写的，
     * 没有这一层"上周花了多少"就永远查不回来。
     */
    today: (() => {
      try {
        const s = summarizeRoundStats(PROJECT_DIR);
        return { ...s, ledgerReplied: countRepliesToday() };
      } catch (error) {
        return { today: null, recent: [], totalRounds: 0, ledgerReplied: 0, error: error.message };
      }
    })(),
    /** 挂机健康度：连续几轮异常退出（≥2 页面要显眼提示，人不在也能发现） */
    alerts: (() => {
      try {
        const fails = consecutiveFailures(PROJECT_DIR);
        return { consecutiveFailures: fails, needsAttention: fails >= 2 };
      } catch {
        return { consecutiveFailures: 0, needsAttention: false };
      }
    })(),
    /** 合作待办（state/cooperation-inbox.jsonl 按 id 聚合，未处理在前） */
    cooperation: (() => {
      try {
        return loadCooperationInbox(PROJECT_DIR);
      } catch (error) {
        return { items: [], total: 0, newCount: 0, error: `合作待办读取失败：${error.message}` };
      }
    })(),
    /** 自动回复模式的当前状态（开关/间隔/上下次运行时间） */
    auto: autoSnapshot(),
    /**
     * 风险处置策略（C-26）：哪类不回、哪类用哪个话术池回，以及「已判定不回」缓存现状。
     * 缓存条数会直接决定下一轮要花多少钱 —— 所以要让作者在页面上一眼看到。
     */
    riskPolicy: (() => {
      try {
        const policy = loadRiskPolicy(PROJECT_DIR);
        return {
          file: policy.file,
          error: policy.error,
          routes: describePolicy(policy),
          /** 话术角色池：喵娘 50 / 御姐 30 / 古风 10 / 皇帝 10 */
          replies: describeRiskReplies(loadRiskReplies(PROJECT_DIR)),
          cache: { ...skipCacheStats(PROJECT_DIR), enabled: policy.cache.enabled, maxAgeDays: policy.cache.maxAgeDays },
        };
      } catch (error) {
        return { error: `风险策略读取失败：${error.message}`, routes: [], cache: null };
      }
    })(),
  };
}

/* ---------------- 人设库（C-23）---------------- */

/** 当前生效的回复字数上限（人设签名/示例的长度校验要用同一把尺） */
function personaEffectiveMax() {
  const rules = readJsonSafe(RULES_PATH) ?? {};
  return Math.min(
    Number(rules.reply_length?.max_chars ?? 60),
    Number(rules.reply_length?.hard_cap ?? 400),
  );
}

/** 回传给页面的瘦身人设（现在与存储同形，单独留一层是为了以后加字段不改页面契约） */
function publicPersona(item) {
  return {
    id: item.id,
    name: item.name,
    tagline: item.tagline,
    builtin: item.builtin === true,
    updatedAt: item.updatedAt,
    persona: item.persona,
  };
}

/**
 * 人设变动后修复「固定一套 / 随机池」的引用。
 * 原理：loadRotation 带 validIds 会把失效 id 剔掉，single 回退到库里第一套；
 * 这里再落盘一次，保证磁盘上的 rotation 与库里的人设一致（页面刷新即见）。
 */
function repairRotation(items) {
  const validIds = items.map((item) => item.id);
  const load = loadRotation(PROJECT_DIR, { validIds });
  const saved = saveRotation(PROJECT_DIR, load.rotation);
  return {
    mode: saved.rotation.mode,
    single: saved.rotation.single,
    pool: saved.rotation.pool,
    options: items.map((item) => ({ id: item.id, name: item.name })),
    fileError: load.error,
  };
}

/** AI 生成中的互斥标记：两个人同时点「生成」会写出两套重复人设，也会白烧两份钱 */
let personaGenerating = false;

/**
 * 人设话术同步状态（C-35）：人设保存后**后台**补/更新它的专属风险话术。
 * status: generating / done / error / skipped（指纹没变，不用重生成）。
 * 为什么放后台：生成要调一次模型（20–60 秒），不能让"保存人设"卡在那儿转圈。
 */
const roleSync = new Map();

/**
 * 人设保存后自动同步话术。
 * 判定依据是**声音指纹**（见 persona.mjs）：口吻没变就不重新生成，不白花钱。
 * 用独立 spawn，不占用 runState 的任务锁 —— 生成话术时照样能点「跑一轮」。
 */
function ensurePersonaRoleSync(item, source = "保存人设") {
  if (!item?.id) return;
  try {
    const roles = loadRiskReplies(PROJECT_DIR).roles;
    const bound = roles.find((r) => r.personaId === item.id || r.id === item.id);
    const fingerprint = personaVoiceFingerprint(item.persona);
    /**
     * ★ 2026-10-19（风险人设库）：**不再自动给没生成过的人设补话术**。
     *   作者要的是「选择是否生成」—— 没生成的人必须停在「未生成话术」板里，
     *   等他自己点按钮（生成要花钱，不能因为改了个人设就偷偷扣钱）。
     *   但已经生成过的，口吻变了就后台重生成：旧话术配新口吻等于串人格。
     */
    if (!bound) {
      roleSync.set(item.id, {
        status: "pending",
        at: new Date().toISOString(),
        message: "还没生成风险话术（到第 8 节「风险人设库」点生成）",
      });
      log(`人设话术：「${item.name}」还没有风险话术，等你在风险人设库里手动生成`);
      return;
    }
    if (bound.personaFingerprint === fingerprint) {
      roleSync.set(item.id, { status: "skipped", at: new Date().toISOString(), message: "话术已是最新" });
      log(`人设话术：「${item.name}」口吻没变，跳过重新生成`);
      return;
    }
    startRoleGeneration(item, { source: `${source}后口吻变了，自动更新` });
  } catch (error) {
    roleSync.set(item.id, { status: "error", at: new Date().toISOString(), message: error.message });
    log(`人设话术：同步失败：${error.message}`);
  }
}

/**
 * 真正去生成话术（后台子进程，不占任务锁）。
 * 生成成功后把新角色**并进在岗池并均分占比** —— 否则新角色的 weight=0，
 * 分配算法会把它算成 0%，用户会以为"生成了但不用"。
 */
function startRoleGeneration(item, { source = "手动生成" } = {}) {
  if (!item?.id) return { ok: false, error: "缺少人设" };
  if (roleSync.get(item.id)?.status === "generating") {
    return { ok: false, error: "这套人设的话术正在生成中，稍等" };
  }
  /**
   * ★ 全局串行：生成脚本是「读整份 risk-replies.json → 写回整份」，
   *   两套同时生成会互相覆盖（后写完的把前一个的角色冲掉）。同一时刻只允许一个。
   */
  const busy = [...roleSync.entries()].find(([, s]) => s?.status === "generating");
  if (busy) {
    return { ok: false, error: "另一套人设的话术还在生成，等它跑完再点（同时生成会互相覆盖）" };
  }
  roleSync.set(item.id, { status: "generating", at: new Date().toISOString(), message: `${source}：正在生成…` });
  log(`人设话术：开始为「${item.name}」生成配套风险话术（后台，不阻塞页面）`);

  const child = spawn(NODE_BIN, [path.join(PROJECT_DIR, "scripts", "gen-risk-roles.mjs"), "--id", item.id], {
    cwd: PROJECT_DIR,
    shell: false,
  });
  let tail = "";
  const collect = (d) => {
    tail = `${tail}${d.toString()}`.slice(-2000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (err) => {
    roleSync.set(item.id, { status: "error", at: new Date().toISOString(), message: `启动失败：${err.message}` });
    log(`人设话术：为「${item.name}」生成启动失败：${err.message}`);
  });
  child.on("close", (code) => {
    const ok = code === 0;
    const last = tail.trim().split("\n").slice(-2).join(" | ").slice(0, 160);
    let joined = null;
    if (ok) {
      try {
        joined = joinRiskPool(PROJECT_DIR, item.id);
      } catch (error) {
        log(`人设话术：「${item.name}」已生成，但并入在岗池失败：${error.message}`);
      }
    }
    roleSync.set(item.id, {
      status: ok ? "done" : "error",
      at: new Date().toISOString(),
      message: ok ? `配套话术已生成${joined?.percent != null ? `（占比 ${joined.percent}%）` : ""}` : `生成失败（退出码 ${code}）`,
      tail: last,
    });
    log(
      ok
        ? `人设话术：已为「${item.name}」生成配套话术${joined?.percent != null ? `，占比 ${joined.percent}%` : ""}`
        : `人设话术：为「${item.name}」生成失败（退出码 ${code}）：${last}`,
    );
  });
  return { ok: true };
}

/**
 * 删除人设时，把它绑定的风险话术角色一起删掉，并把剩余的占比补满。
 * 不删的后果：配置里留下"绑着已不存在的人设"的孤儿角色，越积越多，页面也看不懂。
 * 2026-10-19 起走 risk-personas 的 purge（内部会做再分配），不再直接改 JSON。
 */
function removeRoleBoundToPersona(personaId) {
  if (!personaId) return;
  try {
    const result = purgePersonaFromRisk(PROJECT_DIR, personaId);
    if (!result.ok) {
      log(`人设话术：无需级联删除（${result.error}）`);
      return;
    }
    log(
      `人设话术：已删除「${result.removed.roleName}」的风险话术` +
        `${result.rebalanced ? "，剩余人设占比已自动补齐" : "（已无其他人设负责）"}`,
    );
  } catch (error) {
    log(`人设话术：删除绑定角色失败：${error.message}`);
  }
}

/* ---------------- 写操作 ---------------- */

function patchRules(input) {
  const rules = readJsonSafe(RULES_PATH);
  if (!rules) throw new Error("reply-rules.json 无法解析，已拒绝写入以免毁掉配置");
  const errors = [];

  if (input.maxChars !== undefined) {
    const v = Number(input.maxChars);
    if (!Number.isFinite(v) || v < 4 || v > 400) errors.push("字数上限需在 4–400 之间");
    else rules.reply_length.max_chars = v;
  }
  if (input.minChars !== undefined) {
    const v = Number(input.minChars);
    if (!Number.isFinite(v) || v < 1 || v > 60) errors.push("字数下限需在 1–60 之间");
    else rules.reply_length.min_chars = v;
  }
  if (input.maxRepliesPerRun !== undefined) {
    const v = Number(input.maxRepliesPerRun);
    if (!Number.isFinite(v) || v < 0 || v > 200) errors.push("单轮回复上限需在 0–200 之间");
    else rules.frequency.max_replies_per_run = v;
  }
  if (input.maxRepliesPerWorkTotal !== undefined) {
    const v = Number(input.maxRepliesPerWorkTotal);
    if (!Number.isFinite(v) || v < 0 || v > 10000) errors.push("单视频累计上限需在 0–10000 之间（0 = 不限）");
    else rules.frequency.max_replies_per_work_total = Math.floor(v);
  }
  if (input.policy && typeof input.policy === "object") {
    for (const key of Object.keys(rules.policy ?? {})) {
      if (key === "note") continue;
      if (typeof input.policy[key] === "boolean") rules.policy[key] = input.policy[key];
    }
  }
  if (typeof input.allowThreaded === "boolean") {
    rules.collection = { ...(rules.collection ?? {}), allow_threaded_unreplied: input.allowThreaded };
  }
  if (input.duplicateReplyCap !== undefined) {
    const v = Number(input.duplicateReplyCap);
    if (!Number.isFinite(v) || v < 0 || v > 1000) errors.push("同一内容回复上限需在 0–1000 之间（0 = 不限）");
    else rules.collection = { ...(rules.collection ?? {}), duplicate_reply_cap: Math.floor(v) };
  }
  /**
   * 自定义「不回复」规则（C-38）：页面一次提交整张表（增/删/改都走这里）。
   * 整体替换而不是合并：删除一条规则时，页面不会再提交它 —— 合并式保存会让它永远删不掉。
   */
  let nextNoReply = null;
  if (input.noReplyRules !== undefined) {
    const normalized = normalizeNoReplyRules(input.noReplyRules);
    if (!normalized.ok) errors.push(...normalized.errors);
    else nextNoReply = normalized.items;
  }
  /**
   * ★ C-41：第 3 节「各类评论怎么处理」（不回复 / 模板回复），现在是全 15 类一张表。
   *   落盘位置仍是 **config/risk-policy.json 的 routes[x].action** ——
   *   判定链读哪个文件，配置就写哪个文件，绝不复制一份到别处（两份必然漂移）。
   *   白名单 = HANDLING_TYPES 全部 15 类（C-42 起政治/未成年也可改）。
   */
  let nextNoReplyTypes = null;
  if (input.noReplyTypes !== undefined) {
    if (!input.noReplyTypes || typeof input.noReplyTypes !== "object" || Array.isArray(input.noReplyTypes)) {
      errors.push("处理方式的格式不对");
    } else {
      nextNoReplyTypes = {};
      for (const t of HANDLING_TYPES) {
        const v = input.noReplyTypes[t.key];
        /**
         * 2026-10-20 三值：页面直接提交 skip / template / reply。
         * 仍接受布尔值，兼容还没刷新的旧页面（true = 不回复，false = 用模板）。
         */
        if (typeof v === "string" && HANDLING_ACTIONS.has(v.trim())) nextNoReplyTypes[t.key] = v.trim();
        else if (typeof v === "boolean") nextNoReplyTypes[t.key] = v ? "skip" : "template";
      }
      if (!Object.keys(nextNoReplyTypes).length) errors.push("处理方式里没有一项是有效的");
    }
  }
  /**
   * ★ C-43（2026-10-19 作者要求）：每类的「反向关键词」—— 评论里出现这些词，
   *   就认为这一类**可以回复**（该类不再判，其它类别照常扫）。
   *   落盘位置：config/risk-policy.json 的 **signals[x].allow**（与词表放一起，
   *   判定链读的就是这个字段，不另存一份）。
   */
  let nextAllow = null;
  if (input.allowKeywords !== undefined) {
    if (!input.allowKeywords || typeof input.allowKeywords !== "object" || Array.isArray(input.allowKeywords)) {
      errors.push("反向关键词的格式不对");
    } else {
      nextAllow = {};
      for (const t of HANDLING_TYPES) {
        const list = input.allowKeywords[t.key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          errors.push(`「${t.label}」的反向关键词必须是列表`);
          continue;
        }
        const cleaned = [];
        for (const item of list) {
          const word = String(item ?? "").trim();
          if (!word) continue;
          if (word.length < ALLOW_KEYWORD_MIN) {
            errors.push(`反向关键词「${word}」太短：至少 ${ALLOW_KEYWORD_MIN} 个字，否则会大面积放行`);
            continue;
          }
          if (word.length > ALLOW_KEYWORD_MAX) {
            errors.push(`反向关键词「${word.slice(0, 8)}…」太长：最多 ${ALLOW_KEYWORD_MAX} 个字`);
            continue;
          }
          if (!cleaned.includes(word)) cleaned.push(word);
        }
        nextAllow[t.key] = cleaned.slice(0, ALLOW_KEYWORD_MAX_COUNT);
      }
    }
  }
  /**
   * ★ C-47（2026-10-19 作者要求）：第 3 节抽屉里的「通用兜底话术」要看得见、也能改。
   *   上一版把它折成一行「通用兜底话术 N 条」—— 作者的原话是「我不知道里面是什么，觉得不好也没法改」。
   *
   *   落盘位置：**config/templates.json 的 templates[<pool>]** ——
   *   判定链（judge.mjs 读 templates.json）用的就是这一份，不另存一份，否则必然漂移。
   *   入参按池整体替换：`{ deflect: ["…", "…"] }`（一行一条）。
   *
   *   ⚠ 池是**多类共用**的：deflect 被政治/未成年/色情/暴力等 8 个类共用，
   *   在该池里改一句，这 8 类的兜底话术同时变 —— 页面必须写明，否则会以为只改了当前类。
   */
  let nextPools = null;
  if (input.poolTemplates !== undefined) {
    if (!input.poolTemplates || typeof input.poolTemplates !== "object" || Array.isArray(input.poolTemplates)) {
      errors.push("通用话术的格式不对");
    } else {
      const tplFile = readJsonSafe(TEMPLATES_PATH);
      if (!tplFile || typeof tplFile.templates !== "object" || !tplFile.templates) {
        return { ok: false, errors: ["templates.json 无法解析，已拒绝写入以免毁掉话术配置"] };
      }
      // 白名单：只允许改「当前 15 类实际在用」的池，避免拼错池名凭空造出一个没人读的池
      const known = new Set();
      try {
        const pol = loadRiskPolicy(PROJECT_DIR);
        for (const t of HANDLING_TYPES) {
          const p = routeFor(t.key, pol)?.pool || "deflect";
          if (p) known.add(p);
        }
      } catch {
        /* 读不到策略就退回「只认已有池」 */
        for (const p of Object.keys(tplFile.templates)) known.add(p);
      }
      nextPools = {};
      for (const [pool, list] of Object.entries(input.poolTemplates)) {
        if (known.size && !known.has(pool)) {
          errors.push(`「${pool}」不是当前在用的通用话术池`);
          continue;
        }
        if (!Array.isArray(list)) {
          errors.push(`「${pool}」的话术必须是列表`);
          continue;
        }
        const cleaned = [];
        let rejected = 0;
        for (const item of list) {
          // 模板回复是直接发出去的，一条就是一行 —— 换行会变两条，压成空格
          const line = String(item ?? "").replace(/[\r\n]+/g, " ").trim();
          if (!line) continue;
          if (line.length > POOL_LINE_MAX) {
            rejected += 1;
            errors.push(`通用话术「${line.slice(0, 12)}…」太长：单条最多 ${POOL_LINE_MAX} 字（一条评论就发这一句）`);
            continue;
          }
          if (!cleaned.includes(line)) cleaned.push(line);
        }
        if (!cleaned.length) {
          // 已经因为超长/为空被剔除过，就别再叠一句「至少留 1 条」——同一件事说两遍只会让人以为是两个错
          if (!rejected) errors.push(`「${pool}」至少要留 1 条：全删光这一类选「模板回复」时就没话可用`);
          continue;
        }
        if (cleaned.length > POOL_LINE_MAX_COUNT) {
          errors.push(`「${pool}」最多 ${POOL_LINE_MAX_COUNT} 条`);
          continue;
        }
        nextPools[pool] = cleaned;
      }
      if (!Object.keys(nextPools).length && !errors.length) errors.push("没有要保存的通用话术");
    }
  }
  if (errors.length) return { ok: false, errors };
  if (nextNoReplyTypes || nextAllow) {
    const riskFile = path.join(PROJECT_DIR, "config", "risk-policy.json");
    const riskPolicy = readJsonSafe(riskFile);
    if (!riskPolicy) return { ok: false, errors: ["risk-policy.json 无法解析，已拒绝写入以免毁掉风险策略"] };
    riskPolicy.routes = riskPolicy.routes ?? {};
    for (const [key, value] of Object.entries(nextNoReplyTypes ?? {})) {
      /**
       * 2026-10-20 三值落盘：skip 不回复 / template 用模板 / reply 正常回复。
       * 值已经是校验过的那三种之一（布尔值在校验阶段就换成了字符串）。
       */
      const action = HANDLING_ACTIONS.has(value) ? value : "template";
      riskPolicy.routes[key] = {
        ...(riskPolicy.routes[key] ?? {}),
        action,
        // 只要不是「不回复」就得有个口吻池，否则 routeFor 拿不到 pool
        pool: riskPolicy.routes[key]?.pool || "deflect",
        cache: true,
      };
    }
    if (nextAllow) {
      riskPolicy.signals = riskPolicy.signals ?? {};
      for (const [key, list] of Object.entries(nextAllow)) {
        riskPolicy.signals[key] = { ...(riskPolicy.signals[key] ?? {}), allow: list };
      }
    }
    riskPolicy.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(riskFile, `${JSON.stringify(riskPolicy, null, 2)}\n`, "utf8");
  }

  // ★ C-47：通用兜底话术落盘（config/templates.json）。与上面的 risk-policy 写盘独立，
  //   因为页面「保存这组话术」只提交 poolTemplates，不该连带重写别的文件。
  if (nextPools) {
    const tplFile = readJsonSafe(TEMPLATES_PATH);
    if (!tplFile || typeof tplFile.templates !== "object" || !tplFile.templates) {
      return { ok: false, errors: ["templates.json 无法解析，已拒绝写入以免毁掉话术配置"] };
    }
    tplFile.templates = { ...tplFile.templates };
    for (const [pool, list] of Object.entries(nextPools)) tplFile.templates[pool] = list;
    tplFile.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(TEMPLATES_PATH, `${JSON.stringify(tplFile, null, 2)}\n`, "utf8");
  }

  // 下限不得 ≥ 上限，否则整池模板会被过滤干净（2026-10-15 踩过一次）
  if (Number(rules.reply_length.min_chars) >= Number(rules.reply_length.max_chars)) {
    return { ok: false, errors: [`字数下限(${rules.reply_length.min_chars}) 必须小于上限(${rules.reply_length.max_chars})`] };
  }

  if (nextNoReply) {
    rules[NO_REPLY_CFG_KEY] = {
      ...(rules[NO_REPLY_CFG_KEY] ?? {}),
      note:
        "自定义「不回复」规则。关键词命中即跳过该评论（不调模型、不回复）。" +
        "页面第 3 节「自定义不回复规则」增删改，AI 只负责把一句话变成关键词。",
      updated: new Date().toISOString().slice(0, 16).replace("T", " "),
      items: nextNoReply,
    };
  }

  fs.writeFileSync(RULES_PATH, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  return {
    ok: true,
    effectiveMax: Math.min(Number(rules.reply_length.max_chars), Number(rules.reply_length.hard_cap)),
    noReplyCount: nextNoReply ? nextNoReply.length : undefined,
    savedPools: nextPools ? Object.keys(nextPools) : undefined,
  };
}

/** 作品开关：整体替换式保存（页面每次提交完整状态，避免"部分更新"导致的状态漂移） */
function patchWorks(input) {
  const current = loadSwitch(PROJECT_DIR);
  if (current.error) throw new Error(current.error);
  const next = { mode: current.sw.mode, works: { ...current.sw.works } };

  if (typeof input.mode === "string" && SWITCH_MODES.includes(input.mode)) next.mode = input.mode;

  const enabledMap = input.enabled && typeof input.enabled === "object" ? input.enabled : null;
  if (enabledMap) {
    const worksRaw = readJsonSafe(path.join(OUT_DIR, "list-works.json"))?.works ?? [];
    const byKey = new Map(worksRaw.map((w) => [workKey(w), w]));
    for (const [key, enabled] of Object.entries(enabledMap)) {
      const work = byKey.get(key);
      if (!work) continue; // 只接受当前列表里真实存在的作品
      next.works[key] = {
        enabled: enabled === true,
        publishText: String(work.publishText ?? ""),
        updated: new Date().toISOString().slice(0, 10),
      };
    }
    // 清理已经不存在的作品，避免开关文件无限膨胀
    for (const key of Object.keys(next.works)) {
      if (!byKey.has(key)) delete next.works[key];
    }
  }

  const saved = saveSwitch(PROJECT_DIR, next);
  const enabledCount = Object.values(saved.sw.works).filter((w) => w.enabled).length;
  return { ok: true, mode: saved.sw.mode, enabledCount };
}

/* ---------------- 子进程：预览 / 拉作品 / 跑一轮 ---------------- */

/**
 * 给第三方工具（tool/ 目录）的子进程剥离密钥 —— 与 run-batch.mjs 同一约定。
 * 剥离清单从 config/reply-rules.json 的 security.secrets.strip_from_child_env 读，
 * 缺省 DEEPSEEK_API_KEY。拉作品列表不需要 key，剥掉减少泄漏面。
 */
function envForTool() {
  const env = { ...process.env };
  let stripList = ["DEEPSEEK_API_KEY"];
  try {
    const cfg = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
    const list = cfg.security?.secrets?.strip_from_child_env;
    if (Array.isArray(list) && list.length) stripList = list;
  } catch {
    /* 读不到就用缺省 */
  }
  const stripped = [];
  for (const key of stripList) {
    if (key in env) {
      delete env[key];
      stripped.push(key);
    }
  }
  if (stripped.length) log(`子进程环境已剥离：${stripped.join(", ")}`);
  return env;
}

const runState = {
  running: false,
  kind: null,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

/**
 * 扫码登录 / 换账号（C-28，2026-10-17 作者要求）
 *
 * 复用 tool/src/auth-douyin.mjs（就是 2-扫码登录.bat 跑的那个），不复制它的逻辑：
 * 那个脚本负责开可见浏览器 → 停在登录页 → 等你按回车 → 校验评论页能不能进。
 * 控制台这边只做三件事：把它**以子进程方式**拉起来、把它的输出搬到页面上、
 * 你点「我扫完了」时替你在它的 stdin 敲一个回车。
 *
 * 为什么必须用子进程而不是自己写登录：登录态存的是那个 persistent profile，
 * 浏览器内核版本、profile 加锁、Cookie 落盘全在 tool 那边，重写一遍等于给自己埋坑。
 *
 * 三条防呆：
 *   · 与「跑一轮」互斥（都要独占 profile 目录，同时开会互锁）；
 *   · 与自动回复互斥（登录窗口开着时，自动轮顺延，不会白跑一趟再报错）；
 *   · 15 分钟没点「我扫完了」自动收摊，免得一个忘关的窗口把 profile 锁一整天。
 */
const loginState = {
  child: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  cancelled: false,
  /** 本次是否清空了旧登录态（换号）；记录备份目录，便于反悔 */
  backupDir: null,
  /** 换号时归档的旧跳过缓存文件（null = 没归档） */
  archivedSkipCache: null,
  lines: [],
  timer: null,
};

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const PROFILE_DIR = path.join(TOOL_DIR, ".playwright", "douyin-profile");

function loginSnapshot() {
  return {
    running: Boolean(loginState.child),
    startedAt: loginState.startedAt,
    finishedAt: loginState.finishedAt,
    exitCode: loginState.exitCode,
    cancelled: loginState.cancelled,
    backupDir: loginState.backupDir,
    archivedSkipCache: loginState.archivedSkipCache,
    lines: loginState.lines.slice(-120),
    login: detectLogin(),
  };
}

function pushLoginLine(line) {
  loginState.lines.push(line);
  if (loginState.lines.length > 400) loginState.lines.splice(0, loginState.lines.length - 400);
}

function finishLogin(code, reason) {
  if (loginState.timer) {
    clearTimeout(loginState.timer);
    loginState.timer = null;
  }
  loginState.child = null;
  loginState.exitCode = code;
  loginState.finishedAt = new Date().toISOString();
  const state = detectLogin();
  log(`扫码登录：结束（${reason}，退出码 ${code}，登录态 ${state.ok ? "有效" : "未生效"}）`);
  return state;
}

/**
 * 换号前把旧 profile 挪走（不是删）——「删」一旦点错就再也回不来，
 * 「改名」还留着一条后路：想恢复把目录名改回去即可。
 */
function stashProfile() {
  if (!fs.existsSync(PROFILE_DIR)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  const backup = `${PROFILE_DIR}.bak-${stamp}`;
  fs.renameSync(PROFILE_DIR, backup);
  return backup;
}

/**
 * 换号时把「已判定不回」缓存归档（C-29）。
 *
 * 为什么非做不可：缓存的 key 是「作品标题 + 评论内容」，**不含账号**。
 * 换了号以后，如果新号有同名作品、或同一个视频被两个号都评论过，
 * 旧结论会被当成新号的事实 —— 表现为"这条明明能回，它就是不动"，而且完全静默。
 * 归档而不是删除：想查上一号当时怎么判的，文件还在。
 *
 * 只在这个动作上清：单纯"重新扫码"（扫码登录按钮）不清，避免同号重登白白多花一遍判定钱。
 */
function archiveSkipCache() {
  const src = path.join(PROJECT_DIR, "state", "skip-cache.json");
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  const dest = path.join(PROJECT_DIR, "state", `skip-cache.bak-${stamp}.json`);
  fs.renameSync(src, dest);
  return dest;
}

function startLogin({ fresh = false } = {}) {
  if (runState.running) return { ok: false, error: "有任务正在跑（采集/发送/拉列表），等它结束后再登录" };
  if (loginState.child) return { ok: false, error: "登录窗口已经开着了，先在上面点「我扫完了」或「取消」" };

  loginState.lines = [];
  loginState.cancelled = false;
  loginState.exitCode = null;
  loginState.finishedAt = null;
  loginState.backupDir = null;
  loginState.archivedSkipCache = null;

  if (fresh) {
    try {
      loginState.backupDir = stashProfile();
      loginState.archivedSkipCache = archiveSkipCache();
      if (loginState.archivedSkipCache) log(`换账号：旧「已判定不回」缓存已归档 → ${loginState.archivedSkipCache}`);
    } catch (error) {
      return { ok: false, error: `清空旧登录态失败（可能有浏览器还开着）：${error.message}` };
    }
  }

  let child;
  try {
    const loginArgs = [path.join(TOOL_DIR, "src", "auth-douyin.mjs")];
    /**
     * 只用 `--profile` 换存档目录（正常不给）。存在的理由只有一个：
     * 自测要真起一次登录窗口验证「扫码页真的能开」，但又绝不能碰作者的真实登录态。
     * 设了 DOUYIN_LOGIN_PROFILE 就写到一个临时目录里，测完删掉。
     */
    if (process.env.DOUYIN_LOGIN_PROFILE) {
      loginArgs.push("--profile", process.env.DOUYIN_LOGIN_PROFILE);
    }
    child = spawn(NODE_BIN, loginArgs, {
      cwd: TOOL_DIR,
      // envForTool() 会按规则把 DEEPSEEK_API_KEY 摘掉 —— 登录子进程全程不需要密钥
      env: envForTool(),
      // stdin 必须留 pipe：脚本在等一行回车，我们代替作者敲
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    log(`扫码登录：启动失败（${error.message}）`);
    return { ok: false, error: `登录脚本起不来：${error.message}` };
  }

  loginState.child = child;
  loginState.startedAt = new Date().toISOString();
  pushLoginLine(`$ node src/auth-douyin.mjs`);

  const onData = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) pushLoginLine(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => finishLogin(code, loginState.cancelled ? "已取消" : "脚本退出"));
  child.on("error", (error) => {
    pushLoginLine(`进程出错：${error.message}`);
    finishLogin(-1, "进程出错");
  });
  // 脚本可能因为浏览器起不来而立即退出；stdin 上的 EPIPE 不该把控制台带崩
  child.stdin.on("error", () => {});

  loginState.timer = setTimeout(() => {
    pushLoginLine("— 超过 15 分钟没有完成，已自动关闭登录窗口 —");
    log("扫码登录：15 分钟超时，自动收摊");
    try {
      loginState.child?.kill();
    } catch {
      /* 已经退了 */
    }
  }, LOGIN_TIMEOUT_MS);
  loginState.timer.unref?.();

  log(`扫码登录：已启动${fresh ? "（先清空了旧登录态）" : ""}`);
  return { ok: true, login: loginSnapshot() };
}

function confirmLoginDone() {
  if (!loginState.child) return { ok: false, error: "当前没有正在进行的登录窗口" };
  try {
    // auth-douyin.mjs 在等这一行；回车 = "我扫完了，你去校验并关窗"
    loginState.child.stdin.write("\n");
    pushLoginLine("— 已通知脚本：校验登录态并关闭浏览器 —");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `通知失败：${error.message}` };
  }
}

function cancelLogin() {
  if (!loginState.child) return { ok: false, error: "当前没有正在进行的登录窗口" };
  loginState.cancelled = true;
  try {
    loginState.child.kill();
  } catch (error) {
    return { ok: false, error: `关闭失败：${error.message}` };
  }
  return { ok: true };
}
const MAX_LINES = 4000;

function pushLine(line) {
  runState.lines.push(line);
  if (runState.lines.length > MAX_LINES) runState.lines.splice(0, runState.lines.length - MAX_LINES);
}

/**
 * 每轮结束记一笔（C-29）：回了几条、采了几条、模型花了多少钱。
 * 只在"真的产出过裁决报告"时记 —— 拉列表、纯空的轮次不留噪音。
 * 统计是附加物，任何异常都只写日志，绝不让它影响跑批结果。
 */
function recordRoundStats(kind, exitCode, startedAtIso) {
  try {
    const startedMs = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
    const sum = summarizeReportsSince(OUT_DIR, startedMs);
    if (!sum.reports) return;
    const rec = appendRoundStat(PROJECT_DIR, {
      at: new Date().toISOString(),
      kind,
      exitCode,
      durationMs: Math.max(0, Date.now() - startedMs),
      ...sum,
    });
    if (!rec.ok) log(`统计：写入失败（${rec.error}）`);
  } catch (error) {
    log(`统计：记一笔时出错（${error.message}）`);
  }
}

function startProcess(kind, bin, args, { env, cwd, onClose } = {}) {
  if (runState.running) throw new Error("已有一个任务在运行，请等它结束");
  runState.running = true;
  runState.kind = kind;
  runState.lines = [];
  runState.exitCode = null;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  pushLine(`$ ${path.basename(bin)} ${args.join(" ")}`);

  let child;
  try {
    child = spawn(bin, args, {
      cwd: cwd ?? PROJECT_DIR,
      env: { ...process.env, ...(env ?? {}) },
      shell: false,
    });
  } catch (error) {
    // ★ 锁必须在 spawn 失败时回滚。
    //   根因（2026-10-16 实测踩到）：Windows 上 spawn 一个 .cmd 文件 + shell:false
    //   会**同步抛 EINVAL**（Node 为 CVE-2024-27980 加的限制）。第一版先置
    //   running=true 再 spawn 且不兜底 → 异常冒泡走了，锁却永久停在"运行中"，
    //   之后每一次点击都报「已有任务在运行」（连"跑一轮"也被同一个锁挡住）。
    runState.running = false;
    runState.exitCode = -1;
    runState.finishedAt = new Date().toISOString();
    pushLine(`进程启动失败：${error.message}`);
    log(`子进程启动失败 kind=${kind}：${error.message}`);
    throw new Error(`任务无法启动（${error.message}）。已自动恢复，可再点一次。`);
  }
  const onData = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) pushLine(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    runState.running = false;
    runState.exitCode = code;
    runState.finishedAt = new Date().toISOString();
    pushLine(`— 结束（退出码 ${code}）—`);
    log(`子进程结束 kind=${kind} code=${code}`);
    recordRoundStats(kind, code, runState.startedAt);
    if (typeof onClose === "function") {
      try {
        onClose(code);
      } catch (error) {
        log(`onClose 回调出错 kind=${kind}：${error.message}`);
      }
    }
  });
  child.on("error", (error) => {
    runState.running = false;
    runState.exitCode = -1;
    runState.finishedAt = new Date().toISOString();
    pushLine(`进程启动失败：${error.message}`);
    log(`子进程出错 kind=${kind}：${error.message}`);
    if (typeof onClose === "function") {
      try {
        onClose(-1);
      } catch (callbackError) {
        log(`onClose 回调出错 kind=${kind}：${callbackError.message}`);
      }
    }
  });
  log(`子进程启动 kind=${kind}`);
  return child;
}

const NODE_BIN = process.execPath;
// 注意：**不要**再用 npm.cmd / npm 启动子进程。
// Windows 上 spawn 一个 .cmd 文件 + shell:false 会同步抛 EINVAL（CVE-2024-27980 的修复），
// shell:true 又有中文路径转义风险。要跑 tool/ 里的 npm script 就直接：
//   spawn(NODE_BIN, [path.join(TOOL_DIR, "src", "xxx.mjs")], { cwd: TOOL_DIR })
// npm run <script> 的实质就是 node <对应的 .mjs>，跳过 npm 这一层反而更稳。

/* ---------------- 自动回复模式 ----------------
 *
 * 开关打开后，本进程按「间隔分钟数」反复跑一轮 stage 2（采集→裁决→发送）。
 * 去重不靠这里：run-session 内部有数据库 + 台账两道已回复过滤，宁可少回不重复回。
 * 与手动「确认发送」的区别只在触发方式 —— 判定、拦截、发送链路完全同一条。
 *
 * 边界（有意为之）：
 *   · 自动模式寄生在控制台进程里：关掉控制台窗口 = 自动模式暂停；
 *     开关本身存在 config/auto-reply.json，重新打开控制台会自动恢复调度。
 *   · 用 setTimeout 链而不是 setInterval：每轮跑完才排下一轮，任务慢了不会叠加。
 *   · 到点时若有任务在跑（手动跑的、拉列表的），本轮顺延 60 秒，绝不并发开浏览器。
 */

const autoCfg = loadAuto(PROJECT_DIR);

/**
 * ★ 「上一轮」必须落盘（2026-10-17 作者报：后台明明跑过一轮，状态里还停在上一轮的时间）。
 *
 * 根因有两条，缺一条都会显得"时间不动"：
 *   ① 页面只在 loadState() 时渲染一次，之后没有任何轮询 → 跑完一轮 DOM 不会自己变；
 *   ② lastRunAt 只存在**进程内存**，控制台一重启就归零，页面甚至不显示"上一轮"。
 * 所以这里加一个 state/auto-last-run.json：进程重启后仍知道上一轮是什么时候、回了多少条。
 */
const AUTO_LAST_RUN_PATH = path.join(PROJECT_DIR, "state", "auto-last-run.json");

function readPersistedLastRun() {
  try {
    const data = JSON.parse(fs.readFileSync(AUTO_LAST_RUN_PATH, "utf8"));
    if (!data || !data.at) return null;
    return data;
  } catch {
    return null;
  }
}

function persistLastRun(payload) {
  try {
    fs.mkdirSync(path.dirname(AUTO_LAST_RUN_PATH), { recursive: true });
    fs.writeFileSync(AUTO_LAST_RUN_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`自动回复：上一轮状态写入失败（不影响运行）：${error.message}`);
  }
}

/** 上一轮实际回了多少条：取本轮时间窗内新写出的裁决报告；取不到就留 null，不瞎猜 */
function summariseRound(startedAt) {
  try {
    const latest = detectLastRun();
    if (!latest || !latest.at) return { total: null, replied: null };
    if (startedAt && new Date(latest.at).getTime() < new Date(startedAt).getTime() - 5000) {
      return { total: null, replied: null };
    }
    return { total: latest.total ?? null, replied: latest.replied ?? null };
  } catch {
    return { total: null, replied: null };
  }
}

const persistedLastRun = readPersistedLastRun();

const autoState = {
  timer: null,
  nextRunAt: null,
  lastRunAt: persistedLastRun?.at ?? null,
  lastExitCode: persistedLastRun?.exitCode ?? null,
  /** 上一轮回了多少条 / 共采到多少条（未知为 null） */
  lastRunReplied: persistedLastRun?.replied ?? null,
  lastRunTotal: persistedLastRun?.total ?? null,
  lastRunStartedAt: persistedLastRun?.startedAt ?? null,
  /** 自动调度被抑制的原因（null = 正常）。页面会显示出来，绝不静默不跑 */
  suppressedReason: null,
};

/**
 * ★ 自动调度只能有一个"司机"（2026-10-17 实测踩到）：
 *
 * 自动模式寄生在控制台进程里，而配置是**全局**的（config/auto-reply.json）。
 * 于是只要同时起两个控制台（例如 `--port 5199` 的排查实例、或自测里起的真实服务），
 * 两个进程都会按同一份配置排程 → **同一批评论被两个进程各回一次**。
 * 这不是理论风险：已经在自测起的临时实例上真发出去过。
 *
 * 三道闸：
 *   ① DOUYIN_CONSOLE_NO_AUTO=1 —— 自测/排查专用，直接不排程（最硬，不依赖任何状态）；
 *   ② state/auto-mode.lock —— 谁能排程写谁，第二个实例只读不跑（PID 死了视为过期）；
 *   ③ 关掉开关即释放锁，换实例接管不用手工删文件。
 */
const AUTO_DISABLED_BY_ENV = process.env.DOUYIN_CONSOLE_NO_AUTO === "1";
const AUTO_LOCK_PATH = path.join(PROJECT_DIR, "state", "auto-mode.lock");

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限（Windows 上偶尔如此），仍算活着
    return error.code === "EPERM";
  }
}

function readAutoLock() {
  try {
    return JSON.parse(fs.readFileSync(AUTO_LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** 尝试成为自动调度的负责人。返回 { ok, holder?, warning? } */
function acquireAutoLock() {
  const current = readAutoLock();
  if (current && Number(current.pid) !== process.pid && pidAlive(current.pid)) {
    return { ok: false, holder: current };
  }
  try {
    fs.mkdirSync(path.dirname(AUTO_LOCK_PATH), { recursive: true });
    fs.writeFileSync(
      AUTO_LOCK_PATH,
      `${JSON.stringify({ pid: process.pid, port: BASE_PORT, startedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return { ok: true };
  } catch (error) {
    // 写不进锁不阻断自动模式（只读盘/权限异常时宁可照常跑），但要在日志里留痕
    return { ok: true, warning: `自动调度锁写入失败（不影响运行）：${error.message}` };
  }
}

function releaseAutoLock() {
  const current = readAutoLock();
  if (current && Number(current.pid) === process.pid) {
    try {
      fs.unlinkSync(AUTO_LOCK_PATH);
    } catch {
      /* 已经不在了 */
    }
  }
}

const AUTO_RETRY_DELAY_MS = 60_000;

function clearAutoTimer() {
  if (autoState.timer) {
    clearTimeout(autoState.timer);
    autoState.timer = null;
  }
  autoState.nextRunAt = null;
}

function scheduleAutoRun(delayMs) {
  clearAutoTimer();
  if (!autoCfg.enabled) return;
  if (AUTO_DISABLED_BY_ENV) {
    autoState.suppressedReason = "本实例以「不自动回复」模式启动（DOUYIN_CONSOLE_NO_AUTO=1），只做配置与排查";
    return;
  }
  if (autoState.suppressedReason) return;
  autoState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  autoState.timer = setTimeout(() => {
    autoState.timer = null;
    autoState.nextRunAt = null;
    fireAutoRun();
  }, delayMs);
  log(
    `自动回复：下一轮已排定（${Math.max(1, Math.round(delayMs / 60000))} 分钟后，` +
      `约 ${new Date(Date.now() + delayMs).toLocaleTimeString("zh-CN")}）`,
  );
}

function fireAutoRun() {
  if (!autoCfg.enabled) return;
  if (AUTO_DISABLED_BY_ENV || autoState.suppressedReason) {
    // 兜底：定时器可能在抑制原因出现之前就排好了
    return;
  }
  // ★ 定时时段闸（2026-10-16）：时段外不跑，直接排到"时段开始"那一刻，
  //   到点自动恢复——不用手动开关。
  if (!isWithinSchedule(autoCfg.schedule)) {
    const delay = msUntilScheduleOpen(autoCfg.schedule);
    log(
      `自动回复：当前不在运行时段（${autoCfg.schedule.start}–${autoCfg.schedule.end}），` +
        `已排定到时段开始时恢复（约 ${Math.max(1, Math.round(delay / 60000))} 分钟后）`,
    );
    scheduleAutoRun(Math.max(60_000, delay));
    return;
  }
  if (runState.running) {
    log("自动回复：有任务正在运行，本轮顺延 60 秒");
    scheduleAutoRun(AUTO_RETRY_DELAY_MS);
    return;
  }
  // 登录窗口开着时自动轮必须让路：它独占浏览器 profile，硬跑只会撞锁再报错
  if (loginState.child) {
    log("自动回复：正在扫码登录，本轮顺延 60 秒（登录窗口独占浏览器存档）");
    scheduleAutoRun(AUTO_RETRY_DELAY_MS);
    return;
  }
  log(`自动回复：开始自动跑一轮（采集→裁决→发送${autoCfg.headless ? "，后台模式" : ""}）`);
  const args = [path.join(PROJECT_DIR, "scripts", "run-batch.mjs"), "--stage", "2"];
  // 后台模式：自动轮不弹创作者中心窗口；手动「跑一轮」不受影响（出问题好排查）
  if (autoCfg.headless) args.push("--headless");
  try {
    // 记下本轮开始时刻：结束时用它判断裁决报告是不是本轮产出的（决定要不要报"回了 N 条"）
    const roundStartedAt = new Date().toISOString();
    startProcess("auto-stage2", NODE_BIN, args, {
      onClose: (code) => {
        const at = new Date().toISOString();
        const summary = summariseRound(roundStartedAt);
        autoState.lastRunAt = at;
        autoState.lastExitCode = code;
        autoState.lastRunReplied = summary.replied;
        autoState.lastRunTotal = summary.total;
        autoState.lastRunStartedAt = roundStartedAt;
        persistLastRun({
          at,
          startedAt: roundStartedAt,
          exitCode: code,
          total: summary.total,
          replied: summary.replied,
          headless: autoCfg.headless === true,
        });
        log(
          `自动回复：本轮结束（退出码 ${code}` +
            `${summary.replied != null ? `，回了 ${summary.replied} 条` : ""}）`,
        );
        if (autoCfg.enabled) scheduleAutoRun(autoCfg.intervalMinutes * 60_000);
      },
    });
    pushLine(
      `（自动回复模式：本轮由定时器触发，无需手动确认${autoCfg.headless ? "；后台运行，不弹窗口" : ""}）`,
    );
  } catch (error) {
    // startProcess 抛错多为"已有任务在运行"的竞态；顺延，不让自动模式哑火
    log(`自动回复：本轮启动失败（${error.message}），60 秒后重试`);
    scheduleAutoRun(AUTO_RETRY_DELAY_MS);
  }
}

/** 应用（启用/停用/改间隔/后台/时段）自动模式；返回给页面的状态快照 */
function applyAutoMode({ enabled, intervalMinutes, headless, schedule }) {
  const wasEnabled = autoCfg.enabled;

  /**
   * ★ 先争锁，再落盘（2026-10-17）：
   *   顺序反了会有副作用 —— 第二个实例点"开启"时，若先把 enabled=true 写进共享配置，
   *   再发现锁被占而退回，磁盘上就留下一个"开着但没人跑"的开关，
   *   下次开控制台会以为自动回复在跑。所以冲突时**什么都不写**。
   */
  if (enabled && !AUTO_DISABLED_BY_ENV) {
    const lock = acquireAutoLock();
    if (!lock.ok) {
      autoState.suppressedReason = "另一个控制台正在负责自动回复";
      log(
        `自动回复：拒绝开启 —— 另一个控制台（PID ${lock.holder?.pid ?? "?"}，` +
          `端口 ${lock.holder?.port ?? "?"}）正在负责`,
      );
      return {
        ok: false,
        error: `另一个控制台（PID ${lock.holder?.pid ?? "?"}，端口 ${lock.holder?.port ?? "?"}）正在负责自动回复`,
      };
    }
    if (lock.warning) log(`自动回复：${lock.warning}`);
  }

  const saved = saveAuto(PROJECT_DIR, { enabled, intervalMinutes, headless, schedule });
  autoCfg.enabled = saved.enabled;
  autoCfg.intervalMinutes = saved.intervalMinutes;
  autoCfg.headless = saved.headless;
  autoCfg.schedule = saved.schedule;
  autoCfg.error = null;

  clearAutoTimer();
  if (autoCfg.enabled) {
    autoState.suppressedReason = AUTO_DISABLED_BY_ENV
      ? "本实例以「不自动回复」模式启动（DOUYIN_CONSOLE_NO_AUTO=1），只做配置与排查"
      : null;
    // 开启的那一刻就先跑一轮（新评论等不到下一个间隔）；
    // 但当前在时段外的话，fireAutoRun 会自己排到时段开始（不会硬跑）
    if (!wasEnabled) {
      log(
        `自动回复：已开启（${autoCfg.headless ? "后台模式" : "窗口模式"}；` +
          `${autoCfg.schedule.enabled ? `时段 ${autoCfg.schedule.start}–${autoCfg.schedule.end}` : "全天"}）`,
      );
      fireAutoRun();
    } else {
      scheduleAutoRun(autoCfg.intervalMinutes * 60_000);
    }
  } else if (wasEnabled) {
    log("自动回复：已关闭（本轮之后的调度已取消；正在跑的一轮会正常跑完）");
    releaseAutoLock();
  }
  return autoSnapshot();
}

function autoSnapshot() {
  return {
    enabled: autoCfg.enabled,
    intervalMinutes: autoCfg.intervalMinutes,
    intervalRange: [AUTO_INTERVAL_MIN, AUTO_INTERVAL_MAX],
    defaultInterval: AUTO_INTERVAL_DEFAULT,
    headless: autoCfg.headless,
    schedule: autoCfg.schedule,
    scheduleDefault: SCHEDULE_DEFAULT,
    windowActive: isWithinSchedule(autoCfg.schedule),
    nextRunAt: autoState.nextRunAt,
    lastRunAt: autoState.lastRunAt,
    lastExitCode: autoState.lastExitCode,
    /** 上一轮回了多少条 / 采到多少条；null = 没拿到（页面就不显示这一段） */
    lastRunReplied: autoState.lastRunReplied,
    lastRunTotal: autoState.lastRunTotal,
    lastRunStartedAt: autoState.lastRunStartedAt,
    activeNow: runState.running && runState.kind === "auto-stage2",
    fileError: autoCfg.error,
    /** 非 null = 自动调度被抑制（测试模式 / 另一个控制台在跑），页面必须显示出来 */
    suppressedReason: autoState.suppressedReason,
    runner: AUTO_DISABLED_BY_ENV ? "disabled_by_env" : readAutoLock(),
  };
}

/** 预览：spawn judge.mjs 的 --preview-text 模式，取哨兵之间的 JSON */
function runPreview(text, username, workKeyValue) {
  return new Promise((resolve) => {
    const argv = [
      path.join(PROJECT_DIR, "scripts", "judge.mjs"),
      "--preview-text", text,
      "--preview-user", username || "预览访客",
    ];
    /**
     * 带上作品语境：不带的话预览走"无语境"分支，判定会比真实运行更保守 ——
     * 于是页面显示"这条会被拦"，真实跑却没有 → 预览失去意义。
     */
    if (workKeyValue) argv.push("--preview-work-key", String(workKeyValue));
    const child = spawn(NODE_BIN, argv, { cwd: PROJECT_DIR, env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "预览超时（60 秒）。若网络慢，可稍后重试。" });
    }, 60000);
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/<<<PREVIEW_JSON>>>\s*([\s\S]*?)\s*<<<END_PREVIEW_JSON>>>/);
      if (!m) {
        resolve({ ok: false, error: `预览未返回结果。stderr：${err.slice(-400) || "(无)"}` });
        return;
      }
      try {
        resolve({ ok: true, preview: JSON.parse(m[1]), stderr: err.slice(-400) });
      } catch (e) {
        resolve({ ok: false, error: `预览结果解析失败：${e.message}` });
      }
    });
  });
}

/* ---------------- HTTP ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * 同源校验：**端口也必须一模一样**（2026-10-17 起对全部写接口生效）。
 *
 * 早先只校验主机名，于是本机另一个网页（例如 127.0.0.1:3000 上的任意页面）
 * 也能往控制台的写接口发 POST —— 改配置事小，/api/run 能触发真实发送、/api/api-key
 * 能换掉密钥。浏览器发起的跨源请求一定带 Origin，所以卡死端口就够；
 * 没有 Origin 的是 curl / 自测脚本这类本地进程 —— 它们本来就能直接改文件。
 */
function sameConsoleOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return (host === "127.0.0.1" || host === "[::1]") && port === BASE_PORT;
  } catch {
    return false;
  }
}

function serveStatic(req, res) {
  /**
   * ★ 畸形百分号必须挡住（2026-10-17 实测：`curl http://127.0.0.1:5180/%E0%A4%A`
   *   能让整个控制台进程直接退出）。`decodeURIComponent` 遇到不完整的 % 转义会抛
   *   URIError，而这一行原本在 try 之外 —— 异常冒到 http 回调顶部，进程就没了。
   *   后果：任何本机网页随手一个 fetch 就能让挂机停止，且没有任何提示。
   */
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("bad request");
    return;
  }
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(UI_DIR, rel);
  if (!target.startsWith(path.resolve(UI_DIR) + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" });

  /**
   * ★ 页面版本号由**后端注入**（2026-10-18 · C-35 收尾）。
   *   以前 index.html 里写死 `const UI_EXPECTS = 'c32'`，升级时要人记得同时改两处；
   *   漏一次（c33/c34 就漏了）页面就一直弹"版本不一致"红条，看着像坏了。
   *   现在：HTML 里的字面值只是占位，真正发出去的值永远等于本进程的 CONSOLE_VERSION ——
   *   前后端不可能再对不上，也就不用"记得改两处"。
   */
  if (rel === "index.html") {
    try {
      const html = fs.readFileSync(target, "utf8").replace(
        /const UI_EXPECTS = '[^']*';/,
        `const UI_EXPECTS = '${CONSOLE_VERSION}';`,
      );
      res.end(html);
      return;
    } catch (error) {
      log(`页面注入版本号失败（按原文件发送）：${error.message}`);
    }
  }
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // 畸形 HTTP 不该把进程带走：正常情况下 Node 会先触发 clientError，
  // 但 `new URL` 仍可能对奇怪路径抛错，所以这里兜一层。
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

  /**
   * ★ 全局改用「端口级」同源（2026-10-17 安全复查）：原来这里只查主机名，
   *   于是本机另一个网页（127.0.0.1:3000 上的任何页面）也能 POST /api/run 触发**真实发送**，
   *   或者改人设、改规则。写密钥那两个接口早就升到端口级了，这里补上。
   *   无 Origin 的请求（curl / 自测脚本）照旧放行 —— 本机进程本来就能直接改文件。
   */
  if (req.method === "POST" && !sameConsoleOrigin(req)) {
    return sendJson(res, 403, { ok: false, error: "拒绝来自其它来源的写入请求（只接受控制台自己的页面）" });
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, buildState());
    }

    /**
     * 风险人设库的轻量读取（2026-10-19）。
     * 页面在「生成话术」之后要反复查进度，但整个 /api/state 会连带重绘人设表单，
     * 把用户没保存的编辑冲掉 —— 所以单独开一个只读接口，只回这一块 + 生成状态。
     */
    if (req.method === "GET" && url.pathname === "/api/risk-personas") {
      const lib = loadPersonaLibrary(PROJECT_DIR);
      /**
       * ★ C-46：顺手把「第 3 节每类的固定话术」一起回。
       *   那一块本来就是这套人设话术的另一种视图，分开取会不同步 ——
       *   人设改了口吻、话术重生成后，第 3 节还挂着旧句子，看着像没生效。
       */
      const typeTemplates = describeNoReplyTypes().map(({ key, pool, personaTemplates, templates }) => ({
        key,
        pool,
        personaTemplates,
        templates,
      }));
      return sendJson(res, 200, {
        ok: true,
        riskPersonas: describeRiskPersonas(PROJECT_DIR, { personaLib: lib }),
        roleSync: Object.fromEntries([...roleSync.entries()]),
        typeTemplates,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/run") {
      return sendJson(res, 200, {
        ok: true,
        running: runState.running,
        kind: runState.kind,
        lines: runState.lines,
        exitCode: runState.exitCode,
        startedAt: runState.startedAt,
        finishedAt: runState.finishedAt,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/auto") {
      // 轻量接口：只回自动模式的运行状态，供页面轮询刷新「下一轮 / 上一轮」。
      // 不复用 /api/state —— 那个要读人设库、作品列表、合作待办，5 秒一次太重。
      return sendJson(res, 200, { ok: true, auto: autoSnapshot() });
    }

    if (req.method === "GET" && url.pathname === "/api/login") {
      return sendJson(res, 200, { ok: true, login: loginSnapshot() });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (body === null) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });

      if (url.pathname === "/api/works") {
        const result = patchWorks(body);
        log(`保存作品开关 mode=${result.mode} enabled=${result.enabledCount}`);
        return sendJson(res, 200, result);
      }

      if (url.pathname === "/api/persona") {
        /**
         * 新增或更新一套人设（C-23）：
         *   · body.id 存在且能对上 = 改这套；对不上/没传 = 新建一套。
         *   · 不管哪种，**保存即最终版本** —— 备份/恢复那套机制已经整个删掉，
         *     不会再出现「点了保存，下次打开又是旧的」。
         *   · 校验仍然按作者手写的标准：超长/带密钥/带占位符一律拒绝，不静默截断。
         */
        const personaInput = body.persona && typeof body.persona === "object" ? body.persona : {};
        const verdict = validatePersonaForSave(personaInput, { maxChars: personaEffectiveMax() });
        if (!verdict.ok) {
          return sendJson(res, 400, { ok: false, errors: verdict.errors, warnings: verdict.warnings });
        }
        try {
          const saved = upsertPersona(PROJECT_DIR, {
            id: body.id,
            name: body.name,
            tagline: body.tagline,
            persona: personaInput,
          });
          log(`${saved.created ? "新建" : "更新"}人设「${saved.item.name}」（id=${saved.item.id}，共 ${saved.items.length} 套）`);
          ensurePersonaRoleSync(saved.item, saved.created ? "新建人设" : "更新人设");
          return sendJson(res, 200, {
            ok: true,
            created: saved.created,
            item: publicPersona(saved.item),
            items: saved.items.map(publicPersona),
            warnings: verdict.warnings,
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, errors: [error.message] });
        }
      }

      if (url.pathname === "/api/persona/duplicate") {
        try {
          const saved = duplicatePersona(PROJECT_DIR, String(body.id ?? "").trim());
          log(`复制人设「${saved.item.name}」（源 id=${body.id}，共 ${saved.items.length} 套）`);
          ensurePersonaRoleSync(saved.item, "复制人设");
          return sendJson(res, 200, {
            ok: true,
            item: publicPersona(saved.item),
            items: saved.items.map(publicPersona),
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      if (url.pathname === "/api/persona/delete") {
        try {
          const result = deletePersona(PROJECT_DIR, String(body.id ?? "").trim());
          /**
           * ★ 删完必须修 rotation：single / pool 里还留着这个 id 的话，
           *   下拉会显示空、判裁层按未知 id 兜底，页面与真跑就对不上了。
           *   normalizeRotation 会把失效 id 全剔掉并把 single 回退到库里第一套。
           */
          const rotation = repairRotation(result.items);
          log(`删除人设「${result.deleted.name}」（id=${result.deleted.id}，剩 ${result.items.length} 套）`);
          removeRoleBoundToPersona(result.deleted.id);
          return sendJson(res, 200, {
            ok: true,
            deleted: { id: result.deleted.id, name: result.deleted.name },
            items: result.items.map(publicPersona),
            rotation,
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      if (url.pathname === "/api/persona/generate") {
        if (personaGenerating) {
          return sendJson(res, 409, { ok: false, error: "上一次 AI 生成还没结束，请稍等几秒" });
        }
        const description = String(body.description ?? "").trim();
        if (!description) return sendJson(res, 400, { ok: false, error: "请先用一句话描述想要的人设" });
        if (description.length > DESCRIPTION_MAX) {
          return sendJson(res, 400, { ok: false, error: `描述请控制在 ${DESCRIPTION_MAX} 字以内（当前 ${description.length} 字）` });
        }
        personaGenerating = true;
        try {
          const draft = await generatePersonaDraft({
            projectDir: PROJECT_DIR,
            description,
            maxChars: personaEffectiveMax(),
            onLog: (msg) => log(msg),
          });
          const saved = upsertPersona(PROJECT_DIR, {
            name: draft.draft.name,
            tagline: draft.draft.tagline,
            persona: draft.draft.persona,
          });
          log(
            `AI 生成人设「${saved.item.name}」（id=${saved.item.id}，model=${draft.model ?? "?"}，` +
              `描述 ${description.length} 字${draft.truncated.length ? `，超长已收短：${draft.truncated.join("、")}` : ""}）`,
          );
          ensurePersonaRoleSync(saved.item, "AI 生成人设");
          return sendJson(res, 200, {
            ok: true,
            item: publicPersona(saved.item),
            items: saved.items.map(publicPersona),
            model: draft.model,
            truncated: draft.truncated,
          });
        } catch (error) {
          log(`AI 生成人设失败：${String(error.message).slice(0, 200)}`);
          return sendJson(res, 500, { ok: false, error: error.message });
        } finally {
          personaGenerating = false;
        }
      }

      if (url.pathname === "/api/auto") {
        const enabled = body.enabled === true;
        const intervalMinutes = Number(body.intervalMinutes ?? autoCfg.intervalMinutes);
        if (!Number.isFinite(intervalMinutes) || intervalMinutes < AUTO_INTERVAL_MIN || intervalMinutes > AUTO_INTERVAL_MAX) {
          return sendJson(res, 400, {
            ok: false,
            error: `间隔需在 ${AUTO_INTERVAL_MIN}–${AUTO_INTERVAL_MAX} 分钟之间`,
          });
        }
        const headless = body.headless === true;
        const scheduleInput = body.schedule && typeof body.schedule === "object" ? body.schedule : {};
        const start = normalizeTime(scheduleInput.start);
        const end = normalizeTime(scheduleInput.end);
        if (scheduleInput.enabled === true && (!start || !end)) {
          return sendJson(res, 400, { ok: false, error: "时间格式应为 HH:MM（如 08:00）" });
        }
        const snapshot = applyAutoMode({
          enabled,
          intervalMinutes,
          headless,
          schedule: { enabled: scheduleInput.enabled === true, start, end },
        });
        if (snapshot && snapshot.ok === false) {
          log(`自动回复：拒绝开启（${snapshot.error}）`);
          return sendJson(res, 409, {
            ok: false,
            error: `${snapshot.error}。请先关掉那个控制台窗口，只保留一个实例。`,
          });
        }
        log(
          `自动回复设置：enabled=${enabled} interval=${snapshot.intervalMinutes}min ` +
            `headless=${snapshot.headless} schedule=${snapshot.schedule.enabled ? `${snapshot.schedule.start}-${snapshot.schedule.end}` : "off"}`,
        );
        return sendJson(res, 200, { ok: true, auto: snapshot });
      }

      /**
       * 在控制台里更换 DeepSeek API key（C-27，2026-10-17 作者要求「安全性第一」）。
       *
       * 这条链路上有四条硬规矩，改动前先读 scripts/api-key-store.mjs 顶部的说明：
       *   ① 写项目树外的 ~/.douyin-automation/secrets.json（项目内 tool/ 有近 200 个第三方包）；
       *   ② 原子写 + 0600，保留文件里原有的 base_url / model；
       *   ③ 先验证后写盘（GET /models，不花 token），验证不过一个字节都不落；
       *   ④ **日志里只有脱敏串**，接口响应里也只有脱敏串 —— 原文不出这个函数。
       */
      if (url.pathname === "/api/api-key") {
        if (!sameConsoleOrigin(req)) {
          log("密钥：拒绝跨源写入请求（Origin 端口与控制台不一致）");
          return sendJson(res, 403, { ok: false, error: "只接受来自控制台自己页面的请求" });
        }
        const verdict = validateApiKey(body.key);
        if (!verdict.ok) {
          log(`密钥：拒绝写入（${verdict.error}）`);
          return sendJson(res, 400, { ok: false, error: verdict.error });
        }
        const before = apiKeyStatus(PROJECT_DIR);
        if (body.verify !== false) {
          const check = await verifyApiKey(verdict.key, { baseUrl: before.baseUrl });
          if (!check.ok) {
            log(`密钥：验证未通过（${check.error}），未写入任何文件`);
            return sendJson(res, 400, { ok: false, error: check.error, stage: "verify" });
          }
        }
        let written;
        try {
          written = writeApiKey(verdict.key);
        } catch (error) {
          log(`密钥：写入失败（${error.message}）`);
          return sendJson(res, 500, { ok: false, error: `写不进密钥文件：${error.message}` });
        }
        const status = apiKeyStatus(PROJECT_DIR);
        log(`密钥：已更新（${status.masked}，生效来源 ${status.source}，文件 ${written.file}）`);
        return sendJson(res, 200, {
          ok: true,
          apiKey: status,
          savedTo: written.file,
          keptFields: written.keptFields,
          warning: status.envOverride
            ? "环境变量 DEEPSEEK_API_KEY 优先级最高：文件已写好，但当前仍在使用环境变量里的那把。清掉环境变量并重开控制台后才会切到新的。"
            : null,
        });
      }

      if (url.pathname === "/api/api-key/clear") {
        if (!sameConsoleOrigin(req)) {
          log("密钥：拒绝跨源移除请求（Origin 端口与控制台不一致）");
          return sendJson(res, 403, { ok: false, error: "只接受来自控制台自己页面的请求" });
        }
        let result;
        try {
          result = clearApiKey();
        } catch (error) {
          log(`密钥：移除失败（${error.message}）`);
          return sendJson(res, 500, { ok: false, error: `改不动密钥文件：${error.message}` });
        }
        const status = apiKeyStatus(PROJECT_DIR);
        log(`密钥：已从文件移除（${result.file}）`);
        return sendJson(res, 200, {
          ok: true,
          apiKey: status,
          removed: result.removed,
          warning: status.envOverride ? "环境变量里还有一把 key，它仍会被优先使用。" : null,
        });
      }

      if (url.pathname === "/api/persona-rotation") {
        /**
         * 固定一套 / 多套随机（C-19，C-23 起池子来自人设库）。
         * 页面在「固定一套」时会隐藏随机池，只提交 single —— 所以这里必须容忍
         * pool 缺失：单套模式下池子保留原值即可，绝不能因为没提交就把它清空
         * （否则作者切一次固定模式，之前勾好的随机池就没了）。
         */
        const lib = loadPersonaLibrary(PROJECT_DIR);
        const allowedIds = lib.items.map((item) => item.id);
        const current = loadRotation(PROJECT_DIR, { validIds: allowedIds }).rotation;
        const mode = body.mode === "random" ? "random" : "single";
        const single = allowedIds.includes(body.single) ? body.single : allowedIds[0];
        let pool = Array.isArray(body.pool)
          ? [...new Set(body.pool.filter((id) => allowedIds.includes(id)))]
          : current.pool;
        if (mode === "random" && pool.length === 0) {
          return sendJson(res, 400, { ok: false, error: "随机池至少要勾选 1 套人设" });
        }
        if (pool.length === 0) pool = [single];
        const saved = saveRotation(PROJECT_DIR, { mode, single, pool });
        log(`保存人设模式：mode=${mode} single=${single} pool=${pool.join(",")}`);
        return sendJson(res, 200, {
          ok: true,
          rotation: {
            mode: saved.rotation.mode,
            single: saved.rotation.single,
            pool: saved.rotation.pool,
            options: lib.items.map((item) => ({ id: item.id, name: item.name })),
          },
        });
      }

      if (url.pathname === "/api/cooperation") {
        const id = String(body.id ?? "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少线索 id" });
        try {
          /**
           * ★ C-50：页面勾「我已回复」= 直接移除（写一行 removed，读取时过滤）。
           *   `done` 标记是旧行为，保留兼容；新页面一律传 remove。
           */
          if (body.remove === true) removeCooperation(PROJECT_DIR, id);
          else markCooperationDone(PROJECT_DIR, id, body.done !== false);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        log(`合作待办：${body.remove === true ? "已回复并移除" : body.done === false ? "撤销已处理" : "标记已处理"} ${id}`);
        return sendJson(res, 200, { ok: true, cooperation: loadCooperationInbox(PROJECT_DIR) });
      }

      /**
       * 清空「已判定不回」缓存（C-26）。
       * 什么时候需要点它：改了风险规则想立刻重新判一遍、或怀疑某条被误判成不回了。
       * 平时不用动 —— 判据一变（规则/提示词/策略文件内容改动）缓存本来就会自动整批作废。
       */
      /**
       * 第 8 节直接改话术与占比（C-32，2026-10-17 作者要求）。
       *
       * 校验用**和运行时同一把尺子**（长度窗口、硬红线词、站外引导），不合格的句子
       * 当场指出来是哪一句、为什么 —— 而不是保存成功、运行时静默跳过。
       * 保存后不需要重启：每轮 judge 都是新起进程，读的是磁盘上的这份配置。
       */
      /**
       * 给新加的风险人设一键生成四组话术（C-33）。**只生成、不落盘**：
       * 结果填进页面上的文本框，用户看过、改过、点「保存话术」才生效。
       * 生成结果同样过 checkRiskLine，不合格的当场丢掉并把原因回报给页面。
       */
      if (url.pathname === "/api/risk-replies/generate") {
        const rules = readJsonSafe(RULES_PATH) ?? {};
        const limits = {
          minChars: Number(rules.reply_length?.min_chars ?? 4),
          maxChars: Number(rules.reply_length?.max_chars ?? 40),
          hardKeywords: rules.risk_block_hard?.keywords ?? [],
          outboundKeywords: rules.outbound?.keywords ?? [],
        };
        const name = String(body.name ?? "").trim();
        log(`风险话术：开始为「${name || "未命名"}」生成`);
        try {
          const out = await generateRolePools({
            projectDir: PROJECT_DIR,
            name,
            hint: body.hint ?? "",
            limits,
            onLog: (m) => log(`[生成] ${m}`),
          });
          log(`风险话术：为「${name}」生成 ${out.count} 句（丢弃不合规 ${out.dropped.length} 句）`);
          return sendJson(res, 200, {
            ok: true,
            name,
            pools: out.pools,
            count: out.count,
            dropped: out.dropped.slice(0, 12),
            droppedCount: out.dropped.length,
          });
        } catch (error) {
          log(`风险话术：生成失败（${error.message}）`);
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      /* ---------------- 风险人设库（链路1） ---------------- */

      /**
       * 写「谁负责 + 占比」。只动 active / weight，不动话术本体 ——
       * 话术仍然走 /api/risk-replies（逐句编辑那条路），两条路写同一个文件。
       */
      if (url.pathname === "/api/risk-personas") {
        const result = saveRiskRouting(PROJECT_DIR, body);
        if (!result.ok) {
          log(`风险人设库：拒绝保存（${result.error}）`);
          return sendJson(res, 400, { ok: false, error: result.error });
        }
        log(`风险人设库：已保存占比（${describeRouting(result.view)}）`);
        return sendJson(res, 200, { ok: true, riskPersonas: result.view });
      }

      /** 删掉某套风险话术 → 人设回到「未生成话术」板（人设本身不动） */
      if (url.pathname === "/api/risk-personas/revoke") {
        const personaId = String(body.personaId ?? "").trim();
        const result = revokeRiskReplies(PROJECT_DIR, personaId);
        if (!result.ok) {
          log(`风险人设库：删除话术失败（${result.error}）`);
          return sendJson(res, 400, { ok: false, error: result.error });
        }
        log(
          `风险人设库：已删除「${result.removed.roleName}」的话术，回到未生成` +
            `${result.rebalanced ? "；剩余占比已自动补齐" : ""}`,
        );
        return sendJson(res, 200, {
          ok: true,
          removed: result.removed,
          rebalanced: result.rebalanced,
          riskPersonas: result.view,
        });
      }

      /** 给某套人设生成风险话术（后台跑，页面轮询 roleSync 看进度） */
      if (url.pathname === "/api/risk-personas/generate") {
        const personaId = String(body.personaId ?? "").trim();
        const lib = loadPersonaLibrary(PROJECT_DIR);
        const item = lib.items.find((p) => p.id === personaId);
        if (!item) return sendJson(res, 404, { ok: false, error: "没有这套人设（刷新页面看看）" });
        const started = startRoleGeneration(item, { source: "风险人设库手动生成" });
        if (!started.ok) return sendJson(res, 409, { ok: false, error: started.error });
        return sendJson(res, 202, { ok: true, status: "generating", personaId, name: item.name });
      }

      if (url.pathname === "/api/risk-replies") {
        const rules = readJsonSafe(RULES_PATH) ?? {};
        const limits = {
          minChars: Number(rules.reply_length?.min_chars ?? 4),
          maxChars: Number(rules.reply_length?.max_chars ?? 40),
          hardKeywords: rules.risk_block_hard?.keywords ?? [],
          outboundKeywords: rules.outbound?.keywords ?? [],
        };
        const result = saveRiskReplies(PROJECT_DIR, body, limits);
        if (!result.ok) {
          log(`风险话术：拒绝保存（${(result.errors || []).length} 处不合格）`);
          return sendJson(res, 400, { ok: false, errors: result.errors || [], error: "有句子没通过校验，未保存" });
        }
        log(`风险话术：已保存 ${result.roles} 套 / ${result.lines} 句`);
        return sendJson(res, 200, {
          ok: true,
          saved: { roles: result.roles, lines: result.lines, file: path.relative(PROJECT_DIR, result.file) },
          replies: describeRiskReplies(loadRiskReplies(PROJECT_DIR)),
        });
      }

      if (url.pathname === "/api/skip-cache") {
        try {
          const result = clearSkipCache(PROJECT_DIR);
          log(`清空「已判定不回」缓存：${result.removed} 条`);
          const policy = loadRiskPolicy(PROJECT_DIR);
          return sendJson(res, 200, {
            ok: true,
            removed: result.removed,
            cache: {
              ...skipCacheStats(PROJECT_DIR),
              enabled: policy.cache.enabled,
              maxAgeDays: policy.cache.maxAgeDays,
            },
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: `清空失败：${error.message}` });
        }
      }

      if (url.pathname === "/api/rules") {
        const result = patchRules(body);
        if (result.ok) {
          log(
            `保存规则 maxChars=${body.maxChars ?? "-"} minChars=${body.minChars ?? "-"}` +
              (body.noReplyRules !== undefined ? ` 自定义不回复=${body.noReplyRules.length} 条` : ""),
          );
        }
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      /**
       * 自定义「不回复」规则：一句话 → 关键词表（C-38）。
       * 只返回草稿，**不落盘** —— 作者看一眼、改一改，再随「保存规则」一起提交。
       */
      if (url.pathname === "/api/no-reply/generate") {
        const prompt = String(body.prompt ?? "").trim();
        if (!prompt) return sendJson(res, 400, { ok: false, error: "先写一句：什么评论不回复" });
        const cfg = readJsonSafe(RULES_PATH) ?? {};
        const existing = describeNoReplyRules(cfg).items.map((r) => r.name);
        log(`不回复规则：按提示词生成（${prompt.length} 字，现有 ${existing.length} 条规则）`);
        try {
          const out = await generateNoReplyRule({
            projectDir: PROJECT_DIR,
            prompt,
            existing,
            onLog: (m) => log(`[生成] ${m}`),
          });
          log(`不回复规则：生成「${out.name}」${out.keywords.length} 个关键词（丢弃 ${out.dropped.length} 个）`);
          return sendJson(res, 200, {
            ok: true,
            name: out.name,
            desc: out.desc,
            keywords: out.keywords,
            regex: out.regex,
            dropped: out.dropped.slice(0, 8),
            droppedCount: out.dropped.length,
            model: out.model,
          });
        } catch (error) {
          log(`不回复规则：生成失败（${error.message}）`);
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      if (url.pathname === "/api/work-context") {
        const raw = body.works && typeof body.works === "object" ? body.works : {};
        /**
         * ★ 合并式保存，不是整体替换。
         * 页面只提交**改动过**的条目；若整体替换，未提交的作品说明会被静默清空 ——
         * 作者填了 10 条、改 1 条，另外 9 条全没了，而且不会有任何提示。
         * 空 note 表示"清空这条说明"，显式删除；没提交的键一律原样保留。
         */
        const existing = loadContext(PROJECT_DIR).ctx;
        const merged = { ...existing.works };
        let changed = 0;
        for (const [k, v] of Object.entries(raw)) {
          const key = String(k ?? "").trim();
          if (!key) continue;
          const note = String(v?.note ?? "").trim().slice(0, NOTE_MAX);
          if (note) {
            merged[key] = { note, updated: new Date().toISOString().slice(0, 10) };
            changed += 1;
          } else if (merged[key]) {
            delete merged[key];
            changed += 1;
          }
        }
        const saved = saveContext(PROJECT_DIR, { works: merged });
        const written = Object.keys(saved.ctx.works).length;
        log(`保存视频语境：本轮提交 ${changed} 条，现存 ${written} 条（只记条数，不记内容）`);
        return sendJson(res, 200, { ok: true, filledCount: written, noteMax: NOTE_MAX });
      }

      if (url.pathname === "/api/preview") {
        const text = String(body.text ?? "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "请先输入一条评论" });
        if (text.length > 300) return sendJson(res, 400, { ok: false, error: "预览输入请控制在 300 字以内" });
        const result = await runPreview(text, body.username, body.workKey);
        log(`预览一条评论（${text.length} 字，${body.workKey ? "含作品语境" : "无作品语境"}）`);
        return sendJson(res, result.ok ? 200 : 500, result);
      }

      if (url.pathname === "/api/refresh-works") {
        if (runState.running) return sendJson(res, 409, { ok: false, error: "已有任务在运行" });
        if (loginState.child) return sendJson(res, 409, { ok: false, error: "登录窗口还开着，先关掉它再拉列表" });
        // ★ 不调 npm：直接用 node 执行 tool/src/list-douyin-works.mjs（= npm run works 的实质）。
        //   原因：Windows 上 spawn 一个 .cmd + shell:false 会同步抛 EINVAL（Node 安全限制），
        //   且 shell:true 拼中文路径有转义风险。直接跑 node 脚本两头都避开。
        //   cwd 必须是 tool/ —— 脚本内部按相对路径读写 comments-output/。
        startProcess("refresh-works", NODE_BIN, [path.join(TOOL_DIR, "src", "list-douyin-works.mjs")], {
          cwd: TOOL_DIR,
          env: envForTool(),
        });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === "/api/run") {
        if (runState.running) return sendJson(res, 409, { ok: false, error: "已有任务在运行" });
        if (loginState.child) {
          return sendJson(res, 409, { ok: false, error: "登录窗口还开着（它独占浏览器存档），先在上面点「我扫完了」或「取消」" });
        }
        const stage = Number(body.stage ?? 1);
        if (![1, 2].includes(stage)) return sendJson(res, 400, { ok: false, error: "stage 只能是 1 或 2" });
        if (stage === 2 && body.confirm !== "SEND") {
          return sendJson(res, 400, { ok: false, error: "发送需要二次确认（confirm 必须为 SEND）" });
        }
        const args = [path.join(PROJECT_DIR, "scripts", "run-batch.mjs")];
        if (stage === 2) args.push("--stage", "2");
        if (body.dryRun) args.push("--dry-run");
        startProcess(stage === 2 ? "run-stage2" : "run-stage1", NODE_BIN, args);
        return sendJson(res, 200, { ok: true, stage });
      }

      /**
       * 扫码登录 / 换账号（C-28）。三个动作：
       *   start  —— 拉起 auth-douyin.mjs（可见浏览器 + 登录页）
       *   done   —— 替作者在它的 stdin 敲回车（"我扫完了"）
       *   cancel —— 直接杀掉（"不换了"）
       * 都走端口级同源校验：这些接口会在本机弹窗口、动登录态，不能给别的网页调用。
       */
      if (url.pathname.startsWith("/api/login/")) {
        if (!sameConsoleOrigin(req)) {
          log(`扫码登录：拒绝跨源请求 ${url.pathname}`);
          return sendJson(res, 403, { ok: false, error: "只接受来自控制台自己页面的请求" });
        }
        if (url.pathname === "/api/login/start") {
          const result = startLogin({ fresh: body.fresh === true });
          if (!result.ok) return sendJson(res, 409, { ok: false, error: result.error });
          return sendJson(res, 200, { ok: true, login: result.login });
        }
        if (url.pathname === "/api/login/done") {
          const result = confirmLoginDone();
          if (!result.ok) return sendJson(res, 409, { ok: false, error: result.error });
          return sendJson(res, 200, { ok: true, login: loginSnapshot() });
        }
        if (url.pathname === "/api/login/cancel") {
          const result = cancelLogin();
          if (!result.ok) return sendJson(res, 409, { ok: false, error: result.error });
          return sendJson(res, 200, { ok: true, login: loginSnapshot() });
        }
      }
    }

    return sendJson(res, 404, { ok: false, error: "未知接口" });
  } catch (error) {
    log(`接口出错 ${url.pathname}：${error.message}`);
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

/**
 * 探测某端口上是不是"本项目的控制台"。
 * 返回：
 *   { occupied: false }                     —— 端口空闲 / 不是本项目的服务
 *   { occupied: true, stale: false }        —— 本项目控制台，且版本一致 → 可以直接指过去
 *   { occupied: true, stale: true }         —— 本项目控制台，但是**旧版本** → 绝不能指过去
 */
async function probeExistingConsole(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { occupied: false };
    const json = await res.json();
    if (json?.app !== "douyin-console") return { occupied: false };
    /**
     * ★ 2026-10-19 补：光认版本号不够，还要认"是谁"。
     *   用户桌面上可能同时摆着好几份项目副本，
     *   没改端口的旧副本默认都用 5180。旧逻辑只看 app + 版本：
     *     · 版本不同 → 直接 process.exit(1)，副本永远起不来（用户以为"点不开新控制台"）
     *     · 版本恰好相同 → 把浏览器指到**另一个项目**的控制台，
     *       改的是 A 项目配置、看到的是 B 项目数据，比打不开更坑
     *   两个不同项目的控制台本来就该并存（各自的 config/ 互不相干），
     *   所以这里把 projectDir 一并返回，交给 listen() 决定是"复用"还是"换端口"。
     */
    const existingDir = path.resolve(String(json.projectDir || ""));
    return {
      occupied: true,
      stale: json.version !== CONSOLE_VERSION,
      sameProject: Boolean(json.projectDir) && existingDir === path.resolve(PROJECT_DIR),
      version: json.version,
      projectDir: json.projectDir || "",
    };
  } catch {
    return { occupied: false };
  }
}

function openConsolePage(url) {
  if (!NO_OPEN && process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
}

/**
 * ★ 2026-10-19：监听相关的 handler 只注册一次，端口用「currentPort」状态推进。
 *
 * 旧写法把 error / listening 两个回调都塞进 listen() 内部 —— 换端口重试就会
 * 重复注册：第一次失败的 listening 回调仍然挂在 server 上，等第二次 listen 成功，
 * **两个回调同时触发**，于是控制台打印两遍面板、浏览器被打开两次
 * （一次旧项目的 5180、一次自己的 5181），用户看到的就是"还是旧控制台"。
 * 这是实测出来的，不是推测：改之前跑一次会输出两个不同的地址。
 */
let currentPort = BASE_PORT;
let listenAttempt = 0;

// 畸形 HTTP 报文（裸 % 转义、非法请求行）只会被拒绝，不会带走挂机进程
server.on("clientError", (error, socket) => {
  log(`HTTP 解析失败（已拒绝，进程继续）：${error.code || error.message}`);
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  } catch {
    /* socket 可能已经断了 */
  }
});

server.once("listening", () => {
  // 端口以内核实际分配的为准，不信闭包里的入参（重试过就是错的）
  const actual = server.address()?.port ?? currentPort;
  const url = `http://127.0.0.1:${actual}/`;
  console.log("");
  console.log("  ╔══════════════════════════════════════════════════╗");
  console.log(boxLine(`   ${INSTANCE_NAME}`));
  console.log("  ╚══════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  地址：${url}`);
  console.log("  （只在本机可访问；关掉这个窗口就等于关闭控制台）");
  console.log("");
  log(`控制台已启动 ${url}`);
  openConsolePage(url);
});

server.on("error", async (error) => {
  if (error.code === "EADDRINUSE" && listenAttempt < 10) {
    const port = currentPort;
    // ★ 先问一句：占着这个端口的，是不是**本项目**的控制台？
    //   同一项目 + 版本一致 → 直接把浏览器指过去，本进程退出。
    //   同一项目 + 版本更旧 → 绝不指过去（页面新、接口旧 = 「未知接口」），报错退出。
    //   不同项目       → 谁也别占谁的，顺延到下一个端口各起各的。
    //   为什么（2026-10-19 实测踩到）：桌面上有多个项目副本，都用 5180。
    //   旧逻辑只比版本号，副本版本一旦落后就永远起不来（用户以为"点不开新控制台"）；
    //   版本号若恰好相同，又会把浏览器指到另一个项目上 —— 改 A 项目的配置，看 B 项目的数据。
    const existing = await probeExistingConsole(port);

    // ① 同一个项目的控制台：复用（版本一致）或劝退（版本旧）。
    if (existing.occupied && existing.sameProject) {
      if (!existing.stale) {
        const url = `http://127.0.0.1:${port}/`;
        console.log("");
        console.log(`  已有控制台在运行：${url}`);
        console.log("  已为你直接打开它（不重复启动第二个实例）。");
        console.log("");
        log(`检测到已有实例 ${url}，本次启动直接退出`);
        openConsolePage(url);
        process.exit(0);
      }
      console.log("");
      console.log(`  [!] 端口 ${port} 上挂着一个**旧版本**的控制台进程（${existing.version}）。`);
      console.log("      页面文件是新的（从磁盘现读），但接口是旧的（在旧进程内存里）——");
      console.log("      点任何按钮都会报「未知接口」，所以本次拒绝直接连过去。");
      console.log("      → 请找到旧控制台的黑窗口关掉它；找不到就把下面的进程结束：");
      console.log(`         taskkill /F /PID <占用 ${port} 的进程>`);
      console.log("      然后重新双击 3-控制台.bat 即可。");
      console.log("");
      log(`端口 ${port} 上是旧版本控制台，拒绝指过去，本次启动退出`);
      process.exit(1);
    }

    // ② 另一个项目的控制台占了端口：不抢、不指过去，直接顺延一个端口。
    //    两个副本的 config/ 完全独立，把浏览器指到对方那儿等于"改 A 看 B"。
    if (existing.occupied) {
      /**
       * ★ 2026-10-19：固定端口（instance.json 的 port）被别的项目占住 → 不再顺延。
       *   固定地址的意义就是"永远是这一个"，静默换成 5191 等于白固定，
       *   用户下次照旧要在两个地址之间猜。所以这里明确失败，把处理办法打出来。
       */
      if (PORT_PINNED) {
        console.log("");
        console.log(`  [!] 端口 ${port} 被另一个项目的控制台占用了：`);
        console.log(`      ${existing.projectDir || "(未知路径)"}`);
        console.log("");
        console.log(`      本副本的地址已固定为 http://127.0.0.1:${port}/（config/instance.json），`);
        console.log("      不会为了避免冲突换到别的端口 —— 换了地址就不再固定了。");
        console.log("");
        console.log("      两条出路，任选一条：");
        console.log("       1) 关掉占用这个端口的控制台黑窗口，再重新双击 3-控制台.bat");
        console.log(`       2) 打开 config/instance.json，把 "port" 改成另一个空端口（例如 ${port + 10}）`);
        console.log("");
        log(`固定端口 ${port} 被另一项目占用（${existing.projectDir}），本次启动退出（不自动顺延）`);
        process.exit(1);
      }
      console.log("");
      console.log(`  [i] 端口 ${port} 已被另一个项目的控制台占用：`);
      console.log(`      ${existing.projectDir || "(未知路径)"}`);
      console.log(`      两个副本的配置互不相干，本实例改用 ${port + 1}，不影响它。`);
      console.log("");
      log(`端口 ${port} 被另一项目控制台占用（${existing.projectDir}），顺延到 ${port + 1}`);
    }

    listenAttempt += 1;
    currentPort = port + 1;
    server.listen(currentPort, "127.0.0.1");
    return;
  }
  console.error(`[控制台] 启动失败：${error.message}`);
  process.exit(1);
});

server.listen(currentPort, "127.0.0.1");

if (!fs.existsSync(path.join(UI_DIR, "index.html"))) {
  console.error(`[控制台] 找不到页面文件 ${path.join(UI_DIR, "index.html")}`);
  process.exit(1);
}

// 控制台启动时恢复自动模式：开关在磁盘上，重启窗口不会把它弄丢。
// 首轮延迟 60 秒再跑 —— 给登录态探测、页面加载留出时间，也避免"刚开窗口就弹浏览器"吓人一跳。
if (autoCfg.enabled) {
  if (AUTO_DISABLED_BY_ENV) {
    autoState.suppressedReason = "本实例以「不自动回复」模式启动（DOUYIN_CONSOLE_NO_AUTO=1），只做配置与排查";
    log("自动回复：DOUYIN_CONSOLE_NO_AUTO=1，本实例不排程（配置里的开关保持原样）");
    console.log("  自动回复模式：本实例已禁用（测试/排查模式），不会自动发送");
  } else {
    const lock = acquireAutoLock();
    if (!lock.ok) {
      autoState.suppressedReason = "另一个控制台正在负责自动回复";
      log(
        `自动回复：另一个控制台（PID ${lock.holder?.pid ?? "?"}，端口 ${lock.holder?.port ?? "?"}）` +
          "正在负责自动回复，本实例不重复排程",
      );
      console.log(
        `  自动回复模式：另一个控制台（PID ${lock.holder?.pid ?? "?"}）正在跑，本实例只做配置，不重复发送`,
      );
    } else {
      if (lock.warning) log(`自动回复：${lock.warning}`);
      console.log(
        `  自动回复模式：开启中（每 ${autoCfg.intervalMinutes} 分钟一轮；` +
          `${autoCfg.headless ? "后台运行不弹窗" : "窗口模式"}；` +
          `${autoCfg.schedule.enabled ? `时段 ${autoCfg.schedule.start}–${autoCfg.schedule.end}` : "全天"}；首轮 60 秒后开始）`,
      );
      log(`自动回复：控制台启动，恢复调度（间隔 ${autoCfg.intervalMinutes} 分钟）`);
      scheduleAutoRun(60_000);
    }
  }
}

// 退出时交还"自动调度"锁：否则下次启动要等 PID 被复用才会被判定为过期
process.on("exit", releaseAutoLock);
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => {
    releaseAutoLock();
    process.exit(0);
  });
}
