#!/usr/bin/env bash
# ==============================================================================
# Bharat Terminal — Oracle Cloud Always Free Automated Deployment Script
# ==============================================================================
set -euo pipefail

echo "=================================================================="
echo "  Bharat Terminal — Oracle Cloud Deployment Setup"
echo "=================================================================="

# 1. Ensure running on Debian/Ubuntu Linux
if ! command -v apt-get &> /dev/null; then
    echo "❌ Error: This script is designed for Debian/Ubuntu Linux instances."
    exit 1
fi

# 2. Update and install prerequisite packages
echo "📦 [1/6] Updating packages and installing prerequisites..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git openssl iptables-persistent netfilter-persistent

# 3. Install Docker and Docker Compose Plugin if not installed
if ! command -v docker &> /dev/null; then
    echo "🐳 [2/6] Installing Docker Engine..."
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
      https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker "$USER"
    echo "✅ Docker installed successfully."
else
    echo "✅ [2/6] Docker already installed."
fi

# 4. Configure iptables to open ports 80 & 443 on the VM
echo "🛡️  [3/6] Configuring OS firewall rules for HTTP (80) and HTTPS (443)..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# 5. Check or prompt for configuration (.env.prod)
echo "⚙️  [4/6] Setting up production environment (.env.prod)..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [ ! -f .env.prod ]; then
    echo ""
    echo "Configure your domain & email for SSL certificates (e.g., from DuckDNS):"
    read -rp "Enter your Domain (e.g., myterminal.duckdns.org): " DOMAIN
    read -rp "Enter your Email (for Let's Encrypt SSL expiry notices): " ACME_EMAIL

    if [ -z "$DOMAIN" ] || [ -z "$ACME_EMAIL" ]; then
        echo "❌ Error: DOMAIN and ACME_EMAIL are required."
        exit 1
    fi

    # Generate cryptographically secure random keys
    PG_PASS=$(openssl rand -base64 32)
    JWT_ACC=$(openssl rand -base64 32)
    JWT_REF=$(openssl rand -base64 32)
    ENC_KEY=$(openssl rand -base64 32)

    cat <<EOF > .env.prod
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_PASSWORD=$PG_PASS
JWT_ACCESS_SECRET=$JWT_ACC
JWT_REFRESH_SECRET=$JWT_REF
CREDENTIAL_ENC_KEY=$ENC_KEY
PRIMARY_PROVIDER=angelone
AI_ENABLED=false
ANTHROPIC_API_KEY=
RSS_FEEDS=https://www.business-standard.com/rss/markets-106.rss,https://www.livemint.com/rss/markets,https://www.moneycontrol.com/rss/marketreports.xml
EOF
    echo "✅ Generated .env.prod with secure secrets and your domain configuration."
else
    echo "ℹ️ Existing .env.prod detected, skipping creation."
fi

# 6. Launch stack using Docker Compose
echo "🚀 [5/6] Building and starting Docker containers..."
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo "⏳ Waiting 30s for the database and application to become healthy..."
sleep 30

# 7. Run database migrations and initial seed
echo "💾 [6/6] Applying database migrations and seed data..."
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod exec app node dist/db/migrate.js up
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod exec app node dist/db/seed.js

echo ""
echo "=================================================================="
echo "🎉 DEPLOYMENT COMPLETE!"
echo "=================================================================="
echo "Your Bharat Terminal is now running!"
echo ""
echo "🔗 Open in browser: https://$(grep '^DOMAIN=' .env.prod | cut -d '=' -f2)"
echo "🏥 Health check:    https://$(grep '^DOMAIN=' .env.prod | cut -d '=' -f2)/health"
echo ""
echo "Note: If HTTPS fails, ensure:"
echo " 1. Your domain DNS points to this VM's Public IP."
echo " 2. In Oracle Cloud Console: Ingress Rules allow TCP 80 & 443 in the Security List."
echo "=================================================================="
