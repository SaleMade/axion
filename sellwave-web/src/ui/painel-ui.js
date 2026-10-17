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

// ENVIAR NAO DEPENDE MAIS DE ESTAR LIVRE. Com fila, clicar durante um disparo e o caminho normal:
// o segundo entra atras do primeiro. Antes isso deixava todos os botoes cinzas e parecia travado.
const podeEnviar = () => !!(estadoWa.envia && estadoWa.chatId)

// ───────────────────────────────────────────────────────────── desenho

// A PILHA SAI DA FILA, nao de uma leitura do processo principal. O painel e um so pra todos os
// numeros, entao a fila daqui JA E tudo que esta saindo - e ela muda na hora, sem esperar aviso.
// O desenho e o do PilhaEnvios do chat.jsx no modo integrado, que e o que ele ja le no inbox.
function desenhaSaindo() {
  if (!fila.length) return ''
  const rodando = fila.filter((j) => j.rodando).length
  const n = fila.length
  let h = '<div class="saindo">'
    + '<div class="cab">' + (rodando ? '<span class="roda"></span>' : '<span class="pt-fila"></span>')
    + '<span class="t">Enviando ' + (n > 1 ? 'funis' : 'funil') + ' · ' + n + '</span></div>'
  for (const j of fila) {
    const total = j.lista.length
    const passo = Math.max(1, Math.min(total, j.passo || 1))
    h += '<div class="item-env">'
      + (j.rodando ? '<span class="roda"></span>' : '<span class="pt-fila"></span>')
      + '<div class="txt">'
      + '<div class="l1"><span class="rot">Funil:</span> ' + esc(j.rotulo)
      + (j.nome || j.fone ? '<span class="para"> &rarr; ' + esc(j.nome || formata(j.fone)) + '</span>' : '') + '</div>'
      + '<div class="l2">' + (j.rodando
        ? 'Enviando passo ' + passo + ' de ' + total
        : 'Na fila · próximo: passo 1 de ' + total) + '</div>'
      + '</div>'
      // TIRAR DA FILA: no que esta rodando, para; no que espera, some sem enviar. Sem isto, mandar
      // um funil pro lead errado so se desfazia esperando ele sair inteiro.
      + '<button class="x" data-tirafila="' + j.id + '" title="' + (j.rodando ? 'Parar este' : 'Tirar da fila') + '">' + IC_X + '</button>'
      + '</div>'
  }
  return h + '</div>'
}

