// O TETO DE LEADS DO DIA AGORA E DO VENDEDOR TAMBEM (28/10/2026, POST /api/chip/limite).
//
// Pedido do Bruno: "gostaria tambem que fosse possivel para os meus vendedores conseguirem fazer a
// edicao do limite. Eles vao poder controlar o limite de chegada de cada um dos numeros tambem.
// Quero deixar esse controle na mao deles, porque eles vao ter mais autonomia no dia a dia."
//
// O QUE ESTE TESTE GUARDA, e cada linha e um jeito de a coisa dar errado:
//  - o vendedor mexe NO DELE e so nele. A trava olha o `at` do CHIP NO BANCO, nunca o que veio no
//    corpo: mandar o numero do colega na mao tem que tomar 403;
//  - o corte casa x afiliado continua de pe pelo `afl` do PROPRIO chip. Sem ele, o afiliado mudaria
//    o teto de um numero da casa sabendo so os 8 digitos;
//  - 100 e o teto DE VERDADE, no servidor. Botao e sugestao, trava e servidor: mandar 150 na mao
//    grava 100;
//  - numero SEM DONO (a prateleira "Disponiveis") e numero EM AQUECIMENTO nao tem `lim_dia` que
//    valha - num quem manda e ninguem, no outro quem manda e a rampa - e gravar ali faria a tela
//    mostrar um teto que a distribuicao ignora;
//  - o gestor de trafego (roleta resumida) nao mexe em teto, igual na dash.
//
// Roda a ROTA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-limite-vendedor.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
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
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, afl) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl || null)
user('dir', 'dir', 'Diretor', 'diretor')
user('vend_kevin', 'kevin', 'Kevin', 'atendente')
user('vend_gui', 'gui', 'Guilherme', 'atendente')
user('traf', 'traf', 'Diego', 'gestor')
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
// Token HEXADECIMAL: o _authSessao casa /^Bearer\s+([a-f0-9]{64})$/ e devolve 401 em qualquer outra
// letra, antes de olhar o banco.
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gui: 'b'.repeat(64), traf: 'c'.repeat(64), gio: 'e'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gui', 'vend_gui'], ['traf', 'traf'], ['gio', 'gio']]) {
  sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)
}

