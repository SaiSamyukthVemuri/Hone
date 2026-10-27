#!/bin/bash
# REHEARSAL - NEVER MERGE. S0B-DIAG2 on macOS arm64 (macos-14): the one-read event-trigger identity diagnostic against a synthetic local database.
# REAL: s0b-diag2.sh, d2-ensure-rls-definition.sql, MANIFEST.sha256 and the runner (byte-identical copies in ./pkg), the darwin supabase-go v2.102.0 (dce26b75) that runs the query, PostgreSQL 17 with TLS and scram.
# STUB: the hosted side ("production" is database postgres on 127.0.0.1, reached by --db-url) and the function: a synthetic look-alike of rls_auto_enable().
#       PIN SUBSTITUTIONS in test copies only: GO_SHA, RUNNER_SHA and EXPECT_MD5 (the look-alike has its own md5). A diff proves they are the only differences.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/pkg"
DRV="$HERE/driver.py"
W="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/s0bdiag2.XXXXXX")}"; mkdir -p "$W"; W="$(cd "$W" && pwd -P)"
H="$W/home"; ROOT="$H/hone-s1"; mkdir -p "$H"
STEPS="$W/steps.tsv"; : > "$STEPS"
pass=0; fail=0; CUR=setup
ok()  { pass=$((pass+1)); echo "ok   - $1"; printf '%s\tok\t%s\n' "$CUR" "$1" >> "$STEPS"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; printf '%s\tFAIL\t%s %s\n' "$CUR" "$1" "${2:-}" >> "$STEPS"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TOKEN="sbp_$(openssl rand -hex 20)"     # a throwaway value made at run time; never stored in the repository
PW_P=PW-PROD-91b3c7e2
PW_X=PW-WRONG-4e8a20d9
NODEDIR="$(dirname "$(node -p process.execPath)")"
SAFEPATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$NODEDIR"

CUR=pkg
( cd "$PKG" && shasum -a 256 -c "$HERE/pkg.SHA256SUMS" >/dev/null 2>&1 ) && ok "the package copies in ./pkg match the recorded checksums" || bad "pkg checksums"
[ "$(sha "$PKG/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "the runner copy is the pinned 471ecb9d" || bad "runner copy sha"
/bin/bash -n "$PKG/s0b-diag2.sh" && ok "bash -n s0b-diag2.sh" || bad "bash -n s0b-diag2.sh"

CUR=infra
B=$("$HERE/pg-setup.sh" "$W/pg" "$PW_P") || { echo "pg-setup failed"; tail -20 "$W/pg/pg.log" 2>/dev/null; exit 2; }
PSQLD() { local db=$1; shift; "$B/psql" -X -At -h "$W/pg" -p 55432 -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "no member of the release archive hashes to dce26b75"; exit 2; }
PSQLD postgres -f "$HERE/events.sql" > "$W/events.log" 2>&1 && ok "the synthetic ensure_rls / rls_auto_enable look-alike created" || { bad "events.sql" "$(tail -n 8 "$W/events.log")"; exit 2; }
[ "$(PSQLD postgres -c 'select count(*) from pg_event_trigger')" = 1 ] && ok "pg_event_trigger holds 1 row" || bad "event trigger count"

CUR=layout
mkdir -p "$ROOT/supabase-cli/real" "$ROOT/s0b-diag2" "$ROOT/s0b" "$ROOT/_e2e"
cp "$REALBIN" "$ROOT/supabase-cli/real/supabase-go"; chmod 0755 "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
printf '%s\n' abcdefghijklmnopqrst > "$ROOT/e2e-restored-ref"; printf 'postgres\n' > "$ROOT/e2e-restored-db"; : > "$ROOT/e2e-calls.log"
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$PKG/run-window-read-macos.sh" > "$ROOT/s0b-diag2/run-window-read-macos.sh"; chmod 0755 "$ROOT/s0b-diag2/run-window-read-macos.sh"
RSHA=$(sha "$ROOT/s0b-diag2/run-window-read-macos.sh")
cp "$PKG/d2-ensure-rls-definition.sql" "$PKG/MANIFEST.sha256" "$ROOT/s0b-diag2/"
mkscript() { sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^EXPECT_MD5=\\([0-9a-f]*\\)\\(.*\\)/EXPECT_MD5=$1\\2/" "$PKG/s0b-diag2.sh" > "$ROOT/_e2e/s0b-diag2.sh"; chmod 0755 "$ROOT/_e2e/s0b-diag2.sh"; }
LOOKMD5=$(PSQLD postgres -c "select md5(prosrc) from pg_proc where proname = 'rls_auto_enable'")
mkscript "$LOOKMD5"; chmod 0755 "$ROOT" "$ROOT/s0b-diag2"
chk() { local d; d=$(diff "$1" "$2" | grep '^[<>]' | grep -Ev "$3" | wc -l | tr -d ' '); [ "$d" = 0 ] && ok "test copy of $(basename "$1") differs from the package only on its pin lines" || bad "test copy of $(basename "$1") differs elsewhere"; }
chk "$PKG/run-window-read-macos.sh" "$ROOT/s0b-diag2/run-window-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
chk "$PKG/s0b-diag2.sh" "$ROOT/_e2e/s0b-diag2.sh" '^[<>] (GO_SHA|RUNNER_SHA|EXPECT_MD5)='
( cd "$ROOT/s0b-diag2" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "d2-ensure-rls-definition.sql verifies against the pinned MANIFEST.sha256" || bad "manifest"

CUR=run
drive() { # drive NAME ANSWERS
  RC=0
  python3 "$DRV" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$ROOT/_e2e/s0b-diag2.sh" || RC=$?
  OUT="$W/$1.out"; tr -d '\r' < "$OUT" > "$OUT.txt"
}
calls() { grep -c . "$ROOT/e2e-calls.log" | tr -d ' '; }
diag() { # diag NAME [PASSWORD]
  { printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'PRODUCTION database password\t%s\n' "${2:-$PW_P}"; } > "$W/$1.ans"
  C0=$(calls); drive "$1" "$W/$1.ans"; DC=$(( $(calls) - C0 ))
}
priv() { PSQLD postgres -c "select has_function_privilege('$1', p.oid, 'EXECUTE') from pg_proc p where p.proname = 'rls_auto_enable'"; }

diag good
if [ "$RC" = 0 ] && [ "$DC" = 1 ] && grep -q "^prosrc_md5=$LOOKMD5 (matches the expected)" "$OUT.txt" && grep -q '^S0B DIAG2 DONE: 1 row; md5 matches\. Result: ' "$OUT.txt" \
   && grep -q '^----- definition -----' "$OUT.txt" && grep -q 'CREATE OR REPLACE FUNCTION public.rls_auto_enable()' "$OUT.txt" && grep -q 'enable row level security' "$OUT.txt" \
   && grep -q '^security_definer=true' "$OUT.txt" && grep -q '^proconfig={search_path=pg_catalog}' "$OUT.txt" && grep -q '^provolatile=v' "$OUT.txt" \
   && grep -q '^evttags={"CREATE TABLE","CREATE TABLE AS","SELECT INTO"}' "$OUT.txt" && grep -q '^evtenabled=O' "$OUT.txt" && grep -q '^evtowner_role=postgres' "$OUT.txt" \
   && grep -q "^anon_can_run=$(priv anon | sed 's/^t$/true/; s/^f$/false/')" "$OUT.txt" && grep -q "^authenticated_can_run=$(priv authenticated | sed 's/^t$/true/; s/^f$/false/')" "$OUT.txt" && grep -q "^service_role_can_run=$(priv service_role | sed 's/^t$/true/; s/^f$/false/')" "$OUT.txt"; then
  ok "matching md5: exit 0 after exactly 1 read; prints md5, security_definer, search_path, volatility, tags, enabled, owner, the three privileges (equal to the database's) and the definition"
else bad "good run" "exit $RC, reads $DC; tail: $(tail -n 24 "$OUT.txt")"; fi
grep -E '^(prosrc_md5|security_definer|proconfig|provolatile|evttags|evtenabled|evtowner_role|anon_can_run|authenticated_can_run|service_role_can_run)=' "$OUT.txt" | sed 's/^/       /'

# the unmodified wrapper expects the production md5: a different function is refused and its definition is never shown
cp "$ROOT/_e2e/s0b-diag2.sh" "$W/script.look"; cp "$PKG/s0b-diag2.sh" "$ROOT/_e2e/s0b-diag2.sh"
sed -i.bak -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$ROOT/_e2e/s0b-diag2.sh"; rm -f "$ROOT/_e2e/s0b-diag2.sh.bak"
grep -q '^EXPECT_MD5=99be20677b456ea8d3be47bdd44fb369 ' "$ROOT/_e2e/s0b-diag2.sh" && ok "the package wrapper pins EXPECT_MD5=99be2067... (only GO_SHA and RUNNER_SHA were substituted here)" || bad "package EXPECT_MD5"
diag wrongmd5
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q "STOP: prosrc_md5 $LOOKMD5 is not the expected 99be20677b456ea8d3be47bdd44fb369; the definition is not shown" "$OUT.txt" && ! grep -qE 'definition -----|CREATE OR REPLACE|row level security|^S0B DIAG2 DONE' "$OUT.txt"; then
  ok "a different function (md5 not 99be2067...) is refused after 1 read; the definition is not shown"
else bad "md5 mismatch" "exit $RC, reads $DC; tail: $(tail -n 8 "$OUT.txt")"; fi
cp "$W/script.look" "$ROOT/_e2e/s0b-diag2.sh"

# a definition that mentions a forbidden word: only the md5 is printed
PSQLD postgres -c "create or replace function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as \$f\$ begin null; /* the Token is not here */ end \$f\$" >/dev/null
LOOK2=$(PSQLD postgres -c "select md5(prosrc) from pg_proc where proname = 'rls_auto_enable'")
mkscript "$LOOK2"
diag forbidden
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q "STOP: the definition mentions password, secret, token or key=; only the md5 is shown: $LOOK2" "$OUT.txt" && ! grep -qE 'definition -----|CREATE OR REPLACE|Token is not here|^S0B DIAG2 DONE' "$OUT.txt"; then
  ok "a definition containing 'Token' (md5 matched): STOP, only the md5 printed, no definition"
else bad "forbidden word" "exit $RC, reads $DC; tail: $(tail -n 8 "$OUT.txt")"; fi

# no ensure_rls trigger: zero rows
PSQLD postgres -c "drop event trigger ensure_rls" >/dev/null
diag zero
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'STOP: expected exactly 1 row, got 0' "$OUT.txt" && ! grep -q '^S0B DIAG2 DONE' "$OUT.txt"; then ok "no ensure_rls trigger: 0 rows, STOP"; else bad "zero rows" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi

CUR=negatives
diag wrongpw "$PW_X"
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'STOP: authentication failed; stopped' "$OUT.txt" && [ -f "$ROOT/s0b-diag2/FAILED-LOGIN" ] && ! grep -q '^S0B DIAG2 DONE' "$OUT.txt"; then
  ok "a wrong password: 1 read, no retry, FAILED-LOGIN written ($(cat "$ROOT/s0b-diag2/FAILED-LOGIN"))"
else bad "wrong password" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
[ -f "$ROOT/s0b/FAILED-LOGIN" ] && ok "the tombstone was also written in ~/hone-s1/s0b" || bad "second tombstone"
diag afterfail
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: a previous run failed a login' "$OUT.txt"; then ok "a re-run while the tombstone exists is refused with 0 reads"; else bad "tombstone block" "exit $RC, reads $DC"; fi
mv "$ROOT/s0b-diag2/FAILED-LOGIN" "$W/FAILED-LOGIN.diag2"; mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.s0b"
: > "$ROOT/s0b-diag/FAILED-LOGIN" 2>/dev/null || { mkdir -p "$ROOT/s0b-diag"; : > "$ROOT/s0b-diag/FAILED-LOGIN"; }
diag afterdiag1
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: a previous run failed a login' "$OUT.txt"; then ok "a tombstone left by the earlier s0b-diag run also blocks this one (0 reads)"; else bad "s0b-diag tombstone block" "exit $RC, reads $DC"; fi
mv "$ROOT/s0b-diag/FAILED-LOGIN" "$W/FAILED-LOGIN.diag1"

: > "$ROOT/e2e-fake-loginrole"
diag loginrole
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'login-role / ban / password path' "$OUT.txt" && [ -f "$ROOT/s0b-diag2/FAILED-LOGIN" ]; then ok "the CLI login-role text path writes the tombstone and stops (1 read)"; else bad "login-role path" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
mv "$ROOT/s0b-diag2/FAILED-LOGIN" "$W/FAILED-LOGIN.loginrole"; mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.loginrole2"; mv "$ROOT/e2e-fake-loginrole" "$W/e2e-fake-loginrole.done"

cp "$ROOT/s0b-diag2/d2-ensure-rls-definition.sql" "$W/d2.orig"
printf '\n-- tampered\n' >> "$ROOT/s0b-diag2/d2-ensure-rls-definition.sql"
diag tampered
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'does not match MANIFEST.sha256' "$OUT.txt"; then ok "a modified SQL file is refused before any read (0 reads)"; else bad "tampered sql" "exit $RC, reads $DC; tail: $(tail -n 4 "$OUT.txt")"; fi
cp "$W/d2.orig" "$ROOT/s0b-diag2/d2-ensure-rls-definition.sql"

CUR=secrets
leak=0
for s in "$PW_P" "$PW_X" "$TOKEN"; do if grep -rqF -- "$s" "$W"/*.out "$W"/*.out.txt 2>/dev/null; then leak=1; fi; done
[ "$leak" = 0 ] && ok "no password and no access token appears in any transcript" || bad "a secret appears in a transcript"
if grep -rqF -e "$PW_P" -e "$PW_X" -e "$TOKEN" "$ROOT"/s0b-diag2-run.* 2>/dev/null; then bad "a secret was written to a work directory"; else ok "no password and no token was written to any work directory"; fi

echo; echo "steps: $pass ok, $fail FAIL"
cp "$ROOT/e2e-calls.log" "$W/calls.log" 2>/dev/null || true
[ "$fail" = 0 ]
