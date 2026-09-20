// js-source.mjs —— legado JS 单文件源执行器（1:1 移植）
//   model/jsSource/JsSourceEngine.kt     — 每次调用新建 scope：绑定 → 挂共享原型 → eval 主脚本 → eval 调用表达式
//   model/jsSource/JsSourceMarshaller.kt — 返回值 → 实体（搜索/详情/目录/正文）
//   model/jsSource/JsSourceBook.kt       — search/explore/getBookInfo/getChapterList/getContent 编排
//   model/jsSource/JsSourceConfig.kt     — 从脚本里 extract 出 config 对象 → BookSource
//   model/jsSource/JsSourceUpsert.kt     — 保存前校验 / 用户态保留 / lastUpdateTime 戳
//
// ⚠ 与 web-book.mjs 相同：内部全是同步阻塞调用，必须在 worker 线程里跑。
import {
  jsRuntime, wrapSource, wrapBook, wrapChapter, wrapNetwork, mixJavaBridge, makeServices,
} from './rule-engine.mjs';
import { JavaBridgeBase } from './js-runtime.mjs';
import { getAbsoluteURL } from './net-utils.mjs';
import {
  BookType, getBookType, createSearchBook, createChapter,
  updateBookTocInfo, removeAllBookType, addBookType,
} from './web-book.mjs';

/* ============================ 编译缓存（JsSourceEngine.scriptCache, LruCache(64)） ============================ */

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { if (!this.map.has(k)) return undefined; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
  put(k, v) { if (this.map.has(k)) this.map.delete(k); this.map.set(k, v); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  clear() { this.map.clear(); }
}

const scriptCache = new Lru(64);

function compileCached(code, filename = 'legado-js-source') {
  const key = String(code);
  let script = scriptCache.get(key);
  if (!script) { script = jsRuntime.compile(key, filename); scriptCache.put(key, script); }
  return script;
}

/* ============================ 返回值归一化 ============================ */

/**
 * JsSourceEngine.normalizeJsResult（spec §2-5）
 *   String 原样；null/undefined → null；其余对象走 JSON.stringify（legado 走引擎自身
 *   NativeJSON.stringify，避免 GSON 反射 Rhino 惰性类型）。
 */
export function normalizeJsResult(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return value.toString();
  if (t === 'function') return null;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? null : s;
  } catch (e) {
    throw new Error(`JS返回值 JSON.stringify 失败: ${e && e.message}`);
  }
}

/** GSON 风格取值：健壮地从对象里读字符串/整数 */
function asString(v) { return v === null || v === undefined ? '' : String(v); }
function asIntOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}
function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

/* ============================ JsSourceEngine ============================ */

/**
 * 纯 JS 单文件源执行器。
 * 每次 callFunction 都新建 scope（并发隔离），args 既作为函数参数、也作为环境绑定。
 * @param {object} source 书源（必须有 mainJs）
 * @param {object} ctx    makeContext() 产物（services / logger / debug）
 */
export class JsSourceEngine {
  constructor(source, ctx) {
    this.source = source;
    this.ctx = ctx || {};
    this._java = null;
    // 脚本执行超时（legado 无此限制；这里给个宽松上限，避免书源死循环拖死 worker）
    this.jsTimeoutMs = Number((this.ctx && this.ctx.jsTimeoutMs) || 120000);
  }

  getSource() { return this.source; }
  getTag() { return this.source ? (this.source.bookSourceName || '') : ''; }

  /** JsExtensions：java 桥接（ajax / md5Encode / CryptoJS 之外的 java.* 工具） */
  javaBridge() {
    if (this._java) return this._java;
    const ctx = this.ctx;
    const services = ctx.services || makeServices(ctx.logger || null);
    const base = new JavaBridgeBase({
      source: this.source,
      cookieStore: services.cookieStore,
      cache: services.cache,
      logger: ctx.logger || null,
      network: wrapNetwork(services.network, this.source),
      browserActions: ctx.browserActions || null,
    });
    this._java = mixJavaBridge(base, {
      getSource: () => this.source,
      getTag: () => this.getTag(),
    });
    return this._java;
  }

