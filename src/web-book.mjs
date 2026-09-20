// web-book.mjs —— WebBook 编排层，1:1 移植 legado 的:
//   model/webBook/WebBook.kt        — 搜索/详情/目录/正文主流程 + loginCheckJs 包装
//   model/webBook/BookList.kt       — 列表页解析（搜索/发现）
//   model/webBook/BookInfo.kt       — 详情页解析
//   model/webBook/BookChapterList.kt— 目录解析（多页）
//   model/webBook/BookContent.kt    — 正文解析（多页 + 副文 + 替换规则）
//   model/webBook/SearchModel.kt    — mergeItems（等值/标签/包含/其他 四桶排序）
//
// ⚠ 本模块内部全部是同步阻塞调用（sync-net 依赖 Atomics.wait 阻塞线程），
//   因此必须在 worker 线程中运行，禁止在主线程直接调用。
import {
  makeServices, createAnalyzeRule, createAnalyzeUrl, runRuleJs, globalCache, globalCookieStore,
} from './rule-engine.mjs';
import { formatIntro, formatKeepImg } from './html-format.mjs';
import { getAbsoluteURL, isTrue, splitNotBlank } from './net-utils.mjs';
import { unescapeHtml4 } from './js-runtime.mjs';
import { isStrResponse } from './packages-shim.mjs';
import { toStrResponse } from './java-bridge.mjs';
import { putVariableInto } from './wrap.mjs';
import { VerificationRequiredError } from './verification.mjs';

/* ============================ 常量 ============================ */

/** AppConfig 中的相关项（legado 对应 help/config/AppConfig.kt） */
export const AppConfig = {
  threadCount: Number(process.env.READER_THREAD_COUNT || 16),
  tocCountWords: true,
  adaptSpecialStyle: true,
  chineseConverterType: 0,
};

/** constant/AppPattern.kt */
export const AppPattern = {
  JS_PATTERN: /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/i,
  WebJS_PATTERN: /@webjs:([\w\W]{5,})/i,
  EXP_PATTERN: /\{\{([\w\W]*?)\}\}/,
  useHtmlRegex: /<usehtml>.*?<\/usehtml>/gis,
  imgRegex: /(.*)((?:data|https?):[\s\S]+)$/,
  wordCountRegex: /(?:^|字数[：:、]?|\s+)([0-9万千百\.]{1,6}字)/,
  nameRegex: /\s+作\s*者.*|\s+\S+\s*著/,
  authorRegex: /^\s*作\s*者[:：\s]+|\s+著/,
  domainRegex: /^https?:\/\/([^:\/]+)/i,
  bookFileRegex: /.*\.(txt|epub|umd|pdf|mobi|azw3|azw)/i,
  LFRegex: /\n/,
  rnRegex: /[\r\n]/g,
};

/** constant/BookType.kt */
export const BookType = {
  video: 4, text: 8, updateError: 16, audio: 32, image: 64,
  webFile: 128, local: 256, archive: 512, notShelf: 1024,
  allBookType: 236,
};

/** BookSource.getBookType() 的默认实现（BookSourceExtensions.kt） */
export function getBookType(source) {
  switch (source ? source.bookSourceType : 0) {
    case 3: return 136;  // text or webFile
    case 2: return 64;   // image
    case 1: return 32;   // audio
    case 4: return 4;    // video
    default: return 8;   // text
  }
}

/* ============================ 工具函数 ============================ */

/** BookHelp.formatBookName */
export function formatBookName(name) {
  if (name === null || name === undefined) return '';
  return String(name).replace(AppPattern.nameRegex, '').trim();
}

/** BookHelp.formatBookAuthor */
export function formatBookAuthor(author) {
  if (author === null || author === undefined) return '';
  return String(author).replace(AppPattern.authorRegex, '').trim();
}

/** StringUtils.isNumeric */
export function isNumeric(str) {
  return /^-?[0-9]+$/.test(String(str));
}

/** StringUtils.wordCountFormat(String?) */
export function wordCountFormat(wc) {
  if (wc === null || wc === undefined) return '';
  const s = String(wc);
  let out = '';
  if (isNumeric(s)) {
    const words = parseInt(s, 10);
    if (words > 0) {
      if (words > 10000) out = oneDecimal(words / 10000) + '万字';
      else out = words + '字';
    }
  } else {
    out = s;
  }
  return out;
}

