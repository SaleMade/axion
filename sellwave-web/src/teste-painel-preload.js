// Preload FALSO pro teste do painel: responde no lugar do processo principal, sem app nenhum de pe.
// Guarda o que foi chamado em window.__chamadas pra o teste conferir.
const { contextBridge } = require('electron')

const chamadas = []
// O pedido 7001 da ficha de cobranca do painel, com o que a ficha gravou (ver cobPedido/cobSalva).
const P7001 = { valor: 397, saldo: 397, pago: false, spg: 'Pendente', agend: '', comentarios: [], pagamentos: [] }
let rascSeq = 0
const reg = (nome, valor) => (...args) => { chamadas.push({ nome, args }); return Promise.resolve(valor) }
// AS AUTOMACOES do painel do cobrador (11/11/2026): o que ESTA pessoa ligou, com estado.
const AUTO_MEU = { rec: true, ret: true, pag: true }
// O TEXTO DE CADA UM (13/11/2026): AUTO_CASA = o da casa, AUTO_TXT = a versao de quem esta no app.
// AUTO_DIR = quem olha e a direcao, vendo a aba do Haynan; AUTO_VELHO = servidor que ainda nao sabe
// editar; AUTO_LONGO = envios com nome comprido (o que alargava a aba e criava a rolagem pro lado).
const AUTO_CASA = { saudacao: '{saudacao} {nome}', apresenta: 'Aqui quem fala é o Elias.', ret1: 'Oi {primeiro}, código {codigo}', pagou: 'Recebi, {primeiro}!' }
const AUTO_TXT = {}
let AUTO_DIR = false, AUTO_VELHO = false, AUTO_LONGO = false
// A DIRECAO SEM "VER COMO" (13/11/2026, rodada 2): a aba e da CASA. AUTO_LIGA_CASA = o interruptor da
// operacao; AUTO_COBS = os cobradores do seletor; AUTO_QUEM = de quem foi a ultima leitura.
const AUTO_LIGA_CASA = { rec: true, ret: true, pag: false }
const AUTO_COBS = [{ id: 'hc', nome: 'Haynan' }, { id: 'bc', nome: 'Bryan' }]
const AUTO_TXT_DE = { hc: {}, bc: { pagou: 'Valeu demais, {primeiro}!' } }
const AUTO_OFF_DE = { hc: {}, bc: { ret: true } }
let AUTO_QUEM = ''
const autoTxCasa = (campo, rot, vars) => ({ campo, rot, texto: AUTO_CASA[campo], proprio: false, vars, outros: AUTO_COBS.filter((c) => AUTO_TXT_DE[c.id][campo]).map((c) => c.nome) })
const autoTxDe = (q) => (campo, rot, vars) => ({ campo, rot, texto: AUTO_TXT_DE[q][campo] || AUTO_CASA[campo], proprio: !!AUTO_TXT_DE[q][campo], vars })
const autoTipos = (tx, liga) => [
  { id: 'rec', nome: 'Boas-vindas', dica: 'O cliente chamou e ninguém respondeu em 1 minuto.', hoje: 5, ...liga('rec'), textos: [tx('saudacao', 'Saudação', ['saudacao', 'primeiro', 'nome']), tx('apresenta', 'Apresentação', ['primeiro', 'nome'])] },
  { id: 'ret', nome: 'Retirar nos Correios', dica: 'Um lembrete por dia, por até 5 dias.', hoje: 0, ...liga('ret'), textos: [tx('ret1', 'Retirada: chegou na agência', ['saudacao', 'primeiro', 'codigo', 'link', 'valor'])] },
  { id: 'pag', nome: 'Pagou', dica: 'O pagamento caiu: agradece.', hoje: 1, ...liga('pag'), textos: [tx('pagou', 'Pagou', ['saudacao', 'primeiro'])] },
]
const autoVarRot = { saudacao: 'Bom dia / Boa tarde', primeiro: 'Primeiro nome', nome: 'Nome completo', codigo: 'Código de rastreio', link: 'Link do rastreio', valor: 'Valor' }
// o que o servidor responde pra direcao: a casa, ou a aba de um cobrador (com a lista pro seletor)
const autoRespostaDir = (q) => {
  const c = AUTO_COBS.find((x) => x.id === q)
  if (!c) {
    return { ok: true, numeros: 3, edita: true, dir: true, de: null, casa: true, cobradores: AUTO_COBS, varRot: autoVarRot,
      tipos: autoTipos(autoTxCasa, (id) => ({ direcao: true, meu: !!AUTO_LIGA_CASA[id], desligou: AUTO_COBS.filter((x) => AUTO_OFF_DE[x.id][id]).map((x) => x.nome) })),
      ultimos: [{ id: 'rec', nome: 'Maria das Dores', status: 'enviado', motivo: '', ts: Math.floor(Date.now() / 1000) - 120, quem: 'Haynan' },
        { id: 'pag', nome: 'Jose Carlos', status: 'enviado', motivo: '', ts: Math.floor(Date.now() / 1000) - 300, quem: 'Bryan' }] }
  }
  return { ok: true, numeros: 1, edita: true, dir: true, de: c, casa: false, cobradores: AUTO_COBS, varRot: autoVarRot,
    tipos: autoTipos(autoTxDe(c.id), (id) => ({ direcao: !!AUTO_LIGA_CASA[id], meu: !AUTO_OFF_DE[c.id][id] })),
    ultimos: [{ id: 'pag', nome: 'Jose Carlos', status: 'enviado', motivo: '', ts: Math.floor(Date.now() / 1000) - 300 }] }
}
const autoTx = (campo, rot, vars) => (AUTO_VELHO ? { rot, texto: AUTO_CASA[campo] } : { campo, rot, texto: AUTO_TXT[campo] || AUTO_CASA[campo], proprio: !!AUTO_TXT[campo], vars })
const autoResposta = () => ({ ok: true, numeros: 1,
  ...(AUTO_VELHO ? {} : { edita: true, dir: AUTO_DIR, de: AUTO_DIR ? { id: 'hc', nome: 'Haynan' } : null,
    varRot: { saudacao: 'Bom dia / Boa tarde', primeiro: 'Primeiro nome', nome: 'Nome completo', codigo: 'Código de rastreio', link: 'Link do rastreio', valor: 'Valor' } }),
  tipos: [
    { id: 'rec', nome: 'Boas-vindas', dica: 'O cliente chamou e ninguém respondeu em 1 minuto.', direcao: true, meu: AUTO_MEU.rec, hoje: 2, textos: [autoTx('saudacao', 'Saudação', ['saudacao', 'primeiro', 'nome']), autoTx('apresenta', 'Apresentação', ['primeiro', 'nome'])] },
    { id: 'ret', nome: 'Retirar nos Correios', dica: 'Um lembrete por dia, por até 5 dias.', direcao: true, meu: AUTO_MEU.ret, hoje: 0, textos: [autoTx('ret1', 'Retirada: chegou na agência', ['saudacao', 'primeiro', 'codigo', 'link', 'valor'])] },
    { id: 'pag', nome: 'Pagou', dica: 'O pagamento caiu: agradece.', direcao: false, meu: AUTO_MEU.pag, hoje: 0, textos: [autoTx('pagou', 'Pagou', ['saudacao', 'primeiro'])] },
  ],
  ultimos: [{ id: 'rec', nome: 'Maria das Dores', status: 'enviado', motivo: '', ts: Math.floor(Date.now() / 1000) - 120 }]
    .concat(AUTO_LONGO ? [
      { id: 'ret', nome: 'Francisca Aparecida dos Santos Oliveira de Albuquerque', status: 'enviado', motivo: '', ts: Math.floor(Date.now() / 1000) - 300 },
      { id: 'pag', nome: 'Sebastiao Raimundo Nonato Cavalcante Vasconcelos Filho', status: 'pulado', motivo: 'o cobrador já falou depois', ts: Math.floor(Date.now() / 1000) - 90000 },
    ] : []),
})

