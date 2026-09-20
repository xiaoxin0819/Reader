/* build-exe.mjs —— 把 Reader 打包成单文件 Windows exe

   原理：Node.js SEA（Single Executable Application）
     1) 用 esbuild 把 server.mjs 打成自包含 CJS（17 个 npm 依赖全部内联）
     2) 同样把两个 worker（book-worker / net-worker）打成自包含 CJS 字符串，
        运行时用 new Worker(code, { eval: true }) 启动 —— SEA 是单文件，
        磁盘上没有 .mjs，这是让 worker 在 exe 里工作的关键。
     3) 前端资源（html/css/js/ico）与内置规则 JSON 作为 SEA assets 嵌入
     4) node --experimental-sea-config 生成 blob，postject 注入 node.exe

   与「阅读器」打包脚本的差异：
     · 阅读器用手工字符串拼接内联，这里改用 esbuild（依赖多、手工拼不可靠）
     · Reader 有 worker 线程，必须走 eval 方案（见 src/exe-worker.mjs）

   用法：node build/build-exe.mjs [--skip-icon] [--no-dist]
*/

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { zipDirectory } from "./zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(__dirname, ".tmp");
const DIST = path.join(ROOT, "dist");
const APP_NAME = "Reader";
const VERSION = "1.0.0";

const SKIP_ICON = process.argv.includes("--skip-icon");

/* 打包所需外部工具（首次运行自动下载并缓存到 build/.tmp） */
const POSTJECT_URL = "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz";

function fail(msg) { console.error("\n[打包失败] " + msg); process.exit(1); }
function step(msg) { console.log("• " + msg); }

function findNode() {
  const list = [
    process.env.READER_NODE,
    path.join(process.env.USERPROFILE || "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"),
    "C:/Develop/nodejs/node.exe",
    process.execPath,
  ].filter(Boolean);
  for (const p of list) { if (p && fs.existsSync(p)) return p; }
  fail("找不到 node.exe，请设置环境变量 READER_NODE 指向 node.exe");
}

const NODE = findNode();
console.log("Node: " + NODE + " (" + spawnSync(NODE, ["--version"], { encoding: "utf8" }).stdout.trim() + ")");

/* ---------------- 0. 定位 esbuild ---------------- */

function findEsbuild() {
  const bin = path.join(ROOT, "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
  if (fs.existsSync(bin)) return bin;
  const alt = path.join(ROOT, "node_modules", ".bin", "esbuild.cmd");
  if (fs.existsSync(alt)) return alt;
  fail("找不到 esbuild，请先在 Reader 目录执行：npm install --no-save esbuild");
}
const ESBUILD = findEsbuild();
step("esbuild: " + ESBUILD);

/* ---------------- 1. esbuild 打包 ---------------- */

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

/* 清掉上一次运行留下的「exe 同级运行时数据」。
   这些是调试时 exe 自己生成的（reader.config.json / sources / cache / fonts），
   不是交付内容；留着会被误打包发给别人，泄露本机的书架与登录态。 */
for (const name of ["reader.config.json", "sources", "cache", "fonts", "server.out.log", "server.err.log"]) {
  const p = path.join(DIST, name);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    step("清理 dist/" + name);
  }
}

const bundlePath = path.join(TMP, "bundle.cjs");
const bookWorkerPath = path.join(TMP, "book-worker.cjs");
const netWorkerPath = path.join(TMP, "net-worker.cjs");

function runEsbuild(entry, outfile, label) {
  const args = [
    entry, "--bundle", "--platform=node", "--format=cjs", "--target=node22",
    "--outfile=" + outfile, "--external:node:*", "--log-level=error",
    // import.meta.url 在 CJS 里为空，会让 fileURLToPath 抛错。
    // 替换成占位路径时必须用 Windows 合法格式（file:///C:/...）：
    // 形如 file:///__reader__/... 会被 fileURLToPath 判定为非绝对路径而报
    // ERR_INVALID_FILE_URL_PATH。
    // 真正用到的目录（__dirname / 缓存 / 资源）在 SEA 下都走 process.execPath，
    // 见 server.mjs 的 __dirname 与 src/exe-env.mjs。
    "--define:import.meta.url=" + JSON.stringify("file:///C:/__reader__/bundle.cjs"),
  ];
  const r = spawnSync(ESBUILD, args, { encoding: "utf8", cwd: ROOT });
  if (r.status !== 0) fail(`esbuild 打包 ${label} 失败:\n${r.stderr || r.stdout}`);
  step(`打包 ${label} → ${(fs.statSync(outfile).size / 1024).toFixed(0)} KB`);
}