function oneDecimal(n) {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** BookChapter.getDisplayTitle 的桌面简化版（无替换规则 / 无简繁转换） */
export function getDisplayTitle(chapter) {
  if (!chapter) return '';
  return String(chapter.title || '').replace(AppPattern.rnRegex, '');
}

function typeHas(book, t) { return ((book.type || 0) & t) !== 0; }
export function isAudio(b) { return typeHas(b, BookType.audio); }
export function isVideo(b) { return typeHas(b, BookType.video); }
export function isImage(b) { return typeHas(b, BookType.image); }
export function isWebFile(b) { return typeHas(b, BookType.webFile); }
export function isOnLineTxt(b) { return typeHas(b, BookType.text); }
export function removeAllBookType(b) { b.type = (b.type || 0) & ~BookType.allBookType; }
export function addBookType(b, ...ts) { for (const t of ts) b.type = (b.type || 0) | t; }

function parseVariable(v) {
  if (!v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}

/* ============================ RuleData ============================ */

/** model/analyzeRule/RuleData.kt —— 只存在于内存的规则数据容器 */
export class RuleData {
  constructor() { this.variableMap = {}; }
  putVariable(key, value) { putVariableInto(this.variableMap, key, value); return true; }
  putBigVariable(key, value) {
    if (value === null || value === undefined) delete this.variableMap[key];
    else this.variableMap[key] = String(value);
    return true;
  }
  getBigVariable() { return null; }
  getVariable(key) {
    if (key === undefined || key === null) {
      return Object.keys(this.variableMap).length === 0 ? null : JSON.stringify(this.variableMap);
    }
    const v = this.variableMap[key];
    return v === undefined || v === null ? null : String(v);
  }
  put(key, value) { return this.putVariable(key, value); }
  get(key) {
    const v = this.variableMap[key];
    return v === undefined || v === null ? '' : String(v);
  }
  get name() { return ''; }
}

/* ============================ 实体工厂 ============================ */

/**
 * BaseBook / RuleDataInterface 的变量方法（legado data/entities/BaseBook.kt）。
 * AnalyzeRule.put/get 会直接对裸实体调用 putVariable/getVariable，
 * 所以实体本身必须带这些方法，不能只依赖 wrapBook 包装。
 */
function attachBookVariableApi(entity) {
  if (!entity.variableMap) entity.variableMap = parseVariable(entity.variable);
  if (typeof entity.putVariable !== 'function') {
    entity.putVariable = function (key, value) {
      putVariableInto(this.variableMap, key, value);
      try { this.variable = JSON.stringify(this.variableMap); } catch (e) { /* ignore */ }
      return true;
    };
  }
  if (typeof entity.getVariable !== 'function') {
    entity.getVariable = function (key) {
      if (key === undefined || key === null) {
        return Object.keys(this.variableMap).length === 0 ? null : JSON.stringify(this.variableMap);
      }
      const v = this.variableMap[key];
      return v === undefined || v === null ? null : String(v);
    };
  }
  if (typeof entity.putBigVariable !== 'function') {
    entity.putBigVariable = function (key, value) {
      if (value === null || value === undefined) delete this.variableMap[key];
      else this.variableMap[key] = String(value);
      return true;
    };
  }
  if (typeof entity.getBigVariable !== 'function') entity.getBigVariable = () => null;
  return entity;
}
/** data/entities/Book.kt */
export function createBook(init = {}) {
  const b = {
    bookUrl: '', tocUrl: '', origin: 'loc_book', originName: '', name: '', author: '',
    kind: null, customTag: null, coverUrl: null, customCoverUrl: null, intro: null,
    customIntro: null, charset: null, type: BookType.text, group: 0,
    latestChapterTitle: null, latestChapterTime: 0, lastCheckTime: 0, lastCheckCount: 0,
    totalChapterNum: 0, durChapterTitle: null, durChapterIndex: 0, durVolumeIndex: 0,
    chapterInVolumeIndex: 0, durChapterPos: 0, durChapterTime: 0, wordCount: null,
    canUpdate: true, order: 0, originOrder: 0, variable: null, readConfig: null, syncTime: 0,
    infoHtml: null, tocHtml: null, downloadUrls: null,
    ...init,
  };
  attachBookVariableApi(b);
  return b;
}

/** data/entities/SearchBook.kt */
export function createSearchBook(init = {}) {
  const sb = {
    bookUrl: '', origin: '', originName: '', type: BookType.text, name: '', author: '',
    kind: null, coverUrl: null, intro: null, wordCount: null, latestChapterTitle: null,
    tocUrl: '', time: Date.now(), variable: null, originOrder: 0,
    chapterWordCountText: null, chapterWordCount: -1, respondTime: -1,
    infoHtml: null, tocHtml: null,
    ...init,
  };
  attachBookVariableApi(sb);
  // legado SearchBook.origins 是 lazy LinkedHashSet：首次访问时用当前 origin 初始化。
  // 这里必须同样惰性 —— 因为 origin 往往在构造之后才赋值（getSearchItem: sb.origin = source.bookSourceUrl），
  // 提前初始化会永远得到空集合，导致多源合并失效。
  let _origins = sb.origins instanceof Set ? new Set(sb.origins)
    : Array.isArray(sb.origins) ? new Set(sb.origins) : null;
  if (_origins && _origins.size === 0) _origins = null;
  Object.defineProperty(sb, 'origins', {
    enumerable: true,
    get() {
      if (!_origins) _origins = new Set(sb.origin ? [sb.origin] : []);
      return _origins;
    },
    set(v) {
      _origins = v instanceof Set ? v : Array.isArray(v) ? new Set(v) : null;
      if (_origins && _origins.size === 0) _origins = null;
    },
  });
  sb.addOrigin = function (o) { if (o) this.origins.add(o); };
  sb.toBook = function () {
    const bk = createBook({
      name: this.name, author: this.author, kind: this.kind, bookUrl: this.bookUrl,
      origin: this.origin, originName: this.originName, type: this.type,
      wordCount: this.wordCount, latestChapterTitle: this.latestChapterTitle,
      coverUrl: this.coverUrl, intro: this.intro, tocUrl: this.tocUrl,
      originOrder: this.originOrder, variable: this.variable,
    });
    bk.variableMap = { ...this.variableMap };
    bk.infoHtml = this.infoHtml;
    bk.tocHtml = this.tocHtml;
    return bk;
  };
  return sb;
}

/** data/entities/BookChapter.kt */
export function createChapter(init = {}) {
  const c = {
    url: '', title: '', isVolume: false, baseUrl: '', bookUrl: '', index: 0,
    isVip: false, isPay: false, resourceUrl: null, tag: null, wordCount: null,
    start: 0, end: 0, startFragmentId: null, endFragmentId: null,
    variable: null, imgUrl: null,
    ...init,
  };
  if (!c.variableMap) c.variableMap = parseVariable(c.variable);
  c.putVariable = function (key, value) {
    putVariableInto(this.variableMap, key, value);
    try { this.variable = JSON.stringify(this.variableMap); } catch (e) { /* ignore */ }
    return true;
  };
  c.putBigVariable = function (key, value) {
    if (value === null || value === undefined) delete this.variableMap[key];
    else this.variableMap[key] = String(value);
    return true;
  };
  c.getVariable = function (key) {
    if (key === undefined || key === null) return '';
    const v = this.variableMap[key];
    return v === undefined || v === null ? '' : String(v);
  };
  c.putLyric = function (v) { return this.putVariable('lyric', v); };
  c.putDanmaku = function (v) { return this.putVariable('danmaku', v); };
  c.getDisplayTitle = function () { return getDisplayTitle(this); };
  return c;
}

export function chapterEquals(a, b) { return !!a && !!b && a.url === b.url; }

/* ============================ InfoMap ============================ */

/** utils/InfoMap.kt —— 发现页筛选参数（持久化在 cache 中） */
export class InfoMap {
  constructor(sourceUrl, cache) {
    this.sourceUrl = sourceUrl;
    this.cache = cache || globalCache;
    this.map = {};
    const saved = this.cache.get(`infoMap_${sourceUrl}`);
    if (saved) {
      try {
        const o = JSON.parse(saved);
        if (o && typeof o === 'object') this.map = o;
      } catch (e) { /* ignore */ }
    }
  }
  key() { return `infoMap_${this.sourceUrl}`; }
  save(_time = 0, _need = true) { return this.saveNow(); }
  saveNow() {
    try { this.cache.put(this.key(), JSON.stringify(this.map)); } catch (e) { /* ignore */ }
  }
  get(k) { const v = this.map[k]; return v === undefined || v === null ? '' : String(v); }
  put(k, v) { this.map[k] = v === null || v === undefined ? null : String(v); return v; }
  remove(k) { delete this.map[k]; }
  putAll(other) { if (other) for (const k of Object.keys(other)) this.map[k] = other[k]; }
  containsKey(k) { return Object.prototype.hasOwnProperty.call(this.map, k); }
  containsValue(v) { return Object.values(this.map).includes(v); }
  get size() { return Object.keys(this.map).length; }
  entries() { return Object.entries(this.map); }
  keys() { return Object.keys(this.map); }
  values() { return Object.values(this.map); }
  isEmpty() { return this.size === 0; }
  clear() { this.map = {}; }
  toJSON() { return this.map; }
  toString() { return JSON.stringify(this.map); }
}

/* ============================ 日志/调试 ============================ */

function nowPrefix() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `[${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]`;
}

/**
 * model/Debug.kt 的桌面替身。
 * 每条日志形如 { sourceUrl, msg, state, time }
 * state: 10=列表页正文 20=详情页 30=目录页 40=正文页 1000=完成 -1=失败
 */
export class DebugCollector {
  constructor(sourceUrl) {
    this.sourceUrl = sourceUrl || '';
    this.logs = [];
    this.html = {};
    this.max = 4000;
  }
  log(msg, state = 1) {
    if (this.logs.length >= this.max) this.logs.shift();
    this.logs.push({ time: Date.now(), state, msg: String(msg === null || msg === undefined ? '' : msg) });
    return msg;
  }
  logHtml(msg, state) { this.html[state] = String(msg); return this.log(msg, state); }
  text() {
    return this.logs.map((l) => `${nowPrefix()} ${l.msg}`).join('\n');
  }
  toJSON() { return { sourceUrl: this.sourceUrl, logs: this.logs, html: Object.keys(this.html) }; }
}

/* ============================ 环境 ============================ */

/**
 * 构造一次抓取会话的上下文。
 * @param {object} opts { logger, cache, cookieStore, network, services, debug, verificationTimeout }
 */
export function makeContext(opts = {}) {
  const logger = opts.logger || null;
  const services = opts.services || makeServices(logger, {
    cookieStore: opts.cookieStore || globalCookieStore,
    cache: opts.cache || globalCache,
  });
  const ctx = {
    services,
    logger,
    debug: opts.debug || null,
    verificationTimeout: opts.verificationTimeout || undefined,
    cache: services.cache,
    cookieStore: services.cookieStore,
  };
  ctx._analyzeRuleCache = new WeakMap();
  ctx._analyzeUrlCache = new WeakMap();
  return ctx;
}

function dlog(ctx, sourceUrl, msg, state = 1, html = false) {
  if (!ctx || !ctx.debug) return;
  if (html) ctx.debug.logHtml(msg, state);
  else ctx.debug.log(msg, state);
  if (ctx.logger) ctx.logger(msg);
}

/** 会话级 AnalyzeRule 工厂：同一 (ruleData, source, chapter) 复用实例 */
function newAnalyzeRule(ctx, ruleData, source, chapter = null, isFromBookInfo = false) {
  const rule = createAnalyzeRule({
    ruleData: ruleData || null,
    source: source || null,
    chapter: chapter || null,
    isFromBookInfo,
    logger: ctx.logger,
    services: ctx.services,
    callbacks: {},
    // 会话级收集器：worker 每个任务开始前置空，脚本里的 java.showBrowser/startBrowser
    // 会把「要开的窗口」push 进来，任务结束后回给前端落地。
    browserActions: ctx.browserActions || null,
  });
  return rule;
}

/** 会话级 AnalyzeUrl 工厂 */
function newAnalyzeUrl(ctx, mUrl, opts = {}) {
  return createAnalyzeUrl(mUrl, {
    key: opts.key ?? null,
    page: opts.page ?? null,
    baseUrl: opts.baseUrl ?? '',
    source: opts.source || null,
    ruleData: opts.ruleData || null,
    chapter: opts.chapter || null,
    infoMap: opts.infoMap ?? null,
    hasLoginHeader: opts.hasLoginHeader !== false,
    readTimeout: opts.readTimeout ?? null,
    callTimeout: opts.callTimeout ?? null,
    logger: ctx.logger,
    services: ctx.services,
    browserActions: ctx.browserActions || null,
  });
}

/* ============================ loginCheckJs 包装 ============================ */

/**
 * WebBook.kt 的公共模式：
 *   runCatching { getStrResponseAwait() }.getOrElse { t ->
 *       if (!checkJs.isNullOrBlank()) { err = getErrStrResponse(t); evalJS(checkJs, err) ... }
 *       else throw t }
 *   checkRedirect(bookSource, res)
 */
function fetchWithLoginCheck(ctx, analyzeUrl, source, opts = {}) {
  const checkJs = source ? source.loginCheckJs : null;
  let res;
  try {
    let r = opts.skipRateLimit || opts.isTest
      ? analyzeUrl.getStrResponse({ skipRateLimit: !!opts.skipRateLimit, isTest: !!opts.isTest })
      : analyzeUrl.getStrResponse();
    if (checkJs && String(checkJs).trim()) {
      // legado 给 loginCheckJs 的 result 是 StrResponse，可同时用 result.body()
      // 和 result.body。桌面请求层的原始返回是普通对象，必须先过同一层垫片，
      // 否则起点限免等源会直接报「result.body is not a function」。
      const replaced = analyzeUrl.evalJS(checkJs, toStrResponse(r));
      if (isStrResponse(replaced)) r = strResponseToPlain(replaced);
    }
    res = r;
  } catch (throwable) {
    if (checkJs && String(checkJs).trim()) {
      const errResponse = analyzeUrl.getErrStrResponseObj(throwable);
      let handled = null;
      try {
        const replaced = analyzeUrl.evalJS(checkJs, errResponse);
        if (isStrResponse(replaced)) handled = strResponseToPlain(replaced);
      } catch (e2) { handled = null; }
      if (handled && handled.code !== 500) res = handled;
      else throw throwable;
    } else {
      throw throwable;
    }
  }
  checkRedirect(ctx, source, res);
  return res;
}

/** StrResponse → 普通对象（保留 code/message/headers） */
function strResponseToPlain(sr) {
  return {
    url: String(sr.url),
    body: String(sr.body),
    code: Number(sr.code) || 200,
    message: String(sr.message || ''),
    headers: sr.headers,
    callTime: Number(sr.callTime) || 0,
    raw: { priorResponse: { isRedirect: false, url: String(sr.url), code: Number(sr.code) || 200 } },
  };
}

/** WebBook.checkRedirect */
function checkRedirect(ctx, source, res) {
  const prior = res && res.raw && res.raw.priorResponse;
  if (prior && prior.isRedirect) {
    dlog(ctx, source ? source.bookSourceUrl : '', `≡检测到重定向(${prior.code})`);
    dlog(ctx, source ? source.bookSourceUrl : '', '┌重定向后地址');
    dlog(ctx, source ? source.bookSourceUrl : '', `└${res.url}`);
  }
}

/* ============================ BookInfo.kt ============================ */

/**
 * 详情页解析（BookInfo.analyzeBookInfo 重载二：外部已建好 analyzeRule）
 * @param {object} book
 * @param {string} body
 * @param {object} analyzeRule 已 setContent/setBaseUrl/setRedirectUrl 的 AnalyzeRule
 * @param {object} source
 * @param {string} baseUrl
 * @param {string} redirectUrl
 * @param {boolean} canReName
 */
export function analyzeBookInfoInner(ctx, book, body, analyzeRule, source, baseUrl, redirectUrl, canReName) {
  const su = source.bookSourceUrl || '';
  const infoRule = source.getBookInfoRule();

  if (infoRule.init && String(infoRule.init).trim()) {
    dlog(ctx, su, '≡执行详情页初始化规则');
    const el = analyzeRule.getElement(infoRule.init);
    if (el !== null && el !== undefined) analyzeRule.setContent(el);
  }

  const mCanReName = canReName && !!(infoRule.canReName && String(infoRule.canReName).trim());

  dlog(ctx, su, '┌获取书名');
  {
    const v = formatBookName(analyzeRule.getString(infoRule.name));
    if (v && (mCanReName || !book.name)) book.name = v;
    dlog(ctx, su, `└${v}`);
  }

  dlog(ctx, su, '┌获取作者');
  {
    const v = formatBookAuthor(analyzeRule.getString(infoRule.author));
    if (v && (mCanReName || !book.author)) book.author = v;
    dlog(ctx, su, `└${v}`);
  }

  dlog(ctx, su, '┌获取分类');
  try {
    const list = analyzeRule.getStringList(infoRule.kind);
    const joined = list ? list.join(',') : '';
    if (joined) book.kind = joined;
    dlog(ctx, su, `└${joined}`);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`); }

  dlog(ctx, su, '┌获取字数');
  try {
    const v = wordCountFormat(analyzeRule.getString(infoRule.wordCount));
    if (v) book.wordCount = v;
    dlog(ctx, su, `└${v}`);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`); }

  dlog(ctx, su, '┌获取最新章节');
  try {
    const v = analyzeRule.getString(infoRule.lastChapter);
    if (v) book.latestChapterTitle = v;
    dlog(ctx, su, `└${v}`);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`); }

  dlog(ctx, su, '┌获取简介');
  try {
    const intro = analyzeRule.getString(infoRule.intro);
    const introTrimS = String(intro).replace(/^\s+/, '');
    if (introTrimS.startsWith('<usehtml>') || introTrimS.startsWith('<md>') || introTrimS.startsWith('<useweb>')) {
      book.intro = introTrimS;
      dlog(ctx, su, `└${introTrimS}`);
    } else {
      const v = formatIntro(intro);
      if (v) book.intro = v;
      dlog(ctx, su, `└${v}`);
    }
  } catch (e) { dlog(ctx, su, `└${e && e.message}`); }

  dlog(ctx, su, '┌获取封面链接');
  try {
    const v = analyzeRule.getString(infoRule.coverUrl);
    if (v) book.coverUrl = getAbsoluteURL(redirectUrl, v);
    dlog(ctx, su, `└${v}`);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`); }

  if (!isWebFile(book)) {
    dlog(ctx, su, '┌获取目录链接');
    book.tocUrl = analyzeRule.getString(infoRule.tocUrl, undefined, true);
    if (!book.tocUrl) book.tocUrl = baseUrl;
    if (book.tocUrl === baseUrl) book.tocHtml = body;
    dlog(ctx, su, `└${book.tocUrl}`);
  } else {
    dlog(ctx, su, '┌获取文件下载链接');
    book.downloadUrls = analyzeRule.getStringList(infoRule.downloadUrls, undefined, true);
    if (!book.downloadUrls || book.downloadUrls.length === 0) {
      dlog(ctx, su, '└');
      throw new Error('下载链接为空');
    }
    dlog(ctx, su, `└${book.downloadUrls.join('，\n')}`);
  }
  return book;
}

