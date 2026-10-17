// Ponte da janela do PAINEL com o processo principal.
// O painel nunca toca no WhatsApp direto: ele pede, e quem executa dentro da pagina e o agente.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('swp', {
  roteiro: () => ipcRenderer.invoke('swp:roteiro'),
  lead: (phone) => ipcRenderer.invoke('swp:lead', { phone }),
  estado: () => ipcRenderer.invoke('swp:estado-wa'),
  manda: (nk, chatId, item) => ipcRenderer.invoke('swp:manda', { nk, chatId, item }),
  // A PAUSA ACONTECE DENTRO DA PAGINA, grudada no envio (igual ao sc-panel, que e a versao que
  // funciona ha meses). Por isso nao ha mais indicador separado aqui: indicador, espera e envio sao
  // uma cadeia so la dentro. O que sobra deste lado e a bandeirinha de PARAR, que a espera confere.
  parar: (nk, parar) => ipcRenderer.invoke('swp:parar', { nk, parar }),
  // O QUE ESTA SAINDO, com nome e passo. Sem os campos extras o registro do processo principal
  // nascia com o rotulo padrao e a faixa do painel dizia literalmente "funil" no lugar do nome.
  disparo: (nk, ligado, info) => ipcRenderer.invoke('swp:disparo', { nk, ligado, ...(info || {}) }),
  parar: (nk, parar) => ipcRenderer.invoke('swp:parar', { nk, parar }),
  // ABA PEDIDOS (16/10/2026). O painel NUNCA cria pedido na PayLog: ele faz o mesmo passo que o
  // Novo Pedido da dash faz, o card cai em Aceitacoes e quem cria la e o Aceitar, com a conferencia
  // dupla e a trava anti-dobro por CPF. Decisao do Bruno, perguntada e confirmada em 16/10.
  pedidoNovo: (lead) => ipcRenderer.invoke('swp:pedido-novo', { lead }),
  rascunhos: (phone) => ipcRenderer.invoke('swp:rascunhos', { phone }),
  rascunhoSalvar: (id, phone, dados) => ipcRenderer.invoke('swp:rascunho-salvar', { id, phone, dados }),
  rascunhoApagar: (id) => ipcRenderer.invoke('swp:rascunho-salvar', { id, apagar: true }),
  // TRATAMENTO VEM DE LISTA, NUNCA DIGITADO. Na dash o kit e escolhido do catalogo e o preco e so
  // leitura, porque preco digitado a mao diverge do catalogo e contamina receita, comissao e margem
  // sem ninguem ver de onde veio (decisao do Bruno em 14/08/2026). O painel segue a mesma regra.
  tratamentos: () => ipcRenderer.invoke('swp:tratamentos'),
  // O arquivo vai em bytes crus, sem base64: um video de 9 MB viraria 12 e passaria duas vezes pela
  // memoria. `bytes` e o Uint8Array que a pagina leu do arquivo.
  comprovante: (nome, mime, bytes, lead) => ipcRenderer.invoke('swp:comprovante', { nome, mime, bytes, lead }),
  // Abre o documento no programa do Windows. So a CHAVE viaja: a pagina nunca ve o endereco da
  // API, e quem monta a URL e o processo principal.
  abrirMidia: (chave) => ipcRenderer.invoke('swp:abrir-midia', { chave }),
  // Busca de CEP. Mora no processo principal porque a pagina nao pode falar com a rede, e
  // porque assim o cache vale pros N numeros abertos em vez de um por janela.
  cep: (cep) => ipcRenderer.invoke('swp:cep', { cep }),
  // O print que esta na area de transferencia, lido pelo processo principal (ver main.js).
  colaPrint: () => ipcRenderer.invoke('swp:cola-print'),
  // PILHA DE DISPAROS: o que esta saindo nos numeros abertos. Hoje da 0 ou 1 (o painel roda um
  // funil por vez), mas a lista ja vem como lista pro dia em que isso mudar.
  disparos: () => ipcRenderer.invoke('swp:disparos'),
  // O evento NAO entrega o objeto do ipc pra pagina: so o que interessa. Passar o `event` cru
  // daria a ela um `sender` com poder de mandar mensagem pro processo principal.
  aoMudarDisparos: (cb) => {
    ipcRenderer.on('swp:disparos-mudou', (_ev, dados) => { try { cb(Number((dados && dados.n) || 0)) } catch (_) { /* a pagina que se vire */ } })
  },
  fechar: () => ipcRenderer.invoke('swp:fechar-ativo'),
  recarregar: () => ipcRenderer.invoke('swp:recarregar-ativo'),
  esconder: () => ipcRenderer.invoke('swp:painel', { ligado: false }),
})
