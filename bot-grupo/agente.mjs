// Bot do grupo da SellWave: o WhatsApp Web do numero do bot, rodando neste PC (Baileys 7, como um
// "aparelho conectado"). O worker axion-api guarda a fila e o estado; este processo so:
//   1. conecta (QR na dash, no cartao do bot > Conectar por QR, ou aqui no terminal);
//   2. pinga o worker a cada 5s (estado, numero; a lista de grupos vai na hora em que muda ou e pedida);
//   3. pega os itens da fila, manda no grupo e confirma (ack). Erro passageiro volta pra fila.
// Config: bot-grupo.json ao lado deste arquivo: { "api": "https://axion-api.axion-dash.workers.dev", "token": "<token da tela>" }
// Flags: --uma-vez (conecta, esvazia a fila e sai) | --codigo 5515981430517 (parear por codigo de 8
// letras em vez do QR, quando o QR trava na etapa de "passkey" do WhatsApp).
// NUNCA EM DOBRO: o id de cada item enviado fica em enviados.json antes do ack; se o ack falhar, o
// item volta no proximo ping e so recebe o ack de novo, sem sendMessage.
// IMAGEM/VIDEO (1.5.0): item com `midia` { url, tipo, mime } baixa o arquivo do worker e manda com o
// texto de legenda. Arquivo que sumiu (404) vai so o texto; falha de rede volta pra fila.
// GRUPOS: a lista vai pro worker num ping "so_estado" (nao consome comando nem leva item) assim que
// muda, quando a tela pede (comando grupos) e de 5 em 5 minutos. A tela espera esse ping pra atualizar.
// LER O GRUPO (1.6.0): o worker diz no ping quais grupos escutar (`escuta`). Cada mensagem desses grupos
// vai pro worker (POST /api/bot/agente/msg), que decide se o bot responde e devolve o texto; aqui so se
// manda no grupo citando a pergunta, com "digitando" antes, e se confirma (msg-ack). Nada e decidido
// neste PC. Uma pergunta em voo por grupo; pergunta com mais de 2 min fica sem resposta (o bot estava fora).
// REAGIR (1.7.0): o worker pode devolver so `reacao` (um emoji) no lugar do texto: o bot poe a reacao na mensagem,
// sem "digitando" e sem citar, e confirma igual (msg-ack). O worker so manda reacao pro bot que se diz 1.7.0 ou mais.
// Higiene (pra nao banir): UM socket por vez, reconexao com recuo, 440 (outra copia) espera 2 min,
// nunca religa depois de 401 sem QR novo, markOnlineOnConnect false, identidade fixa, metadados em cache.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import QRCode from 'qrcode'
import qrterm from 'qrcode-terminal'
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, makeCacheableSignalKeyStore, isJidGroup } from '@whiskeysockets/baileys'
import { textoDa, quemMandou, meusJidsDe, mencionaBot, marcouBot, idsDoBot, respondeBot, idadeS, pacoteDe } from './entrada.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const VERSAO = '1.7.0'
const CFG_ARQ = path.join(AQUI, 'bot-grupo.json')
const SESSAO = path.join(AQUI, 'sessao')
const LOCK = path.join(AQUI, 'agente.lock')
const ENVIADOS_ARQ = path.join(AQUI, 'enviados.json')
const UMA_VEZ = process.argv.includes('--uma-vez')
const CODIGO_NUM = (() => { const i = process.argv.indexOf('--codigo'); return i >= 0 ? String(process.argv[i + 1] || '').replace(/\D/g, '') : '' })()
const PING_S = 5
const GRUPOS_ESPERA_MS = 30 * 60 * 1000   // o WhatsApp devolveu rate-overlimit: 30 min sem pedir a lista
const MSG_TIMEOUT_MS = 35000      // o worker leva ate 25 s pensando (IA): a pergunta tem teto proprio, maior que o do ping
const MSG_IDADE_MAX_S = 120       // pergunta mais velha que isso fica sem resposta (o bot estava fora, ja virou outro assunto)
const MSG_FILA_MAX = 10           // perguntas esperando por grupo; a 11a derruba a mais velha
const MEUS_IDS_MAX = 500          // ids das mensagens que este numero mandou (e como se sabe que responderam ao bot)
const NOME_BOT = 'barbadinho'     // alem do pushName do numero, "barbadinho" no texto conta como marcar o bot

