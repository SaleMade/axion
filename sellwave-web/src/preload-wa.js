// Preload injetado DENTRO de cada sessao de WhatsApp Web.
//
// ELE NAO E O PAINEL. O painel roda no mundo PRINCIPAL da pagina (precisa enxergar o window.WPP do
// WhatsApp); este arquivo roda no mundo ISOLADO e serve de PONTE entre os dois.
//
// POR QUE A PONTE EXISTE: com contextIsolation ligado (e tem que ficar ligado), o preload nao
// alcanca o window da pagina. A passagem oficial entre os dois mundos e o window.postMessage: os
// dois lados compartilham o mesmo objeto de eventos, entao o que o painel posta chega aqui.
//
// POR QUE O PAINEL NAO E INJETADO POR <script>: a pagina do WhatsApp tem CSP apertada e barra
// script externo e inline. O processo principal injeta com webContents.executeJavaScript, que roda
// no mundo principal e NAO passa pela CSP. Assim a gente nao precisa arrancar o cabecalho de
// seguranca da pagina, que seria piorar a seguranca pra ganhar conveniencia.

const { contextBridge, ipcRenderer, webFrame } = require('electron')

// INJECAO NO INICIO DO DOCUMENTO.
//
// webFrame.executeJavaScript chamado do preload roda no MUNDO PRINCIPAL da pagina (confirmado no
// fonte do Electron: ele passa kMainWorldId) e nao passa pela CSP. E o preload roda ANTES dos
// scripts do WhatsApp, que e o momento certo pro WA-JS enganchar.
//
// sendSync de proposito: pedir de forma assincrona perderia a janela do document-start, e aqui a
// espera e por um arquivo que o processo principal ja tem na memoria.
try {
  const { motor, agente } = ipcRenderer.sendSync('sw:codigo') || {}
  if (motor) webFrame.executeJavaScript(motor)
  if (agente) webFrame.executeJavaScript(agente)
} catch (e) {
  // Falhou aqui, o processo principal injeta de novo no did-finish-load. Pior caso: o motor
  // engancha tarde e o painel fica em "esperando o WhatsApp" por alguns segundos.
  console.error('[sellwave] injecao de inicio falhou:', e && e.message)
}

const MARCA = '__sellwave__'

// LISTA FECHADA DE CANAIS, e so este. (16/10/2026, revisao adversarial.)
//
// ESTE LISTENER OUVE O MUNDO PRINCIPAL DA PAGINA DO WHATSAPP. Qualquer codigo que rode la - o motor
// de 500 KB, um iframe que a pagina embuta, um XSS no WhatsApp Web - consegue postar mensagem pra
// ca. Sem lista fechada, bastava mandar { canal: 'sw:trava' } pra DESLIGAR a trava de proxy, ou
// { canal: 'sw:proxy-salvar' } pra trocar o proxy, ou ler as senhas pelo 'sw:estado'.
// So a captura passa, e ela e de mao unica (send, nunca invoke).
const CANAIS_DA_PAGINA = new Set(['swp:captura'])

window.addEventListener('message', (ev) => {
  // So mensagem da PROPRIA janela: iframe aninhado nao fala por aqui.
  if (ev.source !== window) return
  const d = ev && ev.data
  if (!d || d.alvo !== MARCA || !d.canal) return
  if (!CANAIS_DA_PAGINA.has(d.canal)) return
  ipcRenderer.send(d.canal, d.dados || {})
})

// Marca de presenca, util no console pra saber se o preload subiu.
contextBridge.exposeInMainWorld('sellwaveInfo', { versao: '1.0.0', fase: 3 })