runEsbuild("server.mjs", bundlePath, "server.mjs");
runEsbuild("src/book-worker.mjs", bookWorkerPath, "book-worker.mjs");
runEsbuild("src/net-worker.mjs", netWorkerPath, "net-worker.mjs");

/* ---------------- 2. 生成 exe 入口（注入 worker 源码 + 资源读取）---------------- */

const bundleSrc = fs.readFileSync(bundlePath, "utf8");
const bookWorkerSrc = fs.readFileSync(bookWorkerPath, "utf8");
const netWorkerSrc = fs.readFileSync(netWorkerPath, "utf8");

// 前端资源与内置 JSON 作为 SEA assets 嵌入
const ASSETS = [
  ["index.html", "public/index.html"],
  ["style.css", "public/style.css"],
  ["online.css", "public/online.css"],
  ["app.js", "public/app.js"],
  ["online.js", "public/online.js"],
  ["reader.ico", "public/reader.ico"],
  ["builtin-replace-rules.json", "sources/builtin-replace-rules.json"],
  ["builtin-txt-toc-rules.json", "sources/builtin-txt-toc-rules.json"],
  ["cryptojs.min.js", "vendor/cryptojs.min.js"],
  // 内置书源：首次运行时释放到 exe 同级目录，用户随后可在「书源管理」里增删改。
  // 源文件是 sources/book-sources.json（31 个精选书源）；
  // 不用 sources/groups/group-1/ 那份 —— 那是运行时数据，不进仓库。
  ["book-sources.json", "sources/book-sources.json"],
];
for (const [, rel] of ASSETS) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail("缺少资源文件: " + rel);
}

const entry = [
  "/* Reader 单文件版 —— 由 build/build-exe.mjs 自动生成，请勿直接编辑 */",
  '"use strict";',
  'const sea = require("node:sea");',
  "",
  "/* ========== worker 源码（运行时用 eval 启动）========== */",
  "globalThis.__READER_WORKER_SRC__ = {",
  "  bookWorker: " + JSON.stringify(bookWorkerSrc) + ",",
  "  netWorker: " + JSON.stringify(netWorkerSrc) + ",",
  "};",
  "",
  "/* ========== SEA 资源名映射 ========== */",
  "globalThis.__READER_SEA_ASSETS__ = " + JSON.stringify(Object.fromEntries(ASSETS.map(([n]) => [n, n]))) + ";",
  "globalThis.__READER_IS_SEA__ = true;",
  "globalThis.__READER_SEA_GET__ = (name) => {",
  "  try { return Buffer.from(sea.getAsset(name)); } catch (e) { return null; }",
  "};",
  "",
  "/* ========== server.mjs（已由 esbuild 打成自包含 CJS）========== */",
  bundleSrc,
  "",
].join("\n");

const entryPath = path.join(TMP, "entry.cjs");
fs.writeFileSync(entryPath, entry, "utf8");
step("生成 entry.cjs (" + (Buffer.byteLength(entry) / 1024).toFixed(0) + " KB)");

const chk = spawnSync(NODE, ["--check", entryPath], { encoding: "utf8" });
if (chk.status !== 0) fail("entry 语法检查失败:\n" + chk.stderr);
step("entry 语法检查通过");

/* ---------------- 3. 生成 SEA blob ---------------- */

const seaCfgPath = path.join(TMP, "sea-config.json");
const seaBlobPath = path.join(TMP, "sea.blob");
fs.writeFileSync(seaCfgPath, JSON.stringify({
  main: entryPath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries(ASSETS.map(([n, rel]) => [n, path.join(ROOT, rel)])),
}, null, 2), "utf8");

const blob = spawnSync(NODE, ["--experimental-sea-config", seaCfgPath], { encoding: "utf8" });
if (blob.status !== 0) fail("生成 SEA blob 失败:\n" + (blob.stderr || blob.stdout));
step("生成 sea.blob (" + (fs.statSync(seaBlobPath).size / 1024).toFixed(0) + " KB)");

/* ---------------- 4. 复制 node.exe 并注入 ---------------- */

const exePath = path.join(DIST, APP_NAME + ".exe");
fs.copyFileSync(NODE, exePath);
step("复制 node.exe → " + path.basename(exePath));

