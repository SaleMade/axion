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
let soFavs = false        // o mesmo filtro do inbox: estrela ao lado dos chips
let filtro = ''
let tipoFiltro = ''          // '' = todos
let favoritos = {}
let fechadas = {}            // seções recolhidas, por tipo
let aberto = ''              // prévia aberta: 'item:<id>' ou 'funil:<id>'
let ocupado = false
let disparando = ''
let pararPedido = false
let ultimoFone = ''
let alvoFone = ''        // de quem e o disparo em andamento (o painel e um so pra todos os numeros)
let alvoNome = ''
let alvoNkAtual = ''
// So carimba quando o painel JA TROCOU de numero. Com o vendedor parado no mesmo numero, dizer
// "para Fulano" em todo passo e ruido; depois de trocar, nao dizer e mentira.
const paraQuem = () => (alvoNkAtual && estadoWa.nk && alvoNkAtual !== estadoWa.nk && (alvoNome || alvoFone))
  ? ' para ' + (alvoNome || alvoFone) : ''
let estadoWa = { motor: false, autenticado: false, envia: false, chatId: '', phone: '', nome: '', eu: '', trocado: '' }
// O QUE ESTA SAINDO NOS NUMEROS ABERTOS (a "pilha de disparos" que o Bruno perguntou se ja existia;
// nao existia). Hoje da 0 ou 1 porque o painel roda UM funil por vez no app inteiro - a trava
// `ocupado`. Fica como lista de proposito: no dia em que o disparo for por numero, a tela ja serve.
let saindo = []

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
  if (soFavs) itens = itens.filter((x) => favoritos[x.id])
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

async function pegaDisparos() {
  if (window.__swFoto) return          // idem: a faixa "saindo agora" da foto e montada pelo exemplo
  try {
    const r = await window.swp.disparos()
    saindo = (r && r.ok && Array.isArray(r.itens)) ? r.itens : []
  } catch (_) { saindo = [] }
  if (aba === 'funis') desenha()
}

// A faixa do topo da aba Funis. O vendedor que trocou de numero no meio de um funil ve AQUI que ele
// continua saindo, e por qual numero: antes a unica pista era o rodape, que fala do numero da tela.
function desenhaSaindo() {
  if (!saindo.length) return ''
  // A contagem do cabecalho e o texto do inbox, no singular e no plural.
  const n = saindo.length
  let h = '<div class="saindo">'
    + '<div class="cab"><span class="roda"></span>'
    + '<span class="t">Enviando funil' + (n > 1 ? 's' : '') + ' · ' + n + '</span></div>'
  // MOSTRAR O DONO so quando ha mais de um, como no inbox: com um envio so, repetir de quem e o
  // numero em toda linha e ruido.
  const donos = new Set(saindo.map((d) => String(d.dono || '')))
  for (const d of saindo) {
    const total = Number(d.total) || 0
    const passo = Math.max(1, Math.min(total || 1, Number(d.passo) || 1))
    h += '<div class="item-env"><span class="roda"></span><div class="txt">'
      + '<div class="l1"><span class="rot">Funil:</span> ' + esc(d.funil || 'sem nome')
      + (d.alvo ? '<span class="para"> &rarr; ' + esc(formata(d.alvo)) + '</span>' : '') + '</div>'
      + (donos.size > 1 && d.dono ? '<div class="dono">' + esc(d.dono) + '</div>' : '')
      + '<div class="l2">' + (total ? 'Enviando passo ' + passo + ' de ' + total : 'Enviando')
      + (d.numero ? ' · ' + esc(formata(d.numero)) : '') + '</div>'
      + '</div></div>'
  }
  return h + '</div>'
}

