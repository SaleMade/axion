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

### Fase 2 — Painel — **FEITA em 16/10/2026**
- [x] Painel em **janela própria**, ao lado (não injetado na página: aí o layout do WhatsApp teria que ser empurrado por CSS, que depende do DOM deles, e o CSS deles poderia quebrar o nosso)
- [x] Agente injetado na página só com o que precisa estar lá: motor, conversa aberta, envio e captura
- [x] Dados do lead vindos da dash, com escopo por cargo e **sem CPF**
- [x] Respostas rápidas, funis e áudios, agrupados, com busca
- [x] Simulação de digitando e gravando antes de mandar
- [x] Alvo travado no clique (trocar de conversa no meio não desvia o funil)
- [x] Botão Parar no meio do funil

### Fase 3 — Captura de volta — **FEITA em 16/10/2026**
- [x] Mensagens recebidas E enviadas voltam para o worker
- [x] **Idempotência** por id de mensagem, no agente e na ingestão
- [x] Rota própria `POST /api/swweb/captura`, autenticada: o token de ingestão **não desce mais pro app**
- [x] Fila em disco: fechar o app não perde o que ainda não subiu
- [x] Contador de pendência na barra lateral

### Fase 4 — Tela na dash — **FEITA em 15/10/2026**
- [x] Ferramentas > Sellwave Web
- [x] Download do instalador (do R2, pelo worker)
- [x] Lista de números com dono e status colorido pela cor do cadastro
- [x] Cadastro de proxy por número, com colar de uma linha só
- [x] Interruptores das duas travas

### Fase 5 — Acabamento — **FEITA em 16/10/2026**
- [x] Log local em `%APPDATA%/sellwave-web.log`, com botão Abrir registro
- [x] Hibernação por teto de sessões abertas (memória), configurável
- [x] Segredos cifrados no disco com o DPAPI do Windows
- [ ] Atualização automática: por ora o instalador novo é baixado pela dash

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

## 9b. Os 8 furos que a revisão adversarial achou (16/10/2026)

Um agente revisou o código inteiro procurando bug de verdade. Achou 20, 8 graves. **Todos os graves
foram consertados**, e cada conserto está comentado no código com o motivo. Ficam aqui para ninguém
reintroduzir:

| # | O furo | O conserto |
|---|---|---|
| 1 | A ponte do preload repassava **qualquer** canal IPC pra página do WhatsApp. Um script lá dentro desligava a trava de proxy, trocava o proxy e lia as senhas | Lista fechada de canais (só `swp:captura`) e `ev.source !== window` |
| 2 | O vendedor abria o número com o proxy da direção, passava no preflight e **depois trocava por um proxy dele** | O app não cadastra mais proxy, só lê e testa. Teste roda em partição descartável |
| 3 | A mídia era baixada com `fetch` **dentro da página**, e a CSP do WhatsApp bloqueia nossos domínios | Quem baixa é o processo principal, que manda o dataUri pronto |
| 4 | A view do preflight não tinha referência: o coletor de lixo destruía no meio do teste | Guardada num Set, e `close()` em vez de `destroy()` |
| 5 | Dois cliques no mesmo número criavam **duas sessões na mesma partição** | Trava `abrindo` |
| 6 | `GET /api/swweb/lead` não tinha escopo por cargo: dava pra varrer telefone e ler pedido de outro, **com CPF** | Escopo por cargo e o CPF saiu da resposta |
| 7 | `GET /api/swweb/roteiro` entregava o **token de ingestão** pra qualquer login. Com ele dava pra inventar venda (comissão e pixel) | O token não sai mais. Captura por rota autenticada, com o servidor carimbando de quem é |
| 8 | Com um número aberto, a janelinha de proxy e de ajustes abria **atrás** das views | Esconde as views enquanto a janelinha está na tela |

Consertados também: exigir IP do Brasil falhava **aberta** quando não sabia o país; erro de rede
mandava o vendedor pra tela de login; `did-fail-load` de um subframe arrancava da tela o número em
uso; token e senha de proxy ficavam em texto puro no `%APPDATA%` (agora DPAPI); `sandbox: false` na
view que roda a página da Meta; a chave de 10 dígitos era formatada como telefone e sumia com o nono
dígito; permissão de mídia liberava **câmera** junto com microfone; faltava o par `will-navigate` do
`setWindowOpenHandler`; e a fila de captura só existia em memória.

## 9c. A terceira varredura (16/10/2026) e o que ela ensinou

A segunda rodada de consertos **criou** um problema novo (o sinal de vida dizia que o numero estava
pareado na tela do QR). Por isso houve uma terceira: 26 achados, **16 confirmados** por revisor
cetico, todos consertados. A licao que fica: consertar sem varrer de novo e apostar.

Os cinco que doiam no bolso:

