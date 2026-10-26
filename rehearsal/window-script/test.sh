#!/bin/bash
# REHEARSAL - NEVER MERGE. Tests window-s0a.sh on macOS arm64 against a STUB supabase-go and synthetic results.
# STUBBED: supabase-go (a shell script printing canned JSON, hash substituted into a TEST COPY of the runner), the hosted
# project (there is none), and the typed answers (a pty driver types them). NOT stubbed: the real script logic, the real
# runner logic (only its supabase-go hash constant differs in the test copy), the real pinned comparator and lib (same sha),
# the real 14 gate files and manifest, the real baseline (only runner_sha256 and project_ref_sha256 re-pinned to the test values).
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
 && [ "$(st BASELINE_SHA)" = "$(sha "$SRC/BASELINE-W1-MACOS-CANDIDATE-2.json")" ] && ok "the real script's pins equal the real runner, manifest, comparator, lib and baseline" || bad "pins differ from the real files"
want_ref=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.project_ref_sha256)' "$SRC/BASELINE-W1-MACOS-CANDIDATE-2.json")
[ "$(printf '%s' "$(st REF)" | shasum -a 256 | cut -d' ' -f1)" = "$want_ref" ] && ok "the script's project ref hashes to the baseline's project_ref_sha256" || bad "project ref constant differs from the baseline"
bash -n "$REAL" && ok "bash -n (syntax)" || bad "syntax"
# X1 class: no paste hazards, nothing to paste at all
if grep -nE '^[^#]*[A-Za-z0-9_"]+ +# ' "$REAL" | grep -v "^.*#!/" | grep -vE "^[0-9]+:\s*#" | grep -E 'printf|export|unset' >/dev/null; then bad "inline comment after a command in the script"; else ok "no inline comment follows a printf/export/unset command"; fi
grep -nE 'SUPABASE_DB_PASSWORD=|SUPABASE_ACCESS_TOKEN=' "$REAL" | grep -v 'read -rs' | grep -vE '^[0-9]+:(#|cleanup|unset)' | grep -qE '=[^ ]' && bad "a secret assignment appears outside read -rs" || ok "secrets are only ever read with read -rs from /dev/tty"

