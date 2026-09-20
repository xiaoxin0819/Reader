// book-worker.mjs —— 书源抓取工作线程
//
// 为什么必须单独开线程：sync-net.mjs 与 rate-limiter 都用 Atomics.wait 同步阻塞
// 调用线程来等待网络结果（这是为了复刻 legado/Rhino 的同步语义）。这个阻塞发生在
// 主线程就会冻住整个服务器，所以所有书源任务都丢到 worker 里跑，主线程只 await 消息。
//
// 协议（main → worker）：
//   { id, type, payload }
// 回包（worker → main）：
//   { id, ok:true, result } | { id, ok:false, error, code, data? }
//
// type 一览：
//   init         { sources, slots, jsTimeoutMs }  载入书源 + 起网络线程
//   setSources   { sources }                      热更新书源（不重启 worker）
//   search       { sourceUrl, key, page, precision }
//   explore      { sourceUrl, url, page }
//   exploreKinds { sourceUrl, infoMap }
//   exploreAction{ sourceUrl, action, infoMap, kind } 发现页按钮/输入/下拉的 action（evalButtonClick）
//   exploreUiJs  { sourceUrl, code, infoMap }         viewName 求值（evalUiJs）
//   bookInfo     { sourceUrl, book, canReName }
//   chapters     { sourceUrl, book, runPerJs, isFromBookInfo }
//   content      { sourceUrl, book, chapter, nextChapterUrl, needSave }
//   jsRun        { sourceUrl, book, chapter, code, result }  通用 js 执行（书源生成 html 里的 qmRun 桥）
//   loginInfo    { sourceUrl }                          登录 UI 规则求值（SourceLoginDialog 初始化）
//   loginAction  { sourceUrl, action, result, rowUis }   登录页按钮点击（handleButtonClick）
//   login        { sourceUrl, loginData }                执行 login()
//   loginLogout  { sourceUrl }                           清除登录信息与 cookie
//   loginCookie  { sourceUrl, domain, cookie, loginData } 浏览器宿主回写 cookie（CookieStore.setCookie）
//   preciseSearch{ sourceUrl, name, author }
//   verifySubmit { sourceKey, result, url }       把用户提交的验证结果回灌给阻塞中的抓取
//   verifyList   {}                               当前待处理验证任务
//   debug        { sourceUrl, book, chapter }     规则调试：跑搜索→详情→目录→正文并收集日志
//   clearCache   {}
//   ping         {}
import { parentPort, workerData } from 'node:worker_threads';
import { configureNet, shutdownNet } from './sync-net.mjs';
import {
  WebBookSession, makeContext, createBook, createChapter, createSearchBook,
  DebugCollector, mergeItems, isJsSource, BookType,
} from './web-book.mjs';
import { createAnalyzeRule, runSourceJs } from './rule-engine.mjs';
import { mixJavaBridge } from './java-bridge.mjs';
import { wrapBook, wrapChapter } from './wrap.mjs';
import * as JsSource from './js-source.mjs';
import { normalizeSource, getKey } from './book-source-model.mjs';
import { wrapSource } from './wrap.mjs';
import {
  exploreKinds as exploreKindsOf, evalExploreAction, evalExploreUiJs, getExploreInfoMap,
  clearExploreKindsCache, clearAllExploreCache as exploreCacheClearAll, exploreKindsJson,
} from './explore.mjs';
import {
  setResult, takeResult, listPending, removePending, resetVerification,
} from './verification.mjs';
import { WebJsUnsupportedError } from './js-runtime.mjs';
import { parseRelaxedJson } from './net-utils.mjs';

/* ============================ 状态 ============================ */

/** bookSourceUrl -> normalized source */
let sources = new Map();
let session = null;
let ctx = null;
const logs = [];
const MAX_LOGS = 500;
/** 正文缓存：`${sourceUrl}::${bookUrl}::${chapterIndex}` */
const contentCache = new Map();

function logger(msg) {
  const line = String(msg);
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function ensureSession() {
  if (session) return session;
  ctx = makeContext({ logger, debug: new DebugCollector('') });
  session = new WebBookSession({ logger, debug: ctx.debug });
  session.ctx = ctx;
  return session;
}

function loadSources(list) {
  const map = new Map();
  for (const raw of list || []) {
    const s = normalizeSource(raw);
    const key = getKey(s);
    if (key) map.set(key, s);
  }
  sources = map;
  // 书源换了 → 包装对象随之失效
  wrappedCache.clear();
  return map.size;
}

/**
 * 每个抓取任务开始前重置「浏览器动作」收集器。
 * legado 里 java.showBrowser/startBrowser 会直接弹 Android WebView；桌面端没有内嵌
 * WebView，改成把要开的窗口收集起来，任务结束后回给前端落地（见 taskJsRun 的做法）。
 */
function beginActions() {
  ensureSession();
  if (!Array.isArray(ctx.browserActions)) ctx.browserActions = [];
  else ctx.browserActions.length = 0;
  return ctx.browserActions;
}

function getSource(sourceUrl) {
  const s = sources.get(String(sourceUrl || ''));
  if (!s) throw Object.assign(new Error(`书源不存在: ${sourceUrl}`), { code: 'NO_SOURCE' });
  return s;
}

/**
 * WebBookSession 吃的是 wrapSource 包装后的书源（getSearchRule()/getLoginHeaderMap()…）。
 * JS 单文件源则用裸 source（要读 mainJs）。
 */
const wrappedCache = new Map();
function wrappedOf(source) {
  const key = getKey(source);
  const c = wrappedCache.get(key);
  if (c && c.raw === source) return c.wrapped;
  ensureSession();
  const svc = ctx.services;
  const wrapped = wrapSource(source, {
    cookieStore: svc.cookieStore,
    cache: svc.cache,
    logger,
    network: svc.network,
  });
  wrappedCache.set(key, { raw: source, wrapped });
  return wrapped;
}

/** 统一异常 → 可序列化错误 */
function toError(e) {
  if (e instanceof WebJsUnsupportedError || (e && e.verificationRequired)) {
    return {
      ok: false,
      error: (e && e.message) || '需要人工验证',
      code: 'VERIFICATION',
      data: {
        sourceKey: (e && e.sourceKey) || '',
        url: (e && e.url) || '',
        title: (e && e.title) || '',
        sourceName: (e && e.sourceName) || '',
        kind: (e && e.kind) || 'webview',
        api: (e && e.api) || '',
      },
    };
  }
  return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || 'ERROR' };
}