  /** callFunction：函数缺失抛「JS源缺少函数 $name」 */
  callFunction(name, args = []) {
    return this._call(name, args, true);
  }

  /** callFunctionIfExists：缺失返回 null */
  callFunctionIfExists(name, args = []) {
    return this._call(name, args, false);
  }

  _call(name, args, required) {
    const scope = this.buildScope(args);
    if (!jsRuntime.hasFunction(scope, name)) {
      if (required) throw new Error(`JS源缺少函数 ${name}`);
      return null;
    }
    const callExpr = `${name}(${args.map((a) => a[0]).join(', ')})`;
    let raw;
    try {
      raw = compileCached(callExpr, `legado-js-call:${name}`).runInContext(scope, { timeout: this.jsTimeoutMs });
    } catch (e) {
      throw new Error(`JS源调用 ${name} 失败: ${(e && e.message) || e}`);
    }
    return normalizeJsResult(raw);
  }

  /**
   * buildScope（JsSourceEngine.buildScope）：
   *   bindings = { java, source, sourceApi, baseUrl, cookie, cache } + args
   *   eval mainJs → 返回作用域
   */
  buildScope(args) {
    const source = this.source;
    const mainJs = source ? source.mainJs : null;
    if (isBlank(mainJs)) throw new Error('mainJs 为空,不是JS源');
    const ctx = this.ctx;
    const services = ctx.services || makeServices(ctx.logger || null);
    const wsrc = wrapSource(source, {
      cookieStore: services.cookieStore, cache: services.cache, logger: ctx.logger || null,
      network: services.network,
    });

    const bindings = {
      java: this.javaBridge(),
      source: wsrc,
      sourceApi: wsrc,
      baseUrl: String(source.bookSourceUrl || ''),
      cookie: services.cookieStore,
      cache: services.cache,
    };
    for (const [k, v] of args) bindings[k] = v;

    const scope = jsRuntime.createScope(`legado-jssource-${String(source.bookSourceUrl || '')}`);
    jsRuntime._installGlobals(scope, bindings);
    try {
      jsRuntime.compile(String(mainJs), 'legado-main-js').runInContext(scope, { timeout: this.jsTimeoutMs });
    } catch (e) {
      throw new Error(`JS源脚本执行失败: ${(e && e.message) || e}`);
    }
    // 调用表达式执行前再刷一次 bindings（主脚本可能覆盖了 java/source）
    jsRuntime._installGlobals(scope, bindings);
    return scope;
  }
}

/* ============================ JsSourceMarshaller ============================ */

/** validateBookType：0 或含非法位 → null */
export function validateBookType(raw) {
  if (raw === 0) return null;
  if ((raw & ~BookType.allBookType) !== 0) return null;
  return raw;
}

function debugLog(ctx, source, message) {
  try {
    if (ctx && ctx.debug && ctx.debug.log) ctx.debug.log(message, 1);
    else if (ctx && ctx.logger) ctx.logger(message);
  } catch (e) { /* ignore */ }
}

/** resolveType：有合法 type 用之，否则回退书源类型 */
export function resolveType(jsonObj, source, ctx) {
  if (jsonObj && Object.prototype.hasOwnProperty.call(jsonObj, 'type')) {
    const raw = asIntOrNull(jsonObj.type);
    const ok = raw === null ? null : validateBookType(raw);
    if (ok !== null) return ok;
    debugLog(ctx, source, '⇒type 非法,回退书源类型');
  }
  return getBookType(source);
}

