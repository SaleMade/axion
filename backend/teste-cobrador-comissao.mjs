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

console.log('\nA DIRECAO TAMBEM COBRA (09/11/2026): o Bruno ou o socio ficam com o pedido, e ninguem ganha os 3%')
user('socio_bruno', 'bruno', 'Bruno', 'socio', 0)
sq.prepare("UPDATE users SET com_pct=10 WHERE id='dir'").run()   // taxa de VENDA do diretor: nao pode virar taxa de cobranca
r = await api(TK.dir, 'L10', { cob: 'dir' })
t(r.st === 200 && !(r.j.negados || []).includes('cob') && doId('L10').cob === 'dir', 'o diretor pode ficar com um pedido pago', JSON.stringify(r.j))
t(doId('L10').cob_pct === undefined, 'e o pedido deixa de render comissao de cobrador (direcao entra com taxa zero, nunca com os 10% de venda)', String(doId('L10').cob_pct))
await batida()
t(doId('L10').cob === 'dir' && doId('L10').cob_pct === undefined, 'a varredura nao devolve o pedido pra um cobrador nem carimba taxa nele',
  JSON.stringify({ cob: doId('L10').cob, pct: doId('L10').cob_pct }))
r = await api(TK.dir, 'L1', { cob: 'socio_bruno' })
t(r.st === 200 && doId('L1').cob === 'socio_bruno' && doId('L1').cob_ts > 0, 'o socio tambem pode ser o dono de um pedido em aberto', JSON.stringify(r.j))
await batida()
t(doId('L1').cob === 'socio_bruno', 'pedido em aberto no nome do socio continua com ele depois da varredura', String(doId('L1').cob))
r = await api(TK.gui, 'L4', { cob: 'socio_bruno' })
t((r.j.negados || []).includes('cob') && doId('L4').cob !== 'socio_bruno', 'o vendedor continua sem poder escolher quem cobra', JSON.stringify(r.j))
r = await api(TK.dir, 'L4', { cob: 'gestor_x' })
t((r.j.negados || []).includes('cob'), 'id que nao e cobrador nem direcao segue recusado', JSON.stringify(r.j))
user('dir_velho', 'velho', 'Diretor Antigo', 'diretor', 0)
sq.prepare("UPDATE users SET archived=1 WHERE id='dir_velho'").run()
r = await api(TK.dir, 'L4', { cob: 'dir_velho' })
t((r.j.negados || []).includes('cob') && doId('L4').cob !== 'dir_velho', 'direcao ARQUIVADA nao pode ser dona', JSON.stringify(r.j))
user('cob_afl', 'cobafl', 'Cobrador do Giovane', 'cobrador', 3)
sq.prepare("UPDATE users SET afiliado_id='afl_3d767329' WHERE id='cob_afl'").run()
r = await api(TK.dir, 'L4', { cob: 'cob_afl' })
t((r.j.negados || []).includes('cob') && doId('L4').cob !== 'cob_afl', 'cobrador DE AFILIADO nao e cobrador da casa', JSON.stringify(r.j))
r = await api(TK.dir, 'L9', { cob: 'cob_haynan' })
t((r.j.negados || []).includes('cob') && !doId('L9').cob, 'pedido DE AFILIADO nao recebe cobrador da casa nem pela ficha', JSON.stringify({ j: r.j, cob: doId('L9').cob }))

console.log('\nA CONFIRMACAO DE PAGO DA DASH manda valor, Pagos e "quem cobrou" no MESMO patch (09/11/2026)')
{
  const d = ler()
  d.leads.push(lead('P1', { col: 'Cobrança', cob: 'cob_haynan' }))
  d.leads.push(lead('P2', { col: 'Cobrança', cob: 'cob_haynan' }))
  d.leads.push(lead('P3', { col: 'Cobrança', cob: 'cob_haynan' }))
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
}
r = await api(TK.dir, 'P1', { col: 'Pagos', spg: 'Pago', valor_neg: 450, cob: 'dir' })
t(r.st === 200 && doId('P1').cob === 'dir' && doId('P1').col === 'Pagos' && doId('P1').spg === 'Pago' && doId('P1').pago_ts > 0,
  'pago, valor e quem cobrou gravam juntos', JSON.stringify({ st: r.st, j: r.j, l: { cob: doId('P1').cob, col: doId('P1').col, spg: doId('P1').spg } }))
