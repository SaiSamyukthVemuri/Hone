#!/bin/bash
# Run as ROOT by the person doing the OPS READ-BACK STEP (flow item 7, serving-source compatibility). The launcher cannot read the served commit: the app's own
# /api/admin/runtime needs an admin login, and no anonymous route reports it. The read is a Vercel read that OPS already does through its connector:
#   production alias (hone.care) -> the deployment it currently points to -> that deployment's git commit sha and READY state.
# This script records exactly those typed values, root-owned, for the `verify` action to compare with the approval's serving_commit. usage:
#   bind-serving.sh commit=<40 hex> deployment=<deployment id> alias_host=<host> observed_at=<UTC>
# observed_at is when OPS read the alias/deployment (must be after the push and at most 30 minutes before verify).
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
declare -A V
for kv in "$@"; do case "$kv" in *=*) ;; *) echo "arguments are key=value" >&2; exit 1 ;; esac; k=${kv%%=*}; case " commit deployment alias_host observed_at " in *" $k "*) ;; *) echo "unknown argument: $k" >&2; exit 1 ;; esac; [ -z "${V[$k]+x}" ] || { echo "repeated argument: $k" >&2; exit 1; }; V[$k]=${kv#*=}; done
for k in commit deployment alias_host observed_at; do [ -n "${V[$k]+x}" ] && [ -n "${V[$k]}" ] || { echo "missing argument: $k" >&2; exit 1; }; done
printf '%s' "${V[commit]}" | grep -Eq '^[0-9a-f]{40}$' || { echo "commit must be the full 40-hex sha" >&2; exit 1; }
printf '%s' "${V[deployment]}" | grep -Eq '^[A-Za-z0-9_-]{8,64}$' || { echo "deployment id is malformed" >&2; exit 1; }
printf '%s' "${V[alias_host]}" | grep -Eq '^[a-z0-9.-]{3,80}$' || { echo "alias_host is malformed" >&2; exit 1; }
printf '%s' "${V[observed_at]}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || { echo "observed_at must be UTC YYYY-MM-DDTHH:MM:SSZ" >&2; exit 1; }
id=$(sed -n 's/^approval_id=//p' /etc/hone-release/APPROVED-PACKAGE | head -1)
tmp=$(mktemp /etc/hone-release/.sv.XXXXXX)
{ echo "approval_id=$id"; echo "commit=${V[commit]}"; echo "deployment=${V[deployment]}"; echo "alias_host=${V[alias_host]}"; echo "observed_at=${V[observed_at]}"; echo "source=vercel-alias-to-deployment-read-by-OPS"; echo "bound_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > "$tmp"
chown root:root "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" /etc/hone-release/SERVING-READBACK
echo "SERVING-READBACK written for approval $id: alias ${V[alias_host]} -> deployment ${V[deployment]} -> commit ${V[commit]} (observed ${V[observed_at]})"
