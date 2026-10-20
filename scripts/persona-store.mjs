/**
 * persona-store.mjs — 「人设库」的唯一真相来源（多套人设的增删改查）
 *
 * 为什么要有它（2026-10-17 作者提的三条整改）：
 *   ① 人设要能**增删**，还要能一句话让 AI 生成一套新的；
 *   ② 保存即最终版本，**不再有「恢复上一次保存」**；
 *   ③ 固定一套 / 多套随机 两种模式的界面要能收放。
 *
 * 前两条要求人设从「一套固定文件 + 代码里写死的模板」变成**一个可编辑的集合**，
 * 所以人设本体统一搬进 config/personas.json：
 *   · items[] 每项 = { id, name, tagline, builtin, createdAt, updatedAt, persona }
 *   · persona 的形状仍由 persona.mjs 的 normalizePersona 收敛（两处不各写一份）
 *
 * 兼容与迁移（只做一次，且只在文件**不存在**时做）：
 *   · 旧版 config/persona.json（唯一那套自定义人设）→ 迁成 id = "custom" 的一项；
 *   · 代码里的 8 套模板（persona-presets.mjs）→ 种进库里，id 保持不变。
 *   这样 config/persona-rotation.json 里已有的 "custom"/"anime" 等引用**继续有效**。
 *   迁移落盘后旧文件改名成 config/persona.legacy.json——它已不再被读取，
 *   留在原地只会让人误以为"改它有用"。
 *
 * 边界：只读写 config/personas.json，不调模型、不碰浏览器、不读其他配置。
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSONA, normalizePersona } from "./persona.mjs";
import { BASE_BANNED, PERSONA_PRESETS } from "./persona-presets.mjs";

export const PERSONAS_REL_PATH = "config/personas.json";
export const LEGACY_PERSONA_REL_PATH = "config/persona.json";
export const LIBRARY_VERSION = "2.0";

/** 人设库上限。不是技术限制，是防止「几十套随机池」把人设彻底稀释成噪声 */
export const MAX_PERSONAS = 24;
export const NAME_MAX = 20;
export const TAGLINE_MAX = 40;

/** 迁移后旧人设固定用这个 id：config/persona-rotation.json 里已经引用了它 */
export const DEFAULT_PERSONA_ID = "custom";

/** id 会直接出现在 onclick 字符串与 URL 里，只允许安全字符 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function personasPath(projectDir) {
  return path.join(projectDir, PERSONAS_REL_PATH);
}

export function legacyPersonaPath(projectDir) {
  return path.join(projectDir, LEGACY_PERSONA_REL_PATH);
}

/**
 * 生成一个不与现有 id 冲突的短 id。
 * 不用「名字转拼音」：中文转写要引依赖，且改名后 id 会变，反而把随机池引用打断。
 */
export function newPersonaId(existingIds = []) {
  const used = new Set(existingIds);
  for (let i = 0; i < 64; i += 1) {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (ID_RE.test(id) && !used.has(id)) return id;
  }
  throw new Error("生成人设 id 失败（连续冲突），请重试");
}

/**
 * 底座禁用词（防客服腔）强制内置。
 *
 * 2026-10-19：人设页把「禁用词 / 额外要求」收进了默认折叠的「高级设置」，
 * 作者基本不会再看到这两栏。既然看不见，就不能指望他手动补 —— 空着等于没有防客服腔，
 * 回复会滑向「亲～」「感谢您的支持」，一眼机器味。
 * 所以：读和写都统一补齐，**只加不减**，绝不覆盖作者自己写的词。
 */
function withBaseBanned(persona) {
  const missing = BASE_BANNED.filter((w) => !persona.banned_words.includes(w));
  if (!missing.length) return persona;
  return normalizePersona({ ...persona, banned_words: [...persona.banned_words, ...missing] });
}

/**
 * 收敛一项人设。
 * ★ 名称/说明是**库层**字段，不能塞进 normalizePersona —— 那个函数只认人设本体，
 *   多出来的键会被丢掉；两处各写一份又会漂移，所以这里只补库层字段。
 */
export function normalizePersonaItem(raw, { fallbackName = "未命名人设" } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const rawId = String(src.id ?? "").trim();
  const name = String(src.name ?? "").trim().slice(0, NAME_MAX);
  const tagline = String(src.tagline ?? "").trim().slice(0, TAGLINE_MAX);
  return {
    id: ID_RE.test(rawId) ? rawId : newPersonaId([]),
    name: name || fallbackName,
    tagline,
    builtin: src.builtin === true,
    createdAt: String(src.createdAt ?? "").trim(),
    updatedAt: String(src.updatedAt ?? "").trim(),
    persona: withBaseBanned(normalizePersona(src.persona ?? {})),
  };
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 旧版那套人设（迁移源）。读不到/解析失败都返回 null —— 迁移不该因为旧文件而失败 */
function readLegacyPersona(projectDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPersonaPath(projectDir), "utf8"));
    return normalizePersona(raw);
  } catch {
    return null;
  }
}

