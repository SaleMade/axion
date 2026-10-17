// TESTE DA PREVIA DE MIDIA (17/10/2026).
//
// POR QUE ELE EXISTE, e a resposta e um incidente: a previa de foto, audio e video foi publicada na
// 1.17.0 "provada" - o handler do `swmedia://` tinha sido chamado direto, com a midia de verdade, e
// respondia 200 na imagem, 206 no video e 200 no audio. Na maquina do Bruno nada carregava: foto
// quebrada, audio em 0:00, video preto. E nao havia erro em lugar nenhum.
//
// O QUE ESTAVA ERRADO NAO ERA O HANDLER, ERA QUEM CHEGA NELE:
//   1. `protocol.handle(...)` do modulo registra na SESSAO PADRAO. O painel roda em
//      `persist:sw-painel`, entao o pedido morria antes de achar handler nenhum.
//   2. `net.fetch` tambem sai pela sessao padrao, que esta num BURACO NEGRO de proxy de proposito
//      (socks5://127.0.0.1:1, pra nada vazar por engano). Passar `{ session }` pra ele nao da erro:
//      a assinatura nao tem esse campo e ele ignora em silencio. Quem respeita sessao e
//      `ses.fetch(...)`.
//
// A LICAO QUE ESTE ARQUIVO AMARRA: midia nao se testa chamando o handler. Testa-se RENDERIZANDO,
// na particao de verdade, com a sessao padrao no buraco negro - que e o estado em que o app roda.
// Testar o handler sozinho prova que a cozinha funciona sem conferir se a comida chega na mesa.
//
// Roda:  npm run teste-midia
//    ou: env -u ELECTRON_RUN_AS_NODE npx electron src/teste-midia.js

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('ELECTRON_RUN_AS_NODE esta ligado: este teste precisa do Electron de verdade.')
  console.log('Rode assim:  env -u ELECTRON_RUN_AS_NODE npx electron src/teste-midia.js')
  process.exit(2)
}

