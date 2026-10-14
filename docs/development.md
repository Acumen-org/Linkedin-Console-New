# Development

## Prerequisites

- Node.js 24 (`.nvmrc`). TypeScript runs natively with type stripping, so the server, sidecar and pod-agent have no build step.
- pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- Docker (for the full stack, the end-to-end test and account pods)

## Common commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspaces |
| `pnpm lint` / `pnpm format` | Biome check / fix (lint + format + import order) |
| `pnpm typecheck` | `tsc --noEmit` in every package (Turborepo, cached) |
| `pnpm test` | Unit tests (`apps/sidecar/test`) |
| `pnpm build` | Build `@linkedin-console/contracts` and the web app |
| `pnpm images` | Build all Docker images (`docker compose --profile images build`) |
| `pnpm e2e` | End-to-end test inside the running api container (fake bridge, fake Twilio staff list) |

## Running the stack locally

```bash
cp .env.example .env
# edit: SITE_ADDRESS=:80  COOKIE_SECURE=false  HTTP_PORT=8088
# and fill POSTGRES_PASSWORD, POD_AGENT_TOKEN, LIVE_SECRET with random strings (openssl rand -hex 24)
pnpm images
docker compose up -d --wait
open http://localhost:8088
```

Frontend hot reload: `pnpm --filter @linkedin-console/web dev` (proxies `/api` to `localhost:4000`; publish the api port or run the api with `pnpm --filter @linkedin-console/server dev`).

### Identity tests

The Microsoft sign-in, staff sync and Twenty tests run only when the stack points at the test's own fake staff list and fake Twenty, so running the e2e on a real server never touches real staff. Add to `.env` (as CI does):

```
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
```

The real Microsoft round trip can't run in a test; it is covered by the redirect, state and ID-token checks.

## Working without LinkedIn: the bridge simulator

```bash
# an account row without a pod (or stop a real pod's sidecar first)
docker compose exec -T postgres psql -U linkedin_console -c "insert into accounts (id,label,owner_user_id,status,timezone,language) select 'demoacct0001','Demo',id,'PROVISIONING','UTC','en-US' from users limit 1"
docker compose exec api node src/dev/simulate.ts demoacct0001
```

It seeds conversations, answers send commands like a real bridge (echo → confirmation → typing → "Seen" → reply).

## Browser test for self-healing

```bash
chrome --remote-debugging-port=9333 --user-data-dir=/tmp/heal --headless=new &
HEAL_TEST_CDP=http://127.0.0.1:9333 pnpm --filter @linkedin-console/sidecar test
```

## Conventions

- **Shared types live in `packages/contracts`.** Change the bridge protocol or API shapes there first; the type checks then show every place that must follow.
- **Server modules** (`apps/server/src/modules/<feature>/routes.ts`) are Fastify plugins; validate input with zod; throw `HttpError` (`lib/errors.ts`) for 4xx; never call LinkedIn directly, only `core/bridge.ts`.
- **Database changes** are new numbered SQL files in `apps/server/migrations/` (applied automatically on start, never edited after release).
- **Realtime**: publish with `publish(room, event, data)` (`lib/redis.ts`); event names and payloads are typed in `contracts/realtime.ts`.
- **Imports** use explicit `.ts` extensions in Node apps (required by native type stripping); only erasable TypeScript syntax (no enums/namespaces/parameter properties).
- **Logs** are structured JSON (pino). Never log message bodies or secrets.
- **Commits**: run `pnpm lint && pnpm typecheck && pnpm test`; CI also runs the Docker end-to-end test.
