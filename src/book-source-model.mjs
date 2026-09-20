// book-source-model.mjs —— BookSource 数据模型 / 导入导出 / 排序 / 18+ 过滤
// 移植自 legado data/entities/BookSource.kt、BaseSource.kt、help/source/SourceHelp.kt
import fs from 'node:fs';
import path from 'node:path';
import { getBaseUrl } from './net-utils.mjs';

export const RULE_SEARCH_FIELDS = ['checkKeyWord', 'bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'];
export const RULE_EXPLORE_FIELDS = ['bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'];
export const RULE_BOOKINFO_FIELDS = ['init', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'coverUrl', 'tocUrl', 'wordCount', 'canReName', 'downloadUrls'];
export const RULE_TOC_FIELDS = ['preUpdateJs', 'chapterList', 'chapterName', 'chapterUrl', 'formatJs', 'isVolume', 'isVip', 'isPay', 'updateTime', 'nextTocUrl'];
export const RULE_CONTENT_FIELDS = ['content', 'subContent', 'title', 'nextContentUrl', 'webJs', 'sourceRegex', 'replaceRegex', 'imageStyle', 'imageDecode', 'payAction', 'callBackJs'];

/** BookSourceType */
export const BookSourceType = { text: 0, audio: 1, image: 2, file: 3, video: 4 };

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function normRuleObj(obj, fields) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  for (const k of fields) out[k] = blankToNull(src[k]);
  return out;
}

function normInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/**
 * 规范化单个书源（补默认值，与 BookSource.kt 的默认值一致）
 */
export function normalizeSource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const source = {
    bookSourceUrl: src.bookSourceUrl == null ? '' : String(src.bookSourceUrl).trim(),
    bookSourceName: src.bookSourceName == null ? '' : String(src.bookSourceName),
    bookSourceGroup: blankToNull(src.bookSourceGroup),
    bookSourceType: normInt(src.bookSourceType, 0),
    bookUrlPattern: blankToNull(src.bookUrlPattern),
    customOrder: normInt(src.customOrder, 0),
    enabled: src.enabled === undefined ? true : src.enabled !== false,
    enabledExplore: src.enabledExplore === undefined ? true : src.enabledExplore !== false,
    jsLib: blankToNull(src.jsLib),
    enabledCookieJar: src.enabledCookieJar === undefined ? true : src.enabledCookieJar === true,
    concurrentRate: blankToNull(src.concurrentRate),
    header: blankToNull(src.header),
    loginUrl: blankToNull(src.loginUrl),
    loginUi: blankToNull(src.loginUi),
    loginCheckJs: blankToNull(src.loginCheckJs),
    coverDecodeJs: blankToNull(src.coverDecodeJs),
    bookSourceComment: blankToNull(src.bookSourceComment),
    variableComment: blankToNull(src.variableComment),
    lastUpdateTime: normInt(src.lastUpdateTime, 0),
    respondTime: src.respondTime === undefined || src.respondTime === null ? 180000 : normInt(src.respondTime, 180000),
    weight: normInt(src.weight, 0),
    exploreUrl: blankToNull(src.exploreUrl),
    exploreScreen: blankToNull(src.exploreScreen),
    ruleExplore: normRuleObj(src.ruleExplore, RULE_EXPLORE_FIELDS),
    searchUrl: blankToNull(src.searchUrl),
    ruleSearch: normRuleObj(src.ruleSearch, RULE_SEARCH_FIELDS),
    ruleBookInfo: normRuleObj(src.ruleBookInfo, RULE_BOOKINFO_FIELDS),
    ruleToc: normRuleObj(src.ruleToc, RULE_TOC_FIELDS),
    ruleContent: normRuleObj(src.ruleContent, RULE_CONTENT_FIELDS),
    ruleReview: src.ruleReview == null ? null : src.ruleReview,
    mainJs: blankToNull(src.mainJs),
    eventListener: src.eventListener === true,
    customButton: src.customButton === true,
    // 自定义扩展字段（legado 无此项）：标记「禁止导出 TXT」。
    // 整本导出 = 连续几百次请求，部分站点会因此风控 ban IP（用户实测速读谷²）。
    noExport: src.noExport === true,
    // 自定义扩展字段（legado 无此项）：站点对请求量极敏感（风控会封 IP）。
    // 用于把该源排除在「书架全量后台预热」之外 —— 用户没有主动打开的书，
    // 不应该由后台批量请求，只保留「最近阅读」那本的少量预热。
    noShelfWarm: src.noShelfWarm === true,
  };
  return source;
}

