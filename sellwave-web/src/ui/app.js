// Casca do SellWave Web: a barra de números, o login e os ajustes.
// Ela NÃO fala com a rede: tudo passa pelo processo principal, via window.sw (ver preload.js).
//
// DUAS CARAS, uma do vendedor e uma da direção (16/10/2026, pedido do Bruno: "para meus vendedores
// não quero que apareça nada de proxy: conectar proxy, trava de proxy, nada a ver com proxy; só
// para mim"). Quem decide é o servidor, no campo `direcao` do /api/swweb/numeros, nunca o cliente.

const $ = (id) => document.getElementById(id)
const palco = $('palco')
const lista = $('lista')
const modal = $('modal')
const modalCorpo = $('modal-corpo')

let estado = { numeros: [], proxies: {}, abertos: [], travaProxy: true, exigirBrasil: false, temToken: false, direcao: false }
let ativo = ''
const carregando = new Set()
// Numeros cujo motor do WhatsApp nao carregou. Eles continuam abrindo e conversando, mas NAO batem
// sinal de vida: em 3 minutos a roleta para de mandar lead pra eles. Isso tem que estar na cara.
const semMotor = new Set()
const falhou = new Map()
const mexendo = new Set()      // números com a chave da roleta em trânsito
let filtro = ''

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Chave do número: DDD + 8 últimos dígitos. A MESMA do worker e do processo principal. Se mudar, a
// partição muda e o número pede QR de novo.
function numKey(n) {
  let d = String(n || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length >= 12 && d.slice(0, 2) === '55') d = d.slice(2)
  if (d.length < 10) return d
  return d.slice(0, 2) + d.slice(-8)
}

// A chave tem 10 dígitos e NÃO dá pra formatar como telefone (sai sem o nono dígito). Quando a
// lista tem o número cheio, usa ele.
function cheio(nk) {
  const n = (estado.numeros || []).find((x) => numKey(x.numero) === nk)
  return n ? n.numero : nk
}
function bonito(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^55/, '')
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7)
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6)
  return String(n || '')
}

// O foguinho do aquecimento (lucide `flame`). Icone, nunca emoji: emoji muda de desenho em cada
// maquina e nao herda a cor do texto.
const FOGO = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>'
const ZAP = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6.2-.4v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 .6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1l-.3-.2Z"/></svg>'

// ───────────────────────────────────────────────────────────── barra lateral

function desenhaTrava() {
  const el = $('trava')
  // A FAIXA SO FALA QUANDO ALGO PEDE ATENCAO (16/10/2026, pedido do Bruno: "fica so com o
  // essencial, o resto vai pra dentro de Ajustes").
  //
  // Trava LIGADA e o estado normal: anunciar isso todo dia, no topo, ensina a ignorar a faixa - e
  // no dia em que ela disser algo util ninguem le. Ligada, some; desligada, aparece em ambar,
  // porque ai o numero abre sem proxy e sai pelo IP da casa.
  if (!estado.direcao || estado.travaProxy !== false) { el.hidden = true; return }
  el.hidden = false
  el.className = 'trava solta'
  $('trava-txt').innerHTML = '<b>Trava de proxy desligada</b> · o número abre sem proxy'
}

// A BARRA ENCOLHIDA E DECISAO GUARDADA, nao estado da sessao: quem gosta dela fina quer ela fina
// amanha tambem. Quem guarda e o processo principal (sw:barra -> config), porque e ele que tambem
// precisa do valor pra posicionar a view do WhatsApp.
let barraFina = false

function desenhaLista() {
  if (!estado.temToken) { lista.innerHTML = ''; return }
  const nums = (estado.numeros || []).filter((n) => {
    if (!filtro) return true
    return (String(n.numero || '') + ' ' + String(n.dono || '')).toLowerCase().includes(filtro)
  })
  if (!nums.length) {
    lista.innerHTML = '<div class="vend">' + (filtro ? 'Nada encontrado' : 'Nenhum número liberado') + '</div>'
    return
  }

  // AGRUPA POR VENDEDOR (pedido do Bruno em 16/10). Quem atende vem primeiro, e dentro do grupo os
  // que estão recebendo lead sobem.
  const grupos = new Map()
  for (const n of nums) {
    const k = n.dono || 'Sem vendedor'
    if (!grupos.has(k)) grupos.set(k, [])
    grupos.get(k).push(n)
  }
  const ordena = (a, b) => (b.roleta ? 1 : 0) - (a.roleta ? 1 : 0)

  // NA BARRA ENCOLHIDA O AQUECIMENTO VAI TODO PRO FIM, DEPOIS DE UMA BARRINHA LARANJA (16/10/2026).
  //
  // Encolhida nao ha cabecalho nenhum (em 56px o nome do vendedor nao cabe), entao a separacao por
  // area que existe na barra larga simplesmente SUMIA: palavras do Bruno, "os numeros acabam
  // ficando sem essa separacao, eu nao sei qual deles esta em aquecimento ou qual e o numero de
  // vendas normal". Numa lista de quatro bolinhas iguais, confundir um numero que aquece com um
  // que vende e errar pra qual numero mandar o cliente.
  //
  // POR QUE UMA SO, E NAO UMA POR VENDEDOR: encolhida nao existe agrupamento visivel por vendedor
  // (o dono fica no passe de mouse), entao uma barrinha por grupo separaria blocos que a tela nao
  // diz de quem sao. Com uma so, a leitura e a que ele pediu: tudo acima e numero de trabalho,
  // tudo abaixo esta aquecendo. A ordem dos vendedores continua valendo dentro de cada metade.
  if (barraFina) {
    const trabalho = []
    const aquece = []
    for (const [, itens] of grupos) {
      itens.filter((x) => !aquecendo(x)).sort(ordena).forEach((x) => trabalho.push(x))
      itens.filter(aquecendo).sort(ordena).forEach((x) => aquece.push(x))
    }
    lista.innerHTML = trabalho.map(linhaFina).join('')
      + (aquece.length
        ? '<div class="risco-aq" title="Daqui pra baixo, números em aquecimento">' + FOGO + '</div>'
          + aquece.map(linhaFina).join('')
        : '')
    ligaCliques()
    return
  }

  let html = ''
  for (const [dono, itens] of grupos) {
    // O AQUECIMENTO TEM AREA PROPRIA (16/10/2026). Antes o numero em aquecimento ficava solto no
    // fim da lista do vendedor, sem nada dizendo o que ele era - palavras do Bruno: "aquele numero
    // ali, ele so esta simplesmente jogado ali". Agora tem cabecalho proprio, na cor do aquecimento
    // (a mesma ambar da Contingencia), pra o vendedor entender que aqueles numeros sao outra coisa.
    const emAquec = itens.filter(aquecendo).sort(ordena)
    const normais = itens.filter((x) => !aquecendo(x)).sort(ordena)

    if (normais.length) {
      html += '<div class="vend"><span>' + esc(dono) + '</span><span class="risco"></span>'
        + '<span class="qtd">' + normais.filter((x) => x.roleta).length + '/' + normais.length + '</span></div>'
      html += normais.map(linha).join('')
    }
    if (emAquec.length) {
      const leads = emAquec.reduce((t, x) => t + (Number(x.leads_hoje) || 0), 0)
      html += '<div class="vend aquec"><span>Aquecimento</span><span class="risco"></span>'
        + '<span class="qtd" title="Leads que chegaram hoje nos números em aquecimento">'
        + leads + (leads === 1 ? ' lead' : ' leads') + '</span></div>'
      html += emAquec.map(linha).join('')
    }
  }
  lista.innerHTML = html
  ligaCliques()
}

