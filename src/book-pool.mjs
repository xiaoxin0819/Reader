// book-pool.mjs —— 书源抓取 worker 池
//
// 为什么要池化：书源抓取是「同步阻塞」的（Atomics.wait），一个 worker 同一时刻只能跑
// 一个任务。多源并发搜索 = 多个 worker 并行，这也是 legado 用协程池的等价物。
//
// 职责：
//   - 启动/回收 worker（每个 worker 自带一个同步网络线程）
//   - 任务分发（轮询 + 忙闲优先）与超时（超时后重建该 worker，避免脏状态）
//   - 书源热更新广播
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { mergeCookies } from './js-runtime.mjs';
import { getKey as getSourceKey } from './book-source-model.mjs';
import { fileURLToPath } from 'node:url';
import { createWorker, isSea } from './exe-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'book-worker.mjs');
/**
 * 登录态 / 书源变量的落盘位置。
 *
 * ⚠ 必须**运行时**求值，不能写成模块级常量：
 *   ESM 的 import 会被提升，本模块在 server.mjs 第 47 行就执行完了，
 *   而 server.mjs 到第 161 行才设置 READER_CACHE_DIR ——
 *   常量会在环境变量还没设好时就定下来。
 *
 * 为什么优先用 READER_CACHE_DIR：
 *   exe（SEA）模式下 esbuild 把 import.meta.url 替换成占位路径，
 *   __dirname 变成 C:\__reader__，再往上跳一级就是 C:\cache，
 *   书源变量会被写到 C 盘根目录，而 exe 自己读的是 <exe目录>/cache，
 *   两边对不上 → getVariable('云端配置') 永远为空 →
 *   光遇聚合的发现页只剩筛选框（11 项）。
 */
function statePath() {
  const dir = process.env.READER_CACHE_DIR;
  if (dir) return path.join(path.resolve(dir), 'login-state.json');
  // exe（SEA）下 __dirname 是打包占位路径，必须用 exe 所在目录，
  // 否则会退化成 C:\cache —— 又变成「登录态写到别处」。
  const root = isSea() ? path.dirname(process.execPath) : path.join(__dirname, '..');
  return path.join(root, 'cache', 'login-state.json');
}

/**
 * 登录态落盘。legado 的 CookieStore 每次 setCookie 都 appDb.cookieDao.insert()、
 * CacheManager.put 都 cacheDao.insert()，进程重启后依然在。我们原来是纯内存，
 * 重启即掉登录 —— 这里补上等价物（写盘走同步写，量很小：只有 cookie + 登录变量）。
 */
function readStateFile() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return null; }
}
/** 合并两份登录态快照（cookie 用 mergeCookies 同域合并，cache 后写覆盖） */
function mergeState(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const cookieMap = new Map();
  for (const [d, c] of prev.cookie || []) cookieMap.set(String(d), String(c || ''));
  for (const [d, c] of next.cookie || []) {
    const k = String(d);
    const old = cookieMap.get(k) || '';
    const merged = old ? mergeCookies(old, String(c || '')) : String(c || '');
    if (merged) cookieMap.set(k, merged); else cookieMap.delete(k);
  }
  const cacheMap = new Map();
  for (const row of prev.cache || []) if (Array.isArray(row)) cacheMap.set(String(row[0]), row);
  for (const row of next.cache || []) if (Array.isArray(row)) cacheMap.set(String(row[0]), row);
  return { cookie: [...cookieMap.entries()], cache: [...cacheMap.values()] };
}

function writeStateFile(data) {
  try {
    const p = statePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookie: data.cookie || [], cache: data.cache || [] }));
  } catch (e) { /* 落盘失败不影响本次登录 */ }
}

const DEFAULT_TIMEOUT = 90000;
const DEFAULT_SIZE = Number(process.env.READER_POOL_SIZE || 4);

/**
 * 走「发现页」的任务类型。
 *
 * 这些任务共享 worker 内的模块级状态（分类缓存 / InfoMap）和 HTTP 连接池，
 * 必须按书源固定到同一个 worker，见 exploreSlotIndex 的注释。
 */
const EXPLORE_TYPES = new Set(['explore', 'exploreKinds', 'exploreAction', 'exploreUiJs', 'exploreClearCache']);

/** FNV-1a：不引入 crypto，也避免不同 JS 引擎的字符串哈希差异。 */
function hashSlot(key, slotCount) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % slotCount;
}

