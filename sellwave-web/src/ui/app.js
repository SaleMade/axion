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

  const cadeado = px
    ? '<span class="px" title="' + esc(px.host + ':' + px.porta) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'
    : '<span class="px sem" title="Sem proxy. Clique com o botão direito para cadastrar."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></span>'

  return '<button class="' + cls.join(' ') + '" data-numero="' + esc(n.numero) + '">'
    + '<span class="sinal"></span>'
    + '<span class="corpo"><span class="fone">' + esc(bonito(n.numero)) + '</span>'
    + '<span class="sub">' + esc(n.dono || 'sem dono') + '</span></span>'
    + cadeado + '</button>'
}

// ───────────────────────────────────────────────────────────────── palco

function telaLogin(erro) {
  palco.innerHTML = ''
    + '<div class="cartao">'
    + '<h2>Entrar</h2><p>Use o mesmo acesso da dash. O token fica guardado só nesta máquina.</p>'
    + '<div class="campo"><label>Token da dash</label><input id="tk" type="password" placeholder="cole aqui" spellcheck="false" /></div>'
    + '<div class="campo"><label>Endereço da API</label><input id="base" spellcheck="false" /></div>'
    + '<button class="principal" id="ok">Entrar</button>'
    + '<div class="aviso ' + (erro ? 'erro' : '') + '" id="av">' + esc(erro || '') + '</div>'
    + '</div>'
  $('base').value = estado.apiBase || 'https://axion-api.axion-dash.workers.dev'
  $('tk').focus()
  const entra = async () => {
    const b = $('ok'); b.disabled = true; b.textContent = 'Entrando...'
    const r = await window.sw.entrar($('tk').value, $('base').value)
    if (!r.ok) { b.disabled = false; b.textContent = 'Entrar'; return telaLogin(r.erro) }
    await recarregaEstado()
    telaVazia()
  }
  $('ok').onclick = entra
  $('tk').onkeydown = (e) => { if (e.key === 'Enter') entra() }
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
    + '<p>' + esc(bonito(nk)) + '</p>'
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
  palco.innerHTML = '<div class="vazio"><h2>Abrindo ' + esc(bonito(nk)) + '</h2><p id="passo">Preparando a sessão...</p></div>'
  const r = await window.sw.abrir(numero)
  carregando.delete(nk)
  if (!r.ok) return telaErro(nk, r.erro || 'Falhou.')
  await recarregaEstado()
  palco.innerHTML = ''
  desenhaLista()
}

function janelaProxy(numero) {
  const nk = numKey(numero)
  const px = (estado.proxies && estado.proxies[nk]) || {}
  modalCorpo.innerHTML = ''
    + '<h2>Proxy de ' + esc(bonito(nk)) + '</h2>'
    + '<p>Só proxy <b>HTTP</b>. O Chromium não autentica SOCKS com senha.</p>'
    + '<div class="linha2"><div class="campo"><label>Endereço</label><input id="p-host" spellcheck="false" /></div>'
    + '<div class="campo"><label>Porta</label><input id="p-porta" spellcheck="false" /></div></div>'
    + '<div class="linha2"><div class="campo"><label>Usuário</label><input id="p-user" spellcheck="false" /></div>'
    + '<div class="campo"><label>Senha</label><input id="p-senha" type="password" /></div></div>'
    + '<div class="aviso" id="p-av"></div>'
    + '<div class="acoes"><button class="secundario" id="p-testar">Testar saída</button>'
    + '<button class="principal" style="margin:0" id="p-salvar">Salvar</button></div>'
    + '<div class="acoes" style="margin-top:8px"><button class="secundario" id="p-fechar">Fechar</button></div>'
  $('p-host').value = px.host || ''
  $('p-porta').value = px.porta || ''
  $('p-user').value = px.usuario || ''
  $('p-senha').value = px.senha || ''
  modal.classList.add('on')
  $('p-host').focus()

  const guarda = () => window.sw.salvarProxy({
    nk, host: $('p-host').value, porta: $('p-porta').value,
    usuario: $('p-user').value, senha: $('p-senha').value,
  })
  $('p-salvar').onclick = async () => { await guarda(); await recarregaEstado(); fechaModal(); desenhaLista() }
  $('p-fechar').onclick = fechaModal
  $('p-testar').onclick = async () => {
    const b = $('p-testar'); b.disabled = true; b.textContent = 'Testando...'
    await guarda()
    const r = await window.sw.testarProxy(nk)
    b.disabled = false; b.textContent = 'Testar saída'
    const av = $('p-av')
    av.className = 'aviso ' + (r.ok ? 'ok' : 'erro')
    av.textContent = r.ok
      ? 'Saiu por ' + r.ip + (r.pais ? ' · ' + r.pais : '') + (r.cidade ? ' · ' + r.cidade : '') + (r.provedor ? ' · ' + r.provedor : '')
      : r.erro
  }
}

function janelaTravas() {
  modalCorpo.innerHTML = ''
    + '<h2>Travas</h2><p>Elas existem para o número nunca sair pelo seu IP real sem você saber.</p>'
    + '<div class="chave"><div class="txt"><b>Exigir proxy</b><span>Sem proxy cadastrado e respondendo, o número não abre.</span></div>'
    + '<button class="sw ' + (estado.travaProxy ? 'on' : '') + '" id="sw1" role="switch" aria-checked="' + estado.travaProxy + '"></button></div>'
    + '<div class="chave"><div class="txt"><b>Exigir IP do Brasil</b><span>Proxy de fora num número +55 é pior que proxy nenhum.</span></div>'
    + '<button class="sw ' + (estado.exigirBrasil ? 'on' : '') + '" id="sw2" role="switch" aria-checked="' + estado.exigirBrasil + '"></button></div>'
    + '<div class="acoes"><button class="secundario" id="t-fechar">Fechar</button></div>'
  modal.classList.add('on')
  $('sw1').onclick = async () => {
    const r = await window.sw.trava({ travaProxy: !estado.travaProxy })
    estado.travaProxy = r.travaProxy; desenhaTrava(); janelaTravas()
  }
  $('sw2').onclick = async () => {
    const r = await window.sw.trava({ exigirBrasil: !estado.exigirBrasil })
    estado.exigirBrasil = r.exigirBrasil; desenhaTrava(); janelaTravas()
  }
  $('t-fechar').onclick = fechaModal
}

function fechaModal() { modal.classList.remove('on') }

// ───────────────────────────────────────────────────────────────── inicio

async function recarregaEstado() {
  estado = await window.sw.estado()
  $('versao').textContent = 'v' + estado.versao
  desenhaTrava()
  desenhaLista()
  return estado
}

async function inicio() {
  await recarregaEstado()
  if (!estado.temToken) return telaLogin('')
  const r = await window.sw.numeros()
  if (!r.ok) { await recarregaEstado(); return telaLogin(r.erro) }
  await recarregaEstado()
  telaVazia()
}

$('trava').onclick = janelaTravas
$('atualizar').onclick = async () => { await window.sw.numeros(); await recarregaEstado() }
$('sair').onclick = async () => { await window.sw.sair(); await recarregaEstado(); telaLogin('') }
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenhaLista() }
modal.onclick = (e) => { if (e.target === modal) fechaModal() }
document.onkeydown = (e) => { if (e.key === 'Escape') fechaModal() }

window.sw.ao('sw:status', (d) => { const p = $('passo'); if (p && d) p.textContent = d.texto })
window.sw.ao('sw:erro', (d) => { if (d && d.nk) telaErro(d.nk, d.erro) })
window.sw.ao('sw:aberto', async () => { await recarregaEstado() })

inicio()
