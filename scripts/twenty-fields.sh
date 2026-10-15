#!/usr/bin/env bash
# The fields LinkedIn Console writes on Twenty's Person (source / review mark, LinkedIn status, last message
# sent and received, LinkedIn member ID).
#   ./scripts/twenty-fields.sh            show which exist and which are missing (changes nothing)
#   ./scripts/twenty-fields.sh --apply    add the missing ones (custom, nullable; existing fields untouched)
set -euo pipefail
cd "$(dirname "$0")/.."
apply=0
[ "${1:-}" = "--apply" ] && apply=1
docker compose exec -T -e APPLY="$apply" api node src/cli/twenty-fields.ts
