// SellWave Web - processo principal.
//
// O que este arquivo faz: abre uma janela com a casca da SellWave (barra lateral) e, pra cada
// numero de WhatsApp, cria uma WebContentsView COMPLETAMENTE isolada (particao propria, proxy
// proprio) carregando web.whatsapp.com.
//
// LEIA ANEXO-TECNICO.md ANTES DE MEXER. Quase toda linha estranha aqui existe por causa de uma
// armadilha medida em 15/10/2026, e o comentario diz qual.

const { app, BaseWindow, WebContentsView, session, ipcMain, shell, dialog, safeStorage, protocol, net, clipboard, powerMonitor } = require('electron')

// ─── A MIDIA DA PREVIA (16/10/2026) ──────────────────────────────────────────────────────────
//
// O painel roda com CSP fechada (`default-src 'none'`), e a previa de um item de midia so
// conseguia desenhar o rotulo: "[imagem] Formula" num balao de texto, igual pra foto, video e
// documento. O Bruno: "quando eu cliquei no video deveria aparecer o video, parece apenas uma
// mensagem".
//
// POR QUE NAO E SO AFROUXAR A CSP: a origem da API e configuravel (a dash do afiliado aponta pra
// outro worker), e CSP em <meta> nao interpola - ficaria uma origem chumbada que quebra no dia em
// que alguem trocar o apiBase. E `default-src 'none'` e trava de proposito: o painel nao fala com
// a rede, ponto.
//
// POR QUE NAO E DATA URL POR IPC: os videos do funil tem 37 MB. Em base64 viram ~49 MB atravessando
// o IPC a cada clique, e o painel congela. Medido em 16/10 no acervo real: imagem 581 KB, audio
// 469 KB, video 37 MB.
//
// Entao: um esquema proprio. `swmedia://arq/<chave>` e resolvido AQUI, no processo principal, que
// busca no mesmo endereco publico que o envio ja usa. A pagina continua sem poder falar com a rede;
// ela so pede ao app. E o Range passa junto, entao o video abre na hora e deixa arrastar a barra em
// vez de baixar os 37 MB antes do primeiro quadro.
protocol.registerSchemesAsPrivileged([{
  scheme: 'swmedia',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])
const path = require('node:path')
const fs = require('node:fs')

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 1) USER-AGENT: a primeira coisa do arquivo, e tem que ser antes de QUALQUER janela.
//
// Sem isto o WhatsApp Web devolve "O WhatsApp funciona no Google Chrome 100 ou posterior" e o QR
// nunca aparece. O Electron monta o UA padrao como "<NomeDoApp>/<versao> Chrome/<v> Electron/<v>"
// sempre que o nome do app for diferente de "Electron" (BuildApplicationUserAgent em
// shell/common/application_info.cc), entao TODO app empacotado com nome proprio nasce bloqueado.
// Medido por bisseccao: Chrome/99 bloqueia, Chrome/100 passa, e qualquer token estranho perto do
// "Chrome/" derruba. A saida e um UA de Chrome puro, montado da versao real do Chromium embarcado
// (assim ele envelhece sozinho junto com o Electron).
// Conferido: vale no documento, nos subrecursos E no handshake do wss://web.whatsapp.com/ws/chat.
const UA_LIMPO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/' + process.versions.chrome + ' Safari/537.36'
app.userAgentFallback = UA_LIMPO

// MODO DE TESTE: autoteste e modo foto.
//
// Os dois rodam o app DE VERDADE, e isso criou dois choques com o uso real no mesmo computador:
// a trava de instancia unica fazia o teste morrer calado quando o app do vendedor ja estava aberto
// (foi o que aconteceu comigo em 16/10), e a pasta de dados compartilhada punha o teste dentro da
// sessao pareada dele - mexendo no cache, na fila de captura e na configuracao de quem esta
// trabalhando. Teste nao pode encostar em producao, nem ser impedido por ela.
const EH_TESTE = process.env.SW_SMOKE === '1' || process.env.SW_FOTO === '1' || process.env.SW_JANELA === '1'
// OUTRO COMPUTADOR NA MESMA MAQUINA (19/10/2026, teste da sessao na nuvem): SW_DADOS=<pasta> roda uma
// segunda copia do app DE VERDADE, com outra pasta de dados - outra maquina pra trava de uso, outro
// disco de sessao. E o jeito de provar "pareei aqui, abre la" sem um segundo PC. Nao e modo de teste:
// faz tudo que o app faz, so nao briga com a copia instalada pela trava de instancia unica.
const DADOS_A_PARTE = /^sellwave-web-[a-z0-9-]{1,30}$/.test(String(process.env.SW_DADOS || '')) ? String(process.env.SW_DADOS) : ''

// UMA INSTANCIA SO (16/10/2026).
//
// Duas copias do app rodando compartilham a MESMA pasta de dados: a fila de captura, a
// configuracao e - o que morde primeiro - a trava de uso. Uma fecha o numero e manda soltar
// enquanto a outra renova o aluguel, e o numero fica "aberto por voce mesmo" por dois minutos. Foi
// o que o Bruno viu. Abrir duas vezes agora so traz a janela que ja existe pra frente.
if (!EH_TESTE && !DADOS_A_PARTE) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      try { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus() } } catch (_) { /* ok */ }
    })
  }
}

// PASTA DOS DADOS FIXA, e de proposito.
//
// `app.getPath('userData')` deriva do NOME do app. Trocar o nome no package.json - ou o empacotador
// resolver `productName` em vez de `name` - muda a pasta, e com ela somem TODAS as sessoes
// pareadas: o vendedor atualiza o app e cada numero volta pra tela do QR. Escrevendo o caminho aqui,
// renomear o produto deixa de ser perigoso e o app em dev usa exatamente a mesma pasta do instalado.
// Tem que vir antes de qualquer `session.fromPartition`, senao o disco ja foi escolhido.
// Em teste a pasta e OUTRA, de proposito: ela e apagavel e nao tem nada de ninguem dentro.
try { app.setPath('userData', path.join(app.getPath('appData'), EH_TESTE ? 'sellwave-web-teste' : (DADOS_A_PARTE || 'sellwave-web'))) } catch (_) { /* ok */ }

const WA_URL = 'https://web.whatsapp.com'
const WA_ORIGEM = 'https://web.whatsapp.com'
// GEOMETRIA DAS TRES COLUNAS (16/10/2026, pedido do Bruno: "cliquei sem querer numa setinha que
// esconde o painel e nao consegui abrir de volta; tive que ir nos Ajustes").
//
// O BURACO ERA ESTE: escondido, o painel devolvia a largura INTEIRA pro WhatsApp e nao sobrava um
// pixel pra desenhar o caminho de volta. A casca fica ATRAS da view do WhatsApp, entao botao
// flutuante dela tambem nao aparece. O unico jeito de voltar era os Ajustes, que e exatamente onde
// ele se perdeu. Esconder algo sem deixar como trazer de volta nao e esconder, e perder.
//
// Agora o painel escondido deixa uma FRESTA de 22px, que e onde mora a abinha de voltar, e a barra
// da esquerda ENCOLHE em vez de sumir - ele pediu que continuasse "uma coluna fininha mostrando o
// numero", porque sumir a lista inteira tira a unica forma de saber onde ele esta.
const LARGURA_BARRA = 268              // barra lateral da casca (lista de numeros)
const LARGURA_BARRA_MIN = 56           // encolhida: so o ponto de estado, os ultimos digitos e o contador
const LARGURA_PAINEL = 316             // painel de venda, na direita
const FRESTA_PAINEL = 22               // painel escondido: o tanto que sobra pra abinha de voltar
const ALTURA_TOPO = 0                  // a casca desenha o topo dentro da propria barra

// Permissoes que a pagina do WhatsApp realmente pede (capturadas no handler em 15/10):
// 'media' (com mediaTypes ['audio'], que e o microfone pra audio e ligacao) e 'persistent-storage'.
// 'notifications' entra porque o vendedor precisa ser avisado de mensagem nova.
// Tudo o mais e NEGADO: o padrao do Electron e liberar tudo, entao o risco aqui e sobrar
// permissao, nao faltar.
// `notifications` SAIU em 16/10/2026, pedido do Bruno: "toda hora essa notificacao aparece, eu
// acho que nao precisa disso". Ele pareou um numero com 8.082 mensagens de historico e o Windows
// passou a repetir "WhatsApp - 8.082 novas mensagens" sem parar. Num numero de TRABALHO isso nunca
// vai ser util: ele esta olhando a conversa, e o painel do lado ja avisa o que importa. Notificacao
// que aparece o tempo todo nao avisa nada, so ensina a ignorar o canto da tela.
const PERMISSOES_OK = new Set(['media', 'persistent-storage', 'clipboard-sanitized-write'])

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 2) Configuracao local (token da dash, proxies por numero, trava)

const ARQ_CONFIG = () => path.join(app.getPath('userData'), 'sellwave-web.json')
const ARQ_LOG = () => path.join(app.getPath('userData'), 'sellwave-web.log')

// LOG EM ARQUIVO. Sem isto, quando o app falha na maquina do vendedor nao sobra nada pra olhar:
// ele nao abre o console e nao sabe descrever o erro. O arquivo fica em %APPDATA%, e o botao
// "Abrir registro" na barra lateral abre a pasta.
// Corta em 2 MB pra nao crescer pra sempre no computador dele.
function anota(txt) {
  const linha = new Date().toISOString().slice(0, 19).replace('T', ' ') + '  ' + String(txt) + '\n'
  try {
    const f = ARQ_LOG()
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.old') } catch (_) { /* primeiro uso */ }
    fs.appendFileSync(f, linha, 'utf8')
  } catch (_) { /* log que quebra o app e pior que log nenhum */ }
}
// Tudo que ja ia pro console passa a ir junto pro arquivo.
for (const nivel of ['log', 'warn', 'error']) {
  const orig = console[nivel].bind(console)
  console[nivel] = (...a) => { orig(...a); anota((nivel === 'log' ? '' : nivel.toUpperCase() + ': ') + a.map(String).join(' ')) }
}

// AS DUAS REGRAS DE PROXY SAO CONSTANTES, nao configuracao (17/10/2026). Palavras do Bruno:
// "eu quero que todos os numeros, por padrao, exijam proxy e, sim, por padrao, todos eles tem que
// ter o IP do Brasil. NAO TEM COMO DESATIVAR ISSO AQUI. Ja quero deixar isso como regra."
//
// ELAS ERAM CAMPOS DO CONFIG e nao e so cosmetica tirar: o `exigirBrasil` nascia FALSE no disco, e
// so virava true quando a dash respondia a primeira listagem. A janela era estreita (abrir numero
// precisa do token e da lista, que vem na mesma resposta), mas um arquivo de configuracao com um
// default que diz o contrario da regra e exatamente o que alguem le daqui a tres meses e acha que
// pode mexer. Agora nao existe campo pra desligar: nem no disco, nem na rede, nem na tela.
// O servidor continua mandando os dois como true no /api/swweb/numeros; o app so nao os LE mais.
const TRAVA_PROXY = true     // sem proxy respondendo, o numero nao abre
const EXIGE_BRASIL = true    // proxy de fora num numero +55 e pior que proxy nenhum

const CONFIG_PADRAO = {
  token: '',
  apiBase: 'https://axion-api.axion-dash.workers.dev',
  proxies: {},             // { "<numkey>": { host, porta, usuario, senha } }
  numeros: [],             // cache da ultima lista vinda da dash
  maxAbertos: 6,           // teto de sessoes abertas ao mesmo tempo (ver hibernacao)
  painelLigado: true,      // o painel de venda aparece ao lado do WhatsApp?
  nome: '',                // nome de quem entrou, so pra barra lateral
  direcao: false,          // quem entrou e da direcao? quem decide e o servidor, nao o app
  sessoes: {},             // { "<numkey>": { ver, gen, em } } - de que versao da nuvem veio a sessao daqui
  lixo: [],                // [{ nome, em }] pastas de particao antigas, apagadas no boot seguinte
}

let config = { ...CONFIG_PADRAO }

function lerConfig() {
  try {
    const txt = fs.readFileSync(ARQ_CONFIG(), 'utf8')
    config = { ...CONFIG_PADRAO, ...JSON.parse(txt) }
    config.token = decifra(config.token)
    for (const p of Object.values(config.proxies || {})) { if (p) p.senha = decifra(p.senha) }
  } catch (_) {
    config = { ...CONFIG_PADRAO }
  }
  return config
}

// SEGREDO NAO VAI EM TEXTO PURO (16/10/2026, revisao adversarial).
//
// O token da dash e as senhas de proxy ficavam legiveis em %APPDATA%. Qualquer um com acesso ao
// perfil do Windows do vendedor, ou um ladrao de credencial comum, saia com uma sessao valida da
// dash e com o proxy pago da operacao. O safeStorage usa o DPAPI do proprio Windows, entao o
// arquivo so se abre naquele usuario, naquela maquina.
// Sem DPAPI disponivel, o segredo simplesmente NAO e gravado: pedir a senha de novo e melhor que
// deixar ela em texto puro.
const MARCA_CIFRA = 'enc:v1:'
function cifra(txt) {
  if (!txt) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return MARCA_CIFRA + safeStorage.encryptString(String(txt)).toString('base64')
  } catch (_) { return '' }
}
function decifra(txt) {
  const v = String(txt || '')
  if (!v.startsWith(MARCA_CIFRA)) return v   // config antiga, em texto puro: migra ao gravar
  try { return safeStorage.decryptString(Buffer.from(v.slice(MARCA_CIFRA.length), 'base64')) } catch (_) { return '' }
}

function gravarConfig() {
  try {
    const guardar = { ...config, token: cifra(config.token), proxies: {} }
    for (const [k, p] of Object.entries(config.proxies || {})) {
      guardar.proxies[k] = { ...p, senha: cifra(p && p.senha) }
    }
    fs.mkdirSync(path.dirname(ARQ_CONFIG()), { recursive: true })
    fs.writeFileSync(ARQ_CONFIG(), JSON.stringify(guardar, null, 2), 'utf8')
  } catch (e) {
    console.error('[config] nao gravou:', e && e.message)
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 3) Chave do numero.
//
// MESMA CONVENCAO DO WORKER (_waNumKey): DDD + 8 ultimos digitos. Isso importa porque a chave vira
// o nome da particao no disco, e particao e sessao: se a chave mudar, o numero pede QR de novo.
// Por isso ela e derivada do numero e NUNCA de um id gerado.
function numKey(numero) {
  let d = String(numero || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length >= 12 && d.slice(0, 2) === '55') d = d.slice(2)
  if (d.length < 10) return d
  return d.slice(0, 2) + d.slice(-8)
}

// A PARTICAO TEM GERACAO (19/10/2026, sessao na nuvem).
//
// Trazer a sessao que outra maquina salvou nao pode ser escrever POR CIMA da pasta de hoje: se o
// numero ja foi aberto nesta execucao do app, o Chromium segura aquela particao viva ate o app
// fechar (o Local Storage fica com o LevelDB aberto), e trocar os arquivos embaixo dele corrompe a
// sessao. Entao a versao baixada vai pra uma pasta NOVA (sw-<nk>-<geracao>) e a particao passa a
// ser ela; a velha fica pra ser apagada no proximo boot. Numero que nunca baixou nada continua na
// pasta de sempre (sem geracao), entao nenhuma sessao pareada antes disto muda de lugar.
function geracaoDe(nk) {
  const s = config.sessoes && config.sessoes[nk]
  return (s && /^[a-z0-9]{1,16}$/.test(String(s.gen || ''))) ? String(s.gen) : ''
}
const particaoDe = (nk) => 'persist:sw-' + nk + (geracaoDe(nk) ? '-' + geracaoDe(nk) : '')
// Onde o Electron poe a particao no disco: Partitions/<nome em minusculas> dentro da pasta de dados.
function pastaDaParticao(nk, gen) {
  return path.join(app.getPath('userData'), 'Partitions', ('sw-' + nk + (gen ? '-' + gen : '')).toLowerCase())
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 4) Proxy
//
// O QUE NAO FUNCIONA (medido, ver ANEXO-TECNICO A3):
//  - SOCKS5 com usuario e senha: o Chromium nao implementa autenticacao SOCKS. Morre em
//    ERR_NO_SUPPORTED_PROXIES.
//  - Credencial dentro do proxyRules: a regra e DESCARTADA em silencio e nada funciona.
//  - proxyBypassRules '<-loopback>': isso SUBTRAI o bypass de loopback, forcando 127.0.0.1 pelo
//    proxy. Nao ganha privacidade nenhuma e quebra coisa local.
// O QUE FUNCIONA: proxy HTTP com usuario e senha, regra unica sem "=", senha pelo evento
// app.on('login').
//
// O fail-closed sai de graca: SEM "direct://" na lista, proxy fora do ar devolve
// ERR_PROXY_CONNECTION_FAILED e o Chromium NAO sai pelo IP real.

// CREDENCIAL POR PARTICAO, nao por host:porta (16/10/2026, varredura final).
//
// Proxy de ISP (o caso do isp.decodo.com dele) distingue a sessao pelo USUARIO, com o mesmo host e
// a mesma porta pra todos. Chaveando por "host:porta", o segundo numero sobrescrevia a credencial
// do primeiro e os dois passavam a sair pelo MESMO IP - exatamente a correlacao que o proxy existe
// pra evitar, e em silencio.
// A chave agora e a particao, e o evento 'login' do Electron diz qual webContents pediu, o que
// permite achar de quem e a autenticacao.
const credenciais = new Map()   // particao -> { host, porta, usuario, senha }
const particaoDoWc = new Map()  // id do webContents -> particao

// ROTEIRO (respostas rapidas, funis, audios) e as credenciais de captura. Vem da dash uma vez e
// fica aqui: o painel de cada numero pede por IPC, entao N sessoes abertas = 1 busca, nao N.
let roteiro = null
let roteiroEm = 0
async function pegaRoteiro(forcar) {
  if (!forcar && roteiro && (Date.now() - roteiroEm) < 600000) return roteiro
  if (!config.token) return null
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/roteiro',
      { headers: { Authorization: 'Bearer ' + config.token } })
    if (!r.ok) return roteiro
    const d = await r.json()
    if (d && d.ok) { roteiro = d; roteiroEm = Date.now() }
  } catch (_) { /* fica com o que tinha: roteiro velho e melhor que painel vazio */ }
  return roteiro
}

function proxyDoNumero(nk) {
  const p = config.proxies && config.proxies[nk]
  if (!p || !p.host || !p.porta) return null
  return { host: String(p.host).trim(), porta: Number(p.porta), usuario: p.usuario || '', senha: p.senha || '' }
}

// O PROXY MANDA DA DASH, nao da maquina do vendedor.
// Proxy errado (ou de fora do Brasil) num numero +55 e pior que proxy nenhum, entao quem cadastra e
// a direcao, em Ferramentas > SellWave Web. A copia local existe so pra o app continuar abrindo se
// a dash estiver fora do ar na hora. A senha nao vem na listagem: so nesta chamada, por numero.
// Devolve { px, rede } - `rede` diz que NAO deu pra perguntar. Sem essa distincao, dash fora do ar
// virava a frase "Este numero nao tem proxy cadastrado. Cadastre na dash", mandando o vendedor
// cadastrar o que ja esta cadastrado, numa dash que ele nao alcanca.
async function puxaProxyDaDash(nk) {
  if (!config.token || !nk) return { px: null, rede: false }
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/proxy?nk=' + encodeURIComponent(nk)
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(15000) })
    ajustaRelogio(r)
    if (!r.ok) return { px: null, rede: true }
    const d = await r.json()
    const px = d && d.proxy
    config.proxies = config.proxies || {}
    if (px && px.host) config.proxies[nk] = px
    else delete config.proxies[nk]
    gravarConfig()
    // A LIBERACAO VEM JUNTO, e NAO fica gravada no disco de proposito: ela tem hora pra morrer, e
    // copia local de coisa que vence e o jeito de ela sobreviver a propria validade. Se a dash
    // estiver fora do ar, nao existe liberacao - e fechar e o lado certo de errar.
    const exc = d && d.excecao;
    return { px: px && px.host ? px : null, rede: false, excecao: (exc && Number(exc.ate) > Math.floor(agoraCerto() / 1000)) ? exc : null }
  } catch (_) {
    return { px: null, rede: true }   // dash fora do ar: segue com a copia local, se houver
  }
}

// O QUARTO ARGUMENTO EXISTE PORQUE "SEM PROXY" SAO DUAS COISAS DIFERENTES, e confundir as duas
// quebra calado. Sem ele, `px` nulo tinha um unico significado (buraco negro), e o numero liberado
// pela direcao abriria e NAO CONECTARIA EM NADA: a tela diria "abrindo sem proxy, liberado por
// Bruno" e o WhatsApp ficaria rodando pra sempre, que e pior que recusar.
//   px == null, direto FALSO  -> BURACO NEGRO. E o padrao, e o fail-closed: se alguma parte do
//                                codigo esquecer de travar, a requisicao FALHA em vez de vazar.
//   px == null, direto VERDADE -> SAI PELO IP DESTA MAQUINA, de propria vontade da direcao, e com
//                                a barra avisando enquanto durar.
// O argumento e explicito de proposito: quem le a chamada ve a intencao, em vez de ela estar
// escondida num nulo que significa duas coisas.
async function aplicaProxy(ses, px, particao, direto) {
  if (particao) {
    if (px && px.usuario) credenciais.set(particao, px)
    else credenciais.delete(particao)
  }
  if (!px) {
    if (direto) {
      await ses.setProxy({ mode: 'direct' })
      await ses.closeAllConnections()
      return
    }
    // Sem proxy: deixa a sessao num buraco negro em vez de "direct". Assim, se alguma parte do
    // codigo esquecer de travar, a requisicao FALHA em vez de vazar o IP real.
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
    await ses.closeAllConnections()
    return
  }
  // Regra UNICA e sem "=": vira PROXY_LIST e vale pra http, https, ws e wss. Com "scheme=" o que
  // ficou de fora sai DIRETO, que e o vazamento classico.
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://' + px.host + ':' + px.porta })
  // Sem isto o socket velho do pool continua saindo pelo IP anterior por minutos.
  await ses.closeAllConnections()
}

// Autenticacao do proxy. Vale pra navegacao de verdade (WebContents), que e o caminho que a gente
// usa. NAO vale pra net.fetch/ses.fetch: la o evento sai no proprio objeto, nao no app - foi por
// isso que o preflight abaixo e feito num WebContents escondido, e nao com ses.fetch.
app.on('login', (event, wc, _det, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return
  // De QUEM e esta autenticacao: acha a particao daquele webContents.
  const part = wc ? particaoDoWc.get(wc.id) : ''
  const c = part ? credenciais.get(part) : null
  if (!c || !c.usuario) return
  // So responde se for o MESMO proxy que a gente mandou aquela particao usar. Proxy diferente
  // pedindo senha significa que alguma coisa redirecionou o trafego: melhor nao autenticar.
  if (String(authInfo.host) !== String(c.host) || Number(authInfo.port) !== Number(c.porta)) return
  event.preventDefault()
  callback(c.usuario, c.senha)
})

// PREFLIGHT: confere, ANTES de carregar o WhatsApp, que a sessao realmente sai pelo proxy.
// Roda num WebContents escondido com a MESMA particao, porque e o unico jeito de a autenticacao
// do proxy funcionar. Devolve { ok, ip, pais, erro }.
// Views do preflight: sem guardar a referencia, o coletor de lixo destroi a view no meio do teste
// e o executeJavaScript morre com "Object has been destroyed" (medido).
const viewsDoTeste = new Set()

