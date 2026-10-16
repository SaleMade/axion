// Sellwave Web - processo principal.
//
// O que este arquivo faz: abre uma janela com a casca da SellWave (barra lateral) e, pra cada
// numero de WhatsApp, cria uma WebContentsView COMPLETAMENTE isolada (particao propria, proxy
// proprio) carregando web.whatsapp.com.
//
// LEIA ANEXO-TECNICO.md ANTES DE MEXER. Quase toda linha estranha aqui existe por causa de uma
// armadilha medida em 15/10/2026, e o comentario diz qual.

const { app, BaseWindow, WebContentsView, session, ipcMain, shell, dialog, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 1) USER-AGENT: a primeira coisa do arquivo, e tem que ser antes de QUALQUER janela.
//
// Sem isto o WhatsApp Web devolve "O WhatsApp funciona no Google Chrome 100 ou posterior" e o QR
// nunca aparece. O Electron monta o UA padrao como "<NomeDoApp>/<versao> Chrome/<v> Electron/<v>"
// sempre que o nome do app for diferente de "Electron" (BuildApplicationUserAgent em
// shell/common/application_info.cc), entao TODO app empacotado com nome proprio nasce bloqueado.
// Medido por bisseccao: Chrome/99 bloqueia, Chrome/100 passa, e qualquer token estranho perto do
// "Chrome/" derruba. A saida e um UA de Chrome puro, montado da versao real do Chromium embarcado
// (assim ele envelhece sozinho junto com o Electron).
// Conferido: vale no documento, nos subrecursos E no handshake do wss://web.whatsapp.com/ws/chat.
const UA_LIMPO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/' + process.versions.chrome + ' Safari/537.36'
app.userAgentFallback = UA_LIMPO

const WA_URL = 'https://web.whatsapp.com'
const WA_ORIGEM = 'https://web.whatsapp.com'
const LARGURA_BARRA = 268              // barra lateral da casca (lista de numeros)
const LARGURA_PAINEL = 316             // painel de venda, na direita
const ALTURA_TOPO = 0                  // a casca desenha o topo dentro da propria barra

// Permissoes que a pagina do WhatsApp realmente pede (capturadas no handler em 15/10):
// 'media' (com mediaTypes ['audio'], que e o microfone pra audio e ligacao) e 'persistent-storage'.
// 'notifications' entra porque o vendedor precisa ser avisado de mensagem nova.
// Tudo o mais e NEGADO: o padrao do Electron e liberar tudo, entao o risco aqui e sobrar
// permissao, nao faltar.
const PERMISSOES_OK = new Set(['media', 'persistent-storage', 'notifications', 'clipboard-sanitized-write'])

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 2) Configuracao local (token da dash, proxies por numero, trava)

const ARQ_CONFIG = () => path.join(app.getPath('userData'), 'sellwave-web.json')
const ARQ_LOG = () => path.join(app.getPath('userData'), 'sellwave-web.log')

// LOG EM ARQUIVO. Sem isto, quando o app falha na maquina do vendedor nao sobra nada pra olhar:
// ele nao abre o console e nao sabe descrever o erro. O arquivo fica em %APPDATA%, e o botao
// "Abrir registro" na barra lateral abre a pasta.
// Corta em 2 MB pra nao crescer pra sempre no computador dele.
function anota(txt) {
  const linha = new Date().toISOString().slice(0, 19).replace('T', ' ') + '  ' + String(txt) + '\n'
  try {
    const f = ARQ_LOG()
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.old') } catch (_) { /* primeiro uso */ }
    fs.appendFileSync(f, linha, 'utf8')
  } catch (_) { /* log que quebra o app e pior que log nenhum */ }
}
// Tudo que ja ia pro console passa a ir junto pro arquivo.
for (const nivel of ['log', 'warn', 'error']) {
  const orig = console[nivel].bind(console)
  console[nivel] = (...a) => { orig(...a); anota((nivel === 'log' ? '' : nivel.toUpperCase() + ': ') + a.map(String).join(' ')) }
}

const CONFIG_PADRAO = {
  token: '',
  apiBase: 'https://axion-api.axion-dash.workers.dev',
  travaProxy: true,        // requisito duro do Bruno: sem proxy, nao abre
  exigirBrasil: false,     // segunda trava, opcional: so abre se o IP for BR
  proxies: {},             // { "<numkey>": { host, porta, usuario, senha } }
  numeros: [],             // cache da ultima lista vinda da dash
  maxAbertos: 6,           // teto de sessoes abertas ao mesmo tempo (ver hibernacao)
  painelLigado: true,      // o painel de venda aparece ao lado do WhatsApp?
  nome: '',                // nome de quem entrou, so pra barra lateral
  direcao: false,          // quem entrou e da direcao? quem decide e o servidor, nao o app
}

let config = { ...CONFIG_PADRAO }

function lerConfig() {
  try {
    const txt = fs.readFileSync(ARQ_CONFIG(), 'utf8')
    config = { ...CONFIG_PADRAO, ...JSON.parse(txt) }
    config.token = decifra(config.token)
    for (const p of Object.values(config.proxies || {})) { if (p) p.senha = decifra(p.senha) }
  } catch (_) {
    config = { ...CONFIG_PADRAO }
  }
  return config
}

// SEGREDO NAO VAI EM TEXTO PURO (16/10/2026, revisao adversarial).
//
// O token da dash e as senhas de proxy ficavam legiveis em %APPDATA%. Qualquer um com acesso ao
// perfil do Windows do vendedor, ou um ladrao de credencial comum, saia com uma sessao valida da
// dash e com o proxy pago da operacao. O safeStorage usa o DPAPI do proprio Windows, entao o
// arquivo so se abre naquele usuario, naquela maquina.
// Sem DPAPI disponivel, o segredo simplesmente NAO e gravado: pedir a senha de novo e melhor que
// deixar ela em texto puro.
const MARCA_CIFRA = 'enc:v1:'
function cifra(txt) {
  if (!txt) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return MARCA_CIFRA + safeStorage.encryptString(String(txt)).toString('base64')
  } catch (_) { return '' }
}
function decifra(txt) {
  const v = String(txt || '')
  if (!v.startsWith(MARCA_CIFRA)) return v   // config antiga, em texto puro: migra ao gravar
  try { return safeStorage.decryptString(Buffer.from(v.slice(MARCA_CIFRA.length), 'base64')) } catch (_) { return '' }
}

