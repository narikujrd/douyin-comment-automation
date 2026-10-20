import crypto from "node:crypto";
import { canonicalWorkTitle, normalizeText, normalizeUsername } from "./common.mjs";

export const INTERACTIVE_PROTOCOL_VERSION = 1;
export const INTERACTIVE_MODES = new Set(["smart", "quality", "save-token"]);
export const MAX_INTERACTIVE_REPLY_CHARS = 400;

const PROMPT_INJECTION_PATTERN =
  /(忽略|无视|覆盖).{0,12}(之前|上面|系统|规则|指令)|system\s*prompt|prompt\s*injection|开发者指令|读取.{0,8}(密钥|cookie|配置|文件)|执行.{0,12}(命令|代码|脚本)|rm\s+-rf|curl\s+https?:|wget\s+https?:/iu;
const CREDENTIAL_PATTERN =
  /(api\s*key|apikey|access[_ -]?token|secret|cookie|密码|口令|验证码|登录态|私钥)/iu;
const HIGH_STAKES_PATTERN =
  /(诊断|处方|吃什么药|剂量|急救|律师|诉讼|违法|判刑|投资建议|买什么股票|稳赚|转账|银行卡|人肉|定位他人|绕过同意|黑客|入侵)/u;
const SPECIAL_SKILL_PATTERN = /(起名|取名|地铁|碰头|聚餐|聚会|定位|快捷指令)/u;
const FIXED_RULE_PATTERN = /(黎曼|圆周率|api\s*key|apikey)/iu;

export function buildInteractiveRequestId(workTitle, comment, sequence = 0) {
  const identity = JSON.stringify([
    canonicalWorkTitle(workTitle),
    normalizeUsername(comment?.username).toLowerCase(),
    normalizeText(comment?.commentText),
    Number(sequence) || 0
  ]);
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function classifyInteractiveComment({
  comment,
  workTitle = "",
  history = [],
  mode = "smart"
}) {
  const normalizedMode = INTERACTIVE_MODES.has(mode) ? mode : "smart";
  const combinedText = normalizeText(
    `${workTitle} ${comment?.username ?? ""} ${comment?.commentText ?? ""}`
  );
  const flags = {
    hasImages:
      (Array.isArray(comment?.imagePaths) && comment.imagePaths.length > 0) ||
      (Array.isArray(comment?.imageUrls) && comment.imageUrls.length > 0),
    hasHistory: Array.isArray(history) && history.length > 0,
    specialUser: normalizeUsername(comment?.username) === "半山闲墨",
    promptInjection: PROMPT_INJECTION_PATTERN.test(combinedText),
    credentialRequest: CREDENTIAL_PATTERN.test(combinedText),
    highStakes: HIGH_STAKES_PATTERN.test(combinedText),
    specialSkill: SPECIAL_SKILL_PATTERN.test(combinedText),
    fixedRule: FIXED_RULE_PATTERN.test(combinedText)
  };

  const reasons = [];
  for (const [flag, enabled] of Object.entries(flags)) {
    if (enabled) {
      reasons.push(flag);
    }
  }

  let route = "normal";
  if (flags.promptInjection || flags.credentialRequest || flags.highStakes) {
    route = "review";
  } else if (flags.fixedRule && normalizedMode !== "quality") {
    route = "rule";
  } else if (
    normalizedMode === "quality" ||
    flags.hasImages ||
    flags.hasHistory ||
    flags.specialUser ||
    flags.specialSkill
  ) {
    route = "single";
  } else if (normalizedMode === "save-token") {
    route = "economy";
  }

  return {
    mode: normalizedMode,
    route,
    reasons,
    flags,
    requiresReview: route === "review"
  };
}

export function normalizeInteractiveDecision(rawDecision, expectedRequestId) {
  let parsed = rawDecision;
  if (typeof rawDecision === "string") {
    try {
      parsed = JSON.parse(rawDecision);
    } catch (error) {
      throw new Error(`Decision is not valid JSON: ${error.message}`);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decision must be a JSON object.");
  }

  const action = normalizeText(String(parsed.action ?? "")).toLowerCase();
  if (!new Set(["reply", "skip", "stop"]).has(action)) {
    throw new Error('Decision action must be "reply", "skip", or "stop".');
  }

  if (action !== "stop") {
    const requestId = normalizeText(String(parsed.requestId ?? parsed.id ?? ""));
    if (!requestId || requestId !== expectedRequestId) {
      throw new Error(`Decision requestId does not match pending request ${expectedRequestId}.`);
    }
  }

  if (action === "reply") {
    const replyMessage = String(parsed.replyMessage ?? "").trim();
    if (!replyMessage) {
      throw new Error("Reply decision requires a non-empty replyMessage.");
    }
    if ([...replyMessage].length > MAX_INTERACTIVE_REPLY_CHARS) {
      throw new Error(`replyMessage exceeds ${MAX_INTERACTIVE_REPLY_CHARS} Unicode characters.`);
    }
    return {
      action,
      requestId: expectedRequestId,
      replyMessage,
      reason: normalizeText(String(parsed.reason ?? ""))
    };
  }

  return {
    action,
    requestId: action === "stop" ? null : expectedRequestId,
    reason: normalizeText(String(parsed.reason ?? "")),
    remember: action === "skip" && Boolean(parsed.remember)
  };
}

export function createProtocolEvent(type, payload = {}) {
  return {
    protocolVersion: INTERACTIVE_PROTOCOL_VERSION,
    type,
    emittedAt: new Date().toISOString(),
    ...payload
  };
}
