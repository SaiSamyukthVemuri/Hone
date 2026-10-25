#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. Runs the PROPOSED S1 apply tool and command against a
# DISPOSABLE, SYNTHETIC local database that was built through production's
# migration prefix (0001-0212, recorded by the CLI) -- NOT a verified copy of
# production data or configuration. Nothing here touches a hosted project.
#
# The command under test (from the GO package, with the local password):
#   npx --yes supabase@2.102.0 db push --db-url "$SUPABASE_DB_URL" --yes
#   SUPABASE_DB_URL='postgresql://postgres:<pw>@<host>:<port>/postgres?sslmode=require&options=-c%20statement_timeout%3D120000'
# preceded by the same command with --dry-run. Every expectation is recorded and
# the script keeps going so one failure still yields the rest of the evidence.
set -u

CLI="npx --yes supabase@2.102.0"
DB="${DB:?the supabase db container name}"
OUT="${REHEARSAL_OUT:?}"
HOST=127.0.0.1
PORT=54322
PW=postgres
URLBASE="postgresql://postgres:$PW@$HOST:$PORT/postgres?sslmode=require"
S1_URL="${URLBASE}&options=-c%20statement_timeout%3D120000"
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"
: > "$RES"
say() { echo "$*" | tee -a "$RES"; }
expect() { # expect <label> <0 = met> <observed>
  if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi
}
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
runsql() { docker cp "$1" "$DB:/tmp/step.sql" > /dev/null && psqld -f /tmp/step.sql > /dev/null; }
count_triggers() { psqld -c "select count(*) from pg_trigger where tgname in ('clients_00_pause_archive_trg','audit_logs_00_pause_export_trg') and not tgisinternal"; }
vers() { psqld -c "select coalesce(string_agg(version, ',' order by version), '') from supabase_migrations.schema_migrations"; }
nvers() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }

TLSDIR="$OUT/tls"
ensure_tls() { # the pinned CLI always attempts TLS; serve a self-signed certificate from the container
  if [ ! -f "$TLSDIR/server.crt" ]; then
    mkdir -p "$TLSDIR"
    openssl req -new -x509 -days 1 -nodes -text -out "$TLSDIR/server.crt" -keyout "$TLSDIR/server.key" \
      -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" > /dev/null 2>&1
  fi
  docker exec -u root "$DB" mkdir -p /etc/hone-tls
  docker cp "$TLSDIR/server.crt" "$DB:/etc/hone-tls/server.crt" > /dev/null
  docker cp "$TLSDIR/server.key" "$DB:/etc/hone-tls/server.key" > /dev/null
  docker exec -u root "$DB" chown postgres:postgres /etc/hone-tls/server.crt /etc/hone-tls/server.key
  docker exec -u root "$DB" chmod 600 /etc/hone-tls/server.key
  # ALTER SYSTEM needs a superuser; the stack's `postgres` role is not one.
  local sa=(docker exec -i "$DB" psql -U supabase_admin -X -q -A -t -v ON_ERROR_STOP=1)
  "${sa[@]}" -c "alter system set ssl_cert_file = '/etc/hone-tls/server.crt'"
  "${sa[@]}" -c "alter system set ssl_key_file = '/etc/hone-tls/server.key'"
  "${sa[@]}" -c "alter system set ssl = 'on'"
  "${sa[@]}" -c "select pg_reload_conf()" > /dev/null
  sleep 3
  local s
  s="$(psqld -c 'show ssl')"
  say "INFO  tls: show ssl = $s"
  if [ "$s" != "on" ]; then
    say "DIAG  pg_settings for ssl*:"
    "${sa[@]}" -c "select name || ' = ' || coalesce(setting, '') || ' | source=' || source || ' | file=' || coalesce(sourcefile, '') || ':' || coalesce(sourceline::text, '') || ' | pending_restart=' || pending_restart from pg_settings where name like 'ssl%' order by name" 2>&1 | sed 's/^/   | /' | tee -a "$RES"
    say "DIAG  server process command line:"
    docker exec "$DB" sh -c "ps -eo args | grep '[p]ostgres' | head -3" 2>&1 | sed 's/^/   | /' | tee -a "$RES"
    say "DIAG  container log tail:"
    docker logs --tail 25 "$DB" 2>&1 | sed 's/^/   | /' | tee -a "$RES"
    say "DIAG  key/cert files:"
    docker exec -u root "$DB" ls -l /etc/hone-tls 2>&1 | sed 's/^/   | /' | tee -a "$RES"
    say "DIAG  restarting the db container once so the settings are read at startup"
    docker restart "$DB" > /dev/null
    for _ in $(seq 1 40); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
    s="$(psqld -c 'show ssl')"
    say "INFO  tls after restart: show ssl = $s"
    if [ "$s" != "on" ]; then docker logs --tail 25 "$DB" 2>&1 | sed 's/^/   | /' | tee -a "$RES"; fi
  fi
  [ "$s" = "on" ]
}

