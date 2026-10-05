#!/usr/bin/env bash
# Run INSIDE the VM (as root): installs Docker + hardening.
#   sudo bash infra/proxmox/setup-vm.sh
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl ufw fail2ban unattended-upgrades qemu-guest-agent openssl
systemctl enable --now qemu-guest-agent

# Docker
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl restart docker
id linkunify >/dev/null 2>&1 && usermod -aG docker linkunify

# Firewall: only SSH + web. (Also restrict SSH to your admin IP in the Proxmox firewall.)
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Automatic security updates
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "✅ VM ready. Next: cd /opt/linkunify && ./scripts/install.sh"
