// js-runtime.mjs —— legado Rhino 脚本运行时的 node:vm 复刻
import vm from 'node:vm';
import * as cryptoUtils from './crypto-utils.mjs';
import { formatKeepImg, format as htmlFormatAll } from './html-format.mjs';
import { installJavaShims, SANDBOX_BOOTSTRAP } from './packages-shim.mjs';
import { installCryptoJs } from './crypto-js.mjs';
import { DEFAULT_UA } from './http-core.mjs';
import { getSubDomain } from './net-utils.mjs';

const DEFAULT_UA_TEXT = DEFAULT_UA;

/** Rhino 语义：Java String 参数收到 null 就是 null（不是 "null"）；这里统一收敛 */
function str4(v) {
  return v === null || v === undefined ? null : String(v);
}

export class WebJsUnsupportedError extends Error {
  constructor(api) {
    super(`该书源依赖 ${api}（安卓 WebView 专属），桌面端不支持`);
    this.name = 'WebJsUnsupportedError';
    this.api = api;
  }
}

/*
 * CookieStore（io.legado.app.help.http.CookieStore）
 *
 * Kt 原实现每一处读写都先过 NetworkUtils.getSubDomain(url)：
 *   setCookie(url, ck)    -> domain = getSubDomain(url) → 落库
 *   getCookie(url)        -> domain = getSubDomain(url)  → 读库
 *   removeCookie(url)     -> domain = getSubDomain(url)
 *   replaceCookie(url, ck)-> getCookieNoSession(url) 读写 → 同样归一化
 * 这不是「顺手加个规范化」，而是书源的登录态能读回来的前提：
 * 光遇聚合这类书源 bookSourceUrl 是字面量「光遇聚合」（不是 URL），
 * getSubDomain 对非 http(s) 串原样返回；而它 hosts 里的
 * https://v1.gyks.cf … v7 全部归一化成 gyks.cf。
 * 书源 login() 里 setAllCookies() 往 8 个 host 逐个 setCookie → 全落进
 * 「gyks.cf」这同一个桶；之后 getToken() 逐个 getCookie(host) 读的也是同一个桶。
 * 之前这里精确匹配 tag，写进「光遇聚合」桶、读时按 gyks.cf 找 → 读空 →
 * 书源弹「🤔请先登陆」，就是「登录成功后又说没登录」的原因。
 */
export class CookieStore {
  constructor() {
    this.map = new Map();
    /** 写计数：跨 worker 同步用（>0 表示本 worker 有新登录态要广播出去） */
    this.dirty = 0;
  }

  getCookie(tag) {
    return this.map.get(getSubDomain(tag)) || '';
  }

  getKey(tag = '', key = '') {
    if (!tag) return '';
    const raw = this.map.get(getSubDomain(tag)) || '';
    if (!key) return raw;
    for (const p of raw.split(';')) {
      const idx = p.indexOf('=');
      if (idx === -1) continue;
      if (p.substring(0, idx).trim() === key) return p.substring(idx + 1).trim();
    }
    return '';
  }

  setCookie(tag, cookie) {
    const domain = getSubDomain(tag);
    if (!cookie) return this.map.get(domain) || '';
    const merged = mergeCookies(this.map.get(domain) || '', cookie);
    this.map.set(domain, merged);
    this.dirty++;
    return merged;
  }

  removeCookie(tag) {
    this.map.delete(getSubDomain(tag));
    this.dirty++;
    return '';
  }

  /* Kt：replaceCookie 在 url / cookie 任一为空时直接 return（不写库） */
  replaceCookie(tag, cookie) {
    if (!tag || !cookie) return '';
    const domain = getSubDomain(tag);
    const old = this.map.get(domain) || '';
    const merged = old ? mergeCookies(old, cookie) : cookie;
    this.map.set(domain, merged);
    this.dirty++;
    return merged;
  }

  /* Kt 额外暴露的 getCookieNoSession（按 level 2 域名取裸串），供 replaceCookie 语义复用 */
  getCookieNoSession(tag) { return this.map.get(getSubDomain(tag)) || ''; }