| O furo | Por que doia | O conserto |
|---|---|---|
| A fila de captura contava **eventos**, nao bytes, e gravava o audio em base64 no arquivo, de forma **sincrona**, a cada 10 s | Com a dash fora do ar, isso congela o processo principal (painel, funil e botao Parar juntos) e no extremo estoura o limite de string do V8 dentro de um `catch` mudo: a fila que existe pra sobreviver ao fechamento deixa de existir | Teto em **bytes**; larga o **anexo** do mais antigo antes de largar a **mensagem**; o arquivo nunca guarda os bytes |
| O download de midia nao olhava a idade | Reconexao reemite a conversa (855 mensagens em 11 min, ja medido): cada audio saia pelo **proxy pago**, cobrado por GB, pra virar bolha que o vendedor ja tem do lado | Corta em **6 horas** (nao 30 min: notebook fechado por uma hora ainda precisa trazer o audio do endereco) |
| A mensagem so era mandada **depois** do download | Ate 20 s em que o evento nao existia em lugar nenhum duravel. Recarregar a pagina ali perdia o audio do endereco **e o lead junto** | Mensagem **na hora**, anexo numa segunda passada (a ingestao tem `INSERT OR IGNORE` e `UPDATE media_url`) |
| `velha` saia do **relogio do PC do vendedor** | Windows 40 min adiantado marcava TODA mensagem como velha, e velha no servidor significa `wa_attrib` nao gravado e **nenhuma venda registrada**, em silencio | O carimbo continua na captura (a fila pode esperar a noite inteira), com o relogio corrigido pelo cabecalho `Date` de qualquer resposta da dash |
| A **pausa do passo somava** `delay` + `sim` | Era a reclamacao do Bruno de 18/08/2026 voltando por outro caminho. Pior: funil com `sim` preenchido e `delay` zerado saia **todo no mesmo segundo**, varias mensagens num chip novo | Uma pausa so (`sim` se preenchido, senao `delay`), em fatias de 200 ms pro Parar responder, com "digitando..." ligado |

Consertados tambem: prazo em todo `fetch` (240 s no POST da captura, que sobe ate 6 MB); sinal de
vida em paralelo; motor ausente agora **aparece** na barra (ele faz o numero sair da roleta em
silencio); erro de numero escondido nao arranca da tela o numero em uso; `mostra()` nao elege numero
fechado e a casca ouve `sw:fechado`; a hibernacao nao fecha quem esta disparando; "nao falei com a
dash" deixou de virar "sem pedido na dash" e "proxy nao cadastrado"; grupo aberto **diz grupo**; o
rodape carimba de quem e o funil; LID nao resolvido nao procura lead com digitos que nao sao
telefone; cache de midia com teto em bytes.

**Teste novo:** `npm run teste` (`src/teste-funcoes.mjs`), 22 conferencias em Node puro das contas
que decidem dinheiro e ban. Ele **le o codigo de verdade e executa a funcao de verdade**, entao nao
ha copia pra envelhecer. Rode antes de publicar, junto com o autoteste.

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
- **16/10/2026** — **PROJETO INTEIRO NO AR (fases 2 a 5).** Painel de venda em janela própria, com
  respostas rápidas, funis e áudios do Sale Chat; captura voltando pela rota autenticada; log,
  hibernação por memória e segredos cifrados. **O proxy do Bruno foi testado de verdade e funciona
  como HTTP**: `isp.decodo.com:10001`, saiu por 104.165.109.158, São Paulo, Brasil. Autoteste em
  **21 conferências, 21 passando**, incluindo abrir o WhatsApp Web, carregar o motor, instalar o
  agente e confirmar que proxy morto **não** vira conexão direta. Revisão adversárial achou 20
  problemas e os 8 graves foram consertados (seção 9b).
- **16/10/2026, madrugada** — **TERCEIRA VARREDURA FECHADA E TUDO NO AR.** Os 16 achados
  confirmados estao consertados (secao 9c), com destaque pra pausa do passo, que estava somando, e
  pro `velha` que saia do relogio do PC do vendedor. O painel ficou **igual ao inbox de verdade**:
  comparei com o `SalePanel` do `chat.jsx` e corrigi tres divergencias (o selo da aba Funis contava
  o catalogo, Favoritos era aba em vez do filtro de estrela, e a previa mostrava `*assim*` cru).
  A lista ganhou o **x pra fechar** o numero, que o Bruno pediu e so existia no painel e no Ctrl+W.
  A pasta de dados foi **fixada** em `%APPDATA%/sellwave-web` e a sessao passa a ser gravada no disco
  ao fechar, ao hibernar e ao sair: renomear o produto ou fechar a forca nao apaga mais pareamento.
  **Conferido no ar:** instalador 200 com 111.343.297 bytes, motor 200 com 503.710 bytes,
  `/api/swweb/numeros` 401 sem token; worker `axion-api` versao 1b9fca4a; dash em produção e demo do
  commit `52f9e7f`, carimbo `16/10 02:50` lido de sellwave.com.br com query. Autoteste **21 de 21**
  com o WhatsApp Web de verdade e `npm run teste` **22 de 22**. Modo foto agora retrata as duas caras
  (direcao e vendedor), os dois Ajustes e a previa do funil.
  **Falta o Bruno:** parear um numero e testar a ligacao de voz com a trava ligada (spike 1), e dizer
  em qual maquina o app vai rodar (decisao da secao 7).