// Os cliques das linhas, num lugar so porque a lista e desenhada por DOIS caminhos (encolhida e
// larga). Esquecer de ligar num deles deixaria metade da barra sem reagir a clique nenhum.
function ligaCliques() {
  for (const el of lista.querySelectorAll('.fino')) {
    el.onclick = () => abrir(cheio(el.dataset.nk))
  }

  for (const el of lista.querySelectorAll('.num')) {
    el.onclick = (e) => {
      if (e.target.closest('.sw') || e.target.closest('.fecha')) return
      abrir(el.dataset.numero)
    }
  }
  for (const b of lista.querySelectorAll('.sw')) {
    b.onclick = (e) => { e.stopPropagation(); viraRoleta(b.dataset.nk) }
  }
  for (const b of lista.querySelectorAll('.sw-off')) {
    b.onclick = (e) => { e.stopPropagation() }     // nao e interruptor: e um selo, so explica
  }
  for (const b of lista.querySelectorAll('.fecha')) {
    b.onclick = (e) => { e.stopPropagation(); fechar(b.dataset.fecha) }
  }
}

// A LINHA DO NUMERO, no mesmo desenho da Chegada de leads da dash (16/10/2026, pedido do Bruno:
// "quero parecido com a area de Pressels: ativo ou desativado, a sequencia, o limite e quantos
// leads chegaram").
//
// POR QUE COPIAR E NAO INVENTAR: ele ja le essas frases e essas cores na dash todo dia. Duas telas
// mostrando o MESMO estado com desenhos diferentes e o jeito mais barato de criar duvida sobre qual
// esta certa - e aqui as duas leem a mesma fonte, entao elas nunca discordam de verdade.
//
// O SIGNIFICADO DAS CORES NAO PODE MUDAR:
//   verde  #24c278 = recebendo agora
//   ambar  #f59e0b = fora AGORA, mas volta sozinho a meia-noite (bateu o teto, ou esta perto)
//   cinza  #94a3b8 = fora e so volta se alguem ligar
const FILA_ROTULO = { vez: 'recebendo', espera: 'na fila', bateu: 'no limite' }

// A frase inteira, do jeito que esta na dash. Vai no title: em 268px nao cabe na linha, e cortar
// pela metade seria pior que esconder.
function fraseEstado(n) {
  if (!n.roleta) return 'desligado'
  if (n.dist !== 'limite' || !n.fila) return 'distribuindo'
  if (n.fila.st === 'vez') return 'recebendo agora'
  // EM QUEM AQUECE, "bateu" NAO E LIMITE ESTOURADO: a cota da rampa abre ao longo do dia, entao ele
  // pegou a desta hora e volta a receber na proxima. Dizer "volta a meia-noite" faria o vendedor
  // achar que o numero travou ate amanha e desligar o interruptor por engano.
  if (n.fila.st === 'bateu') {
    return aquecendo(n) ? 'no ritmo do aquecimento, recebe mais daqui a pouco' : 'bateu o limite, volta à meia-noite'
  }
  return 'espera a vez'
}

// O TETO DE QUEM ESTA AQUECENDO NAO E O `lim_dia` DO CHIP (16/10/2026).
//
// Quem aquece tem o teto calculado pela RAMPA, no worker, a partir do dia de aquecimento - o
// `lim_dia` gravado no chip e outra coisa e costuma vir zero. Lendo so o `lim_dia`, o numero em
// aquecimento aparecia SEM contador nenhum na barra lateral, do jeito que o Bruno viu o 8551: a
// unica linha da lista sem placar, logo a unica sobre a qual a tela nao dizia nada.
// `aquec.teto` e a cota do dia inteiro, e vem pronto do servidor de proposito (calcular aqui usaria
// o fuso do cliente e as duas telas passariam a discordar).
const tetoDe = (n) => Number((n && n.aquec && n.aquec.teto) || (n && n.lim_dia)) || 0

// Cor do contador, pela regra do spec: quem bateu e ambar; quem esta na vez vira ambar a partir de
// 80% do teto (o aviso vem ANTES de parar, nao depois); quem espera e cinza.
function corDoContador(n) {
  if (!n.roleta) return '#94a3b8'
  const st = n.dist === 'limite' && n.fila ? n.fila.st : 'vez'
  // EM QUEM AQUECE, "bateu" E O ESTADO NORMAL DA MAIOR PARTE DO DIA: a cota da rampa abre de hora
  // em hora, ele pega a desta hora e espera a proxima. Pintar de ambar (que aqui significa aviso)
  // deixaria o numero em aquecimento parecendo problema o dia inteiro - e aviso que aparece sempre
  // e aviso que ninguem le mais, inclusive no numero estabelecido, onde ele importa.
  // Cinza de "esperando a vez", que e exatamente o que esta acontecendo.
  if (st === 'bateu') return aquecendo(n) ? '#94a3b8' : '#f59e0b'
  if (st !== 'vez') return '#94a3b8'
  const teto = tetoDe(n)
  const pct = teto ? (Number(n.leads_hoje) || 0) / teto : 0
  return pct >= 0.8 ? '#f59e0b' : '#24c278'
}

