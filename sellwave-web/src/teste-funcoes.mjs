// TESTE DAS CONTAS QUE DECIDEM DINHEIRO E BAN.
//
// Roda em Node puro (sem Electron, sem janela, sem rede):
//   node src/teste-funcoes.mjs
//
// Por que existe: o autoteste do Electron prova que a tela abre e que o WhatsApp carrega, mas NAO
// prova que a pausa do passo e a marca de "mensagem velha" estao certas. As duas ja estiveram
// erradas, e as duas erram CALADAS:
//   - a pausa somava `delay` + `sim`, e funil com `sim` preenchido saia todo no mesmo segundo
//     (varias mensagens de uma vez num chip novo e o jeito mais rapido de derrubar numero);
//   - `velha` saia do relogio do PC do vendedor, e Windows 40 minutos adiantado marcava TODA
//     mensagem como velha, o que no servidor significa nenhuma venda registrada.
//
// O teste le o codigo de verdade e executa a funcao de verdade: nao ha copia pra envelhecer.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const leia = (rel) => fs.readFileSync(path.join(AQUI, rel), 'utf8')

let falhas = 0
function vale(nome, condicao, detalhe) {
  const ok = !!condicao
  if (!ok) falhas++
  console.log('  ' + (ok ? 'OK    ' : 'FALHOU') + '  ' + nome + (detalhe ? '  ->  ' + detalhe : ''))
}

// Recorta uma funcao pelo nome, do `function nome(` ate a chave que fecha.
function recorta(fonte, assinatura) {
  const i = fonte.indexOf(assinatura)
  if (i < 0) throw new Error('nao achei: ' + assinatura)
  let nivel = 0
  for (let j = fonte.indexOf('{', i); j < fonte.length; j++) {
    if (fonte[j] === '{') nivel++
    else if (fonte[j] === '}') { nivel--; if (!nivel) return fonte.slice(i, j + 1) }
  }
  throw new Error('nao fechou: ' + assinatura)
}

console.log('\n=== contas do SellWave Web ===\n')

// ── 1) A PAUSA DO PASSO (painel-ui.js). Uma so, nunca a soma.
{
  const fonte = leia('ui/painel-ui.js')
  const pausaDoPasso = eval('(' + recorta(fonte, 'function pausaDoPasso(p)') + ')')
  vale('passo so com delay usa o delay', pausaDoPasso({ delay: 7 }) === 7, String(pausaDoPasso({ delay: 7 })))
  vale('passo so com sim usa o sim', pausaDoPasso({ sim: 5 }) === 5, String(pausaDoPasso({ sim: 5 })))
  vale('com os dois, NAO soma (vale o sim)', pausaDoPasso({ sim: 10, delay: 10 }) === 10, String(pausaDoPasso({ sim: 10, delay: 10 })))
  vale('passo vazio nao pausa', pausaDoPasso({}) === 0 && pausaDoPasso(null) === 0)
  vale('numero negativo vira zero', pausaDoPasso({ delay: -5 }) === 0)
  vale('texto no campo nao vira NaN', pausaDoPasso({ delay: 'abc' }) === 0)
}

// ── 2) A MARCA DE MENSAGEM VELHA (main.js), com o relogio corrigido pelo servidor.
{
  const fonte = leia('main.js')
  const linha = fonte.split('\n').find((l) => l.startsWith('const ehVelha ='))
  if (!linha) throw new Error('nao achei ehVelha')
  let desvioRelogio = 0
  const agoraCerto = () => Date.now() + desvioRelogio
  const ehVelha = eval('(' + linha.replace('const ehVelha =', '') .replace(/;?\s*$/, '') + ')')
  const agora = Math.floor(Date.now() / 1000)

  vale('mensagem de agora nao e velha', ehVelha(agora) === 0)
  vale('mensagem de 2 horas e velha', ehVelha(agora - 7200) === 1)
  vale('sem hora nenhuma nao e velha', ehVelha(0) === 0 && ehVelha(undefined) === 0)

  // O cenario que quebrava: relogio do PC 40 minutos ADIANTADO.
  desvioRelogio = -40 * 60 * 1000   // o servidor esta 40 min ATRAS do PC: o desvio corrige pra tras
  vale('relogio 40 min adiantado NAO marca mensagem nova como velha', ehVelha(agora - 40 * 60) === 0,
    'desvio ' + (desvioRelogio / 60000) + ' min')
  vale('mesmo com o relogio torto, mensagem de ontem continua velha', ehVelha(agora - 86400) === 1)
  desvioRelogio = 0
}

// ── 3) O ARQUIVO DA FILA NUNCA LEVA OS BYTES DO AUDIO.
{
  const fonte = leia('main.js')
  const corpo = recorta(fonte, 'function gravaFilaAgora()')
  vale('gravaFilaAgora apaga o mediaB64 antes de escrever',
    /delete copia\.mediaB64/.test(corpo) && /delete copia\.mediaMime/.test(corpo))
  vale('gravaFilaAgora continua sincrona (o before-quit nao espera promessa)',
    /fs\.writeFileSync/.test(corpo) && !/await/.test(corpo))

  const ipc = fonte.slice(fonte.indexOf("ipcMain.on('swp:captura'"))
  vale('a fila tem teto em BYTES, nao so em eventos', /TETO_FILA_BYTES/.test(ipc))
  vale('o teto larga o ANEXO antes de largar a mensagem', /delete ev\.mediaB64/.test(ipc))
}

// ── 4) O AGENTE NAO BAIXA MIDIA DE HISTORICO, E MANDA A MENSAGEM ANTES DO ANEXO.
{
  const fonte = leia('ui/agente.js')
  vale('historico de mais de 6 horas nao baixa midia', /var antiga = ts && \(Date\.now\(\) \/ 1000 - ts\) > 21600/.test(fonte))
  vale('a condicao do download olha o antiga', /!deMim && !antiga/.test(fonte))
  const trecho = fonte.slice(fonte.indexOf('if (/^(image|audio|sticker)$/i.test(tipo)'))
  const iManda = trecho.indexOf('manda(ev)')
  const iBaixa = trecho.indexOf('baixaMidia(msg)')
  vale('a mensagem vai ANTES do download (nao se perde se a pagina recarregar)',
    iManda >= 0 && iBaixa >= 0 && iManda < iBaixa)
}

