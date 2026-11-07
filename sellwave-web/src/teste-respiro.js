// O RESPIRO DO FUNIL: quanto cada item espera antes de sair (regra de 27/10/2026).
//
// A REGRA ANTERIOR, de 26/10, era "metade da duracao do audio que VAI SAIR". O proprio Bruno
// derrubou no dia seguinte: "sem condicoes". MEDIDO no que fez ele derrubar, no "M - Etapa 3": o
// primeiro item e um audio de 174 s, entao a regra velha segurava 87 SEGUNDOS de "gravando..."
// antes de o lead receber qualquer coisa, e a etapa inteira levava 2,5 minutos.
//
// A REGRA DE AGORA, nas palavras dele ("uns 10 s por item, uns 15 s entre funis, nunca dois audios
// a menos de 10 s um do outro", e "quando eu clicar no funil, ele ja manda o primeiro audio sem
// ficar esperando"):
//
//   PRIMEIRO ITEM DO FUNIL ............. 0 s, sai no clique
//   IMAGEM / VIDEO / DOCUMENTO ......... 0 s (regra dele de 26/10, de pe: "de uma vez so")
//   AUDIO / TEXTO, do segundo em diante  10 s de base
//   ANTERIOR FOI AUDIO LONGO ........... +1 s a cada 6 s acima de 40, teto de 20 s no total
//   IMAGEM LOGO DEPOIS DE AUDIO ........ 60 s, ou a duracao do audio se for menor (04/11/2026)
//   VIDEO LOGO DEPOIS DE AUDIO ......... 30 s, ou a duracao do audio se for menor (07/11/2026)
//
// A conta olha pro audio ANTERIOR, nao pro proximo: o que o lead precisa e de tempo pra OUVIR o que
// acabou de chegar. Era olhar pro proximo que castigava a abertura do funil.
//
// Recorta `respiroDoItem` e `duracaoDoAudio` do proprio `ui/agente.js` e roda. Nada e reescrito aqui.
//   node src/teste-respiro.js
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const fonte = fs.readFileSync(path.join(__dirname, 'ui', 'agente.js'), 'utf8').replace(/\r\n/g, '\n')

function funcao(nome) {
  const i = fonte.indexOf('function ' + nome + '(')
  if (i < 0) return null
  let nivel = 0, viu = false
  for (let k = i; k < fonte.length; k++) {
    const c = fonte[k], n = fonte[k + 1]
    if (c === '/' && n === '/') { k = fonte.indexOf('\n', k); continue }
    if (c === '/' && n === '*') { k = fonte.indexOf('*/', k) + 1; continue }
    if (c === "'" || c === '"' || c === '`') { for (k++; k < fonte.length && fonte[k] !== c; k++) if (fonte[k] === '\\') k++; continue }
    if (c === '{') { nivel++; viu = true }
    else if (c === '}') { nivel--; if (viu && nivel === 0) return fonte.slice(i, k + 1) }
  }
  return null
}

const pecas = { duracaoDoAudio: funcao('duracaoDoAudio'), respiroDoItem: funcao('respiroDoItem') }
const faltam = Object.keys(pecas).filter((k) => !pecas[k])

let ok = 0
const falhas = []
const conta = (nome, certo, det) => {
  if (certo) { ok++; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (det ? '   -> ' + det : '')) }
}
conta('o agente tem as duas funcoes do respiro', !faltam.length, 'faltando: ' + faltam.join(', '))
if (faltam.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1) }

// As CONSTANTES vem do proprio agente, recortadas: se alguem mudar 10 ou 20 la, o teste acompanha
// em vez de mentir.
const CONST = (nome) => {
  const m = fonte.match(new RegExp('var ' + nome + ' = (\\d+)'))
  return m ? Number(m[1]) : null
}
const BASE = CONST('RESPIRO_BASE')
const TETO = CONST('RESPIRO_TETO')
const IMG = CONST('RESPIRO_IMAGEM')
const VID = CONST('RESPIRO_VIDEO')
const ESPERA_TETO = CONST('ESPERA_TETO')
conta('o agente declara a base e o teto do respiro', BASE === 10 && TETO === 20, 'base=' + BASE + ' teto=' + TETO)