// A LINHA DA BARRA ENCOLHIDA. So o que o Bruno chamou de "algo que seja relevante": em que estado
// o numero esta (a cor, ou a posicao na fila), QUAL numero e (os 4 ultimos digitos, que e como a
// equipe se refere a eles) e quantos leads entraram hoje. O resto esta a um clique de distancia.
// Ligado na roleta e, no modo limite, na vez. No modo roleta simples todos os ligados dividem os
// leads, entao ligado ja e "recebendo".
const recebendoAgora = (n) => !!(n && n.roleta && (!n.fila || n.fila.st === 'vez'))

// SO DOIS ESTADOS RECEBEM LEAD (16/10/2026, regra do Bruno): "Em uso" na Contingencia, ou
// "Em aquecimento". Palavras dele: "outros numeros que estejam em outros estados, como por exemplo
// ativo, em analise e tudo mais, eu nao quero que apareca aquele interruptor. Quero que sempre
// deixe ele desligado".
//
// Quem DECIDE continua sendo o servidor - a lista ja vem com `roleta` falso pra esses. Isto aqui e
// a tela parando de OFERECER o que nao tem efeito: interruptor que nao liga nada e pior que
// interruptor nenhum, porque o vendedor clica, nada acontece e ele acha que o app travou.
const EM_AQUECIMENTO = 'aquecimento'
// QUEM DECIDE E O SERVIDOR, e `apto` e a resposta dele. Os outros tres sao reserva pra versao de
// worker que ainda nao manda o campo.
//
// POR QUE NAO REFAZER A CONTA AQUI (16/10/2026, tres bugs na tela do Bruno): "em uso" e
// "aquecimento" existem por DOIS caminhos - o estado operacional (`st`, escrito ao arrastar entre
// colunas) e a TAG (`wa_st`, escrita no seletor "Status WhatsApp" do editor, que e o caminho que
// esta na cara de quem abre o chip). Olhando so os campos crus, um numero Em Uso pela tag virava
// inacessivel no app e um numero em aquecimento pela tag aparecia como se nao fosse nada.
// Regra de negocio refeita no cliente diverge do servidor no primeiro caso que ninguem previu.
const aquecendo = (n) => !!n && (n.aquecendo === true || n.aquec != null || String(n.st || '') === EM_AQUECIMENTO)
// O VEREDICTO DO SERVIDOR VENCE, E NAO E UM DOS TERMOS DO OU (16/10/2026).
//
// Com `||`, um numero que o worker REPROVOU (apto:false) ainda passaria aqui pela flag crua
// `em_uso`. O caso concreto: chip marcado Restrito pela tag e com `em_uso: true` parado no campo -
// o worker diz que nao recebe, a roleta nao manda nada, e o app mostraria o interruptor ligado.
// Mentira de tela sobre numero restrito, que e a mesma familia dos cinco bugs de hoje.
// Os criterios crus ficam como RESERVA pra worker mais velho, que nao manda `apto` - e so nesse
// caso. Quando o servidor opina, e ele quem decide.
const podeReceber = (n) => !!n && (n.apto != null ? n.apto === true : (n.em_uso === true || aquecendo(n)))

function linhaFina(n) {
  const nk = numKey(n.numero)
  const emFila = n.dist === 'limite' && n.fila && n.fila.pos
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const corEstado = corDoContador(n)
  const sinal = emFila
    ? '<span class="pos" style="--pc:' + corEstado + '">' + n.fila.pos + '</span>'
    : '<span class="sinal"' + (corChip ? ' style="background:' + corChip + '"' : '') + '></span>'
  const quatro = cheio(nk).replace(/\D/g, '').slice(-4)
  const leads = Number(n.leads_hoje) || 0
  const teto = tetoDe(n)
  return '<button class="fino' + (recebendoAgora(n) ? ' recebendo' : '') + (nk === ativo ? ' ativo' : '') + '" data-nk="' + nk + '"'
    + ' title="' + esc(bonito(cheio(nk))) + (n.dono ? ' · ' + esc(n.dono) : '') + ' · ' + esc(fraseEstado(n)) + '">'
    + sinal
    + '<span class="d">' + quatro + '</span>'
    + '<span class="c" style="color:' + corEstado + '">' + leads + (teto ? '/' + teto : '') + '</span>'
    + '</button>'
}

