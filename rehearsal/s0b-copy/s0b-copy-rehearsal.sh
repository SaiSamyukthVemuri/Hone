#!/bin/bash
# REHEARSAL - NEVER MERGE. S0B-COPY-POOLER (builds on the S0B-READS harness): the restored project reads through run-s0b-copy-read-macos.sh (aws-0), production through 471ecb9d (aws-1).
#   Extra PIN SUBSTITUTIONS in test copies only: SUPABASE_GO_SHA256 in the variant, COPY_SHA in validate, COPY_RUNNER_SHA in the comparator. Base harness: S0B-READS on macOS arm64 (macos-14): the PRE-RESTORE check and the VALIDATION script against two synthetic databases.
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
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$PKG/run-s0b-copy-read-macos.sh" > "$ROOT/s0b/run-s0b-copy-read-macos.sh"; chmod 0755 "$ROOT/s0b/run-s0b-copy-read-macos.sh"
VSHA=$(sha "$ROOT/s0b/run-s0b-copy-read-macos.sh")
for f in "$PKG"/p*.sql "$PKG"/v*.sql "$PKG/MANIFEST.sha256"; do cp "$f" "$ROOT/s0b/"; done
sed -E -e "s/^export const RUNNER_SHA = \"[0-9a-f]{64}\";/export const RUNNER_SHA = \"$RSHA\";/" -e "s/^export const COPY_RUNNER_SHA = \"[0-9a-f]{64}\";/export const COPY_RUNNER_SHA = \"$VSHA\";/" "$PKG/s0b-compare.mjs" > "$ROOT/s0b/s0b-compare.mjs"
CSHA=$(sha "$ROOT/s0b/s0b-compare.mjs")
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^CMP_SHA=.*/CMP_SHA=$CSHA/" -e "s/^COPY_SHA=[0-9a-f]*/COPY_SHA=$VSHA/" "$PKG/s0b-validate.sh" > "$ROOT/_e2e/s0b-validate.sh"
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$PKG/s0b-precheck.sh" > "$ROOT/_e2e/s0b-precheck.sh"
chmod 0755 "$ROOT/_e2e/s0b-validate.sh" "$ROOT/_e2e/s0b-precheck.sh"; chmod 0755 "$ROOT" "$ROOT/s0b"
chk() { # chk REAL TEST PATTERN
  local d; d=$(diff "$1" "$2" | grep '^[<>]' | grep -Ev "$3" | wc -l | tr -d ' ')
  [ "$d" = 0 ] && ok "test copy of $(basename "$1") differs from the package only on its pin lines" || bad "test copy of $(basename "$1") differs elsewhere"
}
chk "$PKG/run-window-read-macos.sh" "$ROOT/s0b/run-window-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
chk "$PKG/s0b-compare.mjs" "$ROOT/s0b/s0b-compare.mjs" '^[<>] export const (RUNNER_SHA|COPY_RUNNER_SHA) ='
chk "$PKG/s0b-validate.sh" "$ROOT/_e2e/s0b-validate.sh" '^[<>] (GO_SHA|RUNNER_SHA|CMP_SHA|COPY_SHA)='
chk "$PKG/run-s0b-copy-read-macos.sh" "$ROOT/s0b/run-s0b-copy-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
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


# ---------------------------------------------------------------------------------------------------------------------
CUR=pooler
RUNDIR=$(ls -1dt "$ROOT"/s0b-validate.* | head -n 1)
[ "$(cat "$RUNDIR/link-rest/supabase/.temp/pooler-url")" = "postgresql://postgres.$RREF@aws-0-us-east-1.pooler.supabase.com:5432/postgres" ] && [ "$(cat "$RUNDIR/link-prod/supabase/.temp/pooler-url")" = "postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres" ] \
  && ok "the restored link carries the aws-0 pooler URL and the production link keeps aws-1 (byte-exact, no trailing newline)" || bad "pooler urls in the run dir"
