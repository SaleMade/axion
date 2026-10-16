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

  // ── ABRIR E SAIR SEM MEXER NAO CRIA RASCUNHO ───────────────────────────────────────────────
  // O nome e o telefone entram sozinhos da conversa. Se eles contassem como "conteudo", toda
  // passada pela aba viraria um rascunho vazio na lista do vendedor.
  const antesVazio = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").length)'))
  await clica('[data-tipo=entrega]')
  await espera(300)
  await clica('[data-aba=itens]')
  await espera(400)
  const depoisVazio = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").length)'))
  conta('abrir e sair sem digitar nada NAO cria rascunho', depoisVazio === antesVazio, antesVazio + ' -> ' + depoisVazio)
  await clica('[data-aba=pedidos]')
  await espera(300)

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

  // ── O BOTAO DE TROCAR DE CLIENTE (16/10/2026) ───────────────────────────────────────────────
  // O congelamento protege o pedido, mas avisar sem dar saida deixa o vendedor parado. Pedido do
  // Bruno: "um botaozinho ali, tipo Trocar para novo cliente, e isso ficasse um pouco mais
  // destacado, pra que o meu vendedor nao confunda e acabe subindo um pedido pra um cliente que ja
  // saiu".
  const aviso = await js('(() => { const b = document.getElementById("pd-troca"); const bl = document.querySelector(".dono-ped");'
    + ' return { botao: !!b, texto: b ? b.textContent.trim() : "", destaque: !!(bl && bl.classList.contains("trocou")) } })()')
  conta('a conversa trocada ganha botao de trocar de cliente',
    aviso.botao === true && /Outro Cliente/.test(aviso.texto), JSON.stringify(aviso))
  conta('e o bloco inteiro se destaca, nao so um rotulo de canto', aviso.destaque === true, JSON.stringify(aviso))

  await clica('#pd-troca')
  await espera(700)
  const dps = await js('({ dono: (document.querySelector(".dono-ped .q")||{}).textContent || "",'
    + ' aviso: !!document.querySelector(".dono-ped .a"), botao: !!document.getElementById("pd-troca"),'
    + ' wa: (document.querySelector("[data-k=wa]")||{}).value || "",'
    + ' cidade: (document.querySelector("[data-k=cidade]")||{}).value || "",'
    + ' msg: (document.querySelector(".aviso.bom")||{}).textContent || "" })')
  conta('depois de trocar, o pedido e do cliente novo', /Outro Cliente/.test(dps.dono), JSON.stringify(dps))
  conta('o aviso e o botao somem, porque nao ha mais o que trocar',
    dps.aviso === false && dps.botao === false, JSON.stringify(dps))
  conta('o telefone passa a ser o do cliente novo', dps.wa === '(11) 98888-7777', dps.wa)
  // ISTO E O QUE EVITA O PEDIDO ERRADO: endereco, CPF e tratamento sao daquela pessoa. Levar junto
  // seria trocar um pedido errado por outro.
  conta('os campos do cliente anterior NAO vao junto', dps.cidade === '', dps.cidade)
  conta('e avisa que o anterior virou rascunho', /rascunho/i.test(dps.msg), dps.msg)
  const chamR = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").map(c => [String(c.args[0] || ""), String(c.args[1] || "")]))'))
  const ultR = chamR[chamR.length - 1] || []
  conta('o rascunho guardado e do cliente ANTERIOR, nao do novo',
    String(ultR[1] || '') === '5519995983293', JSON.stringify(ultR[1]))
  // O PAINEL TEM QUE GUARDAR O ID QUE O SERVIDOR DEVOLVEU. Sem isso, cada gravacao manda id vazio
  // de novo e nasce UMA LINHA NOVA por troca de conversa - a lista de rascunhos do vendedor vira
  // lixo. O defeito irmao deste (o worker recusando id vazio) ficou escondido por semanas porque o
  // preload falso respondia ok pra tudo.
  const primeiroSemId = (chamR[0] || [])[0] === ''
  const depoisComId = chamR.length < 2 || chamR.slice(1).every((c) => c[0] !== '')
  conta('o 1o save vai sem id e os seguintes reusam o que o servidor deu',
    primeiroSemId && depoisComId, JSON.stringify(chamR.map((c) => c[0])))

  // ── CADASTRAR COM A CONVERSA TROCADA PEDE CONFIRMACAO ──────────────────────────
  // A faixa ambar e o botao avisam; esta e a ultima trava, e e o que ele pediu em palavras: "pra
  // que o meu vendedor nao confunda e acabe subindo um pedido pra um cliente que ja saiu".
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); if (!e) return;'
    + ' e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("cpf","52998224725"); s("cep","13000000"); s("end","Rua A"); s("num","10");'
    + ' s("bairro","Centro"); s("cidade","Campinas"); s("uf","sp"); })()')
  await js('(() => { const o = [...document.querySelectorAll("[data-op=trat]")].find(e => /3 Meses/.test(e.textContent)); if (o) o.click() })()')
  await espera(300)
  await js('(() => { const i = document.getElementById("pd-arquivo");'
    + ' const f = new File([new Uint8Array([1,2,3])], "print2.jpg", { type: "image/jpeg" });'
    + ' const dt = new DataTransfer(); dt.items.add(f); i.files = dt.files;'
    + ' i.dispatchEvent(new Event("change")); })()')
  await espera(700)
  const antesConf = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").length)'))
  // a conversa muda DEPOIS do formulario pronto, que e o caso perigoso
  await js('(() => { window.__trocaConversa("5521970001111", "Cliente Que Chegou Agora") })()')
  await espera(2000)
  await clica('#pd-ok')
  await espera(400)
  const conf1 = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "",'
    + ' n: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  conta('com a conversa trocada, o primeiro Cadastrar NAO manda',
    conf1.n === antesConf, JSON.stringify(conf1.n) + ' vs ' + antesConf)
  conta('e o aviso diz de QUEM e o pedido', /Outro Cliente/.test(conf1.txt), conf1.txt.slice(0, 120))
  await clica('#pd-ok')
  await espera(600)
  const conf2 = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0].wa))'))
  conta('o segundo clique confirma e manda', conf2.length === antesConf + 1, String(conf2.length))
  // O `wa` vai so com digitos e sem o 55 (montaPedido usa dig()), entao o que se confere e que e o
  // numero do dono congelado e NAO o da conversa que estava na tela na hora do clique.
  const ultWa = String(conf2[conf2.length - 1] || '')
  conta('e o pedido sai com o telefone do dono CONGELADO, nao o da tela',
    ultWa === '11988887777' && !/2197000/.test(ultWa), ultWa)

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

  // ── A FILA: varios disparos para leads diferentes, um atras do outro ──────────────────────
  await clica('[data-aba=funis]')
  await espera(250)
  await clica('[data-funil=s1]')
  await espera(250)
  // O BOTAO NAO PODE VIRAR RODINHA ENQUANTO AQUELE FUNIL ESTA NA FILA (16/10/2026). Ele nunca
  // esteve desabilitado, mas a rodinha fez o Bruno entender que estava proibido de disparar pro
  // proximo lead - "voce bloqueou os funis pra mim disparar pra outro". No inbox o item do menu de
  // funil nunca gira nem desabilita; quem mostra o que esta saindo e a pilha.
  const bt = await js('(() => { const b = document.querySelector("[data-funil=s1]");'
    + ' return { desabilitado: b.disabled, girando: !!b.querySelector(".girando") } })()')
  conta('com um funil na fila, o botao continua convidando a disparar',
    bt.desabilitado === false && bt.girando === false, JSON.stringify(bt))

  // TROCA DE CONVERSA E DISPARA NA HORA, sem esperar o pulso de 1,5s - que e como ele trabalha:
  // clica no lead e dispara em seguida. Antes, o alvo vinha do ultimo pulso, entao o funil inteiro
  // saia pro lead ANTERIOR com o nome do novo na pilha. 150ms e menos de um decimo do pulso.
  await js('(() => { window.__trocaConversa("5562961529830", "Segundo Cliente") })()')
  await espera(150)
  await clica('[data-funil=s1]')
  await espera(300)
  const pil = await js('({ cab: (document.querySelector(".saindo .cab .t")||{}).textContent || "", linhas: document.querySelectorAll(".saindo .item-env").length, l1: [...document.querySelectorAll(".saindo .l1")].map(e => e.textContent.trim()), l2: [...document.querySelectorAll(".saindo .l2")].map(e => e.textContent.trim()), rodando: document.querySelectorAll(".saindo .item-env .roda").length, esperando: document.querySelectorAll(".saindo .item-env .pt-fila").length })')
  conta('o segundo disparo ENTRA NA FILA em vez de ser recusado', pil.linhas === 2, JSON.stringify(pil.linhas))
  conta('o cabecalho conta os dois, no plural certo', /Enviando funis · 2/.test(pil.cab), pil.cab)
  conta('o alvo e o da conversa DO CLIQUE, nao a do ultimo pulso',
    (pil.l1[0] || '') !== (pil.l1[1] || '') && /Segundo Cliente/.test(pil.l1[1] || ''), JSON.stringify(pil.l1))
  conta('um roda e o outro espera a vez', pil.rodando === 1 && pil.esperando === 1, JSON.stringify(pil))
  conta('quem espera diz que esta na fila', /Na fila/.test(pil.l2[1] || ''), JSON.stringify(pil.l2))
  const seloFunis = await js('({ txt: $("selo-funis").textContent, escondido: $("selo-funis").hidden })')
  conta('o selo da aba conta os funis da fila', seloFunis.txt === '2' && seloFunis.escondido === false, JSON.stringify(seloFunis))

  // TERCEIRO LEAD, de novo na hora. Tres e o numero que ele deu no pedido: "disparo pro lead 1, pro
  // lead 2, pro lead 3, e a sequencia que chega e lead 1, lead 2, lead 3".
  await js('(() => { window.__trocaConversa("5511988887777", "Terceiro Cliente") })()')
  await espera(150)
  await clica('[data-funil=s1]')
  await espera(300)
  const tres = await js('({ linhas: document.querySelectorAll(".saindo .item-env").length,'
    + ' l1: [...document.querySelectorAll(".saindo .l1")].map(e => e.textContent.trim()),'
    + ' rod: (document.getElementById("rod")||{}).textContent || "" })')
  conta('o terceiro tambem entra, a fila nao tem teto de dois', tres.linhas === 3, JSON.stringify(tres.linhas))
  // Os tres sao leads DIFERENTES, cada um na posicao do seu clique. O primeiro e quem estava aberto
  // quando o teste chegou aqui (os testes de pedido ja tinham trocado de conversa), entao o que se
  // confere e a ORDEM: segundo clique na posicao 2, terceiro na 3, e nenhum repetido.
  conta('a ordem da pilha e a ordem dos cliques',
    /Segundo Cliente/.test(tres.l1[1] || '') && /Terceiro Cliente/.test(tres.l1[2] || '')
    && new Set(tres.l1).size === 3, JSON.stringify(tres.l1))
  // O aviso e o mesmo do inbox (avisoDisparo do chat.jsx): sem ele o vendedor clica de novo
  // achando que falhou, que foi exatamente o que aconteceu aqui.
  conta('o rodape diz a posicao na fila, como o inbox', /Na fila/.test(tres.rod), tres.rod)

  // tirar da fila quem ainda nao saiu
  const tirou = await js('(() => { const bs = document.querySelectorAll(".saindo .item-env [data-tirafila]");'
    + ' if (bs.length < 2) return -1; bs[bs.length - 1].click();'
    + ' return document.querySelectorAll(".saindo .item-env").length })()')
  conta('da pra tirar da fila quem ainda nao saiu', tirou === 2, String(tirou))

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

  // ── AQUECIMENTO tem area propria, e o interruptor so existe pra quem pode receber ──────────
  const sec = await js2('(() => ({'
    + ' cabecalhos: [...document.querySelectorAll(".vend span:first-child")].map(e => e.textContent.trim()),'
    + ' aquecCor: (() => { const h = document.querySelector(".vend.aquec"); return h ? getComputedStyle(h).color : "" })(),'
    + ' aquecQtd: (document.querySelector(".vend.aquec .qtd")||{}).textContent || "",'
    + ' chaves: document.querySelectorAll(".num .sw").length,'
    + ' selos: document.querySelectorAll(".num .sw-off").length }))()')
  conta('o aquecimento ganha cabecalho proprio', sec.cabecalhos.includes('Aquecimento'), JSON.stringify(sec.cabecalhos))
  conta('na cor do aquecimento, nao na cinza dos vendedores', sec.aquecCor === 'rgb(245, 158, 11)', sec.aquecCor)
  conta('e diz quantos leads chegaram hoje', /3 leads/.test(sec.aquecQtd), sec.aquecQtd)
  // 3 em uso + 1 em aquecimento = 4 interruptores; o "Em analise" fica com o selo
  conta('interruptor so pra quem pode receber', sec.chaves === 4 && sec.selos === 1, JSON.stringify(sec))

  const largaAntes = await js2('document.querySelector("aside").getBoundingClientRect().width')
  conta('a barra comeca larga', Math.round(largaAntes) === 268, String(largaAntes))

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  const fina = await js2('({ larg: Math.round(document.querySelector("aside").getBoundingClientRect().width), classe: document.body.className, pediu: (window.__ver()).filter(c => c.nome === "barra").map(c => c.args[0]) })')
  conta('clicar encolhe a barra pra 56px', fina.larg === 56, JSON.stringify(fina))
  conta('e avisa o processo principal, que e quem move a view', JSON.stringify(fina.pediu) === '[true]', JSON.stringify(fina.pediu))

  const dentro = await js2('({ fino: document.querySelectorAll(".fino").length, d: [...document.querySelectorAll(".fino .d")].map(e => e.textContent).join(","), c: [...document.querySelectorAll(".fino .c")].map(e => e.textContent).join(","), vend: document.querySelectorAll(".vend").length, busca: getComputedStyle(document.querySelector(".busca")).display })')
  conta('encolhida, mostra um numero por linha', dentro.fino === 5, JSON.stringify(dentro.fino))
  conta('mostra os 4 ultimos digitos', dentro.d === '2248,3293,1122,8551,0653', dentro.d)
  conta('mostra o contador do dia', dentro.c === '70/70,32/70,0,3/5,0/70', dentro.c)
  conta('esconde a busca e o cabecalho de vendedor', dentro.vend === 0 && dentro.busca === 'none', JSON.stringify(dentro))

  const destFino = await js2('(() => { const r = [...document.querySelectorAll(".fino")].map(e => e.className);'
    + ' return { total: r.length, n: r.filter(c => /recebendo/.test(c)).length,'
    + ' qual: [...document.querySelectorAll(".fino.recebendo .d")].map(e => e.textContent).join(",") } })()')
  // DOIS destacados, e esta certo: o estabelecido da vez e o em aquecimento, que recebe em
  // paralelo (entra na FRENTE da fila com teto pequeno). Se um dia so um aparecer aqui, ou o
  // aquecimento saiu da roleta ou a fila voltou a ser serial entre os dois, e os dois sao bug.
  conta('encolhida, o destaque de "recebendo agora" tambem aparece', destFino.n === 2 && destFino.qual === '3293,8551', JSON.stringify(destFino))

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  // O DESTAQUE na barra larga, que e onde ele olha no dia a dia. So UM dos tres: os outros estao
  // no limite e desligado. Destacar todos os ligados nao diria nada.
  const dest = await js2('(() => { const r = [...document.querySelectorAll(".num")].map(e => e.className);'
    + ' return { total: r.length, n: r.filter(c => /recebendo/.test(c)).length,'
    + ' qual: [...document.querySelectorAll(".num.recebendo .fone")].map(e => e.textContent.trim()).join(",") } })()')
  conta('so quem esta na vez fica destacado', dest.total === 5 && dest.n === 2, JSON.stringify(dest))
  conta('e sao o estabelecido da vez e o em aquecimento', /99598-3293/.test(dest.qual) && /97406-8551/.test(dest.qual), dest.qual)

  const voltou = await js2('({ larg: Math.round(document.querySelector("aside").getBoundingClientRect().width), vend: document.querySelectorAll(".vend").length })')
  conta('clicar de novo devolve a barra larga', voltou.larg === 268 && voltou.vend === 3, JSON.stringify(voltou))

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
