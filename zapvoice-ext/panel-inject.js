// Sale Chat — painel injetado DENTRO do app (roda na pagina web.whatsapp.com).
// O marcador de DADOS (linha do var DATA) e o de CSS sao trocados pelo inject.js.
// Roda no mesmo contexto do WA-JS: chama window.WPP direto.
(function () {
  'use strict';
  if (window.__zvInstalled) return; window.__zvInstalled = true;
  var DATA = "__LIBRARY__";
  var CSS = "__CSS__";
  var busy = false, simulate = true, els = {}, itemById = {}, seqStop = false, seqRunning = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function onReady(cb) {
    var tries = 0;
    (function loop() {
      tries++;
      try { if (window.WPP && window.WPP.chat && typeof window.WPP.chat.getActiveChat === 'function') return cb(); } catch (_) {}
      if (tries > 60) return cb();
      setTimeout(loop, 500);
    })();
  }
  function injectCss() { if (document.getElementById('zv-style')) return; var s = document.createElement('style'); s.id = 'zv-style'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

  function activeChat() { try { return window.WPP.chat.getActiveChat(); } catch (e) { return null; } }
  function activeInfo() {
    var c = activeChat(); if (!c) return null;
    var ct = c.contact || {};
    return { name: ct.name || ct.pushname || ct.formattedName || c.formattedTitle || (c.id && c.id.user) || '', number: (c.id && c.id.user) || '', isGroup: !!c.isGroup };
  }

  function build() {
    injectCss();
    // Enviado pelo injetor (window.__zvReq -> injetor le o arquivo -> chama isso com o base64)
    window.__zvDoSend = function (dataUri, caption, id) {
      try {
        var c = activeChat();
        if (!c) { window.__zvRes = { id: id, ok: false, err: 'sem chat aberto' }; return; }
        window.WPP.chat.sendFileMessage(c.id, dataUri, { type: 'video', caption: caption || '' })
          .then(function () { window.__zvRes = { id: id, ok: true }; })
          .catch(function (e) { window.__zvRes = { id: id, ok: false, err: (e && e.message) || ('' + e) }; });
      } catch (e) { window.__zvRes = { id: id, ok: false, err: (e && e.message) || ('' + e) }; }
    };
    // Gatilhos: escuta mensagens recebidas e sugere o item configurado
    try { if (window.WPP && window.WPP.on) window.WPP.on('chat.new_message', function (m) { try { onIncoming(m); } catch (_) {} }); } catch (_) {}
    var t = setInterval(function () {
      if (document.body && !document.getElementById('zv-panel')) { clearInterval(t); render(); poll(); }
    }, 700);
  }

  function onIncoming(msg) {
    if (!msg || msg.fromMe || (msg.id && msg.id.fromMe)) return;
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
    play:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3.5v17a1 1 0 0 0 1.53.85l13.4-8.5a1 1 0 0 0 0-1.7L7.53 2.65A1 1 0 0 0 6 3.5Z"/></svg>'
  };
  var ZKIND = {
    text:     { c: '#2563eb', ic: SVG.msg },
    audio:    { c: '#13c273', ic: SVG.mic },
    video:    { c: '#8e17f0', ic: SVG.video },
    image:    { c: '#00bcf2', ic: SVG.image },
    document: { c: '#f0810f', ic: SVG.doc }
  };
  function itemsHtml(list) {
    return (list || []).map(function (it) {
      var k = ZKIND[it.kind] || ZKIND.text;
      return '<button class="zv-item" data-id="' + esc(it.id) + '" title="' + esc(it.desc || it.caption || '') + '">' +
        '<span class="zv-ic" style="background:' + k.c + '1f;color:' + k.c + '">' + k.ic + '</span>' +
        '<span class="zv-label">' + esc(it.label) + '</span><span class="zv-play">' + SVG.play + '</span></button>';
    }).join('');
  }
  function mediaByKind(kind) { return (DATA.media || []).filter(function (m) { return m.kind === kind; }); }
  function sectionHtml(title, list, ic, color) {
    return list.length ? ('<div class="zv-h"><span class="zv-hi" style="color:' + color + '">' + ic + '</span>' + title + '</div><div class="zv-list">' + itemsHtml(list) + '</div>') : '';
  }

  function buildIndex() {
    itemById = {};
    (DATA.messages || []).concat(DATA.funnel || [], DATA.social || [], DATA.media || []).forEach(function (it) { if (it && it.id) itemById[it.id] = it; });
  }

  function render() {
    buildIndex();
    var p = document.createElement('div'); p.id = 'zv-panel';
    var msgs = sectionHtml('Mensagens', DATA.messages || [], SVG.msg, '#2563eb');
    var auds = sectionHtml('Audios do funil', mediaByKind('audio'), SVG.mic, '#13c273');
    var vids = sectionHtml('Videos', mediaByKind('video'), SVG.video, '#8e17f0');
    var imgs = sectionHtml('Imagens', mediaByKind('image'), SVG.image, '#00bcf2');
    var docs = sectionHtml('Documentos', mediaByKind('document'), SVG.doc, '#f0810f');
    var seqs = (DATA.sequences && DATA.sequences.length) ? ('<div class="zv-h"><span class="zv-hi" style="color:#8e17f0">' + SVG.funnel + '</span>Funis</div><div class="zv-list">' + DATA.sequences.map(function (s, i) {
      return '<button class="zv-seq" data-si="' + i + '"><span class="zv-ic">' + SVG.seq + '</span><span class="zv-label">' + esc(s.label) + '</span><span class="zv-play">' + SVG.play + '</span></button>';
    }).join('') + '</div>') : '';
    var empty = (!msgs && !auds && !vids && !imgs && !docs && !seqs) ? '<div class="zv-empty">Nada configurado ainda. Abra a dash (Sale Chat) e adicione mensagens, audios e videos.</div>' : '';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">Sale Chat</span><span id="zv-who">carregando...</span><span id="zv-min" title="Recolher">–</span></div>' +
      '<div id="zv-body"><div id="zv-suggest" style="display:none"></div>' + msgs + auds + vids + imgs + docs + seqs + empty +
      '<div id="zv-status"></div>' +
      '<div id="zv-sched" style="display:none"></div>' +
      '<div id="zv-foot"><label id="zv-sim"><input type="checkbox" id="zv-sim-cb" checked> simular gravando</label><a id="zv-sched-toggle">Agendar</a></div></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status');
    var head = p.querySelector('#zv-head');
    p.querySelector('#zv-min').onclick = function (e) { e.stopPropagation(); p.classList.toggle('zv-collapsed'); };
    var cb = p.querySelector('#zv-sim-cb'); simulate = cb.checked; cb.onchange = function () { simulate = cb.checked; };
    var stgl = p.querySelector('#zv-sched-toggle');
    if (stgl) stgl.onclick = function () { var b = p.querySelector('#zv-sched'); if (b) { var show = b.style.display === 'none'; b.style.display = show ? 'block' : 'none'; if (show) schedRender(); } };
    if (!window.__zvSchedIv) window.__zvSchedIv = setInterval(schedCheck, 20000);
    Array.prototype.forEach.call(p.querySelectorAll('.zv-item'), function (b) {
      b.onclick = function () { var it = itemById[b.getAttribute('data-id')]; if (it) send(it, b); };
    });
    Array.prototype.forEach.call(p.querySelectorAll('.zv-seq'), function (b) {
      b.onclick = function () { if (busy && seqRunning) { seqStop = true; return; } sendSequence(DATA.sequences[+b.getAttribute('data-si')], b); };
    });
    restorePos(p);
    makeDraggable(p, head);
  }

  function restorePos(p) {
    try {
      var s = localStorage.getItem('zv_pos');
      if (s) { var a = s.split('|'); p.style.right = 'auto'; p.style.bottom = 'auto'; p.style.left = a[0]; p.style.top = a[1]; }
    } catch (_) {}
  }
  function makeDraggable(p, handle) {
    var drag = false, sx, sy, ox, oy;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', function (e) {
      if (e.target && (e.target.id === 'zv-min')) return;
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
    document.addEventListener('mouseup', function () { if (drag) { drag = false; try { localStorage.setItem('zv_pos', p.style.left + '|' + p.style.top); } catch (_) {} } });
  }

  function status(m, k) { if (els.status) { els.status.textContent = m; els.status.className = k || ''; } }

  // Envia UM item e resolve {ok,err} quando terminar. Nao mexe em busy/status.
  // forceChatId: manda pra um chat especifico (usado no agendamento), senao o aberto.
  function sendItemAsync(item, forceChatId) {
    return new Promise(function (resolve) {
      var chatId;
      if (forceChatId) { chatId = forceChatId; }
      else {
        var c = activeChat();
        if (!c) { resolve({ ok: false, err: 'sem conversa aberta' }); return; }
        if (c.isGroup) { resolve({ ok: false, err: 'e um grupo' }); return; }
        chatId = c.id;
      }
      if (item.kind === 'video') {
        if (forceChatId) { resolve({ ok: false, err: 'video agendado nao suportado (abra o chat)' }); return; }
        // Video vem do injetor (base64 via CDP), pra fugir do bloqueio de fetch do WhatsApp.
        var rid = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
        try { window.__zvRes = null; } catch (_) {}
        window.__zvReq = { id: rid, file: item.file, url: item.mediaUrl, caption: item.caption || '' };
        var waited = 0;
        var iv = setInterval(function () {
          waited += 500; var res = window.__zvRes;
          if (res && res.id === rid) { clearInterval(iv); resolve({ ok: !!res.ok, err: res.err }); }
          else if (waited > 90000) { clearInterval(iv); resolve({ ok: false, err: 'timeout (start.bat rodando?)' }); }
        }, 500);
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
        var preT = Promise.resolve();
        if (simulate) { try { preT = Promise.resolve(window.WPP.chat.markIsComposing(chatId, 1500)); } catch (_) {} }
        preT.then(function () { return sleep(1200); })
          .then(function () { return window.WPP.chat.sendTextMessage(chatId, item.text || ''); })
          .then(function () { resolve({ ok: true }); })
          .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
        return;
      }
      var dur = item.durMs || 3000;
      var pre = Promise.resolve();
      if (simulate) { try { pre = Promise.resolve(window.WPP.chat.markIsRecording(chatId, dur)); } catch (_) {} }
      pre.then(function () { return sleep(dur); })
        .then(function () { return window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'audio', isPtt: true }); })
        .then(function () { resolve({ ok: true }); })
        .catch(function (e) { resolve({ ok: false, err: (e && e.message) || ('' + e) }); });
    });
  }

  function send(item, b) {
    if (busy || !item) return;
    busy = true; if (b) b.classList.add('zv-busy');
    var st = item.kind === 'video' ? 'Enviando video...' : item.kind === 'image' ? 'Enviando imagem...' : item.kind === 'document' ? 'Enviando documento...' : (item.kind === 'text' ? (simulate ? 'Digitando...' : 'Enviando...') : (simulate ? 'Gravando...' : 'Enviando...'));
    status(st, '');
    sendItemAsync(item).then(function (r) {
      status(r.ok ? 'Enviado' : ('Falha: ' + (r.err || '')), r.ok ? 'ok' : 'err');
      busy = false; if (b) b.classList.remove('zv-busy');
    });
  }

  // Passo de funil: id do item + delay (segundos) de espera ANTES de disparar.
  // Aceita formato antigo (so o id string) e novo ({id, delay}).
  function normStep(raw) { return (typeof raw === 'string') ? { id: raw, delay: 0 } : { id: (raw && raw.id) || '', delay: (raw && +raw.delay) || 0 }; }
  // Dispara os passos da sequencia em ordem, respeitando o delay de cada um. Clicar de novo para.
  function sendSequence(seq, b) {
    if (busy || !seq) return;
    var steps = (seq.items || []).map(normStep).filter(function (s) { return itemById[s.id]; });
    if (!steps.length) { status('Sequencia vazia', 'err'); return; }
    var c = activeChat();
    if (!c || c.isGroup) { status('Abra a conversa de um lead', 'err'); return; }
    busy = true; seqRunning = true; seqStop = false; if (b) b.classList.add('zv-busy');
    function done(msg, cls) { status(msg, cls); busy = false; seqRunning = false; if (b) b.classList.remove('zv-busy'); }
    var i = 0;
    (function next() {
      if (seqStop || i >= steps.length) { done(seqStop ? 'Sequencia parada' : 'Sequencia enviada (' + steps.length + ')', seqStop ? 'err' : 'ok'); return; }
      var wait = Math.max(0, steps[i].delay || 0) * 1000;
      if (wait > 0) status('Aguardando ' + steps[i].delay + 's (' + (i + 1) + '/' + steps.length + ')...', '');
      setTimeout(function () {
        if (seqStop) { done('Sequencia parada', 'err'); return; }
        status('Enviando ' + (i + 1) + '/' + steps.length + '...', '');
        sendItemAsync(itemById[steps[i].id]).then(function (r) {
          i++;
          if (!r.ok) { done('Falha no item ' + i + ': ' + (r.err || ''), 'err'); return; }
          setTimeout(next, 400);
        });
      }, wait);
    })();
  }

  function poll() {
    setInterval(function () {
      if (!els.who) return;
      var a = activeInfo();
      if (a) { els.dot.className = 'zv-on'; els.who.textContent = a.isGroup ? 'grupo (abra um lead)' : (a.name ? ('→ ' + a.name) : '→ abra uma conversa'); }
      else { els.dot.className = 'zv-off'; els.who.textContent = 'abra uma conversa'; }
    }, 2000);
  }

  onReady(build);
})();
