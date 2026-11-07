// TESTE DA ENTRADA DO BOT (1.6.0, 05/11/2026): roda sem rede e sem conectar no WhatsApp.
// Monta mensagens no formato que o Baileys entrega ({ key, message, pushName, messageTimestamp }) e
// confere o que entrada.mjs tira delas: texto e tipo, quem mandou (telefone ou LID), se marcou o bot,
// se respondeu ao bot, a mensagem citada, a idade e a forma exata do pacote que vai pro worker.
// No fim le o agente.mjs como TEXTO e confere que a parte nova esta la (versao, escuta, digitando...).
//   node teste-entrada.mjs
import fs from 'node:fs'
import { conteudoDe, textoDa, contextoDe, quemMandou, meusJidsDe, mencionaBot, marcouBot, idsDoBot, respondeBot, citado, idadeS, pacoteDe } from './entrada.mjs'

let ok = 0
const falhas = []
const conf = (cond, msg) => { if (cond) ok += 1; else falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg) }
const secao = (t) => console.log('\n' + t)

// ── mensagens de mentira, no formato do Baileys ─────────────────────────────────────────
const GRUPO = '120363409748972155@g.us'
const PN = '5515997770001@s.whatsapp.net'
const LID = '123456789012345@lid'
const BOT = { id: '5515981316483:3@s.whatsapp.net', lid: '111@lid', name: 'Barbadinho' }
const AGORA_S = 1794000000
let n = 0
const msgDe = (message, extra = {}) => ({
  key: { remoteJid: GRUPO, fromMe: false, id: 'ID' + (++n), participant: PN, ...(extra.key || {}) },
  message,
  pushName: 'pushName' in extra ? extra.pushName : 'Guilherme',
  messageTimestamp: 'ts' in extra ? extra.ts : AGORA_S,
  ...(extra.stub ? { messageStubType: extra.stub } : {}),
})
const texto = (t, contextInfo) => (contextInfo ? { extendedTextMessage: { text: t, contextInfo } } : { conversation: t })

secao('textoDa e conteudoDe')
let r = textoDa(msgDe({ conversation: 'meu numero caiu' }))
conf(r.tipo === 'texto' && r.texto === 'meu numero caiu', 'conversation vira texto')
r = textoDa(msgDe({ extendedTextMessage: { text: 'oi @Barbadinho', contextInfo: { mentionedJid: [] } } }))
conf(r.tipo === 'texto' && r.texto === 'oi @Barbadinho', 'extendedTextMessage vira texto')
r = textoDa(msgDe({ imageMessage: { caption: 'esse pedido foi pago?', mimetype: 'image/jpeg' } }))
conf(r.tipo === 'imagem' && r.texto === 'esse pedido foi pago?', 'imagem com legenda: tipo imagem + a legenda')
r = textoDa(msgDe({ imageMessage: { mimetype: 'image/jpeg' } }))
conf(r.tipo === 'imagem' && r.texto === '', 'imagem sem legenda: texto vazio')
r = textoDa(msgDe({ videoMessage: { caption: 'olha isso' } }))
conf(r.tipo === 'video' && r.texto === 'olha isso', 'video com legenda')
r = textoDa(msgDe({ documentMessage: { caption: 'comprovante', fileName: 'a.pdf' } }))
conf(r.tipo === 'documento' && r.texto === 'comprovante', 'documento com legenda')
r = textoDa(msgDe({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'segue o pix', fileName: 'p.pdf' } } } }))
conf(r.tipo === 'documento' && r.texto === 'segue o pix', 'documentWithCaptionMessage desembrulha')
r = textoDa(msgDe({ audioMessage: { ptt: true, seconds: 4 } }))
conf(r.tipo === 'audio' && r.texto === '', 'audio: tipo audio, texto vazio')
r = textoDa(msgDe({ stickerMessage: { mimetype: 'image/webp' } }))
conf(r.tipo === 'sticker' && r.texto === '', 'figurinha: sticker')
r = textoDa(msgDe({ ephemeralMessage: { message: { extendedTextMessage: { text: 'some em 7 dias' } } } }))
conf(r.tipo === 'texto' && r.texto === 'some em 7 dias', 'ephemeralMessage embrulhando extendedTextMessage desembrulha')
r = textoDa(msgDe({ viewOnceMessageV2: { message: { imageMessage: { caption: 'ver uma vez' } } } }))
conf(r.tipo === 'imagem' && r.texto === 'ver uma vez', 'viewOnceMessageV2 desembrulha')
r = textoDa(msgDe({ editedMessage: { message: { conversation: 'texto corrigido' } } }))
conf(r.tipo === 'texto' && r.texto === 'texto corrigido', 'editedMessage com texto dentro desembrulha')
r = textoDa(msgDe({ editedMessage: { message: { protocolMessage: { type: 14, editedMessage: { conversation: 'corrigido' } } } } }))
conf(r.tipo === 'outro', 'edicao de verdade (protocolMessage dentro de editedMessage) e outro: nao responde em dobro')
r = textoDa(msgDe({ reactionMessage: { text: '+1', key: { id: 'X' } } }))
conf(r.tipo === 'outro' && r.texto === '', 'reacao e outro')
r = textoDa(msgDe({ protocolMessage: { type: 0, key: { id: 'X' } } }))
conf(r.tipo === 'outro', 'protocolo (apagou mensagem) e outro')
r = textoDa(msgDe(undefined, { stub: 27 }))
conf(r.tipo === 'outro' && r.texto === '', 'stub (entrou no grupo) e outro')
r = textoDa(msgDe({ conversation: 'tem texto mas e stub' }, { stub: 1 }))
conf(r.tipo === 'outro', 'messageStubType manda mesmo com texto')
conf(textoDa(null).tipo === 'outro' && textoDa({}).tipo === 'outro', 'sem mensagem e outro, sem lancar')
conf(conteudoDe(msgDe({ ephemeralMessage: { message: { conversation: 'x' } } })).conversation === 'x', 'conteudoDe devolve o de dentro do embrulho')
conf(conteudoDe({}) === null && conteudoDe(null) === null, 'conteudoDe sem message e null')

