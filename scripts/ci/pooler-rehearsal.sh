#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. POOLER-REHEARSAL: the S1 sequence through the local Supavisor SESSION
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
  $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 || { tail -n 20 "$OUT/reset-0212.log"; return 1; }
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
SSLM=""
for m in require prefer disable; do
  r="$(pq "$PW" "$(purl $m)" -At -c 'select 1' | tr '\n' ' ' | cut -c1-160)"
  say "   | sslmode=$m -> $r"
  [ -z "$SSLM" ] && echo "$r" | grep -q '^1 *$' && SSLM=$m
done
if [ -z "$SSLM" ]; then diag_pooler; say "FAIL the pooler accepts no connection with password $PW"; exit 1; fi
say "INFO  strongest sslmode that works through the local pooler: $SSLM"
expect "(info) sslmode=require works through the local pooler" "$([ "$SSLM" = require ] && echo 0 || echo 1)" "strongest working = $SSLM (the hosted pooler accepts TLS; local Supavisor may not, in which case the runbook's sslmode=require is unproven here)"

# ====================== (a) options forwarding / read-back ====================================
say "== (a) what the session pooler forwards (read back on the same connection)"
rb() { # rb <label> <options-string or empty>
  local o; o="$(pq "$PW" "$(purl "$SSLM" "$2")" -At -c 'show statement_timeout' -c 'show lock_timeout' | tr '\n' ' ' | cut -c1-200)"
  say "   | $1: $o"; eval "RB_$1=\"\$o\""
}
rb control ""
rb s1_option "$OPT_S1"
rb both_options "-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D5000"
rb lock_only "-c%20lock_timeout%3D5000"
say "   | direct (no pooler) with the S1 option, for comparison: $(PGPASSWORD=$PW psql "postgresql://postgres@$RUNNER_IP:$PORT/postgres?sslmode=disable&options=$OPT_S1" -X -At -c 'show statement_timeout' -c 'show lock_timeout' 2>&1 | tr '\n' ' ')"
echo "$RB_s1_option" | grep -q '^2min ' ; FWD=$?
expect "(a) the URL options string reaches the session: statement_timeout reads back 2min through the pooler" "$FWD" "control='$RB_control' s1='$RB_s1_option' both='$RB_both_options' lock_only='$RB_lock_only'"

# ====================== (b) firing ============================================================
say "== (b) firing through the pooler"
fire() { # fire <label> <options> <sql>  -> prints elapsed seconds and the verbose error
  local t0=$SECONDS o; o="$(pq "$PW" "$(purl "$SSLM" "$2")" -At -c "$3" | tr '\n' ' ' | cut -c1-220)"
  say "   | $1: elapsed=$((SECONDS - t0))s :: $o"; FIRE_OUT="$o"; FIRE_T=$((SECONDS - t0))
}
fire sleep_control "" "select pg_sleep(8)"
fire sleep_options "-c%20statement_timeout%3D5000" "select pg_sleep(8)"
OPT_FIRES=0; echo "$FIRE_OUT" | grep -q '57014' && OPT_FIRES=1
fire sleep_set_in_session "" "set statement_timeout = 5000; select pg_sleep(8)"
SET_FIRES=0; echo "$FIRE_OUT" | grep -q '57014' && SET_FIRES=1
expect "(b) options statement_timeout=5000 via the pooler cancels pg_sleep(8) with 57014 after ~5 s" "$([ "$OPT_FIRES" = 1 ] && echo 0 || echo 1)" "options-form fires=$OPT_FIRES; in-session SET fires=$SET_FIRES (the SET form is not what S1 uses)"
sadm -c "drop table if exists public.pooler_lock_probe; create table public.pooler_lock_probe(id int)" > /dev/null
( pq "$PW" "$(purl "$SSLM")" -At -c "begin; lock table public.pooler_lock_probe in access exclusive mode; select pg_sleep(25); commit;" > "$OUT/holder.txt" 2>&1 & )
sleep 3
fire lock_options "-c%20lock_timeout%3D5000" "select count(*) from public.pooler_lock_probe"
LOCK_OPT=0; echo "$FIRE_OUT" | grep -q '55P03' && LOCK_OPT=1
fire lock_set_in_session "" "set lock_timeout = '5s'; select count(*) from public.pooler_lock_probe"
LOCK_SET=0; echo "$FIRE_OUT" | grep -q '55P03' && LOCK_SET=1
expect "(b) a held lock gives 55P03 at lock_timeout 5s through the pooler (options form)" "$([ "$LOCK_OPT" = 1 ] && echo 0 || echo 1)" "options-form fires=$LOCK_OPT; in-session SET fires=$LOCK_SET"
sleep 25

