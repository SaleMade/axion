// GRUPO DA LOGISTICA (13/11/2026).
//
// A PayLog pediu: todo pedido pro Ceara tem que ser confirmado no grupo deles antes da postagem. O bot
// avisa cada pedido (nome e CPF) e nao faz mais nada la. Desde 25/11 os que aparecem juntos saem numa
// mensagem so, e a abertura ("Ola! Temos...") so vai na primeira mensagem do dia. Este teste recorta do worker.js o
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
  recorta('const _botIaEhSala = ', '\n};\n'),   // a sala da direcao (19/11/2026): a escuta e o grupo passam por ela
  recorta('const _botIaGrupoDe = ', '\n};\n'),
  recorta('function _botIaEscuta('),
].join('\n')

// As mutacoes: cada uma tira uma protecao; alguma conferencia TEM que reclamar.
const MUTACOES = [
  ['sem a janela de horario', "if (min < _botMinutos(L.de) || min >= _botMinutos(L.ate)) return;", ''],
  ['sem o freio por hora', 'if ((Number(h && h.n) || 0) >= BOT_LOG_HORA) return;', ''],
  ['freio contando pedido, nao mensagem', 'SELECT COUNT(DISTINCT outbox_id) AS n', 'SELECT COUNT(*) AS n'],
  // JUNTAR (25/11/2026)
  ['sem a espera pra juntar', 'if (agoraS - maisVelho < BOT_LOG_JUNTA_S) return;', ''],
  ['um pedido por mensagem', 'const lote = vivos.slice(0, BOT_LOG_LOTE);', 'const lote = vivos.slice(0, 1);'],
  ['lote sem limite', 'const lote = vivos.slice(0, BOT_LOG_LOTE);', 'const lote = vivos;'],
  ['abertura em toda mensagem', 'const primeira = !(await _botLogJaFalouHoje(env, L));\n    const id', 'const primeira = true;\n    const id'],
  ['mensagem com erro conta como ja falou', "status IN ('pend', 'enviado') LIMIT 1", 'status IS NOT NULL LIMIT 1'],
  ['ontem conta como hoje', 'AND dia = ? AND status', 'AND ? IS NOT NULL AND status'],
  ['sem plural na abertura', '(lista.length > 1 ? _botLogPlural(abertura) : abertura)', 'abertura'],
  ['sai aviso de quem saiu na espera', 'if (p.saiu || p.cancelado || !BOT_LOG_UFS.includes(p.uf)) {', 'if (false) {'],
  ['religar solta a espera', "  await env.DB.prepare(\"UPDATE bot_logistica SET por = 'antes' WHERE por = 'espera'\").run();\n", ''],
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
  let diaBR = '2026-11-13'   // o dia que o _brDay devolve (a abertura so vai na primeira mensagem do dia)
  let cfg = null
  let agente = { vivo: true, estado: 'open' }
  const stubs = {
    _agoraBR: () => new Date(Date.UTC(2026, 10, 13, Math.floor(horaBR / 60), horaBR % 60)),
    _brDay: () => diaBR,
    _botEnsureTables: async () => {},
    _botCfgLer: async () => cfg,
    _botAgenteEstado: async () => agente,
    _botPodeUsar: (u) => !!u && u.role === 'diretor',
    _botIaPadrao: () => ({ responde: { vend: false, cob: false }, teste: {} }),
    authUser: async (req) => req.__user || null,
    json: (o, s) => ({ ...o, status: s || 200 }),
    err: (m, s) => ({ erro: m, status: s || 400 }),
  }
  const nomes = ['_botLogPadrao', '_botLogNormaliza', '_botLogConfere', '_botLogLigou', '_botLogTexto', '_botLogTextoLote', '_botLogPlural', '_botLogMarcaExistentes', '_botLogTick', 'handleBotLogistica', '_botIaEscuta', '_botIaEhTeste', '_botIaGrupoDe', '_botLogEhGrupo']
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
    // a sala da direcao (19/11/2026) tambem nunca e o grupo da logistica: la o bot responderia com os valores da casa
    const w = base(); w.ia.sala = { ativo: true, id: G_LOG, nome: 'Direcao' }
    conta('mesmo gravado como sala da direcao, nao e escutado nem respondido', !F._botIaEscuta(w).includes(G_LOG) && F._botIaGrupoDe(w, G_LOG) === '')
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

  // 25/11/2026: o pedido novo ESPERA 10 min (linha 'espera') pra juntar com os que entram logo depois;
  // vencida a espera do mais antigo, todos saem numa mensagem so. Date.now e de verdade: "passar o
  // tempo" aqui e recuar o ts das linhas.
  const vence = (codes) => (codes
    ? db.prepare("UPDATE bot_logistica SET ts = ts - 601 WHERE por = 'espera' AND code IN (SELECT value FROM json_each(?))").run(JSON.stringify(codes))
    : db.prepare("UPDATE bot_logistica SET ts = ts - 601 WHERE por = 'espera'").run())
  const passaHora = () => db.prepare("UPDATE bot_logistica SET ts = ts - 3700 WHERE por = 'auto'").run()
  const nomesDe = (t) => [...String(t || '').matchAll(/Cliente: (.*)/g)].map((m) => m[1])
  const tick = () => F._botLogTick(env, cfg)
  const ABRE1 = 'Olá! Temos um novo pedido para o Ceará, podem fazer a postagem.'
  const ABREN = 'Olá! Temos novos pedidos para o Ceará, podem fazer a postagem.'
  const CPF = '529.982.247-25'

  secao('a varredura: o pedido novo espera pra juntar com os outros:')
  cfg = base()
  await tick()
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
  // De noite a espera anda, mas a parte que manda nao roda: e onde da pra ver o filtro da entrada sozinho
  // (de dia a conferencia da espera apagaria o que entrou errado, e o erro viraria escrita a cada minuto).
  horaBR = 22 * 60
  await tick()
  const fora = ['ORDNOVOSP', 'ORDNOVOENV', 'ORDNOVOCANC', 'ORDNOVOCANC2', 'ORDNOVOESTORNO', 'ORDVELHO']
  conta('SP, entregue, cancelado, estornado e velho nem entram na espera', fora.every((c) => !linhaLog(c)), fora.filter((c) => linhaLog(c)).join(' '))
  horaBR = 10 * 60
  await tick()
  conta('nada sai na hora: fica esperando juntar', fila().length === 0, JSON.stringify(fila()))
  conta('o novo do Ceara espera, mesmo com o card de 5 dias atras', linhaLog('ORDNOVO1') && linhaLog('ORDNOVO1').por === 'espera')
  conta('o que ja tem etiqueta mas nao saiu tambem espera', linhaLog('ORDNOVOPREP') && linhaLog('ORDNOVOPREP').por === 'espera')
  conta('...nem de dia', fora.every((c) => !linhaLog(c)), fora.filter((c) => linhaLog(c)).join(' '))
  conta('CPF invalido nao sai sozinho (fica "pulou")', linhaLog('ORDSEMCPF') && linhaLog('ORDSEMCPF').por === 'pulou' && /CPF/.test(linhaLog('ORDSEMCPF').motivo))
  conta('nome incompleto tambem nao', linhaLog('ORDSEMNOME') && linhaLog('ORDSEMNOME').por === 'pulou')
  poe('ORDNOVO2', { nome: 'Francisca Pedro Filho', criado: agora - 60 })
  vence(['ORDNOVO1', 'ORDNOVOPREP'])
  await tick()
  let f = fila()
  conta('venceu a espera do primeiro: sai TUDO numa mensagem so, ate o que acabou de chegar', f.length === 1 && nomesDe(f[0].texto).join(' | ') === 'José Ribamar da Silva | Maria Lucineide Souza | Francisca Pedro Filho', f.map((x) => x.texto).join(' // '))
  conta('a mensagem: a abertura uma vez, no plural, e um bloco por pedido', f[0] && f[0].texto === ABREN + '\n\nCliente: José Ribamar da Silva\nCPF: ' + CPF + '\n\nCliente: Maria Lucineide Souza\nCPF: ' + CPF + '\n\nCliente: Francisca Pedro Filho\nCPF: ' + CPF, f[0] && f[0].texto)
  conta('vai pro grupo da logistica, como item de logistica', f.every((x) => x.jid === G_LOG && x.tipo === 'logistica' && x.status === 'pend' && x.nome === 'SellWave x PayLog'))
  conta('as tres linhas guardam o mesmo item da fila', f[0] && ['ORDNOVO1', 'ORDNOVOPREP', 'ORDNOVO2'].every((c) => linhaLog(c).por === 'auto' && linhaLog(c).outbox_id === f[0].id))
  await tick()
  conta('a batida seguinte nao repete', fila().length === 1)

  secao('a abertura so na primeira mensagem do dia:')
  poe('ORDTARDE', { nome: 'Raimundo Nonato Lima' })
  await tick(); vence(); await tick()
  conta('a segunda mensagem do dia vai sem a abertura, so o cliente', fila().length === 2 && fila()[1].texto === 'Cliente: Raimundo Nonato Lima\nCPF: ' + CPF, fila()[1] && fila()[1].texto)
  diaBR = '2026-11-14'
  poe('ORDAMANHA', { nome: 'Cicera Maria Alves' })
  await tick(); vence(); await tick()
  conta('no dia seguinte a primeira volta com a abertura (um pedido = singular, como antes)', fila().length === 3 && fila()[2].texto === ABRE1 + '\nCliente: Cicera Maria Alves\nCPF: ' + CPF, fila()[2] && fila()[2].texto)
  db.prepare("UPDATE bot_outbox SET status = 'erro' WHERE id = ?").run(fila()[2].id)
  poe('ORDDEPOISERRO', { nome: 'Joana Darc Sousa' })
  await tick(); vence(); await tick()
  conta('a primeira do dia nao saiu (erro): a seguinte leva a abertura', fila().length === 4 && fila()[3].texto.startsWith(ABRE1 + '\n'), fila()[3] && fila()[3].texto)
  diaBR = '2026-11-13'

  secao('as pecas do texto:')
  {
    const pA = { nome: 'Ana Maria Souza', cpf: '52998224725', cidade: 'Sobral', code: 'ORDA1' }
    const pB = { nome: 'Bia Lima', cpf: '', cidade: 'Crato', code: 'ORDB2' }
    const L1 = { texto: 'Bom dia!\nTemos um pedido novo do Ceará.\nCliente: {nome}\nCidade: {cidade}\nPedido: {codigo}' }
    conta('abertura de duas linhas, no plural', F._botLogTextoLote(L1, [pA, pB], true) === 'Bom dia!\nTemos pedidos novos do Ceará.\n\nCliente: Ana Maria Souza\nCidade: Sobral\nPedido: ORDA1\n\nCliente: Bia Lima\nCidade: Crato\nPedido: ORDB2', F._botLogTextoLote(L1, [pA, pB], true))
    conta('um pedido na primeira do dia = a mensagem gravada, igual a antes', F._botLogTextoLote(base().logistica, [pA], true) === F._botLogTexto(base().logistica, pA))
    conta('maiuscula no comeco fica maiuscula', F._botLogPlural('Um novo pedido chegou') === 'Novos pedidos chegou', F._botLogPlural('Um novo pedido chegou'))
    conta('mensagem sem {nome}/{cpf}: sai o texto, sem repetir', F._botLogTextoLote({ texto: 'Tem pedido do Ceará pra liberar.' }, [pA, pB], false) === 'Tem pedido do Ceará pra liberar.')
    conta('mensagem que ja comeca no cliente: sem abertura', F._botLogTextoLote({ texto: 'Cliente: {nome}' }, [pA], true) === 'Cliente: Ana Maria Souza')
  }

  secao('quando nao sai:')
  passaHora()
  poe('ORDNOITE', { nome: 'Francisco Nogueira Silva' })
  horaBR = 22 * 60
  await tick()
  conta('de noite o pedido ja entra na espera...', linhaLog('ORDNOITE') && linhaLog('ORDNOITE').por === 'espera')
  vence()
  await tick()
  conta('...mas fora do horario nao sai', fila().length === 4)
  horaBR = 7 * 60 + 59
  await tick()
  conta('07:59 ainda espera', fila().length === 4)
  horaBR = 10 * 60
  cfg = { ...base(), ativo: false }
  await tick()
  conta('bot inteiro desligado: nada', fila().length === 4)
  cfg = base(); cfg.logistica.ativo = false
  await tick()
  conta('aviso desligado: nada', fila().length === 4)
  horaBR = 8 * 60
  cfg = base()
  await tick()
  conta('as 08:00 em ponto sai o da noite (a espera venceu de madrugada)', fila().length === 5 && nomesDe(fila()[4].texto).join() === 'Francisco Nogueira Silva', String(fila().length))

  secao('o que saiu ou foi cancelado durante a espera:')
  poe('ORDSAIUNAESPERA', { nome: 'Pedro Henrique Costa' })
  poe('ORDCANCNAESPERA', { nome: 'Ana Paula Moreira' })
  await tick()
  conta('os dois esperando', ['ORDSAIUNAESPERA', 'ORDCANCNAESPERA'].every((c) => linhaLog(c) && linhaLog(c).por === 'espera'))
  db.prepare("UPDATE five_orders SET shipping_status = 'IN_TRANSIT' WHERE order_id = 'PL-ORDSAIUNAESPERA'").run()
  db.prepare("UPDATE five_orders SET charge_status = 'CANCELED' WHERE order_id = 'PL-ORDCANCNAESPERA'").run()
  vence(); await tick(); await tick()
  conta('nao sai aviso de quem saiu ou foi cancelado no meio da espera', fila().length === 5 && !linhaLog('ORDSAIUNAESPERA') && !linhaLog('ORDCANCNAESPERA'), String(fila().length))

  secao('o lote e o freio:')
  passaHora()
  for (let i = 0; i < 20; i++) poe('ORDLOTE' + String(i).padStart(2, '0'), { criado: agora - 3600 + i })
  await tick(); vence(); await tick()
  conta('no maximo 15 pedidos por mensagem', fila().length === 6 && nomesDe(fila()[5].texto).length === 15, fila().length + ' / ' + nomesDe((fila()[5] || {}).texto).length)
  await tick()
  conta('o resto vai na seguinte, sem abertura', fila().length === 7 && nomesDe(fila()[6].texto).length === 5 && !/Olá/.test(fila()[6].texto))
  poe('ORDAPOSLOTE', { nome: 'Marcos Vinicius Rocha' })
  await tick(); vence(); await tick()
  conta('20 pedidos em 2 mensagens contam 2 no freio, nao 20: o seguinte sai', fila().length === 8 && /Marcos Vinicius/.test(fila()[7].texto), String(fila().length))
  passaHora()
  const insAuto = db.prepare("INSERT INTO bot_logistica (code, ts, por, quem, outbox_id, motivo) VALUES (?, ?, 'auto', '', ?, '')")
  for (let i = 0; i < 6; i++) insAuto.run('ORDFREIO' + i, agora - 60, 9000 + i)
  poe('ORDDEPOISFREIO', { nome: 'Luzia Ferreira Gomes' })
  await tick(); vence(); await tick()
  conta('no maximo 6 mensagens por hora: a setima espera', fila().length === 8 && linhaLog('ORDDEPOISFREIO').por === 'espera', String(fila().length))
  passaHora()
  await tick()
  conta('na hora seguinte ela sai', fila().length === 9 && /Luzia/.test(fila()[8].texto))

  secao('muitos pedidos ja conhecidos nao escondem o novo:')
  for (let i = 0; i < 60; i++) {
    poe('ORDCONHECIDO' + i, { criado: agora - 7200 })
    db.prepare("INSERT INTO bot_logistica (code, ts, por, quem, outbox_id, motivo) VALUES (?, ?, 'antes', '', NULL, '')").run('ORDCONHECIDO' + i, agora)
  }
  poe('ORDDEPOISDE60', { nome: 'Sebastiao Alves Pinto', criado: agora - 60 })
  await tick()
  conta('com 60 pedidos do Ceara ja conhecidos, o novo ainda entra na espera', linhaLog('ORDDEPOISDE60') && linhaLog('ORDDEPOISDE60').por === 'espera')
  vence(); await tick()
  conta('...e sai', fila().length === 10 && /Sebastiao/.test(fila()[9].texto))
  db.prepare("DELETE FROM five_orders WHERE order_id LIKE 'PL-ORDCONHECIDO%'").run()   // a lista da tela mostra so 60

  secao('religar nao solta quem estava esperando:')
  poe('ORDRELIGA', { nome: 'Rita de Cassia Lopes' })
  await tick()
  await F._botLogMarcaExistentes(env)
  conta('religar (ou trocar o grupo) passa quem esperava pra "antes"', linhaLog('ORDRELIGA').por === 'antes')
  vence(); await tick()
  conta('...e ele nao sai sozinho', fila().length === 10)

  secao('a tela:')
  db.prepare("UPDATE bot_outbox SET status = 'enviado', feito_ts = ? WHERE texto LIKE '%Ribamar%'").run(agora)
  db.prepare("UPDATE bot_outbox SET erro = 'O bot do PC ficou desligado por 20h. Texto descartado.' WHERE id = ?").run(fila()[2].id)
  poe('ORDNATELA', { nome: 'Gabriel Lima Souza' })
  await tick()
  let g = await F.handleBotLogistica({ url: 'https://x/api/bot/logistica', method: 'GET', __user: DIR }, env)
  const item = (c) => (g.itens || []).find((x) => x.code === c)
  conta('lista so do Ceara, sem cancelado', g.ok && !item('ORDSAOPAULO') && !item('ORDNOVOCANC') && !item('ORDNOVOCANC2') && !!item('ORDPARADO1'), JSON.stringify((g.itens || []).map((x) => x.code)))
  conta('"antes de ligar" no que ja existia', item('ORDPARADO1') && item('ORDPARADO1').aviso.tipo === 'antes')
  conta('"enviado" com a hora', item('ORDNOVO1') && item('ORDNOVO1').aviso.tipo === 'enviado' && item('ORDNOVO1').aviso.ts === agora)
  conta('"erro" com o motivo', item('ORDAMANHA') && item('ORDAMANHA').aviso.tipo === 'erro' && /20h/.test(item('ORDAMANHA').aviso.erro))
  conta('"fila" no que espera pra juntar', item('ORDNATELA') && item('ORDNATELA').aviso.tipo === 'fila')
  conta('"fila" no que ja esta na fila do PC', item('ORDLOTE00') && item('ORDLOTE00').aviso.tipo === 'fila')
  conta('"pulou" com o motivo', item('ORDSEMCPF') && item('ORDSEMCPF').aviso.tipo === 'pulou' && item('ORDSEMCPF').pula === 'CPF inválido')
  conta('o que ja saiu vem marcado', item('ORDSAIU') && item('ORDSAIU').saiu === true)
  conta('o texto de cada item e o que o Avisar mandaria agora: sem a abertura, o grupo ja ouviu hoje', item('ORDPARADO1') && item('ORDPARADO1').texto === 'Cliente: Antonio Cesar Bentes\nCPF: ' + CPF, item('ORDPARADO1') && item('ORDPARADO1').texto)
  diaBR = '2026-11-15'
  g = await F.handleBotLogistica({ url: 'https://x/api/bot/logistica', method: 'GET', __user: DIR }, env)
  conta('...e com a abertura num dia em que o grupo nao ouviu nada', item('ORDPARADO1') && item('ORDPARADO1').texto === ABRE1 + '\nCliente: Antonio Cesar Bentes\nCPF: ' + CPF, item('ORDPARADO1') && item('ORDPARADO1').texto)
  diaBR = '2026-11-13'
  const vend = await F.handleBotLogistica({ url: 'https://x/api/bot/logistica', method: 'GET', __user: { id: 'v', role: 'atendente' } }, env)
  conta('vendedor nao ve', vend.status === 403)

  secao('mandar a mao:')
  const avisar = (code, u = DIR) => F.handleBotLogistica({ url: 'https://x/api/bot/logistica/avisar', method: 'POST', __user: u, json: async () => ({ code }) }, env)
  const antesN = fila().length
  let r = await avisar('ORDPARADO1')
  conta('o parado de antes de ligar vai pra fila', r.ok && fila().length === antesN + 1 && /Antonio Cesar Bentes/.test(fila().at(-1).texto), JSON.stringify(r))
  conta('...sem a abertura, que o grupo ja ouviu hoje', fila().at(-1).texto === 'Cliente: Antonio Cesar Bentes\nCPF: ' + CPF, fila().at(-1).texto)
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
  db.prepare("UPDATE bot_logistica SET ts = ts - 200 WHERE code = 'ORDNATELA'").run()
  const n0 = fila().length
  r = await avisar('ORDNATELA')
  conta('o Avisar leva o pedido que estava esperando juntar', r.ok && linhaLog('ORDNATELA').por === 'mao' && fila().length === n0 + 1, JSON.stringify(r))
  vence(); await tick()
  conta('...e ele nao sai de novo no aviso automatico', fila().length === n0 + 1)
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
