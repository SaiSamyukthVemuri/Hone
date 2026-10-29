#!/bin/bash
# Run as ROOT, by the approver, AFTER reading the GO/NO-GO package THEMSELVES AS ROOT (sudo cat /var/lib/hone-release/state/GONOGO.json); type the "sha256" field from THAT read, never a value copied from the agent's output. usage: bind-gonogo.sh gonogo_sha=<64 hex typed from the package you read>
# It re-hashes state/GONOGO.json, requires verdict GO and that the package is about the CURRENT APPROVED-PACKAGE, prints the checks, and writes
# /etc/hone-release/GONOGO-BOUND (root:root 644). The apply refuses without a fresh binding (30 minutes) that names this approval and this package sha.
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ $# = 1 ] && case "$1" in gonogo_sha=*) ;; *) false ;; esac || { echo "usage: bind-gonogo.sh gonogo_sha=<64 hex>" >&2; exit 1; }
typed=${1#gonogo_sha=}; printf '%s' "$typed" | grep -Eq '^[0-9a-f]{64}$' || { echo "the sha must be the FULL 64-hex value printed in the GO/NO-GO package" >&2; exit 1; }
G=/var/lib/hone-release/state/GONOGO.json; A=/etc/hone-release/APPROVED-PACKAGE
[ -f "$G" ] && [ ! -L "$G" ] && [ -f "$A" ] && [ ! -L "$A" ] || { echo "no GONOGO.json or no APPROVED-PACKAGE" >&2; exit 1; }
res=$(python3 -I - "$G" "$A" "$typed" <<'PY'
import json, sys, hashlib
j = json.load(open(sys.argv[1])); sh = j.pop("sha256", "")
canon = json.dumps(j, sort_keys=True, separators=(",", ":"))
asha = hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
bad = []
if hashlib.sha256(canon.encode()).hexdigest() != sh: bad.append("the package's own sha256 does not verify (it was altered)")
if sh != sys.argv[3]: bad.append("the typed sha256 is not this package's sha256")
if j.get("verdict") != "GO": bad.append("the verdict is %s: %s" % (j.get("verdict"), j.get("reason")))
if j.get("approval_sha256") != asha: bad.append("the package is about a different approval record than the current APPROVED-PACKAGE")
for c in j.get("checks", []): print("  %-5s %-18s %s" % (c["result"], c["name"], c["detail"]))
print("BAD:" + "; ".join(bad) if bad else "OK:" + j["approval_id"])
PY
)
printf '%s\n' "$res" | sed '$d'
last=$(printf '%s\n' "$res" | tail -n 1)
case "$last" in OK:*) id=${last#OK:} ;; *) echo "REFUSED: ${last#BAD:}; nothing was bound" >&2; exit 1 ;; esac
tmp=$(mktemp /etc/hone-release/.gb.XXXXXX)
{ echo "gonogo_sha=$typed"; echo "approval_id=$id"; echo "bound_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > "$tmp"
chown root:root "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" /etc/hone-release/GONOGO-BOUND
echo "GONOGO-BOUND written for approval $id (valid 30 minutes). The typed sha256 matched the package on disk as read by root."
