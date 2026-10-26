// O RESPIRO DE CADA PASSO DO FUNIL (26/10/2026, regra ditada pelo Bruno).
//
// Palavras dele: "cada vez que um dos audios e enviado, ele espera sempre metade do tempo do
// proximo audio para ser enviado. Por exemplo, eu enviei um audio de 10 segundos, e o proximo
// tambem e de 10 segundos. Entao eu vou esperar 5 segundos para que ele seja enviado. (...) Sobre
// imagens, documentos ou videos, eu quero que eles sejam enviados de uma vez so (...) voce nao
// precisa ter tempo."
//
// Recorta as DUAS funcoes do proprio `ui/agente.js` e roda com um Audio de mentira. Elas vivem
// dentro da pagina do WhatsApp, entao nao da pra importar: o recorte e o jeito de testar o codigo
// que vai de verdade, e nao uma copia dele.
//   node src/teste-respiro.js
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const fonte = fs.readFileSync(path.join(__dirname, 'ui', 'agente.js'), 'utf8').replace(/\r\n/g, '\n')

// Recorta "function <nome>(" ate a chave que fecha, contando chaves e pulando string e comentario.
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

// O Audio de mentira: entrega a duracao que o teste mandar, ou falha, ou nunca responde.
function montar({ duracao, falha, mudo }) {
  class Audio {
    constructor() { this.preload = ''; this._src = '' }
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
  const ctx = vm.createContext({ Audio, Promise, setTimeout, clearTimeout, Number, isFinite, String })
  vm.runInContext(pecas.duracaoDoAudio + '\n' + pecas.respiroDoItem + '\nthis.R = respiroDoItem', ctx)
  return ctx.R
}

;(async () => {
  // ── AUDIO: metade da duracao ────────────────────────────────────────────────────────────────
  let R = montar({ duracao: 10 })
  conta('audio de 10s espera 5s, que e o exemplo que ele deu',
    (await R({ tipo: 'midia', kind: 'audio', pausa: 3 }, 'data:audio/ogg;base64,AA')) === 5)

  R = montar({ duracao: 186 })
  conta('o audio mais longo do roteiro (186s) espera 93s',
    (await R({ tipo: 'midia', kind: 'audio', pausa: 3 }, 'data:audio/ogg;base64,AA')) === 93)

  R = montar({ duracao: 42 })
  const r42 = await R({ tipo: 'midia', kind: 'audio', pausa: 3 }, 'data:audio/ogg;base64,AA')
  conta('e a regra NAO usa mais o numero do roteiro: 42s de audio da 21s, nao os 3s do passo',
    r42 === 21, String(r42))

  // ── MIDIA: sem pausa nenhuma ────────────────────────────────────────────────────────────────
  R = montar({ duracao: 30 })
  const mids = []
  for (const k of ['image', 'video', 'document']) {
    mids.push(await R({ tipo: 'midia', kind: k, pausa: 15 }, 'data:x;base64,AA'))
  }
  conta('imagem, video e documento saem de uma vez, sem pausa', mids.every((x) => x === 0), JSON.stringify(mids))

  // ── TEXTO: continua com o que esta no passo do roteiro ──────────────────────────────────────
  conta('texto continua com o tempo que ele configurou no funil',
    (await R({ tipo: 'texto', pausa: 7 })) === 7)
  conta('e texto sem tempo configurado nao inventa pausa',
    (await R({ tipo: 'texto' })) === 0)

  // ── QUANDO NAO DA PRA LER A DURACAO ─────────────────────────────────────────────────────────
  R = montar({ falha: true })
  conta('audio que nao abre cai no tempo do passo, em vez de sair sem pausa nenhuma',
    (await R({ tipo: 'midia', kind: 'audio', pausa: 6 }, 'data:audio/ogg;base64,AA')) === 6)

  R = montar({ duracao: 0 })
  conta('audio que diz duracao zero tambem cai no tempo do passo',
    (await R({ tipo: 'midia', kind: 'audio', pausa: 4 }, 'data:audio/ogg;base64,AA')) === 4)

  // O teto de 4s: audio que nunca responde nao pode segurar o funil pra sempre.
  R = montar({ mudo: true })
  const t0 = Date.now()
  const r = await R({ tipo: 'midia', kind: 'audio', pausa: 5 }, 'data:audio/ogg;base64,AA')
  const levou = Date.now() - t0
  conta('audio que nunca responde desiste em ~4s e usa o tempo do passo',
    r === 5 && levou >= 3900 && levou < 6000, 'devolveu ' + r + ' em ' + levou + 'ms')

  console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
  process.exit(falhas.length ? 1 : 0)
})()
