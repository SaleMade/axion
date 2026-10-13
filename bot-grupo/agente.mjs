// Bot do grupo da SellWave: o WhatsApp Web do numero do bot, rodando neste PC (Baileys 7, como um
// "aparelho conectado"). O worker axion-api guarda a fila e o estado; este processo so:
//   1. conecta (QR na dash, em Grupo do WhatsApp > Conectar por QR, ou aqui no terminal);
//   2. pinga o worker a cada 15s (estado, numero, grupos quando mudam);
//   3. pega os itens da fila, manda no grupo e confirma (ack). Erro passageiro volta pra fila.
// Config: bot-grupo.json ao lado deste arquivo: { "api": "https://axion-api.axion-dash.workers.dev", "token": "<token da tela>" }
// Flags: --uma-vez (conecta, esvazia a fila e sai) | --codigo 5515981430517 (parear por codigo de 8
// letras em vez do QR, quando o QR trava na etapa de "passkey" do WhatsApp).
// Higiene (pra nao banir): UM socket por vez, reconexao com recuo, nunca religa depois de 401 sem QR
// novo, markOnlineOnConnect false, identidade fixa, metadados do grupo em cache.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import QRCode from 'qrcode'
import qrterm from 'qrcode-terminal'
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const VERSAO = '1.1.0'
const CFG_ARQ = path.join(AQUI, 'bot-grupo.json')
const SESSAO = path.join(AQUI, 'sessao')
const LOCK = path.join(AQUI, 'agente.lock')
const UMA_VEZ = process.argv.includes('--uma-vez')
const CODIGO_NUM = (() => { const i = process.argv.indexOf('--codigo'); return i >= 0 ? String(process.argv[i + 1] || '').replace(/\D/g, '') : '' })()
const PING_S = 15
const PING_QR_S = 5

const hora = () => new Date().toLocaleTimeString('pt-BR', { hour12: false })
const log = (...a) => console.log(hora(), ...a)

function lerCfg() {
  if (!existsSync(CFG_ARQ)) {
    console.log('Falta o arquivo bot-grupo.json ao lado do agente.mjs, com este conteudo:')
    console.log('{ "api": "https://axion-api.axion-dash.workers.dev", "token": "<token da tela: Ferramentas > Bot de WhatsApp > Grupo do WhatsApp>" }')
    process.exit(1)
  }
  let c = {}
  try { c = JSON.parse(readFileSync(CFG_ARQ, 'utf8')) } catch (e) { console.log('bot-grupo.json invalido: ' + e.message); process.exit(1) }
  if (!c.token || String(c.token).length < 20) { console.log('bot-grupo.json sem token. Copie o token em Ferramentas > Bot de WhatsApp > Grupo do WhatsApp.'); process.exit(1) }
  return { api: String(c.api || 'https://axion-api.axion-dash.workers.dev').replace(/\/+$/, ''), token: String(c.token).trim() }
}
const cfg = lerCfg()

// So um bot por pasta: dois ao mesmo tempo derrubam a sessao um do outro (e isso costuma virar bloqueio).
let fechando = false
try {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8')) || 0
    let vivo = false
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); vivo = true } } catch { vivo = false }
    if (vivo) { log('Ja tem um bot rodando nesta pasta (processo ' + pid + '). Saindo.'); process.exit(0) }
  }
  writeFileSync(LOCK, String(process.pid))
} catch {}
const limparLock = () => { try { rmSync(LOCK, { force: true }) } catch {} }
process.on('exit', limparLock)
process.on('SIGINT', () => { fechando = true; limparLock(); process.exit(0) })
process.on('SIGTERM', () => { fechando = true; limparLock(); process.exit(0) })

let sock = null
let estado = 'close'          // 'qr' | 'open' | 'close'
let qrDataUrl = ''
let pairingCode = ''
let ultimoQrTexto = ''
let numero = ''
let nome = ''
let gruposPend = null         // lista pra mandar no proximo ping (so quando mudou)
let ocupado = false
let conectando = false
let tentativa = 0
let pingsSemItem = 0
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

async function lerGrupos() {
  const g = await sock.groupFetchAllParticipating()
  const lista = Object.values(g || {})
  for (const x of lista) if (x && x.id) cacheGrupo.set(x.id, x)
  return lista
    .map((x) => ({ id: String(x.id || ''), nome: String(x.subject || ''), tamanho: Number(x.size) || (Array.isArray(x.participants) ? x.participants.length : 0) }))
    .filter((x) => /@g\.us$/.test(x.id))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
}

