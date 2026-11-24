// DESLIGADO COM ACESSO RESTRITO (23/11/2026, ver _gateDesligado no worker).
//
// Pedido do Bruno pro funcionario que vai sair: "quero que ele continue tendo acesso ainda ao login
// dele. Porem, ele vai ficar acompanhando mais a questao do salario dele, as vendas dele, tudo que
// ele ja fez (...) que ele nao fique espionando nada da nossa operacao, nao tenha acesso ao numero
// dos clientes". E: nada pode mudar pra ele antes de o diretor arquivar.
//
// O QUE ESTE TESTE GUARDA, e cada linha e um jeito de a coisa dar errado:
//  - ANTES DE ARQUIVAR nada muda: a mesma pessoa ve e faz o que sempre viu e fez;
//  - ARQUIVAR "MANTENDO O ACESSO" nao estraga o login nem derruba a sessao, e a pessoa passa a ser
//    `desligado` na ficha (o menu curto da dash nasce disso);
//  - O ESTADO DELE e so dele e SEM O CLIENTE: pedido sem telefone, CPF, endereco, comprovante,
//    rastreio, link; nome encurtado; sem equipe, numero, pressel, conexao; saque e pagamento so dele;
//  - TODA ROTA FORA DA LISTA BRANCA leva 403 com `desligado` (e o que recarrega a aba aberta);
//  - O SELLWAVE WEB DELE FECHA OS NUMEROS: o aluguel volta `revogado` (403 o app ignoraria);
//  - A FILA EM ABERTO dele passa pro outro cobrador na varredura; o PAGO continua dele, com a taxa;
//  - O "VER COMO" do diretor mostra exatamente o mesmo recorte;
//  - CORTAR O ACESSO depois estraga o login, derruba a sessao e ainda fecha o numero que ficou
//    aberto no computador dele (a quarentena vale sem sessao);
//  - devolver o acesso restrito e reativar voltam o login.
//
// Roda o WORKER DE VERDADE (bundle do wrangler) contra um D1 de mentira. Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-desligado.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [bundle] = process.argv.slice(2)
if (!bundle) { console.error('uso: node teste-desligado.mjs <dir>/worker.js'); process.exit(2) }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
// O worker usa `!= ""` (aspas duplas) numa consulta de usuarios; o D1 aceita, o SQLite do Node nao.
const _sqlNode = (s) => String(s).replace(/!= ""/g, "!= ''")
function stmt(sql0, args = []) {
  const sql = _sqlNode(sql0)
  return {
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.all())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const exp = Math.floor(Date.now() / 1000) + 86400
const SENHA = 'senha-de-teste'
const hashLegado = createHash('sha256').update(SENHA).digest('hex')   // o worker aceita o sha256 antigo
const user = (id, login, nome, role, pct, sal) => sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct,salario) VALUES (?,?,?,?,?,?,?,?)')
  .run(id, login, hashLegado, nome, nome.slice(0, 2).toUpperCase(), role, pct || 0, sal || 0)
user('dir', 'dir', 'Diretor', 'diretor', 0)
user('cob_a', 'cobra', 'Cobrador A', 'cobrador', 3, 600)
user('cob_b', 'cobrb', 'Cobrador B', 'cobrador', 3, 600)
user('vend_gui', 'gui', 'Vendedor', 'atendente', 12)
const TK = { dir: 'd'.repeat(64), a: 'a'.repeat(64), b: 'b'.repeat(64) }
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.dir, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.a, 'cob_a', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.b, 'cob_b', exp)
sq.prepare("INSERT INTO push_subs (endpoint,user_id,p256dh,auth) VALUES ('https://push/b','cob_b','x','y')").run()

