// Casca do Sellwave Web: barra lateral, login, travas e janelinha de proxy.
// Ela NAO fala com a rede: tudo passa pelo processo principal, via window.sw (ver preload.js).

const $ = (id) => document.getElementById(id)
const palco = $('palco')
const lista = $('lista')
const modal = $('modal')
const modalCorpo = $('modal-corpo')

let estado = { numeros: [], proxies: {}, abertos: [], travaProxy: true, exigirBrasil: false, temToken: false }
let ativo = ''
let carregando = new Set()
let falhou = new Map()
let filtro = ''

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Chave do numero: DDD + 8 ultimos digitos. A MESMA do worker e do processo principal. Se mudar,
// a particao muda e o numero pede QR de novo.
function numKey(n) {
  let d = String(n || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length >= 12 && d.slice(0, 2) === '55') d = d.slice(2)
  if (d.length < 10) return d
  return d.slice(0, 2) + d.slice(-8)
}

// A chave do numero tem 10 digitos (DDD + 8) e NAO da pra formatar como telefone: sai
// "(15) 7407-6200", sem o nono digito, e numero de DDD 55 sai pior ainda. Quando a lista tem o
// numero cheio, usa ele.
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

// ───────────────────────────────────────────────────────────────── barra lateral

function desenhaTrava() {
  const el = $('trava')
  const t = estado.travaProxy
  el.className = 'trava ' + (t ? 'ligada' : 'solta')
  $('trava-txt').innerHTML = t
    ? '<b>Trava de proxy ligada</b>' + (estado.exigirBrasil ? ' · só IP do Brasil' : '')
    : '<b>Trava de proxy desligada</b>'
}

function desenhaLista() {
  const nums = (estado.numeros || []).filter((n) => {
    if (!filtro) return true
    const alvo = (String(n.numero || '') + ' ' + String(n.dono || '')).toLowerCase()
    return alvo.includes(filtro)
  })

  if (!estado.temToken) { lista.innerHTML = ''; return }
  if (!nums.length) {
    lista.innerHTML = '<div class="rotulo">' + (filtro ? 'Nada encontrado' : 'Nenhum número liberado') + '</div>'
    return
  }

  const dentro = nums.filter((n) => estado.abertos.includes(numKey(n.numero)))
  const fora = nums.filter((n) => !estado.abertos.includes(numKey(n.numero)))

  let html = ''
  if (dentro.length) html += '<div class="rotulo">Abertos</div>' + dentro.map(linha).join('')
  if (fora.length) html += '<div class="rotulo">' + (dentro.length ? 'Disponíveis' : 'Números') + '</div>' + fora.map(linha).join('')
  lista.innerHTML = html

  lista.querySelectorAll('.num').forEach((el) => {
    el.onclick = () => abrir(el.dataset.numero)
    el.oncontextmenu = (e) => { e.preventDefault(); janelaProxy(el.dataset.numero) }
  })
}

function linha(n) {
  const nk = numKey(n.numero)
  const aberto = estado.abertos.includes(nk)
  const px = estado.proxies && estado.proxies[nk]
  const cls = ['num']
  if (nk === ativo) cls.push('ativo')
  if (carregando.has(nk)) cls.push('carregando')
  else if (falhou.has(nk)) cls.push('falhou')
  else if (aberto) cls.push('aberto')
  // A BOLINHA USA A COR DO STATUS DO CHIP, a mesma que o Bruno escolheu na Contingencia (pedido
  // dele em 16/10). Vem pronta do servidor, entao trocar a cor la muda aqui sem mexer em codigo.
  // Quem avisa que a sessao esta ABERTA e a faixa verde e o grupo "Abertos", nao a bolinha.
  const corChip = /^#[0-9a-f]{3,8}$/i.test(String(n.cor || '')) ? n.cor : ''
  const estiloSinal = corChip && !carregando.has(nk) && !falhou.has(nk) ? ' style="background:' + corChip + '"' : ''

  const cadeado = px
    ? '<span class="px" title="' + esc(px.host + ':' + px.porta) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'
    : '<span class="px sem" title="Sem proxy. Clique com o botão direito para cadastrar."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></span>'

  const sub = [n.dono || 'sem dono', n.status || ''].filter(Boolean).join(' · ')
  return '<button class="' + cls.join(' ') + '" data-numero="' + esc(n.numero) + '" title="' + esc(n.status || '') + '">'
    + '<span class="sinal"' + estiloSinal + '></span>'
    + '<span class="corpo"><span class="fone">' + esc(bonito(n.numero)) + '</span>'
    + '<span class="sub">' + esc(sub) + '</span></span>'
    + cadeado + '</button>'
}

