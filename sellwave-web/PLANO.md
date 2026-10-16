# Sellwave Web — plano e fonte de verdade do projeto

> **Se você é uma conversa do Claude pegando este projeto pela primeira vez: leia este arquivo
> inteiro antes de escrever qualquer linha.** Ele existe porque o Bruno pediu explicitamente uma
> base sólida que sobreviva à perda de contexto. Atualize-o a cada fase concluída. Plano que
> mente é pior que plano nenhum.

Criado em 15/10/2026. Dono: Bruno (SellWave). Codinome do app: **Sellwave Web**.

> **Leia junto: [`ANEXO-TECNICO.md`](ANEXO-TECNICO.md).** Ele tem o que já foi MEDIDO (o bloqueio de
> User-Agent que mata o app no primeiro dia, o que funciona e o que não funciona em proxy, o
> vazamento de WebRTC, o teto de memória por número) e a lista de hipóteses que já morreram. Não
> refaça aquela pesquisa.

---

## 1. O que é

Um **aplicativo de desktop Windows, em Electron**, que funciona como um AdsPower especializado em
WhatsApp Web.

Cada número de WhatsApp da operação roda numa **sessão completamente isolada** — cookies, storage,
cache, proxy e identificação próprios. Barra lateral para trocar de número. O vendedor conecta por
QR uma vez e a sessão **persiste entre aberturas**, voltando exatamente onde parou, inclusive se
outra pessoa abrir depois (é esse comportamento do AdsPower que o Bruno usa hoje e quer manter).

---

## 2. Por que existe (e o que ele NÃO resolve)

**Não é para reduzir banimento.** Isso foi medido em 15/10/2026 e está em
`~/.claude/.../memory/queda-numeros-dapi-uazapi-medido.md`:

- Era Uazapi (13 a 22/09): mediana de **1 dia** até a restrição.
- Era Datacrazy / API oficial (22/09 em diante): mediana de **1 dia**.

O canal não muda a queda. **O que muda é a rampa**: por faixa de enviadas/recebida no primeiro dia
do número, até 1,3 vive 27 dias de mediana; acima de 1,5 vive 1 dia. A rampa é um projeto separado
e vale mais que este aqui para durabilidade.

**O que este projeto resolve de fato, nesta ordem:**

1. **Acaba o teto de 10 números do Datacrazy**, que é o que trava a escala do Bruno hoje.
2. Corta a mensalidade do Datacrazy e os ~R$ 444/mês da Meta (mensagem de serviço, ver memória
   `cobranca-meta-servico-outubro`).
3. Dá ao vendedor a bancada que ele já tem hoje no AdsPower, só que dentro da nossa operação e com
   os funis e os dados do lead ao lado.

**Por que é viável sem virar um projeto de anos:** o valor difícil do AdsPower é *antidetect*
(forjar canvas, WebGL, áudio, fontes contra antifraude de banco e e-commerce). **O WhatsApp Web não
faz nada disso** — ele identifica a sessão pela credencial do dispositivo vinculado, que mora no
celular. Os três recursos que o Bruno realmente usa (sessão isolada por perfil, proxy por perfil,
tudo salvo ao fechar) são nativos do Chromium/Electron.

---

## 3. Requisitos duros (palavras do Bruno, não negociáveis)

| # | Requisito | Observação |
|---|---|---|
| R1 | **Toda** sessão sai por um proxy **brasileiro** dele | Ele já tem os proxies |
| R2 | **Trava fail-closed**: sem proxy, a sessão não abre | Com interruptor para ligar/desligar |
| R3 | Zero vazamento de IP real | WebRTC, DNS e mídia. Vazou, o proxy não serve pra nada |
| R4 | Vendedor **liga** pelo WhatsApp Web (voz nativa) | Microfone tem que funcionar dentro do app |
| R5 | Vendedor manda **áudio** | Mesma dependência de microfone |
| R6 | Dispara os **funis** que ele usa hoje no inbox | Reaproveitar o que o Sale Chat já faz |
| R7 | Sessão persiste e volta onde parou, para qualquer pessoa que abrir | Comportamento do AdsPower |
| R8 | Tela de controle dentro da dash, em **Ferramentas** | Design enxuto; ele reclama de excesso de informação |

**Decisão do Bruno sobre o inbox (16/10):** quando os vendedores passarem a usar o Sellwave Web,
eles **deixam de usar o inbox** e trabalham só no navegador. O inbox continua útil como visão
agregada de todos os números, mas isso é problema para depois. Isso **rebaixa a urgência da fase 3
(captura de volta)**, mas não a elimina: sem captura, a dash fica cega para atribuição e pixel.

---

## 4. Arquitetura

