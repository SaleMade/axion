// A COBRANCA NO SELLWAVE WEB (31/10/2026, pedido do Bruno: "uma versao do aplicativo para os
// cobradores", com os numeros dele, os funis de cobranca, o Kanban de pedidos e uma agenda de quem
// cobrar). Este arquivo e o pedaco COMUM das duas telas que mostram pedido:
//   - a CASCA (index.html + cobranca.js): o quadro e a agenda, no pe da area do WhatsApp;
//   - o PAINEL (painel.html + painel-ui.js): a ficha do cliente da conversa aberta, ao lado.
// As duas desenham a MESMA ficha e chamam a MESMA regra de agenda. Duas copias de "atrasado" ja
// deram quatro numeros diferentes na dash (ver pages/app/cobranca.js); aqui e uma so.
//
// O QUE VEM PRONTO DO SERVIDOR (/api/swweb/cobranca, ver _cobLinha no worker): coluna ja resolvida
// pelo apelido, valor a cobrar, pago, selo de entrega, "Entregue em", hora em que entrou na coluna.
// O que fica aqui e so o que depende do RELOGIO da maquina: o `agend` e hora de Brasilia sem fuso,
// e a maquina do cobrador esta em Brasilia (o app de celular le igual).
//
// GRAVAR passa pelas rotas da dash (/api/lead/:id com patch), com o login de quem esta no app. Quem
// decide o que o cobrador pode mudar e o servidor (canManage no handleUpdateLead), nao esta tela.
;(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  // AS COLUNAS E AS CORES DO KANBAN DA DASH (lib/crm-leads.js, KB_COLS e KB_COLS_PERDA), na mesma ordem.
  const COLS = [
    { id: 'A Enviar', lbl: 'A enviar', cor: '#94a3b8' },
    { id: 'Preparando', lbl: 'Preparando', cor: '#a855f7' },
    { id: 'Enviados', lbl: 'Enviado', cor: '#06b6d4' },
    { id: 'Saiu para Entrega', lbl: 'Saiu para Entrega', cor: '#818cf8' },
    { id: 'Entregues', lbl: 'Cobrança', cor: '#fbbf24' },
    { id: 'Retirar nos Correios', lbl: 'Retirar nos Correios', cor: '#a3e635' },
    { id: 'Requer Atenção', lbl: 'Requer Atenção', cor: '#f43f5e' },
    { id: 'Pagos', lbl: 'Pagos', cor: '#10b981' },
  ]
  const PERDA = [
    { id: 'Frustrados', lbl: 'Frustrados', cor: '#ef4444' },
    { id: 'Roubos', lbl: 'Roubos', cor: '#b91c1c' },
    { id: 'Devolvido com Reverso', lbl: 'Devolvido', cor: '#fb923c' },
    { id: 'Retornado', lbl: 'Retornado', cor: '#a855f7' },
    { id: 'Cancelado sem Custo', lbl: 'Cancelado', cor: '#64748b' },
  ]
  const TODAS = [...COLS, ...PERDA.filter((c) => !COLS.some((x) => x.id === c.id))]
  const colDef = (id) => TODAS.find((c) => c.id === id) || { id: String(id || ''), lbl: String(id || 'Sem etapa'), cor: '#64748b' }
  // Sair de Pagos so pra perda (SAIDAS_DE_PAGOS da dash): Pagos e dinheiro que entrou, e tirar dali
  // por engano apaga uma venda da contabilidade sem rastro.
  const SAIDAS_DE_PAGOS = PERDA.map((c) => c.id)

  // A FILA DE COBRANCA e o que esta CHEGANDO: as mesmas duas listas do app de celular do cobrador
  // (pages/app/cobranca.js). Retirar nos Correios entra na fila por decisao do Bruno (06/10).
  const COLS_COBRANCA = ['Entregues', 'Retirar nos Correios']
  const COLS_A_CAMINHO = ['Enviados', 'Saiu para Entrega']
  const naFila = (p) => !!p && !p.pago && COLS_COBRANCA.includes(p.col)
  const aCaminho = (p) => !!p && !p.pago && COLS_A_CAMINHO.includes(p.col)
  const quandoAgend = (p) => {
    const s = String((p && p.agend) || '').trim()
    if (!s) return NaN
    const t = Date.parse(s)
    return isNaN(t) ? NaN : t
  }
  const diaIni = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
  // A CHAVE DO DIA EM HORA LOCAL. toISOString converteria pra UTC e, depois das 21h, o retorno de
  // hoje cairia amanha.
  const chaveDia = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  const DIAS_SEM = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
  function rotuloDia(ms, agora) {
    const alvo = diaIni(ms), hoje = diaIni(agora || Date.now())
    const dif = Math.round((alvo - hoje) / 86400000)
    const d = new Date(ms)
    const curto = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
    if (dif === 0) return 'Hoje · ' + curto
    if (dif === 1) return 'Amanhã · ' + curto
    if (dif === -1) return 'Ontem · ' + curto
    return DIAS_SEM[d.getDay()] + ' · ' + curto
  }
  const hora = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const quandoTxt = (ms, agora) => (isNaN(ms) ? '' : rotuloDia(ms, agora).split(' · ')[0] + ' ' + hora(ms))

  // A AGENDA, na ordem em que ele trabalha: o que venceu, o que e hoje, o que vem, a fila que ninguem
  // marcou e o que esta chegando. A regra de cada grupo e a do app de celular (agendaDoCobrador).
  function agenda(pedidos, agora) {
    agora = agora || Date.now()
    const todos = Array.isArray(pedidos) ? pedidos : []
    const hojeIni = diaIni(agora), hojeFim = hojeIni + 86400000
    const atrasados = [], hoje = [], proximos = [], semRetorno = []
    for (const p of todos) {
      if (!naFila(p)) continue
      const t = quandoAgend(p)
      if (isNaN(t)) { semRetorno.push(p); continue }
      if (t < hojeIni) atrasados.push(p)
      else if (t < hojeFim) hoje.push(p)
      else proximos.push(p)
    }
    const porAgend = (a, b) => quandoAgend(a) - quandoAgend(b)
    atrasados.sort(porAgend); hoje.sort(porAgend); proximos.sort(porAgend)
    semRetorno.sort((a, b) => (Number(b.saldo) || Number(b.valor) || 0) - (Number(a.saldo) || Number(a.valor) || 0))
    // CHEGANDO: o que saiu e ainda nao chegou. Quem ja esta na rua (Saiu para Entrega) vem primeiro:
    // chega hoje, e e o primeiro a virar cobranca.
    const chegando = todos.filter(aCaminho).sort((a, b) => (a.col === b.col ? (Number(b.entrou) || 0) - (Number(a.entrou) || 0) : (a.col === 'Saiu para Entrega' ? -1 : 1)))
    // O QUE ENTROU HOJE, pela data do PAGAMENTO, so do que passou pela cobranca (venda de cartao que
    // nasce paga nunca esteve na fila).
    const pagosHoje = todos.filter((p) => p.pago && p.vc && Number(p.pagoTs) >= hojeIni && Number(p.pagoTs) < hojeFim)
    return {
      atrasados, hoje, proximos, semRetorno, chegando, pagosHoje,
      recebidoHoje: pagosHoje.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      fila: atrasados.length + hoje.length + proximos.length + semRetorno.length,
    }
  }

  // ── valores ──────────────────────────────────────────────────────────────────────────────────
  // O parseMoney da dash (lib/pagamentos.js): virgula e o decimal, ponto e o milhar. "1.000,50" e
  // mil reais e cinquenta; Number("1.000,50") daria NaN e "297.5" viraria 2975 se lido ao contrario.
  function valorDigitado(s) {
    let t = String(s == null ? '' : s).trim().replace(/[^\d.,-]/g, '')
    if (!t) return NaN
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
    const n = Number(t)
    return isFinite(n) ? n : NaN
  }
  const valorCampo = (v) => (Number(v) || 0).toFixed(2).replace('.', ',')
  const p2 = (n) => String(n).padStart(2, '0')
  const agendDe = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  // Os atalhos de retorno: a mao do cobrador e "liga de novo daqui a pouco" ou "amanha cedo".
  function atalhosRetorno(agora) {
    const a = new Date(agora || Date.now())
    const umaHora = new Date(a.getTime() + 3600000); umaHora.setMinutes(Math.ceil(umaHora.getMinutes() / 5) * 5, 0, 0)
    const dia = (n, h) => { const d = new Date(a); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return d }
    const out = [{ rot: 'Daqui 1 h', v: agendDe(umaHora) }]
    if (a.getHours() < 17) out.push({ rot: 'Hoje 18h', v: agendDe(dia(0, 18)) })
    out.push({ rot: 'Amanhã 9h', v: agendDe(dia(1, 9)) }, { rot: 'Amanhã 14h', v: agendDe(dia(1, 14)) }, { rot: 'Em 2 dias', v: agendDe(dia(2, 9)) })
    return out
  }
  const foneBonito = (f) => {
    let d = String(f || '').replace(/\D/g, '')
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7)
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6)
    return d
  }
  const chip = (col) => { const c = colDef(col); return '<span class="fx-col" style="--c:' + c.cor + '">' + esc(c.lbl) + '</span>' }

  // ── icones (lucide, em linha: a CSP das duas paginas nao carrega nada de fora) ───────────────
  const I = {
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
    copia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    abre: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    envia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    relogio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    caminhao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>',
    balao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  }

  // ── A FICHA ──────────────────────────────────────────────────────────────────────────────────
  // ctx: { enviar: bool (o painel manda na conversa aberta), conversa: bool (a casca abre a
  //        conversa), prontos: [frases], agora: ms, armado: '' }
  const LINKS = [
    { k: 'pix', rot: 'Pix', frase: 'Segue o link para pagamento via Pix:' },
    { k: 'boleto', rot: 'Boleto', frase: 'Segue o link para pagamento via boleto:' },
    { k: 'cartao', rot: 'Cartão', frase: 'Segue o link para pagamento no cartão:' },
    { k: 'checkout', rot: 'Checkout', frase: 'Segue o link para pagamento:' },
  ]
  function fichaHtml(p, ctx) {
    ctx = ctx || {}
    const agora = ctx.agora || Date.now()
    const ag = quandoAgend(p)
    const atrasado = naFila(p) && !isNaN(ag) && ag < agora
    const desconto = Number(p.vl) > Number(p.valor) ? '<small>de ' + esc(brl(p.vl)) + '</small>' : ''
    const linhaSub = [p.prod, [p.cidade, p.uf].filter(Boolean).join('/'), p.atNome ? 'vendeu: ' + p.atNome : ''].filter(Boolean)
    let h = '<div class="fx" data-id="' + esc(p.id) + '">'
    // cabecalho
    h += '<div class="fx-cab"><div class="fx-nome"><b>' + esc(p.nome) + '</b>' + chip(p.col) + (p.pago ? '<span class="fx-pago">' + I.ok + 'Pago</span>' : '') + '</div>'
      + '<div class="fx-valor">' + esc(brl(p.valor)) + desconto + '</div></div>'
    if (linhaSub.length) h += '<div class="fx-sub">' + esc(linhaSub.join(' · ')) + '</div>'
    // telefone + conversa
    h += '<div class="fx-linha">'
      + '<button class="fx-mini" data-acao="copiar" data-v="+55' + esc(String(p.wa || '').replace(/^55(?=\d{10,11}$)/, '')) + '" title="Copiar o telefone">' + I.copia + esc(foneBonito(p.wa)) + '</button>'
      + (ctx.conversa ? '<button class="fx-bt fx-verde" data-acao="conversa" title="Abrir a conversa deste cliente num dos seus números">' + I.zap + 'Abrir conversa</button>' : '')
      + '</div>'
    // entrega
    const ent = []
    if (p.selo) ent.push('<span class="fx-selo" style="--c:' + esc(p.selo.cor) + '">' + esc(p.selo.label) + (p.selo.quando ? ' · ' + esc(p.selo.quando) : '') + '</span>')
    if (p.entrega) ent.push('<span class="fx-ap">' + esc(p.entrega.label + ' ' + p.entrega.data + (p.entrega.dias ? ' · ' + p.entrega.dias : '')) + '</span>')
    if (p.track) ent.push('<span class="fx-ap">' + esc((p.transp ? p.transp + ' ' : '') + p.track) + '</span>')
    if (ent.length || (p.links && p.links.rastreio)) {
      h += '<div class="fx-bloco"><div class="fx-tit">' + I.caminhao + 'Entrega</div><div class="fx-wrap">' + ent.join('') + '</div>'
      if (p.links && p.links.rastreio) h += linkLinha({ k: 'rastreio', rot: 'Rastreio', frase: 'Segue o link para acompanhar a entrega do seu pedido:' }, p.links.rastreio, ctx)
      h += '</div>'
    }
    // retorno
    h += '<div class="fx-bloco"><div class="fx-tit">' + I.relogio + 'Retorno'
      + (isNaN(ag) ? '<span class="fx-ap">sem retorno marcado</span>' : '<span class="fx-quando' + (atrasado ? ' atrasado' : '') + '">' + esc(quandoTxt(ag, agora)) + (atrasado ? ' · atrasado' : '') + '</span>')
      + '</div><div class="fx-wrap">'
      + atalhosRetorno(agora).map((a) => '<button class="fx-mini" data-acao="agend" data-v="' + a.v + '">' + esc(a.rot) + '</button>').join('')
      + '<input class="fx-data" type="datetime-local" value="' + esc(isNaN(ag) ? '' : String(p.agend).slice(0, 16)) + '">'
      + '<button class="fx-mini" data-acao="agend-campo">Marcar</button>'
      + (p.agend ? '<button class="fx-mini fx-fraco" data-acao="agend" data-v="">Tirar</button>' : '')
      + '</div></div>'
    // pagamento
    h += '<div class="fx-bloco"><div class="fx-tit">' + I.ok + 'Pagamento</div>'
    if (p.pago) {
      h += '<div class="fx-ap">Recebido ' + esc(brl(p.valor)) + (p.pagoTs ? ' em ' + esc(new Date(Number(p.pagoTs)).toLocaleDateString('pt-BR')) : '') + '.</div>'
    } else {
      const armado = ctx.armado === 'pago'
      h += '<div class="fx-wrap"><label class="fx-rot">Valor recebido</label><input class="fx-valor-in" inputmode="decimal" value="' + esc(valorCampo(p.valor)) + '">'
        + '<button class="fx-bt ' + (armado ? 'fx-alerta' : 'fx-verde') + '" data-acao="pago">' + (armado ? 'Confirmar recebimento' : 'Marcar como pago') + '</button></div>'
      const links = LINKS.filter((l) => p.links && p.links[l.k])
      if (links.length) h += links.map((l) => linkLinha(l, p.links[l.k], ctx)).join('')
      else if (p.links) h += '<div class="fx-ap">Sem link de pagamento cadastrado para este pedido.</div>'
    }
    h += '</div>'
    // etapa
    const opcoes = (p.col === 'Pagos' ? PERDA : TODAS.filter((c) => c.id !== 'Pagos'))
      .filter((c) => c.id !== p.col)
    h += '<div class="fx-bloco"><div class="fx-tit">Etapa</div><div class="fx-wrap"><select class="fx-etapa"><option value="">Mudar para...</option>'
      + opcoes.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.lbl) + '</option>').join('') + '</select>'
      + '<button class="fx-mini" data-acao="etapa">Mover</button></div>'
      + (p.col === 'Pagos' ? '<div class="fx-ap">Pedido pago só sai para Frustrados, Roubos, Devolvido, Retornado ou Cancelado.</div>' : '')
      + '</div>'
    // comentarios
    const coms = Array.isArray(p.comentarios) ? p.comentarios : []
    h += '<div class="fx-bloco"><div class="fx-tit">' + I.balao + 'Comentários' + (coms.length ? '<span class="fx-ap">' + coms.length + '</span>' : '') + '</div>'
      + (Array.isArray(ctx.prontos) && ctx.prontos.length ? '<div class="fx-wrap fx-prontos">' + ctx.prontos.map((t) => '<button class="fx-mini fx-fraco" data-acao="pronto" data-v="' + esc(t) + '">' + esc(t) + '</button>').join('') + '</div>' : '')
      + '<div class="fx-com-novo"><textarea class="fx-com" rows="2" placeholder="Escreva o que combinou com o cliente"></textarea><button class="fx-bt" data-acao="comentar">Salvar</button></div>'
      + coms.slice(0, 12).map((c) => '<div class="fx-com-item"><div><b>' + esc(c.quem || 'alguém') + '</b><time>' + esc(c.quando) + '</time></div><p>' + esc(c.tipo === 'image' ? '[imagem] ' + (c.tx || '') : c.tx) + '</p></div>').join('')
      + '</div>'
    // historico
    const hist = Array.isArray(p.hist) ? p.hist.slice(-6).reverse() : []
    if (hist.length) {
      h += '<div class="fx-bloco"><div class="fx-tit">Histórico</div>'
        + hist.map((x) => '<div class="fx-hist"><time>' + esc(x.quando) + '</time><span>' + esc((x.de ? x.de + ' → ' : '') + x.para) + (x.quem ? ' · ' + esc(x.quem) : '') + (x.nota ? ' · ' + esc(x.nota) : '') + '</span></div>').join('')
        + '</div>'
    }
    h += '<div class="fx-msg" hidden></div></div>'
    return h
  }
  function linkLinha(l, url, ctx) {
    return '<div class="fx-link"><span>' + esc(l.rot) + '</span>'
      + (ctx.enviar ? '<button class="fx-mini fx-verde" data-acao="enviar" data-k="' + l.k + '" title="Mandar o link na conversa aberta">' + I.envia + 'Enviar</button>' : '')
      + '<button class="fx-mini" data-acao="copiar-link" data-k="' + l.k + '" title="Copiar o link">' + I.copia + 'Copiar</button>'
      + '<button class="fx-mini" data-acao="abrir-link" data-k="' + l.k + '" title="Abrir no navegador">' + I.abre + '</button></div>'
  }
  const FRASE = { rastreio: 'Segue o link para acompanhar a entrega do seu pedido:' }
  for (const l of LINKS) FRASE[l.k] = l.frase

  // LIGA OS BOTOES DA FICHA. `ad` e o adaptador da tela que hospeda:
  //   salva(id, patch) -> { ok, erro, negados }   copiar(texto) -> { ok }
  //   abrirLink(url)   curto(url, id) -> { ok, url }   conversa?(p)   enviar?(texto) -> { ok, erro }
  //   recarrega() -> relê a ficha e redesenha (depois de gravar)
  function ligaFicha(raiz, p, ad, ctx) {
    const fx = raiz.querySelector('.fx[data-id="' + CSS.escape(String(p.id)) + '"]') || raiz.querySelector('.fx')
    if (!fx) return
    const msg = fx.querySelector('.fx-msg')
    const diz = (t, erro) => { if (!msg) return; msg.textContent = t; msg.className = 'fx-msg' + (erro ? ' erro' : ''); msg.hidden = !t; clearTimeout(msg.__t); if (t) msg.__t = setTimeout(() => { msg.hidden = true }, 6000) }
    let ocupado = false
    const grava = async (patch, ok) => {
      if (ocupado) return
      ocupado = true
      fx.classList.add('fx-salvando')
      let r = null
      try { r = await ad.salva(p.id, patch) } catch (e) { r = { ok: false, erro: String((e && e.message) || e) } }
      ocupado = false
      fx.classList.remove('fx-salvando')
      if (!r || !r.ok) { diz('Não salvou: ' + ((r && r.erro) || 'a dash não respondeu') + '.', true); return }
      if (Array.isArray(r.negados) && r.negados.length) { diz('A dash não deixou mudar: ' + r.negados.join(', ') + '.', true); return }
      diz(ok || 'Salvo.')
      try { await ad.recarrega(ok) } catch (_) { /* a releitura seguinte acerta */ }
    }
    const linkDe = (k) => (p.links && p.links[k]) || ''
    fx.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-acao]')
      if (!b || !fx.contains(b)) return
      const acao = b.dataset.acao
      if (acao === 'copiar') { const r = await ad.copiar(b.dataset.v); diz(r && r.ok ? 'Telefone copiado.' : 'Não consegui copiar.', !(r && r.ok)); return }
      if (acao === 'conversa') { if (ad.conversa) ad.conversa(p, b); return }
      if (acao === 'agend') {
        const v = b.dataset.v
        await grava({ agend: v }, v ? 'Retorno marcado: ' + quandoTxt(Date.parse(v), Date.now()) + '.' : 'Retorno tirado.')
        return
      }
      if (acao === 'agend-campo') {
        const v = String((fx.querySelector('.fx-data') || {}).value || '').slice(0, 16)
        if (!v) { diz('Escolha o dia e a hora.', true); return }
        await grava({ agend: v }, 'Retorno marcado: ' + quandoTxt(Date.parse(v), Date.now()) + '.')
        return
      }
      if (acao === 'pago') {
        const v = valorDigitado((fx.querySelector('.fx-valor-in') || {}).value)
        if (!(v > 0)) { diz('Escreva o valor que o cliente pagou.', true); return }
        // DOIS CLIQUES, como tudo que nao tem desfazer simples: o primeiro arma e diz o valor.
        if (b.dataset.armado !== '1') {
          b.dataset.armado = '1'; b.className = 'fx-bt fx-alerta'; b.textContent = 'Confirmar ' + brl(v)
          setTimeout(() => { if (b.isConnected && b.dataset.armado === '1') { b.dataset.armado = ''; b.className = 'fx-bt fx-verde'; b.textContent = 'Marcar como pago' } }, 6000)
          return
        }
        // A MESMA CHAMADA DO "JA PAGOU" DA DASH: spg, valor e coluna numa gravacao so, com o `antes`
        // pra recusar se outra pessoa mexeu no pedido desde que a ficha abriu.
        await grava({ spg: 'Pago', valor_neg: v, col: 'Pagos', antes: { spg: p.spg || '', col: p.colBruta || '' } }, 'Pago: ' + brl(v) + '.')
        return
      }
      if (acao === 'etapa') {
        const para = String((fx.querySelector('.fx-etapa') || {}).value || '')
        if (!para) { diz('Escolha a etapa.', true); return }
        if (p.col === 'Pagos' && !SAIDAS_DE_PAGOS.includes(para)) { diz('Pedido pago só sai para uma coluna de perda.', true); return }
        await grava({ col: para, antes: { spg: p.spg || '', col: p.colBruta || '' } }, 'Movido para ' + colDef(para).lbl + '.')
        return
      }
      if (acao === 'pronto') {
        const ta = fx.querySelector('.fx-com')
        if (ta) { ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + b.dataset.v; ta.focus() }
        return
      }
      if (acao === 'comentar') {
        const ta = fx.querySelector('.fx-com')
        const tx = String((ta && ta.value) || '').trim()
        if (!tx) { diz('Escreva o comentário.', true); return }
        // SEM `who`: o servidor carimba quem esta logado (no "ver como", a direcao, nunca a pessoa do preview).
        await grava({ comment_add: { tx } }, 'Comentário salvo.')
        return
      }
      if (acao === 'copiar-link' || acao === 'abrir-link' || acao === 'enviar') {
        const k = b.dataset.k
        const longo = linkDe(k)
        if (!longo) return
        if (acao === 'abrir-link') { ad.abrirLink(longo); return }
        // O LINK CURTO e o mesmo da dash (POST /api/short); dominio que o encurtador nao aceita sai inteiro.
        let url = longo
        try { const c = await ad.curto(longo, p.id); if (c && c.ok && c.url) url = c.url } catch (_) { /* vai o longo */ }
        if (acao === 'copiar-link') { const r = await ad.copiar(url); diz(r && r.ok ? 'Link copiado.' : 'Não consegui copiar.', !(r && r.ok)); return }
        if (!ad.enviar) return
        const r = await ad.enviar(FRASE[k] + ' ' + url)
        diz(r && r.ok ? 'Mandando na conversa.' : ((r && r.erro) || 'Não consegui mandar.'), !(r && r.ok))
      }
    })
  }

  // ── o estilo da ficha: usa os tokens das duas paginas (--texto, --apagado, --linha, --verde) ──
  const CSS_FICHA = `
  .fx { display: flex; flex-direction: column; gap: 10px; font-size: 12.5px; color: var(--texto); }
  .fx.fx-salvando { opacity: .6; pointer-events: none; }
  .fx svg { width: 13px; height: 13px; flex: 0 0 auto; }
  .fx-cab { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .fx-nome { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .fx-nome b { font-size: 14px; font-weight: 700; }
  .fx-valor { text-align: right; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fx-valor small { display: block; font-size: 10.5px; font-weight: 500; color: var(--apagado); text-decoration: line-through; }
  .fx-sub { color: var(--apagado); font-size: 11.5px; margin-top: -6px; }
  .fx-col { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 99px; font-size: 10.5px; font-weight: 700;
    color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); border: 1px solid color-mix(in srgb, var(--c) 35%, transparent); white-space: nowrap; }
  .fx-pago { display: inline-flex; align-items: center; gap: 3px; color: #10b981; font-size: 11px; font-weight: 700; }
  .fx-linha, .fx-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .fx-bloco { border-top: 1px solid var(--linha); padding-top: 9px; display: flex; flex-direction: column; gap: 7px; }
  .fx-tit { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--apagado); }
  .fx-tit .fx-ap, .fx-tit .fx-quando { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 600; }
  .fx-quando { color: #60a5fa; }
  .fx-quando.atrasado { color: #f0506a; }
  .fx-ap { color: var(--apagado); font-size: 11.5px; }
  .fx-selo { padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 650; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
  .fx-mini, .fx-bt { display: inline-flex; align-items: center; gap: 5px; border-radius: 8px; font-size: 11.5px; white-space: nowrap;
    border: 1px solid var(--linha); padding: 4px 8px; color: var(--texto); background: rgba(255, 255, 255, .03); cursor: pointer; }
  .fx-mini:hover, .fx-bt:hover { background: rgba(255, 255, 255, .08); }
  .fx-bt { padding: 6px 11px; font-weight: 650; }
  .fx-verde { background: color-mix(in srgb, var(--verde) 18%, transparent); border-color: color-mix(in srgb, var(--verde) 45%, transparent); color: var(--texto); }
  .fx-verde:hover { background: color-mix(in srgb, var(--verde) 28%, transparent); }
  .fx-alerta { background: rgba(245, 165, 36, .2); border-color: rgba(245, 165, 36, .55); }
  .fx-fraco { color: var(--apagado); }
  .fx-data, .fx-valor-in, .fx-etapa, .fx-com { font: inherit; color: var(--texto); background: rgba(255, 255, 255, .04); border: 1px solid var(--linha); border-radius: 8px; padding: 4px 7px; outline: none; }
  .fx-data:focus, .fx-valor-in:focus, .fx-etapa:focus, .fx-com:focus { border-color: color-mix(in srgb, var(--verde) 60%, transparent); }
  .fx-etapa option { background: #1d2330; }
  .fx-valor-in { width: 92px; font-variant-numeric: tabular-nums; }
  .fx-data { color-scheme: dark; }
  .fx-rot { font-size: 11px; color: var(--apagado); }
  .fx-link { display: flex; align-items: center; gap: 6px; }
  .fx-link > span { min-width: 64px; font-weight: 650; }
  .fx-prontos .fx-mini { white-space: normal; text-align: left; }
  .fx-com-novo { display: flex; gap: 6px; align-items: flex-end; }
  .fx-com { flex: 1; resize: vertical; min-height: 38px; }
  .fx-com-item { padding: 6px 8px; border-radius: 8px; background: rgba(255, 255, 255, .03); }
  .fx-com-item div { display: flex; gap: 8px; font-size: 11px; }
  .fx-com-item time, .fx-hist time { color: var(--apagado); font-variant-numeric: tabular-nums; }
  .fx-com-item p { margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
  .fx-hist { display: flex; gap: 8px; font-size: 11px; color: var(--apagado); }
  .fx-hist span { color: var(--texto); }
  .fx-msg { position: sticky; bottom: 0; padding: 7px 10px; border-radius: 8px; font-size: 12px; background: color-mix(in srgb, var(--verde) 20%, #10151d); border: 1px solid color-mix(in srgb, var(--verde) 40%, transparent); }
  .fx-msg.erro { background: rgba(240, 80, 106, .16); border-color: rgba(240, 80, 106, .4); }
  .fx-msg[hidden] { display: none; }
  `
  function poeEstilo() {
    if (document.getElementById('fx-estilo')) return
    const s = document.createElement('style')
    s.id = 'fx-estilo'
    s.textContent = CSS_FICHA
    document.head.appendChild(s)
  }

  window.SWCob = {
    esc, brl, COLS, PERDA, TODAS, colDef, chip, SAIDAS_DE_PAGOS, COLS_COBRANCA, COLS_A_CAMINHO,
    naFila, aCaminho, quandoAgend, agenda, rotuloDia, hora, quandoTxt, chaveDia, diaIni,
    valorDigitado, atalhosRetorno, foneBonito, fichaHtml, ligaFicha, poeEstilo, I,
  }
})()