/** BookInfo.analyzeBookInfo 重载一：自建 AnalyzeRule */
export function analyzeBookInfo(ctx, source, book, baseUrl, redirectUrl, body, canReName) {
  if (body === null || body === undefined) {
    throw new Error(`获取网页内容失败(${baseUrl})`);
  }
  const su = source.bookSourceUrl || '';
  dlog(ctx, su, `≡获取成功:${baseUrl}`);
  dlog(ctx, su, body, 20, true);
  const ar = newAnalyzeRule(ctx, book, source);
  ar.setContent(body).setBaseUrl(baseUrl);
  ar.setRedirectUrl(redirectUrl);
  return analyzeBookInfoInner(ctx, book, body, ar, source, baseUrl, redirectUrl, canReName);
}

/* ============================ BookList.kt ============================ */

function getInfoItem(ctx, source, analyzeRule, analyzeUrl, body, baseUrl, variable, isRedirect, filter) {
  const book = createBook({ variable });
  book.variableMap = parseVariable(variable);
  book.bookUrl = isRedirect ? baseUrl : getAbsoluteURL(analyzeUrl.url, analyzeUrl.ruleUrl);
  book.origin = source.bookSourceUrl;
  book.originName = source.bookSourceName;
  book.originOrder = source.customOrder;
  book.type = getBookType(source);
  analyzeRule.setRuleData(book);
  analyzeBookInfoInner(ctx, book, body, analyzeRule, source, baseUrl, baseUrl, false);
  if (filter && filter(book.name, book.author, book.kind) === false) return null;
  if (book.name && String(book.name).trim()) {
    const sb = createSearchBook({
      name: book.name, author: book.author, kind: book.kind, bookUrl: book.bookUrl,
      origin: book.origin, originName: book.originName, originOrder: book.originOrder,
      type: book.type, wordCount: book.wordCount, latestChapterTitle: book.latestChapterTitle,
      coverUrl: book.coverUrl, intro: book.intro, tocUrl: book.tocUrl, variable: book.variable,
    });
    sb.variableMap = book.variableMap;
    return sb;
  }
  return null;
}

