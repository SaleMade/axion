#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Setup rápido da Evolution API numa VPS Ubuntu NOVA.
# Uso:  sudo bash setup.sh [IP_PUBLICO]
# (se nao passar o IP, ele tenta descobrir sozinho)
# Coloque este script na MESMA pasta do docker-compose.yml.
# ════════════════════════════════════════════════════════════════
set -e

IP="${1:-$(curl -s ifconfig.me)}"
DASHED=$(echo "$IP" | tr '.' '-')
DOMAIN="${DASHED}.sslip.io"
echo ">> IP=$IP  DOMINIO=$DOMAIN"

# 1) Swap 4GB (VPS fraca nao aguenta sem)
if [ ! -f /swapfile ]; then
  echo ">> criando swap 4GB"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# 2) Docker
if ! command -v docker >/dev/null 2>&1; then
  echo ">> instalando Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
fi

# 3) Firewall do OS (libera 80/443; persistente). Docker publica 8080 so no localhost.
echo ">> abrindo 80/443 no iptables"
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 4 -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 4 -p tcp --dport 443 -j ACCEPT
(netfilter-persistent save 2>/dev/null || (mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4)) || true

# 4) Caddy (HTTPS automatico via Let's Encrypt no dominio sslip.io)
if ! command -v caddy >/dev/null 2>&1; then
  echo ">> instalando Caddy"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq >/dev/null && apt-get install -y -qq caddy >/dev/null
fi
echo ">> configurando Caddy pra $DOMAIN"
printf '%s {\n    reverse_proxy localhost:8080\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl restart caddy

# 5) Evolution stack
echo ">> subindo Evolution + Postgres + Redis"
mkdir -p /home/ubuntu/evolution
sed "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" docker-compose.yml > /home/ubuntu/evolution/docker-compose.yml
cd /home/ubuntu/evolution && docker compose up -d

echo ""
echo "════════════════════════════════════════════════════════════"
echo " PRONTO. HTTPS: https://${DOMAIN}"
echo " FALTA (manual):"
echo "  1) Abrir portas 80 e 443 no firewall da NUVEM (Security List)"
echo "  2) Atualizar no D1 da dash: wa_url = https://${DOMAIN}"
echo "     cd AXION/backend && npx wrangler d1 execute axion --remote \\"
echo "       --command \"UPDATE app_config SET value='https://${DOMAIN}' WHERE key='wa_url'\""
echo "  3) Reconectar os numeros (QR/codigo) e re-registrar os webhooks"
echo "  Ver RESTORE.md pra o passo a passo completo."
echo "════════════════════════════════════════════════════════════"
