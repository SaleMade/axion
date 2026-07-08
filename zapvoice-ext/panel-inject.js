// Sale Chat — painel injetado DENTRO do app (roda na pagina web.whatsapp.com).
// O marcador de DADOS (linha do var DATA) e o de CSS sao trocados pelo inject.js.
// Roda no mesmo contexto do WA-JS: chama window.WPP direto.
(function () {
  'use strict';
  if (window.__zvInstalled) return; window.__zvInstalled = true;
  var DATA = "__LIBRARY__";
  var CSS = "__CSS__";
  var busy = false, simulate = true, els = {};

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

  function render() {
    var p = document.createElement('div'); p.id = 'zv-panel';
    var social = (DATA.social && DATA.social.length) ? ('<div class="zv-h">Prova social</div><div class="zv-list">' + itemsHtml(DATA.social, 'social') + '</div>') : '';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">Sale Chat</span><span id="zv-who">carregando...</span><span id="zv-min" title="Recolher">–</span></div>' +
      '<div id="zv-body"><div class="zv-h">Funil do campeao</div><div class="zv-list">' + itemsHtml(DATA.funnel, 'funnel') + '</div>' +
      social +
      '<div id="zv-status"></div>' +
      '<div id="zv-foot"><label id="zv-sim"><input type="checkbox" id="zv-sim-cb" checked> simular gravando</label></div></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status');
    var head = p.querySelector('#zv-head');
    p.querySelector('#zv-min').onclick = function (e) { e.stopPropagation(); p.classList.toggle('zv-collapsed'); };
    var cb = p.querySelector('#zv-sim-cb'); simulate = cb.checked; cb.onchange = function () { simulate = cb.checked; };
    Array.prototype.forEach.call(p.querySelectorAll('.zv-item'), function (b) {
      b.onclick = function () { var list = b.getAttribute('data-k') === 'social' ? DATA.social : DATA.funnel; send(list[+b.getAttribute('data-i')], b); };
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

  function send(item, b) {
    if (busy || !item) return;
    var c = activeChat();
    if (!c) { status('Abra uma conversa primeiro', 'err'); return; }
    if (c.isGroup) { status('E um grupo. Abra a conversa de um lead.', 'err'); return; }
    busy = true; b.classList.add('zv-busy');
    var chatId = c.id;
    if (item.kind === 'video') {
      status('Enviando video...', '');
      fetch(item.url).then(function (r) { return r.blob(); })
        .then(function (blob) { return window.WPP.chat.sendFileMessage(chatId, blob, { type: 'video', caption: item.caption || '' }); })
        .then(function () { status('Video enviado', 'ok'); })
        .catch(function (e) { status('Falha: ' + ((e && e.message) || e), 'err'); })
        .then(function () { busy = false; b.classList.remove('zv-busy'); });
      return;
    }
    var dur = item.durMs || 3000;
    status(simulate ? 'Gravando...' : 'Enviando...', '');
    var pre = Promise.resolve();
    if (simulate) { try { pre = Promise.resolve(window.WPP.chat.markIsRecording(chatId, dur)); } catch (_) {} }
    pre.then(function () { return sleep(dur); })
      .then(function () { return window.WPP.chat.sendFileMessage(chatId, item.dataUri, { type: 'audio', isPtt: true }); })
      .then(function () { status('Enviado para ' + ((c.id && c.id.user) || ''), 'ok'); })
      .catch(function (e) { status('Falha: ' + ((e && e.message) || e), 'err'); })
      .then(function () { busy = false; b.classList.remove('zv-busy'); });
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
