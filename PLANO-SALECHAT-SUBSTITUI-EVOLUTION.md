# Plano Final: Sale Chat assume a Evolution (captura, pixel, atribuicao e disparo com 1 conexao so)

## 1. Resumo em 5 linhas (pro dono)

Hoje cada numero vive em dois lugares: a Evolution (cliente nao-oficial na VPS, o que mais arrisca ban) e o Sale Chat (no WhatsApp do proprio vendedor). Vamos fazer o Sale Chat capturar e fazer TUDO que a Evolution faz: ver todo lead que chega, reconhecer o numero do vendedor, detectar a venda, disparar os eventos do pixel do TikTok e mandar as auto-respostas. O disparo automatico sai primeiro da Evolution (e o que mais bane), e a captura da Evolution so e desligada quando o Sale Chat provar, com numeros na mao, que esta pegando 100% dos leads. Resultado: 1 conexao so, o WhatsApp real do vendedor, sem custo novo, reusando quase tudo que ja existe no worker. Nada de virar a chave de uma vez: roda em paralelo, compara, e so corta quando bate.

## 2. O que o Sale Chat vai passar a fazer (era da Evolution, agora e dele)

- Capturar TODO lead que chega, nao so a conversa aberta (via `WPP.on('chat.new_message')`, que ja e global).
- Reconhecer o numero logado do vendedor (via `WPP.conn.getMyUserId`) e mandar em cada evento.
- Detectar a venda lendo o "Pedido Concluido" que o vendedor envia (mensagem `fromMe`).
- Alimentar as tabelas de atribuicao (`wa_lead`, `wa_attrib`, `cpf_attrib`) que dizem qual vendedor fez a venda.
- Fazer o backend disparar o pixel de LEAD (`InitiateCheckout`) e de VENDA (`CompletePayment`).
- Enviar as auto-respostas (1o contato e por gatilho) pelo proprio WhatsApp do vendedor, com trava anti-ban.
- Reportar presenca (heartbeat) pra roleta saber quais numeros estao vivos e logados.

## 3. Como funciona (arquitetura)

Principio: o worker JA tem toda a logica (captura, casamento de ttclid, deteccao de venda, pixel, atribuicao). Hoje ela e alimentada por um ponto so, o `handleEvolutionWebhook`. Vamos criar uma segunda fonte (o Sale Chat) que entrega ao worker o MESMO formato de payload, e o worker roda as MESMAS funcoes. Nao reescrevemos `_waLeadCapture`, `_waDetectSale`, `saveCpfAttrib`, `_ttSend`, `_ttFireSale`, `resolveAtByCpf/Phone`, `handlePaytWebhook` nem a pagina de Leads.

Os tres pedacos:

1. Painel (`sc-panel.js`, roda dentro do WhatsApp Web): captura o evento no `WPP.on('chat.new_message')`, monta o payload e faz append numa fila (`window.__zvOutbox`). Nao faz POST direto (a CSP do WhatsApp bloqueia; o codigo inteiro foi desenhado pra fugir disso).
2. Injetor (`inject.js`, processo Node fora do navegador, sem CSP e sem throttle de aba): novo loop `pumpOutbox()` drena a fila por CDP e faz POST em lote pro worker. So remove da fila os eventos que o worker confirmou (ack por msgId). A fila duravel mora em ARQUIVO no disco do injetor (nao no localStorage do WhatsApp, que e volatil).
3. Worker (`worker.js`): novo endpoint `POST /api/salechat/ingest/<token>` (fail-closed, token em `app_config`) que recebe o lote e, pra cada evento, roda a mesma cadeia do webhook Evolution MENOS os envios server-side: `_waOnInbound` (sem o `evoFetch` da auto-resposta) e `_waDetectSale`.

Caminho de um lead, passo a passo:
1. Lead clica no anuncio, cai na pressel. `handlePresselPublic` grava `tt_pending` (inst, ttclid, pid, code de 6 chars) e injeta `Código de desconto "XXXX"!` no texto do WhatsApp. (Isso ja funciona, nao muda.)
2. Lead manda a mensagem no WhatsApp do vendedor. O painel captura via `chat.new_message`, extrai `{phone, body, fromMe, msgId, pushName, ts, selfNumber}` e da append no outbox.
3. Injetor drena e faz POST pro `/api/salechat/ingest`.
4. Worker resolve `instance = ax_<at>` a partir do `selfNumber` (server-side, ver secao 4), roda `_waOnInbound` -> `_waLeadCapture`: casa o `code` com `tt_pending`, grava `wa_lead` (com pid/ttclid) e `wa_attrib`, e dispara `InitiateCheckout` via `_ttSend`.
5. Vendedor fecha o pedido e manda o "Pedido Concluido". Painel captura (inclusive `fromMe`), envia. Worker roda `_waDetectSale`: parse Nome/Valor/CPF, grava `wa_sales`, alimenta `cpf_attrib` e dispara `CompletePayment`.
6. Payt manda o postback da receita real. `handlePaytWebhook` credita o vendedor via `resolveAtByCpf(cpf) || resolveAtByPhone(phone)`, lendo as pontes que o Sale Chat acabou de preencher. Zero mudanca aqui.

