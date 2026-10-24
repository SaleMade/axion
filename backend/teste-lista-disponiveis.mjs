// OS NUMEROS DE "DISPONIVEIS" APARECEM NO SELLWAVE WEB, SO PRA QUEM MANDA (24/10/2026).
//
// Pedido do Bruno: "eu preciso conectar esses numeros para que, ai sim, eu atribua a um dos meus
// vendedores". Antes o /api/swweb/numeros cortava TODO numero sem dono (regra de 16/10, tambem
// pedido dele), e ele tinha que atribuir primeiro, conectar, e depois devolver pra Disponiveis.
//
// O QUE ESTE TESTE GUARDA, e cada linha e um jeito de a coisa dar errado:
//  - a direcao ve os sem dono; o VENDEDOR nao (numero sem dono nao e trabalho dele, e numero e
//    credencial - a propria Contingencia so mostra a coluna pro diretor);
//  - o recorte e o MESMO da coluna: chip em coluna do cadastro (at='ccol_1') nao esta disponivel, e
//    quem aquece sem dono tem pool proprio e nao pode aparecer duas vezes;
//  - o CORTE POR MUNDO continua de pe pelo `afl` do PROPRIO chip, porque sem dono nao ha de quem
//    herdar o mundo. Era exatamente aqui que dava pra furar o isolamento casa x afiliado;
//  - o numero disponivel chega SEM interruptor (apto false): ele nao recebe lead nenhum ate alguem
//    marcar Em uso, e a tela nao pode sugerir o contrario.
//
// Roda a ROTA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-lista-disponiveis.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)')
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
const user = (id, login, nome, role, afl) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl || null)
user('dir', 'dir', 'Diretor', 'diretor')
user('vend_kevin', 'kevin', 'Kevin', 'atendente')
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
// Token tem que ser HEXADECIMAL: o _authSessao casa /^Bearer s+([a-f0-9]{64})$/ e devolve 401 em
// qualquer outra letra, antes de olhar o banco. Perdi uma rodada com 'k' e 'g' aqui.
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gio: 'b'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gio', 'gio']]) {
  sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)
}

const ST = [
  { id: 'st_em', label: 'Em Uso', papel: 'em_uso' },
  { id: 'st_disp', label: 'Disponível' },
  { id: 'st_ban', label: 'Banido', papel: 'banido' },
  { id: 'st_aq', label: 'Em Aquecimento', papel: 'aquecimento' },
]
const estado = {
  wa_statuses: ST,
  chips: [
    // da casa, com dono
    { id: 1, num: '(17) 99701-1859', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
    // DISPONIVEIS da casa: os dois do print do Bruno
    { id: 2, num: '(15) 97400-8709', at: '', st: 'ativo', wa_st: 'st_disp', idx: 12 },
    { id: 3, num: '(15) 99250-3977', at: '', st: 'ativo', wa_st: 'st_disp', idx: 32 },
    // sem dono, mas numa COLUNA do cadastro: mora na coluna, nao em Disponiveis
    { id: 4, num: '(15) 90000-0004', at: 'ccol_1', st: 'ativo', wa_st: 'st_disp' },
    // sem dono e AQUECENDO: tem pool proprio na Contingencia
    { id: 5, num: '(15) 90000-0005', at: '', st: 'ativo', wa_st: 'st_aq' },
    // sem dono e BANIDO: nao abre mais, nao faz volume
    { id: 6, num: '(15) 90000-0006', at: '', st: 'ativo', wa_st: 'st_ban' },
    // sem dono NO MUNDO DO AFILIADO
    { id: 7, num: '(15) 90000-0007', at: '', st: 'ativo', wa_st: 'st_disp', afl: 'afl_3d767329' },
  ],
  pressels: [{ id: 'p1', vendedores: [] }],
  leads: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const pede = async (tk, maq) => {
  const r = await worker.fetch(new Request('https://x/api/swweb/numeros', {
    headers: { authorization: 'Bearer ' + tk, 'x-sw-maquina': maq, 'x-sw-versao': '1.25.23' },
  }), env, ctx)
  const j = await r.json()
  return Array.isArray(j.numeros) ? j.numeros : []
}
const fins = (l) => l.map((n) => String(n.numero).replace(/\D/g, '').slice(-4)).sort().join(',')

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

const doDir = await pede(TK.dir, 'mbruno0000000001')
t(fins(doDir) === '1859,3977,8709', 'a direcao ve os dois de Disponiveis junto com os numeros com dono', fins(doDir))

const disp = doDir.filter((n) => !n.at)
t(disp.length === 2, 'os dois chegam sem dono', String(disp.length))
t(disp.every((n) => n.dono === ''), 'e sem nome de dono (a barra ja escreve o rotulo dela)')
t(disp.every((n) => n.apto === false && n.roleta === false),
  'e SEM interruptor: numero disponivel nao recebe lead ate alguem marcar Em uso')
t(disp.every((n) => n.status === 'Disponível'), 'com o status da Contingencia, pro selo explicar o porque')
t((disp.find((n) => String(n.numero).includes('97400')) || {}).idx === 12,
  'e com a numeracao da Contingencia (o 8709 e o #12 do print)')

const doKevin = await pede(TK.kevin, 'mkevin0000000002')
t(fins(doKevin) === '1859', 'o VENDEDOR nao ve numero sem dono: so o dele', fins(doKevin))

t(!doDir.some((n) => String(n.numero).includes('90000-0004')), 'chip de coluna do cadastro nao e "disponivel"')
t(!doDir.some((n) => String(n.numero).includes('90000-0005')), 'sem dono e aquecendo nao entra aqui (tem pool proprio)')
t(!doDir.some((n) => String(n.numero).includes('90000-0006')), 'sem dono e banido continua fora da lista')
t(!doDir.some((n) => String(n.numero).includes('90000-0007')), 'a casa NAO ve o disponivel do afiliado')

const doGio = await pede(TK.gio, 'mgio00000000003')
t(fins(doGio) === '0007', 'o afiliado ve o disponivel DELE, e so ele', fins(doGio))

console.log('\n' + ok + ' certos, ' + mau + ' errados')
process.exit(mau ? 1 : 0)
