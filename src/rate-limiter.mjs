// rate-limiter.mjs —— ConcurrentRateLimiter.kt 的同步复刻
// concurrentRate 语义："次数/间隔ms"（如 "2/1000"），或单个数字 = 1/该毫秒数
const recordMap = new Map(); // key -> {time, accessLimit, interval, frequency}

export function parseConcurrentRate(rate) {
  if (!rate) return null;
  const s = String(rate).trim();
  const idx = s.indexOf('/');
  if (idx > 0) {
    const limit = parseInt(s.substring(0, idx), 10);
    const interval = parseInt(s.substring(idx + 1), 10);
    if (!Number.isFinite(limit) || !Number.isFinite(interval)) return null;
    if (limit <= 0 || interval <= 0) return null;
    return { accessLimit: limit, interval };
  }
  const n = parseInt(s, 10);
  if (Number.isFinite(n) && n > 0) return { accessLimit: 1, interval: n };
  return null;
}

export function updateConcurrentRate(key, rate) {
  const parsed = parseConcurrentRate(rate);
  if (!parsed) return;
  const old = recordMap.get(key);
  recordMap.set(key, {
    time: old ? old.time : Date.now(),
    accessLimit: parsed.accessLimit,
    interval: parsed.interval,
    frequency: old ? old.frequency : 0,
  });
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  if (ms > 0) Atomics.wait(sleepBuf, 0, 0, ms);
}

export class ConcurrentLimiter {
  constructor(rate) {
    this.rate = parseConcurrentRate(rate);
    this.key = null;
  }

  /** 阻塞直到允许访问（对应 withLimit） */
  acquire() {
    if (!this.rate || !this.key) return;
    for (;;) {
      const wait = this._try();
      if (wait <= 0) return;
      sleepMs(wait);
    }
  }

  _try() {
    const now = Date.now();
    let rec = recordMap.get(this.key);
    if (!rec) {
      recordMap.set(this.key, {
        time: now, accessLimit: this.rate.accessLimit,
        interval: this.rate.interval, frequency: 1,
      });
      return 0;
    }
    const nextTime = rec.time + rec.interval;
    if (now >= nextTime) {
      rec.time = now;
      rec.frequency = 1;
      return 0;
    }
    if (rec.frequency < rec.accessLimit) {
      rec.frequency++;
      return 0;
    }
    return nextTime - now;
  }
}

const limiterCache = new Map();

export function getConcurrentLimiter(source) {
  if (!source) return null;
  const rate = source.concurrentRate;
  const parsed = parseConcurrentRate(rate);
  if (!parsed) return null;
  const key = source.bookSourceUrl || source.getKey?.();
  if (!key) return null;
  let limiter = limiterCache.get(key);
  const rateStr = String(rate);
  if (!limiter || limiter.rateStr !== rateStr) {
    limiter = new ConcurrentLimiter(rate);
    limiter.rateStr = rateStr;
    limiter.key = key;
    limiterCache.set(key, limiter);
  }
  return limiter;
}

export function resetLimiters() { limiterCache.clear(); recordMap.clear(); }