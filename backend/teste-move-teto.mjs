// TETO DE 6 S NO CAMINHO LONGO DO ARRASTO (05/11/2026, ver handleMoveLead e handleUpdateLead no worker.js).
//
// O arrasto do pedido 1792845282163 ficou 20,5 s preso: 10 tentativas de ler e regravar o estado inteiro,
// todas perdidas pra rajada do cron, e so entao o 409 "Conflito ao salvar". O navegador nao tem tempo
// limite nesse POST, entao o Bruno esperou os 20 s olhando o card. Agora o laco desiste aos 6 s e responde
// 409 { ok: false, error, tente: true, ms } com um texto que explica e diz que da pra repetir.
//
// D1 de mentira: a leitura inteira demora 400 ms e TODO UPDATE do estado perde (outro gravador sobe a
// versao logo antes, como na rajada), com o pedido no ARQUIVO de leads (o caminho curto nao o ve, entao
// e o laco longo que roda). Prova: POST /api/lead/:id/move e POST /api/lead/:id { col } respondem 409 com
// tente em menos de 8 s, com menos leituras do que as 10 tentativas fariam, e o pedido continua onde estava.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-move-teto.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
if (!bundle) { console.error('uso: node teste-move-teto.mjs <dir>/worker.js'); process.exit(2) }
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
const ATRASO = 400   // ms por leitura do estado inteiro (na producao: 0,5 a 0,9 s de GRU a ENAM por 1,4 MB)
let leuInteiro = 0, perdeu = 0
const dorme = (ms) => new Promise((r) => setTimeout(r, ms))
const ehInteiro = (sql) => /^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)
const ehGrava = (sql) => /^\s*UPDATE dashboard_state\b/i.test(sql)
// a rajada: alguem grava o estado entre a leitura e a gravacao, TODA vez
const outroGravou = () => sq.prepare("UPDATE dashboard_state SET version = version + 1, updated_by = 'cron:outro' WHERE id = 1").run()
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { if (ehInteiro(sql)) { leuInteiro++; await dorme(ATRASO) } const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => { if (ehInteiro(sql)) { leuInteiro++; await dorme(ATRASO) } return { results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) } },
    run: async () => {
      if (ehGrava(sql)) { perdeu++; outroGravou() }
      const r = sq.prepare(sql).run(...args)
      return { meta: { changes: Number(r.changes) } }
    },
  }
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => {
    if ((l || []).some((s) => ehGrava(String(s.__sql || '')))) outroGravou()   // antes do lote inteiro: o arquivo tambem perde a trava de versao
    const out = []; for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run()); return out
  },
  exec: async (s) => sq.exec(s),
}
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor', null)
const TK = 'd'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK, 'dir', exp)
const estado = { tags: [], regras: { kits: [] }, team: [], leads: [{ id: '100', nome: 'Joao da Casa', col: 'Cobrança', at: 'vend_kevin', afl: '', hist: [] }] }
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
const arquivado = { id: '900', nome: 'Jardelino Arquivado', col: 'Pagos', spg: 'Pago', at: 'vend_kevin', afl: '', hist: [] }
sq.prepare('INSERT INTO leads_arquivo (id,json,col,ts) VALUES (?,?,?,?)').run('900', JSON.stringify(arquivado), 'Pagos', Math.floor(Date.now() / 1000) - 864000)

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-move-teto.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const post = async (url, body) => {
  const t0 = Date.now()
  const r = await worker.fetch(new Request('https://x' + url, { method: 'POST', headers: { authorization: 'Bearer ' + TK, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})), ms: Date.now() - t0 }
}
const noArquivo = (id) => { const r = sq.prepare('SELECT json, col FROM leads_arquivo WHERE id=?').get(String(id)); return r ? { ...JSON.parse(r.json), __col: r.col } : null }
const naLinha = (id) => (JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data).leads || []).find((l) => String(l.id) === String(id))
const TEXTO = 'O quadro estava sendo gravado por outra pessoa ou pelo sistema e a alteração não entrou. Nada mudou: tente de novo.'
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }
const confere = (r, rotulo) => {
  console.log('  (' + rotulo + ': ' + r.ms + ' ms de parede, ' + leuInteiro + ' leituras inteiras, ' + perdeu + ' gravacoes perdidas)')
  t(r.st === 409 && r.j.ok === false && r.j.tente === true, rotulo + ': responde 409 com tente: true', JSON.stringify(r.j))
  t(r.j.error === TEXTO, rotulo + ': com o texto que explica e manda arrastar de novo', JSON.stringify(r.j.error))
  t(Number(r.j.ms) >= 6000 && r.ms < 8000, rotulo + ': desistiu depois dos 6 s e respondeu em menos de 8 s (antes: 10 tentativas, 20 s)', 'ms=' + r.j.ms + ' parede=' + r.ms)
  t(perdeu >= 2 && perdeu < 10, rotulo + ': tentou mais de uma vez e menos de 10', String(perdeu))
  t(!naLinha('900') && noArquivo('900') && noArquivo('900').col === 'Pagos' && noArquivo('900').__col === 'Pagos' && JSON.stringify({ ...noArquivo('900'), __col: undefined }) === JSON.stringify({ ...arquivado, __col: undefined }), rotulo + ': o pedido continua exatamente onde estava', JSON.stringify(noArquivo('900')))
}

console.log('\nARRASTO (POST /api/lead/:id/move) com o estado sendo gravado por outro a toda hora')
let r = await post('/api/lead/900/move', { col: 'Frustrados' })
confere(r, 'move')

console.log('\nSALVAR COM COLUNA (POST /api/lead/:id) no mesmo cenario')
leuInteiro = 0; perdeu = 0
r = await post('/api/lead/900', { patch: { col: 'Frustrados' } })
confere(r, 'lead')

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