/**
 * 迁移成功后，把旧文件改名归档。
 *
 * 为什么必须改名而不是留着（2026-10-17）：迁移之后 config/persona.json **不再被任何代码读取**，
 * 它留在原地就是一个陷阱——下次谁手改它都不会生效，还会以为是程序坏了。
 * 改名（不是删除）既保住原始内容，又让"真正的存储位置"只有一个。
 */
function archiveLegacyPersona(projectDir) {
  const legacy = legacyPersonaPath(projectDir);
  const archived = path.join(projectDir, "config", "persona.legacy.json");
  try {
    if (!fs.existsSync(legacy)) return null;
    if (fs.existsSync(archived)) return null; // 已有归档，不覆盖（那一份可能更早）
    fs.renameSync(legacy, archived);
    return archived;
  } catch {
    return null;
  }
}

/**
 * 首次迁移用的种子：旧自定义人设（若有）+ 8 套内置模板。
 * 内置模板的 id 原样保留，保证旧的 persona-rotation.json 不用改也能用。
 */
export function seedPersonaItems({ legacyPersona = null } = {}) {
  const items = [];
  if (legacyPersona) {
    items.push({
      id: DEFAULT_PERSONA_ID,
      name: "我的创作人设",
      tagline: String(legacyPersona.identity || "").slice(0, TAGLINE_MAX) || "之前手动调过的那套",
      builtin: false,
      createdAt: legacyPersona.updated || today(),
      updatedAt: legacyPersona.updated || today(),
      persona: legacyPersona,
    });
  }
  for (const preset of PERSONA_PRESETS) {
    items.push({
      id: preset.id,
      name: preset.name,
      tagline: preset.tagline,
      builtin: true,
      createdAt: "",
      updatedAt: "",
      persona: preset.persona,
    });
  }
  return items;
}

/**
 * 读取人设库；文件不存在时**自动迁移并落盘**。
 *
 * 三种情况必须区分清楚（混在一起就会静默丢人设）：
 *   · 文件不存在 → 迁移（旧人设 + 模板）并写入，返回 created=true；
 *   · 文件坏了   → **不覆盖**（覆盖等于把作者的人设烧掉），返回 error + 只读种子，
 *                  页面据此显示警告，等人工处理；
 *   · 文件正常   → 原样读回，只做收敛。
 */
export function loadPersonaLibrary(projectDir, { persistMigration = true } = {}) {
  const file = personasPath(projectDir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const missing = error.code === "ENOENT";
    const legacy = readLegacyPersona(projectDir);
    const items = seedPersonaItems({ legacyPersona: legacy });

    if (!missing) {
      return {
        items,
        file,
        created: false,
        corrupt: true,
        error: `人设库无法解析，已临时按「旧人设 + 内置模板」展示：${error.message}。请检查 config/personas.json，改好之前不要保存。`,
      };
    }

    let errorMsg = null;
    let created = false;
    if (persistMigration) {
      try {
        savePersonaLibrary(projectDir, items);
        created = true;
        archiveLegacyPersona(projectDir);
      } catch (writeError) {
        errorMsg = `人设库迁移时写入失败（本次仍可正常使用，但重启后会重新迁移）：${writeError.message}`;
      }
    }
    return { items, file, created, error: errorMsg };
  }

  /**
   * 形状不对（不是 { items: [...] }）同样按"损坏"处理：
   * 这个文件可能是别的格式但装着作者的人设，写回去就是覆盖。
   * 而 `items: []`（显式空库）不算损坏 —— 那是"确实没有"，允许新建。
   */
  if (!Array.isArray(raw?.items)) {
    return {
      items: seedPersonaItems({ legacyPersona: readLegacyPersona(projectDir) }),
      file,
      created: false,
      corrupt: true,
      error: "人设库格式不对（缺少 items 数组），为防覆盖已拒绝写入。请检查 config/personas.json。",
    };
  }

  const items = dedupeById(raw.items.map((item) => normalizePersonaItem(item))).slice(0, MAX_PERSONAS);
  if (!items.length) {
    /**
     * ★ 2026-10-19：空库就是空库，**不再临时造一套"默认人设"**。
     *   原逻辑会自动补一套并给 error，于是页面永远显示"有一套人设 + 一条红字"，
     *   空库时看着像坏了。现在返回真正的空数组：页面显示"人设库是空的"，
     *   判定层自己用内存默认口吻兜底（见 judge.mjs 的 EMPTY_PERSONA_ITEM）。
     */
    return { items: [], file, created: false, error: null };
  }

  return {
    items,
    file,
    created: false,
    error: raw?.version && raw.version !== LIBRARY_VERSION
      ? `人设库版本是 ${raw.version}，当前代码按 ${LIBRARY_VERSION} 读取（字段已自动兼容）`
      : null,
  };
}