function gravarConfig() {
  try {
    const guardar = { ...config, token: cifra(config.token), proxies: {} }
    for (const [k, p] of Object.entries(config.proxies || {})) {
      guardar.proxies[k] = { ...p, senha: cifra(p && p.senha) }
    }
    fs.mkdirSync(path.dirname(ARQ_CONFIG()), { recursive: true })
    fs.writeFileSync(ARQ_CONFIG(), JSON.stringify(guardar, null, 2), 'utf8')
  } catch (e) {
    console.error('[config] nao gravou:', e && e.message)
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 3) Chave do numero.
//
// MESMA CONVENCAO DO WORKER (_waNumKey): DDD + 8 ultimos digitos. Isso importa porque a chave vira
// o nome da particao no disco, e particao e sessao: se a chave mudar, o numero pede QR de novo.
// Por isso ela e derivada do numero e NUNCA de um id gerado.
function numKey(numero) {
  let d = String(numero || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length >= 12 && d.slice(0, 2) === '55') d = d.slice(2)
  if (d.length < 10) return d
  return d.slice(0, 2) + d.slice(-8)
}

const particaoDe = (nk) => 'persist:sw-' + nk

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 4) Proxy
//
// O QUE NAO FUNCIONA (medido, ver ANEXO-TECNICO A3):
//  - SOCKS5 com usuario e senha: o Chromium nao implementa autenticacao SOCKS. Morre em
//    ERR_NO_SUPPORTED_PROXIES.
//  - Credencial dentro do proxyRules: a regra e DESCARTADA em silencio e nada funciona.
//  - proxyBypassRules '<-loopback>': isso SUBTRAI o bypass de loopback, forcando 127.0.0.1 pelo
//    proxy. Nao ganha privacidade nenhuma e quebra coisa local.
// O QUE FUNCIONA: proxy HTTP com usuario e senha, regra unica sem "=", senha pelo evento
// app.on('login').
//
// O fail-closed sai de graca: SEM "direct://" na lista, proxy fora do ar devolve
// ERR_PROXY_CONNECTION_FAILED e o Chromium NAO sai pelo IP real.

// CREDENCIAL POR PARTICAO, nao por host:porta (16/10/2026, varredura final).
//
// Proxy de ISP (o caso do isp.decodo.com dele) distingue a sessao pelo USUARIO, com o mesmo host e
// a mesma porta pra todos. Chaveando por "host:porta", o segundo numero sobrescrevia a credencial
// do primeiro e os dois passavam a sair pelo MESMO IP - exatamente a correlacao que o proxy existe
// pra evitar, e em silencio.
// A chave agora e a particao, e o evento 'login' do Electron diz qual webContents pediu, o que
// permite achar de quem e a autenticacao.
const credenciais = new Map()   // particao -> { host, porta, usuario, senha }
const particaoDoWc = new Map()  // id do webContents -> particao

// ROTEIRO (respostas rapidas, funis, audios) e as credenciais de captura. Vem da dash uma vez e
// fica aqui: o painel de cada numero pede por IPC, entao N sessoes abertas = 1 busca, nao N.
let roteiro = null
let roteiroEm = 0
async function pegaRoteiro(forcar) {
  if (!forcar && roteiro && (Date.now() - roteiroEm) < 600000) return roteiro
  if (!config.token) return null
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/roteiro',
      { headers: { Authorization: 'Bearer ' + config.token } })
    if (!r.ok) return roteiro
    const d = await r.json()
    if (d && d.ok) { roteiro = d; roteiroEm = Date.now() }
  } catch (_) { /* fica com o que tinha: roteiro velho e melhor que painel vazio */ }
  return roteiro
}

function proxyDoNumero(nk) {
  const p = config.proxies && config.proxies[nk]
  if (!p || !p.host || !p.porta) return null
  return { host: String(p.host).trim(), porta: Number(p.porta), usuario: p.usuario || '', senha: p.senha || '' }
}

// O PROXY MANDA DA DASH, nao da maquina do vendedor.
// Proxy errado (ou de fora do Brasil) num numero +55 e pior que proxy nenhum, entao quem cadastra e
// a direcao, em Ferramentas > Sellwave Web. A copia local existe so pra o app continuar abrindo se
// a dash estiver fora do ar na hora. A senha nao vem na listagem: so nesta chamada, por numero.
async function puxaProxyDaDash(nk) {
  if (!config.token || !nk) return null
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/proxy?nk=' + encodeURIComponent(nk)
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + config.token } })
    if (!r.ok) return null
    const d = await r.json()
    const px = d && d.proxy
    config.proxies = config.proxies || {}
    if (px && px.host) config.proxies[nk] = px
    else delete config.proxies[nk]
    gravarConfig()
    return px && px.host ? px : null
  } catch (_) {
    return null   // dash fora do ar: segue com a copia local, se houver
  }
}

async function aplicaProxy(ses, px, particao) {
  if (particao) {
    if (px && px.usuario) credenciais.set(particao, px)
    else credenciais.delete(particao)
  }
  if (!px) {
    // Sem proxy: deixa a sessao num buraco negro em vez de "direct". Assim, se alguma parte do
    // codigo esquecer de travar, a requisicao FALHA em vez de vazar o IP real.
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
    await ses.closeAllConnections()
    return
  }
  // Regra UNICA e sem "=": vira PROXY_LIST e vale pra http, https, ws e wss. Com "scheme=" o que
  // ficou de fora sai DIRETO, que e o vazamento classico.
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://' + px.host + ':' + px.porta })
  // Sem isto o socket velho do pool continua saindo pelo IP anterior por minutos.
  await ses.closeAllConnections()
}

// Autenticacao do proxy. Vale pra navegacao de verdade (WebContents), que e o caminho que a gente
// usa. NAO vale pra net.fetch/ses.fetch: la o evento sai no proprio objeto, nao no app - foi por
// isso que o preflight abaixo e feito num WebContents escondido, e nao com ses.fetch.
app.on('login', (event, wc, _det, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return
  // De QUEM e esta autenticacao: acha a particao daquele webContents.
  const part = wc ? particaoDoWc.get(wc.id) : ''
  const c = part ? credenciais.get(part) : null
  if (!c || !c.usuario) return
  // So responde se for o MESMO proxy que a gente mandou aquela particao usar. Proxy diferente
  // pedindo senha significa que alguma coisa redirecionou o trafego: melhor nao autenticar.
  if (String(authInfo.host) !== String(c.host) || Number(authInfo.port) !== Number(c.porta)) return
  event.preventDefault()
  callback(c.usuario, c.senha)
})

// PREFLIGHT: confere, ANTES de carregar o WhatsApp, que a sessao realmente sai pelo proxy.
// Roda num WebContents escondido com a MESMA particao, porque e o unico jeito de a autenticacao
// do proxy funcionar. Devolve { ok, ip, pais, erro }.
// Views do preflight: sem guardar a referencia, o coletor de lixo destroi a view no meio do teste
// e o executeJavaScript morre com "Object has been destroyed" (medido).
const viewsDoTeste = new Set()

