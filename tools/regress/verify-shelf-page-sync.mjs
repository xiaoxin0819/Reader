// 回归：正文与左侧书架必须始终匹配（用户明确要求）。
//   A) 抓完目录后，书架条目要立刻出现「读到 / 最新」两行（不用手动刷新）
//   B) 刷新页面（F5）后，书架不能回到第 1 页 —— 必须仍停在这本书所在的那页
//   C) 正在读的那本必须高亮，并且出现在当前渲染的那一页里
//
// 只读验证：拦断 /api/online/content 与 /api/online/progress，绝不写用户数据。
// 用法：node tools/regress/verify-shelf-page-sync.mjs   （服务需已在 7788 运行）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:7788";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9346);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const cleanupFns = [];
const cleanup = async () => { for (const f of cleanupFns.reverse()) { try { await f(); } catch {} } };
const watchdog = setTimeout(async () => { console.error("!! 超时"); await cleanup(); process.exit(2); }, 240000);

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

const profile = path.join(os.tmpdir(), "rzsync-" + Date.now());
fs.mkdirSync(profile, { recursive: true });
cleanupFns.push(async () => {
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
for (let i = 0; i < 200; i++) { try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(50); } }
if (!version) { console.error("浏览器没起来"); await cleanup(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await openWs(tab.webSocketDebuggerUrl);
cleanupFns.push(async () => { try { page.ws.close(); } catch {} });
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Fetch.enable", {
  patterns: [
    { urlPattern: "*api/online/content*", requestStage: "Request" },
    { urlPattern: "*api/online/progress", requestStage: "Request" },
  ],
});
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

async function goto(url) {
  await page.send("Page.navigate", { url });
  await sleep(400);
}

async function waitFor(expr, timeoutMs = 60000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evalJs(expr)) return true; } catch {}
    await sleep(150);
  }
  console.log(`  （等待超时：${label}）`);
  return false;
}

const SNAPSHOT = [
  "JSON.stringify((function(){",
  "  var items = Array.prototype.slice.call(document.querySelectorAll('#bookList .book-item.online'));",
  "  var act = document.querySelector('#bookList .book-item.online.active');",
  "  return {",
  "    mode: (typeof state !== 'undefined' && state.mode) || document.body.dataset.mode,",
  "    page: (typeof state !== 'undefined' && state.bookPage) || 0,",
  "    per: (typeof state !== 'undefined' && state.bookPerPage) || 0,",
  "    total: (typeof state !== 'undefined' && state.books) ? state.books.length : 0,",
  "    info: (document.getElementById('bkPageInfo')||{}).textContent||'',",
  "    activeName: act ? ((act.querySelector('.bn')||{}).textContent||'') : null,",
  "    activeMetas: act ? Array.prototype.map.call(act.querySelectorAll('.bk-meta'), function(e){return e.textContent.trim()}) : [],",
  "    pageNames: items.map(function(e){ return (e.querySelector('.bn')||{}).textContent; })",
  "  };",
  "})())",
].join("\n");

