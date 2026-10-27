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
# Usage: hone-push-linux.sh --go PATH --url-base postgresql://user@host:port/postgres?sslmode=require --workdir DIR \
#          --expected FILE [--limit 120] [--every 1] [--first 0213] [--state-dir DIR]
# Password: HONE_GATE_PASSWORD_FILE (absolute path; owner, mode 600, one line). Never printed, never in argv.
set -u
GO=; URLBASE=; WD=; EXP=; LIMIT=120; EVERY=1; FIRST=0213; SD=
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=$2; shift 2 ;; --url-base) URLBASE=$2; shift 2 ;; --workdir) WD=$2; shift 2 ;; --expected) EXP=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;; --every) EVERY=$2; shift 2 ;; --first) FIRST=$2; shift 2 ;; --state-dir) SD=$2; shift 2 ;;
    *) echo "PUSH: unknown argument" >&2; exit 2 ;;
  esac
done
refuse() { echo "PUSH REFUSED: $1"; exit 2; }
[ -x "$GO" ] && [ -d "$WD/supabase/migrations" ] && [ -f "$EXP" ] && [ -n "$URLBASE" ] || refuse "--go, --url-base, --workdir (with supabase/migrations) and --expected are required"
[ "$(sha256sum -- "$GO" | cut -d' ' -f1)" = "$GOSHA" ] || refuse "the supabase binary is not the pinned linux_amd64 2.102.0 build"
case "$FIRST$LIMIT$EVERY" in *[!0-9]*|'') refuse "--first/--limit/--every must be digits" ;; esac
[ -r "$HERE/hone-push-guard.sh" ] || refuse "hone-push-guard.sh must sit beside this script"
[ "$(printf '%s' "${HONE_GATE_PASSWORD_FILE:-}" | head -c1)" = / ] || refuse "HONE_GATE_PASSWORD_FILE must be an absolute path"
export HONE_GATE_PASSWORD_FILE
PWF=$HONE_GATE_PASSWORD_FILE
[ -f "$PWF" ] && [ ! -L "$PWF" ] && [ "$(stat -c '%u %a %h' -- "$PWF")" = "$(id -u) 600 1" ] && [ "$(wc -l < "$PWF")" -le 1 ] && [ -s "$PWF" ] || refuse "the password file must be a regular, unlinked, non-empty one-line file, owner $(id -u), mode 600"
IFS= read -r PGPASSWORD < "$PWF" || true
export PGPASSWORD SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN SUPABASE_ACCESS_TOKEN
[ -n "$SD" ] || SD=$(mktemp -d "${TMPDIR:-/tmp}/hone-push.XXXXXX")
mkdir -p -m 700 "$SD" "$SD/supabase/.temp"; printf 'v2.102.0\n' > "$SD/supabase/.temp/cli-latest"
mkdir -p "$WD/supabase/.temp"; printf 'v2.102.0\n' > "$WD/supabase/.temp/cli-latest"
ERR="$SD/push.err"
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
H1=$(hist) || refuse "cannot read the migration history through the pooler (nothing attempted)"
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
if [ "$k" = "$NEXP" ]; then echo "RESULT: ALREADY-COMPLETE $k/$NEXP (nothing pushed)"; exit 0; fi
PENDING=$(printf '%s' "$EXPECTED" | awk -v k=$k '{for (i = k + 1; i <= NF; i++) printf "%s ", $i}')
DRY=$( cd "$WD" && "$GO" --agent no db push --db-url "$URLBASE" --dry-run 2>&1 ) || refuse "the dry run failed: $(printf '%s' "$DRY" | tail -n 1 | cut -c1-120)"
DRYL=$(printf '%s\n' "$DRY" | grep -oE '[0-9]{4}_[A-Za-z0-9_]+\.sql' | sort -u | tr '\n' ' ')
[ "$DRYL" = "$PENDING" ] || refuse "the dry run does not list exactly the remaining $((NEXP - k)) files (listed: $(printf '%s' "$DRYL" | wc -w))"
echo "RECONCILE: the dry run lists exactly the remaining $((NEXP - k)) files."
# in-flight: nothing active besides this session, twice, history unchanged
inflight() { q "select count(*) as n from pg_stat_activity where datname = 'postgres' and usename = 'postgres' and backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid()" | jget n; }
a=$(inflight) || refuse "cannot read pg_stat_activity"; sleep 3; b=$(inflight) || refuse "cannot read pg_stat_activity"; H2=$(hist) || refuse "cannot re-read history"
[ "$a" = 0 ] && [ "$b" = 0 ] && [ "$H2" = "$H1" ] || refuse "a postgres-role statement is active or the history moved (n=$a/$b): a previous push may still be running. Wait, then re-run; nothing was re-pushed."
echo "RECONCILE: no in-flight statement; history stable."