function testaSaida(particao) {
  return new Promise((resolve) => {
    const view = new WebContentsView({
      webPreferences: { partition: particao, sandbox: true, javascript: true, images: false },
    })
    viewsDoTeste.add(view)
    const wc = view.webContents
    particaoDoWc.set(wc.id, particao)
    let respondeu = false
    const acabou = (r) => {
      if (respondeu) return
      respondeu = true
      clearTimeout(relogio)
      try { if (!wc.isDestroyed()) wc.close() } catch (_) { /* ok */ }
      viewsDoTeste.delete(view)
      resolve(r)
    }
    const relogio = setTimeout(() => acabou({ ok: false, erro: 'O proxy nao respondeu em 20 segundos.' }), 20000)

    wc.once('did-fail-load', (_e, code, desc) => {
      acabou({ ok: false, erro: (desc || 'falhou') + ' (' + code + ')' })
    })
    wc.once('did-finish-load', async () => {
      try {
        const txt = await wc.executeJavaScript('document.body && document.body.innerText')
        const dados = JSON.parse(String(txt || '{}'))
        if (dados && dados.query) acabou({ ok: true, ip: dados.query, pais: dados.countryCode || '', cidade: dados.city || '', provedor: dados.isp || '' })
        else acabou({ ok: false, erro: 'Resposta inesperada do teste de IP.' })
      } catch (e) {
        acabou({ ok: false, erro: 'Nao deu pra ler o IP de saida: ' + (e && e.message) })
      }
    })
    wc.loadURL('http://ip-api.com/json/?fields=status,query,countryCode,city,isp')
  })
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 5) WebRTC: a unica politica que NAO vaza o IP real.
//
// 'disable_non_proxied_udp' desliga UDP, STUN e TURN-UDP e deixa so TCP, que sai pelo proxy da
// particao. E API de webContents (nao de session), entao tem que ser aplicada em TODO webContents,
// inclusive nos que o proprio site cria.
// Valor com typo cai em 'default' EM SILENCIO: a chamada funciona lindamente e o IP vaza. Por isso
// a gente le de volta e grita.
app.on('web-contents-created', (_e, wc) => {
  try {
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    const lido = wc.getWebRTCIPHandlingPolicy && wc.getWebRTCIPHandlingPolicy()
    if (lido && lido !== 'disable_non_proxied_udp') {
      console.error('[webrtc] POLITICA NAO APLICOU, esta em "' + lido + '". O IP real pode vazar.')
    }
  } catch (e) {
    console.error('[webrtc] falhou:', e && e.message)
  }
  // Link externo abre no navegador do sistema, nunca dentro de uma sessao de numero.
  wc.setWindowOpenHandler(({ url }) => {
    // So http e https vao pro navegador do sistema. Outros esquemas (ms-..., file:, javascript:)
    // sao recusados sem abrir nada: entregar esquema desconhecido pro Windows e abrir porta.
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url)
    return { action: 'deny' }
  })
  // O PAR DO DE CIMA. Sem isto, um link com target proprio navega a sessao PRA FORA do WhatsApp:
  // a view vira um navegador comum, ainda com o proxy e a sessao do numero. Link externo vai pro
  // navegador do sistema; a sessao so anda dentro do WhatsApp.
  // COMPARA ORIGEM, NAO PREFIXO. "https://web.whatsapp.com.evil.com/" comeca com o nosso endereco
  // e passaria num startsWith, levando junto o preload e a sessao autenticada daquele numero.
  wc.on('will-navigate', (ev, url) => {
    const u = String(url || '')
    let origem = ''
    try { origem = new URL(u).origin } catch (_) { origem = '' }
    if (origem === WA_ORIGEM) return
    // A casca e o painel sao file://, e cada um tem a propria view: a de numero nunca navega pra la.
    if (u.startsWith('file://') && wc.getURL().startsWith('file://')) return
    ev.preventDefault()
    if (/^https?:/i.test(u)) shell.openExternal(u)
  })
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 6) Janela e views

let janela = null
let casca = null
let painel = null   // a view do painel de venda, uma so pra todos os numeros
const abertos = new Map()   // nk -> { view, nk, numero, carregado, ultimoUso }
let ativoAgora = ''         // qual numero esta na tela (a hibernacao nunca fecha este)

// TRES COLUNAS: barra de numeros | WhatsApp | painel de venda.
//
// O painel e uma VIEW PROPRIA, nao um pedaco injetado na pagina. Se fosse injetado, pra ele nao
// cobrir a conversa a gente teria que encolher o layout do WhatsApp por CSS - que depende do DOM
// deles e quebra quando eles mudam - e o CSS deles poderia quebrar o nosso. Separado, cada um cuida
// do seu espaco e nenhum estraga o outro.
// O painel pode ser escondido: em tela pequena ele e a barra comiam 584 px e sobrava pouco pro
// WhatsApp, que corta a tela de entrar da Meta.
let painelLigado = true
function temPainel() { return painelLigado && !!ativoAgora && abertos.has(ativoAgora) }

function areaConteudo() {
  if (!janela) return { x: 0, y: 0, width: 0, height: 0 }
  const b = janela.getContentBounds()
  const reserva = temPainel() ? LARGURA_PAINEL : 0
  return { x: LARGURA_BARRA, y: ALTURA_TOPO, width: Math.max(0, b.width - LARGURA_BARRA - reserva), height: Math.max(0, b.height - ALTURA_TOPO) }
}

function areaPainel() {
  if (!janela) return { x: 0, y: 0, width: 0, height: 0 }
  const b = janela.getContentBounds()
  return { x: Math.max(0, b.width - LARGURA_PAINEL), y: 0, width: LARGURA_PAINEL, height: b.height }
}

function reposiciona() {
  if (!janela) return
  const b = janela.getContentBounds()
  if (casca) casca.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  const area = areaConteudo()
  for (const s of abertos.values()) s.view.setBounds(area)
  if (painel) {
    const liga = temPainel()
    painel.setVisible(liga)
    if (liga) { painel.setBounds(areaPainel()); janela.contentView.addChildView(painel) }
  }
}

function avisaCasca(canal, dados) {
  try { casca && casca.webContents.send(canal, dados) } catch (_) { /* ok */ }
}

function preparaSessao(nk) {
  const ses = session.fromPartition(particaoDe(nk))
  // Permissao por particao, negando tudo que nao esta na lista e so pra origem do WhatsApp.
  ses.setPermissionRequestHandler((wc, permissao, callback, detalhes) => {
    const origem = (detalhes && detalhes.requestingUrl) || (wc && wc.getURL && wc.getURL()) || ''
    const daCasa = String(origem).startsWith(WA_ORIGEM)
    // MICROFONE SIM, CAMERA NAO. O vendedor manda audio e liga por voz; video nunca foi pedido, e
    // liberar camera numa tela que fica aberta o dia inteiro e risco sem contrapartida.
    const tipos = (detalhes && detalhes.mediaTypes) || []
    const soAudio = permissao !== 'media' || !tipos.includes('video')
    callback(!!daCasa && PERMISSOES_OK.has(permissao) && soAudio)
  })
  ses.setPermissionCheckHandler((_wc, permissao, origem) => {
    return String(origem || '').startsWith(WA_ORIGEM) && PERMISSOES_OK.has(permissao)
  })
  return ses
}

// Abre (ou traz pra frente) a sessao de um numero. Faz o preflight do proxy ANTES de carregar o
// WhatsApp: se a trava estiver ligada e o proxy nao responder, a pagina nao chega a ser pedida.
// Quem ja esta no meio da abertura. Sem isto, dois cliques no mesmo numero (coisa que vendedor
// leigo faz direto, ainda mais com a lista redesenhando embaixo do dedo) criam DUAS views na MESMA
// particao, e o WhatsApp Web entra em conflito de sessao.
const abrindo = new Set()
// Qual foi o ULTIMO numero que o vendedor pediu. Duas aberturas correm em paralelo e a mais lenta
// terminava por ultimo, roubando a tela de quem ele clicou depois.
let pedidoAtual = 0

