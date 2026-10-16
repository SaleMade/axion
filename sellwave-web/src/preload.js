// Ponte da CASCA (barra lateral) com o processo principal.
// A casca nunca fala com a rede direto: tudo passa por aqui.

const { contextBridge, ipcRenderer } = require('electron')

const chamar = (canal, dados) => ipcRenderer.invoke(canal, dados || {})

contextBridge.exposeInMainWorld('sw', {
  estado: () => chamar('sw:estado'),
  entrar: (token, apiBase) => chamar('sw:entrar', { token, apiBase }),
  sair: () => chamar('sw:sair'),
  numeros: () => chamar('sw:numeros'),
  abrir: (numero) => chamar('sw:abrir', { numero }),
  mostrar: (nk) => chamar('sw:mostrar', { nk }),
  esconder: () => chamar('sw:esconder'),
  fechar: (nk) => chamar('sw:fechar', { nk }),
  recarregar: (nk) => chamar('sw:recarregar', { nk }),
  salvarProxy: (p) => chamar('sw:proxy-salvar', p),
  testarProxy: (nk) => chamar('sw:proxy-testar', { nk }),
  trava: (v) => chamar('sw:trava', v),

  // avisos vindos do processo principal
  ao: (canal, fn) => {
    const permitidos = ['sw:aberto', 'sw:fechado', 'sw:ativo', 'sw:erro', 'sw:status', 'sw:saida']
    if (!permitidos.includes(canal)) return () => {}
    const envelope = (_e, dados) => fn(dados)
    ipcRenderer.on(canal, envelope)
    return () => ipcRenderer.removeListener(canal, envelope)
  },
})