const hora = () => new Date().toLocaleTimeString('pt-BR', { hour12: false })
const log = (...a) => console.log(hora(), ...a)
const dorme = (ms) => new Promise((res) => setTimeout(res, ms))

function lerCfg() {
  if (!existsSync(CFG_ARQ)) {
    console.log('Falta o arquivo bot-grupo.json ao lado do agente.mjs, com este conteudo:')
    console.log('{ "api": "https://axion-api.axion-dash.workers.dev", "token": "<token da tela: Ferramentas > Bot de WhatsApp>" }')
    process.exit(1)
  }
  let c = {}
  try { c = JSON.parse(readFileSync(CFG_ARQ, 'utf8')) } catch (e) { console.log('bot-grupo.json invalido: ' + e.message); process.exit(1) }
  if (!c.token || String(c.token).length < 20) { console.log('bot-grupo.json sem token. Copie o token em Ferramentas > Bot de WhatsApp.'); process.exit(1) }
  return { api: String(c.api || 'https://axion-api.axion-dash.workers.dev').replace(/\/+$/, ''), token: String(c.token).trim() }
}
const cfg = lerCfg()

// So um bot por pasta: dois ao mesmo tempo derrubam a sessao um do outro (e isso costuma virar bloqueio).
// No Windows o PID pode ser reaproveitado por outro programa: confere se o PID vivo e mesmo um node.
function pidEhNode(pid) {
  try {
    if (process.platform !== 'win32') { process.kill(pid, 0); return true }
    const saida = execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true })
    return /node\.exe/i.test(saida)
  } catch { return false }
}
let fechando = false
try {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8')) || 0
    if (pid && pid !== process.pid && pidEhNode(pid)) { log('Ja tem um bot rodando nesta pasta (processo ' + pid + '). Saindo.'); process.exit(0) }
  }
  writeFileSync(LOCK, String(process.pid))
} catch {}
const limparLock = () => { try { rmSync(LOCK, { force: true }) } catch {} }
process.on('exit', limparLock)
process.on('SIGINT', () => { fechando = true; limparLock(); process.exit(0) })
process.on('SIGTERM', () => { fechando = true; limparLock(); process.exit(0) })

// Ids ja enviados (id da fila -> id da mensagem no WhatsApp). Gravado ANTES do ack: ack perdido nunca vira envio em dobro.
let enviadosMapa = {}
try { enviadosMapa = JSON.parse(readFileSync(ENVIADOS_ARQ, 'utf8')) || {} } catch { enviadosMapa = {} }
// Ids das mensagens que ESTE numero mandou (fila, respostas e tudo que o WhatsApp devolve como fromMe): e assim
// que se sabe que alguem respondeu ao bot. Teto de 500; o Set guarda a ordem, entao o mais velho sai primeiro.
const meusMsgIds = new Set()
function lembrarMeuId(id) {
  const s = String(id || '')
  if (!s || meusMsgIds.has(s)) return
  meusMsgIds.add(s)
  while (meusMsgIds.size > MEUS_IDS_MAX) meusMsgIds.delete(meusMsgIds.values().next().value)
}
for (const k of Object.keys(enviadosMapa).sort((a, b) => ((enviadosMapa[a] || {}).ts || 0) - ((enviadosMapa[b] || {}).ts || 0))) lembrarMeuId((enviadosMapa[k] || {}).msg_id)
function guardarEnviado(id, msgId) {
  enviadosMapa[String(id)] = { msg_id: String(msgId || ''), ts: Date.now() }
  lembrarMeuId(msgId)
  const chaves = Object.keys(enviadosMapa)
  if (chaves.length > 300) for (const k of chaves.sort((a, b) => enviadosMapa[a].ts - enviadosMapa[b].ts).slice(0, chaves.length - 300)) delete enviadosMapa[k]
  try { writeFileSync(ENVIADOS_ARQ, JSON.stringify(enviadosMapa)) } catch {}
}

