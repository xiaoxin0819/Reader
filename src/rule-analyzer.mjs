// RuleAnalyzer —— 1:1 移植自 legado io.legado.app.model.analyzeRule.RuleAnalyzer
// 通用规则切分处理：按 && / || / %% / @ 切分，但会跳过 [] () 内部（筛选器）的这些符号。

const ESC = '\\';

// Kotlin: c < '!' 等价于 c <= ' ' （按 UTF-16 码元比较，不做 Unicode 空白扩展）
function leSpace(ch) {
  return ch !== undefined && ch <= ' ';
}

export class RuleAnalyzer {
  constructor(data, code = false) {
    this.queue = data;
    this.pos = 0;
    this.start = 0;
    this.startX = 0;
    this.rule = [];
    this.step = 0;
    this.elementsType = '';
    this.code = !!code;
  }

  chompBalanced(open, close) {
    return this.code ? this.chompCodeBalanced(open, close) : this.chompRuleBalanced(open, close);
  }

  // 修剪当前规则之前的 "@" 或者空白符
  trim() {
    const q = this.queue;
    if (q[this.pos] === '@' || leSpace(q[this.pos])) {
      this.pos++;
      while (this.pos < q.length && (q[this.pos] === '@' || leSpace(q[this.pos]))) this.pos++;
      this.start = this.pos;
      this.startX = this.pos;
    }
  }

  reSetPos() {
    this.pos = 0;
    this.startX = 0;
  }

  // 从剩余字串中拉出一个字符串，直到但不包括匹配序列
  consumeTo(seq) {
    this.start = this.pos;
    const offset = this.queue.indexOf(seq, this.pos);
    if (offset !== -1) {
      this.pos = offset;
      return true;
    }
    return false;
  }

  // 直到但不包括匹配序列（任意一项），或剩余字串用完
  consumeToAny(...seq) {
    let pos = this.pos;
    const q = this.queue;
    while (pos !== q.length) {
      for (let i = 0; i < seq.length; i++) {
        const s = seq[i];
        if (s.length > 0 && q.startsWith(s, pos)) {
          this.step = s.length;
          this.pos = pos;
          return true;
        }
      }
      pos++;
    }
    return false;
  }

  findToAny(...seq) {
    let pos = this.pos;
    const q = this.queue;
    while (pos !== q.length) {
      for (let i = 0; i < seq.length; i++) if (q[pos] === seq[i]) return pos;
      pos++;
    }
    return -1;
  }

