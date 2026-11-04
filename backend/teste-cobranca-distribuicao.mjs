// A DISTRIBUICAO DA COBRANCA E O LINK DE ENTREGA (04/11/2026).
//
// Pedido do Bruno com o segundo cobrador (Bryan): controlar pra quem vai cada pedido novo ("todos
// os leads do Guilherme pro cobrador 1, todos do Kevin pro cobrador 2") e, agora, "todos os novos
// pro Bryan". E o link que o vendedor manda pro cliente tem que abrir o WhatsApp do MESMO cobrador.
//
// O furo que este teste guarda: antes o pedido novo ia pro Bryan, mas o link da mensagem era o
// numero fixo do Haynan; o cliente escrevia pra ele e a regra "o pedido e de quem o cliente chamou"
// devolvia o pedido pro Haynan. A regra e UMA (app_config cob_regra) e a varredura e o link leem dela.
//
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cobranca-distribuicao.mjs <dir>/worker.js
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
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, pct) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, pct || 0)
user('dir', 'dir', 'Diretor', 'diretor', 0)
user('cob_haynan', 'haynan', 'Haynan', 'cobrador', 3)
user('cob_bryan', 'bryan', 'Bryan', 'cobrador', 3)
user('vend_gui', 'gui', 'Guilherme', 'atendente', 12)
user('vend_kev', 'kev', 'Kevin', 'atendente', 12)
user('vend_bar', 'bar', 'Barbara', 'atendente', 12)
const TK = { dir: 'd'.repeat(64), gui: 'b'.repeat(64), hay: 'c'.repeat(64) }
for (const [t, id] of [[TK.dir, 'dir'], [TK.gui, 'vend_gui'], [TK.hay, 'cob_haynan']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(t, id, exp)

let seq = Date.now() - 3600e3
const lead = (extra) => ({ id: String(++seq), nome: 'Cliente ' + seq, col: 'A Enviar', vl: 497, hist: [], ...extra })
// O Haynan com 3 em aberto, o Bryan com 0: na regra antiga (menos em aberto) tudo novo iria pro Bryan.
const estado = {
  leads: [
    lead({ at: 'vend_gui', col: 'Cobrança', cob: 'cob_haynan', wa: '5515900000001' }),
    lead({ at: 'vend_kev', col: 'Cobrança', cob: 'cob_haynan', wa: '5515900000002' }),
    lead({ at: 'vend_kev', col: 'Enviado', cob: 'cob_haynan', wa: '5515900000003' }),
  ],
  chips: [
    { id: 1, num: '(15) 99198-0514', at: 'cob_haynan', st: 'ativo', em_uso: true },
    { id: 2, num: '(15) 99286-0587', at: 'cob_haynan', st: 'ativo', em_uso: false },
    { id: 3, num: '(11) 92733-5679', at: 'cob_bryan', st: 'ativo', em_uso: true },
  ],
  pressels: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,0,?)').run(JSON.stringify(estado), 'teste')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-distribuicao.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }
const pend = []
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} }
const batida = async () => {
  let alvo = Math.floor(Date.now() / 60000)
  while (alvo % 5 !== 1) alvo++
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run()
  const ol = console.log, oe = console.error
  console.log = () => {}; console.error = () => {}
  try { await worker.scheduled({ scheduledTime: alvo * 60000, cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift() }
  finally { console.log = ol; console.error = oe }
}
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
const poe = (...ls) => { const d = ler(); d.leads.push(...ls); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)); return ls }
const doId = (id) => (ler().leads || []).find((l) => l.id === id) || {}
const req = async (metodo, caminho, tk, corpo) => {
  const h = { 'content-type': 'application/json' }
  if (tk) h.authorization = 'Bearer ' + tk
  const ol = console.log; console.log = () => {}
  try {
    const r = await worker.fetch(new Request('https://x' + caminho, { method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined, redirect: 'manual' }), env, ctx)
    return { st: r.status, loc: r.headers.get('location') || '', j: await r.clone().json().catch(() => null) }
  } finally { console.log = ol }
}
const regra = (corpo, tk = TK.dir) => req('POST', '/api/cob/regra', tk, corpo)
const b36 = (fone) => Number(fone).toString(36)
const WA_HAY = 'https://wa.me/5515991980514', WA_BRY = 'https://wa.me/5511927335679'

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nSEM REGRA SALVA: o de antes (quem tem menos em aberto)')
let [n1] = poe(lead({ at: 'vend_gui', wa: '5511911110001' }))
await batida()
t(doId(n1.id).cob === 'cob_bryan', 'pedido novo foi pro Bryan (0 em aberto contra 3)', doId(n1.id).cob)