async function abreNumero(numero) {
  const nk = numKey(numero)
  if (!nk) return { ok: false, erro: 'Numero invalido.' }

  if (abertos.has(nk)) {
    mostra(nk)
    return { ok: true, jaAberto: true }
  }
  if (abrindo.has(nk)) return { ok: true, jaAberto: true }
  abrindo.add(nk)
  const meu = ++pedidoAtual
  try {
    return await abreDeVerdade(nk, numero, meu)
  } finally { abrindo.delete(nk) }
}

async function abreDeVerdade(nk, numero, meu) {

  avisaCasca('sw:status', { nk, texto: 'Buscando o proxy na dash...' })
  await puxaProxyDaDash(nk)
  const px = proxyDoNumero(nk)
  if (config.travaProxy && !px) {
    return { ok: false, erro: 'Este número não tem proxy cadastrado, e a trava está ligada. Cadastre o proxy em Ferramentas > Sellwave Web, na dash.' }
  }

  const ses = preparaSessao(nk)
  await aplicaProxy(ses, px, particaoDe(nk))

  if (config.travaProxy && px) {
    avisaCasca('sw:status', { nk, texto: 'Conferindo o proxy...' })
    const teste = await testaSaida(particaoDe(nk))
    if (!teste.ok) {
      // Fail-closed: deixa a sessao no buraco negro, pra nada escapar depois.
      await aplicaProxy(ses, null, particaoDe(nk))
      return { ok: false, erro: 'O proxy não respondeu: ' + teste.erro }
    }
    // FECHA quando NAO SABE o pais, nao so quando sabe que e outro. Antes, resposta sem countryCode
    // passava - e o teste e http em texto claro, entao o proprio dono do proxy podia forjar.
    if (config.exigirBrasil && teste.pais !== 'BR') {
      await aplicaProxy(ses, null, particaoDe(nk))
      return { ok: false, erro: teste.pais
        ? 'O proxy saiu por ' + teste.pais + ', e a exigência de IP brasileiro está ligada.'
        : 'Não deu pra confirmar que o IP é do Brasil, e a exigência está ligada.' }
    }
    avisaCasca('sw:saida', { nk, ip: teste.ip, pais: teste.pais, cidade: teste.cidade, provedor: teste.provedor })
  }

  // Baixa o motor ANTES de criar a view: o preload pede ele de forma sincrona no inicio do
  // documento, e se nao estiver em maos ali, a injecao cai pro caminho tardio.
  await pegaMotor()

  const view = new WebContentsView({
    webPreferences: {
      partition: particaoDe(nk),
      preload: path.join(__dirname, 'preload-wa.js'),
      // SANDBOX LIGADO: esta view roda a pagina da Meta e um motor de 500 KB baixado da rede. O
      // preload so usa contextBridge, ipcRenderer e webFrame, que funcionam com sandbox, entao
      // desligar nao compraria nada e tiraria a caixa de areia do sistema operacional.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  })
  const s = { view, nk, numero, carregado: false, ultimoUso: Date.now() }
  abertos.set(nk, s)
  particaoDoWc.set(view.webContents.id, particaoDe(nk))

  view.webContents.on('did-finish-load', () => {
    s.carregado = true
    avisaCasca('sw:aberto', { nk })
    injetaPainel(s)
  })
  view.webContents.on('did-fail-load', (_e, code, desc, url, ehPrincipal) => {
    if (code === -3) return                       // navegacao abortada, normal
    // SO O QUADRO PRINCIPAL. Um subframe do proprio WhatsApp falhando nao e o numero caindo, e
    // avisar a casca fazia a tela do numero que o vendedor estava usando sumir.
    if (ehPrincipal === false) return
    if (url && !String(url).startsWith(WA_URL)) return
    avisaCasca('sw:erro', { nk, erro: desc + ' (' + code + ')' })
  })

  janela.contentView.addChildView(view)
  view.setBounds(areaConteudo())
  view.webContents.loadURL(WA_URL)
  // SO VAI PRA TELA SE AINDA FOR O QUE ELE QUER. Se ele clicou noutro numero enquanto este abria,
  // a sessao fica pronta escondida e a casca so é avisada.
  if (!meu || meu === pedidoAtual) mostra(nk)
  else avisaCasca('sw:aberto', { nk })
  return { ok: true, naTela: !meu || meu === pedidoAtual }
}

function mostra(nk) {
  const area = areaConteudo()
  for (const [chave, s] of abertos) {
    if (chave === nk) {
      s.ultimoUso = Date.now()
      s.view.setVisible(true)
      s.view.setBounds(area)
      janela.contentView.addChildView(s.view)   // re-adicionar traz pra frente
    } else {
      s.view.setVisible(false)
    }
  }
  ativoAgora = nk
  avisaCasca('sw:ativo', { nk })
  reposiciona()
  hibernaSePrecisar()
}

function escondeTodos() {
  for (const s of abertos.values()) s.view.setVisible(false)
  ativoAgora = ''
  avisaCasca('sw:ativo', { nk: '' })
  reposiciona()
}

// HIBERNACAO. O Chromium NUNCA compartilha processo entre particoes diferentes, entao cada numero
// aberto e um navegador inteiro: foi medido ~430 MB so na tela de QR, e 600 MB a 2 GB logado com
// conversa. Sem teto, o vendedor abre oito numeros e a maquina dele morre.
//
// Quando passa do teto, fecha o que esta parado ha mais tempo (e nunca o que esta na tela). A
// sessao fica no disco, entao reabrir e so recarregar: NAO pede QR de novo.
//
// O PRECO, e e honesto dizer: numero hibernado para de capturar mensagem enquanto estiver fechado.
// Por isso o teto e configuravel e o padrao e 6, nao 2.
function hibernaSePrecisar() {
  const teto = Math.max(1, Number(config.maxAbertos) || 6)
  if (abertos.size <= teto) return
  const candidatos = [...abertos.values()]
    .filter((s) => s.nk !== ativoAgora)
    .sort((a, b) => (a.ultimoUso || 0) - (b.ultimoUso || 0))
  while (abertos.size > teto && candidatos.length) {
    const s = candidatos.shift()
    console.log('[memoria] hibernando ' + s.nk + ' (teto de ' + teto + ' sessoes abertas)')
    fechaNumero(s.nk)
    avisaCasca('sw:hibernou', { nk: s.nk })
  }
}

function fechaNumero(nk) {
  const s = abertos.get(nk)
  if (!s) return
  try { janela.contentView.removeChildView(s.view) } catch (_) { /* ok */ }
  try { s.view.webContents.close() } catch (_) { /* ok */ }
  abertos.delete(nk)
  if (ativoAgora === nk) ativoAgora = ''
  avisaCasca('sw:fechado', { nk })
  reposiciona()
}

// INJECAO DO MOTOR E DO PAINEL.
//
// POR QUE executeJavaScript E NAO <script>: a pagina do WhatsApp tem CSP apertada e barra script
// externo e inline. O executeJavaScript roda no mundo PRINCIPAL e nao passa pela CSP, entao a gente
// nao precisa arrancar o cabecalho de seguranca da pagina - que seria piorar a seguranca do
// vendedor pra ganhar conveniencia.
//
// ORDEM IMPORTA: primeiro o motor (WA-JS), depois o painel. O painel espera o window.WPP ficar
// pronto sozinho, entao nao trava se o motor demorar.
const CAMINHO_AGENTE = path.join(__dirname, 'ui', 'agente.js')
let motorCache = ''
async function pegaMotor() {
  if (motorCache) return motorCache
  const r = await pegaRoteiro(false)
  const url = (r && r.motor) || (String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/motor.js')
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('motor respondeu ' + resp.status)
    const txt = await resp.text()
    // O motor tem ~500 KB. Resposta curta demais e pagina de erro disfarcada de script.
    if (txt.length < 100000) throw new Error('motor veio pela metade (' + txt.length + ' bytes)')
    motorCache = txt
    return txt
  } catch (e) {
    console.error('[painel] nao baixei o motor:', e && e.message)
    return ''
  }
}
// O PRELOAD PEDE O CODIGO DE FORMA SINCRONA e injeta no inicio do documento, que e o momento certo
// pro WA-JS: ele precisa estar la antes dos scripts do WhatsApp engancharem. O caminho pelo
// did-finish-load continua existindo como rede de seguranca (se o motor ainda nao tinha sido
// baixado na hora em que a pagina comecou).
ipcMain.on('sw:codigo', (e) => {
  let agente = ''
  try { agente = fs.readFileSync(CAMINHO_AGENTE, 'utf8') } catch (_) { /* ok */ }
  e.returnValue = { motor: motorCache || '', agente }
})

async function injetaPainel(s) {
  if (!s || !s.view || s.view.webContents.isDestroyed()) return
  const wc = s.view.webContents
  // DUAS PERGUNTAS SEPARADAS. O agente vem do disco e sempre entra; o MOTOR vem da rede e pode ter
  // falhado. Perguntar so pelo agente dava "ja esta instalado" com o motor ausente, e o painel
  // ficava em "esperando o WhatsApp carregar" pra sempre, sem ninguem saber por que.
  try {
    const temMotor = await wc.executeJavaScript('typeof window.WPP !== "undefined"').catch(() => false)
    if (!temMotor) {
      motorCache = ''                      // a copia vazia nao serve: busca de novo
      const motor = await pegaMotor()
      if (motor) await wc.executeJavaScript(motor, true).catch((e) => console.error('[painel] motor nao rodou:', e && e.message))
      else console.error('[painel] sem motor em ' + s.nk + ': o painel nao vai conseguir mandar')
    }
    const temAgente = await wc.executeJavaScript('typeof window.__swEstado === "function"').catch(() => false)
    if (!temAgente) await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
    console.log('[painel] pronto em ' + s.nk + (temMotor ? '' : ' (motor injetado agora)'))
  } catch (e) {
    console.error('[painel] falhou em ' + s.nk + ': ' + ((e && e.message) || e))
  }
}

// FILA DE CAPTURA. O painel manda lotes; aqui eles viram POST pra rota de ingestao do Sale Chat,
// que e a MESMA que ja alimenta o inbox, a atribuicao e o pixel. Reusar em vez de criar um segundo
// caminho evita ter duas verdades sobre a mesma conversa.
// A FILA SOBREVIVE A FECHAR O APP. Ela so existia em memoria: fechar o programa (ou um
// travamento) perdia tudo que ainda nao tinha subido, calado. Ela e pequena - texto de mensagem.
const ARQ_FILA = () => path.join(app.getPath('userData'), 'captura-pendente.json')
const filaCaptura = []
let drenando = false
let filaSuja = false
function gravaFila() {
  if (!filaSuja) return
  gravaFilaAgora()
}
function gravaFilaAgora() {
  filaSuja = false
  try { fs.writeFileSync(ARQ_FILA(), JSON.stringify(filaCaptura.slice(0, 5000)), 'utf8') } catch (_) { /* ok */ }
}
function leFila() {
  try {
    const v = JSON.parse(fs.readFileSync(ARQ_FILA(), 'utf8'))
    if (Array.isArray(v) && v.length) { filaCaptura.push(...v); console.log('[captura] ' + v.length + ' mensagens esperando do uso anterior') }
  } catch (_) { /* primeiro uso */ }
}
setInterval(gravaFila, 10000)
app.on('before-quit', gravaFila)
async function drenaCaptura() {
  if (drenando || !filaCaptura.length) return
  const r = await pegaRoteiro(false)
  // A captura vai pela rota AUTENTICADA, com o Bearer do proprio usuario. O token de ingestao nao
  // desce mais pro app (ver worker: quem o tivesse podia inventar venda).
  const alvo = (r && r.captura) || (String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/captura')
  if (!config.token) return
  drenando = true
  try {
    while (filaCaptura.length) {
      // NÃO TIRA DA FILA ANTES DA CONFIRMAÇÃO. Antes o lote saía da fila no `splice` e só existia
      // em memória: fechar o app (ou um travamento) no meio do envio perdia aquelas mensagens, sem
      // erro nenhum. Agora a fila só encolhe pelo que o servidor confirmou no ack, e reenviar é
      // seguro porque a ingestão deduplica por id.
      const lote = filaCaptura.slice(0, 50)
      gravaFilaAgora()
      let aceitos = null
      try {
        const resp = await fetch(alvo, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
          body: JSON.stringify({ events: lote }),
        })
        if (resp.status === 401 || resp.status === 403) {
          console.error('[captura] sessao vencida: a fila fica guardada ate entrar de novo')
          avisaCasca('sw:fila', { n: filaCaptura.length, erro: 'entre de novo na dash' })
          break
        }
        if (!resp.ok) { console.error('[captura] ingestao respondeu ' + resp.status); break }
        const d = await resp.json().catch(() => null)
        aceitos = d && Array.isArray(d.ack) ? new Set(d.ack.map(String)) : null
        const barrados = Number(d && d.barrados) || 0
        if (barrados) console.error('[captura] o servidor recusou ' + barrados + ' evento(s) deste lote')
      } catch (e) {
        console.error('[captura] nao enviou: ' + ((e && e.message) || e))
        break
      }
      // Sem ack detalhado (lote todo aceito ou todo barrado), tira o lote inteiro: o servidor
      // respondeu 200, e segurar pra sempre o que ele nunca vai aceitar enche a fila.
      const antes = filaCaptura.length
      if (aceitos && aceitos.size) {
        for (let i = filaCaptura.length - 1; i >= 0; i--) {
          const id = String(filaCaptura[i] && filaCaptura[i].msgId)
          if (aceitos.has(id)) filaCaptura.splice(i, 1)
        }
        // O que ficou do lote e nao voltou no ack sai mesmo assim: senao o mesmo evento recusado
        // bloquearia a fila inteira pra sempre.
        for (const ev of lote) {
          const i = filaCaptura.indexOf(ev)
          if (i >= 0) filaCaptura.splice(i, 1)
        }
      } else {
        filaCaptura.splice(0, lote.length)
      }
      if (filaCaptura.length === antes) break   // nada saiu: para em vez de girar
      filaSuja = true
    }
  } finally {
    drenando = false
    gravaFila()
    avisaCasca('sw:fila', { n: filaCaptura.length })
  }
}
setInterval(drenaCaptura, 15000)

// SINAL DE VIDA DOS NUMEROS ABERTOS.
//
// A roleta so manda lead pra numero que ela considera vivo, e a linha expira em 3 minutos. Sem
// isto, numero que sai do Datacrazy e passa a viver aqui some da roleta e para de receber lead em
// silencio - o pior desfecho possivel numa migracao. Manda a cada 60 segundos, e so marca vivo
// quando o motor do WhatsApp esta de pe naquela sessao.
async function bateSinal() {
  if (!config.token || !abertos.size) return
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/heartbeat'
  for (const s of abertos.values()) {
    if (!s.view || s.view.webContents.isDestroyed()) continue
    let e = null
    try { e = await s.view.webContents.executeJavaScript('window.__swEstado ? window.__swEstado() : null') } catch (_) { e = null }
    const numero = (e && e.eu) || s.numero
    if (!numero) continue
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
        body: JSON.stringify({ numero, motor: !!(e && e.motor) }),
      })
    } catch (_) { /* sem rede o sinal expira sozinho, que e o certo */ }
  }
}
setInterval(bateSinal, 60000)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 7) Conversa com a dash

