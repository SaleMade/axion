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
  // PRA ONDE O COBRADOR LEVA UM PEDIDO (03/11/2026, pedido do Bruno: "que as duas ferramentas estejam
  // sincronizadas"): so Pagos (pedindo o valor) e as perdas. As etapas de entrega quem move e a
  // Five/PayLog. A trava de verdade e do servidor (handleUpdateLead); aqui a tela so nao oferece.
  const DESTINOS_COB = ['Pagos', ...SAIDAS_DE_PAGOS]
  const podeIrCob = (de, para) => !!para && de !== para && DESTINOS_COB.includes(para) && !(de === 'Pagos' && para === 'Pagos')

  // A FILA DE COBRANCA e o que esta CHEGANDO: as mesmas duas listas do app de celular do cobrador
  // (pages/app/cobranca.js). Retirar nos Correios entra na fila por decisao do Bruno (06/10).
  const COLS_COBRANCA = ['Entregues', 'Retirar nos Correios']
  const COLS_A_CAMINHO = ['Enviados', 'Saiu para Entrega']
  const naFila = (p) => !!p && !p.pago && COLS_COBRANCA.includes(p.col)
  const aCaminho = (p) => !!p && !p.pago && COLS_A_CAMINHO.includes(p.col)
  const quandoAgend = (p) => {
    const s = String((p && p.agend) || '').trim()
    if (!s) return NaN
    // SO A DATA ("2026-11-06") e hora LOCAL, meia-noite: Date.parse le data sem hora como UTC e o
    // retorno cairia no dia anterior, as 21h (revisao de 05/11/2026).
    const t = Date.parse(/^\d{4}-\d\d-\d\d$/.test(s) ? s + 'T00:00' : s)
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
  // "agora", "há 12 min", "há 3 h", "ontem 18:40", "sexta 09:12"
  function haQuanto(ms, agora) {
    agora = agora || Date.now()
    const min = Math.floor((agora - ms) / 60000)
    if (min < 1) return 'agora'
    if (min < 60) return 'há ' + min + ' min'
    if (diaIni(ms) === diaIni(agora)) return 'há ' + Math.floor(min / 60) + ' h'
    return rotuloDia(ms, agora).split(' · ')[0].toLowerCase() + ' ' + hora(ms)
  }
  const quandoTxt = (ms, agora) => (isNaN(ms) ? '' : rotuloDia(ms, agora).split(' · ')[0] + ' ' + hora(ms))

  // A AGENDA, na ordem em que ele trabalha: o que venceu, o que e hoje, o que vem, a fila que ninguem
  // marcou e o que esta chegando. A regra de cada grupo e a do app de celular (agendaDoCobrador).
  // ENTRARAM EM CONTATO (03/11/2026, pedido do Bruno): o cliente escreveu num numero do cobrador e
  // ninguem respondeu nem mexeu no pedido desde entao (o `contato` vem pronto do servidor). O card sai
  // da coluna em que estava e vai pra esta, a primeira; respondeu ou mexeu, ele volta pro lugar dele.
  // So pedido que esta na agenda (na fila ou chegando): pago e perda nao sao cobranca.
  const emContato = (p) => !!p && Number(p.contato) > 0 && (naFila(p) || aCaminho(p))
  function agenda(pedidos, agora) {
    agora = agora || Date.now()
    const todos = Array.isArray(pedidos) ? pedidos : []
    const hojeIni = diaIni(agora), hojeFim = hojeIni + 86400000
    const atrasados = [], hoje = [], proximos = [], semRetorno = []
    const contato = todos.filter(emContato).sort((a, b) => Number(b.contato) - Number(a.contato))
    for (const p of todos) {
      if (!naFila(p) || emContato(p)) continue
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
    const chegando = todos.filter((p) => aCaminho(p) && !emContato(p)).sort((a, b) => (a.col === b.col ? (Number(b.entrou) || 0) - (Number(a.entrou) || 0) : (a.col === 'Saiu para Entrega' ? -1 : 1)))
    // O QUE ENTROU HOJE, pela data do PAGAMENTO, so do que passou pela cobranca (venda de cartao que
    // nasce paga nunca esteve na fila).
    const pagosHoje = todos.filter((p) => p.pago && p.vc && Number(p.pagoTs) >= hojeIni && Number(p.pagoTs) < hojeFim)
    return {
      contato, atrasados, hoje, proximos, semRetorno, chegando, pagosHoje,
      recebidoHoje: pagosHoje.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      fila: atrasados.length + hoje.length + proximos.length + semRetorno.length + contato.filter(naFila).length,
    }
  }

  // ── O CALENDARIO DO MES (05/11/2026) ─────────────────────────────────────────────────────────
  // Pedido do Bruno: "um terceiro [quadro], mais ou menos essa visualizacao [a Agenda de retornos
  // da dash], pra eles saberem mais ou menos que dia do mes tem retorno, quais sao os pedidos, e ter
  // uma nocao". A regra e a do calendario da dash (pages/apps/calendar.jsx):
  //  - retorno marcado em pedido NA FILA vai pro dia dele: vermelho se o dia passou, azul se e hoje,
  //    azul claro se e depois; pedido PAGO com retorno marcado fica verde (foi remarcado de proposito,
  //    pagou metade por exemplo) e nunca e "atrasado";
  //  - o que esta CHEGANDO cai no dia de HOJE, discreto (so a bolinha cinza): e o estado de agora,
  //    nao um compromisso. "Chegando" aqui e o mesmo da faixa e da Agenda (Enviados e Saiu para
  //    Entrega), pra o numero bater em todo canto do app; a dash so poe quem ja saiu pra entrega.
  // Quem escreveu (contato) continua no dia marcado: "Entraram em contato" e coluna da Agenda.
  const COR_CAL = { atrasado: '#ef4444', hoje: '#3b82f6', agendado: '#0ea5e9', pago: '#10b981', rua: '#94a3b8' }
  function calendario(pedidos, agora) {
    agora = agora || Date.now()
    const hojeK = chaveDia(agora)
    const porDia = new Map()
    const poe = (k, ev) => { if (!porDia.has(k)) porDia.set(k, []); porDia.get(k).push(ev) }
    // Os mesmos numeros do cartao "Atender hoje" da dash: hoje e marcados contam o pago tambem (e um
    // retorno que alguem marcou de proposito); atrasado nunca conta pago.
    const n = { hoje: 0, atrasados: 0, agendados: 0, chegando: 0 }
    for (const p of (Array.isArray(pedidos) ? pedidos : [])) {
      if (!p) continue
      const t = quandoAgend(p)
      if (!isNaN(t) && (p.pago || naFila(p))) {
        const k = chaveDia(t)
        const u = p.pago ? 'pago' : k < hojeK ? 'atrasado' : k === hojeK ? 'hoje' : 'agendado'
        if (k === hojeK) n.hoje += 1
        else if (k > hojeK) n.agendados += 1
        else if (!p.pago) n.atrasados += 1
        poe(k, { p, t, u, k })
      }
      if (aCaminho(p)) { n.chegando += 1; poe(hojeK, { p, t: NaN, u: 'rua', k: hojeK }) }
    }
    // No dia: os retornos pela hora, e por ultimo quem esta chegando (na rua primeiro, como na Agenda).
    const naRua = (e) => (e.p.col === 'Saiu para Entrega' ? 0 : 1)
    for (const l of porDia.values()) {
      l.sort((a, b) => {
        if ((a.u === 'rua') !== (b.u === 'rua')) return a.u === 'rua' ? 1 : -1
        if (a.u === 'rua') return naRua(a) - naRua(b) || (Number(b.p.entrou) || 0) - (Number(a.p.entrou) || 0) || String(a.p.nome).localeCompare(String(b.p.nome))
        return (a.t - b.t) || String(a.p.nome).localeCompare(String(b.p.nome))
      })
    }
    return { porDia, hojeK, n }
  }
  // A GRADE DO MES: do domingo da semana do dia 1 ao sabado da semana do ultimo dia (5 ou 6 linhas;
  // 4 so em fevereiro que comeca no domingo). Dia de outro mes vem marcado `fora`. `mes` e 0 a 11.
  function diasDaGrade(ano, mes) {
    const primeiro = new Date(ano, mes, 1)
    const ultimo = new Date(ano, mes + 1, 0)
    const total = Math.ceil((primeiro.getDay() + ultimo.getDate()) / 7) * 7
    const out = []
    for (let i = 0; i < total; i++) {
      const d = new Date(ano, mes, 1 - primeiro.getDay() + i)
      out.push({ k: chaveDia(d.getTime()), dia: d.getDate(), fora: d.getMonth() !== mes, dom: d.getDay() === 0, ms: d.getTime() })
    }
    return out
  }
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
  const mesRotulo = (ano, mes) => MESES[mes] + ' de ' + ano
  // REMARCAR ARRASTANDO: o dia muda e a hora fica (a dash faz igual). Retorno sem hora vai pras 9h.
  const agendNoDia = (agend, k) => { const s = String(agend || ''); return k + 'T' + (/T\d\d:\d\d/.test(s) ? s.slice(11, 16) : '09:00') }

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
  // OS ATALHOS DE RETORNO, POR DIA (05/11/2026, o Bruno: "nenhum lead retorna daqui a 1 hora (...)
  // a partir de 1 dia, 2 dias, 7 dias, 10 dias, algo assim"). Antes era "Daqui 1 h / Hoje 18h /
  // Amanha 9h / Amanha 14h / Em 2 dias", e os cobradores nao conseguiam usar. Todos as 9h: e quando
  // o dia de cobranca comeca; hora diferente e no calendario ("Outro dia"). `quando` e o dia por
  // extenso, pra quem passa o mouse ver em que data cai.
  const DIAS_ATALHO = [1, 2, 3, 7, 10, 15]
  function atalhosRetorno(agora) {
    const a = new Date(agora || Date.now())
    return DIAS_ATALHO.map((n) => {
      const d = new Date(a); d.setDate(d.getDate() + n); d.setHours(9, 0, 0, 0)
      return { rot: n === 1 ? 'Amanhã' : n + ' dias', v: agendDe(d), quando: rotuloDia(d.getTime(), a.getTime()) + ' às 09:00' }
    })
  }

  // ── O CALENDARIO DA FICHA (05/11/2026, o Bruno: "esse calendario esta muito feio. Estiliza ele,
  // deixa no design padrao da nossa dash") ────────────────────────────────────────────────────
  // O campo nativo de data e hora do Chromium (branco, com as duas colunas de hora) sai; entra a
  // grade do mes no desenho do calendario da dash (o do shadcn: mes com setas, D S T Q Q S S, hoje
  // marcado, dia escolhido no verde) com as horas em chips embaixo. Nasce fechado dentro da caixa
  // Retorno e abre no "Outro dia". Dia passado nao se escolhe (retorno no passado nasce atrasado).
  // `st` = { ano, mes (0-11, o mes na tela), dia: 'AAAA-MM-DD', hh, mm }: a tela anda de mes sem
  // perder o dia escolhido. So HTML e estado; quem liga os cliques e a ligaFicha.
  const HORAS_FICHA = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']
  const SEM_CURTA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']
  function calInicial(p, agora) {
    agora = agora || Date.now()
    const ag = quandoAgend(p)
    // Retorno marcado de hoje em diante e o ponto de partida (hora e minuto exatos, pra remarcar so
    // o dia sem mexer na hora); atrasado ou sem retorno comeca em amanha as 9h.
    const vale = !isNaN(ag) && ag >= diaIni(agora)
    const base = new Date(vale ? ag : agora + 86400000)
    return { ano: base.getFullYear(), mes: base.getMonth(), dia: chaveDia(base.getTime()), hh: vale ? p2(base.getHours()) : '09', mm: vale ? p2(base.getMinutes()) : '00' }
  }
  function calFicha(st, agora) {
    agora = agora || Date.now()
    const hojeK = chaveDia(agora)
    const tit = mesRotulo(st.ano, st.mes)
    let h = '<div class="fx-cal-nav"><button type="button" class="fx-cal-seta" data-acao="cal-mes" data-v="-1" title="Mês anterior">' + I.esq + '</button>'
      + '<b>' + esc(tit.charAt(0).toUpperCase() + tit.slice(1)) + '</b>'
      + '<button type="button" class="fx-cal-seta" data-acao="cal-mes" data-v="1" title="Próximo mês">' + I.dir + '</button></div>'
    h += '<div class="fx-cal-sem">' + SEM_CURTA.map((s) => '<span>' + s + '</span>').join('') + '</div>'
    h += '<div class="fx-cal-grade">' + diasDaGrade(st.ano, st.mes).map((c) => {
      const passado = c.k < hojeK
      const cls = ['fx-cal-d', c.fora ? 'fora' : '', c.k === hojeK ? 'hoje' : '', c.k === st.dia ? 'sel' : '', passado ? 'passado' : ''].filter(Boolean).join(' ')
      return '<button type="button" class="' + cls + '" data-acao="cal-dia" data-v="' + c.k + '"' + (passado ? ' disabled' : '') + '>' + c.dia + '</button>'
    }).join('') + '</div>'
    h += '<div class="fx-cal-horas">' + HORAS_FICHA.map((x) => '<button type="button" class="fx-cal-h' + (x === st.hh ? ' sel' : '') + '" data-acao="cal-hora" data-v="' + x + '">' + x + 'h</button>').join('')
      + '<span class="fx-cal-min">' + ['00', '30'].map((x) => '<button type="button" class="fx-cal-h' + (x === st.mm ? ' sel' : '') + '" data-acao="cal-min" data-v="' + x + '">:' + x + '</button>').join('') + '</span></div>'
    const quando = Date.parse(st.dia + 'T' + st.hh + ':' + st.mm)
    h += '<div class="fx-cal-pe"><span class="fx-cal-escolhido">' + esc(isNaN(quando) ? 'Escolha o dia' : rotuloDia(quando, agora) + ' às ' + st.hh + ':' + st.mm) + '</span>'
      + '<button type="button" class="fx-bt fx-verde" data-acao="cal-marca">Marcar</button></div>'
    return h
  }
  // O QUE FALTA RECEBER e o que JA ENTROU (05/11/2026, pagamento parcial). O `saldo` vem pronto do
  // servidor (valor a cobrar menos as parcelas registradas); sem ele, falta o valor inteiro.
  const faltaDe = (p) => { const s = Number(p && p.saldo), v = Number(p && p.valor) || 0; return isFinite(s) && s > 0 && s <= v ? s : v }
  const jaPagoDe = (p) => Math.max(0, (Number(p && p.valor) || 0) - faltaDe(p))
  const foneBonito = (f) => {
    let d = String(f || '').replace(/\D/g, '')
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7)
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6)
    return d
  }
  // O TEXTO DO "COPIAR DADOS" (05/11/2026, pedido do Haynan via Bruno: "copiar todos os dados da
  // pessoa, o nome, tudo certinho"). E o mesmo bloco do "Copiar tudo pra colar na PayLog" das
  // Aceitacoes da dash (blocoCopia em aceitacoes.jsx): nome, CPF, WhatsApp e e-mail; endereco,
  // bairro - cidade/UF e CEP; produto, valor a cobrar e forma de pagamento. Linha sem dado some,
  // bloco vazio some, e os blocos ficam separados por uma linha em branco.
  const cpfBonito = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : String(c || '').trim() }
  const cepBonito = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : String(c || '').trim() }
  function textoDados(p) {
    p = p || {}
    const rua = [p.end, p.num].filter(Boolean).join(', ') + (p.comp ? ' - ' + p.comp : '')
    const bairroCid = [p.bairro, [p.cidade, p.uf].filter(Boolean).join('/')].filter(Boolean).join(' - ')
    const blocos = [
      [p.nome, p.cpf && 'CPF: ' + cpfBonito(p.cpf), p.wa && 'WhatsApp: ' + foneBonito(p.wa), p.email && 'E-mail: ' + String(p.email).trim()],
      [rua, bairroCid, p.cep && 'CEP: ' + cepBonito(p.cep)],
      [p.prod && 'Produto: ' + p.prod, Number(p.valor) > 0 && 'Valor: ' + brl(p.valor), 'Pagamento: ' + (p.mod === 'antecipado' ? 'Antecipado' : 'Na entrega (COD)')],
    ]
    return blocos.map((b) => b.filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
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
    pessoa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    fone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    pino: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.99-5.54 10.19-7.4 11.79a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
    pacote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/></svg>',
    balao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    calendario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
    esq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
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
    // TAGS (03/11/2026, pedido do Bruno: "a opcao de colocar tags (...) algo bem discreto e simples").
    // As marcadas ficam a mostra (clicar tira); o "+ Tag" abre as outras do catalogo da dash. Criar
    // tag nova continua na dash (Gerenciar tags, no topo do Kanban).
    const marc = Array.isArray(p.tags) ? p.tags.filter((t) => t && t.id) : []
    const cat = Array.isArray(ctx.tags) ? ctx.tags.filter((t) => t && t.id) : []
    const resto = cat.filter((t) => !marc.some((m) => m.id === t.id))
    if (marc.length || cat.length) {
      const pill = (t, on) => '<button class="fx-tag' + (on ? ' on' : '') + '" data-acao="tag" data-v="' + esc(t.id) + '" style="--c:' + esc(t.cor || '#64748b') + '" title="' + (on ? 'Tirar a tag' : 'Marcar esta tag') + '"><i></i>' + esc(t.nome || t.id) + '</button>'
      h += '<div class="fx-tags">' + marc.map((t) => pill(t, true)).join('')
        + (resto.length ? '<button class="fx-tag fx-tag-mais" data-acao="tags-abre" title="Marcar uma tag">+ Tag</button><div class="fx-tags-lista" hidden>' + resto.map((t) => pill(t, false)).join('') + '</div>' : '')
        + '</div>'
    }
    // telefone + conversa
    h += '<div class="fx-linha">'
      + '<button class="fx-mini" data-acao="copiar" data-v="+55' + esc(String(p.wa || '').replace(/^55(?=\d{10,11}$)/, '')) + '" title="Copiar o telefone">' + I.copia + esc(foneBonito(p.wa)) + '</button>'
      // COPIAR DADOS (05/11/2026, pedido do Haynan via Bruno): nome, CPF, WhatsApp, endereco, CEP,
      // produto, valor e forma de pagamento num bloco so (ver textoDados).
      + '<button class="fx-mini" data-acao="copiar-dados" title="Copiar nome, CPF, WhatsApp, endereço, CEP, produto e valor">' + I.copia + 'Copiar dados</button>'
      + (ctx.conversa ? '<button class="fx-bt fx-verde" data-acao="conversa" title="Abrir a conversa deste cliente num dos seus números">' + I.zap + 'Abrir conversa</button>' : '')
      + '</div>'
    // entrega
    const ent = []
    if (p.selo) ent.push('<span class="fx-selo" style="--c:' + esc(p.selo.cor) + '">' + esc(p.selo.label) + (p.selo.quando ? ' · ' + esc(p.selo.quando) : '') + '</span>')
    if (p.entrega) ent.push('<span class="fx-ap">' + esc(p.entrega.label + ' ' + p.entrega.data + (p.entrega.dias ? ' · ' + p.entrega.dias : '')) + '</span>')
    if (p.track) ent.push('<span class="fx-ap">' + esc((p.transp ? p.transp + ' ' : '') + p.track) + '</span>')
    if (ent.length || (p.links && p.links.rastreio)) {
      h += '<div class="fx-bloco fx-caixa" data-sec="entrega" style="--c:#818cf8"><div class="fx-tit">' + I.caminhao + 'Entrega</div><div class="fx-wrap">' + ent.join('') + '</div>'
      if (p.links && p.links.rastreio) h += linkLinha({ k: 'rastreio', rot: 'Rastreio', frase: 'Segue o link para acompanhar a entrega do seu pedido:' }, p.links.rastreio, ctx)
      h += '</div>'
    }
    // retorno
    // ENTREGA, RETORNO E PAGAMENTO EM CAIXAS (03/11/2026, pedido do Bruno: "ficasse um pouco mais
    // destacada (...) mais separados entre eles, pra eu conseguir diferenciar"). Cada uma com a sua cor
    // de leve no fundo e no titulo; o resto da ficha segue com a linha fina de sempre.
    h += '<div class="fx-bloco fx-caixa" data-sec="retorno" style="--c:#60a5fa"><div class="fx-tit">' + I.relogio + 'Retorno'
      + (isNaN(ag) ? '<span class="fx-ap">sem retorno marcado</span>' : '<span class="fx-quando' + (atrasado ? ' atrasado' : '') + '">' + esc(quandoTxt(ag, agora)) + (atrasado ? ' · atrasado' : '') + '</span>')
      + '</div><div class="fx-wrap">'
      // Os atalhos por dia (ver atalhosRetorno) e o "Outro dia", que abre o calendario da ficha
      // (calFicha) logo abaixo, dentro da caixa. O campo nativo de data e hora saiu em 05/11/2026.
      + atalhosRetorno(agora).map((a) => '<button class="fx-mini" data-acao="agend" data-v="' + a.v + '" title="' + esc(a.quando) + '">' + esc(a.rot) + '</button>').join('')
      + '<button class="fx-mini fx-cal-bt" data-acao="cal-abre" aria-expanded="false" title="Escolher o dia e a hora no calendário">' + I.calendario + 'Outro dia</button>'
      + (p.agend ? '<button class="fx-mini fx-fraco" data-acao="agend" data-v="">Tirar</button>' : '')
      + '</div><div class="fx-cal" hidden></div></div>'
    // pagamento
    h += '<div class="fx-bloco fx-caixa" data-sec="pagamento" style="--c:#10b981"><div class="fx-tit">' + I.ok + 'Pagamento</div>'
    if (p.pago) {
      h += '<div class="fx-ap">Recebido ' + esc(brl(p.valor)) + (p.pagoTs ? ' em ' + esc(new Date(Number(p.pagoTs)).toLocaleDateString('pt-BR')) : '') + '.</div>'
    } else {
      // PAGAMENTO PARCIAL (05/11/2026, o Bruno: "as vezes o lead nao paga todo o valor e fala que daqui
      // a tantos dias vai pagar o restante"). O que ja entrou e o que falta ficam a mostra, o campo
      // ja vem com o que FALTA, e o pedido fica na fila ate quitar. O rotulo "Valor recebido" saiu
      // ("ja e bem obvio pra que serve"): o campo diz isso pro leitor de tela, nao pra tela.
      const falta = faltaDe(p), jaPago = jaPagoDe(p)
      const parcelas = Array.isArray(p.pagamentos) ? p.pagamentos.filter((x) => x && Number(x.valor) > 0) : []
      if (jaPago > 0) {
        h += '<div class="fx-parcial">Já pagou <b>' + esc(brl(jaPago)) + '</b> de ' + esc(brl(p.valor)) + ' · faltam <b>' + esc(brl(falta)) + '</b>'
          + (parcelas.length ? '<div class="fx-parcelas">' + parcelas.slice(-6).map((x) => '<span>' + esc([x.data, brl(x.valor), x.quem].filter(Boolean).join(' · ')) + '</span>').join('') + '</div>' : '')
          + '</div>'
      }
      h += '<div class="fx-wrap"><input class="fx-valor-in" inputmode="decimal" value="' + esc(valorCampo(falta)) + '" aria-label="Valor recebido" title="Valor recebido">'
        + '<button class="fx-bt fx-verde" data-acao="pago">Marcar como pago</button>'
        + '<button class="fx-bt" data-acao="parcial" title="O cliente pagou só uma parte: registra o valor e o pedido continua na cobrança com o que falta">Pagamento parcial</button></div>'
      const links = LINKS.filter((l) => p.links && p.links[l.k])
      if (links.length) h += links.map((l) => linkLinha(l, p.links[l.k], ctx)).join('')
      else if (p.links) h += '<div class="fx-ap">Sem link de pagamento cadastrado para este pedido.</div>'
    }
    h += '</div>'
    // etapa
    // So as perdas: Pagos tem o botao com o valor, e as etapas de entrega sao da Five (DESTINOS_COB).
    const opcoes = PERDA.filter((c) => c.id !== p.col)
    h += '<div class="fx-bloco"><div class="fx-tit">Etapa</div><div class="fx-wrap"><select class="fx-etapa"><option value="">Mudar para...</option>'
      + opcoes.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.lbl) + '</option>').join('') + '</select>'
      + '<button class="fx-mini" data-acao="etapa">Mover</button></div>'
      + '<div class="fx-ap">' + (p.col === 'Pagos' ? 'Pedido pago só sai para uma frustração.' : 'As etapas de entrega mudam sozinhas, pela plataforma.') + '</div>'
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
      // Com a palavra "Abrir" (05/11/2026): so o icone passava despercebido, e o cobrador ia na dash
      // buscar o link do checkout pra abrir no navegador.
      + '<button class="fx-mini" data-acao="abrir-link" data-k="' + l.k + '" title="Abrir no navegador">' + I.abre + 'Abrir</button></div>'
  }
  const FRASE = { rastreio: 'Segue o link para acompanhar a entrega do seu pedido:' }
  for (const l of LINKS) FRASE[l.k] = l.frase

  // A FICHA ESTA NO MEIO DE ALGO? (05/11/2026) As duas telas releem a ficha em segundo plano (o quadro
  // mudou, ou de 30 em 30 s no painel) e redesenham por cima. Antes so "campo com foco" segurava a
  // releitura; o calendario aberto, o botao armado ("Confirmar R$ ...") e o comentario escrito e
  // nao salvo tambem sao trabalho em andamento, e a releitura apagava os tres.
  function fichaOcupada(raiz) {
    if (!raiz || !raiz.querySelector) return false
    const cal = raiz.querySelector('.fx-cal')
    if (cal && !cal.hidden) return true
    if (raiz.querySelector('[data-armado="1"]')) return true
    const com = raiz.querySelector('.fx-com')
    if (com && String(com.value || '').trim()) return true
    const a = (typeof document !== 'undefined') ? document.activeElement : null
    return !!(a && a.matches && raiz.contains && raiz.contains(a) && a.closest('.fx') && a.matches('input, textarea, select'))
  }

  // LIGA OS BOTOES DA FICHA. `ad` e o adaptador da tela que hospeda:
  //   salva(id, patch) -> { ok, erro, negados }   copiar(texto) -> { ok }
  //   abrirLink(url)   curto(url, id) -> { ok, url }   conversa?(p)   enviar?(texto) -> { ok, erro }
  //   recarrega() -> relê a ficha e redesenha (depois de gravar)
  function ligaFicha(raiz, p, ad, ctx) {
    const fx = raiz.querySelector('.fx[data-id="' + CSS.escape(String(p.id)) + '"]') || raiz.querySelector('.fx')
    if (!fx) return
    // A mensagem vai na ficha de AGORA: depois de uma releitura a ficha e outro no (o `fx` daqui
    // ja saiu da tela), entao quem avisa depois de reler procura o .fx-msg de novo dentro da raiz.
    const dizEm = (m, t, erro, ms) => { if (!m) return; m.textContent = t; m.className = 'fx-msg' + (erro ? ' erro' : ''); m.hidden = !t; clearTimeout(m.__t); if (t) m.__t = setTimeout(() => { m.hidden = true }, ms || 6000) }
    const diz = (t, erro) => dizEm(fx.querySelector('.fx-msg'), t, erro)
    const dizNaNova = (t, erro) => dizEm(raiz.querySelector('.fx-msg'), t, erro, 9000)
    let ocupado = false
    // DESARMA O QUE A FICHA ARMOU (05/11/2026, revisao): o "Confirmar R$ ..." e o calendario aberto
    // contam como trabalho em andamento (fichaOcupada) e seguravam a releitura que a propria gravacao
    // pede no painel: a ficha ficava velha e o clique seguinte levava "o pedido mudou". O botao
    // volta ao rotulo e a classe de antes (data-rot / data-cls, postos na hora de armar).
    const desarmaBotoes = () => {
      for (const b of fx.querySelectorAll('[data-armado="1"]')) { b.dataset.armado = ''; if (b.dataset.rot) b.textContent = b.dataset.rot; if (b.dataset.cls) b.className = b.dataset.cls }
    }
    const fechaCal = () => {
      const cx = fx.querySelector('.fx-cal'); if (cx) cx.hidden = true
      const ab = fx.querySelector('[data-acao="cal-abre"]'); if (ab) ab.setAttribute('aria-expanded', 'false')
    }
    const semPonto = (t) => String(t || '').replace(/\.+\s*$/, '')
    const grava = async (patch, ok) => {
      if (ocupado) return null
      ocupado = true
      fx.classList.add('fx-salvando')
      let r = null
      try { r = await ad.salva(p.id, patch) } catch (e) { r = { ok: false, erro: String((e && e.message) || e) } }
      ocupado = false
      fx.classList.remove('fx-salvando')
      desarmaBotoes()
      if (!r || !r.ok) {
        const t = 'Não salvou: ' + semPonto((r && r.erro) || 'a dash não respondeu') + '.'
        // "O PEDIDO MUDOU" (409): outra pessoa mexeu no pedido com a ficha aberta. Rele a ficha, pra
        // ela mostrar o que esta la agora e o proximo clique mandar o `antes` certo; o aviso vai na
        // ficha relida (a de antes some com a releitura).
        if (r && r.mudou) { try { await ad.recarrega('') } catch (_) { /* a releitura seguinte acerta */ } dizNaNova(t, true) }
        else diz(t, true)
        return r
      }
      if (Array.isArray(r.negados) && r.negados.length) { diz('A dash não deixou mudar: ' + r.negados.join(', ') + '.', true); return r }
      // A PROVA DA PARCELA: o servidor responde quantas parcelas o pedido ficou tendo. Servidor que
      // ainda nao conhece a parcela responde ok SEM isso, e ai ela NAO entrou: dizer "registrado"
      // seria mentir (a dash do lado mostraria o saldo cheio).
      if (patch.pagamento_add && !(Number(r.parcelas) > 0)) {
        try { await ad.recarrega('') } catch (_) { /* idem */ }
        dizNaNova((patch.spg === 'Pago' ? 'Marcou pago, mas a parcela não entrou na ficha de pagamentos' : 'A dash não registrou a parcela') + ': o servidor está desatualizado. Avise a direção.', true)
        return r
      }
      if (patch.comment_add) { const ta = fx.querySelector('.fx-com'); if (ta) ta.value = '' }
      fechaCal()
      diz(ok || 'Salvo.')
      try { await ad.recarrega(ok) } catch (_) { /* a releitura seguinte acerta */ }
      return r
    }
    const linkDe = (k) => (p.links && p.links[k]) || ''
    let cal = null   // o estado do calendario da ficha; nasce no primeiro "Outro dia" (calInicial)
    const redesenhaCal = () => { const cx = fx.querySelector('.fx-cal'); if (cx && cal) cx.innerHTML = calFicha(cal, Date.now()) }
    fx.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-acao]')
      if (!b || !fx.contains(b)) return
      const acao = b.dataset.acao
      if (acao === 'copiar') { const r = await ad.copiar(b.dataset.v); diz(r && r.ok ? 'Telefone copiado.' : 'Não consegui copiar.', !(r && r.ok)); return }
      if (acao === 'copiar-dados') { const r = await ad.copiar(textoDados(p)); diz(r && r.ok ? 'Dados do cliente copiados.' : 'Não consegui copiar.', !(r && r.ok)); return }
      if (acao === 'conversa') { if (ad.conversa) ad.conversa(p, b); return }
      if (acao === 'tags-abre') { const l = fx.querySelector('.fx-tags-lista'); if (l) { l.hidden = !l.hidden; b.classList.toggle('on', !l.hidden) } return }
      if (acao === 'tag') {
        const id = b.dataset.v
        const ids = (Array.isArray(p.tags) ? p.tags : []).map((t) => t && t.id).filter(Boolean)
        const tinha = ids.includes(id)
        await grava({ tags: tinha ? ids.filter((x) => x !== id) : [...ids, id] }, tinha ? 'Tag tirada.' : 'Tag marcada.')
        return
      }
      if (acao === 'agend') {
        const v = b.dataset.v
        await grava({ agend: v }, v ? 'Retorno marcado: ' + quandoTxt(Date.parse(v), Date.now()) + '.' : 'Retorno tirado.')
        return
      }
      // O CALENDARIO DA FICHA (05/11/2026): abre fechado, anda de mes, escolhe dia, hora e minuto, e
      // so grava no "Marcar". Redesenha SO a caixa do calendario (o resto da ficha, com o que ele
      // digitou, fica como esta).
      if (acao === 'cal-abre') {
        const cx = fx.querySelector('.fx-cal')
        if (!cx) return
        if (!cx.hidden) { cx.hidden = true; b.setAttribute('aria-expanded', 'false'); return }
        if (!cal) cal = calInicial(p, Date.now())
        redesenhaCal(); cx.hidden = false; b.setAttribute('aria-expanded', 'true')
        return
      }
      if (acao === 'cal-mes' || acao === 'cal-dia' || acao === 'cal-hora' || acao === 'cal-min') {
        if (!cal) cal = calInicial(p, Date.now())
        if (acao === 'cal-mes') { cal.mes += Number(b.dataset.v) || 0; if (cal.mes < 0) { cal.mes = 11; cal.ano -= 1 } else if (cal.mes > 11) { cal.mes = 0; cal.ano += 1 } }
        else if (acao === 'cal-dia') { if (b.disabled) return; cal.dia = b.dataset.v }
        else if (acao === 'cal-hora') cal.hh = b.dataset.v
        else cal.mm = b.dataset.v
        redesenhaCal()
        return
      }
      if (acao === 'cal-marca') {
        const v = cal ? cal.dia + 'T' + cal.hh + ':' + cal.mm : ''
        if (!v || isNaN(Date.parse(v))) { diz('Escolha o dia e a hora.', true); return }
        await grava({ agend: v }, 'Retorno marcado: ' + quandoTxt(Date.parse(v), Date.now()) + '.')
        return
      }
      if (acao === 'pago') {
        const v = valorDigitado((fx.querySelector('.fx-valor-in') || {}).value)
        if (!(v > 0)) { diz('Escreva o valor que o cliente pagou.', true); return }
        const jaPago = jaPagoDe(p), falta = faltaDe(p)
        // DOIS CLIQUES, como tudo que nao tem desfazer simples: o primeiro arma e diz o valor. Com
        // parcela anterior o botao diz tambem o TOTAL que o pedido vai fechar (o digitado e o resto),
        // e se o digitado passa do que faltava, avisa antes: pagar a mais e caso real (regra de 23/09,
        // nao se bloqueia), mas o cobrador acostumado a digitar o total precisa ver a conta.
        if (b.dataset.armado !== '1') {
          b.dataset.rot = 'Marcar como pago'; b.dataset.cls = 'fx-bt fx-verde'
          b.dataset.armado = '1'; b.className = 'fx-bt fx-alerta'; b.textContent = 'Confirmar ' + brl(v) + (jaPago > 0 ? ' (total ' + brl(jaPago + v) + ')' : '')
          if (jaPago > 0 && v > falta + 0.005) diz('Faltavam ' + brl(falta) + '. Confirme só se ele pagou ' + brl(v) + ' agora: o pedido fecha com ' + brl(jaPago + v) + ' no total.', true)
          setTimeout(() => { if (b.isConnected && b.dataset.armado === '1') { b.dataset.armado = ''; b.className = 'fx-bt fx-verde'; b.textContent = 'Marcar como pago' } }, 6000)
          return
        }
        // A MESMA CHAMADA DO "JA PAGOU" DA DASH: spg, valor e coluna numa gravacao so, com o `antes`
        // pra recusar se outra pessoa mexeu no pedido desde que a ficha abriu.
        // COM PARCELA ANTERIOR (05/11/2026): o que ele digitou e o RESTO. Entra como parcela (a ficha
        // de pagamentos fecha a conta) e o valor negociado vira o total que entrou (parcelas + resto):
        // o resto com desconto fecha o pedido com menos, que e o que um desconto e.
        const antes = { spg: p.spg || '', col: p.colBruta || '' }
        const patch = jaPago > 0
          ? { pagamento_add: { valor: v, obs: 'quitou pelo SellWave Web' }, spg: 'Pago', valor_neg: Math.round((jaPago + v) * 100) / 100, col: 'Pagos', antes }
          : { spg: 'Pago', valor_neg: v, col: 'Pagos', antes }
        await grava(patch, 'Pago: ' + brl(jaPago + v) + '.')
        return
      }
      if (acao === 'parcial') {
        const v = valorDigitado((fx.querySelector('.fx-valor-in') || {}).value)
        if (!(v > 0)) { diz('Escreva o valor que o cliente pagou.', true); return }
        const falta = faltaDe(p)
        if (v + 0.005 >= falta) { diz('Esse valor quita o pedido: use o "Marcar como pago".', true); return }
        if (b.dataset.armado !== '1') {
          b.dataset.rot = 'Pagamento parcial'; b.dataset.cls = 'fx-bt'
          b.dataset.armado = '1'; b.className = 'fx-bt fx-alerta'; b.textContent = 'Confirmar parcial de ' + brl(v)
          setTimeout(() => { if (b.isConnected && b.dataset.armado === '1') { b.dataset.armado = ''; b.className = 'fx-bt'; b.textContent = 'Pagamento parcial' } }, 6000)
          return
        }
        // So a parcela (pagamento_add, o servidor acrescenta): sem spg e sem coluna, o pedido fica na
        // fila com o saldo. O `antes` recusa se alguem marcou pago ou moveu enquanto a ficha estava aberta.
        await grava({ pagamento_add: { valor: v, obs: 'parcial pelo SellWave Web' }, antes: { spg: p.spg || '', col: p.colBruta || '' } }, 'Parcial de ' + brl(v) + ' registrado. Faltam ' + brl(falta - v) + '.')
        return
      }
      if (acao === 'etapa') {
        const para = String((fx.querySelector('.fx-etapa') || {}).value || '')
        if (!para) { diz('Escolha a etapa.', true); return }
        if (!podeIrCob(p.col, para)) { diz('Por aqui o pedido só vai pra Pagos ou pra uma frustração.', true); return }
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
  .fx-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: -3px; }
  .fx-tags-lista { display: contents; }
  .fx-tags-lista[hidden] { display: none; }
  .fx-tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 7px; border-radius: 99px; font-size: 11px; color: var(--apagado);
    border: 1px solid var(--linha); background: transparent; cursor: pointer; white-space: nowrap; }
  .fx-tag i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); flex: 0 0 auto; }
  .fx-tag:hover { color: var(--texto); border-color: rgba(255, 255, 255, .18); }
  .fx-tag.on { color: var(--texto); border-color: color-mix(in srgb, var(--c) 45%, transparent); }
  .fx-tag-mais { border-style: dashed; }
  .fx-pago { display: inline-flex; align-items: center; gap: 3px; color: #10b981; font-size: 11px; font-weight: 700; }
  .fx-linha, .fx-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .fx-bloco { border-top: 1px solid var(--linha); padding-top: 9px; display: flex; flex-direction: column; gap: 7px; }
  .fx-tit { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--apagado); }
  .fx-tit .fx-ap, .fx-tit .fx-quando { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 600; }
  .fx-caixa { border: 1px solid color-mix(in srgb, var(--c) 30%, transparent); border-radius: 10px; padding: 9px 10px 10px;
    background: color-mix(in srgb, var(--c) 7%, transparent); }
  .fx-caixa + .fx-caixa { margin-top: 2px; }
  .fx-caixa > .fx-tit { color: var(--c); }
  .fx-caixa + .fx-bloco:not(.fx-caixa) { margin-top: 4px; }
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
  .fx-valor-in, .fx-etapa, .fx-com { font: inherit; color: var(--texto); background: rgba(255, 255, 255, .04); border: 1px solid var(--linha); border-radius: 8px; padding: 4px 7px; outline: none; }
  .fx-valor-in:focus, .fx-etapa:focus, .fx-com:focus { border-color: color-mix(in srgb, var(--verde) 60%, transparent); }
  .fx-etapa option { background: #1d2330; }
  .fx-valor-in { width: 92px; font-variant-numeric: tabular-nums; }
  .fx-rot { font-size: 11px; color: var(--apagado); }
  /* o calendario da ficha (05/11/2026): o desenho do calendario da dash, dentro da caixa Retorno */
  .fx-cal-bt svg { width: 12px; height: 12px; }
  .fx-cal { margin-top: 2px; padding: 8px 8px 9px; border-radius: 10px; border: 1px solid var(--linha); background: rgba(0, 0, 0, .22); }
  .fx-cal[hidden] { display: none; }
  .fx-cal-nav { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
  .fx-cal-nav b { font-size: 12.5px; font-weight: 650; color: var(--texto); }
  .fx-cal-seta { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--apagado); cursor: pointer; padding: 0; }
  .fx-cal-seta:hover { background: rgba(255, 255, 255, .07); color: var(--texto); }
  .fx-cal-seta svg { width: 14px; height: 14px; }
  .fx-cal-sem, .fx-cal-grade { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
  .fx-cal-sem span { text-align: center; font-size: 10.5px; font-weight: 600; color: var(--apagado); padding: 2px 0 3px; }
  .fx-cal-d { height: 28px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--texto); font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; cursor: pointer; padding: 0; }
  .fx-cal-d:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
  .fx-cal-d.fora { color: var(--apagado); opacity: .55; }
  .fx-cal-d.hoje { background: rgba(255, 255, 255, .09); font-weight: 700; }
  .fx-cal-d.sel, .fx-cal-h.sel { background: var(--verde); border-color: var(--verde); color: #05070c; font-weight: 700; opacity: 1; }
  .fx-cal-d.sel:hover, .fx-cal-h.sel:hover { background: var(--verde); }
  .fx-cal-d:disabled { opacity: .3; cursor: default; }
  .fx-cal-horas { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--linha); }
  .fx-cal-h { padding: 3px 7px; border-radius: 7px; border: 1px solid var(--linha); background: rgba(255, 255, 255, .03); color: var(--texto); font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
  .fx-cal-h:hover { background: rgba(255, 255, 255, .08); }
  .fx-cal-min { display: inline-flex; gap: 4px; margin-left: auto; padding-left: 6px; border-left: 1px solid var(--linha); }
  .fx-cal-pe { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
  .fx-cal-escolhido { font-size: 12px; font-weight: 650; color: #60a5fa; }
  /* pagamento parcial (05/11/2026): o que ja entrou e o que falta, com as parcelas */
  .fx-parcial { font-size: 12px; color: var(--apagado); }
  .fx-parcial b { color: var(--texto); }
  .fx-parcelas { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .fx-parcelas span { padding: 1px 7px; border-radius: 6px; font-size: 11px; background: rgba(255, 255, 255, .05); color: var(--apagado); }
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
    esc, brl, COLS, PERDA, TODAS, colDef, chip, SAIDAS_DE_PAGOS, DESTINOS_COB, podeIrCob, COLS_COBRANCA, COLS_A_CAMINHO,
    naFila, aCaminho, emContato, quandoAgend, agenda, rotuloDia, hora, haQuanto, quandoTxt, chaveDia, diaIni,
    COR_CAL, calendario, diasDaGrade, mesRotulo, agendNoDia,
    valorDigitado, atalhosRetorno, DIAS_ATALHO, HORAS_FICHA, calInicial, calFicha, faltaDe, jaPagoDe,
    foneBonito, textoDados, fichaHtml, ligaFicha, fichaOcupada, poeEstilo, I,
  }
})()