function testaSaida(particao) {
  return new Promise((resolve) => {
    const view = new WebContentsView({
      webPreferences: { partition: particao, sandbox: true, javascript: true, images: false },
    })
    viewsDoTeste.add(view)
    const wc = view.webContents
    particaoDoWc.set(wc.id, particao)
    let respondeu = false
    const acabou = (r) => {
      if (respondeu) return
      respondeu = true
      clearTimeout(relogio)
      try { if (!wc.isDestroyed()) wc.close() } catch (_) { /* ok */ }
      viewsDoTeste.delete(view)
      resolve(r)
    }
    const relogio = setTimeout(() => acabou({ ok: false, erro: 'O proxy nao respondeu em 20 segundos.' }), 20000)

    wc.once('did-fail-load', (_e, code, desc) => {
      acabou({ ok: false, erro: (desc || 'falhou') + ' (' + code + ')' })
    })
    wc.once('did-finish-load', async () => {
      try {
        const txt = await wc.executeJavaScript('document.body && document.body.innerText')
        const dados = JSON.parse(String(txt || '{}'))
        if (dados && dados.query) acabou({ ok: true, ip: dados.query, pais: dados.countryCode || '', cidade: dados.city || '', provedor: dados.isp || '' })
        else acabou({ ok: false, erro: 'Resposta inesperada do teste de IP.' })
      } catch (e) {
        acabou({ ok: false, erro: 'Nao deu pra ler o IP de saida: ' + (e && e.message) })
      }
    })
    wc.loadURL('http://ip-api.com/json/?fields=status,query,countryCode,city,isp')
  })
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 5) WebRTC: o UDP SAI DIRETO, de proposito, e isso e uma troca consciente.
//
// ATE 16/10/2026 AQUI ERA 'disable_non_proxied_udp', que e a unica politica que nao deixa o IP real
// aparecer. O preco dela foi MEDIDO numa ligacao de verdade do Bruno: 6 conexoes TCP, todas pelo
// proxy, ZERO UDP, e o WhatsApp dizendo "Sua rede Wi-Fi nao permite fazer ligacoes". Ou seja a
// chamada TOCA dos dois lados (a sinalizacao passa por TCP, pelo proxy) e o audio NUNCA monta.
//
// E nao ha jeito de ter os dois. O Chromium nao manda UDP por proxy nenhum - nem SOCKS5, que na
// documentacao dele so relaia TCP, e que aqui ainda esbarra em nao autenticar com senha (ANEXO A3).
// O AdsPower "funciona" porque NAO bloqueia UDP: ele troca o IP que a PAGINA enxerga e deixa o
// pacote sair direto. Tanto que tem um "Disabled UDP" separado, que faz o que a nossa trava fazia,
// com o mesmo efeito de derrubar a ligacao. A escolha e a mesma nos dois produtos.
//
// O BRUNO ESCOLHEU A LIGACAO, em 16/10/2026, depois de ouvir isso: "nao precisa de interruptor nem
// nada disso, pode deixar essa funcao como padrao".
//
// O QUE MUDA E O QUE NAO MUDA, e isso precisa estar certo aqui porque ele mesmo entendeu diferente
// ("vai ter que tirar ele da proxy"): NAO vai. Navegacao, mensagem, midia e a sinalizacao da
// chamada continuam saindo pelo proxy daquela particao, por TCP. SO os pacotes de audio passam a
// sair direto, e e so neles que o IP publico da maquina aparece.
//
// 'default_public_interface_only' e nao 'default': as duas deixam a ligacao funcionar, mas a
// `default` entrega junto a topologia da rede local (os IPs das interfaces internas). Perder o IP
// publico na ligacao e inevitavel pra ela existir; entregar o resto nao compra nada.
app.on('web-contents-created', (_e, wc) => {
  try {
    wc.setWebRTCIPHandlingPolicy('default_public_interface_only')
    const lido = wc.getWebRTCIPHandlingPolicy && wc.getWebRTCIPHandlingPolicy()
    if (lido && lido !== 'default_public_interface_only') {
      console.error('[webrtc] POLITICA NAO APLICOU, esta em "' + lido + '".')
    }
  } catch (e) {
    console.error('[webrtc] falhou:', e && e.message)
  }
  // LINK EXTERNO ABRE NO NAVEGADOR DO SISTEMA, E ISSO E UMA TROCA, NAO UM DESCUIDO (17/10/2026).
  //
  // O QUE SE GANHA: o site aberto fica FORA da particao do numero. Se ele navegasse ali dentro, a
  // view viraria um navegador comum ainda carregando a sessao do WhatsApp daquele chip - e uma
  // pagina hostil no mesmo compartimento e o caminho curto pra roubar a sessao. E o fingerprint
  // daquela particao, que existe pra parecer um aparelho so, passaria a ser visto por qualquer site
  // que o vendedor abrir.
  //
  // O QUE SE PERDE, e e justo registrar: o navegador do Windows NAO passa pelo proxy daquele
  // numero. Quem receber o clique ve o IP de casa do Bruno, nao o do chip. Num app cuja razao de
  // existir e nao correlacionar numeros, isso soa contraditorio - mas o modelo de ameaca aqui e a
  // META correlacionar chips, e um site de terceiro vendo o IP residencial nao ajuda nisso. O que
  // ajudaria seria o contrario: expor a sessao do chip.
  //
  // SE UM DIA ISSO INCOMODAR, o meio-termo existe e e o que as ferramentas de multi-conta fazem:
  // abrir numa janela com particao PROPRIA (nao a do numero) e o proxy DAQUELE chip. Da os dois
  // lados, e custa uma sessao por chip. Nao foi feito porque ninguem pediu e porque o risco medido
  // e baixo - nao porque a opcao nao exista.
  //
  // O QUE NAO SE MEXE: so http e https vao pro navegador. Esquema desconhecido entregue ao Windows
  // e abrir porta.
  wc.setWindowOpenHandler(({ url }) => {
    // So http e https vao pro navegador do sistema. Outros esquemas (ms-..., file:, javascript:)
    // sao recusados sem abrir nada: entregar esquema desconhecido pro Windows e abrir porta.
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url)
    return { action: 'deny' }
  })
  // O PAR DO DE CIMA. Sem isto, um link com target proprio navega a sessao PRA FORA do WhatsApp:
  // a view vira um navegador comum, ainda com o proxy e a sessao do numero. Link externo vai pro
  // navegador do sistema; a sessao so anda dentro do WhatsApp.
  // COMPARA ORIGEM, NAO PREFIXO. "https://web.whatsapp.com.evil.com/" comeca com o nosso endereco
  // e passaria num startsWith, levando junto o preload e a sessao autenticada daquele numero.
  wc.on('will-navigate', (ev, url) => {
    const u = String(url || '')
    let origem = ''
    try { origem = new URL(u).origin } catch (_) { origem = '' }
    if (origem === WA_ORIGEM) return
    // A casca e o painel sao file://, e cada um tem a propria view: a de numero nunca navega pra la.
    if (u.startsWith('file://') && wc.getURL().startsWith('file://')) return
    ev.preventDefault()
    if (/^https?:/i.test(u)) shell.openExternal(u)
  })
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 6) Janela e views

let janela = null
let casca = null
let painel = null   // a view do painel de venda da janela PRINCIPAL
const abertos = new Map()   // nk -> { view, nk, numero, carregado, ultimoUso }
let ativoAgora = ''         // qual numero esta na tela DA PRINCIPAL (a hibernacao nunca fecha este)

// ─── JANELAS DESTACADAS (17/10/2026, pedido do Bruno) ────────────────────────────────────────
//
// "No AdsPower, quando voce clica em abrir outra instancia, ele abre OUTRO navegador: na tela dele
// ficam dois navegadores funcionando ao mesmo tempo. No SellWave Web nao funciona assim: toda vez
// que eu clico em outra instancia, ele TROCA o meu navegador de um WhatsApp para outro."
//
// A VIEW SE MUDA DE JANELA, NAO SE DUPLICA. A mesma WebContentsView sai da janela principal e entra
// numa BaseWindow nova; o documento continua o mesmo, o WhatsApp nao recarrega e o funil que estiver
// no meio de um disparo nao sente nada. Duas views na MESMA particao seriam conflito de sessao no
// WhatsApp Web, que e o que o Set `abrindo` ja evita desde 16/10.
//
// SEM `parent: janela`: no Windows, janela filha fica SEMPRE na frente da mae e minimiza junto com
// ela. Isso mataria o pedido, que e justamente poder por um WhatsApp em cada monitor.
//
// SEM BARRA DE NUMEROS LA DENTRO: a lista e a torre de controle e e uma so, igual ao AdsPower (o
// launcher tem a lista; cada navegador aberto e so um navegador).
const destacados = new Map()   // nk -> { nk, win, painel }

// DE QUAL NUMERO E O PAINEL QUE PERGUNTOU. E a peca central do desenho e o unico lugar que decide:
// todo handler do painel passa por aqui em vez de ler `ativoAgora`.
//
// O BUG QUE ISTO IMPEDE: o painel pergunta "qual conversa esta aberta" tres vezes (no pulso de
// 1,5s, no clique do funil e no clique do lead). Com dois paineis lendo o mesmo global, o painel da
// janela destacada mostraria a conversa, o nome e o telefone do numero da janela PRINCIPAL - e o
// funil disparado la sairia pelo chip errado, pro lead errado, com a atribuicao da venda junto.
function nkDoPainel(wc) {
  for (const d of destacados.values()) {
    if (d.painel && !d.painel.webContents.isDestroyed() && d.painel.webContents === wc) return d.nk
  }
  return ativoAgora
}
// A JANELA DONA de um numero: a destacada dele, ou a principal.
const janelaDe = (nk) => { const d = destacados.get(nk); return d ? d.win : janela }

// TRES COLUNAS: barra de numeros | WhatsApp | painel de venda.
//
// O painel e uma VIEW PROPRIA, nao um pedaco injetado na pagina. Se fosse injetado, pra ele nao
// cobrir a conversa a gente teria que encolher o layout do WhatsApp por CSS - que depende do DOM
// deles e quebra quando eles mudam - e o CSS deles poderia quebrar o nosso. Separado, cada um cuida
// do seu espaco e nenhum estraga o outro.
// O painel pode ser escondido: em tela pequena ele e a barra comiam 584 px e sobrava pouco pro
// WhatsApp, que corta a tela de entrar da Meta.
let painelLigado = true
function temPainel() { return painelLigado && !!ativoAgora && abertos.has(ativoAgora) }

// A largura da barra AGORA, que depende de ela estar encolhida ou nao. A janela DESTACADA nao tem
// barra: la o WhatsApp comeca na borda.
const larguraBarra = (d) => (d ? 0 : (config.barraEncolhida ? LARGURA_BARRA_MIN : LARGURA_BARRA))

// `d` = o registro da janela destacada, ou nada pra janela principal. As tres funcoes abaixo eram
// de uma janela so: com duas, jogar a geometria da principal numa view que mora na outra fazia ela
// desenhar deslocada, com a largura da barra de vazio na esquerda.
function areaConteudo(d) {
  const win = d ? d.win : janela
  if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
  const b = win.getContentBounds()
  // Painel escondido NAO devolve a largura inteira: deixa a fresta da abinha de voltar.
  const reserva = (d ? painelLigado : temPainel()) ? LARGURA_PAINEL : FRESTA_PAINEL
  const esq = larguraBarra(d)
  const topo = d ? 0 : ALTURA_TOPO
  return { x: esq, y: topo, width: Math.max(0, b.width - esq - reserva), height: Math.max(0, b.height - topo) }
}

function areaPainel(d) {
  const win = d ? d.win : janela
  if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
  const b = win.getContentBounds()
  return { x: Math.max(0, b.width - LARGURA_PAINEL), y: 0, width: LARGURA_PAINEL, height: b.height }
}

function reposiciona(d) {
  // SEM ARGUMENTO, REPOSICIONA TUDO. Os chamadores de antes (o resize, o liga/desliga do painel, o
  // encolher da barra) nao precisam saber que existem duas janelas.
  if (d === undefined) {
    reposicionaPrincipal()
    for (const x of destacados.values()) reposiciona(x)
    return
  }
  if (!d) { reposicionaPrincipal(); return }
  if (!d.win || d.win.isDestroyed()) return
  const s = abertos.get(d.nk)
  if (s && !s.view.webContents.isDestroyed()) s.view.setBounds(areaConteudo(d))
  if (d.painel && !d.painel.webContents.isDestroyed()) {
    d.painel.setVisible(painelLigado)
    if (painelLigado) { d.painel.setBounds(areaPainel(d)); d.win.contentView.addChildView(d.painel) }
  }
}

function reposicionaPrincipal() {
  if (!janela || janela.isDestroyed()) return
  const b = janela.getContentBounds()
  if (casca) casca.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  const area = areaConteudo()
  // SO AS VIEWS DESTA JANELA. Jogar a geometria da principal na view destacada deixava ela cortada
  // e deslocada dentro da outra janela.
  for (const s of abertos.values()) { if (!destacados.has(s.nk)) s.view.setBounds(area) }
  if (painel) {
    const liga = temPainel()
    painel.setVisible(liga)
    if (liga) { painel.setBounds(areaPainel()); janela.contentView.addChildView(painel) }
  }
}

function avisaCasca(canal, dados) {
  try { casca && casca.webContents.send(canal, dados) } catch (_) { /* ok */ }
}

function preparaSessao(nk) {
  const ses = session.fromPartition(particaoDe(nk))
  // Permissao por particao, negando tudo que nao esta na lista e so pra origem do WhatsApp.
  ses.setPermissionRequestHandler((wc, permissao, callback, detalhes) => {
    const origem = (detalhes && detalhes.requestingUrl) || (wc && wc.getURL && wc.getURL()) || ''
    const daCasa = String(origem).startsWith(WA_ORIGEM)
    // MICROFONE SIM, CAMERA NAO. O vendedor manda audio e liga por voz; video nunca foi pedido, e
    // liberar camera numa tela que fica aberta o dia inteiro e risco sem contrapartida.
    const tipos = (detalhes && detalhes.mediaTypes) || []
    const soAudio = permissao !== 'media' || !tipos.includes('video')
    callback(!!daCasa && PERMISSOES_OK.has(permissao) && soAudio)
  })
  ses.setPermissionCheckHandler((_wc, permissao, origem) => {
    return String(origem || '').startsWith(WA_ORIGEM) && PERMISSOES_OK.has(permissao)
  })
  return ses
}

// Abre (ou traz pra frente) a sessao de um numero. Faz o preflight do proxy ANTES de carregar o
// WhatsApp: se a trava estiver ligada e o proxy nao responder, a pagina nao chega a ser pedida.
// Quem ja esta no meio da abertura. Sem isto, dois cliques no mesmo numero (coisa que vendedor
// leigo faz direto, ainda mais com a lista redesenhando embaixo do dedo) criam DUAS views na MESMA
// particao, e o WhatsApp Web entra em conflito de sessao.
const abrindo = new Set()
// Qual foi o ULTIMO numero que o vendedor pediu. Duas aberturas correm em paralelo e a mais lenta
// terminava por ultimo, roubando a tela de quem ele clicou depois.
let pedidoAtual = 0

async function abreNumero(numero, opcoes) {
  const nk = numKey(numero)
  if (!nk) return { ok: false, erro: 'Numero invalido.' }
  // `fundo` e a passada que sobe pra nuvem as sessoes pareadas antes da 1.25.0 (ver sobeAsAntigas):
  // abre escondido, sem roubar a tela. Clique de gente no mesmo numero tira ele do fundo, e ai a
  // passada nao fecha mais um numero que alguem esta usando.
  const fundo = !!(opcoes && opcoes.fundo)
  if (!fundo) emFundo.delete(nk)

  // CLICAR NUM NUMERO JA ABERTO CONTA COMO PEDIDO NOVO.
  //
  // `pedidoAtual` so subia no caminho lento. Entao: o vendedor clica no (15), que esta frio e leva
  // oito segundos; cansa de esperar e clica no (19), que ja estava aberto e aparece na hora. Como o
  // contador nao mudou, quando o (15) termina ele se acha o pedido vigente e sobe POR CIMA do (19).
  // O vendedor passa a conversar numa tela que nao e a que a barra marca.
  //
  // O `abrindo.has(nk)` NAO incrementa de proposito: ele e o mesmo numero clicado duas vezes, e
  // subir o contador ali faria a abertura em voo se achar velha e terminar escondida - o numero que
  // ele pediu nunca apareceria.
  if (abertos.has(nk)) {
    pedidoAtual++
    mostra(nk)
    return { ok: true, jaAberto: true }
  }
  if (abrindo.has(nk)) return { ok: true, jaAberto: true }
  // O FECHAMENTO DESTE NUMERO AINDA ESTA SALVANDO NA NUVEM: espera terminar. Abrir no meio leria a
  // versao de antes do fechamento e, pior, o fim do fechamento soltaria o aluguel do numero aberto.
  const saindo = despedidas.get(nk)
  if (saindo) {
    avisaCasca('sw:status', { nk, texto: 'Terminando de salvar este número na nuvem...' })
    try { await saindo } catch (_) { /* o fechamento ja registrou o que deu errado */ }
    if (abertos.has(nk) || abrindo.has(nk)) return { ok: true, jaAberto: true }
  }
  // A TRAVA VEM ANTES DE QUALQUER COISA PESADA: antes do proxy, antes de subir a sessao. Se o
  // numero esta com outra maquina, nem comeca.
  const uso = await pedeUso(nk)
  if (!uso.ok) {
    return uso.ocupado
      ? { ok: false, ocupado: uso.ocupado, erro: 'Este número está aberto por ' + (uso.ocupado.nome || 'outra pessoa') + '. Dois computadores no mesmo WhatsApp é o que mais derruba número.' }
      : { ok: false, erro: uso.erro || 'Não consegui reservar este número.' }
  }
  abrindo.add(nk)
  if (fundo) emFundo.add(nk)
  // O FUNDO NAO MEXE NO PEDIDO ATUAL: ele nao e pedido de ninguem, e subir o contador faria a
  // abertura que o vendedor clicou se achar velha e terminar escondida.
  const meu = fundo ? -1 : ++pedidoAtual
  // REDE DE SEGURANCA DO ALUGUEL (18/10/2026, auditoria da vespera da virada).
  //
  // O `desiste()` la dentro do abreDeVerdade cobre os quatro caminhos que RETORNAM erro, e cobre
  // bem. O que ele nao cobre e EXCECAO: entre o pedeUso aqui em cima e o `abertos.set` la embaixo
  // rodam preparaSessao, aplicaProxy, puxaProxyDaDash, pegaMotor, testaSaida e o
  // `new WebContentsView`, e qualquer um deles pode estourar. A excecao sobe, este `finally` so
  // tirava do `abrindo`, e o aluguel ficava em `alugados` sendo RENOVADO DE 45 EM 45 SEGUNDOS pelo
  // turno inteiro. Resultado: o numero fica trancado pra equipe toda, e a tela do dono do problema
  // diz "Aberto por <ele mesmo>". Nao vence sozinho porque a renovacao e um laco cego.
  // `soltaUso` e idempotente (tira do Set e manda soltar), e a guarda do `abertos` garante que isto
  // nunca derruba um numero que ABRIU de verdade.
  try {
    const r = await abreDeVerdade(nk, numero, meu)
    if ((!r || !r.ok) && !abertos.has(nk)) { try { soltaUso(nk) } catch (_) { /* vence em 2 min */ } }
    return r
  } catch (e) {
    if (!abertos.has(nk)) { try { soltaUso(nk) } catch (_) { /* vence em 2 min */ } }
    anota('abreNumero estourou em ' + nk + ': ' + ((e && e.stack) || e))
    return { ok: false, erro: 'Não consegui abrir este número agora. Tente de novo.' }
  } finally { abrindo.delete(nk) }
}

