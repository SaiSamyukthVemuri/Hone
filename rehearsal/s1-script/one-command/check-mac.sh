#!/bin/bash
# REHEARSAL - NEVER MERGE. CI check of the ONE-COMMAND STAGE RUNNER against STUBS (no hosted access, no database, canary credentials only).
# The runner under test is a TEST VARIANT that differs from hone-stage-run.sh ONLY inside its #CONST block (asserted below). The children are
# stubs that print the REAL prompt strings (each one asserted to occur in reference/, the byte-identical pinned children), and a fake CLI.
# Runs on macOS arm64 (/bin/bash 3.2, /usr/bin/expect) in CI. N of N asserted; a mutation pass proves the negative controls bite.
set -u
D="$(cd "$(dirname "$0")" && pwd)"; T=${RUNNER_TEMP:-/tmp}/onecmd; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
echo "platform: $(uname -sm); bash: $(/bin/bash -c 'echo $BASH_VERSION'); expect: $(command -v expect)"
TOKC="TOKEN-CANARY-7f3a91"; PWC="PW-CANARY-5be240"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
hs() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
case "$(uname -s)$(uname -m)" in Darwinarm64) PLAT=1 ;; *) PLAT=0 ;; esac

# ---- 0. the prompts the runner types are the REAL prompts of the pinned children
chk_prompts() { # chk_prompts EXPFILE-PHASE-REGEX REFERENCE : every literal prompt phase.exp uses for that child occurs in the reference
  local f=$2 miss=0 p
  while IFS= read -r p; do [ -n "$p" ] || continue; grep -Fq -- "$p" "$D/reference/$f" || { echo "       missing in $f: $p"; miss=1; }; done
  return $miss
}
PX=$D/phase.exp
sect() { sed -n "/^  $1 {/,/^  }/p" "$PX"; }
prompts_of() { sect "$1" | sed -n 's/^ *\(step\|secret_step\) "\([^"]*\)".*/\2/p'; }
for pair in "s0a:window-s0a-0248.sh" "row4:window-row4.sh" "apply:s1-apply-0248.sh" "s1read:window-s1read-0248.sh"; do
  ph=${pair%%:*}; f=${pair#*:}
  if prompts_of "$ph" | chk_prompts "$ph" "$f"; then ok "every prompt phase.exp answers in '$ph' occurs in the pinned $f"; else bad "a '$ph' prompt is not in the pinned child"; fi
done
grep -Fq 'Supabase access token (not shown): ' "$D/reference/pitr-backups.sh" && grep -Fq 'read -rs PGPASSWORD' "$D/reference/d3-watchdog.zsh" && grep -Fq 'WATCHDOG armed (self-test ok)' "$D/reference/d3-watchdog.zsh" && grep -Fq 'watching for the push session to start' "$D/reference/d3-watchdog.zsh" && ok "the pitr-backups token prompt and the watchdog password read and both watchdog lines are in the pinned children" || bad "pitr/watchdog prompts differ from the pinned children"
# stubs print only real prompts
sp=0; for f in "$D"/stubs/*.sh "$D"/stubs/*.zsh; do b=$(basename "$f"); [ -f "$D/reference/$b" ] || continue
  grep -ho 'sask [A-Z_0-9]* "[^"]*"\|ssecret [A-Z]* "[^"]*"' "$f" | sed 's/^[a-z]* [A-Z_0-9]* "//;s/"$//' | while IFS= read -r p; do p2=${p%%\$*}; grep -Fq -- "$p2" "$D/reference/$b" || echo "$b: $p"; done
done > "$T/stubprompts.txt"
[ ! -s "$T/stubprompts.txt" ] && ok "every prompt a stub prints (up to its first variable part) occurs in the pinned child it stands for" || bad "a stub prompt is not in the pinned child" "$(head -3 "$T/stubprompts.txt")"

# ---- environment builder
mkenv() { # mkenv NAME -> H (fake HOME) with stubs installed, pins, plan, a test variant of the runner
  NAME=$1; H=$T/$NAME/home; R=$H/hone-s1; mkdir -p "$R/pitr-status" "$R/window-reads" "$R/window-reads-0248" "$R/s1-apply-0248" "$R/window-reads-s1-0248" "$R/supabase-cli" "$R/s1-apply"; chmod 700 "$R"
  cp "$D/stubs/common.sh" "$R/stub-common.sh"
  cp "$D/stubs/pitr-backups.sh" "$R/pitr-status/pitr-backups.sh"; cp "$D/stubs/window-row4.sh" "$R/window-reads/window-row4.sh"; cp "$D/stubs/window-s0a-0248.sh" "$R/window-reads-0248/"
  cp "$D/stubs/s1-apply-0248.sh" "$R/s1-apply-0248/"; echo "# stub reconcile" > "$R/s1-apply-0248/s1-reconcile-0248.sh"; cp "$D/stubs/window-s1read-0248.sh" "$R/window-reads-s1-0248/"
  cp "$D/stubs/d3-watchdog.zsh" "$R/d3-watchdog.zsh"; cp "$D/stubs/supabase-go" "$R/supabase-cli/supabase-go"; chmod 755 "$R"/*/*.sh "$R/d3-watchdog.zsh" "$R/supabase-cli/supabase-go"
  NOWS=$(date -u +%s); fmt() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
  WS=$(fmt $((NOWS - 600))); WE=$(fmt $((NOWS + 18000)))
  printf 'STAGE=0248\nWSTART=%s\nWEND=%s\nOPERATOR=ci\nMFLAG=no_flag\nPITR_RET=7\nR6CHOICE=accept_rpo\nR6TEXT=accepted for the rehearsal\nR6REF=CI-1\nROLE_LIMIT=120s\n' "$WS" "$WE" > "$T/$NAME/plan.env"
  { echo "TOKH=$(hs "$TOKC")"; echo "PWH=$(hs "$PWC")"; echo "X_OPERATOR=ci"; echo "X_WSTART=$WS"; echo "X_WEND=$WE"; echo "X_MFLAG=no_flag"; echo "X_PITR_RET=7"; echo "X_R6CHOICE=accept_rpo"
    echo "X_R6TEXT=accepted for the rehearsal"; echo "X_R6REF=CI-1"; } > "$R/stub.cfg"
  : > "$R/stub.log"; echo "statement_timeout=0" > "$R/fake-rolconfig"; echo "other=1" >> "$R/fake-rolconfig"; echo "other=1,statement_timeout=0" > "$R/fake-rolconfig"
  ORIGCONF=$(cat "$R/fake-rolconfig")
  # the TEST VARIANT: only the #CONST block differs
  { sed -n '1,/^#CONST-BEGIN$/p' "$D/hone-stage-run.sh"
    echo "ROOT=\"\$HOME/hone-s1\""; echo "REF=testref"; echo "POOLER=pooler.invalid"; echo "PLATFORM_CHECK=$PLAT"; echo "GO_SHA=x"; echo "WD_SHA=x"
    echo "MIN_REMAIN_START_MIN=150"; echo "POLL_S=1"; echo "WAIT_LIMIT_S=${WAIT_LIMIT_S_T:-8}"; echo "MAX_ATTEMPTS=2"; echo "PINS='"
    for p in pitr-status/pitr-backups.sh window-reads/window-row4.sh window-reads-0248/window-s0a-0248.sh s1-apply-0248/s1-apply-0248.sh s1-apply-0248/s1-reconcile-0248.sh window-reads-s1-0248/window-s1read-0248.sh d3-watchdog.zsh supabase-cli/supabase-go; do echo "$(sha "$R/$p")  $p"; done
    echo "'"; sed -n '/^#CONST-END$/,$p' "$D/hone-stage-run.sh"; } > "$T/$NAME/runner.sh"
  # keep the variant next to phase.exp (the runner finds it through its own directory)
  cp "$D/phase.exp" "$T/$NAME/phase.exp"
}
variant_only_const() { # the variant equals the real runner outside the #CONST block
  [ "$(sed -n '1,/^#CONST-BEGIN$/p' "$D/hone-stage-run.sh" | shasum)" = "$(sed -n '1,/^#CONST-BEGIN$/p' "$T/$1/runner.sh" | shasum)" ] && [ "$(sed -n '/^#CONST-END$/,$p' "$D/hone-stage-run.sh" | shasum)" = "$(sed -n '/^#CONST-END$/,$p' "$T/$1/runner.sh" | shasum)" ]
}
answers() { # answers NAME [h1] [h2] [approve] [token] [pw]
  local n=$1 h1=${2:-yes} h2=${3:-yes} ap=${4:-approve} tk=${5:-$TOKC} pw=${6:-$PWC}
  printf 'Cron-job.org reminders paused (yes or no): \t%s\t0\nPeople hold in place (yes or no): \t%s\t0\nType approve or decline: \t%s\t0\nSupabase access token (not shown): \t%s\t1\nDatabase password (not shown): \t%s\t1\n' "$h1" "$h2" "$ap" "$tk" "$pw" > "$T/$n/answers.txt"
}
run() { # run NAME [env assignments...] -> RC, OUT (runner output); the env goes to the runner and, through the pty, to the stub children via stub.cfg
  local n=$1; shift
  ( cd "$T/$n" && env -i HOME="$T/$n/home" PATH="$PATH" TERM=xterm "$@" expect -f "$D/drive-runner.exp" "$T/$n/answers.txt" "$T/$n/out.txt" "$T/$n/runner.sh" "$T/$n/plan.env" ) >"$T/$n/driver.out" 2>&1; RC=$?
  OUT=$(cat "$T/$n/out.txt" 2>/dev/null); LOG=$(cat "$T/$n/home/hone-s1/stub.log" 2>/dev/null)
}
cfg() { echo "$2" >> "$T/$1/home/hone-s1/stub.cfg"; }
pushes() { [ -f "$T/$1/home/hone-s1/push.count" ] && grep -c '' "$T/$1/home/hone-s1/push.count" || echo 0; }
rolconf() { cat "$T/$1/home/hone-s1/fake-rolconfig"; }
altered() { grep -c '^alter role postgres set' "$T/$1/home/hone-s1/sql.log" 2>/dev/null || echo 0; }
marker() { cat "$T/$1/home/hone-s1/s1-apply/APPLY-STATE" 2>/dev/null; }

