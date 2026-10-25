#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. Proves, against a throwaway Postgres container and
# the PINNED Supabase CLI, which mechanism puts statement_timeout on the SAME
# session that runs migration files, and that a file's own `set local
# lock_timeout` fires. Synthetic data only: nothing here touches a hosted
# project, a Hone migration, or customer data. Each probe has its own database
# and its own scratch project directory, so one failure cannot touch the next.
#
# Every value is read from INSIDE the migration file (current_setting, pid) and
# read back with psql afterwards; the CLI's own output is never trusted for it.
set -u

CLI="npx --yes supabase@2.102.0"
HOST="${REHEARSAL_PGHOST:-127.0.0.1}"
PORT="${REHEARSAL_PGPORT:-5432}"
PW="${REHEARSAL_PGPASSWORD:-postgres}"
OUT="${REHEARSAL_OUT:-$PWD/timeout-rehearsal-out}"
S1_OPTS='-c statement_timeout=120000'
URL_OPTS='&options=-c%20statement_timeout%3D120000'
FAILS=0

mkdir -p "$OUT"
RES="$OUT/results.txt"
: > "$RES"
say() { echo "$*" | tee -a "$RES"; }
admin() { psql -X -q -A -t "postgresql://postgres:$PW@$HOST:$PORT/$1" -c "$2" 2>&1; }
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
expect() { # expect <label> <0|1 condition-result> <observed>
  if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi
}

newprobe() { # newprobe <name>: database + scratch project dir
  local dir="$OUT/$1"
  admin postgres "drop database if exists rh_$1" > /dev/null
  admin postgres "create database rh_$1" > /dev/null
  mkdir -p "$dir"
  (cd "$dir" && $CLI init < /dev/null > "$dir/init.log" 2>&1)
  if [ ! -f "$dir/supabase/config.toml" ]; then
    mkdir -p "$dir/supabase"
    printf 'project_id = "rehearsal"\n[db]\nmajor_version = 17\n' > "$dir/supabase/config.toml"
  fi
  mkdir -p "$dir/supabase/migrations"
}

mig() { # mig <probe> <version> <body>: one file, the real #1035 header shape
  printf 'begin;\n\nset local lock_timeout = '"'5s'"';\n\n%s\n\ncommit;\n' "$3" \
    > "$OUT/$1/supabase/migrations/${2}_rehearsal.sql"
}

OBS_TABLE='create table if not exists public.rehearsal_obs (probe text, file text, statement_timeout text, lock_timeout text, pid int, app text, at timestamptz default clock_timestamp());'
obs() { # obs <probe> <file>: record what THIS session sees
  echo "insert into public.rehearsal_obs (probe, file, statement_timeout, lock_timeout, pid, app) values ('$1', '$2', current_setting('statement_timeout'), current_setting('lock_timeout'), pg_backend_pid(), current_setting('application_name'));"
}

push() { # push <probe> <PGOPTIONS or empty> [extra url query]; sets RC and ELAPSED
  local name="$1" opts="$2" extra="${3:-}" dir="$OUT/$1"
  local url="postgresql://postgres:$PW@$HOST:$PORT/rh_$name?sslmode=require$extra"
  local t0 t1
  t0="$(now)"
  if [ -n "$opts" ]; then
    PGOPTIONS="$opts" $CLI db push --workdir "$dir" --db-url "$url" --yes > "$dir/push.log" 2>&1
  else
    env -u PGOPTIONS $CLI db push --workdir "$dir" --db-url "$url" --yes > "$dir/push.log" 2>&1
  fi
  RC=$?
  t1="$(now)"
  ELAPSED="$(secs "$t0" "$t1")"
  say "-- $name: exit=$RC elapsed=${ELAPSED}s (includes npx start-up)"
  sed 's/^/   | /' "$dir/push.log" | tail -n 12 | tee -a "$RES"
}

