#!/usr/bin/env bash
# Run on the PROXMOX HOST (as root). Creates an Ubuntu 24.04 VM for LinkUnify from the official cloud image.
#   VMID=210 IPCONFIG="ip=dhcp" ./create-vm.sh
# For a static IP from your Comcast block, e.g.:
#   IPCONFIG="ip=203.0.113.163/29,gw=203.0.113.166" ./create-vm.sh
set -euo pipefail

VMID=${VMID:-210}
NAME=${NAME:-linkunify}
CORES=${CORES:-8}
MEMORY_MB=${MEMORY_MB:-32768}      # ~0.5 GB per LinkedIn account + headroom (see docs/operations.md)
DISK=${DISK:-150G}
STORAGE=${STORAGE:-local-lvm}
BRIDGE=${BRIDGE:-vmbr0}
IPCONFIG=${IPCONFIG:-ip=dhcp}
SSH_KEYS=${SSH_KEYS:-/root/.ssh/authorized_keys}
IMG=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img

[ -f "$IMG" ] || wget -O "$IMG" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

qm create "$VMID" --name "$NAME" --ostype l26 --cpu host --cores "$CORES" --memory "$MEMORY_MB" \
  --net0 "virtio,bridge=${BRIDGE},firewall=1" --scsihw virtio-scsi-single --agent enabled=1 \
  --serial0 socket --vga serial0
qm set "$VMID" --scsi0 "${STORAGE}:0,import-from=${IMG},discard=on,ssd=1,iothread=1"
qm resize "$VMID" scsi0 "$DISK"
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" --boot order=scsi0
qm set "$VMID" --ciuser linkunify --sshkeys "$SSH_KEYS" --ipconfig0 "$IPCONFIG" --nameserver 1.1.1.1
qm set "$VMID" --onboot 1
qm start "$VMID"

echo "VM $VMID started. SSH in as 'linkunify', copy the project to /opt/linkunify, then run:"
echo "  sudo bash /opt/linkunify/infra/proxmox/setup-vm.sh"