function montar({ duracao, falha, mudo }) {
  class Audio {
    constructor() { this.preload = ''; this._src = '' }
    // o agente descarrega com removeAttribute + load() em vez de `src = ''`, que fazia o elemento
    // pedir a URL da PAGINA (um round-trip a toa pela proxy em cada audio do funil)
    removeAttribute() { this._src = '' }
    load() {}
    set src(v) {
      this._src = v
      if (!v) return
      setTimeout(() => {
        if (mudo) return                              // nunca responde: o teto de 4 s tem que salvar
        if (falha) { if (this.onerror) this.onerror(); return }
        this.duration = duracao
        if (this.onloadedmetadata) this.onloadedmetadata()
      }, 5)
    }
    get src() { return this._src }
  }
  const ctx = vm.createContext({ Audio, Promise, setTimeout, clearTimeout, Number, isFinite, String, Math })
  // As constantes vao com os valores RECORTADOS do agente, nao com numeros digitados aqui: se
  // alguem mudar 10 ou 20 la, o teste passa a medir o valor novo em vez de mentir.
  vm.runInContext('var RESPIRO_BASE = ' + BASE + '; var RESPIRO_TETO = ' + TETO + '; var RESPIRO_IMAGEM = ' + IMG + '; var RESPIRO_VIDEO = ' + VID + '; var ESPERA_TETO = ' + ESPERA_TETO + ';\n'
    + pecas.duracaoDoAudio + '\n' + pecas.respiroDoItem + '\nthis.R = respiroDoItem\nthis.D = duracaoDoAudio', ctx)
  return ctx
}

const audio = (dur) => ({ kind: 'audio', dur })
const item = (kind) => ({ tipo: kind === 'texto' ? 'texto' : 'midia', kind: kind === 'texto' ? '' : kind, pausa: 4 })

