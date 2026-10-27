// O POP-UP DO MOTOR DE CONVERSA, NUMA JANELA DE VERDADE (27/10/2026).
//
// POR QUE ELE EXISTE. O conserto do motor e servido pelo servidor e o app baixa sozinho, mas ele SO
// VALE quando a pagina do numero recarrega. Ate 27/10 o aviso disso era UMA LINHA na barra por 20
// segundos, e ninguem le: o motor leve foi publicado as 11:19 e as 11:26 o vendedor ainda estava com
// o funil lento, porque o app dele seguia rodando o motor velho que ja estava na memoria.
//
// Este teste prova o DESENHO e o COMPORTAMENTO: que o pop-up abre, que o botao principal RESOLVE
// (chama o recarregar e conta o que foi feito), que ele avisa quando um numero ficou de fora por
// estar disparando um funil, e que "Agora nao" cala por 15 minutos e nao pra sempre.
//
// Como rodar:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-motor-tela.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SAIDA = process.env.SW_FOTO || path.join(os.tmpdir(), 'sw-popup-motor.png')
let ok = 0, ruim = 0
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

// Preload de mentira: objeto PLANO, nunca um Proxy (o contextBridge copia o valor pra outro mundo de
// JS e as armadilhas do Proxy nao atravessam).
//
// E O CONTADOR VIAJA NUMA PONTE PROPRIA, nao numa variavel de `window`: com contextIsolation ligada
// o `window` do preload NAO e o `window` da pagina, entao marcar `window.__chamou` aqui dentro nao
// chegaria no executeJavaScript - o teste leria sempre zero e acusaria o codigo por um defeito dele
// mesmo. Foi o que aconteceu na primeira rodada.
const STUB = path.join(os.tmpdir(), 'sw-preload-teste-motor.js')
fs.writeFileSync(STUB, [
  "const { contextBridge } = require('electron')",
  'const nada = async () => ({})',
  'let chamadas = 0',
  'let resposta = { ok: true, feitos: 4, noFunil: 0 }',
  "contextBridge.exposeInMainWorld('sw', {",
  '  ao: () => () => {},',
  "  estado: async () => ({ numeros: [], vendedores: [], versao: '1.25.30', nome: 'Teste', direcao: false }),",
  '  esconder: nada, mostrar: nada, abrirInstalador: nada, abrir: nada, fechar: nada,',
  '  painel: nada, barra: nada, verComo: nada, abrirLog: nada, soltarUso: nada, teto: nada,',
  '  recarregarTodos: async () => { chamadas += 1; return resposta },',
  '})',
  "contextBridge.exposeInMainWorld('teste', {",
  '  chamadas: () => chamadas,',
  '  prepara: (r) => { chamadas = 0; resposta = r },',
  '})',
].join('\n'), 'utf8')

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1100, height: 780,
    webPreferences: { preload: STUB, partition: 'persist:sw-teste-motor' },
  })
  await w.loadFile(path.join(__dirname, 'ui', 'index.html'))
  await espera(900)
  const js = (c) => w.webContents.executeJavaScript(c)

  const tem = await js('typeof janelaMotor')
  conta('a casca carregou com a janelaMotor', tem === 'function', 'typeof = ' + tem)
  if (tem !== 'function') { console.log('\n  ' + ok + ' ok, ' + (ruim + 1) + ' ruim'); app.exit(1); return }

  await js("window.teste.prepara({ ok: true, feitos: 4, noFunil: 0 }); ''")
  const erro = await js('(() => { try { janelaMotor(); return "" } catch (e) { return String((e && e.stack) || e) } })()')
  conta('a janelaMotor rodou sem estourar', erro === '', erro)
  await espera(300)

  const m = await js(`(() => {
    const f = document.getElementById('modal')
    const c = document.getElementById('modal-corpo')
    const r = c.getBoundingClientRect()
    return {
      aberto: f.classList.contains('on'),
      larg: Math.round(r.width), alt: Math.round(r.height),
      titulo: (c.querySelector('h2') || {}).textContent || '',
      agora: !!document.getElementById('motor-ok'),
      depois: !!document.getElementById('motor-depois'),
      avisaFunil: c.textContent.indexOf('funil') >= 0,
      avisaQR: c.textContent.indexOf('QR') >= 0,
      cabe: r.height <= window.innerHeight && r.width <= window.innerWidth,
      fora: typeof f.onclick,
    }
  })()`)
  conta('o pop-up abriu', m.aberto === true)
  conta('o titulo diz que a correcao esta pronta', /Correção/.test(m.titulo), m.titulo)
  conta('tem o botao que resolve na hora', m.agora === true)
  conta('tem a saida "agora nao"', m.depois === true)
  conta('clicar fora nao fecha', m.fora === 'object', 'onclick = ' + m.fora)
  // O vendedor precisa saber as duas coisas antes de clicar: que o numero some uns segundos e que
  // ele NAO vai ter que parear de novo. Sem a segunda, ninguem clica.
  conta('avisa que o numero volta sem pedir QR', m.avisaQR === true)
  conta('e que quem esta disparando funil fica pra depois', m.avisaFunil === true)
  conta('cabe na janela', m.cabe === true, m.larg + 'x' + m.alt)
  conta('e grande de verdade (>=380px de largura)', m.larg >= 380, m.larg + 'px')

  fs.writeFileSync(SAIDA, (await w.webContents.capturePage()).toPNG())
  console.log('\n  foto: ' + SAIDA + '  (cartao ' + m.larg + 'x' + m.alt + ')')

  // ── O BOTAO RESOLVE, e e isso que o diferencia do pop-up de versao ────────────────────────────
  await js("document.getElementById('motor-ok').click()")
  await espera(300)
  const d1 = await js(`(() => {
    const b = document.getElementById('motor-ok'), d = document.getElementById('motor-depois')
    return { chamou: window.teste.chamadas(), txt: b.textContent, travado: b.disabled, saida: d.textContent,
             corpo: document.getElementById('motor-txt').textContent }
  })()`)
  conta('o clique manda recarregar os numeros', d1.chamou === 1, 'chamadas=' + d1.chamou)
  conta('e nao da pra clicar de novo', d1.travado === true)
  conta('a tela diz quantos foram', /4 números recarregados/.test(d1.corpo), d1.corpo.slice(0, 80))
  conta('o botao vira "Pronto"', d1.txt === 'Pronto', d1.txt)
  conta('e a saida vira "Fechar"', d1.saida === 'Fechar', d1.saida)
  await js("document.getElementById('motor-depois').click()")
  await espera(200)
  conta('e o Fechar fecha mesmo', (await js("document.getElementById('modal').classList.contains('on')")) === false)

  // ── O NUMERO QUE FICOU DE FORA PRECISA APARECER ───────────────────────────────────────────────
  // Recarregar no meio de um funil cortaria o disparo pela metade, entao o main pula. Se a tela nao
  // contar isso, o vendedor acha que todos pegaram a correcao e um deles nao pegou.
  await js("window.teste.prepara({ ok: true, feitos: 3, noFunil: 1 }); janelaMotor(); ''")
  await espera(250)
  await js("document.getElementById('motor-ok').click()")
  await espera(300)
  const d2 = await js("document.getElementById('motor-txt').textContent")
  conta('quando um fica no funil, a tela conta os dois numeros',
    /3 números recarregados/.test(d2) && /1 estava/.test(d2) && /pra depois/.test(d2), d2.slice(0, 140))
  await js("document.getElementById('motor-depois').click()"); await espera(200)

  // ── O MAIN NAO RESPONDEU: nao pode ficar dizendo "Recarregando..." pra sempre ─────────────────
  await js("window.teste.prepara(null); janelaMotor(); ''")
  await espera(250)
  await js("document.getElementById('motor-ok').click()")
  await espera(300)
  const d3 = await js("document.getElementById('motor-txt').textContent")
  conta('falhando, a tela diz o que fazer na mao', /painel de cada número/.test(d3), d3.slice(0, 100))

  // ── "AGORA NAO" CALA POR 15 MIN, NAO PRA SEMPRE ──────────────────────────────────────────────
  // O app continua rodando o motor velho ate recarregar, e esse e o estado que esta custando lead:
  // calar pra sempre seria voltar a faixinha que ninguem le.
  //
  // ABRE LIMPO ANTES DE CLICAR: depois do "recarregar" aquele botao ja virou "Fechar", que SO fecha
  // e nao adia - e isso esta certo, quem acabou de recarregar nao tem o que adiar.
  await js("document.getElementById('motor-depois').click()"); await espera(200)
  await js("motorAdiado = 0; janelaMotor(); ''"); await espera(250)
  await js("document.getElementById('motor-depois').click()"); await espera(200)
  conta('o "agora nao" fecha', (await js("document.getElementById('modal').classList.contains('on')")) === false)
  await js("janelaMotor(); ''"); await espera(250)
  const calado = await js("document.getElementById('modal').classList.contains('on')")
  conta('depois do "agora nao" ele nao reaparece na hora', calado === false)
  await js('motorAdiado = 0; janelaMotor(); ""'); await espera(250)
  conta('mas volta quando a espera passa',
    (await js("document.getElementById('modal').classList.contains('on')")) === true)

  console.log('\n  ' + ok + ' ok, ' + ruim + ' ruim')
  app.exit(ruim ? 1 : 0)
})
