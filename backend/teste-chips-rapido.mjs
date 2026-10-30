// AS ROTAS DE CHIP GRAVAM SO A LISTA DE CHIPS (30/10/2026, ver _chipsLe/_chipsGrava no worker.js).
//
// Antes: salvar/cadastrar/ordenar/excluir chip lia o estado inteiro (1,38 MB com os pedidos) e
// regravava tudo, com a trava na versao do estado inteiro. Mover um chip levava 3,7 s e qualquer
// gravacao do cron no meio derrubava a tentativa.
//
// O que este teste prova, na rota de verdade contra um D1 de mentira:
//  1) gravar chip NAO reescreve os pedidos nem as chaves do envelope do arquivo (_arq/_fim);
//  2) uma gravacao em OUTRA parte do estado entre a leitura e a gravacao do chip NAO derruba o chip;
//  3) outra gravacao DE CHIP no meio derruba, a rota rele e refaz, e as DUAS mudancas ficam;
//  4) a versao sobe, entao quem grava o estado inteiro com a versao velha perde e rele;
//  5) cadastrar, ordem da fila e excluir continuam funcionando, e o nextChip anda.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-chips-rapido.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
// Gancho: roda UMA vez, logo depois da proxima leitura da lista de chips (simula outra gravacao no meio).
let noMeio = null
let leuInteiro = 0   // quantas vezes alguem leu o estado INTEIRO (SELECT data ...), que e o que a rota nao pode mais fazer
function stmt(sql, args = []) {
  if (/^\s*SELECT data[^]*FROM dashboard_state/i.test(sql)) leuInteiro++
  return {
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => {
      const r = sq.prepare(sql).get(...args)
      if (noMeio && /json_extract\(data, '\$\.chips'\) AS chips/.test(sql)) { const f = noMeio; noMeio = null; f() }
      return r ? (col ? r[col] : { ...r }) : null
    },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor')
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_kevin', 'kevin', 'x', 'Kevin', 'KE', 'atendente')
const TK = 'd'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK, 'dir', exp)

const LEADS = [{ id: 1791981322120, nome: 'Fulano', col: 'Pagos', hist: [{ from: 'A Enviar', to: 'Pagos' }], comments: [{ who: 'dir', tx: 'ok' }] }, { id: 1791981322121, nome: 'Ciclano', col: 'Cobrança' }]
const estado = {
  _arq: 3,
  wa_statuses: [{ id: 'st_aq', label: 'Em Aquecimento', papel: 'aquecimento' }, { id: 'st_at', label: 'Ativo', papel: 'ativo' }, { id: 'st_em', label: 'Em Uso', papel: 'em_uso' }],
  chips: [
    { id: 128, idx: 66, num: '(49) 98894-8922', at: '', st: 'aquecimento', wa_st: 'st_aq' },
    { id: 129, idx: 67, num: '(49) 98890-8842', at: '', st: 'aquecimento', wa_st: 'st_aq' },
    { id: 118, idx: 62, num: '(15) 99797-3450', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true, dist: 'limite', lim_ordem: 1 },
    { id: 119, idx: 63, num: '(15) 99187-2193', at: 'vend_kevin', st: 'ativo', wa_st: 'st_at', dist: 'limite', lim_ordem: 2 },
  ],
  nextChip: 131,
  pressels: [], leads: LEADS, _fim: 1,
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,100)').run(JSON.stringify(estado))
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
// A tabela do arquivo de leads existe na producao; o caminho antigo (estado inteiro) passa por ela.
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-chips-rapido.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const post = async (rota, corpo) => {
  const r = await worker.fetch(new Request('https://x' + rota, { method: 'POST', headers: { authorization: 'Bearer ' + TK, 'content-type': 'application/json' }, body: JSON.stringify(corpo) }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const linha = () => sq.prepare('SELECT data, version, updated_by FROM dashboard_state WHERE id=1').get()
const estadoAgora = () => JSON.parse(linha().data)
const chipAgora = (id) => estadoAgora().chips.find((c) => c.id === id)
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }

// 1) salvar chip nao reescreve pedidos nem o envelope
const leadsAntes = JSON.stringify(estadoAgora().leads)
let r = await post('/api/chip/save', { id: 128, patch: { at: '', st: 'ativo', wa_st: 'st_at', em_uso: false, bkp: false } })
let e = estadoAgora()
t(r.st === 200 && r.j.chip && r.j.chip.wa_st === 'st_at' && r.j.chip.st === 'ativo', 'salvar chip responde 200 com o chip novo', JSON.stringify(r.j).slice(0, 160))
t(chipAgora(128).wa_st === 'st_at' && chipAgora(128).st === 'ativo', 'o chip mudou no estado')
t(JSON.stringify(e.leads) === leadsAntes, 'os pedidos ficaram byte a byte iguais')
t(e._arq === 3 && e._fim === 1, 'o envelope do arquivo (_arq/_fim) continua la')
t(linha().version === 101 && r.j.version === 101, 'a versao subiu 1 e a resposta traz a versao nova', linha().version + ' / ' + r.j.version)
t(linha().updated_by === 'chip:dir', 'updated_by diz quem gravou', linha().updated_by)
t(e.chips.length === 4 && e.chips[0].id === 128, 'a ordem da lista de chips nao mudou')

// 2) gravacao em OUTRA parte do estado no meio NAO derruba o chip
noMeio = () => {
  const d = JSON.parse(linha().data); d.leads[1].col = 'Pagos'
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_by=? WHERE id=1').run(JSON.stringify(d), 'kanban:x')
}
r = await post('/api/chip/save', { id: 129, patch: { at: '', st: 'ativo', wa_st: 'st_at' } })
e = estadoAgora()
t(r.st === 200 && chipAgora(129).wa_st === 'st_at', 'o chip gravou mesmo com um pedido mudando no meio')
t(e.leads[1].col === 'Pagos', 'e a mudanca do pedido feita no meio FICOU (nao foi atropelada)')
t(linha().version === 103, 'versao: +1 do pedido, +1 do chip', String(linha().version))

// 3) outra gravacao DE CHIP no meio: rele, refaz, e as duas ficam
noMeio = () => {
  const d = JSON.parse(linha().data); d.chips.find((c) => c.id === 119).note = 'anotado no meio'
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_by=? WHERE id=1').run(JSON.stringify(d), 'chip:outro')
}
r = await post('/api/chip/save', { id: 118, patch: { note: 'minha nota' } })
t(r.st === 200 && chipAgora(118).note === 'minha nota', 'o chip gravou depois de reler')
t(chipAgora(119).note === 'anotado no meio', 'e a gravacao de chip que passou na frente nao se perdeu')

// 4) quem grava o estado inteiro com a versao velha perde
const vVelha = linha().version
await post('/api/chip/save', { id: 118, patch: { note: 'mais uma' } })
const perdeu = sq.prepare('UPDATE dashboard_state SET data=?, version=? WHERE id=1 AND version=?').run('{}', vVelha + 1, vVelha)
t(Number(perdeu.changes) === 0 && chipAgora(118).note === 'mais uma', 'gravacao do estado inteiro com a versao velha nao pega')

// 5) cadastrar, ordem e excluir
const leuAntes = leuInteiro
r = await post('/api/chip/create', { chip: { num: '(49) 98893-1497' } })
e = estadoAgora()
t(r.st === 200 && r.j.chip && r.j.chip.id === 131 && r.j.chip.idx === 68, 'cadastrar: id 131 e Nº 68 (maior da casa + 1)', JSON.stringify(r.j.chip && { id: r.j.chip.id, idx: r.j.chip.idx }))
t(e.nextChip === 132 && e.chips[0].id === 131, 'cadastrar: nextChip andou e o chip novo entrou no topo da lista', e.nextChip + ' / ' + e.chips[0].id)
t(JSON.stringify(e.leads[0]) === JSON.stringify(LEADS[0]), 'cadastrar: o pedido intocado continua igual')
r = await post('/api/chip/ordem', { ids: ['119', '118'] })
t(r.st === 200 && r.j.mudou === 2 && chipAgora(119).lim_ordem === 1 && chipAgora(118).lim_ordem === 2, 'ordem da fila: trocou as posicoes', JSON.stringify(r.j))
r = await post('/api/chip/delete', { id: 131 })
e = estadoAgora()
t(r.st === 200 && !e.chips.some((c) => c.id === 131) && e.chips.length === 4, 'excluir: o chip saiu da lista')
t(e._arq === 3 && e._fim === 1 && e.leads.length === 2, 'no fim, envelope e pedidos inteiros')
t(leuInteiro === 0, 'NENHUMA rota de chip leu o estado inteiro (o que fazia mover um chip levar 3,7 s)', 'leituras inteiras: ' + leuInteiro + ' (cadastro/ordem/exclusao: ' + (leuInteiro - leuAntes) + ')')

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
