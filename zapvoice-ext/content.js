// ZapVoice Nosso — content script (roda dentro do web.whatsapp.com)
// Injeta um painel flutuante com os audios/videos do atendente. Detecta o
// numero do chat aberto (pelo data-id das mensagens) e dispara pela Evolution
// via Worker AXION (/api/wa/send-audio | /api/wa/send-media).
(function () {
  let cfg = {};
  let items = [];
  let numInput, listEl, statusEl, panel;

  chrome.storage.local.get(['zv_cfg', 'zv_items'], (r) => {
    cfg = r.zv_cfg || {};
    items = r.zv_items || [];
    boot();
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.zv_cfg) cfg = ch.zv_cfg.newValue || {};
    if (ch.zv_items) { items = ch.zv_items.newValue || []; renderList(); }
  });

  function boot() {
    // WhatsApp Web demora pra montar; espera o body estar pronto
    const t = setInterval(() => {
      if (document.body && !document.getElementById('zv-panel')) { clearInterval(t); injectPanel(); }
    }, 800);
  }

  // Lê o número do chat aberto a partir do data-id das mensagens (false_5599...@c.us_ID)
  function detectNumber() {
    let num = '';
    document.querySelectorAll('[data-id]').forEach((el) => {
      const m = (el.getAttribute('data-id') || '').match(/_(\d{8,15})@c\.us/);
      if (m) num = m[1];
    });
    return num;
  }

  function injectPanel() {
    panel = document.createElement('div');
    panel.id = 'zv-panel';
    panel.innerHTML = [
      '<div id="zv-head"><span id="zv-title">ZapVoice Nosso</span><span id="zv-min" title="Recolher">–</span></div>',
      '<div id="zv-body">',
      '  <div id="zv-numrow"><input id="zv-num" placeholder="numero do chat"><button id="zv-refresh" title="Detectar do chat aberto">detectar</button></div>',
      '  <div id="zv-list"></div>',
      '  <div id="zv-status"></div>',
      '  <div id="zv-foot"><a id="zv-opts">Configurar / meus audios</a></div>',
      '</div>'
    ].join('');
    document.body.appendChild(panel);

    numInput = panel.querySelector('#zv-num');
    listEl = panel.querySelector('#zv-list');
    statusEl = panel.querySelector('#zv-status');
    panel.querySelector('#zv-refresh').onclick = () => { numInput.value = detectNumber() || numInput.value; };
    panel.querySelector('#zv-min').onclick = () => panel.classList.toggle('zv-collapsed');
    panel.querySelector('#zv-head').ondblclick = () => panel.classList.toggle('zv-collapsed');
    panel.querySelector('#zv-opts').onclick = () => chrome.runtime.openOptionsPage();

    numInput.value = detectNumber();
    // acompanha a troca de chat sem atropelar o que o user digitou
    setInterval(() => {
      if (document.activeElement !== numInput) { const n = detectNumber(); if (n) numInput.value = n; }
    }, 2500);
    renderList();
  }

  function renderList() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<div class="zv-empty">Nenhum audio ainda. Clique em "Configurar / meus audios" e adicione os seus.</div>';
      return;
    }
    listEl.innerHTML = '';
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'zv-item';
      const tag = it.kind === 'video' ? 'VIDEO' : 'AUDIO';
      b.innerHTML = '<span class="zv-stage">' + esc(it.stage || tag) + '</span><span class="zv-label">' + esc(it.label || ('Item ' + (i + 1))) + '</span>';
      b.onclick = () => sendItem(it);
      listEl.appendChild(b);
    });
  }

  async function sendItem(it) {
    const number = (numInput.value || '').replace(/\D/g, '');
    if (!number) { setStatus('Sem numero. Abra um chat ou digite o numero.', true); return; }
    if (!cfg.workerUrl || !cfg.token || !cfg.instance) { setStatus('Config incompleta. Clique em Configurar.', true); return; }
    setStatus('Enviando ' + (it.label || 'item') + '...');
    try {
      const base = cfg.workerUrl.replace(/\/+$/, '');
      let url, payload;
      if (it.kind === 'video' || it.kind === 'image') {
        url = base + '/api/wa/send-media';
        payload = { number, instance: cfg.instance, media: it.b64, mediatype: it.kind, mimetype: it.mime, fileName: (it.label || 'midia'), caption: it.caption || '' };
      } else {
        url = base + '/api/wa/send-audio';
        payload = { number, instance: cfg.instance, audio_base64: it.b64 };
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus('Erro: ' + (d.error || ('HTTP ' + r.status)), true); return; }
      setStatus('Enviado para ' + number);
    } catch (e) { setStatus('Falha: ' + e.message, true); }
  }

  function setStatus(msg, isErr) { if (statusEl) { statusEl.textContent = msg; statusEl.className = isErr ? 'zv-err' : 'zv-ok'; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
