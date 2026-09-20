// 回归：打开一本书之后，是否真的会预取「相邻章」。
//
// 只读验证：
//   - 用临时浏览器 Profile，进度写请求（/api/online/progress）被 CDP 拦断，不改服务端进度；
//   - 正文 / 目录请求正常放行，通过 performance resource timing 记录每一次
//     /api/online/content 的发起时间与耗时，用来确认「当前章 → 相邻章」的请求顺序。
//
// 用法：
//   node tools/regress/verify-open-prefetch.mjs            # 默认取最近阅读的书
//   PROBE_BOOK=盘龙 node tools/regress/verify-open-prefetch.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:7788";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9361);
const WANT = String(process.env.PROBE_BOOK || "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.id && this.pending.get(m.id);
      if (w) {
        this.pending.delete(m.id);
        m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
      }
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("CDP 超时: " + method));
        }
      }, timeout);
    });
  }
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await Promise.race([
    new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true });
      ws.addEventListener("error", () => j(new Error("WebSocket 失败")), { once: true });
    }),
    sleep(10000).then(() => { throw new Error("WebSocket 超时"); }),
  ]);
  return new CDP(ws);
}

const cleanupFns = [];
const cleanup = async () => { for (const f of cleanupFns.reverse()) { try { await f(); } catch {} } };

const profile = path.join(os.tmpdir(), "reader-open-prefetch-" + Date.now());
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
  const cfg = JSON.parse(fs.readFileSync(new URL("../../reader.config.json", import.meta.url), "utf8"));
  const books = cfg.online.books || [];
  const progress = cfg.online.progress || {};
  const rows = books
    .map((b) => ({ b, rel: `${b.origin}|${b.bookUrl}`, at: Number((progress[`${b.origin}|${b.bookUrl}`] || {}).at) || 0 }))
    .sort((a, b) => b.at - a.at);
  const pick = WANT ? rows.find((r) => r.b.name.includes(WANT)) : rows[0];
  if (!pick) throw new Error("没找到目标书：" + (WANT || "(最近阅读)"));
  console.log(`目标书：${pick.b.originName} / ${pick.b.name}`);

  await page.send("Page.navigate", { url: BASE + "/" });
  await sleep(400);
  await evalJs([
    "localStorage.setItem('readerMode','online');",
    `localStorage.setItem('lastOnlineRel', ${JSON.stringify(pick.rel)});`,
    "'ok'",
  ].join("\n"));

  const started = Date.now();
  await page.send("Page.navigate", { url: BASE + "/" });
  let ready = false;
  for (let i = 0; i < 600; i++) {
    try {
      ready = await evalJs([
        "(function(){",
        "  var el=document.getElementById('content');",
        "  return typeof state!=='undefined' && state.mode==='online' && state.book",
        "    && (el && el.textContent.trim().length>100);",
        "})()",
      ].join("\n"));
    } catch {}
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error("正文没有在 60 秒内渲染出来");
  const firstPaintMs = Date.now() - started;

  // 再给预取一点时间落进 resource timing
  await sleep(4000);

  const rowsOut = JSON.parse(await evalJs([
    "JSON.stringify((function(){",
    "  var rs=performance.getEntriesByType('resource')",
    "    .filter(function(e){return e.name.indexOf('/api/online/content')>=0});",
    "  return rs.map(function(e){",
    "    var m=/[?&]index=(\\d+)/.exec(e.name);",
    "    return {index:m?Number(m[1]):null,",
    "      start:Math.round(e.startTime),",
    "      end:Math.round(e.startTime+e.duration),",
    "      ms:Math.round(e.duration)};",
    "  });",
    "})())",
  ].join("\n")));

  const chapter = await evalJs("(function(){return state.chapterIdx})()");
  console.log(`首次正文渲染：${firstPaintMs}ms（当前章 index=${chapter}）`);
  console.log("正文请求时间线（相对页面导航起点）：");
  for (const r of rowsOut) {
    const tag = r.index === chapter ? "当前章"
      : r.index === chapter + 1 ? "下一章(预取)"
      : r.index === chapter - 1 ? "上一章(预取)"
      : "其它";
    console.log(`  index=${String(r.index).padStart(4)}  起 ${String(r.start).padStart(6)}ms  耗 ${String(r.ms).padStart(5)}ms  ${tag}`);
  }

  const indexes = new Set(rowsOut.map((r) => r.index));
  const checks = [];
  checks.push(["当前章有请求", indexes.has(chapter)]);
  checks.push(["下一章被预取", indexes.has(chapter + 1)]);
  if (chapter > 0) checks.push(["上一章被预取", indexes.has(chapter - 1)]);
  const far = rowsOut.filter((r) => Math.abs(r.index - chapter) > 1);
  checks.push(["没有远距离章节请求", far.length === 0]);

  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (ok) pass++;
  }
  console.log(`\n结果：${pass}/${checks.length} PASS`);

  await page.ws.close();
  await cleanup();
  process.exit(pass === checks.length ? 0 : 1);
} catch (e) {
  console.error("验证失败：" + (e && e.message));
  await cleanup();
  process.exit(1);
}
