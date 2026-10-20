// Preload FALSO da CASCA (a barra lateral), pro teste do index.html. Responde no lugar do processo
// principal e guarda o que foi chamado pra o teste conferir.
const { contextBridge, ipcRenderer } = require('electron')   // eslint-disable-line no-unused-vars

const chamadas = []
let barraEncolhida = false
let painelLigado = true
// AS TRAVAS E O TETO RESPONDEM DE VERDADE desde 17/10: a tela dos Ajustes passou a pintar o estado
// (trava desligada fica ambar), e stub que devolve sempre a mesma coisa nunca deixaria o teste ver
// a troca de cor. O mesmo vale pro teto, que agora tem botoes de mais e menos.
let maxAbertos = 6

const ESTADO = () => ({
  temToken: true, nome: 'Bruno Correa', versao: '1.5.0', como: '',
  // Os dois campos vem SEMPRE TRUE, como o main.js real manda desde que viraram constante.
  direcao: true, travaProxy: true, exigirBrasil: true, maxAbertos,
  abertos: ['1574060653'], barraEncolhida, painelLigado,
  // o numero aberto (e fora da tela) tem 3 conversas esperando: a lista mostra o contador (20/10/2026)
  naoLidas: { '1574060653': 3 },
  numeros: [
    { numero: '5511966632248', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 1, st: 'bateu' }, leads_hoje: 70, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    { numero: '5519995983293', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 2, st: 'vez' }, leads_hoje: 32, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    // LIGADO E SEM APP ABERTO (19/10/2026): o interruptor esta ligado (`ligado`), mas ninguem tem o numero aberto,
    // entao `roleta` (recebe agora) e falso. A chave tem que aparecer LIGADA.
    { numero: '5515974060653', dono: 'Heynan Dantas', roleta: false, ligado: true, vivo: false, dist: 'roleta', leads_hoje: 0, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    // em aquecimento: area propria e interruptor liberado
    // lim_dia ZERO de proposito: o teto de quem aquece vem da RAMPA (`aquec.teto`), nao do campo do
    // chip. Era assim que o 8551 aparecia na tela do Bruno, e por isso ele ficava sem contador.
    { numero: '5515974068551', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 1, st: 'vez' }, leads_hoje: 3, lim_dia: 0, cor: '', st: 'aquecimento', aquec: { dia: 3, teto: 5, agora: 2 } },
    // estado que NAO recebe: sem interruptor
    { numero: '5515977001122', dono: 'Guilherme', roleta: false, dist: 'roleta', leads_hoje: 0, lim_dia: 0, cor: '', st: 'ativo', em_uso: false, apto: false, status: 'Em análise' },
    // O SERVIDOR REPROVOU, mas o campo cru `em_uso` ficou true parado (ex: tag virou Restrito e
    // ninguem limpou o campo). Quem manda e o `apto`: o interruptor NAO pode aparecer.
    { numero: '5515977003344', dono: 'Guilherme', roleta: false, dist: 'roleta', leads_hoje: 0, lim_dia: 0, cor: '', st: 'ativo', em_uso: true, apto: false, status: 'Restrito' },
    // AQUECENDO E JA PEGOU A COTA DESTA HORA (fila.st 'bateu'). O teto do DIA e 20 e ele tem 7, ou
    // seja nao bateu limite nenhum: a rampa libera a cota aos poucos e ele volta na hora seguinte.
    // E o caso que fazia o app escrever "recebendo" o dia inteiro, antes de o worker passar a
    // carimbar a fila de quem aquece.
    { numero: '5515977005566', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 1, st: 'bateu' }, leads_hoje: 7, lim_dia: 0, cor: '', st: 'aquecimento', aquec: { dia: 8, teto: 20, agora: 7 } },
  ],
  vendedores: [],
})

contextBridge.exposeInMainWorld('sw', {
  estado: () => { chamadas.push({ nome: 'estado' }); return Promise.resolve(ESTADO()) },
  barra: (encolhida) => { chamadas.push({ nome: 'barra', args: [encolhida] }); barraEncolhida = !!encolhida; return Promise.resolve({ ok: true, encolhida: barraEncolhida }) },
  painel: (ligado) => { chamadas.push({ nome: 'painel', args: [ligado] }); painelLigado = ligado !== false; return Promise.resolve({ ok: true, ligado: painelLigado }) },
  abrir: (n) => { chamadas.push({ nome: 'abrir', args: [n] }); return Promise.resolve({ ok: true }) },
  destacar: (numero, nk) => { chamadas.push({ nome: 'destacar', args: [numero, nk] }); return Promise.resolve({ ok: true }) },
  devolver: (nk) => { chamadas.push({ nome: 'devolver', args: [nk] }); return Promise.resolve({ ok: true }) },
  fechar: (n) => { chamadas.push({ nome: 'fechar', args: [n] }); return Promise.resolve({ ok: true }) },
  // O 5566 RECUSA de proposito: e o caso em que a chave tem que voltar e dizer por que.
  roleta: (n, l) => { chamadas.push({ nome: 'roleta', args: [n, l] }); return new Promise((r) => setTimeout(() => r(n === '1577005566' ? { ok: false, erro: 'recusado no teste' } : { ok: true }), 300)) },
  entrar: () => Promise.resolve({ ok: true }),
  sair: () => { chamadas.push({ nome: 'sair' }); return Promise.resolve({ ok: true }) },
  verComo: () => Promise.resolve({ ok: true }),
  proxy: () => Promise.resolve({ ok: true }),
  // O `trava` SAIU DO DUBLE junto com a ponte de verdade (17/10/2026): duble que oferece o que o
  // preload real nao tem faz o teste "nao existe jeito de desligar" passar por sorte do lado errado.
  abrirLog: () => Promise.resolve({ ok: true }),
  abrirInstalador: () => Promise.resolve({ ok: true }),
  // Os que a casca chama e o teste nao exercita direto. Faltar UM aqui quebra a tela inteira com
  // "x is not a function", que foi o que este teste pegou na primeira rodada.
  numeros: () => { chamadas.push({ nome: 'numeros' }); return Promise.resolve({ ok: true, numeros: ESTADO().numeros }) },
  esconder: () => { chamadas.push({ nome: 'esconder' }); return Promise.resolve({ ok: true }) },
  mostrar: () => { chamadas.push({ nome: 'mostrar' }); return Promise.resolve({ ok: true }) },
  teto: (v) => {
    chamadas.push({ nome: 'teto', args: [v] })
    maxAbertos = Math.max(1, Math.min(20, Number(v) || 6))
    return Promise.resolve({ ok: true, maxAbertos })
  },
  ao: () => {},
})
// Ver a nota no teste-painel-preload: array exposto direto nasce congelado.
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
// Pra o teste poder simular o que o processo principal devolveria depois de esconder o painel.
contextBridge.exposeInMainWorld('__painelOff', () => { painelLigado = false })
// O PROPRIO STUB, pro teste contar a partir dele em vez de repetir o numero na mao. Expectativa
// escrita a mao quebra toda vez que a lista cresce, e quem le o erro acha que quebrou alguma coisa
// de verdade - ja aconteceu duas vezes aqui.
contextBridge.exposeInMainWorld('__stub', () => JSON.parse(JSON.stringify(ESTADO())))
