#!/usr/bin/env bash
# One-shot server setup for AdviSha on an Oracle Cloud Always Free VM
# (Ubuntu 22.04 / 24.04, Ampere ARM). Run it ON THE VM after SSH-ing in:
#
#   curl -fsSL https://raw.githubusercontent.com/jeevamani502-hue/portfolio-management/main/scripts/oracle-bootstrap.sh \
#     | bash -s -- yourname.duckdns.org you@example.com
#
# It opens ports 80/443 in the VM firewall, installs Docker, clones the
# repo, generates the secrets once, builds and starts the stack, applies the
# database schema and prints the URL. Re-running is safe: it pulls the latest
# code and keeps the existing secrets.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "usage: oracle-bootstrap.sh <domain-pointing-at-this-vm> <email-for-letsencrypt>" >&2
  exit 1
fi

REPO="https://github.com/jeevamani502-hue/portfolio-management.git"
APP_DIR="$HOME/portfolio-management"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "1/6  Opening ports 80 and 443 in the VM firewall"
for port in 80 443; do
  sudo iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save >/dev/null 2>&1 || true
echo "Remember: the Oracle security list (VCN → subnet → Security List) must also allow TCP 80 and 443 from 0.0.0.0/0."

say "2/6  Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
else
  echo "Docker already installed: $(docker --version)"
fi
# Group membership only applies to new logins, so use sudo for this run.
DOCKER="sudo docker"

say "3/6  Fetching the code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

say "4/6  Secrets"
if [ ! -f .env.prod ]; then
  cat > .env.prod <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
JWT_ACCESS_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
CREDENTIAL_ENC_KEY=$(openssl rand -base64 32)
PRIMARY_PROVIDER=angelone
AI_ENABLED=false
ANTHROPIC_API_KEY=
RSS_FEEDS=https://www.business-standard.com/rss/markets-106.rss,https://www.livemint.com/rss/markets,https://www.moneycontrol.com/rss/marketreports.xml
EOF
  chmod 600 .env.prod
  echo "Generated .env.prod. BACK UP CREDENTIAL_ENC_KEY from it: without it the saved broker login cannot be read."
else
  echo ".env.prod already exists; keeping it."
  sed -i "s#^DOMAIN=.*#DOMAIN=$DOMAIN#; s#^ACME_EMAIL=.*#ACME_EMAIL=$EMAIL#" .env.prod
fi

say "5/6  Building and starting (first build takes several minutes on ARM)"
$DOCKER compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo "Waiting for the API to report healthy…"
for i in $(seq 1 60); do
  status=$($DOCKER inspect --format '{{.State.Health.Status}}' bharat-app-1 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 5
done
echo "API container: $status"

say "6/6  Database schema"
$DOCKER compose -f docker-compose.prod.yml --env-file .env.prod exec -T app node dist/db/migrate.js up
$DOCKER compose -f docker-compose.prod.yml --env-file .env.prod exec -T app node dist/db/seed.js || true

echo
echo "Done. Open  https://$DOMAIN  (the certificate can take a minute on first visit)."
echo "Then: create your account, and enter the Angel One credentials under Settings → Market data providers."
echo
echo "Logs:    cd $APP_DIR && sudo $COMPOSE logs -f app"
echo "Update:  cd $APP_DIR && bash scripts/oracle-bootstrap.sh $DOMAIN $EMAIL"
