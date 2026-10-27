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

let estado = { numeros: [], proxies: {}, abertos: [], temToken: false, direcao: false }
let ativo = ''
const carregando = new Set()
// Numeros cujo motor do WhatsApp nao carregou. Eles continuam abrindo e conversando, mas NAO batem
// sinal de vida: em 3 minutos a roleta para de mandar lead pra eles. Isso tem que estar na cara.
const semMotor = new Set()
const falhou = new Map()
const mexendo = new Set()      // números com a chave da roleta em trânsito
const confirmados = new Map()  // nk -> { on, ate }: o que a pessoa clicou, valendo ate o servidor confirmar (ver viraRoleta)
const erroChave = new Map()    // nk -> frase: a dash recusou o clique (a chave pisca vermelha 4 s)
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

// A SETINHA PRA FORA, que substitui o icone do WhatsApp na linha do numero que esta em janela
// propria: o mesmo desenho do botao que destacou, pra ligar as duas coisas na cabeca de quem usa.
const SETA_FORA = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>'

// O foguinho do aquecimento (lucide `flame`). Icone, nunca emoji: emoji muda de desenho em cada
// maquina e nao herda a cor do texto.
const FOGO = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>'
// A nuvem da sessao salva (lucide cloud), do tamanho do icone do WhatsApp.
const NUVEM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>'
const ZAP = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6.2-.4v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 .6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1l-.3-.2Z"/></svg>'

// ───────────────────────────────────────────────────────────── barra lateral

