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
  recarregar: (nk) => chamar('sw:recarregar', { nk }),
  testarProxy: (nk) => chamar('sw:proxy-testar', { nk }),
  trava: (v) => chamar('sw:trava', v),
  roleta: (nk, on) => chamar('sw:roleta', { nk, on }),
  painel: (ligado) => chamar('swp:painel', { ligado }),
  teto: (maxAbertos) => chamar('sw:teto', { maxAbertos }),
  abrirLog: () => chamar('sw:abrirLog'),
  abrirInstalador: () => chamar('sw:abrirInstalador'),
  salvarProxy: (d) => chamar('sw:proxy-salvar', d),
  verComo: (id) => chamar('sw:como', { id }),
  soltarUso: (nk) => chamar('sw:uso-soltar', { nk }),

  // avisos vindos do processo principal
  ao: (canal, fn) => {
    const permitidos = ['sw:aberto', 'sw:fechado', 'sw:ativo', 'sw:erro', 'sw:status', 'sw:saida', 'sw:hibernou', 'sw:fila', 'sw:semMotor', 'sw:versao', 'sw:agente']
    if (!permitidos.includes(canal)) return () => {}
    const envelope = (_e, dados) => fn(dados)
    ipcRenderer.on(canal, envelope)
    return () => ipcRenderer.removeListener(canal, envelope)
  },
})
