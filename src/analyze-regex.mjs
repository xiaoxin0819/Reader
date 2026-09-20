// AnalyzeByRegex —— 移植自 legado io.legado.app.model.analyzeRule.AnalyzeByRegex
// Java Pattern/Matcher.find -> JS RegExp 循环 exec（Java 的 find 是"任意位置匹配"，JS 用 g 标志的 exec 等价）

function execAll(re, res, limit) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(res)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
    if (limit && out.length >= limit) break;
  }
  return out;
}

export const AnalyzeByRegex = {
  // 返回 [group0, group1, ...]；Java: resM.group(groupIndex)!!
  getElement(res, regs, index = 0) {
    let vIndex = index;
    const re = new RegExp(regs[vIndex]);
    re.lastIndex = 0;
    const first = re.exec(res);
    if (first === null) return null;
    if (vIndex + 1 === regs.length) {
      const info = [];
      for (let i = 0; i <= first.length - 1; i++) info.push(first[i] === undefined ? '' : first[i]);
      return info;
    }
    let result = '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(res)) !== null) {
      result += m[0];
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return this.getElement(result, regs, ++vIndex);
  },

  // 返回 [[group0, group1, ...], ...]
  getElements(res, regs, index = 0) {
    let vIndex = index;
    const re = new RegExp(regs[vIndex]);
    const matches = execAll(re, res);
    if (matches.length === 0) return [];
    if (vIndex + 1 === regs.length) {
      const books = [];
      for (const m of matches) {
        const info = [];
        for (let i = 0; i <= m.length - 1; i++) info.push(m[i] === undefined ? '' : m[i]);
        books.push(info);
      }
      return books;
    }
    let result = '';
    for (const m of matches) result += m[0];
    return this.getElements(result, regs, ++vIndex);
  },
};