// O PEDIDO PASSA A TER DONO DE COBRANCA (29/10/2026, lead.cob + lead.cob_pct).
//
// Pedido do Bruno: o cobrador sai do salario fixo e passa a fixo + comissao ("3%, que vai dar mais
// ou menos uns R$ 15 por venda"), e "futuramente, quando eu adicionar um outro cobrador, na area de
// cobranca apareceriam apenas os compradores designados para ele".
//
// O QUE ESTE TESTE GUARDA, e cada linha e um jeito de a coisa dar errado:
//  - COM UM COBRADOR nada muda na pratica: tudo vai pra ele. E a situacao de hoje, e se este teste
//    quebrar o Haynan para de ver a propria fila;
//  - COM DOIS, divide pelo que tem MENOS PEDIDO EM ABERTO. Dividir por quantidade total daria a
//    impressao de justica e entregaria o dobro de trabalho pra quem ja esta afogado, porque pedido
//    encerrado nao ocupa ninguem;
//  - A PORCENTAGEM CONGELA NO PEDIDO. Sem isso, mudar a taxa de 3 pra 4 muda o mes passado que ja
//    foi pago - exatamente o bug que o Guilherme pegou em 06/10/2026, comissao de dia fechado
//    mudando sozinha de madrugada;
//  - OUTUBRO NAO PAGA COMISSAO. A decisao do Bruno e "de novembro em diante"; pedido pago antes de
//    01/11 nao pode receber carimbo nenhum, senao ele ganha retroativo que ninguem combinou;
//  - PEDIDO DE AFILIADO FICA DE FORA. Ali a casa fica com 35% da venda e 3% do valor cheio sairia
//    caro pelo que ela recebe;
//  - TROCAR O COBRADOR NA MAO e de DIRETOR, e so pra quem e cobrador de verdade. Um id qualquer no
//    corpo nao pode virar dono de pedido;
//  - E a varredura e IDEMPOTENTE: rodar de novo nao pode mexer em nada, senao ela briga de CAS com
//    o resto da dash de minuto em minuto a toa.
//
// Roda a VARREDURA DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cobrador-comissao.mjs <dir>/worker.js
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
// Rede DEVOLVE 404, nao explode: a batida da agenda chama varias coisas antes da nossa, e uma
// excecao la em cima pularia a varredura do cobrador sem o teste perceber (ele passaria "verde"
// sem ter rodado nada). Com 404 cada uma sai pelo caminho de erro dela e a batida chega no fim.
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const exp = Math.floor(Date.now() / 1000) + 86400
const user = (id, login, nome, role, pct) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct) VALUES (?,?,?,?,?,?,?)')
  .run(id, login, 'x', nome, nome.slice(0, 2).toUpperCase(), role, pct || 0)
user('dir', 'dir', 'Diretor', 'diretor', 0)
user('cob_haynan', 'haynan', 'Haynan', 'cobrador', 3)
user('vend_gui', 'gui', 'Guilherme', 'atendente', 12)
const TK = { dir: 'd'.repeat(64), gui: 'b'.repeat(64) }
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.dir, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.gui, 'vend_gui', exp)

// 01/11/2026 00:00 BRT, o mesmo marco do worker, em ms
const DESDE = Date.UTC(2026, 10, 1, 3, 0, 0)
const DIA = 86400000
const lead = (id, extra) => ({ id, nome: 'Cliente ' + id, at: 'vend_gui', col: 'Enviado', vl: 497, hist: [], ...extra })

const estado = {
  leads: [
    // em aberto, na rua: e carga de verdade pra quem receber
    lead('L1'),
    lead('L2', { col: 'Cobrança' }),
    lead('L3', { col: 'Retirada' }),
    lead('L4', { col: 'A Enviar' }),
    // ENCERRADOS: nao ocupam ninguem (entram na divisao, mas nao contam carga)
    lead('L5', { col: 'Cancelado sem Custo' }),
    lead('L6', { col: 'Roubos' }),
    // PAGO EM OUTUBRO: o Bruno decidiu que outubro fecha no fixo, entao nada de carimbo
    lead('L7', { col: 'Pagos', spg: 'Pago', pago_ts: DESDE - 5 * DIA, pagamentos: [{ ts: DESDE - 5 * DIA, valor: 497 }] }),
    // PAGO EM NOVEMBRO: este sim rende comissao
    lead('L8', { col: 'Pagos', spg: 'Pago', pago_ts: DESDE + 2 * DIA, pagamentos: [{ ts: DESDE + 2 * DIA, valor: 450 }] }),
    // DO AFILIADO: fora da divisao da casa
    lead('L9', { col: 'Cobrança', afl: 'afl_3d767329' }),
  ],
  chips: [], pressels: [],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,0,?)').run(JSON.stringify(estado), 'teste')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-cobrador.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }
const pend = []
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} }

