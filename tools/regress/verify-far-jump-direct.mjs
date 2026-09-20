// 回归：目录远距离跳章必须是“直接换章”，不能误走滚轮连续滚动动画。
// 同时验证：目录 hover 不再预取任意章节（避免风控站点被扫射）、
// pending 章节必须显示加载反馈、失败后状态留在旧章。
// 进度写请求会被 CDP 拦断，不改变服务端阅读进度。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:7788";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9351);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const cleanupFns = [];
const cleanup = async () => { for (const f of cleanupFns.reverse()) { try { await f(); } catch {} } };
const watchdog = setTimeout(async () => { console.error("!! 超时"); await cleanup(); process.exit(2); }, 120000);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) { this.pending.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("CDP 超时: " + method)); } }, timeout);
    });
  }
}
async function openWs(url) {
  const ws = new WebSocket(url);
  await Promise.race([
    new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", () => j(new Error("WS 失败")), { once: true }); }),
    sleep(10000).then(() => { throw new Error("WS 超时"); }),
  ]);
  return new CDP(ws);
}

const profile = path.join(os.tmpdir(), "rzfarjump-" + Date.now());
fs.mkdirSync(profile, { recursive: true });
cleanupFns.push(() => {
  const p = path.resolve(profile);
  if (p.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(p, { recursive: true, force: true });
});

const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-component-update",
  "--window-size=1500,950", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
cleanupFns.push(() => edge.kill("SIGKILL"));

let version = null;
for (let i = 0; i < 200; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(50); }
}
if (!version) { console.error("浏览器没起来"); await cleanup(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await openWs(tab.webSocketDebuggerUrl);
cleanupFns.push(async () => { try { await page.ws.close(); } catch {} });
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Fetch.enable", { patterns: [{ urlPattern: "*api/online/progress*", requestStage: "Request" }] });
page.ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Fetch.requestPaused") {
    page.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Aborted" }).catch(() => {});
  }
});

const evalJs = async (expression, awaitPromise = false) => {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + String(r.exceptionDetails.exception?.description || ""));
  return r.result.value;
};

