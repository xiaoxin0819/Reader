// packages-shim.mjs —— Rhino/Java 互操作垫片（Packages / JavaImporter / org.jsoup / StrResponse）
// 书源 JS 里大量使用 legado(Rhino) 的 Java 互操作写法，这里在 node:vm 里等价复刻。
import crypto from 'node:crypto';
import * as cryptoUtils from './crypto-utils.mjs';
import { Jsoup, JsoupElement, JsoupElements, JsoupNode, jsoupParse } from './jsoup-bridge.mjs';

/* ---------------- StrResponse（callable + property 双语义） ---------------- */

function callable(value, { asString = false } = {}) {
  const f = function () { return value; };
  const isStr = asString || typeof value === 'string';
  if (isStr) {
    // 关键：把函数对象的原型链改成 String.prototype，
    // 这样 res.body 既是函数（res.body()），又能当字符串用（res.body.slice(0,10) / res.body == "x"）
    const s = value === null || value === undefined ? '' : String(value);
    Object.defineProperty(f, 'length', { value: s.length, configurable: true, writable: true });
    Object.setPrototypeOf(f, String.prototype);
    f.toString = () => s;
    f.valueOf = () => s;
    f[Symbol.toPrimitive] = () => s;
    f.__strValue = s;
  } else {
    f.toString = () => String(value === null || value === undefined ? '' : value);
    if (typeof value === 'number') {
      f.valueOf = () => value;
      f[Symbol.toPrimitive] = () => value;
    } else if (typeof value === 'object' && value !== null) {
      f.valueOf = () => value;
      f[Symbol.toPrimitive] = () => value;
    }
  }
  return f;
}

/**
 * 复刻 io.legado.app.help.http.StrResponse 的 JS 可见形态：
 * 既支持 result.body() / result.url() 调用式，也支持 response.code / response.msg 属性式。
 */
export function makeStrResponse(r = {}) {
  const url = r.url == null ? '' : String(r.url);
  const body = r.body == null ? '' : String(r.body);
  const code = typeof r.code === 'number' ? r.code : 200;
  const message = r.message == null ? 'OK' : String(r.message);
  const headers = r.headers || {};
  const callTime = typeof r.callTime === 'number' ? r.callTime : 0;

  const self = function () { return body; };
  self.toString = () => body;
  self.valueOf = () => body;
  self[Symbol.toPrimitive] = () => body;
  Object.defineProperty(self, 'name', { value: 'StrResponse', configurable: true });

  Object.defineProperty(self, 'url', { value: callable(url, { asString: true }), enumerable: true });
  Object.defineProperty(self, 'body', { value: callable(body, { asString: true }), enumerable: true });
  Object.defineProperty(self, 'code', { value: callable(code), enumerable: true });
  Object.defineProperty(self, 'message', { value: callable(message, { asString: true }), enumerable: true });
  Object.defineProperty(self, 'msg', { value: callable(message, { asString: true }), enumerable: true });
  Object.defineProperty(self, 'headers', { value: callable(headers), enumerable: true });
  Object.defineProperty(self, 'callTime', { value: callable(callTime), enumerable: true });
  Object.defineProperty(self, 'isSuccessful', { value: callable(code >= 200 && code < 300), enumerable: true });
  Object.defineProperty(self, 'errorBody', { value: callable(null), enumerable: true });
  const raw = { url, body, code, message, headers, callTime, priorResponse: r.priorResponse || null };
  Object.defineProperty(raw, 'body', { value: callable(body, { asString: true }), enumerable: true });
  Object.defineProperty(raw, 'url', { value: callable(url, { asString: true }), enumerable: true });
  Object.defineProperty(raw, 'code', { value: callable(code), enumerable: true });
  Object.defineProperty(self, 'raw', { value: raw, enumerable: false });
  Object.defineProperty(self, '__isStrResponse', { value: true, enumerable: false });
  // 一些书源用 result.urlWithDefault() / result.getUrl()
  Object.defineProperty(self, 'urlWithDefault', { value: () => url, enumerable: false });
  self.toJSON = () => ({ url, body, code, message, headers, callTime });
  return self;
}

