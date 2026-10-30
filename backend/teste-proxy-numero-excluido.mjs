// NUMERO EXCLUIDO TEM QUE SAIR DA PROXY (30/10/2026).
//
// Pedido do Bruno: "teve alguns numeros que eu exclui (...) estou tentando tirar eles da proxy,
// porem fica dando a mensagem de que o numero nao foi encontrado. Quando eu excluo um numero, ja
// quero que ele saia da proxy, porque ele foi excluido."
//
// Eram DUAS coisas, e as duas estao guardadas aqui:
//  1) a atribuicao de proxy mora FORA do blob (`swweb_proxies`, chave propria do D1, lida direto
//     pelo SellWave Web e pelo painel do LDPlayer). Apagar o chip nao tocava nela, entao a linha
//     ficava pendurada no Banco de proxies - contando como numero daquela proxy e ate disparando o
//     aviso de "2 numeros saindo pelo mesmo IP" por causa de um numero que nao existe mais;
//  2) o "tirar a proxy" daquela linha respondia 404 "Número não encontrado", porque o gate procura
//     o chip no cadastro ANTES de deixar mexer. A unica tela que podia limpar a sujeira era
//     justamente a que se recusava a limpar.
//
// O QUE NAO PODE AFROUXAR JUNTO: a excecao do 404 vale SO pra tirar (`id` vazio). Atribuir proxy a
// numero que nao existe continua 404, e o corte casa x afiliado continua valendo nos dois sentidos
// (cada mundo tem a chave dele: `swweb_proxies` x `swweb_proxies__afl_xxx`).
//
// Roda a ROTA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-proxy-numero-excluido.mjs <dir>/worker.js
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
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gio: 'e'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gio', 'gio']]) {
  sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)
}

// DDD + 8 finais, que e a chave do `swweb_proxies` (a mesma do _waNumKey).
const NK_FICA = '1797011859'     // (17) 99701-1859, continua cadastrado
const NK_SAI = '1581589461'      // (15) 98158-9461, o que ele exclui no meio do teste
const NK_ORFAO = '1592371970'    // (15) 99237-1970, ja estava orfao antes do conserto
const NK_GIO = '1590000007'      // numero do mundo do afiliado

