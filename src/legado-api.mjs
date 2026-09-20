// src/legado-api.mjs —— legado api.md 兼容层
// 目标：让第三方 legado 客户端（含 legado 自带的 Vue Web 界面）能把本服务当成
// legado 的 Web 服务端使用。返回结构、路径、参数名、实体字段全部对齐：
//   api.md                            —— 对外契约
//   api/ReturnData.kt                 —— { isSuccess, errorMsg, data }
//   web/HttpServer.kt                 —— 路由表 + 令牌保护范围
//   api/controller/*.kt               —— 各接口语义
//   data/entities/{Book,BookChapter,BookSource,BookProgress,ReplaceRule}.kt —— 实体
// 端点（裸路径与 /api/legado/ 前缀两套都挂）：
//   GET  /getBookSources /getBookSource?url= /getBookshelf
//        /getChapterList?url= /refreshToc?url= /getBookContent?url=&index=
//        /cover?path= /image?url=&path=&width= /getReplaceRules /getReadConfig
//   POST /saveBookSource /saveBookSources /saveJsSource /deleteBookSources
//        /saveBook /deleteBook /saveBookProgress
//        /saveReplaceRule /deleteReplaceRule /testReplaceRule /saveReadConfig
//   WS   /searchBook /bookSourceDebug        （legado 里在 1235 端口，这里同端口挂载）
// 映射约定：
//   书源 ID = bookSourceUrl；书籍 ID = bookUrl；章节 = index（章节序号从 0 开始）
//   章节列表落在 cache/toc（与站内 /api/online/* 共用同一份缓存）
//
// 设计原则：不在本文件里重复实现抓取逻辑，全部复用 server.mjs 的抓取池与缓存，
// 由 server.mjs 通过 ctx 注入（见 createLegadoApi 的 ctx 契约）。
import crypto from "node:crypto";
import { extractJsSource, prepareForSave, validatePayload } from "./js-source.mjs";
import { javaRegex } from "./java-regex.mjs";
import { replaceWithRule } from "./replace-engine.mjs";

/** 与 legado JsSourceUpsert.MAX_SOURCE_BYTES 一致 */
export const MAX_JS_SOURCE_BYTES = 1024 * 1024;
/** 请求体上限（书源批量导入可能很大，给 32 MiB） */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/* ============================ 返回体 / HTTP 基础 ============================ */

/** ReturnData：legado 所有接口的统一返回体 */
function ok(data) { return { isSuccess: true, errorMsg: "", data: data === undefined ? null : data }; }
function fail(msg) { return { isSuccess: false, errorMsg: String(msg || "未知错误,请联系开发者"), data: null }; }

function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = {
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-legado-token",
    "cache-control": "no-store",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function sendReturn(req, res, rd, code = 200) {
  const body = Buffer.from(JSON.stringify(rd), "utf8");
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": body.length, ...corsHeaders(req) });
  res.end(body);
}

function sendBinary(req, res, buf, type) {
  res.writeHead(200, { "content-type": type || "image/jpeg", "content-length": buf.length, ...corsHeaders(req) });
  res.end(buf);
}

function sendText(req, res, code, text) {
  const body = Buffer.from(String(text ?? ""), "utf8");
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "content-length": body.length, ...corsHeaders(req) });
  res.end(body);
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * NanoHTTPD 的 parseBody 把裸请求体放进 files["postData"]。
 * 表单一类则先解出 postData 字段。这里两种都吃。
 */
function postDataOf(raw, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      const sp = new URLSearchParams(raw);
      const v = sp.get("postData");
      return v === null ? raw : v;
    } catch { return raw; }
  }
  return raw;
}

