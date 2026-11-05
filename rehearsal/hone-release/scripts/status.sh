#!/bin/bash
# hone-release action: status. Prints the release state and the last run record. No secret is read or printed.
set -u
STATE=/var/lib/hone-release/state
[ "${HONE_RELEASE_ACTION:-}" = status ] || { echo "STOP: not started by the launcher for the status action" >&2; exit 1; }
echo "state: $(cat "$STATE/APPLY-STATE" 2>/dev/null || echo none)"
echo "consumed approvals: $(ls "$STATE/consumed" 2>/dev/null | tr '\n' ' ')"
if [ -f /etc/hone-release/APPROVED-PACKAGE ]; then
  echo "approved package: $(grep -E '^(approval_id|head|first|last|count|expires_at)=' /etc/hone-release/APPROVED-PACKAGE | tr '\n' ' ')"
else echo "approved package: none"; fi
last=$(ls -dt /var/lib/hone-release/logs/*/ 2>/dev/null | head -1)
[ -n "$last" ] && [ -f "${last}run.txt" ] && { echo "last run record (${last}):"; sed -E 's#postgres(ql)?://[^ ]*#<url>#g' "${last}run.txt"; }
exit 0
