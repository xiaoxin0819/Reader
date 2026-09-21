/* 自动下一章验证（更新版）：设置面板已移除复选框，改为验证顶栏按钮 + 状态一致性。 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { spawn } from 'node:child_process';
const PORT = Number(process.env.PROBE_PORT) || 7788;
const CDP = Number(process.env.PROBE_CDP_PORT) || 17949;
const DIR=path.join(os.tmpdir(),'reader-an2');
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
  let pass=0,fail=0;
  const ck=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${l}${e?' — '+e:''}`)};

  const r1 = await ev(`(()=>{
    const a=document.getElementById('btnAutoNext');
    return { exists:!!a, on:a?a.classList.contains('on'):null, title:a?a.title:null,
             setting:state.settings.autoNext, checkboxInSettings:!!document.getElementById('setAutoNext') };
  })()`);
  console.log('初始:', JSON.stringify(r1));
  ck(r1.exists, '顶栏按钮存在');
  ck(!r1.checkboxInSettings, '设置面板里的复选框已移除');
  ck(r1.on === (r1.setting!==false), '按钮状态与 state.settings.autoNext 一致');

  const r2 = await ev(`(async()=>{
    const a=document.getElementById('btnAutoNext');
    const before={on:a.classList.contains('on'), setting:state.settings.autoNext};
    a.click(); await new Promise(r=>setTimeout(r,300));
    const after={on:a.classList.contains('on'), setting:state.settings.autoNext, title:a.title};
    a.click(); await new Promise(r=>setTimeout(r,300));
    const back={on:a.classList.contains('on'), setting:state.settings.autoNext};
    return {before,after,back};
  })()`);
  console.log('切换:', JSON.stringify(r2));
  ck(r2.before.on !== r2.after.on, '点击翻转');
  ck(r2.after.on === r2.after.setting, '翻转后与 state 一致');
  ck(/已开启/.test(r2.after.title||''), '开启后 tooltip 正确', r2.after.title);
  ck(r2.back.on === r2.before.on, '再点恢复原状态');

  const r3 = await ev(`(async()=>{
    document.getElementById('btnSettings').click();
    await new Promise(r=>setTimeout(r,600));
    const body=document.querySelector('#modalSettings .settings-body');
    const rows=Array.from(body.querySelectorAll('.row')).map(x=>(x.querySelector('span')||{}).textContent||'');
    return { rows, hasAuto: rows.some(t=>t.includes('自动下一章')) };
  })()`);
  console.log('设置面板行:', JSON.stringify(r3.rows));
  ck(!r3.hasAuto, '设置面板无「自动下一章」行');

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
} finally { try{browser&&browser.kill()}catch{} }

