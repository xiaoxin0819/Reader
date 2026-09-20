// src/txt-toc-rules.mjs
//
// TXT 目录规则引擎 —— 逐行移植 legado：
//   app/src/main/java/io/legado/app/model/localBook/TextFile.kt
//     · getChapterList()  → 前 512KB 探测规则，选中后按该规则切整本
//     · getTocRule()      → 遍历启用规则，csNum / numE 打分选最佳
//     · analyze(rr)       → 按规则正则切章、识别卷、跑 replacement JS
//     · JsExtensions      → @js 里的 java.putVolume(title)
//     · getTocRules()     → 只用 enable === true 的规则
//   app/src/main/assets/defaultData/txtTocRule.json（默认规则源文件）
//
// 与 legado 的差异只在于实现层面：Java 按 512KB 块读文件，这里整串处理；
// 因为正则是 MULTILINE 且块边界对齐换行符，两者结果一致。
import vm from "node:vm";
import { javaRegex, tryJavaRegex } from "./java-regex.mjs";

/** TextFile.kt 里 rule 与 replacement 的分隔符 */
export const SPACE_CHARS = "🫅🈳🏻";

/* ---------------- JS 替换脚本（replacement 字段） ----------------
 * legado 里 replacement 直接当 JS 跑（不带 @js: 前缀），绑定：
 *   result / book / index / prevTitle / prevLength / lastVolumeTitle / java
 * 返回值取脚本最后一条表达式的 completion value（Rhino eval 语义）。
 */

const jsScriptCache = new Map();

function compileJs(code) {
  let script = jsScriptCache.get(code);
  if (!script) {
    script = new vm.Script("(function () { return eval(__code); })()", { filename: "txt-toc-rule-js" });
    jsScriptCache.set(code, script);
  }
  return script;
}

function makeSandbox() {
  const sandbox = Object.create(null);
  for (const n of [
    "JSON", "Math", "Date", "Array", "Object", "String", "Number", "Boolean", "RegExp",
    "Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "ReferenceError",
    "Map", "Set", "Symbol", "BigInt", "Intl", "parseInt", "parseFloat", "isNaN", "isFinite",
    "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "escape", "unescape",
  ]) {
    if (n in globalThis) sandbox[n] = globalThis[n];
  }
  return vm.createContext(sandbox);
}

/** TextFile.JsExtensions —— @js 规则里能用的 java 对象 */
class TocJsExtensions {
  constructor(state, toc) {
    this._state = state;
    this._toc = toc || null;
  }
  /** TextFile.JsExtensions.putVolume(title) */
  putVolume(title) {
    const t = String(title == null ? "" : title);
    this._state.lastVolumeTitle = t;
    if (this._toc) {
      const start = this._toc.length ? this._toc[this._toc.length - 1].end : 0;
      this._toc.push({ title: t, isVolume: true, start, end: start, offset: start });
    }
  }
}

/**
 * TextFile.evalJs(content, jsStr, index, prevTitle, prevLength, toc)
 * index 为 1 起的章节序号；返回脚本最后一条表达式的字符串。
 */
function evalJs(content, jsStr, index, prevTitle, prevLength, ctx) {
  const sandbox = makeSandbox();
  sandbox.__code = jsStr;
  sandbox.result = String(content == null ? "" : content);
  sandbox.book = ctx.book || null;
  sandbox.index = index;
  sandbox.prevTitle = prevTitle == null ? null : String(prevTitle);
  sandbox.prevLength = prevLength == null ? -1 : prevLength;
  sandbox.lastVolumeTitle = ctx.state.lastVolumeTitle;
  sandbox.java = new TocJsExtensions(ctx.state, ctx.toc);
  let value;
  try {
    value = compileJs(jsStr).runInContext(sandbox, { timeout: 3000 });
  } catch (e) {
    // legado：脚本抛异常会打断整本解析，这里记日志并退回原标题，避免整本书打不开
    console.error("TXT 目录规则 JS 出错:", e && e.message);
    return String(content == null ? "" : content);
  }
  return value == null ? "" : String(value);
}

/** TextFile.replacement(content, jsStr, index, prevTitle, prevLength, toc) */
function replacement(content, jsStr, index, prevTitle, prevLength, ctx) {
  if (jsStr == null || jsStr === "") return String(content == null ? "" : content);
  return evalJs(content, jsStr, index, prevTitle, prevLength, ctx);
}

/* ---------------- 规则选择（TextFile.getTocRule） ---------------- */

const PROBE_BYTES = 512000;   // TextFile.bufferSize
const OVER_RULE_COUNT = 2;    // TextFile.overRuleCount

/**
 * 取启用规则，按 order/serialNumber 升序（dao.enabled 的语义）。
 * 没有 order 字段时退回 serialNumber，再退回 0。
 */
export function enabledTocRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return list
    .filter((r) => r && r.enable === true && String(r.rule == null ? "" : r.rule) !== "")
    .slice()
    .sort((a, b) => tocRuleOrder(a) - tocRuleOrder(b));
}

function tocRuleOrder(r) {
  const o = Number(r.order);
  if (Number.isFinite(o)) return o;
  const s = Number(r.serialNumber);
  return Number.isFinite(s) ? s : 0;
}

