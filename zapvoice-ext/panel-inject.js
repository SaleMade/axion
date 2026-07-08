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
    var t = setInterval(function () {
      if (document.body && !document.getElementById('zv-panel')) { clearInterval(t); render(); poll(); }
    }, 700);
  }

  function itemsHtml(list, prefix) {
    return (list || []).map(function (it, i) {
      var icon = it.kind === 'video' ? '&#9654;' : '&#9655;';
      return '<button class="zv-item" data-k="' + prefix + '" data-i="' + i + '" title="' + esc(it.desc || it.caption || '') + '">' +
        '<span class="zv-stage">' + esc(it.stage) + '</span><span class="zv-label">' + esc(it.label) + '</span><span class="zv-play">' + icon + '</span></button>';
    }).join('');
  }

  function buildIndex() {
    itemById = {};
    (DATA.messages || []).concat(DATA.funnel || [], DATA.social || []).forEach(function (it) { if (it && it.id) itemById[it.id] = it; });
  }

  function render() {
    buildIndex();
    var p = document.createElement('div'); p.id = 'zv-panel';
    var msgs = (DATA.messages && DATA.messages.length) ? ('<div class="zv-h">Mensagens</div><div class="zv-list">' + itemsHtml(DATA.messages, 'messages') + '</div>') : '';
    var social = (DATA.social && DATA.social.length) ? ('<div class="zv-h">Prova social</div><div class="zv-list">' + itemsHtml(DATA.social, 'social') + '</div>') : '';
    var seqs = (DATA.sequences && DATA.sequences.length) ? ('<div class="zv-h">Sequencias</div><div class="zv-list">' + DATA.sequences.map(function (s, i) {
      return '<button class="zv-seq" data-si="' + i + '"><span class="zv-stage">SEQ</span><span class="zv-label">' + esc(s.label) + '</span><span class="zv-play">&#9193;</span></button>';
    }).join('') + '</div>') : '';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">Sale Chat</span><span id="zv-who">carregando...</span><span id="zv-min" title="Recolher">–</span></div>' +
      '<div id="zv-body">' + msgs + '<div class="zv-h">Funil do campeao</div><div class="zv-list">' + itemsHtml(DATA.funnel, 'funnel') + '</div>' +
      social + seqs +
      '<div id="zv-status"></div>' +
      '<div id="zv-foot"><label id="zv-sim"><input type="checkbox" id="zv-sim-cb" checked> simular gravando</label></div></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status');
    var head = p.querySelector('#zv-head');
    p.querySelector('#zv-min').onclick = function (e) { e.stopPropagation(); p.classList.toggle('zv-collapsed'); };
    var cb = p.querySelector('#zv-sim-cb'); simulate = cb.checked; cb.onchange = function () { simulate = cb.checked; };
    Array.prototype.forEach.call(p.querySelectorAll('.zv-item'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-k');
        var list = k === 'social' ? DATA.social : (k === 'messages' ? DATA.messages : DATA.funnel);
        send(list[+b.getAttribute('data-i')], b);
      };
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
  function sendItemAsync(item) {
    return new Promise(function (resolve) {
      var c = activeChat();
      if (!c) { resolve({ ok: false, err: 'sem conversa aberta' }); return; }
      if (c.isGroup) { resolve({ ok: false, err: 'e um grupo' }); return; }
      var chatId = c.id;
      if (item.kind === 'video') {
        // Video vem do injetor (base64 via CDP), pra fugir do bloqueio de fetch do WhatsApp.
        var rid = 'v' + Date.now() + Math.random().toString(36).slice(2, 6);
        try { window.__zvRes = null; } catch (_) {}
        window.__zvReq = { id: rid, file: item.file, caption: item.caption || '' };
        var waited = 0;
        var iv = setInterval(function () {
          waited += 500; var res = window.__zvRes;
          if (res && res.id === rid) { clearInterval(iv); resolve({ ok: !!res.ok, err: res.err }); }
          else if (waited > 90000) { clearInterval(iv); resolve({ ok: false, err: 'timeout (start.bat rodando?)' }); }
        }, 500);
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
    var st = item.kind === 'video' ? 'Enviando video...' : (item.kind === 'text' ? (simulate ? 'Digitando...' : 'Enviando...') : (simulate ? 'Gravando...' : 'Enviando...'));
    status(st, '');
    sendItemAsync(item).then(function (r) {
      status(r.ok ? 'Enviado' : ('Falha: ' + (r.err || '')), r.ok ? 'ok' : 'err');
      busy = false; if (b) b.classList.remove('zv-busy');
    });
  }

  // Dispara os itens da sequencia em ordem, com pausa entre eles. Clicar de novo para.
  function sendSequence(seq, b) {
    if (busy || !seq) return;
    var items = (seq.items || []).map(function (id) { return itemById[id]; }).filter(Boolean);
    if (!items.length) { status('Sequencia vazia', 'err'); return; }
    var c = activeChat();
    if (!c || c.isGroup) { status('Abra a conversa de um lead', 'err'); return; }
    busy = true; seqRunning = true; seqStop = false; if (b) b.classList.add('zv-busy');
    var i = 0;
    (function next() {
      if (seqStop || i >= items.length) {
        status(seqStop ? 'Sequencia parada' : 'Sequencia enviada (' + items.length + ')', seqStop ? 'err' : 'ok');
        busy = false; seqRunning = false; if (b) b.classList.remove('zv-busy'); return;
      }
      status('Sequencia ' + (i + 1) + '/' + items.length + '...', '');
      sendItemAsync(items[i]).then(function (r) {
        i++;
        if (!r.ok) { status('Falha no item ' + i + ': ' + (r.err || ''), 'err'); busy = false; seqRunning = false; if (b) b.classList.remove('zv-busy'); return; }
        setTimeout(next, 1600);
      });
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
