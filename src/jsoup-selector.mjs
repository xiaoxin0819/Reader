// jsoup-selector.mjs -- org.jsoup.select 的 1:1 移植（jsoup 1.16.2）
//
// legado 的 AnalyzeByJSoup 在 isCss 分支里直接调用 jsoup 的 Element.select()，
// 因此 @css: 规则可以使用 jsoup 的全部 CSS 扩展语法：
//   :eq(n) :lt(n) :gt(n) :has() :not() :contains() :containsOwn() :containsWholeText()
//   :containsData() :matches() :matchesOwn() :matchText :nth-child(An+B) :first-child
//   :last-child :first-of-type :last-of-type :only-child :only-of-type :empty :root
//   [attr~=regex] [^attrPrefix] [attr!=v] 等
// 之前这里用的是 css-select，上述 jsoup 专有语法要么抛异常、要么静默返回 0 个元素
// （异常被 catch 吞掉），导致书源的 kind / lastChapter / nextContentUrl 等字段解析为空。
//
// 逐行对照源码：
//   .research/jsoup-1.16.2/jsoup/select/QueryParser.java
//   .research/jsoup-1.16.2/jsoup/select/Evaluator.java
//   .research/jsoup-1.16.2/jsoup/select/CombiningEvaluator.java
//   .research/jsoup-1.16.2/jsoup/select/StructuralEvaluator.java
//   .research/jsoup-1.16.2/jsoup/select/Collector.java
//   .research/jsoup-1.16.2/jsoup/select/Selector.java
//   .research/jsoup-1.16.2/jsoup/parser/TokenQueue.java
//   .research/jsoup-1.16.2/jsoup/internal/StringUtil.java
//   .research/jsoup-1.16.2/jsoup/internal/Normalizer.java
import { isTag, isText, isCDATA, isComment, isDocument, Element } from 'domhandler';
import { getChildren } from 'domutils';
import { elementText, elementOwnText, elementData } from './analyze-jsoup.mjs';

export class SelectorParseException extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SelectorParseException';
  }
}

function validateFail(msg) {
  throw new SelectorParseException(msg);
}

// ---------- Normalizer ----------
function lowerCase(s) {
  return s == null ? '' : String(s).toLowerCase();
}
function normalize(s) {
  return lowerCase(s).trim();
}
function normalizeLiteral(s, isStringLiteral) {
  return isStringLiteral ? lowerCase(s) : normalize(s);
}

// ---------- StringUtil ----------
const WORD_RE = /[\p{L}\p{Nd}]/u;
const DIGIT_RE = /^\p{Nd}$/u;

function isWhitespaceCode(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
}
function isNumericStr(s) {
  if (s == null || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) if (!DIGIT_RE.test(s.charAt(i))) return false;
  return true;
}
// Java Integer.parseInt（不允许空白，失败即抛，调用方会转成 SelectorParseException）
function javaParseInt(s) {
  if (!/^[+-]?\d+$/.test(s)) throw new SelectorParseException("not an integer: '" + s + "'");
  return parseInt(s, 10);
}
const isActuallyWhitespaceCode = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === '\u00a0';
function isInvisibleCode(c) {
  const n = c.codePointAt(0);
  return n === 0x200b || (n >= 0x200c && n <= 0x200f) || n === 0xfeff || n === 0x2060;
}
// StringUtil.normaliseWhitespace / appendNormalisedWhitespace(stripLeading=false)
export function normaliseWhitespace(str) {
  const src = str == null ? '' : String(str);
  let out = '';
  let lastWasWhite = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (isActuallyWhitespaceCode(c)) {
      if (lastWasWhite) continue;
      out += ' ';
      lastWasWhite = true;
    } else if (!isInvisibleCode(c)) {
      out += c;
      lastWasWhite = false;
    }
  }
  return out;
}

// ---------- Java Pattern -> JS RegExp ----------
// 处理 Java 正则里的 \Q..\E（Pattern.quote）与前导内联标志 (?i)(?s)(?m)(?u)(?x)(?d)
export function javaPatternToJs(src) {
  let body = String(src);
  let flags = '';
  for (;;) {
    const m = /^\(\?([a-zA-Z]+)\)/.exec(body);
    if (!m) break;
    for (const ch of m[1]) {
      if ('ism'.indexOf(ch) >= 0) {
        if (flags.indexOf(ch) < 0) flags += ch;
      } else if ('udx'.indexOf(ch) >= 0) {
        // u/d/x 在 JS 无对应或语义无关，忽略
      } else {
        throw new SelectorParseException("unsupported inline flag in regex: " + ch);
      }
    }
    body = body.substring(m[0].length);
  }
  // \Q ... \E -> 字面量转义
  if (body.indexOf('\\Q') >= 0) {
    let out = '';
    let inQuote = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body.charAt(i);
      if (!inQuote && ch === '\\' && body.charAt(i + 1) === 'Q') {
        inQuote = true;
        i++;
        continue;
      }
      if (inQuote && ch === '\\' && body.charAt(i + 1) === 'E') {
        inQuote = false;
        i++;
        continue;
      }
      if (inQuote) out += ch.replace(/[.\*+?^$(){}|[\]\\\/]/g, (x) => '\\' + x);
      else out += ch;
    }
    body = out;
  }
  try {
    return new RegExp(body, flags);
  } catch (e) {
    throw new SelectorParseException('bad regex: ' + src + ' (' + (e && e.message) + ')');
  }
}

// ---------- TokenQueue (org.jsoup.parser.TokenQueue) ----------
const ESC = '\\';
const NUL = '\u0000';

