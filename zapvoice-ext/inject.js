// ZapVoice Nosso — INJETOR pro app de desktop (WhatsApp da Windows Store = WebView2)
// Conecta na porta de debug do WebView2 (CDP), injeta o WA-JS + o painel DENTRO
// do app, na propria pagina web.whatsapp.com que o app carrega. O atendente
// continua ligando e conversando no app, e ganha o soundboard do funil por dentro.
//
// Requisitos: Node 21+ (WebSocket nativo) e o app aberto com --remote-debugging-port
// (o start.ps1 cuida disso). Uso: node inject.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.ZV_PORT ? Number(process.env.ZV_PORT) : 9222;
const MEDIA_PORT = process.env.ZV_MEDIA_PORT ? Number(process.env.ZV_MEDIA_PORT) : 9223;
const DIR = __dirname;

function getJson(pathname) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

// Audios vao embutidos (base64, leves). Videos sao pesados: NAO embutimos nem
// servimos por HTTP (o WhatsApp bloqueia fetch a 127.0.0.1 por CSP/mixed-content).
// Em vez disso, o painel pede o video (window.__zvReq) e o injetor entrega o
// base64 via CDP na hora do clique, chamando window.__zvDoSend na pagina (WPP envia).
function buildLibrary() {
  const lib = JSON.parse(fs.readFileSync(path.join(DIR, 'library.json'), 'utf8'));
  const funnel = (lib.funnel || []).map((it) => ({
    id: it.id, stage: it.stage, label: it.label, desc: it.desc || '', kind: 'audio',
    dataUri: 'data:audio/ogg;base64,' + fs.readFileSync(path.join(DIR, it.file)).toString('base64'),
    durMs: Math.min(7000, Math.max(1800, (it.sizeKB || 300) * 6)),
  }));
  const social = (lib.social || []).map((it) => ({
    id: it.id, stage: it.stage, label: it.label, kind: it.kind || 'video', caption: it.caption || '',
    file: String(it.file).replace(/\\/g, '/'),
  }));
  const sequences = lib.sequences || [];
  return { funnel, social, sequences };
}

function buildBundle() {
  const wajs = fs.readFileSync(path.join(DIR, 'vendor', 'wppconnect-wa.js'), 'utf8');
  const css = fs.readFileSync(path.join(DIR, 'panel.css'), 'utf8');
  let panel = fs.readFileSync(path.join(DIR, 'panel-inject.js'), 'utf8');
  // replace por FUNCAO (imune a sequencias $ nos dados, ex: "R$497")
  panel = panel.replace('"__LIBRARY__"', () => JSON.stringify(buildLibrary()))
               .replace('"__CSS__"', () => JSON.stringify(css));
  return { wajs, panel };
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.cbs = {}; this.onEvent = null;
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id && this.cbs[m.id]) { this.cbs[m.id](m); delete this.cbs[m.id]; }
      else if (m.method && this.onEvent) this.onEvent(m);
    });
  }
  send(method, params) {
    return new Promise((res) => { const id = ++this.id; this.cbs[id] = res; this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
}

async function findPage() {
  const targets = await getJson('/json');
  return targets.find((t) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
}

async function run() {
  const page = await findPage();
  if (!page) { console.log('[zv] Nao achei a pagina do WhatsApp na porta ' + PORT + '. O app esta aberto com a porta de debug?'); process.exit(2); }
  console.log('[zv] Pagina encontrada:', page.title);
  const { wajs, panel } = buildBundle();

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Helper: Runtime.evaluate usa o campo "expression"; o resultado vem em result.result.value
  async function evaluate(expression, byValue) {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: !!byValue, awaitPromise: false });
    return r.result || {};
  }
  const valOf = (x) => (x.result ? x.result.value : undefined);

  // Re-injeta automaticamente em cada carregamento/reload da pagina (roda no document-start)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: wajs });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: panel });

  async function injectNow() {
    const hasWpp = valOf(await evaluate('!!window.WPP', true));
    if (!hasWpp) await evaluate(wajs);
    await evaluate(panel);
    const ok = valOf(await evaluate('!!window.__zvInstalled', true));
    console.log('[zv] Painel injetado:', ok === true);
  }
  await injectNow();

  // Bomba de video: o painel pede (window.__zvReq), o injetor le o arquivo e
  // entrega o base64 na pagina chamando window.__zvDoSend (WPP envia). Evita
  // fetch bloqueado por CSP e nao embute video pesado na injecao inicial.
  let lastReqId = null;
  async function pumpVideo() {
    try {
      const raw = valOf(await evaluate('window.__zvReq ? JSON.stringify(window.__zvReq) : ""', true));
      if (raw) {
        let req = null; try { req = JSON.parse(raw); } catch (_) {}
        if (req && req.id !== lastReqId) {
          lastReqId = req.id;
          await evaluate('window.__zvReq = null;');
          try {
            const full = path.join(DIR, req.file || '');
            if (!full.startsWith(DIR) || !fs.existsSync(full)) throw new Error('arquivo nao encontrado: ' + req.file);
            const dataUri = 'data:video/mp4;base64,' + fs.readFileSync(full).toString('base64');
            await evaluate('window.__zvDoSend(' + JSON.stringify(dataUri) + ',' + JSON.stringify(req.caption || '') + ',' + JSON.stringify(req.id) + ')');
          } catch (e) {
            await evaluate('window.__zvRes = {id:' + JSON.stringify(req.id) + ',ok:false,err:' + JSON.stringify(String(e.message || e)) + '}');
          }
        }
      }
    } catch (_) {}
    setTimeout(pumpVideo, 700);
  }
  pumpVideo();

  cdp.onEvent = (m) => { if (m.method === 'Page.loadEventFired') setTimeout(injectNow, 1500); };
  ws.addEventListener('close', () => { console.log('[zv] Conexao caiu. Rode de novo (o app reiniciou?).'); process.exit(0); });
  console.log('[zv] Rodando. Deixe esta janela aberta. O painel esta dentro do WhatsApp.');
}

run().catch((e) => { console.log('[zv] Erro:', e && e.message || e); process.exit(1); });
