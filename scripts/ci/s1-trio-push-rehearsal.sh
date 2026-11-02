#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. S1-TRIO-PUSH-REHEARSAL (PREPARATION ONLY / HELD): ONE group stage, ONE plain push of several files: what the pinned supabase CLI v2.102.0 (the inner Go binary, "supabase-go")
# does with each step's bundle of a multi-stage package built by rehearsal/multi-stage/build.py. A DISPOSABLE local PostgreSQL on the CI runner; no hosted project
# and no credential beyond the canary password of the throwaway database.
#
# The synthetic "hosted" database holds the hosted set (the repository's migration file NAMES, 0247 absent) after the CLI itself pushed it. Then, per step k of the
# ordered list, the REAL bundle tar of that step is extracted and the CLI is run exactly as the stage's apply script runs it (plain, or --include-all for a step
# below the hosted max), and the result is checked against the step's EXPECT.json (rows, max, md5 of the sorted version list).
#
# Limit, stated plainly: the REAL sealed migration bodies rewrite objects the stand-in database does not have, so the pending file of each step is a tiny synthetic
# migration that carries the REAL file name (placeholder steps have synthetic bodies anyway). The CLI's listing, ordering and refusal rules depend on names and history
# rows only; the sealed bytes are covered by the apply script's sealed-sha gate (seq-check.sh) and by each migration's own CI.
# usage: multi-stage-push-rehearsal.sh PKGDIR [SEQUENCE]   (REHEARSAL_OUT = log directory, PGURL = the throwaway database; env ONLY_A=1 skips the negative controls)
set -u

PKG="${1:?PKGDIR}"
SEQ="${2:-full}"
OUT="${REHEARSAL_OUT:?}"
PGURL="${PGURL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable}"
VER=2.102.0
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"; : > "$RES"
CALLS="$OUT/cli-calls.txt"; : > "$CALLS"
say() { echo "$*" | tee -a "$RES"; }
expect() { if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi; }
yes0() { [ "$1" = "$2" ] && echo 0 || echo 1; }
pg() { psql "$PGURL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sha() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
pj() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "$1" "$2"; }
OS=$(uname -s)
# A failed read of the plan (a missing PLAN.json, a typo in the sequence name, a plan without a stage list) is NOT an empty sequence: it stops here with a FAIL,
# so only a sequence that really lists no stage reaches the no-op below.
STAGES=$(pj "$PKG/PLAN.json" '" ".join(d["sequences"]["'"$SEQ"'"]["stages"])' 2> "$OUT/plan-read.err") || { say "FAIL  could not read the stage list of sequence '$SEQ' from $PKG/PLAN.json: $(tail -1 "$OUT/plan-read.err")"; exit 1; }
ex() { pj "$PKG/$1/EXPECT.json" "$2"; }
# an empty sequence (every step dropped) applies nothing: there is no first stage, no bundle to build the synthetic hosted database from and no root EXPECT.json to read.
# It is an explicit no-op, decided before anything else touches a stage or downloads the CLI.
if [ -z "$STAGES" ]; then
  say "SKIP  sequence $SEQ has no stages (every step dropped): nothing to apply, so there is no bundle to reset from and no stage to read; the hosted history stays as it is"
  say "=================== RESULT: 0 passed, 0 failed (empty sequence, nothing run)"
  exit 0
fi

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
expect "the extracted supabase-go has the recorded inner sha256 for $ARCH" "$(yes0 "$(sha "$GOBIN")" "$GOSHA")" "$(sha "$GOBIN" | cut -c1-16)"
expect "supabase-go prints $VER" "$(yes0 "$("$GOBIN" --version 2>&1 | head -1)" "$VER")" "$("$GOBIN" --version 2>&1 | head -1)"
say "INFO  os: $OS; psql: $(psql --version); server: $(pg -c 'show server_version')"

PROJ="$OUT/proj"; MIG="$PROJ/supabase/migrations"
mkdir -p "$MIG"
printf 'project_id = "multi-stage-rehearsal"\n\n[db]\nmajor_version = 17\n' > "$PROJ/supabase/config.toml"
FIRST=$(echo $STAGES | cut -d' ' -f1)
# the hosted set = the first step's bundle minus the first step's migration
MEMBERS=$(ex "$FIRST" '" ".join(d["migrations"])')
FIRSTMIG=$(echo $MEMBERS | cut -d' ' -f1)

