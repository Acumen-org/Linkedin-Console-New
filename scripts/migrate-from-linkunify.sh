#!/usr/bin/env bash
# One-time move of an existing install from the project's former name (LinkUnify) to LinkedIn Console.
# Run it once on the server, after pulling the renamed code:
#   cd /opt/linkunify && git pull && ./scripts/migrate-from-linkunify.sh
#
# What it does (about 1-3 minutes of downtime, plus the image build):
#   1. dumps the database to ~/linkedin-console-pre-rename-<date>/db.dump (safety copy)
#   2. stops the old stack and the account pods
#   3. copies every volume to its new name: database, Redis, Caddy (TLS certificates), files, and each
#      account's browser profile (= its LinkedIn login)
#   4. renames the database and its user (linkunify → linkedin_console), password unchanged
#   5. builds and starts the stack under the new names, then recreates the account pods
# The old volumes are left untouched, so going back is possible until you delete them (printed at the end).
# Options: SKIP_BUILD=1 (images already built), SKIP_DUMP=1.
set -euo pipefail
cd "$(dirname "$0")/.."

OLD=linkunify
NEW=linkedin-console
OLD_DB=linkunify
NEW_DB=linkedin_console

vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

[ -f .env ] || { echo "No .env in $(pwd)." >&2; exit 1; }
vol_exists "${OLD}_pgdata" || { echo "Nothing to migrate: volume ${OLD}_pgdata not found." >&2; exit 1; }
if vol_exists "${NEW}_pgdata"; then
  echo "Volume ${NEW}_pgdata already exists: the migration already ran (or the new stack was started first)." >&2
  exit 1
fi
PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)
[ -n "$PASSWORD" ] || { echo "POSTGRES_PASSWORD is empty in .env." >&2; exit 1; }

if [ -z "${SKIP_DUMP:-}" ]; then
  echo "1/5 Safety dump of the database"
  dump_dir="$HOME/linkedin-console-pre-rename-$(date +%Y%m%d-%H%M)"
  mkdir -p "$dump_dir"
  chmod 700 "$dump_dir"
  docker exec "${OLD}-postgres-1" pg_dump -U "$OLD_DB" -Fc "$OLD_DB" > "$dump_dir/db.dump"
  echo "    $dump_dir/db.dump ($(du -h "$dump_dir/db.dump" | cut -f1))"
fi

echo "2/5 Stopping the old stack and the account pods"
docker ps -aq --filter "label=com.docker.compose.project=${OLD}" | xargs -r docker rm -f >/dev/null
docker ps -aq --filter "label=${OLD}.pod" | xargs -r docker rm -f >/dev/null
docker network rm "$OLD" >/dev/null 2>&1 || true

echo "3/5 Copying volumes"
copy() {
  local from=$1 to=$2
  shift 2
  docker volume create "$@" "$to" >/dev/null
  docker run --rm -v "$from":/from:ro -v "$to":/to alpine:3.22 sh -c 'cp -a /from/. /to/'
  echo "    $from → $to"
}
for v in pgdata redisdata caddydata caddyconfig files; do
  vol_exists "${OLD}_$v" || continue
  copy "${OLD}_$v" "${NEW}_$v" --label "com.docker.compose.project=${NEW}" --label "com.docker.compose.volume=$v"
done
for v in $(docker volume ls -q --filter "name=^${OLD}_profile_"); do
  id=${v#"${OLD}_profile_"}
  copy "$v" "${NEW}_profile_${id}" --label "${NEW}.pod=${id}"
done

echo "4/5 Renaming the database and its user"
tmp="${NEW}-db-rename"
docker rm -f "$tmp" >/dev/null 2>&1 || true
docker run -d --name "$tmp" -v "${NEW}_pgdata":/var/lib/postgresql/data postgres:17 >/dev/null
for _ in $(seq 60); do docker exec "$tmp" pg_isready -q -U "$OLD_DB" && break; sleep 1; done
# The original user can't be renamed while connected as it, so a temporary superuser does the rename.
docker exec "$tmp" psql -q -v ON_ERROR_STOP=1 -U "$OLD_DB" -d postgres -c "CREATE ROLE lc_rename SUPERUSER LOGIN"
docker exec "$tmp" psql -q -v ON_ERROR_STOP=1 -U lc_rename -d postgres \
  -c "ALTER ROLE ${OLD_DB} RENAME TO ${NEW_DB}" -c "ALTER DATABASE ${OLD_DB} RENAME TO ${NEW_DB}"
docker exec -i "$tmp" psql -q -v ON_ERROR_STOP=1 -U "$NEW_DB" -d postgres -v pw="$PASSWORD" <<'SQL'
ALTER ROLE linkedin_console PASSWORD :'pw';
DROP ROLE lc_rename;
SQL
docker rm -f "$tmp" >/dev/null
echo "    database and user are now ${NEW_DB}"

echo "5/5 Starting LinkedIn Console"
if [ -z "${SKIP_BUILD:-}" ]; then
  docker compose --profile images build
  docker compose build
fi
docker compose up -d
docker compose exec -T api node src/dev/recreate-pods.ts

echo
echo "✅ Migrated. Check the app: log in, open the inbox, open Live View of an account (still logged in)."
echo "   The old volumes are kept for rollback. Once everything works, delete them with:"
echo "   docker volume rm \$(docker volume ls -q --filter name=^${OLD}_)"
