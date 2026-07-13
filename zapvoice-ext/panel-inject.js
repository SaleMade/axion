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
    if (window.__zvPollIv) { clearInterval(window.__zvPollIv); window.__zvPollIv = null; }
    if (window.__zvSgT) { clearTimeout(window.__zvSgT); window.__zvSgT = null; }
  } catch (_) {}
  window.__zvInstalled = true;
  var DATA = "__LIBRARY__";
  var CSS = "__CSS__";
  var simulate = true, els = {}, itemById = {};
  // Envios concorrentes: cada envio (item OU funil) vira um JOB independente, com seu proprio
  // alvo (lead), progresso e stop. Assim da pra mandar pra varios leads ao mesmo tempo e o
  // banner mostra todos empilhados, cada um com seu Pausar.
  var jobs = [];

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
  var ZV_ENGINE_ERR = 'O motor do WhatsApp nao carregou nesta versao do app. Feche o WhatsApp e abra de novo pelo start. Se continuar, use o WhatsApp normal (nao o Beta).';
  function wppAlive() {
    try {
      var W = window.WPP;
      return !!(W && W.chat && typeof W.chat.sendTextMessage === 'function' && W.whatsapp && W.whatsapp.ChatStore);
    } catch (_) { return false; }
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
      var m = /^(?:true|false)_([^_]+)_/.exec(nodes[i].getAttribute('data-id') || '');
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
  function _activeFromDom() {
    try {
      var main = document.querySelector('#main');
      if (!main) return null;   // sem #main = nao ha conversa aberta MESMO (erro honesto)
      var t = main.querySelector('header span[title]');
      var title = t ? (t.getAttribute('title') || t.textContent || '') : '';
      var jid = _domJidFromMessages(main);
      if (jid) return _mkChat(jid, title);
      return _activeFromFiber(main);   // conversa vazia
    } catch (_) { return null; }
  }
  function activeChat() {
    try { var c = window.WPP.chat.getActiveChat(); if (c) return c; } catch (_) {}
    var s = _activeFromStore(); if (s) return s;
    return _activeFromDom();
  }
  // id serializado da conversa (pra travar o alvo do envio no lead que estava aberto no clique).
  function chatIdOf(c) { try { return (c && c.id && (c.id._serialized || (c.id.toString && c.id.toString()))) || (c && c.id) || null; } catch (_) { return null; } }
  // Alvo capturado de cada video pendente: id-do-pedido -> chatId. Assim o video vai pro lead
  // certo mesmo se o atendente trocar de conversa enquanto o injetor baixa o base64.
  var videoTargets = {};
  // Fila de videos: window.__zvReq e um slot UNICO (o injetor le um por vez). Se dois videos
  // setam o slot no mesmo instante, um se sobrescreve e se perde. Por isso serializamos: so
  // um video ocupa o slot por vez; os demais esperam a vez.
  var videoQueue = [], videoBusy = false;
  function pumpVideoQueue() {
    if (videoBusy || !videoQueue.length) return;
    var job = videoQueue.shift();
    // Se o job (funil/item) desse video foi pausado antes de comecar, nao envia.
    if (job.stopFn && job.stopFn()) { delete videoTargets[job.rid]; job.resolve({ ok: false, cancelled: true }); pumpVideoQueue(); return; }
    videoBusy = true;
    try { window.__zvRes = null; } catch (_) {}
    window.__zvReq = job.req;
    var waited = 0;
    var iv = setInterval(function () {
      waited += 500; var res = window.__zvRes;
      if (job.stopFn && job.stopFn()) { clearInterval(iv); delete videoTargets[job.rid]; videoBusy = false; job.resolve({ ok: false, cancelled: true }); pumpVideoQueue(); }
      else if (res && res.id === job.rid) { clearInterval(iv); delete videoTargets[job.rid]; videoBusy = false; job.resolve({ ok: !!res.ok, err: res.err }); pumpVideoQueue(); }
      else if (waited > 180000) { clearInterval(iv); delete videoTargets[job.rid]; videoBusy = false; job.resolve({ ok: false, err: 'timeout (start.bat rodando?)' }); pumpVideoQueue(); }
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
    window.__zvDoSend = function (dataUri, caption, id) {
      try {
        // Alvo travado no clique. Se sumiu (timeout/cancelou), NAO envia pro chat aberto agora
        // — isso mandaria o video pro lead errado. Aborta de proposito.
        var toId = videoTargets[id]; delete videoTargets[id];
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
      jobs.forEach(function (j) { if (j.stopOnReply && !j.stop && mFromS && mFromS === j.chatId) { j.stop = true; any = true; } });
      if (any) { renderSending(); status('Funil parado: o lead respondeu', 'err'); }
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
    if (!wppAlive()) { status(ZV_ENGINE_ERR, 'err'); return; }
    var c = activeChat(); if (!c || c.isGroup) { status('Abra a conversa de um lead pra agendar', 'err'); return; }
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
    due.forEach(function (s) { var it = itemById[s.itemId]; if (it) sendItemAsync(it, s.chatId); });
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
    pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
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
    { key: 'ajuda', label: 'Ajuda', icon: 'help' }
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
    if (TAB === 'funis') return renderFunisTab(c);
    if (TAB === 'agenda') return renderAgendaTab(c);
    if (TAB === 'ajustes') return renderAjustesTab(c);
    if (TAB === 'ajuda') return renderAjudaTab(c);
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
    var inner = seqList.length ? seqList.map(function (s, i) {
      return '<div class="zv-itemwrap">' +
        '<div class="zv-item zv-seqrow" data-fexp="' + i + '">' +
          '<span class="zv-ic zv-seq-ic">' + SVG.seq + '</span>' +
          '<span class="zv-label">' + esc(s.label) + '</span>' +
          '<button class="zv-send zv-seqsend" data-si="' + i + '" title="Disparar funil">' + SVG.play + '</button>' +
          '<span class="zv-exp" title="Prever funil">' + SVG.chevDown + '</span>' +
        '</div><div class="zv-prev" style="display:none"></div></div>';
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
        '<div class="zv-setrow"><span>Tema do painel</span><button id="zv-theme2" class="zv-mini2">' + (DARK ? 'Escuro' : 'Claro') + '</button></div>' +
        '<p class="zv-tabhint">Simular deixa mais humano: mostra "gravando..." / "digitando..." antes de enviar.</p>' +
      '</div></div>';
    var cb = c.querySelector('#zv-sim-cb'); if (cb) cb.onchange = function () { simulate = cb.checked; };
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
        '<p class="zv-tabhint">Os itens sao configurados na dash (Sale Chat). O painel puxa sozinho.</p>' +
      '</div></div>';
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
    var el = els.sending; if (!el) return;
    if (!jobs.length) { el.style.display = 'none'; el.innerHTML = ''; try { dockLayout(); } catch (_) {} return; }
    el.innerHTML = jobs.map(function (j) {
      var stopping = !!j.stop;
      return '<div class="zv-snd-row' + (stopping ? ' zv-snd-stopping' : '') + '">' +
        '<span class="zv-snd-spin"></span>' +
        '<div class="zv-snd-txt"><b>' + esc(j.name) + (j.chatName ? ' <em class="zv-snd-to">&rarr; ' + esc(j.chatName) + '</em>' : '') + '</b>' +
          '<span>' + esc(stopping ? 'Parando…' : (j.sub || '')) + '</span></div>' +
        (stopping ? '<span class="zv-snd-stoplbl">Parando…</span>' : '<button class="zv-snd-stop" data-job="' + j.id + '">' + SVG.pause + ' Pausar</button>') +
        '</div>';
    }).join('');
    el.style.display = 'block';
    Array.prototype.forEach.call(el.querySelectorAll('.zv-snd-stop'), function (btn) {
      btn.onclick = function (e) { e.stopPropagation(); var jid = btn.getAttribute('data-job'); for (var k = 0; k < jobs.length; k++) { if (jobs[k].id === jid) { jobs[k].stop = true; break; } } renderSending(); };
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
        window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'image', caption: item.caption || '' })
          .then(function () { resolve({ ok: true }); })
          .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
        return;
      }
      if (item.kind === 'document') {
        window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'document', caption: item.caption || '', filename: item.label || 'documento' })
          .then(function () { resolve({ ok: true }); })
          .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
        return;
      }
      if (item.kind === 'text') {
        var stMs = opts.simMs > 0 ? opts.simMs : 1200;
        var preT = Promise.resolve();
        if (simulate) { try { preT = Promise.resolve(window.WPP.chat.markIsComposing(chatId, stMs + 300)).catch(function () {}); } catch (_) {} }
        preT.then(function () { return sleepStop(stMs, opts.stopFn); })
          .then(function (stopped) { if (stopped) return { __cancel: true }; return window.WPP.chat.sendTextMessage(chatId, item.text || ''); })
          .then(function (r) { resolve(r && r.__cancel ? { ok: false, cancelled: true } : { ok: true }); })
          .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
        return;
      }
      var dur = opts.simMs > 0 ? opts.simMs : (item.durMs || 3000);
      var pre = Promise.resolve();
      if (simulate) { try { pre = Promise.resolve(window.WPP.chat.markIsRecording(chatId, dur)).catch(function () {}); } catch (_) {} }
      pre.then(function () { return sleepStop(dur, opts.stopFn); })
        .then(function (stopped) { if (stopped) return { __cancel: true }; return window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'audio', isPtt: true }); })
        .then(function (r) { resolve(r && r.__cancel ? { ok: false, cancelled: true } : { ok: true }); })
        .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
     } catch (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); }
    });
  }

  // Nome do lead da conversa capturada (pro banner mostrar pra quem vai).
  function chatName(c) { return (c && ((c.contact && (c.contact.name || c.contact.pushname)) || c.formattedTitle || (c.id && c.id.user))) || ''; }
  // Envia UM item: cria um job e mostra na pilha. Alvo travado no clique.
  function send(item, b) {
    if (!item) return;
    if (!wppAlive()) { status(ZV_ENGINE_ERR, 'err'); return; }
    var c = activeChat();
    if (!c || c.isGroup) { status(c && c.isGroup ? 'Isso e um grupo; abra um lead' : 'Abra a conversa de um lead', 'err'); return; }
    var chatId = chatIdOf(c);
    if (!chatId) { status('Abra a conversa de um lead', 'err'); return; }
    for (var k = 0; k < jobs.length; k++) { if (jobs[k].chatId === chatId && jobs[k].itemId === item.id) { status('Esse item ja esta indo pra esse lead', 'err'); return; } }
    var kindLbl = { text: 'Mensagem', audio: 'Áudio', video: 'Vídeo', image: 'Imagem', document: 'Documento' }[item.kind] || 'Item';
    var who = chatName(c);
    var job = { id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: 'item', itemId: item.id, chatId: chatId, chatName: who, name: item.label || kindLbl, sub: (item.kind === 'text' ? (simulate ? 'Digitando…' : 'Enviando…') : item.kind === 'audio' ? (simulate ? 'Gravando…' : 'Enviando…') : ('Enviando ' + kindLbl.toLowerCase() + '…')), stop: false };
    jobs.push(job); renderSending();
    sendItemAsync(item, chatId, { stopFn: function () { return job.stop; } }).then(function (r) {
      jobs = jobs.filter(function (x) { return x.id !== job.id; }); renderSending();
      status(r.cancelled ? ('Cancelado (' + who + ')') : (r.ok ? ('Enviado -> ' + who) : ('Falha -> ' + who + ': ' + (r.err || ''))), (r.ok && !r.cancelled) ? 'ok' : 'err');
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
    if (!wppAlive()) { status(ZV_ENGINE_ERR, 'err'); return; }
    var c = activeChat();
    if (!c || c.isGroup) { status('Abra a conversa de um lead', 'err'); return; }
    var chatId = chatIdOf(c);
    if (!chatId) { status('Abra a conversa de um lead', 'err'); return; }  // sem alvo travado, nem comeca
    for (var k = 0; k < jobs.length; k++) { if (jobs[k].chatId === chatId && jobs[k].seqId === seq.id) { status('Esse funil ja esta indo pra esse lead', 'err'); return; } }
    var who = chatName(c);
    var job = { id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: 'funil', seqId: seq.id, chatId: chatId, chatName: who, name: 'Funil: ' + (seq.label || 'Funil'), sub: '', stop: false, stopOnReply: !!seq.stopOnReply };
    jobs.push(job); renderSending();
    var stopFn = function () { return job.stop; };
    function finish(how, err) {
      jobs = jobs.filter(function (x) { return x.id !== job.id; }); renderSending();
      status(how === 'ok' ? ('Funil enviado (' + steps.length + ') -> ' + who) : how === 'parado' ? ('Funil parado -> ' + who) : ('Falha no funil -> ' + who + (err ? ': ' + err : '')), how === 'ok' ? 'ok' : 'err');
    }
    var i = 0;
    (function next() {
      if (job.stop) { finish('parado'); return; }
      if (i >= steps.length) { finish('ok'); return; }
      var it = itemById[steps[i].id];
      if (!it) { i++; setTimeout(next, 0); return; }   // item foi apagado/editado na dash no meio: pula
      var wait = Math.max(0, steps[i].delay || 0) * 1000;
      if (wait > 0) { job.sub = 'Aguardando ' + steps[i].delay + 's · próximo passo ' + (i + 1) + '/' + steps.length + (it ? ' (' + it.label + ')' : ''); renderSending(); }
      // Espera checando o stop a cada 500ms, pra o Pausar responder rapido (nao ficar preso o delay).
      var waited = 0;
      (function waitLoop() {
        if (job.stop) { finish('parado'); return; }
        if (waited >= wait) {
          job.sub = 'Enviando passo ' + (i + 1) + ' de ' + steps.length + (it ? ' · ' + it.label : ''); renderSending();
          sendItemAsync(itemById[steps[i].id], chatId, { simMs: steps[i].sim ? steps[i].sim * 1000 : 0, stopFn: stopFn }).then(function (r) {
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
  }

  function poll() {
    window.__zvPollIv = setInterval(function () {
      var pnl = document.getElementById('zv-panel');
      if (pnl && !pnl.classList.contains('zv-collapsed')) dockLayout();
      if (!els.who) return;
      // Motor morto: fala a verdade em vez de mandar "abra uma conversa" (o atendente
      // ficava tentando abrir a conversa que JA estava aberta).
      if (!wppAlive()) { els.dot.className = 'zv-off'; els.who.textContent = 'motor nao carregou (use o WhatsApp normal)'; return; }
      var a = activeInfo();
      if (a) { els.dot.className = 'zv-on'; els.who.textContent = a.isGroup ? 'grupo (abra um lead)' : (a.name ? ('→ ' + a.name) : '→ abra uma conversa'); }
      else { els.dot.className = 'zv-off'; els.who.textContent = 'abra uma conversa'; }
    }, 2000);
  }

  onReady(build);
})();
