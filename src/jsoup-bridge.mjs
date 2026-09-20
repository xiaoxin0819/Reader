// jsoup-bridge.mjs —— 给书源 JS 用的 org.jsoup 兼容层
// 底层复用 analyze-jsoup.mjs 的 jsoup 语义实现（elementText / outerHtml / elementSelect ...）
import { isTag, isText, isCDATA, isComment, isDocument, isDirective } from 'domhandler';
import { getChildren } from 'domutils';
import {
  elementText, elementOwnText, elementTextNodes, outerHtml, elementSelect,
  parseDoc, getElementsByClass, getElementsByTag, getElementsById,
  getElementsContainingOwnText, elementData,
} from './analyze-jsoup.mjs';

function attrOf(el, name) {
  if (!isTag(el) || !el.attribs) return '';
  const v = el.attribs[String(name).toLowerCase()];
  return v === undefined || v === null ? '' : String(v);
}

/** jsoup Element 包装 */
export class JsoupElement {
  constructor(node) {
    Object.defineProperty(this, '_n', { value: node, enumerable: false });
  }
  _nodes() { return [this._n]; }

  text() { return elementText(this._n); }
  ownText() { return elementOwnText(this._n); }
  data() { return elementData(this._n); }
  html() { return getChildren(this._n).map((c) => outerHtml(c)).join(''); }
  outerHtml() { return outerHtml(this._n); }
  toString() { return this.outerHtml(); }

  tagName() { return isTag(this._n) ? (this._n.name || '') : (this._n.name || ''); }
  nodeName() { return this.tagName(); }
  normalName() { return this.tagName().toLowerCase(); }

  attr(name) { return attrOf(this._n, name); }
  hasAttr(name) {
    if (!isTag(this._n) || !this._n.attribs) return false;
    return Object.prototype.hasOwnProperty.call(this._n.attribs, String(name).toLowerCase());
  }
  id() { return attrOf(this._n, 'id'); }
  className() { return attrOf(this._n, 'class'); }
  hasClass(cls) {
    return String(attrOf(this._n, 'class')).toLowerCase().split(/\s+/).includes(String(cls).toLowerCase());
  }
  val() { return attrOf(this._n, 'value'); }
  absUrl(name) { return attrOf(this._n, name); }

  select(css) { return new JsoupElements(elementSelect(this._n, css)); }
  size() { return 1; }
  get() { return this; }
  first() { return this; }
  last() { return this; }
  isEmpty() { return false; }

  textNodes() { return new JsoupNodes(elementTextNodes(this._n)); }
  children() {
    if (!isDocument(this._n) && !isDirective(this._n) && !isTag(this._n)) return new JsoupElements([]);
    return new JsoupElements(getChildren(this._n).filter(isTag));
  }
  child(i) {
    const k = this.children();
    return i >= 0 && i < k.length ? k.get(i) : null;
  }
  parent() { return this._n.parent && isTag(this._n.parent) ? new JsoupElement(this._n.parent) : null; }
  nextElementSibling() { return siblingOf(this._n, 1); }
  previousElementSibling() { return siblingOf(this._n, -1); }
  siblingElements() {
    const p = this._n.parent;
    if (!p) return new JsoupElements([]);
    return new JsoupElements(getChildren(p).filter((c) => isTag(c) && c !== this._n));
  }
  getElementsByTag(t) { return new JsoupElements(getElementsByTag(this._n, t)); }
  getElementsByClass(c) { return new JsoupElements(getElementsByClass(this._n, c)); }
  getElementById(id) {
    const r = getElementsById(this._n, id);
    return r.length ? new JsoupElement(r[0]) : null;
  }
  getAllElements() { return this.select('*'); }

  [Symbol.iterator]() { return this._nodes()[Symbol.iterator](); }
}

function siblingOf(node, dir) {
  const p = node.parent;
  if (!p) return null;
  const sibs = getChildren(p).filter(isTag);
  const i = sibs.indexOf(node);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < sibs.length ? new JsoupElement(sibs[j]) : null;
}