export function getKey(source) { return String(source.bookSourceUrl || ''); }
export function getTag(source) { return String(source.bookSourceName || ''); }
export function isJsSource(source) { return !!(source.mainJs && String(source.mainJs).trim()); }
export function isEnabled(source) { return source.enabled !== false; }

/** BaseSource.getLoginJs() */
export function getLoginJs(source) {
  if (isJsSource(source)) return source.mainJs;
  const loginUrl = source.loginUrl;
  if (!loginUrl) return null;
  const s = String(loginUrl);
  if (s.startsWith('@js:')) return s.substring(4);
  if (s.startsWith('<js>')) return s.substring(4, s.lastIndexOf('<'));
  return s;
}

/** BookSource.hasGroup */
export function hasGroup(source, group) {
  const g = source.bookSourceGroup;
  if (!g) return false;
  return splitNotBlankStr(g, /[,，\s]+/).includes(group);
}

export function splitNotBlankStr(str, delimiter) {
  if (str == null) return [];
  const d = delimiter instanceof RegExp ? delimiter : new RegExp(delimiter);
  return String(str).split(d).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function getInvalidGroupNames(source) {
  const g = source.bookSourceGroup;
  if (!g) return [];
  return [...new Set(splitNotBlankStr(g, /[,，\s]+/).filter((it) => it.includes('失效') || it === '校验超时'))];
}

export function getCheckKeyword(source, def) {
  const ck = source.ruleSearch ? source.ruleSearch.checkKeyWord : null;
  if (ck && String(ck).trim() && !String(ck).includes('http') && !String(ck).includes('::')
    && !String(ck).includes('++') && !String(ck).includes('--')) {
    return String(ck);
  }
  return def;
}

/** SourceHelp.is18Plus —— 需要 18PlusList.txt（base64 域名表） */
export function load18PlusList(assetsPath) {
  try {
    const txt = fs.readFileSync(assetsPath, 'utf8');
    const set = new Set();
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { set.add(Buffer.from(s, 'base64').toString('utf8').trim()); } catch (e) { /* ignore */ }
    }
    return set;
  } catch (e) {
    return new Set();
  }
}

export function is18Plus(url, list18Plus) {
  if (!list18Plus || list18Plus.size === 0) return false;
  if (!url) return false;
  const baseUrl = getBaseUrl(url);
  if (!baseUrl) return false;
  try {
    const parts = baseUrl.split(/\/\/|\./);
    if (parts.length <= 2) return false;
    const host = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    return list18Plus.has(host);
  } catch (e) { return false; }
}

/**
 * SourceHelp.adjustSortNumber 的等价实现（对传入数组就地修改并返回是否需要写回）
 * 当 customOrder 超出 ±99999 或存在重复值时，按顺序重排为 0..n-1
 */
export function adjustSortNumber(sources) {
  if (!sources.length) return false;
  let maxOrder = -Infinity;
  let minOrder = Infinity;
  const seen = new Set();
  let dup = false;
  for (const s of sources) {
    const o = normInt(s.customOrder, 0);
    if (o > maxOrder) maxOrder = o;
    if (o < minOrder) minOrder = o;
    if (seen.has(o)) dup = true;
    seen.add(o);
  }
  if (!(maxOrder > 99999 || minOrder < -99999 || dup)) return false;
  sources.forEach((s, i) => { s.customOrder = i; });
  return true;
}

