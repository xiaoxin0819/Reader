// AnalyzeRule —— 1:1 移植自 legado io.legado.app.model.analyzeRule.AnalyzeRule
// 规则引擎主入口：splitSourceRule / getString / getStringList / getElement / getElements
//                          / put / get / replaceRegex
import { decodeHTML } from 'entities';
import { javaRegex } from './java-regex.mjs';
import { AnalyzeByJSoup } from './analyze-jsoup.mjs';
import { AnalyzeByJSonPath } from './analyze-json.mjs';
import { AnalyzeByXPath } from './analyze-xpath.mjs';
import { AnalyzeByRegex } from './analyze-regex.mjs';
import { wrapBook, wrapChapter } from './wrap.mjs';
import {
  getAbsoluteURL, isJson, isJsonArray, isJsonObject, isXml, splitNotBlank,
} from './net-utils.mjs';

// AppPattern.kt
const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const WebJS_PATTERN = /@webjs:([\w\W]{5,})/gi;
const PUT_PATTERN = /@put:(\{[^}]+?\})/gi;
const EVAL_PATTERN = /@get:\{[^}]+?\}|\{\{[\w\W]*?\}\}/gi;
const REGEX_PATTERN = /\$\d{1,2}/g;

export const Mode = Object.freeze({
  XPath: 'XPath',
  Json: 'Json',
  Default: 'Default',
  Js: 'Js',
  Regex: 'Regex',
  WebJs: 'WebJs',
});

export class WebJsUnsupportedError extends Error {
  constructor(rule) {
    super('该书源依赖 WebJS / WebView（安卓专属），桌面端暂不支持');
    this.name = 'WebJsUnsupportedError';
    this.rule = rule;
  }
}

function reExecAll(re, str) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(str)) !== null) {
    out.push(m);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}

/**
 * legado AnalyzeRule 对象快路径的适用范围。
 * Kotlin 里 content 为 Rhino NativeObject / GSON LinkedTreeMap 时走「键值直取」，
 * 不执行规则；但 Js / WebJs 规则必须真跑一遍 JS —— 否则规则原文会被当成字段值返回
 * （书源 `@js:` 字段会退化成规则字符串）。
 */
function objectFastPathApplies(sourceRule) {
  return sourceRule.mode !== Mode.Js && sourceRule.mode !== Mode.WebJs;
}

function isPlainObjectLike(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  if (Buffer.isBuffer(v)) return false;
  // domhandler 节点
  if (typeof v.type === 'string' && ('children' in v || 'parent' in v)) return false;
  return true;
}

export class AnalyzeRule {
  constructor(ruleData = null, source = null, options = {}) {
    this.ruleData = ruleData;
    this.source = source;
    this.content = null;
    this.baseUrl = null;
    this.redirectUrl = null;
    this.chapter = null;
    this.nextChapterUrl = null;
    this.isJSON = false;
    this.isRegex = false;
    this.isFromBookInfo = false;
    this.jsEval = options.jsEval || null;
    this._stringRuleCache = new Map();
    this._regexCache = new Map();
    this._aXPath = null;
    this._aJSoup = null;
    this._aJSonPath = null;
    this.logger = options.logger || null;
  }

  // Kotlin: setContent
  setContent(content, baseUrl = undefined) {
    if (content === null || content === undefined) {
      throw new Error('内容不可空（Content cannot be null）');
    }
    this.content = content;
    // Kotlin: isJSON = when(content) { is Node -> false; else -> content.toString().isJson() }
    if (typeof content === 'string') {
      this.isJSON = isJson(content);
    } else if (isPlainObjectLike(content)) {
      let s = null;
      try { s = JSON.stringify(content); } catch (e) { s = null; }
      this.isJSON = s !== null && isJson(s);
    } else {
      this.isJSON = false;
    }
    this.setBaseUrl(baseUrl);
    this._aXPath = null;
    this._aJSoup = null;
    this._aJSonPath = null;
    return this;
  }

  setBaseUrl(baseUrl) {
    if (baseUrl !== undefined && baseUrl !== null) this.baseUrl = baseUrl;
    return this;
  }

