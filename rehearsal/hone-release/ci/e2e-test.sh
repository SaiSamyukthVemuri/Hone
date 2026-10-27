#!/bin/bash
# REHEARSAL - NEVER MERGE. The REAL vendor CLI (linux_amd64 supabase-go, archive 9c0421ba / inner 174a90e2) applying the REAL bundle (the 34 files
# 0213..0246 of d189768b) through the LOCAL Supavisor SESSION pooler (behind the TLS relay that counts connections), run through the REAL launcher,
# sudoers line, hone-release user and APPROVED-PACKAGE, on a SYNTHETIC database built through production's prefix 0212 (NOT a verified copy of
# production). Run as root. The only rewrite of the shipped scripts: the project_ref pattern (the local pooler's tenant id is "pooler-dev", not a
# 20-character ref). Canary credentials only.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; HR="$HERE/.."; S1="$HR/../s1-script"
T=$(mktemp -d /tmp/hr-e2e.XXXXXX); chmod 755 "$T"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
DB="${DB:?the supabase db container name}"
LB=/usr/local/libexec/hone-release/launcher
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
VER=2.102.0
mkdir -p "$T/dl" "$T/cli"
( cd "$T/dl" && env -u SSL_CERT_FILE curl -fsSL -O "https://github.com/supabase/cli/releases/download/v$VER/supabase_${VER}_linux_amd64.tar.gz" ) || { echo "download failed"; exit 1; }
[ "$(sha256sum "$T/dl/supabase_${VER}_linux_amd64.tar.gz" | cut -d' ' -f1)" = 9c0421ba8089ff2ade90654a05441ac04de4a430f852591323319542ec101872 ] || { echo "archive sha mismatch"; exit 1; }
tar -xzf "$T/dl/supabase_${VER}_linux_amd64.tar.gz" -C "$T/cli" supabase-go; chmod 755 "$T/cli/supabase-go"
[ "$(sha256sum "$T/cli/supabase-go" | cut -d' ' -f1)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] && ok "supabase-go linux_amd64 is the recorded binary (174a90e2)" || { bad "supabase-go sha"; exit 1; }
for _ in $(seq 1 30); do psqld -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
[ "$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')" = 211 ] && [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')" = 0212 ] || { echo "history is not 211 rows / max 0212"; exit 1; }
POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"; [ -n "$POOLER" ] || { echo "no pooler"; exit 1; }
TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"; TENANT="${TENANT:-pooler-dev}"
openssl req -new -x509 -days 1 -nodes -text -out "$T/relay.crt" -keyout "$T/relay.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
export COUNT_FILE="$T/accepts.txt"; : > "$COUNT_FILE"
nohup python3 -I "$S1/tlsfront-count.py" "$T/relay.crt" "$T/relay.key" 54330 54329 > "$T/relay.log" 2>&1 &
sleep 3
IP="$(hostname -I | awk '{print $1}')"; URL="postgresql://postgres.$TENANT@$IP:54330/postgres?sslmode=require"
for _ in $(seq 1 30); do PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' 2>/dev/null | grep -qx 1 && break; sleep 2; done
PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' | grep -qx 1 || { echo "the pooler does not answer through the relay"; exit 1; }
: > "$COUNT_FILE"

# ---- install the shipped scripts with ONE rewrite (project_ref pattern), the real CLI and the real launcher/sudoers
id sam >/dev/null 2>&1 || useradd -m -s /bin/bash sam
SRC="$T/src"; mkdir -p "$SRC/scripts"; cp "$HR/launcher" "$HR/install.sh" "$HR/set-secret.sh" "$HR/approve-package.sh" "$HR/actions.conf" "$HR/sudoers.hone-release" "$SRC/"; cp "$HR"/scripts/*.sh "$SRC/scripts/"
sed -i 's/\[a-z0-9\]{20}/[a-z0-9-]{10,20}/' "$SRC/scripts/release-apply.sh" "$SRC/scripts/read-backups.sh" "$SRC/install.sh"
echo "e2e rewrites: the project_ref pattern [a-z0-9]{20} -> [a-z0-9-]{10,20} in release-apply.sh, read-backups.sh and install.sh (the local pooler tenant is pooler-dev)"
bash "$SRC/install.sh" sam "$TENANT" "$T/cli/supabase-go" > "$T/install.out" 2>&1 && ok "install.sh with the REAL supabase-go" || { bad "install" "$(tail -4 "$T/install.out")"; exit 1; }
install -m 644 -o sam -g sam "$HR/../s1-script/migrations-d189768b.tar" /srv/hone-release-inbox/bundle.tar
install -m 644 -o sam -g sam "$HR/../s1-script/MIGRATIONS-d189768b.sha256" /srv/hone-release-inbox/list.sha256
HEAD=d189768b86fe1c53e330c65078f3a9f2949f8e59
in1h() { date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ; }
approve() { bash "$SRC/approve-package.sh" "$1" 0213 0246 34 "$(in1h)" "$URL" "recovery point attested by the approver, not verified here" --yes > "$T/approve.out" 2>&1; }
setpw() { printf '%s\n' "$1" | bash "$SRC/set-secret.sh" db-password --stdin >/dev/null; }
SAMOUT="$T/sam.txt"; : > "$SAMOUT"; chmod 666 "$SAMOUT"
runo() { OUT=$(runuser -u sam -- env -i PATH=/usr/bin:/bin HOME=/home/sam sudo -n -u hone-release $LB "$@" 2>&1); RC=$?; printf '%s\n' "$OUT" >> "$SAMOUT"; }
state() { cat /var/lib/hone-release/state/APPLY-STATE 2>/dev/null || echo none; }
hist() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }

# ---- 1. a wrong password: ONE connection, FAILED-LOGIN, nothing applied, then blocked
approve E2E-WRONG; setpw "WRONG-CANARY-5d41"
runo apply
c=$(wc -l < "$COUNT_FILE" | tr -d ' ')
[ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-LOGIN ] && [ "$c" = 1 ] && [ "$(hist)" = 211 ] && ok "wrong password through the real CLI and Supavisor: ONE connection, exit non-zero, state FAILED-LOGIN, history still 211" || bad "wrong password" "rc=$RC conn=$c state=$(state) hist=$(hist) $OUT"
printf '%s' "$OUT" | grep -q "WRONG-CANARY" && bad "the wrong password was printed" || ok "the wrong password is not in the output the agent received"
approve E2E-WRONG2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q FAILED-LOGIN && ok "while FAILED-LOGIN stands the next run is refused" || bad "not blocked" "$OUT"
rm -f /var/lib/hone-release/state/APPLY-STATE; : > "$COUNT_FILE"

# ---- 2. the real push through the launcher
setpw "postgres"; approve E2E-GOOD
( while :; do ps -axww -o args= 2>/dev/null | grep -E 'supabase-go'; sleep 0.05; done > "$T/ps.txt" ) & SP=$!
runo apply
kill $SP 2>/dev/null; wait $SP 2>/dev/null
c=$(wc -l < "$COUNT_FILE" | tr -d ' ')
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && [ "$(hist)" = 245 ] && [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')" = 0246 ]; then ok "the REAL 34 files applied through the launcher with the real CLI and Supavisor: history 245, max 0246"; else bad "real apply" "rc=$RC hist=$(hist) $OUT"; fi
[ "$c" = 2 ] && ok "exactly 2 connection attempts (one dry run, one push)" || bad "connection attempts: $c"
[ "$(state | cut -d' ' -f1)" = APPLIED ] && [ -d /var/lib/hone-release/state/consumed/E2E-GOOD ] && ok "state APPLIED and the approval consumed" || bad "state" "$(state)"
grep -q 'db push' "$T/ps.txt" && ok "the process sampler saw the CLI (the argv check is not vacuous)" || bad "sampler never saw the CLI"
! grep -Eq 'PGPASSWORD|:postgres@|assword=' "$T/ps.txt" && ok "no password in the CLI's argv" || bad "password in argv"
ls /var/lib/hone-release/logs/E2E-GOOD/ >/dev/null 2>&1 && ok "run record and logs kept under the release logs (owner hone-release)" || bad "no run record"
grep -a 'Applying migration' /var/lib/hone-release/logs/E2E-GOOD/push.log | wc -l | grep -qx 34 && ok "push log: 34 Applying migration lines" || bad "push log lines"
approve E2E-AGAIN; runo apply; [ $RC -ne 0 ] && ok "a further apply of the same bundle with a new approval does not re-push (the state allows it, the dry run finds nothing pending and the script refuses)" || bad "second apply succeeded" "$OUT"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
