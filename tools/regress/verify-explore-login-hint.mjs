/* 验证「发现页需要先登录」提示：
     1) 未登录的光遇聚合 → 显示提示条 + 登录按钮
     2) 正常书源（内容入口 > 0）→ 不显示提示条（不误报）
   用全新空目录的 exe 模拟新用户，绝不使用开发者本机登录态。

   用法：node tools/regress/verify-explore-login-hint.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PORT = 17913;
const DIR = path.join(os.tmpdir(), 'reader-login-hint-verify');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join('dist', 'Reader.exe'), path.join(DIR, 'Reader.exe'));

const child = spawn(path.join(DIR, 'Reader.exe'), [], {
  cwd: DIR,
  env: { ...process.env, PORT: String(PORT), READER_OPEN_BROWSER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const waitUp = async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/* 与 public/online.js 的 exploreNeedsLogin 保持同一判据 */
function exploreNeedsLogin(kinds) {
  const list = kinds || [];
  if (!list.length) return false;
  let content = 0;
  let loginAction = 0;
  for (const k of list) {
    const u = String((k && k.url) || '');
    if (!u) continue;
    if (/java\.(startBrowser|startBrowserAwait|openUrl|showBrowser|reLoginView)/.test(u)) loginAction += 1;
    else content += 1;
  }
  return content === 0 && loginAction > 0;
}

const pass = [];
const fail = [];
const check = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

try {
  if (!(await waitUp())) throw new Error('exe 未启动:\n' + out.slice(-1500));

  const sources = await (await fetch(`http://127.0.0.1:${PORT}/api/sources`)).json();
  const exploreList = (sources.sources || []).filter((s) => s.enabled && s.hasExplore);
  check(exploreList.length > 0, '存在启用且支持发现的书源', '共 ' + exploreList.length + ' 个');

  let hinted = [];
  let clean = [];
  for (const s of exploreList) {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/online/explore/kinds?source=${encodeURIComponent(s.url)}`)).json();
    const needs = exploreNeedsLogin(j.kinds);
    if (needs) hinted.push(s.name); else clean.push(s.name);
  }

  // 未登录的光遇聚合应当被判定为「需要登录」
  const gy = exploreList.find((s) => String(s.name).includes('光遇'));
  check(!!gy, '书源列表里能找到光遇聚合');
  if (gy) {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/online/explore/kinds?source=${encodeURIComponent(gy.url)}`)).json();
    check(exploreNeedsLogin(j.kinds) === true, '未登录光遇聚合 → 判定为需要登录', '项数=' + (j.kinds || []).length);
    const loginBtn = (j.kinds || []).filter((k) => /java\.startBrowser/.test(String((k && k.url) || ''))).length;
    check(loginBtn > 0, '残缺分类里确实带登录按钮', '登录动作=' + loginBtn);
  }

  // 不能误伤：绝大多数正常书源不应被判定为需要登录
  check(clean.length >= exploreList.length - 3, '多数书源未被误判为需要登录',
    '被判定需要登录的: ' + JSON.stringify(hinted));

  // 前端资源确实包含提示逻辑与样式
  const js = await (await fetch(`http://127.0.0.1:${PORT}/online.js`)).text();
  check(js.includes('exploreNeedsLogin'), 'online.js 已包含判定函数');
  check(js.includes('showExploreLoginHint'), 'online.js 已包含提示渲染');
  const css = await (await fetch(`http://127.0.0.1:${PORT}/online.css`)).text();
  check(css.includes('.ek-need-login'), 'online.css 已包含提示样式');
} catch (e) {
  fail.push('异常: ' + e.message);
} finally {
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 600));
}

console.log('\n===== 发现页登录提示验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
