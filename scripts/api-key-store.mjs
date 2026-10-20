/**
 * api-key-store.mjs — 从控制台更换 DeepSeek API Key（C-27，2026-10-17 作者要求）
 *
 * 安全纪律（这一份文件就是这几条的实现，改动前先读完）：
 *  1. **只写盘、不回显**：接口返回给页面的一律是 `maskKey()` 之后的串，原文只在本进程内存里停留一次调用。
 *  2. **不落日志**：任何 log 都只写脱敏串；错误信息里也不带 key（validate 的报错只说格式，不说内容）。
 *  3. **写项目树外**：默认写 `~/.douyin-automation/secrets.json`，不是 `config/secrets.local.json` ——
 *     项目里有 tool/ 下近两百个第三方包，放在项目树内理论上可被它们读到。
 *  4. **原子写 + 0600**：先写临时文件再 rename，避免写一半断电留下残文件；权限尽量收到仅本人可读。
 *  5. **保留其它字段**：文件里已有 base_url / model 时不得被覆盖清空。
 *  6. **先验后写**：可选的 verify 用 GET /models 验证（不消耗 token），不通过就不写盘。
 *
 * 为什么要独立成模块：ui-server 是带副作用的可执行脚本（import 即监听端口），
 * 逻辑留在里面就没法单测。这里全是纯函数 + 显式传参。
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  EXTERNAL_SECRETS_FILE,
  looksLikePlaceholder,
  maskKey,
  readSecrets,
} from "./llm-deepseek.mjs";

/** DeepSeek key 的形态：sk- 开头，正文是字母/数字/下划线/短横线 */
const KEY_SHAPE = /^sk-[A-Za-z0-9_-]+$/;
const MIN_LEN = 24;
const MAX_LEN = 200;

/**
 * 校验一把用户输入的 key。
 * 返回 { ok:true, key } 或 { ok:false, error }，**error 里绝不回显 key 内容**。
 */
export function validateApiKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key) return { ok: false, error: "请先填入 key" };
  if (/[\s\u0000-\u001f]/.test(key)) return { ok: false, error: "key 里不能有空格、制表符或换行（多半是复制时多带了字符）" };
  if (key.length < MIN_LEN) return { ok: false, error: `长度不对：至少 ${MIN_LEN} 位，你给的是 ${key.length} 位` };
  if (key.length > MAX_LEN) return { ok: false, error: `长度不对：最多 ${MAX_LEN} 位，你给的是 ${key.length} 位` };
  if (!key.toLowerCase().startsWith("sk-")) return { ok: false, error: "DeepSeek 的 key 以 sk- 开头，请确认复制的是完整 key" };
  if (!KEY_SHAPE.test(key)) return { ok: false, error: "key 里出现了不该有的字符（只允许字母、数字、下划线、短横线）" };
  if (looksLikePlaceholder(key)) return { ok: false, error: "这看起来是模板里的占位符，不是真 key" };
  return { ok: true, key };
}

function readJsonObject(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * 原子写：临时文件 → rename。中途崩了也不会留下半截 JSON。
 * 返回 { file, keptFields }（keptFields 用来在界面上说明"没动你原来的配置"）。
 */
export function writeApiKey(key, { file = EXTERNAL_SECRETS_FILE } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readJsonObject(file);
  const next = { ...existing, deepseek_api_key: key };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能没建出来 */
    }
    throw error;
  }
  // Windows 上 chmod 语义有限，尽力而为；失败不影响写入本身
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return {
    file,
    keptFields: Object.keys(existing).filter((k) => k !== "deepseek_api_key" && !k.startsWith("_")),
  };
}

/** 清掉文件里的 key（其它字段保留）。文件不存在时返回 removed:false。 */
export function clearApiKey({ file = EXTERNAL_SECRETS_FILE } = {}) {
  const existing = readJsonObject(file);
  if (!("deepseek_api_key" in existing)) return { removed: false, file };
  delete existing.deepseek_api_key;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return { removed: true, file };
}

/**
 * 给页面看的状态：只到"配置没配置 + 脱敏 + 从哪来"这一层。
 * envOverride = true 时必须提醒作者：环境变量优先级最高，写文件不生效。
 */
export function apiKeyStatus(projectDir, { file = EXTERNAL_SECRETS_FILE } = {}) {
  const secrets = readSecrets(projectDir);
  const configured = Boolean(secrets.apiKey);
  return {
    configured,
    masked: maskKey(secrets.apiKey),
    source: secrets.keySource,
    envOverride: secrets.keySource === "env:DEEPSEEK_API_KEY",
    placeholderSource: secrets.placeholderSource,
    file,
    internalFile: path.join(projectDir, "config", "secrets.local.json"),
    baseUrl: secrets.baseUrl,
  };
}

/**
 * 验证 key 是否可用。
 * 用 GET /models 而不是 chat/completions：不消耗 token，也不触发任何生成。
 * fetchImpl 可注入 —— 自测里用假 fetch，避免真的打到线上接口。
 */
export async function verifyApiKey(key, {
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const url = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/models`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "服务端拒绝了这把 key（401/403），请确认有没有复制全、有没有被停用" };
    }
    return { ok: false, error: `服务端返回 HTTP ${res.status}，暂时没法确认这把 key 是否可用` };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { ok: false, error: timedOut ? "验证超时（15 秒），检查网络或代理后重试" : `验证请求发不出去：${error.message}` };
  }
}
