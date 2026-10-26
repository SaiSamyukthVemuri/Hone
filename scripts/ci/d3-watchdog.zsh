# D3 WATCHDOG (operator form). REHEARSAL - NEVER MERGE.
# Run it as a FILE in a SECOND Terminal (Terminal 2), never pasted:   zsh d3-watchdog.zsh
# from the directory that holds ./supabase-cli (the same directory S1 runs in), AFTER the dry run lists exactly the
# expected files and BEFORE the push starts in Terminal 1. The user, host and sslmode below are the S1 values.
# There is NO password in this file: it asks for it with read -rs (not echoed, not in any argument list).
#
# What it does: it cancels ONE backend, the one it PINNED as the S1 push session, and only when that backend has been
# running a single statement for longer than WD_LIMIT seconds. It never selects by role or by age alone.
#   0. SELF-TEST: it must see its own row (state active, query_start set, role postgres). If not, it refuses to arm.
#   1. ARM: it records EVERY postgres-role client backend that is already ACTIVE (space separated, none dropped) and
#      ignores them for ever.
#   2. PIN: the first postgres-role client backend that becomes ACTIVE, is not in that list AND looks like a migration
#      (it holds a transaction id, or a relation lock stronger than a read). Exactly one -> pinned (pid + backend_start).
#      Two or more at once -> it refuses to pin, says so, and cancels NOTHING.
#   3. CHECK: every WD_EVERY seconds it asks about the pinned backend only (pid, backend_start, role; never its own
#      backend). Over the limit: pg_cancel_backend(pid) for that pid. Nothing else is ever cancelled.
# It stops when the pinned backend has been idle for 2 polls in a row or is gone (the pooler reuses backends, so a
# pin can outlive the push), after WD_MAX seconds, or on Ctrl-C IN THIS TERMINAL. Stopping does NOT mean the push is
# done: confirm Terminal 1 printed "Finished supabase db push." before you trust it.
# NEVER press Ctrl-C in Terminal 1 and never close or kill it: that does not stop the running statement and the
# file still commits. The only ways to stop a statement are this watchdog and the printed one-shot.

d3_wdq() { ./supabase-cli/supabase-go --agent no db query --db-url "$WD_URL" -o json "$1" 2> "$WD_ERR" || { print -r -- "$(date +%T) query failed: $(tail -n 2 "$WD_ERR" | tr '\n' ' ')" >&2; return 1; }; }
# first value of a JSON key, from one-line or pretty-printed JSON, with grep and sed only (a stock Mac has no jq)
d3_wdget() { tr -d '\n' | grep -o "\"$1\": *\"\{0,1\}[^\",}]*" | head -n 1 | sed -e 's/^[^:]*: *"\{0,1\}//' -e 's/[[:space:]]*$//'; }