- **16/10/2026, manha** — **ATUALIZAR SEM REINSTALAR (primeira entrega) E O INCIDENTE DO PROXY.**
  O **agente** (o pedaço que fala com a página do WhatsApp por dentro, e o que quebra quando a Meta
  muda) passou a vir do servidor por `GET /api/swweb/agente.js`, com a cópia do instalador como
  piso e **quatro portas** antes de entrar: tamanho, assinatura, sintaxe por `vm.Script` sem
  executar, e — depois de injetar — as três funções de pé; falhando, a cópia servida é reprovada e
  o piso entra **na mesma sessão**, sem reiniciar. Conserto de agente chega **recarregando o
  número**. O que **nunca** vem do servidor: `main.js` e os três preloads, que são a fronteira de
  confiança. Pro resto, **aviso de versão** (`GET /api/swweb/versao` público, `POST /api/swweb/app`
  só da direção) e um cartão na barra que abre o instalador.
  **INCIDENTE, e o conserto vale mais que a entrega:** o Bruno passou a manhã sem conseguir
  cadastrar proxy nenhum. Duas causas somadas, as duas minhas. (1) `api()` da dash manda o `body`
  direto pro `fetch`, e `fetch` **não serializa objeto**: as duas chamadas da tela (proxy e travas)
  mandavam objeto cru, viravam a letra `[object Object]`, o worker estourava no `req.json()` e
  respondia "Body inválido". O cadastro **nunca funcionou pela dash**, desde que a tela nasceu — por
  isso `swweb_proxies` não existia no `app_config`. Achado pela conversa paralela lendo o bundle no
  ar. (2) A varredura tinha tirado o formulário de proxy do **app** por causa do vendedor, e eu
  tirei de todo mundo: o diretor ficava sem caminho justamente na hora em que descobre que falta
  proxy. Hoje o `api()` serializa objeto simples sozinho (Blob, FormData e string passam intactos) e
  o formulário voltou no app **só pra direção** — quem segura o vendedor é o 403 do servidor, não
  esconder campo. A senha não desce mais pro app: campo vazio ao salvar **mantém** a atual.
  **ISOLAMENTO CASA x AFILIADO:** a lista de chips mostrava a vendedora do afiliado pro Bruno. Rota
  nova nasceu sem corte por mundo, exatamente o que a memória avisa. Medido antes de mexer: **não
  havia lead indo pro lugar errado** (ela só está nas pressels do afiliado). Agora a porta abre pros
  dois e **quem corta é o mundo**; trava e proxy viraram chaves por mundo, pelo padrão do
  `dc_api_key`. Conferido ao vivo com sessão de teste de 10 minutos, só GET, apagada no fim.
  **No ar:** app **1.1.1** (111.348.654 bytes), worker, dash e demo do commit `a88ca3c`, carimbo
  `16/10 11:23` lido com query. `npm run teste` em **40 conferências**, autoteste em **21 de 21**.
  **Falta o Bruno:** cadastrar o proxy, parear (de preferência três números, pra fechar a medição de
  memória junto) e testar a ligação de voz com a trava ligada.

- **16/10/2026, noite — a fila aceita VÁRIOS, e o alvo passou a ser lido no clique (1.12.0).**
  Ele testou a 1.11.0 e o áudio saiu: *"finalmente funcionou perfeitamente"*. Mas a fila só servia
  pra metade do que ele queria: *"quando eu disparei um aqui pra um lead, você bloqueou os funis pra
  mim disparar pra outro, então eu não consegui disparar pra outros leads e deixar na fila do
  empilhamento"*. **Medido: o botão nunca esteve desabilitado** — o clique enfileirava. O que
  bloqueou foi o DESENHO: enquanto aquele funil estivesse na fila, o play virava rodinha, e ninguém
  clica num botão que parece ocupado. No inbox o item do menu de funil **nunca gira nem desabilita**
  (`chat.jsx`, `dispararFunil`); quem mostra o que está saindo é a `PilhaEnvios`, e o clique
  responde com um toast dizendo a posição. Agora é igual: play sempre, e o rodapé diz *"Na fila ·
  3º da pilha"*, com as palavras do `avisoDisparo` de lá.
  **E o teste achou um bug de verdade, que ninguém tinha visto:** o alvo congelado vinha do último
  pulso, que só relê a conversa a cada 1,5s. Clicando 150ms depois de trocar de lead — que é
  exatamente como ele trabalha, clica no lead e dispara —, **o funil inteiro saía pro lead
  anterior**, com o nome do novo na pilha mentindo que era o certo. Agora o alvo é perguntado ao
  processo principal na hora do clique. No inbox isso não existe porque o alvo vem da LINHA clicada
  (`c.phone`), nunca de um "lead ativo" guardado.
  A ordem dos cliques é garantida por senha tirada ANTES da espera (dois cliques rápidos podiam
  voltar trocados e a fila sairia na ordem das respostas). Ele foi explícito: *"se eu disparar pro
  lead 1, pro lead 2, pro lead 3, a sequência vai ser lead 1, lead 2, lead 3"*.
  **No ar:** app **1.12.0** (111.385.662 bytes, conferido no ar por content-length). Três suítes:
  **50** contas em Node, **64** de painel e casca (3 novas: botão não gira, alvo é o do clique,
  três leads na ordem), **21 de 21** do autoteste, e o pacote **9 de 9** byte a byte.

