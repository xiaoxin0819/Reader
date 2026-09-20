// charset —— 文本编码/解码工具（GBK/Big5/UTF-8/UTF-16 …）
import iconv from 'iconv-lite';

const ALIAS = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big-5': 'big5',
  'latin1': 'latin1',
  'iso-8859-1': 'latin1',
  'us-ascii': 'ascii',
  'ascii': 'ascii',
  'utf-16': 'utf16-le',
  'utf-16le': 'utf16-le',
  'utf-16be': 'utf16-be',
  'ucs-2': 'utf16-le',
  'unicode': 'utf16-le',
};

export function normalizeCharset(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/\s|_/g, '-');
  return ALIAS[key] || (iconv.encodingExists(key) ? key : null);
}

export function assertCharset(name) {
  const cs = normalizeCharset(name);
  if (!cs) throw new Error(`unsupported charset: ${name}`);
  return cs;
}

export function encodeBytes(str, charsetName) {
  const cs = normalizeCharset(charsetName) || 'utf-8';
  if (cs === 'utf-8') return Buffer.from(String(str), 'utf8');
  return iconv.encode(String(str), cs);
}

export function decodeBytes(buf, charsetName) {
  const cs = normalizeCharset(charsetName) || 'utf-8';
  if (cs === 'utf-8') return Buffer.from(buf).toString('utf8');
  return iconv.decode(Buffer.from(buf), cs);
}

export function charsetExists(name) {
  return !!normalizeCharset(name);
}

export { iconv };