/** TextFile.getTocRules()：enable === true 的规则 */
export function getTocRules(rules) {
  return (Array.isArray(rules) ? rules : []).filter((r) => r && r.enable === true);
}

/**
 * TextFile.getTocRule(content)：在前 512KB 里挑一条最合适的规则。
 * 命中条件 csNum >= numE * 3 且 csNum > maxNum + overRuleCount；
 * 匹配到 70 章以上立即停止（说明已经够准）。
 * @returns {object|null}
 */
export function pickTocRule(content, rules) {
  const probe = content.length > PROBE_BYTES ? content.slice(0, PROBE_BYTES) : content;
  const list = getTocRules(rules);
  let maxNum = -1;
  let picked = null;
  for (const rule of list) {
    const re = tryJavaRegex(rule.rule, "gm");
    if (!re) { console.error("TXT 目录规则正则语法错误:", rule.name); continue; }
    const ctx = { book: null, state: { lastVolumeTitle: "" }, toc: null };
    let start = 0;
    let csNum = 0;
    let numE = 0;
    let lastTitle = null;
    let m;
    while ((m = re.exec(probe)) !== null) {
      const contentLength = m.index - start;
      if (start === 0 || contentLength > 1000) {
        const title = replacement(m[0], rule.replacement, csNum, lastTitle, contentLength, ctx);
        if (title !== "") { lastTitle = title; csNum++; }
        start = m.index + m[0].length;
      } else if (contentLength < 100) {
        numE++;   // 不足 100 字的多半是卷标题，误识别
      }
      if (m[0] === "" && re.lastIndex === m.index) re.lastIndex += 1;
    }
    if (csNum >= numE * 3 && csNum > maxNum + OVER_RULE_COUNT) {
      maxNum = csNum;
      picked = rule;
      if (maxNum > 70) break;
    }
  }
  return picked;
}

/* ---------------- 按规则切章（TextFile.analyze(rr)） ---------------- */

/**
 * 按选中的规则把整本书切成章节。
 * 返回的 start / end 是字符偏移；调用方再按行号换算。
 * chapter.title 已经是 replacement 处理过的最终标题。
 */
export function analyzeByTocRule(text, rule, book) {
  const re = javaRegex(rule.rule, "gm");
  const jsStr = rule.replacement == null ? "" : String(rule.replacement);
  const ctx = { book: book || null, state: { lastVolumeTitle: "" }, toc: null };
  const chapters = [];   // 临时集合，供 java.putVolume 往里插卷
  ctx.toc = chapters;
  let intro = null;
  let seekPos = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const chapterStart = m.index;
    const content = text.slice(seekPos, chapterStart);
    const contentLen = content.length;
    const titleLen = m[0].length;
    const last = chapters.length ? chapters[chapters.length - 1] : null;
    if (seekPos === 0 && chapterStart !== 0) {
      // 开头正文：没章节 → 序章；否则是上一章的剩余内容
      if (!chapters.length) {
        if (content.trim() !== "") {
          const preTitle = replacement("前言", jsStr, chapters.length + 1, null, -1, ctx);
          if (preTitle !== "") intro = { title: preTitle, start: 0, end: chapterStart };
        }
        const title = replacement(m[0], jsStr, chapters.length + 1, null, -1, ctx);
        if (title === "") { seekPos += contentLen + titleLen; continue; }
        chapters.push({ title, start: chapterStart, end: chapterStart, isVolume: false });
      } else {
        const title = replacement(m[0], jsStr, chapters.length + 1, last.title, contentLen, ctx);
        if (title === "") { seekPos += contentLen + titleLen; continue; }
        last.isVolume = content.trim() === "";
        if (last.isVolume) ctx.state.lastVolumeTitle = last.title;
        last.end = chapterStart;
        chapters.push({ title, start: chapterStart, end: chapterStart, isVolume: false });
      }
    } else if (chapters.length) {
      const title = replacement(m[0], jsStr, chapters.length + 1, last.title, contentLen, ctx);
      if (title === "") { seekPos += contentLen + titleLen; continue; }
      last.isVolume = content.trim() === "";
      if (last.isVolume) ctx.state.lastVolumeTitle = last.title;
      last.end = chapterStart;
      chapters.push({ title, start: chapterStart, end: chapterStart, isVolume: false });
    } else {
      const title = replacement(m[0], jsStr, chapters.length + 1, null, -1, ctx);
      if (title === "") { seekPos += contentLen + titleLen; continue; }
      chapters.push({ title, start: chapterStart, end: chapterStart, isVolume: false });
    }
    seekPos += contentLen + titleLen;
    if (m[0] === "" && re.lastIndex === m.index) re.lastIndex += 1;
  }
  if (chapters.length) chapters[chapters.length - 1].end = text.length;
  return { chapters, intro };
}

/* ---------------- 行号换算 ---------------- */

/** 构造「字符偏移 → 行号」的映射表 */
export function makeLineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return function lineOf(offset) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
}

/** 规则指纹：规则集合变了就得让本地解析缓存失效 */
export function tocRuleFingerprint(rules) {
  return enabledTocRules(rules)
    .map((r) => (r.id == null ? "" : r.id) + ":" + String(r.rule == null ? "" : r.rule))
    .join("|");
}
