# REHEARSAL - NEVER MERGE. HON66 shared setup (from the D3 pooler rehearsal, trimmed): verified linux_amd64 supabase-go, the local
# Supavisor SESSION pooler (enabled in CI only) behind a TLS relay (NOT Supavisor), a SYNTHETIC database reset to production's prefix 0212.
# Canary credentials only. No hosted project, no provider, no customer data. Sourced by facts.sh / verify.sh.
DB="${DB:?the supabase db container name}"
OUT="${REHEARSAL_OUT:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$PWD"
PORT=54322; PPORT=54329; TLSP=54330; PW=postgres
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"; : >> "$RES"
say() { echo "$*" | tee -a "$RES"; }
expect() { if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi; }
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sadm() { docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
hist_list() { psqld -c "select coalesce(string_agg(version, ',' order by version), 'none') from supabase_migrations.schema_migrations where version >= '0213'"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }

command -v psql > /dev/null || { sudo apt-get update -qq > /dev/null 2>&1; sudo apt-get install -y -qq postgresql-client > /dev/null 2>&1; }
sudo apt-get install -y -qq zsh > /dev/null 2>&1
RUNNER_IP="$(hostname -I | awk '{print $1}')"
VER=2.102.0
REL="https://github.com/supabase/cli/releases/download/v$VER"
dl() { env -u SSL_CERT_FILE curl "$@"; }
WORK="$OUT/archive"; mkdir -p "$WORK"
( cd "$WORK" && dl -fsSL -O "$REL/checksums.txt" -O "$REL/supabase_${VER}_linux_amd64.tar.gz" ) || { say "FAIL download"; exit 1; }
( cd "$WORK" && grep ' supabase_2.102.0_linux_amd64.tar.gz$' checksums.txt | sha256sum -c - ) > "$OUT/verify.txt" 2>&1
expect "the linux_amd64 archive verifies against checksums.txt" "$?" "$(tr '\n' ' ' < "$OUT/verify.txt")"
mkdir -p "$REPO/supabase-cli" && tar -xzf "$WORK/supabase_${VER}_linux_amd64.tar.gz" -C "$REPO/supabase-cli"
GOBIN="$REPO/supabase-cli/supabase-go"; chmod +x "$GOBIN"
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
expect "supabase-go (linux_amd64) has the recorded inner sha256 $GOSHA" "$([ "$(sha256sum "$GOBIN" | cut -d" " -f1)" = "$GOSHA" ] && echo 0 || echo 1)" "$($GOBIN --version 2>&1 | tail -1)"
CLI="npx --yes supabase@2.102.0"   # only for the db reset of the synthetic stack

POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"
[ -n "$POOLER" ] || { say "FAIL no pooler container"; exit 1; }
TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"
PUSER="postgres.${TENANT:-pooler-dev}"
say "INFO  pooler image $(docker inspect -f '{{.Config.Image}}' "$POOLER"); tenant user $PUSER; the HOSTED Supavisor version is UNKNOWN: this is synthetic evidence about the LOCAL image."
TLSDIR="$OUT/tls"; mkdir -p "$TLSDIR"
openssl req -new -x509 -days 1 -nodes -text -out "$TLSDIR/server.crt" -keyout "$TLSDIR/server.key" -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" > /dev/null 2>&1
purl() { echo "postgresql://$PUSER@$RUNNER_IP:$PPORT/postgres?sslmode=$1"; }
pq() { local pw="$1" url="$2"; shift 2; PGPASSWORD="$pw" PGCONNECT_TIMEOUT=15 psql "$url" -X -v ON_ERROR_STOP=0 "$@" 2>&1; }
SSLM=""
for m in disable prefer require; do
  r="$(pq "$PW" "$(purl $m)" -At -c 'select 1' | tr '\n' ' ' | cut -c1-80)"
  [ -z "$SSLM" ] && echo "$r" | grep -q '^1 *$' && SSLM=$m
done
[ -n "$SSLM" ] || { say "FAIL the pooler accepts no connection"; exit 1; }
start_relay() { python3 "$HERE/pooler-tlsfront.py" "$TLSDIR/server.crt" "$TLSDIR/server.key" "$TLSP" "$PPORT" > "$OUT/tlsfront.log" 2>&1 & RELAY=$!; sleep 1; }
start_relay
TLSURL_BASE="postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require"
S1ENV=(SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false)
CANARY=Hon66canarypw8K3x
trap 'sadm -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1; sadm -c "alter role postgres reset statement_timeout" > /dev/null 2>&1' EXIT
reset_to_0212() {
  local try
  for try in 1 2 3; do
    $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 && break
    sleep 15
    [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations' 2> /dev/null)" = "0212" ] && break
  done
  for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
}
say "-- resetting the synthetic database to production's prefix 0212"
reset_to_0212
sadm -c "alter role postgres password '$CANARY'" > /dev/null
PWU="$CANARY"
for _ in $(seq 1 45); do pq "$PWU" "$(purl "$SSLM")" -At -c 'select 1' | grep -qx 1 && break; sleep 2; done
echo "v$VER" > "$OUT/cli-latest"

mkwd() { # mkwd <dir> : migrations 0001-0212 (identical copies), config, cli-latest
  rm -rf "$1"; mkdir -p "$1/supabase/migrations" "$1/supabase/.temp"
  cp "$REPO/supabase/config.toml" "$1/supabase/config.toml"
  for f in "$REPO"/supabase/migrations/*.sql; do b="$(basename "$f")"; [ "${b%%_*}" -le 212 ] 2> /dev/null && cp "$f" "$1/supabase/migrations/$b"; done
  cp "$OUT/cli-latest" "$1/supabase/.temp/cli-latest"
}
# 34 small, fast, realistic DDL migrations 0213..0246 (each its own transaction-shaped file), like the real S1 bundle's speed
write_fast34() { # write_fast34 <dir>
  local i n
  for i in $(seq 213 246); do
    n=$(printf '%04d' "$i")
    cat > "$1/supabase/migrations/${n}_hon66_fast.sql" <<SQL
create table public.hon66_t$n (id bigint generated always as identity primary key, v text not null default '', created_at timestamptz not null default now());
create index hon66_t${n}_v_idx on public.hon66_t$n (v);
create function public.hon66_f$n() returns int language sql as \$\$ select $i \$\$;
alter table public.hon66_t$n enable row level security;
insert into public.hon66_t$n (v) select 'x' || g from generate_series(1, 200) g;
SQL
  done
}
clean_hon66() {
  psqld -c "delete from supabase_migrations.schema_migrations where version >= '0213'" > /dev/null 2>&1
  psqld -c "do \$\$ declare r record; begin for r in select tablename from pg_tables where schemaname='public' and tablename like 'hon66_%' loop execute format('drop table public.%I cascade', r.tablename); end loop; for r in select proname, oid from pg_proc where pronamespace='public'::regnamespace and proname like 'hon66_%' loop execute format('drop function if exists public.%I()', r.proname); end loop; end \$\$" > /dev/null 2>&1
}
push_bg() { # push_bg <label> <workdir> <db-url> : the S1 push (supabase-go, password-free --db-url, PGPASSWORD only), in the background
  ( cd "$2" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" db push --db-url "$3" --yes > "$OUT/run-$1.log" 2>&1; echo $? > "$OUT/rc-$1.txt" ) &
  PUSHBG=$!
}
push_wait() { wait "$PUSHBG" 2> /dev/null; PUSHRC="$(cat "$OUT/rc-$1.txt" 2> /dev/null || echo 99)"; }
wait_for() { local i; for i in $(seq 1 "$1"); do grep -q -E "$2" "$3" 2> /dev/null && return 0; sleep 1; done; return 1; }