// A batida do passo 'agenda' (RODIZIO = conexao, agenda, conexao, agenda, manutencao -> resto 1).
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
const versao = () => Number(sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version)
const doId = (id) => (ler().leads || []).find((l) => l.id === id) || {}
const api = async (tk, id, patch) => {
  const r = await worker.fetch(new Request('https://x/api/lead/' + id, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nUM COBRADOR SO: vai tudo pra ele (e a operacao de hoje)')
await batida()
const casa = () => (ler().leads || []).filter((l) => !l.afl)
t(casa().every((l) => l.cob === 'cob_haynan'), 'todo pedido da casa ficou com o Haynan',
  JSON.stringify(casa().map((l) => l.id + ':' + (l.cob || '-'))))
t(!doId('L9').cob, 'o pedido do AFILIADO nao entra na divisao da casa', JSON.stringify(doId('L9').cob))

console.log('\nA PORCENTAGEM CONGELA NO PEDIDO, e so de novembro em diante')
t(doId('L8').cob_pct === 3, 'pedido pago em novembro carimbou 3%', String(doId('L8').cob_pct))
t(doId('L7').cob_pct === undefined, 'pedido pago em OUTUBRO nao carimbou nada (outubro fecha no fixo)', String(doId('L7').cob_pct))
t(doId('L1').cob_pct === undefined, 'pedido que ainda nao foi pago tambem nao carimba', String(doId('L1').cob_pct))

console.log('\nRODAR DE NOVO NAO MEXE EM NADA (senao briga de CAS com a dash toda batida)')
const v1 = versao()
await batida()
t(versao() === v1, 'a versao do estado nao andou na segunda batida', v1 + ' -> ' + versao())

console.log('\nMUDAR A TAXA NAO MEXE NO QUE JA FOI PAGO')
sq.prepare("UPDATE users SET com_pct=4 WHERE id='cob_haynan'").run()
await batida()
t(doId('L8').cob_pct === 3, 'o pedido de novembro continua com os 3% que valiam quando ele pagou', String(doId('L8').cob_pct))

console.log('\nPEDIDO NOVO JA PAGO PEGA A TAXA DE AGORA')
{
  const d = ler()
  d.leads.push(lead('L10', { col: 'Pagos', spg: 'Pago', pago_ts: DESDE + 9 * DIA, pagamentos: [{ ts: DESDE + 9 * DIA, valor: 497 }] }))
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
}
await batida()
t(doId('L10').cob === 'cob_haynan' && doId('L10').cob_pct === 4, 'o pedido novo saiu com 4%, a taxa de agora',
  JSON.stringify({ cob: doId('L10').cob, pct: doId('L10').cob_pct }))

console.log('\nDOIS COBRADORES: divide pelo que tem MENOS PEDIDO EM ABERTO')
user('cob_novo', 'novo', 'Cobrador Novo', 'cobrador', 4)
{
  // cinco pedidos novos em aberto. O Haynan ja carrega 4 em aberto (L1..L4) e o novo carrega 0:
  // os primeiros tem que ir TODOS pro novo ate empatar, e so depois alternar.
  const d = ler()
  for (let i = 1; i <= 5; i++) d.leads.push(lead('N' + i, { col: 'Enviado' }))
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
}
await batida()
const novos = ['N1', 'N2', 'N3', 'N4', 'N5'].map((id) => doId(id).cob)
t(novos.filter((c) => c === 'cob_novo').length === 4, 'os 4 primeiros foram pro cobrador novo, que estava com zero', JSON.stringify(novos))
t(novos.filter((c) => c === 'cob_haynan').length === 1, 'e o quinto voltou pro Haynan, ja empatados', JSON.stringify(novos))
{
  const emAberto = (quem) => casa().filter((l) => l.cob === quem && !['Pago', 'Pagos'].includes(l.col)
    && !['Cancelado sem Custo', 'Roubos'].includes(l.col)).length
  t(Math.abs(emAberto('cob_haynan') - emAberto('cob_novo')) <= 1, 'a carga em aberto ficou emparelhada',
    emAberto('cob_haynan') + ' x ' + emAberto('cob_novo'))
}

console.log('\nTROCAR O COBRADOR NA MAO: so o diretor, e so pra quem e cobrador')
let r = await api(TK.dir, 'L2', { cob: 'cob_novo' })
t(r.st === 200 && doId('L2').cob === 'cob_novo', 'o diretor passa o pedido pro outro cobrador', JSON.stringify(r.j))
r = await api(TK.gui, 'L2', { cob: 'cob_haynan' })
t((r.j.negados || []).includes('cob') && doId('L2').cob === 'cob_novo', 'o vendedor NAO troca o cobrador do pedido', JSON.stringify(r.j))
r = await api(TK.dir, 'L2', { cob: 'vend_gui' })
t((r.j.negados || []).includes('cob') && doId('L2').cob === 'cob_novo', 'um id que nao e de cobrador e recusado', JSON.stringify(r.j))

console.log('\nPASSAR UM PEDIDO PAGO LEVA A COMISSAO JUNTO')
r = await api(TK.dir, 'L10', { cob: 'cob_novo' })
t(doId('L10').cob === 'cob_novo' && doId('L10').cob_pct === 4, 'o pedido pago mudou de dono e recarimbou a taxa do novo dono',
  JSON.stringify({ cob: doId('L10').cob, pct: doId('L10').cob_pct }))
r = await api(TK.dir, 'L7', { cob: 'cob_novo' })
t(doId('L7').cob === 'cob_novo' && doId('L7').cob_pct === undefined, 'mas o pago em OUTUBRO continua sem comissao depois da troca',
  JSON.stringify({ cob: doId('L7').cob, pct: doId('L7').cob_pct }))

console.log('\nTIRAR O COBRADOR devolve o pedido pra fila')
r = await api(TK.dir, 'L3', { cob: '' })
t(doId('L3').cob === undefined, 'o campo saiu do pedido', JSON.stringify(doId('L3').cob))
await batida()
t(!!doId('L3').cob, 'e a proxima batida deu um dono novo pra ele', JSON.stringify(doId('L3').cob))

console.log('\n' + ok + ' de ' + (ok + mau) + ' conferencias passaram')
process.exit(mau ? 1 : 0)
