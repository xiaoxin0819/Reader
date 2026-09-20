// AnalyzeByJSoup —— 移植自 legado io.legado.app.model.analyzeRule.AnalyzeByJSoup
// jsoup -> htmlparser2 + domutils + jsoup-selector（jsoup 原生选择器引擎移植）
import { parseDocument } from 'htmlparser2';
import { selectJsoup } from './jsoup-selector.mjs';
export { selectJsoup };
import render from 'dom-serializer';
import { isTag, isText, isCDATA, isComment, isDocument, isDirective } from 'domhandler';
import { getChildren, findAll, getElementsByTagName } from 'domutils';
import { RuleAnalyzer } from './rule-analyzer.mjs';

// ---------- jsoup 语义辅助 ----------

// jsoup: Element#text() / ownText() 使用的块级标签集合
const BLOCK_TAGS = new Set([
  'html','head','body','frameset','script','noscript','style','meta','link','title','frame',
  'noframes','section','nav','aside','hgroup','header','footer','p','h1','h2','h3','h4','h5','h6',
  'ul','ol','pre','div','blockquote','hr','address','figure','figcaption','form','fieldset','ins',
  'del','s','dl','dt','dd','li','table','caption','thead','tfoot','tbody','colgroup','col','tr',
  'th','td','video','audio','canvas','details','menu','plaintext','template','article','main',
  'svg','math','center'
]);
const PRESERVE_WS = new Set(['pre', 'plaintext', 'title', 'textarea']);

function isActuallyWhitespace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === '\u00a0';
}
function isInvisibleChar(c) {
  const n = c.codePointAt(0);
  return n === 0x200b || (n >= 0x200c && n <= 0x200f) || n === 0xfeff || n === 0x2060;
}

// jsoup: StringUtil.appendNormalisedWhitespace
function appendNormalisedWhitespace(acc, str, isBlank) {
  let last = acc.length - 1;
  for (let offset = 0; offset < str.length; offset++) {
    const c = str[offset];
    if (isActuallyWhitespace(c)) {
      if ((offset === 0 && isBlank) || (offset > 0 && isActuallyWhitespace(str[offset - 1]))) continue;
      if (last >= 0 && isActuallyWhitespace(acc[last])) continue;
      acc.push(' ');
      last++;
    } else if (!isInvisibleChar(c)) {
      acc.push(c);
      last++;
    }
  }
}

function isPreserveWhitespace(node) {
  const p = node.parent;
  return !!(p && isTag(p) && PRESERVE_WS.has((p.name || '').toLowerCase()));
}

// jsoup: Element#text()
export function elementText(el) {
  const acc = [];
  const walk = (node) => {
    const kids = getChildren(node);
    for (const child of kids) {
      if (isText(child) || isCDATA(child)) {
        if (isPreserveWhitespace(child)) acc.push(child.data);
        else appendNormalisedWhitespace(acc, child.data, /^\s*$/.test(child.data));
      } else if (isTag(child)) {
        const name = (child.name || '').toLowerCase();
        if (acc.length > 0 && (BLOCK_TAGS.has(name) || name === 'br') && !isActuallyWhitespace(acc[acc.length - 1])) {
          acc.push(' ');
        }
        walk(child);
        if (acc.length > 0 && BLOCK_TAGS.has(name) && !isActuallyWhitespace(acc[acc.length - 1])) {
          acc.push(' ');
        }
      }
    }
  };
  walk(el);
  while (acc.length && isActuallyWhitespace(acc[acc.length - 1])) acc.pop();
  let s = acc.join('');
  return s.trim();
}

function appendWhitespaceIfBr(el, acc) {
  if ((el.name || '').toLowerCase() === 'br' && acc.length > 0 && !isActuallyWhitespace(acc[acc.length - 1])) {
    acc.push(' ');
  }
}

// jsoup: Element#ownText()
export function elementOwnText(el) {
  const acc = [];
  for (const child of getChildren(el)) {
    if (isText(child) || isCDATA(child)) {
      if (isPreserveWhitespace(child)) acc.push(child.data);
      else appendNormalisedWhitespace(acc, child.data, /^\s*$/.test(child.data));
    } else if (isTag(child)) {
      appendWhitespaceIfBr(child, acc);
    }
  }
  return acc.join('').trim();
}

// jsoup: Element#textNodes()
export function elementTextNodes(el) {
  return getChildren(el).filter((c) => isText(c) || isCDATA(c));
}

// jsoup: Element#data()
export function elementData(el) {
  let s = '';
  for (const c of getChildren(el)) {
    if (isComment(c)) s += c.data || '';
    else if (isCDATA(c)) s += c.data || '';
    else if (isText(c) && c.parent && isTag(c.parent) && /^(script|style)$/i.test(c.parent.name || '')) s += c.data || '';
  }
  return s;
}