/**
 * 计算带 concurrentRate 的书源应固定使用的 worker 下标。
 *
 * legado 的 ConcurrentRateLimiter 依赖 companion object 里的 ConcurrentHashMap，
 * 同一 App 进程内所有协程共享一份限速记录。我们为了同步网络 / Atomics.wait 把
 * 书源抓取拆到多个 worker，每个 worker 的 module state 是独立的；如果同一个
 * 限速书源被轮询到不同 worker，就会变成“每个 worker 各限一次”，实际上放大并发。
 * 因此对配置了 concurrentRate 的书源按 source key 稳定映射到同一个 worker，
 * 让该 worker 内的 ConcurrentLimiter 等价于 legado 的进程级限速。
 */
export function rateLimitedSlotIndex(sourceUrl, sources, slotCount) {
  const key = String(sourceUrl || '').trim();
  if (!key || !slotCount) return -1;
  const source = (sources || []).find((s) => getSourceKey(s) === key);
  if (!source) return -1;
  const rate = String(source.concurrentRate || '').trim();
  if (!rate || rate === '0') return -1;
  return hashSlot(key, slotCount);
}

/**
 * 正文请求固定 worker 下标（不涉及限速）。
 *
 * 为什么需要：每个 worker 有自己的 http(s).Agent 连接池，TLS 连接不能跨 worker 共享。
 * 同一本书的章节如果被轮询到 4 个 worker，每个 worker 首次访问该站都要重做一次
 * TLS 握手（走代理时实测 1.4~1.9 秒），于是出现「4 次慢、之后快」的锯齿；
 * 而 legado 只有一个进程级 okHttpClient / ConnectionPool（HttpHelper.kt:51），
 * 天然复用连接，所以它没有这个问题。
 *
 * 按「书源 + 书籍」固定到同一个 worker 后，同一本书的连续章节复用同一条 TLS 连接，
 * 实测从 1.7~3.2s 降到 ~0.5s；不同书 / 不同书源仍分散到不同 worker，保持并发能力。
 */
export function contentSlotIndex(sourceUrl, bookUrl, slotCount) {
  const key = String(sourceUrl || '').trim();
  if (!key || !slotCount) return -1;
  return hashSlot(key + '|' + String(bookUrl || ''), slotCount);
}

/**
 * 发现页（explore / exploreKinds / exploreAction / exploreUiJs）固定 worker 下标。
 *
 * 为什么必须固定：`explore.mjs` 里的 `exploreKindsMap`（分类内存缓存）和
 * `exploreInfoMapList`（InfoMap）都是**模块级状态，每个 worker 各一份**，
 * 而 legado 里它们是进程内单例。池里 4 个 worker 轮询接任务时，同一个书源
 * 会轮流落到不同 worker：
 *   1) InfoMap（线路 / 频道 / 平台 / 字数 / 更新 / 排序）在不同 worker 上
 *      各存一份。用户改完筛选条件，下一次请求落到别的 worker 就读到旧值，
 *      界面上的筛选与返回结果对不上。
 *   2) 每个 worker 各自跑一遍分类脚本、各自缓存一份结果。
 *   3) 每个 worker 有自己的 http(s).Agent 连接池，TLS 连接不能跨 worker 共享。
 *      请求散在 4 个 worker 上，等于每次都要在冷连接上重新握手 ——
 *      表现就是「没点过的分类要 5s+，点过的 1-2s」。
 *
 * 固定到同一个 worker 后，上述三个问题一起消失（与 legado 里
 * BookSourceExtensions 的 exploreKindsMap / exploreInfoMapList 是进程内单例等价）。
 */
export function exploreSlotIndex(sourceUrl, slotCount) {
  const key = String(sourceUrl || '').trim();
  if (!key || !slotCount) return -1;
  return hashSlot(key, slotCount);
}

/**
 * 取某书源的并发上限（0 = 不限制）。
 *
 * 对应书源管理里的「限制该书源（防封禁）」：勾上后 concurrencyLimit=3，
 * 表示同一书源**同时最多 3 个请求在飞**，避免一次性并发太多触发站点风控。
 *
 * 与 concurrentRate 的区别：
 *   · concurrentRate 是 legado 自带的「速率」限制（N 次 / 每 M 毫秒），
 *     管的是**频率**；而且我们已按用户原始书源把它清成 null。
 *   · concurrencyLimit 是「同时几个在飞」，管的是**并发度**。
 *     速读谷这类站点的问题正是并发度过高（一开书就同时打 3 个章节请求），
 *     所以需要的是后者。
 */
