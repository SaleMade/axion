# Handoff — Automações de WhatsApp + Bot de IA (GlicoVax)

Documento pra continuar a evolução da **área de Automações** noutra conversa. Resume tudo que já existe, onde está, e o que falta. (Estado em 29/06/2026.)

## Objetivo do bot
Bot de IA que atende leads no WhatsApp da operação GlicoVax (COD, controle de açúcar / saúde do homem). NÃO substitui vendedor: ele **acolhe na hora, pré-qualifica e passa pro humano fechar (ligação)**. Foco nº 1: ser **rede de segurança dos leads abandonados** (que chamam num número rotacionado e ninguém responde).

## Infra (no ar)
- **Evolution API** v2.3.7 na VPS Oracle `136.248.93.228`, atrás do **Caddy (HTTPS)** em `https://136-248-93-228.sslip.io` (cert Let's Encrypt). Só portas 80/443 públicas; 8080 só localhost. Stack docker em `/home/ubuntu/evolution`. Detalhes: memória [[evolution-api-vps]].
- **Worker** `axion-api` (`AXION/backend/worker.js`) = ponte segura Dash→Worker→Evolution + cérebro do bot. Deploy: `cd backend && npx wrangler deploy`.
- **Gemini** (key no D1 `ai_gemini_key`) pro cérebro e transcrição. Modelo que funciona: `gemini-2.5-flash` (1.5 dá 404, 2.0-flash dá quota 0).
- Chave SSH VPS: `~/Downloads/ssh-key-2026-06-26.key`. Credenciais Evolution: `Sale Made Inc/evolution-vps/credenciais.txt`.

## Números conectados (instâncias Evolution)
- `salemade` — número PESSOAL do Bruno. **É onde o bot de teste roda** (whitelist).
- `atendimento1` — número de atendimento. CAIU (desconectou); 93k msgs já sincronizadas e guardadas. Reconectar quando for produção.
- `vendas1`, `vendas2` — números de venda, conectados só pra ANÁLISE das conversas que converteram.
- Webhook inbound registrado em cada uma (auto no create, ou `/webhook/set/<inst>`).

## Backend — worker.js
Endpoints (auth via Bearer, exceto webhooks):
- Config: `GET/POST /api/config/wa` (url/key/instance).
- Envio/status: `GET /api/wa/status`, `POST /api/wa/send {number,text,instance?}`.
- Multi-instância: `GET /api/wa/instances`, `POST /api/wa/instance/create`, `GET /api/wa/instance/connect?instance=`, `GET /api/wa/instance/status?instance=`, `POST /api/wa/instance/logout`.
- Conexões: `GET /api/wa/conn`. Webhook: `POST /webhook/evolution/<token>`.
- Bot teste (gera resposta SEM enviar): `POST /api/wa/bot/preview {message, history?}` → {reply, handoff}.

Config no D1 (`app_config`): `wa_url`, `wa_key`, `wa_instance`, `wa_webhook_token`, `wa_bot_test_instance=salemade`, `wa_bot_test_phone=554774009891`, `wa_bot_prompt` (override do prompt; se vazio usa BOT_PROMPT_DEFAULT).

Tabelas D1 do bot: `wa_buf` (buffer de mensagens recebidas pro agrupamento + histórico), `wa_conn` (estado de conexão), `wa_attrib` (telefone→instância = atribuição de vendedor), `wa_replied`, `wa_bot_done` (idempotência).

### Como o bot inbound funciona (`_waBotTestReply` em worker.js)
1. Webhook recebe msg → `_waOnInbound` → se for o chat whitelistado (`wa_bot_test_*`), chama `_waBotTestReply` (ignora grupos `@g.us`).
2. Grava a msg no `wa_buf` na hora (fonte confiável; o findMessages da Evolution atrasa).
3. **Debounce 7s** + reivindica todas as pendentes do telefone (agrupa mensagens picadas; idempotência evita resposta dupla).
4. Transcreve áudios do lote (`_waTranscribeAudio` via Gemini).
5. Monta histórico do `wa_buf` (inclui respostas do bot = não re-cumprimenta).
6. Chama Gemini com `BOT_PROMPT_DEFAULT`.
7. Quebra a resposta em várias mensagens (por "---" ou parágrafo) e envia com **delay proporcional** (mostra "digitando..."). Guarda as respostas no buffer.
8. Handoff via tag interna `[HANDOFF]` (removida antes de enviar).

### Cérebro
`BOT_PROMPT_DEFAULT` no worker.js: persona equipe GlicoVax, fala humana/curta, fluxo (saudação→dor→validação→oferta→qualifica→handoff), **12 objeções** com respostas, sempre termina com pergunta. Qualificado = aceita pagar na entrega + aceita o valor. Preço oficial: **R$ 697** (8 meses / COD). Conhecimento bruto: `AXION/backend/bot-knowledge.md`.

## Frontend — index.html / axion_v2.html (manter os 2 em sync; deploy via git push → Cloudflare Pages)
- Aba **Automações** (acordeon próprio na sidebar): `renderAutomacoes`. Regras em `DB.wa_automacoes` (campos: gatilho, alvo, inst, msg, ativo). Chave-mestra `DB.wa_autom_on`. Gatilhos: `primeiro_contato`, `novo_lead`, `col:<Coluna>`. Alvo: todos / role / pessoa.
- Config da Evolution: Configurações → Integrações, card "WhatsApp (Evolution API)".

## Estado atual
Bot roda AO VIVO só no número de teste (whitelist salemade + 554774009891). NÃO toca leads reais. Qualidade já boa: humano, agrupa mensagens, entende áudio, lembra contexto, contorna objeções, faz handoff. Bruno aprovou.

## Pendências / roadmap (continuar aqui)
1. **Áudios de objeção (voz do Bruno):** ele vai curar e salvar em `Sale Made Inc/audios-bot/` (ex: caro.ogg, vou-pensar.ogg). Implementar: mapa objeção→áudio (D1), prompt emite `[AUDIO:chave]`, envio via `/message/sendWhatsAppAudio`. A voz do bot é sempre a dele (não misturar vendedores).
2. **Produção / rede de segurança (nº1):** tirar do modo teste; regra = bot só responde lead SEM resposta humana há X horas (números rotacionados/abandonados); recua na hora que um humano responde. Rollout num número só primeiro.
3. **Anti-ban:** só inbound, throttle, delay/digitando (já tem), sem link, número aquecido. Revisar antes de escalar. Ver [[automacao-whatsapp-ban-risk]].
4. **Enriquecer o cérebro** com as transcrições das conversas que converteram: `Sale Made Inc/evolution-vps/vencedoras-transcritas.txt` e `conversas-que-converteram.txt` (só texto/argumentos; a voz vem dos áudios curados do Bruno). RAG pesado (Vectorize) foi AVALIADO e descartado por ora: o texto do WhatsApp é fino (a venda é na ligação), ROI baixo.
5. **Limpar logs de debug** (`console.log('BOTTEST...')` em `_waBotTestReply`) antes de produção.
6. **Reconectar atendimento1** (QR/código) quando for pra produção.
7. **Melhorias da UI de Automações** (o que o Bruno quer evoluir): integrar config do bot (editor do prompt, ligar/desligar bot por número, whitelist de teste), inbox/visão das conversas, status de conexão dos números (`/api/wa/conn`), gestão dos áudios de objeção, e a regra da rede de segurança visível/configurável.

## Domínios das pressels (30/06)
3 domínios da Hostinger, na Cloudflare (conta brunomc1416), anexados ao Worker como custom domain (em `wrangler.toml`): `area-acesso.com`, `area-glico.fun`, `painel-glico.fun`. A MESMA pressel funciona em `https://<dominio>/p/<id>` nos três — ideia é usar um domínio por conta do TikTok (não ligar as contas). Pegadinha que rolou: cada domínio tinha um registro A na raiz (parking Hostinger) que dava erro 100117; tem que apagar o A antes de anexar. O token OAuth do wrangler NÃO edita DNS (só Workers), então a exclusão do A é manual no painel Cloudflare. Possível melhoria: seletor de domínio no editor de pressel (hoje `presselPublicUrl` usa a URL do Worker; o usuário monta a URL do domínio na mão).

## Coordenação (IMPORTANTE)
Duas conversas em paralelo mexendo nos MESMOS arquivos. Combinado: a mecânica do inbound/Automações é tocada por uma; o cérebro+análise por outra. **Trabalhar uma de cada vez** pra não dar conflito. Sempre reler o arquivo antes de editar. Detalhes em [[robo-ia-atendimento]].