  /* legado 里 CookieStore 是 object 单例 + cookieDao 落库，所有协程共享一份。
     我们把它拆到了多个 worker，于是加了「导出/导入」让 worker 池能互相同步。 */
  toArray() { return [...this.map.entries()].map(([d, c]) => [d, c]); }

  /**
   * 合并式写入：同域下快照里的 key 覆盖本地同名 key，本地独有的 key 保留。
   * 不能用覆盖式 —— 站点 set-cookie 是每个 worker 各自累积的（AnalyzeUrl 回写），
   * 整桶覆盖会把别的 worker 攒下来的 cookie 抹掉。
   */
  fromArray(arr) {
    for (const pair of arr || []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const d = String(pair[0] == null ? '' : pair[0]);
      const c = pair[1] == null ? '' : String(pair[1]);
      if (!d) continue;
      if (!c) continue;
      const old = this.map.get(d) || '';
      const merged = old ? mergeCookies(old, c) : c;
      if (merged) this.map.set(d, merged); else this.map.delete(d);
    }
    return this.map.size;
  }
}

export function mergeCookies(oldCookie, newCookie) {
  if (!newCookie) return oldCookie || '';
  if (!oldCookie) return newCookie;
  const kv = new Map();
  for (const part of String(oldCookie).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    kv.set(part.substring(0, i).trim(), part.substring(i + 1).trim());
  }
  let maxAge0 = false;
  for (const part of String(newCookie).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.substring(0, i).trim();
    const v = part.substring(i + 1).trim();
    if (/^max-age$/i.test(k)) { if (v === '0') maxAge0 = true; continue; }
    if (/^(expires|path|domain)$/i.test(k)) continue;
    kv.set(k, v);
  }
  if (maxAge0) return '';
  if (kv.size === 0) return oldCookie;
  return [...kv.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/* CacheManager（简化：内存） */
export class CacheManager {
  constructor(store = null) {
    this.store = store || new Map();
    /**
     * memoryLruCache 等价物（legado CacheManager.kt: memoryLruCache）。
     * 只活在本进程内存里、不落库、不参与跨 worker 同步 —— 对应 WebCacheManager 的
     * putMemory/getFromMemory/deleteMemory。光遇聚合的段评/本章说气泡会用它存点击计数：
     *   createSvg(…) → showCmt() 里 `cache.getFromMemory(url)` / `cache.putMemory(url, click+1)`
     * 缺了这三个方法，整条 ruleContent 会 TypeError → 前端显示「章节加载失败」。
     */
    this.mem = new Map();
    /** 写计数：登录/变量类 key 被改过时自增（跨 worker 同步触发条件） */
    this.dirty = 0;
  }

  get(key) {
    // legado get()：先看 memory，但只有 String 才直接返回（数字等仍要回落到 DB）
    const mem = this.mem.get(key);
    if (typeof mem === 'string') return mem;
    const item = this.store.get(key);
    if (!item) return null;
    if (item.deadline > 0 && Date.now() > item.deadline) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  /* ---- WebCacheManager 的三个内存方法（Kt：memoryLruCache 直接存取任意类型） ---- */
  putMemory(key, value) { this.mem.set(String(key), value); }

  getFromMemory(key) { return this.mem.get(String(key)); }

  deleteMemory(key) { this.mem.delete(String(key)); }

  put(key, value, saveTime = 0) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    // legado put()：先写 memoryLruCache，再插 DB（CacheManager.kt）
    this.putMemory(key, str);
    this.store.set(key, {
      value: str,
      deadline: saveTime > 0 ? Date.now() + saveTime * 1000 : 0,
    });
    if (CacheManager.SYNC_PREFIXES.some((p) => String(key).startsWith(p))) this.dirty++;
    return value;
  }

  delete(key) {
    this.store.delete(key);
    this.deleteMemory(key);
    if (CacheManager.SYNC_PREFIXES.some((p) => String(key).startsWith(p))) this.dirty++;
  }
  clear() { this.store.clear(); this.mem.clear(); this.dirty++; }

  /**
   * 导出/导入（对应 legado CacheManager 的 cacheDao 落库：单例共享）。
   * 只同步「登录/变量」这几类 key —— 对应 AppCacheManager.clearSourceVariables 的前缀表，
   * 正文缓存等大对象不跨 worker 搬。
   */
  static SYNC_PREFIXES = ['userInfo_', 'loginHeader_', 'sourceVariable_', 'v_'];

  toArray() {
    const out = [];
    for (const [k, item] of this.store) {
      if (!CacheManager.SYNC_PREFIXES.some((p) => k.startsWith(p))) continue;
      if (item.deadline > 0 && Date.now() > item.deadline) continue;
      out.push([k, item.value, item.deadline]);
    }
    return out;
  }

  fromArray(arr) {
    for (const row of arr || []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const k = String(row[0] == null ? '' : row[0]);
      if (!k) continue;
      const v = row[1] == null ? '' : String(row[1]);
      if (!v) { this.store.delete(k); this.mem.delete(k); }
      else {
        this.store.set(k, { value: v, deadline: Number(row[2]) || 0 });
        // 快照覆盖后必须同步刷新 memory 副本，否则 get() 会读回本 worker 的旧值
        if (this.mem.has(k)) this.mem.set(k, v);
      }
    }
    return this.store.size;
  }
}

class JsURL {
  constructor(url, base) {
    const raw = String(url == null ? '' : url);
    try {
      this.href = base ? new URL(raw, base).toString() : raw;
    } catch (e) {
      this.href = raw;
    }
  }

  toString() { return this.href; }
  toStringWithBase() { return this.href; }
}

const HTML_ENTITIES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', ' ': '&nbsp;',
};

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"' ]/g, (c) => HTML_ENTITIES[c]);
}