const DESDE = Date.UTC(2026, 10, 1, 3, 0, 0)
const DIA = 86400000
// Um pedido com TUDO que um pedido de verdade carrega de cliente.
const cliente = {
  nome: 'maria aparecida da silva', wa: '5511988887777', cpf: '12345678909', email: 'cliente@exemplo.com',
  end: 'Rua das Flores', num: '10', comp: 'casa 2', bairro: 'Centro', cidade: 'Campinas', uf: 'SP', cep: '13010000',
  obs: 'ligar depois das 18h', comments: [{ t: 'cliente pediu desconto', who: 'cob_b' }], comprovante_url: 'https://arquivo/c.jpg',
  comprovante_mime: 'image/jpeg', comprovantes: ['https://arquivo/c2.jpg'], entrega_url: 'https://arquivo/e.jpg', entrega_mime: 'image/jpeg',
  entrega_assinante: 'Joao da Silva', entrega_assin_url: 'https://arquivo/a.jpg', track: 'AP123456789BR', track_core: 'AP123456789BR',
  link: 'https://pagar/x', pago_link: 'https://pagar/y', external_id: 'MAN-1', aceito_por: 'dir', five_id: 'PL-ORDX', fu: '', trat: 'Glico Six - 3 Meses',
}
const lead = (id, extra) => ({ id, ...cliente, at: 'vend_gui', col: 'Enviado', vl: 497, prod: 'Glico Six', mod: 'entrega', pgto: 'pix',
  hist: [{ from: '-', to: 'A Enviar', who: 'vend_gui', time: '05/11 10:00', note: 'nota com o nome da cliente' }], ...extra })