## 4. Atribuicao por numero e a pagina de Leads/metricas

A regra de ouro: o cliente reporta o NUMERO logado, nunca o `at`. Quem decide o vendedor e o servidor. Motivo (critica item 9): se o vendedor logar o WhatsApp pessoal ou o install estiver mal configurado, confiar no `at` do cliente joga lead e comissao no nome errado.

Como cada lead vira "numero X, vendedor Y":

1. O painel le o numero logado (`WPP.conn.getMyUserId` / `UserPrefs.getMaybeMeUser`), serializa defensivo (`_serialized || toString()`, so digitos) e manda como `selfNumber` em todo evento. Rele quando o vendedor troca de chip (nunca cacheia pra sempre).
2. O worker resolve `selfNumber -> at` contra uma tabela canonica `wa_number_owner (number PK, at_id, instance)`, semeada a partir de `state.chips` (que ja tem `c.at` + `c.num`, cross-checado por `_servConnOk`) e de `wa_conn`. Se o numero nao estiver no registro: QUARENTENA. Nao atribui a ninguem, marca `owner_unknown=1` e alarma na dash "numero X capturando sem dono cadastrado".
3. `wa_lead.num` recebe o `selfNumber` direto do evento (nao mais o `ownerJid` da Evolution). `wa_lead.inst` recebe `ax_<at>` resolvido no servidor.
4. Normalizacao dura (critica item 10): `selfNumber` tem que bater EXATO com o formato de `chip.num` (55 + DDD + 9o digito conforme o cadastro), senao o `_servConnOk` da roleta derruba o vendedor em silencio. Testar com os 38 numeros reais, DDDs variados, antes do corte.

A pagina de Leads (`handlePresselsTotalPage`, `view=leads`) nao muda uma linha: continua agrupando por `baseAt(l.inst)` (vendedor, casando `at_id` com `users.name`) e por `l.num` (numero). O `index.html`/`axion_v2.html` nao mexem, porque a pagina e server-rendered e le as mesmas tabelas.

## 5. Auto-resposta client-side + anti-ban

O envio sai do proprio WhatsApp Web oficial do vendedor (fingerprint humano), o que ja e muito menos detectavel que o Baileys. Mas o numero agora em risco e o numero REAL de operacao, entao a trava anti-ban e obrigatoria (critica itens 5 e 18: reduzimos deteccao, nao a violacao, e o custo de um ban sobe).

Decisao: o CLIENTE decide e envia (config puxada de `/api/salechat`), o SERVIDOR so faz o claim de dedup. Round-trip de comando pro servidor recriaria a dependencia de rede que estamos removendo. Antes de enfileirar a auto-resposta de 1o contato, o painel chama `POST /api/salechat/claim-reply {phone, kind, selfNumber}`, que roda o mesmo `INSERT OR IGNORE INTO wa_replied` (dedup 12h) / `wa_autoreply_log` (6h) e responde `{claimed:true|false}`. So envia se `true`. Isso sobrevive a reinjecao, reload e ate a dois installs do mesmo numero, porque o claim e no D1 central.

Regras anti-ban (todas passam pela fila serial `jobs`/`pumpJobs`, que ja garante um envio por vez com watchdog de 15s, o unico caminho de saida):
- So inbound: auto-resposta so reage a mensagem que chegou (1o contato) ou ao `fromMe` do gatilho. Nunca disparo frio em lote.
- Delay humano + digitando: `markIsComposing` antes de texto, `markIsRecording` antes de audio (ja implementados), delay proporcional ao tamanho.
- Jitter grande entre jobs (ex. 3 a 8s aleatorio) alem do `delaySec` da regra.
- Teto diario por numero: contador em disco por numero; acima do teto, para de auto-responder (loga, nao envia).
- Sem link na 1a mensagem.
- Card de contato (vCard) automatico: questionar se vale o risco. Portar `WPP.chat.sendVCardContactMessage` so na Fase 3, e so em mensagens posteriores por gatilho, nunca no 1o contato.