async function conectar() {
  if (fechando || conectando) return
  conectando = true
  try {
    mkdirSync(SESSAO, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(SESSAO)
    let version
    try { version = (await fetchLatestBaileysVersion()).version } catch { version = undefined }
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
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('group-participants.update', (u) => { if (u && u.id) cacheGrupo.delete(u.id) })
    sock.ev.on('connection.update', async (u) => {
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
          log('QR novo. Escaneie na dash (Grupo do WhatsApp > Conectar por QR) ou aqui embaixo, com o celular do numero do bot:')
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
        numero = String((sock.user && sock.user.id) || '').split(':')[0].split('@')[0].replace(/\D/g, '')
        nome = String((sock.user && (sock.user.name || sock.user.verifiedName)) || '')
        log('WhatsApp Web conectado como ' + numero + (nome ? ' (' + nome + ')' : ''))
        try { gruposPend = await lerGrupos(); log(gruposPend.length + ' grupo(s) encontrado(s)') } catch (e) { log('nao consegui listar os grupos agora: ' + String((e && e.message) || e)) }
        ping().catch(() => {})
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
          setTimeout(() => conectar().catch((e) => log('erro ao reconectar: ' + String((e && e.message) || e))), 3000)
          return
        }
        const espera = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * Math.pow(2, tentativa++))
        log('Conexao caiu (' + (code || 'sem codigo') + '). Reconectando em ' + Math.round(espera / 1000) + 's.')
        setTimeout(() => conectar().catch((e) => log('erro ao reconectar: ' + String((e && e.message) || e))), espera)
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

async function ping() {
  if (ocupado) return
  ocupado = true
  try {
    const body = { estado, numero, nome, qr: estado === 'qr' ? qrDataUrl : '', pairingCode: estado === 'qr' ? pairingCode : '', versao: VERSAO, pc: hostname() }
    if (gruposPend) { body.grupos = gruposPend; gruposPend = null }
    const r = await api('/api/bot/agente/ping', body)
    if (r.status !== 200 || !r.j || !r.j.ok) {
      if (r.status !== 401) log('ping falhou: ' + r.status + ' ' + JSON.stringify(r.j || {}).slice(0, 120))
      return
    }
    if (r.j.cmd === 'logout') { await sair(); return }
    if (r.j.cmd === 'grupos' && estado === 'open') { try { gruposPend = await lerGrupos() } catch {} }
    const itens = Array.isArray(r.j.itens) ? r.j.itens : []
    if (!itens.length) pingsSemItem++; else pingsSemItem = 0
    for (const it of itens) {
      if (estado !== 'open') break
      try {
        const jid = String(it.jid)
        if (!cacheGrupo.has(jid)) { try { cacheGrupo.set(jid, await sock.groupMetadata(jid)) } catch {} }
        const m = await sock.sendMessage(jid, { text: String(it.texto || '') })
        const id = (m && m.key && m.key.id) || ''
        enviados++
        log('enviado no grupo ' + jid + ' (' + (it.tipo || 'texto') + ')' + (id ? ', id ' + id : ''))
        await api('/api/bot/agente/ack', { id: it.id, ok: true, msg_id: id })
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200)
        const passageiro = /timed out|timeout|connection|closed|not open|rate|socket/i.test(msg)
        log('falhou no grupo ' + it.jid + ': ' + msg + (passageiro ? ' (tento de novo)' : ''))
        await api('/api/bot/agente/ack', { id: it.id, ok: false, erro: msg, repetir: passageiro }).catch(() => {})
      }
      await new Promise((res) => setTimeout(res, 1500))
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
  // --uma-vez: conectado e 4 pings seguidos sem nada na fila (1 min) = acabou por hoje.
  if (UMA_VEZ && estado === 'open' && pingsSemItem >= 4) {
    log('Fila vazia. ' + enviados + ' envio(s) nesta rodada. Saindo.')
    fechando = true
    try { sock.end(undefined) } catch {}
    limparLock()
    process.exit(0)
  }
  setTimeout(laco, (estado === 'qr' ? PING_QR_S : PING_S) * 1000)
}
setTimeout(laco, 3000)
