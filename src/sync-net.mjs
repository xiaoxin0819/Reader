// sync-net.mjs —— 同步 HTTP 桥（Atomics + worker 消息驱动）
// 供规则 JS（Rhino 语义，同步）调用 java.ajax / java.get / java.post / java.connect
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorker } from './exe-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLOT_SIZE = 2 * 1024 * 1024;

let SLOTS = 16;
let metaSab = null;
let meta = null;
let dataSab = null;
let data = null;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
let worker = null;
let started = false;
let lastError = null;
const waiters = new Map(); // slot -> Array<{resolve, reject}>

function metaBase(i) { return 8 + i * 8; }
const waitArr = new Int32Array(new SharedArrayBuffer(4));

function initBufs(slots) {
  SLOTS = slots;
  metaSab = new SharedArrayBuffer(4 * (8 + SLOTS * 8) + 64);
  meta = new Int32Array(metaSab);
  dataSab = new SharedArrayBuffer(SLOT_SIZE * SLOTS);
  data = new Uint8Array(dataSab);
  Atomics.store(meta, 0, SLOTS);
}

initBufs(16);

export function configureNet(slots = 16) {
  shutdownNet();
  initBufs(slots);
  ensureWorker();
}

function ensureWorker() {
  if (started) return;
  started = true;
  // exe（SEA）模式下磁盘没有 worker 文件，改用打包时注入的源码 eval 启动
  worker = createWorker(
    'netWorker',
    path.join(__dirname, 'net-worker.mjs'),
    { slots: SLOTS, slotSize: SLOT_SIZE, metaSab, dataSab },
    Worker,
  );
  worker.unref?.();
  worker.on('error', (e) => { lastError = e; started = false; });
  worker.on('exit', () => { started = false; });
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(waitArr, 0, 0, ms);
}

function acquireSlot() {
  for (let attempt = 0; attempt < 60000; attempt++) {
    for (let i = 0; i < SLOTS; i++) {
      const b = metaBase(i);
      if (Atomics.load(meta, b + 3) === 0 && Atomics.load(meta, b + 1) === 0) {
        if (Atomics.compareExchange(meta, b + 3, 0, 1) === 0) return i;
      }
    }
    sleepMs(2);
  }
  throw new Error('sync-net: no free slot');
}

function releaseSlot(i) {
  const b = metaBase(i);
  Atomics.store(meta, b + 1, 0);
  Atomics.store(meta, b + 2, 0);
  Atomics.store(meta, b + 0, 0);
  Atomics.store(meta, b + 3, 0);
}

/**
 * 同步发起请求（阻塞主线程直至 worker 写回）
 */
export function requestSync(req, timeoutMs = 120000) {
  ensureWorker();
  if (!worker) throw new Error('sync-net: worker 启动失败 ' + (lastError ? lastError.message : ''));
  const i = acquireSlot();
  const b = metaBase(i);
  const off = i * SLOT_SIZE;
  const json = enc.encode(JSON.stringify(req));
  if (json.length > SLOT_SIZE - 1024) {
    releaseSlot(i);
    throw new Error('sync-net: 请求体过大');
  }
  data.set(json, off);
  Atomics.store(meta, b + 2, json.length);
  Atomics.store(meta, b + 1, 0);
  Atomics.store(meta, b + 0, 1);
  worker.postMessage({ slot: i });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const flag = Atomics.load(meta, b + 1);
    if (flag !== 0) {
      const len = Atomics.load(meta, b + 2);
      const txt = dec.decode(data.subarray(off, off + len));
      releaseSlot(i);
      let obj;
      try { obj = JSON.parse(txt); } catch (e) { throw new Error('sync-net: 响应解析失败 ' + e.message); }
      if (!obj.ok) {
        const err = new Error(obj.error || 'request failed');
        err.codeName = obj.codeName || null;
        err.url = obj.url;
        throw err;
      }
      return obj;
    }
    if (Date.now() > deadline) {
      releaseSlot(i);
      throw new Error(`sync-net: 请求超时（${timeoutMs}ms） ${req.url}`);
    }
    sleepMs(3);
  }
}

export function shutdownNet() {
  try { worker?.terminate(); } catch (e) { /* noop */ }
  worker = null;
  started = false;
}

export function netLastError() { return lastError; }
