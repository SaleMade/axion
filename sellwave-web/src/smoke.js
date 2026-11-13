// Autoteste do Sellwave Web. Roda com SW_SMOKE=1 e sai com codigo 1 se algo essencial quebrou.
//
// Por que existe: app de desktop nao da pra conferir lendo codigo, e a maioria das armadilhas
// deste projeto (User-Agent barrado, proxy que nao aplica, WebRTC vazando) falha EM SILENCIO.
// Rode isto antes de entregar qualquer versao:
//     SW_SMOKE=1 npx electron .

const { app, session, WebContentsView, BaseWindow } = require('electron')

const UA_WA = 'https://web.whatsapp.com'
const resultados = []

function conta(nome, passou, detalhe) {
  resultados.push({ nome, passou, detalhe: detalhe || '' })
  console.log((passou ? '  OK   ' : '  FALHA') + '  ' + nome + (detalhe ? '  ->  ' + detalhe : ''))
}

// Segura referencia das views do teste: sem isto o Electron coleta a view que nao esta anexada a
// nenhuma janela e o executeJavaScript morre com "Object has been destroyed".
const vivas = []

// Abre o WhatsApp Web numa particao descartavel, SEM proxy, e conta o que viu.
function abreWhatsapp() {
  return new Promise((resolve) => {
    const part = 'persist:sw-teste-wa'
    const ses = session.fromPartition(part)
    ses.setProxy({ mode: 'direct' })
    const janelinha = new BaseWindow({ width: 1100, height: 820, show: false })
    const view = new WebContentsView({ webPreferences: { partition: part } })
    janelinha.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1100, height: 820 })
    vivas.push(view, janelinha)
    const wc = view.webContents
    let viuWs = false
    try {
      ses.webRequest.onBeforeRequest({ urls: ['wss://web.whatsapp.com/*'] }, (_d, cb) => { viuWs = true; cb({}) })
    } catch (_) { /* ok */ }

    let pronto = false
    const fim = (r) => {
      if (pronto) return
      pronto = true
      clearTimeout(relogio)
      // NAO destroi a view aqui: o teste do painel injeta nela logo depois. Quem derruba tudo e o
      // app.exit no fim do autoteste.
      resolve(r)
    }
    const relogio = setTimeout(async () => {
      fim({ carregou: false, bloqueado: false, temQr: false, ws: viuWs, erro: 'nao carregou em 45s' })
    }, 45000)

    wc.once('did-fail-load', (_e, code, desc) => fim({ carregou: false, bloqueado: false, temQr: false, ws: viuWs, erro: desc + ' (' + code + ')' }))
    wc.once('did-finish-load', async () => {
      // O QR nao vem junto com o load: o app monta, abre o websocket e so entao desenha. Em vez de
      // esperar um tempo fixo, pergunta de 1 em 1 segundo por ate 30 segundos.
      let o = {}
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (pronto) return
        try {
          o = JSON.parse(String(await wc.executeJavaScript(leitura) || '{}'))
          if (o.qr || o.temRef || o.bloqueado) break
        } catch (e) {
          return fim({ carregou: true, bloqueado: false, temQr: false, ws: viuWs, erro: 'nao deu pra ler a pagina: ' + (e && e.message) })
        }
      }
      return fim({ carregou: true, bloqueado: !!o.bloqueado, temQr: !!(o.qr || o.temRef), qr: o.qr, titulo: o.titulo, ws: viuWs, wc: wc, temApp: !!o.temApp })
    })
    const leitura = `(() => {
          const t = (document.body && document.body.innerText) || ''
          const c = document.querySelector('canvas[aria-label], canvas')
          return JSON.stringify({
            titulo: document.title || '',
            bloqueado: /Google Chrome 100|atualize o Chrome|update (to )?(the )?latest/i.test(t),
            qr: c ? (c.width + 'x' + c.height) : '',
            temRef: !!document.querySelector('[data-ref]'),
            // a mesma conta da vigia da tela branca do main.js (JS_TEM_TELA): o #app tem que ter desenho
            temApp: (function(){var a=document.getElementById('app');return !!(a&&a.children.length&&(document.visibilityState==='hidden'||a.getBoundingClientRect().height>0))})(),
          })
        })()`
    wc.loadURL(UA_WA)
  })
}

