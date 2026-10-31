// UM LINK DE CHECKOUT POR KIT, COM O DOS AFILIADOS A PARTE (30/10/2026, troca da Payt pra conta do
// CNPJ). Ver handleAfiliadoCheckout / _checkoutDoAfiliado / _linkCheckoutDoLead no worker.js.
//
// Prova, na rota de verdade contra um D1 de mentira:
//  - o diretor grava `link` e `link_af` no kit da casa; o formato antigo (antecipado/entrega) sai;
//  - gravar so um campo nao apaga o outro;
//  - a gravacao nao le o estado inteiro e nao mexe nos pedidos;
//  - o afiliado grava so o `link` do galho dele, nunca o AF da casa;
//  - o afiliado enxerga o galho dele e o AF da casa, NUNCA o link da casa (GET e /api/state);
//  - pedido novo de afiliado nasce com: link dele > AF da casa > formato antigo dele;
//  - link que nao e http(s) e recusado; aba velha mandando antecipado/entrega vira link unico.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-checkout-link.mjs <dir>/worker.js
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
function stmt(sql, args = []) {
  if (/^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)) leuInteiro++
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
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
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_g')
user('ana', 'ana', 'Ana', 'afiliado', 'afl_a')
const TK = { dir: 'd'.repeat(64), gio: 'e'.repeat(64), ana: 'a'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['gio', 'gio'], ['ana', 'ana']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)