d3_watchdog() {
  local out armed pin bstart n act run cancelled lastq idle=0 fails=0 q me t0=$SECONDS
  : ${WD_LIMIT:=120} ${WD_EVERY:=5} ${WD_MAX:=1200}
  WD_URL="postgresql://<USER>@<HOSTPORT>/postgres?sslmode=<SSLMODE>"
  WD_ERR="${TMPDIR:-/tmp}/d3-wd.err"
  mkdir -p supabase/.temp && print -r -- v2.102.0 > supabase/.temp/cli-latest
  if [[ $(< supabase/.temp/cli-latest) != v2.102.0 ]] || [[ -z $(find supabase/.temp/cli-latest -mmin -540 2> /dev/null) ]]; then
    print -r -- "WATCHDOG: supabase/.temp/cli-latest is not v2.102.0 or is older than 9 hours; refusing to run (every poll would call GitHub)."
    return 1
  fi
  out=$(d3_wdq "select count(*) as me from pg_stat_activity where pid = pg_backend_pid() and state = 'active' and query_start is not null and usename = 'postgres' and backend_type = 'client backend'") || {
    print -r -- "WATCHDOG: cannot query the pooler. Do NOT start the push without a working watchdog."
    return 1
  }
  me=$(print -r -- "$out" | d3_wdget me)
  if [[ $me != 1 ]]; then
    print -r -- "WATCHDOG: self-test failed (own session not visible as active postgres-role client backend; me=${me:-none}). Refusing to arm. Do NOT start the push."
    return 1
  fi
  out=$(d3_wdq "select coalesce(string_agg(pid::text, ' '), '') as armed from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and pid <> pg_backend_pid()") || {
    print -r -- "WATCHDOG: cannot read pg_stat_activity. Do NOT start the push without a working watchdog."
    return 1
  }
  armed=$(print -r -- "$out" | d3_wdget armed)
  print -r -- "$(date +%T) WATCHDOG armed (self-test ok). Ignoring already-active postgres-role backends: [${armed:-none}]. Limit ${WD_LIMIT}s, poll every ${WD_EVERY}s, stops after ${WD_MAX}s."
  while (( SECONDS - t0 < WD_MAX )); do
    if [[ -z $pin ]]; then
      q="select count(*) as n, coalesce(min(pid), 0) as pid, coalesce(min(backend_start::text), '') as bstart, left(coalesce(min(query), ''), 50) as q from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and pid <> pg_backend_pid() and pid <> all(string_to_array('${armed}', ' ')::int[]) and (backend_xid is not null or exists (select 1 from pg_locks l where l.pid = pg_stat_activity.pid and l.locktype = 'relation' and l.granted and l.mode in ('ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')))"
      if out=$(d3_wdq "$q"); then
        fails=0
        n=$(print -r -- "$out" | d3_wdget n)
        if [[ $n == 1 ]]; then
          pin=$(print -r -- "$out" | d3_wdget pid)
          bstart=$(print -r -- "$out" | d3_wdget bstart)
          lastq=$(print -r -- "$out" | d3_wdget q)
          print -r -- "$(date +%T) WATCHDOG PINNED pid=$pin started=$bstart as the S1 push session. Statement: $lastq"
          print -r -- "                  If that is NOT a statement from the migration files, press Ctrl-C in THIS Terminal only and cancel by hand (see the notes)."
          print -r -- "                  NEVER press Ctrl-C in Terminal 1 and never close it: the statement keeps running and the file still commits."
        elif [[ $n != 0 && -n $n ]]; then
          print -r -- "$(date +%T) *** WATCHDOG AMBIGUOUS: $n new active postgres-role sessions. NOT pinning, NOT cancelling anything. Look with:"
          print -r -- "    ./supabase-cli/supabase-go --agent no db query --db-url \"\$WD_URL\" -o json \"select pid, now() - query_start as running, left(query, 80) as q from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' order by query_start\""
          print -r -- "    then, for the push session's pid ONLY:   ./supabase-cli/supabase-go --agent no db query --db-url \"\$WD_URL\" -o json \"select pg_cancel_backend(<PID>)\""
        else
          print -r -- "$(date +%T) watching for the push session to start (nothing new is active yet)"
        fi
      else
        fails=$((fails + 1))
        print -r -- "$(date +%T) *** WATCHDOG BLIND: the poll failed ($fails in a row). The push is NOT protected while this lasts."
      fi
    else
      q="select count(*) as present, coalesce(max(case when state = 'active' then 1 else 0 end), 0) as active, coalesce(max(extract(epoch from now() - query_start)::int), 0) as run, left(coalesce(min(query), ''), 50) as q, coalesce(bool_or(case when state = 'active' and now() - query_start > interval '${WD_LIMIT} seconds' then pg_cancel_backend(pid) end), false) as cancelled from pg_stat_activity where pid = ${pin} and pid <> pg_backend_pid() and backend_start = '${bstart}'::timestamptz and usename = 'postgres' and backend_type = 'client backend'"
      if out=$(d3_wdq "$q"); then
        fails=0
        n=$(print -r -- "$out" | d3_wdget present)
        act=$(print -r -- "$out" | d3_wdget active)
        run=$(print -r -- "$out" | d3_wdget run)
        cancelled=$(print -r -- "$out" | d3_wdget cancelled)
        [[ -n $(print -r -- "$out" | d3_wdget q) ]] && lastq=$(print -r -- "$out" | d3_wdget q)
        if [[ $n == 0 ]]; then
          print -r -- "$(date +%T) WATCHDOG STOPPED: the pinned backend (pid $pin) is gone or was reused. Last statement seen: $lastq"
          print -r -- "                  This does NOT prove the push finished. CONFIRM Terminal 1 printed Finished supabase db push. If it did not, the push may be running UNWATCHED: stop it only with the one-shot, and restart this watchdog."
          return 0
        fi
        if [[ $cancelled == true ]]; then
          print -r -- "$(date +%T) *** WATCHDOG CANCELLED pid=$pin: one statement ran ${run}s (limit ${WD_LIMIT}s). The CLI will stop with 57014. Do not re-run the push until you have read back the history (db push --dry-run)."
          idle=0
        elif [[ $act == 1 ]]; then
          idle=0
          print -r -- "$(date +%T) watching pid=$pin statement running ${run}s (limit ${WD_LIMIT}s)"
        else
          idle=$((idle + 1))
          print -r -- "$(date +%T) pid=$pin not active ($idle of 2)"
          if (( idle >= 2 )); then
            print -r -- "$(date +%T) WATCHDOG STOPPED: the pinned backend has been idle for 2 polls. Last statement seen: $lastq"
            print -r -- "                  This does NOT prove the push finished. CONFIRM Terminal 1 printed Finished supabase db push. If it did not, the push may be running UNWATCHED: stop it only with the one-shot, and restart this watchdog."
            return 0
          fi
        fi
      else
        fails=$((fails + 1))
        print -r -- "$(date +%T) *** WATCHDOG BLIND: the poll failed ($fails in a row). The push is NOT protected while this lasts."
      fi
    fi
    sleep $WD_EVERY
  done
  print -r -- "$(date +%T) WATCHDOG STOPPED: WD_MAX (${WD_MAX}s) reached. The push is NOT watched any more. Confirm Terminal 1 printed Finished supabase db push."
}

read -rs PGPASSWORD
export PGPASSWORD
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN
d3_watchdog
unset PGPASSWORD
print -r -- "Watchdog finished. Close this Terminal window now (the password is not kept)."