export function unescapeHtml4(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
}

/* java 桥接基类：JsExtensions + JsEncodeUtils 全部可用方法 */
export class JavaBridgeBase {
  constructor(opts = {}) {
    this.source = opts.source || null;
    this.cookieStore = opts.cookieStore || null;
    this.cache = opts.cache || null;
    this.logger = opts.logger || null;
    this.network = opts.network || null;
    this.info = opts.info || null;
    // legado/Rhino 里 java.showBrowser 会真的弹 WebView；桌面端没有内嵌 WebView，
    // 所以把「要打开的窗口」收集成动作交给前端落地（参考 explore.mjs 的 makeActionJava）。
    // 不传收集器时保持旧行为（抛 WebJsUnsupportedError），避免影响既有回退逻辑。
    this.browserActions = opts.browserActions || null;
  }

  /** 收集一条浏览器动作；没有收集器返回 false（调用方继续走旧路径） */
  _pushBrowserAction(action) {
    if (!this.browserActions) return false;
    this.browserActions.push(action);
    return true;
  }

  getSource() { return this.source; }

  getTag() { return this.source ? (this.source.bookSourceName || '') : ''; }

  ajax(url, callTimeout) {
    if (!this.network) throw new Error('java.ajax 不可用（网络层未接入）');
    return this.network.ajax(url, callTimeout);
  }

  ajaxAll(urlList, skipRateLimit) {
    if (!this.network) throw new Error('java.ajaxAll 不可用');
    return this.network.ajaxAll(urlList, skipRateLimit);
  }

  ajaxTestAll(urlList, timeout, skipRateLimit) {
    if (!this.network) throw new Error('java.ajaxTestAll 不可用');
    return this.network.ajaxTestAll(urlList, timeout, skipRateLimit);
  }

  connect(urlStr, header, callTimeout) {
    if (!this.network) throw new Error('java.connect 不可用');
    return this.network.connect(urlStr, header, callTimeout);
  }

  get(urlStr, headers, timeout) {
    if (!this.network) throw new Error('java.get 不可用');
    return this.network.get(urlStr, headers, timeout);
  }

  post(urlStr, body, headers, timeout) {
    if (!this.network) throw new Error('java.post 不可用');
    return this.network.post(urlStr, body, headers, timeout);
  }

  head(urlStr, headers, timeout) {
    if (!this.network) throw new Error('java.head 不可用');
    return this.network.head(urlStr, headers, timeout);
  }

  getCookie(tag, key) {
    if (!this.cookieStore) return '';
    return this.cookieStore.getKey(tag, key);
  }

