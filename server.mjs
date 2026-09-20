// server.mjs —— Reader 在线阅读器服务端
//
// 两条阅读路径：
//   本地：复用「阅读器」的 txt 解析（parse-core.mjs），路由契约完全一致
//   在线：书源（legado 格式）→ worker 池抓取 → 与本地共用章节/正文接口形状
//
// 为什么在线抓取必须走 worker：src/sync-net.mjs 与 rate-limiter 用 Atomics.wait 同步阻塞
// 线程来复刻 legado/Rhino 的同步语义，放主线程会把整个 HTTP 服务冻住。
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { IS_SEA, readAsset } from "./src/exe-env.mjs";

/* exe（SEA）模式：内置规则 JSON 打包进 exe，磁盘上没有 sources/*.json。
   这里包一层 fs.readFileSync：找不到文件时回退到 SEA assets。
   只拦「我们明确嵌进去的那几个文件」，其它路径行为不变（用户书源组、
   reader.config.json、cache 等都仍在磁盘上，可正常读写）。 */
const SEA_BUILTIN_FILES = new Set([
  "builtin-replace-rules.json",
  "builtin-txt-toc-rules.json",
]);
if (IS_SEA) {
  const origReadFileSync = fs.readFileSync.bind(fs);
  fs.readFileSync = function (p, ...rest) {
    try {
      return origReadFileSync(p, ...rest);
    } catch (e) {
      const base = path.basename(String(p || ""));
      if (e && e.code === "ENOENT" && SEA_BUILTIN_FILES.has(base)) {
        const buf = readAsset(base);
        if (buf) {
          const enc = rest[0];
          return (typeof enc === "string" && enc !== "buffer") ? buf.toString(enc) : buf;
        }
      }
      throw e;
    }
  };
}
import { decodeBuffer, analyzeText } from "./parse-core.mjs";
import { BookPool } from "./src/book-pool.mjs";
import {
  parseSourceImport, normalizeSource, sourceSummary, exportSources,
  getKey as sourceKey, mergeSources,
} from "./src/book-source-model.mjs";
import { createLegadoApi } from "./src/legado-api.mjs";
// 登录 / 验证类书源需要真实浏览器内核（legado 的 WebViewActivity 等价物）：
// 起一个 headless Edge，CDP 投帧到前端弹窗、回灌输入、把 cookie 写回 CookieStore。
import { BrowserHost, findChromium, subDomainOf } from "./src/browser-host.mjs";
// legado 换源时的阅读进度映射（BookHelp.getDurChapter / StringUtils），逐行移植见 src/legado-text.mjs
import { getDurChapter } from "./src/legado-text.mjs";
import { javaRegex, tryJavaRegex } from "./src/java-regex.mjs";
// 替换净化引擎：严格对齐 legado RegexExtensions.kt / ContentProcessor.kt
// （Matcher.appendReplacement 语义 + @js: 绑定 + 超时保护），见 src/replace-engine.mjs
import { replaceWithRule, replaceManyWithRule, RegexTimeoutError } from "./src/replace-engine.mjs";
// TXT 目录规则引擎：直接照搬 legado TextFile.kt 的 getTocRule()/analyze(rr)/replacement()，
// 本地 txt 的章节标题与右侧目录栏因此和 legado 用同一套规则，见 src/txt-toc-rules.mjs
import { pickTocRule, analyzeByTocRule, makeLineIndexer, tocRuleFingerprint, getTocRules as getEnabledTocRules } from "./src/txt-toc-rules.mjs";

/**
 * 应用根目录。
 *
 * 开发模式 = server.mjs 所在目录（Reader/）。
 * exe（SEA）模式 = exe 文件所在目录 —— SEA 里 import.meta.url 无意义，
 * 打包时被替换成占位路径，因此改用 process.execPath 反推。
 * 这样 exe 旁边的 reader.config.json / cache / sources 仍能被正常读写，
 * 用户把 exe 放到哪，数据就在哪，不会污染系统盘其它位置。
 */
const __dirname = IS_SEA
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "reader.config.json");
const SOURCE_DIR = path.join(__dirname, "sources");
const SOURCE_PATH = path.join(SOURCE_DIR, "book-sources.json");
const SOURCE_DEFAULT = path.join(SOURCE_DIR, "shuyuan-default.json");
const BUILTIN_REPLACE_PATH = path.join(SOURCE_DIR, "builtin-replace-rules.json");
// 默认 TXT 目录规则：与 legado app/src/main/assets/defaultData/txtTocRule.json 同一份
const BUILTIN_TXT_TOC_PATH = path.join(SOURCE_DIR, "builtin-txt-toc-rules.json");
const SOURCE_GROUPS_DIR = path.join(SOURCE_DIR, "groups");
const SOURCE_GROUPS_INDEX = path.join(SOURCE_GROUPS_DIR, "index.json");
const SOURCE_GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/**
 * 端口解析。优先级（从高到低）：
 *   1. 命令行参数  --port 8080 / -p 8080
 *   2. 环境变量    PORT=8080
 *   3. 配置文件    exe 同级的 port.txt（内容就是一个数字）
 *   4. 默认        7788
 *
 * 为什么需要配置文件：exe 是双击运行的，用户没法方便地设环境变量；
 * 放一个 port.txt 是最直观的做法（记事本改个数字就行）。
 *
 * 支持 0：表示「让系统自动分配空闲端口」，启动日志会打印实际端口。
 */
function resolvePort() {
  const fromArgs = (() => {
    const argv = process.argv.slice(1);
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i]);
      const m = /^--?port[=:]?(\d+)$/i.exec(a) || /^-p(\d+)$/i.exec(a);
      if (m) return m[1];
      if (/^--?port$/i.test(a) || /^-p$/i.test(a)) return argv[i + 1];
    }
    return null;
  })();

  const fromFile = (() => {
    try {
      const p = path.join(__dirname, "port.txt");
      if (!fs.existsSync(p)) return null;
      const txt = fs.readFileSync(p, "utf8").trim();
      const m = /^(\d{1,5})/.exec(txt);
      return m ? m[1] : null;
    } catch { return null; }
  })();

  const raw = fromArgs || process.env.PORT || fromFile || "7788";
  const n = Number(raw);
  // 0 合法（系统分配）；1~65535 合法；其余回退默认值
  if (!Number.isInteger(n) || n < 0 || n > 65535) return 7788;
  return n;
}
const PORT = resolvePort();
// 记录用户是否显式指定过端口 —— 决定「端口被占用」时是报错还是自动换一个
const PORT_EXPLICIT = !!(process.argv.slice(1).some((a) => /^--?port|^-p/i.test(String(a)))
  || process.env.PORT
  || (() => { try { return fs.existsSync(path.join(__dirname, "port.txt")); } catch { return false; } })());
// 实际监听端口。PORT 为 0 时由系统分配，listen 回调里回填真实值。
let activePort = PORT;
// legado BookType.localTag：本地书的 origin，用于替换净化的 scope / excludeScope 匹配
const LOCAL_ORIGIN = "loc_book";

/**
 * 统一数据/缓存根目录。
 *
 * legado AppConfig.cacheDirPath 的桌面端等价物：默认必须落在 Reader 文件夹内，
 * 这样用户删除 Reader 时不会在 %TEMP% 或浏览器默认 profile 留下正文、目录、
 * 发现分类和登录 WebView 数据。需要把缓存放到别的盘时，显式设置
 * READER_CACHE_DIR；不设置时永远是 <Reader>/cache。
 */
const CACHE_DIR_FROM_ENV = !!process.env.READER_CACHE_DIR;
function bootstrapCacheDir() {
  if (CACHE_DIR_FROM_ENV) return path.resolve(process.env.READER_CACHE_DIR);
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const d = c && c.online && c.online.cacheDir;
    if (typeof d === "string" && d.trim() && path.isAbsolute(d.trim())) return path.resolve(d.trim());
  } catch {}
  return path.join(__dirname, "cache");
}
const DEFAULT_CACHE_DIR = path.join(__dirname, "cache");
const CACHE_DIR = bootstrapCacheDir();
// Worker / BrowserHost 都直接读取 READER_CACHE_DIR；这里统一回写，保证用户从界面
// 设置过的缓存目录在 worker 和 WebView profile 两边都生效。
process.env.READER_CACHE_DIR = CACHE_DIR;
const WEBVIEW_DIR = path.join(CACHE_DIR, "webview");
const TOC_DIR = path.join(CACHE_DIR, "toc");
const CONTENT_DIR = path.join(CACHE_DIR, "content");
const EXPLORE_DIR = path.join(CACHE_DIR, "explore");
const LOGIN_STATE_PATH = path.join(CACHE_DIR, "login-state.json");
for (const d of [CACHE_DIR, WEBVIEW_DIR, TOC_DIR, CONTENT_DIR, EXPLORE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

/**
 * legado WebViewActivity / BottomWebViewDialog 的桌面端替身。
 * 懒启动：只有真的点了「登录」或书源要求开浏览器时才拉起 Edge。
 * user-data-dir 放 cache/webview，保持登录态跨重启。
 */
const browserHost = new BrowserHost({
  bin: process.env.READER_BROWSER || findChromium(),
  dataDir: WEBVIEW_DIR,
});

/**
 * CookieManager.getCookie(url) → CookieStore.setCookie(source.getKey(), cookie)
 * 对应 WebViewLoginFragment 的 onPageStarted / onPageFinished。
 * 不写回这里，用户「登录成功」的 cookie 就到不了书源请求上，等于没登录。
 */
browserHost.on("cookie", (ev) => {
  const sourceUrl = String((ev && ev.sourceUrl) || "");
  const tabId = String((ev && ev.tabId) || "");
  const p = ev && ev.cookie ? getPool().runAndSync("loginCookie", {
    sourceUrl,
    domain: ev.domain || subDomainOf(sourceUrl),
    cookie: ev.cookie,
  }, { timeout: 30000 }).then((r) => {
    webviewLogin[tabId] = Object.assign({}, webviewLogin[tabId] || {}, {
      loginInfo: (r && r.result && r.result.loginInfo) || null,
      hasLoginHeader: !!(r && r.result && r.result.hasLoginHeader),
      cookieAt: Date.now(),
    });
  }) : Promise.resolve();
  p.catch(() => { /* 书源可能已被删/停用，忽略 */ });
});

/** tabId -> 该标签页最近一次 cookie 回写结果（前端关闭窗口时展示「已保存登录信息」） */
const webviewLogin = Object.create(null);

/* ============================ 自定义字体 ============================ */

const FONT_DIR = path.join(__dirname, "fonts");
try { fs.mkdirSync(FONT_DIR, { recursive: true }); } catch {}
const FONT_EXT = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc"]);
const FONT_MIME = {
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttc": "font/collection"
};

/* ============================ 配置 ============================ */

const defaultConfig = {
  shelves: [],
  progress: {},          // rel -> { chapter, scroll }
  fonts: [],
  settings: {
    theme: "light", fontSize: 19, lineHeight: 1.9, indent: 2,
    fontFamily: "serif", maxWidth: 820, letterSpacing: 0,
    // 书源抓取并发数（worker 数量）。0 / 缺省 = 用环境变量或默认值 4。
    // 调大 = 多书源搜索 / 发现更快，但同一书源的 TLS 连接会被分散到更多 worker；
    // 调小 = 连接复用更充分、单本正文更稳，但多源并发变低。
    sourcePoolSize: 0,
  },
  online: {
    books: [],           // 在线书架
    progress: {},        // key -> { chapter, scroll }
    replaceRules: [],    // 替换规则（legado ReplaceRule）
    builtinReplaceInitialized: false,
    // 一次性迁移标记：内置净化规则（sources/builtin-replace-rules.json，20 条）全部内置供用户勾选。
    // 默认只开启 #01、#13~#17（数字标题/净化网址/标点/词语/段落/杂项），其余默认关闭，用户可自行勾选。
    builtinReplaceDefaultsMigrated: false,
    // 一次性迁移标记：把源文件里更新过的内置规则体同步进已有 config（保留用户开关/排序）。
    builtinReplaceContentMigrated: false,
    txtTocRules: [],     // TXT 目录规则（legado TxtTocRule），本地 txt 分章用
    builtinTxtTocRulesInitialized: false,
    bookGroups: [],
    searchConcurrency: 0, // 0 = 用池大小
    searchTimeout: 45000
  }
};

function dedupeShelves(list) {
  const seen = new Map();
  const out = [];
  for (const s of list) {
    if (!s || !s.path) continue;
    const key = path.resolve(s.path).toLowerCase();
    const hit = seen.get(key);
    if (hit) { hit.count = Math.max(hit.count || 0, s.count || 0); continue; }
    const item = { ...s };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...defaultConfig, ...c,
      settings: { ...defaultConfig.settings, ...(c.settings || {}) },
      progress: c.progress || {},
      fonts: Array.isArray(c.fonts) ? c.fonts : [],
      shelves: dedupeShelves(Array.isArray(c.shelves) ? c.shelves : []),
      online: {
        ...defaultConfig.online, ...(c.online || {}),
        books: Array.isArray(c.online?.books) ? c.online.books : [],
        progress: c.online?.progress || {},
        replaceRules: Array.isArray(c.online?.replaceRules) ? c.online.replaceRules : [],
        txtTocRules: Array.isArray(c.online?.txtTocRules) ? c.online.txtTocRules : [],
        bookGroups: Array.isArray(c.online?.bookGroups) ? c.online.bookGroups : []
      }
    };
  } catch {
    return structuredClone(defaultConfig);
  }
}

let config = loadConfig();

function loadBuiltinReplaceRules() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_REPLACE_PATH, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && r.pattern).map((r, i) => ({
      ...r,
      id: "builtin-netclean-" + String(r.id == null ? i + 1 : r.id),
      builtin: true,
      builtinSource: "净化合集20条_23.05.05",
    }));
  } catch (e) {
    console.error("读取内置净化规则失败:", e.message);
    return [];
  }
}

const builtinReplaceRules = loadBuiltinReplaceRules();

// 内置净化规则文件的内容签名：文件一改（新增/改写内置规则）就触发一次同步
const BUILTIN_REPLACE_SIGNATURE = crypto
  .createHash("sha1")
  .update(fs.readFileSync(BUILTIN_REPLACE_PATH))
  .digest("hex");

function ensureBuiltinReplaceRules() {
  if (config.online.builtinReplaceInitialized) return false;
  const list = config.online.replaceRules || (config.online.replaceRules = []);
  let maxOrder = list.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
  for (const raw of builtinReplaceRules) {
    if (list.some((r) => String(r.id) === String(raw.id))) continue;
    list.push({ ...raw, order: ++maxOrder });
  }
  config.online.builtinReplaceInitialized = true;
  saveConfig();
  return true;
}
let saveTimer = null;
function saveConfig() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      config.shelves = dedupeShelves(config.shelves);
      await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    } catch (e) { console.error("保存配置失败:", e.message); }
  }, 200);
}

/** 退出前同步刷盘：saveConfig 有 200ms 防抖，Ctrl+C 会把还没落盘的改动带走 */
function flushConfigNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    config.shelves = dedupeShelves(config.shelves);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (e) { console.error("退出保存配置失败:", e.message); }
}

/**
 * 内置净化规则的一次性默认值迁移。
 * 用户确认：源文件 20 条里默认只开启 #01、#13~#17（数字标题 + 净化网址/标点/词语/段落/杂项）。
 * 其余内置规则只作为候选出现，默认关闭；用户自建规则完全不动。
 */
const BUILTIN_REPLACE_ENABLED_IDS = new Set([1, 13, 14, 15, 16, 17]);

function builtinReplaceRuleOrdinal(rule) {
  const m = /^builtin-netclean-(\d+)$/.exec(String((rule && rule.id) || ''));
  return m ? Number(m[1]) : null;
}

function migrateBuiltinReplaceRules() {
  if (config.online.builtinReplaceDefaultsMigrated) return false;
  let changed = false;
  for (const r of config.online.replaceRules || []) {
    const isBuiltin = r && (r.builtin || String(r.id || '').startsWith('builtin-netclean-'));
    if (!isBuiltin) continue;
    const ordinal = builtinReplaceRuleOrdinal(r);
    const want = ordinal != null && BUILTIN_REPLACE_ENABLED_IDS.has(ordinal);
    if (!!r.isEnabled !== want) { r.isEnabled = want; changed = true; }
  }
  config.online.builtinReplaceDefaultsMigrated = true;
  saveConfig();
  if (changed) console.log('内置净化规则默认值已对齐：#01、#13~#17 启用，其余关闭（用户自建规则未改动）');
  return changed;
}

migrateBuiltinReplaceRules();

/* ---- 数字标题规则二选一（内置 #00 / #01 互斥） ----
 * 用户要求：sjshb57 新版数字标题规则与原数字标题规则都保留，
 * 但两条互斥，用户自行选择开启哪一条。
 */
const NUMERIC_TITLE_RULE_IDS = ["builtin-netclean-0", "builtin-netclean-1"];

/** 返回被自动关闭的规则；justEnabledId 为刚刚被用户开启的那条 */
function numericTitleRuleMutex(justEnabledId) {
  const list = config.online.replaceRules || [];
  const pair = NUMERIC_TITLE_RULE_IDS
    .map((id) => list.find((r) => String(r.id) === id))
    .filter(Boolean);
  if (pair.length < 2) return [];
  const enabled = pair.filter((r) => r.isEnabled !== false);
  if (!enabled.length) return [];
  let keep = justEnabledId ? enabled.find((r) => String(r.id) === String(justEnabledId)) : null;
  if (!keep) keep = enabled.slice().sort((a, b) => ruleOrder(a) - ruleOrder(b))[0];
  const turnedOff = [];
  for (const r of enabled) {
    if (r === keep) continue;
    r.isEnabled = false;
    turnedOff.push({ id: r.id, name: r.name });
  }
  return turnedOff;
}

/**
 * 内置净化规则内容同步（签名守卫）。
 * sources/builtin-replace-rules.json 的内容一变，就按 id：
 *   1) 补上 config 里缺失的内置规则（默认开关见 BUILTIN_REPLACE_ENABLED_IDS）
 *   2) 用源文件覆盖内置规则的规则体（原样导入，不做任何改写）
 * 只动内置项：保留用户自己的 isEnabled 开关与 order 排序，用户自建规则完全不动。
 * 同步后强制数字标题两条互斥（见 numericTitleRuleMutex）。
 */
function syncBuiltinReplaceRulesBySignature() {
  if (config.online.builtinReplaceContentSignature === BUILTIN_REPLACE_SIGNATURE) return false;
  ensureBuiltinReplaceRules();
  const list = config.online.replaceRules || (config.online.replaceRules = []);
  const fields = ["group", "name", "pattern", "replacement", "isRegex", "scopeContent", "scopeTitle", "timeoutMillisecond"];
  let added = 0, updated = 0;
  for (const raw of builtinReplaceRules) {
    const id = String(raw.id);
    const cur = list.find((r) => String(r.id) === id);
    if (!cur) {
      // 新内置规则：按序号插队（#00 排在 #01 前面），默认开关沿用内置默认值
      const minOrder = list.length
        ? list.reduce((mn, r) => Math.min(mn, ruleOrder(r)), Infinity)
        : Number(raw.order);
      const wantOrder = Number.isFinite(Number(raw.order)) && Number(raw.order) < minOrder
        ? Number(raw.order)
        : minOrder - 1;
      list.push({
        ...raw,
        isEnabled: BUILTIN_REPLACE_ENABLED_IDS.has(Number(raw.id)),
        order: wantOrder,
      });
      added += 1;
      continue;
    }
    if (!(cur.builtin || id.startsWith("builtin-netclean-"))) continue;
    let diff = false;
    for (const f of fields) {
      if (raw[f] === undefined) continue;
      if (JSON.stringify(cur[f]) !== JSON.stringify(raw[f])) { cur[f] = raw[f]; diff = true; }
    }
    if (diff) updated += 1;
  }
  const turnedOff = numericTitleRuleMutex();
  config.online.builtinReplaceContentSignature = BUILTIN_REPLACE_SIGNATURE;
  saveConfig();
  if (added || updated) {
    console.log(`内置净化规则已同步：新增 ${added} 条 / 更新 ${updated} 条（保留用户开关与排序）`);
  }
  return added + updated > 0 || turnedOff.length > 0;
}

syncBuiltinReplaceRulesBySignature();

/* ---- TXT 目录规则（legado TxtTocRule） ----
 * 字段清单照 data/entities/TxtTocRule.kt：
 *   id / name / rule / replacement / example / serialNumber / enable（+ order 用于排序）
 * 默认 12 条启用、14 条关闭，直接取 legado defaultData/txtTocRule.json，
 * 用户可在「替换净化 → TXT 目录规则」里自行勾选开关。
 */

function loadBuiltinTxtTocRules() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_TXT_TOC_PATH, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && typeof r.rule === "string").map((r, i) => {
      const sn = Number.isFinite(Number(r.serialNumber)) ? Number(r.serialNumber) : i;
      return {
        id: "builtin-toc-" + String(r.id == null ? i + 1 : r.id),
        name: String(r.name || ""),
        rule: String(r.rule || ""),
        replacement: String(r.replacement == null ? "" : r.replacement),
        example: r.example == null ? "" : String(r.example),
        serialNumber: sn,
        enable: r.enable === true,
        order: sn,
        builtin: true,
        builtinSource: "legado 默认 TXT 目录规则",
      };
    });
  } catch (e) {
    console.error("读取内置 TXT 目录规则失败:", e.message);
    return [];
  }
}

const builtinTxtTocRules = loadBuiltinTxtTocRules();

function ensureBuiltinTxtTocRules() {
  if (config.online.builtinTxtTocRulesInitialized) return false;
  const list = config.online.txtTocRules || (config.online.txtTocRules = []);
  for (const raw of builtinTxtTocRules) {
    if (list.some((r) => String(r.id) === String(raw.id))) continue;
    list.push({ ...raw });
  }
  config.online.builtinTxtTocRulesInitialized = true;
  saveConfig();
  return true;
}

/** legado TxtTocRuleDao.enabled：只取 enable == true，按 order 升序 */
function activeTxtTocRules() {
  ensureBuiltinTxtTocRules();
  return getEnabledTocRules(config.online.txtTocRules || []);
}

migrateTxtTocRules();

function migrateTxtTocRules() {
  if (ensureBuiltinTxtTocRules()) {
    console.log("已内置 TXT 目录规则 " + builtinTxtTocRules.length + " 条（默认启用 " +
      builtinTxtTocRules.filter((r) => r.enable).length + " 条，与 legado 一致）");
  }
}

/* ============================ 本地书籍解析 ============================ */

const fileCache = new Map();
/** 本地书目录标题缓存：原始标题仍存在 parsed book 中，这里只缓存规则处理后的展示结果。 */
const localTitleCache = new Map();

/** TXT 目录规则变了 → 本地解析缓存必须整体作废，否则右侧目录栏还是旧分章 */
function invalidateFileCache() {
  fileCache.clear();
}

/**
 * 用 legado TXT 目录规则切章（TextFile.analyze(rr)）。
 * 命中规则时按规则切，返回的 start/end 换算成行号；没命中返回 null 走原有兜底。
 */
function analyzeTextWithTocRules(text, fallbackTitle, rules) {
  const rule = pickTocRule(text, rules);
  if (!rule) return null;
  const base = analyzeText(text, fallbackTitle);
  const chips = text.length > 512000 ? text.slice(0, 512000) : text;
  void chips;
  let out;
  try {
    out = analyzeByTocRule(text, rule, { name: base.title, author: base.author });
  } catch (e) {
    console.error("TXT 目录规则切章失败:", e && e.message);
    return null;
  }
  if (!out || !out.chapters.length) return null;
  const lineOf = makeLineIndexer(text);
  const lines = base.lines;
  const chapters = out.chapters.map((c) => {
    const start = Math.max(0, Math.min(lines.length - 1, lineOf(c.start)));
    const end = Math.max(start, Math.min(lines.length, lineOf(c.end)));
    const label = String(c.title == null ? "" : c.title);
    return {
      title: label, label, name: label, num: null,
      start, end, isVolume: !!c.isVolume, noHead: false,
    };
  });
  chapters[chapters.length - 1].end = lines.length;
  let pre = null;
  if (out.intro && out.intro.title) {
    const pe = Math.min(lines.length, lineOf(out.intro.end));
    if (pe > 0) pre = { title: out.intro.title, start: 0, end: pe };
  }
  return {
    lines, chapters, pre, title: base.title, author: base.author,
    fellBack: false, ruleName: rule.name,
  };
}

function parseBook(absPath) {
  const st = fs.statSync(absPath);
  const rules = activeTxtTocRules();
  const fp = tocRuleFingerprint(rules);
  const key = st.mtimeMs + ":" + st.size + ":" + fp;
  const cached = fileCache.get(absPath);
  if (cached && cached.key === key) {
    // 命中时刷新 LRU 顺序，避免切换几十本后再回来重复解析。
    fileCache.delete(absPath);
    fileCache.set(absPath, cached);
    return cached;
  }
  const buf = fs.readFileSync(absPath);
  const { text, encoding } = decodeBuffer(buf);
  const fallbackTitle = path.basename(absPath, path.extname(absPath));
  const a = analyzeTextWithTocRules(text, fallbackTitle, rules) || analyzeText(text, fallbackTitle);
  const result = {
    key, lines: a.lines, chapters: a.chapters, pre: a.pre, fellBack: a.fellBack,
    encoding, title: a.title, author: a.author, size: st.size, tocRule: a.ruleName || ""
  };
  fileCache.delete(absPath);
  fileCache.set(absPath, result);
  while (fileCache.size > 40) fileCache.delete(fileCache.keys().next().value);
  return result;
}

const TEXT_EXT = new Set([".txt", ".md"]);

function shelfRoot(index) {
  const s = config.shelves[index];
  if (!s) throw new Error("书架不存在");
  return path.resolve(s.path);
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const r = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(r)) throw new Error("路径越界");
  return abs;
}

const BOOK_SCAN_CONCURRENCY = 64;

/* ---------------- 书架快照（stale-while-revalidate） ----------------
 * 书架常放在 USB 移动硬盘上，Windows 空闲一段时间（默认 20 分钟）就让盘休眠。
 * 服务重启后内存里没有列表，第一次列书架要等磁盘唤醒 + 全目录 stat，
 * 用户看到的就是「每次打开阅读器都要等书架转出来」。
 * 这里把上次成功的列表落盘到缓存目录（默认在 C:）：进程刚起来先秒回快照，
 * 后台再重扫校正。磁盘慢慢转，界面不用等。
 */
const BOOKLIST_SNAPSHOT_DIR = path.join(CACHE_DIR, "booklist");
const BOOKLIST_SNAPSHOT_MAX_AGE = 7 * 24 * 3600 * 1000;
const BOOKLIST_TTL = 1500;
const bookListCache = new Map();
try { fs.mkdirSync(BOOKLIST_SNAPSHOT_DIR, { recursive: true }); } catch {}

function snapshotFileOf(root) {
  const h = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(BOOKLIST_SNAPSHOT_DIR, h + ".json");
}

function readBookSnapshot(root) {
  try {
    const j = JSON.parse(fs.readFileSync(snapshotFileOf(root), "utf8"));
    if (!j || !Array.isArray(j.books) || !j.books.length) return null;
    if (Date.now() - Number(j.at || 0) > BOOKLIST_SNAPSHOT_MAX_AGE) return null;
    if (path.resolve(String(j.root || "")) !== path.resolve(root)) return null;
    return j;
  } catch { return null; }
}