  setRedirectUrl(url) {
    if (!url) return this.redirectUrl;
    try {
      this.redirectUrl = new URL(url);
    } catch (e) {
      this._log(`URL(${url}) error`);
    }
    return this.redirectUrl;
  }

  setRuleName() { /* 保留接口 */ }

  // ---------- Kotlin companion 的 setter（供目录/正文循环复用同一个 AnalyzeRule） ----------
  setRuleData(ruleData) {
    this.ruleData = ruleData === undefined ? null : ruleData;
    this._wrappedBook = this.ruleData && this._env ? wrapBook(this.ruleData, this._env) : null;
    return this;
  }

  setChapter(chapter) {
    this.chapter = chapter === undefined ? null : chapter;
    this._wrappedChapter = this.chapter && this._env ? wrapChapter(this.chapter, this._env) : null;
    return this;
  }

  setNextChapterUrl(url) {
    this.nextChapterUrl = url === undefined ? null : url;
    return this;
  }

  setCoroutineContext() { /* Node 侧空实现 */ }

  _log(msg) {
    if (this.logger) this.logger(msg);
  }

  _getAnalyzeByXPath(o) {
    if (o !== this.content) return new AnalyzeByXPath(o);
    if (!this._aXPath) this._aXPath = new AnalyzeByXPath(this.content);
    return this._aXPath;
  }

  _getAnalyzeByJSoup(o) {
    if (o !== this.content) return new AnalyzeByJSoup(o);
    if (!this._aJSoup) this._aJSoup = new AnalyzeByJSoup(this.content);
    return this._aJSoup;
  }

  _getAnalyzeByJSonPath(o) {
    if (o !== this.content) return new AnalyzeByJSonPath(o);
    if (!this._aJSonPath) this._aJSonPath = new AnalyzeByJSonPath(this.content);
    return this._aJSonPath;
  }

  _getWebJsResult() {
    throw new WebJsUnsupportedError('');
  }

  _evalJS(jsStr, result) {
    if (!this.jsEval) throw new Error('JS 运行时未接入');
    return this.jsEval(jsStr, result);
  }

  // ---------- getStringList ----------
  getStringList(rule, mContent = undefined, isUrl = false) {
    if (Array.isArray(rule)) return this._getStringList(rule, mContent, isUrl);
    if (!rule) return null;
    const ruleList = this._splitSourceRuleCacheString(rule);
    return this._getStringList(ruleList, mContent, isUrl);
  }

  _getStringList(ruleList, mContent, isUrl) {
    let result = null;
    const content = mContent === undefined || mContent === null ? this.content : mContent;
    if (content !== null && content !== undefined && ruleList.length > 0) {
      result = content;
      // legado 的快路径只在 result 是 Rhino NativeObject / GSON LinkedTreeMap 时命中；
      // 而 JSON 响应经 Jayway(json-smart) 解析后是 JSONObject(HashMap)，两者都不是，
      // 因此 legado 对 JSON 内容实际走的是下面的通用循环，`$..bid` + `@js:` 这类
      // 链式规则会被完整执行。本引擎的 JSON.parse 产物是普通对象，一旦也走快路径
      // 就只执行 ruleList[0]，把后面的 @js: 段整个丢掉（QQ阅读封面就是这么坏的）。
      // 所以这里只在规则链只剩一条时启用快路径，多段规则交给通用循环完整执行。
      if (ruleList.length === 1 && isPlainObjectLike(result) && objectFastPathApplies(ruleList[0])) {
        const sourceRule = ruleList[0];
        this._putRule(sourceRule.putMap);
        sourceRule.makeUpRule(result);
        if (sourceRule.mode === Mode.Json) {
          result = this._getAnalyzeByJSonPath(result).getStringList(sourceRule.rule);
        } else if (sourceRule.getParamSize() > 1) {
          result = sourceRule.rule;
        } else {
          result = result[sourceRule.rule];
        }
        if (result !== null && result !== undefined) {
          if (sourceRule.replaceRegex !== '' && Array.isArray(result)) {
            result = result.map((o) => this.replaceRegex(String(o), sourceRule));
          } else if (sourceRule.replaceRegex !== '') {
            result = this.replaceRegex(String(result), sourceRule);
          }
        }
      } else {
        for (const sourceRule of ruleList) {
          this._putRule(sourceRule.putMap);
          sourceRule.makeUpRule(result);
          if (result === null || result === undefined) continue;
          const rule = sourceRule.rule;
          if (rule !== '') {
            switch (sourceRule.mode) {
              case Mode.WebJs: result = this._getWebJsResult(rule, result); break;
              case Mode.Js: result = this._evalJS(rule, result); break;
              case Mode.Json: result = this._getAnalyzeByJSonPath(result).getStringList(rule); break;
              case Mode.XPath: result = this._getAnalyzeByXPath(result).getStringList(rule); break;
              case Mode.Default: result = this._getAnalyzeByJSoup(result).getStringList(rule); break;
              default: result = rule;
            }
          }
          if (sourceRule.replaceRegex !== '' && Array.isArray(result)) {
            result = result.map((item) => this.replaceRegex(String(item), sourceRule));
          } else if (sourceRule.replaceRegex !== '') {
            result = this.replaceRegex(String(result), sourceRule);
          }
        }
      }
    }
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') result = result.split('\n');
    if (isUrl) {
      const urlList = [];
      if (Array.isArray(result)) {
        for (const url of result) {
          if (url === null || url === undefined) continue;
          const absoluteURL = getAbsoluteURL(this.redirectUrl, String(url));
          if (absoluteURL !== '' && !urlList.includes(absoluteURL)) urlList.push(absoluteURL);
        }
      }
      return urlList;
    }
    return Array.isArray(result) ? result : null;
  }

