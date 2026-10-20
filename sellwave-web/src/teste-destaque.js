// TESTE DE PONTA A PONTA DA JANELA PROPRIA, dentro do app de verdade.
//
// POR QUE ELE EXISTE (17/10/2026). O `teste-janela.js` mede a mudanca de view entre duas janelas
// soltas e confere as guardas lendo o fonte. Isso prova as PECAS. Nao prova o app: quem chama
// `destaca`, quem devolve, quem reposiciona e quem avisa a barra e o main.js inteiro, com o seu
// estado - e e exatamente ai que mora a classe de bug que mais custou tempo neste projeto, a que
// nao da erro em lugar nenhum e so aparece quando alguem olha a tela.
//
// Entao aqui o app roda DE VERDADE (mesmo main.js, mesma janela, mesma barra, mesmo painel) e o
// teste finge um unico pedaco: a view do numero carrega uma pagina local em vez do WhatsApp Web.
// Sem isso o teste precisaria de chip, proxy e rede, e passaria a medir a internet.
//
// Uso:  SW_JANELA=1 npx electron .      (ou `npm run teste-destaque`)
// ELE ABRE JANELA NA TELA de proposito: janela escondida nao desenha, e o que esta sendo conferido
// e justamente quem desenha onde. O Bruno autorizou em 17/10.
const { WebContentsView } = require('electron')

