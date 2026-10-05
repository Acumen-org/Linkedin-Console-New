#!/usr/bin/env bash
# Update to the latest code: rebuild images, restart services, recreate account pods.
# LinkedIn sessions are kept (they live in each account's profile volume).
#   ./scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d .git ]; then git pull --ff-only; fi
docker compose --profile images build
docker compose up -d
echo "Recreating account pods with the new images…"
docker compose exec -T api node src/dev/recreate-pods.ts
echo "✅ Updated."
