// Entrada do bot (1.6.0): o que chega do grupo, em funcoes puras. Nada aqui abre conexao nem fala com
// o worker; so importa helpers do Baileys. E assim que da pra testar sem ligar o WhatsApp
// (teste-entrada.mjs). O agente.mjs usa isto pra montar o pacote que vai pro worker
// (POST /api/bot/agente/msg) e pra saber se a pessoa marcou o bot ou respondeu a ele.
//
// Mensagem do Baileys: { key: { remoteJid, fromMe, id, participant, participantAlt }, message, pushName,
// messageTimestamp }. O `message` pode vir embrulhado (temporaria, ver uma vez, editada, documento com
// legenda): normalizeMessageContent tira o embrulho antes de qualquer leitura.
// Identidade: desde 2025 o WhatsApp manda muita gente so como LID (xxx@lid), sem telefone. O telefone
// sai de jidDecode(...).user, NUNCA filtrando digitos do jid inteiro: o mapa LID -> telefone devolve
// `<fone>:<aparelho>@s.whatsapp.net` e os digitos do aparelho colariam no fone.
import { normalizeMessageContent, jidDecode, jidNormalizedUser, toNumber, isJidGroup } from '@whiskeysockets/baileys'

const TEXTO_MAX = 1000
const CITADO_MAX = 300

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const escapaRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const soDigitos = (s) => (/^\d+$/.test(String(s || '')) ? String(s) : '')

// Texto e tipo de um conteudo JA desembrulhado. Midia com legenda = tipo da midia + a legenda.
function textoDe(c) {
  if (!c || typeof c !== 'object') return { tipo: 'outro', texto: '' }
  if (typeof c.conversation === 'string' && c.conversation !== '') return { tipo: 'texto', texto: c.conversation }
  if (c.extendedTextMessage) return { tipo: 'texto', texto: String(c.extendedTextMessage.text || '') }
  if (c.imageMessage) return { tipo: 'imagem', texto: String(c.imageMessage.caption || '') }
  if (c.videoMessage) return { tipo: 'video', texto: String(c.videoMessage.caption || '') }
  if (c.documentMessage) return { tipo: 'documento', texto: String(c.documentMessage.caption || '') }
  if (c.audioMessage) return { tipo: 'audio', texto: '' }
  if (c.stickerMessage) return { tipo: 'sticker', texto: '' }
  // reacao, protocolo (apagou/editou), enquete, contato, localizacao...: nao e pergunta
  return { tipo: 'outro', texto: '' }
}

// O conteudo da mensagem sem o embrulho (temporaria, ver uma vez, editada, documento com legenda) ou null.
export function conteudoDe(msg) {
  try { return normalizeMessageContent(msg && msg.message) || null } catch { return null }
}

// { tipo, texto }. Stub (entrou/saiu/mudou o nome) e mensagem sem conteudo viram 'outro'.
// Edicao de mensagem chega como protocolMessage dentro de editedMessage: fica 'outro' de proposito
// (responder de novo a mesma pergunta corrigida seria resposta em dobro).
export function textoDa(msg) {
  if (!msg || msg.messageStubType) return { tipo: 'outro', texto: '' }
  return textoDe(conteudoDe(msg))
}

// O contextInfo do conteudo desembrulhado (quem foi marcado, mensagem citada), seja qual for o tipo, ou null.
export function contextoDe(msg) {
  const c = conteudoDe(msg)
  if (!c) return null
  for (const k of Object.keys(c)) {
    const v = c[k]
    if (v && typeof v === 'object' && v.contextInfo && typeof v.contextInfo === 'object') return v.contextInfo
  }
  return null
}

