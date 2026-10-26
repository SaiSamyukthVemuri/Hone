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
# PW_PATTERN: what a leak looks like. A canary password is searched for verbatim; the Linux stack's own password is the common word
# "postgres", so there the patterns are the password-bearing forms (PGPASSWORD=, user:password@, password=) plus the canaries.
: "${PW_PATTERN:=$PW_OK|$PW_BAD|$LEFT}"
A_RP=""; A_WS=""; A_WE=""; A_W1=yes; A_W2=yes; A_PW="$PW_OK"; A_GO=APPLY
R4_AGE=600; R4_NONE=""; R4_VERDICT="OVERALL PASS"
iso_at() { python3 -I -c 'import sys,datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(seconds=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
PINS_FROM=""   # a pkg dir whose pins.env the test copy should use (forged-consistent bundles); empty = the base package

setmtime() { python3 -I -c 'import os,sys,time;t=time.time()-int(sys.argv[2]);os.utime(sys.argv[1],(t,t))' "$1" "$2"; }
r4sel() { sed -n 's/^ *"selected_at_utc": "\([^"]*\)".*/\1/p' "$F/home/hone-s1/row4.$1/row4-attestation.json"; }
r4extra() { # r4extra NAME SEL_AGE_S VERDICT_TEXT|none MTIME_AGE_S  (an extra row-4 run in the current fixture; VERDICT none = a run that left no files)
  local d="$F/home/hone-s1/row4.$1"; mkdir -p "$d"; chmod 700 "$d"
  if [ "$3" != none ]; then
    printf '{\n  "pre_migration_restore_point": {\n    "selected_at_utc": "%s",\n    "basis": "latest_at_or_after"\n  }\n}\n' "$(iso_at "$((0 - $2))")" > "$d/row4-attestation.json"
    printf 'x\n%s\n' "$3" > "$d/verdict.txt"
  fi
  setmtime "$d" "$4"
}
mkfix() { # mkfix NAME PKGDIR [bin]  -> F
  F="$T/$1"; rm -rf "$F"; mkdir -p "$F/home/hone-s1/supabase-cli" "$F/pkg"
  chmod 700 "$F/home/hone-s1"; chmod 755 "$F/home/hone-s1/supabase-cli"
  cp "${3:-$GOBIN}" "$F/home/hone-s1/supabase-cli/supabase-go"; chmod 755 "$F/home/hone-s1/supabase-cli/supabase-go"
  cp "$2/migrations-d189768b.tar" "$2/MIGRATIONS-d189768b.sha256" "$F/pkg/"
  R4_SEL=$(iso_at "$((0 - R4_AGE))")
  if [ -z "$R4_NONE" ]; then   # the result window-row4.sh leaves: $HOME/hone-s1/row4.XXXXXX/{row4-attestation.json,verdict.txt}
    mkdir -p "$F/home/hone-s1/row4.AbC123"; chmod 700 "$F/home/hone-s1/row4.AbC123"
    printf '{\n  "pre_migration_restore_point": {\n    "selected_at_utc": "%s",\n    "basis": "latest_at_or_after"\n  },\n  "g4_pitr": {}\n}\n' "$R4_SEL" > "$F/home/hone-s1/row4.AbC123/row4-attestation.json"
    printf 'PASS x\n%s\n' "$R4_VERDICT" > "$F/home/hone-s1/row4.AbC123/verdict.txt"
    setmtime "$F/home/hone-s1/row4.AbC123" 300
  fi
  local pf="${PINS_FROM:-$2}"
  local bsha lsha gsha
  bsha=$(sed -n 's/^BUNDLE_SHA=//p' "$pf/pins.env"); lsha=$(sed -n 's/^LIST_SHA=//p' "$pf/pins.env")
  gsha=$(sha "$F/home/hone-s1/supabase-cli/supabase-go")
  python3 -I "$HERE/fixture.py" copy "$HERE/s1-apply.sh" "$F/pkg/s1-apply.sh" --go-sha "$gsha" --bundle-sha "$bsha" --list-sha "$lsha" \
    --ref "$REFTEST" --url "$URLTEST" ${GO34FILE:+--go34 "$GO34FILE"} $NOPLAT > "$F/rewrites.txt" || { echo "fixture.py failed"; exit 1; }
}
answers() { # answers FILE   (the order of the prompts is the script's: window start, restore point, password, watchdog x2, APPLY)
  printf 'Window start (UTC)\t%s\nWindow end (UTC)\t%s\nexactly as row 4 printed it\t%s\nDatabase password\t%s\narmed  (type yes)\t%s\nsession to start  (type yes)\t%s\nType  APPLY\t%s\n' \
    "${A_WS:-$(iso_at -3600)}" "${A_WE:-$(iso_at 7200)}" "${A_RP:-$R4_SEL}" "$A_PW" "$A_W1" "$A_W2" "$A_GO" > "$1"
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
  hits=$(grep -rlaE --exclude=supabase-go --exclude="*.tar" -e "$PW_PATTERN" "$F" 2>/dev/null | grep -v "/answers.tsv$" | tr '\n' ' ')
  grep -qaE "Database password \(not shown\): *($PW_OK|$PW_BAD)" "$F/transcript.txt" 2>/dev/null && hits="$hits transcript-echo"
  [ -z "$hits" ] && ok "$1: no password or canary in any log, transcript, process listing or file" || bad "$1: secret found in: $hits"
}
refused() { # refused NAME "text" : exit 1, the text is shown, zero connections, nothing applied, no APPLIED line
  [ "$RC" = 1 ] && has "$2" && [ "$CONN" = 0 ] && ! has "S1 APPLIED" && ok "$1: refused with '$2'; exit 1; zero connection attempts" || bad "$1: expected refusal '$2'" "rc=$RC conn=$CONN $(tail -c 400 "$F/transcript.txt" | tr '\r\n' '  ')"
  leak_scan "$1"
}

refused_after_dry() { # refused_after_dry NAME "text" : dry run happened (one connection, 34 listed), then STOP; no push; nothing applied
  [ "$RC" = 1 ] && has "$2" && has "Dry run OK: exactly 34" && [ "$CONN" = 1 ] && [ ! -e "$F"/home/hone-s1/s1apply.*/logs/push.log ] && [ "$(db_hist_count)" = 211 ] && ! has "S1 APPLIED" && ok "$1: dry run listed 34, then '$2'; exit 1; one connection; no push; history still 211" || bad "$1: expected '$2' after the dry run" "rc=$RC conn=$CONN hist=$(db_hist_count) $(tail -c 400 "$F/transcript.txt" | tr '\r\n' '  ')"
  leak_scan "$1"
}
ln1() { grep -n -F -m1 -- "$1" "$F/transcript.txt" | cut -d: -f1; }

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

[ -z "$(grep -nE '/tmp|\$\$' "$HERE/s1-apply.sh")" ] && ok "F5: no /tmp path and no PID-named file in the script (temp files are inside the private work dir)" || bad "F5: /tmp or \$\$ in the script"
grep -q 'Do not press Ctrl-C or close this window during the push; the only way to stop a statement is the watchdog.' "$HERE/s1-apply.sh" && [ "$(grep -c 'Do not press Ctrl-C or close this window during the push; the only way to stop a statement is the watchdog.' "$HERE/s1-apply.sh")" = 2 ] && ok "F3: the Ctrl-C warning is printed before APPLY and is in the INT trap message" || bad "F3 text"
echo "== the embedded GO list and the environment scan (real script)"
sed -n "/^GO34='/,/sql'\$/p" "$HERE/s1-apply.sh" | sed "s/^GO34='//; s/'\$//" > "$T/embedded-go34.txt"
[ "$(grep -c '' "$T/embedded-go34.txt")" = 34 ] && ok "the script embeds 34 lines" || bad "embedded list lines: $(grep -c '' "$T/embedded-go34.txt")"
awk '{v=substr($2,1,4); if (v+0>=213 && v+0<=246) print}' "$HERE/MIGRATIONS-d189768b.sha256" | diff -q "$T/embedded-go34.txt" - > /dev/null && ok "the embedded 34 lines equal the 0213..0246 lines of MIGRATIONS-d189768b.sha256 byte for byte" || bad "embedded GO34 differs from the manifest"
[ "$(sha "$HERE/G3-CHECKSUMS-d189768b.txt")" = bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6 ] && ok "G3-CHECKSUMS-d189768b.txt (the GO package list, bbdcd917) is the committed copy" || bad "G3 file sha"
sed 's#[^ ]*/##' "$HERE/G3-CHECKSUMS-d189768b.txt" | sed 's/  */  /' | diff -q "$T/embedded-go34.txt" - > /dev/null && ok "the embedded 34 lines equal the GO package checksums (G3, paths stripped), in the same order" || bad "embedded GO34 differs from the G3 list"
[ "$(grep -E '^bad=' "$HERE/s1-apply.sh" | grep -o "grep -E '[^']*'")" = "$(grep -o "grep -E '[^']*'" "$HERE/s0a-env-regex.txt")" ] && ok "the environment-scan regex is identical to window-s0a.sh's (source sha 02290ee1)" || bad "environment regex differs from window-s0a.sh"

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

R4_NONE=1 mkfix rp-none "$BASEPKG"; runk
refused "F1 no row-4 result on the Mac" "no row-4 result was found"
R4_VERDICT="OVERALL FAIL" mkfix rp-failverdict "$BASEPKG"; runk
refused "F1 the only row-4 run was refused" "the latest row-4 run was refused"
mkfix g1-latest-refused "$BASEPKG"; r4extra NEWREFUSED 400 "OVERALL FAIL" 100; runk
refused "G1 pass at T1, REFUSED at T2 (newer): the older pass is not used" "the latest row-4 run was refused"
mkfix g1-latest-unfinished "$BASEPKG"; r4extra NEWEMPTY 0 none 100; runk
refused "G1 a newer row-4 run that left no result (did not finish)" "the latest row-4 run was refused (or did not finish)"
mkfix g1-newer-pass "$BASEPKG"; r4extra NEWPASS 400 "OVERALL PASS" 100; A_RP=$(r4sel NEWPASS); A_GO=no; runk; A_RP=""; A_GO=APPLY
refused_after_dry "G1 two passing runs: the newer one is used (typed point = the newer's)" "not confirmed (type exactly: APPLY)"
mkfix g1-older-typed "$BASEPKG"; r4extra NEWPASS2 400 "OVERALL PASS" 100; runk
refused "G1 two passing runs: typing the OLDER point is refused" "not the one in the row-4 result"
R4_VERDICT="OVERALL FAIL" mkfix g1-pass-after-refused "$BASEPKG"; r4extra LATERPASS 400 "OVERALL PASS" 100; A_RP=$(r4sel LATERPASS); A_GO=no; runk; A_RP=""; A_GO=APPLY
refused_after_dry "G1 refused at T1, PASS at T2 (newer): accepted" "not confirmed (type exactly: APPLY)"
mkfix we-before "$BASEPKG"; A_WS=$(iso_at -30); A_WE=$(iso_at -60); runk; A_WS=""; A_WE=""
refused "G3 window end not after the window start" "the window end is not after the window start"
mkfix rp-typo "$BASEPKG"; A_RP='yesterday'; runk; A_RP=""
refused "F1 restore point typed malformed" "restore point is not YYYY-MM-DDTHH:MM:SSZ"
mkfix rp-mismatch "$BASEPKG"; A_RP=$(iso_at -700); runk; A_RP=""
refused "F1 typed point differs from row 4's" "not the one in the row-4 result"
R4_AGE=3000 mkfix rp-stale "$BASEPKG"; runk
refused "F1 restore point older than 45 minutes" "older than 45 minutes"
R4_AGE=-3600 mkfix rp-future "$BASEPKG"; runk
refused "F1 restore point in the future" "restore point is in the future"
mkfix rp-beforewin "$BASEPKG"; A_WS=$(iso_at -300); runk; A_WS=""
refused "F1 restore point before the typed window start" "restore point is before the window start"
mkfix empty-pw "$BASEPKG"; A_PW=''; runk; A_PW="$PW_OK"
refused "empty password" "empty password; nothing was attempted"

mkfix bin-bad "$BASEPKG"; printf 'x' >> "$F/home/hone-s1/supabase-cli/supabase-go"
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
[ "$RC" = 1 ] && has "the CLI reported a login-role / ban / password / Management API path" && ! has "S1 APPLIED" && ok "login-role text in the dry-run output: STOP and REPORT (stub CLI prints it; exit 1)" || bad "login-role scan" "rc=$RC $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"

# stub CLI for the push phase: the dry run lists the expected 34, the push answers with an authentication failure
STUB2="$T/stub-push-auth"
{ printf '#!/bin/sh\ncase "$*" in *--dry-run*) echo "DRY RUN: migrations will *not* be pushed to the database." >&2; echo "Connecting to remote database..." >&2; echo "Would push these migrations:" >&2\n'
  awk '{printf "echo \" \342\200\242 %s\" >&2\n", $2}' "$T/embedded-go34.txt"
  echo 'echo "Finished supabase db push."; exit 0;; esac'
  echo 'echo '"'"'failed to connect to postgres: failed SASL auth (FATAL: password authentication failed for user "postgres.secretref" (SQLSTATE 28P01)) host=db.secretref.supabase.com'"'"' >&2'
  echo 'exit 1'; } > "$STUB2"; chmod 755 "$STUB2"
mkfix push-auth "$BASEPKG" "$STUB2"; runk
TF="$F/home/hone-s1/s1-apply/FAILED-LOGIN"
if [ "$RC" = 1 ] && has "The push may already have applied: do the S1 read-back before anything else" && [ -f "$TF" ] && grep -q 'phase push' "$TF" && ! has "secretref"; then ok "TOMBSTONE: an authentication failure in the push wrote FAILED-LOGIN (UTC time + phase push), said the push may already have applied, and masked user/host in the echoed tail"; else bad "push-phase tombstone" "rc=$RC $(tail -c 500 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
runk
refused "TOMBSTONE: the next run" "a previous run failed a login"

# ---- order, watchdog, confirmation (the dry run comes first) --------------------------------------------------------
db_reset_state
mkfix no-armed "$BASEPKG"; A_W1=no; runk; A_W1=yes
refused_after_dry "F2 watchdog 'armed' not confirmed" "watchdog 'armed' not confirmed"
mkfix no-watching "$BASEPKG"; A_W2=no; runk; A_W2=yes
refused_after_dry "F2 watchdog 'watching' not confirmed" "watchdog 'watching' not confirmed"
mkfix no-apply "$BASEPKG"; A_GO=no; runk; A_GO=APPLY
refused_after_dry "APPLY not typed" "not confirmed (type exactly: APPLY)"
mkfix g3-short "$BASEPKG"; A_WE=$(iso_at 4200); runk; A_WE=""
refused_after_dry "G3 only 70 minutes of the window remain at APPLY" "fewer than 75 minutes of the window remain"
mkfix ctrlc "$BASEPKG"; A_GO='^C'; runk; A_GO=APPLY
if [ "$RC" = 130 ] && has "Do not press Ctrl-C or close this window during the push; the only way to stop a statement is the watchdog." && [ "$(db_hist_count)" = 211 ]; then ok "F3: Ctrl-C at the APPLY prompt: the trap message carries the warning; exit 130; nothing applied"; else bad "ctrl-c trap" "rc=$RC $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"; fi

# ---- connection cases -----------------------------------------------------------------------------------------------------
mkfix wrong-pw "$BASEPKG"; A_PW="$PW_BAD"; runk; A_PW="$PW_OK"
TF="$F/home/hone-s1/s1-apply/FAILED-LOGIN"
if [ "$RC" = 1 ] && has "the dry run failed" && [ "$CONN" = 1 ] && [ ! -e "$F"/home/hone-s1/s1apply.*/logs/push.log ] && [ "$(db_hist_count)" = 211 ] && ! has "S1 APPLIED"; then
  ok "wrong password: exactly ONE connection attempt, exit 1, no push, nothing applied (history still 211)"
else bad "wrong password" "rc=$RC conn=$CONN hist=$(db_hist_count) $(tail -c 400 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
[ -f "$TF" ] && grep -qE '^failed login at [0-9T:Z-]+ in phase dry-run$' "$TF" && ok "TOMBSTONE: the wrong password wrote FAILED-LOGIN (UTC time + phase dry-run, nothing else)" || bad "dry-run tombstone: $(cat "$TF" 2>/dev/null)"
leak_scan "wrong password"
runk
refused "TOMBSTONE: a re-run after a failed login" "a previous run failed a login"
! has "Window start" && ok "TOMBSTONE: the re-run asked nothing (refused before any prompt)" || bad "tombstone: prompts shown"

db_hist_add 0213
mkfix dry33 "$BASEPKG"; runk
if [ "$RC" = 1 ] && has "the dry run lists 33 migrations, expected exactly 34" && [ "$CONN" = 1 ] && [ "$(db_hist_count)" = 212 ] && ! has "START THE WATCHDOG"; then ok "dry run lists 33: STOP before the watchdog step and any push; history unchanged"; else bad "dry33" "rc=$RC conn=$CONN $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
db_hist_del 0213
if [ "$MODE" = syn ]; then
  db_hist_del 0212
  mkfix dry35 "$BASEPKG"; runk
  if [ "$RC" = 1 ] && has "the dry run lists 35 migrations, expected exactly 34" && [ "$CONN" = 1 ] && [ "$(db_hist_count)" = 210 ]; then ok "dry run lists 35: STOP before any push; history unchanged"; else bad "dry35" "rc=$RC conn=$CONN $(tail -c 300 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
  db_hist_add 0212

  python3 -I "$HERE/fixture.py" syn "$T/syn-fail" --fail 0230
  db_reset_state
  GO34FILE_SAVE="$GO34FILE"; GO34FILE="$T/syn-fail/go34.txt"
  mkfix fail-mig "$T/syn-fail"; runk
  GO34FILE="$GO34FILE_SAVE"
  n=$(db_hist_count)
  if [ "$RC" = 1 ] && has "the push failed" && has "The push may already have applied: do the S1 read-back before anything else" && has "Do NOT rerun this script" && ! has "S1 APPLIED" && [ "$n" = 228 ] && [ "$(db_hist_max)" = 0229 ] && db_table_exists s1_t0229 && ! db_table_exists s1_t0230 && ! db_table_exists s1_t0231; then
    ok "a failing migration (0230): the push stops; ONLY 0213..0229 are recorded (history 228, max 0229); 0230 not applied, 0231.. never run; exit 1; F4 read-back wording; 'do NOT rerun'"
  else bad "failing migration" "rc=$RC hist=$n max=$(db_hist_max) $(tail -c 500 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
  leak_scan "failing migration"
  [ ! -e "$F/home/hone-s1/s1-apply/FAILED-LOGIN" ] && ok "a failing migration is not an authentication failure: no tombstone" || bad "tombstone written for a migration failure"

  python3 -I "$HERE/fixture.py" syn "$T/syn-slow" --sleep 0230
  db_reset_state
  GO34FILE_SAVE="$GO34FILE"; GO34FILE="$T/syn-slow/go34.txt"
  mkfix cancel57014 "$T/syn-slow"
  ( for _ in $(seq 1 90); do sleep 1; db_cancel_sleep && break; done ) & cpid=$!
  runk; kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null
  GO34FILE="$GO34FILE_SAVE"
  n=$(db_hist_count)
  if [ "$RC" = 1 ] && has "57014" && has "D3 operator runbook, section 5, After a cancel" && has "The push may already have applied" && [ "$n" = 228 ] && [ "$(db_hist_max)" = 0229 ]; then
    ok "F4: a statement cancelled mid-push (57014): exit 1, the message points to the D3 runbook section 5 (After a cancel) and says the push may already have applied; history 228, max 0229"
  else bad "57014 cancel" "rc=$RC hist=$n max=$(db_hist_max) $(tail -c 600 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
fi

# ---- the happy path (last: it applies) ----------------------------------------------------------------------------------
db_reset_state
mkfix happy "$BASEPKG"; runk
W=$(ls -d "$F"/home/hone-s1/s1apply.* 2>/dev/null | head -1)
if [ "$RC" = 0 ] && has "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order" && [ "$(db_hist_count)" = 245 ] && [ "$(db_hist_max)" = 0246 ]; then
  ok "happy path ($REAL_NOTE): exit 0; dry run listed exactly 34; push applied 34 in order; history = 245 rows, max 0246"
else bad "happy path" "rc=$RC hist=$(db_hist_count) max=$(db_hist_max) $(tail -c 600 "$F/transcript.txt" | tr '\r\n' '  ')"; fi
[ "$CONN" = 2 ] && ok "happy path: exactly 2 connection attempts (one dry run, one push)" || bad "connection attempts: $CONN"
a=$(ln1 "Window start (UTC)"); b=$(ln1 "exactly as row 4 printed it"); c=$(ln1 "Database password"); d=$(ln1 "Dry run OK"); e=$(ln1 "START THE WATCHDOG NOW"); f=$(ln1 "armed  (type yes)"); g=$(ln1 "Do not press Ctrl-C or close this window during the push"); h=$(ln1 "Type  APPLY")
[ -n "$a$b$c$d$e$f$g$h" ] && [ "$a" -le "$b" ] && [ "$b" -le "$c" ] && [ "$c" -lt "$d" ] && [ "$d" -lt "$e" ] && [ "$e" -le "$f" ] && [ "$f" -lt "$g" ] && [ "$g" -le "$h" ] && ok "F2/F3 order in the transcript: window start, restore point, password, dry run OK, start-the-watchdog, armed/watching, Ctrl-C warning, APPLY" || bad "prompt order" "$a $b $c $d $e $f $g $h"
[ -n "$W" ] && [ "$(grep -c '^Applying migration ' "$W/logs/push.log" 2>/dev/null)" = 34 ] && grep -qx 'Finished supabase db push.' "$W/logs/push.log" && ok "push log: 34 'Applying migration' lines and the finish line" || bad "push log shape"
grep -q 'Connecting to remote database' "$W/logs/dry-run.log" && grep -q 'Connecting to remote database' "$W/logs/push.log" && ok "both CLI runs treated the target as REMOTE (not the local-stack path)" || bad "remote/local classification"
[ -z "$(find "$W" ! -user "$(id -un)" -o -perm -040 -o -perm -004 2>/dev/null | head -1)" ] && ok "work dir, logs and project dir are private (no group/other access)" || bad "permissions: $(find "$W" -perm -040 -o -perm -004 | head -3)"
[ ! -e "$F/home/hone-s1/s1-apply/FAILED-LOGIN" ] && ok "a successful run leaves no tombstone" || bad "tombstone after success"
grep -q 'db push' "$F/ps.txt" && ok "process sampler saw the CLI run (the argv check below is not vacuous)" || bad "sampler never saw the CLI"
! grep -qaE -e "$PW_PATTERN" "$F/ps.txt" && ok "the password never appeared in any process argv (sampled every 50 ms)" || bad "password in argv"
leak_scan "happy path"
find "$W/project" -type f ! -path "*/supabase/migrations/*" | sed "s#$W/project/##" | tr '\n' ' ' | sed 's/^/files outside migrations in the project dir: /; s/$/\n/' | tee -a "$F/info.txt"
echo "-- rewrites in the test copy: $(cat "$F/rewrites.txt")"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
