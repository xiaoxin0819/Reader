// src/replace-engine.mjs
//
// 替换净化引擎 —— 逐行移植 legado：
//   app/src/main/java/io/legado/app/utils/RegexExtensions.kt
//   app/src/main/java/io/legado/app/help/book/ContentProcessor.kt
//   app/src/main/java/io/legado/app/help/RegexJsExtensions.kt
//   app/src/main/java/io/legado/app/utils/StringExtensions.kt  (quoteReplacementJs)
//
// 为什么不能直接 text.replace(re, replacement)：
//   1. Java 的 Matcher.appendReplacement 对替换串里的 `$` / `\` 有自己的解析规则
//      （`$1`/`${name}` 取分组、`\$` 是字面量 `$`、`$` 后跟非法字符直接抛
//      Illegal group reference），跟 JS String.replace 的 `$&`/`$<name>` 完全不同。
//   2. `@js:` 的返回值先 quoteReplacementJs() 再进 appendReplacement，
//      所以 JS 返回的 `\` 是字面量，而 `$` 仍会被当成分组引用。
//   3. legado 的整套替换有超时保护，超时会 disable 这条规则并落库。
import vm from "node:vm";
import { javaRegex } from "./java-regex.mjs";

/** 替换规则超时（对应 legado RegexTimeoutException）。 */
export class RegexTimeoutError extends Error {
  constructor(message) {
    super(message || "替换超时");
    this.name = "RegexTimeoutError";
  }
}

/**
 * Kotlin String.quoteReplacementJs()：只把 `\` 翻倍。
 * 这样 appendReplacement 解析回来还是原来的单个 `\`，不会被当成转义符。
 */
export function quoteReplacementJs(value) {
  const s = String(value == null ? "" : value);
  if (!s.includes("\\")) return s;
  let out = "";
  for (const c of s) out += c === "\\" ? "\\\\" : c;
  return out;
}

/**
 * java.util.regex.Matcher.appendReplacement 的替换串解析（只算替换出来的文本）。
 *
 * 规则（JDK Matcher.appendReplacement 的 appendExpandedReplacement）：
 *   `\` + 任意字符 → 该字符本身（`\\` → `\`，`\$` → `$`）
 *   `$$`          → 字面量 `$`
 *   `${name}`     → 命名分组
 *   `$N`          → 第 N 个分组（尽量多吃数字，越界时回退一位）
 *   其它 `$x`     → 抛 Illegal group reference
 */
export function javaExpandReplacement(replacement, match) {
  const s = String(replacement == null ? "" : replacement);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length) out += s[i + 1];
      else out += "\\";
      i += 2;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    const next = s[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next === "{") {
      const close = s.indexOf("}", i + 2);
      if (close < 0) throw new Error("Illegal group reference");
      const name = s.slice(i + 2, close);
      const g = match && match.groups ? match.groups[name] : undefined;
      out += g == null ? "" : g;
      i = close + 1;
      continue;
    }
    if (next >= "0" && next <= "9") {
      let digits = "";
      let j = i + 1;
      while (j < s.length && s[j] >= "0" && s[j] <= "9") { digits += s[j]; j += 1; }
      let groupIndex = -1;
      let used = 0;
      for (let k = digits.length; k >= 1; k -= 1) {
        const cand = Number(digits.slice(0, k));
        if (cand >= 1 && cand < match.length) { groupIndex = cand; used = k; break; }
      }
      if (groupIndex < 0) throw new Error("Illegal group reference");
      const g = match[groupIndex];
      out += g == null ? "" : g;
      i += 1 + used;
      continue;
    }
    throw new Error("Illegal group reference");
  }
  return out;
}

/**
 * legado RegexJsExtensions —— 替换规则 @js: 里能用的 `java` 对象。
 * RuleData 就是一张 map（legado RuleData.kt），put/get 在同一规则的执行期共享。
 */
