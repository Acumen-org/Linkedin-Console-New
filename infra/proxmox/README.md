# Proxmox + Comcast Business setup

## 1. Network (Comcast Business, static IP)

Your public IP is a Comcast Business static IP (ISP line, Chicago region). LinkedIn traffic from every account browser leaves through it, which looks like a normal office.

**Option A: a static block (/29 = 5 usable IPs)** (recommended)
- Comcast's gateway keeps one IP (usually the highest usable). Give the VM one of the others directly:
  `IPCONFIG="ip=<free-ip>/29,gw=<comcast-gateway-ip>" ./create-vm.sh` (VM on `vmbr0`, bridged to the Comcast gateway).
- No NAT needed. Point DNS at that IP.

**Option B: a single static IP**
- Keep the VM on your LAN (`IPCONFIG="ip=dhcp"` or a fixed LAN IP).
- In the Comcast gateway admin page: **port-forward TCP 80 and 443 → the VM's LAN IP**.
- Point DNS at the public IP.

DNS: create `A  inbox.yourcompany.com → <public IP>`. Caddy gets the HTTPS certificate automatically (needs port 80 reachable).

## 2. Create the VM (on the Proxmox host)

```bash
scp -r infra/proxmox root@proxmox:/root/linkedin-console-proxmox
ssh root@proxmox
cd /root/linkedin-console-proxmox
VMID=210 CORES=8 MEMORY_MB=32768 ./create-vm.sh
```

Sizing: about 0.5 GB RAM per LinkedIn account plus ~1 GB for the app and OS headroom. 32 GB is comfortable for ~30 accounts (see docs/operations.md → Resource usage).

## 3. Install (inside the VM)

```bash
ssh linkedin-console@<vm-ip>
sudo mkdir -p /opt/linkedin-console && sudo chown linkedin-console /opt/linkedin-console
# copy the project here (git clone, or scp -r from your PC)
cd /opt/linkedin-console
sudo bash infra/proxmox/setup-vm.sh
newgrp docker
./scripts/install.sh
```

**Behind a gateway** (APISIX, nginx… terminating TLS and forwarding to the VM on port 80):

```bash
sudo GATEWAY_IP=10.10.10.51 SSH_ALLOW="10.10.10.0/24" bash infra/proxmox/setup-vm.sh
```

- Only the gateway may open connections to port 80; 443 is closed. The rules go into Docker's `DOCKER-USER` chain (Docker-published ports bypass normal ufw rules) and are kept in `/etc/ufw/after.rules`, so they survive reboots. Safe to run again. Preview with `DRY_RUN=1`.
- In `.env` set `TRUSTED_PROXIES=10.10.10.51` and `SITE_ADDRESS=:80`, so login limits and the audit log see the real client IP instead of the gateway's.
- Check: `sudo iptables -L DOCKER-USER -n --line-numbers` (5 rules).

`install.sh` offers to schedule the nightly backup; later: `./scripts/schedule-backup.sh`.

## 4. Hardening checklist

- Proxmox UI (8006) and SSH reachable only from your admin IP or a VPN (WireGuard/Tailscale), never the open internet.
- Enable the Proxmox firewall on the VM: allow 80/443 from anywhere, 22 from your admin IP only.
- Nightly backups: Proxmox Backup Server snapshot of the VM **and** `scripts/backup.sh` (database + files + browser profiles; scheduled by `scripts/schedule-backup.sh`) copied off-site.
- New teammates get no account access by default (`DEFAULT_GRANT=NONE`); grant it per account. See [docs/rbac.md](../../docs/rbac.md).
- UPS for the Comcast modem + Proxmox host.
