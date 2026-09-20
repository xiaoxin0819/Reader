// net-utils —— 移植自 legado
//   io.legado.app.utils.NetworkUtils  (getAbsoluteURL / getBaseUrl / getSubDomain / getDomain
//                                      encodedQuery / encodedForm)
//   io.legado.app.utils.EncoderUtils.escape
//   io.legado.app.model.analyzeRule.AnalyzeUrl.encodeParams / appendEncoded
import { encodeBytes } from './charset.mjs';

export function isAbsUrl(s) {
  if (!s) return false;
  return /^https?:\/\//i.test(String(s));
}

export function isDataUrl(s) {
  if (!s) return false;
  return /^data:.*?;base64,(.*)/s.test(String(s));
}

// Kotlin: NetworkUtils.getAbsoluteURL(baseURL: String?, relativePath: String)
export function getAbsoluteURL(base, rel) {
  const relativePath = rel == null ? '' : String(rel);
  if (base == null || base === '') return relativePath.trim();
  let u = null;
  try {
    u = new URL(String(base).split(',')[0]);
  } catch (e) {
    u = null;
  }
  return getAbsoluteURLFromUrl(u, relativePath);
}

// Kotlin: NetworkUtils.getAbsoluteURL(baseURL: URL?, relativePath: String)
export function getAbsoluteURLFromUrl(baseUrl, relativePath) {
  const rel = relativePath == null ? '' : String(relativePath);
  const relTrim = rel.trim();
  if (baseUrl == null) return relTrim;
  if (isAbsUrl(relTrim)) return relTrim;
  if (isDataUrl(relTrim)) return relTrim;
  if (relTrim.startsWith('javascript')) return '';
  // legado 用 java.net.URL，其 toString() 不做百分号规范化，形如
  //   /api/v5/book/detail?id=1,{"headers":{"app-version":"80400"}}
  // 的 UrlOption 段会被原样带出；WHATWG URL 却把 '"' 规范成 %22，导致后续
  // JSON.parse(options) 失败 → headers 全部丢失（七猫这类 API 源直接回
  // {"Status":"Unauthorized"}，报错还会被 JS 运行器回退掩盖成 Unexpected token）。
  // 这里按 legado AnalyzeUrl 的 paramPattern 语义切成 [地址, 选项]，只绝对化地址。
  const opt = URL_OPTION_PATTERN.exec(relTrim);
  const urlPart = opt ? relTrim.substring(0, opt.index) : relTrim;
  const optPart = opt ? relTrim.substring(opt.index) : '';
  let relativeUrl = urlPart;
  try {
    relativeUrl = new URL(urlPart, baseUrl).toString();
  } catch (e) {
    /* 拼接出错时保持原样，与 Kotlin 一致 */
  }
  return relativeUrl + optPart;
}

/** legado AnalyzeUrl.paramPattern：地址与 UrlOption 的分隔（',{' ，允许空白） */
const URL_OPTION_PATTERN = /\s*,\s*(?=\s*\{)/;


export function getBaseUrl(url) {
  if (url == null) return null;
  const u = String(url);
  if (/^http:\/\//i.test(u) || /^https:\/\//i.test(u)) {
    const index = u.indexOf('/', 9);
    return index === -1 ? u : u.substring(0, index);
  }
  return null;
}

// 简化版公共后缀表（覆盖常见多段后缀），用于 getSubDomain 取 eTLD+1
const MULTI_SUFFIX = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'org.hk', 'edu.hk', 'gov.hk', 'net.hk', 'com.tw', 'org.tw',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'com.sg', 'com.my',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.kr', 'or.kr', 'com.au',
]);

