// ZapVoice Nosso — painel injetado DENTRO do app (roda na pagina web.whatsapp.com).
// Os marcadores LIB e CSS (nas duas linhas abaixo) sao trocados pelo inject.js.
// Roda no mesmo contexto do WA-JS: chama window.WPP direto.
(function () {
  'use strict';
  if (window.__zvInstalled) return; window.__zvInstalled = true;
  var LIB = "__LIBRARY__";
  var CSS = "__CSS__";
  var busy = false, simulate = true, els = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Nao depende de WPP.isReady (que nao vira true em injecao tardia). Espera a
  // API de chat ficar utilizavel; com fallback pra mostrar mesmo assim depois de ~30s.
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

  function render() {
    var p = document.createElement('div'); p.id = 'zv-panel';
    var items = LIB.map(function (it, i) {
      return '<button class="zv-item" data-i="' + i + '" title="' + esc(it.desc) + '"><span class="zv-stage">' + esc(it.stage) + '</span><span class="zv-label">' + esc(it.label) + '</span><span class="zv-play">&#9655;</span></button>';
    }).join('');
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">ZapVoice Nosso</span><span id="zv-who">carregando...</span><span id="zv-min" title="Recolher">–</span></div>' +
      '<div id="zv-body"><div class="zv-h">Funil do campeao</div><div id="zv-funnel" class="zv-list">' + items + '</div>' +
      '<div id="zv-status"></div>' +
      '<div id="zv-foot"><label id="zv-sim"><input type="checkbox" id="zv-sim-cb" checked> simular gravando</label></div></div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who'); els.dot = p.querySelector('#zv-dot'); els.status = p.querySelector('#zv-status');
    p.querySelector('#zv-min').onclick = function () { p.classList.toggle('zv-collapsed'); };
    p.querySelector('#zv-head').ondblclick = function () { p.classList.toggle('zv-collapsed'); };
    var cb = p.querySelector('#zv-sim-cb'); simulate = cb.checked; cb.onchange = function () { simulate = cb.checked; };
    Array.prototype.forEach.call(p.querySelectorAll('.zv-item'), function (b) { b.onclick = function () { send(LIB[+b.getAttribute('data-i')], b); }; });
  }

  function status(m, k) { if (els.status) { els.status.textContent = m; els.status.className = k || ''; } }

  function send(item, b) {
    if (busy || !item) return;
    var c = activeChat();
    if (!c) { status('Abra uma conversa primeiro', 'err'); return; }
    if (c.isGroup) { status('E um grupo. Abra a conversa de um lead.', 'err'); return; }
    busy = true; b.classList.add('zv-busy'); status(simulate ? 'Gravando...' : 'Enviando...', '');
    var chatId = c.id, dur = item.durMs || 3000;
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
