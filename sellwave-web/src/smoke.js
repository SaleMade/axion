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
      return fim({ carregou: true, bloqueado: !!o.bloqueado, temQr: !!(o.qr || o.temRef), qr: o.qr, titulo: o.titulo, ws: viuWs, wc: wc })
    })
    const leitura = `(() => {
          const t = (document.body && document.body.innerText) || ''
          const c = document.querySelector('canvas[aria-label], canvas')
          return JSON.stringify({
            titulo: document.title || '',
            bloqueado: /Google Chrome 100|atualize o Chrome|update (to )?(the )?latest/i.test(t),
            qr: c ? (c.width + 'x' + c.height) : '',
            temRef: !!document.querySelector('[data-ref]'),
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

  // 2) Sessao padrao no buraco negro: qualquer esquecimento FALHA em vez de vazar o IP real.
  const padraoProxy = await session.defaultSession.resolveProxy('https://example.com')
  conta('a sessao padrao nao sai direto', !/DIRECT/i.test(String(padraoProxy)), String(padraoProxy))

  // 3) Particao de numero com proxy aplicado e SEM direct na lista (fail-closed de graca).
  const ses = session.fromPartition('persist:sw-teste-smoke')
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' })
  const r1 = await ses.resolveProxy(UA_WA)
  conta('proxy por particao aplica no https', /PROXY 127\.0\.0\.1:9/.test(String(r1)), String(r1))
  const r2 = await ses.resolveProxy('wss://web.whatsapp.com/ws/chat')
  conta('o MESMO proxy vale pro websocket', /PROXY 127\.0\.0\.1:9/.test(String(r2)), String(r2))
  conta('nao ha DIRECT de reserva na lista', !/DIRECT/i.test(String(r1)), String(r1))

  // 4) Credencial dentro do proxyRules tem que ser RECUSADA (medido: a regra e descartada e tudo
  //    morre em ERR_NO_SUPPORTED_PROXIES). O teste existe pra ninguem "consertar" isso um dia.
  const sesB = session.fromPartition('persist:sw-teste-smoke-b')
  await sesB.setProxy({ mode: 'fixed_servers', proxyRules: 'http://u:p@127.0.0.1:9' })
  const r3 = String(await sesB.resolveProxy(UA_WA))
  conta('credencial no proxyRules nao vira regra valida', r3.trim() === '' || !/127\.0\.0\.1:9/.test(r3), r3 || '(vazio)')

  // 5) WebRTC: a unica politica que nao vaza. Typo cai em 'default' EM SILENCIO.
  const view = new WebContentsView({ webPreferences: { partition: 'persist:sw-teste-smoke' } })
  const pol = view.webContents.getWebRTCIPHandlingPolicy()
  conta('politica de WebRTC nao vaza o IP', pol === 'disable_non_proxied_udp', pol)
  try { view.webContents.destroy() } catch (_) { /* ok */ }

  // 6) A casca sobe de verdade (HTML e JS sem erro de carregamento).
  conta('a casca carregou', ctx.cascaOk === true, ctx.cascaErro || '')
  conta('a casca desenhou a barra lateral', ctx.temBarra === true, ctx.textoBarra || '')

  // 7) O TESTE QUE IMPORTA: o WhatsApp Web abre de verdade e mostra o QR?
  //    Fica atras de SW_SMOKE_WA=1 porque precisa de internet e sai SEM proxy (so pra provar que o
  //    User-Agent passa no portao). Nao use isso como teste de rotina em maquina de vendedor.
  if (process.env.SW_SMOKE_WA === '1') {
    const r = await abreWhatsapp()
    conta('o WhatsApp Web carregou', r.carregou, r.erro || r.titulo || '')
    conta('NAO caiu na tela de navegador nao suportado', !r.bloqueado, r.bloqueado ? 'apareceu o aviso de Chrome desatualizado' : '')
    conta('o QR apareceu', r.temQr, r.temQr ? ('canvas ' + r.qr) : 'sem canvas de QR')
    conta('o websocket do WhatsApp abriu', r.ws, r.ws ? 'wss conectado' : 'nenhum wss://web.whatsapp.com visto')
    // O PAINEL: injeta motor + painel na MESMA pagina e confere que os dois subiram.
    if (r.carregou && ctx.injeta) {
      const p = await ctx.injeta(r.wc)
      conta('o motor do WhatsApp (WA-JS) carregou', !!p.wpp, p.wppErro || (p.wpp ? 'window.WPP presente' : ''))
      conta('o agente instalou na pagina', !!p.agente, p.painelErro || (p.agente ? '__swEstado e __swManda presentes' : ''))
      conta('o agente responde o estado', !!p.estado, p.estado ? JSON.stringify(p.estado).slice(0, 70) : 'sem resposta')
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
    await ctx.aplicaProxy(session.fromPartition(part), px)
    const r = await ctx.testaSaida(part)
    conta('o proxy responde e autentica', !!r.ok, r.ok ? (r.ip + ' · ' + r.pais + ' · ' + (r.cidade || '')) : r.erro)
    conta('o IP de saida e do Brasil', r.ok && r.pais === 'BR', r.pais || '')
    // E a trava: com o proxy errado, a sessao NAO pode cair pra conexao direta.
    await ctx.aplicaProxy(session.fromPartition(part), { host: '127.0.0.1', porta: 9, usuario: '', senha: '' })
    const ruim = await ctx.testaSaida(part)
    conta('proxy morto NAO vira conexao direta', !ruim.ok, ruim.ok ? ('VAZOU por ' + ruim.ip) : (ruim.erro || '').slice(0, 60))
    await ctx.aplicaProxy(session.fromPartition(part), null)
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
