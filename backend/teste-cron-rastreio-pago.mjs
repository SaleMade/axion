// O CRON DE RASTREIO NAO TIRA PEDIDO PAGO DE PAGOS E ESCREVE HISTORICO EM TODA TROCA (05/11/2026,
// ver _cronRastreio no worker.js).
//
// O caso real: o 1792845282163 foi pago pelo link da Payt as 02:03 (card em Pago, hist 'Rota de Entrega
// -> Pago (payt)'); o proprio postback subiu o updated_at da five_orders e, na batida seguinte, o cron
// viu ship IN_TRANSIT_TO_DELIVERY e devolveu o card pra Rota de Entrega, sem uma linha de historico.
// Todo pedido COD pago pelo link antes do DELIVERED era desfeito em ate 5 minutos. A regra de 17/10 ("a
// decisao da equipe e a ultima palavra") vivia so no webhook; o cron nasceu antes dela.
//
// Roda o bundle REAL (wrangler deploy --dry-run) contra um D1 de mentira (node:sqlite), no passo 'agenda'
// do scheduled, DUAS batidas seguidas, e prova:
//  F1 pago em Pago + rastreio em rota: FICA em Pago, col_plat guarda o que a Five disse, UMA nota no hist;
//  F2 pago em Pagos + na agencia: fica, uma nota;   F3 pago + devolvido: fica em Pago (nao vai pra perda);
//  F4 pago + entregue: fica, hist intacto;   F5 nao pago anda pra Rota de Entrega COM hist (who 'five');
//  F7 pago + RETURNING_TO_ORIGIN: so o selo muda;   F8 spg Pago em Rota de Entrega + DELIVERED: vai pra
//  Pago com nota (antes ficava preso);   F9 Pagos ARQUIVADO: continua no arquivo, com a nota;
//  toda troca de coluna feita pelo cron tem hist (who 'five', time ISO);
//  2a batida (a Five reenviou tudo): NENHUMA nota duplica e o estado NAO e regravado.
// F6 (reenvio do mesmo status desfazendo um arrasto manual) NAO esta consertado aqui: so e mostrado.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cron-rastreio-pago.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
if (!bundle) { console.error('uso: node teste-cron-rastreio-pago.mjs <dir>/worker.js'); process.exit(2) }
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
const gravacoes = []   // updated_by de cada UPDATE do estado que pegou
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => {
      const r = sq.prepare(sql).run(...args)
      if (/UPDATE dashboard_state/.test(sql) && r.changes > 0) gravacoes.push(String(args[3]))
      return { meta: { changes: Number(r.changes) } }
    },
  }
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => { const out = []; for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run()); return out },
  exec: async (s) => sq.exec(s),
}
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const agora = Math.floor(Date.now() / 1000)
let seq = Date.now() - 3600e3
const lead = (extra) => ({ id: String(++seq), nome: 'Cliente ' + seq, at: 'vend_x', vl: 497, wa: '55159' + String(seq).slice(-8), hist: [], ...extra })
const histPago = () => [
  { from: 'Rota de Entrega', to: 'Rota de Entrega', who: 'payt', time: '31/10 02:03', note: 'Pago pelo link de pagamento (Payt, boleto)' },
  { from: 'Rota de Entrega', to: 'Pago', who: 'payt', time: '31/10 02:03', note: 'pago pelo link: o card vai pra Pago' },
]
const L = {
  // F1: o incidente. Depois da Payt o col_plat e 'Pago' (caminho PL- do postback), nao 'Rota de Entrega'.
  rota:      lead({ five_id: 'PL-F1', col: 'Pago',  spg: 'Pago', pago_ts: 1793423031000, ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Pago', hist: histPago() }),
  retirada:  lead({ five_id: 'F2', col: 'Pagos', spg: 'Pago', ship: 'READY_FOR_PICKUP', col_plat: 'Retirada', hist: histPago() }),
  devolvido: lead({ five_id: 'F3', col: 'Pago',  spg: 'Pago', ship: 'RETURNED', col_plat: 'Rota de Entrega', hist: histPago() }),
  entregue:  lead({ five_id: 'F4', col: 'Pago',  spg: 'Pago', ship: 'DELIVERED', col_plat: 'Cobrança', hist: histPago() }),
  naoPago:   lead({ five_id: 'F5', col: 'Enviado', ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Enviado' }),
  // F6: arrasto MANUAL (Rota de Entrega -> Enviado) e a Five so REENVIA o mesmo status.
  manual:    lead({ five_id: 'F6', col: 'Enviado', ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Rota de Entrega', hist: [{ from: 'Rota de Entrega', to: 'Enviado', who: 'socio_x', time: new Date(Date.now() - 600e3).toISOString() }] }),
  // F7: pago em Pago, a transportadora passa a dizer RETURNING_TO_ORIGIN (sem entrada no _COL_DO_SELO).
  voltando:  lead({ five_id: 'F7', col: 'Pago', spg: 'Pago', ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Pago', hist: histPago() }),
  // F8: pago so pelo spg (PAGO ANTES DE CHEGAR), card em Rota de Entrega, a entrega so chegou pelo rastreio.
  ruaPagoEnt: lead({ five_id: 'F8', col: 'Rota de Entrega', spg: 'Pago', ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Rota de Entrega' }),
}
// F9: pedido PAGOS que mora no ARQUIVO de leads (linha em geracao 1), e a Five toca a five_orders dele.
const arquivado = lead({ five_id: 'F9', col: 'Pagos', spg: 'Pago', ship: 'IN_TRANSIT_TO_DELIVERY', col_plat: 'Retirada', hist: histPago() })
const linha = '{"_arq":1,"chips":[],"pressels":[],"leads":[' + Object.values(L).map((l) => JSON.stringify(l)).join(',') + '],"_fim":1}'
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,7,0,?)').run(linha, 'teste')
sq.prepare('INSERT INTO leads_arquivo (id, json, col, ts) VALUES (?,?,?,?)').run(arquivado.id, JSON.stringify(arquivado), 'Pagos', agora - 30 * 86400)

const fo = (id, ship, ev, upd) => sq.prepare('INSERT INTO five_orders (order_id, shipping_status, last_event, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, ship, ev, agora - 86400, upd)
fo('PL-F1', 'IN_TRANSIT_TO_DELIVERY', 'CHARGE_UPDATED', agora - 50)   // o proprio postback da Payt sobe o updated_at
fo('F2', 'READY_FOR_PICKUP', 'SHIPPING_UPDATE', agora - 49)
fo('F3', 'RETURNED', 'SHIPPING_UPDATE', agora - 48)
fo('F4', 'DELIVERED', 'CHARGE_UPDATED', agora - 47)
fo('F5', 'IN_TRANSIT_TO_DELIVERY', 'SHIPPING_UPDATE', agora - 46)
fo('F6', 'IN_TRANSIT_TO_DELIVERY', 'SHIPPING_UPDATE', agora - 45)   // reenvio: mesmo status que o lead ja tem
fo('F7', 'RETURNING_TO_ORIGIN', 'SHIPPING_UPDATE', agora - 44)
fo('F8', 'DELIVERED', 'SHIPPING_UPDATE', agora - 43)
fo('F9', 'IN_TRANSIT_TO_DELIVERY', 'CHARGE_UPDATED', agora - 42)

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-rastreio-pago.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }
const pend = []
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} }
let ultimoAlvo = Math.floor(Date.now() / 60000)
async function batida() {
  let alvo = ultimoAlvo + 1
  while (alvo % 5 !== 1) alvo++   // RODIZIO[1] = 'agenda', onde o _cronRastreio roda
  ultimoAlvo = alvo
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run()
  const ol = console.log, oe = console.error
  console.log = () => {}; console.error = () => {}
  try { await worker.scheduled({ scheduledTime: alvo * 60000, cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift() }
  finally { console.log = ol; console.error = oe }
}
const foto = () => {
  const row = sq.prepare('SELECT data, version, updated_by FROM dashboard_state WHERE id=1').get()
  const naLinha = JSON.parse(row.data).leads
  const arq = sq.prepare('SELECT id, col, json FROM leads_arquivo').all()
  const por = Object.fromEntries(naLinha.map((l) => [l.five_id, l]))
  for (const a of arq) { const l = JSON.parse(a.json); por[l.five_id] = { ...l, __arquivado: true, __colArq: a.col } }
  return { row, naLinha, arq, por }
}
const ehISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) && !isNaN(Date.parse(s))
let falhas = 0, oks = 0
const diz = (ok, msg, extra) => { console.log((ok ? '  ok  ' : '  XX  ') + msg + (!ok && extra ? '  ' + extra : '')); if (ok) oks++; else falhas++ }
const ult = (l) => (l.hist || []).slice(-1)[0] || {}
const antes = { ...L, arquivado }

await batida()
const A = foto()
console.log('\nBATIDA 1 (gravacoes do estado: ' + gravacoes.join(', ') + ' | linha v' + A.row.version + ' por ' + A.row.updated_by + ')')
const m = (k) => { const d = A.por[antes[k].five_id]; return d ? `${antes[k].col} -> ${d.col} (col_plat ${antes[k].col_plat} -> ${d.col_plat}, ship ${d.ship}, hist ${antes[k].hist.length} -> ${d.hist.length}${d.__arquivado ? ', no arquivo' : ''})` : 'SUMIU' }
for (const k of Object.keys(antes)) console.log('  ' + k.padEnd(11) + m(k))
const f1 = A.por['PL-F1'], f2 = A.por.F2, f3 = A.por.F3, f4 = A.por.F4, f5 = A.por.F5, f6 = A.por.F6, f7 = A.por.F7, f8 = A.por.F8, f9 = A.por.F9
diz(gravacoes.filter((g) => g === 'cron:rastreio').length === 1, 'o estado foi gravado UMA vez, como cron:rastreio', gravacoes.join(','))
diz(f1.col === 'Pago' && f1.col_plat === 'Rota de Entrega', 'F1 incidente: pago em Pago FICA em Pago; col_plat guarda o que a Five disse (Rota de Entrega)', JSON.stringify({ col: f1.col, col_plat: f1.col_plat }))
diz(f1.hist.length === 3 && ult(f1).who === 'five' && ult(f1).from === 'Pago' && ult(f1).to === 'Pago' && ult(f1).note === 'rastreio disse Rota de Entrega; o card fica em Pago (pedido pago fica em Pagos)' && ehISO(ult(f1).time), 'F1: UMA nota no hist explicando (who five, time ISO)', JSON.stringify(ult(f1)))
diz(f1.pago_ts === 1793423031000 && f1.spg === 'Pago', 'F1: pago_ts e spg intactos')
// F2 ja tinha col_plat 'Retirada' e o selo nao mudou nesta passada: o webhook ja tinha processado o
// evento, entao NADA novo pra anotar (revisao de 05/11: nota so quando a passada mudou selo ou col_plat).
diz(f2.col === 'Pagos' && f2.col_plat === 'Retirada' && f2.hist.length === 2, 'F2 Pagos + READY_FOR_PICKUP ja processado: fica em Pagos SEM nota nova', JSON.stringify({ col: f2.col, hist: f2.hist.length }))
diz(f3.col === 'Pago' && f3.col_plat === 'Devolvido' && f3.hist.length === 3 && /rastreio disse Devolvido; o card fica em Pago/.test(ult(f3).note), 'F3 Pago + RETURNED: NAO vai pra perda, nota no hist, col_plat Devolvido', JSON.stringify({ col: f3.col, col_plat: f3.col_plat, nota: ult(f3).note }))
diz(f4.col === 'Pago' && f4.col_plat === 'Cobrança' && f4.hist.length === 2, 'F4 Pago + DELIVERED: fica, hist intacto (sem nota a cada reenvio)', JSON.stringify({ col: f4.col, hist: f4.hist.length }))
diz(f5.col === 'Rota de Entrega' && f5.col_plat === 'Rota de Entrega' && f5.hist.length === 1 && ult(f5).from === 'Enviado' && ult(f5).to === 'Rota de Entrega' && ult(f5).who === 'five' && ult(f5).note === 'rastreio: IN_TRANSIT_TO_DELIVERY' && ehISO(ult(f5).time), 'F5 nao pago anda pra Rota de Entrega COM hist (who five, note rastreio: <ship>, time ISO)', JSON.stringify(ult(f5)))
console.log('  F6 (reenvio x arrasto manual, NAO consertado aqui): ' + m('manual'))
diz(f7.col === 'Pago' && f7.ship === 'RETURNING_TO_ORIGIN' && f7.ship_ts === agora - 44 && f7.hist.length === 2, 'F7 Pago + RETURNING_TO_ORIGIN: so o selo muda (ship_ts = updated_at), coluna e hist ficam', JSON.stringify({ col: f7.col, ship: f7.ship, hist: f7.hist.length }))
diz(f8.col === 'Pago' && f8.col_plat === 'Cobrança' && f8.ship === 'DELIVERED' && f8.hist.length === 1 && ult(f8).from === 'Rota de Entrega' && ult(f8).to === 'Pago' && ult(f8).who === 'five' && ult(f8).note === 'entregue e ja estava pago: foi pra Pago em vez de Cobrança', 'F8 spg Pago em Rota de Entrega + DELIVERED: vai pra Pago com nota (antes ficava preso)', JSON.stringify({ col: f8.col, col_plat: f8.col_plat, ult: ult(f8) }))
diz(!!f9 && f9.__arquivado === true && f9.col === 'Pagos' && f9.__colArq === 'Pagos' && !A.naLinha.some((l) => l.five_id === 'F9'), 'F9 Pagos ARQUIVADO: continua em Pagos e continua no arquivo (nao volta pro Kanban ativo)', JSON.stringify({ arquivado: f9 && f9.__arquivado, col: f9 && f9.col }))
diz(!!f9 && f9.col_plat === 'Rota de Entrega' && f9.hist.length === 3 && /rastreio disse Rota de Entrega; o card fica em Pagos/.test(ult(f9).note), 'F9: com a nota e o col_plat atualizados no arquivo', JSON.stringify(f9 && ult(f9)))
let trocasSemHist = []
for (const k of Object.keys(antes)) {
  const d = A.por[antes[k].five_id]; if (!d || d.col === antes[k].col) continue
  const u = ult(d)
  if (!(d.hist.length === antes[k].hist.length + 1 && u.who === 'five' && u.to === d.col && ehISO(u.time))) trocasSemHist.push(k)
}
diz(trocasSemHist.length === 0, 'TODA troca de coluna feita pelo cron escreveu hist (who five, to = coluna nova, time ISO)', trocasSemHist.join(','))

// SEGUNDA BATIDA: a Five reenviou tudo (updated_at subiu de novo). Nada pode mudar.
sq.prepare('UPDATE five_orders SET updated_at = ?').run(agora + 10)
const histAntes = Object.fromEntries(Object.keys(antes).map((k) => [k, JSON.stringify(A.por[antes[k].five_id].hist)]))
const nGrav = gravacoes.length
await batida()
const B = foto()
console.log('\nBATIDA 2, reenvio da Five (gravacoes: ' + gravacoes.slice(nGrav).join(', ') + ' | linha v' + B.row.version + ')')
diz(gravacoes.length === nGrav && B.row.version === A.row.version, 'nada mudou: o estado NAO foi regravado (versao igual)', 'v' + A.row.version + ' -> v' + B.row.version)
const duplicou = Object.keys(antes).filter((k) => JSON.stringify(B.por[antes[k].five_id].hist) !== histAntes[k])
diz(duplicou.length === 0, 'nenhuma nota duplicou no hist (os 9 pedidos iguais)', duplicou.join(','))
const wm = sq.prepare("SELECT value FROM app_config WHERE key='rastreio_wm'").get()
diz(!!wm && Number(wm.value) === agora + 10, 'e a marca d agua do rastreio avancou mesmo assim', JSON.stringify(wm))
diz(B.por.F9 && B.por.F9.__arquivado === true && B.arq.length === 1, 'F9 continua no arquivo', JSON.stringify(B.arq.map((a) => a.id + ':' + a.col)))

console.log('')
if (falhas) { console.error('FALHOU: ' + falhas + ' de ' + (oks + falhas)); process.exit(1) }
console.log('  ' + oks + ' conferencias, todas passaram.')