async function buscaNumeros() {
  if (!config.token) return { ok: false, erro: 'Falta entrar com o token da dash.' }
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/numeros'
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + config.token } })
    if (!r.ok) return { ok: false, erro: 'A dash respondeu ' + r.status }
    const d = await r.json()
    const lista = Array.isArray(d && d.numeros) ? d.numeros : []
    config.numeros = lista
    config.direcao = !!(d && d.direcao)
    if (d && d.config) {
      if (typeof d.config.travaProxy === 'boolean') config.travaProxy = d.config.travaProxy
      if (typeof d.config.exigirBrasil === 'boolean') config.exigirBrasil = d.config.exigirBrasil
    }
    gravarConfig()
    return { ok: true, numeros: lista }
  } catch (e) {
    return { ok: false, erro: 'Nao deu pra falar com a dash: ' + (e && e.message) }
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 8) IPC

ipcMain.handle('sw:estado', () => ({
  temToken: !!config.token,
  nome: config.nome || '',
  apiBase: config.apiBase,
  travaProxy: config.travaProxy,
  exigirBrasil: config.exigirBrasil,
  numeros: config.numeros,
  proxies: config.proxies,
  maxAbertos: Number(config.maxAbertos) || 6,
  direcao: !!config.direcao,
  painelLigado: painelLigado,
  abertos: [...abertos.keys()],
  versao: app.getVersion(),
  chromium: process.versions.chrome,
}))