secao('contextoDe')
conf(contextoDe(msgDe({ conversation: 'x' })) === null, 'conversation nao tem contextInfo')
conf(contextoDe(msgDe({ imageMessage: { caption: 'x', contextInfo: { stanzaId: 'Q1' } } })).stanzaId === 'Q1', 'contextInfo da imagem')
conf(contextoDe(msgDe({ ephemeralMessage: { message: { extendedTextMessage: { text: 'x', contextInfo: { stanzaId: 'Q2' } } } } })).stanzaId === 'Q2', 'contextInfo por baixo do embrulho')
conf(contextoDe(msgDe({ messageContextInfo: { deviceListMetadataVersion: 2 }, extendedTextMessage: { text: 'x', contextInfo: { stanzaId: 'Q3' } } })).stanzaId === 'Q3', 'messageContextInfo (do protocolo) nao confunde')

secao('quemMandou')
let chamadas = 0
const mapa = async () => { chamadas++; return '5515997770001:12@s.whatsapp.net' }
let q = await quemMandou(msgDe(texto('oi')), mapa)
conf(q.de_jid === PN && q.de_fone === '5515997770001' && q.de_nome === 'Guilherme' && chamadas === 0, 'participant em @s.whatsapp.net: fone direto, sem usar o mapa')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: '5515997770001:7@s.whatsapp.net' } }), mapa)
conf(q.de_jid === PN && q.de_fone === '5515997770001', 'participant com :aparelho: de_jid sem o aparelho e fone sem o 7')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: LID, participantAlt: '5515997770002@s.whatsapp.net' } }), mapa)
conf(q.de_jid === LID && q.de_fone === '5515997770002' && chamadas === 0, 'participant LID + participantAlt PN: fone do alt, de_jid e o LID')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: LID } }), mapa)
conf(q.de_jid === LID && q.de_fone === '5515997770001' && chamadas === 1, 'participant LID sem alt: o mapa devolve fone:12@s.whatsapp.net e o fone sai sem o 12')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: LID } }), async () => null)
conf(q.de_jid === LID && q.de_fone === '', 'mapa devolve null: fone vazio')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: LID } }), async () => { throw new Error('boom') })
conf(q.de_jid === LID && q.de_fone === '' && q.de_nome === 'Guilherme', 'mapa que lanca: fone vazio, a funcao nao lanca')
q = await quemMandou(msgDe(texto('oi'), { key: { participant: LID } }), undefined)
conf(q.de_fone === '' && q.de_jid === LID, 'sem mapa: fone vazio')
q = await quemMandou(msgDe(texto('oi'), { pushName: undefined }), mapa)
conf(q.de_nome === '', 'sem pushName: nome vazio')
q = await quemMandou({ key: { remoteJid: '5515997770003@s.whatsapp.net', id: 'X' } }, mapa)
conf(q.de_jid === '5515997770003@s.whatsapp.net' && q.de_fone === '5515997770003', 'sem participant (conversa privada): usa o remoteJid')
q = await quemMandou(null, mapa)
conf(q.de_jid === '' && q.de_fone === '' && q.de_nome === '', 'mensagem nula: tudo vazio, sem lancar')

