// PEDIDO QUE A PAYLOG NAO LIBEROU (13/11/2026).
//
// O caso: 14 pedidos do Ceara ficaram parados em "Cadastrado" no AfterPayLog de 18/10 a 13/11 (a
// cotacao de frete falhou e a aprovacao automatica nunca rodou). Ninguem viu ate o cliente reclamar.
// A vigia pergunta a PayLog o status de cada pedido sem envio e guarda os parados ha mais de 1 hora;
// a direcao recebe UM aviso por pedido novo na lista; as Aceitacoes leem pelo GET.
//
// Este teste recorta do worker.js as tres funcoes de verdade e roda com um SQLite em memoria e uma
// PayLog falsa.
//
//   node teste-pl-nao-liberados.mjs
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const recorta = (inicio) => {
  const i = src.indexOf(inicio)
  if (i < 0) throw new Error('nao achei ' + inicio)
  const fim = src.indexOf('\n}\n', i)
  return src.slice(i, fim + 3)
}
const codigo = [
  /const _PL_NAO_LIB_ESPERA_S = [^\n]*\n/.exec(src)[0],
  recorta('async function _plVigiaNaoLiberados('),
  recorta('async function _plAvisaNaoLiberados('),
  recorta('async function handlePaylogNaoLiberados('),
].join('\n')

let ok = 0, ruim = 0
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome) } else { ruim += 1; console.log('  RUIM ' + nome + (detalhe !== undefined ? '  ->  ' + detalhe : '')) }
}

