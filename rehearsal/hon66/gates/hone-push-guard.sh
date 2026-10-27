#!/usr/bin/env bash
# hone-push-guard.sh (HON66-LINUX-GATES, Linux x86_64). REHEARSAL-PROVEN ONLY; never run against a hosted project without
# the operator's per-change authorization.
#
# WHY THIS REPLACES d3-watchdog.zsh. On 2026-10-27 the watchdog was "armed" and never PINNED: it pins by SAMPLING the first
# new active postgres-role backend, and a 34-file push through the session pooler is active for ~0.1 s of a ~0.35 s run
# (measured, rehearsal #1194 run 40541020312: 10 samples at 10 ms). A 5 s poll sees it ~2% of the time. The predicate was
# right; the sampling was the defect. The pooler also makes the push session indistinguishable from any other pooled session
# (application_name is always "Supavisor"; options=-c ... in the URL is ignored), so a nonce/identity pin is impossible.
#
# WHAT THIS DOES INSTEAD (stateless; nothing has to be caught):
#   every --every seconds, ONE statement as the push role cancels every active, postgres-role client backend (not itself)
#   whose current statement STARTED AFTER THE GUARD ARMED and has been running longer than --limit seconds.
#   A short push is never touched; a hung one is cancelled at the first poll after the limit, whenever it started.
# It writes heartbeats so a caller can prove the guard was polling (no blind poll) across an interval. It cannot prove it
# "saw" the push session, and says so.
#
# Credentials: the password is read from a file named by HONE_GATE_PASSWORD_FILE (mode 600, owner, one line); never printed,
# never in argv. Usage:  hone-push-guard.sh --go PATH --url-base postgresql://user@host:port/postgres?sslmode=require \
#                          --state-dir DIR [--limit 120] [--every 1] [--max 1800]
# Exit: 0 = stopped on request (SIGTERM/INT) or --max; 2 = refused (self-test/arm/usage).
set -u
LIMIT=120; EVERY=1; MAX=1800; GO=; URLBASE=; SD=
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=$2; shift 2 ;; --url-base) URLBASE=$2; shift 2 ;; --state-dir) SD=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;; --every) EVERY=$2; shift 2 ;; --max) MAX=$2; shift 2 ;;
    *) echo "GUARD: unknown argument" >&2; exit 2 ;;
  esac