reset_to_0212() {
  say "-- resetting the synthetic database to production's prefix 0212 (supabase db reset --local --version 0212)"
  $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 || { tail -n 20 "$OUT/reset-0212.log"; return 1; }
  for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
  ensure_tls || return 1
}

# ---- artefact capture --------------------------------------------------------
capture() { # capture <label>
  local d="$OUT/cap-$1"; mkdir -p "$d"
  docker exec -i "$DB" pg_dump -U postgres --schema-only --schema=public --schema=auth --schema=storage postgres \
    | grep -vE '^\\(un)?restrict ' > "$d/dump.sql"
  psqld -c "select extname || ' ' || extversion from pg_extension order by 1" > "$d/extensions.txt"
  psqld -c "select n.nspname, c.relname, c.relkind, r.rolname, coalesce(c.relacl::text, '') from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname in ('public','auth','storage') order by 1,2,3" > "$d/class-owner-acl.txt"
  psqld -c "select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), r.rolname, coalesce(p.proacl::text, '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner where n.nspname in ('public','auth','storage') order by 1,2,3" > "$d/proc-owner-acl.txt"
  psqld -c "select r.rolname, coalesce(n.nspname, '*'), d.defaclobjtype, d.defaclacl::text from pg_default_acl d join pg_roles r on r.oid = d.defaclrole left join pg_namespace n on n.oid = d.defaclnamespace order by 1,2,3" > "$d/default-acl.txt"
  psqld -c "select n.nspname, r.rolname, coalesce(n.nspacl::text, '') from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname in ('public','auth','storage') order by 1" > "$d/namespaces.txt"
  psqld -c "select version, name, coalesce(cardinality(statements), 0), md5(coalesce(array_to_string(statements, E'\n'), '')) from supabase_migrations.schema_migrations order by version" > "$d/history.txt"
}
compare() { # compare <labelA> <labelB>
  local a="$OUT/cap-$1" b="$OUT/cap-$2" f
  for f in dump.sql extensions.txt class-owner-acl.txt proc-owner-acl.txt default-acl.txt namespaces.txt history.txt; do
    if diff -u "$b/$f" "$a/$f" > "$OUT/diff-$1-vs-$2-$f.diff"; then
      say "SAME  $f  ($(wc -l < "$a/$f") lines)"
    else
      say "DIFF  $f  ($(grep -c '^[-+][^-+]' "$OUT/diff-$1-vs-$2-$f.diff") changed lines; control=-, $1=+)"
      sed -n '1,60p' "$OUT/diff-$1-vs-$2-$f.diff" | sed 's/^/   | /' | tee -a "$RES"
    fi
  done
}

# ---- the tree under test -------------------------------------------------------
EXPECTED="$(ls supabase/migrations | awk -F_ '$1 >= "0213" && $1 <= "0246" {print substr($1,1,4)}' | sort | tr '\n' ' ')"
NEXP="$(echo $EXPECTED | wc -w)"
say "# apply-tool rehearsal: $($CLI --version 2> /dev/null | tail -1) against $(psqld -c 'show server_version') -- a SYNTHETIC database built through production's prefix 0212, not a verified copy of production"
say "# expected pending: $NEXP versions $(echo $EXPECTED | cut -c1-30)..."
[ "$NEXP" = "34" ] || { say "FAIL expected 34 files for 0213-0246, found $NEXP"; exit 1; }

