// rule-engine.mjs —— 把 AnalyzeRule / AnalyzeUrl / JsRuntime / 网络层装配起来
// 提供 createAnalyzeRule()：规则引擎实例（含 java.* 桥接，与 legado 行为一致）
import { AnalyzeRule, WebJsUnsupportedError } from './analyze-rule.mjs';
import { AnalyzeUrl } from './analyze-url.mjs';
import { JsRuntime, JavaBridgeBase, CookieStore, CacheManager, escapeHtml, unescapeHtml4, JsURL } from './js-runtime.mjs';
import { toStrResponse, mixJavaBridge, makeJavaBridge, getAllMethodNames, makeStrResponse } from './java-bridge.mjs';
import { wrapSource, wrapBook, wrapChapter, wrapNetwork } from './wrap.mjs';
import { getSubDomain } from './net-utils.mjs';
import { DEFAULT_UA } from './http-core.mjs';

/** 全局共享的 cookie / cache（对应 legado 的 CookieStore / CacheManager 单例） */
export const globalCookieStore = new CookieStore();
export const globalCache = new CacheManager(new Map());

/* ---------------- JS 运行时（按 source 复用 context） ---------------- */
const jsRuntime = new JsRuntime();

/** 由 rule-engine 构造的完整服务集合 */
export function makeServices(logger = null, opts = {}) {
  const cookieStore = opts.cookieStore || globalCookieStore;
  const cache = opts.cache || globalCache;
  const network = new JsNetwork({ cookieStore, cache, logger });
  return { cookieStore, cache, logger, network };
}

export function defaultServices(logger = null) { return makeServices(logger); }

/* ---------------- 网络层 ---------------- */

export class JsNetwork {
  constructor({ cookieStore = globalCookieStore, cache = globalCache, logger = null } = {}) {
    this.cookieStore = cookieStore;
    this.cache = cache;
    this.logger = logger;
  }

  _env(source) {
    return {
      cookieStore: this.cookieStore,
      cache: this.cache,
      logger: this.logger,
      network: this,
      evalJs: (code, result, extra) => runSourceJs(source, code, result, extra, this._env(source)),
    };
  }

  _mk(url, source, extra = {}) {
    return new AnalyzeUrl(url, {
      source, cookieStore: this.cookieStore, cache: this.cache, logger: this.logger,
      services: this._env(source),
      ...extra,
    });
  }

  ajax(url, callTimeout, source) {
    const urlStr = Array.isArray(url) ? String(url[0]) : String(url);
    const au = this._mk(urlStr, source, {
      callTimeout: callTimeout ?? null,
      jsEval: this._mkJsEval(source),
    });
    try {
      const r = au.getStrResponse();
      return r.body;
    } catch (e) {
      if (this.logger) this.logger(`ajax(${urlStr}) error ${e && e.message}`);
      return String((e && e.stack) || e);
    }
  }

  connect(urlStr, header, callTimeout, source) {
    let headerMapF = null;
    if (header) {
      try { headerMapF = typeof header === 'string' ? JSON.parse(header) : header; } catch (e) { headerMapF = null; }
    }
    const au = this._mk(urlStr, source, {
      callTimeout: callTimeout ?? null, headerMapF, jsEval: this._mkJsEval(source),
    });
    try { return toStrResponse(au.getStrResponse()); } catch (e) { return this._errResponse(au, e); }
  }

  get(urlStr, headers, timeout, source) { return this.connect(urlStr, headers, timeout, source); }

  post(urlStr, body, headers, timeout, source) {
    let headerMapF = null;
    if (headers) {
      try { headerMapF = typeof headers === 'string' ? JSON.parse(headers) : headers; } catch (e) { headerMapF = null; }
    }
    const au = new AnalyzeUrl(urlStr, {
      source, cookieStore: this.cookieStore, cache: this.cache, logger: this.logger,
      headerMapF, callTimeout: timeout ?? null, jsEval: this._mkJsEval(source),
      services: this._env(source),
    });
    au.method = 'POST';
    au.body = body === null || body === undefined ? '' : String(body);
    au.urlNoQuery = au.url;
    if (au.body) {
      const ct = headerGetCI(au.headerMap, 'Content-Type');
      if (!ct) au.analyzeFields(au.body);
    }
    try { return toStrResponse(au.getStrResponse()); } catch (e) { return this._errResponse(au, e); }
  }

