# ZapVoice Nosso (extensão Chrome) — v0

Soundboard do funil pro **WhatsApp Web**. O atendente abre uma conversa e dispara os áudios/vídeos que ele mesmo gravou, com 1 clique. O envio sai pela nossa Evolution (via Worker AXION) e aparece no chat, tudo logado no histórico.

> Importante: só funciona no **WhatsApp Web** (web.whatsapp.com no Chrome). O app da Windows Store é fechado e não aceita extensão. O número do atendente precisa estar conectado na nossa Evolution (é a instância que ele configura aqui).

## Como instalar (fazer uma vez)
1. Abra o Chrome em `chrome://extensions`
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação** e escolha esta pasta (`zapvoice-ext`)
4. A extensão aparece na lista. Fixa ela na barra se quiser.

## Como configurar (cada atendente)
1. Clique com o botão direito no ícone da extensão → **Opções** (ou clique no ícone)
2. Em **Conexão**: confirme o servidor, coloque seu **login e senha da AXION** e o **nome da sua instância** (número na Evolution). Clique em **Entrar e salvar**.
3. Em **Meus áudios e vídeos**: escolha a fase do funil, dê um nome e suba o áudio **gravado com a sua voz**. Repita pra cada áudio. Vídeos de prova social: adicione por URL (são grandes).

## Como usar (dia a dia)
1. Abra `web.whatsapp.com` no Chrome, logado no número do atendimento
2. Abra a conversa do lead. Aparece o painel **ZapVoice Nosso** no canto
3. O número do chat é detectado sozinho (dá pra corrigir na mão)
4. Clique no áudio/vídeo da fase certa → ele é enviado na hora

## O que essa v0 faz e o que ainda vem
- [x] Painel no WhatsApp Web, detecta o número do chat aberto
- [x] Biblioteca por fase do funil (áudio/imagem por upload, vídeo por URL)
- [x] Envio 1 clique via Evolution, logado no histórico da AXION
- [ ] Biblioteca compartilhada do time (hoje é local por atendente)
- [ ] Simular "gravando..." antes do áudio
- [ ] Métrica de qual áudio mais converte
- [ ] Amarrar no lead do CRM (nome, etapa)

## Depende de
- Endpoints do Worker: `POST /api/wa/send-audio`, `POST /api/wa/send-media` (já no ar)
- Número do atendente conectado na Evolution como instância
