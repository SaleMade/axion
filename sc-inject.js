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
const BASE_URL = process.env.ZV_CONFIG_URL || 'https://axion-api.axion-dash.workers.dev/api/salechat';
// Perfil: vendedores (padrao) ou cobradores. Vem de perfil.txt na pasta (o instalador
// de cobradores traz esse arquivo) ou da env ZV_PERFIL. Cada perfil tem config propria.
let PERFIL = (process.env.ZV_PERFIL || '').trim().toLowerCase();
if (!PERFIL) { try { PERFIL = require('fs').readFileSync(require('path').join(__dirname, 'perfil.txt'), 'utf8').trim().toLowerCase(); } catch (_) {} }
if (PERFIL !== 'cobradores') PERFIL = 'vendedores';
const CONFIG_URL = PERFIL === 'cobradores' ? (BASE_URL + '?perfil=cobradores') : BASE_URL;
const MEDIA_BASE = BASE_URL.replace(/\/+$/, '') + '/media';
const DIR = __dirname;
// Token do Sale Chat Engine (captura) — env ZV_INGEST_TOKEN ou arquivo ingest-token.txt na pasta
// (o Diretor pega em GET /api/salechat/health e salva aqui). Sem token, a captura fica so no console.
let INGEST_TOKEN = (process.env.ZV_INGEST_TOKEN || '').trim();
if (!INGEST_TOKEN) { try { INGEST_TOKEN = fs.readFileSync(path.join(DIR, 'ingest-token.txt'), 'utf8').trim(); } catch (_) {} }

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

// POST JSON simples (Node, sem CSP). Usado pela captura do Sale Chat Engine.
function httpPostJson(url, obj) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const payload = Buffer.from(JSON.stringify(obj || {}), 'utf8');
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length }
      }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { fin(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { fin(null); } });
      });
      req.on('error', () => fin(null));
      req.setTimeout(15000, () => { try { req.destroy(); } catch (_) {} fin(null); });
      req.write(payload); req.end();
    } catch (_) { fin(null); }
  });
}

