#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. ARCHIVES-AND-UPDATECHECK: (1) all eight v2.102.0 release
# archives verified against checksums.txt, with the binaries' own hashes and every
# second source that exists (artifact attestations, Homebrew/Scoop publication, the
# npm platform packages); (2) what the CLI's update check and telemetry send, observed
# through a local TLS-intercepting proxy, with the verified binary against a non-loopback
# SYNTHETIC database (through production's prefix 0212; not a copy of production).
# Nothing touches a hosted project. Canary values only.
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
dl() { env -u SSL_CERT_FILE curl "$@"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }
RUNNER_IP="$(hostname -I | awk '{print $1}')"
VER=2.102.0
REL="https://github.com/supabase/cli/releases/download/v$VER"
WORK="$OUT/archives"; rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"

# ====================== (1) all eight archives ==========================================
say "== (1) all eight v$VER archives against checksums.txt"
dl -fsSL -o checksums.txt "$REL/checksums.txt" || { say "FAIL could not download checksums.txt"; exit 1; }
ARCHIVES="supabase_${VER}_darwin_arm64.tar.gz supabase_${VER}_darwin_amd64.tar.gz supabase_${VER}_linux_arm64.tar.gz supabase_${VER}_linux_amd64.tar.gz supabase_${VER}_windows_amd64.zip supabase_${VER}_windows_amd64.tar.gz supabase_${VER}_windows_arm64.zip supabase_${VER}_windows_arm64.tar.gz"
: > "$WORK/inner-hashes.txt"
for a in $ARCHIVES; do
  dl -fsSL -o "$a" "$REL/$a" || { expect "(1) download $a" 1 "failed"; continue; }
  grep -F " $a" checksums.txt | grep -E " $a\$" > "$a.sum"
  sha256sum -c "$a.sum" > "$a.verify" 2>&1; rc=$?
  expect "(1) $a: sha256sum -c against checksums.txt" "$rc" "$(tr '\n' ' ' < "$a.verify") sha256=$(sha256sum "$a" | cut -d' ' -f1)"
  d="$WORK/x-$a"; mkdir -p "$d"
  case "$a" in *.zip) unzip -q -o "$a" -d "$d" ;; *) tar -xzf "$a" -C "$d" ;; esac
  for f in $(cd "$d" && find . -type f | sort); do
    echo "$a $f $(sha256sum "$d/$f" | cut -d' ' -f1)" >> "$WORK/inner-hashes.txt"
  done
done
say "INFO  files inside each archive and their sha256:"
sed 's/^/   | /' "$WORK/inner-hashes.txt" | tee -a "$RES"
BIN="$WORK/x-supabase_${VER}_linux_amd64.tar.gz/supabase"
chmod +x "$BIN" "$WORK/x-supabase_${VER}_linux_amd64.tar.gz/supabase-go" 2> /dev/null
CLI="$BIN"
expect "(1) the linux_amd64 binary prints $VER (the only archive executable on this runner)" "$([ "$($BIN --version 2>&1 | tail -1)" = "$VER" ] && echo 0 || echo 1)" "version check"

