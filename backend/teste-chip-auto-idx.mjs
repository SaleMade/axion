// O "AUTO" DO Nº DO CHIP CONTA SO O MESMO MUNDO (30/10/2026).
//
// Queixa do Bruno: no Novo chip o campo Nº mostra "Auto (67)", ele deixa em branco, salva, e o
// numero nasce com outro Nº. A tela calcula o maior Nº DA CASA + 1; o servidor calculava o maior Nº
// de TODOS os chips do estado, e os chips do afiliado usam os 4 ultimos digitos como Nº (ate 9887).
// Resultado: o chip da casa nascia 9888.
//
// Aqui: chip da casa sem Nº nasce com o maior da casa + 1, chip do afiliado sem Nº nasce com o
// maior DELE + 1, e Nº digitado continua sendo respeitado.
//
// Roda a ROTA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-chip-auto-idx.mjs <dir>/worker.js
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
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, afl) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl || null)
user('dir', 'dir', 'Diretor', 'diretor')
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
const TK = { dir: 'd'.repeat(64), gio: 'e'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['gio', 'gio']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)

// O formato de producao em 30/10: casa ate 68, afiliado com Nº = 4 ultimos digitos (ate 9887).
const estado = {
  chips: [
    { id: 129, idx: 67, num: '(15) 99999-8842', st: 'ativo' },
    { id: 130, idx: 68, num: '(15) 99999-0026', st: 'ativo' },
    { id: 102, idx: 9887, num: '(11) 99999-9887', st: 'ativo', afl: 'afl_3d767329' },
    { id: 57, idx: 9837, num: '(11) 99999-9837', st: 'ativo', afl: 'afl_3d767329' },
  ],
  nextChip: 131,
  pressels: [], leads: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-chip-auto.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const post = async (tk, rota, corpo) => {
  const r = await worker.fetch(new Request('https://x' + rota, {
    method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify(corpo),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }
const cria = (tk, chip) => post(tk, '/api/chip/create', { chip })
const leChip = (id) => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data).chips.find((c) => c.id === id)

let r = await cria(TK.dir, { num: '(15) 98888-0001' })
t(r.st === 200 && r.j.chip && r.j.chip.idx === 69, 'casa sem Nº: nasce 69 (o "Auto (69)" da tela), nao 9888', JSON.stringify(r.j.chip && r.j.chip.idx))
t(r.j.chip && !r.j.chip.afl, 'chip da casa continua sem o campo afl')
r = await cria(TK.dir, { num: '(15) 98888-0002' })
t(r.st === 200 && r.j.chip && r.j.chip.idx === 70, 'o seguinte da casa vem 70', JSON.stringify(r.j.chip && r.j.chip.idx))
r = await cria(TK.dir, { num: '(15) 98888-0003', idx: 500 })
t(r.st === 200 && r.j.chip && r.j.chip.idx === 500, 'Nº digitado e respeitado', JSON.stringify(r.j.chip && r.j.chip.idx))
r = await cria(TK.gio, { num: '(11) 98888-0004' })
t(r.st === 200 && r.j.chip && r.j.chip.idx === 9888 && r.j.chip.afl === 'afl_3d767329', 'afiliado sem Nº: conta so os dele (9887 + 1) e leva o afl', JSON.stringify(r.j.chip))
const c = leChip(r.j.chip && r.j.chip.id)
t(!!c && c.idx === 9888, 'o chip do afiliado ficou gravado no estado com o Nº certo')
t(leChip(131) && leChip(131).idx === 69, 'o 69 da casa continua gravado')

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
