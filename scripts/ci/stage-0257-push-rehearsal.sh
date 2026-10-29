#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. STAGE-0257-PUSH-REHEARSAL: what the pinned supabase CLI v2.102.0 (the inner Go
# binary, "supabase-go") does with the 0257-only stage bundle. A DISPOSABLE local PostgreSQL on the CI runner;
# no hosted project and no credential beyond the canary password of the throwaway database.
#
# The synthetic "hosted" database holds exactly the hosted prefix: 246 history rows whose names are the REAL
# hosted file names (0001..0246 less the skipped 0158, plus 0248; 0247 absent), each a tiny synthetic migration,
# and a one-column stand-in for the one table 0257 alters. The pending file is the REAL sealed 0257 text
# (sha256 170b5dda...), so the plain push, the read-back queries and the read-back checker run on the real bytes.
#
# The bundle is the only control: it holds the hosted files and the sealed 0257, nothing else. NO --include-all
# is used by any plain-stage scenario (asserted at the end from a log of every CLI call).
set -u

OUT="${REHEARSAL_OUT:?}"
D="$(cd "$(dirname "$0")/../../rehearsal/stage-0257-online" && pwd)"
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

# ---- the real sealed file and the real hosted names ---------------------------------------------------
SEALED="$D/reference/0257_studio_payment_jurisdiction_failed_attempt_ack.sql"
LIST="$D/reference/MIGRATIONS-stage0257.sha256"
expect "the sealed 0257 text is the pinned 170b5dda..." "$(yes0 "$(sha "$SEALED")" 170b5ddaf851c4e6d2900162ccdf47d048b2cf49a4ed7f4c6e0f79217b5ad20f)" "$(sha "$SEALED" | cut -c1-16)"
expect "the bundle list has 247 lines and ends at 0257" "$([ "$(grep -c '' "$LIST")" = 247 ] && tail -1 "$LIST" | grep -q '  0257_' && echo 0 || echo 1)" "$(grep -c '' "$LIST") lines"
HOSTED_NAMES=$(awk '{print $2}' "$LIST" | grep -v '^0257_')
expect "the hosted prefix has 246 files (0247 and 0249..0256 absent)" "$([ "$(echo "$HOSTED_NAMES" | grep -c '')" = 246 ] && ! echo "$HOSTED_NAMES" | grep -Eq '^(0247|0249|025[0-6])_' && echo 0 || echo 1)" "$(echo "$HOSTED_NAMES" | grep -c '')"

PROJ="$OUT/proj"; MIG="$PROJ/supabase/migrations"
mkdir -p "$MIG"
printf 'project_id = "stage-0257-rehearsal"\n\n[db]\nmajor_version = 17\n' > "$PROJ/supabase/config.toml"

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
has_fn() { pg -c "select count(*) from pg_proc where proname = 'initialize_studio_payment_jurisdiction_from_history_v2'"; }
has_col() { pg -c "select count(*) from information_schema.columns where table_name = 'studio_payment_jurisdiction_changes' and column_name = 'failed_attempts_acknowledged'"; }
snap() { echo "$(hist) | $(hist_digest) | fn=$(has_fn) col=$(has_col)"; }

fresh() { # fresh : the synthetic hosted database: roles, then the 246 hosted-name files pushed by the CLI itself
  # The sealed 0257 declares a plpgsql function whose body names six tables the one-column stand-in schema does not have. The server validates plpgsql bodies at CREATE time,
  # so the DISPOSABLE database turns that validation off; the body itself is checked on the real chain by #1267's CI and, here, byte for byte by md5(prosrc).
  pg -c "alter database postgres set check_function_bodies = off" > /dev/null 2>&1
  pg -c "drop schema if exists public cascade; create schema public; drop schema if exists supabase_migrations cascade;" > /dev/null 2>&1
  for r in anon authenticated service_role; do pg -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$r') then create role $r nologin; end if; end \$\$" > /dev/null 2>&1; done
  rm -rf "$MIG"; mkdir -p "$MIG"; hosted_files
  cli "setup-$1" --yes
  pg -c "insert into public.studio_payment_jurisdiction_changes default values" > /dev/null 2>&1
}

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

SEALNAME=0257_studio_payment_jurisdiction_failed_attempt_ack.sql

say "=================== P0: the synthetic hosted database: exactly the hosted prefix"
fresh p0
expect "history is 246 rows, max 0248" "$(yes0 "$(hist)" '246 rows, max 0248')" "$(hist)"
expect "0247 and every version 0249..0257 are absent from the history" "$(yes0 "$(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '0247' or version >= '0249'")" 0)" "absent"
PRE="$(snap)"

