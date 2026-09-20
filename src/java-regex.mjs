// src/java-regex.mjs
//
// Java / Android 正则兼容层。
//
// legado 的替换规则和书源规则使用 Java `Pattern` 语法，而 Node/浏览器用的是
// ECMAScript 语法。差异集中在这几处：
//   1. `\w` `\W`：Android/ICU 下 `\w` 是 Unicode 单词字符（中文算单词字符），
//      JS 默认只有 ASCII `[A-Za-z0-9_]`。legado #15 净化词语里的
//      `(?<=\n)\W+$` 正是靠这个语义，才不会把整段中文正文当成"非单词字符"删掉。
//   2. 裸内联 flag `(?mi)`：Java 允许出现在模式中间，作用域是"从此处到所在组末尾"，
//      ECMAScript 只允许在模式最开头。legado #15 就用了 `(?mi)`，
//      若提升为全局 flag 会让 `^`/`$` 变成多行，从而吞掉整段正文。
//   3. `\h` `\R`：Java 水平空白 / 任意换行，ECMAScript 没有。
//   4. `[A&&B]` `[A&&[^B]]`：Java 字符类交集/差集，ECMAScript 没有。
//   5. Java legacy 允许 `\!` `\–` `\,` 这类 identity escape，`u` flag 下非法。
//   6. `[\W国女]` 这类"补集 ∪ 字符"的类内补集，ECMAScript 无法直接表达。
//
// 本模块只做"Java Pattern -> 等价 ECMAScript"的翻译。

/** legado/Android 里 `\w` 的 Unicode 单词字符：字母 + 标记 + 十进制数字 + 连接符。 */
export const JAVA_WORD_BODY = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
/**
 * Java `\b` / `\B` 在 `Pattern.UNICODE_CHARACTER_CLASS` 下是「Unicode 单词边界」，
 * 而 ECMAScript 的 `\b` 只看 `[A-Za-z0-9_]`，中文两侧会被判成无边界
 * （legado #17 净化杂项里的 `(?<=\b：\n)` 就因此整条规则失效）。
 * 用零宽的前/后视断言精确复刻：边界 = 恰好一侧是单词字符。
 */
const WORD_BOUNDARY = "(?:(?<=[" + JAVA_WORD_BODY + "])(?![" + JAVA_WORD_BODY + "])|(?<![" + JAVA_WORD_BODY + "])(?=[" + JAVA_WORD_BODY + "]))";
const NON_WORD_BOUNDARY = "(?:(?<=[" + JAVA_WORD_BODY + "])(?=[" + JAVA_WORD_BODY + "])|(?<![" + JAVA_WORD_BODY + "])(?![" + JAVA_WORD_BODY + "]))";
/** Java `\h` 的水平空白字符类内容。 */
const HORIZONTAL_WS_BODY = "\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000";
/** Java `\R` 的任意换行序列。 */
const ANY_LINE_BREAK = "(?:\\r\\n|[\\n\\r\\u2028\\u2029\\u0085])";

const KEEP_ESCAPE_LETTERS = new Set([
  "d", "D", "s", "S", "b", "B", "n", "r", "t", "v", "f", "0",
  "x", "u", "c", "p", "P", "k", "K",
]);
const KEEP_OUTSIDE_LITERAL = new Set(["^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/", "\\"]);
const KEEP_IN_CLASS_LITERAL = new Set(["]", "\\", "^"]);

