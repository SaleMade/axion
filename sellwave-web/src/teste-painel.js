// TESTE DA ABA PEDIDOS do painel do Sellwave Web.
//
// Abre o painel.html DE VERDADE num Electron sem janela, com um preload falso no lugar do processo
// principal, e confere que a aba desenha, que o formulario aceita o que o vendedor digita, que a
// conferencia barra o que falta e que o objeto que sai e o mesmo que a dash manda.
//
// POR QUE ISTO EXISTE: ja houve versao deste projeto em que uma funcao chamava a si mesma e NENHUM
// dialogo abria, com a tela em branco e nada no console. Conferir que "o arquivo tem a funcao" nao
// pega isso; abrir a tela e clicar pega.
//
// Roda (de dentro de AXION/sellwave-web, pelo binario, com ELECTRON_RUN_AS_NODE fora):
//   npm run teste-painel
// (ou, na mao: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-painel.js)

// ELECTRON_RUN_AS_NODE LIGADO = o binario vira Node puro, `require('electron')` devolve so um
// caminho e `app` vem undefined. O erro que sai disso nao explica nada. Neste ambiente essa env
// vive setada, entao avisa e sai, em vez de estourar em outro lugar.
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('ELECTRON_RUN_AS_NODE esta ligado: este teste precisa do Electron de verdade.')
  console.log('Rode assim:  env -u ELECTRON_RUN_AS_NODE npx electron src/teste-painel.js')
  process.exit(2)
}

const { app, BrowserWindow } = require('electron')
const path = require('path')

const PROJ = path.join(__dirname, '..')
const PRELOAD = path.join(__dirname, 'teste-painel-preload.js')

let ok = 0, falhas = []
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')) }
}

// Teto duro: se qualquer coisa pendurar, o teste MORRE em vez de ficar segurando o terminal.
setTimeout(() => { console.log('ESTOUROU O TEMPO (60s). Ultimo ponto: ' + ponto); app.exit(1) }, 60000)
let ponto = 'antes do whenReady'

process.on('unhandledRejection', (e) => { console.log('PROMESSA SOLTA em ' + ponto + ': ' + (e && e.message)); app.exit(1) })