cli() { # cli <label> <args...>  -> $OUT/<label>.log, sets RC and LOG
  local label="$1"; shift
  LOG="$OUT/$label.log"
  echo "db push $*" >> "$CALLS"
  ( cd "$PROJ" && perl -e 'alarm 180; exec @ARGV' "$GOBIN" db push --db-url "$PGURL" --workdir "$PROJ" "$@" ) < /dev/null > "$LOG" 2>&1
  RC=$?
  say "RUN   $label: db push $* -> rc=$RC"
  head -30 "$LOG" | sed 's/^/   | /' >> "$RES"
}
hist() { pg -c "select count(*) || ' rows, max ' || coalesce(max(version), '-') from supabase_migrations.schema_migrations" 2> /dev/null; }
hmd5() { pg -c "select md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations" 2> /dev/null; }
hrows() { pg -c "select count(*) from supabase_migrations.schema_migrations" 2> /dev/null; }
hmax() { pg -c "select max(version) from supabase_migrations.schema_migrations" 2> /dev/null; }
snap() { echo "$(hrows) $(hmax) $(hmd5)"; }
is_state() { # is_state STAGE before|after
  [ "$(hrows)" = "$(ex $1 "d['history_$2']['rows']")" ] && [ "$(hmax)" = "$(ex $1 "d['history_$2']['max']")" ] && [ "$(hmd5)" = "$(ex $1 "d['history_$2']['list_md5']")" ]
}
bundle() { # bundle STAGE : the stage's REAL bundle tar extracted; every pending member replaced by a synthetic body with the same name
  rm -rf "$PROJ/supabase/migrations"; mkdir -p "$PROJ"
  tar -xf "$PKG/$1/s1-apply-$1-online/migrations-stage$1.tar" -C "$PROJ"
  local m v
  for m in $MEMBERS; do v=${m:0:4}
    [ -f "$MIG/$m" ] && printf '%s\n' "begin;" "set local lock_timeout = '5s';" "create table public.ms_marker_$v (id int);" "commit;" > "$MIG/$m"
  done
}
reset_hosted() { # a fresh synthetic hosted database holding the 249 hosted versions (the CLI itself applies them)
  pg -c "alter database postgres set check_function_bodies = off" > /dev/null 2>&1
  pg -c "drop schema if exists public cascade; create schema public; drop schema if exists supabase_migrations cascade;" > /dev/null 2>&1
  bundle "$FIRST"; local m; for m in $MEMBERS; do rm -f "$MIG/$m"; done
  for f in "$MIG"/*.sql; do printf '%s\n' "begin;" "set local lock_timeout = '5s';" "select 1;" "commit;" > "$f"; done
  cli "setup-hosted" --yes
}
assert_dry_run() { # assert_dry_run <log> <rc> <expected-file...>   (the stage's own dry-run assertion)
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

S=$FIRST
N=$(echo $MEMBERS | wc -w | tr -d ' ')
say "=================== A: the hosted set, then the ONE plain push of the $N members in numeric order"
reset_hosted
expect "the synthetic hosted database is the planned start: $(ex $S "d['history_before']['rows']") rows, max $(ex $S "d['history_before']['max']"), version-set md5 as planned" "$(is_state "$S" before && echo 0 || echo 1)" "$(snap)"
bundle "$S"; PRE="$(snap)"
cli a-dry --dry-run
assert0 "the dry run lists EXACTLY [$MEMBERS], in this order, and nothing else" $MEMBERS
expect "...and the dry run changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
cli a-push --yes
expect "the push exits 0, logs $N 'Applying migration' lines naming the members in order, and the finish line" "$([ "$RC" = 0 ] && [ "$(grep -c '^Applying migration' "$LOG")" = "$N" ] && [ "$(sed -n 's/^Applying migration \([0-9]*_[A-Za-z0-9_]*\.sql\)\.\.\.$/\1/p' "$LOG" | tr '\n' ' ')" = "$(printf '%s ' $MEMBERS)" ] && grep -q 'Finished supabase db push.' "$LOG" && echo 0 || echo 1)" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
cnt=0; for m in $MEMBERS; do cnt=$((cnt + $(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '${m:0:4}'"))); done
expect "history $(ex $S "d['history_after']['rows']") rows, max $(ex $S "d['history_after']['max']"), each member once, version-set md5 as planned" "$(is_state "$S" after && [ "$cnt" = "$N" ] && echo 0 || echo 1)" "$(snap)"
POST="$(snap)"
cli a-rerun --dry-run
expect "a re-run is idempotent ('Remote database is up to date', no list)" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
expect "...and nothing moved" "$(yes0 "$(snap)" "$POST")" "$(snap)"
if [ "${ONLY_A:-0}" = 1 ]; then say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"; [ "$FAILS" = 0 ]; exit; fi

say "=================== B1: a stray BELOW the hosted max: the plain push refuses the whole bundle and applies nothing"
reset_hosted; bundle "$S"; PRE="$(snap)"; printf '%s\n' "begin;" "select 255;" "commit;" > "$MIG/0255_stray.sql"
cli b1-dry --dry-run
expect "the plain dry run REFUSES (rc != 0) and lists nothing" "$([ "$RC" != 0 ] && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
cli b1-push --yes
expect "...and the plain push refuses too and applies nothing" "$([ "$RC" != 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"
say "=================== B2: a stray ABOVE the hosted max is listed, and the stage's exact-list assertion refuses it"
reset_hosted; bundle "$S"; PRE="$(snap)"; printf '%s\n' "begin;" "select 273;" "commit;" > "$MIG/0273_stray.sql"
cli b2-dry --dry-run
assert_fails "the dry run lists the stray as well, and the exact-list assertion for [$MEMBERS] REFUSES it" $MEMBERS
expect "...and the dry run changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
for m in $MEMBERS; do
  say "=================== B3: member $m missing from the bundle"
  reset_hosted; bundle "$S"; rm -f "$MIG/$m"; PRE="$(snap)"
  cli "b3-$m-dry" --dry-run
  assert_fails "the exact-list assertion REFUSES a dry run that lacks $m" $MEMBERS
done
say "=================== B4: a hosted version missing from the bundle refuses the plain push"
reset_hosted; bundle "$S"; rm -f "$MIG"/0005_*.sql; PRE="$(snap)"
cli b4-dry --dry-run
expect "the dry run REFUSES or lists something other than the members (so the assertion refuses)" "$([ "$RC" != 0 ] && echo 0 || { assert_dry_run "$LOG" "$RC" $MEMBERS > /dev/null && echo 1 || echo 0; })" "rc=$RC"
cli b4-push --yes
expect "...and the push applies nothing" "$([ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "$(snap)"
say "=================== B5: FAILURE INJECTED AT EACH MEMBER: the members before it stay applied, it does not, the re-run lists the rest"
k=0
for m in $MEMBERS; do
  k=$((k+1))
  reset_hosted; bundle "$S"; printf '%s\n' "begin;" "select 1/0;" "commit;" > "$MIG/$m"
  base=$(ex $S "d['history_before']['rows']"); want=$((base + k - 1))
  cli "b5-$k-push" --yes
  rest=$(echo $MEMBERS | cut -d' ' -f$k-)
  expect "failure at $m: the push FAILS (rc != 0); history is $want rows: the $((k-1)) member(s) before it applied, $m did not" "$([ "$RC" != 0 ] && [ "$(hrows)" = "$want" ] && [ "$(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '${m:0:4}'")" = 0 ] && echo 0 || echo 1)" "rc=$RC $(snap)"
  cli "b5-$k-rerun" --dry-run
  assert0 "...and a re-run lists exactly the rest [$rest]: the CLI could resume, but the stage must not (marker, read-back, new approval)" $rest
done
say "=================== Z: no --include-all anywhere in this rehearsal"
expect "no CLI call used --include-all" "$([ "$(grep -c -- '--include-all' "$CALLS")" = 0 ] && echo 0 || echo 1)" "$(grep -c -- '--include-all' "$CALLS") calls"
expect "the stage's apply script has no --include-all in its executable text" "$(grep -v '^ *#' "$PKG/$S/s1-apply-$S-online/s1-apply-$S-online.sh" | grep -Ev '^ *(echo|printf) ' | grep -q -- '--include-all' && echo 1 || echo 0)" "plain"
say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"
[ "$FAILS" = 0 ]