let sock = null
let estado = 'close'          // 'qr' | 'open' | 'close'
let qrDataUrl = ''
let pairingCode = ''
let ultimoQrTexto = ''
let numero = ''
let nome = ''
let gruposPend = null         // lista que nao conseguiu ir na hora; vai no proximo ping
let ultimaListaJson = ''      // a ultima lista que o worker recebeu
let timerGrupos = null
let ocupado = false
let conectando = false
let tentativa = 0
let pingsSemItemAberto = 0    // so conta com a sessao aberta (pra --uma-vez)
let enviados = 0
const cacheGrupo = new Map()
let escuta = null             // grupos que o worker mandou escutar (vem no ping); null = ainda nao veio, nada e repassado
const filas = new Map()       // jid do grupo -> { ativa, itens }: uma pergunta em voo por grupo
const logger = pino({ level: 'silent' })

async function chamar(rota, body, timeoutMs) {
  const r = await fetch(cfg.api + rota, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let j = {}
  try { j = await r.json() } catch { j = {} }
  if (r.status === 401) log('O worker recusou o token (401). Confira o token do bot-grupo.json com o da tela (Gerar outro troca o token).')
  return { status: r.status, j }
}
const api = (rota, body) => chamar(rota, body, 20000)
// A pergunta do grupo tem chamada propria: o worker leva ate 25 s pensando (IA), mais que o teto do ping.
const apiMsg = (pacote) => chamar('/api/bot/agente/msg', pacote, MSG_TIMEOUT_MS)
// Ack com insistencia: ate 3 vezes, 2s entre elas. Devolve true se o worker respondeu 200.
async function ack(body, rota = '/api/bot/agente/ack') {
  for (let i = 0; i < 3; i++) {
    try { const r = await api(rota, body); if (r.status === 200) return true; if (r.status === 401) return false } catch {}
    await dorme(2000)
  }
  return false
}
// Confirma pro worker o que aconteceu com a resposta de uma pergunta (chat_id que a rota /msg devolveu).
const msgAck = (body) => ack(body, '/api/bot/agente/msg-ack')

async function lerGrupos() {
  const g = await sock.groupFetchAllParticipating()
  const lista = Object.values(g || {})
  for (const x of lista) if (x && x.id) cacheGrupo.set(x.id, x)
  return lista
    .map((x) => ({ id: String(x.id || ''), nome: String(x.subject || ''), tamanho: Number(x.size) || (Array.isArray(x.participants) ? x.participants.length : 0) }))
    .filter((x) => /@g\.us$/.test(x.id))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
}
// Manda a lista AGORA, num ping que so leva estado (nao consome comando nem pega item da fila).
async function mandarGrupos(lista) {
  try {
    const r = await api('/api/bot/agente/ping', { estado, numero, nome, qr: '', pairingCode: '', versao: VERSAO, pc: hostname(), grupos: lista, so_estado: true })
    if (r.status === 200) { guardarEscuta(r.j); ultimaListaJson = JSON.stringify(lista); gruposPend = null; return true }
  } catch {}
  gruposPend = lista
  return false
}
// Rele os grupos e manda se mudou. `forcar` = a tela pediu: manda mesmo igual, pra tela parar de esperar.
// LISTA DE GRUPOS SEM ABUSAR DO WHATSAPP (14/10/2026): a releitura de 5 em 5 minutos tomava
// 'rate-overlimit' o dia inteiro (361 vezes em 13/10), e insistir num limite do WhatsApp e o tipo de
// coisa que leva a bloqueio. Agora so le ao conectar, quando um grupo muda e quando a tela pede; se o
// WhatsApp mandar esperar, fica 30 min sem pedir (a tela recebe a lista que ja temos). Devolve quantos
// grupos leu (-1 = nao leu).
let gruposLivreEm = 0
async function atualizarGrupos(forcar) {
  if (estado !== 'open' || fechando) return -1
  if (Date.now() < gruposLivreEm) {
    if (forcar && ultimaListaJson) { try { await mandarGrupos(JSON.parse(ultimaListaJson)) } catch {} }
    return -1
  }
  try {
    const lista = await lerGrupos()
    if (forcar || JSON.stringify(lista) !== ultimaListaJson) { await mandarGrupos(lista); log(lista.length + ' grupo(s) na lista') }
    return lista.length
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/rate-?overlimit|rate limit|too many/i.test(msg)) {
      gruposLivreEm = Date.now() + GRUPOS_ESPERA_MS
      log('o WhatsApp pediu pra esperar antes de listar os grupos de novo; proxima tentativa em 30 min')
      if (forcar && ultimaListaJson) { try { await mandarGrupos(JSON.parse(ultimaListaJson)) } catch {} }
    } else log('nao consegui listar os grupos agora: ' + msg)
    return -1
  }
}
// Mudanca de grupo chega em rajada (entrou alguem, mudou o nome): uma leitura so, 60s depois da ultima.
const agendaGrupos = () => { clearTimeout(timerGrupos); timerGrupos = setTimeout(() => atualizarGrupos(false).catch(() => {}), 60000) }