function desenhaChips() {
  const el = $('chips')
  const linha = $('linha-chips')
  // Busca e chips são do catálogo de itens. Nas outras abas eles não filtram nada, e deixar a busca
  // ali faz o vendedor digitar nela achando que procura pedido.
  if (aba === 'funis' || aba === 'pedidos') { linha.style.display = 'none'; $('cabeca').style.display = aba === 'pedidos' ? 'none' : ''; return }
  $('cabeca').style.display = ''
  linha.style.display = ''
  $('fav-filtro').classList.toggle('on', soFavs)
  $('fav-filtro').setAttribute('aria-pressed', String(soFavs))
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
  // O SELO CONTA SO O QUE ESTA SAINDO AGORA, nunca o tamanho do catalogo.
  //
  // Esta e a mesma regra do inbox, e ela foi escrita la depois de um erro igual: contar tudo fazia
  // "5 funis cadastrados" virar um 5 verde na aba, e o vendedor lia como 5 disparos acontecendo.
  // Aqui so roda um funil por vez (um painel por numero), entao o selo e 1 ou nada.
  const saindo = disparando && (roteiro.sequences || []).some((s) => s.id === disparando)
  const selo = $('selo-funis')
  selo.hidden = !saindo
  selo.textContent = '1'

  if (aba === 'funis') { corpo.innerHTML = desenhaSaindo() + desenhaFunis(); ligaFunis(corpo); return }
  if (aba === 'pedidos') { corpo.innerHTML = desenhaPedidos(); ligaPedidos(corpo); return }

  const itens = visiveis()
  if (!itens.length) {
    corpo.innerHTML = '<div class="vazio">' + (soFavs
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

// FORMATAÇÃO DO WHATSAPP NO BALÃO. O inbox faz isso desde 16/09/2026, por pedido do Bruno: "texto
// que eu mando em negrito tem que aparecer em negrito aqui". Sem isto a prévia mostra os símbolos
// crus (*assim*), que é justamente o que ele mandou tirar de lá.
//
// Mesma regra do WhatsApp, pra não comer asterisco que não é marcação: o símbolo só vale colado no
// texto, o trecho não pode ser vazio e não pode atravessar linha. Escrito na mão, sem lookbehind.
const MARCAS = { '*': 'neg', _: 'ita', '~': 'ris' }
const podeAbrir = (t, i) => i === 0 || /[\s(]/.test(t[i - 1])
const podeFechar = (t, i) => i === t.length - 1 || /[\s.,!?:;)]/.test(t[i + 1])
function formatado(txt) {
  const t = String(txt == null ? '' : txt)
  let saida = ''
  let plano = ''
  const solta = () => { if (plano) { saida += esc(plano); plano = '' } }
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '`' && t.startsWith('```', i)) {
      const fim = t.indexOf('```', i + 3)
      const dentro = fim > i + 3 ? t.slice(i + 3, fim) : ''
      if (fim > i + 3 && dentro.indexOf('\n') < 0) {
        solta(); saida += '<span class="mono">' + esc(dentro) + '</span>'; i = fim + 2; continue
      }
    }
    const cls = MARCAS[c]
    if (cls && podeAbrir(t, i)) {
      let fim = -1
      for (let j = i + 2; j < t.length; j++) {
        if (t[j] === '\n') break
        if (t[j] !== c || t[j - 1] === ' ' || !podeFechar(t, j)) continue
        fim = j; break
      }
      const dentro = fim > 0 ? t.slice(i + 1, fim) : ''
      if (fim > 0 && dentro.trim()) {
        solta(); saida += '<span class="' + cls + '">' + formatado(dentro) + '</span>'; i = fim; continue
      }
    }
    plano += c
  }
  solta()
  return saida
}

function cartaoItem(x, k) {
  const ab = aberto === 'item:' + x.id
  const fav = !!favoritos[x.id]
  let prev = ''
  if (ab) {
    const corpo = x.tipo === 'text' ? (x.texto || '') : (x.caption || ('[' + TIPOS[x.tipo].rotulo.slice(0, -1).toLowerCase() + '] ' + x.label))
    prev = '<div class="prev"><div class="prev-bandeja"><div class="prev-balao">' + formatado(corpo)
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
          const pausa = pausaDoPasso(p)
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

// PAUSA EFETIVA DO PASSO: vale sim se estiver preenchido, senao delay. NUNCA soma.
//
// E a mesma conta do _pausaDoPasso do worker, e ela existe por reclamacao do Bruno em 18/08/2026:
// a tela tinha dois campos (espera e simula) e eles somavam, entao um passo de 10+10 ficava 20
// segundos parado. Aqui estava somando DE NOVO, por outro caminho: o painel dormia delay e o
// agente dormia mais sim por dentro do envio. Agora ha uma pausa so, e ela acontece com o
// "digitando..." ligado.
function pausaDoPasso(p) {
  const sim = Math.max(0, Number(p && p.sim) || 0)
  const del = Math.max(0, Number(p && p.delay) || 0)
  return sim > 0 ? sim : del
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
// ───────────────────────────────────────────────────────────── pedidos
//
// A ABA PEDIDOS (16/10/2026, pedido do Bruno). O vendedor cadastra o pedido do cliente que está na
// conversa aberta, sem sair do WhatsApp.
//
// ONDE O PEDIDO VAI PARAR, e isto foi decidido pelo Bruno em 16/10 depois de a pergunta ir pra ele
// com as três saídas na mesa: o pedido daqui CAI EM ACEITAÇÕES, igualzinho ao Novo Pedido da dash.
// Quem cria o pedido na PayLog continua sendo o botão Aceitar. Não é burocracia: a API da PayLog não
// tem idempotência nem referência externa, então o anti-dobro por CPF é NOSSO (ver a memória
// aceitar-cria-pedido-paylog) e mandar direto daqui pularia ele, a conferência dupla e a trava
// aceite_trava. Pedido duplicado lá não tem desfazer barato.
//
// O OBJETO É O MESMO que o `buildOrder` do axion-produtor/src/lib/orders.js monta. Está portado aqui
// porque o painel roda com CSP fechada e sem empacotador, então não dá pra importar. É a mesma
// situação do `despacho-paylog.js`, que tem gêmeo no worker: MEXEU NUM, MEXE NO OUTRO. Campo com
// nome diferente faz o card entrar torto no meio dos outros e ninguém percebe até o Aceitar recusar.

const IC_SALVAR = svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>')
const IC_CHECK = svg('<path d="M20 6 9 17l-5-5"/>')
const IC_X = svg('<path d="M18 6 6 18M6 6l12 12"/>')
const IC_RASC = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')
const IC_CLIPE = svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/>')
const IC_NOTA = svg('<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h6"/>')

// DOIS PASSOS, COMO NA DASH (16/10/2026, pedido do Bruno vendo a aba rodando). Primeiro o tipo de
// pagamento, nos dois cartoes verde e azul; depois o formulario. Na dash o formulario e tres
// COLUNAS; aqui a coluna e fina, entao viram tres blocos empilhados na mesma ordem e com os mesmos
// titulos: Dados do Cliente, Endereco, Tratamento e Anexo. Palavras dele: "eu gostaria de deixar o
// mais parecido possivel com o layout em que eles ja trabalham hoje".
const BLOCOS_PED = [
  {
    t: 'Dados do Cliente', bc: '#3b82f6',
    ic: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    linhas: [['cpf'], ['nome'], ['wa']],
  },
  {
    t: 'Endereço', bc: '#f59e0b',
    ic: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    linhas: [['cep'], ['end', 'num'], ['bairro', 'comp'], ['cidade', 'uf']],
  },
  {
    t: 'Tratamento e Anexo', bc: '#00a884',
    ic: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    linhas: [['trat'], ['obs']],
  },
]
const CAMPOS_PED = {
  cpf: { r: 'CPF', req: true, ph: '000.000.000-00' },
  nome: { r: 'Nome', req: true, ph: 'Nome do cliente' },
  wa: { r: 'WhatsApp', req: true, ph: '(00) 90000-0000' },
  cep: { r: 'CEP', req: true, ph: '00000-000' },
  end: { r: 'Rua', req: true, ph: 'Rua' },
  num: { r: 'Número', req: true, ph: 'Nº' },
  bairro: { r: 'Bairro', req: true, ph: 'Bairro' },
  comp: { r: 'Complemento', ph: 'Compl.' },
  cidade: { r: 'Cidade', req: true, ph: 'Cidade' },
  uf: { r: 'UF', req: true, ph: 'UF', max: 2 },
  obs: { r: 'Observações (opcional)', area: true, ph: 'Ex: Vai pagar dia 5, desconto de R$50...' },
}
const PARES = { end: 'num', bairro: 'comp', cidade: 'uf' }
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']

let ped = {}             // o que está digitado agora
let pedTipo = ''         // '' = ainda escolhendo | 'entrega' | 'antecipado'
let rascunhos = []
let rascId = 0           // > 0 = está editando um rascunho que já existe no servidor
let pedErros = []        // só preenche depois de tentar cadastrar
let pedSalvando = ''     // 'rascunho' | 'cadastro' | 'anexo'
let pedFeito = ''        // mensagem verde depois de cadastrar
let ofertas = []         // o catálogo de tratamentos, do servidor
let ofertasEstado = ''   // '' | 'carregando' | 'ok' | 'erro'
let anexos = []          // comprovantes já no R2: { nome, url, mime }
// DE QUEM E O PEDIDO: congelado no instante em que o formulario abriu, e NAO muda mais.
//
// Regra do Bruno em 16/10: "caso eu esteja na metade do processo de criar aquele pedido para aquele
// lead e eu clico em outra conversa, aquele pedido ainda assim vai ser criado pelo antigo, porque eu
// estava na conversa na qual eu iniciei o processo".
//
// E o MESMO padrao que o disparo de funil ja usa (ver o `alvo` dentro do `roda`), e aqui a
// consequencia de errar e pior: funil errado manda mensagem pra pessoa errada; pedido errado cria
// PEDIDO no nome da pessoa errada, e isso vira comissao, despacho e cobranca. Depois que o
// formulario abre, nada neste arquivo pode voltar a ler `estadoWa` pra saber de quem e o pedido.
let pedLead = null       // { chatId, phone, nome }

const dig = (v) => String(v == null ? '' : v).replace(/\D/g, '')
const mascCpf = (v) => { const c = dig(v).slice(0, 11); return c.length === 11 ? c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9) : c }
const mascCep = (v) => { const c = dig(v).slice(0, 8); return c.length === 8 ? c.slice(0, 5) + '-' + c.slice(5) : c }

// CPF de verdade, com os dois dígitos. A mesma conta do despacho-paylog.js: CPF errado só aparece
// quando a PayLog recusa, e aí o pedido já está na fila do Bruno.
function cpfValido(v) {
  const c = dig(v)
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false
  let s = 0
  for (let i = 0; i < 9; i++) s += Number(c[i]) * (10 - i)
  let d = (s * 10) % 11
  if (d === 10) d = 0
  if (d !== Number(c[9])) return false
  s = 0
  for (let i = 0; i < 10; i++) s += Number(c[i]) * (11 - i)
  d = (s * 10) % 11
  if (d === 10) d = 0
  return d === Number(c[10])
}

const emDinheiro = (n) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// O TRATAMENTO E COMPARADO PELO `key`, NUNCA PELO ROTULO. "GlicoSix - 4 Meses" e "Glico Six - 4
// Meses" sao a MESMA oferta (a Five renomeou e mudou so o espaco) e casar por nome duplica o kit.
const ofertaDe = (k) => ofertas.find((o) => String(o.key) === String(k)) || null

function confere(f) {
  const faltam = []
  for (const [k, c] of Object.entries(CAMPOS_PED)) {
    if (c.req && !String(f[k] || '').trim()) faltam.push(c.r)
  }
  if (!ofertaDe(f.tratKey)) faltam.push('Tratamento')
  if (String(f.cpf || '').trim() && !cpfValido(f.cpf)) faltam.push('CPF não confere')
  if (String(f.uf || '').trim() && !UFS.includes(String(f.uf).toUpperCase())) faltam.push('UF inválida')
  if (String(f.cep || '').trim() && dig(f.cep).length !== 8) faltam.push('CEP precisa de 8 dígitos')
  // COMPROVANTE SO E OBRIGATORIO NO PAGAMENTO NA ENTREGA, a mesma regra da dash (novo-pedido.jsx):
  // no antecipado o dinheiro ja entrou e nao ha o que comprovar.
  if (pedTipo === 'entrega' && !anexos.length) faltam.push('Comprovante (imagem, vídeo ou áudio)')
  return faltam
}

const p2 = (x) => String(x).padStart(2, '0')
const ddmm = () => { const d = new Date(); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) }
const hhmm = () => { const d = new Date(); return p2(d.getHours()) + ':' + p2(d.getMinutes()) }
const NL = String.fromCharCode(10)

// A MENSAGEM QUE O CLIENTE RECEBE fica gravada no pedido, no campo `raw`. O Cadastro de Pedidos da
// dash mostra esse campo como "mensagem enviada ao lead", e pedido nascido sem ele aparece em branco
// lá (já aconteceu, e o Bruno viu). Texto igual ao textoDadosEnvio do orders.js.
function textoPedido(o) {
  const rua = [o.end, o.num].filter(Boolean).join(', ')
  const cidUf = [o.cidade, (o.uf || '').toUpperCase()].filter(Boolean).join(' / ')
  return [
    '⭐ Pedido Concluído! ⭐', '',
    '👤 Nome: ' + (o.nome || ''),
    '📍CPF: ' + mascCpf(o.cpf),
    '📍Rua : ' + rua,
    '📍Bairro: ' + (o.bairro || ''),
    '📍Cidade e Estado: ' + cidUf,
    '📍Complemento: ' + (o.comp || ''),
    '📍CEP: ' + mascCep(o.cep || ''),
    '📲 : ' + formata(o.wa || ''), '',
    'Tratamento Referente: ' + (o.trat || o.prod || ''),
    'Valor do Pedido: R$ ' + emDinheiro(o.vl),
    'Forma de Pagamento após a Entrega',
    'Prazo de entrega de 10 a 12 dias úteis.', '',
    'Assim que o produto chegar a Equipe vai entrar em contato para enviar o meio de pagamento.',
    'Importante: Seu pedido será despachado em 10 minutos.',
  ].join(NL)
}

// O TERMO, igual ao textoTermo do orders.js. Vai ANTES do pedido concluído: o cliente confirma e
// só então o vendedor manda o resto.
function textoTermo(o) {
  const produto = String(o.prod || '').trim()
  return [
    'Declaração de Confirmação de Compra',
    'Eu, ' + (o.nome || 'o cliente') + ', portador do CPF n ' + mascCpf(o.cpf) + ', confirmo a compra do produto'
      + (produto ? ' ' + produto : '') + ', comprometendo-me a realizar o pagamento no ato do recebimento, conforme as condições acordadas.',
    '', 'Advertência',
    'Em caso de inadimplemento, estou ciente de que será aplicada uma multa de 10% sobre o valor do produto, juros de 1% ao mês, correção monetária com base no IGPM-FGV, e honorários advocatícios no percentual de 20% sobre o montante devido.',
    '', 'Data: ' + ddmm() + '/' + new Date().getFullYear(),
  ].join(NL)
}

function montaPedido(f) {
  const id = Date.now()
  const of = ofertaDe(f.tratKey) || {}
  const o = {
    id, external_id: 'MAN-' + id, orig: 'Manual',
    nome: String(f.nome || '').trim(), cpf: dig(f.cpf), wa: dig(f.wa), email: '',
    cep: dig(f.cep), end: String(f.end || '').trim(), num: String(f.num || '').trim(), comp: String(f.comp || '').trim(),
    bairro: String(f.bairro || '').trim(), cidade: String(f.cidade || '').trim(), uf: String(f.uf || '').toUpperCase().trim(),
    // PRODUTO E VALOR SAEM DO CATALOGO, nunca do que foi digitado. Preço à mão diverge do catálogo
    // e contamina receita, comissão e margem sem ninguém ver de onde veio (decisão de 14/08/2026).
    prod: String(of.prod || of.label || '').trim(), trat: String(of.label || '').trim(), vl: Number(of.price) || 0,
    // VAZIO fica VAZIO: sem taxa no pedido, a dash usa a do vendedor.
    com_pct: '',
    pgto: '', spg: 'Pendente',
    transp: '', mod: pedTipo === 'antecipado' ? 'antecipado' : 'entrega',
    // O DONO É DECIDIDO NO SERVIDOR, pelo login (handlePedidoNovo carimba o `at`). Mandar daqui
    // deixaria o painel escolhendo de quem é a venda.
    col: 'A Enviar', obs: String(f.obs || '').trim(),
    tags: [], fu: null, agend: '', track: '', link: '',
    data: ddmm(),
    hist: [{ from: '—', to: 'A Enviar', who: 'Sellwave Web', time: ddmm() + ' ' + hhmm() }],
    comments: [],
    five_status: 'pendente_despacho',
    comprovante_url: (anexos[0] && anexos[0].url) || '',
    comprovante_mime: (anexos[0] && anexos[0].mime) || '',
    comprovantes: anexos.map((a) => ({ url: a.url, mime: a.mime })),
  }
  o.raw = textoPedido(o)
  return o
}

// ─── catálogo e rascunhos ───

async function pegaOfertas() {
  if (ofertasEstado === 'carregando') return
  ofertasEstado = 'carregando'
  try {
    const r = await window.swp.tratamentos()
    ofertas = (r && r.ok && Array.isArray(r.offers)) ? r.offers : []
    ofertasEstado = ofertas.length ? 'ok' : 'erro'
  } catch (_) { ofertas = []; ofertasEstado = 'erro' }
  if (aba === 'pedidos') desenha()
}

async function pegaRascunhos() {
  if (window.__swFoto) return          // o exemplo da foto já traz a lista que ela quer retratar
  try {
    const r = await window.swp.rascunhos('')
    rascunhos = (r && r.ok && Array.isArray(r.rascunhos)) ? r.rascunhos : []
  } catch (_) { /* servidor fora: a aba ainda cadastra, só não lista rascunho */ }
  const selo = $('selo-pedidos')
  if (selo) { selo.hidden = !rascunhos.length; selo.textContent = String(rascunhos.length) }
}

const rotuloRasc = (r) => {
  const d = (r && r.dados) || {}
  return String(d.nome || '').trim() || formata(r && r.phone) || 'rascunho sem nome'
}
const detalheRasc = (r) => {
  const d = (r && r.dados) || {}
  const of = d.tratKey ? ofertaDe(d.tratKey) : null
  return [of && of.label, d.cidade].filter(Boolean).join(' · ') || 'nada preenchido ainda'
}

// ─── desenho ───

function desenhaPedidos() {
  if (estadoWa.grupo) return '<div class="vazio">Conversa de grupo.<br>O cadastro de pedido é por cliente.</div>'

  let h = ''
  if (pedFeito) h += '<div class="form"><div class="aviso bom">' + esc(pedFeito) + '</div></div>'

  // PASSO 1: o tipo de pagamento, antes de qualquer campo.
  if (!pedTipo) {
    if (!estadoWa.phone) return h + '<div class="vazio">Abra a conversa do cliente.<br>O pedido nasce com o número dela.</div>'
    h += '<div class="tipo">'
      + '<button class="tipo-cx ent" data-tipo="entrega">'
      + '<span class="ic">' + svg('<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M14 9h4l4 4v4a1 1 0 0 1-1 1h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>') + '</span>'
      + '<span><span class="t1">Pagamento na Entrega</span><span class="t2">Cliente paga ao receber o produto</span></span>'
      + '</button>'
      + '<button class="tipo-cx ant" data-tipo="antecipado">'
      + '<span class="ic">' + svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>') + '</span>'
      + '<span><span class="t1">Pagamento Antecipado</span><span class="t2">Cliente paga antes do envio</span></span>'
      + '</button>'
      + '</div>'
    if (rascunhos.length) h += '<div class="form">' + listaRascunhos() + '</div>'
    return h
  }

  // PASSO 2: o formulário.
  h += '<div class="form">'
  if (pedErros.length) {
    h += '<div class="aviso ruim">Falta preencher:<ul>'
      + pedErros.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'
  }
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">'
    + '<span class="selo-tipo ' + (pedTipo === 'entrega' ? 'ent' : 'ant') + '">'
    + (pedTipo === 'entrega' ? 'Pagamento na entrega' : 'Pagamento antecipado') + '</span>'
    + '<button class="bt sec" id="pd-voltar" style="height:26px;padding:0 9px;font-size:11px;margin-left:auto">Trocar</button>'
    + '</div>'
  // DE QUEM E O PEDIDO, sempre a vista. Com a conversa trocada na tela, esta linha e a unica coisa
  // que diz que o formulario continua sendo do cliente de antes - e e o que evita o vendedor
  // cadastrar achando que e do que esta vendo agora.
  if (pedLead) {
    const trocou = (estadoWa.phone || '') && (estadoWa.phone || '') !== pedLead.phone
    h += '<div class="dono-ped">'
      + svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')
      + '<span class="q">' + esc(pedLead.nome || formata(pedLead.phone) || 'cliente') + '</span>'
      + (trocou ? '<span class="a">a conversa mudou</span>' : '')
      + '</div>'
  }

  for (const b of BLOCOS_PED) {
    h += '<div class="bloco" style="--bc:' + b.bc + '"><h3>' + svg(b.ic) + esc(b.t) + '</h3>'
    for (const linha of b.linhas) {
      if (linha[0] === 'trat') { h += campoTratamento(); continue }
      const par = PARES[linha[0]]
      h += '<div class="cx' + (par ? ' par' : '') + (par === 'uf' ? ' uf' : '') + '">'
        + campoPed(linha[0]) + (par ? campoPed(par) : '') + '</div>'
    }
    if (b.t === 'Tratamento e Anexo') h += campoAnexo()
    h += '</div>'
  }

  const trabalhando = !!pedSalvando
  h += '<div class="acoes" style="grid-template-columns:1fr 1fr">'
    + '<button class="bt sec" id="pd-copia-dados"' + (trabalhando ? ' disabled' : '') + '>Copiar envio</button>'
    + '<button class="bt sec" id="pd-copia-termo"' + (trabalhando ? ' disabled' : '') + '>Copiar termo</button>'
    + '</div>'
  h += '<div class="acoes">'
    + '<button class="bt sec" id="pd-rasc"' + (trabalhando ? ' disabled' : '') + '>'
    + (pedSalvando === 'rascunho' ? IC_GIRA : IC_SALVAR) + 'Rascunho</button>'
    + '<button class="bt pri" id="pd-ok"' + (trabalhando ? ' disabled' : '') + '>'
    + (pedSalvando === 'cadastro' ? IC_GIRA : IC_CHECK)
    + (pedSalvando === 'anexo' ? 'Enviando anexo' : 'Cadastrar Pedido') + '</button>'
    + '</div>'
  h += '<div style="margin-top:8px;font-size:10.5px;line-height:14px;color:var(--apagado)">'
    + 'O pedido entra em Aceitações, como o da dash. Quem envia pra PayLog é o Aceitar.</div>'

  if (rascunhos.length) h += '<div style="margin-top:12px">' + listaRascunhos() + '</div>'
  return h + '</div>'
}

function listaRascunhos() {
  let h = '<div class="grp primeiro"><span>Rascunhos</span><span class="n" style="--ac:' + TIPOS.text.cor + '">' + rascunhos.length + '</span></div>'
  for (const r of rascunhos) {
    h += '<div class="rasc">'
      + '<span class="ic">' + IC_RASC + '</span>'
      + '<button class="txt" data-abre="' + esc(r.id) + '">'
      + '<div class="t1">' + esc(rotuloRasc(r)) + '</div>'
      + '<div class="t2">' + esc(detalheRasc(r)) + '</div>'
      + '</button>'
      + '<button class="x" data-apaga="' + esc(r.id) + '" title="Apagar rascunho">' + IC_X + '</button>'
      + '</div>'
  }
  return h
}

function campoPed(k) {
  const c = CAMPOS_PED[k]
  if (!c) return ''
  const erro = pedErros.length && c.req && !String(ped[k] || '').trim() ? ' erro' : ''
  const v = esc(ped[k] == null ? '' : ped[k])
  const dentro = c.area
    ? '<textarea data-k="' + k + '" placeholder="' + esc(c.ph || '') + '" spellcheck="false">' + v + '</textarea>'
    : '<input data-k="' + k + '" value="' + v + '" placeholder="' + esc(c.ph || '') + '"'
      + (c.max ? ' maxlength="' + c.max + '"' : '') + ' spellcheck="false" />'
  return '<div class="' + (erro ? 'erro' : '') + '"><label>' + esc(c.r) + '</label>' + dentro + '</div>'
}

// SO TRATAMENTO CADASTRADO, sem digitar livre, e o total e leitura. O vendedor nao escolhe preco.
function campoTratamento() {
  const erro = pedErros.length && !ofertaDe(ped.tratKey) ? ' erro' : ''
  const of = ofertaDe(ped.tratKey)
  let dentro
  if (ofertasEstado === 'ok') {
    dentro = listaPropria('trat', of ? of.label : '', 'Selecione',
      ofertas.map((o) => ({ v: o.key, r: o.label, p: 'R$ ' + emDinheiro(o.price), on: String(ped.tratKey || '') === String(o.key) })))
  } else if (ofertasEstado === 'erro') {
    dentro = listaPropria('trat', '', 'não deu pra buscar', [], true)
      + '<button class="bt sec" id="pd-retrat" style="height:28px;margin-top:6px;font-size:11px;width:100%">Tentar de novo</button>'
  } else {
    dentro = listaPropria('trat', '', 'carregando tratamentos...', [], true)
  }
  return '<div class="' + (erro ? 'erro' : '') + '"><label>Tratamento *</label>' + dentro + '</div>'
    + '<div class="total' + (of ? '' : ' vazio') + '"><span class="r">Total</span>'
    + '<span class="v">' + (of ? 'R$ ' + emDinheiro(of.price) : 'escolha o tratamento') + '</span></div>'
}

// LISTA PROPRIA NO LUGAR DO <select> (16/10: "os select ficam BRANCOS e so dao pra ler passando o
// mouse"). O <option> nativo no Windows e desenhado pelo SISTEMA e ignora o tema da pagina: o fundo
// sai branco por mais CSS que se escreva, e num painel escuro vira uma mancha ilegivel. A unica
// saida e nao usar select.
function listaPropria(id, valor, vazio, ops, travada = false) {
  let h = '<div class="sel" data-sel="' + id + '">'
    + '<button type="button" class="lista-bt" data-abrelista="' + id + '"' + (travada ? ' disabled' : '') + '>'
    + '<span class="v' + (valor ? '' : ' vazio') + '">' + esc(valor || vazio) + '</span>'
    + svg('<path d="m6 9 6 6 6-6"/>') + '</button>'
  if (!travada) {
    h += '<div class="lista-op">'
      + ops.map((o) => '<button type="button" class="' + (o.on ? 'on' : '') + '" data-op="' + id + '" data-v="' + esc(o.v) + '">'
        + esc(o.r) + (o.p ? '<span class="p">' + esc(o.p) + '</span>' : '') + '</button>').join('')
      + '</div>'
  }
  return h + '</div>'
}

function campoAnexo() {
  const obrig = pedTipo === 'entrega'
  const falta = pedErros.length && obrig && !anexos.length
  let h = '<div class="cx" style="margin-top:8px"><label' + (falta ? ' style="color:#ffb3bf"' : '') + '>'
    + 'Comprovante (imagem, vídeo ou áudio)' + (obrig ? ' *' : '') + '</label>'
  for (const a of anexos) {
    h += '<div class="anexo tem" style="margin-bottom:6px">' + IC_CHECK
      + '<span class="nm">' + esc(a.nome) + '</span>'
      + '<button class="x" data-tiraanexo="' + esc(a.url) + '" title="Tirar">' + IC_X + '</button></div>'
  }
  h += '<button class="anexo' + (falta ? '' : '') + '" id="pd-anexar"' + (pedSalvando ? ' disabled' : '') + '>'
    + (pedSalvando === 'anexo' ? IC_GIRA : IC_CLIPE)
    + '<span class="nm">' + (pedSalvando === 'anexo' ? 'enviando...' : (anexos.length ? 'Adicionar outro' : 'Clique para adicionar')) + '</span></button>'
    + '<input type="file" id="pd-arquivo" accept="image/*,video/*,audio/*" multiple hidden />'
  return h + '</div>'
}

function ligaPedidos(corpo) {
  for (const b of corpo.querySelectorAll('[data-tipo]')) {
    b.onclick = () => {
      pedTipo = b.dataset.tipo
      pedLead = { chatId: estadoWa.chatId || '', phone: estadoWa.phone || '', nome: estadoWa.nome || '' }
      pedErros = []; pedFeito = ''
      preenchePed()
      guardaNascimento()
      if (!ofertas.length) pegaOfertas()
      desenha()
    }
  }
  for (const el of corpo.querySelectorAll('[data-k]')) {
    el.oninput = () => {
      const k = el.dataset.k
      let v = el.value
      // A máscara entra só com o campo COMPLETO: mascarar no meio empurra o cursor e a pessoa
      // perde a conta do que digitou.
      if (k === 'cpf' && dig(v).length === 11) { v = mascCpf(v); el.value = v }
      if (k === 'cep' && dig(v).length === 8) { v = mascCep(v); el.value = v }
      if (k === 'uf') { v = v.toUpperCase(); el.value = v }
      ped[k] = v
      if (k === 'tratKey') desenha()      // o Total acompanha
    }
    if (el.tagName === 'SELECT') el.onchange = el.oninput
  }
  for (const b of corpo.querySelectorAll('[data-abre]')) {
    b.onclick = () => {
      const r = rascunhos.find((x) => String(x.id) === String(b.dataset.abre))
      if (!r) return
      ped = { ...(r.dados || {}) }
      pedTipo = String(ped.__tipo || 'entrega')
      anexos = Array.isArray(ped.__anexos) ? ped.__anexos : []
      // O DONO VOLTA COM ELE. Rascunho reaberto numa conversa diferente continua sendo do cliente
      // de origem - senao o congelamento valeria so ate a primeira interrupcao.
      pedLead = ped.__lead || { chatId: '', phone: r.phone || '', nome: String(ped.nome || '') }
      delete ped.__tipo; delete ped.__anexos; delete ped.__lead
      guardaNascimento()
      rascId = Number(r.id) || 0
      pedErros = []; pedFeito = ''
      if (!ofertas.length) pegaOfertas()
      desenha()
    }
  }
  for (const b of corpo.querySelectorAll('[data-apaga]')) {
    b.onclick = async () => {
      const id = b.dataset.apaga
      try { await window.swp.rascunhoApagar(id) } catch (_) { /* some da lista no próximo pulso */ }
      if (String(rascId) === String(id)) rascId = 0
      await pegaRascunhos()
      desenha()
    }
  }
  for (const b of corpo.querySelectorAll('[data-tiraanexo]')) {
    b.onclick = () => { anexos = anexos.filter((a) => a.url !== b.dataset.tiraanexo); desenha() }
  }
  for (const b of corpo.querySelectorAll('[data-abrelista]')) {
    b.onclick = (ev) => {
      ev.stopPropagation()
      const cx = b.closest('.sel')
      const abrindo = !cx.classList.contains('aberta')
      for (const o of corpo.querySelectorAll('.sel')) o.classList.remove('aberta')
      if (abrindo) cx.classList.add('aberta')
    }
  }
  for (const b of corpo.querySelectorAll('[data-op]')) {
    b.onclick = (ev) => {
      ev.stopPropagation()
      if (b.dataset.op === 'trat') ped.tratKey = b.dataset.v
      desenha()
    }
  }
  // Clicar FORA fecha. Sem isto a lista fica aberta por cima dos campos de baixo e o vendedor tem
  // que clicar no proprio botao de novo pra enxergar o que esta embaixo.
  corpo.onclick = () => { for (const o of corpo.querySelectorAll('.sel.aberta')) o.classList.remove('aberta') }

  const liga = (id, fn) => { const e = $(id); if (e) e.onclick = fn }
  // VOLTAR guarda o que estava pela metade antes de sair. E o caminho que ele descreveu pra
  // comecar um pedido novo: "clico em Voltar (...) aquele vai ficar salvo como rascunho".
  liga('pd-voltar', async () => {
    await rascunhoSozinho()
    pedTipo = ''; pedLead = null; ped = {}; anexos = []; rascId = 0; pedErros = []
    preenchePed()
    guardaNascimento()
    desenha()
  })
  liga('pd-rasc', salvaRascunho)
  liga('pd-ok', cadastraPedido)
  liga('pd-retrat', () => { ofertasEstado = ''; pegaOfertas(); desenha() })
  liga('pd-anexar', () => { const i = $('pd-arquivo'); if (i) i.click() })
  liga('pd-copia-dados', () => copia(textoPedido(montaPedido(ped)), 'Dados de envio copiados'))
  liga('pd-copia-termo', () => copia(textoTermo(montaPedido(ped)), 'Termo copiado'))
  const inp = $('pd-arquivo')
  if (inp) inp.onchange = () => subirAnexos([...(inp.files || [])])
}

function copia(txt, aviso) {
  try { navigator.clipboard.writeText(txt); rodape(aviso) }
  catch (_) { rodape('não deu pra copiar') }
}

// O ARQUIVO SOBE NA HORA DE ANEXAR, não no clique de cadastrar. É a mesma escolha da dash, e o
// motivo está na memória: vídeo de 3 a 9 MB em 60% dos pedidos, e subir só no fim deixa o vendedor
// olhando "Salvando..." parado achando que travou.
async function subirAnexos(arquivos) {
  if (!arquivos.length || pedSalvando) return
  pedSalvando = 'anexo'; desenha()
  for (const f of arquivos) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const r = await window.swp.comprovante(f.name || 'comprovante', f.type || '', bytes, '')
      if (r && r.ok && r.url) anexos.push({ nome: f.name || 'comprovante', url: r.url, mime: r.mime || f.type || '' })
      else pedErros = [humano((r && r.erro) || 'não deu pra subir o anexo')]
    } catch (e) { pedErros = [humano((e && e.message) || 'não deu pra subir o anexo')] }
  }
  pedSalvando = ''; desenha()
}