  // ---------- getString ----------
  getString(ruleStr, mContentOrUnescape = undefined, isUrl = false, unescape = true) {
    // Kotlin 侧存在公开重载 getString(ruleList: List<SourceRule>, mContent, isUrl, unescape)
    if (Array.isArray(ruleStr)) {
      if (typeof mContentOrUnescape === 'boolean') {
        return this._getString(ruleStr, undefined, false, mContentOrUnescape);
      }
      return this._getString(ruleStr, mContentOrUnescape, isUrl, unescape);
    }
    if (!ruleStr) return '';
    const ruleList = this._splitSourceRuleCacheString(ruleStr);
    if (typeof mContentOrUnescape === 'boolean') {
      return this._getString(ruleList, undefined, false, mContentOrUnescape);
    }
    return this._getString(ruleList, mContentOrUnescape, isUrl, unescape);
  }

  _getString(ruleList, mContent, isUrl, unescape) {
    let result = null;
    const content = mContent === undefined || mContent === null ? this.content : mContent;
    if (content !== null && content !== undefined && ruleList.length > 0) {
      result = content;
      // legado 的快路径只在 result 是 Rhino NativeObject / GSON LinkedTreeMap 时命中；
      // 而 JSON 响应经 Jayway(json-smart) 解析后是 JSONObject(HashMap)，两者都不是，
      // 因此 legado 对 JSON 内容实际走的是下面的通用循环，`$..bid` + `@js:` 这类
      // 链式规则会被完整执行。本引擎的 JSON.parse 产物是普通对象，一旦也走快路径
      // 就只执行 ruleList[0]，把后面的 @js: 段整个丢掉（QQ阅读封面就是这么坏的）。
      // 所以这里只在规则链只剩一条时启用快路径，多段规则交给通用循环完整执行。
      if (ruleList.length === 1 && isPlainObjectLike(result) && objectFastPathApplies(ruleList[0])) {
        const sourceRule = ruleList[0];
        this._putRule(sourceRule.putMap);
        sourceRule.makeUpRule(result);
        let tmp;
        if (sourceRule.mode === Mode.Json) {
          tmp = this._getAnalyzeByJSonPath(result).getString(sourceRule.rule);
        } else if (sourceRule.getParamSize() > 1) {
          tmp = sourceRule.rule;
        } else {
          const v = result[sourceRule.rule];
          tmp = v === null || v === undefined ? null : String(v);
        }
        if (tmp !== null && tmp !== undefined) result = this.replaceRegex(tmp, sourceRule);
        else result = null;
      } else {
        for (const sourceRule of ruleList) {
          this._putRule(sourceRule.putMap);
          sourceRule.makeUpRule(result);
          if (result === null || result === undefined) continue;
          const rule = sourceRule.rule;
          if (rule !== '' || sourceRule.replaceRegex === '') {
            switch (sourceRule.mode) {
              case Mode.WebJs: result = this._getWebJsResult(rule, result); break;
              case Mode.Js: result = this._evalJS(rule, result); break;
              case Mode.Json: result = this._getAnalyzeByJSonPath(result).getString(rule); break;
              case Mode.XPath: result = this._getAnalyzeByXPath(result).getString(rule); break;
              case Mode.Default:
                result = isUrl
                  ? this._getAnalyzeByJSoup(result).getString0(rule)
                  : this._getAnalyzeByJSoup(result).getString(rule);
                break;
              default: result = rule;
            }
          }
          if (result !== null && result !== undefined && sourceRule.replaceRegex !== '') {
            result = this.replaceRegex(String(result), sourceRule);
          }
        }
      }
    }
    if (result === null || result === undefined) result = '';
    const resultStr = String(result);
    const str = unescape && resultStr.includes('&') ? decodeHTML(resultStr) : resultStr;
    if (isUrl) {
      if (str.trim() === '') return this.baseUrl == null ? '' : this.baseUrl;
      return getAbsoluteURL(this.redirectUrl, str);
    }
    return str;
  }

