/* 验证 deviceId 修复（真实 exe）：
     1) 首次运行会生成 <exe目录>/cache/device-id
     2) 值是 16 位十六进制，且不是旧的固定常量 localreader00000
     3) 重启后保持不变（持久）
     4) 另一个目录的 exe 得到不同的值（每台机器唯一）
   用法：node tools/regress/verify-device-id.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const OLD = 'localreader00000';
const pass = [];
const fail = [];
const ck = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

async function runOnce(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'Reader.exe');
  if (!fs.existsSync(exe)) fs.copyFileSync(path.join('dist', 'Reader.exe'), exe);

  const child = spawn(exe, [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), READER_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const up = async () => {
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) return true; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };

  try {
    if (!(await up())) throw new Error('exe 未启动:\n' + out.slice(-1000));
    // 触发一次会用到 java.androidId() 的路径：光遇发现页
    await fetch(`http://127.0.0.1:${port}/api/online/explore/kinds?source=${encodeURIComponent('光遇聚合')}`).catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  const f = path.join(dir, 'cache', 'device-id');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}

const base = path.join(os.tmpdir(), 'reader-deviceid-verify');
const dirA = path.join(base, 'A');
const dirB = path.join(base, 'B');
fs.rmSync(base, { recursive: true, force: true });

try {
  const a1 = await runOnce(dirA, 17940);
  ck(!!a1, '首次运行生成了 device-id 文件', String(a1));
  ck(/^[0-9a-f]{16}$/.test(a1 || ''), '是 16 位十六进制', String(a1));
  ck(a1 !== OLD, '不是旧的固定常量', String(a1));

  // 重启同目录：应保持
  const a2 = await runOnce(dirA, 17941);
  ck(a2 === a1, '重启后保持不变（持久）', `${a1} → ${a2}`);

  // 另一台「机器」
  const b1 = await runOnce(dirB, 17942);
  ck(/^[0-9a-f]{16}$/.test(b1 || ''), '另一份安装也生成有效值', String(b1));
  ck(b1 !== a1, '两份安装的 deviceId 不同（唯一）', `${a1} vs ${b1}`);
} catch (e) {
  fail.push('异常: ' + e.message);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('\n===== deviceId 端到端验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