# ---- mitm proxy (zero-outbound proof), as in #1168 ---------------------------------------
python3 -m venv "$OUT/venv" > /dev/null 2>&1 && "$OUT/venv/bin/pip" install --quiet "mitmproxy==11.0.2" > "$OUT/pip.log" 2>&1 || { tail -n 5 "$OUT/pip.log"; say "FAIL mitmproxy install"; exit 1; }
MITM="$OUT/mitm"; mkdir -p "$MITM"
cat > "$MITM/dump.py" <<'PY'
import json, os
from mitmproxy import http
OUT = os.environ["MITM_OUT"]
class Dump:
    def request(self, flow: http.HTTPFlow):
        r = flow.request
        with open(OUT, "a") as f:
            f.write(json.dumps({"method": r.method, "host": r.pretty_host, "path": r.path}) + "\n")
addons = [Dump()]
PY
PORTP=8089
with_proxy() { # with_proxy <label> <command...>
  local label="$1"; shift
  : > "$OUT/flows-$label.jsonl"
  MITM_OUT="$OUT/flows-$label.jsonl" "$OUT/venv/bin/mitmdump" -q -p "$PORTP" --set confdir="$MITM" -s "$MITM/dump.py" > "$OUT/mitm-$label.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do [ -f "$MITM/mitmproxy-ca-cert.pem" ] && (echo > /dev/tcp/127.0.0.1/$PORTP) 2> /dev/null && break; sleep 0.5; done
  env HTTPS_PROXY="http://127.0.0.1:$PORTP" HTTP_PROXY="http://127.0.0.1:$PORTP" NO_PROXY="" SSL_CERT_FILE="$MITM/mitmproxy-ca-cert.pem" "$@"
  local rc=$?
  sleep 1; kill "$pid" 2> /dev/null; wait "$pid" 2> /dev/null
  return $rc
}
nflows() { grep -c . "$OUT/flows-$1.jsonl" 2> /dev/null || echo 0; }

