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
function roda({ comRecentes }) {
  const agoraS = Math.floor(Date.now() / 1000)
  const msgs = {
    'naolida@c.us': [{ id: { id: 'MSG_NAOLIDA' }, t: agoraS - 30, type: 'chat', body: 'oi, quero saber' }],
    'atendendo@c.us': [{ id: { id: 'MSG_ATENDENDO' }, t: agoraS - 30, type: 'chat', body: 'me explica melhor' }],
  }
  const naoLida = { id: { _serialized: 'naolida@c.us' }, isGroup: false, unreadCount: 1 }
  const atendendo = { id: { _serialized: 'atendendo@c.us' }, isGroup: false, unreadCount: 0 }
  const pedidos = []
  const capturadas = []
  const ctx = {
    Promise, setTimeout, clearTimeout, Number, Math, Array, String, Date, Boolean,
    vistas: {}, segurados: {},
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

  console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
  process.exit(falhas.length ? 1 : 0)
})()