function agendaReconexao(ms) {
  if (fechando) return
  setTimeout(() => {
    conectar().catch((e) => { log('erro ao reconectar: ' + String((e && e.message) || e) + '. Tento de novo em 15s.'); conectando = false; agendaReconexao(15000) })
  }, ms)
}

async function conectar() {
  if (fechando || conectando) return
  conectando = true
  try {
    mkdirSync(SESSAO, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(SESSAO)
    let version
    try { version = (await Promise.race([fetchLatestBaileysVersion(), dorme(8000).then(() => ({}))])).version } catch { version = undefined }
    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => cacheGrupo.get(jid),
    })
    const meuSock = sock
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('group-participants.update', (u) => { if (u && u.id) cacheGrupo.delete(u.id); agendaGrupos() })
    sock.ev.on('groups.upsert', agendaGrupos)   // entrou num grupo novo
    sock.ev.on('groups.update', agendaGrupos)   // nome do grupo mudou
    // Ler o grupo (1.6.0). 'notify' = chegou agora; 'append' = chegou enquanto o bot estava fora, ou e a nossa
    // propria mensagem. Quem decide se e velha demais e a idade, nao o tipo. Registrado por socket, como os outros.
    sock.ev.on('messages.upsert', (u) => {
      if (meuSock !== sock) return   // evento de um socket velho
      if (!u || (u.type !== 'notify' && u.type !== 'append')) return
      for (const m of (Array.isArray(u.messages) ? u.messages : [])) {
        try { receberMensagem(m) } catch (e) { log('mensagem recebida: ' + String((e && e.message) || e).slice(0, 160)) }
      }
    })
    sock.ev.on('connection.update', async (u) => {
      if (meuSock !== sock) return   // evento de um socket velho
      if (u.qr && u.qr !== ultimoQrTexto) {
        ultimoQrTexto = u.qr
        estado = 'qr'
        if (CODIGO_NUM && !pairingCode && !(sock.authState && sock.authState.creds && sock.authState.creds.registered)) {
          try {
            pairingCode = String(await sock.requestPairingCode(CODIGO_NUM))
            log('Codigo de pareamento pro numero ' + CODIGO_NUM + ': ' + pairingCode + ' (no celular: Aparelhos conectados > Conectar aparelho > Conectar com numero de telefone)')
          } catch (e) { log('nao consegui pedir o codigo de pareamento: ' + String((e && e.message) || e)) }
        }
        try { qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, scale: 6 }) } catch { qrDataUrl = '' }
        if (!pairingCode) {
          log('QR novo. Escaneie na dash (cartao do bot > Conectar por QR) ou aqui embaixo, com o celular do numero do bot:')
          try { qrterm.generate(u.qr, { small: true }) } catch {}
        }
        ping().catch(() => {})
      }
      if (u.isNewLogin) log('Pareado. O WhatsApp vai reiniciar a conexao uma vez (normal).')
      if (u.connection === 'open') {
        estado = 'open'
        qrDataUrl = ''
        pairingCode = ''
        ultimoQrTexto = ''
        tentativa = 0
        pingsSemItemAberto = 0
        ultimaListaJson = ''
        numero = String((sock.user && sock.user.id) || '').split(':')[0].split('@')[0].replace(/\D/g, '')
        nome = String((sock.user && (sock.user.name || sock.user.verifiedName)) || '')
        log('WhatsApp Web conectado como ' + numero + (nome ? ' (' + nome + ')' : ''))
        ping().catch(() => {})
        // Logo depois de abrir o WhatsApp ainda esta sincronizando: le agora e, SO se vier vazia, de novo em 10s e em 30s.
        ;(async () => {
          for (const espera of [0, 10000, 30000]) {
            if (espera) await dorme(espera)
            if (meuSock !== sock || estado !== 'open') return
            const n = await atualizarGrupos(false)
            if (n > 0 || Date.now() < gruposLivreEm) return
          }
        })().catch(() => {})
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode
        estado = 'close'
        qrDataUrl = ''
        conectando = false
        if (fechando) return
        if (code === DisconnectReason.loggedOut) {
          log('Sessao encerrada no celular (ou pela dash). Apagando a sessao local; vai pedir QR de novo.')
          try { rmSync(SESSAO, { recursive: true, force: true }) } catch {}
          pairingCode = ''
          agendaReconexao(3000)
          return
        }
        if (code === DisconnectReason.connectionReplaced) {
          log('Outra copia do bot conectou com esta mesma sessao (440). Esta copia espera 2 min antes de tentar de novo.')
          agendaReconexao(120000)
          return
        }
        const espera = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * Math.pow(2, tentativa++))
        log('Conexao caiu (' + (code || 'sem codigo') + '). Reconectando em ' + Math.round(espera / 1000) + 's.')
        agendaReconexao(espera)
      }
    })
  } catch (e) {
    conectando = false
    throw e
  }
}

