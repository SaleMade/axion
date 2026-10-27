// A VARREDURA TEM QUE PEGAR A CONVERSA QUE O VENDEDOR ESTA ATENDENDO (26/10/2026).
//
// O Guilherme: "irmao ta marcando errado, chegou mais de 4". O numero dele mostrava 4/30 com mais
// leads ja na conversa. MEDIDO nos leads do dia, atraso entre a mensagem chegar e o lead aparecer:
//     66632248 ... mediana  13 s   (lead chega e fica NAO LIDO: a varredura pega)
//     92373996 ... mediana 126 s   (o numero DELE, que ele estava atendendo)
//     97405847 ... mediana 227 s
//
// A causa: a varredura pedia `onlyWithUnreadMessage: true`. Conversa que o vendedor abre e le na
// hora NUNCA entra nessa lista, entao pra ela sobrava so a colheita de 2 minutos. Quem estava sendo
// atendido era justamente quem demorava a ser contado.
//
// Recorta a `varreNaoLidas` do proprio `ui/agente.js` e roda com um WPP de mentira.
//   node src/teste-varredura.js
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const fonte = fs.readFileSync(path.join(__dirname, 'ui', 'agente.js'), 'utf8').replace(/\r\n/g, '\n')

function funcao(nome) {
  const i = fonte.indexOf('function ' + nome + '(')
  if (i < 0) return null
  let nivel = 0, viu = false
  for (let k = i; k < fonte.length; k++) {
    const c = fonte[k], n = fonte[k + 1]
    if (c === '/' && n === '/') { k = fonte.indexOf('\n', k); continue }
    if (c === '/' && n === '*') { k = fonte.indexOf('*/', k) + 1; continue }
    if (c === "'" || c === '"' || c === '`') { for (k++; k < fonte.length && fonte[k] !== c; k++) if (fonte[k] === '\\') k++; continue }
    if (c === '{') { nivel++; viu = true }
    else if (c === '}') { nivel--; if (viu && nivel === 0) return fonte.slice(i, k + 1) }
  }
  return null
}

let ok = 0
const falhas = []
const conta = (nome, certo, det) => {
  if (certo) { ok++; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (det ? '   -> ' + det : '')) }
}

const corpo = funcao('varreNaoLidas')
conta('o agente tem a varredura', !!corpo)
if (!corpo) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1) }