// jsoup: Elements#outerHtml()
export function outerHtml(nodes) {
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  return arr.map((n) => render(n, { decodeEntities: false, encodeEntities: 'utf8' })).join('');
}

// jsoup: Node#attr / Element#attr —— 属性名不区分大小写（htmlparser2 已小写化）
function attrOf(el, name) {
  if (!isTag(el) || !el.attribs) return '';
  const v = el.attribs[String(name).toLowerCase()];
  return v === undefined || v === null ? '' : v;
}

// jsoup: Element#select（含自身）
export function elementSelect(root, selector) {
  if (root == null || !selector) return [];
  // jsoup Element#select(cssQuery)：以本元素（含自身）为根，使用 jsoup 完整选择器语法。
  // 语法错误按 legado 行为向上抛（不再静默吞掉，避免书源规则失败却毫无线索）。
  return selectJsoup(root, selector);
}

// jsoup: Element#getElementsByClass —— 按空白分词，要求所有类名都出现，大小写不敏感，含自身
export function getElementsByClass(root, classNames) {
  const wanted = String(classNames).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = isTag(root) ? [root, ...findAll(() => true, [root], true)] : findAll(() => true, getChildren(root), true);
  const out = [];
  for (const el of all) {
    if (!isTag(el)) continue;
    const cls = (el.attribs && el.attribs['class']) || '';
    if (!cls) continue;
    const words = cls.toLowerCase().split(/\s+/).filter(Boolean);
    if (wanted.every((w) => words.includes(w))) out.push(el);
  }
  return out;
}

export function getElementsByTag(root, tagName) {
  const want = String(tagName).toLowerCase();
  const all = isTag(root) ? [root, ...findAll(() => true, [root], true)] : findAll(() => true, getChildren(root), true);
  return all.filter((el) => isTag(el) && (el.name || '').toLowerCase() === want);
}

export function getElementsById(root, id) {
  const all = isTag(root) ? [root, ...findAll(() => true, [root], true)] : findAll(() => true, getChildren(root), true);
  return all.filter((el) => isTag(el) && el.attribs && el.attribs['id'] === id);
}

// jsoup: Element#getElementsContainingOwnText —— 大小写不敏感 contains
export function getElementsContainingOwnText(root, searchText) {
  const needle = String(searchText).toLowerCase();
  const all = isTag(root) ? [root, ...findAll(() => true, [root], true)] : findAll(() => true, getChildren(root), true);
  return all.filter((el) => isTag(el) && elementOwnText(el).toLowerCase().includes(needle));
}

export function parseDoc(doc) {
  if (doc == null) return parseDocument('');
  if (typeof doc === 'object' && (isDocument(doc) || isTag(doc) || doc.type)) return doc;
  const str = String(doc);
  if (/^\s*<\?xml/i.test(str)) return parseDocument(str, { xmlMode: true, decodeEntities: true });
  return parseDocument(str, { decodeEntities: true });
}

// ---------- AnalyzeByJSoup ----------

class JsoupSourceRule {
  constructor(ruleStr) {
    if (/^@CSS:/i.test(ruleStr)) {
      this.isCss = true;
      this.elementsRule = ruleStr.substring(5).trim();
    } else {
      this.isCss = false;
      this.elementsRule = ruleStr;
    }
  }
}

export class AnalyzeByJSoup {
  constructor(doc) {
    this.element = parseDoc(doc);
  }

  getElements(rule) {
    return this._getElements(this.element, rule);
  }

  getString(ruleStr) {
    if (!ruleStr) return null;
    const list = this.getStringList(ruleStr);
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    return list.join('\n');
  }

  getString0(ruleStr) {
    const list = this.getStringList(ruleStr);
    return list.length === 0 ? '' : list[0];
  }

  getStringList(ruleStr) {
    const textS = [];
    if (!ruleStr) return textS;
    const sourceRule = new JsoupSourceRule(ruleStr);

    if (!sourceRule.elementsRule) {
      textS.push(elementData(this.element));
      return textS;
    }

    const ruleAnalyzes = new RuleAnalyzer(sourceRule.elementsRule);
    const ruleStrS = ruleAnalyzes.splitRule('&&', '||', '%%');

    const results = [];
    for (const ruleStrX of ruleStrS) {
      let temp;
      if (sourceRule.isCss) {
        const lastIndex = ruleStrX.lastIndexOf('@');
        if (lastIndex < 0) continue;
        temp = this._getResultLast(
          elementSelect(this.element, ruleStrX.substring(0, lastIndex)),
          ruleStrX.substring(lastIndex + 1)
        );
      } else {
        temp = this._getResultList(ruleStrX);
      }
      if (temp && temp.length) {
        results.push(temp);
        if (ruleAnalyzes.elementsType === '||') break;
      }
    }
    if (results.length) {
      if (ruleAnalyzes.elementsType === '%%') {
        for (let i = 0; i < results[0].length; i++) {
          for (const temp of results) {
            if (i < temp.length) textS.push(temp[i]);
          }
        }
      } else {
        for (const temp of results) textS.push(...temp);
      }
    }
    return textS;
  }