function getSearchItem(ctx, source, analyzeRule, item, baseUrl, variable, log, filter, rules) {
  const sb = createSearchBook({ variable });
  sb.variableMap = parseVariable(variable);
  sb.type = getBookType(source);
  sb.origin = source.bookSourceUrl;
  sb.originName = source.bookSourceName;
  sb.originOrder = source.customOrder;
  analyzeRule.setRuleData(sb);
  analyzeRule.setContent(item);
  const su = source.bookSourceUrl || '';

  dlog(ctx, su, '┌获取书名', 1, false);
  sb.name = formatBookName(analyzeRule.getString(rules.name));
  dlog(ctx, su, `└${sb.name}`, 1, false);
  if (!sb.name.length) return null;

  dlog(ctx, su, '┌获取作者', 1, false);
  sb.author = formatBookAuthor(analyzeRule.getString(rules.author));
  dlog(ctx, su, `└${sb.author}`, 1, false);

  dlog(ctx, su, '┌获取分类', 1, false);
  try {
    const l = analyzeRule.getStringList(rules.kind);
    sb.kind = l ? l.join(',') : null;
    dlog(ctx, su, `└${sb.kind || ''}`, 1, false);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`, 1, false); }

  if (filter && filter(sb.name, sb.author, sb.kind) === false) return null;

  dlog(ctx, su, '┌获取字数', 1, false);
  try {
    sb.wordCount = wordCountFormat(analyzeRule.getString(rules.wordCount));
    dlog(ctx, su, `└${sb.wordCount}`, 1, false);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`, 1, false); }

  dlog(ctx, su, '┌获取最新章节', 1, false);
  try {
    sb.latestChapterTitle = analyzeRule.getString(rules.lastChapter);
    dlog(ctx, su, `└${sb.latestChapterTitle}`, 1, false);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`, 1, false); }

  dlog(ctx, su, '┌获取简介', 1, false);
  try {
    sb.intro = formatIntro(analyzeRule.getString(rules.intro));
    dlog(ctx, su, `└${sb.intro}`, 1, false);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`, 1, false); }

  dlog(ctx, su, '┌获取封面链接', 1, false);
  try {
    const v = analyzeRule.getString(rules.coverUrl);
    if (v) sb.coverUrl = getAbsoluteURL(baseUrl, v);
    dlog(ctx, su, `└${sb.coverUrl || ''}`, 1, false);
  } catch (e) { dlog(ctx, su, `└${e && e.message}`, 1, false); }

  dlog(ctx, su, '┌获取详情页链接', 1, false);
  sb.bookUrl = analyzeRule.getString(rules.bookUrl, undefined, true);
  if (!sb.bookUrl) sb.bookUrl = baseUrl;
  dlog(ctx, su, `└${sb.bookUrl}`, 1, false);
  return sb;
}

/**
 * BookList.analyzeBookList
 * @param {object} ctx
 * @param {object} source
 * @param {object} ruleData
 * @param {object} analyzeUrl
 * @param {string} baseUrl
 * @param {string} body
 * @param {boolean} isSearch
 * @param {boolean} isRedirect
 * @param {Function} filter (name, author, kind) => boolean
 * @param {Function} shouldBreak (size) => boolean
 */
