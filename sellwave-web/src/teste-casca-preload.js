// Preload FALSO da CASCA (a barra lateral), pro teste do index.html. Responde no lugar do processo
// principal e guarda o que foi chamado pra o teste conferir.
const { contextBridge, ipcRenderer } = require('electron')   // eslint-disable-line no-unused-vars

const chamadas = []
let barraEncolhida = false
let painelLigado = true

const ESTADO = () => ({
  temToken: true, nome: 'Bruno Correa', versao: '1.5.0', como: '',
  direcao: true, travaProxy: true, exigirBrasil: true,
  abertos: ['1574060653'], barraEncolhida, painelLigado,
  numeros: [
    { numero: '5511966632248', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 1, st: 'bateu' }, leads_hoje: 70, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    { numero: '5519995983293', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 2, st: 'vez' }, leads_hoje: 32, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    { numero: '5515974060653', dono: 'Heynan Dantas', roleta: false, dist: 'roleta', leads_hoje: 0, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    // em aquecimento: area propria e interruptor liberado
    { numero: '5515974068551', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 1, st: 'vez' }, leads_hoje: 3, lim_dia: 5, cor: '', st: 'aquecimento', aquec: { dia: 1, teto: 5, agora: 2 } },
    // estado que NAO recebe: sem interruptor
    { numero: '5515977001122', dono: 'Guilherme', roleta: false, dist: 'roleta', leads_hoje: 0, lim_dia: 0, cor: '', st: 'ativo', em_uso: false, apto: false, status: 'Em análise' },
    // O SERVIDOR REPROVOU, mas o campo cru `em_uso` ficou true parado (ex: tag virou Restrito e
    // ninguem limpou o campo). Quem manda e o `apto`: o interruptor NAO pode aparecer.
    { numero: '5515977003344', dono: 'Guilherme', roleta: false, dist: 'roleta', leads_hoje: 0, lim_dia: 0, cor: '', st: 'ativo', em_uso: true, apto: false, status: 'Restrito' },
  ],
  vendedores: [],
})

contextBridge.exposeInMainWorld('sw', {
  estado: () => { chamadas.push({ nome: 'estado' }); return Promise.resolve(ESTADO()) },
  barra: (encolhida) => { chamadas.push({ nome: 'barra', args: [encolhida] }); barraEncolhida = !!encolhida; return Promise.resolve({ ok: true, encolhida: barraEncolhida }) },
  painel: (ligado) => { chamadas.push({ nome: 'painel', args: [ligado] }); painelLigado = ligado !== false; return Promise.resolve({ ok: true, ligado: painelLigado }) },
  abrir: (n) => { chamadas.push({ nome: 'abrir', args: [n] }); return Promise.resolve({ ok: true }) },
  fechar: (n) => { chamadas.push({ nome: 'fechar', args: [n] }); return Promise.resolve({ ok: true }) },
  roleta: (n, l) => { chamadas.push({ nome: 'roleta', args: [n, l] }); return Promise.resolve({ ok: true }) },
  entrar: () => Promise.resolve({ ok: true }),
  sair: () => Promise.resolve({ ok: true }),
  verComo: () => Promise.resolve({ ok: true }),
  proxy: () => Promise.resolve({ ok: true }),
  trava: () => Promise.resolve({ ok: true }),
  abrirLog: () => Promise.resolve({ ok: true }),
  abrirInstalador: () => Promise.resolve({ ok: true }),
  // Os que a casca chama e o teste nao exercita direto. Faltar UM aqui quebra a tela inteira com
  // "x is not a function", que foi o que este teste pegou na primeira rodada.
  numeros: () => Promise.resolve({ ok: true, numeros: ESTADO().numeros }),
  esconder: () => Promise.resolve({ ok: true }),
  mostrar: () => Promise.resolve({ ok: true }),
  teto: () => Promise.resolve({ ok: true }),
  ao: () => {},
})
// Ver a nota no teste-painel-preload: array exposto direto nasce congelado.
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
// Pra o teste poder simular o que o processo principal devolveria depois de esconder o painel.
contextBridge.exposeInMainWorld('__painelOff', () => { painelLigado = false })
