// A VARREDURA DA PAYLOG SO REGRAVA QUEM MUDOU DE VERDADE (06/11/2026).
//
// O caso: 168 pedidos que a PayLog marcou PL_ROUBADO depois de entregues. A trava de entregue mantem
// DELIVERED no five_orders, entao o "mudou" (que comparava so com a coluna) dava sim em TODA varredura,
// e cada um regravava o estado inteiro: ~2 minutos de gravacao seguida de meia em meia hora, e o
// Cadastrar do vendedor perdia as 6 tentativas ("nao foi enviado: conflict").
//
// Este teste recorta do worker.js a CONSULTA e a REGRA de verdade e roda num SQLite em memoria:
// o pedido que a esteira ja viu igual nao passa de novo; o que mudou de verdade passa.
//
//   node teste-varredura-paylog-mudou.mjs
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const ini = src.indexOf('async function _plReconciliar(')
const corpo = src.slice(ini, src.indexOf('\nasync function ', ini + 10))

let ok = 0, ruim = 0
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome) } else { ruim += 1; console.log('  RUIM ' + nome + (detalhe !== undefined ? '  ->  ' + detalhe : '')) }
}

// 1) A consulta: a expressao que monta o SQL, do jeito que esta no worker
const mSql = /const rr = await env\.DB\.prepare\(([\s\S]*?)\)\.bind\(\.\.\.ids\)\.all\(\);/.exec(corpo)
conta('achei a consulta no _plReconciliar', !!mSql)
const montaSql = new Function('ids', 'return ' + mSql[1])

