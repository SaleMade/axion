// Interface do painel. Roda na PRÓPRIA janela, ao lado da página do WhatsApp.
//
// O DESENHO É O MESMO DO INBOX DA DASH (pedido do Bruno em 16/10: "quero que fique igualzinho,
// idêntico"). As cores, os raios e os tamanhos estão no painel.html, resolvidos em hex: o inbox
// vive dentro do `.wa-scope`, que troca o tema da SellWave pela paleta do WhatsApp Web escuro.
//
// Quem fala com o WhatsApp é o agente injetado (src/ui/agente.js). Este arquivo só pede, por IPC:
// "qual é o estado?" e "manda este item".

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// CATÁLOGO DE TIPOS, a mesma paleta do inbox (KIND em chat.jsx). A cor é por TIPO, não por tema.
const TIPOS = {
  text: { cor: '#2563eb', rotulo: 'Mensagens', ic: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-4-1L3 21l2.1-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>' },
  audio: { cor: '#13c273', rotulo: 'Áudios', ic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>' },
  video: { cor: '#8e17f0', rotulo: 'Vídeos', ic: '<path d="m23 7-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/>' },
  image: { cor: '#00bcf2', rotulo: 'Imagens', ic: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>' },
  document: { cor: '#f0810f', rotulo: 'Documentos', ic: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>' },
}
const svg = (d, cls) => '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'
const IC_PLAY = svg('<path d="m6 3 14 9-14 9V3Z"/>')
const IC_GIRA = svg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 'girando')
const IC_ZAP = svg('<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>')
const IC_SETA = svg('<path d="m6 9 6 6 6-6"/>', 'seta')
const IC_ESTRELA = (cheia) => '<svg viewBox="0 0 24 24" fill="' + (cheia ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z"/></svg>'

let roteiro = { messages: [], sequences: [], media: [], mediaBase: '' }
let aba = 'itens'
let filtro = ''
let tipoFiltro = ''          // '' = todos
let favoritos = {}
let fechadas = {}            // seções recolhidas, por tipo
let aberto = ''              // prévia aberta: 'item:<id>' ou 'funil:<id>'
let ocupado = false
let disparando = ''
let pararPedido = false
let ultimoFone = ''
let estadoWa = { motor: false, autenticado: false, envia: false, chatId: '', phone: '', nome: '', eu: '', trocado: '' }

try { favoritos = JSON.parse(localStorage.getItem('sw_favs') || '{}') } catch { favoritos = {} }
const guardaFavs = () => { try { localStorage.setItem('sw_favs', JSON.stringify(favoritos)) } catch { /* sem armazenamento o favorito vale só nesta sessão */ } }

// ───────────────────────────────────────────────────────────── catálogo

// Junta mensagens e mídias num catálogo só, como a aba Itens do inbox.
function catalogo() {
  const saida = []
  for (const m of (roteiro.messages || [])) saida.push({ id: m.id, tipo: 'text', label: m.label || m.text || m.id, texto: m.text || '', grp: m.grp || '' })
  for (const md of (roteiro.media || [])) {
    // SÓ O QUE O AGENTE SABE MANDAR. O catálogo do Sale Chat guarda tudo que não é mensagem no
    // mesmo lugar, inclusive cartão de contato, que não tem arquivo e não tem envio aqui: clicar
    // nele dava um erro técnico sem explicação. Melhor não aparecer.
    if (!TIPOS[md.kind] || !md.key) continue
    saida.push({ id: md.id, tipo: md.kind, label: md.label || md.id, caption: md.caption || '', key: md.key, grp: md.grp || '' })
  }
  return saida
}

function visiveis() {
  let itens = catalogo()
  if (aba === 'favs') itens = itens.filter((x) => favoritos[x.id])
  if (tipoFiltro) itens = itens.filter((x) => x.tipo === tipoFiltro)
  if (filtro) itens = itens.filter((x) => (x.label + ' ' + (x.texto || '') + ' ' + (x.grp || '')).toLowerCase().includes(filtro))
  return itens
}

function porGrupo(lista) {
  const ordem = [], g = {}
  for (const x of lista) { const k = x.grp || 'Geral'; if (!g[k]) { g[k] = []; ordem.push(k) } g[k].push(x) }
  return { ordem, g }
}

const podeEnviar = () => !!(estadoWa.envia && estadoWa.chatId && !ocupado)

// ───────────────────────────────────────────────────────────── desenho

function desenhaChips() {
  const el = $('chips')
  if (aba === 'funis') { el.style.display = 'none'; return }
  el.style.display = ''
  const usados = [...new Set(catalogo().map((x) => x.tipo))]
  let html = '<button class="chip' + (tipoFiltro ? '' : ' on') + '" data-t="" style="--kc:#54656f" title="Todos">'
    + svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') + '</button>'
  for (const t of ['text', 'audio', 'video', 'image', 'document']) {
    if (!usados.includes(t)) continue
    const k = TIPOS[t]
    html += '<button class="chip' + (tipoFiltro === t ? ' on' : '') + '" data-t="' + t + '" style="--kc:' + k.cor + '" title="' + k.rotulo + '">' + svg(k.ic) + '</button>'
  }
  el.innerHTML = html
  for (const b of el.querySelectorAll('.chip')) b.onclick = () => { tipoFiltro = b.dataset.t; desenha() }
}

function desenha() {
  desenhaChips()
  const corpo = $('corpo')
  const nFunis = (roteiro.sequences || []).length
  const selo = $('selo-funis')
  selo.hidden = !nFunis
  selo.textContent = nFunis

  if (aba === 'funis') { corpo.innerHTML = desenhaFunis(); ligaFunis(corpo); return }

  const itens = visiveis()
  if (!itens.length) {
    corpo.innerHTML = '<div class="vazio">' + (aba === 'favs'
      ? 'Nenhum favorito ainda. Toque na estrela de um item.'
      : (filtro || tipoFiltro ? 'Nenhum item encontrado.' : 'Nada aqui. Cadastre itens no Sale Chat.')) + '</div>'
    return
  }

  // Duas camadas, como no inbox: seção por TIPO e, dentro dela, subgrupo pela divisória do roteiro.
  let html = ''
  for (const t of ['text', 'audio', 'video', 'image', 'document']) {
    const doTipo = itens.filter((x) => x.tipo === t)
    if (!doTipo.length) continue
    const k = TIPOS[t]
    const fechada = !!fechadas[t]
    html += '<button class="sec' + (fechada ? ' fechada' : '') + '" data-sec="' + t + '" style="--kc:' + k.cor + '">'
      + svg(k.ic) + '<span>' + k.rotulo + '</span><span class="n">' + doTipo.length + '</span>' + IC_SETA + '</button>'
    if (fechada) continue
    const { ordem, g } = porGrupo(doTipo)
    const umSo = ordem.length === 1
    ordem.forEach((nome, i) => {
      if (!umSo) html += '<div class="grp' + (i === 0 ? ' primeiro' : '') + '" style="--ac:' + k.cor + '">'
        + '<span>' + esc(nome) + '</span><span class="n">' + g[nome].length + '</span></div>'
      for (const x of g[nome]) html += cartaoItem(x, k)
    })
  }
  corpo.innerHTML = html
  ligaItens(corpo)
}

function cartaoItem(x, k) {
  const ab = aberto === 'item:' + x.id
  const fav = !!favoritos[x.id]
  let prev = ''
  if (ab) {
    const corpo = x.tipo === 'text' ? (x.texto || '') : (x.caption || ('[' + TIPOS[x.tipo].rotulo.slice(0, -1).toLowerCase() + '] ' + x.label))
    prev = '<div class="prev"><div class="prev-bandeja"><div class="prev-balao">' + esc(corpo)
      + '<span class="prev-hora">agora</span></div></div></div>'
  }
  return '<div class="item" style="--kc:' + k.cor + '">'
    + '<div class="item-linha">'
    + '<span class="item-ic">' + svg(k.ic) + '</span>'
    + '<button class="item-lbl" data-abre="item:' + esc(x.id) + '">' + esc(x.label) + '</button>'
    + '<button class="estrela' + (fav ? ' on' : '') + '" data-fav="' + esc(x.id) + '" title="Favorito">' + IC_ESTRELA(fav) + '</button>'
    + '<button class="enviar" data-envia="' + esc(x.id) + '" title="Enviar"' + (podeEnviar() ? '' : ' disabled') + '>'
    + (disparando === x.id ? IC_GIRA : IC_PLAY) + '</button>'
    + '</div>' + prev + '</div>'
}

function desenhaFunis() {
  let seqs = roteiro.sequences || []
  if (filtro) seqs = seqs.filter((s) => (String(s.label || '') + ' ' + String(s.grp || '')).toLowerCase().includes(filtro))
  if (!seqs.length) return '<div class="vazio">Nenhum funil ainda. Crie no Sale Chat.</div>'
  const { ordem, g } = porGrupo(seqs)
  const umSo = ordem.length === 1
  let html = ''
  ordem.forEach((nome, i) => {
    if (!umSo) html += '<div class="grp' + (i === 0 ? ' primeiro' : '') + '" style="--ac:#8e17f0">'
      + '<span>' + esc(nome) + '</span><span class="n">' + g[nome].length + '</span></div>'
    for (const s of g[nome]) {
      const ab = aberto === 'funil:' + s.id
      let prev = ''
      if (ab) {
        const passos = (s.items || [])
        prev = '<div class="funil-prev">' + (passos.length ? passos.map((p, j) => {
          const info = infoDoPasso(p.id || p)
          const k = TIPOS[info.tipo]
          const pausa = Number(p.delay || 0)
          return '<div class="passo" style="--kc:' + k.cor + '">'
            + '<span class="passo-ic">' + svg(k.ic) + '</span>'
            + '<span class="passo-n">' + (j + 1) + '</span>'
            + '<span class="passo-lbl">' + esc(info.label) + '</span>'
            + '<span class="passo-pausa">' + (pausa > 0 ? 'pausa ' + pausa + 's' : 'sem pausa') + '</span></div>'
        }).join('') : 'Funil sem passos.')
          + (s.stopOnReply ? '<div style="margin-top:4px;font-size:10px">Para se o lead responder.</div>' : '')
          + '</div>'
      }
      html += '<div class="funil">'
        + '<div class="funil-linha">'
        + '<span class="funil-ic">' + IC_ZAP + '</span>'
        + '<button class="funil-lbl" data-abre="funil:' + esc(s.id) + '">' + esc(s.label || s.id)
        + '<span class="passos">' + (s.items || []).length + ' passos</span></button>'
        + '<button class="enviar" data-funil="' + esc(s.id) + '" title="Disparar funil"' + (podeEnviar() ? '' : ' disabled') + '>'
        + (disparando === s.id ? IC_GIRA : IC_PLAY) + '</button>'
        + '</div>' + prev + '</div>'
    }
  })
  return html
}

function infoDoPasso(id) {
  const m = (roteiro.messages || []).find((x) => x.id === id)
  if (m) return { tipo: 'text', label: m.label || m.text || id }
  const md = (roteiro.media || []).find((x) => x.id === id)
  if (md) return { tipo: TIPOS[md.kind] ? md.kind : 'document', label: md.label || id }
  return { tipo: 'text', label: String(id) }
}

function ligaItens(corpo) {
  for (const b of corpo.querySelectorAll('.sec')) b.onclick = () => { fechadas[b.dataset.sec] = !fechadas[b.dataset.sec]; desenha() }
  for (const b of corpo.querySelectorAll('[data-abre]')) b.onclick = () => { aberto = aberto === b.dataset.abre ? '' : b.dataset.abre; desenha() }
  for (const b of corpo.querySelectorAll('[data-fav]')) b.onclick = () => {
    const id = b.dataset.fav
    if (favoritos[id]) delete favoritos[id]; else favoritos[id] = 1
    guardaFavs(); desenha()
  }
  for (const b of corpo.querySelectorAll('[data-envia]')) b.onclick = () => disparaItem(b.dataset.envia)
}
function ligaFunis(corpo) {
  for (const b of corpo.querySelectorAll('[data-abre]')) b.onclick = () => { aberto = aberto === b.dataset.abre ? '' : b.dataset.abre; desenha() }
  for (const b of corpo.querySelectorAll('[data-funil]')) b.onclick = () => disparaFunil(b.dataset.funil)
}

// AVISO QUE DURA. O pulso roda a cada 1,5 segundo e reescrevia o rodapé com "pronto": toda
// mensagem de erro sumia antes de o vendedor ler. Agora erro segura a linha por 10 segundos.
let avisoAte = 0
// Traduz o erro do navegador. ERR_PROXY_CONNECTION_FAILED não diz nada pra um vendedor.
function humano(txt) {
  const t = String(txt || '')
  if (/ERR_PROXY|ERR_TUNNEL|NO_SUPPORTED_PROXIES/i.test(t)) return 'o proxy deste número não respondeu'
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|fetch failed|Failed to fetch/i.test(t)) return 'sem internet'
  if (/demorou demais/i.test(t)) return t
  if (/não baixei a mídia|midia/i.test(t)) return 'não consegui baixar o arquivo'
  if (/motor/i.test(t)) return 'o WhatsApp ainda não está pronto'
  return t
}

function rodape(txt, pct, segura) {
  if (!segura && Date.now() < avisoAte) return
  if (segura) avisoAte = Date.now() + 10000
  $('rod').textContent = txt
  const barra = $('barra')
  barra.style.display = pct == null ? 'none' : 'block'
  if (pct != null) barra.firstChild.style.width = Math.round(pct * 100) + '%'
}

// ───────────────────────────────────────────────────────────── disparo

const achaMsg = (id) => (roteiro.messages || []).find((m) => m.id === id)
const achaMidia = (id) => (roteiro.media || []).find((m) => m.id === id)

function itemParaEnvio(id, simPadrao) {
  const m = achaMsg(id)
  if (m) return { tipo: 'texto', texto: m.text || '', sim: simPadrao == null ? 2 : simPadrao }
  const md = achaMidia(id)
  if (md) return { tipo: 'midia', kind: md.kind, url: roteiro.mediaBase + md.key, caption: md.caption || '', label: md.label || '', sim: simPadrao == null ? (md.kind === 'audio' ? 3 : 0) : simPadrao }
  return null
}

async function disparaItem(id) {
  const it = itemParaEnvio(id)
  if (!it) { rodape('não achei esse item no roteiro'); return }
  await roda([it], id)
}

async function disparaFunil(id) {
  const s = (roteiro.sequences || []).find((x) => x.id === id)
  if (!s) return
  const lista = []
  for (const p of (s.items || [])) {
    const it = itemParaEnvio(p.id || p, p.sim)
    if (it) { it.delay = p.delay || 0; lista.push(it) }
  }
  if (!lista.length) { rodape('funil sem passos'); return }
  await roda(lista, id)
}

async function roda(lista, marca) {
  if (ocupado) return
  if (!estadoWa.chatId) { rodape('abra uma conversa primeiro'); return }
  if (!estadoWa.envia) { rodape('o motor do WhatsApp não está pronto'); return }

  // TRAVA O ALVO NO CLIQUE. Se o vendedor trocar de conversa no meio do funil, o resto tem que ir
  // pra quem ele mandou, não pra quem está na tela agora.
  const alvo = estadoWa.chatId
  const alvoNk = estadoWa.nk || ''
  ocupado = true
  disparando = marca
  pararPedido = false
  desenha()
  $('parar').style.display = lista.length > 1 ? 'inline' : 'none'

  for (let i = 0; i < lista.length; i++) {
    if (pararPedido) { rodape('parado no item ' + (i + 1) + ' de ' + lista.length, null, true); break }
    if (lista.length > 1) rodape('enviando ' + (i + 1) + ' de ' + lista.length, (i + 1) / lista.length)
    else rodape('enviando...')
    const it = lista[i]
    if (it.delay) await new Promise((r) => setTimeout(r, Number(it.delay) * 1000))
    if (pararPedido) { rodape('parado em ' + (i + 1) + ' de ' + lista.length); break }
    const r = await window.swp.manda(alvoNk, alvo, it)
    if (!r || !r.ok) {
      ocupado = false; disparando = ''; $('parar').style.display = 'none'
      const feitos = i
      rodape(lista.length > 1
        ? 'parou no item ' + (i + 1) + ' de ' + lista.length + (feitos ? ', os ' + feitos + ' primeiros já foram' : '') + ': ' + humano((r && r.erro) || 'sem resposta')
        : 'não enviou: ' + humano((r && r.erro) || 'sem resposta'), null, true)
      desenha()
      return
    }
  }
  ocupado = false
  disparando = ''
  $('parar').style.display = 'none'
  if (!pararPedido) rodape('enviado')
  desenha()
  setTimeout(() => { if (!ocupado) rodape(estadoWa.autenticado ? 'pronto' : 'leia o QR no celular') }, 2500)
}

$('parar').onclick = () => { pararPedido = true }
$('fechar').onclick = () => window.swp.fechar()
$('recarregar').onclick = () => { rodape('recarregando...'); window.swp.recarregar() }
$('esconder').onclick = () => window.swp.esconder()

// ───────────────────────────────────────────────────────────── lead

const formata = (d) => {
  const x = String(d || '').replace(/^55/, '')
  if (x.length === 11) return '(' + x.slice(0, 2) + ') ' + x.slice(2, 7) + '-' + x.slice(7)
  if (x.length === 10) return '(' + x.slice(0, 2) + ') ' + x.slice(2, 6) + '-' + x.slice(6)
  return String(d || '')
}

async function atualizaLead() {
  const fone = estadoWa.phone
  if (!fone) {
    if (ultimoFone !== '') {
      ultimoFone = ''
      $('lead').innerHTML = '<div class="nm">Abra uma conversa</div><div class="ln">o painel segue quem está na tela</div>'
    }
    return
  }
  if (fone === ultimoFone) return
  ultimoFone = fone
  const cabecalho = esc(estadoWa.nome || formata(fone))
  $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div><div class="ln">procurando na dash...</div>'
  const d = await window.swp.lead(fone)
  if (estadoWa.phone !== fone) return    // trocou de conversa no meio da busca
  if (!d || !d.achou) {
    $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div><div class="ln">' + esc(formata(fone)) + ' · sem pedido na dash</div>'
    return
  }
  const linha = [d.produto, d.cidade ? d.cidade + '/' + d.uf : ''].filter(Boolean).join(' · ')
  $('lead').innerHTML = '<div class="nm">' + esc(d.nome || cabecalho) + '</div>'
    + '<div class="ln">' + esc(linha || formata(fone)) + '</div>'
    + (d.etapa ? '<span class="tag">' + esc(d.etapa) + (d.pedidos > 1 ? ' · ' + d.pedidos + ' pedidos' : '') + '</span>' : '')
}

// ───────────────────────────────────────────────────────────── ciclo

let podiaEnviar = false
let ultimaTentativa = 0
async function pulso() {
  const e = await window.swp.estado()
  if (e) estadoWa = e
  // O pontinho verde so acende com o WhatsApp PAREADO. Antes acendia na tela do QR, porque so
  // olhava se a biblioteca tinha carregado.
  $('pt').className = 'pt' + (estadoWa.autenticado ? '' : ' off')
  $('meu').textContent = estadoWa.eu ? formata(estadoWa.eu) : ''

  // NÚMERO TROCADO: o QR deste slot foi lido por outro aparelho. Grita, porque dali pra frente a
  // dash e o app discordam do que está acontecendo.
  const av = $('trocado')
  if (estadoWa.trocado) {
    av.textContent = 'Atenção: este slot está pareado com ' + formata(estadoWa.trocado) + '. Desconecte e leia o QR com o aparelho certo.'
    av.style.display = 'block'
  } else { av.style.display = 'none' }

  if (!ocupado) rodape(estadoWa.autenticado ? 'pronto' : (estadoWa.motor ? 'leia o QR no celular' : 'carregando o WhatsApp'))
  // Só redesenha quando o botão de enviar muda de estado: redesenhar a cada pulso apagaria a
  // seleção de texto e piscaria a lista.
  const agora = podeEnviar()
  if (agora !== podiaEnviar) { podiaEnviar = agora; desenha() }
  // Roteiro vazio: tenta de novo de vez em quando (o login pode ter acontecido depois do boot).
  if (roteiroVazio() && Date.now() - ultimaTentativa > 15000) { ultimaTentativa = Date.now(); pegaRoteiro() }
  await atualizaLead()
}

for (const b of document.querySelectorAll('.aba')) {
  b.onclick = () => {
    aba = b.dataset.aba
    for (const o of document.querySelectorAll('.aba')) o.classList.toggle('on', o === b)
    aberto = ''
    desenha()
  }
}
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenha() }

// O PAINEL CARREGA ANTES DO LOGIN. A janela dele sobe junto com o app, e nessa hora pode nao
// haver token ainda: o roteiro volta vazio e, sem tentar de novo, o vendedor ficaria com Respostas
// e Funis em branco pra sempre, mesmo depois de entrar. Por isso insiste enquanto estiver vazio.
let buscandoRoteiro = false
async function pegaRoteiro() {
  if (buscandoRoteiro) return
  buscandoRoteiro = true
  try {
    const r = await window.swp.roteiro()
    if (r && r.ok) {
      roteiro = { messages: r.messages || [], sequences: r.sequences || [], media: r.media || [], mediaBase: r.mediaBase || '' }
      desenha()
    }
  } catch (_) { /* tenta de novo no próximo pulso */ } finally { buscandoRoteiro = false }
}
const roteiroVazio = () => !(roteiro.messages || []).length && !(roteiro.sequences || []).length && !(roteiro.media || []).length
pegaRoteiro().then(desenha)

setInterval(pulso, 1500)
pulso()
