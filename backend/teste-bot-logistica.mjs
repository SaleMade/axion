// GRUPO DA LOGISTICA (13/11/2026).
//
// A PayLog pediu: todo pedido pro Ceara tem que ser confirmado no grupo deles antes da postagem. O bot
// manda UMA mensagem por pedido (nome e CPF) e nao faz mais nada la. Este teste recorta do worker.js o
// codigo de verdade (os dois blocos da logistica e as tres guardas do bot de IA) e roda num SQLite em
// memoria, com a fila do bot do PC (bot_outbox) e a tabela five_orders.
//
//   node teste-bot-logistica.mjs            roda as conferencias
//   node teste-bot-logistica.mjs --mutacoes confere que cada conferencia importante pega o defeito
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const entre = (ini, fim) => {
  const i = src.indexOf(ini)
  if (i < 0) throw new Error('nao achei ' + ini)
  const j = src.indexOf(fim, i)
  if (j < 0) throw new Error('nao achei o fim ' + fim)
  return src.slice(i, j)
}
const recorta = (inicio, fim = '\n}\n') => {
  const i = src.indexOf(inicio)
  if (i < 0) throw new Error('nao achei ' + inicio)
  const j = src.indexOf(fim, i)
  return src.slice(i, j + fim.length)
}
const linha = (re) => { const m = re.exec(src); if (!m) throw new Error('nao achei ' + re); return m[0] }
const CODIGO = [
  linha(/const _botHoraOk = [^\n]*\n/),
  linha(/const _botTexto300 = [^\n]*\n/),
  linha(/const _botMinutos = [^\n]*\n/),
  linha(/const _botJidGrupoOk = [^\n]*\n/),
  recorta('function _cpfValido('),
  entre('// ═══ GRUPO DA LOGISTICA (13/11/2026', 'function _botCfgPadrao() {'),
  entre('// ═══ GRUPO DA LOGISTICA: a varredura', '// ═══ BARBADINHO VIVO'),
  recorta('const _botIaEhTeste = ', '\n};\n'),
  recorta('const _botIaGrupoDe = ', '\n};\n'),
  recorta('function _botIaEscuta('),
].join('\n')

// As mutacoes: cada uma tira uma protecao; alguma conferencia TEM que reclamar.
const MUTACOES = [
  ['sem a janela de horario', "if (min < _botMinutos(L.de) || min >= _botMinutos(L.ate)) return;", ''],
  ['sem o freio por hora', 'const vagas = BOT_LOG_HORA - (Number(h && h.n) || 0);', 'const vagas = 99;'],
  ['sem lembrar quem ja foi avisado', ' AND NOT EXISTS (SELECT 1 FROM bot_logistica b WHERE b.code = substr(f.order_id, 4))', ''],
  ['sem o filtro de estado no tick', "f.order_id LIKE 'PL-%' AND \" + _BOT_LOG_UF_SQL\n    + \" AND f.created_at", "f.order_id LIKE 'PL-%' AND (? IS NOT NULL)\"\n    + \" AND f.created_at"],
  ['sem tirar o que ja saiu', " AND COALESCE(f.shipping_status, '') = ''", ''],
  ['sem tirar cancelado', " AND upper(COALESCE(f.charge_status, '')) NOT IN ('CANCELED', 'REFUNDED')", ''],
  ['sem pular CPF invalido', "!_cpfValido(p.cpf) ? 'CPF inválido' : ''", "''"],
  ['sem exigir o bot ligado', '!cfg.ativo || ', ''],
  ['escuta o grupo da logistica', 'return out.filter((j) => !_botLogEhGrupo(cfg, j));', 'return out;'],
  ['grupo de teste pode ser o da logistica', '  if (_botLogEhGrupo(cfg, j)) return false;\n', ''],
  ['sem conferir grupo repetido', "lg && (lg === cfg.grupo.id ||", "false && (lg === cfg.grupo.id ||"],
  ['sem a reserva do manual', " WHERE (bot_logistica.outbox_id IS NULL AND (bot_logistica.por IN ('antes', 'pulou') OR bot_logistica.ts < ?))\"\n      + \" OR (bot_logistica.outbox_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bot_outbox o WHERE o.id = bot_logistica.outbox_id AND o.status = 'pend'))\")", " WHERE ? IS NOT NULL\")"],
  ['sem a janela de 45 dias', ' AND f.created_at > ?', ' AND f.created_at > ? - 999999999'],
  ['sem conferir a palavra entre chaves', 'if (ruins.length) return', 'if (false) return'],
]