export class RegexJsExtensions {
  constructor(name, logger) {
    this.name = String(name == null ? "" : name);
    this._logger = typeof logger === "function" ? logger : null;
    this._vars = new Map();
  }
  log(msg) {
    if (this._logger) this._logger(msg);
    else console.log(`替换净化规则 ${this.name} 输出: ${msg == null ? "" : msg}`);
    return msg;
  }
  logType(any) { this.log(any == null ? "null" : typeof any); }
  // legado 用 ChineseUtils.t2s/s2t（ICU 简繁转换）。桌面端没有等价实现，
  // 保持恒等而**不是**抛错 —— 抛错会把整条规则废掉。
  t2s(text) { return String(text == null ? "" : text); }
  s2t(text) { return String(text == null ? "" : text); }
  get(key) { return this._vars.get(String(key)) ?? ""; }
  put(key, value) { this._vars.set(String(key), String(value == null ? "" : value)); return value; }
}

/** @js: 代码编译缓存：同一个规则只编译一次。 */
const jsScriptCache = new Map();

/**
 * 编译 @js: 脚本体。
 *
 * legado 是 RhinoScriptEngine 的 eval(replacement1, bindings)，返回值取脚本
 * 最后一个表达式的 completion value。这里不能包成 function 后调用：函数没有
 * 显式 return 会得到 undefined，标题规则里的三元表达式就会被当成空串。
 * 用函数内的直接 eval 才能同时保留参数绑定，并返回最后一条表达式的值。
 */
function compileJsRule(code) {
  let script = jsScriptCache.get(code);
  if (!script) {
    // 用直接 eval 模拟 Rhino eval：返回最后一条表达式的 completion value，
    // 同时让每次匹配拥有独立的函数作用域，避免顶层 let/const 在多次匹配间重复声明。
    script = new vm.Script(
      "(function () { return eval(__code); })()",
      { filename: "replace-rule-js" },
    );
    jsScriptCache.set(code, script);
  }
  return script;
}

function makeJsSandbox() {
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

/**
 * @js: 规则运行上下文缓存。
 *
 * legado 在同一个 Rhino 引擎里重复执行规则；这里如果每次 replaceWithRule()
 * 都 vm.createContext()，大书的逐章标题替换会创建几千个 context，直接堵住
 * Node 事件循环。上下文按规则源码缓存，调用前刷新 bindings，保持结果语义不变。
 */
const jsContextCache = new Map();
const JS_CONTEXT_MAX = 64;

function getJsSandbox(code) {
  let ctx = jsContextCache.get(code);
  if (!ctx) {
    ctx = makeJsSandbox();
    jsContextCache.set(code, ctx);
    if (jsContextCache.size > JS_CONTEXT_MAX) {
      const oldest = jsContextCache.keys().next().value;
      jsContextCache.delete(oldest);
    }
  }
  ctx.__code = code;
  return ctx;
}

/**
 * 按 legado CharSequence.replace(name, regex, replacement, timeout, chapter, book) 跑一条规则。
 *
 * @param {object} o
 * @param {string} o.name          规则名（只用于日志）
 * @param {string} o.text          输入文本
 * @param {string} o.pattern       Java 正则 / 字面量
 * @param {string} o.replacement   替换内容（`@js:` 开头走脚本）
 * @param {boolean} o.isRegex      false 时按字面量替换（Kotlin String.replace）
 * @param {number} o.timeout       超时毫秒
 * @param {object} o.chapter       绑定给 @js: 的 chapter
 * @param {object} o.book          绑定给 @js: 的 book
 */
export function replaceWithRule(o) {
  const opts = o || {};
  const text = String(opts.text == null ? "" : opts.text);
  const pattern = String(opts.pattern == null ? "" : opts.pattern);
  if (!pattern) return text;

  // Kotlin String.replace(oldValue, newValue) —— 字面量，无正则、无 $ 语义
  if (opts.isRegex === false) {
    return text.split(pattern).join(String(opts.replacement == null ? "" : opts.replacement));
  }

  const replacementRaw = String(opts.replacement == null ? "" : opts.replacement);
  const isJs = replacementRaw.startsWith("@js:");
  const jsCode = isJs ? replacementRaw.slice(4) : "";
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 3000;
  const deadline = Date.now() + timeout;

  const re = javaRegex(pattern, "g");
  const jsSandbox = isJs ? getJsSandbox(jsCode) : null;
  const jsScript = isJs ? compileJsRule(jsCode) : null;
  const jsApi = isJs ? new RegexJsExtensions(opts.name) : null;

  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // legado RegexExtensions.kt：整条替换有超时，超时 → RegexTimeoutException
    if (Date.now() > deadline) {
      throw new RegexTimeoutError(`替换超时：规则「${opts.name || ""}」`);
    }
    out += text.slice(last, m.index);
    if (isJs) {
      // 与 Rhino bindings 同名；脚本最后一条表达式的结果由 runInContext 返回。
      jsSandbox.result = m[0];
      jsSandbox.chapter = opts.chapter || null;
      jsSandbox.book = opts.book || null;
      jsSandbox.java = jsApi;
      let value;
      try {
        value = jsScript.runInContext(jsSandbox, { timeout: Math.max(1, deadline - Date.now()) });
      } catch (e) {
        if (e && (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out/i.test(String(e.message)))) {
          throw new RegexTimeoutError(`替换超时：规则「${opts.name || ""}」`);
        }
        throw e;
      }
      // legado：jsResult.quoteReplacementJs() 之后再 appendReplacement
      out += javaExpandReplacement(quoteReplacementJs(value == null ? "" : String(value)), m);
    } else {
      out += javaExpandReplacement(replacementRaw, m);
    }
    last = m.index + m[0].length;
    if (m[0] === "" && re.lastIndex === m.index) re.lastIndex += 1;
  }
  return out + text.slice(last);
}