// ── Cache de midia em DISCO ────────────────────────────────────────────────────────────
// O video e pesado e, ate agora, era rebaixado da nuvem A CADA disparo — por isso demorava
// tanto. Agora ele fica salvo na maquina do atendente (pasta "cache") e o envio le do disco.
// O download acontece 1x, no start (prefetch), entao ate o primeiro envio ja sai rapido.
const CACHE_DIR = path.join(DIR, 'cache');
// Se nao der pra gravar (pasta protegida, antivirus, Controlled Folder Access, disco cheio), o
// envio continua funcionando (baixa da nuvem) — mas AVISA, em vez de falhar calado e rebaixar
// tudo pra sempre achando que esta cacheando.
let cacheOk = true, cacheWarned = false;
function cacheOff(e, ctx) {
  cacheOk = false;
  if (cacheWarned) return;
  cacheWarned = true;
  console.log('[zv] AVISO: nao consigo gravar o cache de video em ' + CACHE_DIR + ' (' + ctx + ': ' + ((e && e.code) || e) + ').');
  console.log('[zv]        O video vai ser baixado da nuvem a CADA envio (lento). Cheque permissao da pasta, antivirus e espaco em disco.');
}
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const probe = path.join(CACHE_DIR, '.probe');
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);   // pega pasta somente-leitura ja no start
} catch (e) { cacheOff(e, 'mkdir'); }
function cacheName(url) {
  // nome legivel + hash da url (a chave do R2 e unica por upload, entao trocar o video na
  // dash gera uma chave nova e, com ela, um arquivo novo — nao tem cache velho grudado).
  const base = String(url).split('/').pop().split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_').slice(-40);
  return hashStr(String(url)) + '_' + (base || 'f');
}
function cachePath(url) { return path.join(CACHE_DIR, cacheName(url)); }
const inflight = new Map();
// Bytes da midia: DISCO primeiro; se nao tiver, baixa 1x e salva. A escrita e atomica (.tmp +
// rename) pra um download interrompido (PC desligou no meio) nao deixar um video corrompido
// no cache pra sempre. Dois pedidos da mesma url ao mesmo tempo compartilham o mesmo download.
async function mediaBytes(url) {
  if (!url) return null;
  const p = cachePath(url);
  try {
    if (fs.existsSync(p)) {
      const b = fs.readFileSync(p);
      // Arquivo zerado no inicio = vitima de queda de energia (o NTFS grava o nome antes dos
      // dados). Sem esta checagem, um video corrompido seria servido pra SEMPRE. Joga fora e rebaixa.
      const bom = b && b.length > 1024 && !b.subarray(0, 64).every((x) => x === 0);
      if (bom) return b;
      if (b) { console.log('[zv] Cache corrompido, baixando de novo: ' + path.basename(p)); try { fs.unlinkSync(p); } catch (_) {} }
    }
  } catch (_) {}
  if (inflight.has(p)) return inflight.get(p);
  const job = (async () => {
    const buf = await fetchBytes(url);
    if (buf && buf.length && cacheOk) {
      const tmp = p + '.' + process.pid + '.tmp';
      try {
        fs.writeFileSync(tmp, buf);
        // fsync ANTES do rename: o NTFS journala o METADADO, nao o dado. Sem isto, uma queda de
        // energia logo apos o rename deixa um arquivo do tamanho certo com o conteudo zerado.
        const fd = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, p);
      } catch (e) { cacheOff(e, 'gravar'); try { fs.unlinkSync(tmp); } catch (_) {} }
    }
    return buf;   // mesmo se o cache falhar, o envio segue (so nao fica rapido)
  })();
  inflight.set(p, job);
  try { return await job; } finally { inflight.delete(p); }
}
// Baixa os videos que ainda nao estao no PC, em segundo plano, sem travar nada.
let prefetching = false, prefetchPending = null;
async function prefetchMedia(list) {
  if (!cacheOk) return;                       // sem cache, prefetch e so queimar banda
  if (prefetching) { prefetchPending = list; return; }   // guarda a lista NOVA pra rodar depois
  prefetching = true;
  try {
    const vids = (list || []).filter((m) => m && m.kind === 'video' && m.key && !fs.existsSync(cachePath(MEDIA_BASE + '/' + m.key)));
    if (vids.length) console.log('[zv] Salvando ' + vids.length + ' video(s) no PC...');
    for (const m of vids) {
      if (!cacheOk) { console.log('[zv]   prefetch abortado: cache indisponivel.'); break; }
      const url = MEDIA_BASE + '/' + m.key;
      const buf = await mediaBytes(url);
      // so diz "ok" se REALMENTE gravou (senao o log mentiria quando o cache esta morto)
      if (buf && fs.existsSync(cachePath(url))) console.log('[zv]   ok: ' + (m.label || m.key) + ' (' + Math.round(buf.length / 104857.6) / 10 + ' MB)');
      else console.log('[zv]   nao salvou (tenta de novo depois): ' + (m.label || m.key));
    }
  } catch (_) {} finally {
    prefetching = false;
    // A config mudou no meio do prefetch? Roda de novo com a lista nova, senao os videos
    // novos nunca iriam pro disco (ficariam lentos pra sempre).
    const next = prefetchPending; prefetchPending = null;
    if (next) setTimeout(() => prefetchMedia(next), 0);
  }
}
// Apaga do cache o que nao esta mais na biblioteca (video trocado na dash), pra nao encher o
// disco. So roda se a config veio de verdade — senao apagaria tudo num erro de rede.
function cleanCache(list) {
  try {
    if (!list || !list.length) return;
    const keep = new Set(list.filter((m) => m && m.key).map((m) => cacheName(MEDIA_BASE + '/' + m.key)));
    for (const m of list) { if (m && m.posterKey) keep.add(cacheName(MEDIA_BASE + '/' + m.posterKey)); }
    const STALE = 10 * 60 * 1000;   // .tmp so e lixo se for VELHO
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      if (f.endsWith('.tmp')) {
        // Nao apagar o .tmp de um download EM ANDAMENTO (o outro app — normal x beta — divide
        // esta pasta). So limpa o orfao, de quando o PC desligou no meio.
        try { if (Date.now() - fs.statSync(fp).mtimeMs < STALE) continue; } catch (_) {}
        try { fs.unlinkSync(fp); } catch (_) {}
        continue;
      }
      if (!keep.has(f)) { try { fs.unlinkSync(fp); } catch (_) {} }
    }
  } catch (_) {}
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

