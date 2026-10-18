// Prova LOCAL da liberacao forcada de aluguel: roda o worker DE VERDADE (bundle do wrangler)
// contra um D1 de mentira (node:sqlite em memoria). Nao toca em producao.
// Uso: node teste-libera-uso.mjs <bundle>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) { /* tabela que o teste nao usa */ } }

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
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'bruno', 'x', 'Bruno', 'BR', 'diretor')
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_kevin', 'kevin', 'x', 'Kevin', 'KV', 'atendente')
const TK_DIR = 'd'.repeat(64), TK_VEN = 'a'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_DIR, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_VEN, 'vend_kevin', exp)

// O numero tem que ser DE ALGUEM: a rota recusa numero sem dono.
const NK = '1599999999'
const estado = { chips: [{ id: 1, num: '(15) 99999-9999', at: 'vend_kevin', st: 'ativo', wa_st: '', em_uso: true }], pressels: [], leads: [] }
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

const mod = await import(pathToFileURL(bundle).href)
const worker = mod.default
const env = { DB, MEDIA: null }
const ctx = { waitUntil: () => {} }
const chama = async (token, corpo, maquina) => {
  const r = await worker.fetch(new Request('https://x/api/swweb/uso', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-sw-maquina': maquina },
    body: JSON.stringify(corpo),
  }), env, ctx)
  let j = null
  try { j = await r.json() } catch (_) {}
  return { http: r.status, ...j }
}
const linha = () => sq.prepare('SELECT * FROM swweb_uso WHERE nk=?').get(NK) || null
const revoga = () => sq.prepare('SELECT * FROM swweb_uso_revoga WHERE nk=?').all(NK)

let ok = 0, mau = 0
const t = (cond, oque, det) => { if (cond) { ok++; console.log('  ok    ' + oque) } else { mau++; console.log('  FALHOU ' + oque + (det ? '  -> ' + det : '')) } }

const MAQ_PRESA = 'mpresa0000000001'       // a maquina do vendedor que travou (app 1.21.0 vazando)
const MAQ_NOVA = 'mnova00000000002'        // o mesmo vendedor, depois de reabrir o app
const MAQ_OUTRA = 'moutra0000000003'       // outra maquina qualquer

console.log('── 1) o vendedor pega o numero e a trava funciona ──')
let r = await chama(TK_VEN, { nk: NK }, MAQ_PRESA)
t(r.ok === true, 'a maquina presa pega o aluguel', JSON.stringify(r))
r = await chama(TK_VEN, { nk: NK }, MAQ_OUTRA)
t(r.ok === false && !!r.ocupado, 'outra maquina e recusada enquanto ele tem', JSON.stringify(r))

console.log('')
console.log('── 2) o vendedor NAO pode liberar a forca ──')
r = await chama(TK_VEN, { nk: NK, soltar: true, forcar: true }, MAQ_OUTRA)
t(r.http === 403, 'vendedor levando 403 no forcar', 'http ' + r.http + ' ' + JSON.stringify(r.error || r.erro || ''))
t(!!linha(), 'e o aluguel continua de pe', JSON.stringify(linha()))

console.log('')
console.log('── 3) a direcao libera ──')
r = await chama(TK_DIR, { nk: NK, soltar: true, forcar: true }, MAQ_OUTRA)
t(r.ok === true && r.forcado === true, 'a direcao libera', JSON.stringify(r))
t(linha() === null, 'o aluguel sumiu', JSON.stringify(linha()))
const rv = revoga()
t(rv.length === 1 && rv[0].maquina === MAQ_PRESA, 'a maquina presa entrou em quarentena', JSON.stringify(rv))
const log = sq.prepare("SELECT * FROM pressel_num_log WHERE acao='uso_liberado'").all()
t(log.length === 1 && String(log[0].por) === 'dir', 'ficou registrado quem liberou', JSON.stringify(log))

console.log('')
console.log('── 4) O PONTO DO TESTE: o app que vazou NAO retoma ──')
r = await chama(TK_VEN, { nk: NK }, MAQ_PRESA)
t(r.ok === false && r.revogado === true, 'a maquina presa e recusada na renovacao seguinte', JSON.stringify(r))
t(/Feche e abra/i.test(String(r.erro || '')), 'e a frase diz o que fazer', String(r.erro || ''))
t(linha() === null, 'e ela nao recriou o aluguel', JSON.stringify(linha()))

console.log('')
console.log('── 5) quem precisa do numero consegue, na hora ──')
r = await chama(TK_VEN, { nk: NK }, MAQ_NOVA)
t(r.ok === true, 'o mesmo vendedor, no app reaberto, pega o numero', JSON.stringify(r))
t(linha() && linha().maquina === MAQ_NOVA, 'o aluguel e dele agora', JSON.stringify(linha()))
r = await chama(TK_VEN, { nk: NK }, MAQ_PRESA)
t(r.ok === false, 'e a maquina presa continua fora', JSON.stringify(r))

console.log('')
console.log('── 6) liberar numero ja livre nao quebra ──')
await chama(TK_VEN, { nk: NK, soltar: true }, MAQ_NOVA)
r = await chama(TK_DIR, { nk: NK, soltar: true, forcar: true }, MAQ_OUTRA)
t(r.ok === true && r.jaLivre === true, 'responde jaLivre em vez de erro', JSON.stringify(r))

console.log('')
console.log('── 7) a quarentena vence sozinha ──')
sq.prepare('UPDATE swweb_uso_revoga SET ate = ? WHERE nk = ?').run(Math.floor(Date.now() / 1000) - 1, NK)
r = await chama(TK_VEN, { nk: NK }, MAQ_PRESA)
t(r.ok === true, 'passados os 3 minutos a maquina volta a poder', JSON.stringify(r))

console.log('')
console.log(ok + ' passaram, ' + mau + ' falharam')
process.exit(mau ? 1 : 0)