function jsonOf(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/* ============================ ctx 契约 ============================ */
// ctx 由 server.mjs 注入（复用现成函数，不重复实现抓取/缓存/持久化）：
//   parseSourceImport(text) exportSources(list) persistSources() refreshPool()
//   getPool() findOnlineBook(origin,bookUrl) okey(origin,bookUrl) ensureBookInfo(origin,bookUrl,opts)
//   readTocCache(origin,bookUrl) writeTocCache(origin,bookUrl,chapters) dropTocCache(origin,bookUrl)
//   applyReplaceRules(text)

/** BookType.text */
const BOOK_TYPE_TEXT = 8;

/** Web 书源访问令牌保护的写路由（HttpServer.PROTECTED_SOURCE_WRITE_ROUTES） */
const PROTECTED_ROUTES = new Set([
  "saveBookSource", "saveBookSources", "deleteBookSources",
  "saveRssSource", "saveRssSources", "deleteRssSources",
  "saveReplaceRule", "deleteReplaceRule", "testReplaceRule",
]);

/** 裸路径 → 处理名（与 legado HttpServer.kt 路由表一致） */
const GET_ROUTES = new Set([
  "getBookSources", "getBookSource", "getBookshelf", "getChapterList", "refreshToc",
  "getBookContent", "getBookInfo", "getReplaceRules", "getReadConfig", "cover", "image",
]);
const POST_ROUTES = new Set([
  "saveBookSource", "saveBookSources", "saveJsSource", "deleteBookSources",
  "saveBook", "deleteBook", "saveBookProgress", "saveReadConfig",
  "saveReplaceRule", "deleteReplaceRule", "testReplaceRule",
]);

/* ============================ 鉴权 ============================ */

function tokenOk(expected, given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * 令牌校验：reader.config.json 里没有 legadoToken（或为空）→ 放行（本项目的本地口径，
 * legado 原版是"未配置即拒绝"）。配了就只认 X-Legado-Token。 */
function checkToken(ctx, req) {
  const conf = ctx.getConfig();
  const expected = conf.legadoToken;
  if (expected === undefined || expected === null || String(expected).trim() === "") return null;
  if (tokenOk(expected, req.headers["x-legado-token"])) return null;
  return fail("Web 书源访问令牌未配置或不正确");
}

/* ============================ 实体映射 ============================ */

const chaptersOf = (ctx, book) => {
  const list = ctx.readTocCache(book.origin, book.bookUrl);
  return Array.isArray(list) ? list : null;
};

const progressOf = (ctx, book) => {
  const p = ctx.getConfig().online.progress[ctx.okey(book.origin, book.bookUrl)];
  return p && typeof p === "object" ? p : {};
};

/** 站内书籍 → legado Book 实体（字段名与 Book.kt 对齐） */
function toBookEntity(ctx, book) {
  const chapters = chaptersOf(ctx, book);
  const p = progressOf(ctx, book);
  const scroll = Number(p.scroll);
  return {
    bookUrl: String(book.bookUrl || ""),
    tocUrl: String(book.tocUrl || ""),
    origin: String(book.origin || ""),
    originName: String(book.originName || ""),
    name: String(book.name || ""),
    author: String(book.author || ""),
    kind: book.kind ?? null,
    customTag: book.customTag ?? null,
    coverUrl: book.coverUrl ?? null,
    customCoverUrl: book.customCoverUrl ?? null,
    intro: book.intro ?? null,
    customIntro: book.customIntro ?? null,
    charset: book.charset ?? null,
    type: Number(book.type) || BOOK_TYPE_TEXT,
    group: Number(book.group) || 0,
    latestChapterTitle: book.latestChapterTitle ?? null,
    latestChapterTime: Number(book.latestChapterTime) || 0,
    lastCheckTime: Number(book.lastCheckTime) || 0,
    lastCheckCount: Number(book.lastCheckCount) || 0,
    totalChapterNum: chapters ? chapters.length : (Number(book.totalChapterNum) || 0),
    durChapterTitle: p.title || book.durChapterTitle || null,
    durChapterIndex: Number(p.chapter) || 0,
    durVolumeIndex: 0,
    chapterInVolumeIndex: 0,
    durChapterPos: Number.isFinite(Number(p.pos)) ? Number(p.pos) : Math.round((Number.isFinite(scroll) ? scroll : 0) * 10000),
    durChapterTime: Number(p.at) || 0,
    wordCount: book.wordCount ?? null,
    canUpdate: book.canUpdate !== false,
    order: Number(book.customOrder) || 0,
    originOrder: 0,
    variable: book.variable ?? null,
    readConfig: book.readConfig ?? null,
    syncTime: Number(book.syncTime) || 0,
  };
}

/** 缓存章节 → legado BookChapter 实体（剔掉站内缓存里的 variableMap/__wrappedChapter 冗余） */
function toChapterEntity(c, i, bookUrl) {
  const variableMap = c.variableMap && typeof c.variableMap === "object" ? c.variableMap : {};
  const variable = c.variable != null
    ? String(c.variable)
    : (Object.keys(variableMap).length ? JSON.stringify(variableMap) : null);
  return {
    url: String(c.url || ""),
    title: String(c.title || ""),
    isVolume: c.isVolume === true,
    baseUrl: String(c.baseUrl || ""),
    bookUrl: String(c.bookUrl || bookUrl || ""),
    index: Number.isFinite(Number(c.index)) ? Number(c.index) : i,
    isVip: c.isVip === true,
    isPay: c.isPay === true,
    resourceUrl: c.resourceUrl ?? null,
    tag: c.tag ?? null,
    wordCount: c.wordCount ?? null,
    start: Number(c.start) || 0,
    end: Number(c.end) || 0,
    startFragmentId: c.startFragmentId ?? null,
    endFragmentId: c.endFragmentId ?? null,
    variable,
    imgUrl: c.imgUrl ?? null,
  };
}

/** legado ReplaceRule 实体（ReplaceRule.kt 默认值） */
function toRuleEntity(r, order) {
  const idNum = Number(r.id);
  return {
    id: Number.isFinite(idNum) && String(r.id).trim() !== "" ? idNum : r.id,
    name: String(r.name || ""),
    group: r.group ?? null,
    pattern: String(r.pattern || ""),
    replacement: String(r.replacement ?? ""),
    scope: r.scope ?? null,
    scopeTitle: r.scopeTitle === true,
    scopeContent: r.scopeContent !== false,
    excludeScope: r.excludeScope ?? null,
    isEnabled: r.isEnabled !== false,
    isRegex: r.isRegex !== false,
    timeoutMillisecond: Number(r.timeoutMillisecond) > 0 ? Math.trunc(Number(r.timeoutMillisecond)) : 3000,
    order: Number.isFinite(Number(r.order)) ? Math.trunc(Number(r.order)) : order,
  };
}

function fromRuleEntity(r, fallbackOrder) {
  const idNum = Number(r.id);
  return {
    id: Number.isFinite(idNum) && r.id !== undefined && r.id !== null && String(r.id).trim() !== "" ? idNum : Date.now(),
    name: String(r.name || ""),
    group: r.group ?? null,
    pattern: String(r.pattern || ""),
    replacement: String(r.replacement ?? ""),
    scope: r.scope ?? null,
    scopeTitle: r.scopeTitle === true,
    scopeContent: r.scopeContent !== false,
    excludeScope: r.excludeScope ?? null,
    isEnabled: r.isEnabled !== false,
    isRegex: r.isRegex !== false,
    timeoutMillisecond: Number(r.timeoutMillisecond) > 0 ? Math.trunc(Number(r.timeoutMillisecond)) : 3000,
    order: Number.isFinite(Number(r.order)) && r.order !== null && r.order !== undefined ? Math.trunc(Number(r.order)) : fallbackOrder,
  };
}

/* ============================ 书源 ============================ */

function upsertSource(ctx, raw) {
  const s = ctx.normalizeSource(raw);
  const list = ctx.getSources();
  const i = list.findIndex((x) => ctx.getSKey(x) === ctx.getSKey(s));
  if (i >= 0) list[i] = s; else list.push(s);
  ctx.setSources(list);
  return s;
}

function hGetBookSources(ctx) {
  const list = ctx.getSources();
  if (!list.length) return fail("设备源列表为空");
  return ok(list.map((s) => ({ ...s })));
}

function hGetBookSource(ctx, u) {
  const url = u.searchParams.get("url");
  if (!url) return fail("参数url不能为空，请指定源地址");
  const s = ctx.getSources().find((x) => ctx.getSKey(x) === url);
  if (!s) return fail("未找到源，请检查书源地址");
  return ok({ ...s });
}

async function hSaveBookSource(ctx, req) {
  const raw = postDataOf(await readRaw(req), req.headers["content-type"]);
  const obj = jsonOf(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fail("转换源失败");
  if (!String(obj.bookSourceName || "").trim() || !String(obj.bookSourceUrl || "").trim()) {
    return fail("源名称和URL不能为空");
  }
  const saved = upsertSource(ctx, obj);
  await ctx.persistSources();
  ctx.refreshPool();
  return ok(saved.bookSourceUrl === undefined ? "" : "");
}

async function hSaveBookSources(ctx, req) {
  const raw = postDataOf(await readRaw(req), req.headers["content-type"]);
  if (raw === null || raw === undefined || String(raw).trim() === "") return fail("数据为空");
  const arr = jsonOf(raw);
  if (!Array.isArray(arr) || !arr.length) return fail("转换源失败");
  const okSources = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (!String(item.bookSourceName || "").trim() || !String(item.bookSourceUrl || "").trim()) continue;
    okSources.push(upsertSource(ctx, item));
  }
  if (okSources.length) {
    await ctx.persistSources();
    ctx.refreshPool();
  }
  return ok(okSources);
}

async function hDeleteBookSources(ctx, req) {
  const raw = postDataOf(await readRaw(req), req.headers["content-type"]);
  const arr = jsonOf(raw);
  if (!Array.isArray(arr)) return fail("数据格式错误");
  const keys = new Set();
  for (const item of arr) {
    if (typeof item === "string") keys.add(item);
    else if (item && typeof item === "object" && item.bookSourceUrl) keys.add(String(item.bookSourceUrl));
  }
  if (!keys.size) return fail("数据格式错误");
  const list = ctx.getSources().filter((s) => !keys.has(ctx.getSKey(s)));
  ctx.setSources(list);
  await ctx.persistSources();
  ctx.refreshPool();
  return ok("已执行");
}

/** /saveJsSource：与 legado JsSourceUpsert 对齐（校验 CT/Content-Length/大小 + extract + prepareForSave） */
async function hSaveJsSource(ctx, req) {
  if (req.headers["transfer-encoding"] != null) return fail("JS源请求不支持 Transfer-Encoding");
  const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ct !== "text/plain") return fail("JS源请求 Content-Type 必须为 text/plain");
  const cl = Number(req.headers["content-length"]);
  if (!Number.isFinite(cl)) return fail("JS源请求必须提供 Content-Length");
  if (cl < 0 || cl > MAX_JS_SOURCE_BYTES) return fail("JS源脚本不能超过 1 MiB");
  const text = String(postDataOf(await readRaw(req), req.headers["content-type"]) ?? "").trim();
  const issue = validatePayload(text);
  if (issue === "EMPTY") return fail("数据不能为空");
  if (issue === "TOO_LARGE") return fail("JS源脚本不能超过 1 MiB");
  let source;
  try {
    source = extractJsSource(text, ctx.normalizeSource);
  } catch (e) {
    return fail((e && e.message) || "JS源保存失败");
  }
  const old = ctx.getSources().find((x) => ctx.getSKey(x) === String(source.bookSourceUrl)) || null;
  const prepared = prepareForSave(source, old).source;
  const saved = upsertSource(ctx, prepared);
  await ctx.persistSources();
  ctx.refreshPool();
  return ok(saved);
}

/* ============================ 替换规则 ============================ */

function rulesOf(ctx) { return ctx.getConfig().online.replaceRules || []; }

function hGetReplaceRules(ctx) {
  const list = rulesOf(ctx);
  return ok(JSON.stringify(list.map((r, i) => toRuleEntity(r, i + 1))));
}

function hSaveReplaceRule(ctx, obj) {
  if (!obj || typeof obj !== "object") return fail("格式不对");
  const incoming = Array.isArray(obj) ? obj : [obj];
  const list = rulesOf(ctx);
  let maxOrder = 0;
  for (const r of list) if (Number.isFinite(Number(r.order))) maxOrder = Math.max(maxOrder, Number(r.order));
  let saved = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    if (!String(raw.pattern || "").length && !String(raw.name || "").length) continue;
    const maxBefore = maxOrder;
    const rule = fromRuleEntity(raw, undefined);
    if (!Number.isFinite(Number(raw.order)) || raw.order === null || raw.order === undefined ||
        Number(raw.order) === -2147483648) {
      rule.order = maxBefore + 1;
    }
    maxOrder = Math.max(maxOrder, rule.order);
    const i = list.findIndex((r) => String(r.id) === String(rule.id));
    if (i >= 0) list[i] = rule; else list.push(rule);
    saved++;
  }
  if (!saved) return fail("格式不对");
  ctx.getConfig().online.replaceRules = list;
  ctx.saveConfig();
  return ok("");
}