async function sair() {
  log('Pedido da dash: desconectar. Saindo do WhatsApp Web e apagando a sessao.')
  try { await sock.logout() } catch {}
  try { rmSync(SESSAO, { recursive: true, force: true }) } catch {}
}

// Baixa a imagem/video do item (ate 20 MB, 60s). { buf } ou { sumiu } (404/410) ou { erro } (passageiro).
async function baixarMidia(m) {
  try {
    const r = await fetch(String(m.url), { signal: AbortSignal.timeout(60000) })
    if (r.status === 404 || r.status === 410) return { sumiu: true }
    if (!r.ok) return { erro: 'baixar a midia deu ' + r.status }
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return { sumiu: true }
    if (buf.length > 20 * 1048576) return { erro: 'midia acima de 20 MB', grande: true }
    return { buf }
  } catch (e) { return { erro: 'baixar a midia: ' + String((e && e.message) || e).slice(0, 120) } }
}

async function enviarItem(it) {
  const jid = String(it.jid)
  const ja = enviadosMapa[String(it.id)]
  if (ja) {
    // Ja saiu no grupo numa rodada anterior e o ack nao chegou: so confirma, sem mandar de novo.
    log('item ' + it.id + ' ja tinha sido enviado; confirmando de novo')
    await ack({ id: it.id, ok: true, msg_id: ja.msg_id })
    return
  }
  let msgId = ''
  try {
    if (!cacheGrupo.has(jid)) { try { cacheGrupo.set(jid, await sock.groupMetadata(jid)) } catch {} }
    const texto = String(it.texto || '')
    let conteudo = { text: texto }
    if (it.midia && it.midia.url) {
      const d = await baixarMidia(it.midia)
      if (d.buf) conteudo = it.midia.tipo === 'video' ? { video: d.buf, caption: texto, mimetype: it.midia.mime || 'video/mp4' } : { image: d.buf, caption: texto, mimetype: it.midia.mime || 'image/jpeg' }
      else if (d.sumiu && texto.trim()) log('item ' + it.id + ': a midia nao existe mais; vai so o texto')
      else {
        log('item ' + it.id + ': ' + (d.erro || 'a midia nao existe mais') + (d.sumiu || d.grande ? '' : ' (tento de novo)'))
        await ack({ id: it.id, ok: false, erro: d.erro || 'a imagem anexada nao existe mais', repetir: !(d.sumiu || d.grande) })
        return
      }
    }
    const m = await sock.sendMessage(jid, conteudo)
    msgId = (m && m.key && m.key.id) || ''
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200)
    const passageiro = /timed out|timeout|connection|closed|not open|rate|socket|upload/i.test(msg)
    log('falhou no grupo ' + jid + ': ' + msg + (passageiro ? ' (tento de novo)' : ''))
    await ack({ id: it.id, ok: false, erro: msg, repetir: passageiro })
    return
  }
  // Daqui pra frente a mensagem JA ESTA no grupo: nada aqui pode virar ok:false.
  guardarEnviado(it.id, msgId)
  enviados++
  log('enviado no grupo ' + jid + ' (' + (it.tipo || 'texto') + (it.midia ? ', com ' + (it.midia.tipo === 'video' ? 'video' : 'imagem') : '') + ')' + (msgId ? ', id ' + msgId : ''))
  const confirmou = await ack({ id: it.id, ok: true, msg_id: msgId })
  if (!confirmou) log('o worker nao confirmou o item ' + it.id + ' agora; confirmo no proximo ping (sem mandar de novo)')
}