// ─── Auto-update do painel: puxa o codigo do painel/css do servidor (com fallback pro disco) ──
// Assim, quando o Diretor publica uma melhoria no painel, ela entra sozinha na maquina do
// atendente (sem rebaixar). A dash serve os arquivos em /sc-panel.js e /sc-panel.css.
const DASH_URL = (process.env.ZV_DASH_URL || 'https://axion.axion-dash.workers.dev').replace(/\/+$/, '');
const PANEL_JS_URL = DASH_URL + '/sc-panel.js';
const PANEL_CSS_URL = DASH_URL + '/sc-panel.css';
function fetchText(url) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const r = https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fin(null); }
        let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => fin(d));
      });
      r.on('error', () => fin(null));
      r.setTimeout(8000, () => { try { r.destroy(); } catch (_) {} fin(null); });
    } catch (_) { fin(null); }
  });
}
// Puxa painel+css do servidor. Valida que veio CODIGO do painel (nao o HTML da dash, que
// o worker devolve como fallback de rota nao encontrada). Falha/HTML -> null (usa o disco).
async function fetchPanelAssets() {
  const [pj, pcss] = await Promise.all([fetchText(PANEL_JS_URL), fetchText(PANEL_CSS_URL)]);
  if (!pj || pj.indexOf('__zvInstalled') < 0 || pj.indexOf('"__LIBRARY__"') < 0 || pj.indexOf('"__CSS__"') < 0) return null;
  if (!pcss || pcss.indexOf('#zv-') < 0) return null;
  return { panelRaw: pj, css: pcss };
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return String(h >>> 0); }
let currentPanelHash = '';   // hash do painel que esta RODANDO na pagina
let builtPanelHash = '';     // hash do painel que o buildBundle acabou de baixar (ainda nao aplicado)

