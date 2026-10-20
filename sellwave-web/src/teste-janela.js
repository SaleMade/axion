// TESTE DA JANELA PROPRIA: a view muda de mae sem o WhatsApp recarregar.
//
// POR QUE ELE EXISTE (17/10/2026). O Bruno pediu pra poder abrir um segundo WhatsApp numa janela
// separada, pra trabalhar dois ao mesmo tempo como ele faz no AdsPower. O desenho inteiro se apoia
// numa aposta: que dar MUDAR uma WebContentsView de uma BaseWindow pra outra sem a pagina
// recarregar. Se recarregasse, destacar um numero no meio de um funil mataria o funil, derrubaria o
// motor do WhatsApp e, no pior caso, pediria QR de novo.
//
// "Dizem que funciona" nao serve pra uma aposta dessas. Aqui ela e MEDIDA: mesmo processo de
// renderizacao, mesmo documento, o setInterval sem pular uma batida e nenhuma navegacao nova.
//
// A SEGUNDA METADE do teste recorta o main.js e confere as guardas que o desenho exige. Elas sao
// invisiveis quando estao certas e silenciosas quando somem: o `mostra()` escondendo a view que
// mora na outra janela deixaria a janela destacada preta, e ninguem veria isso num teste de tela.
//
// Como rodar:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-janela.js
// (ou `npm run teste-janela`)
const { app, BaseWindow, WebContentsView } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let ok = 0, ruim = 0
function conta(nome, bom, detalhe) {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

async function rodar() {
  console.log('\nA VIEW MUDA DE JANELA')

  const a = new BaseWindow({ show: false, width: 900, height: 700 })
  const b = new BaseWindow({ show: false, width: 900, height: 700 })
  const v = new WebContentsView({ webPreferences: { partition: 'persist:sw-teste-janela' } })

  // Conta navegacoes e cargas do inicio ao fim: e o numero que diz se a pagina recarregou.
  let navegou = 0, carregou = 0
  v.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame) navegou += 1 })
  v.webContents.on('did-finish-load', () => { carregou += 1 })

  a.contentView.addChildView(v)
  v.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  await v.webContents.loadURL('data:text/html,<meta charset="utf-8"><body>oi</body>')

  // Marca o DOCUMENTO e liga um relogio dentro dele. Se a pagina recarregar, os dois somem.
  await v.webContents.executeJavaScript(
    'window.__marca = "antes-de-mudar"; window.__batidas = 0;'
    + ' window.__t = setInterval(() => { window.__batidas += 1 }, 50); "ok"',
  )
  const idAntes = v.webContents.id
  const pidAntes = v.webContents.getOSProcessId()
  await espera(400)
  const batidasAntes = await v.webContents.executeJavaScript('window.__batidas')

  // ── A MUDANCA ────────────────────────────────────────────────────────────────────────────
  a.contentView.removeChildView(v)
  b.contentView.addChildView(v)
  v.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  await espera(400)

  const depois = await v.webContents.executeJavaScript(
    'JSON.stringify({ marca: window.__marca || "", batidas: window.__batidas || 0, url: location.href.slice(0, 30) })',
  )
  const d = JSON.parse(depois)

  conta('a view continua no mesmo processo de renderizacao',
    v.webContents.getOSProcessId() === pidAntes && v.webContents.id === idAntes,
    'pid ' + pidAntes + ' -> ' + v.webContents.getOSProcessId())
  conta('e no mesmo DOCUMENTO: o que a pagina guardou continua la',
    d.marca === 'antes-de-mudar', JSON.stringify(d.marca))
  // O RELOGIO NAO DA PRA MEDIR AQUI, e e honesto dizer por que: o Chromium CONGELA timer de janela
  // escondida, e estas duas sao `show: false` de proposito (teste nao pode piscar janela na tela do
  // Bruno). Entao o que se confere e que o timer CONTINUA O MESMO OBJETO do mesmo documento, e nao
  // que ele andou.
  //
  // Pro funil isso basta, e o motivo e o de cima: o risco nunca foi o timer, foi a pagina
  // RECARREGAR - e recarregar esta descartado pelas duas conferencias vizinhas (o documento
  // intacto e uma navegacao so). A janela de verdade esta visivel nas duas pontas da mudanca.
  //
  // A CONTA ERA `=== batidasAntes` E DAVA FALSO ALARME (medido em 17/10: falhou 1 vez em 4 com
  // "batidas 0 -> 1", nas quatro com o mesmo codigo, so com a maquina mais ou menos ocupada). O
  // congelamento da janela escondida NAO E INSTANTANEO, entao numa maquina carregada uma batida
  // escapa durante a mudanca - e exigir que ela NAO ande mede justamente o que o comentario acima
  // diz que nao da pra medir.
  // `>=` e a conta certa porque e ela que distingue o que o teste quer provar: recarregar ZERA o
  // `__batidas` (e apaga o `__marca`), entao contador que nao andou pra tras e a prova de que o
  // documento e o mesmo. Uma batida a mais nao e sintoma de nada.
  // E O `>=` NAO E FOLGA, E A CONFERENCIA CERTA. A primeira versao exigia `===`, ou seja que o
  // relogio NAO andasse nada - e o congelamento de timer em janela escondida nao e instantaneo,
  // entao numa maquina ocupada uma batida escapa durante a mudanca. Medido pela sessao ac: 14 de 15
  // numa rodada, 15 de 15 em duas seguidas, com o MESMO codigo. Era corrida, nao regressao, e ela
  // quase culpou o proprio diff por causa disso.
  //
  // O que o teste quer provar e que a pagina nao RECARREGOU, e recarregar ZERA o `__batidas` e
  // apaga o `__marca`. Entao contador que nao andou pra tras e a prova; exigir que ele nao ande e
  // exigir uma coisa que este ambiente nao garante.
  const relogio = await v.webContents.executeJavaScript('typeof window.__t')
  conta('o relogio de dentro da pagina sobrevive a mudanca (o objeto, nao a contagem)',
    relogio === 'number' && d.batidas >= batidasAntes, relogio + ', batidas ' + batidasAntes + ' -> ' + d.batidas)
  conta('e a pagina NAO recarregou (uma navegacao e uma carga, do inicio ao fim)',
    navegou === 1 && carregou === 1, 'navegacoes ' + navegou + ', cargas ' + carregou)

  // A VISIBILIDADE COLA NA VIEW, e e por isso que o codigo manda aparecer e desaparecer na mao
  // depois de cada mudanca: devolver um numero escondido faria ele voltar POR CIMA do que estiver
  // na janela principal.
  v.setVisible(false)
  b.contentView.removeChildView(v)
  a.contentView.addChildView(v)
  await espera(120)
  conta('a visibilidade atravessa a mudanca, entao quem muda tem que mandar aparecer',
    v.getVisible() === false, 'visivel=' + v.getVisible())

  try { v.webContents.close() } catch (_) { /* ok */ }
  try { a.destroy(); b.destroy() } catch (_) { /* ok */ }

  // ── AS GUARDAS DO main.js ────────────────────────────────────────────────────────────────
  console.log('\nAS GUARDAS NO FONTE')
  const fonte = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const semComentario = fonte.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

  conta('existe o registro das janelas destacadas', /const destacados = new Map\(\)/.test(semComentario))
  // O NO DO DESENHO: todo handler do painel pergunta de QUEM ele e, em vez de ler o numero ativo.
  conta('o painel pergunta de quem ele e (nkDoPainel), nao quem esta na tela',
    /function nkDoPainel\(/.test(semComentario)
    && /swp:estado-wa[\s\S]{0,400}nkDoPainel\(/.test(semComentario),
    'nkDoPainel no estado-wa')
  conta('o fechar e o recarregar do painel tambem',
    /swp:fechar-ativo[\s\S]{0,200}nkDoPainel\(/.test(semComentario)
    && /swp:recarregar-ativo[\s\S]{0,200}nkDoPainel\(/.test(semComentario))
  // Sem esta, clicar num numero na barra apagaria o WhatsApp da outra janela.
  conta('o mostra() nao mexe na view que mora noutra janela',
    /if \(destacados\.has\(chave\)\) continue/.test(semComentario))
  conta('e o escondeTodos() tambem nao',
    /escondeTodos[\s\S]{0,160}!destacados\.has\(s\.nk\)/.test(semComentario))
  // Sem esta, a hibernacao fecharia justo o numero destacado: ele nunca passa pelo mostra(), entao
  // o `ultimoUso` dele envelhece parado e ele vira o candidato mais velho da lista.
  conta('a hibernacao protege o que esta na tela de QUALQUER janela',
    /const naTela = new Set\(\[ativoAgora, \.\.\.destacados\.keys\(\)\]/.test(semComentario)
    && /!naTela\.has\(s\.nk\) && !disparos\.has\(s\.nk\)/.test(semComentario))
  // O arrendamento e o unico ponto que os dois paineis enxergam: a trava deles vive dentro de cada
  // pagina e nenhuma sabe da outra.
  conta('o disparo e arrendado por numero, pra dois paineis nao intercalarem na mesma conversa',
    /dono\.quem !== quem/.test(semComentario) && /disparando na outra janela/.test(fonte))
  conta('fechar um numero destacado derruba a janela dele',
    /function fechaNumero[\s\S]{0,400}destacados\.has\(nk\)[\s\S]{0,200}d\.win\.destroy\(\)/.test(semComentario))
  // A JANELA NAO PODE SER FILHA: no Windows, filha fica sempre na frente da mae e minimiza junto,
  // o que mata o pedido (um WhatsApp em cada monitor).
  // SO A JANELA DESTACADA. A janela do DOCUMENTO (o leitor de PDF) usa `parent` de proposito e
  // deve continuar usando: ela e um visualizador que acompanha o app. A primeira versao desta
  // conferencia varria o arquivo inteiro e reprovava por causa dela.
  const blocoDestaca = semComentario.slice(semComentario.indexOf('function destaca('), semComentario.indexOf('function devolve('))
  conta('a janela destacada nao e filha da principal',
    blocoDestaca.length > 200 && !/parent:/.test(blocoDestaca),
    blocoDestaca.length + ' bytes no bloco destaca()')
  conta('e ela devolve o numero ao fechar, em vez de matar a view',
    /win\.on\('close', \(\) => devolve\(nk\)\)/.test(semComentario))

  // ── O ALUGUEL DO NUMERO VOLTA QUANDO A ABERTURA FALHA ────────────────────────────────────
  //
  // Mora aqui porque aqui e onde as guardas do main.js sao recortadas do fonte. O aluguel e pedido
  // ANTES do preflight (de proposito: nao se sobe uma sessao de 400 MB pra descobrir no fim que o
  // numero esta com outra maquina), e por isso TODA saida de erro tem que devolver. Sem isso o
  // numero fica trancado como "Aberto por <quem tentou>" pra todo mundo MENOS pra ele, e so solta
  // fechando o app - o `fechaNumero` nao resolve, porque sai cedo quando o numero nao esta em
  // `abertos`, e abertura que falhou nunca entrou.
  const bloco = semComentario.slice(
    semComentario.indexOf('async function abreDeVerdade('),
    semComentario.indexOf('function salvaSessao('),
  )
  const crus = (bloco.match(/return \{ ok: false/g) || []).length
  const comDesiste = (bloco.match(/return desiste\(/g) || []).length
  conta('toda saida de erro da abertura devolve o aluguel do numero',
    bloco.length > 200 && crus === 0 && comDesiste >= 4, crus + ' cruas, ' + comDesiste + ' devolvendo')

  // ── SAIR DA JANELA E VOLTAR NAO DEMORA (19/10/2026) ──────────────────────────────────────
  // As tres chaves do Chromium que impedem a pagina de ir pro fundo, e o redesenho na volta nas DUAS
  // janelas. Se uma sumir, o vendedor volta a ver a janela preta por segundos ao voltar pra ela.
  const chaves = ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'CalculateNativeWinOcclusion']
  conta('o app nao deixa o Chromium jogar a pagina pro fundo',
    chaves.every((k) => semComentario.indexOf(k) >= 0 && semComentario.indexOf(k) < semComentario.indexOf('app.whenReady()')),
    chaves.filter((k) => semComentario.indexOf(k) < 0).join(', ') || 'ordem')
  conta('e redesenha na volta, na principal e na destacada',
    /janela\.on\(ev, \(\) => acordaJanela\(null\)\)/.test(semComentario) && /win\.on\(ev, \(\) => acordaJanela\(d\)\)/.test(semComentario))

  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  app.exit(ruim ? 1 : 0)
}

app.whenReady().then(() => {
  rodar().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) })
})
