// GERA O ICONE DO MAC (build/icon-mac.png, 1024x1024) - 04/11/2026, versao de Mac do app.
//
// E o mesmo desenho do icone do Windows (src/icone.js, variante "verde": onda branca sobre o
// quadrado verde da marca), em duas coisas diferentes:
//   1. O TAMANHO E A MOLDURA DO MAC. Icone de Mac e uma tela de 1024 com o quadrado de 824 no meio,
//      cantos de 185 e sombra embaixo (a grade da Apple desde o Big Sur). O icone do Windows ocupa
//      a tela inteira; no Dock ele ficaria maior que todos os outros e sem sombra.
//   2. A ONDA VEM DE UM ARQUIVO MAIOR. O `ui/img/icone.png` tem 256 px, e a onda ocupa so o meio
//      dele: ampliada pra 1024 ela borra. Aqui a fonte e o `build/marca-512.png` (o icone de 512 da
//      dash, a mesma onda sobre fundo preto), e o fundo preto vira transparencia pela claridade de
//      cada pixel - a onda e clara, o fundo e quase preto.
//
// O electron-builder transforma este PNG no .icns na hora de empacotar (precisa de 512 ou mais).
//
// Uso:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/icone-mac.js
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const SAIDA = path.join(__dirname, '..', 'build', 'icon-mac.png')
const MARCA = path.join(__dirname, '..', 'build', 'marca-512.png')

const COMPOE = (arquivo) => `(async () => {
  const img = new Image()
  await new Promise((ok, erro) => { img.onload = ok; img.onerror = () => erro(new Error('nao carreguei a marca')); img.src = ${JSON.stringify(arquivo)} })

  // 1. A ONDA EM BRANCO, com a transparencia tirada da claridade (o fundo da marca e preto).
  const m = document.createElement('canvas')
  m.width = img.width; m.height = img.height
  const mg = m.getContext('2d')
  mg.drawImage(img, 0, 0)
  const d = mg.getImageData(0, 0, m.width, m.height)
  const px = d.data
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1
  for (let i = 0; i < px.length; i += 4) {
    const luz = Math.max(px[i], px[i + 1], px[i + 2])
    const a = Math.max(0, Math.min(1, (luz - 40) / 70))
    px[i] = px[i + 1] = px[i + 2] = 255
    px[i + 3] = Math.round(a * 255)
    if (a > 0.05) {
      const p = i / 4, x = p % m.width, y = Math.floor(p / m.width)
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('a marca esta vazia')
  mg.putImageData(d, 0, 0)
  const mw = x1 - x0 + 1, mh = y1 - y0 + 1

  const canto = (g, x, y, w, h, r) => {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }

  const L = 1024, Q = 824, O = (L - Q) / 2, R = 185
  const c = document.createElement('canvas')
  c.width = c.height = L
  const g = c.getContext('2d')
  g.imageSmoothingQuality = 'high'

  // 2. O QUADRADO, com a sombra da grade da Apple embaixo.
  g.save()
  g.shadowColor = 'rgba(0,0,0,.30)'
  g.shadowBlur = 24
  g.shadowOffsetY = 10
  canto(g, O, O, Q, Q, R)
  const grad = g.createLinearGradient(O, O, O + Q, O + Q)
  grad.addColorStop(0, '#34d89b'); grad.addColorStop(1, '#13a05c')
  g.fillStyle = grad
  g.fill()
  g.restore()

  // o mesmo brilho de leve do icone do Windows
  g.save()
  canto(g, O, O, Q, Q, R)
  g.clip()
  const luz = g.createLinearGradient(0, O, 0, O + Q)
  luz.addColorStop(0, 'rgba(255,255,255,.18)')
  luz.addColorStop(0.55, 'rgba(255,255,255,0)')
  g.fillStyle = luz
  g.fillRect(O, O, Q, Q)
  g.restore()

  // 3. A ONDA, centralizada, 74 por cento da largura do quadrado (a mesma conta do Windows).
  const alvoW = Q * 0.74
  const esc = alvoW / mw
  const alvoH = mh * esc
  g.shadowColor = 'rgba(0,0,0,.28)'
  g.shadowBlur = Q * 0.05
  g.shadowOffsetY = Q * 0.02
  g.drawImage(m, x0, y0, mw, mh, O + (Q - alvoW) / 2, O + (Q - alvoH) / 2, alvoW, alvoH)
  return c.toDataURL('image/png')
})()`

app.whenReady().then(async () => {
  try {
    const url = 'data:image/png;base64,' + fs.readFileSync(MARCA).toString('base64')
    const j = new BrowserWindow({ show: false, width: 400, height: 400 })
    await j.loadURL('data:text/html,<meta charset="utf-8"><body style="margin:0;background:#000"></body>')
    const dados = await j.webContents.executeJavaScript(COMPOE(url))
    const buf = Buffer.from(String(dados).split(',')[1], 'base64')
    fs.writeFileSync(SAIDA, buf)
    console.log('build/icon-mac.png  ' + buf.length + ' bytes')
    app.exit(0)
  } catch (e) {
    console.log('ESTOUROU: ' + ((e && e.stack) || e))
    app.exit(1)
  }
})
