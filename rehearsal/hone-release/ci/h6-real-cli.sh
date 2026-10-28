#!/bin/bash
# REHEARSAL - NEVER MERGE. Insurance H6 / Machines H6c-b: what the REAL linux_amd64 supabase-go 2.102.0 does for `db query --linked` and `backups list`, recorded
# by a LOCAL fake Management API (fake-mgmt-api.py) and a local TCP listener standing in for the database host. NO database, NO Supabase stack, no hosted call.
# Run as root. The finding this test pins: `db query --linked` runs ParseDatabaseConfig in the CLI's PersistentPreRunE BEFORE the query, which dials the database host
# and, without a database password in the environment, asks the Management API to CREATE A LOGIN ROLE (a write needing a read-write token). The hone-release read
# actions therefore do NOT use the CLI: they call the read-only query endpoint directly (see custody-test.sh, section 8b, for their recorded requests).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d /tmp/hr-h6.XXXXXX); pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
VER=2.102.0
mkdir -p "$T/dl" "$T/cli" "$T/home" "$T/stub" "$T/w/supabase/.temp"
( cd "$T/dl" && env -u SSL_CERT_FILE curl -fsSL -O "https://github.com/supabase/cli/releases/download/v$VER/supabase_${VER}_linux_amd64.tar.gz" ) || { echo "download failed"; exit 1; }
[ "$(sha256sum "$T/dl/supabase_${VER}_linux_amd64.tar.gz" | cut -d' ' -f1)" = 9c0421ba8089ff2ade90654a05441ac04de4a430f852591323319542ec101872 ] || { echo "archive sha mismatch"; exit 1; }
tar -xzf "$T/dl/supabase_${VER}_linux_amd64.tar.gz" -C "$T/cli" supabase-go
[ "$(sha256sum "$T/cli/supabase-go" | cut -d' ' -f1)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] && ok "supabase-go linux_amd64 is the recorded binary (174a90e2)" || { bad "sha"; exit 1; }
REF=abcdefghijklmnopqrst; TOK="sbp_$(printf 'a1%.0s' $(seq 1 20))"; echo "$TOK" > "$T/stub/canary-pat"
cat > "$T/profile.yaml" <<YAML
name: fake
api_url: http://127.0.0.1:18081
dashboard_url: http://127.0.0.1:18082
project_host: supabase.test
YAML
grep -q "db.$REF.supabase.test" /etc/hosts || echo "127.0.0.1 db.$REF.supabase.test" >> /etc/hosts
printf '%s' "$REF" > "$T/w/supabase/.temp/project-ref"; echo v2.102.0 > "$T/w/supabase/.temp/cli-latest"
nohup python3 -I "$HERE/fake-mgmt-api.py" 18081 "$T/stub" "$T/api.log" > "$T/api.out" 2>&1 & sleep 1
LISTEN() { python3 -I -c "import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1',5432)); s.listen(5)
while True:
    c,_=s.accept(); c.close()" > /dev/null 2>&1 & LP=$!; sleep 1; }
run() { # run LABEL [extra env]... -- args
  : > "$T/api.log"; local e=(HOME="$T/home" SUPABASE_PROFILE="$T/profile.yaml" SUPABASE_ACCESS_TOKEN="$TOK" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PATH=/usr/bin:/bin)
  while [ "$1" != -- ]; do e+=("$1"); shift; done; shift
  ( cd "$T/w" && timeout 60 env -i "${e[@]}" "$T/cli/supabase-go" "$@" ) > "$T/out.txt" 2>&1; RC=$?; }
paths() { python3 -I -c "import json,re
for l in open('$T/api.log'):
    r=json.loads(l); print(r['method'], re.sub(r'/v1/projects/[a-z0-9-]+','/v1/projects/<ref>',r['path']))" | sort | uniq; }
LOGIN="POST /v1/projects/<ref>/cli/login-role"

# D1: the database host answers (a listener), NO database password: the CLI asks the Management API to create a login role
LISTEN
run X=1 -- db query --linked -o json "select 1 as x"
echo "D1 observed (rc=$RC):"; paths | sed 's/^/       /'; tail -n 2 "$T/out.txt" | sed 's/^/       cli: /'
paths | grep -qx "$LOGIN" && ok "H6 FINDING (real CLI): db query --linked WITHOUT a database password asks the Management API to CREATE A LOGIN ROLE (POST .../cli/login-role) before any query: the read token would need read-write scope and a role would be created" || bad "D1: no login-role request seen; the finding is not reproduced" "$(paths | tr '\n' ';')"
# D2: same, with a (non-secret) database password in the environment
run SUPABASE_DB_PASSWORD=placeholder-not-a-secret -- db query --linked -o json "select 1 as x"
echo "D2 observed (rc=$RC):"; paths | sed 's/^/       /'
! paths | grep -qE "login-role|network-bans" && ok "with SUPABASE_DB_PASSWORD set and the database host reachable the CLI makes no login-role and no network-bans request" || bad "D2: login-role or bans requested" "$(paths | tr '\n' ';')"
kill $LP 2>/dev/null; wait $LP 2>/dev/null
# D3: the database host does NOT answer (Machines H6c-b) and no pooler-url: the CLI stops before any query
run SUPABASE_DB_PASSWORD=placeholder-not-a-secret -- db query --linked -o json "select 1 as x"
echo "D3 observed (rc=$RC): $(tail -n 2 "$T/out.txt" | tr '\n' ' ')"
[ $RC -ne 0 ] && grep -q "IPv6 is not supported" "$T/out.txt" && [ ! -s "$T/api.log" ] && ok "H6c-b reproduced with the real binary: database host unreachable + no pooler-url -> 'IPv6 is not supported ...' and NO request reached the Management API (the CLI dials the database host first)" || bad "D3 not as Machines recorded" "rc=$RC $(paths | tr '\n' ';')"
# D4: unreachable database host but a pooler-url file and the password in the environment
printf 'postgresql://postgres.%s@aws-0-us-east-1.pooler.supabase.test:5432/postgres' "$REF" > "$T/w/supabase/.temp/pooler-url"
run SUPABASE_DB_PASSWORD=placeholder-not-a-secret -- db query --linked -o json "select 1 as x"
echo "D4 observed (rc=$RC):"; paths | sed 's/^/       /'; tail -n 2 "$T/out.txt" | sed 's/^/       cli: /'
! paths | grep -qE "login-role|network-bans" && ok "with a pooler-url file and the password in the environment the CLI falls back without any login-role or bans request" || bad "D4: login-role or bans requested" "$(paths | tr '\n' ';')"
rm -f "$T/w/supabase/.temp/pooler-url"
# B: the API-only command used before: backups list
run -- backups list --project-ref "$REF" -o json
echo "B observed (rc=$RC):"; paths | sed 's/^/       /'
[ "$(paths | wc -l)" -ge 1 ] && ! paths | grep -qE "login-role|network-bans|query" && ok "backups list asks only the backups endpoint (API-only command; no database config is parsed)" || bad "backups list requests" "$(paths | tr '\n' ';')"
echo "RESULT (h6): $pass passed, $fail failed"
EXPECT=6; [ $((pass + fail)) = $EXPECT ] || { echo "FAIL - $((pass + fail)) of $EXPECT cases ran (a skipped or vacuous case; change EXPECT only with a reviewed case change)"; exit 1; }
[ "$fail" = 0 ]
