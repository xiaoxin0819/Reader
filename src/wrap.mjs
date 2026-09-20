// wrap.mjs —— BaseSource / Book / BookChapter 的规则可见语义包装
// 对应 legado: BaseSource.kt + BookSource 扩展 + Book.kt + BookChapter.kt 中暴露给 JS 的部分。
// 不 import rule-engine，避免循环依赖。
import crypto from 'node:crypto';
import { getAbsoluteURL, splitNotBlank } from './net-utils.mjs';
import { getConcurrentLimiter, updateConcurrentRate } from './rate-limiter.mjs';
import { JavaBridgeBase, getAllMethodNames } from './java-bridge.mjs';
import { parseRelaxedJson } from './net-utils.mjs';

const SEARCH_RULE_FIELDS = ['checkKeyWord', 'bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'];
const EXPLORE_RULE_FIELDS = ['bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'];
const BOOK_INFO_RULE_FIELDS = ['init', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'coverUrl', 'tocUrl', 'wordCount', 'canReName', 'downloadUrls'];
const TOC_RULE_FIELDS = ['preUpdateJs', 'chapterList', 'chapterName', 'chapterUrl', 'formatJs', 'isVolume', 'isVip', 'isPay', 'updateTime', 'nextTocUrl'];
const CONTENT_RULE_FIELDS = ['content', 'subContent', 'title', 'nextContentUrl', 'webJs', 'sourceRegex', 'replaceRegex', 'imageStyle', 'imageDecode', 'payAction', 'callBackJs'];

/** AnalyzeUrl.paramPattern: /\s*,\s*(?=\s*\{)/ */
const CHAPTER_PARAM_PATTERN = /\s*,\s*(?=\s*\{)/;

function emptyRule(fields) {
  const o = {};
  for (const k of fields) o[k] = null;
  return o;
}

/** 把 rule 对象里的 null/undefined 补成 null，保证字段齐全 */
function normRule(obj, fields) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const o = {};
  for (const k of fields) {
    const v = src[k];
    o[k] = v === undefined || v === null || v === '' ? null : String(v);
  }
  return o;
}

/** JsNetwork（source 已绑定）→ legado 的 java.ajax 系列签名 */
export function wrapNetwork(network, source) {
  if (!network) return null;
  return {
    ajax: (url, callTimeout) => network.ajax(url, callTimeout, source),
    ajaxAll: (urlList, skipRateLimit) => network.ajaxAll(urlList, skipRateLimit, source),
    ajaxTestAll: (urlList, timeout, skipRateLimit) => network.ajaxAll(urlList, skipRateLimit, source),
    connect: (u, h, t) => network.connect(u, h, t, source),
    get: (u, h, t) => network.get(u, h, t, source),
    post: (u, b, h, t) => network.post(u, b, h, t, source),
    head: (u, h, t) => network.head(u, h, t, source),
  };
}

const wrapCache = new WeakMap(); // source -> {env, wrapped}

/**
 * 包装书源（BaseSource 语义）
 * @param {object} source 原始书源 JSON 对象
 * @param {object} env {cookieStore, cache, logger, network, evalJs}
 *   evalJs(code, result, extra) —— source.evalJS 的执行器（由 rule-engine 注入）
 */
