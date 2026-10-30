#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. MULTI-STAGE-PUSH-REHEARSAL (PREPARATION ONLY / HELD): what the pinned supabase CLI v2.102.0 (the inner Go binary, "supabase-go")
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
STAGES=$(pj "$PKG/PLAN.json" '" ".join(d["sequences"]["'"$SEQ"'"]["stages"])')
ex() { pj "$PKG/$1/EXPECT.json" "$2"; }

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
FIRSTMIG=$(ex "$FIRST" 'd["migration"]')

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
bundle() { # bundle STAGE : the step's REAL bundle tar extracted; the pending file replaced by a synthetic body with the same name
  rm -rf "$PROJ/supabase/migrations"; mkdir -p "$PROJ"
  tar -xf "$PKG/$1/s1-apply-$1-online/migrations-stage$1.tar" -C "$PROJ"
  # every step migration in the bundle gets a synthetic body with its real name (the sealed bodies need objects the stand-in does not have)
  local S2 m v
  for S2 in $STAGES; do
    m=$(ex "$S2" 'd["migration"]'); v=${m:0:4}
    [ -f "$MIG/$m" ] && printf '%s\n' "begin;" "set local lock_timeout = '5s';" "create table public.ms_marker_$v (id int);" "commit;" > "$MIG/$m"
  done
}
reset_to() { # reset_to N : a fresh synthetic hosted database, then steps 1..N applied by the CLI exactly as the stages do
  pg -c "alter database postgres set check_function_bodies = off" > /dev/null 2>&1
  pg -c "drop schema if exists public cascade; create schema public; drop schema if exists supabase_migrations cascade;" > /dev/null 2>&1
  # the hosted set: the first bundle without its migration; every file has a synthetic body; the CLI itself applies them (all forward files, one plain push)
  bundle "$FIRST"; rm -f "$MIG/$FIRSTMIG"
  for f in "$MIG"/*.sql; do printf '%s\n' "begin;" "set local lock_timeout = '5s';" "select 1;" "commit;" > "$f"; done
  cli "setup-hosted" --yes
  local i=0 S
  for S in $STAGES; do
    i=$((i+1)); [ $i -gt "$1" ] && break
    bundle "$S"
    if [ "$(ex "$S" 'd["include_all"]')" = True ]; then cli "setup-step$i" --include-all --yes; else cli "setup-step$i" --yes; fi
  done
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

# =============================================================== A. the whole ordered sequence, one CLI invocation per migration
say "=================== A: the combined sequence (hosted set, then each step in order, one push per migration)"
reset_to 0
FIRSTST=$(echo $STAGES | cut -d' ' -f1)
expect "the synthetic hosted database is the planned start: $(ex $FIRSTST "d['history_before']['rows']") rows, max $(ex $FIRSTST "d['history_before']['max']"), version-set md5 as planned" "$(is_state "$FIRSTST" before && echo 0 || echo 1)" "$(snap)"
i=0
for S in $STAGES; do
  i=$((i+1)); M=$(ex "$S" 'd["migration"]'); V=${M%%_*}; IA=""; [ "$(ex "$S" 'd["include_all"]')" = True ] && IA="--include-all"
  say "---- step $i: $M ($([ -n "$IA" ] && echo 'below the hosted max: --include-all' || echo 'above the hosted max: plain'))"
  is_state "$S" before || expect "step $i: history before is the planned one" 1 "$(snap)"
  bundle "$S"
  PRE="$(snap)"
  if [ -n "$IA" ]; then
    cli "s$i-plain-dry" --dry-run
    expect "step $i: a PLAIN dry run REFUSES the below-head file (out-of-order) and lists nothing" "$([ "$RC" != 0 ] && grep -q "$OOO" "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
  fi
  cli "s$i-dry" $IA --dry-run
  assert0 "step $i: the dry run lists EXACTLY [$M]" "$M"
  expect "step $i: ...and changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"
  cli "s$i-push" $IA --yes
  expect "step $i: the push exits 0, one 'Applying migration' line naming $V, and the finish line" "$([ "$RC" = 0 ] && [ "$(grep -c '^Applying migration' "$LOG")" = 1 ] && grep -q "^Applying migration $M" "$LOG" && grep -q 'Finished supabase db push.' "$LOG" && echo 0 || echo 1)" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
  expect "step $i: history $(ex "$S" "d['history_after']['rows']") rows, max $(ex "$S" "d['history_after']['max']"), $V once, version-set md5 as planned" "$(is_state "$S" after && [ "$(pg -c "select count(*) from supabase_migrations.schema_migrations where version = '$V'")" = 1 ] && echo 0 || echo 1)" "$(snap)"
  POST="$(snap)"
  cli "s$i-rerun" $IA --dry-run
  expect "step $i: a re-run is idempotent ('Remote database is up to date', no list)" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
  expect "step $i: ...and nothing moved" "$(yes0 "$(snap)" "$POST")" "$(snap)"
done
LASTS=$(echo $STAGES | awk '{print $NF}')
expect "combined: final history is the plan's last step: $(ex $LASTS "d['history_after']['rows']") rows, max $(ex $LASTS "d['history_after']['max']")" "$(is_state "$LASTS" after && echo 0 || echo 1)" "$(snap)"

# =============================================================== B. negative controls
if [ "${ONLY_A:-0}" = 1 ]; then say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"; [ "$FAILS" = 0 ]; exit; fi
NSTEPS=$(echo $STAGES | wc -w | tr -d ' ')
S1=$(echo $STAGES | cut -d' ' -f1); S2=$(echo $STAGES | cut -d' ' -f2); S3=$(echo $STAGES | cut -d' ' -f3)
M1=$(ex "$S1" 'd["migration"]'); M2=$(ex "$S2" 'd["migration"]'); M3=$(ex "$S3" 'd["migration"]')
IA1=""; [ "$(ex "$S1" 'd["include_all"]')" = True ] && IA1="--include-all"
IA2=""; [ "$(ex "$S2" 'd["include_all"]')" = True ] && IA2="--include-all"
IA3=""; [ "$(ex "$S3" 'd["include_all"]')" = True ] && IA3="--include-all"

say "=================== B1: EXTRA FILE (a stray below the head, taken by --include-all) in step 1's bundle"
reset_to 0; bundle "$S1"; PRE="$(snap)"
printf '%s\n' "begin;" "select 255;" "commit;" > "$MIG/0255_stray.sql"
cli b1-dry $IA1 --dry-run
expect "the dry run LISTS the stray as well as [$M1] (a stray file is not harmless)" "$(sed -n 's/^ • //p' "$LOG" | grep -q '^0255_stray.sql$' && sed -n 's/^ • //p' "$LOG" | grep -q "^$M1\$" && echo 0 || echo 1)" "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')"
assert_fails "...and the exact-list assertion for [$M1] REFUSES it, so the stage STOPs before any push" "$M1"
expect "...and the dry run changed nothing" "$(yes0 "$(snap)" "$PRE")" "$(snap)"

say "=================== B2: EXTRA FILE (the NEXT step's migration) in step 1's bundle: why there is one push per migration"
reset_to 0; bundle "$S2"; PRE="$(snap)"
cli b2-dry $IA1 --dry-run
expect "step 2's bundle on the START history lists both [$M1] and [$M2]" "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ' | grep -q "$M1" && sed -n 's/^ • //p' "$LOG" | grep -q "^$M2\$" && echo 0 || echo 1)" "$(sed -n 's/^ • //p' "$LOG" | tr '\n' ' ')"
assert_fails "OUT OF ORDER: the exact-list assertion for [$M2] REFUSES (step 1 is not applied yet)" "$M2"
expect "...and nothing changed" "$(yes0 "$(snap)" "$PRE")" "$(snap)"

say "=================== B3: OUT OF ORDER: step 3's bundle with the history at step 1 (step 2 missing)"
reset_to 1; bundle "$S3"; PRE="$(snap)"
cli b3-dry $IA3 --dry-run
assert_fails "the dry run lists [$M2 $M3], the assertion for [$M3] REFUSES" "$M3"
expect "...and nothing changed" "$(yes0 "$(snap)" "$PRE")" "$(snap)"

say "=================== B4: MISSING FILE: step 1's migration absent from its bundle"
reset_to 0; bundle "$S1"; rm -f "$MIG/$M1"; PRE="$(snap)"
cli b4-dry $IA1 --dry-run
expect "the dry run says up to date and lists nothing" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
assert_fails "...and the exact-list assertion for [$M1] REFUSES it" "$M1"

say "=================== B5: MISSING FILE: a hosted version missing from the bundle refuses even with --include-all"
reset_to 0; bundle "$S1"; rm -f "$MIG"/0005_*.sql; PRE="$(snap)"
cli b5-dry --include-all --dry-run
expect "the --include-all dry run REFUSES (remote version not found locally) and lists nothing" "$([ "$RC" != 0 ] && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC $(grep -m1 -i 'not found' "$LOG" | cut -c1-100)"
cli b5-push --include-all --yes
expect "...and the push refuses too and applies nothing" "$([ "$RC" != 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"

say "=================== B6: A PUSH OF TWO FILES CANNOT ROLL BACK THE ONE ALREADY APPLIED (why one run per migration)"
reset_to 1; bundle "$S3"
# step 2's file is fine, step 3's file fails: both are in this bundle (the history is at step 1)
printf '%s\n' "begin;" "select 1/0;" "commit;" > "$MIG/$M3"
PRE1="$(snap)"
cli b6-multipush $IA3 --yes
expect "a single push of both files exits non-zero (the second failed)" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...but the FIRST file stayed applied: history is +1 ($M2), not back at step 1's state" "$([ "$(hrows)" = "$(ex "$S2" "d['history_after']['rows']")" ] && [ "$(hmax)" = "$(ex "$S2" "d['history_after']['max']")" ] && [ "$(snap)" != "$PRE1" ] && echo 0 || echo 1)" "$(snap)"

say "=================== B7: FAILURE INJECTED AT STEP k: history stops at k-1, and the same step cannot be pushed on"
for k in 2 3 4 5; do
  [ $k -le "$NSTEPS" ] || continue
  Sk=$(echo $STAGES | cut -d' ' -f$k); Mk=$(ex "$Sk" 'd["migration"]'); IAk=""; [ "$(ex "$Sk" 'd["include_all"]')" = True ] && IAk="--include-all"
  reset_to $((k-1)); bundle "$Sk"; printf '%s\n' "begin;" "select 1/0;" "commit;" > "$MIG/$Mk"
  cli "b7-$k-dry" $IAk --dry-run
  assert0 "step $k: the dry run still lists exactly [$Mk] (a dry run cannot see the failure)" "$Mk"
  cli "b7-$k-push" $IAk --yes
  expect "step $k: the push FAILS (rc != 0) and applies nothing: history is still step $((k-1))'s end state" "$([ "$RC" != 0 ] && is_state "$Sk" before && echo 0 || echo 1)" "rc=$RC $(snap)"
  cli "b7-$k-rerun" $IAk --dry-run
  assert0 "step $k: and a re-run still lists exactly [$Mk]: the history did not move on, nothing later is reachable" "$Mk"
done

say "=================== Z: --include-all is used ONLY for a step below the hosted max"
expect "include-all calls in this rehearsal exist (the below-head step) and every call used only --yes, --dry-run or --include-all" "$([ "$(grep -c -- '--include-all' "$CALLS")" -gt 0 ] && [ "$(grep -v -- '^db push \(--yes\|--dry-run\|--include-all --dry-run\|--include-all --yes\)$' "$CALLS" | grep -c '')" = 0 ] && echo 0 || echo 1)" "include-all calls=$(grep -c -- '--include-all' "$CALLS")"
FWD=""; for S in $STAGES; do [ "$(ex "$S" 'd["include_all"]')" = True ] || FWD="$FWD $S"; done
for S in $FWD; do
  expect "forward step $S: its stage uses a plain push (no --include-all anywhere in its apply script's executable text)" "$(grep -v '^ *#' "$PKG/$S/s1-apply-$S-online/s1-apply-$S-online.sh" | grep -Ev '^ *(echo|printf) ' | grep -q -- '--include-all' && echo 1 || echo 0)" "plain"
done

say "=================== RESULT: $(grep -c '^PASS' "$RES") passed, $FAILS failed"
[ "$FAILS" = 0 ]
