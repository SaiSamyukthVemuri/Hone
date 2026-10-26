#!/bin/bash
# REHEARSAL - NEVER MERGE. Tests window-s0a.sh on macOS arm64 against a STUB supabase-go and synthetic results.
# STUBBED: supabase-go (a shell script printing canned JSON, hash substituted into a TEST COPY of the runner), the hosted
# project (there is none), and the typed answers (a pty driver types them). NOT stubbed: the real script logic, the real
# runner logic (only its supabase-go hash constant differs in the test copy), the real pinned comparator and lib (same sha),
# the real 14 gate files and manifest, the real baseline (only runner_sha256 and project_ref_sha256 re-pinned to the test values).
# window-row4.sh is tested the same way (no stub: it makes no hosted call). Typed answers may carry {now-N} tokens that the driver resolves at the moment it types.
# WS_DEV_LINUX=1 (local development only) removes the Darwin/arm64 check from the TEST COPY; CI never sets it.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/window-reads"
T="$(mktemp -d "${TMPDIR:-/tmp}/ws0a.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0; skipped=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TREF=abcdefghijklmnopqrst
TOKEN=TOKEN-SECRET-9f3a1b
PASSWORD=PW-SECRET-77c2de

# static: the REAL script's constants equal the real files (the test copy differs only by sed of these lines)
REAL="$HERE/window-s0a.sh"
st() { grep -E "^$1=" "$REAL" | head -1 | cut -d= -f2; }
[ "$(st RUNNER_SHA)" = "$(sha "$SRC/run-window-read-macos.sh")" ] && [ "$(st MANIFEST_SHA)" = "$(sha "$SRC/MANIFEST.sha256")" ] \
 && [ "$(st CMP_SHA)" = "$(sha "$SRC/compare-preflight.mjs")" ] && [ "$(st LIB_SHA)" = "$(sha "$SRC/compare-preflight-lib.mjs")" ] \
 && [ "$(st BASELINE_SHA)" = "$(sha "$SRC/BASELINE-W1-MACOS-CANDIDATE-3.json")" ] && [ "$(st G3_SHA)" = "$(sha "$SRC/G3-CHECKSUMS-d189768b.txt")" ] && ok "the real script's pins equal the real runner, manifest, comparator, lib, baseline and G3 checksums file" || bad "pins differ from the real files"
want_ref=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.project_ref_sha256)' "$SRC/BASELINE-W1-MACOS-CANDIDATE-3.json")
[ "$(printf '%s' "$(st REF)" | shasum -a 256 | cut -d' ' -f1)" = "$want_ref" ] && ok "the script's project ref hashes to the baseline's project_ref_sha256" || bad "project ref constant differs from the baseline"
bash -n "$REAL" && ok "bash -n (syntax)" || bad "syntax"
ROW4="$HERE/window-row4.sh"
r4st() { grep -E "^$1=" "$ROW4" | head -1 | cut -d= -f2; }
[ "$(r4st CMP_SHA)" = "$(sha "$SRC/compare-preflight.mjs")" ] && [ "$(r4st LIB_SHA)" = "$(sha "$SRC/compare-preflight-lib.mjs")" ] && [ "$(r4st BASELINE_SHA)" = "$(sha "$SRC/BASELINE-W1-MACOS-CANDIDATE-3.json")" ] && ok "window-row4.sh pins equal the real comparator, lib and baseline" || bad "row-4 pins differ"
bash -n "$ROW4" && ok "bash -n window-row4.sh" || bad "row-4 syntax"
DOC="$HERE/WINDOW-COMMAND-MACOS.md"
grep -q "run this script again\|it selects a new time" "$DOC" && bad "the doc still tells Sam to run row 4 again to get a new time" || ok "the doc no longer offers 'run again (it selects a new time)' as a remedy for a quiet database (F1)"
grep -q "Sync the Mac clock" "$DOC" && grep -q "Set time and date automatically" "$DOC" && ok "the doc says to sync the Mac clock (F5)" || bad "no clock-sync line (F5)"
grep -q "Pre-window read-only look" "$DOC" && grep -q "a decision for Sam" "$DOC" && grep -q "base backup not after the reading" "$DOC" && ok "the doc has the pre-window visibility check and the fallback as Sam's decision (F2)" || bad "F2 doc missing"
grep -q "Refresh the dashboard page before you read it" "$DOC" && grep -q "checks again the moment you type" "$DOC" && ok "the doc says to refresh the dashboard page (N2) and that the 90-minute check repeats at ready (N1)" || bad "N1/N2 doc missing"
grep -q "only after .window-s0a.sh. printed .OVERALL PASS" "$DOC" && grep -q "start S1 within 10 minutes" "$DOC" && grep -q "fewer than 90 minutes of the window remain" "$DOC" && ok "the doc says run row 4 only after S0a PASS, start S1 within 10 minutes, and N = 90 (F4)" || bad "F4 doc missing"
grep -q "P_READ=\$(utcnow)" "$REAL" && grep -q "P_READ=\$(utcnow)" "$ROW4" && ! grep -q '^ask P_READ' "$REAL" "$ROW4" && ok "read_at_utc is stamped by date -u at the last prompt in both scripts, not typed (F3)" || bad "F3 not applied"
for f in "$REAL" "$ROW4"; do grep -E '^(text_ok|utc_ok)\(\)' "$f" | grep -vq 'LC_ALL=C' && bad "a validator lacks LC_ALL=C in $f" || ok "text_ok and utc_ok run grep under LC_ALL=C ($(basename "$f"))"; done
if grep -nE '^ask (G3|G4)|Absolute path|backup identifier' "$REAL" >/dev/null; then bad "the typed G3/G4 daily prompts are gone from the script"; else ok "no typed G3 path, head or daily G4 prompt remains"; fi
# X1 class: no paste hazards, nothing to paste at all
if grep -nE '^[^#]*[A-Za-z0-9_"]+ +# ' "$REAL" | grep -v "^.*#!/" | grep -vE "^[0-9]+:\s*#" | grep -E 'printf|export|unset' >/dev/null; then bad "inline comment after a command in the script"; else ok "no inline comment follows a printf/export/unset command"; fi
grep -nE 'SUPABASE_DB_PASSWORD=|SUPABASE_ACCESS_TOKEN=' "$REAL" | grep -v 'read -rs' | grep -vE '^[0-9]+:(#|cleanup|unset)' | grep -qE '=[^ ]' && bad "a secret assignment appears outside read -rs" || ok "secrets are only ever read with read -rs from /dev/tty"