function hDeleteReplaceRule(ctx, obj) {
  if (!obj || typeof obj !== "object") return fail("格式不对");
  const ids = (Array.isArray(obj) ? obj : [obj])
    .map((r) => (r && typeof r === "object" ? r.id : r))
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v));
  if (!ids.length) return fail("格式不对");
  ctx.getConfig().online.replaceRules = rulesOf(ctx).filter((r) => !ids.includes(String(r.id)));
  ctx.saveConfig();
  return ok("");
}

function hTestReplaceRule(obj) {
  if (!obj || typeof obj !== "object") return fail("格式不对");
  let rule = obj.rule;
  if (typeof rule === "string") rule = jsonOf(rule);
  if (!rule || typeof rule !== "object") return fail("格式不对");
  const pattern = String(rule.pattern || "");
  if (!pattern) return fail("替换规则不能为空");
  const text = String(obj.text ?? "");
  const replacement = String(rule.replacement ?? "");
  try {
    // legado ReplaceRuleController.testRule 走的是同一套 RegexExtensions.replace，
    // 不是 JS String.replace —— 这里必须复用替换引擎，否则测试通过、正文却不一样。
    const out = replaceWithRule({
      name: rule.name,
      text,
      pattern,
      replacement,
      isRegex: rule.isRegex !== false,
      timeout: Number(rule.timeoutMillisecond) > 0 ? Number(rule.timeoutMillisecond) : 3000,
    });
    return ok(out);
  } catch (e) {
    return ok(((e && e.stack) || String(e)) + "");
  }
}

