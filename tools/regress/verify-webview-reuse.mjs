/* 验证内置浏览器能复用已在运行的 Edge 实例。

   背景：Edge 对同一个 user-data-dir 是单实例的。若已有 Edge 占着这个 profile
   （上一次没关干净、或源码版与 exe 版共用同一个 cache/webview），
   新起的 Edge 会把请求转交过去后**以 exit 0 正常退出**，
   旧代码先删了 DevToolsActivePort，于是必然报「浏览器进程启动即退出（exit 0）」，
   用户看到的是「打开失败」。

   用法：node tools/regress/verify-webview-reuse.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserHost, findChromium } from '../../src/browser-host.mjs';

const pass = [];
const fail = [];
const ck = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

const bin = findChromium();
ck(!!bin, '找到本机浏览器内核', bin || '(未找到)');
if (!bin) {
  console.log('\n===== 内置浏览器复用验证 =====');
  for (const f of fail) console.log('  FAIL  ' + f);
  process.exit(1);
}

const base = path.join(os.tmpdir(), 'reader-webview-reuse');
const dataDir = path.join(base, 'webview');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const a = new BrowserHost({ bin, dataDir });
const b = new BrowserHost({ bin, dataDir });   // 同一个 profile：旧代码在这里必挂

try {
  await a.ensure();
  ck(!!a.port, '第 1 个实例启动成功', '端口 ' + a.port);
  const tabA = await a.open({ url: 'about:blank', title: 'a' });
  ck(!!tabA && !!tabA.id, '第 1 个实例能开标签', tabA && tabA.id);

  await b.ensure();
  ck(!!b.port, '第 2 个实例（同 profile）不再报 exit 0', '端口 ' + b.port);
  ck(b.port === a.port, '第 2 个实例复用了同一个浏览器', `${a.port} vs ${b.port}`);
  const tabB = await b.open({ url: 'about:blank', title: 'b' });
  ck(!!tabB && !!tabB.id, '第 2 个实例能开标签', tabB && tabB.id);
} catch (e) {
  fail.push('异常: ' + e.message);
} finally {
  try { await a.closeAll(); } catch {}
  try { await b.closeAll(); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('\n===== 内置浏览器复用验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
