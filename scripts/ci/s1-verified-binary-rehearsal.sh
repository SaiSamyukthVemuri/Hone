#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. S1-VERIFIED-BINARY: the S1 procedure with a CLI binary that
# is VERIFIED before it is given a database password, and with the pgdelta catalog step
# switched off by SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false. Disposable SYNTHETIC local
# database through production's prefix 0212 (not a copy of production); nothing touches
# a hosted project. See 01-ops/S1-COMMAND-WARNING-PGDELTA.md section 3-4.
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



# ---- helpers ------------------------------------------------------------------------------
export SSL_CERT_FILE="$TLSDIR/server.crt"
hist_sig() { psqld -c "select md5(string_agg(version || '|' || name || '|' || md5(array_to_string(statements, E'\n')), ';' order by version)) from supabase_migrations.schema_migrations where version >= '0213'"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }
pull_attempts() { grep -cE 'Pulling from supabase/edge-runtime|failed to pull docker image' "$1"; }
RUNNER_IP="$(hostname -I | awk '{print $1}')"
REMOTE_URL="postgresql://postgres:$PW@$RUNNER_IP:$PORT/postgres?sslmode=require&options=-c%20statement_timeout%3D120000"
VER=2.102.0
# SSL_CERT_FILE points at the throwaway database certificate; curl must not use it for the internet.
dl() { env -u SSL_CERT_FILE curl "$@"; }
WORK="$OUT/verified"; rm -rf "$WORK"; mkdir -p "$WORK"
REL="https://github.com/supabase/cli/releases/download/v$VER"

say "# s1-verified-binary rehearsal on $(uname -sm); synthetic DB through production's prefix 0212 (not a copy of production)"

# ---- (a) release archive + checksums.txt ---------------------------------------------------
say "== (a) GitHub release archive, verified with sha256sum -c"
dl -fsSL "https://api.github.com/repos/supabase/cli/releases/tags/v$VER" -o "$WORK/release.json" 2> "$WORK/release.err" || true
if [ -s "$WORK/release.json" ]; then
  say "INFO  release assets (name, size):"
  python3 -c "import json,sys; d=json.load(open('$WORK/release.json')); print('\n'.join('   | %s  %s' % (a['name'], a['size']) for a in d.get('assets', [])))" | tee -a "$RES"
fi
ARCH_NAME="supabase_${VER}_linux_amd64.tar.gz"
cd "$WORK"
dl -fsSL -o "$ARCH_NAME" "$REL/$ARCH_NAME"
SUMS=""
for n in "supabase_${VER}_checksums.txt" "checksums.txt"; do
  if dl -fsSL -o "$n" "$REL/$n" 2> /dev/null; then SUMS="$n"; break; fi
done
expect "(a) archive and checksums file downloaded from the v$VER release" "$([ -s "$ARCH_NAME" ] && [ -n "$SUMS" ] && echo 0 || echo 1)" "archive=$(stat -c %s "$ARCH_NAME" 2> /dev/null) bytes; checksums file=$SUMS"
say "INFO  archive sha256: $(sha256sum "$ARCH_NAME" | cut -d' ' -f1)"
say "INFO  checksums.txt line for this archive: $(grep -F "$ARCH_NAME" "$SUMS" | head -1)"
grep -F "$ARCH_NAME" "$SUMS" > "$WORK/one.sum"
sha256sum -c "$WORK/one.sum" > "$WORK/verify-good.txt" 2>&1; GOOD=$?
say "INFO  sha256sum -c on the genuine archive: $(cat "$WORK/verify-good.txt")  (exit $GOOD)"
expect "(a) the genuine archive PASSES sha256sum -c" "$GOOD" "exit=$GOOD"
mkdir -p "$WORK/tampered"; cp "$ARCH_NAME" "$WORK/tampered/$ARCH_NAME"; printf 'x' >> "$WORK/tampered/$ARCH_NAME"
( cd "$WORK/tampered" && sha256sum -c "$WORK/one.sum" > "$WORK/verify-bad.txt" 2>&1 ); BAD=$?
say "INFO  sha256sum -c on a tampered copy (one byte appended): $(tr '\n' ' ' < "$WORK/verify-bad.txt") (exit $BAD)"
expect "(a) a TAMPERED archive FAILS sha256sum -c (non-zero)" "$([ "$BAD" != "0" ] && echo 0 || echo 1)" "exit=$BAD"
mkdir -p "$WORK/bin"; tar -xzf "$ARCH_NAME" -C "$WORK/bin"
BIN="$(find "$WORK/bin" -name supabase -type f | head -1)"
chmod +x "$BIN"
[ -n "$BIN" ] && [ -x "$BIN" ] || { say "FAIL no verified binary: cannot continue"; exit 1; }
VOUT="$($BIN --version 2>&1 | tail -1)"
expect "(a) the extracted binary prints $VER" "$([ "$VOUT" = "$VER" ] && echo 0 || echo 1)" "--version='$VOUT'; binary sha256=$(sha256sum "$BIN" | cut -d' ' -f1)"
say "INFO  archive contents: $(tar -tzf "$ARCH_NAME" | tr '\n' ' ')"
cd - > /dev/null