await batida()
t(doId('P1').cob === 'dir' && doId('P1').cob_pct === undefined, 'cobrado pela direcao: a varredura nao carimba 3% pra ninguem', JSON.stringify({ cob: doId('P1').cob, pct: doId('P1').cob_pct }))
r = await api(TK.dir, 'P2', { col: 'Pagos', spg: 'Pago', valor_neg: 497, cob: 'cob_novo' })
await batida()
t(doId('P2').cob === 'cob_novo' && doId('P2').cob_pct === 4, 'cobrado por OUTRO cobrador: o pedido e a taxa dele (4%) vao pra ele', JSON.stringify({ cob: doId('P2').cob, pct: doId('P2').cob_pct }))
r = await api(TK.dir, 'P3', { col: 'Pagos', spg: 'Pago', valor_neg: 497, cob: 'cob_haynan' })
await batida()
t(doId('P3').cob === 'cob_haynan' && doId('P3').cob_pct === 4 && !doId('P3').cob_ts, 'o mesmo dono confirmado de novo: fica com ele, carimba a taxa, e o cob_ts nao anda (nada trocou)',
  JSON.stringify({ cob: doId('P3').cob, pct: doId('P3').cob_pct, ts: doId('P3').cob_ts }))

console.log('\nO MESMO DONO DE NOVO NAO MEXE NA TAXA CONGELADA (09/11/2026)')
{
  const antes = { ...doId('L8') }   // pago em novembro com 3% congelados; o cadastro do Haynan ja esta em 4%
  r = await api(TK.dir, 'L8', { cob: antes.cob })
  t(r.st === 200 && doId('L8').cob_pct === antes.cob_pct && (doId('L8').cob_ts || 0) === (antes.cob_ts || 0),
    'mandar o dono que ja estava nao apaga os 3% congelados nem move o cob_ts', JSON.stringify({ antes: antes.cob_pct, depois: doId('L8').cob_pct }))
}

console.log('\nTIRAR O COBRADOR devolve o pedido pra fila')
r = await api(TK.dir, 'L3', { cob: '' })
t(doId('L3').cob === undefined, 'o campo saiu do pedido', JSON.stringify(doId('L3').cob))
await batida()
t(!!doId('L3').cob, 'e a proxima batida deu um dono novo pra ele', JSON.stringify(doId('L3').cob))

