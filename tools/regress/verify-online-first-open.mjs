// 回归：服务重启后的首次打开速度。
// 只读验证：临时浏览器 Profile + 拦截 /api/online/progress，不写用户进度；
// 正文 / 目录请求正常放行，用于确认启动预热和打开链路优化是否生效。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.PROBE_BASE || "http://127.0.0.1:7788";
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9347);
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

const profile = path.join(os.tmpdir(), "reader-first-open-" + Date.now());
fs.mkdirSync(profile, { recursive: true });
const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--window-size=1400,900",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const cleanup = async () => {
  try { edge.kill("SIGKILL"); } catch {}
  try {
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {}
};

try {
  let version = null;
  for (let i = 0; i < 200; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch { await sleep(50); }
  }
  if (!version) throw new Error("浏览器没起来");

  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const page = await openWs(tab.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*api/online/progress*", requestStage: "Request" }],
  });
  page.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Fetch.requestPaused") {
      page.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Aborted" }).catch(() => {});
    }
  });

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " :: " + String(r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };

  await page.send("Page.navigate", { url: BASE + "/" });
  await sleep(500);
  await evalJs("document.readyState === 'complete'");

  const cfg = JSON.parse(fs.readFileSync(new URL("../../reader.config.json", import.meta.url), "utf8"));
  const recent = Object.entries(cfg.online.progress || {})
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))[0];
  if (!recent) throw new Error("没有在线阅读进度");
  await evalJs(`localStorage.setItem('readerMode','online'); localStorage.setItem('lastOnlineRel', ${JSON.stringify(recent[0])}); 'ok'`);

  const started = performance.now();
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
  const ms = Math.round(performance.now() - started);
  if (!ready) throw new Error("正文没有在 60 秒内渲染出来");

  const snapshot = JSON.parse(await evalJs([
    "JSON.stringify((function(){",
    "  var rs=performance.getEntriesByType('resource').filter(function(e){return e.name.indexOf('/api/online/')>=0});",
    "  return {",
    "    book:(state.book&&state.book.name)||'',",
    "    title:(document.getElementById('chapterHead')||{}).textContent||'',",
    "    textLength:(document.getElementById('content')||{}).textContent.trim().length,",
    "    api:rs.map(function(e){return {name:e.name.split('/api/online/')[1].split('?')[0],ms:Math.round(e.duration),size:Math.round(e.transferSize||0)}})",
    "  };",
    "})())",
  ].join("\n")));

  console.log(`首次正文渲染：${ms}ms`);
  console.log(JSON.stringify(snapshot, null, 2));
  await page.ws.close();
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error("验证失败：" + (e && e.message));
  await cleanup();
  process.exit(1);
}
