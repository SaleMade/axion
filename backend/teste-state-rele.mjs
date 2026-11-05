// A LEITURA DO ESTADO NAO DEVOLVE COPIA VELHA NA PRIMEIRA FALHA DO BANCO (05/11/2026, ver _dashRawAtual).
//
// O GET /api/state pergunta ao banco so a versao (uma linha) e, se ela nao mudou, devolve o texto que ja
// esta na memoria do isolate. Quando essa pergunta FALHAVA (D1 em rajada, "network connection lost",
// "DB is overloaded"), o worker devolvia na hora o ultimo texto que tinha, de ate 2 minutos atras, com a
// versao velha. E isso acontece justamente na hora em que mais doi: no dia do arrasto do pedido
// 1792845282163 a tela recebeu o quadro de ANTES da gravacao, com a versao andando pra tras, logo depois
// do toast verde. Agora: pergunta de novo uma vez (150 ms); se ainda falhar, faz a leitura completa; so
// com as duas falhando devolve a copia velha (nunca 500: as outras telas cairiam no vazio).
//
// Prova, na rota de verdade (GET /api/state) contra um D1 de mentira que falha sob comando:
//  1. primeira leitura: completa, versao 1;
//  2. o estado muda (v2) e a pergunta da versao falha DUAS vezes: a resposta e a v2, fresca, via leitura completa;
//  3. a pergunta falha so na primeira vez: a repeticao responde e a copia da memoria serve (versao igual);
//  4. idem com a versao diferente (v3): a repeticao ve a diferenca e cai na leitura completa;
//  5. pergunta E leitura completa falhando: devolve a ultima copia (v3), 200, sem 500;
//  6. banco de volta: responde normal, pela versao, sem leitura completa.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-state-rele.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
if (!bundle) { console.error('uso: node teste-state-rele.mjs <dir>/worker.js'); process.exit(2) }
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
const ehVersao = (sql) => /^\s*SELECT version, updated_at, updated_by FROM dashboard_state WHERE id = 1\s*$/i.test(sql)
const ehInteiro = (sql) => /^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)
// comandos do teste: quantas vezes a pergunta da versao ainda vai falhar; se a leitura completa falha
let falhaVersao = 0, falhaInteiro = false
let perguntas = 0, inteiras = 0
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => {
      if (ehVersao(sql)) { perguntas++; if (falhaVersao > 0) { falhaVersao--; throw new Error('D1_ERROR: network connection lost (teste)') } }
      if (ehInteiro(sql)) { inteiras++; if (falhaInteiro) throw new Error('D1_ERROR: D1 DB is overloaded (teste)') }
      const r = sq.prepare(sql).get(...args)
      return r ? (col ? r[col] : { ...r }) : null
    },
    all: async () => {
      if (ehInteiro(sql)) { inteiras++; if (falhaInteiro) throw new Error('D1_ERROR: D1 DB is overloaded (teste)') }
      return { results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }
    },
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
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor', null)
const TK = 'd'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK, 'dir', exp)
const estado = { tags: [], regras: { kits: [] }, team: [], leads: [{ id: '100', nome: 'Joao da Casa', col: 'Rota de Entrega', at: 'vend_kevin', afl: '', obs: 'v1', hist: [] }] }
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,1,?)').run(JSON.stringify(estado), 'teste')
const regrava = (fn, quem) => { const d = JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data); fn(d); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_at=updated_at+1, updated_by=? WHERE id=1').run(JSON.stringify(d), quem) }

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-state-rele.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const le = async () => {
  const t0 = Date.now()
  const r = await worker.fetch(new Request('https://x/api/state', { headers: { authorization: 'Bearer ' + TK } }), env, ctx)
  const j = await r.json().catch(() => ({}))
  const lead = (((j || {}).data || {}).leads || []).find((l) => String(l.id) === '100') || {}
  return { st: r.status, version: Number(j && j.version), obs: lead.obs, ms: Date.now() - t0 }
}
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }
const zera = () => { perguntas = 0; inteiras = 0 }

console.log('\n1. PRIMEIRA LEITURA (completa)')
let r = await le()
t(r.st === 200 && r.version === 1 && r.obs === 'v1', 'responde a v1', JSON.stringify(r))
t(inteiras >= 1, 'pela leitura completa', String(inteiras))

console.log('\n2. O ESTADO MUDOU E A PERGUNTA DA VERSAO FALHA DUAS VEZES')
regrava((d) => { d.leads[0].obs = 'v2: card movido' }, 'kanban:dir')
zera(); falhaVersao = 2
r = await le()
t(r.st === 200 && r.version === 2 && r.obs === 'v2: card movido', 'a resposta e a v2, FRESCA (antes: a copia velha v1, com a versao andando pra tras)', JSON.stringify(r))
t(perguntas === 2, 'perguntou a versao duas vezes (a repeticao)', String(perguntas))
t(inteiras >= 1, 'e caiu na leitura completa', String(inteiras))
t(r.ms >= 150, 'a repeticao esperou 150 ms', r.ms + ' ms')
t(falhaVersao === 0, '(as duas falhas foram consumidas)')

console.log('\n3. A PERGUNTA FALHA SO NA PRIMEIRA VEZ, VERSAO IGUAL')
zera(); falhaVersao = 1
r = await le()
t(r.st === 200 && r.version === 2 && r.obs === 'v2: card movido', 'responde a v2', JSON.stringify(r))
t(perguntas === 2 && inteiras === 0, 'a repeticao respondeu e a copia da memoria serviu, sem leitura completa', 'perguntas ' + perguntas + ' inteiras ' + inteiras)

console.log('\n4. A PERGUNTA FALHA SO NA PRIMEIRA VEZ, VERSAO DIFERENTE')
regrava((d) => { d.leads[0].obs = 'v3' }, 'cron:rastreio')
zera(); falhaVersao = 1
r = await le()
t(r.st === 200 && r.version === 3 && r.obs === 'v3', 'a repeticao viu a versao nova e a resposta e a v3', JSON.stringify(r))
t(perguntas === 2 && inteiras >= 1, 'pela leitura completa', 'perguntas ' + perguntas + ' inteiras ' + inteiras)

console.log('\n5. PERGUNTA E LEITURA COMPLETA FALHANDO: a ultima copia, sem 500')
regrava((d) => { d.leads[0].obs = 'v4 invisivel' }, 'cron:rastreio')
zera(); falhaVersao = 2; falhaInteiro = true
r = await le()
t(r.st === 200 && r.version === 3 && r.obs === 'v3', 'responde 200 com a ultima copia (v3), em vez de derrubar a tela', JSON.stringify(r))
t(perguntas === 2 && inteiras >= 1, 'depois de tentar as duas', 'perguntas ' + perguntas + ' inteiras ' + inteiras)
falhaInteiro = false; falhaVersao = 0

console.log('\n6. BANCO DE VOLTA')
zera()
r = await le()
t(r.st === 200 && r.version === 4 && r.obs === 'v4 invisivel', 'responde a v4 normalmente', JSON.stringify(r))
t(perguntas === 1 && inteiras >= 1, 'uma pergunta, versao diferente, leitura completa', 'perguntas ' + perguntas + ' inteiras ' + inteiras)
zera()
r = await le()
t(r.st === 200 && r.version === 4 && perguntas === 1 && inteiras === 0, 'e a seguinte, sem mudanca, sai da memoria (uma pergunta, zero leitura completa)', JSON.stringify(r) + ' perguntas ' + perguntas + ' inteiras ' + inteiras)

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