function desenhaTrava() {
  const el = $('trava')
  // A FAIXA SO FALA QUANDO ALGO PEDE ATENCAO (16/10/2026, pedido do Bruno: "fica so com o
  // essencial, o resto vai pra dentro de Ajustes").
  //
  // O QUE ELA DIZ MUDOU EM 17/10/2026. Antes ela avisava "trava de proxy desligada", e esse
  // interruptor acabou: proxy virou obrigatoria, sem jeito de desligar. Faixa que fala de um
  // controle que nao existe mais e pior que faixa nenhuma.
  //
  // O que ela conta agora e o unico problema que sobrou NESTE assunto e que a pessoa pode resolver:
  // tem numero que NAO VAI ABRIR porque esta sem proxy. Isso e trabalho pendente dela (escolher uma
  // proxy do banco, na Contingencia), e antes so aparecia quando o vendedor tentava abrir e falhava.
  // DUAS COISAS PODEM PEDIR ATENCAO, E A ORDEM NAO E ARBITRARIA: numero LIBERADO e risco
  // correndo agora (ele esta saindo pelo IP desta casa, com hora pra acabar); numero SEM PROXY e
  // trabalho pendente (nao abre, ninguem se expoe). Risco correndo vem primeiro.
  const agora = Math.floor(Date.now() / 1000)
  const soltos = (estado.numeros || []).filter((n) => n.excecao && Number(n.excecao.ate) > agora)
  if (soltos.length) {
    el.hidden = false
    el.className = 'trava solta'
    // O MENOR PRAZO MANDA: e o que volta a exigir primeiro, e o que decide quando olhar de novo.
    const falta = Math.max(1, Math.round((Math.min(...soltos.map((n) => Number(n.excecao.ate))) - agora) / 60))
    const quem = soltos.length === 1 ? bonito(cheio(numKey(soltos[0].numero))) : soltos.length + ' números'
    $('trava-txt').innerHTML = '<b>' + esc(quem) + ' sem proxy</b> · volta a exigir em ' + falta + ' min'
    return
  }
  // SO PRA DIRECAO, como era antes: e trabalho dela, e o vendedor nao tem como resolver. Pro
  // vendedor a recusa aparece na tela do proprio numero, com a frase que diz o que fazer.
  // (A linha de cima nao tem esse corte de proposito: numero liberado APARECE pro vendedor, porque
  // e ele que esta com o chip na mao e tem que saber que esta sem proxy.)
  const sem = estado.direcao ? (estado.numeros || []).filter((n) => !n.proxy) : []
  if (!sem.length) { el.hidden = true; return }
  el.hidden = false
  el.className = 'trava solta'
  const quem = sem.length === 1
    ? bonito(cheio(numKey(sem[0].numero))) + ' sem proxy'
    : sem.length + ' números sem proxy'
  $('trava-txt').innerHTML = '<b>' + esc(quem) + '</b> · não abrem até escolher uma na dash'
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
    const k = n.dono || DISPONIVEIS
    if (!grupos.has(k)) grupos.set(k, [])
    grupos.get(k).push(n)
  }
  // DISPONIVEIS VAI PRO FIM (24/10/2026). Numero sem dono nao e a lista de trabalho de ninguem: e a
  // prateleira de onde ele tira. No meio dos vendedores viraria so mais um nome.
  if (grupos.has(DISPONIVEIS)) { const d = grupos.get(DISPONIVEIS); grupos.delete(DISPONIVEIS); grupos.set(DISPONIVEIS, d) }
  // NA ORDEM DA FILA (19/10/2026, pedido do Bruno: a lista do Guilherme saia "2, 3, 4, 1" porque
  // quem recebia subia; ele quer "1, 2, 3, 4", a mesma sequencia da Chegada de leads). Quem tem
  // posicao na fila vai pela posicao; quem esta fora dela (desligado, ou roleta sem fila) vem depois,
  // com quem esta recebendo na frente, como antes.
  const ordena = (a, b) => {
    const pa = Number(a.fila && a.fila.pos) || 0
    const pb = Number(b.fila && b.fila.pos) || 0
    if (pa && pb) return pa - pb
    if (pa || pb) return pa ? -1 : 1
    return (b.roleta ? 1 : 0) - (a.roleta ? 1 : 0)
  }

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

  // O PLACAR DE HOJE DA EQUIPE, no topo (23/10/2026, pedido do Bruno: "uma fotinha dos outros
  // vendedores com a quantidade de leads que chegaram pra ele no total, so pra ele ter nocao").
  // Vem pronto do servidor (`equipe`): a mesma conta do placar da roleta. Sem filtro de busca: e o
  // retrato do time, nao parte da lista.
  let html = filtro ? '' : placarEquipe()
  for (const [dono, itens] of grupos) {
    // O AQUECIMENTO TEM AREA PROPRIA (16/10/2026). Antes o numero em aquecimento ficava solto no
    // fim da lista do vendedor, sem nada dizendo o que ele era - palavras do Bruno: "aquele numero
    // ali, ele so esta simplesmente jogado ali". Agora tem cabecalho proprio, na cor do aquecimento
    // (a mesma ambar da Contingencia), pra o vendedor entender que aqueles numeros sao outra coisa.
    const emAquec = itens.filter(aquecendo).sort(ordena)
    const normais = itens.filter((x) => !aquecendo(x)).sort(ordena)

    if (normais.length) {
      const d0 = itens[0] || {}
      // A PRATELEIRA TEM CABECALHO PROPRIO, verde como a coluna da Contingencia, sem foto (nao e de
      // ninguem) e contando o que FALTA CONECTAR, que e o trabalho que ele vem fazer aqui. O
      // "recebendo/total" dos vendedores nao diria nada: numero sem dono nao recebe lead nenhum, e
      // o proprio selo no lugar do interruptor ja explica isso linha por linha.
      if (dono === DISPONIVEIS) {
        const faltam = normais.filter(faltaConectar).length
        html += '<div class="vend disp"><span>' + esc(DISPONIVEIS) + '</span><span class="risco"></span>'
          + '<span class="qtd" title="' + (faltam
            ? 'Abra cada um e leia o QR. Depois é só atribuir o número a um vendedor na Contingência.'
            : 'Todos conectados. Já dá pra atribuir a um vendedor na Contingência.')
          + '">' + (faltam ? faltam + ' a conectar' : 'conectados') + '</span></div>'
      } else {
        html += '<div class="vend"><span class="vnome">' + avatar(d0.foto, d0.sigla, d0.corDono, dono) + esc(dono) + '</span><span class="risco"></span>'
          + '<span class="qtd">' + normais.filter((x) => x.roleta).length + '/' + normais.length + '</span></div>'
      }
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

// A FOTO REDONDA DE QUEM ATENDE (23/10/2026). A imagem chega pronta do main, ja reduzida (`estado.fotos`,
// por endereco); sem foto, a sigla na cor da pessoa, igual a dash. A sigla sai pelo CSS (data-ini), nao
// como texto: assim o texto do cabecalho continua sendo so o nome.
function avatar(foto, sigla, cor, nome, cls) {
  const img = foto && estado.fotos ? estado.fotos[foto] : ''
  const c = /^#[0-9a-f]{3,8}$/i.test(String(cor || '')) ? cor : '#64748b'
  const ini = String(sigla || String(nome || '?').split(/\s+/).map((p) => p[0] || '').join('').slice(0, 2)).toUpperCase()
  return '<i class="av' + (cls ? ' ' + cls : '') + '" style="--avc:' + c + '"' + (img ? '' : ' data-ini="' + esc(ini) + '"') + '>'
    + (img ? '<img src="' + esc(img) + '" alt="">' : '') + '</i>'
}
function placarEquipe() {
  const eq = Array.isArray(estado.equipe) ? estado.equipe : []
  if (eq.length < 2) return ''
  return '<div class="equipe"><div class="eq-tit">Leads de hoje</div><div class="eq-lista">'
    + eq.map((e) => '<div class="eq' + (e.eu ? ' eu' : '') + '" title="' + esc(e.nome) + ': ' + (Number(e.leads) || 0) + (Number(e.leads) === 1 ? ' lead hoje' : ' leads hoje') + '">'
      + avatar(e.foto, e.sigla, e.cor, e.nome, 'grande')
      + '<span class="eq-n">' + esc(String(e.nome || '').split(/\s+/)[0]) + '</span>'
      + '<b>' + (Number(e.leads) || 0) + '</b></div>').join('')
    + '</div></div>'
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
  // NA PRATELEIRA A FRASE E OUTRA (24/10/2026). Numero sem dono nao esta em roleta nenhuma, e o
  // `ligado` dele e verdade vazia (quer dizer so "nao ha interruptor desligado pra ele"), entao
  // todas as frases abaixo descreveriam uma fila em que ele nao esta. O que importa ali e so se ele
  // ja esta conectado, que e o trabalho que ele vem fazer na prateleira.
  if (!n.dono) {
    const c = seloConn(n)
    return 'sem dono ainda · ' + String(c.txt || '').toLowerCase()
  }
  if (!ligadoDe(n)) return n.volta ? 'desligado até a meia-noite' : 'desligado'
  if (!n.roleta) return 'ligado, mas nenhum computador está com ele aberto'
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
// A PRATELEIRA: os numeros da coluna "Disponiveis" da Contingencia, sem dono ainda (24/10/2026,
// pedido do Bruno). Ele conecta eles aqui e SO DEPOIS atribui a um vendedor. Mesmo nome da coluna
// de proposito: sao a mesma coisa, e dois nomes pro mesmo monte de numero criam duvida sobre se e.
const DISPONIVEIS = 'Disponíveis'
// FALTA CONECTAR? Conectado de verdade e ter sessao funcionando: "Conectado" ou "Fechado, mas
// conectado" (ver CONN_TXT). Desconectado, caiu, banido e sem informacao sao todos "ainda precisa do
// QR", que e exatamente o trabalho que ele vem fazer nesta prateleira.
const faltaConectar = (n) => {
  const c = (n && n.conn && n.conn.st) || ''
  return c !== 'pronto' && c !== 'sincronizando' && c !== 'fechado'
}

function linhaFina(n) {
  const nk = numKey(n.numero)
  // Mesma regra da linha larga: sem dono nao ha posicao de fila nem teto pra mostrar. Em 56px nao
  // cabe palavra nenhuma, entao a prateleira fica so com o ponto e os quatro digitos; o estado
  // inteiro continua no passe de mouse, que e o mesmo `fraseEstado` da outra barra.
  const prateleira = !n.dono
  const emFila = !prateleira && n.dist === 'limite' && n.fila && n.fila.pos
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const corEstado = corDoContador(n)
  const sinal = emFila
    ? '<span class="pos" style="--pc:' + corEstado + '">' + n.fila.pos + '</span>'
    : '<span class="sinal"' + (corChip ? ' style="background:' + corChip + '"' : '') + '></span>'
  const quatro = cheio(nk).replace(/\D/g, '').slice(-4)
  const leads = Number(n.leads_hoje) || 0
  const teto = tetoDe(n)
  return '<button class="fino' + (recebendoAgora(n) ? ' recebendo' : '') + (nk === ativo ? ' ativo' : '') + (carregando.has(nk) ? ' carregando' : '') + '" data-nk="' + nk + '"'
    + ' title="' + esc(bonito(cheio(nk))) + (n.dono ? ' · ' + esc(n.dono) : '') + ' · ' + esc(fraseEstado(n)) + '">'
    + sinal
    + '<span class="d">' + quatro + '</span>'
    + '<span class="c" style="color:' + corEstado + '">' + (prateleira ? '' : leads + (teto ? '/' + teto : '')) + '</span>'
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

  // NA PRATELEIRA A LINHA DIZ MENOS (24/10/2026, pedido do Bruno). Numero sem dono nao esta em fila
  // e nao tem teto: "preciso apenas saber se eles estao conectados ou nao". E nao e so limpeza - a
  // posicao e o teto saiam de `dist` e `lim_dia`, que SOBRARAM de quando o numero teve dono, entao
  // a tela mostrava resto de cadastro como se fosse estado de agora ("13/70 sem app aberto" num
  // numero que nao esta em fila nenhuma).
  const prateleira = !n.dono
  // NA FILA, A BOLINHA VIRA A POSICAO. E a mesma troca da dash: no modo Limite o que importa nao e
  // "esta de pe?", e "e a vez de quem?". Fora da fila, continua o ponto com a cor do cadastro.
  const emFila = !prateleira && n.dist === 'limite' && n.fila && n.fila.pos
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const corEstado = corDoContador(n)
  const sinal = emFila
    ? '<span class="pos" style="--pc:' + corEstado + '">' + n.fila.pos + '</span>'
    : '<span class="sinal"' + (corChip ? ' style="background:' + corChip + '"' : '') + '></span>'

  // JANELA PROPRIA: a linha diz onde o numero esta. Sem isso o vendedor clica nele esperando ver a
  // conversa aqui, a janela de la ganha o foco e ele nao entende por que a tela "nao mudou".
  const foraDaqui = (estado.destacados || []).includes(nk)
  const zap = '<span class="zap' + (aberto ? '' : ' off') + (foraDaqui ? ' fora' : '') + '" title="'
    + (foraDaqui ? 'Está numa janela própria. Clique pra trazer ela pra frente.' : (aberto ? 'Aberto nesta máquina' : 'Fechado'))
    + '">' + (foraDaqui ? SETA_FORA : ZAP) + '</span>'
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
  // O NUMERO DO CHIP NA CONTINGENCIA (19/10/2026, pedido do Bruno: "eu me baseio muito na numeracao deles,
  // como no aplicativo de celulares"). Pequeno e verde, colado no icone do WhatsApp, o mesmo selo da central.
  const nChip = Number(n.idx) || 0
  const idx = nChip ? '<span class="idx" title="Número ' + nChip + ' na Contingência">' + nChip + '</span>' : ''
  // CADEADO: outra MAQUINA esta com este numero aberto agora. Nao e erro nem bloqueio permanente -
  // e o aviso de que abrir ali criaria o cruzamento que derruba chip.
  const trancado = n.uso && !n.uso.meu
    ? '<span class="trancado" title="Aberto por ' + esc(n.uso.nome || 'outra pessoa') + '. Dois computadores no mesmo WhatsApp derruba número.">'
      + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">'
      + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'
    : ''
  // A NUVEM (19/10/2026): a sessao deste numero esta salva e abre ja conectada em qualquer computador.
  // Verde = salva; pulsando = subindo ou descendo agora; vermelha = a ultima tentativa falhou. Sem
  // sessao salva nao aparece nada, pra lista nao virar um painel de icones.
  const nv = (estado.nuvem || {})[nk]
  const salva = n.nuvem && Number(n.nuvem.ver) > 0
  const nvCls = nv && (nv.st === 'enviando' || nv.st === 'baixando') ? 'ocupado' : (nv && nv.st === 'erro' ? 'erro' : (salva || (nv && nv.st === 'salvo') ? 'ok' : ''))
  const nvTit = nvCls === 'ok'
    ? 'Sessão salva na nuvem' + (salva && n.nuvem.ts ? ' em ' + new Date(n.nuvem.ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
      + (salva && n.nuvem.nome ? ' por ' + n.nuvem.nome : '') + '. Abre já conectado em qualquer computador.'
    : String((nv && nv.txt) || '')
  const nuvem = nvCls
    ? '<span class="nv ' + nvCls + '" title="' + esc(nvTit) + '">' + NUVEM + '</span>'
    : ''
  // GENTE ESPERANDO NESTE NUMERO (20/10/2026). Com os numeros abertos em segundo plano, o vendedor
  // conversa num e os leads dos outros chegam sem ninguem ver. O contador e o das conversas com
  // mensagem nao lida, contado no proprio WhatsApp do numero; no numero da tela ele nao aparece.
  const nl = aberto && nk !== ativo ? (Number((estado.naoLidas || {})[nk]) || 0) : 0
  const naoLidas = nl
    ? '<span class="nl" title="' + nl + (nl === 1 ? ' conversa com mensagem não lida' : ' conversas com mensagem não lida') + ' neste número">' + (nl > 99 ? '99+' : nl) + '</span>'
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
  // LIGADO E SEM RECEBER e outra coisa que desligado: o interruptor esta certo, o que falta e alguem
  // com o numero aberto (sem app aberto o numero da casa nao recebe, ver roleta-casa-sem-api).
  const rot = !ligadoDe(n) ? (n.volta ? 'até 0h' : 'desligado')
    : !n.roleta ? 'sem app aberto'
    : n.livre_hoje ? 'liberado'
      : (n.dist === 'limite' && n.fila
        ? ((n.fila.st === 'bateu' && aquecendo(n)) ? 'no ritmo' : (FILA_ROTULO[n.fila.st] || ''))
        : 'recebendo')
  const pct = teto ? Math.min(100, Math.round((leads / teto) * 100)) : 0
  // Na prateleira, no lugar do contador vai a UNICA coisa que ele precisa saber ali. Duas palavras,
  // pela MESMA conta do cabecalho do grupo (`faltaConectar`): se as duas discordassem, o cabecalho
  // diria "2 a conectar" e as linhas diriam outra coisa, e nenhuma das duas serviria. A frase
  // inteira (o que e e o que fazer) continua no passe de mouse, vinda do seloConn.
  const sc = prateleira ? seloConn(n) : null
  const falta = prateleira && faltaConectar(n)
  const conta = prateleira
    ? '<span class="cnt" style="--cc:' + (falta ? '#f59e0b' : 'var(--verde)') + '" title="'
      + esc(sc.txt + '. ' + sc.det) + '">' + (falta ? 'falta conectar' : 'conectado') + '</span>'
    : teto
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
  // A CHAVE DESENHA O INTERRUPTOR, NAO O "RECEBENDO" (19/10/2026, pedido do Bruno: "clico pra ligar e
  // ele nao liga"). As tres cores sao as da Chegada de leads:
  //   verde   = ligado
  //   laranja = fora agora, mas volta sozinho a meia-noite (bateu o limite, ou desligado ate 0h)
  //   cinza   = desligado, so volta se alguem ligar
  // Clique: ligado (verde ou laranja do limite) desliga; desligado (cinza ou laranja do 0h) liga.
  const lig = ligadoDe(n)
  const limiteHoje = lig && n.dist === 'limite' && n.fila && n.fila.st === 'bateu' && !aquecendo(n)
  const ate0h = !lig && !!n.volta
  const chave = podeReceber(n)
    ? '<span class="sw' + (lig && !limiteHoje ? ' on' : '') + (limiteHoje || ate0h ? ' pausa' : '')
      + (mexendo.has(nk) ? ' ocupado' : '') + (erroChave.has(nk) ? ' erro' : '')
      + '" data-nk="' + nk + '" role="switch" aria-checked="' + lig + '"'
      + ' title="' + esc(erroChave.has(nk) ? 'Não salvou: ' + erroChave.get(nk)
        : mexendo.has(nk) ? 'Salvando...'
          : limiteHoje ? 'Ligado, mas bateu o limite de hoje: volta sozinho à meia-noite. Clique pra desligar.'
            : ate0h ? 'Desligado até a meia-noite: volta sozinho. Clique pra ligar agora.'
              : lig ? (n.roleta ? 'Ligado e recebendo lead. Clique pra desligar.' : 'Ligado, mas nenhum computador está com este número aberto agora. Clique pra desligar.')
                : 'Desligado. Clique pra ligar.') + '"></span>'
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
    + '<span class="sub">' + fogo + idx + zap + naoLidas + nuvem + trancado + alerta + conta + '</span></span>'
    + fecha + chave + '</button>'
}
// ───────────────────────────────────────────────────────────── palco

function telaLogin(erro) {
  // ESCONDE AS VIEWS ANTES DE DESENHAR. Sem isto o WhatsApp do numero aberto fica POR CIMA desta
  // tela: o vendedor sai da conta e continua vendo a conversa, achando que o clique nao pegou.
  try { window.sw.esconder() } catch (_) { /* sem numero aberto nao ha o que esconder */ }
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
    // O BOTAO PROXY SUMIU, e isso conserta um estouro. A `janelaProxy(nk)` que ele chamava NAO
    // EXISTE no projeto (uma chamada, zero definicoes): clicar dava ReferenceError, e era a tela
    // que o proprio comentario do main.js diz que prendeu o Bruno sem conseguir cadastrar proxy.
    // A funcao se perdeu numa edicao e levou junto o unico chamador do `separaProxy`.
    //
    // NAO ESTOU RECRIANDO porque a area de proxy esta saindo daqui: desde 17/10 o banco de proxies
    // mora na Contingencia, e e de la que o numero passa a receber a dele. Botao que estoura e pior
    // que botao que nao existe.
    + '<button class="principal" style="margin:0" id="tentar">Tentar de novo</button></div></div>'
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
// O ESTADO DA CONEXAO EM PALAVRAS (18/10/2026, pedido do Bruno: "gostaria que aparecesse alguma
// coisa bem visivel ali falando numero conectado, tudo certinho, so clicar em abrir").
//
// A REGRA QUE ORGANIZA ISTO E DELE: acao de gente nao e queda. Fechar o numero ou sair do app
// marca o fechamento, e o estado ruim que vier depois chega com `esp` falso - por isso "Fechado"
// e cinza e nao alarme. O que pinta de vermelho e o que caiu SOZINHO, com a janela aberta.
// `naosei` existe de proposito: numero que nunca foi aberto, ou agente velho sem o campo, nao
// pode aparecer como "conectado" por omissao. Foi exatamente assim que um numero na tela do QR
// entrou na roleta uma vez.
// GRANDE E EM PALAVRAS (19/10/2026, pedido do Bruno: "frasezinhas bem curtas, porem destacadas, pra eu entender
// rapidamente se aquele numero esta ativo ou nao" - conectado, banido, caiu, desconectado, ou so fechado mas ainda
// conectado). [tom, titulo curto, o que fazer]. "Sem leitura" e "Esperando ler o QR" nao diziam nada pra quem bate o
// olho: viraram "Sem informacao" e "Desconectado", cada um com a linha do que fazer.
const CONN_TXT = {
  pronto: ['ok', 'Conectado', 'Funcionando e recebendo mensagens.'],
  sincronizando: ['ok', 'Conectado', 'Carregando as conversas.'],
  fechado: ['fechado', 'Fechado, mas conectado', 'Da última vez estava funcionando. Abra pra voltar a receber lead.'],
  qr: ['alerta', 'Desconectado', 'Falta conectar: abra e leia o QR com o celular.'],
  caiu: ['ruim', 'Caiu', 'O WhatsApp desconectou sozinho. Abra e leia o QR de novo.'],
  bloqueado: ['ruim', 'Banido', 'O WhatsApp bloqueou este número.'],
  conflito: ['alerta', 'Aberto em outro lugar', 'Este WhatsApp abriu em outro computador ou navegador.'],
  proxy: ['alerta', 'Proxy barrada', 'A proxy deste número foi bloqueada. Troque a proxy.'],
  versao: ['alerta', 'Precisa atualizar', 'Atualize o WhatsApp deste número.'],
  offline: ['alerta', 'Sem internet', 'Este computador está sem internet.'],
  naosei: ['neutro', 'Sem informação', 'Ainda não foi aberto neste app. Abra pra conferir.'],
}
function seloConn(n) {
  const aberto = (estado.abertos || []).includes(numKey(n.numero))
  const c = n.conn || null
  // ABERTO AQUI? a verdade e a do app, que esta dentro da pagina. Fechado? o que o servidor
  // guardou da ultima vez, e dito no passado, nunca como se fosse agora.
  let chave = (c && c.st) || 'naosei'
  if (!aberto && (chave === 'pronto' || chave === 'sincronizando')) chave = 'fechado'
  const [tom, txt, det] = CONN_TXT[chave] || CONN_TXT.naosei
  return { tom, txt, det, ruim: tom === 'ruim' }
}

// A assinatura do que a telaAbrir esta mostrando, pro recarregaEstado so redesenhar quando mudar.
let travaDesenhada = ''
// FECHAR NO COMPUTADOR DE OUTRA PESSOA (24/10/2026, so a direcao). Numero -> quando pediu. Enquanto
// o app de la nao solta (ate 45 s), a tela mostra a contagem e abre aqui sozinha no fim.
const forcados = new Map()
const forcadoDe = new Map()
const ESPERA_FORCAR_MS = 55000
let forcarArmado = ''
let forcarRelogio = 0
function telaForcando(nk, n) {
  const falta = Math.max(0, Math.ceil((ESPERA_FORCAR_MS - (Date.now() - forcados.get(nk))) / 1000))
  const quem = forcadoDe.get(nk)
  palco.innerHTML = '<div class="abrir">'
    + '<span class="zapg trancado"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>'
    + '<h2>' + esc(bonito(cheio(nk))) + '</h2>'
    + (n && n.dono ? '<p class="de">' + esc(n.dono) + '</p>' : '')
    + '<div class="estado alerta" role="status"><span class="pt"></span>Fechando no computador ' + esc(quem ? 'de ' + quem : 'da outra pessoa') + '</div>'
    + '<p class="espera" id="ab-espera">O WhatsApp abre aqui em <b>' + falta + ' s</b>, quando o app de lá soltar o número.</p>'
    + '</div>'
}
async function forcarFechar(nk, nome) {
  const rotulo = nome ? 'no computador de ' + nome : 'no outro computador'
  if (forcarArmado !== nk) {
    forcarArmado = nk
    const b = $('ab-forcar')
    if (b) { b.classList.add('armado'); b.textContent = 'Clique de novo pra fechar ' + rotulo }
    setTimeout(() => {
      if (forcarArmado !== nk) return
      forcarArmado = ''
      const x = $('ab-forcar')
      if (x) { x.classList.remove('armado'); x.textContent = 'Fechar ' + rotulo }
    }, 4000)
    return
  }
  forcarArmado = ''
  const b = $('ab-forcar')
  if (b) { b.disabled = true; b.textContent = 'Fechando...' }
  let r = null
  try { r = await window.sw.usoForcar(nk) } catch (_) { r = null }
  if (!r || !r.ok) {
    if (b) { b.disabled = false; b.classList.remove('armado'); b.textContent = (r && r.erro) || 'Não consegui fechar agora. Tente de novo.' }
    return
  }
  forcados.set(nk, Date.now())
  forcadoDe.set(nk, r.estava || nome || '')
  clearInterval(forcarRelogio)
  forcarRelogio = setInterval(() => {
    if (!forcados.has(nk)) { clearInterval(forcarRelogio); return }
    if (Date.now() - forcados.get(nk) >= ESPERA_FORCAR_MS) {
      clearInterval(forcarRelogio)
      forcados.delete(nk)
      // so abre se ele continua nesta tela: se clicou em outro numero no meio, nao rouba a tela dele
      if (ativo === nk) abrirDeVerdade(nk)
      return
    }
    if (ativo === nk) telaForcando(nk, (estado.numeros || []).find((x) => numKey(x.numero) === nk))
  }, 1000)
  if (ativo === nk) telaForcando(nk, (estado.numeros || []).find((x) => numKey(x.numero) === nk))
}

function telaAbrir(nk) {
  const n = (estado.numeros || []).find((x) => numKey(x.numero) === nk)
  if (!n) return telaVazia()
  // FECHANDO LA: a releitura de 20 s redesenha esta tela (o aluguel ja sumiu e ela mostraria "Abrir
  // WhatsApp"); o vendedor abriria antes do app de la soltar. Enquanto conta, a tela e a da contagem.
  if (forcados.has(nk) && Date.now() - forcados.get(nk) < ESPERA_FORCAR_MS) {
    window.sw.esconder()
    ativo = nk
    telaForcando(nk, n)
    desenhaLista()
    return
  }
  travaDesenhada = [n.uso ? (n.uso.meu ? 'meu' : 'de:' + (n.uso.nome || '?')) : 'livre',
    (n.conn && n.conn.st) || '-', (estado.destacados || []).includes(nk) ? 'dst' : ''].join('|')
  window.sw.esconder()
  ativo = nk
  const ocupado = n.uso && !n.uso.meu ? n.uso : null
  const destacado = (estado.destacados || []).includes(nk)
  const jaAberto = (estado.abertos || []).includes(nk)
  palco.innerHTML = ''
    + '<div class="abrir">'
    + '<span class="zapg' + (ocupado ? ' trancado' : '') + '">'
    + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6.2-.4v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 .6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1l-.3-.2Z"/></svg>'
    + '</span>'
    + '<h2>' + esc(bonito(cheio(nk))) + '</h2>'
    + (n.dono ? '<p class="de">' + esc(n.dono) + '</p>' : '')
    + (() => { const c = seloConn(n); return '<div class="estado ' + c.tom + '" role="status"><span class="pt"></span>' + esc(c.txt) + '</div><p class="estado-det">' + esc(c.det) + '</p>' })()
    + (ocupado
      // QUANDO E VOCE MESMO EM OUTRO PC, A TELA TEM QUE DIZER ISSO (18/10/2026). A trava e por
      // MAQUINA, de proposito (o Bruno pareia os numeros no PC dele e o vendedor usa no dele, e e
      // esse cruzamento que derruba numero). So que a tela mostrava o NOME de quem travou, e quando
      // era a propria pessoa em outro computador ela lia "Aberto por <ela mesma>" e ia procurar um
      // colega que nao existe. Aconteceu em 18/10 com o Heynan.
      ? '<div class="aviso erro" style="display:block;max-width:360px;margin:14px auto 0">'
        + (ocupado.mesmaPessoa
          ? '<b>Você abriu este número em outro computador</b><br>'
            + 'Feche ele lá e este botão libera sozinho, em até 2 minutos.'
          : '<b>Aberto por ' + esc(ocupado.nome || 'outra pessoa') + '</b><br>'
            + 'Quando a outra pessoa fechar, este botão libera sozinho, em até 2 minutos.')
        + '</div>'
        + '<button class="principal" disabled style="margin-top:14px">Em uso</button>'
        // SO A DIRECAO (fora do "ver como"): fecha la e abre aqui (24/10/2026).
        + (estado.direcao && !estado.como
          ? '<button class="forcar" id="ab-forcar" title="Fecha este número no computador de quem está com ele. O WhatsApp abre aqui em seguida.">'
            + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
            + 'Fechar ' + (ocupado.mesmaPessoa ? 'no outro computador' : 'no computador de ' + esc(ocupado.nome || 'outra pessoa')) + '</button>'
          : '')
      : '<div class="abrir-acoes">'
        + '<button class="principal" id="ab-abrir">' + (jaAberto ? 'Ver aqui' : 'Abrir WhatsApp') + '</button>'
        // A SETINHA PRA FORA. Mesma altura e mesmo verde do botao do lado, so quadrado.
        + '<button class="quadrado" id="ab-destacar" title="' + (destacado
          ? 'Já está numa janela própria. Clique pra trazer ela pra frente.'
          : 'Abrir este WhatsApp numa janela própria, pra trabalhar dois ao mesmo tempo') + '">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M14 4h6v6"/><path d="M20 4 11 13"/>'
        + '<path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>'
        + '</button></div>'
        + (destacado ? '<p class="dica">Este número está numa janela própria.</p>' : ''))
    + '</div>'
  const b = $('ab-abrir')
  if (b) b.onclick = () => (jaAberto ? abrir(n.numero) : abrirDeVerdade(nk))
  const fx = $('ab-forcar')
  if (fx) fx.onclick = () => forcarFechar(nk, ocupado && !ocupado.mesmaPessoa ? (ocupado.nome || '') : '')
  const dst = $('ab-destacar')
  if (dst) {
    dst.onclick = async () => {
      // ABRE ANTES, SE PRECISAR. Destacar um numero que ainda nao esta aberto nao faria nada: a
      // view que muda de janela e a que ja existe.
      if (!estado.abertos.includes(nk)) {
        dst.disabled = true
        await abrirDeVerdade(nk)
        dst.disabled = false
        if (!estado.abertos.includes(nk)) return    // nao abriu: a propria tela ja disse por que
      }
      await window.sw.destacar(n.numero, nk)
      await recarregaEstado()
      telaVazia()
    }
  }
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
  // `finally` e nao linha solta: se a promessa do IPC rejeitar, o delete nao rodava e o numero
  // ficava preso em `carregando` pro resto da sessao (o `abrir` desiste em cima dele). O main ja
  // foi ensinado a nunca rejeitar; isto aqui e o cinto do cinto.
  let r
  try { r = await window.sw.abrir(numero) } catch (e) { r = { ok: false, erro: (e && e.message) || 'Falhou.' } }
  finally { carregando.delete(nk) }
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
// A CHAVE VIRA NA HORA E FICA (19/10/2026, pedido do Bruno: "eu clico, ele liga, fica pensando,
// pensando, e depois desliga sozinho ou mantem ligado; nesse meio-termo eu achei que nao ligou").
//
// Os dois defeitos que davam isso: a chave desenhava o "recebendo agora" (que inclui a conexao, e
// com o app fechado e falso mesmo ligado), e a releitura de 20 s que tinha saido ANTES do clique
// chegava depois dele com o estado velho e desvirava a chave. Agora a chave desenha o interruptor
// (`ligado`), o clique fica valendo por cima de qualquer leitura velha ate o servidor concordar, e so
// volta atras se a dash RECUSAR - e ai diz por que.
function ligadoDe(n) {
  const nk = numKey(n && n.numero)
  const doServidor = (n && n.ligado != null) ? !!n.ligado : !!(n && n.roleta)
  const c = confirmados.get(nk)
  if (c) {
    if (Date.now() > c.ate || (!mexendo.has(nk) && doServidor === c.on)) confirmados.delete(nk)
    else return c.on
  }
  return doServidor
}
async function viraRoleta(nk) {
  if (mexendo.has(nk)) return
  const n = (estado.numeros || []).find((x) => numKey(x.numero) === nk)
  if (!n) return
  const quer = !ligadoDe(n)
  erroChave.delete(nk)
  mexendo.add(nk)
  confirmados.set(nk, { on: quer, ate: Date.now() + 60000 })
  desenhaLista()
  let r = null
  try { r = await window.sw.roleta(nk, quer) } catch (e) { r = { ok: false, erro: String((e && e.message) || e) } }
  mexendo.delete(nk)
  if (!r || !r.ok) {
    confirmados.delete(nk)
    erroChave.set(nk, (r && r.erro) || 'a dash não respondeu')
    desenhaLista()
    setTimeout(() => { erroChave.delete(nk); desenhaLista() }, 4000)
    return
  }
  // 30 s de folga pra a leitura do servidor alcancar o clique: ate la, o clique vence.
  confirmados.set(nk, { on: quer, ate: Date.now() + 30000 })
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

// ─────────────────────────────────────────────────────── a janelinha de Ajustes
//
// O PEDIDO (Bruno, 17/10/2026): "melhora o visual dessa parte de configuracoes, eu acho bem feio.
// Colocar alguns icones, colocar umas coisas para que a gente bata o olho e ja entenda, para voce
// ver que os icones funcionam muito bem."
//
// Eram cinco linhas iguais separadas por um fio de 1px: trava da operacao, preview de vendedor e
// teto de memoria desta maquina, tudo com o mesmo peso e nenhum icone. Pra saber o que estava
// ligado era preciso LER cada uma.
//
// TRES COISAS MUDARAM, e cada uma ataca um problema diferente:
//  1. AGRUPAR POR ONDE A COISA MORA, que e o unico corte verdadeiro desta tela: o que vale pra
//     equipe inteira (e mora no servidor), o que e so deste computador, e o que e da conta dele.
//  2. ICONE EM QUADRADO ARREDONDADO, a linguagem do painel do Sale Chat que ele ja aprovou e
//     mandou reaplicar na operacao inteira.
//  3. O ESTADO VIRA COR. Ligado fica verde, desligado fica cinza - e nas duas TRAVAS, desligado
//     fica AMBAR, porque trava desligada nao e preferencia desligada, e risco em aberto. E isso
//     que se ve de longe sem ler nada, que foi o pedido dele em palavras.

// Os desenhos. Lucide, escritos na mao, traco 2.2, sem preenchimento. Os que tem DUAS caras mudam
// com o estado: o escudo ganha um corte quando a trava esta desligada, e e o corte que o olho pega
// antes de ler qualquer palavra.
const AJ_IC = {
  escudoOn: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  escudoOff: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m3 3 18 18"/>',
  globoOn: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  globoOff: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="m3 3 18 18"/>',
  painel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M18 9h-1"/><path d="M18 13h-1"/>',
  janelas: '<rect x="3" y="7" width="12" height="12" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>',
  registro: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  olho: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  porta: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  engrenagem: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.67.75.86.3.17.65.26 1 .26H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  seta: '<path d="m9 18 6-6-6-6"/>',
}
const ajSvg = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'

// Um cartao. `tom` e o que pinta o quadradinho: 'on' verde, 'alerta' ambar, 'azul', 'perigo', ou
// vazio pro cinza neutro.
const ajItem = (tom, ic, titulo, ajuda, direita, attrs) =>
  '<div class="aj-item ' + (tom || '') + '"' + (attrs || '') + '>'
  + '<span class="ic">' + ajSvg(ic) + '</span>'
  + '<div class="txt"><b>' + esc(titulo) + '</b>' + (ajuda ? '<span>' + esc(ajuda) + '</span>' : '') + '</div>'
  + (direita || '') + '</div>'

// SAIR ARMADO: depois do primeiro clique o botao muda de cara e espera o segundo. "Com duplo
// clique, tem que clicar duas vezes para poder realmente confirmar que eu quero sair" (Bruno).
// E ele DESARMA sozinho em 4 segundos: botao que fica armado pra sempre e o mesmo perigo de antes,
// so que escondido num lugar onde ninguem olha.
let sairArmado = false
let sairRelogio = null
function desarmaSair() {
  if (sairRelogio) { clearTimeout(sairRelogio); sairRelogio = null }
  if (!sairArmado) return
  sairArmado = false
  if (modal.classList.contains('on')) janelaAjustes()
}

function janelaAjustes() {
  const t = Number(estado.maxAbertos) || 6
  const quem = String(estado.nome || '').trim()
  const cargo = estado.direcao ? 'direção' : 'vendedor'

  // ── o topo: a marca, de quem e esta sessao, e a versao ──────────────────────────────────
  let html = '<div class="aj-topo">'
    + '<span class="marca">' + ajSvg(AJ_IC.engrenagem) + '</span>'
    + '<div><h2>Ajustes</h2>'
    + '<div class="quem">' + esc(quem ? quem + ' · ' + cargo : cargo) + '</div></div>'
    + '<span class="ver">v' + esc(estado.versao || '') + '</span>'
    + '</div><div class="aj-lista">'

  // ── DA OPERAÇÃO: mora no servidor e vale pra equipe inteira ─────────────────────────────
  //
  // OS DOIS INTERRUPTORES SAIRAM (17/10/2026, pedido do Bruno junto com o banco de proxies). Eles
  // ligavam e desligavam "Exigir proxy" e "Exigir IP do Brasil" pra operacao inteira, e o problema
  // de interruptor nao e desligar, e RELIGAR: quem desliga as 23h pra resolver UM numero sem proxy
  // nao religa, e dai todo numero sem proxy passa a sair pelo IP da casa sem a tela dizer nada.
  // As duas regras agora valem SEMPRE, e o que substituiu o interruptor e a liberacao por numero,
  // que vence sozinha - ela aparece no botao da tela de "Não abriu", que e onde o problema aparece.
  // A LINHA FICA, SEM CHAVE: regra que ninguem enuncia vira surpresa no dia em que ela barra
  // alguem, e foi por nao estar escrito em lugar nenhum que isto virou interruptor.
  if (estado.direcao) {
    const sem = (estado.numeros || []).filter((n) => !n.proxy).length
    const soltos = (estado.numeros || []).filter((n) => n.excecao && Number(n.excecao.ate) > Math.floor(Date.now() / 1000)).length
    html += '<div class="aj-sec">Da operação · vale pra todos</div>'
      + ajItem('on', AJ_IC.escudoOn,
        'Proxy obrigatória, e do Brasil',
        'Sem proxy respondendo, o número não abre. Proxy de fora num +55 é pior que proxy nenhum.',
        '<span class="aj-fixo">sempre</span>')
      // A SEGUNDA LINHA MOSTRA, NAO CONCEDE. O controle de liberar mora na Contingencia > Proxies,
      // do lado do seletor que resolve melhor - pedido do Bruno: "coloca uma configuracaozinha ali,
      // em algum lugarzinho mais escondido". Aqui ela seria a primeira coisa que alguem lembra.
      + ajItem((soltos || sem) ? 'alerta' : '', soltos ? AJ_IC.escudoOff : AJ_IC.globoOn,
        soltos ? 'Número liberado sem proxy' : 'Onde se escolhe a proxy',
        soltos
          ? soltos + (soltos === 1 ? ' número está saindo' : ' números estão saindo') + ' pelo IP desta máquina, por tempo contado. Quem tira é a direção, na dash.'
          : (sem
            ? sem + (sem === 1 ? ' número está' : ' números estão') + ' sem proxy e não abre. Na dash: Contingência > Proxies.'
            : 'Todos os números têm proxy. Na dash: Contingência > Proxies.'),
        '<span class="aj-fixo">' + (soltos ? soltos + ' livre' : (sem ? sem + ' sem' : 'na dash')) + '</span>')
  }

  // ── SÓ NESTE COMPUTADOR ─────────────────────────────────────────────────────────────────
  const ligado = estado.painelLigado !== false
  html += '<div class="aj-sec">Só neste computador</div>'
    + ajItem(ligado ? 'on' : '', AJ_IC.painel,
      'Painel de venda ao lado', 'As respostas rápidas e os funis, do lado direito do WhatsApp.',
      '<button class="sw ' + (ligado ? 'on' : '') + '" id="sw3" role="switch" aria-checked="' + ligado + '"></button>')
    + ajItem('', AJ_IC.janelas,
      'Números abertos ao mesmo tempo', 'Passando do teto, o mais parado fecha sozinho e volta sem pedir QR.',
      '<div class="aj-num"><button id="teto-menos" title="Menos um">−</button>'
      + '<input id="teto" value="' + t + '" inputmode="numeric" />'
      + '<button id="teto-mais" title="Mais um">+</button></div>')
    + ajItem('', AJ_IC.registro, 'Abrir registro desta máquina', 'O que o app anotou, pra mandar quando algo der errado.',
      '<span class="aj-seta">' + ajSvg(AJ_IC.seta) + '</span>',
      ' id="t-log" role="button" style="cursor:pointer"')

  // ── SUA CONTA ───────────────────────────────────────────────────────────────────────────
  html += '<div class="aj-sec">Sua conta</div>'

  // VER COMO UM DOS VENDEDORES (16/10/2026, pedido do Bruno: "quero ver como seria a visualizacao
  // dele, pra acompanhar o dia a dia e ver se ele esta convertendo certinho").
  //
  // Quem responde como a pessoa e a DASH, nao o app: o pedido sai com ?como=<id> e volta com o que
  // o login dela traria. E a mesma peca do "ver como" da dash e ela so ESTREITA. Por isso o preview
  // aparece so pra quem ja e direcao de verdade - dentro dele `estado.direcao` vem false do
  // servidor e esta tela some sozinha, que e o certo.
  const vends = (estado.vendedores || []).filter((v) => v && v.id && v.id !== 'dir')
  if (estado.direcao && vends.length) {
    html += ajItem(estado.como ? 'azul' : '', AJ_IC.olho,
      'Ver como vendedor', 'A tela fica igual à dele: só os números dele, sem nada de proxy. Leitura apenas.',
      '<div class="escolha" id="como">'
      + '<button type="button" id="como-bt"><span class="v">'
      + esc((vends.find((v) => v.id === estado.como) || {}).nome || 'Eu mesmo') + '</span>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>'
      + '</button><div class="ops">'
      + '<button type="button" data-como="" class="' + (estado.como ? '' : 'on') + '">Eu mesmo</button>'
      + vends.map((v) => '<button type="button" data-como="' + esc(v.id) + '" class="' + (estado.como === v.id ? 'on' : '') + '">' + esc(v.nome) + '</button>').join('')
      + '</div></div>')
  }
  if (estado.como) {
    html += ajItem('azul', AJ_IC.olho, 'Você está vendo como outra pessoa',
      'Ligar ou desligar número continua acontecendo como você, não como ela.',
      '<button class="secundario" id="como-sair" style="margin:0;padding:6px 10px;border-radius:8px;font-size:11.5px">Voltar a ser eu</button>')
  }

  // O SAIR, ultima linha e longe do reflexo: pra chegar nele agora sao tres gestos (abrir Ajustes,
  // descer e clicar duas vezes) em vez de um clique num botao do tamanho do Ajustes, no rodape.
  html += '<button class="aj-item perigo' + (sairArmado ? ' armado' : '') + '" id="t-sair">'
    + '<span class="ic">' + ajSvg(AJ_IC.porta) + '</span>'
    + '<div class="txt"><b>' + (sairArmado ? 'Clique de novo para sair' : 'Sair da conta') + '</b>'
    + '<span>' + (sairArmado
      ? 'Os números abertos vão ser fechados.'
      : 'Fecha os números abertos e volta pra tela de entrar.') + '</span>'
    + (sairArmado ? '<div class="aj-conta"><i></i></div>' : '')
    + '</div></button>'

  html += '</div>'   // fim da lista que rola
    + '<div class="acoes"><button class="secundario" id="t-fechar">Fechar</button></div>'

  modalCorpo.className = 'cartao aj'
  modalCorpo.innerHTML = html
  abreModal()

  $('sw3').onclick = async () => {
    const r = await window.sw.painel(!(estado.painelLigado !== false))
    estado.painelLigado = r.ligado
    janelaAjustes()
  }
  const poeTeto = async (v) => {
    const r = await window.sw.teto(v)
    estado.maxAbertos = r.maxAbertos
    const el = $('teto')
    if (el) el.value = r.maxAbertos
    await recarregaEstado()
  }
  $('teto').onchange = (e) => poeTeto(e.target.value)
  // MAIS E MENOS, porque o campo de digitar sozinho obriga selecionar e apagar pra trocar de 6 pra
  // 5. O teto anda de um em um; quem quiser pular digita.
  $('teto-menos').onclick = () => poeTeto(Math.max(1, (Number($('teto').value) || 6) - 1))
  $('teto-mais').onclick = () => poeTeto(Math.min(20, (Number($('teto').value) || 6) + 1))
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
  const voltarEu = $('como-sair')
  if (voltarEu) voltarEu.onclick = async () => { await window.sw.verComo(''); await recarregaEstado(); janelaAjustes() }
  $('t-log').onclick = () => window.sw.abrirLog()

  // O SAIR, EM DOIS CLIQUES. O primeiro arma e o segundo executa; sair da janelinha desarma.
  $('t-sair').onclick = async () => {
    if (!sairArmado) {
      sairArmado = true
      janelaAjustes()
      sairRelogio = setTimeout(desarmaSair, 4000)
      return
    }
    desarmaSair()
    // A ORDEM AQUI NAO E ESTILO, E O QUE IMPEDE O WHATSAPP DE FICAR POR CIMA DA TELA DE ENTRAR.
    // `ativo` zera ANTES porque o `fechaModal` reexibe a view do numero ativo; e a janelinha se
    // fecha na mao, sem passar por ele, pelo mesmo motivo.
    ativo = ''
    await window.sw.sair()
    modal.classList.remove('on')
    await recarregaEstado()
    telaLogin('')
  }
  $('t-fechar').onclick = fechaModal
}

// A janelinha é desenhada pela CASCA, que fica ATRÁS da view do número e da do painel. Com um
// número aberto, ela abria invisível. Então esconder as views enquanto ela estiver na tela.
function fechaModal() {
  // SAIR DA JANELINHA DESARMA O SAIR. Senao ele ficaria armado esperando o segundo clique na
  // proxima vez que ela abrisse - e o segundo clique seria o PRIMEIRO da nova visita, ou seja o
  // vendedor sairia da conta com um clique so, que e exatamente o acidente que isto evita.
  sairArmado = false
  if (sairRelogio) { clearTimeout(sairRelogio); sairRelogio = null }
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
  // A TELA DO MEIO TAMBEM TEM QUE SE ATUALIZAR (18/10/2026).
  //
  // Esta funcao roda a cada 20 s (sincroniza) e redesenhava SO a barra e o cabecalho. Quem estava
  // parado na tela de um numero trancado via "Em uso" pra sempre - inclusive depois de a trava
  // vencer -, e a propria mensagem promete "Quando a outra pessoa fechar, este botao libera
  // sozinho". A promessa era falsa: so clicando em outro numero e voltando.
  // SO REDESENHA QUANDO MUDA, e nunca por cima de outra tela: numero ABERTO aqui mostra o WhatsApp
  // (nao a telaAbrir), abertura EM CURSO mostra "Abrindo...", e telaErro/telaVazia zeram o `ativo`.
  // A assinatura evita trocar o HTML embaixo do dedo de quem esta clicando a cada 20 s.
  if (ativo && !carregando.has(ativo) && !(estado.abertos || []).includes(ativo)) {
    const n = (estado.numeros || []).find((x) => numKey(x.numero) === ativo)
    const assina = n ? [n.uso ? (n.uso.meu ? 'meu' : 'de:' + (n.uso.nome || '?')) : 'livre',
      (n.conn && n.conn.st) || '-', (estado.destacados || []).includes(ativo) ? 'dst' : ''].join('|') : 'sem'
    if (assina !== travaDesenhada) { travaDesenhada = assina; telaAbrir(ativo) }
  }
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
  // `entrada` so vem na PRIMEIRA checagem desta abertura do app (quem decide e o main.js, que
  // sobrevive ao recarregamento desta pagina). Nas checagens de 6 em 6 horas ele nao vem, e ai
  // sobra so a faixinha - de proposito, pra nao abrir modal em cima de quem esta atendendo.
  if (d && d.entrada) janelaVersao(nova, d.atual || estado.versao, d.notas)
}

// POP-UP DE ATUALIZACAO (21/10/2026, pedido do Bruno).
//
// POR QUE A FAIXINHA NAO BASTOU: ela existe desde a 1.1.0, mora no rodape da barra e some da vista
// em um dia. Em 21/10 a Barbara estava na 1.25.7, cinco versoes atras, com a captura parada desde o
// dia anterior - 449 cliques pagos e 139 conversas que nunca entraram na dash. Ninguem viu a faixa.
//
// AS REGRAS, todas do Bruno: aparece na ENTRADA (nunca no meio do atendimento), ocupa a tela, diz o
// que mudou e tem uma saida clara. Clicar fora NAO fecha - tem que escolher um dos dois botoes,
// senao o pop-up grande vira a mesma faixinha que ninguem le.
function janelaVersao(nova, atual, notas) {
  const ICO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
    + '<path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>'
  const corpo = String(notas || '').trim()
  modalCorpo.className = 'cartao'
  modalCorpo.style.maxWidth = '470px'   // mais largo que o padrao; o sai() devolve
  modalCorpo.innerHTML = '<div style="text-align:center;padding:4px 6px 2px">'
    + '<div style="width:64px;height:64px;margin:0 auto 16px;border-radius:20px;background:rgba(36,194,120,.14);'
    + 'display:flex;align-items:center;justify-content:center;color:var(--verde)">' + ICO + '</div>'
    + '<h2 style="font-size:22px;margin:0 0 8px;font-weight:700">Atualização disponível</h2>'
    + '<div style="font-size:14px;opacity:.72;margin-bottom:' + (corpo ? '16px' : '20px') + '">Você está na <b>'
    + esc(atual || '') + '</b> · a atual é a <b>' + esc(nova) + '</b></div>'
    + (corpo
      ? '<div style="text-align:left;background:rgba(255,255,255,.04);border-radius:12px;padding:12px 14px;margin-bottom:18px">'
        + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.55;margin-bottom:5px">O que mudou</div>'
        + '<div style="font-size:13.5px;line-height:1.5">' + esc(corpo) + '</div></div>'
      : '')
    + '<p style="font-size:13.5px;line-height:1.55;opacity:.85;margin:0 0 20px">Instale antes de começar a atender. '
    + 'É por cima da que já está aqui, leva menos de um minuto, e as conversas e os números pareados continuam salvos.</p>'
    + '<button id="ver-baixar" style="width:100%;padding:13px;border:0;border-radius:12px;background:var(--verde);'
    + 'color:#04070c;font-size:15px;font-weight:700;cursor:pointer">Baixar e instalar</button>'
    + '<button id="ver-depois" style="width:100%;margin-top:10px;padding:9px;border:0;border-radius:10px;'
    + 'background:transparent;color:inherit;opacity:.55;font-size:13px;cursor:pointer">Agora não</button>'
    + '</div>'
  modal.classList.add('on')
  modal.onclick = null
  // OS BOTOES PRIMEIRO, O `esconder` DEPOIS, E ELE DENTRO DE UM try. O pop-up tira o fechar-
  // clicando-fora, entao a unica saida sao os dois botoes: se qualquer linha antes deles estourar,
  // o vendedor fica preso numa tela que nao fecha. Foi o que o teste de tela pegou.
  const sai = () => {
    modal.onclick = fechaPorFora
    modalCorpo.style.maxWidth = ''
    fechaModal()
  }
  const dep = $('ver-depois')
  if (dep) dep.onclick = sai
  const bx = $('ver-baixar')
  if (bx) {
    bx.onclick = () => {
      try { window.sw.abrirInstalador() } catch (_) { /* o botao da faixa continua valendo */ }
      // A TELA TEM QUE DIZER O QUE FAZER DEPOIS. O download abre no navegador e o app continua
      // aberto: sem esta troca a pessoa clica, nao ve nada acontecer e fecha achando que falhou.
      bx.textContent = 'Download aberto no navegador'
      bx.disabled = true
      bx.style.opacity = '.6'
      bx.style.cursor = 'default'
      if (dep) { dep.textContent = 'Fechar'; dep.style.opacity = '.85' }
      const p = modalCorpo.querySelector('p')
      if (p) p.innerHTML = 'Quando o download terminar, <b>feche o app</b> e rode o instalador. Ele instala por cima e seus números continuam pareados.'
    }
  }
  try { window.sw.esconder() } catch (_) { /* a tela ja esta coberta pelo fundo do modal */ }
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
// ATUALIZAR A LISTA NA HORA (19/10/2026, pedido do Bruno: "um botaozinho simples de atualizar, pra ver se algum
// numero novo chegou"). A lista ja se rele sozinha; o botao so nao deixa esperar. Busca na dash (sw:numeros) e
// redesenha; clique repetido enquanto busca nao dispara outra busca.
$('atualizar').onclick = async () => {
  const b = $('atualizar')
  if (b.disabled) return
  b.disabled = true; b.classList.add('girando')
  try { await window.sw.numeros() } catch (_) { /* a releitura mostra o que tiver */ }
  try { await recarregaEstado() } catch (_) { /* idem */ }
  b.disabled = false; b.classList.remove('girando')
}
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
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenhaLista() }
// Com nome porque o pop-up de atualizacao TIRA o fechar-clicando-fora enquanto esta aberto e
// precisa repor depois (ver janelaVersao).
const fechaPorFora = (e) => { if (e.target === modal) fechaModal() }
modal.onclick = fechaPorFora
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
// A CONEXAO MUDOU: redesenha na hora, sem esperar o proximo minuto. Se o numero da tela for o que
// mudou, a tela de abrir e refeita; senao basta a lista. O `recarregaEstado` traz o campo `conn`
// atualizado do servidor, que e a mesma fonte que a tela le quando o numero esta fechado.
window.sw.ao('sw:conexao', async (d) => {
  await recarregaEstado()
  if (d && d.nk && ativo === d.nk && !(estado.abertos || []).includes(d.nk)) telaAbrir(d.nk)
})
let avisoBarraAte = 0   // um aviso do app (sw:aviso) na mesma linha nao some com a fila zerando
window.sw.ao('sw:fila', (d) => {
  const el = $('fila')
  if (!el) return
  const n = (d && Number(d.n)) || 0
  if (!n && Date.now() < avisoBarraAte) return
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
// O NUMERO FOI PRA UMA JANELA PROPRIA, OU VOLTOU. A barra precisa saber: a linha dele passa a
// dizer que ele esta noutra janela, e clicar nela foca aquela janela em vez de tentar trazer a view
// de volta (trazer arrancaria ela de la e a outra janela ficaria em branco).
window.sw.ao('sw:destacado', async (d) => {
  await recarregaEstado()
  if (d && d.nk === ativo) { ativo = ''; telaVazia() }
})
window.sw.ao('sw:devolvido', async () => { await recarregaEstado() })
window.sw.ao('sw:versao', (d) => avisaVersao(d))
// A NUVEM DA SESSAO MUDOU (subindo, descendo, salva, falhou): so a lista muda, e o estado vem do main.
window.sw.ao('sw:nuvem', async () => { await recarregaEstado() })
// FECHANDO O APP: os numeros ja sairam da tela e a sessao de cada um esta subindo. Sem este aviso o
// X parece nao funcionar, e a pessoa fecha pelo gerenciador de tarefas - que e o que perde a sessao.
window.sw.ao('sw:saindo', (d) => {
  const n = Number(d && d.n) || 0
  modalCorpo.innerHTML = '<div class="aj-topo"><span class="marca">' + NUVEM.replace(/width="11" height="11"/, 'width="18" height="18"') + '</span>'
    + '<div><h2>Salvando na nuvem</h2><div class="quem">' + (n === 1 ? '1 número' : n + ' números') + '</div></div></div>'
    + '<p class="saindo-txt">Guardando a sessão de cada número pra ele abrir já conectado em qualquer computador. O app fecha sozinho quando terminar.</p>'
  modal.classList.add('on')
  modal.onclick = null
  document.onkeydown = null
})
// MOTOR DE CONVERSA NOVO: POP-UP, NAO LINHA NA BARRA (27/10/2026, pedido do Bruno).
//
// O conserto do motor e servido pelo servidor e o app baixa sozinho, mas ele SO VALE quando a
// pagina do numero recarrega. Ate aqui o aviso era uma linha na barra por 20 segundos, e ninguem
// le: em 27/10 o motor leve foi publicado as 11:19 e as 11:26 o vendedor ainda estava com o funil
// lento, porque o app dele seguia rodando o motor velho que ja estava na memoria.
//
// A faixa continua, pra quem fechar o pop-up.
window.sw.ao('sw:agente', () => {
  const el = $('fila')
  if (el && !el.textContent) {
    el.textContent = 'Motor de conversa atualizado. Recarregue o número pra usar o novo.'
    setTimeout(() => { if (el.textContent.startsWith('Motor de conversa')) el.textContent = '' }, 20000)
  }
  janelaMotor()
})

// O POP-UP DO MOTOR. Mesmas regras do pop-up de versao (ocupa a tela, so sai pelos botoes), com uma
// diferenca que importa: aqui nao ha o que baixar nem instalar, entao o botao RESOLVE na hora.
// Quem escolher "Agora nao" ve de novo em 15 minutos: o app continua rodando o motor velho ate
// recarregar, e esse e exatamente o estado que esta custando lead.
let motorAdiado = 0
function janelaMotor() {
  if (Date.now() < motorAdiado) return
  const ICO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>'
    + '<path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'
  modalCorpo.className = 'cartao'
  modalCorpo.style.maxWidth = '470px'
  modalCorpo.innerHTML = '<div style="text-align:center;padding:4px 6px 2px">'
    + '<div style="width:64px;height:64px;margin:0 auto 16px;border-radius:20px;background:rgba(36,194,120,.14);'
    + 'display:flex;align-items:center;justify-content:center;color:var(--verde)">' + ICO + '</div>'
    + '<h2 style="font-size:22px;margin:0 0 8px;font-weight:700">Correção pronta pra entrar</h2>'
    + '<div style="font-size:14px;opacity:.72;margin-bottom:16px">Ela só passa a valer quando os números recarregam</div>'
    + '<p id="motor-txt" style="font-size:13.5px;line-height:1.55;opacity:.85;margin:0 0 20px">Cada número some da tela por '
    + 'alguns segundos e volta conectado, sem pedir QR. Se algum estiver disparando um funil agora, ele fica pra depois.</p>'
    + '<button id="motor-ok" style="width:100%;padding:13px;border:0;border-radius:12px;background:var(--verde);'
    + 'color:#04070c;font-size:15px;font-weight:700;cursor:pointer">Recarregar os números agora</button>'
    + '<button id="motor-depois" style="width:100%;margin-top:10px;padding:9px;border:0;border-radius:10px;'
    + 'background:transparent;color:inherit;opacity:.55;font-size:13px;cursor:pointer">Agora não</button>'
    + '</div>'
  modal.classList.add('on')
  modal.onclick = null
  // Os botoes antes do `esconder`, pelo mesmo motivo do pop-up de versao: o pop-up tira o fechar-
  // clicando-fora, entao se qualquer linha antes deles estourar o vendedor fica preso.
  const sai = () => {
    modal.onclick = fechaPorFora
    modalCorpo.style.maxWidth = ''
    fechaModal()
  }
  const dep = $('motor-depois')
  if (dep) {
    dep.onclick = () => { motorAdiado = Date.now() + 15 * 60000; sai() }
  }
  const ok = $('motor-ok')
  if (ok) {
    ok.onclick = async () => {
      ok.disabled = true
      ok.style.opacity = '.6'
      ok.style.cursor = 'default'
      ok.textContent = 'Recarregando...'
      let r = null
      try { r = await window.sw.recarregarTodos() } catch (_) { r = null }
      const txt = $('motor-txt')
      if (txt) {
        txt.innerHTML = r && r.feitos
          ? '<b>' + r.feitos + (r.feitos === 1 ? ' número recarregado.' : ' números recarregados.') + '</b> '
            + 'Eles voltam sozinhos em alguns segundos.'
            + (r.noFunil ? ' ' + r.noFunil + (r.noFunil === 1 ? ' estava' : ' estavam')
              + ' disparando um funil e ' + (r.noFunil === 1 ? 'fica' : 'ficam') + ' pra depois.' : '')
          : 'Não consegui recarregar daqui. Use o botão de recarregar no painel de cada número.'
      }
      ok.textContent = 'Pronto'
      if (dep) { dep.textContent = 'Fechar'; dep.style.opacity = '.85'; dep.onclick = sai }
    }
  }
  try { window.sw.esconder() } catch (_) { /* a tela ja esta coberta pelo fundo do modal */ }
}
// AVISO DE UM NUMERO QUE O APP CONSERTOU SOZINHO (ver confereCaptura no main): 30 s na barra.
window.sw.ao('sw:aviso', (d) => {
  const el = $('fila')
  if (!el || !d || !d.texto) return
  el.textContent = String(d.texto)
  avisoBarraAte = Date.now() + 30000
  setTimeout(() => { if (el.textContent === String(d.texto)) el.textContent = '' }, 30000)
})
// AS FOTOS CHEGARAM (o main acabou de baixar): redesenha pra elas aparecerem.
window.sw.ao('sw:fotos', async () => { await recarregaEstado() })
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
