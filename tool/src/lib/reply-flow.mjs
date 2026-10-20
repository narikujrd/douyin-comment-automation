import {
  getEffectiveTimeout,
  isThreadedUnrepliedAllowed,
  logReplyFilterDebug,
  normalizeText,
  normalizeUsername,
  summarizeCommentsForLog
} from "./common.mjs";
import {
  advanceCommentScroll,
  applyUnrepliedCommentsFilter,
  captureCommentListFingerprint,
  getCommentTerminalIndicator,
  markCommentScrollContainer,
  resetCommentScrollToTop,
  waitForCommentListChange,
  waitForCommentsArea
} from "./comment-ops.mjs";
import { extractCommentSnapshot } from "./comment-snapshot.mjs";
import {
  getReplyLedgerEntry,
  recordReplyLedgerEvent,
  reserveReplyLedgerAttempt
} from "./reply-ledger.mjs";
import {
  buildInteractiveRequestId,
  classifyInteractiveComment,
  normalizeInteractiveDecision
} from "./interactive-comment-protocol.mjs";

/** 与平台常见限制一致：按 Unicode 码点计数字符（汉字、标点、字母、空格各计 1），超出则截断 */
const MAX_REPLY_MESSAGE_CHARS = 400;

function truncateReplyMessage(text) {
  const s = text == null ? "" : String(text);
  const codePoints = [...s];
  if (codePoints.length <= MAX_REPLY_MESSAGE_CHARS) {
    return { text: s, truncated: false };
  }
  return {
    text: codePoints.slice(0, MAX_REPLY_MESSAGE_CHARS).join(""),
    truncated: true
  };
}

function buildVisibleUsernameCounts(snapshot, processedSignatures) {
  const counts = new Map();

  for (const comment of snapshot) {
    if (!comment?.signature || processedSignatures.has(comment.signature)) {
      continue;
    }

    const username = normalizeUsername(comment.username).toLowerCase();
    if (!username) {
      continue;
    }

    counts.set(username, (counts.get(username) || 0) + 1);
  }

  return counts;
}

function countRemainingPlansForUsername(replyPlans, processedPlanIds, username) {
  let count = 0;

  for (const plan of replyPlans) {
    if (processedPlanIds.has(plan.id)) {
      continue;
    }

    if (normalizeUsername(plan.username).toLowerCase() !== username) {
      continue;
    }

    count += 1;
  }

  return count;
}

function commentTextsMatch(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function findCurrentInteractiveComment(snapshot, originalComment) {
  const exactMatch = snapshot.find(
    (comment) => comment.signature && comment.signature === originalComment.signature
  );
  if (exactMatch) {
    return exactMatch;
  }

  const originalUsername = normalizeUsername(originalComment.username).toLowerCase();
  const candidates = snapshot.filter((comment) => {
    return (
      normalizeUsername(comment.username).toLowerCase() === originalUsername &&
      commentTextsMatch(comment.commentText, originalComment.commentText)
    );
  });
  if (candidates.length === 1) {
    return candidates[0];
  }

  const originalPublishText = normalizeText(originalComment.publishText);
  if (originalPublishText) {
    const publishMatches = candidates.filter(
      (comment) => normalizeText(comment.publishText) === originalPublishText
    );
    if (publishMatches.length === 1) {
      return publishMatches[0];
    }
  }

  return null;
}

function matchReplyPlan(comment, replyPlans, processedPlanIds, visibleUsernameCounts) {
  if (!Array.isArray(replyPlans) || replyPlans.length === 0) {
    return null;
  }

  const commentUsername = normalizeUsername(comment.username).toLowerCase();
  const remainingPlanCount = countRemainingPlansForUsername(
    replyPlans,
    processedPlanIds,
    commentUsername
  );
  const visibleCommentCount = visibleUsernameCounts.get(commentUsername) || 0;

  for (const plan of replyPlans) {
    if (processedPlanIds.has(plan.id)) {
      continue;
    }

    if (!plan.username) {
      continue;
    }

    if (normalizeUsername(plan.username).toLowerCase() !== commentUsername) {
      continue;
    }

    const requireCommentMatch = Boolean(normalizeText(plan.commentText));
    if (requireCommentMatch && !commentTextsMatch(plan.commentText, comment.commentText)) {
      continue;
    }

    return {
      plan,
      matchMode: requireCommentMatch ? "username_comment" : "username_only",
      remainingPlanCount,
      visibleCommentCount
    };
  }

  return null;
}

function getNextReplyTarget(snapshot, options, processedSignatures, processedPlanIds) {
  if (!Array.isArray(options.replyPlans) || options.replyPlans.length === 0) {
    return null;
  }

  const visibleUsernameCounts = buildVisibleUsernameCounts(snapshot, processedSignatures);

  for (const comment of snapshot) {
    if (!comment.signature || processedSignatures.has(comment.signature)) {
      continue;
    }

    const matchedPlan = matchReplyPlan(
      comment,
      options.replyPlans,
      processedPlanIds,
      visibleUsernameCounts
    );
    if (!matchedPlan) {
      continue;
    }

    return {
      comment,
      plan: matchedPlan.plan,
      replyMessage: matchedPlan.plan.replyMessage,
      matchMode: matchedPlan.matchMode,
      remainingPlanCount: matchedPlan.remainingPlanCount,
      visibleCommentCount: matchedPlan.visibleCommentCount
    };
  }

  return null;
}

async function inspectCommentActions(commentLocator) {
  return commentLocator.evaluate((root) => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();

    for (const marked of root.querySelectorAll("[data-codex-toggle-action]")) {
      marked.removeAttribute("data-codex-toggle-action");
    }

    for (const marked of root.querySelectorAll("[data-codex-reply-action]")) {
      marked.removeAttribute("data-codex-reply-action");
    }

    const candidates = Array.from(root.querySelectorAll("button, div, span"));
    const toggleCandidate = candidates.find((node) => {
      const text = normalize(node.textContent || "");
      return text === "收起" || /^(?:查看|展开)?(?:全部)?\d+条回复$/.test(text);
    });
    const replyCandidate = candidates.find((node) => normalize(node.textContent || "") === "回复");
    const toggleText = normalize(toggleCandidate?.textContent || "");
    const replyCountMatch = toggleText.match(/(\d+)条回复/);
    const replyCount = replyCountMatch ? Number(replyCountMatch[1]) : null;
    const editableValues = Array.from(root.querySelectorAll('[contenteditable="true"]'))
      .map((node) => normalize(node.textContent || ""))
      .filter(Boolean)
      .slice(0, 2);
    const rootText = normalize(root.innerText || "");

    if (toggleCandidate instanceof HTMLElement) {
      toggleCandidate.setAttribute("data-codex-toggle-action", "true");
    }

    if (replyCandidate instanceof HTMLElement) {
      replyCandidate.setAttribute("data-codex-reply-action", "true");
    }

    return {
      hasToggle: toggleCandidate instanceof HTMLElement,
      toggleText,
      // “收起”说明线程已展开；无法解析非空回复标记时保守跳过，避免重复回复。
      hasExistingReplies:
        toggleCandidate instanceof HTMLElement &&
        (toggleText === "收起" || replyCount === null || replyCount > 0),
      replyCount,
      hasReplyButton: replyCandidate instanceof HTMLElement,
      openInputCount: root.querySelectorAll('[contenteditable="true"]').length,
      editableValues,
      textPreview: rootText.slice(0, 240)
    };
  });
}

