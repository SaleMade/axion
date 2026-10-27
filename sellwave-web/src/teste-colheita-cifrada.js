// A COLHEITA TEM QUE TRAZER A LEGIVEL DO ID QUE SAIU CIFRADO (27/10/2026).
//
// O QUE O VENDEDOR VE: a conversa na lista do WhatsApp com "Aguardando mensagem. Abra o WhatsApp no
// seu celular". O WhatsApp Web recebeu a mensagem e NAO conseguiu decifrar; o aparelho reenvia
// depois, as vezes meia hora depois, e a versao legivel chega com O MESMO id.
//
// O agente, depois de esperar 6 s, manda a cifrada mesmo (perder o lead seria pior). Dali em diante
// a colheita - que e a rede de seguranca, relendo as conversas de 2 em 2 min - pulava esse id
// porque ele ja estava em `entregues`, o registro do que o SERVIDOR confirmou. Ou seja: a unica
// parte do sistema que rele a conversa inteira estava proibida de trazer justamente a mensagem que
// faltava. A conversa ficava vazia na dash pra sempre.
//
// MEDIDO em 27/10 no (15) 97400-8709: 7 de 7 mensagens recebidas entre 09:41 e 09:52 nessa situacao,
// com 58 cliques pagos naquela hora. No banco inteiro: 70 linhas cifradas, 43 telefones com a
// conversa vazia e 12 que nunca viraram lead.
//
// Recorta a `faltamNaDash` do proprio main.js e roda. Nada e reescrito aqui.
//   node src/teste-colheita-cifrada.js
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const fonte = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\r\n/g, '\n')

// Mesmo recorte do teste-varredura: acha `function nome(` e fecha nas chaves, pulando comentario e
// texto entre aspas pra nao contar chave que esta dentro de string.
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

let ok = 0
const falhas = []
const conta = (nome, certo, det) => {
  if (certo) { ok++; console.log('  ok    ' + nome) }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (det ? '   -> ' + det : '')) }
}

const corpo = funcao('faltamNaDash')
conta('o main tem a regra do que falta na dash', !!corpo)
if (!corpo) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1) }

const AGORA = 1_700_000_000_000
// `entregues` guarda o que o SERVIDOR confirmou; `cifradas` e o subconjunto que foi confirmado com
// o corpo cifrado. `filaCaptura` e o que ainda esta esperando pra sair.
function filtra({ evs, entregues = [], cifradas = [], fila = [] }) {
  const ctx = {
    Map, Set, Number, String, Date,
    entregues: new Map(entregues.map((id) => [String(id), AGORA])),
    cifradas: new Set(cifradas.map(String)),
    filaCaptura: fila,
    __evs: evs, __agora: AGORA, __out: null,
  }
  vm.createContext(ctx)
  vm.runInContext(corpo + '\n__out = faltamNaDash(__evs, __agora)', ctx)
  return ctx.__out.map((e) => e.msgId)
}

const cifrada = { msgId: 'MSG2', type: 'ciphertext', body: '' }
const legivel = { msgId: 'MSG2', type: 'text', body: 'Olá! Código de desconto Au3fte' }
const outra = { msgId: 'MSG9', type: 'text', body: 'quanto custa' }

console.log('\nO QUE A COLHEITA LEVA')
conta('mensagem que o servidor nunca confirmou vai',
  filtra({ evs: [outra] }).join() === 'MSG9')
conta('mensagem ja confirmada nao vai de novo',
  filtra({ evs: [outra], entregues: ['MSG9'] }).length === 0)
conta('mensagem na fila ha pouco tempo fica pra fila, nao duplica',
  filtra({ evs: [outra], fila: [{ msgId: 'MSG9', __em: AGORA - 10_000 }] }).length === 0)
conta('mas presa na fila ha mais de 5 min a colheita manda de novo',
  filtra({ evs: [outra], fila: [{ msgId: 'MSG9', __em: AGORA - 10 * 60_000 }] }).join() === 'MSG9')

console.log('\nA CIFRADA QUE VIROU LEGIVEL')
conta('a legivel do id que foi entregue CIFRADO passa, e esse e o conserto',
  filtra({ evs: [legivel], entregues: ['MSG2'], cifradas: ['MSG2'] }).join() === 'MSG2',
  JSON.stringify(filtra({ evs: [legivel], entregues: ['MSG2'], cifradas: ['MSG2'] })))
conta('e a mesma cifrada NAO volta: repetir balao vazio nao conserta nada',
  filtra({ evs: [cifrada], entregues: ['MSG2'], cifradas: ['MSG2'] }).length === 0)
conta('id entregue com texto de verdade continua sem voltar',
  filtra({ evs: [legivel], entregues: ['MSG2'], cifradas: [] }).length === 0)
conta('a excecao e so do id certo: outro id confirmado nao vem junto',
  filtra({ evs: [outra], entregues: ['MSG9'], cifradas: ['MSG2'] }).length === 0)
conta('numa mesma colheita, a legivel passa e a repetida do mesmo lote nao',
  filtra({ evs: [legivel, legivel], entregues: ['MSG2'], cifradas: ['MSG2'] }).join() === 'MSG2',
  JSON.stringify(filtra({ evs: [legivel, legivel], entregues: ['MSG2'], cifradas: ['MSG2'] })))
conta('evento sem id nunca passa (sem id o servidor nao tem como deduplicar)',
  filtra({ evs: [{ type: 'text', body: 'oi' }] }).length === 0)

console.log('\nO MAIN ANOTA E ESQUECE NA HORA CERTA')
// As duas linhas que mantem o conjunto `cifradas` vivo moram no recebimento do evento e na poda do
// registro. Recortadas daqui pra garantir que uma mudanca no main nao deixe o conjunto crescer pra
// sempre nem esquecer antes da hora.
const anota = fonte.includes("cifradas.add(String(ev.msgId)); entreguesSujo = true")
const esquece = fonte.includes("cifradas.delete(String(ev.msgId))")
const poda = fonte.includes("{ entregues.delete(id); cifradas.delete(id) }")
const grava = fonte.includes("cifradas: [...cifradas]")
conta('o main anota o id que saiu cifrado', anota)
conta('e esquece quando a legivel do mesmo id passa', esquece)
conta('a poda de 26 h limpa os dois juntos, senao o conjunto so cresce', poda)
conta('e o registro vai pro disco, pra sobreviver a um reinicio do app', grava)

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados')
process.exit(falhas.length ? 1 : 0)