// ─── Ler o grupo (1.6.0) ──────────────────────────────────────────────────────────────────
// O worker manda no ping quais grupos escutar. Daqui pra baixo: filtrar, enfileirar por grupo, perguntar
// ao worker e mandar a resposta citando a pergunta. Nunca fora de grupo, nunca a si mesmo.
function guardarEscuta(j) {
  if (!j || !Array.isArray(j.escuta)) return   // so quando o campo vier; lista vazia = nao escuta nada
  const nova = j.escuta.map((x) => String(x || '')).filter(Boolean)
  if (!escuta || nova.join(' ') !== escuta.join(' ')) log(nova.length ? 'escutando ' + nova.length + ' grupo(s): ' + nova.join(', ') : 'nenhum grupo pra escutar')
  escuta = nova
}

// Toda mensagem que o WhatsApp entrega. Filtros baratos aqui; o resto na fila do grupo.
function receberMensagem(msg) {
  const key = msg && msg.key
  if (!key) return
  // A nossa propria mensagem (fila, resposta, ou mandada pelo celular do bot): so guarda o id. ANTES de
  // qualquer filtro: e com esses ids que se sabe que alguem respondeu ao bot.
  if (key.fromMe) { if (key.id) lembrarMeuId(key.id); return }
  const jid = String(key.remoteJid || '')
  if (!isJidGroup(jid)) return                              // nunca em conversa privada
  if (!escuta || !escuta.includes(jid)) return              // so os grupos que o worker mandou escutar
  if (msg.messageStubType) return                           // entrou/saiu/mudou o nome: nao e mensagem
  const { tipo } = textoDa(msg)
  if (tipo === 'sticker' || tipo === 'outro') return        // figurinha, reacao, enquete...: nao e pergunta
  if (idadeS(msg, Date.now()) > MSG_IDADE_MAX_S) return     // o bot estava fora: pergunta velha fica sem resposta
  enfileirar(jid, msg)
}

// UMA pergunta em voo por grupo; as outras esperam na ordem (ate 10; a 11a derruba a mais velha).
// Independente do ping (`ocupado`): a fila de envio continua andando enquanto o worker pensa.
function enfileirar(jid, msg) {
  let f = filas.get(jid)
  if (!f) { f = { ativa: false, itens: [] }; filas.set(jid, f) }
  if (f.itens.length >= MSG_FILA_MAX) {
    const velha = f.itens.shift()
    log('fila do grupo ' + jid + ' cheia (' + MSG_FILA_MAX + ' esperando); descartei a mais velha, de ' + String((velha && velha.pushName) || 'alguem'))
  }
  f.itens.push(msg)
  if (!f.ativa) rodarFila(f).catch(() => {})
}
async function rodarFila(f) {
  f.ativa = true
  try {
    while (f.itens.length && !fechando) {
      const msg = f.itens.shift()
      try { await tratarMensagem(msg, await montarPacote(msg)) } catch (e) { log('pergunta do grupo: ' + String((e && e.message) || e).slice(0, 160)) }
    }
  } finally { f.ativa = false }
}
const filaOcupada = () => [...filas.values()].some((f) => f.ativa || f.itens.length)

// O pacote que vai pro worker (forma no entrada.mjs). O numero e o calculado ao conectar.
async function montarPacote(msg) {
  const s = sock
  // Quem mandou pode vir so como LID (identidade nova do WhatsApp); o mapa LID -> telefone mora no Baileys.
  const lidParaPn = async (j) => { try { return await s.signalRepository?.lidMapping?.getPNForLID?.(j) } catch { return null } }
  const quem = await quemMandou(msg, lidParaPn)
  const meusJids = meusJidsDe(s && s.user)
  const responde = respondeBot(msg, meusJids, meusMsgIds)
  // 1.6.1: `marcado` (marcou de verdade, nao so falou o nome) e `bot_ids` (numero e LID do bot) pro worker.
  return pacoteDe(msg, { numero, ...quem, menciona: mencionaBot(msg, meusJids, [nome, NOME_BOT]), marcado: marcouBot(msg, meusJids, [nome, NOME_BOT]), bot_ids: idsDoBot(meusJids), responde, citado_de_bot: responde })
}