function linha(n) {
  const nk = numKey(n.numero)
  const aberto = estado.abertos.includes(nk)
  const cls = ['num']
  // RECEBENDO AGORA = ligado na roleta E, no modo limite, sendo a vez dele. Sem a segunda parte,
  // os tres numeros do vendedor ficariam destacados ao mesmo tempo e o destaque nao diria nada.
  if (recebendoAgora(n)) cls.push('recebendo')
  if (nk === ativo) cls.push('ativo')
  if (carregando.has(nk)) cls.push('carregando')
  if (semMotor.has(nk)) cls.push('sem-motor')

  // NA FILA, A BOLINHA VIRA A POSICAO. E a mesma troca da dash: no modo Limite o que importa nao e
  // "esta de pe?", e "e a vez de quem?". Fora da fila, continua o ponto com a cor do cadastro.
  const emFila = n.dist === 'limite' && n.fila && n.fila.pos
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const corEstado = corDoContador(n)
  const sinal = emFila
    ? '<span class="pos" style="--pc:' + corEstado + '">' + n.fila.pos + '</span>'
    : '<span class="sinal"' + (corChip ? ' style="background:' + corChip + '"' : '') + '></span>'

  const zap = '<span class="zap' + (aberto ? '' : ' off') + '" title="' + (aberto ? 'Aberto nesta máquina' : 'Fechado') + '">' + ZAP + '</span>'
  // O DIA DO AQUECIMENTO NA PROPRIA LINHA (16/10/2026, pedido do Bruno: "do lado esquerdo do icone
  // de WhatsApp, o dia em que aquele numero esta de aquecimento - vai ter um foguinho, o dia e o
  // numero do ladinho").
  //
  // O cabecalho ambar ja diz QUE aquele bloco aquece; o que faltava era QUANTO FALTA. Com rampa, o
  // dia e a informacao que muda tudo: dia 2 recebe 5 leads, dia 12 recebe 35, e o mesmo rotulo
  // "aquecendo" cobria os dois. O dia vem do servidor (`aquec.dia`) porque ele e contado do
  // warm_start - a tela nao recalcula, pela mesma razao do `apto`.
  const dia = Number(n.aquec && n.aquec.dia) || 0
  const fogo = dia
    ? '<span class="aq" title="Dia ' + dia + ' do aquecimento. O teto de leads sobe conforme os dias passam: 5 até o dia 3, 10 até o 6, 20 até o 9, 35 até o 15, e 50 do 16 em diante.">'
      + FOGO + 'dia ' + dia + '</span>'
    : ''
  // CADEADO: outra MAQUINA esta com este numero aberto agora. Nao e erro nem bloqueio permanente -
  // e o aviso de que abrir ali criaria o cruzamento que derruba chip.
  const trancado = n.uso && !n.uso.meu
    ? '<span class="trancado" title="Aberto por ' + esc(n.uso.nome || 'outra pessoa') + '. Dois computadores no mesmo WhatsApp derruba número.">'
      + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">'
      + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'
    : ''
  const alerta = semMotor.has(nk)
    ? '<span class="alerta" title="O WhatsApp não carregou o motor aqui. Este número não está recebendo lead novo. Feche e abra de novo.">'
      + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">'
      + '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></span>'
    : ''

  // O CONTADOR: leads de hoje sobre o teto, com o rotulo do estado e uma barra de 2px na base.
  // Sem teto cadastrado nao ha o que medir, entao mostra so quantos chegaram.
  const leads = Number(n.leads_hoje) || 0
  const teto = tetoDe(n)
  // O rotulo curto do contador. Em quem aquece, "no limite" viraria mentira curta (ver fraseEstado):
  // "no ritmo" cabe no mesmo espaco e diz a verdade; a frase inteira fica no passe de mouse.
  const rot = !n.roleta ? 'desligado'
    : n.livre_hoje ? 'liberado'
      : (n.dist === 'limite' && n.fila
        ? ((n.fila.st === 'bateu' && aquecendo(n)) ? 'no ritmo' : (FILA_ROTULO[n.fila.st] || ''))
        : 'recebendo')
  const pct = teto ? Math.min(100, Math.round((leads / teto) * 100)) : 0
  const conta = teto
    ? '<span class="cnt" style="--cc:' + corEstado + '">' + leads + '/' + teto
      + (rot ? ' <i>' + rot + '</i>' : '')
      + '<b style="width:' + pct + '%"></b></span>'
    : (leads ? '<span class="cnt" style="--cc:' + corEstado + '">' + leads + ' hoje</span>' : '')

  // Fechar so faz sentido no que esta aberto. A sessao fica no disco: fechar NAO pede QR depois.
  const fecha = aberto
    ? '<span class="fecha" data-fecha="' + nk + '" role="button" title="Fechar este número (a sessão fica salva)">'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>'
    : ''

  // O INTERRUPTOR SO EXISTE PRA QUEM PODE RECEBER. Em outro estado ele nao ligaria nada (o servidor
  // recusa), e um botao que nao faz nada e pior que botao nenhum. No lugar dele vai um selo
  // apagado, que diz POR QUE nao da - sem o selo, o numero apareceria sem nada no canto e a leitura
  // seria "a tela nao carregou direito".
  const chave = podeReceber(n)
    ? '<span class="sw' + (n.roleta ? ' on' : '') + (mexendo.has(nk) ? ' ocupado' : '')
      + '" data-nk="' + nk + '" role="switch" aria-checked="' + !!n.roleta + '"'
      + ' title="' + (n.roleta ? 'Recebendo lead. Clique pra parar.' : 'Fora da roleta. Clique pra voltar a receber.') + '"></span>'
    : '<span class="sw-off" title="Só recebe lead quem está Em uso ou Em aquecimento na Contingência'
      + (n.status ? '. Este está como ' + esc(n.status) : '') + '">—</span>'

  // A DICA DE QUEM AQUECE PRECISA DOS DOIS NUMEROS. O contador mostra o teto do DIA (5), mas quem
  // decide se ele recebe agora e a cota JA LIBERADA nesta hora (`aquec.agora`, 2 por exemplo) - sem
  // dizer isso, "2/5" parado se le como numero travado por engano.
  const explicaAquec = (dia && n.aquec)
    ? ' · dia ' + dia + ': ' + (Number(n.aquec.teto) || 0) + ' no dia, '
      + (Number(n.aquec.agora) || 0) + ' liberados até agora'
    : ''
  return '<button class="' + cls.join(' ') + '" data-numero="' + esc(n.numero) + '" title="'
    + esc(bonito(n.numero) + ' · ' + fraseEstado(n) + explicaAquec + (n.status ? ' · ' + n.status : '')) + '">'
    + sinal
    + '<span class="corpo"><span class="fone">' + esc(bonito(n.numero)) + '</span>'
    + '<span class="sub">' + fogo + zap + trancado + alerta + conta + '</span></span>'
    + fecha + chave + '</button>'
}
// ───────────────────────────────────────────────────────────── palco

function telaLogin(erro) {
  palco.innerHTML = ''
    + '<div class="cartao">'
    + '<h2>Entrar</h2><p>Use o mesmo usuário e senha da dash.</p>'
    + '<div class="campo"><label>Usuário</label><input id="us" spellcheck="false" autocapitalize="off" /></div>'
    + '<div class="campo"><label>Senha</label><input id="pw" type="password" /></div>'
    + '<button class="principal" id="ok">Entrar</button>'
    + '<div class="aviso ' + (erro ? 'erro' : '') + '" id="av">' + esc(erro || '') + '</div>'
    + '</div>'
  $('us').focus()
  const entra = async () => {
    const b = $('ok'); b.disabled = true; b.textContent = 'Entrando...'
    const r = await window.sw.entrar($('us').value, $('pw').value)
    if (!r.ok) { await recarregaEstado(); return telaLogin(r.erro) }
    await recarregaEstado()
    telaVazia()
  }
  $('ok').onclick = entra
  $('us').onkeydown = (e) => { if (e.key === 'Enter') $('pw').focus() }
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') entra() }
}

