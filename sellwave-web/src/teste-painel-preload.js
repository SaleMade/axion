// Preload FALSO pro teste do painel: responde no lugar do processo principal, sem app nenhum de pe.
// Guarda o que foi chamado em window.__chamadas pra o teste conferir.
const { contextBridge } = require('electron')

const chamadas = []
let rascSeq = 0
const reg = (nome, valor) => (...args) => { chamadas.push({ nome, args }); return Promise.resolve(valor) }

const ESTADO = {
  motor: true, autenticado: true, envia: true,
  chatId: '5519995983293@c.us', phone: '5519995983293', nome: 'Cliente de Teste',
  eu: '5515974060653', nk: '95983293', trocado: '', lid: 0, grupo: false,
}

// Quantas das proximas chamadas de pedidoNovo devem falhar (ver o stub abaixo).
let falharPedido = 0

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
  // A BUSCA DE CEP responde como a de verdade: o 88504411 e o CEP real que o Bruno usou no print
  // (Rua Curitiba, Santa Helena, Lages/SC), e o 12345678 e um que nenhuma base acha.
  cep: (cep) => {
    chamadas.push({ nome: 'cep', args: [cep] })
    const c = String((cep && cep.cep) || cep || '').replace(/\D/g, '')
    if (c === '88504411') return Promise.resolve({ ok: true, achou: true, invalido: false, completo: true, dados: { end: 'Rua Curitiba', bairro: 'Santa Helena', cidade: 'Lages', uf: 'SC' } })
    if (c === '12345678') return Promise.resolve({ ok: true, achou: false, invalido: true, completo: false, dados: null })
    return Promise.resolve({ ok: true, achou: false, invalido: false, completo: false, dados: null })
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
  rascunhoApagar: reg('rascunhoApagar', { ok: true }),
  fechar: reg('fechar', { ok: true }),
  recarregar: reg('recarregar', { ok: true }),
  esconder: reg('esconder', { ok: true }),
})
// O contextBridge COPIA o valor na hora de expor: um array exposto direto nasce congelado e os
// push() daqui nunca aparecem do outro lado. Por isso vai uma funcao, que copia a cada chamada.
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
// Pro teste simular o vendedor clicando noutra conversa enquanto o formulario esta aberto.
contextBridge.exposeInMainWorld('__trocaConversa', (phone, nome) => {
  ESTADO.phone = phone; ESTADO.chatId = phone + '@c.us'; ESTADO.nome = nome
})
// Pro teste simular a rede caindo no cadastro.
contextBridge.exposeInMainWorld('__falhaPedido', (n) => { falharPedido = Number(n) || 0 })