/* ============================ 书籍 / 书架 ============================ */

const booksOf = (ctx) => ctx.getConfig().online.books;

const findShelfBook = (ctx, bookUrl, origin) => booksOf(ctx).find((b) => {
  if (String(b.bookUrl) !== String(bookUrl)) return false;
  return origin ? String(b.origin) === String(origin) : true;
}) || null;

function applyBookPatch(ctx, book, incoming) {
  const patch = {};
  for (const k of ["name", "author", "kind", "coverUrl", "intro", "tocUrl", "origin", "originName",
    "latestChapterTitle", "variable", "class", "customTag", "customCoverUrl", "customIntro", "wordCount"]) {
    if (incoming[k] !== undefined && incoming[k] !== null) patch[k] = incoming[k];
  }
  if (incoming.type !== undefined && incoming.type !== null) patch.type = Number(incoming.type) || BOOK_TYPE_TEXT;
  if (incoming.group !== undefined && incoming.group !== null) patch.group = Number(incoming.group) || 0;
  Object.assign(book, patch);
  const p = progressOf(ctx, book);
  const key = ctx.okey(book.origin, book.bookUrl);
  const next = { ...p };
  const pos = Number(incoming.durChapterPos);
  if (incoming.durChapterIndex !== undefined && incoming.durChapterIndex !== null) next.chapter = Number(incoming.durChapterIndex) || 0;
  if (Number.isFinite(pos)) next.pos = pos;
  if (pos !== undefined && !Number.isFinite(Number(p.scroll)) ) next.scroll = Math.max(0, Math.min(1, (Number.isFinite(pos) ? pos : 0) / 10000));
  if (incoming.durChapterTitle !== undefined) next.title = incoming.durChapterTitle;
  if (incoming.durChapterTime !== undefined && Number(incoming.durChapterTime)) next.at = Number(incoming.durChapterTime);
  if (Object.keys(next).length) ctx.getConfig().online.progress[key] = next;
}

function hGetBookshelf(ctx) {
  const books = booksOf(ctx);
  if (!books.length) return fail("还没有添加小说");
  const data = books.map((b) => toBookEntity(ctx, b));
  data.sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
  return ok(data);
}

function hSaveBook(ctx, obj) {
  const incoming = typeof obj === "string" ? jsonOf(obj) : obj;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return fail("格式不对");
  const bookUrl = String(incoming.bookUrl || "");
  if (!bookUrl) return fail("格式不对");
  let book = findShelfBook(ctx, bookUrl, incoming.origin ? String(incoming.origin) : null);
  if (!book) {
    book = {
      name: String(incoming.name || ""), author: String(incoming.author || ""),
      bookUrl, tocUrl: String(incoming.tocUrl || ""),
      origin: String(incoming.origin || ""), originName: String(incoming.originName || ""),
      kind: incoming.kind ?? null, coverUrl: incoming.coverUrl ?? null, intro: incoming.intro ?? null,
      latestChapterTitle: incoming.latestChapterTitle ?? null,
      type: Number(incoming.type) || BOOK_TYPE_TEXT, group: Number(incoming.group) || 0,
      addedAt: Date.now(), variable: incoming.variable ?? null,
    };
    booksOf(ctx).push(book);
  }
  applyBookPatch(ctx, book, incoming);
  ctx.saveConfig();
  return ok("");
}