console.log('\nQUEM PODE MEXER NA REGRA')
let r = await regra({ modo: 'fixo', alvo: 'cob_bryan' }, TK.gui)
t(r.st === 403, 'vendedor nao grava a regra', String(r.st))
r = await regra({ modo: 'fixo', alvo: 'cob_bryan' }, TK.hay)
t(r.st === 403, 'cobrador nao grava a regra', String(r.st))
r = await req('GET', '/api/cob/regra', TK.hay)
t(r.st === 200 && r.j && r.j.regra && r.j.regra.modo === 'menos', 'cobrador le a regra (e sem regra salva vale "menos")', JSON.stringify(r.j && r.j.regra))
r = await regra({ modo: 'fixo', alvo: 'vend_gui' })
t(r.st === 400, 'alvo que nao e cobrador ativo e recusado', String(r.st))
r = await regra({ modo: 'qualquer' })
t(r.st === 400, 'modo desconhecido e recusado', String(r.st))
r = await regra({ modo: 'fixo' })
t(r.st === 400, '"todos para" sem cobrador e recusado', String(r.st))

console.log('\nTODOS OS NOVOS PRO HAYNAN (fixo), mesmo ele tendo mais em aberto')
r = await regra({ modo: 'fixo', alvo: 'cob_haynan' })
t(r.st === 200 && r.j.regra.modo === 'fixo', 'diretor grava a regra', JSON.stringify(r.j))
let [n2, n3] = poe(lead({ at: 'vend_gui', wa: '5511911110002' }), lead({ at: 'vend_kev', wa: '5511911110003' }))
await batida()
t(doId(n2.id).cob === 'cob_haynan' && doId(n3.id).cob === 'cob_haynan', 'os dois novos foram pro Haynan', doId(n2.id).cob + ' / ' + doId(n3.id).cob)
t(doId(n1.id).cob === 'cob_bryan', 'o que ja tinha dono nao muda quando a regra muda', doId(n1.id).cob)

console.log('\nTODOS OS NOVOS PRO BRYAN (a decisao do Bruno em 04/11)')
await regra({ modo: 'fixo', alvo: 'cob_bryan' })
let [n4] = poe(lead({ at: 'vend_kev', wa: '5511911110004' }))
await batida()
t(doId(n4.id).cob === 'cob_bryan', 'pedido novo foi pro Bryan', doId(n4.id).cob)

console.log('\nPOR VENDEDOR: Guilherme -> Haynan, Kevin -> Bryan, os outros dividem igual')
await regra({ modo: 'vendedor', porVend: { vend_gui: 'cob_haynan', vend_kev: 'cob_bryan' } })
let [g1, k1, g2] = poe(lead({ at: 'vend_gui', wa: '5511911110005' }), lead({ at: 'vend_kev', wa: '5511911110006' }), lead({ at: 'vend_gui', wa: '5511911110007' }))
await batida()
t(doId(g1.id).cob === 'cob_haynan' && doId(g2.id).cob === 'cob_haynan', 'os do Guilherme foram pro Haynan', doId(g1.id).cob + ' / ' + doId(g2.id).cob)
t(doId(k1.id).cob === 'cob_bryan', 'o do Kevin foi pro Bryan', doId(k1.id).cob)
// vendedor sem cobrador escolhido divide igual (a contagem recomeca quando a regra e salva)
await regra({ modo: 'vendedor', porVend: { vend_gui: 'cob_haynan', vend_kev: 'cob_bryan' } })
let [b1, b2] = poe(lead({ at: 'vend_bar', wa: '5511911110008' }), lead({ at: 'vend_bar', wa: '5511911110009' }))
await batida()
t(doId(b1.id).cob !== doId(b2.id).cob && [doId(b1.id).cob, doId(b2.id).cob].every(Boolean), 'os dois da Barbara (sem cobrador escolhido) dividiram, um pra cada', doId(b1.id).cob + ' / ' + doId(b2.id).cob)
await regra({ modo: 'vendedor', alvo: 'cob_bryan', porVend: { vend_gui: 'cob_haynan' } })
let [b3, g3] = poe(lead({ at: 'vend_bar', wa: '5511911110010' }), lead({ at: 'vend_gui', wa: '5511911110011' }))
await batida()
t(doId(b3.id).cob === 'cob_bryan' && doId(g3.id).cob === 'cob_haynan', 'com "os outros vendedores vao pro Bryan": Barbara -> Bryan, Guilherme -> Haynan', doId(b3.id).cob + ' / ' + doId(g3.id).cob)

console.log('\nDIVIDIR IGUAL: um pra cada, contando so os que chegaram depois de salvar')
await regra({ modo: 'igual' })
const quatro = poe(...[12, 13, 14, 15].map((i) => lead({ at: 'vend_gui', wa: '55119111100' + i })))
await batida()
const cont = quatro.reduce((m, l) => { const c = doId(l.id).cob; m[c] = (m[c] || 0) + 1; return m }, {})
t(cont.cob_haynan === 2 && cont.cob_bryan === 2, 'quatro novos: 2 pra cada', JSON.stringify(cont))

