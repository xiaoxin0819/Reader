// AnalyzeByJSonPath —— 移植自 legado io.legado.app.model.analyzeRule.AnalyzeByJSonPath
// jayway JsonPath -> jsonpath-plus
import { JSONPath } from 'jsonpath-plus';
import { RuleAnalyzer } from './rule-analyzer.mjs';

function parse(json) {
  if (typeof json === 'string') {
    try {
      return JSON.parse(json);
    } catch (e) {
      return json;
    }
  }
  return json;
}

export class AnalyzeByJSonPath {
  constructor(json) {
    this.ctx = parse(json);
  }

  // legado 用 Jayway JsonPath，PathCompiler 对不以 `$`/`@` 开头的规则统一前置 `$.`：
  //   `.data.book_list[*]` → `$..data.book_list[*]`（递归下降，可命中任意深度的节点）
  // jsonpath-plus 不接受以「.」开头的路径，会直接返回 undefined，这里按 legado 同一语义补根节点。
  // 这条差异正是番茄书架分组（响应为 data.detail_list）与分类列表共用 `.xxx||.yyy` 规则时的关键。
  _normalizePath(rule) {
    const r = String(rule == null ? '' : rule).trim();
    if (!r) return r;
    return /^[$@]/.test(r) ? r : '$.' + r;
  }

  _read(rule) {
    try {
      return JSONPath({ path: this._normalizePath(rule), json: this.ctx, wrap: false });
    } catch (e) {
      return undefined;
    }
  }

  getString(rule) {
    if (!rule) return null;
    let result = '';
    const ruleAnalyzes = new RuleAnalyzer(rule, true);
    const rules = ruleAnalyzes.splitRule('&&', '||');

    if (rules.length === 1) {
      ruleAnalyzes.reSetPos();
      result = ruleAnalyzes.innerRule('{$.', (r) => this.getString(r));
      if (!result) {
        const ob = this._read(rule);
        if (ob === undefined) return result;
        result = Array.isArray(ob) ? ob.join('\n') : String(ob);
      }
      return result;
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

  getStringList(rule) {
    const result = [];
    if (!rule) return result;
    const ruleAnalyzes = new RuleAnalyzer(rule, true);
    const rules = ruleAnalyzes.splitRule('&&', '||', '%%');

    if (rules.length === 1) {
      ruleAnalyzes.reSetPos();
      const st = ruleAnalyzes.innerRule('{$.', (r) => this.getString(r));
      if (!st) {
        const obj = this._read(rule);
        if (obj !== undefined) {
          if (Array.isArray(obj)) for (const o of obj) result.push(String(o));
          else result.push(String(obj));
        }
      } else {
        result.push(st);
      }
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

  getObject(rule) {
    return this._read(rule);
  }

  getList(rule) {
    const result = [];
    if (!rule) return result;
    const ruleAnalyzes = new RuleAnalyzer(rule, true);
    const rules = ruleAnalyzes.splitRule('&&', '||', '%%');
    if (rules.length === 1) {
      const r = this._read(rules[0]);
      return r === undefined ? result : r;
    }
    const results = [];
    for (const rl of rules) {
      const temp = this.getList(rl);
      if (temp && temp.length) {
        results.push(temp);
        if (ruleAnalyzes.elementsType === '||') break;
      }
    }
    if (results.length) {
      if (ruleAnalyzes.elementsType === '%%') {
        for (let i = 0; i < results[0].length; i++) {
          for (const temp of results) if (i < temp.length && temp[i] != null) result.push(temp[i]);
        }
      } else {
        for (const temp of results) result.push(...temp);
      }
    }
    return result;
  }
}