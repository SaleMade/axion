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

const { app, BrowserWindow, session } = require('electron')
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
  // O ESQUEMA swmedia PRECISA DE DONO AQUI, mesmo que devolva 404.
  //
  // O QUE ACONTECIA (17/10/2026, achado pela sessao e0): o teste carrega o painel.html numa janela
  // escondida na sessao PADRAO, e o app de verdade registra o `swmedia://` na `persist:sw-painel`.
  // Sem dono na padrao, a previa de documento - que e um `<iframe src="swmedia://...">`, ou seja uma
  // NAVEGACAO, nao um carregamento de imagem - era entregue pro Windows, e o Windows abria o dialogo
  // "Obter um aplicativo para abrir este 'swmedia' link" NA TELA DO BRUNO, com a janela do teste
  // escondida. Img, video e audio falham calados; o iframe e o unico que escapa pro sistema.
  //
  // 404 e de proposito: o teste da previa de documento confere papel e tinta no elemento (ver
  // teste-midia, que roda na particao de verdade). Aqui so e preciso que o esquema tenha dono.
  session.defaultSession.protocol.handle('swmedia', () => new Response('', { status: 404 }))

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

  // ══ A PREVIA MOSTRA A MIDIA, NAO O ROTULO DELA ════════════════════════════════════════════
  //
  // Achado do Bruno em 16/10: clicar num video, numa foto ou num documento abria sempre o MESMO
  // balao de texto, escrito "[imagem] Formula". A previa existe pra ele conferir o que vai
  // disparar ANTES de disparar; mostrando so o rotulo, ela nao servia pra nada.
  //
  // A midia vem por `swmedia://`, um esquema que o processo principal resolve (ver main.js). O
  // teste confere o ENDERECO e o ELEMENTO, que e o que a pagina controla - buscar o arquivo de
  // verdade e trabalho do processo principal e nao roda aqui.
  const previa = async (id) => {
    await clica('[data-abre="item:' + id + '"]')
    await espera(220)
    return js('(() => { const b = document.querySelector(".prev-balao"); if (!b) return null;'
      + ' const m = b.querySelector("img,video,audio");'
      + ' return { classe: b.className, tag: m ? m.tagName.toLowerCase() : "",'
      + ' src: m ? m.getAttribute("src") : "", controles: m ? m.hasAttribute("controls") : false,'
      + ' doc: !!b.querySelector("[data-abredoc]"), docTxt: (b.querySelector("[data-abredoc] span")||{}).textContent || "",'
      + ' cap: (b.querySelector(".prev-cap")||{}).textContent || "", txt: b.textContent } })()')
  }

  const pImg = await previa('i1')
  conta('a previa da imagem desenha um <img>', pImg && pImg.tag === 'img', JSON.stringify(pImg))
  conta('apontando pro esquema que o app resolve', pImg && pImg.src === 'swmedia://arq/m%2Faaa111.png', pImg && pImg.src)
  conta('e a legenda vem junto, embaixo da imagem', pImg && /olha a formula/.test(pImg.cap), pImg && pImg.cap)
  conta('e NAO escreve mais "[imagem] ..." no lugar da foto', pImg && !/\[imagem\]/.test(pImg.txt), pImg && pImg.txt.slice(0, 60))

  const pVid = await previa('v1')
  conta('a previa do video desenha um <video>', pVid && pVid.tag === 'video', JSON.stringify(pVid))
  conta('com controles, pra ele dar play e arrastar', pVid && pVid.controles === true)
  conta('no endereco do esquema proprio', pVid && pVid.src === 'swmedia://arq/m%2Fbbb222.mp4', pVid && pVid.src)

  const pAud = await previa('a1')
  conta('o audio continua tocavel', pAud && pAud.tag === 'audio' && pAud.controles === true, JSON.stringify(pAud))

  // O DOCUMENTO NAO ABRE DENTRO DO PAINEL de proposito: PDF embutido pediria visualizador e mais um
  // furo na CSP. Ele mostra o nome e abre no programa do Windows.
  const pDoc = await previa('d1')
  conta('o documento mostra o nome num botao', pDoc && pDoc.doc === true && /Certificado Anvisa/.test(pDoc.docTxt), JSON.stringify(pDoc))
  await js('(() => { const b = document.querySelector("[data-abredoc]"); if (b) b.click() })()')
  await espera(220)
  const abriu = await js('JSON.stringify((window.__ver()).filter(c => c.nome === "abrirMidia").map(c => c.args[0]))')
  conta('e clicar nele manda o app abrir o arquivo', /ddd444\.pdf/.test(abriu), abriu)

  // A CSP TEM QUE DEIXAR, E SO ELE. Se alguem apertar a politica de novo, a midia volta a nao
  // aparecer - e o sintoma (balao de texto no lugar da foto) nao parece um problema de CSP.
  const csp = await js('(document.querySelector("meta[http-equiv=\'Content-Security-Policy\']")||{}).content || ""')
  conta('a CSP aceita swmedia em img e media', /img-src[^;]*swmedia:/.test(csp) && /media-src[^;]*swmedia:/.test(csp), csp)
  conta('e continua sem deixar a pagina falar com a rede',
    /default-src 'none'/.test(csp) && !/connect-src/.test(csp) && !/https?:/.test(csp), csp)

  await clica('[data-abre="item:d1"]')   // fecha a previa antes de seguir
  await espera(200)

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
  conta('o formulario diz de quem e o pedido', /99598-3293/.test(sub), sub)

  const campos = await js('[...document.querySelectorAll("#corpo [data-k]")].map(e => e.dataset.k).join(",")')
  const ESPERADOS = ['cpf', 'nome', 'wa', 'cep', 'end', 'num', 'bairro', 'comp', 'cidade', 'uf', 'obs']
  conta('todos os campos desenharam', ESPERADOS.every((k) => campos.split(',').includes(k)), campos)

  const pre = await js('({ wa: document.querySelector("[data-k=wa]").value, nome: document.querySelector("[data-k=nome]").value })')
  conta('o numero da conversa entra sozinho', pre.wa === '(19) 99598-3293', pre.wa)
  // O CAMPO NOME NASCE VAZIO, E ISSO E A REGRA (16/10/2026, decisao do Bruno). O que a gente tinha
  // pra preencher era o TITULO DA CONVERSA, que nao e nome: pra quem nao esta na agenda ele e o
  // telefone, e num estado intermediario e a propria interface ("clique para mostrar os dados do
  // contato"). Os dois casos chegaram no pedido dele. Vazio custa uma digitacao; lixo custa o nome
  // errado na etiqueta e na cobranca.
  conta('o campo nome nasce VAZIO, nunca com o titulo da conversa', pre.nome === '', JSON.stringify(pre.nome))
  // E o vendedor digita, que e o fluxo de verdade daqui pra frente.
  await js('(() => { const e = document.querySelector("[data-k=nome]"); e.value = "Cliente de Teste"; e.dispatchEvent(new Event("input")) })()')

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

  // ══ PARIDADE COM O NOVO PEDIDO DA DASH (16/10/2026) ═══════════════════════════════════════
  //
  // Pedido dele: "todas as funcionalidades que a gente tem hoje na area de novo pedido da dash
  // funcionem la no aplicativo tambem, porque nao esta funcionando corretamente". Eram quatro
  // coisas: mascara enquanto digita, busca de CEP preenchendo o endereco, prazo de entrega com as
  // tres formas de mandar, e venda futura com calendario.

  // ── MASCARA A CADA TECLA, nao so com o campo completo ──────────────────────────────────────
  const digitando = async (k, texto) => {
    await js('(() => { const e = document.querySelector("[data-k=" + ' + JSON.stringify(JSON.stringify(k)) + ' + "]"); e.value = ""; })()')
    const saida = []
    for (const c of texto) {
      await js('(() => { const e = document.querySelector("[data-k=' + k + ']"); e.value = e.value + ' + JSON.stringify(c) + '; e.dispatchEvent(new Event("input")); })()')
      saida.push(await js('document.querySelector("[data-k=' + k + ']").value'))
    }
    return saida
  }
  const cpfPassos = await digitando('cpf', '52998224725')
  conta('o CPF vai se formatando enquanto digita',
    cpfPassos[2] === '529' && cpfPassos[3] === '529.9' && cpfPassos[8] === '529.982.247' && cpfPassos[10] === '529.982.247-25',
    JSON.stringify([cpfPassos[2], cpfPassos[3], cpfPassos[8], cpfPassos[10]]))
  const telPassos = await digitando('wa', '19995983293')
  // OS PASSOS SAO OS DA DASH, conferidos contra o maskTel dela digito a digito. O corte muda com o
  // tamanho de proposito: com 8 digitos depois do DDD ele desenha "(19) 9959-8329", que e como um
  // numero ANTIGO sem o 9 tem que aparecer; so no nono digito vira "(19) 99598-3293".
  conta('o WhatsApp tambem, com DDD e o 9',
    telPassos[1] === '(19' && telPassos[6] === '(19) 9959-8' && telPassos[10] === '(19) 99598-3293',
    JSON.stringify([telPassos[1], telPassos[6], telPassos[10]]))
  // APAGAR NO MEIO nao pode embaralhar: e o caso que fazia a mascara ser adiada ate o fim.
  // APAGAR NO MEIO nao pode embaralhar. Com 10 digitos o desenho volta pro corte de 8 (de novo:
  // igual a dash), entao o esperado e "(19) 9959-8329" e NAO o texto cru que ficou no campo.
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "(19) 99598-329"; e.dispatchEvent(new Event("input")); })()')
  conta('apagar um digito nao embaralha o resto',
    (await js('document.querySelector("[data-k=wa]").value')) === '(19) 9959-8329',
    await js('document.querySelector("[data-k=wa]").value'))

  // TELEFONE SEM O 9 avisa na hora, em vez de so na recusa do Aceitar.
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "1933334444"; e.dispatchEvent(new Event("input")); })()')
  await espera(200)
  const semNove = await js('({ dica: (document.querySelector(".dica-campo")||{}).textContent || "" })')
  conta('celular sem o 9 avisa no proprio campo', /9 depois do DDD|Faltam/.test(semNove.dica), JSON.stringify(semNove))
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "19995983293"; e.dispatchEvent(new Event("input")); })()')
  await espera(150)

  // ── O CURSOR NAO PODE SAIR DO CAMPO ────────────────────────────────────────────────────────
  //
  // O BUG QUE ISTO PRENDE (17/10/2026): "toda vez que eu digitava um digito, ele me cortava e nao
  // me deixava digitar o proximo; eu tinha que clicar no campo de novo". Todo desenha() troca o
  // innerHTML inteiro e mata o elemento que tinha o foco. No CEP isso era fatal: ele nunca chegava
  // nos oito digitos, entao a busca nunca disparava - e o sintoma que ele viu foi "nao puxa o
  // endereco", que e o DEPOIS do defeito, nao o defeito.
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = ""; e.dispatchEvent(new Event("input")); e.focus(); })()')
  await espera(150)
  const focoPorDigito = []
  for (const c of '88504411') {
    await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = e.value + ' + JSON.stringify(c) + '; e.dispatchEvent(new Event("input")); })()')
    await espera(90)
    focoPorDigito.push(await js('((document.activeElement||{}).dataset||{}).k || "-"'))
  }
  // Os SETE primeiros ficam no CEP; o OITAVO leva o cursor pro numero de proposito, porque a busca
  // disparou e o numero e o proximo campo que sobra pra ele digitar (igual a dash e a Five).
  conta('o cursor fica no CEP a cada digito, sem precisar clicar de novo',
    focoPorDigito.slice(0, 7).every((k) => k === 'cep'), JSON.stringify(focoPorDigito))
  conta('e so no oitavo ele vai pro numero, porque a busca ja preencheu o resto',
    focoPorDigito[7] === 'num', JSON.stringify(focoPorDigito))
  await espera(500)
  const depoisDeDigitar = await js('(document.querySelector("[data-k=end]")||{}).value || ""')
  conta('e por isso a busca dispara e preenche o endereco', depoisDeDigitar === 'Rua Curitiba', depoisDeDigitar)

  // CEP PELA METADE NAO CHUTA ESTADO: ele digitou "2" e a tela prometia "estimativa pra RJ".
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "2"; e.dispatchEvent(new Event("input")); })()')
  await espera(300)
  conta('com o CEP pela metade, o prazo nao aparece chutando estado',
    (await js('!document.querySelector(".prazo")')) === true,
    await js('(document.querySelector(".prazo")||{}).textContent || "(sem prazo)"'))

  // ── A BUSCA DE CEP ─────────────────────────────────────────────────────────────────────────
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "88504411"; e.dispatchEvent(new Event("input")); })()')
  await espera(500)
  const dep = await js('(() => { const v = (k) => (document.querySelector("[data-k=" + k + "]")||{}).value || "";'
    + ' const tr = (k) => { const e = document.querySelector("[data-k=" + k + "]"); return !!(e && e.hasAttribute("readonly")) };'
    + ' return { end: v("end"), bairro: v("bairro"), cidade: v("cidade"), uf: v("uf"), cep: v("cep"),'
    + ' travou: tr("end") && tr("bairro") && tr("cidade") && tr("uf"), numLivre: !tr("num"),'
    + ' foco: (document.activeElement||{}).dataset ? (document.activeElement.dataset.k || "") : "",'
    + ' cadeados: document.querySelectorAll(".form label .cad").length } })()')
  conta('o CEP de 8 digitos preenche rua, bairro, cidade e UF',
    dep.end === 'Rua Curitiba' && dep.bairro === 'Santa Helena' && dep.cidade === 'Lages' && dep.uf === 'SC', JSON.stringify(dep))
  conta('e mascara o proprio CEP', dep.cep === '88504-411', dep.cep)
  conta('o que veio da busca fica travado, com cadeado', dep.travou === true && dep.cadeados >= 4, JSON.stringify(dep))
  conta('o numero continua livre, que e o que falta digitar', dep.numLivre === true)
  conta('e o cursor vai pro numero sozinho', dep.foco === 'num', dep.foco)

  // ── ONDE CADA CAMPO DO ENDERECO FICA ────────────────────────────────────
  //
  // Pedido do Bruno em 17/10/2026, depois de usar: "geralmente o pessoal coloca um complemento
  // grande, por exemplo: na esquina atras da igreja, perto do salao de beleza. E um complemento
  // grande e aquele espacinho e muito pequeno. No lugar do complemento coloca a cidade, e no lugar
  // da cidade o complemento". O complemento estava na metade de uma linha dividida e a cidade no
  // espaco largo: os dois trocados, porque a cidade quase sempre e uma palavra so.
  const ordemEnd = await js('[...document.querySelectorAll(".bloco [data-k]")].map(e => e.dataset.k).join(",")')
  conta('o complemento desce pro espaco largo e a cidade sobe pro lado do bairro',
    /cep,end,num,bairro,cidade,comp,uf/.test(ordemEnd), ordemEnd)
  const larguras = await js('(() => { const w = (k) => Math.round(document.querySelector("[data-k=" + k + "]").getBoundingClientRect().width);'
    + ' return { comp: w("comp"), cidade: w("cidade"), uf: w("uf") } })()')
  conta('e o complemento fica mais largo que a cidade, que e o ponto do pedido',
    larguras.comp > larguras.cidade && larguras.uf < larguras.cidade, JSON.stringify(larguras))

  // A CAIXA DO COMPLEMENTO CRESCE COM O TEXTO e volta a encolher quando ele apaga.
  const alturas = await js('(() => { const e = document.querySelector("[data-k=comp]");'
    + ' const h = () => Math.round(e.getBoundingClientRect().height);'
    + ' const vazia = h();'
    + ' e.value = "Na esquina atras da igreja matriz, perto do salao de beleza da dona Cida, portao verde"; e.dispatchEvent(new Event("input"));'
    + ' const cheia = h();'
    + ' e.value = "Ap 12"; e.dispatchEvent(new Event("input"));'
    + ' const curta = h();'
    + ' return { vazia, cheia, curta, eTextarea: e.tagName === "TEXTAREA" } })()')
  conta('o complemento e caixa de texto, nao campo de uma linha', alturas.eTextarea === true, JSON.stringify(alturas))
  conta('ela cresce conforme ele digita', alturas.cheia > alturas.vazia + 8, JSON.stringify(alturas))
  conta('e volta a encolher quando ele apaga', alturas.curta <= alturas.vazia + 2, JSON.stringify(alturas))

  // ENTER NAO QUEBRA LINHA: endereco com quebra vira etiqueta torta na transportadora.
  const semQuebra = await js('(() => { const e = document.querySelector("[data-k=comp]");'
    + ' const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });'
    + ' const foiBarrado = !e.dispatchEvent(ev); return foiBarrado })()')
  conta('Enter no complemento nao quebra linha', semQuebra === true, String(semQuebra))

  // ── O PRAZO E AS TRES FORMAS DE MANDAR ─────────────────────────────────────────────────────
  const prazo = await js('(() => { const p = document.querySelector(".prazo"); if (!p) return null;'
    + ' return { txt: p.textContent.replace(/\\s+/g, " ").trim(),'
    + ' ops: [...p.querySelectorAll("[data-transp]")].map(b => b.dataset.transp).join(","),'
    + ' on: (p.querySelector("[data-transp].on")||{}).dataset.transp } })()')
  conta('aparece o prazo de entrega pra UF do endereco', prazo && /Chega em 4 dias úteis/.test(prazo.txt), prazo && prazo.txt)
  conta('com as tres formas de mandar', prazo && prazo.ops === 'five,correios,correios_retirada', prazo && prazo.ops)
  conta('e a transportadora vem marcada por padrao', prazo && prazo.on === 'five', prazo && prazo.on)
  // Correios no endereco sao 2 dias a mais; a retirada, 1. Trocar MUDA o prazo que ele promete.
  await clica('[data-transp=correios]')
  await espera(250)
  const prazo2 = await js('(document.querySelector(".prazo")||{}).textContent || ""')
  conta('trocar pra Correios muda o prazo na hora', /Chega em 6 dias úteis/.test(prazo2.replace(/\s+/g, ' ')), prazo2.replace(/\s+/g, ' ').slice(0, 60))
  await clica('[data-transp=five]')
  await espera(200)

  // CEP QUE NAO EXISTE avisa e nao deixa cadastrar.
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "12345678"; e.dispatchEvent(new Event("input")); })()')
  await espera(450)
  const ruim = await js('({ dica: (document.querySelector(".dica-campo")||{}).textContent || "",'
    + ' limpou: (document.querySelector("[data-k=end]")||{}).value || "" })')
  conta('CEP que nenhuma base acha avisa no campo', /não encontrado/.test(ruim.dica), JSON.stringify(ruim))
  conta('e o endereco do CEP anterior e apagado, nao fica embaixo do CEP novo', ruim.limpou === '', JSON.stringify(ruim))
  // CEP QUE AS BASES NAO TEM ENDERECO: tem que dizer OUTRA coisa. CEP terminado em 000 e o geral da
  // cidade e NENHUMA das tres bases tem endereco pra ele (medido em 17/10/2026), entao isto acontece
  // todo dia: chamar de invalido pararia o pedido por nada, e oferecer "tentar de novo" seria mentir.
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "01000000"; e.dispatchEvent(new Event("input")); })()')
  await espera(450)
  const semBase = await js('({ dica: (document.querySelector(".dica-campo")||{}).textContent || "",'
    + ' aviso: !!document.querySelector(".cep-sinal.aviso"), again: !!document.querySelector("#pd-cepagain"),'
    + ' travou: !!(document.querySelector("[data-k=end]")||{}).hasAttribute && document.querySelector("[data-k=end]").hasAttribute("readonly") })')
  conta('CEP sem endereco nas bases manda digitar na mao', /bases não têm o endereço/.test(semBase.dica), JSON.stringify(semBase))
  conta('com aviso ambar, nao com vermelho de erro', semBase.aviso === true, JSON.stringify(semBase))
  conta('sem oferecer "tentar de novo", que nao resolveria', semBase.again === false, JSON.stringify(semBase))
  conta('e sem travar campo nenhum: ele precisa digitar os quatro', semBase.travou === false, JSON.stringify(semBase))

  // CONSULTA QUE NAO RESPONDEU: a terceira situacao, e a unica em que "tentar de novo" faz sentido.
  //
  // O BUG QUE ISTO PRENDE (17/10/2026): a busca saia por `net.fetch`, que usa a sessao padrao do
  // Electron - e a sessao padrao deste app esta num buraco negro de proxy de proposito. As tres
  // bases morriam em ERR_PROXY, e a tela nao dizia NADA: o Bruno digitava os oito digitos e ficava
  // olhando um campo girando. Ver tambem o teste-cep, que roda o codigo de verdade contra as bases.
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "99000000"; e.dispatchEvent(new Event("input")); })()')
  await espera(450)
  const falhou = await js('({ dica: (document.querySelector(".dica-campo")||{}).textContent || "",'
    + ' aviso: !!document.querySelector(".cep-sinal.aviso"), again: !!document.querySelector("#pd-cepagain"),'
    + ' girando: !!document.querySelector(".cep-sinal.gira") })')
  conta('consulta que nao respondeu AVISA, em vez de girar pra sempre',
    /Não deu pra consultar/.test(falhou.dica) && falhou.girando === false, JSON.stringify(falhou))
  conta('e oferece tentar de novo', falhou.again === true, JSON.stringify(falhou))
  await clica('#pd-cepagain')
  await espera(400)
  const tentou = await js('(window.__ver()).filter(c => c.nome === "cep" && String(c.args[0]).replace(/\\D/g,"") === "99000000").length')
  conta('o tentar de novo consulta de novo, sem redigitar o CEP', tentou >= 2, String(tentou))

  // ── A REGRA DO CEARA ─────────────────────────────────────────────────
  // A TRANSPORTADORA NAO ATENDE O CEARA (regra do Bruno de 14/10/2026, ja na dash). Lembrete dele em
  // 17/10: "pedidos para o Ceara tem uma regrinha, eu nao vou falar aqui, mas tem uma regra la que
  // voce tem que ver". La o padrao e Correios no endereco e o botao da transportadora fica travado.
  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "60175045"; e.dispatchEvent(new Event("input")); })()')
  await espera(500)
  const ce = await js('(() => { const p = document.querySelector(".prazo"); if (!p) return null;'
    + ' const b = (id) => p.querySelector("[data-transp=" + id + "]");'
    + ' return { uf: (document.querySelector("[data-k=uf]")||{}).value || "",'
    + ' on: (p.querySelector("[data-transp].on")||{}).dataset.transp || "",'
    + ' fiveTravada: !!(b("five") && b("five").disabled && b("five").classList.contains("travado")),'
    + ' correiosLivre: !!(b("correios") && !b("correios").disabled),'
    + ' retiradaLivre: !!(b("correios_retirada") && !b("correios_retirada").disabled),'
    + ' nota: (p.querySelector(".prazo-ce")||{}).textContent || "",'
    + ' txt: p.textContent.replace(/\\s+/g, " ").trim() } })()')
  conta('CEP do Ceara preenche UF=CE', ce && ce.uf === 'CE', JSON.stringify(ce))
  conta('no Ceara a transportadora fica travada e riscada', ce && ce.fiveTravada === true, JSON.stringify(ce))
  conta('e o padrao passa a ser Correios no endereco', ce && ce.on === 'correios', JSON.stringify(ce))
  conta('os dois Correios continuam valendo', ce && ce.correiosLivre && ce.retiradaLivre, JSON.stringify(ce))
  conta('e a tela explica por que', ce && /transportadora não atende/.test(ce.nota), ce && ce.nota)
  // 7 dias da tabela + 2 dos Correios no endereco = 9. Se o prazo mostrasse 7, estaria usando a
  // transportadora travada pra calcular e prometendo ao cliente um prazo que ninguem vai cumprir.
  conta('o prazo do Ceara e calculado pelos Correios, nao pela transportadora travada',
    ce && /Chega em 9 dias úteis/.test(ce.txt), ce && ce.txt.slice(0, 70))
  // CLICAR NA TRAVADA NAO FAZ NADA: botao desabilitado que ainda muda o estado e pior que botao
  // nenhum, porque a tela passa a mostrar uma coisa e o pedido sai com outra.
  await js('(() => { const b = document.querySelector("[data-transp=five]"); if (b) b.click() })()')
  await espera(250)
  const aindaCorreios = await js('(document.querySelector("[data-transp].on")||{}).dataset.transp || ""')
  conta('clicar na transportadora travada nao muda nada', aindaCorreios === 'correios', aindaCorreios)

  await js('(() => { const e = document.querySelector("[data-k=cep]"); e.value = "88504411"; e.dispatchEvent(new Event("input")); })()')
  await espera(450)
  const foraCE = await js('(() => { const b = document.querySelector("[data-transp=five]");'
    + ' return { uf: (document.querySelector("[data-k=uf]")||{}).value || "", livre: !!(b && !b.disabled),'
    + ' nota: !!document.querySelector(".prazo-ce") } })()')
  conta('fora do Ceara a transportadora volta a valer', foraCE.uf === 'SC' && foraCE.livre === true && foraCE.nota === false, JSON.stringify(foraCE))

  // ── O 9 QUE FALTA DEPOIS DO DDD ──────────────────────────────────────
  // Pedido do Bruno em 17/10/2026: "faltou um digito no numero do celular, esse digito que falta
  // sempre e o 9, que vai depois do DDD; esses numeros que vem sem esse digito, eu gostaria que voce
  // ja adicionasse essa correcaozinha". Numero de 10 digitos ainda chega de contato antigo e de jid
  // velho do WhatsApp; sem o 9 a transportadora nao entrega e a cobranca nao acha o cliente.
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "1999598329"; e.dispatchEvent(new Event("input")); })()')
  await espera(250)
  const antesBlur = await js('({ v: (document.querySelector("[data-k=wa]")||{}).value || "",'
    + ' dica: (document.querySelector(".dica-campo")||{}).textContent || "" })')
  conta('enquanto digita, 10 digitos NAO ganham o 9 (empurraria o que ele esta digitando)',
    antesBlur.v === '(19) 9959-8329', JSON.stringify(antesBlur))
  // SAIU DO CAMPO: o 9 entra. O EVENTO AQUI E DISPARADO NA MAO, de proposito, e isto e uma limitacao
  // do teste que vale escrita: em janela com `show: false` o Chromium muda o `activeElement` quando
  // se chama `focus()`/`blur()` mas NAO dispara os eventos de foco (medido em 17/10/2026 - o handler
  // existia, o foco saia, e o `blur` nunca chegava). Mostrar a janela so pra isso abriria uma janela
  // na tela do Bruno no meio do teste, que e justamente o que a gente acabou de parar de fazer.
  //
  // Entao este trecho prova o HANDLER, e a garantia de verdade esta na hora de cadastrar (logo
  // abaixo, no pedido que vai pro servidor), que o teste clica de verdade.
  const temHandler = await js('typeof (document.querySelector("[data-k=wa]")||{}).onblur === "function"')
  conta('o campo do WhatsApp tem o conserto do 9 ligado na saida', temHandler === true, String(temHandler))
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.dispatchEvent(new FocusEvent("blur")) })()')
  await espera(300)
  const depoisBlur = await js('({ v: (document.querySelector("[data-k=wa]")||{}).value || "",'
    + ' erro: !!document.querySelector(".form .erro [data-k=wa]") })')
  conta('ao sair do campo, o 9 entra depois do DDD', depoisBlur.v === '(19) 99959-8329', JSON.stringify(depoisBlur))
  conta('e o campo para de reclamar', depoisBlur.erro === false, JSON.stringify(depoisBlur))

  // TELEFONE FIXO NAO GANHA 9: 2 a 5 no inicio do assinante e fixo, e enfiar um 9 ali INVENTA um
  // numero que nao existe. O certo e o campo reclamar e o vendedor resolver.
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "1932415566"; e.dispatchEvent(new Event("input")); e.focus(); e.blur() })()')
  await espera(300)
  const fixo = await js('(document.querySelector("[data-k=wa]")||{}).value || ""')
  conta('telefone fixo nao ganha 9 inventado', fixo === '(19) 3241-5566', fixo)
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "19995983293"; e.dispatchEvent(new Event("input")); })()')
  await espera(250)

  // ── VENDA FUTURA ───────────────────────────────────────────────────────────────────────────
  await clica('#pd-vf')
  await espera(220)
  await clica('#pd-cal')
  await espera(220)
  const cal = await js('(() => { const c = document.querySelector(".cal"); if (!c) return null;'
    + ' const dias = [...c.querySelectorAll("[data-dia]")];'
    + ' return { n: dias.length, livres: dias.filter(d => !d.disabled).length,'
    + ' primeiroLivre: (dias.find(d => !d.disabled)||{}).dataset.dia || "" } })()')
  conta('a venda futura abre um calendario proprio, no tema do painel', !!cal && cal.n > 27, JSON.stringify(cal))
  // A JANELA E DE 20 DIAS, a regra da dash: o resto do mes fica apagado.
  conta('e so deixa escolher dentro da janela de 20 dias', cal && cal.livres > 0 && cal.livres <= 21, JSON.stringify(cal))
  await js('(() => { const d = [...document.querySelectorAll("[data-dia]")].find(x => !x.disabled); if (d) d.click() })()')
  await espera(250)
  const escolhido = await js('({ txt: (document.querySelector(".vf-data")||{}).textContent || "", fechou: !document.querySelector(".cal") })')
  conta('escolher o dia fecha o calendario e mostra a data', /\d\d\/\d\d\/\d{4}/.test(escolhido.txt) && escolhido.fechou === true, JSON.stringify(escolhido))

  // ── a conferencia do app tem que ser a MESMA do Aceitar ────────────────────────────────────
  // Nome de uma palavra e telefone cortado passavam daqui e so eram recusados DEPOIS, no Aceitar do
  // Bruno, com o cliente ja esperando - e o vendedor nem ficava sabendo que o pedido parou.
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("nome","Maria"); })()')
  await clica('#pd-ok')
  await espera(250)
  const soUmNome = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "", mandou: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  conta('nome de uma palavra so e barrado AQUI, nao no Aceitar',
    /sobrenome/i.test(soUmNome.txt) && soUmNome.mandou === 0, JSON.stringify(soUmNome))

  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("nome","Cliente de Teste"); s("wa","(19) 9959"); })()')
  await clica('#pd-ok')
  await espera(250)
  const telCurto = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "", mandou: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  // UM MOTIVO SO PRO MESMO TELEFONE (17/10/2026). O quadro listava duas linhas pro mesmo problema -
  // "Faltam 5 numeros: celular tem DDD + 9 + 8 digitos" e "WhatsApp incompleto (DDD + numero)" - e a
  // dash lista uma. A segunda continua no codigo, pro caso de o telValido afrouxar, mas so fala
  // quando a primeira nao falou.
  conta('telefone incompleto tambem e barrado aqui',
    /Faltam 5 n/i.test(telCurto.txt) && telCurto.mandou === 0, JSON.stringify(telCurto))
  conta('e com um motivo so, nao dois pro mesmo telefone',
    !/WhatsApp incompleto/i.test(telCurto.txt), JSON.stringify(telCurto.txt))
  // ENTRA COM 10 DIGITOS DE PROPOSITO: daqui pra frente o teste cadastra de verdade, e e no clique
  // em Cadastrar que o 9 tem que entrar sozinho em vez de o pedido ser recusado. E o caso do Bruno:
  // o numero vem do WhatsApp sem o 9 e ele nao tem por que digitar o que a gente sabe.
  await js('(() => { const e = document.querySelector("[data-k=wa]"); e.value = "1999598329"; e.dispatchEvent(new Event("input")) })()')

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

  // ── a rede cai no meio do cadastro: a segunda tentativa tem que ser O MESMO pedido ─────────
  // O anti-duplicata do servidor casa por `id`. Com o id sorteado a cada clique, o vendedor que
  // tentava de novo depois de um erro de rede criava DOIS cards - dois pedidos na PayLog, duas
  // cobrancas, dois frascos despachados, e nenhum aviso.
  await js('window.__falhaPedido(1)')
  await clica('#pd-ok')
  await espera(400)
  const caiu = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "" })')
  conta('erro de rede aparece na tela sem dizer que falta campo',
    /dash|rede|internet/i.test(caiu.txt) && !/Falta preencher/.test(caiu.txt), JSON.stringify(caiu))

  // ── COLAR O PRINT ──────────────────────────────────────────────────────────────────────────
  // "Toda vez que a pessoa da um clique, ele ja cola o print que estava na area de transferencia;
  // caso clique duas vezes, abre a pastinha." Um clique = colar; dois = escolher arquivo.
  const antesAnexos = await js('document.querySelectorAll(".anexo.tem").length')
  await clica('#pd-anexar')
  await espera(700)
  const colou = await js('({ n: document.querySelectorAll(".anexo.tem").length,'
    + ' pediu: (window.__ver()).filter(c => c.nome === "colaPrint").length,'
    + ' nomes: [...document.querySelectorAll(".anexo.tem .nm")].map(e => e.textContent).join(",") })')
  conta('um clique no comprovante cola o print da area de transferencia',
    colou.pediu >= 1 && colou.n === antesAnexos + 1
    // NOME COM DATA E HORA, igual ao nomeDePrint da dash: o Chrome chama todo print de "image.png" e
    // o caminho do clique mandava "print.png" fixo, entao dois prints no mesmo pedido ficavam
    // indistinguiveis no modal do CRM.
    && /print-\d{8}-\d{6}\.png/.test(colou.nomes), JSON.stringify(colou))
  // O print COLADO fica: dois comprovantes no mesmo pedido e caso normal, e tirar um deles aqui
  // tiraria os dois - o stub devolve a MESMA url pra todo upload, e o botao de tirar casa por url.

  await clica('#pd-ok')
  await espera(500)
  const lista = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0]))'))
  conta('a tentativa que falhou e a seguinte sao o MESMO pedido',
    lista.length === 2 && lista[0].id === lista[1].id && lista[0].external_id === lista[1].external_id,
    JSON.stringify(lista.map((x) => x && x.id)))
  lista.splice(0, 1)   // daqui pra baixo o que vale e o envio que DEU certo
  conta('com tudo certo, o pedido vai pro servidor', lista.length === 1, String(lista.length))
  const o = lista[0] || {}
  conta('o objeto tem o formato do Novo Pedido da dash',
    o.orig === 'Manual' && /^MAN-/.test(String(o.external_id || '')) && o.col === 'A Enviar' && o.spg === 'Pendente',
    JSON.stringify({ orig: o.orig, ext: o.external_id, col: o.col, spg: o.spg }))
  conta('o tipo de pagamento vira o `mod`', o.mod === 'entrega', String(o.mod))
  // O PRECO SAI DO CATALOGO: e a regra que o campo livre de ontem quebrava.
  conta('produto e valor saem do CATALOGO, nao do que foi digitado',
    o.vl === 397 && o.trat === 'Produto A - 3 Meses', JSON.stringify({ vl: o.vl, trat: o.trat }))
  // MASCARADO, como a dash grava (17/10/2026). Ia com digitos crus, e o pedido do app aparecia
  // diferente de todos os outros na fila do Bruno: "CEP: 88501000" em Aceitacoes e CPF, telefone e
  // CEP crus no modal do CRM, inclusive nos botoes de copiar daquela tela.
  conta('CPF, telefone e CEP vao MASCARADOS, igual aos da dash',
    o.cpf === '529.982.247-25' && /^\(\d\d\) \d{5}-\d{4}$/.test(String(o.wa || '')) && o.cep === '13000-000',
    o.cpf + ' / ' + o.wa + ' / ' + o.cep)
  // E ESTA E A GARANTIA DO 9: o formulario entrou com 10 digitos (1999598329) e o pedido saiu com 11.
  // Sem isso o pedido era RECUSADO na conferencia e o vendedor tinha que digitar o 9 na mao - ou pior,
  // passava sem o 9 e a transportadora nao entregava.
  conta('o 9 que faltava entra no pedido que vai pro servidor', o.wa === '(19) 99959-8329', String(o.wa))
  conta('a UF vai em maiuscula', o.uf === 'SP', o.uf)
  // DOIS comprovantes: o arquivo escolhido e o print colado logo acima. Levar os dois e o certo -
  // o pedido pode ter mais de um, e o `comprovante_url` continua apontando pro primeiro, que e o
  // que as telas antigas leem.
  conta('o comprovante vai junto', /^https?:/.test(String(o.comprovante_url || '')) && (o.comprovantes || []).length === 2,
    String(o.comprovante_url) + ' · ' + (o.comprovantes || []).length)
  conta('a mensagem do cliente fica gravada no pedido', /Pedido Conclu/.test(String(o.raw || '')) && /397,00/.test(String(o.raw || '')), String(o.raw || '').slice(0, 40))
  conta('o painel NAO decide de quem e a venda', o.at === undefined, String(o.at))
  conta('a comissao nasce vazia, nao inventada', o.com_pct === '', JSON.stringify(o.com_pct))

  const depois = await js('({ bom: !!document.querySelector(".aviso.bom"), tipo: document.querySelectorAll("[data-tipo]").length })')
  conta('depois de cadastrar avisa e volta pro inicio', depois.bom === true && depois.tipo === 2, JSON.stringify(depois))

  // ── antecipado NAO exige comprovante ───────────────────────────────────────────────────────
  await clica('[data-tipo=antecipado]')
  await espera(350)
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("nome","Cliente de Teste");'
    + ' s("cpf","52998224725"); s("cep","13000000"); s("end","Rua A"); s("num","10");'
    + ' s("bairro","Centro"); s("cidade","Campinas"); s("uf","SP"); })()')
  await espera(200)
  await clica('[data-op=trat][data-v=k3]')
  await espera(300)
  await clica('#pd-ok')
  await espera(500)
  const nAnt = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0].mod))'))
  // Pelo ULTIMO, nao pelo indice: a lista inclui a tentativa que a rede derrubou la em cima, e
  // contar posicao faz esta conferencia quebrar toda vez que alguem acrescenta um envio antes.
  conta('pagamento antecipado passa sem comprovante',
    nAnt[nAnt.length - 1] === 'antecipado' && nAnt.filter((x) => x === 'antecipado').length === 1, JSON.stringify(nAnt))

  // -- PEDIDO PRO CEARA SAI PELOS CORREIOS, nao "no padrao da casa" -------------------------
  //
  // O FURO QUE ISTO FECHA: `transp` vazio quer dizer "transportadora", e o vendedor que nunca
  // encosta nos botoes deixa o campo vazio. No Ceara a tela MOSTRAVA Correios (porque o padrao de la
  // e Correios) e o pedido saia vazio, ou seja, lido como Transportadora - num estado que ela nao
  // atende. Tela dizendo uma coisa e pedido dizendo outra e o jeito de descobrir dias depois.
  await clica('[data-tipo=antecipado]')
  await espera(350)
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("nome","Cliente do Ceara"); s("cpf","52998224725"); s("cep","60175045"); s("num","10"); })()')
  await espera(600)
  await clica('[data-op=trat][data-v=k3]')
  await espera(300)
  const antesCE = await js('(() => { const b = document.querySelector("[data-transp=five]");'
    + ' return { uf: (document.querySelector("[data-k=uf]")||{}).value || "", travada: !!(b && b.disabled) } })()')
  conta('o CEP do Ceara chega pelo caminho de verdade e trava a transportadora',
    antesCE.uf === 'CE' && antesCE.travada === true, JSON.stringify(antesCE))
  await clica('#pd-ok')
  await espera(600)
  const ceEnv = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0]).slice(-1))'))[0] || {}
  conta('pedido pro Ceara vai gravado como correios, sem o vendedor clicar em nada',
    ceEnv.transp === 'correios' && ceEnv.uf === 'CE', JSON.stringify({ uf: ceEnv.uf, transp: ceEnv.transp, nome: ceEnv.nome }))

  // ── O RASCUNHO GRAVA SOZINHO ENQUANTO ELE DIGITA ───────────────────────────────────────────
  //
  // Antes o rascunho so era gravado nas SAIDAS (trocar de aba, de conversa, de cliente ou de tipo) e
  // no botao Rascunho. Isso deixava de fora o unico caso em que o rascunho existe pra servir: o app
  // fechar, o Windows reiniciar ou a tela recarregar no meio do cadastro. A dash grava 1s depois da
  // ultima tecla; aqui e 1,5s, porque cada gravacao fala com o servidor.
  await clica('[data-tipo=entrega]')
  await espera(350)
  const antesSozinho = Number(await js('(window.__ver()).filter(c => c.nome === "rascunhoSalvar").length'))
  await js('(() => { const e = document.querySelector("[data-k=nome]"); e.value = "Cliente Que Digita"; e.dispatchEvent(new Event("input")) })()')
  await espera(600)
  const noMeio = Number(await js('(window.__ver()).filter(c => c.nome === "rascunhoSalvar").length'))
  conta('nao grava a cada tecla (600ms depois ainda nao gravou)', noMeio === antesSozinho, antesSozinho + ' -> ' + noMeio)
  await espera(1600)
  const depoisSozinho = Number(await js('(window.__ver()).filter(c => c.nome === "rascunhoSalvar").length'))
  conta('mas grava sozinho 1,5s depois da ultima tecla, sem ele sair de lugar nenhum',
    depoisSozinho === antesSozinho + 1, antesSozinho + ' -> ' + depoisSozinho)
  await clica('#pd-voltar')
  await espera(400)

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

  // ── O CARTAO DO RASCUNHO, E A VELOCIDADE DE APAGAR ───────────────────────
  //
  // Pedido do Bruno em 17/10/2026: "gostaria que eles ficassem um pouco mais parecidos com os
  // rascunhos da area de cadastro de pedidos. Eles tem ali uma lixeirinha vermelha e um botaozinho
  // liso escrito Continuar. A unica coisa que eu gostei dessas coisas novas e o icone de canetinha
  // em amarelo, que ficou bem legal, e com o numero ou o nome da pessoa".
  const cartaoRasc = await js('(() => { const c = document.querySelector(".rasc"); if (!c) return null;'
    + ' const lixo = c.querySelector(".lixo"); const segue = c.querySelector(".segue");'
    + ' const ic = c.querySelector(".ic");'
    + ' return { temSegue: !!segue, txtSegue: segue ? segue.textContent.trim() : "",'
    + ' corLixo: lixo ? getComputedStyle(lixo).color : "", corIc: ic ? getComputedStyle(ic).color : "",'
    + ' t1: (c.querySelector(".t1")||{}).textContent || "" } })()')
  conta('o rascunho ganha o botao liso "Continuar", como na dash',
    !!cartaoRasc && cartaoRasc.temSegue && /Continuar/.test(cartaoRasc.txtSegue), JSON.stringify(cartao))
  // VERMELHO DE VERDADE, nao cinza: era um X apagado que nao dizia que aquilo apaga.
  conta('e a lixeira e vermelha', !!cartaoRasc && /^rgb\(240, 80, 106\)/.test(cartaoRasc.corLixo), cartaoRasc && cartaoRasc.corLixo)
  // O QUE ELE DISSE QUE GOSTOU FICA: a caneta ambar e o nome ou numero na primeira linha.
  conta('a canetinha ambar continua', !!cartaoRasc && /^rgb\(255, 185, 0\)/.test(cartaoRasc.corIc), cartaoRasc && cartaoRasc.corIc)
  conta('e o nome ou numero continua na primeira linha', !!cartaoRasc && cartaoRasc.t1.trim().length > 0, cartaoRasc && cartaoRasc.t1)

  // APAGAR NAO ESPERA O SERVIDOR. Ele sentiu e estava certo: antes era uma gravacao E uma listagem
  // inteira, as duas com a tela parada. Com o duble demorando 700ms, o cartao tem que sumir ANTES.
  await js('window.__demoraApagar(700); "ok"')
  const antesApagar = await js('document.querySelectorAll(".rasc").length')
  await js('(() => { const b = document.querySelector(".rasc .lixo"); if (b) b.click() })()')
  await espera(150)
  const logoApos = await js('document.querySelectorAll(".rasc").length')
  conta('o cartao some na hora do clique, sem esperar o servidor',
    logoApos === antesApagar - 1, antesApagar + ' -> ' + logoApos + ' em 150ms')
  await espera(900)

  // MAS SE O SERVIDOR RECUSAR, O CARTAO VOLTA. Sumir da tela e continuar no servidor seria ele
  // achar que apagou e o rascunho reaparecer sozinho no proximo pulso, sem explicacao.
  await js('window.__demoraApagar(0); window.__falhaApagar(1); "ok"')
  await js('(() => { pegaRascunhos() })()').catch(() => {})
  await espera(400)
  const temDeNovo = await js('document.querySelectorAll(".rasc").length')
  if (temDeNovo > 0) {
    await js('(() => { const b = document.querySelector(".rasc .lixo"); if (b) b.click() })()')
    await espera(500)
    const voltou = await js('({ n: document.querySelectorAll(".rasc").length,'
      + ' aviso: (document.querySelector(".aviso.ruim")||{}).textContent || "" })')
    conta('servidor recusando o apagar devolve o cartao e avisa',
      voltou.n === temDeNovo && /continua a/i.test(voltou.aviso), JSON.stringify(voltou))
  } else {
    conta('servidor recusando o apagar devolve o cartao e avisa', false, 'nao sobrou rascunho pra testar')
  }
  await js('window.__falhaApagar(0); "ok"')

  // ── O LEAD FICA CONGELADO quando a conversa muda no meio ───────────────────────────────────
  await clica('[data-tipo=entrega]')
  await espera(350)
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); e.value = v; e.dispatchEvent(new Event("input")) }; s("cidade","Campinas") })()')
  // o pulso troca a conversa por baixo, como quando o vendedor clica noutro chat
  await js('(() => { window.__trocaConversa("5511988887777", "Outro Cliente") })()')
  await espera(2200)
  const congelado = await js('({ dono: (document.querySelector(".dono-ped .q")||{}).textContent || "", aviso: !!document.querySelector(".dono-ped .a"), wa: (document.querySelector("[data-k=wa]")||{}).value || "" })')
  conta('trocar de conversa NAO muda o dono do pedido', /99598-3293/.test(congelado.dono), JSON.stringify(congelado))
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

  // DAQUI PRA BAIXO, SO OS SAVES DESTE TRECHO. A conferencia do id (logo abaixo) olhava o log
  // INTEIRO e exigia "o primeiro sem id, todos os seguintes com id" - e isso so era verdade por
  // acidente do roteiro. Comecar um rascunho NOVO zera o id de proposito (e o que o Trocar, o
  // Voltar e o cadastro que deu certo fazem), entao um id vazio no meio do log e comportamento
  // certo, nao defeito. Quando a gravacao automatica entrou, o log ganhou um save a mais e a
  // conferencia acusou um bug que nao existia.
  const rascAntesTroca = Number(await js('(window.__ver()).filter(c => c.nome === "rascunhoSalvar").length'))
  await clica('#pd-troca')
  await espera(700)
  const dps = await js('({ dono: (document.querySelector(".dono-ped .q")||{}).textContent || "",'
    + ' aviso: !!document.querySelector(".dono-ped .a"), botao: !!document.getElementById("pd-troca"),'
    + ' wa: (document.querySelector("[data-k=wa]")||{}).value || "",'
    + ' cidade: (document.querySelector("[data-k=cidade]")||{}).value || "",'
    + ' msg: (document.querySelector(".aviso.bom")||{}).textContent || "" })')
  conta('depois de trocar, o pedido e do cliente novo', /98888-7777/.test(dps.dono), JSON.stringify(dps))
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
  // A CONFERENCIA E "EXISTE REUSO", nao uma sequencia fixa de ids.
  //
  // A versao antiga exigia "o primeiro sem id, todos os seguintes com id", e isso era verdade por
  // acidente do roteiro: comecar um rascunho NOVO zera o id de proposito (e o que o Trocar, o Voltar
  // e o cadastro que deu certo fazem), entao id vazio no meio do log e comportamento CERTO. Quando a
  // gravacao automatica entrou, o log ganhou um save e a conferencia acusou um bug que nao existia -
  // e escopar no trecho do Trocar tambem nao servia, porque ali o save e do rascunho ANTIGO, que ja
  // tinha id. O que importa e o defeito de verdade: o painel guarda o id que o servidor devolveu e
  // manda ele na gravacao seguinte do MESMO rascunho, em vez de abrir uma linha nova a cada vez.
  const primeiroSemId = (chamR[0] || [])[0] === ''
  const reusou = chamR.some((c, i) => i > 0 && c[0] && chamR[i - 1][0] === '' && chamR[i - 1][1] === c[1])
  conta('o 1o save vai sem id, e a gravacao seguinte do mesmo rascunho reusa o que o servidor deu',
    primeiroSemId && reusou, JSON.stringify(chamR.map((c) => c[0])))
  // E NINGUEM INVENTA ID: todo id que sai do painel e um que o servidor devolveu (o duble cunha
  // 99000N). Id inventado era o outro lado do mesmo defeito - o worker recusava e o rascunho sumia.
  const idsInventados = chamR.filter((c) => c[0] && !/^99000\d+$/.test(c[0])).map((c) => c[0])
  conta('e nenhum id sai do painel sem ter vindo do servidor', idsInventados.length === 0, JSON.stringify(idsInventados))

  // ── CADASTRAR COM A CONVERSA TROCADA PEDE CONFIRMACAO ──────────────────────────
  // A faixa ambar e o botao avisam; esta e a ultima trava, e e o que ele pediu em palavras: "pra
  // que o meu vendedor nao confunda e acabe subindo um pedido pra um cliente que ja saiu".
  await js('(() => { const s = (k,v) => { const e = document.querySelector("[data-k="+k+"]"); if (!e) return;'
    + ' e.value = v; e.dispatchEvent(new Event("input")) };'
    + ' s("nome","Outro Cliente");'
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
  // O DONO AQUI JA E O CLIENTE NOVO: a troca de lead aconteceu la em cima, entao o pedido e do
  // 8888-7777 e a tela esta em outra conversa. E o telefone que identifica, nao o nome - o titulo
  // da conversa deixou de ser usado como nome em 16/10.
  conta('e o aviso diz de QUEM e o pedido', /98888-7777/.test(conf1.txt), conf1.txt.slice(0, 120))
  await clica('#pd-ok')
  await espera(600)
  const conf2 = JSON.parse(await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0].wa))'))
  conta('o segundo clique confirma e manda', conf2.length === antesConf + 1, String(conf2.length))
  // O `wa` vai MASCARADO e sem o 55 (montaPedido usa mascTel), entao o que se confere e que e o
  // numero do dono congelado e NAO o da conversa que estava na tela na hora do clique.
  const ultWa = String(conf2[conf2.length - 1] || '')
  conta('e o pedido sai com o telefone do dono CONGELADO, nao o da tela',
    ultWa === '(11) 98888-7777' && !/2197000/.test(ultWa), ultWa)

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
  // O RODAPE E LIDO NO MESMO TURNO DO CLIQUE, e isto nao e detalhe de estilo.
  //
  // O aviso "Na fila" e escrito UMA VEZ, dentro do proprio clique (painel-ui.js, o `if (pos > 1)
  // rodape(...)`), e o laco de disparo sobrescreve o rodape com "digitando 2 de 2" no instante
  // seguinte. Ler 300ms depois e apostar numa corrida: falhava em uma de cada tres rodadas, e
  // alargar a espera piorou. Clicar e ler na mesma expressao e deterministico, porque o `rodape`
  // roda sincrono dentro do handler.
  const rodFila = await js('(() => { const b = document.querySelector("[data-funil=s1]");'
    + ' if (!b) return "(sem botao)"; b.click();'
    + ' return (document.getElementById("rod")||{}).textContent || "" })()')
  conta('o rodape diz a posicao na fila, como o inbox', /Na fila/.test(rodFila), rodFila)
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
  //
  // ESPERA O RODAPE EM VEZ DE FOTOGRAFAR UM INSTANTE. O rodape alterna entre o estado do envio que
  // esta correndo ("digitando 2 de 2") e o da fila, e ler uma vez no meio de um envio de 1,2s dava
  // falha intermitente - teste que falha as vezes vira teste que ninguem olha.
  // A ORDEM AQUI IMPORTA, e e por isso que estas duas conferencias foram reescritas em 17/10/2026:
  // A FILA ANDA SOZINHA ENQUANTO O TESTE ROLA. Cada envio do duble demora 1,2s de proposito, entao
  // tudo que o teste gasta esperando come a fila que ele ia conferir depois. A versao antiga
  // esperava ate 3s pelo rodape e SO DEPOIS tentava tirar alguem da fila - quando chegava la, nem
  // sempre havia dois pra tirar. Falhou em uma de cada tres rodadas, e alargar a espera piorou
  // (duas de tres), porque o problema nunca foi a janela: era gastar tempo antes de medir.
  //
  // Agora: tira da fila PRIMEIRO, agora que a gente sabe que ela tem tres, e conta RELATIVO.
  const tirou = await js('(() => { const bs = document.querySelectorAll(".saindo .item-env [data-tirafila]");'
    + ' if (bs.length < 2) return { erro: "menos de 2 na fila" };'
    + ' const antes = document.querySelectorAll(".saindo .item-env").length;'
    + ' bs[bs.length - 1].click();'
    + ' return { antes, depois: document.querySelectorAll(".saindo .item-env").length } })()')
  conta('da pra tirar da fila quem ainda nao saiu',
    !!tirou && tirou.depois === tirou.antes - 1, JSON.stringify(tirou))



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
  conta('e diz quantos leads chegaram hoje', /10 leads/.test(sec.aquecQtd), sec.aquecQtd)
  // 3 em uso + 1 em aquecimento = 4 interruptores; o "Em analise" fica com o selo
  // 3 em uso + 1 em aquecimento = 4 interruptores; "Em analise" e "Restrito" ficam com o selo
  conta('interruptor so pra quem pode receber', sec.chaves === 5 && sec.selos === 2, JSON.stringify(sec))
  // O SERVIDOR VENCE O CAMPO CRU: numero com em_uso true e apto false NAO ganha interruptor. Sem
  // esta conferencia, trocar o ternario por um OU devolveria o interruptor pra numero restrito, e
  // isso e mentira de tela no lado perigoso - o vendedor acharia que esta recebendo e nao esta.
  const reprovado = await js2('(() => { const l = [...document.querySelectorAll(".num")].find(e => /77003344|7700-3344/.test(e.textContent.replace(/\D/g, "")) || /7700-3344/.test(e.textContent));'
    + ' return l ? { temChave: !!l.querySelector(".sw"), temSelo: !!l.querySelector(".sw-off") } : null })()')
  conta('servidor reprovou vence o em_uso parado no campo',
    reprovado && reprovado.temChave === false && reprovado.temSelo === true, JSON.stringify(reprovado))

  const largaAntes = await js2('document.querySelector("aside").getBoundingClientRect().width')
  conta('a barra comeca larga', Math.round(largaAntes) === 268, String(largaAntes))

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  const fina = await js2('({ larg: Math.round(document.querySelector("aside").getBoundingClientRect().width), classe: document.body.className, pediu: (window.__ver()).filter(c => c.nome === "barra").map(c => c.args[0]) })')
  conta('clicar encolhe a barra pra 56px', fina.larg === 56, JSON.stringify(fina))
  conta('e avisa o processo principal, que e quem move a view', JSON.stringify(fina.pediu) === '[true]', JSON.stringify(fina.pediu))

  // A ORDEM ESPERADA SAI DO PROPRIO STUB, com a mesma regra da tela: agrupa por vendedor (na ordem
  // em que aparecem), dentro do grupo quem esta na roleta sobe, e o aquecimento de TODOS vai pro
  // fim, depois da barrinha. Escrever a lista a mao quebrava a cada numero novo, e o erro parecia
  // regressao quando era so contagem.
  const esperado = await js2('(() => { const ns = window.__stub().numeros;'
    + ' const aq = (n) => n.aquecendo === true || n.aquec != null || String(n.st || "") === "aquecimento";'
    + ' const donos = []; for (const n of ns) if (!donos.includes(n.dono)) donos.push(n.dono);'
    + ' const porDono = (f) => donos.flatMap(d => ns.filter(n => n.dono === d && f(n))'
    + '   .sort((a, b) => (b.roleta ? 1 : 0) - (a.roleta ? 1 : 0)));'
    + ' const q = [...porDono(n => !aq(n)), ...porDono(aq)];'
    + ' return { n: ns.length, digitos: q.map(x => x.numero.slice(-4)).join(","),'
    + ' naAquec: porDono(aq).map(x => x.numero.slice(-4)).join(",") } })()')
  const dentro = await js2('({ fino: document.querySelectorAll(".fino").length, d: [...document.querySelectorAll(".fino .d")].map(e => e.textContent).join(","), c: [...document.querySelectorAll(".fino .c")].map(e => e.textContent).join(","), vend: document.querySelectorAll(".vend").length, busca: getComputedStyle(document.querySelector(".busca")).display })')
  conta('encolhida, mostra um numero por linha', dentro.fino === esperado.n, dentro.fino + ' de ' + esperado.n)
  conta('mostra os 4 ultimos digitos', dentro.d === esperado.digitos, dentro.d + '   esperado ' + esperado.digitos)
  // O '3/5' do 8551 PROVA que o teto sai da rampa: o `lim_dia` dele no stub e zero.
  conta('mostra o contador do dia', dentro.c === '70/70,32/70,0,0,0/70,3/5,7/20', dentro.c)
  conta('esconde a busca e o cabecalho de vendedor', dentro.vend === 0 && dentro.busca === 'none', JSON.stringify(dentro))

  const destFino = await js2('(() => { const r = [...document.querySelectorAll(".fino")].map(e => e.className);'
    + ' return { total: r.length, n: r.filter(c => /recebendo/.test(c)).length,'
    + ' qual: [...document.querySelectorAll(".fino.recebendo .d")].map(e => e.textContent).join(",") } })()')
  // DOIS destacados, e esta certo: o estabelecido da vez e o em aquecimento, que recebe em
  // paralelo (entra na FRENTE da fila com teto pequeno). Se um dia so um aparecer aqui, ou o
  // aquecimento saiu da roleta ou a fila voltou a ser serial entre os dois, e os dois sao bug.
  conta('encolhida, o destaque de "recebendo agora" tambem aparece', destFino.n === 2 && destFino.qual === '3293,8551', JSON.stringify(destFino))

  // ── A BARRINHA LARANJA DA BARRA ENCOLHIDA ─────────────────────────────────────────────────
  // Encolhida nao ha cabecalho nenhum, entao sem a barrinha o numero em aquecimento fica igual
  // aos de venda: "nao sei qual deles esta em aquecimento ou qual e o numero de vendas normal".
  // Conferir que ela EXISTE nao basta - tem que estar na posicao certa, senao ela separa o
  // lugar errado e mente com mais confianca do que separacao nenhuma.
  const risco = await js2('(() => { const r = document.querySelector(".risco-aq"); if (!r) return null;'
    + ' const itens = [...document.querySelector(".lista").children];'
    + ' const i = itens.indexOf(r);'
    + ' const dig = (e) => (e.querySelector(".d") || {}).textContent || "";'
    + ' return { i, antes: itens.slice(0, i).map(dig).join(","), depois: itens.slice(i + 1).map(dig).join(","),'
    + ' cor: getComputedStyle(r).borderTopColor, fogo: !!r.querySelector("svg") } })()')
  conta('encolhida, uma barrinha separa o aquecimento', !!risco && risco.fogo === true, JSON.stringify(risco))
  conta('e ela fica na divisa certa: tudo que aquece embaixo dela',
    risco && risco.depois === esperado.naAquec, JSON.stringify(risco) + '   esperado embaixo: ' + esperado.naAquec)
  conta('na cor do aquecimento', risco && /245, 158, 11/.test(risco.cor), risco && risco.cor)

  await js2('document.getElementById("encolhe").click()')
  await espera(600)
  // O DESTAQUE na barra larga, que e onde ele olha no dia a dia. So UM dos tres: os outros estao
  // no limite e desligado. Destacar todos os ligados nao diria nada.
  const dest = await js2('(() => { const r = [...document.querySelectorAll(".num")].map(e => e.className);'
    + ' return { total: r.length, n: r.filter(c => /recebendo/.test(c)).length,'
    + ' qual: [...document.querySelectorAll(".num.recebendo .fone")].map(e => e.textContent.trim()).join(",") } })()')
  conta('so quem esta na vez fica destacado', dest.total === esperado.n && dest.n === 2, JSON.stringify(dest))
  conta('e sao o estabelecido da vez e o em aquecimento', /99598-3293/.test(dest.qual) && /97406-8551/.test(dest.qual), dest.qual)

  // ── O DIA DO AQUECIMENTO NA LINHA, com o foguinho ─────────────────────────────────────────
  // Com rampa, "aquecendo" sozinho cobre um numero que recebe 5 e um que recebe 50. O dia e o
  // que diz qual dos dois. Tem que estar ANTES do icone do WhatsApp, que foi onde ele pediu.
  const selo8551 = await js2('(() => { const l = [...document.querySelectorAll(".num")].find(e => /97406-8551/.test(e.textContent));'
    + ' if (!l) return null; const aq = l.querySelector(".sub .aq"); const sub = [...l.querySelectorAll(".sub > *")].map(e => e.className.split(" ")[0]);'
    + ' return { txt: aq ? aq.textContent.trim() : "", fogo: !!(aq && aq.querySelector("svg")), ordem: sub.join(","),'
    + ' cor: aq ? getComputedStyle(aq).color : "" } })()')
  conta('o numero em aquecimento mostra o dia na linha', selo8551 && selo8551.txt === 'dia 3', JSON.stringify(selo8551))
  conta('com o foguinho, e a esquerda do icone do WhatsApp',
    selo8551 && selo8551.fogo === true && /^aq,zap/.test(selo8551.ordem), JSON.stringify(selo8551))
  conta('na cor do aquecimento', selo8551 && selo8551.cor === 'rgb(245, 158, 11)', selo8551 && selo8551.cor)
  // E o contador do mesmo numero sai da RAMPA: o lim_dia dele e zero.
  const cnt8551 = await js2('(() => { const l = [...document.querySelectorAll(".num")].find(e => /97406-8551/.test(e.textContent));'
    + ' const c = l && l.querySelector(".cnt"); return c ? c.textContent.replace(/\s+/g, " ").trim() : "" })()')
  conta('e o contador dele vem do teto da rampa, nao do campo do chip', /^3\/5/.test(cnt8551), cnt8551)
  // ── AQUECENDO QUE JA PEGOU A COTA DESTA HORA ──────────────────────────────────────────────
  // Sem a fila carimbada pelo worker, este numero escrevia "recebendo" em verde e com o contorno
  // de "recebendo agora" nas horas em que o worker tinha segurado ele - e a Chegada de leads, no
  // mesmo instante, dizia o contrario. Duas telas discordando sobre quem recebe lead.
  // E o rotulo NAO pode ser "no limite": a cota da rampa volta na hora seguinte, nao a meia-noite.
  const naCota = await js2('(() => { const l = [...document.querySelectorAll(".num")].find(e => /97700-5566|7700-5566/.test(e.textContent));'
    + ' if (!l) return null; const c = l.querySelector(".cnt");'
    + ' return { destacado: /recebendo/.test(l.className), txt: c ? c.textContent.replace(/\\s+/g, " ").trim() : "",'
    + ' dica: l.getAttribute("title") || "" } })()')
  conta('aquecendo que pegou a cota da hora NAO fica destacado', naCota && naCota.destacado === false, JSON.stringify(naCota))
  conta('e o contador dele diz "no ritmo", nao "no limite"',
    naCota && /7\/20/.test(naCota.txt) && /no ritmo/.test(naCota.txt) && !/no limite/.test(naCota.txt), JSON.stringify(naCota))
  conta('e o passe de mouse explica que volta daqui a pouco',
    naCota && /daqui a pouco/.test(naCota.dica) && !/meia-noite/.test(naCota.dica), naCota && naCota.dica)

  // O numero que NAO aquece nao pode ganhar o selo - senao o sinal perde o sentido.
  const semSelo = await js2('[...document.querySelectorAll(".num")].filter(e => e.querySelector(".sub .aq")).length')
  conta('e so o que aquece ganha o selo', semSelo === 2, String(semSelo))

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
