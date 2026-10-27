#!/bin/bash
# REHEARSAL - NEVER MERGE. HON66 LINUX VARIANTS of window-s0a (c5) and window-row4 (c5), on Linux x86_64, ported from rehearsal/candidate4/test.sh by a fixed sed list (credentials from mode-600 files, the original Linux runner run-window-read.sh behind the verified-binary npx shim, Linux baseline 5): window-s0a.sh and window-row4.sh (the REAL scripts; test copies differ only
# in pin lines) driven through a pty, with a STUB supabase-go and SYNTHETIC pitr-backups.sh captures (gen-capture.mjs, bound to the real pins
# 85407d0b / dce26b75). NOT stubbed: the script logic, the runner (only its go-hash constant), the real comparator and lib (same sha), the 14
# gate files, the baseline (only runner_sha256 / project_ref_sha256 re-pinned). Also runs the comparator's own unit tests.
# WS_DEV_LINUX=1 (local development only) is NOT supported: the scripts use BSD stat.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/window-reads-c4"
T="$(mktemp -d "${TMPDIR:-/tmp}/c4.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0; skipped=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
TREF=abcdefghijklmnopqrst
TOKEN=TOKEN-SECRET-9f3a1b
PASSWORD=PW-SECRET-77c2de
BARE='OVERALL PASS'
L_S0='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)'
ACK='base backup unverified, restore not tested'

# ---- static: the REAL scripts' pins equal the real files
REAL="$SRC/window-s0a.sh"; ROW4="$SRC/window-row4.sh"
st() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2; }
[ "$(st "$REAL" RUNNER_SHA)" = "$(sha "$SRC/run-window-read.sh")" ] && [ "$(st "$REAL" MANIFEST_SHA)" = "$(sha "$SRC/MANIFEST.sha256")" ] \
 && [ "$(st "$REAL" CMP_SHA)" = "$(sha "$SRC/compare-preflight.mjs")" ] && [ "$(st "$REAL" LIB_SHA)" = "$(sha "$SRC/compare-preflight-lib.mjs")" ] \
 && [ "$(st "$REAL" BASELINE_SHA)" = "$(sha "$SRC/BASELINE-W1-LINUX-CANDIDATE-5.json")" ] && [ "$(st "$REAL" G3_SHA)" = "$(sha "$SRC/G3-CHECKSUMS-d189768b.txt")" ] \
 && ok "window-s0a.sh pins equal the real runner, manifest, comparator, lib, Linux baseline 5 and G3 file" || bad "s0a pins differ from the real files"
[ "$(st "$ROW4" CMP_SHA)" = "$(sha "$SRC/compare-preflight.mjs")" ] && [ "$(st "$ROW4" LIB_SHA)" = "$(sha "$SRC/compare-preflight-lib.mjs")" ] && [ "$(st "$ROW4" BASELINE_SHA)" = "$(sha "$SRC/BASELINE-W1-LINUX-CANDIDATE-5.json")" ] \
 && ok "window-row4.sh pins equal the real comparator, lib and Linux baseline 5" || bad "row4 pins differ"