/** 把 Java `\Q...\E` 字面量块转义成 ECMAScript 源串。 */
function convertQuotedLiterals(src) {
  if (!src.includes("\\Q")) return src;
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\" && src[i + 1] === "Q") {
      const end = src.indexOf("\\E", i + 2);
      const body = end < 0 ? src.slice(i + 2) : src.slice(i + 2, end);
      out += body.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** 展开 Java 字符类差集 `[A&&[^B]]`，返回分组写法。 */
function expandDifference(a, b) {
  return "(?:(?![" + b + "])[" + (a || "\\s\\S") + "])";
}
/** 展开 Java 字符类交集 `[A&&B]`，返回分组写法。 */
function expandIntersection(a, b) {
  return "(?:(?=[" + a + "])[" + b + "])";
}

/**
 * 处理一个字符类的"内容"（不含外层方括号）。
 * 返回 { text, group }：group 为 true 时 text 已经是可独立使用的分组表达式。
 */
function rewriteClassBody(body) {
  // 负向类 [^...]：先原样转换，不参与集合运算。
  if (body.startsWith("^")) {
    return { text: "^" + convertClassBody(body.slice(1)), group: false };
  }

  // 补集并集：[\W国女] == (?:\W|[国女])，[\D...] / [\S...] 同理。
  const unionMatch = /\\[WDS]/.exec(body);
  if (unionMatch) {
    const kind = unionMatch[0][1];
    const complement = kind === "W" ? "[^" + JAVA_WORD_BODY + "]"
      : kind === "D" ? "[^0-9]"
      : "[^\\t\\n\\x0B\\f\\r ]";
    const rest = body.replace(/\\[WDS]/g, "");
    const restText = rest ? "[" + convertClassBody(rest) + "]" : "";
    return { text: "(?:" + complement + (restText ? "|" + restText : "") + ")", group: true };
  }

  // 差集 / 交集（单层）
  const diff = /^([^\[\]]*)&&\[\^([^\[\]]*)\]$/.exec(body);
  if (diff) {
    return { text: expandDifference(convertClassBody(diff[1]), convertClassBody(diff[2])), group: true };
  }
  const inter = /^([^\[\]]*)&&([^\[\]]*)$/.exec(body);
  if (inter) {
    return { text: expandIntersection(convertClassBody(inter[1]), convertClassBody(inter[2])), group: true };
  }

  return { text: convertClassBody(body), group: false };
}

/** 转换字符类内部的转义，保留 Java 语义。 */
function convertClassBody(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c !== "\\") { out += c; i += 1; continue; }
    const n = body[i + 1];
    if (n === undefined) { out += "\\\\"; i += 1; continue; }
    if (n === "w") { out += JAVA_WORD_BODY; i += 2; continue; }
    if (n === "h") { out += HORIZONTAL_WS_BODY; i += 2; continue; }
    if (n === "b") { out += "\\x08"; i += 2; continue; }
    if (n === "B") { out += "B"; i += 2; continue; }
    if (KEEP_ESCAPE_LETTERS.has(n) || KEEP_IN_CLASS_LITERAL.has(n)) {
      out += "\\" + n; i += 2; continue;
    }
    // identity escape：丢掉反斜杠；`-` 用 \x2d 防止意外变成区间。
    if (n === "-") { out += "\\x2d"; i += 2; continue; }
    if (n === "]") { out += "\\x5d"; i += 2; continue; }
    out += n; i += 2;
  }
  return out;
}