/** 解析用户导入的书源 JSON（单对象 / 数组 / { bookSources: [] } / { bookSourceList: [] }） */
export function parseSourceImport(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    throw new Error('书源 JSON 解析失败: ' + e.message);
  }
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.bookSources)) arr = data.bookSources;
    else if (Array.isArray(data.bookSourceList)) arr = data.bookSourceList;
    else if (data.bookSourceUrl) arr = [data];
  }
  if (!arr) throw new Error('未识别到书源数组（支持数组 / {bookSources:[]} / 单个书源对象）');
  const out = [];
  const bad = [];
  for (const item of arr) {
    try {
      const s = normalizeSource(item);
      if (!s.bookSourceUrl) { bad.push(item && item.bookSourceName); continue; }
      if (!/^https?:\/\//i.test(s.bookSourceUrl) && !s.bookSourceUrl.startsWith('data:')) {
        // 允许（部分源用自定义 scheme），但仍保留
      }
      out.push(s);
    } catch (e) { bad.push(item && item.bookSourceName); }
  }
  return { sources: out, skipped: bad };
}

/** 导出为 JSON 文本 */
export function exportSources(sources) {
  return JSON.stringify(sources.map((s) => ({ ...s })), null, 2);
}

/** 去重（按 bookSourceUrl 保留后者），返回 {added, updated, rejected} */
export function mergeSources(existing, incoming, { list18Plus = null } = {}) {
  const map = new Map();
  for (const s of existing) map.set(getKey(s), s);
  let added = 0;
  let updated = 0;
  const rejected = [];
  for (const s of incoming) {
    const key = getKey(s);
    if (!key) continue;
    if (list18Plus && is18Plus(key, list18Plus)) { rejected.push({ name: s.bookSourceName, reason: '18+' }); continue; }
    if (map.has(key)) { map.set(key, s); updated++; } else { map.set(key, s); added++; }
  }
  const merged = [...map.values()];
  adjustSortNumber(merged);
  return { sources: merged, added, updated, rejected };
}

/** 从文件读取书源（兼容 UTF-8 BOM） */
export function readSourcesFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return parseSourceImport(text);
}

export function writeSourcesFile(file, sources) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, exportSources(sources), 'utf8');
}

/** 便于 UI 展示的摘要 */
export function sourceSummary(s) {
  const hasSearch = !!(s.searchUrl && String(s.searchUrl).trim());
  const hasExplore = !!(s.exploreUrl && String(s.exploreUrl).trim()) || (s.ruleExplore && s.ruleExplore.bookList);
  return {
    url: s.bookSourceUrl,
    name: s.bookSourceName,
    group: s.bookSourceGroup,
    type: s.bookSourceType,
    enabled: s.enabled !== false,
    enabledExplore: s.enabledExplore !== false,
    customOrder: s.customOrder,
    weight: s.weight,
    respondTime: s.respondTime,
    lastUpdateTime: s.lastUpdateTime,
    comment: s.bookSourceComment,
    hasSearch,
    hasExplore,
    noExport: s.noExport === true,
    hasLogin: !!(s.loginUrl && String(s.loginUrl).trim()) || !!(s.loginUi && String(s.loginUi).replace(/\s/g, '') !== '[]'),
    jsSource: isJsSource(s),
    useWebView: /@webjs:|useWebView|"webView"\s*:\s*true|,?\s*"?webView"?\s*:\s*true/i.test(
      [s.searchUrl, s.exploreUrl, s.ruleContent && s.ruleContent.webJs, s.jsLib].filter(Boolean).join(' '),
    ),
  };
}

export default {
  normalizeSource, parseSourceImport, exportSources, mergeSources, adjustSortNumber,
  is18Plus, load18PlusList, getBookSourceType: BookSourceType,
};
