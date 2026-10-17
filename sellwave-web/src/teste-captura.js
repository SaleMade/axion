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
    chat: { get: function () { return null } },
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

  try { j.destroy() } catch (_) { /* ok */ }
  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  app.exit(ruim ? 1 : 0)
}

app.whenReady().then(() => {
  rodar().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) })
})
