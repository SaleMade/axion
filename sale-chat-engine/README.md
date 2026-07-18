# Sale Chat Engine (motor que substitui a Evolution API)

Pasta que organiza a migração: fazer o Sale Chat capturar e disparar tudo que a Evolution API faz hoje, pra operar com 1 conexão só (o WhatsApp Web do vendedor). Motivo: a Evolution (Baileys) está derrubando números e caindo o faturamento.

Plano completo: `../PLANO-SALECHAT-SUBSTITUI-EVOLUTION.md`.

## Backup / rollback (feito antes de começar)
- Git tag: `backup-pre-salechat-20260717` (commit 96e2a5f)
- Git branch: `backup/pre-salechat-migracao`
- Cópia dos arquivos: `backup-pre-migracao-20260717/`
- Reverter um arquivo: `git checkout backup-pre-salechat-20260717 -- <arquivo>`
- Reverter tudo: `git reset --hard backup-pre-salechat-20260717` (cuidado, descarta mudanças)

## Regra de ouro da migração
Nunca virar a chave de uma vez. A Evolution fica LIGADA de rede de segurança até o Sale Chat provar cobertura ~100%. Tudo aditivo e reversível. O worker reusa a lógica que já existe (`_waOnInbound`, `_waLeadCapture`, `_waDetectSale`, `_ttFireSale`, `wa_attrib`, `cpf_attrib`, `resolveAtByCpf/Phone`, `handlePaytWebhook`), só troca a FONTE (Evolution -> Sale Chat).

Lembretes do projeto: `sc-panel.js` espelha `zapvoice-ext/panel-inject.js` SEMPRE; `index.html` e `axion_v2.html` idênticos; dar push após cada melhoria.

## Checklist por fase

### Fase 0 - fundação (aditivo, sem mudar comportamento ao vivo) - NO AR (deploy 17/07, commit 3cb097e)
- [x] Tabela `wa_number_owner` (número do vendedor -> at) + `resolveOwner(selfNumber)` no worker (atribuição resolvida no SERVIDOR, nunca confiar no cliente)
- [x] Tabela de auditoria CRUA (`sc_ingest_audit`, sem dedup, flag `source` = evo|sc) pra validar captura
- [x] Endpoint `POST /api/salechat/ingest/<token>` (fail-closed, token `sc_ingest_token` em `app_config`), gravando só na auditoria crua
- [x] Endpoint `POST /api/salechat/heartbeat/<token>` (tabela `sc_heartbeat`) + `GET /api/salechat/health` (Diretor)
- [ ] Normalizar dedup pro id puro em `wa_sales`/`wa_messages` (feito com cuidado antes da Fase 2)
- [ ] Painel de saúde na dash (UI que consome `/api/salechat/health`: heartbeat/lastSeen por número, tamanho do outbox, número sem dono)

### Fase 1a - captura em sombra pra AUDITORIA (Evolution ligada) - FEITO (commit desta etapa)
- [x] Painel (`sc-panel.js`/`panel-inject.js`): `_scCapture(msg)` no `onIncoming` ANTES do filtro `fromMe`; lê `selfNumber` (`WPP.conn.getMyUserId`, cache 60s); fila `window.__zvOutbox` (sobrevive a reinjeção); contraparte = `msg.to` quando fromMe (risco 1); `__zvOutboxDump()` no console pra PoC sem servidor
- [x] Injetor (`inject.js`): `pumpOutbox()` (molde do `pumpVideo`) drain ack-based; `pumpHeartbeat()`; token via env `ZV_INGEST_TOKEN` ou arquivo `ingest-token.txt`
- [x] Worker: ingest grava só na auditoria crua (Fase 0), devolve ack
- [ ] `sweepRecent()` na subida/reconexão (pegar msg que chegou antes do listener) - PENDENTE
- [ ] Fila durável em ARQUIVO no injetor (hoje sobrevive a reinjeção do painel, não ao fechar o app) - PENDENTE

### Fase 1b - medir cobertura em sombra (Evolution ligada) - FEITO (deploy 17/07)
- [x] Espelhar o inbound da Evolution na auditoria crua (`source='evo'`) pra comparar com o Sale Chat (`source='sc'`) - em `_waOnInbound`, fire-and-forget
- [x] Semear `wa_number_owner` (número->at) a partir de `data.chips` (`_scSeedOwners`, disparado ao abrir `/api/salechat/health`)
- [x] Ingest resolve o dono no SERVIDOR e grava `at_id` na auditoria (coluna nova via ALTER)
- [x] `/api/salechat/health` mostra a cobertura (leads distintos por fonte: sc x evo)
- [ ] Semear owners por cron (hoje só ao abrir a saúde) - melhoria futura
- [ ] Aba de saúde na dash que consome `/api/salechat/health` (hoje dá pra ver o JSON direto) - melhoria
- [ ] Critério pra avançar pra Fase 2: Sale Chat cobre >= Evolution em leads por vários dias

Nota: NÃO liguei o ingest no `_waLeadCapture`/pixel de propósito (dispararia pixel DUPLICADO com a Evolution ligada). Isso é a Fase 2 abaixo (virar o gatilho e desligar SÓ o pixel do lado Evolution).

### Fase 2 - venda + pixel pelo Sale Chat
- [ ] Capturar "Pedido Concluído" `fromMe`; worker reusa `_waDetectSale`
- [ ] Disparo de pixel pelo Sale Chat; desligar SÓ o pixel do lado Evolution
- [ ] Critério: vendas/faturamento por vendedor idênticos; zero pixel duplicado

### Fase 3 - auto-resposta client-side (mover o que bane pra fora da Evolution)
- [ ] Auto-resposta 1o contato + gatilho na fila serial, claim server-side, anti-ban (jitter, teto diário, sem link)
- [ ] Desligar o disparo da Evolution
- [ ] Critério: zero duplicidade, caps respeitados, zero ban por semanas

### Fase 4 - desligar a captura da Evolution
- [ ] Só quando tt_pending x wa_lead mostrar zero buraco por dias
- [ ] Webhook Evolution off, instâncias logout
- [ ] Atualizar a UI: remover/ocultar botões de conectar/desconectar e "instâncias conectadas" na Pressel; métricas passam a ler a nova fonte

## Áreas da dash que mudam (mapear antes de mexer)
- Pressel/Contingência: botões de conectar/desconectar WhatsApp na Evolution e "instâncias conectadas" (deixam de ser úteis)
- Métricas das pressels: hoje coletam da Evolution, precisam ler a nova fonte