let ok = 0, ruim = 0
function conta(nome, bom, detalhe) {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGINA = 'data:text/html,<meta charset="utf-8">'
  + '<body style="margin:0;background:%23111b21;color:%23e9edef;font:14px sans-serif">'
  + '<h1 id="t">numero de teste</h1></body>'

// `ctx` vem do main.js e da acesso ao estado real: nada aqui e copia.
async function rodar(ctx) {
  const { janela, abertos, destacados, destaca, devolve, mostra, nkDoPainel, fechaNumero, particaoDe } = ctx
  const NK = '11900000001'
  console.log('\n=== JANELA PROPRIA, no app de verdade ===')

  // ── um numero "aberto", com a view carregando pagina local ───────────────────────────────
  const view = new WebContentsView({ webPreferences: { partition: particaoDe(NK), contextIsolation: true } })
  janela.contentView.addChildView(view)
  await view.webContents.loadURL(PAGINA)
  abertos.set(NK, { view, nk: NK, numero: '55' + NK, carregado: true, ultimoUso: Date.now() })
  mostra(NK)
  await espera(300)

  const filhosAntes = janela.contentView.children.length
  conta('o numero aparece na janela principal', view.getVisible() === true && filhosAntes >= 1,
    'filhos da principal: ' + filhosAntes)

  // ── DESTACAR ─────────────────────────────────────────────────────────────────────────────
  const r = destaca(NK)
  await espera(1200)
  const d = destacados.get(NK)
  conta('destacar responde ok e registra a janela', !!(r && r.ok) && !!d, JSON.stringify(r))
  if (!d) { fim(ctx, NK, view); return }

  conta('nasceu uma janela de verdade, visivel',
    d.win && !d.win.isDestroyed() && d.win.isVisible() === true,
    'visivel=' + (d.win && d.win.isVisible()))
  // ELA SE IDENTIFICA E VAI PRO CANTO. O teste PRECISA de janela visivel (escondida nao desenha, e
  // o que esta sendo conferido e quem desenha onde), mas ela abre na tela de quem estiver
  // trabalhando. Dizer no titulo que e teste custa uma linha e evita o susto.
  try {
    d.win.setTitle('TESTE do SellWave Web · pode ignorar, fecha sozinha')
    d.win.setBounds({ x: 24, y: 24, width: 960, height: 640 })
    await espera(250)
  } catch (_) { /* se o sistema recusar, o teste segue */ }
  // A VIEW MUDOU DE MAE: tem que ter saido da principal e entrado na nova.
  const naPrincipal = janela.contentView.children.includes(view)
  const naNova = d.win.contentView.children.includes(view)
  conta('a view saiu da janela principal e entrou na nova',
    naPrincipal === false && naNova === true, 'principal=' + naPrincipal + ' nova=' + naNova)
  conta('e ela esta aparecendo la (a visibilidade cola na view, entao alguem tem que mandar)',
    view.getVisible() === true, 'visivel=' + view.getVisible())
  // MINIMIZAR E VOLTAR (19/10/2026, o Guilherme: "quando eu saio da janela e volto, ta demorando pra
  // carregar novamente"). Minimizada, o Windows manda um resize com a janela de tamanho zero; se a
  // view guarda esse tamanho e ninguem refaz a conta na volta, ela fica preta ate outro resize.
  const larguraAntes = view.getBounds().width
  d.win.minimize()
  await espera(700)
  conta('minimizada, a view nao fica com tamanho zero guardado',
    view.getBounds().width === larguraAntes, 'largura ' + view.getBounds().width + ' (antes ' + larguraAntes + ')')
  d.win.restore()
  await espera(700)
  const bV = view.getBounds()
  const bP = d.painel ? d.painel.getBounds() : { width: 0 }
  conta('e ao voltar o WhatsApp e o painel estao no tamanho certo, na hora',
    bV.width > 300 && bV.height > 300 && bP.width > 200, JSON.stringify({ zap: bV, painel: bP }))
  // O DOCUMENTO SOBREVIVEU: e a prova de que o WhatsApp nao recarregaria.
  const vivo = await view.webContents.executeJavaScript('(document.getElementById("t")||{}).textContent || ""')
  conta('o documento continua o mesmo depois da mudanca', vivo === 'numero de teste', vivo)

  // O PAINEL DELA: tem que existir, ter carregado e responder pelo numero DELA.
  conta('a janela tem painel proprio', !!(d.painel && !d.painel.webContents.isDestroyed()))
  const deQuem = d.painel ? nkDoPainel(d.painel.webContents) : ''
  conta('e o painel dela responde pelo numero dela, nao pelo ativo da principal',
    deQuem === NK, 'nkDoPainel devolveu "' + deQuem + '"')
  const temPainelDentro = d.win.contentView.children.includes(d.painel)
  conta('o painel esta dentro da janela nova', temPainelDentro === true, String(temPainelDentro))
  // GEOMETRIA: sem barra de numeros, o WhatsApp comeca na borda esquerda.
  const bw = view.getBounds()
  conta('o WhatsApp comeca na borda, sem o vao da barra de numeros',
    bw.x === 0 && bw.width > 300, JSON.stringify(bw))

  // ── A FOTO, porque "ficou bom?" nao se responde lendo codigo ─────────────────────────────
  // A janela esta visivel (e por isso que este teste abre janela), entao da pra fotografar. O
  // painel demora a desenhar: ele pede roteiro e estado antes de ter o que mostrar.
  await espera(2500)
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const pasta = path.join(require('electron').app.getPath('userData'), 'fotos')
    fs.mkdirSync(pasta, { recursive: true })
    const img = await d.painel.webContents.capturePage()
    fs.writeFileSync(path.join(pasta, 'j1-painel-da-janela-propria.png'), img.toPNG())
    console.log('  foto: ' + path.join(pasta, 'j1-painel-da-janela-propria.png'))
  } catch (e) { console.log('  (nao fotografei: ' + ((e && e.message) || e) + ')') }

  // ── CLICAR NO NUMERO NA BARRA NAO PODE ROUBAR A VIEW ─────────────────────────────────────
  mostra(NK)
  await espera(300)
  conta('clicar nele na barra NAO arranca a view da outra janela',
    d.win.contentView.children.includes(view) === true
    && janela.contentView.children.includes(view) === false,
    'ainda na nova: ' + d.win.contentView.children.includes(view))
  // E a outra janela nao pode ter sido apagada por um esconder da casca.
  ctx.escondeTodos()
  await espera(250)
  conta('e esconder tudo na principal nao apaga o WhatsApp da outra janela',
    view.getVisible() === true, 'visivel=' + view.getVisible())

  // ── A HIBERNACAO NAO PODE ESCOLHER ELE ───────────────────────────────────────────────────
  const candidatos = ctx.candidatosHibernacao()
  conta('a hibernacao nao lista o numero destacado como candidato',
    !candidatos.includes(NK), JSON.stringify(candidatos))

  // ── FECHAR A JANELA DEVOLVE O NUMERO ─────────────────────────────────────────────────────
  d.win.close()
  await espera(900)
  conta('fechar a janela nao mata o numero: ele continua aberto',
    abertos.has(NK) && !view.webContents.isDestroyed(), 'abertos tem: ' + abertos.has(NK))
  conta('a view voltou pra janela principal',
    janela.contentView.children.includes(view) === true, String(janela.contentView.children.includes(view)))
  // ESCONDIDA DE PROPOSITO: voltar aparecendo seria cobrir o numero que estiver na principal.
  conta('e voltou ESCONDIDA, pra nao cobrir o que estiver na tela',
    view.getVisible() === false, 'visivel=' + view.getVisible())
  conta('o registro de destacados ficou limpo', destacados.has(NK) === false, String(destacados.has(NK)))

  // ── DESTACAR DE NOVO, E DAI FECHAR O NUMERO ──────────────────────────────────────────────
  destaca(NK)
  await espera(900)
  const d2 = destacados.get(NK)
  conta('da pra destacar de novo depois de devolver', !!d2 && !d2.win.isDestroyed())
  const win2 = d2 && d2.win
  fechaNumero(NK)
  await espera(700)
  conta('fechar o numero derruba a janela dele junto, sem sobrar janela preta',
    !!win2 && win2.isDestroyed() === true, 'destruida=' + (win2 && win2.isDestroyed()))
  conta('e o numero saiu de abertos', abertos.has(NK) === false, String(abertos.has(NK)))

  fim(ctx, NK, view)
}