## 6. O ponto critico da captura 24/7 (com honestidade)

O que se perde: a Evolution recebia inbound na VPS 24/7, mesmo com o PC do vendedor DESLIGADO. O Sale Chat so ve a mensagem se o app estiver aberto e o motor vivo. Cenario real que perde lead (critica item 2): a roleta manda o lead pro numero X (deep-link so pra ele), o PC do vendedor dorme/cai a net/fecha o app, 20 min depois o cliente escreve. O `chat.new_message` nunca dispara. Pior: se o vendedor le no CELULAR, a mensagem chega LIDA no Web e nem o backfill por "nao lida" pega. Esse lead foi endereçado so pra aquele numero, nenhum outro vendedor o ve.

Mitigacao recomendada (a de maior retorno e menor risco):
1. NAO matar a Evolution como CAPTURADORA de inbound junto com o disparo. Separar as duas decisoes. O que bane e o DISPARO automatico via cliente nao-oficial; o inbound puro do Baileys (so recebe) quase nao bane. Mata-se o disparo ja (Fase 3) e mantem-se a Evolution como rede de seguranca SILENCIOSA de inbound ate o Sale Chat provar cobertura ~100%. So entao corta a captura da Evolution (Fase 4).
2. `sweepRecent()` na subida/reconexao do painel: varre o ChatStore por `ts > lastSyncTs` (por timestamp, NAO so por nao-lida, pra pegar o que foi lido no celular), e reprocessa idempotente. Fecha a janela de app-fechado recente.
3. Heartbeat curto (30 a 60s) so de presenca + cron marcando offline agressivo. A roleta ignora quem nao bate heartbeat ha 1 a 2 min, pra reduzir lead mandado pra PC morto (critica item 13). Ainda sobra a janela do intervalo; por isso a rede de seguranca da Evolution (ponto 1) e o que de fato cobre.

Limite conhecido que fica documentado: mensagem que chega com a maquina em reboot/desligada e ja saiu da janela do sweep e ponto cego. E igual ou melhor que a Evolution quando a instancia dela caia, mas existe.

## 7. Provas de conceito obrigatorias ANTES de construir

Nao escrever uma linha de producao antes de provar, em chat/numero real:

1. Contraparte em mensagem `fromMe` (critica item 1, o mais grave): confirmar que numa mensagem que o VENDEDOR mandou (`fromMe===true`), o numero do CLIENTE vem de `msg.to`/chatId, e NAO de `msg.from` (que e o proprio vendedor). A regra de phone e "sempre a contraparte do chat" (`msg.to` quando fromMe, `msg.from` quando inbound), e SO DEPOIS aplicar @lid. Testar com uma venda conhecida: se sintetizar errado, a venda entra no telefone do vendedor, o dedup de 24h colapsa varias vendas numa so e o CompletePayment vai com hash errado.
2. Chat `@lid`: confirmar de onde sai o numero real (cascata `msg.from` -> `msg.author` -> `senderObj` -> `contact.id`; normalizar `split('@')[0]`). Se so sobrar `@lid`, marcar `phone_unresolved` e mandar mesmo assim (worker resolve depois), nunca descartar.
3. `chat.new_message` minimizado 24h (critica item 3, hoje e fe, nao fato): rodar um numero real 24h com a janela minimizada/ocluida e o OS em economia de energia (o notebook Lenovo ja e pegadinha conhecida do projeto). Medir se os eventos chegam em tempo real, atrasados, ou so no refocus, e se algum se perde. Sem isso o pilar 24/7 nao esta provado.
4. `getMyUserId()`: retorna numero estavel, no formato que casa EXATO com `chip.num`.
5. `sendTextMessage`/`downloadMedia` minimizado e pra JID nao-aberto, sem estourar rate limit.
6. `key.id` (Baileys) == `msg.id.id` (WA-JS, id PURO, extraido do `_serialized` que vem `true_<jid>_<id>`) pro MESMO "Pedido Concluido", medido numa tabela de auditoria CRUA sem dedup (critica item 8: `wa_sales` deduplica por telefone+24h ANTES do msg_id, entao a comparacao normal esconde a divergencia de formato).

## 8. Fases de entrega (cada uma com criterio de sucesso pra avancar)

