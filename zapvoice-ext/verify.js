'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = __dirname, MEDIA_PORT = 9223;
function buildLibrary() {
  const lib = JSON.parse(fs.readFileSync(path.join(DIR, 'library.json'), 'utf8'));
  const funnel = (lib.funnel || []).map(it => ({ stage: it.stage, label: it.label, desc: it.desc || '', kind: 'audio', dataUri: 'data:audio/ogg;base64,' + fs.readFileSync(path.join(DIR, it.file)).toString('base64'), durMs: Math.min(7000, Math.max(1800, (it.sizeKB || 300) * 6)) }));
  const social = (lib.social || []).map(it => ({ stage: it.stage, label: it.label, kind: it.kind || 'video', caption: it.caption || '', url: 'http://127.0.0.1:' + MEDIA_PORT + '/' + String(it.file).replace(/\\/g, '/') }));
  return { funnel, social };
}
let panel = fs.readFileSync(path.join(DIR, 'panel-inject.js'), 'utf8');
panel = panel.replace('"__LIBRARY__"', () => JSON.stringify(buildLibrary())).replace('"__CSS__"', () => JSON.stringify(fs.readFileSync(path.join(DIR, 'panel.css'), 'utf8')));
function j(p) { return new Promise((r, x) => http.get({ host: '127.0.0.1', port: 9222, path: p }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => r(JSON.parse(d))); }).on('error', x)); }
(async () => {
  const t = await j('/json'); const pg = t.find(x => x.type === 'page' && /web.whatsapp.com/.test(x.url));
  const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0, cb = {}; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (cb[m.id]) { cb[m.id](m); delete cb[m.id]; } });
  const ev = (ex, bv) => new Promise(r => { const i = ++id; cb[i] = r; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, returnByValue: !!bv } })); });
  const val = async (ex) => { const m = await ev(ex, true); return m.result && m.result.result ? m.result.result.value : undefined; };
  await ev('window.__zvInstalled=false;var o=document.getElementById("zv-panel");if(o)o.remove();var s=document.getElementById("zv-style");if(s)s.remove();');
  const r = await ev(panel);
  console.log('inject exc =', r.result && r.result.exceptionDetails ? JSON.stringify(r.result.exceptionDetails).slice(0, 300) : 'nenhuma');
  await new Promise(r => setTimeout(r, 3500));
  console.log('titulo =', await val('(document.getElementById("zv-title")||{}).textContent'));
  console.log('botoes =', await val('document.querySelectorAll(".zv-item").length'));
  console.log('secoes =', await val('Array.from(document.querySelectorAll(".zv-h")).map(x=>x.textContent).join(" | ")'));
  console.log('cursor header =', await val('(getComputedStyle(document.getElementById("zv-head"))||{}).cursor'));
  console.log('labels =', await val('Array.from(document.querySelectorAll(".zv-label")).map(x=>x.textContent).join(", ")'));
  process.exit(0);
})().catch(e => { console.log('err', e.message); process.exit(1); });