// Espera a conexao voltar (ate `ms`, olhando a cada 2 s). true = aberta.
async function esperarAberto(ms) {
  const fim = Date.now() + ms
  while (Date.now() < fim && !fechando) {
    if (estado === 'open') return true
    await dorme(2000)
  }
  return estado === 'open'
}

// "Digitando" por 2 a 7 s (gente nao responde em zero segundos), a resposta citando a pergunta, e para de digitar.
async function mandarResposta(jid, msg, texto) {
  const s = sock
  if (!cacheGrupo.has(jid)) { try { cacheGrupo.set(jid, await s.groupMetadata(jid)) } catch {} }
  try { await s.sendPresenceUpdate('composing', jid) } catch {}
  await dorme(Math.min(2000 + 35 * texto.length, 7000))
  const m = await s.sendMessage(jid, { text: texto }, { quoted: msg })
  try { await s.sendPresenceUpdate('paused', jid) } catch {}
  return (m && m.key && m.key.id) || ''
}

// A reacao (1.7.0): o emoji na propria mensagem, depois de 1 a 3 s (gente nao reage em zero segundos). A chave e a da
// mensagem (com o participant, que e quem escreveu no grupo).
async function mandarReacao(jid, msg, emoji) {
  const s = sock
  await dorme(1000 + Math.floor(Math.random() * 2000))
  const k = msg.key || {}
  const m = await s.sendMessage(jid, { react: { text: emoji, key: { remoteJid: k.remoteJid, fromMe: !!k.fromMe, id: k.id, participant: k.participant } } })
  return (m && m.key && m.key.id) || ''
}

// Pergunta ao worker e manda a resposta. Resposta vazia (e sem reacao) ou `ignorar` = o bot fica calado.
async function tratarMensagem(msg, pacote) {
  const jid = pacote.jid
  const curto = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const cabeca = 'pergunta no grupo ' + jid + ' de ' + (pacote.de_nome || pacote.de_fone || pacote.de_jid) + ': "' + curto(pacote.texto) + '"'
  if (idadeS(msg, Date.now()) > MSG_IDADE_MAX_S) { log(cabeca + ' -> ignorada (esperou mais de ' + MSG_IDADE_MAX_S + ' s na fila)'); return }
  let r
  try { r = await apiMsg(pacote) }
  catch (e) {
    const m = String((e && (e.name + ': ' + e.message)) || e)
    log(cabeca + ' -> ignorada (' + (/timeout|abort/i.test(m) ? 'o worker nao respondeu em ' + MSG_TIMEOUT_MS / 1000 + ' s' : 'worker: ' + m.slice(0, 120)) + ')')
    return   // sem resposta nao ha chat_id, entao nao ha o que confirmar
  }
  const j = r.j || {}
  const chatId = j.chat_id
  if (r.status !== 200 || !j.ok) {
    log(cabeca + ' -> ignorada (worker ' + r.status + (j.error ? ': ' + String(j.error).slice(0, 100) : '') + ')')
    if (chatId) await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: 'worker ' + r.status })
    return
  }
  if (j.ignorar) { log(cabeca + ' -> ignorada (' + (j.motivo ? 'worker: ' + String(j.motivo).slice(0, 60) : 'o worker nao quis') + ')'); return }
  const texto = String(j.resposta || '').trim()
  const reacao = String(j.reacao || '').trim()
  if (!texto && !reacao) { log(cabeca + ' -> calado'); return }
  // O worker pode ter demorado: pergunta de mais de 2 min nao se responde mais (ja virou outro assunto).
  if (idadeS(msg, Date.now()) > MSG_IDADE_MAX_S) {
    log(cabeca + ' -> ignorada (passou do tempo)')
    await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: 'passou do tempo' })
    return
  }
  if (!texto) {
    try {
      const idR = await mandarReacao(jid, msg, reacao)
      log(cabeca + ' -> reagi ' + reacao)
      await msgAck({ chat_id: chatId, ok: true, msg_id: idR, erro: '' })
    } catch (e) {
      const m = String((e && e.message) || e).slice(0, 200)
      log(cabeca + ' -> ignorada (a reacao falhou: ' + m + ')')
      await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: m })
    }
    return
  }
  let msgId = ''
  try { msgId = await mandarResposta(jid, msg, texto) }
  catch (e) {
    const m = String((e && e.message) || e).slice(0, 200)
    const passageiro = /timed out|timeout|connection|closed|not open|rate|socket|upload/i.test(m)
    if (!passageiro) {
      log(cabeca + ' -> ignorada (falhou ao mandar: ' + m + ')')
      await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: m })
      return
    }
    // A conexao caiu no meio: espera religar e tenta UMA vez, se a pergunta ainda for recente.
    log('falhou ao responder no grupo ' + jid + ': ' + m + ' (espero reconectar e tento uma vez)')
    const religou = await esperarAberto(60000)
    if (!religou || idadeS(msg, Date.now()) > MSG_IDADE_MAX_S) {
      log(cabeca + ' -> ignorada (' + (religou ? 'passou do tempo' : 'nao reconectou em 60 s') + ')')
      await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: religou ? 'passou do tempo' : m })
      return
    }
    try { msgId = await mandarResposta(jid, msg, texto) }
    catch (e2) {
      const m2 = String((e2 && e2.message) || e2).slice(0, 200)
      log(cabeca + ' -> ignorada (falhou de novo: ' + m2 + ')')
      await msgAck({ chat_id: chatId, ok: false, msg_id: '', erro: m2 })
      return
    }
  }
  // Daqui pra frente a resposta JA ESTA no grupo: nada aqui pode virar ok:false.
  if (msgId) lembrarMeuId(msgId)
  log(cabeca + ' -> respondi: "' + curto(texto) + '"')
  const confirmou = await msgAck({ chat_id: chatId, ok: true, msg_id: msgId, erro: '' })
  if (!confirmou) log('o worker nao confirmou a resposta ' + String(chatId || '') + ' (ja esta no grupo; nada a refazer)')
}