Fase 0 (gratis, sem mudar comportamento): fundacao de identidade e dedup.
- Criar `wa_number_owner` semeada de `state.chips` + `wa_conn`. Funcao `resolveOwner(selfNumber)`.
- Normalizar chave de dedup pro id PURO em `wa_sales`/`wa_messages`.
- Criar tabela de auditoria CRUA (sem dedup, com flag `source` = `evo`|`sc`) pra validar msg_id.
- Endpoint `POST /api/salechat/ingest` (idempotente, lote, ack por msgId) gravando so na auditoria crua primeiro.
- Rodar as PoCs da secao 7.
- Sucesso pra avancar: as 6 PoCs passam, e o msg_id do Sale Chat casa com o da Evolution na tabela crua.

Fase 1 (captura em sombra, Evolution LIGADA): o Sale Chat captura em paralelo, sem desligar nada.
- Painel: `captureIncoming(msg)` no `onIncoming` ANTES do filtro `fromMe`; leitura do `selfNumber`; `window.__zvOutbox` + espelho pra handoff rapido ao injetor; `sweepRecent()` na subida/reconexao.
- Injetor: `pumpOutbox()` com POST autenticado, drain ack-based (nunca `splice` cego, critica item 12), fila duravel em arquivo no disco; heartbeat de numero.
- Worker: ingest chama `_waOnInbound`/`_waLeadCapture` de verdade (grava `wa_lead`/`wa_attrib`), casamento `tt_pending` por code e o backfill de ttclid (`UPDATE wa_lead SET ttclid WHERE ttclid IS NULL`, critica item 6), entregando as mensagens de um mesmo telefone em ordem de `ts`. Quarentena de numero sem dono.
- Detector de falha silenciosa como cidadao de primeira classe (critica item 15): cruzar `tt_pending` (cliques mandados pro numero) x `wa_lead` (leads que apareceram). Numero com cliques e zero leads = capturador morto, alarme na dash.
- Sucesso pra avancar: por varios dias, o Sale Chat cobre >= a Evolution em leads por numero/vendedor, medido na auditoria crua. Pagina de Leads mostra os dois batendo.

Fase 2 (venda + pixel pelo Sale Chat): virar o gatilho de pixel.
- Capturar o "Pedido Concluido" `fromMe`; worker reusa `_waDetectSale` (grava `wa_sales`, `saveCpfAttrib`, dispara `_ttFireSale`).
- Ligar disparo de pixel (LEAD/VENDA) pelo Sale Chat e desligar SO o disparo de pixel pelo lado Evolution.
- Validar Payt: `resolveAtByCpf`/`resolveAtByPhone` continuam creditando o vendedor certo.
- Sucesso pra avancar: contagem de vendas e faturamento por vendedor identicos aos da Evolution; zero pixel duplicado no TikTok (event_id deterministico garante isso); atribuicao Payt intacta.

Fase 3 (auto-resposta e disparo client-side): mover o que bane pra fora da Evolution.
- Auto-resposta de 1o contato + por gatilho na fila serial, com claim server-side (`wa_replied`/`wa_autoreply_log`) e anti-ban completo (secao 5). Portar `sendVCardContactMessage`.
- Desligar o disparo da Evolution (nao a captura ainda). Aposentar/reapontar `/api/wa/send*` usados manualmente.
- Sucesso pra avancar: auto-respostas saindo sem duplicidade (nem entre principal e `_b`), caps respeitados, zero ban observado por semanas.

Fase 4 (desligar a captura da Evolution): so quando o detector de falha silenciosa mostrar zero buraco (tt_pending x wa_lead) por varios dias.
- Webhook Evolution off, instancias em logout. `wa_conn` vive do heartbeat.
- Manter `handleWASaleAdd` (fallback manual) e `resolveAtByCpf/Phone` intactos.
- Rollback: religar o webhook. Nada foi removido do worker, reversivel a qualquer momento.
- Sucesso: 1 a 2 semanas monitorado, `wa_number_owner` como fonte unica de identidade, faturamento estavel.

## 9. Arquivos e funcoes a mexer

worker.js (backend):
- NOVO `handleSalechatIngest` (roda `_waOnInbound` sem envio + `_waDetectSale`) e rota `POST /api/salechat/ingest/<token>` no dispatch (perto de ~3350, ao lado do `evoMatch`).
- NOVO `handleSalechatHeartbeat` (UPSERT `wa_conn`) e `handleSalechatClaimReply` (dedup `wa_replied`/`wa_autoreply_log`).
- REFATORAR `_waOnInbound`: extrair o trecho de envio de auto-resposta de 1o contato (linhas ~2028 a 2050) pra `_waFirstContactReply`, que NO caminho Sale Chat nao chama `evoFetch`.
- NOVA tabela `wa_number_owner` + `resolveOwner(selfNumber)`; NOVA tabela de auditoria crua com flag `source`.
- Normalizar dedup pro id puro em `wa_sales`/`wa_messages`. Backfill de ttclid em `_waLeadCapture` (`UPDATE ... WHERE ttclid IS NULL`).
- Token `sc_ingest_token` em `app_config` (fail-closed).
- NAO mexer: `_waLeadCapture` (so o backfill), `_waDetectSale`, `saveCpfAttrib`, `_ttSend`, `_ttFireSale`, `_ttPixelToken`, `resolveAtByCpf/Phone`, `handlePaytWebhook`, `handlePresselsTotalPage`.