  _getElements(temp, rule) {
    if (temp == null || !rule) return [];
    const sourceRule = new JsoupSourceRule(rule);
    const ruleAnalyzes = new RuleAnalyzer(sourceRule.elementsRule);
    const ruleStrS = ruleAnalyzes.splitRule('&&', '||', '%%');

    const elementsList = [];
    if (sourceRule.isCss) {
      for (const ruleStr of ruleStrS) {
        const tempS = elementSelect(temp, ruleStr);
        elementsList.push(tempS);
        if (tempS.length && ruleAnalyzes.elementsType === '||') break;
      }
    } else {
      for (const ruleStr of ruleStrS) {
        const rsRule = new RuleAnalyzer(ruleStr);
        rsRule.trim();
        const rs = rsRule.splitRule('@');
        let el;
        if (rs.length > 1) {
          el = [temp];
          for (const rl of rs) {
            const es = [];
            for (const et of el) es.push(...this._getElements(et, rl));
            el = es;
          }
        } else {
          el = new ElementsSingle().getElementsSingle(temp, ruleStr);
        }
        elementsList.push(el);
        if (el.length > 0 && ruleAnalyzes.elementsType === '||') break;
      }
    }

    const elements = [];
    if (elementsList.length) {
      if (ruleAnalyzes.elementsType === '%%') {
        for (let i = 0; i < elementsList[0].length; i++) {
          for (const es of elementsList) {
            if (i < es.length) elements.push(es[i]);
          }
        }
      } else {
        for (const es of elementsList) elements.push(...es);
      }
    }
    return elements;
  }

  _getResultList(ruleStr) {
    if (!ruleStr) return null;
    let elements = [this.element];
    const rule = new RuleAnalyzer(ruleStr);
    rule.trim();
    const rules = rule.splitRule('@');
    const last = rules.length - 1;
    for (let i = 0; i < last; i++) {
      const es = [];
      for (const elt of elements) es.push(...new ElementsSingle().getElementsSingle(elt, rules[i]));
      elements = es;
    }
    if (!elements.length) return null;
    return this._getResultLast(elements, rules[last]);
  }

  _getResultLast(elements, lastRule) {
    const textS = [];
    switch (lastRule) {
      case 'text':
        for (const element of elements) {
          const text = elementText(element);
          if (text) textS.push(text);
        }
        return textS;
      case 'textNodes':
        for (const element of elements) {
          const tn = [];
          for (const item of elementTextNodes(element)) {
            const text = (item.data || '').trim();
            if (text) tn.push(text);
          }
          if (tn.length) textS.push(tn.join('\n'));
        }
        return textS;
      case 'ownText':
        for (const element of elements) {
          const text = elementOwnText(element);
          if (text) textS.push(text);
        }
        return textS;
      case 'html': {
        const cleaned = elements.filter((el) => isTag(el));
        const stripped = removeTags(cleaned, 'script', 'style');
        const html = outerHtml(stripped);
        if (html) textS.push(html);
        return textS;
      }
      case 'all':
        textS.push(outerHtml(elements));
        return textS;
      default:
        for (const element of elements) {
          const url = attrOf(element, lastRule);
          if (!url || !url.trim() || textS.includes(url)) continue;
          textS.push(url);
        }
        return textS;
    }
  }
}

// jsoup: elements.select("script").remove() / style
function removeTags(elements, ...tagNames) {
  const wanted = tagNames.map((t) => t.toLowerCase());
  const out = [];
  for (const el of elements) {
    const doomed = new Set();
    for (const tag of wanted) {
      for (const hit of getElementsByTagName(tag, [el], true)) {
        if (hit === el) doomed.add(hit);
        else if (hit.parent) {
          const idx = hit.parent.children.indexOf(hit);
          if (idx >= 0) hit.parent.children.splice(idx, 1);
        }
      }
    }
    if (!doomed.has(el)) out.push(el);
  }
  return out;
}

// ---------- ElementsSingle ----------

export class ElementsSingle {
  constructor() {
    this.split = '.';
    this.beforeRule = '';
    this.indexDefault = [];
    this.indexes = [];
  }

