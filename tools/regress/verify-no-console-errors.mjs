// 运行时检查：用无头浏览器打开阅读器，收集所有 console 错误 / 未捕获异常。
//
// 只读验证：进度写请求被 CDP 拦断；正文/目录请求正常放行。
// 目的：抓出静态检查发现不了的运行时问题（未定义变量、类型错误等）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:7788';
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9391);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    });
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, timeout);
    });
  }
}
async function openWs(url) {
  const ws = new WebSocket(url);
  await Promise.race([
    new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('WS 失败')), { once: true }); }),
    sleep(10000).then(() => { throw new Error('WS 超时'); }),
  ]);
  return new CDP(ws);
}

const cleanupFns = [];
const cleanup = async () => { for (const f of cleanupFns.reverse()) { try { await f(); } catch {} } };

const profile = path.join(os.tmpdir(), 'reader-console-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
cleanupFns.push(() => {
  const p = path.resolve(profile);
  if (p.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(p, { recursive: true, force: true });
});

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update',
  '--window-size=1500,950', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
cleanupFns.push(() => edge.kill('SIGKILL'));

let version = null;
for (let i = 0; i < 200; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(50); }
}
if (!version) { console.error('浏览器没起来'); await cleanup(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const page = await openWs(tab.webSocketDebuggerUrl);
cleanupFns.push(async () => { try { await page.ws.close(); } catch {} });

const errors = [];
page.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push('未捕获异常: ' + (d.text || '') + ' ' + (d.exception?.description || ''));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
});

await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/online/progress*', requestStage: 'Request' }] });
page.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Fetch.requestPaused') {
    page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Aborted' }).catch(() => {});
  }
});

const evalJs = async (expression, awaitPromise = false) => {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + String(r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

try {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../reader.config.json', import.meta.url), 'utf8'));
  const books = cfg.online.books || [];
  const progress = cfg.online.progress || {};
  const pick = books
    .map((b) => ({ b, rel: `${b.origin}|${b.bookUrl}`, at: Number((progress[`${b.origin}|${b.bookUrl}`] || {}).at) || 0 }))
    .sort((a, b) => b.at - a.at)[0];
  if (!pick) throw new Error('书架为空');
  console.log(`目标书：${pick.b.originName} / ${pick.b.name}`);

  await page.send('Page.navigate', { url: BASE + '/' });
  await sleep(400);
  await evalJs([
    "localStorage.setItem('readerMode','online');",
    `localStorage.setItem('lastOnlineRel', ${JSON.stringify(pick.rel)});`,
    "'ok'",
  ].join('\n'));
  await page.send('Page.navigate', { url: BASE + '/' });

  // 等正文渲染
  let ready = false;
  for (let i = 0; i < 600; i++) {
    try { ready = await evalJs("typeof state!=='undefined' && state.mode==='online' && state.book && document.getElementById('content').textContent.trim().length>100"); } catch {}
    if (ready) break;
    await sleep(100);
  }
  console.log('正文渲染:', ready ? '成功' : '失败');

  // 触发几个常用交互，看是否有运行时错误
  const probes = [
    ['打开设置面板', "$('btnSettings').click(); 'ok'"],
    ['关闭设置面板', "$('setClose').click(); 'ok'"],
    ['打开书源面板', "$('btnSources').click(); 'ok'"],
    ['渲染书源列表', "typeof renderSources==='function' ? (renderSources(), 'ok') : 'skip'"],
    ['切目录顺序', "typeof toggleTocOrder==='function' ? (toggleTocOrder(), 'ok') : 'skip'"],
    ['预取函数存在', "typeof prefetchNeighbors==='function' ? 'ok' : 'missing'"],
    ['预取半径值', "typeof PREFETCH_RADIUS!=='undefined' ? String(PREFETCH_RADIUS) : 'undefined'"],
    ['章节缓存大小', "typeof chapterCache!=='undefined' ? String(chapterCache.size) : 'undefined'"],
  ];
  console.log('\n交互探测：');
  for (const [label, expr] of probes) {
    try {
      const r = await evalJs(expr);
      console.log(`  ${label.padEnd(16)} ${r}`);
    } catch (e) {
      console.log(`  ${label.padEnd(16)} 抛错: ${e.message.slice(0, 100)}`);
    }
    await sleep(200);
  }

  await sleep(1500);
  console.log('\n=== 控制台错误汇总 ===');
  // 过滤掉预期内的网络中断（我们主动 fail 了进度写请求）
  const real = errors.filter((e) => !/api\/online\/progress|Failed to fetch|Aborted|ERR_FAILED|net::/i.test(e));
  if (!real.length) console.log('无（干净）');
  else { for (const e of real.slice(0, 20)) console.log('  ✗ ' + e); }
  console.log(`\n原始错误 ${errors.length} 条，过滤后 ${real.length} 条`);

  await page.ws.close();
  await cleanup();
  process.exit(real.length ? 1 : 0);
} catch (e) {
  console.error('验证失败：' + (e && e.message));
  await cleanup();
  process.exit(1);
}
