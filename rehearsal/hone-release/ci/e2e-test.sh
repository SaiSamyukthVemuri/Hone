#!/bin/bash
# REHEARSAL - NEVER MERGE. The REAL vendor CLI (linux_amd64 supabase-go, archive 9c0421ba / inner 174a90e2) applying a package through the REAL launcher,
# sudoers line, hone-release user and APPROVED-PACKAGE. Run as root. usage: e2e-test.sh pg|supavisor
#   supavisor: the REAL bundle (the 34 files 0213..0246 of d189768b) through the LOCAL Supavisor SESSION pooler (behind the TLS relay that counts
#              connections), on a SYNTHETIC database built through production's prefix 0212 (NOT a verified copy of production). Needs the supabase
#              local stack (its database image comes from ghcr.io).
#   pg:        a SYNTHETIC bundle (the 245 real file NAMES, trivial SQL) against a plain local PostgreSQL 16 with TLS (no Supavisor, no docker pull).
# The only rewrite of the shipped scripts (supavisor mode): the project_ref pattern (the local pooler tenant is "pooler-dev"). Canary credentials only.
set -u
MODE=${1:?pg|supavisor}
HERE="$(cd "$(dirname "$0")" && pwd)"; HR="$HERE/.."; S1="$HR/../s1-script"
T=$(mktemp -d /tmp/hr-e2e.XXXXXX); chmod 755 "$T"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
LB=/usr/local/libexec/hone-release/launcher
VER=2.102.0
mkdir -p "$T/dl" "$T/cli"
( cd "$T/dl" && env -u SSL_CERT_FILE curl -fsSL -O "https://github.com/supabase/cli/releases/download/v$VER/supabase_${VER}_linux_amd64.tar.gz" ) || { echo "download failed"; exit 1; }
[ "$(sha256sum "$T/dl/supabase_${VER}_linux_amd64.tar.gz" | cut -d' ' -f1)" = 9c0421ba8089ff2ade90654a05441ac04de4a430f852591323319542ec101872 ] || { echo "archive sha mismatch"; exit 1; }
tar -xzf "$T/dl/supabase_${VER}_linux_amd64.tar.gz" -C "$T/cli" supabase-go; chmod 755 "$T/cli/supabase-go"
[ "$(sha256sum "$T/cli/supabase-go" | cut -d' ' -f1)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] && ok "supabase-go linux_amd64 is the recorded binary (174a90e2)" || { bad "supabase-go sha"; exit 1; }
chmod 440 /etc/sudoers.d/* 2>/dev/null
HEAD40=d189768b86fe1c53e330c65078f3a9f2949f8e59

if [ "$MODE" = supavisor ]; then
  DB="${DB:?the supabase db container name}"
  psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
  for _ in $(seq 1 30); do psqld -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
  [ "$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')" = 211 ] && [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')" = 0212 ] || { echo "history is not 211 rows / max 0212"; exit 1; }
  POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"; [ -n "$POOLER" ] || { echo "no pooler"; exit 1; }
  TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"; TENANT="${TENANT:-pooler-dev}"
  IP="$(hostname -I | awk '{print $1}')"
  openssl req -new -x509 -days 1 -nodes -text -out "$T/relay.crt" -keyout "$T/relay.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP" >/dev/null 2>&1
  export COUNT_FILE="$T/accepts.txt"; : > "$COUNT_FILE"
  nohup python3 -I "$S1/tlsfront-count.py" "$T/relay.crt" "$T/relay.key" 54330 54329 > "$T/relay.log" 2>&1 &
  sleep 3
  REF="$TENANT"; POOLER_HOST="$IP:54330"; URL="postgresql://postgres.$TENANT@$IP:54330/postgres?sslmode=require"
  for _ in $(seq 1 30); do PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' 2>/dev/null | grep -qx 1 && break; sleep 2; done
  PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' | grep -qx 1 || { echo "the pooler does not answer through the relay"; exit 1; }
  : > "$COUNT_FILE"
  conns() { wc -l < "$COUNT_FILE" | tr -d ' '; }
  hist() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }
  histmax() { psqld -c 'select max(version) from supabase_migrations.schema_migrations'; }
  GOODPW=postgres
  BUNDLE="$S1/migrations-d189768b.tar"; LIST="$S1/MIGRATIONS-d189768b.sha256"
  RELAX=1; BASEHIST=211
else
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
  [ -x "$PGBIN/initdb" ] || { apt-get install -y -qq postgresql >/dev/null 2>&1; PGBIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1); }
  PGD=$T/pgdata; install -d -o postgres -g postgres "$PGD" "$T/sock" "$T/pgl"; chmod 755 "$T"
  runuser -u postgres -- "$PGBIN/initdb" -D "$PGD" -U admin -A trust -E UTF8 >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
  openssl req -new -x509 -days 1 -nodes -out "$PGD/server.crt" -keyout "$PGD/server.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1; chown postgres:postgres "$PGD/server.crt" "$PGD/server.key"; chmod 600 "$PGD/server.key"
  cat >> "$PGD/postgresql.conf" <<CONF
port = 54329
listen_addresses = '127.0.0.1'
unix_socket_directories = '$T/sock'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
log_connections = on
password_encryption = scram-sha-256
CONF
  printf 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 reject\n' > "$PGD/pg_hba.conf"
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGD" -l "$T/pgl/pg.log" -w start >/dev/null || { cat "$T/pgl/pg.log"; exit 1; }
  psqld() { "$PGBIN/psql" -X -q -A -t -v ON_ERROR_STOP=1 -h "$T/sock" -p 54329 -U admin -d postgres "$@"; }
  REF=abcdefghijklmnopqrst
  psqld -c "create role \"postgres.$REF\" login superuser password 'postgres'"
  python3 -I "$S1/fixture.py" syn "$T/syn" --head $HEAD40 >/dev/null
  psqld -c "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);" >/dev/null
  awk '{v=substr($2,1,4); if (v+0<=212) printf "insert into supabase_migrations.schema_migrations (version,name) values (\x27%s\x27,\x27%s\x27);\n", v, substr($2,6,length($2)-9)}' "$T/syn/MIGRATIONS-d189768b.sha256" | psqld >/dev/null
  POOLER_HOST="127.0.0.1:54329"
  conns() { grep -c 'connection received' "$T/pgl/pg.log"; }
  hist() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }
  histmax() { psqld -c 'select max(version) from supabase_migrations.schema_migrations'; }
  GOODPW=postgres
  BUNDLE="$T/syn/migrations-d189768b.tar"; LIST="$T/syn/MIGRATIONS-d189768b.sha256"
  RELAX=0; BASEHIST=211
fi
[ "$(hist)" = 211 ] || { echo "history is not 211 rows"; exit 1; }

# ---- install the shipped scripts (one rewrite in supavisor mode), the real CLI and the real launcher/sudoers
id sam >/dev/null 2>&1 || useradd -m -s /bin/bash sam
SRC=/opt/hr-pkg-e2e; rm -rf "$SRC" /opt/hr-pins-e2e.txt; mkdir -p "$SRC/scripts"
cp "$HR/launcher" "$HR/install.sh" "$HR/set-secret.sh" "$HR/approve-package.sh" "$HR/actions.conf" "$HR/sudoers.hone-release" "$SRC/"; cp "$HR"/scripts/*.sh "$SRC/scripts/"
python3 - "$SRC/scripts/release-apply.sh" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
a="'^aws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com:5432$'"
assert a in s
open(p,"w").write(s.replace(a,"'^[0-9.]+:[0-9]+$'"))
PY
echo "e2e rewrites: the pooler_host pattern (aws-N-region.pooler.supabase.com:5432 -> a local IP:port) in release-apply.sh"
if [ "$RELAX" = 1 ]; then
  sed -i 's/\[a-z0-9\]{20}/[a-z0-9-]{10,20}/' "$SRC/scripts/release-apply.sh" "$SRC/scripts/read-backups.sh" "$SRC/install.sh"
  echo "e2e rewrites: the project_ref pattern [a-z0-9]{20} -> [a-z0-9-]{10,20} in release-apply.sh, read-backups.sh and install.sh (the local pooler tenant is pooler-dev)"
fi
chown -R root:root "$SRC"; chmod -R go-w "$SRC"
(cd "$SRC" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done) > /opt/hr-pins-e2e.txt; chown root:root /opt/hr-pins-e2e.txt; chmod 644 /opt/hr-pins-e2e.txt
bash "$SRC/install.sh" sam "$REF" "$T/cli/supabase-go" /opt/hr-pins-e2e.txt > "$T/install.out" 2>&1 && ok "install.sh with the REAL supabase-go (every file matched its pin)" || { bad "install" "$(tail -4 "$T/install.out")"; exit 1; }
# T5 evidence: the vendor CLI does NOT honour sslmode/sslrootcert in --db-url (it rebuilds the URL), so verify-full cannot be required on this path:
# a dry run with sslmode=verify-full and a NONEXISTENT sslrootcert still connects (an honoured setting would fail).
mkdir -p "$T/probe/supabase/migrations" "$T/probe/supabase/.temp"; echo v2.102.0 > "$T/probe/supabase/.temp/cli-latest"
PROBE_URL="postgresql://postgres.$REF@${POOLER_HOST}/postgres?sslmode=verify-full&sslrootcert=/nonexistent/ca.pem"
c0=$(conns)
( cd "$T/probe" && HOME="$T/probe" PGPASSWORD=postgres SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$T/cli/supabase-go" db push --db-url "$PROBE_URL" --dry-run > "$T/probe.out" 2>&1 ); prc=$?
if [ "$prc" = 0 ] && [ "$(( $(conns) - c0 ))" -ge 1 ]; then ok "T5 evidence: supabase-go connects with sslmode=verify-full and a nonexistent sslrootcert (it drops both): verify-full cannot be enforced on this path; the exact pooler-host pin is the control (accepted residual)"; else bad "T5 probe" "rc=$prc $(tail -3 "$T/probe.out")"; fi
install -m 644 -o sam -g sam "$BUNDLE" /srv/hone-release-inbox/bundle.tar
install -m 644 -o sam -g sam "$LIST" /srv/hone-release-inbox/list.sha256
RECEIPT=$(printf 'a%.0s' $(seq 1 64))
approve() { bash "$SRC/approve-package.sh" id="$1" bundle_sha="$(sha256sum /srv/hone-release-inbox/bundle.tar | cut -d' ' -f1)" list_sha="$(sha256sum /srv/hone-release-inbox/list.sha256 | cut -d' ' -f1)" head="$HEAD40" pr=1193 receipt_sha="$RECEIPT" first=0213 last=0246 count=34 minutes=30 \
  window_start="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)" window_end="$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)" recovery_basis=waiver recovery_point=none waiver_id=E2E-WAIVER pooler_host="$POOLER_HOST" max_push_seconds=300 attestation="synthetic target; recovery not applicable" > "$T/approve.out" 2>&1; }
setpw() { printf '%s\n' "$1" | bash "$SRC/set-secret.sh" db-password --stdin >/dev/null; }
SAMOUT="$T/sam.txt"; : > "$SAMOUT"; chmod 666 "$SAMOUT"
runo() { OUT=$(runuser -u sam -- env -i PATH=/usr/bin:/bin HOME=/home/sam sudo -n -u hone-release $LB "$@" 2>&1); RC=$?; printf '%s\n' "$OUT" >> "$SAMOUT"; }
state() { cat /var/lib/hone-release/state/APPLY-STATE 2>/dev/null || echo none; }

# ---- 1. a wrong password: ONE connection, FAILED-LOGIN, nothing applied, then blocked
c0=$(conns); approve E2E-WRONG; setpw "WRONG-CANARY-5d41"
runo apply
c=$(( $(conns) - c0 ))
[ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-LOGIN ] && [ "$c" = 1 ] && [ "$(hist)" = 211 ] && ok "wrong password through the real CLI ($MODE): ONE connection, exit non-zero, state FAILED-LOGIN, history still 211" || bad "wrong password" "rc=$RC conn=$c state=$(state) hist=$(hist) $OUT"
printf '%s' "$OUT" | grep -q "WRONG-CANARY" && bad "the wrong password was printed" || ok "the wrong password is not in the output the agent received"
approve E2E-WRONG2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q FAILED-LOGIN && ok "while FAILED-LOGIN stands the next run is refused" || bad "not blocked" "$OUT"
rm -f /var/lib/hone-release/state/APPLY-STATE

# ---- 2. the real push through the launcher
setpw "$GOODPW"; approve E2E-GOOD; c0=$(conns)
( while :; do ps -axww -o args= 2>/dev/null | grep -E 'supabase-go'; sleep 0.05; done > "$T/ps.txt" ) & SP=$!
runo apply
kill $SP 2>/dev/null; wait $SP 2>/dev/null
c=$(( $(conns) - c0 ))
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && [ "$(hist)" = 245 ] && [ "$(histmax)" = 0246 ]; then ok "34 migrations applied through the launcher with the real CLI ($MODE): history 245, max 0246"; else bad "real apply" "rc=$RC hist=$(hist) $OUT"; fi
[ "$c" = 2 ] && ok "exactly 2 connection attempts (one dry run, one push)" || bad "connection attempts: $c"
[ "$(state | cut -d' ' -f1)" = APPLIED ] && [ -d /var/lib/hone-release/state/consumed/E2E-GOOD ] && ok "state APPLIED and the approval consumed" || bad "state" "$(state)"
grep -q 'db push' "$T/ps.txt" && ok "the process sampler saw the CLI (the argv check is not vacuous)" || bad "sampler never saw the CLI"
! grep -Eq 'PGPASSWORD|:postgres@|assword=' "$T/ps.txt" && ok "no password in the CLI's argv" || bad "password in argv"
[ "$(grep -a -c '^Applying migration' /var/lib/hone-release/logs/E2E-GOOD/push.log)" = 34 ] && ok "push log (kept under the release logs): 34 Applying migration lines" || bad "push log lines"
approve E2E-AGAIN; runo apply; [ $RC -ne 0 ] && [ "$(hist)" = 245 ] && ok "a further apply with a new approval does not push again (nothing pending: refused, history unchanged)" || bad "second apply" "rc=$RC $OUT"
echo "RESULT ($MODE): $pass passed, $fail failed"
[ "$fail" = 0 ]
