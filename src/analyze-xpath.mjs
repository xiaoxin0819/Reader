// AnalyzeByXPath —— 移植自 legado io.legado.app.model.analyzeRule.AnalyzeByXPath
// JXDocument -> xpath 包 + domhandler 适配层
import xpathPkg from 'xpath';
import { parseDocument } from 'htmlparser2';
import { isTag, isText, isComment, isDocument, isCDATA } from 'domhandler';
import { getChildren } from 'domutils';
import { elementText } from './analyze-jsoup.mjs';
import { RuleAnalyzer } from './rule-analyzer.mjs';

const NODE_TYPES = { ELEMENT: 1, ATTRIBUTE: 2, TEXT: 3, CDATA: 4, PROCESSING: 7, COMMENT: 8, DOCUMENT: 9 };

// domhandler 节点 -> xpath 包可识别的 DOM 外观（带缓存，parent 链指向包装节点）
const cache = new WeakMap();

function wrap(raw, parentWrapper) {
  if (!raw) return null;
  let w = cache.get(raw);
  if (w && !w.parentNode) {
    // 保持首个父引用（文档树唯一）
  } else if (w) {
    return w;
  }
  const isDocNode = isDocument(raw);
  const name = isDocNode ? '#document' : isText(raw) || isCDATA(raw) ? '#text' : raw.name || '#node';

  w = {
    __raw: raw,
    nodeType: isDocNode ? NODE_TYPES.DOCUMENT : isText(raw) || isCDATA(raw) ? NODE_TYPES.TEXT : isComment(raw) ? NODE_TYPES.COMMENT : NODE_TYPES.ELEMENT,
    nodeName: name,
    localName: isDocNode || isText(raw) || isCDATA(raw) ? null : name,
    prefix: null,
    namespaceURI: null,
    tagName: isDocNode ? null : name,
    nodeValue: isText(raw) || isCDATA(raw) ? raw.data : isComment(raw) ? raw.data : null,
    data: isText(raw) || isCDATA(raw) ? raw.data : null,
    parentNode: parentWrapper || null,
    childNodes: [],
    attributes: [],
    firstChild: null,
    lastChild: null,
    previousSibling: null,
    nextSibling: null,
    documentElement: null,
    ownerDocument: null,
  };
  cache.set(raw, w);
  return w;
}

function buildChildren(w) {
  const raw = w.__raw;
  const kids = getChildren(raw);
  let prev = null;
  w.childNodes = [];
  for (const k of kids) {
    const kw = wrap(k, w);
    if (kw.__built) {
      // 已构建过（自身上下文），仍要链接
    }
    w.childNodes.push(kw);
    kw.parentNode = w;
    kw.previousSibling = prev;
    kw.nextSibling = null;
    if (prev) prev.nextSibling = kw;
    prev = kw;
  }
  w.firstChild = w.childNodes[0] || null;
  w.lastChild = w.childNodes[w.childNodes.length - 1] || null;
  w.__built = true;
  return w;
}

function ensureBuilt(w) {
  if (w && !w.__built) buildChildren(w);
  return w;
}

function toAttrs(w) {
  const raw = w.__raw;
  if (!isTag(raw)) {
    const empty = [];
    empty.item = () => null;
    empty.getNamedItem = () => null;
    return empty;
  }
  if (w.__attrsBuilt) return w.__attrs;
  const attrs = [];
  for (const [k, v] of Object.entries(raw.attribs || {})) {
    attrs.push({
      nodeType: NODE_TYPES.ATTRIBUTE,
      nodeName: k,
      localName: k,
      name: k,
      prefix: null,
      namespaceURI: null,
      nodeValue: v,
      value: v,
      specified: true,
      ownerElement: w,
      childNodes: [],
      parentNode: null,
      ownerDocument: w.ownerDocument,
      firstChild: null,
    });
  }
  // xpath 包按 NamedNodeMap 使用：attributes.item(k)
  const map = attrs.slice();
  map.item = (i) => map[i] || null;
  map.getNamedItem = (n) => map.find((a) => a.name === n) || null;
  map.length = attrs.length;
  w.attributes = map;
  w.__attrsBuilt = true;
  return map;
}

// 懒加载属性/子节点：xpath 包会直接读 childNodes/attributes
function makeLazy(w) {
  if (!w) return w;
  Object.defineProperty(w, 'childNodes', {
    configurable: true,
    get() {
      if (!w.__childrenReady) {
        const raw = w.__raw;
        const kids = getChildren(raw);
        let prev = null;
        const arr = [];
        for (const k of kids) {
          const kw = makeLazy(wrap(k, w));
          arr.push(kw);
          kw.parentNode = w;
          kw.previousSibling = prev;
          if (prev) prev.nextSibling = kw;
          prev = kw;
        }
        w.__arr = arr;
        w.__firstChild = arr[0] || null;
        w.__lastChild = arr[arr.length - 1] || null;
        w.__childrenReady = true;
      }
      return w.__arr;
    },
    set(v) {
      w.__arr = v;
      w.__childrenReady = true;
    },
  });
  Object.defineProperty(w, 'attributes', {
    configurable: true,
    get() {
      return toAttrs(w);
    },
    set(v) {
      w.__attrs = v;
      w.__attrsBuilt = true;
    },
  });
  Object.defineProperty(w, 'firstChild', {
    configurable: true,
    get() {
      return this.childNodes[0] || null;
    },
  });
  Object.defineProperty(w, 'lastChild', {
    configurable: true,
    get() {
      const c = this.childNodes;
      return c[c.length - 1] || null;
    },
  });
  Object.defineProperty(w, 'ownerDocument', {
    configurable: true,
    get() {
      let cur = w;
      while (cur.parentNode) cur = cur.parentNode;
      return cur;
    },
  });
  return w;
}