/** 把 Java `\w` `\W` `\h` `\R` 以及字符类交集/差集替换为 ECMAScript 写法。 */
function convertEscapes(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) { out += "\\\\"; i += 1; continue; }
      if (n === "w") { out += "[" + JAVA_WORD_BODY + "]"; i += 2; continue; }
      if (n === "W") { out += "[^" + JAVA_WORD_BODY + "]"; i += 2; continue; }
      if (n === "h") { out += "[" + HORIZONTAL_WS_BODY + "]"; i += 2; continue; }
      if (n === "H") { out += "[^" + HORIZONTAL_WS_BODY + "]"; i += 2; continue; }
      if (n === "R") { out += ANY_LINE_BREAK; i += 2; continue; }
      if (n === "A") { out += "^"; i += 2; continue; }
      if (n === "z") { out += "$"; i += 2; continue; }
      if (n === "Z") { out += "(?=\\n?$)"; i += 2; continue; }
      if (n === "G") { out += ""; i += 2; continue; }
      // Java Unicode 单词边界（见上方 WORD_BOUNDARY 注释）
      if (n === "b") { out += WORD_BOUNDARY; i += 2; continue; }
      if (n === "B") { out += NON_WORD_BOUNDARY; i += 2; continue; }
      if (KEEP_ESCAPE_LETTERS.has(n) || KEEP_OUTSIDE_LITERAL.has(n)) {
        out += "\\" + n; i += 2; continue;
      }
      // Java legacy identity escape：\! \% \– \~ \_ 等，直接输出该字符。
      out += n; i += 2;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let depth = 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") {
          // Java nested class only appears after && (e.g. [A&&[^B]]).
          if (src[j - 1] === "&" && src[j - 2] === "&") depth += 1;
          j += 1;
          continue;
        }
        if (src[j] === "]") depth -= 1;
        j += 1;
      }
      const inner = src.slice(i + 1, j - 1);
      const rewritten = rewriteClassBody(inner);
      out += rewritten.group ? rewritten.text : "[" + rewritten.text + "]";
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 把裸内联 flag `(?ims)` / `(?i-ms)` 翻译成作用于"剩余部分"的限定组 `(?ims:...)`。
 * Java 语义：从该点到当前所在组结束；ECMAScript 的 `(?ims-ims:...)` 完全对应。
 */
function convertInlineFlags(src) {
  let i = 0;
  let changed = false;

  function readGroupBody(stopAtClose) {
    let out = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { out += c + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === "[") {
        let j = i + 1;
        let depth = 1;
        while (j < src.length && depth > 0) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") {
            if (src[j - 1] === "&" && src[j - 2] === "&") depth += 1;
            j += 1;
            continue;
          }
          if (src[j] === "]") depth -= 1;
          j += 1;
        }
        out += src.slice(i, j);
        i = j;
        continue;
      }
      if (c === ")") {
        if (stopAtClose) { i += 1; return { text: out, closed: true }; }
        out += c; i += 1; continue;
      }
      if (c === "(") {
        const m = /^\(\?([ims]*)(?:-([ims]+))?\)/.exec(src.slice(i));
        if (m && (m[1] || m[2])) {
          const on = m[1] || "";
          const off = m[2] || "";
          const spec = on + (off ? "-" + off : "");
          i += m[0].length;
          const rest = readGroupBody(stopAtClose);
          out += "(?" + spec + ":" + rest.text + ")";
          changed = true;
          return { text: out, closed: rest.closed };
        }
        const pm = /^\(\?(?:[:=!]|<[=!])/.exec(src.slice(i));
        if (pm) {
          out += pm[0]; i += pm[0].length;
          const inner = readGroupBody(true);
          out += inner.text + ")";
          continue;
        }
        out += "("; i += 1;
        const inner = readGroupBody(true);
        out += inner.text + ")";
        continue;
      }
      out += c; i += 1;
    }
    return { text: out, closed: false };
  }

  const res = readGroupBody(false);
  return changed ? res.text : src;
}

/** 纯转换：Java Pattern 源串 -> ECMAScript 源串。 */
export function javaRegexSource(pattern) {
  const s = String(pattern == null ? "" : pattern);
  return convertInlineFlags(convertEscapes(convertQuotedLiterals(s)));
}

/**
 * 构造一个 Java 语义的正则。
 *
 * @param {string} pattern Java Pattern 源串
 * @param {string} flags `g` / `i` / `m` / `s`，默认 `g`
 * @returns {RegExp}
 */
export function javaRegex(pattern, flags = "g") {
  const source = javaRegexSource(pattern);
  const uniq = Array.from(new Set(("u" + String(flags || "")).split(""))).join("");
  return new RegExp(source, uniq);
}

/** 尝试转换并构造，失败返回 null。 */
export function tryJavaRegex(pattern, flags = "g") {
  try { return javaRegex(pattern, flags); } catch { return null; }
}

/** 判断单个字符是否属于 Java `\w`。 */
export function isJavaWordChar(ch) {
  return new RegExp("^[" + JAVA_WORD_BODY + "]$", "u").test(ch);
}
