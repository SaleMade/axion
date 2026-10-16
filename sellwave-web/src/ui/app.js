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

const ZAP = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6.2-.4v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 .6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1l-.3-.2Z"/></svg>'

// ───────────────────────────────────────────────────────────── barra lateral

function desenhaTrava() {
  const el = $('trava')
  // Proxy é assunto da direção. Para o vendedor a trava nem existe na tela.
  el.hidden = !estado.direcao
  if (!estado.direcao) return
  const t = estado.travaProxy
  el.className = 'trava ' + (t ? 'ligada' : 'solta')
  $('trava-txt').innerHTML = t
    ? '<b>Trava de proxy ligada</b>' + (estado.exigirBrasil ? ' · só Brasil' : '')
    : '<b>Trava de proxy desligada</b>'
}

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
  let html = ''
  for (const [dono, itens] of grupos) {
    itens.sort((a, b) => (b.roleta ? 1 : 0) - (a.roleta ? 1 : 0))
    const ligados = itens.filter((x) => x.roleta).length
    html += '<div class="vend"><span>' + esc(dono) + '</span><span class="risco"></span>'
      + '<span class="qtd">' + ligados + '/' + itens.length + '</span></div>'
    html += itens.map(linha).join('')
  }
  lista.innerHTML = html

  for (const el of lista.querySelectorAll('.num')) {
    el.onclick = (e) => {
      if (e.target.closest('.sw')) return
      abrir(el.dataset.numero)
    }
    if (estado.direcao) el.oncontextmenu = (ev) => { ev.preventDefault(); janelaProxy(el.dataset.numero) }
  }
  for (const b of lista.querySelectorAll('.sw')) {
    b.onclick = (e) => { e.stopPropagation(); viraRoleta(b.dataset.nk) }
  }
}