# 1. happy path
mkenv happy; answers happy; variant_only_const happy && ok "the test variant differs from hone-stage-run.sh only inside the #CONST block" || bad "the variant differs outside #CONST"
run happy
echo "$OUT" | grep -q 'RESULT: APPLIED+VERIFIED' && [ "$(pushes happy)" = 1 ] && [ "$(rolconf happy)" = "$ORIGCONF" ] && echo "$OUT" | grep -q 'role setting restored and read back' && ok "happy path: APPLIED+VERIFIED, one push, the role setting is back to its original and read back" || bad "happy path" "rc=$RC $(echo "$OUT" | tail -12)"
echo "$LOG" | grep -q 'wd started' && [ "$(altered happy)" -ge 2 ] && ok "  the runner started the reviewed watchdog itself and the role setting was applied then restored (>= 2 ALTERs)" || bad "watchdog or alter calls" "$(cat "$T/happy/home/hone-s1/sql.log" 2>/dev/null)"
echo "$OUT" | grep -q 'plan sha256: [0-9a-f]\{64\}' && echo "$OUT" | grep -q 'New-route approval sentence' && ok "  the plan and its sha256 and the generated new-route approval sentence were printed" || bad "plan output"
# canary: no secret in any file or any output
if grep -rIl -e "$TOKC" -e "$PWC" "$T/happy/home" "$T/happy/out.txt" "$T/happy/driver.out" 2>/dev/null | grep -q .; then bad "a canary secret is in a file or output" "$(grep -rIl -e "$TOKC" -e "$PWC" "$T/happy/home" "$T/happy/out.txt" "$T/happy/driver.out" | head -3)"; else ok "  neither canary secret appears in any file under the home, the run evidence, the transcripts or the output"; fi
ls "$T/happy/home/hone-s1/one-command"/run.*/PLAN.txt >/dev/null 2>&1 && ls "$T/happy/home/hone-s1/one-command"/run.*/APPROVAL.txt >/dev/null 2>&1 && ok "  the plan, its approval record and the phase transcripts are kept as evidence" || bad "evidence files missing"

