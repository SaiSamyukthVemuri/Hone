#!/bin/bash
# REHEARSAL - NEVER MERGE. Starts a throwaway PostgreSQL 17 on 127.0.0.1:55432 with TLS (macOS arm64 runner), the shim from
# shim.sql, and one login role "postgres.<ref>" whose password is $2. usage: pg-setup.sh <pgdata-dir> <password>
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$1"; PW="$2"
P="$(brew --prefix postgresql@17 2>/dev/null || true)"
if [ ! -x "$P/bin/initdb" ]; then brew install postgresql@17 >/dev/null 2>&1 || brew install postgresql@17; P="$(brew --prefix postgresql@17)"; fi
B="$P/bin"
mkdir -p "$D"; chmod 700 "$D"
printf '%s\n' "$PW" > "$D.pw"
"$B/initdb" -D "$D/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 --pwfile="$D.pw" -E UTF8 >/dev/null
rm -f "$D.pw"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/data/server.key" -out "$D/data/server.crt" -subj /CN=localhost -days 2 >/dev/null 2>&1
chmod 600 "$D/data/server.key"
cat >> "$D/data/postgresql.conf" <<CONF
port = 55432
listen_addresses = '127.0.0.1'
unix_socket_directories = '$D'
ssl = on
fsync = off
synchronous_commit = off
full_page_writes = off
CONF
printf 'hostssl all all 127.0.0.1/32 scram-sha-256\n' > "$D/data/pg_hba.conf.new"
grep -v '^host ' "$D/data/pg_hba.conf" | grep -v '^#' | grep . >> "$D/data/pg_hba.conf.new" || true
mv "$D/data/pg_hba.conf.new" "$D/data/pg_hba.conf"
"$B/pg_ctl" -D "$D/data" -l "$D/pg.log" -w start >/dev/null
"$B/psql" -X -h "$D" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -v pw="$PW" -f "$HERE/shim.sql" >/dev/null
echo "$B"
