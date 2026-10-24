// O CRM DO ATENDIMENTO NA CASCA (23/10/2026, pedido do Bruno: o mesmo CRM do inbox da dash, "sempre
// disponivel quando eles rolassem para baixo, mesmo que troquem de conversa"). Ver o comentario
// grande "O CRM DO ATENDIMENTO" no main.js: la mora quem busca na dash, quem tira a view do WhatsApp
// da frente e quem abre a conversa do card. Aqui so se desenha e se clica.
//
// A FAIXA (fechado) fica no pe da area do WhatsApp com a contagem de cada etapa e o que a colheita
// conferiu da marcacao; clicar, apertar Enter ou rolar o mouse pra baixo em cima dela abre o QUADRO.
// O quadro fecha no botao, no Esc, rolando o mouse pra cima no topo dele, ou clicando num numero da
// lista (o main fecha e avisa por sw:area).
;(function () {
  // AS MESMAS ETAPAS E CORES DO CRM DA DASH (CRM_STAGES em pages/apps/chat.jsx), na mesma ordem. O id
  // 'sem_resposta' e o que esta gravado no banco; o nome na tela e "Aguardando dados".
  const ETAPAS = [
    { id: 'novo', lbl: 'Lead Novo', curto: 'Novos', cor: '#60a5fa' },
    { id: 'atendimento', lbl: 'Em Atendimento', curto: 'Atendimento', cor: '#06b6d4' },
    { id: 'qualificado', lbl: 'Qualificado', curto: 'Qualificado', cor: '#a855f7' },
    { id: 'sem_resposta', lbl: 'Aguardando dados', curto: 'Aguardando', cor: '#f59e0b' },
    { id: 'fechou', lbl: 'Fechou', curto: 'Fechou', cor: '#10b981' },
    { id: 'perdido', lbl: 'Perdido', curto: 'Perdido', cor: '#ef4444' },
  ]
  const PERIODOS = { hoje: 'hoje', '7d': 'nos últimos 7 dias', mes: 'neste mês' }
  const AV = ['#6d9eeb', '#00bcd4', '#26a69a', '#66bb6a', '#9ccc65', '#ffa726', '#ff7043', '#ec407a', '#ab47bc', '#7e57c2', '#5c6bc0', '#8d6e63']
  const ICO_MSG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>'
  const ICO_DOC = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h6"/><path d="M9 14h6"/><path d="M9 18h4"/></svg>'
  const ICO_OK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
  const ICO_COPIA = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'
  const ICO_TROCA = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M3 7h18"/><path d="M7 21l-4-4 4-4"/><path d="M21 17H3"/></svg>'
  const ICO_PESSOA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'

  const pega = (id) => document.getElementById(id)
  const caixa = pega('crm')
  if (!caixa) return
  const faixa = pega('crm-faixa'), mini = pega('crm-mini'), marca = pega('crm-marca'), marca2 = pega('crm-marca2')
  const topo = pega('crm-topo'), colunas = pega('crm-colunas'), aviso = pega('crm-aviso')
  const pedido = pega('crm-pedido'), pedidoCorpo = pega('crm-pedido-corpo'), menu = pega('crm-menu')
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  let aberto = false
  let periodo = 'mes'
  try { const p = localStorage.getItem('sw-crm-periodo'); if (PERIODOS[p]) periodo = p } catch (_) { /* sem armazenamento: Este mes */ }
  let dados = { cards: [], totais: {}, lim: 0 }
  let sig = ''
  let carregou = false
  let buscando = false
  let erro = ''
  let marcacao = null
  let arrastando = null
  let geometria = false

  // ── geometria e visibilidade ────────────────────────────────────────────────────────────────
  function aplicaArea(g) {
    if (!g || typeof g !== 'object') return
    if (Number(g.width) > 0) {
      caixa.style.setProperty('--crm-x', Math.round(Number(g.x) || 0) + 'px')
      caixa.style.setProperty('--crm-w', Math.round(Number(g.width)) + 'px')
      geometria = true
    }
    if (Number(g.faixa) > 0) caixa.style.setProperty('--crm-faixa', Math.round(Number(g.faixa)) + 'px')
    // O MAIN FECHOU (clicou num numero da lista, abriu a conversa de um card): a tela acompanha.
    if (typeof g.aberto === 'boolean' && g.aberto !== aberto) desenhaAberto(g.aberto)
    ajustaMini()
  }
  window.sw.ao('sw:area', aplicaArea)
  window.sw.ao('sw:marcacao', (m) => {
    const antes = marcacao
    marcacao = m || null
    desenhaMarca()
    // A colheita mandou o que faltava: o lead ja esta na dash, entao o quadro rele agora.
    if (m && m.faltavam && (!antes || antes.em !== m.em)) { sig = ''; busca() }
  })
  function logado() { try { return !!(typeof estado !== 'undefined' && estado && estado.temToken) } catch (_) { return false } }
  function vigia() {
    const ok = logado()
    if (ok && !geometria) { try { aplicaArea(estado.crm) } catch (_) { /* proxima volta */ } }
    if (ok && estado && estado.marcacao && !marcacao) { marcacao = estado.marcacao; desenhaMarca() }
    if (caixa.hidden === ok) {
      caixa.hidden = !ok
      if (ok && !carregou) busca()
      if (!ok && aberto) fecha()
    }
  }
  setInterval(vigia, 1000)
  vigia()

  // ── abrir e fechar ──────────────────────────────────────────────────────────────────────────
  function desenhaAberto(v) {
    aberto = !!v
    caixa.classList.toggle('on', aberto)
    if (!aberto) { pedido.hidden = true; aviso.hidden = true; menu.hidden = true }
    if (aberto) { desenha(); desenhaPeriodo() }
  }
  async function abre() {
    if (aberto || !logado()) return
    desenhaAberto(true)
    try { await window.sw.crmAbrir(true) } catch (_) { /* a tela ja abriu; o main corrige no proximo aviso */ }
    busca()
  }
  async function fecha() {
    if (!aberto) return
    desenhaAberto(false)
    try { await window.sw.crmAbrir(false) } catch (_) { /* ok */ }
  }
  faixa.onclick = abre
  faixa.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre() } }
  // ROLAR PRA BAIXO ABRE, rolar pra cima no topo do quadro fecha: e o "rolar pra baixo" do pedido.
  faixa.addEventListener('wheel', (e) => { if (e.deltaY > 0) abre() }, { passive: true })
  topo.addEventListener('wheel', (e) => { if (e.deltaY < 0) fecha() }, { passive: true })
  pega('crm-volta').onclick = fecha
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !aberto) return
    const m = document.getElementById('modal')
    if (m && m.classList.contains('on')) return
    if (!pedido.hidden) { pedido.hidden = true; return }
    if (!menu.hidden) { fechaMenu(); return }
    fecha()
  })
  for (const b of pega('crm-per').querySelectorAll('button')) {
    b.onclick = () => {
      if (b.dataset.p === periodo) return
      periodo = b.dataset.p
      try { localStorage.setItem('sw-crm-periodo', periodo) } catch (_) { /* ok */ }
      sig = ''; carregou = false; dados = { cards: [], totais: {}, lim: 0 }
      desenhaPeriodo(); desenha(); desenhaMini(); busca()
    }
  }
  function desenhaPeriodo() {
    for (const b of pega('crm-per').querySelectorAll('button')) b.classList.toggle('on', b.dataset.p === periodo)
    faixa.title = 'Abrir o CRM do Atendimento (contagem ' + PERIODOS[periodo] + ')'
  }
  desenhaPeriodo()

  // ── dados ───────────────────────────────────────────────────────────────────────────────────
  async function busca() {
    if (buscando || !logado()) return
    buscando = true
    const pediu = periodo
    try {
      const r = await window.sw.crmDados(periodo, sig)
      if (pediu !== periodo) return            // trocou de periodo no meio: a resposta e do anterior
      if (r && r.marcacao) { marcacao = r.marcacao; desenhaMarca() }
      if (!r || !r.ok) { erro = (r && r.erro) || 'Não deu pra falar com a dash.'; if (!carregou) desenha(); return }
      erro = ''
      if (r.igual) return
      dados = { cards: Array.isArray(r.cards) ? r.cards : [], totais: r.totais || {}, lim: Number(r.lim) || 0 }
      sig = String(r.sig || '')
      carregou = true
      desenhaMini()
      if (aberto && !arrastando) desenha()
    } catch (_) {
      erro = 'Não deu pra falar com a dash.'
    } finally { buscando = false }
  }
  // De 20 em 20 s com o quadro aberto (como a dash), de minuto em minuto so pra contagem da faixa.
  let ultimaBusca = 0
  setInterval(() => {
    if (!logado() || document.hidden) return
    const passo = aberto ? 20000 : 60000
    if (Date.now() - ultimaBusca < passo) return
    ultimaBusca = Date.now()
    busca()
  }, 5000)

  const daEtapa = (c) => String((c && c.crm_stage) || 'novo')
  const naEtapa = (id) => dados.cards.filter((c) => daEtapa(c) === id || (id === 'novo' && !ETAPAS.some((e) => e.id === daEtapa(c))))
  const totalDe = (id) => {
    const n = naEtapa(id).length
    const t = Number(dados.totais && dados.totais[id]) || 0
    return Math.max(n, t)
  }

  // ── a faixa ─────────────────────────────────────────────────────────────────────────────────
  function desenhaMini() {
    mini.innerHTML = carregou
      ? ETAPAS.map((e) => '<span title="' + escH(e.lbl) + '"><i style="--c:' + e.cor + '"></i><em data-l="' + escH(e.lbl) + '" data-c="' + escH(e.curto) + '">' + escH(e.lbl) + '</em><strong>' + totalDe(e.id).toLocaleString('pt-BR') + '</strong></span>').join('')
      : ''
    ajustaMini()
  }
  // Area estreita (notebook com barra e painel abertos): primeiro o nome curto de cada etapa, e so se
  // ainda nao couber fica a bolinha com o numero, em vez de cortar no meio de uma palavra.
  function ajustaMini() {
    const ems = [...mini.querySelectorAll('em')]
    const cabe = () => mini.scrollWidth <= mini.clientWidth + 1
    for (const em of ems) { em.style.display = ''; em.textContent = em.dataset.l || em.textContent }
    if (cabe()) return
    for (const em of ems) em.textContent = em.dataset.c || em.textContent
    if (cabe()) return
    for (const em of ems) em.style.display = 'none'
  }
  window.addEventListener('resize', ajustaMini)

  // O QUE A COLHEITA CONFERIU (ver garanteMarcacao no main.js). So aparece com numero conectado:
  // sem nenhum, nao ha o que conferir, e "Tudo marcado" seria mentira por omissao.
  function desenhaMarca() {
    const m = marcacao
    let html = '', cls = '', tit = ''
    if (m && m.prontos) {
      const recente = m.em && (Date.now() - Number(m.em)) < 6 * 60000
      if (recente) {
        const hh = new Date(Number(m.em)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        tit = 'Conferido às ' + hh + ' nas conversas recentes de ' + (m.numeros === 1 ? '1 número aberto' : (m.numeros || 0) + ' números abertos')
        if (m.faltavam) { cls = 'foi'; html = ICO_OK + ' Marcou agora ' + m.faltavam + (m.faltavam === 1 ? ' mensagem que faltava' : ' mensagens que faltavam') }
        else { cls = 'ok'; html = ICO_OK + ' Tudo marcado' }
      } else { html = 'Conferindo a marcação'; tit = 'O app confere de 2 em 2 minutos se cada conversa chegou na dash' }
    }
    for (const x of [marca, marca2]) { x.className = 'crm-marca' + (cls ? ' ' + cls : ''); x.innerHTML = html; x.title = tit }
  }
  setInterval(desenhaMarca, 30000)

  // ── o quadro ────────────────────────────────────────────────────────────────────────────────
  function corDe(seed) { const s = String(seed || ''); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length] }
  function iniciais(nome) {
    const p = String(nome || '').replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
    if (!p.length) return ''
    return (p.length > 1 ? p[0][0] + p[1][0] : p[0].slice(0, 2)).toUpperCase()
  }
  function foneBonito(f) {
    let d = String(f || '').replace(/\D/g, '')
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7)
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6)
    return d ? '+' + d : ''
  }
  // O mesmo resumo da ultima mensagem que o card da dash mostra (lastPreview).
  function resumo(t) {
    const s = String(t || '')
    const m = s.match(/^\[([a-z0-9_]+)\]$/i)
    if (m) return ({ ptt: 'Áudio', audio: 'Áudio', voice: 'Áudio', image: 'Foto', video: 'Vídeo', document: 'Documento', sticker: 'Figurinha', location: 'Localização', contact: 'Contato', chat: 'Mensagem', text: 'Mensagem' })[m[1].toLowerCase()] || 'Mensagem'
    if (s.length > 90 && !/\s/.test(s)) return 'Anexo'
    return s
  }
  function hora(ts) {
    const n = Number(ts) || 0
    if (!n) return ''
    const d = new Date(n * 1000)
    const hoje = new Date()
    return d.toDateString() === hoje.toDateString()
      ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  }
  function card(c, e) {
    const fone = String(c.phone || '')
    const nome = String(c.name || '').trim() || foneBonito(fone)
    const ini = iniciais(nome)
    const nl = Number(c.unread) || 0
    const ul = resumo(c.last_text)
    return '<div class="crm-card" draggable="true" data-fone="' + escH(fone) + '" data-inst="' + escH(c.instance || '') + '" data-nome="' + escH(nome) + '"'
      + ' title="Clique pra abrir a conversa. Botão direito: chamar por outro número ou copiar o telefone." style="--c:' + e.cor + '">'
      + '<div class="l1"><span class="crm-av" style="background:' + corDe(fone) + '">' + (ini ? escH(ini) : ICO_PESSOA) + '</span>'
      + '<div class="nm"><b>' + escH(nome) + '</b></div>'
      + (nl > 0 ? '<span class="nl">' + (nl > 9 ? '9+' : nl) + '</span>' : '') + '</div>'
      // O TELEFONE INTEIRO, NA LINHA DELE, E O CLIQUE COPIA (24/10/2026): do lado do avatar ele era
      // cortado em "+5531886998...", e com o numero de origem banido o vendedor nao tinha como chamar o lead.
      + '<button class="fone" data-copiar="+' + escH(fone) + '" title="Copiar +' + escH(fone) + '">' + escH(foneBonito(fone)) + ICO_COPIA + '</button>'
      + (ul ? '<div class="ul">' + escH(ul) + '</div>' : '')
      + '<div class="l3"><span>' + ICO_MSG + ' Abrir conversa</span><em><time>' + escH(hora(c.last_ts)) + '</time><button class="outro" title="Chamar esse lead por outro número aberto aqui">' + ICO_TROCA + '</button></em></div>'
      + (e.id === 'fechou' ? '<button class="ped" data-ped="' + escH(fone) + '">' + ICO_DOC + ' Ver Pedido Concluído</button>' : '')
      + '</div>'
  }
  function desenha() {
    if (!aberto) return
    // A ROLAGEM DE CADA COLUNA SOBREVIVE A RELEITURA de 20 s: sem isto o vendedor que desceu na
    // coluna Em Atendimento voltava pro topo sozinho no meio da leitura.
    const rolagem = {}
    for (const x of colunas.querySelectorAll('.crm-col')) { const k = x.querySelector('.crm-cards'); if (k) rolagem[x.dataset.etapa] = k.scrollTop }
    const rolagemX = colunas.scrollLeft
    colunas.innerHTML = ETAPAS.map((e) => {
      const itens = naEtapa(e.id).sort((a, b) => (Number(b.last_ts) || 0) - (Number(a.last_ts) || 0))
      const total = totalDe(e.id)
      const cortada = dados.lim && total > itens.length
      let corpo
      if (!carregou) corpo = '<div class="crm-vazio">' + (erro ? escH(erro) : 'Carregando...') + '</div>'
      else if (!itens.length) corpo = '<div class="crm-vazio">Arraste conversas pra cá</div>'
      else corpo = itens.map((c) => card(c, e)).join('')
        + (cortada ? '<div class="crm-pe">Mostrando os ' + itens.length.toLocaleString('pt-BR') + ' mais recentes de ' + total.toLocaleString('pt-BR') + '</div>' : '')
      return '<div class="crm-col" data-etapa="' + e.id + '" style="--c:' + e.cor + '">'
        + '<div class="crm-col-cab"><i></i><b title="' + escH(e.lbl) + '">' + escH(e.lbl) + '</b><span>' + (carregou ? total.toLocaleString('pt-BR') : '·') + '</span></div>'
        + '<div class="crm-cards">' + corpo + '</div></div>'
    }).join('')
    for (const x of colunas.querySelectorAll('.crm-col')) { const k = x.querySelector('.crm-cards'); if (k && rolagem[x.dataset.etapa]) k.scrollTop = rolagem[x.dataset.etapa] }
    colunas.scrollLeft = rolagemX
  }

  // ── cliques e arrasto (delegados: o quadro e redesenhado inteiro a cada releitura) ──────────
  colunas.addEventListener('click', (ev) => {
    const ped = ev.target.closest('.ped')
    if (ped) { ev.stopPropagation(); abrePedido(ped.dataset.ped); return }
    const cp = ev.target.closest('.fone')
    if (cp) { ev.stopPropagation(); copia(cp); return }
    const c = ev.target.closest('.crm-card')
    if (!c) return
    if (ev.target.closest('.outro')) { ev.stopPropagation(); abreMenu(c, ''); return }
    abreConversa(c.dataset.fone, c.dataset.inst, c)
  })

  async function copia(el) {
    let r = null
    try { r = await window.sw.copiar(el.dataset.copiar) } catch (_) { r = null }
    if (!r || !r.ok) { avisa('Não consegui copiar. O número é ' + el.dataset.copiar); return }
    const antes = el.innerHTML
    el.classList.add('copiou')
    el.innerHTML = 'Copiado ' + ICO_OK
    setTimeout(() => { el.classList.remove('copiou'); el.innerHTML = antes }, 1500)
  }

  // CHAMAR POR OUTRO NUMERO (24/10/2026). Lista os numeros abertos aqui; o escolhido abre a conversa
  // daquele telefone (a que ja existe ou uma nova). Tambem abre sozinho quando o numero de origem foi
  // banido ou saiu da lista (o main responde `semNumero`), com o porque em cima.
  let menuDe = null
  function abreMenu(cardEl, porque, origem) {
    menuDe = { fone: cardEl.dataset.fone, inst: cardEl.dataset.inst, nome: cardEl.dataset.nome || '' }
    const abertos = (typeof estado !== 'undefined' && estado && Array.isArray(estado.abertos)) ? estado.abertos : []
    const nums = (typeof estado !== 'undefined' && estado && Array.isArray(estado.numeros)) ? estado.numeros : []
    const k8 = (String(menuDe.inst).match(/_(\d{8})$/) || [])[1] || ''
    const nomeNum = (nk) => { const n = nums.find((x) => String(x.numero || '').replace(/\D/g, '').slice(-8) === String(nk).slice(-8)); return (n && n.dono) || '' }
    let html = '<div class="tit">' + escH(porque || ('Chamar ' + (menuDe.nome || 'esse lead') + ' por:')) + '</div>'
    const lista = abertos.filter((nk) => String(nk).slice(-8) !== k8)
    if (lista.length) {
      html += lista.map((nk) => '<button data-nk="' + escH(nk) + '">' + ICO_MSG + ' ' + escH(foneBonito(nk)) + '<small>' + escH(nomeNum(nk)) + '</small></button>').join('')
    } else {
      html += '<div class="vazio">Nenhum outro número aberto aqui. Abra um na lista e tente de novo.</div>'
    }
    html += '<hr><button data-copiar="+' + escH(menuDe.fone) + '">' + ICO_COPIA + ' Copiar o número<small>' + escH(foneBonito(menuDe.fone)) + '</small></button>'
    if (origem) html += '<button data-origem="1">' + ICO_MSG + ' Abrir no número de origem<small>' + escH(foneBonito(origem)) + '</small></button>'
    menu.innerHTML = html
    menu.hidden = false
    // perto do card, sem sair da area do CRM
    const rc = cardEl.getBoundingClientRect(), rb = caixa.getBoundingClientRect()
    const larg = menu.offsetWidth || 240, alt = menu.offsetHeight || 160
    let x = rc.left - rb.left, y = rc.bottom - rb.top + 4
    if (x + larg > rb.width - 8) x = Math.max(8, rb.width - larg - 8)
    if (y + alt > rb.height - 8) y = Math.max(8, rc.top - rb.top - alt - 4)
    menu.style.left = x + 'px'; menu.style.top = y + 'px'
  }
  function fechaMenu() { menu.hidden = true; menuDe = null }
  menu.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button')
    if (!b || !menuDe) return
    const de = menuDe
    if (b.dataset.copiar) { fechaMenu(); try { await window.sw.copiar(b.dataset.copiar) } catch (_) { /* ok */ } avisa('Número copiado: ' + b.dataset.copiar); return }
    if (b.dataset.nk) { fechaMenu(); abreConversa(de.fone, de.inst, null, b.dataset.nk) }
    if (b.dataset.origem) { fechaMenu(); abreConversa(de.fone, de.inst, null, '', true) }
  })
  // BOTAO DIREITO NO CARD: o mesmo menu (o CRM da dash tambem abre as opcoes no botao direito)
  colunas.addEventListener('contextmenu', (ev) => {
    const c = ev.target.closest && ev.target.closest('.crm-card')
    if (!c) return
    ev.preventDefault()
    abreMenu(c, '')
  })
  document.addEventListener('mousedown', (ev) => { if (!menu.hidden && !menu.contains(ev.target) && !ev.target.closest('.outro')) fechaMenu() })
  colunas.addEventListener('dragstart', (ev) => {
    const c = ev.target.closest && ev.target.closest('.crm-card')
    if (!c) return
    const col = c.closest('.crm-col')
    arrastando = { fone: c.dataset.fone, de: col ? col.dataset.etapa : '' }
    c.classList.add('arrastando')
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', c.dataset.fone) } catch (_) { /* ok */ }
  })
  colunas.addEventListener('dragend', () => {
    arrastando = null
    for (const x of colunas.querySelectorAll('.arrastando, .alvo')) x.classList.remove('arrastando', 'alvo')
  })
  colunas.addEventListener('dragover', (ev) => {
    const col = ev.target.closest && ev.target.closest('.crm-col')
    if (!col || !arrastando) return
    ev.preventDefault()
    for (const x of colunas.querySelectorAll('.crm-col.alvo')) if (x !== col) x.classList.remove('alvo')
    col.classList.add('alvo')
  })
  colunas.addEventListener('drop', (ev) => {
    const col = ev.target.closest && ev.target.closest('.crm-col')
    const a = arrastando
    arrastando = null
    for (const x of colunas.querySelectorAll('.arrastando, .alvo')) x.classList.remove('arrastando', 'alvo')
    if (!col || !a) return
    ev.preventDefault()
    move(a.fone, col.dataset.etapa)
  })

  // MOVE NA HORA e grava depois; a dash recusou, volta e diz por que (o mesmo da dash).
  async function move(fone, para) {
    const c = dados.cards.find((x) => String(x.phone) === String(fone))
    if (!c || daEtapa(c) === para) return
    const de = daEtapa(c), deTs = c.crm_ts
    const tot = dados.totais || (dados.totais = {})
    const ajusta = (k, n) => { if (tot[k] != null) tot[k] = Math.max(0, (Number(tot[k]) || 0) + n) }
    c.crm_stage = para; c.crm_ts = Math.floor(Date.now() / 1000)
    ajusta(de, -1); ajusta(para, 1)
    desenha(); desenhaMini()
    let r = null
    try { r = await window.sw.crmEtapa(fone, para) } catch (_) { r = null }
    if (r && r.ok) { sig = ''; return }
    c.crm_stage = de; c.crm_ts = deTs
    ajusta(para, -1); ajusta(de, 1)
    desenha(); desenhaMini()
    avisa('Não salvou: ' + ((r && r.erro) || 'a dash não respondeu') + '. O card voltou pra onde estava.')
  }

  async function abreConversa(fone, inst, cardEl, nk, naOrigem) {
    let r = null
    try { r = await window.sw.crmConversa(fone, inst, nk || '', !!naOrigem) } catch (_) { r = null }
    if (r && r.semNumero && cardEl) { abreMenu(cardEl, r.erro || 'Escolha por qual número chamar.', r.origem || ''); return }
    if (!r || !r.ok) { avisa((r && r.erro) || 'Não consegui abrir essa conversa agora.'); return }
    desenhaAberto(false)
    // NUMERO FECHADO: abre pelo caminho de sempre da lista (com a trava de "em uso"); a conversa
    // abre sozinha quando o WhatsApp dele ficar pronto (crmPendente no main).
    if (r.fechado && r.numero && typeof abrir === 'function') abrir(r.numero)
  }

  async function abrePedido(fone) {
    pedidoCorpo.innerHTML = '<h2>Pedido Concluído</h2><p>Buscando na dash...</p>'
    pedido.hidden = false
    let r = null
    try { r = await window.sw.crmPedido(fone) } catch (_) { r = null }
    if (pedido.hidden) return
    const fechar = '<div class="acoes"><button class="secundario" id="crm-ped-fechar">Fechar</button></div>'
    if (!r || !r.ok) pedidoCorpo.innerHTML = '<h2>Pedido Concluído</h2><p>' + escH((r && r.erro) || 'Não deu pra falar com a dash.') + '</p>' + fechar
    else if (!r.venda) pedidoCorpo.innerHTML = '<h2>Pedido Concluído</h2><p>Nenhum Pedido Concluído registrado pra esse lead nos últimos 60 dias.</p>' + fechar
    else {
      const v = r.venda
      const quando = v.ts ? new Date(v.ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
      const valor = v.valor ? v.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : ''
      pedidoCorpo.innerHTML = '<h2>Pedido Concluído</h2><p>' + [escH(v.nome), escH(valor), escH(quando)].filter(Boolean).join(' · ') + '</p>'
        + '<pre>' + escH(v.raw || 'Sem texto salvo nessa venda.') + '</pre>' + fechar
    }
    const b = pega('crm-ped-fechar')
    if (b) b.onclick = () => { pedido.hidden = true }
  }
  pedido.addEventListener('click', (ev) => { if (ev.target === pedido) pedido.hidden = true })

  let avisoT = 0
  function avisa(txt) {
    aviso.textContent = txt
    aviso.hidden = false
    clearTimeout(avisoT)
    avisoT = setTimeout(() => { aviso.hidden = true }, 6000)
  }

  // pro teste e pra quem for depurar na maquina do vendedor
  window.__swCrm = { abre, fecha, busca, estado: () => ({ aberto, periodo, carregou, n: dados.cards.length, erro, sig }) }
})()
