import path from "node:path";
import {
  DEFAULT_COMMENT_PAGE_URL,
  DEFAULT_USER_DATA_DIR,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import {
  getEffectiveTimeout,
  sanitizeCollectedComment,
  setReplyFilterDebugEnabled
} from "./lib/common.mjs";
import { downloadCommentImages } from "./lib/comment-images.mjs";
import { ensureCommentPageReady, hardRefreshPage } from "./lib/comment-page.mjs";
import {
  captureCommentListFingerprint,
  collectComments,
  waitForCommentListChange
} from "./lib/comment-ops.mjs";
import { processCommentsInteractively, replyToComments } from "./lib/reply-flow.mjs";
import { emitResult, loadReplyCommentsFile } from "./lib/result-store.mjs";
import {
  fetchAllWorksWithRetry,
  findTargetWorkWithRetry,
  getSelectedWorkOutput,
  getWorksOutput
} from "./lib/works-panel.mjs";
import {
  getReplyCountMap,
  getRepliedCommentRows,
  getUserHistoryMap,
  incrementReplyCount,
  upsertComments
} from "./lib/db-ops.mjs";
import { backfillReplyLedgerEvents, getReplyLedgerMatchMap } from "./lib/reply-ledger.mjs";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_UI_TIMEOUT_MS = 30000;
const DEFAULT_WORKS_TIMEOUT_MS = 45000;
const DEFAULT_WORKS_IDLE_MS = 5000;
const DEFAULT_COMMENTS_TIMEOUT_MS = 300000;
const DEFAULT_COMMENTS_IDLE_MS = 5000;
const DEFAULT_REPLY_TIMEOUT_MS = 30000;
const DEFAULT_REPLY_SETTLE_MS = 1800;
const DEFAULT_REPLY_TYPE_DELAY_MS = 50;
const DEFAULT_REPLY_LIMIT = 20;
const DEFAULT_EXPORT_LIMIT = 5000;
const DEFAULT_REPLY_FLOW_TIMEOUT_MS = 1800000;
const REPLY_FLOW_TIMEOUT_BUFFER_MS = 60000;
const REPLY_FLOW_TIMEOUT_PER_PLAN_MS = 20000;
const MAX_AUTO_REPLY_FLOW_TIMEOUT_MS = 7200000;

export const DEFAULT_WORKS_OUTPUT_PATH = path.resolve("comments-output/list-works.json");
export const DEFAULT_EXPORT_OUTPUT_PATH = path.resolve("comments-output/unreplied-comments.json");
export const DEFAULT_EXPORT_ALL_OUTPUT_PATH = path.resolve("comments-output/all-comments.json");
export const DEFAULT_REPLY_OUTPUT_PATH = path.resolve("comments-output/reply-comments-result.json");
export const DEFAULT_INTERACTIVE_OUTPUT_PATH = path.resolve(
  "comments-output/interactive-comments-result.json"
);

function buildRuntimeBudget(totalTimeoutMs = 0) {
  if (!totalTimeoutMs) {
    return {
      deadline: null,
      maxRuntimeMs: 0
    };
  }

  return {
    deadline: Date.now() + totalTimeoutMs,
    maxRuntimeMs: totalTimeoutMs
  };
}

function resolveReplyFlowTimeout(replyLimit, replyPlanCount) {
  const targetReplyCount = Math.max(
    1,
    Math.min(replyLimit || replyPlanCount || 1, replyPlanCount || replyLimit || 1)
  );

  return Math.min(
    MAX_AUTO_REPLY_FLOW_TIMEOUT_MS,
    Math.max(
      DEFAULT_REPLY_FLOW_TIMEOUT_MS,
      REPLY_FLOW_TIMEOUT_BUFFER_MS + targetReplyCount * REPLY_FLOW_TIMEOUT_PER_PLAN_MS
    )
  );
}

function filterKnownRepliedComments(comments, workTitle, replyCountMap, options = {}) {
  const ledgerMap = getReplyLedgerMatchMap(workTitle, comments, options);
  let skippedByDatabase = 0;
  let skippedByLedger = 0;
  const filtered = comments.filter((comment) => {
    const key = `${comment.username}|||${comment.commentText}`;
    if ((replyCountMap.get(key) ?? 0) >= 1) {
      skippedByDatabase += 1;
      return false;
    }
    if (ledgerMap.has(key)) {
      skippedByLedger += 1;
      return false;
    }
    return true;
  });

  if (skippedByDatabase > 0) {
    console.log(`[db] 过滤掉 ${skippedByDatabase} 条已回复过的评论`);
  }
  if (skippedByLedger > 0) {
    console.log(`[ledger] 过滤掉 ${skippedByLedger} 条回复台账中已有记录的评论`);
  }
  return filtered;
}

function syncReplyLedgerFromDatabase(options = {}) {
  try {
    const rows = getRepliedCommentRows();
    const result = backfillReplyLedgerEvents(
      rows.map((row) => ({
        workTitle: row.work_title,
        username: row.username,
        commentText: row.comment_text,
        publishText: row.comment_time,
        replyMessage: row.reply_message,
        status: "db_backfill",
        source: "database_reply_count"
      })),
      options
    );

    if (result.appendedCount > 0) {
      console.log(`[ledger] 已从数据库回填 ${result.appendedCount} 条历史回复记录`);
    }
    return result;
  } catch (error) {
    // 数据库损坏或丢失时不能阻断台账保护；后续回复前仍会独立读取台账。
    console.warn(`[ledger] 数据库历史回填失败，继续使用现有独立台账: ${error?.message ?? error}`);
    return {
      appendedCount: 0,
      existingCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function openCommentSession(options = {}) {
  setReplyFilterDebugEnabled(options.debug);

  const runtimeBudget = buildRuntimeBudget(options.timeoutMs || 0);
  const { context, page } = await launchPersistentPage({
    userDataDir: options.profileDir || DEFAULT_USER_DATA_DIR,
    headless: Boolean(options.headless)
  });

  context.setDefaultTimeout(getEffectiveTimeout(runtimeBudget, DEFAULT_UI_TIMEOUT_MS));
  context.setDefaultNavigationTimeout(
    getEffectiveTimeout(runtimeBudget, DEFAULT_NAVIGATION_TIMEOUT_MS)
  );
  page.setDefaultTimeout(getEffectiveTimeout(runtimeBudget, DEFAULT_UI_TIMEOUT_MS));
  page.setDefaultNavigationTimeout(
    getEffectiveTimeout(runtimeBudget, DEFAULT_NAVIGATION_TIMEOUT_MS)
  );

  try {
    await ensureCommentPageReady(page, options.pageUrl || DEFAULT_COMMENT_PAGE_URL, {
      ...runtimeBudget,
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
      promptForLogin: options.promptForLogin
    });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  return {
    context,
    page,
    runtimeBudget
  };
}

async function resolveTargetWork(page, runtimeBudget, workTitle, workPublishText = "") {
  return findTargetWorkWithRetry(page, {
    ...runtimeBudget,
    workTitle,
    workPublishText,
    selectWhenMatched: true,
    timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
    idleMs: DEFAULT_WORKS_IDLE_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
  });
}

export async function listWorks(options = {}) {
  const outputPath = options.outputPath || DEFAULT_WORKS_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const works = await fetchAllWorksWithRetry(page, {
      ...runtimeBudget,
      timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
      idleMs: DEFAULT_WORKS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    await emitResult(
      {
        pageUrl: options.pageUrl || DEFAULT_COMMENT_PAGE_URL,
        count: works.length,
        works: getWorksOutput(works)
      },
      outputPath
    );
  } finally {
    await context.close();
  }
}

export async function exportUnrepliedComments(options = {}) {
  if (!options.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:export -- "作品短标题"');
  }

  syncReplyLedgerFromDatabase(options);

  const outputPath = options.outputPath || DEFAULT_EXPORT_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      options.workTitle,
      options.workPublishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);
    const comments = await collectComments(page, {
      ...runtimeBudget,
      limit: options.limit || DEFAULT_EXPORT_LIMIT,
      timeoutMs: DEFAULT_COMMENTS_TIMEOUT_MS,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork) ?? { title: "" };
    const includeHistory = !options.noHistory;

    // 在写入当前批次之前查询历史 & 回复次数，确保数据只含过去记录
    let historyMap = new Map();
    let replyCountMap = new Map();
    try {
      if (includeHistory) {
        historyMap = getUserHistoryMap(comments.map((c) => c.username));
      }
      replyCountMap = getReplyCountMap(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 查询历史/回复次数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    const exportComments = filterKnownRepliedComments(
      comments,
      selectedWorkOutput.title,
      replyCountMap,
      options
    );

    await downloadCommentImages(exportComments, outputPath);

    await emitResult(
      {
        selectedWork: selectedWorkOutput,
        count: exportComments.length,
        comments: exportComments.map((comment) => {
          const entry = {
            username: comment.username,
            commentText: comment.commentText,
            replyMessage: ""
          };
          if (comment.imagePaths?.length > 0) {
            entry.imagePaths = comment.imagePaths;
          }
          if (includeHistory) {
            entry.history = historyMap.get(comment.username) ?? [];
          }
          return entry;
        })
      },
      outputPath
    );

    try {
      upsertComments(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText,
          replyMessage: null
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 写入评论失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }
  } finally {
    await context.close();
  }
}

export async function exportAllComments(options = {}) {
  if (!options.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:export-all -- "作品短标题"');
  }

  syncReplyLedgerFromDatabase(options);

  const outputPath = options.outputPath || DEFAULT_EXPORT_ALL_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    // 强制刷新（清空 HTTP 缓存，等价于 Ctrl+Shift+R），确保拿到最新评论数据。
    // 必须在选作品之前刷新，刷新后 SPA 状态重置，选作品后不再刷新。
    await hardRefreshPage(page, {
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS
    });
    // 刷新后等"选择作品"按钮出现，确认页面已恢复就绪
    await page
      .locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")')
      .first()
      .waitFor({ state: "visible", timeout: DEFAULT_UI_TIMEOUT_MS });

    // 等页面自动加载默认作品的评论（最多 8 秒），拿到稳定「旧指纹」
    await waitForCommentListChange(page, "", 8000).catch(() => {});
    const preSelectionFingerprint = await captureCommentListFingerprint(page).catch(() => "");

    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      options.workTitle,
      options.workPublishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);

    // 等评论列表从「旧指纹」切换到目标作品内容
    await waitForCommentListChange(page, preSelectionFingerprint, 10000).catch(() => {});

    const comments = await collectComments(page, {
      ...runtimeBudget,
      filterMode: "all",
      limit: options.limit || DEFAULT_EXPORT_LIMIT,
      timeoutMs: DEFAULT_COMMENTS_TIMEOUT_MS,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork) ?? { title: "" };
    const includeHistory = !options.noHistory;

    // 在写入当前批次之前查询历史 & 回复次数，确保数据只含过去记录
    let historyMap = new Map();
    let replyCountMap = new Map();
    try {
      if (includeHistory) {
        historyMap = getUserHistoryMap(comments.map((c) => c.username));
      }
      replyCountMap = getReplyCountMap(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 查询历史/回复次数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    const exportComments = filterKnownRepliedComments(
      comments,
      selectedWorkOutput.title,
      replyCountMap,
      options
    );

    await downloadCommentImages(exportComments, outputPath);

    await emitResult(
      {
        selectedWork: selectedWorkOutput,
        count: exportComments.length,
        comments: exportComments.map((comment) => {
          const entry = {
            username: comment.username,
            commentText: comment.commentText
          };
          if (comment.imagePaths?.length > 0) {
            entry.imagePaths = comment.imagePaths;
          }
          if (includeHistory) {
            entry.history = historyMap.get(comment.username) ?? [];
          }
          return entry;
        })
      },
      outputPath
    );

    try {
      upsertComments(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText,
          replyMessage: null
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 写入评论失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }
  } finally {
    await context.close();
  }
}

export async function interactiveComments(options = {}) {
  if (!options.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:interactive -- "作品短标题"');
  }
  if (typeof options.requestDecision !== "function") {
    throw new Error("Interactive comments require a requestDecision callback.");
  }

  syncReplyLedgerFromDatabase(options);

  const outputPath = options.outputPath || DEFAULT_INTERACTIVE_OUTPUT_PATH;
  const decisionLimit = options.limit || DEFAULT_REPLY_LIMIT;
  const decisionTimeoutMs = Math.max(1000, Number(options.decisionTimeoutMs) || 600000);
  const interactiveFlowTimeoutMs = Math.min(
    12 * 60 * 60 * 1000,
    Math.max(
      DEFAULT_REPLY_FLOW_TIMEOUT_MS,
      60000 + decisionLimit * (decisionTimeoutMs + DEFAULT_REPLY_TIMEOUT_MS)
    )
  );
  // stdin 是逐条 JSONL 决策通道，登录失效时不能再用它等待人工按 Enter。
  const { context, page, runtimeBudget } = await openCommentSession({
    ...options,
    promptForLogin: false
  });

  try {
    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      options.workTitle,
      options.workPublishText || ""
    );
    const selectedWork = getSelectedWorkOutput(targetWork) ?? {
      title: options.workTitle,
      publishText: options.workPublishText || ""
    };
    console.log(`已选中作品：${selectedWork.title}`);

    if (typeof options.onReady === "function") {
      await options.onReady({
        selectedWork,
        outputPath: path.resolve(outputPath)
      });
    }

    let databaseChecksEnabled = true;
    let historyChecksEnabled = !options.noHistory;
    const getKnownReplyEvidence = (comment) => {
      if (!databaseChecksEnabled) {
        return null;
      }

      try {
        const replyCountMap = getReplyCountMap(selectedWork.title, [comment]);
        const replyCount = replyCountMap.get(`${comment.username}|||${comment.commentText}`) ?? 0;
        return {
          replied: replyCount >= 1,
          replyCount
        };
      } catch (error) {
        databaseChecksEnabled = false;
        console.warn(
          `[db] 逐条回复检查失败，后续继续依赖页面和独立台账: ${error?.message ?? error}`
        );
        return null;
      }
    };

    const enrichComment = async (comment) => {
      const enrichedComment = sanitizeCollectedComment(comment);
      let history = [];

      if (historyChecksEnabled) {
        try {
          history = getUserHistoryMap([comment.username]).get(comment.username) ?? [];
        } catch (error) {
          historyChecksEnabled = false;
          console.warn(`[db] 用户历史查询失败，后续不再查询: ${error?.message ?? error}`);
        }
      }

      try {
        upsertComments(selectedWork.title, [
          {
            username: comment.username,
            commentText: comment.commentText,
            commentTime: comment.publishText || null,
            replyMessage: null
          }
        ]);
      } catch (error) {
        console.warn(`[db] 当前评论写入失败（不影响交互流程）: ${error?.message ?? error}`);
      }

      const imageDownload = await downloadCommentImages([enrichedComment], outputPath);
      if (imageDownload.failed > 0) {
        enrichedComment.imageDownload = imageDownload;
      }
      if (!options.noHistory) {
        enrichedComment.history = history;
      }
      return enrichedComment;
    };

    const afterReplyResult = ({ comment, decision, result }) => {
      if (result.status !== "replied" && result.status !== "sent_unconfirmed") {
        return;
      }

      try {
        upsertComments(selectedWork.title, [
          {
            username: comment.username,
            commentText: comment.commentText,
            commentTime: comment.publishText || null,
            replyMessage: decision.replyMessage
          }
        ]);
        if (result.status === "replied") {
          incrementReplyCount(selectedWork.title, comment.username, comment.commentText);
        }
      } catch (error) {
        // 独立台账已在点击发送前写入；数据库故障不能使已发送评论失去去重保护。
        console.warn(`[db] 交互回复结果写入失败（台账仍有效）: ${error?.message ?? error}`);
      }
    };

    const buildOutput = (summary) => ({
      fetchedAt: new Date().toISOString(),
      mode: "interactive_comments",
      interactiveMode: options.mode || "smart",
      pageUrl: options.pageUrl || DEFAULT_COMMENT_PAGE_URL,
      selectedWork,
      preview: Boolean(options.preview),
      ...summary
    });

    const replySummary = await processCommentsInteractively(page, {
      ...runtimeBudget,
      selectedWork,
      decisionLimit,
      interactiveMode: options.mode || "smart",
      preview: Boolean(options.preview),
      requestDecision: options.requestDecision,
      onProgress: async (progress) => {
        await emitResult(buildOutput(progress.summary), outputPath);
        if (typeof options.onProgress === "function") {
          await options.onProgress(progress);
        }
      },
      getKnownReplyEvidence,
      enrichComment,
      afterReplyResult,
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      replySettleMs: DEFAULT_REPLY_SETTLE_MS,
      replyTypeDelayMs: DEFAULT_REPLY_TYPE_DELAY_MS,
      timeoutMs: interactiveFlowTimeoutMs,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
      skipUnrepliedFilter: Boolean(options.skipUnrepliedFilter),
      replyLedgerPath: options.replyLedgerPath
    });

    const output = buildOutput(replySummary);
    await emitResult(output, outputPath);
    return {
      outputPath: path.resolve(outputPath),
      ...output
    };
  } finally {
    await context.close();
  }
}

export async function replyComments(options = {}) {
  if (!options.planFile) {
    throw new Error("Missing plan file. Usage: npm run comments:reply -- plan.json");
  }

  syncReplyLedgerFromDatabase(options);

  const replyCommentsSource = await loadReplyCommentsFile(options.planFile);
  const allReplyPlans = replyCommentsSource.plans ?? [];
  const selectedWorkHint = replyCommentsSource.selectedWork;
  const skipUnrepliedFilter =
    replyCommentsSource.skipUnrepliedFilter || options.skipUnrepliedFilter;

  if (!selectedWorkHint?.title) {
    throw new Error("Reply plan file must contain selectedWork.title.");
  }

  // 过滤掉已回复过的评论（reply_count >= 1）
  let replyPlans = allReplyPlans;
  try {
    const replyCountMap = getReplyCountMap(
      selectedWorkHint.title,
      allReplyPlans.map((p) => ({
        username: p.username,
        commentText: p.commentText
      }))
    );
    const skippedByCount = [];
    replyPlans = allReplyPlans.filter((plan) => {
      const count = replyCountMap.get(`${plan.username}|||${plan.commentText}`) ?? 0;
      if (count >= 1) {
        skippedByCount.push({ username: plan.username, replyCount: count });
        return false;
      }
      return true;
    });
    if (skippedByCount.length > 0) {
      console.log(`[db] 跳过 ${skippedByCount.length} 条已回复过的评论`);
    }
  } catch (dbError) {
    console.warn(`[db] 查询回复次数失败（继续使用全部计划）: ${dbError?.message ?? dbError}`);
  }

  const ledgerMap = getReplyLedgerMatchMap(selectedWorkHint.title, replyPlans, options);
  const skippedByLedger = [];
  replyPlans = replyPlans.filter((plan) => {
    const event = ledgerMap.get(`${plan.username}|||${plan.commentText}`);
    if (!event) {
      return true;
    }
    skippedByLedger.push({
      username: plan.username,
      status: event.status,
      recordedAt: event.recordedAt
    });
    return false;
  });
  if (skippedByLedger.length > 0) {
    console.log(`[ledger] 跳过 ${skippedByLedger.length} 条回复台账中已有记录的评论`);
  }

  const outputPath = options.outputPath || DEFAULT_REPLY_OUTPUT_PATH;
  const replyLimit = options.limit || DEFAULT_REPLY_LIMIT;
  const keepBrowserOpenAfterRun = Boolean(options.keepOpen || options.dryRun) && !options.headless;
  const replyFlowTimeoutMs = resolveReplyFlowTimeout(replyLimit, replyPlans.length);
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      selectedWorkHint.title,
      selectedWorkHint.publishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);
    const replySummary = await replyToComments(page, {
      ...runtimeBudget,
      replyPlans,
      selectedWork: targetWork,
      replyLimit,
      replyDryRun: Boolean(options.dryRun),
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      replySettleMs: DEFAULT_REPLY_SETTLE_MS,
      replyTypeDelayMs: DEFAULT_REPLY_TYPE_DELAY_MS,
      timeoutMs: replyFlowTimeoutMs,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS,
      skipUnrepliedFilter,
      replyLedgerPath: options.replyLedgerPath
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork);

    await emitResult(
      {
        fetchedAt: new Date().toISOString(),
        mode: "reply_comments",
        pageUrl: options.pageUrl || DEFAULT_COMMENT_PAGE_URL,
        selectedWork: selectedWorkOutput,
        replyCommentsFile: options.planFile,
        replyDryRun: Boolean(options.dryRun),
        replyLimit,
        ...replySummary
      },
      outputPath
    );

    try {
      const dbRows = replyPlans.map((plan) => ({
        username: plan.username,
        commentText: plan.commentText,
        replyMessage: plan.replyMessage
      }));
      upsertComments(selectedWorkOutput?.title ?? selectedWorkHint.title, dbRows);
    } catch (dbError) {
      console.warn(`[db] 写入回复失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    // 对本次实际成功回复的评论，在数据库中递增 reply_count。
    // 必须用 plan 里的 username/commentText：页面上 fuzzy 匹配到的正文可能与库里（导出 JSON）不完全一致，
    // 若用快照字符串 UPDATE 会 0 行，reply_count 不增，导致同一评论被反复导出、反复回复。
    try {
      const workTitleForDb = selectedWorkOutput?.title ?? selectedWorkHint.title;
      const planById = new Map(replyPlans.map((p) => [p.id, p]));
      const repliedResults = replySummary.results.filter((r) => r.status === "replied");
      let updatedRows = 0;
      let missedRows = 0;
      for (const r of repliedResults) {
        const plan = r.replyPlanId != null ? planById.get(r.replyPlanId) : null;
        const username = plan?.username ?? r.username;
        const commentText = plan?.commentText ?? r.commentText;
        const changes = incrementReplyCount(workTitleForDb, username, commentText);
        if (changes > 0) {
          updatedRows += 1;
        } else {
          missedRows += 1;
        }
      }
      if (updatedRows > 0) {
        console.log(`[db] 已更新 ${updatedRows} 条评论的回复计数`);
      }
      if (missedRows > 0) {
        console.warn(
          `[db] 有 ${missedRows} 条成功回复未在库中匹配到行（reply_count 未增加），请核对作品标题与导出 plan 是否一致`
        );
      }
    } catch (dbError) {
      console.warn(`[db] 更新回复计数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    if (keepBrowserOpenAfterRun) {
      await promptForEnter("流程已完成，检查浏览器现场后按 Enter 关闭浏览器");
    }
  } finally {
    await context.close();
  }
}