function telaVazia() {
  window.sw.esconder()
  ativo = ''
  palco.innerHTML = ''
    + '<div class="vazio"><div class="icone">'
    + '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-4-1L3 21l2.1-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/></svg>'
    + '</div><h2>Escolha um número</h2>'
    + '<p>A chave do lado liga e desliga a chegada de lead.</p></div>'
  desenhaLista()
}

// TRADUZ O ERRO DO NAVEGADOR. O Chromium devolve coisas como ERR_PROXY_CONNECTION_FAILED (-130),
// que nao diz nada pra um vendedor. A frase tem que dizer o que fazer.
function humano(txt) {
  const t = String(txt || '')
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/i.test(t))
    return 'O proxy deste número não respondeu. Avise a direção.'
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|fetch failed|Failed to fetch/i.test(t))
    return 'Sem internet. Confira a conexão e tente de novo.'
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|demorou/i.test(t))
    return 'A conexão demorou demais. Tente de novo.'
  if (/ERR_CERT|SSL/i.test(t))
    return 'A conexão não é segura. Avise a direção.'
  return t
}

function telaErro(nk, erro) {
  falhou.set(nk, erro)
  carregando.delete(nk)
  window.sw.esconder()
  ativo = ''
  palco.innerHTML = ''
    + '<div class="cartao"><h2>Não abriu</h2>'
    + '<p>' + esc(bonito(cheio(nk))) + '</p>'
    + '<div class="aviso erro" style="display:block">' + esc(humano(erro)) + '</div>'
    + '<div class="acoes">'
    + (estado.direcao ? '<button class="secundario" id="cfg">Proxy</button>' : '')
    + '<button class="principal" style="margin:0" id="tentar">Tentar de novo</button></div></div>'
  const cfg = $('cfg')
  if (cfg) cfg.onclick = () => janelaProxy(nk)
  $('tentar').onclick = () => abrir(nk)
  desenhaLista()
}

// ───────────────────────────────────────────────────────────── ações

// CLICAR NO NUMERO NAO ABRE DIRETO (16/10/2026, pedido do Bruno, e o motivo e dele):
// "imagina o mesmo WhatsApp abrir em dois computadores ao mesmo tempo, o WhatsApp ia detectar que
// tem alguma coisa estranha". E assim que o AdsPower funciona: o navegador tem um botao de iniciar
// e nao deixa abrir o que ja esta aberto noutro lugar.
//
// Entao o clique mostra a sessao: o simbolo do WhatsApp, o numero, quem esta com ele se for o caso,
// e um botao. Abrir de verdade so no botao - e so depois de o servidor confirmar que ninguem mais
// esta com aquele numero.
function telaAbrir(nk) {
  const n = (estado.numeros || []).find((x) => numKey(x.numero) === nk)
  if (!n) return telaVazia()
  window.sw.esconder()
  ativo = nk
  const ocupado = n.uso && !n.uso.meu ? n.uso : null
  palco.innerHTML = ''
    + '<div class="abrir">'
    + '<span class="zapg' + (ocupado ? ' trancado' : '') + '">'
    + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6.2-.4v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 .6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1l-.3-.2Z"/></svg>'
    + '</span>'
    + '<h2>' + esc(bonito(cheio(nk))) + '</h2>'
    + (n.dono ? '<p class="de">' + esc(n.dono) + '</p>' : '')
    + (ocupado
      ? '<div class="aviso erro" style="display:block;max-width:360px;margin:14px auto 0">'
        + '<b>Aberto por ' + esc(ocupado.nome || 'outra pessoa') + '</b><br>'
        + 'O mesmo WhatsApp em dois computadores é o que mais derruba número. '
        + 'Quando a outra pessoa fechar, este botão libera sozinho.</div>'
        + '<button class="principal" disabled style="margin-top:14px">Em uso</button>'
      : '<button class="principal" id="ab-abrir" style="margin-top:14px">Abrir WhatsApp</button>')
    + '</div>'
  const b = $('ab-abrir')
  if (b) b.onclick = () => abrirDeVerdade(nk)
  desenhaLista()
}

async function abrir(numero) {
  const nk = numKey(numero)
  if (!nk || carregando.has(nk)) return
  falhou.delete(nk)
  // Numero JA ABERTO nesta maquina so volta pra tela: nao ha nada pra reservar nem pra perguntar.
  if (estado.abertos.includes(nk)) {
    ativo = nk
    await window.sw.mostrar(nk)
    palco.innerHTML = ''
    desenhaLista()
    return
  }
  telaAbrir(nk)
}

async function abrirDeVerdade(nk) {
  if (!nk || carregando.has(nk)) return
  const numero = (((estado.numeros || []).find((x) => numKey(x.numero) === nk)) || {}).numero || nk
  falhou.delete(nk)
  carregando.add(nk)
  ativo = nk
  desenhaLista()
  palco.innerHTML = '<div class="vazio"><h2>Abrindo ' + esc(bonito(cheio(nk))) + '</h2><p id="passo">Preparando a sessão...</p></div>'
  const r = await window.sw.abrir(numero)
  carregando.delete(nk)
  // A MESMA GUARDA DO OUVINTE sw:erro, QUE AQUI FALTAVA.
  //
  // O vendedor clica em A (proxy ruim, preflight de 20 s), cansa, clica em B e comeca a conversar.
  // Vinte segundos depois a promessa de A volta com erro e `telaErro` chamava `esconder()`: a tela
  // do B era arrancada e o palco mostrava "Nao abriu" do A. O B continuava aberto e capturando, so
  // tinha sumido da tela, e ele nao tinha como saber.
  if (!r.ok) {
    if (ativo !== nk) { falhou.set(nk, r.erro || 'Falhou.'); desenhaLista(); return }
    // OCUPADO NAO E FALHA: e a trava fazendo o trabalho dela. Volta pra tela da sessao, que ja sabe
    // dizer quem esta com o numero, em vez da tela vermelha de "Nao abriu".
    if (r.ocupado) { await recarregaEstado(); return telaAbrir(nk) }
    return telaErro(nk, r.erro || 'Falhou.')
  }
  await recarregaEstado()
  // O cartao "Abrindo..." SO SAI quando a view ja esta por cima, senao fica um retangulo vazio na
  // tela por segundos enquanto o WhatsApp carrega.
  if (ativo === nk) palco.innerHTML = ''
  desenhaLista()
}
async function fechar(nk) {
  await window.sw.fechar(nk)
  await recarregaEstado()
  if (ativo === nk) { ativo = ''; telaVazia() } else desenhaLista()
}