say "== (1) second sources"
cat > "$WORK/second.py" <<'PY'
import base64, hashlib, json, os, re, sys, urllib.request
ver = os.environ["VER"]; work = os.environ["WORK"]
def get(url, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": "hone-rehearsal", **({"Accept": accept} if accept else {})})
    with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read()
sums = {}
for line in open(f"{work}/checksums.txt"):
    h, n = line.split(); sums[n] = h
# (i) GitHub artifact attestations for each archive digest (unauthenticated public endpoint)
print("-- GitHub artifact attestations (api.github.com/repos/supabase/cli/attestations/sha256:<digest>)")
for n, h in sums.items():
    if not n.startswith(f"supabase_{ver}_"): continue
    try:
        st, body = get(f"https://api.github.com/repos/supabase/cli/attestations/sha256:{h}")
        d = json.loads(body); atts = d.get("attestations", [])
        info = []
        for a in atts:
            env = a.get("bundle", {}).get("dsseEnvelope", {})
            stmt = json.loads(base64.b64decode(env.get("payload", "e30=")))
            subj = [(s.get("name"), s.get("digest", {}).get("sha256")) for s in stmt.get("subject", [])]
            pred = stmt.get("predicate", {})
            bd = pred.get("buildDefinition", {}).get("externalParameters", {}).get("workflow", {})
            info.append({"predicateType": stmt.get("predicateType"), "subjects": subj[:3], "workflow": bd})
        print(f"   {n}: HTTP {st}, {len(atts)} attestation(s) {json.dumps(info)[:400]}")
    except Exception as e:
        print(f"   {n}: no attestation retrieved ({type(e).__name__}: {str(e)[:80]})")
# (ii) Homebrew tap / Scoop bucket publications of the same release
print("-- Homebrew tap and Scoop bucket (separate repositories, separate publishing steps)")
def history(repo, path):
    st, body = get(f"https://api.github.com/repos/{repo}/commits?path={path}&per_page=100")
    return [c["sha"] for c in json.loads(body)]
for repo, path in (("supabase/homebrew-tap", "Formula/supabase.rb"), ("supabase/scoop-bucket", "supabase.json")):
    found = False
    try:
        for sha in history(repo, path):
            st, body = get(f"https://raw.githubusercontent.com/{repo}/{sha}/{path}")
            text = body.decode()
            if ver in text:
                found = True
                hashes = set(re.findall(r"[0-9a-f]{64}", text))
                names = {n: h for n, h in sums.items() if h in hashes}
                print(f"   {repo}@{sha[:8]}: mentions {ver}; {len(hashes)} sha256 values, {len(names)} equal checksums.txt entries: {sorted(names)}")
                print(f"   {repo}: values NOT in checksums.txt: {sorted(h[:12] for h in hashes if h not in set(sums.values()))}")
                break
        if not found: print(f"   {repo}: no commit of {path} mentions {ver} in the last 100")
    except Exception as e:
        print(f"   {repo}: unavailable ({type(e).__name__}: {str(e)[:80]})")
PY
VER="$VER" WORK="$WORK" python3 "$WORK/second.py" 2>&1 | tee -a "$RES"

say "-- npm platform packages vs the release archives (a different publishing channel): sha256 of every file in each @supabase/cli-<platform>@$VER tarball, intersected with the archives' inner files"
PLATFORMS="$(npm view "supabase@$VER" optionalDependencies --json 2> /dev/null | python3 -c "import json,sys; print(' '.join(json.load(sys.stdin).keys()))")"
for p in $PLATFORMS; do
  d="$WORK/npm-$(echo "$p" | tr '/@' '__')"; mkdir -p "$d"
  ( cd "$d" && npm pack "$p@$VER" --silent > pack.out 2> pack.err ); t="$d/$(tail -1 "$d/pack.out" 2> /dev/null)"
  if [ -f "$t" ]; then
    mkdir -p "$d/x"; tar -xzf "$t" -C "$d/x"
    matches=""
    for f in $(cd "$d/x" && find . -type f); do
      h="$(sha256sum "$d/x/$f" | cut -d' ' -f1)"
      m="$(grep -F " $h" "$WORK/inner-hashes.txt" | awk '{print $1":"$2}' | head -2 | tr '\n' ',')"
      [ -n "$m" ] && matches="$matches $f=>$m"
    done
    say "   $p@$VER: $(basename "$t") integrity=$(npm view "$p@$VER" dist.integrity 2> /dev/null | cut -c1-30)...; files equal to archive files:${matches:- NONE}"
  else
    say "   $p@$VER: could not be packed ($(head -c 100 "$d/pack.err"))"
  fi
done

# ====================== (2) update check and telemetry ==============================
say "== (2) what the verified binary sends, observed through a local TLS-intercepting proxy"
cd - > /dev/null
reset_to_0212 || { say "FAIL could not reset to 0212"; exit 1; }
python3 -m venv "$OUT/venv" > /dev/null 2>&1 && "$OUT/venv/bin/pip" install --quiet "mitmproxy==11.0.2" > "$OUT/pip.log" 2>&1 || { tail -n 5 "$OUT/pip.log"; say "FAIL could not install the pinned mitmproxy"; exit 1; }
MITM="$OUT/mitm"; mkdir -p "$MITM"
cat > "$MITM/dump.py" <<'PY'
import json, os
from mitmproxy import http
OUT = os.environ["MITM_OUT"]
class Dump:
    def request(self, flow: http.HTTPFlow):
        r = flow.request
        with open(OUT, "a") as f:
            f.write(json.dumps({"method": r.method, "host": r.pretty_host, "path": r.path,
                                "headers": dict(r.headers.items()),
                                "body": (r.get_text(strict=False) or "")[:20000]}) + "\n")
addons = [Dump()]
PY
PORTP=8089
with_proxy() { # with_proxy <label> <env assignments... --> then the push command arguments as "$@" after --
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
flows() { cat "$OUT/flows-$1.jsonl" 2> /dev/null; }
nflows() { flows "$1" | grep -c . ; }
show_flows() { # one line per request: METHOD host path | has Authorization | body bytes
  python3 - "$OUT/flows-$1.jsonl" <<'PY' | tee -a "$RES"
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line); h = {k.lower(): v for k, v in r["headers"].items()}
    auth = "Authorization: " + h["authorization"][:14] + "..." if "authorization" in h else "no Authorization header"
    print(f"   | {r['method']} {r['host']}{r['path'][:70]} | {auth} | body {len(r['body'])} bytes")
PY
}

CANARY_PW="S1canarypw8K3x"
CANARY_TOKEN="ghp_CANARYtoken0123456789abcdefABCDEF"
docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -c "alter role postgres password '$CANARY_PW'" > /dev/null
trap 'docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1' EXIT
CANARY_URL="postgresql://postgres:$CANARY_PW@$RUNNER_IP:$PORT/postgres?sslmode=require&options=-c%20statement_timeout%3D120000"
CACHE=supabase/.temp/cli-latest
export SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
S1="$BIN db push --db-url $CANARY_URL --dry-run"

# (a) with GITHUB_TOKEN set
rm -f "$CACHE"; unset SUPABASE_TELEMETRY_DISABLED DO_NOT_TRACK
with_proxy a GITHUB_TOKEN="$CANARY_TOKEN" $S1 > "$OUT/run-a.log" 2>&1; RCA=$?
say "-- (a) dry run, GITHUB_TOKEN=<canary>, no cache file, telemetry default: exit=$RCA, $(nflows a) outbound request(s)"
show_flows a
GH_AUTH="$(flows a | python3 -c "
import sys, json
for l in sys.stdin:
    r = json.loads(l)
    if r['host'] == 'api.github.com' and '/releases/latest' in r['path']:
        h = {k.lower(): v for k, v in r['headers'].items()}
        print(h.get('authorization', ''))
")"
expect "(2a) the update check's GET api.github.com/repos/supabase/cli/releases/latest carries the token as 'Authorization: Bearer <GITHUB_TOKEN>'" "$([ "$GH_AUTH" = "Bearer $CANARY_TOKEN" ] && echo 0 || echo 1)" "authorization header begins '${GH_AUTH:0:14}' and equals canary=$([ "$GH_AUTH" = "Bearer $CANARY_TOKEN" ] && echo yes || echo no)"
expect "(2a) the same token is sent to no other host" "$(flows a | python3 -c "
import sys, json
bad = [json.loads(l)['host'] for l in sys.stdin if '$CANARY_TOKEN' in l and json.loads(l)['host'] != 'api.github.com']
sys.exit(1 if bad else 0)" && echo 0 || echo 1)" "hosts that saw the token: api.github.com only"

# (b) without GITHUB_TOKEN
rm -f "$CACHE"
with_proxy b env -u GITHUB_TOKEN -u GH_TOKEN $S1 > "$OUT/run-b.log" 2>&1; RCB=$?
say "-- (b) dry run, GITHUB_TOKEN unset, no cache file: exit=$RCB, $(nflows b) outbound request(s)"
show_flows b
expect "(2b) with GITHUB_TOKEN unset the update check carries NO Authorization header" "$(flows b | python3 -c "
import sys, json
n = 0
for l in sys.stdin:
    r = json.loads(l)
    if r['host'] == 'api.github.com':
        n += 1
        if any(k.lower() == 'authorization' for k in r['headers']): sys.exit(1)
sys.exit(0 if n >= 1 else 1)" && echo 0 || echo 1)" "request to api.github.com present, no Authorization"

# (c) the database URL / password in any outbound request
ALLF="$OUT/flows-all.jsonl"; cat "$OUT"/flows-a.jsonl "$OUT"/flows-b.jsonl > "$ALLF"
PWENC="$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CANARY_PW', safe=''))")"
LEAK=""
for needle in "$CANARY_PW" "$PWENC" "$RUNNER_IP" "postgresql://" "postgres:" "sslmode" "statement_timeout" ":54322"; do
  c="$(grep -c -F -- "$needle" "$ALLF")"; [ "$c" != "0" ] && LEAK="$LEAK [$needle x$c]"