/** parseSearchBooks：需 name/bookUrl 非空；设 origin/originName/originOrder/type */
export function parseSearchBooks(json, source, ctx) {
  const result = [];
  if (isBlank(json)) return result;
  let array;
  try { array = JSON.parse(String(json)); } catch (e) { throw new Error('search/explore 返回值不是数组'); }
  if (!Array.isArray(array)) throw new Error('search/explore 返回值不是数组');
  for (const element of array) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const book = createSearchBook({
      name: asString(element.name),
      author: asString(element.author),
      bookUrl: asString(element.bookUrl),
      coverUrl: isBlank(element.coverUrl) ? null : asString(element.coverUrl),
      intro: isBlank(element.intro) ? null : asString(element.intro),
      kind: isBlank(element.kind) ? null : asString(element.kind),
      wordCount: isBlank(element.wordCount) ? null : asString(element.wordCount),
      latestChapterTitle: isBlank(element.latestChapterTitle) ? null : asString(element.latestChapterTitle),
      tocUrl: asString(element.tocUrl),
    });
    if (isBlank(book.name) || isBlank(book.bookUrl)) {
      debugLog(ctx, source, '⇒丢弃缺少 name/bookUrl 的搜索条目');
      continue;
    }
    book.origin = String(source.bookSourceUrl || '');
    book.originName = String(source.bookSourceName || '');
    book.originOrder = Number(source.customOrder) || 0;
    book.type = resolveType(element, source, ctx);
    book.origins = new Set([book.origin]);
    result.push(book);
  }
  return result;
}

/** mergeVariable：对象或 JSON 串 → book.variableMap */
function mergeVariable(book, value, source, ctx) {
  let variables = null;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) variables = value;
    else if (typeof value === 'string') {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) variables = parsed;
    }
  } catch (e) { variables = null; }
  if (variables === null) { debugLog(ctx, source, '⇒variable 不是合法 JSON 对象,忽略'); return; }
  book.variableMap = {};
  for (const [k, v] of Object.entries(variables)) book.variableMap[k] = v === null || v === undefined ? null : String(v);
  book.variable = JSON.stringify(book.variableMap);
}

/** mergeBookInfo：getBookInfo 返回值覆盖 book 字段 */
export function mergeBookInfo(book, json, source, canReName, ctx) {
  if (isBlank(json)) return book;
  let obj;
  try { obj = JSON.parse(String(json)); } catch (e) { throw new Error('getBookInfo 返回值不是对象'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('getBookInfo 返回值不是对象');
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    switch (key) {
      case 'name': if (canReName) book.name = asString(value); break;
      case 'author': book.author = asString(value); break;
      case 'intro': book.intro = asString(value); break;
      case 'coverUrl': book.coverUrl = asString(value); break;
      case 'kind': book.kind = asString(value); break;
      case 'wordCount': book.wordCount = asString(value); break;
      case 'latestChapterTitle': book.latestChapterTitle = asString(value); break;
      case 'tocUrl': book.tocUrl = asString(value); break;
      case 'variable': mergeVariable(book, value, source, ctx); break;
      case 'type': {
        const raw = asIntOrNull(value);
        const ok = raw === null ? null : validateBookType(raw);
        if (ok !== null) book.type = ok;
        else debugLog(ctx, source, '⇒type 非法,忽略详情覆盖');
        break;
      }
      default: break;
    }
  }
  return book;
}

/** parseChapters：需 title/url 非空；补 bookUrl/baseUrl/index */
export function parseChapters(json, book, source, ctx) {
  const chapters = [];
  if (isBlank(json)) return chapters;
  let array;
  try { array = JSON.parse(String(json)); } catch (e) { throw new Error('getChapters 返回值不是数组'); }
  if (!Array.isArray(array)) throw new Error('getChapters 返回值不是数组');
  for (const element of array) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const chapter = createChapter({
      title: asString(element.title),
      url: asString(element.url),
      isVolume: element.isVolume === true,
      tag: isBlank(element.tag) ? null : asString(element.tag),
      isVip: element.isVip === true,
      isPay: element.isPay === true,
      resourceUrl: isBlank(element.resourceUrl) ? null : asString(element.resourceUrl),
      wordCount: isBlank(element.wordCount) ? null : asString(element.wordCount),
      start: asIntOrNull(element.start) || 0,
      end: asIntOrNull(element.end) || 0,
      startFragmentId: isBlank(element.startFragmentId) ? null : asString(element.startFragmentId),
      endFragmentId: isBlank(element.endFragmentId) ? null : asString(element.endFragmentId),
      imgUrl: isBlank(element.imgUrl) ? null : asString(element.imgUrl),
      baseUrl: String(book.tocUrl == null ? '' : book.tocUrl),
      bookUrl: String(book.bookUrl || ''),
    });
    if (isBlank(chapter.title) || isBlank(chapter.url)) {
      debugLog(ctx, source, '⇒丢弃缺少 title/url 的章节');
      continue;
    }
    if (!(chapter.isVolume && chapter.url === chapter.title)) {
      chapter.url = getAbsoluteURL(String(book.tocUrl == null ? '' : book.tocUrl), chapter.url);
    }
    chapter.bookUrl = book.bookUrl;
    chapter.baseUrl = book.tocUrl;
    chapter.index = chapters.length;
    chapters.push(chapter);
  }
  return chapters;
}

