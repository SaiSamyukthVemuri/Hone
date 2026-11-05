#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. S1-SUPABASE-GO: the S1 sequence with the vendor supabase-go binary through the local Supavisor SESSION
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
nflows() { local n; n="$(grep -c . "$OUT/flows-$1.jsonl" 2> /dev/null)"; echo "${n:-0}"; }

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
mk_script() { # mk_script <user> <host:port> <sslmode> <dry|push|both> [binary name, default supabase] -> path
  local bn="${5:-supabase}" f="$OUT/s1-$1-$4-${5:-supabase}.sh"
  sed -e "s#<USER>#$1#g" -e "s#<HOSTPORT>#$2#g" -e "s#<SSLMODE>#$3#g" -e "s#^\./supabase-cli/supabase #./supabase-cli/$bn #" "$OUT/s1-template.sh" > "$f"
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
  local n; n="$(grep -c 'db push' "$OUT/ps-$1.txt")"
  if [ "$n" -ge 1 ] && ! grep -q -F -e "$2" "$OUT/ps-$1.txt" && ! grep -E -q '://[^@/ ]*:[^@/ ]+@' "$OUT/ps-$1.txt"; then echo 0; else echo 1; fi
}
set_pw() { sadm -c "alter role postgres password '$1'" > /dev/null; }
CANARY=S1canarypw8K3x
trap 'sadm -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1' EXIT


