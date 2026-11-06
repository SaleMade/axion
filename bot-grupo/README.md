# Bot do grupo (SellWave)

O WhatsApp Web do numero do bot, rodando num PC do Bruno. Sem VPS. Ele conversa com o worker
`axion-api` (rotas `/api/bot/agente/ping` e `/api/bot/agente/ack`) usando o token que aparece em
Ferramentas > Bot de WhatsApp > Grupo do WhatsApp > "Onde roda o WhatsApp Web do bot".

O worker guarda a fila (resumo diario, semanal, comemoracoes, mensagem livre); este bot busca a fila
a cada 15 segundos e manda no grupo. PC desligado = a mensagem espera na fila (ate 20h) e sai quando
o bot ligar.

Desde a 1.6.0 ele tambem LE os grupos que o worker mandar escutar (lista `escuta` do ping): cada
mensagem vai pro worker (`/api/bot/agente/msg`), que decide se o bot responde e devolve o texto; o bot
manda no grupo citando a pergunta, com "digitando" antes, e confirma (`/api/bot/agente/msg-ack`).
Nada e decidido no PC. Pergunta com mais de 2 minutos (o bot estava fora) fica sem resposta.

## Instalar num PC novo
1. Node 20 ou mais novo instalado (`node -v`).
2. Copiar esta pasta (sem `node_modules`, sem `sessao`) e rodar `npm install` dentro dela.
3. Criar `bot-grupo.json` ao lado do `agente.mjs`:
   ```json
   { "api": "https://axion-api.axion-dash.workers.dev", "token": "<token da tela>" }
   ```
4. Dois cliques em `bot-grupo.bat`. Na dash, Grupo do WhatsApp > Conectar por QR, e escanear com o
   celular do numero do bot (WhatsApp > Aparelhos conectados > Conectar aparelho).
5. Pra ligar sozinho ao entrar no Windows (sem janela): tarefa agendada rodando `bot-grupo-oculto.vbs`.
   Neste PC ela ja existe com o nome "SellWave Bot do grupo". Log em `bot-grupo.log`.

## Arquivos
- `agente.mjs`: o bot (Baileys). Flags: `--uma-vez` (conecta, esvazia a fila e sai).
- `entrada.mjs`: o que chega do grupo, em funcoes puras (texto, quem mandou, marcou o bot, citacao, o
  pacote pro worker). `teste-entrada.mjs` confere tudo sem conectar: `node teste-entrada.mjs`.
- `sessao/`: a sessao do WhatsApp (nao versionar, nao copiar entre PCs com o bot ligado nos dois).
- `bot-grupo.json`: endereco do worker e token (nao versionar).
