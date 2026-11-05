// ARRASTAR O CARD LE E GRAVA SO AQUELE PEDIDO (05/11/2026, ver _leadMoveRapido no worker.js).
//
// O caso real: o arrasto do pedido 1792845282163 (Rota de Entrega -> Frustrados) levou 20,5 s e voltou
// 409 "Conflito ao salvar". O POST /api/lead/:id/move lia o estado inteiro (1,4 MB + o arquivo de leads),
// mexia num pedido e regravava tudo, ate 10 vezes, com a trava na versao do estado inteiro, que o cron e
// os webhooks mudam varias vezes por minuto. Em rajada, as 10 tentativas perdiam.
//
// O que este teste prova, na rota de verdade contra um D1 de mentira:
//  1. diretor move pedido da linha: 200, NAO le o estado inteiro, os outros pedidos ficam byte a byte
//     iguais, versao +1 (no banco e na resposta), updated_by, hist com quem e quando (ISO);
//  2. entrar em Pagos carimba pago_ts e limpa o retorno de cobranca; sair de Pagos apaga o carimbo;
//  3. col_plat congela uma vez (pedido com five_id);
//  4. mesma coluna = noop com a versao real do banco;
//  5. cancelamento vai pelo caminho de sempre e marca wa_sales (0 quando outro pedido do telefone esta
//     vivo, 1 quando nao); sair do cancelamento pelo curto desmarca;
//  6. pedido do ARQUIVO vai pelo caminho de sempre: reabrir volta pra linha, perda segue no arquivo;
//  7. concorrencia: outro pedido mudando no meio, pedido novo no topo (o indice anda), o PROPRIO pedido
//     mudando no meio, e 3 recusas seguidas (cai no longo e ainda assim grava);
//  8. gates: afiliado 404 no pedido da casa, vendedor 403 (sem nenhuma leitura), aceito 403, sem token
//     401, sem col 400, id inexistente 404;
//  9. a resposta do curto tem as mesmas chaves da do longo.
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-move-rapido.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
if (!bundle) { console.error('uso: node teste-move-rapido.mjs <dir>/worker.js'); process.exit(2) }
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
sq.exec('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER, msg_id TEXT, raw TEXT, cancelado INTEGER)')

const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
let leuInteiro = 0   // leituras do estado INTEIRO (SELECT data ...): e o que o arrasto nao pode mais fazer
let leuCurto = 0     // leituras de UM pedido por json_each
let noMeio = null    // gancho: roda UMA vez logo depois da proxima leitura curta (outro gravador no meio)
const ehLeituraRapida = (sql) => /json_each\(json_extract\(s\.data, '\$\.leads'\)\)/.test(sql) && /AS regras/.test(sql)
function stmt(sql, args = []) {
  if (/^\s*SELECT data\b/i.test(sql) && /dashboard_state/.test(sql)) leuInteiro++
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => {
      if (ehLeituraRapida(sql)) leuCurto++
      const r = sq.prepare(sql).get(...args)
      if (noMeio && ehLeituraRapida(sql)) { const f = noMeio; noMeio = null; f() }
      return r ? (col ? r[col] : { ...r }) : null
    },
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
user('vend_kevin', 'kevin', 'Kevin', 'atendente')
user('gio', 'gio', 'Giovane', 'afiliado', 'afl_3d767329')
const TK = { dir: 'd'.repeat(64), kevin: 'a'.repeat(64), gio: 'e'.repeat(64) }
for (const [k, id] of [['dir', 'dir'], ['kevin', 'vend_kevin'], ['gio', 'gio']]) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], id, exp)

