#!/bin/bash
# REHEARSAL - NEVER MERGE. The S1 apply script's cases. Sourced by test-macos.sh (synthetic bundle, real Postgres, macOS arm64,
# real darwin supabase-go) and test-linux.sh (the REAL bundle and 34 files, local Supavisor behind a TLS relay, real linux supabase-go).
# The script under test is the REAL s1-apply.sh; the test copy differs only in the lines fixture.py reports (pins, URL, ref,
# embedded list, and the platform check on Linux). The password is typed through a pty with echo off.
# The caller defines: MODE (syn|real), T, HERE, GOBIN, URLTEST, REFTEST, PW_OK, NOPLAT (""|--no-platform), BASEPKG, GO34FILE,
# and functions db_reset_state, db_hist_count, db_hist_max, db_hist_add V, db_hist_del V, db_table_exists NAME, conn_count.
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
PW_BAD="WRONG-CANARY-5d41"
LEFT="LEFTOVER-CANARY-9a7c"
A_RP='{now-60}'; A_W1=yes; A_W2=yes; A_PW="$PW_OK"; A_GO=APPLY
PINS_FROM=""   # a pkg dir whose pins.env the test copy should use (forged-consistent bundles); empty = the base package

mkfix() { # mkfix NAME PKGDIR [bin]  -> F
  F="$T/$1"; rm -rf "$F"; mkdir -p "$F/home/hone-s1/supabase-cli" "$F/pkg"
  chmod 700 "$F/home/hone-s1"; chmod 755 "$F/home/hone-s1/supabase-cli"
  cp "${3:-$GOBIN}" "$F/home/hone-s1/supabase-cli/supabase-go"; chmod 755 "$F/home/hone-s1/supabase-cli/supabase-go"
  cp "$2/migrations-d189768b.tar" "$2/MIGRATIONS-d189768b.sha256" "$F/pkg/"
  local pf="${PINS_FROM:-$2}"
  local bsha lsha gsha
  bsha=$(sed -n 's/^BUNDLE_SHA=//p' "$pf/pins.env"); lsha=$(sed -n 's/^LIST_SHA=//p' "$pf/pins.env")
  gsha=$(sha "$F/home/hone-s1/supabase-cli/supabase-go")
  python3 -I "$HERE/fixture.py" copy "$HERE/s1-apply.sh" "$F/pkg/s1-apply.sh" --go-sha "$gsha" --bundle-sha "$bsha" --list-sha "$lsha" \
    --ref "$REFTEST" --url "$URLTEST" --go34 "$GO34FILE" $NOPLAT > "$F/rewrites.txt" || { echo "fixture.py failed"; exit 1; }
}
answers() { # answers FILE
  printf 'Pre-migration PITR restore point\t%s\nprinted the word  armed\t%s\nprinted the word  watching\t%s\nDatabase password\t%s\nType  APPLY\t%s\n' \
    "$A_RP" "$A_W1" "$A_W2" "$A_PW" "$A_GO" > "$1"
}
runk() { # runk EXTRA_ENV_ASSIGNMENT(optional)  -> RC, CONN (delta), transcript at $F/transcript.txt
  answers "$F/answers.tsv"
  local c0 c1
  c0=$(conn_count)
  ( while :; do ps -axww -o command= 2>/dev/null | grep -E 'hone-s1/supabase-cli/supabase-go|pkg/s1-apply\.sh'; sleep 0.05; done > "$F/ps.txt" ) & local sp=$!
  S1D_HOME="$F/home" S1D_EXTRA="${1:-}" python3 -I "$HERE/driver.py" "$F/transcript.txt" "$F/answers.tsv" -- /bin/bash "$F/pkg/s1-apply.sh"
  RC=$?
  kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
  c1=$(conn_count); CONN=$((c1 - c0))
}
has() { grep -qF -- "$1" "$F/transcript.txt"; }
leak_scan() { # the typed passwords and the leftover canary appear nowhere on disk, in the transcript or in any process listing
  local hits
  hits=$(grep -rlF -e "$PW_OK" -e "$PW_BAD" -e "$LEFT" "$F" 2>/dev/null | grep -v "/answers.tsv$" | tr '\n' ' ')
  [ -z "$hits" ] && ok "$1: no password or canary in any log, transcript, process listing or file" || bad "$1: secret found in: $hits"
}
refused() { # refused NAME "text" : exit 1, the text is shown, zero connections, nothing applied, no APPLIED line
  [ "$RC" = 1 ] && has "$2" && [ "$CONN" = 0 ] && ! has "S1 APPLIED" && ok "$1: refused with '$2'; exit 1; zero connection attempts" || bad "$1: expected refusal '$2'" "rc=$RC conn=$CONN $(tail -c 400 "$F/transcript.txt" | tr '\r\n' '  ')"
  leak_scan "$1"
}