export function isStrResponse(v) {
  return typeof v === 'function' && v.__isStrResponse === true;
}

/** StrResponse 的构造器形态：支持 new Packages.io.legado...StrResponse(url, body) */
export function StrResponseCtor(url, body) {
  return makeStrResponse({ url, body, code: 200, message: 'OK' });
}

/* ---------------- Java 类垫片 ---------------- */

class JavaClassShim {
  constructor(name) { this.__javaClass = name; }
  toString() { return `class ${this.__javaClass}`; }
}

// java.lang.String 在 JS 侧就是原生 String（含 getBytes 补丁，由 installShims 注入到 realm）
const jThread = {
  __javaClass: 'java.lang.Thread',
  sleep(ms) {
    const n = Number(ms) || 0;
    if (n > 0) {
      const sab = new SharedArrayBuffer(4);
      const ia = new Int32Array(sab);
      Atomics.wait(ia, 0, 0, Math.min(n, 30000));
    }
  },
  currentThread() { return { __javaClass: 'java.lang.Thread', getName: () => 'main' }; },
};

const jInteger = {
  __javaClass: 'java.lang.Integer',
  parseInt: (s, r) => parseInt(s, r || 10),
  valueOf: (v) => Number(v),
  MAX_VALUE: 2147483647, MIN_VALUE: -2147483648,
};
const jLong = { __javaClass: 'java.lang.Long', parseLong: (s) => parseInt(s, 10), MAX_VALUE: Number.MAX_SAFE_INTEGER };
const jCharacter = { __javaClass: 'java.lang.Character', isDigit: (c) => /[0-9]/.test(String(c)), isLetter: (c) => /[A-Za-z]/.test(String(c)) };
const jSystem = {
  __javaClass: 'java.lang.System',
  currentTimeMillis: () => Date.now(),
  nanoTime: () => Number(process.hrtime.bigint()),
  getProperty: () => '',
  out: { println: () => {} },
  lineSeparator: () => '\n',
};
const jMath = { __javaClass: 'java.lang.Math', max: Math.max, min: Math.min, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, pow: Math.pow, random: Math.random, sqrt: Math.sqrt };
const jException = class JavaException extends Error { constructor(m) { super(m == null ? '' : String(m)); this.name = 'JavaException'; } };
const jRuntimeException = class JavaRuntimeException extends Error { constructor(m) { super(m == null ? '' : String(m)); this.name = 'JavaRuntimeException'; } };
const jStringBuilder = class StringBuilder {
  constructor(s = '') { this.buf = String(s); }
  append(x) { this.buf += String(x); return this; }
  toString() { return this.buf; }
  length() { return this.buf.length; }
};
const jObject = { __javaClass: 'java.lang.Object' };
const jBoolean = { __javaClass: 'java.lang.Boolean', parseBoolean: (s) => String(s) === 'true', TRUE: true, FALSE: false };
const jDouble = { __javaClass: 'java.lang.Double', parseDouble: (s) => parseFloat(s) };
const jNumber = { __javaClass: 'java.lang.Number' };
const jCharSequence = { __javaClass: 'java.lang.CharSequence' };
const jClass = { __javaClass: 'java.lang.Class', forName: (n) => new JavaClassShim(n) };