# ---- (b) npm pack, sha512 against dist.integrity ----------------------------------------------
say "== (b) npm pack supabase@$VER, sha512 against the published dist.integrity"
EXPECT_INTEGRITY="sha512-PMoWgoQOb1/mZ3Y+e/HIIvWmEfui20cWELXYURrb6s66Swvo1jnkBmRvtCtSA8lan+aHtkgVQAyekocugle2eg=="
REG_INTEGRITY="$(npm view "supabase@$VER" dist.integrity 2> /dev/null)"
say "INFO  registry dist.integrity: $REG_INTEGRITY"
expect "(b) the registry's dist.integrity equals the value OPS recorded" "$([ "$REG_INTEGRITY" = "$EXPECT_INTEGRITY" ] && echo 0 || echo 1)" "match"
( cd "$WORK" && npm pack "supabase@$VER" --silent > "$WORK/npm-pack.out" 2> "$WORK/npm-pack.err" ); TGZ="$WORK/$(tail -1 "$WORK/npm-pack.out")"
integrity_of() { echo "sha512-$(openssl dgst -sha512 -binary "$1" | base64 -w0)"; }
check_integrity() { [ "$(integrity_of "$1")" = "$EXPECT_INTEGRITY" ]; }
say "INFO  tarball $(basename "$TGZ") sha512: $(integrity_of "$TGZ")"
check_integrity "$TGZ"; NGOOD=$?
expect "(b) the packed tarball's sha512 EQUALS the published dist.integrity" "$NGOOD" "exit=$NGOOD"
cp "$TGZ" "$WORK/tampered-npm.tgz"; printf 'x' >> "$WORK/tampered-npm.tgz"
check_integrity "$WORK/tampered-npm.tgz"; NBAD=$?
expect "(b) a TAMPERED tarball is REFUSED (mismatch, non-zero)" "$([ "$NBAD" != "0" ] && echo 0 || echo 1)" "exit=$NBAD"
say "INFO  tarball contents: $(tar -tzf "$TGZ" | head -12 | tr '\n' ' ')"
say "INFO  package.json scripts: $(tar -xzOf "$TGZ" package/package.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('scripts', {})), 'bin=', d.get('bin'))")"
npm install --prefix "$WORK/npmroot" --ignore-scripts "$TGZ" > "$WORK/npm-install.log" 2>&1; NI=$?
NPMBIN="$WORK/npmroot/node_modules/.bin/supabase"
NV="$($NPMBIN --version 2>&1 | tail -1)"
say "INFO  installing from the verified tarball with --ignore-scripts: exit=$NI; '$NPMBIN --version' -> '$NV'"
say "INFO  (b) files present under the installed package: $(ls "$WORK/npmroot/node_modules/supabase" 2> /dev/null | tr '\n' ' ') | bin dir: $(ls "$WORK/npmroot/node_modules/supabase/bin" 2> /dev/null | tr '\n' ' ')"

# ---- (c)(d) the S1 sequence with the VERIFIED archive binary -------------------------------------
CLI="$BIN"
say "== (c) exact S1 sequence with the verified binary ($BIN), non-loopback address"
$CLI db reset --local --yes > "$OUT/reset-control.log" 2>&1
for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
CTRL_SIG="$(hist_sig)"; CTRL_N="$(hist_n)"
say "INFO  control chain (normal db reset): rows 0213-0246=$CTRL_N signature=$CTRL_SIG"
say "INFO  S0 pre-check, grep -n -A1 'experimental.pgdelta' supabase/config.toml:"
grep -n -A1 'experimental.pgdelta' supabase/config.toml | sed 's/^/   | /' | tee -a "$RES"

