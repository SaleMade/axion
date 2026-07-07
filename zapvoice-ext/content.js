// ZapVoice Nosso — painel (mundo isolado). UI + storage. Fala com o bridge
// (mundo principal) por window.postMessage. Envia pela sessao do proprio
// atendente via WA-JS, com a conversa aberta detectada de forma confiavel.
(function () {
  'use strict';
  var funnel = [], userItems = [], settings = { simulate: true };
  var busy = false, els = {}, seq = 0, pending = {};

  function call(cmd, payload) {
    return new Promise(function (resolve) {
      var id = ++seq; pending[id] = resolve;
      window.postMessage({ __zv: 'req', id: id, cmd: cmd, payload: payload }, '*');
      setTimeout(function () { if (pending[id]) { pending[id]({ ok: false, error: 'timeout' }); delete pending[id]; } }, 25000);
    });
  }
  window.addEventListener('message', function (e) {
    var d = e.data; if (!d) return;
    if (d.__zv === 'res' && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
  });
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function boot() {
    Promise.all([
      fetch(chrome.runtime.getURL('library.json')).then(function (r) { return r.json(); }).catch(function () { return { funnel: [] }; }),
      new Promise(function (res) { chrome.storage.local.get(['zv_items', 'zv_settings'], res); })
    ]).then(function (a) {
      funnel = (a[0] && a[0].funnel) || [];
      userItems = (a[1] && a[1].zv_items) || [];
      settings = Object.assign({ simulate: true }, (a[1] && a[1].zv_settings) || {});
      waitBody();
    });
    chrome.storage.onChanged.addListener(function (ch) {
      if (ch.zv_items) { userItems = ch.zv_items.newValue || []; render(); }
      if (ch.zv_settings) { settings = Object.assign({ simulate: true }, ch.zv_settings.newValue || {}); if (els.simcb) els.simcb.checked = !!settings.simulate; }
    });
  }
  function waitBody() {
    var t = setInterval(function () { if (document.body && !document.getElementById('zv-panel')) { clearInterval(t); inject(); } }, 700);
  }

  function inject() {
    var p = document.createElement('div');
    p.id = 'zv-panel';
    p.innerHTML =
      '<div id="zv-head"><span id="zv-dot" class="zv-off"></span><span id="zv-title">ZapVoice Nosso</span><span id="zv-who">carregando...</span><span id="zv-min" title="Recolher">–</span></div>' +
      '<div id="zv-body">' +
      '  <div class="zv-h">Funil do campeao</div><div id="zv-funnel" class="zv-list"></div>' +
      '  <div class="zv-h">Meus audios</div><div id="zv-mine" class="zv-list"></div>' +
      '  <div id="zv-status"></div>' +
      '  <div id="zv-foot"><label id="zv-sim"><input type="checkbox" id="zv-sim-cb"> simular gravando</label><a id="zv-opts">config</a></div>' +
      '</div>';
    document.body.appendChild(p);
    els.who = p.querySelector('#zv-who');
    els.dot = p.querySelector('#zv-dot');
    els.funnel = p.querySelector('#zv-funnel');
    els.mine = p.querySelector('#zv-mine');
    els.status = p.querySelector('#zv-status');
    els.simcb = p.querySelector('#zv-sim-cb');
    p.querySelector('#zv-min').onclick = function () { p.classList.toggle('zv-collapsed'); };
    p.querySelector('#zv-head').ondblclick = function () { p.classList.toggle('zv-collapsed'); };
    p.querySelector('#zv-opts').onclick = function () { chrome.runtime.openOptionsPage(); };
    els.simcb.checked = !!settings.simulate;
    els.simcb.onchange = function () { settings.simulate = els.simcb.checked; chrome.storage.local.set({ zv_settings: settings }); };
    render();
    pollActive();
  }

  function mkBtn(item, kindDefault) {
    var b = document.createElement('button');
    b.className = 'zv-item';
    b.title = item.desc || '';
    b.innerHTML = '<span class="zv-stage">' + esc(item.stage || (item.kind || kindDefault || 'AUD').toUpperCase()) + '</span>' +
      '<span class="zv-label">' + esc(item.label || 'Item') + '</span><span class="zv-play">&#9655;</span>';
    b.onclick = function () { send(item, kindDefault, b); };
    return b;
  }
  function render() {
    if (!els.funnel) return;
    els.funnel.innerHTML = '';
    funnel.forEach(function (it) { els.funnel.appendChild(mkBtn({ stage: it.stage, label: it.label, url: chrome.runtime.getURL(it.file), kind: 'audio', sizeKB: it.sizeKB, desc: it.desc }, 'audio')); });
    els.mine.innerHTML = '';
    if (!userItems.length) els.mine.innerHTML = '<div class="zv-empty">Nada ainda. Clique em "config" pra subir os seus audios (a tua voz).</div>';
    userItems.forEach(function (it) { els.mine.appendChild(mkBtn(it, it.kind || 'audio')); });
  }

  function fetchDataUri(url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result)); }; fr.onerror = rej; fr.readAsDataURL(blob); });
    });
  }
  function estDur(item, dataUri) {
    var kb = item.sizeKB || (dataUri ? Math.round(dataUri.length * 3 / 4 / 1024) : 300);
    return Math.min(7000, Math.max(1800, kb * 6));
  }

  function send(item, kindDefault, b) {
    if (busy) return;
    busy = true; if (b) b.classList.add('zv-busy'); status('Preparando...', '');
    var kind = item.kind || kindDefault || 'audio';
    var prep;
    if (item.url) prep = fetchDataUri(item.url);
    else if (item.b64 && /^https?:/.test(item.b64)) prep = fetchDataUri(item.b64);
    else prep = Promise.resolve('data:' + (item.mime || 'audio/ogg') + ';base64,' + item.b64);
    prep.then(function (dataUri) {
      status(settings.simulate && kind === 'audio' ? 'Gravando...' : 'Enviando...', '');
      return call('send', { dataUri: dataUri, kind: kind, caption: item.caption || '', durMs: estDur(item, dataUri), simulate: settings.simulate });
    }).then(function (r) {
      if (r && r.ok) status('Enviado' + (r.data && r.data.number ? ' para ' + r.data.number : ''), 'ok');
      else status('Erro: ' + ((r && r.error) || 'falhou'), 'err');
    }).catch(function (e) { status('Falha: ' + (e && e.message || e), 'err'); })
      .then(function () { busy = false; if (b) b.classList.remove('zv-busy'); });
  }
  function status(m, k) { if (els.status) { els.status.textContent = m; els.status.className = k || ''; } }

  function pollActive() {
    setInterval(function () {
      call('active').then(function (r) {
        if (!els.who) return;
        if (r && r.ok) {
          els.dot.className = 'zv-on';
          els.who.textContent = (r.data && r.data.name) ? ('→ ' + r.data.name) : '→ abra uma conversa';
        } else {
          els.dot.className = 'zv-off';
          els.who.textContent = (r && /carregando/.test(r.error || '')) ? 'carregando WhatsApp...' : 'abra uma conversa';
        }
      });
    }, 2500);
  }

  boot();
})();
