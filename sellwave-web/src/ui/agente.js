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
  // SO CONVERSA DE PESSOA. Lista de PERMITIDOS, usada tanto pra achar a conversa quanto pra
  // capturar e pra ENVIAR. Antes ela so valia na captura: com um grupo aberto na tela, o painel
  // liberava o botao e um funil inteiro ia parar dentro do grupo.
  var JID = /^\d{5,}@(c\.us|s\.whatsapp\.net|lid)$/i
  var ehPessoa = function (id) { return JID.test(String(id || '')) }
  var soDigitos = function (j) { return String(j || '').replace(/@.*/, '').replace(/\D/g, '') }

  function podeEnviar() {
    try { var W = window.WPP; return !!(W && W.chat && typeof W.chat.sendTextMessage === 'function') } catch (_) { return false }
  }
  function motorVivo() {
    try { var W = window.WPP; return !!(podeEnviar() && W.whatsapp && W.whatsapp.ChatStore) } catch (_) { return false }
  }

  // AUTENTICADO E OUTRA COISA, E E ESTA QUE IMPORTA.
  //
  // `motorVivo` diz que a BIBLIOTECA carregou. Medido: na tela do QR, sem nenhum aparelho pareado,
  // motorVivo ja e true, podeEnviar ja e true e ate WPP.isReady e true. Quem diz a verdade e so o
  // isAuthenticated.
  // Isso ja derrubou lead nesta casa uma vez, no outro caminho: o comentario em AXION/sc-inject.js
  // diz, com todas as letras, "WhatsApp deslogado ainda tem WPP.on, entao mandava 1 mesmo
  // deslogado, e o servidor achava o numero vivo e mandava lead pra ninguem".
  function autenticado() {
    try { return !!(window.WPP && window.WPP.conn && window.WPP.conn.isAuthenticated && window.WPP.conn.isAuthenticated()) } catch (_) { return false }
  }

  // ────────────────────────────────────────────────────────────────────────────────────────
  // O ESTADO DA CONEXAO, pra tela saber se o numero esta de pe (18/10/2026, pedido do Bruno:
  // "numero conectado ou nao? (...) ou que apareca: numero foi restrito, numero levou ban").
  //
  // A IDEIA QUE ORGANIZA ISTO E DELE, e e mais simples que a minha: se foi ACAO DE GENTE (fechou o
  // WhatsApp, fechou a janela), nao foi ban. Se a janela estava aberta, tudo funcionando, e o
  // WhatsApp caiu sozinho, ai e evento do WhatsApp. Quem sabe separar os dois e o APP, porque e ele
  // que fecha a janela - o servidor so ve silencio, e silencio nao distingue nada.
  // Aqui dentro a gente cuida da metade "o que o WhatsApp fez"; a metade "o que a pessoa fez" e do
  // main.js.
  //
  // `jaAutenticou` e a peca que separa "nunca pareou" de "caiu": sem ela, a tela do QR de um numero
  // novo e a tela do QR de um numero que acabou de ser desconectado sao identicas.
  var jaAutenticou = false
  var ultimaQueda = null   // { modo, motivo, ts } do evento que derrubou, pra calibrar depois
  function estadoConn() {
    var modo = '', info = ''
    try {
      var d = window.WPP && window.WPP.conn && window.WPP.conn.getStreamData && window.WPP.conn.getStreamData()
      modo = String((d && d.mode) || '')
      info = String((d && d.info) || '')
    } catch (_) { modo = ''; info = '' }
    var auth = autenticado()
    if (auth) jaAutenticou = true
    // A ORDEM IMPORTA: bloqueio e conflito ANTES de offline, senao um pisco de internet esconde
    // um TOS_BLOCK, que e o sinal mais grave que existe aqui.
    var st = 'naosei'
    if (modo === 'TOS_BLOCK' || modo === 'SMB_TOS_BLOCK') st = 'bloqueado'
    else if (modo === 'CONFLICT') st = 'conflito'
    else if (modo === 'PROXYBLOCK') st = 'proxy'
    else if (modo === 'DEPRECATED_VERSION') st = 'versao'
    else if (modo === 'MAIN' && auth) st = 'pronto'
    else if (modo === 'SYNCING') st = 'sincronizando'
    else if (modo === 'OFFLINE') st = 'offline'
    else if (modo === 'QR') st = jaAutenticou ? 'caiu' : 'qr'
    else if (modo === '') st = 'naosei'   // o motor ainda nao registrou o Stream: nao e queda
    return { st: st, modo: modo, info: info, queda: ultimaQueda }
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
  // ONDE A CONVERSA ABERTA MORA NA TELA. Varios seletores de proposito: apoiar o painel inteiro
  // num `#main` so transforma uma renomeacao da Meta em "Abra uma conversa" com a conversa aberta.
  var ONDE_CONVERSA = ['#main', '[data-testid="conversation-panel-messages"]', '[data-testid="conversation-panel-body"]', '#app div[role="application"]']
  function painelDaConversa() {
    for (var i = 0; i < ONDE_CONVERSA.length; i++) {
      try { var el = document.querySelector(ONDE_CONVERSA[i]); if (el) return el } catch (_) { /* seletor invalido num build antigo */ }
    }
    return null
  }

  function conversaAberta() {
    var main = painelDaConversa()
    // O VOTO DO DOM SO VALE DENTRO DA CONVERSA ABERTA.
    //
    // Varrendo o documento inteiro, uma busca de mensagens (sem conversa aberta) elege o chat do
    // resultado da busca: o painel mostrava o lead dele e LIBERAVA o disparo. Um funil de cinco
    // passos ia pra quem o vendedor so pesquisou.
    var dom = main ? jidDoDom(main) : null
    var interno = null
    try { interno = (window.WPP.chat.getActiveChat() || null) } catch (_) { /* ok */ }
    var idInterno = interno && interno.id && (interno.id._serialized || String(interno.id))
    var escolhido = null
    if (dom && idInterno && dom !== idInterno) escolhido = dom        // discordaram: vale o que está ABERTO
    else if (dom) escolhido = dom
    // SEM VOTO DO DOM, O INTERNO SO VALE COM CONVERSA ABERTA NA TELA.
    //
    // A flag .active do WhatsApp fica GRUDADA num chat velho: com a conversa fechada (Esc), o
    // getActiveChat continuava apontando pro último lead e o painel liberava o disparo. O funil ia
    // pra quem ele tinha acabado de deixar.
    else if (idInterno && main) escolhido = idInterno
    if (!escolhido) return null
    // Grupo, status e newsletter não recebem disparo: a mesma regra da captura.
    if (ehPessoa(escolhido)) { ultimoRecusado = ''; return escolhido }
    // GUARDA O MOTIVO. Sem isso o painel escrevia "Abra uma conversa" com o grupo aberto na tela e
    // todos os botões cinzas: o vendedor conclui que o painel quebrou, não que existe uma regra.
    ultimoRecusado = escolhido
    return null
  }
  var ultimoRecusado = ''
  // O NOME DA CONVERSA. Este bloco inteiro foi REESCRITO em 16/10/2026, a noite, depois de uma
  // revisao adversarial achar que a primeira tentativa dele era CODIGO MORTO:
  //
  //   `WPP.contact.get(chatId)` E ASSINCRONO. Provado no proprio motor (sc-wajs.js, modulo 296910:
  //   `t.get=async function(e){...return o.ContactStore.get(t)}`). Ele devolve uma PROMESSA, e
  //   promessa e truthy, entao o `if (c)` entrava e `c.name`, `c.pushname`, `c.verifiedName` e
  //   `c.attributes` saiam TODOS undefined. Nove candidatos empilhados, zero contribuicao.
  //
  // Com aquele bloco morto, quem respondia era `chat.get` (esse e SINCRONO: `t.get=function(e)`),
  // e ali o `formattedTitle` vinha primeiro. Pra contato NAO SALVO o WhatsApp preenche o
  // formattedTitle com o TELEFONE FORMATADO - e era por isso que o campo NOME do cadastro de
  // pedido nascia com "+55 74 9995-7871" em vez do push name que aparece logo abaixo dele.
  //
  // A FORMA CERTA JA ESTAVA EM PRODUCAO, no `activeInfo()` do AXION/sc-panel.js (por volta da
  // linha 436), rodando ha meses no Sale Chat do Bruno:
  //
  //     var ct = c.contact || {}
  //     ct.name || ct.pushname || ct.formattedName || c.formattedTitle || c.id.user
  //
  // Nome da AGENDA primeiro, PUSH NAME antes do formattedName e do formattedTitle, tudo lido do
  // contato DO MODEL DO CHAT, de forma sincrona, sem `contact.get` nenhum. E a regra do Bruno:
  // quando a casa ja resolveu o problema, a versao que roda vence a ideia nova.
  //
  // A unica diferenca daqui pra la e o fim da fila: o sc-panel cai em `c.id.user` (o numero) porque
  // la o valor so vira rotulo na tela. Aqui ele entra no CADASTRO DE PEDIDO, e dali vai pro nome do
  // cliente na PayLog, na etiqueta e na cobranca. Entao numero NAO vale como nome: melhor voltar
  // vazio e o painel mostrar `formata(fone)` do que carimbar telefone no campo Nome.
  var NAO_E_NOME = /^(dados do perfil|informacoes do contato|informa..es do contato|perfil|contact info|profile details)$/i

  // PRESENCA NAO E NOME. A segunda linha do cabecalho, onde o push name aparece, e o MESMO lugar
  // onde o WhatsApp escreve "online", "digitando...", "gravando audio..." e "visto por ultimo hoje
  // as 14:02". Tudo isso tem letra, entao passaria por qualquer filtro de telefone e viraria nome
  // de cliente dentro do pedido. E a mesma familia do incidente do "Dados do perfil".
  // 16/10: "clique/toque para ..." inteiro entrou. O Bruno viu "clique para mostrar os dados do
  // contato" dentro do campo NOME do pedido: frase legitima em portugues, com letra, que passou
  // pelo filtro de telefone E pelo de letra. O campo do pedido deixou de usar o titulo por causa
  // disso; isto aqui e pra o CABECALHO do painel tambem nao mostrar a interface como se fosse
  // o nome do cliente.
  var PRESENCA = /^(online|offline|digitando|gravando( [aá]udio)?|typing|recording|visto por [uú]ltimo\b.*|[uú]ltima vez\b.*|last seen\b.*|aqui para.*|(clique|toque|tap|click)\s+(aqui|para|to)\b.*)[.…]*$/i

  // SO TELEFONE TAMBEM NAO E NOME. O minimo de 6 caracteres evita jogar fora apelido curto e
  // legitimo feito de digito (um "2112" e nome ruim, mas e nome).
  var SO_TELEFONE = /^[\s+()\-.\d]{6,}$/

  // O TIL E ENFEITE DO WHATSAPP: ele marca "isto e push name, nao e contato salvo", igual na lista
  // de participantes de grupo. No atributo do motor ele nao vem (prova: o push name capturado e
  // gravado CRU em wa_messages.push_name e nao ha strip de til em lugar nenhum do worker); pelo DOM
  // vem. Tirar aqui e o unico lugar que serve pros dois caminhos.
  //
  // E EMOJI SAI, de proposito. O que o Bruno pediu e o NOME ("~Amor"), e esse valor nao para na
  // tela: ele vai pro campo Nome do pedido, e dali pro `customer[name]` da PayLog quando ele aceita
  // - ou seja pra etiqueta de despacho e pra cobranca. Coracao na etiqueta nao ajuda ninguem, e o
  // campo continua editavel se ele quiser por de volta.
  function limpaNome(v) {
    var t = String(v == null ? '' : v).replace(/^[~\s]+/, '').trim()
    if (!t) return ''
    if (NAO_E_NOME.test(t) || PRESENCA.test(t)) return ''
    // Sobram letra (com acento), digito, espaco, apostrofo, hifen, ponto e &. O resto vira espaco.
    try { t = t.replace(/[^\p{L}\p{N} '\-.&]/gu, ' ').replace(/\s+/g, ' ').trim() }
    catch (_) { t = t.replace(/[^A-Za-z0-9À-ɏ '\-.&]/g, ' ').replace(/\s+/g, ' ').trim() }
    if (!t) return ''
    if (SO_TELEFONE.test(t)) return ''
    return t
  }

  function nomeDaConversa() {
    var chatId = ''
    try { chatId = conversaAberta() || '' } catch (_) { chatId = '' }
    // SEM CONVERSA DE PESSOA, SEM NOME. `conversaAberta` ja recusa grupo; sem este corte, o ultimo
    // recurso do DOM devolveria o ASSUNTO DO GRUPO como se fosse nome de lead.
    if (!chatId) return ''
    try {
      var ch = (window.WPP && window.WPP.chat && window.WPP.chat.get) ? window.WPP.chat.get(chatId) : null
      if (ch) {
        var ct = ch.contact || {}
        // A ordem do sc-panel, com `verifiedName` somado depois do nome da agenda: pra empresa, o
        // nome verificado vale mais que o apelido que ela escolheu.
        var cands = [ct.name, ct.verifiedName, ct.pushname, ct.notifyName, ct.formattedName,
          ch.formattedTitle, ch.name]
        for (var i = 0; i < cands.length; i++) {
          var bom = limpaNome(cands[i])
          if (bom) return bom
        }
      }
    } catch (_) { /* sem motor, o DOM tenta */ }
    // ULTIMO RECURSO: SO O TITULO, e so o `span[title]`, que e o mesmo seletor que o sc-panel usa
    // (`header span[title]`). Varrer os outros span do cabecalho seria pescar a linha de presenca.
    // Pra contato nao salvo o titulo e o telefone, o filtro recusa, e o nome volta VAZIO - que e o
    // resultado certo: o painel mostra `formata(fone)` e o vendedor digita se quiser.
    try {
      var t = document.querySelector('#main header span[title]')
      return limpaNome(t && (t.getAttribute('title') || t.textContent))
    } catch (_) { return '' }
  }
  // QUATRO TENTATIVAS, as mesmas do painel que ja roda em producao. Com duas so, o numero voltava
  // vazio em alguns builds - e numero vazio agora significa "nao mando sinal de vida", ou seja um
  // numero pareado sairia da roleta em silencio. A folga aqui protege contra isso.
  function numeroDoAparelho() {
    var tentativas = [
      function () { return window.WPP.conn.getMyUserId() },
      function () { return window.WPP.whatsapp.UserPrefs.getMaybeMeUser() },
      function () { return window.WPP.conn.me },
      function () { return window.WPP.conn.wid },
    ]
    for (var i = 0; i < tentativas.length; i++) {
      try {
        var w = tentativas[i]()
        var d = soDigitos(w && (w._serialized || w.user || w))
        if (d.length >= 10) return d
      } catch (_) { /* tenta a proxima */ }
    }
    return ''
  }

  // ───────────────────────────────────────────────────────────── envio
  function comPrazo(p, ms, oque) {
    return Promise.race([p, new Promise(function (_, x) { setTimeout(function () { x(new Error('demorou demais: ' + oque)) }, ms) })])
  }
  // A MIDIA NAO E BAIXADA AQUI, DE PROPOSITO.
  //
  // A CSP do web.whatsapp.com tem connect-src que NAO inclui os nossos dominios: um fetch pra
  // /api/salechat/media/... de dentro da pagina e bloqueado pelo navegador, sem erro util. Quem
  // baixa e o processo principal (que nao passa por CSP nem por CORS) e manda o dataUri pronto
  // junto do item. Mesmo motivo de nao existir tag script aqui.

  // LIGA O "DIGITANDO.../GRAVANDO..." E VOLTA NA HORA.
  //
  // Quem espera é o painel, não aqui, e isso não é detalhe: a pausa do passo precisa acontecer num
  // lugar onde o botão Parar seja olhado. Antes o envio ligava o indicador E dormia, então apertar
  // Parar no meio de uma pausa de 10 s não fazia nada até o item terminar.
  // O ENVIO INTEIRO ACONTECE AQUI DENTRO, COMO NO SALE CHAT QUE JA RODA EM PRODUCAO.
  //
  // CORRIGINDO UM DIAGNOSTICO MEU QUE ESTAVA ERRADO (16/10/2026): eu tinha concluido que o
  // `markIsRecording` travava o envio do audio, porque o gravador aparece aberto na barra no print
  // do Bruno. O proprio Sale Chat dele desmente isso - ele usa `markIsRecording` do mesmo jeito,
  // ha meses, e manda audio sem problema (AXION/sc-panel.js, por volta da linha 1784). Diagnostico
  // bonito que a producao desmente e palpite, nao achado.
  //
  // O QUE EU TINHA DE DIFERENTE, E QUE AGORA DEIXOU DE SER: eu quebrei o que la e UMA cadeia
  // continua dentro da pagina em TRES saltos entre processos - indicador, espera no painel, envio.
  // Cada salto e uma chance de a ordem mudar, de um retorno nao chegar e de o estado da barra de
  // escrever ser outro na hora do envio. A versao que funciona faz indicador, espera e envio
  // GRUDADOS, na mesma promessa, do lado de dentro. Agora esta igual.
  //
  // A ESPERA CONTINUA INTERROMPIVEL: `esperaOuPara` confere a cada 400ms se o Parar foi apertado,
  // que e exatamente o `sleepStop` de la. O painel so precisa ligar `window.__swParar`.
  window.__swParar = false
  function esperaOuPara(ms) {
    return new Promise(function (ok) {
      var feito = 0
      ;(function passo() {
        if (window.__swParar) { ok(true); return }
        if (feito >= ms) { ok(false); return }
        var p = Math.min(400, ms - feito)
        setTimeout(function () { feito += p; passo() }, p)
      })()
    })
  }

  // Continua existindo pra quem ja chama, mas nao espera mais nada: quem liga o indicador agora e
  // o proprio envio, colado na espera.
  window.__swIndica = function () { return Promise.resolve(true) }

  // Manda UM item. A PAUSA NÃO ACONTECE AQUI (ver __swIndica): o painel já esperou.
  window.__swManda = function (chatId, item) {
    var W = window.WPP
    if (!chatId) return Promise.reject(new Error('nenhuma conversa aberta'))
    // TRAVA FINAL DO ENVIO. Mesmo que algo mais acima erre, nada sai pra grupo ou lista.
    if (!ehPessoa(chatId)) return Promise.reject(new Error('essa conversa não é de uma pessoa'))
    if (!podeEnviar()) return Promise.reject(new Error('o motor do WhatsApp não está pronto'))
    // A PAUSA DO PASSO E DAQUI PRA BAIXO. Vem em `item.pausa`, em segundos, ja resolvida pelo
    // painel (vale `sim` se preenchido, senao `delay`, nunca a soma).
    var pausaMs = Math.max(0, Math.min(120, Number(item.pausa) || 0)) * 1000
    window.__swParar = false

    if (item.tipo === 'texto') {
      var pre = Promise.resolve()
      if (pausaMs) { try { pre = comPrazo(W.chat.markIsComposing(chatId, pausaMs + 300), 8000, 'digitando') } catch (_) { /* ok */ } }
      return pre.catch(function () {})
        .then(function () { return esperaOuPara(pausaMs) })
        .then(function (parou) {
          if (parou) return false
          return comPrazo(W.chat.sendTextMessage(chatId, item.texto || ''), 60000, 'texto').then(function () { return true })
        })
    }
    var dataUri = item.dataUri
    if (!dataUri) return Promise.reject(new Error('mídia não veio junto'))
    return Promise.resolve().then(function () {
      if (item.kind === 'audio') {
        var preA = Promise.resolve()
        if (pausaMs) { try { preA = comPrazo(W.chat.markIsRecording(chatId, pausaMs + 300), 8000, 'gravando') } catch (_) { /* ok */ } }
        return preA.catch(function () {})
          .then(function () { return esperaOuPara(pausaMs) })
          .then(function (parou) {
            if (parou) return false
            return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'audio', isPtt: true }), 120000, 'áudio')
          })
      }
      return esperaOuPara(pausaMs).then(function (parou) {
        if (parou) return false
        if (item.kind === 'image') return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'image', caption: item.caption || '' }), 120000, 'imagem')
        if (item.kind === 'video') return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'video', caption: item.caption || '' }), 180000, 'vídeo')
        return comPrazo(W.chat.sendFileMessage(chatId, dataUri, { type: 'document', caption: item.caption || '', filename: item.label || 'arquivo' }), 120000, 'documento')
      })
    }).then(function () { return true })
  }

  // O que o painel pergunta a cada pulso.
  // Telefone DE VERDADE da conversa aberta, pro painel procurar o lead certo. Em conversa por LID
  // os digitos do id NAO sao telefone: sem resolver, o painel pedia lead de um numero inexistente e
  // mostrava "sem pedido na dash" pra um cliente que tem pedido.
  var cacheLid = {}
  function telefoneDaConversa(chatId) {
    if (!chatId) return { digits: '', isLid: false }
    var p = partes(chatId)
    if (p.digits && !p.isLid) return { digits: p.digits, isLid: false }
    if (cacheLid[chatId]) return cacheLid[chatId]
    var r = telefoneReal({ from: chatId, to: chatId }, false)
    if (r && r.digits && !r.isLid) cacheLid[chatId] = r
    return r || { digits: p.digits, isLid: true }
  }

  window.__swEstado = function () {
    var chatId = conversaAberta()
    var tel = telefoneDaConversa(chatId)
    return {
      motor: motorVivo(),
      // `autenticado` e o que vale pra dizer que o numero esta de pe. `motor` fica como
      // diagnostico de injecao.
      autenticado: autenticado(),
      // O ESTADO DA CONEXAO vai junto, no mesmo objeto que o main ja le a cada minuto. Campo novo
      // nao quebra quem nao conhece: `painel-ui.js` le motor/autenticado/envia e continua igual.
      conn: estadoConn(),
      envia: podeEnviar(),
      chatId: chatId || '',
      phone: tel.digits || '',
      lid: tel.isLid ? 1 : 0,
      nome: nomeDaConversa(),
      eu: numeroDoAparelho(),
      // POR QUE NAO HA CONVERSA: o painel precisa dizer "grupo" em vez de "abra uma conversa".
      grupo: (!chatId && ultimoRecusado) ? 1 : 0,
      capturadas: window.__swVistasN || 0,
    }
  }

  // ───────────────────────────────────────────────────────────── captura
  // Dedupe por id é obrigatório: o WhatsApp reemite mensagem na sincronização e listener duplicado
  // é normal. Sem isso a dash enche de repetida (já aconteceu: 357 duplicadas em setembro).
  var vistas = {}
  window.__swVistasN = 0

  function partes(wid) {
    try {
      // RESERVA DE toString. O WhatsApp as vezes entrega um Wid sem `_serialized`, so com
      // user/server e um toString. Sem a reserva, a mensagem saia DESCARTADA em silencio no dia em
      // que eles mudassem o formato - e e o tipo de mudanca que eles fazem sem avisar.
      var s = (wid && (wid._serialized || (wid.id && wid.id._serialized)))
        || (typeof wid === 'string' ? wid : '')
        || (wid && wid.toString && String(wid.toString()))
        || ''
      s = String(s)
      if (!s || s === '[object Object]') return { digits: '', isLid: false, ser: '' }
      // Tira o sufixo do aparelho (":12" em 5511999@c.us:12), senao o JID nao casa com a lista.
      s = s.replace(/:(\d+)@/, '@')
      var servidor = (wid && wid.server) || (s.split('@')[1] || '')
      return { digits: s.replace(/@.*/, '').replace(/\D/g, ''), isLid: /lid/i.test(String(servidor)), ser: s }
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
      // O CONTATO VEM DO ContactStore, QUE E SINCRONO. O `W.contact.get` e async (medido no motor:
      // `t.get=async function(e){...return o.ContactStore.get(t)}`), entao chamar sem await
      // devolvia uma Promise e `promise.phoneNumber` era sempre undefined - o candidato que mais
      // deveria resolver nunca entrava na lista. Esta funcao e sincrona de proposito (ela roda
      // dentro do handler de mensagem nova), entao quem serve aqui e o Store.
      try {
        var CS = W && W.whatsapp && W.whatsapp.ContactStore
        var c = CS && CS.get ? CS.get(p.ser) : null
        if (c) { push(c.id || (c.attributes && c.attributes.id)); push(c.phoneNumber || (c.attributes && c.attributes.phoneNumber)) }
      } catch (_) { /* ok */ }
      try { var ch = W && W.chat && W.chat.get ? W.chat.get(p.ser) : null; var cc = ch && ch.contact; if (cc) { push(cc.id || (cc.attributes && cc.attributes.id)); push(cc.phoneNumber || (cc.attributes && cc.attributes.phoneNumber)) } } catch (_) { /* ok */ }
      // O CACHE DE LID DO PROPRIO MOTOR. E o que o WhatsApp usa internamente pra achar o telefone
      // de um @lid, e devolve sincrono. Trocou a linha do `LidUtils.getPhoneNumberForLid`, que o
      // motor NAO TEM (zero ocorrencias no arquivo de producao) e era codigo morto.
      try {
        var LC = W && W.whatsapp && W.whatsapp.lidPnCache
        if (LC && LC.getPhoneNumber) push(LC.getPhoneNumber(wid))
      } catch (_) { /* ok */ }
      for (var i = 0; i < cands.length; i++) {
        var cp = partes(cands[i])
        if (cp.digits && !cp.isLid && cp.digits !== meu) return { digits: cp.digits, isLid: false }
        if (typeof cands[i] === 'string' && cands[i].indexOf('@lid') < 0) {
          var ds = String(cands[i]).replace(/\D/g, '')
          if (ds.length >= 12 && ds !== meu) return { digits: ds, isLid: false }
        }
      }
      // A VARREDURA FINAL, que e o que de fato resolve na pratica e faltava aqui: procura um campo
      // QUALQUER do objeto da mensagem que tenha <digitos>@c.us e nao seja o meu proprio numero.
      // Copiada do sc-panel.js, que e a versao que roda em producao ha meses - regra do Bruno de
      // 16/10: quando o sc-panel ja resolveu, o caminho e copiar, nao reinventar.
      try {
        var achado = ''
        Object.keys(msg).forEach(function (k) {
          try {
            var v = msg[k]
            var txt = (v && (v._serialized || (v.id && v.id._serialized))) || (typeof v === 'string' ? v : '')
            var dg = String(txt).match(/(\d{10,15})@c\.us/)
            if (dg && dg[1] !== meu && !achado) achado = dg[1]
          } catch (_) { /* campo estranho: segue */ }
        })
        if (achado) return { digits: achado, isLid: false }
      } catch (_) { /* ok */ }
      return { digits: p.digits, isLid: true }   // não resolveu: marca lid e o worker decide
    } catch (_) { return { digits: '', isLid: false } }
  }

  // Quanto a cifrada espera pela versao legivel, em milissegundos.
  //
  // O NUMERO E CONSERVADOR E ESTA SENDO MEDIDO: toda vez que a legivel chega, o agente guarda o
  // tempo real em `window.__swCifraMs` (e o maior ja visto em `__swCifraMsMax`). Quem for ajustar
  // isto olha esses dois na maquina do vendedor em vez de chutar de novo. Esperar demais so atrasa
  // a bolha no inbox; esperar de menos manda o lead sem o codigo, que e o defeito que isto conserta.
  var ESPERA_CIFRA = 6000
  var segurados = {}
  window.__swCifraMs = 0
  window.__swCifraMsMax = 0
  window.__swCifraSoltas = 0
  // QUANTO CADA MENSAGEM ESPEROU, por id. Vai DENTRO do evento (campo `cifraMs`), e nao so numa
  // variavel do console: assim o numero chega junto com a mensagem que ele mediu, sem ninguem
  // precisar abrir o DevTools na maquina do vendedor pra ler. E e o numero que decide se a espera
  // de 6s esta certa, curta ou desperdicio.
  var esperou = {}

  function capturar(msg, solta) {
    try {
      if (!msg) return
      var deMim = !!(msg.fromMe || (msg.id && msg.id.fromMe))
      var p = partes(deMim ? msg.to : msg.from)
      if (!p.ser || !ehPessoa(p.ser)) return                  // grupo, status, newsletter: não é lead
      var pr = telefoneReal(msg, deMim)
      if (!pr.digits) return
      if (pr.digits === numeroDoAparelho()) return            // conversa comigo mesmo
      var ts = Number(msg.t || msg.timestamp || 0)
      var id = (msg.id && (msg.id.id || (msg.id._serialized ? String(msg.id._serialized).split('_').pop() : ''))) || ''
      if (!id) id = 'sw_' + (ts || Date.now()) + '_' + pr.digits + '_' + deMim

      // A CIFRADA ESPERA A LEGIVEL (ver o bloco acima). `solta` e a propria espera estourando.
      var tipoCru = String(msg.type || 'chat').toLowerCase()
      if (tipoCru === 'ciphertext' && !solta) {
        if (!segurados[id] && !vistas[id]) {
          segurados[id] = {
            msg: msg,
            em: Date.now(),
            t: setTimeout(function () {
              var g = segurados[id]
              delete segurados[id]
              if (!g || vistas[id]) return
              window.__swCifraSoltas++
              capturar(g.msg, true)       // a legivel nao veio: manda a cifrada mesmo
            }, ESPERA_CIFRA),
          }
        }
        return
      }
      // A LEGIVEL CHEGOU: cancela a espera da cifrada de mesmo id e guarda quanto tempo levou.
      if (segurados[id]) {
        var gasto = Date.now() - segurados[id].em
        window.__swCifraMs = gasto
        esperou[id] = gasto
        if (gasto > window.__swCifraMsMax) window.__swCifraMsMax = gasto
        try { clearTimeout(segurados[id].t) } catch (_) { /* ok */ }
        delete segurados[id]
      }

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
      // `antiga` e so pro download. Nao confundir com `velha`, que e a marca de 30 minutos que o
      // servidor usa pra nao reescrever atribuicao nem criar venda.
      var antiga = ts && (Date.now() / 1000 - ts) > 21600 ? 1 : 0
      var ev = {
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
        // QUANTO ESTA MENSAGEM ESPEROU pela versao legivel (0 = nao foi segurada), e quantas
        // cifradas ja sairam sem a legivel chegar. Viaja no evento de proposito: e o jeito de medir
        // a espera na maquina do vendedor sem pedir pra ele abrir o console.
        cifraMs: esperou[id] || 0,
        cifraSoltas: window.__swCifraSoltas || 0,
      }
      delete esperou[id]
      // ÁUDIO E FOTO DO LEAD VÃO COM OS BYTES.
      //
      // Nesta operação o cliente manda o endereço de entrega POR ÁUDIO: sem os bytes, a bolha no
      // inbox vira um rótulo vazio e o vendedor tem que abrir o WhatsApp pra ouvir. Quem baixa é o
      // próprio WhatsApp (WPP.chat.downloadMedia faz a decifragem), então a CSP não entra nisso.
      //
      // Limites copiados do painel que já roda em produção: só o leve (áudio, foto, figurinha),
      // teto de 5 MB (base64 pesa no lote) e prazo de 20s. Vídeo e documento NÃO baixam.
      // E o evento vai mesmo que o download falhe: nunca perder a mensagem por causa do anexo.
      // A MENSAGEM VAI NA HORA. O ANEXO VAI DEPOIS, NUMA SEGUNDA PASSADA.
      //
      // Antes o `manda` morava DENTRO do .then do download: entre marcar a mensagem como vista e o
      // anexo chegar passavam ate 20 segundos, e nesse intervalo o evento nao existia em lugar
      // nenhum duravel. Se a pagina recarregasse ali no meio (o proprio painel tem Recarregar, o
      // WhatsApp Web se atualiza sozinho, a hibernacao fecha a view no setimo numero), o audio do
      // ENDERECO sumia inteiro: nao virava bolha, nao virava lead. Agora vai duas vezes, e a
      // ingestao aguenta: o INSERT em wa_messages e OR IGNORE por msg_id e logo abaixo existe um
      // UPDATE ... SET media_url justamente pro anexo que chega atrasado.
      //
      // E NAO BAIXA HISTORICO. Ao reconectar, o WhatsApp reemite a conversa (ja foi medido aqui:
      // 855 mensagens em 11 minutos num numero). Cada audio desses sairia pelo CDN do WhatsApp POR
      // DENTRO da pagina, ou seja pelo proxy pago daquela particao, que e cobrado por GB, pra virar
      // uma bolha que o vendedor ja tem na tela do lado. O corte e de SEIS HORAS e nao de 30
      // minutos de proposito: o notebook fechado por uma hora precisa trazer o audio do endereco
      // que chegou no meio (e essa a razao do `velha` existir e ir marcado em vez de descartado).
      if (/^(image|audio|sticker)$/i.test(tipo) && !deMim && !antiga) {
        manda(ev)
        baixaMidia(msg).then(function (m) {
          if (!m) return
          var comAnexo = {}
          for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) comAnexo[k] = ev[k]
          comAnexo.mediaB64 = m.b64
          comAnexo.mediaMime = m.mime
          manda(comAnexo)
        })
      } else manda(ev)
    } catch (_) { /* captura nunca pode derrubar a página do vendedor */ }
  }

  function manda(ev) {
    window.postMessage({ alvo: MARCA, canal: 'swp:captura', dados: { eventos: [ev] } }, '*')
  }

  function baixaMidia(msg) {
    return new Promise(function (ok) {
      try {
        var W = window.WPP
        if (!(W && W.chat && W.chat.downloadMedia)) return ok(null)
        var id = (msg && msg.id && (msg.id._serialized || msg.id)) || msg
        var pronto = false
        var prazo = setTimeout(function () { if (!pronto) { pronto = true; ok(null) } }, 20000)
        Promise.resolve(W.chat.downloadMedia(id)).then(function (blob) {
          if (pronto) return
          pronto = true
          clearTimeout(prazo)
          if (!blob || !blob.size || blob.size > 5 * 1024 * 1024) return ok(null)
          var mime = blob.type || (msg && msg.mimetype) || ''
          var fr = new FileReader()
          fr.onloadend = function () {
            try {
              var t = String(fr.result || '')
              var i = t.indexOf(',')
              var b64 = i >= 0 ? t.slice(i + 1) : ''
              ok(b64 ? { b64: b64, mime: mime } : null)
            } catch (_) { ok(null) }
          }
          fr.onerror = function () { ok(null) }
          fr.readAsDataURL(blob)
        }).catch(function () { if (!pronto) { pronto = true; clearTimeout(prazo); ok(null) } })
      } catch (_) { ok(null) }
    })
  }

  var ligado = null
  setInterval(function () {
    try {
      var W = window.WPP
      if (!W || !W.on || ligado === W) return
      try { if (W.off && ligado) W.off('chat.new_message', capturar) } catch (_) { /* ok */ }
      W.on('chat.new_message', capturar)
      // OS EVENTOS DE CONEXAO, no mesmo rearme. Eles so gravam em variavel local: NAO postam nada
      // no canal da pagina, entao a lista de canais do preload-wa continua com um canal so.
      // GRAVA O MOTIVO CRU, sempre. Ninguem aqui sabe ainda qual sinal um ban de verdade dispara
      // num aparelho vinculado, e inventar essa regra agora seria escolher entre alarme falso e
      // silencio justo na hora que importa. Com o cru guardado, o primeiro caso real calibra.
      try {
        W.on('conn.logout', function (r) { ultimaQueda = { modo: 'LOGOUT', motivo: String((r && (r.reason || r.code)) || ''), ts: Date.now() } })
        W.on('conn.require_auth', function () { ultimaQueda = { modo: 'REQUIRE_AUTH', motivo: '', ts: Date.now() } })
        W.on('conn.logout_reason', function (r) { ultimaQueda = { modo: 'LOGOUT_REASON', motivo: String(r == null ? '' : (r.reason || r.code || r)), ts: Date.now() } })
        W.on('conn.stream_mode_changed', function (m) {
          var mo = String((m && (m.mode || m)) || '')
          if (mo === 'TOS_BLOCK' || mo === 'SMB_TOS_BLOCK' || mo === 'QR' || mo === 'CONFLICT' || mo === 'PROXYBLOCK') {
            ultimaQueda = { modo: mo, motivo: '', ts: Date.now() }
          }
        })
      } catch (_) { /* motor sem esses eventos: o getStreamData ainda cobre o estado */ }
      ligado = W
      console.log('[sellwave] captura ligada')
    } catch (_) { /* ok */ }
  }, 2000)

  console.log('[sellwave] agente instalado')
})()