export function analyzeBookList(ctx, source, ruleData, analyzeUrl, baseUrl, body, isSearch = true, isRedirect = false, filter = null, shouldBreak = null) {
  if (body === null || body === undefined) {
    throw new Error(`获取网页内容失败(${analyzeUrl.ruleUrl})`);
  }
  const su = source.bookSourceUrl || '';
  const bookList = [];
  dlog(ctx, su, `≡获取成功:${analyzeUrl.ruleUrl}`);
  dlog(ctx, su, body, 10, true);

  const analyzeRule = newAnalyzeRule(ctx, ruleData, source);
  analyzeRule.setContent(body).setBaseUrl(baseUrl);
  analyzeRule.setRedirectUrl(baseUrl);

  if (isSearch && source.bookUrlPattern) {
    let matched = false;
    try { matched = new RegExp(source.bookUrlPattern).test(baseUrl); } catch (e) { matched = false; }
    if (matched) {
      dlog(ctx, su, '≡链接为详情页');
      const it = getInfoItem(ctx, source, analyzeRule, analyzeUrl, body, baseUrl, ruleData.getVariable(), isRedirect, filter);
      if (it) { it.infoHtml = body; bookList.push(it); }
      return bookList;
    }
  }

  let reverse = false;
  const bookListRule = (isSearch || !(source.getExploreRule().bookList && String(source.getExploreRule().bookList).trim()))
    ? source.getSearchRule()
    : source.getExploreRule();
  let ruleList = bookListRule.bookList || '';
  if (ruleList.startsWith('-')) { reverse = true; ruleList = ruleList.substring(1); }
  if (ruleList.startsWith('+')) { ruleList = ruleList.substring(1); }

  dlog(ctx, su, '┌获取书籍列表');
  const collections = analyzeRule.getElements(ruleList);

  if (collections.length === 0 && !source.bookUrlPattern) {
    dlog(ctx, su, '└列表为空,按详情页解析');
    const it = getInfoItem(ctx, source, analyzeRule, analyzeUrl, body, baseUrl, ruleData.getVariable(), isRedirect, filter);
    if (it) { it.infoHtml = body; bookList.push(it); }
  } else {
    const rules = {
      name: analyzeRule.splitSourceRule(bookListRule.name),
      bookUrl: analyzeRule.splitSourceRule(bookListRule.bookUrl),
      author: analyzeRule.splitSourceRule(bookListRule.author),
      coverUrl: analyzeRule.splitSourceRule(bookListRule.coverUrl),
      intro: analyzeRule.splitSourceRule(bookListRule.intro),
      kind: analyzeRule.splitSourceRule(bookListRule.kind),
      lastChapter: analyzeRule.splitSourceRule(bookListRule.lastChapter),
      wordCount: analyzeRule.splitSourceRule(bookListRule.wordCount),
    };
    const variable = ruleData.getVariable();
    for (let index = 0; index < collections.length; index++) {
      const item = collections[index];
      const sb = getSearchItem(ctx, source, analyzeRule, item, baseUrl, variable, true, filter, rules);
      if (sb) {
        if (baseUrl === sb.bookUrl) sb.infoHtml = body;
        bookList.push(sb);
      }
      if (shouldBreak && shouldBreak(bookList.length) === true) break;
    }
    // LinkedHashSet 去重（按 bookUrl）
    const seen = new Set();
    const dedup = [];
    for (const b of bookList) {
      if (seen.has(b.bookUrl)) continue;
      seen.add(b.bookUrl);
      dedup.push(b);
    }
    bookList.length = 0;
    bookList.push(...dedup);
    if (reverse) bookList.reverse();
  }
  return bookList;
}

/* ============================ BookChapterList.kt ============================ */

function analyzeChapterListInner(ctx, book, baseUrl, redirectUrl, body, tocRule, listRule, source, getNextUrl = true, log = false, isFromBookInfo = false) {
  const su = source.bookSourceUrl || '';
  const analyzeRule = newAnalyzeRule(ctx, book, source, null, isFromBookInfo);
  analyzeRule.setContent(body).setBaseUrl(baseUrl);
  analyzeRule.setRedirectUrl(redirectUrl);
  const elements = analyzeRule.getElements(listRule);
  const nextUrlList = [];
  const nextTocRule = tocRule.nextTocUrl;
  if (getNextUrl && nextTocRule && String(nextTocRule).length) {
    const list = analyzeRule.getStringList(nextTocRule, undefined, true);
    if (list) for (const item of list) if (item && item !== redirectUrl) nextUrlList.push(item);
  }
  const chapterList = [];
  if (elements.length) {
    const nameRule = analyzeRule.splitSourceRule(tocRule.chapterName);
    const urlRule = analyzeRule.splitSourceRule(tocRule.chapterUrl);
    const vipRule = analyzeRule.splitSourceRule(tocRule.isVip);
    const payRule = analyzeRule.splitSourceRule(tocRule.isPay);
    const upTimeRule = analyzeRule.splitSourceRule(tocRule.updateTime);
    const isVolumeRule = analyzeRule.splitSourceRule(tocRule.isVolume);
    const tocCountWords = AppConfig.tocCountWords;

    for (let index = 0; index < elements.length; index++) {
      const item = elements[index];
      analyzeRule.setContent(item);
      const chapter = createChapter({ bookUrl: book.bookUrl, baseUrl: redirectUrl });
      analyzeRule.setChapter(chapter);
      chapter.title = analyzeRule.getString(nameRule);
      chapter.url = analyzeRule.getString(urlRule);
      const info = analyzeRule.getString(upTimeRule);
      const isVolume = analyzeRule.getString(isVolumeRule);
      chapter.isVolume = false;
      if (isTrue(isVolume)) {
        chapter.isVolume = true;
        chapter.tag = info;
      } else if (tocCountWords) {
        const m = AppPattern.wordCountRegex.exec(info);
        if (m) {
          chapter.wordCount = String(m[1]).trim();
          chapter.tag = info.replace(m[0], '');
        } else {
          chapter.tag = info;
        }
      } else {
        chapter.tag = info;
      }
      if (!chapter.url) {
        if (chapter.isVolume) {
          chapter.url = chapter.title + index;
          dlog(ctx, su, `⇒一级目录${index}未获取到url,使用标题替代`);
        } else {
          chapter.url = baseUrl;
          dlog(ctx, su, `⇒目录${index}未获取到url,使用baseUrl替代`);
        }
      }
      if (chapter.title && String(chapter.title).length) {
        if (isTrue(analyzeRule.getString(vipRule))) chapter.isVip = true;
        if (isTrue(analyzeRule.getString(payRule))) chapter.isPay = true;
        chapterList.push(chapter);
      }
    }
    dlog(ctx, su, '└目录列表解析完成', 1, false);
    if (!chapterList.length) {
      dlog(ctx, su, '◇章节列表为空');
    } else {
      dlog(ctx, su, '≡首章信息');
      dlog(ctx, su, `◇章节名称:${chapterList[0].title}`);
      dlog(ctx, su, `◇章节链接:${chapterList[0].url}`);
      if (chapterList[0].wordCount) {
        dlog(ctx, su, `◇章节信息:${chapterList[0].tag} ${chapterList[0].wordCount}`);
        dlog(ctx, su, '⇒已识别到章节信息中的字数');
      } else {
        dlog(ctx, su, `◇章节信息:${chapterList[0].tag}`);
      }
      dlog(ctx, su, `◇是否VIP:${chapterList[0].isVip}`);
      dlog(ctx, su, `◇是否购买:${chapterList[0].isPay}`);
    }
  }
  return { list: chapterList, nextUrlList };
}