// 2) A regra: _plDifere + o bloco que calcula o "mudou"
const mDif = /const _plDifere = [^\n]*\n/.exec(corpo)
const mReg = /(const shNovo = [\s\S]*?\|\| _plDifere\(cmNovo,[^\n]*\n)/.exec(corpo)
conta('achei a regra do mudou', !!mDif && !!mReg)
const mudouDe = new Function('q', 'atual', mDif[0] + mReg[1] + '\nreturn !!mudou;')

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE five_orders (order_id TEXT PRIMARY KEY, shipping_status TEXT, charge_status TEXT, shipping_code TEXT, charge_method TEXT, raw TEXT)')
const poe = (id, col, raw) => db.prepare('INSERT INTO five_orders VALUES (?,?,?,?,?,?)')
  .run(id, col.sh ?? null, col.ch ?? null, col.sc ?? null, col.cm ?? null, typeof raw === 'string' ? raw : JSON.stringify(raw))
// q no formato que o _plApiToFive monta
const qDe = (id, { sh, ch, sc, pm, metodo } = {}) => ({
  orderId: id,
  shipping: (sh || sc) ? { shippingStatus: sh || null, shippingCode: sc || null } : null,
  charge: ch ? { status: ch, paymentMethod: pm || null } : null,
  __plMetodo: metodo || null,
})

// O caso do dia: entregue no five_orders, a PayLog diz roubado, e a esteira ja viu isso
poe('PL-ROUBADO-VISTO', { sh: 'DELIVERED', ch: 'PENDING', sc: 'AB1', cm: 'pix' }, qDe('PL-ROUBADO-VISTO', { sh: 'PL_ROUBADO', ch: 'PENDING', sc: 'AB1', pm: 'pix' }))
// Primeira vez que a PayLog diz roubado (a esteira so viu entregue): tem que passar, pra mover o card
poe('PL-ROUBADO-NOVO', { sh: 'DELIVERED', ch: 'PENDING', sc: 'AB2', cm: 'pix' }, qDe('PL-ROUBADO-NOVO', { sh: 'DELIVERED', ch: 'PENDING', sc: 'AB2', pm: 'pix' }))
// Pago travado: a PayLog diz pendente de novo, a esteira ja viu
poe('PL-PAGO-TRAVADO', { sh: 'DELIVERED', ch: 'PAID', cm: 'pix' }, qDe('PL-PAGO-TRAVADO', { sh: 'DELIVERED', ch: 'PENDING', pm: 'pix' }))
// Pagou agora: estava pendente, a PayLog diz PAID
poe('PL-PAGOU', { sh: 'DELIVERED', ch: 'PENDING', cm: 'boleto' }, qDe('PL-PAGOU', { sh: 'DELIVERED', ch: 'PENDING', pm: 'boleto' }))
// Cancelado sem meio na cobranca: a coluna fica vazia (COALESCE), o meio vem do __plMetodo
poe('PL-CANC-MEIO', { sh: null, ch: 'CANCELED', cm: null }, qDe('PL-CANC-MEIO', { ch: 'CANCELED', metodo: 'pix' }))
// raw cortado em 40 mil caracteres (JSON quebrado): a consulta nao pode cair por causa dele
poe('PL-RAW-CORTADO', { sh: 'DELIVERED', ch: 'PENDING' }, '{"orderId":"PL-RAW-CORTADO","shipping":{"shippingStatus":"PL_ROU')
// Tudo igual
poe('PL-IGUAL', { sh: 'IN_TRANSIT', ch: 'PENDING', sc: 'AB9', cm: 'pix' }, qDe('PL-IGUAL', { sh: 'IN_TRANSIT', ch: 'PENDING', sc: 'AB9', pm: 'pix' }))
// Rastreio novo
poe('PL-RASTREIO', { sh: 'POSTED', ch: 'PENDING', sc: 'AB3' }, qDe('PL-RASTREIO', { sh: 'POSTED', ch: 'PENDING', sc: 'AB3' }))

const ids = ['PL-ROUBADO-VISTO', 'PL-ROUBADO-NOVO', 'PL-PAGO-TRAVADO', 'PL-PAGOU', 'PL-CANC-MEIO', 'PL-RAW-CORTADO', 'PL-IGUAL', 'PL-RASTREIO', 'PL-NAO-EXISTE']
let linhas = []
try { linhas = db.prepare(montaSql(ids)).all(...ids); conta('a consulta roda (com raw cortado no meio)', true) }
catch (e) { conta('a consulta roda (com raw cortado no meio)', false, e.message) }
const jaSabe = new Map(linhas.map((x) => [String(x.order_id), x]))
conta('o raw cortado volta sem o visto, sem derrubar nada', jaSabe.get('PL-RAW-CORTADO') && jaSabe.get('PL-RAW-CORTADO').raw_sh == null)
conta('o visto vem no formato da regra (maiuscula / minuscula)', jaSabe.get('PL-ROUBADO-VISTO').raw_sh === 'PL_ROUBADO' && jaSabe.get('PL-CANC-MEIO').raw_cm === 'pix', JSON.stringify(jaSabe.get('PL-ROUBADO-VISTO')))

const caso = (nome, id, q, esperado) => {
  const r = mudouDe(q, jaSabe.get(id))
  conta(nome, r === esperado, 'mudou=' + r)
}
caso('roubado que a esteira ja viu NAO regrava (o bug dos 168)', 'PL-ROUBADO-VISTO', qDe('PL-ROUBADO-VISTO', { sh: 'PL_ROUBADO', ch: 'PENDING', sc: 'AB1', pm: 'pix' }), false)
caso('roubado pela primeira vez passa (move o card)', 'PL-ROUBADO-NOVO', qDe('PL-ROUBADO-NOVO', { sh: 'PL_ROUBADO', ch: 'PENDING', sc: 'AB2', pm: 'pix' }), true)
caso('pago travado com a PayLog repetindo pendente NAO regrava', 'PL-PAGO-TRAVADO', qDe('PL-PAGO-TRAVADO', { sh: 'DELIVERED', ch: 'PENDING', pm: 'pix' }), false)
caso('pagou agora passa', 'PL-PAGOU', qDe('PL-PAGOU', { sh: 'DELIVERED', ch: 'PAID', pm: 'boleto' }), true)
caso('meio que so existe no __plMetodo NAO regrava toda vez', 'PL-CANC-MEIO', qDe('PL-CANC-MEIO', { ch: 'CANCELED', metodo: 'pix' }), false)
caso('meio novo passa', 'PL-CANC-MEIO', qDe('PL-CANC-MEIO', { ch: 'CANCELED', metodo: 'cartao' }), true)
caso('raw cortado: volta pro jeito de antes (compara so com a coluna)', 'PL-RAW-CORTADO', qDe('PL-RAW-CORTADO', { sh: 'PL_ROUBADO', ch: 'PENDING' }), true)
caso('tudo igual NAO regrava', 'PL-IGUAL', qDe('PL-IGUAL', { sh: 'IN_TRANSIT', ch: 'PENDING', sc: 'AB9', pm: 'pix' }), false)
caso('rastreio novo passa', 'PL-RASTREIO', qDe('PL-RASTREIO', { sh: 'POSTED', ch: 'PENDING', sc: 'XY7' }), true)
caso('status de envio novo passa', 'PL-IGUAL', qDe('PL-IGUAL', { sh: 'DELIVERED', ch: 'PENDING', sc: 'AB9', pm: 'pix' }), true)
caso('pedido que nao existe aqui passa (webhook perdido)', 'PL-NAO-EXISTE', qDe('PL-NAO-EXISTE', { sh: 'POSTED' }), true)
caso('sem nada novo da PayLog NAO regrava', 'PL-IGUAL', qDe('PL-IGUAL', {}), false)

console.log('\n  ' + ok + ' ok, ' + ruim + ' ruim')
process.exit(ruim ? 1 : 0)
