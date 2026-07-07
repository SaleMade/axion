# ZapVoice Nosso — v0.3

Soundboard do funil campeao pra disparar audios (voz real) com 1 clique, DENTRO do WhatsApp. Vem com os 6 audios do Rafael por fase. Motor: **WA-JS (WPPConnect)**, a mesma base que ZapVoice/WaSeller usam.

Tem **dois modos**. O importante pro teu time e o **modo APP**.

---

## MODO APP (recomendado) — dentro do WhatsApp da Windows Store

O app da Store hoje e um WebView2 (Chromium por dentro rodando web.whatsapp.com). A gente liga a porta de debug dele e **injeta o painel por dentro do proprio app**, na mesma janela onde o atendente liga e conversa. Nao e extensao, nao troca o jeito de trabalhar deles.

### Instalar / rodar
1. Precisa do **Node.js** instalado na maquina do atendente (https://nodejs.org, versao LTS).
2. Da dois cliques em **`start.bat`**.
   - Na primeira vez ele liga a porta de debug e reinicia o WhatsApp sozinho.
   - Depois injeta o painel e fica vigiando (se o WhatsApp reiniciar, reinjeta).
3. Deixa a janela preta aberta. Abre o WhatsApp, entra numa conversa: o painel **ZapVoice Nosso** aparece no canto.

### Usar
- Abre a conversa do lead. O painel mostra pra quem vai enviar (bolinha verde).
- Clica no audio da fase (F1 Abertura, F4 Dor, F9 Oferta...). Ele simula "gravando..." e manda como **nota de voz** pela sessao do proprio atendente.

---

## MODO WEB — extensao no WhatsApp Web (Chrome)

Se o atendente usa o WhatsApp Web no Chrome em vez do app:
1. `chrome://extensions` -> Modo do desenvolvedor -> Carregar sem compactacao -> esta pasta.
2. Abre web.whatsapp.com. Mesmo painel, mesmos audios.

---

## Arquivos
- `start.bat` / `start.ps1` — lancador do MODO APP (liga a porta + injeta)
- `inject.js` — conecta no WebView2 (CDP) e injeta o WA-JS + painel dentro do app
- `panel-inject.js` — o painel que roda dentro do app (chama o WPP direto)
- `manifest.json` + `content.js` + `bridge.js` — o MODO WEB (extensao)
- `panel.css` — visual do painel (usado pelos dois modos)
- `vendor/wppconnect-wa.js` — motor WA-JS
- `audios/` + `library.json` — os 6 audios do funil campeao por fase
- `diag.js` — ferramenta de diagnostico (dev)

## Como ja passa ZapVoice/WaSeller
- Vem com o **funil campeao pronto**, por fase (eles vem vazios)
- Roda **dentro do app de desktop** (o ZapVoice so roda no navegador)
- Deteccao de conversa nativa (WA-JS), envio como PTT de verdade, "gravando..." embutido

## Proximo (pra abrir distancia)
- [ ] Biblioteca compartilhada do time + audios proprios do atendente no modo app
- [ ] Sequencia: disparar o funil inteiro em ordem com pausas humanas
- [ ] Amarrar no lead do CRM AXION + medir qual audio converte

## Notas tecnicas
- A porta de debug (9222) fica so no localhost. E o mecanismo padrao do WebView2 (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`). Pra remover: apagar a variavel de ambiente do usuario e reiniciar o WhatsApp.
- Precisa de Node 21+ (WebSocket nativo). Testado no Node 24.
