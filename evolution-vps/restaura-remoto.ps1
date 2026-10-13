# Sobe (ou reinstala) a Evolution API na VPS da Database Mart (69.197.134.180) a partir deste PC, sem
# abrir terminal na VPS. Precisa do Posh-SSH (Install-Module Posh-SSH -Scope CurrentUser -Force).
# Uso:  powershell -ExecutionPolicy Bypass -File restaura-remoto.ps1 -Senha '<senha do administrator>'
# A senha fica no painel da Database Mart (Server Connection Information > Login Password) e NUNCA e
# impressa. O script deixa uma chave ed25519 nossa em authorized_keys (privada em _segredos/
# vps-evolution-ed25519) pra proxima vez entrar sem senha: ssh -i <chave> administrator@69.197.134.180
param(
  [Parameter(Mandatory = $true)][string]$Senha,
  [string]$Ip = '69.197.134.180',
  [string]$Usuario = 'administrator'
)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$raiz = (Resolve-Path (Join-Path $aqui '..\..')).Path
$seg = Join-Path $raiz '_segredos'
$chave = Join-Path $seg 'vps-evolution-ed25519'
if (-not (Test-Path $chave)) { & ssh-keygen -t ed25519 -N '""' -C 'sellwave-claude' -f $chave | Out-Null }
$pub = (Get-Content "$chave.pub" -Raw).Trim()
$compose = Get-Content (Join-Path $aqui 'docker-compose.yml') -Raw
$composeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($compose.Replace("`r`n", "`n")))

$cred = New-Object System.Management.Automation.PSCredential($Usuario, (ConvertTo-SecureString $Senha -AsPlainText -Force))
$s = New-SSHSession -ComputerName $Ip -Credential $cred -AcceptKey -Force -ConnectionTimeout 25
Write-Host "sessao aberta em $Ip"

# 1) chave pra proxima vez + compose na home (sem SCP: vai em base64 dentro do comando)
$prep = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qF '$pub' ~/.ssh/authorized_keys 2>/dev/null || echo '$pub' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys && echo '$composeB64' | base64 -d > ~/docker-compose.yml && echo prep-ok && (command -v docker >/dev/null 2>&1 && echo docker-instalado || echo docker-falta) && (ls /opt/evolution/docker-compose.yml 2>/dev/null || echo compose-nao-existe) && (systemctl is-active caddy 2>/dev/null || echo caddy-parado)"
$r = Invoke-SSHCommand -SessionId $s.SessionId -Command $prep -TimeOut 60
$r.Output

# 2) o que precisa de root, num script so (a senha vai pro sudo -S pelo stdin, nunca ecoada)
$remoto = @'
set -e
IP=__IP__; DASHED=$(echo $IP | tr . -); DOMAIN=$DASHED.sslip.io
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /swapfile ]; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab && echo swap-ok; fi
if ! command -v docker >/dev/null 2>&1; then echo instalando-docker; curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! command -v caddy >/dev/null 2>&1; then
  echo instalando-caddy
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1 || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq caddy >/dev/null 2>&1
fi
printf '%s {\n    reverse_proxy localhost:8080\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl enable --now caddy >/dev/null 2>&1 || true; systemctl restart caddy
mkdir -p /opt/evolution
if [ ! -f /opt/evolution/docker-compose.yml ]; then sed "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" /home/__USUARIO__/docker-compose.yml > /opt/evolution/docker-compose.yml; echo compose-novo; else echo compose-ja-existia; fi
cd /opt/evolution && docker compose up -d 2>&1 | tail -n 6
for i in $(seq 1 18); do sleep 5; if curl -s -m 5 http://127.0.0.1:8080/ | grep -q version; then break; fi; done
echo "--- containers"; docker ps --format '{{.Names}} {{.Status}}'
echo "--- raiz local"; curl -s -m 5 http://127.0.0.1:8080/ | head -c 200; echo
echo "--- caddy"; systemctl is-active caddy; ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | head -n 3
echo "--- https publico"; curl -s -m 25 https://$DOMAIN/ | head -c 200; echo
'@
$remoto = $remoto.Replace('__IP__', $Ip).Replace('__USUARIO__', $Usuario).Replace("`r`n", "`n")
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoto))
$senhaSh = $Senha.Replace("'", "'\''")
$cmd = "echo '$b64' | base64 -d > /tmp/restaura.sh && printf '%s\n' '$senhaSh' | sudo -S -p '' bash /tmp/restaura.sh; rc=`$?; rm -f /tmp/restaura.sh; exit `$rc"
$r = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd -TimeOut 1500
$r.Output
if ($r.ExitStatus -ne 0) { Write-Host "saida de erro (codigo $($r.ExitStatus)):"; $r.Error }
Remove-SSHSession -SessionId $s.SessionId | Out-Null
Write-Host 'fim'
