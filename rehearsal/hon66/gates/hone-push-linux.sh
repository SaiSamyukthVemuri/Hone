#!/usr/bin/env bash
# hone-push-linux.sh (HON66-LINUX-GATES, Linux x86_64). REHEARSAL-PROVEN ONLY; a hosted push needs the operator's per-change,
# exact-stage authorization. It replaces the manual yes/yes: readiness is MACHINE-CHECKED and the push is refused unless every
# check passes. It is also the RESUME path: there is no separate resume flag, because the state is always re-derived.
#
#   1. RECONCILE (read only): history (supabase_migrations.schema_migrations, version >= FIRST) must be a contiguous PREFIX of
#      the expected list; the CLI dry run must list exactly the remaining suffix. Anything else = REFUSE (never "fix" by pushing).
#      history == whole list -> "already complete", exit 0, nothing pushed.
#   2. IN-FLIGHT: two polls 3 s apart must both show NO active postgres-role backend besides this session and an unchanged
#      history; a killed client can leave its server statement running, so a possibly-applied file is never re-pushed blind.
#   3. CANARY: a guard with a short limit must cancel a pg_sleep canary on the SAME role and path -> proves the guard can act.
#   4. GUARD at the real limit, first heartbeat observed, then the push. The CLI applies only pending files natively and each
#      file is one atomic transaction.
#   5. AFTER (always, also after a signal): history re-read, PREFIX/COMPLETE verdict, and the guard's coverage evidence:
#      polls inside the push interval and blind polls. Signals (INT/TERM/HUP) are recorded and do NOT kill the push or the
#      guard (killing the client does not stop a running statement); the wrapper waits for the push to end, then reports.
#
# RESUME IS A DELIBERATE, REVIEWED EXCEPTION to the no-retry rule (HON66-PROOF M6). A run that ends with an unknown outcome leaves
# IN-FLIGHT; the next run may proceed ONLY through the reconcile rules above (clean contiguous prefix, dry run == remaining suffix, nothing
# non-idle on the postgres role twice, history unchanged) and records itself against the same --approval-id. It is never a blind re-push,
# and it never bypasses FAILED-LOGIN: any authentication failure writes FAILED-LOGIN and every later run refuses (no login storm).
# The password arrives on FD 3 (opened by hone-release); it is never a file this script opens, never argv, never printed.
# Usage: hone-push-linux.sh --go PATH --url-base postgresql://user@host:port/postgres?sslmode=require --workdir DIR --expected FILE \
#          --approval-id ID [--tombstone-dir DIR] [--limit 120] [--every 2] [--first 0213] [--state-dir DIR]  3< password-source
set -u
GO=; URLBASE=; WD=; EXP=; LIMIT=120; EVERY=2; FIRST=0213; SD=; APPROVAL=; TD="$HOME/hone-s1/hon66-push"
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=$2; shift 2 ;; --url-base) URLBASE=$2; shift 2 ;; --workdir) WD=$2; shift 2 ;; --expected) EXP=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;; --every) EVERY=$2; shift 2 ;; --first) FIRST=$2; shift 2 ;; --approval-id) APPROVAL=$2; shift 2 ;; --tombstone-dir) TD=$2; shift 2 ;; --state-dir) SD=$2; shift 2 ;;
    *) echo "PUSH: unknown argument" >&2; exit 2 ;;
  esac