- **16/10/2026, noite — o nome do lead, o botão de trocar de cliente, e dois bugs que ninguém via
  (1.13.0).** Ele pediu duas coisas pequenas e a investigação achou dois defeitos sérios no caminho.
  **O NOME.** Com o contato não salvo, o WhatsApp mostra o número no título e o push name logo
  abaixo (*"~Amor"*); o campo NOME do cadastro nascia com o NÚMERO. A causa raiz não era ordem de
  preferência: **`WPP.contact.get` é ASSÍNCRONO** (prova no próprio motor, `sc-wajs.js` módulo
  296910: `t.get=async function`). Ele devolve uma Promise, e Promise é truthy, então o bloco
  inteiro lia nove propriedades `undefined` sem quebrar e sem avisar. Com ele morto, quem respondia
  era `chat.get` — e ali o `formattedTitle` vinha primeiro, que para contato fora da agenda **é o
  telefone formatado**. A forma certa já rodava há meses no `sc-panel.js` (`activeInfo`, linha 436),
  e agora o agente faz igual. O filtro recusa também **presença** (*online*, *digitando...*, *visto
  por último às 14:02* — que moram na MESMA linha do push name) e tira emoji, porque esse valor vai
  pro `customer[name]` da PayLog quando ele aceita, ou seja pra etiqueta e pra cobrança.
  **A TROCA DE CONVERSA.** O aviso virou faixa âmbar com **saída**: botão *"Trocar para \<nome\>"*
  que guarda o pedido anterior como rascunho, lê o lead NA HORA do clique e começa limpo. Endereço,
  CPF, tratamento e comprovante não vão junto: são daquela pessoa. E cadastrar com a conversa
  trocada passou a pedir confirmação.
  **OS DOIS BUGS, medidos na produção.** (1) `cadastraPedido` **não zerava `pedLead`**: o
  `preenchePed` seguinte reenchia `wa` e `nome` com o cliente que ACABOU de ser cadastrado e, como
  ele só escreve em campo vazio, o próximo pedido nascia com o telefone e o nome do anterior — **sem
  aviso nenhum**, porque o `pedLead` já era o novo e não havia o que comparar. Era o caminho
  silencioso pro medo que ele descreveu. (2) **Rascunho novo nunca gravou um dia**: o painel mandava
  `id: 0` e o worker recusava com *"Falta o id do rascunho"*; conferido na API, 400 na resposta e a
  tabela **vazia**. O painel engolia porque só olhava exceção. Agora o id nasce no servidor, só com
  dígito (pra caber em inteiro seguro: versão antiga do app faz `Number(id)`), o painel guarda como
  texto e a recusa aparece na tela. **O que escondia isso era o duble de teste**, que respondia
  `{ok:true}` pra qualquer chamada — ele passou a responder como o worker.
  **No ar:** app **1.13.0** (111.391.915 bytes conferidos no ar) e `axion-api`. Três suítes: **50**
  contas em Node (13 novas rodam a função de verdade com um WPP de mentira, inclusive o
  `contact.get` devolvendo Promise), **80** de painel e casca, **21 de 21** do autoteste, pacote
  **9 de 9**.
  **E a LIGAÇÃO DE VOZ foi confirmada por ele:** *"acabei de testar a ligação e funcionou
  perfeitamente"*. Spike 1 fechado dos dois lados. Ver ANEXO A12.

- **31/10/2026, noite — A VERSÃO DE COBRADOR (1.26.0).** Pedido do Bruno: "uma versão do SellWave Web
  para cobradores", com conexão e contingência dos números, os funis e respostas do Sale Chat de
  cobrança, "literalmente o nosso Kanban" e uma agenda de quem cobrar. **É o mesmo app**: o modo sai
  do CARGO que o `/api/swweb/numeros` manda (`cargo`), então o "ver como" da direção vira cobrador
  junto e o cobrador recebe toda atualização com o vendedor. No modo cobrança: a faixa de baixo vira
  **Cobrança** (ui/cobranca.js) com as abas Agenda (Atrasados, Hoje, Próximos por dia, Sem retorno,
  Chegando) e Pedidos (o Kanban da dash, arrastar com as regras de lá: Pagos pede o valor, de Pagos só
  pra perda); a **ficha do pedido** (ui/cob-comum.js) aparece no quadro e no painel ao lado da conversa
  (aba Pedidos vira Cobrança), com retorno, marcar pago, etapa, comentário e os links de pagamento e
  rastreio (no painel o "Enviar" manda o link NA CONVERSA pela fila dos funis); "Abrir conversa" escolhe
  o número (o último usado com o cliente, o da tela, qualquer conectado que não seja Restrito, ou a
  lista dele pra escolher); lembrete do Windows na hora do retorno; nada de interruptor, limite ou
  placar. Servidor: rotas `/api/swweb/cobranca` (quadro) e `/cobranca/pedido` (ficha), roteiro de
  cobrança pro cobrador, e **número de cobrador nunca é número de venda** (roleta, captura e
  atribuição, ver `_cobIds` no worker). Gravar vai pelas rotas da dash (`/api/lead/:id`).
  Testes: painel 355/355, `npm run teste` (+22), smoke WA 23/23, worker `teste-cobranca-rota` 44/44.
  Fotos: `src/foto-cobranca.js`.