function hDeleteBook(ctx, obj) {
  const incoming = typeof obj === "string" ? jsonOf(obj) : obj;
  if (!incoming || typeof incoming !== "object") return fail("格式不对");
  const bookUrl = String(incoming.bookUrl || "");
  if (!bookUrl) return fail("格式不对");
  const conf = ctx.getConfig();
  const doomed = conf.online.books.filter((b) => String(b.bookUrl) === bookUrl
    && (!incoming.origin || String(b.origin) === String(incoming.origin)));
  for (const b of doomed) {
    delete conf.online.progress[ctx.okey(b.origin, b.bookUrl)];
    ctx.dropTocCache(b.origin, b.bookUrl);
  }
  conf.online.books = conf.online.books.filter((b) => !doomed.includes(b));
  ctx.saveConfig();
  return ok("");
}

function hSaveBookProgress(ctx, obj) {
  const p = typeof obj === "string" ? jsonOf(obj) : obj;
  if (!p || typeof p !== "object") return fail("格式不对");
  const name = String(p.name || "");
  const author = String(p.author || "");
  const book = booksOf(ctx).find((b) => String(b.name) === name && String(b.author) === author);
  if (!book) return fail("格式不对");
  const key = ctx.okey(book.origin, book.bookUrl);
  const prev = ctx.getConfig().online.progress[key] || {};
  const pos = Number(p.durChapterPos);
  const next = {
    ...prev,
    chapter: Number(p.durChapterIndex) || 0,
    pos: Number.isFinite(pos) ? pos : (Number(prev.pos) || 0),
    title: p.durChapterTitle ?? prev.title ?? null,
    at: Number(p.durChapterTime) || Date.now(),
  };
  if (!Number.isFinite(Number(prev.scroll)) && Number.isFinite(pos)) {
    next.scroll = Math.max(0, Math.min(1, pos / 10000));
  }
  ctx.getConfig().online.progress[key] = next;
  if (next.title) book.durChapterTitle = next.title;
  ctx.saveConfig();
  return ok("");
}

/* ============================ 目录 / 正文 ============================ */

function chapterListOf(ctx, book) {
  return (chaptersOf(ctx, book) || []).map((c, i) => toChapterEntity(c, i, book.bookUrl));
}

async function refreshTocImpl(ctx, book) {
  const source = ctx.getSources().find((s) => ctx.getSKey(s) === String(book.origin));
  if (!source) return fail("未找到对应书源,请换源");
  try {
    if (!book.tocUrl) await ctx.ensureBookInfo(book.origin, book.bookUrl, { force: true });
    const r = await ctx.getPool().request("chapters", {
      sourceUrl: book.origin, book, runPerJs: false, isFromBookInfo: false,
    }, { timeout: ctx.getConfig().online.searchTimeout || 120000 });
    const chapters = r.result.chapters || [];
    ctx.writeTocCache(book.origin, book.bookUrl, chapters);
    book.totalChapterNum = chapters.length;
    if (r.result.book) {
      if (r.result.book.tocUrl) book.tocUrl = r.result.book.tocUrl;
      if (r.result.book.variable !== undefined) book.variable = r.result.book.variable;
      if (r.result.book.latestChapterTitle) book.latestChapterTitle = r.result.book.latestChapterTitle;
    }
    ctx.saveConfig();
    return ok(chapterListOf(ctx, book));
  } catch (e) {
    return fail((e && e.message) || "refresh toc error");
  }
}

async function hGetChapterList(ctx, u) {
  const bookUrl = u.searchParams.get("url");
  if (!bookUrl) return fail("参数url不能为空，请指定书籍地址");
  const book = findShelfBook(ctx, bookUrl);
  if (!book) return fail("未在数据库找到对应书籍，请先添加");
  const cached = chaptersOf(ctx, book);
  if (cached && cached.length) return ok(chapterListOf(ctx, book));
  return await refreshTocImpl(ctx, book);
}

async function hGetBookContent(ctx, u) {
  const bookUrl = u.searchParams.get("url");
  const indexRaw = u.searchParams.get("index");
  if (!bookUrl) return fail("参数url不能为空，请指定书籍地址");
  if (indexRaw === null || indexRaw === "" || !Number.isFinite(Number(indexRaw))) {
    return fail("参数index不能为空, 请指定目录序号");
  }
  const index = Number(indexRaw);
  const book = findShelfBook(ctx, bookUrl);
  if (!book) return fail("未找到");
  let chapters = chaptersOf(ctx, book);
  if (!chapters || !chapters.length) {
    const r = await refreshTocImpl(ctx, book);
    if (!r.isSuccess) return r;
    chapters = chaptersOf(ctx, book);
  }
  if (!chapters || !chapters[index]) return fail("未找到");
  const chapter = chapters[index];
  const next = chapters[index + 1];
  try {
    const r = await ctx.getPool().request("content", {
      sourceUrl: book.origin, book, chapter,
      nextChapterUrl: next ? next.url : null, refresh: false, needSave: true,
    }, { timeout: ctx.getConfig().online.searchTimeout || 120000 });
    return ok(ctx.applyReplaceRules(r.result.content || ""));
  } catch (e) {
    return fail((e && e.message) || "获取正文失败");
  }
}