/** BookChapterList.updateBookTocInfo */
export function updateBookTocInfo(book, list) {
  const now = Date.now();
  const last = list.length ? list[list.length - 1] : null;
  const dur = list[book.durChapterIndex] || last;
  book.durChapterTitle = getDisplayTitle(dur);
  if ((book.totalChapterNum || 0) < list.length) {
    book.lastCheckCount = list.length - (book.totalChapterNum || 0);
    book.latestChapterTime = now;
  }
  book.lastCheckTime = now;
  book.totalChapterNum = list.length;
  const latest = list[(book.totalChapterNum || 1) - 1] || last;
  book.latestChapterTitle = getDisplayTitle(latest);
  return book;
}

/**
 * BookChapterList.analyzeChapterList
 * @returns {Array} BookChapter 列表（已排序 / 编号 / formatJs 处理）
 */
export function analyzeChapterList(ctx, source, book, baseUrl, redirectUrl, body, isFromBookInfo = false) {
  if (body === null || body === undefined) {
    throw new Error(`获取网页内容失败(${baseUrl})`);
  }
  const su = source.bookSourceUrl || '';
  const chapterList = [];
  dlog(ctx, su, `≡获取成功:${baseUrl}`);
  dlog(ctx, su, body, 30, true);
  const tocRule = source.getTocRule();
  const nextUrlList = [redirectUrl];
  let reverse = false;
  let listRule = tocRule.chapterList || '';
  if (listRule.startsWith('-')) { reverse = true; listRule = listRule.substring(1); }
  if (listRule.startsWith('+')) { listRule = listRule.substring(1); }

  let data = analyzeChapterListInner(ctx, book, baseUrl, redirectUrl, body, tocRule, listRule, source, true, true, isFromBookInfo);
  chapterList.push(...data.list);

  if (data.nextUrlList.length === 0) {
    // 单页目录
  } else if (data.nextUrlList.length === 1) {
    let nextUrl = data.nextUrlList[0];
    while (nextUrl && nextUrl.length && !nextUrlList.includes(nextUrl)) {
      nextUrlList.push(nextUrl);
      const au = newAnalyzeUrl(ctx, nextUrl, { source, ruleData: book });
      const res = au.getStrResponse();
      if (res.body !== null && res.body !== undefined) {
        data = analyzeChapterListInner(ctx, book, nextUrl, nextUrl, res.body, tocRule, listRule, source, true, false, isFromBookInfo);
        nextUrl = data.nextUrlList.length ? data.nextUrlList[0] : '';
        chapterList.push(...data.list);
      } else {
        break;
      }
    }
    dlog(ctx, su, `◇目录总页数:${nextUrlList.length}`);
  } else {
    dlog(ctx, su, `◇并发解析目录,总页数:${data.nextUrlList.length}`);
    for (const urlStr of data.nextUrlList) {
      const au = newAnalyzeUrl(ctx, urlStr, { source, ruleData: book });
      const res = au.getStrResponse();
      const sub = analyzeChapterListInner(ctx, book, urlStr, res.url, res.body == null ? '' : res.body, tocRule, listRule, source, false, false, isFromBookInfo);
      chapterList.push(...sub.list);
    }
  }

  if (chapterList.length === 0) throw new Error('目录为空');

  if (!reverse) chapterList.reverse();

  // 去重（LinkedHashSet 语义：按 url 保序）
  const seen = new Set();
  const list = [];
  for (const c of chapterList) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    list.push(c);
  }
  if (!getReverseToc(book)) list.reverse();
  dlog(ctx, book.origin, `◇目录总数:${list.length}`);

  for (let i = 0; i < list.length; i++) list[i].index = i;

  const formatJs = tocRule.formatJs;
  if (formatJs && String(formatJs).trim()) {
    for (let index = 0; index < list.length; index++) {
      const chapter = list[index];
      try {
        const out = runRuleJs(
          newAnalyzeRule(ctx, book, source),
          String(formatJs),
          undefined,
          { gInt: 0, index: index + 1, chapter, title: chapter.title },
        );
        if (out !== null && out !== undefined && out !== '') chapter.title = String(out);
      } catch (e) {
        dlog(ctx, book.origin, `格式化标题出错, ${e && e.message}`);
      }
    }
  }

  updateBookTocInfo(book, list);
  return list;
}

/** BaseBook.getReverseToc() */
export function getReverseToc(book) {
  return !!(book && book.readConfig && book.readConfig.reverseToc === true);
}

/* ============================ BookContent.kt ============================ */

function analyzeContentInner(ctx, book, baseUrl, redirectUrl, body, contentRule, chapter, source, nextChapterUrl, getNextPageUrl = true, printLog = true) {
  const analyzeRule = newAnalyzeRule(ctx, book, source, chapter);
  analyzeRule.setContent(body, baseUrl);
  analyzeRule.setRedirectUrl(redirectUrl);
  analyzeRule.setNextChapterUrl(nextChapterUrl);
  analyzeRule.setChapter(chapter);

  let content = analyzeRule.getString(contentRule.content, false);
  if (!isAudio(book) && !isVideo(book)) {
    const useHtmlMap = new Map();
    if (AppConfig.adaptSpecialStyle) {
      content = String(content).replace(AppPattern.useHtmlRegex, (m) => {
        const ph = `{usehtml_${useHtmlMap.size}}`;
        useHtmlMap.set(ph, m);
        return ph;
      });
    }
    content = formatKeepImg(content, analyzeRule.redirectUrl);
    if (String(content).indexOf('&') > -1) content = unescapeHtml4(content);
    for (const [ph, orig] of useHtmlMap) content = String(content).split(ph).join(orig);
  }
  const nextUrlList = [];
  if (getNextPageUrl) {
    const nextUrlRule = contentRule.nextContentUrl;
    if (nextUrlRule && String(nextUrlRule).length) {
      const l = analyzeRule.getStringList(nextUrlRule, undefined, true);
      if (l) for (const u of l) if (u) nextUrlList.push(u);
    }
  }
  return { content, nextUrlList };
}

/**
 * BookContent.analyzeContent
 * @returns {string} 正文
 */