  md5Encode(str) { return cryptoUtils.md5Encode(str); }
  md5Encode16(str) { return cryptoUtils.md5Encode16(str); }
  base64Encode(str, flags) { return cryptoUtils.base64Encode(str, flags); }
  base64Decode(str, charset) { return cryptoUtils.base64Decode(str, charset); }
  base64DecodeToByteArray(str) { return cryptoUtils.base64DecodeToByteArray(str); }
  hexDecodeToByteArray(hex) { return cryptoUtils.hexDecodeToByteArray(hex); }
  hexDecodeToString(hex) { return cryptoUtils.hexDecodeToString(hex); }
  hexEncodeToString(utf8) { return cryptoUtils.hexEncodeToString(utf8); }
  strToBytes(str, charset) { return cryptoUtils.strToBytes(str, charset); }
  bytesToStr(bytes, charset) { return cryptoUtils.bytesToStr(bytes, charset); }
  createSymmetricCrypto(t, k, iv) { return cryptoUtils.createSymmetricCrypto(t, k, iv); }
  aesDecodeToString(str, key, t, iv) { return cryptoUtils.aesDecodeToString(str, key, t, iv); }
  aesDecodeArgsBase64Str(d, k, m, p, iv) { return cryptoUtils.aesDecodeArgsBase64Str(d, k, m, p, iv); }
  desDecodeToString(str, key, t, iv) { return cryptoUtils.desDecodeToString(str, key, t, iv); }
  tripleDESDecodeToString(str, key, t, iv) { return cryptoUtils.tripleDESDecodeToString(str, key, t, iv); }
  digestHex(data, algorithm) { return cryptoUtils.digestHex(data, algorithm); }
  digestBase64Str(data, algorithm) { return cryptoUtils.digestBase64Str(data, algorithm); }
  HMacHex(data, algorithm, key) { return cryptoUtils.hmacHex(data, algorithm, key); }
  HMacBase64(data, algorithm, key) { return cryptoUtils.hmacBase64(data, algorithm, key); }

  encodeURI(str) {
    try { return encodeURIComponent(String(str)); } catch (e) { return ''; }
  }

  htmlFormat(str, redirectUrl) {
    return formatKeepImg(str, redirectUrl || null);
  }

  formatHtml(str) { return htmlFormatAll(str); }
  escapeHtml(str) { return escapeHtml(str); }
  unescapeHtml4(str) { return unescapeHtml4(str); }

  timeFormat(time) { return cryptoUtils.timeFormat(time); }
  timeFormatUTC(time, format, sh) { return cryptoUtils.timeFormat(time); }
  randomUUID() { return cryptoUtils.randomUUID(); }
  toNumChapter(s) { return cryptoUtils.toNumChapter(s); }
  toURL(url, baseUrl) { return new JsURL(url, baseUrl); }

  log(msg) {
    if (this.logger) this.logger(String(msg));
    return msg;
  }

  logType(any) {
    const t = Array.isArray(any) ? 'array' : typeof any;
    if (this.logger) this.logger(`类型: ${t}`);
    return t;
  }

  toast(msg) { if (this.logger) this.logger(`[toast] ${msg}`); }
  longToast(msg) { if (this.logger) this.logger(`[longToast] ${msg}`); }