async function roda(codigo, quieto) {
  let ok = 0, ruim = 0
  const conta = (nome, bom, detalhe) => {
    if (bom) { ok += 1; if (!quieto) console.log('  ok   ' + nome) } else { ruim += 1; if (!quieto) console.log('  RUIM ' + nome + (detalhe !== undefined ? '  ->  ' + detalhe : '')) }
  }
  const secao = (t) => { if (!quieto) console.log('\n' + t) }

  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE five_orders (order_id TEXT PRIMARY KEY, customer_name TEXT, customer_doc TEXT, customer_address TEXT, created_at INTEGER, shipping_status TEXT, shipping_code TEXT, charge_status TEXT, last_status TEXT);
           CREATE TABLE bot_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, dia TEXT, tipo TEXT, jid TEXT, nome TEXT, texto TEXT, status TEXT, tent INTEGER DEFAULT 0, msg_id TEXT, erro TEXT, feito_ts INTEGER, pego_ts INTEGER, midia TEXT);`)
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
  const agora = Math.floor(Date.now() / 1000)
  let horaBR = 10 * 60   // minutos do dia em Brasilia que o _agoraBR devolve
  let cfg = null
  let agente = { vivo: true, estado: 'open' }
  const stubs = {
    _agoraBR: () => new Date(Date.UTC(2026, 10, 13, Math.floor(horaBR / 60), horaBR % 60)),
    _brDay: () => '2026-11-13',
    _botEnsureTables: async () => {},
    _botCfgLer: async () => cfg,
    _botAgenteEstado: async () => agente,
    _botPodeUsar: (u) => !!u && u.role === 'diretor',
    _botIaPadrao: () => ({ responde: { vend: false, cob: false }, teste: {} }),
    authUser: async (req) => req.__user || null,
    json: (o, s) => ({ ...o, status: s || 200 }),
    err: (m, s) => ({ erro: m, status: s || 400 }),
  }
  const nomes = ['_botLogPadrao', '_botLogNormaliza', '_botLogConfere', '_botLogLigou', '_botLogTexto', '_botLogMarcaExistentes', '_botLogTick', 'handleBotLogistica', '_botIaEscuta', '_botIaEhTeste', '_botIaGrupoDe', '_botLogEhGrupo']
  let F
  try {
    F = new Function(...Object.keys(stubs), codigo + '\nreturn { ' + nomes.join(', ') + ' };')(...Object.values(stubs))
  } catch (e) { return { ok, ruim: ruim + 1, quebrou: String(e.message || e) } }

  const G_LOG = '120363000000000001@g.us', G_VEND = '120363000000000002@g.us', G_COB = '120363000000000003@g.us', G_TESTE = '120363432063011744@g.us'
  const base = () => ({
    ativo: true,
    grupo: { id: G_VEND, nome: 'Vendedores' },
    cobranca: { grupo: { id: G_COB, nome: 'Cobradores' } },
    ia: { responde: { vend: true, cob: true }, teste: { ativo: true, id: G_TESTE, nome: 'Aa', como: 'cob' } },
    logistica: { ativo: true, grupo: { id: G_LOG, nome: 'SellWave x PayLog' }, de: '08:00', ate: '20:00', texto: 'Olá! Temos um novo pedido para o Ceará, podem fazer a postagem.\nCliente: {nome}\nCPF: {cpf}' },
  })
  const end = (uf, cidade = 'Fortaleza') => JSON.stringify({ address: 'Rua X', number: '1', city: cidade, state: uf })
  const poe = (code, o = {}) => db.prepare('INSERT INTO five_orders VALUES (?,?,?,?,?,?,?,?,?)').run('PL-' + code, o.nome ?? 'Maria Lucineide Souza', o.cpf ?? '52998224725', o.end ?? end(o.uf ?? 'CE', o.cidade), o.criado ?? agora - 3600, o.sh ?? null, o.sc ?? null, o.ch ?? null, o.ls ?? 'Cadastrado')
  const fila = () => db.prepare("SELECT * FROM bot_outbox WHERE tipo = 'logistica' ORDER BY id").all()
  const linhaLog = (code) => db.prepare('SELECT * FROM bot_logistica WHERE code = ?').get(code)
  const DIR = { id: 'dir_bruno', name: 'Bruno', role: 'diretor' }

  secao('a configuracao:')
  {
    const p = F._botLogPadrao()
    conta('nasce desligado, sem grupo, das 08:00 as 20:00', p.ativo === false && p.grupo.id === '' && p.de === '08:00' && p.ate === '20:00')
    const n1 = F._botLogNormaliza({ ativo: true }, null)
    conta('ligado sem grupo fica desligado', n1.ativo === false)
    const n2 = F._botLogNormaliza({ ativo: true, grupo: { id: G_LOG, nome: 'X' }, texto: '   ', de: '25:00', ate: '19:00' }, null)
    conta('texto vazio volta pro padrao; hora invalida volta pra base', n2.ativo && /\{nome\}/.test(n2.texto) && n2.de === '08:00' && n2.ate === '19:00', JSON.stringify(n2))
    const n3 = F._botLogNormaliza({ de: '20:00', ate: '09:00' }, { ativo: true, grupo: { id: G_LOG }, de: '07:00', ate: '18:00', texto: 'a' })
    conta('fim antes do comeco fica o horario gravado', n3.de === '07:00' && n3.ate === '18:00' && n3.texto === 'a', JSON.stringify(n3))
    const n4 = F._botLogNormaliza({ grupo: { id: 'grupo-falso' } }, { ativo: true, grupo: { id: G_LOG } })
    conta('grupo com formato errado e recusado (e desliga)', n4.grupo.id === '' && n4.ativo === false)
    const n5 = F._botLogNormaliza({}, { ativo: true, grupo: { id: G_LOG, nome: 'L' }, de: '09:00', ate: '18:00', texto: 'oi {nome}' })
    conta('o que nao veio fica como estava gravado', n5.ativo && n5.grupo.id === G_LOG && n5.de === '09:00' && n5.texto === 'oi {nome}')
  }

  secao('o que impede de gravar:')
  {
    const c = base()
    conta('tudo certo passa', F._botLogConfere({ logistica: c.logistica }, c) === '')
    const semGrupo = base(); semGrupo.logistica.grupo.id = ''
    conta('ligar sem grupo', /Escolha o grupo/.test(F._botLogConfere({ logistica: { ativo: true } }, semGrupo)))
    conta('palavra entre chaves que nao existe', /\{telefone\} não existe/.test(F._botLogConfere({ logistica: { texto: 'oi {nome} {telefone}' } }, c)))
    conta('{cidade} e {codigo} valem', F._botLogConfere({ logistica: { texto: '{nome} {cpf} {cidade} {codigo}' } }, c) === '')
    conta('horario ao contrario', /termina antes/.test(F._botLogConfere({ logistica: { de: '20:00', ate: '08:00' } }, c)))
    for (const [nome, g] of [['vendedores', G_VEND], ['cobradores', G_COB], ['teste', G_TESTE]]) {
      const x = base(); x.logistica.grupo.id = g
      conta('o grupo dos ' + nome + ' nao pode ser o da logistica', /não pode ser o mesmo/.test(F._botLogConfere({}, x)))
    }
    const v = base(); v.grupo.id = G_LOG
    conta('...e o contrario tambem (trocar o grupo dos vendedores pro da logistica)', /não pode ser o mesmo/.test(F._botLogConfere({ grupo: { id: G_LOG } }, v)))
  }

  secao('o bot de IA nunca enxerga o grupo da logistica:')
  {
    const c = base()
    conta('fora da escuta', !F._botIaEscuta(c).includes(G_LOG) && F._botIaEscuta(c).length === 3, JSON.stringify(F._botIaEscuta(c)))
    const x = base(); x.ia.teste.id = G_LOG
    conta('mesmo gravado como grupo de teste, nao e escutado', !F._botIaEscuta(x).includes(G_LOG))
    conta('...nem vira teste', F._botIaEhTeste(x, G_LOG) === false)
    const y = base(); y.grupo.id = G_LOG
    conta('mesmo gravado como grupo dos vendedores, nao e escutado nem respondido', !F._botIaEscuta(y).includes(G_LOG) && F._botIaGrupoDe(y, G_LOG) === '')
    const z = base(); z.logistica.ativo = false; z.ia.teste.id = G_LOG
    conta('com o aviso desligado o grupo continua fora (o grupo e dele)', !F._botIaEscuta(z).includes(G_LOG))
  }

  secao('ao ligar: o que ja existe nao sai sozinho:')
  poe('ORDPARADO1', { nome: 'Antonio Cesar Bentes', criado: agora - 20 * 86400 })
  poe('ORDPARADO2', { criado: agora - 2 * 86400 })
  poe('ORDSAIU', { sh: 'IN_TRANSIT', sc: 'AP1BR' })
  poe('ORDSAOPAULO', { uf: 'SP' })
  db.prepare("INSERT INTO five_orders (order_id, customer_name, customer_doc, customer_address, created_at) VALUES ('PL-ORDQUEBRADO', 'X Y', '52998224725', 'nao e json', ?)").run(agora)
  db.prepare("INSERT INTO five_orders (order_id, customer_name, customer_doc, customer_address, created_at) VALUES ('5550001', 'Five Antiga', '52998224725', ?, ?)").run(end('CE'), agora)
  conta('desligado -> ligado = separar', F._botLogLigou({ logistica: { ativo: false } }, base()))
  conta('trocou o grupo = separar', F._botLogLigou({ logistica: { ativo: true, grupo: { id: G_COB } } }, base()))
  conta('mesmo grupo, ja ligado = nao separa de novo', !F._botLogLigou({ logistica: { ativo: true, grupo: { id: G_LOG } } }, base()))
  const marcados = await F._botLogMarcaExistentes(env)
  conta('separa os 3 do Ceara da PayLog (o de SP, o endereco quebrado e o da Five ficam fora)', marcados === 3, String(marcados))
  conta('todos como "antes"', ['ORDPARADO1', 'ORDPARADO2', 'ORDSAIU'].every((c) => linhaLog(c) && linhaLog(c).por === 'antes'))

  secao('a varredura:')
  cfg = base()
  await F._botLogTick(env, cfg)
  conta('nada sai logo depois de ligar', fila().length === 0, JSON.stringify(fila()))
  poe('ORDNOVO1', { nome: 'José  Ribamar   da Silva', cpf: '529.982.247-25', cidade: 'Maracanaú', criado: agora - 5 * 86400 })   // card de 5 dias: o created_at recua pro card
  poe('ORDNOVOSP', { uf: 'SP' })
  poe('ORDNOVOENV', { sh: 'DELIVERED', sc: 'AP2BR' })
  poe('ORDNOVOPREP', { sc: 'AP3BR', ls: 'Pedido em Preparação' })   // ja tem etiqueta, ainda nao saiu
  poe('ORDNOVOCANC', { ch: 'CANCELED', ls: 'Pedido Cancelado sem Custo' })
  poe('ORDNOVOCANC2', { ls: 'Cancelado sem custo' })
  poe('ORDNOVOESTORNO', { ch: 'REFUNDED', ls: 'Cadastrado' })   // estornado, com o rotulo ainda de cadastrado
  poe('ORDVELHO', { criado: agora - 60 * 86400 })
  poe('ORDSEMCPF', { cpf: '11111111111' })
  poe('ORDSEMNOME', { nome: 'Maria' })
  await F._botLogTick(env, cfg)
  let f = fila()
  const codigos = () => fila().map((x) => (/Cliente: (.*)/.exec(x.texto) || [])[1]).join(' | ')
  conta('sai o pedido novo do Ceara, mesmo com o card de 5 dias atras', f.some((x) => /José Ribamar da Silva/.test(x.texto)), codigos())
  conta('o que ja tem etiqueta mas nao saiu tambem sai', linhaLog('ORDNOVOPREP') && linhaLog('ORDNOVOPREP').por === 'auto')
  conta('sao 2 mensagens, nenhuma de SP, entregue, cancelado ou velho', f.length === 2, codigos())
  const msg = f.find((x) => /Ribamar/.test(x.texto))
  conta('a mensagem: nome arrumado e CPF com pontos', msg && msg.texto === 'Olá! Temos um novo pedido para o Ceará, podem fazer a postagem.\nCliente: José Ribamar da Silva\nCPF: 529.982.247-25', msg && msg.texto)
  conta('vai pro grupo da logistica, como item de logistica', f.every((x) => x.jid === G_LOG && x.tipo === 'logistica' && x.status === 'pend' && x.nome === 'SellWave x PayLog'))
  conta('CPF invalido nao sai sozinho (fica "pulou")', linhaLog('ORDSEMCPF') && linhaLog('ORDSEMCPF').por === 'pulou' && /CPF/.test(linhaLog('ORDSEMCPF').motivo))
  conta('nome incompleto tambem nao', linhaLog('ORDSEMNOME') && linhaLog('ORDSEMNOME').por === 'pulou')
  conta('a linha guarda o item da fila', linhaLog('ORDNOVO1') && linhaLog('ORDNOVO1').outbox_id > 0)
  await F._botLogTick(env, cfg)
  conta('a segunda batida nao repete', fila().length === 2)

  secao('quando nao sai:')
  poe('ORDNOITE')
  horaBR = 22 * 60
  await F._botLogTick(env, cfg)
  conta('fora do horario espera', fila().length === 2)
  horaBR = 7 * 60 + 59
  await F._botLogTick(env, cfg)
  conta('07:59 ainda espera', fila().length === 2)
  horaBR = 10 * 60
  cfg = { ...base(), ativo: false }
  await F._botLogTick(env, cfg)
  conta('bot inteiro desligado: nada', fila().length === 2)
  cfg = base(); cfg.logistica.ativo = false
  await F._botLogTick(env, cfg)
  conta('aviso desligado: nada', fila().length === 2)
  horaBR = 8 * 60
  cfg = base()
  await F._botLogTick(env, cfg)
  conta('as 08:00 sai o da noite', fila().length === 3 && /Maria Lucineide/.test(fila()[2].texto))

  secao('o freio:')
  for (let i = 0; i < 8; i++) poe('ORDLOTE' + i)
  await F._botLogTick(env, cfg)
  conta('no maximo 6 automaticos por hora (3 ja tinham saido: entram mais 3)', fila().length === 6, String(fila().length))
  db.prepare("UPDATE bot_logistica SET ts = ts - 3700 WHERE por = 'auto'").run()
  await F._botLogTick(env, cfg)
  conta('na hora seguinte sai o resto do lote (5 de 8 faltando, cabem 6)', fila().length === 11, String(fila().length))

  secao('a tela:')
  db.prepare("UPDATE bot_outbox SET status = 'enviado', feito_ts = ? WHERE texto LIKE '%Ribamar%'").run(agora)
  const idErro = fila()[2].id
  db.prepare("UPDATE bot_outbox SET status = 'erro', erro = 'O bot do PC ficou desligado por 20h. Texto descartado.' WHERE id = ?").run(idErro)
  let g = await F.handleBotLogistica({ url: 'https://x/api/bot/logistica', method: 'GET', __user: DIR }, env)
  const item = (c) => (g.itens || []).find((x) => x.code === c)
  conta('lista so do Ceara, sem cancelado', g.ok && !item('ORDSAOPAULO') && !item('ORDNOVOCANC') && !item('ORDNOVOCANC2') && !!item('ORDPARADO1'), JSON.stringify((g.itens || []).map((x) => x.code)))
  conta('"antes de ligar" no que ja existia', item('ORDPARADO1') && item('ORDPARADO1').aviso.tipo === 'antes')
  conta('"enviado" com a hora', item('ORDNOVO1') && item('ORDNOVO1').aviso.tipo === 'enviado' && item('ORDNOVO1').aviso.ts === agora)
  conta('"erro" com o motivo', (g.itens || []).some((x) => x.aviso.tipo === 'erro' && /20h/.test(x.aviso.erro)))
  conta('"fila" no que espera', item('ORDLOTE0') && item('ORDLOTE0').aviso.tipo === 'fila')
  conta('"pulou" com o motivo', item('ORDSEMCPF') && item('ORDSEMCPF').aviso.tipo === 'pulou' && item('ORDSEMCPF').pula === 'CPF inválido')
  conta('o que ja saiu vem marcado', item('ORDSAIU') && item('ORDSAIU').saiu === true)
  conta('cada item traz o texto que iria pro grupo', item('ORDPARADO1') && /Cliente: Antonio Cesar Bentes\nCPF: 529\.982\.247-25$/.test(item('ORDPARADO1').texto))
  const vend = await F.handleBotLogistica({ url: 'https://x/api/bot/logistica', method: 'GET', __user: { id: 'v', role: 'atendente' } }, env)
  conta('vendedor nao ve', vend.status === 403)

  secao('mandar a mao:')
  const avisar = (code, u = DIR) => F.handleBotLogistica({ url: 'https://x/api/bot/logistica/avisar', method: 'POST', __user: u, json: async () => ({ code }) }, env)
  const antesN = fila().length
  let r = await avisar('ORDPARADO1')
  conta('o parado de antes de ligar vai pra fila', r.ok && fila().length === antesN + 1 && /Antonio Cesar Bentes/.test(fila().at(-1).texto), JSON.stringify(r))
  conta('fica marcado como mandado a mao, por quem', linhaLog('ORDPARADO1').por === 'mao' && linhaLog('ORDPARADO1').quem === 'Bruno')
  r = await avisar('ORDPARADO1')
  conta('segundo clique com o primeiro na fila: recusa', r.status === 409 && fila().length === antesN + 1)
  db.prepare("UPDATE bot_outbox SET status = 'enviado' WHERE id = ?").run(linhaLog('ORDPARADO1').outbox_id)
  r = await avisar('ORDPARADO1')
  conta('depois de enviado, da pra mandar de novo', r.ok && fila().length === antesN + 2)
  r = await avisar('ORDSAOPAULO')
  conta('pedido de fora do Ceara: recusa', !r.ok && /não é do Ceará/.test(r.erro))
  r = await avisar('ORDNOVOCANC')
  conta('cancelado: recusa', !r.ok && /cancelado/.test(r.erro))
  r = await avisar('ORDSEMCPF')
  conta('CPF invalido: recusa', !r.ok && /CPF inválido/.test(r.erro))
  r = await avisar('ORDNAOEXISTE')
  conta('pedido que nao existe: 404', r.status === 404)
  r = await avisar("ORD1' OR 1=1 --")
  conta('codigo esquisito: recusa', r.status === 400)
  cfg = base(); cfg.logistica.grupo.id = ''
  r = await avisar('ORDPARADO2')
  conta('sem grupo salvo: recusa', !r.ok && /Escolha o grupo/.test(r.erro))
  cfg = base()
  agente = { vivo: false, estado: 'offline' }
  r = await avisar('ORDPARADO2')
  conta('com o bot do PC desligado entra na fila e avisa', r.ok && /desligado/.test(r.msg))
  r = await avisar('ORDPARADO2', { id: 'v', role: 'atendente' })
  conta('vendedor nao manda', r.status === 403)

  return { ok, ruim }
}

if (process.argv.includes('--mutacoes')) {
  let pegas = 0
  for (const [nome, de, para] of MUTACOES) {
    if (!CODIGO.includes(de)) { console.log('  ?? mutacao nao achou o trecho: ' + nome); continue }
    let r
    const [l0, e0] = [console.log, console.error]
    console.log = () => {}; console.error = () => {}
    try { r = await roda(CODIGO.replace(de, para), true) } catch (e) { r = { ruim: 1, quebrou: String((e && e.message) || e) } }
    console.log = l0; console.error = e0
    const pegou = r.ruim > 0
    if (pegou) pegas += 1
    console.log((pegou ? '  pegou   ' : '  ESCAPOU ') + nome + (r.quebrou ? ' (quebrou: ' + r.quebrou + ')' : ''))
  }
  console.log('\n' + pegas + ' de ' + MUTACOES.length + ' mutacoes pegas')
  process.exit(pegas === MUTACOES.length ? 0 : 1)
} else {
  const r = await roda(CODIGO, false)
  console.log('\n' + r.ok + ' ok, ' + r.ruim + ' ruins' + (r.quebrou ? ' (quebrou: ' + r.quebrou + ')' : ''))
  process.exit(r.ruim ? 1 : 0)
}
