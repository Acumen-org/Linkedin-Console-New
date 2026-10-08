#!/usr/bin/env bash
# First-time install on the server (inside the Proxmox VM).
#   ./scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker is missing. Run infra/proxmox/setup-vm.sh first."; exit 1; }

# An install from before the rename keeps its data under the old names: move it first.
if docker volume inspect linkunify_pgdata >/dev/null 2>&1 && ! docker volume inspect linkedin-console_pgdata >/dev/null 2>&1; then
  echo "This server has an install from before the rename (LinkUnify). Run ./scripts/migrate-from-linkunify.sh instead." >&2
  exit 1
fi

[ -f .env ] || cp .env.example .env

# Generate secrets that are still empty.
for key in POSTGRES_PASSWORD POD_AGENT_TOKEN LIVE_SECRET; do
  if grep -qE "^${key}=$" .env; then
    sed -i "s#^${key}=\$#${key}=$(openssl rand -hex 24)#" .env
  fi
done

if grep -q '^SITE_ADDRESS=app.example.com' .env; then
  read -rp "Domain for the app (e.g. inbox.yourcompany.com), or :80 for a quick LAN test: " domain
  sed -i "s#^SITE_ADDRESS=.*#SITE_ADDRESS=${domain}#" .env
  if [[ "$domain" == :* ]]; then sed -i 's#^COOKIE_SECURE=.*#COOKIE_SECURE=false#' .env; fi
fi

echo "Building images (first time takes a few minutes)…"
docker compose --profile images build
docker compose up -d

# Nightly backups (browser profiles = LinkedIn sessions). BACKUP_SCHEDULE=yes|no skips the question.
answer=${BACKUP_SCHEDULE:-}
if [ -z "$answer" ] && [ -t 0 ]; then read -rp "Schedule a nightly backup at 03:15? [Y/n] " answer; fi
case "${answer:-y}" in
  [Nn]*) echo "Skipped. Schedule later with ./scripts/schedule-backup.sh" ;;
  *) ./scripts/schedule-backup.sh ;;
esac

site=$(grep '^SITE_ADDRESS=' .env | cut -d= -f2)
echo
echo "✅ LinkedIn Console is running."
if [[ "$site" == :* ]]; then
  echo "   Open http://<this-server-ip>${site#:80} and create the owner account."
else
  echo "   Point DNS  A ${site} → your public IP, forward ports 80/443 to this VM,"
  echo "   then open https://${site} and create the owner account."
fi
