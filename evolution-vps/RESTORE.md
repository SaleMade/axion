# RESTORE — Reinstalar a Evolution API numa VPS nova (rápido)

Quando a VPS cair/for trocada, siga isto. Tudo aqui é versionado no GitHub, então
nunca se perde. O que NÃO sobrevive é a sessão dos WhatsApps (precisa reconectar os
números) — o resto sobe automático.

## Credenciais (já embutidas no docker-compose.yml)
- Evolution API key: `Pbnqw5fpCVNF9DWj8tY3IReLo6UOxy1GzJBrch7Q`
- Postgres password: `xmh9VB2jXuEw74gkTlOWrvUf`
- Webhook token (inbound do bot): `evo_hook_8f3c1a9d27b64e05`
- Manter a MESMA API key facilita: aí o `wa_key` no D1 da dash não muda. Só o `wa_url` (domínio) muda.

## Passo a passo

### 1. Provisionar a VPS
Ubuntu 22.04/24.04. **Recomendado 2GB+ de RAM** (a de 1GB vive travando). Pega o IP público.

### 2. Rodar o setup automático
Copia esta pasta `evolution-vps/` pra VPS (ou `git clone` o repo) e roda:
```bash
sudo bash setup.sh <IP_PUBLICO>
```
Isso faz: swap 4GB, Docker, firewall do OS (80/443), Caddy com HTTPS automático no
domínio `<ip-com-tracos>.sslip.io`, e sobe Evolution + Postgres + Redis. Os containers
têm `restart: always`, então voltam sozinhos em qualquer reboot.

### 3. Abrir 80 e 443 no firewall da NUVEM
No painel do provedor (Security List / firewall), liberar entrada TCP **80** e **443**
de `0.0.0.0/0`. (O setup.sh já abre no OS, mas a nuvem tem firewall próprio.)

### 4. Apontar a dash pro novo servidor
O domínio novo é `https://<ip-com-tracos>.sslip.io`. Atualiza no D1:
```bash
cd AXION/backend
npx wrangler d1 execute axion --remote --command "UPDATE app_config SET value='https://NOVO-DOMINIO.sslip.io' WHERE key='wa_url'"
```
(a `wa_key` continua a mesma se manteve a API key.)

### 5. Reconectar os números + registrar webhook
Pra cada número (ex: salemade, atendimento1, vendas1...), criar a instância (registra o
webhook automático) e gerar o QR/código. Exemplo direto na Evolution (do seu PC, via o
domínio HTTPS), trocando BASE pelo novo domínio:
```powershell
$base="https://NOVO-DOMINIO.sslip.io"; $h=@{apikey="Pbnqw5fpCVNF9DWj8tY3IReLo6UOxy1GzJBrch7Q"}
# cria + QR
Invoke-RestMethod "$base/instance/create" -Method Post -Headers $h -ContentType application/json -Body '{"instanceName":"salemade","integration":"WHATSAPP-BAILEYS","qrcode":true}'
$c = Invoke-RestMethod "$base/instance/connect/salemade" -Headers $h
# $c.base64 = imagem do QR (salva e escaneia). Se o QR travar, usar codigo:
# Invoke-RestMethod "$base/instance/connect/salemade?number=55XXXXXXXXXXX" -Headers $h  -> .pairingCode
# registrar webhook inbound:
$hook="https://axion-api.axion-dash.workers.dev/webhook/evolution/evo_hook_8f3c1a9d27b64e05"
$body=@{webhook=@{enabled=$true;url=$hook;events=@('MESSAGES_UPSERT','CONNECTION_UPDATE')}} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/webhook/set/salemade" -Method Post -Headers $h -ContentType application/json -Body $body
```
Dica do QR: escanear o PRIMEIRO QR rápido. Se der "tente mais tarde", esperar ~10 min
(o WhatsApp limita após várias tentativas) ou usar o código de pareamento.

### 6. Conferir
```powershell
Invoke-RestMethod "$base/instance/connectionState/salemade" -Headers $h   # state = open
```
E testar o bot pelo número de teste (whitelist em wa_bot_test_phone no D1).

## Pegadinhas que já nos pegaram (não repetir)
- **Cloudflare Worker não chama IP cru** (erro 1003): por isso usamos domínio `sslip.io`, nunca o IP direto no `wa_url`.
- **Docker fura o iptables**: por isso o compose publica `127.0.0.1:8080:8080` (só localhost) e o Caddy faz o público. Não expor 8080.
- **VPS de 1GB trava (OOM)** com vários números + histórico grande. Manter só os números necessários conectados; pegar VPS com mais RAM.
- O domínio sslip.io muda com o IP, então `wa_url` e o Caddyfile mudam a cada VPS nova (o setup.sh já cuida do Caddyfile).
