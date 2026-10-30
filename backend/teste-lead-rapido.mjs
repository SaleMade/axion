// O SALVAR DO PEDIDO (POST /api/lead/:id) LE E GRAVA SO AQUELE PEDIDO (30/10/2026, ver _leadRapidoLe).
//
// Antes ele lia o estado inteiro (1,38 MB + o arquivo de leads), mexia num pedido e regravava tudo,
// com a trava na versao do estado inteiro: 1,7 s no meio do dia, pico de 18 s.
//
// O que este teste prova, na rota de verdade contra um D1 de mentira:
//  - pedido da linha, sem troca de coluna: NAO le o estado inteiro, e os OUTROS pedidos ficam byte
//    a byte iguais;
//  - pedido do ARQUIVO de leads: cai no caminho de sempre e grava;
//  - patch com `col`: caminho de sempre (a venda cancelada olha todos os pedidos), e grava o historico;
//  - outro pedido mudando no meio NAO derruba a gravacao; pedido novo entrando no TOPO (o indice
//    anda) faz a rota reler e gravar no pedido CERTO;
//  - os gates continuam: afiliado nao mexe em pedido da casa, vendedor nao troca dono, `antes`
//    diferente do banco recusa com 409, etiqueta fora do catalogo nao entra.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-lead-rapido.mjs <dir>/worker.js
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
const ehLeituraRapida = (sql) => /json_each\(json_extract\(s\.data, '\$\.leads'\)\)/.test(sql) && /AS regras/.test(sql)
function stmt(sql, args = []) {
  if (/^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)) leuInteiro++
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => {
      const r = sq.prepare(sql).get(...args)
      if (noMeio && ehLeituraRapida(sql)) { const f = noMeio; noMeio = null; f() }
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
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gio: 'e'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gio', 'gio']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)

const estado = {
  tags: [{ id: 't_vip', nome: 'VIP' }],
  tags__afl_3d767329: [{ id: 't_gio', nome: 'Do Giovane' }],
  regras: { kits: [] },
  team: [],
  leads: [
    { id: '100', nome: 'Joao da Casa', col: 'Cobrança', spg: 'Pendente', at: 'vend_kevin', afl: '', obs: '', comments: [{ who: 'dir', tx: 'ligar', time: '28/10 09:10' }], hist: [], tags: [] },
    { id: '200', nome: 'Maria do Afiliado', col: 'Cobrança', at: 'gio', afl: 'afl_3d767329', obs: '', hist: [], tags: [] },
    { id: '300', nome: 'Pedro Outro', col: 'Enviado', at: 'vend_kevin', afl: '', obs: 'nada', hist: [] },
  ],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
sq.prepare('INSERT INTO leads_arquivo (id,json,col,ts) VALUES (?,?,?,?)').run('900',
  JSON.stringify({ id: '900', nome: 'Jardelino Arquivado', col: 'Pagos', at: 'vend_kevin', afl: '', obs: '', hist: [] }), 'Pagos', Math.floor(Date.now() / 1000) - 864000)

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-lead-rapido.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const salva = async (tk, id, patch) => {
  const r = await worker.fetch(new Request('https://x/api/lead/' + id, { method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify({ patch }) }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const linha = () => sq.prepare('SELECT data, version, updated_by FROM dashboard_state WHERE id=1').get()
const naLinha = (id) => (JSON.parse(linha().data).leads || []).find((l) => String(l.id) === String(id))
const noArquivo = (id) => { const r = sq.prepare('SELECT json FROM leads_arquivo WHERE id=?').get(String(id)); return r ? JSON.parse(r.json) : null }
const ondeFor = (id) => naLinha(id) || noArquivo(id)
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }

console.log('\nCAMINHO CURTO')
let antes = JSON.stringify([naLinha('200'), naLinha('300')])
let v0 = linha().version
leuInteiro = 0
let r = await salva(TK.dir, '100', { obs: 'cliente pediu boleto novo', end: 'Rua A, 10' })
t(r.st === 200 && r.j.ok === true, 'salvar obs/endereco do pedido da linha responde 200', JSON.stringify(r.j))
t(naLinha('100').obs === 'cliente pediu boleto novo' && naLinha('100').end === 'Rua A, 10', 'o pedido gravou')
t(leuInteiro === 0, 'e NAO leu o estado inteiro', 'leituras inteiras: ' + leuInteiro)
t(JSON.stringify([naLinha('200'), naLinha('300')]) === antes, 'os outros pedidos ficaram byte a byte iguais')
t(linha().version === v0 + 1 && r.j.version === v0 + 1, 'a versao subiu 1 e a resposta traz a nova', linha().version + ' / ' + r.j.version)
t(linha().updated_by === 'kanban:dir', 'updated_by diz quem gravou', linha().updated_by)
t(Array.isArray(naLinha('100').comments) && naLinha('100').comments.length === 1, 'os comentarios do pedido continuam la')

console.log('\nPEDIDO DO ARQUIVO E TROCA DE COLUNA (caminho de sempre)')
leuInteiro = 0
r = await salva(TK.dir, '900', { obs: 'conferido depois de arquivado' })
t(r.st === 200 && ondeFor('900') && ondeFor('900').obs === 'conferido depois de arquivado', 'pedido do arquivo: grava pelo caminho de sempre', JSON.stringify(r.j))
t(leuInteiro >= 1, 'e usou o caminho de sempre (leu o estado inteiro)', String(leuInteiro))
leuInteiro = 0
r = await salva(TK.dir, '300', { col: 'Rota de Entrega' })
t(r.st === 200 && naLinha('300').col === 'Rota de Entrega', 'troca de coluna grava', JSON.stringify(r.j))
t(leuInteiro >= 1, 'troca de coluna vai pelo caminho de sempre (venda cancelada olha todos os pedidos)', String(leuInteiro))
t((naLinha('300').hist || []).some((h) => h.to === 'Rota de Entrega'), 'e o historico da troca entrou')

console.log('\nCONCORRENCIA')
noMeio = () => {
  const d = JSON.parse(linha().data); d.leads.find((l) => l.id === '300').obs = 'mexido no meio'
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_by=? WHERE id=1').run(JSON.stringify(d), 'kanban:outro')
}
r = await salva(TK.dir, '100', { obs: 'segunda anotacao' })
t(r.st === 200 && naLinha('100').obs === 'segunda anotacao', 'outro pedido mudando no meio NAO derruba a gravacao')
t(naLinha('300').obs === 'mexido no meio', 'e a mudanca do outro pedido feita no meio ficou')
noMeio = () => {
  const d = JSON.parse(linha().data); d.leads.unshift({ id: '400', nome: 'Pedido Novo da Captura', col: 'A Enviar', afl: '', hist: [] })
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_by=? WHERE id=1').run(JSON.stringify(d), 'captura')
}
r = await salva(TK.dir, '100', { obs: 'terceira, com pedido novo no topo' })
t(r.st === 200 && naLinha('100').obs === 'terceira, com pedido novo no topo', 'pedido novo entrando no topo: rele e grava no pedido certo', JSON.stringify(r.j))
t(naLinha('400') && !naLinha('400').obs, 'o pedido novo da captura nao foi atropelado', JSON.stringify(naLinha('400')))
t(JSON.parse(linha().data).leads.length === 4, 'nenhum pedido sumiu nem duplicou', String(JSON.parse(linha().data).leads.length))

console.log('\nGATES')
r = await salva(TK.gio, '100', { obs: 'afiliado tentando' })
t(r.st === 404 && naLinha('100').obs === 'terceira, com pedido novo no topo', 'afiliado NAO mexe em pedido da casa (404)', JSON.stringify(r))
r = await salva(TK.gio, '200', { obs: 'do mundo dele', tags: ['t_gio', 't_vip', 't_inventada'] })
t(r.st === 200 && naLinha('200').obs === 'do mundo dele', 'afiliado mexe no pedido dele', JSON.stringify(r.j))
t(JSON.stringify(naLinha('200').tags) === JSON.stringify(['t_gio', 't_vip']), 'etiqueta fora do catalogo nao entra (o catalogo dele + o da casa)', JSON.stringify(naLinha('200').tags))
r = await salva(TK.kevin, '100', { at: 'gio', obs: 'vendedor anotou' })
t(r.st === 200 && naLinha('100').at === 'vend_kevin' && naLinha('100').obs === 'vendedor anotou', 'vendedor anota mas NAO troca o dono', JSON.stringify(naLinha('100').at))
r = await salva(TK.dir, '100', { obs: 'nao pode gravar', antes: { spg: 'Pago' } })
t(r.st === 409 && r.j.mudou === true && naLinha('100').obs === 'vendedor anotou', '`antes` diferente do banco recusa com 409 e nao grava', JSON.stringify(r))
r = await salva(TK.dir, '100', { spg: 'Pago', valor_neg: 297 })
t(r.st === 200 && naLinha('100').spg === 'Pago' && naLinha('100').col === 'Pagos', 'marcar pago sem coluna leva o card pra Pagos (regra de 17/10 continua)', JSON.stringify({ spg: naLinha('100').spg, col: naLinha('100').col }))
t(Number(naLinha('100').pago_ts) > 0, 'e carimba a data do pagamento', String(naLinha('100').pago_ts))

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
