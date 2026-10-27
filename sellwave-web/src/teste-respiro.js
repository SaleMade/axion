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
  vm.runInContext('var RESPIRO_BASE = ' + BASE + '; var RESPIRO_TETO = ' + TETO + ';\n'
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
  for (const k of ['image', 'video', 'document']) {
    conta(k + ' nao espera nada, nem depois de audio longo',
      (await R(item(k), audio(186), false)) === 0)
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

  console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
  process.exit(falhas.length ? 1 : 0)
})()
