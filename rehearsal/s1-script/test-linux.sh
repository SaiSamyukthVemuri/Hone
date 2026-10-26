#!/bin/bash
# REHEARSAL - NEVER MERGE. s1-apply.sh against the REAL bundle (245 files, 34 pending) through the LOCAL SUPAVISOR session pooler
# (behind the TLS relay of rehearsal #1170, which also counts connection attempts), on a SYNTHETIC database built through
# production's prefix 0212 (NOT a verified copy of production), with the real linux_amd64 supabase-go (inner sha 174a90e2).
# The macOS/darwin binary and bash 3.2 are covered by test-macos.sh. No hosted call; canary credentials only.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/s1t.XXXXXX")"; T="$(cd "$T" && pwd -P)"
MODE=real
DB="${DB:?the supabase db container name}"
PW_OK=postgres          # the stack's own local password: a canary, never a real credential
NOPLAT="--no-platform"
PW_PATTERN="PGPASSWORD=|:postgres@|assword=postgres|WRONG-CANARY-5d41|LEFTOVER-CANARY-9a7c"
VER=2.102.0
echo "platform: $(uname -sm); bash: $BASH_VERSION"

A="$T/dl"; mkdir -p "$A" "$T/cli"
( cd "$A" && env -u SSL_CERT_FILE curl -fsSL -O "https://github.com/supabase/cli/releases/download/v$VER/supabase_${VER}_linux_amd64.tar.gz" ) || { echo "download failed"; exit 1; }
[ "$(sha256sum "$A/supabase_${VER}_linux_amd64.tar.gz" | cut -d' ' -f1)" = 9c0421ba8089ff2ade90654a05441ac04de4a430f852591323319542ec101872 ] || { echo "archive sha mismatch"; exit 1; }
tar -xzf "$A/supabase_${VER}_linux_amd64.tar.gz" -C "$T/cli" supabase-go || exit 1
GOBIN="$T/cli/supabase-go"; chmod 755 "$GOBIN"
[ "$(sha256sum "$GOBIN" | cut -d' ' -f1)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] || { echo "supabase-go sha mismatch"; exit 1; }

psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
for _ in $(seq 1 30); do psqld -c 'select 1' > /dev/null 2>&1 && break; sleep 2; done
[ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations')" = 0212 ] || { echo "history max is not 0212"; exit 1; }
[ "$(psqld -c 'select count(*) from supabase_migrations.schema_migrations')" = 211 ] || { echo "history is not 211 rows"; exit 1; }

POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"
[ -n "$POOLER" ] || { docker ps -a --format '{{.Names}} {{.Status}}'; echo "no pooler container"; exit 1; }
echo "supavisor image: $(docker inspect -f '{{.Config.Image}}' "$POOLER")"
TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"; TENANT="${TENANT:-pooler-dev}"
REFTEST="$TENANT"
# TLS: the pinned CLI always attempts TLS; the local Supavisor refuses it, so a relay terminates it (as the hosted pooler does)
openssl req -new -x509 -days 1 -nodes -text -out "$T/relay.crt" -keyout "$T/relay.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" > /dev/null 2>&1
export COUNT_FILE="$T/accepts.txt"; : > "$COUNT_FILE"
nohup python3 -I "$HERE/tlsfront-count.py" "$T/relay.crt" "$T/relay.key" 54330 54329 > "$T/relay.log" 2>&1 &
sleep 2
RUNNER_IP="$(hostname -I | awk '{print $1}')"
URLTEST="postgresql://postgres.$TENANT@$RUNNER_IP:54330/postgres?sslmode=require"
# the pooler must answer the real password through the relay before any case
for _ in $(seq 1 30); do PGPASSWORD="$PW_OK" PGSSLMODE=require psql "postgresql://postgres.$TENANT@$RUNNER_IP:54330/postgres" -X -At -c 'select 1' 2>/dev/null | grep -qx 1 && break; sleep 2; done
PGPASSWORD="$PW_OK" PGSSLMODE=require psql "postgresql://postgres.$TENANT@$RUNNER_IP:54330/postgres" -X -At -c 'select 1' | grep -qx 1 || { echo "the pooler does not answer through the relay"; docker logs --tail 30 "$POOLER"; exit 1; }
: > "$COUNT_FILE"

# the real package
BASEPKG="$T/real"; mkdir -p "$BASEPKG"
cp "$HERE/migrations-d189768b.tar" "$HERE/MIGRATIONS-d189768b.sha256" "$BASEPKG/"
printf 'BUNDLE_SHA=%s\nLIST_SHA=%s\n' "$(sha256sum "$BASEPKG/migrations-d189768b.tar" | cut -d' ' -f1)" "$(sha256sum "$BASEPKG/MIGRATIONS-d189768b.sha256" | cut -d' ' -f1)" > "$BASEPKG/pins.env"
awk '{v=substr($2,1,4); if (v+0>=213 && v+0<=246) print}' "$BASEPKG/MIGRATIONS-d189768b.sha256" > "$BASEPKG/go34.txt"
GO34FILE="$BASEPKG/go34.txt"

db_reset_state() { psqld -c "delete from supabase_migrations.schema_migrations where version >= '0213'" > /dev/null; }
db_hist_count() { psqld -c "select count(*) from supabase_migrations.schema_migrations"; }
db_hist_max() { psqld -c "select max(version) from supabase_migrations.schema_migrations"; }
db_hist_add() { psqld -c "insert into supabase_migrations.schema_migrations (version,name) values ('$1','x')" > /dev/null; }
db_hist_del() { psqld -c "delete from supabase_migrations.schema_migrations where version='$1'" > /dev/null; }
db_table_exists() { return 0; }
conn_count() { wc -l < "$COUNT_FILE" | tr -d ' '; }

. "$HERE/cases.sh"
