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

console.log('')
if (falhas) { console.log(falhas + ' conta(s) erradas.'); process.exit(1) }
console.log('todas as contas conferem.')
