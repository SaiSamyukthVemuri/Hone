#!/bin/bash
# REHEARSAL - NEVER MERGE. The REAL vendor CLI (linux_amd64 supabase-go, archive 9c0421ba / inner 174a90e2) applying a package through the REAL launcher,
# sudoers line, hone-release user and APPROVED-PACKAGE. Run as root. usage: e2e-test.sh pg|supavisor
#   pg:        DIRECT connection form (db.<ref>.supabase.co:<port>, startup options, user postgres) against a plain local PostgreSQL 16 with TLS from a TEST CA
#              (host name mapped in /etc/hosts); a SYNTHETIC bundle (the 245 real file NAMES, trivial SQL). Proves T5 (verify-full) and T4 B1 (server-side
#              timeouts through the real CLI, including the CLI's RESET ALL between files) and the client wall clock KILL.
#   supavisor: POOLER form through the local Supavisor SESSION pooler (behind the TLS relay that counts connections) with a SYNTHETIC bundle whose files carry
#              their own `set local statement_timeout` (B2); the REAL 34 files are shown to be REFUSED by the pooler gate. Needs the supabase local stack.
# Rewrites of the shipped scripts (each printed): the test CA sha in CA_SHA (and the CA file), the host pattern/port, and (supavisor) the project_ref pattern.
# Canary credentials only. Nothing here touches a hosted system.
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

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
if [ "$MODE" = supavisor ]; then
  DB="${DB:?the supabase db container name}"
  psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
  for _ in $(seq 1 30); do psqld -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
  [ "$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')" = 211 ] && [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')" = 0212 ] || { echo "history is not 211 rows / max 0212"; exit 1; }
  POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"; [ -n "$POOLER" ] || { echo "no pooler"; exit 1; }
  TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"; TENANT="${TENANT:-pooler-dev}"
  IP="$(hostname -I | awk '{print $1}')"
  # the relay's certificate doubles as the TEST CA (a self-signed leaf is a valid trust anchor); its SAN holds the IP the CLI connects to
  openssl req -new -x509 -days 1 -nodes -text -out "$T/relay.crt" -keyout "$T/relay.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP" >/dev/null 2>&1
  export COUNT_FILE="$T/accepts.txt"; : > "$COUNT_FILE"
  nohup python3 -I "$S1/tlsfront-count.py" "$T/relay.crt" "$T/relay.key" 54330 54329 > "$T/relay.log" 2>&1 &
  sleep 3
  REF="$TENANT"; DMB=8; DBHOST="$IP:54330"; CM=pooler; PH="$DBHOST"; TESTCA="$T/relay.crt"
  for _ in $(seq 1 30); do PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' 2>/dev/null | grep -qx 1 && break; sleep 2; done
  PGPASSWORD=postgres PGSSLMODE=require psql "postgresql://postgres.$TENANT@$IP:54330/postgres" -X -At -c 'select 1' | grep -qx 1 || { echo "the pooler does not answer through the relay"; exit 1; }
  : > "$COUNT_FILE"
  conns() { wc -l < "$COUNT_FILE" | tr -d ' '; }
  GOODPW=postgres
  python3 -I "$S1/fixture.py" syn "$T/syn" --head $HEAD40 --all-setlocal >/dev/null
  BUNDLE="$T/syn/migrations-d189768b.tar"; LIST="$T/syn/MIGRATIONS-d189768b.sha256"
  REALBUNDLE="$S1/migrations-d189768b.tar"; REALLIST="$S1/MIGRATIONS-d189768b.sha256"
  RELAX=1; TLSUSER="postgres.$TENANT"
else
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
  [ -x "$PGBIN/initdb" ] || { apt-get install -y -qq postgresql >/dev/null 2>&1; PGBIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1); }
  PGD=$T/pgdata; install -d -o postgres -g postgres "$PGD" "$T/sock" "$T/pgl"; chmod 755 "$T"
  runuser -u postgres -- "$PGBIN/initdb" -D "$PGD" -U admin -A trust -E UTF8 >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
  REF=abcdefghijklmnopqrst; DBH="db.$REF.supabase.co"
  # TEST CA, a server certificate for the exact direct host name, and an IMPOSTOR certificate for the same name from a DIFFERENT CA
  mkca() { openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/$1.key" -out "$T/$1.pem" -days 1 -subj "/CN=$1" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" >/dev/null 2>&1; }
  mkleaf() { # mkleaf CA OUTBASE SAN
    openssl req -newkey rsa:2048 -nodes -keyout "$T/$2.key" -out "$T/$2.csr" -subj "/CN=$DBH" >/dev/null 2>&1
    printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$3" > "$T/$2.ext"
    openssl x509 -req -in "$T/$2.csr" -CA "$T/$1.pem" -CAkey "$T/$1.key" -CAcreateserial -out "$T/$2.crt" -days 1 -extfile "$T/$2.ext" >/dev/null 2>&1; }
  mkca testca; mkca wrongca; mkleaf testca server "DNS:$DBH"; mkleaf wrongca impostor "DNS:$DBH"
  cp "$T/server.crt" "$PGD/server.crt"; cp "$T/server.key" "$PGD/server.key"; chown postgres:postgres "$PGD/server.crt" "$PGD/server.key"; chmod 600 "$PGD/server.key"
  cat >> "$PGD/postgresql.conf" <<CONF
