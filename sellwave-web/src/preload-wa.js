// Preload injetado DENTRO de cada sessao de WhatsApp Web.
//
// FASE 1: so marca presenca e expoe o minimo. O painel (dados do lead, respostas rapidas, botoes
// de funil) e a captura de mensagem entram nas fases 2 e 3, e vao reaproveitar a camada window.WPP
// que o Sale Chat ja usa (ver "Sale Chat Atendimento/panel-inject.js").
//
// POR QUE AQUI E NAO POR CDP: no Electron o preload roda no contexto certo, com contextIsolation
// ligado, sem precisar abrir porta de debug. O inject.js do Sale Chat so existia porque ele se
// pendurava no app do WhatsApp da Microsoft Store por fora.

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('sellwave', {
  versao: '1.0.0',
  fase: 1,
})

// Sinal simples pra casca saber que a pagina subiu de verdade (e nao a tela de navegador
// desatualizado). Se este texto aparecer, o User-Agent voltou a ser barrado: ver ANEXO-TECNICO A2.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const txt = String(document.body && document.body.innerText || '')
    if (/Google Chrome 100|navegador|browser/i.test(txt) && /Chrome/i.test(txt) && txt.length < 2000) {
      console.warn('[sellwave] possivel tela de navegador nao suportado. Conferir o userAgentFallback.')
    }
  } catch (_) { /* ok */ }
})
