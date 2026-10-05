#!/usr/bin/env bash
# Nightly backup: database dump + files + every account's browser profile (= LinkedIn sessions).
# Put it in cron:  15 3 * * *  /opt/linkunify/scripts/backup.sh >> /var/log/linkunify-backup.log 2>&1
# Copy BACKUP_DIR off the server (Proxmox Backup Server, NAS, S3…). Backups contain private messages: keep them encrypted.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-/var/backups/linkunify}
KEEP_DAYS=${KEEP_DAYS:-14}
stamp=$(date +%Y%m%d-%H%M)
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"

docker compose exec -T postgres pg_dump -U linkunify -Fc linkunify > "$dest/db.dump"

for vol in linkunify_files $(docker volume ls -q --filter name=linkunify_profile_); do
  docker run --rm -v "$vol":/v:ro -v "$dest":/out alpine tar czf "/out/$vol.tgz" -C /v .
done

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "$(date -Is) backup ok → $dest"
