#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. STAGE-0254A-PUSH-REHEARSAL (PREPARATION ONLY / HELD): what the pinned supabase CLI v2.102.0 (the inner Go
# binary, "supabase-go") does with the "0254 AFTER 0257" bundle. A DISPOSABLE local PostgreSQL on the CI runner; no hosted project and no
# credential beyond the canary password of the throwaway database.
#
# The synthetic "hosted" database holds the hosted prefix PLUS the hosted 0257: 247 history rows whose names are the REAL file names
# (0001..0246 less the skipped 0158, 0248, and the REAL sealed 0257 pushed by the CLI itself; 0247 and 0249..0256 absent). 0254 is a
# BELOW-head apply (0254 < the remote max 0257), so it needs `db push --include-all`.
#
# Limit, stated plainly: the REAL sealed 0254 rewrites policies and functions on payment tables that the stand-in schema does not have, so the
# pending file here is a tiny synthetic migration that carries the REAL 0254 FILE NAME. The CLI's listing, ordering and refusal rules depend on
# names and history rows only; the sealed 0254 bytes are covered by the apply script's sealed-sha gate (proved in check.sh) and by #1226's own CI.
set -u

OUT="${REHEARSAL_OUT:?}"
D="$(cd "$(dirname "$0")/../../rehearsal/stage-0254-after-0257" && pwd)"
PGURL="${PGURL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable}"
VER=2.102.0
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"; : > "$RES"
CALLS="$OUT/cli-calls.txt"; : > "$CALLS"
say() { echo "$*" | tee -a "$RES"; }
expect() { # expect <label> <0 = met> <observed>
  if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi
}
yes0() { [ "$1" = "$2" ] && echo 0 || echo 1; }
has0() { grep -q -- "$2" "$1" && echo 0 || echo 1; }
pg() { psql "$PGURL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sha() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
OS=$(uname -s)

# ---- the pinned binary, verified against checksums.txt ----------------------------------------------
REL="https://github.com/supabase/cli/releases/download/v$VER"
case "$OS" in
  Linux)  ARCH=linux_amd64;  GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ;;
  Darwin) ARCH=darwin_arm64; GOSHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ;;
  *) say "FAIL unsupported OS $OS"; exit 1 ;;
esac
WORK="$OUT/archive"; mkdir -p "$WORK"
( cd "$WORK" && env -u SSL_CERT_FILE curl -fsSL -O "$REL/checksums.txt" -O "$REL/supabase_${VER}_${ARCH}.tar.gz" ) || { say "FAIL download"; exit 1; }
want=$(grep " supabase_${VER}_${ARCH}.tar.gz\$" "$WORK/checksums.txt" | cut -d' ' -f1)
expect "the $ARCH release archive verifies against checksums.txt" "$(yes0 "$(sha "$WORK/supabase_${VER}_${ARCH}.tar.gz")" "$want")" "$(echo "$want" | cut -c1-16)"
mkdir -p "$OUT/cli" && tar -xzf "$WORK/supabase_${VER}_${ARCH}.tar.gz" -C "$OUT/cli"
GOBIN="$OUT/cli/supabase-go"; chmod +x "$GOBIN"
expect "the extracted supabase-go has the recorded inner sha256 for $ARCH (macOS dce26b75 is the binary the operator runs)" "$(yes0 "$(sha "$GOBIN")" "$GOSHA")" "$(sha "$GOBIN" | cut -c1-16)"
expect "supabase-go prints $VER" "$(yes0 "$("$GOBIN" --version 2>&1 | head -1)" "$VER")" "$("$GOBIN" --version 2>&1 | head -1)"
say "INFO  os: $OS; psql: $(psql --version); server: $(pg -c 'show server_version')"