  webView(url, html, preloadJs, config) {
    if (this._pushBrowserAction({ type: 'webView', url: str4(url), html: str4(html), preloadJs: str4(preloadJs), config: str4(config) })) return '';
    throw new WebJsUnsupportedError('java.webView');
  }
  webViewGetSource(url, html, preloadJs, config) {
    if (this._pushBrowserAction({ type: 'webViewGetSource', url: str4(url), html: str4(html), preloadJs: str4(preloadJs), config: str4(config) })) return '';
    throw new WebJsUnsupportedError('java.webViewGetSource');
  }
  webViewGetOverrideUrl() { throw new WebJsUnsupportedError('java.webViewGetOverrideUrl'); }
  startBrowser(url, title) {
    if (this._pushBrowserAction({ type: 'openUrl', url: str4(url), title: str4(title) })) return '';
    throw new WebJsUnsupportedError('java.startBrowser');
  }
  startBrowserAwait(url, title) {
    // legado 会挂起等 WebView 关闭；桌面端只能先把窗口开出去（不阻塞脚本）。
    if (this._pushBrowserAction({ type: 'openUrl', url: str4(url), title: str4(title), await: true })) return '';
    throw new WebJsUnsupportedError('java.startBrowserAwait');
  }
  showBrowser(url, html, preloadJs, config) {
    if (this._pushBrowserAction({ type: 'openUrl', url: str4(url), html: str4(html), preloadJs: str4(preloadJs), config: str4(config) })) return '';
    throw new WebJsUnsupportedError('java.showBrowser');
  }
  /**
   * JsExtensions.openUrl(url, mimeType)（help/JsExtensions.kt:1173）：
   * legado 里弹 OpenUrlConfirmActivity（或对 legado:// / yuedu:// 走 OnLineImportActivity）。
   * 桌面端把「要打开的链接」收集成动作交给前端落地（内置浏览器 / 系统浏览器）。
   */
  openUrl(url, mimeType) {
    const u = str4(url);
    if (u) {
      if (this._pushBrowserAction({ type: 'openUrl', url: u, mimeType: str4(mimeType), sourceUrl: this.source ? this.source.bookSourceUrl : null })) return '';
    }
    this.log('java.openUrl 桌面端忽略');
    return '';
  }
  /**
   * RssJsExtensions.open(name, url, title, origin)（ui/rss/read/RssJsExtensions.kt:99）：
   * name 取值 login / sort / rss / search / explore，前四个分支在 legado 里都是 startActivity。
   * 桌面端没有这些 Activity，改成把参数原样收集成动作，由前端按相同的 when(name) 分派。
   */
  open(name, url, title, origin) {
    const n = str4(name);
    if (n) {
      if (this._pushBrowserAction({ type: 'open', name: n, url: str4(url), title: str4(title), origin: str4(origin), sourceUrl: this.source ? this.source.bookSourceUrl : null })) return '';
    }
    this.log('java.open 桌面端忽略');
    return '';
  }
  openBook() { this.log('java.openBook 桌面端忽略'); return ''; }
  /**
   * RssJsExtensions.searchBook(key, searchScope)（ui/rss/read/RssJsExtensions.kt:74）
   * 桌面端没有 SearchActivity，改成把「打开搜索页」收集成动作交给前端落地。
   * 找不到收集器时保持旧行为（只记日志、不抛错），避免打断既有回退路径。
   */
  searchBook(key, searchScope) {
    const k = String(key == null ? '' : key).trim();
    if (!k) return '';
    if (this._pushBrowserAction({ type: 'searchBook', key: k, scope: str4(searchScope) })) return '';
    this.log('java.searchBook 桌面端忽略');
    return '';
  }
  showReadingBrowser() { this.log('java.showReadingBrowser 桌面端忽略'); return ''; }
  startBrowserDp() { this.log('java.startBrowserDp 桌面端忽略'); return ''; }
  /**
   * BaseSource.refreshExplore()（data/entities/BaseSource.kt:325）：清发现分类缓存后重拉。
   * 桌面端把「重载发现页」收集成动作，由前端按 explorer 的 refreshExplore 语义落地。
   */
  refreshExplore() {
    if (this._pushBrowserAction({ type: 'refreshExplore' })) return '';
    this.log('java.refreshExplore 桌面端忽略');
    return '';
  }
  deviceID() { throw new WebJsUnsupportedError('java.deviceID'); }
  qread() { throw new WebJsUnsupportedError('java.qread'); }
  /**
   * legado 光遇聚合 jsLib 的 checkEnv()：依次探测 java.qread()（轻阅读）、
   * java.reLoginView / Packages.io.legato.kazusa.utils.TimeoutCancellationException（改版）、
   * java.deviceID()（苹果），最后看 source.loginUi 是不是函数（安卓）。
   * 我们是桌面端实现：没有 qread/deviceID，但 source.loginUi 可以绑成函数，
   * 所以照原样返回 "安卓"（BaseSource.loginUi 是 @js: 时就会绑函数）。
   * 影响：光遇 showCmt 首次点击只计数不弹窗（legado 在安卓上就是这个行为）。
   */
  checkEnv() {
    try { this.qread(); return '轻阅读'; } catch (e) { /* 往下探 */ }
    try { if (typeof this.reLoginView === 'function') return '改版'; } catch (e) { /* 往下探 */ }
    try { this.deviceID(); return '苹果'; } catch (e) { /* 往下探 */ }
    if (this.source && typeof this.source.loginUi === 'function') return '安卓';
    return '改版';
  }
  getWebViewUA() { return DEFAULT_UA_TEXT; }
  getAppVariant() { return ''; }
  lang() { return 'zh'; }
  getThemeMode() { return '0'; }
  getReadBookConfig() { return ''; }
  getReadBookConfigMap() { return {}; }
  getThemeConfig() { return ''; }
  getThemeConfigMap() { return {}; }
  createGod() { return ''; }
  getCloudSettings() { return ''; }
  createSvg() { return ''; }
  getLoginInfo() { return ''; }
  putLoginInfo() { return true; }
  removeLoginInfo() { return true; }
  getLoginInfoMap() { return {}; }
  setLoginHeader() { return ''; }
  getBaseUrl() { return this.source ? String(this.source.bookSourceUrl || '') : ''; }
  openVideoPlayer() { throw new WebJsUnsupportedError('java.openVideoPlayer'); }
  getVerificationCode() { throw new WebJsUnsupportedError('java.getVerificationCode'); }
  importScript() { throw new WebJsUnsupportedError('java.importScript'); }
  queryTTF() { throw new WebJsUnsupportedError('java.queryTTF'); }
  queryBase64TTF() { throw new WebJsUnsupportedError('java.queryBase64TTF'); }
  replaceFont() { throw new WebJsUnsupportedError('java.replaceFont'); }
  downloadFile() { throw new WebJsUnsupportedError('java.downloadFile'); }
  cacheFile() { throw new WebJsUnsupportedError('java.cacheFile'); }
  readFile() { throw new WebJsUnsupportedError('java.readFile'); }
  readTxtFile() { throw new WebJsUnsupportedError('java.readTxtFile'); }
  getTxtInFolder() { throw new WebJsUnsupportedError('java.getTxtInFolder'); }
  unzipFile() { throw new WebJsUnsupportedError('java.unzipFile'); }
  un7zFile() { throw new WebJsUnsupportedError('java.un7zFile'); }
  unrarFile() { throw new WebJsUnsupportedError('java.unrarFile'); }
  unArchiveFile() { throw new WebJsUnsupportedError('java.unArchiveFile'); }
  getZipStringContent() { throw new WebJsUnsupportedError('java.getZipStringContent'); }
  getRarStringContent() { throw new WebJsUnsupportedError('java.getRarStringContent'); }
  get7zStringContent() { throw new WebJsUnsupportedError('java.get7zStringContent'); }
  singleFlight() { throw new WebJsUnsupportedError('java.singleFlight'); }
  lock() { throw new WebJsUnsupportedError('java.lock'); }
  androidId() { return 'localreader00000'; } // 16 字符：legado 用 encodeToByteArray(0,16) 作 AES key
  t2s(text) { return String(text == null ? '' : text); }
  s2t(text) { return String(text == null ? '' : text); }
}

