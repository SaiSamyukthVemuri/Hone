#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. OOO-PUSH-REHEARSAL: how the pinned supabase CLI v2.102.0 (the inner Go
# binary, "supabase-go") behaves when the local bundle holds a migration version LOWER than the
# remote maximum. A DISPOSABLE local PostgreSQL on the CI runner, SYNTHETIC migrations only (tiny
# tables named ooo_*). No Hone migration, no hosted project, no credential beyond the canary
# password of the throwaway database.
#
# Every scenario starts from a fresh database whose history holds 0001 0002 0248 0254 (applied by the
# CLI itself, in order), then changes only the LOCAL bundle. Ground truth is read back with psql.
set -u

OUT="${REHEARSAL_OUT:?}"
PGURL="${PGURL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable}"
VER=2.102.0
FAILS=0
mkdir -p "$OUT"
RES="$OUT/results.txt"
: > "$RES"
say() { echo "$*" | tee -a "$RES"; }
expect() { # expect <label> <0 = met> <observed>
  if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi
}
yes0() { [ "$1" = "$2" ] && echo 0 || echo 1; }       # yes0 <a> <b>   -> 0 when equal
has0() { grep -q -- "$2" "$1" && echo 0 || echo 1; }  # has0 <file> <fixed>
pg() { psql "$PGURL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

# ---- the pinned binary, verified exactly as the S1 rehearsal verifies it -----------------------
REL="https://github.com/supabase/cli/releases/download/v$VER"
WORK="$OUT/archive"; mkdir -p "$WORK"
( cd "$WORK" && env -u SSL_CERT_FILE curl -fsSL -O "$REL/checksums.txt" -O "$REL/supabase_${VER}_linux_amd64.tar.gz" ) || { say "FAIL download"; exit 1; }
( cd "$WORK" && grep " supabase_${VER}_linux_amd64.tar.gz\$" checksums.txt | sha256sum -c - ) > "$OUT/verify.txt" 2>&1
expect "the linux_amd64 release archive verifies against checksums.txt" "$?" "$(tr '\n' ' ' < "$OUT/verify.txt")"
mkdir -p "$OUT/cli" && tar -xzf "$WORK/supabase_${VER}_linux_amd64.tar.gz" -C "$OUT/cli"
GOBIN="$OUT/cli/supabase-go"
chmod +x "$GOBIN"
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
expect "the extracted supabase-go has the recorded inner sha256 (linux; the macOS inner binary is dce26b75, same source tag)" \
  "$(yes0 "$(sha256sum "$GOBIN" | cut -d' ' -f1)" "$GOSHA")" "$(sha256sum "$GOBIN" | cut -c1-16)"
expect "supabase-go prints $VER" "$(yes0 "$("$GOBIN" --version 2>&1 | tail -1)" "$VER")" "$("$GOBIN" --version 2>&1 | tail -1)"
say "INFO  psql: $(psql --version); server: $(pg -c 'show server_version')"

# ---- the scratch project ------------------------------------------------------------------------
PROJ="$OUT/proj"
MIG="$PROJ/supabase/migrations"
mkdir -p "$MIG"
printf 'project_id = "ooo-rehearsal"\n\n[db]\nmajor_version = 17\n' > "$PROJ/supabase/config.toml"

# Hone's migration shape: its own begin/commit and a set local lock_timeout inside it.
mig() { # mig <version> <name> [extra sql]
  cat > "$MIG/$1_$2.sql" <<SQL
begin;
set local lock_timeout = '5s';
create table public.ooo_$1 (id integer primary key, note text);
${3:-}
commit;
SQL
}
rawmig() { printf '%s\n' "$3" > "$MIG/$1_$2.sql"; } # rawmig <version> <name> <exact sql>

cli() { # cli <label> <args...>   -> $OUT/<label>.log, sets RC
  local label="$1"; shift
  LOG="$OUT/$label.log"
  ( cd "$PROJ" && timeout 180 "$GOBIN" db push --db-url "$PGURL" --workdir "$PROJ" "$@" ) < /dev/null > "$LOG" 2>&1
  RC=$?
  say "RUN   $label: db push $* -> rc=$RC"
  sed 's/^/   | /' "$LOG" | head -30 | tee -a "$RES" > /dev/null
}

hist() { pg -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations" 2> /dev/null; }
hist_md5() { # hist_md5 <version...>  : digest of name+statements for the given versions
  local v; for v in "$@"; do
    pg -c "select md5(version || name || statements::text) from supabase_migrations.schema_migrations where version = '$v'"
  done | tr '\n' ' '
}
has_table() { pg -c "select count(*) from pg_tables where schemaname = 'public' and tablename = '$1'"; }
oids() { pg -c "select string_agg(relname || '=' || oid::text, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'ooo\\_%'"; }
snap() { echo "$(hist) | $(oids) | $(pg -c 'select count(*) from public.ooo_0248' 2> /dev/null)"; }

fresh() { # fresh : the remote is 0001 0002 0248 0254, applied by the CLI in order; local bundle equals it
  pg -c "drop schema if exists public cascade; create schema public; drop schema if exists supabase_migrations cascade;" > /dev/null 2>&1
  rm -rf "$MIG" "$PROJ/supabase/seed.sql" "$PROJ/supabase/roles.sql"; mkdir -p "$MIG"
  mig 0001 base; mig 0002 second; mig 0248 sixth; mig 0254 seventh
  cli "setup-$1" --yes
  [ "$(hist)" = "0001 0002 0248 0254" ] || say "WARN  setup did not produce the expected history: $(hist)"
  pg -c "insert into public.ooo_0248 values (1, 'sentinel')" > /dev/null
}

# ---- THE DRY-RUN ASSERTION the online apply script should make ---------------------------------
# assert_dry_run <log> <rc> <expected-file...>   (expected files listed in order, base names)
# Passes only when: exit 0, the DRY RUN banner, the "Would push" block exists, the bullets are
# EXACTLY the expected files in the expected order, and nothing about seeds or roles appears.
assert_dry_run() {
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
assert0() { # assert0 <label> <expected files...>   uses $LOG and $RC
  local label="$1"; shift
  local m; m="$(assert_dry_run "$LOG" "$RC" "$@")"; local r=$?
  expect "$label" "$r" "$m"
}
assert_fails() { # a NEGATIVE control of the assertion itself: it must REFUSE
  local label="$1"; shift
  local m; m="$(assert_dry_run "$LOG" "$RC" "$@")"; local r=$?
  expect "$label" "$([ "$r" != 0 ] && echo 0 || echo 1)" "refused: $m"
}

say "=================== S1: remote 0001 0002 0248 0254; local adds 0251 (lower than the remote max)"
fresh s1
mig 0251 fifth
PRE="$(snap)"; PRE_OLD="$(hist_md5 0001 0002 0248 0254)"
say "INFO  pre-state: $PRE"

cli s1-plain-dry --dry-run
expect "plain --dry-run REFUSES (non-zero)" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...with the CLI's own out-of-order message" "$(has0 "$LOG" 'Found local migration files to be inserted before the last migration on remote database')" "message"
expect "...and it names the 0251 file in its suggestion" "$(has0 "$LOG" '0251_fifth.sql')" "suggestion"
expect "...and it prints NO 'Would push' list (the dry run lists nothing without --include-all)" "$([ "$(grep -c 'Would push' "$LOG")" = 0 ] && echo 0 || echo 1)" "lines=$(grep -c 'Would push' "$LOG")"
expect "...and the database is byte-for-byte unchanged" "$(yes0 "$(snap)" "$PRE")" "$(snap)"

cli s1-plain-yes --yes
expect "plain --yes push REFUSES the same way" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...nothing applied: no ooo_0251, history unchanged" "$(yes0 "$(has_table ooo_0251) $(snap)" "0 $PRE")" "$(has_table ooo_0251)"

cli s1-incl-dry --include-all --dry-run
assert0 "--include-all --dry-run passes the exact-list assertion for [0251_fifth.sql]" 0251_fifth.sql
expect "...and the dry run changed nothing (snapshot identical, no ooo_0251)" "$(yes0 "$(has_table ooo_0251) $(snap)" "0 $PRE")" "$(has_table ooo_0251)"
assert_fails "CONTROL: the same log fails the assertion when the expected list is wrong [0252_x.sql]" 0252_x.sql
assert_fails "CONTROL: the same log fails when the expected list has an extra file [0251 + 0254]" 0251_fifth.sql 0254_seventh.sql

cli s1-incl-yes --include-all --yes
expect "--include-all --yes exits 0" "$(yes0 "$RC" 0)" "rc=$RC"
expect "history is now 0001 0002 0248 0251 0254 (0251 slotted in; nothing else added)" "$(yes0 "$(hist)" '0001 0002 0248 0251 0254')" "$(hist)"
expect "ONLY 0251 was applied: exactly one 'Applying migration' line, naming 0251" \
  "$([ "$(grep -c '^Applying migration' "$LOG")" = 1 ] && grep -q '^Applying migration 0251_fifth.sql' "$LOG" && echo 0 || echo 1)" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
expect "the four applied history rows are unchanged (name + statements digest)" "$(yes0 "$(hist_md5 0001 0002 0248 0254)" "$PRE_OLD")" "digest"
expect "the four existing tables were NOT recreated (pg_class oids unchanged)" \
  "$(yes0 "$(oids | sed 's/,ooo_0251=[0-9]*//')" "$(echo "$PRE" | cut -d'|' -f2 | sed 's/^ //; s/ $//')")" "$(oids)"
expect "the sentinel row in ooo_0248 survived (nothing was dropped or re-run)" "$(yes0 "$(pg -c 'select count(*) from public.ooo_0248')" 1)" "rows=$(pg -c 'select count(*) from public.ooo_0248')"
expect "ooo_0251 exists" "$(yes0 "$(has_table ooo_0251)" 1)" "created"

cli s1-again-incl-dry --include-all --dry-run
expect "re-run: --include-all --dry-run now says up to date, exit 0, no list" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && ! grep -q 'Would push' "$LOG" && echo 0 || echo 1)" "rc=$RC"
cli s1-again-plain-dry --dry-run
expect "re-run: PLAIN --dry-run is also clean now (the gap is closed)" "$([ "$RC" = 0 ] && grep -q 'Remote database is up to date' "$LOG" && echo 0 || echo 1)" "rc=$RC"

say "=================== N1: local is MISSING a remote version (0248) and adds 0251: --include-all must not rescue it"
fresh n1
rm "$MIG/0248_sixth.sql"; mig 0251 fifth
PRE="$(snap)"
cli n1-incl-dry --include-all --dry-run
expect "N1 dry run REFUSES even with --include-all" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...with the missing-local message" "$(has0 "$LOG" 'Remote migration versions not found in local migrations directory')" "message"
assert_fails "CONTROL: the dry-run assertion refuses that output" 0251_fifth.sql
cli n1-incl-yes --include-all --yes
expect "N1 real push refuses too and applies nothing" "$([ "$RC" != 0 ] && [ "$(has_table ooo_0251)" = 0 ] && [ "$(snap)" = "$PRE" ] && echo 0 || echo 1)" "rc=$RC"

say "=================== N2: local adds 0251 AND a newer 0255: --include-all takes the newer one too"
fresh n2
mig 0251 fifth; mig 0255 eighth
cli n2-incl-dry --include-all --dry-run
assert0 "N2 dry run lists both, in order [0251, 0255]" 0251_fifth.sql 0255_eighth.sql
assert_fails "CONTROL: an assertion pinned to [0251] alone REFUSES this log (the pin is what catches the extra file)" 0251_fifth.sql
cli n2-incl-yes --include-all --yes
expect "N2 real push applied both, 0251 before 0255" "$(yes0 "$(grep '^Applying migration' "$LOG" | sed 's/Applying migration \(....\).*/\1/' | tr '\n' ' ')" '0251 0255 ')" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"

say "=================== N3: an APPLIED migration's file is edited locally, plus 0251: it is NOT re-applied and the edit is NOT noticed"
fresh n3
mig 0248 sixth "alter table public.ooo_0248 add column edited text;"
mig 0251 fifth
PRE_OLD="$(hist_md5 0001 0002 0248 0254)"
cli n3-incl-yes --include-all --yes
expect "N3 applied exactly [0251]" "$(yes0 "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')" 'Applying migration 0251_fifth.sql... ')" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"
expect "...the edited 0248 was not re-run (column absent) and its history digest is unchanged" \
  "$([ "$(pg -c "select count(*) from information_schema.columns where table_name='ooo_0248' and column_name='edited'")" = 0 ] && [ "$(hist_md5 0001 0002 0248 0254)" = "$PRE_OLD" ] && echo 0 || echo 1)" "no re-apply"

say "=================== N4: 0251 valid, 0252 invalid inside begin/commit: per-file atomicity, resume applies only the fixed file"
fresh n4
mig 0251 fifth
rawmig 0252 sixth_b $'begin;\ncreate table public.ooo_0252 (id integer);\nselect 1/0;\ncommit;'
cli n4-incl-yes --include-all --yes
expect "N4 first run fails" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...0251 is committed and recorded; 0252 left no table and no history row" \
  "$(yes0 "$(has_table ooo_0251)$(has_table ooo_0252) $(hist)" '10 0001 0002 0248 0251 0254')" "$(has_table ooo_0251)$(has_table ooo_0252) $(hist)"
mig 0252 sixth_b
cli n4-resume --include-all --yes
expect "N4 after fixing 0252, the re-run applies ONLY 0252" "$(yes0 "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')" 'Applying migration 0252_sixth_b.sql... ')" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"

say "=================== N5: a file that COMMITS and then errors leaves its effect with NO history row (re-apply hazard)"
fresh n5
mig 0251 fifth
rawmig 0252 sixth_b $'begin;\ncreate table public.ooo_0252a (id integer);\ncommit;\nselect 1/0;'
cli n5-incl-yes --include-all --yes
expect "N5 first run fails" "$([ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"
expect "...the committed table EXISTS but 0252 has NO history row" "$(yes0 "$(has_table ooo_0252a) $(hist)" '1 0001 0002 0248 0251 0254')" "$(has_table ooo_0252a) $(hist)"
cli n5-rerun --include-all --yes
expect "...a re-run tries 0252 AGAIN (it is still pending) - the apply script must treat a failed file as needing human review, never retry blindly" \
  "$(grep -q '^Applying migration 0252_sixth_b.sql' "$LOG" && [ "$RC" != 0 ] && echo 0 || echo 1)" "rc=$RC"

say "=================== N6: seed and roles are NOT touched unless asked"
fresh n6
mig 0251 fifth
printf 'create table public.ooo_seed_marker (id integer);\n' > "$PROJ/supabase/seed.sql"
printf 'create table public.ooo_roles_marker (id integer);\n' > "$PROJ/supabase/roles.sql"
cli n6-default --include-all --yes
expect "N6 default flags: neither marker table was created" "$(yes0 "$(has_table ooo_seed_marker)$(has_table ooo_roles_marker)" 00)" "seed=$(has_table ooo_seed_marker) roles=$(has_table ooo_roles_marker)"
fresh n6b
mig 0251 fifth
printf 'create table public.ooo_seed_marker (id integer);\n' > "$PROJ/supabase/seed.sql"
printf 'create table public.ooo_roles_marker (id integer);\n' > "$PROJ/supabase/roles.sql"
cli n6-with-flags --include-all --include-seed --include-roles --yes
say "INFO  with --include-seed --include-roles: seed=$(has_table ooo_seed_marker) roles=$(has_table ooo_roles_marker) (CONTROL: shows the markers CAN be created, so the 00 above is not vacuous)"
expect "CONTROL: at least one marker is created when its flag is passed" "$([ "$(has_table ooo_seed_marker)$(has_table ooo_roles_marker)" != 00 ] && echo 0 || echo 1)" "seed=$(has_table ooo_seed_marker) roles=$(has_table ooo_roles_marker)"

say "=================== N7: --include-all WITHOUT --yes and with no terminal"
fresh n7
mig 0251 fifth
cli n7-no-yes --include-all
say "INFO  N7 rc=$RC; applied 0251: $(has_table ooo_0251); history: $(hist); output tail: $(tail -n 3 "$LOG" | tr '\n' '/' | cut -c1-200)"

say "=================== N8: a plain in-order push needs no --include-all (the flag is only for the gap)"
fresh n8
mig 0255 eighth
cli n8-plain --yes
expect "N8 plain push applied exactly [0255]" "$(yes0 "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')" 'Applying migration 0255_eighth.sql... ')" "$(grep '^Applying migration' "$LOG" | tr '\n' ' ')"

say "=================== RESULT: $FAILS failed expectation(s)"
[ "$FAILS" = 0 ]