export function sourceConcurrencyLimit(sourceUrl, sources) {
  const key = String(sourceUrl || '').trim();
  if (!key) return 0;
  const source = (sources || []).find((s) => getSourceKey(s) === key);
  if (!source) return 0;
  const n = Math.trunc(Number(source.concurrencyLimit) || 0);
  return n > 0 ? n : 0;
}

class Slot {
  constructor(pool, index) {
    this.pool = pool;
    this.index = index;
    this.worker = null;
    this.busy = false;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer, type }
    this._spawn();
  }

  _spawn() {
    // exe（SEA）模式下磁盘没有 worker 文件，改用打包时注入的源码 eval 启动
    const worker = createWorker(
      'bookWorker',
      WORKER_PATH,
      { slots: this.pool.netSlots, sources: this.pool.sourcesSnapshot() },
      Worker,
    );
    worker.unref?.();
    worker.on('message', (msg) => this._onMessage(msg));
    worker.on('error', (e) => this._onDead(e));
    worker.on('exit', () => { if (this.worker === worker) this._onDead(new Error('worker 已退出')); });
    this.worker = worker;
  }

  _onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    this.busy = this.pending.size > 0;
    // worker 报告自己改过登录态（cookie / 登录变量）→ 交给池广播给其它 worker。
    // 对应 legado：CookieStore/CacheManager 是 object 单例，写入对所有协程立即可见。
    if (msg.state) {
      this.pool._onStateChanged(this, msg.state);
    }
    if (msg.ok) p.resolve({ result: msg.result, logs: msg.logs || [] });
    else {
      const err = new Error(msg.error || '任务失败');
      err.code = msg.code || 'ERROR';
      err.data = msg.data || null;
      err.logs = msg.logs || [];
      p.reject(err);
    }
  }

  _onDead(e) {
    const pend = [...this.pending.values()];
    this.pending.clear();
    this.busy = false;
    for (const p of pend) { clearTimeout(p.timer); p.reject(e); }
    try { this.worker?.terminate(); } catch (err) { /* noop */ }
    this.worker = null;
    if (!this.pool.closed) {
      try {
        this._spawn();
        // 新 worker 是空的：把最近一次登录态补回去（legado 里单例不存在「换了协程就丢登录」）
        this.pool._restoreSlot(this);
      } catch (err) { /* 下次派任务时再试 */ }
    }
  }

  run(type, payload, timeoutMs) {
    if (!this.worker) this._spawn();
    const id = ++this.seq;
    this.busy = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`任务超时（${timeoutMs}ms）: ${type}`);
        err.code = 'TIMEOUT';
        reject(err);
        // 超时的 worker 可能卡在 Atomics.wait，直接换掉
        this._onDead(new Error('任务超时，已重建 worker'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        this.worker.postMessage({ id, type, payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

export class BookPool {
  constructor(opts = {}) {
    this.size = Math.max(1, Number(opts.size) || DEFAULT_SIZE);
    this.netSlots = Number(opts.netSlots) || 16;
    this.timeout = Number(opts.timeout) || DEFAULT_TIMEOUT;
    this.sources = opts.sources || [];
    this.slots = [];
    this.closed = false;
    this.rr = 0;
    /**
     * 书源级并发闸门：sourceKey -> { limit, active, queue: [] }。
     *
     * 用于「限制该书源（防封禁）」（concurrencyLimit=3）：
     * 同一书源同时最多 N 个请求在飞，多出来的排队等前面的完成。
     *
     * 为什么必须做在池这一层而不是 worker 里：
     * worker 是「一个 worker 同时只跑一个任务」，但**多个 worker 可以同时跑
     * 同一个书源**（书源没配 concurrentRate 时走忙闲轮询）。
     * 所以「同时最多 3 个」只能在能看到全部 worker 的主线程池里统一裁决。
     */
    this.gates = new Map();
    for (let i = 0; i < this.size; i++) this.slots.push(new Slot(this, i));
  }

  sourcesSnapshot() { return this.sources; }

  /**
   * 取（或建）某书源的并发闸门。
   * limit <= 0 表示不限制，直接返回 null，调用方跳过排队。
   */
  _gateFor(sourceKey) {
    const key = String(sourceKey || '').trim();
    if (!key) return null;
    const limit = sourceConcurrencyLimit(key, this.sources);
    if (limit <= 0) {
      // 限制被取消：清掉旧闸门，并放行所有排队者
      const old = this.gates.get(key);
      if (old) {
        this.gates.delete(key);
        while (old.queue.length) old.queue.shift()();
      }
      return null;
    }
    let g = this.gates.get(key);
    if (!g) { g = { limit, active: 0, queue: [] }; this.gates.set(key, g); }
    g.limit = limit;   // 设置面板改过上限时跟着更新
    return g;
  }

  /** 等一个并发名额（拿到就 resolve；limit<=0 时立刻 resolve） */
  _acquire(sourceKey) {
    const g = this._gateFor(sourceKey);
    if (!g) return Promise.resolve(null);
    if (g.active < g.limit) { g.active++; return Promise.resolve(g); }
    return new Promise((resolve) => {
      g.queue.push(() => { g.active++; resolve(g); });
    });
  }

  /** 释放名额并唤醒下一个排队者 */
  _release(g) {
    if (!g) return;
    g.active = Math.max(0, g.active - 1);
    const next = g.queue.shift();
    if (next) next();
  }

  /** 轮询 + 忙闲优先 */
  _pick() {
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const s = this.slots[(this.rr + i) % n];
      if (!s.busy) { this.rr = (this.rr + i + 1) % n; return s; }
    }
    this.rr = (this.rr + 1) % n;
    return this.slots[this.rr];
  }

  /**
   * 派发任务。
   *
   * 若该书源勾了「限制该书源（防封禁）」（concurrencyLimit>0），
   * 先过并发闸门：同时最多 N 个在飞，多出来的排队等前面的完成。
   * 未限制的书源走原路径（零开销）。
   */
  request(type, payload, opts = {}) {
    const sourceKey = payload && (payload.sourceUrl || payload.sourceKey);
    const slot = opts.slot || this._pinnedSlotForPayload(payload, type) || this._pick();
    const run = () => slot.run(type, payload, opts.timeout || this.timeout);
    // 不限制的书源：保持原样，不引入 Promise 包装开销
    if (!sourceKey || sourceConcurrencyLimit(sourceKey, this.sources) <= 0) return run();
    return this._acquire(sourceKey).then((gate) => {
      if (!gate) return run();
      return run().finally(() => this._release(gate));
    });
  }

  /**
   * 挑一个「空闲、且不是 excludeIndex」的 worker。
   *
   * 用途：后台预热这类**绝不该挡住用户**的任务。
   *
   * 为什么需要：worker 的任务处理是同步阻塞的（书源 JS 里 java.ajax 走 Atomics.wait），
   * 一个 worker 同时只能跑一个任务，后来的消息会排队。发现页按书源固定了 worker
   * （见 exploreSlotIndex），如果预热也走那个 worker，用户点框就得排在预热后面 ——
   * 预热反而把界面拖慢了。
   *
   * @returns {Slot|null} 没有空闲 worker 时返回 null，调用方应跳过本轮（用户优先）
   */
  pickIdleSlot(excludeIndex = -1) {
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const s = this.slots[(this.rr + i) % n];
      if (s.index === excludeIndex) continue;
      if (!s.busy) return s;
    }
    return null;
  }

  /**
   * 固定 worker 的两种情况：
   *   1) 带 concurrentRate 的书源 —— 保证限速记录只有一份（legado 语义）；
   *   2) 正文请求 —— 按「书源 + 书籍」固定，复用该 worker 的 TLS 连接
   *      （legado 的进程级 ConnectionPool 等价物，见 contentSlotIndex 注释）。
   * 其余任务（搜索 / 发现 / 详情）仍走忙闲轮询，保持多源并发。
   */
  _pinnedSlotForPayload(payload, type) {
    const sourceUrl = payload && (payload.sourceUrl || payload.sourceKey);
    const rateIdx = rateLimitedSlotIndex(sourceUrl, this.sources, this.slots.length);
    if (rateIdx >= 0) return this.slots[rateIdx];
    // 发现页：分类缓存 / InfoMap / TLS 连接池都在 worker 内，必须按书源固定（见 exploreSlotIndex）
    if (EXPLORE_TYPES.has(type)) {
      const exIdx = exploreSlotIndex(sourceUrl, this.slots.length);
      return exIdx >= 0 ? this.slots[exIdx] : null;
    }
    if (type === 'content') {
      const idx = contentSlotIndex(sourceUrl, payload && (payload.bookUrl || (payload.book && payload.book.bookUrl)), this.slots.length);
      return idx >= 0 ? this.slots[idx] : null;
    }
    return null;
  }

  /**
   * 跑一个「会改登录态」的任务，然后把该 worker 的 cookie/cache 快照灌给其它 worker。
   *
   * legado 的 CookieStore/CacheManager 是 object 单例（且落库），登录一次全局可见；
   * 我们拆到多 worker 后必须显式同步，否则只有跑 login() 的那个 worker 知道 qttoken，
   * 其它 worker 取正文时按匿名请求 —— 这就是「登录一会儿又掉」的根因。
   */
  async runAndSync(type, payload, opts = {}) {
    const slot = (opts && opts.slot) || this._pinnedSlotForPayload(payload) || this._pick();
    // 登录类任务同样受书源并发闸门约束（它也是打源站的请求）
    const sourceKey = payload && (payload.sourceUrl || payload.sourceKey);
    const gate = sourceKey ? await this._acquire(sourceKey) : null;
    let r;
    try {
      r = await slot.run(type, payload, (opts && opts.timeout) || this.timeout);
    } finally {
      this._release(gate);
    }
    // 登录类调用要把登录态**立刻**同步出去（不能等防抖窗口，用户马上就会去取正文）
    await this.flushState().catch(() => 0);
    return Object.assign({}, r, { slotIndex: slot.index });
  }

  /** 立即把待扇出的登录态合并扇出（不等防抖定时器） */
  async flushState() {
    if (this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null; }
    const pending = this._pendingState;
    this._pendingState = null;
    await (this._inflightState || Promise.resolve()).catch(() => 0);
    if (pending) this._inflightState = this._fanoutState(pending).catch(() => 0);
    await this._inflightState;
    return 1;
  }

  /**
   * 某个 worker 自报了登录态写增量（msg.state）→ 立刻扇出给其它 worker 并落盘。
   * 做去重/防抖：同一份快照在 300ms 内只扇出一次，避免搜索并发时报文风暴。
   */
  _onStateChanged(fromSlot, state) {
    if (!state) return;
    // 站点每个响应都可能带 set-cookie，搜索并发时写很密集，做 300ms 合并窗口：
    // 关键是不能「只留最后一份」—— 多个 worker 并发写不同 cookie 时那样会丢写。
    this._pendingState = mergeState(this._pendingState, state);
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      const state2 = this._pendingState;
      this._pendingState = null;
      if (!state2) return;
      this._inflightState = (this._inflightState || Promise.resolve())
        .then(() => this._fanoutState(state2))
        .catch(() => 0);
    }, 300);
    if (this._stateTimer.unref) this._stateTimer.unref();
  }

  /**
   * 把合并后的登录态扇出给**所有** worker（含发起者）。
   * 含发起者是必须的：发起者只有自己那部分 cookie，别人的 set-cookie 也要合进去，
   * 否则会出现「slot0 有 qttoken 没 uid、slot1 有 uid 没 qttoken」这种半残状态。
   */
  async _fanoutState(state) {
    if (!state || (!(state.cookie || []).length && !(state.cache || []).length)) return 0;
    this._lastState = mergeState(this._lastState, state);
    state = this._lastState;
    // 内容没变就跳过，避免 import → 站点 set-cookie → 再 import 的抖动
    const key = JSON.stringify(state);
    if (key === this._lastBroadcastKey) return 0;
    this._lastBroadcastKey = key;
    writeStateFile(state);
    const results = await Promise.allSettled(this.slots.map((s) => s.run('stateImport', state, this.timeout)));
    return results.filter((x) => x.status === 'fulfilled').length;
  }

  /** 从某个 worker 拉一份完整快照并全量扇出（等价 cookieDao / cacheDao 的共享单例） */
  async shareStateFrom(slot) {
    if (!slot) return 0;
    let snap;
    try { snap = await slot.run('stateExport', {}, 15000); } catch (e) { return 0; }
    const data = snap && snap.result;
    if (!data || (!(data.cookie || []).length && !(data.cache || []).length)) return 0;
    return await this._fanoutState(data);
  }

  /**
   * 建池时把磁盘上的登录态灌进每个 worker —— 等价 legado 冷启动后
   * CacheManager.get() 直接命中 cacheDao / CookieStore 命中 cookieDao。
   */
  async restoreState() {
    const data = readStateFile();
    if (!data || (!(data.cookie || []).length && !(data.cache || []).length)) return 0;
    this._lastState = data;
    const results = await Promise.allSettled(this.slots.map((s) => s.run('stateImport', data, this.timeout)));
    return results.filter((x) => x.status === 'fulfilled').length;
  }

  /** 单个 worker 重建后补状态（不 await：不能挡住重建流程） */
  _restoreSlot(slot) {
    const data = this._lastState;
    if (!data || (!(data.cookie || []).length && !(data.cache || []).length)) return;
    setTimeout(() => { slot.run('stateImport', data, this.timeout).catch(() => {}); }, 200).unref?.();
  }

  /** 广播任务到所有 worker（每个 worker 都有自己的模块级缓存，需要一起失效） */
  async broadcast(type, payload, opts = {}) {
    const timeout = (opts && opts.timeout) || this.timeout;
    const results = await Promise.allSettled(this.slots.map((s) => s.run(type, payload, timeout)));
    return results.filter((r) => r.status === 'fulfilled').length;
  }

  /** 退出登录后重新落盘（否则重启会把已清除的登录态灌回来） */
  async refreshStateFile() {
    try {
      const snap = await this.slots[0].run('stateExport', {}, 15000);
      const data = snap && snap.result;
      if (!data) return 0;
      this._lastState = data;
      writeStateFile(data);
      return 1;
    } catch (e) { return 0; }
  }

  /** 广播书源（每个 worker 一份） */
  async setSources(sources) {
    this.sources = sources || [];
    const results = await Promise.allSettled(
      this.slots.map((s) => s.run('setSources', { sources: this.sources }, this.timeout)),
    );
    return results.filter((r) => r.status === 'fulfilled').length;
  }

  /**
   * 运行时调整 worker 数量（阅读设置里的「书源并发数」）。
   *
   * 为什么能热改：worker 只持有书源快照与登录态，没有不可迁移的会话数据；
   * 登录态由 _lastState 统一持有，新 worker 建好后用 stateImport 补回（等价 legado
   * 的 CookieStore 单例在进程内一直可见）。
   *
   * 缩容只终止多余的 worker；扩容新建的 worker 会自动拿到当前书源与登录态。
   * 正在跑任务的 worker 不立即杀，等它空闲后再回收，避免打断在飞请求。
   *
   * @returns {number} 实际生效后的 worker 数量
   */
  async resize(nextSize) {
    const want = Math.max(1, Math.min(32, Math.trunc(Number(nextSize) || 0)));
    if (!want || want === this.slots.length) return this.slots.length;

    if (want > this.slots.length) {
      const prevLen = this.slots.length;
      for (let i = prevLen; i < want; i++) this.slots.push(new Slot(this, i));
      // 新 worker 是空的：补书源 + 登录态（老 worker 不动，继续服务在飞请求）
      const fresh = this.slots.slice(prevLen);
      await Promise.allSettled(fresh.map((s) => s.run('setSources', { sources: this.sources }, this.timeout)));
      const state = this._lastState;
      if (state && ((state.cookie || []).length || (state.cache || []).length)) {
        await Promise.allSettled(fresh.map((s) => s.run('stateImport', state, this.timeout)));
      }
    } else {
      const dropped = this.slots.splice(want);
      for (const s of dropped) {
        // 忙的等它跑完再关，避免把在飞请求一起带走
        const closeIt = () => { try { s.worker?.terminate(); } catch (e) { /* noop */ } };
        if (s.pending.size === 0) closeIt();
        else {
          const t = setInterval(() => {
            if (s.pending.size === 0) { clearInterval(t); closeIt(); }
          }, 500);
          if (t.unref) t.unref();
        }
      }
    }
    this.size = this.slots.length;
    return this.size;
  }

  /**
   * 多源并发搜索（legado SearchModel：并发 + mergeItems 合并）
   * @param {Array} sources 要搜的书源（已启用）
   * @param {string} key
   * @param {object} opts { page, precision, timeout, concurrency, onSource, existing, author }
   *   existing —— 上一页已合并的结果（legado SearchModel：同一 searchId 翻页时 searchBooks 累加）
   *   author   —— 换源模式：作者二次过滤（legado ChangeBookSourceViewModel 的 filter 语义）；
   *     普通搜索：仅把作者命中的结果提到前面，不做全局过滤（legado 普通搜索没有作者过滤）
   *   changeSource —— 换源模式：按 legado ChangeBookSourceViewModel.search() 的
   *     filter = { fName, fAuthor, _ -> fName == name && (!checkAuthor || fAuthor.contains(author)) }
   *     逐本过滤（在合并之前过滤，等价于 legado 在 analyzeBookList 里过滤），
   *     否则同作者的其它书（斗破苍穹 → 武动乾坤）会被当成「同名书」混进换源列表。
   */
  async searchAll(sources, key, opts = {}) {
    const page = Number(opts.page) || 1;
    const precision = opts.precision === true;
    const author = String(opts.author || "").trim();
    const changeSource = opts.changeSource === true;
    const checkAuthor = opts.checkAuthor !== false;
    const timeout = Number(opts.timeout) || this.timeout;
    const limit = Math.max(1, Number(opts.concurrency) || this.slots.length);
    const list = (sources || []).slice();
    const results = [];
    const errors = [];
    let cursor = 0;

    const workerFn = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        const s = list[i];
        const t0 = Date.now();
        try {
          const r = await this.request('search', {
            sourceUrl: s.bookSourceUrl, key, page, precision,
          }, { timeout });
          let books = r.result.books || [];
          if (changeSource) books = filterChangeSourceBooks(books, key, author, checkAuthor);
          // actions：书源脚本里 java.showBrowser/startBrowser 收集出来的浏览器动作
          // （legado 会直接弹 WebView，桌面端交给前端开弹窗）
          const item = { sourceUrl: s.bookSourceUrl, sourceName: s.bookSourceName, books, respondTime: r.result.respondTime || (Date.now() - t0), ok: true, actions: r.result.actions || [] };
          results.push(item);
          if (opts.onSource) { try { opts.onSource(item); } catch (e) { /* noop */ } }
        } catch (e) {
          const item = { sourceUrl: s.bookSourceUrl, sourceName: s.bookSourceName, books: [], ok: false, error: e.message, code: e.code, data: e.data || null, respondTime: Date.now() - t0, actions: (e && e.actions) || [] };
          errors.push(item);
          if (opts.onSource) { try { opts.onSource(item); } catch (err) { /* noop */ } }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, list.length)) }, workerFn));

    // 合并（等值 / 标签 / 包含 / 其他 四桶 + origins 数排序）
    const all = [];
    for (const r of results) all.push(...r.books);
    // existing 里的书已经带 origins 数组，交回 mergeItemsLocal 会按同名同作者再合并一轮
    let merged = mergeItemsLocal(all, precision, key, opts.existing || []);
    let filtered = 0;
    // legado 普通搜索（SearchModel.startSearch → WebBook.searchBookAwait(it, key, page, filter)）
    // 只用一个 key 去书源搜，filter 也是拿 key 去比 name/author/kind，**没有**「按作者做全局硬过滤」这一步。
    // 之前这里在普通搜索里按作者过滤，导致「我的星空武道 + 小道白霜」只剩 1 本（作者过滤 182 本）。
    // 现在只在换源模式（changeSource）保留作者过滤；普通搜索传入作者时只把它命中的书排到前面，
    // 不丢弃其它结果，避免「手机能搜到、桌面搜不到」。
    if (author && !changeSource) {
      const hit = merged.filter((b) => String(b.author || "").includes(author));
      if (hit.length && hit.length < merged.length) {
        const hitSet = new Set(hit);
        merged = hit.concat(merged.filter((b) => !hitSet.has(b)));
      }
    }
    return { books: merged, sources: results, errors, filtered };
  }

  close() {
    this.closed = true;
    for (const s of this.slots) {
      try { s.worker?.terminate(); } catch (e) { /* noop */ }
    }
    this.slots = [];
  }
}