```
┌─────────────────────────────── Sellwave Web (Electron, Windows) ──┐
│  Login com o token da dash  →  GET /api/swweb/numeros             │
│                                                                   │
│  ┌── barra lateral ──┐   ┌──────── WebContentsView por número ──┐ │
│  │ (15) 97407-6200 ● │   │ partition: persist:sw-<numkey>       │ │
│  │ (19) 99598-3293 ● │   │ proxy:     session.setProxy(...)     │ │
│  │ (47) 99740-5847 ○ │   │ url:       https://web.whatsapp.com  │ │
│  │ ...               │   │ painel injetado: lead, funis, respostas│
│  └───────────────────┘   └──────────────────────────────────────┘ │
│  Trava: testa o proxy ANTES de carregar. Falhou, não carrega.     │
└───────────────────────────────────────────────────────────────────┘
                     │ (fase 3)
                     ▼
         worker axion-api  →  D1 (wa_messages, wa_lead, ...)
                     ▲
         dash Ferramentas > Sellwave Web (instalador, números, proxies, trava)
```

**Uma partição por número.** A chave é `persist:sw-<num_key>`, onde `num_key` é DDD + 8 últimos
dígitos (a mesma convenção do `_waNumKey` no worker — ver seção 9). Partição `persist:` grava em
disco e é exatamente o que dá o comportamento R7.

---

## 5. Fases

Marque `[x]` ao concluir e anote a data e o que foi verificado.

### Fase 1 — Base (substitui o AdsPower sozinha) — **FEITA em 15/10/2026**
- [x] Projeto Electron criado (44.7.2, fixado), instalador Windows gerado (111 MB)
- [x] Login com o token da dash
- [x] `GET /api/swweb/numeros` no worker, com escopo por cargo — conferido no ar: 91 números
- [x] Barra lateral com os números, dono, status do chip e indicador de proxy
- [x] Uma partição `persist:sw-<numkey>` por número
- [x] Proxy por partição, HTTP com usuário e senha pelo evento `app.on('login')`
- [x] **Trava fail-closed**: testa o proxy num WebContents real ANTES de carregar o WhatsApp
- [x] Interruptores das travas (exigir proxy, exigir IP do Brasil), lidos da dash
- [x] Bloqueio de vazamento: WebRTC em `disable_non_proxied_udp` em TODO webContents; sessão padrão
      num buraco negro pra qualquer esquecimento falhar em vez de vazar
- [x] WhatsApp Web carrega e **o QR aparece** (canvas 228x228, medido no autoteste)
- [x] Microfone liberado, só pra origem do WhatsApp e só nas permissões que ele pede
- [x] Autoteste `SW_SMOKE=1` com 15 conferências, todas passando
- [ ] Falta só o que depende do Bruno: **parear um número de verdade** e **cadastrar um proxy dele**

**Como rodar o autoteste** (antes de entregar qualquer versão):
```
cd AXION/sellwave-web
SW_SMOKE=1 npx electron .              # 11 conferências locais
SW_SMOKE=1 SW_SMOKE_WA=1 npx electron . # + abre o WhatsApp Web de verdade e procura o QR
```
Aviso de ambiente: se `ELECTRON_RUN_AS_NODE=1` estiver setado no shell, o Electron roda como Node e
nada funciona. Use `env -u ELECTRON_RUN_AS_NODE`.

### Fase 2 — Painel
- [ ] Painel injetado dentro de cada sessão
- [ ] Dados do lead vindos da dash (nome, pedido, histórico)
- [ ] Respostas rápidas
- [ ] Botões de funil (reaproveitar `Sale Chat Atendimento/panel-inject.js`)

### Fase 3 — Captura de volta
- [ ] Mensagens recebidas e enviadas voltam para o worker
- [ ] **Idempotência**: nada entra duas vezes (já houve incidente de 357 duplicadas em setembro,
      memória `inbox-datacrazy-poll-vs-sync`)
- [ ] Carimbo da instância correto (ver memória `canal-real-whatsapp-instance-mente`)

### Fase 4 — Tela na dash
- [ ] Ferramentas > Sellwave Web
- [ ] Download do instalador
- [ ] Lista de números, quem está usando, conectado ou não
- [ ] Cadastro de proxy por número
- [ ] Interruptor da trava

### Fase 5 — Acabamento
- [ ] Atualização automática do app
- [ ] Reconexão e recuperação de sessão
- [ ] Log local para diagnóstico

---

## 6. Decisões já tomadas (não reabrir sem motivo novo)

| Decisão | Por quê |
|---|---|
| Electron, não WebView2 | Precisa de várias sessões isoladas no mesmo app, com proxy por sessão. O Sale Chat de hoje se pendura no app do WhatsApp da Microsoft Store e só aguenta uma conta por instalação |
| `WebContentsView`, não `webview` tag | A tag `webview` está depreciada pelo Electron |
| Partição `persist:` por número | Dá isolamento e persistência nativos, sem código nosso |
| Não replicar antidetect | O WhatsApp Web não faz fingerprinting; seria gastar meses no que não é usado |
| Sem automação de aquecimento por mensagem agendada | Mensagem automática em horário fixo é assinatura de automação. O aquecimento certo é a rampa com lead real |
| Nome: **Sellwave Web** | Escolha do Bruno em 16/10 |