// javax.crypto.*
const jCipher = class Cipher {
  constructor(t) { this.transformation = t; this.mode = null; this.key = null; this.iv = null; }
  static getInstance(t) { return new Cipher(String(t)); }
  init(mode, key, iv) { this.mode = Number(mode); this.key = key; this.iv = iv || null; return this; }
  doFinal(data) {
    const buf = toBuffer(data);
    const t = cryptoUtils.parseTransformation(this.transformation);
    const keyBuf = toBuffer(this.key && this.key.key);
    const ivBuf = this.iv ? toBuffer(this.iv.iv) : null;
    const isEncrypt = this.mode === 1;
    // 复刻 SymmetricCrypto 的 cipherName 规则（Node 侧 AES 需要带密钥长度）
    let name;
    if (t.nodeAlg === 'aes') name = `aes-${keyBuf.length * 8}-${t.nodeMode}`;
    else if (t.nodeAlg === 'des-ede3') name = `des-ede3-${t.nodeMode}`;
    else name = `${t.nodeAlg}-${t.nodeMode}`;
    const ivArg = t.nodeMode === 'ecb' ? null : ivBuf;
    try {
      if (isEncrypt) {
        const c = crypto.createCipheriv(name, keyBuf, ivArg);
        c.setAutoPadding(!t.noPad);
        return Buffer.concat([c.update(buf), c.final()]);
      }
      const d = crypto.createDecipheriv(name, keyBuf, ivArg);
      d.setAutoPadding(!t.noPad);
      return Buffer.concat([d.update(buf), d.final()]);
    } catch (e) {
      throw new Error(`Cipher.doFinal: ${e.message}`);
    }
  }
  update(data) { return toBuffer(data); }
};
const jMac = class Mac {
  static getInstance(t) { return new Mac(String(t)); }
  init(k) { this.key = k; return this; }
  doFinal(d) { return Buffer.alloc(0); }
};
const jSecretKeySpec = class SecretKeySpec {
  constructor(key, alg) { this.key = toBuffer(key); this.alg = alg == null ? '' : String(alg); }
  getAlgorithm() { return this.alg; }
  getEncoded() { return this.key; }
};
const jIvParameterSpec = class IvParameterSpec {
  constructor(iv) { this.iv = toBuffer(iv); }
  getIV() { return this.iv; }
};
const jDESKeySpec = class DESKeySpec { constructor(k) { this.key = toBuffer(k); } };
const jCipherException = class CipherException extends Error {};