const ESTADO = {
  motor: true, autenticado: true, envia: true,
  chatId: '5519995983293@c.us', phone: '5519995983293', nome: 'Cliente de Teste',
  eu: '5515974060653', nk: '95983293', trocado: '', lid: 0, grupo: false,
}

// Quantas das proximas chamadas de pedidoNovo devem falhar (ver o stub abaixo).
let falharPedido = 0
// O APAGAR DO RASCUNHO PODE RECUSAR SOB COMANDO. Desde 17/10 a tela tira o cartao ANTES de o
// servidor responder (pra devolver o clique na hora), entao o caminho que precisa de teste e
// justamente o da recusa: o cartao tem que VOLTAR.
let falharApagar = 0
// E PODE DEMORAR. Sem demora, "sumiu antes da resposta" e indistinguivel de "sumiu depois dela".
let demoraApagar = 0

contextBridge.exposeInMainWorld('swp', {
  roteiro: reg('roteiro', { ok: true,
    messages: [{ id: 'm1', label: 'Bom dia', text: 'Bom dia!' }, { id: 'm2', label: 'Tudo bem?', text: 'Tudo bem?' }],
    // Um funil com pausa DE VERDADE: e com ele que o teste prova que o painel nao espera.
    sequences: [{ id: 's1', label: 'Boas-vindas', items: [{ id: 'm1', sim: 3 }, { id: 'm2', sim: 3 }] }],
    // MIDIA DE VERDADE NO STUB (16/10/2026). Com a lista vazia, a previa de imagem, video,
    // audio e documento nao era exercitada por teste nenhum - e foi exatamente ali que o Bruno
    // achou o defeito: os quatro desenhavam o MESMO balao de texto, escrito "[imagem] Formula".
    media: [
      { id: 'i1', kind: 'image', label: 'Formula', caption: 'olha a formula', key: 'm/aaa111.png', grp: '' },
      { id: 'v1', kind: 'video', label: 'Prova: Sr Jose', caption: 'Sr Jose, 1 semana', key: 'm/bbb222.mp4', grp: '' },
      { id: 'a1', kind: 'audio', label: 'H - 02 Explicacao', caption: '', key: 'm/ccc333.ogg', grp: '' },
      { id: 'd1', kind: 'document', label: 'Certificado Anvisa', caption: '', key: 'm/ddd444.pdf', grp: '' },
    ],
    mediaBase: 'https://exemplo/api/salechat/media/' }),
  lead: reg('lead', { ok: true, achou: true, nome: 'Cliente de Teste', cidade: 'Campinas', uf: 'SP', produto: 'Produto A - 3 Meses', etapa: 'A Enviar', pedidos: 1 }),
  estado: reg('estado', ESTADO),
  // DEMORA DE PROPOSITO. Na vida real a pausa do passo acontece DENTRO desta chamada (a pagina
  // espera antes de enviar), entao um `manda` instantaneo faria todo job acabar em milissegundos e
  // a fila nunca teria dois ao mesmo tempo pro teste olhar.
  manda: (nk, chatId, item) => {
    chamadas.push({ nome: 'manda', args: [nk, chatId, item], t: Date.now() })
    return new Promise((r) => setTimeout(() => r({ ok: true }), 1200))
  },
  parar: (nk, parar) => { chamadas.push({ nome: 'parar', args: [nk, parar] }); return Promise.resolve({ ok: true }) },
  indica: reg('indica', { ok: true }),
  disparo: reg('disparo', { ok: true }),
  disparos: reg('disparos', { ok: true, itens: [
    { nk: '81430517', numero: '5515974015754', dono: 'Guilherme', funil: 'Boas-vindas', passo: 2, total: 5, alvo: '5519995983293', inicio: Date.now() },
  ] }),
  aoMudarDisparos: () => {},
  tratamentos: reg('tratamentos', { ok: true, offers: [
    { key: 'k1', label: 'Produto A - 1 Mes', price: 197, prod: 'Produto A' },
    { key: 'k3', label: 'Produto A - 3 Meses', price: 397, prod: 'Produto A' },
    { key: 'k6', label: 'Produto A - 6 Meses', price: 697, prod: 'Produto A' },
  ] }),
  comprovante: reg('comprovante', { ok: true, url: 'https://r2.exemplo/comprovante/print.jpg', mime: 'image/jpeg' }),
  abrirMidia: reg('abrirMidia', { ok: true }),
  // A area de transferencia com um print dentro, pro teste do clique que cola.
  colaPrint: reg('colaPrint', { ok: true, bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', nome: 'print.png' }),
  // A BUSCA DE CEP responde COMO A DE VERDADE, nos quatro casos que existem de verdade - e o
  // `respondeu` vai em todos porque e ele que a tela usa pra escolher o recado (ver main.js).
  // Os CEPs sao reais, conferidos contra as bases em 17/10/2026:
  //   88504-411 Rua Curitiba, Santa Helena, Lages/SC (o do print do Bruno)
  //   60175-045 Rua Pereira de Miranda, Papicu, Fortaleza/CE (pra regra do Ceara)
  //   01000-000 existe e NENHUMA das tres bases tem endereco (CEP geral de cidade)
  //   12345678 nenhuma base acha  ·  99000-000 a consulta nao responde (sem internet/proxy)
  cep: (cep) => {
    chamadas.push({ nome: 'cep', args: [cep] })
    const c = String((cep && cep.cep) || cep || '').replace(/\D/g, '')
    if (c === '88504411') return Promise.resolve({ ok: true, achou: true, invalido: false, completo: true, respondeu: true, dados: { end: 'Rua Curitiba', bairro: 'Santa Helena', cidade: 'Lages', uf: 'SC' } })
    if (c === '60175045') return Promise.resolve({ ok: true, achou: true, invalido: false, completo: true, respondeu: true, dados: { end: 'Rua Pereira de Miranda', bairro: 'Papicu', cidade: 'Fortaleza', uf: 'CE' } })
    if (c === '12345678') return Promise.resolve({ ok: true, achou: false, invalido: true, completo: false, respondeu: true, dados: null })
    if (c === '01000000') return Promise.resolve({ ok: true, achou: false, invalido: false, completo: false, respondeu: true, dados: null })
    if (c === '99000000') return Promise.resolve({ ok: false, achou: false, invalido: false, completo: false, respondeu: false, dados: null })
    return Promise.resolve({ ok: true, achou: false, invalido: false, completo: false, respondeu: true, dados: null })
  },
  // PODE FALHAR SOB COMANDO. A rede caindo no meio do cadastro e o caso que fazia o app criar
  // DOIS cards do mesmo pedido, e um stub que so responde ok nunca encosta nesse caminho - e a
  // mesma licao do preload que respondia ok pra tudo e escondeu o rascunho quebrado por semanas.
  pedidoNovo: (o) => {
    chamadas.push({ nome: 'pedidoNovo', args: [o] })
    if (falharPedido > 0) { falharPedido -= 1; return Promise.reject(new Error('fetch failed')) }
    return Promise.resolve({ ok: true, id: 123, ja: false })
  },
  rascunhos: reg('rascunhos', { ok: true, rascunhos: [
    { id: 7, phone: '5519995983293', dados: { nome: 'Maria Teste', trat: 'Produto A - 2 Meses', vl: '297,00', cidade: 'Campinas' }, criado: 1, mexido: 2 },
  ] }),
  // RESPONDE COMO O WORKER DE VERDADE, nao com ok pra tudo (16/10/2026).
  //
  // O preload antigo devolvia `{ok:true, id:7}` pra QUALQUER chamada, e foi isso que escondeu um
  // defeito real por semanas: o worker recusava id vazio com "Falta o id do rascunho", entao
  // rascunho NOVO nunca gravava na producao, e a bateria passava feliz. Medido depois, direto na
  // API: a tabela estava vazia, zero linhas.
  //
  // Agora o id novo nasce no servidor, como la, e o teste pode provar que o painel GUARDA o id
  // devolvido - sem isso, cada gravacao criaria uma linha nova.
  rascunhoSalvar: (id, phone, dados) => {
    chamadas.push({ nome: 'rascunhoSalvar', args: [id, phone, dados] })
    if (!id) { rascSeq += 1; return Promise.resolve({ ok: true, id: '99000' + rascSeq }) }
    return Promise.resolve({ ok: true, id: String(id) })
  },
  rascunhoApagar: (id) => {
    chamadas.push({ nome: 'rascunhoApagar', args: [id] })
    const resposta = falharApagar > 0 ? (falharApagar -= 1, { ok: false, erro: 'servidor recusou' }) : { ok: true }
    if (demoraApagar > 0) return new Promise((r) => setTimeout(() => r(resposta), demoraApagar))
    return Promise.resolve(resposta)
  },
  fechar: reg('fechar', { ok: true }),
  recarregar: reg('recarregar', { ok: true }),
  esconder: reg('esconder', { ok: true }),
  // "Ja li esta conversa" (19/10/2026). O teste confere QUANDO ela e chamada, que e o que importa:
  // marcar cedo demais apaga o aviso de quem ainda espera resposta.
  marcarLida: reg('marcarLida', { ok: true }),
  // A FICHA DE COBRANCA (31/10/2026, versao de cobrador): o pedido do cliente da conversa.
  // O 7001 TEM ESTADO (05/11/2026): o que a ficha grava (retorno, parcela, pago, comentario) volta na
  // leitura seguinte, como o worker faz. E o que prova que a ficha do painel redesenha depois de gravar.
  cobPedido: (phone) => {
    chamadas.push({ nome: 'cobPedido', args: [phone] })
    const e = P7001
    return Promise.resolve({ ok: true, prontos: ['Aguardando resposta do cliente'], pedidos: [{
      id: '7001', nome: 'Cliente de Teste', wa: '19995983293', cidade: 'Campinas', uf: 'SP', prod: 'Produto A - 3 Meses',
      vl: 397, valor: e.valor, saldo: e.saldo, pago: e.pago, pagoTs: e.pago ? Date.now() : 0, col: e.pago ? 'Pagos' : 'Entregues', colBruta: e.pago ? 'Pagos' : 'Cobrança', spg: e.spg, mod: 'entrega',
      agend: e.agend, selo: { label: 'Entregue', cor: '#10b981', quando: '30/10/2026' }, entrega: { label: 'Entregue em', data: '30/10/2026', dias: '3 dias' },
      entrou: Date.now(), criado: Date.now(), at: 'a1', atNome: 'Guilherme', cob: 'hc', cobNome: 'Haynan', track: 'AB1', transp: 'Correios', tags: [], ncom: e.comentarios.length, vc: true,
      data: '27/10', links: { checkout: 'https://checkout.exemplo/k3', pix: 'https://pix.exemplo/p?ped=7001', boleto: '', cartao: '', rastreio: 'https://glico-six.rastreio.vip/rastreio?codigo=AB1' },
      hist: [], comentarios: e.comentarios.slice(), pagamentos: e.pagamentos.slice(),
    }] })
  },
  cobSalva: (id, patch) => {
    chamadas.push({ nome: 'cobSalva', args: [id, patch] })
    const e = P7001, p = patch || {}
    if (p.antes && (String(p.antes.spg || '') !== e.spg)) return Promise.resolve({ ok: false, erro: 'O pedido mudou desde que você abriu. Recarregue e tente de novo.', mudou: true })
    if ('agend' in p) e.agend = String(p.agend || '')
    if (p.comment_add) e.comentarios.unshift({ quem: 'Haynan', tx: String(p.comment_add.tx || ''), quando: '05/11 10:00', tipo: '', url: '' })
    if (p.pagamento_add) { e.pagamentos.push({ valor: Number(p.pagamento_add.valor) || 0, data: '05/11/2026', quem: 'Haynan', obs: String(p.pagamento_add.obs || '') }); e.saldo = Math.max(0, e.valor - e.pagamentos.reduce((s, x) => s + x.valor, 0)); if (!('spg' in p)) e.spg = e.saldo > 0 ? 'Parcial' : 'Pago' }
    if (p.spg === 'Pago') { e.spg = 'Pago'; e.pago = true; if (Number(p.valor_neg) > 0) e.valor = Number(p.valor_neg); e.saldo = 0; e.agend = '' }
    return Promise.resolve({ ok: true, negados: [], ...(p.pagamento_add ? { parcelas: e.pagamentos.length } : {}) })
  },
  cobCurto: reg('cobCurto', { ok: true, url: 'https://sw.li/abc' }),
  // A ABA AUTOMACOES (11/11/2026): tres de exemplo, com estado (o que ele desliga volta desligado) e
  // uma recusa pra provar que o interruptor volta sozinho.
  // `quem` = de quem a direcao escolheu ver ('casa' ou o id do cobrador); fica fora do `args` pras
  // conferencias antigas continuarem lendo so o que mandavam antes.
  autoConfig: (quem) => {
    chamadas.push({ nome: 'autoConfig', args: [], quem: quem || '' })
    if (ESTADO.direcao && !ESTADO.cobranca) { AUTO_QUEM = quem === 'casa' ? '' : (quem || ''); return new Promise((r) => setTimeout(() => r(autoRespostaDir(AUTO_QUEM)), 60)) }
    return Promise.resolve(autoResposta())
  },
  autoLiga: (id, ligado, quem) => {
    chamadas.push({ nome: 'autoLiga', args: [id, ligado], quem: quem || '' })
    if (ESTADO.direcao && !ESTADO.cobranca) {
      const q = quem === 'casa' ? '' : (quem || '')
      if (AUTO_COBS.some((c) => c.id === q)) { if (ligado) delete AUTO_OFF_DE[q][id]; else AUTO_OFF_DE[q][id] = true } else AUTO_LIGA_CASA[id] = !!ligado
      return Promise.resolve(autoRespostaDir(q))
    }
    if (id === 'pag') return Promise.resolve({ ok: false, erro: 'A dash respondeu 500.' })
    AUTO_MEU[id] = !!ligado
    return Promise.resolve(autoResposta())
  },
  // Editar o texto: como o servidor, recusa palavra entre chaves que nao conhece e guarda a versao
  // da pessoa (ou troca o da casa, no "pra todos").
  autoTexto: (campo, texto, opc) => {
    const o = opc || {}
    chamadas.push({ nome: 'autoTexto', args: [campo, texto, { todos: !!o.todos, padrao: !!o.padrao }], quem: o.quem || '' })
    if (!o.padrao && /\{Nome\}/.test(String(texto))) return Promise.resolve({ ok: false, erro: 'Esta mensagem não sabe preencher {Nome}. Aqui dá pra usar: {saudacao} {primeiro} {nome}' })
    if (ESTADO.direcao && !ESTADO.cobranca) {
      const q = o.quem === 'casa' ? '' : (o.quem || '')
      const c = AUTO_COBS.find((x) => x.id === q)
      if (c && !o.todos) { if (o.padrao) delete AUTO_TXT_DE[q][campo]; else AUTO_TXT_DE[q][campo] = String(texto) }
      else { AUTO_CASA[campo] = String(texto); for (const x of AUTO_COBS) delete AUTO_TXT_DE[x.id][campo] }
      return new Promise((r) => setTimeout(() => r(autoRespostaDir(q)), 120))
    }
    if (o.padrao) delete AUTO_TXT[campo]
    else if (o.todos) { AUTO_CASA[campo] = String(texto); delete AUTO_TXT[campo] }
    else if (String(texto) === AUTO_CASA[campo]) delete AUTO_TXT[campo]
    else AUTO_TXT[campo] = String(texto)
    return new Promise((r) => setTimeout(() => r(autoResposta()), 120))
  },
  abrirLink: reg('abrirLink', { ok: true }),
  copiar: reg('copiar', { ok: true }),
  aoMudarModo: () => {},
})
// O app vira o do cobrador (o main manda `cobranca` no estado da conversa).
contextBridge.exposeInMainWorld('__poeCobranca', (v) => { ESTADO.cobranca = !!v })
// A direcao no app (a aba Automacoes aparece fora da versao de cobrador) e o painel sem numero aberto.
contextBridge.exposeInMainWorld('__poeDirecao', (v) => { ESTADO.direcao = !!v })
contextBridge.exposeInMainWorld('__poeSemNumero', (v) => {
  if (v) { ESTADO.__antes = ESTADO.__antes || { motor: ESTADO.motor, autenticado: ESTADO.autenticado, envia: ESTADO.envia, chatId: ESTADO.chatId, phone: ESTADO.phone, nome: ESTADO.nome, eu: ESTADO.eu }
    Object.assign(ESTADO, { motor: false, autenticado: false, envia: false, chatId: '', phone: '', nome: '', eu: '', semNumero: true }) }
  else if (ESTADO.__antes) { Object.assign(ESTADO, ESTADO.__antes, { semNumero: false }); delete ESTADO.__antes }
})
contextBridge.exposeInMainWorld('__poeAuto', (o) => { if ('dir' in o) AUTO_DIR = !!o.dir; if ('velho' in o) AUTO_VELHO = !!o.velho; if ('longo' in o) AUTO_LONGO = !!o.longo })
// O contextBridge COPIA o valor na hora de expor: um array exposto direto nasce congelado e os
// push() daqui nunca aparecem do outro lado. Por isso vai uma funcao, que copia a cada chamada.
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
// Pro teste simular o vendedor clicando noutra conversa enquanto o formulario esta aberto.
contextBridge.exposeInMainWorld('__trocaConversa', (phone, nome, nk) => {
  ESTADO.phone = phone; ESTADO.chatId = phone + '@c.us'; ESTADO.nome = nome
  // O NUMERO (nk) tambem troca sob comando desde 17/10. Sem isso nao da pra testar o que o Bruno
  // perguntou: dois WhatsApps DIFERENTES disparando ao mesmo tempo. Com um nk so, os dois jobs
  // caem no mesmo consumidor e o teste provaria o contrario do que interessa.
  if (nk) ESTADO.nk = String(nk)
})
// Pro teste do "ja li esta conversa": grupo e desconectado sao os dois casos que NAO podem marcar.
contextBridge.exposeInMainWorld('__grupo', (on) => { ESTADO.grupo = !!on })
contextBridge.exposeInMainWorld('__autenticado', (on) => { ESTADO.autenticado = !!on })
// Pro teste simular a rede caindo no cadastro.
contextBridge.exposeInMainWorld('__falhaPedido', (n) => { falharPedido = Number(n) || 0 })
contextBridge.exposeInMainWorld('__falhaApagar', (n) => { falharApagar = Number(n) || 0 })
contextBridge.exposeInMainWorld('__demoraApagar', (ms) => { demoraApagar = Number(ms) || 0 })