async function abreDeVerdade(nk, numero, meu) {
  // DEVOLVE O ALUGUEL E SAI. Toda saida de erro daqui passa por ela: o aluguel foi pedido antes do
  // preflight (ver `abreNumero`), e sem devolver, o numero fica trancado no nome de quem tentou
  // pra todo mundo MENOS pra ele - o `fechaNumero` nao serve aqui porque sai cedo quando o numero
  // nao esta em `abertos`, e abertura que falhou nunca entrou.
  const desiste = (resp) => { try { soltaUso(nk) } catch (_) { /* vence sozinho em 2 min */ } return resp }

  // A SESSAO DA NUVEM VEM ANTES DE TUDO (19/10/2026): ela pode trocar a particao (ver geracaoDe), e
  // o proxy, o preflight e a view abaixo tem que nascer ja na particao certa.
  const nuvem = await trazDaNuvem(nk)
  if (!nuvem.ok) return desiste({ ok: false, erro: nuvem.erro })

  avisaCasca('sw:status', { nk, texto: 'Buscando o proxy na dash...' })
  const busca = await puxaProxyDaDash(nk)
  const px = proxyDoNumero(nk)
  // SEM PROXY NAO ABRE, E NAO TEM INTERRUPTOR (17/10/2026, palavras do Bruno: "eu quero que todos
  // os numeros, por padrao, exijam proxy e, sim, por padrao, todos eles tem que ter o IP do Brasil.
  // NAO TEM COMO DESATIVAR ISSO AQUI. Ja quero deixar isso como regra").
  //
  // A frase do erro diz PRA ONDE IR, e nao so que recusou: a proxy se escolhe num seletor do banco,
  // na Contingencia, e e um clique. Antes a saida pra proxy caida era desligar a trava da operacao
  // inteira, e o custo disso nao era desligar, era RELIGAR - ninguem religa.
  if (!px && !busca.excecao) {
    if (busca.rede) return desiste({ ok: false, erro: 'Não deu pra falar com a dash pra pegar o proxy deste número. Tente de novo em um minuto.' })
    return desiste({ ok: false, erro: 'Este número não tem proxy. Escolha uma em Contingência > Proxies, na dash.' })
  }
  if (!px && busca.excecao) {
    // AVISA SEMPRE, E COM A HORA: numero aberto sem proxy e uma excecao, e excecao silenciosa vira
    // regra. A barra mostra isto enquanto ele estiver aberto, pro vendedor saber em que pe esta.
    const falta = Math.max(1, Math.round((Number(busca.excecao.ate) - agoraCerto() / 1000) / 60))
    avisaCasca('sw:status', { nk, texto: 'Abrindo SEM PROXY, liberado por ' + (busca.excecao.por || 'direção') + '. Volta a exigir em ' + falta + ' min.' })
  }

  const ses = preparaSessao(nk)
  // `!!busca.excecao` e a unica coisa que autoriza sair pelo IP da maquina. Sem proxy e sem
  // liberacao a funcao ja voltou la em cima, entao aqui o nulo com liberacao e intencional.
  await aplicaProxy(ses, px, particaoDe(nk), !!busca.excecao)

  // O PREFLIGHT SO RODA SE HOUVER PROXY. Com numero liberado, `px` e null e nao ha o que conferir:
  // a sessao sai pelo IP da maquina de propria vontade da direcao, e quem avisa isso e a linha de
  // cima. Testar o buraco negro aqui daria "o proxy nao respondeu" e fecharia a liberacao.
  if (TRAVA_PROXY && px) {
    avisaCasca('sw:status', { nk, texto: 'Conferindo o proxy...' })
    const teste = await testaSaida(particaoDe(nk))
    if (!teste.ok) {
      // Fail-closed: deixa a sessao no buraco negro, pra nada escapar depois.
      await aplicaProxy(ses, null, particaoDe(nk))
      return desiste({ ok: false, erro: 'O proxy não respondeu: ' + teste.erro })
    }
    // FECHA quando NAO SABE o pais, nao so quando sabe que e outro. Antes, resposta sem countryCode
    // passava - e o teste e http em texto claro, entao o proprio dono do proxy podia forjar.
    if (EXIGE_BRASIL && teste.pais !== 'BR') {
      await aplicaProxy(ses, null, particaoDe(nk))
      // A FRASE NAO FALA MAIS DE "EXIGENCIA LIGADA": nao ha o que desligar, e mandar a pessoa
      // procurar um interruptor que nao existe e o pior tipo de mensagem de erro.
      return desiste({ ok: false, erro: teste.pais
        ? 'Este proxy sai por ' + teste.pais + ', e o número só abre com IP do Brasil. Escolha outro em Contingência > Proxies.'
        : 'Não deu pra confirmar que o IP é do Brasil. Teste este proxy em Contingência > Proxies.' })
    }
    avisaCasca('sw:saida', { nk, ip: teste.ip, pais: teste.pais, cidade: teste.cidade, provedor: teste.provedor })
    // Sem await: abrir o numero nao espera a dash. Se nao chegar, a proxima abertura conta.
    contaPais(nk, teste.pais)
  }

  // Baixa o motor ANTES de criar a view: o preload pede ele de forma sincrona no inicio do
  // documento, e se nao estiver em maos ali, a injecao cai pro caminho tardio.
  await pegaMotor()

  const view = new WebContentsView({
    webPreferences: {
      partition: particaoDe(nk),
      preload: path.join(__dirname, 'preload-wa.js'),
      // SANDBOX LIGADO: esta view roda a pagina da Meta e um motor de 500 KB baixado da rede. O
      // preload so usa contextBridge, ipcRenderer e webFrame, que funcionam com sandbox, entao
      // desligar nao compraria nada e tiraria a caixa de areia do sistema operacional.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  })
  // TETO DE OUVINTES EXPLICITO. O padrao do Node e 10 e o Electron registra os dele (loadURL
  // sozinho poe tres por navegacao), entao uma pagina que recarrega sozinha - o WhatsApp faz isso -
  // enche o console de MaxListenersExceededWarning sem que haja vazamento no nosso codigo. O aviso
  // em si nao e o problema; o problema e ele ESCONDER um vazamento de verdade no meio do barulho.
  // 40 e folga pra recarga normal e ainda grita se algo passar disso.
  try { view.webContents.setMaxListeners(40) } catch (_) { /* ok */ }
  const s = { view, nk, numero, carregado: false, ultimoUso: Date.now() }
  abertos.set(nk, s)
  particaoDoWc.set(view.webContents.id, particaoDe(nk))

  view.webContents.on('did-finish-load', () => {
    s.carregado = true
    avisaCasca('sw:aberto', { nk })
    injetaPainel(s)
  })
  // O RENDERER MORREU: ate hoje isso dava TELA BRANCA e mais nada.
  //
  // O Bruno ficou cinco minutos olhando uma tela branca que nao sincronizava: a pasta da particao
  // nao crescia um byte e o processo nao gastava CPU. Parado, nao carregando. O Electron avisa isso
  // por `render-process-gone` e ninguem estava escutando, entao o app nao tinha como contar - e
  // "esta sincronizando, espera" e exatamente a leitura errada que custa meia hora de alguem.
  view.webContents.on('render-process-gone', (_e, d) => {
    const motivo = (d && d.reason) || 'desconhecido'
    anota('[numero] ' + nk + ' o WhatsApp caiu: ' + motivo + (d && d.exitCode != null ? ' (codigo ' + d.exitCode + ')' : ''))
    avisaCasca('sw:erro', {
      nk,
      erro: motivo === 'oom'
        ? 'O WhatsApp deste número ficou sem memória. Feche algum outro número e abra este de novo.'
        : 'A tela deste número caiu (' + motivo + '). Clique em Tentar de novo.',
    })
  })
  // Pagina que trava de vez em quando tambem conta, e o Electron sabe antes de voce.
  view.webContents.on('unresponsive', () => {
    anota('[numero] ' + nk + ' parou de responder')
    avisaCasca('sw:status', { nk, texto: 'Esta tela parou de responder. Se não voltar, feche e abra o número.' })
  })
  view.webContents.on('responsive', () => { anota('[numero] ' + nk + ' voltou a responder') })

  view.webContents.on('did-fail-load', (_e, code, desc, url, ehPrincipal) => {
    if (code === -3) return                       // navegacao abortada, normal
    // SO O QUADRO PRINCIPAL. Um subframe do proprio WhatsApp falhando nao e o numero caindo, e
    // avisar a casca fazia a tela do numero que o vendedor estava usando sumir.
    if (ehPrincipal === false) return
    if (url && !String(url).startsWith(WA_URL)) return
    avisaCasca('sw:erro', { nk, erro: desc + ' (' + code + ')' })
  })

  janela.contentView.addChildView(view)
  view.setBounds(areaConteudo())
  // CARREGAMENTO QUE NAO TERMINA (16/10/2026). O Bruno ficou minutos numa tela branca e o 1.4.0
  // nao disse nada - porque o processo NAO morreu e NAO estava travado: ele estava vivo, a rede
  // viva, e o WhatsApp Web simplesmente nunca terminava de carregar. Esse caso nao dispara
  // `render-process-gone` nem `unresponsive`, entao precisa de relogio proprio.
  //
  // 45 segundos: o WhatsApp Web numa conta grande leva uns 15 a 20 pela rede do vendedor, com
  // proxy no meio. O dobro disso nao e lentidao, e emperro.
  const relogioCarga = setTimeout(() => {
    if (s.carregado) return
    anota('[numero] ' + nk + ' nao terminou de carregar em 45s')
    avisaCasca('sw:status', {
      nk,
      texto: 'O WhatsApp deste número não terminou de carregar. Feche e abra de novo; se repetir, avise a direção.',
    })
  }, 45000)
  view.webContents.once('did-finish-load', () => clearTimeout(relogioCarga))
  view.webContents.once('destroyed', () => clearTimeout(relogioCarga))

  view.webContents.loadURL(WA_URL)
  // SO VAI PRA TELA SE AINDA FOR O QUE ELE QUER.
  //
  // E PRECISA ESCONDER DE VERDADE: WebContentsView nasce VISIVEL. So deixar de chamar mostra()
  // nao bastava - a view do numero lento entrava por cima do numero que o vendedor escolheu
  // depois, e ele ficava conversando numa tela que nao era a que a barra mostrava marcada.
  const aindaQuero = !meu || meu === pedidoAtual
  if (aindaQuero) mostra(nk)
  else {
    view.setVisible(false)
    if (ativoAgora) mostra(ativoAgora)     // reempilha o que ele escolheu
    avisaCasca('sw:aberto', { nk })
  }
  return { ok: true, naTela: aindaQuero }
}

function mostra(nk) {
  // NUMERO FECHADO NAO VIRA ATIVO. Sem esta guarda, mostra() de um nk que nao esta em `abertos`
  // escondia TODAS as views e ainda gravava ativoAgora com um numero que nao existe: a tela ficava
  // preta, o painel passava a falar de um numero fechado e o Fechar do painel nao achava nada.
  if (!abertos.has(nk)) { avisaCasca('sw:ativo', { nk: ativoAgora }); return }
  // NUMERO DESTACADO NAO VEM PRA CA: ele mora na janela dele. Trazer a view de volta aqui a
  // arrancaria de dentro da outra janela, que ficaria em branco - o vendedor teria duas janelas e
  // um WhatsApp so. Clicar nele FOCA a janela dele, que e o que ele quer dizer com o clique.
  const d = destacados.get(nk)
  if (d) {
    if (d.win && !d.win.isDestroyed()) { d.win.show(); d.win.focus() }
    const s = abertos.get(nk)
    if (s) s.ultimoUso = Date.now()
    avisaCasca('sw:ativo', { nk: ativoAgora })
    return
  }
  const area = areaConteudo()
  for (const [chave, s] of abertos) {
    if (destacados.has(chave)) continue      // mora noutra janela: nao e irmao desta
    if (chave === nk) {
      s.ultimoUso = Date.now()
      s.view.setVisible(true)
      s.view.setBounds(area)
      janela.contentView.addChildView(s.view)   // re-adicionar traz pra frente
    } else {
      s.view.setVisible(false)
    }
  }
  ativoAgora = nk
  avisaCasca('sw:ativo', { nk })
  reposiciona()
  hibernaSePrecisar()
}

function escondeTodos() {
  for (const s of abertos.values()) { if (!destacados.has(s.nk)) s.view.setVisible(false) }
  ativoAgora = ''
  avisaCasca('sw:ativo', { nk: '' })
  reposiciona()
}

// HIBERNACAO. O Chromium NUNCA compartilha processo entre particoes diferentes, entao cada numero
// aberto e um navegador inteiro: foi medido ~430 MB so na tela de QR, e 600 MB a 2 GB logado com
// conversa. Sem teto, o vendedor abre oito numeros e a maquina dele morre.
//
// Quando passa do teto, fecha o que esta parado ha mais tempo (e nunca o que esta na tela). A
// sessao fica no disco, entao reabrir e so recarregar: NAO pede QR de novo.
//
// O PRECO, e e honesto dizer: numero hibernado para de capturar mensagem enquanto estiver fechado.
// Por isso o teto e configuravel e o padrao e 6, nao 2.
// QUEM PODE SER HIBERNADO, do mais parado pro menos. Funcao propria pra o teste de ponta a ponta
// exercitar ESTA regra, e nao uma copia dela: o filtro que protege o numero destacado e invisivel
// quando esta certo e silencioso quando some - sem ele o app fecha o WhatsApp que o vendedor esta
// olhando na outra janela.
function candidatosHibernacao() {
  // NA TELA DE QUALQUER JANELA, e com disparo vivo em QUALQUER numero.
  const naTela = new Set([ativoAgora, ...destacados.keys()].filter(Boolean))
  return [...abertos.values()]
    .filter((s) => !naTela.has(s.nk) && !disparos.has(s.nk))
    .sort((a, b) => (a.ultimoUso || 0) - (b.ultimoUso || 0))
    .map((s) => s.nk)
}

function hibernaSePrecisar() {
  // O PISO SOBE COM AS JANELAS: com duas janelas abertas e teto 1, a hibernacao fecharia sem parar
  // o que o vendedor acabou de abrir.
  const teto = Math.max(1 + destacados.size, Number(config.maxAbertos) || 6)
  if (abertos.size <= teto) return
  // O NUMERO QUE ESTA DISPARANDO TAMBEM NAO PODE SER FECHADO.
  //
  // Ele acabou de sair da tela (o vendedor trocou pra atender outro lead), logo e justamente o de
  // ultimoUso mais velho: a hibernacao fechava ele no meio do funil e o painel dizia "o numero foi
  // fechado, o funil parou aqui". Metade do funil ia pro lead e a outra metade nao, por causa de
  // uma decisao de memoria.
  const candidatos = candidatosHibernacao().map((nk) => abertos.get(nk)).filter(Boolean)
  while (abertos.size > teto && candidatos.length) {
    const s = candidatos.shift()
    console.log('[memoria] hibernando ' + s.nk + ' (teto de ' + teto + ' sessoes abertas)')
    fechaNumero(s.nk)
    avisaCasca('sw:hibernou', { nk: s.nk })
  }
}

// GRAVA A SESSAO NO DISCO AGORA, sem esperar o Chromium achar que e hora.
//
// O pareamento do WhatsApp Web mora em IndexedDB, e o Chromium grava quando quer: num fechamento
// a forca (gerenciador de tarefas, queda de luz, travamento) o que estava so na memoria SOME, e o
// numero volta pedindo QR. O Bruno pediu em letra maiuscula que sessao ficasse salva, entao nao da
// pra confiar no momento escolhido pelo navegador: a gente manda gravar ao fechar, ao hibernar e
// ao sair. E barato e so acontece nessas tres horas.
function salvaSessao(particao) {
  try {
    const ses = session.fromPartition(particao)
    ses.flushStorageData()
    if (ses.cookies && ses.cookies.flushStore) ses.cookies.flushStore().catch(() => {})
  } catch (_) { /* ok */ }
}

function fechaNumero(nk) {
  const s = abertos.get(nk)
  if (!s) return
  // SE ELE ESTAVA DESTACADO, a janela dele vai junto: janela com o WhatsApp fechado seria uma
  // janela preta sem saida. O `devolve` tira a view de la antes de ela ser destruida.
  if (destacados.has(nk)) {
    const d = destacados.get(nk)
    devolve(nk)
    try { if (d.win && !d.win.isDestroyed()) d.win.destroy() } catch (_) { /* ok */ }
  }
  // SAI DA TELA NA HORA, e o resto (conferir se esta conectado, gravar, mandar pra nuvem, soltar o
  // aluguel) segue na `despedida`. Quem chama isto (hibernacao, Fechar, sair) conta com o numero
  // fora de `abertos` quando a funcao volta.
  try { janela.contentView.removeChildView(s.view) } catch (_) { /* ok */ }
  abertos.delete(nk)
  emFundo.delete(nk)
  if (ativoAgora === nk) ativoAgora = ''
  avisaCasca('sw:fechado', { nk })
  reposiciona()
  const p = despedida(nk, s)
    .catch((e) => anota('[nuvem] fechamento de ' + nk + ' estourou: ' + ((e && e.stack) || e)))
    .finally(() => { if (despedidas.get(nk) === p) despedidas.delete(nk) })
  despedidas.set(nk, p)
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// A SESSAO DO NUMERO NA NUVEM (19/10/2026, pedido do Bruno).
//
// Ate aqui a sessao do WhatsApp morava SO no disco de quem pareou. O Bruno pareia os numeros do
// time no PC dele, com os celulares principais no LDPlayer de la, e o vendedor trabalha no PC do
// vendedor: la o numero pedia QR de novo, e o celular que le o QR estava na casa do Bruno. Palavras
// dele: "toda vez que eu fechar o WhatsApp, ele salve todos os cookies, todas as informacoes, para
// que quando o meu vendedor abrir na maquina dele e clicar nesse mesmo telefone, ele consiga abrir o
// WhatsApp e comecar a vender".
//
// O QUE VAI: as pastas IndexedDB e Local Storage da particao, que e onde o WhatsApp Web guarda o
// pareamento (as chaves do aparelho vinculado). E o mesmo recorte que o RemoteAuth do
// whatsapp-web.js usa pra levar sessao de um servidor pro outro. Cookie NAO vai: no Windows ele e
// cifrado com uma chave do DPAPI daquela maquina, nao abriria em outra, e o WhatsApp Web nao
// depende dele pra continuar conectado. Cache, Service Worker e GPU ficam: sao refeitos sozinhos.
//
// COMO VAI: cada arquivo cifrado com AES-256-GCM (chave do numero, guardada no servidor) e mandado
// pelo hash do conteudo. O LevelDB nao reescreve um .ldb depois de pronto, entao fechar de novo so
// manda o que mudou - em geral o .log e o MANIFEST, uns poucos MB.
//
// QUANDO VAI: ao fechar o numero (Fechar, hibernacao, sair, fechar o app), e SO se ele estava
// conectado. Mandar a tela do QR por cima de uma sessao boa apagaria o pareamento pra todo mundo.
// O aluguel do numero fica preso ate o envio terminar: assim ninguem abre no outro computador a
// versao de antes do fechamento.
//
// QUANDO VOLTA: ao abrir, se a nuvem tem versao mais nova que a daqui, baixa ANTES de carregar o
// WhatsApp (ver trazDaNuvem e geracaoDe).
const crypto = require('node:crypto')
const PASTAS_DA_SESSAO = ['IndexedDB', 'Local Storage']
// LOCK e trava do proprio LevelDB (o Chromium segura ele aberto); LOG e diario de texto.
const FORA_DA_SESSAO = new Set(['LOCK', 'LOG', 'LOG.old'])
const PEDACO = 32 * 1024 * 1024
const despedidas = new Map()     // nk -> fechamento em curso (conferir, gravar, mandar, soltar)
const emFundo = new Set()        // numeros abertos escondidos pela passada de sobeAsAntigas
const nuvemEstado = new Map()    // nk -> { st: enviando|baixando|salvo|erro, txt, ts }
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const baseApi = () => String(config.apiBase).replace(/\/+$/, '')
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' MB'
const hashDe = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const pedacosDe = (n) => Math.max(1, Math.ceil((n + 28) / PEDACO))   // 28 = iv (12) + etiqueta (16)

function marcaNuvem(nk, st, txt) {
  nuvemEstado.set(nk, { st, txt: String(txt || ''), ts: Date.now() })
  avisaCasca('sw:nuvem', { nk, st, txt: String(txt || '') })
}

// Os arquivos da sessao, com o caminho relativo em barra normal (e o que vai no manifesto).
function arquivosDaSessao(dir) {
  const out = []
  const anda = (rel) => {
    let itens
    try { itens = fs.readdirSync(path.join(dir, ...rel.split('/')), { withFileTypes: true }) } catch (_) { return }
    for (const it of itens) {
      const r = rel + '/' + it.name
      if (it.isDirectory()) anda(r)
      else if (it.isFile() && !FORA_DA_SESSAO.has(it.name)) out.push({ rel: r, abs: path.join(dir, ...r.split('/')) })
    }
  }
  for (const raiz of PASTAS_DA_SESSAO) anda(raiz)
  return out
}
// TEM SESSAO DO WHATSAPP NESTA PASTA? A base de dados do WhatsApp Web e o que diz.
function temSessaoNoDisco(dir) {
  try { return fs.existsSync(path.join(dir, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb', 'CURRENT')) } catch (_) { return false }
}
// O CAMINHO QUE VEM DO SERVIDOR VIRA ARQUIVO NO DISCO DO VENDEDOR: so dentro da particao nova, so nas
// duas pastas da sessao. O worker ja confere, e aqui confere de novo, porque e daqui que o arquivo
// sai escrito.
function caminhoSeguro(dir, rel) {
  const r = String(rel || '')
  if (!/^(IndexedDB|Local Storage|SellWave)\/[A-Za-z0-9 ._\-/]{1,300}$/.test(r)) return ''
  if (r.split('/').some((x) => x === '' || x === '.' || x === '..')) return ''
  const abs = path.resolve(dir, ...r.split('/'))
  return abs.startsWith(path.resolve(dir) + path.sep) ? abs : ''
}

function cifraArquivo(chave, buf) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv)
  const corpo = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([iv, corpo, c.getAuthTag()])
}
function decifraArquivo(chave, enc) {
  if (enc.length < 28) throw new Error('pedaço curto demais')
  const d = crypto.createDecipheriv('aes-256-gcm', chave, enc.subarray(0, 12))
  d.setAuthTag(enc.subarray(enc.length - 16))
  return Buffer.concat([d.update(enc.subarray(12, enc.length - 16)), d.final()])
}

// OS COOKIES VAO JUNTO (19/10/2026, pedido do Bruno com o print do AdsPower, que exporta o JSON de
// cookies de cada perfil: wa_csrf, wa_lang_pref, wa_ul...).
//
// O arquivo de cookies do disco NAO serve: no Windows o valor e cifrado com uma chave do DPAPI daquela
// maquina e nao abre em outra. O Electron entrega os cookies ja abertos pelo `session.cookies.get`,
// entao eles viajam como um JSON (cifrado como o resto, em SellWave/cookies.json) e voltam pelo
// `cookies.set` na particao nova, antes de o WhatsApp carregar. Medido no teste de ponta a ponta: o
// numero abre conectado mesmo SEM eles; vao pra outra maquina ficar igual a esta.
const ARQ_COOKIES = 'SellWave/cookies.json'
async function cookiesDaParticao(particao) {
  try {
    const lista = await session.fromPartition(particao).cookies.get({})
    return lista.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'unspecified',
      ...(c.session || !c.expirationDate ? {} : { expirationDate: c.expirationDate }),
    }))
  } catch (e) { anota('[nuvem] nao li os cookies: ' + ((e && e.message) || e)); return [] }
}
async function poeCookies(particao, lista) {
  const ses = session.fromPartition(particao)
  const agora = Date.now() / 1000
  let postos = 0
  for (const c of (Array.isArray(lista) ? lista : [])) {
    if (!c || !c.name || !c.domain || (c.expirationDate && c.expirationDate < agora)) continue
    const host = String(c.domain).replace(/^\./, '')
    try {
      await ses.cookies.set({
        url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'),
        name: c.name, value: String(c.value || ''), path: c.path || '/',
        ...(c.hostOnly ? {} : { domain: c.domain }),
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        ...(c.sameSite && c.sameSite !== 'unspecified' ? { sameSite: c.sameSite } : {}),
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
      })
      postos++
    } catch (_) { /* um cookie recusado nao impede os outros */ }
  }
  try { await ses.cookies.flushStore() } catch (_) { /* ok */ }
  return postos
}

// N de cada vez, e o primeiro erro para os outros (o que ja estava no ar termina, mas nada novo sai).
async function emParalelo(itens, n, fn) {
  let i = 0
  let falha = null
  const corre = async () => {
    while (!falha && i < itens.length) {
      const k = i++
      try { await fn(itens[k], k) } catch (e) { falha = falha || e }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, corre))
  if (falha) throw falha
}

async function sessaoMeta(nk) {
  const r = await fetch(baseApi() + '/api/swweb/sessao?nk=' + encodeURIComponent(nk), { headers: cabecalhos(), signal: AbortSignal.timeout(20000) })
  ajustaRelogio(r)
  const d = await r.json().catch(() => null)
  if (!r.ok || !d || !d.ok) {
    const e = new Error((d && (d.error || d.erro)) || ('a dash respondeu ' + r.status))
    e.status = r.status
    throw e
  }
  return d
}

// UM PEDACO, com tres tentativas. Erro 4xx nao repete: e recusa, nao rede.
async function pedaco(metodo, nk, h, i, corpo) {
  const url = baseApi() + '/api/swweb/sessao/obj?nk=' + encodeURIComponent(nk) + '&h=' + h + '&i=' + i
  let ultimo = null
  for (let t = 0; t < 3; t++) {
    if (t) await espera(800 * t)
    let r
    try {
      r = await fetch(url, {
        method: metodo,
        headers: { Authorization: 'Bearer ' + config.token, 'x-sw-maquina': maquinaId(), ...(corpo ? { 'content-type': 'application/octet-stream' } : {}) },
        body: corpo || undefined,
        signal: AbortSignal.timeout(180000),
      })
      if (r.ok) return metodo === 'GET' ? Buffer.from(await r.arrayBuffer()) : true
    } catch (e) { ultimo = e; continue }   // rede: tenta de novo
    const d = await r.json().catch(() => null)
    ultimo = new Error((d && (d.error || d.erro)) || ('a dash respondeu ' + r.status))
    if (r.status < 500 && r.status !== 429) throw ultimo
  }
  throw ultimo || new Error('sem resposta da dash')
}

// MANDA A SESSAO DAQUI PRA NUVEM. Precisa estar com o aluguel do numero (o servidor confere).
async function enviaSessao(nk) {
  const dir = pastaDaParticao(nk, geracaoDe(nk))
  if (!temSessaoNoDisco(dir)) return { ok: false, pulou: 'sem sessão no disco' }
  const meta = await sessaoMeta(nk)
  const local = (config.sessoes && config.sessoes[nk]) || {}
  const base = Number(local.ver) || 0
  // A NUVEM ESTA NA FRENTE DESTA COPIA: alguem salvou depois da versao que esta aqui. Mandar daqui
  // seria voltar o numero no tempo; o servidor recusaria de qualquer jeito.
  if (Number(meta.ver) !== base) return { ok: false, conflito: true, ver: Number(meta.ver) || 0 }
  const chave = Buffer.from(String(meta.chave || ''), 'base64')
  if (chave.length !== 32) throw new Error('a chave da sessão veio errada')
  const laNaNuvem = new Set((Array.isArray(meta.manifesto) ? meta.manifesto : []).map((e) => e && (e.h + ':' + e.k)))
  const manifesto = []
  const subir = new Map()
  const itens = arquivosDaSessao(dir)
  // Os cookies entram como um arquivo a mais, que so existe na memoria (ver cookiesDaParticao).
  const ck = await cookiesDaParticao(particaoDe(nk))
  if (ck.length) itens.push({ rel: ARQ_COOKIES, buf: Buffer.from(JSON.stringify(ck)) })
  for (const a of itens) {
    let buf = a.buf
    if (!buf) { try { buf = fs.readFileSync(a.abs) } catch (e) { if (e && e.code === 'ENOENT') continue; throw e } }
    const h = hashDe(buf)
    const k = pedacosDe(buf.length)
    manifesto.push({ p: a.rel, h, n: buf.length, k })
    if (!laNaNuvem.has(h + ':' + k) && !subir.has(h)) subir.set(h, { abs: a.abs, buf: a.buf, h, n: buf.length, k })
  }
  if (!manifesto.length) return { ok: false, pulou: 'sem arquivos' }
  const total = [...subir.values()].reduce((t, x) => t + x.n, 0)
  let feito = 0
  marcaNuvem(nk, 'enviando', 'Salvando na nuvem' + (total ? ' (' + mb(total) + ')' : '') + '...')
  await emParalelo([...subir.values()], 3, async (x) => {
    const buf = x.buf || fs.readFileSync(x.abs)
    // O ARQUIVO MUDOU ENTRE A LEITURA E O ENVIO: alguma coisa ainda esta escrevendo na sessao, e uma
    // copia feita assim pode nao abrir. Melhor nao mandar esta vez do que mandar quebrada.
    if (hashDe(buf) !== x.h) throw new Error('a sessão mudou no meio do envio')
    const enc = cifraArquivo(chave, buf)
    for (let i = 0; i < x.k; i++) await pedaco('PUT', nk, x.h, i, enc.subarray(i * PEDACO, (i + 1) * PEDACO))
    feito += x.n
    if (total > 4 * 1048576) marcaNuvem(nk, 'enviando', 'Salvando na nuvem ' + mb(feito) + ' de ' + mb(total))
  })
  const r = await fetch(baseApi() + '/api/swweb/sessao/fim', {
    method: 'POST', headers: cabecalhos(), body: JSON.stringify({ nk, base, manifesto }), signal: AbortSignal.timeout(60000),
  })
  ajustaRelogio(r)
  const d = await r.json().catch(() => null)
  if (d && d.conflito) return { ok: false, conflito: true, ver: Number(d.ver) || 0 }
  if (!r.ok || !d || !d.ok) throw new Error((d && (d.error || d.erro)) || ('a dash respondeu ' + r.status))
  config.sessoes = config.sessoes || {}
  config.sessoes[nk] = { ...local, ver: Number(d.ver) || base + 1, gen: geracaoDe(nk), em: Date.now() }
  gravarConfig()
  return { ok: true, ver: Number(d.ver) || base + 1, bytes: manifesto.reduce((t, e) => t + e.n, 0), mandou: total }
}

// BAIXA A VERSAO DA NUVEM PRA UMA PASTA NOVA e vira a particao do numero pra ela.
async function baixaSessao(nk, meta) {
  const chave = Buffer.from(String(meta.chave || ''), 'base64')
  if (chave.length !== 32) throw new Error('a chave da sessão veio errada')
  const lista = Array.isArray(meta.manifesto) ? meta.manifesto : []
  const genVelha = geracaoDe(nk)
  const dirVelho = pastaDaParticao(nk, genVelha)
  let genNova = Date.now().toString(36)
  while (fs.existsSync(pastaDaParticao(nk, genNova))) genNova = (Date.now() + Math.floor(Math.random() * 1e6)).toString(36)
  const dirNovo = pastaDaParticao(nk, genNova)
  // O QUE JA ESTA AQUI NAO DESCE DE NOVO: arquivo igual (mesmo hash) na pasta de hoje e copiado do
  // disco. E o caso de quem so ficou uma versao atras.
  const precisa = new Set(lista.map((e) => String(e && e.h)))
  const temAqui = new Map()
  for (const a of arquivosDaSessao(dirVelho)) {
    try { const b = fs.readFileSync(a.abs); const h = hashDe(b); if (precisa.has(h) && !temAqui.has(h)) temAqui.set(h, a.abs) } catch (_) { /* fica pra baixar */ }
  }
  const total = lista.filter((e) => !temAqui.has(e.h)).reduce((t, e) => t + (Number(e.n) || 0), 0)
  let feito = 0
  marcaNuvem(nk, 'baixando', 'Baixando a sessão salva' + (total ? ' (' + mb(total) + ')' : '') + '...')
  try {
    fs.mkdirSync(dirNovo, { recursive: true })
    await emParalelo(lista, 3, async (e) => {
      const destino = caminhoSeguro(dirNovo, e && e.p)
      const k = Number(e && e.k) || 0
      if (!destino || !/^[0-9a-f]{64}$/.test(String(e && e.h)) || k < 1 || k > 200) throw new Error('a lista de arquivos da nuvem veio estranha')
      fs.mkdirSync(path.dirname(destino), { recursive: true })
      let buf = null
      if (temAqui.has(e.h)) {
        try { buf = fs.readFileSync(temAqui.get(e.h)); if (hashDe(buf) !== e.h) buf = null } catch (_) { buf = null }
      }
      if (!buf) {
        const partes = []
        for (let i = 0; i < k; i++) partes.push(await pedaco('GET', nk, e.h, i))
        buf = decifraArquivo(chave, Buffer.concat(partes))
        if (hashDe(buf) !== e.h) throw new Error('um arquivo da sessão veio diferente do que foi salvo')
        feito += buf.length
        if (total > 4 * 1048576) {
          marcaNuvem(nk, 'baixando', 'Baixando a sessão salva ' + mb(feito) + ' de ' + mb(total))
          avisaCasca('sw:status', { nk, texto: 'Baixando a sessão salva deste número: ' + mb(feito) + ' de ' + mb(total) })
        }
      }
      fs.writeFileSync(destino, buf)
    })
  } catch (e) {
    try { fs.rmSync(dirNovo, { recursive: true, force: true }) } catch (_) { /* fica pro lixo */ }
    throw e
  }
  config.sessoes = config.sessoes || {}
  config.sessoes[nk] = { ver: Number(meta.ver) || 0, gen: genNova, em: Date.now() }
  if (fs.existsSync(dirVelho)) config.lixo = [...(Array.isArray(config.lixo) ? config.lixo : []), { nome: path.basename(dirVelho), em: Date.now() }]
  gravarConfig()
}

// ANTES DE ABRIR: a nuvem tem versao mais nova que a daqui? Entao baixa.
//
// SE A DASH NAO RESPONDER SOBRE A SESSAO, ABRE COM A DAQUI. O aluguel acabou de passar (a dash
// estava de pe um segundo atras), entao isso e soluco, e travar o numero do vendedor por causa da
// nuvem seria trocar "pode estar uma versao atras" por "nao trabalha". Ja se a dash RESPONDEU que ha
// versao nova e o download falhou, nao abre: abrir a velha por cima de uma nova e o caso que
// desconecta.
async function trazDaNuvem(nk) {
  if (!config.token) return { ok: true }
  let meta
  try { meta = await sessaoMeta(nk) } catch (e) {
    anota('[nuvem] ' + nk + ' sem resposta sobre a sessao, abre com a daqui: ' + ((e && e.message) || e))
    return { ok: true, semNuvem: true }
  }
  const local = (config.sessoes && config.sessoes[nk]) || {}
  const ver = Number(meta.ver) || 0
  if (!(ver > (Number(local.ver) || 0)) || !Array.isArray(meta.manifesto) || !meta.manifesto.length) {
    if (ver) marcaNuvem(nk, 'salvo', 'Sessão salva na nuvem')
    return { ok: true }
  }
  avisaCasca('sw:status', { nk, texto: 'Baixando a sessão salva deste número...' })
  try {
    await baixaSessao(nk, meta)
    // OS COOKIES QUE VIERAM JUNTO entram na particao nova antes de o WhatsApp carregar, e o JSON sai
    // do disco: o lugar deles e o banco de cookies do Chromium, cifrado por esta maquina.
    let postos = 0
    const arqCk = path.join(pastaDaParticao(nk, geracaoDe(nk)), ...ARQ_COOKIES.split('/'))
    try {
      if (fs.existsSync(arqCk)) {
        postos = await poeCookies(particaoDe(nk), JSON.parse(fs.readFileSync(arqCk, 'utf8')))
        fs.rmSync(path.dirname(arqCk), { recursive: true, force: true })
      }
    } catch (e) { anota('[nuvem] ' + nk + ' cookies da nuvem nao entraram: ' + ((e && e.message) || e)) }
    anota('[nuvem] ' + nk + ' baixou a versao ' + ver + ' (' + meta.arquivos + ' arquivos, ' + mb(Number(meta.bytes) || 0) + ', ' + postos + ' cookies, salva por ' + (meta.nome || '?') + ')')
    marcaNuvem(nk, 'salvo', 'Sessão da nuvem aberta aqui')
    return { ok: true, baixou: true }
  } catch (e) {
    anota('[nuvem] ' + nk + ' nao baixou a versao ' + ver + ': ' + ((e && e.stack) || e))
    marcaNuvem(nk, 'erro', 'Não baixou a sessão da nuvem')
    return { ok: false, erro: 'Não consegui baixar a sessão salva deste número (' + String((e && e.message) || e) + '). Tente de novo.' }
  }
}

// ESTA CONECTADO? Quem diz e o motor (isAuthenticated). Sem o motor de pe, o `last-wid-md` do
// Local Storage, que o WhatsApp Web so grava depois de parear. Pareado com OUTRO aparelho (o slot diz
// um numero e o WhatsApp outro) nao conta: aquela sessao nao e deste numero.
// `estrito` (a passada de sobeAsAntigas) so aceita o motor dizendo que esta autenticado: la ninguem
// esta olhando, e o `last-wid-md` sobra no disco de numero que foi desconectado pelo celular ate o
// WhatsApp carregar e limpar. No Fechar de gente o numero acabou de ser usado, e o plano B vale.
const JS_CONECTADO = '(function(){try{var e=window.__swEstado?window.__swEstado():null;'
  + 'return {auth:!!(e&&e.autenticado),eu:String((e&&e.eu)||""),st:String((e&&e.conn&&e.conn.st)||""),wid:!!localStorage.getItem("last-wid-md")}}catch(_){return null}})()'
async function lerConexao(wc) {
  try { return await Promise.race([wc.executeJavaScript(JS_CONECTADO), espera(3000).then(() => null)]) } catch (_) { return null }
}
function conectadoDe(r, nk, estrito) {
  if (!r) return false
  if (r.eu && numKey(r.eu) && numKey(r.eu) !== nk) return false
  if (r.st === 'qr' || r.st === 'caiu' || r.st === 'bloqueado') return false
  return estrito ? !!r.auth : !!(r.auth || r.wid)
}
async function estaConectado(wc, nk, estrito) { return conectadoDe(await lerConexao(wc), nk, estrito) }

// O RESTO DO FECHAMENTO, fora da tela.
async function despedida(nk, s) {
  const wc = s && s.view && s.view.webContents
  let conectado = false
  if (wc && !wc.isDestroyed()) conectado = await estaConectado(wc, nk)
  salvaSessao(particaoDe(nk))
  try { if (wc && !wc.isDestroyed()) wc.close() } catch (_) { /* ok */ }
  if (conectado && config.token) {
    marcaNuvem(nk, 'enviando', 'Salvando na nuvem...')
    // O Chromium termina de gravar e fecha a base do IndexedDB uns instantes depois de a pagina sair.
    await espera(2500)
    try {
      const r = await enviaSessao(nk)
      if (r.ok) {
        anota('[nuvem] ' + nk + ' salvou a versao ' + r.ver + ' (' + mb(r.bytes) + ', mandou ' + mb(r.mandou) + ')')
        marcaNuvem(nk, 'salvo', 'Sessão salva na nuvem')
      } else if (r.conflito) {
        anota('[nuvem] ' + nk + ' nao salvou: a nuvem ja tem a versao ' + r.ver + ', mais nova que a daqui')
        marcaNuvem(nk, 'erro', 'Outro computador salvou uma versão mais nova deste número')
      } else anota('[nuvem] ' + nk + ' nao salvou: ' + r.pulou)
    } catch (e) {
      anota('[nuvem] ' + nk + ' falhou ao salvar: ' + ((e && e.stack) || e))
      marcaNuvem(nk, 'erro', 'Não salvou na nuvem: ' + String((e && e.message) || e))
    }
  }
  // O ALUGUEL SO SOLTA DEPOIS DO ENVIO, e nunca de um numero que ja foi reaberto aqui no meio tempo.
  if (!abertos.has(nk) && !abrindo.has(nk)) await soltaUso(nk)
}

// AS SESSOES PAREADAS ANTES DA 1.25.0 SOBEM SOZINHAS (19/10/2026).
//
// O Bruno pareou os numeros do time na 1.24.0, que nao mandava nada pra nuvem, e o vendedor abre
// amanha. Sem isto, cada sessao so subiria quando alguem abrisse e fechasse aquele numero aqui. A
// passada abre ESCONDIDO, um de cada vez, cada numero que tem sessao no disco e nenhuma na nuvem;
// espera o WhatsApp dizer que esta conectado e fecha, e o fechamento normal manda. Numero na tela do
// QR fecha sem mandar nada (ver despedida). Abrir de verdade e o unico jeito de saber se a sessao
// presta: os .ldb do LevelDB sao comprimidos, e procurar "conectado" no arquivo e adivinhar.
let passadaRodando = false
let ultimaPassada = 0
async function sobeAsAntigas() {
  if (passadaRodando || !config.token || EH_TESTE) return
  passadaRodando = true
  try {
    const lista = Array.isArray(config.numeros) ? config.numeros : []
    for (const n of lista) {
      const nk = numKey(n && n.numero)
      if (!nk || abertos.has(nk) || abrindo.has(nk) || despedidas.has(nk)) continue
      if (n.nuvem && Number(n.nuvem.ver) > 0) continue                     // a nuvem ja tem
      if (n.uso && !n.uso.meu) continue                                   // esta com outra maquina
      const local = (config.sessoes && config.sessoes[nk]) || {}
      if (Number(local.ver) > 0) continue                                 // ja subiu daqui
      if (local.tentou && Date.now() - Number(local.tentou) < 12 * 3600000) continue
      if (!temSessaoNoDisco(pastaDaParticao(nk, geracaoDe(nk)))) continue
      // SO COM FOLGA NA MEMORIA: abrir mais um com o teto cheio faria a hibernacao fechar o numero
      // de alguem.
      const teto = Math.max(1 + destacados.size, Number(config.maxAbertos) || 6)
      if (abertos.size + 1 >= teto) break
      config.sessoes = config.sessoes || {}
      config.sessoes[nk] = { ...local, tentou: Date.now() }
      gravarConfig()
      anota('[nuvem] passada: abrindo ' + nk + ' escondido pra subir a sessao')
      marcaNuvem(nk, 'enviando', 'Preparando pra salvar na nuvem...')
      const r = await abreNumero(n.numero, { fundo: true }).catch((e) => ({ ok: false, erro: String((e && e.message) || e) }))
      if (!r || !r.ok || r.jaAberto) {
        anota('[nuvem] passada: ' + nk + ' nao abriu: ' + ((r && r.erro) || 'ja estava aberto'))
        nuvemEstado.delete(nk)
        avisaCasca('sw:nuvem', { nk, st: '', txt: '' })
        continue
      }
      // ATE 90 s PRA CONECTAR. O WhatsApp de uma conta grande leva uns 20 s pra ficar de pe.
      // A TELA DO QR FIRME POR NOVE SEGUNDOS ENCERRA A ESPERA: numero que nunca pareou nesta maquina
      // nao tem o que salvar, e esperar os 90 s em cada um faria a passada levar meia hora.
      let conectado = false
      let qrSeguido = 0
      for (let t = 0; t < 30 && emFundo.has(nk); t++) {
        await espera(3000)
        const s = abertos.get(nk)
        if (!s || !s.view || s.view.webContents.isDestroyed()) break
        const r = await lerConexao(s.view.webContents)
        if (conectadoDe(r, nk, true)) { conectado = true; break }
        qrSeguido = (r && (r.st === 'qr' || r.st === 'caiu')) ? qrSeguido + 1 : 0
        if (qrSeguido >= 3) break
      }
      // ALGUEM CLICOU NELE NO MEIO: o numero e dele agora, a passada nao fecha.
      if (!emFundo.has(nk)) continue
      if (!conectado) {
        // NAO E "NAO SALVA": o motor nao confirmou (medido em 19/10: escondido e com a tela do PC
        // apagada, tres numeros pareados ficaram sem estado ate o fim do prazo e abriram normais
        // depois, na tela). Quem decide e o fechamento, pelo pareamento gravado no disco; numero que
        // nunca pareou nao tem esse registro e fecha sem mandar nada.
        anota('[nuvem] passada: ' + nk + ' o motor nao confirmou a conexao; o fechamento decide pelo disco')
        nuvemEstado.delete(nk)
        avisaCasca('sw:nuvem', { nk, st: '', txt: '' })
      } else await espera(4000)   // mais um respiro pro WhatsApp gravar o que baixou ao conectar
      fechaNumero(nk)
      try { await despedidas.get(nk) } catch (_) { /* ja anotado */ }
    }
  } finally { passadaRodando = false }
}

// APAGA AS PASTAS DE PARTICAO QUE FICARAM PRA TRAS, dois dias depois de trocadas. Roda no boot, antes
// de qualquer sessao subir, porque e o unico momento em que o Chromium nao segura nenhuma delas.
function limpaParticoesVelhas() {
  const lista = Array.isArray(config.lixo) ? config.lixo : []
  if (!lista.length) return
  const emUso = new Set(Object.keys(config.sessoes || {}).map((nk) => path.basename(pastaDaParticao(nk, geracaoDe(nk)))))
  const fica = []
  for (const x of lista) {
    const nome = String((x && x.nome) || '')
    if (!/^sw-\d{10}(-[a-z0-9]{1,16})?$/.test(nome) || emUso.has(nome)) continue
    if (Date.now() - (Number(x.em) || 0) < 2 * 86400000) { fica.push(x); continue }
    try { fs.rmSync(path.join(app.getPath('userData'), 'Partitions', nome), { recursive: true, force: true }) } catch (_) { fica.push(x) }
  }
  config.lixo = fica
  gravarConfig()
}

// FECHAR O APP ESPERA A NUVEM. Sem isto o X fechava tudo no mesmo instante e o que estava aberto
// nunca subia: justamente o caso do Bruno, que pareia os numeros e fecha o app.
let saindoDeVez = false
async function saiGuardando() {
  saindoDeVez = true
  const n = abertos.size + despedidas.size
  avisaCasca('sw:saindo', { n })
  for (const nk of [...abertos.keys()]) {
    marcaFechouNaMao(nk)
    try { fechaNumero(nk) } catch (_) { /* um que falhe nao segura os outros */ }
  }
  // TRES MINUTOS NO MAXIMO: a primeira subida de uma conta grande demora, mas o app nao pode ficar
  // preso pra sempre por causa de uma rede ruim.
  await Promise.race([Promise.allSettled([...despedidas.values()]), espera(180000)])
  try { if (janela && !janela.isDestroyed()) janela.destroy() } catch (_) { /* ok */ }
  app.quit()
}

// INJECAO DO MOTOR E DO PAINEL.
//
// POR QUE executeJavaScript E NAO <script>: a pagina do WhatsApp tem CSP apertada e barra script
// externo e inline. O executeJavaScript roda no mundo PRINCIPAL e nao passa pela CSP, entao a gente
// nao precisa arrancar o cabecalho de seguranca da pagina - que seria piorar a seguranca do
// vendedor pra ganhar conveniencia.
//
// ORDEM IMPORTA: primeiro o motor (WA-JS), depois o painel. O painel espera o window.WPP ficar
// pronto sozinho, entao nao trava se o motor demorar.
const CAMINHO_AGENTE = path.join(__dirname, 'ui', 'agente.js')

// ──────────────────────────────────────────────────────────────────────────────────────────────
// AGENTE ATUALIZAVEL SEM REINSTALAR (16/10/2026, pergunta do Bruno: "preciso baixar o aplicativo de
// novo, ou voce atualiza tudo?").
//
// POR QUE SO O AGENTE, e nao o app inteiro. Ele e o arquivo mais acoplado ao DOM e as APIs da Meta:
// e ele que quebra quando o WhatsApp muda, e quebra pra todo mundo no mesmo dia. E e o UNICO que da
// pra trocar QUENTE, porque o app rele o arquivo a cada injecao - recarregar a pagina do numero ja
// pega o novo, sem fechar nada.
//
// O QUE NUNCA VEM DO SERVIDOR: main.js e os tres preloads. Eles sao a FRONTEIRA DE CONFIANCA - a
// lista fechada de canais que a pagina do WhatsApp alcanca, o token da dash, a senha do proxy, o
// DPAPI. Baixar a fronteira significa que uma resposta ruim apaga a propria trava que deveria
// conter o estrago. O agente nao acrescenta poder nenhum: ele ja roda no mesmo mundo do MOTOR, que
// e biblioteca de terceiro e desce do servidor desde o primeiro dia.
//
// A COPIA DO INSTALADOR E O PISO. Ela mora no app.asar, e read-only e nunca falta. Toda duvida -
// sem rede, arquivo curto, sintaxe que nao parseia, ou as funcoes nao de pe depois de injetar -
// cai nela.
// AVISO DE VERSAO NOVA.
//
// O que NAO da pra atualizar sozinho (o processo principal, os preloads, o Electron) continua
// exigindo baixar o instalador. A diferenca e o vendedor SABER: antes ele rodava versao velha pra
// sempre e ninguem descobria. E exatamente o que causou o banimento da dash de teste - codigo
// velho na tela de quem achava que era o atual.
let versaoPublicada = ''
let urlInstalador = ''
// Compara 1.2.3 numero a numero. Comparar como texto diz que "1.10.0" e menor que "1.9.0".
function versaoMenor(a, b) {
  const pa = String(a || '').split('.').map((x) => Number(x) || 0)
  const pb = String(b || '').split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true
    if ((pa[i] || 0) > (pb[i] || 0)) return false
  }
  return false
}
async function confereVersao() {
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/versao',
      { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return
    ajustaRelogio(r)
    const d = await r.json()
    versaoPublicada = String((d && d.versao) || '')
    urlInstalador = String((d && d.url) || '')
    if (versaoPublicada && versaoMenor(app.getVersion(), versaoPublicada)) {
      anota('[versao] este app e ' + app.getVersion() + ' e a publicada e ' + versaoPublicada)
      avisaCasca('sw:versao', { atual: app.getVersion(), publicada: versaoPublicada, url: urlInstalador })
    }
  } catch (_) { /* sem rede: o aviso espera, o app funciona */ }
}

// ID DESTA MAQUINA, sorteado uma vez e guardado junto da configuracao.
//
// E o que distingue "o Bruno no PC dele" de "o Bruno no PC do vendedor". Tem que ser a MAQUINA e
// nao a pessoa: ele mesmo contou que pareia os numeros do time no computador dele e depois o
// vendedor usa no dele - sao dois lugares, o mesmo login, e e exatamente o cruzamento que a trava
// existe pra impedir.
function maquinaId() {
  if (!config.maquina) {
    config.maquina = 'm' + require('node:crypto').randomBytes(8).toString('hex')
    gravarConfig()
  }
  return config.maquina
}
const cabecalhos = () => ({
  'content-type': 'application/json',
  Authorization: 'Bearer ' + config.token,
  'x-sw-maquina': maquinaId(),
  // A VERSAO (19/10/2026): o servidor nao deixa app sem ela abrir numero que esta salvo na nuvem,
  // porque o app velho abriria a copia velha do disco por cima da nova.
  'x-sw-versao': app.getVersion(),
})

// TRAVA DE USO: PEDE, RENOVA E SOLTA.
//
// O aluguel vale 2 minutos no servidor e a renovacao vai de 45 em 45 segundos: tres chances de
// renovar antes de vencer, entao uma falha de rede nao derruba o numero da mao de quem esta
// usando. Fechou, solta na hora; caiu a luz, vence sozinho.
const alugados = new Set()
async function pedeUso(nk) {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/uso', {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify({ nk }), signal: AbortSignal.timeout(15000),
    })
    ajustaRelogio(r)
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('a dash respondeu ' + r.status) }
    if (d && d.ok) { alugados.add(nk); return { ok: true } }
    return { ok: false, ocupado: (d && d.ocupado) || { nome: 'outra pessoa' } }
  } catch (_) {
    // SEM RESPOSTA, NAO ABRE. Abrir "no escuro" e justamente o cruzamento que a trava evita, e o
    // preco de errar pro lado permissivo e um chip banido.
    return { ok: false, erro: 'Não deu pra falar com a dash pra conferir se alguém está usando este número.' }
  }
}
// SOLTAR TEM QUE VENCER A RENOVACAO.
//
// `soltaUso` e `pedeUso` podem estar no ar ao mesmo tempo: se a renovacao de 45s disparou um
// instante antes do fechamento, o INSERT dela chega DEPOIS do DELETE e ressuscita o aluguel por
// mais dois minutos. O `soltandoAgora` corta isso: a renovacao confere na hora de mandar, nao so
// quando o laco comecou.
const soltandoAgora = new Set()
async function soltaUso(nk) {
  alugados.delete(nk)
  soltandoAgora.add(nk)
  if (!config.token) { soltandoAgora.delete(nk); return }
  try {
    await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/uso', {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify({ nk, soltar: true }), signal: AbortSignal.timeout(10000),
    })
  } catch (_) { /* vence sozinho em 2 min */ }
  finally { soltandoAgora.delete(nk) }
}
// A renovacao confere DUAS vezes: ao montar o laco e na hora de mandar. Entre uma e outra cabe um
// fechamento inteiro.
setInterval(() => {
  for (const nk of [...alugados]) {
    if (!alugados.has(nk) || soltandoAgora.has(nk)) continue
    pedeUso(nk)
  }
}, 45000)