const estado = {
  wa_statuses: [{ id: 'st_em', label: 'Em Uso', papel: 'em_uso' }],
  chips: [
    { id: 1, num: '(17) 99701-1859', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
    { id: 2, num: '(15) 98158-9461', at: 'vend_kevin', st: 'ativo', wa_st: 'st_em', em_uso: true },
    { id: 3, num: '(15) 90000-0007', at: 'gio', st: 'ativo', wa_st: 'st_em', em_uso: true, afl: 'afl_3d767329' },
  ],
  pressels: [{ id: 'p1', vendedores: [] }],
  leads: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
const poeCfg = (k, v) => sq.prepare('INSERT OR REPLACE INTO app_config (key,value,updated_at) VALUES (?,?,?)')
  .run(k, JSON.stringify(v), Math.floor(Date.now() / 1000))
const leCfg = (k) => { const r = sq.prepare('SELECT value FROM app_config WHERE key=?').get(k); try { return JSON.parse(r ? r.value : '{}') } catch (_) { return {} } }

const PX = { host: 'isp.decodo.com', porta: 10003, usuario: 'sp6ek', senha: 'x' }
poeCfg('swweb_proxy_banco', { px3: { apelido: 'Proxy 03', ...PX, criado: 1, mexido: 1 } })
poeCfg('swweb_proxies', {
  [NK_FICA]: { ...PX, id: 'px3', ver: 1 },
  [NK_SAI]: { ...PX, id: 'px3', ver: 1 },
  [NK_ORFAO]: { ...PX, id: 'px3', ver: 1 },
})
poeCfg('swweb_excecoes', { [NK_SAI]: { ate: exp, por: 'dir', nome: 'Diretor' } })
poeCfg('swweb_proxies__afl_3d767329', { [NK_GIO]: { ...PX, porta: 10009, id: 'pxg', ver: 1 } })
poeCfg('swweb_proxy_banco__afl_3d767329', { pxg: { apelido: 'Proxy do Gio', ...PX, porta: 10009, criado: 1, mexido: 1 } })

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-proxy-orfa.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }

const post = async (tk, rota, corpo) => {
  const r = await worker.fetch(new Request('https://x' + rota, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json', 'x-sw-maquina': 'm'.repeat(16), 'x-sw-versao': '1.25.37' },
    body: JSON.stringify(corpo),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const apaga = (tk, id) => post(tk, '/api/chip/delete', { id })
const tira = (tk, nk) => post(tk, '/api/swweb/proxy-atribuir', { nk, id: '' })

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nEXCLUIR O NUMERO TIRA ELE DA PROXY (o pedido de hoje)')
let r = await apaga(TK.dir, 2)
t(r.st === 200 && r.j.ok, 'o diretor exclui o (15) 98158-9461 na Contingencia', JSON.stringify(r))
let px = leCfg('swweb_proxies')
t(!(NK_SAI in px), 'e ele sai do Banco de proxies junto, sem ninguem precisar clicar', JSON.stringify(Object.keys(px)))
t(NK_FICA in px && px[NK_FICA].id === 'px3', 'o numero que CONTINUA cadastrado nao foi tocado', JSON.stringify(px[NK_FICA] || null))
t(!(NK_SAI in leCfg('swweb_excecoes')), 'e a liberacao "sem proxy" dele tambem some (mesma classe de sobra)',
  JSON.stringify(Object.keys(leCfg('swweb_excecoes'))))
t(!(JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data).chips || []).some((c) => c.id === 2),
  'e o chip saiu do cadastro, que e o que a exclusao sempre fez')

console.log('\nO QUE JA ESTAVA PENDURADO ANTES: o "tirar a proxy" agora limpa')
r = await tira(TK.dir, NK_ORFAO)
t(r.st === 200 && r.j.apagou, 'tirar a proxy de numero que nao existe mais DA CERTO (antes: 404)', JSON.stringify(r))
t(!(NK_ORFAO in leCfg('swweb_proxies')), 'e a linha some do banco de verdade', JSON.stringify(Object.keys(leCfg('swweb_proxies'))))
r = await tira(TK.dir, NK_FICA)
t(r.st === 200 && !(NK_FICA in leCfg('swweb_proxies')), 'e tirar de numero que EXISTE continua funcionando igual', JSON.stringify(r))

console.log('\nO QUE NAO PODE TER AFROUXADO JUNTO')
r = await post(TK.dir, '/api/swweb/proxy-atribuir', { nk: NK_ORFAO, id: 'px3' })
t(r.st === 404, 'ATRIBUIR proxy a numero que nao existe continua 404: a excecao e so pra TIRAR', JSON.stringify(r))
t(!(NK_ORFAO in leCfg('swweb_proxies')), 'e nada foi gravado pra ele', JSON.stringify(Object.keys(leCfg('swweb_proxies'))))
r = await tira(TK.kevin, NK_FICA)
t(r.st === 403, 'vendedor nao tira proxy de ninguem (so a direcao atribui)', JSON.stringify(r))
r = await post(TK.dir, '/api/swweb/proxy-atribuir', { nk: '98159461', id: '' })
t(r.st === 400, 'chave de 8 digitos continua recusada (ela grava onde o app nunca le)', JSON.stringify(r))

console.log('\nCADA MUNDO NA CHAVE DELE')
poeCfg('swweb_proxies', { [NK_GIO]: { ...PX, id: 'px3', ver: 1 } })   // homonimo na casa, de proposito
r = await tira(TK.gio, NK_GIO)
t(r.st === 200, 'o afiliado tira a proxy do numero DELE', JSON.stringify(r))
t(!(NK_GIO in leCfg('swweb_proxies__afl_3d767329')), 'e sai da chave do mundo dele',
  JSON.stringify(leCfg('swweb_proxies__afl_3d767329')))
t(NK_GIO in leCfg('swweb_proxies'), 'e a chave da CASA, com a mesma chave de numero, nao foi tocada',
  JSON.stringify(Object.keys(leCfg('swweb_proxies'))))
r = await apaga(TK.dir, 3)
t(r.st === 200, 'a direcao da casa exclui o numero do afiliado (ela manda na operacao)', JSON.stringify(r))
t(!(NK_GIO in leCfg('swweb_proxies__afl_3d767329')), 'e a faxina acontece na chave do mundo DELE, nao na da casa',
  JSON.stringify(leCfg('swweb_proxies__afl_3d767329')))
t(NK_GIO in leCfg('swweb_proxies'), 'a chave da casa continua intacta (o homonimo nao foi arrastado junto)',
  JSON.stringify(Object.keys(leCfg('swweb_proxies'))))

console.log('\nEXCLUIR NUMERO SEM PROXY NAO MEXE EM NADA')
const antes = JSON.stringify(leCfg('swweb_proxies'))
r = await apaga(TK.dir, 1)
t(r.st === 200 && JSON.stringify(leCfg('swweb_proxies')) === antes,
  'o (17) 99701-1859 ja estava sem proxy: a exclusao nao reescreve a chave a toa', JSON.stringify(r))

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
