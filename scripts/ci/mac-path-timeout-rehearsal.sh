#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. MAC-PATH: which control puts a timeout on the migration session the supabase-go CLI uses through the local Supavisor SESSION pooler, and what a server-side cancellation and a local interruption leave behind. Synthetic only.
# pooler (enabled in CI only), with the verified linux_amd64 CLI binary, against a SYNTHETIC
# database built through production's prefix 0212 (NOT a verified copy of production data or
# configuration). The hosted Supavisor version is unknown: everything here is synthetic evidence.
# Nothing touches a hosted project. Canary values only.
set -u

DB="${DB:?the supabase db container name}"
OUT="${REHEARSAL_OUT:?}"
PORT=54322
PPORT=54329
PW=postgres
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"
: > "$RES"
say() { echo "$*" | tee -a "$RES"; }
expect() { # expect <label> <0 = met> <observed>
  if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi
}
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sadm() { docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }
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
  local sa=(docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -A -t -v ON_ERROR_STOP=1)
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
  local try
  for try in 1 2 3; do
    $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 && break
    say "WARN db reset attempt $try failed: $(tail -n 3 "$OUT/reset-0212.log" | tr '\n' ' ' | cut -c1-200)"
    sleep 15
    [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations' 2> /dev/null)" = "0212" ] && { say "INFO  history max is 0212 despite the failed restart step; continuing"; break; }
  done
  for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
  ensure_tls || return 1
}

# ---- setup ---------------------------------------------------------------------------------
command -v psql > /dev/null || { sudo apt-get update -qq > /dev/null 2>&1; sudo apt-get install -y -qq postgresql-client > /dev/null 2>&1; }
say "# pooler rehearsal; psql: $(psql --version)"
RUNNER_IP="$(hostname -I | awk '{print $1}')"
VER=2.102.0
REL="https://github.com/supabase/cli/releases/download/v$VER"
dl() { env -u SSL_CERT_FILE curl "$@"; }
REPO="$PWD"
WORK="$OUT/archive"; mkdir -p "$WORK"
( cd "$WORK" && dl -fsSL -O "$REL/checksums.txt" -O "$REL/supabase_${VER}_linux_amd64.tar.gz" ) || { say "FAIL download"; exit 1; }
( cd "$WORK" && grep ' supabase_2.102.0_linux_amd64.tar.gz$' checksums.txt | sha256sum -c - ) > "$OUT/verify.txt" 2>&1; rc=$?
expect "the linux_amd64 release archive verifies against checksums.txt (S1 step 0.2)" "$rc" "$(tr '\n' ' ' < "$OUT/verify.txt")"
mkdir -p "$REPO/supabase-cli" && tar -xzf "$WORK/supabase_${VER}_linux_amd64.tar.gz" -C "$REPO/supabase-cli"
BIN="$REPO/supabase-cli/supabase"
GOBIN="$REPO/supabase-cli/supabase-go"
chmod +x "$GOBIN"
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
expect "the extracted supabase-go has the recorded inner sha256" "$([ "$(sha256sum "$GOBIN" | cut -d" " -f1)" = "$GOSHA" ] && echo 0 || echo 1)" "$(sha256sum "$GOBIN" | cut -c1-16)... version: $($GOBIN --version 2>&1 | tail -1)"
CLI="npx --yes supabase@2.102.0"   # only for db reset of the synthetic stack; every S1 run uses $BIN
expect "the extracted binary prints $VER" "$([ "$($BIN --version 2>&1 | tail -1)" = "$VER" ] && echo 0 || echo 1)" "version"

POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"
say "INFO  pooler container: ${POOLER:-NONE}"
[ -n "$POOLER" ] || { docker ps -a --format '{{.Names}} {{.Status}}' | sed 's/^/   | /' | tee -a "$RES"; say "FAIL no pooler container"; exit 1; }
PIMG="$(docker inspect -f '{{.Config.Image}}' "$POOLER")"
PIMGID="$(docker inspect -f '{{.Image}}' "$POOLER")"
PDIG="$(docker image inspect -f '{{join .RepoDigests ","}}' "$PIMG" 2> /dev/null)"
TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"
TENANT="${TENANT:-pooler-dev}"
PUSER="postgres.$TENANT"
say "INFO  (e) local Supavisor image: tag=$PIMG id=$PIMGID digests=${PDIG:-none}; tenant user=$PUSER; pool_mode in tracked-config-as-edited: $(grep -A8 '^\[db.pooler\]' supabase/config.toml | grep -E '^(enabled|pool_mode)' | tr '\n' ' ')"
say "INFO  (e) the HOSTED Supavisor version is UNKNOWN; every result below is synthetic evidence about the LOCAL image only."

purl() { # purl <sslmode> [options-string]   (no password)
  echo "postgresql://$PUSER@$RUNNER_IP:$PPORT/postgres?sslmode=$1${2:+&options=$2}"
}
OPT_S1="-c%20statement_timeout%3D120000"
pq() { # pq <password> <url> <psql args...>
  local pw="$1" url="$2"; shift 2
  PGPASSWORD="$pw" PGCONNECT_TIMEOUT=15 psql "$url" -X -v VERBOSITY=verbose -v ON_ERROR_STOP=0 "$@" 2>&1
}
wait_pooler() { # wait_pooler <password> <sslmode>
  for _ in $(seq 1 45); do pq "$1" "$(purl "$2")" -At -c 'select 1' | grep -qx 1 && return 0; sleep 2; done
  return 1
}
diag_pooler() {
  say "DIAG  pooler container status/log tail:"
  docker ps -a --filter "name=$POOLER" --format '   | {{.Names}} {{.Status}} {{.Ports}}' | tee -a "$RES"
  docker logs --tail 40 "$POOLER" 2>&1 | cut -c1-240 | sed 's/^/   | /' | tee -a "$RES"
}

say "== sslmode actually supported by the local pooler (the pinned CLI attempts TLS first)"
TLSP=54330
SSLM=""
for m in require prefer disable; do
  r="$(pq "$PW" "$(purl $m)" -At -c 'select 1' | tr '\n' ' ' | cut -c1-160)"
  say "   | sslmode=$m -> $r"
  [ -z "$SSLM" ] && echo "$r" | grep -q '^1 *$' && SSLM=$m
done
if [ -z "$SSLM" ]; then diag_pooler; say "FAIL the pooler accepts no connection with password $PW"; exit 1; fi
say "INFO  strongest sslmode that works through the local pooler: $SSLM"
say "RESULT the local Supavisor accepts sslmode=require: $([ "$SSLM" = require ] && echo yes || echo NO); strongest psql mode that works: $SSLM. The CLI (pgx) fails against the plain pooler with 'tls error (server refused TLS connection)' even for prefer, so CLI runs go through the TLS relay on :$TLSP with sslmode=require."

# The local Supavisor refuses TLS and the pinned CLI always attempts it (the hosted pooler accepts it): a relay that is NOT
# Supavisor (scripts/ci/pooler-tlsfront.py) answers SSLRequest, terminates TLS and forwards plain bytes, standing in for it.
mkdir -p "$TLSDIR"; [ -f "$TLSDIR/server.crt" ] || openssl req -new -x509 -days 1 -nodes -text -out "$TLSDIR/server.crt" -keyout "$TLSDIR/server.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" > /dev/null 2>&1
python3 scripts/ci/pooler-tlsfront.py "$OUT/tls/server.crt" "$OUT/tls/server.key" "$TLSP" "$PPORT" > "$OUT/tlsfront.log" 2>&1 &
sleep 1
say "INFO  TLS front on :$TLSP -> pooler :$PPORT: $(pq "$PW" "postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require" -At -c 'select 1 as ok' | tr '\n' ' ')"


