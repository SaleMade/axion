// Sellwave Web - processo principal.
//
// O que este arquivo faz: abre uma janela com a casca da SellWave (barra lateral) e, pra cada
// numero de WhatsApp, cria uma WebContentsView COMPLETAMENTE isolada (particao propria, proxy
// proprio) carregando web.whatsapp.com.
//
// LEIA ANEXO-TECNICO.md ANTES DE MEXER. Quase toda linha estranha aqui existe por causa de uma
// armadilha medida em 15/10/2026, e o comentario diz qual.

const { app, BaseWindow, WebContentsView, session, ipcMain, shell, dialog } = require('electron')
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
const LARGURA_BARRA = 268              // barra lateral da casca
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

const CONFIG_PADRAO = {
  token: '',
  apiBase: 'https://axion-api.axion-dash.workers.dev',
  travaProxy: true,        // requisito duro do Bruno: sem proxy, nao abre
  exigirBrasil: false,     // segunda trava, opcional: so abre se o IP for BR
  proxies: {},             // { "<numkey>": { host, porta, usuario, senha } }
  numeros: [],             // cache da ultima lista vinda da dash
}

let config = { ...CONFIG_PADRAO }

function lerConfig() {
  try {
    const txt = fs.readFileSync(ARQ_CONFIG(), 'utf8')
    config = { ...CONFIG_PADRAO, ...JSON.parse(txt) }
  } catch (_) {
    config = { ...CONFIG_PADRAO }
  }
  return config
}

