#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. PUSH-IMAGE-PULL: why `supabase@2.102.0 db push --db-url`
# pulls the edge-runtime image at the END of a push, whether it also does so for a
# non-loopback (remote-looking) host, what happens when that pull fails or the
# registry is unreachable, and how to avoid it. DISPOSABLE, SYNTHETIC local
# database through production's prefix 0212; nothing touches a hosted project.
#
# Source reading (cli tag v2.102.0, commit 0ad96872): internal/db/push/push.go calls
# pgcache.TryCacheMigrationsCatalog after ApplyMigrations; it returns early unless
# ShouldCacheMigrationsCatalog() = utils.IsPgDeltaEnabled() || EXPERIMENTAL_PG_DELTA,
# and IsPgDeltaEnabled() is Config.Experimental.PgDelta.Enabled, which this
# repository's tracked supabase/config.toml sets to true ([experimental.pgdelta]).
# A failure there only prints "Warning: failed to cache migrations catalog:".
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
  $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 || { tail -n 20 "$OUT/reset-0212.log"; return 1; }
  for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
  ensure_tls || return 1
}


# ---- helpers for this rehearsal ------------------------------------------------------
# The same pinned CLI, installed once up front so a blocked registry cannot also block npx.
npm install --prefix "$OUT/cli" supabase@2.102.0 > "$OUT/cli-install.log" 2>&1 || { tail -n 20 "$OUT/cli-install.log"; exit 1; }
CLI="$OUT/cli/node_modules/.bin/supabase"
say "INFO  pinned CLI binary for the blocked-registry runs: $($CLI --version 2> /dev/null | tail -1)"
# Registry outage without touching the runner's own connectivity: point the registry names at a
# refusing address (127.0.0.1, fast failure) or at a blackhole (192.0.2.1, packets go nowhere).
block_registry() { # block_registry <127.0.0.1|192.0.2.1>
  echo "$1 public.ecr.aws ghcr.io # push-image-pull rehearsal" | sudo tee -a /etc/hosts > /dev/null
}
unblock_registry() { sudo sed -i '/# push-image-pull rehearsal$/d' /etc/hosts; }
trap unblock_registry EXIT
export SSL_CERT_FILE="$TLSDIR/server.crt"
ECR=public.ecr.aws/supabase/edge-runtime
GHCR=ghcr.io/supabase/edge-runtime
rmi_edge() { docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '/edge-runtime:' | xargs -r docker rmi -f > /dev/null 2>&1; true; }
edge_present() { docker images --format '{{.Repository}}:{{.Tag}}' | grep -cE '/edge-runtime:'; }
hist_sig() { psqld -c "select md5(string_agg(version || '|' || name || '|' || md5(array_to_string(statements, E'\n')), ';' order by version)) from supabase_migrations.schema_migrations where version >= '0213'"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }
RUNNER_IP="$(hostname -I | awk '{print $1}')"
LOOP_URL="$S1_URL"
REMOTE_URL="postgresql://postgres:$PW@$RUNNER_IP:$PORT/postgres?sslmode=require&options=-c%20statement_timeout%3D120000"

fresh() { # fresh <label>: database at 0212, no edge-runtime image, no cached catalogs
  reset_to_0212 || { say "FAIL could not reset to 0212 for $1"; exit 1; }
  rmi_edge
  rm -rf supabase/.temp/pgdelta
}
run_push() { # run_push <label> <url> [workdir] [timeout seconds]; sets RC ELAPSED; env prefix comes from the caller
  local label="$1" url="$2" wd="${3:-}" to="${4:-900}" t0
  t0=$(date +%s)
  if [ -n "$wd" ]; then
    timeout "$to" $CLI db push --workdir "$wd" --db-url "$url" --yes > "$OUT/$label.log" 2>&1
  else
    timeout "$to" $CLI db push --db-url "$url" --yes > "$OUT/$label.log" 2>&1
  fi
  RC=$?
  ELAPSED=$(( $(date +%s) - t0 ))
  say "-- $label: exit=$RC elapsed=${ELAPSED}s history_rows=$(hist_n) edge-runtime image present afterwards=$(edge_present)"
  grep -nE "Connecting to|Pulling from|Warning|Finished supabase db push|Applying migration 0246|failed to|error|Error" "$OUT/$label.log" | cut -c1-230 | sed 's/^/   | /' | head -14 | tee -a "$RES"
}

