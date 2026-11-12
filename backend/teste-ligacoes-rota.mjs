// LIGACOES DE CADA NUMERO (12/11/2026). Roda a rota de verdade da captura (bundle do wrangler)
// contra um D1 de mentira e confere que a ligacao sai do lote ANTES da ingestao: vai pra
// swweb_ligacoes e nunca vira mensagem em wa_messages.
// Uso: npx wrangler deploy --dry-run --outdir <dir>, troque a linha do import de
// cloudflare:sockets por um stub, e: node teste-ligacoes-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
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
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { const out = []; for (const s of l) out.push(await s.run()); return out }, exec: async (s) => sq.exec(s) }
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }
const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_kevin', 'kevin', 'x', 'Kevin', 'KE', 'atendente')
const TK = 'a'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK, 'vend_kevin', exp)
const estado = { chips: [
  { id: 1, num: '(49) 98893-1497', at: 'vend_kevin', st: 'ativo' },
  { id: 2, num: '(15) 99243-9406', at: 'outro', st: 'ativo' },
], leads: [] }
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const agora = Math.floor(Date.now() / 1000)
const manda = async (events) => {
  const r = await worker.fetch(new Request('https://x/api/swweb/captura', {
    method: 'POST', body: JSON.stringify({ events }),
    headers: { authorization: 'Bearer ' + TK, 'content-type': 'application/json', 'x-sw-maquina': 'mkevin0000000002', 'x-sw-versao': '1.26.17' },
  }), env, ctx)
  return { status: r.status, j: await r.json().catch(() => null) }
}
const lig = (id, extra) => ({ msgId: id, via: '', selfNumber: '5549988931497', phone: '5511999998888', lid: 0, velha: 0, fromMe: true,
  type: 'call_log', body: '', pushName: '', ts: agora - 30, cifraMs: 0, cifraSoltas: 0, ligacao: { video: 0, dur: 0, desfecho: '' }, ...extra })
const ligs = () => sq.prepare('SELECT * FROM swweb_ligacoes ORDER BY msg_id').all().map((r) => ({ ...r }))
const msgs = () => { try { return sq.prepare("SELECT msg_id, type FROM wa_messages").all().map((r) => ({ ...r })) } catch (_) { return [] } }

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

// 1. lote so com uma ligacao do numero do Kevin
let r = await manda([lig('LIG1', { ligacao: { video: 0, dur: 0, desfecho: '' } })])
t(r.status === 200 && Array.isArray(r.j && r.j.ack) && r.j.ack.includes('LIG1'), 'a ligacao volta no ack (o app tira da fila)', JSON.stringify(r.j))
let l = ligs()
t(l.length === 1 && l[0].nk8 === '88931497' && l[0].de_mim === 1 && l[0].phone === '5511999998888', 'ela vira uma linha em swweb_ligacoes, com o numero, quem ligou e o telefone', JSON.stringify(l))
t(!msgs().some((m) => m.msg_id === 'LIG1'), 'e NAO vira mensagem em wa_messages', JSON.stringify(msgs()))

// 2. a mesma ligacao volta com duracao e desfecho: atualiza, nao duplica
r = await manda([lig('LIG1', { ligacao: { video: 0, dur: 75, desfecho: 'Connected' } })])
l = ligs()
t(l.length === 1 && l[0].dur === 75 && l[0].desfecho === 'Connected', 'a mesma ligacao com duracao atualiza a linha, sem duplicar', JSON.stringify(l))
r = await manda([lig('LIG1', { ligacao: { video: 0, dur: 0, desfecho: '' } })])
l = ligs()
t(l.length === 1 && l[0].dur === 75 && l[0].desfecho === 'Connected', 'e uma repeticao sem dados nao apaga a duracao nem o desfecho', JSON.stringify(l))

// 3. ligacao de numero que nao e do Kevin: barrada pela trava da rota
r = await manda([lig('LIG2', { selfNumber: '5515992439406' })])
t(!ligs().some((x) => x.msg_id === 'LIG2') && Number(r.j && r.j.barrados) === 1, 'ligacao de numero de outra pessoa e barrada', JSON.stringify(r.j))

// 4. lote misto: a ligacao sai, a mensagem de gente segue pra ingestao
r = await manda([
  lig('LIG3', { fromMe: false, ligacao: { video: 1, dur: 0, desfecho: 'Missed' } }),
  { msgId: 'TXT1', via: '', selfNumber: '5549988931497', phone: '5511999998888', lid: 0, velha: 0, fromMe: false, type: 'text', body: 'oi, quero saber do produto', pushName: 'Cliente', ts: agora - 20, cifraMs: 0, cifraSoltas: 0 },
])
l = ligs()
const l3 = l.find((x) => x.msg_id === 'LIG3')
t(l3 && l3.de_mim === 0 && l3.video === 1 && l3.desfecho === 'Missed', 'no lote misto a ligacao (recebida, de video, perdida) vai pra conta dela', JSON.stringify(l3))
const m = msgs()
t(m.some((x) => x.msg_id === 'TXT1') && !m.some((x) => x.msg_id === 'LIG3'), 'e a mensagem de gente do mesmo lote continua indo pra conversa', JSON.stringify(m) + ' status=' + r.status)

console.log('\n' + ok + ' de ' + (ok + mau))
process.exit(mau ? 1 : 0)