try {
  await page.send("Page.navigate", { url: BASE + "/" });
  for (let i = 0; i < 200; i++) {
    if (await evalJs("document.readyState === 'complete'").catch(() => false)) break;
    await sleep(100);
  }
  await evalJs("localStorage.setItem('readerMode','online'); 'ok'");
  await page.send("Page.navigate", { url: BASE + "/" });
  for (let i = 0; i < 300; i++) {
    if (await evalJs("typeof state !== 'undefined' && state.mode === 'online' && (state.books||[]).length > 0").catch(() => false)) break;
    await sleep(100);
  }
  // 回归不碰速读谷：它已被确认有风控，测试书固定选非速读谷来源。
  const testRel = await evalJs(`(state.books || []).find(function (b) {
    return String(b.origin || '').indexOf('shudugu.org') < 0 && String(b.origin || '').indexOf('sudugu.org') < 0;
  })?.rel || ''`);
  if (!testRel) throw new Error("在线书架没有书籍");
  await evalJs(`localStorage.setItem('lastOnlineRel', ${JSON.stringify(testRel)}); 'ok'`);
  await page.send("Page.navigate", { url: BASE + "/" });
  for (let i = 0; i < 300; i++) {
    if (await evalJs("document.readyState === 'complete' && typeof state !== 'undefined' && state.mode === 'online' && !!state.book && (state.book.chapterCount || 0) > 5").catch(() => false)) break;
    await sleep(100);
  }
  const ready = await evalJs("typeof state !== 'undefined' && state.mode === 'online' && !!state.book && (state.book.chapterCount || 0) > 5").catch(() => false);
  check("在线正文已恢复且目录足够测试", !!ready);
  if (!ready) throw new Error("没有可测试的在线正文");

  const direct = JSON.parse(await evalJs(`(async function(){
    var total = state.book.chapterCount;
    var from = state.chapterIdx;
    var target = Math.min(total - 1, from + 57);
    if (target === from) target = Math.min(total - 1, from + 3);
    var el = document.getElementById('content');
    el.innerHTML = Array.from({length: 120}, function(_, i) {
      return '<p>旧章第' + (i + 1) + '行，用于确认直接跳章不会连续滚动。</p>';
    }).join('');
    chRenderedIdx = from;
    el.scrollTop = el.scrollHeight - el.clientHeight;

    var oldFetch = fetchChapter;
    var oldPrefetch = prefetchNeighbors;
    prefetchNeighbors = function () {};
    fetchChapter = function (rel, idx) {
      window.__farJumpCalls = window.__farJumpCalls || [];
      window.__farJumpCalls.push(idx);
      return Promise.resolve({ title: '测试远跳章 ' + (idx + 1), text: '远跳测试正文\\n第二行' });
    };
    try { await gotoChapter(target, 0, 'direct'); }
    finally {
      fetchChapter = oldFetch;
      prefetchNeighbors = oldPrefetch;
    }
    return JSON.stringify({ from: from, target: target, idx: state.chapterIdx, animated: flipRAF !== 0 });
  })()`, true));
  check("远距离目录跳章为瞬时直接换章", direct.idx === direct.target && direct.animated === false,
    `${direct.from + 1} → ${direct.target + 1}，flipRAF=${direct.animated ? "active" : "0"}`);

  const noHoverPrefetch = JSON.parse(await evalJs(`(async function(){
    var total = state.book.chapterCount;
    var probe = Math.min(total - 1, state.chapterIdx + 1);
    chapterCache.delete(chapterKey(state.book.rel, probe));
    var box = document.getElementById('tocList');
    box.scrollTop = Math.max(0, probe * (state.tocVirtual.itemH || 38) - 50);
    if (window.__tocPaint) window.__tocPaint();
    var item = document.querySelector('.toc-item[data-idx="' + probe + '"]');
    if (!item) return JSON.stringify({ ok: false, reason: 'item not rendered' });

    var oldFetch = fetchChapter;
    window.__farPrefetchCalls = [];
    fetchChapter = function (rel, idx) {
      window.__farPrefetchCalls.push(idx);
      return Promise.resolve({ title: '预取测试', text: '预取测试正文' });
    };
    try {
      item.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      await new Promise(function (r) { setTimeout(r, 190); });
    } finally { fetchChapter = oldFetch; }
    return JSON.stringify({ ok: window.__farPrefetchCalls.indexOf(probe) >= 0, probe: probe, calls: window.__farPrefetchCalls });
  })()`, true));
  check("目录条目悬停不会预取目标章", noHoverPrefetch.calls.length === 0,
    `probe=${noHoverPrefetch.probe + 1}，calls=${JSON.stringify(noHoverPrefetch.calls || [])}`);

  const pending = JSON.parse(await evalJs(`(async function(){
    var total = state.book.chapterCount;
    var from = state.chapterIdx;
    var target = Math.min(total - 1, from + 31);
    var el = document.getElementById('content');
    el.innerHTML = '<p>旧章正文：pending 测试</p>';
    chRenderedIdx = from;

    var oldFetch = fetchChapter;
    var oldPrefetch = prefetchNeighbors;
    var resolveChapter;
    var p = new Promise(function (r) { resolveChapter = r; });
    p.__readerSettled = false;
    p.then(function () { p.__readerSettled = true; }, function () { p.__readerSettled = true; });
    prefetchNeighbors = function () {};
    fetchChapter = function () { return p; };
    var running = gotoChapter(target, 0, 'direct');
    await new Promise(function (r) { setTimeout(r, 190); });
    var loadingShown = !!(document.getElementById('chapterHead').querySelector('.ch-loading:not(.ch-loading-error)'));
    var stateAtFrom = state.chapterIdx === from;
    var renderedAtFrom = chRenderedIdx === from;
    resolveChapter({ title: 'pending 测试章', text: 'pending 测试正文' });
    try { await running; } finally {
      fetchChapter = oldFetch;
      prefetchNeighbors = oldPrefetch;
    }
    return JSON.stringify({
      from: from, target: target, loadingShown: loadingShown,
      stateAtFrom: stateAtFrom, renderedAtFrom: renderedAtFrom,
      finalIdx: state.chapterIdx, finalRendered: chRenderedIdx
    });
  })()`, true));
  check("pending 远跳章会显示加载且旧 UI 不提前切换",
    pending.loadingShown && pending.stateAtFrom && pending.renderedAtFrom
      && pending.finalIdx === pending.target && pending.finalRendered === pending.target,
    `loading=${pending.loadingShown}，请求中=${pending.stateAtFrom}/${pending.renderedAtFrom}，完成后=${pending.finalIdx + 1}/${pending.finalRendered + 1}`);

  const failed = JSON.parse(await evalJs(`(async function(){
    var total = state.book.chapterCount;
    var from = state.chapterIdx;
    var target = Math.min(total - 1, from + 19);
    var oldFetch = fetchChapter;
    var oldPrefetch = prefetchNeighbors;
    var oldToast = toast;
    var toastText = '';
    prefetchNeighbors = function () {};
    toast = function (s) { toastText = String(s); };
    fetchChapter = function () { return Promise.reject(new Error('AggregateError')); };
    try { await gotoChapter(target, 0, 'direct'); }
    finally {
      fetchChapter = oldFetch;
      prefetchNeighbors = oldPrefetch;
      toast = oldToast;
    }
    return JSON.stringify({
      from: from, target: target, idx: state.chapterIdx, rendered: chRenderedIdx,
      error: !!(document.getElementById('chapterHead').querySelector('.ch-loading-error')),
      toast: toastText
    });
  })()`, true));
  check("AggregateError 失败会保留旧章并显示可读错误",
    failed.idx === failed.from && failed.rendered === failed.from && failed.error
      && failed.toast.indexOf('书源站点无法访问') >= 0,
    `state/render=${failed.idx + 1}/${failed.rendered + 1}，toast=${failed.toast}`);

  const failures = results.filter((r) => !r.pass);
  console.log(`\\n=== ${failures.length === 0 ? "全部通过" : "有失败"} (${results.length - failures.length}/${results.length}) ===`);
  clearTimeout(watchdog);
  await cleanup();
  process.exit(failures.length === 0 ? 0 : 1);
} catch (e) {
  console.error("验证异常：" + (e && e.message));
  clearTimeout(watchdog);
  await cleanup();
  process.exit(2);
}
