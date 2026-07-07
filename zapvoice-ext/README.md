# ZapVoice Nosso (extensão Chrome) — v0.2 (motor WA-JS)

Soundboard do funil pro **WhatsApp Web**. Já vem com os 6 áudios do funil campeão (Rafael) por fase. O atendente abre a conversa do lead e dispara o áudio com 1 clique, simulando "gravando...", **pela própria sessão dele** (igual o ZapVoice/WaSeller).

## Por que essa versão é diferente da anterior
Ela roda em cima do **WA-JS (WPPConnect)**, a mesma base que o ZapVoice e o WaSeller usam. Isso muda tudo:
- **Detecta a conversa aberta de verdade** (`WPP.chat.getActiveChat`), não fica adivinhando o HTML.
- **Envia pela sessão do atendente** como nota de voz real (PTT), não por um número separado.
- **Simula "gravando..."** antes do áudio (o truque que faz parecer gravado na hora).
- Não precisa de login nem configurar número. Instalou, funciona.

## Instalar (uma vez, por atendente)
1. Chrome → `chrome://extensions` → liga **Modo do desenvolvedor**
2. **Carregar sem compactação** → escolhe a pasta `zapvoice-ext`
3. Abre/atualiza `web.whatsapp.com` (logado no número do atendimento)

## Usar
1. Abra a conversa do lead. O painel **ZapVoice Nosso** aparece no canto e mostra pra quem vai enviar (bolinha verde = pronto).
2. Clique no áudio da fase certa (F1 Abertura, F4 Dor, F9 Oferta...). Ele grava e envia na conversa aberta.
3. Em "config" você adiciona os **seus** áudios (a sua voz) e vídeos de prova social.

## Estrutura
- `vendor/wppconnect-wa.js` — motor WA-JS (injeta a API `WPP`)
- `bridge.js` — roda no mundo da página, fala com o `WPP` (chat aberto, gravando, enviar)
- `content.js` + `panel.css` — o painel
- `audios/` + `library.json` — os 6 áudios do funil campeão por fase
- `options.html/js` — cadastro dos áudios do atendente

## Já surpassa ZapVoice/WaSeller em
- Vem com o **funil campeão pronto** (eles vêm vazios)
- Organizado **por fase do funil** (eles são lista solta)

## Ainda vem (pra abrir distância)
- [ ] Biblioteca **compartilhada do time** (hoje os áudios extras são por atendente)
- [ ] **Sequência**: disparar o funil inteiro em ordem com pausas humanas
- [ ] Amarrar no **lead do CRM** da AXION + medir **qual áudio converte**
- [ ] Simular "digitando..." nos textos e envio de vídeo por 1 clique