- **03/11/2026 — AJUSTES DA VERSÃO DE COBRADOR (1.26.1).** Quatro pedidos do Bruno depois de usar.
  (1) **O quadro piscava**: abria, fechava, a área ficava vazia e ele voltava em 2 a 3 s. O vigia de
  1 s do `cobranca.js` reaplicava o `estado.crm` inteiro, que é uma FOTO da última leitura: logo
  depois do clique ela dizia "fechado". O mesmo vigia reabria o quadro por cima da conversa recém
  aberta. Agora o aberto/fechado só vem do `sw:area` do main ou do clique, e a foto serve uma vez, só
  pra geometria (o mesmo que o `crm.js` já fazia). (2) **"Abrir conversa" usa o número da tela
  primeiro** (o que ele escolheu na lista), depois o último que falou com o cliente, depois qualquer
  conectado. (3) **Agenda na ordem da fila**: Atrasados, Sem retorno, Hoje, Chegando, Próximos (a
  faixa de baixo também). (4) **Ficha**: Entrega, Retorno e Pagamento em caixas com a cor de cada um.
  Testes: painel 360/360 (o do quadro que pisca falha com o código antigo), `npm run teste`.

- **09/11/2026 — MENSAGENS AUTOMÁTICAS DA COBRANÇA (1.26.14).** Pedido do Bruno: o cliente que chama o
  cobrador recebe a recepção "mesmo que o cobrador não esteja online", e quem já chamou recebe o código de
  rastreio quando o pedido sai. **O servidor decide, o app manda:** `_cobAutoItens` no worker (quem, o quê,
  os textos já preenchidos com nome, valor e código) e o laço `autoCobranca` no main, que só roda com número
  de COBRANÇA aberto, alugado por esta máquina e de pé há 2 min. Cada item: espera o painel terminar um funil
  naquele número, CONFERE A CONVERSA NA PÁGINA (`__swChatDe` no agente: o cobrador pode ter respondido pelo
  celular), PEGA no servidor (`/api/swweb/auto/pega`, a trava contra mandar duas vezes), manda texto por texto
  com "digitando" (`auto: true` + `espera` valem até na primeira, ver `respiroDoItem`) e conta como foi
  (`/auto/feito`); a barra avisa o cobrador. **O `swp:manda` virou `mandaItem`, com a VEZ DO NÚMERO**
  (`naVezDoNumero`): painel e automática nunca digitam em duas conversas do mesmo número ao mesmo tempo. A
  automática tem marca própria (`autoNoAr`) que a hibernação e o "recarregar todos" respeitam; ela NÃO entra
  no `disparos` do painel (lá cada número tem um dono). Liga e desliga na dash, Cobrança > Cobradores
  (`/api/cob/auto`, `app_config cob_auto`, desligado sem config). Sem o computador do cobrador ligado com o
  app aberto, nada sai: a recepção sai quando ele abrir (janela de 72 h). Testes: `src/teste-auto-cobranca.mjs`
  (61), `backend/teste-cob-auto.mjs` (54).
- **12/11/2026 — A AUTOMÁTICA SÓ SAI COM O COBRADOR LIVRE (1.26.18).** Pedido do Bruno: disparar "quando o
  meu cobrador não estiver em ligação, quando ele não estiver respondendo a ninguém, quando estiver tudo
  tranquilo". Quem sabe disso é a página de cada número: `window.__swOcupado` no agente (microfone aberto,
  ligação tocando ou recém terminada, tecla/clique/rolagem de verdade, mensagem que ele mandou daqui ou do
  celular, item do painel, áudio tocando), com 90 s de calma (`CALMA_MS`). **Dois níveis:** o `__swChatDe`
  recusa sozinho quando o ocupado é aquele número (vale pra qualquer app desde a 1.26.14, chega pelo agente
  do R2), e o `cobradorOcupado` do main pergunta a TODOS os números abertos antes de cada rodada e de cada
  cliente, porque ocupado é a pessoa (ligação num número segura a automática do outro). Ligação feita pelo
  celular só é vista quando acaba. Não tem válvula de tempo: quem não para 90 s não libera. Testes:
  `src/teste-ocupado.js` (32, o agente numa página de verdade) e `src/teste-auto-cobranca.mjs` (106).
- **13/11/2026 — EDITAR AS MENSAGENS NA ABA AUTOMAÇÕES, E A ABA CABE NO PAINEL (1.26.19).** Pedido do Bruno:
  "eu quero que tanto eu quanto os meus cobradores tenham autonomia para poder editar essas mensagens" e
  "as mensagens não cabem naquela área lateral direita, eu sempre tenho que usar a barrinha lá embaixo".
  **A rolagem pro lado** era a grade da aba (`.au`) sem `minmax(0, 1fr)`: a linha dos "Últimos envios" com
  nome de cliente comprido (uma linha só) alargava a coluna inteira, e tudo passava da borda (medido com os
  envios de verdade: 480px num painel de 310). O teste antigo só tinha "Maria das Dores" e nunca viu; agora
  tem nome comprido e mede cartão por cartão. **Editar:** cada texto aberto ganhou o lápis; o balão vira a
  caixa com o texto como é gravado (palavras entre chaves) e os botões do que dá pra colocar. O cobrador
  salva a versão DELE (`cob_auto_pessoa[uid].txt`, só vale no que sai pelos números dele; selo "Seu texto",
  "Voltar ao padrão"). A direção só vê a aba no "ver como" de um cobrador, e ali escolhe "Salvar pra todos"
  (troca o texto da casa e apaga a versão própria de todo mundo naquela mensagem) ou "Só para Fulano". Quem
  confere o texto é o servidor (`_cobAutoConfere`: palavra entre chaves que a mensagem não sabe preencher
  sairia crua pro cliente) e a frase dele aparece embaixo da caixa. Quem está escrevendo não é
  interrompido pelo redesenho de fundo (`auto.redesenha`). `{saudacao}` e `{primeiro}` passaram a valer em
  todas as mensagens. A dash (Cobrança > Cobradores > Textos) mostra quem tem texto próprio e devolve ao
  da casa. Servidor antigo (sem `edita`) ou app antigo: a aba fica como era. Testes: `teste-painel` (os de
  "editar", "direcao" e largura) e `backend/teste-cob-auto3.mjs` (51).
