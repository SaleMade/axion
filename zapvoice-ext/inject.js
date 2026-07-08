// ZapVoice Nosso — INJETOR pro app de desktop (WhatsApp da Windows Store = WebView2)
// Conecta na porta de debug do WebView2 (CDP), injeta o WA-JS + o painel DENTRO
// do app, na propria pagina web.whatsapp.com que o app carrega. O atendente
// continua ligando e conversando no app, e ganha o soundboard do funil por dentro.
//
// Requisitos: Node 21+ (WebSocket nativo) e o app aberto com --remote-debugging-port
// (o start.ps1 cuida disso). Uso: node inject.js
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.ZV_PORT ? Number(process.env.ZV_PORT) : 9222;
const MEDIA_PORT = process.env.ZV_MEDIA_PORT ? Number(process.env.ZV_MEDIA_PORT) : 9223;
const CONFIG_URL = process.env.ZV_CONFIG_URL || 'https://axion-api.axion-dash.workers.dev/api/salechat';
const MEDIA_BASE = CONFIG_URL.replace(/\/+$/, '') + '/media';
const DIR = __dirname;

// Baixa bytes de uma URL (mídia do R2 servida pelo Worker). Node não tem CSP.
function fetchBytes(url) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const r = https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fin(null); }
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => fin(Buffer.concat(chunks)));
      });
      r.on('error', () => fin(null));
      r.setTimeout(30000, () => { try { r.destroy(); } catch (_) {} fin(null); });
    } catch (_) { fin(null); }
  });
}

// Busca a config do Sale Chat na AXION (mensagens + funis que o Diretor edita
// na dash). Node nao tem CSP, entao busca aqui e injeta no painel. Falha -> null.
function fetchRemoteConfig() {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const r = https.get(CONFIG_URL, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { fin(JSON.parse(d)); } catch (_) { fin(null); } });
      });
      r.on('error', () => fin(null));
      r.setTimeout(6000, () => { try { r.destroy(); } catch (_) {} fin(null); });
    } catch (_) { fin(null); }
  });
}

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
async function buildLibrary(remote) {
  const lib = JSON.parse(fs.readFileSync(path.join(DIR, 'library.json'), 'utf8'));
  // Mensagens e funis: se a AXION mandou config, ela manda (o Diretor edita na dash);
  // senao, cai no library.json local.
  const rMsgs = remote && Array.isArray(remote.messages) && remote.messages.length ? remote.messages : (lib.messages || []);
  const messages = rMsgs.map((it) => ({ id: it.id, stage: it.stage || 'MSG', label: it.label, kind: 'text', text: it.text || '' }));
  const sequences = remote && Array.isArray(remote.sequences) && remote.sequences.length ? remote.sequences : (lib.sequences || []);
  const triggers = remote && Array.isArray(remote.triggers) ? remote.triggers : [];
  // Midia unificada (audio/video/imagem/documento). O painel agrupa por tipo.
  // Online: tudo vem da dash (R2) — funil campeao + midia do Diretor, editaveis.
  // Offline: cai no funil local (library.json) pra nao ficar sem soundboard.
  const media = [];
  const remoteMedia = remote && Array.isArray(remote.media) ? remote.media : [];
  if (remoteMedia.length) {
    for (const m of remoteMedia) {
      if (!m || !m.key) continue;
      const url = MEDIA_BASE + '/' + m.key;
      // video pesado: NAO embute; painel pede via __zvReq e injetor entrega base64 no clique.
      if (m.kind === 'video') { media.push({ id: m.id, kind: 'video', label: m.label || 'Video', caption: m.caption || '', mediaUrl: url }); continue; }
      const buf = await fetchBytes(url);
      if (!buf) continue;
      const dataUri = 'data:' + (m.mime || (m.kind === 'image' ? 'image/jpeg' : m.kind === 'document' ? 'application/pdf' : 'audio/ogg')) + ';base64,' + buf.toString('base64');
      if (m.kind === 'image') media.push({ id: m.id, kind: 'image', label: m.label || 'Imagem', caption: m.caption || '', dataUri });
      else if (m.kind === 'document') media.push({ id: m.id, kind: 'document', label: m.label || 'Documento', mime: m.mime || 'application/pdf', dataUri });
      else media.push({ id: m.id, kind: 'audio', label: m.label || 'Audio', dataUri, durMs: Math.min(7000, Math.max(1800, Math.round(buf.length / 1024) * 6)) });
    }
  } else {
    (lib.funnel || []).forEach((it) => {
      media.push({ id: it.id, stage: it.stage, kind: 'audio', label: it.label, desc: it.desc || '',
        dataUri: 'data:audio/ogg;base64,' + fs.readFileSync(path.join(DIR, it.file)).toString('base64'),
        durMs: Math.min(7000, Math.max(1800, (it.sizeKB || 300) * 6)) });
    });
    (lib.social || []).forEach((it) => {
      media.push({ id: it.id, stage: it.stage, kind: it.kind || 'video', label: it.label, caption: it.caption || '', file: String(it.file).replace(/\\/g, '/') });
    });
  }
  return { messages, sequences, media, triggers, funnel: [], social: [] };
}