async function rodar(ctx) {
  console.log('\n=== autoteste do Sellwave Web ===')
  console.log('electron ' + process.versions.electron + ' | chromium ' + process.versions.chrome + '\n')

  // 1) User-Agent limpo. Esta e a armadilha que mata o app no primeiro dia (ver ANEXO A2).
  const ua = app.userAgentFallback
  conta('o userAgent nao tem "Electron"', !/Electron/i.test(ua), ua.slice(0, 90))
  conta('o userAgent nao tem o nome do app', !/Sellwave/i.test(ua))
  const mChrome = ua.match(/Chrome\/(\d+)/)
  conta('o userAgent declara Chrome 100 ou mais', !!mChrome && Number(mChrome[1]) >= 100, mChrome ? ('Chrome/' + mChrome[1]) : 'sem Chrome no UA')
  // O SISTEMA DO UA E O DA MAQUINA (04/11/2026, versao de Mac): "Windows" no UA de quem roda num Mac
  // e a incoerencia que denuncia navegador montado (a pagina tambem le navigator.platform).
  const soDoUa = /Macintosh/.test(ua) ? 'darwin' : /Windows/.test(ua) ? 'win32' : '?'
  conta('o userAgent diz o sistema desta maquina', soDoUa === process.platform, soDoUa + ' no UA, ' + process.platform + ' na maquina')

  // 2) Sessao padrao no buraco negro: qualquer esquecimento FALHA em vez de vazar o IP real.
  const padraoProxy = await session.defaultSession.resolveProxy('https://example.com')
  conta('a sessao padrao nao sai direto', !/DIRECT/i.test(String(padraoProxy)), String(padraoProxy))

  // 3) Particao de numero com proxy aplicado e SEM direct na lista (fail-closed de graca).
  //    PELO CAMINHO DO APP (`aplicaProxy`), nao por um setProxy solto (04/11/2026): no Mac a primeira
  //    consulta logo depois do setProxy vinha DIRECT, e e o `aplicaProxy` que espera a regra valer
  //    antes de devolver. Testar o setProxy cru mediria o Chromium, nao o app.
  const ses = session.fromPartition('persist:sw-teste-smoke')
  const valeu = ctx.aplicaProxy
    ? await ctx.aplicaProxy(ses, { host: '127.0.0.1', porta: 9, usuario: '', senha: '' }, 'persist:sw-teste-smoke')
    : (await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }), null)
  if (ctx.aplicaProxy) conta('o app so segue com a regra do proxy valendo', valeu === true, String(valeu))
  if (ctx.aplicaProxy) {
    // proxy por NOME (os da operacao sao assim, ex. isp.decodo.com), com maiuscula de proposito: a
    // conferencia compara o texto do Chromium, e um erro de caixa ali recusaria TODO numero
    const sesN = session.fromPartition('persist:sw-teste-smoke-nome')
    const okN = await ctx.aplicaProxy(sesN, { host: 'Proxy.Exemplo.com.br', porta: 10001, usuario: '', senha: '' }, 'persist:sw-teste-smoke-nome')
    conta('proxy por nome tambem confirma', okN === true, String(await sesN.resolveProxy(UA_WA)))
    await ctx.aplicaProxy(sesN, null, 'persist:sw-teste-smoke-nome')
  }
  const r1 = await ses.resolveProxy(UA_WA)
  conta('proxy por particao aplica no https', /PROXY 127\.0\.0\.1:9/.test(String(r1)), String(r1))
  const r2 = await ses.resolveProxy('wss://web.whatsapp.com/ws/chat')
  conta('o MESMO proxy vale pro websocket', /PROXY 127\.0\.0\.1:9/.test(String(r2)), String(r2))
  conta('nao ha DIRECT de reserva na lista', !/DIRECT/i.test(String(r1)), String(r1))

  // 3b) A PRIMEIRA CARGA SAI PELO PROXY (04/11/2026, achado no primeiro autoteste no Mac). A prova
  //     de ponta a ponta do item 3: um proxy de mentira aqui dentro anota o que chega, e a carga sai
  //     logo depois do aplicaProxy, sem espera nenhuma. O endereco nao existe (.invalid): saindo
  //     direto, a carga morreria no DNS e o proxy de mentira nao veria nada.
  if (ctx.aplicaProxy) {
    const http = require('node:http')
    // so pra registro: o que o setProxy CRU responde na primeira consulta (no Mac veio DIRECT)
    const sesCru = session.fromPartition('persist:sw-teste-cru-' + Date.now())
    await sesCru.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' })
    console.log('  info   setProxy cru, primeira consulta: ' + String(await sesCru.resolveProxy(UA_WA)))
    const viu = []
    const srv = http.createServer((req, res) => { viu.push(req.method + ' ' + req.url); res.end('ok') })
    srv.on('connect', (req, sock) => { viu.push('CONNECT ' + req.url); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
    const part = 'persist:sw-teste-primeira-' + Date.now()
    const sesP = session.fromPartition(part)
    await ctx.aplicaProxy(sesP, { host: '127.0.0.1', porta: srv.address().port, usuario: '', senha: '' }, part)
    const v = new WebContentsView({ webPreferences: { partition: part } })
    vivas.push(v)
    await v.webContents.loadURL('http://sw-teste-vazamento.invalid/primeira').catch(() => {})
    await v.webContents.loadURL('https://sw-teste-vazamento.invalid/segura').catch(() => {})
    conta('a primeira carga depois de aplicar o proxy sai por ele', viu.some((x) => x.includes('sw-teste-vazamento.invalid/primeira')), viu.join(' | ') || 'o proxy nao viu nada')
    conta('e o https tambem (CONNECT no proxy)', viu.some((x) => x.startsWith('CONNECT sw-teste-vazamento.invalid:443')), viu.join(' | ') || 'o proxy nao viu nada')
    try { v.webContents.close() } catch (_) { /* ok */ }
    srv.close()
  }

  // 4) Credencial dentro do proxyRules tem que ser RECUSADA (medido: a regra e descartada e tudo
  //    morre em ERR_NO_SUPPORTED_PROXIES). O teste existe pra ninguem "consertar" isso um dia.
  const sesB = session.fromPartition('persist:sw-teste-smoke-b')
  await sesB.setProxy({ mode: 'fixed_servers', proxyRules: 'http://u:p@127.0.0.1:9' })
  const r3 = String(await sesB.resolveProxy(UA_WA))
  conta('credencial no proxyRules nao vira regra valida', r3.trim() === '' || !/127\.0\.0\.1:9/.test(r3), r3 || '(vazio)')

  // 5) WebRTC: a unica politica que nao vaza. Typo cai em 'default' EM SILENCIO.
  const view = new WebContentsView({ webPreferences: { partition: 'persist:sw-teste-smoke' } })
  const pol = view.webContents.getWebRTCIPHandlingPolicy()
  // A CONFERENCIA MUDOU DE LADO EM 16/10/2026, junto com a decisao do Bruno de ter ligacao de voz.
  // Ela continua existindo porque o valor ainda importa: `default` entregaria a topologia da rede
  // local junto, e um typo cai em silencio no padrao do Chromium.
  conta('politica de WebRTC permite ligacao sem expor a rede local', pol === 'default_public_interface_only', pol)
  try { view.webContents.destroy() } catch (_) { /* ok */ }

  // 6) A casca sobe de verdade (HTML e JS sem erro de carregamento).
  conta('a casca carregou', ctx.cascaOk === true, ctx.cascaErro || '')
  conta('a logo da SellWave carregou na barra', ctx.temBarra === true, ctx.textoBarra || '')
  conta('a janelinha de Ajustes abre', ctx.modal === 'abriu', ctx.modal || '')

  // 6b) O PAINEL SEM NUMERO ABERTO (13/11/2026). Pedido do Bruno: a direcao ve o painel (e a aba
  //     Automacoes) sem ter que abrir numero. So a direcao, e so nas telas que convivem com ele: a
  //     janelinha de Ajustes cobre a janela inteira e o painel, que e uma view por cima, sai da frente.
  if (ctx.painelSemNumero) {
    const r = await ctx.painelSemNumero()
    const j = r.erro || ''
    const d = (x) => JSON.stringify(x || null)
    conta('vendedor sem numero aberto continua sem painel', !!r.vendedor && r.vendedor.tem === false && r.vendedor.reserva === 22 && r.vendedor.classe === false && r.vendedor.visivel !== true, j || d(r.vendedor))
    conta('direcao sem numero aberto: o painel aparece na direita e a tela do meio recua', !!r.direcao && r.direcao.tem === true && r.direcao.reserva === 316 && r.direcao.visivel !== false
      && r.direcao.painelX === r.direcao.largura - 316 && r.direcao.classe === true && r.direcao.recuo === '348px', j || d(r.direcao))
    conta('com a janelinha de Ajustes aberta o painel sai da frente', !!r.modal && r.modal.tem === false && r.modal.visivel !== true && r.modal.classe === false, j || d(r.modal))
    conta('fechou a janelinha, o painel volta', !!r.fechou && r.fechou.tem === true && r.fechou.visivel !== false && r.fechou.classe === true, j || d(r.fechou))
    conta('o painel sem numero diz que nao ha numero aberto e mostra a aba Automacoes pra direcao', !!r.painel && /Nenhum número aberto/.test(r.painel.lead) && r.painel.rod === 'nenhum número aberto' && r.painel.auto === true && r.painel.fechar === 'none', j || d(r.painel))
    conta('sem conta nao ha painel', !!r.semConta && r.semConta.tem === false && r.semConta.classe === false, j || d(r.semConta))
  }

  // 7) O TESTE QUE IMPORTA: o WhatsApp Web abre de verdade e mostra o QR?
  //    Fica atras de SW_SMOKE_WA=1 porque precisa de internet e sai SEM proxy (so pra provar que o
  //    User-Agent passa no portao). Nao use isso como teste de rotina em maquina de vendedor.
  if (process.env.SW_SMOKE_WA === '1') {
    const r = await abreWhatsapp()
    conta('o WhatsApp Web carregou', r.carregou, r.erro || r.titulo || '')
    conta('NAO caiu na tela de navegador nao suportado', !r.bloqueado, r.bloqueado ? 'apareceu o aviso de Chrome desatualizado' : '')
    conta('o QR apareceu', r.temQr, r.temQr ? ('canvas ' + r.qr) : 'sem canvas de QR')
    conta('a vigia da tela branca enxerga a tela do WhatsApp (#app desenhado)', r.temApp === true, String(r.temApp))
    conta('o websocket do WhatsApp abriu', r.ws, r.ws ? 'wss conectado' : 'nenhum wss://web.whatsapp.com visto')
    // O PAINEL: injeta motor + painel na MESMA pagina e confere que os dois subiram.
    if (r.carregou && ctx.injeta) {
      const p = await ctx.injeta(r.wc)
      conta('o motor do WhatsApp (WA-JS) carregou', !!p.wpp, p.wppErro || (p.wpp ? 'window.WPP presente' : ''))
      conta('o agente instalou na pagina', !!p.agente, p.painelErro || (p.agente ? '__swEstado, __swManda e __swIndica presentes' : ''))
      conta('o agente responde o estado', !!p.estado, p.estado ? JSON.stringify(p.estado).slice(0, 70) : 'sem resposta')
      conta('o motor tem a lista de conversas e as mensagens que a varredura das nao lidas usa', p.varredura === true, String(p.varredura))
      // O TESTE QUE IMPEDE LEAD PAGO IR PRA NINGUEM. Na tela do QR o motor ja responde true, mas
      // ninguem pareou aparelho nenhum: se `autenticado` vier true aqui, o sinal de vida vai dizer
      // que o numero esta de pe e a roleta vai entregar lead pra uma sessao sem dono.
      conta('na tela do QR o agente NAO se diz autenticado',
        !!(p.estado && p.estado.motor) && !(p.estado && p.estado.autenticado),
        p.estado ? ('motor=' + p.estado.motor + ' autenticado=' + p.estado.autenticado) : '')
      conta('sem aparelho pareado o numero vem vazio', !(p.estado && p.estado.eu), (p.estado && p.estado.eu) || '(vazio)')
    }
  }

  // 8) O PROXY DE VERDADE. Roda com:
  //      SW_SMOKE=1 SW_SMOKE_PROXY="host:porta:usuario:senha" npx electron .
  //    Exercita o MESMO caminho do app: aplica na particao, autentica pelo evento app.on('login')
  //    e le o IP de saida num WebContents (nao em ses.fetch, que nao autentica em proxy).
  if (process.env.SW_SMOKE_PROXY && ctx.aplicaProxy) {
    const p = String(process.env.SW_SMOKE_PROXY).split(':')
    const px = { host: p[0], porta: Number(p[1]), usuario: p[2] || '', senha: p.slice(3).join(':') }
    const part = 'persist:sw-teste-proxy'
    await ctx.aplicaProxy(session.fromPartition(part), px, part)
    const r = await ctx.testaSaida(part)
    conta('o proxy responde e autentica', !!r.ok, r.ok ? (r.ip + ' · ' + r.pais + ' · ' + (r.cidade || '')) : r.erro)
    conta('o IP de saida e do Brasil', r.ok && r.pais === 'BR', r.pais || '')
    // E a trava: com o proxy errado, a sessao NAO pode cair pra conexao direta.
    await ctx.aplicaProxy(session.fromPartition(part), { host: '127.0.0.1', porta: 9, usuario: '', senha: '' }, part)
    const ruim = await ctx.testaSaida(part)
    conta('proxy morto NAO vira conexao direta', !ruim.ok, ruim.ok ? ('VAZOU por ' + ruim.ip) : (ruim.erro || '').slice(0, 60))
    await ctx.aplicaProxy(session.fromPartition(part), null, part)
  }

  const falhas = resultados.filter((r) => !r.passou)
  console.log('\n' + (resultados.length - falhas.length) + ' de ' + resultados.length + ' passaram.')
  if (falhas.length) {
    console.log('FALHARAM: ' + falhas.map((f) => f.nome).join(' | '))
    app.exit(1)
  } else {
    console.log('tudo certo.')
    app.exit(0)
  }
}

module.exports = { rodar }
