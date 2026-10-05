# Operations

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SITE_ADDRESS` | | Your domain (automatic HTTPS) or `:80` for LAN testing |
| `COOKIE_SECURE` | `true` | `false` only for plain-HTTP testing |
| `POSTGRES_PASSWORD`, `POD_AGENT_TOKEN`, `LIVE_SECRET` | generated | Secrets (`scripts/install.sh` fills them in) |
| `DEFAULT_TIMEZONE` / `DEFAULT_LANGUAGE` | `America/Chicago` / `en-US` | For new account browsers |
| `DEFAULT_GRANT` | `REPLY` | Access teammates get on new accounts (`READ`/`REPLY`/`FULL`) |
| `DAILY_SEND_CAP` | `80` | Sends per account per 24h (whole team); editable per account |
| `SMTP_URL`, `ALERT_FROM`, `APP_URL` | | Email alerts (`smtp://user:pass@host:587`) |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Contact for web push (keys are generated automatically) |
| `AI_PROVIDER`, `AI_MODEL` | off | Reply drafts: `ollama` (local) or `anthropic` (Claude, default model `claude-opus-5-5`) |
| `HEAL_PROVIDER`, `HEAL_MODEL` | off | Self-healing selectors: `ollama` or `anthropic` |
| `ANTHROPIC_API_KEY`, `OLLAMA_URL` | | Shared by AI drafts and self-healing |
| `POD_MEMORY_MB` | `2048` | Memory limit per account browser |
| `PARK_AFTER_MINUTES` | `10` | Unload human-facing tabs of connected accounts after this long without Live View viewers (restored on open) |
| `SIDECAR_ENV` | | Extra sidecar env, e.g. `CAPTURE_RAW=1` |
| `LOG_LEVEL` | `info` | `debug` for troubleshooting |

After changing `.env`, run `docker compose up -d`. For pod-related settings (`HEAL_*`, `PARK_AFTER_MINUTES`, `SIDECAR_ENV`, `POD_MEMORY_MB`) also run `docker compose exec api node src/dev/recreate-pods.ts`.

## Day-2 tasks

| Task | How |
|---|---|
| Update | `./scripts/update.sh`: pulls, rebuilds, restarts, recreates pods (LinkedIn sessions are kept) |
| Backup | `./scripts/backup.sh`: database + files + every browser profile. Schedule it nightly (cron) and copy the result off-site; it contains private messages |
| Restore | `docker compose exec -T postgres pg_restore -U linkunify -d linkunify --clean < db.dump`, then untar each volume archive into its volume |
| Logs | `docker compose logs -f api worker` · `docker logs -f pod-<accountId>-sidecar` (JSON, filter with `jq`) |
| Restart an account's browser | Accounts → ⟳, or `docker restart pod-<id> pod-<id>-sidecar` |
| Pause sending | Accounts → ⏸ |
| Health | `GET /api/health` (db + redis); Docker healthchecks on api, postgres, redis |

## Monitoring checklist

- `api` container healthy, and `worker` running (it logs `worker started`)
- Accounts page: any **Needs attention** / **Offline** (email alerts if SMTP is set)
- Settings → Webhooks: last delivery status
- Disk: `docker system df`; the `linkunify_files` volume grows with attachments

## Troubleshooting

| Symptom | Check |
|---|---|
| Live View blank / reconnecting | `docker logs pod-<id>-sidecar`; Caddy logs for `/live/` 502s; the pod exists in `docker ps` |
| Account stuck on "Starting" | `docker compose logs pod-agent`; images built (`pnpm images`)? |
| Messages don't sync | Sidecar logs; see [bridge-maintenance.md](bridge-maintenance.md) |
| Push notifications missing | HTTPS domain required; Settings → Notifications on that device |
| Webhook failing | Settings → Webhooks → Test; the target must answer 2xx within 10s |
| "Too many failed login attempts" | 10 failures per IP per 15 minutes; wait, or restart api |

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

One VM with 32 GB RAM comfortably runs about 30 accounts (roughly 0.45–0.6 GB each plus ~0.3 GB of shared services, with headroom for Live View sessions). Beyond that, run additional browser VMs. That needs a shared `linkunify_files` volume (NFS) and a pod-agent per VM, with the api choosing the agent per account. This is designed (`docs/master-plan.md` §5) but not built yet.