done
expect "(2c) across every outbound request of (a) and (b): the DB password, host/IP, port, 'postgresql://', 'sslmode' and 'statement_timeout' appear NOWHERE (URL, headers, body)" "$([ -z "$LEAK" ] && echo 0 || echo 1)" "searched $(wc -l < "$ALLF") requests; hits:${LEAK:- none}"
say "INFO  (2c) what the telemetry request carries (event name, flags property, env_signals), from the captured body:"
python3 - "$ALLF" <<'PY' | tee -a "$RES"
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r["host"] == "api.github.com": continue
    try: b = json.loads(r["body"])
    except Exception: print(f"   | {r['host']}{r['path'][:50]}: non-JSON body {len(r['body'])} bytes"); continue
    batch = b.get("batch", [b]) if isinstance(b, dict) else b
    for ev in batch:
        p = ev.get("properties", {})
        print(f"   | {r['host']} event={ev.get('event')} flags={json.dumps(p.get('flags'))[:200]} env_signals={json.dumps(p.get('env_signals'))[:160]} exit_code={p.get('exit_code')} is_ci={p.get('is_ci')}")
PY

# (d) a fresh supabase/.temp cache file suppresses the check
ls -l --time-style=+%FT%T "$CACHE" 2> /dev/null | sed 's/^/   | cache after run (b): /' | tee -a "$RES"
with_proxy d GITHUB_TOKEN="$CANARY_TOKEN" SUPABASE_TELEMETRY_DISABLED=1 $S1 > "$OUT/run-d.log" 2>&1; RCD=$?
say "-- (d) same dry run again with the cache from (b) <10 h old, telemetry disabled: exit=$RCD, $(nflows d) outbound request(s)"
show_flows d
expect "(2d) with a fresh cache file there is NO request to api.github.com (and, with telemetry disabled, none at all)" "$([ "$(nflows d)" = "0" ] && echo 0 || echo 1)" "requests=$(nflows d)"
with_proxy d2 GITHUB_TOKEN="$CANARY_TOKEN" SUPABASE_TELEMETRY_DISABLED=1 $BIN --version > "$OUT/run-d2.log" 2>&1
say "-- (d) --version is documented to ALWAYS fetch: requests=$(nflows d2)"; show_flows d2

