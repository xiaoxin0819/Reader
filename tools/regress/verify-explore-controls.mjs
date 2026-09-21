/* 验证发现页的下拉控件真的生效（不是只有 UI 值变了）。

   背景：七猫的「选择分组 / 性别 / 分类 / 字数 / 状态 / 排序」这些下拉，
   切换后要重新执行 exploreUrl 脚本产出**不同的分类列表**。
   曾经有两个 bug：
     1) 前端只更新了 infoMap，没有重绘分类 → 用户看到「值变了、内容没变」
     2) explore.mjs 的 .good 兜底按「url 数多者胜」比较，
        而「排行榜」只有 20 项、「动态分类」有 200+ 项，
        切到小分组时被旧的完整缓存挡住 → 同样表现为「切换没反应」

   用法：node tools/regress/verify-explore-controls.mjs [port]
   默认端口 7788（源码模式服务需已在运行）。
*/
const PORT = Number(process.argv[2] || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const SRC = 'https://api-bc.wtzw.com#七猫官方API';

const pass = [];
const fail = [];
const ck = (ok, label, extra = '') => (ok ? pass : fail).push(label + (extra ? ' — ' + extra : ''));

const kindsOf = async () => (await (await fetch(`${BASE}/api/online/explore/kinds?source=${encodeURIComponent(SRC)}`)).json()).kinds || [];
const act = async (body) => (await fetch(`${BASE}/api/online/explore/action`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();
const curIm = (kinds) => {
  const im = {};
  for (const x of kinds) {
    if (String(x.type || 'url') === 'select') {
      im[x.title] = x.default != null ? String(x.default) : (x.chars && x.chars[0]);
    }
  }
  return im;
};
const urlFp = (kinds) => kinds
  .filter((x) => String(x.type || 'url') === 'url' && x.url)
  .map((x) => String(x.url)).join('|');

async function setGroup(g) {
  const base = await kindsOf();
  const gk = base.find((x) => String(x.title).includes('选择分组'));
  if (!gk) return base;
  const im = curIm(base);
  im['📁 选择分组'] = g;
  const r = await act({ source: SRC, action: gk.action, kind: gk, infoMap: im, title: '📁 选择分组' });
  return r.kinds && r.kinds.length ? r.kinds : await kindsOf();
}

/**
 * 把某个分组下的下拉复位到指定值。
 *
 * 注意：**每次都要重新取控件**。切换分组后控件名可能变化
 * （例如「经典分类」是「📜 分类」，「动态分类」是「📓 分类」），
 * 用旧的 kind 对象复位会打到已经不存在的控件上，
 * 导致下一轮从「脏状态」开始 —— 这正是之前 3 个用例时好时坏的原因。
 */
async function resetCtrl(group, title, value) {
  const k = await setGroup(group);
  const c = k.find((x) => String(x.title) === title);
  if (!c) return;
  const im = curIm(k);
  im[title] = value;
  await act({ source: SRC, action: c.action, kind: c, infoMap: im, title });
}

try {
  const base = await kindsOf();
  ck(base.length > 0, '七猫发现页可加载', base.length + ' 项');

  const gk = base.find((x) => String(x.title).includes('选择分组'));
  ck(!!gk, '存在「选择分组」下拉');
  if (!gk) throw new Error('没有选择分组，无法继续');

  // 1) 每个分组必须产出**互不相同**的内容
  const seen = new Map();
  for (const g of gk.chars) {
    const k = await setGroup(g);
    const fp = urlFp(k);
    ck(fp.length > 0, `分组「${g}」有内容入口`, k.length + ' 项');
    seen.set(g, fp);
  }
  const uniq = new Set(seen.values());
  ck(uniq.size === seen.size, '各分组内容互不相同（切换真的生效）',
    [...seen.entries()].map(([g, fp]) => `${g}=${fp.split('|').length}`).join(' '));

  /**
   * 2) 子控件（性别/分类/字数/状态/排序）切换后 URL 必须变化。
   *
   * 已知例外：七猫「🔄 动态分类」分组下的「📏 字数 / ⏳ 状态 / 📌 排序」不会生效。
   * 这是**书源脚本自身的设计**，不是阅读器 bug：
   *   这三个下拉的 action 写的是 c.dynamicWords / c.dynamicOver / c.dynamicSort，
   *   但该分组的脚本只读取 config.dynamicGender 和 config.dynamicGroup 来拼分类列表，
   *   从未读取这三个变量（脚本里出现 0 次）—— 变量存了却没人用，属于书源作者留的摆设。
   * 「📚 经典分类」和「🏷️ 标签」分组下的同名下拉则都正常生效。
   * 这里显式记录为「已知例外」，避免以后被误当成回归。
   */
  const KNOWN_INERT = new Set([
    '🔄 动态分类/📏 字数',
    '🔄 动态分类/⏳ 状态',
    '🔄 动态分类/📌 排序',
  ]);
  let inertSkipped = 0;

  for (const g of ['📚 经典分类', '🔄 动态分类', '🏷️ 标签']) {
    let k = await setGroup(g);
    const ctrls = k.filter((x) => String(x.type || 'url') === 'select' && !String(x.title).includes('选择分组'));
    for (const c of ctrls) {
      const chars = Array.isArray(c.chars) ? c.chars : [];
      const cur = c.default != null ? String(c.default) : chars[0];
      const to = chars.find((v) => v !== cur);
      if (to === undefined) continue;
      if (KNOWN_INERT.has(`${g}/${c.title}`)) { inertSkipped++; continue; }
      /**
       * 每个用例都从「该分组的干净基线」开始，并且比较的是**同一个控件切到两个不同值**时的差异。
       *
       * 不能只比较「切换前后」：其他控件可能残留上一轮的值，
       * 导致切换前后恰好相同（或恰好不同），出现假阴性/假阳性。
       * 正确做法：先显式把该控件设成 A 取指纹，再设成 B 取指纹，比较 A 与 B。
       */
      await resetCtrl(g, c.title, cur);
      const fpA = urlFp(await kindsOf());
      const imB = curIm(await kindsOf());
      imB[c.title] = to;
      const rB = await act({ source: SRC, action: c.action, kind: c, infoMap: imB, title: c.title });
      const afterB = rB.kinds && rB.kinds.length ? rB.kinds : await kindsOf();
      ck(urlFp(afterB) !== fpA, `${g} / ${c.title} 切换生效`, `${cur} → ${to}`);
      await resetCtrl(g, c.title, cur);
      k = await kindsOf();
    }
  }

  // 收尾：恢复默认分组
  await setGroup('🔄 动态分类');
  ck(inertSkipped === 3, '已知例外恰好 3 个（书源脚本未读取这三个变量）', '跳过 ' + inertSkipped + ' 个');
} catch (e) {
  fail.push('异常: ' + e.message);
}

console.log('\n===== 发现页控件生效验证 =====');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n结果: ${pass.length} PASS / ${fail.length} FAIL`);
process.exit(fail.length ? 1 : 0);
