#!/usr/bin/env bash
# Run INSIDE the VM (as root): installs Docker + hardening.
#   sudo bash infra/proxmox/setup-vm.sh
#
# Optional settings (environment variables):
#   GATEWAY_IP=10.10.10.51        LinkUnify sits behind a gateway (APISIX, nginx…): only that address may open
#                                 connections to port 80; port 443 is closed (TLS ends at the gateway).
#   SSH_ALLOW="10.0.0.5 10.0.0.6" Only these addresses/CIDRs may use SSH (default: anyone).
#   DRY_RUN=1                     Print the firewall rules instead of applying anything.
#
# Docker publishes ports through its own iptables chains, which bypass ufw's normal rules. The gateway
# rules therefore go into Docker's DOCKER-USER chain via /etc/ufw/after.rules, so they survive reboots and
# `ufw reload`. Never install iptables-persistent here: it removes ufw.
set -euo pipefail

GATEWAY_IP=${GATEWAY_IP:-}
SSH_ALLOW=${SSH_ALLOW:-}
DRY_RUN=${DRY_RUN:-}
MARK_BEGIN='# BEGIN LINKUNIFY DOCKER-USER'
MARK_END='# END LINKUNIFY DOCKER-USER'

# The DOCKER-USER rules for "behind a gateway". Only traffic arriving on the external interface is
# filtered, so the browsers' own outgoing connections (e.g. HTTPS to LinkedIn) and their replies pass.
docker_user_rules() {
  local ext_if="$1" gw="$2"
  cat <<RULES
$MARK_BEGIN
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i $ext_if -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -s $gw -j RETURN
-A DOCKER-USER -i $ext_if -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j DROP
-A DOCKER-USER -i $ext_if -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j DROP
-A DOCKER-USER -j RETURN
COMMIT
$MARK_END
RULES
}

ext_interface() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}'
}

if [ -n "$DRY_RUN" ]; then
  [ -n "$GATEWAY_IP" ] && docker_user_rules "${EXT_IF:-$(ext_interface || echo eth0)}" "$GATEWAY_IP"
  echo "# ssh allowed from: ${SSH_ALLOW:-anywhere}"
  exit 0
fi

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

# Firewall (host ports): SSH + web.
ufw default deny incoming
ufw default allow outgoing
if [ -n "$SSH_ALLOW" ]; then
  for src in $SSH_ALLOW; do ufw allow from "$src" to any port 22 proto tcp; done
else
  ufw allow 22/tcp
fi
ufw allow 80/tcp
[ -z "$GATEWAY_IP" ] && ufw allow 443/tcp

# Firewall (Docker-published ports) when behind a gateway.
if [ -n "$GATEWAY_IP" ]; then
  EXT_IF=${EXT_IF:-$(ext_interface)}
  [ -n "$EXT_IF" ] || { echo "Could not detect the external interface; set EXT_IF=…" >&2; exit 1; }
  # Replace our block (idempotent), keep everything else in after.rules.
  sed -i "/^$MARK_BEGIN\$/,/^$MARK_END\$/d" /etc/ufw/after.rules
  docker_user_rules "$EXT_IF" "$GATEWAY_IP" >> /etc/ufw/after.rules
  echo "Gateway mode: port 80 only from $GATEWAY_IP on $EXT_IF; 443 closed."
fi
ufw --force enable
ufw reload

# Automatic security updates
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "✅ VM ready. Next: cd /opt/linkunify && ./scripts/install.sh"
[ -n "$GATEWAY_IP" ] && echo "   Check: sudo iptables -L DOCKER-USER -n --line-numbers (5 rules)"
exit 0
