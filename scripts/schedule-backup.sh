#!/usr/bin/env bash
# Schedule the nightly backup (database + files + browser profiles) in the current user's crontab.
#   ./scripts/schedule-backup.sh                 03:15 every night, into /var/backups/linkedin-console
#   BACKUP_TIME="30 2" BACKUP_DIR=/srv/backups ./scripts/schedule-backup.sh
#   ./scripts/schedule-backup.sh --remove
# Safe to run again: it replaces its own crontab line. Copy the backups off this machine (they contain
# private messages and LinkedIn sessions); keep the copies encrypted.
set -euo pipefail
cd "$(dirname "$0")/.."

MARK='# linkedin-console-backup'
# Also drops the line written under the project's former name (# linkunify-backup).
current=$(crontab -l 2>/dev/null | grep -v -e "$MARK" -e '# linkunify-backup' || true)

if [ "${1:-}" = "--remove" ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  echo "Backup schedule removed."
  exit 0
fi

BACKUP_TIME=${BACKUP_TIME:-"15 3"}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/linkedin-console}
LOG_FILE=${LOG_FILE:-$HOME/linkedin-console-backup.log}

# The backup user must be able to write the target directory.
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
  sudo mkdir -p "$BACKUP_DIR"
  sudo chown "$(id -u):$(id -g)" "$BACKUP_DIR"
  sudo chmod 700 "$BACKUP_DIR"
fi

line="$BACKUP_TIME * * * cd $PWD && BACKUP_DIR=$BACKUP_DIR ./scripts/backup.sh >> $LOG_FILE 2>&1 $MARK"
printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
echo "✅ Nightly backup scheduled ($BACKUP_TIME * * *) into $BACKUP_DIR; log: $LOG_FILE"
echo "   Run one now to test: BACKUP_DIR=$BACKUP_DIR ./scripts/backup.sh"