// ── 5) FORMATACAO DO BALAO: marcacao vira estilo e texto do lead sai ESCAPADO.
{
  const fonte = leia('ui/painel-ui.js')
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const MARCAS = { '*': 'neg', _: 'ita', '~': 'ris' }
  const podeAbrir = (t, i) => i === 0 || /[\s(]/.test(t[i - 1])
  const podeFechar = (t, i) => i === t.length - 1 || /[\s.,!?:;)]/.test(t[i + 1])
  void MARCAS; void podeAbrir; void podeFechar; void esc
  const formatado = eval('(' + recorta(fonte, 'function formatado(txt)') + ')')
  vale('negrito vira estilo', formatado('*oi*') === '<span class="neg">oi</span>')
  vale('asterisco de conta nao vira marcacao', formatado('2*3 reais') === '2*3 reais')
  vale('html do lead sai escapado', formatado('<script>x</script>').indexOf('<script') < 0,
    formatado('<script>x</script>'))
  vale('aspas do lead saem escapadas', formatado('ele disse "oi"').indexOf('&quot;') >= 0)
}

// ── 6) VERSAO: comparar como TEXTO diz que 1.10.0 e menor que 1.9.0.
{
  const fonte = leia('main.js')
  const versaoMenor = eval('(' + recorta(fonte, 'function versaoMenor(a, b)') + ')')
  vale('1.0.0 e menor que 1.1.0', versaoMenor('1.0.0', '1.1.0') === true)
  vale('1.1.0 NAO e menor que 1.1.0', versaoMenor('1.1.0', '1.1.0') === false)
  vale('1.2.0 NAO e menor que 1.1.9', versaoMenor('1.2.0', '1.1.9') === false)
  vale('1.9.0 e menor que 1.10.0 (o caso que texto erra)', versaoMenor('1.9.0', '1.10.0') === true)
  vale('versao vazia nao derruba', versaoMenor('', '1.0.0') === true && versaoMenor('1.0.0', '') === false)
}

// ── 7) AS PORTAS DO AGENTE SERVIDO. Deixar entrar texto ruim aqui e tela em branco no
//    WhatsApp do vendedor, entao cada porta tem um teste.
{
  const fonte = leia('main.js')
  const require = createRequire(import.meta.url)
  void require
  const agenteServe = eval('(' + recorta(fonte, 'function agenteServe(txt)') + ')')
  const bom = 'window.__swEstado = function(){}; window.__swManda = function(){};' + ' '.repeat(9000)
  vale('o agente de verdade passa', agenteServe(bom) === true)
  vale('vazio nao passa', agenteServe('') === false && agenteServe(null) === false)
  vale('arquivo curto nao passa (pagina de erro disfarcada)', agenteServe('window.__swEstado=1;window.__swManda=1') === false)
  vale('arquivo grande SEM as nossas funcoes nao passa', agenteServe('<html>' + 'x'.repeat(9000) + '</html>') === false)
  vale('sintaxe quebrada nao passa', agenteServe('window.__swEstado = function({ window.__swManda' + ' '.repeat(9000)) === false)
}

// ── 8) A SENHA DO PROXY NAO PODE SAIR NO ESTADO DA CASCA.
{
  const fonte = leia('main.js')
  const bloco = fonte.slice(fonte.indexOf("ipcMain.handle('sw:estado'"), fonte.indexOf("ipcMain.handle('sw:estado'") + 1400)
  vale('sw:estado manda so host, porta e temSenha', /temSenha: !!\(p && \(p\.usuario \|\| p\.senha\)\)/.test(bloco))
  vale('sw:estado NAO manda config.proxies cru', !/proxies: config\.proxies/.test(bloco))
}

// ── 9) COLAR O PROXY DE UMA LINHA SO. O Bruno cola do painel do Decodo; errar aqui faz o
//    numero sair pelo lugar errado, ou nao sair.
{
  const fonte = leia('ui/app.js')
  const separaProxy = eval('(' + recorta(fonte, 'function separaProxy(txt)') + ')')
  const d = separaProxy('isp.decodo.com:10001:sp6ekfnce5:1ZyltWnn5st_9KnrK7')
  vale('formato host:porta:usuario:senha', d && d.host === 'isp.decodo.com' && d.porta === '10001'
    && d.usuario === 'sp6ekfnce5' && d.senha === '1ZyltWnn5st_9KnrK7', JSON.stringify(d))
  const u = separaProxy('http://user:pa:ss@proxy.com:8080')
  vale('formato de URL com senha contendo dois-pontos', u && u.host === 'proxy.com' && u.porta === '8080'
    && u.usuario === 'user' && u.senha === 'pa:ss', JSON.stringify(u))
  const sp = separaProxy('isp.decodo.com:10001')
  vale('so host e porta, sem credencial', sp && sp.host === 'isp.decodo.com' && sp.porta === '10001' && !sp.usuario)
  const ds = separaProxy('host:10001:user:se:nha:com:dois')
  vale('senha com dois-pontos nao e cortada', ds && ds.senha === 'se:nha:com:dois', ds && ds.senha)
  vale('texto solto nao vira proxy', separaProxy('nada') === null && separaProxy('') === null && separaProxy(null) === null)
  vale('porta que nao e numero nao passa', separaProxy('host:abc:u:s') === null)
}