// ── D1 de mentira em cima do SQLite ──
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE five_orders (order_id TEXT PRIMARY KEY, shipping_status TEXT, shipping_code TEXT, charge_status TEXT, last_status TEXT, created_at INTEGER);
         CREATE TABLE push_avisos (chave TEXT PRIMARY KEY, ts INTEGER);
         CREATE TABLE app_config (k TEXT PRIMARY KEY, v TEXT);`)
const DB = {
  prepare(sql) {
    let args = []
    const st = () => db.prepare(sql)
    const o = {
      bind(...a) { args = a; return o },
      async all() { return { results: st().all(...args) } },
      async first() { return st().get(...args) || null },
      async run() { const r = st().run(...args); return { meta: { changes: Number(r.changes) } } },
    }
    return o
  },
}
const env = { DB }

// ── PayLog falsa ──
const agora = Math.floor(Date.now() / 1000)
const iso = (s) => new Date(s * 1000).toISOString()
let pl = {}            // code -> { status, criado, nome }
let falhaEm = ''       // code que faz a consulta falhar
let chamadas = 0
const _plApi = async (_env, caminho, mundo) => {
  chamadas++
  if (mundo) return { erro: 'mundo errado' }
  const code = decodeURIComponent(/search=([^&]+)/.exec(caminho)[1])
  if (code === falhaEm) return { erro: 'http 500' }
  const p = pl[code]
  const data = p ? [{ code, platform_status: { value: p.status }, created_at: iso(p.criado), client: { name: p.nome } }] : []
  return { ok: true, dados: { data } }
}
const avisos = []
const stubs = {
  _ehDashDaCasa: () => true,
  _plMundoPronto: async () => ({ ok: true }),
  _plApi,
  _readConfig: async (_e, k) => { const r = db.prepare('SELECT v FROM app_config WHERE k = ?').get(k); return r ? r.v : null },
  _writeConfig: async (_e, k, v) => { db.prepare('INSERT INTO app_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v) },
  _ensurePushTables: async () => {},
  _wpChaves: async () => true,
  _wpApoio: async () => ({ diretoresDaCasa: ['dir_bruno', 'dir_heynan'] }),
  _wpParaPessoa: async (_e, id, payload) => { avisos.push({ id, ...payload }); return 1 },
  isDirector: (u) => u && u.role === 'diretor',
  authUser: async (req) => req.__user || null,
  json: (o) => o,
  err: (m, s) => ({ erro: m, status: s }),
}
const fabrica = new Function(...Object.keys(stubs), codigo + '\nreturn { _plVigiaNaoLiberados, handlePaylogNaoLiberados };')
const { _plVigiaNaoLiberados, handlePaylogNaoLiberados } = fabrica(...Object.values(stubs))
const pede = (user, q = '') => handlePaylogNaoLiberados({ url: 'https://x/api/paylog/nao-liberados' + q, __user: user }, env)
const DIR = { id: 'dir_bruno', role: 'diretor' }
const VEND = { id: 'atendente_x', role: 'atendente' }
const AFL = { id: 'afiliado_y', role: 'afiliado', afiliado_id: 'afl_1' }

// ── o cenario ──
const poe = (id, c) => db.prepare('INSERT INTO five_orders VALUES (?,?,?,?,?,?)').run(id, c.sh ?? null, c.sc ?? null, c.ch ?? null, c.ls ?? 'Pedido Cadastrado', c.criado ?? agora - 5 * 3600)
poe('PL-ORDPARADO1', { criado: agora - 26 * 86400 })                 // o caso do Antonio: 26 dias parado
poe('PL-ORDPARADO2', { criado: agora - 3 * 3600, ls: 'Cadastrado' })  // rotulo da varredura, sem "Pedido"
poe('PL-ORDAPROVADO', {})                                              // aprovado, ainda sem etiqueta
poe('PL-ORDNOVINHO', { criado: agora - 600 })                          // 10 minutos: ainda pode aprovar sozinho
poe('PL-ORDENVIADO', { sc: 'AB123BR', sh: 'IN_TRANSIT', ls: 'Pedido Em Trânsito' })
poe('PL-ORDCANCEL', { ch: 'CANCELED', ls: 'Pedido Cancelado sem Custo' })
poe('PL-ORDVELHO', { criado: agora - 70 * 86400 })                     // fora da janela de 60 dias
poe('MAN-123', {})                                                     // nao e da PayLog
pl = {
  ORDPARADO1: { status: 'cadastrado', criado: agora - 26 * 86400, nome: 'Antonio Cesar Bentes' },
  ORDPARADO2: { status: 'cadastrado', criado: agora - 3 * 3600, nome: 'Maria Lucineide' },
  ORDAPROVADO: { status: 'aprovado', criado: agora - 5 * 3600, nome: 'Raimundo X' },
  ORDNOVINHO: { status: 'cadastrado', criado: agora - 600, nome: 'Joao Y' },
  ORDENVIADO: { status: 'em_transito', criado: agora - 5 * 3600, nome: 'Z' },
  ORDCANCEL: { status: 'cadastrado', criado: agora - 5 * 3600, nome: 'W' },
  ORDVELHO: { status: 'cadastrado', criado: agora - 70 * 86400, nome: 'V' },
}

console.log('\nvigia:')
let r = await _plVigiaNaoLiberados(env)
const codigos = (x) => (x.itens || []).map((i) => i.code).join(',')
conta('acha os dois parados, do mais velho pro mais novo', r.ok && codigos(r) === 'ORDPARADO1,ORDPARADO2', JSON.stringify(r))
conta('aprovado sem etiqueta NAO entra', !codigos(r).includes('ORDAPROVADO'))
conta('criado ha 10 minutos ainda nao entra (a aprovacao automatica leva 5)', !codigos(r).includes('ORDNOVINHO'))
conta('so pergunta a PayLog de quem esta sem envio, sem cancelar e dentro de 60 dias (4 de 8)', r.conferidos === 4 && chamadas === 4, 'conferidos=' + r.conferidos + ' chamadas=' + chamadas)
conta('a lista guardada nao leva nome de cliente', !/Antonio|Maria/.test(db.prepare("SELECT v FROM app_config WHERE k='pl_nao_lib'").get().v))
conta('UM aviso pra cada diretor, dizendo quantos', avisos.length === 2 && avisos.every((a) => a.title === 'PayLog não liberou 2 pedidos'), JSON.stringify(avisos))
conta('o aviso abre as Aceitacoes', avisos[0].url === '/pressels/aceitacoes')

console.log('\nsegunda vigia, nada novo:')
avisos.length = 0
r = await _plVigiaNaoLiberados(env)
conta('mesma lista', codigos(r) === 'ORDPARADO1,ORDPARADO2')
conta('nao avisa de novo', avisos.length === 0, JSON.stringify(avisos))

console.log('\nentra um parado novo:')
pl.ORDNOVINHO.criado = agora - 2 * 3600
r = await _plVigiaNaoLiberados(env)
conta('ele entra na lista', codigos(r).includes('ORDNOVINHO'))
conta('o aviso e so dele, com o nome', avisos.length === 2 && avisos[0].title === 'PayLog não liberou um pedido' && /^Joao Y está parado em Cadastrado/.test(avisos[0].body), JSON.stringify(avisos[0]))

console.log('\nconsulta que falha no meio:')
falhaEm = 'ORDPARADO2'
const antes = db.prepare("SELECT v FROM app_config WHERE k='pl_nao_lib'").get().v
pl.ORDPARADO1.status = 'aprovado'
r = await _plVigiaNaoLiberados(env)
conta('devolve erro', r.ok === false)
conta('a lista velha fica como estava (lista pela metade apagaria aviso de verdade)', db.prepare("SELECT v FROM app_config WHERE k='pl_nao_lib'").get().v === antes)
falhaEm = ''
pl.ORDPARADO1.status = 'cadastrado'

console.log('\nGET das Aceitacoes:')
let g = await pede(DIR)
conta('o diretor ve os tres', codigos(g) === 'ORDPARADO1,ORDPARADO2,ORDNOVINHO', JSON.stringify(g))
g = await pede(VEND)
conta('quem esta logado ve a lista (so codigo e data)', codigos(g) === 'ORDPARADO1,ORDPARADO2,ORDNOVINHO' && Object.keys(g.itens[0]).sort().join() === 'code,criado')
g = await pede(AFL)
conta('o afiliado nao ve a lista da casa', g.itens.length === 0)
g = await pede(null)
conta('sem login: 401', g.status === 401)
// a pessoa clicou em Aprovar no painel: o webhook 'aprovado' grava o last_status
db.prepare("UPDATE five_orders SET last_status = 'Pedido Aprovado' WHERE order_id = 'PL-ORDPARADO1'").run()
g = await pede(DIR)
conta('aprovado depois da vigia sai na hora, sem esperar meia hora', codigos(g) === 'ORDPARADO2,ORDNOVINHO', codigos(g))
db.prepare("UPDATE five_orders SET charge_status = 'CANCELED' WHERE order_id = 'PL-ORDPARADO2'").run()
g = await pede(DIR)
conta('cancelado depois da vigia sai na hora', codigos(g) === 'ORDNOVINHO', codigos(g))

console.log('\natualizar=1:')
pl.ORDPARADO1.status = 'aprovado'
avisos.length = 0
const ch0 = chamadas
await pede(VEND, '?atualizar=1')
conta('quem nao e diretor nao dispara a vigia', chamadas === ch0)
g = await pede(DIR, '?atualizar=1')
conta('o diretor dispara e a lista vem nova', chamadas > ch0 && !codigos(g).includes('ORDPARADO1'), codigos(g))
conta('e nao toca o celular de ninguem', avisos.length === 0)

console.log('\n' + ok + ' ok, ' + ruim + ' ruim')
process.exit(ruim ? 1 : 0)
