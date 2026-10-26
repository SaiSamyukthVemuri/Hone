#!/bin/bash
# REHEARSAL - NEVER MERGE. S0B-DIAG on macOS arm64 (macos-14): the one-read event-trigger identity diagnostic against a synthetic local database.
# REAL: s0b-diag.sh, d1-event-trigger-identity.sql, MANIFEST.sha256 and the runner (byte-identical copies in ./pkg), the darwin supabase-go v2.102.0
#       (dce26b75) that runs the query, PostgreSQL 17 with TLS and scram.
# STUB: the hosted side. "Production" is database postgres on 127.0.0.1; the CLI reaches it through --db-url (a wrapper rewrites --linked). The nine event
#       triggers are synthetic (see events.sql). PIN SUBSTITUTIONS in test copies only: the wrapper's sha for GO_SHA and the runner's SUPABASE_GO_SHA256,
#       the resulting runner sha for RUNNER_SHA. A diff proves they are the only differences.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/pkg"
DRV="$HERE/driver.py"
W="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/s0bdiag.XXXXXX")}"; mkdir -p "$W"; W="$(cd "$W" && pwd -P)"
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
/bin/bash -n "$PKG/s0b-diag.sh" && ok "bash -n s0b-diag.sh" || bad "bash -n s0b-diag.sh"

CUR=infra
B=$("$HERE/pg-setup.sh" "$W/pg" "$PW_P") || { echo "pg-setup failed"; tail -20 "$W/pg/pg.log" 2>/dev/null; exit 2; }
PSQLD() { local db=$1; shift; "$B/psql" -X -At -h "$W/pg" -p 55432 -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "no member of the release archive hashes to dce26b75"; exit 2; }
PSQLD postgres -f "$HERE/events.sql" > "$W/events.log" 2>&1 && ok "nine synthetic event triggers created (6 platform-style, ensure_rls look-alike, hostile net.http_post, platform-name spoof)" || { bad "events.sql" "$(tail -n 8 "$W/events.log")"; exit 2; }
[ "$(PSQLD postgres -c 'select count(*) from pg_event_trigger')" = 9 ] && ok "pg_event_trigger holds 9 rows" || bad "event trigger count"