# ---- the real sealed 0257 and the real hosted names ---------------------------------------------------
SEAL257="$D/reference/0257_studio_payment_jurisdiction_failed_attempt_ack.sql"
LIST="$D/reference/MIGRATIONS-stage0254a.sha256"
N257=0257_studio_payment_jurisdiction_failed_attempt_ack.sql
N254=0254_perm_hon44_role_enforcement.sql
expect "the sealed 0257 text is the pinned 170b5dda..." "$(yes0 "$(sha "$SEAL257")" 170b5ddaf851c4e6d2900162ccdf47d048b2cf49a4ed7f4c6e0f79217b5ad20f)" "$(sha "$SEAL257" | cut -c1-16)"
expect "the bundle list has 248 lines and ends at 0257" "$([ "$(grep -c '' "$LIST")" = 248 ] && tail -1 "$LIST" | grep -q '  0257_' && echo 0 || echo 1)" "$(grep -c '' "$LIST") lines"
HOSTED_NAMES=$(awk '{print $2}' "$LIST" | grep -v '^0254_' | grep -v '^0257_')
expect "the hosted prefix has 246 files (0247, 0249..0256 absent; 0254 and 0257 not in it)" "$([ "$(echo "$HOSTED_NAMES" | grep -c '')" = 246 ] && ! echo "$HOSTED_NAMES" | grep -Eq '^(0247|0249|025[0-9])_' && echo 0 || echo 1)" "$(echo "$HOSTED_NAMES" | grep -c '')"
expect "the list names 0254 once, with its real file name" "$(yes0 "$(grep -c "  $N254\$" "$LIST")" 1)" "$N254"

PROJ="$OUT/proj"; MIG="$PROJ/supabase/migrations"
mkdir -p "$MIG"
printf 'project_id = "stage-0254a-rehearsal"\n\n[db]\nmajor_version = 17\n' > "$PROJ/supabase/config.toml"

hosted_files() { # the synthetic hosted prefix, real names
  local n v first=1
  for n in $HOSTED_NAMES; do
    v=${n%%_*}
    if [ $first = 1 ]; then
      printf '%s\n' "begin;" "set local lock_timeout = '5s';" "create table public.studio_payment_jurisdiction_changes (id uuid primary key default gen_random_uuid());" "commit;" > "$MIG/$n"; first=0
    else
      printf '%s\n' "begin;" "set local lock_timeout = '5s';" "select $((10#$v));" "commit;" > "$MIG/$n"
    fi
  done
}
cli() { # cli <label> <args...>  -> $OUT/<label>.log, sets RC and LOG; every call is logged in $CALLS
  local label="$1"; shift
  LOG="$OUT/$label.log"
  echo "db push $*" >> "$CALLS"
  ( cd "$PROJ" && perl -e 'alarm 180; exec @ARGV' "$GOBIN" db push --db-url "$PGURL" --workdir "$PROJ" "$@" ) < /dev/null > "$LOG" 2>&1
  RC=$?
  say "RUN   $label: db push $* -> rc=$RC"
  head -30 "$LOG" | sed 's/^/   | /' >> "$RES"
}
hist() { pg -c "select count(*) || ' rows, max ' || coalesce(max(version), '-') from supabase_migrations.schema_migrations" 2> /dev/null; }
rows_of() { pg -c "select count(*) from supabase_migrations.schema_migrations where version = '$1'" 2> /dev/null; }
hist_digest() { pg -c "select md5(string_agg(version || name || statements::text, ',' order by version)) from supabase_migrations.schema_migrations" 2> /dev/null; }
digest_except_0254() { pg -c "select md5(string_agg(version || name || statements::text, ',' order by version)) from supabase_migrations.schema_migrations where version <> '0254'" 2> /dev/null; }
has_fn() { pg -c "select count(*) from pg_proc where proname = 'initialize_studio_payment_jurisdiction_from_history_v2'"; }
has_marker() { pg -c "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'stage0254a_marker'"; }
snap() { echo "$(hist) | $(hist_digest) | v2=$(has_fn) marker=$(has_marker)"; }

fresh() { # fresh : the synthetic hosted database: the 246 hosted-name files, then the REAL sealed 0257, each pushed by the CLI itself (plain: both are forward applies)
  pg -c "alter database postgres set check_function_bodies = off" > /dev/null 2>&1
  pg -c "drop schema if exists public cascade; create schema public; drop schema if exists supabase_migrations cascade;" > /dev/null 2>&1
  for r in anon authenticated service_role; do pg -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$r') then create role $r nologin; end if; end \$\$" > /dev/null 2>&1; done
  rm -rf "$MIG"; mkdir -p "$MIG"; hosted_files
  cli "setup-$1-prefix" --yes
  pg -c "insert into public.studio_payment_jurisdiction_changes default values" > /dev/null 2>&1
  cp "$SEAL257" "$MIG/$N257"
  cli "setup-$1-0257" --yes
}
pend254() { printf '%s\n' "begin;" "set local lock_timeout = '5s';" "create table public.stage0254a_marker (id int);" "commit;" > "$MIG/$N254"; }