  // ---------- getElement / getElements ----------
  getElement(ruleStr) {
    if (!ruleStr) return null;
    let result = null;
    const content = this.content;
    const ruleList = this.splitSourceRule(ruleStr, true);
    if (content !== null && ruleList.length > 0) {
      result = content;
      for (const sourceRule of ruleList) {
        this._putRule(sourceRule.putMap);
        sourceRule.makeUpRule(result);
        if (result === null || result === undefined) continue;
        const rule = sourceRule.rule;
        switch (sourceRule.mode) {
          case Mode.Regex:
            result = AnalyzeByRegex.getElement(String(result), splitNotBlank(rule, '&&'), 0);
            break;
          case Mode.WebJs: result = this._getWebJsResult(rule, result); break;
          case Mode.Js: result = this._evalJS(rule, result); break;
          case Mode.Json: result = this._getAnalyzeByJSonPath(result).getObject(rule); break;
          case Mode.XPath: result = this._getAnalyzeByXPath(result).getElements(rule); break;
          default: result = this._getAnalyzeByJSoup(result).getElements(rule);
        }
        if (sourceRule.replaceRegex !== '' && result !== null && result !== undefined) {
          result = this.replaceRegex(String(result), sourceRule);
        }
      }
    }
    return result;
  }

  getElements(ruleStr) {
    let result = null;
    const content = this.content;
    const ruleList = this.splitSourceRule(ruleStr, true);
    if (content !== null && ruleList.length > 0) {
      result = content;
      for (const sourceRule of ruleList) {
        this._putRule(sourceRule.putMap);
        if (result === null || result === undefined) continue;
        const rule = sourceRule.rule;
        switch (sourceRule.mode) {
          case Mode.Regex:
            result = AnalyzeByRegex.getElements(String(result), splitNotBlank(rule, '&&'), 0);
            break;
          case Mode.WebJs: result = this._getWebJsResult(rule, result); break;
          case Mode.Js: result = this._evalJS(rule, result); break;
          case Mode.Json: result = this._getAnalyzeByJSonPath(result).getList(rule); break;
          case Mode.XPath: result = this._getAnalyzeByXPath(result).getElements(rule); break;
          default: result = this._getAnalyzeByJSoup(result).getElements(rule);
        }
      }
    }
    if (Array.isArray(result)) return result;
    return [];
  }

  // ---------- 变量保存 / 读取 ----------
  put(key, value) {
    const chapterObj = this._wrappedChapter || this.chapter;
    const bookObj = this._wrappedBook || this.ruleData;
    if (chapterObj && typeof chapterObj.putVariable === 'function') {
      chapterObj.putVariable(key, value);
    } else if (bookObj && typeof bookObj.putVariable === 'function') {
      this.ruleData.putVariable(key, value);
    } else if (this.source && typeof this.source.put === 'function') {
      this.source.put(key, value);
    } else if (bookObj && bookObj.variableMap) {
      bookObj.variableMap[key] = value;
    }
    return value;
  }