let currentCfgStamp = 0; // updated_at da config ja aplicada no painel (pra detectar mudancas)
async function buildBundle() {
  const remote = await fetchRemoteConfig();
  if (remote && remote.updated_at) currentCfgStamp = remote.updated_at;
  if (remote && ((remote.messages && remote.messages.length) || (remote.sequences && remote.sequences.length))) console.log('[zv] Config carregada da AXION (mensagens/funis da dash).');
  else console.log('[zv] Sem config na AXION ainda; usando o funil local (library.json).');
  const wajs = fs.readFileSync(path.join(DIR, 'vendor', 'wppconnect-wa.js'), 'utf8');
  const css = fs.readFileSync(path.join(DIR, 'panel.css'), 'utf8');
  let panel = fs.readFileSync(path.join(DIR, 'panel-inject.js'), 'utf8');
  // replace por FUNCAO (imune a sequencias $ nos dados, ex: "R$497")
  const libJson = JSON.stringify(await buildLibrary(remote));
  panel = panel.replace('"__LIBRARY__"', () => libJson)
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
  const { wajs, panel } = await buildBundle();

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
            let dataUri;
            if (req.url) {
              const buf = await fetchBytes(req.url);
              if (!buf) throw new Error('nao consegui baixar o video da nuvem');
              dataUri = 'data:video/mp4;base64,' + buf.toString('base64');
            } else {
              const full = path.join(DIR, req.file || '');
              if (!full.startsWith(DIR) || !fs.existsSync(full)) throw new Error('arquivo nao encontrado: ' + req.file);
              dataUri = 'data:video/mp4;base64,' + fs.readFileSync(full).toString('base64');
            }
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

  // Bomba de PREVIA de video: o painel pede (window.__zvPrevReq) pra ver o video antes
  // de enviar; o injetor baixa da nuvem e devolve o base64 (window.__zvPrevRes). Nao envia.
  let lastPrevId = null;
  async function pumpPreview() {
    try {
      const raw = valOf(await evaluate('window.__zvPrevReq ? JSON.stringify(window.__zvPrevReq) : ""', true));
      if (raw) {
        let req = null; try { req = JSON.parse(raw); } catch (_) {}
        if (req && req.id !== lastPrevId) {
          lastPrevId = req.id;
          await evaluate('window.__zvPrevReq = null;');
          try {
            if (!req.url) throw new Error('sem url');
            const buf = await fetchBytes(req.url);
            if (!buf) throw new Error('nao consegui baixar');
            const dataUri = 'data:' + (req.mime || 'video/mp4') + ';base64,' + buf.toString('base64');
            await evaluate('window.__zvPrevRes = {id:' + JSON.stringify(req.id) + ',ok:true,dataUri:' + JSON.stringify(dataUri) + '}');
          } catch (e) {
            await evaluate('window.__zvPrevRes = {id:' + JSON.stringify(req.id) + ',ok:false,err:' + JSON.stringify(String(e.message || e)) + '}');
          }
        }
      }
    } catch (_) {}
    setTimeout(pumpPreview, 700);
  }
  pumpPreview();

  // Atualizacao ao vivo: checa a config da dash a cada 20s. Se o Diretor editou
  // (updated_at mudou), reconstroi a biblioteca e empurra pro painel (window.__zvUpdate),
  // sem precisar reabrir o WhatsApp nem rodar o start.bat de novo.
  async function pollConfig() {
    try {
      const remote = await fetchRemoteConfig();
      if (remote && remote.updated_at && remote.updated_at !== currentCfgStamp) {
        currentCfgStamp = remote.updated_at;
        const libJson = JSON.stringify(await buildLibrary(remote));
        await evaluate('window.__zvUpdate && window.__zvUpdate(' + libJson + ')');
        console.log('[zv] Config atualizada na dash; painel recarregado ao vivo.');
      }
    } catch (_) {}
    setTimeout(pollConfig, 20000);
  }
  setTimeout(pollConfig, 20000);

  cdp.onEvent = (m) => { if (m.method === 'Page.loadEventFired') setTimeout(injectNow, 1500); };
  ws.addEventListener('close', () => { console.log('[zv] Conexao caiu. Rode de novo (o app reiniciou?).'); process.exit(0); });
  console.log('[zv] Rodando. Deixe esta janela aberta. O painel esta dentro do WhatsApp.');
}

run().catch((e) => { console.log('[zv] Erro:', e && e.message || e); process.exit(1); });