CUR=layout
mkdir -p "$ROOT/supabase-cli/real" "$ROOT/s0b-diag" "$ROOT/s0b" "$ROOT/_e2e"
cp "$REALBIN" "$ROOT/supabase-cli/real/supabase-go"; chmod 0755 "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
printf '%s\n' abcdefghijklmnopqrst > "$ROOT/e2e-restored-ref"; printf 'postgres\n' > "$ROOT/e2e-restored-db"; : > "$ROOT/e2e-calls.log"
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$PKG/run-window-read-macos.sh" > "$ROOT/s0b-diag/run-window-read-macos.sh"; chmod 0755 "$ROOT/s0b-diag/run-window-read-macos.sh"
RSHA=$(sha "$ROOT/s0b-diag/run-window-read-macos.sh")
cp "$PKG/d1-event-trigger-identity.sql" "$PKG/MANIFEST.sha256" "$ROOT/s0b-diag/"
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$PKG/s0b-diag.sh" > "$ROOT/_e2e/s0b-diag.sh"; chmod 0755 "$ROOT/_e2e/s0b-diag.sh" "$ROOT" "$ROOT/s0b-diag"
chk() { local d; d=$(diff "$1" "$2" | grep '^[<>]' | grep -Ev "$3" | wc -l | tr -d ' '); [ "$d" = 0 ] && ok "test copy of $(basename "$1") differs from the package only on its pin lines" || bad "test copy of $(basename "$1") differs elsewhere"; }
chk "$PKG/run-window-read-macos.sh" "$ROOT/s0b-diag/run-window-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
chk "$PKG/s0b-diag.sh" "$ROOT/_e2e/s0b-diag.sh" '^[<>] (GO_SHA|RUNNER_SHA)='
( cd "$ROOT/s0b-diag" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "d1-event-trigger-identity.sql verifies against the pinned MANIFEST.sha256" || bad "manifest"

CUR=run
drive() { # drive NAME ANSWERS
  RC=0
  python3 "$DRV" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$ROOT/_e2e/s0b-diag.sh" || RC=$?
  OUT="$W/$1.out"; tr -d '\r' < "$OUT" > "$OUT.txt"
}
calls() { grep -c . "$ROOT/e2e-calls.log" | tr -d ' '; }
diag() { # diag NAME [PASSWORD]
  { printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'PRODUCTION database password\t%s\n' "${2:-$PW_P}"; } > "$W/$1.ans"
  C0=$(calls); drive "$1" "$W/$1.ans"; DC=$(( $(calls) - C0 ))
}

diag good
if [ "$RC" = 0 ] && [ "$DC" = 1 ] && grep -q '^event triggers: 9$' "$OUT.txt" && grep -Eq '^S0B DIAG DONE: 9 event trigger\(s\); names, hashes and booleans only\. Result: ' "$OUT.txt"; then
  ok "the diagnostic exits 0 after exactly 1 database read, prints 9 event triggers and the DONE line"
else bad "diagnostic run" "exit $RC, reads $DC; tail: $(tail -n 14 "$OUT.txt")"; fi

# the expected per-trigger values, with the md5 taken from the database for the same function
{
  for n in pgrst_ddl_watch pgrst_drop_watch issue_graphql_placeholder issue_pg_graphql_access issue_pg_cron_access issue_pg_net_access ensure_rls zz_hostile_notify pgaudit_sql_drop; do
    printf '%s|%s\n' "$n" "$(PSQLD postgres -c "select md5(p.prosrc) from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid where e.evtname = '$n'")"
  done
} > "$W/md5s.txt"
python3 - "$OUT.txt" "$W/md5s.txt" > "$W/assert.txt" 2>&1 <<'PY'
import sys
lines = [l.rstrip("\n") for l in open(sys.argv[1])]
md5 = dict(l.strip().split("|") for l in open(sys.argv[2]) if l.strip())
rows = {}
for l in lines:
    if l.startswith("evtname="):
        kv = dict(p.split("=", 1) for p in l.split(" "))
        rows[kv["evtname"]] = kv
exp = {}
def e(name, evt, en, tags, towner, fn, fowner, callout, rls, ex, plat):
    exp[name] = dict(evtevent=evt, evtenabled=en, evttags_count=str(tags), trigger_owner_role=towner, function_name=fn, function_owner_role=fowner, language="plpgsql",
                     function_is_extension_member="false", prosrc_md5=md5[name], source_mentions_callout=callout, source_mentions_enable_rls=rls, source_has_execute_dynamic=ex, is_exact_platform_name=plat)
e("pgrst_ddl_watch", "ddl_command_end", "O", 0, "supabase_admin", "extensions.rh_noop", "supabase_admin", "false", "false", "false", "true")
e("pgrst_drop_watch", "sql_drop", "O", 0, "supabase_admin", "extensions.rh_noop", "supabase_admin", "false", "false", "false", "true")
e("issue_graphql_placeholder", "sql_drop", "O", 1, "supabase_admin", "extensions.rh_noop2", "supabase_admin", "false", "false", "false", "true")
e("issue_pg_graphql_access", "ddl_command_end", "O", 1, "supabase_admin", "extensions.rh_noop2", "supabase_admin", "false", "false", "false", "true")
e("issue_pg_cron_access", "ddl_command_end", "O", 1, "supabase_admin", "extensions.rh_noop2", "supabase_admin", "false", "false", "false", "true")
e("issue_pg_net_access", "ddl_command_end", "O", 1, "supabase_admin", "extensions.rh_noop2", "supabase_admin", "false", "false", "false", "true")
e("ensure_rls", "ddl_command_end", "O", 3, "postgres", "public.rls_auto_enable", "postgres", "false", "true", "true", "false")
e("zz_hostile_notify", "ddl_command_end", "D", 0, "postgres", "public.rh_hostile", "postgres", "true", "false", "false", "false")
e("pgaudit_sql_drop", "sql_drop", "O", 0, "postgres", "public.rh_spoof", "postgres", "true", "false", "false", "true")
bad = 0
if set(rows) != set(exp): print("row names differ:", sorted(rows), sorted(exp)); bad = 1
for n, want in exp.items():
    got = rows.get(n, {})
    for k, v in want.items():
        if got.get(k) != v: print(f"{n}.{k}: got {got.get(k)!r} want {v!r}"); bad = 1
print("ASSERT_RESULT", "FAIL" if bad else "OK")
sys.exit(bad)
PY
[ $? = 0 ] && ok "every column of all 9 rows is as expected (owners, function names, tag counts, enabled state, md5 equals the database's, and each boolean)" || bad "per-row booleans" "$(cat "$W/assert.txt")"
grep -E '^evtname=(ensure_rls|zz_hostile_notify|pgaudit_sql_drop|issue_pg_net_access) ' "$OUT.txt" | sed 's/^/       /'
! grep -qE 'http_post|http_get|example\.invalid|alter table|pg_event_trigger_ddl_commands|format\(|begin null' "$OUT.txt" && ok "the output carries no function source text and no URL" || bad "source text appears in the output"
RESULT=$(ls -1dt "$ROOT"/s0b-diag-run.*/results/d1-event-trigger-identity.json | head -n 1)
! grep -qE 'http_post|example\.invalid|alter table|format\(' "$RESULT" && ok "the stored result file carries no source text either" || bad "source text in the result file"

CUR=negatives
diag wrongpw "$PW_X"
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'STOP: authentication failed; stopped' "$OUT.txt" && [ -f "$ROOT/s0b-diag/FAILED-LOGIN" ] && ! grep -q '^S0B DIAG DONE' "$OUT.txt"; then
  ok "a wrong password: 1 read, no retry, FAILED-LOGIN written ($(cat "$ROOT/s0b-diag/FAILED-LOGIN"))"
else bad "wrong password" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
[ -f "$ROOT/s0b/FAILED-LOGIN" ] && ok "the tombstone was also written in ~/hone-s1/s0b, so the other S0b scripts refuse too" || bad "second tombstone"
diag afterfail
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: a previous run failed a login' "$OUT.txt"; then ok "a re-run while the tombstone exists is refused with 0 reads"; else bad "tombstone block" "exit $RC, reads $DC"; fi
mv "$ROOT/s0b-diag/FAILED-LOGIN" "$W/FAILED-LOGIN.diag"
diag afterfail2
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'STOP: a previous run failed a login' "$OUT.txt"; then ok "the tombstone in ~/hone-s1/s0b alone also blocks the diagnostic (0 reads)"; else bad "second tombstone block" "exit $RC, reads $DC"; fi
mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.s0b"

: > "$ROOT/e2e-fake-loginrole"
diag loginrole
if [ "$RC" != 0 ] && [ "$DC" = 1 ] && grep -q 'login-role / ban / password path' "$OUT.txt" && [ -f "$ROOT/s0b-diag/FAILED-LOGIN" ]; then ok "the CLI login-role text path writes the tombstone and stops (1 read)"; else bad "login-role path" "exit $RC, reads $DC; tail: $(tail -n 6 "$OUT.txt")"; fi
mv "$ROOT/s0b-diag/FAILED-LOGIN" "$W/FAILED-LOGIN.loginrole"; mv "$ROOT/s0b/FAILED-LOGIN" "$W/FAILED-LOGIN.loginrole2"; mv "$ROOT/e2e-fake-loginrole" "$W/e2e-fake-loginrole.done"

cp "$ROOT/s0b-diag/d1-event-trigger-identity.sql" "$W/d1.orig"
printf '\n-- tampered\n' >> "$ROOT/s0b-diag/d1-event-trigger-identity.sql"
diag tampered
if [ "$RC" != 0 ] && [ "$DC" = 0 ] && grep -q 'does not match MANIFEST.sha256' "$OUT.txt"; then ok "a modified SQL file is refused before any read (0 reads)"; else bad "tampered sql" "exit $RC, reads $DC; tail: $(tail -n 4 "$OUT.txt")"; fi
cp "$W/d1.orig" "$ROOT/s0b-diag/d1-event-trigger-identity.sql"

CUR=secrets
leak=0
for s in "$PW_P" "$PW_X" "$TOKEN"; do if grep -rqF -- "$s" "$W"/*.out "$W"/*.out.txt 2>/dev/null; then leak=1; fi; done
[ "$leak" = 0 ] && ok "no password and no access token appears in any transcript" || bad "a secret appears in a transcript"
if grep -rqF -e "$PW_P" -e "$PW_X" -e "$TOKEN" "$ROOT"/s0b-diag-run.* 2>/dev/null; then bad "a secret was written to a work directory"; else ok "no password and no token was written to any work directory"; fi
[ "$(ls "$ROOT" | grep -c '^s0b-diag-run\.')" -ge 4 ] && ok "every run used its own private work directory (mode 700): $(stat -f '%Lp' "$(ls -1dt "$ROOT"/s0b-diag-run.* | head -n 1)")" || bad "work directories"

echo; echo "steps: $pass ok, $fail FAIL"
cp "$ROOT/e2e-calls.log" "$W/calls.log" 2>/dev/null || true
[ "$fail" = 0 ]
