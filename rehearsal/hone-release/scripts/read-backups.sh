#!/bin/bash
# hone-release action: read-backups. A READ with the separate read-only personal access token (Database Read + Backups Read) on
# fd 3. It never sees the database password and the apply action never sees this token. The token reaches only the one CLI child.
set -u
umask 077
REFFILE=/etc/hone-release/PROJECT-REF
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = read-backups ] || die "not started by the launcher for the read-backups action"
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
[ -f "$REFFILE" ] && [ ! -L "$REFFILE" ] && [ "$(stat -c %u "$REFFILE")" = 0 ] && [ $(( 8#$(stat -c %a "$REFFILE") & 8#022 )) = 0 ] || die "PROJECT-REF is missing or not root-owned"
REF=$(head -n 1 "$REFFILE")
printf '%s' "$REF" | grep -Eq '^[a-z0-9]{20}$' || die "PROJECT-REF is malformed"
WORK=$(mktemp -d /var/lib/hone-release/work/read.XXXXXX) || die "no work dir"
MANIFEST=/usr/local/libexec/hone-release/manifest
mgmt() { # mgmt ID [args]   the ONE pinned read helper (mgmt-read.py): sha256-checked against the root-owned manifest; the token is only in its environment
  local line msha mpath; line=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null)
  msha=${line% *}; mpath=${line#* }
  [ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || { echo "the mgmt-read helper is missing or differs from the manifest sha256" >&2; return 9; }
  HONE_READ_TOKEN="$TOKEN" python3 -I "$mpath" "$REF" "$@"
}
rc=0
mgmt backups > "$WORK/out.json" 2> "$WORK/err.txt"
TOKEN=""; unset TOKEN
if [ "$rc" != 0 ]; then tail -n 5 "$WORK/err.txt" | LC_ALL=C sed -E 's#[A-Za-z0-9.-]*\.supabase\.(com|co)[:0-9]*#<host>#g; s#(sbp_)[A-Za-z0-9]+#\1<masked>#g' >&2; die "the backups read failed (exit $rc)"; fi
cat "$WORK/out.json"
# C: the custody layer records WHAT THE PROVIDER SAID, timestamped, in state only hone-release can write. The apply STOPs unless this
# record shows the recovery evidence the unattended path needs. Nothing here calls the restore-point endpoint (it is never a target).
STATE=/var/lib/hone-release/state
python3 -I - "$WORK/out.json" "$STATE" <<'PYEV' || die "the backups answer could not be turned into the evidence record"
import json, sys, time, os
j = json.load(open(sys.argv[1]))
st = sys.argv[2]
d = j.get("physical_backup_data") or {}
lo, hi = d.get("earliest_physical_backup_date_unix"), d.get("latest_physical_backup_date_unix")
pitr = bool(j.get("pitr_enabled"))
now = int(time.time())
iso = lambda u: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(u))
ok = pitr and isinstance(lo, int) and isinstance(hi, int) and lo > 0 and hi >= lo and hi <= now + 60
lines = ["read_at=" + iso(now), "pitr_enabled=" + ("true" if pitr else "false")]
if ok:
    lines += ["earliest=" + iso(lo), "latest=" + iso(hi), "span_seconds=%d" % (hi - lo)]
else:
    lines += ["earliest=none", "latest=none", "span_seconds=0"]
tmp = os.path.join(st, "BACKUPS-EVIDENCE.tmp")
with open(tmp, "w") as f:
    f.write("\n".join(lines) + "\n"); f.flush(); os.fsync(f.fileno())
os.replace(tmp, os.path.join(st, "BACKUPS-EVIDENCE"))
print("evidence recorded: " + " ".join(lines), file=sys.stderr)
PYEV