  get(key) {
    if (key === 'bookName') {
      const b = this._wrappedBook || this.ruleData;
      if (b && typeof b.name === 'string' && b.name !== '') return b.name;
    }
    if (key === 'title') {
      const c = this._wrappedChapter || this.chapter;
      if (c && c.title) return c.title;
    }
    const from = (obj) => {
      if (!obj) return null;
      if (typeof obj.getVariable === 'function') {
        const v = obj.getVariable(key);
        return v === '' || v == null ? null : v;
      }
      if (obj.variableMap && obj.variableMap[key] != null) {
        const v = obj.variableMap[key];
        return v === '' ? null : v;
      }
      return null;
    };
    return from(this._wrappedChapter || this.chapter) || from(this._wrappedBook || this.ruleData) || from(this.source) || '';
  }

  _putRule(map) {
    if (!map) return;
    for (const [key, value] of Object.entries(map)) {
      this.put(key, this.getString(value));
    }
  }

  // ---------- splitPutRule ----------
  splitPutRule(ruleStr, putMap) {
    let vRuleStr = ruleStr;
    for (const m of reExecAll(PUT_PATTERN, ruleStr)) {
      vRuleStr = vRuleStr.split(m[0]).join('');
      const putJsonStr = m[1];
      try {
        const putJson = JSON.parse(putJsonStr);
        if (putJson && typeof putJson === 'object') {
          for (const [k, v] of Object.entries(putJson)) putMap[k] = v;
          continue;
        }
      } catch (e) {
        // 非严格 JSON：legado 会尝试宽松解析，这里用简单修正
        const relaxed = tryRelaxedJson(putJsonStr);
        if (relaxed) for (const [k, v] of Object.entries(relaxed)) putMap[k] = v;
      }
    }
    return vRuleStr;
  }

  // ---------- replaceRegex ----------
  replaceRegex(result, rule) {
    if (rule.replaceRegex === '') return result;
    const replaceRegexStr = rule.replaceRegex;
    const replacement = rule.replacement;
    const regex = this._compileRegexCache(replaceRegexStr);
    if (rule.replaceFirst) {
      if (regex) {
        const re = new RegExp(regex.source, regex.flags.replace('g', ''));
        const m = re.exec(result);
        if (m) {
          const one = new RegExp(regex.source, regex.flags.replace('g', ''));
          return m[0].replace(one, replacement);
        }
        return '';
      }
      return replacement;
    }
    if (regex) {
      try {
        return result.replace(new RegExp(regex.source, regex.flags), replacement);
      } catch (e) {
        return result.split(replaceRegexStr).join(replacement);
      }
    }
    return result.split(replaceRegexStr).join(replacement);
  }

  _compileRegexCache(regex) {
    if (this._regexCache.has(regex)) return this._regexCache.get(regex);
    let r = null;
    try {
      r = javaRegex(regex, 'g');
    } catch (e) {
      r = null;
    }
    if (this._regexCache.size >= 32) this._regexCache.clear();
    this._regexCache.set(regex, r);
    return r;
  }

  // ---------- splitSourceRule ----------
  _splitSourceRuleCacheString(ruleStr) {
    if (!ruleStr) return [];
    if (this._stringRuleCache.has(ruleStr)) return this._stringRuleCache.get(ruleStr);
    const v = this.splitSourceRule(ruleStr, false);
    if (this._stringRuleCache.size >= 128) this._stringRuleCache.clear();
    this._stringRuleCache.set(ruleStr, v);
    return v;
  }