/* ============================ 任务实现 ============================ */

function isJs(s) { return !!(s.mainJs && String(s.mainJs).trim()); }

function taskSearch(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  const precision = payload.precision === true;
  const key = String(payload.key || '');
  const page = Number(payload.page) || 1;
  const out = [];
  const perSource = [];

  const filter = (name, author, kind) => {
    if (!precision) return true;
    const k = key;
    return String(name || '').includes(k) || String(author || '').includes(k) || String(kind || '').includes(k);
  };

  const before = Date.now();
  let books = [];
  if (isJs(s)) books = JsSource.search(ctx, s, key, page, filter);
  else books = session.search(wrappedOf(s), key, page, filter, null);
  const cost = Date.now() - before;

  for (const b of books) {
    const sb = createSearchBook({ ...b, respondTime: cost });
    perSource.push(sb);
    out.push(sb);
  }
  return {
    books: out,
    respondTime: cost,
    count: out.length,
    sourceName: s.bookSourceName,
    actions,
  };
}

function taskExplore(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  ctx.lastExploreMeta = null;
  ctx.infoMap = (payload && payload.infoMap) || null;
  const url = String(payload.url || '');
  const page = Number(payload.page) || 1;
  const before = Date.now();
  const books = isJs(s) ? JsSource.explore(ctx, s, url, page) : session.explore(wrappedOf(s), url, page);
  const respondTime = Date.now() - before;
  return { books: books.map((b) => createSearchBook({ ...b, respondTime })), respondTime, actions, meta: ctx.lastExploreMeta || null };
}

function taskExploreKinds(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  ctx.infoMap = (payload && payload.infoMap) || null;
  const kinds = exploreKindsOf(ctx, s);
  // 前端拿到 kinds 后会把 infoMap 存回来（ExploreAdapter 的 infoMap 是跨调用共享的）
  const infoMap = getExploreInfoMap(s, ctx);
  return { kinds, infoMap: JSON.parse(infoMap.toString() || '{}'), actions };
}

/**
 * 发现页 kind 的 action（ExploreAdapter.evalButtonClick / evalUiJs）。
 * 执行后若脚本调了 java.refreshExplore()，就照 legado 的 refreshExplore() 清缓存重拉分类。
 */
function taskExploreAction(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  ctx.infoMap = (payload && payload.infoMap) || null;
  ctx.exploreActions = [];
  ctx.exploreRefresh = false;
  const before = getExploreInfoMap(s, ctx);
  const kind = payload.kind && typeof payload.kind === 'object' ? payload.kind : {};
  const code = payload.action != null ? payload.action : kind.action;
  const r = evalExploreAction(ctx, s, code, before, kind.title || payload.title || '');
  before.saveNow();
  const actions = ctx.exploreActions || [];
  let kinds = null;
  if (ctx.exploreRefresh) {
    // legado: clearExploreKindsCache() → exploreKinds()
    clearExploreKindsCache(s);
    kinds = exploreKindsOf(ctx, s);
    getExploreInfoMap(s, ctx).saveNow();
  }
  return {
    ok: r.ok, error: r.error || null, actions, refreshed: !!ctx.exploreRefresh,
    kinds, infoMap: JSON.parse(before.toString() || '{}'),
    raw: exploreKindsJson(s),
  };
}

/** viewName 求值（ExploreAdapter.evalUiJs） */
function taskExploreUiJs(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  ctx.infoMap = (payload && payload.infoMap) || null;
  const before = getExploreInfoMap(s, ctx);
  const v = evalExploreUiJs(ctx, s, payload.code, before);
  return { value: v };
}

function taskBookInfo(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  const book = createBook(payload.book || {});
  const canReName = payload.canReName !== false;
  const before = Date.now();
  if (isJs(s)) JsSource.getBookInfo(ctx, s, book, canReName);
  else session.bookInfo(wrappedOf(s), book, canReName);
  return { book, respondTime: Date.now() - before, actions };
}

function taskChapters(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  const book = createBook(payload.book || {});
  const chapters = isJs(s)
    ? JsSource.getChapterList(ctx, s, book)
    : session.chapters(wrappedOf(s), book, payload.runPerJs === true, payload.isFromBookInfo === true);
  return { book, chapters, actions };
}

function taskContent(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  const book = createBook(payload.book || {});
  const chapter = createChapter(payload.chapter || {});
  const cacheKey = `${getKey(s)}::${book.bookUrl}::${chapter.index}::${chapter.url}`;
  if (!payload.refresh && contentCache.has(cacheKey)) {
    return { content: contentCache.get(cacheKey), cached: true, actions };
  }
  const content = isJs(s)
    ? JsSource.getContent(ctx, s, book, chapter, payload.nextChapterUrl || null)
    : session.content(wrappedOf(s), book, chapter, payload.nextChapterUrl || null);
  contentCache.set(cacheKey, content);
  if (contentCache.size > 200) {
    const first = contentCache.keys().next().value;
    contentCache.delete(first);
  }
  return { content, cached: false, actions };
}

function taskPreciseSearch(payload) {
  const s = getSource(payload.sourceUrl);
  const actions = beginActions();
  if (isJs(s)) {
    const list = JsSource.search(ctx, s, String(payload.name || ''), 1);
    const hit = list.find((b) => b.name === payload.name && b.author === payload.author);
    if (!hit) throw new Error(`未搜索到 ${payload.name}(${payload.author})`);
    return { book: hit.toBook(), actions };
  }
  return { book: session.preciseSearch(wrappedOf(s), payload.name, payload.author), actions };
}