sc-panel.js (painel) E panel-inject.js (regra de ouro do projeto: espelhar SEMPRE os dois; o servidor serve `sc-panel.js`, o disco serve `panel-inject.js`/`panel.css`):
- `captureIncoming(msg)` chamado em `onIncoming` ANTES do filtro `fromMe`; regra phone = contraparte + @lid.
- Leitura do `selfNumber` (`WPP.conn.getMyUserId`).
- Fila `window.__zvOutbox` (padrao `window.__zv*`, sobrevive a reinjecao) + handoff rapido pro injetor.
- `sweepRecent()` na subida/reconexao (`watchLate` -> `bindTriggers`).
- Auto-resposta via fila serial `jobs` com jitter + caps; claim server-side; portar `sendVCardContactMessage`.
- Estender `__zvBusy` pra retornar true com outbox pendente (adia auto-update ate drenar).

inject.js (host Node):
- Loop `pumpOutbox()` (molde do `pumpVideo`): drain ack-based, POST em lote autenticado, fila duravel em ARQUIVO no disco (nao localStorage).
- Heartbeat de numero. Injetar as acoes de auto-resposta na fila do painel.

index.html / axion_v2.html (dash, os dois identicos, espelhar qualquer mudanca): nenhuma mudanca no fluxo de captura. Adicionar so o painel de saude (heartbeat/lastSeen por numero, tamanho do outbox, quarentena de numero sem dono, alarme tt_pending x wa_lead).

Lembrete operacional: dar push apos cada melhoria (regra do projeto).

## 10. Riscos e o que pode dar errado

1. Venda no numero errado por `fromMe` (gravidade maxima). Phone tem que ser a contraparte (`msg.to` quando fromMe), nunca `msg.from`. Provar em venda real ANTES de tudo (PoC 1).
2. Lead roteado pra PC morto = lead perdido sem rede. Mitigacao central: manter a Evolution como capturadora de inbound silenciosa ate cobertura ~100%; heartbeat curto + cron agressivo; sweepRecent por timestamp.
3. `chat.new_message` throttlado minimizado. Nao esta provado. PoC 3 obrigatoria antes de construir.
4. WA-JS e engenharia reversa: falha silenciosa e distribuida em 38 PCs. O detector tt_pending x wa_lead + canario no heartbeat (quantos eventos WPP vistos, getMyUserId respondeu) e o que substitui a confiabilidade central perdida. Nao e opcional.
5. Ban do numero real de operacao. So-inbound, fila serial, jitter grande, teto diario, sem link, e questionar o vCard automatico. Mover disparo pro cliente reduz deteccao, nao a violacao; o custo de um ban sobe.
6. Atribuicao quebra se a 1a mensagem nao tem o code. Backfill de ttclid no worker + ordem por `ts` no lote. No sweepRecent, casar SO por code exato, nunca inventar FIFO retroativo (critica item 7).
7. FIFO cola telefone no ttclid errado. Encurtar a janela; nunca FIFO no replay.
8. msg_id Baileys vs WA-JS divergindo esconde-se atras do dedup por telefone. Validar na tabela de auditoria CRUA (PoC 6), nao em `wa_sales`.
9. Confiar no `at` do cliente polui comissao. Resolver numero -> at no servidor + quarentena. Nunca confiar no cliente.
10. Normalizacao de `selfNumber` diferente de `chip.num` derruba o vendedor da roleta em silencio. Bater exato, testar os 38 numeros.
11. Outbox em localStorage do WhatsApp e volatil. Dono da fila duravel = injetor (arquivo no disco), painel so faz handoff rapido.
12. Drain com `splice` cego perde evento na corrida. Ack-based sempre; `__zvBusy` segura reinjecao com outbox pendente.
13. Dois installs do mesmo numero (principal + `_b`). Heartbeat idempotente por numero; dedup por msg_id cobre lead/venda; claim cobre auto-resposta; alertar numero aberto em dois lugares.
14. Perda de CompletePayment no corte. Manter as duas fontes disparando pixel ate a cobertura estar provada na auditoria crua; so entao virar a chave.