// O x da faixa existe nas duas abas que a desenham, entao o clique mora numa funcao so.
function ligaFaixa(corpo) {
  for (const b of corpo.querySelectorAll('[data-tirafila]')) {
    b.onclick = () => {
      const id = Number(b.dataset.tirafila)
      const j = fila.find((x) => x.id === id)
      if (!j) return
      if (j.rodando) {
        pararPedido = true
        try { window.swp.parar(j.nk, true) } catch (_) { /* o laco para do mesmo jeito */ }
      } else {
        fila = fila.filter((x) => x.id !== id)
        desenha()
      }
    }
  }
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
  // O SELO CONTA QUANTOS FUNIS ESTAO NA FILA, nao o tamanho do catalogo (a mesma regra do inbox,
  // escrita la depois do mesmo erro: "5 funis cadastrados" virava um 5 verde e o vendedor lia como
  // 5 disparos acontecendo). Agora pode ser mais de 1 de verdade, porque existe fila.
  const nFunis = fila.filter((j) => (roteiro.sequences || []).some((x) => x.id === j.marca)).length
  const selo = $('selo-funis')
  selo.hidden = !nFunis
  selo.textContent = String(nFunis)

  if (aba === 'funis') {
    corpo.innerHTML = desenhaSaindo() + desenhaFunis()
    ligaFunis(corpo)
    ligaFaixa(corpo)
    return
  }
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

// O ENDERECO DA MIDIA PRA PREVIA. O processo principal resolve `swmedia://arq/<chave>` buscando no
// mesmo lugar de onde o envio puxa (ver main.js). A pagina nao fala com a rede: ela so pede ao app.
const urlMidia = (chave) => 'swmedia://arq/' + encodeURIComponent(String(chave || ''))

// A PREVIA MOSTRA A MIDIA, NAO O ROTULO DELA (16/10/2026, pedido do Bruno: "quando eu cliquei no
// video deveria aparecer o video, parece apenas uma mensagem"). Antes, foto, video e documento
// viravam todos o mesmo balao de texto escrito "[imagem] Formula" - o vendedor nao tinha como
// conferir o que ia disparar antes de disparar, que e exatamente pra isso que a previa existe.
//
// O DOCUMENTO NAO ABRE AQUI DENTRO de proposito: PDF dentro do painel precisaria de visualizador
// embutido e de mais um furo na CSP, pra uma coisa que o vendedor olha uma vez. Ele mostra o nome e
// abre no programa do Windows, que ja sabe ler PDF.
function corpoDaPrevia(x) {
  const legenda = String(x.caption || '').trim()
  const rodape = '<span class="prev-hora">agora</span>'
  const cap = legenda ? '<div class="prev-cap">' + formatado(legenda) + '</div>' : ''
  if (x.tipo === 'image') {
    return '<div class="prev-balao midia"><img class="prev-img" src="' + esc(urlMidia(x.key)) + '" alt="' + esc(x.label) + '">' + cap + rodape + '</div>'
  }
  if (x.tipo === 'video') {
    return '<div class="prev-balao midia"><video class="prev-vid" src="' + esc(urlMidia(x.key)) + '" controls preload="metadata"></video>' + cap + rodape + '</div>'
  }
  if (x.tipo === 'audio') {
    return '<div class="prev-balao midia audio"><audio class="prev-aud" src="' + esc(urlMidia(x.key)) + '" controls preload="metadata"></audio>' + cap + rodape + '</div>'
  }
  if (x.tipo === 'document') {
    return '<div class="prev-balao midia doc">'
      + '<button class="prev-doc" data-abredoc="' + esc(x.key) + '" title="Abrir no computador">'
      + svg(TIPOS.document.ic) + '<span>' + esc(x.label) + '</span></button>' + cap + rodape + '</div>'
  }
  return '<div class="prev-balao">' + formatado(x.texto || '') + rodape + '</div>'
}

function cartaoItem(x, k) {
  const ab = aberto === 'item:' + x.id
  const fav = !!favoritos[x.id]
  let prev = ''
  if (ab) {
    prev = '<div class="prev"><div class="prev-bandeja">' + corpoDaPrevia(x) + '</div></div>'
  }
  return '<div class="item" style="--kc:' + k.cor + '">'
    + '<div class="item-linha">'
    + '<span class="item-ic">' + svg(k.ic) + '</span>'
    + '<button class="item-lbl" data-abre="item:' + esc(x.id) + '">' + esc(x.label) + '</button>'
    + '<button class="estrela' + (fav ? ' on' : '') + '" data-fav="' + esc(x.id) + '" title="Favorito">' + IC_ESTRELA(fav) + '</button>'
    + '<button class="enviar" data-envia="' + esc(x.id) + '" title="Enviar"' + (podeEnviar() ? '' : ' disabled') + '>'
    + IC_PLAY + '</button>'
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
        + IC_PLAY + '</button>'
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
  // O documento abre no programa do Windows, nao dentro do painel: PDF embutido pediria
  // visualizador e mais um furo na CSP, pra uma coisa que o vendedor olha uma vez.
  for (const b of corpo.querySelectorAll('[data-abredoc]')) {
    b.onclick = async () => {
      try { await window.swp.abrirMidia(b.dataset.abredoc) }
      catch (_) { rodape('não consegui abrir o arquivo', null, true) }
    }
  }
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
let rascId = ''          // vazio = ainda nao existe no servidor; o id vem de la no 1o save
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
  // AS MESMAS DUAS REGRAS DO ACEITAR (problemasPaylog no despacho-paylog.js). Sem elas, o vendedor
  // fechava a venda, cadastrava, lia "Pedido cadastrado" e o pedido so era recusado DEPOIS, no
  // Aceitar do Bruno, com o cliente ja esperando. Barrar aqui custa 10 segundos de digitacao;
  // barrar la custa um pedido parado na fila e um vendedor que nao sabe que parou.
  //
  // Nome: a PayLog exige nome e sobrenome. "Maria" sozinho e recusado.
  const _nome = String(f.nome || '').trim().replace(/\s+/g, ' ')
  if (_nome && _nome.split(' ').filter((x) => x.length > 1).length < 2) faltam.push('Nome e sobrenome do cliente')
  // Telefone: 10 ou 11 digitos depois de tirar o 55. Numero cortado passava daqui direto.
  let _tel = dig(f.wa)
  if (_tel.length >= 12 && _tel.startsWith('55')) _tel = _tel.slice(2)
  if (String(f.wa || '').trim() && (_tel.length < 10 || _tel.length > 11)) faltam.push('WhatsApp incompleto (DDD + número)')
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

// O ID DO PEDIDO NASCE UMA VEZ E SOBREVIVE A TENTATIVA QUE FALHOU (16/10/2026, auditoria).
//
// O `montaPedido` sorteava `Date.now()` a cada chamada, entao cada clique em Cadastrar criava um id
// NOVO - e o anti-duplicata do servidor casa por id. Com a rede engasgando (4G, 52x do Cloudflare,
// ou o tempo limite de 30s estourando numa gravacao que JA tinha sido feita), o vendedor via "nao
// deu pra falar com a dash" com o formulario intacto, clicava de novo e o resultado eram DOIS cards
// do mesmo pedido - dois pedidos na PayLog, duas cobrancas, dois frascos despachados.
// Agora o id e o mesmo enquanto o formulario for o mesmo: a segunda tentativa cai no `ja: true` do
// servidor e o vendedor le "Esse pedido ja estava cadastrado".
let pedIdFixo = 0
function montaPedido(f) {
  const id = pedIdFixo || Date.now()
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
    // O TITULO DA CAIXA TEM QUE DIZER A VERDADE (16/10/2026, auditoria). Era sempre "Falta
    // preencher:", inclusive pra erro de rede e pra a trava de dono - o vendedor lia "Falta
    // preencher: nao deu pra falar com a dash" e ia cacar campo vazio em vez de tentar de novo.
    // Pior na trava mais importante do app ("Este pedido e de Fulano"), que vira um pedido de
    // confirmacao e nao um campo faltando.
    const _soCampos = pedErros.every((x) => !/n[aã]o deu|servidor|dash|rede|internet|Este pedido é de|PayLog/i.test(String(x)))
    h += '<div class="aviso ruim">' + (_soCampos ? 'Falta preencher:' : 'Confira antes de cadastrar:') + '<ul>'
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
    const agora = estadoWa.nome || formata(estadoWa.phone || '') || 'o cliente de agora'
    h += '<div class="dono-ped' + (trocou ? ' trocou' : '') + '">'
      + '<div class="l">'
      + svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')
      + '<span class="q">' + esc(pedLead.nome || formata(pedLead.phone) || 'cliente') + '</span>'
      + (trocou ? '<span class="a">a conversa mudou</span>' : '')
      + '</div>'
      // O BOTAO SO EXISTE QUANDO HA PRA ONDE IR. Fora da troca ele seria um jeito de zerar o
      // formulario sem querer.
      + (trocou
        ? '<button class="bt-troca" id="pd-troca"' + (pedSalvando ? ' disabled' : '') + '>'
          + svg('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>')
          + '<span>Trocar para ' + esc(agora) + '</span></button>'
        : '')
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
      pedLead = { chatId: estadoWa.chatId || '', phone: estadoWa.phone || '', nome: '' }
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
      pedIdFixo = 0                       // rascunho reaberto e outra tentativa
      pedTipo = String(ped.__tipo || 'entrega')
      anexos = Array.isArray(ped.__anexos) ? ped.__anexos : []
      // O DONO VOLTA COM ELE. Rascunho reaberto numa conversa diferente continua sendo do cliente
      // de origem - senao o congelamento valeria so ate a primeira interrupcao.
      // Aqui o nome vem do que o VENDEDOR digitou no rascunho, nao do titulo da conversa: esse e
      // o unico nome em que da pra confiar, e e o que o pedido vai levar.
      pedLead = ped.__lead || { chatId: '', phone: r.phone || '', nome: String(ped.nome || '') }
      delete ped.__tipo; delete ped.__anexos; delete ped.__lead
      guardaNascimento()
      rascId = String(r.id || '')
      pedErros = []; pedFeito = ''
      if (!ofertas.length) pegaOfertas()
      desenha()
    }
  }
  for (const b of corpo.querySelectorAll('[data-apaga]')) {
    b.onclick = async () => {
      const id = b.dataset.apaga
      try { await window.swp.rascunhoApagar(id) } catch (_) { /* some da lista no próximo pulso */ }
      if (String(rascId) === String(id)) rascId = ''
      await pegaRascunhos()
      desenha()
    }
  }
  for (const b of corpo.querySelectorAll('[data-tiraanexo]')) {
    b.onclick = () => { anexos = anexos.filter((a) => a.url !== b.dataset.tiraanexo); desenha() }
  }
  for (const b of corpo.querySelectorAll('[data-tirafila]')) {
    b.onclick = () => {
      const id = Number(b.dataset.tirafila)
      const j = fila.find((x) => x.id === id)
      if (!j) return
      if (j.rodando) {
        pararPedido = true
        try { window.swp.parar(j.nk, true) } catch (_) { /* o laco para do mesmo jeito */ }
      } else {
        fila = fila.filter((x) => x.id !== id)
        desenha()
      }
    }
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
    pedTipo = ''; pedLead = null; ped = {}; anexos = []; rascId = ''; pedErros = []; pedIdFixo = 0
    preenchePed()
    guardaNascimento()
    desenha()
  })
  liga('pd-troca', trocaDeLead)
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
let trocandoLead = false
let nasceuAssim = ''
const fotoDoForm = () => JSON.stringify(Object.keys(ped).sort().map((k) => k + '=' + String(ped[k] == null ? '' : ped[k]).trim()))
// O nascimento tambem zera a confirmacao da troca: formulario novo, medo novo.
const guardaNascimento = () => { nasceuAssim = fotoDoForm(); confirmouOutro = false }
function temConteudo() { return fotoDoForm() !== nasceuAssim || anexos.length > 0 }
// DEVOLVE A GRAVACAO EM VOO EM VEZ DE DESISTIR (16/10/2026). Antes, `gravandoSozinho` fazia a
// funcao VOLTAR NA HORA sem gravar nada se ja houvesse uma salvando. Pro pulso tanto faz, mas o
// botao de trocar de cliente faz `await rascunhoSozinho()` e limpa a tela logo depois: cair nesse
// desistir silencioso jogaria fora o que o vendedor digitou. Agora quem chega no meio ESPERA.
let gravandoAgora = null
function rascunhoSozinho() {
  if (gravandoAgora) return gravandoAgora
  if (pedSalvando || !pedTipo || !temConteudo()) return Promise.resolve(false)
  gravandoAgora = (async () => {
    try {
      const dados = { ...ped, __tipo: pedTipo, __anexos: anexos, __lead: pedLead }
      // O id vai como esta: vazio significa "ainda nao existe", e quem cunha e o servidor.
      const r = await window.swp.rascunhoSalvar(rascId || '', (pedLead && pedLead.phone) || '', dados)
      if (r && r.ok && r.id) rascId = String(r.id)
      await pegaRascunhos()
      if (aba === 'pedidos') desenha()
      return !!(r && r.ok)
    } catch (_) { return false }   // fica na tela do mesmo jeito; a proxima saida tenta de novo
    finally { gravandoAgora = null }
  })()
  return gravandoAgora
}

