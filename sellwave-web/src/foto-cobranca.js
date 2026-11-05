// FOTOS DA VERSAO DE COBRADOR (31/10/2026). "Ficou bom?" nao se responde lendo CSS: tira foto da
// agenda, do quadro de pedidos com a ficha aberta e do painel com a ficha, com os dados de mentira
// dos testes (teste-casca-preload.js e teste-painel-preload.js).
//
//   env -u ELECTRON_RUN_AS_NODE npx electron src/foto-cobranca.js <pasta de saida>
const { app, BrowserWindow, session } = require('electron')
const path = require('path')
const fs = require('fs')

const SAIDA = process.argv[process.argv.length - 1] && !/foto-cobranca\.js$/.test(process.argv[process.argv.length - 1])
  ? process.argv[process.argv.length - 1] : path.join(__dirname, '..', 'fotos-cobranca')
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
setTimeout(() => { console.log('estourou o tempo'); app.exit(1) }, 90000)

app.whenReady().then(async () => {
  fs.mkdirSync(SAIDA, { recursive: true })
  session.defaultSession.protocol.handle('swmedia', () => new Response('', { status: 404 }))
  const foto = async (win, nome) => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), img.toPNG())
    console.log('foto: ' + path.join(SAIDA, nome + '.png'))
  }
  // a casca do cobrador
  const w = new BrowserWindow({ show: false, width: 1440, height: 860, webPreferences: { preload: path.join(__dirname, 'teste-casca-preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } })
  await w.loadFile(path.join(__dirname, 'ui/index.html'))
  const js = (c) => w.webContents.executeJavaScript(c, true)
  await espera(800)
  await js('(async () => { window.__poeCobranca(true); await recarregaEstado(); telaVazia() })()')
  await espera(1500)
  await foto(w, '1-cobrador-inicio')
  await js('window.__swCob.abre("agenda")')
  await espera(700)
  await foto(w, '2-agenda')
  await js('window.__swCob.abre("cal")')
  await espera(600)
  await foto(w, '2b-calendario')
  await js('window.__swCob.abre("kanban")')
  await espera(500)
  await foto(w, '3-pedidos')
  await js('window.__swCob.abreFicha("9001")')
  await espera(700)
  await foto(w, '4-ficha-no-quadro')
  // o painel com a ficha
  const p = new BrowserWindow({ show: false, width: 340, height: 1000, webPreferences: { preload: path.join(__dirname, 'teste-painel-preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } })
  await p.loadFile(path.join(__dirname, 'ui/painel.html'))
  await espera(600)
  await p.webContents.executeJavaScript('window.__poeCobranca(true)', true)
  await espera(4000)
  console.log('aba: ' + await p.webContents.executeJavaScript('[...document.querySelectorAll(".aba")].map(b => b.dataset.aba + (b.classList.contains("on") ? "*" : "")).join(" ")', true))
  await foto(p, '5-painel-ficha')
  app.exit(0)
})
