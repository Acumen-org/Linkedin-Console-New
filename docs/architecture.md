# Architecture

## Components

```
                    ┌────────────────────────── Docker host (Proxmox VM) ───────────────────────────┐
 Browser ──HTTPS──► │ caddy ──► web (static React app)                                              │
 (team)             │   │  ├──► api  ──── postgres                                                  │
                    │   │  │     │  └──── redis ◄──── worker ──► webhooks / web push / SMTP          │
                    │   │  │     │            ▲  ▲                                                   │
                    │   │  │     └──► pod-agent ──(Docker API)──► account pods                       │
                    │   │  │                  │  │                                                   │
                    │   └─ /live/<id> ──(forward_auth via api)──► pod-<id>: chrome + sidecar         │
                    │                         │  │                 (Live View + bridge)              │
                    │                         └──┴── bridge events / commands (Redis streams)        │
                    └──────────────────────────────────────────────┬────────────────────────────────┘
                                                                   │ egress: server public IP (or proxy)
                                                                   ▼
                                                               LinkedIn
```

| Component | Responsibility |
|---|---|
| **caddy** | TLS (Let's Encrypt), serves the web app, proxies `/api` and `/socket.io`, gates `/live/<id>` with `forward_auth` and adds the pod secret |
| **api** (`apps/server/src/api.ts`) | REST + Socket.IO; auth, roles, per-account grants; enqueues bridge commands; never talks to LinkedIn |
| **worker** (`apps/server/src/worker.ts`) | Consumes bridge events → database → realtime; delivers webhooks; push notifications; email alerts; scheduler (offline detection, daily connection sync, snooze wake-up) |
| **pod-agent** | The only service with the Docker socket; creates/recreates/removes pods; token-protected, internal only |
| **account pod** | `pod-<id>`: Chrome with a persistent profile (the LinkedIn session). `pod-<id>-sidecar`: Live View + bridge, sharing Chrome's network namespace so CDP stays on 127.0.0.1 |

## Server code layout

```
apps/server/src/
  api.ts, worker.ts      process entry points
  app.ts                 Fastify app (plugins, error handling, module registration)
  lib/                   infrastructure: config (zod-validated), db + migrations, redis, logger, errors, ids, vapid
  core/                  cross-cutting: auth/sessions, access control, audit, bridge client + pod-agent, realtime, webhook queue
  modules/<feature>/     HTTP routes per feature: auth, users, accounts, conversations (+messages, queries), labels,
                         templates, files, network, live, audit, webhooks (+deliver), push, ai, system
  worker/                ingest (bridge events → DB), scheduler, webhooks delivery, push, alerts, stream consumer
  dev/                   e2e test, bridge simulator, recreate-pods
```

## Bridge protocol

Defined once in `packages/contracts/src/bridge.ts` and used by both sides.

| Redis key | Direction | Content |
|---|---|---|
| `li:events` (stream) | bridge → worker | `session`, `conversations`, `messages`, `seen`, `typing`, `contacts`, `result` |
| `li:cmd:<accountId>` (stream) | api/worker → bridge | `send_message`, `start_chat`, `sync_inbox`, `sync_thread`, `sync_connections`, `mark_read`, `fetch_media`, `check_session` |
| `li:reply:<cmdId>` (list) | bridge → api | direct replies (media downloads) |
| `lu:webhooks` (stream) | api/worker → worker | outgoing webhook events |
| `lu:emit` (pub/sub) | api/worker → api | realtime events for Socket.IO rooms |

Streams use consumer groups, so events survive restarts and are processed exactly once per group.

## Sidecar (per account)

```
apps/sidecar/src/
  main.ts                 boot: proxy forwarder (optional) → wait for Chrome → Live View → bridge
  liveview/server.ts      CDP screencast to viewers; control lock; secret header from Caddy
  liveview/input.ts       viewer input → CDP Input events
  bridge/index.ts         wires the modules below
  bridge/reader.ts        READ: intercept LinkedIn JSON + realtime SSE → extract → events; outbound confirmations
  bridge/extract.ts       LinkedIn payloads → normalized contracts (entity-based, endpoint-agnostic)
  bridge/session.ts       HEALTH: login state heartbeat; quiet reconcile loop
  bridge/commands.ts      WRITE: command handlers (human-paced, one at a time)
  bridge/actions.ts       UI actions (selectors) with self-healing lookup
  bridge/heal.ts          accessibility snapshot → LLM → cached role+name
  bridge/linkedin.ts      in-page requests (CSRF, Voyager, /me)
  bridge/window.ts        the bridge's own background window
```

## Security model

- **Users** authenticate with Argon2id-hashed passwords and httpOnly, SameSite=Lax session cookies. Cross-site state-changing requests are rejected, and repeated failed logins are throttled per IP.
- **Authorization**: OWNER/ADMIN have full access. MEMBERs need a per-account grant (READ < REPLY < FULL). This is checked on every route and on socket room joins.
- **Live View** is reachable only through Caddy. Caddy calls `/api/live/auth` (session + grant) and adds `X-LU-Secret`, and the sidecar rejects anything without that secret. CDP is never exposed.
- **Chrome** blocks internal hostnames (api, redis, postgres, …) by policy, stores no passwords, and blocks extensions.
- **Webhooks** are admin-only. Payloads are HMAC-SHA256 signed, and the secret is shown once.
- **Audit log** records logins, sends, Live View sessions, account/grant/user changes, AI drafts and webhook changes.
- **Data**: messages and attachments stay on your server. Optional AI features send conversation text to the chosen provider; use Ollama to keep everything local.
