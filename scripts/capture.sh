#!/usr/bin/env bash
# Raw capture of LinkedIn's data, for fixing the parser when LinkedIn changes (see docs/bridge-maintenance.md).
#   ./scripts/capture.sh on                           start capturing (all accounts; recreates the pods)
#   ./scripts/capture.sh list <accountId>             recent threads of an account, with their URNs
#   ./scripts/capture.sh extract <accountId> <urn>    one thread's raw data → captures/<accountId>-<thread>.json
#   ./scripts/capture.sh off                          stop capturing and delete all captured files
# Captures contain private messages. Turn capture off as soon as you have what you need.
set -euo pipefail
cd "$(dirname "$0")/.."

recreate_pods() {
  docker compose up -d
  docker compose exec -T api node src/dev/recreate-pods.ts
}

# SIDECAR_ENV is a comma-separated list; add or remove CAPTURE_RAW=1 and keep the rest.
set_capture() {
  local current entries
  current=$(grep -E '^SIDECAR_ENV=' .env | head -1 | cut -d= -f2- || true)
  entries=$(printf '%s' "$current" | tr ',' '\n' | grep -v '^CAPTURE_RAW=' | grep -v '^$' || true)
  [ "$1" = on ] && entries=$(printf '%s\nCAPTURE_RAW=1' "$entries" | grep -v '^$')
  local value
  value=$(printf '%s' "$entries" | paste -sd, -)
  if grep -qE '^SIDECAR_ENV=' .env; then
    sed -i "s#^SIDECAR_ENV=.*#SIDECAR_ENV=${value}#" .env
  else
    echo "SIDECAR_ENV=${value}" >> .env
  fi
}

case "${1:-}" in
  on)
    set_capture on
    recreate_pods
    echo
    echo "✅ Capture is on. Wait until the account shows Connected (about a minute), then in Live View open"
    echo "   Messaging and click the threads you need. Next: ./scripts/capture.sh list <accountId>"
    ;;
  list)
    account=${2:?usage: capture.sh list <accountId>}
    docker compose exec -T postgres psql -U linkedin_console -d linkedin_console -v account="$account" <<'SQL'
SELECT thread_urn, participants->0->>'name' AS name, folder, last_message_at
FROM conversations WHERE account_id = :'account' ORDER BY last_message_at DESC NULLS LAST LIMIT 20;
SQL
    ;;
  extract)
    account=${2:?usage: capture.sh extract <accountId> <thread_urn>}
    urn=${3:?usage: capture.sh extract <accountId> <thread_urn>}
    mkdir -p captures
    chmod 700 captures
    out="captures/${account}-$(printf '%s' "$urn" | sed -E 's/.*,(2-[^)]+)\)$/\1/' | tr -c 'A-Za-z0-9_-' '_').json"
    status=0
    docker compose exec -T -e ACCOUNT="$account" -e URN="$urn" api node - < scripts/capture-extract.cjs > "$out" || status=$?
    chmod 600 "$out"
    if [ "$status" -eq 0 ]; then echo "✅ Saved $out"; else echo "Not found yet; see the message above. ($out is incomplete)"; fi
    exit "$status"
    ;;
  off)
    set_capture off
    recreate_pods
    docker compose exec -T api rm -rf /data/files/capture
    echo
    echo "✅ Capture is off and captured files are deleted. Delete ./captures when you're done with the extracts."
    ;;
  *)
    sed -n '2,7p' "$0"
    exit 1
    ;;
esac
