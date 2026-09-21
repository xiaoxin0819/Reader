// browser-host.mjs —— legado WebViewActivity 的桌面端等价物
//
// 背景：legado 的登录 / 防爬验证 / showBrowser 都跑在安卓内嵌 WebView 里，是**顶层导航**。
// 桌面端最初用 iframe 顶替，但很多站点用 CSP frame-ancestors / X-Frame-Options 禁止被嵌入
// （番茄 fanqienovel.com 就是 frame-ancestors 'self' *.feishu.cn），iframe 直接白屏，
// 用户根本没机会登录。
//
// 这里改用系统已装的 Edge/Chrome 起一个 headless 实例，通过 CDP：
//   - Page.startScreencast 把画面（JPEG 帧）推给前端弹窗渲染到 canvas
//   - Input.dispatch* 把前端的鼠标 / 键盘事件回灌进页面
//   - Network.getCookies 取 cookie，按 WebViewLoginFragment 的语义回写书源 CookieStore
// 等价于 legado 的「内置 WebView 里登录，cookie 自动回写」。
import { spawn } from "node:child_process";
import { getSubDomain } from "./net-utils.mjs";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

const WIN_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * user-data-dir 下「删掉后浏览器会自行重建、且不含任何登录态」的可再生缓存。
 *
 * 为什么必须列白名单而不是整个删 webview：
 *   - Cookies / Local Storage / IndexedDB / WebStorage / Storage / Preferences /
 *     Local State / Service Worker/Database 是书源登录态的载体，删了就得重新登录；
 *   - 番茄、晴天、光遇这些源的登录态就靠它们跨重启保留。
 * 下面这些是 HTTP 缓存、代码缓存、GPU 着色器缓存、Edge 组件/模型缓存和崩溃指标，
 * 删掉只会让下次访问慢一点，浏览器会按需重新下载/重建。
 */
const REGENERABLE_CACHE_PATHS = [
  // HTTP / 代码 / GPU 缓存
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  ["Default", "ShaderCache"],
  ["GPUPersistentCache"],
  ["GrShaderCache"],
  ["ShaderCache"],
  // Service Worker 的可再生部分；Database 子目录存的是注册信息，必须保留
  ["Default", "Service Worker", "CacheStorage"],
  ["Default", "Service Worker", "ScriptCache"],
  // Edge 组件 / 模型缓存，会按需重新下载
  ["component_crx_cache"],
  ["extensions_crx_cache"],
  ["ProvenanceData"],
  ["ProvenanceDataTensors"],
  ["Edge Entity Extraction"],
  ["Edge Shopping"],
  ["Edge Wallet"],
  ["EdgeLanguageDetectionModel"],
  ["Speech Recognition"],
  ["Subresource Filter"],
  ["Typosquatting"],
  ["SafetyTips"],
  ["Edge Sidebar"],
  ["Edge Notifications"],
  ["Edge Signal Triggers"],
  ["Edge3pSerp"],
  ["EdgeArbitration"],
  ["EdgeEmojiLocales"],
  ["Edge Data Protection Lists"],
  ["Ad Blocking"],
  // 崩溃转储 / 会话恢复
  ["Crashpad"],
  ["Breadcrumbs"],
];

/**
 * 「一次会话内长出来」的缓存，登录窗口关闭后可以立刻回收。
 *
 * 实测（headless Edge 打开一次番茄登录页）：
 *   - Default/Cache（HTTP 缓存）单次 37.6MB，是唯一的量级大头；
 *   - Default/Code Cache 约 3.8MB，GPU/Shader 各约 0.5MB；
 *   - 对比实验：把 --disk-cache-size 从 256MB 压到 8MB 只能降到 31.4MB，
 *     Chromium 并不会因为上限小就主动淘汰，所以只能由我们主动回收；
 *   - Network.clearBrowserCache 实测只清 HTTP 缓存，Cookies / LocalStorage /
 *     IndexedDB 全部原样（见 .scratch/verify-clear-cache-safety.mjs）。
 *
 * 与 REGENERABLE_CACHE_PATHS 的区别：这里的项每次会话都会重新长出来，
 * 适合「关窗即清」；Edge 组件 / 模型缓存（component_crx_cache、ProvenanceData 等）
 * 已由启动参数禁止增长，只在用户手动清理时回收，避免每次重开都重新下载。
 */
const TRANSIENT_CACHE_PATHS = [
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  ["Default", "ShaderCache"],
  ["GPUPersistentCache"],
  ["GrShaderCache"],
  ["ShaderCache"],
  ["Default", "Service Worker", "CacheStorage"],
  ["Default", "Service Worker", "ScriptCache"],
];

/** 同步统计文件/目录体积；读不到的项按 0 处理，不影响清理流程。 */
function dirBytesSync(target) {
  let st = null;
  try { st = fs.statSync(target); } catch (e) { return { bytes: 0, files: 0 }; }
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); }
  catch (e) { return { bytes: 0, files: 0 }; }
  let bytes = 0, files = 0;
  for (const e of entries) {
    const sub = dirBytesSync(path.join(target, e.name));
    bytes += sub.bytes;
    files += sub.files;
  }
  return { bytes: bytes, files: files };
}

const METRICS_FILE_RE = /^(?:BrowserMetrics|CrashpadMetrics).*\.pma$/i;

