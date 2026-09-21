/* 验证 exe 模式下登录态落到「exe 自己的 cache 目录」，且不再污染 C:\cache。
   用全新空目录模拟一个新用户（不含任何本机登录态）。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PORT = 17911;
const DIR = path.join(os.tmpdir(), 'reader-state-verify');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const exe = path.join(DIR, 'Reader.exe');
fs.copyFileSync(path.join('dist', 'Reader.exe'), exe);

const child = spawn(exe, [], {
  cwd: DIR,
  env: { ...process.env, PORT: String(PORT), READER_OPEN_BROWSER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const waitUp = async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const pass = [];
const fail = [];
const check = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

try {
  if (!(await waitUp())) throw new Error('exe 未在 40 秒内启动:\n' + out.slice(-2000));

  const inst = await (await fetch(`http://127.0.0.1:${PORT}/api/instance`)).json();
  check(inst.sea === true, 'exe 以 SEA 模式运行');
  check(path.resolve(inst.dataDir) === path.resolve(DIR), '数据目录 = exe 所在目录', inst.dataDir);

  // 触发一次发现页（会执行脚本、写书源变量）
  const src = encodeURIComponent('光遇聚合');
  const kinds = await (await fetch(`http://127.0.0.1:${PORT}/api/online/explore/kinds?source=${src}`)).json();
  check(Array.isArray(kinds.kinds), '发现页接口可用', '项数=' + (kinds.kinds || []).length);

  await new Promise((r) => setTimeout(r, 3000));

  const ownState = path.join(DIR, 'cache', 'login-state.json');
  const wrongState = 'C:\\cache\\login-state.json';
  check(fs.existsSync(ownState), '登录态写在 exe 自己的 cache/ 下', ownState);
  check(!fs.existsSync(wrongState), '没有写 C:\\cache', wrongState);

  if (fs.existsSync(ownState)) {
    const j = JSON.parse(fs.readFileSync(ownState, 'utf8'));
    const gy = (j.cookie || []).filter((r) => String(r[0]).includes('gyks'));
    check(gy.length === 0, '全新用户不含任何 gyks 凭证（未带开发者登录态）', 'gyks cookie=' + gy.length);
  }

  // 关键：全新用户未登录 → 只剩筛选控件，这是预期行为（需自行登录）
  check((kinds.kinds || []).length > 0, '未登录时仍有筛选控件', '项数=' + (kinds.kinds || []).length);
} catch (e) {
  fail.push('异常: ' + e.message);
} finally {
  try { child.kill(); } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 800));
}

console.log('\n===== exe 登录态路径验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