  splitSourceRule(ruleStr, allInOne = false) {
    if (!ruleStr) return [];
    const ruleList = [];
    let mMode = Mode.Default;
    let start = 0;
    if (allInOne && ruleStr.startsWith(':')) {
      mMode = Mode.Regex;
      this.isRegex = true;
      start = 1;
    } else if (this.isRegex) {
      mMode = Mode.Regex;
    }
    let tmp;
    for (const m of reExecAll(JS_PATTERN, ruleStr)) {
      if (m.index > start) {
        tmp = ruleStr.substring(start, m.index).trim();
        if (tmp !== '') ruleList.push(new SourceRule(this, tmp, mMode));
      }
      ruleList.push(new SourceRule(this, m[2] !== undefined && m[2] !== null ? m[2] : m[1], Mode.Js));
      start = m.index + m[0].length;
    }
    for (const m of reExecAll(WebJS_PATTERN, ruleStr)) {
      if (m.index > start) {
        tmp = ruleStr.substring(start, m.index).trim();
        if (tmp !== '') ruleList.push(new SourceRule(this, tmp, mMode));
      }
      ruleList.push(new SourceRule(this, m[1] || '', Mode.WebJs));
      start = m.index + m[0].length;
    }
    if (ruleStr.length > start) {
      tmp = ruleStr.substring(start).trim();
      if (tmp !== '') ruleList.push(new SourceRule(this, tmp, mMode));
    }
    return ruleList;
  }

  _singleSourceRule(rule) {
    return [new SourceRule(this, rule)];
  }
}

