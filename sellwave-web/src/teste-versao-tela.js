// DESENHA O POP-UP DE ATUALIZACAO NUMA JANELA DE VERDADE E TIRA A FOTO (21/10/2026).
//
// O teste-versao-popup.mjs prova a REGRA (quando aparece). Este aqui prova o DESENHO: que ele cabe,
// que fica grande no meio da tela, que os dois botoes existem e que o de baixar troca de texto
// depois do clique. Sem isto, "pop-up bem grande" fica na palavra.
//
// Como rodar:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-versao-tela.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SAIDA = process.env.SW_FOTO || path.join(os.tmpdir(), 'sw-popup-versao.png')
let ok = 0, ruim = 0
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

// Preload de mentira: a casca so precisa que `window.sw` exista pra nao estourar no carregamento.
const STUB = path.join(os.tmpdir(), 'sw-preload-teste-versao.js')
// Objeto PLANO, nunca um Proxy: o contextBridge copia o valor pra outro mundo de JS e as armadilhas
// do Proxy nao atravessam - `window.sw` chegaria vazio e o teste mediria a casca sem a ponte.
fs.writeFileSync(STUB, [
  "const { contextBridge } = require('electron')",
  'const nada = async () => ({})',
  "contextBridge.exposeInMainWorld('sw', {",
  "  ao: () => () => {},",
  "  estado: async () => ({ numeros: [], vendedores: [], versao: '1.25.7', nome: 'Teste', direcao: false }),",
  '  esconder: nada, mostrar: nada, abrirInstalador: nada, abrir: nada, fechar: nada,',
  '  painel: nada, barra: nada, verComo: nada, abrirLog: nada, soltarUso: nada, teto: nada,',
  '})',
].join('\n'), 'utf8')

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1100, height: 780,
    webPreferences: { preload: STUB, partition: 'persist:sw-teste-versao' },
  })
  await w.loadFile(path.join(__dirname, 'ui', 'index.html'))
  await new Promise((r) => setTimeout(r, 900))

  const tem = await w.webContents.executeJavaScript('typeof janelaVersao')
  conta('a casca carregou com a janelaVersao', tem === 'function', 'typeof = ' + tem)
  if (tem !== 'function') { console.log('\n  ' + ok + ' ok, ' + (ruim + 1) + ' ruim'); app.exit(1); return }

  const erro = await w.webContents.executeJavaScript(`(() => { try {
    janelaVersao('1.25.11', '1.25.7', 'A pilha de funis mostra no maximo tres e o resto rola dentro dela. Pareamento novo so vai pra nuvem depois de 3 minutos conectado.')
    return ''
  } catch (e) { return String((e && e.stack) || e) } })()`)
  conta('a janelaVersao rodou sem estourar', erro === '', erro)
  await new Promise((r) => setTimeout(r, 400))

  const m = await w.webContents.executeJavaScript(`(() => {
    const f = document.getElementById('modal')
    const c = document.getElementById('modal-corpo')
    const r = c.getBoundingClientRect()
    return {
      aberto: f.classList.contains('on'),
      larg: Math.round(r.width), alt: Math.round(r.height),
      titulo: (c.querySelector('h2') || {}).textContent || '',
      baixar: !!document.getElementById('ver-baixar'),
      depois: !!document.getElementById('ver-depois'),
      notas: c.textContent.indexOf('O que mudou') >= 0,
      versoes: c.textContent.indexOf('1.25.7') >= 0 && c.textContent.indexOf('1.25.11') >= 0,
      cabe: r.height <= window.innerHeight && r.width <= window.innerWidth,
      fora: typeof f.onclick,
    }
  })()`)

  conta('o pop-up abriu', m.aberto === true)
  conta('o titulo e o certo', m.titulo === 'Atualização disponível', m.titulo)
  conta('mostra as duas versoes', m.versoes === true)
  conta('mostra o que mudou', m.notas === true)
  conta('tem o botao de baixar', m.baixar === true)
  conta('tem a saida "agora nao"', m.depois === true)
  conta('clicar fora nao fecha', m.fora === 'object', 'onclick = ' + m.fora)
  conta('cabe na janela', m.cabe === true, m.larg + 'x' + m.alt)
  conta('e grande de verdade (>=380px de largura)', m.larg >= 380, m.larg + 'px')

  const foto = await w.webContents.capturePage()
  fs.writeFileSync(SAIDA, foto.toPNG())
  console.log('\n  foto: ' + SAIDA + '  (cartao ' + m.larg + 'x' + m.alt + ')')

  // o clique no baixar troca o texto e libera o fechar
  await w.webContents.executeJavaScript("document.getElementById('ver-baixar').click()")
  await new Promise((r) => setTimeout(r, 250))
  const dep = await w.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('ver-baixar'), d = document.getElementById('ver-depois')
    return { txt: b.textContent, travado: b.disabled, saida: d.textContent,
             instrucao: document.getElementById('modal-corpo').textContent.indexOf('feche o app') >= 0 }
  })()`)
  conta('depois do clique o botao diz que abriu', dep.txt === 'Download aberto no navegador', dep.txt)
  conta('e nao da pra clicar de novo', dep.travado === true)
  conta('a saida vira "Fechar"', dep.saida === 'Fechar', dep.saida)
  conta('e a tela diz o que fazer depois', dep.instrucao === true)

  console.log('\n  ' + ok + ' ok, ' + ruim + ' ruim')
  app.exit(ruim ? 1 : 0)
})
