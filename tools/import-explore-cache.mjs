#!/usr/bin/env node
/**
 * 把 legado（手机端）的发现页分类缓存导入本阅读器。
 *
 * 背景：光遇聚合这类书源的发现页分类（榜单入口）是 exploreUrl 脚本里
 * `java.ajax(base_url + "/discovestyle?...")` 拉回来的，源站挂掉时脚本
 * try/catch 吞掉异常，只能吐出筛选框。手机 legado 只要有缓存就照常显示，
 * 所以直接把手机那份 cache/explore/<key> 文件搬过来是最可靠的恢复方式。
 *
 * 用法：
 *   node tools/import-explore-cache.mjs <缓存文件路径> [书源名关键字]
 * 例：
 *   node tools/import-explore-cache.mjs D:\627715079 光遇
 *
 * key 与 legado 一致：md5(bookSourceUrl + exploreUrl)，
 * 落盘文件名 = Java String.hashCode(key)，所以手机上的文件通常可以同名直接用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getACache } from '../src/acache.mjs';
import { md5Encode } from '../src/explore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSources() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources', 'book-sources.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.bookSources || raw.sources || []);
  return list.filter((s) => s && s.bookSourceUrl);
}

function keyOf(source) {
  return md5Encode(String(source.bookSourceUrl) + String(source.exploreUrl == null ? '' : source.exploreUrl));
}

function scoreKinds(kinds) {
  let urls = 0;
  for (const k of kinds) if (k && k.url) urls += 1;
  return { urls, total: kinds.length };
}

const [, , fileArg, sourceArg] = process.argv;
if (!fileArg) {
  console.error('用法：node tools/import-explore-cache.mjs <缓存文件路径> [书源名关键字]');
  process.exit(2);
}
const srcPath = path.resolve(fileArg);
if (!fs.existsSync(srcPath)) { console.error('文件不存在：' + srcPath); process.exit(1); }

const text = fs.readFileSync(srcPath, 'utf8').trim();
let kinds;
try { kinds = JSON.parse(text); } catch (e) { console.error('不是合法 JSON：' + e.message); process.exit(1); }
if (!Array.isArray(kinds) || !kinds.length) { console.error('内容不是非空 JSON 数组，不是 legado 的发现分类缓存'); process.exit(1); }

const keyword = sourceArg || '光遇';
const sources = loadSources();
const hit = sources.find((s) => String(s.bookSourceName || '').includes(keyword) || String(s.bookSourceUrl || '').includes(keyword));
if (!hit) { console.error(`没找到书名含「${keyword}」的书源`); process.exit(1); }

const key = keyOf(hit);
const cache = getACache('explore');
const target = cache.fileOf(key);
let before = { urls: 0, total: 0 };
try { before = scoreKinds(JSON.parse(cache.getAsString(key) || '[]')); } catch { /* 旧缓存不是 JSON 数组就当空的 */ }
const after = scoreKinds(kinds);

if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak-' + Date.now());
cache.put(key, text);
cache.putGood(key, text);

const mb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log('书源      :', hit.bookSourceName);
console.log('缓存 key  :', key);
console.log('落盘文件  :', target);
console.log('导入条目  :', after.total, '条（其中带榜单入口', after.urls, '条）', mb(Buffer.byteLength(text)));
console.log('导入前    :', before.total, '条（其中带榜单入口', before.urls, '条）');
console.log(after.urls > before.urls ? '✅ 榜单入口变多了，导入有效' : '⚠️ 榜单入口没有变多，确认一下是不是同一个书源版本');
console.log('下一步    : 重启 Reader 服务（内存里的 exploreKindsMap 还是旧的）');