// GRAVA SOZINHO AO SAIR (16/10, pedido dele: "rascunho gravado sozinho ao trocar de aba ou de
// conversa"). Nao avisa nada na tela: aviso a cada troca de conversa seria pior que o problema.
// So grava se houver algo ALEM do que entrou sozinho - nome e telefone vem preenchidos da conversa,
// entao rascunho com so os dois e um rascunho vazio, e encheria a lista de lixo.
let gravandoSozinho = false
// COMO ELE NASCEU, pra saber se o vendedor mexeu em alguma coisa.
//
// A primeira versao disto era uma LISTA DE EXCECAO ("ignore nome e wa porque entram sozinhos da
// conversa"). Lista de excecao envelhece: no dia em que o preenchimento automatico crescer - cidade
// pelo DDD, por exemplo - alguem esquece de somar o campo novo e volta a gravar rascunho vazio, e
// o defeito aparece semanas depois como lixo na lista do vendedor.
//
// Guardando a FOTO do formulario no instante em que ele nasceu, o criterio deixa de ser "quais
// campos nao contam" e passa a ser a pergunta que de fato interessa: mudou alguma coisa? O
// preenchimento automatico pode crescer a vontade, porque o que ele escrever entra na foto junto.
//
// A foto e tirada DEPOIS do preenchimento automatico, e compara o valor ja aparado: mascara de CPF
// e de CEP so rodam quando a pessoa digita, mas comparar texto cru deixaria uma diferenca de espaco
// virar "mexeu".
let nasceuAssim = ''
const fotoDoForm = () => JSON.stringify(Object.keys(ped).sort().map((k) => k + '=' + String(ped[k] == null ? '' : ped[k]).trim()))
const guardaNascimento = () => { nasceuAssim = fotoDoForm() }
function temConteudo() { return fotoDoForm() !== nasceuAssim || anexos.length > 0 }
async function rascunhoSozinho() {
  if (gravandoSozinho || pedSalvando || !pedTipo || !temConteudo()) return
  gravandoSozinho = true
  try {
    const dados = { ...ped, __tipo: pedTipo, __anexos: anexos, __lead: pedLead }
    const r = await window.swp.rascunhoSalvar(rascId || 0, (pedLead && pedLead.phone) || '', dados)
    if (r && r.ok && Number(r.id)) rascId = Number(r.id)
    await pegaRascunhos()
    if (aba === 'pedidos') desenha()
  } catch (_) { /* fica na tela do mesmo jeito; a proxima saida tenta de novo */ }
  finally { gravandoSozinho = false }
}