done
case "$LIMIT$EVERY$MAX" in *[!0-9]*|'') echo "GUARD: --limit/--every/--max must be whole numbers" >&2; exit 2 ;; esac
[ "$EVERY" -ge 1 ] && [ "$LIMIT" -ge 1 ] || { echo "GUARD: --limit/--every must be >= 1" >&2; exit 2; }
[ -n "$GO" ] && [ -x "$GO" ] && [ -n "$URLBASE" ] && [ -n "$SD" ] || { echo "GUARD: --go, --url-base and --state-dir are required" >&2; exit 2; }
case "$URLBASE" in *@*) : ;; *) echo "GUARD: --url-base needs a user@host" >&2; exit 2 ;; esac
case "$URLBASE" in *:*@*:*) echo "GUARD: --url-base must not carry a password" >&2; exit 2 ;; esac
[ "$(printf '%s' "${HONE_GATE_PASSWORD_FILE:-}" | head -c1)" = / ] || { echo "GUARD: HONE_GATE_PASSWORD_FILE must be an absolute path" >&2; exit 2; }
PWF=$HONE_GATE_PASSWORD_FILE; unset HONE_GATE_PASSWORD_FILE
[ -f "$PWF" ] && [ ! -L "$PWF" ] && [ "$(stat -c '%u %a %h' -- "$PWF")" = "$(id -u) 600 1" ] || { echo "GUARD: the password file must be a regular, unlinked file, owner $(id -u), mode 600" >&2; exit 2; }
[ "$(wc -l < "$PWF")" -le 1 ] && [ -s "$PWF" ] || { echo "GUARD: the password file must be exactly one non-empty line" >&2; exit 2; }
IFS= read -r PGPASSWORD < "$PWF" || true
[ -n "$PGPASSWORD" ] || { echo "GUARD: empty password" >&2; exit 2; }
export PGPASSWORD
mkdir -p -m 700 "$SD/supabase/.temp" || exit 2
printf 'v2.102.0\n' > "$SD/supabase/.temp/cli-latest"
echo $$ > "$SD/guard.pid"
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN SUPABASE_ACCESS_TOKEN
URL=$URLBASE
ERR="$SD/guard.err"
q() { ( cd "$SD" && "$GO" --agent no db query --db-url "$URL" -o json "$1" 2> "$ERR" ); }
jget() { python3 -I -c 'import json,sys
d=json.load(sys.stdin)
r=d[0] if isinstance(d,list) and d else (d.get("rows",[{}])[0] if isinstance(d,dict) else {})
print(r.get(sys.argv[1],""))' "$1"; }
now_ms() { date +%s%3N; }
: > "$SD/polls.log"; : > "$SD/cancels.log"

# self-test: own session must be visible as an active postgres-role client backend
out=$(q "select count(*) as me, clock_timestamp()::text as armed from pg_stat_activity where pid = pg_backend_pid() and state = 'active' and usename = 'postgres' and backend_type = 'client backend'") || { echo "GUARD REFUSES: cannot query the pooler. Do NOT push."; exit 2; }
me=$(printf '%s' "$out" | jget me); ARMED=$(printf '%s' "$out" | jget armed)
[ "$me" = 1 ] && [ -n "$ARMED" ] || { echo "GUARD REFUSES: self-test failed (own session not visible as active postgres-role client backend; me=${me:-none}). Do NOT push."; exit 2; }
echo "$(date +%T) GUARD armed at server time $ARMED; cancels any postgres-role active statement started after that and older than ${LIMIT}s; poll ${EVERY}s; stops after ${MAX}s"
printf 'armed %s %s\n' "$(now_ms)" "$ARMED" > "$SD/state"
STOP=0; trap 'STOP=1' INT TERM HUP
T0=$SECONDS; n=0; blind=0
while [ "$STOP" = 0 ] && [ $((SECONDS - T0)) -lt "$MAX" ]; do
  t=$(now_ms)
  if out=$(q "select count(*) as seen, coalesce(max(run), 0) as maxrun, count(*) filter (where c) as cancelled, coalesce(string_agg(pid::text, ',') filter (where c), '') as pids from (select pid, extract(epoch from (now() - query_start))::int as run, pg_cancel_backend(pid) as c from pg_stat_activity where datname = 'postgres' and usename = 'postgres' and backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and query_start > '$ARMED'::timestamptz and now() - query_start > interval '$LIMIT seconds') s") && [ -n "$out" ]; then
    n=$((n + 1)); c=$(printf '%s' "$out" | jget cancelled)
    printf '%s ok %s\n' "$t" "$(now_ms)" >> "$SD/polls.log"
    if [ "${c:-0}" != 0 ]; then
      echo "$(date +%T) *** GUARD CANCELLED $c backend(s) (pids $(printf '%s' "$out" | jget pids)): a statement ran past ${LIMIT}s. The CLI stops with 57014; do not re-run until the history is read back."
      printf '%s %s\n' "$(now_ms)" "$c" >> "$SD/cancels.log"
    fi
  else
    blind=$((blind + 1)); printf '%s blind %s\n' "$t" "$(now_ms)" >> "$SD/polls.log"
    echo "$(date +%T) *** GUARD BLIND ($blind): the poll failed ($(tail -n 1 "$ERR" | cut -c1-120)). The push is NOT protected while this lasts."
  fi
  sleep "$EVERY" & wait $! 2> /dev/null
done
echo "$(date +%T) GUARD stopped: polls ok=$n blind=$blind"
exit 0