function fim(ctx, NK, view) {
  try { ctx.abertos.delete(NK) } catch (_) { /* ok */ }
  try { if (view && !view.webContents.isDestroyed()) view.webContents.close() } catch (_) { /* ok */ }
  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  require('electron').app.exit(ruim ? 1 : 0)
}

module.exports = { rodar }

// RODAR ESTE ARQUIVO DIRETO NAO FUNCIONA, E ANTES FALHAVA CALADO. Ele e MODULO: quem o carrega e o
// main.js quando SW_JANELA=1. Chamado como `electron src/teste-destaque.js`, o Electron subia sem
// janela nenhuma e ficava PENDURADO - aconteceu duas vezes em 17/10, uma delas por dez minutos com
// processo vivo na maquina do Bruno. A linha "Uso:" do cabecalho existia e nao foi lida, entao o
// aviso passa a estar onde ninguem escapa: na cara, e saindo na hora.
// A DETECCAO E PELO argv, nao pelo `require.main`: no processo principal do Electron o
// `require.main` NAO aponta pra este arquivo mesmo quando ele e o ponto de entrada, entao a guarda
// escrita assim nao disparava e o processo continuava pendurado - medido aqui, com o mesmo sintoma
// que se queria evitar.
const souOPontoDeEntrada = process.argv.slice(1).some((a) => String(a).replace(/\\/g, '/').endsWith('src/teste-destaque.js'))
if (souOPontoDeEntrada) {
  console.log('')
  console.log('Este arquivo e um MODULO, nao um teste solto: quem roda ele e o app.')
  console.log('Rode assim:')
  console.log('')
  console.log('  npm run teste-destaque')
  console.log('  (ou, na mao:  SW_JANELA=1 npx electron .)')
  console.log('')
  try { require('electron').app.exit(2) } catch (_) { process.exit(2) }
}
