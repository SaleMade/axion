// O COMENTARIO QUE A TELA MOSTRA TEM QUE SER O DO BANCO (30/10/2026).
//
// Queixa do time, trazida pelo Bruno: "estao escrevendo comentarios, clicando em salvar e, quando
// fecham e vao para outro lugar e depois voltam para aquele lead, nao aparece. Demora demais ou
// simplesmente nao aparece mais."
//
// Medido na producao em 30/10, pela rota de verdade e com a conta que reclamou: o comentario GRAVA
// nos dois caminhos (curto 684 ms, e 2,1 s no pedido que mora no arquivo de leads) e volta na
// leitura seguinte. Ou seja, o que envelhecia era a LISTA QUE A TELA TINHA NA MAO - a copia do
// estado que o quadro baixou. Dois consertos nasceram disso, e sao eles que este teste guarda:
//
//  1) GET /api/lead/<id>/comments: a tela PERGUNTA a lista ao servidor ao abrir o pedido, em vez de
//     confiar na copia. Barata (nao baixa 1,4 MB de estado) e olha nos DOIS lugares onde o pedido
//     pode morar: a linha do estado e a tabela leads_arquivo.
//  2) `patch.comments` passou a SOMAR em vez de substituir. A lista inteira ainda e aceita (cliente
//     antigo manda assim), e como substituicao ela apagava, em silencio, todo comentario escrito
//     depois da copia que aquela aba tinha. Aba presa em bundle velho e justamente o que o cache
//     envenenado deixou por ai.
//
// E o que NAO pode afrouxar junto: o corte de mundo (afiliado nao le nem escreve comentario em
// pedido da casa) e a contagem que a resposta devolve, que e como a tela descobre que divergiu.
//
// Roda a ROTA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-coment-servidor.mjs <dir>/worker.js
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
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
// O LOTE TEM QUE DEVOLVER LINHA PRA SELECT. O caminho curto poe a conferencia e o registro no MESMO
// lote (uma ida ao banco em vez de duas); um batch de mentira que respondesse `changes` pra tudo
// faria a conferencia voltar vazia, a funcao passar a vez e o teste medir o caminho ERRADO sem
// ninguem notar.
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => {
    const out = []
    for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run())
    return out
  },
  exec: async (s) => sq.exec(s),
}
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, afl) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl || null)
user('dir', 'dir', 'Diretor', 'diretor')
user('vend_kevin', 'kevin', 'Kevin', 'atendente')
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
user('zumbi', 'zumbi', 'Sem Vinculo', 'afiliado', null)
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gio: 'e'.repeat(64), zumbi: 'f'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gio', 'gio'], ['zumbi', 'zumbi']]) {
  sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)
}

const C_ANTIGO = { who: 'atendente_k1s0gl', tx: 'cliente pediu pra ligar amanha', time: '28/10 09:10' }
const C_ARQ1 = { who: 'dir', tx: 'pago no pix', time: '20/10 11:00' }
const C_ARQ2 = { who: 'atendente_k1s0gl', tx: 'comprovante conferido', time: '20/10 11:05' }

// 100 = pedido da casa, na LINHA.  200 = pedido do mundo do afiliado.  900 = pedido no ARQUIVO.
const estado = {
  tags: [],
  team: [],
  leads: [
    { id: '100', nome: 'Joao da Casa', col: 'Cobranca', at: 'vend_kevin', afl: '', comments: [C_ANTIGO], hist: [] },
    { id: '200', nome: 'Maria do Afiliado', col: 'Cobranca', at: 'gio', afl: 'afl_3d767329', comments: [{ who: 'gio', tx: 'do mundo dele', time: '27/10 08:00' }], hist: [] },
  ],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
sq.prepare('INSERT INTO leads_arquivo (id,json,col,ts) VALUES (?,?,?,?)').run('900',
  JSON.stringify({ id: '900', nome: 'Jardelino Arquivado', col: 'Pagos', at: 'vend_kevin', afl: '', comments: [C_ARQ2, C_ARQ1], hist: [] }),
  'Pagos', Math.floor(Date.now() / 1000) - 864000)

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-coment-servidor.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }

