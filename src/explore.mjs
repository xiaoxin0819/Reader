// explore.mjs —— 1:1 移植 legado help/source/BookSourceExtensions.kt
//   exploreKinds() / exploreKindsJson() / clearExploreKindsCache()
// ACache("explore") 落盘（legado utils/ACache.kt：一个 key 一个文件，key 为 md5(bookSourceUrl + exploreUrl)）。
import crypto from 'node:crypto';
import { jsRuntime } from './rule-engine.mjs';
import { isJsonArray } from './net-utils.mjs';
import { wrapSource, wrapNetwork } from './wrap.mjs';
import { JavaBridgeBase } from './js-runtime.mjs';
import { mixJavaBridge } from './java-bridge.mjs';
import { createAnalyzeRule } from './rule-engine.mjs';
import { InfoMap } from './web-book.mjs';
import { getACache } from './acache.mjs';

/** legado: private val aCache by lazy { ACache.get("explore") } —— 落盘，跨 worker / 跨重启复用 */
const aCache = getACache('explore');
/** exploreKindsMap（内存缓存） */
const exploreKindsMap = new Map();
/** exploreInfoMapList：bookSourceUrl -> InfoMap（跨调用共享，legado 里是静态 map） */
const exploreInfoMapList = new Map();

/**
 * 「用户主动刷新过」的 key → 时间戳。
 * legado ExploreAdapter.refreshExplore()（源菜单「刷新发现」）是
 *   clearExploreKindsCache() → exploreKinds()
 * 第二次执行时 ACache.put **直接覆盖**，不做任何新旧比较。
 * 桌面端多出来的 keepBetterKinds() 自愈逻辑只能作用于「非用户刷新」的重算：
 * 否则登录番茄后新脚本吐出的番茄书架/分组入口（url 入口数比登录前的旧缓存少）
 * 会被旧缓存一直挡住 —— 表现就是「登录了番茄，番茄书架还是不出来」。
 */
const refreshedKeys = new Map();
/** 标记有效期：用户点刷新时广播到所有 worker，只有真正重算的那个 worker 会消费掉 */
const REFRESH_FLAG_TTL = 5 * 60 * 1000;

