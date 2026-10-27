#!/bin/bash
# REHEARSAL - NEVER MERGE. S0B-READS on macOS arm64 (macos-14): the PRE-RESTORE check and the VALIDATION script against two synthetic databases.
# REAL: the S0B scripts, comparator, SQL templates and the runner (byte-identical copies in ./pkg), the darwin supabase-go v2.102.0 (dce26b75) that runs
#       every query, PostgreSQL 17 with TLS and scram, the real migration chain 0001..0212 (bundle d189768b) applied by the real CLI, pg_dump/pg_restore.
# STUB:   the hosted side. "Production" is database postgres and "the restored project" is another database in the same throwaway cluster on 127.0.0.1;
#         the CLI reaches them through --db-url (a wrapper rewrites --linked), NOT through the Management API. The optional production features
#         (cron, pg_net, webhooks, vault) are synthetic stub tables. All rows are synthetic. The typed answers are scripted. CHECK/EXCLUDE constraints on the
#         eight counted tables are dropped before the synthetic rows go in (the rows are counted, they are not valid bookings).
#         PIN SUBSTITUTIONS in test copies only: the wrapper's sha for GO_SHA and the runner's SUPABASE_GO_SHA256, the resulting runner sha for RUNNER_SHA and
#         the comparator's RUNNER_SHA constant, the test comparator's sha for CMP_SHA. A diff proves they are the only differences.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/pkg"
DRV="$HERE/driver.py"
W="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/s0b.XXXXXX")}"; mkdir -p "$W"; W="$(cd "$W" && pwd -P)"
H="$W/home"; ROOT="$H/hone-s1"; mkdir -p "$H"
STEPS="$W/steps.tsv"; : > "$STEPS"
pass=0; fail=0; CUR=setup
ok()  { pass=$((pass+1)); echo "ok   - $1"; printf '%s\tok\t%s\n' "$CUR" "$1" >> "$STEPS"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; printf '%s\tFAIL\t%s %s\n' "$CUR" "$1" "${2:-}" >> "$STEPS"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TOKEN="sbp_$(openssl rand -hex 20)"     # a throwaway value made at run time; never stored in the repository
PW_P=PW-PROD-91b3c7e2
PW_R=PW-REST-4e8a20d9
REF=alhhybgqdmcdyzpybykj
RREF=abcdefghijklmnopqrst
NODEDIR="$(dirname "$(node -p process.execPath)")"
SAFEPATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$NODEDIR"

# ---------------------------------------------------------------------------------------------------------------------
CUR=pkg
( cd "$PKG" && shasum -a 256 -c "$HERE/pkg.SHA256SUMS" >/dev/null 2>&1 ) && ok "the package copies in ./pkg match the recorded checksums" || bad "pkg checksums"
[ "$(sha "$PKG/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "the runner copy is the pinned 471ecb9d" || bad "runner copy sha"
for s in s0b-validate.sh s0b-precheck.sh; do /bin/bash -n "$PKG/$s" && ok "bash -n $s" || bad "bash -n $s"; done
UT=0; ( cd "$PKG" && node --test s0b-compare.test.mjs ) > "$W/unit.out" 2>&1 || UT=$?
if [ "$UT" = 0 ] && grep -Eq '^(ℹ|#) fail 0$' "$W/unit.out"; then ok "comparator unit tests: $(grep -E '^(ℹ|#) pass' "$W/unit.out") (node $(node --version))"; else bad "comparator unit tests" "$(tail -n 15 "$W/unit.out")"; fi

# ---------------------------------------------------------------------------------------------------------------------
CUR=infra
B=$("$HERE/pg-setup.sh" "$W/pg" "$PW_P") || { echo "pg-setup failed"; tail -20 "$W/pg/pg.log" 2>/dev/null; exit 2; }
PSQLD() { local db=$1; shift; "$B/psql" -X -At -h "$W/pg" -p 55432 -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
PSQLD postgres -c "create role \"postgres.$RREF\" superuser login password '$PW_R'" >/dev/null || { echo "could not create the restored-project role"; exit 2; }
LOCALURL="postgresql://postgres.$REF@127.0.0.1:55432/postgres?sslmode=require"
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "no member of the release archive hashes to dce26b75"; exit 2; }
mkdir -p "$W/build/supabase/migrations" "$W/build/supabase/.temp" && tar -xf "$HERE/migrations-d189768b.tar" -C "$W/build"
for f in "$W/build/supabase/migrations/"*.sql; do v=$(basename "$f" | cut -c1-4); [ "$v" -gt 0212 ] && rm "$f"; done
printf 'v2.102.0\n' > "$W/build/supabase/.temp/cli-latest"
( cd "$W/build" && PGPASSWORD="$PW_P" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$REALBIN" db push --db-url "$LOCALURL" --yes ) > "$W/build.log" 2>&1 || { echo "building 0212 failed"; tail -30 "$W/build.log"; exit 2; }
HIST0=$(PSQLD postgres -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
[ "$HIST0" = "211|0212" ] && ok "synthetic production is at 0212 (211 history rows) after the real CLI applied the real chain" || { bad "build 0212" "$HIST0"; exit 2; }

# ---- synthetic data BEFORE the dump (what existed at T), stubs, then the dump = "the restore at T"
T=$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
printf '%s' "$T" > "$W/T.txt"
PSQLD postgres -f "$HERE/lib.sql" -f "$HERE/data.sql" -v phase=pre -v t="$T" > "$W/data-pre.log" 2>&1 && ok "synthetic rows created before T=$T (3 studios, clients, appointments, sessions, consents, intake, charges, payments, storage metadata)" || { bad "pre-T data" "$(tail -n 8 "$W/data-pre.log")"; exit 2; }
PSQLD postgres -f "$HERE/stubs.sql" > "$W/stubs.log" 2>&1 && ok "stub cron / pg_net / webhook / vault objects created in the synthetic production" || { bad "stubs" "$(tail -n 5 "$W/stubs.log")"; exit 2; }
PSQLD postgres -f "$HERE/stubs2.sql" > "$W/stubs2.log" 2>&1 && ok "stub foreign server / publication / subscription / event trigger / http-calling function and trigger created" || { bad "stubs2" "$(tail -n 8 "$W/stubs2.log")"; exit 2; }
"$B/pg_dump" --no-subscriptions -h "$W/pg" -p 55432 -U postgres -d postgres -Fc -f "$W/prod.dump" && ok "pg_dump of the synthetic production at T" || { bad "pg_dump"; exit 2; }
PSQLD postgres -f "$HERE/lib.sql" -f "$HERE/data.sql" -v phase=post -v t="$T" > "$W/data-post.log" 2>&1 && ok "synthetic rows created AFTER T in production only (studio 4, extra rows in studios 1 and 2, two storage objects)" || { bad "post-T data" "$(tail -n 8 "$W/data-post.log")"; exit 2; }

# ---------------------------------------------------------------------------------------------------------------------
CUR=layout
mkdir -p "$ROOT/supabase-cli/real" "$ROOT/s0b" "$ROOT/_e2e"
cp "$REALBIN" "$ROOT/supabase-cli/real/supabase-go"; chmod 0755 "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
printf '%s\n' "$RREF" > "$ROOT/e2e-restored-ref"; : > "$ROOT/e2e-calls.log"
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$PKG/run-window-read-macos.sh" > "$ROOT/s0b/run-window-read-macos.sh"; chmod 0755 "$ROOT/s0b/run-window-read-macos.sh"
RSHA=$(sha "$ROOT/s0b/run-window-read-macos.sh")
for f in "$PKG"/p*.sql "$PKG"/v*.sql "$PKG/MANIFEST.sha256"; do cp "$f" "$ROOT/s0b/"; done
sed -E "s/^export const RUNNER_SHA = \"[0-9a-f]{64}\";/export const RUNNER_SHA = \"$RSHA\";/" "$PKG/s0b-compare.mjs" > "$ROOT/s0b/s0b-compare.mjs"
CSHA=$(sha "$ROOT/s0b/s0b-compare.mjs")
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^CMP_SHA=.*/CMP_SHA=$CSHA/" "$PKG/s0b-validate.sh" > "$ROOT/_e2e/s0b-validate.sh"
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$PKG/s0b-precheck.sh" > "$ROOT/_e2e/s0b-precheck.sh"
chmod 0755 "$ROOT/_e2e/s0b-validate.sh" "$ROOT/_e2e/s0b-precheck.sh"; chmod 0755 "$ROOT" "$ROOT/s0b"
chk() { # chk REAL TEST PATTERN
  local d; d=$(diff "$1" "$2" | grep '^[<>]' | grep -Ev "$3" | wc -l | tr -d ' ')
  [ "$d" = 0 ] && ok "test copy of $(basename "$1") differs from the package only on its pin lines" || bad "test copy of $(basename "$1") differs elsewhere"
}
chk "$PKG/run-window-read-macos.sh" "$ROOT/s0b/run-window-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
chk "$PKG/s0b-compare.mjs" "$ROOT/s0b/s0b-compare.mjs" '^[<>] export const RUNNER_SHA ='
chk "$PKG/s0b-validate.sh" "$ROOT/_e2e/s0b-validate.sh" '^[<>] (GO_SHA|RUNNER_SHA|CMP_SHA)='
chk "$PKG/s0b-precheck.sh" "$ROOT/_e2e/s0b-precheck.sh" '^[<>] (GO_SHA|RUNNER_SHA)='
( cd "$ROOT/s0b" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "the 19 pinned SQL files verify against the pinned MANIFEST.sha256" || bad "manifest"

# ---------------------------------------------------------------------------------------------------------------------
CUR=restore
mk_restored() { # mk_restored NAME : a fresh database from the dump (the state at T), made the "restored project" for the next run
  PSQLD postgres -c "drop database if exists $1" >/dev/null && PSQLD postgres -c "create database $1 template template0 encoding 'UTF8'" >/dev/null || { bad "create database $1"; return 1; }
  local rc=0
  "$B/pg_restore" -h "$W/pg" -p 55432 -U postgres -d "$1" "$W/prod.dump" > "$W/restore-$1.log" 2>&1 || rc=$?
  PSQLD postgres -c "alter database $1 set search_path to \"\$user\", public, extensions" >/dev/null
  printf '%s\n' "$1" > "$ROOT/e2e-restored-db"
  echo "pg_restore into $1: exit $rc, $(grep -c 'error' "$W/restore-$1.log" | tr -d ' ') error lines (kept in the artifact)"
}
MUT() { # MUT DB 'sql' : change the restored database (replica mode: no triggers, no foreign keys)
  { cat "$HERE/lib.sql"; printf '%s\n' "$2"; } | PSQLD "$1" > "$W/mut-$1.log" 2>&1 || { bad "mutation on $1" "$(tail -n 5 "$W/mut-$1.log")"; return 1; }
}
drive() { # drive NAME ANSWERS SCRIPT
  RC=0
  python3 "$DRV" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$3" || RC=$?
  OUT="$W/$1.out"; tr -d '\r' < "$OUT" > "$OUT.txt"
}
calls() { grep -c . "$ROOT/e2e-calls.log" | tr -d ' '; }
validate() { # validate NAME T RREF PWP PWR [LAST4]   (answers the prompts of s0b-validate.sh)
  {
    printf 'Recovery timestamp T you gave the restore\t%s\n' "$2"
    printf 'Project ref of the RESTORED\t%s\n' "$3"
    printf 'Type the last 4 characters of the RESTORED project ref\t%s\n' "${6:-${3: -4}}"
    printf "Type yes only if the restored project's session pooler host\tyes\n"
    printf 'Type yes: the restored project is a NEW project\tyes\n'
    printf 'Supabase access token\t%s\n' "$TOKEN"
    printf 'RESTORED project database password\t%s\n' "$5"
    printf 'PRODUCTION database password\t%s\n' "$4"
  } > "$W/$1.ans"
  C0=$(calls); drive "$1" "$W/$1.ans" "$ROOT/_e2e/s0b-validate.sh"; DC=$(( $(calls) - C0 ))
}
expect_fail() { # expect_fail NAME REGEX CALLS : exit non-zero, the verdict line matches, never PASS, exact number of database reads
  if [ "$RC" != 0 ] && ! grep -qx 'S0B PASS' "$OUT.txt" && grep -Eq "$2" "$OUT.txt" && [ "$DC" = "$3" ]; then ok "$1: refused / FAIL as expected ($DC reads): $(grep -Eo "$2" "$OUT.txt" | head -n 1)"
  else bad "$1" "exit $RC, reads $DC (want $3); tail: $(tail -n 6 "$OUT.txt")"; fi
}

mk_restored r_clean
validate pass "$T" "$RREF" "$PW_P" "$PW_R"
if [ "$RC" = 0 ] && grep -qx 'S0B PASS' "$OUT.txt" && ! grep -q '^S0B FAIL' "$OUT.txt" && [ "$DC" = 20 ]; then
  ok "clean restore: S0B PASS, exit 0, 20 database reads: restored 8, restored unfiltered 4, production 8 LAST"
else bad "clean restore" "exit $RC, reads $DC; tail: $(tail -n 12 "$OUT.txt")"; fi
grep -E '^PASS ' "$OUT.txt" | sed 's/^/       /'
RUNDIR=$(ls -1dt "$ROOT"/s0b-validate.* | head -n 1)
node -e '
  const fs=require("fs"); const d=process.argv[1];
  const p=JSON.parse(fs.readFileSync(d+"/prod/res/v5-recovery-point.json")), r=JSON.parse(fs.readFileSync(d+"/rest/res/v5-recovery-point.json"));
  const c=(a)=>a.find(x=>x.table_name==="clients");
  console.log("production clients: created_le_t="+c(p).rows_created_le_t+" total="+c(p).rows_total+" newer_than_t="+c(p).rows_newer_than_t+"; restored clients: created_le_t="+c(r).rows_created_le_t+" total="+c(r).rows_total);
  process.exit(Number(c(p).rows_total) > Number(c(p).rows_created_le_t) && Number(c(r).rows_total) === Number(c(p).rows_created_le_t) ? 0 : 1);' "$RUNDIR" > "$W/tfilter.txt" \
  && ok "the T filter is exercised: production holds rows after T that its T-filtered counts exclude, and the restored copy holds exactly the pre-T rows ($(cat "$W/tfilter.txt"))" || bad "T filter evidence" "$(cat "$W/tfilter.txt")"
grep -q "p as (select '$T'::timestamptz as t)" "$RUNDIR/prod/gen/v3-studio-counts.sql" && grep -q "p as (select '9999-12-31T00:00:00Z'::timestamptz as t)" "$RUNDIR/restfar/gen/v3-studio-counts.sql" && ok "the generated v3 carries T on production and restored@T, and the far constant on restored unfiltered" || bad "generated T literal"

CUR=negatives
mk_restored r_late
MUT r_late "select pg_temp.rh_ins('public.clients', jsonb_build_object('id', gen_random_uuid(), 'studio_id', md5('studio1')::uuid, 'created_at', '$T'::timestamptz + interval '5 minutes', 'updated_at', '$T'::timestamptz + interval '5 minutes'));"
validate late "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a restored row created AFTER T (caught by the unfiltered read)" '^S0B FAIL: per-studio counts differ \(production@T vs restored@unfiltered\) at studio ordinal 1' 20

mk_restored r_missing
MUT r_missing "delete from public.appointments where id = md5('preappt2-2')::uuid;"
validate missing "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a pre-T appointment MISSING from the restored copy (id digest)" '^S0B FAIL: appointments: the restored copy holds 1 fewer ids than production held at T' 20

mk_restored r_deleted
MUT r_deleted "delete from public.payment_charge_attempts where id = md5('precharge3')::uuid;"
validate deleted "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a pre-T charge attempt DELETED in the restored copy (id digest)" '^S0B FAIL: payment_charge_attempts: the restored copy holds 1 fewer ids' 20

mk_restored r_swapid
MUT r_swapid "update public.clients set id = gen_random_uuid() where id = md5('preclient1-1')::uuid;"
validate swapid "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "same number of clients but one id differs (id digest)" '^S0B FAIL: clients: same number of ids but the id digest differs' 20

mk_restored r_updated
MUT r_updated "update public.appointments set updated_at = '$T'::timestamptz + interval '5 minutes' where id = md5('preappt1-1')::uuid;"
validate updated "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a pre-T row UPDATED after T in the restored copy" '^S0B FAIL: appointments: the restored copy holds rows newer than T' 20

mk_restored r_history
MUT r_history "delete from supabase_migrations.schema_migrations where version = (select min(version) from supabase_migrations.schema_migrations);"
validate history "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a migration history row missing from the restored copy" '^S0B FAIL: migration history differs' 20

mk_restored r_catalog
MUT r_catalog "do \$\$ declare r record; begin select * into r from pg_policies where schemaname = 'public' order by tablename, policyname limit 1; execute format('drop policy %I on public.%I', r.policyname, r.tablename); end \$\$;"
validate catalog "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a policy missing from the restored copy" '^S0B FAIL: catalog fingerprint differs' 20

# S5: rows the copy holds that production lacks at T = rows deleted in production after T: informational, not a failure
mk_restored r_extra
MUT r_extra "select pg_temp.rh_ins('public.clients', jsonb_build_object('id', gen_random_uuid(), 'studio_id', md5('studio1')::uuid, 'created_at', '$T'::timestamptz - interval '1 hour', 'updated_at', '$T'::timestamptz - interval '1 hour'));"
validate extra "$T" "$RREF" "$PW_P" "$PW_R"
if [ "$RC" = 0 ] && grep -qx 'S0B PASS' "$OUT.txt" && grep -q '^NOTE  post-T deletes signature: clients: the restored copy holds 1 more ids than production at T' "$OUT.txt" && [ "$DC" = 20 ]; then
  ok "S5: a restored copy holding one more client than production at T (a delete after T) passes with a NOTE naming the table, not a fail"
else bad "S5 post-T deletes signature" "exit $RC, reads $DC; tail: $(tail -n 10 "$OUT.txt")"; fi

mk_restored r_clean
validate sameref "$T" "$REF" "$PW_P" "$PW_R" "bykj"; expect_fail "restored ref equal to the production ref" 'STOP: the restored ref equals the production ref' 0
validate badt1 "2026-10-26" "$RREF" "$PW_P" "$PW_R"; expect_fail "T without a time" 'STOP: T is not YYYY-MM-DDTHH:MM:SSZ' 0
validate badt2 "$T'; drop table x;--" "$RREF" "$PW_P" "$PW_R"; expect_fail "T with a quote and a statement" 'STOP: T is not YYYY-MM-DDTHH:MM:SSZ' 0
validate badt3 "2099-01-01T00:00:00Z" "$RREF" "$PW_P" "$PW_R"; expect_fail "T in the future" 'STOP: T must be after 2026-01-01 and in the past' 0
validate badref "$T" "NOT-A-REF" "$PW_P" "$PW_R"; expect_fail "a malformed restored ref" 'STOP: the restored ref is not 20 lower-case letters' 0
validate badlast4 "$T" "$RREF" "$PW_P" "$PW_R" "zzzz"; expect_fail "the last 4 characters of the restored ref typed wrongly" 'STOP: the last 4 characters do not match' 0

# D4: the CLI login-role / ban text path also writes the tombstone
: > "$ROOT/e2e-fake-loginrole"
validate loginrole "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "the login-role text path" 'STOP: rest v1-history.sql: the CLI reported a login-role' 1
[ -f "$ROOT/s0b/FAILED-LOGIN" ] && ok "D4: the login-role text path wrote the FAILED-LOGIN tombstone: $(cat "$ROOT/s0b/FAILED-LOGIN")" || bad "D4: no tombstone on the login-role path"
validate afterlogin "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a re-run after the login-role path is refused" 'STOP: a previous run failed a login' 0
mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.loginrole"; mv "$ROOT/e2e-fake-loginrole" "$W/e2e-fake-loginrole.done"

# S3: the two passwords typed in the wrong order. The RESTORED project is read first, so the failed login is on the new project and production is never contacted.
validate swapped "$T" "$RREF" "$PW_R" "$PW_P"; expect_fail "the two passwords typed in the wrong order" 'STOP: rest v1-history.sql failed' 1
if [ "$(tail -n "$DC" "$ROOT/e2e-calls.log" | awk '{print $2}' | sort -u | tr '\n' ' ')" = "$RREF " ]; then ok "S3: the only read of the swapped run went to the RESTORED project; production was not contacted"; else bad "S3 swapped run touched production"; fi
[ -f "$ROOT/s0b/FAILED-LOGIN" ] && ok "S3: the failed login left the FAILED-LOGIN tombstone: $(cat "$ROOT/s0b/FAILED-LOGIN")" || bad "S3: no tombstone after a failed login"
validate afterfail "$T" "$RREF" "$PW_P" "$PW_R"; expect_fail "a re-run after a failed login is refused" 'STOP: a previous run failed a login' 0
mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.validate"

CUR=precheck
precheck() { # precheck NAME [PASSWORD]
  { printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'PRODUCTION database password\t%s\n' "${2:-$PW_P}"; } > "$W/$1.ans"
  C0=$(calls); drive "$1" "$W/$1.ans" "$ROOT/_e2e/s0b-precheck.sh"; DC=$(( $(calls) - C0 ))
}
lastline() { tail -n 1 "$OUT.txt"; }
precheck pre_a
if [ "$RC" != 0 ] && [ "$DC" = 12 ] && [ "$(lastline)" = "S0B PRECHECK STOP" ] \
   && grep -q '^cron.job: 3 jobs, 2 active, 2 mention http/net/functions (1 active)' "$OUT.txt" && grep -q '^ALERT  3 cron job(s) exist' "$OUT.txt" && grep -q '^ALERT  2 queued pg_net' "$OUT.txt" && grep -q '^ALERT  1 database webhook' "$OUT.txt" && grep -q '^ALERT  2 vault secret' "$OUT.txt" \
   && grep -q '^ALERT  1 foreign server' "$OUT.txt" && grep -q '^ALERT  1 logical replication subscription' "$OUT.txt" && grep -q '^ALERT  1 publication(s) other than supabase_realtime' "$OUT.txt" && grep -q '^ALERT  1 event trigger(s) not owned by' "$OUT.txt" \
   && grep -q '^ALERT  1 function(s) not owned by a supabase_' "$OUT.txt" && grep -q '^ALERT  1 trigger(s) run an http-calling function' "$OUT.txt" \
   && grep -q '^storage rehearsal-a: 5 objects, 500 bytes' "$OUT.txt" && grep -q '^storage (all buckets): 6 objects, 507 bytes' "$OUT.txt" && grep -q '^auth.users: 0' "$OUT.txt"; then
  ok "S1/S2: pre-check with the stub features present exits non-zero, 12 reads, ALERTs for cron, pg_net queue, webhook, vault, foreign server, subscription, publication, event trigger, http-calling function and trigger, and the LAST line is S0B PRECHECK STOP"
else bad "pre-check (features present)" "exit $RC, reads $DC; tail: $(tail -n 16 "$OUT.txt")"; fi
! grep -qE 'select 1|http_post|example.invalid|rehearsal-secret|rh_srv|rh_sub|rh_evt' "$OUT.txt" && ok "the pre-check output carries counts only: no command text, URL, secret or object name" || bad "pre-check printed a command, URL or object name"

PSQLD postgres -c 'drop table net.http_request_queue' -c 'create function net.boom() returns bigint language plpgsql as $f$ begin raise exception '"'"'rehearsal unreadable'"'"'; end $f$' -c 'create view net.http_request_queue as select net.boom() as id' >/dev/null
precheck pre_b
if [ "$RC" != 0 ] && [ "$DC" = 12 ] && grep -q '^UNREADABLE p2-net.sql' "$OUT.txt" && grep -q '^CANNOT RULE OUT  net queue: UNREADABLE' "$OUT.txt" && grep -q '^ALERT  2 vault secret' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then
  ok "S1: an unreadable risk object counts as an alert (CANNOT RULE OUT), is not retried, the remaining files were still read, and the last line is S0B PRECHECK STOP"
else bad "pre-check (unreadable object)" "exit $RC, reads $DC; tail: $(tail -n 14 "$OUT.txt")"; fi

PSQLD postgres -c "insert into supabase_migrations.schema_migrations (version, name) values ('0213', 'rehearsal')" >/dev/null
precheck pre_d
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'STOP: production history max is not 0212 (chain guard)' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then ok "pre-check chain guard: history max 0213 stops it after one read (last line S0B PRECHECK STOP)"; else bad "pre-check chain guard" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
PSQLD postgres -c "delete from supabase_migrations.schema_migrations where version = '0213'" >/dev/null

PSQLD postgres -c 'drop schema cron cascade' -c 'drop schema net cascade' -c 'drop schema supabase_functions cascade' -c 'drop schema vault cascade' -c 'alter subscription rh_sub disable' -c 'alter subscription rh_sub set (slot_name = none)' -c 'drop subscription rh_sub' -c 'drop publication rh_pub' -c 'drop event trigger rh_evt' -c 'drop trigger rh_trg on public.studios' -c 'drop function public.rh_callout_trg()' -c 'drop function public.rh_evt()' -c 'drop server rh_srv' -c 'drop foreign data wrapper rh_fdw' >/dev/null || bad "dropping the stubs"
precheck pre_c
if [ "$RC" = 0 ] && [ "$DC" = 8 ] && grep -q '^cron.job: not present' "$OUT.txt" && grep -q '^vault.secrets: not present' "$OUT.txt" && grep -q '^pg_foreign_server: 0' "$OUT.txt" && grep -q '^pg_subscription: 0' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK CLEAR" ]; then
  ok "S1: with nothing that can call out the pre-check exits 0 and the LAST line is S0B PRECHECK CLEAR (8 reads, no read of a missing relation)"
else bad "pre-check (nothing present)" "exit $RC, reads $DC; tail: $(tail -n 14 "$OUT.txt")"; fi

# D1: a user function in schema extensions calling net.http_post is scanned (no schema exclusion), D3: dblink, D2: a platform-looking event trigger name does not hide it
PSQLD postgres -c 'create function extensions.rh_helper() returns void language plpgsql as $f$ begin perform net.http_post(url := '"'"'x'"'"'); end $f$' >/dev/null
precheck pre_g
if [ "$RC" != 0 ] && [ "$DC" = 8 ] && grep -q '^ALERT  1 function(s) not owned by a supabase_' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then ok "D1: a user function in schema extensions that calls net.http_post is counted: STOP"; else bad "D1 extensions function" "exit $RC, reads $DC; tail: $(tail -n 8 "$OUT.txt")"; fi
PSQLD postgres -c 'drop function extensions.rh_helper()' >/dev/null
PSQLD postgres -c 'create function public.rh_noop() returns event_trigger language plpgsql as $f$ begin null; end $f$' -c 'create event trigger pgrst_ddl_watch on ddl_command_end execute function public.rh_noop()' >/dev/null
precheck pre_h
if [ "$RC" != 0 ] && [ "$DC" = 8 ] && grep -q '^ALERT  1 event trigger(s) not owned by' "$OUT.txt" && grep -q '1 carry a usual platform name' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then ok "D2: a non-platform event trigger carrying the platform name pgrst_ddl_watch is NOT hidden by its name: STOP"; else bad "D2 platform-looking event trigger" "exit $RC, reads $DC; tail: $(tail -n 8 "$OUT.txt")"; fi
PSQLD postgres -c 'drop event trigger pgrst_ddl_watch' -c 'drop function public.rh_noop()' >/dev/null
PSQLD postgres -c 'create function public.rh_dbl() returns void language plpgsql as $f$ begin perform dblink_exec('"'"'a'"'"', '"'"'b'"'"'); end $f$' >/dev/null
precheck pre_i
if [ "$RC" != 0 ] && [ "$DC" = 8 ] && grep -q '^ALERT  1 function(s) not owned by a supabase_' "$OUT.txt" && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then ok "D3: a function calling dblink is counted: STOP"; else bad "D3 dblink" "exit $RC, reads $DC; tail: $(tail -n 8 "$OUT.txt")"; fi
PSQLD postgres -c 'drop function public.rh_dbl()' >/dev/null

# S3: a failed login in the pre-check leaves the tombstone and blocks both scripts
precheck pre_e "$PW_R"
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && [ -f "$ROOT/s0b/FAILED-LOGIN" ] && [ "$(lastline)" = "S0B PRECHECK STOP" ]; then ok "S3: a wrong production password in the pre-check stops after one read and writes the FAILED-LOGIN tombstone"; else bad "pre-check failed login" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
precheck pre_f
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: a previous run failed a login' "$OUT.txt"; then ok "S3: the pre-check refuses to run while the tombstone exists (0 reads)"; else bad "pre-check tombstone block" "exit $RC, reads $DC"; fi
mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.precheck"

CUR=secrets
leak=0
for s in "$PW_P" "$PW_R" "$TOKEN"; do if grep -rqF -- "$s" "$W"/*.out "$W"/*.out.txt 2>/dev/null; then leak=1; fi; done
[ "$leak" = 0 ] && ok "no password and no access token appears in any transcript" || bad "a secret appears in a transcript"
if grep -rqF -- "$PW_P" "$ROOT"/s0b-validate.* "$ROOT"/s0b-precheck.* 2>/dev/null || grep -rqF -- "$TOKEN" "$ROOT"/s0b-validate.* "$ROOT"/s0b-precheck.* 2>/dev/null; then bad "a secret was written to a work directory"; else ok "no password and no token was written to any work directory"; fi
[ "$(ls "$ROOT" | grep -c '^s0b-validate\.')" -ge 11 ] && ok "every run used its own private work directory (mode 700): $(stat -f '%Lp' "$(ls -1dt "$ROOT"/s0b-validate.* | head -n 1)")" || bad "work directories"

echo; echo "steps: $pass ok, $fail FAIL"
cp "$ROOT/e2e-calls.log" "$W/calls.log" 2>/dev/null || true
[ "$fail" = 0 ]