/* ============================ JsSourceBook ============================ */

function makeEngine(ctx, source) { return new JsSourceEngine(source, ctx); }

function summary(ctx) { return ctx && ctx.debug ? ctx.debug : null; }

function logSummary(ctx, source, lines) {
  const dbg = summary(ctx);
  if (!dbg) return;
  try { for (const l of lines()) dbg.log(l, 1); } catch (e) { /* ignore */ }
}

function logHtml(ctx, source, text, state) {
  const dbg = summary(ctx);
  if (!dbg) return;
  try { dbg.log(text, state); } catch (e) { /* ignore */ }
}

/** JsSourceBook.searchAwait */
export function search(ctx, source, key, page = 1, filter = null) {
  const engine = makeEngine(ctx, source);
  const json = engine.callFunction('search', [['key', key], ['page', page === null || page === undefined ? 1 : page]]);
  logHtml(ctx, source, json || '', 10);
  const books = parseSearchBooks(json, source, ctx);
  let out = books;
  if (typeof filter === 'function') out = books.filter((b) => filter(b.name, b.author, b.kind));
  debugLog(ctx, source, `◇JS源搜索完成,共${out.length}条`);
  logSummary(ctx, source, () => books.map((b) => `◇${b.name}(${b.author}) ${b.bookUrl}`));
  return out;
}

/** JsSourceBook.exploreAwait */
export function explore(ctx, source, url, page = 1) {
  const engine = makeEngine(ctx, source);
  const json = engine.callFunction('explore', [['url', url], ['page', page === null || page === undefined ? 1 : page]]);
  logHtml(ctx, source, json || '', 10);
  const books = parseSearchBooks(json, source, ctx);
  debugLog(ctx, source, `◇JS源发现完成,共${books.length}条`);
  return books;
}

/** JsSourceBook.getBookInfoAwait */
export function getBookInfo(ctx, source, book, canReName = true) {
  removeAllBookType(book);
  addBookType(book, getBookType(source));
  const engine = makeEngine(ctx, source);
  const json = engine.callFunctionIfExists('getBookInfo', [['book', wrapBook(book, {
    cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger: ctx.logger, network: ctx.services.network,
  })]]);
  if (json === null) debugLog(ctx, source, '≡getBookInfo 未定义或无返回,沿用搜索阶段字段');
  logHtml(ctx, source, json || '', 20);
  mergeBookInfo(book, json, source, canReName, ctx);
  if (isBlank(book.tocUrl)) book.tocUrl = book.bookUrl;
  return book;
}

/** JsSourceBook.getChapterListAwait */
export function getChapterList(ctx, source, book) {
  removeAllBookType(book);
  addBookType(book, getBookType(source));
  const engine = makeEngine(ctx, source);
  const json = engine.callFunction('getChapters', [['book', wrapBook(book, {
    cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger: ctx.logger, network: ctx.services.network,
  })]]);
  logHtml(ctx, source, json || '', 30);
  const chapters = parseChapters(json, book, source, ctx);
  if (chapters.length === 0) throw new Error('JS源目录为空');
  updateBookTocInfo(book, chapters);
  debugLog(ctx, source, `◇JS源目录完成,共${chapters.length}章`);
  return chapters;
}

