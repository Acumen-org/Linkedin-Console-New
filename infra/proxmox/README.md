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
scp -r infra/proxmox root@proxmox:/root/linkunify-proxmox
ssh root@proxmox
cd /root/linkunify-proxmox
VMID=210 CORES=8 MEMORY_MB=32768 ./create-vm.sh
```

Sizing: about 0.5 GB RAM per LinkedIn account plus ~1 GB for the app and OS headroom. 32 GB is comfortable for ~30 accounts (see docs/operations.md → Resource usage).

## 3. Install (inside the VM)

```bash
ssh linkunify@<vm-ip>
sudo mkdir -p /opt/linkunify && sudo chown linkunify /opt/linkunify
# copy the project here (git clone, or scp -r from your PC)
cd /opt/linkunify
sudo bash infra/proxmox/setup-vm.sh
newgrp docker
./scripts/install.sh
```

## 4. Hardening checklist

- Proxmox UI (8006) and SSH reachable only from your admin IP or a VPN (WireGuard/Tailscale), never the open internet.
- Enable the Proxmox firewall on the VM: allow 80/443 from anywhere, 22 from your admin IP only.
- Nightly backups: Proxmox Backup Server snapshot of the VM **and** `scripts/backup.sh` (database + files + browser profiles) copied off-site.
- UPS for the Comcast modem + Proxmox host.
