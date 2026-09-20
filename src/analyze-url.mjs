// analyze-url.mjs —— 1:1 移植自 legado io.legado.app.model.analyzeRule.AnalyzeUrl
// 负责：@js / <js> 处理 → {{js}} 内嵌 → <page> 替换 → UrlOption 解析
//        → query/form 编码 → 发起请求（同步桥）→ bodyJs / type 处理
import { RuleAnalyzer } from './rule-analyzer.mjs';
import {
  getAbsoluteURL, getBaseUrl, getSubDomain, encodeParams, encodedQuery as isEncodedQuery,
  isJson, isJsonObject, isJsonArray, isXml, parseRelaxedJson,
} from './net-utils.mjs';
import { requestSync } from './sync-net.mjs';
import { DEFAULT_UA } from './http-core.mjs';
import { getConcurrentLimiter } from './rate-limiter.mjs';
import { makeJavaBridge, toStrResponse } from './java-bridge.mjs';
import { wrapSource, wrapNetwork } from './wrap.mjs';

const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const PARAM_PATTERN = /\s*,\s*(?=\s*\{)/;
const PAGE_PATTERN = /<(.*?)>/;
const XML_CONTENT_TYPE = /^(application|text)\/\w*\+?xml/i;

const REQUEST_METHOD = { GET: 'GET', POST: 'POST', HEAD: 'HEAD' };

// ---- AnalyzeUrlNetworkOptions.kt ----
export function parseRequestTimeoutMillis(value) {
  let t = null;
  if (typeof value === 'number') t = Number.isFinite(value) && value % 1 === 0 ? value : null;
  else if (typeof value === 'string') {
    const s = value.trim();
    t = /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
  }
  if (t === null) return null;
  return t >= 1 && t <= 2147483647 ? t : null;
}

export function parseBooleanOption(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 0) return false;
    if (value === 1) return true;
    return null;
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return null;
  }
  return null;
}

export function shouldReturnRedirectBeforeWebView(followRedirects, responseCode) {
  return followRedirects === false && responseCode >= 300 && responseCode <= 399;
}

export function derivedCallTimeoutMillis(readTimeoutMillis) {
  const doubled = readTimeoutMillis > 2147483647 / 2 ? 2147483647 : readTimeoutMillis * 2;
  return Math.max(60000, doubled);
}

function blank(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }

/** UrlOption（AnalyzeUrl.kt 内部类） */
export class UrlOption {
  constructor(raw = {}) {
    this.raw = raw;
  }

  _get(...keys) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(this.raw, k)) return this.raw[k];
    }
    return undefined;
  }

  getMethod() {
    const v = this._get('method');
    return blank(v) ? null : String(v);
  }

  getCharset() {
    const v = this._get('charset', 'encoding');
    return blank(v) ? null : String(v);
  }

  getHeaderMap() {
    const value = this._get('headerMap', 'headers', 'header');
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      if (blank(value)) return null;
      try { return JSON.parse(value); } catch (e) { return null; }
    }
    return null;
  }

  getBody() {
    const v = this._get('body');
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (blank(v)) return null;
      if (isJsonObject(v) || isJsonArray(v)) {
        try { return JSON.stringify(JSON.parse(v)); } catch (e) { return v; }
      }
      return v;
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  getType() {
    const v = this._get('type');
    return blank(v) ? null : String(v);
  }

  getRetry() {
    const v = this._get('retry');
    if (v === null || v === undefined || v === '') return 0;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : 0;
  }

  useWebView() {
    const v = this._get('webView');
    if (v === null || v === undefined || v === '' || v === false || v === 'false') return false;
    return true;
  }

  getWebJs() {
    const v = this._get('webJs');
    return blank(v) ? null : String(v);
  }

  getTimeout() {
    return parseRequestTimeoutMillis(this._get('timeout'));
  }

  getFollowRedirects() {
    return parseBooleanOption(this._get('followRedirects'));
  }

  getDnsIp() {
    const v = this._get('dnsIp');
    return blank(v) ? null : String(v).trim();
  }

  getJs() {
    const v = this._get('js');
    return blank(v) ? null : String(v);
  }

  getBodyJs() {
    const v = this._get('bodyJs');
    return blank(v) ? null : String(v);
  }

  getServerID() {
    const v = this._get('serverID');
    if (blank(v)) return null;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  }

  getWebViewDelayTime() {
    const v = this._get('webViewDelayTime');
    if (blank(v)) return null;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  }

  getOrigin() {
    const v = this._get('origin');
    return blank(v) ? null : String(v);
  }
}