reset_ready() { # a fresh prefix-0212 database with the canary password usable through the pooler
  reset_to_0212 || { say "FAIL reset"; exit 1; }
  set_pw "$CANARY"
  if wait_pooler "$CANARY" "$SSLM"; then PWU="$CANARY"; else set_pw "$PW"; PWU="$PW"; wait_pooler "$PW" "$SSLM" || { diag_pooler; say "FAIL pooler unusable"; exit 1; }; fi
}
S1ENV=(SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false)
mkwd() { # mkwd <dir>: a scratch workdir holding migrations 0001-0212 (identical copies)
  rm -rf "$1"; mkdir -p "$1/supabase/migrations" "$1/supabase/.temp"
  cp "$REPO/supabase/config.toml" "$1/supabase/config.toml"
  for f in "$REPO"/supabase/migrations/*.sql; do b="$(basename "$f")"; [ "${b%%_*}" -le 212 ] 2> /dev/null && cp "$f" "$1/supabase/migrations/$b"; done
  echo "v$VER" > "$1/supabase/.temp/cli-latest"
}
clean_probe() { sadm -c "delete from supabase_migrations.schema_migrations where version >= '0213'; drop table if exists public.pooler_marker_a, public.pooler_marker_b, public.pooler_marker_c, public.pooler_c3_marker" > /dev/null 2>&1; }

# ====================== (a) the S1 template with supabase-go vs the wrapper, pooler and direct ==========
say "== (a) the exact S1 template with ./supabase-cli/supabase-go in place of ./supabase-cli/supabase"
declare -A DRYLOG PUSHLOG
for path in pooler direct; do
  if [ "$path" = pooler ]; then U="$PUSER"; HP="$RUNNER_IP:$TLSP"; else U=postgres; HP="$RUNNER_IP:$PORT"; fi
  for bn in supabase supabase-go; do
    L="a-$path-$bn"
    reset_ready
    run_s1 "$L-dry" "$(mk_script "$U" "$HP" require dry "$bn")" "$PWU" 8
    NB="$(grep -c '^ *• 0' "$OUT/run-$L-dry.log")"; RD=$RC
    expect "(a) $path/$bn dry run: exit 0, exactly 34 listed, zero outbound HTTP(S), no password in argv" "$([ "$RD" = 0 ] && [ "$NB" = 34 ] && [ "$(nflows "$L-dry")" = 0 ] && [ "$(argv_clean "$L-dry" "$PWU")" = 0 ] && echo 0 || echo 1)" "exit=$RD bullets=$NB requests=$(nflows "$L-dry") argv samples=$(grep -c 'db push' "$OUT/ps-$L-dry.txt")"
    run_s1 "$L-push" "$(mk_script "$U" "$HP" require push "$bn")" "$PWU" 8
    expect "(a) $path/$bn push: exit 0, 34 history rows, 'Finished supabase db push.', zero outbound HTTP(S), no password in argv" "$([ "$RC" = 0 ] && [ "$(hist_n)" = 34 ] && grep -q '^Finished supabase db push\.' "$OUT/run-$L-push.log" && [ "$(nflows "$L-push")" = 0 ] && [ "$(argv_clean "$L-push" "$PWU")" = 0 ] && echo 0 || echo 1)" "exit=$RC rows=$(hist_n) requests=$(nflows "$L-push") argv samples=$(grep -c 'db push' "$OUT/ps-$L-push.txt")"
    say "   | $path/$bn argv sample: $(head -n 1 "$OUT/ps-$L-push.txt" | cut -c1-240)"
  done
  for k in dry push; do
    if cmp -s "$OUT/run-a-$path-supabase-$k.log" "$OUT/run-a-$path-supabase-go-$k.log"; then
      expect "(a) $path $k: stdout+stderr of supabase-go is BYTE-IDENTICAL to the wrapper's" 0 "cmp equal, $(wc -c < "$OUT/run-a-$path-supabase-go-$k.log") bytes"
    else
      say "INFO  (a) $path $k: output differs between wrapper and supabase-go; diff (wrapper -> go):"
      diff -u "$OUT/run-a-$path-supabase-$k.log" "$OUT/run-a-$path-supabase-go-$k.log" | head -n 30 | sed 's/^/   | /' | tee -a "$RES"
      expect "(a) $path $k: output identical (see diff above)" 1 "differs"
    fi
  done
done
# control: the proxy does see requests when the S1 shell is NOT used (so 'zero' is meaningful for supabase-go)
reset_ready
rm -f supabase/.temp/cli-latest
with_proxy a-control env -u GITHUB_TOKEN -u GH_TOKEN PGPASSWORD="$PWU" "$GOBIN" db push --db-url "postgresql://postgres@$RUNNER_IP:$PORT/postgres?sslmode=require" --dry-run > "$OUT/run-a-control.log" 2>&1
say "INFO  (a) control, supabase-go dry run WITHOUT telemetry-off and without the cache file: $(nflows a-control) outbound request(s): $(python3 -c "
import json,sys
print(', '.join(sorted({json.loads(l)['host'] for l in open('$OUT/flows-a-control.jsonl')})))")"

# ====================== (b) wrong and empty password through supabase-go (pooler) =====================
say "== (b) wrong / empty / unset password through supabase-go on the pooler path"
reset_ready
SCG="$(mk_script "$PUSER" "$RUNNER_IP:$TLSP" require dry supabase-go)"
for kind in wrong empty; do
  if [ $kind = wrong ]; then PWX="definitely-wrong-pw"; else PWX=""; fi
  run_s1 "b-$kind" "$SCG" "$PWX" 0
  expect "(b) supabase-go, $kind password: ONE attempt, exit 1, <=30 s, zero HTTP(S), nothing applied" "$([ "$RC" = 1 ] && [ "$ELAPSED" -le 30 ] && [ "$(grep -c 'Connecting to' "$OUT/run-b-$kind.log")" = 1 ] && [ "$(nflows "b-$kind")" = 0 ] && [ "$(hist_n)" = 0 ] && echo 0 || echo 1)" "exit=$RC elapsed=${ELAPSED}s connecting-lines=$(grep -c 'Connecting to' "$OUT/run-b-$kind.log") requests=$(nflows "b-$kind")"
  sed 's/^/   | /' "$OUT/run-b-$kind.log" | head -n 5 | tee -a "$RES"
done
( cd "$REPO" && with_proxy b-unset timeout 60 env -u PGPASSWORD "${S1ENV[@]}" "$GOBIN" db push --db-url "postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require" --dry-run < /dev/null > "$OUT/run-b-unset.log" 2>&1; echo $? > "$OUT/rc-b-unset.txt" )
expect "(b) supabase-go, PGPASSWORD never set, stdin closed: exit 1, zero HTTP(S), no prompt" "$([ "$(cat "$OUT/rc-b-unset.txt")" = 1 ] && [ "$(nflows b-unset)" = 0 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/rc-b-unset.txt") requests=$(nflows b-unset)"

# ====================== (c1) default timeouts a pooler session gets, and where they come from ==========
say "== (c1) the default statement_timeout/lock_timeout of a pooled session with NO options, and their source (SYNTHETIC database)"
reset_ready
say "   | through the pooler, no options: $(pq "$PWU" "$(purl "$SSLM")" -At -c "select name || '=' || setting || ' (source=' || source || coalesce(', file=' || sourcefile, '') || ')' from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout') order by name" | tr '\n' ';')"
say "   | server-wide (pg_settings reset_val, boot_val) :"
sadm -c "select '     ' || name || ' boot=' || boot_val || ' reset=' || reset_val || ' source=' || source from pg_settings where name in ('statement_timeout','lock_timeout')" | tee -a "$RES"
say "   | per-role / per-database overrides (pg_db_role_setting), then role configs:"
sadm -c "select '     db=' || coalesce(d.datname,'*') || ' role=' || coalesce(r.rolname,'*') || ' ' || array_to_string(s.setconfig, ',') from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole order by 1" | tee -a "$RES"
sadm -c "select '     rolconfig ' || rolname || ' ' || coalesce(array_to_string(rolconfig, ','), '(none)') from pg_roles where rolname in ('postgres','authenticator','anon','authenticated','service_role','supabase_admin') order by rolname" | tee -a "$RES"
say "   | Supavisor container env names/values matching TIMEOUT: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | grep -i timeout | tr '\n' ';')"
say "   | the same on the DIRECT path with no options: $(PGPASSWORD=$PWU psql "postgresql://postgres@$RUNNER_IP:$PORT/postgres?sslmode=require" -X -At -c 'show statement_timeout' -c 'show lock_timeout' | tr '\n' ' ')"
say "   | application_name/usename seen in pg_stat_activity for pooled sessions: $(pq "$PWU" "$(purl "$SSLM")" -At -c "select distinct usename || '/' || coalesce(application_name,'') from pg_stat_activity where backend_type='client backend' and datname='postgres'" | tr '\n' ';')"

# ====================== (c2) watchdog: a second pooled session that cancels long statements ===========
say "== (c2) watchdog rehearsal (threshold scaled from 120 s to 15 s; the SQL text is otherwise the hosted text)"
cat > "$OUT/watchdog.sql" <<'SQL'
select pid, now() - query_start as running, pg_cancel_backend(pid) as cancelled, left(query, 50) as q
from pg_stat_activity
where backend_type = 'client backend'
  and datname = 'postgres'
  and usename = 'postgres'
  and pid <> pg_backend_pid()
  and state = 'active'
  and now() - query_start > interval '__SECONDS__ seconds';
SQL
WDLOG="$OUT/watchdog.log"
start_watchdog() { # start_watchdog <seconds> <password>
  local sql; sql="$(sed "s/__SECONDS__/$1/" "$OUT/watchdog.sql" | tr '\n' ' ')"
  : > "$WDLOG"
  ( while :; do echo "$(date +%T) $(pq "$2" "$(purl "$SSLM")" -At -c "$sql" | tr '\n' ' ')" >> "$WDLOG"; sleep 3; done ) &
  WDPID=$!
}
stop_watchdog() { kill "$WDPID" 2> /dev/null; wait "$WDPID" 2> /dev/null; }
probe_files() { # probe_files <dir> <sleep seconds in the middle file>
  cat > "$1/supabase/migrations/0213_probe_a.sql" <<SQL
begin;
create table public.pooler_marker_a (id int);
commit;
SQL
  cat > "$1/supabase/migrations/0214_probe_slow.sql" <<SQL
begin;
select pg_sleep($2);
create table public.pooler_marker_b (id int);
commit;
SQL
  cat > "$1/supabase/migrations/0215_probe_next.sql" <<SQL
begin;
create table public.pooler_marker_c (id int);
commit;
SQL
}
run_wd_case() { # run_wd_case <label> <sleep seconds>
  local label="$1" WDIR="$OUT/wd-$1"
  reset_ready; clean_probe; mkwd "$WDIR"; probe_files "$WDIR" "$2"
  start_watchdog 15 "$PWU"
  sleep 4
  local t0=$SECONDS
  ( cd "$WDIR" && PGPASSWORD="$PWU" with_proxy "$label" env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" "$GOBIN" db push --db-url "postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require&options=$OPT_S1" --yes > "$OUT/run-$label.log" 2>&1; echo $? > "$OUT/rc-$label.txt" )
  WDT=$((SECONDS - t0)); WDRC="$(cat "$OUT/rc-$label.txt")"; sleep 4; stop_watchdog
  WDROWS="$(psqld -c "select coalesce(string_agg(version, ','), 'none') from supabase_migrations.schema_migrations where version >= '0213'")"
  WDMARK="$(psqld -c "select coalesce(string_agg(replace(tablename, 'pooler_marker_', ''), ','), 'none') from pg_tables where tablename like 'pooler_marker_%'")"
  say "-- (c2) $label (middle file sleeps $2 s, threshold 15 s): exit=$WDRC elapsed=${WDT}s history>=0213: $WDROWS markers: $WDMARK requests=$(nflows "$label")"
  tail -n 6 "$OUT/run-$label.log" | sed 's/^/   | /' | tee -a "$RES"
  say "   | watchdog log lines that cancelled something:"; grep -E '[|]t[|]' "$WDLOG" | cut -c1-200 | sed 's/^/   | /' | tee -a "$RES"
  say "   | watchdog polls: $(wc -l < "$WDLOG"); polls that returned a row: $(grep -c -E '[|]' "$WDLOG")"
}
run_wd_case wd-fire 40
expect "(c2) watchdog FIRES: the CLI stops (exit 1) with 57014, the slow file 0214 is not recorded, 0215 did not run, 0213 stayed recorded" "$([ "$WDRC" = 1 ] && grep -q '57014' "$OUT/run-wd-fire.log" && [ "$WDROWS" = 0213 ] && [ "$WDMARK" = a ] && [ "$WDT" -ge 12 ] && [ "$WDT" -le 35 ] && echo 0 || echo 1)" "exit=$WDRC elapsed=${WDT}s rows=$WDROWS markers=$WDMARK"
run_wd_case wd-quiet 5
expect "(c2) watchdog does NOT fire under the threshold: all three files applied, exit 0, no cancel row in the log" "$([ "$WDRC" = 0 ] && [ "$WDROWS" = "0213,0214,0215" ] && ! grep -q -E '[|]t[|]' "$WDLOG" && echo 0 || echo 1)" "exit=$WDRC rows=$WDROWS cancelled-lines=$(grep -c -E '[|]t[|]' "$WDLOG")"
say "INFO  (c2) exact watchdog SQL (hosted value: __SECONDS__ = 120), run repeatedly every 3 s from a SECOND session through the pooler:"
sed 's/^/   | /' "$OUT/watchdog.sql" | tee -a "$RES"
clean_probe

# ====================== (c3) other per-session timeout inputs for supabase-go db push =================
say "== (c3) other per-session timeout inputs for supabase-go db push"
say "   | db push --help lines mentioning timeout: $("$GOBIN" db push --help 2>&1 | grep -i -c timeout); all flags: $("$GOBIN" db push --help 2>&1 | grep -E '^ +(-|--)' | awk '{print $1,$2}' | tr '\n' ';' | cut -c1-300)"
say "   | root/global flags mentioning timeout: $("$GOBIN" --help 2>&1 | grep -i timeout | tr '\n' ';' | cut -c1-200)"
say "   | strings in the binary like SUPABASE_*TIMEOUT*: $(strings -a "$GOBIN" | grep -o -E 'SUPABASE_[A-Z_]*TIMEOUT[A-Z_]*' | sort -u | tr '\n' ' ')"
say "   | config.toml keys mentioning timeout: $(grep -n -i timeout supabase/config.toml | cut -c1-80 | tr '\n' ';')"
reset_ready
C3DIR="$OUT/wd-c3"; mkwd "$C3DIR"
cat > "$C3DIR/supabase/migrations/0213_probe_sleep8.sql" <<'SQL'
begin;
select pg_sleep(8);
create table public.pooler_c3_marker (id int);
commit;
SQL
c3run() { # c3run <label> <hostport> <user> <url-query> <PGOPTIONS-or-empty>
  clean_probe
  local t0=$SECONDS pgo=()
  [ -n "$5" ] && pgo=("PGOPTIONS=$5")
  ( cd "$C3DIR" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "${pgo[@]}" "$GOBIN" db push --db-url "postgresql://$3@$2/postgres?sslmode=require$4" --yes > "$OUT/run-c3-$1.log" 2>&1; echo $? > "$OUT/rc-c3-$1.txt" )
  local el=$((SECONDS - t0)) fired=no
  grep -q '57014' "$OUT/run-c3-$1.log" && [ "$el" -lt 8 ] && fired=YES
  say "   | $1: exit=$(cat "$OUT/rc-c3-$1.txt") elapsed=${el}s statement_timeout fired (57014 before the 8 s sleep ended): $fired"
}
for path in direct pooler; do
  if [ $path = direct ]; then HP="$RUNNER_IP:$PORT"; U=postgres; else HP="$RUNNER_IP:$TLSP"; U="$PUSER"; fi
  c3run "$path-url-options" "$HP" "$U" "&options=-c%20statement_timeout%3D5000" ""
  c3run "$path-url-runtime-param" "$HP" "$U" "&statement_timeout=5000" ""
  c3run "$path-env-PGOPTIONS" "$HP" "$U" "" "-c statement_timeout=5000"
  c3run "$path-env-PGSTATEMENT_TIMEOUT-(not a libpq variable)" "$HP" "$U" "" ""
done
clean_probe

# ====================== (d) the exact commands for the Mac with supabase-go ===============================
say "== (d) exact S1 command lines with supabase-go (byte for byte; <USER>/<HOSTPORT>/<SSLMODE> are the only placeholders)"
sed 's#^\./supabase-cli/supabase #./supabase-cli/supabase-go #' "$OUT/s1-template.sh" > "$OUT/s1-template-go.sh"
sed 's/^/   | /' "$OUT/s1-template-go.sh" | tee -a "$RES"
say "INFO  supabase-go template sha256: $(sha256sum "$OUT/s1-template-go.sh" | cut -d' ' -f1)"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