grep -q 'session pooler host is exactly aws-0-us-east-1.pooler.supabase.com' "$W/pass.out.txt" && ! grep -q 'host is exactly aws-1' "$W/pass.out.txt" && ok "the PHOST prompt names aws-0-us-east-1 for the RESTORED project" || bad "PHOST prompt text"
ok_runners=1
for d in rest restfar; do [ -f "$RUNDIR/$d/gen/run-s0b-copy-read-macos.sh" ] && [ ! -e "$RUNDIR/$d/gen/run-window-read-macos.sh" ] && [ "$(sha "$RUNDIR/$d/gen/run-s0b-copy-read-macos.sh")" = "$VSHA" ] && ! grep -v "\"runner_sha256\":\"$VSHA\"" "$RUNDIR/$d/res/"*.meta.json | grep -q . || ok_runners=0; done
[ -f "$RUNDIR/prod/gen/run-window-read-macos.sh" ] && [ ! -e "$RUNDIR/prod/gen/run-s0b-copy-read-macos.sh" ] && [ "$(sha "$RUNDIR/prod/gen/run-window-read-macos.sh")" = "$RSHA" ] && ! grep -v "\"runner_sha256\":\"$RSHA\"" "$RUNDIR/prod/res/"*.meta.json | grep -q . || ok_runners=0
[ "$ok_runners" = 1 ] && ok "rest and restfar ran with the variant (gen copy and every sidecar), production with 471ecb9d-equivalent (gen copy and every sidecar)" || bad "which runner each run dir carries"

# no credential prompt before the host yes
{
  printf 'Recovery timestamp T you gave the restore\t%s\n' "$T"; printf 'Project ref of the RESTORED\t%s\n' "$RREF"; printf 'Type the last 4 characters of the RESTORED project ref\t%s\n' "${RREF: -4}"
  printf "Type yes only if the restored project's session pooler host\tno\n"
  printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'RESTORED project database password\t%s\n' "$PW_R"; printf 'PRODUCTION database password\t%s\n' "$PW_P"
} > "$W/phostno.ans"
C0=$(calls); drive phostno "$W/phostno.ans" "$ROOT/_e2e/s0b-validate.sh"; DC=$(( $(calls) - C0 ))
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: restored pooler host not confirmed' "$OUT.txt" && ! grep -qE 'Supabase access token|database password' "$OUT.txt"; then ok "answering no to the host question stops with 0 reads and no credential prompt was ever shown"; else bad "PHOST no" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi

# swapped runners inside validate (mutated test copies of validate only)
mutate() { sed -e "$2" "$ROOT/_e2e/s0b-validate.sh" > "$ROOT/_e2e/$1.sh"; chmod 0755 "$ROOT/_e2e/$1.sh"; }
vm() { # vm NAME SCRIPT
  RC=0; { printf 'Recovery timestamp T you gave the restore\t%s\n' "$T"; printf 'Project ref of the RESTORED\t%s\n' "$RREF"; printf 'Type the last 4 characters of the RESTORED project ref\t%s\n' "${RREF: -4}"; printf "Type yes only if the restored project's session pooler host\tyes\n"; printf 'Type yes: the restored project is a NEW project\tyes\n'; printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'RESTORED project database password\t%s\n' "$PW_R"; printf 'PRODUCTION database password\t%s\n' "$PW_P"; } > "$W/$1.ans"
  C0=$(calls); drive "$1" "$W/$1.ans" "$ROOT/_e2e/$2.sh"; DC=$(( $(calls) - C0 )); }