secao('meusJidsDe')
const meus = meusJidsDe(BOT)
conf(meus.size === 2 && meus.has('5515981316483@s.whatsapp.net') && meus.has('111@lid'), 'id e lid do bot, sem o aparelho')
conf(meusJidsDe(undefined).size === 0 && meusJidsDe({ id: BOT.id }).size === 1, 'sem user: vazio; so id: um')

secao('mencionaBot')
const NOMES = ['Barbadinho', 'barbadinho']
conf(mencionaBot(msgDe(texto('@5515981316483 o pedido foi pago?', { mentionedJid: ['5515981316483@s.whatsapp.net'] })), meus, NOMES) === true, 'marcado pelo PN')
conf(mencionaBot(msgDe(texto('@5515981316483 oi', { mentionedJid: ['5515981316483:3@s.whatsapp.net'] })), meus, NOMES) === true, 'marcado pelo PN com :aparelho')
conf(mencionaBot(msgDe(texto('oi', { mentionedJid: ['111@lid'] })), meus, NOMES) === true, 'marcado pelo LID')
conf(mencionaBot(msgDe(texto('oi', { mentionedJid: ['5515997770009@s.whatsapp.net'] })), meus, NOMES) === false, 'marcou outra pessoa: falso')
conf(mencionaBot(msgDe(texto('@Barbadinho me ajuda')), meus, NOMES) === true, '@Barbadinho no texto')
conf(mencionaBot(msgDe(texto('barbadinho o numero caiu')), meus, NOMES) === true, 'barbadinho em minusculo')
conf(mencionaBot(msgDe(texto('BARBADÍNHO?')), meus, 'Barbadinho') === true, 'com acento e maiusculo, nome como string')
conf(mencionaBot(msgDe({ imageMessage: { caption: 'olha barbadinho' } }), meus, NOMES) === true, 'nome na legenda da imagem')
conf(mencionaBot(msgDe(texto('meu numero caiu')), meus, NOMES) === false, 'sem nada: falso')
conf(mencionaBot(msgDe(texto('barbadinhos')), meus, NOMES) === false, 'palavra colada (barbadinhos) nao conta')
conf(mencionaBot(msgDe({ audioMessage: {} }), meus, NOMES) === false, 'audio sem texto: falso')
conf(mencionaBot(msgDe(texto('oi')), meus, ['', '  ']) === false, 'nomes vazios: falso, sem lancar')

secao('marcouBot e idsDoBot (1.6.1)')
conf(marcouBot(msgDe(texto('@30662576877805 oi', { mentionedJid: ['111@lid'] })), meus, NOMES) === true, 'marcou pelo LID: marcou de verdade')
conf(marcouBot(msgDe(texto('@Barbadinho me ajuda')), meus, NOMES) === true, '"@Barbadinho" digitado: marcou')
conf(marcouBot(msgDe(texto('kkkk o barbadinho zoou o Kevin')), meus, NOMES) === false && mencionaBot(msgDe(texto('kkkk o barbadinho zoou o Kevin')), meus, NOMES) === true, 'so o nome no meio da frase: menciona sim, marcou nao')
conf(marcouBot(msgDe(texto('oi', { mentionedJid: ['5515997770009@s.whatsapp.net'] })), meus, NOMES) === false, 'marcou outra pessoa: falso')
conf(marcouBot(msgDe(texto('@barbadinhos')), meus, NOMES) === false, '"@barbadinhos" colado: falso')
conf(idsDoBot(meus).join(',') === '5515981316483', 'idsDoBot: so digitos de 5 a 20 (o LID de mentira "111" do teste fica fora)')
conf(idsDoBot(new Set(['5515981316483@s.whatsapp.net', '30662576877805@lid'])).join(',') === '5515981316483,30662576877805' && idsDoBot(undefined).length === 0, 'idsDoBot: numero e LID, so digitos; sem nada, vazio')