// LIGA E DESLIGA A CHEGADA DE LEAD naquele número. É a mesma chave da Contingência: muda o chip,
// e a roleta passa a pular (ou a incluir) o número na escolha seguinte.
async function viraRoleta(nk) {
  if (mexendo.has(nk)) return
  const n = (estado.numeros || []).find((x) => numKey(x.numero) === nk)
  if (!n) return
  mexendo.add(nk)
  const antes = n.roleta
  n.roleta = !antes            // otimista: a chave vira na hora
  desenhaLista()
  const r = await window.sw.roleta(nk, !antes)
  mexendo.delete(nk)
  if (!r || !r.ok) { n.roleta = antes; desenhaLista(); return }
  await recarregaEstado()
}

// SEPARA UM PROXY COLADO DE UMA LINHA SO. O Bruno cola do painel do Decodo, que entrega no
// formato host:porta:usuario:senha. Digitar campo a campo quatro vezes por numero, em 90 numeros,
// e onde a paciencia acaba. Aceita tambem http://usuario:senha@host:porta.
function separaProxy(txt) {
  const t = String(txt || '').trim()
  if (!t) return null
  try {
    if (/^\w+:\/\//.test(t)) {
      const u = new URL(t)
      if (!u.hostname) return null
      return { host: u.hostname, porta: u.port || '', usuario: decodeURIComponent(u.username || ''), senha: decodeURIComponent(u.password || '') }
    }
  } catch (_) { /* nao era URL: tenta o formato de dois pontos */ }
  const p = t.split(':')
  if (p.length < 2) return null
  const host = p[0].trim()
  const porta = String(p[1] || '').replace(/\D/g, '')
  if (!host || !porta) return null
  return { host, porta, usuario: (p[2] || '').trim(), senha: p.slice(3).join(':').trim() }
}

function janelaAjustes() {
  const t = Number(estado.maxAbertos) || 6
  let html = '<h2>Ajustes<span class="ver">v' + esc(estado.versao || '') + '</span></h2>'
  if (estado.direcao) {
    html += '<p>As travas são da operação. O teto é só desta máquina.</p>'
      + '<div class="chave"><div class="txt"><b>Exigir proxy</b><span>Sem proxy cadastrado e respondendo, o número não abre.</span></div>'
      + '<button class="sw ' + (estado.travaProxy ? 'on' : '') + '" id="sw1" role="switch" aria-checked="' + estado.travaProxy + '"></button></div>'
      + '<div class="chave"><div class="txt"><b>Exigir IP do Brasil</b><span>Proxy de fora num número +55 é pior que proxy nenhum.</span></div>'
      + '<button class="sw ' + (estado.exigirBrasil ? 'on' : '') + '" id="sw2" role="switch" aria-checked="' + estado.exigirBrasil + '"></button></div>'
  }
  // VER COMO UM DOS VENDEDORES (16/10/2026, pedido do Bruno: "quero ver como seria a visualizacao
  // dele, pra acompanhar o dia a dia e ver se ele esta convertendo certinho").
  //
  // Quem responde como a pessoa e a DASH, nao o app: o pedido sai com ?como=<id> e volta com o que
  // o login dela traria. E a mesma peca do "ver como" da dash e ela so ESTREITA. Por isso o preview
  // aparece so pra quem ja e direcao de verdade - dentro dele `estado.direcao` vem false do
  // servidor e esta tela some sozinha, que e o certo.
  const vends = (estado.vendedores || []).filter((v) => v && v.id && v.id !== 'dir')
  if (estado.direcao && vends.length) {
    html += '<div class="chave"><div class="txt"><b>Ver como vendedor</b>'
      + '<span>A tela fica igualzinha à dele: só os números dele, sem nada de proxy. Leitura apenas.</span></div>'
      + '<div class="escolha" id="como">'
      + '<button type="button" id="como-bt"><span class="v">'
      + esc((vends.find((v) => v.id === estado.como) || {}).nome || 'Eu mesmo') + '</span>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>'
      + '</button><div class="ops">'
      + '<button type="button" data-como="" class="' + (estado.como ? '' : 'on') + '">Eu mesmo</button>'
      + vends.map((v) => '<button type="button" data-como="' + esc(v.id) + '" class="' + (estado.como === v.id ? 'on' : '') + '">' + esc(v.nome) + '</button>').join('')
      + '</div></div></div>'
  }
  if (estado.como) {
    html += '<div class="chave"><div class="txt"><b>Você está vendo como outra pessoa</b>'
      + '<span>Ligar ou desligar número continua acontecendo como você, não como ela.</span></div>'
      + '<button class="secundario" id="como-sair" style="margin:0">Voltar a ser eu</button></div>'
  }
  html += '<div class="chave"><div class="txt"><b>Painel de venda ao lado</b>'
    + '<span>As respostas rápidas e os funis, do lado direito do WhatsApp.</span></div>'
    + '<button class="sw ' + (estado.painelLigado !== false ? 'on' : '') + '" id="sw3" role="switch" aria-checked="' + (estado.painelLigado !== false) + '"></button></div>'
  html += '<div class="chave"><div class="txt"><b>Números abertos ao mesmo tempo</b>'
    + '<span>Cada um consome memória. Passando do teto, o mais parado fecha sozinho e volta sem pedir QR.</span></div>'
    + '<input id="teto" value="' + t + '" inputmode="numeric" style="width:54px;text-align:center;padding:6px;border-radius:8px;border:1px solid var(--linha);background:rgba(255,255,255,.03);outline:none" /></div>'
    + '<div class="acoes"><button class="secundario" id="t-log">Abrir registro</button>'
    + '<button class="secundario" id="t-fechar">Fechar</button></div>'
  modalCorpo.innerHTML = html
  abreModal()
  if (estado.direcao) {
    // A trava mora no SERVIDOR: o app pede e só acredita no que voltar. Se o servidor recusar
    // (não é direção, sem rede), a chave volta pro lugar e a tela diz por quê.
    const mexeTrava = async (patch) => {
      const r = await window.sw.trava(patch)
      estado.travaProxy = r.travaProxy
      estado.exigirBrasil = r.exigirBrasil
      desenhaTrava()
      janelaAjustes()
      if (!r.ok) {
        const el = document.createElement('div')
        el.className = 'aviso erro'
        el.style.display = 'block'
        el.textContent = r.erro || 'Não salvou'
        modalCorpo.insertBefore(el, modalCorpo.querySelector('.acoes'))
      }
    }
    $('sw1').onclick = () => mexeTrava({ travaProxy: !estado.travaProxy })
    $('sw2').onclick = () => mexeTrava({ exigirBrasil: !estado.exigirBrasil })
  }
  $('sw3').onclick = async () => {
    const r = await window.sw.painel(!(estado.painelLigado !== false))
    estado.painelLigado = r.ligado
    janelaAjustes()
  }
  $('teto').onchange = async (e) => {
    const r = await window.sw.teto(e.target.value)
    estado.maxAbertos = r.maxAbertos
    e.target.value = r.maxAbertos
    await recarregaEstado()
  }
  const sel = $('como')
  if (sel) {
    $('como-bt').onclick = (ev) => { ev.stopPropagation(); sel.classList.toggle('aberta') }
    for (const b of sel.querySelectorAll('[data-como]')) {
      b.onclick = async (ev) => {
        ev.stopPropagation()
        sel.classList.remove('aberta')
        await window.sw.verComo(b.dataset.como)
        await recarregaEstado()
        janelaAjustes()
      }
    }
  }
  const sair = $('como-sair')
  if (sair) sair.onclick = async () => { await window.sw.verComo(''); await recarregaEstado(); janelaAjustes() }
  $('t-log').onclick = () => window.sw.abrirLog()
  $('t-fechar').onclick = fechaModal
}

