#!/bin/bash
# hone-release action: wal-capture. READ-ONLY (read token, pinned helper). Run at S0a: stores ONE sample of the Insurance-approved pitr-wal-status.sql as state/S0A-WAL.json, the
# record the idle-probe compares its two samples with. Nothing is written to the database.
set -u
umask 077
REFFILE=/etc/hone-release/PROJECT-REF; STATE=/var/lib/hone-release/state; MANIFEST=/usr/local/libexec/hone-release/manifest
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = wal-capture ] || die "not started by the launcher for the wal-capture action"
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
[ -f "$REFFILE" ] && [ ! -L "$REFFILE" ] && [ "$(stat -c %u "$REFFILE")" = 0 ] && [ $(( 8#$(stat -c %a "$REFFILE") & 8#022 )) = 0 ] || die "PROJECT-REF is missing or not root-owned"
REF=$(head -n 1 "$REFFILE"); printf '%s' "$REF" | grep -Eq '^[a-z0-9-]{10,20}$' || die "PROJECT-REF is malformed"
line=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null); msha=${line% *}; mpath=${line#* }
[ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || die "the mgmt-read helper is missing or differs from the manifest sha256"
HONE_READ_TOKEN="$TOKEN" python3 -I "$mpath" "$REF" pitr-wal > "$STATE/S0A-WAL.json.tmp" 2> "$STATE/S0A-WAL.err" || { TOKEN=""; rm -f "$STATE/S0A-WAL.json.tmp"; die "the WAL read failed (a permission denial closes the idle path; it is not retried here)"; }
TOKEN=""; unset TOKEN
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(r,list) and len(r)==1 else 1)' "$STATE/S0A-WAL.json.tmp" || { rm -f "$STATE/S0A-WAL.json.tmp"; die "the answer is not exactly one row"; }
mv -f "$STATE/S0A-WAL.json.tmp" "$STATE/S0A-WAL.json"
echo "S0A-WAL.json recorded at $(date -u +%Y-%m-%dT%H:%M:%SZ) (sha256 $(sha256sum "$STATE/S0A-WAL.json" | cut -d' ' -f1)); run idle-probe within 30 minutes."
