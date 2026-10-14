# Operations

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SITE_ADDRESS` | | Your domain (automatic HTTPS) or `:80` for LAN testing |
| `COOKIE_SECURE` | `true` | `false` only for plain-HTTP testing |
| `POSTGRES_PASSWORD`, `POD_AGENT_TOKEN`, `LIVE_SECRET` | generated | Secrets (`scripts/install.sh` fills them in) |
| `DEFAULT_TIMEZONE` / `DEFAULT_LANGUAGE` | `America/Chicago` / `en-US` | For new account browsers |
| `DEFAULT_GRANT` | `NONE` | Access members get automatically on new accounts / as new teammates (`NONE`/`READ`/`REPLY`/`FULL`); see [rbac.md](rbac.md) |
| `TRUSTED_PROXIES` | | Behind a gateway (APISIX, nginx…): its IP/CIDR(s), space-separated, so the real client IP is used for login limits and the audit log. Leave empty when Caddy faces the internet directly |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Published ports |
| `DAILY_SEND_CAP` | `80` | Sends per account per 24h (whole team); editable per account |
| `NEW_CHAT_CAP` | `20` | Of those, new chats (cold outreach) per account per 24h; editable per account |
| `SEND_RAMP`, `SEND_RAMP_START`, `SEND_RAMP_STEP` | `on`, `20`, `10` | Newly connected accounts start at 20/day and add 10 per day up to their cap ("skip ramp-up" per account for established ones). A LinkedIn limit or restriction warning pauses sending on the account, restarts its ramp and emails the admins |
| `SMTP_URL`, `ALERT_FROM`, `APP_URL` | | Email alerts (`smtp://user:pass@host:587`) |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Contact for web push (keys are generated automatically) |
| `AI_PROVIDER`, `AI_MODEL` | off | Reply drafts: `ollama` (local) or `anthropic` (Claude, default model `claude-opus-5-5`) |
| `HEAL_PROVIDER`, `HEAL_MODEL` | off | Self-healing selectors: `ollama` or `anthropic` |
| `ANTHROPIC_API_KEY`, `OLLAMA_URL` | | Shared by AI drafts and self-healing |
| `POD_MEMORY_MB` | `1024` | Memory limit per account browser (measured use is about 450 MB) |
| `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE` | `1GB`, `4GB` | Postgres memory; protected from the memory killer, like Redis |
| `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | | Microsoft 365 sign-in (Entra app registration; redirect URI `<APP_URL>/api/auth/microsoft/callback`). Needs `APP_URL`. See [rbac.md](rbac.md) |
| `PASSWORD_SIGNIN` | `on` | `owner`: only the owner may use a password (emergency access); others use Microsoft |
| `STAFF_SYNC` | `off` | Follow the Twilio console staff list: `disable` (leavers) or `provision` (also adds staff as members). With `TWILIO_CONSOLE_URL`, `TWILIO_CONSOLE_API_KEY`, `STAFF_SYNC_MINUTES` (5) |
| `SEND_MODE` | `fast` | `fast`: text replies reach LinkedIn in about half a second. `human`: typed with human pauses (10-20 s) |
| `PARK_AFTER_MINUTES` | `10` | Unload human-facing tabs of connected accounts after this long without Live View viewers (restored on open) |
| `SIDECAR_ENV` | | Extra sidecar env, e.g. `CAPTURE_RAW=1` |
| `LOG_LEVEL` | `info` | `debug` for troubleshooting |

After changing `.env`, run `docker compose up -d`. For pod-related settings (`HEAL_*`, `PARK_AFTER_MINUTES`, `SEND_MODE`, `SIDECAR_ENV`, `POD_MEMORY_MB`) also run `docker compose exec api node src/dev/recreate-pods.ts`.

## Day-2 tasks

| Task | How |
|---|---|
| Update | `./scripts/update.sh`: pulls, rebuilds, restarts, recreates pods (LinkedIn sessions are kept) |
| Backup | `./scripts/backup.sh`: database + files + every browser profile. `./scripts/schedule-backup.sh` runs it nightly at 03:15 into `/var/backups/linkedin-console` (`BACKUP_TIME`, `BACKUP_DIR` to change; `--remove` to stop). Copy the result off-site, encrypted; it contains private messages and LinkedIn sessions |
| Restore | 1. Stop writers: `docker compose stop api worker caddy` and `docker stop $(docker ps -q --filter label=linkedin-console.pod)`. 2. `docker compose exec -T postgres pg_restore -U linkedin_console -d linkedin_console --clean < db.dump`. 3. Untar each `<volume>.tgz` into its volume (`docker run --rm -v <volume>:/v -v $PWD:/b alpine tar xzf /b/<volume>.tgz -C /v`). 4. Put `env` back as `.env` if the secrets changed. 5. `docker compose up -d`, then `docker compose exec api node src/dev/recreate-pods.ts` |
| Import a LinkedIn data archive | Accounts → ⬆ on the account (FULL access): upload `Connections.csv` and `messages.csv` from LinkedIn's "Download my data" ZIP. Adds every connection (with its date) and older chats; merges with synced data, never duplicates |
| Export chats | Accounts → **Export chats** (admins): the latest N chats with all stored messages, CSV or JSON; recorded in the audit log |
| Logs | `docker compose logs -f api worker` · `docker logs -f pod-<accountId>-sidecar` (JSON, filter with `jq`) |
| Restart an account's browser | Accounts → ⟳, or `docker restart pod-<id> pod-<id>-sidecar` |
| Pause sending | Accounts → ⏸ |
| Health | `GET /api/health` (db + redis); Docker healthchecks on api, postgres, redis |

### Registry images

`./scripts/push-images.sh` pushes the locally built images to Harbor (`h4rb0r.acm.acumen-strategy.com/linkedin-outreach`, tags `latest` and the commit): server → `worker`, web/Caddy → `frontend`, plus `sidecar`, `chrome`, `pod-agent`. Log in first with `docker login`; `REGISTRY` and `PROJECT` override the target.

## Account browsers stay on

Every LinkedIn account runs in its own browser (Chrome + bridge). It is kept running without anyone watching:

- **Restarted by itself.** When a browser stops reporting for 4 minutes, or its containers are missing or stopped (server reboot, failed update, removed by hand), the worker restarts it within a minute, and creates it again if it is gone. The LinkedIn session lives in the account's profile volume and is kept. If it doesn't come back, it tries again after 2, 5, 15, 30 minutes, then every hour. Each restart is in the audit log ("Restarted an account browser automatically").
- **Admins are alerted** (email, with SMTP set up) only when three restarts in a row (about 20 minutes) didn't bring it back, not on a short hiccup.
- **A hung browser restarts itself.** The bridge checks every minute that its LinkedIn tab still answers; after three misses in a row it exits and Docker starts it again. A crashed tab or a lost Chrome connection does the same at once.
- **After an update**, `./scripts/update.sh` waits up to 3 minutes and lists every account as back or not yet.
- **Accounts page:** how long each browser has been up, and its last automatic restart with the reason.

What can't be fixed automatically: LinkedIn logging an account out or asking for a security check. That account shows **Needs attention** (its browser keeps running) and someone with full access logs in again through **Reconnect**.

`AUTO_RECOVERY=off` switches the restarts off; only for test stacks whose accounts have no real browser.

## Monitoring checklist

- `api` and `worker` containers healthy (`docker compose ps`); the worker restarts itself if its event processing stalls
- Accounts page: any **Needs attention** / **Offline** (email alerts if SMTP is set)
- Settings → Webhooks: last delivery status
- Disk: `docker system df`; the `linkedin-console_files` volume grows with attachments

## Troubleshooting

| Symptom | Check |
|---|---|
| Live View blank / reconnecting | `docker logs pod-<id>-sidecar`; Caddy logs for `/live/` 502s; the pod exists in `docker ps` |
| Account stuck on "Starting" | `docker compose logs pod-agent`; images built (`pnpm images`)? |
| Messages don't sync | Sidecar logs; see [bridge-maintenance.md](bridge-maintenance.md) |
| Push notifications missing | HTTPS domain required; Settings → Notifications on that device |
| Webhook failing | Settings → Webhooks → Test; the target must answer 2xx within 10s |
| "Too many failed login attempts" | 10 failures per IP per 15 minutes (successful logins don't count); wait, or restart api. If everyone is locked out at once behind a gateway, `TRUSTED_PROXIES` is missing and all users share the gateway's IP |
| Audit log shows the gateway's IP for everyone | Set `TRUSTED_PROXIES` to the gateway's IP and `docker compose up -d` |

## Resource usage

Measured on Docker (Chrome 154), per LinkedIn account:

| Part | Memory |
|---|---|
| Chrome, logged-out/login page | ~345 MB |
| Chrome, heavy LinkedIn page open in Live View | ~435 MB (more for a long feed) |
| Chrome after idle-tab parking | ~330 MB |
| Sidecar (Live View + bridge) | ~77 MB (capped at 256 MB) |

Shared services: api ~90 MB, worker ~60 MB, pod-agent ~30 MB, Postgres ~35-75 MB, Redis ~7 MB, Caddy ~10 MB.

What keeps it light:
- Chrome background services that websites can't see are off (sync, component updates, on-device ML models, translation, media router).
- Idle human tabs are parked.
- Live View only streams while someone watches.
- The AI SDK loads only when self-healing is used.
- The pod-agent talks to the Docker API directly.
- Node images are Alpine.

**Deliberately not done:**
- **Chrome's new headless mode.** Tested with Chrome 154: it still puts "HeadlessChrome" in the user agent (sent to LinkedIn on every request), reports an 800×600 screen and a software WebGL renderer.
- **One shared Chrome for several accounts.** Identical device fingerprints would link the accounts.
- **Lightpanda.** It has no rendering, so Live View can't work, and it isn't Chrome.
- **Disabling site isolation.** It saves memory but weakens security.

## Scaling

One VM with 32 GB RAM comfortably runs about 30 accounts (roughly 0.45–0.6 GB each plus ~0.3 GB of shared services, with headroom for Live View sessions). Beyond that, run additional browser VMs. That needs a shared `linkedin-console_files` volume (NFS) and a pod-agent per VM, with the api choosing the agent per account. This is designed (`docs/master-plan.md` §5) but not built yet.
