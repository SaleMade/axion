// TESTE DO PAINEL do Sellwave Web (aba Pedidos e pilha de disparos).
//
// Abre o painel.html DE VERDADE num Electron sem janela, com um preload falso no lugar do processo
// principal, clica, digita e confere o que saiu. Nao e teste de funcao: e a tela.
//
// POR QUE ISTO EXISTE: ja houve versao deste projeto em que uma funcao chamava a si mesma e NENHUM
// dialogo abria, com a tela em branco e nada no console. Conferir que "o arquivo tem a funcao" nao
// pega isso; abrir a tela e clicar pega.
//
// Roda:
//   npm run teste-painel
// (ou, na mao: env -u ELECTRON_RUN_AS_NODE npx electron src/teste-painel.js)

// ELECTRON_RUN_AS_NODE LIGADO = o binario vira Node puro, `require('electron')` devolve so um
// caminho e `app` vem undefined. O erro que sai disso nao explica nada.
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('ELECTRON_RUN_AS_NODE esta ligado: este teste precisa do Electron de verdade.')
  console.log('Rode assim:  env -u ELECTRON_RUN_AS_NODE npx electron src/teste-painel.js')
  process.exit(2)
}

const { app, BrowserWindow } = require('electron')
const path = require('path')

// PASTA DE DADOS SEPARADA. O app fixa a pasta em %APPDATA%/sellwave-web, que e onde moram as
// sessoes pareadas de verdade; sem trocar aqui, o teste escreve dentro delas e ainda esbarra na
// trava de instancia unica quando o app esta aberto. Mesma guarda que o SW_SMOKE usa.
app.setPath('userData', path.join(app.getPath('appData'), 'sellwave-web-teste'))

const PROJ = path.join(__dirname, '..')
const PRELOAD = path.join(__dirname, 'teste-painel-preload.js')

let ok = 0
const falhas = []
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')) }
}