const pendingSnapshots = new Map();
let snapshotTimer = null;
function saveBookSnapshotSoon(root, books) {
  const abs = path.resolve(root);
  pendingSnapshots.set(abs, { root: abs, books });
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    const items = [...pendingSnapshots.values()];
    pendingSnapshots.clear();
    for (const it of items) {
      try {
        await fsp.writeFile(snapshotFileOf(it.root), JSON.stringify({ at: Date.now(), root: it.root, books: it.books }), "utf8");
      } catch (e) { console.error("保存书架快照失败:", e.message); }
    }
  }, 400);
}

function dropBookSnapshot(root) {
  try { fs.unlinkSync(snapshotFileOf(root)); } catch {}
}

/** 后台重扫：磁盘慢慢转，先让用户看到上次的结果 */
function revalidateBookList(root, ck) {
  const cur = bookListCache.get(ck);
  if (cur && cur.revalidating) return;
  bookListCache.set(ck, { ...(cur || { at: 0, books: [] }), revalidating: true });
  listBooksUncached(root).then((books) => {
    bookListCache.set(ck, { at: Date.now(), books });
    if (bookListCache.size > 32) bookListCache.delete(bookListCache.keys().next().value);
    saveBookSnapshotSoon(root, books);
  }).catch((e) => {
    const s = bookListCache.get(ck);
    if (s) s.revalidating = false;
    console.error("重扫书架失败:", e && e.message);
  });
}

/** 返回 { books, stale }：stale=true 表示这是上次的结果，后台正在校正 */
async function listBooksWithMeta(root, opts = {}) {
  const ck = path.resolve(root).toLowerCase();
  const hit = bookListCache.get(ck);
  if (!opts.fresh) {
    if (hit && hit.at > 0) {
      if (Date.now() - hit.at < BOOKLIST_TTL) return { books: hit.books, stale: false };
      revalidateBookList(root, ck);
      return { books: hit.books, stale: true };
    }
    if (hit && hit.books && hit.books.length) {      // 快照已回，后台还在校正
      revalidateBookList(root, ck);
      return { books: hit.books, stale: true };
    }
    const snap = readBookSnapshot(root);
    if (snap) {
      bookListCache.set(ck, { at: 0, books: snap.books });
      revalidateBookList(root, ck);
      return { books: snap.books, stale: true };
    }
  }
  const books = await listBooksUncached(root);
  bookListCache.set(ck, { at: Date.now(), books });
  if (bookListCache.size > 32) bookListCache.delete(bookListCache.keys().next().value);
  saveBookSnapshotSoon(root, books);
  return { books, stale: false };
}

/**
 * 扫描本地书架。
 *
 * 旧实现逐个文件 stat + 同步读取 4KB 头部，1.4 万本时约 2.3s；这里先串行遍历目录树，
 * 再用固定并发池读取文件头，Windows 实测约 0.9s。保持原有的隐藏项/小于 1KB/深度 <= 6
 * 过滤规则和返回字段不变。
 */
async function listBooksUncached(root) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("__")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      files.push({ abs, name: path.basename(e.name, path.extname(e.name)) });
    }
  }
  await walk(root, 0);

  const out = new Array(files.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      let fh;
      try {
        fh = await fsp.open(f.abs, "r");
        const st = await fh.stat();
        if (!st.isFile() || st.size < 1024) continue;
        const head = Buffer.allocUnsafe(4096);
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        let author = "";
        try {
          const { text } = decodeBuffer(head.subarray(0, bytesRead));
          const m = text.match(/^\s*作者[:：]\s*(.+)$/m);
          if (m) author = m[1].trim().slice(0, 40);
        } catch {}
        out[i] = { rel: path.relative(root, f.abs), name: f.name, size: st.size, mtime: st.mtimeMs, author };
      } catch {} finally {
        if (fh) await fh.close().catch(() => {});
      }
    }
  }
  const workerCount = Math.min(BOOK_SCAN_CONCURRENCY, Math.max(1, files.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  const books = out.filter(Boolean);
  books.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return books;
}

/* ============================ 书源存储 ============================ */

/** 用户书源库：[normalized source] */
let sources = [];
/** bookSourceUrl -> source */
const sourceMap = new Map();

/**
 * 书源组是互相独立的整套书源集合，不是单个书源的 bookSourceGroup 标签。
 * 索引与组数据都放在 sources/groups/ 下：
 *   sources/groups/index.json
 *   sources/groups/<groupId>/book-sources.json
 * 旧版 sources/book-sources.json 会在首次启动时迁移为「书源组1」，并继续作为
 * 当前生效组的镜像，方便旧工具读取。
 */
let sourceGroupIndex = { version: 1, activeId: "", groups: [] };

function sourceGroupSafeId(value) {
  const id = String(value || "").trim();
  return SOURCE_GROUP_ID_RE.test(id) ? id : "";
}
function sourceGroupById(id) {
  const safe = sourceGroupSafeId(id);
  return safe ? sourceGroupIndex.groups.find((g) => g.id === safe) || null : null;
}
function sourceGroupDir(id) {
  const safe = sourceGroupSafeId(id);
  if (!safe) throw new Error("书源组 ID 不合法");
  const root = path.resolve(SOURCE_GROUPS_DIR);
  const dir = path.resolve(root, safe);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error("书源组路径不合法");
  return dir;
}
function sourceGroupFile(id) {
  return path.join(sourceGroupDir(id), "book-sources.json");
}
function activeSourceGroup() {
  return sourceGroupById(sourceGroupIndex.activeId);
}
function activeSourceGroupPath() {
  const group = activeSourceGroup();
  return group ? sourceGroupFile(group.id) : SOURCE_PATH;
}
function normalizeSourceGroupName(value) {
  const name = String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").trim();
  return name.slice(0, 40);
}
function writeSourceGroupIndex() {
  fs.mkdirSync(SOURCE_GROUPS_DIR, { recursive: true });
  sourceGroupIndex.version = 1;
  fs.writeFileSync(SOURCE_GROUPS_INDEX, JSON.stringify(sourceGroupIndex, null, 2), "utf8");
}
function readSourceGroupIndex() {
  const raw = fs.readFileSync(SOURCE_GROUPS_INDEX, "utf8");
  const parsed = JSON.parse(raw);
  const now = Date.now();
  const groups = Array.isArray(parsed && parsed.groups)
    ? parsed.groups.map((g) => ({
        id: sourceGroupSafeId(g && g.id),
        name: normalizeSourceGroupName(g && g.name),
        createdAt: Number(g && g.createdAt) || now,
        updatedAt: Number(g && g.updatedAt) || now,
      })).filter((g) => g.id && g.name)
    : [];
  return { version: 1, activeId: sourceGroupSafeId(parsed && parsed.activeId), groups };
}
function seedSourceGroupFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return;
  const from = fs.existsSync(SOURCE_PATH) ? SOURCE_PATH
    : (fs.existsSync(SOURCE_DEFAULT) ? SOURCE_DEFAULT : "");
  if (from) { fs.copyFileSync(from, file); return; }

  /* exe（SEA）模式：磁盘上只有 exe 一个文件，书源打包在 assets 里。
     首次运行时把内置书源「释放」到 exe 同级目录，之后用户就能像开发模式
     一样在「书源管理」里增删改 —— 界面写的是磁盘上的 sources/groups/*.json。 */
  if (IS_SEA) {
    const builtin = readAsset("book-sources.json");
    if (builtin) {
      fs.writeFileSync(file, builtin, "utf8");
      console.log(`已释放内置书源到 ${path.relative(__dirname, file)}`);
      return;
    }
  }
  fs.writeFileSync(file, "[]", "utf8");
}
function ensureSourceGroups() {
  fs.mkdirSync(SOURCE_GROUPS_DIR, { recursive: true });
  let parsed = null;
  if (fs.existsSync(SOURCE_GROUPS_INDEX)) {
    try { parsed = readSourceGroupIndex(); }
    catch (e) {
      const backup = SOURCE_GROUPS_INDEX + ".bad-" + Date.now();
      try { fs.renameSync(SOURCE_GROUPS_INDEX, backup); } catch {}
      console.error(`书源组索引损坏，已备份到 ${backup}: ${e.message}`);
    }
  }
  if (!parsed || !parsed.groups.length) {
    const id = "group-1";
    const now = Date.now();
    seedSourceGroupFile(sourceGroupFile(id));
    parsed = {
      version: 1,
      activeId: id,
      groups: [{ id, name: "书源组1", createdAt: now, updatedAt: now }],
    };
  }
  if (!parsed.activeId || !parsed.groups.some((g) => g.id === parsed.activeId)) {
    parsed.activeId = parsed.groups[0].id;
  }
  for (const group of parsed.groups) seedSourceGroupFile(sourceGroupFile(group.id));
  sourceGroupIndex = parsed;
  writeSourceGroupIndex();
}
function sourceGroupPublic() {
  const active = activeSourceGroup();
  return {
    activeId: active ? active.id : "",
    activeName: active ? active.name : "",
    groups: sourceGroupIndex.groups.map((g) => ({ ...g })),
  };
}
function markActiveSourceGroupUpdated() {
  const group = activeSourceGroup();
  if (!group) return;
  group.updatedAt = Date.now();
  writeSourceGroupIndex();
}

function loadSources() {
  ensureSourceGroups();
  const target = activeSourceGroupPath();
  let raw = null;
  for (const file of [target, SOURCE_PATH, SOURCE_DEFAULT]) {
    try { raw = fs.readFileSync(file, "utf8"); break; } catch {}
  }
  if (!raw) { sources = []; sourceMap.clear(); return; }
  try {
    const parsed = parseSourceImport(raw);
    sources = parsed.sources.map((s) => normalizeSource(s));
    if (parsed.skipped.length) console.log(`书源导入跳过 ${parsed.skipped.length} 条`);
  } catch (e) {
    console.error("书源加载失败:", e.message);
    sources = [];
  }
  sourceMap.clear();
  for (const s of sources) sourceMap.set(sourceKey(s), s);
  const active = activeSourceGroup();
  console.log(`已载入书源组「${active ? active.name : "默认"}」 ${sources.length} 个`);
}

async function persistSources() {
  try {
    const target = activeSourceGroupPath();
    const body = exportSources(sources);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body, "utf8");
    if (path.resolve(target) !== path.resolve(SOURCE_PATH)) {
      await fsp.writeFile(SOURCE_PATH, body, "utf8");
    }
    markActiveSourceGroupUpdated();
  } catch (e) { console.error("保存书源失败:", e.message); }
}

function enabledSources() { return sources.filter((s) => s.enabled !== false); }

/** 书源唯一键（bookSourceUrl） */
const getSKey = (s) => sourceKey(s);