/** 原子写入：先写临时文件再改名，避免半截 JSON 把人设库写坏 */
export function savePersonaLibrary(projectDir, items) {
  const normalized = dedupeById((Array.isArray(items) ? items : []).map((item) => normalizePersonaItem(item)));
  if (!normalized.length) throw new Error("人设库至少要保留一套人设");
  if (normalized.length > MAX_PERSONAS) {
    throw new Error(`人设最多 ${MAX_PERSONAS} 套，当前 ${normalized.length} 套`);
  }

  const file = personasPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { version: LIBRARY_VERSION, updated: today(), items: normalized };
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标被占用时 rename 会失败：退回直接写，别把改动丢在半路
    fs.writeFileSync(file, text, "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
  }
  return { items: normalized, file };
}

/** 读取人设库并断言它可安全写入（损坏时拒绝任何写操作，绝不覆盖） */
function loadForWrite(projectDir) {
  const lib = loadPersonaLibrary(projectDir);
  if (lib.corrupt) {
    throw new Error(
      "人设库文件已损坏，为了不覆盖你现有的人设，已拒绝写入。请先修好 config/personas.json（或从备份恢复）再操作。",
    );
  }
  return lib;
}

export function findPersona(items, id) {
  return (Array.isArray(items) ? items : []).find((item) => item.id === id) ?? null;
}

/**
 * 新增或更新一套人设。
 * id 传了且存在 = 更新；否则新增（id 由服务端生成，页面不用管）。
 * 名称必填、超长直接拒绝 —— 与「人设超长不静默截断」同一条纪律。
 */
export function upsertPersona(projectDir, input = {}) {
  const lib = loadForWrite(projectDir);
  const items = [...lib.items];

  const idRaw = String(input.id ?? "").trim();
  const index = idRaw ? items.findIndex((item) => item.id === idRaw) : -1;

  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("人设名称不能为空（它是你在人设库里认出这套人设的唯一标识）");
  if (name.length > NAME_MAX) throw new Error(`人设名称最多 ${NAME_MAX} 字，当前 ${name.length} 字`);
  const tagline = String(input.tagline ?? "").trim();
  if (tagline.length > TAGLINE_MAX) throw new Error(`一句话说明最多 ${TAGLINE_MAX} 字，当前 ${tagline.length} 字`);

  const persona = normalizePersona(input.persona ?? {});
  const stamp = today();

  let item;
  if (index >= 0) {
    item = { ...items[index], name, tagline, persona, updatedAt: stamp };
    items[index] = item;
  } else {
    if (items.length >= MAX_PERSONAS) throw new Error(`人设最多 ${MAX_PERSONAS} 套，删掉几套再新建`);
    item = {
      id: newPersonaId(items.map((x) => x.id)),
      name,
      tagline,
      builtin: false,
      createdAt: stamp,
      updatedAt: stamp,
      persona,
    };
    items.push(item);
  }

  const saved = savePersonaLibrary(projectDir, items);
  return { item: findPersona(saved.items, item.id) ?? item, items: saved.items, file: saved.file, created: index < 0 };
}

/**
 * 删除一套人设。**至少保留一套**——否则 random 池与固定人选都会失效，
 * 页面会陷入「有开关但没人设可用」的死状态。
 * 引用修复（rotation 的 single/pool）由调用方用 normalizeRotation 完成，本模块只管库。
 */
export function deletePersona(projectDir, id) {
  const lib = loadForWrite(projectDir);
  if (lib.items.length <= 1) throw new Error("至少要保留一套人设，不能全删");
  const target = findPersona(lib.items, id);
  if (!target) throw new Error("没有这套人设（可能已被删除，刷新页面看看）");
  const items = lib.items.filter((item) => item.id !== id);
  const saved = savePersonaLibrary(projectDir, items);
  return { deleted: target, items: saved.items, file: saved.file };
}

/** 复制一套人设（最常见的「增」：拿现有的改两个词） */
export function duplicatePersona(projectDir, id) {
  const lib = loadForWrite(projectDir);
  const source = findPersona(lib.items, id);
  if (!source) throw new Error("没有这套人设（可能已被删除）");
  const baseName = `${source.name} 副本`;
  return upsertPersona(projectDir, {
    name: baseName.slice(0, NAME_MAX),
    tagline: source.tagline,
    persona: source.persona,
  });
}
