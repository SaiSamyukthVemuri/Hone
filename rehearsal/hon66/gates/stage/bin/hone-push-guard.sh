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
# SCOPE (HON66-PROOF M3). Through the session pooler the push's backend cannot be told apart from any other pooled postgres-role
# session (application_name is always "Supavisor"), so the guard CANNOT be limited to "the push's own backend". What it does instead:
#   - only pooler-originated sessions (application_name = 'Supavisor') are ever candidates: direct sessions (dashboard, Management API,
#     pg_cron, platform tools) are never cancelled;
#   - only statements that STARTED AFTER arming (a pre-arm census, enforced by hone-push-linux.sh, shows none active beforehand);
#   - every cancel is RECORDED (pid, seconds, application_name, client_addr, query_start, md5 and length of the query, never its text);
#   - the guard exits when its parent is gone (a SIGKILLed wrapper does not leave a cancelling guard behind) and after --max (900 s).
# What remains true and is stated, not hidden: another pooled postgres-role statement (for example Sam's own psql through the pooler)
# that starts during the window and runs past the limit WOULD be cancelled. Run attended; keep other pooled postgres-role work off.
# LOGINS (M4): one pooler login per poll. Default poll 2 s; after a failed poll the interval backs off (x2, capped at 8 s); an
# authentication failure writes the tombstone and STOPS at once; 3 consecutive failed polls write it and stop.
#
# The password arrives ONLY as PGPASSWORD in the environment of this process, set by hone-push-linux.sh from fd 3 (never a file, never
# argv). Usage (internal; called by the wrapper):  hone-push-guard.sh --go PATH --url-base postgresql://user@host:port/postgres?sslmode=require \
#          --state-dir DIR --parent PID --tombstone FILE [--limit 120] [--every 2] [--max 900]
# Exit: 0 stopped on request / parent gone / --max; 2 refused (self-test/arm/usage); 3 login failure (tombstone written).
set -u
LIMIT=120; EVERY=2; MAX=900; GO=; URLBASE=; SD=; PARENT=; TOMB=
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=$2; shift 2 ;; --url-base) URLBASE=$2; shift 2 ;; --state-dir) SD=$2; shift 2 ;;
    --parent) PARENT=$2; shift 2 ;; --tombstone) TOMB=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;; --every) EVERY=$2; shift 2 ;; --max) MAX=$2; shift 2 ;;
    *) echo "GUARD: unknown argument" >&2; exit 2 ;;
  esac
done
case "$LIMIT$EVERY$MAX" in *[!0-9]*|'') echo "GUARD: --limit/--every/--max must be whole numbers" >&2; exit 2 ;; esac
[ "$EVERY" -ge 1 ] && [ "$LIMIT" -ge 1 ] || { echo "GUARD: --limit/--every must be >= 1" >&2; exit 2; }
case "$PARENT" in ''|*[!0-9]*) echo "GUARD: --parent PID is required" >&2; exit 2 ;; esac
[ -n "$TOMB" ] || { echo "GUARD: --tombstone FILE is required" >&2; exit 2; }
[ -n "$GO" ] && [ -x "$GO" ] && [ -n "$URLBASE" ] && [ -n "$SD" ] || { echo "GUARD: --go, --url-base and --state-dir are required" >&2; exit 2; }
case "$URLBASE" in *@*) : ;; *) echo "GUARD: --url-base needs a user@host" >&2; exit 2 ;; esac
UI=${URLBASE#*://}; UI=${UI%%@*}; case "$UI" in *:*) echo "GUARD: --url-base must not carry a password" >&2; exit 2 ;; esac
[ -n "${PGPASSWORD:-}" ] || { echo "GUARD: PGPASSWORD is not set (the wrapper passes it from fd 3)" >&2; exit 2; }
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
fails=0; GAP=$EVERY
while [ "$STOP" = 0 ] && [ $((SECONDS - T0)) -lt "$MAX" ]; do
  kill -0 "$PARENT" 2> /dev/null || { echo "$(date +%T) GUARD: parent $PARENT is gone; stopping (no orphan guard)"; break; }
  t=$(now_ms)
  if out=$(q "select count(*) filter (where ok) as cancelled, coalesce(max(run), 0) as maxrun, coalesce(string_agg(pid::text || '|' || run::text || '|' || app || '|' || addr || '|' || qs || '|' || md5q || '|' || lenq::text, ';') filter (where ok), '') as detail from (select pid, extract(epoch from (now() - query_start))::int as run, application_name as app, coalesce(client_addr::text, '-') as addr, query_start::text as qs, md5(query) as md5q, length(query) as lenq, pg_cancel_backend(pid) as ok from pg_stat_activity where datname = 'postgres' and usename = 'postgres' and backend_type = 'client backend' and state = 'active' and application_name = 'Supavisor' and pid <> pg_backend_pid() and query_start > '$ARMED'::timestamptz and now() - query_start > interval '$LIMIT seconds') s") && [ -n "$out" ]; then
    n=$((n + 1)); fails=0; GAP=$EVERY; c=$(printf '%s' "$out" | jget cancelled)
    printf '%s ok %s\n' "$t" "$(now_ms)" >> "$SD/polls.log"
    if [ "${c:-0}" != 0 ]; then
      echo "$(date +%T) *** GUARD CANCELLED $c backend(s): a pooled postgres-role statement ran past ${LIMIT}s (detail pid|secs|app|addr|query_start|md5|len in cancels.log). The CLI stops with 57014; do not re-run until the history is read back."
      printf '%s %s %s\n' "$(now_ms)" "$c" "$(printf '%s' "$out" | jget detail)" >> "$SD/cancels.log"
    fi
  else
    blind=$((blind + 1)); fails=$((fails + 1)); printf '%s blind %s\n' "$t" "$(now_ms)" >> "$SD/polls.log"
    echo "$(date +%T) *** GUARD BLIND ($blind): the poll failed ($(tail -n 1 "$ERR" | cut -c1-120 | LC_ALL=C sed -E 's#postgres(ql)?://[^ ]*#<url>#g')). The push is NOT protected while this lasts."
    if grep -qiE 'password authentication failed|28P01|28000|SASL' "$ERR" 2> /dev/null || [ "$fails" -ge 3 ]; then
      printf 'FAILED-LOGIN written by the push guard at %s (%s consecutive failed polls; authentication failure: %s). Do not retry; do not reset the password; report.\n' "$(date -u +%FT%TZ)" "$fails" "$(grep -qiE 'password authentication failed|28P01|28000|SASL' "$ERR" && echo yes || echo no)" > "$TOMB"
      echo "$(date +%T) *** GUARD STOPPED: login failure tombstone written ($TOMB). No further logins."; exit 3
    fi
    GAP=$((GAP * 2)); [ "$GAP" -le 8 ] || GAP=8
  fi
  sleep "$GAP" & wait $! 2> /dev/null
done
echo "$(date +%T) GUARD stopped: polls ok=$n blind=$blind"
exit 0