# ---- the S1 command lines, byte for byte, as the Mac runbook will use them ----------------
# Only <HOSTPORT> and <USER> (and the sslmode, where noted) differ from the hosted values.
cat > "$OUT/s1-template.sh" <<'TPL'
export SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
unset GITHUB_TOKEN GH_TOKEN
mkdir -p supabase/.temp && echo v2.102.0 > supabase/.temp/cli-latest
read -rs PGPASSWORD
export PGPASSWORD
./supabase-cli/supabase db push --db-url "postgresql://<USER>@<HOSTPORT>/postgres?sslmode=<SSLMODE>&options=-c%20statement_timeout%3D120000" --dry-run
./supabase-cli/supabase db push --db-url "postgresql://<USER>@<HOSTPORT>/postgres?sslmode=<SSLMODE>&options=-c%20statement_timeout%3D120000" --yes
TPL
mk_script() { # mk_script <user> <host:port> <sslmode> <dry|push|both> -> path
  local f="$OUT/s1-$1-$4.sh"
  sed -e "s#<USER>#$1#g" -e "s#<HOSTPORT>#$2#g" -e "s#<SSLMODE>#$3#g" "$OUT/s1-template.sh" > "$f"
  case "$4" in
    dry) grep -v -e '--yes$' "$f" > "$f.x"; mv "$f.x" "$f" ;;
    push) grep -v -e '--dry-run$' "$f" > "$f.x"; mv "$f.x" "$f" ;;
  esac
  echo "$f"
}
# run_s1 <label> <script> <password-or-empty> <hold-seconds>: runs the script with the password on stdin,
# optionally while another session holds a lock on schema_migrations so the CLI process lives long enough
# for `ps` sampling; records exit, argv samples, outbound requests.
run_s1() {
  local label="$1" script="$2" pw="$3" hold="$4" t0=$SECONDS
  : > "$OUT/ps-$label.txt"
  if [ "$hold" -gt 0 ]; then
    ( sadm -c "begin; lock table supabase_migrations.schema_migrations in access exclusive mode; select pg_sleep($hold); commit;" > /dev/null 2>&1 & )
    sleep 1
  fi
  ( cd "$REPO" && printf '%s\n' "$pw" | with_proxy "$label" bash "$script" > "$OUT/run-$label.log" 2>&1; echo $? > "$OUT/rc-$label.txt" ) &
  local bg=$!
  while kill -0 "$bg" 2> /dev/null; do ps -eo args | grep -F -e "supabase-cli/supabase" | grep -v -e grep >> "$OUT/ps-$label.txt"; sleep 0.5; done
  wait "$bg" 2> /dev/null
  RC="$(cat "$OUT/rc-$label.txt" 2> /dev/null || echo 99)"; ELAPSED=$((SECONDS - t0))
}
argv_clean() { # argv_clean <label> <password>: no password in any sampled argv line; at least one CLI line sampled
  local n; n="$(grep -c 'supabase-cli/supabase db push' "$OUT/ps-$1.txt")"
  if [ "$n" -ge 1 ] && ! grep -q -F -e "$2" "$OUT/ps-$1.txt" && ! grep -E -q '://[^@/ ]*:[^@/ ]+@' "$OUT/ps-$1.txt"; then echo 0; else echo 1; fi
}
set_pw() { sadm -c "alter role postgres password '$1'" > /dev/null; }
CANARY=S1canarypw8K3x
trap 'sadm -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1' EXIT

# ====================== (c) the exact S1 sequence through the pooler ===========================
say "== (c) S1 through the session pooler, password ONLY via PGPASSWORD, password-free --db-url"
reset_to_0212 || { say "FAIL reset"; exit 1; }
set_pw "$CANARY"
if wait_pooler "$CANARY" "$SSLM"; then CANARY_OK=yes; PWU="$CANARY"; else CANARY_OK=no; set_pw "$PW"; PWU="$PW"; wait_pooler "$PW" "$SSLM" || { diag_pooler; say "FAIL pooler unusable after reset"; exit 1; }; fi
say "INFO  canary password accepted through the pooler after ALTER ROLE: $CANARY_OK (using '${PWU:0:2}...' for the S1 runs)"
SC_DRY="$(mk_script "$PUSER" "$RUNNER_IP:$PPORT" "$SSLM" dry)"
run_s1 c-dry "$SC_DRY" "$PWU" 8
NB="$(grep -c '^ *• 0' "$OUT/run-c-dry.log")"
say "-- (c) dry run: exit=$RC elapsed=${ELAPSED}s bullets=$NB requests=$(nflows c-dry)"
sed 's/^/   | /' "$OUT/run-c-dry.log" | head -n 6 | tee -a "$RES"
expect "(c) dry run through the pooler: exit 0, lists exactly 34, connection reached (password only in PGPASSWORD)" "$([ "$RC" = 0 ] && [ "$NB" = 34 ] && echo 0 || echo 1)" "exit=$RC bullets=$NB"
expect "(c) no password and no user:password@ userinfo in the CLI's argv (sampled $(grep -c 'db push' "$OUT/ps-c-dry.txt") times)" "$(argv_clean c-dry "$PWU")" "$(head -n 1 "$OUT/ps-c-dry.txt" | cut -c1-260)"
expect "(c) zero outbound HTTP(S) requests during the dry run" "$([ "$(nflows c-dry)" = 0 ] && echo 0 || echo 1)" "requests=$(nflows c-dry)"
SC_PUSH="$(mk_script "$PUSER" "$RUNNER_IP:$PPORT" "$SSLM" push)"
run_s1 c-push "$SC_PUSH" "$PWU" 8
HN="$(hist_n)"
say "-- (c) push: exit=$RC elapsed=${ELAPSED}s history rows 0213-0246=$HN requests=$(nflows c-push)"
tail -n 3 "$OUT/run-c-push.log" | sed 's/^/   | /' | tee -a "$RES"
expect "(c) push through the pooler: exit 0, 'Finished supabase db push.', 34 history rows" "$([ "$RC" = 0 ] && [ "$HN" = 34 ] && grep -q '^Finished supabase db push\.' "$OUT/run-c-push.log" && echo 0 || echo 1)" "exit=$RC rows=$HN"
expect "(c) no password in the push's argv" "$(argv_clean c-push "$PWU")" "samples=$(grep -c 'db push' "$OUT/ps-c-push.txt")"
expect "(c) zero outbound HTTP(S) requests during the push" "$([ "$(nflows c-push)" = 0 ] && echo 0 || echo 1)" "requests=$(nflows c-push)"
expect "(c) no pgdelta / image-pull lines" "$(grep -q -i -e 'pulling from' -e 'failed to pull' -e 'catalog' "$OUT/run-c-push.log" && echo 1 || echo 0)" "clean"