export function analyzeContent(ctx, source, book, chapter, baseUrl, redirectUrl, body, nextChapterUrl = null, needSave = true) {
  if (body === null || body === undefined) {
    throw new Error(`获取网页内容失败(${baseUrl})`);
  }
  const su = source.bookSourceUrl || '';
  dlog(ctx, su, `≡获取成功:${baseUrl}`);
  dlog(ctx, su, body, 40, true);

  let mNextChapterUrl = nextChapterUrl || chapter.nextChapterUrl || null;
  const contentList = [];
  const nextUrlList = [redirectUrl];
  const contentRule = source.getContentRule();

  const analyzeRule = newAnalyzeRule(ctx, book, source, chapter);
  analyzeRule.setContent(body, baseUrl);
  analyzeRule.setRedirectUrl(redirectUrl);
  analyzeRule.setChapter(chapter);
  analyzeRule.setNextChapterUrl(mNextChapterUrl);

  let data = analyzeContentInner(ctx, book, baseUrl, redirectUrl, body, contentRule, chapter, source, mNextChapterUrl, true, true);
  contentList.push(data.content);

  if (data.nextUrlList.length === 1) {
    const webJs = contentRule.webJs;
    let nextUrl = data.nextUrlList[0];
    while (nextUrl && nextUrl.length && !nextUrlList.includes(nextUrl)) {
      if (mNextChapterUrl && getAbsoluteURL(redirectUrl, nextUrl) === getAbsoluteURL(redirectUrl, mNextChapterUrl)) break;
      nextUrlList.push(nextUrl);
      const au = newAnalyzeUrl(ctx, nextUrl, { source, ruleData: book });
      const res = au.getStrResponse();
      if (res.body !== null && res.body !== undefined) {
        data = analyzeContentInner(ctx, book, nextUrl, res.url, res.body, contentRule, chapter, source, mNextChapterUrl, true, false);
        nextUrl = data.nextUrlList.length ? data.nextUrlList[0] : '';
        contentList.push(data.content);
        dlog(ctx, su, `第${contentList.length}页完成`);
      } else break;
    }
    dlog(ctx, su, `◇本章总页数:${nextUrlList.length}`);
  } else if (data.nextUrlList.length > 1) {
    dlog(ctx, su, `◇并发解析正文,总页数:${data.nextUrlList.length}`);
    for (const urlStr of data.nextUrlList) {
      const au = newAnalyzeUrl(ctx, urlStr, { source, ruleData: book });
      const res = au.getStrResponse();
      const sub = analyzeContentInner(ctx, book, urlStr, res.url, res.body == null ? '' : res.body, contentRule, chapter, source, mNextChapterUrl, false, false);
      contentList.push(sub.content);
    }
  }

  // 副文
  const subContentRule = contentRule.subContent;
  if (subContentRule && String(subContentRule).trim()) {
    try {
      const rawContent = analyzeRule.getString(subContentRule);
      if (isOnLineTxt(book)) {
        contentList.push(rawContent);
      } else {
        let subContent = String(rawContent).trim();
        if (/^http/i.test(subContent)) {
          const au = newAnalyzeUrl(ctx, subContent, { source, ruleData: book });
          subContent = au.getStrResponse().body || '';
        }
        if (isAudio(book)) chapter.putLyric(subContent);
        else if (isVideo(book)) chapter.putDanmaku(subContent);
      }
    } catch (e) {
      dlog(ctx, su, `获取副文出错, ${e && e.message}`);
    }
  }

  let contentStr = contentList.join('\n');

  const replaceRegex = contentRule.replaceRegex;
  if (replaceRegex && String(replaceRegex).length) {
    contentStr = contentStr.split(AppPattern.LFRegex).map((s) => s.trim()).join('\n');
    contentStr = analyzeRule.getString(replaceRegex, contentStr);
    if (isOnLineTxt(book)) {
      contentStr = contentStr.split(AppPattern.LFRegex).map((s) => `　　${s}`).join('\n');
    }
  }

  const titleRule = contentRule.title;
  if (titleRule && String(titleRule).trim()) {
    try {
      let title = analyzeRule.getString(titleRule);
      if (title && String(title).trim()) {
        const m = AppPattern.imgRegex.exec(title);
        if (m) {
          const g1 = m[1] || '';
          const g2 = m[2] || '';
          title = g1 !== '' ? g1 : chapter.title;
          chapter.imgUrl = g2;
        }
        chapter.title = title;
        if ('titleMD5' in chapter) chapter.titleMD5 = null;
      }
    } catch (e) { /* ignore */ }
  }

  if (!chapter.isVolume && String(contentStr).trim() === '') {
    throw new Error('内容为空');
  }
  return contentStr;
}

/* ============================ WebBook.kt ============================ */

/** WebBook.getBookInfoAwait（无 loginCheckJs 的 infoHtml 短路） */
export function getBookInfo(ctx, source, book, canReName = true) {
  removeAllBookType(book);
  addBookType(book, getBookType(source));
  if (book.infoHtml !== null && book.infoHtml !== undefined && String(book.infoHtml).length) {
    return analyzeBookInfo(ctx, source, book, book.bookUrl, book.bookUrl, book.infoHtml, canReName);
  }
  const au = newAnalyzeUrl(ctx, book.bookUrl, { source, ruleData: book, baseUrl: source.bookSourceUrl });
  const res = fetchWithLoginCheck(ctx, au, source);
  return analyzeBookInfo(ctx, source, book, book.bookUrl, res.url, res.body, canReName);
}

/** WebBook.runPreUpdateJs */
export function runPreUpdateJs(ctx, source, book, isFromBookInfo = false) {
  const preUpdateJs = source.getTocRule().preUpdateJs;
  if (!preUpdateJs || !String(preUpdateJs).trim()) return;
  try {
    const ar = newAnalyzeRule(ctx, book, source, null, isFromBookInfo);
    ar._preUpdateJs = true;
    runRuleJs(ar, String(preUpdateJs));
  } catch (e) {
    dlog(ctx, source.bookSourceUrl, `执行preUpdateJs规则失败 书源:${source.bookSourceName}`);
  }
}

/** WebBook.getChapterListAwait */
export function getChapterList(ctx, source, book, runPerJs = false, isFromBookInfo = false) {
  removeAllBookType(book);
  addBookType(book, getBookType(source));
  if (runPerJs) runPreUpdateJs(ctx, source, book, isFromBookInfo);
  if (book.bookUrl === book.tocUrl && book.tocHtml !== null && book.tocHtml !== undefined && String(book.tocHtml).length) {
    return analyzeChapterList(ctx, source, book, book.tocUrl, book.tocUrl, book.tocHtml, isFromBookInfo);
  }
  const au = newAnalyzeUrl(ctx, book.tocUrl, { source, ruleData: book, baseUrl: book.bookUrl });
  const res = fetchWithLoginCheck(ctx, au, source);
  return analyzeChapterList(ctx, source, book, book.tocUrl, res.url, res.body, isFromBookInfo);
}

/** WebBook.getContentAwait */
export function getContent(ctx, source, book, chapter, nextChapterUrl = null, needSave = true) {
  const contentRule = source.getContentRule();
  if (!contentRule.content || !String(contentRule.content).length) {
    dlog(ctx, source.bookSourceUrl, `⇒正文规则为空,使用章节链接:${chapter.url}`);
    return chapter.url;
  }
  if (chapter.isVolume && String(chapter.url).startsWith(String(chapter.title))) {
    return chapter.tag === null || chapter.tag === undefined ? '' : String(chapter.tag);
  }
  if (chapter.url === book.bookUrl && book.tocHtml !== null && book.tocHtml !== undefined && String(book.tocHtml).length) {
    const u = chapterAbsoluteURL(chapter);
    return analyzeContent(ctx, source, book, chapter, u, u, book.tocHtml, nextChapterUrl, needSave);
  }
  const chapterUrl = chapterAbsoluteURL(chapter);
  const au = newAnalyzeUrl(ctx, chapterUrl, { source, ruleData: book, chapter, baseUrl: book.tocUrl });
  const res = fetchWithLoginCheck(ctx, au, source);
  return analyzeContent(ctx, source, book, chapter, chapterUrl, res.url, res.body, nextChapterUrl, needSave);
}