/* 用 postject 的 API 而不是 CLI：
   CLI（dist/cli.js）依赖 commander，而 tgz 里不含 node_modules，
   直接跑会报 "Cannot find module 'commander'"。
   API（dist/api.js）只依赖 node 内置模块，可以独立使用。 */
const postjectDir = path.join(TMP, "postject");
const postjectApiPath = path.join(postjectDir, "package", "dist", "api.js");
if (!fs.existsSync(postjectApiPath)) {
  step("下载 postject…");
  fs.mkdirSync(postjectDir, { recursive: true });
  const tgz = path.join(TMP, "postject.tgz");
  const dl = spawnSync("curl.exe", ["-L", "--fail", "-o", tgz, POSTJECT_URL], { encoding: "utf8" });
  if (dl.status !== 0) fail("下载 postject 失败（需要网络）");
  let ex = spawnSync("tar", ["-xzf", tgz, "-C", postjectDir], { encoding: "utf8" });
  if (ex.status !== 0 || !fs.existsSync(postjectApiPath)) {
    ex = spawnSync("C:\\Windows\\System32\\tar.exe", ["-xzf", tgz, "-C", postjectDir], { encoding: "utf8" });
  }
  if (ex.status !== 0 || !fs.existsSync(postjectApiPath)) fail("解压 postject 失败");
}

step("注入 SEA blob…");
{
  const req = createRequire(path.join(TMP, "anchor.cjs"));
  const postject = req(postjectApiPath);
  const blobBuf = fs.readFileSync(seaBlobPath);
  try {
    await postject.inject(exePath, "NODE_SEA_BLOB", blobBuf, {
      sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      overwrite: true,
    });
  } catch (e) {
    fail("postject 注入失败: " + e.message);
  }
}
step("注入完成");

/* ---------------- 5. 图标与版本信息 ---------------- */

if (!SKIP_ICON) {
  const icon = path.join(ROOT, "public", "reader.ico");
  if (fs.existsSync(icon)) {
    /* 用自带的 build/set-icon.mjs（纯 JS 改 PE 资源），不用 rcedit：
       rcedit 在这种无交互会话里会挂住不退出，导致图标永远写不进去
       （打包日志里表现为「rcedit 执行失败或超时，跳过图标设置」，
       exe 一直带着 Node 默认的绿色方块图标）。 */
    const r = spawnSync(NODE, [path.join(__dirname, "set-icon.mjs"), exePath, icon], {
      encoding: "utf8", cwd: ROOT, timeout: 120000,
    });
    if (r.status === 0) {
      step("已设置图标");
      if (r.stdout) for (const line of r.stdout.trim().split("\n")) console.log("  " + line);
    } else {
      console.warn("  （设置图标失败，继续打包）");
      if (r.stderr) console.warn("  " + r.stderr.trim().split("\n").join("\n  "));
      if (r.error) console.warn("  " + r.error.message);
    }
  } else {
    console.warn("  （找不到 public/reader.ico，跳过图标设置）");
  }
}

/* ---------------- 6. 冒烟测试 ---------------- */

/* 冒烟测试在临时目录跑，不要在 dist/ 里跑：
   exe 首次运行会在「exe 同级目录」生成 reader.config.json / sources/ / cache/，
   如果直接在 dist/ 里启动，这些运行时会污染交付产物，
   打包发给别人时容易被误当成程序的一部分一起打包出去。 */
step("冒烟测试（启动 exe，检查是否监听端口）…");
const SMOKE_PORT = 17788;
const SMOKE_DIR = path.join(TMP, "smoke");
fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
fs.mkdirSync(SMOKE_DIR, { recursive: true });
const smokeExe = path.join(SMOKE_DIR, APP_NAME + ".exe");
fs.copyFileSync(exePath, smokeExe);

const smoke = spawn(smokeExe, [], {
  cwd: SMOKE_DIR,
  env: { ...process.env, PORT: String(SMOKE_PORT), READER_CACHE_DIR: path.join(SMOKE_DIR, "cache") },
  stdio: ["ignore", "pipe", "pipe"],
});

let smokeOut = "";
smoke.stdout.on("data", (d) => { smokeOut += d.toString(); });
smoke.stderr.on("data", (d) => { smokeOut += d.toString(); });

const ok = await new Promise((resolve) => {
  const deadline = Date.now() + 40000;
  const tick = async () => {
    if (Date.now() > deadline) return resolve(false);
    try {
      const r = await fetch(`http://127.0.0.1:${SMOKE_PORT}/api/state`);
      if (r.ok) return resolve(true);
    } catch { /* 还没起来 */ }
    setTimeout(tick, 500);
  };
  tick();
});

