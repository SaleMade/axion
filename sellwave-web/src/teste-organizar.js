// TESTE DO CRIAR E ORGANIZAR do painel (05/11/2026, pedido do Bruno: o vendedor cria mensagem,
// audio, video e foto, monta funil com o tempo de cada passo, esconde o que nao usa, e escolhe "so
// eu" ou "todos").
//
// Abre o painel.html DE VERDADE num Electron sem janela, com o preload falso que faz o papel do
// servidor (teste-organizar-preload.js), e clica como o vendedor clicaria.
//
//   env -u ELECTRON_RUN_AS_NODE npx electron src/teste-organizar.js
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('ELECTRON_RUN_AS_NODE esta ligado. Rode: env -u ELECTRON_RUN_AS_NODE npx electron src/teste-organizar.js')
  process.exit(2)
}
const { app, BrowserWindow, session } = require('electron')
const path = require('path')
app.setPath('userData', path.join(app.getPath('appData'), 'sellwave-web-teste-organizar'))

let ok = 0
const falhas = []
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')) }
}
let ponto = 'antes do whenReady'
setTimeout(() => { console.log('ESTOUROU O TEMPO (120s). Ultimo ponto: ' + ponto); app.exit(1) }, 120000)
process.on('unhandledRejection', (e) => { console.log('PROMESSA SOLTA em ' + ponto + ': ' + (e && e.message)); app.exit(1) })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('swmedia', () => new Response('', { status: 404 }))
  const abre = async (preload) => {
    const win = new BrowserWindow({ show: false, width: 320, height: 1000, webPreferences: { preload, sandbox: false, contextIsolation: true } })
    const erros = []
    win.webContents.on('console-message', (ev) => { if (ev && ev.level === 'error') erros.push(String(ev.message || '')) })
    await win.loadFile(path.join(__dirname, 'ui', 'painel.html'))
    return { win, erros, js: (c) => win.webContents.executeJavaScript(c, true) }
  }
  const espera = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── O APP VELHO (preload sem as funcoes novas) NAO MOSTRA OS BOTOES ──────────────────────────
  ponto = 'preload velho'
  const velho = await abre(path.join(__dirname, 'teste-painel-preload.js'))
  await espera(1800)
  const vis = await velho.js('({ novo: !document.getElementById("novo").hidden, org: !document.getElementById("organizar").hidden, itens: document.querySelectorAll(".item").length })')
  conta('com o preload antigo os botoes de criar e organizar ficam escondidos', !vis.novo && !vis.org && vis.itens > 0, JSON.stringify(vis))
  // fica aberta (escondida) ate o fim: fechar e abrir outra em seguida faz o segundo loadFile morrer
  // com ERR_FAILED neste Electron

  ponto = 'painel novo'
  const { js, erros } = await abre(path.join(__dirname, 'teste-organizar-preload.js'))
  const clica = (sel) => js('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (e) e.click(); return !!e })()')
  const digita = (k, v) => js('(() => { const e = document.querySelector("[data-k=' + k + ']"); if (!e) return false; e.value = ' + JSON.stringify(v) + '; e.dispatchEvent(new Event("input")); return true })()')
  const ver = () => js('window.__ver()')
  const ultima = async (nome) => { const c = (await ver()).filter((x) => x.nome === nome); return c[c.length - 1] }
  const conta1 = async (nome) => (await ver()).filter((x) => x.nome === nome).length
  const texto = () => js('document.getElementById("corpo").textContent')
  const poeArquivo = (b64, nome, tipo) => js('(() => { const bin = atob(' + JSON.stringify(b64) + '); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);'
    + ' const dt = new DataTransfer(); dt.items.add(new File([u], ' + JSON.stringify(nome) + ', { type: ' + JSON.stringify(tipo) + ' }));'
    + ' const i = document.querySelector("[data-ed=arquivo]"); if (!i) return false; i.files = dt.files; i.dispatchEvent(new Event("change")); return true })()')
  await espera(1800)

  console.log('TESTE DE CRIAR E ORGANIZAR\n')
  console.log('OS BOTOES')
  const b = await js('({ novo: !document.getElementById("novo").hidden, org: !document.getElementById("organizar").hidden })')
  conta('o + e o lapis aparecem ao lado da busca', b.novo && b.org, JSON.stringify(b))

  // ── MENSAGEM ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nMENSAGEM DE TEXTO')
  await clica('#novo'); await espera(150)
  const tipos = await js('[...document.querySelectorAll("[data-novo]")].map(x => x.dataset.novo).join(",")')
  conta('o + abre os cinco tipos: mensagem, audio, video, foto e documento', tipos === 'text,audio,video,image,document', tipos)
  conta('o documento ocupa a linha inteira (sem buraco do lado)', await js('getComputedStyle(document.querySelector("[data-novo=document]")).gridColumnStart === "1" && document.querySelector("[data-novo=document]").offsetWidth > document.querySelector("[data-novo=text]").offsetWidth * 1.8'))
  conta('com o editor aberto a busca some', await js('getComputedStyle(document.getElementById("cabeca")).display === "none"'))
  await clica('[data-novo="text"]'); await espera(120)
  await clica('[data-ed="salva"]'); await espera(150)
  conta('salvar sem texto mostra o recado e nao chama o servidor', /Escreva a mensagem/.test(await texto()) && (await conta1('salvaItem')) === 0, (await texto()).slice(0, 120))
  await digita('ed-nome', 'Meu bom dia')
  await digita('ed-texto', 'Bom dia, *tudo bem*?')
  await clica('[data-quem="todos"]'); await espera(100)
  conta('o "Todos" fica marcado', await js('document.querySelector("[data-quem=todos]").classList.contains("on")'))
  conta('e o que foi digitado nao se perde ao redesenhar', await js('document.querySelector("[data-k=ed-texto]").value === "Bom dia, *tudo bem*?"'))
  await clica('[data-ed="salva"]'); await espera(400)
  let s = await ultima('salvaItem')
  conta('salvar manda tipo, nome, texto e "todos"', s && s.args[0].tipo === 'text' && s.args[0].label === 'Meu bom dia' && s.args[0].text === 'Bom dia, *tudo bem*?' && s.args[0].escopo === 'todos', JSON.stringify(s && s.args[0]))
  conta('e rele o roteiro na hora (forcado)', (await ver()).some((x) => x.nome === 'roteiro' && x.args[0] === true))
  const lista1 = await js('({ ed: !!document.querySelector(".ed"), itens: [...document.querySelectorAll(".item-lbl")].map(e => e.textContent), grupos: [...document.querySelectorAll(".grp span:first-child")].map(e => e.textContent), todos: !!document.querySelector(".item-lbl .esc") })')
  conta('o editor fecha e a mensagem aparece na lista', !lista1.ed && lista1.itens.includes('Meu bom dia'), JSON.stringify(lista1))
  conta('no grupo "Meus itens", em cima do oficial', lista1.grupos[0] === 'Meus itens' && lista1.itens.indexOf('Meu bom dia') < lista1.itens.indexOf('Bom dia'), JSON.stringify(lista1.grupos))
  conta('com o icone de "todos veem"', lista1.todos)

  // ── FOTO ─────────────────────────────────────────────────────────────────────────────────────
  console.log('\nFOTO')
  await clica('#novo'); await espera(100)
  await clica('[data-novo="image"]'); await espera(100)
  conta('a foto abre com o botao grande de escolher', !!(await js('document.querySelector(".ed-arq")')))
  conta('o seletor aceita so JPG e PNG', await js('document.querySelector("[data-ed=arquivo]").accept === "image/jpeg,image/png"'))
  await poeArquivo(PNG, 'tabela-nova.png', 'image/png'); await espera(200)
  const pv = await js('({ src: (document.querySelector(".ed-midia img") || {}).src || "", nome: document.querySelector("[data-k=ed-nome]").value })')
  conta('escolhida, a foto aparece na previa antes de subir', /^blob:/.test(pv.src), pv.src)
  conta('e o nome do arquivo vira o nome do item', pv.nome === 'tabela-nova', pv.nome)
  await digita('ed-legenda', 'olha a tabela')
  await clica('[data-ed="salva"]'); await espera(500)
  const up = await ultima('sobeMidia')
  conta('salvar sobe o arquivo como image/png, com os bytes do PNG', up && up.args[0] === 'image/png' && up.args[1] === 70 && up.args[2].slice(1) === 'PNG', JSON.stringify(up && up.args))
  s = await ultima('salvaItem')
  conta('e grava o item com a chave que voltou, legenda e "so eu"', s && s.args[0].tipo === 'image' && /^m\/novo/.test(s.args[0].key) && s.args[0].caption === 'olha a tabela' && s.args[0].escopo === 'eu', JSON.stringify(s && s.args[0]))
  await clica('#novo'); await espera(100)
  await clica('[data-novo="image"]'); await espera(100)
  await poeArquivo('R0lGODlhAQABAAAAACw=', 'x.gif', 'image/gif'); await espera(150)
  conta('GIF e recusado com o recado', /JPG ou PNG/.test(await texto()), (await texto()).slice(0, 100))
  await clica('[data-ed="volta"]'); await espera(100)
  conta('voltar de um item novo leva pra escolha do tipo', !!(await js('document.querySelector("[data-novo]")')))
  await clica('[data-ed="volta"]'); await espera(100)
  conta('e voltar de novo leva pra lista', !(await js('document.querySelector(".ed")')) && !!(await js('document.querySelector(".item")')))

  // ── AUDIO ESCOLHIDO DO COMPUTADOR VIRA OGG ───────────────────────────────────────────────────
  console.log('\nAUDIO')
  await clica('#novo'); await espera(100)
  await clica('[data-novo="audio"]'); await espera(100)
  conta('o audio abre com o botao de gravar e o de escolher arquivo', !!(await js('document.querySelector(".grav-bt[data-ed=grava]")')) && !!(await js('document.querySelector("[data-ed=escolhe]")')))
  // um WAV de 1 s (seno de 440 Hz, 8 kHz, 16 bits), montado aqui mesmo
  await js(`(() => {
    const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000), true)
    const dt = new DataTransfer(); dt.items.add(new File([buf], 'explicacao.wav', { type: 'audio/wav' }))
    const i = document.querySelector('[data-ed=arquivo]'); i.files = dt.files; i.dispatchEvent(new Event('change'))
  })()`)
  await espera(200)
  conta('escolhido, o audio aparece pra ouvir antes de salvar', /^blob:/.test(await js('(document.querySelector(".grav audio") || {}).src || ""')))
  await clica('[data-ed="salva"]')
  for (let i = 0; i < 30 && !(await ultima('sobeMidia') || {}).args?.[0]?.startsWith('audio'); i++) await espera(200)
  const upa = await ultima('sobeMidia')
  conta('o WAV sobe convertido em OGG/Opus (nota de voz)', upa && upa.args[0] === 'audio/ogg' && upa.args[2] === 'OggS', JSON.stringify(upa && upa.args))
  await espera(300)
  s = await ultima('salvaItem')
  conta('e o item de audio e gravado', s && s.args[0].tipo === 'audio' && s.args[0].label === 'explicacao', JSON.stringify(s && s.args[0]))

  // ── DOCUMENTO (PDF) ──────────────────────────────────────────────────────────────────────────
  console.log('\nDOCUMENTO')
  await clica('#novo'); await espera(100)
  await clica('[data-novo="document"]'); await espera(100)
  const d0 = await js('({ titulo: (document.querySelector(".ed-topo b") || {}).textContent, bt: (document.querySelector(".ed-arq") || {}).textContent || "", aceita: (document.querySelector("[data-ed=arquivo]") || {}).accept })')
  conta('abre o "Novo documento" com o botao de escolher PDF', d0.titulo === 'Novo documento' && /Escolher PDF/.test(d0.bt) && /32 MB/.test(d0.bt), JSON.stringify(d0))
  conta('o seletor so oferece PDF', d0.aceita === 'application/pdf,.pdf', d0.aceita)
  await poeArquivo(PNG, 'foto.png', 'image/png'); await espera(150)
  conta('foto no lugar do PDF e recusada com o recado', /Use um arquivo PDF/.test(await texto()), (await texto()).slice(0, 100))
  await js('(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(33 * 1048576)], "grande.pdf", { type: "application/pdf" })); const i = document.querySelector("[data-ed=arquivo]"); i.files = dt.files; i.dispatchEvent(new Event("change")) })()')
  await espera(150)
  conta('PDF acima de 32 MB e recusado antes de subir (o envio nao aguentaria)', /O limite é 32 MB/.test(await texto()) && !(await js('document.querySelector(".ed-doc")')), (await texto()).slice(0, 100))
  // PDF que o Windows entrega sem tipo (acontece): vale pela extensao, e sobe como application/pdf
  await poeArquivo('JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDw+PgplbmRvYmoKdHJhaWxlcgo8PD4+CiUlRU9G', 'Bula GlicoSix.pdf', ''); await espera(150)
  const d1 = await js('({ card: (document.querySelector(".ed-doc b") || {}).textContent, info: (document.querySelector(".ed-doc .t span") || {}).textContent, nome: document.querySelector("[data-k=ed-nome]").value, erro: !!document.querySelector(".aviso.ruim") })')
  conta('escolhido, o PDF aparece num cartao com o nome e o tamanho', d1.card === 'Bula GlicoSix.pdf' && /^PDF · 1 MB$/.test(d1.info) && !d1.erro, JSON.stringify(d1))
  conta('e o nome do arquivo vira o nome do item (sem o .pdf)', d1.nome === 'Bula GlicoSix', d1.nome)
  await digita('ed-legenda', 'segue a bula')
  await clica('[data-quem="todos"]'); await espera(80)
  await clica('[data-ed="salva"]')
  for (let i = 0; i < 20 && (((await ultima('sobeMidia')) || {}).args || [])[0] !== 'application/pdf'; i++) await espera(150)
  const upd = await ultima('sobeMidia')
  conta('salvar sobe o arquivo como application/pdf, com os bytes do PDF', upd && upd.args[0] === 'application/pdf' && upd.args[2] === '%PDF', JSON.stringify(upd && upd.args))
  await espera(300)
  s = await ultima('salvaItem')
  conta('e grava o documento com nome, legenda e "todos"', s && s.args[0].tipo === 'document' && s.args[0].label === 'Bula GlicoSix' && s.args[0].caption === 'segue a bula' && s.args[0].mime === 'application/pdf' && s.args[0].escopo === 'todos', JSON.stringify(s && s.args[0]))
  const d2 = await js('({ secoes: [...document.querySelectorAll(".sec span:first-of-type")].map(e => e.textContent), itens: [...document.querySelectorAll(".item-lbl")].map(e => e.textContent) })')
  conta('o documento aparece na lista, na secao Documentos', d2.itens.some((x) => /Bula GlicoSix/.test(x)) && d2.secoes.some((x) => /Documentos/.test(x)), JSON.stringify(d2))
  // o lapis no documento salvo: o cartao abre o arquivo na janela do app
  await clica('#organizar'); await espera(120)
  const idDoc = await js('(() => { const it = [...document.querySelectorAll(".item")].find(i => /Bula GlicoSix/.test(i.textContent)); const b = it && it.querySelector("[data-edita]"); return b ? b.dataset.edita : "" })()')
  await clica('[data-edita="' + idDoc + '"]'); await espera(150)
  const d3 = await js('({ titulo: (document.querySelector(".ed-topo b") || {}).textContent, card: (document.querySelector("button.ed-doc b") || {}).textContent, leg: (document.querySelector("[data-k=ed-legenda]") || {}).value })')
  conta('editar o documento mostra o PDF salvo e a legenda', d3.titulo === 'Editar documento' && d3.card === 'PDF salvo' && d3.leg === 'segue a bula', JSON.stringify(d3))
  await clica('button.ed-doc'); await espera(150)
  const ab = await ultima('abrirMidia')
  conta('tocar no cartao abre o PDF no app', ab && /^m\/novo/.test(ab.args[0]) && ab.args[1] === 'Bula GlicoSix', JSON.stringify(ab && ab.args))
  await clica('[data-ed="volta"]'); await espera(100)
  await clica('[data-org="pronto"]'); await espera(100)

  // ── ORGANIZAR: ESCONDER, EDITAR, APAGAR ──────────────────────────────────────────────────────
  console.log('\nORGANIZAR')
  await clica('#organizar'); await espera(150)
  const org = await js('({ barra: !!document.querySelector(".org-barra"), olhos: document.querySelectorAll("[data-olho]").length, lapis: [...document.querySelectorAll("[data-edita]")].map(e => e.dataset.edita), estrelas: document.querySelectorAll(".estrela").length, play: document.querySelectorAll("[data-envia]").length })')
  conta('o lapis liga o modo organizar, com a faixa e um olho em cada item', org.barra && org.olhos >= 7, JSON.stringify(org))
  conta('so o que e meu ganha o lapis (o oficial nao)', org.lapis.length === 4 &&!org.lapis.some((x) => /m1|a1|i1|m2/.test(x)), JSON.stringify(org.lapis))
  conta('a estrela e o play saem enquanto organiza', org.estrelas === 0 && org.play === 0, JSON.stringify(org))
  await clica('[data-olho="m1"]'); await espera(200)
  let oc = await ultima('ocultar')
  conta('o olho esconde o item oficial', oc && oc.args[0] === 'm1' && oc.args[1] === true, JSON.stringify(oc && oc.args))
  conta('e ele fica apagado na lista enquanto organiza', await js('!!document.querySelector("[data-olho=m1]").closest(".item.oculto")'))
  await clica('[data-org="pronto"]'); await espera(150)
  let lbls = await js('[...document.querySelectorAll(".item-lbl")].map(e => e.textContent)')
  conta('fora do modo organizar o escondido some da lista', !lbls.includes('Bom dia'), JSON.stringify(lbls))
  conta('e aparece o aviso "1 escondido"', /1 escondido/.test(await js('(document.querySelector(".ocultos-link") || {}).textContent || ""')))
  await clica('.ocultos-link'); await espera(150)
  await clica('[data-olho="m1"]'); await espera(200)
  oc = await ultima('ocultar')
  conta('pelo aviso volta pro organizar, e o olho mostra de novo', oc && oc.args[0] === 'm1' && oc.args[1] === false, JSON.stringify(oc && oc.args))
  // editar a mensagem minha
  const idTexto = (await ver()).find((x) => x.nome === 'salvaItem' && x.args[0].tipo === 'text') ? 'swteste1' : ''
  await clica('[data-edita="item:' + idTexto + '"]'); await espera(150)
  const ed = await js('({ titulo: (document.querySelector(".ed-topo b") || {}).textContent, nome: (document.querySelector("[data-k=ed-nome]") || {}).value, txt: (document.querySelector("[data-k=ed-texto]") || {}).value, todos: document.querySelector("[data-quem=todos]").classList.contains("on"), lixo: !!document.querySelector("[data-ed=apaga]") })')
  conta('o lapis abre o editor com tudo preenchido', ed.titulo === 'Editar mensagem' && ed.nome === 'Meu bom dia' && ed.txt === 'Bom dia, *tudo bem*?' && ed.todos && ed.lixo, JSON.stringify(ed))
  await digita('ed-texto', 'Bom dia de novo')
  await clica('[data-quem="eu"]'); await espera(80)
  await js('window.__falhaSalvar(1)')
  await clica('[data-ed="salva"]'); await espera(300)
  conta('servidor recusando: o editor fica aberto e mostra o motivo', /Só quem criou/.test(await texto()) && !!(await js('document.querySelector(".ed")')), (await texto()).slice(0, 120))
  await clica('[data-ed="salva"]'); await espera(400)
  s = await ultima('salvaItem')
  conta('salvar de novo manda o id, o texto novo e "so eu"', s && s.args[0].id === idTexto && s.args[0].text === 'Bom dia de novo' && s.args[0].escopo === 'eu', JSON.stringify(s && s.args[0]))
  // apagar com dois cliques
  await clica('#organizar'); await espera(120)
  if (!(await js('!!document.querySelector(".org-barra")'))) { await clica('#organizar'); await espera(120) }
  await clica('[data-apaga="' + idTexto + '"]'); await espera(120)
  conta('o primeiro clique na lixeira so arma ("Apagar?")', /Apagar\?/.test(await js('document.querySelector("[data-apaga=' + idTexto + ']").textContent')) && (await conta1('apagaItem')) === 0)
  await clica('[data-apaga="' + idTexto + '"]'); await espera(400)
  const ap = await ultima('apagaItem')
  conta('o segundo apaga', ap && ap.args[0] === idTexto, JSON.stringify(ap && ap.args))
  lbls = await js('[...document.querySelectorAll(".item-lbl")].map(e => e.textContent)')
  conta('e ele some da lista', !lbls.some((x) => /Bom dia de novo|Meu bom dia/.test(x)), JSON.stringify(lbls))
  await clica('[data-org="pronto"]'); await espera(100)

  // ── FUNIL COM TEMPO ──────────────────────────────────────────────────────────────────────────
  console.log('\nFUNIL')
  await clica('.aba[data-aba="funis"]'); await espera(150)
  conta('na aba Funis o + e o lapis continuam ali', await js('!document.getElementById("novo").hidden && !document.getElementById("organizar").hidden'))
  await clica('#novo'); await espera(120)
  conta('o + abre o funil novo direto', (await js('(document.querySelector(".ed-topo b") || {}).textContent')) === 'Novo funil')
  await clica('[data-ed="salva"]'); await espera(120)
  conta('sem nome, pede o nome', /nome pro funil/.test(await texto()))
  await digita('ed-nome', 'Meu fechamento')
  await clica('[data-ed="escolher"]'); await espera(120)
  const opcoes = await js('[...document.querySelectorAll("button.item-lbl[data-poe]")].map(e => e.dataset.poe)')
  conta('a lista de passos traz os itens, inclusive os meus', opcoes.includes('m2') && opcoes.includes('a1') && opcoes.some((x) => /^swteste/.test(x)), JSON.stringify(opcoes))
  await digita('ed-busca', 'valor'); await espera(120)
  const filtrado = await js('[...document.querySelectorAll("button.item-lbl[data-poe]")].map(e => e.dataset.poe)')
  conta('e a busca filtra', filtrado.length === 1 && filtrado[0] === 'm2', JSON.stringify(filtrado))
  await clica('button.item-lbl[data-poe="m2"]'); await espera(120)
  await clica('[data-ed="escolher"]'); await espera(100)
  await clica('button.item-lbl[data-poe="a1"]'); await espera(100)
  await clica('[data-ed="escolher"]'); await espera(100)
  await clica('button.item-lbl[data-poe="i1"]'); await espera(100)
  let passos = await js('[...document.querySelectorAll(".ed-passo .l")].map(e => e.textContent)')
  conta('tres passos na ordem em que foram colocados', passos.join('|') === 'Valores|H - 02 Explicacao|Tabela 497', JSON.stringify(passos))
  conta('o relogio aparece ENTRE os passos (dois, nao tres)', (await js('document.querySelectorAll("[data-esp]").length')) === 2)
  conta('e nasce no "padrao"', /padrão/.test(await js('document.querySelector("[data-esp=\'1\']").textContent')))
  await clica('[data-esp="2"]'); await espera(100)
  const ops = await js('[...document.querySelectorAll(".esp-op")].map(e => e.textContent).join(",")')
  conta('tocar no relogio mostra os tempos', ops === 'Padrão,Na hora,5 s,10 s,30 s,1 min,2 min', ops)
  await clica('[data-espv="2:60"]'); await espera(100)
  conta('e o escolhido fica no relogio', /1 min/.test(await js('document.querySelector("[data-esp=\'2\']").textContent')))
  await clica('[data-sobe="2"]'); await espera(100)
  passos = await js('[...document.querySelectorAll(".ed-passo .l")].map(e => e.textContent)')
  conta('a seta de subir troca a ordem', passos.join('|') === 'Valores|Tabela 497|H - 02 Explicacao', JSON.stringify(passos))
  await clica('[data-tira="2"]'); await espera(100)
  passos = await js('[...document.querySelectorAll(".ed-passo .l")].map(e => e.textContent)')
  conta('o X tira o passo', passos.join('|') === 'Valores|Tabela 497', JSON.stringify(passos))
  await clica('[data-ed="salva"]'); await espera(400)
  s = await ultima('salvaItem')
  conta('salvar manda os passos com o tempo de cada um', s && s.args[0].tipo === 'funil' && JSON.stringify(s.args[0].passos) === JSON.stringify([{ id: 'm2', espera: null }, { id: 'i1', espera: 60 }]), JSON.stringify(s && s.args[0]))
  const funis = await js('[...document.querySelectorAll(".funil-lbl")].map(e => e.firstChild.textContent)')
  conta('o funil aparece em cima, em "Meus funis"', funis[0] === 'Meu fechamento', JSON.stringify(funis))
  // disparar o funil meu: o tempo vai junto pro envio
  const idFunil = await js('(document.querySelector("[data-funil]") || {}).dataset?.funil || ""')
  await clica('[data-funil="' + idFunil + '"]')
  for (let i = 0; i < 20 && (await conta1('manda')) < 2; i++) await espera(150)
  const mandas = (await ver()).filter((x) => x.nome === 'manda').map((x) => x.args[2])
  conta('disparar manda os dois passos', mandas.length === 2, JSON.stringify(mandas.map((x) => x.tipo + ':' + (x.kind || ''))))
  conta('o primeiro sem tempo escolhido (vai na regra)', mandas[0] && mandas[0].espera === undefined, JSON.stringify(mandas[0]))
  conta('o segundo leva os 60 s escolhidos', mandas[1] && mandas[1].espera === 60, JSON.stringify(mandas[1]))
  await espera(300)
  await clica('[data-abre="funil:' + idFunil + '"]'); await espera(120)
  conta('a previa do funil mostra o tempo escolhido', /1 min/.test(await js('(document.querySelector(".passo-pausa.fixo") || {}).textContent || ""')))
  // copiar o oficial
  await clica('#organizar'); await espera(120)
  conta('no oficial o organizar oferece copiar (e nao editar)', !!(await js('document.querySelector("[data-copia=s1]")')) && !(await js('document.querySelector("[data-edita=\'funil:s1\']")')))
  await clica('[data-copia="s1"]'); await espera(120)
  const cp = await js('({ nome: document.querySelector("[data-k=ed-nome]").value, passos: [...document.querySelectorAll(".ed-passo .l")].map(e => e.textContent), titulo: document.querySelector(".ed-topo b").textContent })')
  conta('copiar abre um funil NOVO com os passos do oficial', cp.titulo === 'Novo funil' && cp.nome === 'Cópia de Boas-vindas' && cp.passos.join('|') === 'Bom dia|H - 02 Explicacao', JSON.stringify(cp))
  await clica('[data-ed="volta"]'); await espera(100)
  await clica('#organizar'); await espera(100)
  if (!(await js('!!document.querySelector(".org-barra")'))) { await clica('#organizar'); await espera(100) }
  await clica('[data-olho="s1"]'); await espera(200)
  await clica('[data-org="pronto"]'); await espera(120)
  const funis2 = await js('[...document.querySelectorAll(".funil-lbl")].map(e => e.firstChild.textContent)')
  conta('funil escondido some da aba Funis', !funis2.includes('Boas-vindas') && /1 escondido/.test(await js('(document.querySelector(".ocultos-link") || {}).textContent || ""')), JSON.stringify(funis2))

  // ── GRUPOS: ESCOLHER, CRIAR, ORDENAR, RENOMEAR ──────────────────────────────────────────────
  console.log('\nGRUPOS')
  // { secao: [ [grupo, [itens]] ] } lido da tela, na ordem em que aparece
  const mapa = () => js(`(() => {
    const out = {}; let sec = '', grp = ''
    for (const el of document.getElementById('corpo').children) {
      if (el.classList.contains('sec')) { sec = el.dataset.sec; out[sec] = []; grp = '' }
      else if (el.classList.contains('grp')) { grp = (el.querySelector('span') || {}).textContent || (el.querySelector('input') || {}).value || ''; out[sec].push([grp, []]) }
      else if (el.classList.contains('item') && sec) { if (!out[sec].length) out[sec].push(['', []]); out[sec][out[sec].length - 1][1].push((el.querySelector('.item-lbl') || {}).textContent || '') }
    }
    return out })()`)
  await clica('.aba[data-aba="itens"]'); await espera(120)
  await clica('#novo'); await espera(100)
  await clica('[data-novo="text"]'); await espera(100)
  const chips = await js('[...document.querySelectorAll(".ed-grp")].map(e => e.textContent + (e.classList.contains("on") ? "*" : ""))')
  conta('o editor mostra os grupos que existem, com "Meus itens" marcado', chips.join('|') === 'Meus itens*|Homem|Follow|Novo', JSON.stringify(chips))
  await clica('[data-grpesc="Follow"]'); await espera(80)
  conta('tocar num grupo marca ele', await js('document.querySelector("[data-grpesc=Follow]").classList.contains("on") && !document.querySelector("[data-grpesc=\'\']").classList.contains("on")'))
  await digita('ed-nome', 'Ainda quer?'); await digita('ed-texto', 'Ainda quer o produto?')
  await clica('[data-ed="salva"]'); await espera(400)
  s = await ultima('salvaItem')
  conta('salvar manda o grupo escolhido', s && s.args[0].grp === 'Follow' && s.args[0].tipo === 'text', JSON.stringify(s && s.args[0]))
  let mp = await mapa()
  conta('a mensagem entra no grupo Follow, junto do oficial', JSON.stringify(mp.text) === JSON.stringify([['Homem', ['Bom dia']], ['Follow', ['Ainda quer?', 'Valores']]]), JSON.stringify(mp.text))
  conta('e o Follow NAO pula pra cima do Homem (a ordem da dash fica)', mp.text[0][0] === 'Homem', JSON.stringify(mp.text.map((x) => x[0])))
  // grupo novo, digitado e salvo sem tocar no visto
  await clica('#novo'); await espera(100)
  await clica('[data-novo="text"]'); await espera(100)
  await clica('[data-grpnovo="abre"]'); await espera(100)
  conta('o "Novo" abre o campo do nome ja com o cursor', await js('document.activeElement && document.activeElement.dataset.k === "ed-grupo"'))
  await digita('ed-grupo', '  Recuperação ')
  await digita('ed-nome', 'Vamos resolver?')
  await digita('ed-texto', 'Vamos resolver?')
  await clica('[data-ed="salva"]'); await espera(400)
  s = await ultima('salvaItem')
  conta('o grupo novo vai junto mesmo sem tocar no visto', s && s.args[0].grp === 'Recuperação', JSON.stringify(s && s.args[0]))
  mp = await mapa()
  conta('o grupo novo aparece EM CIMA (acabou de criar)', mp.text[0][0] === 'Recuperação' && mp.text[0][1][0] === 'Vamos resolver?', JSON.stringify(mp.text))
  // mesmo nome com outra caixa nao cria outro
  await clica('#novo'); await espera(100)
  await clica('[data-novo="text"]'); await espera(100)
  await clica('[data-grpnovo="abre"]'); await espera(80)
  await digita('ed-grupo', 'follow')
  await js('document.querySelector("[data-k=ed-grupo]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))'); await espera(100)
  const chips2 = await js('[...document.querySelectorAll(".ed-grp")].map(e => e.textContent + (e.classList.contains("on") ? "*" : ""))')
  conta('digitar "follow" usa o Follow que ja existe (sem repetir)', chips2.filter((x) => /follow/i.test(x)).join('|') === 'Follow*', JSON.stringify(chips2))
  await clica('[data-ed="volta"]'); await espera(80); await clica('[data-ed="volta"]'); await espera(100)
  // o editar abre com o grupo do item
  await clica('#organizar'); await espera(120)
  const idFollow = await js('(() => { const it = [...document.querySelectorAll(".item")].find(i => /Ainda quer\\?/.test(i.textContent)); const b = it && it.querySelector("[data-edita]"); return b ? b.dataset.edita : "" })()')
  await clica('[data-edita="' + idFollow + '"]'); await espera(120)
  conta('editar abre com o grupo do item marcado', await js('document.querySelector("[data-grpesc=Follow]").classList.contains("on")'))
  await clica('[data-ed="volta"]'); await espera(100)
  // organizar: setas e renomear
  // so os cabecalhos da secao de Mensagens (Homem tambem existe nas secoes de audio e foto)
  const cabTxt = await js(`(() => { const out = []; let sec = ''
    for (const el of document.getElementById('corpo').children) {
      if (el.classList.contains('sec')) sec = el.dataset.sec
      else if (sec === 'text' && el.classList.contains('grp') && el.querySelector('.grp-ops')) out.push({ n: el.querySelector('span').textContent, ren: !!el.querySelector('[data-grpren]'), sobe: !el.querySelector('[data-grpmove=sobe]').disabled })
    }
    return out })()`)
  const cab = cabTxt
  conta('no organizar cada grupo ganha as setas', cabTxt.length === 3, JSON.stringify(cab))
  conta('so o grupo que e todo meu ganha o lapis (o Follow tem item oficial)', cabTxt.find((c) => c.n === 'Recuperação')?.ren && !cabTxt.find((c) => c.n === 'Follow')?.ren && !cabTxt.find((c) => c.n === 'Homem')?.ren, JSON.stringify(cabTxt))
  conta('o primeiro grupo nao sobe', cabTxt.find((c) => c.n === 'Recuperação')?.sobe === false, JSON.stringify(cabTxt))
  await clica('[data-grpmove="sobe"][data-grp="Follow"]'); await espera(200)
  const go = await ultima('grupoOrdem')
  conta('subir o Follow grava a ordem com ele antes do Homem', go && go.args[0] === 'itens' && go.args[1].indexOf('Follow') < go.args[1].indexOf('Homem') && go.args[1][0] === 'Recuperação', JSON.stringify(go && go.args))
  mp = await mapa()
  conta('e a lista ja mostra na ordem nova', JSON.stringify(mp.text.map((x) => x[0])) === JSON.stringify(['Recuperação', 'Follow', 'Homem']), JSON.stringify(mp.text.map((x) => x[0])))
  await clica('[data-grpren="Recuperação"]'); await espera(120)
  conta('o lapis troca o nome por um campo, ja com o cursor', await js('document.activeElement && document.activeElement.dataset.k === "grp-nome" && document.activeElement.value === "Recuperação"'))
  await digita('grp-nome', 'Resgate')
  await js('document.querySelector("[data-k=grp-nome]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))'); await espera(400)
  const rn = await ultima('grupoRenomear')
  conta('Enter renomeia o grupo', rn && JSON.stringify(rn.args) === JSON.stringify(['itens', 'Recuperação', 'Resgate']), JSON.stringify(rn && rn.args))
  mp = await mapa()
  conta('e o grupo aparece com o nome novo, no mesmo lugar', JSON.stringify(mp.text.map((x) => x[0])) === JSON.stringify(['Resgate', 'Follow', 'Homem']), JSON.stringify(mp.text))
  await clica('[data-org="pronto"]'); await espera(120)
  conta('fora do organizar o cabecalho volta a ser so o nome', !(await js('document.querySelector(".grp-ops")')))
  // o funil tambem escolhe grupo
  await clica('.aba[data-aba="funis"]'); await espera(120)
  await clica('#novo'); await espera(120)
  conta('o funil novo tambem escolhe o grupo, com "Meus funis" marcado', ((await js('[...document.querySelectorAll(".ed-grp.on")].map(e => e.textContent)')) || []).join('|') === 'Meus funis')
  await clica('[data-ed="volta"]'); await espera(100)

  // ── TROCAR DE ABA FECHA O EDITOR ─────────────────────────────────────────────────────────────
  await clica('#novo'); await espera(100)
  await clica('.aba[data-aba="itens"]'); await espera(120)
  conta('trocar de aba fecha o editor e volta a lista', !(await js('document.querySelector(".ed")')) && !!(await js('document.querySelector(".item")')))

  conta('nenhum erro de javascript na tela', !erros.length, erros.slice(0, 3).join(' | '))
  console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram')
  app.exit(falhas.length ? 1 : 0)
}).catch((e) => { console.log('QUEBROU em ' + ponto + ': ' + (e && e.stack)); app.exit(1) })
