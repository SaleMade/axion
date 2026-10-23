// A BARRA E O PAINEL NAO TEM ZOOM (23/10/2026, o Guilherme apertou Ctrl e girou o mouse com o foco na
// barra, e ela encolheu e ficou gravada assim mesmo depois de reinstalar).
//
// Recorta o `travaZoom` DO PROPRIO main.js e aplica numa janela de verdade com a barra (index.html):
// zoom gravado de antes volta pra 100% ao carregar, o atalho Ctrl+menos e ignorado, e qualquer mudanca
// por outro caminho volta sozinha.
//
// Uso:  env -u ELECTRON_RUN_AS_NODE npx electron src/teste-zoom.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
app.setPath('userData', path.join(app.getPath('appData'), 'sellwave-web-teste'))
let ok = 0, ruim = 0
const conta = (nome, bom, det) => { if (bom) { ok++; console.log('  ok   ' + nome) } else { ruim++; console.log('  RUIM ' + nome + (det ? '  ->  ' + det : '')) } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
setTimeout(() => { console.log('ESTOUROU O TEMPO'); app.exit(1) }, 60000)

app.whenReady().then(async () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const i = fonte.indexOf('function travaZoom(wc)')
  let n = 0, fim = -1
  for (let k = fonte.indexOf('{', i); k < fonte.length; k++) { if (fonte[k] === '{') n++; else if (fonte[k] === '}') { n--; if (!n) { fim = k + 1; break } } }
  const travaZoom = new Function(fonte.slice(i, fim) + '\nreturn travaZoom')()
  conta('o main.js tem o travaZoom', typeof travaZoom === 'function')

  const w = new BrowserWindow({ show: false, width: 300, height: 700, webPreferences: { partition: 'teste-zoom-barra' } })
  // o zoom que ficou GRAVADO: o Chromium guarda por endereco, e o da barra e o mesmo arquivo sempre
  await w.loadURL('data:text/html,<meta charset="utf-8"><body>barra</body>')
  w.webContents.setZoomFactor(0.5)
  await espera(200)
  conta('(montagem) a barra comeca com o zoom pequeno que ficou gravado', Math.abs(w.webContents.getZoomFactor() - 0.5) < 0.01, String(w.webContents.getZoomFactor()))
  travaZoom(w.webContents)
  await espera(200)
  conta('ao ligar a trava, a barra volta pra 100%', Math.abs(w.webContents.getZoomFactor() - 1) < 0.01, String(w.webContents.getZoomFactor()))
  w.webContents.setZoomFactor(0.6)
  await w.loadURL('data:text/html,<meta charset="utf-8"><body>barra de novo</body>')
  await espera(300)
  conta('e cada vez que a pagina da barra carrega, 100% de novo', Math.abs(w.webContents.getZoomFactor() - 1) < 0.01, String(w.webContents.getZoomFactor()))
  w.webContents.focus()
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: '-', modifiers: ['control'] })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: '-', modifiers: ['control'] })
  await espera(400)
  conta('Ctrl e menos na barra nao diminui nada', Math.abs(w.webContents.getZoomFactor() - 1) < 0.01, String(w.webContents.getZoomFactor()))
  w.webContents.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: -240, modifiers: ['control'], canScroll: true })
  await espera(400)
  conta('nem Ctrl girando o mouse', Math.abs(w.webContents.getZoomFactor() - 1) < 0.01, String(w.webContents.getZoomFactor()))
  const usos = (fonte.match(/travaZoom\((casca|painel|d\.painel)\.webContents\)/g) || []).length
  conta('a barra, o painel e o painel da janela destacada usam a trava', usos === 3, String(usos))
  conta('a pagina do WhatsApp NAO tem a trava (o zoom dela e do vendedor)', !/travaZoom\(view\.webContents\)/.test(fonte))
  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  app.exit(ruim ? 1 : 0)
})