say "# push-image-pull rehearsal: $($CLI --version 2> /dev/null | tail -1); runner non-loopback IP is used for the remote-URL run (not printed)"
say "# tracked config: $(grep -A1 '^\[experimental.pgdelta\]' supabase/config.toml | tr '\n' ' ')"

# T0: control - the final history signature a normal 'db reset' produces for 0213-0246
$CLI db reset --local --yes > "$OUT/reset-control.log" 2>&1
for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
CTRL_SIG="$(hist_sig)"; CTRL_N="$(hist_n)"
say "INFO  control chain (normal db reset): rows 0213-0246=$CTRL_N signature=$CTRL_SIG"

# T1: (1) WHY - loopback URL, tracked config (pgdelta enabled), default registry
fresh t1
run_push t1-loopback-default "$LOOP_URL"
pull_attempts() { grep -cE 'Pulling from supabase/edge-runtime|failed to pull docker image' "$1"; }
expect "(1) the pull is ATTEMPTED with the tracked config (loopback URL)" "$([ "$(pull_attempts "$OUT/t1-loopback-default.log")" -ge 1 ] && echo 0 || echo 1)" "attempt lines=$(pull_attempts "$OUT/t1-loopback-default.log") image present=$(edge_present) exit=$RC"
say "INFO  (1) catalog cache files written (success of the post-push step):"
ls supabase/.temp/pgdelta 2> /dev/null | sed 's/^/   | /' | tee -a "$RES"
T1_RC=$RC; T1_SIG="$(hist_sig)"; T1_N="$(hist_n)"

# T1b: same through the ghcr.io mirror, so a success path exists even when ecr.aws throttles
fresh t1b
SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io run_push t1b-loopback-ghcr "$LOOP_URL"
say "INFO  (1) catalog cache files after the ghcr.io-mirror run:"
ls supabase/.temp/pgdelta 2> /dev/null | sed 's/^/   | /' | tee -a "$RES"

# T2: remote-looking (non-loopback) host
fresh t2
run_push t2-remote-default "$REMOTE_URL"
expect "(1) with a NON-LOOPBACK host the CLI says 'remote database' (not the loopback 'local database')" "$(grep -q 'Connecting to remote database' "$OUT/t2-remote-default.log" && echo 0 || echo 1)" "$(grep -m1 'Connecting to' "$OUT/t2-remote-default.log")"
expect "(1) the pull is ALSO attempted for the non-loopback host" "$([ "$(pull_attempts "$OUT/t2-remote-default.log")" -ge 1 ] && echo 0 || echo 1)" "attempt lines=$(pull_attempts "$OUT/t2-remote-default.log") image present=$(edge_present) exit=$RC"
expect "(1) the remote-URL push applied and recorded 0213-0246 identically to the control" "$([ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n) sig=$(hist_sig)"

# T2b: remote-looking host through the ghcr.io mirror, so the pull SUCCEEDS and the whole post-push step runs
fresh t2b
SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io run_push t2b-remote-ghcr "$REMOTE_URL"
expect "(1) non-loopback host, pull succeeds: the image is pulled and the catalog cache file is written (the step runs for a remote URL exactly as for loopback)" "$([ "$(edge_present)" -ge 1 ] && [ "$(ls supabase/.temp/pgdelta 2> /dev/null | wc -l)" -ge 1 ] && echo 0 || echo 1)" "image present=$(edge_present) cache files: $(ls supabase/.temp/pgdelta 2> /dev/null | cut -c1-40 | tr '\n' ' ')"
say "INFO  (1) T2b output around the post-push step:"
grep -nE "Connecting to|Pulling from|Applying migration 0246|Warning|Finished" "$OUT/t2b-remote-ghcr.log" | cut -c1-200 | sed 's/^/   | /' | tee -a "$RES"

# T4: (2) registry UNREACHABLE (fast refusal): the registry names resolve to a refusing address
fresh t4
block_registry 127.0.0.1
run_push t4-registry-rejected "$LOOP_URL"
unblock_registry
expect "(2) with the registry refusing connections the migrations are still applied AND recorded (all 34, identical signature)" "$([ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n)"
say "INFO  (2) exit code with the registry refusing: $RC; warning line: $(grep -m1 'Warning: failed to cache' "$OUT/t4-registry-rejected.log" | cut -c1-200)"
T4_RC=$RC

