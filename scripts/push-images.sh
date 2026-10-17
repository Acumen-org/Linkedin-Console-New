#!/usr/bin/env bash
# Push the locally built images to the Harbor registry, tagged latest and with the current commit.
# Build first (docker compose --profile images build && docker compose build), and log in yourself:
#   docker login h4rb0r.acm.acumen-strategy.com
#   ./scripts/push-images.sh
# Overwrites the tags in the registry ("latest" moves to this build).
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY=${REGISTRY:-h4rb0r.acm.acumen-strategy.com}
PROJECT=${PROJECT:-linkedin-outreach}
TAG=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || echo "Note: uncommitted changes; the $TAG tag may not match exactly what was built."

# Harbor shares one public IP with the app and Nomad: a brief blip shouldn't fail the whole push. Retry.
push_with_retry() {
  for i in 1 2 3 4 5; do
    docker push -q "$1" && return 0
    echo "  push $1 attempt $i failed; retrying in $((i * 10))s" >&2
    sleep $((i * 10))
  done
  echo "Failed to push $1 after 5 attempts (is $REGISTRY reachable?)" >&2
  return 1
}

# local image → repository in the Harbor project
MAPPING="server:worker caddy:frontend sidecar:sidecar chrome:chrome pod-agent:pod-agent"

for pair in $MAPPING; do
  local_name="linkedin-console/${pair%%:*}:latest"
  repo="$REGISTRY/$PROJECT/${pair##*:}"
  docker image inspect "$local_name" >/dev/null 2>&1 || { echo "Missing $local_name: build first." >&2; exit 1; }
  for t in latest "$TAG"; do
    docker tag "$local_name" "$repo:$t"
    push_with_retry "$repo:$t"
  done
  echo "✅ $local_name → $repo (latest, $TAG)"
done
