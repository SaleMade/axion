// GERA O ICONE do aplicativo, do instalador e do atalho, a partir da marca da SellWave.
//
// POR QUE EXISTE (17/10/2026). O Bruno baixou o instalador e reclamou: "ele vem com esse icone feio,
// acho que colocar um icone da minha empresa ou fazer um icone personalizado so para esse aplicativo
// ficaria bem legal". O `package.json` nao tinha icone nenhum configurado, entao o electron-builder
// usava o padrao do Electron (o globo azul).
//
// POR QUE NAO DA PRA USAR O `img/icone.png` DIRETO: ele e a onda da marca com MUITA margem
// transparente em volta (a onda ocupa so a faixa do meio dos 256x256). Icone de Windows e lido a
// 16 pixels na barra de tarefas; aquela onda fininha, transparente e clara vira um borrao cinza no
// escuro. Icone bom a 16px e FORMA CHEIA e CONTRASTE: aqui, a onda BRANCA sobre o quadrado verde da
// marca, que e o que o olho reconhece de longe e o que o Windows 11 espera (cantos arredondados).
//
// COMO: a composicao e feita num canvas de verdade, numa janela escondida, porque o `nativeImage`
// do Electron redimensiona e recorta mas NAO compoe (nao da pra desenhar uma coisa por cima da
// outra). O canvas calcula pixel mesmo com a janela escondida - quem nao funciona escondido e o
// `capturePage`, que e outra coisa. Depois os PNGs viram um .ico de verdade, montado aqui na mao.
//
// Uso:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/icone.js
//   (ou `npm run icone`)
//
// Sai em build/: icon.ico (o que o electron-builder usa), mais um PNG por tamanho e um contato das
// variantes, pra dar pra OLHAR antes de empacotar. "Ficou bom?" nao se responde lendo codigo.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const SAIDA = path.join(__dirname, '..', 'build')
const MARCA = path.join(__dirname, 'ui', 'img', 'icone.png')

// OS TAMANHOS QUE O WINDOWS PEDE. 16 e a barra de tarefas e a lista de arquivos; 32 e o atalho na
// area de trabalho; 48 e o modo "icones medios" do Explorer; 256 e o modo "icones extra grandes" e
// o que o instalador NSIS mostra. Sem o 16 dentro do .ico, o Windows encolhe o 256 na marra e o
// resultado fica borrado - que e metade do motivo de icone de app parecer amador.
const TAMANHOS = [16, 24, 32, 48, 64, 128, 256]

