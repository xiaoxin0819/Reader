// exe-env.mjs —— 单文件 exe（Node.js SEA）运行时的环境适配
//
// 为什么需要：SEA 把所有代码打进一个 exe，磁盘上没有 src/*.mjs、public/*，
// 因此两件事必须改：
//   1) new Worker(文件路径) 找不到 worker 文件 → 改用 new Worker(源码字符串, { eval: true })
//   2) fs.readFileSync(public/xxx) 找不到文件 → 改从 SEA assets 里取
//
// 非 exe 模式（npm start / 启动Reader.bat）下这些函数都是直通，行为不变。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 是否运行在 SEA 单文件里。
 *
 * 注意：必须是「每次读 globalThis」的函数，不能用模块级常量。
 * 原因：book-worker 线程在 import 本模块之后才从 workerData 注入
 * __READER_IS_SEA__，那时常量早已求值成 false，
 * 会导致嵌套的 net-worker 退回「按文件路径启动」而找不到文件。
 */
export function isSea() {
  return globalThis.__READER_IS_SEA__ === true;
}

/** SEA 资源名 → 内容（打包时注入 __READER_SEA_GET__） */
function seaAsset(name) {
  const get = globalThis.__READER_SEA_GET__;
  if (typeof get !== 'function') return null;
  return get(name);
}

/**
 * 读取前端资源。
 * exe 模式从 SEA assets 取，开发模式走磁盘。
 * @param {string} rel 相对 public/ 的路径，如 "index.html"
 * @returns {Buffer|null}
 */
export function readAsset(rel) {
  if (isSea()) {
    // assets 名就是文件名（见 build/build-exe.mjs 的 ASSETS 表）
    const name = String(rel).replace(/^[\\/]+/, '');
    return seaAsset(name);
  }
  try { return fs.readFileSync(rel, 'utf8'); } catch { return null; }
}

/**
 * 读取「随程序分发」的内置 JSON（sources/*.json）。
 * exe 模式下这些文件也作为 assets 嵌入。
 */
export function readBuiltinJson(basename) {
  if (isSea()) return seaAsset(basename);
  return null;   // 开发模式由调用方直接读磁盘
}

/**
 * 启动 worker。
 *
 * exe 模式：worker 源码由打包入口注入到 globalThis.__READER_WORKER_SRC__，
 * 用 eval 方式启动（SEA 里没有 worker 文件）。
 * 开发模式：走原来的文件路径。
 *
 * ⚠ worker 线程之间不共享 globalThis：
 *   book-worker 里还会再起 net-worker（sync-net 的嵌套 worker），
 *   而子线程看不到父线程注入的 __READER_WORKER_SRC__。
 *   所以这里把「net-worker 的源码」通过 workerData 一起传下去，
 *   由子线程自己重新注入到它的 globalThis。否则嵌套 worker 起不来，
 *   表现为所有网络请求静默挂死、最后报「任务超时」。
 *
 * @param {string} kind 'bookWorker' | 'netWorker'
 * @param {string} filePath 开发模式下的 worker 文件绝对路径
 * @param {object} workerData 传给 worker 的数据
 * @param {Function} WorkerCtor worker_threads 的 Worker 构造器
 */
export function createWorker(kind, filePath, workerData, WorkerCtor) {
  if (isSea()) {
    const src = globalThis.__READER_WORKER_SRC__ && globalThis.__READER_WORKER_SRC__[kind];
    if (!src) throw new Error(`exe 模式缺少 worker 源码: ${kind}`);
    return new WorkerCtor(src, {
      eval: true,
      workerData: withNestedWorkerSrc(kind, workerData),
    });
  }
  return new WorkerCtor(filePath, { workerData });
}

/**
 * 给 workerData 补上「子 worker 需要的源码」。
 *
 * book-worker 里会再起 net-worker，而 worker 线程之间不共享 globalThis。
 * 把 netWorker 源码塞进 workerData，book-worker 启动时自行注入。
 * net-worker 是叶子节点（不再起 worker），无需再往下传。
 */
function withNestedWorkerSrc(kind, workerData) {
  if (kind !== 'bookWorker') return workerData;
  const all = globalThis.__READER_WORKER_SRC__ || {};
  if (!all.netWorker) return workerData;
  return { ...(workerData || {}), __netWorkerSrc: all.netWorker };
}

/** 开发模式下 exe 相关目录不存在；返回 null 让调用方走原逻辑 */
export function seaPublicDir() {
  return isSea() ? '__sea_assets__' : null;
}
