# Anexo técnico — o que foi MEDIDO em 15/10/2026

> Levantado por 4 frentes em paralelo, cada uma revisada por um agente cético que foi na fonte
> conferir. O que está aqui sobreviveu à checagem. **Não refaça esta pesquisa.** O que caiu está na
> seção A9, para ninguém ressuscitar.
>
> Companheiro de `PLANO.md`. O plano diz o que fazer; este anexo diz o que já se sabe.

## A1. Viabilidade: funciona, e foi rodado de verdade

- **Electron 44.7.2** embarca **Chromium 152.0.7977.149** e Node 24.21.0. Foi baixado nesta máquina
  e `web.whatsapp.com` carregou dentro de um `BrowserWindow`: QR renderizado (canvas 228x228,
  elemento `[data-ref]`), `wss://web.whatsapp.com/ws/chat` aberto, service worker registrado.
- **Os codecs proprietários já vêm no binário oficial** (H264/AAC/MP3 = `probably`,
  `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` = true,
  `RTCRtpSender.getCapabilities('audio')` lista opus/48000). Cuidado inverso: cada release publica
  um `ffmpeg-...-win32-x64.zip` SEM os codecs. **Nunca sobrescrever o `ffmpeg.dll`.**
- **Microfone funciona.** `getUserMedia({audio:true})` devolveu o device real. O padrão do Electron
  é LIBERAR tudo, então o risco é sobrar permissão, não faltar.
- As permissões que a página do WhatsApp realmente pede: `persistent-storage` e `media` com
  `mediaTypes: ['audio']`.

## A2. A armadilha que mata no primeiro dia: o User-Agent

Com o UA padrão do Electron, o WhatsApp devolve a tela **"O WhatsApp funciona no Google Chrome 100
ou posterior"** e o QR nunca aparece.

**Por quê:** o Electron monta o UA como `NomeDoApp/versao Chrome/v Electron/v` sempre que o nome do
app for diferente de "Electron" (`BuildApplicationUserAgent()` em
`shell/common/application_info.cc:39-54`). Ou seja, **todo app empacotado com nome próprio nasce
bloqueado.**

**A regra real, bissectada por curl:**

- Piso é **Chrome 100**. Chrome/99 bloqueia, Chrome/100 passa.
- O que dispara o bloqueio é **qualquer token estranho perto de `Chrome/`** — seja
  `SellwaveWeb/1.0.0` ou a palavra `Electron/44.7.2`.
- UA de Chrome puro passa. UA tipo Edge (`Edg/152` no fim) passa.

**Correção, uma linha, ANTES de criar qualquer janela:**

```js
app.userAgentFallback =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/' + process.versions.chrome + ' Safari/537.36'
```

Conferido: o UA limpo vale no documento, nos subrecursos e **no handshake do `wss://`**.

**Client Hints:** o Electron não manda NENHUM header `sec-ch-ua` (medido contra um servidor que
pedia `Accept-CH`). E `navigator.userAgentData.brands` continua dizendo "Chromium", sem relação com
o UA. Hoje o WhatsApp não liga para isso. **É o vetor onde a Meta apertaria primeiro**: se um dia o
bloqueio voltar mesmo com UA limpo, olhe aqui.

## A3. Proxy: o que funciona e o que não funciona

**Funciona e foi medido:** proxy **HTTP com usuário e senha**, por partição, autenticado pelo evento
`app.on('login')`. Um verificador rodou e viu passar pelo proxy a página, os assets do
`static.whatsapp.net` e **os dois websockets** (443 e 5222).

**NÃO funciona (não tente):**

