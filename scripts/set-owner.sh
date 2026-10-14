#!/usr/bin/env bash
# Makes someone the owner of LinkedIn Console (the previous owner stays on as an admin).
#   ./scripts/set-owner.sh person@example.com ["Their Name"]
# Asks for a password (hidden): needed when the person is new or has none yet; press Enter to keep theirs.
# The owner keeps password sign-in when everyone else uses Microsoft 365 (PASSWORD_SIGNIN=owner).
set -euo pipefail
cd "$(dirname "$0")/.."

email=${1:?usage: set-owner.sh person@example.com ["Their Name"]}
name=${2:-}
read -rsp "Password for ${email} (10+ characters; Enter = keep the current one): " password
echo
if [ -n "$password" ]; then
  read -rsp "Same password again: " again
  echo
  [ "$password" = "$again" ] || { echo "The passwords don't match." >&2; exit 1; }
fi
printf '%s' "$password" | docker compose exec -T -e EMAIL="$email" -e NAME="$name" api node src/cli/set-owner.ts
