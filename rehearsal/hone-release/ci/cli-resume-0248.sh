#!/bin/bash
# REHEARSAL - NEVER MERGE. STAGE-PACKAGE-3 addendum (CI only, SYNTHETIC target, no hosted access): with the pinned CLI (supabase 2.102.0) prove, for a 0248-ONLY stage,
#   (1) the push applies 0248 and not 0247 (the dry run lists only 0248),
#   (2) the history afterwards is 0001..0246 + 0248,
#   (3) a LATER resumption applies 0247, 0249 and 0250 without re-applying 0248 (needs --include-all; without it the CLI refuses), and ends with 0001..0250.
# Plus the hazard: if the 0247 file is present in the migrations directory the same push would pull it into the stage.
# The files are synthetic one-liners named like the real chain; the frozen real SQL is not used. usage: cli-resume-0248.sh
set -u
W=${RUNNER_TEMP:-/tmp}/cli-resume; rm -rf "$W"; mkdir -p "$W/proj/supabase/migrations"; cd "$W/proj"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
PGC=hr-resume-pg; docker rm -f $PGC >/dev/null 2>&1; docker run -d --name $PGC -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54399:5432 postgres:15-alpine >/dev/null
for _ in $(seq 1 40); do docker exec $PGC pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
q() { docker exec $PGC psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
URL='postgresql://postgres:postgres@127.0.0.1:54399/postgres'
cli() { env PGSSLMODE=disable SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 supabase "$@" 2>&1; }
mig() { printf '%s\n' "$2" > "supabase/migrations/${1}_synthetic.sql"; }
echo "CLI: $(supabase --version)"
for i in $(seq 1 246); do mig "$(printf %04d "$i")" "select 1;"; done
# base: the remote holds 0001..0246 (pushed by the same CLI, as production does)
OUT=$(cli db push --db-url "$URL" --yes); RC=$?
[ $RC = 0 ] && [ "$(q "select count(*) from supabase_migrations.schema_migrations")" = 246 ] && ok "base: the synthetic remote holds exactly 0001..0246 (246 rows)" || bad "base push" "rc=$RC $(echo "$OUT" | tail -3)"
# HAZARD: with the 0247 file present, the same push pulls it in alongside 0248
mig 0247 "create table public.s0247 (id int);"; mig 0248 "create table public.s0248 (id int);"
OUT=$(cli db push --db-url "$URL" --dry-run)
echo "$OUT" | grep -q '0247_synthetic.sql' && echo "$OUT" | grep -q '0248_synthetic.sql' && ok "hazard shown: with 0247 in the directory the dry run lists BOTH 0247 and 0248 (so the 0248 stage directory must not contain 0247)" || bad "hazard" "$(echo "$OUT" | tail -5)"
# (1) the 0248-only stage: the directory holds 0001..0246 + 0248, no 0247/0249/0250
rm -f supabase/migrations/0247_synthetic.sql
OUT=$(cli db push --db-url "$URL" --dry-run); RC=$?
listed=$(echo "$OUT" | grep -o '[0-9]\{4\}_synthetic.sql' | sort -u | tr '\n' ' ')
[ $RC = 0 ] && [ "$listed" = "0248_synthetic.sql " ] && ok "(1) dry run lists exactly 0248 (not 0247)" || bad "(1) dry run" "rc=$RC listed=[$listed] $(echo "$OUT" | tail -4)"
OUT=$(cli db push --db-url "$URL" --yes); RC=$?
napp=$(echo "$OUT" | grep -c 'Applying migration'); [ $RC = 0 ] && [ "$napp" = 1 ] && echo "$OUT" | grep -q 'Applying migration 0248_synthetic.sql' && ok "(1) the push applied exactly one migration: 0248" || bad "(1) push" "rc=$RC napp=$napp $(echo "$OUT" | tail -4)"
# (2) the history
[ "$(q "select count(*) from supabase_migrations.schema_migrations")" = 247 ] && [ "$(q "select max(version) from supabase_migrations.schema_migrations")" = 0248 ] && [ "$(q "select count(*) from supabase_migrations.schema_migrations where version = '0247'")" = 0 ] && [ "$(q "select count(*) from supabase_migrations.schema_migrations where version <= '0246'")" = 246 ] && ok "(2) history is 0001..0246 plus 0248: 247 rows, max 0248, 0247 absent" || bad "(2) history" "$(q "select count(*), max(version) from supabase_migrations.schema_migrations")"
[ "$(q "select to_regclass('public.s0248') is not null and to_regclass('public.s0247') is null")" = t ] && ok "(2) the 0248 object exists and the 0247 object does not" || bad "(2) objects"
# (3) resumption: 0247, 0249, 0250 are added to the directory
mig 0247 "create table public.s0247 (id int);"; mig 0249 "create table public.s0249 (id int);"; mig 0250 "create table public.s0250 (id int);"
OUT=$(cli db push --db-url "$URL" --dry-run); RC=$?
[ $RC != 0 ] && echo "$OUT" | grep -q 'inserted before the last migration on remote' && echo "$OUT" | grep -q -- '--include-all' && ok "(3) without --include-all the CLI REFUSES (older local file below the remote max) and names the flag" || bad "(3) refusal" "rc=$RC $(echo "$OUT" | tail -5)"
[ "$(q "select count(*) from supabase_migrations.schema_migrations")" = 247 ] && ok "(3) the refused attempt changed nothing (still 247 rows)" || bad "(3) refused attempt changed history"
OUT=$(cli db push --db-url "$URL" --include-all --dry-run); RC=$?
listed=$(echo "$OUT" | grep -o '[0-9]\{4\}_synthetic.sql' | sort -u | tr '\n' ' ')
[ $RC = 0 ] && [ "$listed" = "0247_synthetic.sql 0249_synthetic.sql 0250_synthetic.sql " ] && ok "(3) --include-all dry run lists exactly 0247, 0249, 0250 (not 0248)" || bad "(3) include-all dry run" "rc=$RC listed=[$listed]"
OUT=$(cli db push --db-url "$URL" --include-all --yes); RC=$?
napp=$(echo "$OUT" | grep -c 'Applying migration'); [ $RC = 0 ] && [ "$napp" = 3 ] && ! echo "$OUT" | grep -q 'Applying migration 0248' && ok "(3) the resumption applied exactly 3 migrations, not 0248 (a re-apply would also fail: create table s0248)" || bad "(3) resumption" "rc=$RC napp=$napp $(echo "$OUT" | tail -4)"
[ "$(q "select count(*) from supabase_migrations.schema_migrations")" = 250 ] && [ "$(q "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0246'")" = 0246,0247,0248,0249,0250 ] && ok "(3) final history is 0001..0250, each once" || bad "(3) final history" "$(q "select count(*), max(version) from supabase_migrations.schema_migrations")"
docker rm -f $PGC >/dev/null 2>&1
echo "RESULT: $pass passed, $fail failed"
EXPECT=11; [ $((pass + fail)) = $EXPECT ] || { echo "FAIL - $((pass + fail)) of $EXPECT cases ran"; exit 1; }
[ "$fail" = 0 ]