| Tentativa | O que acontece |
|---|---|
| **SOCKS5 com usuário e senha** | O Chromium **não implementa autenticação SOCKS**. `ERR_NO_SUPPORTED_PROXIES` |
| Credencial dentro do `proxyRules` | `setProxy` resolve sem erro, a regra é **descartada**, `resolveProxy` devolve string vazia, tudo morre |
| `proxyBypassRules: '<-loopback>'` | **SUBTRAI** o bypass de loopback, forçando 127.0.0.1 pelo proxy. Não ganha privacidade e quebra coisa local |
| `ses.fetch()` como teste de proxy | **`app.on('login')` NÃO dispara para `net.fetch`/`ses.fetch`** (`electron_api_url_loader.cc:583-616` emite no próprio objeto). Com proxy autenticado volta `ERR_TUNNEL_CONNECTION_FAILED`. **O preflight tem que rodar num `WebContents` de verdade** |
| Switch global `--proxy-server` | Briga com o `setProxy` por partição, de forma intermitente |

**Formato certo:** regra única, sem `=`, sem `direct://`:

```js
await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://IP:PORTA' })
await ses.closeAllConnections()   // senão o socket velho continua saindo pelo IP antigo
```

Isso vira `PROXY_LIST` e vale para http, https, ws e wss. `scheme=` incompleto deixa o resto sair
direto.

**Fail-closed sai de graça:** sem `direct://` na lista, proxy fora do ar devolve
`ERR_PROXY_CONNECTION_FAILED` e o Chromium **não** sai pelo IP real.

**DNS:** com HTTP/HTTPS ou SOCKS5, a resolução do alvo é sempre do lado do proxy. Não há o que
configurar.

**PERGUNTA EM ABERTO PARA O BRUNO:** os proxies brasileiros dele são HTTP ou só SOCKS5? Se forem
SOCKS5 com senha, ou ele libera o IP da máquina na whitelist do provedor, ou precisamos de um relay
local por número.

## A4. Risco número 1: WebRTC, vazamento e a ligação

A única política que **não vaza** o IP real é `disable_non_proxied_udp`. Ela desliga UDP, STUN e
TURN-UDP, e sobra só TCP, que sai pelo proxy da partição.

```js
app.on('web-contents-created', (_e, wc) => {
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // LER DE VOLTA e abortar se não bater: valor com typo cai em 'default' em silêncio,
  // a chamada funciona lindamente e o IP real vaza.
})
```

É API de **webContents**, não de session, e tem que ser aplicada em TODO webContents, inclusive os
que o site cria. O switch `--force-webrtc-ip-handling-policy` não tem consumidor no Electron.

**O risco:** com UDP desligado, a chamada do WhatsApp só completa se a Meta oferecer **TURN em TCP
ou TLS**. Isso **não foi testado** e é o spike número 1. Precisa de um número real.

Se não funcionar, as saídas são: proxy que fale UDP de verdade, ou aceitar
`default_public_interface_only` (esconde o IP local mas **expõe o IP público real**, furando o
proxy). **Essa escolha é do Bruno, não nossa.**

## A5. Memória: o teto que decide quantos números cabem

O Chromium **nunca compartilha processo entre StoragePartitions diferentes**. Logo N números = no
mínimo N renderers, e a RAM soma linear.

- Medido: **~430 MB por número só na tela de QR**, 2 processos por número.
- WhatsApp Web logado, com conversas: 600 a 700 MB parado, 2 a 3 GB carregando histórico.
- Projeção: **4 a 6 números em 16 GB, 10 a 14 em 32 GB.**
- **Hibernação de sessão inativa é obrigatória**, não opcional.

## A6. Prior art