bash -n "$REAL" && bash -n "$ROW4" && ok "bash -n on both scripts" || bad "syntax"
[ "$(st "$REAL" WR)" != "" ] || true
grep -q '^WR="\$ROOT/window-reads-c4"' "$REAL" && grep -q '^WR="\$ROOT/window-reads-c4"' "$ROW4" && ok "both scripts install into window-reads-c4, apart from the pinned candidate-3 directory" || bad "WR is not window-reads-c4"
( cd "$SRC" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "shasum -c MANIFEST.sha256 passes on the candidate-4 directory (runner and 14 gate files)" || bad "manifest check"
if grep -nE 'base_backup_status|latest_base_backup|Latest base backup' "$REAL" "$ROW4" | grep -v '^[^:]*:[0-9]*:\s*#' | grep -vq 'echo\|die\|ask.*UNVERIFIED'; then bad "a typed base-backup prompt remains"; else ok "no typed base-backup prompt remains in either script"; fi

# ---- the comparator's own unit tests and the baseline proofs, on this runner's node
( cd "$SRC" && node --test --test-concurrency=1 compare-preflight.test.mjs > "$T/unit.out" 2>&1 ); rc=$?
tail -n 12 "$T/unit.out"
[ $rc = 0 ] && ok "comparator unit tests + baseline proofs pass on macOS ($(grep -E '^ℹ tests' "$T/unit.out" | tail -1))" || bad "unit tests" "rc=$rc"

mkfix() { # mkfix NAME  -> F (fake HOME); prepares the stub go, the test runner and baseline, the test copies
  F="$T/$1"; WRD="$F/hone-s1/window-reads-c4"; mkdir -p "$F/hone-s1/supabase-cli" "$WRD" "$F/res"; chmod 700 "$F/hone-s1"
  mkdir -p "$F/cred"; chmod 700 "$F/cred"; printf '%s\n' "$TOKEN" > "$F/cred/token"; printf '%s\n' "$PASSWORD" > "$F/cred/pw"; chmod 600 "$F/cred/token" "$F/cred/pw"
  cp "$SRC"/*.sql "$SRC"/MANIFEST.sha256 "$SRC"/G3-CHECKSUMS-d189768b.txt "$SRC"/compare-preflight.mjs "$SRC"/compare-preflight-lib.mjs "$SRC"/compare-preflight.test.mjs "$WRD/"
  cp -r "$SRC/fixtures" "$WRD/"
  cat > "$F/hone-s1/supabase-cli/supabase-go" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
f=""; while [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done
cat "$STUB_RESULTS/$(basename "$f" .sql).json"
STUB
  chmod +x "$F/hone-s1/supabase-cli/supabase-go"
  GOSHA=$(sha "$F/hone-s1/supabase-cli/supabase-go")
  cp "$SRC/run-window-read.sh" "$WRD/run-window-read.sh"
  RSHA=$(sha "$WRD/run-window-read.sh")
  node -e '
    const fs=require("fs"),c=require("crypto");const [src,dst,rsha,ref]=process.argv.slice(1);
    const b=JSON.parse(fs.readFileSync(src));b.runner_sha256=rsha;b.project_ref_sha256=c.createHash("sha256").update(ref).digest("hex");
    fs.writeFileSync(dst,JSON.stringify(b,null,2)+"\n");' "$SRC/BASELINE-W1-LINUX-CANDIDATE-5.json" "$WRD/BASELINE-W1-LINUX-CANDIDATE-5.json" "$RSHA" "$TREF"
  BSHA=$(sha "$WRD/BASELINE-W1-LINUX-CANDIDATE-5.json")
  sed -e "s/^GO_SHA=.*/GO_SHA=$GOSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$RSHA/" -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$BSHA/" -e "s/^REF=.*/REF=$TREF/" "$REAL" > "$F/window-s0a.test.sh"
  cp "$ROW4" "$F/window-row4.test.sh"
  sed -e "s/^BASELINE_SHA=.*/BASELINE_SHA=$BSHA/" "$ROW4" > "$F/window-row4.test.sh"
  node "$HERE/gen-results.mjs" "$F/res" "$WRD/BASELINE-W1-LINUX-CANDIDATE-5.json" "" "$SRC" || { echo "gen-results failed"; exit 1; }
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
mkcap() { # mkcap NAME LATEST_OFFSET_S CAPTURED_OFFSET_S [real-layout]  -> a capture dir under $F/hone-s1, prints nothing; sets EARLY/LATE and writes early.txt/late.txt
  local out; out=$(node "$HERE/gen-capture.mjs" "$F/hone-s1/pitr-backups.$1" "$2" "$3" "${4:-}") || { echo "gen-capture failed"; exit 1; }
  EARLY=${out% *}; LATE=${out#* }; printf '%s' "$EARLY" > "$F/early.txt"; printf '%s' "$LATE" > "$F/late.txt"
}
s0a_answers() { # s0a_answers WSTART WEND [choice] [ack] [text]
  { printf 'Operator label\tOP-1\nWindow start\t%s\nWindow end\t%s\nCron-job.org\tyes\nPeople hold\tyes\nMaintenance flag\tno_flag\n' "$1" "$2"
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{cat:%s/early.txt}\nLatest recovery point\t{cat:%s/late.txt}\nUse the idle proof\tno\n' "$F" "$F"
    printf 'R-6 choice\t%s\nType exactly: base backup unverified\t%s\nR-6 answer\t%s\nR-6 decision reference\tdecision-ref-1\n0242 disposition (\tR-3\n0242 disposition reference\tdecision-ref-2\n' "${3:-accept_rpo}" "${4:-$ACK}" "${5:-Accept the unverified base backup for the cutover.}"
    printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOKEN" "$PASSWORD"; } > "$F/answers.txt"
}
runs0a() { # runs0a [script] [ENV=VAL ...]
  local sc="${1:-$F/window-s0a.test.sh}"; shift 2>/dev/null || true; RC=0
  python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=${SHIM:+$SHIM:}/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(command -v node)") HOME="$F" TERM=dumb HONE_GATE_TOKEN_FILE="$F/cred/token" HONE_GATE_PASSWORD_FILE="$F/cred/pw" STUB_LOG="$F/stub.log" STUB_RESULTS="$F/res" "$@" /bin/bash "$sc" || RC=$?
  OUT="$F/out.txt"
}
refuse() { [ "$RC" != 0 ] && has "$OUT" "$2" && ok "$1" || { bad "$1" "rc=$RC want [$2]"; tail -6 "$OUT"; }; }
WS=$(nowplus -10); WE=$(nowplus 150)
if [ -n "$(blackout "$WS" "$WE")" ]; then skipped=$((skipped+1)); echo "SKIP - script cases: the 160-minute window overlaps 07:45-10:00 UTC (the comparator would, correctly, refuse)"; else

# ---- S0a
mkfix happy; mkcap one -300 -150 real-layout; s0a_answers "$WS" "$WE"; runs0a
[ "$RC" = 0 ] && has "$OUT" "$L_S0" && ok "S0a happy path with the REAL capture layout (backups.err and cwd/ present): exit 0 and the labelled line" || { bad "S0a happy" "rc=$RC"; tail -25 "$OUT"; }
! { tr -d "\r" < "$OUT" | grep -qx "$BARE"; } && ok "  ... a bare OVERALL PASS line is nowhere in the transcript" || bad "  ... bare OVERALL PASS printed"
has "$OUT" "UNVERIFIED" && has "$OUT" "restore not tested" && ok "  ... the PASS says UNVERIFIED and restore not tested" || bad "  ... label words missing"
[ "$(grep -c . "$F/stub.log")" = 14 ] && ok "  ... exactly 14 runner calls" || bad "  ... stub call count" "$(grep -c . "$F/stub.log")"
grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$F/hone-s1" 2>/dev/null && bad "  ... a secret appears in output or on disk" || ok "  ... neither secret appears in the output or in any file written"
grep -q 'base_backup_unverified_ack' "$F"/hone-s1/window.*/attest/attestation.json && ! grep -qE 'latest_base_backup|base_backup_source' "$F"/hone-s1/window.*/attest/attestation.json && ok "  ... the attestation carries the ack and no typed base-backup field" || bad "  ... attestation fields"

mkfix wrongack; mkcap one -300 -150; s0a_answers "$WS" "$WE" accept_rpo "base backup unverified"; runs0a
refuse "a wrong acknowledgement phrase is refused before any hosted read" "the acknowledgement was not typed exactly"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub was called"
mkfix notext; mkcap one -300 -150; s0a_answers "$WS" "$WE" accept_rpo "$ACK" "Accept the loss window for the cutover."; runs0a
refuse "accept_rpo without the words 'unverified base backup' is refused before any hosted read" "S0-10"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub was called"
mkfix s0b; mkcap one -300 -150; s0a_answers "$WS" "$WE" S0b "$ACK" "Restore test planned before the cutover."; runs0a
[ "$RC" = 0 ] && has "$OUT" "$L_S0" && ok "S0b choice with the ack passes with the labelled line" || { bad "S0b" "rc=$RC"; tail -12 "$OUT"; }
mkfix noapi; s0a_answers "$WS" "$WE"; mkdir -p "$F/hone-s1"; printf 'x' > "$F/early.txt"; printf 'x' > "$F/late.txt"; runs0a
refuse "no pitr-backups.* directory: refused before any hosted read" "no $F/hone-s1/pitr-backups.* directory"
mkfix mode755; mkcap one -300 -150; chmod 755 "$F/hone-s1/pitr-backups.one"; s0a_answers "$WS" "$WE"; runs0a
refuse "a mode-755 capture directory is refused" "is not a private (mode 700) directory"
mkfix symlink; mkcap real -300 -150; mv "$F/hone-s1/pitr-backups.real" "$F/elsewhere"; ln -s "$F/elsewhere" "$F/hone-s1/pitr-backups.link"; s0a_answers "$WS" "$WE"; runs0a
refuse "a symlinked capture directory is refused" "is not a private (mode 700) directory"
mkfix nojson; mkcap one -300 -150; rm "$F/hone-s1/pitr-backups.one/backups.json"; s0a_answers "$WS" "$WE"; runs0a
refuse "a capture without backups.json is refused" "is not a regular file"
mkfix stale; mkcap one -4400 -4200; s0a_answers "$WS" "$WE"; runs0a
refuse "a capture older than 60 minutes is refused by the comparator before any hosted read" "S0-10"
[ ! -s "$F/stub.log" ] && ok "  ... nothing was read" || bad "  ... stub was called"
mkfix newest; mkcap old -4400 -4200; sleep 1; mkcap new -300 -150; s0a_answers "$WS" "$WE"; runs0a
[ "$RC" = 0 ] && has "$OUT" "pitr-backups.new" && ok "the NEWEST capture directory is the one used (a stale older one is ignored)" || { bad "newest" "rc=$RC"; tail -8 "$OUT"; }
mkfix dash; mkcap one -300 -150; s0a_answers "$WS" "$WE"; printf '%s' "$(nowplus -300)" > "$F/late.txt"; runs0a
refuse "a dashboard latest that disagrees with the capture is refused" "S0-10"

# stub comparator: prints a BARE 'OVERALL PASS'. The script must refuse to accept it.
mkfix barepass; mkcap one -300 -150; s0a_answers "$WS" "$WE"
cp "$F/hone-s1/window-reads-c4/compare-preflight.mjs" "$F/hone-s1/window-reads-c4/compare-real.mjs"
cat > "$F/hone-s1/window-reads-c4/compare-preflight.mjs" <<'STUBJS'
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const real = path.join(path.dirname(fileURLToPath(import.meta.url)), "compare-real.mjs");
const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { encoding: "utf8" });
process.stdout.write(r.stdout.replace(/^OVERALL PASS \(.*\)$/m, "OVERALL PASS")); process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
STUBJS
sed -i.bak "s/^CMP_SHA=.*/CMP_SHA=$(sha "$F/hone-s1/window-reads-c4/compare-preflight.mjs")/" "$F/window-s0a.test.sh"; runs0a
[ "$RC" != 0 ] && tr -d "\r" < "$OUT" | grep -qx "$BARE" && ! has "$OUT" "WINDOW S0a" && ok "the script refuses a comparator that prints a bare OVERALL PASS (exit non-zero, no success banner)" || { bad "bare PASS accepted" "rc=$RC"; tail -8 "$OUT"; }

# ---- row 4
r4_answers() { # r4_answers WSTART WEND BASIS [sleep]
  { printf 'Window start\t%s\nWindow end\t%s\nType exactly select\tselect\n' "$1" "$2"
    printf 'Type ready when\t{sleep:%s}ready\nBasis (\t%s\n' "${4:-12}" "$3"
    printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{cat:%s/early.txt}\nLatest recovery point\t{cat:%s/late.txt}\n' "$F" "$F"; } > "$F/answers.txt"
}
runr4() { RC=0; python3 "$HERE/driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=${SHIM:+$SHIM:}/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(command -v node)") HOME="$F" TERM=dumb HONE_GATE_TOKEN_FILE="$F/cred/token" HONE_GATE_PASSWORD_FILE="$F/cred/pw" /bin/bash "$F/window-row4.test.sh" || RC=$?; OUT="$F/out.txt"; }
mkfix r4ok; mkdir -p "$F/hone-s1"; : > "$F/answers.txt"
# the capture is made AFTER the selection (the driver sleeps 12 s at the ready prompt); a background job writes it 6 s in
( /bin/sleep 6; node "$HERE/gen-capture.mjs" "$F/hone-s1/pitr-backups.r4" -1 0 real-layout > "$F/cap.txt" 2>&1; cut -d' ' -f1 "$F/cap.txt" > "$F/early.txt"; cut -d' ' -f2 "$F/cap.txt" > "$F/late.txt" ) &
BG=$!
r4_answers "$WS" "$WE" latest_at_or_after 14; runr4; wait $BG
[ "$RC" = 0 ] && has "$OUT" "$L_S0" && ok "row 4 latest_at_or_after with a capture taken after the selection: exit 0 and the labelled line" || { bad "row4 happy" "rc=$RC"; tail -25 "$OUT"; }
mkfix r4pre; mkcap early -2500 -2400; mkdir -p "$F/hone-s1"; r4_answers "$WS" "$WE" latest_at_or_after 2; runr4
[ "$RC" != 0 ] && ok "row 4 with a capture taken BEFORE the selection is refused (exit $RC)" || { bad "row4 pre-selection capture accepted"; tail -10 "$OUT"; }
mkfix r4nocap; mkdir -p "$F/hone-s1"; printf x > "$F/early.txt"; printf x > "$F/late.txt"; r4_answers "$WS" "$WE" latest_at_or_after 2; runr4
refuse "row 4 with no capture directory is refused" "no $F/hone-s1/pitr-backups.* directory"
mkfix r4idle; mkcap one -300 -150; r4_answers "$WS" "$WE" idle_proven_latest 2; runr4
refuse "row 4 refuses the idle basis for this window (S1 accepts only the latest-at-or-after result)" "the idle basis is not offered for this window"
! grep -qE 'idle_proven_latest|pitr-wal' <(sed -n '/^ask BASIS/p' "$ROW4" | sed 's/idle_proven_latest) die.*//') && ok "the row-4 basis prompt offers only latest_at_or_after and named_restore_point" || bad "row-4 prompt still offers the idle basis"
! grep -q 'take_idle\|--pitr-idle\|PIDLE' "$ROW4" && ok "window-row4.sh has no idle-evidence handling left" || bad "idle handling remains in row 4"
fi

echo; echo "passed: $pass failed: $fail skipped: $skipped"
[ "$fail" = 0 ]