/** JsSourceBook.getContentAwait */
export function getContent(ctx, source, book, chapter, nextChapterUrl = null) {
  if (chapter.isVolume && String(chapter.url).startsWith(String(chapter.title))) {
    debugLog(ctx, source, '⇒一级目录正文不解析');
    return chapter.tag === null || chapter.tag === undefined ? '' : String(chapter.tag);
  }
  const engine = makeEngine(ctx, source);
  const env = {
    cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger: ctx.logger, network: ctx.services.network,
  };
  const content = engine.callFunction('getContent', [
    ['chapter', wrapChapter(chapter, env)],
    ['book', wrapBook(book, env)],
    ['nextChapterUrl', nextChapterUrl],
  ]);
  if (isBlank(content)) throw new Error('JS源正文为空');
  logHtml(ctx, source, content, 40);
  return content;
}

/* ============================ JsSourceConfig.extract ============================ */

const REQUIRED_FUNCTIONS = ['search', 'getChapters', 'getContent'];
const STRIPPED_KEYS = ['mainJs', 'ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview'];

/**
 * 从 JS 源脚本里提取 config（兼容旧版 source）。
 * 需要 normalizeSource 才能补齐 BookSource 默认值 → 由调用方传入。
 * @param {string} text 脚本全文
 * @param {function} normalizeSourceFn book-source-model.normalizeSource
 * @returns {object} BookSource
 */