// ── 10) O ENVIO TEM QUE SER IGUAL AO DO SALE CHAT QUE JA RODA EM PRODUCAO.
//
//    Eu tinha concluido que `markIsRecording` travava o envio do audio e tirei ele. O sc-panel do
//    Bruno desmente: usa ha meses e manda audio. Estes testes amarram o app NAQUELE desenho -
//    indicador, espera e envio GRUDADOS na mesma promessa, dentro da pagina - pra ninguem (eu
//    inclusive) voltar a quebrar isso em saltos entre processos.
{
  const fonte = leia('ui/agente.js')
  const bloco = fonte.slice(fonte.indexOf('window.__swManda = function'))
  vale('o audio mostra "gravando", como em producao', /markIsRecording/.test(bloco))
  vale('o texto mostra "digitando"', /markIsComposing/.test(bloco))
  vale('a espera do passo acontece DENTRO do envio', bloco.indexOf('esperaOuPara(pausaMs)') > 0)
  const ramoAudio = bloco.slice(bloco.indexOf("item.kind === 'audio'"))
  vale('no audio o indicador vem ANTES da espera',
    ramoAudio.indexOf('markIsRecording') > 0 && ramoAudio.indexOf('markIsRecording') < ramoAudio.indexOf('esperaOuPara'))
  vale('o envio vem depois da espera', bloco.indexOf('esperaOuPara') < bloco.indexOf('sendFileMessage'))

  const espera = recorta(fonte, 'function esperaOuPara(ms)')
  vale('a espera confere o Parar em fatias', espera.indexOf('__swParar') > 0 && espera.indexOf('400') > 0)

  const main = leia('main.js')
  vale('o Parar alcanca a pagina', main.indexOf("ipcMain.handle('swp:parar'") > 0 && main.indexOf('__swParar') > 0)
}

// ── 10b) O NOME DO LEAD. Com o contato NAO salvo, o WhatsApp Web poe o NUMERO no titulo e o push
//    name logo abaixo, com til: "+55 74 9995-7871" / "~Amor". O painel estava levando o NUMERO pro
//    campo NOME do cadastro de pedido. Este teste roda a funcao DE VERDADE, tirada do fonte, pra
//    nao virar uma segunda copia da regra que pode discordar dela.
{
  const fonte = leia('ui/agente.js')
  const pedaco = fonte.slice(fonte.indexOf('var NAO_E_NOME'), fonte.indexOf('function nomeDaConversa'))
  const limpaNome = new Function(pedaco + '; return limpaNome')()

  const casos = [
    ['+55 74 9995-7871', '', 'numero do cabecalho nao e nome'],
    ['(19) 99598-3293', '', 'numero formatado em (DD) tambem nao'],
    ['+5574999957871', '', 'numero colado tambem nao'],
    ['~Amor', 'Amor', 'o push name entra, sem o til'],
    ['~ Joao Pedro', 'Joao Pedro', 'til com espaco tambem sai'],
    ['Maria Silva', 'Maria Silva', 'nome salvo na agenda passa inteiro'],
    ['Loja do Ze LTDA', 'Loja do Ze LTDA', 'nome de empresa passa'],
    ['Dados do perfil', '', 'rotulo da gaveta de contato continua barrado'],
    ['2112', '2112', 'apelido curto de digito ainda e nome'],
    ['   ', '', 'so espaco nao e nome'],
  ]
  for (const [entra, sai, oque] of casos) vale(oque, limpaNome(entra) === sai, JSON.stringify(limpaNome(entra)))

  // PRESENCA NAO PODE VIRAR NOME. A linha onde o push name aparece e a MESMA onde o WhatsApp
  // escreve "online" e "visto por ultimo". Sem este filtro, "visto por ultimo hoje as 14:02" ia
  // parar no campo Nome do pedido e, dali, na etiqueta de despacho.
  for (const p of ['online', 'digitando...', 'gravando audio...', 'visto por ultimo hoje as 14:02',
    'última vez hoje às 09:12', 'last seen today at 3:04 PM']) {
    vale('presenca "' + p + '" nao vira nome', limpaNome(p) === '', JSON.stringify(limpaNome(p)))
  }

  // EMOJI SAI. O valor nao para na tela: vai pro campo Nome do pedido e, quando o Bruno aceita,
  // pro customer[name] da PayLog - ou seja pra etiqueta e pra cobranca. Coracao na etiqueta nao
  // ajuda ninguem, e o campo continua editavel.
  vale('o emoji sai e o nome fica', limpaNome('~Amor ❤️') === 'Amor', limpaNome('~Amor ❤️'))
  vale('acento NAO e emoji, fica', limpaNome('João Pedro') === 'João Pedro', limpaNome('João Pedro'))

  // ── A FUNCAO INTEIRA, com um WPP de mentira. Isto e o que pega a causa raiz de verdade:
  //    `WPP.contact.get` e ASSINCRONO (devolve Promise), entao qualquer versao que leia nome dele
  //    volta vazio. Aqui o fake devolve Promise de proposito.
  const corpo = recorta(fonte, 'function nomeDaConversa()')
  const monta = (chat, titulo) => {
    const ctx = {
      window: {
        WPP: {
          contact: { get: async () => ({ name: 'NAO DEVE SER LIDO', pushname: 'NAO DEVE SER LIDO' }) },
          chat: { get: () => chat },
        },
      },
      document: { querySelector: () => (titulo ? { getAttribute: () => titulo, textContent: titulo } : null) },
      // Grupo = conversaAberta devolve vazio (o ehPessoa recusa). E o caso que prova que o DOM
      // nao e consultado sem conversa de pessoa aberta.
      conversaAberta: () => (chat ? '5574999957871@c.us' : ''),
    }
    const f = new Function('window', 'document', 'conversaAberta',
      pedaco + '\n' + corpo + '\n; return nomeDaConversa')
    return f(ctx.window, ctx.document, ctx.conversaAberta)()
  }

  vale('contato NAO salvo: o push name vence o numero do titulo',
    monta({ formattedTitle: '+55 74 9995-7871', contact: { pushname: 'Amor', formattedName: '+55 74 9995-7871' } }) === 'Amor',
    monta({ formattedTitle: '+55 74 9995-7871', contact: { pushname: 'Amor', formattedName: '+55 74 9995-7871' } }))
  vale('contato SALVO: o nome da agenda vence o push name',
    monta({ formattedTitle: 'Maria', contact: { name: 'Maria Cliente', pushname: 'Amor' } }) === 'Maria Cliente')
  vale('empresa: o nome verificado vence o apelido',
    monta({ formattedTitle: 'Loja', contact: { verifiedName: 'Loja do Ze LTDA', pushname: 'Zezinho' } }) === 'Loja do Ze LTDA')
  vale('sem push name nenhum, volta VAZIO em vez de devolver o numero',
    monta({ formattedTitle: '+55 74 9995-7871', contact: { formattedName: '+55 74 9995-7871' } }) === '')
  vale('sem conversa aberta (grupo), nem olha o desenho da tela',
    monta(null, 'Equipe SellWave') === '')
  vale('com conversa aberta, o DOM so vale pelo titulo e passa pelo mesmo filtro',
    monta({ formattedTitle: '' }, 'Maria Cliente') === 'Maria Cliente')
  vale('e o DOM nao entrega presenca como nome',
    monta({ formattedTitle: '' }, 'visto por ultimo hoje as 14:02') === '')
}