/** 全部书源分组名（去重排序） */
function groupNames() {
  const set = new Set();
  for (const s of sources) {
    const g = s.bookSourceGroup;
    if (!g) continue;
    for (const part of String(g).split(/[,，;；|]/)) {
      const x = part.trim();
      if (x) set.add(x);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh"));
}

/* ============ 书籍分组（legado book_groups 表 / BookGroupDao / BookGroup.kt） ============
 * legado 里分组 id 是**位掩码**：BookGroupDao.getUnusedId() 取最低未占用位（id = id.shl(1)），
 * Book.group 也是位掩码，所以一本书能同时属于多个分组（Book.kt:78）。
 * BookAdapter.getGroupName()：groupId > 0 且 (groupId and book.group) > 0 的分组名以「,」拼起来。
 * 我们用同一套语义，只是把 SQL 换算成数组操作。 */

function bookGroups() {
  if (!Array.isArray(config.online.bookGroups)) config.online.bookGroups = [];
  return config.online.bookGroups;
}

/** BookGroupDao.flowSelect()：groupId >= 0，按 `order` 升序 */
function bookGroupSorted() {
  return bookGroups().filter((g) => Number(g.groupId) >= 0)
    .slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/** BookGroupDao.getUnusedId()：sum(groupId) 里第一个空位 */
function bookGroupUnusedId() {
  const sum = bookGroups().reduce((a, g) => a + (Number(g.groupId) > 0 ? Number(g.groupId) : 0), 0);
  let id = 1;
  while ((id & sum) !== 0) id = id << 1;
  return id;
}

/** BookAdapter.getGroupName(groupId) —— 逗号拼接的分组名，没有分组返回空串 */
function bookGroupNames(groupId) {
  const id = Number(groupId) || 0;
  if (!id) return "";
  return bookGroupSorted()
    .filter((g) => Number(g.groupId) > 0 && (Number(g.groupId) & id) > 0)
    .map((g) => g.groupName).join(",");
}

/** legado Book.order：书架管理长按拖动后按 order 排列；旧数据按现有顺序补齐。 */
function ensureShelfOrder() {
  let changed = false;
  config.online.books.forEach((b, i) => {
    if (!Number.isFinite(Number(b.order))) { b.order = i + 1; changed = true; }
  });
  return changed;
}
function shelfBooksSorted() {
  ensureShelfOrder();
  return config.online.books.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/* ============================ 抓取池 ============================ */

/** @type {BookPool|null} */
let pool = null;
let poolSourceHash = "";

/**
 * worker 侧持有**全部**书源（含 enabled=false）。
 * legado 里 AppDatabase.bookSourceDao.getBookSource(key) 不看 enabled：
 * 停用的书源照样能打开登录页、能调试；"是否参与搜索"由上层过滤（enableSources 的用法见 /api/online/search）。
 * 早期只把启用书源下发给 worker，导致停用的🍅番茄小说连登录窗都打不开（书源不存在）。
 */
function sourceHash() {
  return sources.map((s) => sourceKey(s) + ":" + (s.lastUpdateTime || 0)).join("|");
}

function getPool() {
  const h = sourceHash();
  if (!pool) {
    // worker 数量优先级：阅读设置 > 环境变量 READER_POOL_SIZE > 默认 4。
    // 设置面板可运行时热改（POST /api/online/pool），改完写回 config.settings。
    const settingSize = Math.trunc(Number(config.settings && config.settings.sourcePoolSize) || 0);
    pool = new BookPool({
      size: settingSize > 0 ? settingSize : Number(process.env.READER_POOL_SIZE || 4),
      netSlots: Number(process.env.READER_NET_SLOTS || 16),
      timeout: config.online.searchTimeout || 90000,
      sources,

    });
    poolSourceHash = h;
    // 冷启动恢复登录态（legado：CookieStore/CacheManager 落库）
    pool.restoreState().catch(() => {});
    return pool;
  }
  if (poolSourceHash !== h) {
    poolSourceHash = h;
    pool.setSources(sources).catch(() => {});
  }
  return pool;
}

function closePool() { try { pool?.close(); } catch {} pool = null; }

/**
 * 发现页 infoMap（legado ExploreAdapter 的 infoMap 是跨调用共享的 MutableMap）。
 * 前端持有一份，每次请求带上；这里只做透传 + 校验。
 */
function exploreInfoFromQuery(u) {
  const raw = u.searchParams.get("infoMap");
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}

/** 广播「清空发现分类缓存」到所有 worker（legado clearExploreKindsCache） */
async function clearExploreKindCacheEverywhere(sourceUrl) {
  try { await getPool().broadcast("exploreClearCache", { sourceUrl }, { timeout: 15000 }); } catch { /* 尽力而为 */ }
}

/** 在线书 key：origin + '|' + bookUrl */
const okey = (origin, bookUrl) => String(origin || "") + "|" + String(bookUrl || "");

/**
 * tocUrl 是不是「坏记录」？三种情况：
 *   1) 空 —— 从没抓到过目录；
 *   2) 与详情页 bookUrl 完全相同 —— 详情页被当目录页存下来了；
 *   3) 书源模板变量没替换成功，留下空查询参数。
 *      例：松鹤阅读的 tocUrl 模板是
 *        https://bookshelf.html5.qq.com/qbread/api/book/all-chapter?bookId={{$..resourceID}}
 *      详情页解析失败时 resourceID 取空，落盘成 `...all-chapter?bookId=`。
 *      实测该 URL 站点直接回 `{"ret":422,...should not be empty...field: bookId}`，
 *      永远拿不到目录，必须判坏才能触发重抓详情把它补上。
 *
 * 注意不能把「tocUrl === bookUrl」一律当坏：速读谷² 这类站点的目录页
 * 就是详情页本身（`https://www.shudugu.org/485/`），这是正常形态，
 * 由调用方配合 readTocCache() 判断是否真的抓过目录。
 */
function isDegenerateTocUrl(tocUrl, bookUrl) {
  if (!tocUrl) return true;
  const a = String(tocUrl).split(',{')[0].trim();
  const b = String(bookUrl).split(',{')[0].trim();
  if (a === b) return true;
  try {
    const ua = new URL(a);
    let ub = null;
    try { ub = new URL(b); } catch { /* bookUrl 可能是 data: 或非标准地址 */ }
    for (const [name, value] of ua.searchParams) {
      if (String(value).trim() !== "") continue;
      // 不能把所有空参数都当坏 URL：`?x=&y=1` 在 HTTP 语义里合法。
      // 这里只认两类强信号：id 类必填参数为空，或同一参数在详情 URL 里本来有值。
      const n = String(name || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      const idLike = /(?:^|_)(?:id|bid|cid|bookid|chapterid|novelid|resourceid)$/.test(n);
      const hadValueInBookUrl = !!(ub && String(ub.searchParams.get(name) || "").trim());
      if (idLike || hadValueInBookUrl) return true;
    }
  } catch { /* data: 等非标准 URL 不参与空参数判断 */ }
  return false;
}

/**
 * 按 legado BookshelfViewModel 的方式，用 bookUrlPattern 在书源里反查 origin。
 * 场景：书架的 origin 指向了错误的书源（历史脏数据 / 搜索结果被合并覆盖过），
 * 结果就是拿着 A 源的 origin 去解析 B 源的 bookUrl → 目录恒为空。
 * legado 的做法是遍历所有带 bookUrlPattern 的启用书源，bookUrl.match(pattern) 命中即用。
 * @returns {object|null} 命中的书源
 */
function urlHost(u) {
  try { return new URL(String(u || '').split(',{')[0].trim()).host.toLowerCase(); }
  catch { return ''; }
}

function safeTest(pattern, url) {
  try { return new RegExp(pattern).test(String(url || '').split(',{')[0].trim()); }
  catch { return true; } // 用户写的正则非法时不做否定判断，避免误改
}

/**
 * 这个书源认不认这个 bookUrl？
 * 优先 bookUrlPattern（legado 的官方判据），书源没写 pattern 时退化为同域判断。
 */
function sourceAcceptsBookUrl(s, bookUrl) {
  if (!s) return false;
  if (s.bookUrlPattern) return safeTest(s.bookUrlPattern, bookUrl);
  const h = urlHost(s.bookSourceUrl);
  return !!h && h === urlHost(bookUrl);
}

function matchSourceByBookUrl(bookUrl) {
  const url = String(bookUrl || '').split(',{')[0].trim();
  if (!url) return null;
  for (const s of sources) {
    if (!s.enabled || !s.bookUrlPattern) continue;
    if (safeTest(s.bookUrlPattern, url)) return s;
  }
  // 没有 pattern 的书源（如松鹤阅读）按同域兜底
  const host = urlHost(url);
  if (host) {
    for (const s of sources) {
      if (!s.enabled || s.bookUrlPattern) continue;
      if (urlHost(s.bookSourceUrl) === host) return s;
    }
  }
  return null;
}

/**
 * 归一化 bookUrl。
 * 历史版本在写书架时对 urlOption 的 JSON 段做过一次 encodeURI（`{"headers":..}` → `%7B%22headers%22..`），
 * legado 的 bookUrl 始终是「url,{jsonOption}」明文形态；编码后 AnalyzeUrl 的 PARAM_PATTERN
 * (`\s*,\s*(?=\{)`) 匹配不到，headerMap 丢失 → 需要 sign 头的源（七猫）全部 401。
 * 只在明确检测到「编码过的 urlOption」时才还原，避免误伤本身带百分号转义的合法 URL。
 */
function normalizeBookUrl(raw) {
  const s = String(raw || "");
  if (!s) return s;
  const i = s.indexOf(",{");
  if (i === -1) return s;
  const head = s.slice(0, i);
  let opt = s.slice(i + 1);
  if (!opt.includes("%22") && !opt.includes("%7B")) return s;
  try {
    const dec = decodeURIComponent(opt);
    if (!dec.startsWith("{")) return s;
    JSON.parse(dec);
    return head + "," + dec;
  } catch { return s; }
}
/** 书架记录的 origin 与 bookUrl 对不上时纠正（legado 换源同语义） */
function repairOnlineBookOrigin(book) {
  if (!book || !book.bookUrl) return false;
  const oldOrigin = String(book.origin || '');
  const cur = sourceMap.get(oldOrigin);
  if (sourceAcceptsBookUrl(cur, book.bookUrl)) return false;
  const hit = matchSourceByBookUrl(book.bookUrl);
  if (!hit || hit.bookSourceUrl === oldOrigin) return false;
  console.log(`修正书架来源: ${book.name} ${book.originName || oldOrigin} → ${hit.bookSourceName}`);
  book.origin = hit.bookSourceUrl;
  book.originName = hit.bookSourceName;
  // 换源后 tocUrl 不可信，清掉让它重抓
  if (isDegenerateTocUrl(book.tocUrl, book.bookUrl)) book.tocUrl = '';
  // 阅读进度跟着换 key，否则进度会丢
  const oldKey = okey(oldOrigin, book.bookUrl);
  const newKey = okey(book.origin, book.bookUrl);
  if (config.online.progress[oldKey] !== undefined && config.online.progress[newKey] === undefined) {
    config.online.progress[newKey] = config.online.progress[oldKey];
    delete config.online.progress[oldKey];
  }
  return true;
}

/**
 * 书架条目「完整度」评分 —— 用来在重复记录里挑出该留的那条。
 * 背景：换源（doChangeSource）正常是「删旧插新」，但历史上出现过
 * 同一本书留下两条记录的情况（例如先手动换了源、旧记录又被重新写回），
 * 其中一条的 tocUrl 是坏的（bookId 空），去重时若命中坏的那条，
 * 打开正文就会「目录为空」。legado 里 Book 表主键是 bookUrl，
 * 换源时 oldBook.delete() 保证不会重复；我们按 bookUrl 存，
 * 但换源后 bookUrl 变了，旧的残留就变成孤儿记录，所以这里做一次收敛。
 */
function bookRecordScore(b) {
  let s = 0;
  if (!isDegenerateTocUrl(b.tocUrl, b.bookUrl)) s += 100;
  if (Number(b.totalChapterNum) > 0) s += 50;
  if (b.latestChapterTitle) s += 10;
  if (b.coverUrl) s += 5;
  if (b.intro) s += 3;
  if (b.variable) s += 1;
  return s;
}

/** 同名同作者 = 同一本书（legado SearchAdapter.areItemsTheSame 判据） */
function sameBookMeta(a, b) {
  if (String(a.name || "").trim() !== String(b.name || "").trim()) return false;
  const aa = String(a.author || "").trim();
  const ba = String(b.author || "").trim();
  if (!aa || !ba) return true;
  return aa === ba;
}

/**
 * 合并书架里的重复记录：同名同作者只留「最完整」的一条。
 * 被丢掉的那条如果还占着阅读进度，把进度搬到留下的那条上。
 * @returns {number} 清理掉几条
 */
function dedupeOnlineBooks() {
  const groups = new Map();
  for (const b of config.online.books) {
    const key = String(b.name || "").trim() + "\u0000" + String(b.author || "").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  let removed = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list.slice().sort((x, y) => bookRecordScore(y) - bookRecordScore(x))[0];
    // 书架按 order（加入时间）排序，保留最早的那个位置，书不会因为清理而跳位
    const orders = list.map((x) => Number(x.order)).filter((v) => Number.isFinite(v));
    if (orders.length) keep.order = Math.min(...orders);
    for (const b of list) {
      if (b === keep) continue;
      const k = okey(b.origin, b.bookUrl);
      // 进度搬迁：留下那条没有进度、被删那条有时才搬，避免覆盖新书源的进度
      const keepKey = okey(keep.origin, keep.bookUrl);
      if (config.online.progress[k] && !config.online.progress[keepKey]) {
        config.online.progress[keepKey] = config.online.progress[k];
      }
      delete config.online.progress[k];
      dropTocCache(b.origin, b.bookUrl);
      dropContentCache(b.origin, b.bookUrl);
      config.online.books = config.online.books.filter((x) => x !== b);
      console.log(`清理书架重复记录：《${b.name}》${b.originName || b.origin}（保留 ${keep.originName || keep.origin}）`);
      removed++;
    }
  }
  return removed;
}

function repairAllOnlineBooks() {
  let n = 0;
  for (const b of config.online.books) {
    // 1) bookUrl 编码还原（key 变了要跟着搬进度）
    try {
      const fixed = normalizeBookUrl(b.bookUrl);
      if (fixed !== b.bookUrl) {
        const oldKey = okey(b.origin, b.bookUrl);
        b.bookUrl = fixed;
        const newKey = okey(b.origin, fixed);
        if (config.online.progress[oldKey] !== undefined && config.online.progress[newKey] === undefined) {
          config.online.progress[newKey] = config.online.progress[oldKey];
        }
        delete config.online.progress[oldKey];
        console.log("修正书架 bookUrl 编码: " + b.name);
        n++;
      }
    } catch {}
    // 2) 来源与 bookUrl 不匹配时纠正
    try { if (repairOnlineBookOrigin(b)) n++; } catch {}
  }
  // 3) 同名同作者去重（换源残留的孤儿记录）
  try { n += dedupeOnlineBooks(); } catch (e) { console.log("去重失败: " + e.message); }
  if (n) saveConfig();
  return n;
}

function findOnlineBook(origin, bookUrl) {
  const k = okey(origin, bookUrl);
  return config.online.books.find((b) => okey(b.origin, b.bookUrl) === k) || null;
}

/* ---------------- 历史坏记录自愈：bookUrl 的 URL 选项 ---------------- */

/**
 * 书源规则的 bookUrl 模板里带 `,{...}` URL 选项吗？
 *
 * 早期版本往书架写记录时会把这截选项剥掉，结果松鹤阅读这类靠 Referer 过风控的源
 * 详情接口恒回 `incorrect referer`（实测 17 字节），详情里的模板变量取不到值，
 * tocUrl 落盘成 `...all-chapter?bookId=`，目录就永远是空的。
 * 这里按「书源规则本来就该带选项」识别这类历史记录 —— 没这个判据就不能乱补，
 * 很多源的 bookUrl 本来就不带选项。
 */
function sourceBookUrlHasOption(s) {
  if (!s) return false;
  for (const r of [s.ruleSearch, s.ruleExplore]) {
    const v = r && r.bookUrl;
    const t = typeof v === "string" ? v : (v && (v.rule || v.js)) || "";
    if (typeof t === "string" && /,\s*\{/.test(t)) return true;
  }
  return false;
}

/** 取出规则模板尾部的 `,{...}` 选项段（没有就返回空串） */
function ruleOptionText(v) {
  const t = typeof v === "string" ? v : (v && (v.rule || v.js)) || "";
  if (typeof t !== "string") return "";
  const i = t.indexOf(",{");
  return i === -1 ? "" : t.slice(i + 1).trim();
}

/**
 * 兜底修复：书源规则里本来就写死了 Referer 头（松鹤阅读的 tocUrl 规则就是这样），
 * 把它移植到裸 bookUrl 上。
 *
 * 只在「精确搜索没拿到带选项的结果」时用。移植范围严格限制为 `headers` 一项：
 * 规则尾部的选项里还可能有 @js / body / method 等，那些跟具体请求强绑定，乱搬会出错。
 * @returns {string} 补好选项的 bookUrl；搬不了时返回空串
 */
function transplantRuleHeaders(s, bookUrl) {
  const bare = String(bookUrl || "");
  if (!s || !bare || bare.includes(",{")) return "";
  for (const r of [s.ruleSearch, s.ruleExplore, s.ruleBookInfo]) {
    const opt = ruleOptionText(r && (r.bookUrl || r.tocUrl));
    if (!opt || !opt.startsWith("{")) continue;
    // 选项里还留着没渲染的模板变量（{{...}}）时不能搬：搬到请求上会原样发出去
    if (opt.includes("{{")) continue;
    try {
      const j = JSON.parse(opt);
      const headers = j && j.headers;
      if (!headers || typeof headers !== "object") continue;
      return bare + "," + JSON.stringify({ headers });
    } catch { /* 选项里带模板变量，解析不了就换下一个 */ }
  }
  return "";
}

/**
 * 判断规则选项里是否还有未渲染的动态占位符。
 * 纵横中文网这类 POST body 会写成 `bookId={$.bookId}`；裸 bookUrl 上没有
 * bookId，不能原样移植，否则请求会带着字面量 `{$.bookId}` 发出去。
 */
function ruleOptionHasUnresolvedPlaceholder(value) {
  return /\{\{|\{\$\.|<js:|@js:/i.test(JSON.stringify(value));
}

/**
 * 从同源的 bookUrl 规则移植完整 URL 选项。
 *
 * 这里比 transplantRuleHeaders() 多支持 method/body 等静态完整选项，但前提是
 * 选项已经没有模板占位符；动态 body（如纵横 `bookId={$.bookId}`）不能从
 * 裸 URL 反推出 bookId，仍必须依赖 preciseSearchWithRetry 返回完整结果。
 */
function transplantRuleOptions(s, bookUrl) {
  const bare = String(bookUrl || "");
  if (!s || !bare || bare.includes(",{")) return "";
  for (const r of [s.ruleSearch, s.ruleExplore, s.ruleBookInfo]) {
    const opt = ruleOptionText(r && r.bookUrl);
    if (!opt || !opt.startsWith("{")) continue;
    try {
      const j = JSON.parse(opt);
      if (!j || typeof j !== "object") continue;
      if (ruleOptionHasUnresolvedPlaceholder(j)) continue;
      return bare + "," + JSON.stringify(j);
    } catch { /* 非完整 JSON 选项不搬 */ }
  }
  // 静态完整选项拿不到时，退回只移植 headers 的保守路径。
  return transplantRuleHeaders(s, bookUrl);
}

/**
 * 历史坏记录自愈缓存：`origin|裸bookUrl` → 修复后的 bookUrl（修不好记空串）。
 *
 * 只改「本次请求实际用的 URL」，不写回书架记录 —— 书架的 bookUrl 是前端 rel、
 * 阅读进度 key、目录/正文缓存 key 的组成部分，就地改写会把正在读的这本书的状态
 * 全部打乱。legado 里 Book.bookUrl 也始终是「url,{jsonOption}」明文形态，
 * 只在 AnalyzeUrl 消费时才切分。
 */
const bookUrlHealCache = new Map();
const BOOK_URL_HEAL_FAILURE_TTL_MS = 10 * 60 * 1000;

function readBookUrlHealCache(key) {
  const hit = bookUrlHealCache.get(key);
  if (!hit) return undefined;
  // 失败负缓存不能永久生效：站点恢复或搜索接口修好后必须能重试。
  if (hit.failure && Date.now() >= hit.expiresAt) {
    bookUrlHealCache.delete(key);
    return undefined;
  }
  return hit.value || null;
}

function writeBookUrlHealCache(key, fixed) {
  bookUrlHealCache.set(key, fixed
    ? { value: fixed }
    : { failure: true, expiresAt: Date.now() + BOOK_URL_HEAL_FAILURE_TTL_MS });
}

/**
 * 这条书架记录需要做「URL 选项自愈」吗？
 * 判据（三个条件同时成立才是历史坏记录）：
 *   1) 书源规则的 bookUrl 模板本来就该带 `,{...}`；
 *   2) 记录里的 bookUrl 是裸的；
 *   3) 记录里的 tocUrl 也是裸的 —— 一旦 tocUrl 已带上选项，说明这条记录修过了，
 *      不能再触发，否则每次打开书都要白跑一次精确搜索，越读越慢。
 */
function needsUrlOptionHeal(origin, bookUrl, tocUrl) {
  const raw = String(bookUrl || "");
  if (!raw || raw.includes(",{")) return false;
  if (String(tocUrl || "").includes(",{")) return false;
  return sourceBookUrlHasOption(sourceMap.get(origin));
}

/**
 * 给一条「丢了 URL 选项」的历史记录找回选项。
 * 办法等价于 legado WebBook.preciseSearchAwait：按书名 + 作者精确搜一次，
 * 取搜索结果里那条自带 `,{...}` 的 bookUrl（搜索结果的 bookUrl 是规则直接产出的，
 * 实测松鹤阅读的搜索接口返回就带完整 Referer 选项）。
 * @returns {Promise<string|null>} 修复后的 bookUrl；不需要修 / 修不了时返回 null
 */
async function healLegacyBookUrl(origin, bookUrl, name, author) {
  const raw = String(bookUrl || "");
  if (!raw || raw.includes(",{")) return null;      // 本来就带选项，不用修
  const s = sourceMap.get(origin);
  if (!sourceBookUrlHasOption(s)) return null;      // 该源的 bookUrl 本来就没选项，别乱补
  const nm = String(name || "").trim();
  if (!nm) return null;                             // 没有书名没法精确搜索
  const key = okey(origin, raw);
  const cached = readBookUrlHealCache(key);
  if (cached !== undefined) return cached;
  try {
    const ps = await preciseSearchWithRetry(origin, nm, String(author || "").trim(), 1);
    const hit = ps && ps.book;
    let fixed = hit && String(hit.bookUrl || "").includes(",{") ? String(hit.bookUrl) : "";
    // 精确搜索没带回选项（站点抽风 / 搜索接口变更）时，退回「从书源规则移植 headers」
    if (!fixed) fixed = transplantRuleOptions(s, raw);
    writeBookUrlHealCache(key, fixed);
    if (fixed) console.log(`修复历史 bookUrl 选项：《${nm}》${(s && s.bookSourceName) || origin}`);
    return fixed || null;
  } catch (e) {
    // 搜索本身失败也别直接放弃：书源规则里写着固定 Referer 的话照样能救回来
    const fixed = transplantRuleOptions(s, raw);
    writeBookUrlHealCache(key, fixed);
    if (fixed) console.log(`修复历史 bookUrl 选项（按规则移植）：《${nm}》${(s && s.bookSourceName) || origin}`);
    return fixed || null;
  }
}

/**
 * 补齐在线书籍的详情。
 * 为什么必要：目录抓取依赖 book.tocUrl，而搜索结果是拿不到 tocUrl 的，
 * legado 里这一步由 WebBook.getBookInfoAwait 完成；这里等价地补上。
 */
async function ensureBookInfo(origin, bookUrl, { force = false, timeout, seed = null, actions = null } = {}) {
  const s = sourceMap.get(origin);
  if (!s) throw Object.assign(new Error("书源不存在，可能已被删除"), { code: "NO_SOURCE" });
  let book = findOnlineBook(origin, bookUrl);
  // tocUrl 缺失或等于详情页地址 = 坏记录（上一次抓取失败留下的），必须重抓
  // 另外：bookUrl 缺 URL 选项（历史版本写坏）时也必须重抓一次，否则目录永远抓不出来。
  if (book && !force && !isDegenerateTocUrl(book.tocUrl, bookUrl)
      && !needsUrlOptionHeal(origin, bookUrl, book.tocUrl)) return book;
  // 历史坏记录自愈：先把被剥掉的 `,{Referer}` 选项找回来，否则详情接口恒回
  // incorrect referer，tocUrl 模板里的变量永远渲染成空 —— 这就是「目录为空」修不好的原因。
  const healedUrl = await healLegacyBookUrl(
    origin, bookUrl,
    (book && book.name) || (seed && seed.name),
    (book && book.author) || (seed && seed.author),
  );
  const requestUrl = healedUrl || bookUrl;
  const r = await getPool().request("bookInfo", {
    sourceUrl: origin,
    book: {
      bookUrl: requestUrl, origin, originName: s.bookSourceName,
      name: book?.name || (seed && seed.name) || "",
      author: book?.author || (seed && seed.author) || "",
    },
    canReName: true,
  }, { timeout: timeout || config.online.searchTimeout || 60000 });
  // 书源详情脚本里可能有 java.showBrowser/startBrowser（需要人工登录/验证），
  // legado 会直接弹 WebView；桌面端把动作回给调用方，由前端开弹窗。
  if (Array.isArray(actions) && Array.isArray(r.result.actions)) actions.push(...r.result.actions);
  const info = r.result.book;
  // 解析失败保护：规则没取到书名，且目录链接退化了 —— 说明这次抓取没拿到有效正文
  // （常见于 403 / 需要 Referer / 网络抖动）。此时绝不能落盘，否则「详情页」会被当成目录页
  // 永久缓存下来，之后因为 tocUrl 非空而永远不会重抓。宁可抛错让上层重试。
  // 用 isDegenerateTocUrl 而不是简单比较：它还能识别「模板变量没替换成功、留下空查询参数」
  // 这一类（`...all-chapter?bookId=`），否则坏 tocUrl 会覆盖掉记录里本来还好的值。
  if (!info.name && isDegenerateTocUrl(info.tocUrl, requestUrl)) {
    throw Object.assign(new Error("详情页解析失败（未取到书名，可能是网络或防盗链）"), { code: "PARSE_FAILED" });
  }
  if (book) {
    Object.assign(book, {
      name: info.name || book.name, author: info.author || book.author,
      intro: info.intro ?? book.intro, coverUrl: info.coverUrl ?? book.coverUrl,
      kind: info.kind ?? book.kind,
      tocUrl: info.tocUrl || (isDegenerateTocUrl(book.tocUrl, bookUrl) ? '' : book.tocUrl),
      latestChapterTitle: info.latestChapterTitle ?? book.latestChapterTitle,
      wordCount: info.wordCount ?? book.wordCount,
      variable: info.variable ?? book.variable, type: info.type ?? book.type,
    });
    saveConfig();
    return book;
  }
  book = { ...info, origin, originName: s.bookSourceName };
  book.bookUrl = book.bookUrl || bookUrl;
  return book;
}

/* ============================ 正文后处理 ============================ */

/**
 * 替换净化 —— 语义严格对齐 legado：
 *
 *  1) 取规则： ReplaceRuleDao.kt
 *       findEnabledByContentScope(name, origin)  按正文
 *       findEnabledByTitleScope(name, origin)    按标题
 *     SQL： WHERE isEnabled = 1 AND scopeContent = 1
 *             AND (scope LIKE '%name%' OR scope LIKE '%origin%' OR scope IS NULL OR scope = '')
 *             AND (excludeScope IS NULL OR (excludeScope NOT LIKE '%name%' AND excludeScope NOT LIKE '%origin%'))
 *           ORDER BY sortOrder
 *  2) 跑规则： ContentProcessor.kt:157-192
 *       · 正文逐行 trim 之后再替换
 *       · isRegex=false 时是字面量替换（不是正则）
 *       · 某条规则正则写坏只丢这条，不影响整章
 *  3) 标题：   BookChapter.getDisplayTitle()（同样受 scope/order 管）
 */
/** legado ReplaceRule.isValid()：pattern 为空直接跳过（ContentProcessor 里 if (item.pattern.isEmpty())） */
function isEmptyPattern(p) {
  return String(p == null ? "" : p).length === 0;
}

/** 把 Java Pattern 编译成 JS 正则（见 src/java-regex.mjs）。 */
function legadoRegex(pattern) {
  return javaRegex(pattern, "g");
}

function ruleOrder(r) {
  const v = Number(r && r.order);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

/**
 * SQLite LIKE 语义（android_metadata 默认 case_sensitive_like = off）：
 *   `%` 任意长度、`_` 单个字符，其余为字面量；ASCII 大小写不敏感。
 * legado ReplaceRuleDao 的 SQL 里直接把书名/书源 URL 拼进 LIKE 模式
 * （`scope LIKE '%' || :name || '%'`），所以这里必须按 LIKE 而不是
 * JS 的 String.includes 来判定，否则空串、通配符、大小写的结果都会不一致。
 */
function sqlLikeMatches(value, pattern) {
  if (value == null) return false; // SQL：NULL LIKE ... → NULL（假）
  let src = "^";
  for (const ch of String(pattern)) {
    if (ch === "%") src += "[\\s\\S]*";
    else if (ch === "_") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  src += "$";
  try { return new RegExp(src, "i").test(String(value)); } catch { return false; }
}

function ruleInScope(r, name, origin) {
  const n = String(name == null ? "" : name);
  const o = String(origin == null ? "" : origin);
  const scope = r.scope == null ? null : String(r.scope);
  // scope LIKE '%name%' OR scope LIKE '%origin%' OR scope IS NULL OR scope = ''
  const scopeHit = scope === null || scope === ""
    || sqlLikeMatches(scope, "%" + n + "%")
    || sqlLikeMatches(scope, "%" + o + "%");
  if (!scopeHit) return false;
  // excludeScope IS NULL OR (excludeScope NOT LIKE '%name%' AND NOT LIKE '%origin%')
  const ex = r.excludeScope == null ? null : String(r.excludeScope);
  if (ex !== null) {
    if (sqlLikeMatches(ex, "%" + n + "%")) return false;
    if (sqlLikeMatches(ex, "%" + o + "%")) return false;
  }
  return true;
}

/** kind = "content" | "title"；对齐 dao 里的 scopeContent / scopeTitle 判定 */
function pickReplaceRules(kind, name, origin) {
  const flag = kind === "title" ? "scopeTitle" : "scopeContent";
  const list = (config.online.replaceRules || []).filter((r) => {
    if (!r || r.isEnabled === false) return false;
    if (!r.pattern) return false;
    // legado 的列默认值：scopeContent 默认 1、scopeTitle 默认 0
    const on = flag === "scopeContent" ? r.scopeContent !== false : r.scopeTitle === true;
    if (!on) return false;
    return ruleInScope(r, name, origin);
  });
  return list.slice().sort((a, b) => ruleOrder(a) - ruleOrder(b));
}

/**
 * 单条规则跑一遍 —— 严格对齐 legado RegexExtensions.kt。
 *
 * 返回 { text, changed }；正则编译失败 / 替换失败都只丢这一条（legado 同款行为）。
 * 超时单独抛 RegexTimeoutError，交给 applyRulesToText 禁用规则并落库。
 */
function runOneRule(text, r, ctx) {
  const c = ctx || {};
  return replaceWithRule({
    name: r.name,
    text,
    pattern: r.pattern,
    replacement: r.replacement,
    isRegex: r.isRegex !== false,
    timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000,
    chapter: c.chapter || null,
    book: c.book || null,
  });
}

/**
 * 逐条应用规则 —— 对齐 ContentProcessor.kt:163-186。
 * 只有输出和输入不同才记为 effective；超时按 legado 关掉该规则并落库。
 */
function applyRulesToText(text, rules, ctx) {
  let out = String(text == null ? "" : text);
  const effective = [];
  for (const r of rules) {
    if (isEmptyPattern(r.pattern)) continue;
    try {
      const next = runOneRule(out, r, ctx);
      if (next !== out) {
        effective.push(r);
        out = next;
      }
    } catch (e) {
      if (e instanceof RegexTimeoutError || (e && e.name === "RegexTimeoutError")) {
        // legado ContentProcessor.kt:181-184：超时 → item.isEnabled = false 并落库
        r.isEnabled = false;
        saveConfig();
        console.error(`[替换净化] ${e.message}，已自动禁用该规则`);
      } else {
        console.error(`替换净化: 规则 ${r.name}替换出错.`, (e && e.message) || e);
      }
    }
  }
  return { text: out, effective };
}

/**
 * 正文替换。opts.bookName / opts.origin 给定时按书源/书名范围过滤（legado ContentProcessor）。
 * 不传时退化为「所有启用的正文规则」——兼容旧调用方。
 * opts.returnMeta=true 时返回 { text, effective }，供调试/统计使用。
 */
function applyReplaceRules(text, opts) {
  const o = opts || {};
  const list = pickReplaceRules("content", o.bookName, o.origin);
  // legado ContentProcessor.kt:160：正文先逐行 trim 再替换
  const src = String(text == null ? "" : text).split("\n").map((l) => l.trim()).join("\n");
  const r = applyRulesToText(src, list, { book: o.book || null, chapter: o.chapter || null });
  return o.returnMeta === true ? r : r.text;
}

/** 标题替换。对齐 BookChapter.getDisplayTitle()：逐条替换，结果非空才采纳。 */
function applyTitleRules(title, bookName, origin, ctx) {
  let t = String(title == null ? "" : title).replace(/[\r\n]/g, "");
  for (const r of pickReplaceRules("title", bookName, origin)) {
    if (isEmptyPattern(r.pattern)) continue;
    try {
      const next = runOneRule(t, r, ctx);
      if (next.trim()) t = next;
    } catch (e) {
      console.error(`替换净化(标题): 规则 ${r.name}替换出错.`, (e && e.message) || e);
    }
  }
  return t;
}

/** 规则内容指纹：任一标题净化规则改变都会让本地目录标题缓存失效。 */
function titleRuleFingerprint(bookName, origin) {
  return pickReplaceRules("title", bookName, origin).map((r) => [
    r.id || "", r.name || "", r.pattern || "", r.replacement || "",
    r.isRegex === false ? "0" : "1", Number(r.timeout) || 0,
  ].join("\u0000")).join("\u0001");
}

/**
 * 批量标题净化：把整本书的标题一次性交给引擎，避免逐章调用 vm 的看门狗开销。
 *
 * 语义与 applyTitleRules 逐条跑完全一致：按规则顺序、结果非空才采纳；
 * 单条规则在该标题上出错时保留该规则执行前的文本（legado 同款）。
 */
function applyTitleRulesBatch(titles, bookName, origin) {
  const rules = pickReplaceRules("title", bookName, origin).filter((r) => !isEmptyPattern(r.pattern));
  let list = titles.map((t) => String(t == null ? "" : t).replace(/[\r\n]/g, ""));
  for (const r of rules) {
    let next;
    try {
      next = replaceManyWithRule({
        name: r.name,
        texts: list,
        pattern: r.pattern,
        replacement: r.replacement,
        isRegex: r.isRegex !== false,
        timeout: Number(r.timeoutMillisecond) > 0 ? Number(r.timeoutMillisecond) : 3000,
      });
    } catch (e) {
      if (e instanceof RegexTimeoutError || (e && e.name === "RegexTimeoutError")) {
        // legado BookChapter.getDisplayTitle：标题规则超时 → 禁用该规则
        r.isEnabled = false;
        saveConfig();
        console.error(`[替换净化] ${e.message}，已自动禁用该规则`);
        continue;
      }
      console.error(`替换净化(标题): 规则 ${r.name}替换出错.`, (e && e.message) || e);
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const v = next[i];
      if (v == null) continue; // 该标题上失败 → 保留原文（与逐条 catch 后不改 t 一致）
      if (String(v).trim()) list[i] = String(v);
    }
  }
  return list;
}

/** 本地 /api/book 的展示目录。大书有几千章，逐章跑 @js 规则会造成切换书籍明显卡顿。 */
function localDisplayChapters(absPath, book) {
  const bookName = book.title || "";
  const cacheKey = absPath + "\u0002" + (book.key || "") + "\u0002" + titleRuleFingerprint(bookName, LOCAL_ORIGIN);
  const cached = localTitleCache.get(cacheKey);
  if (cached) {
    localTitleCache.delete(cacheKey);
    localTitleCache.set(cacheKey, cached);
    return cached;
  }
  const raws = [];
  if (book.pre) raws.push(book.pre.title);
  book.chapters.forEach((c) => raws.push(c.label));
  const cleaned = applyTitleRulesBatch(raws, bookName, LOCAL_ORIGIN);
  let cursor = 0;
  const list = [];
  if (book.pre) list.push({ title: cleaned[cursor++] || book.pre.title, idx: -1, kind: "pre" });
  book.chapters.forEach((c, i) => list.push({
    title: cleaned[cursor++] || c.label, idx: i, noHead: !!c.noHead, volume: !!c.isVolume,
  }));
  localTitleCache.set(cacheKey, list);
  while (localTitleCache.size > 24) localTitleCache.delete(localTitleCache.keys().next().value);
  return list;
}

/**
 * 付费/广告章节预览识别。
 *
 * 松鹤阅读（QQ 阅读）这类源对未解锁章节会返回 HTTP 200 + 50 字左右、以 "..." 结尾的
 * 试读片段（原始 JSON 里带 Code=15 / "ads read is not supported"）。legado 对没有
 * payAction 的书源同样只能拿到这段预览，并不是替换净化把正文删掉了。
 *
 * 这里只在「正文很短 + 行数很少 + 结尾是省略号」时打标，前端据此提示用户换源，
 * 不影响正常短文、诗歌等短章节。
 */
function looksLikePayPreview(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || t.length > 400) return false;
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 3) return false;
  return /(?:\.{3,}|…{1,}|·{3,})\s*$/.test(t);
}
/* ============================ HTTP 基础 ============================ */

const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/i;

function acceptsGzip(res) {
  const encoding = String((res.req && res.req.headers["accept-encoding"]) || "");
  return /(?:^|,)\s*(?:x-)?gzip\s*(?:,|$)/i.test(encoding);
}

function send(res, code, data, type = "application/json; charset=utf-8", extraHeaders = {}) {
  const body = type.startsWith("application/json") ? JSON.stringify(data) : data;
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    ...extraHeaders,
  };
  let out = body === undefined ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  // 本机接口里目录 / 书架 JSON 和 online.js 都在几百 KB 级别，gzip 后
  // 明显减少浏览器等待时间。只在文本类型且压缩确实变小时启用。
  if (code === 200 && out.length > 1024 && COMPRESSIBLE_TYPE.test(type) && acceptsGzip(res)) {
    const gz = zlib.gzipSync(out, { level: zlib.constants.Z_BEST_SPEED });
    if (gz.length < out.length) {
      out = gz;
      headers["content-encoding"] = "gzip";
      headers.vary = "Accept-Encoding";
    }
  }
  headers["content-length"] = String(out.length);
  res.writeHead(code, headers);
  res.end(out);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return chunks;
}

/** 缓存目录体积/文件数；读不到的项按 0 处理，不影响页面。 */
async function dirStats(dir) {
  let bytes = 0, files = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await dirStats(p);
        bytes += sub.bytes; files += sub.files;
      } else if (e.isFile()) {
        try { const st = await fsp.stat(p); bytes += st.size; files += 1; } catch {}
      }
    }
  } catch {}
  return { bytes, files };
}

/**
 * 对应 legado 设置页「缓存管理」的信息来源：告诉用户数据实际落在哪里。
 * 登录态和 WebView profile 属于用户数据，不混进普通“阅读缓存”清理。
 */
async function cacheStorageInfo() {
  const defs = [
    { key: "content", label: "正文缓存", dir: CONTENT_DIR, keep: false },
    { key: "toc", label: "目录缓存", dir: TOC_DIR, keep: false },
    { key: "explore", label: "发现分类缓存", dir: EXPLORE_DIR, keep: false },
    { key: "webview", label: "登录 WebView 数据（含可清理缓存）", dir: WEBVIEW_DIR, keep: true },
  ];
  const items = [];
  for (const d of defs) {
    const s = await dirStats(d.dir);
    items.push({ key: d.key, label: d.label, path: d.dir, bytes: s.bytes, files: s.files, keep: d.keep });
  }
  // WebView 拆成「可清理的可再生缓存」与「必须保留的登录数据」两类。
  // 只清可再生部分时不会碰到 Cookies / Local Storage / IndexedDB，登录态不受影响。
  let webview = null;
  try {
    const wv = browserHost.cacheStats();
    webview = {
      dir: wv.dir,
      totalBytes: wv.totalBytes,
      clearable: wv.items,
      keep: wv.keep,
      keepBytes: wv.keep.reduce((a, x) => a + x.bytes, 0),
    };
  } catch (e) { webview = null; }
  let loginBytes = 0;
  try { loginBytes = (await fsp.stat(LOGIN_STATE_PATH)).size; } catch {}
  items.push({
    key: "loginState", label: "登录 Cookie / 登录信息", path: LOGIN_STATE_PATH,
    bytes: loginBytes, files: loginBytes ? 1 : 0, keep: true,
  });
  const root = await dirStats(CACHE_DIR);
  return {
    ok: true,
    root: CACHE_DIR,
    defaultDir: DEFAULT_CACHE_DIR,
    custom: path.resolve(CACHE_DIR) !== path.resolve(DEFAULT_CACHE_DIR),
    envLocked: CACHE_DIR_FROM_ENV,
    appRoot: __dirname,
    configPath: CONFIG_PATH,
    sourcePath: activeSourceGroupPath(),
    totalBytes: root.bytes,
    totalFiles: root.files,
    items,
    webview,
  };
}

/** 只打开固定缓存目录，不接受前端传入任意路径，避免变成目录穿越/任意程序调用入口。
 *  原来的 windowsHide:true 会让部分 Windows 环境里 explorer 进程被隐藏，表现为接口返回 ok 但没有窗口；
 *  这里改成不隐藏窗口，并在 explorer 启动失败时退回 cmd start。 */
function openCacheFolder() {
  const dir = CACHE_DIR;
  return new Promise((resolve, reject) => {
    const launch = (cmd, args, fallback) => {
      let done = false;
      const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
      p.once("error", (e) => {
        if (done) return;
        done = true;
        if (fallback) { try { fallback(); resolve(); } catch (e2) { reject(e2); } }
        else reject(e);
      });
      p.once("spawn", () => {
        if (done) return;
        done = true;
        p.unref();
        resolve();
      });
    };
    if (process.platform === "win32") {
      launch("explorer.exe", [dir], () => launch("cmd.exe", ["/c", "start", "", "/d", dir], null));
    } else if (process.platform === "darwin") {
      launch("open", [dir], null);
    } else {
      launch("xdg-open", [dir], null);
    }
  });
}

/**
 * 站内 HTML（java.showBrowser(url, html)）里跨域请求的代理。
 *
 * legado 的 BottomWebViewDialog 用 loadDataWithBaseURL(url, html, ...) 把文档 origin 设成书源地址，
 * 页面里的 fetch("/api/xxx") 与书源同源，走 WebView 网络栈直连并共享 CookieManager 的 Cookie。
 * 桌面端 iframe 的 origin 只能是阅读器自己，所以这里做等价代理：原样转发请求，自动补上该域名
 * 对应的 CookieStore Cookie（legado CookieStore 落库在 cache/login-state.json），回包原样透传。
 */
// LOGIN_STATE_PATH 由顶部统一数据目录常量声明，避免缓存根路径分散。
let cookieSnap = { mtime: 0, entries: [] };
function cookieHeaderFor(target) {
  try {
    const st = fs.statSync(LOGIN_STATE_PATH);
    if (st.mtimeMs !== cookieSnap.mtime) {
      const raw = JSON.parse(fs.readFileSync(LOGIN_STATE_PATH, "utf8"));
      cookieSnap = { mtime: st.mtimeMs, entries: Array.isArray(raw.cookie) ? raw.cookie : [] };
    }
  } catch { /* 没有登录态文件就当没有 Cookie */ }
  let host = "";
  try { host = new URL(target).hostname.toLowerCase(); } catch { return ""; }
  const parts = [];
  for (const row of cookieSnap.entries) {
    const d = String((row && row[0]) || "").toLowerCase();
    const c = (row && row[1]) || "";
    if (d && c && (host === d || host.endsWith("." + d))) parts.push(c);
  }
  return parts.join("; ");
}
const PROXY_REQ_HEADERS = ["accept", "content-type", "x-requested-with", "range", "accept-language"];
const PROXY_UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36";
function isProxyTargetAllowed(target) {
  let h = "";
  try { h = new URL(target).hostname.toLowerCase(); } catch { return false; }
  return !(h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2"
};

/**
 * srcdoc 中的书源页面会通过 CSS 的相对 url() 引用图标字体、背景图等资源。
 * CSS 如果直接从远端加载，字体请求会失去桌面端代理的 Cookie/Referer；
 * CSS 如果从本地代理加载，相对路径又会错误地落到 Reader 本身。
 * 因此只对代理返回的 CSS 做一次资源地址重写，让每个资源继续经过同一个代理。
 */
function rewriteProxyCssUrls(css, baseUrl) {
  return String(css || "").replace(/url\(\s*(['"]?)([^'" )]+)\1\s*\)/gi, (all, quote, raw) => {
    const ref = String(raw || "").trim();
    if (!ref || /^(?:data:|blob:|about:|#)/i.test(ref)) return all;
    let abs = "";
    try { abs = new URL(ref, baseUrl).href; } catch { return all; }
    if (!/^https?:/i.test(abs) || !isProxyTargetAllowed(abs)) return all;
    return "url(\"/api/online/proxy?url=" + encodeURIComponent(abs) + "\")";
  });
}

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch { return send(res, 403, { error: "禁止" }); }
  if (rel === "/" || rel === "") rel = "/index.html";
  // exe（SEA）模式：前端资源打包进 exe，磁盘上没有 public/ 目录
  if (IS_SEA) {
    const name = String(rel).replace(/^\/+/, "");
    const buf = readAsset(name);
    if (!buf) return send(res, 404, { error: "未找到" });
    const mime = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
    // 内容随 exe 固定，用内容长度做 ETag 即可；避免每请求都算哈希
    return send(res, 200, buf, mime, { ETag: `W/"sea-${buf.length}"`, "cache-control": "no-cache" });
  }
  const abs = path.join(PUBLIC_DIR, rel);
  const relFromPublic = path.relative(PUBLIC_DIR, abs);
  const insidePublic = relFromPublic !== "" && relFromPublic !== ".."
    && !relFromPublic.startsWith(`..${path.sep}`) && !path.isAbsolute(relFromPublic);
  if (!insidePublic) return send(res, 403, { error: "禁止" });
  try {
    const st = await fsp.stat(abs);
    const etag = `W/"${st.size.toString(16)}-${String(st.mtimeMs)}"`;
    const req = res.req;
    const ifNoneMatch = req ? String(req.headers["if-none-match"] || "") : "";
    if (ifNoneMatch.split(",").map((s) => s.trim()).includes(etag)) {
      res.writeHead(304, { ETag: etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    const buf = await fsp.readFile(abs);
    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", {
      ETag: etag,
      "cache-control": "no-cache",
    });
  } catch {
    send(res, 404, { error: "未找到" });
  }
}

/* ============================ 在线内容缓存 ============================ */
// 目录页一次要抓几百章，没必要每次打开书都重来。

// TOC_DIR 由顶部统一数据目录常量声明并已创建。
const tocMem = new Map();          // key -> chapters
const TOC_TTL = 6 * 60 * 60 * 1000;
const TOC_MEM_MAX = 200;           // 目录内存缓存上限（本）
const CONTENT_MEM_MAX = 500;       // 正文章节内存缓存上限（章）

/** Map 简易 LRU：读命中时把条目移到末尾（最近用），超上限时淘汰最前面的（最久未用） */
function lruTouch(map, key) {
  const v = map.get(key);
  if (v === undefined) return undefined;
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, val, max) {
  map.set(key, val);
  while (map.size > max) map.delete(map.keys().next().value);
}

function tocFile(origin, bookUrl) {
  const h = crypto.createHash("md5").update(okey(origin, bookUrl)).digest("hex");
  return path.join(TOC_DIR, h + ".json");
}

function readTocCache(origin, bookUrl) {
  const k = okey(origin, bookUrl);
  const hit = lruTouch(tocMem, k);
  if (hit && Date.now() - hit.at < TOC_TTL) return hit.chapters;
  try {
    const j = JSON.parse(fs.readFileSync(tocFile(origin, bookUrl), "utf8"));
    if (j && Array.isArray(j.chapters) && Date.now() - (j.at || 0) < TOC_TTL) {
      lruSet(tocMem, k, j, TOC_MEM_MAX);
      return j.chapters;
    }
  } catch {}
  return null;
}

function writeTocCache(origin, bookUrl, chapters) {
  const rec = { at: Date.now(), chapters };
  lruSet(tocMem, okey(origin, bookUrl), rec, TOC_MEM_MAX);
  fs.promises.writeFile(tocFile(origin, bookUrl), JSON.stringify(rec), "utf8").catch(() => {});
}

function dropTocCache(origin, bookUrl) {
  tocMem.delete(okey(origin, bookUrl));
  fs.promises.rm(tocFile(origin, bookUrl), { force: true }).catch(() => {});
}

/* ---- 正文缓存（legado BookChapter.content 的桌面持久化等价物） ----
 * legado 每章抓到的正文会写进 BookChapter 表，换书、换页面、甚至重启后仍直接读缓存；
 * refresh 时才重新回源。以前这里只有每个 worker 一份的 Map，多 worker 轮询就会重复抓，
 * 源站挂掉后也读不回已经看过的章节。现在按「书源 + 书籍 + 章节索引 + 章节URL」落盘，
 * 由主进程统一读写，和 toc 缓存一样跨 worker、跨重启共享。 */
// CONTENT_DIR 由顶部统一数据目录常量声明并已创建。
const contentMem = new Map();       // cacheKey -> { content, at, title, url, index }
// 同一章的抓取请求只允许一个在飞。启动预热和用户首次打开可能同时发生，
// 没有这层去重会造成同一章打两次源站，反而更慢。
const contentInflight = new Map();  // cacheKey -> Promise

function contentBookHash(origin, bookUrl) {
  return crypto.createHash("md5").update(okey(origin, bookUrl)).digest("hex");
}
function contentChapterHash(chapter, index) {
  return crypto.createHash("md5")
    .update(String(index) + "|" + String((chapter && chapter.url) || ""))
    .digest("hex");
}
function contentCacheKey(origin, bookUrl, chapter, index) {
  return contentBookHash(origin, bookUrl) + "|" + contentChapterHash(chapter, index);
}
function contentFile(origin, bookUrl, chapter, index) {
  return path.join(CONTENT_DIR, contentBookHash(origin, bookUrl) + "-" + contentChapterHash(chapter, index) + ".json");
}
function readContentCache(origin, bookUrl, chapter, index) {
  const k = contentCacheKey(origin, bookUrl, chapter, index);
  const hit = lruTouch(contentMem, k);
  if (hit) return hit;
  try {
    const j = JSON.parse(fs.readFileSync(contentFile(origin, bookUrl, chapter, index), "utf8"));
    if (j && typeof j.content === "string") {
      const rec = { content: j.content, at: j.at || 0, title: j.title || "", url: j.url || "", index: Number(j.index) || 0 };
      lruSet(contentMem, k, rec, CONTENT_MEM_MAX);
      return rec;
    }
  } catch {}
  return null;
}
function writeContentCache(origin, bookUrl, chapter, index, content, title) {
  if (typeof content !== "string" || !content.length) return;
  const rec = { at: Date.now(), title: title || "", url: (chapter && chapter.url) || "", index: Number(index) || 0, content };
  lruSet(contentMem, contentCacheKey(origin, bookUrl, chapter, index), rec, CONTENT_MEM_MAX);
  fs.promises.writeFile(contentFile(origin, bookUrl, chapter, index), JSON.stringify(rec), "utf8").catch(() => {});
}
function dropContentCache(origin, bookUrl) {
  const prefix = contentBookHash(origin, bookUrl) + "|";
  for (const k of [...contentMem.keys()]) if (k.startsWith(prefix)) contentMem.delete(k);
  const filePrefix = contentBookHash(origin, bookUrl) + "-";
  fs.promises.readdir(CONTENT_DIR).then((names) => Promise.all(
    names.filter((n) => n.startsWith(filePrefix)).map((n) => fs.promises.rm(path.join(CONTENT_DIR, n), { force: true })),
  )).catch(() => {});
}
function clearContentCache() {
  contentMem.clear();
  return fs.promises.rm(CONTENT_DIR, { recursive: true, force: true })
    .then(() => fs.promises.mkdir(CONTENT_DIR, { recursive: true }))
    .catch(() => {});
}
/**
 * 正文读取入口：先读持久缓存，未命中再调度 worker。
 * refresh=1 与 legado 阅读菜单「刷新」一致，强制回源并覆盖缓存。
 */
async function fetchContentCached(origin, bookUrl, book, chapter, nextChapterUrl, refresh, timeout) {
  const index = Number(chapter && chapter.index) || 0;
  const cacheKey = contentCacheKey(origin, bookUrl, chapter, index);
  if (!refresh) {
    const hit = readContentCache(origin, bookUrl, chapter, index);
    if (hit) return { content: hit.content, title: hit.title || chapter.title || "", cached: true };
    const pending = contentInflight.get(cacheKey);
    if (pending) return pending;
  }
  const job = (async () => {
    const r = await getPool().request("content", {
      sourceUrl: origin, book, chapter, nextChapterUrl: nextChapterUrl || null,
      refresh: !!refresh, needSave: true,
    }, { timeout: Number(timeout) || 120000 });
    const content = (r.result && r.result.content) || "";
    const title = (r.result && r.result.title) || chapter.title || "";
    writeContentCache(origin, bookUrl, chapter, index, content, title);
    return { content, title, cached: !!(r.result && r.result.cached) };
  })();
  if (!refresh) contentInflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    if (contentInflight.get(cacheKey) === job) contentInflight.delete(cacheKey);
  }
}

/** 预热一章节。返回 cached 用于判断这次有没有真的回源。 */
async function warmOnlineContent(book, index) {
  const qs = new URLSearchParams({
    origin: book.origin,
    url: book.bookUrl,
    index: String(index),
    timeout: "30000",
  });
  // 用 activePort 而不是 PORT：PORT 可能是 0（系统分配），真实端口在 listen 后才知道
  const r = await fetch(`http://127.0.0.1:${activePort}/api/online/content?${qs}`, {
    signal: AbortSignal.timeout(35000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) return { ok: false, cached: false };
  return { ok: true, cached: !!j.cached };
}

/**
 * 是否跳过后台预热。
 *
 * noExport 只表示“整本导出会触发风控”，不能拿它当预热开关：启动 / 清缓存后的
 * 预热只抓“当前章 + 下一章”，和用户正常翻一章的请求量相同。真正不适合预热的
 * 站点使用 noPrewarm 显式标记。
 */
function shouldSkipBackgroundWarm(book) {
  const source = sourceMap.get(book && book.origin);
  return !source || source.noPrewarm === true;
}

/**
 * 是否跳过「书架全量预热」。
 *
 * 与 shouldSkipBackgroundWarm 的区别：后者连「最近阅读」也不预热；
 * 这里只把书从「书架里每本都抓几章」的批量名单里剔除，仍允许最近阅读那本预热。
 *
 * 为什么需要：速读谷² 一章要串行抓 4 个分页，书架 4 本速读谷书按「上下各 1 章」
 * 预热也要 4×3×4=48 次请求，实测足以触发站点风控（302 跳 google）。
 * 用户没主动打开的书，不该由后台批量请求。
 */
function shouldSkipShelfWarm(book) {
  const source = sourceMap.get(book && book.origin);
  return !source || source.noPrewarm === true || source.noShelfWarm === true;
}

/**
 * 启动预热最近阅读的书。
 *
 * 为什么要做：正文持久缓存已经跨重启保留，但重启后内存缓存为空；如果当前章
 * 恰好还没落过盘，首次打开仍要完整走一次源站请求（速读谷²实测约 1~3 秒）。
 * 服务启动后立刻在后台预热「当前章前后各 WARM_RADIUS 章」，前端恢复时大概率直接命中。
 *
 * 注意：这里通过本机 HTTP 接口走，而不是直接调用请求处理函数，保证预热和
 * 用户请求走完全相同的目录修复、登录、净化与缓存语义。
 */
/**
 * 预热/预取的半径：当前章前后各几章。
 *
 * 取 1 的理由：速读谷² 这类源一章要串行抓 4 个分页（约 1.4s），
 * 且站点对请求量极敏感 —— 前后各 2 章（5 章/本 × 17 本）连续预热会被封 IP。
 * 收到「上下各一章」后每本只预热 3 章，是兼顾预取效果与风控的最小窗口。
 * 前端 PREFETCH_RADIUS 与本值保持一致。
 */
const WARM_RADIUS = 1;

async function warmRecentOnlineReading() {
  const books = Array.isArray(config.online && config.online.books) ? config.online.books : [];
  const progress = (config.online && config.online.progress) || {};
  const recent = Object.entries(progress)
    .map(([rel, p]) => {
      const book = books.find((b) => okey(b.origin, b.bookUrl) === rel);
      return book ? { book, progress: p || {} } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (Number(b.progress.at) || 0) - (Number(a.progress.at) || 0))[0];
  if (!recent || !recent.book || shouldSkipBackgroundWarm(recent.book)) return false;

  const { book, progress: recentProgress } = recent;
  const start = Math.max(0, Number(recentProgress.chapter) || 0);
  const knownTotal = Number(book.totalChapterNum) || 0;
  // 当前章前后各 WARM_RADIUS 章（共 2*R+1 章），先往后再往前。
  // 与前端预取窗口保持一致。
  const order = [];
  for (let step = 1; step <= WARM_RADIUS; step++) {
    const after = start + step;
    if (knownTotal > 0 ? after < knownTotal : true) order.push(after);
  }
  order.push(start);
  for (let step = 1; step <= WARM_RADIUS; step++) {
    const before = start - step;
    if (before >= 0) order.push(before);
  }
  for (const i of order) {
    const r = await warmOnlineContent(book, i);
    if (!r.ok) break;
  }
  return true;
}

/**
 * 启动后台预热书架里的书。
 *
 * 目标是让「切到书架里任意一本」时，当前章前后几章尽量直接命中缓存。
 * 只预热当前章前后各 WARM_RADIUS 章，不整本抓取，避免启动后把源站和网络打满。
 * 顺序按最近阅读时间排，最近的书优先；已缓存章节通过本地 HTTP 直接命中持久缓存。
 */
async function warmOnlineShelfBooks() {
  const books = Array.isArray(config.online && config.online.books) ? config.online.books : [];
  const progress = (config.online && config.online.progress) || {};
  const rows = books
    .filter((b) => b && !shouldSkipShelfWarm(b))
    .map((b) => ({ book: b, progress: progress[okey(b.origin, b.bookUrl)] || {} }))
    .sort((a, b) => (Number(b.progress.at) || 0) - (Number(a.progress.at) || 0));

  let done = 0;
  for (const { book, progress: p } of rows) {
    const start = Math.max(0, Number(p.chapter) || 0);
    const knownTotal = Number(book.totalChapterNum) || 0;
    // 当前章前后各 WARM_RADIUS 章（先往后再往前），与最近阅读预热保持一致。
    // 用局部函数拼顺序，避免和 warmRecentOnlineReading 里的同名逻辑各写一份。
    const order = [];
    for (let step = 1; step <= WARM_RADIUS; step++) {
      const after = start + step;
      if (knownTotal > 0 ? after < knownTotal : true) order.push(after);
    }
    order.push(start);
    for (let step = 1; step <= WARM_RADIUS; step++) {
      const before = start - step;
      if (before >= 0) order.push(before);
    }
    let fetched = false;
    for (const i of order) {
      const r = await warmOnlineContent(book, i);
      if (!r.ok) break;
      if (!r.cached) fetched = true;
    }
    done++;
    // 只有真的回源过才稍微歇一下；全部命中本地缓存时不需要额外等待。
    if (fetched) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (rows.length) console.log(`书架正文预热完成：${done}/${rows.length} 本`);
}

/* ============================ legado API 兼容层 ============================ */
// legado api.md 兼容端点（裸路径 + /api/legado/ 前缀），逻辑全部在 src/legado-api.mjs。
// 这里只把 server.mjs 现成的函数/状态通过 ctx 注入，避免重复实现抓取与缓存。
let legadoApi = null;
function makeLegadoCtx() {
  return {
    getConfig: () => config,
    saveConfig,
    getSources: () => sources,
    setSources: (list) => {
      sources = Array.isArray(list) ? list : [];
      sourceMap.clear();
      for (const s of sources) sourceMap.set(sourceKey(s), s);
    },
    getSKey,
    normalizeSource,
    parseSourceImport,
    exportSources,
    persistSources,
    refreshPool: () => getPool(),
    getPool,
    enabledSources,
    getSourceByUrl: (url) => sourceMap.get(String(url || "")) || null,
    findOnlineBook,
    okey,
    ensureBookInfo,
    readTocCache,
    writeTocCache,
    dropTocCache,
    applyReplaceRules,
  };
}
function getLegadoApi() {
  if (!legadoApi) legadoApi = createLegadoApi(makeLegadoCtx());
  return legadoApi;
}
/**
 * 换源。语义照 legado：
 *   ChangeBookSourceDialog.changeSource()（ChangeBookSourceDialog.kt:388-414）
 *     → 先 viewModel.getToc(newBook) 抓新源目录，拿不到目录就不换；
 *   ReadBookViewModel.changeTo()（ReadBookViewModel.kt:285-303）
 *     → book.migrateTo(newBook, toc) → oldBook.delete() → insert(newBook) → loadContent();
 *   Book.migrateTo()（Book.kt:407-427）
 *     → BookHelp.getDurChapter(durChapterIndex, durChapterTitle, toc, totalChapterNum) 映射章号，
 *       并把 durChapterPos / group / order 搬过去。
 * 我们的等价物：config.online.books 是 books 表，config.online.progress 是 durChapterIndex/Pos。
 * 关键点：必须「删旧书 + 插新书」，否则同一本书会留两条记录，
 * 前端 openBook 仍然按旧的 origin/bookUrl 抓正文 —— 这就是「换源之后还没变」的原因。
 * @returns {Promise<{status:number, data:object}>} HTTP 状态 + 响应体
 */
async function doChangeSource(body) {
    const nb = body.newBook && typeof body.newBook === "object" ? body.newBook : body;
    const newOrigin = String(nb.origin || "");
    const newBookUrl = normalizeBookUrl(nb.bookUrl || "");
    if (!newOrigin || !newBookUrl) return { status: 400, data: { error: "缺少新书的书源或链接" } };
    const s0 = sourceMap.get(newOrigin);
    if (!s0) return { status: 404, data: { error: "书源不存在，可能已被删除" } };

    const oldOrigin = String(body.oldOrigin || "");
    const oldBookUrl = normalizeBookUrl(body.oldBookUrl || "");
    // 旧书查找：先按 origin+bookUrl 精确命中（legado 的 Book 主键是 bookUrl）。
    // 兜底 1：启动时的 repairOnlineBookOrigin() 可能已经把书架里那条的 origin 改写成
    //         另一个同域书源，而前端 meta 还是改写前的 origin → 精确查找落空。
    // 兜底 2：按「书名 + 作者」找 —— 与 /api/online/shelf/add 的去重判据一致。
    // 没有这两层兜底时，换源会「删不掉旧记录 + 插一条新记录」，书架就留下同名两条，
    // 其中旧的那条 tocUrl 往往是坏的（目录模板变量没替换成功），正文打开即「目录为空」。
    const oldName = String(body.oldName || nb.name || "");
    const oldAuthor = String(body.oldAuthor || nb.author || "");
    const oldMatches = (x) => {
      if (findOnlineBook(oldOrigin, oldBookUrl) === x) return true;      // 精确命中
      if (oldBookUrl && normalizeBookUrl(x.bookUrl) === oldBookUrl) return true;
      if (oldName && sameBookMeta(x, { name: oldName, author: oldAuthor })) return true;
      return false;
    };
    const oldDupes = config.online.books.filter(oldMatches);
    const old = oldDupes[0] || null;
    const timeout = Number(body.timeout) || config.online.searchTimeout || 60000;

    // ---- 1) 新源详情 + 目录（legado getToc：tocUrl 空则先 getBookInfoAwait）----
    let book = null;
    try {
      book = await ensureBookInfo(newOrigin, newBookUrl, {
        timeout,
        // 搜索结果就是 legado SearchBook.toBook() 的产物，书名/作者作为兜底传进规则引擎
        seed: { name: nb.name || "", author: nb.author || "" },
      });
    } catch (e) {
      return { status: 200, data: { ok: false, error: "新书源抓取详情失败：" + e.message, code: e.code } };
    }
    // 搜索结果里比详情页更全的字段补上（legado 里 Book 由 SearchBook 转换而来，这些字段一直都在）
    for (const k of ["name", "author", "kind", "coverUrl", "intro", "latestChapterTitle", "wordCount"]) {
      if (nb[k] && !book[k]) book[k] = nb[k];
    }
    if (nb.variable && !book.variable) book.variable = nb.variable;

    let chapters = readTocCache(newOrigin, newBookUrl);
    if (!chapters || !chapters.length) {
      try {
        const r = await getPool().request("chapters", {
          sourceUrl: newOrigin, book, runPerJs: false, isFromBookInfo: false,
        }, { timeout: Number(body.timeout) || 150000 });
        chapters = r.result.chapters || [];
        if (r.result.book) {
          if (r.result.book.variable) book.variable = r.result.book.variable;
          if (r.result.book.tocUrl) book.tocUrl = r.result.book.tocUrl;
        }
      } catch (e) {
        return { status: 200, data: { ok: false, error: "新书源抓取目录失败：" + e.message, code: e.code, data: e.data || null } };
      }
    }
    if (!chapters.length) return { status: 200, data: { ok: false, error: "新书源没有解析到章节，未换源" } };
    writeTocCache(newOrigin, newBookUrl, chapters);

    // ---- 2) 进度映射（legado Book.migrateTo → BookHelp.getDurChapter）----
    const oldKey = okey(oldOrigin, oldBookUrl);
    const oldP = oldOrigin && oldBookUrl ? (config.online.progress[oldKey] || null) : null;
    const oldToc = oldOrigin && oldBookUrl ? (readTocCache(oldOrigin, oldBookUrl) || []) : [];
    const oldIdx = Number(body.oldChapterIndex != null ? body.oldChapterIndex : (oldP ? oldP.chapter : 0)) || 0;
    const oldTotal = Number(body.oldTotalChapterNum || (old && old.totalChapterNum) || (oldP && oldP.total) || oldToc.length) || 0;
    const oldTitle = String(body.oldChapterTitle || (old && old.durChapterTitle) || (oldToc[oldIdx] && oldToc[oldIdx].title) || "");
    const idx = Math.min(Math.max(0, getDurChapter(oldIdx, oldTitle, chapters, oldTotal)), chapters.length - 1);
    const newTitle = (chapters[idx] && chapters[idx].title) || "";

    // ---- 3) 删旧书 + 插新书（legado changeTo：migrateTo → delete → insert）----
    // 同名同作者的残留一并清掉：换源后 bookUrl 变了，旧记录会变成孤儿，
    // 而 /api/online/shelf/add 是按「书名+作者」去重的，孤儿记录一旦信息更全
    // 就会被选中打开 —— 所以换源必须把这一组全部收敛成一条新记录。
    for (const x of oldDupes) {
      const xk = okey(x.origin, x.bookUrl);
      if (xk !== oldKey) delete config.online.progress[xk];
      dropTocCache(x.origin, x.bookUrl);
      dropContentCache(x.origin, x.bookUrl);
    }
    config.online.books = config.online.books.filter((x) => !oldDupes.includes(x));
    // 旧 key 的进度已在上面搬到 newKey（oldP），这里只清残留
    if (oldKey !== "|") delete config.online.progress[oldKey];
    const item = {
      name: String(book.name || nb.name || (old && old.name) || ""),
      author: String(book.author || nb.author || (old && old.author) || ""),
      bookUrl: newBookUrl, tocUrl: String(book.tocUrl || ""),
      origin: newOrigin, originName: String(s0.bookSourceName || nb.originName || ""),
      kind: book.kind || null, coverUrl: book.coverUrl || null, intro: book.intro || null,
      latestChapterTitle: book.latestChapterTitle || newTitle || null,
      type: book.type || 8, wordCount: book.wordCount || null,
      // migrateTo 搬过来的字段：分组、书架里的位置（我们按加入时间排序，等价于 legado 的 order）
      group: (old && old.group) || 0,
      order: old && Number.isFinite(Number(old.order)) ? Number(old.order) : Date.now(),
      addedAt: (old && old.addedAt) || Date.now(),
      canUpdate: old ? old.canUpdate !== false : true,
      lastCheckCount: 0,
      variable: book.variable || null,
      totalChapterNum: chapters.length, durChapterTitle: newTitle,
    };
    const newKey = okey(newOrigin, newBookUrl);
    // 换到同一个源（重复点）时先清掉自身，避免留两条记录
    config.online.books = config.online.books.filter((x) => okey(x.origin, x.bookUrl) !== newKey);
    config.online.books.push(item);
    config.online.progress[newKey] = {
      chapter: idx,
      scroll: (oldP && Number(oldP.scroll)) || 0,   // legado：newBook.durChapterPos = durChapterPos
      total: chapters.length,
      at: Date.now(),
    };
    saveConfig();
    console.log(`换源：《${item.name}》${oldOrigin ? (old && old.originName) || oldOrigin : "（未入架）"} → ${item.originName}，第 ${idx + 1} 章 ${newTitle}`);
    return { status: 200, data: {
      ok: true, book: item, chapter: idx, chapterTitle: newTitle,
      chapters: chapters.length, oldChapterIndex: oldIdx, oldChapterTitle: oldTitle,
    } };
}

/**
 * 精确搜索 + 一次退避重试。
 * 语义仍是 legado WebBook.preciseSearchAwait（name 全等 + author 全等，命中即 break），
 * 只是把「站点偶发返回空列表」这种可重试失败多跑一次。
 * @returns {{book?:object, error?:Error, retried?:boolean}}
 */
async function preciseSearchWithRetry(sourceUrl, name, author, tries = 2) {
  let lastErr = null, retried = false;
  for (let i = 0; i < Math.max(1, tries); i++) {
    if (i > 0) {
      retried = true;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
    try {
      const r = await getPool().request("preciseSearch", { sourceUrl, name, author },
        { timeout: config.online.searchTimeout || 60000 });
      const book = (r.result && r.result.book) || null;
      if (book && book.bookUrl) return { book, retried };
      lastErr = new Error("未搜索到 " + name + "(" + author + ") 书籍");
    } catch (e) { lastErr = e; }
  }
  return { error: lastErr || new Error("搜索失败"), retried };
}

/**
 * 书架批量换源 —— 照 legado BookshelfManageViewModel.changeSource(books, source)
 * （ui/book/manage/BookshelfManageViewModel.kt:86-122）：
 *
 *   val changeSourceDelay = AppConfig.batchChangeSourceDelay * 1000L
 *   books.forEachIndexed { index, book ->
 *     batchChangeSourceProcessLiveData.postValue("index+1 / size")   // 进度文案
 *     if (book.isLocal) return                                       // 本地书跳过
 *     if (book.origin == source.bookSourceUrl) return                // 同源跳过
 *     val newBook = WebBook.preciseSearchAwait(source, name, author) // 书名 + 作者精确搜索
 *     if (newBook.tocUrl.isEmpty()) WebBook.getBookInfoAwait(source, newBook)
 *     WebBook.getChapterListAwait(source, newBook).getOrNull()?.let { toc ->
 *       book.migrateTo(newBook, toc)                                 // 搬阅读进度
 *       appDb.bookDao.insert(newBook)                                // 替换旧记录
 *     }
 *     delay(changeSourceDelay)                                       // 每本之间节流
 *   }
 *
 * 入口是 SourcePickerDialog：只列 flowEnabled() 的启用源，Toolbar 上可调 batchChangeSourceDelay
 * （BookshelfManageActivity.kt:332 / :466-468 是菜单「换源」→ 选源 → changeSource）。
 *
 * 我们的差异点（用户要求）：入口是「书架所有书」一键换源，所以 books 缺省 = 全部在线书。
 * 串行执行（照 legado，站点风控下并发换源极易被 ban），每本的结果用 NDJSON 实时推给前端。
 *
 * @param {object} body { source: 目标书源 url, delay?: 毫秒, books?: [{origin,bookUrl}] }
 * @param {(o:object)=>void} write NDJSON 写出一行
 */
async function doChangeAllSource(body, write) {
  const targetKey = String(body.source || "");
  const s0 = sourceMap.get(targetKey);
  if (!s0) return { ok: false, error: "书源不存在，可能已被删除", total: 0, changed: 0, failed: 0 };
  // legado 的 batchChangeSourceDelay 单位是秒（AppConfig.kt:530-534），前端传毫秒
  const delayMs = Math.max(0, Math.min(60000, Math.trunc(Number(body.delay) || 0)));
  // books 缺省 = 书架全部在线书（legado 是「选中若干本」，用户要的是「所有书」）
  let list = config.online.books.slice();
  if (Array.isArray(body.books) && body.books.length) {
    const keys = new Set(body.books.map((x) => okey(x.origin, x.bookUrl)));
    list = list.filter((b) => keys.has(okey(b.origin, b.bookUrl)));
  }
  const total = list.length;
  write({ type: "start", total, source: targetKey, sourceName: s0.bookSourceName });

  let changed = 0, failed = 0, skipped = 0, notfound = 0;
  for (let i = 0; i < total; i++) {
    const b = list[i];
    // legado: batchChangeSourceProcessLiveData.postValue("index+1 / size")
    write({ type: "book", index: i + 1, total, name: b.name, author: b.author, originName: b.originName || b.origin, state: "working" });

    // legado: if (book.origin == source.bookSourceUrl) return@forEachIndexed
    if (b.origin === targetKey) {
      skipped++;
      write({ type: "book", index: i + 1, total, name: b.name, state: "skip", note: "已经是该书源" });
      if (delayMs && i + 1 < total) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    // 旧进度（legado migrateTo 要用的 durChapterIndex / durChapterTitle / totalChapterNum）
    const p0 = config.online.progress[okey(b.origin, b.bookUrl)] || null;
    const oldToc = readTocCache(b.origin, b.bookUrl) || [];
    const oldIdx = p0 ? Number(p0.chapter) || 0 : 0;
    const oldTitle = String(b.durChapterTitle || (oldToc[oldIdx] && oldToc[oldIdx].title) || "");
    const oldTotal = Number(b.totalChapterNum) || oldToc.length || 0;

    // legado: WebBook.preciseSearchAwait(source, book.name, book.author)
    // 差异说明：部分站点（如顶点）同一关键词偶发返回不含目标书的页面（站点侧限流/慢查询），
    // legado 一次失败就跳过；批量换源里全量重跑成本高，这里给一次退避重试兜底。
    const ps = await preciseSearchWithRetry(targetKey, b.name, b.author, 2);
    if (ps.error) {
      // 用户要求：目标书源里根本没有这本书时，绝不换源 —— 只报「未找到」，不算失败。
      // legado WebBook.preciseSearchAwait 搜不到就是抛异常跳过（BookshelfManageViewModel
      // 里 forEachIndexed 的 getOrNull()?.let{} 直接不执行换源），这里对齐成独立状态，
      // 好统计也好让用户在结束弹窗里一眼看出哪些书在目标源没有。
      const msg = String((ps.error && ps.error.message) || ps.error || "搜索失败");
      if (/^未搜索到/.test(msg)) {
        notfound++;
        write({ type: "book", index: i + 1, total, name: b.name, author: b.author,
          state: "notfound", note: "目标书源没有这本书，保持原书源不变" });
      } else {
        failed++;
        write({ type: "book", index: i + 1, total, name: b.name, state: "fail",
          error: ps.retried ? ("搜索出错（已重试）：" + msg) : ("搜索出错：" + msg) });
      }
      if (delayMs && i + 1 < total) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const hit = ps.book;

    // legado: getBookInfoAwait + getChapterListAwait + migrateTo + insert —— doChangeSource 已完整实现
    const r2 = await doChangeSource({
      oldOrigin: b.origin, oldBookUrl: b.bookUrl,
      oldChapterIndex: oldIdx, oldChapterTitle: oldTitle, oldTotalChapterNum: oldTotal,
      newBook: {
        origin: targetKey, bookUrl: hit.bookUrl, originName: s0.bookSourceName,
        name: hit.name || b.name, author: hit.author || b.author,
        kind: hit.kind, coverUrl: hit.coverUrl, intro: hit.intro,
        latestChapterTitle: hit.latestChapterTitle, wordCount: hit.wordCount,
        variable: hit.variable, tocUrl: hit.tocUrl,
      },
    });
    if (r2.status === 200 && r2.data && r2.data.ok) {
      changed++;
      write({
        type: "book", index: i + 1, total, name: b.name, state: "ok",
        newOriginName: r2.data.book && r2.data.book.originName,
        chapter: r2.data.chapter, chapterTitle: r2.data.chapterTitle, chapters: r2.data.chapters,
      });
    } else {
      failed++;
      write({ type: "book", index: i + 1, total, name: b.name, state: "fail", error: (r2.data && r2.data.error) || "换源失败" });
    }
    if (delayMs && i + 1 < total) await new Promise((r) => setTimeout(r, delayMs));
  }
  const done = { type: "done", ok: true, total, changed, failed, skipped, notfound, source: targetKey, sourceName: s0.bookSourceName };
  write(done);
  console.log("批量换源 → " + s0.bookSourceName + "：共 " + total + " 本，成功 " + changed + "，未找到 " + notfound + "，失败 " + failed + "，跳过 " + skipped);
  return done;
}

/* ============================ 路由 ============================ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  // legado 兼容端点优先（在浏览器同源前端接口之前，路径不重叠）
  try {
    if (await getLegadoApi().tryHandle(req, res, u)) return;
  } catch (e) {
    return send(res, 500, { isSuccess: false, errorMsg: e.message, data: null });
  }

  try {
    /* ---------------- 通用状态 ---------------- */

    if (p === "/api/state") {
      return send(res, 200, {
        shelves: config.shelves,
        settings: config.settings,
        progress: config.progress,
        fonts: config.fonts,
        // 运行模式：前端据此决定是否显示「退出程序」按钮
        // （exe 是双击运行的，用户需要一个界面上的关闭入口；源码模式关终端即可）
        runtime: {
          sea: IS_SEA,
          port: activePort,
          dataDir: __dirname,
          pid: process.pid,
        },
        online: {
          bookCount: config.online.books.length,
          sourceCount: sources.length,
          enabledCount: enabledSources().length,
          groups: groupNames(),
        }
      });
    }

    if (p === "/api/settings" && req.method === "POST") {
      const { settings } = await readBody(req);
      if (settings && typeof settings === "object") {
        config.settings = { ...config.settings, ...settings };
        saveConfig();
      }
      return send(res, 200, { ok: true, settings: config.settings });
    }

    /* ---------------- 本地书架 ---------------- */

    if (p === "/api/books") {
      const index = Number(u.searchParams.get("shelf"));
      const root = shelfRoot(index);
      // 快照命中时先回上次结果（stale），后台重扫；前端据此决定要不要再拉一次
      const { books, stale } = await listBooksWithMeta(root);
      const s = config.shelves[index];
      if (!stale && s && s.count !== books.length) { s.count = books.length; saveConfig(); }
      return send(res, 200, { shelf: config.shelves[index]?.name || "", root, books, stale });
    }

    if (p === "/api/book") {
      const index = Number(u.searchParams.get("shelf"));
      const rel = u.searchParams.get("rel");
      const abs = safeJoin(shelfRoot(index), rel);
      const book = parseBook(abs);
      // 与 legado LocalBook.getChapterList（BookChapter.getDisplayTitle）对齐：
      // 本地书目录标题同样套用 scopeTitle 替换规则；规则结果按书/规则指纹缓存。
      const list = localDisplayChapters(abs, book);
      return send(res, 200, {
        title: book.title, author: book.author, size: book.size, encoding: book.encoding,
        chapterCount: book.chapters.length, chapters: list, tocRule: book.tocRule || ""
      });
    }

    if (p === "/api/chapter") {
      const index = Number(u.searchParams.get("shelf"));
      const rel = u.searchParams.get("rel");
      const idx = Number(u.searchParams.get("idx"));
      // 防护：rel 缺失 / 书架无效时绝不能让 safeJoin 落到书架根目录。
      // 否则 parseBook 会 readFileSync 一个目录，抛出 EISDIR 这种对用户毫无意义的错误
      // （历史 bug：前端在线模式下 rel 解析失败时退化成 /api/chapter?rel=）。
      if (!rel) return send(res, 400, { error: "缺少章节路径 rel" });
      if (!Number.isInteger(index) || !config.shelves[index]) {
        return send(res, 400, { error: "书架不存在" });
      }
      const abs = safeJoin(shelfRoot(index), rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        return send(res, 404, { error: "章节文件不存在" });
      }
      const book = parseBook(abs);
      const seg = idx === -1 ? book.pre : book.chapters[idx];
      if (!seg) return send(res, 404, { error: "章节不存在" });
      // 卷标题（legado BookChapter.isVolume）本身没有正文，别把下一章的内容算进来
      const skipHead = idx === -1 || seg.noHead ? 0 : 1;
      const rawTitle = idx === -1 ? (book.pre?.title || "简介") : book.chapters[idx].label;
      const bn = book.title || "";
      const title = applyTitleRules(rawTitle, bn, LOCAL_ORIGIN) || rawTitle;
      const rawBody = seg.isVolume ? "" : book.lines.slice(seg.start + skipHead, seg.end)
        .map((l) => l.replace(/[\s\u3000]+$/, ""))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
      // 与 legado ReadBook.kt:798-805（ContentProcessor.getContent）对齐：
      // 本地书正文同样跑一遍替换净化，规则取消/停用即恢复原文。
      const body = seg.isVolume ? "" : applyReplaceRules(rawBody, {
        bookName: bn, origin: LOCAL_ORIGIN, book: bn, chapter: title,
      });
      return send(res, 200, {
        title, index: idx, total: book.chapters.length, text: body, isVolume: !!seg.isVolume
      });
    }

    if (p === "/api/progress" && req.method === "POST") {
      const { rel, chapter, scroll } = await readBody(req);
      if (rel) {
        config.progress[rel] = { chapter: Number(chapter) || 0, scroll: Number(scroll) || 0, at: Date.now() };
        const keys = Object.keys(config.progress);
        if (keys.length > 3000) {
          keys.sort((a, b) => (config.progress[a].at || 0) - (config.progress[b].at || 0))
            .slice(0, 1000).forEach((k) => delete config.progress[k]);
        }
        saveConfig();
      }
      return send(res, 200, { ok: true });
    }

    if (p === "/api/shelves/add" && req.method === "POST") {
      const { dir } = await readBody(req);
      if (!dir) return send(res, 400, { error: "缺少目录" });
      const abs = path.resolve(dir);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isDirectory()) return send(res, 400, { error: "目录不存在" });
      const key = abs.toLowerCase();
      const dup = config.shelves.findIndex((s) => path.resolve(s.path).toLowerCase() === key);
      if (dup >= 0) return send(res, 200, { ok: true, duplicated: true, index: dup, shelves: config.shelves });
      // 新导入的书架必须是真实扫描结果，不能拿旧快照顶替
      const books = await listBooksWithMeta(abs, { fresh: true }).then((r) => r.books);
      config.shelves.push({ path: abs, name: path.basename(abs) || abs, count: books.length, addedAt: Date.now() });
      saveConfig();
      return send(res, 200, { ok: true, index: config.shelves.length - 1, shelves: config.shelves, count: books.length });
    }

    if (p === "/api/shelves/remove" && req.method === "POST") {
      const { index } = await readBody(req);
      if (typeof index === "number" && config.shelves[index]) {
        dropBookSnapshot(config.shelves[index].path);
        config.shelves.splice(index, 1);
        saveConfig();
      }
      return send(res, 200, { ok: true, shelves: config.shelves });
    }

    if (p === "/api/shelves/rename" && req.method === "POST") {
      const { index, name } = await readBody(req);
      if (typeof index === "number" && config.shelves[index] && name) {
        config.shelves[index].name = String(name).slice(0, 60);
        saveConfig();
      }
      return send(res, 200, { ok: true, shelves: config.shelves });
    }

    /* ---------------- 字体 ---------------- */

    if (p === "/api/fonts/upload" && req.method === "POST") {
      const { name, data } = await readBody(req);
      if (!data) return send(res, 400, { error: "缺少字体数据" });
      const raw = String(name || "字体.ttf");
      const ext = path.extname(raw).toLowerCase();
      if (!FONT_EXT.has(ext)) return send(res, 400, { error: "仅支持 ttf / otf / woff / woff2 / ttc" });
      const buf = Buffer.from(String(data), "base64");
      if (!buf.length) return send(res, 400, { error: "字体文件为空" });
      if (buf.length > 80 * 1024 * 1024) return send(res, 400, { error: "字体文件过大（>80MB）" });
      const id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = id + ext;
      await fsp.writeFile(path.join(FONT_DIR, file), buf);
      const display = path.basename(raw, ext).slice(0, 60) || "自定义字体";
      config.fonts.push({ id, name: display, file, size: buf.length, addedAt: Date.now() });
      saveConfig();
      return send(res, 200, { ok: true, fonts: config.fonts });
    }

    if (p === "/api/fonts/remove" && req.method === "POST") {
      const { id } = await readBody(req);
      const i = config.fonts.findIndex((f) => f.id === id);
      if (i >= 0) {
        const f = config.fonts[i];
        config.fonts.splice(i, 1);
        try { await fsp.unlink(path.join(FONT_DIR, f.file)); } catch {}
        if (config.settings.fontFamily === "custom:" + id) config.settings.fontFamily = "serif";
        saveConfig();
      }
      return send(res, 200, { ok: true, fonts: config.fonts, settings: config.settings });
    }

    if (p.startsWith("/fonts/")) {
      const rel = decodeURIComponent(p.slice("/fonts/".length)).replace(/\\/g, "/");
      const abs = path.join(FONT_DIR, path.basename(rel));
      try {
        const buf = await fsp.readFile(abs);
        return send(res, 200, buf, FONT_MIME[path.extname(abs).toLowerCase()] || "font/ttf");
      } catch { return send(res, 404, { error: "字体不存在" }); }
    }

    /* ---------------- 目录浏览 ---------------- */

    if (p === "/api/browse") {
      const dir = u.searchParams.get("dir");
      const target = dir ? path.resolve(dir) : "";
      if (!target) {
        const drives = [];
        for (const letter of "CDEFGH") {
          try { fs.accessSync(letter + ":\\"); drives.push(letter + ":\\"); } catch {}
        }
        return send(res, 200, { dir: "", parent: null, dirs: drives, files: [] });
      }
      const parent = path.dirname(target);
      const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
      if (!entries) return send(res, 400, { error: "无法读取目录" });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"))
        .map((e) => path.join(target, e.name)).sort((a, b) => a.localeCompare(b, "zh"));
      const files = entries.filter((e) => e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name);
      return send(res, 200, { dir: target, parent: parent === target ? null : parent, dirs, files });
    }

    /* ---------------- 书源组 ---------------- */

    if (p === "/api/source-groups" && req.method === "GET") {
      return send(res, 200, sourceGroupPublic());
    }

    if (p === "/api/source-groups/create" && req.method === "POST") {
      const body = await readBody(req);
      const name = normalizeSourceGroupName(body.name);
      if (!name) return send(res, 400, { error: "书源组名称不能为空" });
      let id = "";
      do { id = "group-" + Date.now().toString(36) + "-" + crypto.randomBytes(2).toString("hex"); }
      while (sourceGroupById(id));
      const now = Date.now();
      const file = sourceGroupFile(id);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "[]", "utf8");
      sourceGroupIndex.groups.push({ id, name, createdAt: now, updatedAt: now });
      if (body.switch !== false) sourceGroupIndex.activeId = id;
      writeSourceGroupIndex();
      if (sourceGroupIndex.activeId === id) {
        loadSources();
        getPool();
      }
      return send(res, 200, { ok: true, createdId: id, ...sourceGroupPublic() });
    }

    if (p === "/api/source-groups/switch" && req.method === "POST") {
      const body = await readBody(req);
      const group = sourceGroupById(body.id);
      if (!group) return send(res, 404, { error: "书源组不存在" });
      sourceGroupIndex.activeId = group.id;
      writeSourceGroupIndex();
      loadSources();
      getPool();
      return send(res, 200, { ok: true, ...sourceGroupPublic() });
    }

    if (p === "/api/source-groups/rename" && req.method === "POST") {
      const body = await readBody(req);
      const group = sourceGroupById(body.id);
      if (!group) return send(res, 404, { error: "书源组不存在" });
      const name = normalizeSourceGroupName(body.name);
      if (!name) return send(res, 400, { error: "书源组名称不能为空" });
      group.name = name;
      group.updatedAt = Date.now();
      writeSourceGroupIndex();
      return send(res, 200, { ok: true, ...sourceGroupPublic() });
    }

    if (p === "/api/source-groups/delete" && req.method === "POST") {
      const body = await readBody(req);
      const group = sourceGroupById(body.id);
      if (!group) return send(res, 404, { error: "书源组不存在" });
      if (sourceGroupIndex.groups.length <= 1) return send(res, 400, { error: "至少保留一个书源组" });
      if (group.id === sourceGroupIndex.activeId) return send(res, 400, { error: "请先切换到其他书源组再删除" });
      await fsp.rm(sourceGroupDir(group.id), { recursive: true, force: true });
      sourceGroupIndex.groups = sourceGroupIndex.groups.filter((g) => g.id !== group.id);
      writeSourceGroupIndex();
      return send(res, 200, { ok: true, ...sourceGroupPublic() });
    }

    /* ---------------- 书源管理 ---------------- */

    if (p === "/api/sources" && req.method === "GET") {
      const kw = (u.searchParams.get("key") || "").trim().toLowerCase();
      const group = u.searchParams.get("group") || "";
      let list = sources.map((s) => sourceSummary(s));
      if (group) list = list.filter((s) => (s.group || "").includes(group));
      if (kw) list = list.filter((s) => (s.name || "").toLowerCase().includes(kw) || (s.url || "").toLowerCase().includes(kw));
      list.sort((a, b) => (a.customOrder || 0) - (b.customOrder || 0) || String(a.name).localeCompare(String(b.name), "zh"));
      return send(res, 200, { sources: list, total: sources.length, groups: groupNames(), sourceGroup: sourceGroupPublic() });
    }

    if (p === "/api/sources/get") {
      const url = u.searchParams.get("url") || "";
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      return send(res, 200, { source: s });
    }

    /* 需求：导入书源前先预览（legado 的「导入书源」会先列出清单让用户勾选）。
     * 前端拿这份清单渲染复选框：默认全选，已在源库里的标「已存在」。 */
    if (p === "/api/sources/preview") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      if (sub) {
        if (!/^https?:\/\//i.test(sub)) return send(res, 400, { error: "仅支持 http(s) 地址" });
        try {
          const r = await fetch(sub, { headers: { "user-agent": "Mozilla/5.0" } });
          if (!r.ok) throw new Error("HTTP " + r.status);
          text = await r.text();
        } catch (e) { return send(res, 400, { error: "下载失败：" + e.message }); }
      }
      if (!String(text).trim()) return send(res, 400, { error: "书源内容为空" });
      let parsed;
      try { parsed = parseSourceImport(text); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const list = parsed.sources.map((x) => {
        const k = getSKey(x);
        const old = sourceMap.get(k);
        return {
          key: k,
          name: x.bookSourceName || "",
          group: x.bookSourceGroup || "",
          type: x.bookSourceType,
          comment: x.bookSourceComment || "",
          enabled: x.enabled !== false,
          exists: !!old,
          oldEnabled: old ? old.enabled !== false : null,
          hasSearch: !!(x.searchUrl && String(x.searchUrl).trim()),
          hasExplore: !!(x.exploreUrl && String(x.exploreUrl).trim()) || !!(x.ruleExplore && x.ruleExplore.bookList),
          hasLogin: !!(x.loginUrl && String(x.loginUrl).trim()) || !!(x.loginUi && String(x.loginUi).replace(/\s/g, "") !== "[]"),
        };
      });
      return send(res, 200, { ok: true, sources: list, skipped: parsed.skipped.length, total: sources.length });
    }

    if (p === "/api/sources/import" && req.method === "POST") {
      const body = await readBody(req);
      const text = body.text != null ? String(body.text) : (body._raw || "");
      if (!text.trim()) return send(res, 400, { error: "书源内容为空" });
      let parsed;
      try { parsed = parseSourceImport(text); }
      catch (e) { return send(res, 400, { error: e.message }); }
      let incoming = parsed.sources.map((x) => normalizeSource(x));
      // 用户在预览弹窗里勾选的 keys（不传 = 全部导入，兼容旧调用）
      if (Array.isArray(body.keys)) {
        const want = new Set(body.keys.map(String));
        incoming = incoming.filter((x) => want.has(getSKey(x)));
      }
      const incomingKeys = new Set(incoming.map(getSKey));
      let added = 0, updated = 0;
      for (const s of incoming) {
        const k = getSKey(s);
        if (sourceMap.has(k)) {
          const old = sourceMap.get(k);
          // 覆盖内容但保留用户的启用/分组/排序
          const keep = { enabled: old.enabled, bookSourceGroup: old.bookSourceGroup,
            customOrder: old.customOrder, enabledExplore: old.enabledExplore };
          const merged = normalizeSource({ ...s, ...keep, lastUpdateTime: Date.now() });
          const i = sources.indexOf(old);
          sources[i] = merged;
          sourceMap.set(k, merged);
          updated++;
        } else {
          const ns = normalizeSource({ ...s, lastUpdateTime: Date.now(), customOrder: s.customOrder || (sources.length + 1) });
          sources.push(ns);
          sourceMap.set(k, ns);
          added++;
        }
      }
      await persistSources();
      getPool();
      return send(res, 200, {
        ok: true, added, updated, skipped: parsed.skipped.length,
        total: sources.length
      });
    }

    if (p === "/api/sources/import-url" && req.method === "POST") {
      const body = await readBody(req);
      const url = body.url;
      if (!/^https?:\/\//i.test(url || "")) return send(res, 400, { error: "仅支持 http(s) 地址" });
      let text;
      try {
        const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        text = await r.text();
      } catch (e) { return send(res, 400, { error: "下载失败：" + e.message }); }
      let parsed;
      try { parsed = parseSourceImport(text); }
      catch (e) { return send(res, 400, { error: "解析失败：" + e.message }); }
      let incoming = parsed.sources.map((x) => normalizeSource(x));
      if (Array.isArray(body.keys)) {
        const want = new Set(body.keys.map(String));
        incoming = incoming.filter((x) => want.has(getSKey(x)));
      }
      let added = 0, updated = 0;
      for (const src of incoming) {
        const k = getSKey(src);
        if (sourceMap.has(k)) {
          const old = sourceMap.get(k);
          const merged = normalizeSource({ ...src, enabled: old.enabled, bookSourceGroup: old.bookSourceGroup,
            customOrder: old.customOrder, enabledExplore: old.enabledExplore, lastUpdateTime: Date.now() });
          sources[sources.indexOf(old)] = merged;
          sourceMap.set(k, merged);
          updated++;
        } else {
          const ns = normalizeSource({ ...src, lastUpdateTime: Date.now(), customOrder: src.customOrder || (sources.length + 1) });
          sources.push(ns);
          sourceMap.set(k, ns);
          added++;
        }
      }
      await persistSources();
      getPool();
      return send(res, 200, { ok: true, added, updated, skipped: parsed.skipped.length, total: sources.length });
    }

    if (p === "/api/sources/delete" && req.method === "POST") {
      const { urls } = await readBody(req);
      const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
      const set = new Set(list);
      const before = sources.length;
      sources = sources.filter((s) => !set.has(getSKey(s)));
      for (const k of set) sourceMap.delete(k);
      await persistSources();
      getPool();
      return send(res, 200, { ok: true, removed: before - sources.length, total: sources.length });
    }

    if (p === "/api/sources/update" && req.method === "POST") {
      const body = await readBody(req);
      const { url } = body;
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
      const next = normalizeSource({ ...s, ...patch, bookSourceUrl: s.bookSourceUrl });
      const i = sources.indexOf(s);
      sources[i] = next;
      sourceMap.set(getSKey(next), next);
      await persistSources();
      getPool();
      return send(res, 200, { ok: true, source: next });
    }

    if (p === "/api/sources/toggle" && req.method === "POST") {
      const { urls, enabled } = await readBody(req);
      const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
      for (const url of list) {
        const s = sourceMap.get(url);
        if (s) s.enabled = enabled !== false;
      }
      await persistSources();
      getPool();
      return send(res, 200, { ok: true, enabled: enabledSources().length });
    }

    if (p === "/api/sources/export") {
      const group = u.searchParams.get("group") || "";
      const list = group ? sources.filter((s) => (s.bookSourceGroup || "").includes(group)) : sources;
      const body = exportSources(list);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename=book-sources.json",
        "cache-control": "no-store"
      });
      return res.end(body);
    }

    if (p === "/api/sources/groups") {
      return send(res, 200, { groups: groupNames() });
    }

    if (p === "/api/sources/order" && req.method === "POST") {
      const { urls } = await readBody(req);
      if (!Array.isArray(urls)) return send(res, 400, { error: "缺少 urls" });
      urls.forEach((url, i) => {
        const s = sourceMap.get(url);
        if (s) s.customOrder = i + 1;
      });
      await persistSources();
      return send(res, 200, { ok: true });
    }

    if (p === "/api/sources/analyze" && req.method === "POST") {
      // 规则调试：跑 搜索→详情→目录→正文 全链路，收集日志
      const { url, key, exploreUrl, chapterIndex } = await readBody(req);
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().request("debug", {
          sourceUrl: getSKey(s), key: key || "", exploreUrl: exploreUrl || "",
        }, { timeout: Number(u.searchParams.get("timeout")) || config.online.searchTimeout || 90000 });
        return send(res, 200, { ok: true, result: r.result, logs: r.logs });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data, logs: e.logs || [] });
      }
    }

    /* ---------------- 发现（explore） ---------------- */

    if (p === "/api/online/explore/kinds") {
      const url = u.searchParams.get("source") || "";
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      const infoMap = exploreInfoFromQuery(u);
      try {
        const r = await getPool().request("exploreKinds", { sourceUrl: getSKey(s), infoMap }, { timeout: 30000 });
        return send(res, 200, { ok: true, kinds: r.result.kinds || [], infoMap: r.result.infoMap || null, actions: r.result.actions || [] });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, kinds: [] });
      }
    }

    /**
     * 刷新发现（legado ExploreAdapter.refreshExplore + 菜单项 refresh_explore）：
     *   source.clearExploreKindsCache() → source.exploreKinds()
     * 两步之间不做任何新旧比较，ACache 直接覆盖 —— 登录番茄后新增的
     * 「番茄书架 / 分组」入口只有这样才进得来。
     */
    if (p === "/api/online/explore/refresh" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      await clearExploreKindCacheEverywhere(getSKey(s));
      try {
        const r = await getPool().request("exploreKinds", {
          sourceUrl: getSKey(s), infoMap: body.infoMap || null,
        }, { timeout: Number(body.timeout) || 60000 });
        return send(res, 200, { ok: true, kinds: r.result.kinds || [], infoMap: r.result.infoMap || null, actions: r.result.actions || [] });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, kinds: [] });
      }
    }

    /* 发现页 kind 的 action（legado ExploreAdapter.evalButtonClick / evalUiJs） */
    if (p === "/api/online/explore/action" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      if (body.refresh === true) await clearExploreKindCacheEverywhere(getSKey(s));
      try {
        const r = await getPool().request("exploreAction", {
          sourceUrl: getSKey(s),
          action: body.action == null ? null : String(body.action),
          infoMap: body.infoMap || null,
          kind: body.kind || null,
          title: body.title == null ? null : String(body.title),
        }, { timeout: config.online.searchTimeout || 60000 });
        // 注意：这里**不能**再清一次缓存。
        // legado 的 java.refreshExplore() 语义是 clearExploreKindsCache() → exploreKinds()，
        // 清空只发生一次，紧接着就重建；worker 里已经照做并把新分类写回 ACache。
        // 之前这里在 worker 返回后又 broadcast 清了一次，worker 刚写好的完整分类被删掉，
        // 下一次 /explore/kinds 只能重新执行脚本；源站 502 时脚本 try/catch 吞掉异常，
        // 只吐出筛选框 —— 表现就是「光遇发现页内容又不见了」。
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, actions: [] });
      }
    }

    /* viewName 求值（legado ExploreAdapter.evalUiJs） */
    if (p === "/api/online/explore/ui" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().request("exploreUiJs", {
          sourceUrl: getSKey(s), code: String(body.code || ""), infoMap: body.infoMap || null,
        }, { timeout: 30000 });
        return send(res, 200, { ok: true, value: r.result.value || "" });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, value: "" });
      }
    }

    if (p === "/api/online/explore") {
      // 发现页 URL 可能是书源在求值时生成的整串 POST 描述（例如番茄「我的书架」某个分组
      // 会把 258 个 book_id 塞进 body），长度可达十几 KB。走 GET query 会触发 Node
      // 的 431 Request Header Fields Too Large，书架分组因此加载失败；这里同时支持 POST。
      let url = u.searchParams.get("source") || "";
      let target = u.searchParams.get("url") || "";
      let page = Number(u.searchParams.get("page")) || 1;
      let infoMap = exploreInfoFromQuery(u);
      if (req.method === "POST") {
        const body = await readBody(req);
        url = String(body.source == null ? url : body.source);
        target = String(body.url == null ? target : body.url);
        if (Number(body.page)) page = Number(body.page);
        if (body.infoMap && typeof body.infoMap === "object") infoMap = body.infoMap;
      }
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().request("explore", { sourceUrl: getSKey(s), url: target, page, infoMap },
          { timeout: config.online.searchTimeout || 60000 });
        return send(res, 200, {
          ok: true,
          books: r.result.books || [],
          respondTime: r.result.respondTime,
          sourceName: s.bookSourceName,
          actions: r.result.actions || [],
          meta: r.result.meta || null,
        });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data, books: [] });
      }
    }

    /* ---------------- 搜索 ---------------- */

    if (p === "/api/online/search" && req.method === "POST") {
      const body = await readBody(req);
      const key = String(body.key || "").trim();
      if (!key) return send(res, 400, { error: "缺少关键词" });
      const author = String(body.author || "").trim();
      const page = Number(body.page) || 1;
      const precision = body.precision === true;
      // 换源搜索（legado ChangeBookSourceViewModel.search 的 filter 语义）：
      // 书名精确同名 + 作者 contains；默认检查作者（legado changeSourceCheckAuthor 默认开）
      const changeSource = body.changeSource === true;
      const checkAuthor = body.checkAuthor !== false;
      const timeout = Number(body.timeout) || config.online.searchTimeout || 45000;
      let list = enabledSources();
      if (Array.isArray(body.sources) && body.sources.length) {
        const set = new Set(body.sources);
        list = list.filter((s) => set.has(getSKey(s)));
      }
      if (body.group) list = list.filter((s) => (s.bookSourceGroup || "").includes(body.group));
      if (!list.length) return send(res, 200, { ok: true, books: [], sources: [], errors: [], note: "没有启用的书源" });
      const concurrency = Number(body.concurrency) || config.online.searchConcurrency || 0;
      // 需求 11：同一轮搜索翻页时把上一页结果带回来，worker 端 mergeItems 会按「同名同作者合并 origins」累加
      const existing = Array.isArray(body.existing) ? body.existing : [];
      const opts = {
        page, precision, timeout, concurrency: concurrency || undefined,
        existing, author, changeSource, checkAuthor,
      };

      // 需求 2：把「哪个源回到了、回了多少本、失败了什么」实时推给前端（legado SearchProgressReporter 的等价物）
      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        const write = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* 客户端断开 */ } };
        write({ type: "start", total: list.length, key, page, author });
        let done = 0;
        opts.onSource = (item) => {
          done++;
          write({
            type: "source", done, total: list.length,
            sourceName: item.sourceName, sourceUrl: item.sourceUrl,
            count: (item.books || []).length,
            ok: item.ok !== false, error: item.error || null, code: item.code || null,
            respondTime: item.respondTime || 0,
            books: item.books || [],
            actions: item.actions || [],
          });
        };
        try {
          const r = await getPool().searchAll(list, key, opts);
          write({
            type: "done", ok: true, key, page, precision, author,
            books: r.books, sources: r.sources, errors: r.errors, filtered: r.filtered || 0,
            hasMore: r.sources.some((x) => (x.books || []).length > 0),
          });
        } catch (e) {
          write({ type: "done", ok: false, error: e.message, code: e.code, books: [], sources: [], errors: [] });
        }
        return res.end();
      }

      const r = await getPool().searchAll(list, key, opts);
      return send(res, 200, {
        ok: true, key, page, precision, author,
        books: r.books, sources: r.sources, errors: r.errors, filtered: r.filtered || 0,
        hasMore: r.sources.some((x) => (x.books || []).length > 0),
      });
    }

    /* ---------------- 在线书籍 ---------------- */

    if (p === "/api/online/shelf" && req.method === "GET") {
      repairAllOnlineBooks();
      // 需求 3：书架条目按 legado item_bookshelf_list 显示「读到 / 最新 / 未读章节数」，
      // 这些都要章节总数与章节标题 —— 从目录缓存补，没缓存过就是 0/空（界面上不显示那一行）。
      for (const b of config.online.books) {
        try {
          const chapters = readTocCache(b.origin, b.bookUrl);
          if (chapters && chapters.length) {
            // BookChapterList.updateBookTocInfo()（BookChapterList.kt:171-176）：
            //   目录变长 → lastCheckCount = 新长度 - 旧长度、latestChapterTime = 现在，
            //   再 totalChapterNum = 新长度。
            // lastCheckCount > 0 才让未读气泡高亮（BooksAdapterList.kt:113 setHighlight）。
            const prevTotal = Number(b.totalChapterNum) || 0;
            if (prevTotal > 0 && chapters.length > prevTotal) {
              b.lastCheckCount = chapters.length - prevTotal;
              b.latestChapterTime = Date.now();
            }
            b.totalChapterNum = chapters.length;
            const pr = config.online.progress[okey(b.origin, b.bookUrl)];
            // 「读到」= Book.durChapterTitle（BooksAdapterList.kt:63 tvRead.text = item.durChapterTitle）。
            // 没打开过的书 legado 里是 null，书架那行会空掉；用户要求退成第一章章节名。
            const idx = pr ? Number(pr.chapter) || 0 : 0;
            if (chapters[idx]) b.durChapterTitle = displayChapterTitle(b.origin, b, chapters[idx].title);
            // 「最新」= tvLast.text = item.latestChapterTitle。以目录末章为准：
            // 详情页规则常抓到推广文案（七猫「《斗破苍穹：斗帝之路》手游…」），不是真正的最后一章。
            b.latestChapterTitle = displayChapterTitle(b.origin, b, chapters[chapters.length - 1].title);
          }
        } catch { /* 缓存损坏就跳过，不影响返回 */ }
      }
      // 阅读进度（durChapterIndex / durChapterPos）必须随书架一起返回：
      // legado 里它们是 Book 表字段（Book.kt:97 durChapterIndex / :94 durChapterPos），
      // 书架「未读章节数」getUnreadChapterNum() = totalChapterNum - durChapterIndex - 1 全靠它。
      // 前端的 onlineProgress 是内存态，刷新页面就没了，光靠它算出来全是 99+。
      const orderChanged = ensureShelfOrder();
      if (orderChanged) saveConfig();
      return send(res, 200, { books: shelfBooksSorted(), progress: config.online.progress, groups: bookGroupSorted() });
    }

    if (p === "/api/online/shelf/add" && req.method === "POST") {
      const body = await readBody(req);
      const b = body.book && typeof body.book === "object" ? body.book : body;
      if (!b || !b.bookUrl) return send(res, 400, { error: "缺少 bookUrl" });
      const origin = String(b.origin || body.sourceUrl || "");
      // 需求 5：同一本书只留一个书源（想换源看走「换源」，不是往书架塞第二本）。
      // 判据跟 legado SearchAdapter.diffItemCallback.areItemsTheSame 对齐 —— 书名 + 作者相同即同一本；
      // 作者缺失时退化成只比书名，避免同名言情/同名不同人的书被误判成重复。
      //
      // 命中多条时挑「最完整」的那条返回：换源残留可能让同一本书有两条记录，
      // 其中一条 tocUrl 是坏的（bookId 空）。若返回坏的那条，打开正文就是「目录为空」。
      const dups = config.online.books.filter((x) => sameBookMeta(x, b));
      if (dups.length) {
        const dup = dups.slice().sort((x, y) => bookRecordScore(y) - bookRecordScore(x))[0];
        return send(res, 200, { ok: true, duplicated: true, book: dup });
      }
      const exists = config.online.books.find((x) => okey(x.origin, normalizeBookUrl(x.bookUrl)) === okey(origin, normalizeBookUrl(b.bookUrl)));
      if (exists) return send(res, 200, { ok: true, duplicated: true, book: exists });
      const item = {
        name: String(b.name || ""), author: String(b.author || ""), bookUrl: normalizeBookUrl(b.bookUrl),
        tocUrl: String(b.tocUrl || ""), origin, originName: String(b.originName || ""),
        kind: b.kind || null, coverUrl: b.coverUrl || null, intro: b.intro || null,
        latestChapterTitle: b.latestChapterTitle || null, type: b.type || 8,
        wordCount: b.wordCount || null,
        group: Number(b.group) || 0, order: Number.isFinite(Number(b.order)) ? Number(b.order) : (config.online.books.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1), addedAt: Date.now(), variable: b.variable || null,
      };
      config.online.books.push(item);
      saveConfig();
      return send(res, 200, { ok: true, book: item, books: config.online.books });
    }

    if (p === "/api/online/shelf/remove" && req.method === "POST") {
      const { origin, bookUrl } = await readBody(req);
      const k = okey(origin, bookUrl);
      const before = config.online.books.length;
      config.online.books = config.online.books.filter((b) => okey(b.origin, b.bookUrl) !== k);
      delete config.online.progress[k];
      dropTocCache(origin, bookUrl);
      dropContentCache(origin, bookUrl);
      saveConfig();
      return send(res, 200, { ok: true, removed: before - config.online.books.length });
    }

    /**
     * 书架一键换源（用户需求 1）。
     * 入口对应 legado BookshelfManageActivity 的书架菜单「换源」→ SourcePickerDialog 选目标源；
     * 我们用 NDJSON 推进度（legado 是 waitDialog 上一句 "3 / 12"，见 BookshelfManageActivity.kt:134-144）。
     */
    if (p === "/api/online/changeAllSource" && req.method === "POST") {
      const body = await readBody(req);
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      const write = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* 客户端断开 */ } };
      try {
        const result = await doChangeAllSource(body, write);
        // 参数错误/目标源刚被删除时，任务会在写 start 前返回；仍要发 done，
        // 否则前端的 NDJSON 进度窗会永久停在「正在启动」。
        if (result && !result.type) write({ type: "done", ...result });
      } catch (e) {
        write({ type: "done", ok: false, error: e.message });
      }
      return res.end();
    }

    /** 换源（单本）。真正的逻辑在模块级 doChangeSource()，批量换源也复用它。 */
    if (p === "/api/online/changeSource" && req.method === "POST") {
      const r = await doChangeSource(await readBody(req));
      return send(res, r.status, r.data);
    }

    /* ---------------- 书架管理（legado BookshelfManageActivity / GroupViewModel） ---------------- */
    if (p === "/api/online/bookGroups" && req.method === "GET") {
      return send(res, 200, { groups: bookGroupSorted() });
    }
    if (p === "/api/online/bookGroups/save" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.groupName || "").trim();
      if (!name) return send(res, 400, { error: "分组名称不能为空" });
      const id = Number(body.groupId);
      let g = bookGroups().find((x) => Number(x.groupId) === id);
      if (!g || id <= 0) {
        g = { groupId: bookGroupUnusedId(), groupName: name, cover: body.cover || "", order: bookGroups().reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1, enableRefresh: body.enableRefresh !== false, onlyUpdateRead: body.onlyUpdateRead === true, bookSort: Number(body.bookSort) || -1 };
        bookGroups().push(g);
      } else {
        Object.assign(g, { groupName: name, cover: body.cover || "", enableRefresh: body.enableRefresh !== false, onlyUpdateRead: body.onlyUpdateRead === true, bookSort: Number(body.bookSort) || -1 });
      }
      saveConfig();
      return send(res, 200, { ok: true, group: g, groups: bookGroupSorted() });
    }
    if (p === "/api/online/bookGroups/delete" && req.method === "POST") {
      const body = await readBody(req); const id = Number(body.groupId) || 0;
      config.online.bookGroups = bookGroups().filter((g) => Number(g.groupId) !== id);
      if (id > 0) config.online.books.forEach((b) => { b.group = (Number(b.group) || 0) & ~id; });
      saveConfig();
      return send(res, 200, { ok: true, groups: bookGroupSorted() });
    }
    if (p === "/api/online/bookGroups/order" && req.method === "POST") {
      const body = await readBody(req); const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
      ids.forEach((id, i) => { const g = bookGroups().find((x) => Number(x.groupId) === id); if (g) g.order = i + 1; });
      saveConfig();
      return send(res, 200, { ok: true, groups: bookGroupSorted() });
    }
    if (p === "/api/online/shelf/order" && req.method === "POST") {
      const body = await readBody(req); const ids = Array.isArray(body.ids) ? body.ids : [];
      ids.forEach((x, i) => { const b = findOnlineBook(x.origin, x.bookUrl); if (b) b.order = i + 1; });
      saveConfig();
      return send(res, 200, { ok: true, books: shelfBooksSorted() });
    }
    if (p === "/api/online/shelf/batch" && req.method === "POST") {
      const body = await readBody(req); const action = String(body.action || "");
      const refs = Array.isArray(body.books) ? body.books : [];
      const selected = refs.map((x) => findOnlineBook(x.origin, x.bookUrl)).filter(Boolean);
      if (!selected.length && action !== "reorder") return send(res, 400, { error: "没有选中书籍" });
      if (action === "remove") {
        const keys = new Set(selected.map((b) => okey(b.origin, b.bookUrl)));
        config.online.books = config.online.books.filter((b) => !keys.has(okey(b.origin, b.bookUrl)));
        selected.forEach((b) => { delete config.online.progress[okey(b.origin, b.bookUrl)]; dropTocCache(b.origin, b.bookUrl); dropContentCache(b.origin, b.bookUrl); });
      } else if (action === "update" || action === "disableUpdate") {
        selected.forEach((b) => { b.canUpdate = action === "update"; });
      } else if (action === "groupAdd" || action === "groupRemove" || action === "groupSet") {
        const gid = Number(body.groupId) || 0;
        selected.forEach((b) => { if (action === "groupAdd") b.group = (Number(b.group) || 0) | gid; else if (action === "groupRemove") b.group = (Number(b.group) || 0) & ~gid; else b.group = gid; });
      } else if (action === "clearCache") {
        selected.forEach((b) => dropTocCache(b.origin, b.bookUrl));
        selected.forEach((b) => dropContentCache(b.origin, b.bookUrl));
        const pool = getPool(); await Promise.allSettled(pool.slots.map((s) => s.run("clearCache", {}, 8000)));
      } else if (action === "reorder") {
        const ids = Array.isArray(body.ids) ? body.ids : [];
        ids.forEach((x, i) => { const b = findOnlineBook(x.origin, x.bookUrl); if (b) b.order = i + 1; });
      } else if (action === "updateToc") {
        const todo = selected.filter((b) => b.canUpdate !== false);
        let ok = 0, fail = 0;
        for (const b of todo) {
          try {
            let info = b;
            if (isDegenerateTocUrl(info.tocUrl, info.bookUrl)) info = await ensureBookInfo(b.origin, b.bookUrl);
            const r = await getPool().request("chapters", {
              sourceUrl: b.origin, book: info, runPerJs: false, isFromBookInfo: false,
            }, { timeout: config.online.searchTimeout || 120000 });
            const chapters = r.result.chapters || [];
            if (!chapters.length) throw new Error("没有解析到目录");
            writeTocCache(b.origin, b.bookUrl, chapters);
            b.totalChapterNum = chapters.length;
            b.latestChapterTitle = displayChapterTitle(b.origin, b, chapters[chapters.length - 1].title) || b.latestChapterTitle;
            ok++;
          } catch { fail++; }
        }
        saveConfig(); return send(res, 200, { ok: true, updated: ok, failed: fail });
      } else { return send(res, 400, { error: "未知书架操作" }); }
      saveConfig();
      return send(res, 200, { ok: true, books: shelfBooksSorted(), selected: selected.length });
    }

    if (p === "/api/online/shelf/update" && req.method === "POST") {
      const { origin, bookUrl, patch } = await readBody(req);
      const b = findOnlineBook(origin, bookUrl);
      if (!b) return send(res, 404, { error: "书不在在线书架" });
      if (patch && typeof patch === "object") Object.assign(b, patch);
      saveConfig();
      return send(res, 200, { ok: true, book: b });
    }

    if (p === "/api/online/book" && req.method === "GET") {
      // 详情：优先用已存的书架数据，缺字段就抓一次
      const origin = u.searchParams.get("origin") || "";
      const bookUrl = u.searchParams.get("url") || "";
      const refresh = u.searchParams.get("refresh") === "1";
      const s = sourceMap.get(origin);
      if (!s) return send(res, 404, { error: "书源不存在，可能已被删除" });
      let book = findOnlineBook(origin, bookUrl);
      const bookActions = [];
      // tocUrl == bookUrl 是「详情页本身就是目录页」那类站点的正常形态（速读谷² 等）。
      // 只有「从没成功抓到过目录」时才需要重抓详情去修复；否则每次打开都白跑一趟网络
      // （实测速读谷² 每次打开要多等 0.3~1.1s，且站点被 ban 时直接拖到超时）。
      // needsUrlOptionHeal：历史坏记录（bookUrl 被剥掉 URL 选项）即使 tocUrl 看着正常，
      // 也先补一次详情 —— 那种记录在源站眼里就是「没带 Referer」，正文一样抓不到。
      if (refresh || !book
          || (isDegenerateTocUrl(book.tocUrl, bookUrl) && !readTocCache(origin, bookUrl))
          || needsUrlOptionHeal(origin, bookUrl, book.tocUrl)) {
        try {
          book = await ensureBookInfo(origin, bookUrl, { force: refresh, actions: bookActions });
        } catch (e) {
          if (!book) return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data });
          return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data, book });
        }
      }
      const chapters = readTocCache(origin, bookUrl) || [];
      return send(res, 200, { ok: true, book, cached: !refresh, chapterCount: chapters.length, actions: bookActions });
    }

