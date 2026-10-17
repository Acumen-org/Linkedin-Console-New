#!/usr/bin/env bash
# Writes .env for the end-to-end test stack (CI and local): fresh secrets, plain HTTP on :8088, a fake Microsoft
# tenant, the test's own fake Twilio staff list and fake Twenty CRM (served by the test on api:4100), and no
# automatic recovery (test accounts have no real browser). Never use this on a real server.
#   ./scripts/e2e-env.sh && docker compose --profile images build && docker compose up -d --wait
#   docker compose exec -T api node src/dev/e2e.ts
set -euo pipefail
cd "$(dirname "$0")/.."

cp .env.example .env
. scripts/ensure-secrets.sh
ensure_secrets >/dev/null
# Replaced in place (not appended): .env.example already has most of these keys.
while IFS='=' read -r key value; do
  [ -n "$key" ] && set_env "$key" "$value"
done <<'ENV'
SITE_ADDRESS=:80
COOKIE_SECURE=false
HTTP_PORT=8088
HTTPS_PORT=8443
APP_URL=http://localhost:8088
MICROSOFT_TENANT_ID=00000000-0000-4000-8000-000000000e2e
MICROSOFT_CLIENT_ID=e2e-client
MICROSOFT_CLIENT_SECRET=e2e-secret
TWILIO_CONSOLE_URL=http://api:4100
TWILIO_CONSOLE_API_KEY=e2e-staff-key
STAFF_SYNC=provision
TWENTY_API_URL=http://api:4100/graphql
TWENTY_API_KEY=e2e-twenty-key
CRM_SYNC=on
AUTO_RECOVERY=off
CREDENTIALS_KEY=ZTJlZTJlZTJlZTJlZTJlZTJlZTJlZTJlZTJlZTJlZTI=
ENV
echo "Wrote .env for the test stack."
