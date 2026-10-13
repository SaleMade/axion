# Bot do grupo (SellWave)

O WhatsApp Web do numero do bot, rodando num PC do Bruno. Sem VPS. Ele conversa com o worker
`axion-api` (rotas `/api/bot/agente/ping` e `/api/bot/agente/ack`) usando o token que aparece em
Ferramentas > Bot de WhatsApp > Grupo do WhatsApp > "Onde roda o WhatsApp Web do bot".

O worker guarda a fila (resumo diario, semanal, comemoracoes, mensagem livre); este bot busca a fila
a cada 15 segundos e manda no grupo. PC desligado = a mensagem espera na fila (ate 20h) e sai quando
o bot ligar.

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
- `sessao/`: a sessao do WhatsApp (nao versionar, nao copiar entre PCs com o bot ligado nos dois).
- `bot-grupo.json`: endereco do worker e token (nao versionar).
