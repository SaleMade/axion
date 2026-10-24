// Ponte da CASCA (barra lateral) com o processo principal.
// A casca nunca fala com a rede direto: tudo passa por aqui.

const { contextBridge, ipcRenderer } = require('electron')

const chamar = (canal, dados) => ipcRenderer.invoke(canal, dados || {})

contextBridge.exposeInMainWorld('sw', {
  estado: () => chamar('sw:estado'),
  entrar: (login, senha) => chamar('sw:entrar', { login, senha }),
  sair: () => chamar('sw:sair'),
  numeros: () => chamar('sw:numeros'),
  abrir: (numero) => chamar('sw:abrir', { numero }),
  mostrar: (nk) => chamar('sw:mostrar', { nk }),
  esconder: () => chamar('sw:esconder'),
  fechar: (nk) => chamar('sw:fechar', { nk }),
  // O numero em JANELA PROPRIA (17/10/2026): destacar tira da janela principal, devolver traz.
  destacar: (numero, nk) => chamar('sw:destacar', { numero, nk }),
  devolver: (nk) => chamar('sw:devolver', { nk }),
  recarregar: (nk) => chamar('sw:recarregar', { nk }),
  testarProxy: (nk) => chamar('sw:proxy-testar', { nk }),
  roleta: (nk, on) => chamar('sw:roleta', { nk, on }),
  painel: (ligado) => chamar('swp:painel', { ligado }),
  teto: (maxAbertos) => chamar('sw:teto', { maxAbertos }),
  abrirLog: () => chamar('sw:abrirLog'),
  abrirInstalador: () => chamar('sw:abrirInstalador'),
  salvarProxy: (d) => chamar('sw:proxy-salvar', d),
  verComo: (id) => chamar('sw:como', { id }),
  soltarUso: (nk) => chamar('sw:uso-soltar', { nk }),
  // so a direcao: fecha o numero no computador de quem esta com ele (24/10/2026)
  usoForcar: (nk) => chamar('sw:uso-forcar', { nk }),
  barra: (encolhida) => chamar('sw:barra', { encolhida }),
  // O CRM DO ATENDIMENTO (23/10/2026): abrir/fechar o quadro, ler, mover de etapa, abrir a conversa
  // do card e ver o Pedido Concluido. Tudo vai pela dash, com o login de quem esta no app.
  crmAbrir: (aberto) => chamar('sw:crm-abrir', { aberto }),
  crmDados: (periodo, sig) => chamar('sw:crm-dados', { periodo, sig }),
  crmEtapa: (fone, etapa) => chamar('sw:crm-etapa', { fone, etapa }),
  crmConversa: (fone, instancia) => chamar('sw:crm-conversa', { fone, instancia }),
  crmPedido: (fone) => chamar('sw:crm-pedido', { fone }),

  // avisos vindos do processo principal
  ao: (canal, fn) => {
    const permitidos = ['sw:aberto', 'sw:fechado', 'sw:ativo', 'sw:erro', 'sw:status', 'sw:saida', 'sw:hibernou', 'sw:fila', 'sw:semMotor', 'sw:versao', 'sw:agente', 'sw:destacado', 'sw:devolvido', 'sw:conexao', 'sw:nuvem', 'sw:saindo', 'sw:aviso', 'sw:fotos', 'sw:area', 'sw:marcacao']
    if (!permitidos.includes(canal)) return () => {}
    const envelope = (_e, dados) => fn(dados)
    ipcRenderer.on(canal, envelope)
    return () => ipcRenderer.removeListener(canal, envelope)
  },
})