/** jsoup Elements 包装：数字索引可枚举（支持 for..in），方法不可枚举 */
export class JsoupElements {
  constructor(nodes = []) {
    const arr = nodes.map((n) => (n instanceof JsoupElement ? n : new JsoupElement(n)));
    Object.defineProperty(this, '_a', { value: arr, enumerable: false });
    for (let i = 0; i < arr.length; i++) {
      Object.defineProperty(this, i, { value: arr[i], enumerable: true, configurable: true });
    }
    Object.defineProperty(this, 'length', { value: arr.length, enumerable: false });
  }
  size() { return this._a.length; }
  get(i) { return i >= 0 && i < this._a.length ? this._a[i] : null; }
  first() { return this._a.length ? this._a[0] : null; }
  last() { return this._a.length ? this._a[this._a.length - 1] : null; }
  isEmpty() { return this._a.length === 0; }
  toArray() { return this._a.slice(); }
  eq(i) { const e = this.get(i); return e ? new JsoupElements([e]) : new JsoupElements([]); }
  eachText() { return this._a.map((e) => e.text()); }
  eachAttr(name) { return this._a.map((e) => e.attr(name)); }
  text() { return this._a.map((e) => e.text()).join(' '); }
  ownText() { return this._a.map((e) => e.ownText()).join(' '); }
  html() { return this._a.map((e) => e.html()).join(''); }
  outerHtml() { return this._a.map((e) => e.outerHtml()).join(''); }
  toString() { return this.outerHtml(); }
  attr(name) { return this._a.length ? this._a[0].attr(name) : ''; }
  hasAttr(name) { return this._a.length ? this._a[0].hasAttr(name) : false; }
  val() { return this._a.length ? this._a[0].val() : ''; }
  hasClass(c) { return this._a.some((e) => e.hasClass(c)); }
  select(css) {
    const out = [];
    for (const e of this._a) for (const n of elementSelect(e._n, css)) out.push(n);
    return new JsoupElements([...new Set(out)]);
  }
  filter(fn) { return new JsoupElements(this._a.filter((e, i) => fn(e, i)).map((e) => e._n)); }
  map(fn) { return this._a.map((e, i) => fn(e, i)); }
  forEach(fn, thisArg) { this._a.forEach((e, i) => fn.call(thisArg, e, i)); }
  add(e) { return new JsoupElements([...this._a, e].map((x) => x._n)); }
  remove() { return this; }
  [Symbol.iterator]() { return this._a[Symbol.iterator](); }
}

/** jsoup List<Node> 包装（textNodes()） */
export class JsoupNodes {
  constructor(nodes = []) {
    Object.defineProperty(this, '_a', { value: nodes, enumerable: false });
    for (let i = 0; i < nodes.length; i++) {
      Object.defineProperty(this, i, { value: new JsoupNode(nodes[i]), enumerable: true });
    }
    Object.defineProperty(this, 'length', { value: nodes.length, enumerable: false });
  }
  size() { return this._a.length; }
  get(i) { return this[i]; }
  first() { return this._a.length ? this[0] : null; }
  [Symbol.iterator]() { return Array.from({ length: this._a.length }, (_, i) => this[i])[Symbol.iterator](); }
}

export class JsoupNode {
  constructor(node) {
    Object.defineProperty(this, '_n', { value: node, enumerable: false });
  }
  text() {
    const n = this._n;
    if (isText(n) || isCDATA(n) || isComment(n)) return n.data || '';
    if (isTag(n) || isDocument(n)) return elementText(n);
    return '';
  }
  outerHtml() { return outerHtml(this._n); }
  toString() { return this.outerHtml(); }
  nodeName() { return this._n.name || ''; }
  attr(name) { return attrOf(this._n, name); }
}

export function wrapElement(node) { return node == null ? null : new JsoupElement(node); }
export function wrapElements(nodes) { return new JsoupElements(nodes || []); }

/** jsoup Jsoup.parse(html) / parseBodyFragment / clean */
export function jsoupParse(html) {
  return new JsoupElement(parseDoc(html == null ? '' : String(html)));
}

export const Jsoup = {
  parse: jsoupParse,
  parseBodyFragment: jsoupParse,
  connect: () => { throw new Error('Jsoup.connect 桌面端不支持，请用 java.ajax'); },
};

export const orgJsoup = {
  jsoup: {
    Jsoup,
    parse: jsoupParse,
    nodes: {
      Document: JsoupElement,
      Element: JsoupElement,
      Elements: JsoupElements,
      Node: JsoupNode,
    },
    select: { Evaluator: class {} },
    helper: { DataUtil: class {} },
  },
};