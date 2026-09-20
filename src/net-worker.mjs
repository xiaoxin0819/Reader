// net-worker.mjs —— 网络工作线程（消息驱动，不阻塞事件循环）
// main 通过 postMessage({slot:i}) 唤醒；worker 异步执行后写 SAB 并 Atomics.notify
import { parentPort, workerData } from 'node:worker_threads';
import { requestRaw } from './http-core.mjs';

const SLOTS = workerData.slots;
const SLOT_SIZE = workerData.slotSize;
const meta = new Int32Array(workerData.metaSab);
const data = new Uint8Array(workerData.dataSab);
const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();

function metaBase(i) { return 8 + i * 8; }

function writeResponse(i, obj) {
  const b = metaBase(i);
  const off = i * SLOT_SIZE;
  let bytes = enc.encode(JSON.stringify(obj));
  if (bytes.length > SLOT_SIZE) {
    const keep = Math.max(0, SLOT_SIZE - 4096);
    const small = {
      ok: obj.ok, url: obj.url, code: obj.code, message: obj.message,
      headers: obj.headers, charset: obj.charset, setCookies: obj.setCookies,
      body: String(obj.body || '').slice(0, keep), truncated: true,
      error: obj.error, codeName: obj.codeName, hops: obj.hops,
    };
    bytes = enc.encode(JSON.stringify(small));
    if (bytes.length > SLOT_SIZE) {
      bytes = enc.encode(JSON.stringify({ ok: false, error: 'response too large', body: '' }));
    }
  }
  data.set(bytes, off);
  Atomics.store(meta, b + 2, bytes.length);
  Atomics.store(meta, b + 1, obj.ok ? 1 : 2);
  Atomics.notify(meta, b + 1);
}

async function handleSlot(i) {
  const b = metaBase(i);
  const off = i * SLOT_SIZE;
  const len = Atomics.load(meta, b + 2);
  const json = dec.decode(data.subarray(off, off + len));
  let req;
  try {
    req = JSON.parse(json);
  } catch (e) {
    writeResponse(i, { ok: false, error: 'bad request json: ' + e.message, body: '' });
    return;
  }
  try {
    const res = await requestRaw(req);
    writeResponse(i, {
      ok: true,
      url: res.url, code: res.code, message: res.message,
      headers: res.headers, body: res.body, charset: res.charset,
      setCookies: res.setCookies, hops: res.hops, error: null,
    });
  } catch (e) {
    writeResponse(i, {
      ok: false, url: req.url, code: -1,
      error: String((e && e.message) || e),
      codeName: (e && e.code) || null, body: '',
    });
  }
}

parentPort.on('message', (msg) => {
  const i = msg && msg.slot;
  if (typeof i === 'number' && i >= 0 && i < SLOTS) {
    handleSlot(i).catch(() => {});
  }
});