const ARQ_AGENTE_BAIXADO = () => path.join(app.getPath('userData'), 'agente-servido.js')
let agenteReprovado = false        // a copia baixada ja falhou nesta sessao: nao tenta de novo
let agenteDeOnde = 'instalador'    // so pro log e pro rodape dizerem a verdade

// O agente que vale AGORA, resolvido na hora da injecao (nao no boot): e isso que faz o conserto
// chegar sem fechar o app.
function agenteAgora() {
  if (!agenteReprovado) {
    try {
      const txt = fs.readFileSync(ARQ_AGENTE_BAIXADO(), 'utf8')
      if (agenteServe(txt)) { agenteDeOnde = 'servidor'; return txt }
      console.error('[agente] a copia baixada nao passou na conferencia; usando a do instalador')
    } catch (_) { /* nunca baixou, ou foi apagada: o piso resolve */ }
  }
  agenteDeOnde = 'instalador'
  try { return fs.readFileSync(CAMINHO_AGENTE, 'utf8') } catch (_) { return '' }
}

// TRES PORTAS ANTES DE DEIXAR O TEXTO ENTRAR NA PAGINA.
//  1. tamanho: resposta curta e pagina de erro disfarcada de script (o mesmo golpe que o motor leva)
//  2. assinatura: tem que ser o nosso arquivo, nao um HTML qualquer que tambem seja grande
//  3. sintaxe: `new vm.Script` parseia SEM executar. Pega arquivo truncado no meio do caminho.
// A quarta porta nao cabe aqui e acontece depois de injetar: conferir se as funcoes subiram.
function agenteServe(txt) {
  try {
    if (!txt || txt.length < 8000) return false
    if (txt.indexOf('window.__swEstado') < 0 || txt.indexOf('window.__swManda') < 0) return false
    new (require('node:vm').Script)(txt, { filename: 'agente-servido.js' })
    return true
  } catch (_) { return false }
}

