// http-core.mjs —— 原生 HTTP 请求核心（在 net worker 内运行，异步）
// 对应 legado 的 okhttp 请求层：重定向控制 / 超时 / 解压 / 编码嗅探
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import iconv from 'iconv-lite';
import { normalizeCharset } from './charset.mjs';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
};

function parseCharsetFromContentType(ct) {
  if (!ct) return null;
  const m = /charset\s*=\s*"?([\w\-]+)"?/i.exec(String(ct));
  return m ? m[1] : null;
}

export function sniffCharset(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  const head = b.subarray(0, Math.min(b.length, 1 << 20));
  const strict = head.subarray(0, Math.max(0, head.length - 3));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(strict);
    return 'utf-8';
  } catch (e) { /* not utf8 */ }
  const bad = (t) => (t.match(/\uFFFD/g) || []).length;
  const bu = bad(head.toString('utf8'));
  const bg = bad(iconv.decode(head, 'gb18030'));
  return bu <= bg ? 'utf-8' : 'gb18030';
}

export function decodeBody(buf, { contentType = null, charset = null } = {}) {
  const cs = normalizeCharset(charset)
    || normalizeCharset(parseCharsetFromContentType(contentType))
    || sniffCharset(buf);
  const use = normalizeCharset(cs) || 'utf-8';
  if (use === 'utf-8' || use === 'utf16-le' || use === 'utf16-be') {
    let b = Buffer.from(buf);
    if (use === 'utf-8' && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
    return { text: b.toString(use === 'utf-8' ? 'utf8' : use), charset: use };
  }
  return { text: iconv.decode(Buffer.from(buf), use), charset: use };
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf); } catch (e) { return zlib.inflateRawSync(buf); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { /* 解压失败按原文返回 */ }
  return buf;
}

function normalizeHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    const v = h[k];
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function sendOnce(target, { method, headers, body, readTimeoutMs, callTimeoutMs, rejectUnauthorized, proxy }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      agent: isHttps ? agents.https : agents.http,
    };
    if (isHttps) reqOpts.rejectUnauthorized = rejectUnauthorized !== false ? true : false;
    let settled = false;
    let timer = null;
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          code: res.statusCode || 0,
          message: res.statusMessage || '',
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (e) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
    if (readTimeoutMs) req.setTimeout(readTimeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(Object.assign(new Error('read timeout'), { code: 'ETIMEDOUT' }));
    });
    if (callTimeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy(Object.assign(new Error('call timeout'), { code: 'ETIMEDOUT' }));
      }, callTimeoutMs);
      if (timer.unref) timer.unref();
    }
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    if (body !== undefined && body !== null && body.length !== 0) req.write(body);
    req.end();
  });
}

function setCookiesOf(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.slice() : [String(raw)];
}

/**
 * 发起请求，内部处理重定向链（legado 用 okhttp 的 followRedirects）
 * @returns {Promise<{url, code, message, headers, body, setCookies, hops, bodyRaw}>}
 */
export async function requestRaw(opts) {
  const {
    url, method = 'GET', headers = {}, body = null,
    readTimeoutMs = 60000, callTimeoutMs = null,
    followRedirects = true, maxRedirects = 6,
    rejectUnauthorized = true, proxy = null, bodyEncoding = null,
  } = opts;

  let current = new URL(url);
  let curMethod = String(method || 'GET').toUpperCase();
  let curBody = body;
  const setCookies = [];
  const hops = [];
  let attempt = 0;

  for (;;) {
    const h = normalizeHeaders(headers);
    if (!h['Host'] && !h['host']) {
      h['Host'] = current.host;
    }
    if (!h['Accept-Encoding'] && !h['accept-encoding']) {
      h['Accept-Encoding'] = 'gzip, deflate';
    } else if (String(h['Accept-Encoding']).toLowerCase() === 'null') {
      delete h['Accept-Encoding'];
    }
    if (!h['Connection'] && !h['connection']) h['Connection'] = 'Keep-Alive';
    if (!h['Cache-Control'] && !h['cache-control']) h['Cache-Control'] = 'no-cache';
    if (!h['User-Agent'] && !h['user-agent']) h['User-Agent'] = DEFAULT_UA;
    const payload = curBody === null || curBody === undefined ? null
      : (Buffer.isBuffer(curBody) ? curBody : Buffer.from(String(curBody), bodyEncoding || 'utf8'));
    if (payload) h['Content-Length'] = String(payload.length);

    const requestUrl = proxy ? buildProxyTarget(current, proxy) : current;
    let res;
    try {
      res = await sendOnce(requestUrl, {
        method: curMethod, headers: h, body: payload,
        readTimeoutMs, callTimeoutMs, rejectUnauthorized, proxy,
      });
    } catch (e) {
      throw e;
    }
    for (const c of setCookiesOf(res.headers)) setCookies.push(c);
    hops.push({ url: current.toString(), code: res.code });
    const loc = res.headers['location'];
    const isRedirect = res.code >= 300 && res.code <= 399;
    if (!isRedirect || !followRedirects || !loc || attempt >= maxRedirects) {
      const encoding = res.headers['content-encoding'];
      const raw = decompress(res.body, encoding);
      const ct = res.headers['content-type'] || null;
      const decoded = decodeBody(raw, { contentType: ct });
      return {
        url: current.toString(),
        code: res.code,
        message: res.message,
        headers: res.headers,
        body: decoded.text,
        charset: decoded.charset,
        bodyRaw: raw,
        setCookies,
        hops,
      };
    }
    attempt++;
    let next;
    try { next = new URL(String(loc), current); } catch (e) { break; }
    if (next.protocol === 'http:' && current.protocol === 'https:') {
      // 跨协议降级：按 okhttp 默认继续跟随
    }
    if (res.code === 303 || ((res.code === 301 || res.code === 302) && curMethod === 'POST')) {
      curMethod = 'GET';
      curBody = null;
    }
    current = next;
  }
  // 未能继续重定向时返回最后一次结果
  return { url: current.toString(), code: 0, message: 'redirect loop', headers: {}, body: '', setCookies, hops };
}

function buildProxyTarget(target, proxy) {
  return target;
}

export function closeAgents() {
  try { agents.http.destroy(); } catch (e) { /* noop */ }
  try { agents.https.destroy(); } catch (e) { /* noop */ }
}