export function wrapSource(source, env = {}) {
  if (!source) return null;
  const cached = wrapCache.get(source);
  if (cached && cached.env === env) return cached.wrapped;

  const key = String(source.bookSourceUrl || '');
  const cookieStore = env.cookieStore || null;
  const cache = env.cache || null;
  const logger = env.logger || null;

  const W = {
    // ---- 字段 ----
    bookSourceUrl: source.bookSourceUrl,
    bookSourceName: source.bookSourceName,
    bookSourceComment: source.bookSourceComment,
    bookSourceType: source.bookSourceType ?? 0,
    customOrder: source.customOrder ?? 0,
    enabled: source.enabled !== false,
    enabledExplore: source.enabledExplore !== false,
    enabledCookieJar: source.enabledCookieJar === true,
    header: source.header ?? null,
    loginUrl: source.loginUrl ?? null,
    loginUi: source.loginUi ?? null,
    loginCheckJs: source.loginCheckJs ?? null,
    jsLib: source.jsLib ?? null,
    exploreUrl: source.exploreUrl ?? null,
    searchUrl: source.searchUrl ?? null,
    concurrentRate: source.concurrentRate ?? null,

    // ---- 标识 ----
    getKey() { return key; },
    getTag() { return source.bookSourceName || ''; },
    getSource() { return W; },
    // legado BookSource.getBookType(): Int（BookType 位掩码）
    getBookType() {
      switch (source.bookSourceType) {
        case 3: return 136;   // text(8) or webFile(128)
        case 2: return 64;    // image
        case 1: return 32;    // audio
        case 4: return 4;     // video
        default: return 8;    // text
      }
    },
    isJsSource() { const m = source.mainJs; return !!(m && String(m).trim()); },

    // ---- 规则读取 ----
    getSearchRule() { return normRule(source.ruleSearch, SEARCH_RULE_FIELDS); },
    getExploreRule() { return normRule(source.ruleExplore, EXPLORE_RULE_FIELDS); },
    getBookInfoRule() { return normRule(source.ruleBookInfo, BOOK_INFO_RULE_FIELDS); },
    getTocRule() { return normRule(source.ruleToc, TOC_RULE_FIELDS); },
    getContentRule() { return normRule(source.ruleContent, CONTENT_RULE_FIELDS); },

    // ---- 自定义变量 / KV ----
    setVariable(v) { if (v === null || v === undefined) cache?.delete(`sourceVariable_${key}`); else cache?.put(`sourceVariable_${key}`, String(v)); },
    putVariable(v) { W.setVariable(v); },
    getVariable() { return (cache && cache.get(`sourceVariable_${key}`)) || ''; },
    put(k, v) { cache?.put(`v_${key}_${k}`, String(v)); return v; },
    get(k) { return (cache && cache.get(`v_${key}_${k}`)) || ''; },

    // ---- 登录 ----
    getLoginJs() {
      const loginUrl = source.loginUrl;
      if (!loginUrl) return null;
      const s = String(loginUrl);
      if (s.startsWith('@js:')) return s.substring(4);
      if (s.startsWith('<js>')) return s.substring(4, s.lastIndexOf('<'));
      return s;
    },
    hasLoginForm() {
      const ui = source.loginUi;
      if (!ui || !String(ui).trim()) return false;
      return String(ui).replace(/\s/g, '') !== '[]';
    },
    hasLogin() { return !!(source.loginUrl && String(source.loginUrl).trim()) || W.hasLoginForm(); },
    loginInfoInitStack: new Set(),
    getLoginInfoMap() {
      const raw = W.getLoginInfo();
      if (raw) { try { return JSON.parse(raw); } catch (e) { return {}; } }
      const uiRule = source.loginUi;
      if (!uiRule || !String(uiRule).trim()) return {};
      if (W.loginInfoInitStack.has(key)) return {};
      W.loginInfoInitStack.add(key);
      try {
        let json;
        const ui = String(uiRule);
        if (ui.startsWith('@js:') || ui.startsWith('<js>')) {
          const sub = ui.startsWith('@js:') ? ui.substring(4) : ui.substring(4, ui.lastIndexOf('<'));
          const code = (W.getLoginJs() || '') + '\n' + sub;
          json = String(env.evalJs ? env.evalJs(code, { result: {}, book: null, chapter: null }) : '');
        } else json = ui;
        // legado: loginUi 解析同样走 GSON 宽松回退（裸键 / 单引号 / 尾逗号）
        const arr = parseRelaxedJson(json);
        if (!Array.isArray(arr)) return {};
        const map = {};
        for (const it of arr) {
          if (!it || it.type === 'button') continue;
          map[it.name] = it.default == null ? '' : String(it.default);
        }
        if (Object.keys(map).length) W.putLoginInfo(JSON.stringify(map));
        return map;
      } finally { W.loginInfoInitStack.delete(key); }
    },
    getLoginInfo() {
      const enc = cache && cache.get(`userInfo_${key}`);
      if (!enc) return null;
      try { return decryptLoginInfo(enc); } catch (e) { if (logger) logger(`getLoginInfo 解密失败: ${e && e.message}`); return null; }
    },
    putLoginInfo(info) {
      try { cache?.put(`userInfo_${key}`, encryptLoginInfo(String(info))); return true; }
      catch (e) { if (logger) logger(`putLoginInfo 加密失败: ${e && e.message}`); return false; }
    },
    removeLoginInfo() { cache?.delete(`userInfo_${key}`); },
    getLoginHeader() { return (cache && cache.get(`loginHeader_${key}`)) || null; },
    getLoginHeaderMap() {
      const s = W.getLoginHeader();
      if (!s) return null;
      try { const m = JSON.parse(s); return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
    },
    putLoginHeader(header) {
      if (!header) return;
      try {
        const m = JSON.parse(String(header));
        const cookie = m && (m['Cookie'] ?? m['cookie']);
        if (cookie && cookieStore) cookieStore.replaceCookie(key, String(cookie));
      } catch (e) { /* ignore */ }
      cache?.put(`loginHeader_${key}`, String(header));
    },
    removeLoginHeader() { cache?.delete(`loginHeader_${key}`); cookieStore?.removeCookie(key); },

    // ---- 请求头 ----
    getHeaderMap(hasLoginHeader = false) {
      const out = {};
      const h = source.header;
      if (h) {
        try {
          let json = String(h);
          if (json.startsWith('@js:')) json = String(env.evalJs ? env.evalJs(json.substring(4)) : '');
          else if (json.startsWith('<js>')) json = String(env.evalJs ? env.evalJs(json.substring(4, json.lastIndexOf('<'))) : '');
          // legado: GSONStrict 失败后回退 GSON（lenient）。
          // 书源里常见 {'User-Agent': "..."} 这种单引号 JSON，JSON.parse 会挂。
          const m = parseRelaxedJson(json);
          if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) out[k] = String(v);
        } catch (e) { if (logger) logger(`执行请求头规则出错 ${e && e.message}`); }
      }
      if (!Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')) out['User-Agent'] = env.defaultUA || '';
      if (hasLoginHeader) { const lm = W.getLoginHeaderMap(); if (lm) for (const [k, v] of Object.entries(lm)) out[k] = v; }
      return out;
    },

    /**
     * legado 里 java === source === sourceApi 是 Kotlin 对象，Rhino 会把 getXxx() 映射成属性 xxx，
     * 所以书源可以写 source.key。JS 对象不会自动映射，这里显式补上这类读取。
     * 不补的话 source.key 是 undefined，全本小说（searchUrl 里 java.ajax(source.key)）
     * 会报 "Cannot read properties of null (reading '1')"。
     */
    get key() { return key; },
    get tag() { return source.bookSourceName || ''; },
    get bookType() { return W.getBookType(); },
    get loginJs() { return W.getLoginJs(); },
    get name() { return source.bookSourceName || ''; },
    get url() { return source.bookSourceUrl || ''; },

    // ---- 其他 ----
    refreshExplore() {
      // legado BaseSource.refreshExplore()：清发现分类缓存（不是正文缓存）
      if (typeof env.onRefreshExplore === 'function') {
        try { env.onRefreshExplore(source); } catch (e) { if (logger) logger('refreshExplore 失败: ' + (e && e.message)); }
      } else if (logger) logger('refreshExplore：未接入发现缓存');
    },
    refreshJSLib() { if (logger) logger('refreshJSLib 桌面端忽略'); },
    // legado 里 java.toast / java.longToast 会真的弹 Toast（source API 即 java）。
    // 有 action 通道（发现页）就回传前端弹；否则退回 logger 记录，不再静默吞掉提示。
    toast(msg) {
      if (typeof env.onToast === 'function') { try { env.onToast(msg); return ''; } catch (err) { /* 退回 logger */ } }
      if (logger) logger(`[toast] ${msg}`);
      return '';
    },
    longToast(msg) {
      if (typeof env.onToast === 'function') { try { env.onToast(msg); return ''; } catch (err) { /* 退回 logger */ } }
      if (logger) logger(`[longToast] ${msg}`);
      return '';
    },
    putConcurrent(value) { updateConcurrentRate(key, value); },
    getConcurrentRate() { return source.concurrentRate ?? null; },
    getLimiter() { return getConcurrentLimiter(source); },
    toString() { return source.bookSourceName || key; },
  };

  // ---- JsExtensions 方法补齐 ----
  // legado: interface BaseSource : JsExtensions，书源级 evalJS 里 java === source === sourceApi，
  // 所以 java.ajax / java.longToast / java.md5Encode ... 必须直接挂在 source 包装对象上。
  // 不这样做，发现页脚本里的 java.longToast()/java.ajax() 会直接抛
  // "java.xxx is not a function"，整个 exploreUrl 解析失败。
  const bridge = new JavaBridgeBase({
    source, cookieStore, cache, logger,
    network: wrapNetwork(env.network, source),
  });
  for (const k of getAllMethodNames(bridge)) {
    if (k === 'constructor') continue;
    if (k in W) continue; // W 自身实现（BaseSource 的覆写）优先
    const v = bridge[k];
    if (typeof v === 'function') W[k] = v.bind(bridge);
  }

  const wrapped = W;
  wrapCache.set(source, { env, wrapped });
  return wrapped;
}

function loginCryptoKey() {
  return Buffer.from('localreader00000', 'utf8').subarray(0, 16);
}

function encryptLoginInfo(plain) {
  const cipher = crypto.createCipheriv('aes-128-ecb', loginCryptoKey(), null);
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');
}

function decryptLoginInfo(enc) {
  const d = crypto.createDecipheriv('aes-128-ecb', loginCryptoKey(), null);
  return Buffer.concat([d.update(Buffer.from(String(enc), 'base64')), d.final()]).toString('utf8');
}

/**
 * Kotlin RuleDataInterface.putVariable 的语义：
 *   value == null        → 删除 map[key]，返回 keyExist
 *   value.length < 10000 → map[key] = value，返回 true
 *   else                 → map 里删掉、存 big，返回 keyExist
 */
export function putVariableInto(map, key, value) {
  const keyExist = Object.prototype.hasOwnProperty.call(map, key);
  if (value === null || value === undefined) {
    delete map[key];
    return keyExist;
  }
  const str = String(value);
  if (str.length < 10000) {
    map[key] = str;
    return true;
  }
  delete map[key];
  return keyExist;
}

/** 包装 Book（ReadBook / Book 语义） */
export function wrapBook(book, env = {}) {
  if (!book) return null;
  if (book.__wrappedBook) return book.__wrappedBook;
  const B = Object.create(null);
  Object.defineProperty(B, '__wrappedBook', { value: B, enumerable: false });
  const passthrough = ['bookUrl', 'tocUrl', 'origin', 'originName', 'name', 'author', 'kind', 'customTag',
    'coverUrl', 'customCoverUrl', 'intro', 'customIntro', 'charset', 'type', 'group', 'latestChapterTitle',
    'latestChapterTime', 'lastCheckTime', 'lastCheckCount', 'totalChapterNum', 'durChapterTitle',
    'durChapterIndex', 'durVolumeIndex', 'chapterInVolumeIndex', 'durChapterPos', 'durChapterTime',
    'wordCount', 'canUpdate', 'order', 'originOrder', 'readConfig', 'syncTime', 'isOnLineTxt'];
  for (const k of passthrough) {
    Object.defineProperty(B, k, {
      get() { return book[k]; },
      set(v) { book[k] = v; },
      enumerable: true,
    });
  }
  B.variableMap = book.variableMap || {};
  if (!book.variableMap) book.variableMap = B.variableMap;
  /** Kotlin BaseBook.putVariable：写入 variableMap 后序列化回 book.variable；永远 return true */
  B.putVariable = (key, value) => {
    putVariableInto(B.variableMap, key, value);
    try { book.variable = JSON.stringify(B.variableMap); } catch (e) { /* ignore */ }
    return true;
  };
  B.putBigVariable = (key, value) => {
    if (value === null || value === undefined) delete B.variableMap[key];
    else B.variableMap[key] = String(value);
    return true;
  };
  B.getBigVariable = (key) => (B.variableMap[key] === undefined ? null : String(B.variableMap[key]));
  B.getVariable = (k) => {
    if (k === undefined || k === null) return '';
    const v = B.variableMap ? B.variableMap[k] : undefined;
    return v === undefined || v === null ? '' : String(v);
  };
  B.getReverseToc = () => !!(book.readConfig && book.readConfig.reverseToc === true);
  // legado BaseBook.getKindList()：wordCount 优先，再按 , 与 \n 切分（splitNotBlank）
  B.getKindList = () => {
    const out = [];
    if (book.wordCount && String(book.wordCount).trim()) out.push(String(book.wordCount));
    if (book.kind) {
      for (const seg of splitNotBlank(String(book.kind), ',')) {
        for (const s2 of splitNotBlank(seg, '\n')) out.push(s2);
      }
    }
    return out;
  };
  B.getCustomVariable = (k) => (book.customVariableMap && book.customVariableMap[k]) || '';
  B.putCustomVariable = (k, v) => { book.customVariableMap = book.customVariableMap || {}; book.customVariableMap[k] = v; return v; };
  B.toSearchBook = () => ({
    name: B.name, author: B.author, bookUrl: B.bookUrl, origin: B.origin, originName: B.originName,
    kind: B.kind, intro: B.intro, coverUrl: B.coverUrl, tocUrl: B.tocUrl, wordCount: B.wordCount,
    latestChapterTitle: B.latestChapterTitle, originOrder: B.originOrder, variableMap: B.variableMap,
  });
  B.setUseReplaceRule = () => {};
  B.getUseReplaceRule = () => false;
  // legado 的 Book 上没有这个字段：包装对象缓存必须以「不可枚举」方式回指，
  // 否则 book-worker 的 sanitize 会把它当成普通字段整份拷到主线程（函数被丢弃），
  // 再次 wrapBook 时命中这份僵尸副本 → book.getVariable/putVariable 全部消失。
  Object.defineProperty(book, '__wrappedBook', { value: B, enumerable: false, writable: true, configurable: true });
  return B;
}

/** 包装 BookChapter（BookChapter 语义 + isVip() 调用式） */
export function wrapChapter(chapter, env = {}) {
  if (!chapter) return null;
  if (chapter.__wrappedChapter) return chapter.__wrappedChapter;
  const C = Object.create(null);
  Object.defineProperty(C, '__wrappedChapter', { value: C, enumerable: false });
  for (const k of ['url', 'title', 'index', 'isVolume', 'tag', 'baseUrl', 'bookUrl', 'wordCount',
    'start', 'end', 'startFragmentId', 'endFragmentId', 'imgUrl', 'resourceUrl']) {
    Object.defineProperty(C, k, { get() { return chapter[k]; }, set(v) { chapter[k] = v; }, enumerable: true });
  }
  Object.defineProperty(C, '_isVip', { get() { return !!chapter.isVip; }, set(v) { chapter.isVip = !!v; }, enumerable: false });
  Object.defineProperty(C, '_isPay', { get() { return !!chapter.isPay; }, set(v) { chapter.isPay = !!v; }, enumerable: false });
  C.isVip = () => !!chapter.isVip;       // 规则 JS: chapter.isVip()
  C.isPay = () => !!chapter.isPay;
  C.variableMap = chapter.variableMap || {};
  if (!chapter.variableMap) chapter.variableMap = C.variableMap;
  C.getVariable = (k) => (C.variableMap && C.variableMap[k] != null ? String(C.variableMap[k]) : '');
  /** Kotlin BookChapter.putVariable：写入后序列化回 chapter.variable；永远 return true */
  C.putVariable = (key, value) => {
    putVariableInto(C.variableMap, key, value);
    try { chapter.variable = JSON.stringify(C.variableMap); } catch (e) { /* ignore */ }
    return true;
  };
  C.putBigVariable = (key, value) => {
    if (value === null || value === undefined) delete C.variableMap[key];
    else C.variableMap[key] = String(value);
    return true;
  };
  C.getBigVariable = (key) => (C.variableMap[key] === undefined ? null : String(C.variableMap[key]));
  C.putLyric = (value) => C.putVariable('lyric', value);
  C.putDanmaku = (value) => C.putVariable('danmaku', value);
  // legado BookChapter.getAbsoluteURL()：支持 "url,{js/规则}" 形式
  C.getAbsoluteURL = () => {
    const url = String(chapter.url == null ? '' : chapter.url);
    const title = String(chapter.title == null ? '' : chapter.title);
    if (chapter.isVolume && title && url.startsWith(title)) return chapter.baseUrl || '';
    const m = CHAPTER_PARAM_PATTERN.exec(url);
    const urlBefore = m ? url.substring(0, m.index) : url;
    const abs = getAbsoluteURL(chapter.baseUrl || '', urlBefore);
    return urlBefore.length === url.length ? abs : abs + ',' + url.substring(m.index + m[0].length);
  };
  C.toString = () => String(chapter.title || '');
  Object.defineProperty(chapter, '__wrappedChapter', { value: C, enumerable: false, writable: true, configurable: true });
  return C;
}

export { emptyRule };
