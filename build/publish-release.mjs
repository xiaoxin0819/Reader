/* publish-release.mjs —— 把 dist/Reader.zip 发到 GitHub Release

   为什么不把 exe 直接提交进 git：
     · exe 94 MB，接近 GitHub 单文件 100 MB 硬上限；
     · 二进制进 git 后每次重新打包都会让仓库历史膨胀（Git 不做二进制增量），
       发几个版本仓库就几百 MB，clone 极慢。
   GitHub Release 的附件不占仓库体积，且有独立的下载统计，是分发二进制的标准做法。

   用法：
     set GITHUB_TOKEN=ghp_xxx        （需要 repo 权限）
     node build/publish-release.mjs v1.0.1

   可选环境变量：
     GITHUB_REPO   默认 xiaoxin0819/Reader
     RELEASE_NOTES 版本说明文件路径（默认自动生成一段）
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const TAG = process.argv[2];
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'xiaoxin0819/Reader';

function fail(msg) { console.error('\n[发布失败] ' + msg); process.exit(1); }
function step(msg) { console.log('• ' + msg); }

if (!TAG) fail('用法: node build/publish-release.mjs <tag>，例如 v1.0.1');
if (!/^v\d+\.\d+\.\d+$/.test(TAG)) fail(`tag 格式应为 vX.Y.Z，收到：${TAG}`);
if (!TOKEN) fail('缺少环境变量 GITHUB_TOKEN（需要 repo 权限）');

const zipPath = path.join(DIST, 'Reader.zip');
if (!fs.existsSync(zipPath)) fail(`找不到 ${zipPath}，请先运行 node build/build-exe.mjs`);

const zipSize = fs.statSync(zipPath).size;
step(`待发布：${path.basename(zipPath)} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
step(`目标仓库：${REPO}  标签：${TAG}`);

const api = `https://api.github.com/repos/${REPO}`;
const headers = {
  Authorization: `token ${TOKEN}`,
  'User-Agent': 'Reader-Publisher',
  Accept: 'application/vnd.github+json',
};

/** 统一的 JSON 请求（带错误详情） */
async function gh(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!r.ok) {
    const detail = json && (json.message || json.error) ? (json.message || json.error) : text.slice(0, 300);
    throw new Error(`${r.status} ${detail}`);
  }
  return json;
}

/* 1) 确认 tag 已存在于仓库（Release 指向已有 tag，避免打错） */
step('校验 tag 是否存在…');
try {
  await gh(`${api}/git/ref/tags/${TAG}`);
} catch (e) {
  fail(`仓库里没有 tag ${TAG}：${e.message}\n  请先：git tag ${TAG} && git push origin ${TAG}`);
}
step(`tag ${TAG} 已存在`);

/* 2) 若该 tag 已有 Release 则复用，否则新建 */
let release = null;
try {
  release = await gh(`${api}/releases/tags/${TAG}`);
  step(`Release 已存在（id ${release.id}），将追加 / 覆盖附件`);
} catch {
  step('创建 Release…');
  const notesPath = process.env.RELEASE_NOTES;
  const body = notesPath && fs.existsSync(notesPath)
    ? fs.readFileSync(notesPath, 'utf8')
    : [
      `## Reader ${TAG}`,
      '',
      '下载下面的 **Reader.zip**，解压后双击 `Reader.exe` 即可（无需安装 Node.js）。',
      '',
      '- 首次运行自动释放内置的 31 个书源',
      '- 浏览器自动打开 http://127.0.0.1:7788/',
      '- 数据全在 exe 同级目录，整个文件夹拷走即带走全部数据',
      '- 不要放在 `C:\\Program Files` 等需要管理员权限的目录',
      '',
      '详见 [README](https://github.com/' + REPO + '#readme)。',
    ].join('\n');
  release = await gh(`${api}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: `Reader ${TAG}`,
      body,
      draft: false,
      prerelease: false,
    }),
  });
  step(`Release 创建成功（id ${release.id}）`);
}

/* 3) 删掉同名旧附件（GitHub 不允许同名覆盖，必须删了再传） */
const assets = await gh(`${api}/releases/${release.id}/assets`);
for (const a of assets) {
  if (a.name === 'Reader.zip') {
    step(`删除旧附件 ${a.name}（id ${a.id}）`);
    await gh(`${api}/releases/assets/${a.id}`, { method: 'DELETE' });
  }
}

/* 4) 上传新附件 */
step('上传 Reader.zip…');
const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=Reader.zip`;
const buf = fs.readFileSync(zipPath);
const uploaded = await gh(uploadUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip' },
  body: buf,
});

step(`上传完成：${(uploaded.size / 1024 / 1024).toFixed(1)} MB`);
console.log('\n[发布完成]');
console.log('  页面: ' + release.html_url);
console.log('  直链: ' + uploaded.browser_download_url);
console.log('  最新: https://github.com/' + REPO + '/releases/latest/download/Reader.zip');