port = 54329
listen_addresses = '127.0.0.1'
unix_socket_directories = '$T/sock'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
log_connections = on
wal_level = logical
password_encryption = scram-sha-256
CONF
  printf 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 reject\n' > "$PGD/pg_hba.conf"
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGD" -l "$T/pgl/pg.log" -w start >/dev/null || { cat "$T/pgl/pg.log"; exit 1; }
  psqld() { "$PGBIN/psql" -X -q -A -t -v ON_ERROR_STOP=1 -h "$T/sock" -p 54329 -U admin -d postgres "$@"; }
  grep -q " $DBH" /etc/hosts || echo "127.0.0.1 $DBH" >> /etc/hosts
  psqld -c "create role postgres login superuser password 'postgres'"
  python3 -I "$S1/fixture.py" syn "$T/syn" --head $HEAD40 >/dev/null
  psqld -c "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);" >/dev/null
  awk '{v=substr($2,1,4); if (v+0<=212) printf "insert into supabase_migrations.schema_migrations (version,name) values (\x27%s\x27,\x27%s\x27);\n", v, substr($2,6,length($2)-9)}' "$T/syn/MIGRATIONS-d189768b.sha256" | psqld >/dev/null
  DBHOST="$DBH:54329"; CM=direct; PH=none; TESTCA="$T/testca.pem"
  conns() { grep -c 'connection received' "$T/pgl/pg.log"; }
  GOODPW=postgres
  BUNDLE="$T/syn/migrations-d189768b.tar"; LIST="$T/syn/MIGRATIONS-d189768b.sha256"
  RELAX=0; TLSUSER=postgres
fi
hist() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }
histmax() { psqld -c 'select max(version) from supabase_migrations.schema_migrations'; }
[ "$(hist)" = 211 ] || { echo "history is not 211 rows"; exit 1; }
reset_db() { psqld -c "delete from supabase_migrations.schema_migrations where version > '0212'" >/dev/null; for t in $(psqld -c "select tablename from pg_tables where schemaname='public' and tablename like 's1_t%'"); do psqld -c "drop table public.$t" >/dev/null; done; rm -f /var/lib/hone-release/state/APPLY-STATE; }

