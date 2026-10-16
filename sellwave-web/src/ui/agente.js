// AGENTE — o pedacinho que roda DENTRO da página do WhatsApp Web.
//
// Ele NÃO desenha nada. A interface do painel vive numa janela própria, ao lado, e não dentro da
// página: assim o layout do WhatsApp não precisa ser empurrado (dependeria do DOM deles, que muda)
// e o painel não pode ser quebrado pelo CSS deles.
//
// O que fica aqui é só o que precisa estar no mesmo mundo do WhatsApp:
//   - carregar e vigiar o motor (window.WPP)
//   - dizer qual conversa está aberta
//   - mandar mensagem, áudio e imagem
//   - escutar mensagem nova e enfileirar pra captura
//
// Quem injeta é o processo principal, com executeJavaScript: a CSP do WhatsApp barraria um
// <script>, e arrancar o cabeçalho de segurança pra ganhar conveniência seria piorar a segurança.
;(function () {
  if (window.__sw_agente) return
  window.__sw_agente = true

  var MARCA = '__sellwave__'
  var JID = /^\d{5,}@(c\.us|s\.whatsapp\.net|lid)$/i
  var soDigitos = function (j) { return String(j || '').replace(/@.*/, '').replace(/\D/g, '') }

  function podeEnviar() {
    try { var W = window.WPP; return !!(W && W.chat && typeof W.chat.sendTextMessage === 'function') } catch (_) { return false }
  }
  function motorVivo() {
    try { var W = window.WPP; return !!(podeEnviar() && W.whatsapp && W.whatsapp.ChatStore) } catch (_) { return false }
  }

  // A CONVERSA ABERTA NA TELA É A VERDADE (portado do painel que já roda em produção). O caminho
  // interno do WPP lê a flag .active, que num build veio toda apagada e noutro veio GRUDADA num
  // chat velho — e aí o painel aponta pro lead errado, que é o pior desfecho possível.
  function jidDoDom(raiz) {
    try {
      var nos = (raiz || document).querySelectorAll('[data-id]')
      var votos = {}, melhor = null, nMelhor = 0
      for (var i = 0; i < nos.length; i++) {
        var n = nos[i]
        // Só mensagem VISÍVEL: o WhatsApp deixa a conversa anterior escondida no DOM, e contar
        // aquilo faz o voto apontar pro lead errado.
        try { if (!n.offsetParent && n.offsetWidth === 0 && n.offsetHeight === 0) continue } catch (_) { /* ok */ }
        var m = /^(?:true|false)_([^_]+)_/.exec(n.getAttribute('data-id') || '')
        if (!m || !JID.test(m[1])) continue
        votos[m[1]] = (votos[m[1]] || 0) + 1
        if (votos[m[1]] > nMelhor) { nMelhor = votos[m[1]]; melhor = m[1] }
      }
      return melhor
    } catch (_) { return null }
  }
  function conversaAberta() {
    var dom = jidDoDom(document.querySelector('#main') || document)
    var interno = null
    try { interno = (window.WPP.chat.getActiveChat() || null) } catch (_) { /* ok */ }
    var idInterno = interno && interno.id && (interno.id._serialized || String(interno.id))
    if (dom && idInterno && dom !== idInterno) return dom   // discordaram: manda pro que está ABERTO
    return idInterno || dom || null
  }
  function nomeDaConversa() {
    try {
      var h = document.querySelector('#main header [title]')
      return h ? (h.getAttribute('title') || h.textContent || '') : ''
    } catch (_) { return '' }
  }
  function numeroDoAparelho() {
    try {
      var w = window.WPP.whatsapp.UserPrefs.getMaybeMeUser()
      return soDigitos(w && (w._serialized || w.user))
    } catch (_) { /* ok */ }
    try { return soDigitos(window.WPP.conn.getMyUserId()) } catch (_) { return '' }
  }

  // ───────────────────────────────────────────────────────────── envio
  function espera(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function comPrazo(p, ms, oque) {
    return Promise.race([p, new Promise(function (_, x) { setTimeout(function () { x(new Error('demorou demais: ' + oque)) }, ms) })])
  }
  // A MIDIA NAO E BAIXADA AQUI, DE PROPOSITO.
  //
  // A CSP do web.whatsapp.com tem connect-src que NAO inclui os nossos dominios: um fetch pra
  // /api/salechat/media/... de dentro da pagina e bloqueado pelo navegador, sem erro util. Quem
  // baixa e o processo principal (que nao passa por CSP nem por CORS) e manda o dataUri pronto
  // junto do item. Mesmo motivo de nao existir tag script aqui.

  // Manda UM item. `sim` é o tempo de "digitando"/"gravando" em segundos: é o que faz a conversa
  // não parecer disparo automático.
  window.__swManda = function (chatId, item) {
    var W = window.WPP
    if (!chatId) return Promise.reject(new Error('nenhuma conversa aberta'))
    if (!podeEnviar()) return Promise.reject(new Error('o motor do WhatsApp não está pronto'))
    if (item.tipo === 'texto') {
      var ms = Math.max(0, Number(item.sim || 0)) * 1000
      var pre = ms ? comPrazo(W.chat.markIsComposing(chatId, ms + 300), 8000, 'digitando').catch(function () {}) : Promise.resolve()
      return pre.then(function () { return espera(ms) })
        .then(function () { return comPrazo(W.chat.sendTextMessage(chatId, item.texto || ''), 60000, 'texto') })
        .then(function () { return true })
    }
    var dataUri = item.dataUri
    if (!dataUri) return Promise.reject(new Error('mídia não veio junto'))
    return Promise.resolve().then(function () {
      if (item.kind === 'audio') {
        var ms2 = Math.max(0, Number(item.sim || 0)) * 1000
        var pre2 = ms2 ? comPrazo(W.chat.markIsRecording(chatId, ms2 + 300), 8000, 'gravando').catch(function () {}) : Promise.resolve()
        return pre2.then(function () { return espera(ms2) })
          .then(function () { return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'audio', isPtt: true }), 120000, 'áudio') })
      }
      if (item.kind === 'image') return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'image', caption: item.caption || '' }), 120000, 'imagem')
      if (item.kind === 'video') return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'video', caption: item.caption || '' }), 180000, 'vídeo')
      return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'document', caption: item.caption || '', filename: item.label || 'arquivo' }), 120000, 'documento')
    }).then(function () { return true })
  }

  // O que o painel pergunta a cada pulso.
  window.__swEstado = function () {
    var chatId = conversaAberta()
    return {
      motor: motorVivo(),
      envia: podeEnviar(),
      chatId: chatId || '',
      phone: soDigitos(chatId),
      nome: nomeDaConversa(),
      eu: numeroDoAparelho(),
      capturadas: window.__swVistasN || 0,
    }
  }

  // ───────────────────────────────────────────────────────────── captura
  // Dedupe por id é obrigatório: o WhatsApp reemite mensagem na sincronização e listener duplicado
  // é normal. Sem isso a dash enche de repetida (já aconteceu: 357 duplicadas em setembro).
  var vistas = {}
  window.__swVistasN = 0

  // SÓ CONVERSA DE PESSOA. Lista de PERMITIDOS, não de proibidos: filtrar só @g.us deixava passar
  // status@broadcast, newsletter e lista de transmissão, que viravam conversa no inbox do CRM e
  // lead fantasma na roleta.
  var SO_PESSOA = /^\d{5,}@(c\.us|s\.whatsapp\.net|lid)$/i

  function partes(wid) {
    try {
      var s = (wid && (wid._serialized || (wid.id && wid.id._serialized))) || (typeof wid === 'string' ? wid : '')
      if (!s) return { digits: '', isLid: false, ser: '' }
      return { digits: String(s).replace(/@.*/, '').replace(/\D/g, ''), isLid: /@lid$/i.test(s), ser: String(s) }
    } catch (_) { return { digits: '', isLid: false, ser: '' } }
  }

  // TELEFONE DE VERDADE QUANDO A CONVERSA É POR LID (portado do painel em produção).
  //
  // Em conversa endereçada por LID, o identificador NÃO é telefone. Mandar os dígitos dele como
  // telefone faz o worker descartar o evento inteiro (a guarda do `lid`), e aí a mensagem do lead
  // não vira lead, não vira bolha no inbox e não casa com o pedido. Some sem erro nenhum.
  function telefoneReal(msg, deMim) {
    try {
      var W = window.WPP
      var wid = deMim ? msg.to : msg.from
      var p = partes(wid)
      if (p.digits && !p.isLid) return { digits: p.digits, isLid: false }
      var meu = numeroDoAparelho()
      var cands = []
      var push = function (x) { if (x != null) cands.push(x) }
      // O remetente só serve quando a mensagem é RECEBIDA: numa enviada o remetente sou eu.
      if (!deMim) {
        try { var so = msg.senderObj || msg.sender; push(so && (so.id || (so.attributes && so.attributes.id))); push(so && so.phoneNumber) } catch (_) { /* ok */ }
        try { push(msg.author) } catch (_) { /* ok */ }
      }
      try { var c = W && W.contact && W.contact.get ? W.contact.get(p.ser) : null; if (c) { push(c.id || (c.attributes && c.attributes.id)); push(c.phoneNumber || (c.attributes && c.attributes.phoneNumber)) } } catch (_) { /* ok */ }
      try { var ch = W && W.chat && W.chat.get ? W.chat.get(p.ser) : null; var cc = ch && ch.contact; if (cc) { push(cc.id || (cc.attributes && cc.attributes.id)); push(cc.phoneNumber || (cc.attributes && cc.attributes.phoneNumber)) } } catch (_) { /* ok */ }
      try { var LU = W && W.whatsapp && (W.whatsapp.LidUtils || W.whatsapp.functions); if (LU && LU.getPhoneNumberForLid) push(LU.getPhoneNumberForLid(wid)) } catch (_) { /* ok */ }
      for (var i = 0; i < cands.length; i++) {
        var cp = partes(cands[i])
        if (cp.digits && !cp.isLid && cp.digits !== meu) return { digits: cp.digits, isLid: false }
        if (typeof cands[i] === 'string' && cands[i].indexOf('@lid') < 0) {
          var ds = String(cands[i]).replace(/\D/g, '')
          if (ds.length >= 12 && ds !== meu) return { digits: ds, isLid: false }
        }
      }
      return { digits: p.digits, isLid: true }   // não resolveu: marca lid e o worker decide
    } catch (_) { return { digits: '', isLid: false } }
  }

  function capturar(msg) {
    try {
      if (!msg) return
      var deMim = !!(msg.fromMe || (msg.id && msg.id.fromMe))
      var p = partes(deMim ? msg.to : msg.from)
      if (!p.ser || !SO_PESSOA.test(p.ser)) return            // grupo, status, newsletter: não é lead
      var pr = telefoneReal(msg, deMim)
      if (!pr.digits) return
      if (pr.digits === numeroDoAparelho()) return            // conversa comigo mesmo
      var ts = Number(msg.t || msg.timestamp || 0)
      var id = (msg.id && (msg.id.id || (msg.id._serialized ? String(msg.id._serialized).split('_').pop() : ''))) || ''
      if (!id) id = 'sw_' + (ts || Date.now()) + '_' + pr.digits + '_' + deMim
      if (vistas[id]) return
      vistas[id] = 1
      window.__swVistasN++
      var tipoBruto = String(msg.type || 'chat')
      // VOCABULÁRIO DA META, não o do WA-JS. O resto do sistema fala 'text' e 'audio'; o WA-JS fala
      // 'chat' e 'ptt'. Sem traduzir, a mesma conversa fica com dois vocabulários no banco e a
      // bolha do inbox não sabe o que desenhar.
      var tipo = { chat: 'text', ptt: 'audio', voice: 'audio' }[tipoBruto.toLowerCase()] || tipoBruto
      var ehMidia = /^(image|audio|video|document|sticker)$/i.test(tipo)
      // A MENSAGEM VELHA VAI JUNTO, MARCADA. Descartar aqui dentro fazia ela sumir sem rastro
      // nenhum: o notebook fechado por uma hora perdia tudo que chegou no meio. Quem decide o que
      // fazer com mensagem velha é o servidor, que tem contexto e deduplicação.
      var velha = ts && (Date.now() / 1000 - ts) > 1800 ? 1 : 0
      window.postMessage({
        alvo: MARCA, canal: 'swp:captura', dados: { eventos: [{
          msgId: id,
          selfNumber: numeroDoAparelho(),
          phone: pr.digits,
          lid: pr.isLid ? 1 : 0,
          velha: velha,
          fromMe: deMim,
          type: tipo,
          body: (ehMidia ? String(msg.caption || '') : String(msg.body || msg.caption || '')).slice(0, 2000),
          pushName: String((msg.sender && (msg.sender.pushname || msg.sender.name)) || msg.notifyName || ''),
          ts: ts,
        }] },
      }, '*')
    } catch (_) { /* captura nunca pode derrubar a página do vendedor */ }
  }

  var ligado = null
  setInterval(function () {
    try {
      var W = window.WPP
      if (!W || !W.on || ligado === W) return
      try { if (W.off && ligado) W.off('chat.new_message', capturar) } catch (_) { /* ok */ }
      W.on('chat.new_message', capturar)
      ligado = W
      console.log('[sellwave] captura ligada')
    } catch (_) { /* ok */ }
  }, 2000)

  console.log('[sellwave] agente instalado')
})()
