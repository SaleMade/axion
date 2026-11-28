// A COMISSAO DO PAGAMENTO PARCIAL (27/11/2026). Pedido do Bruno: "se o cliente ja pagou uma parcela
// (...) ja aparece pro meu cobrador e pro meu vendedor a comissao dele em cima daquilo que ja foi pago
// (...) ja deveria contabilizar dentro da comissao que eles podem sacar".
//
// O QUE ESTE TESTE GUARDA (o servidor; a conta das telas tem o gemeo em
// axion-produtor/scripts/teste-comissao-parcial.mjs):
//  - a varredura CONGELA a taxa do cobrador ja na primeira parte paga (de 01/11 em diante), nao so
//    quando o pedido quita. Sem isso a parte rendia zero pra ele;
//  - parte paga em OUTUBRO nao carimba (outubro fecha no fixo, decisao de 29/10);
//  - pedido sem nada pago continua sem carimbo;
//  - trocar o dono de um pedido com parte paga recarimba pro cobrador novo (e a direcao fica sem taxa);
//  - o SALDO DO SAQUE (que o servidor confere) soma a comissao da parte paga, do vendedor e do cobrador.
//
// Roda o worker DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-comissao-parcial.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
function stmt(sql, args = []) {
  return {
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, pct) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, pct || 0)
user('dir', 'dir', 'Diretor', 'diretor', 0)
user('cob_a', 'coba', 'Cobrador A', 'cobrador', 3)
user('cob_b', 'cobb', 'Cobrador B', 'cobrador', 4)
user('vend_gui', 'gui', 'Guilherme', 'atendente', 12)
const TK = { dir: 'd'.repeat(64), gui: 'b'.repeat(64), coba: 'e'.repeat(64) }
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.dir, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.gui, 'vend_gui', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.coba, 'cob_a', exp)

const DESDE = Date.UTC(2026, 10, 1, 3, 0, 0)
const DIA = 86400000
const seg = (ms) => Math.floor(ms / 1000)
const lead = (id, extra) => ({ id, nome: 'Cliente ' + id, at: 'vend_gui', cob: 'cob_a', col: 'Cobrança', vl: 497, hist: [], ...extra })

const estado = {
  leads: [
    // PARTE PAGA EM NOVEMBRO, parcela em SEGUNDOS (como o pagamento_add grava): carimba 3%
    lead('P1', { spg: 'Parcial', pagamentos: [{ ts: seg(DESDE + 3 * DIA), valor: 200 }] }),
    // PARTE PAGA EM NOVEMBRO, parcela em MS (como a Payt grava): carimba tambem
    lead('P2', { spg: 'Parcial', pagamentos: [{ ts: DESDE + 4 * DIA, valor: 150, who: 'payt' }] }),
    // PARTE PAGA EM OUTUBRO: nao carimba (outubro fecha no fixo)
    lead('P3', { spg: 'Parcial', pagamentos: [{ ts: seg(DESDE - 3 * DIA), valor: 100 }] }),
    // NADA PAGO: nao carimba
    lead('P4'),
    // PAGO EM NOVEMBRO (a regra de antes continua)
    lead('P5', { col: 'Pagos', spg: 'Pago', pago_ts: DESDE + 5 * DIA }),
    // PARTE PAGA DE AFILIADO: nunca e da casa
    lead('P6', { afl: 'afl_x', cob: undefined, spg: 'Parcial', pagamentos: [{ ts: seg(DESDE + 3 * DIA), valor: 200 }] }),
  ],
  chips: [], pressels: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,0,?)').run(JSON.stringify(estado), 'teste')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-parcial.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }
const pend = []
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} }