export function findChromium() {
  const list = WIN_CANDIDATES.slice();
  const local = process.env.LOCALAPPDATA || "";
  if (local) {
    list.push(path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"));
    list.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
  }
  for (const p of list) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * 书源 header 的两种去处，严格对齐 legado WebViewLoginFragment.loadUrl(url, additionalHeaders)：
 *   - User-Agent 进 WebSettings.userAgentString：主文档、重定向、子资源都用它（浏览器语义）
 *   - 其余 header 交给 loadUrl 的 additionalHeaders：只作用于这一次顶层导航
 *
 * 安卓 WebView 的 additionalHttpHeaders 不会带到 XHR / fetch / script / img 上。
 * 桌面端早先图省事整包丢进 Network.setExtraHTTPHeaders，等于给页面里每个跨域请求都加上
 * 了自定义头（番茄书源 header 里有 ismobile），于是全部触发 CORS 预检失败 ——
 * 验证中心的 @latest/index.js 直接加载不出来，滑块验证码的交互代码根本没注册，
 * 表现就是「验证码窗口点了没反应、拖不动」。
 */
function splitSourceHeaders(headers) {
  const extra = {};
  let userAgent = "";
  if (headers && typeof headers === "object") {
    for (const k of Object.keys(headers)) {
      const v = headers[k];
      if (v == null) continue;
      const lower = String(k).toLowerCase();
      if (lower === "user-agent") { userAgent = String(v); continue; }
      if (lower === "cookiejar") continue;
      extra[k] = String(v);
    }
  }
  return { userAgent: userAgent, extra: extra };
}

function headersToArray(obj) {
  const out = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] == null) continue;
    out.push({ name: k, value: String(obj[k]) });
  }
  return out;
}

