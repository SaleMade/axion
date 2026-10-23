// TESTE DA CAPTURA DE LEAD: o agente de verdade, numa pagina de verdade, sem WhatsApp nenhum.
//
// POR QUE ELE EXISTE (17/10/2026). Medido pela sessao f5 contra a producao: o app NUNCA capturou
// um lead. Zero `wa_lead`, zero `tt_events`. Em 16/10, das 10h54 as 11h46, o numero ..0653 levou
// 141 visitas e 111 cliques com ttclid e produziu ZERO lead. Dois furos no `agente.js` explicavam:
//
//  1. A MENSAGEM CIFRADA. O motor entrega a primeira mensagem como `ciphertext` e REEMITE a mesma,
//     legivel, com o MESMO id. A deduplicacao jogava a segunda fora - e a segunda e justamente a
//     que tem o "Codigo de desconto", que e o que amarra o lead ao clique pago. Sem o codigo, o
//     lead cai no FIFO e pode levar o ttclid de outra pessoa.
//  2. O LID. Conversa endereçada por @lid nao resolvia pro telefone real, e o worker descarta o
//     evento inteiro quando vem `lid: 1`.
//
// COMO ELE TESTA: carrega o `agente.js` DE VERDADE numa pagina, com um WPP de mentira no lugar do
// WhatsApp, e escuta o `window.postMessage` que o agente usa pra mandar evento. Ou seja exercita o
// arquivo que vai pro R2, nao uma copia da logica. O que e dublado e o WhatsApp, que nao cabe num
// teste; o que esta sendo medido e o agente.
//
// Uso:  MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-captura.js
// (ou `npm run teste-captura`)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let ok = 0, ruim = 0
function conta(nome, bom, detalhe) {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

// O WhatsApp de mentira: so o que o agente encosta. Um emissor de evento e as lojas que ele le.
const WPP_FALSO = `
  window.__enviados = []
  window.addEventListener('message', function (e) {
    var d = e && e.data
    if (d && d.canal === 'swp:captura') window.__enviados.push(d.dados.eventos[0])
  })
  var ouvintes = {}
  window.WPP = {
    on: function (ev, fn) { (ouvintes[ev] = ouvintes[ev] || []).push(fn) },
    off: function (ev, fn) { ouvintes[ev] = (ouvintes[ev] || []).filter(function (f) { return f !== fn }) },
    conn: { isAuthenticated: function () { return true } },
    whatsapp: {
      ContactStore: { get: function () { return null } },
      // o cache de lid do motor existe mas nao conhece este wid: forca o teste a chegar na
      // varredura final, que e a peca que faltava no agente
      lidPnCache: { getPhoneNumber: function () { return null } },
      UserPrefs: { getMaybeMeUser: function () { return { user: '5515974060653', _serialized: '5515974060653@c.us' } } },
    },
    // A VARREDURA DAS NAO LIDAS (20/10/2026) le daqui: o teste poe conversas e mensagens que o evento
    // NUNCA disparou, que e o caso do numero aberto em segundo plano.
    chat: {
      get: function () { return null },
      list: async function (o) { return (window.__naoLidas || []).map(function (c) { return { id: { _serialized: c.id }, isGroup: !!c.grupo, unreadCount: c.msgs.length } }) },
      getMessages: async function (id) { var c = (window.__naoLidas || []).find(function (x) { return x.id === id }); return c ? c.msgs : [] },
    },
    contact: { get: async function () { return null } },
  }
  window.__dispara = function (msg) { (ouvintes['chat.new_message'] || []).forEach(function (f) { f(msg) }) }
  'ok'
`

const msgBase = (extra) => Object.assign({
  id: { id: 'MSG1', _serialized: 'false_5511999998888@c.us_MSG1', fromMe: false },
  from: '5511999998888@c.us',
  to: '5515974060653@c.us',
  t: Math.floor(Date.now() / 1000),
  type: 'chat',
  body: 'oi',
}, extra || {})

async function rodar() {
  const j = new BrowserWindow({ show: false, width: 500, height: 400, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  await j.loadURL('data:text/html,<meta charset="utf-8"><body>captura</body>')
  const js = (c) => j.webContents.executeJavaScript(c, true)

  await js(WPP_FALSO)
  await js('window.__swVarreduraMs = 700; "ok"')   // a varredura de verdade e de 20 s; aqui, rapida
  await js(fs.readFileSync(path.join(__dirname, 'ui', 'agente.js'), 'utf8'))
  await espera(2500)   // o agente liga a captura num intervalo de 2s
  conta('o agente liga a captura sozinho', (await js('typeof window.__swVistasN')) === 'number')

  console.log('\nA MENSAGEM CIFRADA')
  // 1) so a cifrada: ela NAO pode sair na hora, senao o lead vai sem o codigo.
  await js('window.__enviados = []; window.__dispara(' + JSON.stringify(msgBase({ type: 'ciphertext', body: '' })) + '); "ok"')
  await espera(400)
  conta('a cifrada NAO e mandada na hora: ela espera a legivel',
    (await js('window.__enviados.length')) === 0, 'enviados=' + (await js('window.__enviados.length')))

  // 2) a legivel chega com o MESMO id: e ela que sai, uma vez so, com o corpo certo.
  await js('window.__dispara(' + JSON.stringify(msgBase({ type: 'chat', body: 'Oi, Código de desconto GLICO10' })) + '); "ok"')
  await espera(500)
  const dep = JSON.parse(await js('JSON.stringify(window.__enviados)'))
  conta('a legivel chega e e ELA que sai, uma vez so', dep.length === 1, 'enviados=' + dep.length)
  // ESTE E O PONTO DO CONSERTO INTEIRO: o codigo de desconto e o que amarra o lead ao clique pago.
  conta('e ela leva o "Código de desconto", que a deduplicacao jogava fora',
    dep.length === 1 && /Código de desconto/.test(String(dep[0].body || '')), dep.length ? String(dep[0].body) : '(nada)')
  conta('e o tempo de espera foi medido, nao chutado',
    (await js('window.__swCifraMs')) > 0, 'ms=' + (await js('window.__swCifraMs')))
  // E O TEMPO VIAJA NO PROPRIO EVENTO. Sem isso, medir a espera na maquina do vendedor exigiria
  // pedir pra ele abrir o DevTools da view do numero - que e o tipo de pedido que nao acontece.
  conta('e o tempo viaja DENTRO do evento, pra dar pra medir sem abrir o console',
    dep.length === 1 && Number(dep[0].cifraMs) > 0, dep.length ? 'cifraMs=' + dep[0].cifraMs : '(nada)')

  // 3) a legivel NUNCA vem: a cifrada sai mesmo assim. Cair no FIFO e ruim; perder e pior.
  await js('window.__enviados = []; window.__dispara(' + JSON.stringify(msgBase({
    id: { id: 'MSG2', _serialized: 'false_5511999998888@c.us_MSG2', fromMe: false }, type: 'ciphertext', body: '',
  })) + '); "ok"')
  await espera(1000)
  conta('cifrada sozinha continua segurada enquanto a espera corre',
    (await js('window.__enviados.length')) === 0)
  await espera(6500)
  const soltas = JSON.parse(await js('JSON.stringify(window.__enviados)'))
  conta('e sai sozinha quando a legivel nao vem: perder a mensagem seria pior',
    soltas.length === 1 && (await js('window.__swCifraSoltas')) >= 1, 'enviados=' + soltas.length)

  console.log('\nO TELEFONE POR TRAS DO LID')
  // Conversa por @lid: o identificador NAO e telefone. Sem resolver, o evento sai com lid:1 e o
  // worker PULA TUDO - a mensagem nao vira lead, nao vira bolha e nao casa com o pedido.
  await js('window.__enviados = []; window.__dispara(' + JSON.stringify(msgBase({
    id: { id: 'MSG3', _serialized: 'false_111222333444555@lid_MSG3', fromMe: false },
    from: '111222333444555@lid',
    body: 'Código de desconto GLICO10',
    // o telefone de verdade aparece num campo qualquer do objeto, que e como ele aparece na vida
    // real: e exatamente a varredura que o sc-panel faz em producao e que faltava aqui
    senderObj: { id: { _serialized: '5511977776666@c.us' } },
  })) + '); "ok"')
  await espera(500)
  const lid = JSON.parse(await js('JSON.stringify(window.__enviados)'))
  conta('conversa por LID resolve pro telefone de verdade',
    lid.length === 1 && lid[0].phone === '5511977776666', JSON.stringify(lid.map((x) => x.phone)))
  conta('e NAO sai marcada como lid, que e o que fazia o worker descartar',
    lid.length === 1 && !lid[0].lid, lid.length ? 'lid=' + lid[0].lid : '(nada)')

  // E O MEU PROPRIO NUMERO NUNCA PODE SER O LEAD: a varredura precisa pular o aparelho.
  await js('window.__enviados = []; window.__dispara(' + JSON.stringify(msgBase({
    id: { id: 'MSG4', _serialized: 'false_999888777666555@lid_MSG4', fromMe: false },
    from: '999888777666555@lid',
    body: 'oi',
    senderObj: { id: { _serialized: '5515974060653@c.us' } },   // sou eu
  })) + '); "ok"')
  await espera(400)
  const eu = JSON.parse(await js('JSON.stringify(window.__enviados)'))
  conta('o proprio numero do aparelho nunca vira o telefone do lead',
    eu.every((x) => x.phone !== '5515974060653'), JSON.stringify(eu.map((x) => x.phone)))

  console.log('\nA VARREDURA DAS NAO LIDAS (numero em segundo plano)')
  const agoraS = Math.floor(Date.now() / 1000)
  const m = (id, extra) => msgBase(Object.assign({ id: { id: id, _serialized: 'false_5511955554444@c.us_' + id, fromMe: false }, from: '5511955554444@c.us' }, extra || {}))
  await js('window.__enviados = []; window.__naoLidas = ' + JSON.stringify([
    { id: '5511955554444@c.us', msgs: [m('V1', { body: 'Olá! Código de desconto "ABC123"!', t: agoraS - 60 }), m('V2', { body: 'mensagem de ontem', t: agoraS - 86400 })] },
    { id: '120363000000000000@g.us', grupo: true, msgs: [m('V3', { body: 'grupo', from: '120363000000000000@g.us' })] },
  ]) + '; "ok"')
  await espera(1600)
  const vr = JSON.parse(await js('JSON.stringify(window.__enviados)'))
  conta('mensagem que o evento nao trouxe sai pela varredura, com o codigo',
    vr.length === 1 && /ABC123/.test(String(vr[0].body)) && vr[0].via === 'varredura', JSON.stringify(vr.map((x) => [x.msgId, x.via])))
  conta('a de ontem e a do grupo ficam de fora', vr.every((x) => x.msgId !== 'V2' && x.msgId !== 'V3'))
  await espera(1600)
  conta('e a varredura seguinte nao manda a mesma de novo', (await js('window.__enviados.length')) === 1, 'enviados=' + (await js('window.__enviados.length')))
  await js('window.__dispara(' + JSON.stringify(m('V1', { body: 'Olá! Código de desconto "ABC123"!', t: agoraS - 60 })) + '); "ok"')
  await espera(300)
  conta('nem o evento atrasado da mesma mensagem', (await js('window.__enviados.length')) === 1)
  conta('o estado conta as conversas nao lidas (fora grupo) pra lista do app', (await js('window.__swEstado().naoLidas')) === 1, String(await js('window.__swEstado().naoLidas')))

  console.log('\nA COLHEITA (o app pergunta a pagina, 23/10/2026)')
  // A conversa do lead JA LIDA (a varredura das nao lidas nao ve) e uma enviada por mim: e o caso da
  // Barbara, que lia tudo e nada chegava na dash.
  const c = (id, extra) => msgBase(Object.assign({ id: { id: id, _serialized: 'false_5511933332222@c.us_' + id, fromMe: false }, from: '5511933332222@c.us' }, extra || {}))
  await js('window.__enviados = []; window.__naoLidas = ' + JSON.stringify([
    { id: '5511933332222@c.us', t: agoraS - 120, msgs: [
      c('C1', { body: 'Olá! Gostaria de saber mais. Código de desconto "XYZ789"', t: agoraS - 600 }),
      c('C2', { id: { id: 'C2', _serialized: 'true_5511933332222@c.us_C2', fromMe: true }, fromMe: true, from: '5515974060653@c.us', to: '5511933332222@c.us', body: 'Oi! Tudo bem?', t: agoraS - 500 }),
      c('C3', { type: 'e2e_notification', body: '', t: agoraS - 700 }),
      c('C4', { type: 'ciphertext', body: '', t: agoraS - 400 }),
      c('C5', { body: 'de dois dias atras', t: agoraS - 2 * 86400 }),
    ] },
    { id: '5511922221111@c.us', t: agoraS - 3 * 86400, msgs: [c('D1', { from: '5511922221111@c.us', body: 'conversa parada', t: agoraS - 3 * 86400 })] },
    { id: '120363000000000001@g.us', grupo: true, t: agoraS - 60, msgs: [c('G1', { from: '120363000000000001@g.us', body: 'grupo' })] },
  ]).replace(/"grupo":true/g, '"grupo":true,"isGroup":true') + '; window.__naoLidas.forEach(function (x) { x.t = x.t }); "ok"')
  // o duble da lista nao passa o `t` adiante; a colheita precisa dele (e o que o WhatsApp de verdade tem)
  await js('(() => { const l0 = window.WPP.chat.list; window.WPP.chat.list = async function (o) { const r = await l0(o); r.forEach(function (x, i) { x.t = (window.__naoLidas[i] || {}).t; x.isGroup = !!(window.__naoLidas[i] || {}).grupo }); return r }; return "ok" })()')
  const rec = JSON.parse(await js('window.__swColheRecentes(' + (agoraS - 86400) + ', 80, 300).then(function (r) { return JSON.stringify(r) })'))
  const ids = rec.map((x) => x.msgId).sort().join(',')
  conta('a colheita traz a conversa JA LIDA e a mensagem que eu mandei', ids === 'C1,C2', ids)
  conta('com o codigo de desconto e o telefone do lead', rec.some((x) => x.msgId === 'C1' && /XYZ789/.test(x.body) && x.phone === '5511933332222' && x.fromMe === false), JSON.stringify(rec[0]))
  conta('a minha vai como "saiu de mim", pro telefone do lead', rec.some((x) => x.msgId === 'C2' && x.fromMe === true && x.phone === '5511933332222'), JSON.stringify(rec.find((x) => x.msgId === 'C2')))
  conta('aviso de criptografia, cifrada, mensagem antiga, conversa parada e grupo ficam de fora', !/C3|C4|C5|D1|G1/.test(ids), ids)
  conta('as colhidas vao marcadas, pra medir quanto a colheita salvou', rec.every((x) => x.via === 'colheita'))
  conta('a colheita NAO manda nada sozinha (quem decide e o main)', (await js('window.__enviados.length')) === 0, 'enviados=' + (await js('window.__enviados.length')))
  const um = JSON.parse(await js('window.__swColhe("5511933332222@c.us", 25).then(function (r) { return JSON.stringify(r) })'))
  conta('a colheita de UMA conversa (a do funil) traz o lead com o codigo', um.some((x) => x.msgId === 'C1' && x.via === 'colheita-funil') && !um.some((x) => x.msgId === 'C3'), JSON.stringify(um.map((x) => x.msgId)))
  // a V1 ja saiu pela varredura la em cima (esta em `vistas`): a colheita tem que trazer assim mesmo
  await js('window.__naoLidas.push({ id: "5511955554444@c.us", t: ' + (agoraS - 60) + ', msgs: [' + JSON.stringify(m('V1', { body: 'Olá! Código de desconto "ABC123"!', t: agoraS - 60 })) + '] }); "ok"')
  conta('e funciona mesmo com a mensagem ja marcada como vista pelo evento',
    JSON.parse(await js('window.__swColhe("5511955554444@c.us", 25).then(function (r) { return JSON.stringify(r.map(function (x) { return x.msgId })) })')).includes('V1'))

  console.log('\nA COLHEITA DE PONTA A PONTA (o main de verdade perguntando a pagina de verdade)')
  // As funcoes do main.js recortadas do arquivo, rodando AQUI, no processo principal do Electron, e
  // perguntando a esta pagina pelo executeJavaScript - o mesmo caminho do app. So o servidor e falso.
  {
    const fonte = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
    const recorta = (assin) => {
      const i = fonte.indexOf(assin); if (i < 0) throw new Error('nao achei ' + assin)
      let n = 0
      for (let k = fonte.indexOf('{', i); k < fonte.length; k++) { if (fonte[k] === '{') n++; else if (fonte[k] === '}') { n--; if (!n) return fonte.slice(i, k + 1) } }
      throw new Error('nao fechou ' + assin)
    }
    const linha = (ini) => fonte.split('\n').find((l) => l.startsWith(ini))
    const posts = []
    const ambiente = {
      abertos: new Map([['1574060653', { view: { webContents: j.webContents }, connUltimo: 'pronto' }]]),
      filaCaptura: [], entregues: new Map([['C2', Date.now()]]), ultimaColheita: new Map(), saude: { colhidas: 0, colheuEm: 0 },
      config: { token: 't', apiBase: 'https://api' }, anota: () => {}, ajustaRelogio: () => {}, ehVelha: () => 0,
      espera: (ms) => new Promise((r) => setTimeout(r, ms)), agoraCerto: () => Date.now(),
      fetch: async (url, o) => { const evs = JSON.parse(o.body).events; posts.push(evs); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ack: evs.map((e) => e.msgId) }) } },
    }
    const nomes = Object.keys(ambiente)
    const F = new Function(...nomes, 'let entreguesSujo = false, filaSuja = false, jaTinhaRegistro = true, comoId = "";\n'
      + [linha('const perguntaPagina = (wc, codigo, teto) =>') ? fonte.slice(fonte.indexOf('const perguntaPagina = (wc, codigo, teto) =>'), fonte.indexOf('let colhendo = false')) : '',
        'let colhendo = false', recorta('function marcaEntregues(ids)'), recorta('function faltamNaDash(evs, agora)'),
        recorta('function janelaDaColheita(nk, agoraS)'), recorta('async function mandaColheita(evs)'), recorta('async function colheTodos()'),
        'const colheuConversa = new Map()', recorta('async function colheConversa(nk, chatId)')].join('\n')
      + '\nreturn { colheTodos, colheConversa }')(...nomes.map((n) => ambiente[n]))
    await F.colheTodos()
    const foi = posts.flat().map((e) => e.msgId).sort()
    conta('o main pergunta a pagina e manda pra dash o que faltava (conversa ja lida)', foi.includes('C1') && /XYZ789/.test((posts.flat().find((e) => e.msgId === 'C1') || {}).body || ''), JSON.stringify(foi))
    conta('e NAO manda de novo o que o servidor ja tinha confirmado', !foi.includes('C2'), JSON.stringify(foi))
    conta('a janela da proxima colheita anda', ambiente.ultimaColheita.get('1574060653') > 0)
    posts.length = 0
    await F.colheTodos()
    conta('a colheita seguinte nao manda nada que ja foi', posts.length === 0, JSON.stringify(posts))
    ambiente.entregues.clear(); posts.length = 0
    await F.colheConversa('1574060653', '5511933332222@c.us')
    conta('o disparo do funil manda a conversa daquele lead', posts.flat().some((e) => e.msgId === 'C1' && e.via === 'colheita-funil'), JSON.stringify(posts.flat().map((e) => e.msgId)))
    posts.length = 0
    await F.colheConversa('1574060653', '5511933332222@c.us')
    conta('e o mesmo lead nao e colhido de novo em 15 min', posts.length === 0)
    // pagina sem o agente novo: a colheita nao quebra e nao anda a janela
    ambiente.abertos.set('9999', { view: { webContents: { isDestroyed: () => false, executeJavaScript: async () => null } }, connUltimo: 'pronto' })
    await F.colheTodos()
    conta('pagina com o agente antigo (sem colheita): nada quebra e a janela nao anda', !ambiente.ultimaColheita.has('9999'))
  }

  try { j.destroy() } catch (_) { /* ok */ }
  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  app.exit(ruim ? 1 : 0)
}

app.whenReady().then(() => {
  rodar().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) })
})