/** BookChapter.getAbsoluteURL() */
export function chapterAbsoluteURL(chapter) {
  const url = String(chapter.url == null ? '' : chapter.url);
  const title = String(chapter.title == null ? '' : chapter.title);
  if (chapter.isVolume && title && url.startsWith(title)) return chapter.baseUrl || '';
  const m = /\s*,\s*(?=\s*\{)/.exec(url);
  const urlBefore = m ? url.substring(0, m.index) : url;
  const abs = getAbsoluteURL(chapter.baseUrl || '', urlBefore);
  return urlBefore.length === url.length ? abs : abs + ',' + url.substring(m.index + m[0].length);
}

/** WebBook.preciseSearchAwait */
export function preciseSearch(ctx, source, name, author) {
  const list = searchBook(ctx, source, name, 1,
    (fName, fAuthor) => fName === name && fAuthor === author,
    (size) => size > 0);
  if (list && list.length) return list[0].toBook();
  throw new Error(`未搜索到 ${name}(${author}) 书籍`);
}

/** WebBook.searchBookAwait */
export function searchBook(ctx, source, key, page = 1, filter = null, shouldBreak = null) {
  if (isJsSource(source)) {
    throw new Error('JS 单文件书源请使用 js-source 模块');
  }
  if (!source.searchUrl || !String(source.searchUrl).trim()) {
    throw new Error('搜索url不能为空');
  }
  const ruleData = new RuleData();
  const au = newAnalyzeUrl(ctx, source.searchUrl, {
    key, page, baseUrl: source.bookSourceUrl, source, ruleData,
  });
  const res = fetchWithLoginCheck(ctx, au, source);
  const isRedirect = !!(res.raw && res.raw.priorResponse && res.raw.priorResponse.isRedirect);
  return analyzeBookList(ctx, source, ruleData, au, res.url, res.body, true, isRedirect, filter, shouldBreak);
}

/** WebBook.exploreBookAwait */
export function exploreBook(ctx, source, url, page = 1, infoMap = null) {
  const ruleData = new RuleData();
  const __actsBefore = Array.isArray(ctx.browserActions) ? ctx.browserActions.length : 0;
  const au = newAnalyzeUrl(ctx, url, {
    page, baseUrl: source.bookSourceUrl, source, ruleData, infoMap,
  });
  // 发现页里有一类 kind 的 url 是 {{java.startBrowser(...)}} 这种「纯副作用」表达式
  // （光遇聚合的「登录晴天书源 / 登录番茄」）。
  //
  // legado 的真实行为：AnalyzeUrl.replaceKeyPageJs() 只在求值结果非空时才覆盖 ruleUrl，
  // 所以 JS 返回空串时 ruleUrl 仍是原文 '{{java.startBrowser(...)}}'；随后 analyzeUrl()
  // 拼出这个非 URL 字符串去请求并抛错。但那一步发生在 WebView 已经弹出之后，
  // 用户看到的是登录窗，异常被协程吞掉，所以「能用」。
  //
  // 桌面端等价做法：本次构造过程中若产生了 browserActions（说明碰到 startBrowser 这类
  // 副作用），且 ruleUrl 里还残留未求值的 {{}}，就判定为纯副作用触发的发现项，
  // 直接返回空列表，把「开登录窗」交给前端落地，不再把 Invalid URL 糊到用户脸上。
  const pendingStr = String(au.ruleUrl || '');
  const hasPendingJs = pendingStr.includes('{{') && pendingStr.includes('}}');
  if (hasPendingJs && Array.isArray(ctx.browserActions) && ctx.browserActions.length > __actsBefore) return [];
  const res = fetchWithLoginCheck(ctx, au, source);
  // 发现页解析为空时，legado 的界面仍能区分「接口返回失败」和「规则没有匹配到列表」。
  // 把安全的响应摘要交给上层，避免桌面端一律显示成含糊的“没有返回书”。
  if (ctx) {
    const meta = {
      status: Number(res && res.code) || 0,
      url: String((res && res.url) || ''),
      bodyLength: String((res && res.body) || '').length,
      bodyKeys: [],
      message: '',
    };
    try {
      const parsed = JSON.parse(String((res && res.body) || ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta.bodyKeys = Object.keys(parsed).slice(0, 12);
        if (parsed.msg != null) meta.message = String(parsed.msg);
        else if (parsed.message != null) meta.message = String(parsed.message);
        else if (parsed.error != null) meta.message = String(parsed.error);
      }
    } catch { /* HTML/XML 响应没有 JSON 摘要 */ }
    ctx.lastExploreMeta = meta;
  }
  const isRedirect = !!(res.raw && res.raw.priorResponse && res.raw.priorResponse.isRedirect);
  return analyzeBookList(ctx, source, ruleData, au, res.url, res.body, false, isRedirect, null, null);
}

/** BookSource.isJsSource */
export function isJsSource(source) {
  return !!(source && source.mainJs && String(source.mainJs).trim());
}

/* ============================ SearchModel.mergeItems ============================ */

/**
 * SearchModel.mergeItems —— 多源搜索结果合并排序
 * 四个桶：equal（书名/作者等于关键字）、tags（分类含关键字）、contains（书名/作者含关键字）、
 *         other（非精确模式下的其余结果）。桶内同名同作者合并 origin。
 *
 * @param {Array} items 新结果
 * @param {boolean} precision 精确模式
 * @param {string} key 搜索关键字
 * @param {Array} searchBooks 已有结果（会被修改）
 * @returns {Array} 合并后的结果（等于 equal 桶）
 */
export function mergeItems(items, precision, key, searchBooks) {
  const existing = searchBooks || [];
  const equalData = [];
  const tagsData = [];
  const containsData = [];
  const otherData = [];

  const bucketOf = (b) => {
    if (b.name === key || b.author === key) return equalData;
    if (b.kind && String(b.kind).includes(key)) return tagsData;
    if ((b.name && String(b.name).includes(key)) || (b.author && String(b.author).includes(key))) return containsData;
    if (!precision) return otherData;
    return null;
  };

  const put = (bucket, nBook) => {
    if (!bucket) return;
    for (const pBook of bucket) {
      if (pBook.name === nBook.name && pBook.author === nBook.author) {
        pBook.addOrigin(nBook.origin);
        return;
      }
    }
    bucket.push(nBook);
  };

  for (const b of existing) put(bucketOf(b), b);
  for (const b of items) put(bucketOf(b), b);

  equalData.sort((a, b) => b.origins.size - a.origins.size);
  tagsData.sort((a, b) => b.origins.size - a.origins.size);
  containsData.sort((a, b) => b.origins.size - a.origins.size);

  const merged = [...equalData, ...tagsData, ...containsData];
  if (!precision) merged.push(...otherData);
  return merged;
}

/* ============================ 统一门面 ============================ */

/**
 * 一次抓取会话（worker 内使用）。
 * 所有方法都是同步阻塞的。
 */
export class WebBookSession {
  constructor(opts = {}) {
    this.ctx = makeContext(opts);
  }
  search(source, key, page = 1, filter = null, shouldBreak = null) {
    return searchBook(this.ctx, source, key, page, filter, shouldBreak);
  }
  explore(source, url, page = 1, infoMap = null) {
    return exploreBook(this.ctx, source, url, page, infoMap);
  }
  bookInfo(source, book, canReName = true) {
    return getBookInfo(this.ctx, source, book, canReName);
  }
  chapters(source, book, runPerJs = false, isFromBookInfo = false) {
    return getChapterList(this.ctx, source, book, runPerJs, isFromBookInfo);
  }
  content(source, book, chapter, nextChapterUrl = null) {
    return getContent(this.ctx, source, book, chapter, nextChapterUrl);
  }
  preciseSearch(source, name, author) {
    return preciseSearch(this.ctx, source, name, author);
  }
}

export default WebBookSession;