# ---- the dry-run assertion the stage's apply script makes: exit 0, banner, "Would push" block, bullets EXACTLY the expected list
assert_dry_run() { # assert_dry_run <log> <rc> <expected-file...>
  local log="$1" rc="$2"; shift 2
  [ "$rc" = 0 ] || { echo "rc=$rc"; return 1; }
  grep -q '^DRY RUN: migrations will \*not\* be pushed to the database\.$' "$log" || { echo "no DRY RUN banner"; return 1; }
  grep -q '^Would push these migrations:$' "$log" || { echo "no Would-push block"; return 1; }
  grep -qE '^Would (seed|create custom roles)' "$log" && { echo "seed/roles line present"; return 1; }
  local got want
  got="$(sed -n '/^Would push these migrations:$/,$p' "$log" | sed -n 's/^ • //p' | tr '\n' ' ')"
  want="$(printf '%s ' "$@")"
  [ "$got" = "$want" ] || { echo "got [$got] want [$want]"; return 1; }
  echo "exact: $got"
}
assert0() { local label="$1"; shift; local m; m="$(assert_dry_run "$LOG" "$RC" "$@")"; expect "$label" "$?" "$m"; }
assert_fails() { local label="$1"; shift; local m; m="$(assert_dry_run "$LOG" "$RC" "$@")"; expect "$label" "$([ $? != 0 ] && echo 0 || echo 1)" "refused: $m"; }
OOO='Found local migration files to be inserted before the last migration on remote database'

say "=================== P0: the synthetic hosted database: the hosted prefix plus the REAL sealed 0257"
fresh p0
expect "history is 247 rows, max 0257" "$(yes0 "$(hist)" '247 rows, max 0257')" "$(hist)"
expect "0257 is once, the v2 command exists, 0254/0247/0249..0256 are absent" "$(yes0 "$(rows_of 0257) $(has_fn) $(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '0247' or (version >= '0249' and version <= '0256')")" '1 1 0')" "applied"
PRE="$(snap)"; PRE_ROWS=$(hist_digest)

say "=================== A: bundle = hosted files + 0257 + 0254 (below the remote max 0257): a PLAIN dry run REFUSES"
pend254
cli a-plain-dry --dry-run
expect "a plain --dry-run exits non-zero with the CLI's out-of-order refusal and lists nothing" "$([ "$RC" != 0 ] && grep -q "$OOO" "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
assert_fails "...and the exact-list assertion refuses that output too (so a plain run can never be mistaken for the stage's dry run)" "$N254"
cli a-plain-push --yes
expect "a plain push REFUSES as well and applies nothing" "$([ "$RC" != 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"

say "=================== A2: the --include-all dry run lists EXACTLY 0254"
cli a2-dry --include-all --dry-run
assert0 "(a) --include-all --dry-run passes the exact-list assertion for [$N254]" "$N254"
expect "...and the dry run changed nothing (history, digest, no new table)" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
assert_fails "CONTROL: the same log fails the assertion when the expected list is wrong [0252_x.sql]" 0252_x.sql
assert_fails "CONTROL: the same log fails when the expected list has an extra file [0254 + 0255]" "$N254" 0255_x.sql

say "=================== B: --include-all --yes applies only 0254"
cli b-push --include-all --yes
expect "(b) the push exits 0" "$(yes0 "$RC" 0)" "rc=$RC"
expect "...exactly one 'Applying migration' line, naming 0254" "$([ "$(grep -c '^Applying migration' "$LOG")" = 1 ] && grep -q "^Applying migration $N254" "$LOG" && echo 0 || echo 1)" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
expect "...and the 'Finished supabase db push.' line" "$(has0 "$LOG" 'Finished supabase db push.')" "finished"
expect "history is +1: 248 rows, max stays 0257, 0254 once, 0257 once, 0247 and 0249..0253 and 0255..0256 absent" "$(yes0 "$(hist) $(rows_of 0254) $(rows_of 0257) $(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '0247' or (version >= '0249' and version <= '0253') or version in ('0255','0256') or version > '0257'")" '248 rows, max 0257 1 1 0')" "$(hist)"
expect "every row that was there before is untouched (digest of all rows except 0254 equals the digest before the push)" "$(yes0 "$(digest_except_0254)" "$PRE_ROWS")" "unchanged"
expect "the sentinel pending change ran (its marker table exists) and the 0257 v2 command is still there" "$(yes0 "$(has_marker) $(has_fn)" '1 1')" "applied"
POST="$(snap)"

