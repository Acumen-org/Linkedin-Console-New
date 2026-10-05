# Phase 0: One LinkedIn Account in a Self-Hosted Browser (Proxmox)

**Goal:** prove, in 3–5 days, that:
1. a teammate can **log in to LinkedIn through the Live View in their own web browser** (doing 2FA/captcha themselves),
2. the session survives restarts,
3. a script attached to the same browser can **read** conversations + live events,
4. and **send** text + an image,

with LinkedIn seeing one consistent device on your public IP.

```
phase0/
├── docker-compose.yml
├── .env.example
├── browser/        real Google Chrome (headful on Xvfb), persistent profile, CDP on 127.0.0.1
│   ├── Dockerfile
│   ├── start.sh
│   └── policies.json
├── liveview/       CDP-screencast Live View: stream + mouse/keyboard/paste/file upload
│   ├── server.mjs
│   └── public/index.html
└── spike/src/      check.mjs · record.mjs · send-test.mjs
```

**How Live View works:** Chrome sends JPEG frames of the tab (`Page.startScreencast`), the server forwards them over a WebSocket, and your clicks and keys go back as `Input.dispatch*`. There's no VNC, no WebRTC and no UDP ports, only one HTTP/WebSocket port, so it works behind any reverse proxy. Live View only uses the `Page`/`Input`/`DOM` CDP domains, so it adds no automation fingerprint to the page.

> ✅ Tested locally against Chrome 154: streaming, click, typing, Enter, scroll, navigation and tab list all work.

---

## 1. Proxmox VM

Create a VM (Docker inside a VM is more reliable than inside LXC):

| Setting | Value |
|---|---|
| OS | Ubuntu Server 24.04 / Debian 12 |
| CPU | 2–4 cores, **type `host`** |
| RAM | 4 GB (spike) |
| Disk | 40 GB (VirtIO SCSI, `discard` on) |
| Network | `vmbr0` (public) or a private bridge + NAT, see the master plan §5 |
| Options | QEMU guest agent on |

Inside the VM:
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in
```
Phase 0 needs **no inbound ports** apart from SSH. Live View is reached through an SSH tunnel.

## 2. Configure

```bash
cd phase0
cp .env.example .env
# set ACCOUNT_TIMEZONE / CHROME_LANG to the account owner's,
# set LIVEVIEW_TOKEN to a long random string:  openssl rand -hex 32
# leave PROXY_SERVER empty to use the server's public IP
docker compose up -d --build
docker compose logs -f browser liveview
```

## 3. Log in (as the teammate would)

From your computer:
```bash
ssh -L 8090:127.0.0.1:8090 user@<VM_OR_PUBLIC_IP>
```
Open `http://localhost:8090/?token=<LIVEVIEW_TOKEN>`. You'll see LinkedIn's login page. Click into the page, type the email and password, and complete 2FA (authenticator code, SMS, or "approve on your phone").

> ⚠️ **Passkeys don't work** in a remote browser (they're bound to your physical device). Use password + 2FA.
> Paste works (Ctrl/Cmd+V). If a page opens a file picker, a blue bar appears to upload from your computer.

## 4. Run the checks

```bash
docker compose --profile tools run --rm --build spike node src/check.mjs
```
Expect `✅ Logged in.` and your **public IP** (or the proxy's).

```bash
docker compose --profile tools run --rm spike node src/record.mjs 180
```
During those 3 minutes, open a few conversations in Live View and have someone message the account. Output goes to `out/`, **which contains private data. Don't share or commit it.**

```bash
mkdir -p files && cp ~/test.png files/
docker compose --profile tools run --rm -e CONFIRM=yes spike node src/send-test.mjs \
  "https://www.linkedin.com/messaging/thread/<THREAD_ID>/" "Bridge test 👋" /app/files/test.png
```
Use a thread with yourself or a colleague.

> While scripts run, they open their own tab. Live View keeps showing your tab; use the tab dropdown to watch theirs.

## 5. Persistence test

```bash
docker compose restart browser liveview
docker compose --profile tools run --rm spike node src/check.mjs   # still logged in?
```
Repeat after 24 h and 72 h. Also try a VM reboot.

---

## Exit criteria

| # | Check | Pass? |
|---|---|---|
| 1 | Teammate logs in through Live View incl. 2FA, without help | ☐ |
| 2 | Exit IP is the expected one; WebRTC shows no other IP (open `browserleaks.com/webrtc` in Live View) | ☐ |
| 3 | Session survives container restart, VM reboot, and 72 h | ☐ |
| 4 | `record.mjs` captures conversation list + messages as JSON | ☐ |
| 5 | A new incoming message arrives as a realtime event (SSE or WS) within seconds | ☐ |
| 6 | `send-test.mjs` sends text **and** an image; both appear on LinkedIn mobile | ☐ |
| 7 | No security checkpoint during the week | ☐ |
| 8 | Live View feels responsive for 3–5 simultaneous viewers | ☐ |

## Troubleshooting

- **Live View blank:** `docker compose exec browser curl -s 127.0.0.1:9222/json/list` should list a tab. If it's empty, check `docker compose logs browser`.
- **Chrome won't start / profile lock:** `start.sh` clears stale `Singleton*` locks. If it still fails, check that the volume is owned by uid 1000.
- **Checkpoint/captcha:** solve it in Live View, then let the account rest for a day before running scripts again.
- **Selectors in `send-test.mjs` don't match:** inspect the composer in Live View and update the role/label selectors.
