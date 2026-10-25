#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. D3-POOLER-WATCHDOG: the session-pooler + watchdog option for S1, rehearsed with the vendor
# supabase-go (linux_amd64, checksum-verified) through the LOCAL Supavisor 2.9.5 SESSION pooler (TLS relay in front, as in
# #1170) against a SYNTHETIC database through production's prefix 0212. Nothing touches a hosted project; canary values only.
# Sections: F facts; A scope (decoys); B cancel/rollback/reconcile at a scaled and at the REAL 120 s threshold; C quiet;
# D ambiguity (bounded manual outcome); E killing the CLI mid-statement; G read-back commands; H unscoped negative control.
set -u

DB="${DB:?the supabase db container name}"
OUT="${REHEARSAL_OUT:?}"
PORT=54322
PPORT=54329
TLSP=54330
PW=postgres
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"
: > "$RES"
say() { echo "$*" | tee -a "$RES"; }
expect() { if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi; }
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sadm() { docker exec -i "$DB" psql -U supabase_admin -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
hist_list() { psqld -c "select coalesce(string_agg(version, ',' order by version), 'none') from supabase_migrations.schema_migrations where version >= '0213'"; }
hist_n() { psqld -c "select count(*) from supabase_migrations.schema_migrations where version >= '0213'"; }
hist_total() { psqld -c "select count(*) || '/' || count(distinct version) from supabase_migrations.schema_migrations"; }

# ---- setup (from #1170, trimmed) -----------------------------------------------------------
command -v psql > /dev/null || { sudo apt-get update -qq > /dev/null 2>&1; sudo apt-get install -y -qq postgresql-client > /dev/null 2>&1; }
sudo apt-get install -y -qq zsh > /dev/null 2>&1
say "# D3 pooler watchdog rehearsal; psql: $(psql --version); zsh: $(zsh --version 2>&1)"
RUNNER_IP="$(hostname -I | awk '{print $1}')"
VER=2.102.0
REL="https://github.com/supabase/cli/releases/download/v$VER"
dl() { env -u SSL_CERT_FILE curl "$@"; }
REPO="$PWD"
WORK="$OUT/archive"; mkdir -p "$WORK"
( cd "$WORK" && dl -fsSL -O "$REL/checksums.txt" -O "$REL/supabase_${VER}_linux_amd64.tar.gz" ) || { say "FAIL download"; exit 1; }
( cd "$WORK" && grep ' supabase_2.102.0_linux_amd64.tar.gz$' checksums.txt | sha256sum -c - ) > "$OUT/verify.txt" 2>&1
expect "the linux_amd64 archive verifies against checksums.txt" "$?" "$(tr '\n' ' ' < "$OUT/verify.txt")"
mkdir -p "$REPO/supabase-cli" && tar -xzf "$WORK/supabase_${VER}_linux_amd64.tar.gz" -C "$REPO/supabase-cli"
GOBIN="$REPO/supabase-cli/supabase-go"
chmod +x "$GOBIN"
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
expect "supabase-go has the recorded inner sha256" "$([ "$(sha256sum "$GOBIN" | cut -d" " -f1)" = "$GOSHA" ] && echo 0 || echo 1)" "$($GOBIN --version 2>&1 | tail -1)"
CLI="npx --yes supabase@2.102.0"   # only for the db reset of the synthetic stack

POOLER="$(docker ps --format '{{.Names}}' | grep '^supabase_pooler_' | head -1)"
[ -n "$POOLER" ] || { say "FAIL no pooler container"; exit 1; }
TENANT="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$POOLER" | sed -n 's/^POOLER_TENANT_ID=//p' | head -1)"
PUSER="postgres.${TENANT:-pooler-dev}"
say "INFO  pooler image $(docker inspect -f '{{.Config.Image}}' "$POOLER"); tenant user $PUSER; the HOSTED Supavisor version is UNKNOWN: everything here is synthetic evidence about the LOCAL image."

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
python3 scripts/ci/pooler-tlsfront.py "$TLSDIR/server.crt" "$TLSDIR/server.key" "$TLSP" "$PPORT" > "$OUT/tlsfront.log" 2>&1 &
sleep 1
TLSURL="postgresql://$PUSER@$RUNNER_IP:$TLSP/postgres?sslmode=require"
say "INFO  psql sslmode through the plain pooler: $SSLM; the CLI goes through the TLS relay (:$TLSP), which is NOT Supavisor."

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

reset_to_0212() {
  local try
  for try in 1 2 3; do
    $CLI db reset --local --version 0212 --yes > "$OUT/reset-0212.log" 2>&1 && break
    sleep 15
    [ "$(psqld -c 'select max(version) from supabase_migrations.schema_migrations' 2> /dev/null)" = "0212" ] && break
  done
  for _ in $(seq 1 30); do psqld -c "select 1" > /dev/null 2>&1 && break; sleep 2; done
  # the pinned CLI always attempts TLS on the DIRECT path too (S1 direct is not used here); nothing else to do
}
CANARY=D3canarypw8K3x
trap 'sadm -c "alter role postgres password '"'"'postgres'"'"'" > /dev/null 2>&1' EXIT
say "-- resetting the synthetic database to production's prefix 0212"
reset_to_0212
sadm -c "alter role postgres password '$CANARY'" > /dev/null
PWU="$CANARY"
for _ in $(seq 1 45); do pq "$PWU" "$(purl "$SSLM")" -At -c 'select 1' | grep -qx 1 && break; sleep 2; done
S1ENV=(SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false)
# the slow condition is EXTERNAL: the frozen file reads a knob table that is created here, outside any migration
psqld -c "create table public.d3_knob (k text primary key, value double precision not null); insert into public.d3_knob values ('sleep', 0); create table public.d3_decoy (id int)" > /dev/null
echo "v$VER" > "$OUT/cli-latest"

