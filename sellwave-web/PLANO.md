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
```

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