secao('respondeBot')
const meusIds = new Set(['BOT001'])
conf(respondeBot(msgDe(texto('foi?', { participant: '5515981316483:2@s.whatsapp.net', stanzaId: 'X', quotedMessage: { conversation: 'resumo' } })), meus, meusIds) === true, 'citou mensagem cujo autor e o PN do bot')
conf(respondeBot(msgDe(texto('foi?', { participant: '111@lid', stanzaId: 'X', quotedMessage: { conversation: 'resumo' } })), meus, meusIds) === true, 'citou mensagem cujo autor e o LID do bot')
conf(respondeBot(msgDe(texto('foi?', { participant: LID, stanzaId: 'BOT001', quotedMessage: { conversation: 'resumo' } })), meus, meusIds) === true, 'stanzaId entre os ids que o bot mandou')
conf(respondeBot(msgDe(texto('foi?', { participant: LID, stanzaId: 'OUTRO', quotedMessage: { conversation: 'x' } })), meus, meusIds) === false, 'citou outra pessoa: falso')
conf(respondeBot(msgDe(texto('foi?')), meus, meusIds) === false, 'sem contextInfo: falso')

secao('citado')
conf(citado(msgDe(texto('e esse?', { stanzaId: 'Q', quotedMessage: { conversation: 'Guilherme fez 10 hoje' } }))) === 'Guilherme fez 10 hoje', 'citada com conversation')
conf(citado(msgDe(texto('e esse?', { stanzaId: 'Q', quotedMessage: { ephemeralMessage: { message: { extendedTextMessage: { text: 'temporaria' } } } } }))) === 'temporaria', 'citada embrulhada desembrulha')
conf(citado(msgDe(texto('e esse?', { stanzaId: 'Q', quotedMessage: { imageMessage: { caption: 'legenda' } } }))) === 'legenda', 'citada com imagem: a legenda')
conf(citado(msgDe(texto('e esse?', { stanzaId: 'Q', quotedMessage: { audioMessage: {} } }))) === '', 'citada audio: vazio')
conf(citado(msgDe(texto('e esse?', { stanzaId: 'Q', quotedMessage: { conversation: 'x'.repeat(500) } }))).length === 300, 'citada cortada em 300')
conf(citado(msgDe(texto('oi'))) === '', 'sem citacao: vazio')

secao('idadeS')
const agoraMs = AGORA_S * 1000
conf(idadeS(msgDe(texto('oi'), { ts: AGORA_S - 90 }), agoraMs) === 90, '90 s atras')
conf(idadeS(msgDe(texto('oi'), { ts: { low: AGORA_S - 200, high: 0, unsigned: false, toNumber() { return AGORA_S - 200 } } }), agoraMs) === 200, 'messageTimestamp em Long')
conf(idadeS(msgDe(texto('oi'), { ts: { low: AGORA_S - 30, high: 0 } }), agoraMs) === 30, 'Long sem toNumber (so low)')
conf(idadeS(msgDe(texto('oi'), { ts: undefined }), agoraMs) === 0, 'sem carimbo: 0')
conf(idadeS(msgDe(texto('oi'), { ts: AGORA_S + 50 }), agoraMs) === 0, 'carimbo no futuro: 0, nunca negativo')
conf(idadeS(msgDe(texto('oi'), { ts: AGORA_S - 121 }), agoraMs) > 120, 'mais de 120 s: o agente descarta')