export class TokenQueue {
  constructor(data) {
    if (data == null) throw new Error('Queue data must not be null');
    this.queue = String(data);
    this.pos = 0;
  }
  isEmpty() {
    return this.remainingLength() === 0;
  }
  remainingLength() {
    return this.queue.length - this.pos;
  }
  addFirst(seq) {
    this.queue = String(seq) + this.queue.substring(this.pos);
    this.pos = 0;
  }
  matches(seq) {
    const s = String(seq);
    const p = this.pos;
    if (p + s.length > this.queue.length) return false;
    for (let i = 0; i < s.length; i++) {
      const a = this.queue.charAt(p + i);
      const b = s.charAt(i);
      if (a !== b && a.toLowerCase() !== b.toLowerCase()) return false;
    }
    return true;
  }
  matchesAny(...seq) {
    for (const s of seq) if (this.matches(s)) return true;
    return false;
  }
  matchesAnyChar(...chars) {
    if (this.isEmpty()) return false;
    const c = this.queue.charAt(this.pos);
    for (const ch of chars) if (c === ch) return true;
    return false;
  }
  matchChomp(seq) {
    if (this.matches(seq)) {
      this.pos += String(seq).length;
      return true;
    }
    return false;
  }
  matchesWhitespace() {
    return !this.isEmpty() && isWhitespaceCode(this.queue.charAt(this.pos));
  }
  matchesWord() {
    return !this.isEmpty() && WORD_RE.test(this.queue.charAt(this.pos));
  }
  advance() {
    if (!this.isEmpty()) this.pos++;
  }
  consume() {
    const c = this.queue.charAt(this.pos);
    this.pos++;
    return c;
  }
  consumeSeq(seq) {
    if (!this.matches(seq)) throw new Error('Queue did not match expected sequence');
    const len = String(seq).length;
    if (len > this.remainingLength()) throw new Error('Queue not long enough to consume sequence');
    this.pos += len;
  }
  consumeTo(seq) {
    const offset = this.queue.indexOf(String(seq), this.pos);
    if (offset !== -1) {
      const consumed = this.queue.substring(this.pos, offset);
      this.pos += consumed.length;
      return consumed;
    }
    return this.remainder();
  }
  consumeToAny(...seqs) {
    const start = this.pos;
    while (!this.isEmpty() && !this.matchesAny(...seqs)) this.pos++;
    return this.queue.substring(start, this.pos);
  }
  consumeWhitespace() {
    let seen = false;
    while (this.matchesWhitespace()) {
      this.pos++;
      seen = true;
    }
    return seen;
  }
  consumeWord() {
    const start = this.pos;
    while (this.matchesWord()) this.pos++;
    return this.queue.substring(start, this.pos);
  }
  consumeElementSelector() {
    return this._consumeEscapedCssIdentifier(['*|', '|', '_', '-']);
  }
  consumeCssIdentifier() {
    return this._consumeEscapedCssIdentifier(['-', '_']);
  }
  _consumeEscapedCssIdentifier(matches) {
    const start = this.pos;
    let escaped = false;
    while (!this.isEmpty()) {
      if (this.queue.charAt(this.pos) === ESC && this.remainingLength() > 1) {
        escaped = true;
        this.pos += 2;
      } else if (this._matchesCssIdentifier(matches)) {
        this.pos++;
      } else {
        break;
      }
    }
    const consumed = this.queue.substring(start, this.pos);
    return escaped ? TokenQueue.unescape(consumed) : consumed;
  }
  _matchesCssIdentifier(matches) {
    return this.matchesWord() || this.matchesAny(...matches);
  }
  chompBalanced(open, close) {
    let start = -1;
    let end = -1;
    let depth = 0;
    let last = NUL;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inRegexQE = false;
    do {
      if (this.isEmpty()) break;
      let c = this.consume();
      if (last !== ESC) {
        if (c === "'" && c !== open && !inDoubleQuote) inSingleQuote = !inSingleQuote;
        else if (c === '"' && c !== open && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
        if (inSingleQuote || inDoubleQuote || inRegexQE) {
          last = c;
          continue;
        }
        if (c === open) {
          depth++;
          if (start === -1) start = this.pos;
        } else if (c === close) {
          depth--;
        }
      } else if (c === 'Q') {
        inRegexQE = true;
      } else if (c === 'E') {
        inRegexQE = false;
      }
      if (depth > 0 && last !== NUL) end = this.pos;
      last = c;
      if (c === NUL) c = NUL;
    } while (depth > 0);
    const out = end >= 0 ? this.queue.substring(start, end) : '';
    if (depth > 0) validateFail("Did not find balanced marker at '" + out + "'");
    return out;
  }
  remainder() {
    const r = this.queue.substring(this.pos);
    this.pos = this.queue.length;
    return r;
  }
  toString() {
    return this.queue.substring(this.pos);
  }
  static unescape(inp) {
    let out = '';
    let last = NUL;
    const s = String(inp);
    for (let i = 0; i < s.length; i++) {
      let c = s.charAt(i);
      if (c === ESC) {
        if (last === ESC) {
          out += c;
          c = NUL;
        }
      } else {
        out += c;
      }
      last = c;
    }
    return out;
  }
}

// ---------- Element 语义辅助（对应 org.jsoup.nodes.Element） ----------

function tagNameOf(el) {
  return (el && el.name) || '';
}
export function normalName(el) {
  return tagNameOf(el).toLowerCase();
}
function parentEl(el) {
  const p = el && el.parent;
  return p && isTag(p) ? p : null;
}
function elementChildren(el) {
  if (!el) return [];
  return getChildren(el).filter(isTag);
}
function firstElementChild(el) {
  const kids = elementChildren(el);
  return kids.length ? kids[0] : null;
}
function lastElementChild(el) {
  const kids = elementChildren(el);
  return kids.length ? kids[kids.length - 1] : null;
}
function nextElementSibling(el) {
  const p = parentEl(el);
  if (!p) return null;
  const kids = elementChildren(p);
  const i = kids.indexOf(el);
  if (i < 0) return null;
  return i + 1 < kids.length ? kids[i + 1] : null;
}
function prevElementSibling(el) {
  const p = parentEl(el);
  if (!p) return null;
  const kids = elementChildren(p);
  const i = kids.indexOf(el);
  return i > 0 ? kids[i - 1] : null;
}
function firstElementSibling(el) {
  const p = parentEl(el);
  return p ? firstElementChild(p) : el; // orphan is its own first sibling
}
function elementSiblingIndex(el) {
  const p = parentEl(el);
  if (!p) return 0;
  return elementChildren(p).indexOf(el);
}
function siblingElements(el) {
  const p = parentEl(el);
  if (!p) return [];
  return elementChildren(p).filter((c) => c !== el);
}
// Node.attr / Node.hasAttr（属性名大小写不敏感；htmlparser2 已小写化）
function hasAttrOf(node, key) {
  if (!node || !node.attribs) return false;
  const k = String(key).toLowerCase();
  if (k.startsWith('abs:')) {
    const real = k.substring(4);
    return Object.prototype.hasOwnProperty.call(node.attribs, real) && String(node.attribs[real]).length > 0;
  }
  return Object.prototype.hasOwnProperty.call(node.attribs, k);
}
function attrOfEl(node, key) {
  if (!node || !node.attribs) return '';
  const k = String(key).toLowerCase();
  if (k.startsWith('abs:')) return attrOfEl(node, k.substring(4));
  const v = node.attribs[k];
  return v === undefined || v === null ? '' : String(v);
}
function attrKeys(node) {
  return node && node.attribs ? Object.keys(node.attribs) : [];
}
// Element.hasClass（大小写不敏感、按空白分词）
function hasClassOf(el, className) {
  const cls = attrOfEl(el, 'class');
  if (!cls) return false;
  const want = String(className);
  if (cls.length < want.length) return false;
  if (cls.length === want.length) return cls.toLowerCase() === want.toLowerCase();
  const words = cls.split(/[\t\n\f\r ]+/);
  for (const w of words) if (w.toLowerCase() === want.toLowerCase()) return true;
  return false;
}
// Element.wholeText / wholeOwnText：只累加 TextNode，<br> 记为 "\n"
function appendWholeText(node, acc) {
  if (isText(node) || isCDATA(node)) acc.out += node.data || '';
  else if (isTag(node) && normalName(node) === 'br') acc.out += '\n';
}
export function elementWholeText(el) {
  const acc = { out: '' };
  const walk = (node) => {
    appendWholeText(node, acc);
    for (const c of getChildren(node)) walk(c);
  };
  walk(el);
  return acc.out;
}
export function elementWholeOwnText(el) {
  const acc = { out: '' };
  for (const c of getChildren(el)) appendWholeText(c, acc);
  return acc.out;
}

// ---------- Evaluator（org.jsoup.select.Evaluator） ----------

export class Evaluator {
  matches(root, element) {
    return false;
  }
  reset() {}
  cost() {
    return 5;
  }
}

class TagEval extends Evaluator {
  constructor(tagName) {
    super();
    this.tagName = tagName;
  }
  matches(root, element) {
    return normalName(element) === this.tagName;
  }
  cost() {
    return 1;
  }
  toString() {
    return this.tagName;
  }
}

class TagEndsWithEval extends Evaluator {
  constructor(tagName) {
    super();
    this.tagName = tagName;
  }
  matches(root, element) {
    return normalName(element).endsWith(this.tagName);
  }
  toString() {
    return this.tagName;
  }
}

class IdEval extends Evaluator {
  constructor(id) {
    super();
    this.id = id;
  }
  matches(root, element) {
    return this.id === attrOfEl(element, 'id');
  }
  cost() {
    return 2;
  }
  toString() {
    return '#' + this.id;
  }
}

class ClassEval extends Evaluator {
  constructor(className) {
    super();
    this.className = className;
  }
  matches(root, element) {
    return hasClassOf(element, this.className);
  }
  cost() {
    return 6;
  }
  toString() {
    return '.' + this.className;
  }
}

class AttributeEval extends Evaluator {
  constructor(key) {
    super();
    this.key = key;
  }
  matches(root, element) {
    return hasAttrOf(element, this.key);
  }
  cost() {
    return 2;
  }
  toString() {
    return '[' + this.key + ']';
  }
}

class AttributeStartingEval extends Evaluator {
  constructor(keyPrefix) {
    super();
    if (!keyPrefix) validateFail('attribute prefix must not be empty');
    this.keyPrefix = lowerCase(keyPrefix);
  }
  matches(root, element) {
    for (const k of attrKeys(element)) if (lowerCase(k).startsWith(this.keyPrefix)) return true;
    return false;
  }
  cost() {
    return 2;
  }
  toString() {
    return '[^' + this.keyPrefix + ']';
  }
}

// AttributeKeyPair
class AttributeKeyPairEval extends Evaluator {
  constructor(key, value, trimValue = true) {
    super();
    if (!key) validateFail('attribute key must not be empty');
    if (!value) validateFail('attribute value must not be empty');
    this.key = normalize(key);
    const isStringLiteral =
      (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
    let v = isStringLiteral ? value.substring(1, value.length - 1) : value;
    this.value = normalizeLiteral(v, isStringLiteral);
    this.trimValue = trimValue;
  }
}

class AttributeWithValueEval extends AttributeKeyPairEval {
  matches(root, element) {
    return hasAttrOf(element, this.key) && this.value === lowerCase(attrOfEl(element, this.key).trim());
  }
  cost() {
    return 3;
  }
  toString() {
    return '[' + this.key + '=' + this.value + ']';
  }
}

class AttributeWithValueNotEval extends AttributeKeyPairEval {
  matches(root, element) {
    return !(this.value === lowerCase(attrOfEl(element, this.key)));
  }
  cost() {
    return 3;
  }
}

class AttributeWithValueStartingEval extends AttributeKeyPairEval {
  constructor(key, value) {
    super(key, value, false);
  }
  matches(root, element) {
    return hasAttrOf(element, this.key) && lowerCase(attrOfEl(element, this.key)).startsWith(this.value);
  }
  cost() {
    return 4;
  }
}

class AttributeWithValueEndingEval extends AttributeKeyPairEval {
  constructor(key, value) {
    super(key, value, false);
  }
  matches(root, element) {
    return hasAttrOf(element, this.key) && lowerCase(attrOfEl(element, this.key)).endsWith(this.value);
  }
  cost() {
    return 4;
  }
}

class AttributeWithValueContainingEval extends AttributeKeyPairEval {
  matches(root, element) {
    return hasAttrOf(element, this.key) && lowerCase(attrOfEl(element, this.key)).includes(this.value);
  }
  cost() {
    return 6;
  }
}

// [attr~=regex]
class AttributeWithValueMatchingEval extends Evaluator {
  constructor(key, pattern) {
    super();
    this.key = normalize(key);
    this.pattern = pattern;
  }
  matches(root, element) {
    return hasAttrOf(element, this.key) && this.pattern.test(attrOfEl(element, this.key));
  }
  cost() {
    return 8;
  }
  toString() {
    return '[' + this.key + '~=' + this.pattern + ']';
  }
}

class AllElementsEval extends Evaluator {
  matches() {
    return true;
  }
  cost() {
    return 10;
  }
  toString() {
    return '*';
  }
}

class IndexLessThanEval extends Evaluator {
  constructor(index) {
    super();
    this.index = index;
  }
  matches(root, element) {
    return root !== element && elementSiblingIndex(element) < this.index;
  }
  toString() {
    return ':lt(' + this.index + ')';
  }
}

class IndexGreaterThanEval extends Evaluator {
  constructor(index) {
    super();
    this.index = index;
  }
  matches(root, element) {
    return elementSiblingIndex(element) > this.index;
  }
  toString() {
    return ':gt(' + this.index + ')';
  }
}

class IndexEqualsEval extends Evaluator {
  constructor(index) {
    super();
    this.index = index;
  }
  matches(root, element) {
    return elementSiblingIndex(element) === this.index;
  }
  toString() {
    return ':eq(' + this.index + ')';
  }
}

class IsLastChildEval extends Evaluator {
  matches(root, element) {
    const p = parentEl(element);
    return p != null && lastElementChild(p) === element;
  }
  toString() {
    return ':last-child';
  }
}

class IsFirstChildEval extends Evaluator {
  matches(root, element) {
    const p = parentEl(element);
    return p != null && firstElementChild(p) === element;
  }
  toString() {
    return ':first-child';
  }
}

class IsRootEval extends Evaluator {
  matches(root, element) {
    const r = isDocument(root) ? firstElementChild(root) : root;
    return element === r;
  }
  cost() {
    return 1;
  }
  toString() {
    return ':root';
  }
}

class IsOnlyChildEval extends Evaluator {
  matches(root, element) {
    const p = parentEl(element);
    return p != null && siblingElements(element).length === 0;
  }
  toString() {
    return ':only-child';
  }
}

class IsOnlyOfTypeEval extends Evaluator {
  matches(root, element) {
    const p = parentEl(element);
    if (p == null) return false;
    let pos = 0;
    let next = firstElementChild(p);
    const name = normalName(element);
    while (next != null) {
      if (normalName(next) === name) pos++;
      if (pos > 1) break;
      next = nextElementSibling(next);
    }
    return pos === 1;
  }
  toString() {
    return ':only-of-type';
  }
}

class IsEmptyEval extends Evaluator {
  matches(root, element) {
    for (const n of getChildren(element)) {
      if (isText(n)) {
        if (/^\s*$/.test(n.data || '')) continue;
        return false;
      }
      if (isComment(n)) continue;
      return false;
    }
    return true;
  }
  toString() {
    return ':empty';
  }
}

// CssNthEvaluator
class CssNthEvaluator extends Evaluator {
  constructor(a, b) {
    super();
    this.a = a;
    this.b = b;
  }
  matches(root, element) {
    const p = parentEl(element);
    if (p == null) return false;
    const pos = this.calculatePosition(root, element);
    if (this.a === 0) return pos === this.b;
    return (pos - this.b) * this.a >= 0 && (pos - this.b) % this.a === 0;
  }
  toString() {
    if (this.a === 0) return ':' + this.getPseudoClass() + '(' + this.b + ')';
    if (this.b === 0) return ':' + this.getPseudoClass() + '(' + this.a + 'n)';
    return ':' + this.getPseudoClass() + '(' + this.a + 'n' + (this.b >= 0 ? '+' : '') + this.b + ')';
  }
}

class IsNthChildEval extends CssNthEvaluator {
  calculatePosition(root, element) {
    return elementSiblingIndex(element) + 1;
  }
  getPseudoClass() {
    return 'nth-child';
  }
}

class IsNthLastChildEval extends CssNthEvaluator {
  calculatePosition(root, element) {
    const p = parentEl(element);
    if (!p) return 0;
    return elementChildren(p).length - elementSiblingIndex(element);
  }
  getPseudoClass() {
    return 'nth-last-child';
  }
}

class IsNthOfTypeEval extends CssNthEvaluator {
  calculatePosition(root, element) {
    const p = parentEl(element);
    if (!p) return 0;
    const name = normalName(element);
    let pos = 0;
    for (const node of getChildren(p)) {
      if (isTag(node) && normalName(node) === name) pos++;
      if (node === element) break;
    }
    return pos;
  }
  getPseudoClass() {
    return 'nth-of-type';
  }
}

class IsNthLastOfTypeEval extends CssNthEvaluator {
  calculatePosition(root, element) {
    const p = parentEl(element);
    if (!p) return 0;
    let pos = 0;
    let next = element;
    const name = normalName(element);
    while (next != null) {
      if (normalName(next) === name) pos++;
      next = nextElementSibling(next);
    }
    return pos;
  }
  getPseudoClass() {
    return 'nth-last-of-type';
  }
}

class IsFirstOfTypeEval extends IsNthOfTypeEval {
  constructor() {
    super(0, 1);
  }
  toString() {
    return ':first-of-type';
  }
}

class IsLastOfTypeEval extends IsNthLastOfTypeEval {
  constructor() {
    super(0, 1);
  }
  toString() {
    return ':last-of-type';
  }
}

class ContainsTextEval extends Evaluator {
  constructor(searchText) {
    super();
    this.searchText = lowerCase(normaliseWhitespace(searchText));
  }
  matches(root, element) {
    return lowerCase(elementText(element)).includes(this.searchText);
  }
  cost() {
    return 10;
  }
  toString() {
    return ':contains(' + this.searchText + ')';
  }
}

class ContainsOwnTextEval extends Evaluator {
  constructor(searchText) {
    super();
    this.searchText = lowerCase(normaliseWhitespace(searchText));
  }
  matches(root, element) {
    return lowerCase(elementOwnText(element)).includes(this.searchText);
  }
  toString() {
    return ':containsOwn(' + this.searchText + ')';
  }
}

class ContainsWholeTextEval extends Evaluator {
  constructor(searchText) {
    super();
    this.searchText = searchText;
  }
  matches(root, element) {
    return elementWholeText(element).includes(this.searchText);
  }
  cost() {
    return 10;
  }
}

class ContainsWholeOwnTextEval extends Evaluator {
  constructor(searchText) {
    super();
    this.searchText = searchText;
  }
  matches(root, element) {
    return elementWholeOwnText(element).includes(this.searchText);
  }
}

class ContainsDataEval extends Evaluator {
  constructor(searchText) {
    super();
    this.searchText = lowerCase(searchText);
  }
  matches(root, element) {
    return lowerCase(elementData(element)).includes(this.searchText);
  }
}

class MatchesEval extends Evaluator {
  constructor(pattern) {
    super();
    this.pattern = pattern;
  }
  matches(root, element) {
    return this.pattern.test(elementText(element));
  }
  cost() {
    return 8;
  }
  toString() {
    return ':matches(' + this.pattern + ')';
  }
}

class MatchesOwnEval extends Evaluator {
  constructor(pattern) {
    super();
    this.pattern = pattern;
  }
  matches(root, element) {
    return this.pattern.test(elementOwnText(element));
  }
  cost() {
    return 7;
  }
}

class MatchesWholeTextEval extends Evaluator {
  constructor(pattern) {
    super();
    this.pattern = pattern;
  }
  matches(root, element) {
    return this.pattern.test(elementWholeText(element));
  }
  cost() {
    return 8;
  }
}

class MatchesWholeOwnTextEval extends Evaluator {
  constructor(pattern) {
    super();
    this.pattern = pattern;
  }
  matches(root, element) {
    return this.pattern.test(elementWholeOwnText(element));
  }
  cost() {
    return 7;
  }
}

// ---------- CombiningEvaluator（org.jsoup.select.CombiningEvaluator） ----------

class CombiningEvaluator extends Evaluator {
  constructor(evaluators) {
    super();
    this.evaluators = [];
    this.sortedEvaluators = [];
    this.num = 0;
    this.costValue = 0;
    if (evaluators) {
      this.evaluators = evaluators.slice();
      this.updateEvaluators();
    }
  }
  reset() {
    for (const e of this.evaluators) e.reset();
    super.reset();
  }
  cost() {
    return this.costValue;
  }
  rightMostEvaluator() {
    return this.num > 0 ? this.evaluators[this.num - 1] : null;
  }
  replaceRightMostEvaluator(replacement) {
    this.evaluators[this.num - 1] = replacement;
    this.updateEvaluators();
  }
  updateEvaluators() {
    this.num = this.evaluators.length;
    let c = 0;
    for (const e of this.evaluators) c += e.cost();
    this.costValue = c;
    this.sortedEvaluators = this.evaluators.slice().sort((a, b) => a.cost() - b.cost());
  }
}

export class AndEval extends CombiningEvaluator {
  matches(root, element) {
    for (let i = 0; i < this.num; i++) {
      if (!this.sortedEvaluators[i].matches(root, element)) return false;
    }
    return true;
  }
  toString() {
    return this.evaluators.map(String).join('');
  }
}

export class OrEval extends CombiningEvaluator {
  constructor(evaluators) {
    super();
    if (evaluators) this.evaluators.push(...evaluators); // jsoup 的 num>1 分支不可达（super() 后 num 恒为 0）
    this.updateEvaluators();
  }
  add(e) {
    this.evaluators.push(e);
    this.updateEvaluators();
  }
  matches(root, node) {
    for (let i = 0; i < this.num; i++) {
      if (this.sortedEvaluators[i].matches(root, node)) return true;
    }
    return false;
  }
  toString() {
    return this.evaluators.map(String).join(', ');
  }
}

// ---------- StructuralEvaluator ----------

class StructuralEvaluator extends Evaluator {
  constructor(evaluator) {
    super();
    this.evaluator = evaluator;
    this._memo = new Map(); // root -> Map(element -> boolean)
  }
  memoMatches(root, element) {
    let memo = this._memo.get(root);
    if (!memo) {
      memo = new Map();
      this._memo.set(root, memo);
    }
    let m = memo.get(element);
    if (m === undefined) {
      m = this.evaluator.matches(root, element);
      memo.set(element, m);
    }
    return m;
  }
  reset() {
    this._memo.clear();
    super.reset();
  }
}

class RootEval extends Evaluator {
  matches(root, element) {
    return root === element;
  }
  cost() {
    return 1;
  }
  toString() {
    return '';
  }
}

class HasEval extends StructuralEvaluator {
  matches(root, element) {
    for (const node of getChildren(element)) {
      if (!isTag(node)) continue;
      const match = findFirst(this.evaluator, element, node);
      if (match !== null) return true;
    }
    return false;
  }
  cost() {
    return 10 * this.evaluator.cost();
  }
  toString() {
    return ':has(' + this.evaluator + ')';
  }
}

class NotEval extends StructuralEvaluator {
  matches(root, element) {
    return !this.memoMatches(root, element);
  }
  cost() {
    return 2 + this.evaluator.cost();
  }
  toString() {
    return ':not(' + this.evaluator + ')';
  }
}

class ParentEval extends StructuralEvaluator {
  matches(root, element) {
    if (root === element) return false;
    let parent = parentEl(element);
    while (parent != null) {
      if (this.memoMatches(root, parent)) return true;
      if (parent === root) break;
      parent = parentEl(parent);
    }
    return false;
  }
  cost() {
    return 2 * this.evaluator.cost();
  }
  toString() {
    return this.evaluator + ' ';
  }
}

class ImmediateParentRunEval extends Evaluator {
  constructor(evaluator) {
    super();
    this.evaluators = [evaluator];
    this.costValue = 2 + evaluator.cost();
  }
  add(evaluator) {
    this.evaluators.push(evaluator);
    this.costValue += evaluator.cost();
  }
  matches(root, element) {
    let el = element;
    for (let i = this.evaluators.length - 1; i >= 0; --i) {
      if (el == null) return false;
      if (!this.evaluators[i].matches(root, el)) return false;
      el = parentEl(el);
    }
    return true;
  }
  cost() {
    return this.costValue;
  }
  toString() {
    return this.evaluators.map(String).join(' > ');
  }
}

class PreviousSiblingEval extends StructuralEvaluator {
  matches(root, element) {
    if (root === element) return false;
    let sibling = firstElementSibling(element);
    while (sibling != null) {
      if (sibling === element) break;
      if (this.memoMatches(root, sibling)) return true;
      sibling = nextElementSibling(sibling);
    }
    return false;
  }
  cost() {
    return 3 * this.evaluator.cost();
  }
}

class ImmediatePreviousSiblingEval extends StructuralEvaluator {
  matches(root, element) {
    if (root === element) return false;
    const prev = prevElementSibling(element);
    return prev != null && this.memoMatches(root, prev);
  }
  cost() {
    return 2 + this.evaluator.cost();
  }
}

// :matchText —— 把文本节点包成 PseudoTextElement（jsoup PseudoTextElement 语义）
const PSEUDO_TEXT_TAG = '__pseudotext';
class MatchTextEval extends Evaluator {
  matches(root, element) {
    if (isTag(element) && normalName(element) === PSEUDO_TEXT_TAG) return true;
    for (const child of getChildren(element).slice()) {
      if (!isText(child) && !isCDATA(child)) continue;
      const pseudo = new Element(PSEUDO_TEXT_TAG, {}, [], 'tag');
      pseudo.parent = element;
      const idx = element.children.indexOf(child);
      child.parent = pseudo;
      pseudo.children = [child];
      if (idx >= 0) element.children.splice(idx, 1, pseudo);
    }
    return false;
  }
  cost() {
    return -1;
  }
  toString() {
    return ':matchText';
  }
}

// ---------- QueryParser（org.jsoup.select.QueryParser） ----------

const COMBINATORS = [',', '>', '+', '~', ' '];
const ATTRIBUTE_EVALS = ['=', '!=', '^=', '$=', '*=', '~='];
const NTH_AB = /^(([+-])?(\d+)?)n(\s*([+-])?\s*\d+)?$/i;
const NTH_B = /^([+-])?(\d+)$/;

class QueryParser {
  constructor(query) {
    if (!query) validateFail('query must not be empty');
    const q = String(query).trim();
    this.query = q;
    this.tq = new TokenQueue(q);
    this.evals = [];
  }
  static parse(query) {
    const p = new QueryParser(query);
    return p.parse();
  }
  parse() {
    const tq = this.tq;
    tq.consumeWhitespace();
    if (tq.matchesAnyChar(...COMBINATORS)) {
      this.evals.push(new RootEval());
      this.combinator(tq.consume());
    } else {
      this.evals.push(this.consumeEvaluator());
    }
    while (!tq.isEmpty()) {
      const seenWhite = tq.consumeWhitespace();
      if (tq.matchesAnyChar(...COMBINATORS)) {
        this.combinator(tq.consume());
      } else if (seenWhite) {
        this.combinator(' ');
      } else {
        this.evals.push(this.consumeEvaluator());
      }
    }
    if (this.evals.length === 1) return this.evals[0];
    return new AndEval(this.evals);
  }
  combinator(combinator) {
    const tq = this.tq;
    tq.consumeWhitespace();
    const subQuery = this.consumeSubQuery();
    let rootEval;
    let currentEval;
    const newEval = QueryParser.parse(subQuery);
    let replaceRightMost = false;
    if (this.evals.length === 1) {
      rootEval = currentEval = this.evals[0];
      if (rootEval instanceof OrEval && combinator !== ',') {
        currentEval = rootEval.rightMostEvaluator();
        replaceRightMost = true;
      }
    } else {
      rootEval = currentEval = new AndEval(this.evals);
    }
    this.evals.length = 0;
    switch (combinator) {
      case '>': {
        const run = currentEval instanceof ImmediateParentRunEval ? currentEval : new ImmediateParentRunEval(currentEval);
        run.add(newEval);
        currentEval = run;
        break;
      }
      case ' ':
        currentEval = new AndEval([new ParentEval(currentEval), newEval]);
        break;
      case '+':
        currentEval = new AndEval([new ImmediatePreviousSiblingEval(currentEval), newEval]);
        break;
      case '~':
        currentEval = new AndEval([new PreviousSiblingEval(currentEval), newEval]);
        break;
      case ',': {
        let or;
        if (currentEval instanceof OrEval) or = currentEval;
        else {
          or = new OrEval();
          or.add(currentEval);
        }
        or.add(newEval);
        currentEval = or;
        break;
      }
      default:
        throw new SelectorParseException("Unknown combinator '" + combinator + "'");
    }
    if (replaceRightMost) rootEval.replaceRightMostEvaluator(currentEval);
    else rootEval = currentEval;
    this.evals.push(rootEval);
  }
  consumeSubQuery() {
    const tq = this.tq;
    let sq = '';
    while (!tq.isEmpty()) {
      if (tq.matches('(')) sq += '(' + tq.chompBalanced('(', ')') + ')';
      else if (tq.matches('[')) sq += '[' + tq.chompBalanced('[', ']') + ']';
      else if (tq.matchesAnyChar(...COMBINATORS)) {
        if (sq.length > 0) break;
        tq.consume();
      } else sq += tq.consume();
    }
    return sq;
  }
  consumeEvaluator() {
    const tq = this.tq;
    if (tq.matchChomp('#')) return this.byId();
    if (tq.matchChomp('.')) return this.byClass();
    if (tq.matchesWord() || tq.matches('*|')) return this.byTag();
    if (tq.matches('[')) return this.byAttribute();
    if (tq.matchChomp('*')) return new AllElementsEval();
    if (tq.matchChomp(':')) return this.parsePseudoSelector();
    throw new SelectorParseException("Could not parse query '" + this.query + "': unexpected token at '" + tq.toString() + "'");
  }
  parsePseudoSelector() {
    const pseudo = this.tq.consumeCssIdentifier();
    switch (pseudo) {
      case 'lt':
        return new IndexLessThanEval(this.consumeIndex());
      case 'gt':
        return new IndexGreaterThanEval(this.consumeIndex());
      case 'eq':
        return new IndexEqualsEval(this.consumeIndex());
      case 'has':
        return this.has();
      case 'contains':
        return this.contains(false);
      case 'containsOwn':
        return this.contains(true);
      case 'containsWholeText':
        return this.containsWholeText(false);
      case 'containsWholeOwnText':
        return this.containsWholeText(true);
      case 'containsData':
        return this.containsData();
      case 'matches':
        return this.matches(false);
      case 'matchesOwn':
        return this.matches(true);
      case 'matchesWholeText':
        return this.matchesWholeText(false);
      case 'matchesWholeOwnText':
        return this.matchesWholeText(true);
      case 'not':
        return this.not();
      case 'nth-child':
        return this.cssNthChild(false, false);
      case 'nth-last-child':
        return this.cssNthChild(true, false);
      case 'nth-of-type':
        return this.cssNthChild(false, true);
      case 'nth-last-of-type':
        return this.cssNthChild(true, true);
      case 'first-child':
        return new IsFirstChildEval();
      case 'last-child':
        return new IsLastChildEval();
      case 'first-of-type':
        return new IsFirstOfTypeEval();
      case 'last-of-type':
        return new IsLastOfTypeEval();
      case 'only-child':
        return new IsOnlyChildEval();
      case 'only-of-type':
        return new IsOnlyOfTypeEval();
      case 'empty':
        return new IsEmptyEval();
      case 'root':
        return new IsRootEval();
      case 'matchText':
        return new MatchTextEval();
      default:
        throw new SelectorParseException("Could not parse query '" + this.query + "': unexpected token at '" + this.tq.toString() + "'");
    }
  }
  byId() {
    const id = this.tq.consumeCssIdentifier();
    if (!id) validateFail('id must not be empty');
    return new IdEval(id);
  }
  byClass() {
    const className = this.tq.consumeCssIdentifier();
    if (!className) validateFail('class must not be empty');
    return new ClassEval(className.trim());
  }
  byTag() {
    let tagName = normalize(this.tq.consumeElementSelector());
    if (!tagName) validateFail('tag must not be empty');
    if (tagName.startsWith('*|')) {
      const plainTag = tagName.substring(2);
      return new OrEval([new TagEval(plainTag), new TagEndsWithEval(tagName.split('*|').join(':'))]);
    }
    if (tagName.indexOf('|') >= 0) tagName = tagName.split('|').join(':');
    return new TagEval(tagName);
  }
  byAttribute() {
    const cq = new TokenQueue(this.tq.chompBalanced('[', ']'));
    const key = cq.consumeToAny(...ATTRIBUTE_EVALS);
    if (!key) validateFail('attribute key must not be empty');
    cq.consumeWhitespace();
    if (cq.isEmpty()) {
      if (key.startsWith('^')) return new AttributeStartingEval(key.substring(1));
      return new AttributeEval(key);
    }
    if (cq.matchChomp('=')) return new AttributeWithValueEval(key, cq.remainder());
    if (cq.matchChomp('!=')) return new AttributeWithValueNotEval(key, cq.remainder());
    if (cq.matchChomp('^=')) return new AttributeWithValueStartingEval(key, cq.remainder());
    if (cq.matchChomp('$=')) return new AttributeWithValueEndingEval(key, cq.remainder());
    if (cq.matchChomp('*=')) return new AttributeWithValueContainingEval(key, cq.remainder());
    if (cq.matchChomp('~=')) return new AttributeWithValueMatchingEval(key, javaPatternToJs(cq.remainder()));
    throw new SelectorParseException("Could not parse attribute query '" + this.query + "': unexpected token at '" + cq.remainder() + "'");
  }
  cssNthChild(backwards, ofType) {
    const arg = normalize(this.consumeParens());
    let a;
    let b;
    const mAB = NTH_AB.exec(arg);
    const mB = NTH_B.exec(arg);
    if (arg === 'odd') {
      a = 2;
      b = 1;
    } else if (arg === 'even') {
      a = 2;
      b = 0;
    } else if (mAB) {
      a = mAB[3] != null ? javaParseInt(mAB[1].replace(/^\+/, '')) : 1;
      b = mAB[4] != null ? javaParseInt(mAB[4].replace(/^\+/, '')) : 0;
    } else if (mB) {
      a = 0;
      b = javaParseInt(mB[0].replace(/^\+/, ''));
    } else {
      throw new SelectorParseException("Could not parse nth-index '" + arg + "': unexpected format");
    }
    if (ofType) return backwards ? new IsNthLastOfTypeEval(a, b) : new IsNthOfTypeEval(a, b);
    return backwards ? new IsNthLastChildEval(a, b) : new IsNthChildEval(a, b);
  }
  consumeParens() {
    return this.tq.chompBalanced('(', ')');
  }
  consumeIndex() {
    const index = this.consumeParens().trim();
    if (!isNumericStr(index)) validateFail('Index must be numeric');
    return javaParseInt(index);
  }
  has() {
    const subQuery = this.consumeParens();
    if (!subQuery) validateFail(':has(selector) sub-select must not be empty');
    return new HasEval(QueryParser.parse(subQuery));
  }
  contains(own) {
    const query = own ? ':containsOwn' : ':contains';
    const searchText = TokenQueue.unescape(this.consumeParens());
    if (!searchText) validateFail(query + '(text) query must not be empty');
    return own ? new ContainsOwnTextEval(searchText) : new ContainsTextEval(searchText);
  }
  containsWholeText(own) {
    const query = own ? ':containsWholeOwnText' : ':containsWholeText';
    const searchText = TokenQueue.unescape(this.consumeParens());
    if (!searchText) validateFail(query + '(text) query must not be empty');
    return own ? new ContainsWholeOwnTextEval(searchText) : new ContainsWholeTextEval(searchText);
  }
  containsData() {
    const searchText = TokenQueue.unescape(this.consumeParens());
    if (!searchText) validateFail(':containsData(text) query must not be empty');
    return new ContainsDataEval(searchText);
  }
  matches(own) {
    const query = own ? ':matchesOwn' : ':matches';
    const regex = this.consumeParens();
    if (!regex) validateFail(query + '(regex) query must not be empty');
    return own ? new MatchesOwnEval(javaPatternToJs(regex)) : new MatchesEval(javaPatternToJs(regex));
  }
  matchesWholeText(own) {
    const query = own ? ':matchesWholeOwnText' : ':matchesWholeText';
    const regex = this.consumeParens();
    if (!regex) validateFail(query + '(regex) query must not be empty');
    return own ? new MatchesWholeOwnTextEval(javaPatternToJs(regex)) : new MatchesWholeTextEval(javaPatternToJs(regex));
  }
  not() {
    const subQuery = this.consumeParens();
    if (!subQuery) validateFail(':not(selector) subselect must not be empty');
    return new NotEval(QueryParser.parse(subQuery));
  }
}

// ---------- Collector / Selector ----------

export function findFirst(evalr, root, start) {
  let found = null;
  const walk = (node) => {
    if (found !== null) return;
    if (isTag(node) && evalr.matches(root, node)) {
      found = node;
      return;
    }
    for (const c of getChildren(node)) {
      if (found !== null) return;
      walk(c);
    }
  };
  walk(start);
  return found;
}

export function collect(evalr, root) {
  evalr.reset();
  const elements = [];
  const walk = (node) => {
    if (isTag(node) && evalr.matches(root, node)) elements.push(node);
    for (const c of getChildren(node)) walk(c);
  };
  walk(root);
  return elements;
}

/** jsoup Selector.select(query, root) —— 含 root 自身 */
export function selectJsoup(root, query) {
  if (root == null || !query) return [];
  const evaluator = QueryParser.parse(String(query));
  return collect(evaluator, root);
}

export function selectFirstJsoup(root, query) {
  if (root == null || !query) return null;
  const evaluator = QueryParser.parse(String(query));
  evaluator.reset();
  return findFirst(evaluator, root, root);
}