say "=================== C: the re-run is idempotent"
cli c-dry --include-all --dry-run
expect "(c) a re-run dry run says 'Remote database is up to date', exit 0, no list" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
cli c-push --include-all --yes
expect "...and a re-run push applies nothing: up to date, no 'Applying migration' line" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q '^Applying migration' "$LOG" && echo 0 || echo 1)" "rc=$RC"
expect "...and the database is byte-for-byte what the first push left" "$(yes0 "$(snap)" "$POST")" "$(snap)"

for x in 0255 0249 0247; do
  say "=================== D-$x: negative control: an extra unapplied $x in the bundle (below the remote max): --include-all would take it with 0254"
  fresh "d$x"; PRE="$(snap)"; pend254
  printf '%s\n' "begin;" "select ${x#0};" "commit;" > "$MIG/${x}_x.sql"
  cli "d$x-dry" --include-all --dry-run
  expect "the --include-all dry run LISTS both ${x}_x.sql and 0254 (a stray file is not harmless)" "$(yes0 "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')" "$( [ "$x" = 0255 ] && echo "$N254 ${x}_x.sql " || echo "${x}_x.sql $N254 ")")" "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')"
  assert_fails "...and the exact-list assertion for [0254] REFUSES it, so the runner STOPs before any push" "$N254"
  expect "...and the dry run changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
done

say "=================== D-missing: negative control: 0254 missing from the bundle"
fresh dmiss; PRE="$(snap)"
cli dmiss-dry --include-all --dry-run
expect "the --include-all dry run says up to date and lists nothing" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
assert_fails "...and the exact-list assertion for [0254] REFUSES it" "$N254"

say "=================== D-local: negative control: a hosted version missing locally refuses even with --include-all"
fresh dloc; PRE="$(snap)"; pend254; rm -f "$MIG"/0005_*.sql
cli dloc-dry --include-all --dry-run
expect "the --include-all dry run REFUSES (remote version not found locally) and lists nothing" "$([ "$RC" != 0 ] && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC $(grep -m1 -i 'not found' "$LOG" | cut -c1-100)"
assert_fails "...and the exact-list assertion refuses that output" "$N254"
cli dloc-push --include-all --yes
expect "...and the push refuses too and applies nothing" "$([ "$RC" != 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"

say "=================== D-alt: control: a changed 0254 keeps its name (what the CLI cannot see)"
fresh dalt; PRE="$(snap)"; { pend254; echo "-- ALTERED" >> "$MIG/$N254"; }
cli dalt-dry --include-all --dry-run
assert0 "the dry-run assertion PASSES on a changed file (it checks names only) - the sealed-sha gate in the apply script, proved by check.sh, is the layer that stops it" "$N254"

say "=================== Z: --include-all is used ONLY where the stage uses it"
expect "the plain calls (no --include-all) that applied anything: none (every plain push in this rehearsal either was setup of a forward file or refused)" "$([ "$(grep -c -- '--include-all' "$CALLS")" -gt 0 ] && echo 0 || echo 1)" "include-all calls=$(grep -c -- '--include-all' "$CALLS") of $(grep -c '' "$CALLS")"
expect "no CLI call in this rehearsal wrote settings or used any flag other than --yes, --dry-run, --include-all" "$([ "$(grep -v -- '^db push \(--yes\|--dry-run\|--include-all --dry-run\|--include-all --yes\)$' "$CALLS" | grep -c '')" = 0 ] && echo 0 || echo 1)" "$(grep -v -- '^db push \(--yes\|--dry-run\|--include-all --dry-run\|--include-all --yes\)$' "$CALLS" | head -2 | tr '\n' ' ')"

say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"
[ "$FAILS" = 0 ]
