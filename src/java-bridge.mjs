// java-bridge.mjs —— java.* 桥接工具（不依赖 analyze-url / rule-engine，避免循环 import）
import { JavaBridgeBase } from './js-runtime.mjs';
import { makeStrResponse } from './packages-shim.mjs';

/** StrResponse 的 JS 可见形态 */
export function toStrResponse(r) {
  return makeStrResponse({
    url: r.url,
    body: r.body,
    code: typeof r.code === 'number' ? r.code : 200,
    message: r.message,
    headers: r.headers || {},
    callTime: r.callTime || 0,
  });
}

export function getAllMethodNames(obj) {
  const names = new Set();
  let cur = obj;
  while (cur && cur !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(cur)) names.add(n);
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

/**
 * 给 java 桥接对象混入 override 方法，并绑定基类原型上的全部方法。
 * 返回的对象里所有方法都 .bind 到自身，可直接以 java.xxx() 调用。
 */
export function mixJavaBridge(base, overrides = {}) {
  const obj = Object.create(base);
  for (const [k, v] of Object.entries(overrides)) obj[k] = v;
  for (const k of getAllMethodNames(base)) {
    if (typeof base[k] === 'function' && !(k in obj && typeof obj[k] === 'function' && obj[k] !== base[k])) {
      obj[k] = base[k].bind(base);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    obj[k] = typeof v === 'function' ? v.bind(obj) : v;
  }
  return obj;
}

/** 构造一个 java 桥接（source 级） */
export function makeJavaBridge({ source, cookieStore, cache, logger, network, browserActions, overrides } = {}) {
  const base = new JavaBridgeBase({ source, cookieStore, cache, logger, network, browserActions });
  const ov = {
    getSource: () => source || null,
    getTag: () => (source ? source.bookSourceName || '' : ''),
    ...(overrides || {}),
  };
  return mixJavaBridge(base, ov);
}

export { JavaBridgeBase, makeStrResponse };