say "=================== A: bundle = hosted files + sealed 0257: a PLAIN dry run lists ONLY 0257"
cp "$SEALED" "$MIG/$SEALNAME"
cli a-dry --dry-run
assert0 "(a) plain --dry-run passes the exact-list assertion for [$SEALNAME]" "$SEALNAME"
expect "...and the dry run changed nothing (history, digest, no v2 command, no new column)" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
assert_fails "CONTROL: the same log fails the assertion when the expected list is wrong [0252_x.sql]" 0252_x.sql
assert_fails "CONTROL: the same log fails when the expected list has an extra file [0257 + 0254]" "$SEALNAME" 0254_x.sql

say "=================== B: a PLAIN push applies it"
cli b-push --yes
expect "(b) the plain push exits 0" "$(yes0 "$RC" 0)" "rc=$RC"
expect "...exactly one 'Applying migration' line, naming 0257" "$([ "$(grep -c '^Applying migration' "$LOG")" = 1 ] && grep -q "^Applying migration $SEALNAME" "$LOG" && echo 0 || echo 1)" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
expect "...and the 'Finished supabase db push.' line" "$(has0 "$LOG" 'Finished supabase db push.')" "finished"
expect "history is +1: 247 rows, max 0257, 0257 exactly once, 0247 and 0249..0256 absent" "$(yes0 "$(hist) $(rows_of 0257) $(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '0247' or (version >= '0249' and version <= '0256')")" '247 rows, max 0257 1 0')" "$(hist)"
expect "the sentinel audit row survived with an empty acknowledgement" "$(yes0 "$(pg -c "select count(*) from public.studio_payment_jurisdiction_changes where failed_attempts_acknowledged = '{}'")" 1)" "row kept"

say "=================== B2: the REAL read-back queries and the REAL checker on the applied database"
RES_DIR="$OUT/readback"; rm -rf "$RES_DIR"; mkdir -p "$RES_DIR"
runq() { # runq <sql file> <result stem> : psql --csv -> JSON array of row objects (digit-only strings without a leading zero become numbers)
  psql "$PGURL" -X -q --csv -v ON_ERROR_STOP=1 -f "$1" 2> "$RES_DIR/$2.err" | python3 -I -c '
import csv, json, re, sys
rows = []
for r in csv.DictReader(sys.stdin):
    rows.append({k: (int(v) if re.fullmatch(r"0|[1-9][0-9]*", v) else v) for k, v in r.items()})
json.dump(rows, open(sys.argv[1], "w"))' "$RES_DIR/$2.json"
}
runq "$D/reads-s1/s1-history-0257.sql" s1-history-0257
runq "$D/reads-s1/c01_functions-exist.sql" c01_functions-exist
runq "$D/reads-s1/c02_function-bodies.sql" c02_function-bodies
runq "$D/reads-s1/c03_shape-and-grants.sql" c03_shape-and-grants
nonempty() { [ -s "$1" ] && [ "$(cat "$1")" != "[]" ] && echo 0 || echo 1; }
expect "the four read-back queries ran against the applied database and returned a row each" "$([ "$(nonempty "$RES_DIR/s1-history-0257.json")$(nonempty "$RES_DIR/c01_functions-exist.json")$(nonempty "$RES_DIR/c02_function-bodies.json")$(nonempty "$RES_DIR/c03_shape-and-grants.json")" = 0000 ] && echo 0 || echo 1)" "$(cat "$RES_DIR"/*.err | head -2 | tr '\n' ' ')"
PGMD5=$(pg -c "select md5(prosrc) from pg_proc where proname = 'initialize_studio_payment_jurisdiction_from_history_v2'")
SCRIPT_MD5=$(sed -n 's/^const BODY_MD5 = "\([0-9a-f]*\)";$/\1/p' "$D/reads-s1/window-s1read-0257.sh" | head -1)
say "INFO  PostgreSQL md5(prosrc) of the applied v2 command: $PGMD5; the read-back script's BODY_MD5: $SCRIPT_MD5"
expect "the v2 body md5 PostgreSQL computes from the applied file EQUALS the read-back script's pinned md5 (the one value that had only been derived from the file text)" "$(yes0 "$PGMD5" "$SCRIPT_MD5")" "$PGMD5"
sed -n "/^cat > \"\$TMPD\/check-0257.mjs\" <<'NODE'\$/,/^NODE\$/p" "$D/reads-s1/window-s1read-0257.sh" | sed '1d;$d' > "$OUT/check.mjs"
( A_RES="$RES_DIR" node "$OUT/check.mjs" ) > "$OUT/check.out" 2>&1; CRC=$?
sed 's/^/   | /' "$OUT/check.out" >> "$RES"
expect "the shipped read-back checker prints the exact OVERALL PASS line on the real applied database" "$([ $CRC = 0 ] && tail -1 "$OUT/check.out" | grep -Fxq 'OVERALL PASS (0257 read-back: history, 2 verify checks and the shape-and-grants proof; read-only, not a promotion)' && echo 0 || echo 1)" "rc=$CRC $(tail -1 "$OUT/check.out" | cut -c1-90)"
runq "$D/reads/g02-history-0257.sql" g02-history-0257
expect "the g02 history read now shows 247 rows, max 0257 (so it would NOT be mistaken for the 246-row pre-push state)" "$([ "$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))[0]; print(r["applied_count"], r["hosted_max"])' "$RES_DIR/g02-history-0257.json")" = "247 0257" ] && echo 0 || echo 1)" "$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))[0]; print(r["applied_count"], r["hosted_max"])' "$RES_DIR/g02-history-0257.json")"
POST="$(snap)"