;(async () => {
  const { R, D } = montar({ duracao: 42 })

  // ── O PRIMEIRO ITEM SAI NO CLIQUE ───────────────────────────────────────────────────────────
  console.log('\nO PRIMEIRO ITEM DO FUNIL')
  conta('o primeiro audio sai na hora, por mais longo que o anterior tenha sido',
    (await R(item('audio'), audio(186), true)) === 0)
  conta('o primeiro texto tambem sai na hora', (await R(item('texto'), audio(186), true)) === 0)
  conta('e sem item anterior nenhum tambem', (await R(item('audio'), null, true)) === 0)

  // ── DO SEGUNDO EM DIANTE: 10 s DE BASE ──────────────────────────────────────────────────────
  console.log('\nDO SEGUNDO ITEM EM DIANTE')
  conta('audio depois de texto espera os 10 s de base',
    (await R(item('audio'), { kind: '', dur: 0 }, false)) === 10)
  conta('texto depois de audio curto espera os 10 s de base',
    (await R(item('texto'), audio(30), false)) === 10)
  // 40 s e o ponto em que o bonus comeca a contar, e a conta e continua dali: o "01 Abertura", de
  // 42 s, da 11 s. Nao arredondo pra 10 de proposito - um degrau seco em 40 faria dois audios de
  // 39 e 41 s terem esperas muito diferentes sem razao nenhuma.
  conta('audio de 42 s atras (o "01 Abertura") da 11 s, um acima da base',
    (await R(item('audio'), audio(42), false)) === 11)
  conta('e audio de exatos 40 s atras fica na base, sem bonus',
    (await R(item('audio'), audio(40), false)) === 10)

  // ── AUDIO LONGO ATRAS: TEMPO PRO LEAD OUVIR ─────────────────────────────────────────────────
  console.log('\nDEPOIS DE UM AUDIO LONGO')
  conta('depois de 60 s de audio sao 14 s', (await R(item('texto'), audio(60), false)) === 14)
  conta('depois de 100 s sao 20 s (bateu o teto)', (await R(item('audio'), audio(100), false)) === 20)
  conta('e o "02 Explicacao" de 186 s nao passa do teto de 20 s',
    (await R(item('audio'), audio(186), false)) === 20)
  conta('o teto segura ate um audio absurdo de 10 min',
    (await R(item('audio'), audio(600), false)) === 20)

  // ── MIDIA SAI DE UMA VEZ SO (regra de 26/10, que fica de pe) ────────────────────────────────
  console.log('\nIMAGEM, VIDEO E DOCUMENTO')
  conta('documento nao espera nada, nem depois de audio longo',
    (await R(item('document'), audio(186), false)) === 0)
  conta('video depois de texto nao espera nada', (await R(item('video'), { kind: '', dur: 0 }, false)) === 0)
  conta('video depois de imagem nao espera nada', (await R(item('video'), { kind: 'image', dur: 0 }, false)) === 0)
  conta('video que abre o funil sai na hora', (await R(item('video'), audio(174), true)) === 0)
  conta('imagem depois de texto nao espera nada', (await R(item('image'), { kind: '', dur: 0 }, false)) === 0)
  conta('imagem depois de outra imagem nao espera nada', (await R(item('image'), { kind: 'image', dur: 0 }, false)) === 0)
  conta('imagem que abre o funil sai na hora', (await R(item('image'), audio(146), true)) === 0)

  // ── A IMAGEM DO PRECO ESPERA O LEAD OUVIR O AUDIO (04/11/2026) ──────────────────────────────
  // "Etapa 4 - Fechamento": audio do valor de 2min26 e logo depois a imagem com R$ 497. O Bruno
  // pediu "mais ou menos 1 minuto de tempo para escutar o audio" antes da imagem.
  console.log('\nIMAGEM LOGO DEPOIS DE AUDIO')
  conta('o agente declara a espera da imagem em 60 s', IMG === 60, 'RESPIRO_IMAGEM=' + IMG)
  conta('depois do audio do valor (146 s) a imagem espera 60 s', (await R(item('image'), audio(146), false)) === 60)
  conta('audio de 30 s atras: espera so os 30 s dele', (await R(item('image'), audio(30), false)) === 30)
  conta('audio de 42,3 s arredonda pra cima (43)', (await R(item('image'), audio(42.3), false)) === 43)
  conta('audio que nao disse a duracao: espera o minuto cheio', (await R(item('image'), audio(0), false)) === 60)

  // ── O PRIMEIRO VIDEO ESPERA O LEAD DAR PLAY NO AUDIO (07/11/2026) ───────────────────────────
  // "Etapa 3 - Provas Sociais" (H e M): audio "03 Provas Sociais" de 173,8 s (medido no arquivo),
  // tres videos e o audio "04" de 33,5 s. O Guilherme viu o lead clicar nos videos antes de ouvir o
  // audio e pediu "uns 30s no maximo" antes dos videos. Abaixo, a etapa inteira passo a passo.
  console.log('\nVIDEO LOGO DEPOIS DE AUDIO (a Etapa 3, passo a passo)')
  conta('o agente declara a espera do video em 30 s', VID === 30, 'RESPIRO_VIDEO=' + VID)
  conta('passo 1: o audio "03 Provas Sociais" sai no clique', (await R(item('audio'), null, true)) === 0)
  conta('passo 2: o primeiro video espera 30 s depois desse audio', (await R(item('video'), audio(173.8), false)) === 30)
  conta('passos 3 e 4: os outros videos saem logo atras, sem espera', (await R(item('video'), { kind: 'video', dur: 0 }, false)) === 0)
  conta('passo 5: o audio "04" depois do video fica nos 10 s de base', (await R(item('audio'), { kind: 'video', dur: 0 }, false)) === 10)
  conta('audio de 20 s atras: o video espera so os 20 dele', (await R(item('video'), audio(20), false)) === 20)
  conta('audio de 12,2 s arredonda pra cima (13)', (await R(item('video'), audio(12.2), false)) === 13)
  conta('audio que nao disse a duracao: o video espera os 30 s cheios', (await R(item('video'), audio(0), false)) === 30)
  conta('a imagem depois de audio continua com o minuto dela', (await R(item('image'), audio(173.8), false)) === 60)

  // ── O TEMPO QUE O VENDEDOR ESCOLHEU NO FUNIL DELE (05/11/2026) ──────────────────────────────
  console.log('\nO TEMPO ESCOLHIDO NO FUNIL DO VENDEDOR')
  const comEspera = (kind, s) => ({ ...item(kind), espera: s })
  conta('o agente declara o teto da espera escolhida em 120 s', ESPERA_TETO === 120, 'ESPERA_TETO=' + ESPERA_TETO)
  conta('texto com 30 s escolhidos espera 30, nao os 10 da regra', (await R(comEspera('texto', 30), { kind: '', dur: 0 }, false)) === 30)
  conta('audio com 5 s escolhidos espera 5, mesmo depois de audio longo', (await R(comEspera('audio', 5), audio(186), false)) === 5)
  conta('video com 20 s escolhidos espera 20 (a regra seria 0)', (await R(comEspera('video', 20), { kind: 'video', dur: 0 }, false)) === 20)
  conta('video com 10 s escolhidos depois de audio espera 10, nao os 30 da regra', (await R(comEspera('video', 10), audio(174), false)) === 10)
  conta('imagem com 0 escolhido sai na hora, mesmo depois de audio', (await R(comEspera('image', 0), audio(146), false)) === 0)
  conta('video com 0 escolhido sai na hora, mesmo depois de audio', (await R(comEspera('video', 0), audio(174), false)) === 0)
  conta('espera absurda para no teto de 120', (await R(comEspera('texto', 9999), null, false)) === 120)
  conta('espera negativa vira zero', (await R(comEspera('texto', -5), null, false)) === 0)
  conta('o primeiro item sai no clique mesmo com tempo escolhido', (await R(comEspera('texto', 30), null, true)) === 0)
  conta('automatico (null) segue a regra: imagem depois de audio = 60', (await R(comEspera('image', null), audio(146), false)) === 60)
  conta('automatico (null) segue a regra: video depois de audio = 30', (await R(comEspera('video', null), audio(174), false)) === 30)
  conta('espera vazia ("") tambem e automatico', (await R(comEspera('texto', ''), { kind: '', dur: 0 }, false)) === 10)

  // O main corta o envio que passa do teto dele ("o numero nao respondeu a tempo"). A imagem nao
  // tem espera no teto do main (so a pausa do passo), entao os 60 s tem que caber no tempo de envio
  // dela, com folga pro upload pela proxy. Recortado do main.js, nao digitado aqui.
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
  const iT = main.indexOf('function tetoDoItem(')
  const fT = iT < 0 ? -1 : main.indexOf('\n}\n', iT)
  const tetoDoItem = fT < 0 ? null : new Function(main.slice(iT, fT + 2) + '\nreturn tetoDoItem')()
  const tetoImg = tetoDoItem ? tetoDoItem({ tipo: 'midia', kind: 'image', pausa: 0 }) : 0
  conta('o teto do app pra imagem cabe os 60 s com pelo menos 1 min pro upload',
    tetoImg >= (IMG + 60) * 1000, 'teto=' + tetoImg + 'ms')
  // O video tambem nao tem espera no teto do main, mas o tempo de envio dele e o maior (180 s), entao
  // os 30 s cabem sem build novo do app: a regra sai so pelo agente no R2.
  const tetoVid = tetoDoItem ? tetoDoItem({ tipo: 'midia', kind: 'video', pausa: 0 }) : 0
  conta('o teto do app pra video cabe os 30 s com pelo menos 2 min pro upload',
    tetoVid >= (VID + 120) * 1000, 'teto=' + tetoVid + 'ms')
  for (const k of ['texto', 'audio', 'image', 'video']) {
    const it = { tipo: k === 'texto' ? 'texto' : 'midia', kind: k === 'texto' ? '' : k, pausa: 0, espera: ESPERA_TETO }
    const sem = { ...it, espera: null }
    const t1 = tetoDoItem ? tetoDoItem(it) : 0
    const t0 = tetoDoItem ? tetoDoItem(sem) : 0
    conta('o teto do app pra ' + k + ' cresce com a espera maxima escolhida (' + ESPERA_TETO + ' s)',
      t1 - t0 >= (ESPERA_TETO - 30) * 1000 && t1 >= (ESPERA_TETO + 50) * 1000, 'sem=' + t0 + ' com=' + t1)
  }

  // ── A MEDIDA DA DURACAO, que e o que alimenta a conta acima ─────────────────────────────────
  console.log('\nA DURACAO DO AUDIO (e o que o item SEGUINTE usa)')
  conta('le a duracao do arquivo', (await D('data:audio/ogg;base64,AA')) === 42)
  const semDuracao = montar({ duracao: 0 })
  conta('arquivo que diz zero devolve zero (e o seguinte cai nos 10 s de base)',
    (await semDuracao.D('data:audio/ogg;base64,AA')) === 0)
  const quebrado = montar({ falha: true })
  conta('arquivo que falha devolve zero em vez de travar',
    (await quebrado.D('data:audio/ogg;base64,AA')) === 0)
  const travado = montar({ mudo: true })
  const t0 = Date.now()
  const r = await travado.D('data:audio/ogg;base64,AA')
  const gasto = Date.now() - t0
  conta('arquivo que nunca responde desiste em ~4 s em vez de prender o funil',
    r === 0 && gasto >= 3500 && gasto < 6000, 'devolveu ' + r + ' em ' + gasto + 'ms')

  // ── E O ENTRE-FUNIS TEM QUE SER MAIOR QUE A JANELA DO AGENTE ────────────────────────────────
  // E assim que o agente sabe que um item e comeco de funil: nenhum item daquela conversa terminou
  // nos ultimos JANELA_FUNIL. Se o respiro entre funis encolher pra menos que isso, o primeiro item
  // do funil seguinte volta a esperar - que e exatamente o que o Bruno mandou tirar.
  console.log('\nA AMARRA ENTRE O AGENTE E O PAINEL')
  const janela = Number((fonte.match(/var JANELA_FUNIL = (\d+)/) || [])[1])
  const painel = fs.readFileSync(path.join(__dirname, 'ui', 'painel-ui.js'), 'utf8')
  const entre = Number((painel.match(/const ENTRE_FUNIS_MS = (\d+)/) || [])[1])
  conta('o respiro entre funis e maior que a janela que o agente usa pra achar o comeco',
    entre > janela, 'entre funis=' + entre + 'ms, janela=' + janela + 'ms')

  // ── O NOME DO DOCUMENTO QUE O LEAD RECEBE (05/11/2026) ──────────────────────────────────────
  // O WhatsApp manda o nome do jeito que vier: sem a extensao, "Bula do produto" chegava sem cara
  // de PDF. Recorta a tabela e a funcao do proprio agente.
  console.log('\nO NOME DO DOCUMENTO')
  const tabela = (fonte.match(/var EXT_DOC = \{[\s\S]*?\n {2}\}/) || [])[0]
  const fnNome = funcao('nomeDoDocumento')
  conta('o agente tem a tabela de extensoes e a funcao do nome', !!tabela && !!fnNome)
  if (tabela && fnNome) {
    const N = vm.runInNewContext(tabela + '\n' + fnNome + '\nnomeDoDocumento')
    const PDF = 'data:application/pdf;base64,JVBERi0='
    conta('PDF sem extensao ganha ".pdf"', N('Bula do produto', PDF) === 'Bula do produto.pdf', N('Bula do produto', PDF))
    conta('quem ja tem ".pdf" (qualquer caixa) nao ganha outro', N('Contrato.PDF', PDF) === 'Contrato.PDF', N('Contrato.PDF', PDF))
    conta('Word ganha ".docx" pelo tipo do arquivo, nao pelo nome', N('Termo', 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEs=') === 'Termo.docx')
    conta('barra, dois pontos e aspas saem do nome', N('a/b: "c"', PDF) === 'a b c.pdf', N('a/b: "c"', PDF))
    conta('sem nome vira "documento.pdf"', N('', PDF) === 'documento.pdf', N('', PDF))
    conta('tipo desconhecido fica sem extensao inventada', N('Arquivo', 'data:application/zip;base64,UEs=') === 'Arquivo', N('Arquivo', 'data:application/zip;base64,UEs='))
  }

  console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
  process.exit(falhas.length ? 1 : 0)
})()
