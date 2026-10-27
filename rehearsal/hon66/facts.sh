#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. HON66 facts: why the S1 watchdog never PINNED on 2026-10-27, measured on a REAL supabase-go push through a
# REAL local Supavisor session pooler, with a realistic FAST push (34 small migration files), plus the session attributes the push shows.
set -u
. "$(dirname "$0")/common.sh"
say "== F1. a fast 34-file push through the pooler: duration, and the push session as pg_stat_activity shows it (sampled every ~10 ms)"
sadm -c "create table if not exists public.zz_probe_samples (t timestamptz, pid int, usename text, app text, btype text, state text, xid text, xact_start timestamptz, qstart timestamptz, caddr text, q text, lockmode text)" > /dev/null
sampler_sql() { cat <<'SQL'
do $$
declare t_end timestamptz := clock_timestamp() + make_interval(secs => %SECS%);
begin
  while clock_timestamp() < t_end loop
    perform pg_stat_clear_snapshot();
    insert into public.zz_probe_samples
      select clock_timestamp(), a.pid, a.usename::text, a.application_name, a.backend_type, a.state, a.backend_xid::text, a.xact_start, a.query_start, coalesce(a.client_addr::text, '-'), left(a.query, 60),
             (select string_agg(distinct l.mode, ',') from pg_locks l where l.pid = a.pid and l.locktype = 'relation' and l.granted)
        from pg_stat_activity a where a.datname = 'postgres' and a.pid <> pg_backend_pid() and a.backend_type = 'client backend';
    perform pg_sleep(0.01);
  end loop;
end $$;
SQL
}
run_sampler() { sampler_sql | sed "s/%SECS%/$1/" | docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 > "$OUT/sampler.log" 2>&1 & SAMPBG=$!; }
clean_hon66; W1="$OUT/wd-fast"; mkwd "$W1"; write_fast34 "$W1"
sadm -c "truncate public.zz_probe_samples" > /dev/null
run_sampler 40; sleep 3
T0=$(date +%s.%N); push_bg f1 "$W1" "$TLSURL_BASE&application_name=hon66-probe"; push_wait f1; T1=$(date +%s.%N)
sleep 2; wait "$SAMPBG" 2> /dev/null
DUR=$(python3 -c "print(round($T1-$T0,2))")
say "RESULT fast push: exit=$PUSHRC duration ${DUR}s; history rows >=0213: $(hist_n); log tail: $(tail -n 2 "$OUT/run-f1.log" | tr '\n' ' ')"
expect "(F1) the fast 34-file push applied all 34 files" "$([ "$PUSHRC" = 0 ] && [ "$(hist_n)" = 34 ] && echo 0 || echo 1)" "exit=$PUSHRC n=$(hist_n)"
say "RESULT sampled attributes of sessions seen during the push (distinct usename|app|btype|state|has_xid|lockmode counts):"
psqld -F '|' -c "select usename, app, btype, state, (xid is not null) as has_xid, coalesce(lockmode, '-') as locks, count(*) from public.zz_probe_samples group by 1,2,3,4,5,6 order by 7 desc" | sed 's/^/   | /' | tee -a "$RES"
PUSHPID_SAMPLES=$(psqld -c "select count(*) from public.zz_probe_samples where usename = 'postgres' and app = 'hon66-probe'")
say "RESULT samples where the push session carried application_name=hon66-probe (passed in the db-url): $PUSHPID_SAMPLES"
say "RESULT how long (ms) the push session was visible: $(psqld -c "select coalesce(round(extract(epoch from (max(t) - min(t)))*1000), 0) from public.zz_probe_samples where usename = 'postgres' and app = 'hon66-probe'")"
say "RESULT predicate hits: samples matching the WATCHDOG's pin predicate (postgres role, client backend, state=active, xid or relation lock >= ShareUpdateExclusive): $(psqld -c "select count(*) from public.zz_probe_samples where usename='postgres' and btype='client backend' and state='active' and (xid is not null or lockmode ~ 'ShareUpdateExclusiveLock|ShareLock|ShareRowExclusiveLock|ExclusiveLock|AccessExclusiveLock')")"
say "RESULT distinct push-session states: $(psqld -c "select string_agg(distinct state || ':' || (xid is not null)::text, ', ') from public.zz_probe_samples where app = 'hon66-probe'")"
say "RESULT distinct postgres backends (pids) used by the push: $(psqld -c "select count(distinct pid) from public.zz_probe_samples where app = 'hon66-probe'")"
expect "(F1b) application_name from the db-url reaches pg_stat_activity through the session pooler" "$([ "$PUSHPID_SAMPLES" -gt 0 ] && echo 0 || echo 1)" "samples=$PUSHPID_SAMPLES"