  head(urlStr, headers, timeout, source) {
    let headerMapF = null;
    if (headers) {
      try { headerMapF = typeof headers === 'string' ? JSON.parse(headers) : headers; } catch (e) { headerMapF = null; }
    }
    const au = new AnalyzeUrl(urlStr, {
      source, cookieStore: this.cookieStore, cache: this.cache, logger: this.logger,
      headerMapF, callTimeout: timeout ?? null, jsEval: this._mkJsEval(source),
      services: this._env(source),
    });
    au.method = 'HEAD';
    au.urlNoQuery = au.url;
    try { return toStrResponse(au.getStrResponse()); } catch (e) { return this._errResponse(au, e); }
  }

  async ajaxAll(urlList, skipRateLimit, source) {
    const list = Array.isArray(urlList) ? urlList : [urlList];
    const out = [];
    for (const u of list) {
      const au = this._mk(String(u), source, { jsEval: this._mkJsEval(source) });
      try { out.push(toStrResponse(au.getStrResponse({ skipRateLimit }))); }
      catch (e) { out.push(this._errResponse(au, e)); }
    }
    return out;
  }

  _mkJsEval(source) {
    return (code, result, extra) => runSourceJs(source, code, result, extra, this._env(source));
  }

  _errResponse(au, e) {
    return toStrResponse({
      url: au.url, body: String((e && e.stack) || e), code: 500, headers: {}, callTime: 0,
      message: e && e.message,
    });
  }
}

function headerGetCI(map, key) {
  if (map instanceof Map) {
    for (const [k, v] of map) if (k.toLowerCase() === key.toLowerCase()) return v;
    return null;
  }
  const lk = key.toLowerCase();
  for (const k of Object.keys(map || {})) if (k.toLowerCase() === lk) return map[k];
  return null;
}

/* ---------------- source 级 JS ---------------- */

/** 执行 source 级 JS（jsLib / header / loginUrl 等；java=source, baseUrl=key） */
export function runSourceJs(source, code, result, extra = {}, svc = {}) {
  const { cookieStore = globalCookieStore, cache = globalCache, logger = null, network = null } = svc || {};
  const env = {
    cookieStore, cache, logger, network,
    defaultUA: DEFAULT_UA,
    evalJs: (c, r, ex) => runSourceJs(source, c, r, ex, svc),
  };
  const wsrc = wrapSource(source, env);
  const java = wrapSource(source, env);   // 同一个对象（WeakMap 缓存）
  const bindings = {
    java,
    source: wsrc,
    sourceApi: wsrc,
    baseUrl: source ? String(source.bookSourceUrl || '') : '',
    cookie: cookieStore,
    cache,
    result,
    ...extra,
    java: (extra && extra.java) || java,
  };
  const key = source ? (source.bookSourceUrl || 'source') : 'anonymous';
  return jsRuntime.run(String(code), bindings, { key, jsLib: source ? source.jsLib : null });
}

/* ---------------- 规则级 JS（java = AnalyzeRule） ---------------- */

/** 执行规则级 JS（java=AnalyzeRule 实例） */
export function runRuleJs(analyzeRule, code, result, extra = {}) {
  const svc = analyzeRule._svc || {};
  const bindings = {
    java: analyzeRule._java,
    cookie: svc.cookieStore || globalCookieStore,
    cache: svc.cache || globalCache,
    source: analyzeRule._wrappedSource || analyzeRule.source,
    book: analyzeRule._wrappedBook || analyzeRule.ruleData,
    result,
    baseUrl: analyzeRule.baseUrl,
    chapter: analyzeRule._wrappedChapter || analyzeRule.chapter,
    title: analyzeRule.chapter ? analyzeRule.chapter.title : null,
    src: analyzeRule.content,
    nextChapterUrl: analyzeRule.nextChapterUrl,
    rssArticle: null,
    fromBookInfo: analyzeRule.isFromBookInfo,
    ...extra,
  };
  const key = analyzeRule.source ? (analyzeRule.source.bookSourceUrl || 'source') : 'anonymous';
  return jsRuntime.run(String(code), bindings, { key, jsLib: analyzeRule.source ? analyzeRule.source.jsLib : null });
}

/* ---------------- 工厂 ---------------- */

/**
 * 创建规则引擎（java = AnalyzeRule 语义）
 * @param {object} opts {source, ruleData, chapter, baseUrl, isFromBookInfo, logger, services, javaExtra, callbacks}
 *   callbacks: { reGetBook(), refreshTocUrl() }
 */