function linha(n) {
  const nk = numKey(n.numero)
  const aberto = estado.abertos.includes(nk)
  const cls = ['num']
  if (nk === ativo) cls.push('ativo')
  if (carregando.has(nk)) cls.push('carregando')

  // A bolinha usa a cor do status do chip, a mesma que o diretor escolheu na Contingência. Vem
  // pronta do servidor, então trocar a cor lá muda aqui sem mexer em código.
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const estiloSinal = corChip ? ' style="background:' + corChip + '"' : ''

  // O ícone do WhatsApp diz o que importa pro vendedor: esta sessão está aberta aqui?
  const zap = '<span class="zap' + (aberto ? '' : ' off') + '" title="' + (aberto ? 'Aberto nesta máquina' : 'Fechado') + '">' + ZAP + '</span>'
  const leads = Number(n.leads_hoje) || 0
  const teto = Number(n.lim_dia) || 0
  const conta = leads || teto ? (leads + (teto ? '/' + teto : '') + ' hoje') : (n.status || '')

  // Proxy só aparece pra direção.
  const px = estado.direcao
    ? ((estado.proxies && estado.proxies[nk]) || n.proxy
      ? '<span class="px" title="proxy cadastrado"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'
      : '<span class="px sem" title="Sem proxy. Clique com o botão direito."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></span>')
    : ''

  const chave = '<span class="sw' + (n.roleta ? ' on' : '') + (mexendo.has(nk) ? ' ocupado' : '')
    + '" data-nk="' + nk + '" role="switch" aria-checked="' + !!n.roleta + '"'
    + ' title="' + (n.roleta ? 'Recebendo lead. Clique pra parar.' : 'Fora da roleta. Clique pra voltar a receber.') + '"></span>'

  return '<button class="' + cls.join(' ') + '" data-numero="' + esc(n.numero) + '" title="' + esc(n.status || '') + '">'
    + '<span class="sinal"' + estiloSinal + '></span>'
    + '<span class="corpo"><span class="fone">' + esc(bonito(n.numero)) + '</span>'
    + '<span class="sub">' + zap + esc(conta) + '</span></span>'
    + px + chave + '</button>'
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
    + '<p>Cada número abre numa sessão própria. A chave do lado liga e desliga a chegada de lead.</p></div>'
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

async function abrir(numero) {
  const nk = numKey(numero)
  if (!nk || carregando.has(nk)) return
  falhou.delete(nk)
  if (estado.abertos.includes(nk)) {
    ativo = nk
    await window.sw.mostrar(nk)
    palco.innerHTML = ''
    desenhaLista()
    return
  }
  carregando.add(nk)
  ativo = nk
  desenhaLista()
  palco.innerHTML = '<div class="vazio"><h2>Abrindo ' + esc(bonito(cheio(nk))) + '</h2><p id="passo">Preparando a sessão...</p></div>'
  const r = await window.sw.abrir(numero)
  carregando.delete(nk)
  if (!r.ok) return telaErro(nk, r.erro || 'Falhou.')
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

function janelaProxy(numero) {
  if (!estado.direcao) return
  const nk = numKey(numero)
  const px = (estado.proxies && estado.proxies[nk]) || null
  modalCorpo.innerHTML = ''
    + '<h2>Proxy de ' + esc(bonito(cheio(nk))) + '</h2>'
    + (px
      ? '<p>Saindo por <b>' + esc(px.host + ':' + px.porta) + '</b>.</p>'
      : '<p>Este número ainda não tem proxy. Cadastre em Ferramentas &gt; SellWave Web, na dash.</p>')
    + '<div class="aviso" id="p-av"></div>'
    + '<div class="acoes">'
    + (px ? '<button class="secundario" id="p-testar">Testar saída</button>' : '')
    + '<button class="principal" style="margin:0" id="p-fechar">Fechar</button></div>'
  abreModal()
  $('p-fechar').onclick = fechaModal
  const testar = $('p-testar')
  if (testar) testar.onclick = async () => {
    testar.disabled = true; testar.textContent = 'Testando...'
    const r = await window.sw.testarProxy(nk)
    testar.disabled = false; testar.textContent = 'Testar saída'
    const av = $('p-av')
    av.className = 'aviso ' + (r.ok ? 'ok' : 'erro')
    av.textContent = r.ok
      ? 'Saiu por ' + r.ip + (r.pais ? ' · ' + r.pais : '') + (r.cidade ? ' · ' + r.cidade : '')
      : r.erro
  }
}

// AJUSTES. O vendedor vê só o teto de janelas; proxy é da direção.
function janelaAjustes() {
  const t = Number(estado.maxAbertos) || 6
  let html = '<h2>Ajustes</h2>'
  if (estado.direcao) {
    html += '<p>As travas são da operação. O teto é só desta máquina.</p>'
      + '<div class="chave"><div class="txt"><b>Exigir proxy</b><span>Sem proxy cadastrado e respondendo, o número não abre.</span></div>'
      + '<button class="sw ' + (estado.travaProxy ? 'on' : '') + '" id="sw1" role="switch" aria-checked="' + estado.travaProxy + '"></button></div>'
      + '<div class="chave"><div class="txt"><b>Exigir IP do Brasil</b><span>Proxy de fora num número +55 é pior que proxy nenhum.</span></div>'
      + '<button class="sw ' + (estado.exigirBrasil ? 'on' : '') + '" id="sw2" role="switch" aria-checked="' + estado.exigirBrasil + '"></button></div>'
  } else {
    html += '<p>Ajustes desta máquina.</p>'
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
  estado = await window.sw.estado()
  $('versao').textContent = estado.nome || ('v' + estado.versao)
  $('versao').title = 'SellWave Web v' + estado.versao
  desenhaTrava()
  desenhaLista()
  return estado
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

$('trava').onclick = janelaAjustes
$('ajustes').onclick = janelaAjustes
$('atualizar').onclick = async () => { await window.sw.numeros(); await recarregaEstado() }
$('sair').onclick = async () => { await window.sw.sair(); await recarregaEstado(); telaLogin('') }
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenhaLista() }
modal.onclick = (e) => { if (e.target === modal) fechaModal() }
document.onkeydown = (e) => { if (e.key === 'Escape') fechaModal() }

window.sw.ao('sw:status', (d) => { const p = $('passo'); if (p && d) p.textContent = d.texto })
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

// Fechar o número que está aberto: Ctrl+W é o que todo mundo espera num navegador.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && ativo) { e.preventDefault(); fechar(ativo) }
})

inicio()