const get = async (tk, rota) => {
  const r = await worker.fetch(new Request('https://x' + rota, { headers: { authorization: 'Bearer ' + tk } }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const post = async (tk, rota, corpo) => {
  const r = await worker.fetch(new Request('https://x' + rota, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const coments = (tk, id) => get(tk, '/api/lead/' + id + '/comments')
const salva = (tk, id, patch) => post(tk, '/api/lead/' + id, { patch })
const logs = () => sq.prepare('SELECT quem, lead, via, depois FROM coment_log ORDER BY id').all().map((r) => ({ ...r }))

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nA TELA PERGUNTA A LISTA AO SERVIDOR (o conserto de hoje)')
let r = await coments(TK.dir, '100')
t(r.st === 200 && r.j.n === 1 && r.j.comentarios[0].tx === C_ANTIGO.tx,
  'pedido da LINHA: devolve a lista do banco', JSON.stringify(r).slice(0, 200))
r = await coments(TK.dir, '900')
t(r.st === 200 && r.j.n === 2 && r.j.comentarios[0].tx === C_ARQ2.tx,
  'pedido do ARQUIVO de leads: devolve a lista dele tambem (e o caso do pedido ja pago)', JSON.stringify(r).slice(0, 200))
r = await coments(TK.kevin, '100')
t(r.st === 200 && r.j.n === 1, 'quem atende tambem le (anotar comentario sempre foi livre pra quem esta logado)', JSON.stringify(r).slice(0, 120))
r = await coments(TK.dir, '777')
t(r.st === 404, 'pedido que nao existe em lugar nenhum: 404, nao lista vazia fingindo que existe', JSON.stringify(r))

console.log('\nO CORTE DE MUNDO CONTINUA DE PE')
r = await coments(TK.gio, '100')
t(r.st === 404, 'o afiliado NAO le comentario de pedido da casa', JSON.stringify(r))
r = await coments(TK.gio, '200')
t(r.st === 200 && r.j.n === 1, 'mas le o do mundo dele', JSON.stringify(r).slice(0, 120))
r = await coments(TK.zumbi, '200')
t(r.st === 404, 'afiliado sem vinculo nao le nada', JSON.stringify(r))
r = await coments('0'.repeat(64), '100')
t(r.st === 401, 'sem sessao valida, 401', JSON.stringify(r))

console.log('\nESCREVE E LE DE VOLTA, NOS DOIS CAMINHOS')
r = await salva(TK.kevin, '100', { comment_add: { who: 'vend_kevin', tx: 'liguei agora, atendeu', time: '30/10 14:00' } })
t(r.st === 200 && r.j.comentarios === 2, 'caminho curto: salva e DIZ com quantos comentarios o pedido ficou', JSON.stringify(r))
r = await coments(TK.kevin, '100')
t(r.st === 200 && r.j.n === 2 && r.j.comentarios[0].tx === 'liguei agora, atendeu',
  'e a lista do servidor ja vem com ele na frente', JSON.stringify(r.j.comentarios || []).slice(0, 200))
r = await salva(TK.dir, '900', { comment_add: { who: 'dir', tx: 'conferido no extrato', time: '30/10 14:05' } })
t(r.st === 200 && r.j.comentarios === 3, 'pedido do ARQUIVO (caminho lento) tambem devolve a contagem', JSON.stringify(r))
r = await coments(TK.dir, '900')
t(r.st === 200 && r.j.n === 3 && r.j.comentarios[0].tx === 'conferido no extrato',
  'e o comentario esta la quando a tela pergunta', JSON.stringify(r.j.comentarios || []).slice(0, 220))

console.log('\nABA VELHA NAO APAGA COMENTARIO (a lista inteira SOMA, nao substitui)')
// A aba velha tem a copia de ontem: so o comentario antigo. Ela salva o endereco e manda a lista
// inteira junto, como as telas faziam ate 12/10.
r = await salva(TK.dir, '100', { comments: [C_ANTIGO], obs: 'endereco confirmado' })
t(r.st === 200, 'a aba velha consegue salvar o campo dela', JSON.stringify(r))
r = await coments(TK.dir, '100')
t(r.j.n === 2 && (r.j.comentarios || []).some((c) => c.tx === 'liguei agora, atendeu'),
  'o comentario escrito DEPOIS da copia dela sobreviveu (era isto que sumia em silencio)', JSON.stringify((r.j.comentarios || []).map((c) => c.tx)))
r = await salva(TK.dir, '100', { comments: [{ who: 'aba_velha', tx: 'escrito na aba velha', time: '29/10 22:00' }] })
t(r.st === 200 && r.j.comentarios === 3, 'e o que a lista dela tem de NOVO entra', JSON.stringify(r))
r = await coments(TK.dir, '100')
t(r.j.n === 3 && (r.j.comentarios || []).some((c) => c.tx === 'escrito na aba velha') && (r.j.comentarios || []).some((c) => c.tx === C_ANTIGO.tx),
  'sem apagar nada do que ja havia', JSON.stringify((r.j.comentarios || []).map((c) => c.tx)))
// repetir a MESMA lista nao pode duplicar
const antesRep = (await coments(TK.dir, '100')).j.n
await salva(TK.dir, '100', { comments: [{ who: 'aba_velha', tx: 'escrito na aba velha', time: '29/10 22:00' }] })
t((await coments(TK.dir, '100')).j.n === antesRep, 'mandar a mesma lista de novo nao duplica comentario')

console.log('\nAPAGAR CONTINUA EXISTINDO, MAS DIZENDO QUAL')
r = await salva(TK.dir, '100', { comment_del: { time: '29/10 22:00', who: 'aba_velha' } })
t(r.st === 200 && r.j.comentarios === 2, 'o comment_del tira aquele comentario (e so aquele)', JSON.stringify(r))
t(!((await coments(TK.dir, '100')).j.comentarios || []).some((c) => c.tx === 'escrito na aba velha'), 'e ele sai da lista do servidor de verdade')

console.log('\nO AFILIADO NAO ESCREVE EM PEDIDO DA CASA (nao afrouxou)')
r = await salva(TK.gio, '100', { comment_add: { who: 'gio', tx: 'nao devia entrar', time: '30/10 15:00' } })
t(r.st === 404, 'gravacao de comentario de outro mundo continua 404', JSON.stringify(r))
t(!((await coments(TK.dir, '100')).j.comentarios || []).some((c) => c.tx === 'nao devia entrar'), 'e nada foi gravado')

console.log('\nO REGISTRO DURAVEL (pra proxima queixa ser respondida com dado, nao com teoria)')
const L = logs()
t(L.length >= 4, 'cada gravacao de comentario deixou uma linha no coment_log (deu: ' + L.length + ')')
t(L.some((x) => x.quem === 'vend_kevin' && x.lead === '100' && x.via === 'curto' && x.depois === 2),
  'a linha diz quem, qual pedido, por qual caminho e com quantos ficou', JSON.stringify(L.slice(0, 3)))
t(L.some((x) => x.lead === '900' && x.via === 'lento' && x.depois === 3),
  'e o caminho lento (pedido no arquivo) tambem e registrado', JSON.stringify(L.filter((x) => x.lead === '900')))
t(!L.some((x) => x.quem === 'gio'), 'o que foi RECUSADO nao vira registro de gravacao', JSON.stringify(L.filter((x) => x.quem === 'gio')))

console.log('\n' + ok + ' conferencias ok, ' + mau + ' falha(s)')
process.exit(mau ? 1 : 0)