- **13/11/2026 — A DIREÇÃO CHEGA NAS AUTOMAÇÕES SEM "VER COMO" E SEM ABRIR NÚMERO (1.26.20).** O Bruno, horas
  depois da 1.26.19: "para mim, como diretor, está quase impossível (...) tenho que ver como um dos meus
  cobradores, trocar para a visualização, clicar em um dos números. Aí sim eu vou ter ali a área de
  automações (...) eu gostaria que essa área lateral ficasse disponível mesmo sem nenhum número
  selecionado". Três peças:
  **(1) O painel sem número aberto, só pra direção.** `temPainel()` = número na tela OU
  `painelSemNumero()` (`direcaoReal` + `painelSolto` + token). `direcaoReal` é quem ENTROU no app (o
  `config.direcao` vem falso no "ver como"). `painelSolto` é a casca dizendo que a tela dela convive com
  o painel: `window.sw.esconder({ painel: true })` na tela vazia, no cartão de abrir, na contagem e no
  erro; modal, trava e a tela de entrar chamam sem o `painel` e ele sai da frente (o painel é uma view POR
  CIMA da casca: taparia 316 px do modal); `fechaModal` chama `soltaPainel`. A casca recua a tela do meio
  (`body.painel-solto main`, avisada pelo `sw:area` com `solto`). O painel recebe `semNumero` e
  `direcao` em todo estado: mostra "Nenhum número aberto", pontinho cinza, sem fechar nem recarregar.
  Vendedor e cobrador não mudam: sem número aberto, sem painel.
  **(2) A aba Automações pra direção, fora da versão de cobrador** (`souDir`): é a aba da CASA. O
  servidor, pra direção sem `como` e sem `de`, devolve `casa: true`: o interruptor é o da operação
  (`cob_auto`, o mesmo da dash), o texto é o da casa, "hoje" e os últimos envios somam todos os números
  de cobrador (com quem mandou), `desligou` e `outros` dizem quem está diferente. Editar ali é "Salvar
  pra todos".
  **(3) O seletor na própria aba** (`auto.quem`, `escolheAutoQuem`): Todos ou um cobrador, sem passar
  pelos Ajustes. O main traduz em `autoAlvo(quem)`: 'casa' = sem alvo; id = `&como=` na leitura e `de`
  na gravação; sem escolha vale o "ver como" de um cobrador. Só a direção escolhe.
  Os "Últimos envios" viraram duas linhas (cliente em cima, mensagem e quem mandou embaixo): numa só,
  nome comprido escondia qual mensagem foi. Testes: autoteste com 6 conferências novas da geometria de
  verdade (vendedor, direção, modal abre e fecha, sem conta, o painel lendo o estado), `teste-painel`
  (459: "direcao:", "sem numero"), `teste-auto-cobranca` (129) e `backend/teste-cob-auto3.mjs` (66).
- **14/11/2026 — A ABA COBRANÇA MOSTRA OS CLIENTES DOS DOIS NÚMEROS, E O CLIENTE PASSA DE NÚMERO (1.26.21).**
  O Bryan (dois números) dizia que, no número novo, a aba Cobrança ficava vazia: as conversas dali eram de
  gente sem pedido (o número era de venda até 12/11) e os clientes dele conversavam no outro. Pedido do Bruno:
  "que aparecessem ali os leads, mesmo que sejam de outro número, porém com um pouco mais apagado (...) e uma
  opção bem discreta para ele trocar o lead de um número para outro, porém com aviso de que o lead já chamou
  no outro número; caso nunca tenha chamado, ele só troca normalmente".
  **A lista** (painel-ui.js, "A LISTA DE CLIENTES DA ABA COBRANCA"): conversa sem pedido (ou nenhuma conversa)
  mostra a AGENDA do cobrador (`C.agenda`, a mesma ordem e o mesmo "só os meus" do quadro); com pedido, a ficha
  vem primeiro e "Este cliente / Todos os clientes" troca. O servidor manda em cada pedido `numCli` (de qual
  número é o cliente: a escolha à mão, onde ele escreveu por último, a marca do link) e `falou` (em quais
  números dele o cliente já escreveu), mais `nums`. Com mais de um número, quem é do OUTRO vem apagado com o
  final do número, depois dos deste, em cada grupo. As setas (`cl-passa`) aparecem em quem é do outro e em
  quem ainda não chamou; quem já escreveu noutro ganha a pergunta embaixo dele (Passar / Cancelar). Clicar no
  nome abre a conversa no número do cliente (`swp:cob-abre` = o mesmo `cobConversa` do ícone do quadro;
  número fechado: a casca abre ele pelo evento `sw:abre-numero`).
  **Passar** = `POST /api/swweb/cobranca/numero` → `cob_num_cli` com origem `manual`, que vale acima de tudo:
  o link de acompanhar abre esse número, o ícone do quadro também (o `/cobranca/contato` põe ele na frente)
  e as automáticas passam pra ele SÓ depois de existir conversa ali (automática nunca é a primeira mensagem
  de um número que o cliente não conhece; a pergunta diz isso).
  Na mesma rodada, sem build: o "não pagou" só sai pra quem está esquecido (sem comprovante anexado, sem
  foto/documento do cliente desde que saiu, ninguém da equipe falou nem anotou depois da entrega, sem
  retorno pra hoje ou depois), "saiu", retirada e boas-vindas perdem a linha do valor com sinal de
  pagamento, e a pega confere de novo. Motivo medido: a página do WhatsApp só tinha a última mensagem
  carregada e o "o cobrador já falou" passava batido. Testes: `teste-painel` (477, "lista:"),
  `backend/teste-cob-pagou-numero.mjs` (50, 15 mutações pegas).

