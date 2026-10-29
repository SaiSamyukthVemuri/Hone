#!/bin/bash
# hone-release action: reconcile. READ-ONLY. After an UNKNOWN outcome (push killed or overdue, process died) it reads the migration history with the
# separate read-only token (Database Read, through the Management API's READ-ONLY query endpoint: no CLI, no database password, no login role) and classifies the approved
# range as NONE / ALL / PARTIAL. It writes RECONCILE in the release state, never clears APPLY-STATE (only root does), applies nothing and retries nothing.
set -u
umask 077
REFFILE=/etc/hone-release/PROJECT-REF
APPROVAL=/etc/hone-release/APPROVED-PACKAGE
STATE=/var/lib/hone-release/state
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = reconcile ] || die "not started by the launcher for the reconcile action"
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
for p in "$REFFILE" "$APPROVAL"; do [ -f "$p" ] && [ ! -L "$p" ] && [ "$(stat -c %u "$p")" = 0 ] && [ $(( 8#$(stat -c %a "$p") & 8#022 )) = 0 ] || die "$p is missing or not root-owned"; done
REF=$(head -n 1 "$REFFILE"); printf '%s' "$REF" | grep -Eq '^[a-z0-9-]{10,20}$' || die "PROJECT-REF is malformed"
FIRST=$(sed -n 's/^first=//p' "$APPROVAL" | head -1); LAST=$(sed -n 's/^last=//p' "$APPROVAL" | head -1); COUNT=$(sed -n 's/^count=//p' "$APPROVAL" | head -1)
printf '%s%s' "$FIRST" "$LAST" | grep -Eq '^[0-9]{8}$' && printf '%s' "$COUNT" | grep -Eq '^[0-9]{1,3}$' || die "the approved range is malformed"
WORK=$(mktemp -d /var/lib/hone-release/work/recon.XXXXXX) || die "no work dir"
MANIFEST=/usr/local/libexec/hone-release/manifest
mgmt() { # mgmt ID [args]   the ONE pinned read helper (mgmt-read.py): sha256-checked against the root-owned manifest; the token is only in its environment
  local line msha mpath; line=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null)
  msha=${line% *}; mpath=${line#* }
  [ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || { echo "the mgmt-read helper is missing or differs from the manifest sha256" >&2; return 9; }
  HONE_READ_TOKEN="$TOKEN" python3 -I "$mpath" "$REF" "$@"
}
rc=0
mgmt versions "$FIRST" "$LAST" > "$WORK/out.json" 2> "$WORK/err.txt" || rc=$?
TOKEN=""; unset TOKEN
if [ "$rc" != 0 ]; then tail -n 5 "$WORK/err.txt" | LC_ALL=C sed -E 's#[A-Za-z0-9.-]*\.supabase\.(com|co)[:0-9]*#<host>#g; s#(sbp_)[A-Za-z0-9]+#\1<masked>#g' >&2; die "the history read failed (exit $rc): the outcome stays UNKNOWN"; fi
python3 -I - "$WORK/out.json" "$STATE" "$FIRST" "$LAST" "$COUNT" <<'PY' || die "the history answer could not be classified: the outcome stays UNKNOWN"
import json, sys, os, time
raw = open(sys.argv[1]).read()
j = json.loads(raw)
rows = j if isinstance(j, list) else j.get("rows", j.get("result", []))
vs = sorted({str(r["version"]) for r in rows if isinstance(r, dict) and "version" in r})
first, last, count = sys.argv[3], sys.argv[4], int(sys.argv[5])
inrange = [v for v in vs if first <= v <= last]
res = "NONE" if not inrange else ("ALL" if len(inrange) == count else "PARTIAL")
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
line = "RECONCILE %s read_at=%s range=%s..%s expected=%d present=%d" % (res, now, first, last, count, len(inrange))
tmp = os.path.join(sys.argv[2], "RECONCILE.tmp")
open(tmp, "w").write(line + "\n"); os.replace(tmp, os.path.join(sys.argv[2], "RECONCILE"))
print(line)
print("This is a READ. It cleared nothing: only root clears APPLY-STATE, and nothing is retried. NONE = the approved range is absent; ALL = present; PARTIAL = stopped midway (each file is one transaction).")
PY