async function salvaRascunho() {
  if (pedSalvando) return
  pedSalvando = 'rascunho'; pedFeito = ''; desenha()
  try {
    // O tipo e os anexos viajam DENTRO do rascunho: sem eles, reabrir cairia no passo do tipo com os
    // campos preenchidos e o comprovante perdido.
    const dados = { ...ped, __tipo: pedTipo, __anexos: anexos, __lead: pedLead }
    const r = await window.swp.rascunhoSalvar(rascId || 0, (pedLead && pedLead.phone) || estadoWa.phone || '', dados)
    if (r && r.ok) { rascId = Number(r.id) || rascId; pedFeito = 'Rascunho guardado.' }
    await pegaRascunhos()
  } catch (_) {
    pedErros = ['Não deu pra guardar o rascunho agora. O que você digitou continua na tela.']
  } finally { pedSalvando = ''; desenha() }
}

async function cadastraPedido() {
  if (pedSalvando) return
  const faltam = confere(ped)
  if (faltam.length) { pedErros = faltam; pedFeito = ''; desenha(); return }
  pedSalvando = 'cadastro'; pedErros = []; pedFeito = ''; desenha()
  try {
    const r = await window.swp.pedidoNovo(montaPedido(ped))
    if (r && r.ok) {
      // `ja` = o servidor reconheceu que este pedido já tinha entrado. Dizer "cadastrado" de novo
      // faria o vendedor achar que criou dois.
      pedFeito = r.ja ? 'Esse pedido já estava cadastrado.' : 'Pedido cadastrado. Está em Aceitações.'
      if (rascId) { try { await window.swp.rascunhoApagar(rascId) } catch (_) { /* some sozinho depois */ } }
      ped = {}; rascId = 0; anexos = []; pedTipo = ''
      preenchePed()
      guardaNascimento()
      await pegaRascunhos()
    } else {
      pedErros = [humano((r && r.erro) || 'não deu pra cadastrar')]
    }
  } catch (e) {
    pedErros = [humano((e && e.message) || 'não deu pra falar com a dash')]
  } finally { pedSalvando = ''; desenha() }
}