/** 规则调试：按 legado BookSourceDebug 的方式跑完整链路并收集日志 */
function taskDebug(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const dbg = new DebugCollector(getKey(s));
  ctx.debug = dbg;
  session.ctx.debug = dbg;
  const result = { sourceUrl: getKey(s), sourceName: s.bookSourceName, steps: [] };
  const step = (name, fn) => {
    const t0 = Date.now();
    try {
      const r = fn();
      result.steps.push({ name, ok: true, cost: Date.now() - t0 });
      return r;
    } catch (e) {
      result.steps.push({
        name, ok: false, cost: Date.now() - t0,
        error: (e && e.message) || String(e),
        code: (e && e.name) || 'Error',
      });
      return null;
    }
  };

  if (payload.key) {
    const books = step('search', () => (isJs(s) ? JsSource.search(ctx, s, payload.key, 1) : session.search(wrappedOf(s), payload.key, 1, null, null)));
    if (books && books.length) {
      result.bookCount = books.length;
      result.books = books.slice(0, 5).map((b) => ({ name: b.name, author: b.author, bookUrl: b.bookUrl }));
      const book = createBook(books[0].toBook ? books[0].toBook() : books[0]);
      step('bookInfo', () => (isJs(s) ? JsSource.getBookInfo(ctx, s, book, true) : session.bookInfo(wrappedOf(s), book, true)));
      const chapters = step('chapters', () => (isJs(s) ? JsSource.getChapterList(ctx, s, book) : session.chapters(wrappedOf(s), book, true, false)));
      if (chapters && chapters.length) {
        result.chapterCount = chapters.length;
        result.chapters = chapters.slice(0, 5).map((c) => ({ title: c.title, url: c.url }));
        const content = step('content', () => (isJs(s) ? JsSource.getContent(ctx, s, book, chapters[0]) : session.content(wrappedOf(s), book, chapters[0])));
        if (content) result.contentPreview = String(content).slice(0, 800);
      }
      result.book = { name: book.name, author: book.author, intro: book.intro, coverUrl: book.coverUrl, tocUrl: book.tocUrl, kind: book.kind };
    }
  }
  if (payload.exploreUrl) {
    const books = step('explore', () => (isJs(s) ? JsSource.explore(ctx, s, payload.exploreUrl, 1) : session.explore(wrappedOf(s), payload.exploreUrl, 1)));
    if (books) { result.exploreCount = books.length; result.exploreBooks = books.slice(0, 5).map((b) => ({ name: b.name, bookUrl: b.bookUrl })); }
  }
  result.logs = dbg.logs.map((l) => `[${l.state}] ${l.msg}`);
  result.html = dbg.html;
  return result;
}

/**
 * 正文里的 <img src="url,{...option}"> 被点击（legado ReadBookActivity.oldClickImg / clickImg）。
 *
 * legado 语义（ReadBookActivity.kt:1424-1486）：
 *   1) paramPattern = /\s*,\s*(?=\s*\{)/ 切出 url 与 JSON option
 *   2) option.click 存在 → source.evalJS(click)，bindings 里挂
 *      java = SourceLoginJsExtensions（可弹 WebView）、book、chapter、result = 原始 src
 *   3) 没有 click 但有 js → AnalyzeRule(book, source).setBaseUrl(chapter.url).setChapter(chapter)
 *      然后 evalJS(jsStr, urlNoOption)
 * 脚本里的 java.showBrowser(...) 由 js-runtime 收集成 browserActions，回给前端开弹窗。
 */
/**
 * 通用 js 执行入口（legado WebJsExtensions.request("run", [jsCode]) → analyzeRule.evalJS）。
 * 书源生成的 html 里会调 window.qmRun('xxx.call(this,{...})')，等价于在「AnalyzeRule + jsLib」
 * 作用域里 evalJS：java 是 AnalyzeRule 的 java 桥（含 showBrowser / ajax），
 * source / book / chapter / baseUrl / result 与正文规则一致。
 * 返回 value（字符串化）与脚本里 java.showBrowser 收集出来的 actions。
 */
function taskJsRun(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const book = createBook(payload.book || {});
  const chapter = createChapter(payload.chapter || {});
  const services = ctx.services;
  const browserActions = [];
  const wrapped = wrappedOf(s);
  const wrappedBook = wrapBook(book, { cache: services.cache, logger, network: services.network });
  const wrappedChapter = wrapChapter(chapter, { cache: services.cache, logger, network: services.network });
  const pushOpen = (url, html, preloadJs, config, title) => {
    browserActions.push({
      type: 'openUrl', url: str0(url), html: str0(html), preloadJs: str0(preloadJs),
      config: str0(config), title: str0(title),
    });
    return '';
  };
  const java = mixJavaBridge(wrapped, {
    showBrowser: (url, html, preloadJs, config) => pushOpen(url, html, preloadJs, config, null),
    startBrowser: (url, title) => pushOpen(url, null, null, null, title),
    startBrowserAwait: (url, title) => pushOpen(url, null, null, null, title),
    // JsExtensions.openUrl(url, mimeType)（help/JsExtensions.kt:1173）：legado 弹
    // OpenUrlConfirmActivity。桌面端收集成动作，前端非 http(s) 时弹确认框（七猫 QQ 群深链）。
    openUrl(url, mimeType) {
      const u = str0(url);
      if (u) browserActions.push({ type: 'openUrl', url: u, mimeType: str0(mimeType) });
      return '';
    },
    // RssJsExtensions.open(name, url, title, origin)（ui/rss/read/RssJsExtensions.kt:99）：
    // login / sort / rss / search / explore 五个分支，参数原样回给前端分派。
    open(name, url, title, origin) {
      const n = str0(name);
      if (n) browserActions.push({ type: 'open', name: n, url: str0(url), title: str0(title), origin: str0(origin) });
      return '';
    },
    // RssJsExtensions.searchBook(key, searchScope)（RssJsExtensions.kt:74）→ SearchActivity.start。
    // scope 形如 "源名::源key"（七猫/光遇都用这个格式指定只搜某个源）。
    searchBook(key2, searchScope) {
      const k = String(key2 == null ? '' : key2).trim();
      if (!k) return '';
      const scope = str0(searchScope);
      let scopeUrl = null, scopeName = null;
      if (scope && scope.includes('::')) {
        const i = scope.indexOf('::');
        scopeName = scope.slice(0, i);
        scopeUrl = scope.slice(i + 2);
      } else if (scope) scopeName = scope;
      browserActions.push({ type: 'searchBook', key: k, scope, scopeUrl, scopeName });
      return '';
    },
    // BaseSource.refreshExplore()（data/entities/BaseSource.kt:325）：清发现分类缓存后重拉分类
    refreshExplore() {
      browserActions.push({ type: 'refreshExplore' });
      return '';
    },
    toast(msg) { logger('[toast] ' + msg); return ''; },
    longToast(msg) { logger('[longToast] ' + msg); return ''; },
    refreshBookInfo() { return ''; },
    refreshBookToc() { return ''; },
    refreshContent() { return ''; },
  });
  const svcEnv = { cookieStore: services.cookieStore, cache: services.cache, logger, network: services.network };
  try {
    const v = runSourceJs(s, String(payload.code == null ? '' : payload.code), payload.result == null ? null : payload.result, {
      java, book: wrappedBook, chapter: wrappedChapter,
    }, svcEnv);
    let value = '';
    try { value = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { value = String(v); }
    return { ok: true, value, actions: browserActions };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || 'JS_RUN', actions: browserActions };
  }
}