# (e) the recommended S1 shell form: nothing leaves the machine but the database connection
rm -f "$CACHE"; mkdir -p supabase/.temp; echo "v$VER" > "$CACHE"
docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -c "alter role postgres password 'postgres'" > /dev/null 2>&1
reset_to_0212 > /dev/null 2>&1 || say "WARN reset for (e) failed"
docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -c "alter role postgres password '$CANARY_PW'" > /dev/null 2>&1
N0="$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')"
echo "v$VER" > "$CACHE"
with_proxy e env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false $BIN db push --db-url "$CANARY_URL" --dry-run > "$OUT/run-e-dry.log" 2>&1; RCE1=$?
with_proxy e2 env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false $BIN db push --db-url "$CANARY_URL" --yes > "$OUT/run-e-push.log" 2>&1; RCE2=$?
say "-- (e) recommended S1 shell form: dry-run exit=$RCE1 requests=$(nflows e); push exit=$RCE2 requests=$(nflows e2); rows 0213-0246=$(hist_n)"
expect "(2e) recommended form: the dry run and the real push make ZERO outbound HTTP(S) requests, exit 0, 34 rows recorded" "$([ "$RCE1" = "0" ] && [ "$RCE2" = "0" ] && [ "$(nflows e)" = "0" ] && [ "$(nflows e2)" = "0" ] && [ "$(hist_n)" = "34" ] && grep -q '^Finished supabase db push\.' "$OUT/run-e-push.log" && echo 0 || echo 1)" "dry=$RCE1 push=$RCE2 requests=$(nflows e)/$(nflows e2) rows=$(hist_n)"
expect "(2e) and the output has no update-notice line (the cache says this version is current)" "$(grep -q 'A new version of Supabase CLI' "$OUT/run-e-push.log" && echo 1 || echo 0)" "notice absent"
echo "---- (e) push output tail ----" | tee -a "$RES"
tail -n 3 "$OUT/run-e-push.log" | sed 's/^/   | /' | tee -a "$RES"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
