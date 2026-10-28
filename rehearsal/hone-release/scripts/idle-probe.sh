#!/bin/bash
# hone-release action: idle-probe (E4 option (a), "idle proof"). READ-ONLY with the read token, through the ONE pinned helper (mgmt-read.py: provider read-only query endpoint,
# no CLI, no database password, no login role). The proof is WAL evidence (Insurance FX3), evaluated by the pinned wal-evidence.py (a port of Machines' reviewed
# wal-evidence.mjs) over TWO samples of the Insurance-approved pitr-wal-status.sql (byte-identical, sha256-pinned) taken max(600, archive_timeout + 180) seconds apart, and the S0a
# record captured earlier by the wal-capture action (state/S0A-WAL.json): the LSNs, the archiver counters and the WAL position must be equal across both samples and to S0a,
# the archiver healthy, no completed segment waiting. The user-table write counter is recorded as well (the apply also requires it to equal the one typed from S0a).
# On the hosted provider a WAL switch is forced about every 4 minutes, so equal LSNs may never hold and this path then stays CLOSED/FAIL: heartbeat is the other option.
set -u
umask 077
REFFILE=/etc/hone-release/PROJECT-REF
STATE=/var/lib/hone-release/state
MANIFEST=/usr/local/libexec/hone-release/manifest
SLACK=5
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = idle-probe ] || die "not started by the launcher for the idle-probe action"
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
[ -f "$REFFILE" ] && [ ! -L "$REFFILE" ] && [ "$(stat -c %u "$REFFILE")" = 0 ] && [ $(( 8#$(stat -c %a "$REFFILE") & 8#022 )) = 0 ] || die "PROJECT-REF is missing or not root-owned"
REF=$(head -n 1 "$REFFILE"); printf '%s' "$REF" | grep -Eq '^[a-z0-9-]{10,20}$' || die "PROJECT-REF is malformed"
pinned() { # pinned NAME -> the path of a manifest-pinned file, sha256-checked
  local line msha mpath; line=$(awk -v n="$1" '$1 == n {print $2 " " $3}' "$MANIFEST" 2>/dev/null); msha=${line% *}; mpath=${line#* }
  [ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || return 9
  printf '%s' "$mpath"
}
HELPER=$(pinned mgmt-read) || die "the mgmt-read helper is missing or differs from the manifest sha256"
EVAL=$(pinned wal-evidence) || die "the wal-evidence evaluator is missing or differs from the manifest sha256"
mgmt() { HONE_READ_TOKEN="$TOKEN" python3 -I "$HELPER" "$REF" "$@"; }
S0A="$STATE/S0A-WAL.json"
[ -f "$S0A" ] && [ ! -L "$S0A" ] || die "no S0a WAL record: run the wal-capture action at S0a first (the proof compares the two samples with it)"
WORK=$(mktemp -d /var/lib/hone-release/work/idle.XXXXXX) || die "no work dir"
t1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mgmt pitr-wal > "$WORK/s1.json" 2> "$WORK/err.txt" || { TOKEN=""; die "the first WAL sample failed"; }
gap=$(python3 -I "$EVAL" --gap-for "$WORK/s1.json" 2>/dev/null) || gap=-1
[ "$gap" -ge 1 ] 2>/dev/null || { TOKEN=""; die "CLOSED: archive_timeout is 0, unknown or above 1200 s, or the sample is unreadable: the idle path cannot be evidenced"; }
sleep $((gap + SLACK))
t2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mgmt pitr-wal > "$WORK/s2.json" 2>> "$WORK/err.txt" && mgmt writes > "$WORK/w.json" 2>> "$WORK/err.txt" || { TOKEN=""; die "the second WAL sample failed"; }
TOKEN=""; unset TOKEN
python3 -I "$EVAL" --s1 "$WORK/s1.json" --s2 "$WORK/s2.json" --s0a "$S0A" > "$WORK/verdict.json" 2>/dev/null; vrc=$?
w=$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); r=r if isinstance(r,list) else r.get("rows",r.get("result",[])); print(r[0]["writes"])' "$WORK/w.json" 2>/dev/null) || w=x
printf '%s' "$w" | grep -Eq '^[0-9]+$' || die "the write counter is unreadable"
verdict=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["verdict"] + (":" + ",".join(v["failed"][:6]).replace(" ","") if v["failed"] else ""))' "$WORK/verdict.json" 2>/dev/null) || verdict=UNREADABLE
res=active; wal="no:$verdict"; [ "$vrc" = 0 ] && { res=idle; wal=ok; }
line="IDLE-PROOF result=$res first_at=$t1 second_at=$t2 seconds=$gap wal=$wal writes=$w"
printf '%s\n' "$line" > "$STATE/IDLE-PROOF.tmp" && mv -f "$STATE/IDLE-PROOF.tmp" "$STATE/IDLE-PROOF"
cp "$WORK/verdict.json" "$STATE/IDLE-VERDICT.json" 2>/dev/null
echo "$line"
[ "$res" = idle ] || die "the database is NOT proven idle by WAL evidence (verdict $verdict): the quiet-database option is closed for this stage; use quiet_db=heartbeat"