// Busca a versao servida em segundo plano. Nunca bloqueia o boot: o que chegar vale na proxima
// injecao, que e recarregar a pagina do numero.
let buscandoAgente = false
async function atualizaAgente() {
  if (buscandoAgente || agenteReprovado) return
  buscandoAgente = true
  try {
    const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/agente.js'
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error('respondeu ' + r.status)
    const txt = await r.text()
    if (!agenteServe(txt)) throw new Error('nao passou na conferencia (' + txt.length + ' bytes)')
    let igual = false
    try { igual = fs.readFileSync(ARQ_AGENTE_BAIXADO(), 'utf8') === txt } catch (_) { igual = false }
    if (igual) return
    // Grava em temporario e renomeia: queda de luz no meio nao deixa arquivo pela metade.
    const tmp = ARQ_AGENTE_BAIXADO() + '.tmp'
    fs.writeFileSync(tmp, txt, 'utf8')
    fs.renameSync(tmp, ARQ_AGENTE_BAIXADO())
    anota('[agente] versao nova baixada (' + txt.length + ' bytes); vale ao recarregar o numero')
    avisaCasca('sw:agente', { novo: true })
  } catch (e) {
    console.error('[agente] nao atualizei: ' + ((e && e.message) || e))
  } finally { buscandoAgente = false }
}

// A QUARTA PORTA, e a que de fato protege: depois de injetar, as tres funcoes tem que estar de pe.
// Se nao estiverem, a copia baixada e REPROVADA na hora e o piso do instalador entra no lugar, na
// MESMA sessao - sem reiniciar, sem o vendedor ficar parado esperando alguem perceber.
async function confereAgente(wc) {
  let ok = false
  try {
    ok = !!(await wc.executeJavaScript(
      'typeof window.__swEstado === "function" && typeof window.__swManda === "function" && typeof window.__swIndica === "function"'))
  } catch (_) { ok = false }
  if (ok || agenteDeOnde !== 'servidor') return ok
  agenteReprovado = true
  try { fs.unlinkSync(ARQ_AGENTE_BAIXADO()) } catch (_) { /* ok */ }
  anota('[agente] a versao servida nao subiu; voltei pra do instalador e nao tento de novo nesta sessao')
  try {
    await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
    return true
  } catch (_) { return false }
}
let motorCache = ''
async function pegaMotor() {
  if (motorCache) return motorCache
  const r = await pegaRoteiro(false)
  const url = (r && r.motor) || (String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/motor.js')
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('motor respondeu ' + resp.status)
    const txt = await resp.text()
    // O motor tem ~500 KB. Resposta curta demais e pagina de erro disfarcada de script.
    if (txt.length < 100000) throw new Error('motor veio pela metade (' + txt.length + ' bytes)')
    motorCache = txt
    return txt
  } catch (e) {
    console.error('[painel] nao baixei o motor:', e && e.message)
    return ''
  }
}
// O PRELOAD PEDE O CODIGO DE FORMA SINCRONA e injeta no inicio do documento, que e o momento certo
// pro WA-JS: ele precisa estar la antes dos scripts do WhatsApp engancharem. O caminho pelo
// did-finish-load continua existindo como rede de seguranca (se o motor ainda nao tinha sido
// baixado na hora em que a pagina comecou).
ipcMain.on('sw:codigo', (e) => {
  let agente = ''
  try { agente = agenteAgora() } catch (_) { /* ok */ }
  e.returnValue = { motor: motorCache || '', agente }
})

async function injetaPainel(s) {
  if (!s || !s.view || s.view.webContents.isDestroyed()) return
  const wc = s.view.webContents
  // DUAS PERGUNTAS SEPARADAS. O agente vem do disco e sempre entra; o MOTOR vem da rede e pode ter
  // falhado. Perguntar so pelo agente dava "ja esta instalado" com o motor ausente, e o painel
  // ficava em "esperando o WhatsApp carregar" pra sempre, sem ninguem saber por que.
  try {
    const temMotor = await wc.executeJavaScript('typeof window.WPP !== "undefined"').catch(() => false)
    if (!temMotor) {
      motorCache = ''                      // a copia vazia nao serve: busca de novo
      const motor = await pegaMotor()
      if (motor) await wc.executeJavaScript(motor, true).catch((e) => console.error('[painel] motor nao rodou:', e && e.message))
      else console.error('[painel] sem motor em ' + s.nk + ': o painel nao vai conseguir mandar')
    }
    const temAgente = await wc.executeJavaScript('typeof window.__swEstado === "function"').catch(() => false)
    if (!temAgente) await wc.executeJavaScript(agenteAgora(), true)
    // A QUARTA PORTA. Injetou (ou ja estava la): as funcoes estao de pe? Se a copia servida falhar,
    // `confereAgente` volta pra do instalador aqui mesmo, sem reiniciar nada.
    await confereAgente(wc)
    console.log('[painel] pronto em ' + s.nk + (temMotor ? '' : ' (motor injetado agora)'))
  } catch (e) {
    console.error('[painel] falhou em ' + s.nk + ': ' + ((e && e.message) || e))
  }
}

// FILA DE CAPTURA. O painel manda lotes; aqui eles viram POST pra rota de ingestao do Sale Chat,
// que e a MESMA que ja alimenta o inbox, a atribuicao e o pixel. Reusar em vez de criar um segundo
// caminho evita ter duas verdades sobre a mesma conversa.
// A FILA SOBREVIVE A FECHAR O APP. Ela so existia em memoria: fechar o programa (ou um
// travamento) perdia tudo que ainda nao tinha subido, calado.
//
// ELA DEIXOU DE SER PEQUENA, e isso mudou duas regras.
//
// Quando o audio do lead passou a viajar junto (o cliente manda o endereco por audio), cada evento
// virou ate ~6,7 MB de base64. O teto da fila era de 5000 EVENTOS, o que em bytes nao quer dizer
// nada, e o arquivo era reescrito INTEIRO, de forma SINCRONA, a cada 10 segundos. Com a dash fora
// do ar e a fila cheia de audio, isso congelava o processo principal (e com ele o painel, o funil
// em andamento e o botao Parar) por centenas de milissegundos a cada ciclo; no extremo, o
// JSON.stringify estourava o limite de string do V8 e o arquivo nunca mais era escrito, ou seja a
// fila que existe pra sobreviver ao fechamento parava de existir justo no dia em que era precisa.
//
// Duas travas, as duas simples de proposito:
//   1. teto da fila em BYTES. Estourou, o anexo do evento MAIS ANTIGO e jogado fora e a mensagem
//      fica: sem o anexo a bolha ainda aparece no inbox e o lead ainda e criado (conferido no
//      worker: mediaB64 e opcional). Perder o audio e ruim; perder a mensagem e pior.
//   2. o ARQUIVO nunca guarda os bytes. Fechar o app com anexo pendente perde o anexo, nao a
//      mensagem - e em troca a gravacao sincrona volta a ser barata e o estouro do V8 some.
const ARQ_FILA = () => path.join(app.getPath('userData'), 'captura-pendente.json')
const TETO_FILA_BYTES = 40 * 1024 * 1024
const filaCaptura = []
let drenando = false
let filaSuja = false
const pesoDe = (ev) => (ev && ev.mediaB64 ? String(ev.mediaB64).length : 0) + 400
function pesoDaFila() {
  let n = 0
  for (const ev of filaCaptura) n += pesoDe(ev)
  return n
}
function gravaFila() {
  if (!filaSuja) return
  gravaFilaAgora()
}
function gravaFilaAgora() {
  filaSuja = false
  // SINCRONO DE PROPOSITO: o before-quit nao espera promessa, entao gravacao assincrona na saida
  // perde justamente o que a fila em disco existe pra salvar. Sem os bytes, o custo e irrelevante.
  try {
    const semBytes = filaCaptura.slice(0, 5000).map((ev) => {
      if (!ev || !ev.mediaB64) return ev
      const copia = { ...ev }
      delete copia.mediaB64
      delete copia.mediaMime
      return copia
    })
    fs.writeFileSync(ARQ_FILA(), JSON.stringify(semBytes), 'utf8')
  } catch (_) { /* ok */ }
}
function leFila() {
  try {
    const v = JSON.parse(fs.readFileSync(ARQ_FILA(), 'utf8'))
    if (Array.isArray(v) && v.length) {
      filaCaptura.push(...v)
      console.log('[captura] ' + v.length + ' mensagens esperando do uso anterior')
      // A BARRA TEM QUE MOSTRAR ISSO. O contador so era escrito quando chegava mensagem nova:
      // abrir o app com 200 pendentes do dia anterior parecia fila zerada.
      avisaCasca('sw:fila', { n: filaCaptura.length })
    }
  } catch (_) { /* primeiro uso */ }
}
setInterval(gravaFila, 10000)
app.on('before-quit', () => {
  // FECHAR O APP E ACAO DE GENTE, pra TODO numero aberto. Sem isto, sair do programa no fim do
  // expediente geraria um alarme de queda por numero aberto, e alarme falso diario mata a
  // credibilidade do aviso em uma semana.
  try { for (const nk of abertos.keys()) marcaFechouNaMao(nk) } catch (_) { /* saindo mesmo */ }
  gravaFila()
  // Solta o que esta na mao antes de sair. Nao da pra esperar a resposta (o before-quit nao espera
  // promessa), mas o pedido sai; e se nao sair, o aluguel vence em 2 minutos de qualquer jeito.
  for (const nk of alugados) soltaUso(nk)
  // Antes de morrer, manda gravar TODAS as sessoes abertas. Sem isto, fechar o app com seis
  // numeros abertos podia perder o pareamento dos ultimos que o Chromium ainda nao tinha gravado.
  for (const nk of abertos.keys()) salvaSessao(particaoDe(nk))
})
// O RELOGIO QUE VALE E O DO SERVIDOR.
//
// `velha` (mensagem de mais de 30 minutos) decide no worker se a atribuicao e reescrita e se um
// "Pedido Concluido" vira venda. Ele saia do `Date.now()` do PC do vendedor: Windows sem servico
// de hora, maquina virtual ou bateria da placa fraca adiantam o relogio em dezenas de minutos, e
// com 40 minutos de adianto TODA mensagem recebida chegava marcada velha. Resultado silencioso:
// wa_attrib nunca gravado (a resposta sai pelo chip errado) e NENHUMA venda registrada.
//
// Calcular no servidor tambem nao serve: a fila pode ficar a noite inteira esperando a dash voltar,
// e ai a mensagem de ontem chegaria "velha" hoje e as vendas da noite seriam todas descartadas.
// Entao o carimbo continua acontecendo na CAPTURA, so que com o relogio corrigido.
let desvioRelogio = 0
// Toda resposta HTTP traz o cabecalho `Date` com a hora do servidor. Nao precisa de rota nova nem
// de campo novo: qualquer conversa com a dash ja corrige o relogio, com precisao de um segundo -
// de sobra pra uma regra de trinta minutos.
function ajustaRelogio(resp) {
  try {
    const h = resp && resp.headers && resp.headers.get('date')
    if (!h) return
    const t = Date.parse(h)
    if (!Number.isFinite(t)) return
    const novo = t - Date.now()
    if (Math.abs(novo - desvioRelogio) > 60000) {
      console.log('[relogio] o PC esta ' + Math.round(novo / 1000) + 's fora da hora do servidor; corrigindo')
    }
    desvioRelogio = novo
  } catch (_) { /* ok */ }
}
const agoraCerto = () => Date.now() + desvioRelogio
const ehVelha = (ts) => (Number(ts) > 0 && (agoraCerto() / 1000 - Number(ts)) > 1800 ? 1 : 0)

async function drenaCaptura() {
  if (drenando || !filaCaptura.length) return
  // A TRAVA VEM ANTES DE QUALQUER ESPERA. Com ela depois do await do roteiro, duas drenagens
  // entravam juntas no boot (quando o roteiro ainda nao esta em cache e a busca demora de verdade):
  // as duas montavam o mesmo lote e a fila era cortada duas vezes.
  drenando = true
  try {
    await drenaLotes()
  } finally {
    drenando = false
    gravaFila()
    avisaCasca('sw:fila', { n: filaCaptura.length })
  }
}

async function drenaLotes() {
  const r = await pegaRoteiro(false)
  // A captura vai pela rota AUTENTICADA, com o Bearer do proprio usuario. O token de ingestao nao
  // desce mais pro app (ver worker: quem o tivesse podia inventar venda).
  const alvo = (r && r.captura) || (String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/captura')
  if (!config.token) return
  while (filaCaptura.length) {
    // NAO TIRA DA FILA ANTES DA CONFIRMACAO. Antes o lote saia da fila no splice e so existia em
    // memoria: fechar o app no meio do envio perdia aquelas mensagens, sem erro nenhum. Agora a
    // fila so encolhe depois da resposta, e reenviar e seguro porque a ingestao deduplica por id.
    // LOTE POR TAMANHO, NAO SO POR CONTAGEM. Audio e foto do lead viajam em base64: 50 eventos com
    // anexo passariam de 300 MB num POST so, e o Worker derruba a requisicao sem explicar.
    const lote = []
    let peso = 0
    for (const ev of filaCaptura) {
      const tam = ev && ev.mediaB64 ? String(ev.mediaB64).length : 400
      if (lote.length && (peso + tam > 6 * 1024 * 1024 || lote.length >= 50)) break
      lote.push(ev)
      peso += tam
    }
    gravaFilaAgora()
    let aceitos = null
    try {
      // PRAZO LONGO DE PROPOSITO. O lote vai ate 6 MB de base64 e o AbortSignal e relogio de
      // parede, nao inatividade: 60 s abortaria um envio legitimo de vendedor com subida de 512
      // kbps, que cairia no catch, daria break e tentaria o MESMO lote pra sempre. 240 s cobre 6 MB
      // em ~200 kbps e ainda assim solta uma conexao meia-aberta, que era o buraco original.
      const resp = await fetch(alvo, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
        body: JSON.stringify({ events: lote }),
        signal: AbortSignal.timeout(240000),
      })
      ajustaRelogio(resp)
      if (resp.status === 401 || resp.status === 403) {
        console.error('[captura] sessao vencida: a fila fica guardada ate entrar de novo')
        avisaCasca('sw:fila', { n: filaCaptura.length, erro: 'entre de novo na dash' })
        break
      }
      if (!resp.ok) { console.error('[captura] ingestao respondeu ' + resp.status); break }
      const d = await resp.json().catch(() => null)
      aceitos = d && Array.isArray(d.ack) ? new Set(d.ack.map(String)) : null
      const barrados = Number(d && d.barrados) || 0
      if (barrados) console.error('[captura] o servidor recusou ' + barrados + ' evento(s) deste lote')
    } catch (e) {
      console.error('[captura] nao enviou: ' + ((e && e.message) || e))
      break
    }
    // REMOVE POR IDENTIDADE, NUNCA POR POSICAO. Entre montar o lote e chegar a resposta, o agente
    // pode ter empurrado mensagem nova pra fila; cortar os 50 primeiros por posicao jogaria fora o
    // que nunca foi enviado.
    const antes = filaCaptura.length
    const doLote = new Set(lote)
    for (let i = filaCaptura.length - 1; i >= 0; i--) {
      if (doLote.has(filaCaptura[i])) filaCaptura.splice(i, 1)
    }
    if (aceitos && aceitos.size && lote.length) {
      const naoVoltou = lote.filter((ev) => !aceitos.has(String(ev && ev.msgId))).length
      if (naoVoltou) console.error('[captura] ' + naoVoltou + ' evento(s) do lote nao voltaram no ack')
    }
    if (filaCaptura.length === antes) break   // nada saiu: para em vez de girar
    filaSuja = true
  }
}

setInterval(drenaCaptura, 15000)

// SINAL DE VIDA DOS NUMEROS ABERTOS.
//
// A roleta so manda lead pra numero que ela considera vivo, e a linha expira em 3 minutos. Sem
// isto, numero que sai do Datacrazy e passa a viver aqui some da roleta e para de receber lead em
// silencio - o pior desfecho possivel numa migracao. Manda a cada 60 segundos, e so marca vivo
// quando o motor do WhatsApp esta de pe naquela sessao.
async function bateSinal() {
  if (!config.token || !abertos.size) return
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/heartbeat'
  // EM PARALELO, E COM PRAZO. Era um laco sequencial sem prazo nenhum: bastava UM numero com a
  // conexao pendurada pra que os outros cinco nunca batessem sinal, e em tres minutos eles saiam
  // da roleta em silencio.
  await Promise.allSettled([...abertos.values()].map((s) => sinalDeUm(s, url)))
}

async function sinalDeUm(s, url) {
  if (!s.view || s.view.webContents.isDestroyed()) return
  let e = null
  try { e = await s.view.webContents.executeJavaScript('window.__swEstado ? window.__swEstado() : null') } catch (_) { e = null }
  // SO BATE SINAL COM APARELHO PAREADO DE VERDADE.
  //
  // Duas guardas, e as duas sao necessarias. Sem `e.eu` nao existe numero pra reportar: o antigo
  // plano B de usar o numero do SLOT carimbava a linha com um numero que ninguem conectou, e a
  // sessao na tela do QR entrava na roleta. E sem `autenticado` o sinal diria "vivo" so porque a
  // biblioteca carregou - medido: na tela do QR, motor e envia ja sao true.
  //
  // Nao bater sinal tambem e importante: a linha de sc_heartbeat tem o numero como chave e e
  // COMPARTILHADA com o heartbeat do Sale Chat. Mandar "nao vivo" daqui tiraria da roleta um
  // numero que esta pareado la.
  // SEM MOTOR, O NUMERO SOME DA ROLETA EM SILENCIO. Isso nao pode passar calado: `autenticado`
  // depende do WA-JS, entao motor que nao carregou faz um numero PAREADO parar de bater sinal.
  // Falhar fechado continua certo (lead pago indo pra ninguem e pior), mas tem que aparecer.
  if (e && !e.motor) {
    if (!s.avisouMotor) {
      s.avisouMotor = true
      console.error('[sinal] ' + s.nk + ' sem o motor do WhatsApp: nao bate sinal e sai da roleta em 3 min')
      avisaCasca('sw:semMotor', { nk: s.nk })
    }
  } else if (s.avisouMotor && e && e.motor) {
    s.avisouMotor = false
    avisaCasca('sw:semMotor', { nk: s.nk, ok: true })
  }
  // O ESTADO DA CONEXAO, reportado SEMPRE, inclusive o ruim. Vai num canal proprio, separado do
  // sinal que alimenta a roleta: misturar os dois poria numero caido de volta na distribuicao, que
  // e o oposto do que isto serve.
  try { await reportaConexao(s, e) } catch (_) { /* nunca atrapalha o sinal */ }
  if (!e || !e.eu || !e.autenticado) return
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      // `auth` e campo NOVO de proposito: o worker exige ele e trata ausencia como "nao vivo".
      // Assim, uma copia velha do app instalada por ai nao consegue mais marcar numero como vivo.
      body: JSON.stringify({ numero: e.eu, auth: true, motor: !!e.motor }),
      signal: AbortSignal.timeout(15000),
    })
    ajustaRelogio(r)
  } catch (_) { /* sem rede o sinal expira sozinho, que e o certo */ }
}
// REPORTA O ESTADO DA CONEXAO quando ele MUDA, nunca a cada minuto: o servidor so precisa saber
// das viradas, e mandar o mesmo estado 1.440 vezes por dia seria ruido caro.
//
// `espontaneo` e o campo que vale: TRUE quer dizer "a janela estava aberta e o WhatsApp caiu
// sozinho", que e o unico caso que merece alarme. Fechar o numero ou sair do app marca
// `fechouNaMao` e o estado ruim que vier depois chega com `espontaneo: false`.
async function reportaConexao(s, e) {
  if (!config.token || !s || !s.nk) return
  const c = (e && e.conn) || null
  const st = String((c && c.st) || (e ? 'naosei' : 'naosei'))
  if (st === s.connUltimo) return          // nada mudou
  const antes = s.connUltimo || ''
  s.connUltimo = st
  const ruim = (st === 'caiu' || st === 'bloqueado' || st === 'conflito' || st === 'proxy')
  const espontaneo = ruim && !foiAcaoDeGente(s.nk)
  // O LOG LOCAL GUARDA O CRU, sempre. E dele que vai sair a resposta de qual sinal um ban de
  // verdade dispara: hoje ninguem sabe, e e melhor ter o registro do primeiro caso real do que
  // uma regra inventada agora.
  anota('[conn] ' + s.nk + ' ' + antes + ' -> ' + st
    + ' modo=' + String((c && c.modo) || '') + ' info=' + String((c && c.info) || '')
    + ' queda=' + JSON.stringify((c && c.queda) || null) + ' espontaneo=' + (espontaneo ? 1 : 0))
  avisaCasca('sw:conexao', { nk: s.nk, st, espontaneo })
  try {
    await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/conexao', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      // O NUMERO VAI PELO SLOT (`nk`), nunca pelo que o agente diz: depois do logout o
      // `numeroDoAparelho()` volta VAZIO, e usar ele como identidade foi um furo ja consertado.
      body: JSON.stringify({
        nk: s.nk, st, espontaneo,
        modo: String((c && c.modo) || ''), info: String((c && c.info) || ''),
        queda: (c && c.queda) || null,
      }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (_) { /* sem rede: a proxima virada reporta */ }
}

setInterval(bateSinal, 60000)

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 7) Conversa com a dash

// VER COMO UM DOS VENDEDORES (16/10/2026, pedido do Bruno: "quero ver como seria a visualizacao
// dele, pra acompanhar o dia a dia e ver se ele esta convertendo certinho").
//
// Isto NAO e simulacao do lado do app. Quem responde como a pessoa e a dash: qualquer GET com
// `?como=<id>` vindo de diretor volta com as MESMAS colunas que o login dela traria, inclusive as
// que mudam o recorte. E a mesma peca que ja faz o "ver como" da dash inteira desde 15/09, e ela
// so ESTREITA: o alvo nunca e diretor, entao nao da pra ver mais do que se ve.
//
// So vale pra LEITURA, de proposito. Ligar ou desligar um numero enquanto esta no preview continua
// acontecendo como VOCE, nao como ele - gravacao com a cara de outra pessoa seria registro falso.
let comoId = ''
let donosConhecidos = []   // [{ id, nome }] dos donos vistos na ultima leitura REAL
const comoNaUrl = () => (comoId ? '?como=' + encodeURIComponent(comoId) : '')

ipcMain.handle('sw:como', async (_e, { id }) => {
  comoId = String(id || '')
  const r = await buscaNumeros()
  return { ok: true, como: comoId, numeros: (r && r.numeros) || [] }
})

async function buscaNumeros() {
  if (!config.token) return { ok: false, erro: 'Falta entrar com o token da dash.' }
  const url = String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/numeros' + comoNaUrl()
  try {
    // COM A MAQUINA NO CABECALHO (19/10/2026): sem ele o servidor nao tem como dizer que o aluguel e
    // DESTA maquina, e o `uso.meu` vinha sempre falso.
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + config.token, 'x-sw-maquina': maquinaId() }, signal: AbortSignal.timeout(20000) })
    ajustaRelogio(r)
    if (!r.ok) return { ok: false, erro: 'A dash respondeu ' + r.status }
    const d = await r.json()
    const lista = Array.isArray(d && d.numeros) ? d.numeros : []
    config.numeros = lista
    config.direcao = !!(d && d.direcao)
    // A PASSADA QUE SOBE AS SESSOES ANTIGAS sai depois da lista chegar (ela precisa do campo `nuvem`
    // de cada numero), no maximo de meia em meia hora.
    if (!comoId && Date.now() - ultimaPassada > 30 * 60000) {
      ultimaPassada = Date.now()
      setTimeout(() => { sobeAsAntigas().catch((e) => anota('[nuvem] passada estourou: ' + ((e && e.stack) || e))) }, 15000)
    }
    // APROVEITA A VOLTA PRA BUSCAR O ROTEIRO TAMBEM (16/10/2026, pergunta do Bruno: "quando eu mexo
    // no Sale Chat, queria que atualizasse aqui").
    //
    // Esta leitura acontece a cada 20s e ao a janela ganhar foco, que e exatamente o momento em que
    // ele volta da dash depois de mexer no roteiro. Sem isso o painel so pegava a mudanca quando o
    // cache de 10 minutos vencesse, e "mexi la e nao mudou aqui" parece quebrado mesmo nao estando.
    // Dois minutos de folga pra o alt-tab repetido nao virar leitura em rajada.
    if (Date.now() - roteiroEm > 120000) pegaRoteiro(true).catch(() => {})
    // A LISTA DE QUEM DA PRA VER so e remontada fora do preview. Dentro dele a resposta traz so os
    // numeros de uma pessoa, e guardar isso apagaria as outras opcoes do seletor.
    if (!comoId) {
      const vistos = new Map()
      for (const n of lista) if (n && n.at && n.dono) vistos.set(String(n.at), String(n.dono))
      donosConhecidos = [...vistos].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    }
    if (d && d.config) {
    }
    gravarConfig()
    return { ok: true, numeros: lista }
  } catch (e) {
    return { ok: false, erro: 'Nao deu pra falar com a dash: ' + (e && e.message) }
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 8) IPC

