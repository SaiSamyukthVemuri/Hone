# D3 WATCHDOG (operator form). REHEARSAL - NEVER MERGE. Run in a SECOND Terminal (zsh), from the directory that holds
# ./supabase-cli, AFTER the dry run lists exactly the expected files and BEFORE the push starts.
# <USER>, <HOSTPORT>, <SSLMODE> are the same placeholders as the S1 commands; there is NO password in this file.
#
# What it does: it cancels ONE backend, the one it PINNED as the S1 push session, and only when that backend has been
# running a single statement for longer than WD_LIMIT seconds. It never selects by role or by age alone. Identification:
#   1. ARM: it records the postgres-role client backends that are ALREADY ACTIVE (other tools' long queries) and ignores them forever.
#   2. PIN: the first postgres-role client backend that becomes ACTIVE, is not in that list AND looks like a migration
#      (it holds a transaction id, or a lock stronger than a plain read: the push applies DDL/DML; a plain long SELECT, or a
#      pg_cron sleep, does not). If exactly one appears it is pinned (pid + backend_start). If two or more appear at once
#      it refuses to pin, says so loudly, and never cancels.
#   3. CHECK: every WD_EVERY seconds it asks about the pinned backend only (pid AND backend_start AND usename). Over the
#      limit: pg_cancel_backend(pid) for that pid. Nothing else is ever cancelled.
# It stops when: the pinned backend has not been active for 3 polls in a row (the push finished or stopped), the pinned
# backend is gone, WD_MAX seconds have passed, or you press Ctrl-C. Residual risks are written in D3-WATCHDOG-NOTES.

d3_wdq() { ./supabase-cli/supabase-go --agent no db query --db-url "$WD_URL" -o json "$1" 2> "${TMPDIR:-/tmp}/d3-wd.err" || { print -r -- "$(date +%T) query failed: $(tail -n 2 "${TMPDIR:-/tmp}/d3-wd.err" | tr '\n' ' ')" >&2; return 1; }; }
# first value of a JSON key, from one-line or pretty-printed JSON, with grep and sed only (a stock Mac has no jq)
d3_wdget() { tr -d '\n' | grep -o "\"$1\": *\"\{0,1\}[^\",}]*" | head -n 1 | sed 's/^[^:]*: *"\{0,1\}//'; }

d3_watchdog() {
  local out armed pin bstart n act run cancelled idle=0 fails=0 amb=0 t0=$SECONDS q
  : ${WD_LIMIT:=120} ${WD_EVERY:=5} ${WD_MAX:=10800}
  WD_URL="postgresql://<USER>@<HOSTPORT>/postgres?sslmode=<SSLMODE>"
  out=$(d3_wdq "select coalesce(string_agg(pid::text, ','), '') as armed from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and pid <> pg_backend_pid()") || {
    print -r -- "WATCHDOG: cannot read pg_stat_activity through the pooler. Do NOT start the push without a working watchdog."
    return 1
  }
  armed=$(print -r -- "$out" | d3_wdget armed)
  print -r -- "$(date +%T) WATCHDOG armed. Ignoring already-active postgres-role backends: [${armed:-none}]. Limit ${WD_LIMIT}s, poll every ${WD_EVERY}s."
  while (( SECONDS - t0 < WD_MAX )); do
    if [[ -z $pin ]]; then
      q="select count(*) as n, coalesce(min(pid), 0) as pid, coalesce(min(backend_start::text), '') as bstart, left(coalesce(min(query), ''), 50) as q from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and pid <> pg_backend_pid() and pid <> all(string_to_array('${armed}', ',')::int[]) and (backend_xid is not null or exists (select 1 from pg_locks l where l.pid = pg_stat_activity.pid and l.locktype = 'relation' and l.granted and l.mode in ('ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')))"
      if out=$(d3_wdq "$q"); then
        fails=0
        n=$(print -r -- "$out" | d3_wdget n)
        if [[ $n == 1 ]]; then
          pin=$(print -r -- "$out" | d3_wdget pid)
          bstart=$(print -r -- "$out" | d3_wdget bstart)
          print -r -- "$(date +%T) WATCHDOG PINNED pid=$pin started=$bstart as the S1 push session. Statement: $(print -r -- "$out" | d3_wdget q)"
          print -r -- "                  If that is NOT the push session, press Ctrl-C now and cancel by hand (see the notes)."
        elif [[ $n != 0 && -n $n ]]; then
          amb=$((amb + 1))
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
      q="select count(*) as present, coalesce(max(case when state = 'active' then 1 else 0 end), 0) as active, coalesce(max(extract(epoch from now() - query_start)::int), 0) as run, coalesce(bool_or(case when state = 'active' and now() - query_start > interval '${WD_LIMIT} seconds' then pg_cancel_backend(pid) end), false) as cancelled from pg_stat_activity where pid = ${pin} and backend_start = '${bstart}'::timestamptz and usename = 'postgres' and backend_type = 'client backend'"
      if out=$(d3_wdq "$q"); then
        fails=0
        n=$(print -r -- "$out" | d3_wdget present)
        act=$(print -r -- "$out" | d3_wdget active)
        run=$(print -r -- "$out" | d3_wdget run)
        cancelled=$(print -r -- "$out" | d3_wdget cancelled)
        if [[ $n == 0 ]]; then
          print -r -- "$(date +%T) WATCHDOG: the pinned backend (pid $pin) is gone. Push finished or stopped. Stopping."
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
          print -r -- "$(date +%T) pid=$pin not active ($idle of 3)"
          if (( idle >= 3 )); then
            print -r -- "$(date +%T) WATCHDOG: the pinned backend has been idle for 3 polls. Push finished or stopped. Stopping."
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
  print -r -- "$(date +%T) WATCHDOG: WD_MAX (${WD_MAX}s) reached. Stopping."
}

read -rs PGPASSWORD
export PGPASSWORD
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN
d3_watchdog