  // 拉出一个非内嵌代码平衡组，存在转义文本（用于 JS / JSON）
  chompCodeBalanced(open, close) {
    let pos = this.pos;
    let depth = 0;
    let otherDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    const q = this.queue;
    do {
      if (pos === q.length) break;
      const c = q[pos++];
      if (c !== ESC) {
        if (c === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
        else if (c === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
        if (inSingleQuote || inDoubleQuote) continue;
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (depth === 0) {
          if (c === open) otherDepth++;
          else if (c === close) otherDepth--;
        }
      } else pos++;
    } while (depth > 0 || otherDepth > 0);
    if (depth > 0 || otherDepth > 0) return false;
    this.pos = pos;
    return true;
  }

  // 拉出一个规则平衡组（xpath / css 中引号内转义字符无效）
  chompRuleBalanced(open, close) {
    let pos = this.pos;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    const q = this.queue;
    do {
      if (pos === q.length) break;
      const c = q[pos++];
      if (c === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
      else if (c === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
      if (inSingleQuote || inDoubleQuote) continue;
      else if (c === '\\') {
        pos++;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) depth--;
    } while (depth > 0);
    if (depth > 0) return false;
    this.pos = pos;
    return true;
  }

  // 首段匹配（elementsType 为空，或由外部指定）
  splitRule(...split) {
    if (split.length === 1) {
      this.elementsType = split[0];
      if (!this.consumeTo(this.elementsType)) {
        this.rule.push(this.queue.substring(this.startX));
        return this.rule;
      }
      this.step = this.elementsType.length;
      return this.splitRuleNext();
    }
    if (!this.consumeToAny(...split)) {
      this.rule.push(this.queue.substring(this.startX));
      return this.rule;
    }
    const end = this.pos;
    this.pos = this.start;
    for (;;) {
      const st = this.findToAny('[', '(');
      if (st === -1) {
        this.rule = [this.queue.substring(this.startX, end)];
        this.elementsType = this.queue.substring(end, end + this.step);
        this.pos = end + this.step;
        while (this.consumeTo(this.elementsType)) {
          this.rule.push(this.queue.substring(this.start, this.pos));
          this.pos += this.step;
        }
        this.rule.push(this.queue.substring(this.pos));
        return this.rule;
      }
      if (st > end) {
        this.rule = [this.queue.substring(this.startX, end)];
        this.elementsType = this.queue.substring(end, end + this.step);
        this.pos = end + this.step;
        while (this.consumeTo(this.elementsType) && this.pos < st) {
          this.rule.push(this.queue.substring(this.start, this.pos));
          this.pos += this.step;
        }
        if (this.pos > st) {
          this.startX = this.start;
          return this.splitRuleNext();
        }
        this.rule.push(this.queue.substring(this.pos));
        return this.rule;
      }
      this.pos = st;
      const next = this.queue[this.pos] === '[' ? ']' : ')';
      if (!this.chompBalanced(this.queue[this.pos], next)) {
        throw new Error(this.queue.substring(0, this.start) + '后未平衡');
      }
      if (!(end > this.pos)) break;
    }
    this.start = this.pos;
    return this.splitRule(...split);
  }

  // 二段匹配（elementsType 已赋值，直接按 elementsType 查找，更快）
  splitRuleNext() {
    const end = this.pos;
    this.pos = this.start;
    for (;;) {
      const st = this.findToAny('[', '(');
      if (st === -1) {
        this.rule.push(this.queue.substring(this.startX, end));
        this.pos = end + this.step;
        while (this.consumeTo(this.elementsType)) {
          this.rule.push(this.queue.substring(this.start, this.pos));
          this.pos += this.step;
        }
        this.rule.push(this.queue.substring(this.pos));
        return this.rule;
      }
      if (st > end) {
        this.rule.push(this.queue.substring(this.startX, end));
        this.elementsType = this.queue.substring(end, end + this.step);
        this.pos = end + this.step;
        while (this.consumeTo(this.elementsType) && this.pos < st) {
          this.rule.push(this.queue.substring(this.start, this.pos));
          this.pos += this.step;
        }
        if (this.pos > st) {
          this.startX = this.start;
          return this.splitRuleNext();
        }
        this.rule.push(this.queue.substring(this.pos));
        return this.rule;
      }
      this.pos = st;
      const next = this.queue[this.pos] === '[' ? ']' : ')';
      if (!this.chompBalanced(this.queue[this.pos], next)) {
        throw new Error(this.queue.substring(0, this.start) + '后未平衡');
      }
      if (!(end > this.pos)) break;
    }
    this.start = this.pos;
    if (!this.consumeTo(this.elementsType)) {
      this.rule.push(this.queue.substring(this.startX));
      return this.rule;
    }
    return this.splitRuleNext();
  }

  // 替换内嵌 {....} 规则（代码平衡）
  innerRuleCode(inner, startStep, endStep, fr) {
    const st = [];
    while (this.consumeTo(inner)) {
      const posPre = this.pos;
      if (this.chompCodeBalanced('{', '}')) {
        const frv = fr(this.queue.substring(posPre + startStep, this.pos - endStep));
        if (frv !== null && frv !== undefined && frv !== '') {
          st.push(this.queue.substring(this.startX, posPre) + frv);
          this.startX = this.pos;
          continue;
        }
      }
      this.pos += inner.length;
    }
    if (this.startX === 0) return '';
    return st.join('') + this.queue.substring(this.startX);
  }

  // 替换内嵌 startStr...endStr 规则
  innerRuleStr(startStr, endStr, fr) {
    const st = [];
    while (this.consumeTo(startStr)) {
      this.pos += startStr.length;
      const posPre = this.pos;
      if (this.consumeTo(endStr)) {
        const frv = fr(this.queue.substring(posPre, this.pos));
        st.push(this.queue.substring(this.startX, posPre - startStr.length) + frv);
        this.pos += endStr.length;
        this.startX = this.pos;
      }
    }
    if (this.startX === 0) return this.queue;
    return st.join('') + this.queue.substring(this.startX);
  }

  // innerRule("{$.") { ... }         → innerRuleCode(inner,1,1,fr)
  // innerRule(inner,s,e,fr:数字)     → innerRuleCode(inner,s,e,fr)
  // innerRule(inner,startStr,endStr,fr) → innerRuleStr
  innerRule(...args) {
    if (args.length === 2) {
      const [inner, fr] = args;
      if (typeof fr === 'function') return this.innerRuleCode(inner, 1, 1, fr);
      return null;
    }
    if (args.length === 3) {
      const [startStr, endStr, fr] = args;
      if (typeof fr === 'function') return this.innerRuleStr(startStr, endStr, fr);
      return null;
    }
    if (args.length === 4) {
      const [inner, startStep, endStep, fr] = args;
      if (typeof fr === 'function') return this.innerRuleCode(inner, startStep, endStep, fr);
      return null;
    }
    return null;
  }
}