// ── a composicao, que roda dentro da janela ────────────────────────────────────────────────
// Devolve um data URL por tamanho. `variante` escolhe o tratamento; as tres existem pra dar pra
// comparar olhando, em vez de eu decidir no escuro.
// A MARCA ENTRA COMO data: URL, nao como caminho de arquivo, e isso e obrigatorio por DOIS motivos
// que so aparecem quando se tenta: (1) a pagina e uma data: URL, que tem origem opaca e nao consegue
// buscar file:// nenhum - foi o erro que apareceu na primeira tentativa, e ele chega como um Event,
// ou seja "[object Object]", sem mensagem; (2) mesmo numa pagina file://, desenhar uma imagem
// file:// SUJA o canvas pra leitura, e o `getImageData` que acha a onda dentro do PNG passa a
// estourar SecurityError. Imagem em data: nao suja.
const COMPOE = (arquivo, tamanhos, variante) => `(async () => {
  const img = new Image()
  await new Promise((ok, erro) => {
    img.onload = ok
    img.onerror = () => erro(new Error('nao carreguei a marca'))
    img.src = ${JSON.stringify(arquivo)}
  })

  // 1. ACHA A ONDA DENTRO DO PNG. A marca vem com margem transparente de sobra; usar o arquivo
  //    inteiro deixaria o desenho pequeno no meio do quadrado. Entao: varre os pixels, acha o
  //    retangulo do que NAO e transparente, e e com ele que a gente trabalha.
  const m = document.createElement('canvas')
  m.width = img.width; m.height = img.height
  const mg = m.getContext('2d')
  mg.drawImage(img, 0, 0)
  const px = mg.getImageData(0, 0, m.width, m.height).data
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (px[(y * m.width + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) throw new Error('a marca esta vazia')
  const mw = x1 - x0 + 1, mh = y1 - y0 + 1

  // 2. A ONDA EM BRANCO CHAPADO. A onda original e um gradiente claro de azul pra verde: por cima
  //    do quadrado verde ela sumiria. 'source-in' pinta so onde ja ha desenho, entao isto troca a
  //    cor da onda sem tocar no formato dela.
  const b = document.createElement('canvas')
  b.width = mw; b.height = mh
  const bg = b.getContext('2d')
  bg.drawImage(img, x0, y0, mw, mh, 0, 0, mw, mh)
  bg.globalCompositeOperation = 'source-in'
  bg.fillStyle = '#ffffff'
  bg.fillRect(0, 0, mw, mh)

  const canto = (g, x, y, w, h, r) => {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }

  const fora = []
  for (const lado of ${JSON.stringify(tamanhos)}) {
    const c = document.createElement('canvas')
    c.width = c.height = lado
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'

    // 3. O FUNDO. Raio de 22 por cento, que e a proporcao dos icones do Windows 11.
    const r = Math.max(2, Math.round(lado * 0.22))
    canto(g, 0, 0, lado, lado, r)
    const grad = g.createLinearGradient(0, 0, lado, lado)
    if (${JSON.stringify(variante)} === 'verde') {
      grad.addColorStop(0, '#34d89b'); grad.addColorStop(1, '#13a05c')
    } else if (${JSON.stringify(variante)} === 'onda') {
      grad.addColorStop(0, '#5ec8c0'); grad.addColorStop(1, '#2f9d8f')
    } else {
      grad.addColorStop(0, '#1d2433'); grad.addColorStop(1, '#0b0e14')
    }
    g.fillStyle = grad
    g.fill()

    // Um brilho de cima pra baixo, de leve: sem ele o quadrado fica chapado demais e parece
    // adesivo. Vai DENTRO do recorte, senao vaza pelos cantos.
    g.save()
    canto(g, 0, 0, lado, lado, r)
    g.clip()
    const luz = g.createLinearGradient(0, 0, 0, lado)
    luz.addColorStop(0, 'rgba(255,255,255,.18)')
    luz.addColorStop(0.55, 'rgba(255,255,255,0)')
    g.fillStyle = luz
    g.fillRect(0, 0, lado, lado)
    g.restore()

    // 4. A ONDA POR CIMA, centralizada, ocupando 74 por cento da largura. Mais que isso ela encosta
    //    no canto arredondado; menos, ela some no quadrado.
    const alvoW = lado * 0.74
    const esc = alvoW / mw
    const alvoH = mh * esc
    const dx = (lado - alvoW) / 2
    const dy = (lado - alvoH) / 2
    const fonte = ${JSON.stringify(variante)} === 'escuro' ? m : b
    const fx = ${JSON.stringify(variante)} === 'escuro' ? x0 : 0
    const fy = ${JSON.stringify(variante)} === 'escuro' ? y0 : 0
    // SOMBRA SO NOS TAMANHOS GRANDES: a 16px ela vira sujeira cinza em volta do desenho.
    if (lado >= 48) {
      g.shadowColor = 'rgba(0,0,0,.28)'
      g.shadowBlur = lado * 0.05
      g.shadowOffsetY = lado * 0.02
    }
    g.drawImage(fonte, fx, fy, mw, mh, dx, dy, alvoW, alvoH)
    g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0

    fora.push({ lado, dados: c.toDataURL('image/png') })
  }
  return fora
})()`