async function salvaRascunho() {
  if (pedSalvando) return
  pedSalvando = 'rascunho'; pedFeito = ''; desenha()
  try {
    // O tipo e os anexos viajam DENTRO do rascunho: sem eles, reabrir cairia no passo do tipo com os
    // campos preenchidos e o comprovante perdido.
    const dados = { ...ped, __tipo: pedTipo, __anexos: anexos, __lead: pedLead }
    const r = await window.swp.rascunhoSalvar(rascId || '', (pedLead && pedLead.phone) || estadoWa.phone || '', dados)
    // RECUSA DO SERVIDOR TAMBEM E ERRO. O `catch` so pega exceção; um `ok:false` passava calado e o
    // vendedor clicava em Rascunho sem ver confirmação NEM erro. Foi assim que o rascunho ficou
    // quebrado sem ninguém perceber.
    if (r && r.ok) { rascId = String(r.id || rascId); pedFeito = 'Rascunho guardado.' }
    else pedErros = [humano((r && r.erro) || 'não deu pra guardar o rascunho')]
    await pegaRascunhos()
  } catch (_) {
    pedErros = ['Não deu pra guardar o rascunho agora. O que você digitou continua na tela.']
  } finally { pedSalvando = ''; desenha() }
}

// CADASTRAR COM A CONVERSA TROCADA PEDE CONFIRMACAO (16/10/2026). O que ele pediu foi destaque
// "pra que o meu vendedor nao confunda e acabe subindo um pedido pra um cliente que ja saiu". A
// faixa ambar e o botao de trocar avisam; esta trava e a ultima, e ela custa um clique so no caso
// em que o pedido REALMENTE e do cliente de antes (que e legitimo e acontece o tempo todo).
let confirmouOutro = false
async function cadastraPedido() {
  if (pedSalvando) return
  const faltam = confere(ped)
  if (faltam.length) { pedErros = faltam; pedFeito = ''; desenha(); return }
  const outro = pedLead && estadoWa.phone && estadoWa.phone !== pedLead.phone
  if (outro && !confirmouOutro) {
    confirmouOutro = true
    pedErros = ['Este pedido é de ' + (pedLead.nome || formata(pedLead.phone) || 'outro cliente')
      + ', não de quem está na tela. Clique em Cadastrar de novo para confirmar, ou use o botão de trocar.']
    pedFeito = ''
    desenha()
    return
  }
  // O id so nasce AQUI, no primeiro clique: assim ele nao fica preso a um formulario que o
  // vendedor ainda esta montando, e a segunda tentativa reusa o mesmo.
  if (!pedIdFixo) pedIdFixo = Date.now()
  pedSalvando = 'cadastro'; pedErros = []; pedFeito = ''; desenha()
  try {
    const r = await window.swp.pedidoNovo(montaPedido(ped))
    if (r && r.ok) {
      // `ja` = o servidor reconheceu que este pedido já tinha entrado. Dizer "cadastrado" de novo
      // faria o vendedor achar que criou dois.
      pedFeito = r.ja ? 'Esse pedido já estava cadastrado.' : 'Pedido cadastrado. Está em Aceitações.'
      if (rascId) { try { await window.swp.rascunhoApagar(rascId) } catch (_) { /* some sozinho depois */ } }
      // O DONO TAMBEM ZERA (16/10/2026, achado numa revisao adversarial). Sem `pedLead = null`, ele
      // continuava apontando pro cliente que ACABOU de ser cadastrado, e o `preenchePed()` logo
      // abaixo reenchia `wa` e `nome` com os dados DELE. O vendedor ia pro cliente seguinte,
      // escolhia o tipo de pagamento (o que troca o pedLead pro novo) e o formulario seguia com o
      // TELEFONE E O NOME DO ANTERIOR - sem aviso nenhum, porque o "a conversa mudou" compara com o
      // pedLead, que ja era o novo. Era exatamente o que ele descreveu temer: "subir um pedido pra
      // um cliente que ja saiu". `preenchePed` so escreve em campo vazio, entao o `ped = {}` sozinho
      // nao resolvia: o dono tinha que cair junto.
      ped = {}; rascId = ''; anexos = []; pedTipo = ''; pedLead = null; pedIdFixo = 0
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

// O TITULO DA CONVERSA NAO E NOME DE CLIENTE, e por isso ele nao preenche mais nada (16/10/2026).
//
// Aqui morava o `nomeDeVerdade`, que tentava separar nome de lixo. A historia de um dia:
//   1. o campo NOME vinha com o TELEFONE, porque pra quem nao esta na agenda o titulo da conversa
//      E o telefone. Filtrei o que parecia telefone.
//   2. veio "clique para mostrar os dados do contato", que e a propria interface do WhatsApp. Tem
//      letra, e portugues legitimo, e passou pelos dois filtros.
// O agente tem um bloqueio parecido do lado dele (NAO_E_NOME, PRESENCA) e tambem nao pegou essa.
//
// E uma lista de bloqueio correndo atras do texto de uma interface que muda quando quiserem. A
// decisao do Bruno fecha isso pela raiz: o campo nasce VAZIO e o vendedor digita. Campo vazio custa
// uma digitacao; campo com lixo custa o nome errado na etiqueta, na cobranca e na nota - e so
// aparece quando o produto ja saiu.
// O que já se sabe do cliente entra sozinho: o número vem da conversa aberta e o nome vem do que o
// WhatsApp mostra. É a prévia dos dados do cliente que o Bruno pediu.
let fonePreenchido = ''
// TROCAR O PEDIDO PRO CLIENTE DA CONVERSA DE AGORA (16/10/2026, pedido do Bruno).
//
// O congelamento do dono continua valendo e e ele que protege o pedido; o que faltava era a SAIDA
// pra quando a troca foi de proposito. Palavras dele: "eu gostaria que tivesse um botaozinho ali,
// tipo Trocar para novo cliente, pra atualizar, e isso ficasse um pouco mais destacado, pra que o
// meu vendedor nao confunda e acabe subindo um pedido pra um cliente que ja saiu".
//
// TRES CUIDADOS, nesta ordem:
// 1. O que ja foi digitado pro cliente ANTIGO vira rascunho DELE antes de qualquer coisa. O botao
//    nao pode ser um jeito de perder dez minutos de digitacao por um clique.
// 2. O alvo e lido NA HORA (window.swp.estado()), nao do ultimo pulso de 1,5s - a mesma correcao
//    que a fila de disparos levou hoje, e pela mesma razao: ele clica no lead e age em seguida.
// 3. O formulario nasce LIMPO pro novo cliente, guardando so o tipo de pagamento. CPF, endereco,
//    tratamento e valor sao daquela pessoa; levar junto seria trocar um pedido errado por outro.
async function trocaDeLead() {
  if (pedSalvando || trocandoLead) return
  trocandoLead = true
  try {
    const tinha = temConteudo()
    // Grava com o pedLead ANTIGO ainda de pe: e o dono certo do que esta na tela agora.
    if (tinha) await rascunhoSozinho()
    let e = null
    try { e = await window.swp.estado() } catch (_) { /* vale o ultimo pulso */ }
    const at = (e && e.chatId) ? e : estadoWa
    if (e) estadoWa = e
    if (!at.phone) { rodape('abra a conversa do cliente primeiro'); return }
    pedLead = { chatId: at.chatId || '', phone: at.phone || '', nome: '' }
    ped = {}; anexos = []; rascId = ''; pedErros = []; pedIdFixo = 0
    preenchePed()
    guardaNascimento()
    pedFeito = tinha ? 'O pedido anterior ficou guardado em rascunho.' : ''
    await pegaRascunhos()
    desenha()
  } finally { trocandoLead = false }
}

function preenchePed() {
  const de = pedLead || estadoWa
  const fone = de.phone || ''
  if (!fone) return
  if (!ped.wa) ped.wa = formata(fone)
  // O CAMPO NOME NASCE VAZIO, SEMPRE (16/10/2026, decisao do Bruno: "deixa o nome em branco, deixa
  // apenas o numero ali aparecendo").
  //
  // O que a gente tinha pra preencher era o TITULO DA CONVERSA do WhatsApp, e ele nao e o nome do
  // cliente: pra quem nao esta na agenda ele e o telefone, e quando a tela esta num estado
  // intermediario ele e a propria interface ("clique para mostrar os dados do contato"). Eu tentei
  // filtrar - primeiro o que parecia telefone, depois o que nao tinha letra - e o segundo caso
  // passou pelos dois, porque e uma frase legitima em portugues.
  //
  // Nenhum filtro resolve isso, porque a fonte nao sabe responder a pergunta: o titulo da conversa
  // NAO E um campo de nome. Campo vazio custa o vendedor digitar o nome; campo com lixo custa o
  // pedido sair com o nome errado na etiqueta, na cobranca e na nota - e so aparece la na frente.
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

function disparaItem(id) {
  const it = itemParaEnvio(id)
  if (!it) { rodape('não achei esse item no roteiro'); return }
  enfileira([it], id, it.label || 'item avulso')
}

function disparaFunil(id) {
  const s = (roteiro.sequences || []).find((x) => x.id === id)
  if (!s) return
  const lista = []
  for (const p of (s.items || [])) {
    const it = itemParaEnvio(p.id || p, pausaDoPasso(p))
    if (it) lista.push(it)
  }
  if (!lista.length) { rodape('funil sem passos'); return }
  enfileira(lista, id, s.label || s.nome || 'funil')
}

// A FILA DE DISPAROS (16/10/2026, pedido do Bruno). Antes, disparar um funil TRAVAVA o painel: o
// `ocupado` recusava qualquer outro clique ate o primeiro acabar. Palavras dele: "vamos supor que
// eu dispare o funil da etapa 1 para tres leads diferentes, quero que seja mandado em formato de
// pilha, para cada um daqueles clientes, UM DE CADA VEZ, respeitando o tempo de cada um dos
// disparos. E o que esta funcionando hoje dentro do inbox, e e exatamente o que eu quero aqui".
//
// E ELE FOI EXPLICITO que um por vez e o certo, nao uma limitacao a remover: "nao atrapalha, e
// inclusive o certo". Entao NAO e pra rodar funis em paralelo - e pra ENFILEIRAR. Isso simplifica
// tudo: nada de `roda` reentrante, nada de trava por numero. Uma fila, um consumidor.
//
// Cada job carrega o alvo CONGELADO do clique. Trocar de conversa pra disparar o proximo nao mexe
// no que ja esta na fila: quem entrou pro Fulano continua indo pro Fulano.
let fila = []
let jobSeq = 0
let consumindo = false

// O BOTAO DO CATALOGO NAO MOSTRA MAIS RODINHA (16/10/2026, segunda rodada da fila). Ele mostrava
// enquanto aquele funil estivesse na fila, e o Bruno leu isso como proibicao: "voce bloqueou os
// funis pra mim disparar pra outro, entao eu nao consegui disparar pra outros leads e deixar na
// fila do empilhamento". O botao NUNCA esteve desabilitado - medido, o clique enfileirava -, mas
// trocar o play por uma rodinha tira justamente o sinal de "da pra clicar", e ninguem clica num
// botao que parece ocupado.
//
// E E ASSIM NO INBOX, que e o padrao que ele mandou seguir: no chat.jsx o item do menu de funil
// nunca desabilita nem gira; quem mostra o que esta saindo e a PilhaEnvios, e o aviso do clique vai
// pro toast. Rodinha e informacao de PILHA, nao de botao.

// O ALVO E LIDO NA HORA DO CLIQUE, NAO DO ULTIMO PULSO. Isto e correcao de bug de verdade, nao
// enfeite: o painel so relia a conversa aberta a cada 1,5s, e o Bruno trabalha clicando no lead e
// disparando em seguida. MEDIDO no teste do painel: clicando 120ms depois de trocar de conversa, os
// tres disparos saiam congelados no lead ANTERIOR - o funil inteiro ia pra quem nao pediu, com o
// nome certo na pilha mentindo que era o novo. Uma ida ao processo principal custa milissegundos.
//
// No inbox isso nao existe porque o alvo vem da LINHA clicada (`c.phone` no dispararFunil), nunca
// de um "lead ativo" guardado. Aqui a conversa e a que esta na tela, entao o jeito de ter a mesma
// garantia e perguntar na hora.
async function enfileira(lista, marca, rotulo) {
  // A SENHA DA FILA E TIRADA AGORA, antes de qualquer espera. Ele foi claro sobre a ordem: "se eu
  // disparar pro lead 1, pro lead 2, pro lead 3, a sequencia vai ser lead 1, lead 2, lead 3". Como
  // a leitura do alvo abaixo e assincrona, dois cliques rapidos poderiam voltar trocados e a fila
  // sairia na ordem das RESPOSTAS, nao na dos cliques. O numero resolve isso: quem clicou primeiro
  // entra primeiro, independente de quem responder antes.
  const id = ++jobSeq
  let e = null
  try { e = await window.swp.estado() } catch (_) { /* cai no cache abaixo */ }
  // Sem resposta, vale o ultimo pulso: melhor enfileirar com o que se sabe do que recusar o clique.
  const at = (e && e.chatId) ? e : estadoWa
  if (e) estadoWa = e
  if (!at.chatId) { rodape('abra uma conversa primeiro'); return }
  if (!at.envia) { rodape('o motor do WhatsApp não está pronto'); return }
  const job = {
    id,
    marca,
    rotulo: rotulo || 'funil',
    lista,
    alvo: at.chatId,
    nk: at.nk || '',
    nome: at.nome || '',
    fone: at.phone || '',
    passo: 0,
    rodando: false,
  }
  // Entra na posicao da senha. Nunca na frente de quem ja esta saindo: `fila[0]` rodando e o que a
  // pilha mostra como "enviando agora" e o que o consumidor esta esperando terminar.
  const i = fila.findIndex((j) => !j.rodando && j.id > id)
  if (i < 0) fila.push(job)
  else fila.splice(i, 0, job)
  // O AVISO E O DO INBOX, palavra por palavra do avisoDisparo do chat.jsx. O comentario de la diz
  // por que ele existe: "o vendedor precisa saber que a mensagem NAO saiu ainda, senao ele clica de
  // novo achando que falhou". Aqui ele vale dobrado, porque foi exatamente o que aconteceu.
  //
  // `avisoAte` zerado de proposito: um erro de 10s de outro lead nao pode engolir a confirmacao de
  // um clique que o vendedor acabou de dar.
  avisoAte = 0
  const pos = fila.findIndex((j) => j.id === id) + 1
  if (pos > 1) rodape('Na fila · ' + (pos > 2 ? pos + 'º da pilha' : 'sai quando o atual terminar'))
  desenha()
  consome()
}

async function consome() {
  if (consumindo) return
  consumindo = true
  while (fila.length) {
    const job = fila[0]
    job.rodando = true
    pararPedido = false
    desenha()
    await rodaJob(job)
    // SAI DA FILA DEPOIS DE RODAR, nunca antes: enquanto ele esta na posicao 0 e `rodando`, a pilha
    // mostra ele como o que esta saindo agora. Tirar antes faria sumir da tela no meio do envio.
    fila = fila.filter((j) => j.id !== job.id)
    desenha()
  }
  consumindo = false
  ocupado = false
  alvoNkAtual = ''
  setTimeout(() => { if (!fila.length) rodape(estadoWa.autenticado ? 'pronto' : 'leia o QR no celular') }, 2500)
}

async function rodaJob(job) {
  const lista = job.lista
  alvoFone = job.fone ? formata(job.fone) : ''
  alvoNome = job.nome || ''
  alvoNkAtual = job.nk
  ocupado = true
  // A hibernacao por memoria nao pode fechar quem esta disparando no meio do funil. O mesmo aviso
  // carimba o que esta saindo, pra quem olhar o processo principal ver nome e passo e nao o padrao.
  const avisa = (passo) => {
    try { window.swp.disparo(job.nk, true, { funil: job.rotulo, passo, total: lista.length, alvo: job.fone, inicio: Date.now() }) }
    catch (_) { /* o disparo continua */ }
  }
  avisa(0)
  // Zera a bandeirinha de parar da pagina: um Parar do job anterior cancelaria o primeiro item
  // deste sem ninguem entender por que.
  try { window.swp.parar(job.nk, false) } catch (_) { /* ok */ }
  $('parar').style.display = lista.length > 1 ? 'inline' : 'none'

  for (let i = 0; i < lista.length; i++) {
    if (pararPedido) { rodape('parado no item ' + (i + 1) + ' de ' + lista.length, null, true); break }
    const it = lista[i]
    const de = lista.length > 1 ? ' ' + (i + 1) + ' de ' + lista.length : ''
    job.passo = i + 1
    avisa(i + 1)
    desenha()
    const pct = lista.length > 1 ? (i + 1) / lista.length : null
    // A PAUSA NAO ACONTECE AQUI. Ela vive DENTRO da pagina, grudada no envio, porque la e uma
    // cadeia so: indicador, espera e envio na mesma promessa, do jeito que o sc-panel faz ha meses.
    // Esperar dos dois lados SOMA - passo de 8s vira 16s -, e essa soma ja voltou tres vezes por
    // caminhos diferentes. Ha um teste cronometrando o primeiro envio por causa disso.
    const pausa = Math.min(120, Math.max(0, Number(it.pausa) || 0))
    if (pausa > 0) rodape(((it.kind === 'audio') ? 'gravando' : 'digitando') + de + paraQuem(), pct)
    else rodape((lista.length > 1 ? 'enviando' + de : 'enviando') + paraQuem() + (lista.length > 1 ? '' : '...'), pct)
    const r = await window.swp.manda(job.nk, job.alvo, it)
    if (!r || !r.ok) {
      try { window.swp.disparo(job.nk, false) } catch (_) { /* ok */ }
      $('parar').style.display = 'none'
      const feitos = i
      // O ERRO FICA NA TELA e a fila SEGUE. Parar a fila inteira porque um lead deu erro faria o
      // vendedor perder os outros disparos que ele ja tinha mandado enfileirar.
      rodape((lista.length > 1
        ? 'parou no item ' + (i + 1) + ' de ' + lista.length + (feitos ? ', os ' + feitos + ' primeiros já foram' : '')
        : 'não enviou') + (job.nome ? ' para ' + job.nome : '') + ': ' + humano((r && r.erro) || 'sem resposta'), null, true)
      return
    }
  }
  try { window.swp.disparo(job.nk, false) } catch (_) { /* ok */ }
  $('parar').style.display = 'none'
  if (!pararPedido) rodape('enviado' + (job.nome || alvoFone ? ' para ' + (job.nome || alvoFone) : ''))
}

// O PARAR AGORA TEM DOIS LADOS: a bandeirinha que a espera DENTRO da pagina confere a cada 400ms,
// e o laco daqui, que decide se vai pro proximo item. Sem o primeiro, clicar Parar no meio de uma
// pausa de 60s so teria efeito quando ela acabasse.
$('parar').onclick = () => {
  pararPedido = true
  try { window.swp.parar(alvoNkAtual || estadoWa.nk || '', true) } catch (_) { /* o laco para do mesmo jeito */ }
}
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


// O apelido existe pro MODO FOTO congelar a tela: sem isso o pulso sobrescreve o exemplo
// 1,5 s depois e a foto sai sempre com o estado vazio.
window.__swPulso = setInterval(pulso, 1500)
pulso()