function getJson(pathname) {
  return new Promise((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (rr) => {
      let d = ''; rr.on('data', (c) => (d += c)); rr.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
    // Sem timeout, uma conexao meia-aberta (browser em estado ruim) penduraria o watchdog
    // pra sempre e o deadline de 60s do acquirePage nunca seria reavaliado.
    r.setTimeout(5000, () => { try { r.destroy(); } catch (_) {} rej(new Error('timeout')); });
  });
}

// Corre uma promise contra um timeout; se estourar, rejeita (nao trava o loop de recuperacao).
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
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
  const messages = rMsgs.map((it) => ({ id: it.id, stage: it.stage || 'MSG', label: it.label, kind: 'text', text: it.text || '', grp: it.grp || '' }));
  const sequences = remote && Array.isArray(remote.sequences) && remote.sequences.length ? remote.sequences : (lib.sequences || []);
  const triggers = remote && Array.isArray(remote.triggers) ? remote.triggers : [];
  // Midia unificada (audio/video/imagem/documento). O painel agrupa por tipo.
  // Online: tudo vem da dash (R2) — funil campeao + midia do Diretor, editaveis.
  // Offline: cai no funil local (library.json) pra nao ficar sem soundboard.
  const media = [];
  const remoteMedia = remote && Array.isArray(remote.media) ? remote.media : [];
  // Deixa os videos prontos no PC (em segundo plano) e limpa o que saiu da biblioteca.
  // Assim o clique em "enviar" le do disco, em vez de baixar da nuvem na hora.
  if (remoteMedia.length) { cleanCache(remoteMedia); prefetchMedia(remoteMedia); }
  if (remoteMedia.length) {
    for (const m of remoteMedia) {
      if (!m || !m.key) continue;
      const url = MEDIA_BASE + '/' + m.key;
      // video pesado: NAO embute; painel pede via __zvReq e injetor entrega base64 no clique.
      if (m.kind === 'video') {
        var vit = { id: m.id, kind: 'video', label: m.label || 'Video', caption: m.caption || '', mediaUrl: url, grp: m.grp || '' };
        if (m.posterKey) { const pbuf = await mediaBytes(MEDIA_BASE + '/' + m.posterKey); if (pbuf) vit.posterUri = 'data:image/jpeg;base64,' + pbuf.toString('base64'); }
        media.push(vit); continue;
      }
      const buf = await mediaBytes(url);
      if (!buf) continue;
      const dataUri = 'data:' + (m.mime || (m.kind === 'image' ? 'image/jpeg' : m.kind === 'document' ? 'application/pdf' : 'audio/ogg')) + ';base64,' + buf.toString('base64');
      if (m.kind === 'image') media.push({ id: m.id, kind: 'image', label: m.label || 'Imagem', caption: m.caption || '', dataUri, grp: m.grp || '' });
      else if (m.kind === 'document') media.push({ id: m.id, kind: 'document', label: m.label || 'Documento', mime: m.mime || 'application/pdf', dataUri, grp: m.grp || '' });
      else media.push({ id: m.id, kind: 'audio', label: m.label || 'Audio', dataUri, durMs: Math.min(7000, Math.max(1800, Math.round(buf.length / 1024) * 6)), grp: m.grp || '' });
    }
  } else {
    // Fallback offline (sem config na nuvem). O instalador do vendedor nao traz esses
    // arquivos pesados; se faltarem, ignora (online ele pega o funil real do R2).
    (lib.funnel || []).forEach((it) => {
      try {
        media.push({ id: it.id, stage: it.stage, kind: 'audio', label: it.label, desc: it.desc || '',
          dataUri: 'data:audio/ogg;base64,' + fs.readFileSync(path.join(DIR, it.file)).toString('base64'),
          durMs: Math.min(7000, Math.max(1800, (it.sizeKB || 300) * 6)) });
      } catch (_) {}
    });
    (lib.social || []).forEach((it) => {
      try { if (fs.existsSync(path.join(DIR, it.file))) media.push({ id: it.id, stage: it.stage, kind: it.kind || 'video', label: it.label, caption: it.caption || '', file: String(it.file).replace(/\\/g, '/') }); } catch (_) {}
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
  // Painel + css: tenta do servidor (auto-update, sem rebaixar). Se nao vier, usa o do disco.
  let css, panelRaw, src = 'disco';
  const rp = await fetchPanelAssets();
  if (rp) { panelRaw = rp.panelRaw; css = rp.css; src = 'servidor'; }
  else { panelRaw = fs.readFileSync(path.join(DIR, 'panel-inject.js'), 'utf8'); css = fs.readFileSync(path.join(DIR, 'panel.css'), 'utf8'); }
  builtPanelHash = hashStr(panelRaw + '|' + css);   // baixado; so vira 'currentPanelHash' quando REALMENTE rodar
  console.log('[zv] Painel carregado do ' + src + '.');
  // replace por FUNCAO (imune a sequencias $ nos dados, ex: "R$497")
  const libJson = JSON.stringify(await buildLibrary(remote));
  const panel = panelRaw.replace('"__LIBRARY__"', () => libJson)
               .replace('"__CSS__"', () => JSON.stringify(css));
  return { wajs, panel, libJson };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  try { const t = await getJson('/json'); return Array.isArray(t) ? t : []; }
  catch (_) { return []; }
}
function isWhatsAppPage(t) { return t && t.type === 'page' && /web\.whatsapp\.com/i.test(t.url || ''); }
// Pagina do PROPRIO WhatsApp travada na tela de erro/cacto. So consideramos "cacto do
// WhatsApp" quando o TITULO menciona whatsapp — uma URL chrome-error:// sozinha NAO prova
// identidade nenhuma (poderia ser a pagina de erro de outro app WebView2 na mesma porta,
// e a gente acabaria sequestrando o app errado ao navegar pra web.whatsapp.com).
function isCrashedWhatsApp(t) {
  if (!t || t.type !== 'page') return false;
  const u = (t.url || '').toLowerCase(), ti = (t.title || '').toLowerCase();
  if (u.indexOf('web.whatsapp.com') >= 0) return false; // ja carregou; nunca recarregar por engano
  return ti.indexOf('whatsapp') >= 0;
}

// Recupera o WhatsApp quando ele abre na tela de erro (cacto): navega o proprio alvo de
// volta pra web.whatsapp.com via CDP, sem o usuario clicar em nada. Tudo com timeout: um
// renderer travado pode aceitar o WebSocket e nunca responder, o que penduraria o loop.
async function reloadCrashed(t) {
  let ws2 = null;
  try {
    await withTimeout((async () => {
      ws2 = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws2.addEventListener('open', res, { once: true }); ws2.addEventListener('error', rej, { once: true }); });
      const c2 = new CDP(ws2);
      await c2.send('Page.enable');
      await c2.send('Page.navigate', { url: 'https://web.whatsapp.com/' });
    })(), 5000);
    return true;
  } catch (_) { return false; }
  finally { try { if (ws2) ws2.close(); } catch (_) {} }
}

// Procura a pagina do WhatsApp com paciencia (ate ~60s). O app da Store demora pra
// carregar web.whatsapp.com; e se ele abrir na tela de erro (cacto), a gente manda
// recarregar sozinho. So desiste depois de tentar de verdade — nada de loop de 3s.
async function acquirePage() {
  const deadline = Date.now() + 60000;
  let saidBooting = false, saidBusy = false, tries = 0;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const wa = targets.find(isWhatsAppPage);
    if (wa && wa.webSocketDebuggerUrl) return wa;
    // Achou o WhatsApp, mas sem porta de debug livre: outra sessao (outra janela preta do
    // Sale Chat, ou DevTools) ja esta conectada. Nao mexe; avisa uma vez e espera liberar.
    if (wa && !wa.webSocketDebuggerUrl) {
      if (!saidBusy) { saidBusy = true; console.log('[zv] O WhatsApp ja tem uma sessao do Sale Chat conectada. Feche as OUTRAS janelas pretas e deixe so uma aberta.'); }
      await sleep(3000); tries++; continue;
    }
    const crashed = targets.find(isCrashedWhatsApp);
    if (crashed && crashed.webSocketDebuggerUrl && (tries % 6) === 0) {
      console.log('[zv] WhatsApp esta numa tela de erro; mandando recarregar sozinho...');
      await reloadCrashed(crashed);
    } else if (!saidBooting) {
      saidBooting = true;
      const seen = targets.filter((t) => t.type === 'page').map((t) => t.url || '(sem url)');
      console.log('[zv] Porta ' + PORT + ' respondeu; esperando o WhatsApp carregar...' + (seen.length ? ' (paginas: ' + seen.join(' | ') + ')' : ' (nenhuma pagina ainda)'));
    }
    tries++;
    await sleep(1500);
  }
  return null;
}