grep -c 'if \[ "\$name" != prod \]; then rn=' "$ROOT/_e2e/s0b-validate.sh" | grep -qx 1 || bad "the runner-choice line is not where the mutation expects it"
mutate mut_all_swapped 's/if \[ "\$name" != prod \]; then rn=/if [ "$name" = prod ]; then rn=/'
vm swapped_all mut_all_swapped
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && ! grep -qx 'S0B PASS' "$OUT.txt" && grep -q 'STOP: rest v1-history.sql failed' "$OUT.txt"; then ok "validate with the runners swapped (restored via 471ecb9d, production via the variant): STOP at the first restored read, 0 database reads (471ecb9d refuses aws-0)"; else bad "swapped runners" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
mutate mut_prod_variant 's/if \[ "\$name" != prod \]; then rn=/if true; then rn=/'
vm prod_variant mut_prod_variant
if [ "$RC" != 0 ] && [ "$DC" = 12 ] && ! grep -qx 'S0B PASS' "$OUT.txt" && grep -q 'STOP: prod v1-history.sql failed' "$OUT.txt" && grep -rq 'never reads the production project' "$(ls -1dt "$ROOT"/s0b-validate.* | head -n 1)/logs"; then ok "production forced onto the variant: the 12 restored reads succeed, the first production read is REFUSED by the variant ('never reads the production project'), STOP, no verdict"; else bad "production on the variant" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
PASSRUN=$(ls -1dt "$ROOT"/s0b-validate.* | sed -n 1p)

# comparator-level swap on real captured run directories
RUNOK="$RUNDIR"
node "$ROOT/s0b/s0b-compare.mjs" --templates "$ROOT/s0b" --t "$T" --prod "$RUNOK/prod" --rest "$RUNOK/rest" --rest-far "$RUNOK/restfar" > "$W/cmp-ok.txt" 2>&1; [ "$(tail -n 1 "$W/cmp-ok.txt")" = "S0B PASS" ] && ok "control: the comparator on the real captured dirs prints S0B PASS" || bad "comparator control" "$(tail -n 3 "$W/cmp-ok.txt")"
SW="$W/swapdirs"; rm -rf "$SW"; mkdir -p "$SW"; cp -R "$RUNOK/prod" "$SW/prod"; cp -R "$RUNOK/rest" "$SW/rest"; cp -R "$RUNOK/restfar" "$SW/restfar"
rm "$SW/prod/gen/run-window-read-macos.sh"; cp "$ROOT/s0b/run-s0b-copy-read-macos.sh" "$SW/prod/gen/"
rc=0; node "$ROOT/s0b/s0b-compare.mjs" --templates "$ROOT/s0b" --t "$T" --prod "$SW/prod" --rest "$SW/rest" --rest-far "$SW/restfar" > "$W/cmp-swap1.txt" 2>&1 || rc=$?
[ "$rc" != 0 ] && grep -q '^S0B FAIL: production@T gen: unexpected contents' "$W/cmp-swap1.txt" && ! grep -qx 'S0B PASS' "$W/cmp-swap1.txt" && ok "comparator: the production dir carrying the variant fails ($(tail -n 1 "$W/cmp-swap1.txt" | cut -c1-90))" || bad "comparator swap (prod has variant)" "$(tail -n 2 "$W/cmp-swap1.txt")"
cp -R "$RUNOK/prod" "$SW/prod2"; cp -R "$RUNOK/rest" "$SW/rest2"
rm "$SW/rest2/gen/run-s0b-copy-read-macos.sh"; cp "$ROOT/s0b/run-window-read-macos.sh" "$SW/rest2/gen/"
rc=0; node "$ROOT/s0b/s0b-compare.mjs" --templates "$ROOT/s0b" --t "$T" --prod "$SW/prod2" --rest "$SW/rest2" --rest-far "$SW/restfar" > "$W/cmp-swap2.txt" 2>&1 || rc=$?
[ "$rc" != 0 ] && grep -q '^S0B FAIL: restored@T gen: unexpected contents' "$W/cmp-swap2.txt" && ok "comparator: the restored dir carrying 471ecb9d fails ($(tail -n 1 "$W/cmp-swap2.txt" | cut -c1-90))" || bad "comparator swap (rest has classic)" "$(tail -n 2 "$W/cmp-swap2.txt")"