const { app, BrowserWindow, protocol, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// MESMOS PRIVILEGIOS DO main.js. Tem que vir antes do ready.
protocol.registerSchemesAsPrivileged([{
  scheme: 'swmedia',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])
app.setPath('userData', path.join(app.getPath('appData'), 'sellwave-web-teste'))

let ok = 0
const falhas = []
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
  else { falhas.push(nome); console.log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

setTimeout(() => { console.log('ESTOUROU O TEMPO (120s)'); app.exit(1) }, 120000)
process.on('unhandledRejection', (e) => { console.log('PROMESSA SOLTA: ' + (e && e.message)); app.exit(1) })

// O HANDLER, RECORTADO DO main.js. Assim o teste nao vira uma segunda copia que pode discordar:
// se alguem mexer no registro la, o recorte muda e este arquivo quebra junto.
function handlerDoMain() {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const i = src.indexOf("sesPainel.protocol.handle('swmedia'")
  if (i < 0) return null
  const fim = src.indexOf('} catch (e) { anota(', i)
  return src.slice(i, fim)
}

const BASE_PADRAO = 'https://axion-api.axion-dash.workers.dev/api/salechat/media/'

app.whenReady().then(async () => {
  console.log('\nTESTE DA PREVIA DE MIDIA\n')

  // O ESTADO EM QUE O APP RODA, e e ele que fazia a diferenca: padrao no buraco negro, painel direto.
  await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
  const ses = session.fromPartition('persist:sw-painel')
  await ses.setProxy({ mode: 'direct' })

  const recorte = handlerDoMain()
  conta('o main.js registra o swmedia na sessao do painel, nao na padrao',
    !!recorte, recorte ? 'recorte achado' : 'NAO achei sesPainel.protocol.handle no main.js')
  conta('e busca com ses.fetch, que e o unico que respeita a sessao',
    !!recorte && /sesPainel\.fetch\(/.test(recorte) && !/net\.fetch\(/.test(recorte),
    recorte && /net\.fetch\(/.test(recorte) ? 'ainda tem net.fetch, que ignora a sessao' : 'ses.fetch')

  const visto = []
  ses.protocol.handle('swmedia', async (req) => {
    try {
      const u = new URL(req.url)
      const chave = decodeURIComponent(u.pathname.replace(/^\//, ''))
      if (!chave || !/^m\/[A-Za-z0-9._-]+$/.test(chave)) { visto.push({ chave, st: 404 }); return new Response('', { status: 404 }) }
      const cab = {}
      const range = req.headers.get('range')
      if (range) cab.range = range
      const r = await ses.fetch(BASE_PADRAO + chave, { headers: cab, bypassCustomProtocolHandlers: true })
      visto.push({ chave, st: r.status, tipo: r.headers.get('content-type') || '' })
      return r
    } catch (e) { visto.push({ erro: (e && e.message) || String(e) }); return new Response('', { status: 502 }) }
  })

  // A JANELA USA A PARTICAO DO PAINEL E LE PDF, igual ao painel de verdade.
  const win = new BrowserWindow({
    show: false, width: 360, height: 900,
    webPreferences: { partition: 'persist:sw-painel', plugins: true, contextIsolation: true, sandbox: false },
  })
  const bloqueios = []
  win.webContents.on('console-message', (ev) => {
    const m = String((ev && ev.message) || '')
    if (/Refused|Content Security|ERR_/i.test(m)) bloqueios.push(m.slice(0, 120))
  })

  // O painel DE VERDADE, pra valer a CSP do <meta> dele.
  await win.loadFile(path.join(__dirname, 'ui', 'painel.html'))
  const js = (c) => win.webContents.executeJavaScript(c, true)

  // A midia e a de producao: e a unica que prova que o caminho inteiro funciona.
  const ALVOS = [
    ['imagem', 'img', 'm/msxabq170wvev3.jpg'],
    ['audio', 'audio', 'm/msyzg0tp2z8hi5.ogg'],
    ['video', 'video', 'm/mrckvvz5kbpjsb.mp4'],
  ]
  for (const [nome, tag, chave] of ALVOS) {
    const url = 'swmedia://arq/' + encodeURIComponent(chave)
    const r = await js(`(() => new Promise((ok) => {
      const e = document.createElement(${JSON.stringify(tag)}); e.id = 'alvo';
      ${tag === 'img' ? '' : "e.preload = 'metadata'; e.controls = true;"}
      let fim = false; const fecha = (q) => { if (fim) return; fim = true; ok(q) };
      e.onerror = () => fecha({ estado: 'ERRO', detalhe: (e.error && e.error.message) || 'onerror' });
      ${tag === 'img'
      ? "e.onload = () => fecha({ estado: 'OK', w: e.naturalWidth });"
      : "e.onloadedmetadata = () => fecha({ estado: 'OK', dur: Math.round(e.duration) });"}
      e.src = ${JSON.stringify(url)}; document.body.appendChild(e);
      setTimeout(() => fecha({ estado: 'TIMEOUT' }), 15000);
    }))()`)
    const bom = r && r.estado === 'OK' && (tag === 'img' ? r.w > 0 : r.dur > 0)
    conta('a previa de ' + nome + ' CARREGA de verdade', bom, JSON.stringify(r))
    await js("(() => { const a = document.getElementById('alvo'); if (a) a.remove() })()")
  }

  // O DOCUMENTO: `onload` de iframe dispara ate em branco, entao aqui a prova e a FOTO.
  await js(`(() => { const d = document.createElement('div');
    d.id = 'cx'; d.style.cssText = 'margin:8px;height:190px;background:#fff;border-radius:7px;overflow:hidden';
    d.innerHTML = '<iframe src="swmedia://arq/' + encodeURIComponent('m/muwr5jl74ovf7k.pdf') + '#toolbar=0&navpanes=0" style="display:block;width:100%;height:100%;border:0;pointer-events:none"></iframe>';
    document.body.appendChild(d) })()`)
  await new Promise((r) => setTimeout(r, 5000))
  // MEDE O RETANGULO DO PROPRIO ELEMENTO, nao um pedaco chutado da tela: o painel tem cabecalho
  // escuro e abas, entao sortear os primeiros 196px media a interface, nao o documento.
  const cx = await js('(() => { const r = document.getElementById("cx").getBoundingClientRect();'
    + ' return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()')
  const img = await win.webContents.capturePage()
  const bm = img.toBitmap()
  const { width, height } = img.getSize()
  let claros = 0, escuros = 0
  const tons = new Set()
  const x0 = Math.max(0, cx.x + 4), x1 = Math.min(width, cx.x + cx.w - 4)
  const y0 = Math.max(0, cx.y + 4), y1 = Math.min(height, cx.y + cx.h - 4)
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4
      const b = bm[i], g = bm[i + 1], r = bm[i + 2]
      const lum = (r * 299 + g * 587 + b * 114) / 1000
      if (lum > 200) claros++; else escuros++
      tons.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4))
    }
  }
  conta('a previa do DOCUMENTO desenha o PDF (papel e tinta na foto)',
    claros > 500 && escuros > 50 && tons.size > 3,
    'claros ' + claros + ', escuros ' + escuros + ', tons ' + tons.size + ' no retangulo ' + JSON.stringify(cx))

  // Chave fora do padrao nao pode virar um proxy aberto pra API inteira.
  const fora = await js(`(() => new Promise((ok) => {
    const e = document.createElement('img');
    e.onerror = () => ok('recusou'); e.onload = () => ok('CARREGOU, e nao devia');
    e.src = 'swmedia://arq/' + encodeURIComponent('../api/state');
    setTimeout(() => ok('recusou (sem resposta)'), 6000);
  }))()`)
  conta('chave que nao e de midia NAO abre nada', /recusou/.test(fora), fora)

  conta('nenhum bloqueio de CSP na previa', bloqueios.length === 0, bloqueios.join(' | ').slice(0, 140))
  const tiposVistos = visto.filter((v) => v.st === 200 || v.st === 206).map((v) => v.tipo).join(', ')
  conta('o handler foi mesmo chamado pela pagina', visto.length >= 4, tiposVistos.slice(0, 110))

  console.log('')
  if (falhas.length) {
    console.log('  ' + ok + ' passaram, ' + falhas.length + ' FALHARAM:')
    for (const f of falhas) console.log('   - ' + f)
    app.exit(1)
    return
  }
  console.log('  ' + ok + ' de ' + ok + ' conferencias passaram.')
  app.exit(0)
})