reset_to_0212 || { say "FAIL could not reset to 0212 with TLS"; exit 1; }
N0="$(nvers)"; MAXV="$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')"
NPREFIX="$(ls supabase/migrations | awk -F_ '$1 <= "0212"' | wc -l)"
expect "(1) the synthetic DB is at production's prefix 0212 and its history holds exactly the repository's 0001-0212 files" "$([ "$MAXV" = "0212" ] && [ "$N0" = "$NPREFIX" ] && echo 0 || echo 1)" "max=$MAXV rows=$N0 files<=0212=$NPREFIX"
HAS0242="$(psqld -c "select count(*) from pg_proc where proname = 'record_studio_export_audit_governed'")"
expect "(1) 0242 is not present before the push" "$([ "$HAS0242" = "0" ] && echo 0 || echo 1)" "governed export fn count=$HAS0242"

for f in 0242-pause-guard.up.sql 0242-pause-export-guard.up.sql; do runsql "tests/db/fixtures/$f"; done
expect "(1) both window guards installed UP before the push" "$([ "$(count_triggers)" = "2" ] && echo 0 || echo 1)" "triggers=$(count_triggers)"

# ---- (a) dry run -----------------------------------------------------------------
SSL_CERT_FILE="$TLSDIR/server.crt" $CLI db push --db-url "$S1_URL" --dry-run > "$OUT/dryrun.log" 2>&1
DRC=$?
GOT="$(grep -oE '\b0[0-9]{3}_[a-z0-9_]+\.sql' "$OUT/dryrun.log" | cut -c1-4 | sort | uniq | tr '\n' ' ')"
sed 's/^/   | /' "$OUT/dryrun.log" | tail -n 45 | tee -a "$RES"
expect "(a) the dry run exits 0 and lists exactly the 34 versions 0213-0246, nothing else" "$([ "$DRC" = "0" ] && [ "$GOT" = "$EXPECTED" ] && echo 0 || echo 1)" "exit=$DRC listed=$(echo $GOT | wc -w) first=$(echo $GOT | cut -c1-4) last=$(echo $GOT | awk '{print $NF}')"
expect "(a) the dry run changed nothing" "$([ "$(nvers)" = "$N0" ] && echo 0 || echo 1)" "history rows=$(nvers)"

# ---- the S1 push -------------------------------------------------------------------
T0=$(date +%s)
SSL_CERT_FILE="$TLSDIR/server.crt" $CLI db push --db-url "$S1_URL" --yes > "$OUT/push.log" 2>&1
PRC=$?
say "-- S1 push: exit=$PRC elapsed=$(( $(date +%s) - T0 ))s"
sed 's/^/   | /' "$OUT/push.log" | tail -n 45 | tee -a "$RES"
expect "(2b) the push exits 0" "$([ "$PRC" = "0" ] && echo 0 || echo 1)" "exit=$PRC"
NEW="$(psqld -c "select string_agg(substr(version,1,4), ' ' order by version) from supabase_migrations.schema_migrations where version >= '0213'")"
expect "(2b) schema_migrations now holds exactly 0213-0246, in addition to the 0001-0212 rows" "$([ "$NEW" = "$(echo $EXPECTED)" ] && [ "$(nvers)" = "$((N0 + 34))" ] && echo 0 || echo 1)" "new rows=$(echo $NEW | wc -w) total=$(nvers)"
say "INFO  (2b) the CLI's columns for those rows (version | name | statements | md5 of the statements):"
psqld -c "select version || ' | ' || name || ' | ' || cardinality(statements) || ' | ' || md5(array_to_string(statements, E'\n')) from supabase_migrations.schema_migrations where version >= '0213' order by version" | sed 's/^/   | /' | tee -a "$RES"
expect "(2b) the guards survived the push" "$([ "$(count_triggers)" = "2" ] && echo 0 || echo 1)" "triggers=$(count_triggers)"