// ENTRAR COM USUARIO E SENHA, nao com token (16/10/2026, pedido do Bruno: "eu vou passar isso pros
// meus vendedores, eles sao bem leigos, como e que eles vao entender o que e token da dash e
// endereco da API"). O app troca login e senha por token no MESMO /auth/login da dash, e guarda o
// token aqui dentro. O endereco da API saiu da tela: e sempre o nosso worker.
ipcMain.handle('sw:entrar', async (_e, { login, senha }) => {
  const usuario = String(login || '').trim()
  if (!usuario || !senha) return { ok: false, erro: 'Preencha usuário e senha.' }
  const url = String(config.apiBase).replace(/\/+$/, '') + '/auth/login'
  let d = null
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: usuario, password: String(senha) }),
    })
    d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || (r.status === 401 ? 'Usuário ou senha errados.' : 'A dash respondeu ' + r.status) }
  } catch (e) {
    return { ok: false, erro: 'Não deu pra falar com a dash. Confira a internet.' }
  }
  const tk = d && (d.token || (d.user && d.user.token))
  if (!tk) return { ok: false, erro: 'A dash não devolveu o acesso. Avise a direção.' }
  config.token = String(tk)
  config.nome = (d.user && (d.user.name || d.user.login)) || usuario
  gravarConfig()
  return buscaNumeros()
})

ipcMain.handle('sw:sair', () => { config.token = ''; config.nome = ''; gravarConfig(); return { ok: true } })
ipcMain.handle('sw:numeros', () => buscaNumeros())
ipcMain.handle('sw:abrir', (_e, { numero }) => abreNumero(numero))
ipcMain.handle('sw:mostrar', (_e, { nk }) => { mostra(nk); return { ok: true } })
ipcMain.handle('sw:esconder', () => { escondeTodos(); return { ok: true } })
ipcMain.handle('sw:fechar', (_e, { nk }) => { fechaNumero(nk); return { ok: true } })

// O APP NAO CADASTRA PROXY (16/10/2026, revisao adversarial).
//
// Antes o vendedor podia abrir o numero com o proxy da direcao, passar no preflight, e DEPOIS
// trocar por um proxy dele (ou pelo IP da casa dele) com o botao direito: a trava era contornada
// pelo proprio lado que ela deveria conter. Quem cadastra e a direcao, em Ferramentas > Sellwave
// Web, e o app so LE.
ipcMain.handle('sw:proxy-testar', async (_e, { nk }) => {
  await puxaProxyDaDash(nk)
  const px = proxyDoNumero(nk)
  if (!px) return { ok: false, erro: 'Sem proxy cadastrado pra este número. Cadastre na dash.' }
  // PARTICAO DESCARTAVEL: testar na particao viva aplicaria o proxy numa sessao ja aberta.
  const teste = 'persist:sw-teste-' + nk
  await aplicaProxy(session.fromPartition(teste), px, teste)
  const r = await testaSaida(teste)
  await aplicaProxy(session.fromPartition(teste), null, teste)
  return r
})

ipcMain.handle('sw:trava', (_e, { travaProxy, exigirBrasil }) => {
  if (typeof travaProxy === 'boolean') config.travaProxy = travaProxy
  if (typeof exigirBrasil === 'boolean') config.exigirBrasil = exigirBrasil
  gravarConfig()
  return { ok: true, travaProxy: config.travaProxy, exigirBrasil: config.exigirBrasil }
})

// ── IPC DO PAINEL (vem de dentro da pagina do WhatsApp, pela ponte do preload-wa.js)
ipcMain.handle('swp:roteiro', async () => {
  const r = await pegaRoteiro(false)
  if (!r) return { ok: false }
  // O TOKEN DE INGESTAO NAO DESCE PRO PAINEL. Ele roda no mesmo mundo da pagina do WhatsApp; se
  // vazar dali, da pra injetar venda falsa (comissao e pixel). A captura sobe por IPC e quem
  // posta e o processo principal.
  return { ok: true, messages: r.messages, sequences: r.sequences, media: r.media, mediaBase: r.mediaBase }
})

// O painel pergunta o estado e manda item pela view do numero que esta na tela. Quem executa de
// verdade e o agente, dentro da pagina: aqui so se faz a travessia.
function viewAtiva() {
  const s = ativoAgora && abertos.get(ativoAgora)
  if (!s || !s.view || s.view.webContents.isDestroyed()) return null
  return s.view.webContents
}

const ESTADO_VAZIO = { motor: false, envia: false, chatId: '', phone: '', nome: '', eu: '', trocado: '' }