export function isIPv4(s) {
  if (!s) return false;
  const parts = String(s).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIPv6(s) {
  return !!s && String(s).includes(':') && /^[0-9a-fA-F:]+$/.test(String(s));
}

export function isIPAddress(s) {
  return isIPv4(s) || isIPv6(s);
}

// Kotlin: NetworkUtils.getSubDomain
export function getSubDomain(url) {
  const baseUrl = getBaseUrl(url);
  if (!baseUrl) return String(url);
  try {
    const host = new URL(baseUrl).hostname;
    if (isIPAddress(host)) return host;
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const last2 = labels.slice(-2).join('.');
    if (MULTI_SUFFIX.has(last2)) return labels.slice(-3).join('.');
    return last2;
  } catch (e) {
    return baseUrl;
  }
}

export function getDomain(url) {
  const baseUrl = getBaseUrl(url);
  if (!baseUrl) return String(url);
  try {
    return new URL(baseUrl).hostname;
  } catch (e) {
    return baseUrl;
  }
}

// ---------- encodedQuery / encodedForm ----------
function buildBitSet(chars) {
  const bits = new Uint8Array(256);
  for (const ch of chars) bits[ch.charCodeAt(0) & 0xff] = 1;
  return bits;
}

const notNeedEncodingQuery = buildBitSet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$&()*+,-./:;=?@[\\]^_`{|}~'
);
const notNeedEncodingForm = buildBitSet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*-._'
);

function isDigit16Char(c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
}

function encodedWith(str, bitset) {
  let needEncode = false;
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (bitset[c.charCodeAt(0) & 0xff]) {
      i++;
      continue;
    }
    if (c === '%' && i + 2 < str.length) {
      i++;
      const c1 = str[i];
      i++;
      const c2 = str[i];
      if (isDigit16Char(c1) && isDigit16Char(c2)) {
        i++;
        continue;
      }
      i--;
    }
    needEncode = true;
    break;
  }
  return !needEncode;
}

export function encodedQuery(str) {
  return encodedWith(str, notNeedEncodingQuery);
}

export function encodedForm(str) {
  return encodedWith(str, notNeedEncodingForm);
}

// Kotlin: EncoderUtils.escape —— 仅 0-9A-Za-z 直通，其余按码元转义
export function escape(src) {
  const s = src == null ? '' : String(src);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
      continue;
    }
    const prefix = code < 16 ? '%0' : code < 256 ? '%' : '%u';
    out += prefix + code.toString(16);
  }
  return out;
}

// Java: URLEncoder.encode(s, charset)
const JAVA_URLENCODER_SAFE = buildBitSet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.*'
);

export function javaUrlEncode(str, charsetName = 'utf-8') {
  const bytes = encodeBytes(str, charsetName);
  let out = '';
  for (const b of bytes) {
    if (b === 0x20) {
      out += '+';
    } else if (JAVA_URLENCODER_SAFE[b]) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// hutool: RFC3986.UNRESERVED + "!$%&()*+,/:;=?@[\]^`{|}"
const QUERY_ENCODER_SAFE = buildBitSet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$%&()*+,/:;=?@[\\]^`{|}'
);

export function percentEncode(str, charsetName = 'utf-8') {
  const bytes = encodeBytes(str, charsetName);
  let out = '';
  for (const b of bytes) {
    if (QUERY_ENCODER_SAFE[b]) out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Kotlin: AnalyzeUrl.encodeParams
export function encodeParams(params, charsetName, isQuery) {
  const checkEncoded = charsetName == null || charsetName === '';
  const charset = charsetName == null || charsetName === ''
    ? 'utf-8'
    : String(charsetName).toLowerCase() === 'escape'
      ? null
      : charsetName;

  if (isQuery && charset !== null) {
    if (encodedQuery(params)) return params;
    return percentEncode(params, charset);
  }

  const len = params.length;
  let sb = '';
  let pos = 0;
  while (pos <= len) {
    if (sb.length > 0) sb += '&';
    let ampOffset = params.indexOf('&', pos);
    if (ampOffset === -1) ampOffset = len;
    const eqOffset = params.indexOf('=', pos);
    let key;
    let value;
    if (eqOffset === -1 || eqOffset > ampOffset) {
      key = params.substring(pos, ampOffset);
      value = null;
    } else {
      key = params.substring(pos, eqOffset);
      value = params.substring(eqOffset + 1, ampOffset);
    }
    sb += appendEncoded(key, checkEncoded, charset);
    if (value !== null) {
      sb += '=';
      sb += appendEncoded(value, checkEncoded, charset);
    }
    pos = ampOffset + 1;
  }
  return sb;
}

function appendEncoded(value, checkEncoded, charset) {
  if (checkEncoded && encodedForm(value)) return value;
  if (charset === null) return escape(value);
  return javaUrlEncode(value, charset);
}

// ---------- 字符串判定（StringExtensions.kt） ----------
export function isJson(s) {
  if (s == null) return false;
  const t = String(s).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

export function isJsonObject(s) {
  if (s == null) return false;
  const t = String(s).trim();
  return t.startsWith('{') && t.endsWith('}');
}

export function isJsonArray(s) {
  if (s == null) return false;
  const t = String(s).trim();
  return t.startsWith('[') && t.endsWith(']');
}

/**
 * 宽松 JSON 解析（等价 legado AnalyzeUrl / BaseSource 里 GSONStrict 失败后回退 GSON 的行为）。
 *
 * Gson 的 lenient 模式接受：
 *   - 单引号字符串（'a'）
 *   - 不带引号的键（{a:1}），也接受不带引号的裸值（{a:true} / {a:1}）
 *   - 多余的尾逗号（[1,2,]）
 * Gson 的 **单引号字符串里允许直接出现双引号**，所以不能先用正则把 ' 换成 " ——
 * 那样 {"click":"showCmt('u','番茄')"} 会被切坏（图片段评就是这种写法）。
 * 这里按字符扫一遍再重建标准 JSON，语义与 Gson lenient 一致。
 *
 * 解析成功返回对象/数组/标量，失败返回 null（调用方按“没有链接参数”处理）。
 */
export function parseRelaxedJson(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  try { return JSON.parse(t); } catch (e) { /* 落到宽松路径 */ }
  try { return new LenientJsonParser(t).parse(); } catch (e) { return null; }
}

/** 复刻 Gson 的 lenient JsonReader：单引号串 / 裸键 / 裸值 / 尾逗号 */
class LenientJsonParser {
  constructor(text) { this.s = text; this.i = 0; }

  parse() {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) throw new Error('trailing data');
    return v;
  }

  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }

  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) return null;
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"' || c === "'") return this.string();
    // 裸值：true / false / null / 数字 / 未加引号的字符串（Gson lenient 允许）
    const b = this.i;
    while (this.i < this.s.length && !/[,\]}:]/.test(this.s[this.i])) this.i++;
    const raw = this.s.slice(b, this.i).trim();
    if (raw === '') throw new Error('empty value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }

  string() {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '\\') {
        const n = this.s[this.i + 1];
        this.i += 2;
        if (n === undefined) break;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === 'u') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; }
        else out += n;
        continue;
      }
      if (c === q) { this.i++; return out; }
      out += c; this.i++;
    }
    throw new Error('unterminated string');
  }

  /** 键：加引号 / 单引号 / 裸标识符都接受 */
  key() {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const b = this.i;
    while (this.i < this.s.length && !/[\s:]/.test(this.s[this.i])) this.i++;
    const raw = this.s.slice(b, this.i);
    if (raw === '') throw new Error('empty key');
    return raw;
  }

  object() {
    this.i++; // {
    const o = {};
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return o; }
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return o; }   // 尾逗号
      const k = this.key();
      this.ws();
      if (this.s[this.i] !== ':') throw new Error('expect :');
      this.i++;
      o[k] = this.value();
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; continue; }
      if (c === '}') { this.i++; return o; }
      throw new Error('expect , or }');
    }
  }

  array() {
    this.i++; // [
    const a = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return a; }
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return a; }   // 尾逗号
      a.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; continue; }
      if (c === ']') { this.i++; return a; }
      throw new Error('expect , or ]');
    }
  }
}

export function isXml(s) {
  if (s == null) return false;
  const t = String(s).trim();
  return t.startsWith('<') && t.endsWith('>');
}

export function isTrue(s, nullIsTrue = false) {
  if (s == null || String(s).trim() === '' || s === 'null') return nullIsTrue;
  return !/^(?:false|no|not|0|0\.0)$/i.test(String(s).trim());
}

export function splitNotBlank(str, delimiter, limit = 0) {
  if (str == null) return [];
  if (delimiter instanceof RegExp) {
    return String(str)
      .split(delimiter, limit || undefined)
      .map((x) => x.trim())
      .filter((x) => x !== '');
  }
  return String(str)
    .split(delimiter, limit || undefined)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}