---

## 7. Decisão ainda em aberto

**Onde o app roda.** A fase 1 é idêntica nos três casos, então dá para decidir depois de ver
funcionando:

- **A) Máquina de cada vendedor.** Mais simples, impressão de máquina diferente por vendedor (bom
  para isolamento). Custo: a dash só captura o que chega enquanto o app está aberto.
- **B) Máquina central sempre ligada, vendedor acessa de longe.** É o que o Bruno faz hoje com o
  AdsPower. Captura nunca falha. Custo: precisa da máquina ligada e do acesso remoto.
- **C) Híbrido.** Número fica também na coexistência para a API capturar; o navegador é só a
  bancada. Seguro, mas não economiza.

Recomendação registrada: começar no A, migrar para B se o buraco de captura incomodar.

---

## 8. Riscos conhecidos (dizer a verdade sobre eles, sempre)

1. **A injeção quebra quando o WhatsApp Web atualiza.** Já aconteceu com o Sale Chat. Não tem como
   eliminar, só conter. O Bruno aceitou esse custo explicitamente.
2. **Captura mal feita envenena dados em silêncio.** Duplicar ou perder mensagem corrompe inbox,
   atribuição e pixel sem erro visível. Por isso a fase 3 vem depois e com trava de idempotência.
3. **Memória.** Cada sessão de WhatsApp Web aberta custa centenas de MB. O notebook do Bruno tem
   32 GB; a máquina do vendedor provavelmente não. Limitar quantas abrem ao mesmo tempo.
4. **Proxy ruim é pior que proxy nenhum.** IP de fora do Brasil num número +55 piora. A trava tem
   que validar que o proxy responde E que o IP é brasileiro.
5. **Transição.** Não tirar número da API antes do navegador estar capturando certo, senão perde
   rastreio e pixel no meio do caminho.

---

## 9. Onde está cada coisa (para a próxima conversa)

| O quê | Onde |
|---|---|
| Este plano | `AXION/sellwave-web/PLANO.md` |
| Código do app | `AXION/sellwave-web/` |
| Dash | `axion-produtor/` (React 19 + Vite + Tailwind + shadcn) |
| Worker | `AXION/backend/worker.js` |
| Mapa do código | `_coordenacao/MAPA.md` (gerado por `python _coordenacao/mapa.py`) |
| Histórico desta área | `python _coordenacao/log.py area "Sellwave Web"` |
| Injeção que já existe | `Sale Chat Atendimento/inject.js` e `panel-inject.js` |
| Convenção de chave de número | `_waNumKey` no `worker.js` — DDD + 8 últimos dígitos |

**Memórias que precisam ser lidas antes de mexer:**
`queda-numeros-dapi-uazapi-medido` (por que este projeto não é sobre banimento),
`cobranca-meta-servico-outubro` (a conta que ele economiza),
`coexistencia-whatsapp-fluxo-correto` (nunca register/deregister),
`canal-real-whatsapp-instance-mente` (como carimbar a instância),
`antiban-whatsapp-evidencia` (o que realmente causa ban),
`estilo-visual-salechat` e `textos-da-dash-regra` (como a tela tem que parecer).

---

## 10. Diário do projeto

Toda conversa que mexer aqui escreve uma linha. Data, o que fez, o que **verificou**.

- **15/10/2026** — Projeto aprovado pelo Bruno. Pasta criada, plano escrito, descoberta técnica
  rodada por 4 frentes em paralelo com verificação adversária (resultado em `ANEXO-TECNICO.md`).
- **15/10/2026, noite** — **FASE 1 NO AR.** App Electron funcionando, autoteste 15/15 incluindo o QR
  do WhatsApp Web desenhado dentro dele. Worker `axion-api` com a rota `/api/swweb/` (versão
  18ca75cc, commit 3cc544a). Dash com a tela Ferramentas > Sellwave Web (commit 03694d2, produção e
  demo no mesmo commit, conferidas com query). Instalador no R2, baixando pela rota pública
  `/api/swweb/instalador` (111 MB, 200). Projeto movido pra dentro do repositório `AXION` pra ter
  versionamento. **Conferido no ar:** instalador 200, `/api/swweb/numeros` 401 sem token e 91
  números com token, trava de deploy saída 0, smoke das 25 telas.
  **Falta o Bruno:** dizer se os proxies dele são HTTP ou SOCKS (ver A3/A10), parear um número e
  testar a ligação de voz com a trava ligada (spike número 1).
