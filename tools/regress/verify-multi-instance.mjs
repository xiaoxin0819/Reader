/* 验证「同时开多个 Reader 实例」。

   规则：**数据目录（cacheDir）不同 = 不同实例，可以并存**；
        数据目录相同 = 同一个实例，重复启动会被识别为「已在运行」并退出。

   背景：/api/instance 曾经只返回 dataDir（程序目录）。用户用不同的
   READER_CACHE_DIR 想开两份时，两个进程的 dataDir 都是 Reader，
   于是第二个被误判成「已在运行」直接退出 —— 表现为「开不了第二个」。
   现在 /api/instance 额外返回 cacheDir，判定改用 cacheDir。

   用法：node tools/regress/verify-multi-instance.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const pass = [];
const fail = [];
const ck = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

const waitOk = async (url, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

function start(port, cacheDir) {
  const env = { ...process.env, PORT: String(port), READER_OPEN_BROWSER: '0' };
  if (cacheDir) env.READER_CACHE_DIR = cacheDir;
  const p = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p._out = '';
  p.stdout.on('data', (d) => { p._out += d.toString(); });
  p.stderr.on('data', (d) => { p._out += d.toString(); });
  return p;
}

const DIR_B = path.join(os.tmpdir(), 'reader-multi-instance-B');
fs.rmSync(DIR_B, { recursive: true, force: true });
fs.mkdirSync(DIR_B, { recursive: true });

const A_PORT = 17801;
const B_PORT = 17802;
let a = null, b = null, c = null;

try {
  // 1) 两个不同 cacheDir 的实例应能并存
  a = start(A_PORT, null);
  b = start(B_PORT, path.join(DIR_B, 'cache'));

  const okA = await waitOk(`http://127.0.0.1:${A_PORT}/api/state`);
  const okB = await waitOk(`http://127.0.0.1:${B_PORT}/api/state`);
  ck(okA, '实例 A 启动（默认 cacheDir）');
  ck(okB, '实例 B 启动（自定义 READER_CACHE_DIR）');
  ck(okA && okB, '两个不同 cacheDir 的实例可以同时运行');

  if (okA && okB) {
    const ia = await (await fetch(`http://127.0.0.1:${A_PORT}/api/instance`)).json();
    const ib = await (await fetch(`http://127.0.0.1:${B_PORT}/api/instance`)).json();
    ck(!!ia.cacheDir && !!ib.cacheDir, '/api/instance 返回 cacheDir 字段');
    ck(path.resolve(ia.cacheDir) !== path.resolve(ib.cacheDir), '两个实例的 cacheDir 不同',
      `${ia.cacheDir} vs ${ib.cacheDir}`);
    ck(ia.dataDir === ib.dataDir, '两者的程序目录（dataDir）相同 —— 正因如此才必须按 cacheDir 判定');
  }

  // 2) 同 cacheDir + 同端口：应识别为「已在运行」并退出
  c = start(A_PORT, null);
  await new Promise((r) => setTimeout(r, 7000));
  ck(c.exitCode !== null, '同一 cacheDir 重复启动会被识别为「已在运行」并退出');
  ck(/已在运行/.test(c._out), '启动日志给出「已在运行」提示', c._out.split('\n').filter((l) => /已在运行/.test(l))[0] || '(无)');
} catch (e) {
  fail.push('异常: ' + e.message);
} finally {
  for (const p of [a, b, c]) { try { p && p.kill(); } catch {} }
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(DIR_B, { recursive: true, force: true });
}

console.log('\n===== 多实例并存验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
