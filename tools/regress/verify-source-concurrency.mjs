/* 书源并发闸门验证（纯本地，不连源站、不改用户数据）。

   验证「限制该书源（防封禁）」勾上后 concurrencyLimit=3 的行为：
   同一书源同时最多 3 个在飞，多出的排队；且会真正用满 3 个（不是退化成串行）。

   用法：node tools/regress/verify-source-concurrency.mjs
*/
import { BookPool } from '../../src/book-pool.mjs';

// 造一个「受限」书源和 4 个 worker，任务里记录同时在飞数
const sources = [{ bookSourceUrl: '测试源', bookSourceName: '测试源', concurrencyLimit: 3 }];
const pool = new BookPool({ size: 4, netSlots: 4, timeout: 10000, sources });

let active = 0, maxActive = 0, done = 0;
const origRequest = pool.request.bind(pool);
// 用真实 slot 但把 payload 换成 ping 类任务不可行，这里直接观察 _acquire/_release 行为
const t0 = Date.now();
const jobs = [];
for (let i = 0; i < 8; i++) {
  jobs.push((async () => {
    const gate = await pool._acquire('测试源');
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 120));
    active--;
    pool._release(gate);
    done++;
  })());
}
await Promise.all(jobs);
const ms = Date.now() - t0;

console.log(`完成 ${done} 个任务，耗时 ${ms}ms`);
console.log(`同时在飞最大数 = ${maxActive}（上限应为 3）`);
console.log('');
let pass=0,fail=0;
const ck=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${l}${e?' — '+e:''}`)};
ck(done===8, '全部 8 个任务完成');
ck(maxActive<=3, '同时在飞不超过 3', `实测 ${maxActive}`);
ck(maxActive===3, '确实用满了 3 个并发（没有过度串行）', `实测 ${maxActive}`);
console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail?1:0);