say "=================== C: the re-run is idempotent"
cli c-dry --dry-run
expect "(c) a re-run dry run says 'Remote database is up to date', exit 0, no list" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
cli c-push --yes
expect "...and a re-run push applies nothing: up to date, no 'Applying migration' line" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q '^Applying migration' "$LOG" && echo 0 || echo 1)" "rc=$RC"
expect "...and the database is byte-for-byte what the first push left (history, digest, objects)" "$(yes0 "$(snap)" "$POST")" "$(snap)"

say "=================== D1: negative control: an extra 0254 in the bundle (pending, above the remote max)"
fresh d1; PRE="$(snap)"
cp "$SEALED" "$MIG/$SEALNAME"; printf '%s\n' "begin;" "select 254;" "commit;" > "$MIG/0254_x.sql"
cli d1-dry --dry-run
expect "the plain dry run LISTS both 0254 and 0257 (so a bundle with a stray file is not harmless)" "$(yes0 "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')" "0254_x.sql $SEALNAME ")" "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')"
assert_fails "...and the exact-list assertion for [0257] REFUSES it, so the runner STOPs before any push" "$SEALNAME"
expect "...and the dry run changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"

say "=================== D2: negative control: an extra 0247 in the bundle (below the remote max 0248)"
fresh d2; PRE="$(snap)"
cp "$SEALED" "$MIG/$SEALNAME"; printf '%s\n' "begin;" "select 247;" "commit;" > "$MIG/0247_x.sql"
cli d2-dry --dry-run
expect "a plain dry run REFUSES (the CLI's own out-of-order refusal); with no --include-all nothing can slip in" "$([ "$RC" != 0 ] && grep -q 'Found local migration files to be inserted before the last migration on remote database' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
assert_fails "...and the exact-list assertion refuses that output too" "$SEALNAME"
cli d2-push --yes
expect "a plain push REFUSES as well and applies nothing" "$([ "$RC" != 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"

say "=================== D3: negative control: 0257 missing from the bundle"
fresh d3; PRE="$(snap)"
cli d3-dry --dry-run
expect "the plain dry run says up to date and lists nothing" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
assert_fails "...and the exact-list assertion for [0257] REFUSES it" "$SEALNAME"

say "=================== D4: control: a changed sealed file keeps its name (what the CLI cannot see)"
fresh d4; PRE="$(snap)"
{ cat "$SEALED"; echo "-- ALTERED"; } > "$MIG/$SEALNAME"
cli d4-dry --dry-run
assert0 "the dry-run assertion PASSES on a changed file (it checks names only) - so the sealed-sha gate in the apply script, proved by check.sh, is the layer that stops it" "$SEALNAME"
expect "...and the changed bytes differ from the sealed sha" "$([ "$(sha "$MIG/$SEALNAME")" != 170b5ddaf851c4e6d2900162ccdf47d048b2cf49a4ed7f4c6e0f79217b5ad20f ] && echo 0 || echo 1)" "$(sha "$MIG/$SEALNAME" | cut -c1-16)"

say "=================== Z: no --include-all anywhere"
expect "none of the $(grep -c '' "$CALLS") CLI calls in this rehearsal used --include-all" "$([ "$(grep -c -- '--include-all' "$CALLS")" = 0 ] && echo 0 || echo 1)" "calls=$(grep -c '' "$CALLS")"

say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"
[ "$FAILS" = 0 ]
