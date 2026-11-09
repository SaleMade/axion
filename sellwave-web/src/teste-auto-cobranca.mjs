// AS MENSAGENS AUTOMATICAS DA COBRANCA NO APP (09/11/2026), com o codigo de verdade recortado do
// main.js e do ui/agente.js, em Node puro (sem Electron, sem WhatsApp, sem rede):
//
//   AGENTE: __swChatDe acha a conversa pelo telefone (com e sem o 9, e por @lid), diz quando o cliente
//     e quando nos escrevemos por ultimo e se o codigo ja esta na conversa; o "digitando" da mensagem
//     automatica vale ate na primeira (no funil a primeira sai na hora).
//   MAIN: um envio por vez em cada numero (o painel e o automatico nao digitam juntos); o laco so
//     pergunta com numero de cobranca aberto, alugado e de pe ha 2 min; cada item confere a conversa,
//     PEGA no servidor antes de mandar, manda texto por texto e conta como foi.
//
//   node src/teste-auto-cobranca.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const leia = (rel) => fs.readFileSync(path.join(AQUI, rel), 'utf8').replace(/\r\n/g, '\n')

let ok = 0
const falhas = []
const vale = (nome, certo, det) => {
  if (certo) { ok++; console.log('  OK      ' + nome + (det ? '  ->  ' + det : '')) }
  else { falhas.push(nome); console.log('  FALHOU  ' + nome + (det ? '  ->  ' + det : '')) }
}
// Recorta do inicio da assinatura ate a chave que fecha, pulando texto, comentario e regex simples.
function recorta(fonte, assinatura) {
  const i = fonte.indexOf(assinatura)
  if (i < 0) throw new Error('nao achei: ' + assinatura)
  let nivel = 0, viu = false
  for (let k = fonte.indexOf('{', i); k < fonte.length; k++) {
    const c = fonte[k], n = fonte[k + 1]
    if (c === '/' && n === '/') { k = fonte.indexOf('\n', k); continue }
    if (c === '/' && n === '*') { k = fonte.indexOf('*/', k) + 1; continue }
    if (c === "'" || c === '"' || c === '`') { for (k++; k < fonte.length && fonte[k] !== c; k++) if (fonte[k] === '\\') k++; continue }
    if (c === '{') { nivel++; viu = true }
    else if (c === '}') { nivel--; if (viu && nivel === 0) return fonte.slice(i, k + 1) }
  }
  throw new Error('nao fechou: ' + assinatura)
}
const linhaQueComeca = (fonte, ini) => { const l = fonte.split('\n').find((x) => x.trim().startsWith(ini)); if (!l) throw new Error('sem linha: ' + ini); return l }