// ── 10c) NENHUMA CHAMADA DE REDE DO APP PODE SAIR PELA SESSAO PADRAO.
//    Dois bugs da MESMA familia morderam o Bruno em duas semanas, e nenhum dos dois deu erro
//    visivel: a previa de midia (que nao carregava nada, 17/10) e a busca de CEP (que girava pra
//    sempre, pedida quatro vezes). Nos dois, `net.fetch` saia pela sessao PADRAO, que esta num
//    buraco negro de proxy DE PROPOSITO (socks5://127.0.0.1:1, pra nada vazar por engano) - entao
//    a chamada morria em ERR_PROXY, que e indistinguivel de "ninguem respondeu".
//
//    NO PROCESSO PRINCIPAL EXISTEM DOIS CAMINHOS CERTOS: o `fetch` global do Node, que nao passa
//    por sessao nenhuma, e `ses.fetch(...)` numa sessao que saia direto (a do painel esta em
//    'direct'). `net.fetch` nao e nenhum dos dois.
//
//    E A ARMADILHA QUE FAZ ISSO CUSTAR CARO: passar { session } pro `net.fetch` NAO DA ERRO. A
//    assinatura dele so tem bypassCustomProtocolHandlers, entao o campo e ignorado em silencio e o
//    sintoma aparece tres camadas depois, numa midia que nao carrega.
{
  const fonte = leia('main.js')
  const linhas = fonte.split(String.fromCharCode(10))
  const semComentario = linhas.filter((l) => !/^\s*(\/\/|\*)/.test(l)).join(String.fromCharCode(10))
  const usos = (semComentario.match(/net\.fetch\(/g) || []).length
  vale('o processo principal nao usa net.fetch em lugar nenhum', usos === 0, usos + ' uso(s)')
  vale('a midia busca pela sessao do painel, que sai direto', /sesPainel\.fetch\(/.test(semComentario))
  vale('e o handler do swmedia mora na sessao do painel, nao na padrao',
    /sesPainel\.protocol\.handle\(/.test(semComentario))
}

// ── 11) A URL DE DADOS DA MIDIA. Este custou o dia: todo funil com audio morria no primeiro
//    passo com `invalid_data_url`, porque o R2 devolve "audio/ogg; codecs=opus" e o espaco
//    invalida a URL. O teste usa os tipos REAIS que a nossa midia tem.
{
  const fonte = leia('main.js')
  const corpo = recorta(fonte, 'async function dataUriDe(url)')
  const limpa = (t) => String(t).split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  const valida = (u) => /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(u)

  vale('o tipo e cortado no ponto-e-virgula', /split\(';'\)\[0\]/.test(corpo))
  vale('a URL montada e conferida antes de sair', /invalid|tipo estranho/.test(corpo) && /base64,/.test(corpo))

  for (const t of ['audio/ogg; codecs=opus', 'audio/ogg', 'image/jpeg', 'video/mp4; codecs="avc1.4d"', '']) {
    const u = 'data:' + limpa(t) + ';base64,QUJD'
    vale('tipo real "' + (t || '(vazio)') + '" vira URL valida', valida(u), u.slice(0, 34))
  }
}

// ── 12) PAREAMENTO NOVO SO VAI PRA NUVEM DEPOIS DE 3 MINUTOS CONECTADO (21/10/2026). Medido: copia
//    feita 20 a 40 s depois do QR caiu na maquina seguinte (9743, 2193, 8847); com 87 s ou mais,
//    abriu e seguiu de pe. As funcoes de verdade, com um relogio e uma pagina de mentira.
{
  const fonte = leia('main.js')
  const constante = fonte.split('\n').find((l) => l.startsWith('const PAREAMENTO_MIN_MS ='))
  const codigo = [constante, recorta(fonte, 'function numKey(numero)'), recorta(fonte, 'function conectadoDe(r, nk, estrito)'),
    recorta(fonte, 'function notaPareamento(s, st)'), recorta(fonte, 'async function esperaPareamentoAssentar(s, nk, wc, r)')].join('\n')
  let agora = 1792600000000
  const anotado = [], nuvem = []
  let roteiro = []   // o que a pagina responde a cada leitura
  const F = new Function('Date', 'anota', 'marcaNuvem', 'espera', 'lerConexao',
    codigo + '\nreturn { notaPareamento, esperaPareamentoAssentar, PAREAMENTO_MIN_MS }')(
    { now: () => agora },
    (t) => anotado.push(t),
    (nk, st, txt) => nuvem.push(st + ':' + txt),
    async (ms) => { agora += ms },
    async () => (roteiro.length > 1 ? roteiro.shift() : roteiro[0]))
  const wc = { isDestroyed: () => false }
  const NK = '1591872193'
  const pronto = { st: 'pronto', auth: true, eu: '5515991872193', wid: true }

  vale('o minimo e de 3 minutos', F.PAREAMENTO_MIN_MS === 180000, String(F.PAREAMENTO_MIN_MS))

  // o 2193 de 21/10: QR, leu, PRONTO, e fechou 22 s depois
  let s = { nk: NK }
  F.notaPareamento(s, 'qr'); F.notaPareamento(s, 'pronto')
  const t0 = agora
  agora += 22000
  roteiro = [pronto]
  let r = await F.esperaPareamentoAssentar(s, NK, wc, pronto)
  vale('fechou 22 s depois do QR: espera ate completar 3 min conectado', r && agora - t0 >= 180000, Math.round((agora - t0) / 1000) + ' s')
  vale('e a nuvem pisca "terminando o pareamento" enquanto espera', nuvem.some((x) => /^enviando:Terminando o pareamento/.test(x)), nuvem[0])

  // desconectou no meio da espera: nao sobe
  s = { nk: NK }; nuvem.length = 0
  F.notaPareamento(s, 'qr'); F.notaPareamento(s, 'pronto')
  roteiro = [pronto, pronto, { st: 'qr', auth: false, eu: '', wid: false }]
  r = await F.esperaPareamentoAssentar(s, NK, wc, pronto)
  vale('caiu durante a espera: devolve null (nao sobe copia)', r === null, JSON.stringify(r))
  vale('e avisa que precisa ler o QR de novo', nuvem.some((x) => /^erro:.*QR de novo/.test(x)), nuvem.slice(-1)[0])

  // restaurado ja conectado (sem QR nesta abertura): passa direto, sem esperar
  s = { nk: NK }; nuvem.length = 0
  F.notaPareamento(s, 'pronto')
  const t1 = agora
  r = await F.esperaPareamentoAssentar(s, NK, wc, pronto)
  vale('numero que ja abriu conectado nao espera nada', r === pronto && agora === t1 && !nuvem.length)

  // pareado ha 4 minutos: ja passou do minimo
  s = { nk: NK }
  F.notaPareamento(s, 'qr'); F.notaPareamento(s, 'pronto')
  agora += 240000
  const t2 = agora
  r = await F.esperaPareamentoAssentar(s, NK, wc, pronto)
  vale('pareado ha 4 min: sobe na hora', r === pronto && agora === t2)

  // fechou tao rapido que nenhuma leitura viu o PRONTO: o relogio comeca no fechamento
  s = { nk: NK }
  F.notaPareamento(s, 'qr')
  const t3 = agora
  roteiro = [pronto]
  r = await F.esperaPareamentoAssentar(s, NK, wc, pronto)
  vale('QR visto e PRONTO so no fechamento: espera os 3 min inteiros', r && agora - t3 >= 180000, Math.round((agora - t3) / 1000) + ' s')

  // caiu e foi pareado de novo no meio do expediente: o relogio recomeca
  s = { nk: NK }
  F.notaPareamento(s, 'pronto'); F.notaPareamento(s, 'caiu'); F.notaPareamento(s, 'pronto')
  vale('QR lido de novo no meio do dia conta como pareamento novo', s.viuQr === true && s.pareouEm === agora)

  vale('a despedida chama a espera antes de decidir se sobe',
    /r = await esperaPareamentoAssentar\(s, nk, wc, r\)\n\s*conectado = conectadoDe\(r, nk, false\)/.test(fonte))
  vale('toda abertura liga o vigia do pareamento', /abertos\.set\(nk, s\)\n[^\n]*\n\s*vigiaPareamento\(s\)/.test(fonte))
}

// ── 13) O ENVIO DO FUNIL TEM TETO DO LADO DO NODE (22/10/2026). O funil do 8066 do Guilherme girou
//    4 h em "Enviando passo 1 de 5": a pagina congelou em segundo plano, o prazo DELA nao disparou e o
//    main esperava pra sempre. Aqui a pagina congelada e uma promessa que nunca volta.
{
  const fonte = leia('main.js')
  const codigo = ['const mandasNoAr = new Map()', recorta(fonte, 'function comTetoNode(wc, chave, codigo, tetoMs)'),
    recorta(fonte, 'function soltaEnviosDe(chave)'), recorta(fonte, 'function tetoDoItem(it)')].join('\n')
  const F = new Function(codigo + '\nreturn { comTetoNode, soltaEnviosDe, mandasNoAr, tetoDoItem }')()
  const congelada = { executeJavaScript: () => new Promise(() => {}) }
  const viva = { executeJavaScript: async () => true }
  const quebra = { executeJavaScript: async () => { throw new Error('a pagina disse que nao') } }

  // TETO POR ITEM: cobre pausa (ate 120 s) + envio, e e sempre MAIOR que o prazo da pagina daquele
  // passo, pra pagina viva cair no erro bom do comPrazo e so a congelada chegar no teto do Node.
  vale('video com pausa longa nao e cortado (pior caso legitimo 300 s, teto >= 330 s)',
    F.tetoDoItem({ tipo: 'midia', kind: 'video', pausa: 120 }) >= 330000, String(F.tetoDoItem({ tipo: 'midia', kind: 'video', pausa: 120 })))
  vale('o teto do item passa do prazo da pagina dele (audio 120 s, texto 60 s)',
    F.tetoDoItem({ tipo: 'midia', kind: 'audio', pausa: 10 }) > 120000 && F.tetoDoItem({ tipo: 'texto', pausa: 0 }) > 60000)
  vale('texto curto sem pausa nao espera o pior caso do video (teto justo)',
    F.tetoDoItem({ tipo: 'texto', pausa: 0 }) < F.tetoDoItem({ tipo: 'midia', kind: 'video', pausa: 120 }))
  let erro = ''
  const t0 = Date.now()
  try { await F.comTetoNode(congelada, '80668066', 'x', 60) } catch (e) { erro = e.message }
  vale('pagina congelada: o envio desiste sozinho no teto, nao fica preso',
    /não respondeu a tempo/.test(erro) && Date.now() - t0 < 1000, erro)
  vale('e nao sobra nada pendurado do envio que desistiu', !F.mandasNoAr.size, String(F.mandasNoAr.size))

  erro = ''
  const p = F.comTetoNode(congelada, '80668066', 'x', 60000).catch((e) => { erro = e.message })
  F.soltaEnviosDe('11112222')
  await new Promise((r) => setTimeout(r, 20))
  vale('o Parar de OUTRO numero nao solta este', erro === '', erro)
  const t1 = Date.now()
  F.soltaEnviosDe('80668066')
  await p
  vale('o Parar solta na hora o envio preso daquele numero', /você parou este funil/.test(erro) && Date.now() - t1 < 200, erro)
  vale('e limpa a porta do Parar', !F.mandasNoAr.size, String(F.mandasNoAr.size))

  vale('pagina viva: o envio volta normal', (await F.comTetoNode(viva, '80668066', 'x', 60)) === true)
  erro = ''
  try { await F.comTetoNode(quebra, '80668066', 'x', 60) } catch (e) { erro = e.message }
  vale('pagina que responde erro: o erro dela e que aparece', erro === 'a pagina disse que nao', erro)
  vale('o swp:manda usa o teto POR ITEM e o swp:parar solta o envio',
    /comTetoNode\(wc, String\(nk \|\| ''\),\s*\n?\s*'window\.__swManda\(/.test(fonte) && /tetoDoItem\(pedaco\)/.test(fonte) && /if \(parar\) soltaEnviosDe\(nk\)/.test(fonte))
}

// ── 14) A PAGINA QUE PAROU DE REGISTRAR SE CONSERTA SOZINHA (22/10/2026, a Barbara). Envio que deu
//    certo e nao voltou na captura em 90 s, duas vezes seguidas, recarrega a pagina daquele numero.
{
  const fonte = leia('main.js')
  const codigo = [recorta(fonte, 'function nkDaPagina(wcId)'), recorta(fonte, 'function confereCaptura(nk, desde)')].join('\n')
  let agora = 1792640000000
  const anotado = [], avisos = []
  let recargas = 0
  const wc = { id: 7, isDestroyed: () => false, reload: () => { recargas++ } }
  const abertos = new Map([['3173623697', { view: { webContents: wc } }]])
  const mandasNoAr = new Map()
  const capturaVistaEm = new Map(), capturaFaltou = new Map(), recarregouSurdaEm = new Map()
  const F = new Function('Date', 'anota', 'avisaCasca', 'abertos', 'mandasNoAr', 'capturaVistaEm', 'capturaFaltou', 'recarregouSurdaEm', 'cheioDe',
    codigo + '\nreturn { nkDaPagina, confereCaptura }')(
    { now: () => agora }, (t) => anotado.push(t), (c, d) => avisos.push(d), abertos, mandasNoAr,
    capturaVistaEm, capturaFaltou, recarregouSurdaEm, () => '(31) 97362-3697')
  const NK = '3173623697'

  vale('a captura acha de qual numero veio pela pagina', F.nkDaPagina(7) === NK && F.nkDaPagina(99) === '')
  let t = agora; capturaVistaEm.set(NK, agora + 500)
  F.confereCaptura(NK, t)
  vale('envio que voltou na captura: nada a fazer', recargas === 0 && !capturaFaltou.size)
  agora += 100000; t = agora
  F.confereCaptura(NK, t)
  vale('um envio que nao voltou: so anota, nao recarrega', recargas === 0 && capturaFaltou.get(NK) === 1, JSON.stringify([...capturaFaltou]))
  agora += 100000; F.confereCaptura(NK, agora)
  vale('o segundo seguido ainda nao recarrega (sao tres)', recargas === 0 && capturaFaltou.get(NK) === 2)
  // o vendedor esta mexendo neste numero: no terceiro, so avisa
  abertos.get(NK).mexeuEm = agora + 50000
  agora += 100000; F.confereCaptura(NK, agora)
  vale('o terceiro com o vendedor mexendo no numero: NAO recarrega, so avisa', recargas === 0 && avisos.length === 1 && /Quando puder, clique em Atualizar/.test(avisos[0].texto), JSON.stringify(avisos))
  // passada a meia hora e o vendedor parado: recarrega
  abertos.get(NK).mexeuEm = 0; avisos.length = 0
  agora += 31 * 60000; F.confereCaptura(NK, agora); agora += 100000; F.confereCaptura(NK, agora); agora += 100000; F.confereCaptura(NK, agora)
  vale('tres seguidas e ninguem mexendo: recarrega a pagina daquele numero', recargas === 1)
  vale('e avisa na barra com o numero', avisos.length === 1 && /\(31\) 97362-3697 parou de registrar/.test(avisos[0].texto), JSON.stringify(avisos[0]))
  agora += 100000; F.confereCaptura(NK, agora); agora += 100000; F.confereCaptura(NK, agora); agora += 100000; F.confereCaptura(NK, agora)
  vale('surda de novo logo depois: nao recarrega mais de uma vez em 30 min', recargas === 1, String(recargas))
  mandasNoAr.set(NK, new Set([() => {}]))
  agora += 31 * 60000; F.confereCaptura(NK, agora)
  vale('com um funil no meio, espera ele acabar', recargas === 1, String(recargas))
  mandasNoAr.clear(); agora += 100000; F.confereCaptura(NK, agora)
  vale('sem funil no meio e passada a meia hora: recarrega de novo', recargas === 2, String(recargas))
  vale('toda pagina de numero guarda quando o vendedor mexeu nela', /before-input-event', \(\) => \{ s\.mexeuEm = Date\.now\(\) \}/.test(fonte))
  capturaVistaEm.set(NK, agora + 10); agora += 100000; F.confereCaptura(NK, agora - 100000)
  vale('voltou a registrar: zera a contagem', !capturaFaltou.has(NK))
  vale('o envio do painel liga a conferencia e o relogio comeca antes do envio',
    /const antes = Date\.now\(\)\n\s*const r = await comTetoNode\([\s\S]{0,260}?if \(r && nk\) setTimeout\(\(\) => confereCaptura\(String\(nk\), antes\), CAPTURA_ESPERA_MS\)/.test(fonte))
  vale('a captura marca a pagina que esta ouvindo', /const nkCap = nkDaPagina\(_e\.sender\.id\); if \(nkCap\) capturaVistaEm\.set\(nkCap, Date\.now\(\)\)/.test(fonte))
  // pela LISTA de canais permitidos, nao pela posicao: canal novo no fim (sw:fotos, 23/10) nao pode quebrar isto
  const permitidosBarra = (leia('preload.js').match(/const permitidos = \[([^\]]*)\]/) || [])[1] || ''
  vale('o aviso passa pelo preload da barra', /'sw:aviso'/.test(permitidosBarra))
  vale('e o aviso de que as fotos da equipe chegaram tambem', /'sw:fotos'/.test(permitidosBarra))
}

// ── 15) A COLHEITA (23/10/2026): o app pergunta a pagina e manda direto o que o servidor nunca
//    confirmou. O caso: o app inteiro do Guilherme parou de mandar captura as 08:35 com funil saindo.
{
  const fonte = leia('main.js')
  const codigo = [recorta(fonte, 'function marcaEntregues(ids)'), recorta(fonte, 'function faltamNaDash(evs, agora)'),
    recorta(fonte, 'function janelaDaColheita(nk, agoraS)'), recorta(fonte, 'async function mandaColheita(evs)')].join('\n')
  const filaCaptura = []
  const entregues = new Map(), ultimaColheita = new Map()
  const saude = { colhidas: 0 }
  const anotado = []
  let respostas = []   // o que o "servidor" responde a cada POST
  const posts = []
  const fetchFalso = async (url, o) => {
    posts.push(JSON.parse(o.body).events.map((e) => e.msgId))
    const r = respostas.shift() || { ok: true, ack: null }
    if (r.erro) throw new Error(r.erro)
    return { ok: r.ok !== false, status: r.ok === false ? 500 : 200, headers: { get: () => null }, json: async () => ({ ack: r.ack }) }
  }
  const mk = (jaTinha) => new Function('filaCaptura', 'entregues', 'ultimaColheita', 'saude', 'anota', 'config', 'fetch', 'ajustaRelogio', 'ehVelha', 'jaTinhaRegistro',
    'let entreguesSujo = false; let filaSuja = false;\n' + codigo + '\nreturn { marcaEntregues, faltamNaDash, janelaDaColheita, mandaColheita }')(
    filaCaptura, entregues, ultimaColheita, saude, (t) => anotado.push(t), { token: 'x', apiBase: 'https://api' }, fetchFalso, () => {}, () => 0, jaTinha)
  const F = mk(true)
  const agora = 1792700000000
  const ev = (id, extra) => Object.assign({ msgId: id, phone: '5511933332222', ts: Math.floor(agora / 1000) - 60, body: 'oi' }, extra || {})

  entregues.set('JA', agora - 1000)
  filaCaptura.push({ msgId: 'FILA_NOVA', __em: agora - 60000 }, { msgId: 'FILA_PRESA', __em: agora - 6 * 60000 })
  const falta = F.faltamNaDash([ev('JA'), ev('NOVA'), ev('NOVA'), ev('FILA_NOVA'), ev('FILA_PRESA'), ev('')], agora).map((e) => e.msgId)
  vale('a colheita manda so o que o servidor nunca confirmou', !falta.includes('JA') && falta.includes('NOVA'), JSON.stringify(falta))
  vale('sem repetir a mesma mensagem duas vezes', falta.filter((x) => x === 'NOVA').length === 1, JSON.stringify(falta))
  vale('o que entrou na fila agora e da fila; o que esta preso nela ha mais de 5 min, a colheita manda', !falta.includes('FILA_NOVA') && falta.includes('FILA_PRESA'), JSON.stringify(falta))
  vale('e evento sem id fica de fora', !falta.includes(''))

  const agoraS = Math.floor(agora / 1000)
  vale('primeira vez nesta maquina: a colheita olha so a ultima hora', mk(false).janelaDaColheita('NK', agoraS) === agoraS - 3600)
  vale('maquina com registro, numero sem colheita ainda: ultimas 6 h', F.janelaDaColheita('NK', agoraS) === agoraS - 6 * 3600)
  ultimaColheita.set('NK', agoraS - 300)
  vale('depois: desde a ultima colheita, com 10 min de folga', F.janelaDaColheita('NK', agoraS) === agoraS - 300 - 600)
  ultimaColheita.set('NK', agoraS - 3 * 86400)
  vale('app fechado ha dias: no maximo 24 h pra tras (o que o servidor aceita de lead atrasado)', F.janelaDaColheita('NK', agoraS) === agoraS - 86400)

  const muitos = Array.from({ length: 85 }, (_, i) => ev('M' + i))
  respostas = [{ ok: true, ack: muitos.slice(0, 40).map((e) => e.msgId) }, { ok: true, ack: null }, { erro: 'sem rede' }]
  const foram = await F.mandaColheita(muitos)
  vale('manda direto, em lotes de 40', posts.length === 3 && posts[0].length === 40 && posts[2].length === 5, JSON.stringify(posts.map((x) => x.length)))
  vale('o que o servidor confirmou fica registrado (com ack e sem ack)', entregues.has('M0') && entregues.has('M79') && !entregues.has('M80'))
  vale('o lote que falhou NAO se perde: vai pra fila de sempre, marcado com a hora', filaCaptura.some((e) => e.msgId === 'M84' && e.__em > 0) && foram === 80, String(foram))
  respostas = [{ erro: 'de novo' }]
  await F.mandaColheita([ev('M84')])
  vale('e nao entra duplicado na fila se falhar de novo', filaCaptura.filter((e) => e.msgId === 'M84').length === 1)

  vale('a drenagem da fila registra o que o servidor confirmou', /marcaEntregues\(aceitos \? \[\.\.\.aceitos\] : lote\.map\(\(ev\) => ev && ev\.msgId\)\)/.test(fonte))
  vale('o envio do funil colhe a conversa daquele lead', /if \(r && nk && chatId\) setTimeout\(\(\) => \{ colheConversa\(String\(nk\), String\(chatId\)\)/.test(fonte))
  vale('a colheita roda de 2 em 2 minutos', /setInterval\(\(\) => \{ colheTodos\(\)\.catch\(\(\) => \{\}\) \}, 120000\)/.test(fonte))
  vale('o sinal de vida leva a saude da captura', /auth: true, motor: !!e\.motor, saude: saudeDaCaptura\(\)/.test(fonte))
  vale('o roteiro (que a drenagem espera) tem teto', /'\/api\/swweb\/roteiro',\n\s*\{ headers: \{ Authorization: 'Bearer ' \+ config\.token \}, signal: AbortSignal\.timeout\(20000\) \}/.test(fonte))
  vale('o registro do que foi confirmado carrega na abertura', /leFila\(\)\n\s*carregaEntregues\(\)/.test(fonte))
}

// ── 16) A ATUALIZACAO SOZINHA (23/10/2026, pedido do Bruno). O app baixa a versao nova em segundo
//    plano e instala quando o vendedor fecha. Aqui: a fiacao e as travas que nao podem sumir.
{
  const fonte = leia('main.js')
  const pkg = JSON.parse(leia('../package.json'))
  const pub = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {}
  vale('o feed e o do worker, generico', pub.provider === 'generic' && pub.url === 'https://axion-api.axion-dash.workers.dev/api/swweb/atualizacao', JSON.stringify(pub))
  vale('o electron-updater vai no pacote, com versao fixa', /^\d+\.\d+\.\d+$/.test(String((pkg.dependencies || {})['electron-updater'] || '')), JSON.stringify(pkg.dependencies))
  const liga = recorta(fonte, 'function ligaAtualizador()')
  vale('so liga no app instalado (nunca em teste, foto ou segunda copia)', /if \(!app\.isPackaged \|\| EH_TESTE \|\| DADOS_A_PARTE\) return/.test(liga))
  vale('baixa sozinho e instala quando o app fecha', /autoDownload = true/.test(liga) && /autoInstallOnAppQuit = true/.test(liga))
  vale('nunca volta pra versao mais velha', /allowDowngrade = false/.test(liga))
  vale('e NUNCA reinicia o app no meio do trabalho', !/quitAndInstall/.test(fonte))
  vale('o app liga o atualizador ao subir', /ligaAtualizador\(\)\n\s*setTimeout\(\(\) => \{ confereVersao\(\); atualizaAgente\(\) \}, 3000\)/.test(fonte))
  vale('o aviso de baixar na mao so aparece se a atualizacao sozinha nao der conta',
    /versaoMenor\(app\.getVersion\(\), versaoPublicada\) && !atualizaSozinho\(\)/.test(fonte))
}

// ── 17) O CRM DO ATENDIMENTO (23/10/2026, pedido do Bruno). A faixa no pe da area do WhatsApp e o
//    quadro que abre por cima dela. Aqui: a geometria (a view sobe a altura da faixa so na janela
//    principal, e sai da tela com o quadro aberto) e a fiacao que nao pode sumir.
{
  const fonte = leia('main.js')
  const area = recorta(fonte, 'function areaConteudo(d, semCrm)')
  const monta = new Function('crm', 'painel', area.replace('function areaConteudo', 'return function areaConteudo')
    .replace(/^/, 'const ALTURA_FAIXA_CRM = 34; const ALTURA_TOPO = 0; const LARGURA_PAINEL = 316; const FRESTA_PAINEL = 22;'
      + ' const janela = { isDestroyed: () => false, getContentBounds: () => ({ width: 1600, height: 900 }) };'
      + ' const larguraBarra = (d) => (d ? 0 : 268); const temPainel = () => painel; const painelLigado = true; let crmAberto = crm;'))
  const fechado = monta(false, true), aberto = monta(true, true)
  const destacada = { win: { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }) } }
  vale('a view do WhatsApp termina em cima da faixa do CRM (34 px)', JSON.stringify(fechado()) === JSON.stringify({ x: 268, y: 0, width: 1016, height: 866 }), JSON.stringify(fechado()))
  vale('com o quadro aberto ela sai da tela inteira, com o MESMO tamanho (o WhatsApp nao se redesenha)',
    aberto().y + aberto().height < 0 && aberto().height === 866 && aberto().width === 1016, JSON.stringify(aberto()))
  vale('a casca recebe a area de verdade mesmo com o quadro aberto', JSON.stringify(aberto(null, true)) === JSON.stringify(fechado()), JSON.stringify(aberto(null, true)))
  vale('a janela destacada nao tem faixa nem quadro', JSON.stringify(aberto(destacada)) === JSON.stringify({ x: 0, y: 0, width: 884, height: 800 }), JSON.stringify(aberto(destacada)))
  vale('quem posiciona view passa pela areaConteudo (abrir numero com o quadro aberto respeita)', !/setBounds\(\{ x: larguraBarra/.test(fonte))
  vale('clicar num numero da lista fecha o quadro', /ipcMain\.handle\('sw:abrir', async \(_e, \{ numero \}\) => \{\n\s*defineCrm\(false\)/.test(fonte)
    && /ipcMain\.handle\('sw:mostrar', \(_e, \{ nk \}\) => \{ defineCrm\(false\); mostra\(nk\)/.test(fonte))
  vale('o quadro le o mesmo CRM da dash e grava a etapa pela mesma rota', /'\/api\/wa\/crm\?de='/.test(fonte) && /'\/api\/wa\/chat\/stage'/.test(fonte))
  vale('abrir ou reler o quadro roda a colheita (no maximo 1 vez por minuto)', /function garanteMarcacao\(\) \{\n\s*if \(Date\.now\(\) - crmColheuEm < 60000\) return/.test(fonte)
    && /if \(aberto\) garanteMarcacao\(\)/.test(fonte))
  vale('a conversa pedida com o numero fechado abre quando ele ficar pronto', /if \(st === 'pronto'\) crmAbrePendente\(s\)/.test(fonte))
  vale('a conversa do card e achada pelos 8 digitos do numero na instancia', /String\(instancia \|\| ''\)\.match\(\/_\(\\d\{8\}\)\$\/\)/.test(fonte))
  const ini = recorta(fonte, 'function inicioDoPeriodo(periodo)')
  const per = new Function('agoraCerto', ini + '\nreturn inicioDoPeriodo')(() => Date.parse('2026-10-23T15:30:00-03:00'))
  vale('Hoje comeca a meia-noite de Brasilia', per('hoje') === Date.parse('2026-10-23T00:00:00-03:00') / 1000, String(per('hoje')))
  vale('7 dias e hoje mais os 6 anteriores', per('7d') === Date.parse('2026-10-17T00:00:00-03:00') / 1000, String(per('7d')))
  vale('Este mes comeca no dia 1', per('mes') === Date.parse('2026-10-01T00:00:00-03:00') / 1000, String(per('mes')))
  const pre = leia('preload.js')
  vale('o preload da barra deixa passar a area e a marcacao', /'sw:area'/.test(pre) && /'sw:marcacao'/.test(pre))
  vale('a pagina da barra carrega o crm.js', /<script src="crm\.js"><\/script>/.test(leia('ui/index.html')))
}

console.log('')
if (falhas) { console.log(falhas + ' conta(s) erradas.'); process.exit(1) }
console.log('todas as contas conferem.')