/** 跨 realm 的语法错误判定（vm 抛出的 SyntaxError 不一定属于宿主 realm） */
function isSyntaxError(e) {
  return !!e && e.name === 'SyntaxError';
}

/**
 * legado 的 Rhino 对数组解构箭头参数接受一种宽松写法：
 *   list.map([title, id] => { ... })
 * 标准 JavaScript 要写成：
 *   list.map(([title, id]) => { ... })
 * 现有书源普遍按前一种写法编写，桌面端不能因为运行时不同而让整页发现分类失效。
 * 只改明确的数组迭代回调，不碰字符串、普通数组或其它箭头函数。
 */
function normalizeLegacyArrowDestructuring(src) {
  return String(src).replace(
    /(\.\s*(?:map|forEach|filter|some|every|find|findIndex|reduce|flatMap)\s*\(\s*)\[([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\]\s*=>/g,
    '$1([$2]) =>',
  );
}
/* 运行时：每个 source 复用一个 vm context；每个 jsLib 单独一个共享 context */

export class JsRuntime {
  constructor(opts = {}) {
    this.opts = opts;
    this._contexts = new Map();      // sourceKey -> ctx（书源自身的脚本作用域）
    this._libContexts = new Map();   // md5(jsLib) -> ctx（jsLib 共享作用域，对应 SharedJsScope.getScope）
    this.logger = opts.logger || null;
  }

  _sandboxBase() {
    const sandbox = Object.create(null);
    for (const n of [
      'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'RegExp',
      'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError',
      'Promise', 'Map', 'Set', 'Symbol', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Function',
      'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
      'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
      'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'BigInt', 'Intl',
    ]) {
      if (n in globalThis) sandbox[n] = globalThis[n];
    }
    sandbox.console = {
      log: (...a) => this._log(a.join(' ')),
      error: (...a) => this._log(a.join(' ')),
      warn: (...a) => this._log(a.join(' ')),
      info: (...a) => this._log(a.join(' ')),
      debug: (...a) => this._log(a.join(' ')),
      trace: (...a) => this._log(a.join(' ')),
    };
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    sandbox.isNaN = isNaN;
    sandbox.isFinite = isFinite;
    sandbox.encodeURIComponent = encodeURIComponent;
    sandbox.decodeURIComponent = decodeURIComponent;
    sandbox.encodeURI = encodeURI;
    sandbox.decodeURI = decodeURI;
    sandbox.Infinity = Infinity;
    sandbox.NaN = NaN;
    sandbox.undefined = undefined;
    sandbox.Buffer = Buffer;
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.TextEncoder = TextEncoder;
    sandbox.TextDecoder = TextDecoder;
    sandbox.setTimeout = (fn, ms) => setTimeout(() => { try { fn(); } catch (e) { /* noop */ } }, ms);
    sandbox.clearTimeout = clearTimeout;
    sandbox.setInterval = (fn, ms) => setInterval(() => { try { fn(); } catch (e) { /* noop */ } }, ms);
    sandbox.clearInterval = clearInterval;
    sandbox.queueMicrotask = (fn) => queueMicrotask(() => { try { fn(); } catch (e) { /* noop */ } });
    sandbox.structuredClone = typeof structuredClone === 'function' ? structuredClone : undefined;
    sandbox.atob = atob;
    sandbox.btoa = btoa;
    return sandbox;
  }

  _mkContext(name) {
    const sandbox = this._sandboxBase();
    installJavaShims(sandbox, { logger: this.logger });
    const ctx = vm.createContext(sandbox, { name });
    try { vm.runInContext(SANDBOX_BOOTSTRAP, ctx); } catch (e) { /* noop */ }
    // SharedJsScope：每个作用域都注入 CryptoJS（书源普遍直接用 CryptoJS.*）
    installCryptoJs(ctx, { logger: this.logger });
    return ctx;
  }

  /** 书源自身的脚本作用域 */
  _contextFor(key) {
    if (this._contexts.has(key)) return this._contexts.get(key);
    const ctx = this._mkContext(`legado-${key}`);
    this._contexts.set(key, ctx);
    return ctx;
  }

  /**
   * jsLib 共享作用域（SharedJsScope.getScope）：同一 jsLib 只 eval 一次，被所有调用共享。
   * jsLib 里的 `java` / `source` / `cookie` / `cache` 从 this 上取，所以每次 run 前要刷新 sandbox 全局。
   */
  _libContextFor(jsLib, baseBindings) {
    const key = cryptoUtils.md5Encode(String(jsLib));
    let ctx = this._libContexts.get(key);
    if (!ctx) {
      ctx = this._mkContext('legado-jsLib');
      // 先注入一套 bindings 再 eval jsLib，避免 jsLib 顶层就引用 java/source
      this._installGlobals(ctx, baseBindings || {});
      try {
        vm.runInContext(String(jsLib), ctx, { timeout: 60000 });
      } catch (e) {
        this._log(`[jsLib] 加载失败: ${e && e.message}`);
        throw e;
      }
      this._libContexts.set(key, ctx);
    }
    return ctx;
  }

  /** 把 bindings 写到 ctx 全局（同时支持裸用 `java` 和 `this.java`） */
  _installGlobals(ctx, bindings) {
    for (const [k, v] of Object.entries(bindings)) {
      try { ctx[k] = v; } catch (e) { /* noop */ }
    }
  }

  _log(msg) {
    if (this.logger) this.logger(String(msg));
  }

  /**
   * 执行 JS 片段（legado/Rhino 语义）
   * @param {string} code
   * @param {object} bindings
   * @param {object} opts { key, timeoutMs, jsLib }
   */
  run(code, bindings = {}, opts = {}) {
    const key = opts.key || 'default';
    const jsLib = opts.jsLib;
    // legado/Rhino 没有这种每次调用的硬性上限：聚合类书源（光遇聚合等）会在
    // @js 规则里连续 java.ajax 拉多个子源，20s 很容易被砍断（表现为「JS 执行超时」）。
    // 这里放宽到 120s，与 js-source.mjs 的单文件源默认值保持一致；真正兜底的是
    // book-pool 的任务级超时（搜索 45s），所以不会有失控风险。
    const timeout = Number(opts.timeoutMs || process.env.READER_JS_TIMEOUT || 120000);
    const src = String(code);

    // jsLib 存在时优先在其共享作用域里跑（legado：bindings.chainTo(topScope)，bindings 优先）
    const primary = jsLib ? this._libContextFor(jsLib, bindings) : this._contextFor(key);
    const fallback = jsLib ? this._contextFor(key) : primary;

    const attempt = (ctx) => this._exec(ctx, src, bindings, timeout);

    try {
      return attempt(primary);
    } catch (e) {
      if (e && /Script execution timed out/.test(String(e.message))) {
        throw new Error(`JS 执行超时（${timeout}ms）`);
      }
      // 只有语法错误才回退到书源自身作用域（jsLib 作用域确实跑不了这段代码）。
      // 运行期错误必须原样抛出：一旦回退，错误会被换成「某个 jsLib 函数未定义」，
      // 真实原因（如 java.xxx 不存在）就被掩盖了。
      if (fallback === primary || !isSyntaxError(e)) throw e;
      return attempt(fallback);
    }
  }

  _exec(ctx, src, bindings, timeout) {
    this._installGlobals(ctx, bindings);
    const normalizedSrc = normalizeLegacyArrowDestructuring(src);
    // 先编译、再执行：运行期的 JSON.parse 等也可能抛 SyntaxError，不能把它们
    // 误当成编译错误再次回退，否则真实的“接口返回了 HTML/错误 JSON”会被伪装成
    // 无关的 `Unexpected token 'var'`。只有 vm.Script 编译失败时才尝试下一个包装。
    const forms = [
      [`{\n${normalizedSrc}\n}`, 'legado-js'],
      [`(function(){\n${normalizedSrc}\n})()`, 'legado-js-fn'],
      [`(function(){ return (\n${normalizedSrc}\n); })()`, 'legado-js-expr'],
    ];
    const compileErrors = [];
    for (const [code, filename] of forms) {
      let script;
      try {
        script = new vm.Script(code, { filename });
      } catch (e) {
        if (!isSyntaxError(e)) throw e;
        compileErrors.push(e);
        continue;
      }
      // 编译成功后这里是脚本的真实运行期，任何异常（包括 SyntaxError）都必须原样抛出。
      return script.runInContext(ctx, { timeout });
    }
    const brief = String(src).replace(/\s+/g, ' ').trim().slice(0, 200);
    const last = compileErrors[compileErrors.length - 1];
    const err = new Error((last && last.message ? last.message : String(last)) + '（规则 JS：' + brief + '）');
    err.code = 'JS_SYNTAX';
    err.jsSrc = String(src);
    throw err;
  }

  clearCache() { this._contexts.clear(); this._libContexts.clear(); }

  /* ---- JS 单文件源（JsSourceEngine）需要的作用域 / 编译原语 ---- */

  /** 新建一个全新作用域（等价 RhinoScriptEngine.getRuntimeScope：每次调用独立） */
  createScope(name = 'legado-js-source') { return this._mkContext(name); }

  /** 编译（供 LRU 缓存复用；等价 RhinoScriptEngine.compile） */
  compile(code, filename = 'legado-js') {
    return new vm.Script(String(code), { filename });
  }

  /** 作用域里是否声明了某函数（等价 ScriptableObject.getProperty(scope,name) is Function） */
  hasFunction(ctx, name) {
    try { return typeof ctx[name] === 'function'; } catch (e) { return false; }
  }
}

export { JsURL };
