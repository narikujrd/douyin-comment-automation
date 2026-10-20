#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
import { DEFAULT_INTERACTIVE_OUTPUT_PATH, interactiveComments } from "./comment-workflow.mjs";
import { normalizeText, toPositiveInteger } from "./lib/common.mjs";
import {
  createProtocolEvent,
  INTERACTIVE_MODES,
  MAX_INTERACTIVE_REPLY_CHARS,
  normalizeInteractiveDecision
} from "./lib/interactive-comment-protocol.mjs";
import { InteractiveDecisionInbox } from "./lib/interactive-decision-inbox.mjs";
import {
  getInteractiveWorkOutputPath,
  loadInteractiveWorkQueue,
  summarizeInteractiveWorkResults
} from "./lib/interactive-work-queue.mjs";

const DEFAULT_DECISION_TIMEOUT_SECONDS = 600;

function printHelp() {
  console.log(`
Usage:
  npm run comments:interactive -- "作品短标题"
  npm run comments:interactive -- [options] "作品短标题"

JSONL protocol:
  stdout emits one JSON event per line; diagnostics are written to stderr.
  For every comment_found event, write one JSON decision plus a newline to stdin:
  {"requestId":"...","action":"reply","replyMessage":"...","reason":"..."}
  {"requestId":"...","action":"skip","reason":"...","remember":false}
  {"action":"stop","reason":"..."}

Options:
  --mode <name>               smart | quality | save-token (default: smart)
  --limit <n>                 Max comments sent for model decisions (default: 20)
  --decision-timeout <sec>    Max wait for each decision (default: 600)
  --preview                    Generate decisions without typing or sending replies
  --no-history                 Do not attach this user's prior comments
  --skip-unreplied-filter      Scan all comments; page/ledger checks still apply
  --work-publish-text <text>   Disambiguate works with similar titles
  --out <path>                 Checkpoint/result JSON path
  --works-file <path>          Process works[] from one JSON file in this process
  --max-works <n>              Max works read from --works-file (default: 10)
  --out-dir <path>             Per-work output directory for --works-file
  --decision-dir <path>        File inbox fallback when background stdin closes
  --total-timeout <ms>         Stop starting works after this total runtime
  --profile <path>             Playwright profile path
  --timeout <ms>               Max runtime for each work
  --headless                   Run Chromium in headless mode (visible by default)
  --debug                      Print debug logs to stderr
  --help                       Print this help
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    workTitle: "",
    workPublishText: "",
    mode: "smart",
    limit: 20,
    decisionTimeoutMs: DEFAULT_DECISION_TIMEOUT_SECONDS * 1000,
    preview: false,
    noHistory: false,
    skipUnrepliedFilter: false,
    outputPath: DEFAULT_INTERACTIVE_OUTPUT_PATH,
    worksFile: "",
    maxWorks: 10,
    outputDirectory: path.dirname(DEFAULT_INTERACTIVE_OUTPUT_PATH),
    decisionDirectory: "",
    totalTimeoutMs: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--mode": {
        const mode = normalizeText(argv[index + 1] ?? "").toLowerCase();
        if (!INTERACTIVE_MODES.has(mode)) {
          throw new Error(`--mode expects smart, quality, or save-token; received: ${mode}`);
        }
        args.mode = mode;
        index += 1;
        break;
      }
      case "--limit":
        args.limit = toPositiveInteger(argv[index + 1], "--limit");
        index += 1;
        break;
      case "--decision-timeout":
        args.decisionTimeoutMs = toPositiveInteger(argv[index + 1], "--decision-timeout") * 1000;
        index += 1;
        break;
      case "--preview":
      case "--dry-run":
        args.preview = true;
        break;
      case "--no-history":
        args.noHistory = true;
        break;
      case "--skip-unreplied-filter":
        args.skipUnrepliedFilter = true;
        break;
      case "--work-publish-text":
        args.workPublishText = normalizeText(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--out":
        args.outputPath = path.resolve(argv[index + 1] ?? DEFAULT_INTERACTIVE_OUTPUT_PATH);
        index += 1;
        break;
      case "--works-file":
        args.worksFile = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--max-works":
        args.maxWorks = toPositiveInteger(argv[index + 1], "--max-works");
        index += 1;
        break;
      case "--out-dir":
        args.outputDirectory = path.resolve(argv[index + 1] ?? path.dirname(args.outputPath));
        index += 1;
        break;
      case "--decision-dir":
        args.decisionDirectory = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--total-timeout":
        args.totalTimeoutMs = toPositiveInteger(argv[index + 1], "--total-timeout");
        index += 1;
        break;
      default:
        if (!arg.startsWith("-") && !args.workTitle) {
          args.workTitle = normalizeText(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function compactSummary(summary) {
  const counts = { ...summary };
  delete counts.results;
  return counts;
}

function emitProtocol(type, payload = {}) {
  process.stdout.write(`${JSON.stringify(createProtocolEvent(type, payload))}\n`);
}

function createDecisionReceiver(decisionInbox, timeoutMs, decisionRunDirectory = "") {
  return async (request) => {
    const decisionPath = decisionRunDirectory
      ? path.join(decisionRunDirectory, `${request.requestId}.json`)
      : "";
    emitProtocol("comment_found", {
      requestId: request.requestId,
      sequence: request.sequence,
      selectedWork: request.selectedWork,
      routing: request.routing,
      comment: request.comment,
      decisionPath: decisionPath || undefined,
      decisionSchema: {
        reply: {
          requestId: request.requestId,
          action: "reply",
          replyMessage: `required; at most ${MAX_INTERACTIVE_REPLY_CHARS} Unicode characters`,
          reason: "optional"
        },
        skip: {
          requestId: request.requestId,
          action: "skip",
          reason: "optional",
          remember: "optional boolean; true permanently skips this comment"
        },
        stop: {
          action: "stop",
          reason: "optional"
        }
      }
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const decisionInput = await decisionInbox.next({
        decisionPath,
        timeoutMs: remainingMs
      });

      if (decisionInput.done) {
        return {
          action: "stop",
          reason: "stdin_closed"
        };
      }

      const line = String(decisionInput.value ?? "").trim();
      if (!line) {
        continue;
      }

      try {
        return normalizeInteractiveDecision(line, request.requestId);
      } catch (error) {
        emitProtocol("decision_rejected", {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    throw new Error(`Decision timed out after ${timeoutMs}ms.`);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.workTitle && !args.worksFile) {
    throw new Error(
      'Missing work title or --works-file. Usage: npm run comments:interactive -- "作品短标题"'
    );
  }
  if (args.workTitle && args.worksFile) {
    throw new Error("Use either one work title or --works-file, not both.");
  }

  // stdout 保持为机器可解析的 JSONL；浏览器与数据库诊断统一写到 stderr。
  console.log = (...values) => console.error(...values);
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  const lineIterator = lines[Symbol.asyncIterator]();
  const decisionInbox = new InteractiveDecisionInbox(lineIterator);
  const decisionRunDirectory = args.decisionDirectory
    ? path.join(args.decisionDirectory, crypto.randomUUID())
    : "";
  if (decisionRunDirectory) {
    fs.mkdirSync(decisionRunDirectory, { recursive: true, mode: 0o700 });
  }
  const requestDecision = createDecisionReceiver(
    decisionInbox,
    args.decisionTimeoutMs,
    decisionRunDirectory
  );
  const queuedWorks = args.worksFile
    ? loadInteractiveWorkQueue(args.worksFile, args.maxWorks).works
    : [{ title: args.workTitle, publishText: args.workPublishText }];
  const isWorkQueue = Boolean(args.worksFile);
  const startedAt = Date.now();
  const workResults = [];
  let queueExitReason = "all_works_complete";

  try {
    for (let workIndex = 0; workIndex < queuedWorks.length; workIndex += 1) {
      const queuedWork = queuedWorks[workIndex];
      const elapsedMs = Date.now() - startedAt;
      const remainingTotalMs = args.totalTimeoutMs
        ? Math.max(0, args.totalTimeoutMs - elapsedMs)
        : 0;
      if (args.totalTimeoutMs && remainingTotalMs === 0) {
        queueExitReason = "total_timeout_before_next_work";
        break;
      }

      const workTimeoutMs = args.totalTimeoutMs
        ? args.timeoutMs
          ? Math.min(args.timeoutMs, remainingTotalMs)
          : remainingTotalMs
        : args.timeoutMs;
      const workOptions = {
        ...args,
        workTitle: queuedWork.title,
        workPublishText: queuedWork.publishText,
        outputPath: isWorkQueue
          ? getInteractiveWorkOutputPath(args.outputDirectory, workIndex)
          : args.outputPath,
        timeoutMs: workTimeoutMs,
        requestDecision,
        onReady: ({ selectedWork, outputPath }) => {
          emitProtocol(isWorkQueue ? "work_ready" : "ready", {
            workIndex: workIndex + 1,
            workCount: queuedWorks.length,
            selectedWork,
            outputPath,
            mode: args.mode,
            preview: args.preview,
            decisionLimit: args.limit
          });
        },
        onProgress: ({ latestResult, summary }) => {
          emitProtocol("result", {
            workIndex: workIndex + 1,
            workCount: queuedWorks.length,
            requestId: latestResult.requestId,
            result: latestResult,
            summary: compactSummary(summary)
          });
          if (isWorkQueue && latestResult.status === "sent_unconfirmed") {
            throw new Error(
              "sent_unconfirmed: reply was clicked but page confirmation was unavailable; stopping the work queue without retry."
            );
          }
        }
      };

      let result;
      try {
        result = await interactiveComments(workOptions);
      } catch (error) {
        emitProtocol("fatal", {
          workIndex: workIndex + 1,
          workCount: queuedWorks.length,
          queuedWork,
          error: error instanceof Error ? error.message : String(error)
        });
        process.exitCode = 1;
        return;
      }

      workResults.push(result);
      if (isWorkQueue) {
        emitProtocol("work_complete", {
          workIndex: workIndex + 1,
          workCount: queuedWorks.length,
          outputPath: result.outputPath,
          selectedWork: result.selectedWork,
          summary: compactSummary(result)
        });
      }
      if (result.exitReason === "stopped_by_decision") {
        queueExitReason = "stopped_by_decision";
        break;
      }
    }

    if (isWorkQueue) {
      emitProtocol("complete", {
        worksFile: args.worksFile,
        outputDirectory: args.outputDirectory,
        summary: summarizeInteractiveWorkResults(workResults, queueExitReason)
      });
    } else {
      const [result] = workResults;
      emitProtocol("complete", {
        outputPath: result.outputPath,
        selectedWork: result.selectedWork,
        summary: compactSummary(result)
      });
    }
  } finally {
    lines.close();
    if (decisionRunDirectory) {
      fs.rmSync(decisionRunDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  emitProtocol("fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