// ═══════════════════════════════════════ AGENTE
console.log('\n=== agente: __swChatDe e o digitando da mensagem automatica ===\n')
const AG = leia('ui/agente.js')
{
  const ESPERA_TETO = Number((AG.match(/var ESPERA_TETO = (\d+)/) || [])[1])
  const respiroDoItem = new Function('RESPIRO_BASE', 'RESPIRO_TETO', 'RESPIRO_IMAGEM', 'RESPIRO_VIDEO', 'ESPERA_TETO',
    'return (' + recorta(AG, 'function respiroDoItem(item, ant, ehPrimeiro)') + ')')(10, 20, 60, 30, ESPERA_TETO)
  const r1 = await respiroDoItem({ tipo: 'texto', auto: true, espera: 6 }, null, true)
  const r2 = await respiroDoItem({ tipo: 'texto', espera: 6 }, null, true)
  const r3 = await respiroDoItem({ tipo: 'texto', auto: true, espera: 999 }, null, true)
  const r4 = await respiroDoItem({ tipo: 'texto', auto: true, espera: 9 }, { kind: 'texto' }, false)
  vale('mensagem automatica: o "digitando" vale ate na PRIMEIRA', r1 === 6, String(r1))
  vale('funil normal: a primeira continua saindo na hora', r2 === 0, String(r2))
  vale('o tempo da automatica tem o mesmo teto do funil', r3 === ESPERA_TETO, String(r3))
  vale('e no meio da sequencia usa o tempo dela', r4 === 9, String(r4))
}
function montaChatDe(W) {
  const ctx = { window: { WPP: W }, console }
  vm.createContext(ctx)
  const codigo = [
    linhaQueComeca(AG, 'var JID ='), linhaQueComeca(AG, 'var ehPessoa ='), linhaQueComeca(AG, 'var NAO_E_MSG ='),
    'function autenticado() { return !!(window.WPP && window.WPP.__auth !== false) }',
    recorta(AG, 'function partes(wid)'), recorta(AG, 'function telefoneDoChat(c, id)'),
    recorta(AG, 'window.__swChatDe = function (fone, codigo)'),
  ].join('\n')
  vm.runInContext(codigo, ctx)
  return ctx.window.__swChatDe
}
{
  const conversas = {
    '5511999990001@c.us': [
      { type: 'chat', t: 100, fromMe: false, body: 'Olá! Quero acompanhar o meu pedido.' },
      { type: 'e2e_notification', t: 90 },
      { type: 'chat', t: 150, fromMe: true, body: 'Seu codigo: 888031000000001' },
      { type: 'ciphertext', t: 160, fromMe: false },
    ],
    '123456789012345@lid': [{ type: 'chat', t: 300, id: { fromMe: false }, body: 'oi' }],
    '5511999990001@c.us#velha': [],
  }
  const chats = [
    { id: { _serialized: '5511999990001@c.us' }, t: 160, isGroup: false },
    { id: { _serialized: '123456789012345@lid' }, t: 300, isGroup: false, contact: { phoneNumber: '5521988887777@c.us' } },
    { id: { _serialized: '120363000000000@g.us' }, t: 999, isGroup: true },
  ]
  const W = { chat: { list: async () => chats, getMessages: async (id) => conversas[id] || [] } }
  const chatDe = montaChatDe(W)
  let r = await chatDe('5511999990001', '888031000000001')
  vale('acha a conversa pelo telefone e le quem falou por ultimo', r.ok && r.achou && r.chatId === '5511999990001@c.us' && r.ultIn === 160 && r.ultOut === 150, JSON.stringify(r))
  vale('aviso de criptografia nao conta; a cifrada do cliente conta', r.n === 3, String(r.n))
  vale('ve o codigo numa mensagem nossa', r.temCodigo === true, '')
  r = await chatDe('551199990001', 'AP000000000BR')
  vale('acha tambem sem o nono digito, e codigo que nao esta na conversa da falso', r.achou && r.chatId === '5511999990001@c.us' && r.temCodigo === false, JSON.stringify(r))
  r = await chatDe('21988887777', '')
  vale('conversa por @lid casa pelo telefone do contato', r.achou && r.chatId === '123456789012345@lid' && r.ultIn === 300 && r.ultOut === 0, JSON.stringify(r))
  r = await chatDe('5531900000000', '')
  vale('telefone sem conversa: achou falso (o main tenta depois)', r.ok && r.achou === false, JSON.stringify(r))
  r = await chatDe('abc', '')
  vale('telefone invalido nao estoura', r.ok === false, JSON.stringify(r))
  const chatDe2 = montaChatDe({ __auth: false, chat: W.chat })
  r = await chatDe2('5511999990001', '')
  vale('WhatsApp ainda carregando: ok falso, nada estoura', r.ok === false && /carregando/.test(r.erro), JSON.stringify(r))
  const chatDe3 = montaChatDe({ chat: { list: async () => chats, getMessages: async () => { throw new Error('rede caiu') } } })
  r = await chatDe3('5511999990001', '')
  vale('getMessages que falha vira ok falso com o erro', r.ok === false && /rede caiu/.test(r.erro), JSON.stringify(r))
}