// java.util.*
const jBase64 = {
  __javaClass: 'java.util.Base64',
  getDecoder() { return { decode: (s) => Buffer.from(String(s), 'base64') }; },
  getEncoder() { return { encodeToString: (b) => toBuffer(b).toString('base64'), encode: (b) => toBuffer(b) }; },
  getUrlDecoder() { return { decode: (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64') }; },
  getUrlEncoder() { return { encodeToString: (b) => toBuffer(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }; },
  getMimeDecoder() { return { decode: (s) => Buffer.from(String(s), 'base64') }; },
};
const jArrays = {
  __javaClass: 'java.util.Arrays',
  copyOfRange: (arr, from, to) => {
    const b = toBuffer(arr);
    return b.subarray(Number(from), to === undefined || to === null ? b.length : Number(to));
  },
  copyOf: (arr, len) => {
    const b = toBuffer(arr);
    const out = Buffer.alloc(Number(len));
    b.copy(out, 0, 0, Math.min(b.length, out.length));
    return out;
  },
  asList: (...a) => (Array.isArray(a[0]) ? a[0] : a),
  toString: (a) => JSON.stringify(toArrayLike(a)),
  sort: (a, cmp) => { if (Array.isArray(a)) a.sort(cmp); return a; },
};
const jCollections = { __javaClass: 'java.util.Collections', emptyList: () => [], emptyMap: () => ({}), sort: (l, c) => { if (Array.isArray(l)) l.sort(c); return l; }, unmodifiableList: (l) => l, unmodifiableMap: (m) => m };
const jHashMap = class HashMap { constructor(o) { const m = new Map(); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) m.set(k, v); this.map = m; } put(k, v) { this.map.set(k, v); return v; } get(k) { return this.map.has(k) ? this.map.get(k) : null; } containsKey(k) { return this.map.has(k); } size() { return this.map.size; } keySet() { return [...this.map.keys()]; } values() { return [...this.map.values()]; } toString() { return JSON.stringify(Object.fromEntries(this.map)); } };
const jArrayList = class ArrayList { constructor(o) { this.a = Array.isArray(o) ? o.slice() : []; } add(x) { this.a.push(x); return true; } get(i) { return this.a[i]; } size() { return this.a.length; } toArray() { return this.a.slice(); } toString() { return JSON.stringify(this.a); } };
const jList = { __javaClass: 'java.util.List' };
const jMap = { __javaClass: 'java.util.Map' };
const jDate = { __javaClass: 'java.util.Date', now: () => Date.now(), new: () => new Date() };
const jUUID = { __javaClass: 'java.util.UUID', randomUUID: () => cryptoUtils.randomUUID() };
const jRandom = class Random { nextInt(n) { return n ? Math.floor(Math.random() * n) : Math.floor(Math.random() * 4294967296); } nextDouble() { return Math.random(); } };
const jObjects = { __javaClass: 'java.util.Objects', equals: (a, b) => a === b, hashCode: (o) => String(o).length };
const jScanner = { __javaClass: 'java.util.Scanner' };

// java.security / java.text / java.net / android
const jMessageDigest = {
  __javaClass: 'java.security.MessageDigest',
  getInstance(alg) {
    const a = String(alg).replace(/-/g, '').toUpperCase();
    return {
      update() {}, reset() {},
      digest: (d) => Buffer.from(cryptoUtils.digestHex(d === undefined ? '' : d, a), 'hex'),
      digestHex: (d) => cryptoUtils.digestHex(d === undefined ? '' : d, a),
    };
  },
};
const jSimpleDateFormat = class SimpleDateFormat {
  constructor(f) { this.format = f; }
  format(d) { return cryptoUtils.timeFormat(d === undefined ? Date.now() : new Date(d).getTime()); }
};
const jURLEncoder = { __javaClass: 'java.net.URLEncoder', encode: (s, enc) => encodeURIComponent(String(s)), encodeURIComponent: (s) => encodeURIComponent(String(s)) };
const jURLDecoder = { __javaClass: 'java.net.URLDecoder', decode: (s, enc) => decodeURIComponent(String(s)) };
const jURI = { __javaClass: 'java.net.URI' };
const jURL = { __javaClass: 'java.net.URL' };
const jTextUtils = { __javaClass: 'android.text.TextUtils', isEmpty: (s) => s === null || s === undefined || String(s).length === 0, join: (sep, arr) => (arr || []).join(sep) };
const jLog = { __javaClass: 'android.util.Log', i: () => 0, d: () => 0, e: () => 0, w: () => 0, v: () => 0 };

const jHutoolBase64 = {
  __javaClass: 'cn.hutool.core.codec.Base64',
  encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
  decodeStr: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
  decode: (s) => Buffer.from(String(s), 'base64'),
};
const jDigestUtil = {
  __javaClass: 'cn.hutool.crypto.digest.DigestUtil',
  md5Hex: (s) => cryptoUtils.md5Encode(s),
  md5: (s) => cryptoUtils.md5Encode(s),
  sha1Hex: (s) => cryptoUtils.digestHex(s, 'SHA1'),
  sha256Hex: (s) => cryptoUtils.digestHex(s, 'SHA256'),
};
const jHexUtil = {
  __javaClass: 'cn.hutool.core.util.HexUtil',
  encodeHexStr: (s) => cryptoUtils.hexEncodeToString(s),
  decodeHexStr: (s) => cryptoUtils.hexDecodeToString(s),
};
const jSecureUtil = { __javaClass: 'cn.hutool.crypto.SecureUtil', md5Hex: (s) => cryptoUtils.md5Encode(s) };
const jTimeoutCancellationException = class TimeoutCancellationException extends Error {
  constructor(m) { super(m == null ? 'timeout' : String(m)); this.name = 'TimeoutCancellationException'; }
};

/**
 * Rhino 里 Java 类可以不带 new 直接调用：SecretKeySpec(...) / StringBuilder() ...
 * 这里把 ES class 包成「可调用 + 可 new」的函数。
 */
function jclass(Cls) {
  const f = function (...args) { return new Cls(...args); };
  f.prototype = Cls.prototype;
  Object.defineProperty(f, 'name', { value: Cls.name, configurable: true });
  for (const k of Object.getOwnPropertyNames(Cls)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    try { f[k] = Cls[k]; } catch (e) { /* noop */ }
  }
  f.__javaClass = Cls.name;
  return f;
}

// 包路径 → 导出
const PKG_MAP = {
  'java.lang': { String, StringBuilder: jclass(jStringBuilder), Thread: jThread, Integer: jInteger, Long: jLong, Character: jCharacter, System: jSystem, Math: jMath, Object: jObject, Exception: jclass(jException), RuntimeException: jclass(jRuntimeException), Boolean: jBoolean, Double: jDouble, Number: jNumber, CharSequence: jCharSequence, Class: jClass, StringBuffer: jclass(jStringBuilder) },
  'java.util': { Base64: jBase64, Arrays: jArrays, Collections: jCollections, HashMap: jclass(jHashMap), ArrayList: jclass(jArrayList), List: jList, Map: jMap, Date: jDate, UUID: jUUID, Random: jclass(jRandom), Objects: jObjects, Scanner: jScanner },
  'javax.crypto': { Cipher: jclass(jCipher), Mac: jclass(jMac), CipherException: jclass(jCipherException) },
  'javax.crypto.spec': { SecretKeySpec: jclass(jSecretKeySpec), IvParameterSpec: jclass(jIvParameterSpec), DESKeySpec: jclass(jDESKeySpec) },
  'java.security': { MessageDigest: jMessageDigest },
  'java.security.spec': {},
  'java.text': { SimpleDateFormat: jclass(jSimpleDateFormat) },
  'java.net': { URLEncoder: jURLEncoder, URLDecoder: jURLDecoder, URI: jURI, URL: jURL },
  'android.text': { TextUtils: jTextUtils },
  'android.util': { Log: jLog },
  'android.webkit': { WebSettings: {} },
  'cn.hutool.core.codec': { Base64: jHutoolBase64 },
  'cn.hutool.core.util': { HexUtil: jHexUtil },
  'cn.hutool.crypto': { SecureUtil: jSecureUtil },
  'cn.hutool.crypto.digest': { DigestUtil: jDigestUtil },
  'io.legado.app.help.http': { StrResponse: StrResponseCtor },
  'io.legato.kazusa.utils': { TimeoutCancellationException: jclass(jTimeoutCancellationException) },
  'io.legado.app.utils': { GSON: { toJson: (o) => JSON.stringify(o), fromJson: (s) => { try { return JSON.parse(s); } catch (e) { return null; } } } },
  'org.jsoup': { Jsoup, JsoupElement, JsoupElements },
  'org.jsoup.nodes': { Document: JsoupElement, Element: JsoupElement, Elements: JsoupElements },
  'org.jsoup.select': { Elements: JsoupElements },
  'org.json': { JSONObject: Object, JSONArray: Array },
  'kotlin.text': {},
  'kotlin': {},
};

function resolvePkg(path) {
  const p = String(path);
  if (PKG_MAP[p]) return PKG_MAP[p];
  // 前缀匹配：Packages.io.legado 之类
  const out = {};
  for (const [k, v] of Object.entries(PKG_MAP)) {
    if (k.startsWith(p + '.')) {
      const rest = k.substring(p.length + 1).split('.')[0];
      out[rest] = out[rest] || {};
      Object.assign(out[rest], v);
    }
  }
  return out;
}

/** 构造 Packages.xxx.yyy 嵌套对象 */
function buildPackages() {
  const root = {};
  const getPkg = (path) => {
    const parts = path.split('.');
    let cur = root;
    for (const p of parts) {
      if (!cur[p]) cur[p] = {};
      cur = cur[p];
    }
    Object.assign(cur, PKG_MAP[path] || {});
    return cur;
  };
  for (const path of Object.keys(PKG_MAP)) getPkg(path);
  return root;
}

export const Packages = buildPackages();

/* ---------------- JavaImporter ---------------- */

export class JavaImporter {
  constructor(...pkgs) {
    for (const p of pkgs) this.importPackage(p);
  }

  importPackage(...pkgs) {
    const flat = [];
    const walk = (v) => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      flat.push(v);
    };
    pkgs.forEach(walk);
    for (const p of flat) {
      const name = typeof p === 'string' ? p : (p && p.__pkgPath) || null;
      if (!name) continue;
      const resolved = PKG_MAP[name] || resolvePkg(name);
      for (const [k, v] of Object.entries(resolved)) {
        if (!(k in this)) this[k] = v;
      }
    }
    return this;
  }
}

// Packages.java.lang 带 __pkgPath，便于 JavaImporter 解析
for (const [path, table] of Object.entries(PKG_MAP)) {
  const parts = path.split('.');
  let cur = Packages;
  for (const p of parts) { cur = cur[p]; }
  if (cur && typeof cur === 'object') {
    Object.defineProperty(cur, '__pkgPath', { value: path, enumerable: false });
  }
}

export function javaImportPackage(...pkgs) {
  const imp = new JavaImporter();
  imp.importPackage(...pkgs);
  // 全局 importPackage(x) 语义：把名字挂到全局（Rhino 里是挂到当前作用域）
  return imp;
}

/* ---------------- 字节工具 ---------------- */

function toBuffer(v) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (typeof v === 'object' && typeof v.length === 'number') return Buffer.from(v);
  return Buffer.from(String(v), 'utf8');
}

function toArrayLike(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v.length === 'number') return Array.from(v);
  return [];
}