async function waitForReplySendReady(page, commentLocator, timeoutMs, options = null) {
  const effectiveTimeoutMs = getEffectiveTimeout(options, timeoutMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < effectiveTimeoutMs) {
    const ready = await commentLocator.evaluate((root) => {
      const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
      const sendCandidate = Array.from(root.querySelectorAll("button, div, span")).find(
        (node) => normalize(node.textContent || "") === "发送"
      );

      if (!(sendCandidate instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(sendCandidate);
      const isButton = sendCandidate instanceof HTMLButtonElement;
      const disabled =
        (isButton && sendCandidate.disabled) ||
        sendCandidate.getAttribute("disabled") !== null ||
        sendCandidate.getAttribute("aria-disabled") === "true";

      return !disabled && style.pointerEvents !== "none" && style.visibility !== "hidden";
    });

    if (ready) {
      return;
    }

    await page.waitForTimeout(120);
  }

  throw new Error(`Timed out waiting for the send button after ${effectiveTimeoutMs}ms.`);
}

/**
 * 等待回复成功的页面证据。
 *
 * ★ 2026-10-16 修复假阳性：旧版把「线程里有回复 / 出现收起按钮」当作发送成功
 *   ——但线程本来就可能挂着观众自己的子回复，点开回复框线程也会展开，
 *   于是**发送失败也会被记成 replied**，数据库/台账随之污染，
 *   创作者中心却显示未回复（实际使用中反馈）。
 *   现在成功证据只有三种：
 *     ① 评论从未回复列表消失（comment_removed_from_current_filter）
 *     ② 评论区域内出现**我们自己的回复文案**（own_reply_text_visible，排除输入框）
 *     ③ 「回复成功/发送成功」toast（success_toast）
 */
async function waitForReplyConfirmation(page, commentLocator, timeoutMs, options = null, replyText = "") {
  const effectiveTimeoutMs = getEffectiveTimeout(options, timeoutMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < effectiveTimeoutMs) {
    const commentStillVisible = (await commentLocator.count().catch(() => 0)) > 0;
    if (!commentStillVisible) {
      return {
        confirmedBy: "comment_removed_from_current_filter"
      };
    }

    // ★ 关键修复：验证我们自己的回复文案真的出现在了评论区域里。
    //   必须先摘掉 contenteditable 输入框——发送失败时输入框里还留着刚打的字，
    //   不摘掉就会再次假阳性。
    if (replyText) {
      const ownPosted = await commentLocator
        .evaluate((root, expected) => {
          const clone = root.cloneNode(true);
          clone.querySelectorAll('[contenteditable="true"]').forEach((node) => node.remove());
          const normalize = (value = "") => String(value || "").replace(/\s+/g, "");
          return normalize(clone.innerText).includes(normalize(expected));
        }, replyText)
        .catch(() => false);
      if (ownPosted) {
        return {
          confirmedBy: "own_reply_text_visible"
        };
      }
    }

    const successToast = await page.evaluate(() => {
      const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
      return Array.from(document.querySelectorAll('[role="alert"], div, span'))
        .filter((node) => node instanceof HTMLElement)
        .find((node) => {
          const text = normalize(node.textContent || "");
          if (text !== "回复成功" && text !== "发送成功") {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })?.textContent;
    });
    if (successToast) {
      return {
        confirmedBy: "success_toast",
        message: successToast.replace(/\s+/g, " ").trim()
      };
    }

    await page.waitForTimeout(150);
  }

  return null;
}

function isResolvedPlanStatus(status) {
  return (
    status === "replied" ||
    status === "sent_unconfirmed" ||
    status === "dry_run_typed" ||
    status.startsWith("skipped_")
  );
}

function isReplyActionStatus(status) {
  return status === "replied" || status === "sent_unconfirmed" || status === "dry_run_typed";
}

async function safeReplyToComment(page, commentLocator, comment, options) {
  const { text: replyText, truncated: replyMessageTruncated } = truncateReplyMessage(
    options.replyMessage ?? ""
  );
  if (replyMessageTruncated) {
    logReplyFilterDebug("reply message truncated to max length", {
      maxChars: MAX_REPLY_MESSAGE_CHARS,
      originalCodePointCount: [...String(options.replyMessage ?? "")].length
    });
  }

  const result = {
    username: comment.username,
    commentText: comment.commentText,
    publishText: comment.publishText,
    status: "pending",
    appliedReplyMessage: replyText,
    replyMessageTruncated
  };
  let stage = "start";
  let sendClicked = false;
  let sendAttemptRecorded = false;
  const workTitle = options.selectedWork?.title || options.workTitle || "";
  const ledgerEvent = (status, source = "reply_flow") => ({
    workTitle,
    username: comment.username,
    commentText: comment.commentText,
    publishText: comment.publishText,
    replyMessage: replyText,
    status,
    source
  });

  try {
    logReplyFilterDebug("processing reply target", {
      username: comment.username,
      commentText: comment.commentText,
      publishText: comment.publishText
    });

    if (workTitle) {
      let ledgerEntry;
      try {
        ledgerEntry = getReplyLedgerEntry(
          workTitle,
          comment.username,
          comment.commentText,
          options
        );
      } catch (error) {
        logReplyFilterDebug("reply ledger could not be read; skipping send fail-closed", {
          username: comment.username,
          commentText: comment.commentText,
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          ...result,
          status: "skipped_reply_ledger_unavailable",
          appliedReplyMessage: "",
          error: error instanceof Error ? error.message : String(error)
        };
      }

      // ★ allowReReply（run-session 按「以创作者中心为准 + 重复评论上限 3 条」政策传入）：
      //   台账旧记录不再一票否决——页面「未回复」列表里的评论必须允许重试。
      //   （此处与匹配阶段的另一处台账检查是两道独立的门，2026-10-16 实测漏改这里
      //    导致重试仍被 skipped_reply_ledger 挡下，两处必须同时开。）
      if (ledgerEntry && !options.allowReReply) {
        logReplyFilterDebug("skipping comment found in durable reply ledger", {
          username: comment.username,
          commentText: comment.commentText,
          ledgerStatus: ledgerEntry.status,
          ledgerRecordedAt: ledgerEntry.recordedAt
        });
        return {
          ...result,
          status: "skipped_reply_ledger",
          appliedReplyMessage: "",
          ledgerEvidence: {
            status: ledgerEntry.status,
            recordedAt: ledgerEntry.recordedAt,
            source: ledgerEntry.source
          }
        };
      }
    }

    const actionState = await inspectCommentActions(commentLocator);
    logReplyFilterDebug("initial comment action state", {
      username: comment.username,
      commentText: comment.commentText,
      actionState
    });

    // ★ 与采集/发送链路同一开关：开启后，评论下挂着观众子回复（观众互聊）不再算"已回复"。
    //   平台「未回复」= 作者没直接回过这条根评论——2026-10-16 实测：这里漏了开关，
    //   「夸夸我」这类线程有观众回复的评论会在发送前被写成 page_replied 永久跳过。
    if (actionState.hasExistingReplies && !isThreadedUnrepliedAllowed()) {
      logReplyFilterDebug("skipping comment because page shows existing replies", {
        username: comment.username,
        commentText: comment.commentText,
        toggleText: actionState.toggleText,
        replyCount: actionState.replyCount
      });

      if (workTitle) {
        try {
          recordReplyLedgerEvent(ledgerEvent("page_replied", "page_reply_marker"), options);
        } catch (error) {
          logReplyFilterDebug("failed to heal reply ledger from page marker", {
            username: comment.username,
            commentText: comment.commentText,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        ...result,
        status: "skipped_already_replied",
        appliedReplyMessage: "",
        pageReplyEvidence: {
          toggleText: actionState.toggleText,
          replyCount: actionState.replyCount
        }
      };
    }

    if (!actionState.hasReplyButton) {
      return {
        ...result,
        status: "skipped_no_reply_button",
        appliedReplyMessage: ""
      };
    }

    const replyButton = commentLocator.locator('[data-codex-reply-action="true"]').first();
    stage = "click_reply_button";
    await replyButton.click();

    const inputBox = commentLocator.locator('div[contenteditable="true"]').last();
    stage = "wait_input_box";
    await inputBox.waitFor({
      state: "visible",
      timeout: getEffectiveTimeout(options, options.replyTimeoutMs)
    });
    stage = "type_reply";
    await inputBox.click();
    await inputBox.type(replyText, {
      delay: options.replyTypeDelayMs
    });

    if (options.replyDryRun) {
      stage = "settle_after_type";
      await page.waitForTimeout(Math.min(500, options.replySettleMs));
      logReplyFilterDebug("dry-run typed reply message", {
        username: comment.username,
        commentText: comment.commentText
      });

      return {
        ...result,
        status: "dry_run_typed"
      };
    }

    stage = "wait_send_button";
    await waitForReplySendReady(page, commentLocator, options.replyTimeoutMs, options);

    const sendButton = commentLocator.getByText("发送", { exact: true }).first();
    if (workTitle) {
      stage = "record_send_attempt";
      const reservation = reserveReplyLedgerAttempt(ledgerEvent("send_attempted"), options);
      if (!reservation.reserved) {
        await inputBox.evaluate((element) => {
          element.textContent = "";
          const inputEvent = element.ownerDocument.createEvent("Event");
          inputEvent.initEvent("input", true, false);
          element.dispatchEvent(inputEvent);
        });
        return {
          ...result,
          status:
            reservation.reason === "existing_entry"
              ? "skipped_reply_ledger"
              : "skipped_reply_ledger_busy",
          appliedReplyMessage: "",
          ledgerEvidence: reservation.existingEntry
            ? {
                status: reservation.existingEntry.status,
                recordedAt: reservation.existingEntry.recordedAt,
                source: reservation.existingEntry.source
              }
            : undefined
        };
      }
      sendAttemptRecorded = true;
    }
    stage = "click_send_button";
    await sendButton.click();
    sendClicked = true;
    logReplyFilterDebug("clicked send button", {
      username: comment.username,
      commentText: comment.commentText
    });

    stage = "confirm_reply";
    const replyConfirmation = await waitForReplyConfirmation(
      page,
      commentLocator,
      options.replyTimeoutMs,
      options,
      replyText
    );
    if (!replyConfirmation) {
      logReplyFilterDebug("send was clicked but page confirmation was not observed", {
        username: comment.username,
        commentText: comment.commentText
      });
      if (workTitle) {
        try {
          recordReplyLedgerEvent(ledgerEvent("sent_unconfirmed"), options);
        } catch (error) {
          logReplyFilterDebug("failed to append unconfirmed send to reply ledger", {
            username: comment.username,
            commentText: comment.commentText,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        ...result,
        status: "sent_unconfirmed",
        errorStage: stage,
        error:
          "发送已点击，但页面未在超时时间内显示回复成功证据；为避免重复回复，本计划不会自动重试。"
      };
    }

    logReplyFilterDebug("reply confirmed by page", {
      username: comment.username,
      commentText: comment.commentText,
      replyConfirmation
    });
    if (workTitle) {
      try {
        recordReplyLedgerEvent(ledgerEvent("replied"), options);
      } catch (error) {
        // send_attempted 已经持久化，即使最终状态追加失败，后续也会保守跳过。
        logReplyFilterDebug("failed to append confirmed status to reply ledger", {
          username: comment.username,
          commentText: comment.commentText,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      ...result,
      status: "replied",
      replyConfirmation
    };
  } catch (error) {
    if (sendClicked) {
      logReplyFilterDebug("send was clicked but confirmation check failed", {
        username: comment.username,
        commentText: comment.commentText,
        stage,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ...result,
        status: "sent_unconfirmed",
        errorStage: stage,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    if (sendAttemptRecorded || stage === "record_send_attempt") {
      logReplyFilterDebug("send stopped after durable attempt record; automatic retry disabled", {
        username: comment.username,
        commentText: comment.commentText,
        stage,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ...result,
        status: "skipped_send_attempt_recorded",
        appliedReplyMessage: "",
        errorStage: stage,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    logReplyFilterDebug("reply failed", {
      username: comment.username,
      commentText: comment.commentText,
      stage,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ...result,
      status: "error",
      errorStage: stage,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function getNextInteractiveComment(snapshot, processedSignatures) {
  return (
    snapshot.find((comment) => comment?.signature && !processedSignatures.has(comment.signature)) ??
    null
  );
}

function buildInteractiveSummary(state, options) {
  const results = state.results;
  return {
    mode: options.interactiveMode || "smart",
    preview: Boolean(options.preview),
    exitReason: state.exitReason || "running",
    exitDetails: state.exitDetails,
    elapsedMs: Date.now() - state.startedAt,
    configuredTimeoutMs: state.timeoutMs,
    configuredIdleMs: state.idleMs,
    decisionLimit: state.decisionLimit,
    decisionCount: state.decisionCount,
    repliedCount: results.filter((item) => item.status === "replied").length,
    sentUnconfirmedCount: results.filter((item) => item.status === "sent_unconfirmed").length,
    previewCount: results.filter((item) => item.status === "preview_generated").length,
    actedCount: results.filter(
      (item) =>
        item.status === "replied" ||
        item.status === "sent_unconfirmed" ||
        item.status === "preview_generated"
    ).length,
    skippedCount: results.filter((item) => item.status.startsWith("skipped_")).length,
    errorCount: results.filter((item) => item.status === "error").length,
    totalProcessed: results.length,
    results: [...results]
  };
}

async function persistPageReplyMarker(comment, options) {
  const workTitle = options.selectedWork?.title || options.workTitle || "";
  if (!workTitle) {
    return;
  }

  try {
    recordReplyLedgerEvent(
      {
        workTitle,
        username: comment.username,
        commentText: comment.commentText,
        publishText: comment.publishText,
        replyMessage: null,
        status: "page_replied",
        source: "interactive_page_reply_marker"
      },
      options
    );
  } catch (error) {
    logReplyFilterDebug("failed to persist interactive page reply marker", {
      username: comment.username,
      commentText: comment.commentText,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function persistDecisionSkip(comment, decision, options) {
  if (!decision.remember) {
    return null;
  }

  const workTitle = options.selectedWork?.title || options.workTitle || "";
  if (!workTitle) {
    return "Missing work title; skip decision was not persisted.";
  }

  try {
    recordReplyLedgerEvent(
      {
        workTitle,
        username: comment.username,
        commentText: comment.commentText,
        publishText: comment.publishText,
        replyMessage: null,
        status: "decision_skipped",
        source: "interactive_decision"
      },
      options
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 保持浏览器会话打开，逐条发现评论并等待外部决策回调。
 * requestDecision 可由 JSONL/stdin、HTTP、测试桩或其他模型适配器实现。
 */
export async function processCommentsInteractively(page, options) {
  if (typeof options.requestDecision !== "function") {
    throw new Error("Interactive comment flow requires requestDecision(payload).");
  }

  if (options.skipUnrepliedFilter) {
    logReplyFilterDebug("interactive flow is scanning all comments by explicit option");
  } else {
    await applyUnrepliedCommentsFilter(page, options);
  }
  await waitForCommentsArea(page, options);

  const scrollContainer = await markCommentScrollContainer(page);
  await resetCommentScrollToTop(page, scrollContainer);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs || 1800000);
  const decisionLimit = Math.max(1, Number(options.decisionLimit) || 20);
  const idleMs = Math.max(100, Number(options.idleMs) || 5000);
  const state = {
    startedAt: Date.now(),
    timeoutMs,
    decisionLimit,
    idleMs,
    processedSignatures: new Set(),
    results: [],
    decisionCount: 0,
    exitReason: "",
    exitDetails: null
  };
  let stalledScrollAttempts = 0;
  let bottomSearchBursts = 0;
  let lastProgressAt = state.startedAt;

  const appendResult = async (result, context = {}) => {
    const entry = {
      ...result,
      requestId: context.requestId ?? result.requestId ?? null,
      route: context.routing?.route ?? result.route ?? null,
      routeReasons: context.routing?.reasons ?? result.routeReasons ?? []
    };
    state.results.push(entry);
    lastProgressAt = Date.now();
    stalledScrollAttempts = 0;
    bottomSearchBursts = 0;

    if (typeof options.onProgress === "function") {
      await options.onProgress({
        latestResult: entry,
        summary: buildInteractiveSummary(state, options)
      });
    }
    return entry;
  };

  while (Date.now() - state.startedAt < timeoutMs) {
    if (state.decisionCount >= decisionLimit) {
      state.exitReason = "decision_limit_reached";
      state.exitDetails = {
        decisionLimit,
        decisionCount: state.decisionCount
      };
      break;
    }

    const snapshot = await extractCommentSnapshot(page);
    const comment = getNextInteractiveComment(snapshot, state.processedSignatures);

    if (comment) {
      state.processedSignatures.add(comment.signature);
      const baseResult = {
        username: comment.username,
        commentText: comment.commentText,
        publishText: comment.publishText
      };

      if (comment.hasReplies && !isThreadedUnrepliedAllowed()) {
        await persistPageReplyMarker(comment, options);
        await appendResult({
          ...baseResult,
          status: "skipped_already_replied",
          pageReplyEvidence: {
            replyCount: comment.replyCount
          }
        });
        continue;
      }

      const workTitle = options.selectedWork?.title || options.workTitle || "";
      let ledgerEntry;
      try {
        ledgerEntry = getReplyLedgerEntry(
          workTitle,
          comment.username,
          comment.commentText,
          options
        );
      } catch (error) {
        throw new Error(
          `独立回复台账读取失败，交互回复已停止: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // ★ allowReReply（run-session 按「以创作者中心为准 + 重复评论上限 3 条」政策传入）：
      //   台账旧记录不再一票否决——页面显示未回复的评论必须允许重试，上限由上层封顶。
      //   不传该选项（tool 自身默认）时保持上游原行为：台账有记录即跳过。
      if (ledgerEntry && !options.allowReReply) {
        await appendResult({
          ...baseResult,
          status: "skipped_reply_ledger",
          ledgerEvidence: {
            status: ledgerEntry.status,
            recordedAt: ledgerEntry.recordedAt,
            source: ledgerEntry.source
          }
        });
        continue;
      }

      if (typeof options.getKnownReplyEvidence === "function") {
        const databaseEvidence = await options.getKnownReplyEvidence(comment);
        if (databaseEvidence?.replied) {
          try {
            recordReplyLedgerEvent(
              {
                workTitle,
                username: comment.username,
                commentText: comment.commentText,
                publishText: comment.publishText,
                replyMessage: databaseEvidence.replyMessage ?? null,
                status: "db_replied",
                source: "interactive_database_check"
              },
              options
            );
          } catch {
            // 数据库证据已足够跳过；台账回写失败只影响自愈，不允许因此发送。
          }
          await appendResult({
            ...baseResult,
            status: "skipped_database_replied",
            databaseEvidence
          });
          continue;
        }
      }

      const enrichedComment =
        typeof options.enrichComment === "function"
          ? await options.enrichComment(comment)
          : { ...comment };
      const history = Array.isArray(enrichedComment.history) ? enrichedComment.history : [];
      const routing = classifyInteractiveComment({
        comment: enrichedComment,
        workTitle,
        history,
        mode: options.interactiveMode
      });
      const requestId = buildInteractiveRequestId(workTitle, comment, state.decisionCount + 1);
      state.decisionCount += 1;

      const rawDecision = await options.requestDecision({
        requestId,
        sequence: state.decisionCount,
        selectedWork: options.selectedWork,
        comment: enrichedComment,
        routing
      });
      const decision = normalizeInteractiveDecision(rawDecision, requestId);

      if (decision.action === "stop") {
        state.exitReason = "stopped_by_decision";
        state.exitDetails = {
          requestId,
          reason: decision.reason
        };
        break;
      }

      if (decision.action === "skip") {
        const persistenceError = await persistDecisionSkip(comment, decision, options);
        await appendResult(
          {
            ...baseResult,
            status: "skipped_by_decision",
            decisionReason: decision.reason,
            skipRemembered: decision.remember,
            ...(persistenceError ? { persistenceError } : {})
          },
          { requestId, routing }
        );
        continue;
      }

      if (options.preview) {
        await appendResult(
          {
            ...baseResult,
            status: "preview_generated",
            appliedReplyMessage: decision.replyMessage,
            decisionReason: decision.reason
          },
          { requestId, routing }
        );
        continue;
      }

      // 模型决策可能需要几十秒，期间前端会重绘评论列表并移除旧 data 标记。
      // 发送前重新做快照，按评论身份找到当前 DOM，避免对陈旧 locator 操作超时。
      const refreshedSnapshot = await extractCommentSnapshot(page);
      const currentComment = findCurrentInteractiveComment(refreshedSnapshot, comment);
      if (!currentComment) {
        await appendResult(
          {
            ...baseResult,
            status: "error",
            errorStage: "refresh_after_decision",
            error: "comment_disappeared_or_became_ambiguous_before_reply",
            requestedReplyMessage: decision.replyMessage,
            decisionReason: decision.reason
          },
          { requestId, routing }
        );
        continue;
      }
      state.processedSignatures.add(currentComment.signature);

      if (currentComment.hasReplies && !isThreadedUnrepliedAllowed()) {
        await persistPageReplyMarker(currentComment, options);
        await appendResult(
          {
            username: currentComment.username,
            commentText: currentComment.commentText,
            publishText: currentComment.publishText,
            status: "skipped_already_replied",
            pageReplyEvidence: {
              replyCount: currentComment.replyCount
            }
          },
          { requestId, routing }
        );
        continue;
      }

      const commentLocator = page
        .locator(`[data-codex-comment-block="${currentComment.domIndex}"]`)
        .first();
      const replyResult = await safeReplyToComment(page, commentLocator, currentComment, {
        ...options,
        replyMessage: decision.replyMessage,
        replyDryRun: false
      });
      const completedResult = {
        ...replyResult,
        requestedReplyMessage: decision.replyMessage,
        decisionReason: decision.reason
      };

      if (typeof options.afterReplyResult === "function") {
        await options.afterReplyResult({
          comment: currentComment,
          decision,
          result: completedResult
        });
      }
      await appendResult(completedResult, { requestId, routing });
      continue;
    }

    const terminalIndicator = await getCommentTerminalIndicator(page);
    if (terminalIndicator) {
      state.exitReason = terminalIndicator.kind;
      state.exitDetails = { terminalIndicator };
      break;
    }

    const previousFingerprint = await captureCommentListFingerprint(page);
    const scrollState = await advanceCommentScroll(page, scrollContainer, {
      distanceMultiplier: 1.25,
      minDistancePx: 1100,
      wheelDeltaY: 1400,
      pageDistanceMultiplier: 1.1,
      pageMinDistancePx: 900
    });
    const listChanged = await waitForCommentListChange(
      page,
      previousFingerprint,
      Math.min(10000, idleMs)
    );
    const nextSnapshot = await extractCommentSnapshot(page);
    const hasUnprocessed = Boolean(
      getNextInteractiveComment(nextSnapshot, state.processedSignatures)
    );
    const scrollMoved = scrollState.after > scrollState.before;
    const reachedBottom =
      scrollState.after >= scrollState.maxScrollTop && scrollState.after === scrollState.before;

    if (hasUnprocessed) {
      stalledScrollAttempts = 0;
      bottomSearchBursts = 0;
      continue;
    }

    if (scrollMoved || listChanged) {
      stalledScrollAttempts = 0;
    } else {
      stalledScrollAttempts += 1;
    }
    bottomSearchBursts = reachedBottom ? bottomSearchBursts + 1 : 0;

    if (bottomSearchBursts >= 3) {
      state.exitReason = "reached_bottom_without_new_comments";
      state.exitDetails = { bottomSearchBursts };
      break;
    }
    if (stalledScrollAttempts >= 8) {
      state.exitReason = "stalled_scroll_attempts";
      state.exitDetails = { stalledScrollAttempts };
      break;
    }
    if (Date.now() - lastProgressAt >= idleMs * 2 && stalledScrollAttempts >= 4) {
      state.exitReason = "idle_window_without_new_comments";
      state.exitDetails = {
        idleMs: idleMs * 2,
        stalledScrollAttempts
      };
      break;
    }
  }

  if (!state.exitReason) {
    state.exitReason =
      Date.now() - state.startedAt >= timeoutMs
        ? "interactive_flow_total_timeout"
        : "interactive_flow_finished";
    state.exitDetails = {
      timeoutMs,
      elapsedMs: Date.now() - state.startedAt
    };
  }

  return buildInteractiveSummary(state, options);
}

async function aggressivelyAdvanceCommentScroll(
  page,
  scrollContainer,
  options,
  processedSignatures,
  processedPlanIds
) {
  const attempts = [];
  let previousFingerprint = await captureCommentListFingerprint(page);
  let latestSnapshot = [];
  let foundUnprocessed = false;

  for (let index = 0; index < 10; index += 1) {
    const state = await advanceCommentScroll(page, scrollContainer, {
      distanceMultiplier: 2.2,
      minDistancePx: 2200,
      wheelDeltaY: 2600,
      pageDistanceMultiplier: 1.8,
      pageMinDistancePx: 1800
    });
    const listChangeWait = waitForCommentListChange(page, previousFingerprint, 1000);
    await page.waitForTimeout(1000);
    const listChanged = await listChangeWait;
    attempts.push({
      ...state,
      listChanged
    });

    latestSnapshot = await extractCommentSnapshot(page);
    foundUnprocessed = Boolean(
      getNextReplyTarget(latestSnapshot, options, processedSignatures, processedPlanIds)
    );
    previousFingerprint = await captureCommentListFingerprint(page);

    if (foundUnprocessed) {
      break;
    }
  }

  const fallbackState = {
    before: 0,
    after: 0,
    maxScrollTop: 0,
    strategy: "none",
    listChanged: false
  };
  const lastAttempt = attempts[attempts.length - 1] ?? fallbackState;
  const trailingAttempts = attempts.slice(-2);

  return {
    ...lastAttempt,
    attempts: attempts.length,
    anyMovement: attempts.some((attempt) => attempt.after > attempt.before),
    anyListChange: attempts.some((attempt) => attempt.listChanged),
    foundUnprocessed,
    latestSnapshot,
    reachedBottom:
      attempts.length > 0 &&
      lastAttempt.after >= lastAttempt.maxScrollTop &&
      trailingAttempts.every(
        (attempt) => attempt.after >= attempt.maxScrollTop || attempt.after === attempt.before
      )
  };
}

export async function replyToComments(page, options) {
  if (options.skipUnrepliedFilter) {
    logReplyFilterDebug("skipping unreplied filter by explicit plan option");
  } else {
    await applyUnrepliedCommentsFilter(page, options);
  }
  await waitForCommentsArea(page, options);

  const scrollContainer = await markCommentScrollContainer(page);
  await resetCommentScrollToTop(page, scrollContainer);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  const processedSignatures = new Set();
  const processedPlanIds = new Set();
  const results = [];
  let repliedCount = 0;
  let actedCount = 0;
  let lastProgressAt = startedAt;
  let loggedNoMatchSnapshot = false;
  let stalledScrollAttempts = 0;
  let bottomSearchBursts = 0;
  let exitReason = "";
  let exitDetails = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (Array.isArray(options.replyPlans) && processedPlanIds.size >= options.replyPlans.length) {
      exitReason = "all_reply_plans_resolved";
      exitDetails = {
        processedPlanCount: processedPlanIds.size
      };
      logReplyFilterDebug("reply flow completed: all reply plans resolved");
      break;
    }

    const snapshot = await extractCommentSnapshot(page);
    const nextTarget = getNextReplyTarget(snapshot, options, processedSignatures, processedPlanIds);

    if (nextTarget) {
      const {
        comment: nextComment,
        plan,
        replyMessage,
        matchMode,
        remainingPlanCount,
        visibleCommentCount
      } = nextTarget;
      logReplyFilterDebug("matched reply target", {
        username: nextComment.username,
        commentText: nextComment.commentText,
        publishText: nextComment.publishText,
        replyPlanId: plan?.id ?? null,
        matchMode,
        remainingPlanCount,
        visibleCommentCount
      });

      const commentLocator = page
        .locator(`[data-codex-comment-block="${nextComment.domIndex}"]`)
        .first();
      const replyResult = await safeReplyToComment(page, commentLocator, nextComment, {
        ...options,
        replyMessage
      });

      results.push({
        ...replyResult,
        replyPlanId: plan?.id ?? null,
        requestedReplyMessage: replyMessage
      });
      if (isResolvedPlanStatus(replyResult.status)) {
        processedSignatures.add(nextComment.signature);
        if (plan) {
          processedPlanIds.add(plan.id);
        }
        lastProgressAt = Date.now();
        loggedNoMatchSnapshot = false;
        stalledScrollAttempts = 0;
        bottomSearchBursts = 0;
      }

      if (isReplyActionStatus(replyResult.status)) {
        actedCount += 1;
      }

      if (replyResult.status === "replied") {
        repliedCount += 1;
      }

      if (actedCount >= options.replyLimit) {
        exitReason = options.replyDryRun ? "dry_run_limit_reached" : "reply_limit_reached";
        exitDetails = {
          replyLimit: options.replyLimit,
          actedCount,
          repliedCount
        };
        logReplyFilterDebug("reply flow completed: reached action limit", {
          replyLimit: options.replyLimit,
          actedCount,
          repliedCount
        });
        break;
      }

      if (!isResolvedPlanStatus(replyResult.status)) {
        await page.waitForTimeout(600);
      }

      continue;
    }

    if (!loggedNoMatchSnapshot) {
      const remainingPlans = options.replyPlans
        .filter((plan) => !processedPlanIds.has(plan.id))
        .slice(0, 5)
        .map((plan) => ({
          id: plan.id,
          username: plan.username,
          commentText: plan.commentText,
          publishText: plan.publishText,
          replyMessage: plan.replyMessage
        }));
      logReplyFilterDebug("no visible comment matched current reply plans", {
        visibleComments: summarizeCommentsForLog(snapshot, 5),
        remainingPlans
      });
      loggedNoMatchSnapshot = true;
    }

    const terminalIndicator = await getCommentTerminalIndicator(page);
    if (terminalIndicator) {
      exitReason = terminalIndicator.kind;
      exitDetails = {
        terminalIndicator,
        remainingPlanCount: Array.isArray(options.replyPlans)
          ? options.replyPlans.filter((plan) => !processedPlanIds.has(plan.id)).length
          : 0
      };
      logReplyFilterDebug("reply flow completed: reached terminal indicator", exitDetails);
      break;
    }

    const scrollState = await aggressivelyAdvanceCommentScroll(
      page,
      scrollContainer,
      options,
      processedSignatures,
      processedPlanIds
    );
    logReplyFilterDebug("aggressive downward scan after missing reply target", {
      attempts: scrollState.attempts,
      strategy: scrollState.strategy,
      anyMovement: scrollState.anyMovement,
      anyListChange: scrollState.anyListChange,
      foundUnprocessed: scrollState.foundUnprocessed,
      reachedBottom: scrollState.reachedBottom
    });

    const nextSnapshot = Array.isArray(scrollState.latestSnapshot)
      ? scrollState.latestSnapshot
      : [];
    const hasUnprocessed = scrollState.foundUnprocessed;
    const hasVisibleComments = nextSnapshot.length > 0;
    const scrollMoved = scrollState.anyMovement;
    const reachedBottom = scrollState.reachedBottom;

    const terminalIndicatorAfterScroll = await getCommentTerminalIndicator(page);
    if (!hasUnprocessed && terminalIndicatorAfterScroll) {
      exitReason = terminalIndicatorAfterScroll.kind;
      exitDetails = {
        terminalIndicator: terminalIndicatorAfterScroll,
        remainingPlanCount: Array.isArray(options.replyPlans)
          ? options.replyPlans.filter((plan) => !processedPlanIds.has(plan.id)).length
          : 0,
        scrollMoved,
        anyListChange: scrollState.anyListChange
      };
      logReplyFilterDebug(
        "reply flow completed: reached terminal indicator after scrolling",
        exitDetails
      );
      break;
    }

    if (hasUnprocessed) {
      lastProgressAt = Date.now();
      loggedNoMatchSnapshot = false;
      stalledScrollAttempts = 0;
      bottomSearchBursts = 0;
      continue;
    }

    if (scrollMoved || scrollState.anyListChange) {
      stalledScrollAttempts = 0;
    } else {
      stalledScrollAttempts += 1;
    }

    if (reachedBottom) {
      bottomSearchBursts += 1;
    } else {
      bottomSearchBursts = 0;
    }

    if (!hasVisibleComments && !scrollMoved && !scrollState.anyListChange) {
      exitReason = "no_comments_visible_after_scroll";
      exitDetails = {
        hasVisibleComments,
        scrollMoved,
        anyListChange: scrollState.anyListChange
      };
      logReplyFilterDebug("reply flow completed: no comments visible after scroll");
      break;
    }

    if (reachedBottom && !hasUnprocessed && bottomSearchBursts >= 3) {
      exitReason = "reached_bottom_repeatedly_without_match";
      exitDetails = {
        bottomSearchBursts
      };
      logReplyFilterDebug(
        "reply flow completed: reached bottom repeatedly with no matching plans",
        {
          bottomSearchBursts
        }
      );
      break;
    }

    if (stalledScrollAttempts >= 8) {
      exitReason = "stalled_scroll_attempts";
      exitDetails = {
        stalledScrollAttempts
      };
      logReplyFilterDebug("reply flow stopped after repeated stalled scroll attempts", {
        stalledScrollAttempts
      });
      break;
    }

    if (Date.now() - lastProgressAt >= options.idleMs * 2 && stalledScrollAttempts >= 4) {
      exitReason = "idle_window_without_new_matches";
      exitDetails = {
        idleMs: options.idleMs * 2,
        stalledScrollAttempts
      };
      logReplyFilterDebug("reply flow stopped after idle window without new matches", {
        stalledScrollAttempts
      });
      break;
    }
  }

  if (!exitReason) {
    exitReason =
      Date.now() - startedAt >= timeoutMs ? "reply_flow_total_timeout" : "reply_flow_finished";
    exitDetails = {
      timeoutMs,
      elapsedMs: Date.now() - startedAt
    };
  }

  const skippedCount = results.filter((item) => item.status.startsWith("skipped_")).length;
  const skippedAlreadyRepliedCount = results.filter(
    (item) => item.status === "skipped_already_replied"
  ).length;
  const skippedByLedgerCount = results.filter(
    (item) => item.status === "skipped_reply_ledger" || item.status === "skipped_reply_ledger_busy"
  ).length;
  const sentUnconfirmedCount = results.filter((item) => item.status === "sent_unconfirmed").length;
  const dryRunCount = results.filter((item) => item.status === "dry_run_typed").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  const unmatchedPlans = Array.isArray(options.replyPlans)
    ? options.replyPlans
        .filter((plan) => !processedPlanIds.has(plan.id))
        .map((plan) => ({
          id: plan.id,
          username: plan.username,
          commentText: plan.commentText,
          publishText: plan.publishText,
          replyMessage: plan.replyMessage
        }))
    : [];
  const elapsedMs = Date.now() - startedAt;

  logReplyFilterDebug("reply flow finished", {
    exitReason,
    exitDetails,
    elapsedMs,
    repliedCount,
    actedCount,
    totalProcessed: results.length,
    matchedPlanCount: processedPlanIds.size,
    unmatchedPlanCount: unmatchedPlans.length
  });

  return {
    replyDryRun: Boolean(options.replyDryRun),
    exitReason,
    exitDetails,
    elapsedMs,
    configuredTimeoutMs: timeoutMs,
    configuredIdleMs: options.idleMs,
    configuredReplyTimeoutMs: options.replyTimeoutMs,
    configuredReplySettleMs: options.replySettleMs,
    repliedCount,
    actedCount,
    dryRunCount,
    skippedCount,
    skippedAlreadyRepliedCount,
    skippedByLedgerCount,
    sentUnconfirmedCount,
    errorCount,
    totalProcessed: results.length,
    matchedPlanCount: processedPlanIds.size,
    unmatchedPlanCount: unmatchedPlans.length,
    unmatchedPlans,
    results
  };
}