// O que já se sabe do cliente entra sozinho: o número vem da conversa aberta e o nome vem do que o
// WhatsApp mostra. É a prévia dos dados do cliente que o Bruno pediu.
let fonePreenchido = ''
function preenchePed() {
  const de = pedLead || estadoWa
  const fone = de.phone || ''
  if (!fone) return
  if (!ped.wa) ped.wa = formata(fone)
  if (!ped.nome && de.nome) ped.nome = de.nome
}

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

// `pausa` e em SEGUNDOS e ja vem resolvida (uma so). Clique avulso nao tem passo, entao usa um
// valor curto de cortesia: 2 s digitando no texto, 3 s gravando no audio.
function itemParaEnvio(id, pausa) {
  const m = achaMsg(id)
  if (m) return { tipo: 'texto', texto: m.text || '', pausa: pausa == null ? 2 : pausa }
  const md = achaMidia(id)
  if (md) return { tipo: 'midia', kind: md.kind, url: roteiro.mediaBase + md.key, caption: md.caption || '', label: md.label || '', pausa: pausa == null ? (md.kind === 'audio' ? 3 : 0) : pausa }
  return null
}

async function disparaItem(id) {
  const it = itemParaEnvio(id)
  if (!it) { rodape('não achei esse item no roteiro'); return }
  await roda([it], id, it.label || 'item avulso')
}

