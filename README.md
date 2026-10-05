# LinkUnify: self-hosted LinkedIn team inbox

Connect many LinkedIn accounts and let your whole team read and reply from **one unified inbox**. Each account runs in its own real Chrome on **your** server. Teammates log in to this app, never to LinkedIn.

- **Connect an account in 1 minute:** the owner logs in to LinkedIn through a live browser window inside the app (2FA/captcha handled by the human, no password stored).
- **Unified Inbox:** all accounts in one list; filters (unread, starred, assigned, other, requests, archived); search; live updates.
- **Like LinkedIn messaging:** text, images, files, GIFs, voice notes, reactions, read receipts ("Seen"), typing indicators, group chats.
- **Team features:** "sent by" on every message, reply lock ("Ali is replying…"), assignment, internal notes, per-account access (Read / Reply / Full), audit log.
- **Live LinkedIn:** the real linkedin.com of any account, streamed into the app (feed, profiles, posting, everything else).
- **Network:** each account's connections, searchable, with a "Message" button.
- **Safety:** one browser, one IP and one session per account; human-paced sending; daily send cap; pause button.
- **Alerts:** in-app banner + email (optional SMTP) when an account needs re-login or its browser goes offline.
- **Self-healing (optional):** if LinkedIn changes a button, an AI model (local Ollama or Claude) finds it again from the page's accessibility tree; the fix is cached.

> ⚠️ LinkedIn's User Agreement prohibits sharing accounts and automated access. This tool keeps each account looking like one normal user, but restrictions are still possible. Start with non-critical accounts. Everyone with access can read private messages: use the access levels and tell your team.

---

## How it works

```
Teammates ──HTTPS──► Caddy ──► web (React) + api (Fastify, Socket.IO) + worker
                       │                         │            ▲
                       │ /live/<id>  (auth-gated) │ Redis      │ events
                       ▼                         ▼            │
              ┌── account pod (one per LinkedIn account) ───────────────┐
              │  chrome   real Google Chrome, persistent profile        │
              │  sidecar  Live View (CDP screencast) + bridge           │
              └──────────────────── egress: your public IP ─────────────┘
```

| Part | Folder | What it does |
|---|---|---|
| web | `apps/web` | React app (Vite, Tailwind, TanStack Query), baked into the Caddy image |
| api + worker | `apps/server` | REST + realtime + auth/roles; worker turns bridge events into DB rows |
| pod-agent | `apps/pod-agent` | Creates/removes account pods through the Docker API |
| chrome | `apps/chrome` | Headful Chrome on Xvfb, profile on a volume, CDP only on 127.0.0.1 |
| sidecar | `apps/sidecar` | **Live View** (stream + input + control lock) and the **bridge** (reads LinkedIn's own JSON/realtime stream, sends at human pace) |

---

## Install on Proxmox

Follow [`infra/proxmox/README.md`](infra/proxmox/README.md). Short version:

```bash
# on the Proxmox host
VMID=210 ./infra/proxmox/create-vm.sh
# inside the VM, project in /opt/linkunify
sudo bash infra/proxmox/setup-vm.sh
./scripts/install.sh
```

Then open `https://your-domain`, create the owner account, go to **Accounts → Connect LinkedIn account**, and log in through the live window.

## Daily operations

| Task | Command |
|---|---|
| Update | `./scripts/update.sh` (rebuilds and restarts everything; LinkedIn sessions are kept) |
| Backup | `./scripts/backup.sh` (database + files + browser profiles); run it nightly from cron |
| Logs | `docker compose logs -f api worker` · `docker logs -f pod-<accountId>-sidecar` |
| Restart one account's browser | Accounts → ⟳, or `docker restart pod-<id> pod-<id>-sidecar` |
| Pause sending for an account | Accounts → ⏸ |

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SITE_ADDRESS` | | Your domain (auto-HTTPS) or `:80` for LAN testing |
| `DEFAULT_TIMEZONE` | `America/Chicago` | Timezone for new account browsers |
| `DEFAULT_GRANT` | `REPLY` | Access teammates get on new accounts (`READ`/`REPLY`/`FULL`) |
| `DAILY_SEND_CAP` | `80` | Max sends per account per 24h (whole team); editable per account |
| `POD_MEMORY_MB` | `2048` | Memory limit per account browser |
| `SIDECAR_ENV` | | Extra sidecar env, e.g. `CAPTURE_RAW=1` (see maintenance guide) |
| `SMTP_URL`, `ALERT_FROM`, `APP_URL` | | Email alerts, e.g. `smtp://user:pass@smtp.host:587` |
| `HEAL_PROVIDER` | (off) | `ollama` (fully local, set `OLLAMA_URL`) or `anthropic` (set `ANTHROPIC_API_KEY`; page text is sent to Claude when healing) |
| `HEAL_MODEL` | `claude-opus-5-5` / `qwen2.5:7b` | Model used for self-healing |

## Status: what's tested and what isn't

Tested end to end in Docker on this PC:
- install, first-run setup, login, roles, team management, access grants, audit log
- account pods (create, restart, recreate, delete), Live View through Caddy and the auth gate showing LinkedIn's real login page, click and typing, the control lock
- unified inbox with realtime updates, sending with "sent by", the reply lock, mark-as-read, notes, uploads, connections page
- ingest of LinkedIn-shaped data, using a bridge simulator (`apps/server/src/dev/simulate.ts`), the automated end-to-end test (`apps/server/src/dev/e2e.ts`) and unit tests (`apps/sidecar/test`)
- self-healing lookup in a real Chrome (stand-in model), email alerts via a test SMTP server

**Not yet tested against a real logged-in LinkedIn account:**
- the bridge's extraction of LinkedIn's live data
- the sending selectors
- a live Claude or Ollama call for self-healing

These are the parts LinkedIn can change at any time. Confirm them with your first non-critical account using [`docs/BRIDGE_MAINTENANCE.md`](docs/BRIDGE_MAINTENANCE.md).

## Local development

```bash
cp .env.example .env    # SITE_ADDRESS=:80, COOKIE_SECURE=false, HTTP_PORT=8088, fill secrets
docker compose --profile images build && docker compose up -d
# open http://localhost:8088
# demo data without LinkedIn:
docker stop pod-<id>-sidecar && docker compose exec api node src/dev/simulate.ts <accountId>
```
Tests:
- End-to-end (api + worker + DB + Redis, fake bridge): `docker compose exec api node src/dev/e2e.ts` (15 checks)
- Bridge extraction: `cd apps/sidecar && npm test`
- Self-healing in a real Chrome: start Chrome with `--remote-debugging-port=9333 --headless=new`, then `HEAL_TEST_CDP=http://127.0.0.1:9333 npm test`
- Type checks: `cd apps/server && npx tsc --noEmit`, `cd apps/web && npx tsc --noEmit`

See [`MASTER_PLAN.md`](MASTER_PLAN.md) for the full design and roadmap.