## 10b. O PADRÃO A SEGUIR É O INBOX (regra do Bruno, 16/10/2026)

Palavras dele: *"tudo que se diz a respeito do envio de mensagens automáticas, dos itens, dos funis,
eu quero que você se inspire no que está funcionando hoje, que é o inbox de WhatsApp. Tudo lá está
100%. Caso queira fazer alguma melhoria, dá uma olhadinha lá, porque **lá é o padrão que a gente
quer seguir**"*.

Isso não é só fonte de consulta quando algo quebra: é o **desenho de referência**. Vale pro
comportamento (fila, pausa, indicador, o que a tela mostra enquanto sai) e pra aparência (a pilha
de envios, os rótulos, as cores de estado). Quando a pergunta for *"como isso deveria funcionar
aqui?"*, a resposta começa no inbox, não numa ideia nova.

**Onde olhar, por assunto:**

| Pergunta | Onde a resposta já existe |
|---|---|
| Como ENVIAR (pausa, indicador, Parar) | `AXION/sc-panel.js` — o encadeamento por volta da linha 1770 |
| Como mostrar itens e funis | `axion-produtor/src/pages/apps/chat.jsx`, o `SalePanel` |
| Como mostrar o que está saindo | o mesmo arquivo, `PilhaEnvios` no modo integrado |
| O que o botão faz quando já tem funil na fila | `chat.jsx`, `dispararFunil` + `avisoDisparo`: não gira, não desabilita, avisa a posição |
| Formatação do balão, favoritos, chips | `SalePanel` + `_formatado` |

**A FILA É PEDIDO EXPLÍCITO DELE.** Disparar o funil pro lead A, trocar pro B, disparar de novo, e
os dois saem **um após o outro**, cada um respeitando o próprio tempo. Nunca em paralelo — ele foi
direto: um por vez *"não atrapalha, é inclusive o certo"*. Isso encerra a ideia de tornar o disparo
reentrante: o que falta é uma **fila com um consumidor só**, não concorrência.

**O custo de ignorar isso já foi medido:** uma tarde inteira reescrevendo o envio de funil, com dois
diagnósticos errados implementados, enquanto a versão que funciona estava no mesmo repositório.
Ver a memória `sc-panel-e-a-versao-que-funciona`.

## 11. COMO PUBLICAR O APP (decorar: o passo 3 nasceu de um app que não abria)