secao('pacoteDe')
const m = msgDe(texto('o pedido da Maria foi pago?', { stanzaId: 'BOT001', participant: '111@lid', quotedMessage: { conversation: 'Resumo do dia' } }), { key: { id: '3EB0ABC', participant: LID } })
const p = pacoteDe(m, { numero: '5515981316483', de_jid: LID, de_fone: '5515997770001', de_nome: 'Guilherme', menciona: false, responde: true, citado_de_bot: true })
conf(Object.keys(p).join(',') === 'numero,jid,msg_id,de_jid,de_fone,de_nome,texto,tipo,menciona,responde,citado,citado_de_bot,ts,marcado,bot_ids', 'as 15 chaves do contrato, na ordem (1.6.1: marcado e bot_ids no fim)')
const p2 = pacoteDe(m, { marcado: true, bot_ids: ['5515981316483', '30662576877805', 'x', 'y', 'z'] })
conf(p2.marcado === true && p2.bot_ids.length === 4 && p.marcado === false && Array.isArray(p.bot_ids) && p.bot_ids.length === 0, 'marcado e bot_ids (no maximo 4); sem eles, false e lista vazia')
conf(p.numero === '5515981316483' && p.jid === GRUPO && p.msg_id === '3EB0ABC', 'numero, jid do grupo e msg_id')
conf(p.de_jid === LID && p.de_fone === '5515997770001' && p.de_nome === 'Guilherme', 'quem mandou')
conf(p.texto === 'o pedido da Maria foi pago?' && p.tipo === 'texto', 'texto e tipo')
conf(p.menciona === false && p.responde === true && p.citado === 'Resumo do dia' && p.citado_de_bot === true, 'menciona, responde, citado e citado_de_bot')
conf(p.ts === AGORA_S && typeof p.ts === 'number', 'ts em segundos, numero')
const longo = pacoteDe(msgDe(texto('y'.repeat(1500))), {})
conf(longo.texto.length === 1000 && longo.de_fone === '' && longo.menciona === false && longo.citado === '' && longo.numero === '', 'texto cortado em 1000; partes que faltam viram vazio/false')
conf(pacoteDe(msgDe({ audioMessage: {} }), {}).tipo === 'audio' && pacoteDe(msgDe({ audioMessage: {} }), {}).texto === '', 'audio vai como tipo audio e texto vazio')

secao('agente.mjs (fonte)')
const fonte = fs.readFileSync(new URL('./agente.mjs', import.meta.url), 'utf8')
const tem = (s, nome) => conf(fonte.includes(s), 'agente.mjs tem ' + nome)
tem("const VERSAO = '1.7.0'", 'VERSAO 1.7.0')
tem("const reacao = String(j.reacao || '').trim()", 'le a reacao que o worker devolve (1.7.0)')
tem('{ react: { text: emoji, key:', 'manda a reacao pelo Baileys, na chave da mensagem')
tem("log(cabeca + ' -> reagi ' + reacao)", 'registra a reacao no log')
tem("'messages.upsert'", 'o ouvinte messages.upsert')
tem('escuta', 'a lista escuta do ping')
tem("'append'", "aceita type 'append'")
tem("'notify'", "aceita type 'notify'")
tem("sendPresenceUpdate('composing'", 'digitando antes de responder')
tem("sendPresenceUpdate('paused'", 'para de digitar depois')
tem('quoted: msg', 'responde citando a pergunta')
tem('35000', 'timeout de 35 s na chamada /msg')
tem('/api/bot/agente/msg', 'a rota /msg')
tem('msg-ack', 'a rota msg-ack')
tem('getPNForLID', 'o mapa LID -> telefone do Baileys')
tem('meusMsgIds', 'o conjunto de ids do bot')
tem('isJidGroup', 'so grupo')
tem('messageStubType', 'pula stub')
tem('MSG_FILA_MAX = 10', 'ate 10 esperando por grupo')
tem('MSG_IDADE_MAX_S = 120', 'idade maxima de 120 s')
tem('MEUS_IDS_MAX = 500', 'teto de 500 ids')
tem('meuSock !== sock', 'a guarda de socket velho')
const iUpsert = fonte.indexOf("'messages.upsert'")
conf(iUpsert > fonte.indexOf('async function conectar()') && iUpsert < fonte.indexOf('async function sair()'), 'o ouvinte e registrado dentro de conectar(), por socket')
conf(!/\btimeout\(20000\)[\s\S]*agente\/msg'/.test(fonte.slice(fonte.indexOf('const apiMsg'))), 'a chamada /msg nao usa o teto de 20 s do ping')

console.log('\n' + (falhas.length ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhas.length) + ' conferencias')
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1) }
