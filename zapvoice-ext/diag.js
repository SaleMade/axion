'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
function getJson(p) { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: 9222, path: p }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
class CDP { constructor(ws){ this.ws=ws; this.id=0; this.cbs={}; ws.addEventListener('message',(e)=>{ let m; try{m=JSON.parse(e.data);}catch(_){return;} if(m.id&&this.cbs[m.id]){this.cbs[m.id](m); delete this.cbs[m.id];} }); } send(method,params){ return new Promise((res)=>{ const id=++this.id; this.cbs[id]=res; this.ws.send(JSON.stringify({id,method,params:params||{}})); }); } }
async function ev(cdp, src, byVal){ const r = await cdp.send('Runtime.evaluate',{ expression: src, returnByValue: !!byVal, awaitPromise:false }); return r.result || {}; }
function val(r){ return r.result ? r.result.value : undefined; }
function exc(r){ return r.exceptionDetails ? (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) : 'nenhuma'; }
(async()=>{
  const t = await getJson('/json');
  const page = t.find(x=>x.type==='page'&&/web\.whatsapp\.com/.test(x.url||''));
  if(!page){ console.log('sem pagina'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r)=>ws.addEventListener('open',r,{once:true}));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  const raw = await cdp.send('Runtime.evaluate',{ source:'1+1', returnByValue:true });
  console.log('RAW resposta =', JSON.stringify(raw).slice(0,500));
  console.log('1) sanity 1+1 =', val(await ev(cdp,'1+1',true)));
  console.log('2) WPP antes =', val(await ev(cdp,'!!window.WPP',true)));
  const wajs = fs.readFileSync(path.join(DIR,'vendor','wppconnect-wa.js'),'utf8');
  console.log('3) WA-JS eval exception =', exc(await ev(cdp, wajs)));
  console.log('4) WPP depois =', val(await ev(cdp,'!!window.WPP',true)));
  await ev(cdp,'window.__zvTest = 123;');
  console.log('5) persistencia global =', val(await ev(cdp,'window.__zvTest',true)));
  // painel real (com placeholders trocados)
  let panel = fs.readFileSync(path.join(DIR,'panel-inject.js'),'utf8');
  const lib = JSON.parse(fs.readFileSync(path.join(DIR,'library.json'),'utf8')).funnel.map(it=>({ stage:it.stage,label:it.label,desc:it.desc||'',kind:'audio',dataUri:'data:audio/ogg;base64,'+fs.readFileSync(path.join(DIR,it.file)).toString('base64'),durMs:3000 }));
  const css = fs.readFileSync(path.join(DIR,'panel.css'),'utf8');
  panel = panel.replace('"__LIBRARY__"', ()=>JSON.stringify(lib)).replace('"__CSS__"', ()=>JSON.stringify(css));
  console.log('6) tamanho do painel (MB) =', (panel.length/1048576).toFixed(2));
  var li = panel.indexOf('var LIB'); console.log('6b) var LIB vira ->', panel.slice(li, li+24).replace(/\n/g,' '));
  var ci = panel.indexOf('var CSS'); console.log('6c) var CSS vira ->', panel.slice(ci, ci+24).replace(/\n/g,' '));
  console.log('WPP.isReady =', val(await ev(cdp,'!!(window.WPP&&window.WPP.isReady)',true)));
  // teste de insercao de DOM simples (CSP?)
  console.log('DOM test =', val(await ev(cdp,'(function(){try{var d=document.createElement("div");d.id="zv-test";document.body.appendChild(d);return !!document.getElementById("zv-test");}catch(e){return "erro:"+e.message;}})()',true)));
  // captura erros assincronos
  await ev(cdp,'window.__zverr=[]; window.addEventListener("error",function(e){window.__zverr.push(""+(e.message||e.error))});');
  // reset limpo pra nao bater no guard de instalacao anterior
  await ev(cdp,'window.__zvInstalled=false; var o=document.getElementById("zv-panel"); if(o)o.remove(); var s=document.getElementById("zv-style"); if(s)s.remove();');
  console.log('7) painel eval exception =', exc(await ev(cdp, panel)));
  console.log('8) __zvInstalled =', val(await ev(cdp,'!!window.__zvInstalled',true)));
  await new Promise(r=>setTimeout(r,3500));
  console.log('9) painel no DOM (apos 3.5s) =', val(await ev(cdp,'!!document.getElementById("zv-panel")',true)));
  console.log('9b) botoes no painel =', val(await ev(cdp,'(document.querySelectorAll(".zv-item")||[]).length',true)));
  console.log('9c) contato ativo lido =', val(await ev(cdp,'(function(){try{var c=WPP.chat.getActiveChat();return c?((c.contact&&(c.contact.name||c.contact.pushname))||c.formattedTitle||(c.id&&c.id.user)||"sem nome"):"nenhum chat aberto";}catch(e){return "erro:"+e.message;}})()',true)));
  console.log('9d) erros assincronos =', val(await ev(cdp,'JSON.stringify(window.__zverr||[])',true)));
  console.log('9e) getActiveChat e funcao agora =', val(await ev(cdp,'!!(window.WPP&&WPP.chat&&typeof WPP.chat.getActiveChat==="function")',true)));
  console.log('10) WPP.chat.sendFileMessage existe =', val(await ev(cdp,'!!(window.WPP&&WPP.chat&&WPP.chat.sendFileMessage)',true)));
  process.exit(0);
})().catch(e=>{ console.log('erro diag:', e && e.message || e); process.exit(1); });