```
cd AXION/sellwave-web
npm run teste                                    # 40 conferências das contas que decidem dinheiro
env -u ELECTRON_RUN_AS_NODE npx electron src/teste-painel.js    # 27 do painel
env -u ELECTRON_RUN_AS_NODE SW_SMOKE=1 SW_SMOKE_WA=1 npx electron .   # 21, com o WhatsApp de verdade
env -u ELECTRON_RUN_AS_NODE npx electron-builder --win --x64 --config.directories.output=dist-pub
npm run confere-pacote                           # 3) A GUARDA. Sem ela, não suba.
npx wrangler r2 object put "salechat-media/sellwave-web/instalador.exe" --file "dist-pub/SellWave Web Setup <v>.exe" --content-type "application/octet-stream" --remote
# e carimbar a versão publicada: POST /api/swweb/app { versao, bytes, notas } como diretor

# 3b) A ATUALIZACAO SOZINHA (desde a 1.25.17, 23/10/2026): o app instalado le o feed e se atualiza
#     sozinho quando o vendedor fecha. SEM ESTE PASSO A VERSAO NAO CHEGA EM NINGUEM que ja esta na
#     1.25.17 ou mais nova. Os tres arquivos que o build deixa na pasta de saida, com o nome EXATO do
#     latest.yml (tem espaco). Suba o .exe e o .blockmap ANTES e o latest.yml POR ULTIMO: o latest.yml
#     e o que anuncia a versao, e anunciar antes de o arquivo existir da erro na maquina de todo mundo.
npx wrangler r2 object put "salechat-media/sellwave-web/atualizacao/SellWave Web Setup <v>.exe" --file "dist-pub/SellWave Web Setup <v>.exe" --content-type application/octet-stream --remote
npx wrangler r2 object put "salechat-media/sellwave-web/atualizacao/SellWave Web Setup <v>.exe.blockmap" --file "dist-pub/SellWave Web Setup <v>.exe.blockmap" --content-type application/octet-stream --remote
npx wrangler r2 object put "salechat-media/sellwave-web/atualizacao/latest.yml" --file "dist-pub/latest.yml" --content-type text/yaml --remote
# confira: curl ".../api/swweb/atualizacao/latest.yml?v=$RANDOM" mostra a versao nova, e o sha512 do
# .exe servido bate com o do latest.yml. Cada versao publicada tem numero NOVO (nunca republicar por
# baixo): quem ja instalou aquele numero nao seria avisado de novo.
# Com mais de uma conversa mexendo no app, builde em pasta propria (dist-pub-<n>) e confira o NOME do
# .exe gerado antes de subir: o build le o package.json da arvore NA HORA.

# 3c) O MAC (desde a 1.26.4, 04/11/2026: o cobrador usa MacBook). O pacote de Mac SO SAI NUM MAC,
#     entao ele e montado no runner macOS do GitHub (.github/workflows/sellwave-web-mac.yml), que
#     tambem roda o autoteste no app empacotado. Commite e de push ANTES: o runner builda o main.
#     Um comando dispara, espera, confere que o build e do mesmo app do git local, sobe o .dmg pro
#     R2, confere o sha256 do servido e carimba o feed de Mac (swweb_app_mac):
python publica-mac.py --notas "o que mudou, pro cobrador ler"
#     O Mac NAO se atualiza sozinho (assinatura ad-hoc, sem conta de desenvolvedor da Apple): quem
#     tem Mac recebe o aviso de versao nova e baixa de novo. Publicar o Windows sem o Mac deixa o
#     Mac na versao anterior, sem quebrar nada; publicar os dois do mesmo commit e o certo.

# 4) SE MEXEU NO src/ui/agente.js, PUBLIQUE A CÓPIA SERVIDA TAMBÉM:
npx wrangler r2 object put "salechat-media/sellwave-web/agente.js" --file "src/ui/agente.js" --content-type "application/javascript; charset=utf-8" --remote
# confira com query e compare o tamanho com o do disco:
#   curl -s ".../api/swweb/agente.js?v=$RANDOM" -H "Authorization: Bearer <tok>" | wc -c
```

**POR QUE O PASSO 4 EXISTE (incidente 16/10/2026, noite).** O `agente.js` é publicado em **DOIS
lugares**: dentro do instalador e no R2, de onde o worker serve `/api/swweb/agente.js`. E o app
**prefere a cópia baixada** — o arquivo do instalador é só o piso de segurança. Então publicar só o
instalador **não entrega** mudança nenhuma do agente: o app baixa a versão velha do R2 e usa ela.

Aconteceu com o conserto do nome do lead. O `nomeDaConversa` foi reescrito, empacotado na 1.13.0 e
conferido byte a byte no asar — e o Bruno continuou vendo o telefone no campo Nome, porque o R2
ainda servia o agente de antes (25.706 bytes contra 29.363 do disco). Três versões saíram no meio
disso sem que a correção chegasse nele.

**Como perceber:** baixe `/api/swweb/agente.js` e compare o tamanho com `src/ui/agente.js`. Se
diferirem, o que está rodando na máquina dele não é o que está no git.

**POR QUE O PASSO 3 EXISTE (incidente 16/10/2026).** A 1.3.1 foi publicada com o `app.asar`
**corrompido**: os NOVE arquivos com o tamanho certo e o conteúdo de OUTRO arquivo — o
`preload-wa.js` com o conteúdo do `preload-painel.js`, o `preload-painel.js` com o do `main.js`, o
`index.html` começando em binário. O Bruno abriu e levou `SyntaxError: Invalid or unexpected token`
em `app.asar/src/main.js`. O mesmo commit reempacotado saiu perfeito, então foi **aquela rodada de
build**, não o código.

`node --check` no FONTE não prova nada sobre o que foi EMPACOTADO: entre os dois existe um
empacotador, e é ele que pode gravar offset errado ou pegar arquivo no meio de uma escrita. A guarda
(`src/confere-pacote.cjs`) abre o `.asar` direto, sem Electron e sem biblioteca, compara cada
arquivo **byte a byte** com o disco e roda `vm.Script` em cada `.js`. São 3 segundos.

Duas regras que saíram junto:

- **Build de publicação sai em `dist-pub`**, separado do `dist`. Duas conversas rodando
  `electron-builder` no mesmo diretório ao mesmo tempo é, por si só, jeito de corromper pacote.
- **Conferir o artefato que está NO AR, não o que está no disco.** Dá pra baixar o instalador
  publicado, extrair com `7z e <exe> -o<pasta> "$PLUGINSDIR/app-64.7z"` e de novo
  `7z e app-64.7z -o<pasta> "resources/app.asar"`, e rodar a guarda nele. Foi assim que a 1.3.2 foi
  confirmada: mesmo md5 do que eu havia conferido antes de subir.

**ARMADILHA DO AMBIENTE:** estas sessões têm `ELECTRON_RUN_AS_NODE=1` setada. Com ela, o Electron
vira Node e **sai com código 0 sem log nenhum** — parece "não abriu" e não é. Todo comando de
Electron aqui vai com `env -u ELECTRON_RUN_AS_NODE`.
