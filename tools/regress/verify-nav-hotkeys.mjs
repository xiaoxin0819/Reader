/* 快捷键验证（自包含）：先跳到中间章，再检查两个 tooltip 与快捷键行为。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const PORT = Number(process.env.PROBE_PORT) || 7788;
const CDP = Number(process.env.PROBE_CDP_PORT) || 17957;
const DIR=path.join(os.tmpdir(),'reader-hotkey3');
fs.rmSync(DIR,{recursive:true,force:true}); fs.mkdirSync(DIR,{recursive:true});
const EDGE=['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const waitOk=async(u,ms=30000)=>{const e=Date.now()+ms;while(Date.now()<e){try{if((await fetch(u)).ok)return true}catch{}await new Promise(r=>setTimeout(r,200))}return false};
let browser=null;
try{
  browser=spawn(EDGE,['--headless=new',`--remote-debugging-port=${CDP}`,`--user-data-dir=${path.join(DIR,'prof')}`,'--no-first-run','--disable-gpu','--window-size=1440,1000','about:blank'],{stdio:'ignore'});
  if(!(await waitOk(`http://127.0.0.1:${CDP}/json/version`))) throw new Error('Edge 未启动');
  const t=await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`,{method:'PUT'})).json();
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
  let id=0; const pending=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
  const send=(m,p={})=>new Promise(res=>{const n=++id;pending.set(n,res);ws.send(JSON.stringify({id:n,method:m,params:p}))});
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    if(r.result&&r.result.exceptionDetails) return {__err:(r.result.exceptionDetails.exception||{}).description};
    return r.result&&r.result.result?r.result.result.value:undefined};
  await send('Runtime.enable');
  await new Promise(r=>setTimeout(r,3500));

  console.log('前置：打开书并跳到第 5 章（保证前后都有章）');
  await ev(`(async()=>{
    document.querySelector('.mode-switch button[data-mode="online"]').click();
    await new Promise(r=>setTimeout(r,2000));
    document.querySelector('.book-item').click();
    for(let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,500)); if(state.book && (state.book.chapterCount||0)>0) break; }
    gotoChapter(4); await new Promise(r=>setTimeout(r,2500));
  })()`);

  const tips = await ev(`(()=>({
    prev: document.getElementById('btnPrevBook').title,
    next: document.getElementById('btnNextBook').title,
    auto: document.getElementById('btnAutoNext').title,
  }))()`);
  console.log('tooltip:', JSON.stringify(tips));

  const k1 = await ev(`(async()=>{
    const b=state.chapterIdx;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    await new Promise(r=>setTimeout(r,2500));
    return { before:b, after:state.chapterIdx, moved:state.chapterIdx!==b };
  })()`);
  const k2 = await ev(`(async()=>{
    const b=state.chapterIdx;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    await new Promise(r=>setTimeout(r,2500));
    return { before:b, after:state.chapterIdx, moved:state.chapterIdx!==b };
  })()`);

  let pass=0,fail=0;
  const ck=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${l}${e?' — '+e:''}`)};
  console.log('\n判定:');
  ck(/←/.test(tips.prev)&&/PageUp/.test(tips.prev), '「上一章」tooltip 标出 ← / PageUp', tips.prev);
  ck(/→/.test(tips.next)&&/PageDown/.test(tips.next), '「下一章」tooltip 标出 → / PageDown', tips.next);
  ck(/自动下一章/.test(tips.auto), '自动下一章 tooltip 正常');
  ck(k1.moved, '→ 快捷键真的翻章', `${k1.before} → ${k1.after}`);
  ck(k2.moved, '← 快捷键真的翻回', `${k2.before} → ${k2.after}`);
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
} finally { try{browser&&browser.kill()}catch{} }