/* ---------------- 登录（SourceLoginDialog / SourceLoginJsExtensions 语义） ---------------- */

/**
 * SourceLoginJsExtensions 的桌面端等价物。
 * legado 里这个类是 @JavascriptInterface：脚本调 java.open("login") / searchBook() /
 * refreshExplore() / upLoginData() 时直接操作 Activity。桌面端把副作用收集成 actions[]，
 * 由前端落地（与 explore.mjs 的 makeActionJava 同一套路）。
 * showBrowser / startBrowser 在 legado 会弹 WebView —— 这里也收集成 openUrl，
 * 由前端交给 browser-host（真实浏览器内核），而不是 iframe（很多站点 CSP 禁止嵌 frame）。
 */
function makeLoginJava(source, wrapped, push, opts = {}) {
  const rowUis = Array.isArray(opts.rowUis) ? opts.rowUis : [];
  // SourceLoginJsExtensions.getLoginData(rowUis) → 当前 UI 上所有非按钮项的取值
  const collectLoginData = () => {
    const map = {};
    for (const it of rowUis) {
      if (!it || it.type === 'button') continue;
      map[it.name] = it.default == null ? '' : String(it.default);
    }
    return map;
  };
  return mixJavaBridge(wrapped, {
    // JsExtensions.openUrl(url, mimeType)（help/JsExtensions.kt:1173）：弹 OpenUrlConfirmActivity。
    // 桌面端收集成 openUrl 动作（normalizeLoginActions 之后由前端开站内浏览器）。
    openUrl(url, mimeType) {
      const u = str0(url);
      if (u) push({ type: 'openUrl', url: u, mimeType: str0(mimeType), sourceUrl: source.bookSourceUrl });
      return '';
    },
    open(name, url, title, origin) {
      const n = String(name == null ? '' : name);
      push({ type: 'open', name: n, url: str0(url), title: str0(title), origin: str0(origin), sourceUrl: source.bookSourceUrl });
      return '';
    },
    searchBook(key2, searchScope) {
      const k = String(key2 == null ? '' : key2).trim();
      let scopeUrl = null, scopeName = null;
      const scope = str0(searchScope);
      if (scope && scope.includes('::')) {
        const i = scope.indexOf('::');
        scopeName = scope.slice(0, i);
        scopeUrl = scope.slice(i + 2);
      } else if (scope) scopeName = scope;
      push({ type: 'searchBook', key: k, scope, scopeUrl, scopeName, sourceUrl: source.bookSourceUrl });
      return '';
    },
    refreshExplore() { push({ type: 'refreshExplore', sourceUrl: source.bookSourceUrl }); return ''; },
    reLoginView() { push({ type: 'reLoginView', sourceUrl: source.bookSourceUrl }); return ''; },
    upLoginData(data) { push({ type: 'upLoginData', data: data || null, sourceUrl: source.bookSourceUrl }); return ''; },
    refreshBookInfo() { push({ type: 'refresh', what: 'bookInfo', sourceUrl: source.bookSourceUrl }); return ''; },
    refreshBookToc() { push({ type: 'refresh', what: 'toc', sourceUrl: source.bookSourceUrl }); return ''; },
    refreshContent() { push({ type: 'refresh', what: 'content', sourceUrl: source.bookSourceUrl }); return ''; },
    copyText(text) { push({ type: 'copyText', text: String(text == null ? '' : text) }); return ''; },
    toast(msg) { push({ type: 'toast', msg: String(msg == null ? '' : msg) }); return ''; },
    longToast(msg) { push({ type: 'toast', msg: String(msg == null ? '' : msg) }); return ''; },
    // WebViewActivity：交给前端用真实内核浏览器打开，并把 cookie 回写 CookieStore
    startBrowser(url2, title2) {
      push({ type: 'startBrowser', url: str0(url2), title: str0(title2), sourceUrl: source.bookSourceUrl });
      return '';
    },
    startBrowserAwait(url2, title2) {
      push({ type: 'startBrowser', url: str0(url2), title: str0(title2), await: true, sourceUrl: source.bookSourceUrl });
      return '';
    },
    showBrowser(url2, html, preloadJs, config) {
      push({ type: 'startBrowser', url: str0(url2), html: str0(html), preloadJs: str0(preloadJs), config: str0(config), sourceUrl: source.bookSourceUrl });
      return '';
    },
    loginData() { return collectLoginData(); },
  });
}

/** 把 actions 里混进来的 startBrowser/openUrl 统一成前端可落地的形态 */
function normalizeLoginActions(actions) {
  const out = [];
  for (const a of actions || []) {
    if (!a) continue;
    if (a.type === 'startBrowser') out.push({ ...a, type: 'openUrl' });
    else out.push(a);
  }
  return out;
}

/**
 * BaseSource.getLoginInfoMap 等价物（含 loginUi 是 @js: 时的求值）。
 * legado：跑 evalJS("$loginJS\n$jsStr")，bindings = {java: sourceLoginJsExtensions, result, book, chapter}
 */