console.log('\nO LINK DE ENTREGA abre o WhatsApp do dono do pedido')
await regra({ modo: 'fixo', alvo: 'cob_bryan' })
r = await req('GET', '/entrega/' + b36('5515900000001'))
t(r.st === 302 && r.loc.startsWith(WA_HAY), 'cliente com pedido do Haynan cai no numero "Em uso" do Haynan', r.st + ' ' + r.loc)
t(/text=Ol%C3%A1!%20Quero%20acompanhar%20o%20meu%20pedido\./.test(r.loc), 'com a mesma frase de hoje ja escrita', r.loc)
r = await req('GET', '/entrega/' + b36('5511911110004'))
t(r.st === 302 && r.loc.startsWith(WA_BRY), 'cliente com pedido do Bryan cai no Bryan', r.loc)
r = await req('GET', '/entrega/' + b36('5511977770000'))
t(r.st === 302 && r.loc.startsWith(WA_BRY), 'cliente ainda sem pedido segue a regra (todos pro Bryan)', r.loc)
r = await req('GET', '/entrega')
t(r.st === 302 && r.loc.startsWith(WA_BRY), 'link sem telefone (app antigo) tambem segue a regra', r.loc)
r = await req('GET', '/entrega/xx')
t(r.st === 302 && r.loc.startsWith(WA_BRY), 'codigo quebrado nao derruba: vale a regra', r.st + ' ' + r.loc)
// sem pedido ainda, no modo por vendedor: o vendedor sai da conversa (wa_attrib)
await regra({ modo: 'vendedor', porVend: { vend_gui: 'cob_haynan', vend_kev: 'cob_bryan' } })
sq.prepare('INSERT INTO wa_attrib (phone, instance, updated_at) VALUES (?,?,?)').run('5511966660000', 'ax_vend_gui_66660000', Date.now())
r = await req('GET', '/entrega/' + b36('5511966660000'))
t(r.st === 302 && r.loc.startsWith(WA_HAY), 'sem pedido, por vendedor: a conversa diz que e do Guilherme e vai pro Haynan', r.loc)
// pedido que acabou de nascer, antes da varredura dar dono
let [nv] = poe(lead({ at: 'vend_kev', wa: '5511955550000' }))
r = await req('GET', '/entrega/' + b36('5511955550000'))
t(r.st === 302 && r.loc.startsWith(WA_BRY), 'pedido ainda sem dono: a regra com o vendedor dele (Kevin -> Bryan)', r.loc)
await batida()
t(doId(nv.id).cob === 'cob_bryan', 'e a varredura da o mesmo dono que o link mostrou', doId(nv.id).cob)
// o cobrador sem numero ativo: cai no de outro cobrador, nunca em link morto
{ const d = ler(); d.chips.forEach((c) => { if (c.at === 'cob_bryan') c.st = 'banido' }); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)) }
r = await req('GET', '/entrega/' + b36('5511911110004'))
t(r.st === 302 && r.loc.startsWith(WA_HAY), 'numero do Bryan caido: o link abre o de outro cobrador', r.loc)
{ const d = ler(); d.chips.forEach((c) => { if (c.at === 'cob_haynan') c.em_uso = false; if (c.at === 'cob_bryan') c.st = 'ativo' }); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)) }
r = await req('GET', '/entrega/' + b36('5515900000001'))
t(r.st === 302 && r.loc.startsWith('https://wa.me/551599'), 'sem numero "Em uso", vale qualquer numero ativo dele', r.loc)

console.log('\nO ENDERECO NOVO: /acompanhar-pedido (o /entrega continua valendo)')
{ const d = ler(); d.chips.forEach((c) => { c.st = 'ativo'; if (c.id === 1 || c.id === 3) c.em_uso = true }); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d)) }
await regra({ modo: 'fixo', alvo: 'cob_bryan' })
r = await req('GET', '/acompanhar-pedido/' + b36('5515900000001'))
t(r.st === 302 && r.loc.startsWith(WA_HAY), '/acompanhar-pedido com telefone abre o dono do pedido', r.loc)
r = await req('GET', '/acompanhar-pedido')
t(r.st === 302 && r.loc.startsWith(WA_BRY), '/acompanhar-pedido sem telefone segue a regra', r.loc)
r = await req('GET', '/entrega/' + b36('5515900000001'))
t(r.st === 302 && r.loc.startsWith(WA_HAY), '/entrega (mensagem ja mandada) continua funcionando', r.loc)
r = await req('GET', '/api/cob/regra', TK.dir)
const nomes = ((r.j && r.j.cobradores) || []).map((c) => c.name).sort().join(',')
t(nomes === 'Bryan,Haynan', 'a tela recebe os cobradores com nome', nomes)
t((r.j.vendedores || []).map((v) => v.name).join(',') === 'Barbara,Guilherme,Kevin', 'e os vendedores da casa', (r.j.vendedores || []).map((v) => v.name).join(','))
t(r.j.numeros && r.j.numeros.cob_bryan === '5511927335679' && r.j.numeros.cob_haynan === '5515991980514', 'e o WhatsApp que o link abre de cada um', JSON.stringify(r.j.numeros))
t(r.j.link === 'https://sellwave.com.br/acompanhar-pedido', 'o link mostrado e o novo', r.j.link)

console.log('\n' + ok + ' de ' + (ok + mau) + ' conferencias passaram')
process.exit(mau ? 1 : 0)
