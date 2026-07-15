// Sale Chat — painel injetado DENTRO do app (roda na pagina web.whatsapp.com).
// O marcador de DADOS (linha do var DATA) e o de CSS sao trocados pelo inject.js.
// Roda no mesmo contexto do WA-JS: chama window.WPP direto.
(function () {
  'use strict';
  // Re-injecao: limpa a versao anterior (painel + estilo + timers) pra SEMPRE subir a
  // versao nova, mesmo sem recarregar o WhatsApp. Antes um marcador antigo travava a
  // atualizacao e o painel velho continuava na tela ao reabrir o start.bat.
  try {
    var _op = document.getElementById('zv-panel'); if (_op && _op.parentNode) _op.parentNode.removeChild(_op);
    var _os = document.getElementById('zv-style'); if (_os && _os.parentNode) _os.parentNode.removeChild(_os);
    if (window.__zvSchedIv) { clearInterval(window.__zvSchedIv); window.__zvSchedIv = null; }
    if (window.__zvAutoRecIv) { clearInterval(window.__zvAutoRecIv); window.__zvAutoRecIv = null; }
    if (window.__zvPollIv) { clearInterval(window.__zvPollIv); window.__zvPollIv = null; }
    if (window.__zvSgT) { clearTimeout(window.__zvSgT); window.__zvSgT = null; }
  } catch (_) {}
  window.__zvInstalled = true;
  // ── Gancho de captura de chamada (WebRTC) ───────────────────────────────────────────────
  // A ligacao do WhatsApp roda por WebRTC nesta pagina. Pra gravar as DUAS vozes, envolvemos o
  // RTCPeerConnection e guardamos as conexoes vivas em window.__zvPCs. Depois pegamos as faixas
  // de audio: os "senders" (SUA voz/microfone) e os "receivers" (a voz do LEAD). Roda cedo (o
  // painel e injetado no document-start) pra envolver antes do WhatsApp criar a chamada. Fica no
  // window e so envolve UMA vez, entao sobrevive a auto-atualizacao do painel.
  (function hookRTC() {
    try {
      if (window.__zvRtcHooked) return;
      var Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!Native || !Native.prototype) return;
      window.__zvPCs = window.__zvPCs || [];
      var Wrapped = function (cfg, con) {
        var pc = new Native(cfg, con);
        try {
          window.__zvPCs.push(pc);
          pc.addEventListener && pc.addEventListener('connectionstatechange', function () {
            try { if (pc.connectionState === 'closed' || pc.connectionState === 'failed') { var i = window.__zvPCs.indexOf(pc); if (i >= 0) window.__zvPCs.splice(i, 1); } } catch (_) {}
          });
        } catch (_) {}
        return pc;
      };
      Wrapped.prototype = Native.prototype;
      try { Object.setPrototypeOf(Wrapped, Native); } catch (_) {}   // herda estaticos (generateCertificate)
      window.RTCPeerConnection = Wrapped;
      try { window.webkitRTCPeerConnection = Wrapped; } catch (_) {}
      window.__zvRtcHooked = true;
    } catch (_) {}
  })();
  var DATA = "__LIBRARY__";
  var CSS = "__CSS__";
  var simulate = true, els = {}, itemById = {};
  // ─── FILA de envios (a "pilha") ────────────────────────────────────────────────────────
  // UM envio por vez, na ordem em que foi clicado. O funil/item da vez termina INTEIRO antes do
  // proximo comecar — nunca dois leads recebendo ao mesmo tempo. Isso vale pra item, funil E
  // agendamento (todos entram na MESMA fila). O banner mostra o que esta indo agora e quem
  // esta esperando a vez, com a posicao.
  var jobs = [];              // jobs[0] = o da vez; o resto aguarda
  var jobRunning = false;
  // Estado da GRAVACAO de chamada (uma por vez). Declarado cedo pro __zvBusy enxergar.
  var rec = { on: false, starting: false, auto: false, mr: null, chunks: [], ac: null, dest: null, sources: [], sinks: [], capStreams: [], micStream: null, startAt: 0, chatId: '', chatName: '', micOnly: false, hadRemote: false, diag: '', tickIv: null, mime: 'audio/webm' };
  // Gravar automaticamente quando detectar ligacao (setting do Ajustes).
  var autoRec = false; try { autoRec = localStorage.getItem('zv_autorec') === '1'; } catch (_) {}
  var recAutoLast = 0, recAutoArmed = true;   // uma gravacao automatica por ligacao
  function jobId() { return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function jobAdd(job) { jobs.push(job); renderSending(); pumpJobs(); return job; }
  function jobDrop(job) {
    // IDEMPOTENTE de proposito: um fin() atrasado (promise orfa que voltou depois) NAO pode
    // liberar a fila duas vezes — isso subiria DOIS jobs em paralelo (dois leads ao mesmo tempo).
    if (job.__dropped) return;
    job.__dropped = true;
    if (job.wdT) { clearTimeout(job.wdT); job.wdT = null; }
    jobs = jobs.filter(function (x) { return x.id !== job.id; });
    if (job.started) jobRunning = false;
    renderSending(); pumpJobs();
  }
  function pumpJobs() {
    if (jobRunning) return;
    var job = jobs[0];
    if (!job) return;
    if (job.stop) { jobs.shift(); renderSending(); pumpJobs(); return; }   // cancelado antes da vez
    jobRunning = true; job.started = true; renderSending();
    var fin = function () { jobDrop(job); };
    // WATCHDOG: como a fila e serial, um envio pendurado (WhatsApp em "Reconectando") congelaria
    // TODOS os leads pra sempre. Estourou o teto: pede stop e, se em 15s nao sair, ABANDONA. A
    // promise orfa ate pode entregar depois, mas a FILA ANDA. Nenhum envio segura os outros.
    var budget = job.budgetMs || 300000;
    job.wdT = setTimeout(function () {
      job.stop = true; renderSending();
      status('Envio travado -> ' + (job.chatName || '') + ' (liberei a fila)', 'err');
      job.wdT = setTimeout(fin, 15000);
    }, budget);
    try { var p = job.run(job); if (p && p.then) p.then(fin, fin); else fin(); }
    catch (_) { fin(); }
  }
  // Pausar/remover. Nao comecou -> sai da fila na hora. Ja esta indo -> pede pra parar; um
  // segundo clique (ou o force) ABANDONA na marra, pra nunca existir job impossivel de tirar.
  function jobStop(id, force) {
    for (var k = 0; k < jobs.length; k++) {
      if (jobs[k].id !== id) continue;
      var j = jobs[k];
      if (!j.started) { jobs.splice(k, 1); status('Tirado da fila (' + (j.chatName || '') + ')', 'err'); break; }
      if (force || j.stop) { status('Envio abandonado -> ' + (j.chatName || '') + ' (liberei a fila)', 'err'); jobDrop(j); return; }
      j.stop = true; break;
    }
    renderSending(); pumpJobs();
  }
  // O injetor consulta isto pra NAO se auto-atualizar no meio de um envio: reinjetar o painel
  // zera a fila, e o envio continua entregando mas SOME do banner (era esse o bug do "disparei
  // e nao apareceu na pilha").
  // Ocupado = tem envio na fila OU uma gravacao rolando. O injetor consulta isto pra NAO
  // auto-atualizar o painel no meio (reinjetar zeraria a fila / cortaria a gravacao).
  window.__zvBusy = function () { try { return jobs.length > 0 || rec.on || rec.starting; } catch (_) { return false; } };

  // Promise do WPP com TETO. Se o WhatsApp entra em "Reconectando", a promise dele pode NUNCA
  // voltar. Como a fila e serial, um envio pendurado congelaria TODOS os leads. Isto garante que
  // toda chamada assenta: ou responde, ou falha por tempo. Nunca fica em aberto.
  function withTimeout(p, ms, tag) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res({ ok: false, err: 'demorou demais (' + tag + ')' }); } }, ms);
      try {
        Promise.resolve(p).then(
          function () { if (!done) { done = true; clearTimeout(t); res({ ok: true }); } },
          function (e) { if (!done) { done = true; clearTimeout(t); res({ ok: false, err: (e && e.message) || ('' + e) }); } }
        );
      } catch (e) { if (!done) { done = true; clearTimeout(t); res({ ok: false, err: (e && e.message) || ('' + e) }); } }
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Espera ms, mas checando stopFn a cada ~400ms. Resolve true se foi parado (pausar rapido).
  function sleepStop(ms, stopFn) {
    return new Promise(function (resolve) {
      var waited = 0;
      (function loop() {
        if (stopFn && stopFn()) { resolve(true); return; }
        if (waited >= ms) { resolve(false); return; }
        var step = Math.min(400, ms - waited);
        setTimeout(function () { waited += step; loop(); }, step);
      })();
    });
  }
  // O motor (WA-JS) esta VIVO? Nao basta window.WPP existir: o bundle define self.WPP no
  // fim mesmo se TODOS os module finders quebrarem contra um build novo do WhatsApp (foi o
  // que aconteceu no WhatsApp Beta). O sinal honesto e o ChatStore ter resolvido — sem ele
  // nem getActiveChat nem sendTextMessage (que resolve o chat pelo ChatStore) funcionam.
  var ZV_ENGINE_ERR = 'O motor do WhatsApp nao carregou nesta versao do app. Feche o WhatsApp e abra de novo pelo start; se continuar, use o WhatsApp normal.';
  // MINIMO pra enviar: o WPP resolve o chat a partir do jid string, entao basta o sendTextMessage
  // existir. NAO exigimos o ChatStore aqui de proposito — senao a gente barraria um envio que
  // funcionaria (o jid vem do fallback por DOM).
  function wppCanSend() {
    try { var W = window.WPP; return !!(W && W.chat && typeof W.chat.sendTextMessage === 'function'); } catch (_) { return false; }
  }
  // Motor 100% saudavel (os module finders engataram). Se isto for false mas wppCanSend for true,
  // seguimos assim mesmo: o DOM acha a conversa e o envio tem chance de funcionar.
  function wppAlive() {
    try { var W = window.WPP; return !!(wppCanSend() && W.whatsapp && W.whatsapp.ChatStore); } catch (_) { return false; }
  }
  // Resumo curto pro atendente mandar PRINT, sem precisar abrir o F12. Cada campo isola uma
  // etapa: se store>0 mas act=0, a flag .active sumiu; se ids=0, o DOM nao tem mensagem; etc.
  function engineDiag() {
    var wpp = 0, store = 0, act = 0, cs = 0, heal = 0, cmd = 0, main = 0, ids = 0, ifr = 0, dom = '-', loader = '-';
    try { wpp = window.WPP ? 1 : 0; } catch (_) {}
    try {
      var st = window.WPP.whatsapp.ChatStore;
      var arr = (st.getModelsArray && st.getModelsArray()) || st.models || [];
      store = arr.length || 0;
      for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].active) act++; }
    } catch (_) {}
    try { cs = _storeOk(window.WPP.whatsapp.ChatStore) ? 1 : 0; } catch (_) {}
    try { heal = _healStores() ? 1 : 0; } catch (_) {}
    try { cmd = _activeFromCmd() ? 1 : 0; } catch (_) {}
    try { main = _mainEl() ? 1 : 0; } catch (_) {}
    try { ids = document.querySelectorAll('[data-id]').length; } catch (_) {}
    try { ifr = document.querySelectorAll('iframe').length; } catch (_) {}
    try { dom = _activeFromDom() ? 'ok' : '-'; } catch (_) {}
    try { loader = (window.WPP.webpack && window.WPP.webpack.loaderType) || '-'; } catch (_) {}
    var miss = '-';
    try { var mm = _missing(); miss = mm.length ? mm.join(',') : 'none'; } catch (_) {}
    return 'WPP=' + wpp + ' send=' + (wppCanSend() ? 1 : 0) + ' cs=' + cs + ' heal=' + heal +
           ' miss=' + miss + ' store=' + store + ' act=' + act + ' cmd=' + cmd + ' main=' + main +
           ' ids=' + ids + ' ifr=' + ifr + ' dom=' + dom + ' loader=' + loader;
  }
  function onReady(cb) {
    var tries = 0;
    (function loop() {
      tries++;
      if (wppAlive()) { window.__zvWppFail = false; return cb(); }
      if (tries > 60) {   // 30s: sobe o painel mesmo assim, porem MARCADO como degradado
        window.__zvWppFail = true;
        console.warn('[Sale Chat] O motor do WhatsApp (WA-JS) nao carregou nesta versao do app. Painel em modo degradado — rode __zvDiag().');
        cb(); watchLate(); return;
      }
      setTimeout(loop, 500);
    })();
  }
  // Se o WPP chegar atrasado, religa os gatilhos (que senao morreriam pra sempre) e avisa.
  function watchLate() {
    var n = 0, iv = setInterval(function () {
      n++;
      if (wppAlive()) {
        clearInterval(iv); window.__zvWppFail = false;
        try { bindTriggers(); } catch (_) {}
        try { status('Motor do WhatsApp conectado.', 'ok'); } catch (_) {}
      } else if (n > 240) clearInterval(iv);   // desiste em 2min
    }, 500);
  }
  function injectCss() { var ex = document.getElementById('zv-style'); if (ex && ex.parentNode) ex.parentNode.removeChild(ex); var s = document.createElement('style'); s.id = 'zv-style'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

  // Fallback: acha a conversa aberta direto no ChatStore (o modelo com active=true).
  // Serve quando o WhatsApp atualiza e o getActiveChat oficial passa a devolver null,
  // mesmo com a conversa aberta (foi o que aconteceu na maquina de um atendente).
  function _activeFromStore() {
    var stores = [];
    try { var w = window.WPP && window.WPP.whatsapp; if (w && w.ChatStore) stores.push(w.ChatStore); } catch (_) {}
    try { if (window.Store && window.Store.Chat) stores.push(window.Store.Chat); } catch (_) {}
    for (var s = 0; s < stores.length; s++) {
      try {
        var st = stores[s];
        var arr = (st.getModelsArray && st.getModelsArray()) || (st.getModels && st.getModels()) || st.models || st._models || [];
        for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].active) return arr[i]; }
      } catch (_) {}
    }
    return null;
  }
  // ── Fallback por DOM: a UNICA fonte de verdade independente dos internals ──
  // Atencao: WPP.chat.getActiveChat() e literalmente ChatStore.findFirst(c => c.active), que e
  // o mesmo que _activeFromStore() faz na mao. Ou seja, os caminhos acima sao UM SO: se o build
  // do WhatsApp parar de marcar .active (ou o motor morrer), todos caem juntos. O DOM nao.
  var ZV_JID = /^\d[\d.:-]*@(?:c\.us|g\.us|lid|newsletter|broadcast|s\.whatsapp\.net)$/;
  // Chat sintetico no MESMO formato que chatIdOf/chatName/activeInfo ja consomem.
  function _mkChat(jid, title) {
    var p = jid.split('@');
    return { id: { _serialized: jid, user: p[0], server: p[1], toString: function () { return jid; } },
             isGroup: p[1] === 'g.us', formattedTitle: title || p[0], __fromDom: true };
  }
  // O WhatsApp escreve o id de CADA mensagem no DOM: data-id = "<fromMe>_<chatJid>_<msgId>"
  // (em grupo vem + "_<participante>"). O jid nunca tem "_", entao ler ate o 2o underscore basta.
  // Voto por maioria pra uma bolha estranha (citacao/encaminhada) nao sequestrar o alvo.
  function _domJidFromMessages(main) {
    var nodes = main.querySelectorAll('[data-id]');
    var votes = {}, best = null, bestN = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      // So conta mensagem VISIVEL: o WhatsApp deixa no DOM a conversa anterior (escondida), e
      // contar aquilo faria o voto apontar pro lead ERRADO.
      try { if (!n.offsetParent && n.offsetWidth === 0 && n.offsetHeight === 0) continue; } catch (_) {}
      var m = /^(?:true|false)_([^_]+)_/.exec(n.getAttribute('data-id') || '');
      if (!m || !ZV_JID.test(m[1])) continue;
      votes[m[1]] = (votes[m[1]] || 0) + 1;
      if (votes[m[1]] > bestN) { bestN = votes[m[1]]; best = m[1]; }
    }
    return best;
  }
  // Conversa SEM nenhuma mensagem (lead novo) nao tem data-id. Ai subimos o React Fiber a
  // partir do #main: o componente que renderiza a conversa recebe o model do chat como prop.
  function _looksLikeChat(o) {
    if (!o || typeof o !== 'object') return false;
    var id = o.id, jid = id && (typeof id === 'string' ? id : id._serialized);
    if (!jid || !ZV_JID.test(jid)) return false;
    return ('isGroup' in o) || !!o.msgs || !!o.contact || ('unreadCount' in o);
  }
  function _findChatIn(o, depth) {
    if (!o || typeof o !== 'object' || depth > 2) return null;
    try { if (_looksLikeChat(o)) return o; } catch (_) { return null; }
    for (var k in o) {
      if (k === 'children' || k === '_owner' || k === 'stateNode' || k === 'return') continue;
      var v; try { v = o[k]; } catch (_) { continue; }
      if (v && typeof v === 'object') { var r = _findChatIn(v, depth + 1); if (r) return r; }
    }
    return null;
  }
  function _activeFromFiber(main) {
    var key = null;
    for (var k in main) { if (k.lastIndexOf('__reactFiber$', 0) === 0 || k.lastIndexOf('__reactInternalInstance$', 0) === 0) { key = k; break; } }
    if (!key) return null;
    var f = main[key], hops = 0;
    while (f && hops++ < 40) {
      var c = _findChatIn(f.memoizedProps, 0) || _findChatIn(f.memoizedState, 0);
      if (c) return c;
      f = f.return;
    }
    return null;
  }
  // O painel de conversa: NAO depender so do id "#main" (build novo pode ter renomeado).
  function _mainEl() {
    return document.querySelector('#main')
        || document.querySelector('[data-testid="conversation-panel-wrapper"]')
        || document.querySelector('[data-testid="conversation-panel-messages"]')
        || null;
  }
  function _domTitle(root) {
    try { var t = (root || document).querySelector('header span[title]'); return t ? (t.getAttribute('title') || t.textContent || '') : ''; } catch (_) { return ''; }
  }
  // ── Resgate do ChatStore ────────────────────────────────────────────────────────────────
  // No build do atendente o WA-JS NAO encontrou o modulo ChatStore: WPP.whatsapp.ChatStore fica
  // undefined e o envio estoura com "Cannot read properties of undefined (reading 'get')" (o
  // sendTextMessage resolve o chat pelo ChatStore). Mas o ChatStore EXISTE na pagina — quem nao
  // achou foi o WA-JS. Todo model do WhatsApp guarda a colecao dele em .collection, entao a gente
  // pega o chat REAL pelo React e recupera o store por ali, devolvendo pro motor.
  // De onde ancorar a busca no React (a conversa aberta).
  function _fiberAnchor() { return _mainEl() || document.querySelector('[data-id]') || null; }
  // O model REAL do chat (nao o sintetico do DOM) — e dele que sai a .collection.
  function _realChatModel() {
    try { var a = _fiberAnchor(); if (!a) return null; var c = _activeFromFiber(a); return (c && !c.__fromDom) ? c : null; } catch (_) { return null; }
  }
  function _storeOk(s) { try { return !!(s && (typeof s.get === 'function' || typeof s.find === 'function')); } catch (_) { return false; } }
  // Peças que o envio encosta (tirado do proprio bundle). O finder do WA-JS procura cada uma por
  // NOME (ex: ChatStore = modulo que exporta "ChatCollection"); se o build novo renomeou, vira
  // undefined. Listar as que faltam diz de uma vez o tamanho do estrago.
  var ZV_KEYS = ['ChatStore', 'MsgStore', 'ContactStore', 'GroupMetadataStore', 'WidFactory', 'MsgKey', 'UserPrefs', 'Cmd', 'Conn'];
  function _missing() {
    var out = [];
    try {
      var W = window.WPP && window.WPP.whatsapp;
      if (!W) return ['whatsapp'];
      for (var i = 0; i < ZV_KEYS.length; i++) {
        var k = ZV_KEYS[i], v;
        try { v = W[k]; } catch (_) { v = undefined; }
        if (!v) out.push(k.replace('Store', ''));
      }
    } catch (_) {}
    return out;
  }
  // Devolve o ChatStore pro WPP. No caminho feliz (WhatsApp normal) sai na hora sem tocar em nada.
  // Os exports do bundle costumam ser getters; assignment direto pode nao pegar.
  function _bind(W, name, val) {
    try { Object.defineProperty(W, name, { get: function () { return val; }, configurable: true }); }
    catch (_) { try { W[name] = val; } catch (_) {} }
    return _storeOk(W[name]);
  }
  function _healStores() {
    try {
      var W = window.WPP && window.WPP.whatsapp;
      if (!W) return false;
      if (_storeOk(W.ChatStore)) return true;              // ja esta bom (WhatsApp normal): nao mexe
      var m = _realChatModel();
      if (!m) return false;
      var ok = false;
      // ChatStore: todo model guarda a colecao dele em .collection.
      if (_storeOk(m.collection)) ok = _bind(W, 'ChatStore', m.collection);
      // ContactStore: sai de graca pelo contato do chat.
      try { if (!_storeOk(W.ContactStore) && m.contact && _storeOk(m.contact.collection)) _bind(W, 'ContactStore', m.contact.collection); } catch (_) {}
      if (ok) console.warn('[Sale Chat] ChatStore recuperado pelo React (o WA-JS nao tinha achado).');
      return ok;
    } catch (_) { return false; }
  }
  // Caminho interno que NAO usa a flag .active: o Cmd guarda a conversa aberta.
  function _activeFromCmd() {
    try {
      var C = window.WPP && window.WPP.whatsapp && window.WPP.whatsapp.Cmd;
      if (!C) return null;
      var c = C.activeConversation || C._activeConversation || null;
      return (c && c.id) ? c : null;
    } catch (_) { return null; }
  }
  // Se a conversa estiver dentro de um iframe, o document de cima nao tem o DOM dela.
  function _allDocs() {
    var docs = [document];
    try {
      var ifr = document.querySelectorAll('iframe');
      for (var i = 0; i < ifr.length; i++) { try { var d = ifr[i].contentDocument; if (d) docs.push(d); } catch (_) {} }
    } catch (_) {}
    return docs;
  }
  function _activeFromDom() {
    try {
      var root = _mainEl();
      // Varre o documento INTEIRO: a lista de conversas da esquerda tem data-id = jid puro, e o
      // nosso regex exige o formato de MENSAGEM (true_/false_ + jid + _msgid), entao ela nao
      // entra por engano. Assim funciona mesmo se o "#main" tiver mudado de nome.
      var jid = _domJidFromMessages(root || document);
      if (jid) return _mkChat(jid, _domTitle(root));
      if (root) { var f = _activeFromFiber(root); if (f) return f; }   // conversa vazia
      // Ultimo recurso: a conversa pode estar num iframe (document de cima nao ve o DOM dela).
      var docs = _allDocs();
      for (var i = 1; i < docs.length; i++) {
        var j2 = _domJidFromMessages(docs[i]);
        if (j2) return _mkChat(j2, _domTitle(docs[i]));
      }
      return null;
    } catch (_) { return null; }
  }
  // A conversa ABERTA NA TELA e a verdade. Os caminhos internos (getActiveChat/_activeFromStore)
  // leem a flag .active, que nesse build do WhatsApp e furada: ja veio toda apagada (nao achava
  // conversa nenhuma) e depois veio GRUDADA num chat velho (o painel apontava pro lead errado).
  // Por isso: se o interno discordar do DOM, o DOM ganha. Errar o lead e o pior desfecho possivel.
  function activeChat() {
    var dom = _activeFromDom();
    var internal = null;
    try { internal = window.WPP.chat.getActiveChat() || null; } catch (_) {}
    if (!internal) internal = _activeFromStore() || _activeFromCmd();
    if (dom && internal) {
      var a = chatIdOf(dom), b = chatIdOf(internal);
      if (a && b && a !== b) return dom;   // discordaram: manda pro que esta ABERTO na tela
      return internal;                     // concordam: usa o model real (tem contato/nome/foto)
    }
    return internal || dom;
  }
  // id serializado da conversa (pra travar o alvo do envio no lead que estava aberto no clique).
  function chatIdOf(c) { try { return (c && c.id && (c.id._serialized || (c.id.toString && c.id.toString()))) || (c && c.id) || null; } catch (_) { return null; } }
  // Alvo capturado de cada video pendente: id-do-pedido -> chatId. Assim o video vai pro lead
  // certo mesmo se o atendente trocar de conversa enquanto o injetor baixa o base64.
  // Alvo de cada video pendente: rid -> chatId. Fica no WINDOW, nao no escopo do painel: o painel
  // se AUTO-ATUALIZA e e reinjetado do zero. Se o alvo morasse aqui dentro, uma atualizacao no
  // meio do download do video (que demora, vem da nuvem) apagaria o alvo e o envio abortaria com
  // "alvo expirado" — foi o que aconteceu no funil de video. No window, ele sobrevive.
  var videoTargets = window.__zvTargets || (window.__zvTargets = {});
  // Videos CANCELADOS (o atendente pausou / o funil parou). Precisa ser explicito: o injetor
  // devolve o chatId do pedido junto com o video, entao apagar o alvo nao basta pra impedir o
  // envio — sem esta marca, um video pausado seria entregue assim mesmo.
  var videoCanc = window.__zvCanc || (window.__zvCanc = {});
  function videoCancel(rid) { try { videoCanc[rid] = 1; delete videoTargets[rid]; } catch (_) {} }
  // Fila de videos: window.__zvReq e um slot UNICO (o injetor le um por vez). Se dois videos
  // setam o slot no mesmo instante, um se sobrescreve e se perde. Por isso serializamos: so
  // um video ocupa o slot por vez; os demais esperam a vez.
  var videoQueue = [], videoBusy = false;
  function pumpVideoQueue() {
    if (videoBusy || !videoQueue.length) return;
    var job = videoQueue.shift();
    // Se o job (funil/item) desse video foi pausado antes de comecar, nao envia.
    if (job.stopFn && job.stopFn()) { videoCancel(job.rid); job.resolve({ ok: false, cancelled: true }); pumpVideoQueue(); return; }
    videoBusy = true;
    try { window.__zvRes = null; } catch (_) {}
    window.__zvReq = job.req;
    var waited = 0;
    var iv = setInterval(function () {
      waited += 500; var res = window.__zvRes;
      if (job.stopFn && job.stopFn()) { clearInterval(iv); videoCancel(job.rid); videoBusy = false; job.resolve({ ok: false, cancelled: true }); pumpVideoQueue(); }
      else if (res && res.id === job.rid) { clearInterval(iv); delete videoTargets[job.rid]; videoBusy = false; job.resolve({ ok: !!res.ok, err: res.err }); pumpVideoQueue(); }
      else if (waited > 180000) { clearInterval(iv); videoCancel(job.rid); videoBusy = false; job.resolve({ ok: false, err: 'timeout (start.bat rodando?)' }); pumpVideoQueue(); }
    }, 500);
  }
  function activeInfo() {
    var c = activeChat(); if (!c) return null;
    var ct = c.contact || {};
    return { name: ct.name || ct.pushname || ct.formattedName || c.formattedTitle || (c.id && c.id.user) || '', number: (c.id && c.id.user) || '', isGroup: !!c.isGroup };
  }
  // Diagnostico: se o painel disser "abra a conversa" mesmo com a conversa aberta, o
  // atendente abre o console (F12) e digita __zvDiag() — manda o resultado pro suporte.
  window.__zvDiag = function () {
    var d = { motorVivo: false, wppExiste: false, wppReady: false, loader: null, getActiveChat: null, storeCount: 0, jidPeloDom: null, activeAchou: false, waVersion: null };
    try { d.motorVivo = wppAlive(); } catch (_) {}
    try { d.wppExiste = !!window.WPP; } catch (_) {}
    try { d.wppReady = !!(window.WPP && (window.WPP.isReady || (window.WPP.conn && window.WPP.conn.isAuthenticated && window.WPP.conn.isAuthenticated()))); } catch (_) {}
    try { d.loader = (window.WPP && window.WPP.webpack && window.WPP.webpack.loaderType) || null; } catch (_) {}
    try { d.getActiveChat = !!(window.WPP.chat.getActiveChat()); } catch (e) { d.getActiveChat = 'erro:' + ((e && e.message) || e); }
    try { var w = window.WPP.whatsapp; var st = w && w.ChatStore; var arr = st && ((st.getModelsArray && st.getModelsArray()) || st.models || []); d.storeCount = (arr && arr.length) || 0; } catch (_) {}
    try { var dm = _activeFromDom(); d.jidPeloDom = dm ? chatIdOf(dm) : null; } catch (_) {}
    try { d.activeAchou = !!activeChat(); } catch (_) {}
    try { d.waVersion = (window.Debug && window.Debug.VERSION) || null; } catch (_) {}
    console.log('[Sale Chat diag] ' + JSON.stringify(d));
    return d;
  };

  function build() {
    injectCss();
    // Enviado pelo injetor (window.__zvReq -> injetor le o arquivo -> chama isso com o base64)
    window.__zvDoSend = function (dataUri, caption, id, fromInjector) {
      try {
        // Alvo travado no clique. NUNCA cai pro chat aberto agora (mandaria pro lead errado).
        // fromInjector = o mesmo chatId que o painel mandou no pedido e o injetor devolve de
        // volta; e so redundancia do alvo travado, nao o chat atual.
        if (videoCanc[id]) { delete videoCanc[id]; delete videoTargets[id]; window.__zvRes = { id: id, ok: false, cancelled: true, err: 'cancelado' }; return; }
        var toId = videoTargets[id] || fromInjector || null; delete videoTargets[id];
        if (!toId) { window.__zvRes = { id: id, ok: false, err: 'alvo expirado (nao enviei pra nao errar o lead)' }; return; }
        window.WPP.chat.sendFileMessage(toId, dataUri, { type: 'video', caption: caption || '' })
          .then(function () { window.__zvRes = { id: id, ok: true }; })
          .catch(function (e) { window.__zvRes = { id: id, ok: false, err: (e && e.message) || ('' + e) }; });
      } catch (e) { window.__zvRes = { id: id, ok: false, err: (e && e.message) || ('' + e) }; }
    };
    // Atualizacao ao vivo: o injetor busca a config da dash de tempos em tempos e,
    // se mudou, chama isso com os novos dados. O painel se redesenha sozinho, sem
    // precisar reabrir o WhatsApp nem rodar o start.bat de novo.
    window.__zvUpdate = function (newData) {
      try {
        if (!newData) return;
        DATA = newData; buildIndex();
        if (document.getElementById('zv-panel')) { renderRail(); renderContent(); }
      } catch (_) {}
    };
    bindTriggers();
    var t = setInterval(function () {
      if (document.body && !document.getElementById('zv-panel')) { clearInterval(t); render(); poll(); }
    }, 700);
  }

  // Gatilhos: escuta mensagens recebidas e sugere o item configurado. Religavel: se o WPP
  // subir atrasado, o watchLate() chama isso de novo (antes, o listener morria pra sempre).
  var _triggersOn = false;
  function bindTriggers() {
    if (_triggersOn) return;
    try {
      if (window.WPP && window.WPP.on) {
        window.WPP.on('chat.new_message', function (m) { try { onIncoming(m); } catch (_) {} });
        _triggersOn = true;
      }
    } catch (_) {}
  }
  function onIncoming(msg) {
    if (!msg || msg.fromMe || (msg.id && msg.id.fromMe)) return;
    // Interrompe os funis que pedem "parar se o lead responder", pro lead que respondeu.
    if (jobs.length) {
      var mFromS = (msg.from && (msg.from._serialized || (msg.from.toString && msg.from.toString()))) || '';
      var any = false;
      // So para o funil do lead que REALMENTE respondeu (match exato). Sem remetente
      // identificavel, nao para nada — pra um evento ambiguo nao derrubar funis de outros leads.
      jobs.slice().forEach(function (j) {
        if (!j.stopOnReply || j.stop || !mFromS || mFromS !== j.chatId) return;
        // Ja esta indo: pede pra parar. Ainda na fila: tira fora na hora (nem chega a comecar).
        if (j.started) j.stop = true;
        else jobs = jobs.filter(function (x) { return x.id !== j.id; });
        any = true;
      });
      if (any) { renderSending(); pumpJobs(); status('Funil parado: o lead respondeu', 'err'); }
    }
    var trs = DATA.triggers || [];
    if (!trs.length) return;
    var body = String(msg.body || msg.caption || '').toLowerCase();
    if (!body) return;
    // so sugere se for a conversa aberta (o atendente ta olhando)
    var c = activeChat();
    var mFrom = (msg.from && (msg.from._serialized || (msg.from.toString && msg.from.toString()))) || '';
    var cId = (c && c.id && (c.id._serialized || (c.id.toString && c.id.toString()))) || '';
    if (mFrom && cId && mFrom !== cId) return;
    for (var i = 0; i < trs.length; i++) {
      var kws = String(trs[i].keyword || '').toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      for (var j = 0; j < kws.length; j++) {
        if (kws[j] && body.indexOf(kws[j]) >= 0) {
          var item = itemById[trs[i].itemId];
          if (item) { showSuggestion(item, kws[j]); return; }
        }
      }
    }
  }

  // ─── Agendamento (client-side, guardado no localStorage do WhatsApp Web) ───
  function schedGet() { try { return JSON.parse(localStorage.getItem('zv_sched') || '[]'); } catch (_) { return []; } }
  function schedSet(a) { try { localStorage.setItem('zv_sched', JSON.stringify(a)); } catch (_) {} }
  function allItemsList() { return (DATA.messages || []).concat(DATA.funnel || [], DATA.social || [], DATA.media || []); }
  function schedRender() {
    var box = document.getElementById('zv-sched'); if (!box) return;
    var items = allItemsList(), now = Date.now();
    var list = schedGet().sort(function (a, b) { return a.at - b.at; });
    box.innerHTML =
      '<div class="zv-sched-form"><select id="zv-sched-item">' + items.map(function (it) { return '<option value="' + esc(it.id) + '">' + esc(it.label) + '</option>'; }).join('') + '</select>' +
      '<input id="zv-sched-min" type="number" min="1" value="10"><span>min</span>' +
      '<button id="zv-sched-add">Agendar p/ este chat</button></div>' +
      (list.length ? list.map(function (s) { var it = itemById[s.itemId]; var mins = Math.max(0, Math.round((s.at - now) / 60000)); return '<div class="zv-sched-row"><span>' + esc((it && it.label) || s.itemId) + ' &rarr; ' + esc(s.chatName || s.chatId) + ' (~' + mins + 'min)</span><span class="zv-sched-x" data-id="' + esc(s.id) + '">&times;</span></div>'; }).join('') : '<div class="zv-empty" style="padding:8px 2px">Nada agendado.</div>');
    box.querySelector('#zv-sched-add').onclick = schedAdd;
    Array.prototype.forEach.call(box.querySelectorAll('.zv-sched-x'), function (x) { x.onclick = function () { schedCancel(x.getAttribute('data-id')); }; });
  }
  function schedAdd() {
    if (!wppCanSend()) { status(ZV_ENGINE_ERR + ' [' + engineDiag() + ']', 'err'); return; }
    try { _healStores(); } catch (_) {}   // ChatStore sumido? recupera antes de enviar
    var c = activeChat(); if (!c || c.isGroup) { status('Abra a conversa de um lead pra agendar [' + engineDiag() + ']', 'err'); return; }
    var itemId = (document.getElementById('zv-sched-item') || {}).value;
    var min = parseInt((document.getElementById('zv-sched-min') || {}).value, 10) || 10;
    if (!itemId) return;
    var name = (c.contact && (c.contact.name || c.contact.pushname)) || c.formattedTitle || (c.id && c.id.user) || '';
    var chatId = (c.id && (c.id._serialized || (c.id.toString && c.id.toString()))) || '';
    var a = schedGet(); a.push({ id: 's' + Date.now().toString(36), chatId: chatId, chatName: name, itemId: itemId, at: Date.now() + min * 60000 }); schedSet(a);
    status('Agendado pra ' + name + ' em ' + min + 'min', 'ok'); schedRender();
  }
  function schedCancel(id) { schedSet(schedGet().filter(function (s) { return s.id !== id; })); schedRender(); }
  function schedCheck() {
    var a = schedGet(); if (!a.length) return;
    var now = Date.now(), due = a.filter(function (s) { return s.at <= now; });
    if (!due.length) return;
    schedSet(a.filter(function (s) { return s.at > now; }));
    // Agendado tambem ENTRA NA FILA (antes disparava direto e podia mandar pra outro lead no
    // meio de um funil — dois leads recebendo ao mesmo tempo).
    due.forEach(function (s) {
      var it = itemById[s.itemId]; if (!it || !s.chatId) return;
      jobAdd({
        id: jobId(), kind: 'item', itemId: it.id, chatId: s.chatId, chatName: s.chatName || '',
        name: 'Agendado: ' + (it.label || ''), sub: '', stop: false, started: false,
        budgetMs: it.kind === 'video' ? 480000 : 300000,
        run: function (j) {
          j.sub = 'Enviando…'; renderSending();
          return sendItemAsync(it, j.chatId, { stopFn: function () { return j.stop; } }).then(function (r) {
            status(r.ok ? ('Agendado enviado -> ' + (j.chatName || '')) : ('Falha no agendado -> ' + (j.chatName || '') + ': ' + (r.err || '')), r.ok ? 'ok' : 'err');
          });
        },
      });
    });
    var b = document.getElementById('zv-sched'); if (b && b.style.display !== 'none') schedRender();
  }

  function showSuggestion(item, kw) {
    var s = document.getElementById('zv-suggest'); if (!s) return;
    s.innerHTML = '<div class="zv-sg-txt">Cliente falou "<b>' + esc(kw) + '</b>" — sugestao:</div>' +
      '<div class="zv-sg-row"><button class="zv-sg-send"><span class="zv-play">' + SVG.play + '</span><span>' + esc(item.label) + '</span></button><span class="zv-sg-x" title="Fechar">&times;</span></div>';
    s.style.display = 'block';
    s.querySelector('.zv-sg-send').onclick = function () { s.style.display = 'none'; send(item); };
    s.querySelector('.zv-sg-x').onclick = function () { s.style.display = 'none'; };
    if (window.__zvSgT) clearTimeout(window.__zvSgT);
    window.__zvSgT = setTimeout(function () { s.style.display = 'none'; }, 30000);
  }

  var SVG = {
    msg:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    mic:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    video: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
    image: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
    doc:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    funnel:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    seq:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    play:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3.5v17a1 1 0 0 0 1.53.85l13.4-8.5a1 1 0 0 0 0-1.7L7.53 2.65A1 1 0 0 0 6 3.5Z"/></svg>',
    star:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    starFull:'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    chevUp:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    chevDown:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    moon:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    sun:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    search:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    minus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    grid:  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    calendar:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    sliders:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    help:  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    rec:   '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
    stopsq:'<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    dl:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  var COLLAPSED = lsGet('zv_collapsed', {});
  var FAVS = lsGet('zv_favs', {});
  var DARK = true; try { var _d = localStorage.getItem('zv_dark'); if (_d !== null) DARK = _d === '1'; } catch (_) {}
  var FILTER = '';
  var TAB = 'itens'; try { TAB = localStorage.getItem('zv_tab') || 'itens'; } catch (_) {}
  var TYPEFILTER = 'all';
  var FAVONLY = false;
  var TABS = [
    { key: 'itens', label: 'Itens', icon: 'grid' },
    { key: 'funis', label: 'Funis', icon: 'funnel' },
    { key: 'agenda', label: 'Agenda', icon: 'calendar' },
    { key: 'ajustes', label: 'Ajustes', icon: 'sliders' },
    { key: 'ajuda', label: 'Ajuda', icon: 'help' },
    { key: 'gravar', label: 'Gravar', icon: 'rec' }
  ];
  var TYPES = [
    { key: 'all', label: 'Todos', icon: 'grid', color: '#54656f' },
    { key: 'text', label: 'Mensagens', icon: 'msg', color: '#2563eb' },
    { key: 'audio', label: 'Audios', icon: 'mic', color: '#13c273' },
    { key: 'video', label: 'Videos', icon: 'video', color: '#8e17f0' },
    { key: 'image', label: 'Imagens', icon: 'image', color: '#00bcf2' },
    { key: 'document', label: 'Documentos', icon: 'doc', color: '#f0810f' }
  ];
  var ZKIND = {
    text:     { c: '#2563eb', ic: SVG.msg },
    audio:    { c: '#13c273', ic: SVG.mic },
    video:    { c: '#8e17f0', ic: SVG.video },
    image:    { c: '#00bcf2', ic: SVG.image },
    document: { c: '#f0810f', ic: SVG.doc }
  };
  function itemRow(it) {
    var k = ZKIND[it.kind] || ZKIND.text;
    var fav = !!FAVS[it.id];
    return '<div class="zv-itemwrap" data-grp="' + esc(String(it.grp || '').trim()) + '">' +
      '<div class="zv-item" data-exp="' + esc(it.id) + '" title="' + esc(it.desc || it.caption || '') + '">' +
        '<span class="zv-ic" style="background:' + k.c + '1f;color:' + k.c + '">' + k.ic + '</span>' +
        '<span class="zv-label">' + esc(it.label) + '</span>' +
        '<span class="zv-star' + (fav ? ' on' : '') + '" data-fav="' + esc(it.id) + '" title="Favoritar">' + (fav ? SVG.starFull : SVG.star) + '</span>' +
        '<button class="zv-send" data-id="' + esc(it.id) + '" title="Enviar">' + SVG.play + '</button>' +
        '<span class="zv-exp" data-exp="' + esc(it.id) + '" title="Prever antes de enviar">' + SVG.chevDown + '</span>' +
      '</div>' +
      '<div class="zv-prev" style="display:none"></div></div>';
  }
  // Agrupa por subcategoria (grp). Sem grp -> "Geral", que tem prioridade (vem primeiro).
  // Subcategorias seguem a ordem em que aparecem nos itens (controlavel na dash). Um grupo so = sem cabecalho.
  function itemsHtml(list) {
    list = list || [];
    var groups = {}, order = [];
    list.forEach(function (it) { var g = String(it.grp || '').trim() || 'Geral'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(it); });
    var gi = order.indexOf('Geral'); if (gi > 0) { order.splice(gi, 1); order.unshift('Geral'); }
    var single = order.length <= 1;
    return order.map(function (g) {
      var head = single ? '' : '<div class="zv-subh" data-grp="' + esc(g === 'Geral' ? '' : g) + '">' + esc(g) + '<span class="zv-subn">' + groups[g].length + '</span></div>';
      return head + groups[g].map(itemRow).join('');
    }).join('');
  }
  // Prévia expansível: mostra o conteúdo antes de disparar. Imagem/audio/doc vêm
  // embutidos (dataUri). Vídeo é pesado: o injetor busca sob demanda (__zvPrevReq).
  function togglePreview(id, wrap, exp) {
    var prev = wrap.querySelector('.zv-prev'); if (!prev) return;
    if (prev.style.display !== 'none') { prev.style.display = 'none'; prev.innerHTML = ''; if (exp) exp.classList.remove('open'); return; }
    prev.style.display = 'block'; if (exp) exp.classList.add('open');
    var it = itemById[id]; if (!it) { prev.innerHTML = '<div class="zv-prev-note">Sem previa.</div>'; return; }
    var cap = it.caption ? '<div class="zv-prev-cap">' + esc(it.caption) + '</div>' : '';
    if (it.kind === 'text') { prev.innerHTML = '<div class="zv-prev-txt">' + esc(it.text || '(sem texto)') + '</div>'; return; }
    if (it.kind === 'image') { prev.innerHTML = cap + '<img class="zv-prev-img" src="' + it.dataUri + '">'; return; }
    if (it.kind === 'audio') { prev.innerHTML = '<audio class="zv-prev-audio" controls preload="metadata" src="' + it.dataUri + '"></audio>'; return; }
    if (it.kind === 'document') { prev.innerHTML = cap + '<a class="zv-prev-doc" href="' + it.dataUri + '" download="' + esc(it.label || 'documento') + '" target="_blank">' + SVG.doc + ' Abrir documento</a>'; return; }
    if (it.kind === 'video') {
      if (it.posterUri) { prev.innerHTML = cap + '<div class="zv-prev-vwrap"><img class="zv-prev-video" src="' + it.posterUri + '"><span class="zv-prev-badge">' + SVG.play + ' primeiro frame</span></div>'; return; }
      if (it.dataUri) { prev.innerHTML = cap + '<video class="zv-prev-video" controls preload="metadata" src="' + it.dataUri + '"></video>'; return; }
      prev.innerHTML = cap + '<div class="zv-prev-note">carregando previa...</div>';
      var rid = 'pv' + Date.now() + Math.random().toString(36).slice(2, 5);
      try { window.__zvPrevRes = null; } catch (_) {}
      window.__zvPrevReq = { id: rid, url: it.mediaUrl, mime: it.mime || 'video/mp4' };
      var waited = 0;
      var iv = setInterval(function () {
        waited += 500; var res = window.__zvPrevRes;
        if (res && res.id === rid) {
          clearInterval(iv);
          if (prev.style.display === 'none') return;
          if (res.ok && res.dataUri) { it.dataUri = res.dataUri; prev.innerHTML = cap + '<video class="zv-prev-video" controls preload="metadata" src="' + res.dataUri + '"></video>'; }
          else { var n = prev.querySelector('.zv-prev-note'); if (n) n.textContent = 'Nao consegui carregar a previa (start.bat rodando?).'; }
        } else if (waited > 60000) { clearInterval(iv); var n2 = prev.querySelector('.zv-prev-note'); if (n2) n2.textContent = 'Tempo esgotado.'; }
      }, 500);
      return;
    }
    prev.innerHTML = '<div class="zv-prev-note">Sem previa.</div>';
  }
  function mediaByKind(kind) { return (DATA.media || []).filter(function (m) { return m.kind === kind; }); }
  // Seção recolhível com título, contador e chevron. inner = HTML da lista (itens ou funis).
  function section(key, title, ic, color, count, inner) {
    if (!count) return '';
    var col = !!COLLAPSED[key];
    return '<div class="zv-sec" data-sec="' + key + '">' +
      '<div class="zv-h" data-toggle="' + key + '"><span class="zv-hi" style="color:' + color + '">' + ic + '</span>' +
        '<span class="zv-htxt">' + title + '</span><span class="zv-count">' + count + '</span>' +
        '<span class="zv-chev">' + (col ? SVG.chevDown : SVG.chevUp) + '</span></div>' +
      '<div class="zv-list"' + (col ? ' style="display:none"' : '') + '>' + inner + '</div></div>';
  }

  function buildIndex() {
    itemById = {};
    (DATA.messages || []).concat(DATA.funnel || [], DATA.social || [], DATA.media || []).forEach(function (it) { if (it && it.id) itemById[it.id] = it; });
  }

  var PANEL_W = 440, RAIL_W = 74; // casam com o panel.css
  function undockLayout() {
    try { var app = document.getElementById('app'); if (app) { app.style.removeProperty('width'); app.style.removeProperty('min-width'); } } catch (_) {}
  }
  // Ancora o painel na lateral: empurra o WhatsApp pra esquerda pra ele ficar AO LADO
  // (nao por cima). A largura reservada muda conforme o estado (cheio / so-barra / minimizado).
  function dockLayout() {
    try {
      var p = document.getElementById('zv-panel');
      if (p && p.classList.contains('zv-collapsed')) { undockLayout(); return; }
      var w = (p && p.classList.contains('zv-railonly')) ? RAIL_W : PANEL_W;
      var app = document.getElementById('app');
      if (app) { app.style.setProperty('width', 'calc(100vw - ' + w + 'px)', 'important'); app.style.setProperty('min-width', '0', 'important'); }
    } catch (_) {}
  }
  function render() {
    buildIndex();
    var p = document.createElement('div'); p.id = 'zv-panel'; if (DARK) p.className = 'zv-dark';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">Sale Chat</span><span id="zv-who">carregando...</span>' +
        '<span id="zv-min" title="Recolher">' + SVG.minus + '</span></div>' +
      '<div id="zv-sending" style="display:none"></div>' +
      '<div id="zv-suggest" style="display:none"></div>' +
      '<div id="zv-main"><div id="zv-content"></div><div id="zv-rail"></div></div>' +
      '<div id="zv-status"></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status'); els.sending = p.querySelector('#zv-sending');
    var head = p.querySelector('#zv-head');
    p.querySelector('#zv-min').onclick = function (e) { e.stopPropagation(); p.classList.toggle('zv-collapsed'); dockLayout(); };
    if (!window.__zvSchedIv) window.__zvSchedIv = setInterval(schedCheck, 20000);
    if (!window.__zvAutoRecIv) window.__zvAutoRecIv = setInterval(recAutoTick, 2500);   // detecta ligacao pra gravar sozinho
    renderRail(); renderContent();
    dockLayout();
  }

  function setDark(v) {
    DARK = v; var p = document.getElementById('zv-panel'); if (p) p.classList.toggle('zv-dark', DARK);
    try { localStorage.setItem('zv_dark', DARK ? '1' : '0'); } catch (_) {}
    var tb = document.getElementById('zv-theme'); if (tb) tb.innerHTML = DARK ? SVG.sun : SVG.moon;
  }

  // Barra vertical de abas (à direita), estilo ZapVoice: Itens, Funis, Agenda, Ajustes, Ajuda.
  function renderRail() {
    var rail = document.getElementById('zv-rail'); if (!rail) return;
    rail.innerHTML = TABS.map(function (t) {
      return '<button class="zv-tab' + (TAB === t.key ? ' on' : '') + '" data-tab="' + t.key + '"><span class="zv-tab-ic">' + SVG[t.icon] + '</span><span class="zv-tab-lb">' + t.label + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(rail.querySelectorAll('.zv-tab'), function (b) {
      b.onclick = function () {
        var p = document.getElementById('zv-panel');
        var key = b.getAttribute('data-tab');
        var railOnly = p && p.classList.contains('zv-railonly');
        // clicar na aba ativa (com a esquerda aberta) minimiza pra so-barra; clicar de novo abre
        if (!railOnly && key === TAB) { if (p) p.classList.add('zv-railonly'); renderRail(); dockLayout(); return; }
        if (railOnly && p) p.classList.remove('zv-railonly');
        TAB = key; try { localStorage.setItem('zv_tab', TAB); } catch (_) {}
        renderRail(); renderContent(); dockLayout();
      };
    });
  }

  function renderContent() {
    var c = document.getElementById('zv-content'); if (!c) return;
    try { recRevokeUrls(); } catch (_) {}   // libera as URLs de audio ao redesenhar/trocar de aba (nao vaza)
    if (TAB === 'funis') return renderFunisTab(c);
    if (TAB === 'agenda') return renderAgendaTab(c);
    if (TAB === 'ajustes') return renderAjustesTab(c);
    if (TAB === 'ajuda') return renderAjudaTab(c);
    if (TAB === 'gravar') return renderGravarTab(c);
    return renderItensTab(c);
  }

  // ── Aba ITENS: busca + "apenas favoritos" + filtro por tipo + esconder tudo + seções ──
  function renderItensTab(c) {
    var typeChips = TYPES.map(function (t) {
      return '<button class="zv-type' + (TYPEFILTER === t.key ? ' on' : '') + '" data-type="' + t.key + '" title="' + t.label + '" style="--tc:' + t.color + '"><span style="color:' + t.color + '">' + SVG[t.icon] + '</span></button>';
    }).join('');
    var allKeys = ['mensagens', 'audios', 'videos', 'imagens', 'documentos'];
    var anyOpen = allKeys.some(function (k) { return !COLLAPSED[k]; });
    c.innerHTML =
      '<div class="zv-ctop">' +
        '<div id="zv-search"><span class="zv-q-ic">' + SVG.search + '</span><input id="zv-q" placeholder="Buscar item..." autocomplete="off"><span id="zv-q-x" title="Limpar">&times;</span></div>' +
        '<div class="zv-toolrow"><div class="zv-types">' + typeChips + '</div>' +
          '<button id="zv-favonly" class="zv-mini' + (FAVONLY ? ' on' : '') + '" title="Apenas favoritos">' + (FAVONLY ? SVG.starFull : SVG.star) + '</button></div>' +
        '<button id="zv-hideall" class="zv-hideall">' + (anyOpen ? 'Esconder todos' : 'Mostrar todos') + '</button>' +
      '</div>' +
      '<div class="zv-cbody"><div id="zv-sections"></div></div>';
    var q = c.querySelector('#zv-q'); if (q) { q.value = FILTER; q.oninput = function () { FILTER = q.value; applyFilter(); }; }
    var qx = c.querySelector('#zv-q-x'); if (qx) qx.onclick = function () { FILTER = ''; if (q) { q.value = ''; q.focus(); } applyFilter(); };
    Array.prototype.forEach.call(c.querySelectorAll('.zv-type'), function (b) {
      b.onclick = function () { TYPEFILTER = b.getAttribute('data-type'); renderItensTab(c); };
    });
    var fo = c.querySelector('#zv-favonly'); if (fo) fo.onclick = function () { FAVONLY = !FAVONLY; renderItensTab(c); };
    var ha = c.querySelector('#zv-hideall'); if (ha) ha.onclick = function () { allKeys.forEach(function (k) { COLLAPSED[k] = anyOpen; }); lsSet('zv_collapsed', COLLAPSED); renderItensTab(c); };
    renderSections();
  }

  // (Re)desenha só a área de seções da aba Itens, respeitando tipo e "apenas favoritos".
  function renderSections() {
    var host = document.getElementById('zv-sections'); if (!host) return;
    function flt(list) { return FAVONLY ? list.filter(function (it) { return FAVS[it.id]; }) : list; }
    function show(kindKey) { return TYPEFILTER === 'all' || TYPEFILTER === kindKey; }
    var html = '';
    if (show('text')) html += section('mensagens', 'Mensagens', SVG.msg, '#2563eb', flt(DATA.messages || []).length, itemsHtml(flt(DATA.messages || [])));
    if (show('audio')) html += section('audios', 'Audios do funil', SVG.mic, '#13c273', flt(mediaByKind('audio')).length, itemsHtml(flt(mediaByKind('audio'))));
    if (show('video')) html += section('videos', 'Videos', SVG.video, '#8e17f0', flt(mediaByKind('video')).length, itemsHtml(flt(mediaByKind('video'))));
    if (show('image')) html += section('imagens', 'Imagens', SVG.image, '#00bcf2', flt(mediaByKind('image')).length, itemsHtml(flt(mediaByKind('image'))));
    if (show('document')) html += section('documentos', 'Documentos', SVG.doc, '#f0810f', flt(mediaByKind('document')).length, itemsHtml(flt(mediaByKind('document'))));
    host.innerHTML = html || '<div class="zv-empty">' + (FAVONLY ? 'Nenhum favorito ainda. Toque na estrela de um item.' : 'Nada aqui. Abra a dash (Sale Chat) e adicione itens.') + '</div>';
    bindSections(host);
    applyFilter();
  }

  function bindSections(host) {
    // Corpo do item (icone + label + seta) = abre a previa. Enviar so pelo botao verde.
    Array.prototype.forEach.call(host.querySelectorAll('.zv-item[data-exp]'), function (row) {
      row.onclick = function () { var wrap = row.parentNode; if (wrap) togglePreview(row.getAttribute('data-exp'), wrap, wrap.querySelector('.zv-exp')); };
    });
    Array.prototype.forEach.call(host.querySelectorAll('.zv-send'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); var it = itemById[b.getAttribute('data-id')]; if (it) send(it, b); };
    });
    Array.prototype.forEach.call(host.querySelectorAll('.zv-seq'), function (b) {
      b.onclick = function () { sendSequence(DATA.sequences[+b.getAttribute('data-si')], b); };
    });
    Array.prototype.forEach.call(host.querySelectorAll('.zv-star'), function (s) {
      s.onclick = function (e) { e.stopPropagation(); var id = s.getAttribute('data-fav'); if (FAVS[id]) delete FAVS[id]; else FAVS[id] = 1; lsSet('zv_favs', FAVS); renderSections(); };
    });
    Array.prototype.forEach.call(host.querySelectorAll('.zv-h[data-toggle]'), function (h) {
      h.onclick = function () { var key = h.getAttribute('data-toggle'); COLLAPSED[key] = !COLLAPSED[key]; lsSet('zv_collapsed', COLLAPSED); renderSections(); };
    });
  }

  function applyFilter() {
    var host = document.getElementById('zv-sections'); if (!host) return;
    var qx = document.getElementById('zv-q-x'); if (qx) qx.style.display = FILTER ? 'flex' : 'none';
    var q = (FILTER || '').trim().toLowerCase();
    Array.prototype.forEach.call(host.querySelectorAll('.zv-sec'), function (sec) {
      var key = sec.getAttribute('data-sec');
      var nodes = sec.querySelectorAll('.zv-subh, .zv-itemwrap, .zv-seq');
      var visible = 0, curHead = null, curHeadVis = 0;
      var flushHead = function () { if (curHead) curHead.style.display = curHeadVis ? '' : 'none'; };
      Array.prototype.forEach.call(nodes, function (n) {
        if (n.className.indexOf('zv-subh') !== -1) { flushHead(); curHead = n; curHeadVis = 0; return; }
        var lblEl = n.querySelector('.zv-label'); var lbl = lblEl ? lblEl.textContent : '';
        var grp = n.getAttribute('data-grp') || '';
        var ok = !q || lbl.toLowerCase().indexOf(q) !== -1 || grp.toLowerCase().indexOf(q) !== -1;
        n.style.display = ok ? '' : 'none';
        if (ok) { visible++; curHeadVis++; }
      });
      flushHead();
      var list = sec.querySelector('.zv-list');
      if (q) { sec.style.display = visible ? '' : 'none'; if (list) list.style.display = visible ? '' : 'none'; }
      else { sec.style.display = ''; if (list) list.style.display = COLLAPSED[key] ? 'none' : ''; }
    });
  }

  // ── Aba FUNIS ── (toque no funil = previa; botao roxo = disparar)
  function renderFunisTab(c) {
    var seqList = DATA.sequences || [];
    // Um funil (o indice ORIGINAL vai no data-fexp/data-si: disparar tem que acertar o funil certo
    // mesmo com a lista reagrupada).
    var seqRow = function (s, i) {
      return '<div class="zv-itemwrap" data-grp="' + esc(String(s.grp || '').trim()) + '">' +
        '<div class="zv-item zv-seqrow" data-fexp="' + i + '">' +
          '<span class="zv-ic zv-seq-ic">' + SVG.seq + '</span>' +
          '<span class="zv-label">' + esc(s.label) + '</span>' +
          '<button class="zv-send zv-seqsend" data-si="' + i + '" title="Disparar funil">' + SVG.play + '</button>' +
          '<span class="zv-exp" title="Prever funil">' + SVG.chevDown + '</span>' +
        '</div><div class="zv-prev" style="display:none"></div></div>';
    };
    // Agrupa por subcategoria. Sem subcategoria -> "Geral", que vem primeiro. Um grupo so = sem cabecalho.
    var groups = {}, order = [];
    seqList.forEach(function (s, i) {
      var g = String(s.grp || '').trim() || 'Geral';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push({ s: s, i: i });
    });
    var gi = order.indexOf('Geral'); if (gi > 0) { order.splice(gi, 1); order.unshift('Geral'); }
    var single = order.length <= 1;
    var inner = seqList.length ? order.map(function (g) {
      var head = single ? '' : '<div class="zv-subh" data-grp="' + esc(g === 'Geral' ? '' : g) + '">' + esc(g) + '<span class="zv-subn">' + groups[g].length + '</span></div>';
      return head + groups[g].map(function (o) { return seqRow(o.s, o.i); }).join('');
    }).join('') : '<div class="zv-empty">Nenhum funil ainda. Crie na dash (Sale Chat).</div>';
    c.innerHTML = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#8e17f0">' + SVG.funnel + '</span>Funis</div></div><div class="zv-cbody"><div class="zv-list">' + inner + '</div></div>';
    Array.prototype.forEach.call(c.querySelectorAll('.zv-seqrow'), function (row) {
      row.onclick = function () {
        var i = +row.getAttribute('data-fexp'); var wrap = row.parentNode;
        var prev = wrap.querySelector('.zv-prev'), exp = wrap.querySelector('.zv-exp');
        if (prev.style.display !== 'none') { prev.style.display = 'none'; prev.innerHTML = ''; exp.classList.remove('open'); }
        else { prev.style.display = 'block'; exp.classList.add('open'); prev.innerHTML = funnelPreviewHtml(DATA.sequences[i]); }
      };
    });
    Array.prototype.forEach.call(c.querySelectorAll('.zv-seqsend'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); sendSequence(DATA.sequences[+b.getAttribute('data-si')], b); };
    });
  }
  // Previa do funil: passos em ordem com item, espera e simulacao, + tempo total estimado.
  function funnelPreviewHtml(seq) {
    var steps = (seq.items || []).map(normStep);
    if (!steps.length) return '<div class="zv-prev-note">Funil sem passos. Adicione na dash.</div>';
    var total = 0;
    var rows = steps.map(function (st, j) {
      var it = itemById[st.id];
      var label = it ? it.label : '(item removido)';
      var kindTxt = it ? ({ text: 'msg', audio: 'audio', video: 'video', image: 'imagem', document: 'doc' }[it.kind] || '') : '';
      var simMs = st.sim ? st.sim * 1000 : (it && it.kind === 'audio' ? (it.durMs || 3000) : (it && it.kind === 'text' ? 1200 : 800));
      total += Math.max(0, st.delay || 0) * 1000 + simMs;
      var timing = 'espera ' + (st.delay || 0) + 's' + (st.sim ? ' + simula ' + st.sim + 's' : '');
      return '<div class="zv-fp-step"><span class="zv-fp-n">' + (j + 1) + '</span><span class="zv-fp-lb">' + esc(label) + (kindTxt ? ' <i>(' + kindTxt + ')</i>' : '') + '</span><span class="zv-fp-t">' + timing + '</span></div>';
    }).join('');
    var secs = Math.round(total / 1000);
    var totalTxt = secs >= 60 ? (Math.floor(secs / 60) + 'min ' + (secs % 60) + 's') : (secs + 's');
    var stopTxt = seq.stopOnReply ? 'Para se o lead responder no meio.' : 'Continua mesmo se o lead responder.';
    return '<div class="zv-fp">' + rows + '<div class="zv-fp-foot">~' + totalTxt + ' no total · ' + stopTxt + '</div></div>';
  }

  // ── Aba AGENDA ──
  function renderAgendaTab(c) {
    c.innerHTML = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#00bcf2">' + SVG.calendar + '</span>Agenda</div><p class="zv-tabhint">Programa um item pra sair depois de X minutos no chat aberto.</p></div><div class="zv-cbody"><div id="zv-sched"></div></div>';
    schedRender();
  }

  // ── Aba AJUSTES ──
  function renderAjustesTab(c) {
    c.innerHTML = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#54656f">' + SVG.sliders + '</span>Ajustes</div></div>' +
      '<div class="zv-cbody"><div class="zv-set">' +
        '<label class="zv-setrow"><span>Simular gravando / digitando</span><input type="checkbox" id="zv-sim-cb"' + (simulate ? ' checked' : '') + '></label>' +
        '<label class="zv-setrow"><span>Gravar as ligacoes automaticamente</span><input type="checkbox" id="zv-autorec-cb"' + (autoRec ? ' checked' : '') + '></label>' +
        '<div class="zv-setrow"><span>Tema do painel</span><button id="zv-theme2" class="zv-mini2">' + (DARK ? 'Escuro' : 'Claro') + '</button></div>' +
        '<p class="zv-tabhint">Simular deixa mais humano: mostra "gravando..." / "digitando..." antes de enviar.</p>' +
        '<p class="zv-tabhint">Gravar automatico: comeca a gravar sozinho quando voce ligar (ou receber ligacao) e para quando a chamada acaba. A gravacao aparece na aba Gravar.</p>' +
      '</div></div>';
    var cb = c.querySelector('#zv-sim-cb'); if (cb) cb.onchange = function () { simulate = cb.checked; };
    var ar = c.querySelector('#zv-autorec-cb'); if (ar) ar.onchange = function () { autoRec = ar.checked; try { localStorage.setItem('zv_autorec', autoRec ? '1' : '0'); } catch (_) {} };
    var t2 = c.querySelector('#zv-theme2'); if (t2) t2.onclick = function () { setDark(!DARK); t2.textContent = DARK ? 'Escuro' : 'Claro'; };
  }

  // ── Aba AJUDA ──
  function renderAjudaTab(c) {
    c.innerHTML = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#13c273">' + SVG.help + '</span>Ajuda</div></div>' +
      '<div class="zv-cbody"><div class="zv-help">' +
        '<p><b>Itens:</b> clique num item pra enviar no chat aberto. A estrela favorita.</p>' +
        '<p><b>Funis:</b> dispara varios itens em sequencia, com a espera de cada passo.</p>' +
        '<p><b>Agenda:</b> programa um item pra sair depois de X minutos.</p>' +
        '<p><b>Ajustes:</b> liga o "simular gravando" e troca o tema.</p>' +
        '<p><b>Gravar:</b> grava a ligacao de voz (as duas vozes) pra guardar o registro do lead confirmando o termo.</p>' +
        '<p class="zv-tabhint">Os itens sao configurados na dash (Sale Chat). O painel puxa sozinho.</p>' +
      '</div></div>';
  }

  // ══════════════ GRAVACAO DE CHAMADA ══════════════
  // Pega as faixas de audio das chamadas WebRTC vivas: receivers = voz do LEAD, senders = SUA voz.
  function callParts() {
    var remote = [], local = [], seen = [], alive = [];
    (window.__zvPCs || []).forEach(function (pc) {
      try {
        // pc.close() nao dispara connectionstatechange (spec), entao o listener nao limpa a lista.
        // Podamos aqui: descarta conexao morta (nao vaza) e nunca coleta faixa de chamada encerrada.
        var st = pc.connectionState || pc.iceConnectionState;
        if (pc.signalingState === 'closed' || st === 'closed' || st === 'failed') return;
        alive.push(pc);
        (pc.getReceivers ? pc.getReceivers() : []).forEach(function (r) { var t = r && r.track; if (t && t.kind === 'audio' && t.readyState === 'live' && seen.indexOf(t) < 0) { seen.push(t); remote.push(t); } });
        (pc.getSenders ? pc.getSenders() : []).forEach(function (s) { var t = s && s.track; if (t && t.kind === 'audio' && t.readyState === 'live' && seen.indexOf(t) < 0) { seen.push(t); local.push(t); } });
      } catch (_) {}
    });
    try { window.__zvPCs = alive; } catch (_) {}   // fica so com as conexoes vivas
    return { remote: remote, local: local };
  }
  // Faixas de audio dos <audio>/<video> tocando na pagina (o WhatsApp toca a voz do lead por um).
  function mediaElAudioTracks() {
    var out = [], seen = [];
    try {
      var els = document.querySelectorAll('audio,video');
      for (var i = 0; i < els.length; i++) {
        var so = els[i].srcObject;
        if (so && so.getAudioTracks) so.getAudioTracks().forEach(function (t) { if (t && t.readyState === 'live' && seen.indexOf(t) < 0) { seen.push(t); out.push(t); } });
      }
    } catch (_) {}
    return out;
  }
  function recFmtDur(ms) { var s = Math.max(0, Math.round(ms / 1000)); var m = Math.floor(s / 60); s = s % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function recFmtWhen(at) { try { var d = new Date(at); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); } catch (_) { return ''; } }
  function recToast(m) { try { status(m, 'err'); } catch (_) {} }

  async function recStart() {
    // Guard SINCRONO, antes de qualquer await: recStart e async (espera resume + getUserMedia).
    // Sem isto, 2 cliques rapidos criavam 2 gravacoes e deixavam um microfone preso aberto.
    if (rec.on || rec.starting) return;
    rec.starting = true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || typeof MediaRecorder === 'undefined') { rec.starting = false; if (!rec.auto) recToast('Este WhatsApp nao suporta gravacao aqui.'); return; }
      var c = activeChat();
      rec.chatId = c ? chatIdOf(c) : ''; rec.chatName = c ? chatName(c) : '';
      var ac = new AC();
      try { if (ac.state === 'suspended') await ac.resume(); } catch (_) {}
      var dest = ac.createMediaStreamDestination();
      var mix = [], has = function (t) { for (var i = 0; i < mix.length; i++) if (mix[i].track === t) return true; return false; };
      rec.capStreams = [];
      var diag = { pc: 0, cap: 0, recv: 0, src: 0, mic: 0 };
      try { diag.pc = (window.__zvPCs || []).length; } catch (_) {}
      // ── VOZ DO LEAD ── tentativas em ordem de confiabilidade ──
      // 1) captureStream() dos <audio>/<video> tocando: pega a SAIDA decodificada do elemento (o
      //    som do lead que voce ouve), sem o bug de faixa remota muda no WebAudio.
      try {
        var els = document.querySelectorAll('audio,video');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!(el.srcObject || (!el.paused && el.readyState >= 2))) continue;
          var cs = null;
          try { cs = el.captureStream ? el.captureStream() : (el.mozCaptureStream ? el.mozCaptureStream() : null); } catch (_) {}
          if (cs && cs.getAudioTracks) { rec.capStreams.push(cs); cs.getAudioTracks().forEach(function (t) { if (t && t.readyState === 'live' && !has(t)) { mix.push({ track: t, remote: true }); diag.cap++; } }); }
        }
      } catch (_) {}
      // 2) fallback: faixas dos receivers (voz do lead) COM bombeamento — so se o captureStream falhou
      var parts = callParts();
      diag.recv = parts.remote.length;
      if (!diag.cap) parts.remote.forEach(function (t) { if (!has(t)) mix.push({ track: t, remote: true, pump: true }); });
      // 3) fallback: faixas de srcObject dos elementos COM bombeamento — ultimo recurso
      if (!diag.cap && !parts.remote.length) mediaElAudioTracks().forEach(function (t) { if (!has(t)) { mix.push({ track: t, remote: true, pump: true }); diag.src++; } });
      // ── SUA VOZ ── sempre pelo microfone (garantido; roda junto com o WhatsApp)
      try {
        var mic = await navigator.mediaDevices.getUserMedia({ audio: true }); rec.micStream = mic;
        mic.getAudioTracks().forEach(function (t) { if (!has(t)) { mix.push({ track: t, remote: false }); diag.mic = 1; } });
      } catch (_) { parts.local.forEach(function (t) { if (!has(t)) mix.push({ track: t, remote: false }); }); }
      rec.hadRemote = (diag.cap + diag.recv + diag.src) > 0;
      rec.micOnly = !rec.hadRemote;
      rec.diag = 'pc' + diag.pc + ' cap' + diag.cap + ' recv' + diag.recv + ' src' + diag.src + ' mic' + diag.mic;
      if (!mix.length) { try { ac.close(); } catch (_) {} rec.starting = false; if (!rec.auto) recToast('Nao consegui captar audio. Comece a ligacao e tente de novo.'); return; }
      mix.forEach(function (m) {
        try {
          var ms = new MediaStream([m.track]);
          var s = ac.createMediaStreamSource(ms); s.connect(dest); rec.sources.push(s);
          // Faixa remota via WebAudio pode sair MUDA no Chromium; um <audio> mudo tocando ela faz
          // os samples fluirem. So nas faixas marcadas pump (as do captureStream ja vem audiveis).
          if (m.pump) { var sink = new Audio(); sink.muted = true; sink.srcObject = ms; var pr = sink.play(); if (pr && pr.catch) pr.catch(function () {}); rec.sinks.push(sink); }
        } catch (_) {}
      });
      var mime = (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus'
               : (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) ? 'audio/webm' : '';
      rec.mime = mime || 'audio/webm';
      rec.chunks = [];
      rec.mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      rec.mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.mr.onstop = function () { recFinalize(); };
      rec.mr.onerror = function () { try { recStop(); } catch (_) {} };
      rec.ac = ac; rec.dest = dest; rec.startAt = Date.now(); rec.on = true; rec.starting = false;
      rec.mr.start(2000);   // fatia a cada 2s, pra gravacao longa nao ficar so na memoria
      rec.tickIv = setInterval(recRenderLive, 1000);
      if (TAB === 'gravar') renderContent();
    } catch (e) { var wasAuto = rec.auto; recCleanup(); if (!wasAuto) recToast('Falha ao iniciar: ' + ((e && e.message) || e)); if (TAB === 'gravar') renderContent(); }
  }
  function recStop() { try { if (rec.mr && rec.mr.state !== 'inactive') { rec.mr.stop(); return; } } catch (_) {} recCleanup(); if (TAB === 'gravar') renderContent(); }
  function recFinalize() {
    try {
      var dur = Date.now() - rec.startAt;
      var blob = new Blob(rec.chunks.slice(), { type: rec.mime });
      if (blob.size > 0) {
        var at = Date.now();
        var defDesc = 'Gravacao da chamada · ' + recFmtWhen(at);   // descricao automatica (editavel)
        var meta = { id: 'rec' + at.toString(36) + Math.random().toString(36).slice(2, 5), chatId: rec.chatId || '', chatName: rec.chatName || '', at: at, durMs: dur, desc: defDesc, mime: rec.mime, micOnly: !!rec.micOnly, remote: !!rec.hadRemote, diag: rec.diag || '', size: blob.size };
        recPut(meta, blob).then(function () { if (TAB === 'gravar') renderContent(); }, function () { recToast('Nao consegui salvar a gravacao (armazenamento cheio?).'); });
      }
    } catch (_) {}
    recCleanup();
    if (TAB === 'gravar') renderContent();
  }
  function recCleanup() {
    // NUNCA parar as faixas da CHAMADA (sao do WhatsApp). So o nosso proprio microfone.
    try { rec.sources.forEach(function (s) { try { s.disconnect(); } catch (_) {} }); } catch (_) {}
    // Solta os <audio> mudos que usamos so pra "bombear" as faixas (nao para as faixas da chamada).
    try { rec.sinks.forEach(function (s) { try { s.pause(); s.srcObject = null; } catch (_) {} }); } catch (_) {}
    // Para as capturas (captureStream) e o microfone PROPRIO. Nunca as faixas da chamada.
    try { rec.capStreams.forEach(function (st) { try { st.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} }); } catch (_) {}
    try { if (rec.micStream) rec.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} }); } catch (_) {}
    try { if (rec.ac && rec.ac.state !== 'closed') rec.ac.close(); } catch (_) {}
    if (rec.tickIv) { clearInterval(rec.tickIv); rec.tickIv = null; }
    rec.on = false; rec.starting = false; rec.auto = false; rec.mr = null; rec.chunks = []; rec.sources = []; rec.sinks = []; rec.capStreams = []; rec.ac = null; rec.dest = null; rec.micStream = null;
  }
  // Grava sozinho quando ha ligacao (se ligado no Ajustes); para sozinho quando a ligacao acaba.
  function recAutoTick() {
    try {
      if (!autoRec) return;
      var p = callParts(), has = p.remote.length > 0 || p.local.length > 0;
      if (!has) {
        recAutoArmed = true;                       // ligacao acabou: pronto pra proxima
        if (rec.on && rec.auto) recStop();          // para so a gravacao que o AUTO comecou
        return;
      }
      // ha ligacao: comeca UMA vez (se o atendente parar na mao, nao reinicia nesta ligacao)
      if (recAutoArmed && !rec.on && !rec.starting) {
        if (Date.now() - recAutoLast < 8000) return;
        recAutoLast = Date.now(); recAutoArmed = false; rec.auto = true; recStart();
      }
    } catch (_) {}
  }
  function recRenderLive() { if (TAB !== 'gravar') return; var t = document.getElementById('zv-rec-timer'); if (t && rec.on) t.textContent = recFmtDur(Date.now() - rec.startAt); }

  // ── Armazenamento local (IndexedDB): metadados numa store, o audio em outra (lista leve) ──
  var REC_DB = 'zvRecDB';
  function recDB() {
    return new Promise(function (res, rej) {
      try {
        var rq = indexedDB.open(REC_DB, 1);
        rq.onupgradeneeded = function () { var db = rq.result; if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' }); if (!db.objectStoreNames.contains('blob')) db.createObjectStore('blob', { keyPath: 'id' }); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      } catch (e) { rej(e); }
    });
  }
  function recPut(meta, blob) {
    return recDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(['meta', 'blob'], 'readwrite');
        tx.objectStore('meta').put(meta); tx.objectStore('blob').put({ id: meta.id, blob: blob });
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function recAllMeta() {
    return recDB().then(function (db) {
      return new Promise(function (res) {
        var out = [], tx = db.transaction('meta', 'readonly'), cur = tx.objectStore('meta').openCursor();
        cur.onsuccess = function () { var c = cur.result; if (c) { out.push(c.value); c.continue(); } else { out.sort(function (a, b) { return b.at - a.at; }); res(out); } };
        cur.onerror = function () { res(out); };
      });
    }).catch(function () { return []; });
  }
  function recBlob(id) { return recDB().then(function (db) { return new Promise(function (res) { var g = db.transaction('blob', 'readonly').objectStore('blob').get(id); g.onsuccess = function () { res(g.result ? g.result.blob : null); }; g.onerror = function () { res(null); }; }); }); }
  function recDel(id) { return recDB().then(function (db) { return new Promise(function (res) { var tx = db.transaction(['meta', 'blob'], 'readwrite'); tx.objectStore('meta').delete(id); tx.objectStore('blob').delete(id); tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); }; }); }); }
  function recSetDesc(id, desc) { return recDB().then(function (db) { return new Promise(function (res) { var tx = db.transaction('meta', 'readwrite'), st = tx.objectStore('meta'), g = st.get(id); g.onsuccess = function () { var v = g.result; if (v) { v.desc = desc; st.put(v); } }; tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); }; }); }); }

  var recUrls = {}, recAudios = {};
  function recRevokeUrls() {
    try { Object.keys(recAudios).forEach(function (k) { try { var a = recAudios[k]; if (a) { a.pause(); a.src = ''; } } catch (_) {} }); } catch (_) {}
    recAudios = {};
    try { Object.keys(recUrls).forEach(function (k) { try { URL.revokeObjectURL(recUrls[k]); } catch (_) {} }); } catch (_) {}
    recUrls = {};
  }
  // Player proprio de uma gravacao: play/pause + barra clicavel + tempo. Ja aparece na lista; o
  // audio (blob) so e carregado ao tocar pela 1a vez, entao a lista nao pesa a memoria.
  function recWirePlayer(row, id, durMs) {
    var pp = row.querySelector('.zv-rec-pp'), bar = row.querySelector('.zv-rec-bar'),
        fill = row.querySelector('.zv-rec-fill'), timeEl = row.querySelector('.zv-rec-time');
    if (!pp) return;
    var audio = null, loading = false;
    function fmt(s) { s = Math.max(0, Math.round(s || 0)); var m = Math.floor(s / 60); s = s % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
    function total() { return (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (durMs / 1000); }
    function paint() {
      var cur = audio ? audio.currentTime : 0, tot = total();
      if (fill) fill.style.width = (tot > 0 ? Math.min(100, cur / tot * 100) : 0) + '%';
      if (timeEl) timeEl.textContent = fmt(cur) + ' / ' + fmt(tot);
      if (pp) pp.innerHTML = (audio && !audio.paused) ? SVG.pause : SVG.play;
    }
    function ensure(cb) {
      if (audio) { cb(); return; }
      if (loading) return; loading = true;
      recBlob(id).then(function (b) {
        loading = false;
        if (!b) { recToast('Gravacao nao encontrada.'); return; }
        var url = URL.createObjectURL(b); recUrls[id] = url;
        audio = new Audio(url); recAudios[id] = audio;
        audio.ontimeupdate = paint; audio.onended = paint; audio.onloadedmetadata = paint; audio.onplay = paint; audio.onpause = paint;
        cb();
      }, function () { loading = false; recToast('Nao consegui carregar a gravacao.'); });
    }
    pp.onclick = function () { ensure(function () { if (audio.paused) audio.play(); else audio.pause(); }); };
    if (bar) bar.onclick = function (e) {
      ensure(function () { var rct = bar.getBoundingClientRect(), f = (e.clientX - rct.left) / rct.width, tot = total(); if (tot > 0) { audio.currentTime = Math.max(0, Math.min(tot, f * tot)); if (audio.paused) audio.play(); paint(); } });
    };
    paint();
  }

  function renderGravarTab(c) {
    recRevokeUrls();
    var parts = callParts(), callLive = parts.remote.length > 0 || parts.local.length > 0;
    var head = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#e0405a">' + SVG.rec + '</span>Gravar chamada</div>' +
      '<p class="zv-tabhint">Grava a ligacao de voz (as duas vozes) para guardar no seu computador.</p></div>';
    var card;
    if (rec.on) {
      card = '<div class="zv-rec-card zv-rec-live">' +
        '<div class="zv-rec-dotlive"></div>' +
        '<div class="zv-rec-livetxt"><b id="zv-rec-timer">' + recFmtDur(Date.now() - rec.startAt) + '</b><span>Gravando' + (rec.chatName ? (' · ' + esc(rec.chatName)) : '') + (rec.micOnly ? ' · so seu microfone' : '') + '</span></div>' +
        '<button class="zv-rec-btn zv-rec-stop" id="zv-rec-toggle">' + SVG.stopsq + ' Parar</button>' +
        '</div>';
    } else {
      card = '<div class="zv-rec-card">' +
        '<button class="zv-rec-btn zv-rec-go" id="zv-rec-toggle">' + SVG.rec + ' Comecar a gravar</button>' +
        '<div class="zv-rec-hint2">' + (callLive ? '<span class="zv-rec-ok">Chamada detectada</span>' : (autoRec ? 'Gravacao automatica ligada. Ou clique pra gravar agora.' : 'Comeca a gravar na hora. Se houver ligacao, grava as duas vozes.')) + '</div>' +
        '</div>';
    }
    c.innerHTML = head + '<div class="zv-cbody">' + card + '<div id="zv-rec-list" class="zv-rec-list"><div class="zv-tabhint" style="padding:8px 2px">Carregando...</div></div></div>';
    var tg = document.getElementById('zv-rec-toggle');
    if (tg) tg.onclick = function () { if (rec.on) recStop(); else { rec.auto = false; recStart(); } };
    recAllMeta().then(recFillList);
  }
  function recFillList(list) {
    var box = document.getElementById('zv-rec-list'); if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="zv-tabhint" style="padding:8px 2px">Nenhuma gravacao ainda.</div>'; return; }
    box.innerHTML = list.map(function (r) {
      var meta = recFmtWhen(r.at) + ' · ' + recFmtDur(r.durMs || 0) + (r.micOnly ? ' · so microfone' : (r.remote === false ? ' · sem voz do lead' : ''));
      return '<div class="zv-rec-row" data-id="' + esc(r.id) + '">' +
        '<div class="zv-rec-main">' +
          '<div class="zv-rec-rtop"><b>' + esc(r.chatName || '(sem lead)') + '</b><span class="zv-rec-meta">' + esc(meta) + '</span></div>' +
          (r.diag ? '<div class="zv-rec-diag">debug: ' + esc(r.diag) + '</div>' : '') +
          '<input class="zv-rec-desc" placeholder="Descricao" value="' + esc(r.desc || '') + '">' +
          // Player proprio (combina com o card). Ja aparece; o audio so carrega ao tocar (leve).
          '<div class="zv-rec-player">' +
            '<button class="zv-rec-pp" title="Ouvir">' + SVG.play + '</button>' +
            '<div class="zv-rec-bar"><div class="zv-rec-fill"></div></div>' +
            '<span class="zv-rec-time">0:00 / ' + recFmtDur(r.durMs || 0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="zv-rec-acts">' +
          '<button class="zv-rec-dl" title="Baixar">' + SVG.dl + '</button>' +
          '<button class="zv-rec-del" title="Excluir">' + SVG.trash + '</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.zv-rec-row'), function (row) {
      var id = row.getAttribute('data-id');
      var meta = list.filter(function (x) { return x.id === id; })[0] || {};
      var di = row.querySelector('.zv-rec-desc');
      // Salva ENQUANTO digita (debounced): se o painel se redesenhar (auto-update da config), o
      // texto ja esta no banco e volta certinho, em vez de sumir.
      if (di) { di.oninput = function () { clearTimeout(di._t); di._t = setTimeout(function () { recSetDesc(id, di.value); }, 400); }; di.onchange = function () { clearTimeout(di._t); recSetDesc(id, di.value); }; }
      recWirePlayer(row, id, meta.durMs || 0);
      var db = row.querySelector('.zv-rec-dl');
      if (db) db.onclick = function () {
        recBlob(id).then(function (b) {
          if (!b) { recToast('Gravacao nao encontrada.'); return; }
          var url = URL.createObjectURL(b);
          var nm = ('chamada-' + (meta.chatName || 'lead') + '-' + recFmtWhen(meta.at)).replace(/[^\w\-]+/g, '_') + '.webm';
          var a = document.createElement('a'); a.href = url; a.download = nm; document.body.appendChild(a); a.click();
          setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (_) {} }, 1000);
        });
      };
      var xb = row.querySelector('.zv-rec-del');
      if (xb) xb.onclick = function () { if (!confirm('Excluir esta gravacao?')) return; recDel(id).then(function () { if (TAB === 'gravar') renderContent(); }); };
    });
  }

  function restorePos(p) {
    try {
      var s = localStorage.getItem('zv_pos2');
      if (s) { var a = s.split('|'); p.style.right = 'auto'; p.style.bottom = 'auto'; p.style.left = a[0]; p.style.top = a[1]; }
    } catch (_) {}
  }
  function makeDraggable(p, handle) {
    var drag = false, sx, sy, ox, oy;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('#zv-min,#zv-theme')) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      var r = p.getBoundingClientRect(); ox = r.left; oy = r.top;
      p.style.right = 'auto'; p.style.bottom = 'auto'; p.style.left = ox + 'px'; p.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      p.style.left = nx + 'px'; p.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', function () { if (drag) { drag = false; try { localStorage.setItem('zv_pos2', p.style.left + '|' + p.style.top); } catch (_) {} } });
  }

  function status(m, k) { if (els.status) { els.status.textContent = m; els.status.className = k || ''; } }
  // Banner "Envios": pilha do que esta sendo enviado AGORA. Cada linha = um job (item/funil ->
  // lead) com seu progresso e um Pausar proprio. Ao pausar, a linha mostra "Parando..." na hora
  // (feedback claro) e some quando o envio para de fato. Some tudo quando nao ha job ativo.
  function renderSending() {
    // rebusca o elemento se a referencia sumiu (senao o envio rodava sem aparecer no banner)
    var el = els.sending || (els.sending = document.getElementById('zv-sending'));
    if (!el) return;
    if (!jobs.length) { el.style.display = 'none'; el.innerHTML = ''; try { dockLayout(); } catch (_) {} return; }
    el.innerHTML = jobs.map(function (j, idx) {
      var waiting = !j.started;
      var stopping = j.started && j.stop;
      var sub = stopping ? 'Parando…'
              : waiting ? ('Na fila · ' + idx + (idx === 1 ? ' na frente' : ' na frente'))
              : (j.sub || '');
      var cls = 'zv-snd-row' + (stopping ? ' zv-snd-stopping' : '') + (waiting ? ' zv-snd-wait' : '');
      // Mesmo "Parando…" mantem botao: se o envio empacar, o atendente forca a saida e a fila anda.
      var btn = stopping
        ? '<button class="zv-snd-stop" data-job="' + j.id + '" data-force="1">' + SVG.pause + ' Forçar saída</button>'
        : '<button class="zv-snd-stop" data-job="' + j.id + '">' + SVG.pause + (waiting ? ' Tirar da fila' : ' Pausar') + '</button>';
      return '<div class="' + cls + '">' +
        '<span class="zv-snd-spin"></span>' +
        '<div class="zv-snd-txt"><b>' + esc(j.name) + (j.chatName ? ' <em class="zv-snd-to">&rarr; ' + esc(j.chatName) + '</em>' : '') + '</b>' +
          '<span>' + esc(sub) + '</span></div>' + btn +
        '</div>';
    }).join('');
    el.style.display = 'block';
    Array.prototype.forEach.call(el.querySelectorAll('.zv-snd-stop'), function (btn) {
      btn.onclick = function (e) { e.stopPropagation(); jobStop(btn.getAttribute('data-job'), btn.getAttribute('data-force') === '1'); };
    });
    try { dockLayout(); } catch (_) {}
  }

  // Envia UM item e resolve {ok,err} quando terminar (SEMPRE resolve, nunca rejeita).
  // forceChatId: manda pra um chat especifico (usado no agendamento), senao o aberto.
  function sendItemAsync(item, forceChatId, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
     try {
      if (!item) { resolve({ ok: false, err: 'item nao encontrado' }); return; }
      var chatId;
      if (forceChatId) { chatId = forceChatId; }
      else {
        var c = activeChat();
        if (!c) { resolve({ ok: false, err: 'sem conversa aberta' }); return; }
        if (c.isGroup) { resolve({ ok: false, err: 'e um grupo' }); return; }
        chatId = chatIdOf(c);
      }
      if (!chatId) { resolve({ ok: false, err: 'sem conversa aberta' }); return; }
      if (item.kind === 'video') {
        // Video vem do injetor (base64 via CDP), pra fugir do bloqueio de fetch do WhatsApp.
        // O alvo (chatId capturado) fica em videoTargets[rid] pro __zvDoSend mandar pro lead
        // certo. Enfileira (um por vez) pra dois videos nao brigarem pelo slot __zvReq.
        var rid = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
        videoTargets[rid] = chatId;
        videoQueue.push({ rid: rid, resolve: resolve, stopFn: opts.stopFn, req: { id: rid, file: item.file, url: item.mediaUrl, caption: item.caption || '', chatId: chatId } });
        pumpVideoQueue();
        return;
      }
      if (item.kind === 'image') {
        withTimeout(window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'image', caption: item.caption || '' }), 120000, 'imagem').then(resolve);
        return;
      }
      if (item.kind === 'document') {
        withTimeout(window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'document', caption: item.caption || '', filename: item.label || 'documento' }), 120000, 'documento').then(resolve);
        return;
      }
      if (item.kind === 'text') {
        var stMs = opts.simMs > 0 ? opts.simMs : 1200;
        var preT = Promise.resolve();
        if (simulate) { try { preT = withTimeout(window.WPP.chat.markIsComposing(chatId, stMs + 300), 8000, 'digitando'); } catch (_) {} }
        preT.then(function () { return sleepStop(stMs, opts.stopFn); })
          .then(function (stopped) {
            if (stopped) { resolve({ ok: false, cancelled: true }); return; }
            return withTimeout(window.WPP.chat.sendTextMessage(chatId, item.text || ''), 60000, 'texto').then(resolve);
          })
          .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
        return;
      }
      var dur = opts.simMs > 0 ? opts.simMs : (item.durMs || 3000);
      var pre = Promise.resolve();
      if (simulate) { try { pre = withTimeout(window.WPP.chat.markIsRecording(chatId, dur), 8000, 'gravando'); } catch (_) {} }
      pre.then(function () { return sleepStop(dur, opts.stopFn); })
        .then(function (stopped) {
          if (stopped) { resolve({ ok: false, cancelled: true }); return; }
          return withTimeout(window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'audio', isPtt: true }), 120000, 'audio').then(resolve);
        })
        .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
     } catch (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); }
    });
  }

  // Nome do lead da conversa capturada (pro banner mostrar pra quem vai).
  function chatName(c) { return (c && ((c.contact && (c.contact.name || c.contact.pushname)) || c.formattedTitle || (c.id && c.id.user))) || ''; }
  // Envia UM item: cria um job e mostra na pilha. Alvo travado no clique.
  function send(item, b) {
    if (!item) return;
    if (!wppCanSend()) { status(ZV_ENGINE_ERR + ' [' + engineDiag() + ']', 'err'); return; }
    try { _healStores(); } catch (_) {}   // ChatStore sumido? recupera antes de enviar
    var c = activeChat();
    if (!c || c.isGroup) { status(c && c.isGroup ? 'Isso e um grupo; abra um lead' : ('Abra a conversa de um lead [' + engineDiag() + ']'), 'err'); return; }
    var chatId = chatIdOf(c);
    if (!chatId) { status('Abra a conversa de um lead [' + engineDiag() + ']', 'err'); return; }
    for (var k = 0; k < jobs.length; k++) { if (jobs[k].chatId === chatId && jobs[k].itemId === item.id) { status('Esse item ja esta na fila pra esse lead', 'err'); return; } }
    var kindLbl = { text: 'Mensagem', audio: 'Áudio', video: 'Vídeo', image: 'Imagem', document: 'Documento' }[item.kind] || 'Item';
    var who = chatName(c);
    jobAdd({
      id: jobId(), kind: 'item', itemId: item.id, chatId: chatId, chatName: who,
      name: item.label || kindLbl, sub: '', stop: false, started: false,
      budgetMs: item.kind === 'video' ? 480000 : 300000,
      run: function (j) {
        // re-resolve o item AGORA: ele pode ter sido editado na dash enquanto esperava na fila
        var it = itemById[item.id] || item;
        j.sub = (it.kind === 'text' ? (simulate ? 'Digitando…' : 'Enviando…') : it.kind === 'audio' ? (simulate ? 'Gravando…' : 'Enviando…') : ('Enviando ' + kindLbl.toLowerCase() + '…'));
        renderSending();
        return sendItemAsync(it, j.chatId, { stopFn: function () { return j.stop; } }).then(function (r) {
          status(r.cancelled ? ('Cancelado (' + who + ')') : (r.ok ? ('Enviado -> ' + who) : ('Falha -> ' + who + ': ' + (r.err || '') + ' [' + engineDiag() + ']')), (r.ok && !r.cancelled) ? 'ok' : 'err');
        });
      },
    });
  }

  // Passo de funil: id do item + delay (espera antes, s) + sim (duracao gravando/digitando, s; 0=auto).
  function normStep(raw) { return (typeof raw === 'string') ? { id: raw, delay: 0, sim: 0 } : { id: (raw && raw.id) || '', delay: (raw && +raw.delay) || 0, sim: (raw && +raw.sim) || 0 }; }
  // Dispara os passos em ordem: cria um job (concorrente). Cada clique num funil manda pro lead
  // aberto NAQUELE momento; da pra ter varios funis indo pra leads diferentes ao mesmo tempo.
  function sendSequence(seq, b) {
    if (!seq) return;
    var steps = (seq.items || []).map(normStep).filter(function (s) { return itemById[s.id]; });
    if (!steps.length) { status('Sequencia vazia', 'err'); return; }
    if (!wppCanSend()) { status(ZV_ENGINE_ERR + ' [' + engineDiag() + ']', 'err'); return; }
    try { _healStores(); } catch (_) {}   // ChatStore sumido? recupera antes de enviar
    var c = activeChat();
    if (!c || c.isGroup) { status('Abra a conversa de um lead [' + engineDiag() + ']', 'err'); return; }
    var chatId = chatIdOf(c);
    if (!chatId) { status('Abra a conversa de um lead [' + engineDiag() + ']', 'err'); return; }  // sem alvo travado, nem comeca
    for (var k = 0; k < jobs.length; k++) { if (jobs[k].chatId === chatId && jobs[k].seqId === seq.id) { status('Esse funil ja esta na fila pra esse lead', 'err'); return; } }
    var who = chatName(c);
    jobAdd({
      id: jobId(), kind: 'funil', seqId: seq.id, chatId: chatId, chatName: who,
      name: 'Funil: ' + (seq.label || 'Funil'), sub: '', stop: false, started: false,
      stopOnReply: !!seq.stopOnReply,
      budgetMs: steps.reduce(function (a, st) { return a + (st.delay || 0) * 1000 + (st.sim || 0) * 1000; }, 0) + steps.length * 180000 + 60000,
      run: function (job) {
        return new Promise(function (done) {
          var stopFn = function () { return job.stop; };
          function finish(how, err) {
            status(how === 'ok' ? ('Funil enviado (' + steps.length + ') -> ' + who) : how === 'parado' ? ('Funil parado -> ' + who) : ('Falha no funil -> ' + who + (err ? ': ' + err : '')), how === 'ok' ? 'ok' : 'err');
            done();
          }
          var i = 0;
          (function next() {
            if (job.stop) { finish('parado'); return; }
            if (i >= steps.length) { finish('ok'); return; }
            var it = itemById[steps[i].id];
            if (!it) { i++; setTimeout(next, 0); return; }   // item apagado na dash no meio: pula
            var wait = Math.max(0, steps[i].delay || 0) * 1000;
            if (wait > 0) { job.sub = 'Aguardando ' + steps[i].delay + 's · próximo passo ' + (i + 1) + '/' + steps.length + ' (' + it.label + ')'; renderSending(); }
            // Espera checando o stop a cada 500ms, pro Pausar responder rapido.
            var waited = 0;
            (function waitLoop() {
              if (job.stop) { finish('parado'); return; }
              if (waited >= wait) {
                job.sub = 'Enviando passo ' + (i + 1) + ' de ' + steps.length + ' · ' + it.label; renderSending();
                sendItemAsync(itemById[steps[i].id], job.chatId, { simMs: steps[i].sim ? steps[i].sim * 1000 : 0, stopFn: stopFn }).then(function (r) {
                  i++;
                  if (job.stop) { finish('parado'); return; }
                  if (!r.ok && !r.cancelled) { finish('falha', r.err); return; }
                  setTimeout(next, 400);
                });
                return;
              }
              var step = Math.min(500, wait - waited);
              setTimeout(function () { waited += step; waitLoop(); }, step);
            })();
          })();
        });
      },
    });
  }

  function poll() {
    window.__zvPollIv = setInterval(function () {
      var pnl = document.getElementById('zv-panel');
      if (pnl && !pnl.classList.contains('zv-collapsed')) dockLayout();
      if (!els.who) return;
      // Motor morto: fala a verdade em vez de mandar "abra uma conversa" (o atendente
      // ficava tentando abrir a conversa que JA estava aberta).
      if (!wppCanSend()) { els.dot.className = 'zv-off'; els.who.textContent = 'motor nao carregou (use o WhatsApp normal)'; return; }
      var a = activeInfo();
      if (a) { els.dot.className = 'zv-on'; els.who.textContent = a.isGroup ? 'grupo (abra um lead)' : (a.name ? ('→ ' + a.name) : '→ abra uma conversa'); }
      else { els.dot.className = 'zv-off'; els.who.textContent = 'abra uma conversa'; }
    }, 2000);
  }

  onReady(build);
})();