seen() { admin "rh_$1" "select file || '=' || statement_timeout || '/' || lock_timeout || '/pid' || pid from public.rehearsal_obs order by at" | tr '\n' ' '; }
val() { admin "rh_$1" "select $2 from public.rehearsal_obs where file = '$3'"; }
within() { awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN { exit !(v >= lo && v <= hi) }'; }

say "# timeout rehearsal: $(npx --yes supabase@2.102.0 --version) against $(admin postgres 'show server_version')"
say "# server default statement_timeout (no override): $(admin postgres 'show statement_timeout')"

# (a) NEGATIVE CONTROL: no PGOPTIONS. The probe must see the default, so (b)'s value is not vacuous.
newprobe a_baseline
mig a_baseline 20990101000001 "$OBS_TABLE
$(obs a_baseline f1)"
mig a_baseline 20990101000002 "select pg_sleep(1);
$(obs a_baseline f2)"
push a_baseline ""
sv="$(val a_baseline statement_timeout f2)"
expect "(a) no PGOPTIONS: migration session sees the default, not 120s" "$([ "$sv" = "0" ] && echo 0 || echo 1)" "f2 statement_timeout=$sv; $(seen a_baseline)"

# (b) FINDING from run 40189312019: PGOPTIONS in the environment does NOT reach the
# migration session (value 0). Kept as a regression guard on that finding.
newprobe b_pgoptions
mig b_pgoptions 20990101000001 "$OBS_TABLE
$(obs b_pgoptions f1)"
mig b_pgoptions 20990101000002 "$(obs b_pgoptions f2)"
push b_pgoptions "$S1_OPTS"
s1="$(val b_pgoptions statement_timeout f1)"; s2="$(val b_pgoptions statement_timeout f2)"
expect "(b) PGOPTIONS env is IGNORED by db push (both files still see the default)" "$([ "$s1:$s2" = "0:0" ] && echo 0 || echo 1)" "f1=$s1 f2=$s2"

# (g) THE S1 SHAPE: the connection string carries options AND each file runs its own
# set local lock_timeout. Both must hold in the SAME session, across several files.
newprobe g_s1shape
mig g_s1shape 20990101000001 "$OBS_TABLE
$(obs g_s1shape f1)"
mig g_s1shape 20990101000002 "$(obs g_s1shape f2)"
mig g_s1shape 20990101000003 "$(obs g_s1shape f3)"
push g_s1shape "" "$URL_OPTS"
okv=0
for f in f1 f2 f3; do
  sv="$(val g_s1shape statement_timeout $f)"; lv="$(val g_s1shape lock_timeout $f)"
  case "$sv" in 2min | 120s) ;; *) okv=1 ;; esac
  [ "$lv" = "5s" ] || okv=1
done
expect "(g) S1 shape: URL options statement_timeout=120s AND each file's lock_timeout=5s, in every file" "$okv" "$(seen g_s1shape)"
np="$(admin rh_g_s1shape "select count(distinct pid) from public.rehearsal_obs")"
say "INFO  (g) distinct backend pids across the three files: $np (1 = one session runs all files)"

# (c) FIRING through the working mechanism: a 130 s statement is cancelled at ~120 s (57014),
# in a file that ALSO runs its own set local lock_timeout.
newprobe c_fire
mig c_fire 20990101000001 "$OBS_TABLE
$(obs c_fire f1)"
mig c_fire 20990101000002 "select pg_sleep(130);"
mig c_fire 20990101000003 "create table public.rh_after (i int);"
push c_fire "" "$URL_OPTS"
hit=1; grep -qiE '57014|statement timeout' "$OUT/c_fire/push.log" && hit=0
expect "(c) a 130 s statement is cancelled by the URL-option statement_timeout (57014)" "$((hit + (RC == 0 ? 1 : 0)))" "exit=$RC elapsed=${ELAPSED}s"
tw=1; within "$ELAPSED" 115 140 && tw=0
expect "(c) it fired at about 120 s, not 130 s" "$tw" "elapsed=${ELAPSED}s"
vers="$(admin rh_c_fire "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations")"
aft="$(admin rh_c_fire "select count(*) from information_schema.tables where table_name = 'rh_after'")"
expect "(c) the CLI STOPPED at the cancelled file (only f1 recorded, next file not run)" "$([ "$vers" = "20990101000001" ] && [ "$aft" = "0" ] && echo 0 || echo 1)" "recorded=$vers next_file_table=$aft"