done
refuse() { echo "PUSH REFUSED: $1"; exit 2; }
[ -x "$GO" ] && [ -d "$WD/supabase/migrations" ] && [ -f "$EXP" ] && [ -n "$URLBASE" ] || refuse "--go, --url-base, --workdir (with supabase/migrations) and --expected are required"
[ "$(sha256sum -- "$GO" | cut -d' ' -f1)" = "$GOSHA" ] || refuse "the supabase binary is not the pinned linux_amd64 2.102.0 build"
case "$FIRST$LIMIT$EVERY" in *[!0-9]*|'') refuse "--first/--limit/--every must be digits" ;; esac
[ -r "$HERE/hone-push-guard.sh" ] || refuse "hone-push-guard.sh must sit beside this script"
case "$APPROVAL" in ''|*[!A-Za-z0-9._-]*) refuse "--approval-id (letters, digits, . _ -) is required" ;; esac
[ ! -e "$TD/FAILED-LOGIN" ] || refuse "FAILED-LOGIN exists in $TD ($(head -c 160 "$TD/FAILED-LOGIN")). Nothing attempted. Only the operator clears it."
UI=${URLBASE#*://}; UI=${UI%%@*}; case "$UI" in *:*) refuse "--url-base must not carry a password" ;; esac
{ true <&3; } 2> /dev/null || refuse "fd 3 is not open (hone-release passes the database password on fd 3)"
PGPASSWORD=""; IFS= read -r -n 4097 <&3 PGPASSWORD || [ -n "$PGPASSWORD" ] || refuse "could not read the password from fd 3"
if IFS= read -r -t 1 -n 1 _x <&3; then refuse "fd 3 holds more than one line or more than 4096 bytes"; fi
exec 3<&-
[ -n "$PGPASSWORD" ] && [ "${#PGPASSWORD}" -le 4096 ] || refuse "the password on fd 3 is empty or longer than 4096 bytes"
export PGPASSWORD SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN SUPABASE_ACCESS_TOKEN
[ -n "$SD" ] || SD=$(mktemp -d "${TMPDIR:-/tmp}/hone-push.XXXXXX")
mkdir -p -m 700 "$TD" "$SD" "$SD/supabase/.temp"; printf 'v2.102.0\n' > "$SD/supabase/.temp/cli-latest"
mkdir -p "$WD/supabase/.temp"; printf 'v2.102.0\n' > "$WD/supabase/.temp/cli-latest"
ERR="$SD/push.err"
RUNID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
rec() { printf '%s run=%s approval=%s %s\n' "$(date -u +%FT%TZ)" "$RUNID" "$APPROVAL" "$*" >> "$TD/RUN-RECORD"; }
authfail() { grep -qiE 'password authentication failed|28P01|28000|SASL' "$1" 2> /dev/null && { printf 'FAILED-LOGIN written by hone-push-linux at %s (run %s, approval %s). Do not retry; do not reset the password; report.\n' "$(date -u +%FT%TZ)" "$RUNID" "$APPROVAL" > "$TD/FAILED-LOGIN"; rec "FAILED-LOGIN"; return 0; }; return 1; }
rec "start (url-base host only: ${URLBASE#*@})"
[ ! -e "$TD/IN-FLIGHT" ] || { echo "RESUME: an earlier run left IN-FLIGHT ($(head -c 200 "$TD/IN-FLIGHT" | tr '\n' ' ')). This is the recorded, reviewed exception to no-retry: I proceed ONLY if every reconcile rule below holds."; rec "resume-of-in-flight"; }
q() { ( cd "$SD" && "$GO" --agent no db query --db-url "$URLBASE" -o json "$1" 2> "$ERR" ); }
jget() { python3 -I -c 'import json,sys
d=json.load(sys.stdin)
r=d[0] if isinstance(d,list) and d else (d.get("rows",[{}])[0] if isinstance(d,dict) else {})
print(r.get(sys.argv[1],""))' "$1"; }
now_ms() { date +%s%3N; }
EXPECTED=$(grep -E '^[0-9]{4}_[A-Za-z0-9_]+\.sql$' "$EXP" | sort | tr '\n' ' ')
NEXP=$(printf '%s' "$EXPECTED" | wc -w)
[ "$NEXP" -gt 0 ] || refuse "the expected list has no migration file names"
# the migrations dir must hold exactly the expected files at/after FIRST (nothing extra, nothing missing)
ONDISK=$(cd "$WD/supabase/migrations" && ls | grep -E '^[0-9]{4}_.*\.sql$' | awk -v f="$FIRST" '$0 >= f' | sort | tr '\n' ' ')
[ "$ONDISK" = "$EXPECTED" ] || refuse "the migrations directory at/after $FIRST is not exactly the expected list"

# history versions (comma list, sorted) >= FIRST; empty string when none
hist() { local out; out=$(q "select coalesce(string_agg(version, ',' order by version), '') as v from supabase_migrations.schema_migrations where version >= '$FIRST'") || return 1; printf '%s' "$out" | jget v; }
# does the history table exist? (a fresh project may have none; then history == empty)
H1=$(hist) || { authfail "$ERR"; refuse "cannot read the migration history through the pooler (nothing attempted)"; }
EXPV=$(for f in $EXPECTED; do printf '%s ' "${f%%_*}"; done)
# contiguous prefix?
k=0; ok=1; hv=$(printf '%s' "$H1" | tr ',' ' ')
for v in $hv; do
  want=$(printf '%s' "$EXPV" | awk -v i=$((k + 1)) '{print $i}')
  [ "$v" = "$want" ] || { ok=0; break; }
  k=$((k + 1))
done
[ "$ok" = 1 ] || refuse "the history at/after $FIRST is not a contiguous prefix of the expected list (found: $H1). Nothing pushed; this needs a human."
echo "RECONCILE: history holds the first $k of $NEXP expected files."
if [ "$k" = "$NEXP" ]; then rm -f "$TD/IN-FLIGHT"; rec "ALREADY-COMPLETE $k/$NEXP"; echo "RESULT: ALREADY-COMPLETE $k/$NEXP (nothing pushed)"; exit 0; fi
PENDING=$(printf '%s' "$EXPECTED" | awk -v k=$k '{for (i = k + 1; i <= NF; i++) printf "%s ", $i}')
DRY=$( cd "$WD" && "$GO" --agent no db push --db-url "$URLBASE" --dry-run 2>&1 ) || { printf '%s' "$DRY" > "$SD/dry.out"; authfail "$SD/dry.out"; refuse "the dry run failed: $(printf '%s' "$DRY" | tail -n 1 | cut -c1-120 | LC_ALL=C sed -E 's#postgres(ql)?://[^ ]*#<url>#g')"; }
DRYL=$(printf '%s\n' "$DRY" | grep -oE '[0-9]{4}_[A-Za-z0-9_]+\.sql' | sort -u | tr '\n' ' ')
[ "$DRYL" = "$PENDING" ] || refuse "the dry run does not list exactly the remaining $((NEXP - k)) files (listed: $(printf '%s' "$DRYL" | wc -w))"
echo "RECONCILE: the dry run lists exactly the remaining $((NEXP - k)) files."
# census + in-flight: NOTHING non-idle on the postgres role besides this session, twice, history unchanged
inflight() { q "select count(*) as n from pg_stat_activity where datname = 'postgres' and usename = 'postgres' and backend_type = 'client backend' and state <> 'idle' and pid <> pg_backend_pid()" | jget n; }
a=$(inflight) || refuse "cannot read pg_stat_activity"; sleep 3; b=$(inflight) || refuse "cannot read pg_stat_activity"; H2=$(hist) || refuse "cannot re-read history"
[ "$a" = 0 ] && [ "$b" = 0 ] && [ "$H2" = "$H1" ] || refuse "a postgres-role statement is active or the history moved (n=$a/$b): a previous push may still be running. Wait, then re-run; nothing was re-pushed."
echo "RECONCILE: no in-flight statement; history stable."

# canary: a short-limit guard must cancel a canary statement on the same role and path
CAN="$SD/canary"; mkdir -p -m 700 "$CAN"
bash "$HERE/hone-push-guard.sh" --go "$GO" --url-base "$URLBASE" --state-dir "$CAN" --limit 3 --every 1 --max 60 --parent $$ --tombstone "$TD/FAILED-LOGIN" > "$CAN/guard.out" 2>&1 & CG=$!
for _ in $(seq 1 30); do grep -q ' ok ' "$CAN/polls.log" 2> /dev/null && break; kill -0 "$CG" 2> /dev/null || break; sleep 0.5; done
grep -q ' ok ' "$CAN/polls.log" 2> /dev/null || { kill "$CG" 2> /dev/null; refuse "the canary guard never completed a poll: $(tail -n 2 "$CAN/guard.out" | tr '\n' ' ')"; }
( cd "$SD" && "$GO" --agent no db query --db-url "$URLBASE" -o json "select pg_sleep(40)" > "$CAN/canary.out" 2> "$CAN/canary.err"; echo $? > "$CAN/canary.rc" ) & CB=$!
for _ in $(seq 1 60); do [ -f "$CAN/canary.rc" ] && break; sleep 0.5; done
kill "$CG" 2> /dev/null; wait "$CG" 2> /dev/null; wait "$CB" 2> /dev/null
if [ -f "$CAN/canary.rc" ] && [ "$(cat "$CAN/canary.rc")" != 0 ] && grep -qiE 'cancel|57014' "$CAN/canary.err" && [ -s "$CAN/cancels.log" ]; then
  echo "CANARY: the guard cancelled a 3 s canary statement on this role and path (attachment proven)."
else
  refuse "the canary statement was not cancelled by the guard (rc=$(cat "$CAN/canary.rc" 2> /dev/null || echo none)): the guard cannot act on this path"
fi
sleep 1
# real guard
G="$SD/guard"; mkdir -p -m 700 "$G"
bash "$HERE/hone-push-guard.sh" --go "$GO" --url-base "$URLBASE" --state-dir "$G" --limit "$LIMIT" --every "$EVERY" --max 900 --parent $$ --tombstone "$TD/FAILED-LOGIN" > "$G/guard.out" 2>&1 & GP=$!
for _ in $(seq 1 30); do grep -q ' ok ' "$G/polls.log" 2> /dev/null && break; kill -0 "$GP" 2> /dev/null || break; sleep 0.5; done
grep -q ' ok ' "$G/polls.log" 2> /dev/null || { kill "$GP" 2> /dev/null; refuse "the guard never completed a poll: $(tail -n 2 "$G/guard.out" | tr '\n' ' ')"; }
echo "GUARD: armed and polling every ${EVERY}s (limit ${LIMIT}s); first heartbeat observed. Pushing."
SIG=0; trap 'SIG=1; echo "SIGNAL received: recorded. The push and the guard are NOT killed (that would not stop a running statement). Waiting for the push to end, then reconciling."' INT TERM HUP
printf 'run=%s approval=%s started=%s\n' "$RUNID" "$APPROVAL" "$(date -u +%FT%TZ)" > "$TD/IN-FLIGHT" && sync "$TD/IN-FLIGHT" 2> /dev/null; rec "push-start (expected remaining $((NEXP - k)))"
P0=$(now_ms)
( cd "$WD" && "$GO" --agent no db push --db-url "$URLBASE" --yes > "$SD/push.out" 2> "$SD/push.err2"; echo $? > "$SD/push.rc" ) & PP=$!
while kill -0 "$PP" 2> /dev/null; do wait "$PP" 2> /dev/null; done
P1=$(now_ms)
sleep "$EVERY"; sleep 1
kill "$GP" 2> /dev/null; wait "$GP" 2> /dev/null
PRC=$(cat "$SD/push.rc" 2> /dev/null || echo unknown)
authfail "$SD/push.err2" || authfail "$SD/push.out"
GUARD_LOST=0; [ -e "$TD/FAILED-LOGIN" ] && GUARD_LOST=1
# after: reconcile again, always
H3=$(hist) || H3=UNREADABLE
rec "push-end exit=$PRC"
if [ "$H3" = UNREADABLE ]; then echo "RESULT: UNKNOWN (push exit=$PRC; history unreadable through the pooler). Re-run this wrapper once the pooler answers; do not push by hand."; exit 3; fi
k=0; ok=1
for v in $(printf '%s' "$H3" | tr ',' ' '); do want=$(printf '%s' "$EXPV" | awk -v i=$((k + 1)) '{print $i}'); [ "$v" = "$want" ] || { ok=0; break; }; k=$((k + 1)); done
INW=$(awk -v a="$P0" -v b="$P1" '$2 == "ok" && $1 + 0 >= a - 1000 && $3 + 0 <= b + 1000 + 2000 {c++} END {print c + 0}' "$G/polls.log")
BLIND=$(grep -c ' blind ' "$G/polls.log" 2> /dev/null); CANC=$(grep -c . "$G/cancels.log" 2> /dev/null)
DURMS=$((P1 - P0))
[ "$GUARD_LOST" = 1 ] && echo "GUARD LOST: a login-failure tombstone exists; the push was NOT guarded to the end. Treat the outcome as unverified until history is read by hand."
echo "GUARD EVIDENCE: push ${DURMS} ms; polls overlapping/adjacent to the push: ${INW}; blind polls over the whole guard life: ${BLIND}; cancels: ${CANC}. (The guard proves it was polling and able to act; it does not claim to have seen the push session.)"
[ "$SIG" = 1 ] && echo "NOTE: a signal was received during the push; the push was left to finish."
if [ "$ok" = 1 ] && [ "$k" = "$NEXP" ] && [ "$PRC" = 0 ]; then
  rm -f "$TD/IN-FLIGHT"; rec "COMPLETE $k/$NEXP"; echo "RESULT: COMPLETE $k/$NEXP"; exit 0
elif [ "$ok" = 1 ]; then
  rm -f "$TD/IN-FLIGHT"; rec "PARTIAL $k/$NEXP"; echo "RESULT: PARTIAL $k/$NEXP (push exit=$PRC). History is a clean prefix. Re-run this wrapper (same arguments) to resume; it re-derives the state and pushes only the remaining files."; exit 4
else
  rec "INCONSISTENT"; echo "RESULT: INCONSISTENT (push exit=$PRC; history $H3 is not a prefix). Do not push. This needs a human."; exit 5
fi
