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
  function injectCss() { var ex = document.getElementById('zv-style'); if (ex && ex.parentNode) ex.parentNode.removeChild(ex); var s = document.createElement('style'); s.id = 'zv-style'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

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
    help:  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  var COLLAPSED = lsGet('zv_collapsed', {});
  var FAVS = lsGet('zv_favs', {});
  var DARK = false; try { DARK = localStorage.getItem('zv_dark') === '1'; } catch (_) {}
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
  function itemsHtml(list) {
    return (list || []).map(function (it) {
      var k = ZKIND[it.kind] || ZKIND.text;
      var fav = !!FAVS[it.id];
      return '<button class="zv-item" data-id="' + esc(it.id) + '" title="' + esc(it.desc || it.caption || '') + '">' +
        '<span class="zv-ic" style="background:' + k.c + '1f;color:' + k.c + '">' + k.ic + '</span>' +
        '<span class="zv-label">' + esc(it.label) + '</span>' +
        '<span class="zv-star' + (fav ? ' on' : '') + '" data-fav="' + esc(it.id) + '" title="Favoritar">' + (fav ? SVG.starFull : SVG.star) + '</span>' +
        '<span class="zv-play">' + SVG.play + '</span></button>';
    }).join('');
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

  function render() {
    buildIndex();
    var p = document.createElement('div'); p.id = 'zv-panel'; if (DARK) p.className = 'zv-dark';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">Sale Chat</span><span id="zv-who">carregando...</span>' +
        '<span id="zv-theme" title="Tema claro/escuro">' + (DARK ? SVG.sun : SVG.moon) + '</span>' +
        '<span id="zv-min" title="Recolher">' + SVG.minus + '</span></div>' +
      '<div id="zv-suggest" style="display:none"></div>' +
      '<div id="zv-main"><div id="zv-content"></div><div id="zv-rail"></div></div>' +
      '<div id="zv-status"></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status');
    var head = p.querySelector('#zv-head');
    p.querySelector('#zv-min').onclick = function (e) { e.stopPropagation(); p.classList.toggle('zv-collapsed'); };
    var themeBtn = p.querySelector('#zv-theme');
    if (themeBtn) themeBtn.onclick = function (e) { e.stopPropagation(); setDark(!DARK); };
    if (!window.__zvSchedIv) window.__zvSchedIv = setInterval(schedCheck, 20000);
    renderRail(); renderContent();
    restorePos(p);
    makeDraggable(p, head);
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
      b.onclick = function () { TAB = b.getAttribute('data-tab'); try { localStorage.setItem('zv_tab', TAB); } catch (_) {} renderRail(); renderContent(); };
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
    Array.prototype.forEach.call(host.querySelectorAll('.zv-item'), function (b) {
      b.onclick = function () { var it = itemById[b.getAttribute('data-id')]; if (it) send(it, b); };
    });
    Array.prototype.forEach.call(host.querySelectorAll('.zv-seq'), function (b) {
      b.onclick = function () { if (busy && seqRunning) { seqStop = true; return; } sendSequence(DATA.sequences[+b.getAttribute('data-si')], b); };
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
      var items = sec.querySelectorAll('.zv-item, .zv-seq');
      var visible = 0;
      Array.prototype.forEach.call(items, function (it) {
        var lblEl = it.querySelector('.zv-label'); var lbl = lblEl ? lblEl.textContent : '';
        var ok = !q || lbl.toLowerCase().indexOf(q) !== -1;
        it.style.display = ok ? '' : 'none';
        if (ok) visible++;
      });
      var list = sec.querySelector('.zv-list');
      if (q) { sec.style.display = visible ? '' : 'none'; if (list) list.style.display = visible ? '' : 'none'; }
      else { sec.style.display = ''; if (list) list.style.display = COLLAPSED[key] ? 'none' : ''; }
    });
  }

  // ── Aba FUNIS ──
  function renderFunisTab(c) {
    var seqList = DATA.sequences || [];
    var inner = seqList.length ? seqList.map(function (s, i) {
      return '<button class="zv-seq" data-si="' + i + '"><span class="zv-ic">' + SVG.seq + '</span><span class="zv-label">' + esc(s.label) + '</span><span class="zv-play">' + SVG.play + '</span></button>';
    }).join('') : '<div class="zv-empty">Nenhum funil ainda. Crie na dash (Sale Chat).</div>';
    c.innerHTML = '<div class="zv-ctop"><div class="zv-tabhdr"><span class="zv-hi" style="color:#8e17f0">' + SVG.funnel + '</span>Funis</div><p class="zv-tabhint">Dispara varios itens em ordem, com a espera de cada passo.</p></div><div class="zv-cbody"><div class="zv-list">' + inner + '</div></div>';
    Array.prototype.forEach.call(c.querySelectorAll('.zv-seq'), function (b) {
      b.onclick = function () { if (busy && seqRunning) { seqStop = true; return; } sendSequence(DATA.sequences[+b.getAttribute('data-si')], b); };
    });
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
    window.__zvPollIv = setInterval(function () {
      if (!els.who) return;
      var a = activeInfo();
      if (a) { els.dot.className = 'zv-on'; els.who.textContent = a.isGroup ? 'grupo (abra um lead)' : (a.name ? ('→ ' + a.name) : '→ abra uma conversa'); }
      else { els.dot.className = 'zv-off'; els.who.textContent = 'abra uma conversa'; }
    }, 2000);
  }

  onReady(build);
})();
