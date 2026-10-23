// A COLHEITA E A SAUDE DA CAPTURA NO WORKER (23/10/2026). Roda a rota de verdade (bundle do wrangler) contra um D1 de
// mentira. Uso: npx wrangler deploy --dry-run --outdir <dir>, troque a linha do import de cloudflare:sockets por
// um stub, e: node teste-colheita-worker.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)')
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a.map(conv)), first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null }, all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }), run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } } } }
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async (u) => { throw new Error('rede bloqueada') }
const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); }
const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('gui', 'gui', 'x', 'Guilherme', 'GU', 'atendente')
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('a'.repeat(64), 'gui', exp)
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify({ chips: [{ id: 1, num: '(11) 97251-8066', at: 'gui', wa_st: 'em_uso', em_uso: true }], pressels: [], leads: [] }))
const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const pede = async (rota, corpo) => { const r = await worker.fetch(new Request('https://x' + rota, { method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json', 'x-sw-versao': '1.25.16' }, body: JSON.stringify(corpo) }), env, ctx); let j = null; try { j = await r.json() } catch (_) {} return { http: r.status, ...j } }
const agoraS = Math.floor(Date.now() / 1000)
const r = await pede('/api/swweb/captura', { events: [
  { msgId: 'COLH1', via: 'colheita', selfNumber: '551172518066', phone: '5511933332222', lid: 0, velha: 1, fromMe: false, type: 'text', body: 'Olá! Código de desconto "XYZ789"', pushName: 'Lead', ts: agoraS - 7200 },
  { msgId: 'COLH2', via: 'colheita-funil', selfNumber: '551172518066', phone: '5511933332222', lid: 0, velha: 0, fromMe: true, type: 'text', body: 'Oi!', ts: agoraS - 60 },
] })
const rh = await pede('/api/swweb/heartbeat', { numero: '551172518066', auth: true, motor: true, saude: { fila: 57, drenouEm: Date.now() - 900000, erro: 'fetch failed', colhidas: 3, colheuEm: Date.now() - 30000 } })
console.log = orig
const msgs = sq.prepare("SELECT msg_id, direction FROM wa_messages ORDER BY msg_id").all()
let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }
t(r.http === 200 && Array.isArray(r.ack) && r.ack.includes('COLH1') && r.ack.includes('COLH2'), 'a captura aceita os eventos da colheita e devolve o ack', JSON.stringify(r))
t(msgs.length === 2, 'as duas viram mensagem no inbox', JSON.stringify(msgs))
t(logs.some((l) => /^SWWEB_COLHEITA n=2 entrada=1 funil=1 por=gui nums=8066/.test(l)), 'o worker mede quanto a colheita salvou', logs.filter((l) => /COLHEITA/.test(l)).join(' | '))
t(rh.http === 200 && logs.some((l) => /^SWWEB_SAUDE num=72518066 por=gui fila=57 drenou_ha=9\d\ds erro=fetch failed colhidas=3/.test(l)), 'o sinal de vida com a fila parada vira SWWEB_SAUDE no log', logs.filter((l) => /SAUDE/.test(l)).join(' | '))
console.log('\n' + ok + ' certos, ' + mau + ' errados'); process.exit(mau ? 1 : 0)