# 2. decline and holds: nothing runs
mkenv decl; answers decl yes yes decline; run decl
echo "$OUT" | grep -q 'RESULT: NOT APPLIED' && [ ! -s "$T/decl/home/hone-s1/stub.log" ] && [ "$(pushes decl)" = 0 ] && ok "decline: NOT APPLIED and no child, no CLI call was made" || bad "decline" "$OUT"
mkenv hold; answers hold no yes; run hold
echo "$OUT" | grep -q 'hold 1 not confirmed' && [ ! -s "$T/hold/home/hone-s1/stub.log" ] && ok "a hold answered no: STOP before anything runs" || bad "hold" "$OUT"

# 3. a pinned file changed: refused before the approval prompt
mkenv pin; echo "# tampered" >> "$T/pin/home/hone-s1/window-reads-0248/window-s0a-0248.sh"; answers pin; run pin
echo "$OUT" | grep -q 'a pinned file is missing or its sha256 differs' && ! echo "$OUT" | grep -q 'Type approve or decline' && [ ! -s "$T/pin/home/hone-s1/stub.log" ] && ok "pin mismatch: refused before the plan is shown; nothing ran" || bad "pin" "$OUT"

# 4. stalled PITR: clean STOP, nothing pushed, role not touched
mkenv stall; cfg stall "PITR_MODE=stalled"; answers stall; run stall
echo "$OUT" | grep -q 'RESULT: NOT APPLIED' && echo "$OUT" | grep -q 'PITR stalled' && [ "$(pushes stall)" = 0 ] && [ -z "$(marker stall)" ] && [ "$(altered stall)" = 0 ] && [ "$(rolconf stall)" = "$ORIGCONF" ] && ok "stalled PITR: clean STOP, push stub called zero times, no marker, the role was never altered" || bad "stalled PITR" "$(echo "$OUT" | tail -10)"
[ "$(echo "$LOG" | grep -c '^pitr: started')" -ge 3 ] && ok "  the stalled wait polled the API capture repeatedly at the fixed interval (not once)" || bad "polling" "$LOG"