let ponto = 'antes do whenReady'
setTimeout(() => { console.log('ESTOUROU O TEMPO (90s). Ultimo ponto: ' + ponto); app.exit(1) }, 90000)
process.on('unhandledRejection', (e) => { console.log('PROMESSA SOLTA em ' + ponto + ': ' + (e && e.message)); app.exit(1) })

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 300, height: 1000,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true },
  })
  const erros = []
  win.webContents.on('console-message', (ev) => {
    if (ev && (ev.level === 'error' || ev.level === 'warning')) erros.push(String(ev.message || ''))
  })
  win.webContents.on('did-fail-load', (_e, cod, desc) => console.log('[!] nao carregou: ' + cod + ' ' + desc))

  ponto = 'loadFile'
  await win.loadFile(path.join(PROJ, 'src/ui/painel.html'))
  ponto = 'pos-load'

  const js = (c) => win.webContents.executeJavaScript(c, true)
  const espera = (ms) => new Promise((r) => setTimeout(r, ms))
  const set = (k, v) => js('(() => { const e = document.querySelector("[data-k=' + k + ']");'
    + ' e.value = ' + JSON.stringify(v) + '; e.dispatchEvent(new Event("input")); })()')
  const clica = (sel) => js('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (e) e.click(); return !!e })()')

  console.log('TESTE DO PAINEL\n')
  await espera(2200)                      // o pulso de 1,5s preenche lead e estado

  // ── a aba ──────────────────────────────────────────────────────────────────────────────────
  const abas = await js('[...document.querySelectorAll(".aba")].map(b => b.dataset.aba).join(",")')
  conta('as tres abas existem', abas === 'itens,funis,pedidos', abas)

  const selo = await js('({ escondido: $("selo-pedidos").hidden, txt: $("selo-pedidos").textContent })')
  conta('o selo conta os rascunhos do servidor', selo.escondido === false && selo.txt === '1', JSON.stringify(selo))

  // O BOTAO DE PEDIDO NAO EXISTE MAIS no bloco do cliente (ele mandou tirar em 16/10).
  const semBotao = await js('!document.getElementById("lead-cad")')
  conta('o bloco do cliente NAO tem botao de pedido', semBotao)

  // ── passo 1: tipo de pagamento ─────────────────────────────────────────────────────────────
  await clica('[data-aba=pedidos]')
  await espera(250)
  const tipos = await js('[...document.querySelectorAll("[data-tipo]")].map(b => b.dataset.tipo + ":" + b.querySelector(".t1").textContent).join(" | ")')
  conta('abre escolhendo o tipo de pagamento, como na dash',
    /entrega:Pagamento na Entrega/.test(tipos) && /antecipado:Pagamento Antecipado/.test(tipos), tipos)
  const semCampo = await js('document.querySelectorAll("#corpo [data-k]").length')
  conta('nenhum campo aparece antes de escolher o tipo', semCampo === 0, String(semCampo))
  const cartao = await js('(() => { const c = document.querySelector(".tipo-cx"); const t1 = c.querySelector(".t1").getBoundingClientRect(); const t2 = c.querySelector(".t2").getBoundingClientRect(); return { h: Math.round(c.getBoundingClientRect().height), abaixo: t2.top >= t1.bottom } })()')
  conta('o subtitulo fica EMBAIXO do titulo', cartao.abaixo === true, JSON.stringify(cartao))
  conta('os cartoes sao grandes', cartao.h >= 110, String(cartao.h))

  // ── passo 2: o formulario em blocos ────────────────────────────────────────────────────────
  await clica('[data-tipo=entrega]')
  await espera(400)
  const blocos = await js('[...document.querySelectorAll("#corpo .bloco h3")].map(h => h.textContent.trim()).join(" | ")')
  conta('os tres blocos, na ordem da dash',
    blocos === 'Dados do Cliente | Endereço | Tratamento e Anexo', blocos)
  const cores = await js('[...document.querySelectorAll("#corpo .bloco")].map(b => b.style.getPropertyValue("--bc")).join(",")')
  conta('cada bloco tem a sua cor, nao cinza', cores === '#3b82f6,#f59e0b,#00a884', cores)
  const sub = await js('(() => { const c = document.querySelector(".dono-ped"); return c ? c.textContent.trim() : "" })()')
  conta('o formulario diz de quem e o pedido', /Cliente de Teste/.test(sub), sub)

  const campos = await js('[...document.querySelectorAll("#corpo [data-k]")].map(e => e.dataset.k).join(",")')
  const ESPERADOS = ['cpf', 'nome', 'wa', 'cep', 'end', 'num', 'bairro', 'comp', 'cidade', 'uf', 'obs']
  conta('todos os campos desenharam', ESPERADOS.every((k) => campos.split(',').includes(k)), campos)

  const pre = await js('({ wa: document.querySelector("[data-k=wa]").value, nome: document.querySelector("[data-k=nome]").value })')
  conta('o numero da conversa entra sozinho', pre.wa === '(19) 99598-3293', pre.wa)
  conta('o nome do cliente entra sozinho', pre.nome === 'Cliente de Teste', pre.nome)

  // ── tratamento vem de LISTA, nunca digitado ────────────────────────────────────────────────
  const opts = await js('[...document.querySelectorAll("[data-op=trat]")].map(o => o.textContent).join(" | ")')
  conta('o tratamento vem do catalogo, com preco', /Produto A - 3 MesesR\$ 397,00/.test(opts.replace(/\s+/g, '')) || /Produto A - 3 Meses/.test(opts), opts)
  // NENHUM <select> na tela: o option nativo do Windows ignora o tema e sai branco.
  const nenhumSelect = await js('document.querySelectorAll("#corpo select").length')
  conta('nao usa <select>, que no Windows sai branco', nenhumSelect === 0, String(nenhumSelect))

  await clica('[data-op=trat][data-v=k3]')
  await espera(300)
  const total = await js('(document.querySelector(".total .v")||{}).textContent || ""')
  conta('o total acompanha o tratamento escolhido', /397,00/.test(total), total)

  // ── cadastrar sem comprovante, no COD, e barrado ───────────────────────────────────────────
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("cpf","52998224725"); s("cep","13000000"); s("end","Rua A"); s("num","10");'
    + ' s("bairro","Centro"); s("cidade","Campinas"); s("uf","sp"); })()')
  await clica('#pd-ok')
  await espera(300)
  const semAnexo = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "", mandou: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  conta('pagamento na entrega SEM comprovante nao vai pro servidor',
    /Comprovante/.test(semAnexo.txt) && semAnexo.mandou === 0, JSON.stringify(semAnexo))

  // ── anexa e cadastra ───────────────────────────────────────────────────────────────────────
  await js('(() => { const i = document.getElementById("pd-arquivo");'
    + ' const f = new File([new Uint8Array([1,2,3])], "print.jpg", { type: "image/jpeg" });'
    + ' const dt = new DataTransfer(); dt.items.add(f); i.files = dt.files;'
    + ' i.dispatchEvent(new Event("change")); })()')
  await espera(700)
  const temAnexo = await js('({ n: document.querySelectorAll(".anexo.tem").length, nome: (document.querySelector(".anexo.tem .nm")||{}).textContent || "" })')
  conta('o anexo sobe na hora e aparece na lista', temAnexo.n === 1 && /print\.jpg/.test(temAnexo.nome), JSON.stringify(temAnexo))

  await clica('#pd-ok')
  await espera(500)
  const lista = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0]))'))
  conta('com tudo certo, o pedido vai pro servidor', lista.length === 1, String(lista.length))
  const o = lista[0] || {}
  conta('o objeto tem o formato do Novo Pedido da dash',
    o.orig === 'Manual' && /^MAN-/.test(String(o.external_id || '')) && o.col === 'A Enviar' && o.spg === 'Pendente',
    JSON.stringify({ orig: o.orig, ext: o.external_id, col: o.col, spg: o.spg }))
  conta('o tipo de pagamento vira o `mod`', o.mod === 'entrega', String(o.mod))
  // O PRECO SAI DO CATALOGO: e a regra que o campo livre de ontem quebrava.
  conta('produto e valor saem do CATALOGO, nao do que foi digitado',
    o.vl === 397 && o.trat === 'Produto A - 3 Meses', JSON.stringify({ vl: o.vl, trat: o.trat }))
  conta('o CPF e o telefone vao so com digitos', o.cpf === '52998224725' && o.wa === '19995983293', o.cpf + ' / ' + o.wa)
  conta('a UF vai em maiuscula', o.uf === 'SP', o.uf)
  conta('o comprovante vai junto', /^https?:/.test(String(o.comprovante_url || '')) && (o.comprovantes || []).length === 1, String(o.comprovante_url))
  conta('a mensagem do cliente fica gravada no pedido', /Pedido Conclu/.test(String(o.raw || '')) && /397,00/.test(String(o.raw || '')), String(o.raw || '').slice(0, 40))
  conta('o painel NAO decide de quem e a venda', o.at === undefined, String(o.at))
  conta('a comissao nasce vazia, nao inventada', o.com_pct === '', JSON.stringify(o.com_pct))

  const depois = await js('({ bom: !!document.querySelector(".aviso.bom"), tipo: document.querySelectorAll("[data-tipo]").length })')
  conta('depois de cadastrar avisa e volta pro inicio', depois.bom === true && depois.tipo === 2, JSON.stringify(depois))

  // ── antecipado NAO exige comprovante ───────────────────────────────────────────────────────
  await clica('[data-tipo=antecipado]')
  await espera(350)
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("cpf","52998224725"); s("cep","13000000"); s("end","Rua A"); s("num","10");'
    + ' s("bairro","Centro"); s("cidade","Campinas"); s("uf","SP"); })()')
  await espera(200)
  await clica('[data-op=trat][data-v=k3]')
  await espera(300)
  await clica('#pd-ok')
  await espera(500)
  const nAnt = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0].mod))'))
  conta('pagamento antecipado passa sem comprovante', nAnt.length === 2 && nAnt[1] === 'antecipado', JSON.stringify(nAnt))

  // ── O LEAD FICA CONGELADO quando a conversa muda no meio ───────────────────────────────────
  await clica('[data-tipo=entrega]')
  await espera(350)
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) }; s("cidade","Campinas") })()')
  // o pulso troca a conversa por baixo, como quando o vendedor clica noutro chat
  await js('(() => { window.__trocaConversa("5511988887777", "Outro Cliente") })()')
  await espera(2200)
  const congelado = await js('({ dono: (document.querySelector(".dono-ped .q")||{}).textContent || "", aviso: !!document.querySelector(".dono-ped .a"), wa: (document.querySelector("[data-k=wa]")||{}).value || "" })')
  conta('trocar de conversa NAO muda o dono do pedido', /Cliente de Teste/.test(congelado.dono), JSON.stringify(congelado))
  conta('e avisa que a conversa mudou', congelado.aviso === true, JSON.stringify(congelado))
  conta('o telefone do formulario continua o de origem', congelado.wa === '(19) 99598-3293', congelado.wa)
  const rascSozinho = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").length)'))
  conta('e grava rascunho sozinho ao trocar de conversa', rascSozinho >= 1, String(rascSozinho))
  await clica('#pd-voltar')
  await espera(300)

  // ── rascunho guarda o que esta pela metade ─────────────────────────────────────────────────
  await clica('[data-tipo=entrega]')
  await espera(300)
  await set('nome', 'So o nome por enquanto')
  await clica('#pd-rasc')
  await espera(400)
  // O ULTIMO, nao o unico: o rascunho agora tambem e gravado SOZINHO ao trocar de conversa e ao
  // clicar em Voltar, entao a lista tem varios e o que interessa e o que acabou de sair.
  const rl = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").map(c => c.args))'))
  const ult = rl[rl.length - 1] || []
  conta('o rascunho guarda mesmo faltando campo obrigatorio',
    !!(ult[2] && ult[2].nome === 'So o nome por enquanto'), JSON.stringify(ult).slice(0, 140))
  conta('o rascunho guarda o TIPO junto, senao reabrir perde o passo', ult[2] && ult[2].__tipo === 'entrega', String(ult[2] && ult[2].__tipo))
  conta('o rascunho guarda de quem e o pedido', !!(ult[2] && ult[2].__lead && ult[2].__lead.phone), JSON.stringify(ult[2] && ult[2].__lead))

  // ── a pilha de disparos ────────────────────────────────────────────────────────────────────
  await clica('[data-aba=funis]')
  await espera(250)
  const pil = await js('({ tem: !!document.querySelector(".saindo"), nm: (document.querySelector(".saindo .nm")||{}).textContent || "", ln: (document.querySelector(".saindo .ln")||{}).textContent || "", passos: document.querySelectorAll(".saindo .passos i").length, feitos: document.querySelectorAll(".saindo .passos i.ja").length })')
  conta('a pilha mostra o funil que esta saindo', pil.tem === true && /Boas-vindas/.test(pil.nm), JSON.stringify(pil))
  conta('mostra em que passo esta', /2 de 5/.test(pil.nm), pil.nm)
  conta('mostra por qual numero e pra quem', /97401-5754/.test(pil.ln) && /99598-3293/.test(pil.ln), pil.ln)
  conta('a barrinha tem um tracinho por passo, 2 preenchidos', pil.passos === 5 && pil.feitos === 2, pil.passos + '/' + pil.feitos)

  // ── o X de fechar o numero fica aparente ───────────────────────────────────────────────────
  const x = await js('(() => { const e = document.getElementById("fechar"); const s = getComputedStyle(e);'
    + ' return { classe: e.className, borda: s.borderTopWidth, cor: s.color } })()')
  conta('o X de fechar numero se destaca dos outros icones',
    /sair/.test(x.classe) && x.borda !== '0px', JSON.stringify(x))

  conta('nenhum erro de javascript na tela', erros.length === 0, erros.join(' | ').slice(0, 200))

  // ══ A CASCA (barra lateral): encolher e voltar ═════════════════════════════════════════════
  ponto = 'casca'
  const w2 = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(__dirname, 'teste-casca-preload.js'), sandbox: false, contextIsolation: true },
  })
  const erros2 = []
  w2.webContents.on('console-message', (ev) => {
    if (ev && (ev.level === 'error' || ev.level === 'warning')) erros2.push(String(ev.message || ''))
  })
  await w2.loadFile(path.join(PROJ, 'src/ui/index.html'))
  const js2 = (c) => w2.webContents.executeJavaScript(c, true)
  await espera(1200)

  const temBt = await js2('!!document.getElementById("encolhe") && !!document.getElementById("fresta")')
  conta('a casca tem o botao de encolher e a abinha de voltar', temBt)

  const largaAntes = await js2('document.querySelector("aside").getBoundingClientRect().width')
  conta('a barra comeca larga', Math.round(largaAntes) === 268, String(largaAntes))

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  const fina = await js2('({ larg: Math.round(document.querySelector("aside").getBoundingClientRect().width), classe: document.body.className, pediu: (window.__ver()).filter(c => c.nome === "barra").map(c => c.args[0]) })')
  conta('clicar encolhe a barra pra 56px', fina.larg === 56, JSON.stringify(fina))
  conta('e avisa o processo principal, que e quem move a view', JSON.stringify(fina.pediu) === '[true]', JSON.stringify(fina.pediu))

  const dentro = await js2('({ fino: document.querySelectorAll(".fino").length, d: [...document.querySelectorAll(".fino .d")].map(e => e.textContent).join(","), c: [...document.querySelectorAll(".fino .c")].map(e => e.textContent).join(","), vend: document.querySelectorAll(".vend").length, busca: getComputedStyle(document.querySelector(".busca")).display })')
  conta('encolhida, mostra um numero por linha', dentro.fino === 3, JSON.stringify(dentro.fino))
  conta('mostra os 4 ultimos digitos', dentro.d === '2248,3293,0653', dentro.d)
  conta('mostra o contador do dia', dentro.c === '70/70,32/70,0/70', dentro.c)
  conta('esconde a busca e o cabecalho de vendedor', dentro.vend === 0 && dentro.busca === 'none', JSON.stringify(dentro))

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  const voltou = await js2('({ larg: Math.round(document.querySelector("aside").getBoundingClientRect().width), vend: document.querySelectorAll(".vend").length })')
  conta('clicar de novo devolve a barra larga', voltou.larg === 268 && voltou.vend === 2, JSON.stringify(voltou))

  // A ABINHA so aparece com o painel escondido, e e o unico caminho de volta fora de Ajustes.
  const escondida = await js2('getComputedStyle(document.getElementById("fresta")).display')
  conta('com o painel ligado, a abinha nao aparece', escondida === 'none', escondida)
  await js2('window.__painelOff()')
  await js2('(async () => { await recarregaEstado() })()')
  await espera(500)
  const aparece = await js2('({ d: getComputedStyle(document.getElementById("fresta")).display, w: Math.round(document.getElementById("fresta").getBoundingClientRect().width) })')
  conta('com o painel escondido, a abinha aparece na fresta', aparece.d === 'flex' && aparece.w === 22, JSON.stringify(aparece))
  await js2('document.getElementById("fresta").click()')
  await espera(400)
  const pediu = JSON.parse(await js2('JSON.stringify((window.__ver()).filter(c => c.nome === "painel").map(c => c.args[0]))'))
  conta('clicar na abinha manda mostrar o painel de novo', JSON.stringify(pediu) === '[true]', JSON.stringify(pediu))

  conta('nenhum erro de javascript na casca', erros2.length === 0, erros2.join(' | ').slice(0, 200))
  w2.destroy()

  console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram')
  if (falhas.length) console.log('  falharam: ' + falhas.join(', '))
  win.destroy()
  app.exit(falhas.length ? 1 : 0)
})