# ---- install the shipped scripts (disclosed rewrites only), the real CLI and the real launcher/sudoers
id sam >/dev/null 2>&1 || useradd -m -s /bin/bash sam
SRC=/root/hr-pkg-e2e; rm -rf "$SRC" /root/hr-pins-e2e.txt; mkdir -p "$SRC/scripts" "$SRC/ca" "$SRC/tools"
cp "$HR/launcher" "$HR/install.sh" "$HR/set-secret.sh" "$HR/approve-package.sh" "$HR/bind-gonogo.sh" "$HR/bind-serving.sh" "$HR/actions.conf" "$HR/sudoers.hone-release" "$SRC/"; cp "$HR"/scripts/* "$SRC/scripts/"
cp "$TESTCA" "$SRC/ca/supabase-prod-ca-2021.crt"; cp "$HR"/tools/make-verify-bundle.py "$SRC/tools/"
TESTCA_SHA=$(sha256sum "$TESTCA" | cut -d' ' -f1)
sed -i "s/^CA_SHA=.*/CA_SHA=$TESTCA_SHA/" "$SRC/scripts/release-apply.sh" "$SRC/scripts/heartbeat.sh"
echo "e2e rewrites: CA_SHA in release-apply.sh and heartbeat.sh -> the sha256 of the TEST CA ($TESTCA_SHA), and the packaged CA file -> the TEST CA (the shipped pin is the Supabase Root 2021 CA, 70072358...)"
if [ "$MODE" = supavisor ]; then
  python3 - "$SRC/scripts/release-apply.sh" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
a="'^aws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com:5432$'"
assert a in s
open(p,"w").write(s.replace(a,"'^[0-9.]+:[0-9]+$'"))
PY
  echo "e2e rewrites: the pooler_host pattern (aws-N-region.pooler.supabase.com:5432 -> a local IP:port) in release-apply.sh"
  sed -i 's/\[a-z0-9\]{20}/[a-z0-9-]{10,20}/' "$SRC/scripts/release-apply.sh" "$SRC/scripts/read-backups.sh" "$SRC/install.sh"
  echo "e2e rewrites: the project_ref pattern [a-z0-9]{20} -> [a-z0-9-]{10,20} in release-apply.sh, read-backups.sh and install.sh (the local pooler tenant is pooler-dev)"
else
  sed -i 's/co:5432/co:54329/g' "$SRC/scripts/release-apply.sh" "$SRC/scripts/heartbeat.sh" "$SRC/approve-package.sh"
  echo "e2e rewrites: the direct host port 5432 -> 54329 in release-apply.sh, heartbeat.sh and approve-package.sh (the test PostgreSQL listens there)"
fi
chown -R root:root "$SRC"; chmod -R go-w "$SRC"
(cd "$SRC" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done) > /root/hr-pins-e2e.txt; chown root:root /root/hr-pins-e2e.txt; chmod 644 /root/hr-pins-e2e.txt
bash "$SRC/install.sh" sam "$REF" "$T/cli/supabase-go" /root/hr-pins-e2e.txt > "$T/install.out" 2>&1 && ok "install.sh with the REAL supabase-go (every file matched its pin, including the CA)" || { bad "install" "$(tail -4 "$T/install.out")"; exit 1; }