# ======================================================================================
# MAC-PATH part 2. Everything below runs the supabase-go CLI through the TLS front and the
# local Supavisor SESSION pooler as the pooled role postgres.$TENANT (upstream role: postgres).
# ======================================================================================
S1ENV=(SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false)
CANARY=S1canarypw8K3x
set_pw() { sadm -c "alter role postgres password '$1'" > /dev/null; }
role_reset() { sadm -c "alter role postgres reset statement_timeout; alter role postgres reset lock_timeout; alter role postgres reset client_connection_check_interval" > /dev/null 2>&1; }
trap 'role_reset; sadm -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1' EXIT
reset_ready() {
  role_reset
  reset_to_0212 || { say "FAIL reset"; exit 1; }
  set_pw "$CANARY"
  if wait_pooler "$CANARY" "$SSLM"; then PWU="$CANARY"; else set_pw "$PW"; PWU="$PW"; wait_pooler "$PW" "$SSLM" || { diag_pooler; say "FAIL pooler unusable"; exit 1; }; fi
}
mkwd() {
  rm -rf "$1"; mkdir -p "$1/supabase/migrations" "$1/supabase/.temp"
  cp "$REPO/supabase/config.toml" "$1/supabase/config.toml"
  for f in "$REPO"/supabase/migrations/*.sql; do b="$(basename "$f")"; [ "${b%%_*}" -le 212 ] 2> /dev/null && cp "$f" "$1/supabase/migrations/$b"; done
  echo "v$VER" > "$1/supabase/.temp/cli-latest"
}
clean_probe() { sadm -c "delete from supabase_migrations.schema_migrations where version >= '0213'; drop table if exists public.mp_a, public.mp_b, public.mp_c, public.mp_obs" > /dev/null 2>&1; }
hist_ge() { psqld -c "select coalesce(string_agg(version, ',' order by version), 'none') from supabase_migrations.schema_migrations where version >= '0213'"; }
marks() { psqld -c "select coalesce(string_agg(replace(tablename, 'mp_', ''), ',' order by tablename), 'none') from pg_tables where schemaname = 'public' and tablename in ('mp_a','mp_b','mp_c')"; }
# the real #1035 header shape in every file: begin; set local lock_timeout; ...; commit;
mig() { printf 'begin;\nset local lock_timeout = '"'5s'"';\n%s\ncommit;\n' "$3" > "$1/supabase/migrations/$2.sql"; }
OBS="create table if not exists public.mp_obs (file text, statement_timeout text, lock_timeout text, pid int, app text);"
obs() { echo "insert into public.mp_obs values ('$1', current_setting('statement_timeout'), current_setting('lock_timeout'), pg_backend_pid(), current_setting('application_name'));"; }
URL="postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require"
cli() { # cli <workdir> <extra url query> [env assignments...]  (foreground; sets RC, ELAPSED)
  local wd="$1" q="$2"; shift 2; local t0=$SECONDS
  ( cd "$wd" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$@" "$GOBIN" db push --db-url "$URL$q" --yes > "$wd/push.log" 2>&1; echo $? > "$wd/rc" )
  RC="$(cat "$wd/rc")"; ELAPSED=$((SECONDS - t0))
}
newpool_backends() { # drop every upstream backend the pooler is holding for role postgres, so the next client gets a NEW one
  sadm -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = 'postgres' and backend_type = 'client backend' and pid <> pg_backend_pid()" | tr '\n' ' '
}
OPT120="&options=-c%20statement_timeout%3D120000"

say "# MAC-PATH part 2: supabase-go $($GOBIN --version 2>&1 | head -1), pooler tenant user $PUSER"

# ---------- (a) what the URL option / PGOPTIONS give the CLI's own migration backend (control) ----------
say "== (a) URL options and PGOPTIONS: what statement_timeout does the migration backend of the CLI see?"
reset_ready; clean_probe
WA="$OUT/wd-a"; mkwd "$WA"
mig "$WA" 0213_obs "$OBS
$(obs f1)"
cli "$WA" "$OPT120" "PGOPTIONS=-c statement_timeout=120000"
A_SEEN="$(psqld -c "select statement_timeout || '/' || lock_timeout || '/' || app from public.mp_obs where file = 'f1'")"
say "   | exit=$RC; migration backend saw (statement_timeout/lock_timeout/application_name): $A_SEEN"
expect "(a) through the pooler neither the URL option nor PGOPTIONS reaches the migration backend (statement_timeout 0); the file's own set local lock_timeout does (5s)" \
  "$(case "$A_SEEN" in 0/5s/*) echo 0 ;; *) echo 1 ;; esac)" "$A_SEEN"

# ---------- (c) role-level setting: applies to NEW pooled backends ----------------------------------
say "== (c) role-level ALTER ROLE postgres SET statement_timeout / lock_timeout on the SYNTHETIC target"
reset_ready; clean_probe
sadm -c "alter role postgres set statement_timeout = '20s'; alter role postgres set lock_timeout = '8s'"
say "   | role configuration: $(sadm -c "select array_to_string(rolconfig, ',') from pg_roles where rolname = 'postgres'")"
say "   | before dropping the held upstream backends, a pooled connection reads: $(pq "$PWU" "$(purl "$SSLM")" -At -c 'show statement_timeout' -c 'show lock_timeout' | tr '\n' ' ')"
say "   | upstream postgres backends terminated so the pooler must open new ones: $(newpool_backends)"
sleep 3
C_NEW="$(pq "$PWU" "$(purl "$SSLM")" -At -c 'show statement_timeout' -c 'show lock_timeout' | tr '\n' ' ')"
say "   | a NEW pooled connection with NO options reads: $C_NEW"
expect "(c) after the held backends are dropped, a new pooled connection carries the role setting (20s / 8s)" "$([ "$C_NEW" = "20s 8s " ] && echo 0 || echo 1)" "$C_NEW"
WC="$OUT/wd-c"; mkwd "$WC"
mig "$WC" 0213_obs "$OBS
$(obs f1)"
cli "$WC" ""
C_SEEN="$(psqld -c "select statement_timeout || '/' || lock_timeout from public.mp_obs where file = 'f1'")"
say "   | the CLI's own migration backend saw (statement_timeout/lock_timeout): $C_SEEN; the file sets local lock_timeout 5s after it begins, so the role's 8s is what shows BEFORE the file's own statement only through current_setting at start; recorded value above is read after that set local"
expect "(c) the role setting reaches the CLI's migration backend: statement_timeout 20s (lock_timeout shows the file's own 5s)" "$([ "$C_SEEN" = "20s/5s" ] && echo 0 || echo 1)" "$C_SEEN"

# ---------- (c-cancel) server-side cancellation inside a migration file, with the role setting ---------
say "== (c-cancel) a 90 s statement in file 0214, role statement_timeout=20s: server-side 57014, CLI exit, history, earlier files kept"
clean_probe
WK="$OUT/wd-cancel"; mkwd "$WK"
mig "$WK" 0213_a "create table public.mp_a (i int);"
mig "$WK" 0214_slow "create table public.mp_b (i int);
select pg_sleep(90);"
mig "$WK" 0215_c "create table public.mp_c (i int);"
cli "$WK" ""
K_HIST="$(hist_ge)"; K_MARK="$(marks)"
say "   | exit=$RC elapsed=${ELAPSED}s history>=0213: $K_HIST tables: $K_MARK"
tail -n 6 "$WK/push.log" | sed 's/^/   | /' | tee -a "$RES"
expect "(c-cancel) the CLI exits 1 with 57014 at about the role's 20 s (not 90 s), 0213 stays recorded, 0214 is NOT recorded and its table rolled back, 0215 did not run" \
  "$([ "$RC" = 1 ] && grep -q '57014' "$WK/push.log" && [ "$ELAPSED" -ge 15 ] && [ "$ELAPSED" -le 40 ] && [ "$K_HIST" = 0213 ] && [ "$K_MARK" = a ] && echo 0 || echo 1)" "exit=$RC elapsed=${ELAPSED}s history=$K_HIST tables=$K_MARK"
say "   | and the server does not leave the cancelled statement running: $(sadm -c "select count(*) from pg_stat_activity where query like '%pg_sleep(90)%' and pid <> pg_backend_pid()")"

# ---------- (i) interruption: kill the LOCAL CLI during a long statement; is the SERVER statement ended? --
say "== (i) interruption: kill the local CLI while a statement runs; role statement_timeout raised to 5min so the timeout is not what ends it"
interrupt_case() { # interrupt_case <label> <signal>
  local label="$1" sig="$2" WI="$OUT/wd-int-$1"
  reset_ready; clean_probe
  sadm -c "alter role postgres set statement_timeout = '5min'"; newpool_backends > /dev/null; sleep 3
  mkwd "$WI"
  mig "$WI" 0213_a "create table public.mp_a (i int);"
  mig "$WI" 0214_slow "create table public.mp_b (i int);
select pg_sleep(100);"
  ( cd "$WI" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" db push --db-url "$URL" --yes > "$WI/push.log" 2>&1; echo $? > "$WI/rc" ) &
  local pid=""
  for _ in $(seq 1 40); do
    pid="$(sadm -c "select pid from pg_stat_activity where query like '%pg_sleep(100)%' and state = 'active' and pid <> pg_backend_pid() limit 1")"
    [ -n "$pid" ] && break; sleep 1
  done
  say "   | $label: server backend running the long statement: pid=${pid:-NONE}; CLI process: $(pgrep -f "supabase-go db push" | head -1)"
  local cpid; cpid="$(pgrep -f "supabase-go db push" | head -1)"
  kill "-$sig" "$cpid" 2> /dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$cpid" 2> /dev/null || break; sleep 1; done
  say "   | $label: sent SIG$sig to the local CLI (pid ${cpid:-none})"
  local still="" waited=0
  for w in 5 10 20 30; do
    sleep $((w - waited)); waited=$w
    still="$(sadm -c "select state || ' since ' || (now() - state_change)::text from pg_stat_activity where pid = $pid")"
    say "   | $label: ${w}s after the kill, server backend $pid: ${still:-GONE}"
    [ -z "$still" ] && break
  done
  INT_STILL="$still"; INT_PID="$pid"
  say "   | $label: history>=0213: $(hist_ge); tables: $(marks)"
  INT_HIST="$(hist_ge)"
}
interrupt_case term TERM
INT_TERM_STILL="$INT_STILL"; INT_TERM_PID="$INT_PID"
if [ -n "$INT_TERM_STILL" ]; then
  say "RESULT (i-term) killing the local CLI (SIGTERM) did NOT end the server statement: backend $INT_TERM_PID still $INT_TERM_STILL after 30 s"
else
  say "RESULT (i-term) the server ended the statement after the local CLI died (the pooler/server noticed the disconnect)"
fi
# the safe-interruption step: end the server statement from a second session and read-only reconcile
if [ -n "$INT_TERM_STILL" ]; then
  say "   | safe procedure step: cancel from a second pooled session: $(pq "$PWU" "$(purl "$SSLM")" -At -c "select pg_cancel_backend($INT_TERM_PID)" | tr '\n' ' ')"
  sleep 3
  say "   | after pg_cancel_backend: backend $INT_TERM_PID: $(sadm -c "select state from pg_stat_activity where pid = $INT_TERM_PID")"
  say "   | read-only reconcile: history>=0213: $(hist_ge); tables: $(marks)"
fi
interrupt_case kill KILL
INT_KILL_STILL="$INT_STILL"
if [ -n "$INT_KILL_STILL" ]; then say "RESULT (i-kill) SIGKILL of the local CLI did NOT end the server statement: still $INT_KILL_STILL after 30 s"; else say "RESULT (i-kill) the server ended the statement after the local CLI was killed (SIGKILL)"; fi
role_reset

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