mkfix() { # mkfix NAME  -> sets F (home), prepares the fixture
  F="$T/$1"; mkdir -p "$F/hone-s1/supabase-cli" "$F/hone-s1/window-reads" "$F/res" "$F/g3"
  cp "$SRC"/*.sql "$SRC"/MANIFEST.sha256 "$SRC"/compare-preflight.mjs "$SRC"/compare-preflight-lib.mjs "$SRC"/compare-preflight.test.mjs "$F/hone-s1/window-reads/"
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
    fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$SRC/BASELINE-W1-MACOS-CANDIDATE-2.json" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json" "$RSHA" "$TREF"
  BSHA=$(sha "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json")
  # test copy of the script: only the pins change
  sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$BSHA/" -e "s/^REF=.*/REF=$TREF/" "$REAL" > "$F/window-s0a.test.sh"
  if [ "${WS_DEV_LINUX:-}" = 1 ]; then sed -i 's/^\[ "\$(uname -s)" = Darwin \].*$/true/' "$F/window-s0a.test.sh"; fi
  node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json" "${2:-}" "$SRC" || { echo "gen-results failed"; exit 1; }
  node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1]));
    for (const [v,h] of Object.entries(j.g3.checksums)) console.log(h+"  supabase/migrations/"+v+"_synthetic.sql");' "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json" > "$F/g3/checksums.txt"
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
answers() { # answers FILE WSTART WEND  [variant tweaks via env: A_R6CHOICE ...]
  local ws="$2" we="$3" g4at; g4at=$(nowplus -60)
  { printf 'Operator label\tOP-1\nWindow start\t%s\nWindow end\t%s\nCron-job.org\tyes\nPeople hold\tyes\nMaintenance flag\tno_flag\n' "$ws" "$we"
    printf 'Head sha\td189768b86fe1c53e330c65078f3a9f2949f8e59\nAbsolute path\t%s\nG4 backup identifier\tbackup-synthetic-1\nG4 backup status\tCOMPLETED\nG4 backup completed\t%s\n' "$F/g3/checksums.txt" "$g4at"
    printf 'R-6 choice\t%s\nR-6 answer\tAccept the loss window for the cutover.\nR-6 decision reference\tdecision-ref-1\n0242 disposition (\tR-3\n0242 disposition reference\tdecision-ref-2\n' "${A_R6CHOICE:-accept_rpo}"
    printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD"; } > "$1"
}
runit() { # runit NAME [ENV=VAL ...]  -> OUT=$F/out.txt, RC
  local ans="$F/answers.txt"; shift 0
  RC=0
  python3 "$HERE/driver.py" "$F/out.txt" "$ans" -- env -i PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(node -p process.execPath)") HOME="$F" TERM=dumb STUB_LOG="$F/stub.log" STUB_RESULTS="$F/res" "$@" /bin/bash "$F/window-s0a.test.sh" || RC=$?
  OUT="$F/out.txt"
}
WS=$(nowplus -10); WE=$(nowplus 90)
BLK=$(blackout "$WS" "$WE")

# 1. happy path
if [ -n "$BLK" ]; then skipped=$((skipped+1)); echo "SKIP - happy path and comparator cases: the 90-minute window overlaps 07:45-10:00 UTC (the comparator would, correctly, refuse)"; else
mkfix happy; answers "$F/answers.txt" "$WS" "$WE"; runit
[ "$RC" = 0 ] && has "$OUT" "OVERALL PASS" && ok "happy path: exit 0 and the comparator's OVERALL PASS line" || { bad "happy path" "rc=$RC"; tail -30 "$OUT"; }
echo "--- happy path transcript (tail) ---"; tail -n 40 "$OUT" | cut -c1-200; echo "--- end ---"
[ "$(grep -c . "$F/stub.log")" = 14 ] && ok "happy path: exactly 14 runner calls, one per gate file, in order" || bad "stub call count" "$(grep -c . "$F/stub.log")"
grep -q -- "--agent no db query --linked -o json -f" "$F/stub.log" && ok "the CLI call is db query --linked (no --db-url, no --local)" || bad "CLI call shape"
if grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$F/hone-s1" 2>/dev/null; then bad "a typed secret appears in the terminal output or on disk"; else ok "neither the access token nor the password appears in the output or in any file written"; fi
[ "$(ls "$F"/hone-s1/window.*/results | wc -l | tr -d ' ')" = 28 ] && ok "28 files (14 results + 14 sidecars) in the 0700 results directory" || bad "results dir"
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
mkfix g02; answers "$F/answers.txt" "$WS" "$WE"; node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json" g02-0213 "$SRC"; runit
refuse "g02 not at 0212: stopped at the first file" "g02: hosted history max is not 0212"
[ "$(grep -c . "$F/stub.log")" = 1 ] && ok "  ... only g02 was run" || bad "  ... more than one call" "$(grep -c . "$F/stub.log")"
mkfix failfile; answers "$F/answers.txt" "$WS" "$WE"; runit STUB_FAIL=g06-payment-drain
refuse "a failed file stops the run, no retry" "g06-payment-drain.sql failed (exit"
[ "$(grep -c . "$F/stub.log")" = 3 ] && ok "  ... g02, census, g06 were called once each; nothing after g06" || bad "  ... call count" "$(grep -c . "$F/stub.log")"
mkfix denied; answers "$F/answers.txt" "$WS" "$WE"; runit STUB_DENY=g07-sms-claimed-number-duplicates
refuse "a permission denial is reported and stops" "a permission refusal was reported"
mkfix cmpfail; answers "$F/answers.txt" "$WS" "$WE"; node "$HERE/gen-results.mjs" "$F/res" "$F/hone-s1/window-reads/BASELINE-W1-MACOS-CANDIDATE-2.json" wrong-count "$SRC"; runit
refuse "comparator FAIL: one wrong count -> not exit 0, STOP THE CUTOVER" "the comparator did not print OVERALL PASS"
has "$OUT" "OVERALL FAIL" && ok "  ... the comparator's OVERALL FAIL line is printed verbatim" || bad "  ... no OVERALL FAIL line"
mkfix badattest; A_R6CHOICE=maybe answers "$F/answers.txt" "$WS" "$WE"; runit
refuse "an invalid typed answer stops before any hosted read" "R-6 choice must be S0b or accept_rpo"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"
fi
mkfix badwindow; answers "$F/answers.txt" "$(nowplus -300)" "$(nowplus -240)"; runit
refuse "a window that is not now fails the attestation pre-check BEFORE any hosted read" "attestation check S0-8 does not pass"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub called"

echo "passed: $pass failed: $fail skipped: $skipped"
[ "$fail" = 0 ] || exit 1