// A janelinha é desenhada pela CASCA, que fica ATRÁS da view do número e da do painel. Com um
// número aberto, ela abria invisível. Então esconder as views enquanto ela estiver na tela.
function fechaModal() {
  modal.classList.remove('on')
  if (ativo) window.sw.mostrar(ativo)
}
function abreModal() {
  window.sw.esconder()
  modal.classList.add('on')
}

// ───────────────────────────────────────────────────────────── início

async function recarregaEstado() {
  // MODO FOTO: a tela NAO rele (16/10/2026). O `foto.js` injeta um estado de exemplo pra retratar a
  // lista cheia, e esta funcao trocava ele pelos numeros reais no meio da sessao - as fotos 2, 3 e
  // 3b sairam com dado de producao em vez do exemplo. Nao adianta so parar o intervalo: aqui chegam
  // tambem o ouvinte de `focus`, o `visibilitychange` e as chamadas de dentro do viraRoleta, do
  // fechar e dos avisos sw:aberto/sw:fechado/sw:hibernou. Sair cedo AQUI cobre todos de uma vez,
  // porque todos passam por esta porta.
  if (window.__swFoto) return
  estado = await window.sw.estado()
  $('versao').textContent = estado.como
    ? (((estado.vendedores || []).find((x) => x.id === estado.como) || {}).nome || 'vendedor')
    : (estado.nome || ('v' + estado.versao))
  desenhaPreview()
  // As duas classes que mudam o layout da casca. `sem-painel` acende a abinha de voltar, que so
  // existe porque o painel escondido deixa uma fresta de 22px (ver main.js).
  barraFina = !!estado.barraEncolhida
  document.body.classList.toggle('fina', barraFina)
  document.body.classList.toggle('sem-painel', estado.painelLigado === false)
  $('versao').title = 'SellWave Web v' + estado.versao
    + (estado.agenteDeOnde === 'servidor' ? ' · motor de conversa atualizado' : '')
  avisaVersao(estado.precisaBaixar ? estado : null)
  desenhaTrava()
  desenhaLista()
  return estado
}

// VERSAO NOVA PUBLICADA. O botao abre o instalador no navegador; a instalacao e por cima e a
// sessao de cada numero fica salva (a pasta de dados e fixa, ver main.js).
function avisaVersao(d) {
  const el = $('versao-nova')
  if (!el) return
  if (!d || !d.publicada && !d.versaoPublicada) { el.hidden = true; return }
  const nova = d.publicada || d.versaoPublicada
  el.hidden = false
  el.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 13px;color:var(--verde)">'
    + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>'
    + '<span><b>Versão ' + esc(nova) + ' disponível</b><br>Você está na ' + esc(d.atual || estado.versao)
    + '. Clique pra baixar, instale por cima.</span>'
  el.title = 'As conversas e os números pareados continuam salvos'
  el.onclick = () => window.sw.abrirInstalador()
}

// A TELA TEM QUE DIZER QUE E PREVIEW. Sem isto, o Bruno entra no "ver como", some metade da tela
// (proxy, travas, numeros dos outros) e a leitura natural e "quebrou" ou "perdi permissao".
function desenhaPreview() {
  const el = $('preview')
  if (!el) return
  if (!estado.como) { el.hidden = true; return }
  const nome = ((estado.vendedores || []).find((x) => x.id === estado.como) || {}).nome || 'vendedor'
  el.hidden = false
  el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
    + 'stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 12px"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>'
    + '<circle cx="12" cy="12" r="3"/></svg><span>Vendo como <b>' + esc(nome) + '</b></span>'
    + '<button id="preview-sair" title="Voltar a ser você">sair</button>'
  const b = $('preview-sair')
  if (b) b.onclick = async () => { await window.sw.verComo(''); await recarregaEstado() }
}

function avisoRede(txt) {
  const el = $('trava')
  el.hidden = false
  el.className = 'trava solta'
  $('trava-txt').innerHTML = '<b>Sem contato com a dash</b> · usando o que está salvo'
  el.title = String(txt || '')
}