/* ==================== 批量替换（大书解析优化） ==================== */

/**
 * 批量 @js: 求值脚本。
 *
 * 逐条调用 runInContext 时 Node 每次都要挂一个中断看门狗（实测约 113µs/次），
 * 大书 5000+ 章光看门狗就要 600ms，而规则本身只跑 ~50ms。
 * 整批只进一次 vm 即可摊掉这笔固定开销；每条输入仍是独立函数作用域里的
 * 一次 eval，与 legado「每个匹配点一次 eval」的语义保持一致。
 */
const JS_BATCH_SCRIPT = new vm.Script(`(function () {
  var out = new Array(__inputs.length);
  var errs = [];
  for (var i = 0; i < __inputs.length; i++) {
    result = __inputs[i];
    chapter = __chapters ? __chapters[i] : null;
    book = __books ? __books[i] : null;
    try {
      var v = (function () { return eval(__code); })();
      out[i] = v == null ? "" : String(v);
    } catch (e) {
      errs.push([i, String((e && e.message) || e)]);
      out[i] = null;
    }
  }
  return { out: out, errs: errs };
})()`, { filename: "replace-rule-js-batch" });

/** 单次批量求值的输入条数：太大时一次超时回退的代价高，太小则摊不掉看门狗开销。 */
const JS_BATCH_CHUNK = 256;

/**
 * 规则里出现 `java` 时，java.put/get 的状态是「每条文本一份」
 * （legado 每次 replace() 都新建 RegexJsExtensions），跨条共享会串状态，退回逐条。
 */
const JS_CODE_USES_JAVA = /\bjava\b/;

/** 整批跑一次 @js: 规则；返回 { out, errs }，errs 是 [下标, 错误信息]；超时抛错。 */
function runJsBatch(code, inputs, chapters, books, timeout, name) {
  const ctx = getJsSandbox(code);
  ctx.__code = code;
  ctx.__inputs = inputs;
  ctx.__chapters = chapters;
  ctx.__books = books;
  ctx.java = new RegexJsExtensions(name);
  try {
    return JS_BATCH_SCRIPT.runInContext(ctx, { timeout: Math.max(1, timeout) });
  } catch (e) {
    // 超时中断可能让 context 处于不确定状态，丢弃缓存避免后续复用出问题。
    if (jsContextCache.get(code) === ctx) jsContextCache.delete(code);
    throw e;
  }
}

/**
 * 批量替换 —— 结果与逐条 replaceWithRule 完全一致，只是把 @js: 求值合并成整批一次。
 *
 * 语义对齐 legado RegexExtensions.replace：
 *   逐匹配点 eval → quoteReplacementJs → Matcher.appendReplacement。
 *
 * 超时处理对齐 legado BookChapter.getDisplayTitle：规则超时 → 抛 RegexTimeoutError，
 * 由调用方禁用该规则。整批超时（病态规则）时先退回逐条执行以保留原有语义，
 * 逐条若再超时则原样抛出，不会把「该禁用规则」误判成「这几条标题失败」。
 *
 * @param {object} o 同 replaceWithRule，另加 o.texts（字符串数组）、
 *                   o.chapters / o.books（与 texts 等长，逐条绑定）
 * @returns {Array<string|null>} 与 texts 等长；null 表示该条失败，调用方应保持原文
 */