// ───────────────────────────────────────────────────────────────── palco

// TELA DE ENTRAR. Usuario e senha, os MESMOS da dash (16/10/2026, pedido do Bruno: "eu vou passar
// isso pros meus vendedores, eles sao bem leigos, como e que eles vao entender o que e token da
// dash e endereco da API"). O token existe, mas e assunto do programa, nao do vendedor: o app troca
// login e senha por token no /auth/login e guarda sozinho. O endereco da API saiu da tela.
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
    + '<p>Cada número abre numa sessão própria, com proxy próprio. Clique com o botão direito para cadastrar o proxy.</p></div>'
  desenhaLista()
}

function telaErro(nk, erro) {
  falhou.set(nk, erro)
  carregando.delete(nk)
  window.sw.esconder()
  ativo = ''
  palco.innerHTML = ''
    + '<div class="cartao"><h2>Não abriu</h2>'
    + '<p>' + esc(bonito(cheio(nk))) + '</p>'
    + '<div class="aviso erro" style="display:block">' + esc(erro) + '</div>'
    + '<div class="acoes"><button class="secundario" id="cfg">Cadastrar proxy</button>'
    + '<button class="principal" style="margin:0" id="tentar">Tentar de novo</button></div></div>'
  $('cfg').onclick = () => janelaProxy(nk)
  $('tentar').onclick = () => abrir(nk)
  desenhaLista()
}

// ───────────────────────────────────────────────────────────────── acoes

async function abrir(numero) {
  const nk = numKey(numero)
  if (!nk) return
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
  palco.innerHTML = ''
  desenhaLista()
}

// O APP NAO CADASTRA PROXY, so mostra e testa. Quem cadastra e a direcao, em Ferramentas >
// Sellwave Web. Antes o vendedor podia abrir o numero com o proxy certo, passar no preflight e
// DEPOIS trocar por um proxy dele: a trava era contornada por quem ela deveria conter.
function janelaProxy(numero) {
  const nk = numKey(numero)
  const px = (estado.proxies && estado.proxies[nk]) || null
  modalCorpo.innerHTML = ''
    + '<h2>Proxy de ' + esc(bonito(cheio(nk))) + '</h2>'
    + (px
      ? '<p>Saindo por <b>' + esc(px.host + ':' + px.porta) + '</b>.</p>'
      : '<p>Este número ainda não tem proxy. Quem cadastra é a direção, em Ferramentas &gt; Sellwave Web, na dash.</p>')
    + '<div class="aviso" id="p-av"></div>'
    + '<div class="acoes">'
    + (px ? '<button class="secundario" id="p-testar">Testar saída</button>' : '')
    + '<button class="principal" style="margin:0" id="p-fechar">Fechar</button></div>'
  abreModal()
  const fechar = $('p-fechar')
  if (fechar) fechar.onclick = fechaModal
  const testar = $('p-testar')
  if (testar) testar.onclick = async () => {
    testar.disabled = true; testar.textContent = 'Testando...'
    const r = await window.sw.testarProxy(nk)
    testar.disabled = false; testar.textContent = 'Testar saída'
    const av = $('p-av')
    av.className = 'aviso ' + (r.ok ? 'ok' : 'erro')
    av.textContent = r.ok
      ? 'Saiu por ' + r.ip + (r.pais ? ' · ' + r.pais : '') + (r.cidade ? ' · ' + r.cidade : '') + (r.provedor ? ' · ' + r.provedor : '')
      : r.erro
  }
}