ipcMain.handle('sw:estado', () => ({
  temToken: !!config.token,
  nome: config.nome || '',
  apiBase: config.apiBase,
  // A casca ainda recebe os dois, SEMPRE TRUE, porque ela desenha a linha "Proxy obrigatória, e
  // do Brasil / sempre" nos Ajustes. Vem da constante, nao do disco: o que ela mostra e a regra.
  travaProxy: TRAVA_PROXY,
  exigirBrasil: EXIGE_BRASIL,
  numeros: config.numeros,
  // SO O ENDERECO, NUNCA A CREDENCIAL. `config.proxies` guarda usuario e senha decifrados (o
  // lerConfig abre o DPAPI), e a casca so usa host, porta e "tem proxy?" - conferido: app.js le
  // px.host, px.porta e a existencia, mais nada. Mandar a senha inteira pra um renderer era
  // credencial viajando a troco de nada, e vira risco de verdade no dia em que a casca for servida
  // do servidor.
  proxies: Object.fromEntries(Object.entries(config.proxies || {}).map(([k, p]) => [k, {
    host: (p && p.host) || '', porta: Number(p && p.porta) || 0, temSenha: !!(p && (p.usuario || p.senha)),
  }])),
  maxAbertos: Number(config.maxAbertos) || 6,
  direcao: !!config.direcao,
  // Em preview, `direcao` ja vem false do servidor (ele responde como a pessoa), entao a tela
  // esconde proxy e trava sozinha. `comoId` existe so pra marcar a tela: preview sem aviso e o
  // jeito mais rapido de alguem achar que perdeu permissao.
  como: comoId,
  // De quem da pra ver a tela. Sai dos donos dos numeros que a dash mandou na ULTIMA leitura REAL
  // (sem preview), senao entrar no preview de um vendedor apagaria a lista de escolha.
  vendedores: donosConhecidos,
  painelLigado: painelLigado,
  barraEncolhida: !!config.barraEncolhida,
  abertos: [...abertos.keys()],
  // QUAIS ESTAO EM JANELA PROPRIA. A barra precisa disto pra dizer "está na outra janela" em vez de
  // tentar trazer a view de volta: trazer arrancaria ela de la e a outra janela ficaria em branco.
  destacados: [...destacados.keys()],
  // O que a nuvem esta fazendo com cada numero AGORA (enviando, baixando, salvo, erro). O que ja esta
  // salvo de antes vem do servidor, no campo `nuvem` de cada numero.
  nuvem: Object.fromEntries(nuvemEstado),
  versao: app.getVersion(),
  // O que esta publicado agora. Vazio = ainda nao perguntei, ou a dash nao respondeu.
  versaoPublicada,
  precisaBaixar: !!(versaoPublicada && versaoMenor(app.getVersion(), versaoPublicada)),
  urlInstalador,
  agenteDeOnde,
  chromium: process.versions.chrome,
}))

// ENTRAR COM USUARIO E SENHA, nao com token (16/10/2026, pedido do Bruno: "eu vou passar isso pros
// meus vendedores, eles sao bem leigos, como e que eles vao entender o que e token da dash e
// endereco da API"). O app troca login e senha por token no MESMO /auth/login da dash, e guarda o
// token aqui dentro. O endereco da API saiu da tela: e sempre o nosso worker.
ipcMain.handle('sw:entrar', async (_e, { login, senha }) => {
  const usuario = String(login || '').trim()
  if (!usuario || !senha) return { ok: false, erro: 'Preencha usuário e senha.' }
  const url = String(config.apiBase).replace(/\/+$/, '') + '/auth/login'
  let d = null
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: usuario, password: String(senha) }),
    })
    d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || (r.status === 401 ? 'Usuário ou senha errados.' : 'A dash respondeu ' + r.status) }
  } catch (e) {
    return { ok: false, erro: 'Não deu pra falar com a dash. Confira a internet.' }
  }
  const tk = d && (d.token || (d.user && d.user.token))
  if (!tk) return { ok: false, erro: 'A dash não devolveu o acesso. Avise a direção.' }
  config.token = String(tk)
  config.nome = (d.user && (d.user.name || d.user.login)) || usuario
  gravarConfig()
  return buscaNumeros()
})

ipcMain.handle('sw:sair', async () => {
  // FECHA OS NUMEROS ANTES DE APAGAR O TOKEN. O `fechaNumero` solta o aluguel de uso no servidor, e
  // isso so funciona com o token ainda valido: invertendo a ordem, o numero ficaria carimbado como
  // "em uso por voce" pra equipe inteira ate o aluguel vencer sozinho, e ninguem conseguiria abrir.
  for (const nk of [...abertos.keys()]) {
    try { fechaNumero(nk) } catch (_) { /* um que falhe nao pode impedir os outros */ }
  }
  // E ESPERA A NUVEM: o envio da sessao e o soltar do aluguel precisam do token que vai sumir abaixo.
  await Promise.race([Promise.allSettled([...despedidas.values()]), espera(180000)])
  config.token = ''
  config.nome = ''
  gravarConfig()
  return { ok: true }
})
ipcMain.handle('sw:numeros', () => buscaNumeros())
// O IPC NAO PODE REJEITAR (18/10/2026). Do outro lado, `abrirDeVerdade` faz carregando.add(nk)
// antes do await e carregando.delete(nk) DEPOIS dele: promessa rejeitada pula o delete e o numero
// fica preso em `carregando` ate o vendedor fechar o app - e `abrir()` comeca com
// `if (carregando.has(nk)) return`, entao o botao para de responder e nada na tela explica.
ipcMain.handle('sw:abrir', async (_e, { numero }) => {
  try { return await abreNumero(numero) } catch (e) {
    anota('sw:abrir estourou: ' + ((e && e.stack) || e))
    return { ok: false, erro: 'Não consegui abrir este número agora. Tente de novo.' }
  }
})
ipcMain.handle('sw:mostrar', (_e, { nk }) => { mostra(nk); return { ok: true } })

// O TELEFONE NO TITULO DA JANELA. Gemeo do `bonito` do app.js, escrito aqui porque o processo
// principal nao compartilha codigo com a pagina - e porque usar o nome de la daria ReferenceError,
// que `node --check` nao pega e so aparece quando alguem clica no botao.
function telefoneBonito(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^55/, '')
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7)
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6)
  return String(n || '')
}

// ─── DESTACAR: o numero sai pra uma janela propria ───────────────────────────────────────────
//
// A MESMA view muda de mae. Medido pelo levantamento antes de escrever isto: mudar uma
// WebContentsView de BaseWindow mantem o mesmo processo de renderizacao, o mesmo documento, o
// setInterval sem pular e a conexao sem furo - uma navegacao e uma carga do inicio ao fim. Ou seja
// o WhatsApp NAO recarrega e o funil que estiver no meio de um disparo nao sente nada.
function destaca(nk) {
  const s = abertos.get(nk)
  if (!s || s.view.webContents.isDestroyed()) return { ok: false, erro: 'esse número não está aberto' }
  const ja = destacados.get(nk)
  if (ja) {
    // IDEMPOTENTE: destacar duas vezes so traz a janela pra frente. Criar uma segunda view na mesma
    // particao seria conflito de sessao no WhatsApp Web.
    if (ja.win && !ja.win.isDestroyed()) { ja.win.show(); ja.win.focus() }
    return { ok: true, ja: true }
  }

  const num = (config.numeros || []).find((x) => x && numKey(x.numero) === nk) || {}
  const b = janela && !janela.isDestroyed() ? janela.getContentBounds() : { width: 1200, height: 860 }
  const win = new BaseWindow({
    width: Math.max(912, Math.min(1280, b.width - 120)),
    height: Math.max(600, b.height - 40),
    // O PISO E OUTRO AQUI. O 1180 da principal e barra + WhatsApp + painel; sem barra, o piso e o
    // painel (316) mais o que o WhatsApp precisa pra nao cortar a tela de entrar da Meta (596).
    minWidth: 912,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    title: 'SellWave Web · ' + (num.numero ? telefoneBonito(num.numero) : nk),
    // SEM `parent`: no Windows, janela filha fica SEMPRE na frente da mae e minimiza junto. Isso
    // mataria o pedido, que e poder deixar um WhatsApp em cada monitor.
  })

  const d = { nk, win, painel: null }
  destacados.set(nk, d)

  // A VIEW MUDA DE MAE. Tirar da antiga antes de por na nova, e mandar aparecer DE PROPOSITO: a
  // visibilidade cola na view, e ela estaria escondida se o vendedor tivesse trocado de numero.
  try { janela.contentView.removeChildView(s.view) } catch (_) { /* ja pode ter saido */ }
  win.contentView.addChildView(s.view)
  s.view.setVisible(true)
  s.ultimoUso = Date.now()
  if (ativoAgora === nk) ativoAgora = ''

  // O PAINEL DELA, na MESMA particao do outro: e o que faz o `swmedia`, os favoritos e o roteiro
  // funcionarem sem nenhum caminho novo.
  d.painel = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-painel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      partition: 'persist:sw-painel',
    },
  })
  win.contentView.addChildView(d.painel)
  d.painel.webContents.loadFile(path.join(__dirname, 'ui', 'painel.html'))

  win.on('resize', () => reposiciona(d))
  // FECHAR A JANELA DEVOLVE O NUMERO, NAO O MATA. No `close` os filhos ainda estao vivos e
  // alcancaveis; depois disso nao estariam.
  win.on('close', () => devolve(nk))
  reposiciona(d)
  win.show()
  avisaCasca('sw:destacado', { nk })
  return { ok: true }
}

// DEVOLVE O NUMERO PRA JANELA PRINCIPAL. Chamado ao fechar a janela destacada e tambem quando o
// numero e fechado de vez.
function devolve(nk) {
  const d = destacados.get(nk)
  if (!d) return { ok: true }
  destacados.delete(nk)
  const s = abertos.get(nk)
  if (s && !s.view.webContents.isDestroyed()) {
    try { d.win.contentView.removeChildView(s.view) } catch (_) { /* a janela pode estar indo embora */ }
    if (janela && !janela.isDestroyed()) {
      janela.contentView.addChildView(s.view)
      // ESCONDIDA DE PROPOSITO: a visibilidade cola na view, e ela voltaria aparecendo POR CIMA do
      // numero que estiver na principal. Quem decide o que aparece la e o `mostra`.
      s.view.setVisible(false)
      s.view.setBounds(areaConteudo())
    }
  }
  try { if (d.painel && !d.painel.webContents.isDestroyed()) d.painel.webContents.close() } catch (_) { /* ok */ }
  d.painel = null
  avisaCasca('sw:devolvido', { nk })
  reposicionaPrincipal()
  return { ok: true }
}

ipcMain.handle('sw:destacar', (_e, { numero, nk }) => destaca(String(nk || numKey(numero || ''))))
ipcMain.handle('sw:devolver', (_e, { nk }) => {
  const d = destacados.get(String(nk || ''))
  if (d && d.win && !d.win.isDestroyed()) { d.win.close(); return { ok: true } }   // o close chama devolve
  return devolve(String(nk || ''))
})
ipcMain.handle('sw:esconder', () => { escondeTodos(); return { ok: true } })
// QUEM FECHOU: A PESSOA OU O WHATSAPP? (18/10/2026, a distincao e do Bruno)
//
// "quando voce detectar que alguem fechou o WhatsApp ou clicou em fechar na janela, voce sabe que
// ele nao foi banido. Agora, se (...) a janela esta toda aberta, tudo funcionando, e do nada o
// WhatsApp caiu, nao foi nenhuma acao que o vendedor tomou."
//
// Ele esta certo, e o APP e o unico que sabe separar os dois: ele e quem fecha a janela. O servidor
// so ve o sinal parar de chegar, e silencio nao distingue nada. Este conjunto guarda os numeros
// que foram fechados POR ACAO DE GENTE nos ultimos minutos, pra o estado ruim que aparecer logo
// depois nao virar alarme de queda.
const fechouNaMao = new Map()   // nk -> quando (ms)
const FECHOU_VALE = 120000      // 2 min: tempo de sobra pra view morrer e o ultimo sinal passar
function marcaFechouNaMao(nk) { if (nk) fechouNaMao.set(String(nk), Date.now()) }
function foiAcaoDeGente(nk) {
  const t = fechouNaMao.get(String(nk))
  return !!t && (Date.now() - t) < FECHOU_VALE
}

ipcMain.handle('sw:fechar', (_e, { nk }) => { marcaFechouNaMao(nk); fechaNumero(nk); return { ok: true } })

// O APP NAO CADASTRA PROXY (16/10/2026, revisao adversarial).
//
// Antes o vendedor podia abrir o numero com o proxy da direcao, passar no preflight, e DEPOIS
// trocar por um proxy dele (ou pelo IP da casa dele) com o botao direito: a trava era contornada
// pelo proprio lado que ela deveria conter. Quem cadastra e a direcao, em Ferramentas > SellWave
// Web, e o app so LE.
// CADASTRAR PROXY PELO PROPRIO APP, e so a direcao.
//
// Isto esteve de fora por um tempo e foi erro meu. A revisao de 16/10 tirou o cadastro do app com
// um motivo certo - o VENDEDOR nao pode trocar o proxy pelo dele e furar a trava - mas eu apaguei
// a tela pra todo mundo, inclusive pra quem cadastra. Resultado medido no mesmo dia: o Bruno ficou
// preso na tela "Nao abriu / cadastre na dash" sem conseguir cadastrar nada, porque e no app que
// ele esta quando descobre que falta proxy.
//
// Quem segura o vendedor NAO e esconder o formulario, e o servidor: o POST /api/swweb/proxy recusa
// com 403 quem nao manda na operacao, e recusa chip de outro mundo. A tela aqui so mostra o que o
// servidor ja deixaria fazer.
ipcMain.handle('sw:proxy-salvar', async (_e, { nk, host, porta, usuario, senha }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.' }
  const chave = numKey(nk)
  if (!chave) return { ok: false, erro: 'Número inválido.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ nk: chave, host: String(host || ''), porta: Number(porta) || 0, usuario: String(usuario || ''), senha: String(senha || '') }),
      signal: AbortSignal.timeout(20000),
    })
    ajustaRelogio(r)
    const d = await r.json().catch(() => null)
    if (!r.ok) {
      return { ok: false, erro: (d && (d.error || d.erro)) || (r.status === 403 ? 'Só a direção cadastra proxy.' : 'A dash respondeu ' + r.status) }
    }
    // Busca de volta pra copia local ficar igual ao servidor na hora, sem esperar o proximo ciclo.
    await puxaProxyDaDash(chave)
    return { ok: true, apagou: !String(host || '').trim() }
  } catch (_) {
    return { ok: false, erro: 'Não deu pra falar com a dash.' }
  }
})

// CONTA PRA DASH POR ONDE A PROXY SAIU (17/10/2026, banco de proxies).
//
// QUEM MEDE E QUEM USA, e por isso o deposito nasce aqui: o worker roda na borda da Cloudflare e
// sairia pela rede DELA, nao pela do vendedor - testar de la nao diria nada sobre a proxy deste PC.
// O app ja faz esse teste de verdade (testaSaida) toda vez que abre um numero e toda vez que o
// Bruno aperta Testar; isto so manda o resultado.
//
// POR QUE IMPORTA: sem deposito, a proxy fica pra sempre como "nunca testada" na tela do banco - e
// "nunca testada" numa lista onde o resto esta verde e exatamente a linha que o olho pula. A proxy
// recem cadastrada e a mais provavel de estar errada, e e a que mais precisa aparecer.
//
// NAO SEGURA NADA e nao avisa erro: e informacao de tela. Falhou, a proxima abertura tenta.
async function contaPais(nk, pais) {
  if (!config.token || !nk) return
  try {
    await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/proxy-visto', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ nk: String(nk), pais: String(pais || '') }),
      signal: AbortSignal.timeout(10000),
    })
  } catch (_) { /* informacao de tela: a proxima abertura conta de novo */ }
}

ipcMain.handle('sw:proxy-testar', async (_e, { nk }) => {
  const busca = await puxaProxyDaDash(nk)
  const px = proxyDoNumero(nk)
  if (!px) {
    if (busca.rede) return { ok: false, erro: 'Não deu pra falar com a dash pra pegar o proxy deste número.' }
    return { ok: false, erro: 'Sem proxy cadastrado pra este número. Cadastre na dash.' }
  }
  // PARTICAO DESCARTAVEL: testar na particao viva aplicaria o proxy numa sessao ja aberta.
  const teste = 'persist:sw-teste-' + nk
  await aplicaProxy(session.fromPartition(teste), px, teste)
  const r = await testaSaida(teste)
  await aplicaProxy(session.fromPartition(teste), null, teste)
  // Testar na mao e o caminho mais rapido pra proxy nova sair de "nunca testada": ele cadastra,
  // aperta Testar, e a lista do banco ja mostra o pais.
  if (r && r.ok) contaPais(nk, r.pais)
  return r
})

// O `sw:trava` SAIU (17/10/2026). Ele era o cano que ligava e desligava as duas travas no
// servidor, e nao existe mais o que ligar: TRAVA_PROXY e EXIGE_BRASIL sao constantes aqui em cima.
// Deixar o canal aberto sem tela nenhuma chamando ele seria um jeito de desligar a regra que o
// Bruno acabou de pedir pra ser incondicional - escondido, e por isso pior.
// O POST /api/swweb/config continua no worker, recusando desligar com uma frase que diz o porque:
// a v1.18.0 esta instalada e ainda tem os dois interruptores na tela.

// ── IPC DO PAINEL (vem de dentro da pagina do WhatsApp, pela ponte do preload-wa.js)
ipcMain.handle('swp:roteiro', async () => {
  const r = await pegaRoteiro(false)
  if (!r) return { ok: false }
  // O TOKEN DE INGESTAO NAO DESCE PRO PAINEL. Ele roda no mesmo mundo da pagina do WhatsApp; se
  // vazar dali, da pra injetar venda falsa (comissao e pixel). A captura sobe por IPC e quem
  // posta e o processo principal.
  return { ok: true, messages: r.messages, sequences: r.sequences, media: r.media, mediaBase: r.mediaBase }
})

// O painel pergunta o estado e manda item pela view do numero que esta na tela. Quem executa de
// verdade e o agente, dentro da pagina: aqui so se faz a travessia.
function viewAtiva() {
  const s = ativoAgora && abertos.get(ativoAgora)
  if (!s || !s.view || s.view.webContents.isDestroyed()) return null
  return s.view.webContents
}

const ESTADO_VAZIO = { motor: false, autenticado: false, envia: false, chatId: '', phone: '', nome: '', eu: '', trocado: '', grupo: 0 }

ipcMain.handle('swp:estado-wa', async (ev) => {
  // DE QUEM E ESTE PAINEL. Era `viewAtiva()` + `ativoAgora`, ou seja a resposta vinha do numero que
  // esta na tela da PRINCIPAL - com dois paineis, o da janela destacada mostraria a conversa, o
  // nome e o telefone do numero errado, e o funil disparado la sairia pelo chip errado.
  const nkAtual = nkDoPainel(ev && ev.sender)
  const sa = nkAtual && abertos.get(nkAtual)
  const wc = sa && sa.view && !sa.view.webContents.isDestroyed() ? sa.view.webContents : null
  if (!wc) return { ...ESTADO_VAZIO }
  let e
  try { e = await wc.executeJavaScript('window.__swEstado ? window.__swEstado() : null') } catch (_) { e = null }
  if (!e) return { ...ESTADO_VAZIO }
  // O NUMERO PAREADO E O MESMO DO SLOT? (16/10/2026, revisao adversarial.)
  // Se o vendedor ler o QR do slot (15) 97407-6200 com OUTRO aparelho, a barra continua dizendo
  // (15), o proxy usado continua sendo o do (15) e a captura sai carimbada com o numero de verdade.
  // A dash e o app passam a discordar do que esta acontecendo, em silencio. Melhor gritar.
  const esperado = nkAtual
  const real = numKey(e.eu || '')
  // MANDA O NUMERO CHEIO, nao a chave de 10 digitos: a chave formatada como telefone perde o nono
  // digito e mostra um numero que nao existe.
  e.trocado = (real && esperado && real !== esperado) ? String(e.eu || '') : ''
  if (e.trocado) console.error('[slot] ' + esperado + ' esta pareado com ' + real)
  e.nk = nkAtual
  return e
})

// A MIDIA E BAIXADA AQUI, NAO NA PAGINA.
//
// A CSP do web.whatsapp.com tem connect-src que nao inclui os nossos dominios, entao um fetch pra
// /api/salechat/media/... de dentro da pagina e bloqueado pelo navegador. O processo principal nao
// passa por CSP nem por CORS: ele baixa, vira dataUri e manda pronto junto do item.
// Cacheado porque o mesmo audio e usado o dia inteiro, em todos os leads.
const cacheMidia = new Map()
const TETO_MIDIA = 32 * 1024 * 1024   // 32 MB: acima disso o WhatsApp recusa de qualquer jeito
async function dataUriDe(url) {
  if (cacheMidia.has(url)) return cacheMidia.get(url)
  // PRAZO E TETO. Sem prazo, o fetch do Node fica pendurado por ate 5 minutos quando a rede ou o
  // R2 engasgam: o funil trava no meio, o botao Parar nao resolve (ele so e olhado ENTRE itens) e
  // o vendedor fica olhando pra tela sem saber o que houve.
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) })
  if (!r.ok) throw new Error('o arquivo respondeu ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('o arquivo veio vazio')
  if (buf.length > TETO_MIDIA) throw new Error('o arquivo tem ' + Math.round(buf.length / 1048576) + ' MB, grande demais')
  // O TIPO VAI SEM PARAMETRO, E ESSA LINHA E O CONSERTO DO FUNIL QUE NAO ENVIAVA (16/10/2026).
  //
  // O R2 devolve `audio/ogg; codecs=opus` nos audios do Sale Chat. Jogando isso inteiro numa URL de
  // dados sai `data:audio/ogg; codecs=opus;base64,...`, que e INVALIDA por causa do espaco - e o
  // WhatsApp recusa com `invalid_data_url`, que foi exatamente o que apareceu no rodape do Bruno:
  // "parou no item 1 de 2: invalid_data_url". Todo funil com audio morria no primeiro passo.
  //
  // Guardei um dia cacando isso no lugar errado (achei que era o indicador de "gravando"). O que
  // fechou foi a FRASE DO RODAPE: `invalid_data_url` aponta pro conteudo, nao pro fluxo.
  //
  // Fica so `tipo/subtipo`. Os parametros nao servem pra nada aqui: quem decide o formato do audio
  // enviado e o proprio WhatsApp, pelo `isPtt`.
  const tipoCru = r.headers.get('content-type') || 'application/octet-stream'
  const tipo = String(tipoCru).split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  // SO CACHEIA O QUE PASSOU. Guardar um resultado ruim grudava o erro na sessao inteira.
  const uri = 'data:' + tipo + ';base64,' + buf.toString('base64')
  // E CONFERE ANTES DE ENTREGAR. Um content-type esquisito nunca mais vira URL invalida chegando
  // na pagina como erro tecnico: morre aqui, com nome.
  if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(uri)) {
    throw new Error('o arquivo veio com tipo estranho (' + tipoCru + ')')
  }
  // TETO EM BYTES, nao so em contagem. 120 itens de ate 32 MB dariam quase 4 GB de dataUri vivo
  // na memoria do processo principal - e um roteiro com video de oferta chega perto disso.
  cacheMidia.set(url, uri)
  let pesoCache = 0
  for (const v of cacheMidia.values()) pesoCache += v.length
  if (cacheMidia.size > 120 || pesoCache > 120 * 1024 * 1024) {
    cacheMidia.clear()
    cacheMidia.set(url, uri)   // o que acabou de ser pedido fica: e o que vai ser usado agora
  }
  return uri
}

// "DIGITANDO..." NA CONVERSA, sem bloquear ninguem. Quem conta o tempo e o painel.
// O QUE ESTA SAINDO AGORA, POR NUMERO.
//
// O main.js nao sabe nada de funil: quem sabe e o painel, que avisa ao entrar e ao sair. Aqui e so
// o REGISTRO - e e por isso que ele mora aqui e nao la: a hibernacao por memoria precisa saber pra
// nao fechar a sessao no meio do disparo, e a aba de Pedidos precisa mostrar o que esta saindo nos
// OUTROS numeros, que o painel da vez nao tem como saber sozinho.
//
// LIMITE DE HOJE, e vale escrito: o painel e UMA janela so pra todos os numeros e trava em
// `ocupado` enquanto um funil roda, entao na pratica esta lista tem 0 ou 1 item. Ela ja nasce como
// LISTA de proposito - no dia em que o painel rodar funil por numero, nada aqui muda.
const disparos = new Map()   // nk -> { funil, passo, total, alvo, inicio }
let disparandoNk = ''

