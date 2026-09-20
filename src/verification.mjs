// verification.mjs —— SourceVerificationHelp 的桌面端替身
//
// legado 里 WebView 类书源（@webjs: / useWebView）靠安卓 WebView 执行 JS 取源，
// 遇到验证码/滑块时弹 Activity 让用户手动过验证，再由 SourceVerificationHelp
// 把结果回传给正在阻塞等待的抓取协程。
//
// 桌面端没有 WebView，这里改为「等用户从 UI 提交」：
//   1. 抓取线程（worker）发现需要 WebView → 抛出 VerificationRequiredError（含 url/title/sourceKey）
//   2. server 收到后返回 202 + 验证任务 id 给前端，前端在「验证」面板里让用户
//      打开链接、手动过验证、把页面 HTML（或最终 URL）粘贴/提交回来
//   3. server 通过 worker 消息调用 setResult()
//   4. 抓取线程用 Atomics.wait 轮询等待结果（同步阻塞，符合 Rhino 语义）
//
// 该模块只能在 worker 线程里做阻塞等待（Atomics.wait 会阻塞调用线程）。

/** 等待用户验证（默认 5 分钟），期间轮询间隔 100ms（对应 legado waitTime = 1 minute 轮询） */
const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 100;

const waitArr = new Int32Array(new SharedArrayBuffer(4));

/** sourceKey -> { url, result } */
const results = new Map();
/** sourceKey -> { sourceKey, url, title, sourceName, kind, createdAt, message } */
const pending = new Map();
/** 回调：有新的验证任务产生时通知 server（worker → main） */
let notifyPending = null;

export function setPendingNotifier(fn) { notifyPending = typeof fn === 'function' ? fn : null; }

/** 需要人工介入（WebView / 验证码）时抛出，携带足够信息让 UI 展示 */
export class VerificationRequiredError extends Error {
  constructor({ sourceKey, url, title, sourceName, kind, message } = {}) {
    super(message || '该书源需要 WebView / 人工验证，请在验证面板中打开链接并提交结果');
    this.name = 'VerificationRequiredError';
    this.verificationRequired = true;
    this.sourceKey = sourceKey || '';
    this.url = url || '';
    this.title = title || '';
    this.sourceName = sourceName || '';
    this.kind = kind || 'webview';
  }
}

/** SourceVerificationHelp.setResult */
export function setResult(sourceKey, result, url = '') {
  const key = String(sourceKey || '');
  if (!key) return false;
  const value = result === null || result === undefined ? '' : String(result);
  results.set(key, { url: String(url || ''), result: value });
  const p = pending.get(key);
  if (p) { p.resolvedAt = Date.now(); p.done = true; }
  Atomics.notify(waitArr, 0);
  return true;
}

/** SourceVerificationHelp.getResult → {url, result} | null */
export function getResult(sourceKey) {
  const v = results.get(String(sourceKey || ''));
  return v === undefined ? null : v;
}

/** 取出并清除 */
export function takeResult(sourceKey) {
  const key = String(sourceKey || '');
  const v = results.get(key);
  results.delete(key);
  return v === undefined ? null : v;
}

/** SourceVerificationHelp.clearResult */
export function clearResult(sourceKey) {
  results.delete(String(sourceKey || ''));
  return true;
}

/** SourceVerificationHelp.checkResult（内存里是否有待处理结果） */
export function checkResult(sourceKey) {
  return results.has(String(sourceKey || ''));
}

/** 注册一个验证任务（抓取线程调用） */
export function requestVerification(info = {}) {
  const key = String(info.sourceKey || '');
  if (!key) return null;
  const task = {
    id: key,
    sourceKey: key,
    sourceName: info.sourceName || '',
    url: info.url || '',
    title: info.title || '',
    kind: info.kind || 'webview',
    message: info.message || '',
    createdAt: Date.now(),
    done: false,
  };
  pending.set(key, task);
  results.delete(key);
  if (notifyPending) {
    try { notifyPending({ ...task }); } catch (e) { /* ignore */ }
  }
  return task;
}

export function removePending(sourceKey) { pending.delete(String(sourceKey || '')); }

export function listPending() {
  return [...pending.values()].filter((p) => !p.done);
}

/**
 * 同步等待用户在 UI 里提交验证结果（阻塞当前线程）。
 * 超时抛 VerificationRequiredError。
 */
export function waitForVerification(info = {}, timeoutMs = DEFAULT_WAIT_MS) {
  const key = String(info.sourceKey || '');
  const existing = getResult(key);
  if (existing && existing.result) { results.delete(key); return existing; }
  requestVerification(info);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  for (;;) {
    const v = getResult(key);
    if (v && v.result) {
      removePending(key);
      results.delete(key);
      return v;
    }
    if (Date.now() > deadline) {
      removePending(key);
      throw new VerificationRequiredError({ ...info, message: '等待人工验证超时（未在限定时间内提交结果）' });
    }
    Atomics.wait(waitArr, 0, 0, POLL_MS);
  }
}

/** 供 worker 关闭时清理 */
export function resetVerification() {
  results.clear();
  pending.clear();
}

export const VerificationHelp = {
  setResult, getResult, takeResult, clearResult, checkResult,
  requestVerification, removePending, listPending, waitForVerification, resetVerification,
  setPendingNotifier, VerificationRequiredError,
};

export default VerificationHelp;
