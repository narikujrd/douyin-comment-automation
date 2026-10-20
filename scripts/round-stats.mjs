/**
 * round-stats.mjs — 每轮跑完记一笔，供控制台「今天花了多少 / 回了多少」用（C-29）
 *
 * 为什么需要它：`judge-report-work-XX.json` 是**每轮覆盖写**的，只有"当前这一轮"，
 * 上周花了多少根本查不回来。而 `reply-ledger.jsonl` 只有回复条数、没有成本。
 * 所以每轮结束追加一行到 `state/round-stats.jsonl`（只追加、不覆盖）。
 *
 * 为什么不在 run-batch 里写：跑一轮有两条入口（手动按钮 / 自动调度），
 * 都在 ui-server 的 startProcess 里生出来；挂在这一处，两条入口自动都覆盖。
 * 反过来说：**直接用命令行跑 run-batch 不会进统计** —— 这是已知取舍，
 * 那种场景本来就有人在终端前面看着。
 *
 * 字段口径：
 *   · total   = 本轮采到的候选评论数（各作品相加）
 *   · replied = 真正发出去的条数
 *   · skipped = 判定后不回/被拦的条数
 *   · costCny = 各报告里 estimatedCny 之和（模型自己报的用量 × 公开单价，仅估算）
 */

import fs from "node:fs";
import path from "node:path";

export const ROUND_STATS_REL_PATH = "state/round-stats.jsonl";

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 扫出本轮时间窗内被写过的裁决报告，把数字加起来 */
export function summarizeReportsSince(outDir, startedAtMs) {
  const result = { reports: 0, total: 0, replied: 0, skipped: 0, costCny: 0, calls: 0 };
  let files = [];
  try {
    files = fs.readdirSync(outDir).filter((f) => /^judge-report-.*\.json$/.test(f));
  } catch {
    return result;
  }
  const since = Number(startedAtMs || 0) - 2000; // 容 2 秒误差：文件 mtime 与 startedAt 不完全同源
  for (const f of files) {
    const full = path.join(outDir, f);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (since > 0 && stat.mtimeMs < since) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    result.reports += 1;
    result.total += Number(data.total) || 0;
    result.replied += Number(data.replied) || 0;
    result.skipped += Number(data.skipped) || 0;
    result.costCny += Number(data.llm?.estimatedCny) || 0;
    result.calls += Number(data.llm?.calls) || 0;
  }
  return result;
}

/** 追加一轮。写失败不影响跑批 —— 统计是附加物，不能反过来把主流程搞挂 */
export function appendRoundStat(projectDir, record) {
  const file = path.join(projectDir, ROUND_STATS_REL_PATH);
  const at = record.at || new Date().toISOString();
  const line = {
    at,
    date: localDate(new Date(at)),
    kind: String(record.kind || "unknown"),
    exitCode: record.exitCode ?? null,
    durationMs: Number(record.durationMs) || 0,
    reports: Number(record.reports) || 0,
    total: Number(record.total) || 0,
    replied: Number(record.replied) || 0,
    skipped: Number(record.skipped) || 0,
    costCny: Number(record.costCny) || 0,
    calls: Number(record.calls) || 0,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    return { ok: true, line };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function readRoundStats(projectDir) {
  const file = path.join(projectDir, ROUND_STATS_REL_PATH);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 半行（写到一半断电）跳过，不影响其余 */
    }
  }
  return out;
}

/** 今日汇总 + 最近 7 天（给页面顶部那条「今天」和一张小便签） */
export function summarize(projectDir, { now = new Date() } = {}) {
  const rows = readRoundStats(projectDir);
  const today = localDate(now);
  const blank = () => ({ rounds: 0, failedRounds: 0, total: 0, replied: 0, skipped: 0, costCny: 0, calls: 0 });

  const day = blank();
  const byDay = new Map();
  const bump = (bucket, r) => {
    bucket.rounds += 1;
    bucket.total += Number(r.total) || 0;
    bucket.replied += Number(r.replied) || 0;
    bucket.skipped += Number(r.skipped) || 0;
    bucket.costCny += Number(r.costCny) || 0;
    bucket.calls += Number(r.calls) || 0;
    if (r.exitCode !== 0) bucket.failedRounds += 1;
  };
  for (const r of rows) {
    const d = r.date || localDate(new Date(r.at));
    const bucket = byDay.get(d) || blank();
    bump(bucket, r);
    if (d === today) bump(day, r);
    byDay.set(d, bucket);
  }
  day.costCny = Math.round(day.costCny * 10000) / 10000;

  const recent = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 7)
    .map(([date, v]) => ({ date, ...v, costCny: Math.round(v.costCny * 10000) / 10000 }));

  return { today: { date: today, ...day }, recent, totalRounds: rows.length };
}

/** 连续失败轮数（只用最近若干轮判断，给"挂机没人管"报警用） */
export function consecutiveFailures(projectDir, limit = 3) {
  const rows = readRoundStats(projectDir).slice(-limit);
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].exitCode !== 0) n += 1;
    else break;
  }
  return n;
}