// O WhatsApp de mentira: duas conversas. Uma NAO LIDA (o lead que ninguem abriu ainda) e uma JA
// LIDA e recente (o lead que o vendedor esta atendendo agora). Antes do conserto, so a primeira
// chegava na varredura.
function roda({ comRecentes, vistas, cifradasSoltas, tipoAtendendo, idadeAtendendo }) {
  const agoraS = Math.floor(Date.now() / 1000)
  const msgs = {
    'naolida@c.us': [{ id: { id: 'MSG_NAOLIDA' }, t: agoraS - 30, type: 'chat', body: 'oi, quero saber' }],
    'atendendo@c.us': [{ id: { id: 'MSG_ATENDENDO' }, t: agoraS - (Number(idadeAtendendo) || 30), type: tipoAtendendo || 'chat', body: 'me explica melhor' }],
  }
  const naoLida = { id: { _serialized: 'naolida@c.us' }, isGroup: false, unreadCount: 1 }
  const atendendo = { id: { _serialized: 'atendendo@c.us' }, isGroup: false, unreadCount: 0 }
  const pedidos = []
  const capturadas = []
  const ctx = {
    Promise, setTimeout, clearTimeout, Number, Math, Array, String, Date, Boolean,
    vistas: vistas || {}, segurados: {}, cifradasSoltas: cifradasSoltas || {},
    NAO_E_MSG: /^(e2e_notification|notification_template|notification|gp2|protocol|revoked|call_log|ciphertext|broadcast_notification)$/i,
    autenticado: () => true,
    capturar: (m) => capturadas.push(m.id.id),
    window: {
      WPP: {
        chat: {
          list: (o) => {
            pedidos.push(JSON.stringify(o || {}))
            if (o && o.onlyWithUnreadMessage) return Promise.resolve([naoLida])
            // o WPP sem `onlyWithUnreadMessage` devolve as mais recentes
            return Promise.resolve(comRecentes ? [atendendo, naoLida] : [])
          },
          getMessages: (id) => Promise.resolve(msgs[id] || []),
        },
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(corpo + '\nvarreNaoLidas()', ctx)
  return { pedidos, capturadas, ctx }
}

;(async () => {
  const r = roda({ comRecentes: true })
  await new Promise((ok2) => setTimeout(ok2, 60))

  conta('a varredura pede as conversas RECENTES, alem das nao lidas',
    r.pedidos.some((p) => p.indexOf('onlyWithUnreadMessage') >= 0) && r.pedidos.some((p) => p.indexOf('count') >= 0),
    JSON.stringify(r.pedidos))

  conta('pega a mensagem do lead que ninguem abriu (isso ja funcionava)',
    r.capturadas.includes('MSG_NAOLIDA'), JSON.stringify(r.capturadas))

  conta('E pega a da conversa que o vendedor esta ATENDENDO, que era a que ficava pra tras',
    r.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r.capturadas))

  conta('nao manda a mesma conversa duas vezes quando ela esta nas duas listas',
    r.capturadas.filter((x) => x === 'MSG_NAOLIDA').length === 1, JSON.stringify(r.capturadas))

  conta('o contador da tela continua contando so as NAO LIDAS',
    r.ctx.window.__swNaoLidas === 1, String(r.ctx.window.__swNaoLidas))

  // Motor velho que nao entende a segunda lista nao pode quebrar a primeira.
  const r2 = roda({ comRecentes: false })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('motor que nao devolve as recentes continua capturando as nao lidas',
    r2.capturadas.includes('MSG_NAOLIDA'), JSON.stringify(r2.capturadas))

  // ── A CIFRADA QUE VIRA LEGIVEL (27/10/2026) ───────────────────────────────────────────────────
  // Quando o WhatsApp Web nao consegue decifrar, ele mostra "Aguardando mensagem. Abra o WhatsApp
  // no seu celular" e o agente, depois de esperar, manda a cifrada mesmo pra nao perder o lead.
  // O aparelho reenvia a legivel depois, com O MESMO id - e a varredura, que rele a conversa de 20
  // em 20 s, e quem costuma achar ela primeiro. Com o id ja em `vistas` ela era descartada e a
  // conversa ficava vazia na dash pra sempre.
  const r3 = roda({ comRecentes: true, vistas: { MSG_ATENDENDO: 1 }, cifradasSoltas: { MSG_ATENDENDO: 1 } })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('a varredura traz de volta a legivel do id que saiu CIFRADO',
    r3.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r3.capturadas))

  // E SO ESSA EXCECAO: id ja visto que nao saiu cifrado continua fora, senao a varredura mandaria
  // a conversa inteira de novo a cada 20 s.
  const r4 = roda({ comRecentes: true, vistas: { MSG_ATENDENDO: 1 }, cifradasSoltas: {} })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('id ja visto que NAO saiu cifrado continua sendo pulado',
    !r4.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r4.capturadas))

  // E se a conversa continua cifrada na releitura, nao ha o que trazer: mandar a mesma cifrada de
  // novo so repetiria o balao vazio.
  const r5 = roda({ comRecentes: true, vistas: { MSG_ATENDENDO: 1 }, cifradasSoltas: { MSG_ATENDENDO: 1 }, tipoAtendendo: 'ciphertext' })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('e continuando cifrada na releitura, nao manda de novo',
    !r5.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r5.capturadas))

  // O CORTE DE 30 MIN NAO VALE PRA ELA. A legivel chega com a hora ORIGINAL (a de quando o lead
  // escreveu) e o aparelho pode demorar: no print de 27/10 as conversas ficaram em "Aguardando
  // mensagem" das 09:41 ate depois das 10:19. Pelo corte de sempre, a legivel chegaria e seria
  // jogada fora de novo, bem no caso que isto existe pra consertar.
  const r6 = roda({ comRecentes: true, vistas: { MSG_ATENDENDO: 1 }, cifradasSoltas: { MSG_ATENDENDO: 1 }, idadeAtendendo: 3600 })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('a legivel de uma cifrada solta passa mesmo com mais de 30 min',
    r6.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r6.capturadas))

  // E SO PRA ELA: mensagem velha qualquer continua barrada, senao um numero reconectando despeja a
  // conversa inteira na dash como se fosse lead de hoje.
  const r7 = roda({ comRecentes: true, idadeAtendendo: 3600 })
  await new Promise((ok2) => setTimeout(ok2, 60))
  conta('mensagem velha que nao saiu cifrada continua barrada pelo corte de 30 min',
    !r7.capturadas.includes('MSG_ATENDENDO'), JSON.stringify(r7.capturadas))

  console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
  process.exit(falhas.length ? 1 : 0)
})()