# canary: a short-limit guard must cancel a canary statement on the same role and path
CAN="$SD/canary"; mkdir -p -m 700 "$CAN"
bash "$HERE/hone-push-guard.sh" --go "$GO" --url-base "$URLBASE" --state-dir "$CAN" --limit 3 --every 1 --max 60 > "$CAN/guard.out" 2>&1 & CG=$!
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
bash "$HERE/hone-push-guard.sh" --go "$GO" --url-base "$URLBASE" --state-dir "$G" --limit "$LIMIT" --every "$EVERY" --max 1800 > "$G/guard.out" 2>&1 & GP=$!
for _ in $(seq 1 30); do grep -q ' ok ' "$G/polls.log" 2> /dev/null && break; kill -0 "$GP" 2> /dev/null || break; sleep 0.5; done
grep -q ' ok ' "$G/polls.log" 2> /dev/null || { kill "$GP" 2> /dev/null; refuse "the guard never completed a poll: $(tail -n 2 "$G/guard.out" | tr '\n' ' ')"; }
echo "GUARD: armed and polling every ${EVERY}s (limit ${LIMIT}s); first heartbeat observed. Pushing."
SIG=0; trap 'SIG=1; echo "SIGNAL received: recorded. The push and the guard are NOT killed (that would not stop a running statement). Waiting for the push to end, then reconciling."' INT TERM HUP
P0=$(now_ms)
( cd "$WD" && "$GO" --agent no db push --db-url "$URLBASE" --yes > "$SD/push.out" 2> "$SD/push.err2"; echo $? > "$SD/push.rc" ) & PP=$!
while kill -0 "$PP" 2> /dev/null; do wait "$PP" 2> /dev/null; done
P1=$(now_ms)
sleep "$EVERY"; sleep 1
kill "$GP" 2> /dev/null; wait "$GP" 2> /dev/null
PRC=$(cat "$SD/push.rc" 2> /dev/null || echo unknown)
# after: reconcile again, always
H3=$(hist) || H3=UNREADABLE
if [ "$H3" = UNREADABLE ]; then echo "RESULT: UNKNOWN (push exit=$PRC; history unreadable through the pooler). Re-run this wrapper once the pooler answers; do not push by hand."; exit 3; fi
k=0; ok=1
for v in $(printf '%s' "$H3" | tr ',' ' '); do want=$(printf '%s' "$EXPV" | awk -v i=$((k + 1)) '{print $i}'); [ "$v" = "$want" ] || { ok=0; break; }; k=$((k + 1)); done
INW=$(awk -v a="$P0" -v b="$P1" '$2 == "ok" && $1 + 0 >= a - 1000 && $3 + 0 <= b + 1000 + 2000 {c++} END {print c + 0}' "$G/polls.log")
BLIND=$(grep -c ' blind ' "$G/polls.log" 2> /dev/null); CANC=$(grep -c . "$G/cancels.log" 2> /dev/null)
DURMS=$((P1 - P0))
echo "GUARD EVIDENCE: push ${DURMS} ms; polls overlapping/adjacent to the push: ${INW}; blind polls over the whole guard life: ${BLIND}; cancels: ${CANC}. (The guard proves it was polling and able to act; it does not claim to have seen the push session.)"
[ "$SIG" = 1 ] && echo "NOTE: a signal was received during the push; the push was left to finish."
if [ "$ok" = 1 ] && [ "$k" = "$NEXP" ] && [ "$PRC" = 0 ]; then
  echo "RESULT: COMPLETE $k/$NEXP"; exit 0
elif [ "$ok" = 1 ]; then
  echo "RESULT: PARTIAL $k/$NEXP (push exit=$PRC). History is a clean prefix. Re-run this wrapper (same arguments) to resume; it re-derives the state and pushes only the remaining files."; exit 4
else
  echo "RESULT: INCONSISTENT (push exit=$PRC; history $H3 is not a prefix). Do not push. This needs a human."; exit 5
fi