# ====================== (f) wrong password, (g) empty password through the pooler ==============
say "== (f)/(g) failure behaviour through the pooler (must not fall back to the Management API)"
reset_to_0212 || { say "FAIL reset"; exit 1; }
wait_pooler "$PW" "$SSLM" || true
set_pw "$PW"
SC_DRY2="$(mk_script "$PUSER" "$RUNNER_IP:$PPORT" "$SSLM" dry)"
L0="$(docker logs "$POOLER" 2>&1 | wc -l)"
run_s1 f-wrong "$SC_DRY2" "definitely-wrong-pw" 0
say "-- (f) wrong password: exit=$RC elapsed=${ELAPSED}s requests=$(nflows f-wrong); output:"
sed 's/^/   | /' "$OUT/run-f-wrong.log" | head -n 12 | tee -a "$RES"
ATT_F="$(grep -c -i -e 'password authentication failed' -e 'SASL' -e 'authentication' "$OUT/run-f-wrong.log")"
say "   | pooler log lines added during (f): $(( $(docker logs "$POOLER" 2>&1 | wc -l) - L0 ))  (auth-related lines in the CLI output: $ATT_F)"
docker logs "$POOLER" 2>&1 | tail -n +$((L0 + 1)) | cut -c1-200 | head -n 15 | sed 's/^/   | pooler: /' | tee -a "$RES"
expect "(f) wrong password: non-zero exit, finished within 30 s (no retry loop), zero HTTP(S) requests, no Management API" "$([ "$RC" != 0 ] && [ "$ELAPSED" -le 30 ] && [ "$(nflows f-wrong)" = 0 ] && echo 0 || echo 1)" "exit=$RC elapsed=${ELAPSED}s requests=$(nflows f-wrong)"
expect "(f) the output shows the connection was attempted once ('Connecting to remote database...' x1)" "$([ "$(grep -c 'Connecting to' "$OUT/run-f-wrong.log")" = 1 ] && echo 0 || echo 1)" "count=$(grep -c 'Connecting to' "$OUT/run-f-wrong.log")"
expect "(f) nothing was applied" "$([ "$(hist_n)" = 0 ] && echo 0 || echo 1)" "rows=$(hist_n)"
L0="$(docker logs "$POOLER" 2>&1 | wc -l)"
run_s1 g-empty "$SC_DRY2" "" 0
say "-- (g) empty PGPASSWORD (read gets an empty line): exit=$RC elapsed=${ELAPSED}s requests=$(nflows g-empty); output:"
sed 's/^/   | /' "$OUT/run-g-empty.log" | head -n 12 | tee -a "$RES"
expect "(g) empty password: non-zero exit, <=30 s, zero HTTP(S) requests, no prompt (stdin was not a tty)" "$([ "$RC" != 0 ] && [ "$ELAPSED" -le 30 ] && [ "$(nflows g-empty)" = 0 ] && echo 0 || echo 1)" "exit=$RC elapsed=${ELAPSED}s requests=$(nflows g-empty)"
# unset (never exported) PGPASSWORD, stdin closed
( cd "$REPO" && with_proxy g-unset timeout 60 env -u PGPASSWORD SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false "$BIN" db push --db-url "postgresql://$PUSER@$RUNNER_IP:$PPORT/postgres?sslmode=$SSLM" --dry-run < /dev/null > "$OUT/run-g-unset.log" 2>&1; echo $? > "$OUT/rc-g-unset.txt" )
say "-- (g) PGPASSWORD never set, stdin closed: exit=$(cat "$OUT/rc-g-unset.txt") requests=$(nflows g-unset); output:"
sed 's/^/   | /' "$OUT/run-g-unset.log" | head -n 8 | tee -a "$RES"
expect "(g) unset PGPASSWORD: non-zero exit, zero requests" "$([ "$(cat "$OUT/rc-g-unset.txt")" != 0 ] && [ "$(nflows g-unset)" = 0 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/rc-g-unset.txt") requests=$(nflows g-unset)"