const batida = async () => {
  let alvo = Math.floor(Date.now() / 60000)
  while (alvo % 5 !== 1) alvo++
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run()
  const ol = console.log, oe = console.error
  console.log = () => {}; console.error = () => {}
  try { await worker.scheduled({ scheduledTime: alvo * 60000, cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift() }
  finally { console.log = ol; console.error = oe }
}
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
const grava = (d) => sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
const doId = (id) => (ler().leads || []).find((l) => l.id === id) || {}
const api = async (tk, id, patch) => {
  const r = await worker.fetch(new Request('https://x/api/lead/' + id, {
    method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify({ patch }),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const saque = async (tk, valor) => {
  const r = await worker.fetch(new Request('https://x/api/saque/create', {
    method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify({ valor }),
  }), env, ctx)
  return r.json().catch(() => ({}))
}
const recusaSaques = () => { const d = ler(); (d.saques || []).forEach((x) => { x.status = 'recusado' }); grava(d) }

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }
const perto = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01

console.log('\nA TAXA DO COBRADOR CONGELA NA PRIMEIRA PARTE PAGA')
await batida()
t(doId('P1').cob_pct === 3, 'parte paga em novembro (parcela em segundos) carimbou 3%', String(doId('P1').cob_pct))
t(doId('P2').cob_pct === 3, 'parte paga em novembro (parcela em ms, da Payt) carimbou 3%', String(doId('P2').cob_pct))
t(doId('P3').cob_pct === undefined, 'parte paga em OUTUBRO nao carimbou (outubro fecha no fixo)', String(doId('P3').cob_pct))
t(doId('P4').cob_pct === undefined, 'pedido sem nada pago continua sem carimbo', String(doId('P4').cob_pct))
t(doId('P5').cob_pct === 3, 'pedido pago em novembro continua carimbando', String(doId('P5').cob_pct))
t(!doId('P6').cob && doId('P6').cob_pct === undefined, 'parte paga de AFILIADO nao ganha cobrador nem taxa da casa', JSON.stringify({ cob: doId('P6').cob, pct: doId('P6').cob_pct }))
t(doId('P1').spg === 'Parcial' && doId('P1').col === 'Cobrança', 'o carimbo nao mexe no status nem na etapa do pedido', doId('P1').spg + ' / ' + doId('P1').col)

console.log('\nA TAXA CONGELADA NAO MUDA QUANDO A TAXA DO CADASTRO MUDA')
sq.prepare("UPDATE users SET com_pct=5 WHERE id='cob_a'").run()
await batida()
t(doId('P1').cob_pct === 3, 'a parte de novembro continua com os 3% de quando entrou', String(doId('P1').cob_pct))
sq.prepare("UPDATE users SET com_pct=3 WHERE id='cob_a'").run()

console.log('\nUMA PARTE NOVA PELO pagamento_add: a varredura carimba logo depois')
{
  let r = await api(TK.dir, 'P4', { pagamento_add: { valor: 100 } })
  t(r.st === 200 && doId('P4').spg === 'Parcial', 'a parte entrou e o pedido virou Parcial', JSON.stringify(r.j) + ' ' + doId('P4').spg)
  await batida()
  t(doId('P4').cob_pct === 3, 'o pedido que acabou de ter a primeira parte ganhou os 3%', String(doId('P4').cob_pct))
}

console.log('\nTROCAR O DONO DE UM PEDIDO COM PARTE PAGA RECARIMBA')
{
  let r = await api(TK.dir, 'P1', { cob: 'cob_b' })
  t(r.st === 200 && doId('P1').cob === 'cob_b' && doId('P1').cob_pct === 4, 'passou pro cobrador B com a taxa dele (4%)', JSON.stringify({ cob: doId('P1').cob, pct: doId('P1').cob_pct }))
  r = await api(TK.dir, 'P1', { cob: 'dir' })
  t(doId('P1').cob === 'dir' && doId('P1').cob_pct === undefined, 'na mao da direcao fica sem taxa (a comissao fica na casa)', JSON.stringify({ cob: doId('P1').cob, pct: doId('P1').cob_pct }))
  r = await api(TK.dir, 'P1', { cob: 'cob_a' })
  t(doId('P1').cob === 'cob_a' && doId('P1').cob_pct === 3, 'de volta pro cobrador A, 3% de novo', JSON.stringify({ cob: doId('P1').cob, pct: doId('P1').cob_pct }))
}

console.log('\nO SALDO DO SAQUE SOMA A PARTE PAGA')
{
  // Cobrador A: P1 200 + P2 150 + P4 100 (partes) + P5 497 (pago, sem ficha = valor a cobrar), tudo a 3%.
  const cobEsperado = Math.round((200 + 150 + 100 + 497) * 3) / 100
  let s = await saque(TK.coba, cobEsperado)
  t(s.ok && s.saque && perto(s.saque.saldo_servidor, cobEsperado), 'o saldo do cobrador inclui as partes pagas (R$ ' + cobEsperado + ')', String(s.saque && s.saque.saldo_servidor))
  t(s.saque && s.saque.acima_do_saldo === false, 'sacar tudo isso NAO marca "acima do saldo"', JSON.stringify(s.saque || s))
  recusaSaques()
  // Vendedor (12%): as mesmas partes da casa + a de OUTUBRO (P3: a comissao do vendedor nao tem o
  // corte de novembro, so a do cobrador) + o pago. A parte do afiliado (P6) e de outro mundo.
  const vendEsperado = Math.round((200 + 150 + 100 + 100 + 497) * 12) / 100
  s = await saque(TK.gui, vendEsperado)
  t(s.ok && s.saque && perto(s.saque.saldo_servidor, vendEsperado), 'o saldo do vendedor inclui as partes pagas (R$ ' + vendEsperado + ')', String(s.saque && s.saque.saldo_servidor))
  t(s.saque && s.saque.acima_do_saldo === false, 'e sacar tudo isso NAO marca "acima do saldo"', JSON.stringify(s.saque || s))
  recusaSaques()
  s = await saque(TK.gui, vendEsperado + 30)
  t(s.saque && s.saque.acima_do_saldo === true, 'pedir R$ 30 a mais que isso marca "acima do saldo"', JSON.stringify(s.saque || s))
  recusaSaques()
}

console.log('\nRODAR DE NOVO NAO MEXE EM NADA')
{
  const v = Number(sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version)
  await batida()
  const v2 = Number(sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version)
  t(v2 === v, 'a versao do estado nao andou', v + ' -> ' + v2)
}

console.log('\n' + ok + ' de ' + (ok + mau) + ' conferencias passaram')
process.exit(mau ? 1 : 0)
