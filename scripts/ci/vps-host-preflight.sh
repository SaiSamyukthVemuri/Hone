#!/usr/bin/env bash
# Read-only. Run on the VPS host, not inside a runner. No sudo escalation,
# package installation, runner registration, service restart or Docker writes.
set -euo pipefail
export LC_ALL=C
printf '\nHost: '; hostname
printf 'UTC: '; date -u +%FT%TZ
printf 'Kernel: '; uname -r
printf '\n--- Capacity ---\n'
df -h / /srv/hone
free -h
printf '\n--- Existing workloads (preserve these) ---\n'
docker ps --format 'table {{.Names}}\t{{.Status}}'
printf '\n--- Isolation prerequisites ---\n'
printf 'Virtualization: '; systemd-detect-virt || true
test ! -e /dev/kvm || ls -l /dev/kvm
if command -v lxc >/dev/null 2>&1; then
  lxc version
  lxc project list --format csv -c n
else
  printf 'LXD is not installed or lxc is not on PATH\n'
fi
printf '\n--- Admission calculation for ONE runner ---\n'
# Bytes throughout: an 80 GiB host reserve plus a 30 GiB runner budget.
# This is a proposed conservative budget, not a measured peak or a quota.
available=$(df -B1 --output=avail /srv/hone | tail -n 1 | tr -d ' ')
required=$((110 * 1024 * 1024 * 1024))
printf 'Available bytes: %s\nRequired bytes before starting: %s\n' "$available" "$required"
if (( available < required )); then
  printf 'BLOCKED: less than the 80 GiB reserve plus 30 GiB pilot budget. Do not delete or prune to make room automatically.\n'
  exit 2
fi
printf 'Disk admission passes. Isolation, image tools, network policy and runner access still need qualification.\n'