// { de_jid, de_fone, de_nome }. de_jid e a chave (pode ser @lid); de_fone so quando da pra saber:
// participant em @s.whatsapp.net, senao participantAlt em @s.whatsapp.net, senao o mapa LID -> telefone
// do Baileys (`lidParaPn`, async, pode devolver null). Nunca lanca: sem fone vira ''.
export async function quemMandou(msg, lidParaPn) {
  const key = (msg && msg.key) || {}
  const remoto = String(key.remoteJid || '')
  const bruto = String((isJidGroup(remoto) && key.participant) || key.participant || remoto)
  const de_jid = jidNormalizedUser(bruto)
  const de_nome = String((msg && msg.pushName) || '')
  let de_fone = ''
  try {
    const d = jidDecode(bruto)
    if (d && d.server === 's.whatsapp.net') de_fone = soDigitos(d.user)
    else {
      const alt = jidDecode(String(key.participantAlt || ''))
      if (alt && alt.server === 's.whatsapp.net') de_fone = soDigitos(alt.user)
      else if (bruto && typeof lidParaPn === 'function') {
        const pn = jidDecode(String((await lidParaPn(bruto)) || ''))
        if (pn && pn.server === 's.whatsapp.net') de_fone = soDigitos(pn.user)
      }
    }
  } catch { de_fone = '' }
  return { de_jid, de_fone, de_nome }
}

// Os jids do proprio bot, sem o numero do aparelho (sock.user tem id e lid no Baileys 7).
export function meusJidsDe(user) {
  const s = new Set()
  for (const j of [user && user.id, user && user.lid]) {
    const n = j ? jidNormalizedUser(String(j)) : ''
    if (n) s.add(n)
  }
  return s
}

// Marcou o bot: um jid do bot na lista de marcados, ou "@nome"/"nome" no texto (sem acento, sem caixa).
// `nomeBot` pode ser um nome ou uma lista (o pushName do bot e a constante 'barbadinho').
export function mencionaBot(msg, meusJids, nomeBot) {
  const ctx = contextoDe(msg)
  const marcados = ctx && Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : []
  for (const j of marcados) {
    const n = jidNormalizedUser(String(j || ''))
    if (n && meusJids && meusJids.has(n)) return true
  }
  const texto = semAcento(textoDa(msg).texto)
  if (!texto) return false
  const nomes = (Array.isArray(nomeBot) ? nomeBot : [nomeBot]).map((n) => semAcento(n).trim()).filter(Boolean)
  return nomes.some((n) => new RegExp('(^|[^a-z0-9])' + escapaRegex(n) + '(?![a-z0-9])').test(texto))
}

// Respondeu (citou) uma mensagem do bot: o autor da citada e o bot, ou o id dela esta entre os que o bot mandou.
export function respondeBot(msg, meusJids, meusMsgIds) {
  const ctx = contextoDe(msg)
  if (!ctx) return false
  const p = ctx.participant ? jidNormalizedUser(String(ctx.participant)) : ''
  if (p && meusJids && meusJids.has(p)) return true
  const id = ctx.stanzaId ? String(ctx.stanzaId) : ''
  return !!(id && meusMsgIds && meusMsgIds.has(id))
}

// Texto da mensagem citada (ate 300 chars) ou ''.
export function citado(msg) {
  const ctx = contextoDe(msg)
  if (!ctx || !ctx.quotedMessage) return ''
  let q = null
  try { q = normalizeMessageContent(ctx.quotedMessage) } catch { q = null }
  return textoDe(q).texto.slice(0, CITADO_MAX)
}

// Segundos desde que a mensagem foi escrita (messageTimestamp em segundos, numero ou Long). Sem carimbo: 0.
export function idadeS(msg, agoraMs) {
  const ts = Number(toNumber(msg && msg.messageTimestamp)) || 0
  if (!ts) return 0
  const agora = Number(agoraMs) || Date.now()
  return Math.max(0, Math.round(agora / 1000 - ts))
}

// O corpo do POST /api/bot/agente/msg, na forma do contrato (CONTRATO-v2, "Agente -> worker").
// `partes` traz o que depende do socket: numero, de_jid/de_fone/de_nome, menciona, responde, citado_de_bot.
export function pacoteDe(msg, partes) {
  const p = partes || {}
  const key = (msg && msg.key) || {}
  const { tipo, texto } = textoDa(msg)
  return {
    numero: String(p.numero || ''),
    jid: String(key.remoteJid || ''),
    msg_id: String(key.id || ''),
    de_jid: String(p.de_jid || ''),
    de_fone: String(p.de_fone || ''),
    de_nome: String(p.de_nome || ''),
    texto: String(texto || '').slice(0, TEXTO_MAX),
    tipo,
    menciona: !!p.menciona,
    responde: !!p.responde,
    citado: citado(msg),
    citado_de_bot: !!p.citado_de_bot,
    ts: Number(toNumber(msg && msg.messageTimestamp)) || 0,
  }
}