REAL_NOTE="synthetic bundle"; [ "$MODE" = real ] && REAL_NOTE="the REAL bundle and 34 files"

echo "== static: the real script"
bash -n "$HERE/s1-apply.sh" && ok "bash -n s1-apply.sh" || bad "syntax"
if grep -nE '^[^#]*[A-Za-z0-9_"]+ +# ' "$HERE/s1-apply.sh" | grep -vE '^[0-9]+:\s*#' | grep -E 'printf|export|unset|\bdie\b' > /dev/null; then bad "inline comment after a command"; else ok "no inline comment follows a command (Insurance X1)"; fi
grep -nE '^[^#]*\benv\b *\|? *grep|^[^#]*\bprintenv|^[^#]*\bset +-x|^[^#]*echo +"?\$PW|^[^#]*printf .*\$PW' "$HERE/s1-apply.sh" > /dev/null && bad "the script could print environment values or the password" || ok "no env|grep value print, no set -x, no echo of the password"
[ "$(grep -c 'PGPASSWORD="' "$HERE/s1-apply.sh")" = 1 ] && grep -B1 'PGPASSWORD="' "$HERE/s1-apply.sh" | grep -q 'local lf=' && ok "PGPASSWORD is assigned exactly once, as a prefix to the CLI child inside run_cli (not exported to the shell)" || bad "PGPASSWORD assignment"
[ "$(grep -v '^ *#' "$HERE/s1-apply.sh" | grep -c 'read -rs')" = 1 ] && ok "exactly one hidden read (the password)" || bad "hidden reads"
[ "$(grep -c 'run_cli "\$[A-Z]*" db push' "$HERE/s1-apply.sh")" = 2 ] && ok "exactly two CLI invocations in the script: one dry run, one push" || bad "CLI invocation count"
[ "$(grep -E '^H0214=' "$HERE/s1-apply.sh" | cut -d= -f2)" = a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b ] && ok "H0214 is a8bdcefe (P-2)" || bad "H0214"
[ "$(grep -E '^GO_SHA=' "$HERE/s1-apply.sh" | cut -d= -f2)" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && ok "GO_SHA is the recorded supabase-go dce26b75" || bad "GO_SHA"
[ "$(grep -E '^BUNDLE_SHA=' "$HERE/s1-apply.sh" | cut -d= -f2)" = "$(sha "$HERE/migrations-d189768b.tar")" ] && [ "$(grep -E '^LIST_SHA=' "$HERE/s1-apply.sh" | cut -d= -f2)" = "$(sha "$HERE/MIGRATIONS-d189768b.sha256")" ] && ok "the script's bundle and list pins equal the committed files' sha256" || bad "bundle/list pins differ from the committed files"
grep -q '^URL="postgresql://postgres\.\$REF@aws-1-us-east-1\.pooler\.supabase\.com:5432/postgres?sslmode=require"$' "$HERE/s1-apply.sh" && ok "the URL is the session pooler (5432), user only, sslmode=require, no password, no options" || bad "URL line"

echo "== the bundle itself (real files)"
tar -tf "$HERE/migrations-d189768b.tar" | sed 's#/$##' | grep -Evx 'supabase|supabase/migrations|supabase/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql' | head -1 | grep -q . && bad "bundle holds a foreign entry" || ok "the committed bundle holds only supabase/migrations/NNNN_name.sql"
[ "$(tar -tf "$HERE/migrations-d189768b.tar" | grep -c '\.sql$')" = 245 ] && ok "245 files" || bad "file count"
tar -tf "$HERE/migrations-d189768b.tar" | sed -n 's#.*/\([0-9][0-9][0-9][0-9]\)_.*#\1#p' | sort | tail -1 | grep -qx 0246 && ok "highest version in the bundle is 0246" || bad "highest version"
grep -q '^a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b  0214_' "$HERE/MIGRATIONS-d189768b.sha256" && ok "0214 = a8bdcefe in the manifest" || bad "0214"

echo "== cases ($REAL_NOTE; CLI: $("$GOBIN" --version 2>&1 | tail -1))"
db_reset_state

# ---- refusals BEFORE any connection -------------------------------------------------------------------------------------
mkfix env-leftover "$BASEPKG"; runk "SUPABASE_DB_PASSWORD=$LEFT"
refused "env leftover" "unset these variables first (names only): SUPABASE_DB_PASSWORD"
! has "$LEFT" && ok "env leftover: the variable's VALUE is never printed" || bad "env leftover value printed"

mkfix no-armed "$BASEPKG"; A_W1=no; runk; A_W1=yes
refused "watchdog 'armed' not confirmed" "watchdog 'armed' not confirmed"
! has "Database password" && ok "watchdog: the password prompt is never reached" || bad "password asked before the confirmations"
mkfix no-watching "$BASEPKG"; A_W2=no; runk; A_W2=yes
refused "watchdog 'watching' not confirmed" "watchdog 'watching' not confirmed"
mkfix bad-rp "$BASEPKG"; A_RP='yesterday'; runk; A_RP='{now-60}'
refused "restore point malformed" "restore point is not YYYY-MM-DDTHH:MM:SSZ"
mkfix future-rp "$BASEPKG"; A_RP='{now+3600}'; runk; A_RP='{now-60}'
refused "restore point in the future" "restore point is in the future"
mkfix empty-pw "$BASEPKG"; A_PW=''; runk; A_PW="$PW_OK"
refused "empty password" "empty password; nothing was attempted"

mkfix bin-bad "$BASEPKG"; printf 'x' >> "$F/home/hone-s1/supabase-cli/supabase-go"
# the test copy pinned the ORIGINAL binary's sha; the appended byte makes it differ
runk; refused "binary altered" "supabase-go missing or sha256 mismatch"

for v in tamper add247 add247-list drop alter link; do
  python3 -I "$HERE/fixture.py" vary "$BASEPKG" "$T/var-$v" "$v" 2> /dev/null
done
mkfix v-tamper "$T/var-tamper"; runk
refused "tampered bundle (one byte)" "migrations-d189768b.tar sha256 mismatch"
PINS_FROM="$T/var-add247"; mkfix v-add247 "$T/var-add247"; PINS_FROM=""; runk
refused "a 0247 file added to the bundle (pins forged to match)" "holds a file above 0246: version 0247"
PINS_FROM="$T/var-add247-list"; mkfix v-add247l "$T/var-add247-list"; PINS_FROM=""; runk
refused "0247 added to bundle AND list (pins forged to match)" "names a file above 0246: 0247"
PINS_FROM="$T/var-drop"; mkfix v-drop "$T/var-drop"; PINS_FROM=""; runk
refused "a file missing from the bundle (pins forged to match)" "is missing files that"
PINS_FROM="$T/var-alter"; mkfix v-alter "$T/var-alter"; PINS_FROM=""; runk
refused "a pending file altered, bundle and list forged consistently" "differ from the GO package list"
PINS_FROM="$T/var-link"; mkfix v-link "$T/var-link"; PINS_FROM=""; runk
refused "a symlink entry in the bundle (pins forged to match)" "holds a link or special entry"

STUB="$T/stub-supabase-go"
printf '#!/bin/sh\necho "Initialising login role..." >&2\nexit 0\n' > "$STUB"; chmod 755 "$STUB"
mkfix login-role "$BASEPKG" "$STUB"; runk
[ "$RC" = 1 ] && has "the CLI reported a login-role / ban / password / Management API path" && ! has "S1 APPLIED" && ok "login-role text in the CLI output: STOP and REPORT (stub CLI prints it; exit 1)" || bad "login-role scan" "rc=$RC $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"

# ---- connection cases -----------------------------------------------------------------------------------------------------
db_reset_state
mkfix wrong-pw "$BASEPKG"; A_PW="$PW_BAD"; runk; A_PW="$PW_OK"
if [ "$RC" = 1 ] && has "the dry run failed" && [ "$CONN" = 1 ] && [ ! -e "$F"/home/hone-s1/s1apply.*/logs/push.log ] && [ "$(db_hist_count)" = 211 ] && ! has "S1 APPLIED"; then
  ok "wrong password: exactly ONE connection attempt, exit 1, no push, nothing applied (history still 211)"
else bad "wrong password" "rc=$RC conn=$CONN hist=$(db_hist_count) $(tail -c 400 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
leak_scan "wrong password"

mkfix no-apply "$BASEPKG"; A_GO=no; runk; A_GO=APPLY
if [ "$RC" = 1 ] && has "Dry run OK: exactly 34 migrations" && has "not confirmed (type exactly: APPLY)" && [ "$CONN" = 1 ] && [ "$(db_hist_count)" = 211 ]; then
  ok "APPLY not typed: the dry run listed 34, then STOP; one connection; nothing applied"
else bad "no APPLY" "rc=$RC conn=$CONN hist=$(db_hist_count)"; fi

db_hist_add 0213
mkfix dry33 "$BASEPKG"; runk
if [ "$RC" = 1 ] && has "the dry run lists 33 migrations, expected exactly 34" && [ "$CONN" = 1 ] && [ "$(db_hist_count)" = 212 ]; then ok "dry run lists 33: STOP before any push; history unchanged"; else bad "dry33" "rc=$RC conn=$CONN $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
db_hist_del 0213
if [ "$MODE" = syn ]; then
  db_hist_del 0212
  mkfix dry35 "$BASEPKG"; runk
  if [ "$RC" = 1 ] && has "the dry run lists 35 migrations, expected exactly 34" && [ "$CONN" = 1 ] && [ "$(db_hist_count)" = 210 ]; then ok "dry run lists 35: STOP before any push; history unchanged"; else bad "dry35" "rc=$RC conn=$CONN $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
  db_hist_add 0212
fi

if [ "$MODE" = syn ]; then
  python3 -I "$HERE/fixture.py" syn "$T/syn-fail" --fail 0230
  db_reset_state
  GO34FILE_SAVE="$GO34FILE"; GO34FILE="$T/syn-fail/go34.txt"
  mkfix fail-mig "$T/syn-fail"; runk
  GO34FILE="$GO34FILE_SAVE"
  n=$(db_hist_count)
  if [ "$RC" = 1 ] && has "the push failed" && has "Do NOT rerun this script" && ! has "S1 APPLIED" && [ "$n" = 228 ] && [ "$(db_hist_max)" = 0229 ] && db_table_exists s1_t0229 && ! db_table_exists s1_t0230 && ! db_table_exists s1_t0231; then
    ok "a failing migration (0230): the push stops; ONLY 0213..0229 are recorded (history 228, max 0229); 0230 not applied, 0231.. never run; exit 1; 'do NOT rerun'"
  else bad "failing migration" "rc=$RC hist=$n max=$(db_hist_max) $(tail -c 500 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
  leak_scan "failing migration"
fi

# ---- the happy path (last: it applies) ----------------------------------------------------------------------------------
db_reset_state
mkfix happy "$BASEPKG"; runk
W=$(ls -d "$F"/home/hone-s1/s1apply.* 2>/dev/null | head -1)
if [ "$RC" = 0 ] && has "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order" && [ "$(db_hist_count)" = 245 ] && [ "$(db_hist_max)" = 0246 ]; then
  ok "happy path ($REAL_NOTE): exit 0; dry run listed exactly 34; push applied 34 in order; history = 245 rows, max 0246"
else bad "happy path" "rc=$RC hist=$(db_hist_count) max=$(db_hist_max) $(tail -c 600 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
[ "$CONN" = 2 ] && ok "happy path: exactly 2 connection attempts (one dry run, one push)" || bad "connection attempts: $CONN"
[ "$(grep -c '^Applying migration ' "$W/logs/push.log" 2>/dev/null)" = 34 ] && grep -qx 'Finished supabase db push.' "$W/logs/push.log" && ok "push log: 34 'Applying migration' lines and the finish line" || bad "push log shape"
grep -q 'Connecting to remote database' "$W/logs/dry-run.log" && grep -q 'Connecting to remote database' "$W/logs/push.log" && ok "both CLI runs treated the target as REMOTE (not the local-stack path)" || bad "remote/local classification"
[ -z "$(find "$W" ! -user "$(id -un)" -o -perm -040 -o -perm -004 2>/dev/null | head -1)" ] && ok "work dir, logs and project dir are private (no group/other access)" || bad "permissions: $(find "$W" -perm -040 -o -perm -004 | head -3)"
grep -q 'db push' "$F/ps.txt" && ok "process sampler saw the CLI run (the argv check below is not vacuous)" || bad "sampler never saw the CLI"
! grep -qF -e "$PW_OK" "$F/ps.txt" && ok "the password never appeared in any process argv (sampled every 50 ms)" || bad "password in argv"
leak_scan "happy path"
find "$W/project" -type f ! -path "*/supabase/migrations/*" | sed "s#$W/project/##" | tr '\n' ' ' | sed 's/^/files outside migrations in the project dir: /; s/$/\n/' | tee -a "$F/info.txt"
echo "-- rewrites in the test copy: $(cat "$F/rewrites.txt")"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