for f in 0242-pause-guard.down.sql 0242-pause-export-guard.down.sql; do runsql "tests/db/fixtures/$f"; done
expect "(3) both guards DOWN" "$([ "$(count_triggers)" = "0" ] && echo 0 || echo 1)" "triggers=$(count_triggers)"
capture pushed
expect "(3) the capture is not vacuous: the dump holds public, auth AND storage objects" "$(grep -q 'storage\.objects' "$OUT/cap-pushed/dump.sql" && grep -q 'auth\.users' "$OUT/cap-pushed/dump.sql" && grep -q 'public\.clients' "$OUT/cap-pushed/dump.sql" && echo 0 || echo 1)" "dump lines=$(wc -l < "$OUT/cap-pushed/dump.sql")"

# ---- (d) the push session: statement_timeout and lock_timeout as seen by a file ------
OBS="$OUT/obs"; rm -rf "$OBS"; mkdir -p "$OBS/supabase/migrations"
cp supabase/config.toml "$OBS/supabase/"
cp supabase/migrations/*.sql "$OBS/supabase/migrations/"
cat > "$OBS/supabase/migrations/0247_rehearsal_observe_session.sql" <<'SQL'
begin;
set local lock_timeout = '5s';
create table public.rehearsal_session_obs as
  select current_setting('statement_timeout') as statement_timeout,
         current_setting('lock_timeout') as lock_timeout,
         pg_backend_pid() as pid,
         current_setting('application_name') as app;
commit;
SQL
SSL_CERT_FILE="$TLSDIR/server.crt" $CLI db push --workdir "$OBS" --db-url "$S1_URL" --dry-run > "$OUT/obs-dry.log" 2>&1
OL="$(grep -oE '\b0[0-9]{3}_[a-z0-9_]+\.sql' "$OUT/obs-dry.log" | sort -u | tr '\n' ' ')"
expect "(d) observer dry run lists only the synthetic 0247" "$([ "$OL" = "0247_rehearsal_observe_session.sql " ] && echo 0 || echo 1)" "$OL"
SSL_CERT_FILE="$TLSDIR/server.crt" $CLI db push --workdir "$OBS" --db-url "$S1_URL" --yes > "$OUT/obs-push.log" 2>&1
ORC=$?
SV="$(psqld -c "select statement_timeout from public.rehearsal_session_obs")"; LV="$(psqld -c "select lock_timeout from public.rehearsal_session_obs")"
expect "(d) in the S1 push session a file sees statement_timeout=120s (2min) and its own lock_timeout=5s" "$([ "$ORC" = "0" ] && { [ "$SV" = "2min" ] || [ "$SV" = "120s" ]; } && [ "$LV" = "5s" ] && echo 0 || echo 1)" "exit=$ORC statement_timeout=$SV lock_timeout=$LV"
say "INFO  (d) application_name of the push session: $(psqld -c 'select app from public.rehearsal_session_obs')"

# ---- (2c)(e) failure injection on a COPY of the chain ----------------------------------
reset_to_0212 || { say "FAIL could not reset to 0212 for the failure injection"; exit 1; }
N1="$(nvers)"
INJ="$OUT/inj"; rm -rf "$INJ"; mkdir -p "$INJ/supabase/migrations"
cp supabase/config.toml "$INJ/supabase/"
for f in supabase/migrations/*.sql; do
  b="$(basename "$f")"; v="${b:0:4}"
  if [ "$v" -le 229 ]; then cp "$f" "$INJ/supabase/migrations/$b"
  else cp "$f" "$INJ/supabase/migrations/$(printf '%04d' $((10#$v + 1)))${b:4}"; fi   # byte-identical copies, one version later
done
cat > "$INJ/supabase/migrations/0230_synthetic_failure.sql" <<'SQL'
begin;
set local lock_timeout = '5s';
create table public.synthetic_partial (i int);
insert into public.synthetic_partial values (1);
select 1 / 0;
commit;
SQL
cat > "$INJ/supabase/migrations/0999_synthetic_after.sql" <<'SQL'
begin;
create table public.synthetic_after (i int);
commit;
SQL
SSL_CERT_FILE="$TLSDIR/server.crt" $CLI db push --workdir "$INJ" --db-url "$S1_URL" --yes > "$OUT/inj-push.log" 2>&1
IRC=$?
sed 's/^/   | /' "$OUT/inj-push.log" | tail -n 30 | tee -a "$RES"
expect "(e) the CLI exits NON-ZERO on the failing file" "$([ "$IRC" != "0" ] && echo 0 || echo 1)" "exit=$IRC"
expect "(e) it reports the division by zero (22012) and names the failing file" "$(grep -qiE '22012|division by zero' "$OUT/inj-push.log" && grep -q '0230_synthetic_failure' "$OUT/inj-push.log" && echo 0 || echo 1)" "error text found"
IV="$(psqld -c "select string_agg(substr(version,1,4), ' ' order by version) from supabase_migrations.schema_migrations where version >= '0213'")"
EXP17="$(echo $EXPECTED | awk '{for (i = 1; i <= 17; i++) printf "%s%s", $i, (i < 17 ? " " : "")}')"
expect "(c) files before the failure are applied AND recorded (0213-0229), nothing else" "$([ "$IV" = "$EXP17" ] && [ "$(nvers)" = "$((N1 + 17))" ] && echo 0 || echo 1)" "recorded=$(echo $IV | wc -w) first=$(echo $IV | cut -c1-4) last=$(echo $IV | awk '{print $NF}')"
expect "(c) the failing file recorded nothing and its partial DDL/DML rolled back" "$([ "$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version = '0230'")" = "0" ] && [ "$(psqld -c "select coalesce(to_regclass('public.synthetic_partial')::text, 'absent')")" = "absent" ] && echo 0 || echo 1)" "version 0230 rows=$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version = '0230'") partial=$(psqld -c "select coalesce(to_regclass('public.synthetic_partial')::text, 'absent')")"
expect "(c) nothing after the failure ran (the next real file and the synthetic after-file)" "$([ "$(psqld -c "select count(*) from information_schema.columns where table_schema='public' and table_name='client_intake_forms' and column_name='questionnaire_snapshot'")" = "0" ] && [ "$(psqld -c "select coalesce(to_regclass('public.synthetic_after')::text, 'absent')")" = "absent" ] && echo 0 || echo 1)" "0246's column absent; synthetic_after absent"

# ---- plain-psql path (what #1157 did): applies, records nothing -------------------------
reset_to_0212 || { say "FAIL could not reset to 0212 for the psql path"; exit 1; }
N2="$(nvers)"
for f in $(ls supabase/migrations | awk -F_ '$1 >= "0213" && $1 <= "0246"' | sort); do runsql "supabase/migrations/$f"; done
expect "(2b) the plain-psql path (#1157) applied 0213-0246 but recorded NOTHING in schema_migrations" "$([ "$(nvers)" = "$N2" ] && [ "$(psqld -c "select count(*) from information_schema.columns where table_schema='public' and table_name='client_intake_forms' and column_name='questionnaire_snapshot'")" = "1" ] && echo 0 || echo 1)" "history rows before=$N2 after=$(nvers); 0246 column present"

# ---- control: the normal way, no guards ---------------------------------------------------
say "-- control chain: supabase db reset --local (all of 0001-0246, no guards)"
$CLI db reset --local --yes > "$OUT/reset-control.log" 2>&1 || { tail -n 20 "$OUT/reset-control.log"; FAILS=$((FAILS + 1)); }
for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
capture control
say "== COMPARISON: S1-push chain (guards up then down) vs the guard-free control (control = '-', pushed = '+')"
compare pushed control

# ---- (d) Photos' probes, reused verbatim, against this TLS database -------------------------
say "== Photos' timeout probes (#1147's script, byte-identical) against this synthetic cluster"
REHEARSAL_PGHOST="$HOST" REHEARSAL_PGPORT="$PORT" REHEARSAL_PGPASSWORD="$PW" REHEARSAL_OUT="$OUT/photos" SSL_CERT_FILE="$TLSDIR/server.crt" \
  bash scripts/ci/timeout-rehearsal.sh > "$OUT/photos.log" 2>&1
KRC=$?
grep -E '^(PASS|FAIL|RESULT|INFO|# verdict|# residual)' "$OUT/photos.log" | tee -a "$RES"
expect "(d) Photos' probes: ALL EXPECTATIONS MET (statement_timeout fires at ~120s, lock_timeout fires at ~5s, CLI stops)" "$KRC" "exit=$KRC"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