export function extractJsSource(text, normalizeSourceFn) {
  const scope = jsRuntime.createScope('legado-js-source-config');
  let configName = null;
  let configJson = null;
  try {
    jsRuntime.compile(String(text), 'legado-js-source-extract').runInContext(scope, { timeout: 60000 });
  } catch (e) {
    throw new Error(`JS源脚本执行失败: ${(e && e.message) || e}`);
  }
  // findConfig：优先 config；若 config 不完整而 source 存在则用 source
  const has = (n) => { try { return scope[n] !== undefined && scope[n] !== null; } catch (e) { return false; } };
  const complete = (v) => {
    const j = normalizeJsResult(v);
    if (!j) return false;
    try {
      const o = JSON.parse(j);
      return isBlank(o && o.bookSourceUrl) === false && !isBlank(o.bookSourceName);
    } catch (e) { return false; }
  };
  const hasConfig = has('config');
  const hasLegacy = has('source');
  if (hasConfig && (!hasLegacy || complete(scope.config))) { configName = 'config'; configJson = normalizeJsResult(scope.config); }
  else if (hasLegacy) { configName = 'source'; configJson = normalizeJsResult(scope.source); }
  else throw new Error('JS源缺少顶层 config 配置对象（兼容旧版 source）');

  if (!configJson) throw new Error(`${configName} 配置对象无法解析`);
  let obj;
  try { obj = JSON.parse(configJson); } catch (e) { throw new Error(`${configName} 配置对象不是合法对象`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${configName} 配置对象不是合法对象`);

  for (const k of STRIPPED_KEYS) delete obj[k];
  normalizeExploreUrl(obj);
  normalizeLoginUi(obj);

  const source = normalizeSourceFn(obj);
  if (isBlank(source.bookSourceUrl)) throw new Error(`JS源 ${configName}.bookSourceUrl 不能为空`);
  if (isBlank(source.bookSourceName)) throw new Error(`JS源 ${configName}.bookSourceName 不能为空`);
  for (const name of REQUIRED_FUNCTIONS) {
    if (!jsRuntime.hasFunction(scope, name)) throw new Error(`JS源缺少必备函数 ${name}`);
  }
  if (!isBlank(source.exploreUrl) && !jsRuntime.hasFunction(scope, 'explore')) {
    throw new Error('JS源声明了 exploreUrl,缺少配对的 explore 函数');
  }
  if (!isBlank(source.loginUi) && !jsRuntime.hasFunction(scope, 'login')) {
    throw new Error('JS源声明了 loginUi,缺少配对的 login 函数');
  }
  source.mainJs = String(text);
  return source;
}

function normalizeExploreUrl(obj) {
  const e = obj.exploreUrl;
  if (e === undefined || e === null) return;
  if (!Array.isArray(e)) return;
  if (e.length === 0) { delete obj.exploreUrl; return; }
  e.forEach((item, index) => {
    const title = item && typeof item === 'object' ? item.title : null;
    if (isBlank(title)) throw new Error(`exploreUrl 第 ${index + 1} 项缺少 title`);
  });
  obj.exploreUrl = JSON.stringify(e);
}

function normalizeLoginUi(obj) {
  const e = obj.loginUi;
  if (e === undefined || e === null) return;
  if (typeof e === 'string') {
    if (e.replace(/\s/g, '') === '[]') delete obj.loginUi;
    return;
  }
  if (!Array.isArray(e)) return;
  if (e.length === 0) { delete obj.loginUi; return; }
  e.forEach((item, index) => {
    const name = item && typeof item === 'object' ? item.name : null;
    if (isBlank(name)) throw new Error(`loginUi 第 ${index + 1} 项缺少 name`);
  });
  obj.loginUi = JSON.stringify(e);
}

/* ============================ JsSourceUpsert ============================ */

export const MAX_SOURCE_BYTES = 1024 * 1024;

/** validatePayload → null | 'EMPTY' | 'TOO_LARGE' */
export function validatePayload(text) {
  if (text === null || text === undefined || String(text).trim() === '') return 'EMPTY';
  const s = String(text);
  if (s.length > MAX_SOURCE_BYTES || Buffer.byteLength(s, 'utf8') > MAX_SOURCE_BYTES) return 'TOO_LARGE';
  return null;
}

const lastUpdateTimeRegex = /(["']?lastUpdateTime["']?\s*:\s*)(Date\.now\(\)|\d+)/;

/** stampLastUpdateTime */
export function stampLastUpdateTime(text, stamp) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  const m = lastUpdateTimeRegex.exec(s);
  if (!m) return null;
  return s.slice(0, m.index) + m[1] + String(stamp) + s.slice(m.index + m[0].length);
}

function normalizeManagedUpdateTime(script) {
  if (script === null || script === undefined) return script;
  const stamped = stampLastUpdateTime(script, 0);
  return stamped === null ? script : stamped;
}

/** BookSource.equal（字段级比较，忽略 lastUpdateTime/mainJs 里的托管时间戳） */
export function sourceEquals(a, b) {
  if (!a || !b) return false;
  const ka = { ...a, mainJs: normalizeManagedUpdateTime(a.mainJs), lastUpdateTime: 0 };
  const kb = { ...b, mainJs: normalizeManagedUpdateTime(b.mainJs), lastUpdateTime: 0 };
  return JSON.stringify(sortedClone(ka)) === JSON.stringify(sortedClone(kb));
}

function sortedClone(v) {
  if (Array.isArray(v)) return v.map(sortedClone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortedClone(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}

/** preserveUserState：保留用户态（启用/排序/权重/响应时间/分组） */
export function preserveUserState(source, old) {
  if (!old) return source;
  source.enabled = old.enabled;
  source.enabledExplore = old.enabledExplore;
  source.customOrder = old.customOrder;
  source.weight = old.weight;
  source.respondTime = old.respondTime;
  if (isBlank(source.bookSourceGroup)) source.bookSourceGroup = old.bookSourceGroup;
  return source;
}

/**
 * prepareForSave（JsSourceUpsert.prepareForSave）：返回 { source, changed }
 */
export function prepareForSave(source, old, stamp = Date.now()) {
  preserveUserState(source, old);
  const changed = !old || !sourceEquals(source, old);
  if (changed) {
    source.lastUpdateTime = stamp;
    const stamped = stampLastUpdateTime(source.mainJs, stamp);
    if (stamped !== null) source.mainJs = stamped;
  } else {
    source.lastUpdateTime = (old && old.lastUpdateTime) || 0;
    source.mainJs = old ? old.mainJs : source.mainJs;
  }
  return { source, changed };
}

/** JsSourceUpsert.hasTargetConflict */
export function hasTargetConflict(openedSource, targetSource, targetUrl) {
  return openedSource !== null && openedSource !== undefined
    && String(openedSource.bookSourceUrl || '') !== String(targetUrl || '')
    && targetSource !== null && targetSource !== undefined;
}

export { compileCached, scriptCache, isBlank, asString, asIntOrNull, BookType };
export default { JsSourceEngine, extractJsSource, search, explore, getBookInfo, getChapterList, getContent };
