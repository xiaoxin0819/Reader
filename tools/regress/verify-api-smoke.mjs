// 服务端接口冒烟：逐个打常用只读接口，确认都返回 200 且结构正常。
// 不触发外部站点请求（除正文/目录这种必要项，且只各打一次）。
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:7788';

const checks = [
  ['/api/state', (j) => j.settings && Array.isArray(j.shelves)],
  ['/api/build', (j) => typeof j === 'object'],
  ['/api/online/pool', (j) => typeof j.size === 'number'],
  ['/api/online/storage', (j) => typeof j === 'object'],
  ['/api/online/shelf', (j) => Array.isArray(j.books)],
  ['/api/source-groups', (j) => typeof j === 'object'],
  ['/api/sources', (j) => Array.isArray(j.sources) || Array.isArray(j)],
  ['/api/sources/groups', (j) => typeof j === 'object'],
  ['/api/online/bookGroups', (j) => typeof j === 'object'],
  ['/api/replace-rules', (j) => Array.isArray(j.rules) || Array.isArray(j)],
  ['/api/replace-rules/groups', (j) => typeof j === 'object'],
  ['/api/txt-toc-rules', (j) => Array.isArray(j.rules) || Array.isArray(j)],
  ['/api/verify/pending', (j) => typeof j === 'object'],
];

let pass = 0, fail = 0;
for (const [ep, validate] of checks) {
  try {
    const t0 = Date.now();
    const r = await fetch(BASE + ep);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    const okShape = j ? !!validate(j) : false;
    const ok = r.ok && okShape;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${ep.padEnd(26)} ${r.status}  ${Date.now() - t0}ms  ${okShape ? '' : '(结构不符)'}`);
    if (ok) pass++; else fail++;
  } catch (e) {
    console.log(`FAIL  ${ep.padEnd(26)} ERR ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