async function disparaFunil(id) {
  const s = (roteiro.sequences || []).find((x) => x.id === id)
  if (!s) return
  const lista = []
  for (const p of (s.items || [])) {
    const it = itemParaEnvio(p.id || p, pausaDoPasso(p))
    if (it) lista.push(it)
  }
  if (!lista.length) { rodape('funil sem passos'); return }
  await roda(lista, id, s.label || s.nome || 'funil')
}

async function roda(lista, marca, rotulo = '') {
  if (ocupado) return
  if (!estadoWa.chatId) { rodape('abra uma conversa primeiro'); return }
  if (!estadoWa.envia) { rodape('o motor do WhatsApp não está pronto'); return }

  // TRAVA O ALVO NO CLIQUE. Se o vendedor trocar de conversa no meio do funil, o resto tem que ir
  // pra quem ele mandou, não pra quem está na tela agora.
  const alvo = estadoWa.chatId
  const alvoNk = estadoWa.nk || ''
  // DE QUEM E O DISPARO. O painel e um so pra todos os numeros: sem carimbar, o vendedor trocava
  // de numero no meio do funil, via o lead NOVO no topo, o rodape dizendo "enviando 3 de 5" e todos
  // os botoes cinzas - e lia como "estou disparando pro numero errado e travou".
  alvoFone = estadoWa.phone ? formata(estadoWa.phone) : ''
  alvoNome = estadoWa.nome || ''
  alvoNkAtual = alvoNk
  ocupado = true
  disparando = marca
  pararPedido = false
  // A hibernacao por memoria nao pode fechar quem esta disparando no meio do funil. E o MESMO
  // aviso alimenta a faixa "saindo agora": sem mandar o rotulo, o passo e o alvo, o registro do
  // processo principal fica com o padrao e a faixa diz literalmente "funil" no lugar do nome.
  const avisa = (passo) => {
    try { window.swp.disparo(alvoNk, true, { funil: rotulo, passo, total: lista.length, alvo: estadoWa.phone || '', inicio: Date.now() }) }
    catch (_) { /* a faixa some, o disparo continua */ }
  }
  avisa(0)
  desenha()
  $('parar').style.display = lista.length > 1 ? 'inline' : 'none'

  for (let i = 0; i < lista.length; i++) {
    if (pararPedido) { rodape('parado no item ' + (i + 1) + ' de ' + lista.length, null, true); break }
    const it = lista[i]
    const de = lista.length > 1 ? ' ' + (i + 1) + ' de ' + lista.length : ''
    avisa(i + 1)
    const pct = lista.length > 1 ? (i + 1) / lista.length : null
    // A PAUSA ACONTECE AQUI, com o "digitando..." ligado na conversa, e EM FATIAS: assim o botao
    // Parar responde no meio de uma pausa longa em vez de so depois do item.
    //
    // O TETO DE 120 SEGUNDOS e o mesmo do _dorme no worker. Um passo com pausa absurda (dedo
    // escorregado no cadastro) travava o funil sem nada na tela explicando o que estava havendo.
    const pausa = Math.min(120, Math.max(0, Number(it.pausa) || 0))
    if (pausa > 0) {
      const audio = it.kind === 'audio'
      // O rodape diz a VERDADE do momento. Dizer "enviando" durante a pausa fazia o vendedor achar
      // que tinha travado, porque nada aparecia na conversa por dez segundos.
      rodape((audio ? 'gravando' : 'digitando') + de + paraQuem(), pct)
      await window.swp.indica(alvoNk, alvo, audio ? 'audio' : 'texto', pausa)
      const fim = Date.now() + pausa * 1000
      while (Date.now() < fim && !pararPedido) await new Promise((r) => setTimeout(r, 200))
    }
    if (pararPedido) { rodape('parado em ' + (i + 1) + ' de ' + lista.length); break }
    rodape((lista.length > 1 ? 'enviando' + de : 'enviando') + paraQuem() + (lista.length > 1 ? '' : '...'), pct)
    const r = await window.swp.manda(alvoNk, alvo, it)
    if (!r || !r.ok) {
      ocupado = false; disparando = ''; alvoNkAtual = ''; $('parar').style.display = 'none'
      try { window.swp.disparo(alvoNk, false) } catch (_) { /* ok */ }
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
  alvoNkAtual = ''
  try { window.swp.disparo(alvoNk, false) } catch (_) { /* ok */ }
  $('parar').style.display = 'none'
  if (!pararPedido) rodape('enviado' + (alvoNome || alvoFone ? ' para ' + (alvoNome || alvoFone) : ''))
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

// O BLOCO DO CLIENTE NÃO TEM BOTÃO DE PEDIDO (16/10/2026). Nasceu com um, e o Bruno mandou tirar
// no mesmo dia: "gostaria que não tivesse esse botãozinho de Pedido, que o pedido só fosse feito na
// hora que clicar na área de Pedidos". Uma porta por função; a aba já é a porta.
const botaoCadastro = () => ''

// Troca pra uma aba de fora dela (o clique no botão do lead). Mexe no mesmo lugar que o clique na
// aba mexeria, pra as duas entradas não divergirem.
function vaiPara(nome) {
  if (aba === 'pedidos' && nome !== 'pedidos') rascunhoSozinho()
  aba = nome
  for (const o of document.querySelectorAll('.aba')) o.classList.toggle('on', o.dataset.aba === nome)
  aberto = ''
  desenha()
}

async function atualizaLead() {
  const fone = estadoWa.phone
  if (!fone) {
    // GRUPO NAO E "NENHUMA CONVERSA". Com o grupo da equipe aberto, o painel escrevia "Abra uma
    // conversa" com uma conversa na tela e todo botao cinza: a leitura natural e que o painel
    // quebrou, nao que existe uma regra. A regra continua: disparo nao vai pra grupo.
    const chave = estadoWa.grupo ? 'grupo' : ''
    if (ultimoFone !== chave) {
      ultimoFone = chave
      $('lead').innerHTML = estadoWa.grupo
        ? '<div class="nm">Conversa de grupo</div><div class="ln">o painel não dispara em grupo</div>'
        : '<div class="nm">Abra uma conversa</div><div class="ln">o painel segue quem está na tela</div>'
    }
    return
  }
  if (fone === ultimoFone) return
  ultimoFone = fone
  const cabecalho = esc(estadoWa.nome || formata(fone))
  $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div><div class="ln">procurando na dash...</div>' + botaoCadastro()
  ligaBotaoCadastro()
  // LID NAO RESOLVIDO: os digitos nao sao telefone nenhum. Procurar lead com eles sempre devolve
  // vazio, e a tela diria "sem pedido na dash" pra um cliente que pode ter tres pedidos.
  if (estadoWa.lid) {
    $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div>'
      + '<div class="ln">conversa sem número visível, não dá pra procurar o pedido</div>'
    return
  }
  const d = await window.swp.lead(fone)
  if (estadoWa.phone !== fone) return    // trocou de conversa no meio da busca
  // NAO FALEI COM A DASH e diferente de NAO ACHEI. Dizer "sem pedido" quando a dash caiu faz o
  // vendedor atender como lead novo um cliente que tem tres pedidos. E solta o `ultimoFone` pra
  // tentar de novo no proximo pulso, senao a linha mente ate ele trocar de conversa e voltar.
  if (d && d.ok === false) {
    ultimoFone = ''
    $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div><div class="ln">' + esc(formata(fone))
      + ' · ' + esc(humano(d.erro || 'não deu pra falar com a dash')) + '</div>' + botaoCadastro()
    ligaBotaoCadastro()
    return
  }
  if (!d || !d.achou) {
    $('lead').innerHTML = '<div class="nm">' + cabecalho + '</div><div class="ln">' + esc(formata(fone)) + ' · sem pedido na dash</div>' + botaoCadastro()
    ligaBotaoCadastro()
    return
  }
  const linha = [d.produto, d.cidade ? d.cidade + '/' + d.uf : ''].filter(Boolean).join(' · ')
  $('lead').innerHTML = '<div class="nm">' + esc(d.nome || cabecalho) + '</div>'
    + '<div class="ln">' + esc(linha || formata(fone)) + '</div>'
    + (d.etapa ? '<span class="tag">' + esc(d.etapa) + (d.pedidos > 1 ? ' · ' + d.pedidos + ' pedidos' : '') + '</span>' : '')
    + botaoCadastro()
  ligaBotaoCadastro()
}

function ligaBotaoCadastro() { /* o bloco do lead não tem mais botão; ver botaoCadastro */ }

// ───────────────────────────────────────────────────────────── ciclo

let podiaEnviar = false
let ultimaTentativa = 0
async function pulso() {
  // MODO FOTO: nao rele nada (16/10/2026). O foto.js injeta um estado de exemplo pra retratar o
  // painel cheio, e o pulso de 1,5s trocava ele pelo estado real antes da foto sair. O apelido
  // __swPulso ja existia pra parar o intervalo, mas parar o intervalo nao basta: a aba Pedidos
  // tambem redesenha na troca de conversa e a pilha redesenha quando o processo principal avisa.
  if (window.__swFoto) return
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
  // FUNIL NOUTRO NUMERO. Sem esta linha, trocar de numero no meio do funil deixava todos os botoes
  // cinzas sem nenhuma explicacao: o vendedor le como painel travado.
  else if (alvoNkAtual && estadoWa.nk && alvoNkAtual !== estadoWa.nk) $('rod').title = 'O funil está rodando em outro número'
  // Só redesenha quando o botão de enviar muda de estado: redesenhar a cada pulso apagaria a
  // seleção de texto e piscaria a lista.
  const agora = podeEnviar()
  // REDESENHAR COM A ABA PEDIDOS ABERTA APAGA O QUE O VENDEDOR ESTÁ DIGITANDO. O formulário guarda
  // o valor em `ped` a cada tecla, mas o redesenho recria os campos e leva junto o cursor e a
  // seleção. Como ali não existe botão de enviar pra habilitar, não há nada a redesenhar mesmo.
  if (agora !== podiaEnviar) { podiaEnviar = agora; if (aba !== 'pedidos') desenha() }
  // TROCOU DE CONVERSA. Com o formulario ABERTO, o pedido continua sendo do lead congelado e nada
  // aqui o toca: o que acontece e que o rascunho e gravado sozinho, pra o trabalho nao se perder se
  // ele nao voltar. Sem formulario aberto, a previa do proximo pedido acompanha a conversa.
  if (estadoWa.phone !== fonePreenchido) {
    fonePreenchido = estadoWa.phone || ''
    if (pedTipo) { rascunhoSozinho() } else { preenchePed() }
    if (aba === 'pedidos') desenha()
  }
  // Roteiro vazio: tenta de novo de vez em quando (o login pode ter acontecido depois do boot).
  if (roteiroVazio() && Date.now() - ultimaTentativa > 15000) { ultimaTentativa = Date.now(); pegaRoteiro() }
  await atualizaLead()
}

for (const b of document.querySelectorAll('.aba')) b.onclick = () => vaiPara(b.dataset.aba)
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenha() }
$('fav-filtro').onclick = () => { soFavs = !soFavs; desenha() }

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
// Os rascunhos entram no selo da aba sem o vendedor precisar abrir ela. Falha em silencio: sem
// rascunho a aba continua cadastrando normalmente.
pegaRascunhos().then(() => { if (aba === 'pedidos') desenha() })
// O processo principal AVISA quando um disparo comeca ou termina, entao a tela nao precisa ficar
// perguntando. A leitura de boot existe pro caso de o painel abrir com um funil ja rodando.
pegaDisparos()
if (window.swp.aoMudarDisparos) window.swp.aoMudarDisparos(() => { pegaDisparos() })

// O apelido existe pro MODO FOTO congelar a tela: sem isso o pulso sobrescreve o exemplo
// 1,5 s depois e a foto sai sempre com o estado vazio.
window.__swPulso = setInterval(pulso, 1500)
pulso()