const K2 = 'eeaf8612', K3 = '1631b8e1', K4 = 'b1c4c1fd'
const estado = {
  regras: { kits: [{ id: K2, nome: 'Glico Six - 2 Meses' }, { id: K3, nome: 'Glico Six - 3 Meses' }, { id: K4, nome: 'Glico Six - 4 Meses' }] },
  afl_checkout: {
    _casa: {
      [K2]: { antecipado: 'https://checkout.payt.com.br/velho2a', entrega: 'https://checkout.payt.com.br/velho2e' },
      [K3]: { antecipado: 'https://checkout.payt.com.br/velho3a', entrega: 'https://checkout.payt.com.br/velho3e' },
    },
    afl_g: {
      [K2]: { antecipado: 'https://seguro.payt.com.br/a/gio2a', entrega: 'https://seguro.payt.com.br/a/gio2e' },
      [K4]: { antecipado: 'https://seguro.payt.com.br/a/gio4a', entrega: 'https://seguro.payt.com.br/a/gio4e' },
    },
  },
  leads: [{ id: '100', nome: 'Joao', col: 'Cobrança', hist: [] }],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-checkout.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const chama = async (tk, path, method, body) => {
  const r = await worker.fetch(new Request('https://x' + path, { method, headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const grava = (tk, body) => chama(tk, '/api/afiliados/checkout', 'POST', body)
const est = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
const ck = () => est().afl_checkout
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }

console.log('DIRETOR NA CASA')
const leadsAntes = JSON.stringify(est().leads)
leuInteiro = 0
let r = await grava(TK.dir, { afiliado: '_casa', kit: K2, link: 'https://checkout.payt.com.br/novo2', link_af: 'https://checkout.payt.com.br/novo2af' })
t(r.st === 200, 'grava link e link_af do kit 2', JSON.stringify(r))
t(JSON.stringify(ck()._casa[K2]) === JSON.stringify({ link: 'https://checkout.payt.com.br/novo2', link_af: 'https://checkout.payt.com.br/novo2af' }), 'o kit ficou so com link e link_af (antecipado/entrega sairam)', JSON.stringify(ck()._casa[K2]))
t(leuInteiro === 0, 'sem ler o estado inteiro', String(leuInteiro))
t(JSON.stringify(est().leads) === leadsAntes, 'os pedidos ficaram byte a byte iguais')
t(ck()._casa[K3].antecipado === 'https://checkout.payt.com.br/velho3a', 'o outro kit da casa nao foi tocado')
r = await grava(TK.dir, { afiliado: '_casa', kit: K3, link_af: 'https://checkout.payt.com.br/novo3af' })
t(r.st === 200 && ck()._casa[K3].link_af === 'https://checkout.payt.com.br/novo3af' && ck()._casa[K3].antecipado === 'https://checkout.payt.com.br/velho3a', 'gravar so o AF nao apaga o link antigo da casa', JSON.stringify(ck()._casa[K3]))
r = await grava(TK.dir, { afiliado: '_casa', kit: K2, link: 'https://checkout.payt.com.br/novo2b' })
t(ck()._casa[K2].link === 'https://checkout.payt.com.br/novo2b' && ck()._casa[K2].link_af === 'https://checkout.payt.com.br/novo2af', 'gravar so o link da casa nao apaga o AF')
r = await grava(TK.dir, { afiliado: '_casa', kit: K4, link: 'javascript:alert(1)' })
t(r.st === 400 && !ck()._casa[K4], 'link que nao e http(s) e recusado')
r = await grava(TK.dir, { afiliado: '_casa', kit: K4, antecipado: 'https://checkout.payt.com.br/aba4', entrega: '' })
t(r.st === 200 && JSON.stringify(ck()._casa[K4]) === JSON.stringify({ link: 'https://checkout.payt.com.br/aba4' }), 'aba com a tela antiga (antecipado/entrega) vira link unico', JSON.stringify(ck()._casa[K4]))
r = await grava(TK.dir, { afiliado: '_casa', kit: K4, link: '' })
t(r.st === 200 && !ck()._casa[K4], 'apagar o unico link apaga o kit do mapa')

console.log('\nAFILIADO')
r = await grava(TK.gio, { kit: K2, link_af: 'https://evil.example/x' })
t(r.st === 400 && ck()._casa[K2].link_af === 'https://checkout.payt.com.br/novo2af', 'afiliado NAO grava o AF da casa', JSON.stringify(r))
r = await grava(TK.gio, { afiliado: '_casa', kit: K2, link: 'https://evil.example/y' })
t(r.st === 200 && ck()._casa[K2].link === 'https://checkout.payt.com.br/novo2b' && ck().afl_g[K2].link === 'https://evil.example/y', 'afiliado mandando afiliado=_casa grava no galho DELE, nao na casa', JSON.stringify(ck().afl_g[K2]))
await grava(TK.gio, { kit: K2, link: '' })
t(!ck().afl_g[K2], 'e apaga o proprio link')
r = await chama(TK.gio, '/api/afiliados/checkout', 'GET')
const vis = r.j.checkout || {}
t(r.st === 200 && vis.afl_g && vis._casa && !vis.afl_a, 'GET do afiliado traz o galho dele e o da casa', JSON.stringify(vis).slice(0, 300))
t(Object.values(vis._casa || {}).every((v) => Object.keys(v).join() === 'link_af'), 'do galho da casa vem SO o link_af (nunca o link da casa)', JSON.stringify(vis._casa))
r = await chama(TK.gio, '/api/state', 'GET')
const vst = (r.j && r.j.data && r.j.data.afl_checkout) || {}
t(r.st === 200 && vst._casa && Object.values(vst._casa).every((v) => Object.keys(v).join() === 'link_af') && !JSON.stringify(vst).includes('novo2b'), '/api/state do afiliado: AF sim, link da casa nao', JSON.stringify(vst).slice(0, 300))

console.log('\nPEDIDO NOVO DO AFILIADO')
const novo = async (tk, id, trat, mod) => {
  const r = await chama(tk, '/api/pedido/novo', 'POST', { lead: { id, nome: 'Cliente ' + id, trat, mod, col: 'A Enviar', hist: [] } })
  const l = est().leads.find((x) => String(x.id) === String(id))
  return { st: r.st, link: l && l.link, j: r.j }
}
let p = await novo(TK.gio, '201', 'Glico Six - 2 Meses', 'entrega')
t(p.st === 200 && p.link === 'https://checkout.payt.com.br/novo2af', 'sem link dele: nasce com o AF da casa', JSON.stringify(p))
await grava(TK.gio, { kit: K3, link: 'https://seguro.payt.com.br/a/gio3novo' })
p = await novo(TK.gio, '202', 'Glico Six - 3 Meses', 'antecipado')
t(p.link === 'https://seguro.payt.com.br/a/gio3novo', 'com link dele: o dele vence o AF', JSON.stringify(p))
await grava(TK.dir, { afiliado: '_casa', kit: K4, link_af: 'https://checkout.payt.com.br/novo4af' })
p = await novo(TK.gio, '203', 'Glico Six - 4 Meses', 'antecipado')
t(p.link === 'https://checkout.payt.com.br/novo4af', 'o AF vence o link ANTIGO dele (conta que esta saindo)', JSON.stringify(p))
await grava(TK.dir, { afiliado: '_casa', kit: K4, link_af: '' })
p = await novo(TK.gio, '204', 'Glico Six - 4 Meses', 'antecipado')
t(p.link === 'https://seguro.payt.com.br/a/gio4a', 'sem AF, o antigo dele ainda vale pela modalidade', JSON.stringify(p))
p = await novo(TK.ana, '205', 'Glico Six - 2 Meses', 'entrega')
t(p.link === 'https://checkout.payt.com.br/novo2af', 'afiliado sem galho nenhum tambem pega o AF', JSON.stringify(p))

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