# T5: (2) registry BLACKHOLED (packets dropped): how long does the push hang, and how does it end
fresh t5
block_registry 192.0.2.1
run_push t5-registry-blackholed "$LOOP_URL" "" 1200
unblock_registry
expect "(2) with the registry blackholed the migrations are still applied AND recorded" "$([ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n) elapsed=${ELAPSED}s exit=$RC (124 = killed by the 1200 s cap)"
T5_RC=$RC; T5_EL=$ELAPSED

# T6: (3) Docker absent from the CLI's point of view
fresh t6
DOCKER_HOST=unix:///nonexistent/docker.sock run_push t6-docker-absent "$LOOP_URL"
expect "(3) with no Docker the push still applies and records all 34" "$([ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n) exit=$RC"
say "INFO  (3) docker-absent exit code: $RC; warning line: $(grep -m1 'Warning: failed to cache' "$OUT/t6-docker-absent.log" | cut -c1-200)"

# T7: (3) env override of the config key
fresh t7
SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false run_push t7-env-override "$LOOP_URL"
expect "(3) SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false: no pull attempt, no warning, exit 0, 34 applied and recorded identically" "$([ "$RC" = "0" ] && [ "$(pull_attempts "$OUT/t7-env-override.log")" = "0" ] && ! grep -q 'Warning' "$OUT/t7-env-override.log" && [ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "exit=$RC rows=$(hist_n) attempts=$(pull_attempts "$OUT/t7-env-override.log") image present=$(edge_present)"
T7_PULL="$(edge_present)"

echo "---- T7 head and tail of the output (loopback, env-override form) ----" | tee -a "$RES"
{ sed -n '1,3p' "$OUT/t7-env-override.log"; echo '   ...'; tail -n 4 "$OUT/t7-env-override.log"; } | sed 's/^/   | /' | tee -a "$RES"

# T8: (3) a scratch workdir: byte-identical migrations, a config.toml WITHOUT the pgdelta table
fresh t8
WD="$OUT/wd-nopgdelta"; rm -rf "$WD"; mkdir -p "$WD/supabase/migrations"
cp supabase/migrations/*.sql "$WD/supabase/migrations/"
awk 'BEGIN{skip=0} /^\[experimental\.pgdelta\]/{skip=1; next} skip && /^\[/{skip=0} !skip{print}' supabase/config.toml > "$WD/supabase/config.toml"
expect "(3) the scratch migrations are byte-identical to the tree's (sha256 of the whole directory)" "$([ "$(cd supabase/migrations && cat *.sql | sha256sum)" = "$(cd "$WD/supabase/migrations" && cat *.sql | sha256sum)" ] && echo 0 || echo 1)" "$(cd "$WD/supabase/migrations" && ls | wc -l) files"
expect "(3) the scratch config.toml has no pgdelta table" "$(grep -q pgdelta "$WD/supabase/config.toml" && echo 1 || echo 0)" "lines=$(wc -l < "$WD/supabase/config.toml")"
run_push t8-workdir-nopgdelta "$LOOP_URL" "$WD"
expect "(3) workdir without pgdelta: NO pull, NO edge-runtime image, exit 0, 34 files applied and recorded identically" "$([ "$RC" = "0" ] && [ "$(edge_present)" = "0" ] && [ "$(grep -c 'Pulling from' "$OUT/t8-workdir-nopgdelta.log")" = "0" ] && [ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "exit=$RC image present=$(edge_present) rows=$(hist_n)"

# T9: the env-override form, on the NON-LOOPBACK url, with the registry refusing (nothing in the push may depend on it)
fresh t9
block_registry 127.0.0.1
SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false run_push t9-remote-envoverride-registry-down "$REMOTE_URL"
unblock_registry
expect "(3) env override + remote URL + registry down: exit 0, no warning, no pull attempt, 34 applied and recorded identically" "$([ "$RC" = "0" ] && ! grep -q 'Warning' "$OUT/t9-remote-envoverride-registry-down.log" && [ "$(pull_attempts "$OUT/t9-remote-envoverride-registry-down.log")" = "0" ] && [ "$(hist_n)" = "$CTRL_N" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "exit=$RC rows=$(hist_n)"
echo "---- T9 full output: the expected lines for the step table (env-override form, non-loopback URL) ----" | tee -a "$RES"
sed 's/^/   | /' "$OUT/t9-remote-envoverride-registry-down.log" | tee -a "$RES"

say "SUMMARY exit codes: loopback+pull(T1)=$T1_RC registry-rejected(T4)=$T4_RC registry-blackholed(T5)=$T5_RC after ${T5_EL}s; env-override left image present=$T7_PULL"
say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