mkfix() { # mkfix NAME  -> sets F (home), prepares the fixture
  F="$T/$1"; mkdir -p "$F/hone-s1/supabase-cli" "$F/hone-s1/window-reads" "$F/res" "$F/g3"
  cp "$SRC"/*.sql "$SRC"/MANIFEST.sha256 "$SRC"/G3-CHECKSUMS-d189768b.txt "$SRC"/compare-preflight.mjs "$SRC"/compare-preflight-lib.mjs "$SRC"/compare-preflight.test.mjs "$F/hone-s1/window-reads/"
  cat > "$F/hone-s1/supabase-cli/supabase-go" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
f=""; while [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done
stem=$(basename "$f" .sql)
[ "${STUB_FAIL-}" = "$stem" ] && { echo "boom: stub failure" >&2; exit 1; }
[ "${STUB_DENY-}" = "$stem" ] && { echo "ERROR: permission denied for table x (42501)" >&2; exit 1; }
cat "$STUB_RESULTS/$stem.json"
STUB
  chmod +x "$F/hone-s1/supabase-cli/supabase-go"
  GOSHA=$(sha "$F/hone-s1/supabase-cli/supabase-go")
  sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$GOSHA/" "$SRC/run-window-read-macos.sh" > "$F/hone-s1/window-reads/run-window-read-macos.sh"
  RSHA=$(sha "$F/hone-s1/window-reads/run-window-read-macos.sh")
  node -e '
    const fs=require("fs"),c=require("crypto");const [src,dst,rsha,ref]=process.argv.slice(1);
    const b=JSON.parse(fs.readFileSync(src));b.runner_sha256=rsha;b.project_ref_sha256=c.createHash("sha256").update(ref).digest("hex");
    fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$SRC/BASELINE-W1-MACOS-CANDIDATE-3.json" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "$RSHA" "$TREF"
  BSHA=$(sha "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json")
  # test copy of the script: only the pins change
  sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$BSHA/" -e "s/^REF=.*/REF=$TREF/" "$REAL" > "$F/window-s0a.test.sh"
  if [ "${WS_DEV_LINUX:-}" = 1 ]; then sed -i 's/^\[ "\$(uname -s)" = Darwin \].*$/true/' "$F/window-s0a.test.sh"; fi
  node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" "${2:-}" "$SRC" || { echo "gen-results failed"; exit 1; }
  : > "$F/stub.log"
}
nowplus() { python3 -c 'import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
blackout() { python3 - "$1" "$2" <<'PY'
import sys, datetime as d
p=lambda s:d.datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ")
a,b=p(sys.argv[1]),p(sys.argv[2])
day=a.replace(hour=0,minute=0,second=0)-d.timedelta(days=1)
while day<=b:
    bs=day+d.timedelta(hours=7,minutes=45); be=day+d.timedelta(hours=10)
    if a<be and b>bs: print("yes"); break
    day+=d.timedelta(days=1)
PY
}
answers() { # answers FILE WSTART WEND  [variant tweaks via env: A_R6CHOICE A_PITRON A_RET A_LATE_AGO A_BASE_AGO]
  local ws="$2" we="$3"
  { printf 'Operator label\tOP-1\nWindow start\t%s\nWindow end\t%s\nCron-job.org\tyes\nPeople hold\tyes\nMaintenance flag\tno_flag\n' "$ws" "$we"
    printf 'PITR enabled\t%s\nPITR retention\t%s\nEarliest recovery point\t%s\nLatest recovery point\t%s\nLatest base backup status\tCOMPLETED\nLatest base backup completed\t%s\nBase backup read from\tmanagement_api\nRecovery range read from\tdashboard\n' "${A_PITRON-true}" "${A_RET-7}" "$(nowplus -1800)" "$(nowplus -${A_LATE_AGO:-10})" "$(nowplus -${A_BASE_AGO:-60})"
    printf 'R-6 choice\t%s\nR-6 answer\tAccept the loss window for the cutover.\nR-6 decision reference\tdecision-ref-1\n0242 disposition (\tR-3\n0242 disposition reference\tdecision-ref-2\n' "${A_R6CHOICE:-accept_rpo}"
    printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD"; } > "$1"
}
runit() { # runit NAME [ENV=VAL ...]  -> OUT=$F/out.txt, RC
  local ans="$F/answers.txt"; shift 0
  RC=0
  python3 "$HERE/driver.py" "$F/out.txt" "$ans" -- env -i PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(node -p process.execPath)") HOME="$F" TERM=dumb STUB_LOG="$F/stub.log" STUB_RESULTS="$F/res" "$@" /bin/bash "$F/window-s0a.test.sh" || RC=$?
  OUT="$F/out.txt"
}
WS=$(nowplus -10); WE=$(nowplus 150)
BLK=$(blackout "$WS" "$WE")

# 1. happy path
if [ -n "$BLK" ]; then skipped=$((skipped+1)); echo "SKIP - happy path and comparator cases: the 160-minute window overlaps 07:45-10:00 UTC (the comparator would, correctly, refuse)"; else
mkfix happy; answers "$F/answers.txt" "$WS" "$WE"; runit
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "happy path: exit 0 and the comparator's OVERALL PASS line" || { bad "happy path" "rc=$RC"; tail -30 "$OUT"; }
echo "--- happy path transcript (tail) ---"; tail -n 40 "$OUT" | cut -c1-200; echo "--- end ---"
[ "$(grep -c . "$F/stub.log")" = 14 ] && ok "happy path: exactly 14 runner calls, one per gate file, in order" || bad "stub call count" "$(grep -c . "$F/stub.log")"
grep -q -- "--agent no db query --linked -o json -f" "$F/stub.log" && ok "the CLI call is db query --linked (no --db-url, no --local)" || bad "CLI call shape"
if grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$F/hone-s1" 2>/dev/null; then bad "a typed secret appears in the terminal output or on disk"; else ok "neither the access token nor the password appears in the output or in any file written"; fi
[ "$(ls "$F"/hone-s1/window.*/results | wc -l | tr -d ' ')" = 28 ] && ok "28 files (14 results + 14 sidecars) in the 0700 results directory" || bad "results dir"
has "$OUT" "does NOT cover the row-4 bracket" && ok "the last lines say the S0a PASS does not cover the row-4 bracket" || bad "no row-4 disclaimer after OVERALL PASS"
[ "$(stat -c %a "$F"/hone-s1/window.* 2>/dev/null || stat -f %Lp "$F"/hone-s1/window.*)" = 700 ] && ok "the work directory is mode 0700" || bad "work dir mode"
fi

refuse() { # refuse NAME EXPECT_RC_NONZERO EXPECT_TEXT
  [ "$RC" != 0 ] && has "$OUT" "$2" && ok "$1" || { bad "$1" "rc=$RC want text [$2]"; tail -8 "$OUT"; }
}
# 2. refusals
mkfix badlib; answers "$F/answers.txt" "$WS" "$WE"; printf '\n// x\n' >> "$F/hone-s1/window-reads/compare-preflight-lib.mjs"; runit
refuse "bad sha: an edited comparator lib is refused before anything runs" "comparator lib missing or sha256 mismatch"
[ ! -s "$F/stub.log" ] && ok "  ... and nothing was read" || bad "  ... stub was called"
mkfix badgate; answers "$F/answers.txt" "$WS" "$WE"; printf -- '-- x\n' >> "$F/hone-s1/window-reads/g06-payment-drain.sql"; runit
refuse "bad sha: an edited gate file is refused" "a gate file does not match MANIFEST.sha256"
mkfix badgo; answers "$F/answers.txt" "$WS" "$WE"; printf '# x\n' >> "$F/hone-s1/supabase-cli/supabase-go"; runit
refuse "bad sha: an altered supabase-go is refused" "supabase-go missing or sha256 mismatch"
mkfix envvar; answers "$F/answers.txt" "$WS" "$WE"; runit SUPABASE_DB_URL=postgres://user:SECRETVALUE@h/db PGHOSTADDR=1.2.3.4 E2E_SUPABASE_URL=http://x HONE_LOCAL_DB_URL=y NODE_OPTIONS=--no-warnings
refuse "leftover env vars are refused (names only)" "unset these variables first (names only): E2E_SUPABASE_URL HONE_LOCAL_DB_URL NODE_OPTIONS PGHOSTADDR SUPABASE_DB_URL"
has "$OUT" SECRETVALUE && bad "  ... a variable VALUE was printed" || ok "  ... no variable value is printed"
mkfix nocli; answers "$F/answers.txt" "$WS" "$WE"; sed -i.bak 's#^printf .%s\\n. v2.102.0 > .*$#true#' "$F/window-s0a.test.sh"; runit
refuse "missing cli-latest is refused" "cli-latest is not v2.102.0"
if [ -z "$BLK" ]; then
mkfix g02; answers "$F/answers.txt" "$WS" "$WE"; node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" g02-0213 "$SRC"; runit
refuse "g02 not at 0212: stopped at the first file" "g02: hosted history max is not 0212"
[ "$(grep -c . "$F/stub.log")" = 1 ] && ok "  ... only g02 was run" || bad "  ... more than one call" "$(grep -c . "$F/stub.log")"
mkfix failfile; answers "$F/answers.txt" "$WS" "$WE"; runit STUB_FAIL=g06-payment-drain
refuse "a failed file stops the run, no retry" "g06-payment-drain.sql failed (exit"
[ "$(grep -c . "$F/stub.log")" = 3 ] && ok "  ... g02, census, g06 were called once each; nothing after g06" || bad "  ... call count" "$(grep -c . "$F/stub.log")"
mkfix denied; answers "$F/answers.txt" "$WS" "$WE"; runit STUB_DENY=g07-sms-claimed-number-duplicates
refuse "a permission denial is reported and stops" "a permission refusal was reported"
mkfix cmpfail; answers "$F/answers.txt" "$WS" "$WE"; node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-3.json" wrong-count "$SRC"; runit
refuse "comparator FAIL: one wrong count -> not exit 0, STOP THE CUTOVER" "the comparator did not print OVERALL PASS"
has "$OUT" "OVERALL FAIL" && ok "  ... the comparator's OVERALL FAIL line is printed verbatim" || bad "  ... no OVERALL FAIL line"
mkfix badattest; A_R6CHOICE=maybe answers "$F/answers.txt" "$WS" "$WE"; runit
refuse "an invalid typed answer stops before any hosted read" "R-6 choice must be S0b or accept_rpo"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"
fi
mkfix badg3; answers "$F/answers.txt" "$WS" "$WE"; printf 'x\n' >> "$F/hone-s1/window-reads/G3-CHECKSUMS-d189768b.txt"; runit
refuse "bad sha: an edited G3 checksums file is refused before it is parsed" "G3 checksums file G3-CHECKSUMS-d189768b.txt missing or sha256 mismatch"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"
for v in "A_PITRON=TRUE|PITR enabled must be exactly: true" "A_PITRON=yes|PITR enabled must be exactly: true" "A_RET=7.5|retention must be a whole number" "A_RET=7d|retention must be a whole number" "A_RET=|retention must be a whole number"; do
  mkfix "strict"; ( export "${v%%|*}"; answers "$F/answers.txt" "$WS" "$WE" ); runit
  refuse "strict prompt: ${v%%|*} dies before any hosted read" "${v#*|}"
  [ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"
done
mkfix pitrlag; ( export A_LATE_AGO=33 A_READ_AGO=2; answers "$F/answers.txt" "$WS" "$WE" ); runit
refuse "a PITR reading refused by the comparator (latest 31 min behind the read) stops BEFORE any hosted read" "attestation check S0-10 does not pass"
has "$OUT" "Options (none is automatic; this script does not loop or retry)" && ok "  ... the options are printed (wait, named restore point, recorded substitution)" || bad "  ... options not printed"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"
mkfix pitredt; ( export A_LATE_AGO=240 A_BASE_AGO=300; answers "$F/answers.txt" "$WS" "$WE" ); runit
refuse "a latest recovery point typed in EDT (4 h behind) is refused as lagging before any hosted read" "attestation check S0-10 does not pass"
has "$OUT" "lags the reading" && ok "  ... the reason names the lag" || bad "  ... no lag reason"
has "$OUT" "stamped by this script" && ok "  ... the prompt text says the reading time is stamped by the script" || bad "  ... no stamped-time notice"
mkfix badwindow; answers "$F/answers.txt" "$(nowplus -300)" "$(nowplus -240)"; runit
refuse "a window that is not now fails the attestation pre-check BEFORE any hosted read" "attestation check S0-8 does not pass"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"

# ---- window-row4.sh -----------------------------------------------------------------------------------------
mkfix4() { # mkfix4 NAME -> F with the real comparator, lib, baseline 3 (no stub: row 4 makes no hosted call)
  F="$T/$1"; mkdir -p "$F/hone-s1/window-reads"
  cp "$SRC"/compare-preflight.mjs "$SRC"/compare-preflight-lib.mjs "$SRC"/BASELINE-W1-MACOS-CANDIDATE-3.json "$F/hone-s1/window-reads/"
  cp "$ROW4" "$F/window-row4.test.sh"
  if [ "${WS_DEV_LINUX:-}" = 1 ]; then sed -i 's/^\[ "\$(uname -s)" = Darwin \].*$/true/' "$F/window-row4.test.sh"; fi
}
answers4() { # answers4 FILE WSTART WEND BASIS LATEOFF [SLEEP]  (offsets in seconds, resolved when typed; the reading time is stamped by the script)
  local sl=""; [ -n "${6:-}" ] && sl="{sleep:$6}"
  { printf 'Window start\t%s\nWindow end\t%s\nType exactly select\tselect\nType ready\t%s%s\nBasis (\t%s\n' "$2" "$3" "$sl" "${READY:-ready}" "$4"
    [ "$4" = named_restore_point ] && printf 'Restore point name\tpre-s1-point\nRestore point status\tAVAILABLE\nRestore point completed\t{now}\n'
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{now-86400}\nLatest recovery point\t{now%s}\nLatest base backup status\tCOMPLETED\nLatest base backup completed\t{now-3600}\nBase backup read from\tmanagement_api\nRecovery range read from\tdashboard\n' "$5"; } > "$1"
}
runit4() {
  RC=0
  python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(node -p process.execPath)") HOME="$F" TERM=dumb "$@" /bin/bash "$F/window-row4.test.sh" || RC=$?
  OUT="$F/out.txt"
}
mkfix4 r4happy; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0"; runit4
has "$OUT" "WAIT until the dashboard's latest recovery point is AT OR AFTER" && has "$OUT" "Do not select again" && ok "  ... after the stamped time the script says to wait for the latest point and not to select again" || bad "  ... F1 wait text missing"
has "$OUT" "Everything must be answered by" && has "$OUT" "about 25 minutes" && has "$OUT" "named restore point route" && ok "  ... the 30 minute deadline and the 25 minute named-restore-point route are stated" || bad "  ... deadline text missing"
has "$OUT" "Start S1 within 10 minutes" && ok "  ... the PASS says to start S1 within 10 minutes" || bad "  ... S1 deadline missing"
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "row 4 happy path (latest at or after the selected point): exit 0 and OVERALL PASS" || { bad "row 4 happy path" "rc=$RC"; tail -20 "$OUT"; }
has "$OUT" "covers the row-4 bracket only; it does not replace window-s0a.sh" && ok "  ... the PASS line says it covers row 4 only" || bad "  ... row-4 PASS disclaimer missing"
[ "$(stat -c %a "$F"/hone-s1/row4.* 2>/dev/null || stat -f %Lp "$F"/hone-s1/row4.*)" = 700 ] && ok "  ... the row-4 work directory is mode 0700" || bad "  ... row-4 dir mode"
mkfix4 r4named; answers4 "$F/answers.txt" "$WS" "$WE" named_restore_point "+0"; runit4
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "row 4 named restore point (AVAILABLE, completed after the selection): exit 0 and OVERALL PASS" || { bad "row 4 named" "rc=$RC"; tail -20 "$OUT"; }
mkfix4 r4quiet; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "-120"; runit4
refuse "row 4 quiet database: the latest recovery point is before the selected point -> not exit 0" "latest_recovery_at_utc is before the selected restore point"
has "$OUT" "Do NOT start S1" && has "$OUT" "does not loop or retry" && ok "  ... S1 is not started and the script does not loop or retry" || bad "  ... refusal text missing"
has "$OUT" "it was not ready: stop" && has "$OUT" "named restore point route" && ok "  ... the refusal points to the named restore point route, not to running again" || bad "  ... refusal options wrong"
has "$OUT" "it selects a new time" && bad "  ... the old 'run again, it selects a new time' text remains" || ok "  ... the old 'run again (it selects a new time)' option is gone"
mkfix4 r4abort; ( export READY=abort; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0" ); runit4
refuse "row 4: typing abort at the ready gate stops, S1 not started" "aborted by the operator; S1 was not started"
mkfix4 r4junk; ( export READY=yes; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0" ); runit4
refuse "row 4: anything but ready or abort at the gate stops" "type exactly ready or abort"
mkfix4 r4late; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0" 4; sed -i.bak 's/^SELECT_MAX_AGE_S=.*/SELECT_MAX_AGE_S=2/' "$F/window-row4.test.sh"; runit4
refuse "row 4: ready typed after the selection aged out is refused, run again from the start" "stop and run this script again from the start"
mkfix4 r4after; answers4 "$F/answers.txt" "$WS" "$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=5420)).strftime("%Y-%m-%dT%H:%M:%SZ"))')" latest_at_or_after "+0" 25; runit4
refuse "row 4: 90 minutes remained at select but fewer after the wait -> refused at ready, do not start S1" "fewer than 90 minutes of the window remain: do not start S1"
has "$OUT" "Selected pre-migration restore point" && ok "  ... the point had been selected (the first check passed), the second check refused" || bad "  ... first check did not pass"
has "$OUT" "Row 4 was refused" && bad "  ... the comparator ran" || ok "  ... the comparator was not reached"
mkfix4 r4short; answers4 "$F/answers.txt" "$(nowplus -10)" "$(nowplus 30)" latest_at_or_after "+0"; runit4
refuse "row 4: fewer than 90 minutes of the window remaining is refused before select" "fewer than 90 minutes of the window remain"
has "$OUT" "Selected pre-migration restore point" && bad "  ... a point was selected anyway" || ok "  ... nothing was selected"
mkfix4 r4idle; answers4 "$F/answers.txt" "$WS" "$WE" idle_accept "+0"; runit4
refuse "row 4: an idle accept is not an answer" "basis must be latest_at_or_after or named_restore_point"
mkfix4 r4win; answers4 "$F/answers.txt" "$(nowplus -300)" "$(nowplus -240)" latest_at_or_after "+0"; runit4
refuse "row 4: a window that is already over is refused before select" "fewer than 90 minutes of the window remain"
mkfix4 r4future; answers4 "$F/answers.txt" "$(nowplus 5)" "$(nowplus 300)" latest_at_or_after "+0"; runit4
refuse "row 4: a selected point before the typed window start is refused by the comparator" "outside the window"
mkfix4 r4lib; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0"; printf '\n// x\n' >> "$F/hone-s1/window-reads/compare-preflight-lib.mjs"; runit4
refuse "row 4 bad sha: an edited comparator lib is refused before anything is asked" "comparator lib missing or sha256 mismatch"
mkfix4 r4env; answers4 "$F/answers.txt" "$WS" "$WE" latest_at_or_after "+0"; runit4 NODE_OPTIONS=--no-warnings
refuse "row 4: a leftover node variable is refused (names only)" "unset these variables first (names only): NODE_OPTIONS"

echo "passed: $pass failed: $fail skipped: $skipped"
[ "$fail" = 0 ] || exit 1
