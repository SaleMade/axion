// DESENHA A FAIXA DE VERSAO NOVA NAS TRES FASES, NUMA JANELA DE VERDADE, E TIRA FOTO (06/11/2026).
//
// Pedido do Bruno: no lugar do "Clique pra baixar" (que aparecia mesmo com o app baixando sozinho por
// baixo), "Baixando em segundo plano" com uma bolinha girando e, quando terminar, "versao nova pronta,
// reinicie quando quiser". O teste-funcoes.mjs prova a REGRA no processo principal; este aqui prova o
// DESENHO e a FIACAO: os avisos passam pelo mesmo `window.sw.ao` que o app usa, a bolinha gira de
// verdade, as duas fases novas nao tem clique e o baixar na mao continua funcionando quando precisa.
//
// Como rodar:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-faixa-versao.js
// As fotos saem em SW_FOTO_DIR (ou na pasta temporaria): faixa-baixando.png, faixa-pronta.png, faixa-baixar.png.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DIR = process.env.SW_FOTO_DIR || os.tmpdir()
let ok = 0, ruim = 0
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

// Preload de mentira. Guarda os ouvintes que a casca registra e deixa o teste DISPARAR os avisos
// (sw.disparar), troca o estado que o "main" devolve (sw.poeEstado) e conta os cliques no instalador.
// Objeto PLANO, nunca um Proxy: o contextBridge nao atravessa armadilha de Proxy.
const STUB = path.join(os.tmpdir(), 'sw-preload-teste-faixa.js')
fs.writeFileSync(STUB, [
  "const { contextBridge } = require('electron')",
  'const ouvintes = {}',
  "let estado = { temToken: false, numeros: [], vendedores: [], versao: '1.26.11', nome: 'Teste', direcao: false }",
  'let instalador = 0',
  'const nada = async () => ({})',
  "contextBridge.exposeInMainWorld('sw', {",
  '  ao: (canal, fn) => { ouvintes[canal] = fn; return () => {} },',
  '  disparar: (canal, d) => { if (ouvintes[canal]) ouvintes[canal](d); return !!ouvintes[canal] },',
  '  poeEstado: (e) => { estado = e },',
  '  instalador: () => instalador,',
  '  estado: async () => estado,',
  '  abrirInstalador: async () => { instalador += 1; return { ok: true } },',
  '  esconder: nada, mostrar: nada, abrir: nada, fechar: nada, numeros: async () => ({ ok: true }),',
  '  painel: nada, barra: nada, verComo: nada, abrirLog: nada, soltarUso: nada, teto: nada,',
  '})',
].join('\n'), 'utf8')

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1100, height: 720,
    // DESENHO FORA DA TELA (offscreen): a janela escondida comum so redesenha a bolinha (que gira no
    // compositor) e a foto saia com o texto de um quadro atras. Fora da tela, todo quadro e desenhado.
    webPreferences: { preload: STUB, partition: 'persist:sw-teste-faixa', backgroundThrottling: false, offscreen: true },
  })
  await w.loadFile(path.join(__dirname, 'ui', 'index.html'))
  await espera(900)
  const js = (s) => w.webContents.executeJavaScript(s)

  const tem = await js("typeof avisaVersao + '|' + typeof recarregaEstado")
  conta('a casca carregou', tem === 'function|function', tem)
  if (tem !== 'function|function') { console.log('\n  ' + ok + ' ok, ' + (ruim + 1) + ' ruim'); app.exit(1); return }

  // Le a faixa como o vendedor ve: visivel?, texto, bolinha girando?, cabe?, tem clique?
  const faixa = () => js(`(() => {
    const el = document.getElementById('versao-nova')
    const g = el.querySelector('.gira')
    const r = el.getBoundingClientRect()
    return {
      visivel: !el.hidden && r.height > 0,
      texto: el.innerText.replace(/\\s+/g, ' ').trim(),
      gira: g ? getComputedStyle(g).animationName : '',
      girando: g ? getComputedStyle(g).animationPlayState : '',
      parada: el.classList.contains('parada'),
      cursor: getComputedStyle(el).cursor,
      cabe: el.scrollWidth <= el.clientWidth + 1,
      larg: Math.round(r.width), alt: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
    }
  })()`)
  // Tira foto so do pe da barra, onde a faixa mora, com folga em volta.
  const foto = async (nome) => {
    w.webContents.invalidate()
    await espera(500)
    const f = await faixa()
    const area = { x: 0, y: Math.max(0, f.y - 60), width: Math.max(300, f.x + f.larg + 20), height: f.alt + 120 }
    const img = await w.webContents.capturePage(area)
    const arq = path.join(DIR, nome)
    fs.writeFileSync(arq, img.toPNG())
    return arq + ' [' + f.texto + ']'
  }
  const poe = (e) => js('window.sw.poeEstado(' + JSON.stringify(e) + ')')
  const dispara = (canal, d) => js('window.sw.disparar(' + JSON.stringify(canal) + ', ' + JSON.stringify(d) + ')')
  const base = { temToken: true, numeros: [], vendedores: [], versao: '1.26.11', nome: 'Teste', direcao: false,
    versaoPublicada: '1.26.12', urlInstalador: 'https://exemplo/instalador.exe' }

  // 1) A FAIXA DE ANTES, quando ela ainda e a certa: a sozinha nao da conta (Mac, ou falhou)
  await poe({ ...base, precisaBaixar: true, atualizacao: { fase: '', versao: '', pct: 0 } })
  await js('recarregaEstado()')
  await espera(150)
  let f = await faixa()
  conta('sem a sozinha, a faixa pede pra baixar na mao (como antes)', f.visivel && /Versão 1\.26\.12 disponível/.test(f.texto) && /Clique pra baixar/.test(f.texto), f.texto)
  conta('e ela e clicavel', !f.parada && f.cursor === 'pointer', f.cursor)
  await js("document.getElementById('versao-nova').click()")
  conta('o clique abre o instalador', (await js('window.sw.instalador()')) === 1)
  const fotoBaixar = await foto('faixa-baixar.png')

  // 2) A SOZINHA ACHOU A VERSAO: o aviso chega pelo mesmo canal que o app usa
  const chegou = await dispara('sw:atualizacao', { fase: 'baixando', versao: '1.26.12', pct: 0 })
  conta('a casca escuta o sw:atualizacao', chegou === true)
  await espera(150)
  f = await faixa()
  conta('a faixa diz "Baixando em segundo plano"', f.visivel && /^Baixando em segundo plano/.test(f.texto), f.texto)
  conta('com a versao, e sem porcentagem enquanto nao veio nada', /Versão 1\.26\.12$/.test(f.texto), f.texto)
  conta('a bolinha esta girando', f.gira === 'swgira' && f.girando === 'running', f.gira + ' ' + f.girando)
  conta('baixando nao tem clique', f.parada && f.cursor === 'default', f.cursor)
  await js("document.getElementById('versao-nova').click()")
  conta('clicar nela nao abre o instalador', (await js('window.sw.instalador()')) === 1)

  await dispara('sw:atualizacao', { fase: 'baixando', versao: '1.26.12', pct: 37 })
  await espera(150)
  f = await faixa()
  conta('o quanto ja veio aparece', /Versão 1\.26\.12 · 37%$/.test(f.texto), f.texto)
  conta('e cabe na faixa', f.cabe, f.larg + 'x' + f.alt)
  const fotoBaixando = await foto('faixa-baixando.png')

  // 3) BAIXOU
  await dispara('sw:atualizacao', { fase: 'pronta', versao: '1.26.12', pct: 100 })
  await espera(150)
  f = await faixa()
  conta('a faixa diz que a versao esta pronta', f.visivel && /^Versão 1\.26\.12 pronta/.test(f.texto), f.texto)
  conta('e que e so reiniciar quando quiser', /Reinicie o app quando quiser\.$/.test(f.texto), f.texto)
  conta('a bolinha some', f.gira === '')
  conta('pronta nao tem clique', f.parada && f.cursor === 'default', f.cursor)
  conta('e cabe na faixa', f.cabe, f.larg + 'x' + f.alt)
  const fotoPronta = await foto('faixa-pronta.png')

  // 4) O ESTADO DE 20 EM 20 S (e a casca recarregada pela vigia de tela branca) MANTEM a fase, mesmo
  //    com o baixar-na-mao ligado: o arquivo ja baixado instala ao fechar, nao ha o que baixar.
  await poe({ ...base, precisaBaixar: true, atualizacao: { fase: 'pronta', versao: '1.26.12', pct: 100 } })
  await js('recarregaEstado()')
  await espera(150)
  f = await faixa()
  conta('a fase da sozinha vence o baixar na mao', /^Versão 1\.26\.12 pronta/.test(f.texto), f.texto)

  // 5) Sem versao nova e sem nada da sozinha: a faixa some
  await poe({ ...base, versaoPublicada: '1.26.11', precisaBaixar: false, atualizacao: { fase: '', versao: '', pct: 0 } })
  await js('recarregaEstado()')
  await espera(150)
  f = await faixa()
  conta('sem versao nova, sem faixa', f.visivel === false)

  // 6) A sozinha falhou depois: volta a faixa de baixar na mao, clicavel de novo
  await poe({ ...base, precisaBaixar: true, atualizacao: { fase: '', versao: '', pct: 0 } })
  await js('recarregaEstado()')
  await espera(150)
  f = await faixa()
  conta('falhou: o baixar na mao volta', /Clique pra baixar/.test(f.texto) && !f.parada && f.cursor === 'pointer', f.texto + ' / ' + f.cursor)
  await js("document.getElementById('versao-nova').click()")
  conta('e o clique volta a abrir o instalador', (await js('window.sw.instalador()')) === 2)

  console.log('\n  fotos: ' + [fotoBaixando, fotoPronta, fotoBaixar].join('  '))
  console.log('\n  ' + ok + ' ok, ' + ruim + ' ruim')
  app.exit(ruim ? 1 : 0)
})