function janelaTravas() {
  const t = Number(estado.maxAbertos) || 6
  modalCorpo.innerHTML = ''
    + '<h2>Ajustes</h2><p>As travas valem para todas as máquinas. O teto é só desta.</p>'
    + '<div class="chave"><div class="txt"><b>Exigir proxy</b><span>Sem proxy cadastrado e respondendo, o número não abre.</span></div>'
    + '<button class="sw ' + (estado.travaProxy ? 'on' : '') + '" id="sw1" role="switch" aria-checked="' + estado.travaProxy + '"></button></div>'
    + '<div class="chave"><div class="txt"><b>Exigir IP do Brasil</b><span>Proxy de fora num número +55 é pior que proxy nenhum.</span></div>'
    + '<button class="sw ' + (estado.exigirBrasil ? 'on' : '') + '" id="sw2" role="switch" aria-checked="' + estado.exigirBrasil + '"></button></div>'
    + '<div class="chave"><div class="txt"><b>Números abertos ao mesmo tempo</b>'
    + '<span>Cada um consome entre 400 MB e 2 GB. Passando do teto, o mais parado fecha sozinho e volta sem pedir QR.</span></div>'
    + '<input id="teto" value="' + t + '" inputmode="numeric" style="width:54px;text-align:center;padding:6px;border-radius:8px;border:1px solid var(--linha);background:rgba(255,255,255,.03);outline:none" /></div>'
    + '<div class="acoes"><button class="secundario" id="t-log">Abrir registro</button>'
    + '<button class="secundario" id="t-fechar">Fechar</button></div>'
  abreModal()
  $('sw1').onclick = async () => {
    const r = await window.sw.trava({ travaProxy: !estado.travaProxy })
    estado.travaProxy = r.travaProxy; desenhaTrava(); janelaTravas()
  }
  $('sw2').onclick = async () => {
    const r = await window.sw.trava({ exigirBrasil: !estado.exigirBrasil })
    estado.exigirBrasil = r.exigirBrasil; desenhaTrava(); janelaTravas()
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

// A janelinha e desenhada pela CASCA, que fica ATRAS da view do numero e da do painel. Com um
// numero aberto, ela abria invisivel. Entao esconder as views enquanto ela estiver na tela.
function fechaModal() {
  modal.classList.remove('on')
  if (ativo) window.sw.mostrar(ativo)
}
function abreModal() {
  window.sw.esconder()
  abreModal()
}

// ───────────────────────────────────────────────────────────────── inicio

async function recarregaEstado() {
  estado = await window.sw.estado()
  $('versao').textContent = estado.nome ? estado.nome : ('v' + estado.versao)
  $('versao').title = 'Sellwave Web v' + estado.versao
  desenhaTrava()
  desenhaLista()
  return estado
}

async function inicio() {
  await recarregaEstado()
  if (!estado.temToken) return telaLogin('')
  const r = await window.sw.numeros()
  await recarregaEstado()
  if (!r.ok) {
    // SESSAO MORTA vai pro login; FALTA DE REDE nao. Antes, dash fora do ar derrubava o vendedor
    // pra tela de entrar, onde o login tambem falhava: ele ficava preso sem conseguir trabalhar,
    // com os numeros e os proxies em cache ali do lado.
    if (/401|403|sess|senha|autenti/i.test(String(r.erro || ''))) return telaLogin(r.erro)
    avisoRede(r.erro)
    return telaVazia()
  }
  telaVazia()
}

// Aviso de "sem contato com a dash", sem tirar o vendedor do trabalho.
function avisoRede(txt) {
  const el = $('trava')
  el.className = 'trava solta'
  $('trava-txt').innerHTML = '<b>Sem contato com a dash</b> · usando o que está salvo'
  el.title = String(txt || '')
}

$('trava').onclick = janelaTravas
$('atualizar').onclick = async () => { await window.sw.numeros(); await recarregaEstado() }
$('sair').onclick = async () => { await window.sw.sair(); await recarregaEstado(); telaLogin('') }
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenhaLista() }
modal.onclick = (e) => { if (e.target === modal) fechaModal() }
document.onkeydown = (e) => { if (e.key === 'Escape') fechaModal() }

window.sw.ao('sw:status', (d) => { const p = $('passo'); if (p && d) p.textContent = d.texto })
window.sw.ao('sw:erro', (d) => {
  if (!d || !d.nk) return
  // So troca a tela se for o numero que esta na frente. Um numero escondido falhando nao pode
  // arrancar da tela o numero em que o vendedor esta conversando.
  if (d.nk === ativo || !ativo) { telaErro(d.nk, d.erro); return }
  falhou.set(d.nk, d.erro)
  desenhaLista()
})
window.sw.ao('sw:aberto', async () => { await recarregaEstado() })
// Numero que o app fechou sozinho pra caber na memoria: avisa e redesenha, senao o vendedor
// acha que caiu.
// Quantas mensagens ainda nao subiram. Some quando zera: numero na tela so quando ha o que dizer.
window.sw.ao('sw:fila', (d) => {
  const el = $('fila')
  if (!el) return
  const n = (d && Number(d.n)) || 0
  el.textContent = n ? (n + ' na fila') : ''
  el.title = n ? 'Mensagens capturadas que ainda não subiram para a dash' : ''
})

window.sw.ao('sw:hibernou', async (d) => {
  await recarregaEstado()
  if (d && d.nk === ativo) { ativo = ''; telaVazia() }
})

inicio()