ipcMain.handle('swp:estado-wa', async () => {
  const wc = viewAtiva()
  if (!wc) return { ...ESTADO_VAZIO }
  const nkAtual = ativoAgora
  let e
  try { e = await wc.executeJavaScript('window.__swEstado ? window.__swEstado() : null') } catch (_) { e = null }
  if (!e) return { ...ESTADO_VAZIO }
  // O NUMERO PAREADO E O MESMO DO SLOT? (16/10/2026, revisao adversarial.)
  // Se o vendedor ler o QR do slot (15) 97407-6200 com OUTRO aparelho, a barra continua dizendo
  // (15), o proxy usado continua sendo o do (15) e a captura sai carimbada com o numero de verdade.
  // A dash e o app passam a discordar do que esta acontecendo, em silencio. Melhor gritar.
  const esperado = ativoAgora
  const real = numKey(e.eu || '')
  // MANDA O NUMERO CHEIO, nao a chave de 10 digitos: a chave formatada como telefone perde o nono
  // digito e mostra um numero que nao existe.
  e.trocado = (real && esperado && real !== esperado) ? String(e.eu || '') : ''
  if (e.trocado) console.error('[slot] ' + esperado + ' esta pareado com ' + real)
  e.nk = nkAtual
  return e
})

// A MIDIA E BAIXADA AQUI, NAO NA PAGINA.
//
// A CSP do web.whatsapp.com tem connect-src que nao inclui os nossos dominios, entao um fetch pra
// /api/salechat/media/... de dentro da pagina e bloqueado pelo navegador. O processo principal nao
// passa por CSP nem por CORS: ele baixa, vira dataUri e manda pronto junto do item.
// Cacheado porque o mesmo audio e usado o dia inteiro, em todos os leads.
const cacheMidia = new Map()
async function dataUriDe(url) {
  if (cacheMidia.has(url)) return cacheMidia.get(url)
  const r = await fetch(url)
  if (!r.ok) throw new Error('a midia respondeu ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  const tipo = r.headers.get('content-type') || 'application/octet-stream'
  const uri = 'data:' + tipo + ';base64,' + buf.toString('base64')
  if (cacheMidia.size > 120) cacheMidia.clear()   // teto simples: o roteiro tem ~34 midias
  cacheMidia.set(url, uri)
  return uri
}

ipcMain.handle('swp:manda', async (_e, { nk, chatId, item }) => {
  // O ENVIO VAI PRA VIEW DAQUELE NUMERO, nao pra "a que esta na tela".
  //
  // O funil dura dezenas de segundos (tem pausa e simulacao de digitando). Se o vendedor clicasse
  // noutro numero no meio, os passos seguintes saiam pelo OUTRO chip, pro mesmo lead: metade da
  // conversa de um numero, metade de outro, e a atribuicao da venda quebrada.
  const alvo = String(nk || '') ? abertos.get(String(nk)) : null
  const wc = alvo && alvo.view && !alvo.view.webContents.isDestroyed() ? alvo.view.webContents : (nk ? null : viewAtiva())
  if (!wc) return { ok: false, erro: nk ? 'o número foi fechado, o funil parou aqui' : 'nenhum número aberto' }
  const pedaco = { ...(item || {}) }
  if (pedaco.tipo === 'midia') {
    if (!pedaco.url) return { ok: false, erro: 'esse item nao tem arquivo' }
    try { pedaco.dataUri = await dataUriDe(pedaco.url) }
    catch (e) { return { ok: false, erro: 'nao baixei a midia: ' + ((e && e.message) || e) } }
    delete pedaco.url
  }
  try {
    const r = await wc.executeJavaScript(
      'window.__swManda(' + JSON.stringify(String(chatId || '')) + ',' + JSON.stringify(pedaco) + ')', true
    )
    return { ok: !!r }
  } catch (e) {
    return { ok: false, erro: String((e && e.message) || e).replace(/^Error:\s*/, '').slice(0, 160) }
  }
})

// Fechar e recarregar a sessao que esta na tela, pelo proprio painel: e onde a mao do vendedor ja
// esta. A sessao fica no disco, entao fechar NAO pede QR de novo depois.
ipcMain.handle('swp:painel', (_e, { ligado }) => {
  painelLigado = ligado !== false
  if (config.painelLigado !== painelLigado) { config.painelLigado = painelLigado; gravarConfig() }
  reposiciona()
  return { ok: true, ligado: painelLigado }
})

ipcMain.handle('swp:fechar-ativo', () => {
  if (ativoAgora) fechaNumero(ativoAgora)
  return { ok: true }
})
ipcMain.handle('swp:recarregar-ativo', () => {
  const wc = viewAtiva()
  if (wc) wc.reload()
  return { ok: true }
})

ipcMain.handle('swp:lead', async (_e, { phone }) => {
  const fone = String(phone || '').replace(/\D/g, '')
  if (!config.token || fone.length < 8) return { ok: true, achou: false }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/lead?phone=' + encodeURIComponent(fone),
      { headers: { Authorization: 'Bearer ' + config.token } })
    if (!r.ok) return { ok: true, achou: false }
    return await r.json()
  } catch (_) { return { ok: true, achou: false } }
})

ipcMain.on('swp:captura', (_e, dados) => {
  const evs = (dados && Array.isArray(dados.eventos)) ? dados.eventos : []
  if (!evs.length) return
  // Teto de seguranca: se a dash ficar fora do ar por muito tempo, segura as ultimas 5 mil e
  // descarta as mais velhas, em vez de estourar a memoria do vendedor.
  for (const ev of evs) filaCaptura.push(ev)
  if (filaCaptura.length > 5000) {
    const perdidas = filaCaptura.length - 5000
    filaCaptura.splice(0, perdidas)
    console.error('[captura] fila cheia: ' + perdidas + ' mensagem(ns) antiga(s) descartada(s)')
  }
  filaSuja = true
  avisaCasca('sw:fila', { n: filaCaptura.length })
  if (filaCaptura.length >= 50) drenaCaptura()
})

// LIGA E DESLIGA A CHEGADA DE LEAD naquele numero.
//
// Vai pela MESMA rota que a Contingencia usa (POST /api/pressel/num), nao por um caminho novo: a
// roleta ja derrubou a operacao antes e nao e lugar pra ter duas implementacoes. O `at` sai da
// lista que o servidor mandou, e o servidor confere de novo que o numero e daquele vendedor.
ipcMain.handle('sw:roleta', async (_e, { nk, on }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo.' }
  const n = (config.numeros || []).find((x) => numKey(x.numero) === String(nk))
  if (!n || !n.at) return { ok: false, erro: 'Número não encontrado na lista.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/pressel/num', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ at: n.at, num: n.numero, on: !!on }),
    })
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('A dash respondeu ' + r.status) }
    n.roleta = !!on
    gravarConfig()
    // Puxa a lista de novo pra pegar o estado de verdade (e o placar de leads).
    buscaNumeros().catch(() => {})
    return { ok: true, on: !!on }
  } catch (e) {
    return { ok: false, erro: 'Não deu pra falar com a dash.' }
  }
})

ipcMain.handle('sw:teto', (_e, { maxAbertos }) => {
  const n = Math.max(1, Math.min(20, Number(maxAbertos) || 6))
  config.maxAbertos = n
  gravarConfig()
  hibernaSePrecisar()
  return { ok: true, maxAbertos: n }
})

