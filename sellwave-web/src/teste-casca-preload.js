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
// AS FOTOS DA EQUIPE (23/10/2026): comecam VAZIAS, como no app de verdade (o main baixa depois da
// lista chegar e avisa por 'sw:fotos'). O teste chama __fotosChegaram e confere que a barra redesenha.
const URL_FOTO_GUI = 'https://axion-api.axion-dash.workers.dev/api/users/foto/a1/h1'
let fotos = {}
const ouvintes = {}
// O CRM DO ATENDIMENTO (23/10/2026): o quadro que o /api/wa/crm devolveria. Um card por etapa e dois
// em Lead Novo; Em Atendimento passa do limite (1.234 no total, 1 na tela) pra conferir o rodape.
const agoraS = Math.floor(Date.now() / 1000)
const CRM = {
  ok: true, sig: 's1', lim: 200,
  totais: { novo: 2, atendimento: 1234, qualificado: 1, fechou: 1 },
  cards: [
    { phone: '5516982508480', instance: 'ax_atendente_vra3lh_92503977', name: 'Zélia Souza', last_text: '[ptt]', last_ts: agoraS - 300, unread: 2, crm_stage: 'novo' },
    { phone: '554598094898', instance: 'ax_atendente_vra3lh_77001122', name: '', last_text: 'Quero saber o preço', last_ts: agoraS - 600, unread: 0, crm_stage: 'novo' },
    { phone: '558481093434', instance: 'ax_atendente_vra3lh_66632248', name: 'Joana Lima', last_text: 'Oi', last_ts: agoraS - 900, unread: 0, crm_stage: 'atendimento' },
    { phone: '553398306226', instance: 'ax_atendente_vra3lh_95983293', name: 'Cleuza Helena', last_text: 'ok', last_ts: agoraS - 1200, unread: 0, crm_stage: 'qualificado' },
    { phone: '5511950238615', instance: 'ax_atendente_vra3lh_95983293', name: 'Maria do Carmo', last_text: 'Segue o contato', last_ts: agoraS - 1500, unread: 0, crm_stage: 'fechou' },
  ],
}
let MARCACAO = { prontos: 1, em: Date.now(), faltavam: 0, numeros: 1 }

const ESTADO = () => ({
  temToken: true, nome: 'Bruno Correa', versao: '1.5.0', como: '',
  // Os dois campos vem SEMPRE TRUE, como o main.js real manda desde que viraram constante.
  direcao: true, travaProxy: true, exigirBrasil: true, maxAbertos,
  abertos: ['1574060653'], barraEncolhida, painelLigado,
  // o numero aberto (e fora da tela) tem 3 conversas esperando: a lista mostra o contador (20/10/2026)
  naoLidas: { '1574060653': 3 },
  fotos,
  crm: { x: 268, width: 640, faixa: 34, aberto: false },
  marcacao: MARCACAO,
  // o placar de hoje: Guilherme tem foto, o Heynan nao (sai a sigla), e quem esta logado e o Heynan
  equipe: [
    { id: 'a1', nome: 'Guilherme Souza', foto: URL_FOTO_GUI, sigla: 'GS', cor: '#24c278', leads: 112, eu: false },
    { id: 'a2', nome: 'Heynan Dantas', foto: '', sigla: 'HD', cor: '#7c3aed', leads: 0, eu: true },
  ],
  numeros: [
    { numero: '5511966632248', dono: 'Guilherme', foto: URL_FOTO_GUI, sigla: 'GS', corDono: '#24c278', roleta: true, dist: 'limite', fila: { pos: 1, st: 'bateu' }, leads_hoje: 70, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    { numero: '5519995983293', dono: 'Guilherme', roleta: true, dist: 'limite', fila: { pos: 2, st: 'vez' }, leads_hoje: 32, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
    // LIGADO E SEM APP ABERTO (19/10/2026): o interruptor esta ligado (`ligado`), mas ninguem tem o numero aberto,
    // entao `roleta` (recebe agora) e falso. A chave tem que aparecer LIGADA.
    { numero: '5515974060653', dono: 'Heynan Dantas', foto: '', sigla: 'HD', corDono: '#7c3aed', roleta: false, ligado: true, vivo: false, dist: 'roleta', leads_hoje: 0, lim_dia: 70, cor: '', em_uso: true, st: 'ativo' },
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
  ao: (canal, fn) => { (ouvintes[canal] = ouvintes[canal] || []).push(fn) },
  crmAbrir: (aberto) => { chamadas.push({ nome: 'crmAbrir', args: [aberto] }); return Promise.resolve({ ok: true, aberto }) },
  crmDados: (periodo, sig) => { chamadas.push({ nome: 'crmDados', args: [periodo, sig] }); return Promise.resolve(sig === CRM.sig ? { ok: true, igual: true, sig, marcacao: MARCACAO } : { ...JSON.parse(JSON.stringify(CRM)), marcacao: MARCACAO }) },
  // O 4898 RECUSA de proposito: e o caso em que o card tem que voltar pra onde estava.
  crmEtapa: (fone, etapa) => { chamadas.push({ nome: 'crmEtapa', args: [fone, etapa] }); return new Promise((r) => setTimeout(() => r(fone === '554598094898' ? { ok: false, erro: 'Sem acesso a essa conversa' } : { ok: true }), 120)) },
  // O numero do 4898 (77001122) esta FECHADO nesta maquina: o main manda a casca abrir ele.
  crmConversa: (fone, instancia) => { chamadas.push({ nome: 'crmConversa', args: [fone, instancia] }); return Promise.resolve(/77001122$/.test(instancia) ? { ok: true, fechado: true, numero: '5515977001122' } : { ok: true, nk: '1992503977', abriu: true }) },
  crmPedido: (fone) => { chamadas.push({ nome: 'crmPedido', args: [fone] }); return Promise.resolve({ ok: true, venda: { raw: ['Pedido Concluído', 'Nome: Maria do Carmo', 'CPF: 123'].join(String.fromCharCode(10)), valor: 297, ts: agoraS - 1500, nome: 'Maria do Carmo' } }) },
})
// O main avisando a casca (sw:area, sw:marcacao...), como o webContents.send faria.
contextBridge.exposeInMainWorld('__avisaCasca', (canal, dados) => { if (canal === 'sw:marcacao') MARCACAO = dados; for (const fn of ouvintes[canal] || []) fn(dados) })
// O main terminou de baixar as fotos: grava no estado e avisa a barra, como o main.js faz.
contextBridge.exposeInMainWorld('__fotosChegaram', () => {
  fotos = { [URL_FOTO_GUI]: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
  for (const fn of ouvintes['sw:fotos'] || []) fn({})
})
// Ver a nota no teste-painel-preload: array exposto direto nasce congelado.
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
// Pra o teste poder simular o que o processo principal devolveria depois de esconder o painel.
contextBridge.exposeInMainWorld('__painelOff', () => { painelLigado = false })
// O PROPRIO STUB, pro teste contar a partir dele em vez de repetir o numero na mao. Expectativa
// escrita a mao quebra toda vez que a lista cresce, e quem le o erro acha que quebrou alguma coisa
// de verdade - ja aconteceu duas vezes aqui.
contextBridge.exposeInMainWorld('__stub', () => JSON.parse(JSON.stringify(ESTADO())))
