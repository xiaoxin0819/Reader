// crypto-js.mjs —— legado SharedJsScope 的 CryptoJS 注入（桌面端复刻）
//
// legado 把 assets/scripts/cryptojs.min.js 注入到每个 JS 作用域（书源脚本 / jsLib /
// JS 单文件源），并用 __legadoSecureRandomInt 替换 WordArray.random 的实现
// （安卓 WebView 的 crypto.getRandomValues 不可用，改由 SecureRandom 提供熵）。
//
// 这里等价地：读 vendor/cryptojs.min.js（同一份资产），在 vm context 里 eval 一次，
// 并把 WordArray.random 打补丁到 Node 的 crypto.randomInt 上。
//
// 注意：CryptoJS 必须在 SANDBOX_BOOTSTRAP 之后、用户脚本之前注入，且只注入一次。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRYPTO_JS_PATH = path.join(__dirname, '..', 'vendor', 'cryptojs.min.js');

/** 与 SharedJsScope.SECURE_RANDOM_PATCH 等价 */
const SECURE_RANDOM_PATCH = `
CryptoJS.lib.WordArray.random = (function(nextInt) {
    return function(nBytes) {
        var words = [];
        for (var i = 0; i < nBytes; i += 4) {
            words.push(nextInt());
        }
        return CryptoJS.lib.WordArray.create(words, nBytes);
    };
})(__legadoSecureRandomInt);
`;

let cryptoJsText = null;
let loadError = null;

/** 读取（并缓存）CryptoJS 源码 */
export function loadCryptoJsText() {
  if (cryptoJsText !== null) return cryptoJsText;
  try {
    cryptoJsText = fs.readFileSync(CRYPTO_JS_PATH, 'utf8');
  } catch (e) {
    // exe（SEA）模式：vendor/cryptojs.min.js 打包进 exe，磁盘上没有该文件
    const fromAsset = globalThis.__READER_IS_SEA__ && typeof globalThis.__READER_SEA_GET__ === 'function'
      ? globalThis.__READER_SEA_GET__('cryptojs.min.js')
      : null;
    if (fromAsset) {
      cryptoJsText = Buffer.from(fromAsset).toString('utf8');
    } else {
      loadError = e;
      cryptoJsText = '';
    }
  }
  return cryptoJsText;
}

export function cryptoJsAvailable() { return loadCryptoJsText().length > 0; }
export function cryptoJsLoadError() { return loadError; }

/** __legadoSecureRandomInt（等价 SecureRandom.nextInt()） */
function secureRandomInt() { return crypto.randomInt(0x80000000) - 0x40000000; }
export { secureRandomInt };

/**
 * 把 CryptoJS 装进一个 vm context（等价 SharedJsScope.installCryptoJs）。
 * @param {object} ctx vm context
 * @param {object} opts { logger }
 * @returns {boolean} 是否成功注入
 */
export function installCryptoJs(ctx, opts = {}) {
  const src = loadCryptoJsText();
  if (!src) return false;
  if (ctx.__legadoCryptoJsInstalled) return true;
  try {
    // __legadoSecureRandomInt 只在校验期间存在（legado 也是装完就 delete）
    ctx.__legadoSecureRandomInt = secureRandomInt;
    vm.runInContext(src, ctx, { timeout: 60000, filename: 'cryptojs.min.js' });
    vm.runInContext(SECURE_RANDOM_PATCH, ctx, {
      timeout: 10000, filename: 'cryptojs-random-patch.js',
    });
    ctx.__legadoCryptoJsInstalled = true;
    return true;
  } catch (e) {
    if (opts.logger) opts.logger(`加载CryptoJS失败: ${e && e.message}`);
    return false;
  } finally {
    try { delete ctx.__legadoSecureRandomInt; } catch (e) { /* noop */ }
  }
}

export default { installCryptoJs, loadCryptoJsText, cryptoJsAvailable, secureRandomInt };