reset_to_0212 || { say "FAIL could not reset to 0212"; exit 1; }
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '/edge-runtime:' | xargs -r docker rmi -f > /dev/null 2>&1
rm -rf supabase/.temp/pgdelta
N0="$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')"
export SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
$CLI db push --db-url "$REMOTE_URL" --dry-run > "$OUT/s1-dry.log" 2>&1; DRC=$?
GOT="$(grep -oE '\b0[0-9]{3}_[a-z0-9_]+\.sql' "$OUT/s1-dry.log" | cut -c1-4 | sort -u | tr '\n' ' ')"
EXPECTED="$(ls supabase/migrations | awk -F_ '$1 >= "0213" && $1 <= "0246" {print substr($1,1,4)}' | sort | tr '\n' ' ')"
expect "(c) --dry-run: exit 0, 'DRY RUN' banner, 'Connecting to remote database...', lists exactly the 34 files 0213-0246" "$([ "$DRC" = "0" ] && grep -q 'DRY RUN' "$OUT/s1-dry.log" && grep -q 'Connecting to remote database' "$OUT/s1-dry.log" && [ "$GOT" = "$EXPECTED" ] && [ "$(echo $GOT | wc -w)" = "34" ] && echo 0 || echo 1)" "exit=$DRC listed=$(echo $GOT | wc -w)"
expect "(c) the dry run changed nothing" "$([ "$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')" = "$N0" ] && echo 0 || echo 1)" "rows=$N0"
T0=$(date +%s)
$CLI db push --db-url "$REMOTE_URL" --yes > "$OUT/s1-push.log" 2>&1; PRC=$?
say "-- S1 push (verified binary, env var set): exit=$PRC elapsed=$(( $(date +%s) - T0 ))s"
APPLIED="$(grep -cE '^Applying migration 0(2[1-3][0-9]|24[0-6])_' "$OUT/s1-push.log")"
ORDER_OK=1; [ "$(grep -oE '^Applying migration 0[0-9]{3}' "$OUT/s1-push.log" | cut -d' ' -f3 | tr '\n' ' ')" = "$EXPECTED" ] && ORDER_OK=0
expect "(c) push exit 0, 'Connecting to remote database...', 34 'Applying migration' lines in version order, 'Finished supabase db push.'" "$([ "$PRC" = "0" ] && grep -q '^Connecting to remote database' "$OUT/s1-push.log" && [ "$APPLIED" = "34" ] && [ "$ORDER_OK" = "0" ] && grep -q '^Finished supabase db push\.' "$OUT/s1-push.log" && echo 0 || echo 1)" "exit=$PRC applied lines=$APPLIED order_ok=$ORDER_OK"
expect "(c) ABSENT: any 'Pulling from', 'failed to pull docker image' or 'Warning' line; no edge-runtime image; no catalog cache file" "$([ "$(pull_attempts "$OUT/s1-push.log")" = "0" ] && ! grep -q 'Warning' "$OUT/s1-push.log" && [ "$(docker images --format '{{.Repository}}' | grep -c edge-runtime)" = "0" ] && [ ! -d supabase/.temp/pgdelta ] && echo 0 || echo 1)" "attempt lines=$(pull_attempts "$OUT/s1-push.log"); image=$(docker images --format '{{.Repository}}' | grep -c edge-runtime); cache dir present=$([ -d supabase/.temp/pgdelta ] && echo yes || echo no)"
expect "(c) read-back: 34 rows with version >= 0213, identical signature to the control chain" "$([ "$(hist_n)" = "34" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n) sig_equal=$([ "$(hist_sig)" = "$CTRL_SIG" ] && echo yes || echo no)"
echo "---- S1 push output, first 3 and last 5 lines (the expected lines for the checklist) ----" | tee -a "$RES"
{ sed -n '1,3p' "$OUT/s1-push.log"; echo '   ...'; tail -n 5 "$OUT/s1-push.log"; } | sed 's/^/   | /' | tee -a "$RES"
unset SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED

# ---- (d) control without the env var ------------------------------------------------------------
say "== (d) control: the same push WITHOUT the env var"
reset_to_0212 || { say "FAIL could not reset to 0212 for the control"; exit 1; }
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '/edge-runtime:' | xargs -r docker rmi -f > /dev/null 2>&1
rm -rf supabase/.temp/pgdelta
$CLI db push --db-url "$REMOTE_URL" --yes > "$OUT/control-push.log" 2>&1; CRC=$?
say "-- control push (no env var): exit=$CRC rows=$(hist_n)"
grep -nE "Connecting to|Pulling from|Warning|failed to pull|Finished" "$OUT/control-push.log" | cut -c1-200 | sed 's/^/   | /' | tee -a "$RES"
expect "(d) WITHOUT the env var the catalog step runs: a pull attempt (success or failure) is present" "$([ "$(pull_attempts "$OUT/control-push.log")" -ge 1 ] && echo 0 || echo 1)" "attempt lines=$(pull_attempts "$OUT/control-push.log") exit=$CRC"
expect "(d) the control still applied and recorded 34 rows (the step is after the commit), so the env var is what removes the step" "$([ "$(hist_n)" = "34" ] && [ "$(hist_sig)" = "$CTRL_SIG" ] && echo 0 || echo 1)" "rows=$(hist_n)"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
