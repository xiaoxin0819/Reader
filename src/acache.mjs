// ACache.kt 的桌面端移植（只保留 String 数据这一条链路）。
// legado: app/src/main/java/io/legado/app/utils/ACache.kt
//   ACache.get("explore") → cacheDir/explore 目录，一个 key 一个文件，
//   文件名 = key.hashCode()（Java String.hashCode，见 newFile()），
//   文件内容就是原始字符串；put(key, value) 不写时间信息 ⇒ 永不过期，
//   只有 remove(key) / 清缓存（删 cacheDir）才会失效。
// 发现页分类（exploreKinds）就靠它跨进程、跨重启复用 —— legado 里
// BookSourceExtensions.kt 的 exploreKinds() 先查 aCache，命中就不再执行 exploreUrl 里的 JS。
// 文件名与 legado 完全一致（同一 key 落地同名文件），因此 legado 的 cache/explore
// 目录可以直接拷进 Reader/cache/explore 复用（包括光遇这种源站挂掉只有缓存的情况）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// exe（SEA）模式没有 import.meta.url，用 exe 所在目录作为根
const ROOT = globalThis.__READER_IS_SEA__
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 server.mjs 使用同一个 READER_CACHE_DIR；worker 进程继承服务进程环境变量。
export const CACHE_ROOT = process.env.READER_CACHE_DIR
  ? path.resolve(process.env.READER_CACHE_DIR)
  : path.join(ROOT, 'cache');

const instances = new Map();

/** Java String.hashCode()（int 溢出语义），legado ACacheManager.newFile 用的就是它 */
function javaHashCode(str) {
  const s = String(str);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

export class ACache {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
  }

  fileOf(key) { return path.join(this.dir, String(javaHashCode(key))); }

  /** legado ACache.getAsString(key)：没有/读失败都返回 null。
   *  注意 legado 的 operator get() 会 setLastModified（LRU 用的“最近使用时间”），
   *  这里不 touch，让 mtime 保持“写入时间”，上层 TTL 重校验才有意义。 */
  getAsString(key) {
    try {
      const v = fs.readFileSync(this.fileOf(key), 'utf8');
      return v && v.length ? v : null;
    } catch { return null; }
  }

  /** legado ACache.put(key, value)：直接落盘，不带过期时间 */
  put(key, value) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.fileOf(key);
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, String(value), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch { return false; }
  }

  /** 缓存文件最近一次写入时间（ms）；未命中返回 0。legado ACache 本身不记录时间，
   *  这里只给上层做“要不要重新执行脚本”的判断用。 */
  mtimeOf(key) {
    try { return fs.statSync(this.fileOf(key)).mtimeMs; } catch { return 0; }
  }

  /** 「最近一次完整结果」备份文件：<key>.good。
   *  legado 本身没有这一步：它的 aCache 只要非空就永远不再重算，
   *  所以不会出现"残缺结果覆盖完整缓存"。桌面端多了「刷新」入口 +
   *  源站经常半死不活，多留一份备份才能自愈。 */
  goodFileOf(key) { return this.fileOf(key) + ".good"; }

  getGoodAsString(key) {
    try {
      const v = fs.readFileSync(this.goodFileOf(key), "utf8");
      return v && v.length ? v : null;
    } catch { return null; }
  }

  putGood(key, value) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.goodFileOf(key);
      const tmp = f + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, String(value), "utf8");
      fs.renameSync(tmp, f);
      return true;
    } catch { return false; }
  }

  remove(key) {
    try { fs.rmSync(this.fileOf(key), { force: true }); } catch { /* ignore */ }
  }

  /** 先写 *.tmp 再 rename，避免多 worker 并发读到半截文件 */
  clear() {
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
  }
}

export function getACache(name) {
  const key = String(name || 'ACache');
  let inst = instances.get(key);
  if (!inst) {
    inst = new ACache(path.join(CACHE_ROOT, key));
    instances.set(key, inst);
  }
  return inst;
}