try { smoke.kill(); } catch { /* noop */ }

if (!ok) {
  console.error("\nexe 输出:\n" + smokeOut.slice(-3000));
  fail("冒烟测试失败：exe 没能在 40 秒内响应 /api/state");
}
step("冒烟测试通过（/api/state 返回 200）");

const size = fs.statSync(exePath).size;
console.log("\n[打包完成] " + exePath + "  (" + (size / 1024 / 1024).toFixed(1) + " MB)");

/* ---------------- 7. 便携包（可直接发给别人）----------------
   只放 exe + 说明：首次运行会自动在 exe 同级生成
   reader.config.json / sources/ / cache/ / fonts/，
   用户把这一个文件夹拷走就带走了全部数据。 */
const PORTABLE_DIR = path.join(DIST, "Reader");
fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
fs.mkdirSync(PORTABLE_DIR, { recursive: true });
fs.copyFileSync(exePath, path.join(PORTABLE_DIR, "Reader.exe"));

// 文件名用纯 ASCII：tar.exe 写的是 UTF-8 名，部分 Windows 解压工具按 GBK
// 解读会把中文名显示成乱码。说明内容本身仍是中文，打开无碍。
const README_NAME = "README.txt";
fs.writeFileSync(path.join(PORTABLE_DIR, README_NAME), [
  "Reader 在线阅读器 —— 便携版",
  "",
  "【怎么用】",
  "  1. 双击 Reader.exe",
  "  2. 会自动打开浏览器（地址 http://127.0.0.1:7788）",
  "  3. 关闭那个黑色命令行窗口即可退出程序",
  "",
  "【换个端口】",
  "  默认用 7788。想换端口有三种方式（任选其一）：",
  "    1) 在本文件夹新建 port.txt，里面写一个数字，例如：8080",
  "    2) 命令行运行：Reader.exe --port 8080",
  "    3) 设环境变量：set PORT=8080 然后运行 Reader.exe",
  "  端口被占用时会自动往后找一个空闲端口，启动日志里会打印实际地址。",
  "  想同时开多个 Reader（不同书库），把文件夹复制一份、各改各的 port.txt。",
  "",
  "【数据放在哪】",
  "  全部在这个文件夹里，和 Reader.exe 同级：",
  "    reader.config.json  配置（书架、阅读设置、书源开关）",
  "    sources/            书源（可在界面里导入 / 导出 / 增删）",
  "    cache/              正文 / 目录 / 登录态缓存（可在界面里清理）",
  "    fonts/              自定义字体",
  "  把这个文件夹整体拷走，数据就跟着走了。",
  "",
  "【注意】",
  "  · 不要放在 C:\\Program Files 等需要管理员权限的目录，否则无法写入数据。",
  "  · 建议放在桌面、D 盘自建文件夹，或 U 盘。",
  "  · 重复双击不会启动多个实例，会直接打开已运行的页面。",
  "",
  "【常见问题】",
  "  · 浏览器没自动打开：手动访问 http://127.0.0.1:7788",
  "  · 重复双击没反应：说明已有一个在运行，会自动打开它的页面（不会起第二个实例）",
  "  · 想换端口却提示被占用：会自动往后找一个空闲端口，看日志里的实际地址",
  "  · 页面打不开：确认那个黑色命令行窗口还开着（关掉窗口 = 退出程序）",
  "",
].join("\r\n"), "utf8");

const zipPath = path.join(DIST, APP_NAME + ".zip");
fs.rmSync(zipPath, { force: true });
/* 用自带的 build/zip.mjs 而不是 tar.exe / Compress-Archive：
   · tar.exe -a 生成的条目名带 "./" 前缀，部分解压工具会报「压缩包无效」；
   · Compress-Archive 经 spawnSync 传参时引号转义易出错（实测静默失败）；
   · 自写实现完全控制条目名与属性位，只用 node:zlib，无第三方依赖。 */
// 包一层 Reader/：用户解压到桌面时得到「Reader」文件夹，而不是散落的 exe
const zipCount = zipDirectory(PORTABLE_DIR, zipPath, APP_NAME);

console.log("\n[便携包] " + PORTABLE_DIR);
if (fs.existsSync(zipPath)) {
  console.log("[压缩包] " + zipPath + "  (" + (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1) + " MB)");
  console.log(`[压缩包] 含 ${zipCount} 个条目`);
} else {
  console.warn("[压缩包] 生成失败（便携目录已就绪，可手动压缩）");
}