export class AnalyzeUrl {
  /**
   * @param {string} mUrl
   * @param {object} opts {key,page,baseUrl,source,ruleData,chapter,readTimeout,callTimeout,
   *                       headerMapF,hasLoginHeader,infoMap,jsEval,cookieStore,cache,logger}
   */
  constructor(mUrl, opts = {}) {
    this.mUrl = String(mUrl);
    this.key = opts.key ?? null;
    this.page = opts.page ?? null;
    this.baseUrl = opts.baseUrl ?? '';
    this.source = opts.source ?? null;
    this.ruleData = opts.ruleData ?? null;
    this.chapter = opts.chapter ?? null;
    this.infoMap = opts.infoMap ?? null;
    this.jsEval = opts.jsEval ?? null; // (jsStr, result, extraBindings) => any
    this._env = opts.services ?? null;
    if (this._env && !this._env.wrappedSource && this.source) {
      this._env = { ...this._env, wrappedSource: wrapSource(this.source, this._env) };
    }
    this.cookieStore = opts.cookieStore ?? null;
    this.cache = opts.cache ?? null;
    this.logger = opts.logger ?? null;
    // legado 里 java.showBrowser/startBrowser 会真的弹 Android WebView；桌面端没有内嵌
    // WebView，改为把「要打开的窗口」收集成动作回给前端落地（同 book-worker.taskJsRun）。
    this.browserActions = Array.isArray(opts.browserActions) ? opts.browserActions : null;

    this.ruleUrl = '';
    this.url = '';
    this.urlNoQuery = '';
    this.type = null;
    this.headerMap = new Map();
    this.body = null;
    this.encodedForm = null;
    this.encodedQuery = null;
    this.charset = null;
    this.method = 'GET';
    this.proxy = null;
    this.readTimeoutMs = opts.readTimeout ?? null;
    this.callTimeoutMs = opts.callTimeout ?? null;
    this.urlTimeoutConfigured = false;
    this.followRedirects = null;
    this.retry = 0;
    this.useWebView = false;
    this.webJs = null;
    this.bodyJs = null;
    this.dnsIp = null;
    this.enabledCookieJar = this.source ? this.source.enabledCookieJar === true : false;
    this.serverID = null;
    this.webViewDelayTime = 0;
    this.domain = null;
    this.response = null;

    // java 桥接（AnalyzeUrl 语义）：必须在 initUrl() 之前构造，因为头规则里可能 evalJS
    this.javaBridge = makeJavaBridge({
      source: this.source,
      cookieStore: this.cookieStore,
      cache: this.cache,
      logger: this.logger,
      browserActions: this.browserActions,
      // legado JsExtensions.ajax()：AnalyzeUrl(urlStr, source = getSource(), ...)
      // —— java.ajax 必须带书源 header 发起，否则会被反爬/防火墙挡回（全本小说 apap.net
      // 的 searchUrl 用 java.ajax(source.key) 取首页表单 action，裸网络层会拿到宝塔防火墙页）。
      network: this._env ? wrapNetwork(this._env.network, this.source) : null,
      overrides: {
        getSource: () => (this.source ? (this._env && this._env.wrappedSource) || this.source : null),
        getTag: () => (this.source ? this.source.bookSourceName || '' : ''),
        put: (k, v) => this.put(k, v),
        get: (k) => this.get(k),
        initUrl: () => {
          this.headerMap.clear();
          const hm = this._sourceHeaderMap(true);
          if (hm) for (const [k, v] of Object.entries(hm)) this.headerMap.set(k, v);
          this.initUrl();
        },
        getStrResponse: () => toStrResponse(this.getStrResponse()),
        getStrResponseAwait: () => toStrResponse(this.getStrResponse()),
        getErrStrResponse: (t) => toStrResponse(this.getErrStrResponseObj(t)),
        getUrl: () => this.getUrl(),
        getUrlNoQuery: () => this.getUrlNoQuery(),
        getHeaderMapObj: () => this.getHeaderMapObj(),
        isPost: () => this.isPost(),
        getUserAgent: () => this.getUserAgent(),
        getRuleUrl: () => this.ruleUrl,
        setUrl: (u) => { this.ruleUrl = String(u); },
        getPage: () => this.page,
        getKey: () => this.key,
      },
    });
    Object.defineProperty(this.javaBridge, 'ruleUrl', {
      get: () => this.ruleUrl, configurable: true, enumerable: true,
    });
    Object.defineProperty(this.javaBridge, 'url', {
      get: () => this.url, configurable: true, enumerable: true,
    });

    // init {}
    let baseUrl = this.baseUrl;
    const bm = PARAM_PATTERN.exec(baseUrl || '');
    if (bm) baseUrl = String(baseUrl).substring(0, bm.index);
    this.baseUrl = baseUrl;

    let headerMapF = opts.headerMapF;
    if (!headerMapF) {
      headerMapF = this._sourceHeaderMap(opts.hasLoginHeader !== false);
    }
    if (headerMapF) {
      for (const [k, v] of Object.entries(headerMapF)) this.headerMap.set(k, v);
      if (Object.prototype.hasOwnProperty.call(headerMapF, 'proxy')) {
        this.proxy = headerMapF.proxy;
        this.headerMap.delete('proxy');
      }
    }
    this.initUrl();
    this.domain = getSubDomain(this.source ? this.source.bookSourceUrl : this.url);
    this._limiter = getConcurrentLimiter(this.source);
  }