async function hGetBookInfo(ctx, u) {
  const bookUrl = u.searchParams.get("url");
  if (!bookUrl) return fail("参数url不能为空，请指定书籍地址");
  const book = findShelfBook(ctx, bookUrl);
  if (!book) return fail("未在数据库找到对应书籍，请先添加");
  const force = u.searchParams.get("refresh") === "1";
  try {
    if (force || !book.tocUrl) await ctx.ensureBookInfo(book.origin, book.bookUrl, { force });
  } catch (e) {
    return fail((e && e.message) || "获取详情失败");
  }
  return ok(toBookEntity(ctx, book));
}

/* ============================ 阅读配置 ============================ */

function hGetReadConfig(ctx) {
  const data = ctx.getConfig().legadoReadConfig;
  if (data === undefined || data === null || data === "") return fail("没有配置");
  return ok(typeof data === "string" ? data : JSON.stringify(data));
}

async function hSaveReadConfig(ctx, req) {
  const raw = postDataOf(await readRaw(req), req.headers["content-type"]);
  if (raw && String(raw).trim()) ctx.getConfig().legadoReadConfig = String(raw);
  else delete ctx.getConfig().legadoReadConfig;
  ctx.saveConfig();
  return ok("");
}

/* ============================ 封面 / 正文图片 ============================ */

async function proxyImage(req, res, url, referer) {
  if (!/^https?:/i.test(url)) { sendText(req, res, 400, "仅支持 http(s)"); return true; }
  try {
    const headers = { "user-agent": "Mozilla/5.0" };
    if (referer) { try { headers.referer = referer; } catch {} }
    const r = await fetch(url, { headers });
    if (!r.ok) { sendText(req, res, 502, "HTTP " + r.status); return true; }
    sendBinary(req, res, Buffer.from(await r.arrayBuffer()), r.headers.get("content-type") || "image/jpeg");
  } catch (e) {
    sendText(req, res, 502, (e && e.message) || "图片获取失败");
  }
  return true;
}

async function hCover(ctx, req, res, u) {
  const p = u.searchParams.get("path");
  if (!p) { sendText(req, res, 400, "path不能为空"); return true; }
  return await proxyImage(req, res, p, null);
}

async function hImage(ctx, req, res, u) {
  const bookUrl = u.searchParams.get("url");
  const src = u.searchParams.get("path");
  if (!bookUrl) { sendText(req, res, 400, "bookUrl为空"); return true; }
  if (!src) { sendText(req, res, 400, "图片链接为空"); return true; }
  const book = findShelfBook(ctx, bookUrl);
  let referer = null;
  if (book && book.tocUrl) referer = book.tocUrl;
  else { try { referer = new URL(bookUrl).origin; } catch {} }
  return await proxyImage(req, res, src, referer);
}

/* ============================ WebSocket（RFC6455 手写实现） ============================ */
// legado 的 /searchBook 与 /bookSourceDebug 是 WebSocket。本项目没有 ws 依赖，
// 这里手写最小帧实现：只处理文本帧 / close / ping(pong)，客户端帧必带掩码需 XOR 解码。

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_FRAME = 8 * 1024 * 1024;
const WS_ROUTES = new Set(["searchBook", "bookSourceDebug"]);

function wsAccept(key) {
  return crypto.createHash("sha1").update(String(key) + WS_GUID).digest("base64");
}

function wsFrame(opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? "" : payload), "utf8");
  const len = buf.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, buf]);
}

function wsSendText(socket, text) { try { socket.write(wsFrame(0x1, text)); } catch { /* 连接已断 */ } }
function wsSendPing(socket) { try { socket.write(wsFrame(0x9, "ping")); } catch { /* 连接已断 */ } }
function wsSendPong(socket, payload) { try { socket.write(wsFrame(0xa, payload || Buffer.alloc(0))); } catch { /* 连接已断 */ } }

/** 发关闭帧（正常关闭码 1000），随后断开 TCP */
function wsClose(socket, code, reason) {
  try {
    const r = Buffer.from(String(reason || ""), "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    socket.write(wsFrame(0x8, p));
  } catch { /* 连接已断 */ }
  try { socket.end(); } catch { /* 连接已断 */ }
  try { socket.destroy(); } catch { /* 连接已断 */ }
}

/** 解析缓冲区里所有完整帧，残留留回 state.buf */
function wsParseFrames(state, chunk) {
  state.buf = state.buf && state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  const out = [];
  for (;;) {
    const b = state.buf;
    if (!b || b.length < 2) break;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_WS_FRAME) { out.push({ fin: true, opcode: 0x8, payload: Buffer.alloc(0), tooLarge: true }); state.buf = Buffer.alloc(0); break; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) break;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      const copy = Buffer.alloc(len);
      for (let i = 0; i < len; i++) copy[i] = payload[i] ^ mask[i & 3];
      payload = copy;
    }
    state.buf = b.subarray(off + maskLen + len);
    out.push({ fin, opcode, payload });
  }
  return out;
}

/** legado 用 base64url(令牌, 无填充) 放在 Sec-WebSocket-Protocol 第二项 */
function wsExpectedProtocol(token) {
  return "legado.token." + Buffer.from(String(token).trim(), "utf8").toString("base64url");
}

/* ============================ 路由 ============================ */

function stripPrefix(pathname) {
  if (pathname.startsWith("/api/legado/")) return pathname.slice("/api/legado/".length);
  if (pathname === "/api/legado") return "";
  return pathname.replace(/^\/+/, "");
}

/* ============================ WebSocket 会话 ============================ */