- **Altus** (714 estrelas, Electron 35) é o mais maduro: `webview` com `partition="persist:id"`.
  **Não tem proxy por conta** (issue #368; o mantenedor disse que não pretende implementar). Limpa o
  UA com `app.userAgentFallback.replace(/(Altus|Electron)([^\s]+\s)/g, '')`.
  **Cuidado copiado dele:** o `pruneUnusedPartitions` APAGA do disco a pasta de qualquer partição
  que não esteja mais na lista de abas. Perder ou renomear o id = sessão destruída e QR de novo.
  **Nunca fazer isso com a chave do número.**
- **Ferdium** é o único projeto aberto com proxy por conta, e é **fail-open** (sem host, sai
  direto). A trava que o Bruno quer precisa ser escrita por nós.
- **Ban por wrapper de desktop: não há evidência.** A página oficial sobre apps não oficiais fala de
  APK modificado. O risco continua sendo comportamento e reputação de rede.

## A7. Decisão de componente

`webview` tag está desaconselhada pela doc do Electron. `BrowserView` está **deprecated desde o
Electron 30**. O caminho é **`WebContentsView`** com `win.contentView.addChildView(view)` e
`view.setBounds(...)`, só depois do evento `ready`.

## A8. Onde encaixar na dash (quatro pontos, todos obrigatórios)

| # | Arquivo | O que fazer |
|---|---|---|
| 1 | `axion-produtor/src/data/languages/english.json` | Item novo no submenu de Ferramentas, **depois da linha 213** (a 214 é o `]` que fecha o array) |
| 2 | `axion-produtor/src/router/routes-path.jsx` | Import lazy no bloco 32-35 (usar o `lazy` LOCAL, com 3 tentativas) e `Route` junto das 257-259 |
| 3 | `axion-produtor/src/lib/roles.js` | Entrada em `PERM_AREAS` com `nav` igual ao id do menu e `path` igual à rota; chave em `AREA_GROUPS` (111) |
| 4 | `axion-produtor/src/lib/roles.js` | Chave em `AREAS_QUE_PEDEM_CUSTO` (266) para sumir do mundo do afiliado |

- **Trava de menu:** `scripts/check-menu.mjs` falha o deploy se o acordeão não tiver ícone nos DOIS
  iconMaps, se item interno tiver ícone, ou se houver path repetido.
- **Molde visual:** `src/pages/ferramentas/templates.jsx` (241 linhas, enxuto) e
  `src/pages/ferramentas/testador.jsx` (componente `Dobra`, bloco que nasce fechado, antídoto direto
  para o excesso de informação). **Não usar `bot.jsx` como molde**, mas copiar dele o interruptor
  `Chave` (linha 293), porque não existe `switch.jsx` em `components/ui`.
- **Worker:** endpoint novo é uma linha no if-chain do `fetch`, com prefixo **`/api/swweb/`**. Molde
  de handler: `handleBotConfig` (10019) com gate `_botPodeUsar` (8752). Config chave-valor:
  `_readConfig` (8215), `_writeConfig` (8241).
- **O chip do blob JÁ TEM campo `proxy`**, aceito pelo `handleChipSave` (6870) e exibido na
  Contingência. **Conferir se está preenchido em chip real antes de confiar nele.**
- A tela precisa desenhar no build DEMO (`VITE_DEMO=1`), porque o `smoke.mjs` abre as telas antes do
  deploy.

## A9. Hipóteses que morreram (não ressuscitar)

- "Client Hints precisam casar com o UA" — o Electron não manda nenhuma.
- "O ffmpeg do Electron não tem codec proprietário" — tem.
- "`setPermissionRequestHandler` sozinho não habilita `getUserMedia`" — habilita.
- "PAC no `setProxy` cai para DIRECT em silêncio" — o Electron cria o PAC com `pac_mandatory = true`.
- "Credencial na URL do proxy faz a sessão sair direto" — não sai direto, morre com
  `ERR_NO_SUPPORTED_PROXIES`.

## A10. O que continua EM ABERTO (spikes, em ordem de risco)

1. **A ligação de voz completa com `disable_non_proxied_udp`?** Precisa de um número real.
2. **Os proxies do Bruno são HTTP ou SOCKS5 com senha?** Trava a fase 1.
3. **Quantas sessões logadas de verdade cabem na máquina?** Só dá para medir depois de parear.
4. **O nome que aparece em "Aparelhos conectados" vem do User-Agent?** Se vier, vira correlacionador
   entre os números — foi exatamente o problema do `CONFIG_SESSION_PHONE_CLIENT` na Evolution
   (memória `antiban-whatsapp-evidencia`).

## A11. Ligação de voz com a trava de proxy (spike 1) — AINDA EM ABERTO, e por quê

**O que está medido, e é pouco:** com `disable_non_proxied_udp` e **sem proxy configurado**, a
página nem carrega (`ERR_FAILED` em `https://example.com`). Ou seja a política só é utilizável
**com** proxy de pé, o que casa com o desenho fail-closed: nada sai pelo IP real.

**O que NÃO está medido:** se a ligação de voz completa. A pergunta é se a Meta oferece caminho de
relay em **TCP ou TLS** quando o UDP não existe, e isso depende do servidor dela, não do nosso
navegador.

**Uma tentativa de medir por fora deu errado e quase virou conclusão falsa (16/10/2026).** O teste
foi montado contra o `openrelay.metered.ca`, que está **morto** (timeout em 443 e em 80). O cenário
de CONTROLE não formou candidato relay nem sem política e sem proxy — e isso quase foi lido como "a
política mata o TCP", que seria exatamente a conclusão errada com cara de medição. A sessão
paralela pegou o próprio erro antes de reportar.

**A lição, que vale além deste spike:** teste sintético precisa de um controle que você **provou**
que funciona. Controle silenciosamente quebrado não devolve "não sei", devolve a resposta errada com
a mesma cara da certa.

**E mesmo com um TURN vivo não fecharia.** Provar que o Chromium consegue relay por TCP através do
proxy não prova que a **Meta** oferece esse caminho. Só sai com uma chamada de verdade, num número
pareado, com a trava ligada. **Depende do Bruno, e não há substituto.**

## A12. A ligação de voz: medida, e a troca que o Bruno escolheu (16/10/2026)

**SPIKE 1 FECHADO.** Medido numa ligação de verdade, no número pareado dele: **6 conexões TCP,
todas pelo proxy, ZERO UDP**, e o WhatsApp dizendo *"Sua rede Wi-Fi não permite fazer ligações"*.
A chamada **toca dos dois lados** — a sinalização passa por TCP, pelo proxy — e o **áudio nunca
monta**.

**Não há como ter os dois.** O Chromium não manda UDP por proxy nenhum. SOCKS5 não resolve: a
documentação do próprio Chromium diz que ali ele só relaia TCP, e aqui ainda esbarraria em não
autenticar com senha (A3).

**Por que "funciona no AdsPower":** ele **não bloqueia UDP**. O modo Replace troca o IP que a
*página* enxerga e deixa o pacote sair direto. Tanto que o AdsPower tem um *"Disabled UDP"*
separado, que faz exatamente o que a nossa trava fazia, com o mesmo efeito de derrubar a ligação.
A escolha é a mesma nos dois produtos; o AdsPower só escolhe o outro lado sem dizer com todas as
letras.

**A decisão do Bruno, com o custo na mesa:** *"não precisa de interruptor nem nada disso, pode
deixar essa função como padrão"*. A política virou `default_public_interface_only` em todo número.

**O que muda e o que NÃO muda** (ele mesmo entendeu diferente, achou que teria que tirar o proxy):
navegação, mensagem, mídia e a **sinalização da chamada** continuam saindo pelo proxy daquela
partição, por TCP. **Só os pacotes de áudio** passam a sair direto, e é só neles que o IP público da
máquina aparece.

`default_public_interface_only` e não `default`: as duas deixam a ligação funcionar, mas a `default`
entrega junto a topologia da rede local. Perder o IP público na ligação é inevitável pra ela
existir; entregar o resto não compra nada.

**O que fica em aberto, e é honesto dizer:** ninguém sabe se o WhatsApp correlaciona o IP visto numa
chamada com a identidade da conta. Se correlacionar, dois números que fizerem ligação da mesma
máquina ficam ligados pelo IP de áudio, mesmo com proxies diferentes no resto. Isso **não foi
medido** e não dá pra medir do lado de fora.