function wrapTree(raw) {
  const rootW = makeLazy(wrap(raw, null));
  // 文档节点需要 documentElement
  if (rootW.nodeType === NODE_TYPES.DOCUMENT) {
    Object.defineProperty(rootW, 'documentElement', {
      configurable: true,
      get() {
        const kids = this.childNodes;
        for (const k of kids) if (k.nodeType === NODE_TYPES.ELEMENT) return k;
        return null;
      },
    });
  }
  return rootW;
}

function parseDoc(doc) {
  if (doc && typeof doc === 'object' && doc.__raw) return doc.__raw;
  if (doc && typeof doc === 'object' && (isDocument(doc) || isTag(doc) || doc.type)) return doc;
  let html = String(doc == null ? '' : doc);
  if (html.endsWith('</td>')) html = `<tr>${html}</tr>`;
  if (html.endsWith('</tr>') || html.endsWith('</tbody>')) html = `<table>${html}</table>`;
  if (/^\s*<\?xml/i.test(html)) return parseDocument(html, { xmlMode: true, decodeEntities: true });
  return parseDocument(html, { decodeEntities: true });
}

function asString(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  const raw = node.__raw;
  if (raw) {
    if (isText(raw) || isCDATA(raw)) return raw.data || '';
    if (isTag(raw)) return elementText(raw);
    if (isComment(raw)) return raw.data || '';
    return '';
  }
  if (typeof node.nodeValue === 'string') return node.nodeValue;
  return String(node);
}

export class AnalyzeByXPath {
  constructor(doc) {
    const raw = parseDoc(doc);
    this.node = wrapTree(raw);
  }

  _rootFor() {
    return this.node;
  }

  _getResult(xPath) {
    try {
      const r = xpathPkg.select(xPath, this._rootFor());
      if (r == null) return null;
      if (Array.isArray(r)) return r;
      // 标量（string/number/boolean）
      return [r];
    } catch (e) {
      return null;
    }
  }

  getElements(xPath) {
    if (!xPath) return null;
    const jxNodes = [];
    const ruleAnalyzes = new RuleAnalyzer(xPath);
    const rules = ruleAnalyzes.splitRule('&&', '||', '%%');
    if (rules.length === 1) return this._getResult(rules[0]);
    const results = [];
    for (const rl of rules) {
      const temp = this.getElements(rl);
      if (temp && temp.length) {
        results.push(temp);
        if (ruleAnalyzes.elementsType === '||') break;
      }
    }
    if (results.length) {
      if (ruleAnalyzes.elementsType === '%%') {
        for (let i = 0; i < results[0].length; i++) {
          for (const temp of results) if (i < temp.length) jxNodes.push(temp[i]);
        }
      } else {
        for (const temp of results) jxNodes.push(...temp);
      }
    }
    return jxNodes;
  }

  getStringList(xPath) {
    const result = [];
    const ruleAnalyzes = new RuleAnalyzer(xPath);
    const rules = ruleAnalyzes.splitRule('&&', '||', '%%');
    if (rules.length === 1) {
      const r = this._getResult(xPath);
      if (r) for (const n of r) result.push(asString(n));
      return result;
    }
    const results = [];
    for (const rl of rules) {
      const temp = this.getStringList(rl);
      if (temp.length) {
        results.push(temp);
        if (ruleAnalyzes.elementsType === '||') break;
      }
    }
    if (results.length) {
      if (ruleAnalyzes.elementsType === '%%') {
        for (let i = 0; i < results[0].length; i++) {
          for (const temp of results) if (i < temp.length) result.push(temp[i]);
        }
      } else {
        for (const temp of results) result.push(...temp);
      }
    }
    return result;
  }

  getString(rule) {
    const ruleAnalyzes = new RuleAnalyzer(rule);
    const rules = ruleAnalyzes.splitRule('&&', '||');
    if (rules.length === 1) {
      const r = this._getResult(rule);
      if (!r) return null;
      return r.map(asString).join('\n');
    }
    const textList = [];
    for (const rl of rules) {
      const temp = this.getString(rl);
      if (temp) {
        textList.push(temp);
        if (ruleAnalyzes.elementsType === '||') break;
      }
    }
    return textList.join('\n');
  }
}