  _log(msg) { if (this.logger) this.logger(msg); }

  // BaseSource.getHeaderMap
  _sourceHeaderMap(hasLoginHeader) {
    const src = this.source;
    if (!src) return null;
    const out = {};
    const header = src.header;
    if (header) {
      try {
        let json = header;
        if (/^@js:/i.test(header)) json = String(this._sourceEvalJS(header.substring(4)) ?? '');
        else if (/^<js>/i.test(header)) json = String(this._sourceEvalJS(header.substring(4, header.lastIndexOf('<'))) ?? '');
        // 同 wrap.mjs：legado GSONStrict 失败后回退 lenient。
        const map = parseRelaxedJson(json);
        if (map && typeof map === 'object') {
          for (const [k, v] of Object.entries(map)) out[k] = String(v);
        }
      } catch (e) {
        this._log(`执行请求头规则出错 ${e && e.message}`);
      }
    }
    if (!hasKeyCI(out, 'User-Agent')) out['User-Agent'] = DEFAULT_UA;
    if (hasLoginHeader && src.getLoginHeaderMap) {
      const login = src.getLoginHeaderMap();
      if (login) for (const [k, v] of Object.entries(login)) out[k] = v;
    }
    return out;
  }

  _sourceEvalJS(code) {
    if (!this.jsEval) return '';
    const src = this._env && this._env.wrappedSource ? this._env.wrappedSource : this.source;
    return this.jsEval(code, null, { source: src, sourceApi: src, java: src, baseUrl: src ? src.getKey?.() ?? '' : '' });
  }

  getSource() { return this.source; }
  getTag() { return this.source ? (this.source.bookSourceName || '') : ''; }

  initUrl() {
    this.ruleUrl = this.mUrl;
    this.analyzeJs();
    this.replaceKeyPageJs();
    this.analyzeUrl();
  }

