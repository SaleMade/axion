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
    linhaQueComeca(AG, 'var CALMA_MS ='), linhaQueComeca(AG, 'var oc = {'), recorta(AG, 'function micAberto(agora)'), recorta(AG, 'function ocupadoAgora(agora)'),
    recorta(AG, 'function partes(wid)'), recorta(AG, 'function telefoneDoChat(c, id)'),
    recorta(AG, 'window.__swChatDe = function (fone, codigo)'),
  ].join('\n')
  vm.runInContext(codigo, ctx)
  montaChatDe.oc = ctx.oc   // o estado do "cobrador ocupado" desta pagina de mentira
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
  // O COBRADOR OCUPADO NESTE NUMERO (12/11/2026): a conferencia recusa antes de olhar a conversa
  const chatDe4 = montaChatDe(W)
  montaChatDe.oc.mao = Date.now() - 20000
  r = await chatDe4('5511999990001', '')
  vale('cobrador mexendo no WhatsApp ha 20 s: a conferencia recusa (ok falso, ocupado)', r.ok === false && r.ocupado === true && /cobrador ocupado: mexendo no WhatsApp/.test(r.erro), JSON.stringify(r))
  montaChatDe.oc.mao = Date.now() - 95000
  r = await chatDe4('5511999990001', '')
  vale('95 s sem mexer: a conferencia volta a ler a conversa', r.ok === true && r.achou === true, JSON.stringify(r))
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
    'const autoDepois = new Map()', "let autoEspera = { motivo: '', em: 0 }", recorta(MN, 'function anotaEspera(motivo)'),
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
// ── AS AUTOMACOES NOVAS (11/11/2026): tipos novos, `falouDesde`, a foto da entrega e os avisos
{
  const ret = { tipo: 'retirada', falouDesde: 1500 }
  vale('tipo novo: o cobrador falou DEPOIS do fato (falouDesde) -> pula', (confereAuto(ret, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 1600 }, 5000) || {}).pula === 'o cobrador já falou com ele')
  vale('tipo novo: a ultima fala dele e de ANTES do fato -> manda', confereAuto(ret, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 1400 }, 5000) === null)
  vale('tipo novo: codigo ja na conversa NAO segura (o lembrete da retirada repete o codigo de proposito)', confereAuto(ret, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 1400, temCodigo: true }, 5000) === null)
  vale('tipo novo: cobrador falando agora -> depois', (confereAuto(ret, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 4950 }, 5000) || {}).depois)
  vale('o codigo de rastreio continua pulando quando ja esta na conversa', (confereAuto({ tipo: 'postado' }, { ok: true, achou: true, n: 5, ultIn: 10, ultOut: 20, temCodigo: true }, 5000) || {}).pula)
}
{
  const ENT = { k: 'ent:77', tipo: 'entregue', nk: '1127335679', fone: '5531999990077', nome: 'Maria', pedido: '77', codigo: '', falouDesde: 900,
    textos: ['Oi Maria, acabei de ver que seu pedido chegou na sua casa hoje. Recebeu ele tudo certinho?'],
    partes: [{ tipo: 'texto', texto: 'Oi Maria, acabei de ver que seu pedido chegou na sua casa hoje. Recebeu ele tudo certinho?' }, { tipo: 'midia', kind: 'image', url: 'https://axion-api.axion-dash.workers.dev/api/arquivo/comprovante%2F77%2Fentrega.jpg?exp=1&sig=ab' }],
    chaves: ['ent:77'] }
  let a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'm@c.us', ultIn: 100, ultOut: 200, n: 4 } })
  let r = await a.F.rodaAuto(ENT)
  const m = a.log.mandou
  vale('entregue: manda o texto e DEPOIS a foto, na conversa achada', r === 'enviado' && m.length === 2 && m[0].item.tipo === 'texto' && m[1].item.tipo === 'midia' && m[1].item.kind === 'image' && m[1].item.url === ENT.partes[1].url, r + ' ' + m.length)
  vale('a foto vai como automatica, 3 s depois, sem legenda', m[1] && m[1].item.auto === true && m[1].item.espera === 3 && m[1].item.caption === '', JSON.stringify(m[1] && m[1].item))
  vale('conta as duas partes como enviadas e pega com o tipo novo', a.log.posts[0].corpo.tipo === 'entregue' && a.log.posts[1].corpo.ok === true && a.log.posts[1].corpo.n === 2, JSON.stringify(a.log.posts[1].corpo))
  vale('a conferencia da conversa nao passa codigo nenhum (nao e o Postado)', /__swChatDe\("5531999990077",""\)/.test(a.log.js[0] || ''), a.log.js[0])
  vale('a barra avisa com a frase do tipo', a.log.avisos.length === 1 && /Mensagem de pedido entregue enviada para Maria\./.test(a.log.avisos[0].texto), JSON.stringify(a.log.avisos))
  a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'm@c.us', ultIn: 100, ultOut: 200, n: 4 }, falhaNo: 2 })
  r = await a.F.rodaAuto(ENT)
  vale('a foto falhou depois do texto: conta 1 de 2 (parcial no servidor, nunca repete o texto)', r === 'falhou' && a.log.posts[1].corpo.ok === false && a.log.posts[1].corpo.n === 1, JSON.stringify(a.log.posts[1].corpo))
  a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'm@c.us', ultIn: 100, ultOut: 950, n: 4 } })
  r = await a.F.rodaAuto(ENT)
  vale('o cobrador ja perguntou depois da entrega: pulado, nada sai', r === 'pulado' && a.log.mandou.length === 0 && /já falou/.test(a.log.posts[1].corpo.motivo), JSON.stringify(a.log.posts.map((p) => p.corpo.motivo || '')))
  a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'm@c.us', ultIn: 100, ultOut: 200, n: 4 } })
  r = await a.F.rodaAuto({ ...ENT, partes: [ENT.partes[0], { tipo: 'midia', kind: 'image', url: 'file:///c:/x.jpg' }] })
  vale('endereco de midia que nao e https e descartado (vai so o texto)', r === 'enviado' && a.log.mandou.length === 1, r + ' ' + a.log.mandou.length)
  const AVISOS = { saiu: /saída para entrega/, retirada: /Lembrete de retirada/, naoachou: /entrega não concluída/, naopagou: /Lembrete de pagamento/, atrasou: /Aviso de atraso/, pagou: /Agradecimento do pagamento/ }
  let certos = 0
  for (const [tipo, re] of Object.entries(AVISOS)) {
    a = montaRoda({ chatDe: { ok: true, achou: true, chatId: 'm@c.us', ultIn: 100, ultOut: 200, n: 4 } })
    await a.F.rodaAuto({ k: tipo + ':1', tipo, nk: '1127335679', fone: '5531999990077', nome: 'Maria', textos: ['oi'], chaves: [tipo + ':1'] })
    if (re.test((a.log.avisos[0] || {}).texto || '')) certos++
  }
  vale('cada tipo novo tem a propria frase na barra', certos === 6, String(certos))
}
{
  const PR = leia('preload-painel.js'), PU = leia('ui/painel-ui.js'), PH = leia('ui/painel.html')
  vale('a ponte do painel tem a lista e o interruptor das automacoes', /autoConfig: \(\) => ipcRenderer\.invoke\('swp:auto-config'\)/.test(PR) && /autoLiga: \(id, ligado\) => ipcRenderer\.invoke\('swp:auto-liga', \{ id, ligado: !!ligado \}\)/.test(PR))
  vale('o main le e grava pela rota das automacoes (com o "ver como")', /ipcMain\.handle\('swp:auto-config', \(\) => lerCob\('\/api\/swweb\/auto\/config\?v=1' \+ comoE\(\)\)\)/.test(MN) && /ipcMain\.handle\('swp:auto-liga'/.test(MN) && /\.\.\.\(comoId \? \{ de: comoId \} : \{\}\)/.test(MN))
  vale('a aba Automacoes nasce escondida e so aparece na versao de cobrador', /data-aba="auto" id="aba-auto" hidden/.test(PH) && /abaAuto\.hidden = !cobModo/.test(PU) && /\.aba\[hidden\] \{ display: none; \}/.test(PH))
}
// ── a aba Automacoes desenhada de verdade (o codigo do painel, com um documento de mentira)
{
  const PU = leia('ui/painel-ui.js')
  const pedacos = ['const AUTO_EX = ', 'const autoExemplo = ', 'const AUTO_ST = '].map((ini) => linhaQueComeca(PU, ini))
  const F = new Function('auto', 'esc', 'IC_SETA', 'window', 'IC_LAPIS', 'IC_GIRA', [
    ...pedacos, recorta(PU, 'const autoHora = (s) =>') + '', recorta(PU, 'function desenhaAutoTexto(t, x, n)'), recorta(PU, 'function desenhaAuto()'), 'return { desenhaAuto, autoExemplo }',
  ].join('\n'))
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const auto = { em: 1, carregando: false, erro: '', salvando: '', aberto: 'ret', numeros: 1, ultimos: [{ id: 'sai', nome: 'Maria <b>', status: 'enviado', ts: 1794315600 }],
    tipos: [
      { id: 'rec', nome: 'Boas-vindas', dica: 'd1', direcao: true, meu: true, hoje: 3, textos: [{ rot: 'Saudação', texto: '{saudacao} {nome}' }] },
      { id: 'ret', nome: 'Retirar nos Correios', dica: 'd2', direcao: true, meu: false, hoje: 0, textos: [{ rot: 'Dia 1', texto: 'Oi {primeiro}, código {codigo}' }, { rot: 'Dia 2', texto: 'R$ {valor} {novidade}' }] },
      { id: 'pag', nome: 'Pagou', dica: 'd3', direcao: false, meu: true, hoje: 0, textos: [] },
    ] }
  const { desenhaAuto, autoExemplo } = F(auto, esc, '<svg></svg>', { swp: { autoConfig: () => {} } })
  const h = desenhaAuto()
  vale('desenha um cartao por automacao, com o interruptor no estado de cada uma', (h.match(/class="au-it/g) || []).length === 3 && /class="au-sw on" role="switch" aria-checked="true"[^>]*data-au="rec"/.test(h) && /class="au-sw" role="switch" aria-checked="false"[^>]*data-au="ret"/.test(h), '')
  vale('mostra quantas sairam hoje so quando saiu alguma', /<span class="au-hoje">3 hoje<\/span>/.test(h) && (h.match(/au-hoje/g) || []).length === 1, '')
  vale('o que a direcao desligou aparece como "Desligada pela direção"', (h.match(/Desligada pela direção/g) || []).length === 1, '')
  vale('a mensagem aberta mostra os textos em balao, com exemplo no lugar da variavel', /Oi Maria, código AP123456789BR/.test(h) && /R\$ 497,00 \{novidade\}/.test(h) && !/\{primeiro\}/.test(h), '')
  vale('variavel desconhecida fica como esta (nao inventa)', autoExemplo('{x} {link_pag}') === '{x} link de pagamento', autoExemplo('{x} {link_pag}'))
  vale('os ultimos envios mostram cliente, automacao e situacao, com o nome escapado', /Maria &lt;b&gt;<\/b> · Mensagem|Maria &lt;b&gt;/.test(h) && /class="s ok">Enviada/.test(h), '')
  const semApp = F(auto, esc, '', { swp: {} }).desenhaAuto()
  vale('app sem a ponte nova pede pra atualizar em vez de quebrar', /Atualize o app/.test(semApp), semApp)
  const vazio = F({ ...auto, tipos: [], em: 0 }, esc, '', { swp: { autoConfig: () => {} } }).desenhaAuto()
  vale('antes de a lista chegar mostra "Carregando"', /Carregando/.test(vazio), vazio)
  // ── EDITAR O TEXTO (13/11/2026): o lapis so aparece com servidor e app que sabem editar
  vale('sem o servidor dizer que da pra editar, a aba nao tem lapis (fica como era)', !/data-ed=/.test(h) && !/data-area/.test(h), '')
  const TX = (campo, texto, proprio) => ({ campo, rot: 'Dia 1', texto, proprio: !!proprio, vars: ['primeiro', 'codigo'] })
  const comEd = { ...auto, pode: true, dir: false, de: null, varRot: { primeiro: 'Primeiro nome' }, edita: null,
    tipos: [{ id: 'ret', nome: 'Retirar nos Correios', dica: 'd2', direcao: true, meu: true, hoje: 0, textos: [TX('ret1', 'Oi {primeiro}', true), TX('ret2', 'Lembrete <2>')] }] }
  let he = F(comEd, esc, '', { swp: { autoConfig: () => {} } }, '<i>lapis</i>', '<i>gira</i>').desenhaAuto()
  vale('com editar ligado, cada texto tem o lapis com o campo e o selo no que e dele', (he.match(/data-ed="/g) || []).length === 2 && /data-tipo="ret" data-ed="ret1"/.test(he) && (he.match(/class="au-meu">Seu texto</g) || []).length === 1, '')
  comEd.edita = { id: 'ret', campo: 'ret2', valor: 'Lembrete <2> & "aspas"', original: 'Lembrete <2>', erro: 'Aviso <x>', salvando: '' }
  he = F(comEd, esc, '', { swp: { autoConfig: () => {} } }, '<i>lapis</i>', '<i>gira</i>').desenhaAuto()
  vale('editando: a caixa leva o texto escapado, os botoes do que da pra colocar e o aviso', />Lembrete &lt;2&gt; &amp; &quot;aspas&quot;<\/textarea>/.test(he) && /data-var="primeiro"[^>]*>Primeiro nome</.test(he) && /data-var="codigo"[^>]*>\{codigo\}</.test(he) && /class="au-erro">Aviso &lt;x&gt;</.test(he), '')
  vale('editando (cobrador): Salvar e Cancelar, sem "pra todos"; o outro texto continua com o lapis', /data-salva="um"[^>]*>Salvar</.test(he) && /data-cancela/.test(he) && !/data-salva="todos"/.test(he) && (he.match(/data-ed="/g) || []).length === 1, '')
  comEd.dir = true; comEd.de = { id: 'c1', nome: 'Bryan <b>' }; comEd.edita.campo = 'ret1'; comEd.edita.salvando = 'todos'
  he = F(comEd, esc, '', { swp: { autoConfig: () => {} } }, '<i>lapis</i>', '<i>gira</i>').desenhaAuto()
  vale('editando (direcao vendo o cobrador): "Salvar pra todos" e "Só para <nome>", com o nome escapado', /data-salva="todos" disabled><i>gira<\/i>Salvar pra todos</.test(he) && /data-salva="um" disabled>Só para Bryan &lt;b&gt;</.test(he) && /class="au-meu">Texto de Bryan &lt;b&gt;</.test(he), '')
  vale('enquanto salva, a caixa fica so de leitura e o "Voltar ao padrão" travado', /data-area[^>]* readonly>/.test(he) && /data-salva="padrao" disabled>Voltar ao padrão</.test(he), '')
  {
    const PR = leia('preload-painel.js')
    vale('a ponte do painel manda o texto com o campo, pra todos ou de volta ao padrao', /autoTexto: \(campo, texto, opc\) => ipcRenderer\.invoke\('swp:auto-texto', \{ campo, texto, todos: !!\(opc && opc\.todos\), padrao: !!\(opc && opc\.padrao\) \}\)/.test(PR))
    // (o `recorta` pararia na primeira chave, a dos parametros: aqui vale o trecho inteiro do handler)
    const iH = MN.indexOf("ipcMain.handle('swp:auto-texto'")
    const H = iH < 0 ? '' : MN.slice(iH, iH + 1600)
    vale('o main grava o texto pela rota das automacoes, com o "ver como" e sem mandar "todos" junto com "padrao"', /\/api\/swweb\/auto\/config/.test(H) && /\.\.\.\(comoId \? \{ de: comoId \} : \{\}\)/.test(H) && /todos && !padrao/.test(H) && /autoProximaEm = 0/.test(H), H.slice(0, 80))
  }
}
// ── o laco
function montaLaco(op) {
  const log = { fetch: [], rodou: [], esperas: [], anota: [], perguntas: 0 }
  const agora = op.agora || 10_000_000
  const abertos = new Map(Object.entries(op.abertos || { '1127335679': { prontoEm: agora - 200000 } }))
  const F = new Function('config', 'abertos', 'alugados', 'ehDeCobranca', 'prontoCob', 'fetch', 'cabecalhos', 'ajustaRelogio', 'rodaAuto', 'espera', 'anota', 'Date', 'cobradorOcupado', [
    'const AUTO_PRONTO_MS = 120000', 'const AUTO_POR_RODADA = 4', 'let autoRodando = false', 'let autoProximaEm = 0',
    "let autoEspera = { motivo: '', em: 0 }", recorta(MN, 'function anotaEspera(motivo)'),
    recorta(MN, 'async function autoCobranca()'),
    'return { autoCobranca, prox: () => autoProximaEm, rodando: () => autoRodando }',
  ].join('\n'))(
    { apiBase: 'https://api', token: op.semToken ? '' : 't' }, abertos, new Set(op.alugados || ['1127335679']),
    (nk) => (op.cobranca || ['1127335679']).includes(nk), () => true,
    async (url) => { log.fetch.push(url); if (op.falhaRede) throw new Error('sem rede'); return { ok: true, json: async () => op.resposta } },
    () => ({}), () => {},
    async (it) => { log.rodou.push(it.k); return op.resultado || 'enviado' },
    async (ms) => { log.esperas.push(ms) }, (t) => log.anota.push(t), { now: () => agora },
    // `ocupado` = o que o cobradorOcupado responde a cada pergunta (texto, ou funcao da vez)
    async () => { log.perguntas++; return typeof op.ocupado === 'function' ? op.ocupado(log.perguntas) : (op.ocupado || '') },
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
// ── SO COM O COBRADOR LIVRE (12/11/2026, pedido do Bruno: "quando o meu cobrador nao estiver em ligacao,
// quando ele nao estiver respondendo a ninguem, quando estiver tudo tranquilo")
console.log('\n=== main: a automatica espera o cobrador ficar livre ===\n')
{
  const itens = ['a', 'b', 'c'].map((x) => ({ k: 'rec:' + x, nk: '1127335679' }))
  let a = montaLaco({ resposta: { ok: true, itens, proxima: 60 }, ocupado: 'em ligação (11) 92733-5679' })
  await a.F.autoCobranca()
  vale('cobrador em ligacao: nem pergunta ao servidor, nada sai', a.log.fetch.length === 0 && a.log.rodou.length === 0, a.log.fetch.length + ' ' + a.log.rodou.length)
  vale('olha de novo em 30 s e solta a trava', a.F.prox() === a.agora + 30000 && a.F.rodando() === false, String(a.F.prox() - a.agora))
  vale('o registro diz por que esta esperando', a.log.anota.length === 1 && /esperando o cobrador ficar livre: em ligação/.test(a.log.anota[0]), a.log.anota.join(' | '))
  await a.F.autoCobranca()
  vale('o relogio do app nao deixa perguntar de novo antes dos 30 s', a.log.perguntas === 1, String(a.log.perguntas))
  a = montaLaco({ resposta: { ok: true, itens, proxima: 60 }, ocupado: '' })
  await a.F.autoCobranca()
  vale('cobrador livre: tudo como antes (pergunta e manda os tres)', a.log.fetch.length === 1 && a.log.rodou.join(',') === 'rec:a,rec:b,rec:c', a.log.rodou.join(','))
  vale('e confere de novo antes de cada cliente seguinte (1 no comeco + 2 no meio)', a.log.perguntas === 3, String(a.log.perguntas))
  a = montaLaco({ resposta: { ok: true, itens, proxima: 60 }, ocupado: (n) => (n >= 2 ? 'respondendo um cliente (11) 92733-5679' : '') })
  await a.F.autoCobranca()
  vale('voltou a trabalhar no respiro entre dois clientes: o primeiro saiu, o resto espera', a.log.rodou.join(',') === 'rec:a' && a.F.prox() === a.agora + 30000 && a.F.rodando() === false, a.log.rodou.join(','))
}
{
  // a mesma linha no registro nao se repete a cada 30 s
  const linhas = []
  let agoraT = 1_000_000
  const F = new Function('anota', 'Date', ["let autoEspera = { motivo: '', em: 0 }", recorta(MN, 'function anotaEspera(motivo)'), 'return anotaEspera'].join('\n'))((t) => linhas.push(t), { now: () => agoraT })
  F('em ligação'); agoraT += 30000; F('em ligação'); agoraT += 30000; F('mexendo no WhatsApp'); agoraT += 601000; F('mexendo no WhatsApp')
  vale('o registro so anota quando o motivo muda, e de novo depois de 10 min', linhas.length === 3, linhas.join(' | '))
}
{
  // cobradorOcupado: a pergunta vai pra TODOS os numeros abertos e de pe
  const monta = (paginas, disparos) => {
    const perguntadas = []
    const abertos = new Map(Object.entries(paginas).map(([nk, p]) => [nk, { connUltimo: p.conn || 'pronto', view: { webContents: { nk, isDestroyed: () => !!p.destruida } } }]))
    const F = new Function('disparos', 'abertos', 'perguntaPagina', 'cheioDe', [recorta(MN, 'async function cobradorOcupado()'), 'return cobradorOcupado'].join('\n'))(
      disparos || new Map(), abertos,
      async (wc, codigo) => { perguntadas.push(wc.nk + ' ' + codigo); const p = paginas[wc.nk]; if (p.estoura) throw new Error('pagina caiu'); return p.r === undefined ? null : p.r },
      (nk) => (nk === '1591980514' ? '(15) 99198-0514' : ''),
    )
    return { F, perguntadas }
  }
  let m = monta({ '1591980514': { r: { ocupado: false, motivo: '' } }, '1592860587': { r: { ocupado: false, motivo: '' } } })
  let resp = await m.F()
  vale('dois numeros abertos e quietos: livre', resp === '', resp)
  vale('pergunta aos dois, pelo __swOcupado da pagina', m.perguntadas.length === 2 && m.perguntadas.every((x) => /window\.__swOcupado \? window\.__swOcupado\(\) : null/.test(x)), m.perguntadas.join(' | '))
  m = monta({ '1591980514': { r: { ocupado: true, motivo: 'em ligação ou gravando áudio' } }, '1592860587': { r: { ocupado: false, motivo: '' } } })
  resp = await m.F()
  vale('ligacao num numero segura a automatica do OUTRO (quem esta ocupado e a pessoa)', resp === 'em ligação ou gravando áudio ((15) 99198-0514)', resp)
  m = monta({ '1591980514': { r: null }, '1592860587': { estoura: true } })
  resp = await m.F()
  vale('pagina que nao responde (agente antigo) ou que estoura nao vota e nao derruba', resp === '', resp)
  m = monta({ '1591980514': { conn: 'qr', r: { ocupado: true, motivo: 'x' } }, '1592860587': { destruida: true, r: { ocupado: true, motivo: 'x' } } })
  resp = await m.F()
  vale('numero pedindo QR ou ja fechado nem e perguntado', resp === '' && m.perguntadas.length === 0, m.perguntadas.join(' | '))
  m = monta({ '1591980514': { r: { ocupado: false } } }, new Map([['1591980514', { funil: 'x' }]]))
  resp = await m.F()
  vale('funil saindo pelo painel: ocupado, sem nem perguntar as paginas', /funil/.test(resp) && m.perguntadas.length === 0, resp)
}
{
  // rodaAuto: a pagina disse "ocupado" na hora de conferir a conversa
  const a = montaRoda({ chatDe: { ok: false, ocupado: true, erro: 'cobrador ocupado: mexendo no WhatsApp' } })
  const r = await a.F.rodaAuto(REC)
  vale('pagina ocupada na conferencia: fica pra depois, sem pegar no servidor e sem mandar', r === 'depois' && a.log.posts.length === 0 && a.log.mandou.length === 0, r + ' ' + a.log.posts.length)
  vale('e nao conta como conversa perdida (nao vira pulado na quinta volta)', a.F.autoDepois.size === 0, String(a.F.autoDepois.size))
  for (let i = 0; i < 6; i++) await a.F.rodaAuto(REC)
  vale('pode esperar quantas voltas for: continua sem pegar', a.log.posts.length === 0, String(a.log.posts.length))
}
vale('o agente e o main falam a mesma lingua (__swOcupado e o campo ocupado)', /window\.__swOcupado = function \(\) \{ var m = ocupadoAgora\(\); return \{ ocupado: !!m, motivo: m \} \}/.test(AG) && /if \(c && c\.ocupado\)/.test(MN))
vale('a hibernacao e o "recarregar todos" respeitam quem esta mandando automatica', /!disparos\.has\(s\.nk\) && !autoNoAr\.has\(s\.nk\)/.test(MN) && /if \(disparos\.has\(nk\) \|\| autoNoAr\.has\(nk\)\) \{ noFunil \+= 1; continue \}/.test(MN))
vale('o laco esta ligado no relogio do app (a cada 15 s)', /setInterval\(\(\) => \{ autoCobranca\(\)\.catch\(\(\) => \{\}\) \}, AUTO_TICK_MS\)/.test(MN) && /const AUTO_TICK_MS = 15000/.test(MN))
vale('o "de pe desde" e carimbado na virada pra pronto', /if \(st === 'pronto'\) s\.prontoEm = Date\.now\(\)/.test(MN))

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
if (falhas.length) { console.log('FALHARAM:\n - ' + falhas.join('\n - ')); process.exit(1) }
