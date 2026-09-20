// crypto-utils.mjs —— JsEncodeUtils / SymmetricCryptoAndroid 的 node:crypto 实现
import crypto from 'node:crypto';
import iconv from 'iconv-lite';

export function md5Encode(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

export function md5Encode16(str) {
  return md5Encode(str).substring(8, 24);
}

export function base64Encode(str, flags = 2) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

export function base64Decode(str, charset = 'utf-8') {
  if (str == null || str === '') return '';
  return Buffer.from(String(str), 'base64').toString(charset || 'utf8');
}

export function base64DecodeToByteArray(str) {
  if (str == null || str === '') return null;
  return Buffer.from(String(str), 'base64');
}

export function hexDecodeToByteArray(hex) {
  return Buffer.from(String(hex), 'hex');
}

export function hexDecodeToString(hex) {
  return Buffer.from(String(hex), 'hex').toString('utf8');
}

export function hexEncodeToString(utf8) {
  return Buffer.from(String(utf8), 'utf8').toString('hex');
}

export function strToBytes(str, charset = 'utf-8') {
  return iconv.encode(String(str), normalizeCharsetName(charset));
}

export function bytesToStr(bytes, charset = 'utf-8') {
  return iconv.decode(Buffer.from(bytes), normalizeCharsetName(charset));
}

function normalizeCharsetName(c) {
  const n = String(c || 'utf-8').toLowerCase().replace(/[\s_]/g, '');
  if (n === 'utf8') return 'utf-8';
  return n;
}

/* ------------------------------------------------------------------ *
 * SymmetricCrypto（对应 hutool SymmetricCrypto + SymmetricCryptoAndroid）
 * transformation 形如 "AES/CBC/PKCS5Padding" / "AES" / "DESede/ECB/NoPadding"
 * ------------------------------------------------------------------ */
export function parseTransformation(transformation) {
  const parts = String(transformation || '').split('/').filter((s) => s !== '');
  const alg = (parts[0] || 'AES').trim().toUpperCase();
  const mode = (parts[1] || 'ECB').trim().toUpperCase();
  const padding = (parts[2] || 'PKCS5Padding').trim();
  let nodeAlg;
  let fixedLen = null;
  if (alg === 'AES') nodeAlg = 'aes';
  else if (alg === 'DESEDE' || alg === 'TRIPLEDES' || alg === '3DES') nodeAlg = 'des-ede3';
  else if (alg === 'DES') { nodeAlg = 'des'; fixedLen = 64; }
  else nodeAlg = alg.toLowerCase().replace(/-/g, '');
  const nodeMode = mode.toLowerCase();
  const pUpper = String(padding).toUpperCase();
  const noPad = pUpper.startsWith('NOPADDING') || pUpper === 'NONE';
  return {
    alg, mode, padding, noPad, nodeAlg, fixedLen, nodeMode,
  };
}

function cipherName(t, keyLen) {
  if (t.nodeAlg === 'aes') return `aes-${keyLen * 8}-${t.nodeMode}`;
  if (t.nodeAlg === 'des-ede3') return `des-ede3-${t.nodeMode}`;
  return `${t.nodeAlg}-${t.nodeMode}`;
}

export class SymmetricCrypto {
  constructor(transformation, key, iv) {
    this.transformation = transformation;
    this.parsed = parseTransformation(transformation);
    this.algorithmName = this.parsed.alg;
    this.key = toBuffer(key);
    const ivBuf = toBuffer(iv);
    this.iv = ivBuf.length > 0 ? ivBuf : null;
  }

  setIv(iv) {
    const b = toBuffer(iv);
    if (b.length > 0) this.iv = b;
    return this;
  }

  _name() {
    return cipherName(this.parsed, this.key.length);
  }

  _ivArg() {
    if (this.parsed.nodeMode === 'ecb') return null;
    return this.iv;
  }

  encrypt(data, charset = 'utf-8') {
    const c = crypto.createCipheriv(this._name(), this.key, this._ivArg());
    if (!this.parsed.noPad) c.setAutoPadding(true);
    const input = Buffer.isBuffer(data) ? data : iconv.encode(String(data), normalizeCharsetName(charset));
    return Buffer.concat([c.update(input), c.final()]);
  }

  decrypt(data, charset = 'utf-8') {
    const d = crypto.createDecipheriv(this._name(), this.key, this._ivArg());
    d.setAutoPadding(!this.parsed.noPad);
    let input;
    if (Buffer.isBuffer(data)) input = data;
    else if (typeof data === 'string') input = isHexStr(data) ? Buffer.from(data, 'hex') : Buffer.from(data, 'base64');
    else input = Buffer.from(String(data));
    return Buffer.concat([d.update(input), d.final()]);
  }

  decryptStr(data, charset = 'utf-8') {
    return this.decrypt(data).toString(charset || 'utf8');
  }

  encryptBase64(data, charset = 'utf-8') {
    return this.encrypt(data, charset).toString('base64');
  }

  encryptHex(data, charset = 'utf-8') {
    return this.encrypt(data, charset).toString('hex');
  }
}

export function isHexStr(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(s);
}

function toBuffer(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v);
  return Buffer.from(String(v), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 便捷函数（JsEncodeUtils 里的 Deprecated 一族，部分旧书源仍在用）
 * ------------------------------------------------------------------ */
export function createSymmetricCrypto(transformation, key, iv) {
  return new SymmetricCrypto(transformation, key, iv);
}

export function aesDecodeToString(str, key, transformation, iv) {
  return new SymmetricCrypto(transformation, key, iv).decryptStr(str);
}

export function aesEncodeToString(data, key, transformation, iv) {
  return new SymmetricCrypto(transformation, key, iv).encryptBase64(data);
}

export function aesDecodeArgsBase64Str(data, key, mode, padding, iv) {
  return new SymmetricCrypto(
    `AES/${mode}/${padding}`,
    Buffer.from(key, 'base64'),
    Buffer.from(iv, 'base64'),
  ).decryptStr(data);
}

export function desDecodeToString(str, key, transformation, iv) {
  return new SymmetricCrypto(transformation, key, iv).decryptStr(str);
}

export function tripleDESDecodeToString(str, key, transformation, iv) {
  return new SymmetricCrypto(transformation, key, iv).decryptStr(str);
}

/* ------------------------------------------------------------------ *
 * toNumChapter（AppPattern.titleNumPattern）
 * ------------------------------------------------------------------ */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function cnNumToInt(s) {
  if (/^\d+$/.test(s)) return Number(s);
  let num = 0;
  let section = 0;
  let total = 0;
  for (const ch of s) {
    if (ch === '万') { section = (section + num) * 10000; total += section; section = 0; num = 0; continue; }
    if (ch === '千') { section += (num || 1) * 1000; num = 0; continue; }
    if (ch === '百') { section += (num || 1) * 100; num = 0; continue; }
    if (ch === '十') { section += (num || 1) * 10; num = 0; continue; }
    const d = CN_DIGIT[ch];
    if (d === undefined) return null;
    num = d;
  }
  return total + section + num;
}

export function toNumChapter(s) {
  if (s == null) return null;
  const m = /(第)(.+?)(章)/.exec(String(s));
  if (!m) return String(s);
  const n = cnNumToInt(m[2]);
  if (n == null) return String(s);
  return `${m[1]}${n}${m[3]}`;
}

/* ------------------------------------------------------------------ *
 * 时间格式化（java.timeFormat -> yyyy/MM/dd HH:mm）
 * ------------------------------------------------------------------ */
export function timeFormat(time) {
  const d = new Date(Number(time));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function randomUUID() {
  return crypto.randomUUID();
}

export function digestHex(data, algorithm = 'md5') {
  return crypto.createHash(String(algorithm).toLowerCase()).update(String(data), 'utf8').digest('hex');
}

export function digestBase64Str(data, algorithm = 'md5') {
  return crypto.createHash(String(algorithm).toLowerCase()).update(String(data), 'utf8').digest('base64');
}

export function hmacHex(data, algorithm = 'HmacSHA256', key = '') {
  return crypto.createHmac(String(algorithm).replace(/^hmac/i, '').toLowerCase() || 'sha256', String(key)).update(String(data), 'utf8').digest('hex');
}

export function hmacBase64(data, algorithm = 'HmacSHA256', key = '') {
  return crypto.createHmac(String(algorithm).replace(/^hmac/i, '').toLowerCase() || 'sha256', String(key)).update(String(data), 'utf8').digest('base64');
}