ipcMain.handle('sw:abrirLog', () => { try { shell.showItemInFolder(ARQ_LOG()) } catch (_) { /* ok */ } return { ok: true } })

ipcMain.handle('sw:recarregar', (_e, { nk }) => {
  const s = abertos.get(nk)
  if (s) s.view.webContents.reload()
  return { ok: true }
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 9) Ligar

app.whenReady().then(() => {
  lerConfig()
  painelLigado = config.painelLigado !== false
  leFila()

  // A sessao PADRAO tambem vai pro buraco negro. Assim, qualquer parte do app que esqueca de usar
  // a particao certa FALHA em vez de vazar o IP real da maquina.
  try {
    session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
  } catch (_) { /* ok */ }

  // MODO DE TESTE NAO ABRE JANELA NA TELA (16/10/2026). O autoteste e o modo foto rodam o app de
  // verdade, e cada rodada piscava uma janela no monitor de quem estiver usando o computador.
  janela = new BaseWindow({
    // 1180 = barra (268) + painel (316) + 596 pro WhatsApp. Medido: abaixo disso a tela de entrar
    // da Meta corta na direita e o vendedor nao ve o QR inteiro.
    width: 1440, height: 920, minWidth: 1180, minHeight: 680,
    title: 'Sellwave Web',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    // O modo FOTO precisa da janela desenhando (capturePage nao funciona em janela escondida),
    // entao so o autoteste roda invisivel. Quem mexer aqui: ver o comentario em foto.js.
    show: process.env.SW_SMOKE !== '1',
  })

  // A casca usa a sessao PROPRIA dela (nao a default, que esta no buraco negro) e fala com a dash
  // pelo processo principal, nunca direto.
  casca = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:sw-casca',
    },
  })
  session.fromPartition('persist:sw-casca').setProxy({ mode: 'direct' })
  janela.contentView.addChildView(casca)
  casca.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'))

  // O PAINEL DE VENDA. Uma view so, reaproveitada por todos os numeros: ela nao guarda estado do
  // WhatsApp, so pergunta pro numero que esta na tela. Fica escondida ate ter numero aberto.
  painel = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-painel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:sw-painel',
    },
  })
  session.fromPartition('persist:sw-painel').setProxy({ mode: 'direct' })
  painel.setVisible(false)
  janela.contentView.addChildView(painel)
  painel.webContents.loadFile(path.join(__dirname, 'ui', 'painel.html'))

  reposiciona()

  janela.on('resize', reposiciona)
  janela.on('closed', () => { janela = null })

  if (process.argv.includes('--dev')) casca.webContents.openDevTools({ mode: 'detach' })

  // AUTOTESTE (SW_SMOKE=1). Nao entra no app empacotado: so roda quando a variavel esta setada.
  // Existe porque as armadilhas deste projeto falham EM SILENCIO (ver src/smoke.js).
  // FOTO DAS TELAS (SW_FOTO=1), pra conferir o visual sem abrir na mao.
  if (process.env.SW_FOTO === '1') {
    const injeta = async (wc) => {
      try {
        const motor = await pegaMotor()
        if (motor) await wc.executeJavaScript(motor, true)
        await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
        await new Promise((r) => setTimeout(r, 1500))
      } catch (e) { console.error('[foto] injecao falhou: ' + ((e && e.message) || e)) }
    }
    casca.webContents.once('did-finish-load', () => {
      setTimeout(() => require('./foto').rodar({ casca, injeta }), 1200)
    })
  }

  if (process.env.SW_SMOKE === '1') {
    // As duas funcoes do caminho REAL do proxy vao junto, pro autoteste exercitar o mesmo
    // codigo que o app usa (incluindo a autenticacao pelo evento app.on('login')).
    // `injeta` deixa o autoteste exercitar o MESMO caminho de injecao que o app usa de verdade.
    const injeta = async (wc) => {
      const out = { wpp: false, agente: false, estado: null, wppErro: '', painelErro: '' }
      try {
        const motor = await pegaMotor()
        if (!motor) { out.wppErro = 'nao baixei o motor'; return out }
        await wc.executeJavaScript(motor, true)
        out.wpp = !!(await wc.executeJavaScript('typeof window.WPP !== "undefined"'))
      } catch (e) { out.wppErro = String((e && e.message) || e).slice(0, 110) }
      try {
        await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
        await new Promise((r) => setTimeout(r, 1200))
        out.agente = !!(await wc.executeJavaScript('typeof window.__swEstado === "function" && typeof window.__swManda === "function"'))
        out.estado = await wc.executeJavaScript('window.__swEstado ? window.__swEstado() : null')
      } catch (e) { out.painelErro = String((e && e.message) || e).slice(0, 110) }
      return out
    }
    const ctx = { cascaOk: false, cascaErro: '', temBarra: false, textoBarra: '', modal: '', aplicaProxy, testaSaida, particaoDe, injeta }
    casca.webContents.once('did-finish-load', async () => {
      ctx.cascaOk = true
      try {
        // A marca e a LOGO, nao texto: confere que a imagem carregou de verdade (naturalWidth > 0),
        // porque <img> quebrada tambem existe no DOM e passaria num teste de presenca.
        ctx.textoBarra = String(await casca.webContents.executeJavaScript(
          '(() => { const i = document.querySelector("aside .marca img"); return i ? (i.naturalWidth + "x" + i.naturalHeight) : "sem logo" })()'
        ) || '')
        ctx.temBarra = /^[1-9]\d*x[1-9]\d*$/.test(ctx.textoBarra)
        // AS JANELINHAS ABREM? E o tipo de quebra que nao aparece em teste de sintaxe: ja houve uma
        // versao em que abreModal chamava a si mesma e NENHUM dialogo do app abria.
        ctx.modal = await casca.webContents.executeJavaScript(`(async () => {
          try {
            document.getElementById('ajustes').click()
            await new Promise((r) => setTimeout(r, 250))
            const on = !!document.querySelector('.fundo-modal.on')
            const temTexto = (document.getElementById('modal-corpo') || {}).textContent || ''
            document.onkeydown({ key: 'Escape' })
            return on && temTexto.indexOf('Ajustes') >= 0 ? 'abriu' : ('nao abriu (on=' + on + ')')
          } catch (e) { return 'erro: ' + (e && e.message) }
        })()`).catch((e) => 'erro: ' + (e && e.message))
      } catch (e) { ctx.textoBarra = 'erro: ' + (e && e.message) }
      require('./smoke').rodar(ctx)
    })
    casca.webContents.once('did-fail-load', (_e, code, desc) => {
      ctx.cascaErro = desc + ' (' + code + ')'
      require('./smoke').rodar(ctx)
    })
    setTimeout(() => { if (!ctx.cascaOk && !ctx.cascaErro) { ctx.cascaErro = 'nao carregou em 20s'; require('./smoke').rodar(ctx) } }, 20000)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

process.on('uncaughtException', (e) => {
  console.error('[sellwave-web] erro nao tratado:', e)
  try { dialog.showErrorBox('Sellwave Web', String((e && e.message) || e)) } catch (_) { /* ok */ }
})
