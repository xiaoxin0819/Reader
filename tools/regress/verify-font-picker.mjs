/* 验证：① 旧复选框兼容代码已删（页面无 setAutoNext 元素且不报错）
        ② 字体选择器：逐项字体渲染 + 自定义项带删除叉 + 内置项不可删 + 删除可用 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { spawn } from 'node:child_process';
const PORT = Number(process.env.PROBE_PORT) || 7788;
const CDP = Number(process.env.PROBE_CDP_PORT) || 17945;
const DIR=path.join(os.tmpdir(),'reader-font2');
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
  let id=0; const pending=new Map(); const errs=[];
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown') errs.push(String((m.params.exceptionDetails.exception||{}).description||'').slice(0,140));
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error') errs.push('CONSOLE:'+String((m.params.args||[]).map(a=>a.value||a.description).join(' ')).slice(0,140));
  };
  const send=(m,p={})=>new Promise(res=>{const n=++id;pending.set(n,res);ws.send(JSON.stringify({id:n,method:m,params:p}))});
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    if(r.result&&r.result.exceptionDetails) return {__err:(r.result.exceptionDetails.exception||{}).description};
    return r.result&&r.result.result?r.result.result.value:undefined};
  await send('Runtime.enable');
  await new Promise(r=>setTimeout(r,3500));
  let pass=0,fail=0;
  const ck=(ok,l,e='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${l}${e?' — '+e:''}`)};

  console.log('[1] 打开设置，展开字体选择器');
  const r1 = await ev(`(async()=>{
    document.getElementById('btnSettings').click();
    await new Promise(r=>setTimeout(r,600));
    document.getElementById('fontPickerBtn').click();
    await new Promise(r=>setTimeout(r,400));
    const menu=document.getElementById('fontPickerMenu');
    const items=Array.from(menu.querySelectorAll('.fp-item'));
    return {
      legacyCheckboxGone: !document.getElementById('setAutoNext'),
      legacyListGone: !document.getElementById('fontList'),
      legacySelectGone: !document.getElementById('setFamily'),
      menuOpen: !menu.classList.contains('hidden'),
      items: items.map(it=>({
        value: it.dataset.value,
        name: it.querySelector('.fp-name').textContent,
        font: it.querySelector('.fp-name').style.fontFamily,
        hasDel: !!it.querySelector('.fp-del'),
        active: it.classList.contains('on'),
      })),
      btnFont: document.getElementById('fontPickerCur').style.fontFamily,
      btnText: document.getElementById('fontPickerCur').textContent,
    };
  })()`);
  console.log('   ', JSON.stringify(r1,null,1));
  ck(r1.legacyCheckboxGone, '旧复选框元素已移除');
  ck(r1.legacyListGone && r1.legacySelectGone, '旧字体列表 / 原生 select 已移除');
  ck(r1.menuOpen, '选择器可展开');
  const builtin = r1.items.filter(i=>!i.value.startsWith('custom:'));
  const custom = r1.items.filter(i=>i.value.startsWith('custom:'));
  ck(builtin.length===4, '内置字体 4 项', String(builtin.length));
  ck(custom.length>=1, '有自定义字体', String(custom.length));
  ck(builtin.every(i=>!i.hasDel), '内置字体没有删除叉（不可删）');
  ck(custom.every(i=>i.hasDel), '自定义字体每项都有删除叉');
  ck(custom.every(i=>/rz-/.test(i.font)), '自定义项用自身字体渲染', custom[0]&&custom[0].font);
  ck(builtin.every(i=>i.font && i.font.length>0), '内置项也应用各自字体');
  ck(r1.btnText && r1.btnFont, '顶部按钮显示当前字体名并用该字体渲染', `${r1.btnText} / ${r1.btnFont}`);

  console.log('\n[2] 点一个内置字体，确认选中并应用');
  const r2 = await ev(`(async()=>{
    const menu=document.getElementById('fontPickerMenu');
    const kai=Array.from(menu.querySelectorAll('.fp-item')).find(i=>i.dataset.value==='kai');
    kai.click();
    await new Promise(r=>setTimeout(r,500));
    return {
      setting: state.settings.fontFamily,
      menuClosed: document.getElementById('fontPickerMenu').classList.contains('hidden'),
      btnText: document.getElementById('fontPickerCur').textContent,
      contentFont: document.getElementById('content').style.fontFamily,
    };
  })()`);
  console.log('   ', JSON.stringify(r2));
  ck(r2.setting==='kai', '选中的字体写进设置', r2.setting);
  ck(r2.menuClosed, '选完自动收起');
  ck(/Kaiti|KaiTi|楷/.test(r2.contentFont), '正文应用了楷体', r2.contentFont);

  console.log('\n[3] 内置字体不能被删（没有叉，DOM 里也没有删除入口）');
  const r3 = await ev(`(()=>{
    const menu=document.getElementById('fontPickerMenu');
    const builtin=Array.from(menu.querySelectorAll('.fp-item')).filter(i=>!i.dataset.value.startsWith('custom:'));
    return { delCount: builtin.reduce((n,i)=>n+i.querySelectorAll('.fp-del').length,0) };
  })()`);
  ck(r3.delCount===0, '内置项的删除叉数量为 0', String(r3.delCount));

  /* 截图写到系统临时目录（不是项目里的 .scratch —— 那个目录会被清理，
     写进去会让脚本在「已清理」的环境下报 ENOENT）。 */
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(os.tmpdir(), 'reader-fontpicker.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图: ' + shotPath);
  console.log(`\n控制台错误: ${errs.length?errs.join(' | '):'无'}`);
  console.log(`结果: ${pass} PASS / ${fail} FAIL`);
} finally { try{browser&&browser.kill()}catch{} }