  getElementsSingle(temp, rule) {
    this.split = '.';
    this.beforeRule = '';
    this.indexDefault = [];
    this.indexes = [];
    this._findIndexSet(rule);

    let elements;
    if (!this.beforeRule) {
      elements = getChildren(temp).filter(isTag);
    } else {
      const rules = this.beforeRule.split('.');
      switch (rules[0]) {
        case 'children':
          elements = getChildren(temp).filter(isTag);
          break;
        case 'class':
          elements = getElementsByClass(temp, rules[1]);
          break;
        case 'tag':
          elements = getElementsByTag(temp, rules[1]);
          break;
        case 'id':
          elements = getElementsById(temp, rules[1]);
          break;
        case 'text':
          elements = getElementsContainingOwnText(temp, rules[1]);
          break;
        default:
          elements = elementSelect(temp, this.beforeRule);
          break;
      }
    }

    const len = elements.length;
    const lastIndexes = this.indexDefault.length - 1 !== -1 ? this.indexDefault.length - 1 : this.indexes.length - 1;
    const indexSet = new Set();

    if (this.indexes.length === 0) {
      for (let ix = lastIndexes; ix >= 0; ix--) {
        const it = this.indexDefault[ix];
        if (it >= 0 && it < len) indexSet.add(it);
        else if (it < 0 && len >= -it) indexSet.add(it + len);
      }
    } else {
      for (let ix = lastIndexes; ix >= 0; ix--) {
        const cur = this.indexes[ix];
        if (Array.isArray(cur)) {
          const startX = cur[0];
          const endX = cur[1];
          const stepX = cur[2];
          let start = startX === null || startX === undefined ? 0 : startX;
          if (start < 0) start += len;
          let end = endX === null || endX === undefined ? len - 1 : endX;
          if (end < 0) end += len;
          if ((start < 0 && end < 0) || (start >= len && end >= len)) continue;
          if (start >= len) start = len - 1;
          else if (start < 0) start = 0;
          if (end >= len) end = len - 1;
          else if (end < 0) end = 0;
          if (start === end || stepX >= len) {
            indexSet.add(start);
            continue;
          }
          const step = stepX > 0 ? stepX : -stepX < len ? stepX + len : 1;
          if (end > start) {
            for (let v = start; v <= end; v += step) indexSet.add(v);
          } else {
            for (let v = start; v >= end; v -= step) indexSet.add(v);
          }
        } else {
          const it = cur;
          if (it >= 0 && it < len) indexSet.add(it);
          else if (it < 0 && len >= -it) indexSet.add(it + len);
        }
      }
    }

    if (this.split === '!') {
      if (indexSet.size === 0) return elements;
      return elements.filter((_, i) => !indexSet.has(i));
    } else if (this.split === '.') {
      if (indexSet.size === 0) return [];
      const es = [];
      for (const i of indexSet) if (i >= 0 && i < len) es.push(elements[i]);
      return es;
    }
    return elements;
  }

  _findIndexSet(rule) {
    const rus = String(rule).trim();
    let len = rus.length;
    let curMinus = false;
    const curList = [];
    let l = '';
    const head = len > 0 && rus[len - 1] === ']';

    if (head) {
      len--;
      outer: while (true) {
        const cond = len;
        len -= 1;
        if (!(cond >= 0)) break;
        const i = len;
        const rl = rus[i];
        if (rl === ' ') continue;
        if (rl >= '0' && rl <= '9') {
          l = rl + l;
        } else if (rl === '-') {
          curMinus = true;
        } else {
          const curInt = l === '' ? null : curMinus ? -parseInt(l, 10) : parseInt(l, 10);
          if (rl === ':') {
            curList.push(curInt);
          } else {
            if (curList.length === 0) {
              if (curInt === null) break;
              this.indexes.push(curInt);
            } else {
              this.indexes.push([curInt, curList[curList.length - 1], curList.length === 2 ? curList[0] : 1]);
              curList.length = 0;
            }
            let rl2 = rl;
            if (rl2 === '!') {
              this.split = '!';
              do {
                len -= 1;
                rl2 = rus[len];
              } while (len > 0 && rl2 === ' ');
            }
            if (rl2 === '[') {
              this.beforeRule = rus.substring(0, len);
              return;
            }
            if (rl2 !== ',') break outer;
          }
          l = '';
          curMinus = false;
        }
      }
    } else {
      outer2: while (true) {
        const cond = len;
        len -= 1;
        if (!(cond >= 0)) break;
        const i = len;
        const rl = rus[i];
        if (rl === ' ') continue;
        if (rl >= '0' && rl <= '9') {
          l = rl + l;
        } else if (rl === '-') {
          curMinus = true;
        } else {
          if (rl === '!' || rl === '.' || rl === ':') {
            this.indexDefault.push(curMinus ? -parseInt(l, 10) : parseInt(l, 10));
            if (rl !== ':') {
              this.split = rl;
              this.beforeRule = rus.substring(0, len);
              return;
            }
          } else break outer2;
          l = '';
          curMinus = false;
        }
      }
    }

    this.split = ' ';
    this.beforeRule = rus;
  }
}