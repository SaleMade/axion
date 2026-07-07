// ZapVoice Nosso — bridge (roda no MUNDO PRINCIPAL da pagina, junto do WA-JS)
// O WA-JS injeta a global WPP. Aqui a gente escuta comandos do painel (que roda
// no mundo isolado) via window.postMessage e chama a API real do WhatsApp:
//  - WPP.chat.getActiveChat()  -> conversa aberta (confiavel, nada de DOM)
//  - WPP.chat.markIsRecording/markIsComposing -> simula "gravando/digitando"
//  - WPP.chat.sendFileMessage(chatId, dataURI, {type:'audio', isPtt:true}) -> nota de voz
// Envia pela SESSAO do proprio atendente, igual o ZapVoice.
(function () {
  'use strict';
  function evt(name, data) { try { window.postMessage({ __zv: 'evt', name: name, data: data }, '*'); } catch (_) {} }
  function res(id, ok, data, error) { try { window.postMessage({ __zv: 'res', id: id, ok: ok, data: data, error: error }, '*'); } catch (_) {} }
  function ready() { return !!(window.WPP && window.WPP.isReady); }
  function onReady(cb) {
    if (ready()) return cb();
    if (window.WPP && window.WPP.loader && window.WPP.loader.onReady) { window.WPP.loader.onReady(cb); return; }
    var t = setInterval(function () { if (ready()) { clearInterval(t); cb(); } }, 400);
  }
  onReady(function () { evt('ready', true); });

  function activeInfo() {
    var c = window.WPP.chat.getActiveChat();
    if (!c) return null;
    var ct = c.contact || {};
    var name = ct.name || ct.pushname || ct.formattedName || c.formattedTitle || (c.id && c.id.user) || '';
    return { name: String(name), number: (c.id && c.id.user) || '', isGroup: !!c.isGroup };
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__zv !== 'req') return;
    var id = d.id, cmd = d.cmd, p = d.payload || {};
    if (!ready()) return res(id, false, null, 'WhatsApp ainda carregando');
    try {
      if (cmd === 'active') return res(id, true, activeInfo());
      if (cmd === 'send') {
        var c = window.WPP.chat.getActiveChat();
        if (!c) return res(id, false, null, 'Abra uma conversa primeiro');
        if (c.isGroup) return res(id, false, null, 'E um grupo. Abra a conversa de um lead.');
        var chatId = c.id;
        var wait = Math.min(7000, Math.max(1800, p.durMs || 3000));
        var kind = p.kind || 'audio';
        var sim = Promise.resolve();
        if (p.simulate !== false) {
          try { sim = (kind === 'audio') ? window.WPP.chat.markIsRecording(chatId, wait) : window.WPP.chat.markIsComposing(chatId, wait); } catch (_) {}
        }
        Promise.resolve(sim)
          .then(function () { return new Promise(function (r) { setTimeout(r, wait); }); })
          .then(function () {
            var opts = kind === 'audio' ? { type: 'audio', isPtt: true }
              : kind === 'video' ? { type: 'video', caption: p.caption || '' }
              : kind === 'image' ? { type: 'image', caption: p.caption || '' }
              : { type: 'auto-detect' };
            return window.WPP.chat.sendFileMessage(chatId, p.dataUri, opts);
          })
          .then(function () { res(id, true, { number: (c.id && c.id.user) || '' }); })
          .catch(function (err) { res(id, false, null, String((err && err.message) || err)); });
        return;
      }
      res(id, false, null, 'comando desconhecido');
    } catch (err) {
      res(id, false, null, String((err && err.message) || err));
    }
  });
})();