async function ping() {
  if (ocupado) return
  ocupado = true
  try {
    const body = { estado, numero, nome, qr: estado === 'qr' ? qrDataUrl : '', pairingCode: estado === 'qr' ? pairingCode : '', versao: VERSAO, pc: hostname() }
    const levando = gruposPend
    if (levando) body.grupos = levando
    const r = await api('/api/bot/agente/ping', body)
    if (r.status !== 200 || !r.j || !r.j.ok) {
      if (r.status !== 401) log('ping falhou: ' + r.status + ' ' + JSON.stringify(r.j || {}).slice(0, 120))
      return
    }
    if (levando) { ultimaListaJson = JSON.stringify(levando); if (gruposPend === levando) gruposPend = null }
    guardarEscuta(r.j)
    if (r.j.cmd === 'logout') { await sair(); return }
    if (r.j.cmd === 'grupos') await atualizarGrupos(true)   // a tela esta esperando: le e manda na hora
    const itens = Array.isArray(r.j.itens) ? r.j.itens : []
    if (estado === 'open') { if (!itens.length) pingsSemItemAberto++; else pingsSemItemAberto = 0 }
    for (const it of itens) {
      if (estado !== 'open') break
      await enviarItem(it)
      await dorme(1500)
    }
  } catch (e) {
    log('ping: ' + String((e && e.message) || e))
  } finally {
    ocupado = false
  }
}

log('SellWave Bot do grupo v' + VERSAO + ' em ' + hostname() + ' -> ' + cfg.api + (UMA_VEZ ? ' (uma vez)' : '') + (CODIGO_NUM ? ' (pareamento por codigo)' : ''))
await conectar()
const laco = async () => {
  if (fechando) return
  await ping()
  // --uma-vez: sessao aberta, 12 pings seguidos sem nada na fila (1 min) e nenhuma pergunta em voo = acabou por hoje.
  if (UMA_VEZ && estado === 'open' && pingsSemItemAberto >= 12 && !filaOcupada()) {
    log('Fila vazia. ' + enviados + ' envio(s) nesta rodada. Saindo.')
    fechando = true
    try { sock.end(undefined) } catch {}
    limparLock()
    process.exit(0)
  }
  setTimeout(laco, PING_S * 1000)
}
setTimeout(laco, 3000)
