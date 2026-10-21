// BANIDO SOME DA LISTA DO SELLWAVE WEB (21/10/2026). Roda a rota de verdade (bundle do wrangler) contra um D1
// de mentira. Uso: npx wrangler deploy --dry-run --outdir <dir>, troque a linha do import de
// cloudflare:sockets por um stub, e: node teste-lista-sem-banido.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)')
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
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor')
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_kevin', 'kevin', 'x', 'Kevin', 'KE', 'atendente')
const TK_K = 'a'.repeat(64), TK_D = 'd'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_K, 'vend_kevin', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_D, 'dir', exp)
const ST = [{ id: 'st_em', label: 'Em Uso', papel: 'em_uso' }, { id: 'st_ban', label: 'Banido', papel: 'banido' }, { id: 'st_res', label: 'Restrito', papel: 'restrito' }, { id: 'st_sem', label: 'Sem quedas' }]
const estado = { wa_statuses: ST, chips: [
  { id: 1, num: '(17) 99701-1859', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 2, num: '(15) 99797-3450', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 3, num: '(47) 99740-5847', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 4, num: '(15) 99187-2193', at: 'vend_kevin', st: 'ativo', wa_st: 'st_ban', wa_st2: 'st_res', em_uso: false },
  { id: 5, num: '(15) 99187-9743', at: 'vend_kevin', st: 'ativo', wa_st: 'st_ban', wa_st2: 'st_res', em_uso: false },
  { id: 6, num: '(15) 99999-0001', at: 'vend_kevin', st: 'ativo', wa_st: 'st_res', em_uso: false },
  { id: 7, num: '(15) 99999-0002', at: 'vend_kevin', st: 'banido', wa_st: 'st_sem', em_uso: false },
], pressels: [{ id: 'p1', vendedores: [] }], leads: [] }
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const MAQ = 'mkevin0000000002'
const lista = async (tk, maq) => {
  const r = await worker.fetch(new Request('https://x/api/swweb/numeros', { headers: { authorization: 'Bearer ' + tk, 'x-sw-maquina': maq, 'x-sw-versao': '1.25.8' } }), env, ctx)
  const j = await r.json(); return (j.numeros || []).map((n) => n.numero.slice(-4) + (n.banido ? '(ban)' : ''))
}
let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }
let l = await lista(TK_K, MAQ)
t(l.join(',') === '1859,3450,5847,0001', 'o Kevin ve os 3 de pe e o restrito; os banidos (cartao e campo antigo) somem', l.join(','))
l = await lista(TK_D, 'mbruno0000000001')
t(!l.some((x) => /2193|9743|0002/.test(x)), 'a direcao tambem nao ve os banidos', l.join(','))
// o 2193 aberto na maquina do Kevin: fica ate ele fechar
const agora = Math.floor(Date.now() / 1000)
sq.prepare('INSERT INTO swweb_uso (nk, user_id, nome, maquina, desde, ate) VALUES (?,?,?,?,?,?)').run('1591872193', 'vend_kevin', 'Kevin', MAQ, agora - 60, agora + 120)
l = await lista(TK_K, MAQ)
t(l.includes('2193(ban)') && !l.includes('9743(ban)'), 'banido aberto nesta maquina fica na lista ate fechar', l.join(','))
l = await lista(TK_D, 'mbruno0000000001')
t(!l.some((x) => /2193/.test(x)), 'em outra maquina ele continua sumido', l.join(','))
sq.exec('DELETE FROM swweb_uso')
l = await lista(TK_K, MAQ)
t(!l.some((x) => /2193/.test(x)), 'fechou, sumiu', l.join(','))
console.log('\n' + ok + ' certos, ' + mau + ' errados')
process.exit(mau ? 1 : 0)