/* ---------------- 安装到 sandbox ---------------- */

export function installJavaShims(sandbox, { logger = null } = {}) {
  sandbox.Packages = Packages;
  sandbox.JavaImporter = JavaImporter;
  sandbox.importPackage = (...pkgs) => {
    const imp = javaImportPackage(...pkgs);
    for (const [k, v] of Object.entries(imp)) if (!(k in sandbox)) sandbox[k] = v;
    return imp;
  };
  // 🛍️戊戟 / 🐉龙渊 / 🎁起点限免 用裸全局 org.jsoup.*
  sandbox.org = { jsoup: { Jsoup, JsoupElement, JsoupElements, parse: jsoupParse, nodes: { Document: JsoupElement, Element: JsoupElement, Elements: JsoupElements, Node: JsoupNode } } };
  sandbox.__legadoStrResponse = makeStrResponse;
  sandbox.__legadoBytes = toBuffer;
  sandbox.__legadoLog = (m) => { if (logger) logger(String(m)); };
  // scripts 里 `with (javaImport)` / `Packages.java.lang.String` 会遮住全局 String，
  // 解析到 PKG_MAP 里这份宿主 String（没有 getBytes/toCharArray）。
  // 因此 bootstrap 打完补丁后要把这张表里的 String 换成 realm 自己的构造函数。
  sandbox.__legadoBindRealmString = (S) => {
    try { PKG_MAP['java.lang'].String = S; } catch (e) { /* noop */ }
    try { Packages.java.lang.String = S; } catch (e) { /* noop */ }
  };
  return sandbox;
}