# 5. refused ALTER: restore, then STOP
mkenv alt; cfg alt "ALTER_MODE=refused"; answers alt; run alt
echo "$OUT" | grep -q 'RESULT: NOT APPLIED' && echo "$OUT" | grep -q 'the ALTER ROLE was refused' && [ "$(pushes alt)" = 0 ] && [ -z "$(marker alt)" ] && [ "$(rolconf alt)" = "$ORIGCONF" ] && ok "refused ALTER: restore verified, then STOP; push stub called zero times, no marker" || bad "refused ALTER" "$(echo "$OUT" | tail -10)"

# 6. killed push: UNKNOWN, marker stays, role restored
mkenv kill; cfg kill "PUSH_MODE=killed"; answers kill; run kill
echo "$OUT" | grep -q 'RESULT: UNKNOWN -> reconcile' && marker kill | grep -q '^IN-FLIGHT' && [ "$(rolconf kill)" = "$ORIGCONF" ] && echo "$OUT" | grep -q 'do NOT rerun the push' && ok "killed push: UNKNOWN -> reconcile, the IN-FLIGHT marker stays, the role setting is restored, no rerun was made" || bad "killed push" "$(echo "$OUT" | tail -10) marker=$(marker kill)"
[ "$(pushes kill)" = 1 ] && ok "  exactly one push attempt (no retry)" || bad "push count after kill" "$(pushes kill)"