function gravarConfig() {
  try {
    fs.mkdirSync(path.dirname(ARQ_CONFIG()), { recursive: true })
    fs.writeFileSync(ARQ_CONFIG(), JSON.stringify(config, null, 2), 'utf8')
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

const credenciais = new Map()   // "host:porta" -> { usuario, senha }

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

async function aplicaProxy(ses, px) {
  if (!px) {
    // Sem proxy: deixa a sessao num buraco negro em vez de "direct". Assim, se alguma parte do
    // codigo esquecer de travar, a requisicao FALHA em vez de vazar o IP real.
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
    await ses.closeAllConnections()
    return
  }
  credenciais.set(px.host + ':' + px.porta, { usuario: px.usuario, senha: px.senha })
  // Regra UNICA e sem "=": vira PROXY_LIST e vale pra http, https, ws e wss. Com "scheme=" o que
  // ficou de fora sai DIRETO, que e o vazamento classico.
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://' + px.host + ':' + px.porta })
  // Sem isto o socket velho do pool continua saindo pelo IP anterior por minutos.
  await ses.closeAllConnections()
}

// Autenticacao do proxy. Vale pra navegacao de verdade (WebContents), que e o caminho que a gente
// usa. NAO vale pra net.fetch/ses.fetch: la o evento sai no proprio objeto, nao no app - foi por
// isso que o preflight abaixo e feito num WebContents escondido, e nao com ses.fetch.
app.on('login', (event, _wc, _det, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return
  const c = credenciais.get(authInfo.host + ':' + authInfo.port)
  if (!c || !c.usuario) return
  event.preventDefault()
  callback(c.usuario, c.senha)
})

// PREFLIGHT: confere, ANTES de carregar o WhatsApp, que a sessao realmente sai pelo proxy.
// Roda num WebContents escondido com a MESMA particao, porque e o unico jeito de a autenticacao
// do proxy funcionar. Devolve { ok, ip, pais, erro }.
function testaSaida(particao) {
  return new Promise((resolve) => {
    const view = new WebContentsView({
      webPreferences: { partition: particao, sandbox: true, javascript: true, images: false },
    })
    const wc = view.webContents
    let respondeu = false
    const acabou = (r) => {
      if (respondeu) return
      respondeu = true
      clearTimeout(relogio)
      try { wc.destroy() } catch (_) { /* ok */ }
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
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 6) Janela e views

let janela = null
let casca = null
const abertos = new Map()   // nk -> { view, nk, numero, carregado, ultimoUso }

function areaConteudo() {
  if (!janela) return { x: 0, y: 0, width: 0, height: 0 }
  const b = janela.getContentBounds()
  return { x: LARGURA_BARRA, y: ALTURA_TOPO, width: Math.max(0, b.width - LARGURA_BARRA), height: Math.max(0, b.height - ALTURA_TOPO) }
}

function reposiciona() {
  if (!janela) return
  const b = janela.getContentBounds()
  if (casca) casca.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  const area = areaConteudo()
  for (const s of abertos.values()) s.view.setBounds(area)
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
    callback(!!daCasa && PERMISSOES_OK.has(permissao))
  })
  ses.setPermissionCheckHandler((_wc, permissao, origem) => {
    return String(origem || '').startsWith(WA_ORIGEM) && PERMISSOES_OK.has(permissao)
  })
  return ses
}

// Abre (ou traz pra frente) a sessao de um numero. Faz o preflight do proxy ANTES de carregar o
// WhatsApp: se a trava estiver ligada e o proxy nao responder, a pagina nao chega a ser pedida.
async function abreNumero(numero) {
  const nk = numKey(numero)
  if (!nk) return { ok: false, erro: 'Numero invalido.' }

  if (abertos.has(nk)) {
    mostra(nk)
    return { ok: true, jaAberto: true }
  }

  avisaCasca('sw:status', { nk, texto: 'Buscando o proxy na dash...' })
  await puxaProxyDaDash(nk)
  const px = proxyDoNumero(nk)
  if (config.travaProxy && !px) {
    return { ok: false, erro: 'Este número não tem proxy cadastrado, e a trava está ligada. Cadastre o proxy em Ferramentas > Sellwave Web, na dash.' }
  }

  const ses = preparaSessao(nk)
  await aplicaProxy(ses, px)

  if (config.travaProxy && px) {
    avisaCasca('sw:status', { nk, texto: 'Conferindo o proxy...' })
    const teste = await testaSaida(particaoDe(nk))
    if (!teste.ok) {
      // Fail-closed: deixa a sessao no buraco negro, pra nada escapar depois.
      await aplicaProxy(ses, null)
      return { ok: false, erro: 'O proxy nao respondeu: ' + teste.erro }
    }
    if (config.exigirBrasil && teste.pais && teste.pais !== 'BR') {
      await aplicaProxy(ses, null)
      return { ok: false, erro: 'O proxy saiu por ' + teste.pais + ', e a exigencia de IP brasileiro esta ligada.' }
    }
    avisaCasca('sw:saida', { nk, ip: teste.ip, pais: teste.pais, cidade: teste.cidade, provedor: teste.provedor })
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: particaoDe(nk),
      preload: path.join(__dirname, 'preload-wa.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  })
  const s = { view, nk, numero, carregado: false, ultimoUso: Date.now() }
  abertos.set(nk, s)

  view.webContents.on('did-finish-load', () => {
    s.carregado = true
    avisaCasca('sw:aberto', { nk })
  })
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return                       // navegacao abortada, normal
    if (url && !String(url).startsWith(WA_URL)) return
    avisaCasca('sw:erro', { nk, erro: desc + ' (' + code + ')' })
  })

  janela.contentView.addChildView(view)
  view.setBounds(areaConteudo())
  view.webContents.loadURL(WA_URL)
  mostra(nk)
  return { ok: true }
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
  avisaCasca('sw:ativo', { nk })
}

function escondeTodos() {
  for (const s of abertos.values()) s.view.setVisible(false)
  avisaCasca('sw:ativo', { nk: '' })
}

function fechaNumero(nk) {
  const s = abertos.get(nk)
  if (!s) return
  try { janela.contentView.removeChildView(s.view) } catch (_) { /* ok */ }
  try { s.view.webContents.close() } catch (_) { /* ok */ }
  abertos.delete(nk)
  avisaCasca('sw:fechado', { nk })
}

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
  token: config.token ? '***' : '',
  temToken: !!config.token,
  apiBase: config.apiBase,
  travaProxy: config.travaProxy,
  exigirBrasil: config.exigirBrasil,
  numeros: config.numeros,
  proxies: config.proxies,
  abertos: [...abertos.keys()],
  versao: app.getVersion(),
  chromium: process.versions.chrome,
}))