async function fetchTocForBook(origin, bookUrl, timeout) {
  const s = sourceMap.get(origin);
  if (!s) throw Object.assign(new Error("书源不存在"), { code: "NO_SOURCE" });
  let book = findOnlineBook(origin, bookUrl);
  // 历史坏记录（bookUrl 缺 URL 选项 / tocUrl 退化）都要先补详情，
  // 否则拿裸 URL 去请求只会得到 incorrect referer，永远解析不出目录。
  if (!book || isDegenerateTocUrl(book.tocUrl, bookUrl) || needsUrlOptionHeal(origin, bookUrl)) {
    book = await ensureBookInfo(origin, bookUrl);
  }
  const r = await getPool().request("chapters", {
    sourceUrl: origin, book, runPerJs: false, isFromBookInfo: false,
  }, { timeout: Number(timeout) || 120000 });
      const chapters = r.result.chapters || [];
      if (chapters.length) writeTocCache(origin, bookUrl, chapters);
      if (r.result.book && book.variable !== r.result.book.variable) {
        book.variable = r.result.book.variable;
        book.tocUrl = r.result.book.tocUrl || book.tocUrl;
        book.totalChapterNum = chapters.length;
        if (findOnlineBook(origin, bookUrl)) saveConfig();
      }
      // BookChapterList.updateBookTocInfo()（BookChapterList.kt:171-176）的等价物：
      // 目录一变就把「章节总数 / 读到 / 最新」写回书架条目，而不是等下一次 /api/online/shelf
      // 才现算。这样新加入书架的书抓完目录后条目立刻有那两行（不用手动刷新），
      // 其它入口（详情页、换源、重启恢复）拿到的也是完整数据。
      const shelfBook = findOnlineBook(origin, bookUrl);
      if (shelfBook && chapters.length) {
        const prevTotal = Number(shelfBook.totalChapterNum) || 0;
        if (prevTotal > 0 && chapters.length > prevTotal) {
          shelfBook.lastCheckCount = chapters.length - prevTotal;
          shelfBook.latestChapterTime = Date.now();
        }
        shelfBook.totalChapterNum = chapters.length;
        const pr = config.online.progress[okey(origin, bookUrl)];
        const idx = pr ? Number(pr.chapter) || 0 : 0;
        if (chapters[idx]) shelfBook.durChapterTitle = displayChapterTitle(origin, shelfBook, chapters[idx].title);
        shelfBook.latestChapterTitle = displayChapterTitle(origin, shelfBook, chapters[chapters.length - 1].title);
        saveConfig();
      }
      return chapters;
    }

    /**
     * BookChapter.getDisplayTitle()（legado BookChapter.kt:124 / ChapterListAdapter.kt:149）：
     * 目录列表与正文标题共用同一套 scopeTitle 替换规则。
     * TOC 缓存里始终保留原始标题，只在返回给前端时实时套规则 —— 这样切换/编辑净化规则后
     * 目录能立刻跟着变，也不会污染缓存。
     */
    function displayChapterTitle(origin, book, title) {
      const bookName = (book && book.name) || "";
      return applyTitleRules(title, bookName, origin) || title;
    }

    function displayChapters(origin, bookUrl, chapters) {
      if (!Array.isArray(chapters) || !chapters.length) return chapters || [];
      const bk = findOnlineBook(origin, bookUrl);
      // 在线目录一页就常有一两千章。逐章调用 applyTitleRules() 会反复执行
      // 同一批规则并反复挂 vm timeout；这里复用本地大书优化过的批量净化，
      // 语义仍是「原始 TOC 不落库，返回时实时套 scopeTitle」。
      const titles = chapters.map((c) => (c && c.title) || "");
      const displayed = applyTitleRulesBatch(titles, (bk && bk.name) || "", origin);
      return chapters.map((c, i) => {
        if (!c) return c;
        const t = displayed[i] || "";
        return t === c.title ? c : { ...c, title: t };
      });
    }

    if (p === "/api/online/chapters" && req.method === "GET") {
      const origin = u.searchParams.get("origin") || "";
      const bookUrl = u.searchParams.get("url") || "";
      const refresh = u.searchParams.get("refresh") === "1";
      const s = sourceMap.get(origin);
      if (!s) return send(res, 404, { error: "书源不存在" });
      if (!refresh) {
        const cached = readTocCache(origin, bookUrl);
        if (cached) return send(res, 200, { ok: true, chapters: displayChapters(origin, bookUrl, cached), cached: true });
      }
      try {
        const chapters = await fetchTocForBook(origin, bookUrl, u.searchParams.get("timeout"));
        return send(res, 200, { ok: true, chapters: displayChapters(origin, bookUrl, chapters), cached: false });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data, chapters: [] });
      }
    }

    if (p === "/api/online/content" && req.method === "GET") {
      const origin = u.searchParams.get("origin") || "";
      const bookUrl = u.searchParams.get("url") || "";
      const index = Number(u.searchParams.get("index")) || 0;
      const refresh = u.searchParams.get("refresh") === "1";
      const s = sourceMap.get(origin);
      if (!s) return send(res, 404, { error: "书源不存在" });
      let chapters = readTocCache(origin, bookUrl);
      if (!chapters) {
        // 清缓存会把目录缓存一起清掉（这是「清缓存生效」的一部分）；
        // 此处不能直接报「目录未加载」，否则用户点刷新正文就卡死。自动回源重建一次目录。
        try {
          chapters = await fetchTocForBook(origin, bookUrl, u.searchParams.get("timeout"));
        } catch (e) {
          return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data });
        }
      }
      if (!chapters || !chapters.length) return send(res, 409, { error: "目录未加载", code: "NO_TOC" });
      const chapter = chapters[index];
      if (!chapter) return send(res, 404, { error: "章节不存在" });
      let book = findOnlineBook(origin, bookUrl);
      if (!book) { try { book = await ensureBookInfo(origin, bookUrl); } catch { book = { bookUrl, origin, originName: s.bookSourceName }; } }
      const next = chapters[index + 1];
      try {
        // legado 语义：先读持久正文缓存，refresh 才回源。
        const rc = await fetchContentCached(
          origin, bookUrl, book, chapter, next ? next.url : null,
          refresh, u.searchParams.get("timeout"),
        );
        // legado ContentProcessor.getContent：正文净化按「书名 + 书源 URL」圈定作用范围
        const bookName = (book && book.name) || "";
        const text = applyReplaceRules(rc.content || "", { bookName, origin });
        // 章标题也要过 scopeTitle 规则（BookChapter.getDisplayTitle()）
        const title = applyTitleRules(chapter.title, bookName, origin) || chapter.title;
        const payPreview = looksLikePayPreview(text);
        return send(res, 200, {
          ok: true, title, index, total: chapters.length,
          text, cached: !!rc.cached,
          payPreview,
          payHint: payPreview
            ? "当前书源对本章只返回付费或广告预览，阅读器无法解锁。请用「换源」切到其他书源阅读本章。"
            : "",
        });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data });
      }
    }

    /**
     * 正文内嵌图片点击（legado ReadBookActivity.oldClickImg）。
     * 前端把 <img src="url,{...option}"> 的原始 src 回传，worker 解析出 click/js 后执行；
     * 脚本里的 java.showBrowser 会被收集成 actions[].type='openUrl' 交给前端开弹窗。
     */
    if (p === "/api/online/img/click" && req.method === "POST") {
      const body = await readBody(req);
      const origin = String(body.origin || "");
      const bookUrl = String(body.bookUrl || "");
      const s0 = sourceMap.get(origin);
      if (!s0) return send(res, 404, { error: "书源不存在" });
      let book = body.book || findOnlineBook(origin, bookUrl);
      if (!book) { try { book = await ensureBookInfo(origin, bookUrl); } catch { book = { bookUrl, origin, originName: s0.bookSourceName }; } }
      let chapter = body.chapter || null;
      if (!chapter) {
        const chapters = readTocCache(origin, bookUrl);
        const idx = Number(body.index) || 0;
        chapter = (chapters && chapters[idx]) || { url: bookUrl, title: "", index: idx, bookUrl };
      }
      try {
        const r = await getPool().request("imgClick", {
          sourceUrl: origin, book, chapter, src: String(body.src || ""),
        }, { timeout: Number(body.timeout) || 60000 });
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, actions: [] });
      }
    }

    /**
     * 书源生成 html 里的 window.qmRun(...) 桥（legado WebJsExtensions.request("run")）。
     * 前端 iframe 弹窗 postMessage 进来，worker 在 AnalyzeRule + jsLib 作用域里 evalJS，
     * 返回 value 字符串与新的 actions（脚本里可能再次 java.showBrowser）。
     */
    if (p === "/api/online/js/run" && req.method === "POST") {
      const body = await readBody(req);
      const origin = String(body.origin || "");
      const bookUrl = String(body.bookUrl || "");
      const s0 = sourceMap.get(origin);
      if (!s0) return send(res, 404, { error: "书源不存在" });
      let book = body.book || findOnlineBook(origin, bookUrl);
      if (!book) { try { book = await ensureBookInfo(origin, bookUrl); } catch { book = { bookUrl, origin, originName: s0.bookSourceName }; } }
      let chapter = body.chapter || null;
      if (!chapter) {
        const chapters = readTocCache(origin, bookUrl);
        const idx = Number(body.index) || 0;
        chapter = (chapters && chapters[idx]) || { url: bookUrl, title: "", index: idx, bookUrl };
      }
      try {
        const r = await getPool().request("jsRun", {
          sourceUrl: origin, book, chapter, code: String(body.code || ""), result: body.result == null ? null : body.result,
        }, { timeout: Number(body.timeout) || 60000 });
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, value: "", actions: [] });
      }
    }

    if (p === "/api/online/progress" && req.method === "POST") {
      const { origin, bookUrl, chapter, scroll } = await readBody(req);
      const k = okey(origin, bookUrl);
      if (k !== "|") {
        config.online.progress[k] = { chapter: Number(chapter) || 0, scroll: Number(scroll) || 0, at: Date.now() };
        const b = findOnlineBook(origin, bookUrl);
        if (b) {
          // ReadBook.saveRead()（ReadBook.kt:1008）：一开读就清掉「新增章节」标记。
          b.lastCheckCount = 0;
          const chapters = readTocCache(origin, bookUrl);
          if (chapters && chapters[Number(chapter)]) b.durChapterTitle = displayChapterTitle(b.origin, b, chapters[Number(chapter)].title);
        }
        saveConfig();
      }
      return send(res, 200, { ok: true });
    }

    /* ---------------- 验证面板 ---------------- */

    if (p === "/api/verify/pending") {
      try {
        const r = await getPool().request("verifyList", {}, { timeout: 8000 });
        return send(res, 200, { pending: r.result.pending || [] });
      } catch (e) { return send(res, 200, { pending: [], error: e.message }); }
    }

    if (p === "/api/verify/submit" && req.method === "POST") {
      const { sourceKey: sk, result, url } = await readBody(req);
      const jobs = await Promise.allSettled(
        getPool().slots.map((slot) => slot.run("verifySubmit", { sourceKey: sk, result, url }, 8000)),
      );
      return send(res, 200, { ok: true, delivered: jobs.filter((j) => j.status === "fulfilled").length });
    }

    if (p === "/api/verify/clear" && req.method === "POST") {
      await Promise.allSettled(getPool().slots.map((slot) => slot.run("verifyClear", {}, 8000)));
      return send(res, 200, { ok: true });
    }

    /* ---------------- 替换规则（legado ReplaceRuleController + ReplaceRuleActivity） ----------------
     * 字段清单严格照 data/entities/ReplaceRule.kt：
     *   id/name/group/pattern/replacement/scope/scopeTitle/scopeContent/
     *   excludeScope/isEnabled/isRegex/timeoutMillisecond/order
     * order 语义照 dao：MIN_VALUE 表示「没排过序」，落库时取 maxOrder+1（Controller.saveRule）。
     */

    /** 是否有用的规则；对齐 ReplaceRule.isValid() */
    function replaceRuleValid(rule) {
      const pattern = String(rule.pattern == null ? "" : rule.pattern);
      if (!pattern) return false;
      if (rule.isRegex !== false) {
        try { legadoRegex(pattern); } catch (e) { return false; }
        if (/\|$/.test(pattern) && !/\\\|$/.test(pattern)) return false; // legado: endsWith('|') && !endsWith('\|')
      }
      return true;
    }

    /** 统一成完整形状；order 缺省 = Int.MIN_VALUE（未排序） */
    function normReplaceRule(rule, fallbackOrder) {
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
      return {
        id: rule.id || ("r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: String(rule.name || ""),
        group: rule.group == null ? "" : String(rule.group),
        pattern: String(rule.pattern == null ? "" : rule.pattern),
        replacement: String(rule.replacement == null ? "" : rule.replacement),
        scope: rule.scope == null ? "" : String(rule.scope),
        scopeTitle: rule.scopeTitle === true,
        scopeContent: rule.scopeContent !== false,
        excludeScope: rule.excludeScope == null ? "" : String(rule.excludeScope),
        isEnabled: rule.isEnabled !== false,
        isRegex: rule.isRegex !== false,
        timeoutMillisecond: num(rule.timeoutMillisecond, 3000),
        order: Number.isFinite(Number(rule.order)) ? Number(rule.order) : (fallbackOrder == null ? Number.MIN_SAFE_INTEGER : fallbackOrder),
        builtin: rule.builtin === true,
        builtinSource: rule.builtinSource ? String(rule.builtinSource) : "",
      };
    }

    function sortedRules() {
      return (config.online.replaceRules || []).slice().sort((x, y) => ruleOrder(x) - ruleOrder(y));
    }

    if (p === "/api/replace-rules" && req.method === "GET") {
      ensureBuiltinReplaceRules();
      return send(res, 200, { rules: sortedRules() });
    }

    if (p === "/api/replace-rules/builtin/reset" && req.method === "POST") {
      const old = new Map((config.online.replaceRules || []).map((r) => [String(r.id), r]));
      const custom = (config.online.replaceRules || []).filter((r) => !r.builtin && !String(r.id).startsWith("builtin-netclean-"));
      let maxOrder = custom.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
      const restored = builtinReplaceRules.map((r) => {
        const prev = old.get(String(r.id));
        return { ...r, isEnabled: prev ? prev.isEnabled !== false : r.isEnabled !== false, order: ++maxOrder };
      });
      config.online.replaceRules = custom.concat(restored);
      config.online.builtinReplaceInitialized = true;
      const mutexDisabled = numericTitleRuleMutex();
      saveConfig();
      return send(res, 200, { ok: true, count: restored.length, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/save" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule || body;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      const list = config.online.replaceRules;
      const i = rule.id ? list.findIndex((r) => r.id === rule.id) : -1;
      if (!replaceRuleValid(rule)) return send(res, 200, { ok: false, error: "替换规则为空或者不满足正则表达式要求" });
      // ReplaceRuleController.saveRule：order == Int.MIN_VALUE 时取 maxOrder+1
      let order = rule.order;
      if (!Number.isFinite(Number(order))) {
        order = list.reduce((mx, r) => Math.max(mx, Number.isFinite(Number(r.order)) ? Number(r.order) : 0), 0) + 1;
      }
      const item = normReplaceRule(rule, order);
      if (i >= 0) item.id = list[i].id;
      if (i >= 0) list[i] = item; else list.push(item);
      const mutexDisabled = item.isEnabled === false ? [] : numericTitleRuleMutex(item.id);
      saveConfig();
      return send(res, 200, { ok: true, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/delete" && req.method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      config.online.replaceRules = config.online.replaceRules.filter((r) => !ids.includes(r.id));
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules() });
    }

    /** 置顶 / 置底 / 全量重排 —— 对齐 ReplaceRuleViewModel.toTop/toBottom/upOrder */
    if (p === "/api/replace-rules/order" && req.method === "POST") {
      const body = await readBody(req);
      const list = config.online.replaceRules;
      const act = String(body.action || "");
      if (act === "reindex") {                       // upOrder(): 按当前顺序重编号 1..n
        sortedRules().forEach((r, i) => { r.order = i + 1; });
      } else if (Array.isArray(body.urls || body.ids)) {
        const seq = body.ids || body.urls;           // 拖拽排序：按下标写 order
        const idx = new Map(seq.map((u, i) => [String(u), i + 1]));
        for (const r of list) if (idx.has(String(r.id))) r.order = idx.get(String(r.id));
      } else {
        const r = list.find((x) => x.id === body.id);
        if (!r) return send(res, 404, { error: "规则不存在" });
        if (act === "top") {
          r.order = list.reduce((mn, x) => Math.min(mn, ruleOrder(x)), ruleOrder(r)) - 1;
        } else if (act === "bottom") {
          r.order = list.reduce((mx, x) => Math.max(mx, ruleOrder(x)), ruleOrder(r)) + 1;
        } else {
          return send(res, 400, { error: "未知操作" });
        }
      }
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules() });
    }

    /** 批量启用 / 禁用（legado enableSelection / disableSelection） */
    if (p === "/api/replace-rules/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      for (const r of config.online.replaceRules) if (ids.includes(r.id)) r.isEnabled = body.enabled !== false;
      const mutexDisabled = body.enabled === false ? [] : numericTitleRuleMutex(ids.find((id) => NUMERIC_TITLE_RULE_IDS.includes(String(id))));
      saveConfig();
      return send(res, 200, { ok: true, mutexDisabled, rules: sortedRules() });
    }

    if (p === "/api/replace-rules/test" && req.method === "POST") {
      // legado ReplaceRuleController.testRule：入参 { rule, text }，rule 可以是对象或 JSON 串
      const body = await readBody(req);
      let rule = body.rule;
      if (typeof rule === "string") { try { rule = JSON.parse(rule); } catch { rule = null; } }
      if (!rule || typeof rule !== "object") {
        // 兼容旧前端的三段式入参
        rule = { pattern: body.pattern, replacement: body.replacement, isRegex: body.isRegex };
      }
      if (!replaceRuleValid(rule)) return send(res, 200, { ok: false, error: "替换规则为空或者不满足正则表达式要求" });
      const text = String(body.text == null ? "" : body.text);
      if (!text) return send(res, 200, { ok: false, error: "请先打开一章正文再测试" });
      const timeout = Number(rule.timeoutMillisecond) > 0 ? Number(rule.timeoutMillisecond) : 3000;
      try {
        const out = runOneRule(text, rule);
        return send(res, 200, { ok: true, text: out, timeoutMillisecond: timeout });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }

    /* ---------------- 替换规则导入（legado ReplaceAnalyzer + ImportReplaceRuleDialog） ----------------
     * 支持两种 JSON 形状（对齐 ReplaceAnalyzer.jsonToReplaceRule）：
     *   1) 本项目的完整形状：{ id, name, group, pattern, replacement, scope, scopeTitle,
     *      scopeContent, excludeScope, isEnabled, isRegex, timeoutMillisecond, order }
     *   2) legado 老版共享格式：{ id, regex, replaceSummary, replacement, isRegex, useTo, enable, serialNumber }
     * pattern 为空时才走老格式；老格式里 regex 也为空 → 该条丢弃（格式不对）。
     */

    /** 单条：JSON 对象 → 规则；不合法返回 null */
    function parseOneReplaceRule(raw) {
      if (!raw || typeof raw !== "object") return null;
      const hasPattern = String(raw.pattern == null ? "" : raw.pattern).length > 0;
      let rule;
      if (hasPattern) {
        rule = normReplaceRule(raw, Number(raw.order));
      } else {
        const legacy = {
          id: raw.id,
          pattern: String(raw.regex == null ? "" : raw.regex),
          name: String(raw.replaceSummary == null ? "" : raw.replaceSummary),
          replacement: String(raw.replacement == null ? "" : raw.replacement),
          isRegex: raw.isRegex === true,
          scope: raw.useTo == null ? "" : String(raw.useTo),
          isEnabled: raw.enable === true,
          order: Number(raw.serialNumber),
        };
        if (!legacy.pattern) return null;
        rule = normReplaceRule(legacy, legacy.order);
      }
      if (!replaceRuleValid(rule)) return null;
      return rule;
    }

    /** 文本 → 规则数组。JSON 数组 / JSON 对象 / 单个对象都接受 */
    function parseReplaceRulesText(text) {
      const t = String(text == null ? "" : text).trim();
      let data;
      try { data = JSON.parse(t); }
      catch { throw new Error("格式不对"); }
      const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.replaceRules) ? data.replaceRules
          : (data && Array.isArray(data.data) ? data.data : [data]));
      const out = [];
      for (const item of arr) { const r = parseOneReplaceRule(item); if (r) out.push(r); }
      if (!out.length) throw new Error("格式不对");
      return out;
    }

    /** URL → 文本；对齐 legado：以 #requestWithoutUA 结尾时不带 UA 请求 */
    async function fetchReplaceRulesText(url) {
      const raw = String(url || "").trim();
      if (!/^https?:\/\//i.test(raw)) throw new Error("仅支持 http(s) 地址");
      const noUA = raw.endsWith("#requestWithoutUA");
      const target = noUA ? raw.slice(0, -"#requestWithoutUA".length) : raw;
      const headers = noUA ? {} : { "user-agent": "Mozilla/5.0" };
      const r = await fetch(target, { headers });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    }

    /** 预览：列出规则 + 库里是否已有同 id（legado ReplaceRuleImportComparison） */
    if (p === "/api/replace-rules/preview" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        const rules = parseReplaceRulesText(text);
        const list = rules.map((r) => {
          const old = (config.online.replaceRules || []).find((x) => x.id === r.id);
          let state = "新增";
          if (old) {
            state = (old.pattern !== r.pattern || String(old.replacement) !== String(r.replacement)
              || old.isRegex !== r.isRegex || String(old.scope || "") !== String(r.scope || "")) ? "更新" : "已有";
          }
          return {
            id: r.id, name: r.name, group: r.group || "", pattern: r.pattern,
            replacement: r.replacement, isRegex: r.isRegex, isEnabled: r.isEnabled,
            scope: r.scope || "", exists: !!old, state,
          };
        });
        return send(res, 200, { ok: true, rules: list });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === "/api/replace-rules/import" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        let rules = parseReplaceRulesText(text);
        if (Array.isArray(body.ids)) {
          const want = new Set(body.ids.map(String));
          rules = rules.filter((r) => want.has(String(r.id)));
        }
        const list = config.online.replaceRules;
        let added = 0, updated = 0;
        const group = String(body.group || "").trim();
        for (const r of rules) {
          if (group) {
            if (body.addGroup === true) {
              const gs = String(r.group || "").split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
              if (!gs.includes(group)) gs.push(group);
              r.group = gs.join(",");
            } else {
              r.group = group;
            }
          }
          const i = list.findIndex((x) => x.id === r.id);
          if (i >= 0) { r.order = Number.isFinite(Number(list[i].order)) ? list[i].order : r.order; list[i] = r; updated++; }
          else {
            if (!Number.isFinite(Number(r.order))) {
              r.order = list.reduce((mx, x) => Math.max(mx, Number.isFinite(Number(x.order)) ? Number(x.order) : 0), 0) + 1;
            }
            list.push(r); added++;
          }
        }
        const mutexDisabled = numericTitleRuleMutex();
        saveConfig();
        return send(res, 200, { ok: true, added, updated, mutexDisabled, rules: sortedRules() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    /** 分组：全部分组名（对齐 ReplaceRuleDao.allGroups：按 [,;，；] 拆 + 去重 + 中文排序） */
    function replaceRuleGroups() {
      const set = [];
      for (const r of config.online.replaceRules || []) {
        for (const g of String(r.group == null ? "" : r.group).split(/[,;，；]/)) {
          const t = g.trim();
          if (t && !set.includes(t)) set.push(t);
        }
      }
      return set.sort((a, b) => String(a).localeCompare(String(b), "zh"));
    }

    if (p === "/api/replace-rules/groups" && req.method === "GET") {
      return send(res, 200, { groups: replaceRuleGroups() });
    }

    /** 分组管理：addGroup / upGroup / delGroup（对齐 ReplaceRuleViewModel） */
    if (p === "/api/replace-rules/group" && req.method === "POST") {
      const body = await readBody(req);
      const act = String(body.action || "");
      const list = config.online.replaceRules || [];
      const splitG = (v) => String(v == null ? "" : v).split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
      if (act === "add") {                                  // addGroup：未分组的全部并入该分组
        const g = String(body.group || "").trim();
        if (!g) return send(res, 400, { error: "分组名为空" });
        for (const r of list) if (!splitG(r.group).length) r.group = g;
      } else if (act === "rename") {                        // upGroup：精确成员替换（renameGroupExact）
        const oldG = String(body.oldGroup || "");
        const newG = String(body.newGroup == null ? "" : body.newGroup);
        for (const r of list) {
          const gs = splitG(r.group);
          if (!gs.includes(oldG)) continue;
          const next = gs.filter((x) => x !== oldG);
          for (const ng of splitG(newG)) if (!next.includes(ng)) next.push(ng);
          r.group = next.join(",");
        }
      } else if (act === "delete") {                        // delGroup：移除成员，分组没了就是空了
        const g = String(body.group || "");
        for (const r of list) {
          const gs = splitG(r.group);
          if (!gs.includes(g)) continue;
          r.group = gs.filter((x) => x !== g).join(",");
        }
      } else return send(res, 400, { error: "未知操作" });
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedRules(), groups: replaceRuleGroups() });
    }


    /* ---------------- TXT 目录规则（legado TxtTocRuleController + TxtTocRuleActivity） ----------------
     * 字段清单照 data/entities/TxtTocRule.kt：
     *   id / name / rule / replacement / example / serialNumber / enable（+ order 供排序）
     * 与替换净化同一套交互：搜索 / 勾选 / 启用开关 / 置顶置底 / 删除 / 导入导出 / 恢复默认。
     */

    function txtTocRuleOrder(r) {
      const o = Number(r.order);
      if (Number.isFinite(o)) return o;
      const sn = Number(r.serialNumber);
      return Number.isFinite(sn) ? sn : 0;
    }

    function sortedTxtTocRules() {
      return (config.online.txtTocRules || []).slice().sort((a, b) => txtTocRuleOrder(a) - txtTocRuleOrder(b));
    }

    /** 统一成完整形状；enable 与 legado 同名，不做 isEnabled 映射 */
    function normTxtTocRule(rule, fallbackOrder) {
      const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
      return {
        id: rule.id || ("toc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: String(rule.name || ""),
        rule: String(rule.rule == null ? "" : rule.rule),
        replacement: String(rule.replacement == null ? "" : rule.replacement),
        example: rule.example == null ? "" : String(rule.example),
        serialNumber: num(rule.serialNumber, 0),
        enable: rule.enable !== false,
        order: Number.isFinite(Number(rule.order)) ? Number(rule.order)
          : (fallbackOrder == null ? Number.MIN_SAFE_INTEGER : fallbackOrder),
        builtin: rule.builtin === true,
        builtinSource: rule.builtinSource ? String(rule.builtinSource) : "",
      };
    }

    /** 规则可用性：legado TxtTocRule 允许 rule 为空（默认分章规则），只要求 replacement 语法合法 */
    function txtTocRuleValid(rule) {
      const js = String(rule.replacement == null ? "" : rule.replacement);
      if (js) { try { new vm.Script("(function(){ return eval(" + JSON.stringify(js) + "); })"); } catch (e) { return false; } }
      const re = String(rule.rule == null ? "" : rule.rule);
      if (re && !tryJavaRegex(re, "gm")) return false;
      return true;
    }

    if (p === "/api/txt-toc-rules" && req.method === "GET") {
      ensureBuiltinTxtTocRules();
      return send(res, 200, { rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/builtin/reset" && req.method === "POST") {
      const old = new Map((config.online.txtTocRules || []).map((r) => [String(r.id), r]));
      const custom = (config.online.txtTocRules || []).filter((r) => !r.builtin && !String(r.id).startsWith("builtin-toc-"));
      const restored = builtinTxtTocRules.map((r) => {
        const prev = old.get(String(r.id));
        return { ...r, enable: prev ? prev.enable === true : r.enable === true };
      });
      config.online.txtTocRules = custom.concat(restored);
      config.online.builtinTxtTocRulesInitialized = true;
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, count: restored.length, rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/save" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule || body;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      if (!txtTocRuleValid(rule)) return send(res, 200, { ok: false, error: "规则的正则或 JS 语法不合法" });
      const list = config.online.txtTocRules;
      const i = rule.id ? list.findIndex((r) => String(r.id) === String(rule.id)) : -1;
      let order = rule.order;
      if (!Number.isFinite(Number(order))) {
        order = list.reduce((mx, r) => Math.max(mx, Number.isFinite(Number(r.order)) ? Number(r.order) : 0), 0) + 1;
      }
      const item = normTxtTocRule(rule, order);
      if (i >= 0) item.id = list[i].id;
      if (i >= 0) list[i] = item; else list.push(item);
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    if (p === "/api/txt-toc-rules/delete" && req.method === "POST") {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String);
      config.online.txtTocRules = (config.online.txtTocRules || []).filter((r) => !ids.includes(String(r.id)));
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 置顶 / 置底 / 全量重排 —— 对齐 TxtTocRuleViewModel.toTop/toBottom/upOrder */
    if (p === "/api/txt-toc-rules/order" && req.method === "POST") {
      const body = await readBody(req);
      const list = config.online.txtTocRules || [];
      const act = String(body.action || "");
      if (act === "reindex") {
        sortedTxtTocRules().forEach((r, i) => { r.order = i + 1; });
      } else if (Array.isArray(body.ids)) {
        const idx = new Map(body.ids.map((u, i) => [String(u), i + 1]));
        for (const r of list) if (idx.has(String(r.id))) r.order = idx.get(String(r.id));
      } else {
        const r = list.find((x) => String(x.id) === String(body.id));
        if (!r) return send(res, 404, { error: "规则不存在" });
        if (act === "top") r.order = list.reduce((mn, x) => Math.min(mn, txtTocRuleOrder(x)), txtTocRuleOrder(r)) - 1;
        else if (act === "bottom") r.order = list.reduce((mx, x) => Math.max(mx, txtTocRuleOrder(x)), txtTocRuleOrder(r)) + 1;
        else return send(res, 400, { error: "未知操作" });
      }
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 批量启用 / 禁用（legado enableSelection / disableSelection） */
    if (p === "/api/txt-toc-rules/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String);
      for (const r of config.online.txtTocRules || []) if (ids.includes(String(r.id))) r.enable = body.enabled !== false;
      invalidateFileCache();
      saveConfig();
      return send(res, 200, { ok: true, rules: sortedTxtTocRules() });
    }

    /** 单条规则试切：拿一段文本看它匹配出多少章 */
    if (p === "/api/txt-toc-rules/test" && req.method === "POST") {
      const body = await readBody(req);
      const rule = body.rule;
      if (!rule || typeof rule !== "object") return send(res, 400, { error: "缺少规则" });
      const text = String(body.text == null ? "" : body.text);
      if (!text) return send(res, 200, { ok: false, error: "请先打开一本本地 txt 再测试" });
      if (!txtTocRuleValid(rule)) return send(res, 200, { ok: false, error: "规则的正则或 JS 语法不合法" });
      try {
        const r = analyzeByTocRule(text, { rule: String(rule.rule || ""), replacement: String(rule.replacement || "") }, null);
        const titles = (r.chapters || []).slice(0, 30).map((c) => c.title);
        return send(res, 200, { ok: true, count: (r.chapters || []).length, titles });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }

    /** 导入：JSON 形状照 TxtTocRule.kt（也接受 legado 老版 txtTocRule 分享格式） */
    function parseTxtTocRulesText(text) {
      const t = String(text == null ? "" : text).trim();
      let data;
      try { data = JSON.parse(t); } catch { throw new Error("格式不对"); }
      const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.rules) ? data.rules
          : (data && Array.isArray(data.data) ? data.data : [data]));
      const out = [];
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const rule = normTxtTocRule({
          id: raw.id,
          name: raw.name == null ? "" : raw.name,
          rule: raw.rule == null ? "" : raw.rule,
          replacement: raw.replacement == null ? "" : raw.replacement,
          example: raw.example == null ? "" : raw.example,
          serialNumber: raw.serialNumber,
          enable: raw.enable === true,
          order: Number(raw.serialNumber),
        }, Number(raw.serialNumber));
        if (txtTocRuleValid(rule)) out.push(rule);
      }
      if (!out.length) throw new Error("格式不对");
      return out;
    }

    if (p === "/api/txt-toc-rules/preview" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        const rules = parseTxtTocRulesText(text);
        const list = rules.map((r) => {
          const old = (config.online.txtTocRules || []).find((x) => String(x.id) === String(r.id));
          let state = "新增";
          if (old) state = (String(old.rule) !== r.rule || String(old.replacement) !== r.replacement) ? "更新" : "已有";
          return { id: r.id, name: r.name, rule: r.rule, replacement: r.replacement,
            example: r.example, enable: r.enable, exists: !!old, state };
        });
        return send(res, 200, { ok: true, rules: list });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === "/api/txt-toc-rules/import" && req.method === "POST") {
      const body = await readBody(req);
      let text = body.text != null ? String(body.text) : "";
      const sub = String(body.url || "").trim();
      try {
        if (sub) text = await fetchReplaceRulesText(sub);
        if (!text.trim()) return send(res, 400, { error: "内容为空" });
        let rules = parseTxtTocRulesText(text);
        if (Array.isArray(body.ids)) {
          const want = new Set(body.ids.map(String));
          rules = rules.filter((r) => want.has(String(r.id)));
        }
        const list = config.online.txtTocRules;
        let added = 0, updated = 0;
        for (const r of rules) {
          const i = list.findIndex((x) => String(x.id) === String(r.id));
          if (i >= 0) { r.order = Number.isFinite(Number(list[i].order)) ? list[i].order : r.order; list[i] = r; updated++; }
          else {
            if (!Number.isFinite(Number(r.order))) {
              r.order = list.reduce((mx, x) => Math.max(mx, Number.isFinite(Number(x.order)) ? Number(x.order) : 0), 0) + 1;
            }
            list.push(r); added++;
          }
        }
        invalidateFileCache();
        saveConfig();
        return send(res, 200, { ok: true, added, updated, rules: sortedTxtTocRules() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    /* ---------------- 作者/其它 ---------------- */

    if (p === "/api/online/search/precise" && req.method === "POST") {
      const { source: src, name, author } = await readBody(req);
      const s = sourceMap.get(src);
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().request("preciseSearch", { sourceUrl: getSKey(s), name, author },
          { timeout: config.online.searchTimeout || 60000 });
        return send(res, 200, { ok: true, book: r.result.book });
      } catch (e) { return send(res, 200, { ok: false, error: e.message, code: e.code, data: e.data }); }
    }

    /**
     * 需求 9：导出本书（legado 的「缓存/导出」）。
     * 把整本拉一遍：详情 → 目录 → 逐章正文（复用 contentCache，抓过的不会重复抓），
     * 按「书名\n作者\n\n第N章 标题\n正文」拼成 txt，以附件流回。
     * 目录接口是流式输出，用户能立刻看到下载开始而不是干等。
     */
    if (p === "/api/online/export") {
      const origin = u.searchParams.get("origin") || "";
      const bookUrl = u.searchParams.get("url") || "";
      const src = sourceMap.get(origin);
      if (!src) return send(res, 404, { error: "书源不存在" });
      // 需求 D：书源可标记 noExport —— 整本导出是连续几百次请求，部分站点会风控封 IP
      if (src.noExport === true) return send(res, 200, { ok: false, error: "该书源禁止导出 TXT 小说（站点风控会封 IP）" });
      let book = findOnlineBook(origin, bookUrl);
      try { if (!book) book = await ensureBookInfo(origin, bookUrl); } catch { /* 用现有的 */ }

      let chapters = readTocCache(origin, bookUrl);
      if (!chapters || !chapters.length) {
        try {
          const bi = book || (await ensureBookInfo(origin, bookUrl));
          const r = await getPool().request("chapters", { sourceUrl: origin, book: bi, runPerJs: false, isFromBookInfo: false }, { timeout: 150000 });
          chapters = r.result.chapters || [];
          if (chapters.length) writeTocCache(origin, bookUrl, chapters);
        } catch (e) { return send(res, 200, { ok: false, error: "目录抓取失败：" + e.message }); }
      }
      if (!chapters.length) return send(res, 200, { ok: false, error: "没有解析到章节，无法导出" });

      const safe = String((book && book.name) || "book").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80);
      const rows = [];
      let failed = 0;
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        const next = chapters[i + 1];
        try {
          const rc = await fetchContentCached(
            origin, bookUrl, book || { bookUrl, origin, originName: src.bookSourceName },
            ch, next ? next.url : null, false, 120000,
          );
          const bn = (book && book.name) || "";
          rows.push({ title: applyTitleRules(ch.title, bn, origin) || ch.title || ("第 " + (i + 1) + " 章"), text: applyReplaceRules(rc.content || "", { bookName: bn, origin }) });
        } catch (e) {
          failed++;
          rows.push({ title: ch.title || ("第 " + (i + 1) + " 章"), text: "［本章抓取失败：" + e.message + "］" });
        }
      }
      const head = [
        safe,
        "作者：" + ((book && book.author) || "佚名"),
        "来源：" + src.bookSourceName,
        "章节：" + chapters.length + (failed ? "（失败 " + failed + " 章）" : ""),
        "导出时间：" + new Date().toLocaleString("zh-CN"),
        "",
        "".padEnd(40, "="),
        "",
      ].join("\n");
      const body = head + rows.map((r) => "\n" + r.title + "\n\n" + r.text + "\n").join("");
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(safe + ".txt"),
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    /**
     * 需求 A：导出 TXT —— 流式进度 + 可配并发。
     * legado 侧对应 CacheBook.kt:147 的 .onEachParallel(AppConfig.threadCount)，
     * 线程池上限照 CacheBookService.kt:44（min(threadCount, AppConst.MAX_THREAD=9)）；
     * 进度文案照 CacheBook.kt:157 downloadSummary「正在下载/等待中/失败/成功」。
     * 这里把每章完成情况用 NDJSON 实时推给前端，前端画进度条并最终组装 txt 落地。
     * 并发上限 = 抓取池 worker 数（每个 worker 是一条线程，再多也排不上队）。
     */
    if (p === "/api/online/export/stream" && req.method === "POST") {
      const body = await readBody(req);
      const origin = String(body.origin || "");
      const bookUrl = String(body.url || "");
      const src = sourceMap.get(origin);
      if (!src) return send(res, 404, { error: "书源不存在" });
      if (src.noExport === true) return send(res, 200, { ok: false, error: "该书源禁止导出 TXT 小说（站点风控会封 IP）" });

      const pool = getPool();
      const cap = Math.max(1, pool.size);
      const concurrency = Math.max(1, Math.min(cap, Math.trunc(Number(body.concurrency) || cap)));
      const gap = Math.max(0, Math.min(5000, Math.trunc(Number(body.gap) || 0)));

      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      const write = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch (e) { } };

      let book = findOnlineBook(origin, bookUrl);
      try { if (!book) book = await ensureBookInfo(origin, bookUrl); } catch (e) { }
      let chapters = readTocCache(origin, bookUrl);
      if (!chapters || !chapters.length) {
        try {
          const bi = book || (await ensureBookInfo(origin, bookUrl));
          const r = await pool.request("chapters", { sourceUrl: origin, book: bi, runPerJs: false, isFromBookInfo: false }, { timeout: 150000 });
          chapters = r.result.chapters || [];
          if (chapters.length) writeTocCache(origin, bookUrl, chapters);
        } catch (e) {
          write({ type: "error", error: "目录抓取失败：" + e.message });
          return res.end();
        }
      }
      if (!chapters.length) { write({ type: "error", error: "没有解析到章节，无法导出" }); return res.end(); }

      const safe = String((book && book.name) || "book").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80);
      const total = chapters.length;
      write({
        type: "start", total, name: safe, author: (book && book.author) || "佚名",
        source: src.bookSourceName, concurrency, gap,
      });

      const rows = new Array(total);
      let nextIdx = 0, doneN = 0, failed = 0;
      const worker = async () => {
        for (;;) {
          const i = nextIdx++;
          if (i >= total) return;
          const ch = chapters[i];
          const next = chapters[i + 1];
          let text = "";
          let ok = true;
          try {
            const rc = await fetchContentCached(
              origin, bookUrl, book || { bookUrl, origin, originName: src.bookSourceName },
              ch, next ? next.url : null, false, 120000,
            );
            const bn2 = (book && book.name) || "";
            text = applyReplaceRules(rc.content || "", { bookName: bn2, origin });
          } catch (e) {
            ok = false;
            failed++;
            text = "［本章抓取失败：" + e.message + "］";
          }
          rows[i] = { title: applyTitleRules(ch.title, (book && book.name) || "", origin) || ch.title || ("第 " + (i + 1) + " 章"), text };
          doneN++;
          write({ type: "chapter", index: i, title: rows[i].title, ok, done: doneN, total, failed });
          // 站点风控：连续请求太快会被 ban，用户可设置章间隔（毫秒）
          if (gap > 0 && i + 1 < total) await new Promise((r) => setTimeout(r, gap));
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
      } catch (e) {
        write({ type: "error", error: e.message });
        return res.end();
      }
      const head = [
        safe,
        "作者：" + ((book && book.author) || "佚名"),
        "来源：" + src.bookSourceName,
        "章节：" + total + (failed ? "（失败 " + failed + " 章）" : ""),
        "导出时间：" + new Date().toLocaleString("zh-CN"),
        "",
        "".padEnd(40, "="),
        "",
      ].join("\n");
      const txt = head + rows.map((r) => "\n" + r.title + "\n\n" + r.text + "\n").join("");
      write({ type: "done", ok: true, total, failed, name: safe, txt });
      return res.end();
    }

    if (p === "/api/online/pool") {
      const pool = getPool();
      if (req.method === "POST") {
        // 阅读设置里的「书源并发数」：运行时热改 worker 数量，不需要重启服务。
        const body = await readBody(req).catch(() => ({}));
        const want = Math.max(1, Math.min(32, Math.trunc(Number(body.size) || 0)));
        if (!want) return send(res, 400, { ok: false, error: "并发数需为 1~32 的整数" });
        const applied = await pool.resize(want);
        config.settings.sourcePoolSize = applied;
        saveConfig();
        return send(res, 200, {
          ok: true, size: applied, netSlots: pool.netSlots,
          busy: pool.slots.filter((s) => s.busy).length,
          sources: enabledSources().length,
        });
      }
      return send(res, 200, {
        size: pool.size, netSlots: pool.netSlots,
        busy: pool.slots.filter((s) => s.busy).length,
        sources: enabledSources().length,
      });
    }

    if (p === "/api/online/storage" && req.method === "GET") {
      return send(res, 200, await cacheStorageInfo());
    }

    if (p === "/api/online/storage/open" && req.method === "POST") {
      try {
        await openCacheFolder();
        return send(res, 200, { ok: true, path: CACHE_DIR });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message, path: CACHE_DIR });
      }
    }

    if (p === "/api/online/storage/dir" && req.method === "POST") {
      const body = await readBody(req);
      if (CACHE_DIR_FROM_ENV) {
        return send(res, 200, { ok: false, error: "缓存目录由 READER_CACHE_DIR 环境变量指定，不能在界面修改" });
      }
      const raw = String(body.dir || "").trim();
      const next = raw ? path.resolve(raw) : DEFAULT_CACHE_DIR;
      if (raw && !path.isAbsolute(raw)) {
        return send(res, 200, { ok: false, error: "请输入绝对路径，例如 D:\\ReaderCache" });
      }
      try {
        fs.mkdirSync(next, { recursive: true });
        fs.accessSync(next, fs.constants.W_OK);
      } catch (e) {
        return send(res, 200, { ok: false, error: "目录不可写：" + e.message });
      }
      if (!config.online) config.online = {};
      if (raw) config.online.cacheDir = next;
      else delete config.online.cacheDir;
      try {
        await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
      } catch (e) {
        return send(res, 500, { ok: false, error: "写入配置失败：" + e.message });
      }
      return send(res, 200, {
        ok: true, path: next, defaultDir: DEFAULT_CACHE_DIR, restart: true,
      });
    }

    if (p === "/api/online/cache/clear" && req.method === "POST") {
      const before = await dirStats(CACHE_DIR);
      const pool = getPool();
      await Promise.allSettled(pool.slots.map((s) => s.run("clearCache", {}, 8000)));
      tocMem.clear();
      try {
        await fsp.rm(TOC_DIR, { recursive: true, force: true });
        await fsp.mkdir(TOC_DIR, { recursive: true });
      } catch {}
      await clearContentCache();
      // 清缓存 = 清目录/正文磁盘缓存 + 各 worker 的正文内存缓存 + 发现分类缓存。
      // legado ConfigViewModel.clearCache → BookHelp.clearCache() + 删除 cacheDir，
      // ACache('explore') 随之失效，所以这里必须一起清掉发现分类缓存。
      await clearExploreKindCacheEverywhere();
      // 用户已经明确点了「清理缓存」，这里和启动预热一样在后台重建当前章/下一章。
      // 不阻塞清理接口返回；如果用户马上打开书，同章节的 contentInflight 会复用在飞请求。
      setImmediate(() => {
        warmRecentOnlineReading()
          .catch((e) => console.error("预热最近阅读失败:", e && e.message))
          .finally(() => warmOnlineShelfBooks().catch((e) => console.error("预热书架失败:", e && e.message)));
      });
      const after = await dirStats(CACHE_DIR);
      return send(res, 200, {
        ok: true,
        path: CACHE_DIR,
        freedBytes: Math.max(0, before.bytes - after.bytes),
        warming: true,
      });
    }

    /**
     * 只清 WebView 的可再生缓存（HTTP 缓存 / 代码缓存 / GPU 缓存 / Edge 组件与模型缓存），
     * 保留 Cookies、Local Storage、IndexedDB、Service Worker/Database、Preferences 等登录数据。
     *
     * 对应 legado 的 WebView 缓存清理语义：clearCache(true) 只清网页资源缓存，
     * 不调用 clearHistory / clearFormData / CookieManager.removeAllCookies，
     * 所以用户登录态在清理后依然有效。
     *
     * 必须先 stop() 关闭浏览器：Windows 上 Chromium 持有 Cache_Data 等文件句柄，
     * 进程未退出就删会失败或写坏 profile。
     */
    if (p === "/api/online/webview/cache/clear" && req.method === "POST") {
      const before = browserHost.cacheStats();
      try {
        await browserHost.stop(8000);
      } catch (e) { /* 进程可能本来就没起，继续清理 */ }
      const r = browserHost.clearRegenerableCache();
      const after = browserHost.cacheStats();
      return send(res, 200, {
        ok: true,
        path: before.dir,
        freedBytes: r.freedBytes,
        removed: r.removed,
        failed: r.failed,
        remainingBytes: after.totalBytes,
        keepBytes: after.keep.reduce((a, x) => a + x.bytes, 0),
      });
    }

    /* ---------------- 书源登录（SourceLoginDialog / WebViewLoginFragment） ---------------- */

    /** SourceLoginViewModel.initData：登录 UI 规则 + loginInfo + headerMap */
    if (p === "/api/online/login/info") {
      const url = u.searchParams.get("source") || "";
      const s = sourceMap.get(url);
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().request("loginInfo", { sourceUrl: getSKey(s) }, { timeout: 30000 });
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, uis: [] });
      }
    }

    /** SourceLoginDialog.handleButtonClick / evalUiJs（upLoginData / reLoginView） */
    if (p === "/api/online/login/action" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().runAndSync("loginAction", {
          sourceUrl: getSKey(s),
          action: body.action == null ? null : String(body.action),
          name: body.name == null ? "" : String(body.name),
          result: body.result && typeof body.result === "object" ? body.result : null,
          rowUis: Array.isArray(body.rowUis) ? body.rowUis : null,
          book: body.book || null,
          chapter: body.chapter || null,
          isLongClick: body.isLongClick === true,
        }, { timeout: 60000 });
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, actions: [] });
      }
    }

    /** SourceLoginDialog.login：putLoginInfo + login() */
    if (p === "/api/online/login" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        const r = await getPool().runAndSync("login", {
          sourceUrl: getSKey(s),
          loginData: body.loginData && typeof body.loginData === "object" ? body.loginData : null,
        }, { timeout: 60000 });
        return send(res, 200, { ok: true, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, code: e.code, actions: [] });
      }
    }

    /** 清除登录：removeLoginInfo + removeLoginHeader + removeCookie */
    if (p === "/api/online/login/logout" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      try {
        // legado 的 ✓ 登录 在 loginData 为空时只调 removeLoginInfo()（不删 Cookie、不删请求头）；
        // 只有工具栏的 ⊘ 才是「清除登录信息与 Cookie」。这里把两个开关透传给 worker。
        const r = await getPool().broadcast("loginLogout", {
          sourceUrl: getSKey(s),
          clearCookies: body.clearCookies !== false,
          clearHeaders: body.clearHeaders !== false,
        }, { timeout: 20000 });
        await getPool().refreshStateFile().catch(() => 0);
        return send(res, 200, { ok: true, workers: r });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    /* ---------------- 内置浏览器（WebViewActivity 等价物） ---------------- */

    /**
     * 打开 real browser tab。loginUrl 是相对路径时按 NetworkUtils.getAbsoluteURL
     * 用书源 bookSourceUrl 拼绝对地址（得奇小说这类书源就是相对路径）。
     */
    if (p === "/api/online/webview/open" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      const raw = String(body.url || body.loginUrl || s.loginUrl || "").trim();
      if (!/^https?:/i.test(raw) && !raw) return send(res, 400, { error: "缺少要打开的地址" });
      const target = /^https?:/i.test(raw) ? raw : new URL(raw, new URL(String(s.bookSourceUrl).split(",{")[0])).toString();
      let headerMap = {};
      try {
        const info = await getPool().request("loginInfo", { sourceUrl: getSKey(s) }, { timeout: 30000 });
        headerMap = (info.result && info.result.headerMap) || {};
      } catch (e) { /* 没有 header 也能打开页面 */ }
      try {
        const tab = await browserHost.open({
          sourceUrl: getSKey(s),
          url: target,
          title: String(body.title || s.bookSourceName || ""),
          headers: headerMap,
          width: Number(body.width) || 1280,
          height: Number(body.height) || 800,
        });
        return send(res, 200, { ok: true, tabId: tab.id, width: tab.width, height: tab.height, url: target });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    /** 帧长轮询（前端 canvas 渲染用）。 */
    if (p === "/api/online/webview/frame") {
      const tabId = u.searchParams.get("tab") || "";
      const since = Number(u.searchParams.get("since")) || 0;
      const timeout = Number(u.searchParams.get("timeout")) || 20000;
      if (!browserHost.list().some((t) => t.id === tabId)) return send(res, 404, { error: "窗口不存在" });
      const frame = await browserHost.waitFrame(tabId, since, timeout);
      if (!frame) return send(res, 200, { ok: true, closed: true });
      return send(res, 200, {
        ok: true, seq: frame.seq, data: frame.data, width: frame.width, height: frame.height,
        stale: !!frame.stale,
      });
    }

    /** 输入回灌：Input.dispatchMouseEvent / dispatchKeyEvent / insertText */
    if (p === "/api/online/webview/input" && req.method === "POST") {
      const body = await readBody(req);
      const okInput = await browserHost.input(String(body.tab || ""), body.event || {});
      return send(res, 200, { ok: okInput });
    }

    /** 手动回写 cookie（「登录」按钮：先把浏览器里的 cookie 落进 CookieStore 再跑 login()） */
    if (p === "/api/online/webview/cookies" && req.method === "POST") {
      const body = await readBody(req);
      const s = sourceMap.get(String(body.source || ""));
      if (!s) return send(res, 404, { error: "书源不存在" });
      const tabId = String(body.tab || "");
      const cookie = await browserHost.cookies(tabId).catch(() => "");
      // WebViewActivity.onPageFinished(url)：cookie 落到**页面真实 url** 的二级域名桶，
      // 不是 bookSourceUrl。光遇聚合的 bookSourceUrl 是「光遇聚合」字面量，若拿它当归一化
      // 输入，写进去的桶和书源 getToken() 读的桶对不上（详见 src/js-runtime.mjs CookieStore）。
      const tab = browserHost.list().find((x) => x.id === tabId) || null;
      try {
        const r = await getPool().runAndSync("loginCookie", {
          sourceUrl: getSKey(s),
          domain: subDomainOf((tab && (tab.url || tab.sourceUrl)) || tabId || getSKey(s)),
          cookie: cookie || "",
          loginData: body.loginData && typeof body.loginData === "object" ? body.loginData : null,
        }, { timeout: 30000 });
        return send(res, 200, { ok: true, cookie, ...r.result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, cookie });
      }
    }

    /** 关闭窗口（close() 内部会先同步一次 cookie） */
    if (p === "/api/online/webview/close" && req.method === "POST") {
      const body = await readBody(req);
      const tabId = String(body.tab || "");
      const st = webviewLogin[tabId] || null;
      const okClose = await browserHost.close(tabId).catch(() => false);
      delete webviewLogin[tabId];
      return send(res, 200, { ok: okClose, loginInfo: st && st.loginInfo, hasLoginHeader: !!(st && st.hasLoginHeader) });
    }

    if (p === "/api/online/webview/list") {
      return send(res, 200, { ok: true, tabs: browserHost.list() });
    }

    /* ---------------- 图片代理（在线封面） ---------------- */

    /**
     * 书源 HTML 弹窗里的跨域 fetch/XHR 代理（说明见 cookieHeaderFor）。
     * public/online.js 的 chInjectBridge 把 iframe 里跨域请求改写成这个接口。
     */
    if (p === "/api/online/proxy") {
      const target = u.searchParams.get("url") || "";
      if (!/^https?:/i.test(target)) return send(res, 400, { error: "仅支持 http(s)" });
      if (!isProxyTargetAllowed(target)) return send(res, 403, { error: "禁止代理本机地址" });
      let origin = "";
      try { origin = new URL(target).origin; } catch {}
      try {
        const headers = { "user-agent": PROXY_UA, referer: origin + "/" };
        for (const k of PROXY_REQ_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];
        const ck = cookieHeaderFor(target);
        if (ck) headers.cookie = ck;
        const method = String(req.method || "GET").toUpperCase();
        const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(await rawBody(req));
        const r = await fetch(target, { method, headers, body, redirect: "follow" });
        let buf = Buffer.from(await r.arrayBuffer());
        let contentType = r.headers.get("content-type") || "application/octet-stream";
        // 评论页的 Font Awesome 样式表通常用 ../webfonts/*.woff2；
        // 重写后字体也走本代理，避免图标退化成方框或受跨域策略拦截。
        if (/text\/css/i.test(contentType) || /\.css(?:[?#]|$)/i.test(r.url || target)) {
          const css = new TextDecoder().decode(buf);
          buf = Buffer.from(rewriteProxyCssUrls(css, r.url || target), "utf8");
          contentType = "text/css; charset=utf-8";
        }
        res.writeHead(r.status, {
          "content-type": contentType,
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        return res.end(buf);
      } catch (e) { return send(res, 502, { error: (e && e.message) || String(e) }); }
    }

    if (p === "/api/online/image") {
      const target = u.searchParams.get("url") || "";
      if (!/^https?:/i.test(target)) return send(res, 400, { error: "仅支持 http(s)" });
      try {
        const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0", referer: new URL(target).origin } });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          "content-type": r.headers.get("content-type") || "image/jpeg",
          "cache-control": "public, max-age=86400",
        });
        return res.end(buf);
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    /** 前端资源指纹：client 定时比对，一旦 public/* 有新版本就自动重载。
     *  长期开着的标签页会一直跑旧 JS/CSS，这里避免「改了代码但页面没反应」。 */
    /* 实例标识：exe 启动时用它判断「目标端口上的服务是不是同一个实例」。
       只比对数据目录 —— 同一个数据目录 = 同一个实例（重复双击），
       不同数据目录 = 另一个 Reader（换端口启动，不要误判成「已在运行」）。 */
    if (p === "/api/instance") {
      return send(res, 200, {
        app: "Reader",
        dataDir: __dirname,
        sea: IS_SEA,
        port: activePort,
        pid: process.pid,
      });
    }

    if (p === "/api/build") {
      // exe 模式下前端资源固定嵌在 exe 里，不会热更；返回固定 token，
      // 避免 readdir 失败返回空串导致前端每次轮询都判定「有新版本」而重载。
      if (IS_SEA) return send(res, 200, { token: "sea-" + (process.env.READER_BUILD_TOKEN || "1") });
      try {
        const names = (await fsp.readdir(PUBLIC_DIR)).filter((n) => /\.(?:js|css|html)$/i.test(n)).sort();
        const parts = [];
        for (const n of names) {
          const st = await fsp.stat(path.join(PUBLIC_DIR, n));
          parts.push(n + ":" + st.mtimeMs + ":" + st.size);
        }
        return send(res, 200, { token: crypto.createHash("md5").update(parts.join("|")).digest("hex") });
      } catch (e) { return send(res, 200, { token: "" }); }
    }

    /** 优雅关闭：Windows taskkill /f 不走 SIGTERM，.bat 改为先调这个接口再兜底强杀 */
    if (p === "/api/shutdown" && req.method === "POST") {
      const origin = req.headers.origin || "";
      if (origin && origin !== `http://127.0.0.1:${activePort}` && origin !== `http://localhost:${activePort}`) {
        return send(res, 403, { error: "禁止跨站关闭服务" });
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }), () => setTimeout(shutdown, 100));
      return;
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "未知接口" });
    return await serveStatic(res, p);
  } catch (e) {
    return send(res, 500, { error: e.message, stack: process.env.READER_DEBUG ? e.stack : undefined });
  }
});

// WebSocket：legado 的 /searchBook 与 /bookSourceDebug
server.on("upgrade", (req, socket) => {
  let handled = false;
  try { handled = getLegadoApi().handleUpgrade(req, socket); }
  catch { handled = false; }
  if (!handled) { try { socket.destroy(); } catch {} }
});

/**
 * 探测某个端口上是否已经跑着「同一个数据目录」的 Reader 实例。
 *
 * 为什么不能只看「端口有响应」：用户可能同时开着源码模式的调试服务、
 * 或另一个数据目录的 exe。那些情况下应该换个端口自己跑，而不是
 * 打开别人的页面然后退出（用户会以为「exe 没生效」）。
 *
 * 判据 = 对方 /api/instance 的 dataDir 与本进程一致。
 */
function probeSameInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/instance", timeout: 800 }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(!!(j && j.app === "Reader" && j.dataDir === __dirname));
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * 启动入口。
 *
 * 先探测目标端口：
 *   · 是同一个实例（同数据目录）→ 打开它的页面后退出，不重复起服务；
 *   · 是别的程序 / 别的数据目录 → 继续 listen，让 error 处理去换端口。
 * 这样「7788 被别的东西占用」时会自动换端口，而不是误判成「已在运行」。
 */
(async () => {
  if (await probeSameInstance(PORT)) {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`Reader 已在运行: ${url}`);
    if (IS_SEA || process.env.READER_OPEN_BROWSER === "1") {
      try {
        spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch { /* 打不开就算了，上面已打印地址 */ }
    }
    setTimeout(() => process.exit(0), IS_SEA ? 1500 : 0);
    return;
  }
  server.listen(PORT, "127.0.0.1", onListening);
})();

/**
 * 监听成功后的初始化。只执行一次。
 *
 * 为什么需要这个标记：换端口时会再次调用 server.listen(..., onListening)，
 * 而 Node 会把回调注册成新的 'listening' 监听器、不清除旧的，
 * 于是打印两遍启动日志、预热也跑两次。用标记挡住重复执行。
 */
let listeningInited = false;
function onListening() {
  if (listeningInited) return;
  listeningInited = true;
  // PORT=0 时由系统分配，这里回填真实端口，后续所有 URL 都用它
  const addr = server.address();
  activePort = (addr && typeof addr === "object" && addr.port) ? addr.port : PORT;
  console.log(`Reader 已启动: http://127.0.0.1:${activePort}`);
  if (activePort !== 7788) {
    console.log(`（当前端口 ${activePort}；改端口：命令行加 --port 8080，或在 exe 同级放 port.txt 写一个数字）`);
  }
  console.log(`书源组「${activeSourceGroup()?.name || "默认"}」：${sources.length} 个（启用 ${enabledSources().length}）`);
  /* exe 便携版：双击后自动打开浏览器。
     用户拿到的只有一个 Reader.exe，不打开浏览器的话不知道要访问哪个地址。
     开发模式（npm start / 启动Reader.bat）不自动开，避免每次重启都弹窗；
     需要时用 READER_OPEN_BROWSER=1 强制打开。 */
  if (IS_SEA || process.env.READER_OPEN_BROWSER === "1") {
    const url = `http://127.0.0.1:${activePort}/`;
    try {
      // 用系统默认浏览器打开（Windows: start 是 cmd 内置命令，必须走 cmd）
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      console.log(`（自动打开浏览器失败，请手动访问 ${url}）`);
    }
  }
  // 等监听真正可用后预热。放 setImmediate 是为了让页面初始 /api/state、
  // /api/online/shelf 先拿到事件循环；预热全程异步，不阻塞启动。
  setImmediate(() => {
    warmRecentOnlineReading()
      .catch((e) => console.error("启动预热最近阅读失败:", e && e.message))
      .finally(() => warmOnlineShelfBooks().catch((e) => console.error("启动预热书架失败:", e && e.message)));
  });
}

/* 端口被占用时的处理。

   「同一个实例」的情况已经在启动前被 probeSameInstance() 拦掉了，
   走到这里说明端口被**别的程序**（或另一个数据目录的 Reader）占用 ——
   此时应该换个端口自己跑，而不是报错退出。

   注意：换端口后会重新挂这个监听（见 tryListenNextPort），
   所以必须写成具名函数，不能用匿名箭头。 */
function onServerError(e) {
  if (e && e.code === "EADDRINUSE") {
    if (tryListenNextPort()) return;
    console.error(`端口 ${activePort} 及其后续 20 个端口都被占用，请手动指定（--port 9000）`);
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  console.error("启动失败: " + (e && e.message));
  process.exit(1);
}
server.on("error", onServerError);

/**
 * 端口被占用时向后找下一个可用端口（最多试 20 个）。
 */
let portRetry = 0;
function tryListenNextPort() {
  if (portRetry >= 20) {
    console.error("连续 20 个端口都被占用，请手动指定一个空闲端口（--port 9000）");
    return false;
  }
  portRetry++;
  const next = activePort + 1;
  if (next > 65535) return false;
  console.log(`端口 ${activePort} 被占用，改用 ${next} …`);
  activePort = next;
  // 摘掉旧监听后重新挂一次：新端口若再被占用，onServerError 会继续往后找
  server.removeAllListeners("error");
  server.on("error", onServerError);
  // listen 回调必须是 onListening：否则换了端口不会打印地址 / 开浏览器 / 预热
  server.listen(activePort, "127.0.0.1", onListening);
  return true;
}

function shutdown() {
  flushConfigNow();
  closePool();
  try { browserHost.closeAll(); } catch (e) { /* ignore */ }
  try { server.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);   // Windows 关闭控制台窗口
process.on("SIGBREAK", shutdown); // Windows Ctrl+Break

loadSources();
// 书架里可能残留「origin 指向错书源」的历史记录（早期版本搜索结果合并的 bug 所致），
// 启动时按 bookUrlPattern 纠正一次，否则读目录时会拿错书源解析。
repairAllOnlineBooks();
getPool();
