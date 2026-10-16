// Ponte da janela do PAINEL com o processo principal.
// O painel nunca toca no WhatsApp direto: ele pede, e quem executa dentro da pagina e o agente.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('swp', {
  roteiro: () => ipcRenderer.invoke('swp:roteiro'),
  lead: (phone) => ipcRenderer.invoke('swp:lead', { phone }),
  estado: () => ipcRenderer.invoke('swp:estado-wa'),
  manda: (nk, chatId, item) => ipcRenderer.invoke('swp:manda', { nk, chatId, item }),
  indica: (nk, chatId, kind, seg) => ipcRenderer.invoke('swp:indica', { nk, chatId, kind, seg }),
  fechar: () => ipcRenderer.invoke('swp:fechar-ativo'),
  recarregar: () => ipcRenderer.invoke('swp:recarregar-ativo'),
  esconder: () => ipcRenderer.invoke('swp:painel', { ligado: false }),
})