# ---- T5: certificate verification THROUGH THE REAL CLI (the vendor CLI drops sslmode/sslrootcert from the URL; PGSSLMODE/PGSSLROOTCERT in its environment are honoured)
mkdir -p "$T/probe/supabase/migrations" "$T/probe/supabase/.temp"; echo v2.102.0 > "$T/probe/supabase/.temp/cli-latest"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/wrong.key" -out "$T/wrong.pem" -days 1 -subj "/CN=not-the-server-ca" >/dev/null 2>&1
probe() { # probe CAFILE|none HOSTPORT USER -> output in $T/probe.out
  local ca=$1 hp=$2 u=$3 e=(PGPASSWORD=postgres PGSSLMODE=verify-full)
  [ "$ca" = none ] || e+=(PGSSLROOTCERT="$ca")
  ( cd "$T/probe" && env HOME="$T/probe" "${e[@]}" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$T/cli/supabase-go" db query --db-url "postgresql://$u@$hp/postgres" "select 1 as probe_ok" -o json > "$T/probe.out" 2>&1 ); }
CERTERR='x509|certificate|unknown authority|tls: failed to verify'
probe "$TESTCA" "$DBHOST" "$TLSUSER"; grep -q probe_ok "$T/probe.out" && ok "T5 (real CLI): PGSSLMODE=verify-full + the right CA + the exact host name -> the connection is accepted and the query runs" || bad "T5: right CA refused" "$(tail -3 "$T/probe.out")"
probe "$T/wrong.pem" "$DBHOST" "$TLSUSER"; if ! grep -q probe_ok "$T/probe.out" && grep -qiE "$CERTERR" "$T/probe.out"; then ok "T5 (real CLI): verify-full + a WRONG CA -> REFUSED with a certificate error (the old probe, which used sslmode in the URL, connected)"; else bad "T5: wrong CA accepted or no certificate error" "$(tail -3 "$T/probe.out")"; fi
if [ "$MODE" = pg ]; then
  probe "$TESTCA" "127.0.0.1:54329" "$TLSUSER"; if ! grep -q probe_ok "$T/probe.out" && grep -qiE "$CERTERR" "$T/probe.out"; then ok "T5 (real CLI): verify-full + the right CA but a host the certificate does not name (127.0.0.1) -> REFUSED (this separates verify-full from verify-ca)"; else bad "T5: hostname mismatch accepted" "$(tail -3 "$T/probe.out")"; fi
  probe none "$DBHOST" "$TLSUSER"; if ! grep -q probe_ok "$T/probe.out" && grep -qiE "$CERTERR" "$T/probe.out"; then ok "T5 (real CLI): verify-full with no CA file falls back to the system roots -> REFUSED for a private CA"; else bad "T5: no-CA probe" "$(tail -3 "$T/probe.out")"; fi
fi
ST=/var/lib/hone-release/state
install -m 644 -o sam -g sam "$BUNDLE" /srv/hone-release-inbox/bundle.tar
install -m 644 -o sam -g sam "$LIST" /srv/hone-release-inbox/list.sha256
RECEIPT=$(printf 'a%.0s' $(seq 1 64))
approve() { bash "$SRC/approve-package.sh" id="$1" bundle_sha="$(sha256sum /srv/hone-release-inbox/bundle.tar | cut -d' ' -f1)" list_sha="$(sha256sum /srv/hone-release-inbox/list.sha256 | cut -d' ' -f1)" head="$HEAD40" pr=1193 receipt_sha="$RECEIPT" first=0213 last=0246 count=34 minutes=30 \
  window_start="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)" window_end="$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)" recovery_basis=waiver waiver_id=WAIVER-20261027-1 recovery_stamp=none s0a_writes=none history_before=211 drain_holds=yes drain_queues=yes drain_people=yes drain_max_busy="${DMB:-0}" drain_attestation="synthetic target nothing to drain" serving_commit="$(printf 'c%.0s' $(seq 1 40))" serving_attestation="synthetic target no serving source" serving_check=attested-only heartbeat_auth="${HBAUTH:-none}" verify_sha=none s0a_sha="$(printf 'd%.0s' $(seq 1 64))" s0a_at="$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)" min_span_days=6 quiet_db="${QDB:-idle}" \
  connection_mode="$CM" pooler_host="$PH" statement_timeout_s="${STS:-120}" lock_timeout_s=5 idle_tx_timeout_s=60 max_push_seconds="${MPS:-300}" attestation="synthetic target; recovery not applicable" > "$T/approve.out" 2>&1; local rc=$?; [ $rc = 0 ] && fake_bind; return $rc; }
# The Management API is not reachable from CI, so the preflight action (read token) is exercised in the custody job with a STUB CLI. Here the binding root would write after
# reading a GO package is WRITTEN BY THE HARNESS (a synthetic GO package about the current approval, sha-bound) so the REAL CLI can be driven through the real apply path.
fake_bind() { python3 -I - "$ST" /etc/hone-release/APPROVED-PACKAGE <<'PYF'
import json, sys, hashlib, time, os
st, ap = sys.argv[1], sys.argv[2]
aid = [l.split("=", 1)[1].strip() for l in open(ap) if l.startswith("approval_id=")][0]
body = {"kind": "hone-release-gonogo", "approval_id": aid, "approval_sha256": hashlib.sha256(open(ap, "rb").read()).hexdigest(), "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "verdict": "GO", "reason": "synthetic package written by the e2e harness", "checks": []}
body["sha256"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
open(os.path.join(st, "GONOGO.json"), "w").write(json.dumps(body, sort_keys=True, indent=1) + "\n"); os.chown(os.path.join(st, "GONOGO.json"), 0, 0)
open("/etc/hone-release/GONOGO-BOUND", "w").write("gonogo_sha=%s\napproval_id=%s\nbound_at=%s\n" % (body["sha256"], aid, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
PYF
}
setpw() { printf '%s\n' "$1" | bash "$SRC/set-secret.sh" db-password --stdin >/dev/null; }
SAMOUT="$T/sam.txt"; : > "$SAMOUT"; chmod 666 "$SAMOUT"
runo() { OUT=$(runuser -u sam -- env -i PATH=/usr/bin:/bin HOME=/home/sam sudo -n -u hone-release $LB "$@" 2>&1); RC=$?; printf '%s\n' "$OUT" >> "$SAMOUT"; }
state() { cat /var/lib/hone-release/state/APPLY-STATE 2>/dev/null || echo none; }

# ---- 1. a wrong password: ONE connection, FAILED-LOGIN, nothing applied, then blocked
c0=$(conns); approve E2E-WRONG || bad "approve" "$(cat $T/approve.out)"; setpw "WRONG-CANARY-5d41"
runo apply
c=$(( $(conns) - c0 ))
[ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-LOGIN ] && [ "$c" = 1 ] && [ "$(hist)" = 211 ] && ok "wrong password through the real CLI ($MODE, verify-full): ONE connection, exit non-zero, state FAILED-LOGIN, history still 211" || bad "wrong password" "rc=$RC conn=$c state=$(state) hist=$(hist) $OUT"
printf '%s' "$OUT" | grep -q "WRONG-CANARY" && bad "the wrong password was printed" || ok "the wrong password is not in the output the agent received"
approve E2E-WRONG2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q FAILED-LOGIN && ok "while FAILED-LOGIN stands the next run is refused" || bad "not blocked" "$OUT"
rm -f $ST/APPLY-STATE

# ---- 2. T5 through the whole launcher path: an IMPOSTOR certificate (same name, a different CA) is refused BEFORE any login
if [ "$MODE" = pg ]; then
  setpw "$GOODPW"; cp "$PGD/server.crt" "$T/server.crt.keep"; cp "$PGD/server.key" "$T/server.key.keep"
  cp "$T/impostor.crt" "$PGD/server.crt"; cp "$T/impostor.key" "$PGD/server.key"; chown postgres:postgres "$PGD/server.crt" "$PGD/server.key"; chmod 600 "$PGD/server.key"
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGD" reload >/dev/null; sleep 2
  a0=$(grep -c 'connection authorized' "$T/pgl/pg.log"); approve E2E-IMPOSTOR; runo apply; a1=$(grep -c 'connection authorized' "$T/pgl/pg.log")
  if [ $RC -ne 0 ] && [ "$a1" = "$a0" ] && [ "$(hist)" = 211 ] && printf '%s' "$OUT" | grep -qiE "$CERTERR"; then ok "T5 (launcher + real CLI): a server presenting a certificate from a DIFFERENT CA for the right host name is refused with a certificate error; the server saw NO authentication (the password was never sent)"; else bad "T5 impostor" "rc=$RC authorized $a0->$a1 $OUT"; fi
  cp "$T/server.crt.keep" "$PGD/server.crt"; cp "$T/server.key.keep" "$PGD/server.key"; chown postgres:postgres "$PGD/server.crt" "$PGD/server.key"; chmod 600 "$PGD/server.key"
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGD" reload >/dev/null; sleep 2; rm -f $ST/APPLY-STATE
fi

# ---- 3. the real push through the launcher
setpw "$GOODPW"; approve E2E-GOOD; c0=$(conns)
( while :; do ps -axww -o args= 2>/dev/null | grep -E 'supabase-go'; sleep 0.05; done > "$T/ps.txt" ) & SP=$!
runo apply
kill $SP 2>/dev/null; wait $SP 2>/dev/null
c=$(( $(conns) - c0 ))
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && [ "$(hist)" = 245 ] && [ "$(histmax)" = 0246 ]; then ok "34 migrations applied through the launcher with the real CLI ($MODE, verify-full against the test CA): history 245, max 0246"; else bad "real apply" "rc=$RC hist=$(hist) $OUT"; fi
[ "$c" = 3 ] && ok "exactly 3 connection attempts (the connection-phase read-back, one dry run, one push)" || bad "connection attempts: $c"
[ "$(state | cut -d' ' -f1)" = APPLIED-UNVERIFIED ] && [ -d $ST/consumed/E2E-GOOD ] && ok "state APPLIED-UNVERIFIED (the verify action is the only way to APPLIED) and the approval consumed" || bad "state" "$(state)"
grep -q 'db push' "$T/ps.txt" && ok "the process sampler saw the CLI (the argv check is not vacuous)" || bad "sampler never saw the CLI"
! grep -Eq 'PGPASSWORD|:postgres@|assword=' "$T/ps.txt" && ok "no password in the CLI's argv" || bad "password in argv"
! grep -Eq 'sslmode' "$T/ps.txt" && ok "the CLI's argv names no sslmode (verify-full travels in its environment)" || bad "sslmode in argv"
[ "$(grep -a -c '^Applying migration' /var/lib/hone-release/logs/E2E-GOOD/push.log)" = 34 ] && ok "push log (kept under the release logs): 34 Applying migration lines" || bad "push log lines"
if [ "$MODE" = pg ]; then grep -q 'options=-c%20statement_timeout%3D120000' "$T/ps.txt" && ok "T4 (B1): the real CLI's argv carries the startup options (statement 120 s, lock 5 s, idle-in-transaction 60 s, client-connection check 5 s)" || bad "options not in argv"; fi
approve E2E-AGAIN; runo apply; [ $RC -ne 0 ] && [ "$(hist)" = 245 ] && ok "a further apply with a new approval does not push again (refused while APPLIED-UNVERIFIED, history unchanged)" || bad "second apply" "rc=$RC $OUT"

# ---- 4. T4 server-enforced timeout through the REAL CLI (which runs RESET ALL before every file) and the client wall clock
timing_bundle() { # timing_bundle FIXTUREARGS
  rm -rf "$T/tv"; python3 -I "$S1/fixture.py" syn "$T/tv" --head $HEAD40 $1 >/dev/null
  install -m 644 -o sam -g sam "$T/tv/migrations-d189768b.tar" /srv/hone-release-inbox/bundle.tar; install -m 644 -o sam -g sam "$T/tv/MIGRATIONS-d189768b.sha256" /srv/hone-release-inbox/list.sha256; }
if [ "$MODE" = pg ]; then
  reset_db; timing_bundle "--tfile 0230 --tkind slow-b1"; STS=3 approve E2E-B1; t0=$(date +%s); runo apply; el=$(( $(date +%s) - t0 ))
  if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "57014" && [ "$el" -lt 25 ] && [ "$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version = '0230'")" = 0 ] && [ "$(histmax)" = 0229 ]; then ok "T4 B1 (real CLI, direct, startup options, a 30 s statement with NO timeout text in the file): the SERVER cancelled it at the 3 s statement_timeout (SQLSTATE 57014) after ${el}s in total; files 0213..0229 stayed applied, 0230 did not (so RESET ALL kept the startup values)"; else bad "T4 B1" "rc=$RC elapsed=${el}s histmax=$(histmax) $OUT"; fi
  grep -qiE "canceling statement due to statement timeout" /var/lib/hone-release/logs/E2E-B1/push.log 2>/dev/null || printf '%s' "$OUT" | grep -qiE "statement timeout|57014" && ok "T4 B1: the server's own message 'canceling statement due to statement timeout' is in the push output" || bad "no server timeout message"
  [ "$(state | cut -d' ' -f1)" = FAILED ] && ok "T4 B1: the state is FAILED (blocks the next run; the output tells the operator to read back and follow the cancel runbook; never a pass, never a retry)" || bad "state after cancel" "$(state)"
  # the client wall clock: the server-side timeout is set high on purpose so ONLY the client clock can end it
  reset_db; timing_bundle "--tfile 0230 --tkind slow-b1"; STS=600 MPS=10 approve E2E-KILL; t0=$(date +%s); runo apply; el=$(( $(date +%s) - t0 ))
  if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "KILLED" && [ "$(state | cut -d' ' -f1)" = UNKNOWN-KILLED ] && [ "$el" -lt 30 ]; then ok "T4 client wall clock (real CLI): past 10 s the CLI is KILLED and the state is UNKNOWN-KILLED (${el}s); not a pass, not retried"; else bad "T4 kill" "rc=$RC elapsed=${el}s state=$(state) $OUT"; fi
  sleep 12   # the 30 s statement would still be running at this point (it began about 10 s before the kill) unless the server aborted it
  n=$(psqld -c "select count(*) from pg_stat_activity where query like '%pg_sleep(30)%' and pid <> pg_backend_pid()")
  [ "$n" = 0 ] && ok "T4 (client_connection_check_interval): after the kill the server ABORTED the 30 s statement instead of letting it run on (no active pg_sleep backend left)" || bad "the killed client's statement still runs on the server" "backends=$n"
  [ "$(histmax)" = 0229 ] && ok "after the kill the history stops at 0229: the open file's transaction was rolled back (the reconcile read would classify the range PARTIAL)" || bad "history after kill" "$(histmax)"
  # E4(b): the heartbeat WAL message against the real server through the real CLI, verify-full
  rm -f $ST/APPLY-STATE; install -m 644 -o sam -g sam "$BUNDLE" /srv/hone-release-inbox/bundle.tar; install -m 644 -o sam -g sam "$LIST" /srv/hone-release-inbox/list.sha256
  HBAUTH="I authorize ONE heartbeat write to the production database: a single pg_logical_emit_message WAL message (no table, no row, no schema change) over the verify-full direct connection as the postgres role, once for approval E2E-HB." QDB=heartbeat approve E2E-HB; runo heartbeat
  [ $RC = 0 ] && grep -q '^HEARTBEAT at=' $ST/HEARTBEAT && ok "E4(b) (real CLI, local server): the heartbeat emitted a logical WAL message over verify-full and recorded HEARTBEAT" || bad "heartbeat" "rc=$RC $OUT"
else
  # the pooler gate against the REAL 34 files: they carry no bounded set local statement_timeout, so the B2 gate refuses them (this is the finding for the 0247+ stage too)
  install -m 644 -o sam -g sam "$REALBUNDLE" /srv/hone-release-inbox/bundle.tar; install -m 644 -o sam -g sam "$REALLIST" /srv/hone-release-inbox/list.sha256
  rm -f $ST/APPLY-STATE; setpw "$GOODPW"; HEADREAL=$HEAD40; approve E2E-REAL34; runo apply
  [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "fails the timeout gate" && ok "T4 B2: the REAL 34 files (0213..0246, frozen) through the POOLER are REFUSED by the lexical gate before any connection (none carries a bounded set local statement_timeout)" || bad "real 34 not refused by the pooler gate" "rc=$RC $OUT"
  reset_db; timing_bundle "--all-setlocal --tfile 0230 --tkind slow-b2"; approve E2E-B2; t0=$(date +%s); runo apply; el=$(( $(date +%s) - t0 ))
  if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "57014" && [ "$el" -lt 40 ] && [ "$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version = '0230'")" = 0 ]; then ok "T4 B2 (real CLI, Supavisor session pooler, extended-protocol batch): the per-file 'set local statement_timeout = 2s' made the SERVER cancel a 30 s statement (SQLSTATE 57014) after ${el}s; file 0230 not applied"; else bad "T4 B2" "rc=$RC elapsed=${el}s $OUT"; fi
fi
echo "RESULT ($MODE): $pass passed, $fail failed"
case "$MODE" in supavisor) EXPECT=17 ;; pg) EXPECT=26 ;; *) EXPECT=$((pass + fail)) ;; esac
[ $((pass + fail)) = $EXPECT ] || { echo "FAIL - $((pass + fail)) of $EXPECT $MODE cases ran (a skipped or vacuous case; change EXPECT only with a reviewed case change)"; exit 1; }
[ "$fail" = 0 ]