# 7. authentication failure: STOP, the auth stub is called exactly once, nothing else runs
mkenv auth; answers auth yes yes approve "WRONG-TOKEN" "$PWC"; run auth
[ "$(echo "$LOG" | grep -c '^pitr: started')" = 1 ] && echo "$OUT" | grep -q 'RESULT: NOT APPLIED' && ! echo "$LOG" | grep -q '^s0a' && [ "$(pushes auth)" = 0 ] && ok "authentication failure: STOP, pitr-backups called exactly once (no retry), no later phase, nothing pushed" || bad "auth failure" "$LOG | $(echo "$OUT" | tail -6)"

# 8. watchdog never arms: STOP before the push
mkenv wd; cfg wd "WD_MODE=silent"; answers wd; run wd
echo "$OUT" | grep -q 'RESULT:' && [ "$(pushes wd)" = 0 ] && [ -z "$(marker wd)" ] && [ "$(rolconf wd)" = "$ORIGCONF" ] && ok "watchdog that never arms: STOP, nothing pushed, role restored (the runner never types a blind yes)" || bad "watchdog" "$(echo "$OUT" | tail -8)"

# 9. an unexpected prompt from a child: STOP, nothing guessed
mkenv unx; cfg unx "X_BOGUS_PROMPT=1"; answers unx; run unx
echo "$OUT" | grep -q 'RESULT:' && [ "$(pushes unx)" = 0 ] && [ "$(rolconf unx)" = "$ORIGCONF" ] && ok "an unexpected prompt from the apply child: STOP, nothing pushed (no answer is guessed)" || bad "unexpected prompt" "$(echo "$OUT" | tail -8)"

# 10. leftover role-state record: refused at the start
mkenv left; mkdir -p "$T/left/home/hone-s1/one-command"; echo "state=ALTER-PENDING" > "$T/left/home/hone-s1/one-command/ROLE-STATE"; answers left; run left
echo "$OUT" | grep -q 'left the role setting captured but not confirmed restored' && [ ! -s "$T/left/home/hone-s1/stub.log" ] && ok "a leftover ROLE-STATE record is refused before anything runs" || bad "leftover state" "$OUT"

# 11. an existing APPLY-STATE marker: refused
mkenv mk; echo "IN-FLIGHT 2026-10-28T11:00:00Z x" > "$T/mk/home/hone-s1/s1-apply/APPLY-STATE"; answers mk; run mk
echo "$OUT" | grep -q 'an APPLY-STATE marker exists' && [ ! -s "$T/mk/home/hone-s1/stub.log" ] && ok "an APPLY-STATE marker refuses the run (reconcile, not rerun)" || bad "marker" "$OUT"

# 12. attempts per window: the third is refused
mkenv att; answers att; run att; first="$OUT"
for i in 2 3; do answers att; run att; done
echo "$OUT" | grep -q 'row-4 attempts' || echo "$OUT" | grep -q 'an APPLY-STATE marker exists' && ok "the attempt limit / marker stops a third run in the same window" || bad "attempts" "$OUT"
# stalled twice, then refused (the marker is absent in stall runs)
mkenv att2; cfg att2 "PITR_MODE=stalled"; answers att2; run att2; answers att2; run att2; answers att2; run att2
echo "$OUT" | grep -q 'already had 2 row-4 attempts' && ok "two stalled attempts use the window's budget: the third run is refused and nothing is pushed" || bad "attempt budget" "$(echo "$OUT" | tail -5)"

# 13. too little window left
mkenv short; sed -i.bak "s/^WEND=.*/WEND=$(date -u -r $(( $(date -u +%s) + 3600 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)/" "$T/short/plan.env"; answers short; run short
echo "$OUT" | grep -q 'fewer than 150 minutes' && [ ! -s "$T/short/home/hone-s1/stub.log" ] && ok "fewer than 150 minutes of window left: refused before anything runs" || bad "short window" "$OUT"

echo "RESULT: $pass passed, $fail failed"
EXPECT=${EXPECT_N:-0}; if [ "$EXPECT" != 0 ]; then [ $((pass + fail)) = "$EXPECT" ] || { echo "FAIL - $((pass + fail)) of $EXPECT cases ran"; exit 1; }; fi
[ "$fail" = 0 ]
