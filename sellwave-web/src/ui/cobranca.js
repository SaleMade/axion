// O QUADRO E A AGENDA DO COBRADOR NA CASCA (31/10/2026, versao de cobrador do SellWave Web).
//
// Palavras do Bruno: "o CRM dele nao vai ser esse CRM igual a versao de vendedor, vai ser
// literalmente o nosso Kanban, pra ele visualizar quem ele deve estar cobrando e quem foi um dos
// pedidos que chegou", e "uma visualizacao de agenda pra ele acessar de forma rapida e verificar
// quais sao os pedidos que ele deve cobrar, quais sao os atrasados e os que vao chegar mais a frente".
//
// MORA NO MESMO LUGAR DO CRM DO ATENDIMENTO: a faixa no pe da area do WhatsApp, que abre o quadro na
// area inteira (o main tira a view da frente pelo mesmo defineCrm). So um dos dois aparece, pelo
// modo: cobrador ve este, vendedor e direcao veem o CRM. O crm.js se esconde sozinho no modo cobranca.
//
// As regras (o que e atrasado, o que esta na fila, o que esta chegando) e a ficha do pedido sao do
// cob-comum.js, as mesmas do painel ao lado da conversa.
;(function () {
  const C = window.SWCob
  const pega = (id) => document.getElementById(id)
  const caixa = pega('cob')
  if (!C || !caixa) return
  C.poeEstilo()
  const esc = C.esc
  const faixa = pega('cob-faixa'), mini = pega('cob-mini'), topo = pega('cob-topo'), corpo = pega('cob-corpo')
  const resumo = pega('cob-resumo'), ficha = pega('cob-ficha'), fichaCorpo = pega('cob-ficha-corpo')
  const aviso = pega('cob-aviso'), menu = pega('cob-menu'), buscaEl = pega('cob-busca'), meusEl = pega('cob-meus')
  const estadoEl = pega('cob-estado'), estadoEl2 = pega('cob-estado2')

  const guarda = (k, v) => { try { localStorage.setItem(k, v) } catch (_) { /* sem armazenamento: so nao lembra */ } }
  const le = (k) => { try { return localStorage.getItem(k) } catch (_) { return null } }
  let aberto = false
  let aba = le('sw-cob-aba') === 'kanban' ? 'kanban' : 'agenda'
  let soMeus = le('sw-cob-meus') !== '0'
  let filtro = ''
  let dados = { pedidos: [], prontos: [], eu: '' }
  let sig = ''
  let carregou = false
  let buscando = false
  let erro = ''
  let lidoEm = 0
  let fichaId = ''
  let fichaPed = null
  let arrastando = null
  let perdaAberta = false
  let geometria = false

  const modo = () => { try { return !!(typeof estado !== 'undefined' && estado && estado.temToken && estado.cobranca) } catch (_) { return false } }

  // ── geometria e visibilidade (a mesma do CRM: x e largura vem do main pelo sw:area) ──────────
  // O QUADRO PISCAVA (03/11/2026, o Bruno: "ele abre e fecha bem rapido (...) acaba saindo do
  // WhatsApp. Depois de uns 2, 3 segundos ele vai abrir de novo e ai vai permanecer"). O vigia de
  // 1 s reaplicava o `estado.crm` inteiro, e esse estado e uma FOTO tirada na ultima leitura: logo
  // depois do clique ela ainda dizia "fechado", entao o quadro fechava na tela enquanto o main ja
  // tinha tirado o WhatsApp da frente (a area ficava vazia) e so voltava quando a foto renovava. O
  // mesmo vigia reabria o quadro depois de "Abrir conversa". Agora o aberto/fechado so vem do aviso
  // do main (sw:area) ou do clique, e a foto serve uma vez, so pra geometria, como no crm.js.
  function aplicaArea(g, soGeometria) {
    if (!g || typeof g !== 'object') return
    if (Number(g.width) > 0) {
      caixa.style.setProperty('--crm-x', Math.round(Number(g.x) || 0) + 'px')
      caixa.style.setProperty('--crm-w', Math.round(Number(g.width)) + 'px')
      geometria = true
    }
    if (Number(g.faixa) > 0) caixa.style.setProperty('--crm-faixa', Math.round(Number(g.faixa)) + 'px')
    if (soGeometria) return
    if (typeof g.aberto === 'boolean' && g.aberto !== aberto && modo()) desenhaAberto(g.aberto)
  }
  window.sw.ao('sw:area', aplicaArea)
  window.sw.ao('sw:modo', () => { setTimeout(vigia, 50) })
  // O AVISO DO LEMBRETE foi clicado: abre o quadro na ficha daquele pedido.
  window.sw.ao('sw:cob-abrir', (d) => { if (d && d.id && modo()) { abre(); abreFicha(String(d.id)) } })
  function vigia() {
    const ok = modo()
    if (ok && !geometria) { try { aplicaArea(estado.crm, true) } catch (_) { /* proxima volta */ } }
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
    if (!aberto) { menu.hidden = true; aviso.hidden = true }
    if (aberto) { desenhaAbas(); desenha() }
  }
  async function abre(qual) {
    if (qual) { aba = qual; guarda('sw-cob-aba', aba) }
    if (!modo()) return
    if (!aberto) {
      desenhaAberto(true)
      try { await window.sw.crmAbrir(true) } catch (_) { /* a tela ja abriu; o main corrige no proximo aviso */ }
    } else { desenhaAbas(); desenha() }
    busca()
  }
  async function fecha() {
    if (!aberto) return
    desenhaAberto(false)
    fechaFicha()
    try { await window.sw.crmAbrir(false) } catch (_) { /* ok */ }
  }
  faixa.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-vai]')
    abre(b ? b.dataset.vai : '')
  })
  faixa.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre() } }
  faixa.addEventListener('wheel', (e) => { if (e.deltaY > 0) abre() }, { passive: true })
  topo.addEventListener('wheel', (e) => { if (e.deltaY < 0) fecha() }, { passive: true })
  pega('cob-volta').onclick = fecha
  pega('cob-ficha-fecha').onclick = fechaFicha
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !aberto) return
    const m = document.getElementById('modal')
    if (m && m.classList.contains('on')) return
    if (!menu.hidden) { menu.hidden = true; return }
    if (!ficha.hidden) { fechaFicha(); return }
    fecha()
  })
  for (const b of pega('cob-abas').querySelectorAll('button')) {
    b.onclick = () => { if (b.dataset.a === aba) return; aba = b.dataset.a; guarda('sw-cob-aba', aba); desenhaAbas(); desenha() }
  }
  function desenhaAbas() { for (const b of pega('cob-abas').querySelectorAll('button')) b.classList.toggle('on', b.dataset.a === aba) }
  buscaEl.addEventListener('input', () => { filtro = String(buscaEl.value || '').trim(); desenha() })
  meusEl.checked = soMeus
  meusEl.onchange = () => { soMeus = !!meusEl.checked; guarda('sw-cob-meus', soMeus ? '1' : '0'); desenhaMini(); desenha() }

  // ── dados ───────────────────────────────────────────────────────────────────────────────────
  async function busca() {
    if (buscando || !modo()) return
    buscando = true
    try {
      const r = await window.sw.cobDados(sig)
      if (!r || !r.ok) { erro = (r && r.erro) || 'Não deu pra falar com a dash.'; desenhaEstado(); if (!carregou && aberto) desenha(); return }
      erro = ''
      lidoEm = Date.now()
      if (!r.igual) {
        dados = { pedidos: Array.isArray(r.pedidos) ? r.pedidos : [], prontos: Array.isArray(r.prontos) ? r.prontos : [], tags: Array.isArray(r.tags) ? r.tags : [], eu: String(r.eu || '') }
        sig = String(r.sig || '')
        carregou = true
        if (aberto && !arrastando) desenha()
        if (fichaId && !ficha.hidden) recarregaFicha(true)
      }
      desenhaMini()
      desenhaEstado()
      lembretes()
    } catch (_) {
      erro = 'Não deu pra falar com a dash.'
    } finally { buscando = false }
  }
  // De 30 em 30 s com o quadro aberto, de minuto em minuto fechado (a faixa e o lembrete).
  let ultima = 0
  setInterval(() => {
    if (!modo() || document.hidden) return
    const passo = aberto ? 30000 : 60000
    if (Date.now() - ultima < passo) return
    ultima = Date.now()
    busca()
  }, 5000)
  function desenhaEstado() {
    const txt = erro ? 'Sem conexão com a dash' : (lidoEm ? 'Atualizado às ' + new Date(lidoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')
    for (const x of [estadoEl, estadoEl2]) { x.textContent = txt; x.className = 'crm-marca' + (erro ? ' foi' : '') }
  }

  // O RECORTE: "so os meus" e o pedido com o cobrador dele ou ainda sem cobrador (a mesma regra do
  // Kanban da dash pro cobrador); a busca casa nome, telefone, cidade e produto.
  const digitos = (s) => String(s || '').replace(/\D/g, '')
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  function visiveis() {
    let l = dados.pedidos
    // Quem escreveu pra ele aparece mesmo com outro dono: a varredura passa o pedido pra ele em
    // seguida (03/11/2026, "de quem o cliente chamou"), e sumir da tela ate la seria pior.
    if (soMeus && dados.eu) l = l.filter((p) => !p.cob || p.cob === dados.eu || Number(p.contato) > 0)
    if (filtro) {
      const q = semAcento(filtro), qd = digitos(filtro)
      l = l.filter((p) => (qd.length >= 3 && String(p.wa || '').includes(qd))
        || semAcento(p.nome + ' ' + p.cidade + ' ' + p.uf + ' ' + p.prod + ' ' + p.atNome).includes(q))
    }
    return l
  }

  // ── a faixa ─────────────────────────────────────────────────────────────────────────────────
  function desenhaMini() {
    if (!carregou) { mini.innerHTML = ''; return }
    const ag = C.agenda(visiveis())
    const it = (cor, rot, n, vai, tit) => '<span data-vai="' + vai + '" title="' + esc(tit) + '"><i style="--c:' + cor + '"></i><em>' + esc(rot) + '</em><strong>' + n + '</strong></span>'
    mini.innerHTML = (ag.contato.length ? it('#24c278', 'Contato', ag.contato.length, 'agenda', 'Clientes que escreveram e ainda não tiveram resposta') : '')
      + it('#ef4444', 'Atrasados', ag.atrasados.length, 'agenda', 'Retorno marcado que já passou')
      + it('#f59e0b', 'Sem retorno', ag.semRetorno.length, 'agenda', 'Na fila de cobrança sem dia marcado')
      + it('#3b82f6', 'Hoje', ag.hoje.length, 'agenda', 'Retornos marcados pra hoje')
      + it('#818cf8', 'Chegando', ag.chegando.length, 'agenda', 'Enviados e saindo pra entrega')
      + '<span title="Pago hoje, do que passou pela cobrança"><i style="--c:#10b981"></i><em>Recebido hoje</em><strong>' + esc(C.brl(ag.recebidoHoje)) + '</strong></span>'
  }

  // ── o quadro ────────────────────────────────────────────────────────────────────────────────
  function desenha() {
    if (!aberto) return
    const rolagem = {}
    for (const x of corpo.querySelectorAll('.crm-col')) { const k = x.querySelector('.crm-cards'); if (k) rolagem[x.dataset.col] = k.scrollTop }
    const rolagemX = corpo.scrollLeft
    if (!carregou) {
      resumo.innerHTML = ''
      corpo.innerHTML = '<div class="cob-carrega">' + esc(erro || 'Carregando os pedidos...') + '</div>'
      return
    }
    if (aba === 'agenda') desenhaAgenda()
    else desenhaKanban()
    for (const x of corpo.querySelectorAll('.crm-col')) { const k = x.querySelector('.crm-cards'); if (k && rolagem[x.dataset.col]) k.scrollTop = rolagem[x.dataset.col] }
    corpo.scrollLeft = rolagemX
  }
  const coluna = (id, rot, cor, n, cards, vazio, extra) => '<div class="crm-col" data-col="' + esc(id) + '" style="--c:' + cor + '">'
    + '<div class="crm-col-cab"><i></i><b title="' + esc(rot) + '">' + esc(rot) + '</b><span>' + n + '</span></div>'
    + (extra || '')
    + '<div class="crm-cards">' + (cards || '<div class="crm-vazio">' + esc(vazio) + '</div>') + '</div></div>'

  // O CARD COM A CARA DO KANBAN DA DASH (03/11/2026, pedido do Bruno: "mais parecido com o nosso
  // kanban da dash original"). Mesma ordem de la: nome, telefone, data, valor em verde, a entrega, os
  // selos e, no pe, quem vendeu e a UF. A linha do relogio diz o que o cobrador precisa: o retorno
  // marcado (vermelho se passou), "escreveu ha X" em Entraram em contato, ou a data do pedido.
  const pad = (n) => String(n).padStart(2, '0')
  const iniciais = (n) => String(n || '').trim().split(/\s+/).map((x) => x[0] || '').join('').slice(0, 2).toUpperCase() || '?'
  function cartao(p, o) {
    o = o || {}
    const ag = C.quandoAgend(p)
    // Em "Entraram em contato" a hora que importa e a da mensagem; em "Proximos" o dia ja esta na
    // divisoria, entao o card so diz a hora.
    const quando = o.contato ? 'escreveu ' + C.haQuanto(Number(p.contato))
      : o.quando === false ? '' : (!isNaN(ag) ? (o.soHora ? C.hora(ag) : C.quandoTxt(ag)) : '')
    const atras = !o.contato && C.naFila(p) && !isNaN(ag) && ag < Date.now()
    const cri = Number(p.criado) ? new Date(Number(p.criado)) : null
    const data = cri && !isNaN(cri) ? pad(cri.getDate()) + '/' + pad(cri.getMonth() + 1) : ''
    const linhaQ = quando
      ? '<div class="cob-ln">' + C.I.relogio + '<span class="cob-q ' + (o.contato ? 'msg' : atras ? 'atras' : 'marcado') + '">' + esc(quando) + '</span></div>'
      : (data ? '<div class="cob-ln">' + C.I.relogio + '<span>' + esc(data) + '</span></div>' : '')
    const valor = !p.pago && Number(p.saldo) > 0 ? Number(p.saldo) : Number(p.valor)
    const desconto = Number(p.vl) > Number(p.valor) ? '<small>de ' + esc(C.brl(p.vl)) + '</small>' : ''
    const ent = p.entrega ? '<div class="cob-ent">' + C.I.caminhao + '<span><b>' + esc(p.entrega.label + ' ' + p.entrega.data) + '</b>' + (p.entrega.dias ? ' · ' + esc(p.entrega.dias) : '') + '</span></div>' : ''
    const pill = (cor, txt, ic) => '<span class="cob-pill" style="--s:' + esc(cor) + '" title="' + esc(txt) + '">' + (ic || '') + esc(txt) + '</span>'
    // A etapa so aparece na agenda e so quando NAO e a fila (Cobranca e o normal ali; o que vale avisar
    // e o pedido que ainda esta na rua ou esperando retirada). No quadro a coluna ja diz.
    const pills = (o.semColuna || p.col === 'Entregues' ? '' : C.chip(p.col))
      + (p.selo ? pill(p.selo.cor, p.selo.label, C.I.pacote) : '')
      + (p.pago ? pill('#10b981', 'Pago') : pill(p.mod === 'antecipado' ? '#10b981' : '#f59e0b', p.mod === 'antecipado' ? 'PG ANTECIPADO' : 'PG ENTREGA'))
      + (atras ? pill('#f0506a', 'Atrasado') : '')
      + (Array.isArray(p.tags) ? p.tags : []).slice(0, 3).map((t) => pill(t.cor || '#64748b', t.nome)).join('')
    return '<div class="crm-card cob-card" data-id="' + esc(p.id) + '"' + (o.arrasta ? ' draggable="true"' : '') + ' style="--c:' + (o.cor || C.colDef(p.col).cor) + '"'
      + ' title="Clique pra ver o pedido. O balão abre a conversa do cliente.">'
      + '<div class="cob-l1">' + C.I.pessoa + '<b title="' + esc(p.nome) + '">' + esc(p.nome) + '</b></div>'
      + (p.wa ? '<div class="cob-ln">' + C.I.fone + '<span>' + esc(C.foneBonito(p.wa)) + '</span></div>' : '')
      + linhaQ
      + '<div class="cob-v">' + esc(C.brl(valor)) + desconto + '</div>'
      + ent
      + (pills ? '<div class="cob-pills">' + pills + '</div>' : '')
      + '<div class="cob-pe"><span class="cob-av">' + esc(iniciais(p.atNome)) + '</span><span class="cob-vend">' + esc(p.atNome || 'Sem vendedor') + '</span>'
      + (p.uf || p.cidade ? '<span class="cob-uf" title="' + esc([p.cidade, p.uf].filter(Boolean).join('/')) + '">' + C.I.pino + esc(p.uf || p.cidade) + '</span>' : '')
      + '<button class="cob-zap" data-conversa="1" title="Abrir a conversa deste cliente">' + C.I.zap + '</button></div>'
      + '</div>'
  }

  function desenhaAgenda() {
    const ag = C.agenda(visiveis())
    resumo.innerHTML = '<span><b>' + ag.fila + '</b> na fila de cobrança</span>'
      + '<span><b>' + esc(C.brl([...ag.atrasados, ...ag.hoje, ...ag.proximos, ...ag.semRetorno, ...ag.contato.filter(C.naFila)].reduce((s, p) => s + (Number(p.saldo) || 0), 0))) + '</b> a receber</span>'
      + '<span><b>' + ag.pagosHoje.length + '</b> ' + (ag.pagosHoje.length === 1 ? 'pagou' : 'pagaram') + ' hoje · ' + esc(C.brl(ag.recebidoHoje)) + '</span>'
    // PROXIMOS POR DIA: "sexta" se planeja, "02/10" nao (o app de celular faz igual). A DIVISORIA
    // DIZ QUANTOS (03/11/2026, pedido do Bruno: "saber quantos vao chegar amanha, quantos na proxima
    // quinta"), e fica presa no topo enquanto ele rola os pedidos daquele dia.
    const porDia = []
    for (const p of ag.proximos) {
      const k = C.chaveDia(C.quandoAgend(p))
      const ult = porDia[porDia.length - 1]
      if (ult && ult.k === k) ult.itens.push(p)
      else porDia.push({ k, rot: C.rotuloDia(C.quandoAgend(p)), itens: [p] })
    }
    const prox = porDia.map((d) => '<div class="cob-grupo"><div class="cob-dia cob-dia-n"><b>' + esc(d.rot) + '</b><span>' + d.itens.length + (d.itens.length === 1 ? ' pedido' : ' pedidos') + '</span></div>'
      + d.itens.map((p) => cartao(p, { soHora: true })).join('') + '</div>').join('')
    // A ORDEM E A FILA DO DIA (03/11/2026, pedido do Bruno): primeiro o que ja passou (atrasados), o
    // que nunca teve dia (sem retorno), o de hoje, o que esta chegando e, por ultimo, o que tem dia
    // marcado mais pra frente.
    // ENTRARAM EM CONTATO VEM ANTES DE TUDO (03/11/2026): e cliente esperando resposta agora.
    corpo.innerHTML = coluna('contato', 'Entraram em contato', '#24c278', ag.contato.length, ag.contato.map((p) => cartao(p, { contato: true })).join(''), 'Ninguém esperando resposta')
      + coluna('atrasados', 'Atrasados', '#ef4444', ag.atrasados.length, ag.atrasados.map((p) => cartao(p)).join(''), 'Nenhum retorno atrasado')
      + coluna('sem', 'Sem retorno', '#f59e0b', ag.semRetorno.length, ag.semRetorno.map((p) => cartao(p)).join(''), 'Toda a fila tem dia marcado')
      + coluna('hoje', 'Hoje', '#3b82f6', ag.hoje.length, ag.hoje.map((p) => cartao(p)).join(''), 'Nenhum retorno pra hoje')
      + coluna('chegando', 'Chegando', '#818cf8', ag.chegando.length, ag.chegando.map((p) => cartao(p, { quando: false })).join(''), 'Nada a caminho')
      + coluna('proximos', 'Próximos', '#0ea5e9', ag.proximos.length, prox, 'Nada marcado pros próximos dias')
  }

  function desenhaKanban() {
    const l = visiveis()
    resumo.innerHTML = '<span>Arraste pra Pagos ou pra uma frustração. Pago pede o valor recebido; as etapas de entrega mudam sozinhas.</span>'
    const porCol = new Map()
    for (const p of l) { if (!porCol.has(p.col)) porCol.set(p.col, []); porCol.get(p.col).push(p) }
    const ordem = (a, b) => (Number(b.entrou) || 0) - (Number(a.entrou) || 0)   // o ultimo que entrou fica em cima
    let html = C.COLS.map((c) => {
      const itens = (porCol.get(c.id) || []).sort(ordem)
      return coluna(c.id, c.lbl, c.cor, itens.length, itens.map((p) => cartao(p, { arrasta: true, semColuna: true, quando: C.naFila(p) ? undefined : false })).join(''), C.DESTINOS_COB.includes(c.id) ? 'Arraste pedidos pra cá' : 'Nenhum pedido')
    }).join('')
    // A PERDA NUM ACORDEAO, como na dash: fechada ela e so a contagem, pra nao ocupar o quadro todo dia.
    const perda = C.PERDA.map((c) => ({ c, itens: (porCol.get(c.id) || []).sort(ordem) }))
    const nPerda = perda.reduce((s, x) => s + x.itens.length, 0)
    const conteudo = perdaAberta
      ? perda.map((x) => '<div class="cob-dia cob-dia-n" data-solta="' + esc(x.c.id) + '"><b>' + esc(x.c.lbl) + '</b><span>' + x.itens.length + '</span></div>' + x.itens.map((p) => cartao(p, { arrasta: true, semColuna: true, quando: false })).join('')).join('')
      : perda.map((x) => '<div class="cob-perda-l" data-perda="1" data-solta="' + esc(x.c.id) + '" style="--c:' + x.c.cor + '"><i></i>' + esc(x.c.lbl) + '<b>' + x.itens.length + '</b></div>').join('')
    html += coluna('perda', 'Frustrações', '#ef4444', nPerda, conteudo, '',
      '<button class="cob-perda-bt" data-perda="1">' + (perdaAberta ? 'Recolher' : 'Ver os pedidos') + '</button>')
    corpo.innerHTML = html
  }

  // ── cliques (delegados: o quadro e redesenhado inteiro a cada releitura) ─────────────────────
  corpo.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-perda]')) { perdaAberta = !perdaAberta; desenha(); return }
    const card = ev.target.closest('.cob-card')
    if (!card) return
    const p = dados.pedidos.find((x) => String(x.id) === card.dataset.id)
    if (!p) return
    if (ev.target.closest('[data-conversa]')) { ev.stopPropagation(); conversa(p, card); return }
    abreFicha(p.id)
  })
  corpo.addEventListener('contextmenu', (ev) => {
    const card = ev.target.closest && ev.target.closest('.cob-card')
    if (!card) return
    ev.preventDefault()
    const p = dados.pedidos.find((x) => String(x.id) === card.dataset.id)
    if (p) abreMenu(p, card, '')
  })

  // ARRASTAR NO KANBAN: as regras da dash. Entrar em Pagos pede o valor (abre a ficha com o botao
  // armado em vez de mover calado); sair de Pagos so pra perda.
  corpo.addEventListener('dragstart', (ev) => {
    const c = ev.target.closest && ev.target.closest('.cob-card')
    if (!c || aba !== 'kanban') return
    arrastando = { id: c.dataset.id }
    c.classList.add('arrastando')
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', c.dataset.id) } catch (_) { /* ok */ }
  })
  corpo.addEventListener('dragend', () => {
    arrastando = null
    for (const x of corpo.querySelectorAll('.arrastando, .alvo')) x.classList.remove('arrastando', 'alvo')
  })
  // O ALVO DO ARRASTO: a coluna (Pagos) ou uma linha de frustracao (fechada, cada linha e uma; aberta,
  // a divisoria de cada uma). So acende e so aceita o que o cobrador pode (C.podeIrCob).
  const alvoDe = (ev) => {
    const el = ev.target.closest && (ev.target.closest('[data-solta]') || ev.target.closest('.crm-col'))
    if (!el) return null
    const id = el.dataset.solta || el.dataset.col
    return id && id !== 'perda' ? { el, id } : null
  }
  const podeSoltar = (a, alvo) => {
    const p = a && alvo && dados.pedidos.find((x) => String(x.id) === String(a.id))
    return !!p && C.podeIrCob(p.col, alvo.id)
  }
  corpo.addEventListener('dragover', (ev) => {
    const alvo = alvoDe(ev)
    for (const x of corpo.querySelectorAll('.alvo')) if (!alvo || x !== alvo.el) x.classList.remove('alvo')
    if (!alvo || !arrastando || !podeSoltar(arrastando, alvo)) return
    ev.preventDefault()
    alvo.el.classList.add('alvo')
  })
  corpo.addEventListener('drop', (ev) => {
    const alvo = alvoDe(ev)
    const a = arrastando
    arrastando = null
    for (const x of corpo.querySelectorAll('.arrastando, .alvo')) x.classList.remove('arrastando', 'alvo')
    if (!alvo || !a || !podeSoltar(a, alvo)) return
    ev.preventDefault()
    move(a.id, alvo.id)
  })
  async function move(id, para) {
    const p = dados.pedidos.find((x) => String(x.id) === String(id))
    if (!p || p.col === para) return
    if (para === 'Pagos') { avisa('Confira o valor recebido e confirme na ficha.'); abreFicha(p.id); return }
    if (!C.podeIrCob(p.col, para)) { avisa('Por aqui o pedido só vai pra Pagos ou pra uma frustração. As etapas de entrega mudam sozinhas.'); return }
    // MOVE NA HORA e grava depois; a dash recusou, volta e diz por que.
    const antes = { col: p.col, colBruta: p.colBruta, spg: p.spg }
    p.col = para; p.colBruta = para; p.entrou = Date.now()
    desenha(); desenhaMini()
    let r = null
    try { r = await window.sw.cobSalva(p.id, { col: para, antes: { spg: antes.spg || '', col: antes.colBruta || '' } }) } catch (_) { r = null }
    if (r && r.ok) { sig = ''; busca(); return }
    p.col = antes.col; p.colBruta = antes.colBruta
    desenha(); desenhaMini()
    avisa('Não salvou: ' + ((r && r.erro) || 'a dash não respondeu') + '. O card voltou pra onde estava.')
  }

  // ── a ficha ─────────────────────────────────────────────────────────────────────────────────
  async function abreFicha(id) {
    fichaId = String(id)
    fichaPed = null
    ficha.hidden = false
    const p = dados.pedidos.find((x) => String(x.id) === fichaId)
    fichaCorpo.innerHTML = '<div class="cob-carrega">' + esc(p ? p.nome : 'Pedido') + '<br>buscando a ficha na dash...</div>'
    await recarregaFicha(false)
  }
  async function recarregaFicha(quieto) {
    const id = fichaId
    if (!id) return
    let r = null
    try { r = await window.sw.cobPedido(id) } catch (_) { r = null }
    if (id !== fichaId || ficha.hidden) return
    const det = r && r.ok && Array.isArray(r.pedidos) ? r.pedidos[0] : null
    if (!det) { if (!quieto) fichaCorpo.innerHTML = '<div class="cob-carrega">' + esc((r && r.erro) || 'Esse pedido não está mais na lista.') + '</div>'; return }
    // Releitura em segundo plano nao redesenha no meio do que ele esta digitando.
    if (quieto && fichaCorpo.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return
    fichaPed = det
    fichaCorpo.innerHTML = C.fichaHtml(det, { conversa: true, prontos: dados.prontos, tags: dados.tags })
    C.ligaFicha(fichaCorpo, det, {
      salva: (pid, patch) => window.sw.cobSalva(pid, patch),
      copiar: (t) => window.sw.copiar(t),
      abrirLink: (u) => window.sw.abrirLink(u),
      curto: (u, pid) => window.sw.cobCurto(u, pid),
      conversa: (p, b) => conversa(p, b),
      recarrega: async () => { sig = ''; await Promise.all([busca(), recarregaFicha(false)]) },
    })
  }
  function fechaFicha() { ficha.hidden = true; fichaId = ''; fichaPed = null }

  // ── abrir a conversa do cliente ─────────────────────────────────────────────────────────────
  async function conversa(p, ancora, nk) {
    let r = null
    try { r = await window.sw.cobConversa(p.wa, nk || '') } catch (_) { r = null }
    if (r && r.semNumero) { abreMenu(p, ancora, r.erro || 'Escolha por qual número chamar.'); return }
    if (!r || !r.ok) { avisa((r && r.erro) || 'Não consegui abrir essa conversa agora.'); return }
    menu.hidden = true
    desenhaAberto(false)
    fechaFicha()
    // NUMERO FECHADO: abre pelo caminho de sempre da lista; a conversa abre sozinha quando o
    // WhatsApp dele ficar pronto (crmPendente no main).
    if (r.fechado && r.numero && typeof abrir === 'function') abrir(r.numero)
    if (r.aviso) avisa(r.aviso)
  }
  // POR QUAL NUMERO: a lista dele inteira, aberto ou fechado (o fechado abre e a conversa vem
  // sozinha). E a contingencia: o numero de sempre caiu, ele chama pelo outro.
  let menuDe = null
  function abreMenu(p, ancora, porque) {
    menuDe = p
    const nums = (typeof estado !== 'undefined' && estado && Array.isArray(estado.numeros)) ? estado.numeros.filter((n) => n && !n.banido) : []
    const abertos = (typeof estado !== 'undefined' && estado && Array.isArray(estado.abertos)) ? estado.abertos : []
    const nk = (n) => String(n.numero || '').replace(/\D/g, '').replace(/^55/, '').replace(/^(\d\d)9(\d{8})$/, '$1$2')
    let html = '<div class="tit">' + esc(porque || ('Chamar ' + (p.nome || 'o cliente') + ' por:')) + '</div>'
    html += nums.length
      ? nums.map((n) => {
        const ab = abertos.includes(nk(n))
        const st = /restrit/i.test(String(n.status || '')) ? 'restrito' : (ab ? 'aberto' : 'fechado, abre agora')
        return '<button data-num="' + esc(n.numero) + '">' + C.I.zap + ' ' + esc(C.foneBonito(n.numero)) + '<small>' + esc(st) + '</small></button>'
      }).join('')
      : '<div class="vazio">Você ainda não tem número. Peça pra direção pôr um no seu nome na Contingência.</div>'
    html += '<hr><button data-copiar="+55' + esc(String(p.wa || '').replace(/^55(?=\d{10,11}$)/, '')) + '">' + C.I.copia + ' Copiar o telefone<small>' + esc(C.foneBonito(p.wa)) + '</small></button>'
    menu.innerHTML = html
    menu.hidden = false
    const rb = caixa.getBoundingClientRect()
    const ra = ancora && ancora.getBoundingClientRect ? ancora.getBoundingClientRect() : { left: rb.width / 2 - 120, bottom: 120, top: 100 }
    const larg = menu.offsetWidth || 240, alt = menu.offsetHeight || 160
    let x = ra.left - rb.left, y = ra.bottom - rb.top + 4
    if (x + larg > rb.width - 8) x = Math.max(8, rb.width - larg - 8)
    if (y + alt > rb.height - 8) y = Math.max(8, ra.top - rb.top - alt - 4)
    menu.style.left = x + 'px'; menu.style.top = y + 'px'
  }
  menu.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button')
    if (!b || !menuDe) return
    const p = menuDe
    menu.hidden = true
    if (b.dataset.copiar) { let r = null; try { r = await window.sw.copiar(b.dataset.copiar) } catch (_) { r = null } avisa(r && r.ok ? 'Telefone copiado: ' + b.dataset.copiar : 'Não consegui copiar. O telefone é ' + b.dataset.copiar); return }
    if (b.dataset.num) conversa(p, null, b.dataset.num)
  })
  document.addEventListener('mousedown', (ev) => { if (!menu.hidden && !menu.contains(ev.target) && !ev.target.closest('[data-conversa]')) menu.hidden = true })

  let avisoT = 0
  function avisa(txt) {
    aviso.textContent = txt
    aviso.hidden = false
    clearTimeout(avisoT)
    avisoT = setTimeout(() => { aviso.hidden = true }, 6000)
  }

  // ── o lembrete do retorno ───────────────────────────────────────────────────────────────────
  // Na hora marcada sai um aviso do Windows (uma vez por pedido e por horario: remarcou, avisa de
  // novo). So os DELE (a mesma regra do "so os meus"), e so o que chegou na hora agora: atraso de
  // ontem nao vira uma rajada de avisos quando ele abre o app de manha, ele ja esta na coluna.
  let avisados = new Set()
  try { avisados = new Set(JSON.parse(le('sw-cob-avisados') || '[]')) } catch (_) { avisados = new Set() }
  function lembretes() {
    if (!carregou || !modo()) return
    const agora = Date.now()
    for (const p of dados.pedidos) {
      if (!C.naFila(p) || (dados.eu && p.cob && p.cob !== dados.eu)) continue
      const t = C.quandoAgend(p)
      if (isNaN(t) || t > agora || agora - t > 10 * 60000) continue
      const k = p.id + '@' + p.agend
      if (avisados.has(k)) continue
      avisados.add(k)
      try { window.sw.cobLembrete({ id: p.id, nome: p.nome, quando: C.quandoTxt(t) }) } catch (_) { /* aviso e conforto */ }
    }
    const lista = [...avisados].slice(-300)
    avisados = new Set(lista)
    guarda('sw-cob-avisados', JSON.stringify(lista))
  }
  setInterval(lembretes, 30000)

  // pro teste e pra quem for depurar na maquina do cobrador
  window.__swCob = {
    abre, fecha, busca, abreFicha, fechaFicha, move,
    estado: () => ({ aberto, aba, soMeus, carregou, n: dados.pedidos.length, erro, sig, fichaId, ficha: !ficha.hidden, visiveis: visiveis().length }),
  }
})()