function avisaPainel(canal, dados) {
  // TODOS OS PAINEIS, nao so o da principal: a pilha de disparos da janela destacada tambem precisa
  // saber o que esta saindo nos outros numeros.
  try { if (painel && !painel.webContents.isDestroyed()) painel.webContents.send(canal, dados) } catch (_) { /* ok */ }
  for (const d of destacados.values()) {
    try { if (d.painel && !d.painel.webContents.isDestroyed()) d.painel.webContents.send(canal, dados) } catch (_) { /* ok */ }
  }
}

ipcMain.handle('swp:disparo', (e, d) => {
  const nk = String((d && d.nk) || '')
  const quem = e && e.sender ? e.sender.id : 0
  if (d && d.ligado) {
    // UM DONO POR NUMERO. Se outro painel ja esta disparando neste nk, este NAO entra: o laco de
    // la recebe a recusa e para antes do primeiro item, em vez de intercalar mensagens na conversa
    // que o outro esta conduzindo. Mesmo painel reentrando no mesmo nk (o passo seguinte do mesmo
    // funil) passa, que e o caso normal.
    const dono = disparos.get(nk)
    if (dono && dono.quem && dono.quem !== quem) {
      return { ok: false, erro: 'esse número já está disparando na outra janela' }
    }
    disparos.set(nk, {
      funil: String((d && d.funil) || ''),
      passo: Number(d && d.passo) || 0,
      total: Number(d && d.total) || 0,
      alvo: String((d && d.alvo) || ''),
      inicio: Number(d && d.inicio) || Date.now(),
      quem,
    })
    disparandoNk = nk
  } else {
    // SO O DONO SOLTA. Sem isto, o painel que foi recusado derrubaria o arrendamento do outro ao
    // terminar o proprio job, e a protecao da hibernacao cairia junto no meio do funil alheio.
    const dono = disparos.get(nk)
    if (!dono || !dono.quem || dono.quem === quem) {
      disparos.delete(nk)
      if (disparandoNk === nk) disparandoNk = ''
    }
  }
  avisaPainel('swp:disparos-mudou', { n: disparos.size })
  return { ok: true }
})

// O nome e o dono saem da lista que a dash ja mandou: o painel nao precisa saber de cadastro.
ipcMain.handle('swp:disparos', () => ({
  ok: true,
  itens: [...disparos].map(([nk, d]) => {
    const n = (config.numeros || []).find((x) => x && numKey(x.numero) === nk) || {}
    const { quem, ...resto } = d          // `quem` e id de renderer: nao sai daqui
    return { nk, numero: n.numero || '', dono: n.dono || '', ...resto }
  }),
}))

// O PARAR CHEGA NA PAGINA. A espera do passo agora acontece DENTRO da pagina (igual ao Sale Chat
// que roda em producao), entao o botao Parar precisa alcancar la: ele liga uma bandeirinha que o
// `esperaOuPara` confere a cada 400ms.
ipcMain.handle('swp:parar', async (_e, { nk, parar }) => {
  const alvo = String(nk || '') ? abertos.get(String(nk)) : null
  const wc = alvo && alvo.view && !alvo.view.webContents.isDestroyed() ? alvo.view.webContents : (nk ? null : viewAtiva())
  if (!wc) return { ok: false }
  try { await wc.executeJavaScript('window.__swParar = ' + (parar ? 'true' : 'false') + '; true') } catch (_) { /* ok */ }
  return { ok: true }
})

ipcMain.handle('swp:indica', async (_e, { nk, chatId, kind, seg }) => {
  const alvo = String(nk || '') ? abertos.get(String(nk)) : null
  const wc = alvo && alvo.view && !alvo.view.webContents.isDestroyed() ? alvo.view.webContents : (nk ? null : viewAtiva())
  if (!wc) return { ok: false }
  try {
    // PRAZO CURTO E DE PROPOSITO. Este caminho e enfeite: se a pagina engasgar, o funil nao pode
    // ficar esperando por ele. Estourou, segue - a pausa e o envio acontecem do mesmo jeito.
    const r = await Promise.race([
      wc.executeJavaScript(
        'window.__swIndica ? window.__swIndica(' + JSON.stringify(String(chatId || '')) + ','
        + JSON.stringify(String(kind || '')) + ',' + JSON.stringify(Math.max(0, Number(seg) || 0) * 1000) + ') : false', true
      ),
      new Promise((ok) => setTimeout(() => ok(false), 3000)),
    ])
    return { ok: !!r }
  } catch (_) { return { ok: false } }
})

ipcMain.handle('swp:manda', async (_e, { nk, chatId, item }) => {
  // O ENVIO VAI PRA VIEW DAQUELE NUMERO, nao pra "a que esta na tela".
  //
  // O funil dura dezenas de segundos (tem pausa e simulacao de digitando). Se o vendedor clicasse
  // noutro numero no meio, os passos seguintes saiam pelo OUTRO chip, pro mesmo lead: metade da
  // conversa de um numero, metade de outro, e a atribuicao da venda quebrada.
  const alvo = String(nk || '') ? abertos.get(String(nk)) : null
  const wc = alvo && alvo.view && !alvo.view.webContents.isDestroyed() ? alvo.view.webContents : (nk ? null : viewAtiva())
  if (!wc) return { ok: false, erro: nk ? 'o número foi fechado, o funil parou aqui' : 'nenhum número aberto' }
  const pedaco = { ...(item || {}) }
  if (pedaco.tipo === 'midia') {
    if (!pedaco.url) return { ok: false, erro: 'esse item nao tem arquivo' }
    try { pedaco.dataUri = await dataUriDe(pedaco.url) }
    catch (e) { return { ok: false, erro: 'nao baixei a midia: ' + ((e && e.message) || e) } }
    delete pedaco.url
  }
  try {
    const r = await wc.executeJavaScript(
      'window.__swManda(' + JSON.stringify(String(chatId || '')) + ',' + JSON.stringify(pedaco) + ')', true
    )
    return { ok: !!r }
  } catch (e) {
    return { ok: false, erro: String((e && e.message) || e).replace(/^Error:\s*/, '').slice(0, 160) }
  }
})

// Fechar e recarregar a sessao que esta na tela, pelo proprio painel: e onde a mao do vendedor ja
// esta. A sessao fica no disco, entao fechar NAO pede QR de novo depois.
// A BARRA ENCOLHE E VOLTA. Guarda na configuracao, igual ao painel: se ele encolheu, e porque
// quer assim, e reabrir o app com ela larga de novo seria desfazer a escolha dele todo dia.
ipcMain.handle('sw:barra', (_e, { encolhida }) => {
  config.barraEncolhida = !!encolhida
  gravarConfig()
  reposiciona()
  return { ok: true, encolhida: !!config.barraEncolhida }
})

ipcMain.handle('swp:painel', (_e, { ligado }) => {
  painelLigado = ligado !== false
  if (config.painelLigado !== painelLigado) { config.painelLigado = painelLigado; gravarConfig() }
  reposiciona()
  return { ok: true, ligado: painelLigado }
})

ipcMain.handle('swp:fechar-ativo', (ev) => {
  const nk = nkDoPainel(ev && ev.sender)
  if (nk) fechaNumero(nk)        // se estiver destacado, o fechaNumero derruba a janela junto
  return { ok: true }
})
ipcMain.handle('swp:recarregar-ativo', (ev) => {
  const nk = nkDoPainel(ev && ev.sender)
  const s = nk && abertos.get(nk)
  if (s && !s.view.webContents.isDestroyed()) s.view.webContents.reload()
  return { ok: true }
})

// "NAO ACHEI O LEAD" E "NAO FALEI COM A DASH" SAO COISAS DIFERENTES.
//
// Os dois devolviam {ok:true, achou:false}, e o painel escrevia "sem pedido na dash". Com a
// internet oscilando, um cliente com tres pedidos aparecia como lead novo e o vendedor repetia a
// oferta de entrada. Pior: o painel guarda o ultimo telefone consultado e nao tentava de novo,
// entao a linha continuava mentindo depois que a dash voltava.
// ────────────────────────────────────────────────────────────────────────────────────────────
// PEDIDO PELO PROPRIO APP (16/10/2026, pedido do Bruno: o vendedor cadastra o pedido do cliente que
// esta na conversa, e o que nao terminar fica em rascunho).
//
// O APP NAO INVENTA CAMINHO NOVO. O cadastro usa a MESMA rota que o Novo Pedido da dash usa
// (POST /api/pedido/novo): o pedido vira CARD e cai em Aceitacoes, e quem cria de verdade na PayLog
// continua sendo o botao Aceitar. Isso nao e detalhe de arquitetura, e dinheiro: o Aceitar tem
// anti-dobro por CPF, conferencia dupla e trava de aceite, e a API da PayLog NAO tem idempotencia -
// pedido em dobro la nao tem desfazer barato. Qualquer atalho daqui pulava os tres portoes.
//
// Quem recorta por cargo e o servidor (`_stateProtegido` devolve 403 "Seu cargo nao cadastra
// pedido"), entao nao ha regra de permissao escrita aqui pra envelhecer.
ipcMain.handle('swp:pedido-novo', async (_e, { lead }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.' }
  if (!lead || typeof lead !== 'object') return { ok: false, erro: 'Pedido vazio.' }
  // NO PREVIEW NAO SE CADASTRA PEDIDO. A dash ja barra isso no createOrder, com a mesma frase, e o
  // motivo e o mesmo: a LEITURA responde como a outra pessoa, mas a GRAVACAO acontece como voce.
  // Cadastrar olhando a tela dela e gravando no seu nome e o jeito de criar pedido no dono errado.
  if (comoId) return { ok: false, erro: 'Você está vendo como outra pessoa. Volte a ser você para cadastrar.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/pedido/novo', {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify({ lead }), signal: AbortSignal.timeout(30000),
    })
    ajustaRelogio(r)
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('a dash respondeu ' + r.status) }
    return { ok: true, id: d && d.id, ja: !!(d && d.ja) }
  } catch (_) { return { ok: false, erro: 'não deu pra falar com a dash' } }
})

// RASCUNHO: guardado no SERVIDOR, nao no disco desta maquina.
//
// O de hoje na dash vive no localStorage e o proprio arquivo avisa que "some se trocar de maquina".
// Aqui isso seria pior: o vendedor comeca o pedido no app e termina na dash, ou troca de PC, e o
// trabalho sumiria sem aviso. Fica numa tabela propria (nunca no blob do estado, que tem teto e
// perde chave nova quando outra tela regrava).
// A LISTA DE TRATAMENTO, com o PRECO, pro app nao deixar digitar nenhum dos dois.
//
// Na dash o tratamento e SEMPRE escolhido de uma lista cadastrada e o valor vem do catalogo, so
// leitura - decisao do Bruno em 14/08/2026. O motivo esta escrito no novo-pedido.jsx e e de
// dinheiro: preco digitado a mao diverge do catalogo e contamina receita, comissao e margem sem
// ninguem ver de onde veio. O app nascia com "Produto / kit" em texto livre e "Valor" digitado, ou
// seja deixava cadastrar pelo celular do vendedor um pedido que a propria dash recusaria.
//
// Quem monta a lista e o SERVIDOR (GET /api/swweb/tratamentos), juntando o que ja vendeu com o
// catalogo cadastrado - a mesma dupla fonte da dash, numa conta so, pra nao existirem dois
// catalogos. Guardado em memoria por 10 minutos: o vendedor abre essa aba dezenas de vezes por dia
// e o catalogo muda uma vez por semana.
let tratCache = { t: 0, lista: [] }
ipcMain.handle('swp:tratamentos', async () => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.', offers: [] }
  if (tratCache.lista.length && Date.now() - tratCache.t < 600000) return { ok: true, offers: tratCache.lista }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/tratamentos' + comoNaUrl(),
      { headers: cabecalhos(), signal: AbortSignal.timeout(20000) })
    ajustaRelogio(r)
    if (!r.ok) return { ok: false, erro: 'a dash respondeu ' + r.status, offers: tratCache.lista }
    const d = await r.json()
    const lista = Array.isArray(d && d.offers) ? d.offers : []
    // SO GUARDA LISTA CHEIA. Guardar uma resposta vazia (dash engasgada, catalogo ainda carregando)
    // deixaria o vendedor dez minutos sem conseguir escolher tratamento nenhum.
    if (lista.length) tratCache = { t: Date.now(), lista }
    return { ok: true, offers: lista }
  } catch (_) {
    return { ok: false, erro: 'não deu pra falar com a dash', offers: tratCache.lista }
  }
})

// O COMPROVANTE. Na dash ele e OBRIGATORIO quando o pedido e na entrega (COD), e pedido sem anexo
// chega capenga na fila de Aceitacoes do Bruno.
//
// OS BYTES SOBEM DAQUI, nao da tela: o processo principal nao passa por CSP nem por CORS, e o
// arquivo vai DIRETO pro corpo da requisicao - sem base64, que incharia um video de 9 MB pra 12 e
// ainda passaria duas vezes pela memoria.
// ─── BUSCA DE CEP (16/10/2026) ───────────────────────────────────────────────────────────────
//
// GEMEO do axion-produtor/src/lib/cep.js: mexeu num, mexe no outro. Esta aqui, no processo
// principal, porque a pagina do painel roda com `default-src 'none'` e nao pode falar com a rede -
// e porque assim o cache vale pros N numeros abertos, em vez de um por janela.
//
// TRES FONTES EM PARALELO, e sao tres por medicao, nao por chute (06/10/2026, na dash):
//   BrasilAPI 128ms (agrega Correios, a mais completa) · OpenCEP 180ms · ViaCEP 472ms (a menos).
// O caso que decidiu: o CEP 99999-999 existe de verdade e a ViaCEP responde "erro" nele. Sozinha,
// ela reprovaria um pedido bom.
//
// FONTE FORA DO AR NUNCA VIRA "CEP INVALIDO": so e invalido quando TODAS as que responderam
// disseram que nao existe. Nao da pra reprovar o pedido de um cliente porque a internet de
// terceiro caiu.
const _cepCache = new Map()
const _cepLimpa = (r) => ({
  end: String(r.end || '').trim(), bairro: String(r.bairro || '').trim(),
  cidade: String(r.cidade || '').trim(), uf: String(r.uf || '').trim().toUpperCase().slice(0, 2),
})
const _cepNota = (d) => {
  if (!d || !d.cidade) return 0
  if (d.end && d.bairro) return 3
  if (d.end || d.bairro) return 2
  return 1
}
// O `fetch` AQUI E O DO NODE, DE PROPOSITO, e trocar por `net.fetch` quebra a busca inteira.
//
// O BUG QUE ISTO CONSERTA (17/10/2026): o Bruno digitava os oito digitos e o campo ficava girando
// pra sempre, sem endereco e sem erro. O `net.fetch` do Electron sai pela SESSAO PADRAO, e a sessao
// padrao deste app esta num buraco negro de proxy DE PROPOSITO (nenhuma pagina fala com a rede sem
// passar pelo proxy do numero), entao as tres bases de CEP morriam em ERR_PROXY e as tres viravam
// `falhou` - resultado identico ao de um CEP que ninguem respondeu, e a tela nao tinha o que dizer.
//
// O `fetch` global vem do undici do Node e nao passa por sessao nenhuma, que e o que se quer aqui:
// consultar CEP e assunto do APP, nao do numero do vendedor. As outras dez chamadas de rede deste
// arquivo ja usavam ele; esta era a unica fora do padrao.
//
// ARMADILHA IRMA, pra nao cair de novo: passar `{ session }` pro `net.fetch` NAO DA ERRO - a
// assinatura dele so tem `bypassCustomProtocolHandlers` e o campo e ignorado em silencio. Quem
// respeita sessao e `ses.fetch` (foi assim que a previa de midia foi consertada no mesmo dia).
async function _cepBusca(url, ms = 7000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  return r
}
const _cepFontes = [
  async (c) => {
    const r = await _cepBusca('https://brasilapi.com.br/api/cep/v2/' + c)
    if (r.status === 404) return { naoAchou: true }
    if (!r.ok) return { falhou: true }
    const d = await r.json()
    // Quando as bases internas dela falham, ela responde 200 com um objeto de ERRO.
    if (d && d.name === 'CepPromiseError') return { naoAchou: true }
    return _cepLimpa({ end: d.street, bairro: d.neighborhood, cidade: d.city, uf: d.state })
  },
  async (c) => {
    const r = await _cepBusca('https://opencep.com/v1/' + c)
    if (r.status === 404) return { naoAchou: true }
    if (!r.ok) return { falhou: true }
    const d = await r.json()
    if (d && d.error) return { naoAchou: true }
    return _cepLimpa({ end: d.logradouro, bairro: d.bairro, cidade: d.localidade, uf: d.uf })
  },
  async (c) => {
    const r = await _cepBusca('https://viacep.com.br/ws/' + c + '/json/')
    if (!r.ok) return { falhou: true }
    const d = await r.json()
    if (d.erro) return { naoAchou: true }
    return _cepLimpa({ end: d.logradouro, bairro: d.bairro, cidade: d.localidade, uf: d.uf })
  },
]
async function buscaCep(cep) {
  const c = String(cep || '').replace(/\D/g, '')
  if (c.length !== 8) return { achou: false, invalido: false, dados: null, completo: false, respondeu: false }
  if (_cepCache.has(c)) return _cepCache.get(c)
  // CEP DO BRASIL COMECA EM 01000-000. Prefixo 00 nao existe, entao 00000-000 e digitacao e nao o
  // CEP geral de uma cidade - sem esta linha a regra do 000 abaixo o daria por valido.
  if (c.slice(0, 2) === '00') {
    const ruim = { achou: false, invalido: true, dados: null, completo: false, respondeu: true }
    _cepCache.set(c, ruim)
    return ruim
  }
  // CEP TERMINADO EM 000 e o CEP geral da cidade: SEMPRE considerado real. O que vem dele varia
  // (um traz rua, outro so bairro e cidade), entao quem decide o que travar na tela e o campo que
  // voltou preenchido, um por um, nunca o formato do CEP.
  const geral = c.endsWith('000')
  let melhor = null, naoAchou = 0, responderam = 0

  // CORRIDA, NAO Promise.all - identica a da dash (cep.js:102-119).
  //
  // O QUE O Promise.all CUSTAVA: ele so devolve quando as TRES acabam, entao quem mandava no tempo
  // era a ViaCEP, a mais lenta e a menos completa (medido na dash: BrasilAPI 128ms, OpenCEP 180ms,
  // ViaCEP 472ms). Se ela pendurasse, o campo girava os 7 segundos inteiros COM O ENDERECO CERTO JA
  // NA MEMORIA. Resposta completa encerra: esperar as outras pra chegar na mesma coisa e so espera.
  await new Promise((pronto) => {
    let faltam = _cepFontes.length
    let acabou = false
    const fim = () => { if (!acabou) { acabou = true; pronto() } }
    for (const fonte of _cepFontes) {
      fonte(c)
        .then((r) => {
          if (!r || r.falhou) return
          responderam += 1
          if (r.naoAchou) { naoAchou += 1; return }
          if (_cepNota(r) > _cepNota(melhor)) melhor = r
          if (_cepNota(melhor) === 3) fim()
        })
        .catch(() => { /* fonte fora do ar: as outras seguem */ })
        .finally(() => { if (--faltam === 0) fim() })
    }
  })

  const saida = {
    achou: !!melhor,
    // DUAS FONTES PRECISAM DIZER QUE NAO EXISTE, a regra da dash (cep.js:123-125). A regra antiga
    // daqui era "todas as que responderam disseram que nao", e com UMA respondendo (as outras duas
    // fora do ar) isso dava CEP INVALIDO: um 404 solto de uma base ruim barrava o pedido de um
    // cliente de verdade, e o vendedor nao tinha como cadastrar.
    invalido: !melhor && !geral && naoAchou >= 2,
    dados: melhor,
    completo: _cepNota(melhor) === 3,
    // ALGUMA BASE RESPONDEU? Sem este campo, "as bases disseram que nao tem" e "ninguem respondeu"
    // chegavam na tela como a mesma coisa (achou: false, invalido: false), e a tela so podia chutar
    // um dos dois recados. Medido em 17/10/2026: NENHUMA das tres bases conhece CEP terminado em
    // 000, nem 01000-000 nem 13000-000, entao esse caso acontece todo dia e nao e falha de rede.
    respondeu: responderam > 0,
  }
  // SO GUARDA O QUE DEU CERTO, tambem igual a dash (cep.js:126-131). Guardar a recusa junto
  // PRENDIA o pedido: o "tentar de novo" relia o cache e devolvia na hora a MESMA recusa, ou seja o
  // botao de tentar de novo nao tentava de novo. Recusa quase sempre e rede de terceiro oscilando,
  // que e exatamente o caso em que repetir resolve. (O prefixo 00 acima continua em cache: aquele e
  // decidido sem sair da maquina e nao muda nunca.)
  if (saida.achou) _cepCache.set(c, saida)
  return saida
}
// FIM DA BUSCA DE CEP. Esta linha e MARCA DE TESTE: o src/teste-cep.js recorta o bloco daqui pra
// cima e roda o codigo de verdade contra as bases. Nao apague.
// ─── fim-busca-cep ───────────────────────────────────────────────────────────────────────────
// O PRINT DA AREA DE TRANSFERENCIA (17/10/2026, pedido do Bruno). Depois que o cliente aceita o
// termo, o vendedor da um print e ele fica na area de transferencia; anexar sem salvar arquivo no PC
// e o caminho mais curto, e e o que a dash ja faz com Ctrl+V.
//
// LIDO AQUI E NAO NA PAGINA: o painel roda em file://, onde o `navigator.clipboard.read()` depende
// de permissao e falha calado. O `clipboard` do Electron le direto, sem pedir nada a ninguem.
ipcMain.handle('swp:cola-print', async () => {
  try {
    const img = clipboard.readImage()
    if (!img || img.isEmpty()) return { ok: false, vazio: true }
    const png = img.toPNG()
    if (!png || !png.length) return { ok: false, vazio: true }
    return { ok: true, bytes: new Uint8Array(png), mime: 'image/png', nome: 'print.png' }
  } catch (e) { anota('[colar] ' + (e && e.message)); return { ok: false, erro: String((e && e.message) || 'não li a área de transferência') } }
})

ipcMain.handle('swp:cep', async (_e, { cep }) => {
  try { return { ok: true, ...(await buscaCep(cep)) } }
  catch (e) { anota('[cep] ' + (e && e.message)); return { ok: false, achou: false, invalido: false, dados: null } }
})

// ABRE O DOCUMENTO NO PROGRAMA DO WINDOWS. A pagina manda so a CHAVE; quem monta o endereco e
// aqui, e a mesma conferencia do protocolo swmedia vale: chave que nao e de midia nao abre nada.
// Sem ela, um `shell.openExternal` com texto vindo da pagina abriria qualquer coisa.
// ABRE O DOCUMENTO DENTRO DO APP (17/10/2026). Antes ia pro navegador por `shell.openExternal`,
// e ele foi direto ao ponto: "gostaria de ver pelo proprio aplicativo". Mandar pro navegador tambem
// tirava o documento da sessao do painel - abria no Chrome do Windows, logado com outra conta, com
// a janela do app perdendo o foco no meio do atendimento.
//
// A janela e FILHA da janela do app e usa a particao do painel, que e onde o `swmedia://` existe e
// onde a saida e direta. O visualizador e o do proprio Chromium (ver `plugins: true` no painel).
let janelaDoc = null
ipcMain.handle('swp:abrir-midia', async (_e, { chave, titulo }) => {
  const k = String(chave || '')
  if (!/^m\/[A-Za-z0-9._-]+$/.test(k)) return { ok: false, erro: 'chave inválida' }
  const url = 'swmedia://arq/' + encodeURIComponent(k)
  try {
    // UMA JANELA SO, reaproveitada: abrir o mesmo certificado cinco vezes nao pode virar cinco
    // janelas empilhadas em cima do WhatsApp.
    if (janelaDoc && !janelaDoc.isDestroyed()) {
      janelaDoc.setTitle(String(titulo || 'Documento'))
      await janelaDoc.webContents.loadURL(url)
      janelaDoc.show(); janelaDoc.focus()
      return { ok: true }
    }
    const { BrowserWindow } = require('electron')
    janelaDoc = new BrowserWindow({
      width: 900, height: 860, parent: janela || undefined,
      title: String(titulo || 'Documento'),
      backgroundColor: '#0b0e14',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:sw-painel',   // onde o swmedia existe
        plugins: true,                    // leitor de PDF do Chromium
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    janelaDoc.on('closed', () => { janelaDoc = null })
    // Nada de navegar pra fora daqui: a janela existe pra UM arquivo nosso.
    janelaDoc.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    janelaDoc.webContents.on('will-navigate', (ev, alvo) => { if (!String(alvo).startsWith('swmedia://')) ev.preventDefault() })
    await janelaDoc.webContents.loadURL(url)
    return { ok: true }
  } catch (e) {
    anota('[midia] nao abri ' + k + ': ' + (e && e.message))
    // RESERVA: se o leitor embutido falhar, melhor abrir no navegador do que nao abrir nada.
    try {
      const base = (roteiro && roteiro.mediaBase) || (String(config.apiBase).replace(/\/+$/, '') + '/api/salechat/media/')
      await shell.openExternal(base + k)
      return { ok: true, fora: true }
    } catch (_) { return { ok: false, erro: String((e && e.message) || 'não abriu') } }
  }
})

ipcMain.handle('swp:comprovante', async (_e, { nome, mime, bytes, lead }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.' }
  const tipo = String(mime || '').split(';')[0].trim().toLowerCase()
  if (!/^(image|audio|video)\//.test(tipo)) return { ok: false, erro: 'Só imagem, áudio ou vídeo.' }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || [])
  if (!buf.length) return { ok: false, erro: 'O arquivo veio vazio.' }
  // O teto e o mesmo do servidor (95 MB). Recusar aqui poupa subir 90 MB pra levar erro no fim.
  if (buf.length > 95 * 1024 * 1024) {
    return { ok: false, erro: 'Arquivo de ' + Math.round(buf.length / 1048576) + ' MB. O limite é 95 MB.' }
  }
  const qs = new URLSearchParams({ nome: String(nome || 'comprovante'), lead: String(lead || 'sem') })
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/comprovante?' + qs.toString(), {
      method: 'POST',
      headers: { 'content-type': tipo, Authorization: 'Bearer ' + config.token, 'x-sw-maquina': maquinaId() },
      body: buf,
      // Video de 9 MB numa subida de vendedor pode levar minutos. 5 minutos e folgado e ainda solta
      // conexao meia-aberta, que e o que o prazo existe pra pegar.
      signal: AbortSignal.timeout(300000),
    })
    ajustaRelogio(r)
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('a dash respondeu ' + r.status) }
    return { ok: true, url: (d && d.url) || '', mime: (d && d.mime) || tipo }
  } catch (_) {
    return { ok: false, erro: 'não deu pra subir o comprovante' }
  }
})

