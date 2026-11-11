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
if command -v snap >/dev/null 2>&1 &&
   timeout 10s snap list lxd >/dev/null 2>&1 &&
   [ -x /snap/bin/lxc ]; then
  timeout 10s /snap/bin/lxc --force-local version
  timeout 10s /snap/bin/lxc --force-local project list --format csv -c n
else
  printf 'Installed LXD snap not confirmed; no LXC installer wrapper was invoked.\n'
  exit 2
fi
printf '\n--- Separate root and dedicated CI pool storage snapshot ---\n'
# No root-disk fallback, package install or automatic privilege escalation.
exec python3 -I "$(dirname -- "${BASH_SOURCE[0]}")/check-vps-storage.py"