/**
 * 换源过滤（legado ChangeBookSourceViewModel.search 的 filter 等价物）：
 *   fName == name && (!checkAuthor || fAuthor.contains(author))
 * 书名必须精确同名；作者按「包含」匹配（legado 用的是 contains 而不是 equals）。
 * trim 是为了兼容书源返回的名字带空白/换行（legado 的 fName 由规则引擎产出，一般已干净）。
 */
function filterChangeSourceBooks(books, key, author, checkAuthor) {
  const want = String(key || "").trim();
  return (books || []).filter((b) => {
    if (String(b.name || "").trim() !== want) return false;
    if (!checkAuthor || !author) return true;
    return String(b.author || "").includes(author);
  });
}

/* mergeItems 的等价实现（等值 / 标签 / 包含 / 其他 四桶 + origins 数排序）。
   注意：跨线程回包已 sanitize，origins 是数组而不是 Set，这里统一按数组处理。 */
function originsOf(b) {
  if (b.origins instanceof Set) return new Set(b.origins);
  if (Array.isArray(b.origins)) return new Set(b.origins);
  return new Set(b.origin ? [b.origin] : []);
}

/** 书源名集合（legado 只有 origin 集合，这里额外带上名字，仅用于界面展示） */
function originNamesOf(b) {
  if (Array.isArray(b.originNames)) return new Set(b.originNames);
  return new Set(b.originName ? [b.originName] : []);
}