ipcMain.handle('sw:entrar', async (_e, { token, apiBase }) => {
  config.token = String(token || '').trim()
  if (apiBase) config.apiBase = String(apiBase).trim()
  gravarConfig()
  return buscaNumeros()
})

ipcMain.handle('sw:sair', () => { config.token = ''; gravarConfig(); return { ok: true } })
ipcMain.handle('sw:numeros', () => buscaNumeros())
ipcMain.handle('sw:abrir', (_e, { numero }) => abreNumero(numero))
ipcMain.handle('sw:mostrar', (_e, { nk }) => { mostra(nk); return { ok: true } })
ipcMain.handle('sw:esconder', () => { escondeTodos(); return { ok: true } })
ipcMain.handle('sw:fechar', (_e, { nk }) => { fechaNumero(nk); return { ok: true } })

ipcMain.handle('sw:proxy-salvar', (_e, { nk, host, porta, usuario, senha }) => {
  if (!nk) return { ok: false, erro: 'Falta o numero.' }
  config.proxies = config.proxies || {}
  if (!host) delete config.proxies[nk]
  else config.proxies[nk] = { host: String(host).trim(), porta: Number(porta) || 0, usuario: usuario || '', senha: senha || '' }
  gravarConfig()
  return { ok: true }
})

ipcMain.handle('sw:proxy-testar', async (_e, { nk }) => {
  const px = proxyDoNumero(nk)
  if (!px) return { ok: false, erro: 'Sem proxy cadastrado pra este numero.' }
  const ses = preparaSessao(nk)
  await aplicaProxy(ses, px)
  const r = await testaSaida(particaoDe(nk))
  if (!abertos.has(nk)) await aplicaProxy(ses, null)   // nao deixa sessao parada com proxy ligado
  return r
})

ipcMain.handle('sw:trava', (_e, { travaProxy, exigirBrasil }) => {
  if (typeof travaProxy === 'boolean') config.travaProxy = travaProxy
  if (typeof exigirBrasil === 'boolean') config.exigirBrasil = exigirBrasil
  gravarConfig()
  return { ok: true, travaProxy: config.travaProxy, exigirBrasil: config.exigirBrasil }
})

ipcMain.handle('sw:recarregar', (_e, { nk }) => {
  const s = abertos.get(nk)
  if (s) s.view.webContents.reload()
  return { ok: true }
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 9) Ligar

app.whenReady().then(() => {
  lerConfig()

  // A sessao PADRAO tambem vai pro buraco negro. Assim, qualquer parte do app que esqueca de usar
  // a particao certa FALHA em vez de vazar o IP real da maquina.
  try {
    session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
  } catch (_) { /* ok */ }

  janela = new BaseWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 640,
    title: 'Sellwave Web',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
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
  reposiciona()

  janela.on('resize', reposiciona)
  janela.on('closed', () => { janela = null })

  if (process.argv.includes('--dev')) casca.webContents.openDevTools({ mode: 'detach' })

  // AUTOTESTE (SW_SMOKE=1). Nao entra no app empacotado: so roda quando a variavel esta setada.
  // Existe porque as armadilhas deste projeto falham EM SILENCIO (ver src/smoke.js).
  if (process.env.SW_SMOKE === '1') {
    const ctx = { cascaOk: false, cascaErro: '', temBarra: false, textoBarra: '' }
    casca.webContents.once('did-finish-load', async () => {
      ctx.cascaOk = true
      try {
        ctx.textoBarra = String(await casca.webContents.executeJavaScript(
          'document.querySelector("aside h1") && document.querySelector("aside h1").textContent'
        ) || '')
        ctx.temBarra = ctx.textoBarra.indexOf('Sellwave Web') >= 0
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