# the runners themselves: a matrix of pooler URLs (test copies: only the supabase-go pin differs)
CUR=runner-matrix
RM="$ROOT/s0b-rm"; mkdir -p "$RM/gen" "$RM/res"; chmod 0755 "$RM"
printf 'select 1 as x\n' > "$RM/gen/t.sql"; printf '%s  t.sql\n' "$(sha "$RM/gen/t.sql")" > "$RM/gen/MANIFEST.sha256"
cp "$ROOT/s0b/run-s0b-copy-read-macos.sh" "$ROOT/s0b/run-window-read-macos.sh" "$RM/gen/"
LINK="$RM/link"
rcase() { # rcase NAME RUNNER REF URL_PRINTF_FORMAT PW EXPECT(ok|refused) [GREP]
  local name=$1 runner=$2 ref=$3 url=$4 pw=$5 want=$6 pat=${7:-}
  rm -rf "$LINK" "$RM/res"; mkdir -p "$LINK/supabase/.temp" "$RM/res"
  printf '%s\n' "$ref" > "$LINK/supabase/.temp/project-ref"; printf "$url" "$ref" > "$LINK/supabase/.temp/pooler-url"; printf 'v2.102.0\n' > "$LINK/supabase/.temp/cli-latest"
  local C1 rc=0; C1=$(calls)
  ( cd "$LINK" && env -i PATH="$SAFEPATH" HOME="$H" HONE_WINDOW_PROJECT_REF="$ref" HONE_SUPABASE_BIN="$ROOT/supabase-cli/supabase-go" HONE_WINDOW_RESULT_DIR="$RM/res" SUPABASE_ACCESS_TOKEN="$TOKEN" SUPABASE_DB_PASSWORD="$pw" /bin/bash "$RM/gen/$runner" t.sql ) </dev/null > "$W/rm-$name.out" 2> "$W/rm-$name.err" || rc=$?
  local d=$(( $(calls) - C1 ))
  if [ "$want" = ok ]; then
    local own; own=$(sha "$RM/gen/$runner")
    if [ "$rc" = 0 ] && [ "$d" = 1 ] && grep -q "\"runner_sha256\":\"$own\"" "$RM/res/t.meta.json"; then ok "runner $name: accepted, 1 read, sidecar runner_sha256 is the runner's own hash"; else bad "runner $name" "exit $rc reads $d: $(tail -n 3 "$W/rm-$name.err")"; fi
  else
    if [ "$rc" = 2 ] && [ "$d" = 0 ] && grep -q 'REFUSED' "$W/rm-$name.err" && { [ -z "$pat" ] || grep -q "$pat" "$W/rm-$name.err"; }; then ok "runner $name: REFUSED (exit 2, 0 reads)${pat:+ - $pat}"; else bad "runner $name" "exit $rc reads $d: $(tail -n 3 "$W/rm-$name.err")"; fi
  fi
}
V=run-s0b-copy-read-macos.sh; C=run-window-read-macos.sh
A0='postgresql://postgres.%s@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
A1='postgresql://postgres.%s@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
rcase variant_copy_aws0              $V "$RREF" "$A0" "$PW_R" ok
rcase variant_copy_aws0_newline      $V "$RREF" "$A0\n" "$PW_R" ok
rcase variant_copy_aws0_space        $V "$RREF" "$A0 " "$PW_R" ok
rcase variant_copy_postgres_scheme   $V "$RREF" 'postgres://postgres.%s@aws-0-us-east-1.pooler.supabase.com:5432/postgres' "$PW_R" ok
rcase variant_prod_ref_aws0          $V "$REF"  "$A0" "$PW_P" refused 'never reads the production project'
rcase variant_prod_ref_aws1          $V "$REF"  "$A1" "$PW_P" refused 'never reads the production project'
rcase variant_copy_aws1              $V "$RREF" "$A1" "$PW_R" refused 'not exactly the aws-0-us-east-1 session pooler'
rcase variant_copy_aws0_port6543     $V "$RREF" 'postgresql://postgres.%s@aws-0-us-east-1.pooler.supabase.com:6543/postgres' "$PW_R" refused 'not exactly the aws-0'
rcase variant_copy_aws0_other_region $V "$RREF" 'postgresql://postgres.%s@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' "$PW_R" refused 'not exactly the aws-0'
rcase variant_copy_aws0_password_in_url $V "$RREF" 'postgresql://postgres.%s:hunter2@aws-0-us-east-1.pooler.supabase.com:5432/postgres' "$PW_R" refused 'not exactly the aws-0'
rcase variant_copy_aws0_wrong_user   $V "$RREF" 'postgresql://postgres@aws-0-us-east-1.pooler.supabase.com:5432/postgres%.0s' "$PW_R" refused 'not exactly the aws-0'
rcase variant_copy_aws0_other_db     $V "$RREF" 'postgresql://postgres.%s@aws-0-us-east-1.pooler.supabase.com:5432/other' "$PW_R" refused 'not exactly the aws-0'
rcase variant_no_password            $V "$RREF" "$A0" "" refused 'SUPABASE_DB_PASSWORD is not set'
rcase classic_prod_aws1              $C "$REF"  "$A1" "$PW_P" ok
rcase classic_prod_aws1_newline      $C "$REF"  "$A1\n" "$PW_P" ok
rcase classic_prod_aws0              $C "$REF"  "$A0" "$PW_P" refused 'not exactly the aws-1-us-east-1 session pooler'
rcase classic_copy_aws0              $C "$RREF" "$A0" "$PW_R" refused 'not exactly the aws-1-us-east-1 session pooler'
[ "$(sha "$PKG/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "471ecb9d is still byte-identical in the package copy" || bad "471ecb9d changed"

# ------------------------------------------------------------------ S0B-EMPTY-TABLE: a genuinely empty table, end to end
CUR=empty-table
{ cat "$HERE/lib.sql"; echo "delete from public.appointment_payments;"; } | PSQLD postgres > "$W/prod-empty.log" 2>&1 && [ "$(PSQLD postgres -c 'select count(*) from public.appointment_payments')" = 0 ] && ok "production's appointment_payments is now genuinely empty (v5/v7 will return no row for it)" || bad "emptying production" "$(tail -n 3 "$W/prod-empty.log")"
mk_restored r_emptyok
MUT r_emptyok "delete from public.appointment_payments;"
validate emptyok "$T" "$RREF" "$PW_P" "$PW_R"
if [ "$RC" = 0 ] && grep -qx 'S0B PASS' "$OUT.txt" && [ "$DC" = 20 ] && grep -q '^PASS  S0B-4 .*(appointment_payments: empty in all three reads, corroborated by per-studio 0 and the catalog)$' "$OUT.txt" && grep -q '^PASS  S0B-7 .*(appointment_payments: empty in all three reads, corroborated by per-studio 0 and the catalog)$' "$OUT.txt"; then
  ok "END TO END: appointment_payments empty in production and the restored copy: S0B PASS, 20 reads, and the S0B-4 and S0B-7 pass lines name it as empty and corroborated"
else bad "empty table end to end" "exit $RC, reads $DC; tail: $(tail -n 12 "$OUT.txt")"; fi
grep -E '^PASS  S0B-[47] ' "$OUT.txt" | sed 's/^/       /'
EMPTYRUN=$(ls -1dt "$ROOT"/s0b-validate.* | head -n 1)
[ ! -s "$EMPTYRUN/prod/res/v5-recovery-point.json" ] || node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.some(x=>x.table_name==="appointment_payments")?1:0)' "$EMPTYRUN/prod/res/v5-recovery-point.json" && ok "the captured production v5 result really has no appointment_payments row" || bad "v5 still has the row"
mk_restored r_emptypartial
validate emptypartial "$T" "$RREF" "$PW_P" "$PW_R"
expect_fail "production empty but the restored copy still holds payments" '^S0B FAIL: appointment_payments: an id digest is present in restored@T only' 20

CUR=secrets
leak=0
for s in "$PW_P" "$PW_R" "$TOKEN"; do if grep -rqF -- "$s" "$W"/*.out "$W"/*.out.txt 2>/dev/null; then leak=1; fi; done
[ "$leak" = 0 ] && ok "no password and no access token appears in any transcript" || bad "a secret appears in a transcript"
echo; echo "steps: $pass ok, $fail FAIL"
cp "$ROOT/e2e-calls.log" "$W/calls.log" 2>/dev/null || true
[ "$fail" = 0 ]