// ── o .ico, montado na mao ──────────────────────────────────────────────────────────────────
// Formato: ICONDIR de 6 bytes, um ICONDIRENTRY de 16 bytes por imagem, e dai os dados. Cada imagem
// vai como PNG dentro do .ico, que o Windows le desde o Vista. Largura e altura de 256 se escrevem
// como ZERO no cabecalho: o campo tem 1 byte so, e 256 nao cabe nele.
function montaIco(imagens) {
  const n = imagens.length
  const cab = Buffer.alloc(6 + 16 * n)
  cab.writeUInt16LE(0, 0)      // reservado
  cab.writeUInt16LE(1, 2)      // tipo 1 = icone
  cab.writeUInt16LE(n, 4)
  let desloc = 6 + 16 * n
  imagens.forEach((im, i) => {
    const e = 6 + 16 * i
    cab.writeUInt8(im.lado >= 256 ? 0 : im.lado, e)
    cab.writeUInt8(im.lado >= 256 ? 0 : im.lado, e + 1)
    cab.writeUInt8(0, e + 2)             // cores da paleta: 0 = sem paleta
    cab.writeUInt8(0, e + 3)             // reservado
    cab.writeUInt16LE(1, e + 4)          // planos de cor
    cab.writeUInt16LE(32, e + 6)         // bits por pixel
    cab.writeUInt32LE(im.buf.length, e + 8)
    cab.writeUInt32LE(desloc, e + 12)
    desloc += im.buf.length
  })
  return Buffer.concat([cab, ...imagens.map((im) => im.buf)])
}

const bytes = (dataUrl) => Buffer.from(String(dataUrl).split(',')[1], 'base64')

async function rodar() {
  fs.mkdirSync(SAIDA, { recursive: true })
  const url = 'data:image/png;base64,' + fs.readFileSync(MARCA).toString('base64')

  const j = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: false } })
  await j.loadURL('data:text/html,<meta charset="utf-8"><body style="margin:0;background:#000"></body>')

  // AS TRES VARIANTES, pra comparar olhando em vez de decidir no escuro.
  const variantes = ['verde', 'onda', 'escuro']
  const feitas = {}
  for (const v of variantes) {
    const lista = await j.webContents.executeJavaScript(COMPOE(url, TAMANHOS, v))
    feitas[v] = lista.map((x) => ({ lado: x.lado, buf: bytes(x.dados) }))
    // um PNG de 256 por variante, so pra olhar
    fs.writeFileSync(path.join(SAIDA, 'variante-' + v + '.png'), feitas[v].find((x) => x.lado === 256).buf)
    // e o tamanho que decide de verdade: 32 e 16, ampliados, pra ver se o desenho AGUENTA
    for (const p of [16, 32, 48]) {
      fs.writeFileSync(path.join(SAIDA, 'variante-' + v + '-' + p + '.png'), feitas[v].find((x) => x.lado === p).buf)
    }
  }

  // A ESCOLHIDA. Trocar aqui e so trocar o nome; os arquivos das outras continuam em build/ pra
  // comparar na proxima vez que alguem perguntar "por que essa e nao aquela".
  const ESCOLHIDA = process.env.SW_ICONE || 'verde'
  const ico = montaIco(feitas[ESCOLHIDA])
  fs.writeFileSync(path.join(SAIDA, 'icon.ico'), ico)
  // O PNG de 256 tambem, porque o electron-builder usa ele em alguns alvos e e o que fica bom numa
  // tela grande.
  fs.writeFileSync(path.join(SAIDA, 'icon.png'), feitas[ESCOLHIDA].find((x) => x.lado === 256).buf)

  console.log('\nicone gerado a partir de ' + path.basename(MARCA))
  console.log('  variante escolhida: ' + ESCOLHIDA + '  (SW_ICONE=onda|escuro pra trocar)')
  console.log('  build/icon.ico   ' + ico.length + ' bytes, ' + TAMANHOS.length + ' tamanhos: ' + TAMANHOS.join(', '))
  console.log('  build/icon.png   ' + feitas[ESCOLHIDA].find((x) => x.lado === 256).buf.length + ' bytes')
  console.log('  e as variantes em build/variante-*.png, pra olhar antes de empacotar\n')
  app.exit(0)
}

app.whenReady().then(() => {
  rodar().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) })
})