const estado = {
  leads: [
    lead('P1', { cob: 'cob_b', col: 'Pagos', spg: 'Pago', pago_ts: DESDE + 2 * DIA, cob_pct: 3,
      pagamentos: [{ ts: DESDE + 2 * DIA, data: '03/11/2026', valor: 450, obs: 'pago pelo app', who: 'cob_b', print: 'https://arquivo/p.jpg' }],
      hist: [{ from: 'Cobrança', to: 'Pagos', who: 'cob_b', time: '2026-11-03T12:00:00.000Z', note: 'pix da cliente' }] }),
    lead('A1', { cob: 'cob_b', col: 'Cobrança', agend: '2026-11-30T09:00' }),
    lead('A2', { cob: 'cob_b', col: 'A Enviar' }),
    lead('F1', { cob: 'cob_b', col: 'Roubos' }),
    lead('R1', { cob: 'cob_b', col: 'Enviado', vl: 0, tags: ['reenvio', 'vip'] }),
    lead('O1', { cob: 'cob_a', col: 'Cobrança' }),
    lead('X1', { cob: 'cob_a', at: 'vend_gui', col: 'Pagos', spg: 'Pago', pago_ts: DESDE + DIA, cob_pct: 3 }),
    // dono que NAO saiu (vendedor ativo) fica onde esta; dono que sumiu do banco volta pra divisao
    lead('G1', { cob: 'vend_gui', col: 'Cobrança' }),
    lead('Z1', { cob: 'gente_que_sumiu', col: 'Cobrança' }),
  ],
  saques: [{ id: 1, user_id: 'cob_b', valor: 50, status: 'pago' }, { id: 2, user_id: 'vend_gui', valor: 900, status: 'pendente' }],
  lancamentos: [
    { id: 1, tipo: 'pagamento_equipe', at: 'cob_b', categoria: 'Salário', valor: 600, dt: '2026-11-05' },
    { id: 2, tipo: 'pagamento_equipe', at: 'vend_gui', categoria: 'Comissões', valor: 2000, dt: '2026-11-05' },
    { id: 3, tipo: 'despesa', at: 'cob_b', categoria: 'Outros', valor: 99, dt: '2026-11-05' },
  ],
  notifs: [{ id: 1, to: 'cob_b', txt: 'saque pago' }, { id: 2, to: 'todos', txt: 'meta da semana' }, { id: 3, to: 'vend_gui', txt: 'venda' }],
  regras: { kits: [{ nome: '3 Meses', preco: 497 }], fixos: [{ nome: 'Salario - Cobrador B', valor: 600 }] },
  app: { visual: { cor: '#24c278' } },
  chips: [{ id: 'c1', num: '5511977776666', at: 'cob_b', st: 'Em uso' }],
  pressels: [{ id: 'p1', nome: 'Pressel da casa' }],
  salechat: { roteiro: 'segredo' }, gastos: [{ valor: 1 }], custos_produtor: { frasco: 30 },
}
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,0,?)').run(JSON.stringify(estado), 'teste')

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-desligado.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }
const pend = []
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} }
const calado = async (fn) => {
  const ol = console.log, oe = console.error
  console.log = () => {}; console.error = () => {}
  try { return await fn() } finally { console.log = ol; console.error = oe }
}
const batida = async () => {
  let alvo = Math.floor(Date.now() / 60000)
  while (alvo % 5 !== 1) alvo++
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run()
  await calado(async () => { await worker.scheduled({ scheduledTime: alvo * 60000, cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift() })
}
const chama = async (tk, metodo, caminho, corpo, extra) => {
  const h = { 'content-type': 'application/json', ...(extra || {}) }
  if (tk) h.authorization = 'Bearer ' + tk
  const r = await calado(() => worker.fetch(new Request('https://x' + caminho, { method: metodo, headers: h, body: corpo == null ? undefined : JSON.stringify(corpo) }), env, ctx))
  const txt = await r.text()
  let j = {}; try { j = JSON.parse(txt) } catch (_) { j = {} }
  return { st: r.status, j }
}
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data)
const doId = (id) => (ler().leads || []).find((l) => l.id === id) || {}
const linhaUser = (id) => sq.prepare('SELECT * FROM users WHERE id=?').get(id)
const nSessoes = (id) => Number(sq.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(id).n)

let ok = 0, mau = 0
const t = (c, o, d) => { if (c) { ok++; console.log('  ok    ' + o) } else { mau++; console.log('  FALHOU ' + o + (d ? '  -> ' + d : '')) } }

console.log('\nANTES DE ARQUIVAR NADA MUDA')
let r = await chama(TK.b, 'GET', '/auth/me')
t(r.st === 200 && r.j.user && r.j.user.desligado === false, 'a ficha dele diz desligado=false', JSON.stringify(r.j.user && r.j.user.desligado))
r = await chama(TK.b, 'GET', '/api/state')
t(r.st === 200 && (r.j.data.leads || []).length === 9, 'o cobrador ativo ve a base inteira (9 pedidos)', String((r.j.data.leads || []).length))
t(((r.j.data.leads || []).find((l) => l.id === 'P1') || {}).wa === cliente.wa, 'e com o telefone do cliente (como sempre)')
r = await chama(TK.b, 'GET', '/api/podio')
t(!r.j.desligado, 'rota fora da lista branca NAO leva o 403 de desligado', JSON.stringify(r.j).slice(0, 120))

console.log('\nARQUIVAR MANTENDO O ACESSO')
r = await chama(TK.dir, 'DELETE', '/api/users/cob_b?manter=1')
t(r.st === 200 && r.j.action === 'desligado', 'o diretor arquiva com ?manter=1', JSON.stringify(r.j))
let u = linhaUser('cob_b')
t(Number(u.archived) === 1 && u.archived_at > 0, 'ficou arquivado, com a data')
t(u.login === 'cobrb', 'o login NAO ganhou sufixo', u.login)
t(nSessoes('cob_b') === 1, 'a sessao dele continua viva')
t(Number(sq.prepare("SELECT COUNT(*) n FROM push_subs WHERE user_id='cob_b'").get().n) === 0, 'o aviso no celular dele saiu')
r = await chama(TK.a, 'DELETE', '/api/users/vend_gui?manter=1')
t(r.st === 403, 'so o diretor arquiva', String(r.st))

console.log('\nA FICHA E O LOGIN DELE')
r = await chama(TK.b, 'GET', '/auth/me')
t(r.st === 200 && r.j.user.desligado === true, '/auth/me diz desligado=true')
r = await chama(null, 'POST', '/auth/login', { login: 'cobrb', password: SENHA })
t(r.st === 200 && r.j.token && r.j.user.desligado === true, 'ele ainda entra com o mesmo login e ja nasce desligado', JSON.stringify(r.j).slice(0, 160))
const TK_B2 = r.j.token

console.log('\nO ESTADO DELE: SO O QUE E DELE, SEM O CLIENTE')
r = await chama(TK.b, 'GET', '/api/state')
const d = r.j.data || {}
const ids = (d.leads || []).map((l) => l.id).sort().join(',')
t(r.st === 200 && ids === 'A1,A2,F1,P1,R1', 'so os pedidos em que ele e o cobrador', ids)
const PII = ['wa', 'cpf', 'email', 'end', 'num', 'comp', 'bairro', 'cidade', 'uf', 'cep', 'obs', 'comments', 'comprovante_url', 'comprovante_mime',
  'comprovantes', 'entrega_url', 'entrega_mime', 'entrega_assinante', 'entrega_assin_url', 'track', 'track_core', 'link', 'pago_link', 'external_id', 'aceito_por', 'five_id', 'fu']
const vazou = (d.leads || []).flatMap((l) => PII.filter((k) => k in l).map((k) => l.id + '.' + k))
t(!vazou.length, 'nenhum campo de cliente no pedido', vazou.join(' '))
const p1 = (d.leads || []).find((l) => l.id === 'P1') || {}
t(p1.nome === 'Maria S.', 'o nome vira "Maria S."', p1.nome)
t(p1.vl === 497 && p1.cob_pct === 3 && p1.spg === 'Pago' && p1.pago_ts === DESDE + 2 * DIA && p1.trat === cliente.trat, 'o que a conta da comissao usa continua la')
t(JSON.stringify(p1.hist) === JSON.stringify([{ from: 'Cobrança', to: 'Pagos', time: '2026-11-03T12:00:00.000Z' }]), 'o historico fica so com coluna e hora (sem quem e sem nota)', JSON.stringify(p1.hist))
t(JSON.stringify(p1.pagamentos) === JSON.stringify([{ ts: DESDE + 2 * DIA, data: '03/11/2026', valor: 450 }]), 'o pagamento fica so com data e valor', JSON.stringify(p1.pagamentos))
const r1 = (d.leads || []).find((l) => l.id === 'R1') || {}
t(JSON.stringify(r1.tags) === '["reenvio"]', 'das etiquetas fica so a de reenvio (muda conta)', JSON.stringify(r1.tags))
t(JSON.stringify((d.saques || []).map((x) => x.id)) === '[1]', 'saque: so o dele', JSON.stringify(d.saques))
t(JSON.stringify((d.lancamentos || []).map((x) => x.id)) === '[1]', 'pagamentos feitos: so o salario dele', JSON.stringify(d.lancamentos))
t(JSON.stringify((d.notifs || []).map((x) => x.id)) === '[1]', 'aviso: so o endereçado a ele (nem o "todos")', JSON.stringify(d.notifs))
t(JSON.stringify(d.regras) === JSON.stringify({ kits: estado.regras.kits }), 'regras: so o catalogo de kits (a folha sai)', JSON.stringify(d.regras))
t(d.app && d.app.visual && d.app.visual.cor === '#24c278', 'o visual do app vem')
const sobra = Object.keys(d).filter((k) => !['leads', 'saques', 'lancamentos', 'notifs', 'regras', 'app', 'team'].includes(k))
t(!sobra.length, 'nenhuma outra chave do estado (numero, pressel, roteiro, gasto, custo)', sobra.join(' '))
t(Array.isArray(d.team) && d.team.length === 0, 'equipe vazia')

console.log('\nA LISTA DE USUARIOS: SO A LINHA DELE')
r = await chama(TK.b, 'GET', '/api/users')
t(r.st === 200 && (r.j.users || []).length === 1 && r.j.users[0].id === 'cob_b' && Number(r.j.users[0].salario) === 600 && Number(r.j.users[0].com_pct) === 3,
  'so ele, com salario e comissao', JSON.stringify(r.j.users))

console.log('\nO RESTO E FECHADO (403 com a marca que recarrega a aba)')
for (const [m, p, c] of [['POST', '/api/state', { data: {} }], ['POST', '/api/saque/create', { valor: 10 }], ['GET', '/api/podio'], ['GET', '/api/afiliados'],
  ['POST', '/api/users', { id: 'cob_b', name: 'X', login: 'cobrb', role: 'cobrador' }], ['GET', '/api/five/orders'], ['POST', '/api/lead/P1', { patch: { obs: 'x' } }],
  ['POST', '/api/push/sub', { endpoint: 'https://push/b2' }], ['GET', '/api/bot/config'], ['GET', '/api/wa/chats'], ['GET', '/api/swweb/roteiro'], ['GET', '/api/state/arquivo']]) {
  r = await chama(TK.b, m, p, c)
  t(r.st === 403 && r.j.desligado === true, m + ' ' + p + ' -> 403 desligado', r.st + ' ' + JSON.stringify(r.j).slice(0, 100))
}
r = await chama(TK.b, 'GET', '/api/state/pulso')
t(r.st === 200, 'GET /api/state/pulso passa (o app pergunta a versao)', String(r.st))

console.log('\nO SELLWAVE WEB DELE FECHA OS NUMEROS')
r = await chama(TK.b, 'POST', '/api/swweb/uso', { nk: '1177776666' }, { 'x-sw-maquina': 'maq-b' })
t(r.st === 200 && r.j.ok === false && r.j.revogado === true, 'o aluguel do numero volta revogado (o app fecha)', JSON.stringify(r.j))
r = await chama(TK.b, 'GET', '/api/swweb/numeros', null, { 'x-sw-maquina': 'maq-b' })
t(r.st === 200 && Array.isArray(r.j.numeros) && r.j.numeros.length === 0, 'a lista de numeros volta vazia', JSON.stringify(r.j))

console.log('\nA FILA EM ABERTO PASSA PRO OUTRO COBRADOR; O PAGO FICA')
await batida()
t(doId('A1').cob === 'cob_a' && doId('A2').cob === 'cob_a', 'os dois em aberto foram pro cobrador ativo', doId('A1').cob + ' ' + doId('A2').cob)
t(Number(doId('A1').cob_ts) > 0, 'com o carimbo de troca (a conversa velha nao desfaz)')
t(doId('P1').cob === 'cob_b' && doId('P1').cob_pct === 3, 'o pago continua dele, com a taxa congelada')
t(doId('F1').cob === 'cob_b', 'o encerrado (roubo) continua dele')
t(doId('R1').cob === 'cob_b', 'o reenvio sem cobranca nao entra na divisao')
t(doId('O1').cob === 'cob_a', 'o do outro cobrador nao mexe')
t(doId('G1').cob === 'vend_gui', 'dono ativo que nao e cobrador NAO conta como quem saiu (so por prova)', doId('G1').cob)
t(doId('Z1').cob === 'cob_a', 'dono que sumiu do banco volta pra divisao', doId('Z1').cob)
const v1 = Number(sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version)
await batida()
t(Number(sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version) === v1, 'rodar de novo nao mexe em nada')
r = await chama(TK.b, 'GET', '/api/state')
t((r.j.data.leads || []).map((l) => l.id).sort().join(',') === 'F1,P1,R1', 'o estado dele agora tem so o que ficou dele', (r.j.data.leads || []).map((l) => l.id).join(','))

console.log('\nO "VER COMO" DO DIRETOR MOSTRA O MESMO RECORTE')
r = await chama(TK.dir, 'GET', '/auth/me?como=cob_b')
t(r.st === 200 && r.j.user && r.j.user.id === 'cob_b' && r.j.user.desligado === true, 'a ficha do preview diz desligado', JSON.stringify(r.j.user).slice(0, 120))
r = await chama(TK.dir, 'GET', '/api/state?como=cob_b')
const dComo = r.j.data || {}
t((dComo.leads || []).map((l) => l.id).sort().join(',') === 'F1,P1,R1' && !('wa' in ((dComo.leads || [])[0] || {})), 'o estado do preview e o dele, sem cliente')
r = await chama(TK.dir, 'GET', '/api/podio?como=cob_b')
t(r.st === 403 && r.j.desligado, 'no preview a rota fechada tambem fecha')
r = await chama(TK.dir, 'GET', '/api/state')
t((r.j.data.leads || []).length === 9 && (r.j.data.leads || [])[0].wa === cliente.wa, 'o diretor, sem preview, continua vendo tudo')
r = await chama(TK.a, 'GET', '/api/state')
t((r.j.data.leads || []).length === 9 && !r.j.data.desligado, 'o outro cobrador nao foi afetado')

console.log('\nCORTAR O ACESSO DEPOIS')
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER)')   // o app dele com o numero aberto
sq.prepare("INSERT INTO swweb_uso (nk,user_id,nome,maquina,desde,ate) VALUES ('1177776666','cob_b','Cobrador B','maq-b',0,?)").run(exp)
const arqAntes = Number(linhaUser('cob_b').archived_at)
r = await chama(TK.dir, 'DELETE', '/api/users/cob_b')
t(r.st === 200 && r.j.action === 'archived', 'o diretor corta (arquivar sem manter)', JSON.stringify(r.j))
u = linhaUser('cob_b')
t(/^cobrb_arch_\d+$/.test(u.login), 'o login ganhou o sufixo (nao entra mais)', u.login)
t(Number(u.archived_at) === arqAntes, 'a data da saida nao mudou')
t(nSessoes('cob_b') === 0, 'as sessoes cairam')
r = await chama(null, 'POST', '/auth/login', { login: 'cobrb', password: SENHA })
t(r.st === 401, 'o login antigo nao entra mais', String(r.st))
r = await chama(TK_B2, 'POST', '/api/swweb/uso', { nk: '1177776666' }, { 'x-sw-maquina': 'maq-b' })
t(r.st === 200 && r.j.revogado === true, 'o numero que ficou aberto no computador dele recebe revogado mesmo sem sessao', r.st + ' ' + JSON.stringify(r.j))
r = await chama(TK_B2, 'POST', '/api/swweb/uso', { nk: '1177776666' }, { 'x-sw-maquina': 'outra-maq' })
t(r.st === 401, 'outra maquina sem sessao continua levando 401', String(r.st))
r = await chama(TK_B2, 'POST', '/api/swweb/uso', { nk: '1100001111' }, { 'x-sw-maquina': 'maq-b' })
t(r.st === 401, 'outro numero sem quarentena continua levando 401', String(r.st))
r = await chama(TK.dir, 'DELETE', '/api/users/cob_b')
t(/^cobrb_arch_\d+$/.test(linhaUser('cob_b').login), 'cortar de novo nao dobra o sufixo', linhaUser('cob_b').login)