function loginRowUis(s, actions) {
  const raw = s.loginUi;
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw);
  let json = text;
  if (text.startsWith('@js:') || text.startsWith('<js>')) {
    const sub = text.startsWith('@js:') ? text.substring(4) : text.substring(4, text.lastIndexOf('<'));
    const wrapped = wrappedOf(s);
    const java = makeLoginJava(s, wrapped, (a) => actions.push(a));
    const code = (getLoginJsOf(s) || '') + '\n' + sub;
    const svc = { cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger, network: ctx.services.network };
    const v = runSourceJs(s, code, { result: {}, book: null, chapter: null }, { java }, svc);
    json = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
  }
  // legado: GSONStrict 失败后回退 GSON（lenient：单引号/裸键/尾逗号）。
  // 免费看书 / 起点限免的 loginUi 就带裸键，严格 JSON.parse 会解析成 0 行。
  const arr = parseRelaxedJson(json);
  return Array.isArray(arr) ? arr : [];
}

/** BaseSource.getLoginJs（@js: / <js> 剥壳） */
function getLoginJsOf(s) {
  const loginUrl = s.loginUrl;
  if (!loginUrl) return null;
  const x = String(loginUrl);
  if (x.startsWith('@js:')) return x.substring(4);
  if (x.startsWith('<js>')) return x.substring(4, x.lastIndexOf('<'));
  return x;
}