const ST = [
  { id: 'st_em', label: 'Em Uso', papel: 'em_uso' },
  { id: 'st_disp', label: 'Disponível' },
  { id: 'st_aq', label: 'Em Aquecimento', papel: 'aquecimento' },
]
const estado = {
  wa_statuses: ST,
  chips: [
    { id: 1, num: '(17) 99701-1859', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true, lim_dia: 70 },
    { id: 2, num: '(81) 99227-7130', at: 'vend_gui', st: 'ativo', wa_st: 'st_em', em_uso: true, lim_dia: 50 },
    // sem dono: a prateleira "Disponiveis"
    { id: 3, num: '(15) 97400-8709', at: '', st: 'ativo', wa_st: 'st_disp', lim_dia: 70 },
    // numa coluna do cadastro: tambem nao e de ninguem
    { id: 4, num: '(15) 90000-0004', at: 'ccol_1', st: 'ativo', wa_st: 'st_disp' },
    // AQUECENDO com dono: quem manda no teto dele e a rampa
    { id: 5, num: '(15) 90000-0005', at: 'vend_kevin', st: 'aquecimento', wa_st: 'st_aq', warm_start: '2026-10-25' },
    // do mundo do AFILIADO
    { id: 6, num: '(15) 90000-0007', at: 'gio', st: 'ativo', wa_st: 'st_em', em_uso: true, afl: 'afl_3d767329', lim_dia: 50 },
  ],
  pressels: [{ id: 'p1', vendedores: [] }],
  leads: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

// O bundle importa cloudflare:sockets, que o node nao abre: vira uma classe vazia numa copia ao lado.
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-limite.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const grava = async (tk, num, lim) => {
  const r = await worker.fetch(new Request('https://x/api/chip/limite', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json', 'x-sw-maquina': 'm'.repeat(16), 'x-sw-versao': '1.25.36' },
    body: JSON.stringify({ num: String(num).replace(/\D/g, ''), lim }),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
// O que REALMENTE ficou gravado, lido do banco e nao da resposta: resposta otimista ja mentiu antes.
const limNoBanco = (num) => {
  const d = JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
  const nk = String(num).replace(/\D/g, '').slice(-8)
  const c = (d.chips || []).find((x) => String(x.num).replace(/\D/g, '').slice(-8) === nk)
  return c ? (c.lim_dia === undefined ? 'sem campo' : c.lim_dia) : 'sem chip'
}

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nA DIRECAO MEXE EM QUALQUER UM')
let r = await grava(TK.dir, '(17) 99701-1859', 30)
t(r.st === 200 && r.j.ok && r.j.lim === 30, 'o diretor baixa o teto do numero do Kevin pra 30', JSON.stringify(r))
t(limNoBanco('(17) 99701-1859') === 30, 'e o 30 esta no banco', String(limNoBanco('(17) 99701-1859')))

console.log('\nO VENDEDOR MEXE NO DELE (o pedido de hoje)')
r = await grava(TK.gui, '(81) 99227-7130', 100)
t(r.st === 200 && r.j.lim === 100, 'o Guilherme sobe o teto do numero DELE pra 100', JSON.stringify(r))
t(limNoBanco('(81) 99227-7130') === 100, 'e ficou gravado', String(limNoBanco('(81) 99227-7130')))

console.log('\nE SO NO DELE')
r = await grava(TK.gui, '(17) 99701-1859', 100)
t(r.st === 403, 'o Guilherme NAO mexe no numero do Kevin, mesmo mandando na mao', JSON.stringify(r))
t(limNoBanco('(17) 99701-1859') === 30, 'o teto do Kevin continua 30', String(limNoBanco('(17) 99701-1859')))

console.log('\nO CORTE CASA x AFILIADO')
r = await grava(TK.gio, '(17) 99701-1859', 100)
t(r.st === 404, 'o afiliado nao enxerga numero da casa nem sabendo os 8 digitos', JSON.stringify(r))
r = await grava(TK.gio, '(15) 90000-0007', 70)
t(r.st === 200 && r.j.lim === 70, 'mas mexe no numero do mundo dele', JSON.stringify(r))
r = await grava(TK.dir, '(15) 90000-0007', 30)
t(r.st === 200, 'e a direcao da casa alcanca o numero do afiliado (ela manda na operacao)', JSON.stringify(r))

console.log('\nO TETO DE 100 E DO SERVIDOR, NAO DO BOTAO')
r = await grava(TK.gui, '(81) 99227-7130', 150)
t(r.st === 200 && r.j.lim === 100, 'mandar 150 na mao grava 100', JSON.stringify(r))
t(limNoBanco('(81) 99227-7130') === 100, 'e o banco tem 100, nao 150', String(limNoBanco('(81) 99227-7130')))
r = await grava(TK.gui, '(81) 99227-7130', -5)
t(r.st === 200 && r.j.lim === 0, 'numero negativo vira 0 (sem limite), nao erro', JSON.stringify(r))
t(limNoBanco('(81) 99227-7130') === 'sem campo', 'e "sem limite" APAGA o campo, nao grava zero', String(limNoBanco('(81) 99227-7130')))

console.log('\nONDE O CAMPO NAO VALE, A ROTA RECUSA')
r = await grava(TK.dir, '(15) 97400-8709', 50)
t(r.st === 400, 'numero sem vendedor (Disponiveis) nao tem teto pra mexer', JSON.stringify(r))
t(limNoBanco('(15) 97400-8709') === 70, 'e a sobra dele nao foi tocada', String(limNoBanco('(15) 97400-8709')))
r = await grava(TK.dir, '(15) 90000-0004', 50)
t(r.st === 400, 'chip numa coluna do cadastro tambem nao', JSON.stringify(r))
r = await grava(TK.kevin, '(15) 90000-0005', 50)
t(r.st === 400 && /rampa/i.test(String(r.j.error || '')), 'em aquecimento quem manda e a rampa, e a mensagem diz isso', JSON.stringify(r))
t(limNoBanco('(15) 90000-0005') === 'sem campo', 'e nada foi gravado nele', String(limNoBanco('(15) 90000-0005')))

console.log('\nQUEM NAO PODE')
r = await grava(TK.traf, '(17) 99701-1859', 50)
t(r.st === 403, 'o gestor de trafego nao mexe em teto (roleta resumida), igual na dash', JSON.stringify(r))
r = await grava('f'.repeat(64), '(17) 99701-1859', 50)
t(r.st === 401, 'sem sessao valida, 401', JSON.stringify(r))
r = await grava(TK.dir, '(15) 99999-9999', 50)
t(r.st === 404, 'numero que nao existe, 404', JSON.stringify(r))
r = await grava(TK.dir, '123', 50)
t(r.st === 400, 'numero curto demais, 400', JSON.stringify(r))

console.log('\n' + ok + ' certos, ' + mau + ' errados')
process.exit(mau ? 1 : 0)
