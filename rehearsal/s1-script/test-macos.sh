#!/bin/bash
# REHEARSAL - NEVER MERGE. s1-apply.sh on macOS arm64 (/bin/bash 3.2), with the REAL vendor supabase-go (darwin_arm64, inner sha
# dce26b75) against a REAL local PostgreSQL (TLS on, scram, a role named like the pooler's) holding a SYNTHETIC history of 211
# versions (0001..0212 names) and a SYNTHETIC bundle (the real 245 file NAMES, trivial SQL). Not Supavisor (no Docker on this runner):
# the pooler paths are covered by test-linux.sh. No hosted call; canary credentials only.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/s1t.XXXXXX")"; T="$(cd "$T" && pwd -P)"
MODE=syn
PGBIN="$(brew --prefix postgresql@16)/bin"
PW_OK="PW-CANARY-c3e1f0"
REFTEST=testref
PORT=54329
NOPLAT=""
echo "platform: $(uname -sm); bash: $(/bin/bash -c 'echo $BASH_VERSION'); postgres: $("$PGBIN/postgres" --version)"

# ---- the verified CLI (S1 step A, by hand): archive sha, inner sha ------------------------------------------------------------
A="$T/dl"; mkdir -p "$A" "$T/cli"
( cd "$A" && curl -fsSL -O https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz ) || { echo "download failed"; exit 1; }
[ "$(shasum -a 256 "$A/supabase_2.102.0_darwin_arm64.tar.gz" | cut -d' ' -f1)" = 567f0ce9f050ceb46ad4389ab13035e31b5b7205fcb093530f528bb208d2ce28 ] || { echo "archive sha mismatch"; exit 1; }
tar -xzf "$A/supabase_2.102.0_darwin_arm64.tar.gz" -C "$T/cli" supabase-go || { echo "extract failed"; exit 1; }
GOBIN="$T/cli/supabase-go"; chmod 755 "$GOBIN"
[ "$(shasum -a 256 "$GOBIN" | cut -d' ' -f1)" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] || { echo "supabase-go sha mismatch"; exit 1; }
echo "supabase-go: dce26b75... verified; $(file -b "$GOBIN" | cut -c1-40)"

# ---- Postgres with TLS --------------------------------------------------------------------------------------------------------
PGD="$T/pgdata"; SOCK="$T/sock"; mkdir -p "$SOCK"
"$PGBIN/initdb" -D "$PGD" -U admin --auth-local=trust --auth-host=scram-sha-256 -E UTF8 > "$T/initdb.log" 2>&1 || { cat "$T/initdb.log"; exit 1; }
openssl req -new -x509 -days 1 -nodes -out "$PGD/server.crt" -keyout "$PGD/server.key" -subj "/CN=localhost" > /dev/null 2>&1; chmod 600 "$PGD/server.key"
cat >> "$PGD/postgresql.conf" <<CONF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$SOCK'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
log_connections = on
password_encryption = scram-sha-256
CONF
printf 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 reject\n' > "$PGD/pg_hba.conf"
"$PGBIN/pg_ctl" -D "$PGD" -l "$T/pg.log" -w start > /dev/null || { cat "$T/pg.log"; exit 1; }
trap '"$PGBIN/pg_ctl" -D "$PGD" -m immediate stop > /dev/null 2>&1' EXIT
dbq() { "$PGBIN/psql" -X -q -A -t -v ON_ERROR_STOP=1 -h "$SOCK" -p $PORT -U admin -d postgres "$@"; }
dbq -c "create role \"postgres.$REFTEST\" login superuser password '$PW_OK'" || exit 1
URLTEST="postgresql://postgres.$REFTEST@127.0.0.1:$PORT/postgres?sslmode=require"

python3 -I "$HERE/fixture.py" syn "$T/syn"
BASEPKG="$T/syn"; GO34FILE="$T/syn/go34.txt"
NAMES="$T/names.txt"; awk '{print $2}' "$HERE/MIGRATIONS-d189768b.sha256" > "$NAMES"

db_reset_state() {
  dbq -c "drop schema if exists supabase_migrations cascade; drop schema public cascade; create schema public; create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);" > /dev/null
  awk '{v=substr($1,1,4); if (v+0<=212) printf "insert into supabase_migrations.schema_migrations (version,name) values (\x27%s\x27,\x27%s\x27);\n", v, substr($1,6,length($1)-9)}' "$NAMES" | dbq > /dev/null
}
db_hist_count() { dbq -c "select count(*) from supabase_migrations.schema_migrations"; }
db_hist_max() { dbq -c "select max(version) from supabase_migrations.schema_migrations"; }
db_hist_add() { dbq -c "insert into supabase_migrations.schema_migrations (version,name) values ('$1','x')" > /dev/null; }
db_hist_del() { dbq -c "delete from supabase_migrations.schema_migrations where version='$1'" > /dev/null; }
db_table_exists() { [ "$(dbq -c "select count(*) from information_schema.tables where table_schema='public' and table_name='$1'")" = 1 ]; }
db_cancel_sleep() { [ "$(dbq -c "select count(*) from (select pg_cancel_backend(pid) from pg_stat_activity where state='active' and query like '%pg_sleep(30)%' and pid<>pg_backend_pid()) x")" -ge 1 ] 2>/dev/null; }
conn_count() { grep -c 'connection received' "$T/pg.log"; }

. "$HERE/cases.sh"