say "== F2. the REAL operator watchdog (d3-watchdog.zsh) against the same fast push: poll 5 s (the shipped value) and poll 1 s"
render() { cp "$HERE/d3-watchdog.zsh" "$OUT/wd.zsh"; }
render
WDHOME="$OUT/wdhome"; rm -rf "$WDHOME"; mkdir -p "$WDHOME"; ln -s "$REPO/supabase-cli" "$WDHOME/supabase-cli"
wd_run() { # wd_run <label> <every> : the real watchdog under zsh, background
  ( cd "$WDHOME" && printf '%s\n' "$PWU" | WD_USER="$PUSER" WD_HOSTPORT="$RUNNER_IP:$TLSP" WD_SSLMODE=require WD_LIMIT=120 WD_EVERY="$2" WD_PIN_WAIT=60 WD_MAX=120 zsh -f "$OUT/wd.zsh" > "$OUT/wd-$1.log" 2>&1; echo $? > "$OUT/wdrc-$1.txt" ) &
  WDBG=$!
}
for every in 5 1; do
  for rep in 1 2 3; do
    clean_hon66; mkwd "$W1"; write_fast34 "$W1"
    L="every${every}-r$rep"; wd_run "$L" "$every"
    wait_for 40 'WATCHDOG armed' "$OUT/wd-$L.log" || say "WARN watchdog $L did not arm"
    sleep 1
    push_bg "$L" "$W1" "$TLSURL_BASE&options=-c%20statement_timeout%3D120000"; push_wait "$L"
    sleep $((every + 2)); kill "$WDBG" 2> /dev/null; pkill -f 'zsh -f .*wd.zsh' 2> /dev/null; wait "$WDBG" 2> /dev/null
    say "RESULT poll=${every}s run $rep: push exit=$PUSHRC n=$(hist_n); watchdog PINNED lines: $(grep -c 'WATCHDOG PINNED' "$OUT/wd-$L.log"); watching lines: $(grep -c 'watching for the push session' "$OUT/wd-$L.log")"
  done
done
PIN5=$(cat "$OUT"/wd-every5-r*.log | grep -c 'WATCHDOG PINNED'); PIN1=$(cat "$OUT"/wd-every1-r*.log | grep -c 'WATCHDOG PINNED')
say "RESULT total PINNED over 3 fast pushes: poll 5 s = $PIN5, poll 1 s = $PIN1"
expect "(F2) REPRODUCTION: the shipped watchdog (poll 5 s) pins none/few of 3 realistic fast pushes (documents the 2026-10-27 failure)" "$([ "$PIN5" -le 1 ] && echo 0 || echo 1)" "pinned=$PIN5 of 3"

say "== F3. session-bound controls through the pooler"
SHOWT() { PGPASSWORD="$PWU" psql "$1" -X -At -c "show statement_timeout" -c "show lock_timeout" -c "show application_name" 2>&1 | tr '\n' ' '; }
say "RESULT show statement_timeout/lock_timeout/application_name, plain URL: $(SHOWT "$TLSURL_BASE")"
say "RESULT ... with options=-c statement_timeout=7000 -c lock_timeout=3000 in the URL: $(SHOWT "$TLSURL_BASE&options=-c%20statement_timeout%3D7000%20-c%20lock_timeout%3D3000")"
say "RESULT ... with application_name=hon66-x in the URL: $(SHOWT "$TLSURL_BASE&application_name=hon66-x")"
sadm -c "alter role postgres set statement_timeout = '9s'" > /dev/null
say "RESULT ... after ALTER ROLE postgres SET statement_timeout='9s' (role default; hosted analogue = the 2 min that was the only protection on 02:37Z): $(SHOWT "$TLSURL_BASE")"
sadm -c "alter role postgres reset statement_timeout" > /dev/null
say "RESULT supabase-go db query reads application_name/statement_timeout in-session: $(PGPASSWORD="$PWU" "$GOBIN" --agent no db query --db-url "$TLSURL_BASE&application_name=hon66-gq&options=-c%20statement_timeout%3D7000" -o json "show statement_timeout" 2>&1 | tr -d '\n ' | cut -c1-120)"
say "== done facts; failures: $FAILS"
exit $FAILS