/**
 * 在 vm context 内部打补丁（realm 内的 String 是独立的，必须 runInContext 才能改到它）
 *  - String.prototype.getBytes(charset)  ← Java String.getBytes()
 */
export const SANDBOX_BOOTSTRAP = `
(function () {
  // ⚠ realm 割裂：_sandboxBase() 把宿主 String 赋成了 vm 全局，脚本里 String(x) 产出宿主字符串；
  // 而字面量 '' 属于 realm 自己的 String，两者原型不是同一个。legado 里字符串就是 Java String
  // （Rhino 直接给 String 加 getBytes），不存在这种分裂，所以两边都要补。
  // 注意：宿主 Object.getPrototypeOf(primitive) 会返回【宿主】String.prototype，不能用它取 realm 原型，
  // 必须走字面量自身的 constructor。
  var nativeGetBytes = function (cs) {
    var s = String(this);
    try { return __legadoBytes(s, cs || 'utf-8'); } catch (e) { return __legadoBytes(s); }
  };
  var nativeToCharArray = function () { return String(this).split(''); };
  var patch = function (proto) {
    if (!proto) return;
    try { Object.defineProperty(proto, 'getBytes', { value: nativeGetBytes, writable: true, configurable: true }); } catch (e) {}
    try { Object.defineProperty(proto, 'toCharArray', { value: nativeToCharArray, writable: true, configurable: true }); } catch (e) {}
  };
  var realmString = ''.constructor;
  patch(realmString.prototype);
  try { patch(String.prototype); } catch (e) {}
  // 书源用 with (JavaImporter) / Packages.java.lang.String，会解析到 PKG_MAP 里那份宿主 String，
  // 一并换成 realm 的构造函数。
  try { __legadoBindRealmString(realmString); } catch (e) {}
})();
`;