# (d) PER STATEMENT OR PER FILE, with the timeout really in force: two 70 s statements in one file.
newprobe d_perfile
mig d_perfile 20990101000001 "$OBS_TABLE
select pg_sleep(70);
select pg_sleep(70);
$(obs d_perfile f1)"
push d_perfile "" "$URL_OPTS"
if [ "$RC" = "0" ]; then
  say "RESULT (d) statement_timeout=120s applies PER STATEMENT: a 140 s file with two 70 s statements COMPLETED (elapsed ${ELAPSED}s)"
elif grep -qiE '57014|statement timeout' "$OUT/d_perfile/push.log"; then
  say "RESULT (d) statement_timeout=120s is a WHOLE-FILE budget through this CLI: the 140 s file was CANCELLED (57014, elapsed ${ELAPSED}s)"
else
  say "FAIL  (d) the file failed for a reason other than statement timeout (exit=$RC, elapsed ${ELAPSED}s)"; FAILS=$((FAILS + 1))
fi

# (e) LOCK under an ACTIVE statement_timeout: the 5 s lock_timeout must still fire first (55P03).
newprobe e_lock
admin rh_e_lock "create table public.rh_locked (i int)" > /dev/null
mig e_lock 20990101000001 "$OBS_TABLE
$(obs e_lock f1)"
mig e_lock 20990101000002 "alter table public.rh_locked add column x int;"
mig e_lock 20990101000003 "create table public.rh_after (i int);"
psql -X -q "postgresql://postgres:$PW@$HOST:$PORT/rh_e_lock" -c "begin; lock table public.rh_locked in access exclusive mode; select pg_sleep(60); commit;" > "$OUT/e_lock/holder.log" 2>&1 &
HOLDER=$!
held=1
for _ in $(seq 1 40); do
  g="$(admin rh_e_lock "select count(*) from pg_locks where relation = 'public.rh_locked'::regclass and mode = 'AccessExclusiveLock' and granted")"
  [ "$g" = "1" ] && { held=0; break; }
  sleep 0.5
done
expect "(e) the ACCESS EXCLUSIVE lock is granted before the push starts" "$held" "granted=$g"
push e_lock "" "$URL_OPTS"
lk=1; grep -qiE '55P03|lock timeout' "$OUT/e_lock/push.log" && lk=0
expect "(e) with statement_timeout=120s ACTIVE, a blocked ALTER still fails on lock timeout (55P03)" "$((lk + (RC == 0 ? 1 : 0)))" "exit=$RC"
fast=1; within "$ELAPSED" 3 40 && fast=0
expect "(e) it fired at about 5 s, far below 120 s" "$fast" "elapsed=${ELAPSED}s"
sv="$(val e_lock statement_timeout f1)"
case "$sv" in 2min | 120s) sok=0 ;; *) sok=1 ;; esac
expect "(e) the session that hit the lock had statement_timeout=120s in force" "$sok" "f1=$sv"
vers="$(admin rh_e_lock "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations")"
col="$(admin rh_e_lock "select count(*) from information_schema.columns where table_name = 'rh_locked' and column_name = 'x'")"
aft="$(admin rh_e_lock "select count(*) from information_schema.tables where table_name = 'rh_after'")"
expect "(e) the blocked file rolled back and the CLI STOPPED" \
  "$([ "$vers" = "20990101000001" ] && [ "$col" = "0" ] && [ "$aft" = "0" ] && echo 0 || echo 1)" "recorded=$vers column_x=$col f3_table=$aft"
kill "$HOLDER" 2> /dev/null
wait "$HOLDER" 2> /dev/null

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
say "# residual: proven on a DIRECT connection only; pooler (Supavisor) forwarding of startup options is UNVERIFIED"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