try {
  await goto(BASE + "/");
  await waitFor("document.readyState === 'complete'", 30000, "首屏");
  await evalJs("localStorage.setItem('readerMode','online'); 'ok'");

  await goto(BASE + "/");
  const ready = await waitFor(
    "(typeof state !== 'undefined') && state.mode === 'online' && (state.books||[]).length > 0",
    90000, "在线书架就绪",
  );
  check("在线书架加载成功", ready);
  if (!ready) throw new Error("书架没加载出来，无法继续");

  // 回归不碰速读谷：该站有风控，且当前 IP 已被临时封禁。
  // 固定从其它来源里选最后一本，避免测试本身继续打速读谷。
  const target = JSON.parse(await evalJs([
    "JSON.stringify((function(){",
    "  var all = visibleBooks();",
    "  var list = all.filter(function (b) {",
    "    var o = String(b.origin || '');",
    "    return o.indexOf('shudugu.org') < 0 && o.indexOf('sudugu.org') < 0;",
    "  });",
    "  if (!list.length) list = all;",
    "  var per = state.bookPerPage || 6;",
    "  var pages = Math.max(1, Math.ceil(list.length / per));",
    "  var idx = list.length - 1;",
    "  return { rel: list[idx].rel, name: list[idx].name, pos: idx, total: list.length, per: per, pages: pages, expectedPage: Math.floor(idx/per)+1 };",
    "})())",
  ].join("\n")));
  console.log(`  目标书：《${target.name}》 第 ${target.pos + 1} / ${target.total || "-"} 位，共 ${target.pages} 页，应为第 ${target.expectedPage} 页（每页 ${target.per} 本）`);
  check("存在可区分的多页书架（>=2 页）", target.pages >= 2, `共 ${target.pages} 页`);

  await evalJs(`localStorage.setItem('lastOnlineRel', ${JSON.stringify(target.rel)}); 'ok'`);

  await goto(BASE + "/");
  await waitFor("(typeof state !== 'undefined') && state.mode === 'online' && document.querySelector('#bookList .book-item.online.active')", 90000, "恢复正文+书架");
  await sleep(2000);
  const s1 = JSON.parse(await evalJs(SNAPSHOT));
  check("刷新后停在目标书所在页（不是第 1 页）", s1.page === target.expectedPage, `page=${s1.page} 期望=${target.expectedPage} 显示=${JSON.stringify(s1.info)}`);
  check("目标书高亮", s1.activeName === target.name, `active=${JSON.stringify(s1.activeName)}`);
  check("高亮书确实渲染在当前页（不是只高亮看不见）", s1.pageNames.includes(target.name), `当前页：${s1.pageNames.join(" / ")}`);

  await goto(BASE + "/");
  await waitFor("(typeof state !== 'undefined') && state.mode === 'online' && document.querySelector('#bookList .book-item.online.active')", 90000, "二次刷新恢复");
  await sleep(2000);
  const s2 = JSON.parse(await evalJs(SNAPSHOT));
  check("连续刷新分页稳定", s2.page === target.expectedPage, `page=${s2.page} 期望=${target.expectedPage}`);

  const addProbe = await evalJs([
    "(async function(){",
    "  var rel = " + JSON.stringify(target.rel) + ";",
    "  var b = findOnlineByRel(rel);",
    "  if (!b) return JSON.stringify({ err: 'no book' });",
    "  b.durChapterTitle = ''; b.latestChapterTitle = ''; b.totalChapterNum = 0;",
  "  var shaped = toLocalShape(b);",
  "  shaped.durChapterTitle = ''; shaped.latestChapterTitle = '';",
  "  onlineTocCacheDrop(rel);",
  "  await openBook(shaped);",
  "  var fresh = findOnlineByRel(rel);",
    "  return JSON.stringify({",
  "    dur: fresh ? (fresh.durChapterTitle||'') : '',",
  "    last: fresh ? (fresh.latestChapterTitle||'') : '',",
  "    total: fresh ? (fresh.totalChapterNum||0) : 0,",
  "  });",
    "})()",
  ].join("\n"), true);
  const ap = JSON.parse(addProbe);
  check("抓完目录后书架条目补齐「读到」", !!ap.dur, `读到=${JSON.stringify(ap.dur)}`);
  check("抓完目录后书架条目补齐「最新」", !!ap.last, `最新=${JSON.stringify(ap.last)}`);
  check("抓完目录后章节总数落进书架条目", Number(ap.total) > 0, `total=${ap.total}`);

  // 5b) 服务端自己也要在抓完目录时立刻回写（不依赖前端重拉）——
  //     直接问 /api/online/shelf，条目上必须已经有这两行。
  const srv = await (await fetch(BASE + "/api/online/shelf")).json();
  const srvBook = (srv.books || []).find((x) => (x.origin + "|" + x.bookUrl) === target.rel);
  check("服务端书架接口本身已带「读到」", !!(srvBook && srvBook.durChapterTitle), `读到=${JSON.stringify(srvBook && srvBook.durChapterTitle)}`);
  check("服务端书架接口本身已带「最新」", !!(srvBook && srvBook.latestChapterTitle), `最新=${JSON.stringify(srvBook && srvBook.latestChapterTitle)}`);
  check("服务端书架接口本身已带章节总数", !!(srvBook && Number(srvBook.totalChapterNum) > 0), `total=${srvBook && srvBook.totalChapterNum}`);

  await sleep(800);
  const s3 = JSON.parse(await evalJs(SNAPSHOT));
  check("界面上渲染出「读到」行", s3.activeMetas.some((m) => m.includes("读到")), `metas=${JSON.stringify(s3.activeMetas)}`);
  check("界面上渲染出「最新」行", s3.activeMetas.length >= 3, `metas=${JSON.stringify(s3.activeMetas)}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${failed.length === 0 ? "全部通过" : "有失败"} (${results.length - failed.length}/${results.length}) ===`);
  clearTimeout(watchdog);
  await cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
} catch (e) {
  console.error("验证异常：" + (e && e.message));
  clearTimeout(watchdog);
  await cleanup();
  process.exit(2);
}