async function run() {
  const page = await acquirePage();
  if (!page) {
    console.log('[zv] Nao achei o WhatsApp na porta ' + PORT + ' depois de 1 min.');
    console.log('[zv] Feche o WhatsApp POR COMPLETO (inclusive o icone perto do relogio) e rode o start de novo.');
    process.exit(2);
  }
  console.log('[zv] Pagina encontrada:', page.title);
  const _bundle = await buildBundle();
  const wajs = _bundle.wajs;
  let panel = _bundle.panel;
  let panelScriptId = null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Helper: Runtime.evaluate usa o campo "expression"; o resultado vem em result.result.value.
  // Se o script lancar (ex: o WA-JS quebrar contra um build novo do WhatsApp), o CDP devolve
  // exceptionDetails — antes a gente jogava fora e a falha ficava 100% invisivel.
  async function evaluate(expression, byValue, what) {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: !!byValue, awaitPromise: false });
    const ex = r && r.exceptionDetails;
    if (ex) {
      const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'erro desconhecido';
      console.log('[zv] ERRO ao injetar' + (what ? ' (' + what + ')' : '') + ':', String(msg).split('\n')[0]);
    }
    return r.result || {};
  }
  const valOf = (x) => (x.result ? x.result.value : undefined);

  // Re-injeta automaticamente em cada carregamento/reload da pagina (roda no document-start)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: wajs });
  { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: panel }); panelScriptId = r && r.result && r.result.identifier; }

  // O motor esta REALMENTE vivo? window.WPP existir nao basta: o bundle define self.WPP no fim
  // mesmo se todos os module finders quebrarem. O sinal honesto e o ChatStore ter resolvido.
  const WPP_ALIVE = '!!(window.WPP && window.WPP.chat && typeof window.WPP.chat.sendTextMessage==="function" && window.WPP.whatsapp && window.WPP.whatsapp.ChatStore)';
  async function injectNow() {
    const hasWpp = valOf(await evaluate('!!window.WPP', true));
    if (!hasWpp) await evaluate(wajs, false, 'WA-JS');
    await evaluate(panel, false, 'painel');
    currentPanelHash = builtPanelHash;   // agora sim: o que esta rodando na pagina
    const ok = valOf(await evaluate('!!window.__zvInstalled', true));
    console.log('[zv] Painel injetado:', ok === true);
    // Da uns segundos pro WA-JS engatar nos modulos da pagina antes de julgar.
    let alive = false;
    for (let i = 0; i < 20; i++) {
      alive = valOf(await evaluate(WPP_ALIVE, true)) === true;
      if (alive) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (alive) console.log('[zv] Motor do WhatsApp (WA-JS) OK.');
    else console.log('[zv] ATENCAO: o motor do WhatsApp (WA-JS) NAO carregou nesta versao do app.\n' +
                     '     O painel abre, mas nao consegue enviar. Se voce esta no WhatsApp BETA, use o WhatsApp normal.');
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
              const buf = await mediaBytes(req.url);   // disco primeiro (instantaneo)
              if (!buf) throw new Error('nao consegui baixar o video da nuvem');
              dataUri = 'data:video/mp4;base64,' + buf.toString('base64');
            } else {
              const full = path.join(DIR, req.file || '');
              if (!full.startsWith(DIR) || !fs.existsSync(full)) throw new Error('arquivo nao encontrado: ' + req.file);
              dataUri = 'data:video/mp4;base64,' + fs.readFileSync(full).toString('base64');
            }
            // Devolve tambem o chatId que veio NO PEDIDO (alvo travado no clique). Se o painel se
            // auto-atualizar durante o download, ele perde o alvo da memoria; este aqui o salva.
            await evaluate('window.__zvDoSend(' + JSON.stringify(dataUri) + ',' + JSON.stringify(req.caption || '') + ',' + JSON.stringify(req.id) + ',' + JSON.stringify(req.chatId || '') + ')');
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
            const buf = await mediaBytes(req.url);   // disco primeiro (instantaneo)
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

  // ─── Sale Chat Engine: bomba de CAPTURA (Fase 1) ──────────────────────────
  // Drena window.__zvOutbox (o painel enfileira) e manda pro worker (auditoria crua).
  // ack-based: so remove da fila o msg_id que o servidor confirmou. Sem token nao faz nada
  // (a captura ainda funciona no console via __zvOutboxDump()).
  const INGEST_BASE = BASE_URL.replace(/\/+$/, '');
  // Modo teste: pega o token de captura do proprio config publico (sem precisar de arquivo na maquina).
  try { const cfg0 = await fetchRemoteConfig(); if (cfg0 && cfg0.ingest_token && !INGEST_TOKEN) INGEST_TOKEN = String(cfg0.ingest_token); } catch (_) {}
  async function pumpOutbox() {
    try {
      if (INGEST_TOKEN) {
        try { await evaluate('window.__zvIngestOn=true;'); } catch (_) {}
        const raw = valOf(await evaluate('window.__zvOutbox ? JSON.stringify(window.__zvOutbox.slice(0,50)) : "[]"', true));
        let batch = []; try { batch = JSON.parse(raw || '[]'); } catch (_) {}
        if (batch.length) {
          const res = await httpPostJson(INGEST_BASE + '/ingest/' + encodeURIComponent(INGEST_TOKEN), { events: batch });
          if (res && res.ok && Array.isArray(res.ack)) {
            if (res.ack.length) {
              // remove SO o confirmado (nunca splice cego) e conta os enviados pro painel de teste
              await evaluate('(function(a){try{var s={};for(var i=0;i<a.length;i++)s[a[i]]=1;window.__zvOutbox=(window.__zvOutbox||[]).filter(function(e){return !s[e.msgId];});window.__zvSentCount=(window.__zvSentCount||0)+a.length;}catch(_){}})(' + JSON.stringify(res.ack) + ')');
            }
            try { await evaluate('window.__zvIngestOk=true;'); } catch (_) {}
          } else { try { await evaluate('window.__zvIngestOk=false;'); } catch (_) {} }
        }
      }
    } catch (_) { try { await evaluate('window.__zvIngestOk=false;'); } catch (_) {} }
    setTimeout(pumpOutbox, 1500);
  }
  pumpOutbox();

  // heartbeat: avisa que o numero esta vivo/logado a cada 30s (a dash sabe quem esta on).
  async function pumpHeartbeat() {
    try {
      if (INGEST_TOKEN) {
        const self = valOf(await evaluate('(window.__zvGetSelfNumber && window.__zvGetSelfNumber()) || ""', true));
        if (self) {
          const wppSeen = valOf(await evaluate('(window.WPP && window.WPP.on) ? 1 : 0', true));
          await httpPostJson(INGEST_BASE + '/heartbeat/' + encodeURIComponent(INGEST_TOKEN), { selfNumber: String(self), wppSeen: Number(wppSeen) || 0 });
        }
      }
    } catch (_) {}
    setTimeout(pumpHeartbeat, 30000);
  }
  setTimeout(pumpHeartbeat, 10000);

  // Atualizacao ao vivo: checa a config da dash a cada 20s. Se o Diretor editou
  // (updated_at mudou), reconstroi a biblioteca e empurra pro painel (window.__zvUpdate),
  // sem precisar reabrir o WhatsApp nem rodar o start.bat de novo.
  async function pollConfig() {
    try {
      const remote = await fetchRemoteConfig();
      if (remote && remote.ingest_token && !INGEST_TOKEN) INGEST_TOKEN = String(remote.ingest_token);
      if (remote && remote.updated_at && remote.updated_at !== currentCfgStamp) {
        // Reconstroi o BUNDLE (nao so a lib) e RE-REGISTRA o script de novo documento.
        // Sem isso, o painel injetado num reload da pagina volta com a biblioteca ANTIGA:
        // se o Diretor trocou o video, o atendente dispararia o video VELHO pro lead.
        const rebuilt = await buildBundle();   // ja atualiza currentCfgStamp
        if (rebuilt && rebuilt.panel && rebuilt.panel.indexOf('__zvInstalled') >= 0) {
          panel = rebuilt.panel;
          try { if (panelScriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: panelScriptId }); } catch (_) {}
          { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: panel }); panelScriptId = r && r.result && r.result.identifier; }
          await evaluate('window.__zvUpdate && window.__zvUpdate(' + rebuilt.libJson + ')');
          console.log('[zv] Config atualizada na dash; painel recarregado ao vivo.');
        }
      }
    } catch (_) {}
    setTimeout(pollConfig, 20000);
  }
  setTimeout(pollConfig, 20000);

  // Auto-update do PAINEL: a cada 60s checa se o codigo do painel mudou no servidor. Se mudou,
  // reconstroi o bundle e re-injeta ao vivo (o painel se limpa e sobe a versao nova). O
  // atendente ganha as melhorias sem rebaixar nada. Falha/offline -> mantem o painel atual.
  async function pollPanel() {
    try {
      // NAO re-injetar no meio de um envio: reinjetar o painel zera a fila, e o envio continua
      // entregando mas SOME do banner (era o bug do "disparei e nao apareceu na pilha").
      // Se estiver ocupado, espera a proxima rodada.
      const busy = valOf(await evaluate('!!(window.__zvBusy && window.__zvBusy())', true)) === true;
      if (busy) { setTimeout(pollPanel, 60000); return; }
      const rp = await fetchPanelAssets();
      if (rp) {
        const h = hashStr(rp.panelRaw + '|' + rp.css);
        if (currentPanelHash && h !== currentPanelHash) {
          const rebuilt = await buildBundle();   // baixa a versao nova (demora: rede + midia)
          const okNew = rebuilt && rebuilt.panel && rebuilt.panel.indexOf('__zvInstalled') >= 0;
          if (okNew) {
            // RECHECA o "ocupado" agora: baixar o bundle leva tempo e o atendente pode ter
            // disparado um envio nesse meio-tempo. Sem isto, a fila seria zerada mesmo assim.
            const busy2 = valOf(await evaluate('!!(window.__zvBusy && window.__zvBusy())', true)) === true;
            if (busy2) { setTimeout(pollPanel, 60000); return; }
            panel = rebuilt.panel;
            try { if (panelScriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: panelScriptId }); } catch (_) {}
            { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: panel }); panelScriptId = r && r.result && r.result.identifier; }
            await evaluate(panel);
            currentPanelHash = builtPanelHash;   // so AGORA o painel novo esta rodando de fato
            console.log('[zv] Painel atualizado sozinho (nova versao do servidor).');
          }
        }
      }
    } catch (_) {}
    setTimeout(pollPanel, 60000);
  }
  setTimeout(pollPanel, 60000);

  cdp.onEvent = (m) => { if (m.method === 'Page.loadEventFired') setTimeout(injectNow, 1500); };
  ws.addEventListener('close', () => { console.log('[zv] Conexao caiu. Rode de novo (o app reiniciou?).'); process.exit(0); });
  console.log('[zv] Rodando. Deixe esta janela aberta. O painel esta dentro do WhatsApp.');
}

run().catch((e) => { console.log('[zv] Erro:', e && e.message || e); process.exit(1); });