app.whenReady().then(async () => {
  ponto = 'whenReady'
  console.log('[1] electron pronto')
  const win = new BrowserWindow({
    show: false, width: 300, height: 900,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true },
  })

  const erros = []
  win.webContents.on('console-message', (ev) => { if (ev && (ev.level === 'error' || ev.level === 'warning')) erros.push(String(ev.message || '')) })
  win.webContents.on('render-process-gone', (_e, d) => erros.push('processo morreu: ' + JSON.stringify(d)))

  win.webContents.on('did-fail-load', (_e, cod, desc, url) => console.log('[!] nao carregou: ' + cod + ' ' + desc + ' ' + url))
  ponto = 'loadFile'
  console.log('[2] carregando ' + path.join(PROJ, 'src/ui/painel.html'))
  await win.loadFile(path.join(PROJ, 'src/ui/painel.html'))
  console.log('[3] carregou')
  ponto = 'pos-load'
  const js = (codigo) => win.webContents.executeJavaScript(codigo, true)
  const espera = (ms) => new Promise((r) => setTimeout(r, ms))

  console.log('TESTE DA ABA PEDIDOS\n')

  // O pulso roda a cada 1,5s e e ele quem preenche o lead e o estado.
  await espera(2200)

  // 1) A aba existe e tem o rotulo certo
  const abas = await js('[...document.querySelectorAll(".aba")].map(b => b.dataset.aba).join(",")')
  conta('a aba Pedidos existe junto das outras duas', abas === 'itens,funis,pedidos', abas)

  // 2) O selo conta os rascunhos que vieram do servidor
  const selo = await js('({ escondido: $("selo-pedidos").hidden, txt: $("selo-pedidos").textContent })')
  conta('o selo mostra 1 rascunho', selo.escondido === false && selo.txt === '1', JSON.stringify(selo))

  // 3) O botao colorido aparece ao lado do cliente
  const temBotao = await js('!!document.getElementById("lead-cad")')
  conta('o botao de cadastro aparece no bloco do cliente', temBotao)

  // 4) Clicar nele abre a aba (e o caminho que o Bruno pediu)
  await js('document.getElementById("lead-cad").click()')
  await espera(150)
  const abriu = await js('document.querySelector(".aba.on").dataset.aba')
  conta('clicar no botao abre a aba Pedidos', abriu === 'pedidos', abriu)

  // 5) O formulario desenhou, com todos os campos
  const campos = await js('[...document.querySelectorAll("#corpo [data-k]")].map(e => e.dataset.k).join(",")')
  const esperados = ['nome', 'cpf', 'wa', 'cep', 'end', 'num', 'comp', 'bairro', 'cidade', 'uf', 'trat', 'vl', 'pgto', 'obs']
  conta('todos os 14 campos desenharam', esperados.every((k) => campos.split(',').includes(k)), campos)

  // 6) A previa do cliente entrou sozinha: numero da conversa e nome
  const pre = await js('({ wa: document.querySelector("[data-k=wa]").value, nome: document.querySelector("[data-k=nome]").value })')
  conta('o numero da conversa entra sozinho', pre.wa === '(19) 99598-3293', pre.wa)
  conta('o nome do cliente entra sozinho', pre.nome === 'Cliente de Teste', pre.nome)

  // 7) A busca some: ela filtra item, nao pedido
  const cabeca = await js('getComputedStyle($("cabeca")).display')
  conta('a busca de itens some na aba Pedidos', cabeca === 'none', cabeca)

  // 8) O rascunho aparece na lista, com rotulo util
  const rasc = await js('({ n: document.querySelectorAll(".rasc").length, t1: (document.querySelector(".rasc .t1")||{}).textContent, t2: (document.querySelector(".rasc .t2")||{}).textContent })')
  conta('o rascunho aparece com nome e detalhe', rasc.n === 1 && rasc.t1 === 'Maria Teste' && /Produto A/.test(rasc.t2 || ''), JSON.stringify(rasc))

  // 9) CADASTRAR VAZIO NAO MANDA NADA e diz o que falta
  await js('document.getElementById("pd-ok").click()')
  await espera(250)
  const barrou = await js('({ aviso: !!document.querySelector(".aviso.ruim"), mandou: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  conta('cadastro sem os campos obrigatorios nao vai pro servidor', barrou.aviso === true && barrou.mandou === 0, JSON.stringify(barrou))

  // 10) CPF INVALIDO E BARRADO (a conta dos dois digitos, nao so o tamanho)
  await js(`(() => {
    const set = (k, v) => { const e = document.querySelector('[data-k=' + k + ']'); e.value = v; e.dispatchEvent(new Event('input')) };
    set('nome','Jose Teste'); set('cpf','11111111111'); set('cep','13000000'); set('end','Rua A');
    set('num','10'); set('bairro','Centro'); set('cidade','Campinas'); set('uf','sp');
    set('trat','Produto A - 3 Meses'); set('vl','197,00');
  })()`)
  await js('document.getElementById("pd-ok").click()')
  await espera(250)
  const cpfRuim = await js('({ txt: (document.querySelector(".aviso.ruim")||{}).textContent || "", mandou: (window.__ver()).filter(c => c.nome === "pedidoNovo").length })')
  conta('CPF que nao fecha a conta e barrado', /CPF/.test(cpfRuim.txt) && cpfRuim.mandou === 0, JSON.stringify(cpfRuim))

  // 11) COM TUDO CERTO, MANDA, e o objeto e o da dash
  await js(`(() => {
    const e = document.querySelector('[data-k=cpf]'); e.value = '52998224725'; e.dispatchEvent(new Event('input'));
  })()`)
  await js('document.getElementById("pd-ok").click()')
  await espera(400)
  const enviado = await js('JSON.stringify((window.__ver()).filter(c => c.nome === "pedidoNovo").map(c => c.args[0]))')
  const lista = JSON.parse(enviado)
  conta('com tudo certo, o pedido vai pro servidor', lista.length === 1, enviado.slice(0, 120))
  const o = lista[0] || {}
  conta('o objeto tem o formato do Novo Pedido da dash',
    o.orig === 'Manual' && /^MAN-/.test(String(o.external_id || '')) && o.col === 'A Enviar'
    && o.spg === 'Pendente' && o.mod === 'entrega' && o.five_status === 'pendente_despacho',
    JSON.stringify({ orig: o.orig, ext: o.external_id, col: o.col, spg: o.spg, mod: o.mod, fs: o.five_status }))
  conta('o valor digitado em reais vira numero', o.vl === 197, String(o.vl))
  conta('o CPF e o telefone vao so com digitos', o.cpf === '52998224725' && o.wa === '19995983293', o.cpf + ' / ' + o.wa)
  conta('a UF vai em maiuscula', o.uf === 'SP', o.uf)
  conta('a mensagem do cliente fica gravada no pedido', /Pedido Conclu/.test(String(o.raw || '')) && /197,00/.test(String(o.raw || '')), String(o.raw || '').slice(0, 40))
  conta('o painel NAO decide de quem e a venda', o.at === undefined, String(o.at))
  conta('a comissao nasce vazia, nao inventada', o.com_pct === '', JSON.stringify(o.com_pct))

  // 12) Depois de cadastrar, a tela diz que foi e limpa o formulario
  const depois = await js('({ bom: !!document.querySelector(".aviso.bom"), nome: (document.querySelector("[data-k=nome]")||{}).value, cpf: (document.querySelector("[data-k=cpf]")||{}).value, vl: (document.querySelector("[data-k=vl]")||{}).value, end: (document.querySelector("[data-k=end]")||{}).value })')
  conta('depois de cadastrar, avisa e limpa o pedido', depois.bom === true && depois.cpf === '' && depois.vl === '' && depois.end === '', JSON.stringify(depois))
  conta('e o cliente da conversa volta preenchido, pra nao redigitar', depois.nome === 'Cliente de Teste', depois.nome)

  // 13) O rascunho salva o que esta pela metade, SEM conferir nada
  await js(`(() => {
    const set = (k, v) => { const e = document.querySelector('[data-k=' + k + ']'); e.value = v; e.dispatchEvent(new Event('input')) };
    set('nome','So o nome por enquanto');
  })()`)
  await js('document.getElementById("pd-rasc").click()')
  await espera(300)
  const rascOk = await js('JSON.stringify((window.__ver()).filter(c => c.nome === "rascunhoSalvar").map(c => c.args))')
  const rl = JSON.parse(rascOk)
  conta('o rascunho guarda mesmo faltando campo obrigatorio', rl.length === 1 && rl[0][2] && rl[0][2].nome === 'So o nome por enquanto', rascOk.slice(0, 140))

  // 14) A PILHA DE DISPAROS no topo da aba Funis
  await js('document.querySelector("[data-aba=funis]").click()')
  await espera(200)
  const pil = await js('({ tem: !!document.querySelector(".saindo"), nm: (document.querySelector(".saindo .nm")||{}).textContent || "", ln: (document.querySelector(".saindo .ln")||{}).textContent || "", passos: document.querySelectorAll(".saindo .passos i").length, feitos: document.querySelectorAll(".saindo .passos i.ja").length })')
  conta('a pilha mostra o funil que esta saindo', pil.tem === true && /Boas-vindas/.test(pil.nm), JSON.stringify(pil))
  conta('mostra em que passo esta', /2 de 5/.test(pil.nm), pil.nm)
  conta('mostra por qual numero e pra quem', /97401-5754/.test(pil.ln) && /99598-3293/.test(pil.ln), pil.ln)
  conta('a barrinha tem um tracinho por passo, 2 preenchidos', pil.passos === 5 && pil.feitos === 2, pil.passos + '/' + pil.feitos)

  // 15) Nada quebrou no console
  conta('nenhum erro de javascript na tela', erros.length === 0, erros.join(' | ').slice(0, 200))

  console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram')
  if (falhas.length) console.log('  falharam: ' + falhas.join(', '))
  win.destroy()
  app.exit(falhas.length ? 1 : 0)
})