export function createAnalyzeRule(opts = {}) {
  const services = opts.services || makeServices(opts.logger || null);
  const env = {
    cookieStore: services.cookieStore,
    cache: services.cache,
    logger: opts.logger || services.logger || null,
    network: services.network,
  };
  const logger = env.logger;
  env.evalJs = (code, result, extra) => runSourceJs(opts.source ?? null, code, result, extra,
    { ...env, defaultUA: DEFAULT_UA });

  const rule = new AnalyzeRule(opts.ruleData ?? null, opts.source ?? null, { logger });
  rule.isFromBookInfo = opts.isFromBookInfo === true;
  rule.chapter = opts.chapter ?? null;
  if (opts.baseUrl) rule.baseUrl = opts.baseUrl;
  rule._svc = services;
  rule._env = env;
  rule._wrappedSource = wrapSource(opts.source ?? null, { ...env, defaultUA: DEFAULT_UA });
  rule._wrappedBook = wrapBook(opts.ruleData ?? null, env);
  rule._wrappedChapter = wrapChapter(opts.chapter ?? null, env);

  const cb = opts.callbacks || {};
  // browserActions：legado 的 java.showBrowser/startBrowser 在 Android 里弹 WebView，
  // 桌面端改为收集动作回给前端开弹窗（见 book-worker.taskJsRun 的同款做法）。
  const browserActions = Array.isArray(opts.browserActions) ? opts.browserActions : null;
  const javaBase = new JavaBridgeBase({
    source: opts.source ?? null,
    cookieStore: services.cookieStore,
    cache: services.cache,
    logger,
    network: wrapNetwork(services.network, opts.source ?? null),
    browserActions,
  });

  const java = mixJavaBridge(javaBase, {
    getString: (ruleStr, content) => (content === undefined || content === null
      ? rule.getString(ruleStr)
      : rule.getString(ruleStr, content)),
    getStringList: (ruleStr, content, isUrl) => (content === undefined || content === null
      ? rule.getStringList(ruleStr, undefined, isUrl === true)
      : rule.getStringList(ruleStr, content, isUrl === true)),
    getElement: (ruleStr) => rule.getElement(ruleStr),
    getElements: (ruleStr) => rule.getElements(ruleStr),
    put: (k, v) => rule.put(k, v),
    get: (k) => rule.get(k),
    getSource: () => rule._wrappedSource,
    getTag: () => (opts.source ? opts.source.bookSourceName || '' : ''),
    getVariable: () => rule._wrappedSource?.getVariable?.() ?? '',
    setVariable: (v) => rule._wrappedSource?.setVariable?.(v),
    putVariable: (v) => rule._wrappedSource?.putVariable?.(v),
    reGetBook: () => (cb.reGetBook ? cb.reGetBook() : undefined),
    refreshTocUrl: () => (cb.refreshTocUrl ? cb.refreshTocUrl() : undefined),
    ...(opts.javaExtra || {}),
  });
  rule._java = java;
  rule.jsEval = (code, result) => runRuleJs(rule, code, result);
  return rule;
}

/** 创建一个 AnalyzeUrl（供 book-source 层使用） */
export function createAnalyzeUrl(url, opts = {}) {
  const services = opts.services || makeServices(opts.logger || null);
  const source = opts.source ?? null;
  const env = {
    cookieStore: services.cookieStore,
    cache: services.cache,
    logger: opts.logger || services.logger || null,
    network: services.network,
    defaultUA: DEFAULT_UA,
  };
  env.evalJs = (code, result, extra) => runSourceJs(source, code, result, extra, env);
  return new AnalyzeUrl(url, {
    key: opts.key ?? null,
    page: opts.page ?? null,
    baseUrl: opts.baseUrl ?? '',
    source,
    ruleData: opts.ruleData ?? null,
    chapter: opts.chapter ?? null,
    infoMap: opts.infoMap ?? null,
    headerMapF: opts.headerMapF ?? null,
    hasLoginHeader: opts.hasLoginHeader !== false,
    readTimeout: opts.readTimeout ?? null,
    callTimeout: opts.callTimeout ?? null,
    browserActions: Array.isArray(opts.browserActions) ? opts.browserActions : null,
    cookieStore: services.cookieStore,
    cache: services.cache,
    logger: opts.logger || null,
    services: env,
    jsEval: (code, result, extra) => runSourceJs(source, code, result, extra, env),
  });
}

export {
  AnalyzeRule, AnalyzeUrl, WebJsUnsupportedError, JsRuntime, CookieStore, CacheManager,
  escapeHtml, unescapeHtml4, JsURL, getSubDomain, makeJavaBridge, makeStrResponse,
  toStrResponse, mixJavaBridge, getAllMethodNames, wrapSource, wrapBook, wrapChapter, wrapNetwork,
  jsRuntime,
};
