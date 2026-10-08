#!/usr/bin/env bash
# Nightly backup: database dump + files + every account's browser profile (= LinkedIn sessions) + .env.
# Scheduled by scripts/schedule-backup.sh. Copy BACKUP_DIR off the server (Proxmox Backup Server, NAS, S3…):
# backups contain private messages, LinkedIn sessions and the app's secrets, so keep them encrypted.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-/var/backups/linkedin-console}
KEEP_DAYS=${KEEP_DAYS:-14}
stamp=$(date +%Y%m%d-%H%M)
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"
chmod 700 "$dest"
failed=0

docker compose exec -T postgres pg_dump -U linkedin_console -Fc linkedin_console > "$dest/db.dump"
# The secrets (database, Redis, Microsoft, Twilio key): needed to bring this backup back.
cp .env "$dest/env" && chmod 600 "$dest/env"

# Chrome's caches are rebuilt by itself: leaving them out keeps each copy small.
EXCLUDES="--exclude=*/Cache --exclude=*/Code?Cache --exclude=*/GPUCache --exclude=./GPUPersistentCache --exclude=*/Dawn*Cache --exclude=*/GrShaderCache --exclude=*/Service?Worker/CacheStorage --exclude=*/Service?Worker/ScriptCache --exclude=*/Shared?Dictionary/cache --exclude=*/AutofillAiModelCache"

archive() {
  local vol=$1
  # tar exits 1 when a file changes while it's read: still a usable archive, so only >1 is a failure.
  docker run --rm -v "$vol":/v:ro -v "$dest":/out alpine:3.22 sh -c "tar czf '/out/$vol.tgz' $EXCLUDES -C /v .; [ \$? -le 1 ]" \
    || { echo "warning: $vol could not be archived" >&2; failed=1; }
}

archive linkedin-console_files
for vol in $(docker volume ls -q --filter name=linkedin-console_profile_); do
  id=${vol#linkedin-console_profile_}
  # Paused while copied, so Chrome isn't half-way through writing its cookie database (a torn copy logs
  # the account out after a restore). A few seconds per account.
  paused=""
  docker pause "pod-$id" >/dev/null 2>&1 && paused=1
  archive "$vol"
  [ -n "$paused" ] && docker unpause "pod-$id" >/dev/null 2>&1 || true
done

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
if [ "$failed" -eq 0 ]; then
  echo "$(date -Is) backup ok → $dest"
else
  echo "$(date -Is) backup finished with warnings → $dest" >&2
  exit 1
fi
