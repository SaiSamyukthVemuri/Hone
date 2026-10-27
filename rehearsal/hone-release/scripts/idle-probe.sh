#!/bin/bash
# hone-release action: idle-probe (E4 option (a), "idle proof"). READ-ONLY with the read token. It samples the write counters of the user tables
# twice, IDLE_SECS apart, and records IDLE-PROOF (result=idle only if the two samples are equal). It proves "no row was written between the two
# samples"; it does NOT prove when the last write was. The apply compares the provider's latest recovery point with the approval's recovery_stamp.
set -u
umask 077
BIN=/usr/local/libexec/hone-release/bin/supabase-go
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
REFFILE=/etc/hone-release/PROJECT-REF
STATE=/var/lib/hone-release/state
IDLE_SECS=120
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = idle-probe ] || die "not started by the launcher for the idle-probe action"
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
[ -f "$REFFILE" ] && [ ! -L "$REFFILE" ] && [ "$(stat -c %u "$REFFILE")" = 0 ] && [ $(( 8#$(stat -c %a "$REFFILE") & 8#022 )) = 0 ] || die "PROJECT-REF is missing or not root-owned"
REF=$(head -n 1 "$REFFILE"); printf '%s' "$REF" | grep -Eq '^[a-z0-9-]{10,20}$' || die "PROJECT-REF is malformed"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch"
WORK=$(mktemp -d /var/lib/hone-release/work/idle.XXXXXX) || die "no work dir"
mkdir -p "$WORK/supabase/.temp" && printf '%s\n' v2.102.0 > "$WORK/supabase/.temp/cli-latest" && printf '%s' "$REF" > "$WORK/supabase/.temp/project-ref"
SQL="select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text as writes from pg_stat_user_tables"
sample() { ( cd "$WORK" && SUPABASE_ACCESS_TOKEN="$TOKEN" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$BIN" db query --linked -o json "$SQL" ) </dev/null 2> "$WORK/err.txt" | python3 -I -c 'import json,sys; j=json.load(sys.stdin); r=j if isinstance(j,list) else j.get("rows",j.get("result",[])); print(r[0]["writes"])'; }
t1=$(date -u +%Y-%m-%dT%H:%M:%SZ); a=$(sample) || { TOKEN=""; die "the first sample failed"; }
sleep "$IDLE_SECS"
t2=$(date -u +%Y-%m-%dT%H:%M:%SZ); b=$(sample) || { TOKEN=""; die "the second sample failed"; }
TOKEN=""; unset TOKEN
printf '%s%s' "$a" "$b" | grep -Eq '^[0-9]+$' || die "the samples are not numbers"
res=active; [ "$a" = "$b" ] && res=idle
line="IDLE-PROOF result=$res first_at=$t1 second_at=$t2 seconds=$IDLE_SECS"
printf '%s\n' "$line" > "$STATE/IDLE-PROOF.tmp" && mv -f "$STATE/IDLE-PROOF.tmp" "$STATE/IDLE-PROOF"
echo "$line"
[ "$res" = idle ] || die "the write counters moved between the samples: the database is NOT idle"