console.log('\nDEVOLVER O ACESSO RESTRITO E REATIVAR')
r = await chama(TK.dir, 'DELETE', '/api/users/cob_b?manter=1')
t(r.st === 200 && r.j.login === 'cobrb' && linhaUser('cob_b').login === 'cobrb', 'o cadeado aberto devolve o login', JSON.stringify(r.j))
r = await chama(null, 'POST', '/auth/login', { login: 'cobrb', password: SENHA })
t(r.st === 200 && r.j.user.desligado === true, 'entra de novo, desligado')
const TK_B3 = r.j.token
r = await chama(TK.dir, 'POST', '/api/users/cob_b/restore')
t(r.st === 200 && Number(linhaUser('cob_b').archived) === 0, 'reativar tira o arquivado')
r = await chama(TK_B3, 'GET', '/auth/me')
t(r.st === 200 && r.j.user.desligado === false, 'e a ficha volta a desligado=false', JSON.stringify(r.j.user && r.j.user.desligado))
r = await chama(TK_B3, 'GET', '/api/state')
t((r.j.data.leads || []).length === 9, 'e ele volta a ver a base inteira de cobrador', String((r.j.data.leads || []).length))

console.log('\n' + ok + ' ok, ' + mau + ' falha(s)')
process.exit(mau ? 1 : 0)
