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
[ -d .git ] || echo "Note: no git checkout here, so no new code was pulled; rebuilding what's in this folder." >&2
# An install from before the rename keeps its data under the old names: move it first.
if docker volume inspect linkunify_pgdata >/dev/null 2>&1 && ! docker volume inspect linkedin-console_pgdata >/dev/null 2>&1; then
  echo "This server has an install from before the rename (LinkUnify). Run ./scripts/migrate-from-linkunify.sh instead." >&2
  exit 1
fi
# Secrets added by newer versions (e.g. REDIS_PASSWORD) are generated on the way.
. scripts/ensure-secrets.sh
ensure_secrets
# Fresh base images (security fixes) and, once a week, a fresh Chrome.
docker compose pull --quiet postgres redis
CHROME_REFRESH=$(date +%G-W%V) docker compose --profile images build --pull
docker compose up -d
echo "Recreating account pods with the new images…"
docker compose exec -T api node src/dev/recreate-pods.ts
echo "Waiting for every account to come back (up to 3 minutes)…"
docker compose exec -T api node src/cli/accounts-health.ts || true
echo "✅ Updated."