export function replaceManyWithRule(o) {
  const opts = o || {};
  const texts = Array.isArray(opts.texts)
    ? opts.texts.map((t) => String(t == null ? "" : t))
    : [];
  const n = texts.length;
  if (!n) return [];
  const pattern = String(opts.pattern == null ? "" : opts.pattern);
  if (!pattern) return texts.slice();

  const replacementRaw = String(opts.replacement == null ? "" : opts.replacement);
  const isRegex = opts.isRegex !== false;
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 3000;
  const chapters = Array.isArray(opts.chapters) ? opts.chapters : null;
  const books = Array.isArray(opts.books) ? opts.books : null;

  const single = (i) => replaceWithRule({
    name: opts.name,
    text: texts[i],
    pattern,
    replacement: replacementRaw,
    isRegex,
    timeout,
    chapter: (chapters && chapters[i]) || null,
    book: (books && books[i]) || null,
  });

  // 字面量替换 / 非 @js: 规则没有 vm 调用，逐条跑即可（与原有实现逐字节一致）。
  if (!isRegex || !replacementRaw.startsWith("@js:")) {
    return texts.map((_, i) => single(i));
  }

  const jsCode = replacementRaw.slice(4);
  if (JS_CODE_USES_JAVA.test(jsCode)) {
    return texts.map((_, i) => single(i));
  }

  const out = new Array(n);
  // 熔断：某一块批量超时后，说明这条规则本身就慢，剩下的块直接走逐条，
  // 免得每块都白等一次超时预算（最坏情况下只多付一次）。
  let batchUsable = true;
  for (let start = 0; start < n; start += JS_BATCH_CHUNK) {
    const end = Math.min(n, start + JS_BATCH_CHUNK);

    // 第一遍：正则扫描，按 Matcher.find 顺序收集这一块的匹配点。
    const chunkInputs = [];
    const chunkChapter = [];
    const chunkBook = [];
    const plans = [];
    for (let i = start; i < end; i++) {
      const text = texts[i];
      const re = javaRegex(pattern, "g");
      const segs = [];
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        segs.push({ pre: text.slice(last, m.index), match: m, at: chunkInputs.length });
        chunkInputs.push(m[0]);
        chunkChapter.push((chapters && chapters[i]) || null);
        chunkBook.push((books && books[i]) || null);
        last = m.index + m[0].length;
        if (m[0] === "" && re.lastIndex === m.index) re.lastIndex += 1;
      }
      plans.push({ text, segs, tail: text.slice(last) });
    }

    let evaluated = null;
    if (!chunkInputs.length) {
      evaluated = { out: [], errs: [] };
    } else if (!batchUsable) {
      evaluated = null;
    } else {
      try {
        evaluated = runJsBatch(jsCode, chunkInputs, chunkChapter, chunkBook, timeout, opts.name);
      } catch {
        evaluated = null; // 整批超时 / 求值环境异常 → 退回逐条
        batchUsable = false;
      }
    }

    if (!evaluated) {
      // 整批超时：退回逐条，每条重新拿满自己的 timeout（= legado 的单条预算）。
      // 逐条仍超时说明规则本身病态 → 原样抛出，由调用方禁用该规则（legado 同款）。
      for (let i = start; i < end; i++) {
        try {
          out[i] = single(i);
        } catch (e) {
          if (e instanceof RegexTimeoutError || (e && e.name === "RegexTimeoutError")) throw e;
          out[i] = null;
        }
      }
      continue;
    }

    const failedAt = new Set(evaluated.errs.map(([idx]) => idx));
    for (let k = 0; k < plans.length; k++) {
      const plan = plans[k];
      const i = start + k;
      if (!plan.segs.length) { out[i] = plan.text; continue; }
      try {
        let acc = "";
        let ok = true;
        for (const seg of plan.segs) {
          if (failedAt.has(seg.at)) { ok = false; break; }
          acc += seg.pre;
          const raw = evaluated.out[seg.at];
          acc += javaExpandReplacement(quoteReplacementJs(raw == null ? "" : raw), seg.match);
        }
        out[i] = ok ? acc + plan.tail : null;
      } catch {
        out[i] = null; // 与单条路径一致：这条规则在该文本上失败，保持原文
      }
    }
  }
  return out;
}