console.log('\nO CLIENTE ESCREVEU PRO OUTRO COBRADOR: o pedido (e os 3%) vai pra quem ele chamou (03/11/2026)')
try { sq.exec('ALTER TABLE wa_messages ADD COLUMN mundo TEXT') } catch (_) {}
const agS = Math.floor(Date.now() / 1000)
const msg = (id, phone, inst, dir, ts) => sq.prepare('INSERT INTO wa_messages (msg_id,phone,instance,direction,type,body,ts) VALUES (?,?,?,?,?,?,?)').run(id, phone, inst, dir, 'text', 'x', ts)
{
  const d = ler()
  d.chips = [{ id: 'cA', num: '(11) 91111-2222', at: 'cob_haynan' }, { id: 'cB', num: '(11) 93333-4444', at: 'cob_novo' }]
  d.leads.push(lead('C1', { col: 'Cobrança', wa: '31900000001', cob: 'cob_haynan' }))                    // escreveu pro novo: passa
  d.leads.push(lead('C2', { col: 'Cobrança', wa: '31900000002', cob: 'cob_novo' }))                      // escreveu pro dono: fica
  d.leads.push(lead('C3', { col: 'Pagos', spg: 'Pago', pago_ts: DESDE + DIA, wa: '31900000003', cob: 'cob_haynan', cob_pct: 4 }))   // pago: congelado
  d.leads.push(lead('C4', { col: 'Cobrança', wa: '31900000004', cob: 'cob_haynan', cob_ts: Date.now() }))  // trocado na mao DEPOIS da mensagem
  d.leads.push(lead('C5', { col: 'Cobrança', wa: '31900000005', cob: 'cob_haynan' }))                    // o novo mandou e o cliente nunca respondeu
  d.leads.push(lead('C6', { col: 'Cobrança', wa: '31900000006', cob: 'socio_bruno', cob_ts: Date.now() - 60000 }))   // a DIRECAO tomou pra si; o cliente escreveu pro novo depois
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
}
msg('x1', '5531900000001', 'ax_cob_novo_33334444', 'in', agS - 600)
msg('x2', '553100000002', 'ax_cob_novo_33334444', 'in', agS - 600)
msg('x3', '5531900000003', 'ax_cob_novo_33334444', 'in', agS - 600)
msg('x4', '5531900000004', 'ax_cob_novo_33334444', 'in', agS - 600)
msg('x5', '5531900000005', 'ax_cob_novo_33334444', 'out', agS - 600)
msg('x6b', '5531900000006', 'ax_cob_novo_33334444', 'in', agS - 10)
await batida()
t(doId('C6').cob === 'socio_bruno' && doId('C6').cob_pct === undefined, 'pedido que a DIRECAO tomou pra si nao volta pro cobrador pela conversa (09/11/2026)', JSON.stringify({ cob: doId('C6').cob }))
t(doId('C1').cob === 'cob_novo' && doId('C1').cob_ts > 0, 'o pedido do Haynan em que o cliente escreveu pro novo passou pro novo', JSON.stringify({ cob: doId('C1').cob, ts: doId('C1').cob_ts }))
t(doId('C2').cob === 'cob_novo', 'quem escreveu pro proprio dono continua com ele', doId('C2').cob)
t(doId('C3').cob === 'cob_haynan' && doId('C3').cob_pct === 4, 'pedido PAGO nao muda de dono (a comissao ja congelou)', JSON.stringify({ cob: doId('C3').cob, pct: doId('C3').cob_pct }))
t(doId('C4').cob === 'cob_haynan', 'troca manual depois da mensagem vale (a conversa velha nao desfaz)', doId('C4').cob)
t(doId('C5').cob === 'cob_haynan', 'mensagem so do cobrador nao e o cliente chamando', doId('C5').cob)
{
  const v = versao()
  await batida()
  t(versao() === v, 'rodar de novo nao mexe em nada', v + ' -> ' + versao())
}
r = await api(TK.dir, 'C1', { cob: 'cob_haynan' })
await batida()
t(doId('C1').cob === 'cob_haynan', 'a direcao devolve pro Haynan e a conversa de antes nao puxa de volta', doId('C1').cob)
msg('x6', '5531900000001', 'ax_cob_novo_33334444', 'in', Math.floor(Date.now() / 1000) + 5)
await batida()
t(doId('C1').cob === 'cob_novo', 'mas se o cliente escrever de novo pro outro, passa de novo', doId('C1').cob)

console.log('\nO COBRADOR SACA A COMISSAO DELE (03/11/2026: o painel dele ganhou o Solicitar saque)')
{
  sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('e'.repeat(64), 'cob_haynan', exp)
  // a mesma conta do front (comissaoCobrador): taxa congelada no pedido sobre o que foi pago
  const pagoL = (l) => l.spg === 'Pago' || ['Pago', 'Pagos'].includes(l.col)
  const valorL = (l) => { const r = (l.pagamentos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0); return r > 0 ? r : (Number(l.valor_neg) > 0 ? Number(l.valor_neg) : Number(l.vl) || 0) }
  const ganho = Math.round(ler().leads.filter((l) => l.cob === 'cob_haynan' && pagoL(l)).reduce((s, l) => s + valorL(l) * (Number(l.cob_pct) || 0) / 100, 0) * 100) / 100
  const saque = async (valor) => {
    const r = await worker.fetch(new Request('https://x/api/saque/create', {
      method: 'POST', headers: { authorization: 'Bearer ' + 'e'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ valor }),
    }), env, ctx)
    return r.json().catch(() => ({}))
  }
  t(ganho > 0, 'o Haynan tem comissao de novembro pra sacar', String(ganho))
  let s = await saque(ganho)
  t(s.ok && s.saque && s.saque.acima_do_saldo === false, 'sacar a comissao inteira NAO marca "acima do saldo"', JSON.stringify(s.saque || s))
  t(s.saque && Math.abs(Number(s.saque.saldo_servidor) - ganho) < 0.01, 'o saldo que o servidor ve e a comissao dele', String(s.saque && s.saque.saldo_servidor))
  const d = ler(); (d.saques || []).forEach((x) => { if (x.user_id === 'cob_haynan') x.status = 'recusado' })
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d))
  s = await saque(ganho + 50)
  t(s.ok && s.saque && s.saque.acima_do_saldo === true, 'pedir R$ 50 a mais marca "acima do saldo"', JSON.stringify(s.saque || s))
}

console.log('\n' + ok + ' de ' + (ok + mau) + ' conferencias passaram')
process.exit(mau ? 1 : 0)
