// A FOTO E O PLACAR DA EQUIPE NA BARRA DO SELLWAVE WEB (23/10/2026). Roda a rota de verdade (bundle do
// wrangler) contra um D1 de mentira. Uso: npx wrangler deploy --dry-run --outdir <dir>, troque a linha
// do import de cloudflare:sockets por um stub, e: node teste-equipe-barra.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, inst TEXT, num TEXT, src TEXT, ts INTEGER, pid TEXT, ttclid TEXT)')
try { sq.exec('ALTER TABLE users ADD COLUMN photo TEXT') } catch (_) {}
try { sq.exec('ALTER TABLE users ADD COLUMN color TEXT') } catch (_) {}
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a.map(conv)), first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null }, all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }), run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } } } }
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async () => { throw new Error('rede bloqueada') }
const exp = Math.floor(Date.now() / 1000) + 86400
const foto = 'data:image/png;base64,iVBORw0KGgo='
for (const [id, nome, role, ph, cor] of [['dir', 'Diretor', 'diretor', null, '#3b82f6'], ['kevin', 'Kevin Marques', 'atendente', foto, '#a855f7'], ['gui', 'Guilherme', 'atendente', foto + 'AA', '#a855f7'], ['barb', 'Barbara Marin', 'atendente', null, '#c22488'], ['parado', 'Sem Numero', 'atendente', null, '']]) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,photo,color) VALUES (?,?,?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role, ph, cor)
}
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('b'.repeat(64), 'kevin', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('d'.repeat(64), 'dir', exp)
const ST = [{ id: 'st_em', label: 'Em Uso', papel: 'em_uso' }, { id: 'st_ban', label: 'Banido', papel: 'banido' }, { id: 'st_at', label: 'Ativo', papel: 'ativo' }]
const chips = [
  { id: 1, num: '(17) 99701-1859', at: 'kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 2, num: '(15) 99187-2193', at: 'kevin', st: 'ativo', wa_st: 'st_ban', em_uso: false },   // banido no meio do dia: os leads dele contam
  { id: 3, num: '(11) 97251-8066', at: 'gui', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 4, num: '(31) 97362-3697', at: 'barb', st: 'ativo', wa_st: 'st_em', em_uso: true },
  { id: 5, num: '(15) 99999-0001', at: 'parado', st: 'ativo', wa_st: 'st_at', em_uso: false },   // nenhum numero recebendo: fora do placar
  // OS DOIS CASOS QUE APAGAVAM LEAD DO PLACAR (24/10/2026). Os leads deles chegaram no Guilherme e
  // tem que continuar sendo dele: o 0225 saiu da coluna dele e foi pra Disponiveis (sem dono), e o
  // 2222 passou pro Kevin. Antes, os dois sumiam da conta do Guilherme no instante da mudanca.
  { id: 6, num: '(15) 99257-0225', at: '', st: 'ativo', wa_st: 'st_at', em_uso: false },
  { id: 7, num: '(11) 91111-2222', at: 'kevin', st: 'ativo', wa_st: 'st_at', em_uso: false },
]
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify({ wa_statuses: ST, chips, pressels: [{ id: 'p1', vendedores: [] }], leads: [] }))
const agora = Math.floor(Date.now() / 1000)
let i = 0
// A INSTANCIA E `ax_<at>_<8 digitos>`, que e como a captura grava: ela guarda o dono NA HORA, e e
// por ela que o placar conta. O fixture gravava 'ax_x' em todo lead, de quando o codigo somava pelos
// chips de agora e nao olhava este campo - assim o teste nao distinguia dono nenhum.
const lead = (num, n, at) => {
  const inst = 'ax_' + at + '_' + String(num).replace(/\D/g, '').slice(-8)
  for (let k = 0; k < n; k++) sq.prepare('INSERT INTO wa_lead (phone, inst, num, src, ts) VALUES (?,?,?,?,?)').run('5511' + String(100000000 + i++), inst, num, 'code', agora - 60)
}
lead('5517997011859', 4, 'kevin'); lead('5515991872193', 3, 'kevin')
lead('5511972518066', 7, 'gui'); lead('5531973623697', 2, 'barb')
// chegaram no Guilherme; hoje o numero nao e mais dele
lead('5515992570225', 5, 'gui')    // foi pra Disponiveis
lead('5511911112222', 3, 'gui')    // passou pro Kevin
const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const lista = async (tk) => { const r = await worker.fetch(new Request('https://x/api/swweb/numeros', { headers: { authorization: 'Bearer ' + tk, 'x-sw-maquina': 'mteste0000000001', 'x-sw-versao': '1.25.20' } }), env, ctx); return r.json() }
let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }
const k = await lista('b'.repeat(64))
const nomes = (k.equipe || []).map((e) => e.nome + ':' + e.leads).join(',')
t(Array.isArray(k.equipe) && k.equipe.length === 3, 'o vendedor ve a equipe inteira de quem esta recebendo (e so quem esta)', nomes)
t(nomes === 'Barbara Marin:2,Guilherme:15,Kevin Marques:7', 'com os leads de hoje de cada um, contando o numero que caiu no meio do dia', nomes)
// O BUG QUE O BRUNO ACHOU EM 24/10: "para o Guilherme parece que chegou apenas 119, sendo que chegou
// muito mais (...) acredito que seja porque eu removi alguns numeros da contingencia dele". Era isso
// mesmo: o placar somava os chips que a pessoa tem AGORA, entao tirar um numero da coluna dela
// apagava do placar os leads que aquele numero ja tinha recebido no dia. Medido no banco: 119 contra
// 397 de verdade, e 309 leads do dia que nao apareciam pra ninguem.
const gui = (k.equipe || []).find((e) => e.at === 'gui') || {}
t(gui.leads === 15, 'o lead fica com quem o recebeu, mesmo que o numero mude de dono depois', JSON.stringify(gui))
const kev = (k.equipe || []).find((e) => e.at === 'kevin') || {}
t(kev.leads === 7, 'e NAO vai junto com o numero pro dono novo', JSON.stringify(kev))
t((k.equipe || []).find((e) => e.at === 'kevin').eu === true && !(k.equipe || []).find((e) => e.at === 'gui').eu, 'e sabe qual e ele', JSON.stringify(k.equipe))
t(/\/api\/users\/foto\/kevin\//.test((k.equipe || []).find((e) => e.at === 'kevin').foto) && (k.equipe || []).find((e) => e.at === 'barb').foto === '', 'a foto vem como endereco (e vazia pra quem nao tem)', JSON.stringify(k.equipe.map((e) => e.foto)))
t((k.equipe || []).find((e) => e.at === 'barb').sigla === 'BA' && (k.equipe || []).find((e) => e.at === 'barb').cor === '#c22488', 'sem foto, vai a sigla e a cor da pessoa', JSON.stringify(k.equipe.find((e) => e.at === 'barb')))
t((k.numeros || []).every((n) => n.at === 'kevin') && (k.numeros || []).every((n) => /\/api\/users\/foto\/kevin\//.test(n.foto)), 'os numeros do vendedor continuam so os dele, e cada um leva a foto do dono', JSON.stringify(k.numeros.map((n) => [n.numero, !!n.foto])))
const d = await lista('d'.repeat(64))
t((d.equipe || []).length === 3 && (d.numeros || []).some((n) => n.at === 'gui' && /foto\/gui\//.test(n.foto)), 'a direcao ve a mesma equipe, e os numeros de todos com a foto do dono', JSON.stringify((d.equipe || []).map((e) => e.nome)))
console.log('\n' + ok + ' certos, ' + mau + ' errados'); process.exit(mau ? 1 : 0)
