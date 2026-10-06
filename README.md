# LinkUnify

**Self-hosted LinkedIn team inbox.** Connect many LinkedIn accounts and let your whole team read and reply from one unified inbox. Each account runs in its own real Chrome on **your** server. Teammates log in to this app, never to LinkedIn.

> ⚠️ LinkedIn's User Agreement prohibits sharing accounts and automated access. LinkUnify keeps each account looking like one normal user, but restrictions are still possible. Start with non-critical accounts. Everyone with access can read private messages, so use the access levels and tell your team.

## Features

| Area | What you get |
|---|---|
| **Connect accounts** | Log in to LinkedIn through a live browser window inside the app (2FA/captcha handled by a human, no password stored). One isolated Chrome + IP per account. |
| **Unified inbox** | All accounts in one list; views for unread, **awaiting reply**, starred, assigned to me, **snoozed**, other, requests/InMail, archived; full-text search; **labels**; live updates |
| **LinkedIn parity** | Text, images, files, GIFs, voice notes, reactions, read receipts ("Seen"), typing indicators, group chats |
| **Team work** | "Sent by" on every message, reply lock ("Ali is replying…"), assignment, internal notes, **saved replies** with variables, per-account access (Read / Reply / Full), audit log |
| **Live LinkedIn** | The real linkedin.com of any account, streamed into the app (feed, profiles, posting…) with a "who's in control" lock |
| **Network** | Each account's connections, searchable, with a "Message" button |
| **Notifications** | In-app banners, **web push** (installable app), email alerts when an account needs re-login |
| **Integrations** | Signed **webhooks** (new message, message sent, assignment, account status) for CRMs, Slack, Zapier, n8n |
| **AI (optional)** | **Reply drafts** and **self-healing** UI selectors, using a local model (Ollama) or Claude |
| **Safety** | Human-paced sending, daily send caps, pause button, session-health monitoring |

## Repository layout

```
apps/
  server/      api + worker        Fastify, Socket.IO, Postgres, Redis (TypeScript, run natively by Node 24)
  web/         web app             React 19, Vite, Tailwind 4, TanStack Query; PWA + push
  sidecar/     per-account pod     Live View (CDP screencast) + LinkedIn bridge (Patchright)
  pod-agent/   pod manager         Docker API: create/restart/recreate/delete account pods
  chrome/      browser image       Headful Google Chrome on Xvfb, persistent profile
packages/
  contracts/   shared types        bridge protocol, API models, realtime events, domain constants
  tsconfig/    shared TS configs
infra/         Caddyfile, Proxmox VM scripts
scripts/       install / update / backup
docs/          architecture, development, operations, bridge maintenance, master plan
tools/         phase0-spike (original feasibility kit)
```

Tooling: **pnpm** workspaces · **Turborepo** · **Biome** (lint + format) · one multi-target **Dockerfile** · **GitHub Actions** CI (lint, typecheck, unit tests, build, Docker end-to-end test).

## Quick start (Proxmox / any Linux server)

```bash
git clone https://github.com/Acumen-org/Linkedin-Console-New.git /opt/linkunify
cd /opt/linkunify
sudo bash infra/proxmox/setup-vm.sh   # Docker + firewall + auto-updates (run inside the VM)
./scripts/install.sh                  # asks for your domain, generates secrets, builds, starts
```

Then open `https://your-domain`, create the owner account, go to **Accounts → Connect LinkedIn account**, and log in through the live window. Full guide: [infra/proxmox/README.md](infra/proxmox/README.md) · day-2 operations: [docs/operations.md](docs/operations.md).

## Development

```bash
corepack enable         # or: npm i -g pnpm@10
pnpm install
pnpm lint               # Biome
pnpm typecheck          # all packages
pnpm test               # unit + browser tests
pnpm images && docker compose up -d && pnpm e2e   # full stack + end-to-end test
```

See [docs/development.md](docs/development.md) for local setup, the bridge simulator and conventions.

## Status

- **Tested end to end:**
  - install, auth, roles, teams, account pods and Live View, the inbox with all team features
  - labels, snooze, saved replies, signed webhooks, push subscriptions, email alerts, self-healing
  - CI runs the same 21-check end-to-end test against the Docker stack
- **Not yet verified against a real logged-in LinkedIn account:**
  - the bridge's data extraction and sending selectors
  - live AI calls
  - [docs/bridge-maintenance.md](docs/bridge-maintenance.md) is the checklist for your first non-critical account

## Documentation

- [Architecture](docs/architecture.md): components, data flow, security model
- [Development](docs/development.md): local setup, tests, conventions
- [Operations](docs/operations.md): configuration, updates, backups, monitoring, troubleshooting
- [Roles and access](docs/rbac.md): team roles, per-account grants, recommended setup
- [Bridge maintenance](docs/bridge-maintenance.md): keeping up with LinkedIn changes
- [Master plan](docs/master-plan.md): original design and roadmap
