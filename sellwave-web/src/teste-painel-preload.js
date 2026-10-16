// Preload FALSO pro teste do painel: responde no lugar do processo principal, sem app nenhum de pe.
// Guarda o que foi chamado em window.__chamadas pra o teste conferir.
const { contextBridge } = require('electron')

const chamadas = []
const reg = (nome, valor) => (...args) => { chamadas.push({ nome, args }); return Promise.resolve(valor) }

const ESTADO = {
  motor: true, autenticado: true, envia: true,
  chatId: '5519995983293@c.us', phone: '5519995983293', nome: 'Cliente de Teste',
  eu: '5515974060653', nk: '95983293', trocado: '', lid: 0, grupo: false,
}

contextBridge.exposeInMainWorld('swp', {
  roteiro: reg('roteiro', { ok: true,
    messages: [{ id: 'm1', label: 'Bom dia', text: 'Bom dia!' }, { id: 'm2', label: 'Tudo bem?', text: 'Tudo bem?' }],
    // Um funil com pausa DE VERDADE: e com ele que o teste prova que o painel nao espera.
    sequences: [{ id: 's1', label: 'Boas-vindas', items: [{ id: 'm1', sim: 3 }, { id: 'm2', sim: 3 }] }],
    media: [], mediaBase: '' }),
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
  pedidoNovo: reg('pedidoNovo', { ok: true, id: 123, ja: false }),
  rascunhos: reg('rascunhos', { ok: true, rascunhos: [
    { id: 7, phone: '5519995983293', dados: { nome: 'Maria Teste', trat: 'Produto A - 2 Meses', vl: '297,00', cidade: 'Campinas' }, criado: 1, mexido: 2 },
  ] }),
  rascunhoSalvar: reg('rascunhoSalvar', { ok: true, id: 7 }),
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