# ====================== (h) lock_timeout 5s inside a migration file, through the pooler ==========
say "== (h) a 5 s lock_timeout inside a migration file fires through the pooler; failed file not recorded; next file not run"
reset_to_0212 || { say "FAIL reset"; exit 1; }
set_pw "$PW"; wait_pooler "$PW" "$SSLM" || true
WD="$OUT/wd-lock"; rm -rf "$WD"; mkdir -p "$WD/supabase/migrations" "$WD/supabase/.temp"
cp "$REPO/supabase/config.toml" "$WD/supabase/config.toml"
for f in "$REPO"/supabase/migrations/*.sql; do b="$(basename "$f")"; [ "${b%%_*}" -le 212 ] 2> /dev/null && cp "$f" "$WD/supabase/migrations/$b"; done
cat > "$WD/supabase/migrations/0213_probe_lock.sql" <<'SQL'
begin;
set local lock_timeout = '5s';
lock table public.pooler_lock_probe in access exclusive mode;
create table public.pooler_h_marker_a (id int);
commit;
SQL
cat > "$WD/supabase/migrations/0214_probe_next.sql" <<'SQL'
begin;
create table public.pooler_h_marker_b (id int);
commit;
SQL
echo "v$VER" > "$WD/supabase/.temp/cli-latest"
sadm -c "create table if not exists public.pooler_lock_probe(id int)" > /dev/null
( pq "$PW" "$(purl "$SSLM")" -At -c "begin; lock table public.pooler_lock_probe in access exclusive mode; select pg_sleep(30); commit;" > "$OUT/holder-h.txt" 2>&1 & )
sleep 3
t0=$SECONDS
( cd "$WD" && PGPASSWORD="$PW" with_proxy h env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false "$BIN" db push --db-url "postgresql://$PUSER@$RUNNER_IP:$PPORT/postgres?sslmode=$SSLM&options=$OPT_S1" --yes > "$OUT/run-h.log" 2>&1; echo $? > "$OUT/rc-h.txt" )
HT=$((SECONDS - t0)); HRC="$(cat "$OUT/rc-h.txt")"
say "-- (h) push with the lock held by another pooled session: exit=$HRC elapsed=${HT}s requests=$(nflows h)"
sed 's/^/   | /' "$OUT/run-h.log" | tail -n 12 | tee -a "$RES"
HROWS="$(psqld -c "select coalesce(string_agg(version, ','), 'none') from supabase_migrations.schema_migrations where version >= '0213'")"
HMARK="$(psqld -c "select count(*) from pg_tables where tablename like 'pooler_h_marker_%'")"
expect "(h) exit non-zero, SQLSTATE 55P03 / lock timeout in the output, fired at ~5 s (not after the 25+ s hold)" "$([ "$HRC" != 0 ] && grep -q -i -e '55P03' -e 'lock timeout' "$OUT/run-h.log" && [ "$HT" -le 20 ] && echo 0 || echo 1)" "exit=$HRC elapsed=${HT}s"
expect "(h) the failed file 0213 is not recorded and 0214 did not run (history rows >= 0213: $HROWS; marker tables: $HMARK)" "$([ "$HROWS" = none ] && [ "$HMARK" = 0 ] && echo 0 || echo 1)" "rows=$HROWS markers=$HMARK"
expect "(h) zero outbound HTTP(S) requests" "$([ "$(nflows h)" = 0 ] && echo 0 || echo 1)" "requests=$(nflows h)"
sleep 28
( cd "$WD" && PGPASSWORD="$PW" "$BIN" db push --db-url "postgresql://$PUSER@$RUNNER_IP:$PPORT/postgres?sslmode=$SSLM&options=$OPT_S1" --yes > "$OUT/run-h2.log" 2>&1; echo $? > "$OUT/rc-h2.txt" )
H2ROWS="$(psqld -c "select coalesce(string_agg(version, ','), 'none') from supabase_migrations.schema_migrations where version >= '0213'")"
expect "(h) control: once the lock is released the same push applies both files (0213,0214)" "$([ "$(cat "$OUT/rc-h2.txt")" = 0 ] && [ "$H2ROWS" = "0213,0214" ] && echo 0 || echo 1)" "exit=$(cat "$OUT/rc-h2.txt") rows=$H2ROWS"

# ====================== (d) the same PGPASSWORD-only form on the DIRECT path ====================
say "== (d) PGPASSWORD-only on the direct path (password-free --db-url)"
reset_to_0212 || { say "FAIL reset"; exit 1; }
set_pw "$CANARY"
SC_BOTH="$(mk_script postgres "$RUNNER_IP:$PORT" require both)"
run_s1 d-control "$(mk_script postgres "$RUNNER_IP:$PORT" require dry)" "" 0
say "-- (d) control, no password anywhere: exit=$RC requests=$(nflows d-control); output:"
sed 's/^/   | /' "$OUT/run-d-control.log" | head -n 5 | tee -a "$RES"
expect "(d) control: with no password at all the direct path fails (so the success below is the env var)" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "exit=$RC"
run_s1 d-dry "$(mk_script postgres "$RUNNER_IP:$PORT" require dry)" "$CANARY" 8
NB="$(grep -c '^ *• 0' "$OUT/run-d-dry.log")"
expect "(d) direct, PGPASSWORD only: dry run exit 0 lists 34" "$([ "$RC" = 0 ] && [ "$NB" = 34 ] && echo 0 || echo 1)" "exit=$RC bullets=$NB"
expect "(d) no password in argv (direct)" "$(argv_clean d-dry "$CANARY")" "samples=$(grep -c 'db push' "$OUT/ps-d-dry.txt")"
run_s1 d-both "$SC_BOTH" "$CANARY" 0
expect "(d) direct, the whole template (dry run then --yes) exits 0, 34 rows, zero requests" "$([ "$RC" = 0 ] && [ "$(hist_n)" = 34 ] && [ "$(nflows d-both)" = 0 ] && echo 0 || echo 1)" "exit=$RC rows=$(hist_n) requests=$(nflows d-both)"

# ====================== (i) the exact command lines ============================================
say "== (i) the exact S1 command lines (byte for byte; placeholders <USER>, <HOSTPORT>, <SSLMODE> are the only differences)"
sed 's/^/   | /' "$OUT/s1-template.sh" | tee -a "$RES"
say "INFO  template sha256: $(sha256sum "$OUT/s1-template.sh" | cut -d' ' -f1); shells: bash $BASH_VERSION (zsh 'read -rs NAME' is equivalent)"
say "INFO  the script actually executed for the pooler dry run (with the synthetic values substituted):"
sed 's/^/   | /' "$SC_DRY" | tee -a "$RES"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