/* 光遇聚合这类聚合书源，一条结果对应一个平台（番茄 / 七猫 / 顶点…）。
   bookUrl 是 data:;base64,{"type":"gydetail",...,"sources":"<平台>"}，解出来就是平台名。 */
const PLATFORM_TIER = { "番茄": 100 };
function platformNameOf(b) {
  const u = String((b && b.bookUrl) || "");
  if (u.startsWith("data:") && u.includes("gydetail")) {
    const m = /^data:;base64,([A-Za-z0-9+/=_-]+)/.exec(u);
    if (m) {
      try {
        const j = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const nm = String((j && (j.sources || j.source)) || "").trim();
        if (nm) return nm;
      } catch (e) { /* 解不出来就退回 latestChapterTitle */ }
    }
  }
  const t = String((b && b.latestChapterTitle) || "").trim();
  if (t === "番茄" || t.startsWith("番茄 ")) return "番茄";
  return "";
}
/** 合并时用来挑身份的优先级：番茄条目最高，普通源为 0 */
function platformTierOf(b) {
  return PLATFORM_TIER[platformNameOf(b)] || 0;
}

function mergeItemsLocal(items, precision, key, searchBooks) {
  const equalData = [], tagsData = [], containsData = [], otherData = [];
  const bucketOf = (b) => {
    if (b.name === key || b.author === key) return equalData;
    if (b.kind && String(b.kind).includes(key)) return tagsData;
    if ((b.name && String(b.name).includes(key)) || (b.author && String(b.author).includes(key))) return containsData;
    if (!precision) return otherData;
    return null;
  };
  const put = (bucket, nBook) => {
    if (!bucket) return;
    for (const p of bucket) {
      if (p.name === nBook.name && p.author === nBook.author) {
        // legado SearchModel.mergeItems 只做 pBook.addOrigin(nBook.origin)：
        // 保留先到那条的 origin/originName/bookUrl，绝不覆盖（否则会出现
        // 「originName=松鹤、origin=得奇」这种自相矛盾的记录，读目录时按错书源解析）。
        const set = originsOf(p);
        const names = originNamesOf(p);
        for (const o of originsOf(nBook)) set.add(o);
        for (const n of originNamesOf(nBook)) names.add(n);
        p.origins = [...set];
        p.originNames = [...names];
        // 番茄平台条目（光遇聚合里的晴天番茄）信息最全，用户要求优先展示。
        // legado 的 mergeItems 只 addOrigin、保留先到那条的身份；这里当「先到的是普通源、
        // 后来的这条是番茄条目」时，把展示/解析身份整套换成番茄条目（整套字段替换，
        // 不会出现 originName 与 bookUrl 对不上的自相矛盾记录），其余情况仍是先到先得。
        if (platformTierOf(nBook) > platformTierOf(p)) {
          const keepOrigins = p.origins, keepNames = p.originNames;
          Object.assign(p, nBook);
          p.origins = keepOrigins;
          p.originNames = keepNames;
        }
        return;
      }
    }
    nBook.origins = [...originsOf(nBook)];
    nBook.originNames = [...originNamesOf(nBook)];
    bucket.push(nBook);
  };
  for (const b of (searchBooks || [])) put(bucketOf(b), b);
  for (const b of items) put(bucketOf(b), b);
  const sizeOf = (o) => (o instanceof Set ? o.size : Array.isArray(o) ? o.length : 0);
  const bySize = (a, b) => sizeOf(b.origins) - sizeOf(a.origins);
  equalData.sort(bySize); tagsData.sort(bySize); containsData.sort(bySize);
  const merged = [...equalData, ...tagsData, ...containsData];
  if (!precision) merged.push(...otherData);
  return merged;
}

export default BookPool;
