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
// GRUPOS: a lista vai pro worker num ping "so_estado" (nao consome comando nem leva item) assim que
// muda, quando a tela pede (comando grupos) e de 5 em 5 minutos. A tela espera esse ping pra atualizar.
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
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const VERSAO = '1.4.0'
const CFG_ARQ = path.join(AQUI, 'bot-grupo.json')
const SESSAO = path.join(AQUI, 'sessao')
const LOCK = path.join(AQUI, 'agente.lock')
const ENVIADOS_ARQ = path.join(AQUI, 'enviados.json')
const UMA_VEZ = process.argv.includes('--uma-vez')
const CODIGO_NUM = (() => { const i = process.argv.indexOf('--codigo'); return i >= 0 ? String(process.argv[i + 1] || '').replace(/\D/g, '') : '' })()
const PING_S = 5
const GRUPOS_ESPERA_MS = 30 * 60 * 1000   // o WhatsApp devolveu rate-overlimit: 30 min sem pedir a lista

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
function guardarEnviado(id, msgId) {
  enviadosMapa[String(id)] = { msg_id: String(msgId || ''), ts: Date.now() }
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
const logger = pino({ level: 'silent' })

const api = async (rota, body) => {
  const r = await fetch(cfg.api + rota, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  })
  let j = {}
  try { j = await r.json() } catch { j = {} }
  if (r.status === 401) log('O worker recusou o token (401). Confira o token do bot-grupo.json com o da tela (Gerar outro troca o token).')
  return { status: r.status, j }
}
// Ack com insistencia: ate 3 vezes, 2s entre elas. Devolve true se o worker respondeu 200.
async function ack(body) {
  for (let i = 0; i < 3; i++) {
    try { const r = await api('/api/bot/agente/ack', body); if (r.status === 200) return true; if (r.status === 401) return false } catch {}
    await dorme(2000)
  }
  return false
}

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
    if (r.status === 200) { ultimaListaJson = JSON.stringify(lista); gruposPend = null; return true }
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
    const m = await sock.sendMessage(jid, { text: String(it.texto || '') })
    msgId = (m && m.key && m.key.id) || ''
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200)
    const passageiro = /timed out|timeout|connection|closed|not open|rate|socket/i.test(msg)
    log('falhou no grupo ' + jid + ': ' + msg + (passageiro ? ' (tento de novo)' : ''))
    await ack({ id: it.id, ok: false, erro: msg, repetir: passageiro })
    return
  }
  // Daqui pra frente a mensagem JA ESTA no grupo: nada aqui pode virar ok:false.
  guardarEnviado(it.id, msgId)
  enviados++
  log('enviado no grupo ' + jid + ' (' + (it.tipo || 'texto') + ')' + (msgId ? ', id ' + msgId : ''))
  const confirmou = await ack({ id: it.id, ok: true, msg_id: msgId })
  if (!confirmou) log('o worker nao confirmou o item ' + it.id + ' agora; confirmo no proximo ping (sem mandar de novo)')
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
  // --uma-vez: sessao aberta e 12 pings seguidos sem nada na fila (1 min) = acabou por hoje.
  if (UMA_VEZ && estado === 'open' && pingsSemItemAberto >= 12) {
    log('Fila vazia. ' + enviados + ' envio(s) nesta rodada. Saindo.')
    fechando = true
    try { sock.end(undefined) } catch {}
    limparLock()
    process.exit(0)
  }
  setTimeout(laco, PING_S * 1000)
}
setTimeout(laco, 3000)