/** 搜索快照：把 beWorker 回包的书籍合并成 legado SearchBook 数组（同 name+author 合并 origins） */
function mergeSnapshot(acc, item) {
  for (const raw of (item.books || [])) {
    const key = String(raw.name || "") + "\u0000" + String(raw.author || "");
    const hit = acc.get(key);
    const origins = new Set(Array.isArray(raw.origins) && raw.origins.length ? raw.origins : (raw.origin ? [raw.origin] : []));
    if (hit) { for (const o of origins) hit.origins.add(o); continue; }
    acc.set(key, {
      bookUrl: String(raw.bookUrl || ""), origin: String(raw.origin || ""),
      originName: String(raw.originName || ""), type: Number(raw.type) || BOOK_TYPE_TEXT,
      name: String(raw.name || ""), author: String(raw.author || ""),
      kind: raw.kind ?? null, coverUrl: raw.coverUrl ?? null, intro: raw.intro ?? null,
      wordCount: raw.wordCount ?? null, latestChapterTitle: raw.latestChapterTitle ?? null,
      tocUrl: String(raw.tocUrl || ""), time: Date.now(), variable: raw.variable ?? null,
      originOrder: 0, chapterWordCountText: null, chapterWordCount: -1,
      respondTime: Number(raw.respondTime) >= 0 ? Number(raw.respondTime) : (Number(item.respondTime) || -1),
      origins,
    });
  }
}

function snapshotJson(acc) {
  return JSON.stringify([...acc.values()].map((b) => ({ ...b, origins: [...b.origins] })));
}

/** /searchBook：收到 {key} 后按源增量推快照，全部完成时 close(1000,"Search finish") */
async function runSearchSocket(socket, ctx, key) {
  const acc = new Map();
  const sources = (ctx.enabledSources ? ctx.enabledSources() : ctx.getSources()).filter((x) => x.enabled !== false);
  let last = "";
  const push = () => {
    const json = snapshotJson(acc);
    if (json === last) return;
    last = json;
    wsSendText(socket, json);
  };
  try {
    await ctx.getPool().searchAll(sources, key, {
      page: 1, precision: false, timeout: (ctx.getConfig().online.searchTimeout || 45000),
      onSource: (item) => { mergeSnapshot(acc, item); push(); },
    });
    push();
  } catch (e) {
    wsClose(socket, 1000, (e && e.message) || "Search finish");
    return;
  }
  wsClose(socket, 1000, "Search finish");
}

/** /bookSourceDebug：收到 {tag(源地址),key} 后逐行推日志，完成后 close(1000,"调试结束") */
async function runDebugSocket(socket, ctx, tag, key) {
  const source = ctx.getSourceByUrl ? ctx.getSourceByUrl(tag) : ctx.getSources().find((x) => ctx.getSKey(x) === tag);
  if (!source) { wsSendText(socket, "书源不存在"); wsClose(socket, 1000, "调试结束"); return; }
  let logs = [];
  try {
    const r = await ctx.getPool().request("debug", { sourceUrl: tag, key }, {
      timeout: ctx.getConfig().online.searchTimeout || 90000,
    });
    logs = (r.result && r.result.logs) || [];
    for (const line of logs) wsSendText(socket, String(line));
    const steps = (r.result && r.result.steps) || [];
    for (const st of steps) {
      wsSendText(socket, `${st.name}: ${st.ok ? "成功" : "失败"} (${st.cost}ms)${st.error ? " " + st.error : ""}`);
    }
    const books = (r.result && r.result.books) || [];
    for (const b of books) wsSendText(socket, `书: ${b.name} / ${b.author}`);
    if (r.result && r.result.chapterCount) wsSendText(socket, `目录条数: ${r.result.chapterCount}`);
    if (r.result && r.result.contentPreview) wsSendText(socket, `正文预览: ${String(r.result.contentPreview).slice(0, 400)}`);
  } catch (e) {
    wsSendText(socket, `调试失败: ${(e && e.message) || String(e)}`);
  }
  wsClose(socket, 1000, "调试结束");
}

/**
 * legado api.md 兼容入口。
 */
