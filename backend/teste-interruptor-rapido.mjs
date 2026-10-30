// O INTERRUPTOR DO NUMERO (POST /api/pressel/num) LE CHIPS E PRESSELS E GRAVA SO AS PRESSELS (30/10/2026,
// ver _estadoLe/_estadoGrava no worker.js). Antes lia o estado inteiro (1,38 MB) e regravava tudo:
// 2,2 s no meio do dia, 5,4 s no p90, e qualquer gravacao do cron no meio derrubava a tentativa.
//
// Prova, na rota de verdade contra um D1 de mentira:
//  - desligar e ligar mexem SO em pressels (pedidos e chips byte a byte iguais) e NAO leem o estado inteiro;
//  - as pressels do AFILIADO nao sao tocadas pela casa;
//  - pedido mudando no meio nao derruba; chip trocando de dono no meio faz a rota reler e recusar
//    (o numero deixou de ser daquele vendedor);
//  - vendedor so mexe no numero dele.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-interruptor-rapido.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
let leuInteiro = 0
let noMeio = null
function stmt(sql, args = []) {
  if (/^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)) leuInteiro++
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => {
      const r = sq.prepare(sql).get(...args)
      if (noMeio && /AS c0, json_extract\(data, '\$\.pressels'\) AS c1/.test(sql)) { const f = noMeio; noMeio = null; f() }
      return r ? (col ? r[col] : { ...r }) : null
    },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => { const out = []; for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run()); return out },
  exec: async (s) => sq.exec(s),
}
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, afl) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl || null)
user('dir', 'dir', 'Diretor', 'diretor')
user('vend_kevin', 'kevin', 'Kevin', 'atendente')
user('vend_gui', 'gui', 'Guilherme', 'atendente')
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gui: 'b'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gui', 'vend_gui']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)

const estado = {
  wa_statuses: [{ id: 'st_em', label: 'Em Uso', papel: 'em_uso' }],
  chips: [
    { id: 118, idx: 62, num: '(15) 99797-3450', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
    { id: 119, idx: 63, num: '(15) 99187-2193', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
    { id: 200, idx: 9887, num: '(11) 99999-9887', at: 'gio', st: 'ativo', afl: 'afl_3d767329' },
  ],
  pressels: [
    { id: 'p1', nome: 'Casa 1', vendedores: [{ at: 'vend_kevin', ativo: true }] },
    { id: 'p2', nome: 'Casa 2', vendedores: [{ at: 'vend_kevin', ativo: true }] },
    { id: 'p9', nome: 'Do Giovane', afl: 'afl_3d767329', vendedores: [{ at: 'vend_kevin', ativo: true }] },
  ],
  leads: [{ id: '100', nome: 'Joao', col: 'Cobrança', hist: [] }, { id: '101', nome: 'Ana', col: 'Enviado', hist: [] }],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-interruptor.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const liga = async (tk, at, num, on) => {
  const r = await worker.fetch(new Request('https://x/api/pressel/num', { method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify({ at, num, on }) }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const est = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
const offEm = (pid) => { const p = est().pressels.find((x) => x.id === pid); const v = (p.vendedores || []).find((x) => x.at === 'vend_kevin') || {}; return v.off || {} }
const ver = () => sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }

const fixo = () => JSON.stringify({ leads: est().leads, chips: est().chips })
let antes = fixo()
const p9antes = JSON.stringify(est().pressels.find((p) => p.id === 'p9'))
let v0 = ver()
leuInteiro = 0
let r = await liga(TK.dir, 'vend_kevin', '15997973450', false)
t(r.st === 200 && r.j.estado && r.j.estado.p1.on === false && r.j.estado.p2.on === false, 'desligar: responde 200 com o numero desligado nas duas pressels da casa', JSON.stringify(r.j).slice(0, 200))
t(offEm('p1')['97973450'] === true && offEm('p2')['97973450'] === true, 'e gravou o desligado nas pressels')
t(leuInteiro === 0, 'sem ler o estado inteiro', String(leuInteiro))
t(fixo() === antes, 'pedidos e chips ficaram byte a byte iguais')
t(JSON.stringify(est().pressels.find((p) => p.id === 'p9')) === p9antes, 'a pressel do afiliado nao foi tocada')
t(ver() === v0 + 1, 'a versao subiu 1', String(ver()))
r = await liga(TK.dir, 'vend_kevin', '15997973450', true)
t(r.st === 200 && r.j.estado.p1.on === true && !offEm('p1')['97973450'], 'ligar de novo: volta a receber')

console.log('\nCONCORRENCIA')
noMeio = () => { const d = est(); d.leads[1].col = 'Pagos'; sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)) }
r = await liga(TK.dir, 'vend_kevin', '15991872193', false)
t(r.st === 200 && offEm('p1')['91872193'] === true, 'pedido mudando no meio nao derruba o interruptor')
t(est().leads[1].col === 'Pagos', 'e a mudanca do pedido ficou')
noMeio = () => { const d = est(); d.chips.find((c) => c.id === 118).at = 'vend_gui'; sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)) }
r = await liga(TK.dir, 'vend_kevin', '15997973450', false)
t(r.st === 404 && !offEm('p1')['97973450'], 'o numero trocou de dono no meio: rele e recusa (nao desliga no vendedor errado)', JSON.stringify(r))

console.log('\nGATES')
r = await liga(TK.kevin, 'vend_kevin', '15991872193', true)
t(r.st === 200 && !offEm('p1')['91872193'], 'vendedor liga o numero dele', JSON.stringify(r.j).slice(0, 120))
r = await liga(TK.kevin, 'vend_gui', '15997973450', false)
t(r.st === 403, 'vendedor NAO mexe no numero de outro', JSON.stringify(r))

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