// ═══════════════════════════════════════ MAIN
console.log('\n=== main: um envio por vez, a conferencia e o laco ===\n')
const MN = leia('main.js')
const esperaDoTexto = eval('(' + recorta(MN, 'function esperaDoTexto(texto, i, sorte)') + ')')
const confereAuto = eval('(' + recorta(MN, 'function confereAuto(it, c, agoraS)') + ')')
{
  vale('primeiro texto: 4 a 7 s de digitando', esperaDoTexto('Boa tarde', 0, 0) === 4 && esperaDoTexto('Boa tarde', 0, 1) === 7, esperaDoTexto('x', 0, 0) + '..' + esperaDoTexto('x', 0, 1))
  const longo = 'x'.repeat(450)
  vale('texto longo digita mais, com teto (14 + ate 2)', esperaDoTexto(longo, 2, 0) === 14 && esperaDoTexto(longo, 2, 1) === 16 && esperaDoTexto('curto', 1, 0) === 4, esperaDoTexto(longo, 2, 0) + ' ' + esperaDoTexto('curto', 1, 0))
  const rec = { tipo: 'recepcao', desde: 1000 }
  vale('recepcao: ninguem respondeu depois do cliente -> manda', confereAuto(rec, { ok: true, achou: true, n: 2, ultIn: 1000, ultOut: 0 }, 2000) === null)
  vale('recepcao: o cobrador respondeu (ate pelo celular) -> pula', (confereAuto(rec, { ok: true, achou: true, n: 3, ultIn: 1000, ultOut: 1100 }, 2000) || {}).pula)
  vale('recepcao: resposta ANTIGA (de antes do cliente escrever) nao segura', confereAuto(rec, { ok: true, achou: true, n: 3, ultIn: 1000, ultOut: 500 }, 2000) === null)
  vale('conversa nao achada / pagina sem resposta / sem mensagens -> depois (sem pegar)',
    (confereAuto(rec, { ok: true, achou: false }, 2000) || {}).depois && (confereAuto(rec, null, 2000) || {}).depois && (confereAuto(rec, { ok: true, achou: true, n: 0 }, 2000) || {}).depois)
  const pos = { tipo: 'postado' }
  vale('codigo ja na conversa -> pula', (confereAuto(pos, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 20, temCodigo: true }, 2000) || {}).pula)
  vale('cobrador falando com ele agora -> depois; conversa parada -> manda',
    (confereAuto(pos, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 1950 }, 2000) || {}).depois && confereAuto(pos, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 1000 }, 2000) === null)
}
// ── um envio por vez em cada numero
{
  const F = new Function(['const vezDoNumero = new Map()', recorta(MN, 'function naVezDoNumero(nk, fn)'), 'return { naVezDoNumero, vezDoNumero }'].join('\n'))()
  const ordem = []
  const tarefa = (nome, ms, falha) => () => new Promise((ok, x) => { ordem.push('+' + nome); setTimeout(() => { ordem.push('-' + nome); falha ? x(new Error(nome)) : ok(nome) }, ms) })
  const a = F.naVezDoNumero('11', tarefa('a', 40))
  const b = F.naVezDoNumero('11', tarefa('b', 10, true))
  const c = F.naVezDoNumero('11', tarefa('c', 5))
  const z = F.naVezDoNumero('22', tarefa('z', 5))
  const res = await Promise.allSettled([a, b, c, z])
  vale('mesmo numero: um so depois do outro, na ordem', ordem.filter((x) => /[abc]/.test(x)).join(' ') === '+a -a +b -b +c -c', ordem.join(' '))
  vale('outro numero nao espera', ordem.indexOf('+z') < ordem.indexOf('-a'), ordem.join(' '))
  vale('uma falha nao trava o proximo e volta pra quem chamou', res[1].status === 'rejected' && res[2].value === 'c', JSON.stringify(res.map((x) => x.status)))
  await new Promise((r) => setTimeout(r, 5))
  vale('a fila do numero se limpa sozinha', F.vezDoNumero.size === 0, String(F.vezDoNumero.size))
}
// ── mandaItem: o swp:manda de sempre, agora na vez do numero
{
  const chamadas = []
  let ativos = 0, maxAtivos = 0
  const wc = { isDestroyed: () => false }
  const F = new Function('abertos', 'viewAtiva', 'dataUriDe', 'comTetoNode', 'tetoDoItem', 'confereCaptura', 'CAPTURA_ESPERA_MS', 'colheConversa', [
    'const vezDoNumero = new Map()', recorta(MN, 'function naVezDoNumero(nk, fn)'), recorta(MN, 'async function mandaItem(nk, chatId, item)'), 'return { mandaItem }',
  ].join('\n'))(
    new Map([['1127335679', { view: { webContents: wc } }]]), () => null, async () => 'data:x',
    async (w, chave, codigo) => { ativos++; maxAtivos = Math.max(maxAtivos, ativos); chamadas.push(codigo); await new Promise((r) => setTimeout(r, 15)); ativos--; return true },
    () => 1000, () => {}, 5, async () => {},
  )
  const r = await Promise.all([
    F.mandaItem('1127335679', 'a@c.us', { tipo: 'texto', texto: 'um' }),
    F.mandaItem('1127335679', 'b@c.us', { tipo: 'texto', texto: 'dois', auto: true, espera: 5 }),
  ])
  vale('dois envios no mesmo numero nunca ao mesmo tempo', maxAtivos === 1 && r.every((x) => x.ok), 'max=' + maxAtivos)
  vale('o item vai inteiro pro __swManda (com auto e espera)', /__swManda\("b@c\.us",\{"tipo":"texto","texto":"dois","auto":true,"espera":5\}\)/.test(chamadas[1] || ''), (chamadas[1] || '').slice(0, 90))
  const fechado = await F.mandaItem('9999999999', 'a@c.us', { tipo: 'texto', texto: 'x' })
  vale('numero fechado: erro claro, nada sai', fechado.ok === false && /fechado/.test(fechado.erro), JSON.stringify(fechado))
  vale('o swp:manda passou a ser o mandaItem', /ipcMain\.handle\('swp:manda', \(_e, \{ nk, chatId, item \}\) => mandaItem\(nk, chatId, item\)\)/.test(MN))
}
// ── rodaAuto: conferir, pegar, mandar, contar
function montaRoda(op) {
  const log = { js: [], posts: [], mandou: [], avisos: [], esperas: [], anota: [] }
  const wc = { isDestroyed: () => false, executeJavaScript: async (codigo) => { log.js.push(codigo); return typeof op.chatDe === 'function' ? op.chatDe() : op.chatDe } }
  const abertos = new Map([['1127335679', { view: { webContents: wc }, prontoEm: 1 }]])
  const disparos = op.disparos || new Map()
  const autoNoAr = new Set()
  const fetchFalso = async (url, init) => {
    const corpo = JSON.parse(init.body)
    log.posts.push({ rota: url.replace('https://api', ''), corpo, disparoNaHora: disparos.has('1127335679') })
    const rota = url.replace('https://api', '')
    const resp = rota === '/api/swweb/auto/pega' ? (op.pega || { ok: true }) : { ok: true }
    return { ok: true, json: async () => resp }
  }
  const F = new Function('abertos', 'prontoCob', 'disparos', 'autoNoAr', 'espera', 'anota', 'avisaPainel', 'avisaCasca', 'mandaItem', 'fetch', 'config', 'cabecalhos', [
    'const autoDepois = new Map()',
    recorta(MN, 'function esperaDoTexto(texto, i, sorte)'), recorta(MN, 'function confereAuto(it, c, agoraS)'),
    recorta(MN, 'async function postaAuto(rota, corpo)'), recorta(MN, 'async function rodaAuto(it)'), 'return { rodaAuto, autoDepois }',
  ].join('\n'))(
    abertos, () => true, disparos, autoNoAr,
    async (ms) => { log.esperas.push(ms); if (op.aoEsperar) op.aoEsperar(log.esperas.length) },
    (t) => log.anota.push(t), () => {}, (canal, d) => log.avisos.push(d),
    async (nk, chatId, item) => {
      log.mandou.push({ nk, chatId, item, protegido: autoNoAr.has(nk), postsAntes: log.posts.length })
      if (op.falhaNo && log.mandou.length === op.falhaNo) return { ok: false, erro: 'o número não respondeu a tempo' }
      return { ok: true }
    },
    fetchFalso, { apiBase: 'https://api', token: 't' }, () => ({}),
  )
  return { F, log, disparos, autoNoAr }
}
const REC = { k: 'rec:2492940773', tipo: 'recepcao', nk: '1127335679', fone: '5524992940773', nome: 'Paulo Cesar', pedido: '1794056847995', codigo: '888031035093814', desde: 1000,
  textos: ['Boa tarde Paulo Cesar', 'Aqui quem fala é o Elias...', 'Localizei o seu pedido...', 'Tenho uma atualização... 888031035093814'], chaves: ['rec:2492940773', 'pos:1794056847995:888031035093814'] }
{
  const { F, log, disparos, autoNoAr } = montaRoda({ chatDe: { ok: true, achou: true, chatId: '5524992940773@c.us', ultIn: 1000, ultOut: 0, n: 2 } })
  const r = await F.rodaAuto(REC)
  vale('caminho feliz: manda os 4 textos, na ordem, na conversa achada', r === 'enviado' && log.mandou.length === 4 && log.mandou.every((m, i) => m.chatId === '5524992940773@c.us' && m.item.texto === REC.textos[i]), r + ' ' + log.mandou.length)
  vale('confere a conversa ANTES de pegar, e pega ANTES de mandar', /__swChatDe\("5524992940773","888031035093814"\)/.test(log.js[0] || '') && log.posts[0].rota === '/api/swweb/auto/pega' && log.mandou[0].postsAntes === 1, log.posts.map((p) => p.rota).join(' '))
  vale('pega com as duas chaves (a recepcao e o codigo que vai junto)', JSON.stringify(log.posts[0].corpo.chaves) === JSON.stringify(REC.chaves) && log.posts[0].corpo.nk === '1127335679', JSON.stringify(log.posts[0].corpo))
  vale('cada texto vai como automatico, com digitando (4 a 7 s no primeiro)', log.mandou.every((m) => m.item.auto === true && m.item.tipo === 'texto' && m.item.espera > 0) && log.mandou[0].item.espera >= 4 && log.mandou[0].item.espera <= 7, log.mandou.map((m) => m.item.espera).join(','))
  vale('conta como foi: enviado, 4 textos', log.posts[1].rota === '/api/swweb/auto/feito' && log.posts[1].corpo.ok === true && log.posts[1].corpo.n === 4, JSON.stringify(log.posts[1].corpo))
  vale('enquanto manda, o numero fica protegido da hibernacao e do recarregar; depois solta', log.mandou.every((m) => m.protegido === true) && !autoNoAr.has('1127335679') && !disparos.has('1127335679'), '')
  vale('a barra avisa o cobrador', log.avisos.length === 1 && /Recepção automática enviada para Paulo Cesar/.test(log.avisos[0].texto), JSON.stringify(log.avisos))
}
{
  const { F, log } = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 1000, ultOut: 1200, n: 3 } })
  const r = await F.rodaAuto(REC)
  vale('o cobrador ja respondeu pelo celular: pega, conta como pulado e NAO manda nada', r === 'pulado' && log.mandou.length === 0 && log.posts.map((p) => p.rota).join(' ') === '/api/swweb/auto/pega /api/swweb/auto/feito' && log.posts[1].corpo.pulado === true, JSON.stringify(log.posts.map((p) => p.corpo.motivo || '')))
}
{
  const { F, log } = montaRoda({ chatDe: { ok: true, achou: false } })
  const rs = []
  for (let i = 0; i < 5; i++) rs.push(await F.rodaAuto(REC))
  vale('conversa que a pagina nao acha: 4 voltas "depois" sem pegar nada', rs.slice(0, 4).every((x) => x === 'depois') && log.posts.length === 2, rs.join(' '))
  vale('na quinta, pega e conta como pulado (nao gira pra sempre)', rs[4] === 'pulado' && log.posts[1].corpo.pulado === true && /conversa/.test(log.posts[1].corpo.motivo) && log.mandou.length === 0, JSON.stringify(log.posts.map((p) => p.corpo.motivo || p.rota)))
}
{
  const { F, log } = montaRoda({ chatDe: { ok: false, erro: 'agente sem __swChatDe' } })
  const rs = []
  for (let i = 0; i < 7; i++) rs.push(await F.rodaAuto(REC))
  vale('pagina com o agente velho (ainda nao recarregou): so espera, nunca vira pulado', rs.every((x) => x === 'depois') && log.posts.length === 0, rs.join(' '))
}
{
  const { F, log } = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 1000, ultOut: 0, n: 2 }, pega: { ok: false, ja: true } })
  const r = await F.rodaAuto(REC)
  vale('outro ja pegou: nao manda nada', r === 'ja' && log.mandou.length === 0 && log.posts.length === 1, r)
}
{
  const { F, log } = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 1000, ultOut: 0, n: 2 }, falhaNo: 2 })
  const r = await F.rodaAuto(REC)
  vale('falhou no segundo texto: para ali e conta 1 de 4 com o motivo', r === 'falhou' && log.mandou.length === 2 && log.posts[1].corpo.ok === false && log.posts[1].corpo.n === 1 && /respondeu/.test(log.posts[1].corpo.motivo) && !log.avisos.length, JSON.stringify(log.posts[1].corpo))
}
{
  const POS = { k: 'pos:1:AP1', tipo: 'postado', nk: '1127335679', fone: '5511999990001', nome: 'Ana', codigo: 'AP1', textos: ['Tenho uma atualização... AP1'], chaves: ['pos:1:AP1'] }
  let a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 10, ultOut: 20, n: 4, temCodigo: true } })
  let r = await a.F.rodaAuto(POS)
  vale('codigo de rastreio que ja esta na conversa: pulado', r === 'pulado' && a.log.mandou.length === 0, r)
  a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 10, ultOut: Math.floor(Date.now() / 1000) - 30, n: 4 } })
  r = await a.F.rodaAuto(POS)
  vale('cobrador falando com o cliente agora: espera a proxima volta', r === 'depois' && a.log.posts.length === 0, r)
  a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 10, ultOut: 20, n: 4 } })
  r = await a.F.rodaAuto(POS)
  vale('codigo novo: manda e avisa como codigo de rastreio', r === 'enviado' && a.log.mandou.length === 1 && /Código de rastreio enviado automaticamente para Ana/.test((a.log.avisos[0] || {}).texto || ''), JSON.stringify(a.log.avisos))
}
{
  const disparos = new Map([['1127335679', { quem: 7, funil: 'Etapa 3' }]])
  const { F, log } = montaRoda({ disparos, chatDe: { ok: true, achou: true, chatId: 'x@c.us', ultIn: 1000, ultOut: 0, n: 2 }, aoEsperar: (n) => { if (n === 3) disparos.delete('1127335679') } })
  const r = await F.rodaAuto(REC)
  vale('painel disparando funil no numero: espera ele acabar antes de conferir e mandar', r === 'enviado' && log.esperas.slice(0, 3).every((ms) => ms === 5000) && log.js.length === 1, log.esperas.join(','))
}
// ── o laco
function montaLaco(op) {
  const log = { fetch: [], rodou: [], esperas: [] }
  const agora = op.agora || 10_000_000
  const abertos = new Map(Object.entries(op.abertos || { '1127335679': { prontoEm: agora - 200000 } }))
  const F = new Function('config', 'abertos', 'alugados', 'ehDeCobranca', 'prontoCob', 'fetch', 'cabecalhos', 'ajustaRelogio', 'rodaAuto', 'espera', 'anota', 'Date', [
    'const AUTO_PRONTO_MS = 120000', 'const AUTO_POR_RODADA = 4', 'let autoRodando = false', 'let autoProximaEm = 0',
    recorta(MN, 'async function autoCobranca()'),
    'return { autoCobranca, prox: () => autoProximaEm, rodando: () => autoRodando }',
  ].join('\n'))(
    { apiBase: 'https://api', token: op.semToken ? '' : 't' }, abertos, new Set(op.alugados || ['1127335679']),
    (nk) => (op.cobranca || ['1127335679']).includes(nk), () => true,
    async (url) => { log.fetch.push(url); if (op.falhaRede) throw new Error('sem rede'); return { ok: true, json: async () => op.resposta } },
    () => ({}), () => {},
    async (it) => { log.rodou.push(it.k); return op.resultado || 'enviado' },
    async (ms) => { log.esperas.push(ms) }, () => {}, { now: () => agora },
  )
  return { F, log, agora }
}
{
  let a = montaLaco({ semToken: true })
  await a.F.autoCobranca()
  vale('sem login: nem pergunta', a.log.fetch.length === 0)
  a = montaLaco({ cobranca: [] })
  await a.F.autoCobranca()
  vale('numero aberto que nao e de cobranca: nem pergunta', a.log.fetch.length === 0)
  a = montaLaco({ alugados: [] })
  await a.F.autoCobranca()
  vale('numero sem o aluguel desta maquina: nem pergunta', a.log.fetch.length === 0)
  a = montaLaco({ abertos: { '1127335679': { prontoEm: 10_000_000 - 30000 } } })
  await a.F.autoCobranca()
  vale('conectado ha menos de 2 min: espera a sincronizacao do WhatsApp', a.log.fetch.length === 0)
  const itens = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ k: 'rec:' + x, nk: '1127335679' })).concat([{ k: 'rec:outro', nk: '9999999999' }])
  a = montaLaco({ resposta: { ok: true, itens, proxima: 60 } })
  await a.F.autoCobranca()
  vale('pergunta pelos numeros dele', a.log.fetch.length === 1 && /\/api\/swweb\/auto\?nks=1127335679$/.test(a.log.fetch[0]), a.log.fetch[0])
  vale('roda no maximo 4 por volta, so dos numeros dele', a.log.rodou.join(',') === 'rec:a,rec:b,rec:c,rec:d', a.log.rodou.join(','))
  vale('respiro de 30 a 60 s entre um cliente e outro (3 respiros pra 4)', a.log.esperas.length === 3 && a.log.esperas.every((ms) => ms >= 30000 && ms < 60000), a.log.esperas.join(','))
  vale('sobrou fila: volta em 30 s, e solta a trava', a.F.prox() === a.agora + 30000 && a.F.rodando() === false, String(a.F.prox() - a.agora))
  a = montaLaco({ resposta: { ok: true, itens: [{ k: 'rec:a', nk: '1127335679' }], proxima: 60 } })
  await a.F.autoCobranca()
  vale('sem sobra: volta no ritmo do servidor (60 s) e sem respiro a toa', a.F.prox() === a.agora + 60000 && a.log.esperas.length === 0, String(a.F.prox() - a.agora))
  a = montaLaco({ resposta: { ok: true, itens: [], proxima: 300 } })
  await a.F.autoCobranca()
  vale('desligado na dash: 5 min ate perguntar de novo', a.F.prox() === a.agora + 300000, String(a.F.prox() - a.agora))
  a = montaLaco({ falhaRede: true })
  await a.F.autoCobranca()
  vale('sem rede: tenta de novo em 2 min, sem estourar', a.F.prox() === a.agora + 120000 && a.F.rodando() === false, String(a.F.prox() - a.agora))
  a = montaLaco({ resposta: { ok: true, itens: [{ k: 'rec:a', nk: '1127335679' }, { k: 'rec:b', nk: '1127335679' }], proxima: 60 }, resultado: 'pulado' })
  await a.F.autoCobranca()
  vale('pulado nao gasta respiro', a.log.rodou.length === 2 && a.log.esperas.length === 0, a.log.esperas.join(','))
}
vale('a hibernacao e o "recarregar todos" respeitam quem esta mandando automatica', /!disparos\.has\(s\.nk\) && !autoNoAr\.has\(s\.nk\)/.test(MN) && /if \(disparos\.has\(nk\) \|\| autoNoAr\.has\(nk\)\) \{ noFunil \+= 1; continue \}/.test(MN))
vale('o laco esta ligado no relogio do app (a cada 15 s)', /setInterval\(\(\) => \{ autoCobranca\(\)\.catch\(\(\) => \{\}\) \}, AUTO_TICK_MS\)/.test(MN) && /const AUTO_TICK_MS = 15000/.test(MN))
vale('o "de pe desde" e carimbado na virada pra pronto', /if \(st === 'pronto'\) s\.prontoEm = Date\.now\(\)/.test(MN))

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
if (falhas.length) { console.log('FALHARAM:\n - ' + falhas.join('\n - ')); process.exit(1) }