async function inicio() {
  await recarregaEstado()
  if (!estado.temToken) return telaLogin('')
  const r = await window.sw.numeros()
  await recarregaEstado()
  if (!r.ok) {
    // Sessão morta vai pro login; falta de rede não. Antes, dash fora do ar derrubava o vendedor
    // pra tela de entrar, onde o login também falhava: ele ficava preso sem conseguir trabalhar.
    if (/401|403|sess|senha|autenti/i.test(String(r.erro || ''))) return telaLogin(r.erro)
    avisoRede(r.erro)
    return telaVazia()
  }
  telaVazia()
}

// ENCOLHER E VOLTAR. Quem muda a largura de verdade e o processo principal, porque e ele que
// reposiciona a view do WhatsApp; aqui so pedimos e pintamos. O estado volta no sw:estado, entao
// nao ha duas verdades sobre a barra estar fina.
$('encolhe').onclick = async () => {
  const quer = !barraFina
  $('encolhe').title = quer ? 'Voltar a barra' : 'Encolher a barra'
  try { await window.sw.barra(quer) } catch (_) { /* o estado seguinte corrige */ }
  await recarregaEstado()
}
// A ABINHA DE VOLTAR O PAINEL. O botao de esconder vive DENTRO do painel, entao sem isto o caminho
// de volta era so Ajustes - e foi exatamente onde o Bruno se perdeu em 16/10.
$('fresta').onclick = async () => {
  try { await window.sw.painel(true) } catch (_) { /* idem */ }
  await recarregaEstado()
}

$('trava').onclick = janelaAjustes
$('ajustes').onclick = janelaAjustes
// SINCRONIA NOS DOIS SENTIDOS, SEM BOTAO (16/10/2026, pedido do Bruno). Ligar ou desligar um
// numero na Chegada de leads da dash passa a refletir aqui sozinho, e o contrario tambem - as duas
// telas leem a MESMA fonte, entao basta reler.
//
// 20 SEGUNDOS, e nao 3: a leitura passa pelo estado inteiro da dash e o poll curto em consulta
// quente ja derrubou a dash uma vez (ver memoria d1-lentidao-consultas-quentes). O interruptor da
// propria tela ja e otimista, entao quem mexe aqui ve na hora; os 20s sao pra mudanca que veio de
// FORA.
async function sincroniza() {
  if (!estado.temToken || document.hidden) return
  try { await window.sw.numeros(); await recarregaEstado() } catch (_) { /* a proxima tentativa resolve */ }
}
window.__swSync = setInterval(sincroniza, 20000)
// Voltar pra janela e o momento em que a pessoa MAIS repara que algo mudou noutro lugar.
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincroniza() })
// E AO GANHAR FOCO, que e o que de fato acontece aqui: o SellWave Web e uma JANELA, e alternar
// entre a janela dele e a do navegador NAO muda o visibilityState. So com visibilitychange, voltar
// da dash pro app continuaria mostrando o estado velho - justo o caso que a sincronia existe pra
// resolver. Trava de 5s pra alt-tab repetido nao virar leitura em rajada.
let ultimoFoco = 0
window.addEventListener('focus', () => {
  if (Date.now() - ultimoFoco < 5000) return
  ultimoFoco = Date.now()
  sincroniza()
})
$('sair').onclick = async () => { await window.sw.sair(); await recarregaEstado(); telaLogin('') }
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenhaLista() }
modal.onclick = (e) => { if (e.target === modal) fechaModal() }
document.onkeydown = (e) => { if (e.key === 'Escape') fechaModal() }

window.sw.ao('sw:status', (d) => { const p = $('passo'); if (p && d) p.textContent = d.texto })
// POR ONDE O NUMERO SAIU. O main ja mandava e ninguem escutava: a informacao mais util do preflight
// (IP, pais e cidade do proxy daquele chip) morria no caminho.
window.sw.ao('sw:saida', (d) => {
  const p = $('passo')
  if (!p || !d || !d.ip) return
  p.textContent = 'Saindo por ' + d.ip + (d.pais ? ' · ' + d.pais : '') + (d.cidade ? ' · ' + d.cidade : '')
})
window.sw.ao('sw:erro', (d) => {
  if (!d || !d.nk) return
  // Só troca a tela se for o número que está na frente: um número escondido falhando não pode
  // arrancar da tela o número em que o vendedor está conversando.
  if (d.nk === ativo || !ativo) { telaErro(d.nk, d.erro); return }
  falhou.set(d.nk, d.erro)
  desenhaLista()
})
window.sw.ao('sw:aberto', async () => { await recarregaEstado() })
window.sw.ao('sw:fila', (d) => {
  const el = $('fila')
  if (!el) return
  const n = (d && Number(d.n)) || 0
  el.textContent = n ? (n + ' mensagens na fila') : ''
  el.title = n ? 'Capturadas, ainda não subiram para a dash' : ''
})
window.sw.ao('sw:hibernou', async (d) => {
  await recarregaEstado()
  if (d && d.nk === ativo) { ativo = ''; telaVazia() }
})
// FECHAR PELO PAINEL TAMBEM TEM QUE CHEGAR AQUI. O main avisava e ninguem escutava: `estado.abertos`
// ficava desatualizado, `ativo` continuava apontando pro numero fechado e o proximo clique nele
// entrava pelo atalho de "ja esta aberto" - nada abria e a tela ficava preta.
window.sw.ao('sw:fechado', async (d) => {
  semMotor.delete((d && d.nk) || '')
  await recarregaEstado()
  if (d && d.nk === ativo) { ativo = ''; telaVazia() }
})
window.sw.ao('sw:versao', (d) => avisaVersao(d))
// Agente novo baixado: vale ao recarregar a pagina do numero, que e o botao que ja existe no
// painel. Sem fechar o app.
window.sw.ao('sw:agente', () => {
  const el = $('fila')
  if (el && !el.textContent) {
    el.textContent = 'Motor de conversa atualizado. Recarregue o número pra usar o novo.'
    setTimeout(() => { if (el.textContent.startsWith('Motor de conversa')) el.textContent = '' }, 20000)
  }
})
window.sw.ao('sw:semMotor', (d) => {
  if (!d || !d.nk) return
  if (d.ok) semMotor.delete(d.nk); else semMotor.add(d.nk)
  desenhaLista()
})

// Fechar o número que está aberto: Ctrl+W é o que todo mundo espera num navegador.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && ativo) { e.preventDefault(); fechar(ativo) }
})

inicio()