/** RowUi 的 flex 样式 → CSS（legado FlexChildStyle.layout_* 的桌面端映射） */
function rowUiStyle(it) {
  const st = it && it.style;
  if (!st || typeof st !== 'object') return null;
  const out = {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const grow = num(st.layout_flexGrow);
  if (grow != null && grow > 0) out['flex-grow'] = String(grow);
  const basis = num(st.layout_flexBasisPercent);
  if (basis != null && basis > 0) out['flex-basis'] = (basis * 100) + '%';
  const w = num(st.layout_widthPercent);
  if (w != null && w > 0) out.width = (w * 100) + '%';
  const h = num(st.layout_heightPercent);
  if (h != null && h > 0) out.height = (h * 100) + '%';
  const js = st.layout_justifySelf;
  if (js) out['justify-self'] = String(js).toLowerCase() === 'right' ? 'end' : 'start';
  const al = st.layout_alignSelf;
  if (al) out['align-self'] = String(al).toLowerCase();
  const mt = num(st.layout_marginTop);
  if (mt) out['margin-top'] = mt + 'dp';
  const mb = num(st.layout_marginBottom);
  if (mb) out['margin-bottom'] = mb + 'dp';
  return Object.keys(out).length ? out : null;
}

/** GET /api/online/login/info 的 worker 侧（SourceLoginViewModel 初始化） */
function taskLoginInfo(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const actions = [];
  const rowUis = loginRowUis(s, actions);
  const wrapped = wrappedOf(s);
  let loginInfo = null;
  try { loginInfo = wrapped.getLoginInfoMap(); } catch (e) { loginInfo = null; }
  const uis = rowUis.map((it) => ({
    name: it && it.name != null ? String(it.name) : '',
    type: (it && it.type) || 'text',
    action: it && it.action != null ? String(it.action) : null,
    chars: Array.isArray(it && it.chars) ? it.chars.map((c) => (c == null ? null : String(c))) : null,
    default: it && it.default != null ? String(it.default) : null,
    viewName: it && it.viewName != null ? String(it.viewName) : null,
    style: rowUiStyle(it),
  }));
  const headerMap = wrapped.getHeaderMap(true) || {};
  const loginJs = getLoginJsOf(s);
  /**
   * WebViewLoginFragment.loadUrl 只吃 source.loginUrl（BaseSource.getLoginJs）。
   * 但有些源把「登录页地址」误写进 loginUi（饿狼小说：loginUi=http://m.elkoparts.com/login.php），
   * legado 那边 hasLoginForm() 仍为 true → 进表单分支 → GSON.fromJsonArray(url) 解析成 0 行空白表单，
   * 用户既没有输入框也没有 WebView 入口。这里在不动 legado 语义的前提下，把「URL 形态的 loginUi」
   * 也识别成 web 登录入口，交给内置浏览器打开（等价 WebViewLoginFragment 的效果）。
   */
  const loginUiText = s.loginUi == null ? '' : String(s.loginUi).trim();
  const loginWebUrl = isAbsUrlLogin(loginJs) ? loginJs
    : (isAbsUrlLogin(loginUiText) ? loginUiText : null);
  return {
    // BaseSource.getTag() = bookSourceName；SourceLoginDialog:708 / WebViewLoginFragment:50
    // 用它拼 R.string.login_source（"登录 %s"）作为窗口标题
    sourceName: String(s.bookSourceName == null ? '' : s.bookSourceName),
    uis,
    loginInfo: loginInfo || {},
    hasLoginForm: wrapped.hasLoginForm(),
    hasLogin: wrapped.hasLogin(),
    loginUrl: loginJs,
    isAbsUrl: isAbsUrlLogin(loginJs),
    // 内置浏览器（WebViewLoginFragment）可用的登录页地址；loginUrl 非 URL 时回落到 URL 形态的 loginUi
    loginWebUrl,
    headerMap,
    userAgent: headerMap['User-Agent'] || headerMap['user-agent'] || null,
    actions: normalizeLoginActions(actions),
  };
}

/** StringExtensions.isAbsUrl */
function isAbsUrlLogin(v) {
  const s = String(v == null ? '' : v);
  return s.startsWith('http://') || s.startsWith('https://');
}

/**
 * POST /api/online/login/action：SourceLoginDialog.handleButtonClick
 *   action.isAbsUrl() → context.openUrl(action)（交给浏览器打开）
 *   否则 → source.evalJS("$loginJS\n$buttonFunctionJs")
 *          bindings = {java: sourceLoginJsExtensions, result: getLoginData(rowUis), book, chapter, isLongClick}
 */
function taskLoginAction(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const action = String(payload.action == null ? '' : payload.action);
  const actions = [];
  const rowUis = loginRowUis(s, actions);
  const wrapped = wrappedOf(s);

  if (!action.trim()) return { ok: true, actions: normalizeLoginActions(actions) };

  if (isAbsUrlLogin(action)) {
    actions.push({ type: 'openUrl', url: action, title: String(payload.name || ''), sourceUrl: s.bookSourceUrl });
    return { ok: true, actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };
  }

  const java = makeLoginJava(s, wrapped, (a) => actions.push(a), { rowUis: payload.rowUis || rowUis });
  const loginData = {};
  for (const it of rowUis) {
    if (!it || it.type === 'button') continue;
    loginData[it.name] = it.default == null ? '' : String(it.default);
  }
  // SourceLoginDialog：result = getLoginData(adapter.data) —— 前端带回来的当前编辑值优先
  const result = payload.result && typeof payload.result === 'object' ? payload.result : loginData;
  const book = payload.book ? wrapBook(createBook(payload.book), { cache: ctx.services.cache, logger, network: ctx.services.network }) : null;
  const chapter = payload.chapter ? wrapChapter(createChapter(payload.chapter), { cache: ctx.services.cache, logger, network: ctx.services.network }) : null;
  const code = (getLoginJsOf(s) || '') + '\n' + action;
  const svc = { cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger, network: ctx.services.network };
  try {
    const v = runSourceJs(s, code, result, { java, book, chapter, isLongClick: payload.isLongClick === true }, svc);
    let value = '';
    try { value = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { value = String(v); }
    return { ok: true, value, actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };
  }
}

function safeLoginInfo(wrapped) {
  try { return wrapped.getLoginInfoMap() || {}; } catch (e) { return {}; }
}

/**
 * POST /api/online/login：BaseSource.login()
 *   putLoginInfo(GSON.toJson(loginData)) 然后跑 "if (typeof login=='function'){ login.apply(this) }"
 */
function taskLogin(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const actions = [];
  const rowUis = loginRowUis(s, actions);
  const wrapped = wrappedOf(s);

  // 把前端提交的登录数据存进 CookieStore 持久层（legado 先 putLoginInfo 再跑 login）
  let data = payload.loginData;
  if (data && typeof data === 'object') {
    wrapped.putLoginInfo(JSON.stringify(data));
  } else {
    const cur = safeLoginInfo(wrapped);
    if (cur && Object.keys(cur).length) data = cur;
  }

  const loginJs = getLoginJsOf(s);
  if (!loginJs || !String(loginJs).trim()) return { ok: true, value: '', actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };

  const java = makeLoginJava(s, wrapped, (a) => actions.push(a), { rowUis });
  const code = String(loginJs).trim() + "\nif(typeof login=='function'){ login.apply(this); } else { throw('Function login not implements!!!') }";
  const svc = { cookieStore: ctx.services.cookieStore, cache: ctx.services.cache, logger, network: ctx.services.network };
  try {
    const v = runSourceJs(s, code, data && typeof data === 'object' ? data : {}, { java, book: null, chapter: null }, svc);
    let value = '';
    try { value = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { value = String(v); }
    return { ok: true, value, actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), actions: normalizeLoginActions(actions), loginInfo: safeLoginInfo(wrapped) };
  }
}

/** POST /api/online/login/logout：removeLoginInfo + removeLoginHeader + clearCookies */
function taskLoginLogout(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const wrapped = wrappedOf(s);
  try { wrapped.removeLoginInfo(); } catch (e) { /* ignore */ }
  if (payload.clearHeaders !== false) { try { wrapped.removeLoginHeader(); } catch (e) { /* ignore */ } }
  if (payload.clearCookies !== false) {
    try {
      const wrappedAll = ctx.services.cookieStore;
      // legado removeCookie(url)：按 getSubDomain 删
      const key = String(s.bookSourceUrl || '');
      wrappedAll.removeCookie(key);
      if (s.loginUrl && isAbsUrlLogin(s.loginUrl)) wrappedAll.removeCookie(s.loginUrl);
    } catch (e) { /* ignore */ }
  }
  return { ok: true, loginInfo: {} };
}

/** POST /api/online/login/cookie：浏览器宿主把 cookie 回写成 CookieStore.setCookie(source.getKey(), ck) */
function taskLoginCookie(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const cookie = String(payload.cookie == null ? '' : payload.cookie);
  if (cookie) {
    ctx.services.cookieStore.replaceCookie(String(payload.domain || s.bookSourceUrl || ''), cookie);
  }
  const wrapped = wrappedOf(s);
  const data = payload.loginData;
  if (data && typeof data === 'object' && Object.keys(data).length) {
    try { wrapped.putLoginInfo(JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  let header = null;
  try { header = wrapped.getLoginHeaderMap(); } catch (e) { header = null; }
  return {
    ok: true,
    cookie,
    domain: String(payload.domain || ''),
    loginInfo: safeLoginInfo(wrapped),
    hasLoginHeader: !!header,
    headerMap: header || {},
  };
}

/**
 * 跨 worker 状态导出/导入 —— 等价 legado 的 object CookieStore / CacheManager 单例。
 *
 * legado 里这两个是进程内 object，且每次写都 cookieDao/cacheDao 落库，所以「A 协程登录、
 * B 协程读正文」看到的是同一份。桌面端我们把抓取放在 4 个 worker 里，天然变成 4 份副本：
 * 登录只写进了跑 login() 的那个 worker，其余 worker 取正文时 getToken() 读不到 qttoken，
 * 于是站点按匿名放行 —— 表现就是「登录后过一会儿又变回未登录 / 免登录次数超限」。
 *
 * 主线程在每次「写登录态」的任务结束后调用 stateImport 把快照灌给其它 worker。
 */
function taskStateExport() {
  ensureSession();
  const svc = ctx.services;
  return {
    cookie: svc.cookieStore.toArray ? svc.cookieStore.toArray() : [],
    cache: svc.cache.toArray ? svc.cache.toArray() : [],
  };
}

/** 合并式导入：不动 cookies 之外的键，cache 只覆盖 login/变量类 key */
function taskStateImport(payload) {
  ensureSession();
  const svc = ctx.services;
  if (Array.isArray(payload.cookie) && svc.cookieStore.fromArray) svc.cookieStore.fromArray(payload.cookie);
  if (Array.isArray(payload.cache) && svc.cache.fromArray) svc.cache.fromArray(payload.cache);
  // 包装对象缓存里可能留着旧的 loginHeader 快照，直接丢掉重算
  wrappedCache.clear();
  return { cookie: svc.cookieStore.map ? svc.cookieStore.map.size : 0, cache: svc.cache.store ? svc.cache.store.size : 0 };
}

function taskImgClick(payload) {
  const s = getSource(payload.sourceUrl);
  ensureSession();
  const book = createBook(payload.book || {});
  const chapter = createChapter(payload.chapter || {});
  const src = String(payload.src == null ? '' : payload.src);

  const action = parseImgSrc(src);
  if (!action) return { ok: false, error: '图片地址里没有参数（不是可点击图片）', actions: [] };

  const services = ctx.services;
  const browserActions = [];
  const wrapped = wrappedOf(s);
  const wrappedBook = wrapBook(book, { cache: services.cache, logger, network: services.network });
  const wrappedChapter = wrapChapter(chapter, { cache: services.cache, logger, network: services.network });

  // java = SourceLoginJsExtensions（source 级 evalJS）：java === source === sourceApi
  const java = mixJavaBridge(wrapped, {
    showBrowser(url, html, preloadJs, config) {
      browserActions.push({ type: 'openUrl', url: str0(url), html: str0(html), preloadJs: str0(preloadJs), config: str0(config) });
      return '';
    },
    startBrowser(url, title) {
      browserActions.push({ type: 'openUrl', url: str0(url), title: str0(title) });
      return '';
    },
    startBrowserAwait(url, title) {
      browserActions.push({ type: 'openUrl', url: str0(url), title: str0(title), await: true });
      return '';
    },
    openUrl(url, mimeType) {
      const u = str0(url);
      if (u) browserActions.push({ type: 'openUrl', url: u, mimeType: str0(mimeType) });
      return '';
    },
    open(name, url, title, origin) {
      const n = str0(name);
      if (n) browserActions.push({ type: 'open', name: n, url: str0(url), title: str0(title), origin: str0(origin) });
      return '';
    },
    searchBook(key2, searchScope) {
      const k = String(key2 == null ? '' : key2).trim();
      if (!k) return '';
      browserActions.push({ type: 'searchBook', key: k, scope: str0(searchScope) });
      return '';
    },
    refreshExplore() { browserActions.push({ type: 'refreshExplore' }); return ''; },
    toast(msg) { logger('[toast] ' + msg); return ''; },
    longToast(msg) { logger('[longToast] ' + msg); return ''; },
    refreshBookInfo() { return ''; },
    refreshBookToc() { return ''; },
    refreshContent() { return ''; },
  });

  // runSourceJs 内部会构造 bindings（java/source/sourceApi/baseUrl/cookie/cache/result），
  // extra.java 覆盖成上面这个 SourceLoginJsExtensions 等价物，book/chapter 也照 legado 挂进去。
  const svcEnv = { cookieStore: services.cookieStore, cache: services.cache, logger, network: services.network };
  const runEval = (code, result) => runSourceJs(s, code, result, {
    java, book: wrappedBook, chapter: wrappedChapter,
  }, svcEnv);

  try {
    if (action.click) {
      runEval(action.click, src);
    } else if (action.js) {
      // AnalyzeRule(book, source).setBaseUrl(chapter.url).setChapter(chapter).evalJS(jsStr, urlNoOption)
      const rule = createAnalyzeRule({
        ruleData: book, source: s, chapter,
        baseUrl: chapter.url || '',
        logger, services,
        javaExtra: {
          showBrowser(url, html, preloadJs, config) {
            browserActions.push({ type: 'openUrl', url: str0(url), html: str0(html), preloadJs: str0(preloadJs), config: str0(config) });
            return '';
          },
          startBrowser(url, title) {
            browserActions.push({ type: 'openUrl', url: str0(url), title: str0(title) });
            return '';
          },
          startBrowserAwait(url, title) {
            browserActions.push({ type: 'openUrl', url: str0(url), title: str0(title), await: true });
            return '';
          },
          openUrl(url, mimeType) {
            const u = str0(url);
            if (u) browserActions.push({ type: 'openUrl', url: u, mimeType: str0(mimeType) });
            return '';
          },
          open(name, url, title, origin) {
            const n = str0(name);
            if (n) browserActions.push({ type: 'open', name: n, url: str0(url), title: str0(title), origin: str0(origin) });
            return '';
          },
          searchBook(key2, searchScope) {
            const k = String(key2 == null ? '' : key2).trim();
            if (!k) return '';
            browserActions.push({ type: 'searchBook', key: k, scope: str0(searchScope) });
            return '';
          },
          refreshExplore() { browserActions.push({ type: 'refreshExplore' }); return ''; },
        },
      });
      rule.setChapter(chapter);
      rule.jsEval(action.js, action.url);
    } else {
      return { ok: false, error: '图片参数里没有 click / js', actions: [], parsed: action };
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || 'IMG_CLICK', actions: browserActions, parsed: action };
  }
  return { ok: true, actions: browserActions, parsed: action };
}

/**
 * legado 的 Gson/JS 解析允许书源使用全角结构标点。
 * 只在图片参数外面归一化，引号内的中文（，：（））必须原样保留。
 */
function normalizeImageOptionText(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  let quote = '';
  let escaped = false;
  for (const c of s) {
    if (quote) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { out += c; escaped = true; continue; }
      if ((quote === '"' && (c === '"' || c === '＂')) || (quote === "'" && (c === "'" || c === '＇'))) {
        out += quote; quote = ''; continue;
      }
      out += c; continue;
    }
    if (c === '"' || c === '＂') { quote = '"'; out += '"'; continue; }
    if (c === "'" || c === '＇') { quote = "'"; out += "'"; continue; }
    if (c === '，') { out += ','; continue; }
    if (c === '：') { out += ':'; continue; }
    out += c;
  }
  return out;
}

/** 只改 action 代码中字符串外的全角括号/分隔符。 */
function normalizeActionCode(code) {
  const s = String(code == null ? '' : code);
  let out = '';
  let quote = '';
  let escaped = false;
  for (const c of s) {
    if (quote) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { out += c; escaped = true; continue; }
      if (c === quote) { out += c; quote = ''; continue; }
      out += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '（') { out += '('; continue; }
    if (c === '）') { out += ')'; continue; }
    if (c === '，') { out += ','; continue; }
    if (c === '：') { out += ':'; continue; }
    out += c;
  }
  return out;
}

/** 与 html-format.mjs / TextChapterLayout 一致的切分，兼容七猫的 ,【...】。 */
function parseImgSrc(src) {
  const m = /\s*,\s*(?=\s*(?:\{|【))/.exec(src);
  if (!m) return null;
  const url = src.substring(0, m.index);
  const rawOption = src.substring(m.index + m[0].length);
  const trimmedOption = rawOption.trim();
  const rawOptStr = trimmedOption.startsWith('【') && trimmedOption.endsWith('】')
    ? '{' + trimmedOption.slice(1, -1) + '}'
    : rawOption;
  const optStr = normalizeImageOptionText(rawOptStr);
  // legado: 图片参数走 GSONStrict -> GSON 回退，书源里常见 {'click':"..."} 单引号写法。
  const opt = parseRelaxedJson(optStr);
  if (!opt || typeof opt !== 'object') return { url, option: opt, click: null, js: null, optStr, rawOption };
  return {
    url,
    option: opt,
    click: opt.click == null ? null : normalizeActionCode(String(opt.click)),
    js: opt.js == null ? null : normalizeActionCode(String(opt.js)),
    style: opt.style == null ? null : String(opt.style),
    width: opt.width == null ? null : String(opt.width),
    optStr,
    rawOption,
  };
}

function str0(v) { return v === null || v === undefined ? null : String(v); }

/* ======================= 跨线程序列化 ======================= */
// worker 回包必须是结构化可克隆的：实体上挂着 toBook()/putVariable() 这类函数、
// variableMap 这类对象、origins 这类 Set，直接 postMessage 会抛 DataCloneError。
// 这里在边界统一拍平：函数丢弃，Set → 数组，Map → 对象，带环保护。
function sanitize(v, seen = new WeakSet(), depth = 0) {
  if (v === null || v === undefined) return undefined;
  const t = typeof v;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : 0;
  if (t === 'bigint') return Number(v);
  if (depth > 8) return undefined;
  if (v instanceof Date) return v.getTime();
  if (ArrayBuffer.isView(v)) return undefined;
  if (v instanceof Set) return [...v].map((x) => sanitize(x, seen, depth + 1)).filter((x) => x !== undefined);
  if (v instanceof Map) {
    const o = {};
    for (const [k, val] of v) { const s = sanitize(val, seen, depth + 1); if (s !== undefined) o[String(k)] = s; }
    return o;
  }
  if (Array.isArray(v)) return v.map((x) => sanitize(x, seen, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    if (seen.has(v)) return undefined;
    seen.add(v);
    const o = {};
    for (const k of Object.keys(v)) {
      const s = sanitize(v[k], seen, depth + 1);
      if (s !== undefined) o[k] = s;
    }
    return o;
  }
  return undefined;
}

/* ============================ 消息分发 ============================ */

const handlers = {
  ping: () => ({ pong: true, sources: sources.size }),
  init: (p) => {
    if (typeof p.slots === 'number') configureNet(p.slots);
    const n = loadSources(p.sources);
    ensureSession();
    return { sources: n };
  },
  setSources: (p) => ({ sources: loadSources(p.sources) }),
  search: taskSearch,
  explore: taskExplore,
  exploreKinds: taskExploreKinds,
  exploreAction: taskExploreAction,
  exploreUiJs: taskExploreUiJs,
  bookInfo: taskBookInfo,
  chapters: taskChapters,
  content: taskContent,
  imgClick: taskImgClick,
  jsRun: taskJsRun,
  loginInfo: taskLoginInfo,
  loginAction: taskLoginAction,
  login: taskLogin,
  loginLogout: taskLoginLogout,
  loginCookie: taskLoginCookie,
  stateExport: taskStateExport,
  stateImport: taskStateImport,
  preciseSearch: taskPreciseSearch,
  debug: taskDebug,
  verifySubmit: (p) => ({ ok: setResult(p.sourceKey, p.result, p.url) }),
  verifyList: () => ({ pending: listPending() }),
  verifyClear: (p) => { resetVerification(); return { ok: true }; },
  clearCache: () => { contentCache.clear(); return { ok: true }; },
  // 发现分类缓存是 worker 模块级状态，主线程清不了别人的，需要广播到每个 worker
  exploreClearCache: (p) => {
    const s = sources.get(String((p && p.sourceUrl) || ''));
    if (s) clearExploreKindsCache(s);
    else exploreCacheClearAll();
    return { ok: true };
  },
  shutdown: () => { try { shutdownNet(); } catch (e) { /* noop */ } return { ok: true }; },
};

/** 登录态写计数之和 —— 任意任务跑完后只要变大，就说明本 worker 改了 cookie/登录变量 */
function stateDirtySum() {
  try {
    const svc = ctx && ctx.services;
    return (svc.cookieStore.dirty || 0) + (svc.cache.dirty || 0);
  } catch (e) { return 0; }
}

parentPort.on('message', (msg) => {
  const id = msg && msg.id;
  const type = msg && msg.type;
  const payload = (msg && msg.payload) || {};
  let out;
  const dirtyBefore = stateDirtySum();
  try {
    const fn = handlers[type];
    if (!fn) throw new Error(`未知任务类型: ${type}`);
    out = { id, ok: true, result: sanitize(fn(payload)) };
  } catch (e) {
    out = { id, ...toError(e) };
  }
  try {
    // 任务期间写过登录态（站点 set-cookie / source.put / putLoginInfo…）就带一份快照回主线程。
    // legado 里这些写直接落在 object 单例上，所有协程立即可见；多 worker 下必须显式广播。
    if (stateDirtySum() > dirtyBefore && type !== 'stateImport') {
      try {
        const svc = ctx.services;
        out.state = { cookie: svc.cookieStore.toArray(), cache: svc.cache.toArray() };
      } catch (e) { /* ignore */ }
    }
    out.logs = logs.slice(-80);
    parentPort.postMessage(out);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: `回包序列化失败: ${(e && e.message) || e}`, code: 'SERIALIZE' });
  }
});

// 启动即初始化（workerData 里可带初始书源）
if (workerData && workerData.sources) {
  try {
    if (typeof workerData.slots === 'number') configureNet(workerData.slots);
    loadSources(workerData.sources);
    ensureSession();
  } catch (e) { /* 等 init 消息 */ }
}