  analyzeJs() {
    let start = 0;
    let result = this.ruleUrl;
    const re = new RegExp(JS_PATTERN.source, 'gi');
    let m;
    while ((m = re.exec(this.ruleUrl)) !== null) {
      if (m.index > start) {
        const seg = this.ruleUrl.substring(start, m.index).trim();
        if (seg !== '') result = seg.replace('@result', result);
      }
      const js = m[2] !== undefined ? m[2] : m[1];
      const ev = this.evalJS(js, result);
      result = ev === null || ev === undefined ? '' : String(ev);
      start = m.index + m[0].length;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (this.ruleUrl.length > start) {
      const seg = this.ruleUrl.substring(start).trim();
      if (seg !== '') result = seg.replace('@result', result);
    }
    this.ruleUrl = result;
  }

  replaceKeyPageJs() {
    if (this.ruleUrl.includes('{{') && this.ruleUrl.includes('}}')) {
      const analyze = new RuleAnalyzer(this.ruleUrl);
      const url = analyze.innerRule('{{', '}}', (it) => {
        const jsEval = this.evalJS(it);
        if (jsEval === null || jsEval === undefined) return '';
        if (typeof jsEval === 'string') return jsEval;
        if (typeof jsEval === 'number' && Number.isInteger(jsEval)) return jsEval.toFixed(0);
        return String(jsEval);
      });
      if (url && url !== '') this.ruleUrl = url;
    }
    if (this.page !== null && this.page !== undefined) {
      const re = new RegExp(PAGE_PATTERN.source, 'g');
      let m;
      let guard = 0;
      while ((m = re.exec(this.ruleUrl)) !== null && guard++ < 200) {
        const pages = m[1].split(',');
        const pick = this.page < pages.length ? pages[this.page - 1] : pages[pages.length - 1];
        this.ruleUrl = this.ruleUrl.split(m[0]).join(pick.trim());
        re.lastIndex = 0;
        if (!PAGE_PATTERN.test(this.ruleUrl)) break;
        guard++;
      }
    }
  }

  analyzeUrl() {
    const urlMatcher = PARAM_PATTERN.exec(this.ruleUrl);
    const urlNoOption = urlMatcher ? this.ruleUrl.substring(0, urlMatcher.index) : this.ruleUrl;
    this.url = getAbsoluteURL(this.baseUrl, urlNoOption);
    const bu = getBaseUrl(this.url);
    if (bu) this.baseUrl = bu;
    if (urlNoOption.length !== this.ruleUrl.length) {
      const urlOptionStr = this.ruleUrl.substring(urlMatcher.index + urlMatcher[0].length);
      let raw = null;
      try { raw = JSON.parse(urlOptionStr); } catch (e) { raw = null; }
      if (raw === null) {
        // legado: GSONStrict 失败后回退 GSON（lenient，接受单引号/裸键/尾逗号）
        raw = parseRelaxedJson(urlOptionStr);
        if (raw !== null) this._log('链接参数 JSON 格式不规范，请改为规范格式');
      }
      if (raw !== null) {
        const option = new UrlOption(raw);
        const method = option.getMethod();
        if (method !== null) {
          const up = method.toUpperCase();
          this.method = up === 'POST' ? 'POST' : (up === 'HEAD' ? 'HEAD' : 'GET');
        }
        const hm = option.getHeaderMap();
        if (hm) for (const [k, v] of Object.entries(hm)) this.headerMap.set(k, String(v));
        const body = option.getBody();
        if (body !== null) this.body = body;
        this.type = option.getType();
        this.charset = option.getCharset();
        this.retry = option.getRetry();
        this.useWebView = option.useWebView();
        this.webJs = option.getWebJs();
        this.bodyJs = option.getBodyJs();
        const to = option.getTimeout();
        if (to !== null) { this.readTimeoutMs = to; this.urlTimeoutConfigured = true; }
        this.followRedirects = option.getFollowRedirects();
        this.dnsIp = option.getDnsIp();
        const js = option.getJs();
        if (js !== null) {
          const ev = this.evalJS(js, this.url);
          if (ev !== null && ev !== undefined) this.url = String(ev);
        }
        this.serverID = option.getServerID();
        this.webViewDelayTime = Math.max(0, option.getWebViewDelayTime() ?? 0);
      }
    }
    this.urlNoQuery = this.url;
    if (this.method === 'POST') {
      if (this.body !== null) {
        const ct = headerGetCI(this.headerMap, 'Content-Type');
        if (!isJson(this.body) && !isXml(this.body) && blank(ct)) this.analyzeFields(this.body);
      }
    } else {
      const pos = this.url.indexOf('?');
      if (pos !== -1) {
        this.analyzeQuery(this.url.substring(pos + 1));
        this.urlNoQuery = this.url.substring(0, pos);
      }
    }
  }

  analyzeFields(fieldsTxt) {
    this.encodedForm = encodeParams(fieldsTxt, this.charset, false);
  }

  analyzeQuery(query) {
    this.encodedQuery = encodeParams(query, this.charset, true);
  }

  // JsExtensions / AnalyzeRule 桥
  put(key, value) {
    if (this.chapter && typeof this.chapter.putVariable === 'function') this.chapter.putVariable(key, value);
    else if (this.ruleData && typeof this.ruleData.putVariable === 'function') this.ruleData.putVariable(key, value);
    return value;
  }

  get(key) {
    if (key === 'bookName') {
      const b = this.ruleData;
      if (b && typeof b.name === 'string' && b.name !== '') return b.name;
    }
    if (key === 'title' && this.chapter && this.chapter.title) return this.chapter.title;
    const from = (o) => {
      if (!o) return '';
      if (typeof o.getVariable === 'function') return o.getVariable(key) || '';
      return '';
    };
    return from(this.chapter) || from(this.ruleData) || '';
  }

  /** 执行 JS（Rhino 语义，由 jsEval 注入） */
  evalJS(jsStr, result = null) {
    if (!this.jsEval) throw new Error('AnalyzeUrl.evalJS: JS 运行时未接入');
    const src = this._env && this._env.wrappedSource ? this._env.wrappedSource : this.source;
    return this.jsEval(String(jsStr), result, {
      java: this.javaBridge,
      baseUrl: this.baseUrl,
      result,
      page: this.page,
      key: this.key,
      source: src,
      sourceApi: src,
      book: this.ruleData,
      infoMap: this.infoMap,
      cookie: this.cookieStore,
      cache: this.cache,
    });
  }

  /**
   * legado CookieManager.loadRequest / saveResponse：cookie 的 domain 一律按
   * **实际请求 URL** 归一化（NetworkUtils.getSubDomain(request.url)）。
   * 不能用 source.bookSourceUrl —— 光遇聚合这类书源的 bookSourceUrl 是字面量
   * 「光遇聚合」（不是 URL），归一化后仍是「光遇聚合」，查不到 gyks.cf 桶里的
   * 登录 cookie（deviceId/qttoken），请求被服务器判为未登录 → 502。
   */
  _cookieDomain() {
    const u = this.url || this.urlNoQuery || "";
    try {
      const d = u ? getSubDomain(u) : "";
      if (d) return d;
    } catch (e) { /* fallthrough */ }
    return this.domain || "";
  }
  _buildHeaders() {
    const h = new Map();
    for (const [k, v] of this.headerMap) h.set(k, v);
    // setCookie()
    const cookie = this.cookieStore ? this.cookieStore.getCookie(this._cookieDomain()) : '';
    if (cookie) {
      const merged = mergeCookies(cookie, headerGetCI(h, 'Cookie'));
      if (merged) setHeaderCI(h, 'Cookie', merged);
    }
    return h;
  }

  /**
   * 同步执行请求，返回 StrResponse 等价对象
   */
  getStrResponse(opts = {}) {
    const { skipRateLimit = false, isTest = false } = opts;
    if (!skipRateLimit && this._limiter) this._limiter.acquire();
    if (this.type !== null) {
      const bytes = this.getByteArray();
      return { url: this.url, body: Buffer.from(bytes).toString('hex'), code: 200, headers: {}, callTime: 0 };
    }
    return this._executeStrRequest(isTest);
  }

  _executeStrRequest(isTest) {
    const startTime = Date.now();
    const headers = this._buildHeaders();
    const headerObj = {};
    for (const [k, v] of headers) headerObj[k] = v;
    let url = this.urlNoQuery;
    let method = this.method;
    let bodyBuf = null;

    if (this.useWebView) {
      throw new Error('该书源使用了 WebView 请求，桌面端不支持');
    }

    if (method === 'POST') {
      const contentType = headerGetCI(headers, 'Content-Type');
      if (this.encodedForm !== null && this.encodedForm !== '') {
        bodyBuf = Buffer.from(this.encodedForm, 'utf8');
        if (!contentType) { headerObj['Content-Type'] = 'application/x-www-form-urlencoded'; }
      } else if (blank(this.body)) {
        bodyBuf = Buffer.from(this.encodedForm || '', 'utf8');
        if (!contentType) { headerObj['Content-Type'] = 'application/x-www-form-urlencoded'; }
      } else if (!blank(contentType)) {
        bodyBuf = Buffer.from(this.body, 'utf8');
      } else {
        bodyBuf = Buffer.from(this.body, 'utf8');
        headerObj['Content-Type'] = 'application/json; charset=utf-8';
      }
    } else if (method === 'GET') {
      if (this.encodedQuery !== null && this.encodedQuery !== '') {
        url = url + '?' + this.encodedQuery;
      }
    }

    const readTimeout = this.readTimeoutMs ?? 60000;
    const callTimeout = this.callTimeoutMs ?? derivedCallTimeoutMillis(readTimeout);
    let res;
    let lastErr = null;
    const tries = Math.max(0, this.retry) + 1;
    for (let i = 0; i < tries; i++) {
      try {
        res = requestSync({
          url,
          method,
          headers: headerObj,
          body: bodyBuf ? bodyBuf.toString('binary') : null,
          bodyEncoding: 'latin1',
          readTimeoutMs: readTimeout,
          callTimeoutMs: callTimeout,
          followRedirects: this.followRedirects !== false,
        }, callTimeout + 15000);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      if (!isTest) throw lastErr;
      return { url: this.url, body: lastErr.message, code: -7, headers: {}, callTime: -7, error: lastErr };
    }
    if (res.setCookies && res.setCookies.length) this._saveCookies(res.setCookies);
    let body = res.body;
    const ct = res.headers ? res.headers['content-type'] : null;
    const isXmlResp = ct ? XML_CONTENT_TYPE.test(String(ct)) : false;
    if (isXmlResp && !(body || '').trim().toLowerCase().startsWith('<?xml')) {
      body = '<?xml version="1.0"?>' + body;
    } else if (this.bodyJs !== null) {
      body = String(this.evalJS(this.bodyJs, body) ?? '');
    }
    const callTime = Date.now() - startTime;
    const hops = Array.isArray(res.hops) ? res.hops : [];
    const strResp = {
      url: res.url, code: res.code, message: res.message,
      headers: res.headers, body, callTime,
      rawBody: res.body,
      raw: { priorResponse: { isRedirect: hops.length > 1, url: res.url, code: res.code } },
    };
    this.response = strResp;
    return strResp;
  }

  getErrStrResponseObj(t) {
    return {
      url: this.url, body: String((t && (t.stack || t.message)) || t), code: 500,
      message: t && t.message ? String(t.message) : 'error', headers: {}, callTime: 0,
    };
  }

  _saveCookies(setCookies) {
    if (!this.cookieStore) return;
    if (!this.enabledCookieJar) return;
    const domain = this._cookieDomain();
    const merged = mergeCookies(this.cookieStore.getCookie(domain), setCookies.join('; '));
    if (merged) this.cookieStore.replaceCookie(domain, merged);
  }

  getByteArray() {
    if (this.urlNoQuery.startsWith('data:')) {
      const m = /^data:.*?;base64,(.*)/s.exec(this.urlNoQuery);
      if (m) return Buffer.from(m[1], 'base64');
    }
    if (!skipRate(this._limiter)) { /* 已限速则不再重复 */ }
    const headers = this._buildHeaders();
    const headerObj = {};
    for (const [k, v] of headers) headerObj[k] = v;
    const res = requestSync({
      url: this.urlNoQuery, method: this.method, headers: headerObj, body: null,
      readTimeoutMs: this.readTimeoutMs ?? 60000,
      callTimeoutMs: this.callTimeoutMs ?? derivedCallTimeoutMillis(this.readTimeoutMs ?? 60000),
      followRedirects: this.followRedirects !== false,
    }, (this.callTimeoutMs ?? 120000) + 15000);
    return res.rawBodyBase64 ? Buffer.from(res.rawBodyBase64, 'base64') : Buffer.from(res.body, 'utf8');
  }

  /** 供 java.* 桥接：JS 侧调用 */
  getUrl() { return this.url; }
  getUrlNoQuery() { return this.urlNoQuery; }
  getHeaderMapObj() { const o = {}; for (const [k, v] of this.headerMap) o[k] = v; return o; }
  isPost() { return this.method === 'POST'; }
  getUserAgent() { return headerGetCI(this.headerMap, 'User-Agent') || DEFAULT_UA; }
}

function skipRate() { return false; }

function hasKeyCI(obj, key) {
  const lk = key.toLowerCase();
  return Object.keys(obj).some((k) => k.toLowerCase() === lk);
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

function setHeaderCI(map, key, value) {
  if (map instanceof Map) {
    for (const k of map.keys()) if (k.toLowerCase() === key.toLowerCase()) { map.set(k, value); return; }
    map.set(key, value);
    return;
  }
  const lk = key.toLowerCase();
  for (const k of Object.keys(map || {})) if (k.toLowerCase() === lk) { map[k] = value; return; }
  map[key] = value;
}

/** CookieManager.mergeCookies */
export function mergeCookies(...cookieStrs) {
  const kv = new Map();
  let maxAge0 = false;
  for (const c of cookieStrs) {
    if (!c) continue;
    for (const part of String(c).split(';')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      const k = part.substring(0, i).trim();
      const v = part.substring(i + 1).trim();
      if (/^max-age$/i.test(k)) { if (v === '0') maxAge0 = true; continue; }
      if (/^(expires|path|domain|version)$/i.test(k)) continue;
      if (k === '') continue;
      kv.set(k, v);
    }
  }
  if (maxAge0) return '';
  if (kv.size === 0) return null;
  return [...kv.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export { isEncodedQuery };