export function md5Encode(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function exploreKindsKey(source) {
  return md5Encode(String(source.bookSourceUrl || '') + String(source.exploreUrl == null ? '' : source.exploreUrl));
}

/**
 * 保持 legado 语义：explore 脚本里的 java.getSource() 等走 source 包装。
 * ctx.infoMap 由服务端下发（跨 worker 共享），worker 内不再各存一份。
 */
export function getExploreInfoMap(source, ctx) {
  const key = String(source.bookSourceUrl || '');
  let m = exploreInfoMapList.get(key);
  if (!m) {
    m = new InfoMap(key, ctx && ctx.services ? ctx.services.cache : undefined);
    exploreInfoMapList.set(key, m);
  }
  // 前端持有一份权威副本（legado 里 InfoMap 是跨调用共享的 MutableMap，
  // 桌面端每个 worker 各有一份，所以以请求带过来的那份为准，否则会读到别的 worker 的陈旧值）。
  const incoming = ctx && ctx.infoMap;
  if (incoming && typeof incoming === 'object') { m.clear(); m.putAll(incoming); }
  return m;
}

function evalSourceJs(ctx, source, code, extraBindings = {}) {
  const env = {
    cookieStore: ctx.services.cookieStore,
    cache: ctx.services.cache,
    logger: ctx.logger,
    network: ctx.services.network,
    defaultUA: undefined,
  };
  env.evalJs = (c, result, extra) => ctx.evalJs ? ctx.evalJs(c, result, extra) : undefined;
  // legado 里发现页脚本的 java.toast/longToast 是真的弹 Toast（如「发现样式获取失败」）。
  // 桌面端把它塞进本次任务的 actions，前端 applyActions 会照常 toast 出来；
  // 没有 action 通道的任务（搜索/正文）保持只记日志，避免误报。
  env.onToast = (msg) => {
    if (Array.isArray(ctx.browserActions)) {
      ctx.browserActions.push({ type: 'toast', msg: String(msg == null ? '' : msg) });
    }
  };
  const wrapped = wrapSource(source, env);
  const bindings = {
    java: wrapped,
    source: wrapped,
    sourceApi: wrapped,
    baseUrl: source.bookSourceUrl,
    cookie: ctx.services.cookieStore,
    cache: ctx.services.cache,
  };
  // legado 的 ScriptBindings.put(key, value)（写 binding 表）
  bindings.put = (k, v) => { bindings[k] = v; return v; };
  Object.assign(bindings, extraBindings);
  return jsRuntime.run(String(code), bindings, {
    key: String(source.bookSourceUrl || 'source'),
    jsLib: source.jsLib,
  });
}

/**
 * 归一化为 ExploreKind（legado data/entities/rule/ExploreKind.kt 的默认值）。
 * 源里可能写 title 也可能写 name，两者都认，统一输出 title。
 */
function toExploreKind(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const title = it.title != null ? it.title : it.name;
  return {
    title: title == null ? '' : String(title),
    url: it.url == null ? null : String(it.url),
    type: it.type == null ? 'url' : String(it.type),
    action: it.action == null ? null : String(it.action),
    chars: it.chars == null ? null : it.chars,
    default: it.default == null ? null : String(it.default),
    viewName: it.viewName == null ? null : String(it.viewName),
    style: it.style == null ? null : it.style,
  };
}

/**
 * BookSource.exploreKinds() —— 解析发现分类
 * @returns {Array<ExploreKind>} ExploreKind = {title,url,type,action,chars,default,viewName,style}
 *   legado data/entities/rule/ExploreKind.kt
 *
 * 缓存语义严格对齐 legado（BookSourceExtensions.kt）：
 *   aCache.getAsString(key)?.takeIf { it.isNotBlank() } ?: run { 执行脚本; aCache.put(key, it) }
 * 即命中就永远不重算 —— aCache 不带过期时间，bookSourceUrl + exploreUrl 一变 md5 key 就变。
 * 桌面端额外加了两条保险（不影响命中即用的语义）：
 *   1. keepBetterKinds()：脚本重算出残缺分类时不覆盖已有的完整分类；
 *   2. <key>.good：留一份「最近一次完整结果」，源站故障也能自愈。
 */

function parseExploreKindsRule(ruleStr) {
  const kinds = [];
  if (isJsonArray(ruleStr)) {
    for (const it of JSON.parse(ruleStr)) kinds.push(toExploreKind(it));
  } else {
    for (const kindStr of String(ruleStr).split(/(?:&&|\n)+/)) {
      const cfg = kindStr.split('::');
      kinds.push(toExploreKind({ title: cfg[0], url: cfg.length > 1 ? cfg[1] : null }));
    }
  }
  return kinds;
}

/**
 * 「完整度」评分：带 url 的 kind（榜单 / 发现页入口）是源站正常的关键标志。
 * 光遇聚合 gyks.cf 整站 502 时，exploreUrl 脚本里的 try/catch 会吞掉异常，
 * 只吐出筛选框和几个按钮，第一批 url 入口（番茄榜单等）全部消失。
 */
function kindScore(kinds) {
  let urls = 0;
  for (const k of kinds || []) if (k && k.url) urls += 1;
  return { urls: urls, total: (kinds && kinds.length) || 0 };
}

/**
 * 只在两份分类里挑更完整的那份。
 * 先比 url 入口数（榜单有 / 没有是质变），再比总数（筛选框变少也是残缺）。
 * 源站正常时分类是增多的，新结果胜出；源站故障时保留旧缓存，不至于越刷越空。
 */
function keepBetterKinds(staleKinds, freshKinds) {
  if (!staleKinds || !staleKinds.length) return freshKinds;
  if (!freshKinds || !freshKinds.length) return staleKinds;
  const a = kindScore(staleKinds);
  const b = kindScore(freshKinds);
  if (a.urls !== b.urls) return a.urls > b.urls ? staleKinds : freshKinds;
  return a.total > b.total ? staleKinds : freshKinds;
}

/**
 * 读一份分类缓存：good=false 读主缓存 ACache，good=true 读 <key>.good（最近一次完整结果）。
 * 内容不是 JSON 数组 / 读不到时返回 null。
 */
function readKindFile(key, good) {
  const str = good ? aCache.getGoodAsString(key) : aCache.getAsString(key);
  if (!str || !String(str).trim()) return null;
  try { return { kinds: parseExploreKindsRule(str), ruleStr: String(str) }; } catch { return null; }
}

/**
 * 主缓存与 .good 里取更完整的那份。
 * 主缓存存在但比 .good 残缺时，用 .good 覆盖回去（自愈）。
 * 注意：主缓存**不存在**时不在这里补写 —— 那说明是「刷新发现页」刚清过缓存，
 * 必须让 exploreKinds() 重新执行脚本，源站恢复后才能把分类升级回来。
 */
function bestCachedKinds(key) {
  const main = readKindFile(key, false);
  const good = readKindFile(key, true);
  if (!main) return good;
  if (!good) return main;
  if (keepBetterKinds(good.kinds, main.kinds) === good.kinds) {
    if (good.ruleStr !== main.ruleStr) aCache.put(key, good.ruleStr);
    return good;
  }
  return main;
}

function errorExploreKind(e) {
  return toExploreKind({ title: `ERROR:${e && e.message}`, url: (e && e.stack) || String(e) });
}

export function exploreKinds(ctx, source) {
  const key = exploreKindsKey(source);
  const remember = (kinds) => {
    exploreKindsMap.set(key, { at: Date.now(), kinds });
    return kinds;
  };
  const mem = exploreKindsMap.get(key);
  if (mem) {
    // legado: exploreKindsMap[key]?.let { return it } —— 内存命中直接返回。
    // 唯一例外：内存里是残缺结果、而磁盘 / <key>.good 上还留着更完整的那份，用更完整的。
    const disk = bestCachedKinds(key);
    if (disk && kindScore(disk.kinds).urls > kindScore(mem.kinds).urls) return remember(disk.kinds);
    return mem.kinds;
  }

  const exploreUrl = source.exploreUrl;
  if (!exploreUrl || !String(exploreUrl).trim()) return [];
  const eu = String(exploreUrl);
  const scripted = /^@js:/i.test(eu) || /^<js>/i.test(eu);


  if (scripted) {
    // legado BookSourceExtensions.exploreKinds()：
    //   aCache.getAsString(key)?.takeIf { it.isNotBlank() } ?: run { 执行脚本; aCache.put(key, it) }
    // 命中就**永远**不重算（aCache 不带过期时间）。之前这里加了 30 分钟 TTL 重算，
    // 源站 502 时脚本吞掉异常只吐出筛选框，把完整分类覆盖成了残缺版 —— 这就是
    // 「光遇发现页内容又不见了」的直接原因。
    // legado 只认主缓存：命中就永远不重算。
    const mainCached = readKindFile(key, false);
    if (mainCached && mainCached.kinds.length) return remember(mainCached.kinds);
    // 主缓存为空（首次导入 / 点「刷新发现页」/ 改过书源）才执行脚本。
    // 此时拿上次"最近一次完整结果"做兜底：源站故障返回残缺版时不至于把完整版弄丢。
    let staleKinds = null;
    let staleRuleStr = null;
    const goodCached = readKindFile(key, true);
    if (goodCached) { staleKinds = goodCached.kinds; staleRuleStr = goodCached.ruleStr; }
    const flagAt = refreshedKeys.get(key) || 0;
    const userRefresh = Date.now() - flagAt < REFRESH_FLAG_TTL;
    refreshedKeys.delete(key);
    try {
      const infoMap = getExploreInfoMap(source, ctx);
      const code = /^@js:/i.test(eu) ? eu.substring(4) : eu.substring(4, eu.lastIndexOf('<'));
      const ruleStr = String(evalSourceJs(ctx, source, code, { infoMap }) ?? '').trim();
      const kinds = parseExploreKindsRule(ruleStr);
      // 用户主动刷新 → 照 legado refreshExplore() 直接采用脚本新结果（ACache.put 覆盖，不比较）。
      // 唯一保留的保险：结果是空的 / 明显退化（源站 502 时脚本 try/catch 只吐出筛选框，
      // 一个 url 入口都没有）时退回 .good，避免「点一次刷新，榜单全没了」。
      const fScore = kindScore(kinds);
      const sScore = kindScore(staleKinds);
      const degenerate = !kinds.length || (fScore.urls === 0 && sScore.urls > 0);
      const kept = userRefresh && !degenerate ? kinds : keepBetterKinds(staleKinds, kinds);
      if (kept === staleKinds && staleRuleStr) {
        // 新结果是残缺的：把上次完整的那份写回主缓存，实现自愈。
        aCache.put(key, staleRuleStr);
        return remember(staleKinds);
      }
      aCache.put(key, ruleStr);
      aCache.putGood(key, ruleStr);
      return remember(kinds);
    } catch (e) {
      if (staleKinds && staleKinds.length) {
        aCache.put(key, staleRuleStr);
        return remember(staleKinds);
      }
      return remember([errorExploreKind(e)]);
    }
  }

  try {
    return remember(parseExploreKindsRule(eu));
  } catch (e) {
    return remember([errorExploreKind(e)]);
  }
}

/** BookSource.exploreKindsJson() */
export function exploreKindsJson(source) {
  const key = exploreKindsKey(source);
  const cached = aCache.getAsString(key);
  if (cached && isJsonArray(cached)) return String(cached);
  // 主缓存被清掉但 .good 还在时，前端仍然应该拿到完整分类（只读，不回写主缓存）。
  const good = aCache.getGoodAsString(key);
  if (good && isJsonArray(good)) return String(good);
  const eu = source.exploreUrl;
  if (eu && isJsonArray(eu)) return String(eu);
  return '';
}

/** BookSource.clearExploreKindsCache() */
export function clearExploreKindsCache(source) {
  const key = exploreKindsKey(source);
  // legado 的 clearExploreKindsCache() 会连磁盘 aCache 一起删掉，下次访问重新执行脚本。
  // 照做（否则「刷新发现页」永远拿到旧结果），但保留 <key>.good 这份最近一次完整结果：
  // 脚本重算出残缺分类时用它兜底，源站恢复后又能自动升级成新的完整分类。
  aCache.remove(key);
  exploreKindsMap.delete(key);
  exploreInfoMapList.delete(String(source.bookSourceUrl || ''));
  // 打「用户主动刷新」标记：下一次脚本重算走 legado 的覆盖语义（见 refreshedKeys 注释）
  refreshedKeys.set(key, Date.now());
}

/** 清空全部缓存（维护用） */
export function clearAllExploreCache() {
  aCache.clear();
  exploreKindsMap.clear();
  exploreInfoMapList.clear();
}

export { exploreInfoMapList };

/* ============================================================
 *  发现页按钮/输入框/下拉 的 action 执行
 *  1:1 移植 legado ExploreAdapter.kt:502-528
 *
 *  evalUiJs(jsStr, source, infoMap)      → viewName 求值，java 仍是 source
 *  evalButtonClick(jsStr, source, infoMap, name, java)
 *                                       → java 换成 SourceLoginJsExtensions
 * ============================================================ */

/**
 * InfoMap 在 legado 里是 MutableMap，脚本直接写 `infoMap['键'] = 值`。
 * JS 对象做不到这一点，所以套一层 Proxy 让下标读写落到 map 里。
 */
const infoMapProxyCache = new WeakMap();
export function infoMapProxy(m) {
  if (!m || typeof m !== 'object') return m;
  const cached = infoMapProxyCache.get(m);
  if (cached) return cached;
  const own = (t, p) => Object.prototype.hasOwnProperty.call(t, p) || (p in t);
  const proxy = new Proxy(m, {
    get(t, p, r) {
      if (typeof p === 'string' && !own(t, p)) return t.get(p);
      return Reflect.get(t, p, r);
    },
    set(t, p, v) {
      if (typeof p === 'string' && !own(t, p)) { t.put(p, v); return true; }
      return Reflect.set(t, p, v);
    },
    has(t, p) {
      if (typeof p === 'string' && !own(t, p)) return t.containsKey(p);
      return Reflect.has(t, p);
    },
    deleteProperty(t, p) {
      if (typeof p === 'string' && !own(t, p)) { t.remove(p); return true; }
      return Reflect.deleteProperty(t, p);
    },
    ownKeys(t) {
      const keys = new Set(Reflect.ownKeys(t));
      for (const k of t.keys()) keys.add(k);
      return [...keys];
    },
    getOwnPropertyDescriptor(t, p) {
      const d = Reflect.getOwnPropertyDescriptor(t, p);
      if (d) return d;
      if (typeof p === 'string' && t.containsKey(p)) {
        return { value: t.get(p), writable: true, enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
  infoMapProxyCache.set(m, proxy);
  return proxy;
}

/** 把 source 包装成一次 action 执行用的环境（java = SourceLoginJsExtensions 等价物） */
function makeActionJava(ctx, source, wrapped, infoMap, key) {
  const logger = (ctx && ctx.logger) || null;
  const push = (a) => { if (ctx && Array.isArray(ctx.exploreActions)) ctx.exploreActions.push(a); };
  const str = (v) => (v === null || v === undefined ? null : String(v));
  return mixJavaBridge(wrapped, {
    // ---- SourceLoginJsExtensions ----
    searchBook(key2, searchScope) {
      const k = String(key2 == null ? '' : key2).trim();
      const scope = str(searchScope);
      if (!k) { push({ type: 'toast', msg: '关键词为空' }); return ''; }
      // legado: SearchActivity.start(it, key, searchScope)；scope 为 "源名::源key"
      let scopeUrl = null, scopeName = null;
      if (scope && scope.includes('::')) {
        const i = scope.indexOf('::');
        scopeName = scope.slice(0, i);
        scopeUrl = scope.slice(i + 2);
      } else if (scope) scopeName = scope;
      push({ type: 'searchBook', key: k, scope, scopeUrl, scopeName, sourceUrl: key });
      if (logger) logger(`[explore] java.searchBook("${k}", "${scope || ''}") → 打开搜索`);
      return '';
    },
    // RssJsExtensions.open(name, url, title, origin)（ui/rss/read/RssJsExtensions.kt:99）：
    // login / search / explore / sort / rss 五个分支，这里只原样回传参数，
    // 由前端 runOpenAction 按 legado 的 when (name) 分派（避免后端去开界面）。
    open(name, url, title, origin) {
      const n = String(name == null ? '' : name);
      push({ type: 'open', name: n, url: str(url), title: str(title), origin: str(origin), sourceUrl: key });
      if (logger) logger(`[explore] java.open("${n}")`);
      return '';
    },
    // JsExtensions.openUrl(url, mimeType)（help/JsExtensions.kt:1173）：legado 弹
    // OpenUrlConfirmActivity，桌面端交给前端（http(s) → 内置浏览器，其它 scheme → 确认框）。
    openUrl(url, mimeType) {
      const u = str(url);
      if (u) push({ type: 'openUrl', url: u, mimeType: str(mimeType), sourceUrl: key });
      return '';
    },
    refreshExplore() {
      push({ type: 'refreshExplore', sourceUrl: key });
      // legado: callback.reUiView() → refreshExplore() → clearExploreKindsCache + exploreKinds()
      // 这里只打标记，由调用方（worker）在 action 跑完后清缓存并重拉分类。
      if (ctx) ctx.exploreRefresh = true;
      if (logger) logger('[explore] java.refreshExplore() → 重新加载分类');
      return '';
    },
    reLoginView() { push({ type: 'reUiView', sourceUrl: key }); return ''; },
    upLoginData(data) { push({ type: 'upUiData', data: data || null, sourceUrl: key }); return ''; },
    refreshBookInfo() { push({ type: 'refresh', what: 'bookInfo', sourceUrl: key }); return ''; },
    refreshBookToc() { push({ type: 'refresh', what: 'toc', sourceUrl: key }); return ''; },
    refreshContent() { push({ type: 'refresh', what: 'content', sourceUrl: key }); return ''; },
    copyText(text) {
      push({ type: 'copyText', text: String(text == null ? '' : text), sourceUrl: key });
      return '';
    },
    toast(msg) { push({ type: 'toast', msg: String(msg == null ? '' : msg) }); if (logger) logger(`[toast] ${msg}`); },
    longToast(msg) { push({ type: 'toast', msg: String(msg == null ? '' : msg) }); if (logger) logger(`[longToast] ${msg}`); },
    // showBrowser / startBrowser：桌面端没有内嵌 WebView，交给前端开新标签
    showBrowser(url, html, preloadJs, config) {
      push({ type: 'openUrl', url: str(url), html: str(html), preloadJs: str(preloadJs), config: str(config), sourceUrl: key });
      return '';
    },
    startBrowser(url, title) {
      push({ type: 'openUrl', url: str(url), title: str(title), sourceUrl: key });
      return '';
    },
  });
}

/**
 * ExploreAdapter.kt:502 evalUiJs —— viewName 求值（java 保持为 source）
 * @returns {string} 求值结果，失败返回 ''
 */
export function evalExploreUiJs(ctx, source, code, infoMap) {
  if (code === null || code === undefined || !String(code).trim()) return '';
  try {
    const r = evalSourceJs(ctx, source, String(code), { infoMap: infoMapProxy(infoMap) });
    return r === null || r === undefined ? '' : String(r);
  } catch (e) {
    if (ctx && ctx.logger) {
      ctx.logger(`${source.bookSourceName || ''} exploreUi err:${(e && e.message) || e}`);
    }
    return '';
  }
}

/**
 * ExploreAdapter.kt:516 evalButtonClick —— button/text/toggle/select 的 action
 * @returns {{ok:boolean, error?:string}} 永不抛：legado 里也是 try/catch 吞掉
 */
export function evalExploreAction(ctx, source, code, infoMap, kindTitle) {
  if (code === null || code === undefined || !String(code).trim()) return { ok: true };
  const key = String(source.bookSourceUrl || '');
  const env = {
    cookieStore: ctx.services.cookieStore,
    cache: ctx.services.cache,
    logger: ctx.logger,
    network: ctx.services.network,
    defaultUA: undefined,
  };
  env.evalJs = (c, result, extra) => (ctx.evalJs ? ctx.evalJs(c, result, extra) : undefined);
  const wrapped = wrapSource(source, env);
  const im = infoMapProxy(infoMap);
  const bindings = {
    java: makeActionJava(ctx, source, wrapped, infoMap, key),
    source: wrapped,
    sourceApi: wrapped,
    baseUrl: key,
    cookie: ctx.services.cookieStore,
    cache: ctx.services.cache,
    infoMap: im,
    // 书源作者自定义的辅助函数（legado 里不存在，作者默认 InfoMap 可变才这么写）。
    // 语义上等价于「把当前筛选条件落盘」，所以实现成 infoMap.saveNow()。
    saveKeys: (m) => {
      try {
        const target = m && typeof m.saveNow === 'function' ? m : infoMap;
        if (target && typeof target.saveNow === 'function') target.saveNow();
      } catch (e) { /* ignore */ }
      return '';
    },
  };
  bindings.put = (k, v) => { bindings[k] = v; return v; };
  try {
    jsRuntime.run(String(code), bindings, { key, jsLib: source.jsLib });
    return { ok: true };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // legado: AppLog.put("ExploreUI Button $name JavaScript error", e)
    if (ctx && ctx.logger) ctx.logger(`ExploreUI Button ${kindTitle || ''} JavaScript error: ${msg}`);
    return { ok: false, error: msg };
  }
}