function tryRelaxedJson(s) {
  // legado 用 GSON（lenient）解析 @put 的 JSON，lenient 模式允许「键」和「值」都不加引号，
  // 例如 @put:{bid:id} 会被解析成 {"bid":"id"}，随后 putRule 再把 "id" 当规则去取 body.id。
  // 只给键补引号是不够的（会得到 {"bid":id} 而 JSON.parse 失败），必须同样处理裸值。
  const quoteKeys = (x) => x.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  const quoteBareValues = (x) => x.replace(
    /([{,]\s*"?[A-Za-z_$][\w$]*"?\s*:\s*)([A-Za-z_$][\w$]*)(\s*[,}])/g,
    (m, head, val, tail) => (/^(?:true|false|null)$/.test(val) ? m : head + '"' + val + '"' + tail));
  const dropTrailingComma = (x) => x.replace(/,\s*([}\]])/g, '$1');
  const variants = [
    (x) => x,
    dropTrailingComma,
    (x) => dropTrailingComma(quoteBareValues(quoteKeys(x))),
    (x) => quoteBareValues(quoteKeys(dropTrailingComma(x))),
  ];
  for (const fn of variants) {
    try {
      const v = JSON.parse(fn(s.replace(/'/g, '"')));
      if (v && typeof v === 'object') return v;
    } catch (e) { /* 继续放宽 */ }
  }
  return null;
}

// ---------- SourceRule（内部类） ----------
export class SourceRule {
  constructor(outer, ruleStr, mode = Mode.Default) {
    this._outer = outer;
    this.mode = mode;
    this.rule = '';
    this.replaceRegex = '';
    this.replacement = '';
    this.replaceFirst = false;
    this.putMap = {};
    this._ruleParam = [];
    this._ruleType = [];
    this._getRuleType = -2;
    this._jsRuleType = -1;
    this._defaultRuleType = 0;
    this._init(ruleStr);
  }

  _init(ruleStr) {
    const isJSON = this._outer ? this._outer.isJSON : false;
    if (this.mode === Mode.Js || this.mode === Mode.Regex) {
      this.rule = ruleStr;
    } else if (/^@CSS:/i.test(ruleStr)) {
      this.mode = Mode.Default;
      this.rule = ruleStr;
    } else if (ruleStr.startsWith('@@')) {
      this.mode = Mode.Default;
      this.rule = ruleStr.substring(2);
    } else if (/^@XPath:/i.test(ruleStr)) {
      this.mode = Mode.XPath;
      this.rule = ruleStr.substring(7);
    } else if (/^@Json:/i.test(ruleStr)) {
      this.mode = Mode.Json;
      this.rule = ruleStr.substring(6);
    } else if (isJSON || ruleStr.startsWith('$.') || ruleStr.startsWith('$[')) {
      this.mode = Mode.Json;
      this.rule = ruleStr;
    } else if (ruleStr.startsWith('/')) {
      this.mode = Mode.XPath;
      this.rule = ruleStr;
    } else {
      this.rule = ruleStr;
    }

    this.rule = this._outer
      ? this._outer.splitPutRule(this.rule, this.putMap)
      : this.rule;

    let start = 0;
    let tmp;
    const matches = reExecAll(EVAL_PATTERN, this.rule);
    if (matches.length > 0) {
      let m = matches[0];
      tmp = this.rule.substring(start, m.index);
      if (this.mode !== Mode.Js && this.mode !== Mode.Regex
          && (m.index === 0 || !tmp.includes('##'))) {
        this.mode = Mode.Regex;
      }
      let i = 0;
      do {
        m = matches[i];
        if (m.index > start) {
          tmp = this.rule.substring(start, m.index);
          this._splitRegex(tmp);
        }
        tmp = m[0];
        if (/^@get:/i.test(tmp)) {
          this._ruleType.push(this._getRuleType);
          this._ruleParam.push(tmp.substring(6, tmp.length - 1));
        } else if (tmp.startsWith('{{')) {
          this._ruleType.push(this._jsRuleType);
          this._ruleParam.push(tmp.substring(2, tmp.length - 2));
        } else {
          this._splitRegex(tmp);
        }
        start = m.index + m[0].length;
        i++;
      } while (i < matches.length);
    }
    if (this.rule.length > start) {
      this._splitRegex(this.rule.substring(start));
    }
  }

  _splitRegex(ruleStr) {
    let start = 0;
    let tmp;
    const ruleStrArray = ruleStr.split('##');
    const matches = reExecAll(REGEX_PATTERN, ruleStrArray[0]);
    if (matches.length > 0) {
      if (this.mode !== Mode.Js && this.mode !== Mode.Regex) this.mode = Mode.Regex;
      let i = 0;
      do {
        const m = matches[i];
        if (m.index > start) {
          tmp = ruleStr.substring(start, m.index);
          this._ruleType.push(this._defaultRuleType);
          this._ruleParam.push(tmp);
        }
        tmp = m[0];
        this._ruleType.push(parseInt(tmp.substring(1), 10));
        this._ruleParam.push(tmp);
        start = m.index + m[0].length;
        i++;
      } while (i < matches.length);
    }
    if (ruleStr.length > start) {
      this._ruleType.push(this._defaultRuleType);
      this._ruleParam.push(ruleStr.substring(start));
    }
  }

  makeUpRule(result) {
    let infoVal = '';
    if (this._ruleParam.length > 0) {
      let index = this._ruleParam.length;
      while (index-- > 0) {
        const regType = this._ruleType[index];
        if (regType > this._defaultRuleType) {
          if (Array.isArray(result) && result.length > regType) {
            const v = result[regType];
            if (v !== null && v !== undefined) infoVal = v + infoVal;
          } else {
            infoVal = this._ruleParam[index] + infoVal;
          }
        } else if (regType === this._jsRuleType) {
          if (isRule(this._ruleParam[index])) {
            const ruleList = this._outer._singleSourceRule(this._ruleParam[index]);
            const s = this._outer.getString(ruleList);
            infoVal = s + infoVal;
          } else {
            const jsEval = this._outer._evalJS(this._ruleParam[index], result);
            if (jsEval === null || jsEval === undefined) {
              /* null → skip */
            } else if (typeof jsEval === 'string') {
              infoVal = jsEval + infoVal;
            } else if (typeof jsEval === 'number' && Number.isInteger(jsEval)) {
              infoVal = jsEval.toFixed(0) + infoVal;
            } else {
              infoVal = String(jsEval) + infoVal;
            }
          }
        } else if (regType === this._getRuleType) {
          infoVal = this._outer.get(this._ruleParam[index]) + infoVal;
        } else {
          infoVal = this._ruleParam[index] + infoVal;
        }
      }
      this.rule = infoVal;
    }
    const ruleStrS = this.rule.split('##');
    this.rule = ruleStrS[0].trim();
    if (ruleStrS.length > 1) this.replaceRegex = ruleStrS[1];
    if (ruleStrS.length > 2) this.replacement = ruleStrS[2];
    if (ruleStrS.length > 3) this.replaceFirst = true;
  }

  getParamSize() {
    return this._ruleParam.length;
  }
}

function isRule(ruleStr) {
  return ruleStr.startsWith('@')
    || ruleStr.startsWith('$.')
    || ruleStr.startsWith('$[')
    || ruleStr.startsWith('//');
}

export { isRule, isJson, isJsonObject, isJsonArray, isXml };