# ---- the synthetic migration files (scratch workdir only; never any worktree's supabase/migrations) ----
mkwd() { # mkwd <dir> : migrations 0001-0212 (identical copies)
  rm -rf "$1"; mkdir -p "$1/supabase/migrations" "$1/supabase/.temp"
  cp "$REPO/supabase/config.toml" "$1/supabase/config.toml"
  for f in "$REPO"/supabase/migrations/*.sql; do b="$(basename "$f")"; [ "${b%%_*}" -le 212 ] 2> /dev/null && cp "$f" "$1/supabase/migrations/$b"; done
  cp "$OUT/cli-latest" "$1/supabase/.temp/cli-latest"
}
write_probe() { # write_probe <dir> <upto: 1 = only 0213; 4 = all four>
  cat > "$1/supabase/migrations/0213_d3_ok.sql" <<'SQL'
begin;
create table public.d3_ok (id int primary key);
insert into public.d3_ok values (1);
commit;
SQL
  [ "$2" -ge 4 ] || return 0
  cat > "$1/supabase/migrations/0214_d3_slow.sql" <<'SQL'
begin;
create table public.d3_t1 (id int primary key, v text);
create index d3_t1_v_idx on public.d3_t1 (v);
create type public.d3_ty as enum ('a', 'b');
create function public.d3_fn() returns int language sql as $$ select 1 $$;
select pg_sleep((select value from public.d3_knob where k = 'sleep'));
create table public.d3_late (id int);
commit;
SQL
  cat > "$1/supabase/migrations/0215_d3_next.sql" <<'SQL'
begin;
create table public.d3_next (id int);
commit;
SQL
  cat > "$1/supabase/migrations/0216_d3_last.sql" <<'SQL'
begin;
create table public.d3_last (id int);
commit;
SQL
}
clean_probe() {
  psqld -c "delete from supabase_migrations.schema_migrations where version >= '0213'; drop table if exists public.d3_ok, public.d3_t1, public.d3_late, public.d3_next, public.d3_last cascade; drop type if exists public.d3_ty; drop function if exists public.d3_fn(); update public.d3_knob set value = 0" > /dev/null 2>&1
}
catalog() { psqld -c "
select 'ns|' || nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'
union all select 'class|' || n.nspname || '.' || c.relname || '|' || c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'supabase_migrations')
union all select 'proc|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all select 'type|' || n.nspname || '.' || t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
union all select 'constraint|' || conrelid::regclass::text || '|' || conname from pg_constraint where connamespace = 'public'::regnamespace
union all select 'trigger|' || tgrelid::regclass::text || '|' || tgname from pg_trigger where not tgisinternal
union all select 'policy|' || polrelid::regclass::text || '|' || polname from pg_policy
order by 1"; }

s1_start() { # s1_start <label> <workdir> : the S1 push (supabase-go, password-free --db-url on the pooler, PGPASSWORD only), in the background
  ( cd "$2" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" db push --db-url "$TLSURL&options=-c%20statement_timeout%3D120000" --yes > "$OUT/run-$1.log" 2>&1; echo $? > "$OUT/rc-$1.txt" ) &
  S1BG=$!
}
s1_wait() { wait "$S1BG" 2> /dev/null; S1RC="$(cat "$OUT/rc-$1.txt" 2> /dev/null || echo 99)"; }
dry_list() { # dry_list <workdir> -> the file names a dry run lists
  ( cd "$1" && env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" db push --db-url "$TLSURL&options=-c%20statement_timeout%3D120000" --dry-run 2>&1 | sed -n 's/^ *• *\(0[0-9]*\)_.*/\1/p' | tr '\n' ',' | sed 's/,$//' ); }

# the operator watchdog, with the placeholders filled for the pooler, runs under ZSH exactly as written
render_wd() { sed -e "s#<USER>#$PUSER#" -e "s#<HOSTPORT>#$RUNNER_IP:$TLSP#" -e "s#<SSLMODE>#require#" scripts/ci/d3-watchdog.zsh > "$OUT/d3-watchdog.rendered.zsh"; }
render_wd
zsh -n "$OUT/d3-watchdog.rendered.zsh"; expect "the operator watchdog parses under zsh (zsh -n)" "$?" "$(wc -l < scripts/ci/d3-watchdog.zsh) lines"
wd_start() { # wd_start <label> <limit> <every> [proxy-label]
  local label="$1"
  if [ -n "${4:-}" ]; then
    ( printf '%s\n' "$PWU" | WD_LIMIT="$2" WD_EVERY="$3" with_proxy "$4" env -u GITHUB_TOKEN -u GH_TOKEN zsh -f "$OUT/d3-watchdog.rendered.zsh" > "$OUT/wd-$label.log" 2>&1; echo $? > "$OUT/wdrc-$label.txt" ) &
  else
    ( printf '%s\n' "$PWU" | WD_LIMIT="$2" WD_EVERY="$3" zsh -f "$OUT/d3-watchdog.rendered.zsh" > "$OUT/wd-$label.log" 2>&1; echo $? > "$OUT/wdrc-$label.txt" ) &
  fi
  WDBG=$!
}
wd_stop() { kill "$WDBG" 2> /dev/null; pkill -f "d3-watchdog.rendered.zsh" 2> /dev/null; wait "$WDBG" 2> /dev/null; }
wait_for() { # wait_for <seconds> <grep pattern> <file>
  local i; for i in $(seq 1 "$1"); do grep -q -E "$2" "$3" 2> /dev/null && return 0; sleep 1; done; return 1
}

# ---------------- F. facts ---------------------------------------------------------------------
say "== F. facts (RESULT lines, not pass/fail)"
say "RESULT supabase-go db query exists: $("$GOBIN" db query --help > "$OUT/dbquery-help.txt" 2>&1; echo rc=$?); flags: $(grep -E '^ +(-|--)' "$OUT/dbquery-help.txt" | awk '{print $1,$2}' | tr '\n' ';' | cut -c1-400)"
say "RESULT global flags: $("$GOBIN" --help 2>&1 | grep -E -- '--agent|-o, --output' | tr '\n' ';' | cut -c1-300)"
FQ() { env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" --agent no db query --db-url "$TLSURL" -o json "$1"; }
FQ "select 1 as one, 'x' as t, now() as ts, true as b, null as nul" > "$OUT/shape-ok.json" 2> "$OUT/shape-ok.err"; RCOK=$?
say "RESULT db query -o json, success: exit=$RCOK; bytes:"; head -c 700 "$OUT/shape-ok.json" | cat -A | sed 's/^/   | /' | tee -a "$RES"
say "RESULT   stderr: $(head -c 200 "$OUT/shape-ok.err" | tr '\n' ' ')"
FQ "select * from no_such_table_d3" > "$OUT/shape-err.json" 2> "$OUT/shape-err.err"; RCER=$?
say "RESULT db query -o json, SQL error: exit=$RCER; stdout: $(head -c 300 "$OUT/shape-err.json" | tr '\n' ' ') stderr: $(head -c 300 "$OUT/shape-err.err" | tr '\n' ' ')"
say "RESULT backend reuse across three consecutive db query sessions (pid, backend_start, application_name):"
for i in 1 2 3; do say "   | $(FQ "select pg_backend_pid() as pid, backend_start::text as bs, application_name as app from pg_stat_activity where pid = pg_backend_pid()" 2> /dev/null | tr -d '\n ')"; sleep 1; done
expect "db query -o json succeeds and an SQL error exits non-zero" "$([ "$RCOK" = 0 ] && [ "$RCER" != 0 ] && echo 0 || echo 1)" "ok=$RCOK err=$RCER"

# ---------------- baseline for the rollback checks ---------------------------------------------
clean_probe
BASE="$OUT/wdir-base"; mkwd "$BASE"; write_probe "$BASE" 1
s1_start pre "$BASE"; s1_wait pre
expect "setup: only 0213 applied (history list, exit 0)" "$([ "$S1RC" = 0 ] && [ "$(hist_list)" = "0213" ] && echo 0 || echo 1)" "exit=$S1RC history>=0213: $(hist_list)"
catalog > "$OUT/catalog-pre.txt"
EXPECT_TOTAL_BEFORE="$(hist_total)"
say "INFO  baseline: history total/distinct $EXPECT_TOTAL_BEFORE; catalog lines $(wc -l < "$OUT/catalog-pre.txt")"

snapshot() { # snapshot <label> <arm timestamp>: every backend with the identification attributes + would-cancel sets of the candidate predicates
  say "-- live snapshot ($1) $(date +%T)"
  psqld -F '|' -c "select pid, usename, backend_type, left(coalesce(application_name, ''), 12) as app, coalesce(client_addr::text, '-') as caddr, to_char(backend_start, 'HH24:MI:SS.MS') as bstart, to_char(xact_start, 'HH24:MI:SS.MS') as xstart, to_char(query_start, 'HH24:MI:SS.MS') as qstart, state, coalesce(wait_event_type || ':' || wait_event, '-') as we, coalesce(backend_xid::text, '-') as xid, left(replace(query, E'\n', ' '), 38) as q,
    (backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and now() - query_start > interval '10 seconds') as P0_unscoped,
    (backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and now() - query_start > interval '10 seconds' and backend_xid is not null) as P_has_xid,
    (backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and now() - query_start > interval '10 seconds' and backend_start > '$2'::timestamptz) as P_new_backend,
    (backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and state = 'active' and now() - query_start > interval '10 seconds' and (backend_xid is not null or exists (select 1 from pg_locks l where l.pid = pg_stat_activity.pid and l.locktype = 'relation' and l.granted and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')))) as P_writer_or_heavy_lock
    from pg_stat_activity where datname = 'postgres' or backend_type <> 'client backend' order by backend_start" | sed 's/^/   | /' | tee -a "$RES"
  say "-- locks held/awaited by postgres-role client backends ($1) (virtualxid omitted)"
  psqld -F '|' -c "select l.pid, l.locktype, l.mode, l.granted, coalesce(l.relation::regclass::text, l.objid::text, l.transactionid::text, '-') as what from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.usename = 'postgres' and a.backend_type = 'client backend' and a.pid <> pg_backend_pid() and l.locktype <> 'virtualxid' order by l.pid, l.locktype" | sed 's/^/   | /' | tee -a "$RES"
}

# ---------------- A. scope: the pinned watchdog beside decoys that must NEVER be cancelled --------
say "== A. scope proof (threshold scaled to 20 s, poll 3 s): the S1 session is cancelled, nothing else is"
APPDB() { # APPDB <role to SET ROLE to> <seconds> <tag> : app traffic as authenticator (usename=authenticator), timeouts disabled
  PGPASSWORD=postgres psql "postgresql://authenticator@$RUNNER_IP:$PORT/postgres?sslmode=disable" -X -At -v ON_ERROR_STOP=0 -c "set statement_timeout = 0" -c "set role $1" -c "/*D3-APP-$3*/ select pg_sleep($2)" -c "select 'done-$3'" 2>&1; }
{ pq "$PWU" "$(purl "$SSLM")" -At -c "set statement_timeout = 0" -c "/*D3-D1*/ select pg_sleep(110)" -c "select 'done-D1'" > "$OUT/decoy-D1.log"; } &
D1BG=$!
{ APPDB anon 110 anon > "$OUT/decoy-anon.log"; } &
A1=$!
{ APPDB authenticated 110 authd > "$OUT/decoy-authd.log"; } &
A2=$!
{ APPDB service_role 110 svc > "$OUT/decoy-svc.log"; } &
A3=$!
{ sadm -c "set statement_timeout = 0" -c "/*D3-ADMIN*/ select pg_sleep(110)" -c "select 'done-ADMIN'" > "$OUT/decoy-admin.log" 2>&1; } &
A4=$!
sleep 8
ARM_TS="$(psqld -c "select now()::text")"
clean_probe_keep() { :; }
write_probe "$BASE" 4
psqld -c "update public.d3_knob set value = 70" > /dev/null   # the slow condition: 70 s, set OUTSIDE the file
wd_start scope 20 3
sleep 7
s1_start scope "$BASE"
wait_for 40 'WATCHDOG PINNED' "$OUT/wd-scope.log"; PINNED=$?
sleep 6
# a second pooled postgres session opened AFTER the pin (the hard case that is covered by the pin)
{ pq "$PWU" "$(purl "$SSLM")" -At -c "set statement_timeout = 0" -c "/*D3-D2-after-pin*/ select pg_sleep(60)" -c "select 'done-D2'" > "$OUT/decoy-D2.log"; } &
D2BG=$!
sleep 3
snapshot scope "$ARM_TS"
cp "$OUT/results.txt" "$OUT/results-after-snapshot.txt"
s1_wait scope
SCOPE_RC=$S1RC
sleep 4
wd_stop
for p in "$D1BG" "$D2BG" "$A1" "$A2" "$A3" "$A4"; do wait "$p" 2> /dev/null; done
say "-- watchdog log (scope):"; sed 's/^/   | /' "$OUT/wd-scope.log" | tee -a "$RES"
survived() { grep -q "done-$1" "$OUT/decoy-$2.log" && ! grep -q -E '57014|canceling statement' "$OUT/decoy-$2.log"; }
expect "(A1) the S1 session was pinned, exactly one statement cancelled (57014), the CLI exited non-zero" "$([ "$PINNED" = 0 ] && [ "$SCOPE_RC" != 0 ] && grep -q '57014' "$OUT/run-scope.log" && grep -c 'WATCHDOG CANCELLED' "$OUT/wd-scope.log" | grep -qx 1 && echo 0 || echo 1)" "pinned=$PINNED exit=$SCOPE_RC cancelled-lines=$(grep -c 'WATCHDOG CANCELLED' "$OUT/wd-scope.log")"
expect "(A2) a second pooled postgres session open BEFORE the watchdog armed was NOT cancelled (ran to completion, no 57014)" "$(survived D1 D1 && echo 0 || echo 1)" "$(tr '\n' ' ' < "$OUT/decoy-D1.log" | cut -c1-120)"
expect "(A3) a second pooled postgres session opened AFTER the pin was NOT cancelled" "$(survived D2 D2 && echo 0 || echo 1)" "$(tr '\n' ' ' < "$OUT/decoy-D2.log" | cut -c1-120)"
expect "(A4) app traffic (authenticator with SET ROLE anon / authenticated / service_role) was NOT cancelled" "$(survived anon anon && survived authd authd && survived svc svc && echo 0 || echo 1)" "anon:$(tr '\n' ' ' < "$OUT/decoy-anon.log" | cut -c1-60) | authd:$(tr '\n' ' ' < "$OUT/decoy-authd.log" | cut -c1-40) | svc:$(tr '\n' ' ' < "$OUT/decoy-svc.log" | cut -c1-40)"
expect "(A5) a long supabase_admin session was NOT cancelled" "$(survived ADMIN admin && echo 0 || echo 1)" "$(tr '\n' ' ' < "$OUT/decoy-admin.log" | cut -c1-80)"
say "RESULT decoys were genuinely long and uncancelled-by-role-timeouts: statement_timeout set to 0 in each; they ran ~110 s against a 20 s threshold"
say "RESULT backend types present (autovacuum etc. are excluded by backend_type = 'client backend'): $(psqld -c "select string_agg(distinct backend_type, ', ') from pg_stat_activity")"
say "RESULT autovacuum worker past the threshold: NOT reproduced (no way to hold one that long here); excluded by the predicate's backend_type filter only. The watchdog's own poll backend is excluded by pid <> pg_backend_pid() and lives milliseconds; the log shows no self-cancel."

# ---------------- B. cancel + rollback + reconcile (scaled, then the REAL 120 s) ----------------
reconcile_case() { # reconcile_case <label> <limit> <every> <knob seconds> <min elapsed> <max elapsed> [proxy label]
  local label="$1" limit="$2" every="$3" knob="$4" lo="$5" hi="$6" px="${7:-}"
  say "== B. $label: threshold ${limit}s, poll ${every}s, the slow statement would run ${knob}s"
  clean_probe; local wdir="$OUT/wdir-$label"
  mkwd "$wdir"; write_probe "$wdir" 1
  s1_start "pre-$label" "$wdir"; s1_wait "pre-$label"
  catalog > "$OUT/catalog-pre-$label.txt"
  local pre_total; pre_total="$(hist_total)"
  say "INFO  $label: catalog lines pre-file: $(wc -l < "$OUT/catalog-pre-$label.txt"); history total/distinct before the cancelled push: $pre_total"
  [ "$(wc -l < "$OUT/catalog-pre-$label.txt")" -gt 20 ] || say "WARN  the pre-file catalog is suspiciously small: the rollback comparison would be vacuous"
  write_probe "$wdir" 4                                  # 0214-0216 appear; the slow file's bytes never change afterwards
  local sum_before; sum_before="$(sha256sum "$wdir/supabase/migrations/0214_d3_slow.sql" | cut -c1-16)"
  psqld -c "update public.d3_knob set value = $knob" > /dev/null
  wd_start "$label" "$limit" "$every" "$px"
  sleep $((every + 2))
  local t0=$SECONDS
  s1_start "$label" "$wdir"; s1_wait "$label"
  local el=$((SECONDS - t0)) rc=$S1RC
  sleep $((every + 1)); wd_stop
  say "-- watchdog log ($label):"; sed 's/^/   | /' "$OUT/wd-$label.log" | tee -a "$RES"
  tail -n 8 "$OUT/run-$label.log" | sed 's/^/   | /' | tee -a "$RES"
  expect "(B/$label 2) cancelled past the threshold: elapsed ${el}s within [$lo,$hi], 57014, CLI exit non-zero and stopped (no 0215/0216 marker)" "$([ "$rc" != 0 ] && grep -q '57014' "$OUT/run-$label.log" && [ "$el" -ge "$lo" ] && [ "$el" -le "$hi" ] && [ "$(psqld -c "select count(*) from pg_tables where tablename in ('d3_next','d3_last')")" = 0 ] && echo 0 || echo 1)" "exit=$rc elapsed=${el}s overshoot over the limit=$((el - limit))s (poll ${every}s + CLI start)"
  catalog > "$OUT/catalog-post-$label.txt"
  diff "$OUT/catalog-pre-$label.txt" "$OUT/catalog-post-$label.txt" > "$OUT/catalog-diff-$label.txt"
  expect "(B/$label 3) rollback left NO trace: catalog diff against the pre-file state is empty (objects created before the slow statement are absent), no history row for 0214, 0213 intact" "$([ ! -s "$OUT/catalog-diff-$label.txt" ] && [ "$(hist_list)" = "0213" ] && [ "$(psqld -c "select count(*) from pg_tables where tablename in ('d3_t1','d3_late')") $(psqld -c "select count(*) from pg_type where typname = 'd3_ty'") $(psqld -c "select count(*) from pg_proc where proname = 'd3_fn'")" = "0 0 0" ] && echo 0 || echo 1)" "catalog lines pre/post $(wc -l < "$OUT/catalog-pre-$label.txt")/$(wc -l < "$OUT/catalog-post-$label.txt"); diff bytes $(wc -c < "$OUT/catalog-diff-$label.txt"); history>=0213: $(hist_list)"
  local listed; listed="$(dry_list "$wdir")"
  expect "(B/$label 4a) history equals exactly the files applied before the cancelled one; dry run lists exactly the remaining files starting with the cancelled one" "$([ "$(hist_list)" = "0213" ] && [ "$listed" = "0214,0215,0216" ] && echo 0 || echo 1)" "history=$(hist_list) dry-run lists: $listed"
  psqld -c "update public.d3_knob set value = 0" > /dev/null   # the slow condition removed; the FILE is byte-identical
  local sum_after; sum_after="$(sha256sum "$wdir/supabase/migrations/0214_d3_slow.sql" | cut -c1-16)"
  s1_start "second-$label" "$wdir"; s1_wait "second-$label"
  local ver_ge; ver_ge="$(hist_n)"
  expect "(B/$label 4b) after the slow condition is removed a second push applies exactly those: exit 0, history == 0213,0214,0215,0216, no duplicate or skipped version, count(version >= first) = 4, file bytes unchanged" "$([ "$S1RC" = 0 ] && [ "$(hist_list)" = "0213,0214,0215,0216" ] && [ "$ver_ge" = 4 ] && [ "$(hist_total)" = "$(echo "$pre_total" | awk -F/ '{print ($1+3) "/" ($2+3)}')" ] && [ "$sum_before" = "$sum_after" ] && grep -q '^Finished supabase db push\.' "$OUT/run-second-$label.log" && echo 0 || echo 1)" "exit=$S1RC history=$(hist_list) total/distinct=$(hist_total) count>=0213=$ver_ge file sha $sum_before=$sum_after"
  catalog > "$OUT/catalog-final-$label.txt"
  expect "(B/$label 4c) final catalog = pre-file catalog plus exactly the objects of 0214-0216" "$([ "$(diff "$OUT/catalog-pre-$label.txt" "$OUT/catalog-final-$label.txt" | grep -c '^>')" -ge 8 ] && ! diff "$OUT/catalog-pre-$label.txt" "$OUT/catalog-final-$label.txt" | grep -q '^<' && echo 0 || echo 1)" "added lines $(diff "$OUT/catalog-pre-$label.txt" "$OUT/catalog-final-$label.txt" | grep -c '^>'), removed $(diff "$OUT/catalog-pre-$label.txt" "$OUT/catalog-final-$label.txt" | grep -c '^<')"
}
reconcile_case scaled 15 3 60 12 40
reconcile_case real120 120 5 400 118 150 wd120
expect "(B/real120 7) the operator loop made zero outbound HTTP(S) requests behind the mitm proxy (S1 shell env)" "$([ "$(nflows wd120)" = 0 ] && echo 0 || echo 1)" "requests=$(nflows wd120)"

# ---------------- C. quiet ----------------------------------------------------------------------
say "== C. quiet: the slow file runs 8 s under a 20 s threshold; nothing is cancelled"
clean_probe; QD="$OUT/wdir-quiet"; mkwd "$QD"; write_probe "$QD" 4
psqld -c "update public.d3_knob set value = 8" > /dev/null
wd_start quiet 20 3; sleep 5
s1_start quiet "$QD"; s1_wait quiet; QRC=$S1RC
sleep 16; wd_stop
sed 's/^/   | /' "$OUT/wd-quiet.log" | tee -a "$RES"
expect "(C) under the threshold nothing is cancelled: exit 0, all four files applied, no CANCELLED line, the loop stopped on its own" "$([ "$QRC" = 0 ] && [ "$(hist_list)" = "0213,0214,0215,0216" ] && ! grep -q 'CANCELLED' "$OUT/wd-quiet.log" && grep -q 'Stopping\.' "$OUT/wd-quiet.log" && echo 0 || echo 1)" "exit=$QRC history=$(hist_list) polls=$(grep -c -E 'watching|pid=' "$OUT/wd-quiet.log") cancelled=$(grep -c CANCELLED "$OUT/wd-quiet.log")"

# ---------------- D. identification weak points: a second NEW postgres-role session -------------------
say "== D. a second NEW postgres-role session, (i) active BEFORE the push session appears, (ii) starting together with it"
d_case() { # d_case <label> <decoy-first: 1|0> <ro|w>  (ro = a long read-only SELECT; w = a long WRITER: insert, then sleep inside the transaction)
  local label="$1" first="$2" kind="$3"
  clean_probe; local dd="$OUT/wdir-$label"; mkwd "$dd"; write_probe "$dd" 4
  psqld -c "update public.d3_knob set value = 45" > /dev/null
  wd_start "$label" 15 3; sleep 5
  if [ "$kind" = ro ]; then
    { pq "$PWU" "$(purl "$SSLM")" -At -c "set statement_timeout = 0" -c "/*D3-$label*/ select pg_sleep(60)" -c "select 'done-$label'" > "$OUT/decoy-$label.log"; } &
  else
    { pq "$PWU" "$(purl "$SSLM")" -At -c "set statement_timeout = 0" -c "begin" -c "insert into public.d3_decoy values (1)" -c "/*D3-$label*/ select pg_sleep(60)" -c "commit" -c "select 'done-$label'" > "$OUT/decoy-$label.log"; } &
  fi
  local dbg=$!
  if [ "$first" = 1 ]; then wait_for 20 'PINNED|AMBIGUOUS' "$OUT/wd-$label.log"; fi
  s1_start "$label" "$dd"
  wait_for 25 'PINNED|AMBIGUOUS' "$OUT/wd-$label.log"; wait_for 12 'AMBIGUOUS' "$OUT/wd-$label.log"
  sleep 22
  local still=no; [ -s "$OUT/rc-$label.txt" ] || still=yes
  say "RESULT D/$label: watchdog said: $(grep -E 'PINNED|AMBIGUOUS' "$OUT/wd-$label.log" | head -2 | cut -c1-150 | tr '\n' '|')  CANCELLED lines=$(grep -c CANCELLED "$OUT/wd-$label.log"); push still running after 22 s: $still"
  local pid; pid="$(psqld -c "select pid from pg_stat_activity where usename = 'postgres' and backend_type = 'client backend' and query ilike '%d3_knob%' and pid <> pg_backend_pid() limit 1")"
  if [ -n "$pid" ] && [ "$still" = yes ] && [ "$(grep -c CANCELLED "$OUT/wd-$label.log")" = 0 ]; then
    one="$(env -u GITHUB_TOKEN -u GH_TOKEN "${S1ENV[@]}" PGPASSWORD="$PWU" "$GOBIN" --agent no db query --db-url "$TLSURL" -o json "select pg_cancel_backend($pid)" 2>&1 | tr -d '\n ' | cut -c1-100)"
    say "RESULT D/$label: operator one-shot select pg_cancel_backend($pid) -> $one"
  fi
  s1_wait "$label"; local rc=$S1RC
  sleep 3; wd_stop; wait "$dbg" 2> /dev/null
  sed 's/^/   | /' "$OUT/wd-$label.log" | head -n 12 | tee -a "$RES"
  say "RESULT D/$label: push exit=$rc 57014=$(grep -c 57014 "$OUT/run-$label.log"); decoy: $(tr '\n' ' ' < "$OUT/decoy-$label.log" | cut -c1-70)"
  DCASE_AMB=$(grep -c AMBIGUOUS "$OUT/wd-$label.log"); DCASE_RC=$rc; DCASE_DECOY=$(survived "$label" "$label" && echo alive || echo cancelled)
  clean_probe
}
d_case rofirst 1 ro
d_case rotogether 0 ro
expect "(D i) a long READ-ONLY postgres session that is active before the push session appears (the case that fooled the first design) is NOT pinned and NOT cancelled; the push session is pinned and cancelled (57014)" "$([ "$(grep -c CANCELLED "$OUT/wd-rofirst.log")" = 1 ] && [ "$(grep -c CANCELLED "$OUT/wd-rotogether.log")" = 1 ] && survived rofirst rofirst && survived rotogether rotogether && grep -q 57014 "$OUT/run-rofirst.log" && grep -q 57014 "$OUT/run-rotogether.log" && echo 0 || echo 1)" "rofirst: cancelled-lines=$(grep -c CANCELLED "$OUT/wd-rofirst.log") decoy=$(survived rofirst rofirst && echo alive || echo cancelled); rotogether: cancelled-lines=$(grep -c CANCELLED "$OUT/wd-rotogether.log") decoy=$(survived rotogether rotogether && echo alive || echo cancelled)"
d_case wfirst 1 w
say "RESULT (D ii, RESIDUAL) a long WRITER session that becomes active before the push session is pinned in its place: pinned=$(grep -c PINNED "$OUT/wd-wfirst.log") cancelled-lines=$(grep -c CANCELLED "$OUT/wd-wfirst.log") decoy=$(survived wfirst wfirst && echo alive || echo cancelled); the PINNED line prints the pinned statement so the operator can see it is not the push."
d_case wtogether 0 w
if [ "$DCASE_AMB" -gt 0 ]; then
  expect "(D iii) a long WRITER session and the push session seen at once: the watchdog refused to pin and cancelled nothing automatically; the one-shot by pid stopped the push (non-zero, 57014) and the writer decoy was left alone" "$([ "$DCASE_RC" != 0 ] && grep -q 57014 "$OUT/run-wtogether.log" && [ "$DCASE_DECOY" = alive ] && ! grep -q CANCELLED "$OUT/wd-wtogether.log" && echo 0 || echo 1)" "amb=$DCASE_AMB rc=$DCASE_RC decoy=$DCASE_DECOY"
else
  say "RESULT (D iii) the watchdog polled between the two starts, so this timing was not ambiguous (see the log above): pinned=$(grep -c PINNED "$OUT/wd-wtogether.log") cancelled-lines=$(grep -c CANCELLED "$OUT/wd-wtogether.log")"
fi
psqld -c "delete from public.d3_decoy" > /dev/null 2>&1

# ---------------- D2. pg_cron: does a cron job look like a postgres-role client backend? ---------------
say "== D2. pg_cron beside the watchdog"
CRON="$(sadm -c "create extension if not exists pg_cron" 2>&1 | tr '\n' ' ')"
if sadm -c "select 1 from pg_extension where extname = 'pg_cron'" | grep -q 1; then
  wd_start cron 15 3; sleep 4
  psqld -c "select cron.schedule('d3-cron', '30 seconds', \$\$/*D3-CRON*/ select pg_sleep(40)\$\$)" > /dev/null 2>&1
  sleep 75
  psqld -F '|' -c "select pid, usename, backend_type, state, left(query, 30) from pg_stat_activity where query like '%D3-CRON%' and pid <> pg_backend_pid()" | sed 's/^/   | /' | tee -a "$RES"
  wd_stop
  psqld -c "select cron.unschedule(jobid) from cron.job where jobname = 'd3-cron'" > /dev/null 2>&1
  sed 's/^/   | /' "$OUT/wd-cron.log" | head -n 10 | tee -a "$RES"
  say "RESULT pg_cron: job_run_details: $(psqld -c "select string_agg(status || ':' || coalesce(left(return_message, 30), ''), ' ; ') from (select * from cron.job_run_details order by start_time desc limit 3) x")"
  expect "(D2) a pg_cron job running past the threshold was NOT cancelled by the watchdog" "$(psqld -c "select count(*) from cron.job_run_details where return_message ilike '%cancel%'" | grep -qx 0 && ! grep -q CANCELLED "$OUT/wd-cron.log" && echo 0 || echo 1)" "CANCELLED lines=$(grep -c CANCELLED "$OUT/wd-cron.log"); pinned: $(grep -c PINNED "$OUT/wd-cron.log")"
else
  say "RESULT pg_cron: NOT available on this local image ($(echo "$CRON" | cut -c1-160)); UNPROVEN here"
fi

# ---------------- E. killing the CLI mid-statement (is Ctrl-C a bound?) --------------------------
say "== E. killing the CLI mid-statement through the pooler (facts)"
EDIR="$OUT/wdir-kill"; mkwd "$EDIR"; write_probe "$EDIR" 4
psqld -c "update public.d3_knob set value = 40" > /dev/null
s1_start kill "$EDIR"
sleep 9
CLIPID="$(pgrep -f "supabase-go db push" | head -1)"
kill -9 "$CLIPID" 2> /dev/null
say "RESULT SIGKILL sent to the CLI (pid ${CLIPID:-none}) 9 s into a 40 s statement"
for t in 2 8 20 40; do
  sleep $([ "$t" = 2 ] && echo 2 || echo $((t == 8 ? 6 : t == 20 ? 12 : 20)))
  say "RESULT   +${t}s after the kill: upstream backend still running the statement: $(psqld -c "select count(*) from pg_stat_activity where usename = 'postgres' and query ilike '%d3_knob%' and state = 'active' and pid <> pg_backend_pid()")"
done
wait "$S1BG" 2> /dev/null
say "RESULT   after the dust settled: history>=0213 = $(hist_list); d3_t1 exists = $(psqld -c "select count(*) from pg_tables where tablename = 'd3_t1'") (a committed file would show 0213,0214.. )"
clean_probe
say "== E2. SIGINT (what Ctrl-C sends) to the CLI mid-statement"
mkwd "$EDIR"; write_probe "$EDIR" 4
psqld -c "update public.d3_knob set value = 40" > /dev/null
s1_start killint "$EDIR"
sleep 9
CLIPID="$(pgrep -f "supabase-go db push" | head -1)"
kill -INT "$CLIPID" 2> /dev/null
say "RESULT SIGINT sent to the CLI (pid ${CLIPID:-none}) 9 s into a 40 s statement"
for t in 2 8 20 40; do
  sleep $([ "$t" = 2 ] && echo 2 || echo $((t == 8 ? 6 : t == 20 ? 12 : 20)))
  say "RESULT   +${t}s after SIGINT: upstream backend still running the statement: $(psqld -c "select count(*) from pg_stat_activity where usename = 'postgres' and query ilike '%d3_knob%' and state = 'active' and pid <> pg_backend_pid()"); CLI process alive: $(kill -0 "$CLIPID" 2> /dev/null && echo yes || echo no)"
done
wait "$S1BG" 2> /dev/null
say "RESULT   after the dust settled: CLI exit=$(cat "$OUT/rc-killint.txt" 2> /dev/null); history>=0213 = $(hist_list); d3_t1 exists = $(psqld -c "select count(*) from pg_tables where tablename = 'd3_t1'")"
clean_probe

# ---------------- G. read-back command forms, under zsh, behind the proxy -----------------------------
say "== G. hosted timeout read-back command forms (zsh, S1 shell, supabase-go db query via the TLS relay)"
cat > "$OUT/readback.zsh" <<'ZSH'
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false
unset GITHUB_TOKEN GH_TOKEN
read -rs PGPASSWORD
export PGPASSWORD
Q="./supabase-cli/supabase-go --agent no db query -o json"
OPTURL="postgresql://<USER>@<HOSTPORT>/postgres?sslmode=require&options=-c%20statement_timeout%3D120000"
PLAINURL="postgresql://<USER>@<HOSTPORT>/postgres?sslmode=require"
print -r -- "### 1 show statement_timeout, WITH options"
${=Q} --db-url "$OPTURL" "show statement_timeout"; print -r -- "exit=$?"
print -r -- "### 2 show statement_timeout, WITHOUT options"
${=Q} --db-url "$PLAINURL" "show statement_timeout"; print -r -- "exit=$?"
print -r -- "### 3 pg_settings"
${=Q} --db-url "$OPTURL" "select name, setting, source from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')"; print -r -- "exit=$?"
print -r -- "### 4 pg_roles"
${=Q} --db-url "$OPTURL" "select rolname, rolconfig from pg_roles where rolname = 'postgres'"; print -r -- "exit=$?"
ZSH
sed -e "s#<USER>#$PUSER#g" -e "s#<HOSTPORT>#$RUNNER_IP:$TLSP#g" "$OUT/readback.zsh" > "$OUT/readback.rendered.zsh"
zsh -n "$OUT/readback.rendered.zsh"; expect "(G) the read-back script parses under zsh" "$?" "ok"
printf '%s\n' "$PWU" | with_proxy readback zsh -f "$OUT/readback.rendered.zsh" > "$OUT/readback.out" 2>&1
sed 's/^/   | /' "$OUT/readback.out" | tee -a "$RES"
expect "(G) all four read-back commands exit 0 and make zero outbound HTTP(S) requests (no Management API call)" "$([ "$(grep -c '^exit=0' "$OUT/readback.out")" = 4 ] && [ "$(nflows readback)" = 0 ] && echo 0 || echo 1)" "exit-0 lines=$(grep -c '^exit=0' "$OUT/readback.out") requests=$(nflows readback)"

# ---------------- H. negative control: Team's unscoped predicate DOES cancel a decoy ---------------
say "== H. negative control: the unscoped predicate from #1170 cancels an unrelated postgres session (so the decoys above were cancellable)"
{ pq "$PWU" "$(purl "$SSLM")" -At -c "set statement_timeout = 0" -c "/*D3-H*/ select pg_sleep(40)" -c "select 'done-H'" > "$OUT/decoy-H.log"; } &
HBG=$!
sleep 9
psqld -c "select pid, now() - query_start as running, pg_cancel_backend(pid) as cancelled, left(query, 30) as q from pg_stat_activity where backend_type = 'client backend' and datname = 'postgres' and usename = 'postgres' and pid <> pg_backend_pid() and state = 'active' and now() - query_start > interval '5 seconds'" | sed 's/^/   | /' | tee -a "$RES"
wait "$HBG" 2> /dev/null
expect "(H) the unscoped predicate cancelled the unrelated decoy (57014): the decoys are cancellable, so (A2)-(A5) are not vacuous" "$(grep -q -E '57014|canceling statement' "$OUT/decoy-H.log" && echo 0 || echo 1)" "$(tr '\n' ' ' < "$OUT/decoy-H.log" | cut -c1-100)"

# ---------------- operator form ----------------------------------------------------------------------
say "== operator watchdog (zsh), exactly as rehearsed, with the placeholders:"
sed 's/^/   | /' scripts/ci/d3-watchdog.zsh | tee -a "$RES" > /dev/null
say "INFO  d3-watchdog.zsh sha256: $(sha256sum scripts/ci/d3-watchdog.zsh | cut -d' ' -f1)"
say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; head -c 900000 "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