/* ============================ CDP 连接 ============================ */

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    const self = this;
    ws.addEventListener("message", function (ev) { self._onMessage(ev.data); });
    ws.addEventListener("close", function () { self._onClose(); });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise(function (res, rej) {
      const to = setTimeout(function () { rej(new Error("CDP 连接超时")); }, 10000);
      ws.addEventListener("open", function () { clearTimeout(to); res(); }, { once: true });
      ws.addEventListener("error", function () { clearTimeout(to); rej(new Error("CDP 连接失败")); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  _onMessage(data) {
    let msg = null;
    try { msg = JSON.parse(typeof data === "string" ? data : String(data)); } catch (e) { return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP 调用失败"));
      else p.resolve(msg.result || {});
      return;
    }
    const key = (msg.sessionId || "") + "|" + msg.method;
    const arr = this.listeners.get(key);
    if (!arr) return;
    for (const fn of arr.slice()) {
      try { fn(msg.params || {}, msg.sessionId || ""); } catch (e) { /* ignore */ }
    }
  }

  _onClose() {
    const pend = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pend) { try { p.reject(new Error("CDP 连接已断开")); } catch (e) { /* ignore */ } }
  }

  send(method, params, sessionId) {
    const id = ++this.seq;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    const self = this;
    return new Promise(function (resolve, reject) {
      self.pending.set(id, { resolve: resolve, reject: reject });
      try { self.ws.send(JSON.stringify(payload)); }
      catch (e) { self.pending.delete(id); reject(e); }
    });
  }

  on(method, fn, sessionId) {
    const key = (sessionId || "") + "|" + method;
    let arr = this.listeners.get(key);
    if (!arr) { arr = []; this.listeners.set(key, arr); }
    arr.push(fn);
  }

  off(method, fn, sessionId) {
    const key = (sessionId || "") + "|" + method;
    const arr = this.listeners.get(key);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

/* ============================ 浏览器宿主 ============================ */

/*
 * CookieStore 的键一律用 NetworkUtils.getSubDomain 归一化（唯一实现在 net-utils.mjs）。
 * 这里原先自己又写了一份，且用 new URL() 直接解析——对「光遇聚合」这种非 http 开头的
 * bookSourceUrl 会抛异常，回退返回原串，于是和书源侧 getSubDomain 的结果（gyks.cf）
 * 落到两个桶，登录态读写不通。legado 全项目只有 NetworkUtils.getSubDomain 一处实现，
 * 这里改为直接复用，避免第三份不一致的拷贝。
 */
export { getSubDomain as subDomainOf };

export class BrowserHost extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.bin = o.bin || findChromium();
    // 生产入口 server.mjs 总会显式传入 Reader/cache/webview；这里的回退也绝不能
    // 落到系统临时目录，否则用户删除 Reader 后仍会留下 WebView profile。
    this.dataDir = o.dataDir || (process.env.READER_CACHE_DIR
      ? path.join(path.resolve(process.env.READER_CACHE_DIR), "webview")
      // exe（SEA）模式没有 import.meta.url，用 exe 所在目录作为根
      : (globalThis.__READER_IS_SEA__
        ? path.join(path.dirname(process.execPath), "cache", "webview")
        : path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "cache", "webview")));
    this.proc = null;
    this.conn = null;
    this.port = 0;
    this.starting = null;
    this.tabs = new Map();
    this.seq = 0;
    this.frameSeq = 0;
    this.lastFrames = new Map();   // tabId -> 最近一帧（新订阅者先补一帧）
    // 「用完收摊」策略：
    //   clearCacheOnClose —— 最后一个窗口关闭时清掉本次会话长出的 HTTP 缓存；
    //   idleStopMs        —— 最后一个窗口关闭后等多久退出浏览器进程（0 = 不自动退出）。
    // 默认开启且留 20s 宽限：用户关掉登录窗又马上重开时进程还热着，不会感到变慢；
    // 真走了就退出，既释放内存也不再让 Chromium 后台写盘。
    this.clearCacheOnClose = o.clearCacheOnClose !== false;
    this.idleStopMs = o.idleStopMs === undefined ? 20000 : Number(o.idleStopMs) || 0;
    this._idleTimer = null;
    this._opening = 0;   // 正在创建中的窗口数：>0 时「空闲收摊」必须让路
    this._stopping = false;   // 正在主动关闭浏览器：期间不要再排「空闲收摊」
  }

  alive() {
    return !!(this.conn && this.proc && this.proc.exitCode === null);
  }

  async ensure() {
    if (this.alive()) return this.conn;
    if (this.starting) return this.starting;
    const self = this;
    this.starting = (async function () {
      try { await self._launch(); }
      finally { self.starting = null; }
      return self.conn;
    })();
    return this.starting;
  }

  /**
   * 复用已经在跑、且占着本 profile 的浏览器实例。
   *
   * 背景见 _launch() 的注释：Edge 对同一个 user-data-dir 是单实例的，
   * 已有实例在跑时新进程会 exit 0。这里通过上一次写下的 DevToolsActivePort
   * 找到它的调试端口并接管，避免「打开失败：浏览器进程启动即退出（exit 0）」。
   *
   * @returns {Promise<boolean>} 是否成功接管
   */
  async _tryReuseExisting(portFile) {
    let port = 0;
    try {
      const text = fs.readFileSync(portFile, "utf8");
      port = Number(String(text).split(/\r?\n/)[0]) || 0;
    } catch (e) {
      return false;   // 没有端口文件 = 没有可复用的实例
    }
    if (!port) return false;

    let ver = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/json/version");
        ver = await r.json();
        break;
      } catch (e) { await sleep(200); }
    }
    if (!ver || !ver.webSocketDebuggerUrl) return false;   // 端口在但服务已死

    try {
      this.conn = await CdpConnection.connect(ver.webSocketDebuggerUrl);
      this.port = port;
      // 复用别人的实例时 this.proc 为 null：alive() 依赖 proc，
      // 这里补一个「哨兵」让 alive() 判定成立（退出清理时不会再误杀外部进程）。
      this.proc = { exitCode: null, killed: false, kill() { this.killed = true; } };
      this.emit("ready", { port, bin: this.bin, reused: true });
      return true;
    } catch (e) {
      this.conn = null;
      this.proc = null;
      this.port = 0;
      return false;
    }
  }

  async _launch() {
    if (!this.bin) throw new Error("未找到 Edge / Chrome，登录与验证类书源需要本机浏览器内核");
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (e) { /* ignore */ }
    const portFile = path.join(this.dataDir, "DevToolsActivePort");

    /**
     * 先尝试复用「已经在用这个 profile 的浏览器实例」。
     *
     * 为什么必须这么做：Edge 的 user-data-dir 是单实例的。如果已经有 Edge 进程
     * 占着这个 profile（上一次没被正常关掉、或同时跑了源码版和 exe 版两个 Reader，
     * 它们共用同一个 cache/webview），新起的 Edge 会把启动请求转交给已有实例，
     * 然后自己**以 exit 0 正常退出** —— 既不会写 DevToolsActivePort，也不会监听端口。
     * 旧代码在启动前先删掉 DevToolsActivePort，于是这种情况必然抛
     * 「浏览器进程启动即退出（exit 0）」，用户看到的就是「打开失败」。
     *
     * 复用方式：读上一次留下的 DevToolsActivePort，探测它的 /json/version 是否还活着；
     * 活着就直接接管这个实例（书源登录只需要一个能投帧、能回灌输入的内核）。
     */
    const reused = await this._tryReuseExisting(portFile);
    if (reused) return;

    try { fs.rmSync(portFile, { force: true }); } catch (e) { /* ignore */ }

    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      "--user-data-dir=" + this.dataDir,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // 限制磁盘缓存上限（HTTP 缓存 + 媒体缓存），避免长期使用后 profile 无限膨胀。
      // 只影响可再生缓存，不影响 Cookies / Local Storage 等登录数据。
      "--disk-cache-size=" + (256 * 1024 * 1024),
      "--media-cache-size=" + (64 * 1024 * 1024),
      // 关掉浏览器自身的后台联网、组件更新、同步、崩溃上报 —— 登录书源不需要它们，
      // 它们正是 component_crx_cache / ProvenanceData / Crashpad 这些目录的来源。
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-pings",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,800",
      "about:blank",
    ];
    const proc = spawn(this.bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.proc = proc;
    try { proc.stderr.on("data", function () { /* 丢弃噪音 */ }); } catch (e) { /* ignore */ }

    let text = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (proc.exitCode !== null) throw new Error("浏览器进程启动即退出（exit " + proc.exitCode + "）");
      try {
        text = fs.readFileSync(portFile, "utf8");
        if (text && text.trim()) break;
      } catch (e) { /* 还没写出来 */ }
      await sleep(150);
    }
    if (!text || !text.trim()) {
      try { proc.kill(); } catch (e) { /* ignore */ }
      this.proc = null;
      throw new Error("浏览器启动失败：未生成调试端口");
    }
    const port = Number(String(text).split(/\r?\n/)[0]) || 0;
    if (!port) throw new Error("浏览器调试端口无效");
    this.port = port;

    let ver = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/json/version");
        ver = await r.json();
        break;
      } catch (e) { await sleep(200); }
    }
    if (!ver || !ver.webSocketDebuggerUrl) throw new Error("浏览器调试接口不可用");
    this.conn = await CdpConnection.connect(ver.webSocketDebuggerUrl);

    const self = this;
    proc.on("exit", function () {
      self.conn = null;
      self.proc = null;
      self.port = 0;
      self.tabs.clear();
      self.lastFrames.clear();
      self.emit("closed");
    });
    this.emit("ready", { port: port, bin: this.bin });
  }

  /**
   * 打开一个标签页（等价 legado startActivity<WebViewActivity>）。
   * @returns {Promise<object>} tab 句柄
   */
  /**
   * 打开标签页（对外入口）。
   *
   * 外面这层只负责和「空闲收摊」互斥：关掉最后一个窗口后 _scheduleIdleCleanup()
   * 会在宽限期后清缓存并退进程，而 _openTab() 内部有多个 await（建 target、attach、
   * 开 screencast…），期间 tabs 里还是空的。若此时清理逻辑按 tabs.size === 0 动手，
   * 就会把刚建好的窗口一起 closeAll() 掉。这里用 _opening 占位并先取消定时器隔开两者。
   */
  async open(opts) {
    this._cancelIdleCleanup();
    this._opening += 1;
    try {
      return await this._openTab(opts);
    } finally {
      this._opening -= 1;
      if (this.tabs.size === 0) this._scheduleIdleCleanup();
    }
  }

  async _openTab(opts) {
    const o = opts || {};
    const conn = await this.ensure();
    const width = Number(o.width) || 1280;
    const height = Number(o.height) || 800;

    const created = await conn.send("Target.createTarget", { url: "about:blank" });
    const targetId = created.targetId;
    const att = await conn.send("Target.attachToTarget", { targetId: targetId, flatten: true });
    const sid = att.sessionId;
    // headless Chromium 只给「激活中」的 tab 合成新帧（screencast 靠合成器驱动）。
    // legado 的 WebViewActivity 是前台独立 Activity、永远可见，所以登录页总能刷新；
    // 桌面端一个浏览器实例里可能挂着多个 tab，被切到后台的那个会停在首帧（白屏）。
    // 这里显式激活：单窗口场景等价 legado，多窗口时最后开的那个可见，行为可预期。
    try { await conn.send("Target.activateTarget", { targetId: targetId }); } catch (e) { /* ignore */ }

    const tabId = "w" + (++this.seq);
    const tab = {
      id: tabId,
      targetId: targetId,
      sessionId: sid,
      url: String(o.url || ""),
      title: String(o.title || ""),
      sourceUrl: String(o.sourceUrl || ""),
      mainFrameId: "",
      navHeaders: null,
      width: width,
      height: height,
      cookie: "",
      ready: false,
      closed: false,
    };
    this.tabs.set(tabId, tab);

    try {
      await conn.send("Page.enable", {}, sid);
      await conn.send("Network.enable", {}, sid);
      await conn.send("Emulation.setDeviceMetricsOverride", {
        width: width, height: height, deviceScaleFactor: 1, mobile: false,
      }, sid);
      // 书源 header 的落点必须和 legado WebViewLoginFragment 一致：
      //   User-Agent -> WebSettings（等同于浏览器 UA，作用于全部请求）
      //   其余 header -> loadUrl(url, additionalHeaders)（只作用于顶层导航）
      // 早先整包塞 Network.setExtraHTTPHeaders 会给页面每个跨域 fetch 都加自定义头
      // （番茄书源带 ismobile），CORS 预检集体失败，验证码 SDK 加载不全，滑块点不动。
      const hv = splitSourceHeaders(o.headers);
      if (hv.userAgent) {
        try { await conn.send("Network.setUserAgentOverride", { userAgent: hv.userAgent }, sid); } catch (e) { /* ignore */ }
      }
      if (Object.keys(hv.extra).length) {
        tab.navHeaders = hv.extra;
        try {
          await conn.send("Fetch.enable", {
            patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
          }, sid);
          conn.on("Fetch.requestPaused", function (p) {
            // 只认主框架文档；子 iframe 文档不加，避免把书源专属头泄漏到第三方域
            const isTop = !tab.mainFrameId || !p.frameId || p.frameId === tab.mainFrameId;
            const params = { requestId: p.requestId };
            if (isTop && tab.navHeaders) {
              const merged = Object.assign({}, (p.request && p.request.headers) || {}, tab.navHeaders);
              params.headers = headersToArray(merged);
            }
            conn.send("Fetch.continueRequest", params, sid).catch(function () { /* ignore */ });
          }, sid);
        } catch (e) { /* 个别内核不支持 Fetch，退化为不附加额外 header */ }
      }
    } catch (e) { /* 继续，个别命令失败不致命 */ }

    const self = this;
    conn.on("Page.screencastFrame", function (p) {
      conn.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(function () {});
      const meta = p.metadata || {};
      const frame = {
        tabId: tabId,
        seq: ++self.frameSeq,
        data: p.data,
        // Input.dispatch* 与 Emulation viewport 都以 tab.width/height 为准。
        // screencast metadata 在 resize 后可能晚一帧，不能让旧值把前端坐标系改回去。
        width: tab.width,
        height: tab.height,
      };
      self.lastFrames.set(tabId, frame);
      self.emit("frame", frame);
    }, sid);

    conn.on("Page.frameNavigated", function (p) {
      const f = p.frame || {};
      if (f.parentId) return;   // 只看主框架
      tab.mainFrameId = f.id || tab.mainFrameId;
      tab.url = f.url || tab.url;
      if (f.name) tab.title = f.name;
      self._syncCookies(tab).catch(function () { /* ignore */ });
      self.emit("nav", { tabId: tabId, url: tab.url, title: tab.title });
      self._grab(tab).catch(function () { /* ignore */ });
    }, sid);

    conn.on("Page.loadEventFired", function () {
      tab.ready = true;
      self._syncCookies(tab).catch(function () { /* ignore */ });
      self.emit("load", { tabId: tabId, url: tab.url });
      // 静态页（得奇这类）加载完就再也不会产生合成帧，被动 screencast 会永远停在白屏首帧。
      // 主动抓一帧，并在加载后的一小段窗口期再补几帧（字体 / CSS / 图片到位后画面才稳定）。
      self._grab(tab).catch(function () { /* ignore */ });
      for (const delay of [250, 800, 1800, 3200]) {
        const t = setTimeout(function () { self._grab(tab).catch(function () { /* ignore */ }); }, delay);
        if (t.unref) t.unref();
      }
    }, sid);

    conn.on("Page.frameStoppedLoading", function () {
      self._syncCookies(tab).catch(function () { /* ignore */ });
      self._grab(tab).catch(function () { /* ignore */ });
    }, sid);

    try {
      await conn.send("Page.startScreencast", {
        format: "jpeg", quality: 62, maxWidth: width, maxHeight: height, everyNthFrame: 1,
      }, sid);
    } catch (e) { /* ignore */ }

    if (tab.url) {
      try { await conn.send("Page.navigate", { url: tab.url }, sid); }
      catch (e) { /* 导航失败也要把 tab 交出去，用户可手动输地址 */ }
    }

    // cookie 轮询兜底：有些站点不触发 load 事件（长连接 / SPA 重定向）
    tab.timer = setInterval(function () {
      if (tab.closed) return;
      self._syncCookies(tab).catch(function () { /* ignore */ });
    }, 2500);
    if (tab.timer.unref) tab.timer.unref();

    return tab;
  }

  /**
   * 主动抓一帧（Page.captureScreenshot）当 screencast 帧用。
   *
   * 为什么需要：headless Chromium 的 screencast 是「合成器有输出才推帧」，
   * 一个 tab 只加载了一屏静态 HTML、之后没有任何重绘（得奇小说登录页就是这样），
   * 或者 tab 被切到后台，合成器就再不产帧。前端长轮询只能反复拿到那张白屏首帧。
   * legado 没有这个问题，因为它的 WebView 永远在前台、随时可 draw；
   * 桌面端只能用「主动截图」把这个语义补回来。
   *
   * 用 _grabbing 做在途去重：补帧定时器和长轮询会同时打过来，避免并发截图把 CPU 打满。
   */
  async _grab(tab, force) {
    if (!tab || tab.closed || !this.conn || tab.grabbing) return null;
    // 节流：长轮询会不停地进来要求补帧，全速截图会把 CPU 吃满。
    // 400ms 足够跟上「点击 → 页面重绘」的节奏，也不会拖慢交互反馈。
    const now = Date.now();
    if (!force && tab.lastGrab && now - tab.lastGrab < 400) return null;
    tab.lastGrab = now;
    tab.grabbing = true;
    try {
      const r = await this.conn.send("Page.captureScreenshot", { format: "jpeg", quality: 62 }, tab.sessionId);
      if (!r || !r.data || tab.closed) return null;
      const frame = {
        tabId: tab.id,
        seq: ++this.frameSeq,
        data: r.data,
        width: tab.width,
        height: tab.height,
      };
      this.lastFrames.set(tab.id, frame);
      this.frameTimes = this.frameTimes || new Map();
      this.frameTimes.set(tab.id, Date.now());
      this.emit("frame", frame);
      return frame;
    } catch (e) {
      return null;
    } finally {
      tab.grabbing = false;
    }
  }

  /** Network.getCookies → 拼接成 cookie 串；变化时通知 CookieStore 回写 */
  async _syncCookies(tab) {
    if (!this.conn || tab.closed) return "";
    let r = null;
    try { r = await this.conn.send("Network.getCookies", {}, tab.sessionId); }
    catch (e) { return tab.cookie; }
    const list = (r && r.cookies) || [];
    const parts = [];
    for (const c of list) {
      if (!c || !c.name) continue;
      parts.push(c.name + "=" + (c.value == null ? "" : c.value));
    }
    const cookie = parts.join("; ");
    if (cookie !== tab.cookie) {
      tab.cookie = cookie;
      // WebViewActivity.onPageFinished(url) → CookieStore.setCookie(it, cookieManager.getCookie(it))：
      // 用的是**当前页面的真实 url**，不是 bookSourceUrl。光遇聚合的 bookSourceUrl 是
      // 「光遇聚合」这个字面量，只有用页面 url（https://v1.gyks.cf/...）才能落到 gyks.cf 桶，
      // 与书源 login() 里 setAllCookies() 写的桶对上。
      this.emit("cookie", {
        tabId: tab.id,
        sourceUrl: tab.sourceUrl,
        domain: getSubDomain(tab.url || tab.sourceUrl),
        cookie: cookie,
      });
    }
    return cookie;
  }

  async cookies(tabId) {
    const tab = this.tabs.get(String(tabId || ""));
    if (!tab) return "";
    return await this._syncCookies(tab) || tab.cookie;
  }

  /** 最近一帧（新订阅者先用它铺底，避免等待下一次画面变化） */
  lastFrame(tabId) {
    return this.lastFrames.get(String(tabId || "")) || null;
  }

  /**
   * 取帧：若是 since 之后的新帧立即返回；否则挂起等待，超时返回最后一帧（附 stale 标记）。
   * 桌面端用 HTTP 长轮询代替 legado 的 WebView 直接绘制，避免依赖 SSE 连接数。
   */
  waitFrame(tabId, since, timeout) {
    const id = String(tabId || "");
    const cur = this.lastFrames.get(id) || null;
    if (cur && cur.seq > Number(since || 0)) return Promise.resolve(cur);
    if (!this.tabs.has(id)) return Promise.resolve(null);
    const self = this;
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (f, stale) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        self.off("frame", onFrame);
        self.off("closed", onClosed);
        if (!f) return resolve(null);
        resolve(stale ? Object.assign({}, f, { stale: true }) : f);
      };
      const onFrame = function (f) { if (f.tabId === id && f.seq > Number(since || 0)) finish(f, false); };
      const onClosed = function () { finish(null, false); };
      const timer = setTimeout(function () {
        // 超时说明这段时间远端一个合成帧都没产生（静态页 / tab 在后台）。
        // 前端在等画面，这里主动补一帧，别让长轮询干等到下一轮。
        const t = self.tabs.get(id);
        if (t) self._grab(t).catch(function () { /* ignore */ });
        finish(self.lastFrames.get(id) || null, true);
      }, Math.max(1000, Math.min(60000, Number(timeout) || 20000)));
      if (timer.unref) timer.unref();
      self.on("frame", onFrame);
      self.on("closed", onClosed);
      // 轮询一进来就先补一帧：新窗口刚打开时前端还没有任何画面可以画。
      const t0 = self.tabs.get(id);
      if (t0 && (!cur || cur.seq <= Number(since || 0))) self._grab(t0).catch(function () { /* ignore */ });
    });
  }

  /** 前端输入回灌（Input.dispatch*） */
  async input(tabId, ev) {
    const tab = this.tabs.get(String(tabId || ""));
    if (!tab || !this.conn) return false;
    const e = ev || {};
    const sid = tab.sessionId;
    // legado 的输入落在「当前这个 WebView」上；headless 里合成器只服务激活 tab，
    // 所以用户碰哪个窗口就把哪个切到前台，否则在 A 窗口打字会丢进 B 窗口的页面。
    try { await this.conn.send("Target.activateTarget", { targetId: tab.targetId }); } catch (err) { /* ignore */ }
    try {
      if (e.kind === "mouse") {
        const type = e.type === "down" ? "mousePressed"
          : e.type === "up" ? "mouseReleased"
          : e.type === "wheel" ? "mouseWheel" : "mouseMoved";
        const base = {
          x: Number(e.x) || 0,
          y: Number(e.y) || 0,
          button: e.button || "left",
          modifiers: Number(e.modifiers) || 0,
        };
        if (type === "mouseWheel") {
          await this.conn.send("Input.dispatchMouseEvent", Object.assign({}, base, {
            type: "mouseWheel",
            buttons: Number(e.buttons) || 0,
            clickCount: 0,
            deltaX: Number(e.deltaX) || 0,
            deltaY: Number(e.deltaY) || 0,
          }), sid);
        } else {
          // 按下期间 buttons 必须带左键位（1），否则 Chromium 不把它当有效点击，
          // 拖拽 / 选择 / 部分按钮的响应都会丢；抬起时归 0。
          const buttons = e.buttons == null
            ? (type === "mousePressed" ? (base.button === "right" ? 2 : 1) : 0)
            : Number(e.buttons);
          await this.conn.send("Input.dispatchMouseEvent", Object.assign({}, base, {
            type: type,
            buttons: buttons,
            clickCount: Number(e.clickCount) || (type === "mouseMoved" ? 0 : 1),
          }), sid);
        }
      } else if (e.kind === "text") {
        await this.conn.send("Input.insertText", { text: String(e.text == null ? "" : e.text) }, sid);
      } else if (e.kind === "key") {
        const type = e.type === "up" ? "keyUp" : e.type === "char" ? "char" : "keyDown";
        const params = {
          type: type,
          key: e.key == null ? "" : String(e.key),
          code: e.code == null ? "" : String(e.code),
          windowsVirtualKeyCode: Number(e.keyCode) || 0,
          nativeVirtualKeyCode: Number(e.keyCode) || 0,
          modifiers: Number(e.modifiers) || 0,
        };
        if (type === "char") params.text = String(e.text == null ? "" : e.text);
        if (e.text != null && type === "keyDown") params.text = String(e.text);
        await this.conn.send("Input.dispatchKeyEvent", params, sid);
      } else if (e.kind === "scroll") {
        // Android WebView 的手指拖动语义：拖动画面即可滚动。桌面 canvas 把拖动距离
        // 换算成滚轮增量送进同一个 viewport，页面无需依赖原生触摸设备模拟。
        await this.conn.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Number(e.x) || 0,
          y: Number(e.y) || 0,
          button: "none",
          buttons: 0,
          deltaX: Number(e.deltaX) || 0,
          deltaY: Number(e.deltaY) || 0,
        }, sid);
      } else if (e.kind === "nav") {
        await this.conn.send("Page.navigate", { url: String(e.url || "") }, sid);
      } else if (e.kind === "back") {
        const h = await this.conn.send("Page.getNavigationHistory", {}, sid);
        const i = (h && h.currentIndex) || 0;
        if (i > 0 && h.entries && h.entries[i - 1]) {
          await this.conn.send("Page.navigateToHistoryEntry", { entryId: h.entries[i - 1].id }, sid);
        }
      } else if (e.kind === "reload") {
        await this.conn.send("Page.reload", {}, sid);
      } else if (e.kind === "size") {
        const w = Math.max(320, Number(e.width) || tab.width);
        const h = Math.max(320, Number(e.height) || tab.height);
        tab.width = w;
        tab.height = h;
        await this.conn.send("Emulation.setDeviceMetricsOverride", {
          width: w, height: h, deviceScaleFactor: 1, mobile: false,
        }, sid);
        this.lastFrames.delete(tab.id);
        await this._grab(tab, true);
      }
      // 交互后页面通常会重绘，但后台 tab 的合成器不一定推帧 —— 与 legado 里
      // WebView 始终可见的行为对齐：点一下 / 输完字就主动补帧（节流 120ms）。
      // 拖动期间也要补帧：否则滑块在画面上「黏」在原位，看不出拖动结果
      if (e.kind !== "mouse" || e.type === "up" || e.type === "wheel" || (e.type === "move" && Number(e.buttons) > 0)) this._grabSoon(tab);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 交互后的补帧节流：避免连续 mousemove / 输入把 captureScreenshot 打满 */
  _grabSoon(tab) {
    if (!tab || tab.closed) return;
    if (tab.grabTimer) return;
    const self = this;
    tab.grabTimer = setTimeout(function () {
      tab.grabTimer = null;
      self._grab(tab).catch(function () { /* ignore */ });
    }, 120);
    if (tab.grabTimer.unref) tab.grabTimer.unref();
  }

  async close(tabId) {
    const tab = this.tabs.get(String(tabId || ""));
    if (!tab) return false;
    tab.closed = true;
    if (tab.timer) { try { clearInterval(tab.timer); } catch (e) { /* ignore */ } }
    if (tab.grabTimer) { try { clearTimeout(tab.grabTimer); } catch (e) { /* ignore */ } }
    await this._syncCookies(tab).catch(function () { /* ignore */ });
    this.tabs.delete(tab.id);
    this.lastFrames.delete(tab.id);
    try { await this.conn.send("Target.closeTarget", { targetId: tab.targetId }); }
    catch (e) { /* ignore */ }
    this._scheduleIdleCleanup();
    return true;
  }

  /**
   * 最后一个窗口关闭后：先清本次会话长出的 HTTP 缓存，再择机退出浏览器进程。
   *
   * 为什么在这里清而不是等进程退出：clearBrowserCache 走 CDP，进程还活着时就能执行，
   * 而且它只动 HTTP 缓存，Cookies / LocalStorage / IndexedDB 不受影响（已实测）。
   * 缓存清掉后即使进程再挂一会儿，也不会继续占着几十 MB 的磁盘。
   */
  _scheduleIdleCleanup() {
    if (this._stopping) return;
    if (this.tabs.size > 0 || this._opening > 0) return;
    this._cancelIdleCleanup();
    if (!this.clearCacheOnClose && !this.idleStopMs) return;
    const self = this;
    this._idleTimer = setTimeout(function () {
      self._idleTimer = null;
      self._idleCleanup().catch(function () { /* ignore */ });
    }, Math.max(0, this.idleStopMs || 0));
    // 别让这个定时器拖住 Node 进程退出
    try { this._idleTimer.unref && this._idleTimer.unref(); } catch (e) { /* ignore */ }
  }

  /** 取消待执行的「空闲收摊」；重新开窗时调用。 */
  _cancelIdleCleanup() {
    if (!this._idleTimer) return;
    try { clearTimeout(this._idleTimer); } catch (e) { /* ignore */ }
    this._idleTimer = null;
  }

  /** 是否有人在用浏览器（有已打开的窗口，或正在创建窗口）。 */
  _inUse() {
    return this.tabs.size > 0 || this._opening > 0;
  }

  async _idleCleanup() {
    // 期间又开了新窗口就作罢（比如用户连点两次登录）
    if (this._inUse()) return;
    // 进程已经退出时没有 CDP 可用，但目录仍然要回收，所以这里只把「清 HTTP 缓存」
    // 限制在活着的进程上，不能像早先那样直接 return 掉整个收尾流程。
    if (this.alive() && this.clearCacheOnClose) await this._clearHttpCache();
    // 清缓存期间用户又点了登录：此时窗口/进程可能刚起来，必须放弃收摊，
    // 否则会把刚启动的浏览器 kill 掉（表现为「点登录没反应」）。
    if (this._inUse() || this.starting) return;
    if (this.alive() && this.idleStopMs) {
      try { await this.stop(8000); } catch (e) { /* ignore */ }
    }
    // 代码缓存 / GPU 缓存没有 CDP 接口，只能按路径删。
    // 必须等进程退出后再删：Windows 上 Chromium 持有这些文件的句柄，提前删会半删。
    if (this.clearCacheOnClose) this._clearTransientDirs();
  }

  /**
   * 清 HTTP 缓存（Default/Cache）。
   *
   * 坑：Network.clearBrowserCache 只能发在 **page session** 上。直接挂在 browser 级
   * 连接上发会返回 `'Network.clearBrowserCache' wasn't found`，命令被静默丢弃，
   * 磁盘上的 Cache 一个字节都不会少 —— 这正是「关了窗口缓存照样涨」的原因。
   * 实测：page session 调用可把 41.6MB 清到 0.8MB。
   *
   * 此时用户窗口都已关闭，所以临时开一个 about:blank target 专门用来执行清理。
   * 实测在「所有窗口关闭后新建临时 target」场景下同样有效。
   */
  async _clearHttpCache() {
    if (!this.conn) return false;
    let targetId = "";
    try {
      const created = await this.conn.send("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId || "";
      if (!targetId) return false;
      const att = await this.conn.send("Target.attachToTarget", { targetId: targetId, flatten: true });
      await this.conn.send("Network.enable", {}, att.sessionId);
      await this.conn.send("Network.clearBrowserCache", {}, att.sessionId);
      return true;
    } catch (e) {
      return false;
    } finally {
      if (targetId) {
        try { await this.conn.send("Target.closeTarget", { targetId: targetId }); } catch (e) { /* ignore */ }
      }
    }
  }

  /** 删除本次会话产生的可再生缓存目录；浏览器已退出时句柄已释放，可安全删除。 */
  _clearTransientDirs() {
    if (this.alive()) return;   // 进程还开着就交给 stop() 之后清理，避免半删
    for (const rel of TRANSIENT_CACHE_PATHS) {
      const abs = path.join(this.dataDir, ...rel);
      try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  list() {
    const out = [];
    for (const t of this.tabs.values()) {
      out.push({ id: t.id, url: t.url, title: t.title, ready: t.ready, sourceUrl: t.sourceUrl, domain: getSubDomain(t.url || t.sourceUrl) });
    }
    return out;
  }

  closeAll() {
    for (const id of Array.from(this.tabs.keys())) {
      this.close(id).catch(function () { /* ignore */ });
    }
    const proc = this.proc;
    // 同样先请浏览器优雅退出，让 LocalStorage / IndexedDB 落盘；
    // 1.5s 还没退再兜底强杀（进程已退出时 kill 是空操作）。
    try { this.conn && this.conn.send("Browser.close").catch(function () { /* ignore */ }); }
    catch (e) { /* ignore */ }
    if (proc) {
      const t = setTimeout(function () {
        try { if (proc.exitCode === null) proc.kill(); } catch (e) { /* ignore */ }
      }, 1500);
      if (t.unref) t.unref();
    }
    try { this.conn && this.conn.close(); } catch (e) { /* ignore */ }
    this.conn = null;
    this.proc = null;
    this.tabs.clear();
  }

  /**
   * 关闭浏览器并等待进程真正退出。
   *
   * 为什么清理缓存前必须调用：Windows 上 Chromium 打开着 Cache_Data / Code Cache
   * 里的文件句柄，直接删除会部分失败或留下半删状态；而 DevToolsActivePort、
   * Cookies 这些文件如果被写坏，登录态就没了。等进程退出后再删，登录数据不动。
   */
  async stop(timeout) {
    const proc = this.proc;
    this._stopping = true;
    this._cancelIdleCleanup();
    // 逐个关标签（每个都会先同步一次 cookie）。
    // 这里**不能**用 closeAll()：它里面直接 proc.kill()，属于强杀，会在
    // Browser.close 之前就把进程干掉，让下面的优雅退出变成死代码。
    await this._closeTabs();
    if (!proc) { this._stopping = false; return true; }
    // 先请浏览器自己退：Browser.close 会走正常关闭流程，把 LocalStorage /
    // IndexedDB 这类「在内存里还没落盘」的数据刷出去。
    // 早先直接 proc.kill() 属于强杀，实测会让刚写入的 LocalStorage 丢失
    // （Cookies 因为是即时落盘所以还在），用户会遇到「刚登录完重启就掉登录」。
    if (this.conn) {
      try { await this.conn.send("Browser.close"); } catch (e) { /* 老内核不支持就退化为 kill */ }
    }
    const limit = Number(timeout) || 6000;
    const t0 = Date.now();
    while (proc.exitCode === null && Date.now() - t0 < limit) {
      await sleep(120);
    }
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch (e) { /* ignore */ }
      const t1 = Date.now();
      while (proc.exitCode === null && Date.now() - t1 < 3000) await sleep(120);
    }
    try { this.conn && this.conn.close(); } catch (e) { /* ignore */ }
    this.conn = null;
    this.proc = null;
    this.port = 0;
    this.tabs.clear();
    this.lastFrames.clear();
    this._stopping = false;
    return proc.exitCode !== null;
  }

  /** 关掉所有标签页（等待 cookie 同步完成），不杀进程。 */
  async _closeTabs() {
    for (const id of Array.from(this.tabs.keys())) {
      try { await this.close(id); } catch (e) { /* ignore */ }
    }
  }

  /** 可再生缓存的逐项体积（相对 user-data-dir 的路径），供设置页展示。 */
  cacheStats() {
    const out = [];
    for (const rel of REGENERABLE_CACHE_PATHS) {
      const abs = path.join(this.dataDir, ...rel);
      const s = dirBytesSync(abs);
      if (s.bytes > 0 || s.files > 0) {
        out.push({ key: rel.join("/"), label: rel[rel.length - 1], path: abs, bytes: s.bytes, files: s.files });
      }
    }
    try {
      for (const name of fs.readdirSync(this.dataDir)) {
        if (!METRICS_FILE_RE.test(name)) continue;
        const abs = path.join(this.dataDir, name);
        const s = dirBytesSync(abs);
        if (s.bytes > 0) {
          out.push({ key: "metrics:" + name, label: name, path: abs, bytes: s.bytes, files: s.files });
        }
      }
    } catch (e) { /* ignore */ }
    // 保留项汇总，让用户直观看到「登录数据没有被算进可清理体积」。
    // 只列真正承载登录态的项；Default/Network 里还混着 Trust Tokens、Reporting and NEL
    // 等可再生文件，所以这里精确到 Cookies 文件本身，不能整个目录一起算。
    const keepDefs = [
      ["login-cookies", "登录 Cookies", ["Default", "Network", "Cookies"]],
      ["login-localstorage", "站点本地存储", ["Default", "Local Storage"]],
      ["login-indexeddb", "站点 IndexedDB", ["Default", "IndexedDB"]],
      ["login-webstorage", "站点 WebStorage", ["Default", "WebStorage"]],
      ["login-storage", "站点 Storage", ["Default", "Storage"]],
      ["login-prefs", "浏览器配置", ["Default", "Preferences"]],
      ["login-localstate", "浏览器 Local State", ["Local State"]],
      ["login-sw-db", "Service Worker 注册信息", ["Default", "Service Worker", "Database"]],
    ];
    const keep = [];
    for (const [key, label, rel] of keepDefs) {
      const abs = path.join(this.dataDir, ...rel);
      const s = dirBytesSync(abs);
      keep.push({ key: key, label: label, path: abs, bytes: s.bytes, files: s.files });
    }
    const totalBytes = out.reduce(function (a, x) { return a + x.bytes; }, 0);
    return { dir: this.dataDir, items: out, keep: keep, totalBytes: totalBytes };
  }

  /**
   * 清理可再生缓存，返回释放字节数。
   * 调用方应先 await stop()，确保浏览器已退出、文件句柄已释放。
   */
  clearRegenerableCache() {
    let freed = 0, removed = 0, failed = [];
    for (const rel of REGENERABLE_CACHE_PATHS) {
      const abs = path.join(this.dataDir, ...rel);
      const s = dirBytesSync(abs);
      if (!s.bytes && !s.files) continue;
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        freed += s.bytes;
        removed += 1;
      } catch (e) {
        failed.push({ path: rel.join("/"), error: String((e && e.message) || e) });
      }
    }
    try {
      for (const name of fs.readdirSync(this.dataDir)) {
        if (!METRICS_FILE_RE.test(name)) continue;
        const abs = path.join(this.dataDir, name);
        const s = dirBytesSync(abs);
        try {
          fs.rmSync(abs, { force: true });
          freed += s.bytes;
          removed += 1;
        } catch (e) {
          failed.push({ path: name, error: String((e && e.message) || e) });
        }
      }
    } catch (e) { /* ignore */ }
    return { freedBytes: freed, removed: removed, failed: failed };
  }
}