// FUNIL JA DISPARADO PRO LEAD (18/10/2026). Leitura e carimbo, os dois por telefone.
ipcMain.handle('swp:funis-feitos', async (_e, { fone }) => {
  if (!config.token) return { ok: false, feitos: [] }
  const q = String(fone || '').replace(/\D/g, '')
  if (q.length < 8) return { ok: true, feitos: [] }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/funis-feitos?fone=' + encodeURIComponent(q),
      { headers: cabecalhos(), signal: AbortSignal.timeout(12000) })
    ajustaRelogio(r)
    if (!r.ok) return { ok: false, feitos: [] }
    const d = await r.json()
    return { ok: true, feitos: (d && d.feitos) || [] }
  } catch (_) { return { ok: false, feitos: [] } }
})
ipcMain.handle('swp:funil-feito', async (_e, { fone, seq }) => {
  if (!config.token) return { ok: false }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/funil-feito', {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify({ fone, seq }), signal: AbortSignal.timeout(12000),
    })
    ajustaRelogio(r)
    return { ok: r.ok }
  } catch (_) { return { ok: false } }
})

// A CONVERSA ABERTA PASSA A CONTAR COMO LIDA NA DASH (19/10/2026, item 5 da lista do Bruno).
//
// O vendedor le a mensagem AQUI DENTRO, no WhatsApp de verdade, e a dash nunca ficava sabendo: o app
// nao chamava /api/wa/chat/read em lugar nenhum do projeto, e o `wa_chats.unread` so crescia. Medido
// em producao em 19/10/2026, antes deste conserto: 3.487 conversas com nao lida pendente, 10.037
// somadas, a pior com 245 e 400 paradas assim ha mais de um mes. Com esse numero, o filtro
// "Nao lidas" da dash vira ruido e o contador do topo mente.
//
// Silencioso de proposito: contador atrasado e incomodo, erro na cara do vendedor no meio do
// atendimento e pior. Quem decide se pode marcar e o worker, que confere o dono da conversa.
ipcMain.handle('swp:marcar-lida', async (_e, { phone }) => {
  if (!config.token) return { ok: false }
  const f = String(phone || '').replace(/\D/g, '')
  if (!f) return { ok: false }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/wa/chat/read', {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify({ phone: f }), signal: AbortSignal.timeout(12000),
    })
    ajustaRelogio(r)
    return { ok: r.ok }
  } catch (_) { return { ok: false } }
})

ipcMain.handle('swp:rascunhos', async (_e, { phone }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.', rascunhos: [] }
  try {
    const q = String(phone || '').replace(/\D/g, '')
    // SEM `como` AQUI (18/10/2026). O GET mandava o preview e o POST nao manda (nem poderia): o
    // rascunho era GRAVADO no diretor e BUSCADO no vendedor, entao quem estivesse em "ver como"
    // gravava e nunca mais achava. O worker so aceita preview em GET/HEAD, e esta e a unica rota em
    // que isso vira divergencia de dono. Rascunho e do PROPRIO usuario, sempre.
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/rascunhos'
      + (q.length >= 8 ? '?phone=' + encodeURIComponent(q) : ''),
      { headers: cabecalhos(), signal: AbortSignal.timeout(15000) })
    ajustaRelogio(r)
    if (!r.ok) return { ok: false, erro: 'a dash respondeu ' + r.status, rascunhos: [] }
    const d = await r.json()
    return { ok: true, rascunhos: (d && d.rascunhos) || [] }
  } catch (_) { return { ok: false, erro: 'não deu pra falar com a dash', rascunhos: [] } }
})

ipcMain.handle('swp:rascunho-salvar', async (_e, { id, phone, dados, apagar }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo na dash.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/rascunho', {
      method: 'POST', headers: cabecalhos(),
      body: JSON.stringify(apagar ? { id, apagar: true } : { id, phone, dados }),
      signal: AbortSignal.timeout(15000),
    })
    ajustaRelogio(r)
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('a dash respondeu ' + r.status) }
    return { ok: true, id: (d && d.id) || id }
  } catch (_) { return { ok: false, erro: 'não deu pra falar com a dash' } }
})

ipcMain.handle('swp:lead', async (_e, { phone }) => {
  const fone = String(phone || '').replace(/\D/g, '')
  if (fone.length < 8) return { ok: true, achou: false }
  if (!config.token) return { ok: false, erro: 'entre de novo na dash' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/lead?phone=' + encodeURIComponent(fone)
      + (comoId ? '&como=' + encodeURIComponent(comoId) : ''),
      { headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(15000) })
    ajustaRelogio(r)
    if (r.status === 401 || r.status === 403) return { ok: false, erro: 'entre de novo na dash' }
    if (!r.ok) return { ok: false, erro: 'a dash respondeu ' + r.status }
    return await r.json()
  } catch (_) { return { ok: false, erro: 'não deu pra falar com a dash' } }
})

ipcMain.on('swp:captura', (_e, dados) => {
  const evs = (dados && Array.isArray(dados.eventos)) ? dados.eventos : []
  if (!evs.length) return
  for (const ev of evs) {
    // `velha` E CARIMBADO AQUI, com o relogio corrigido pelo servidor. Ver desvioRelogio.
    if (ev && typeof ev === 'object') ev.velha = ehVelha(ev.ts)
    filaCaptura.push(ev)
  }
  // TETO EM BYTES, nao em eventos. Primeiro larga os ANEXOS mais antigos (a mensagem fica), e so
  // se ainda assim nao couber e que evento inteiro e descartado.
  let peso = pesoDaFila()
  if (peso > TETO_FILA_BYTES) {
    let semAnexo = 0
    for (const ev of filaCaptura) {
      if (peso <= TETO_FILA_BYTES) break
      if (!ev || !ev.mediaB64) continue
      peso -= String(ev.mediaB64).length
      delete ev.mediaB64
      delete ev.mediaMime
      semAnexo++
    }
    if (semAnexo) console.error('[captura] fila cheia: ' + semAnexo + ' anexo(s) antigo(s) descartado(s), as mensagens ficaram')
  }
  // Teto de seguranca final: segura as ultimas 5 mil e descarta as mais velhas, em vez de estourar
  // a memoria do vendedor.
  if (filaCaptura.length > 5000) {
    const perdidas = filaCaptura.length - 5000
    filaCaptura.splice(0, perdidas)
    console.error('[captura] fila cheia: ' + perdidas + ' mensagem(ns) antiga(s) descartada(s)')
  }
  filaSuja = true
  avisaCasca('sw:fila', { n: filaCaptura.length })
  if (filaCaptura.length >= 50) drenaCaptura()
})

// LIGA E DESLIGA A CHEGADA DE LEAD naquele numero.
//
// Vai pela MESMA rota que a Contingencia usa (POST /api/pressel/num), nao por um caminho novo: a
// roleta ja derrubou a operacao antes e nao e lugar pra ter duas implementacoes. O `at` sai da
// lista que o servidor mandou, e o servidor confere de novo que o numero e daquele vendedor.
ipcMain.handle('sw:roleta', async (_e, { nk, on }) => {
  if (!config.token) return { ok: false, erro: 'Entre de novo.' }
  const n = (config.numeros || []).find((x) => numKey(x.numero) === String(nk))
  if (!n || !n.at) return { ok: false, erro: 'Número não encontrado na lista.' }
  try {
    const r = await fetch(String(config.apiBase).replace(/\/+$/, '') + '/api/pressel/num', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ at: n.at, num: n.numero, on: !!on }),
    })
    const d = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, erro: (d && (d.error || d.erro)) || ('A dash respondeu ' + r.status) }
    n.roleta = !!on
    gravarConfig()
    // Puxa a lista de novo pra pegar o estado de verdade (e o placar de leads).
    buscaNumeros().catch(() => {})
    return { ok: true, on: !!on }
  } catch (e) {
    return { ok: false, erro: 'Não deu pra falar com a dash.' }
  }
})

ipcMain.handle('sw:teto', (_e, { maxAbertos }) => {
  const n = Math.max(1, Math.min(20, Number(maxAbertos) || 6))
  config.maxAbertos = n
  gravarConfig()
  hibernaSePrecisar()
  return { ok: true, maxAbertos: n }
})

ipcMain.handle('sw:abrirLog', () => { try { shell.showItemInFolder(ARQ_LOG()) } catch (_) { /* ok */ } return { ok: true } })
// ABRE O INSTALADOR NO NAVEGADOR. O arquivo tem 111 MB: baixar por dentro do app seria uma barra
// de progresso nova pra manter e nenhuma vantagem. O navegador ja sabe fazer isso, e a rota e
// publica de proposito (um <a href> nao manda Authorization).
ipcMain.handle('sw:uso-soltar', async (_e, { nk }) => { await soltaUso(numKey(nk)); return { ok: true } })

ipcMain.handle('sw:abrirInstalador', () => {
  const url = urlInstalador || (String(config.apiBase).replace(/\/+$/, '') + '/api/swweb/instalador')
  try { shell.openExternal(url) } catch (_) { /* ok */ }
  return { ok: true }
})

ipcMain.handle('sw:recarregar', (_e, { nk }) => {
  const s = abertos.get(nk)
  if (s) s.view.webContents.reload()
  return { ok: true }
})

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 9) Ligar

app.whenReady().then(() => {
  lerConfig()
  // Antes de qualquer sessao subir: e o unico momento em que nenhuma particao esta presa.
  try { limpaParticoesVelhas() } catch (e) { anota('[nuvem] limpeza das particoes velhas falhou: ' + ((e && e.message) || e)) }

  // Resolve swmedia://arq/<chave> buscando no mesmo endereco publico que o envio usa.
  //
  // NA SESSAO DO PAINEL, E ISSO E O CONSERTO (17/10/2026). A versao anterior registrava com
  // `protocol.handle(...)` do modulo, que vale pra SESSAO PADRAO - e o painel nao roda nela, roda
  // em `persist:sw-painel`. Resultado: o pedido `swmedia://` do painel nao achava handler nenhum e
  // morria antes de chegar aqui. O vendedor via a foto quebrada, o audio em 0:00 e o video preto, e
  // nada aparecia no log, porque este bloco nunca executava.
  //
  // O TESTE QUE NAO PEGOU ensina mais que o bug: o handler foi provado chamando ele direto, com a
  // midia de verdade, e passou - imagem 200, video 206, audio 200. So que o que estava quebrado nao
  // era o handler, era quem chega nele. Teste de midia tem que RENDERIZAR na particao de verdade.
  //
  // E O `fetch` TAMBEM E DAQUI, pela mesma razao: `net.fetch` sai pela sessao padrao, que esta no
  // buraco negro de proxy de proposito (socks5://127.0.0.1:1, pra nada vazar por engano). Buscar
  // por ali nunca chegaria na API. A sessao do painel esta em `direct`, que e o certo pra ela: a
  // midia e NOSSA, nao e trafego do numero do cliente, e nao pode sair pelo proxy dele.
  try {
    const sesPainel = session.fromPartition('persist:sw-painel')
    sesPainel.protocol.handle('swmedia', async (req) => {
      try {
        const u = new URL(req.url)
        const chave = decodeURIComponent(u.pathname.replace(/^\//, ''))
        // So chave de midia. Sem esta linha, qualquer caminho vira um proxy aberto pra API inteira.
        if (!chave || !/^m\/[A-Za-z0-9._-]+$/.test(chave)) return new Response('', { status: 404 })
        const base = (roteiro && roteiro.mediaBase) || (String(config.apiBase).replace(/\/+$/, '') + '/api/salechat/media/')
        const cab = {}
        const range = req.headers.get('range')
        if (range) cab.range = range            // sem isto o video nao deixa arrastar a barra
        // `sesPainel.fetch`, NAO `net.fetch`: o net.fetch nao aceita sessao (a assinatura dele so
        // tem `bypassCustomProtocolHandlers`) e sai SEMPRE pela padrao, que e o buraco negro. Passar
        // { session } pra ele nao da erro, so e ignorado em silencio - foi assim que a primeira
        // metade deste conserto pareceu funcionar e nao funcionou.
        // bypass ligado: a busca e https e nao pode reentrar no proprio handler.
        return await sesPainel.fetch(base + chave, { headers: cab, bypassCustomProtocolHandlers: true })
      } catch (e) {
        anota('[midia] ' + (e && e.message))
        return new Response('', { status: 502 })
      }
    })
  } catch (e) { anota('[midia] nao registrei o swmedia: ' + (e && e.message)) }
  painelLigado = config.painelLigado !== false
  leFila()

  // EM SEGUNDO PLANO, SEMPRE. Nenhuma das duas segura o boot: sem internet o app abre igual, com a
  // copia do instalador e sem aviso de versao. Esperar rede pra abrir seria trocar "painel da
  // semana passada" por "o app nao abre", que e pior.
  setTimeout(() => { confereVersao(); atualizaAgente() }, 3000)
  setInterval(() => { confereVersao(); atualizaAgente() }, 6 * 60 * 60 * 1000)

  // A sessao PADRAO tambem vai pro buraco negro. Assim, qualquer parte do app que esqueca de usar
  // a particao certa FALHA em vez de vazar o IP real da maquina.
  try {
    session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })
  } catch (_) { /* ok */ }

  // MODO DE TESTE NAO ABRE JANELA NA TELA (16/10/2026). O autoteste e o modo foto rodam o app de
  // verdade, e cada rodada piscava uma janela no monitor de quem estiver usando o computador.
  // O ICONE DA JANELA. No app instalado quem manda e o icone do executavel (electron-builder, ver
  // build/icon.ico e o src/icone.js que gera ele); isto aqui e pro `npm start`, que senao abre com
  // o atomo do Electron. Caminho relativo ao src/, e se o arquivo nao existir o Electron ignora.
  janela = new BaseWindow({
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    // 1180 = barra (268) + painel (316) + 596 pro WhatsApp. Medido: abaixo disso a tela de entrar
    // da Meta corta na direita e o vendedor nao ve o QR inteiro.
    width: 1440, height: 920, minWidth: 1180, minHeight: 680,
    title: 'SellWave Web',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    // O modo FOTO precisa da janela desenhando (capturePage nao funciona em janela escondida),
    // entao so o autoteste roda invisivel. Quem mexer aqui: ver o comentario em foto.js.
    show: process.env.SW_SMOKE !== '1',
  })

  // A casca usa a sessao PROPRIA dela (nao a default, que esta no buraco negro) e fala com a dash
  // pelo processo principal, nunca direto.
  casca = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:sw-casca',
    },
  })
  session.fromPartition('persist:sw-casca').setProxy({ mode: 'direct' })
  janela.contentView.addChildView(casca)
  casca.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'))

  // O PAINEL DE VENDA. Uma view so, reaproveitada por todos os numeros: ela nao guarda estado do
  // WhatsApp, so pergunta pro numero que esta na tela. Fica escondida ate ter numero aberto.
  painel = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-painel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // LIGA O VISUALIZADOR DE PDF do proprio Chromium (17/10/2026, pedido do Bruno: "o documento
      // nao abre, fica so um link pra ver no navegador, eu gostaria de ver pelo proprio
      // aplicativo"). Sem isto, PDF em iframe vira download em vez de pagina.
      // Nao e NPAPI nem Flash: no Chromium de hoje `plugins` liga o leitor de PDF e mais nada.
      plugins: true,
      partition: 'persist:sw-painel',
    },
  })
  session.fromPartition('persist:sw-painel').setProxy({ mode: 'direct' })
  painel.setVisible(false)
  janela.contentView.addChildView(painel)
  painel.webContents.loadFile(path.join(__dirname, 'ui', 'painel.html'))

  reposiciona()

  janela.on('resize', reposiciona)
  janela.on('closed', () => { janela = null })
  // FECHAR NO X ESPERA A NUVEM (ver saiGuardando). Em teste nao: o autoteste fecha o app sozinho.
  janela.on('close', (e) => {
    if (saindoDeVez || EH_TESTE || !config.token || !(abertos.size || despedidas.size)) return
    e.preventDefault()
    saiGuardando().catch(() => { try { app.exit(0) } catch (_) { /* ok */ } })
  })
  // DESLIGAR O WINDOWS COM NUMERO ABERTO (19/10/2026, pedido do Bruno: "contramedidas pra nao perder
  // sessao"). O Windows pergunta antes de encerrar a sessao; segurar aqui faz ele mostrar "o SellWave
  // Web esta impedindo o desligamento" enquanto a nuvem recebe, e o app sai sozinho quando termina.
  // Quem clicar em "Desligar mesmo assim" ganha: queda de luz e desligar a forca nao tem como salvar.
  janela.on('query-session-end', (e) => {
    if (saindoDeVez || EH_TESTE || !config.token || !(abertos.size || despedidas.size)) return
    e.preventDefault()
    anota('[nuvem] o Windows vai encerrar: salvando ' + (abertos.size + despedidas.size) + ' numero(s) antes')
    saiGuardando().catch(() => { try { app.exit(0) } catch (_) { /* ok */ } })
  })
  // TAMPA FECHANDO (suspensao). Nao da tempo de subir nada - a rede cai em segundos -, mas da pra
  // garantir que o disco desta maquina tem tudo: ao voltar, o numero continua de onde parou, e ao
  // fechar ele sobe normalmente.
  try {
    powerMonitor.on('suspend', () => {
      anota('[nuvem] o computador vai suspender: gravando ' + abertos.size + ' sessao(oes) no disco')
      for (const nk of abertos.keys()) salvaSessao(particaoDe(nk))
    })
  } catch (_) { /* sem powerMonitor o app funciona igual */ }

  if (process.argv.includes('--dev')) casca.webContents.openDevTools({ mode: 'detach' })

  // AUTOTESTE (SW_SMOKE=1). Nao entra no app empacotado: so roda quando a variavel esta setada.
  // Existe porque as armadilhas deste projeto falham EM SILENCIO (ver src/smoke.js).
  // FOTO DAS TELAS (SW_FOTO=1), pra conferir o visual sem abrir na mao.
  if (process.env.SW_FOTO === '1') {
    const injeta = async (wc) => {
      try {
        const motor = await pegaMotor()
        if (motor) await wc.executeJavaScript(motor, true)
        await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
        await new Promise((r) => setTimeout(r, 1500))
      } catch (e) { console.error('[foto] injecao falhou: ' + ((e && e.message) || e)) }
    }
    casca.webContents.once('did-finish-load', () => {
      setTimeout(() => require('./foto').rodar({ casca, injeta }), 1200)
    })
  }

  // TESTE DE PONTA A PONTA DA JANELA PROPRIA (SW_JANELA=1). Roda no app DE VERDADE e so finge a
  // pagina da view, que carrega HTML local em vez do WhatsApp Web: sem isso o teste precisaria de
  // chip, proxy e rede, e passaria a medir a internet. Ele ABRE JANELA na tela de proposito -
  // janela escondida nao desenha, e o que esta sendo conferido e quem desenha onde.
  if (process.env.SW_JANELA === '1') {
    casca.webContents.once('did-finish-load', () => {
      setTimeout(() => require('./teste-destaque').rodar({
        janela, abertos, destacados, destaca, devolve, mostra, escondeTodos,
        nkDoPainel, fechaNumero, particaoDe, candidatosHibernacao,
      }).catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) }), 1200)
    })
  }

  if (process.env.SW_SMOKE === '1') {
    // As duas funcoes do caminho REAL do proxy vao junto, pro autoteste exercitar o mesmo
    // codigo que o app usa (incluindo a autenticacao pelo evento app.on('login')).
    // `injeta` deixa o autoteste exercitar o MESMO caminho de injecao que o app usa de verdade.
    const injeta = async (wc) => {
      const out = { wpp: false, agente: false, estado: null, wppErro: '', painelErro: '' }
      try {
        const motor = await pegaMotor()
        if (!motor) { out.wppErro = 'nao baixei o motor'; return out }
        await wc.executeJavaScript(motor, true)
        out.wpp = !!(await wc.executeJavaScript('typeof window.WPP !== "undefined"'))
      } catch (e) { out.wppErro = String((e && e.message) || e).slice(0, 110) }
      try {
        await wc.executeJavaScript(fs.readFileSync(CAMINHO_AGENTE, 'utf8'), true)
        await new Promise((r) => setTimeout(r, 1200))
        out.agente = !!(await wc.executeJavaScript('typeof window.__swEstado === "function" && typeof window.__swManda === "function" && typeof window.__swIndica === "function"'))
        out.estado = await wc.executeJavaScript('window.__swEstado ? window.__swEstado() : null')
      } catch (e) { out.painelErro = String((e && e.message) || e).slice(0, 110) }
      return out
    }
    const ctx = { cascaOk: false, cascaErro: '', temBarra: false, textoBarra: '', modal: '', aplicaProxy, testaSaida, particaoDe, injeta }
    casca.webContents.once('did-finish-load', async () => {
      ctx.cascaOk = true
      try {
        // A marca e a LOGO, nao texto: confere que a imagem carregou de verdade (naturalWidth > 0),
        // porque <img> quebrada tambem existe no DOM e passaria num teste de presenca.
        ctx.textoBarra = String(await casca.webContents.executeJavaScript(
          '(() => { const i = document.querySelector("aside .marca img"); return i ? (i.naturalWidth + "x" + i.naturalHeight) : "sem logo" })()'
        ) || '')
        ctx.temBarra = /^[1-9]\d*x[1-9]\d*$/.test(ctx.textoBarra)
        // AS JANELINHAS ABREM? E o tipo de quebra que nao aparece em teste de sintaxe: ja houve uma
        // versao em que abreModal chamava a si mesma e NENHUM dialogo do app abria.
        ctx.modal = await casca.webContents.executeJavaScript(`(async () => {
          try {
            document.getElementById('ajustes').click()
            await new Promise((r) => setTimeout(r, 250))
            const on = !!document.querySelector('.fundo-modal.on')
            const temTexto = (document.getElementById('modal-corpo') || {}).textContent || ''
            document.onkeydown({ key: 'Escape' })
            return on && temTexto.indexOf('Ajustes') >= 0 ? 'abriu' : ('nao abriu (on=' + on + ')')
          } catch (e) { return 'erro: ' + (e && e.message) }
        })()`).catch((e) => 'erro: ' + (e && e.message))
      } catch (e) { ctx.textoBarra = 'erro: ' + (e && e.message) }
      require('./smoke').rodar(ctx)
    })
    casca.webContents.once('did-fail-load', (_e, code, desc) => {
      ctx.cascaErro = desc + ' (' + code + ')'
      require('./smoke').rodar(ctx)
    })
    setTimeout(() => { if (!ctx.cascaOk && !ctx.cascaErro) { ctx.cascaErro = 'nao carregou em 20s'; require('./smoke').rodar(ctx) } }, 20000)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

process.on('uncaughtException', (e) => {
  console.error('[sellwave-web] erro nao tratado:', e)
  try { dialog.showErrorBox('SellWave Web', String((e && e.message) || e)) } catch (_) { /* ok */ }
})