export function createLegadoApi(ctx) {
  async function tryHandle(req, res, u) {
    const name = stripPrefix(u.pathname);
    if (!name || name.includes("/")) return false;
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";
    if (req.method === "OPTIONS") {
      res.writeHead(200, { "content-length": 0, ...corsHeaders(req) });
      res.end();
      return true;
    }
    if (!(isGet ? GET_ROUTES.has(name) : isPost ? POST_ROUTES.has(name) : false)) return false;

    try {
      if (isPost && (PROTECTED_ROUTES.has(name) || name === "saveJsSource")) {
        const denied = checkToken(ctx, req);
        if (denied) { sendReturn(req, res, denied); return true; }
      }

      let rd;
      switch (name) {
        case "getBookSources": rd = hGetBookSources(ctx); break;
        case "getBookSource": rd = hGetBookSource(ctx, u); break;
        case "saveBookSource": rd = await hSaveBookSource(ctx, req); break;
        case "saveBookSources": rd = await hSaveBookSources(ctx, req); break;
        case "deleteBookSources": rd = await hDeleteBookSources(ctx, req); break;
        case "saveJsSource": rd = await hSaveJsSource(ctx, req); break;
        case "getReplaceRules": rd = hGetReplaceRules(ctx); break;
        case "saveReplaceRule": rd = hSaveReplaceRule(ctx, jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "deleteReplaceRule": rd = hDeleteReplaceRule(ctx, jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "testReplaceRule": rd = hTestReplaceRule(jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "getBookshelf": rd = hGetBookshelf(ctx); break;
        case "saveBook": rd = hSaveBook(ctx, jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "deleteBook": rd = hDeleteBook(ctx, jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "saveBookProgress": rd = hSaveBookProgress(ctx, jsonOf(postDataOf(await readRaw(req), req.headers["content-type"]))); break;
        case "getChapterList": rd = await hGetChapterList(ctx, u); break;
        case "refreshToc": {
          const bookUrl = u.searchParams.get("url");
          if (!bookUrl) { rd = fail("参数url不能为空，请指定书籍地址"); break; }
          const book = findShelfBook(ctx, bookUrl);
          rd = book ? await refreshTocImpl(ctx, book) : fail("未在数据库找到对应书籍，请先添加");
          break;
        }
        case "getBookContent": rd = await hGetBookContent(ctx, u); break;
        case "getBookInfo": rd = await hGetBookInfo(ctx, u); break;
        case "getReadConfig": rd = hGetReadConfig(ctx); break;
        case "saveReadConfig": rd = await hSaveReadConfig(ctx, req); break;
        case "cover": return await hCover(ctx, req, res, u);
        case "image": return await hImage(ctx, req, res, u);
        default: return false;
      }
      sendReturn(req, res, rd);
    } catch (e) {
      sendReturn(req, res, fail((e && e.message) || String(e)));
    }
    return true;
  }
  /**
   * WS 升级入口。挂在 http.Server 的 upgrade 事件上。
   * @returns {boolean} 是否已接管（false = 不是本站 WS 路径，调用方应 socket.destroy()）
   */
  function handleUpgrade(req, socket) {
    let u;
    try { u = new URL(req.url, "http://localhost"); } catch { return false; }
    const name = stripPrefix(u.pathname);
    if (!WS_ROUTES.has(name)) return false;

    const key = req.headers["sec-websocket-key"];
    const ver = req.headers["sec-websocket-version"];
    if (!key || String(ver || "") !== "13") {
      try { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* noop */ }
      socket.destroy();
      return true;
    }

    // 令牌：legado 要求 Sec-WebSocket-Protocol 恰为 [legado, legado.token.<b64url>]，
    // 且固定协议在第一项。本项目未配 legadoToken 即放行；配了则必须匹配。
    const conf = ctx.getConfig();
    const token = conf.legadoToken;
    const hasToken = token !== undefined && token !== null && String(token).trim() !== "";
    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    // 未配置 legadoToken 时放宽为只要求首项 legado（兼容 third-party 客户端）。
    if (protocols[0] !== "legado" || (hasToken && protocols.length !== 2)) {
      try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch { /* noop */ }
      socket.destroy();
      return true;
    }
    if (hasToken && protocols[1] !== wsExpectedProtocol(token)) {
      try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch { /* noop */ }
      socket.destroy();
      return true;
    }

    const head = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + wsAccept(key),
      "Sec-WebSocket-Protocol: legado",
      "", "",
    ].join("\r\n");
    try { socket.write(head); } catch { socket.destroy(); return true; }
    if (socket.setNoDelay) socket.setNoDelay(true);

    const state = { buf: Buffer.alloc(0), closed: false, authed: false };
    let hb = null;
    const stopHeartbeat = () => { if (hb) { clearInterval(hb); hb = null; } };

    // legado：握手后 10s 内未收到首帧即按策略违规关闭
    const authTimer = setTimeout(() => {
      if (!state.authed) wsClose(socket, 1008, "认证超时");
    }, 10000);

    socket.on("data", (chunk) => {
      let frames;
      try { frames = wsParseFrames(state, chunk); } catch { frames = []; }
      for (const f of frames) {
        if (f.tooLarge) { wsClose(socket, 1009, "帧过大"); return; }
        if (f.opcode === 0x8) { stopHeartbeat(); state.closed = true; try { socket.end(); } catch { /* noop */ } return; }
        if (f.opcode === 0x9) { wsSendPong(socket, f.payload); continue; }
        if (f.opcode !== 0x1) continue;
        if (state.authed) continue;
        const text = f.payload.toString("utf8");
        let obj = null;
        try { obj = JSON.parse(text); } catch { obj = null; }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          wsClose(socket, 1008, "认证数据格式错误");
          return;
        }
        state.authed = true;
        clearTimeout(authTimer);
        hb = setInterval(() => { if (!state.closed) wsSendPing(socket); }, 30000);
        if (hb.unref) hb.unref();
        const kw = String(obj.key == null ? "" : obj.key);
        if (name === "searchBook") {
          if (!kw.trim()) { wsSendText(socket, "不能为空"); wsClose(socket, 1000, "Search finish"); return; }
          runSearchSocket(socket, ctx, kw.trim()).catch(() => wsClose(socket, 1000, "Search finish"));
        } else {
          const tag = String(obj.tag == null ? "" : obj.tag);
          if (!tag.trim() || !kw.trim()) { wsSendText(socket, "不能为空"); wsClose(socket, 1000, "调试结束"); return; }
          runDebugSocket(socket, ctx, tag.trim(), kw.trim()).catch(() => wsClose(socket, 1000, "调试结束"));
        }
        return;
      }
    });

    socket.on("error", () => { stopHeartbeat(); clearTimeout(authTimer); try { socket.destroy(); } catch { /* noop */ } });
    socket.on("close", () => { stopHeartbeat(); clearTimeout(authTimer); });
    return true;
  }

  return { tryHandle, handleUpgrade };
}

