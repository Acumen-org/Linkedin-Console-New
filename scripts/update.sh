#!/usr/bin/env bash
# Update to the latest code: rebuild images, restart services, recreate account pods.
# LinkedIn sessions are kept (they live in each account's profile volume).
#   ./scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Pull, then restart with the pulled version of this script (bash would otherwise keep reading the old file).
if [ -d .git ] && [ -z "${UPDATE_PULLED:-}" ]; then
  git pull --ff-only
  UPDATE_PULLED=1 exec "$(pwd)/scripts/update.sh" "$@"
fi
# An install from before the rename keeps its data under the old names: move it first.
if docker volume inspect linkunify_pgdata >/dev/null 2>&1 && ! docker volume inspect linkedin-console_pgdata >/dev/null 2>&1; then
  echo "This server has an install from before the rename (LinkUnify). Run ./scripts/migrate-from-linkunify.sh instead." >&2
  exit 1
fi
docker compose --profile images build
docker compose up -d
echo "Recreating account pods with the new images…"
docker compose exec -T api node src/dev/recreate-pods.ts
echo "✅ Updated."