// `ts` (ms) e `wa` sao o que _waSalesMarcaCancelada usa pra achar a venda detectada no WhatsApp
// (janela de 2 dias, ultimos 8 digitos). 100 e 300 dividem o telefone de proposito (caso 5).
const T0 = Date.now() - 3600e3
const estado = {
  tags: [], regras: { kits: [] }, team: [],
  leads: [
    { id: '100', nome: 'Joao da Casa', col: 'Cobrança', spg: 'Pendente', at: 'vend_kevin', afl: '', wa: '+5511999990000', ts: T0, hist: [], tags: [] },
    { id: '101', nome: 'Jose Sozinho', col: 'Cobrança', spg: 'Pendente', at: 'vend_kevin', afl: '', wa: '+5511777770000', ts: T0, hist: [] },
    { id: '200', nome: 'Maria do Afiliado', col: 'Cobrança', at: 'gio', afl: 'afl_3d767329', hist: [] },
    { id: '300', nome: 'Pedro Outro', col: 'Enviado', at: 'vend_kevin', afl: '', wa: '+5511999990000', ts: T0 + 60e3, agend: '2026-11-10', agend_avisado: '2026-11-10', hist: [] },
    { id: '500', nome: 'Ana da Five', col: 'Rota de Entrega', at: 'vend_kevin', afl: '', five_id: 'F1', hist: [] },
  ],
}
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))
const arq = (l) => sq.prepare('INSERT INTO leads_arquivo (id,json,col,ts) VALUES (?,?,?,?)').run(l.id, JSON.stringify(l), l.col, Math.floor(Date.now() / 1000) - 864000)
arq({ id: '900', nome: 'Jardelino Arquivado', col: 'Pagos', spg: 'Pago', at: 'vend_kevin', afl: '', hist: [] })
arq({ id: '901', nome: 'Frustrado Arquivado', col: 'Frustrados', at: 'vend_kevin', afl: '', hist: [] })
for (const tel of ['+5511999990000', '+5511777770000']) sq.prepare('INSERT INTO wa_sales (phone, instance, name, value, ts, cancelado) VALUES (?,?,?,?,?,0)').run(tel, 'inst_kevin', 'Cliente', 497, Math.floor(T0 / 1000))

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-move-rapido.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB }, ctx = { waitUntil: () => {} }
const move = async (tk, id, body) => {
  const headers = { 'content-type': 'application/json' }
  if (tk) headers.authorization = 'Bearer ' + tk
  const r = await worker.fetch(new Request('https://x/api/lead/' + id + '/move', { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx)
  return { st: r.status, j: await r.json().catch(() => ({})) }
}
const linha = () => sq.prepare('SELECT data, version, updated_by FROM dashboard_state WHERE id=1').get()
const todos = () => JSON.parse(linha().data).leads || []
const naLinha = (id) => todos().find((l) => String(l.id) === String(id))
const noArquivo = (id) => { const r = sq.prepare('SELECT json FROM leads_arquivo WHERE id=?').get(String(id)); return r ? JSON.parse(r.json) : null }
const canc = (tel) => { const r = sq.prepare('SELECT cancelado FROM wa_sales WHERE phone=?').get(tel); return r ? (Number(r.cancelado) || 0) : null }
// outro gravador (cron, captura, outra aba) mexendo na LINHA por fora da rota
const regrava = (fn, quem) => { const d = JSON.parse(linha().data); fn(d); sq.prepare('UPDATE dashboard_state SET data=?, version=version+1, updated_by=? WHERE id=1').run(JSON.stringify(d), quem) }
const ehISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) && !isNaN(Date.parse(s))
let ok = 0, mau = 0
const t = (c, nome, extra) => { if (c) { ok++; console.log('  ok  ' + nome) } else { mau++; console.log('  XX  ' + nome + (extra ? '  ' + extra : '')) } }

console.log('\n1. CAMINHO CURTO: diretor move pedido da linha')
let antes = JSON.stringify([naLinha('101'), naLinha('200'), naLinha('300'), naLinha('500')])
let v0 = linha().version
leuInteiro = 0
let r = await move(TK.dir, '100', { col: 'Frustrados' })
const chavesCurto = Object.keys(r.j).sort().join(',')
t(r.st === 200 && r.j.ok === true, 'responde 200', JSON.stringify(r.j))
t(naLinha('100').col === 'Frustrados', 'a coluna gravou', JSON.stringify(naLinha('100')))
t(leuInteiro === 0, 'e NAO leu o estado inteiro', 'leituras inteiras: ' + leuInteiro)
t(JSON.stringify([naLinha('101'), naLinha('200'), naLinha('300'), naLinha('500')]) === antes, 'os outros pedidos ficaram byte a byte iguais')
t(linha().version === v0 + 1 && r.j.version === v0 + 1, 'a versao subiu 1 e a resposta traz a nova', linha().version + ' / ' + r.j.version)
t(linha().updated_by === 'kanban:dir', 'updated_by diz quem gravou', linha().updated_by)
const h1 = (naLinha('100').hist || []).slice(-1)[0]
t(!!h1 && h1.from === 'Cobrança' && h1.to === 'Frustrados' && h1.who === 'dir' && ehISO(h1.time), 'o historico entrou com quem e quando (ISO)', JSON.stringify(h1))
t(naLinha('100').pago_ts === undefined, 'sem carimbo de pago (nao foi pra Pagos)')
t(r.j.from === 'Cobrança' && r.j.to === 'Frustrados', 'a resposta diz de onde pra onde', JSON.stringify(r.j))

console.log('\n2. PAGOS: carimba a data e limpa o retorno; sair apaga o carimbo')
leuInteiro = 0
r = await move(TK.dir, '300', { col: 'Pagos' })
t(r.st === 200 && naLinha('300').col === 'Pagos', 'foi pra Pagos', JSON.stringify(r.j))
t(Number(naLinha('300').pago_ts) > 1.5e12 && naLinha('300').pago_ts_fonte === 'dash', 'pago_ts carimbado pela dash', JSON.stringify({ pago_ts: naLinha('300').pago_ts, fonte: naLinha('300').pago_ts_fonte }))
t(naLinha('300').agend === '' && naLinha('300').agend_avisado === '', 'o retorno de cobranca foi limpo', JSON.stringify({ agend: naLinha('300').agend, avisado: naLinha('300').agend_avisado }))
t((naLinha('300').hist || []).some((h) => h.to === 'Pagos' && h.who === 'dir'), 'com historico')
t(leuInteiro === 0, 'pelo caminho curto', String(leuInteiro))
r = await move(TK.dir, '300', { col: 'Cobrança' })
t(r.st === 200 && naLinha('300').col === 'Cobrança', 'voltou pra Cobrança', JSON.stringify(r.j))
t(naLinha('300').pago_ts === undefined && naLinha('300').pago_ts_fonte === undefined, 'e o carimbo de pago foi apagado', JSON.stringify({ pago_ts: naLinha('300').pago_ts }))

console.log('\n3. COL_PLAT congela uma vez (pedido com five_id)')
r = await move(TK.dir, '500', { col: 'Frustrados' })
t(r.st === 200 && naLinha('500').col === 'Frustrados' && naLinha('500').col_plat === 'Rota de Entrega', 'primeiro arrasto guarda onde a plataforma tinha deixado', JSON.stringify({ col: naLinha('500').col, col_plat: naLinha('500').col_plat }))
r = await move(TK.dir, '500', { col: 'Devolvido' })
t(r.st === 200 && naLinha('500').col === 'Devolvido' && naLinha('500').col_plat === 'Rota de Entrega', 'segundo arrasto nao mexe no col_plat', JSON.stringify({ col: naLinha('500').col, col_plat: naLinha('500').col_plat }))
t(naLinha('100').col_plat === undefined, 'pedido sem five_id nao ganha col_plat')

console.log('\n4. NOOP: mesma coluna')
leuInteiro = 0
const nHist = (naLinha('100').hist || []).length
r = await move(TK.dir, '100', { col: 'Frustrados' })
t(r.st === 200 && r.j.ok === true && r.j.noop === true, 'responde 200 com noop', JSON.stringify(r.j))
t(r.j.version === linha().version && r.j.version > 0, 'com a versao real do banco', r.j.version + ' / ' + linha().version)
t((naLinha('100').hist || []).length === nHist, 'o historico nao cresce')
t(leuInteiro === 0, 'sem ler o estado inteiro', String(leuInteiro))

console.log('\n7. CONCORRENCIA (outro gravador no meio)')
leuInteiro = 0
noMeio = () => regrava((d) => { d.leads.find((l) => l.id === '300').obs = 'mexido no meio' }, 'kanban:outro')
let lc0 = leuCurto
r = await move(TK.dir, '100', { col: 'Enviado' })
t(r.st === 200 && naLinha('100').col === 'Enviado', '(a) outro pedido mudando no meio NAO derruba o arrasto', JSON.stringify(r.j))
t(naLinha('300').obs === 'mexido no meio', '    e a mudanca do outro pedido ficou')
t(leuCurto === lc0 + 1 && leuInteiro === 0, '    gravou na primeira leitura', 'curtas: ' + (leuCurto - lc0) + ' inteiras: ' + leuInteiro)
noMeio = () => regrava((d) => d.leads.unshift({ id: '400', nome: 'Pedido Novo da Captura', col: 'A Enviar', afl: '', hist: [] }), 'captura')
const nAntes = todos().length, nHist100 = (naLinha('100').hist || []).length
r = await move(TK.dir, '100', { col: 'Rota de Entrega' })
t(r.st === 200 && naLinha('100').col === 'Rota de Entrega', '(b) pedido novo no topo: rele e grava no pedido CERTO', JSON.stringify(r.j))
t(naLinha('400') && naLinha('400').col === 'A Enviar' && todos().length === nAntes + 1, '    o pedido novo nao foi atropelado e ninguem sumiu', String(todos().length))
t((naLinha('100').hist || []).length === nHist100 + 1, '    o historico cresceu UMA linha, nao uma por tentativa', String((naLinha('100').hist || []).length))
t(leuInteiro === 0, '    sem ler o estado inteiro', String(leuInteiro))
noMeio = () => regrava((d) => { d.leads.find((l) => l.id === '100').obs = 'mexido no proprio' }, 'kanban:outro')
r = await move(TK.dir, '100', { col: 'Cobrança' })
t(r.st === 200 && naLinha('100').col === 'Cobrança' && naLinha('100').obs === 'mexido no proprio', '(c) o PROPRIO pedido mudando no meio: rele, e ficam a coluna nova E a mudanca do outro', JSON.stringify({ col: naLinha('100').col, obs: naLinha('100').obs }))
t(leuInteiro === 0, '    sem ler o estado inteiro', String(leuInteiro))
let nUn = 0
const armaUnshift = () => { noMeio = () => { regrava((d) => d.leads.unshift({ id: String(401 + nUn), nome: 'Captura ' + (401 + nUn), col: 'A Enviar', afl: '', hist: [] }), 'captura'); if (++nUn < 3) armaUnshift() } }
armaUnshift()
const n3 = todos().length
r = await move(TK.dir, '100', { col: 'Enviado' })
t(r.st === 200 && naLinha('100').col === 'Enviado', '(d) 3 recusas seguidas: ainda assim 200 e gravou', JSON.stringify(r.j))
t(leuInteiro >= 1, '    (caiu no caminho de sempre)', String(leuInteiro))
t(todos().length === n3 + 3 && naLinha('401') && naLinha('402') && naLinha('403'), '    e os 3 pedidos que entraram no topo estao la', String(todos().length))
noMeio = null

console.log('\n5. CANCELAMENTO vai pelo caminho de sempre e marca wa_sales')
leuInteiro = 0
r = await move(TK.kevin, '100', { col: 'Cancelado' })
const chavesLongo = Object.keys(r.j).sort().join(',')
t(r.st === 200 && r.j.ok === true && naLinha('100').col === 'Cancelado', 'vendedor cancela o proprio pedido (nao aceito)', JSON.stringify(r.j))
t(leuInteiro >= 1, 'pelo caminho de sempre (leu o estado inteiro)', String(leuInteiro))
t((naLinha('100').hist || []).slice(-1)[0].who === 'vend_kevin', 'com historico em nome dele')
t(canc('+5511999990000') === 0, 'a venda do telefone NAO e marcada: o 300 (mesmo telefone, na janela) esta vivo', String(canc('+5511999990000')))
leuInteiro = 0
r = await move(TK.dir, '101', { col: 'Cancelado' })
t(r.st === 200 && naLinha('101').col === 'Cancelado' && leuInteiro >= 1, 'diretor cancela o 101 pelo caminho de sempre', JSON.stringify(r.j))
t(canc('+5511777770000') === 1, 'sem outro pedido vivo do telefone, a venda e marcada cancelada', String(canc('+5511777770000')))
leuInteiro = 0
r = await move(TK.dir, '101', { col: 'A Enviar' })
t(r.st === 200 && naLinha('101').col === 'A Enviar' && leuInteiro === 0, 'sair do cancelamento vai pelo curto', JSON.stringify(r.j) + ' inteiras: ' + leuInteiro)
t(canc('+5511777770000') === 0, 'e a venda volta a contar (cancelado = 0)', String(canc('+5511777770000')))

console.log('\n6. PEDIDO DO ARQUIVO vai pelo caminho de sempre')
leuInteiro = 0
r = await move(TK.dir, '900', { col: 'Cobrança' })
t(r.st === 200 && r.j.ok === true, 'reabrir um Pagos arquivado responde 200', JSON.stringify(r.j))
t(leuInteiro >= 1, 'pelo caminho de sempre', String(leuInteiro))
t(naLinha('900') && naLinha('900').col === 'Cobrança' && noArquivo('900') === null, 'ele VOLTOU pra linha e saiu do arquivo', JSON.stringify({ linha: naLinha('900') && naLinha('900').col, arquivo: noArquivo('900') }))
t((naLinha('900').hist || []).some((h) => h.from === 'Pagos' && h.to === 'Cobrança' && h.who === 'dir'), 'com historico da reabertura')
t(naLinha('900').spg === 'Pago' && Number(naLinha('900').pago_ts) > 1.5e12, 'continua pago pelo spg (so a coluna mudou), e o carimbo que faltava entrou', JSON.stringify({ spg: naLinha('900').spg, pago_ts: naLinha('900').pago_ts }))
leuInteiro = 0
r = await move(TK.dir, '900', { col: 'Frustrados' })
t(r.st === 200 && naLinha('900').col === 'Frustrados' && leuInteiro === 0, 'agora na linha, o proximo arrasto ja e curto', JSON.stringify(r.j) + ' inteiras: ' + leuInteiro)
leuInteiro = 0
r = await move(TK.dir, '901', { col: 'Devolvido' })
t(r.st === 200 && leuInteiro >= 1, 'Frustrados arquivado -> Devolvido: caminho de sempre', JSON.stringify(r.j))
t(!naLinha('901') && noArquivo('901') && noArquivo('901').col === 'Devolvido', 'segue SO no arquivo, com a coluna nova', JSON.stringify({ linha: !!naLinha('901'), arquivo: noArquivo('901') && noArquivo('901').col }))
t(sq.prepare('SELECT col FROM leads_arquivo WHERE id=?').get('901').col === 'Devolvido', 'e a coluna indexada do arquivo tambem')

console.log('\n8. GATES')
const col100 = naLinha('100').col
r = await move(TK.gio, '100', { col: 'Frustrados' })
t(r.st === 404 && naLinha('100').col === col100, 'afiliado NAO move pedido da casa (404) e nada muda', JSON.stringify(r))
leuInteiro = 0
r = await move(TK.gio, '200', { col: 'Frustrados' })
t(r.st === 200 && naLinha('200').col === 'Frustrados' && leuInteiro === 0, 'afiliado move o pedido dele, pelo curto', JSON.stringify(r.j) + ' inteiras: ' + leuInteiro)
lc0 = leuCurto; leuInteiro = 0
r = await move(TK.kevin, '100', { col: 'Frustrados' })
t(r.st === 403 && r.j.error === 'Sem permissão', 'vendedor pra Frustrados: 403 Sem permissão', JSON.stringify(r))
t(leuCurto === lc0 && leuInteiro === 0, '    antes de qualquer leitura', 'curtas: ' + (leuCurto - lc0) + ' inteiras: ' + leuInteiro)
regrava((d) => { d.leads.find((l) => l.id === '300').aceito = true }, 'teste')
r = await move(TK.kevin, '300', { col: 'Cancelado' })
t(r.st === 403 && /já foi aceito/.test(String(r.j.error || '')) && naLinha('300').col === 'Cobrança', 'vendedor cancelando pedido ACEITO: 403 com a mensagem de aceito', JSON.stringify(r))
r = await move(null, '100', { col: 'Frustrados' })
t(r.st === 401, 'sem token: 401', JSON.stringify(r))
r = await move(TK.dir, '100', {})
t(r.st === 400 && r.j.error === 'col obrigatório', 'sem col: 400 col obrigatório', JSON.stringify(r))
leuInteiro = 0
r = await move(TK.dir, 'nao-existe', { col: 'Frustrados' })
t(r.st === 404 && r.j.error === 'Lead não encontrado', 'id inexistente: 404', JSON.stringify(r))
t(leuInteiro >= 1, '    (o curto nao inventa 404: devolve null e o caminho de sempre responde)', String(leuInteiro))

console.log('\n9. FORMATO')
t(chavesCurto === 'from,ok,to,version' && chavesCurto === chavesLongo, 'a resposta do curto tem as mesmas chaves da do longo (ok, version, from, to)', chavesCurto + ' x ' + chavesLongo)
const ids = todos().map((l) => String(l.id))
t(new Set(ids).size === ids.length && ['100', '101', '200', '300', '500', '400', '401', '402', '403', '900'].every((id) => ids.includes(id)), 'no fim, todo pedido esta na linha uma vez so', ids.join(','))

console.log('')
if (mau) { console.error('FALHOU: ' + mau + ' de ' + (ok + mau)); process.exit(1) }
console.log('  ' + ok + ' conferencias, todas passaram.')
