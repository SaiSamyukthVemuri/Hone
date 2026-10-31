#!/bin/bash
# REHEARSAL - NEVER MERGE. PREPARATION ONLY / HELD. Sequence check of a multi-stage package built by build.py: the GENERATED apply, reconcile and read-back
# scripts run as REAL TEXT, one stage after the other, against a STATEFUL stub supabase-go (a file-backed remote history that follows the real CLI's
# --include-all rule), a FIFO terminal, canary secrets and a fake HOME. The only differences from the shipped scripts are inside the #CONST block
# (asserted): the stub binary's sha, the terminal path, the platform and the test runner copy's sha. usage: seq-check.sh PKGDIR HOSTEDDIR [SEQUENCE]   (SEQUENCE: a name in PLAN.json; env ONLY_A=1 skips the negative controls)
set -u
D="$(cd "$(dirname "$0")" && pwd)"; PKG=${1:?PKGDIR}; HOSTED=${2:?HOSTEDDIR}; SEQ=${3:-full}
T=${RUNNER_TEMP:-/tmp}/msseq; rm -rf "$T"; mkdir -p "$T/shim" "$T/bin" "$T/vb"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
pj() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "$1" "$2"; }
CTOK=canary-token-4f1c; CPW=canary-pw-9d2e
STAGES=$(pj "$PKG/PLAN.json" '" ".join(d["sequences"]["'"$SEQ"'"]["stages"])'); NSTEPS=$(echo $STAGES | wc -w | tr -d ' ')
ex() { pj "$PKG/$1/EXPECT.json" "$2"; }
[ "$NSTEPS" = 0 ] && { echo "ok   - sequence $SEQ: every step dropped, nothing to apply (no stage runs, history stays the hosted one)"; echo "# RESULT: 1 passed, 0 failed"; exit 0; }
ln -sf "$(node -p 'process.execPath' 2>/dev/null || command -v true)" "$T/bin/node"
printf '%s\n' '#!/bin/bash' 'if [ "${1:-}" = -s ]; then echo Darwin; else exec "$(PATH=/usr/bin:/bin command -v uname)" "$@"; fi' > "$T/shim/uname"; chmod 755 "$T/shim/uname"
printf '%s\n' '#!/bin/bash' '[ -f "$HOME/pgrep-busy" ] && exit 0; exit 1' > "$T/shim/pgrep"; chmod 755 "$T/shim/pgrep"

# ---------------- fixtures: the stub binary, the test runner copy
STUB=$T/supabase-go; cp "$D/stubs/supabase-go-seq" "$STUB"; chmod 755 "$STUB"; STUBSHA=$(sha "$STUB")
REALRUN=$PKG/$(echo $STAGES | cut -d' ' -f1)/window-reads-$(echo $STAGES | cut -d' ' -f1)/run-window-read-macos.sh
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$STUBSHA/" "$REALRUN" > "$T/run-window-read-macos.sh"; chmod 755 "$T/run-window-read-macos.sh"; TRUN=$(sha "$T/run-window-read-macos.sh")
diff <(sed '/^SUPABASE_GO_SHA256=/d' "$REALRUN") <(sed '/^SUPABASE_GO_SHA256=/d' "$T/run-window-read-macos.sh") >/dev/null && ok "the test runner copy differs from the pinned runner only in the pinned-binary constant" || bad "runner copy differs elsewhere"

# ---------------- helpers
mkvar() { # mkvar SRC DST CONSTFILE
  awk -v cf="$3" '
    /^#CONST-BEGIN$/ {print; while ((getline l < cf) > 0) print l; skip=1; next}
    /^#CONST-END$/ {skip=0}
    !skip {print}' "$1" > "$2"; }
constblock() { sed -n '/^#CONST-BEGIN$/,/^#CONST-END$/p' "$1" | sed '1d;$d'; }
cfgset() { printf '%s\n' "$@" >> "$H/stubcfg"; }
newhome() { # a fresh fake HOME holding the hosted history. Sets H.
  H=$T/home$1; rm -rf "$H"; local r=$H/hone-s1; mkdir -p "$r/supabase-cli" "$r/s1-apply"; chmod 700 "$r"
  cp "$STUB" "$r/supabase-cli/supabase-go"; : > "$H/stubcfg"
  ls "$HOSTED" | sed -E 's/^([0-9]{4})_.*/\1/' | grep -E '^[0-9]{4}$' > "$H/remote-history"
}
install_step() { # install_step STAGE [VBDIR]: the package's files + the test variants, in the installed layout
  local S=$1 vb=${2:-} r=$H/hone-s1 P=$PKG/$1
  mkdir -p "$r/s1-apply-$S-online" "$r/window-reads-$S" "$r/window-reads-s1-$S"; chmod 700 "$r/window-reads-$S" "$r/window-reads-s1-$S"
  cp "$P/s1-apply-$S-online/"* "$r/s1-apply-$S-online/"; cp "$P/window-reads-$S/"* "$r/window-reads-$S/"; cp "$P/window-reads-s1-$S/"* "$r/window-reads-s1-$S/"
  cp "$T/run-window-read-macos.sh" "$r/window-reads-$S/"; cp "$T/run-window-read-macos.sh" "$r/window-reads-s1-$S/"
  sed "s#__TTY__#$H/tty#" "$D/stubs/window-s1read-seq.sh" > "$r/window-reads-s1-$S/window-s1read-$S.sh"; chmod 755 "$r/window-reads-s1-$S/window-s1read-$S.sh"
  local s1sha; s1sha=$(sha "$r/window-reads-s1-$S/window-s1read-$S.sh")
  local A=$P/s1-apply-$S-online/s1-apply-$S-online.sh
  constblock "$A" | sed -e "s/^GO_SHA=.*/GO_SHA=$STUBSHA/" -e "s/^PLAT_OS=.*/PLAT_OS=Darwin/" -e "s/^PLAT_ARCH=.*/PLAT_ARCH=$(uname -m)/" -e "s#^TTY=.*#TTY=$H/tty#" \
    -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$TRUN/" -e "s/^S1RUNNER_SHA=.*/S1RUNNER_SHA=$TRUN/" -e "s/^S1READ_SHA=.*/S1READ_SHA=$s1sha/" > "$H/const-$S.txt"
  if [ -n "$vb" ]; then
    cp "$vb/b.tar" "$r/s1-apply-$S-online/migrations-stage$S.tar"; cp "$vb/l.txt" "$r/s1-apply-$S-online/MIGRATIONS-stage$S.sha256"
    sed -i.bak -e "s/^BUNDLE_SHA=.*/BUNDLE_SHA=$(sha "$vb/b.tar")/" -e "s/^LIST_SHA=.*/LIST_SHA=$(sha "$vb/l.txt")/" "$H/const-$S.txt"; rm -f "$H/const-$S.txt.bak"
  fi
  mkvar "$A" "$r/s1-apply-$S-online/s1-apply-$S-online.sh" "$H/const-$S.txt"; chmod 755 "$r/s1-apply-$S-online/s1-apply-$S-online.sh"
  echo "RUNNER_SHA=$TRUN" > "$H/rconst-$S.txt"
  mkvar "$P/s1-apply-$S-online/s1-reconcile-$S-online.sh" "$r/s1-apply-$S-online/s1-reconcile-$S-online.sh" "$H/rconst-$S.txt"; chmod 755 "$r/s1-apply-$S-online/s1-reconcile-$S-online.sh"
  # the stage's stub knobs (replace the previous stage's, the stub reads the FIRST match)
  sed -i.bak -E '/^(S_STAGE|S_VER|S_S1H|S_OVERALL|G12_AT)=/d' "$H/stubcfg"; rm -f "$H/stubcfg.bak"
  cfgset "S_STAGE=$S" "S_VER=$(ex $S 'd["migration"][:4]')" "S_S1H=$(sha "$P/window-reads-s1-$S/s1-history-$S.sql")" "S_OVERALL=$(ex $S 'd["pins"]["overall"]')" "G12_AT=$(ex $S 'd["history_before"]["max"]')"
}
leftover() { python3 -I -c 'import os,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK)
d=b""
while True:
    try: x=os.read(fd,4096)
    except BlockingIOError: break
    if not x: break
    d+=x
print(d.count(b"\n"))' "$1"; }
runscript() { # runscript SCRIPT line... -> RC OUT CONSUMED TIMEOUT
  local script="$1"; shift; local total=$#
  rm -f "$H/tty"; mkfifo "$H/tty"; exec 9<>"$H/tty"; printf '%s\n' "$@" >&9
  TIMEOUT=0; local i=0
  ( cd "$H" && exec env -i HOME="$H" PATH="$T/shim:$T/bin:$PATH" LC_ALL=C /bin/bash "$script" ) > "$H/out.txt" 2>&1 & local p=$!
  while kill -0 $p 2>/dev/null; do sleep 0.2; i=$((i+1)); if [ $i -gt 300 ]; then kill -9 $p 2>/dev/null; TIMEOUT=1; break; fi; done
  wait $p 2>/dev/null; RC=$?
  CONSUMED=$(( total - $(leftover "$H/tty") )); exec 9>&-; rm -f "$H/tty"
  OUT=$(cat "$H/out.txt")
}
APPLYIN=(APPLY "$CTOK" "$CPW" APPLY "$CTOK" "$CPW")
run_apply() { runscript "$H/hone-s1/s1-apply-$1-online/s1-apply-$1-online.sh" "${APPLYIN[@]}"; }
run_recon() { rm -f "$H/out.txt"; ( cd "$H" && env -i HOME="$H" PATH="$T/shim:$T/bin:$PATH" LC_ALL=C /bin/bash "$H/hone-s1/s1-apply-$1-online/s1-reconcile-$1-online.sh" > "$H/out.txt" 2>&1 ); RC=$?; OUT=$(cat "$H/out.txt"); }
calls() { [ -f "$H/calls.log" ] && sed -E 's/ sql=.*//' "$H/calls.log" | tr '\n' ' ' | sed 's/ $//' || true; }
marker() { [ -f "$H/hone-s1/s1-apply/APPLY-STATE" ] && awk '{print $1}' "$H/hone-s1/s1-apply/APPLY-STATE" || echo none; }
receipt_of() { echo "$OUT" | sed -n 's/^RESULT: //p' | head -1; }
leaks() { rm -f "$H/tty"; { [ -f "$H/leak.log" ] && cat "$H/leak.log"; grep -rIl -e "$CTOK" -e "$CPW" "$H" 2>/dev/null | grep -v -e '/stubcfg$' -e '/supabase-cli/supabase-go$' ; echo "$OUT" | grep -e "$CTOK" -e "$CPW"; } | head -3; }
md5() { if command -v md5sum >/dev/null 2>&1; then md5sum | cut -d' ' -f1; else command md5 -q; fi; }
hist_rows() { grep -c . "$H/remote-history"; }
hist_max() { LC_ALL=C sort "$H/remote-history" | tail -1; }
hist_md5() { LC_ALL=C sort "$H/remote-history" | tr '\n' ',' | sed 's/,$//' | tr -d '\n' | md5; }
hist_is() { # hist_is STAGE before|after
  [ "$(hist_rows)" = "$(ex $1 "d['history_$2']['rows']")" ] && [ "$(hist_max)" = "$(ex $1 "d['history_$2']['max']")" ] && [ "$(hist_md5)" = "$(ex $1 "d['history_$2']['list_md5']")" ]
}
nreads() { ex $1 'd["gate_reads"]'; }
expect_calls() { # the calls a clean step makes: N pinned reads, a dry run, ONE push
  local S=$1 c="" f; for f in $(ls "$PKG/$S/window-reads-$S" | grep -E '\.sql$' | sed 's/\.sql$//'); do c="$c query:$f"; done
  local ia=""; [ "$(ex $S 'd["include_all"]')" = True ] && ia="+ia"
  echo "$c dry$ia push$ia" | sed 's/^ //'
}
# do_step STAGE: run the step, assert a clean apply and the end state; leaves the marker (APPLIED-UNVERIFIED)
do_step() {
  local S=$1; install_step "$S"; rm -f "$H/calls.log"; run_apply "$S"
}
good_step() { # good_step STAGE NAME : apply + read-back + reconcile, asserting every contract
  local S=$1 K; K=$(ex $S 'd["step"]')
  hist_is "$S" before || bad "step $K ($S): the history before is not the expected one" "rows=$(hist_rows) max=$(hist_max) md5=$(hist_md5) want=$(ex $S 'd["history_before"]["list_md5"]') md5tool=$(command -v md5sum || command -v md5) head=$(head -c 40 "$H/remote-history" | tr '\n' ' ')"
  do_step "$S"
  local want; want=$(expect_calls "$S")
  [ $RC = 0 ] && [ "$(calls)" = "$want" ] && [ "$(receipt_of)" = "APPLIED+VERIFIED" ] && [ "$(marker)" = APPLIED-UNVERIFIED ] && [ "$CONSUMED" = 6 ] && [ -z "$(leaks)" ] \
    && ok "step $K ($S): $(nreads $S) pinned reads, ONE dry run, ONE push$([ "$(ex $S 'd["include_all"]')" = True ] && echo ' (--include-all)' || echo ' (plain)'), read-back, APPLIED+VERIFIED, marker kept" \
    || bad "step $K ($S): apply" "rc=$RC calls=[$(calls)] want=[$want] receipt=$(receipt_of) marker=$(marker) consumed=$CONSUMED $(echo "$OUT" | grep STOP | head -2) leaks=$(leaks)"
  hist_is "$S" after && [ "$(grep -c "^$(ex $S 'd["migration"][:4]')\$" "$H/remote-history")" = 1 ] \
    && ok "step $K ($S): history $(hist_rows) rows, max $(hist_max), $(ex $S 'd["migration"][:4]') once, version-set md5 as planned" || bad "step $K ($S): history after" "rows=$(hist_rows) max=$(hist_max)"
  [ "$(grep -c '^push' "$H/calls.log")" = 1 ] && ok "step $K ($S): exactly one push call" || bad "step $K ($S): push count"
  run_recon "$S"
  [ $RC = 0 ] && echo "$OUT" | grep -q "RECONCILED ALL" && [ "$(marker)" = none ] && ls "$H/hone-s1/s1-apply/"APPLY-STATE.cleared.* >/dev/null 2>&1 \
    && ok "step $K ($S): reconcile ALL from the read-back evidence; marker archived" || bad "step $K ($S): reconcile" "rc=$RC $(echo "$OUT" | tail -3)"
  rm -f "$H"/hone-s1/s1-apply/APPLY-STATE.cleared.*
}
advance() { # advance N : apply steps 1..N cleanly, silently (for the negative controls)
  local i=0 S; for S in $STAGES; do i=$((i+1)); [ $i -gt $1 ] && break; install_step "$S"; run_apply "$S"; [ $RC = 0 ] || { echo "advance failed at $S: $OUT" >&2; return 1; }; run_recon "$S"; [ $RC = 0 ] || { echo "reconcile failed at $S: $OUT" >&2; return 1; }; rm -f "$H"/hone-s1/s1-apply/APPLY-STATE.cleared.*; done; rm -f "$H/calls.log"
}
# expect_stop NAME 'STOP regex' [calls-regex]: the last run STOPPED before the push; nothing pushed; no marker; NOT APPLIED; history unchanged
expect_stop() {
  local name="$1" pat="$2" hbefore="$3"
  local pushed; pushed=$(grep -c '^push' "$H/calls.log" 2>/dev/null); pushed=${pushed:-0}
  if [ $RC != 0 ] && [ $TIMEOUT = 0 ] && echo "$OUT" | grep -Eq "STOP: .*($pat)" && [ "$pushed" = 0 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && [ "$(hist_rows)" = "$hbefore" ] && [ -z "$(leaks)" ]; then ok "$name"
  else bad "$name" "rc=$RC timeout=$TIMEOUT pushed=$pushed marker=$(marker) receipt=$(receipt_of) rows=$(hist_rows)/$hbefore $(echo "$OUT" | grep STOP | head -2) leaks=$(leaks)"; fi
}
mkvb() { # mkvb STAGE ADD DROP ALT [ALTV] : a variant bundle (b.tar l.txt in $T/vb) built with the SAME tar/list code as the builder
  rm -rf "$T/vb"; mkdir -p "$T/vb"
  python3 -I - "$D" "$PKG/$1/s1-apply-$1-online/migrations-stage$1.tar" "$T/vb" "$2" "$3" "$4" "$(ex $1 'd["migration"]')" "${5:-}" <<'PY'
import hashlib, io, sys, tarfile
d, tarp, out, add, drop, alt, pend, altv = sys.argv[1:9]
sys.path.insert(0, d)
import build
files = {}
with tarfile.open(tarp) as tf:
    for m in tf.getmembers():
        if m.isfile(): files[m.name.split("/")[-1]] = tf.extractfile(m).read()
for a in [x for x in add.split(",") if x]: files[a] = ("-- extra\nselect 1;\n").encode()
for v in [x for x in drop.split(",") if x]:
    for n in [n for n in files if n.startswith(v + "_")]: del files[n]
if alt == "1": files[pend] = files[pend] + b"-- altered\n"
if altv:
    for n in [n for n in files if n.startswith(altv + "_")]: files[n] = files[n] + b"-- altered\n"
open(out + "/b.tar", "wb").write(build.ustar(files))
open(out + "/l.txt", "w").write("".join("%s  %s\n" % (hashlib.sha256(b).hexdigest(), n) for n, b in sorted(files.items())))
PY
}

# ================================================================== the plan itself
echo "# plan: $NSTEPS step(s): $STAGES"
c=0; for S in $STAGES; do
  [ "$(sha "$PKG/$S/s1-apply-$S-online/s1-apply-$S-online.sh")" = "$(ex $S 'd["pins"]["apply"]')" ] || { c=1; bad "$S: apply sha is not its recorded pin"; }
  grep -q "^PIN=$(ex $S 'd["pins"]["apply"]')  s1-apply-$S-online/s1-apply-$S-online.sh\$" "$PKG/$S/runner/stages/$S.conf" || { c=1; bad "$S: the stage conf does not pin the apply script"; }
  grep -q "^PIN=$(ex $S 'd["pins"]["reconcile"]')  s1-apply-$S-online/s1-reconcile-$S-online.sh\$" "$PKG/$S/runner/stages/$S.conf" || { c=1; bad "$S: the stage conf does not pin the reconcile script"; }
  grep -q "^PIN=$(ex $S 'd["pins"]["s1read"]')  window-reads-s1-$S/window-s1read-$S.sh\$" "$PKG/$S/runner/stages/$S.conf" || { c=1; bad "$S: the stage conf does not pin the read-back script"; }
  (cd "$PKG/$S" && shasum -a 256 -c SHA256SUMS.txt >/dev/null 2>&1) || { c=1; bad "$S: SHA256SUMS.txt does not verify"; }
  [ "$(tar -tf "$PKG/$S/s1-apply-$S-online/migrations-stage$S.tar" | grep -c '\.sql$')" = "$(ex $S 'd["bundle"]["files"]')" ] || { c=1; bad "$S: bundle file count is not the plan's"; }
done
[ $c = 0 ] && ok "every step: apply/reconcile/read-back shas equal the plan and the stage conf pins, SHA256SUMS verifies, the bundle holds exactly the planned file count"
# the bundle of step k is the bundle of step k-1 plus exactly one file (the bundle is the control)
prev=""; c=0; for S in $STAGES; do
  tar -tf "$PKG/$S/s1-apply-$S-online/migrations-stage$S.tar" | grep '\.sql$' | sed 's#.*/##' | LC_ALL=C sort > "$T/b-$S.txt"
  if [ -n "$prev" ]; then [ "$(comm -13 "$T/b-$prev.txt" "$T/b-$S.txt" | wc -l | tr -d ' ')" = 1 ] && [ "$(comm -23 "$T/b-$prev.txt" "$T/b-$S.txt" | wc -l | tr -d ' ')" = 0 ] && [ "$(comm -13 "$T/b-$prev.txt" "$T/b-$S.txt")" = "$(ex $S 'd["migration"]')" ] || { c=1; bad "$S: bundle is not the previous bundle plus its one migration"; }; fi
  prev=$S
done; [ $c = 0 ] && ok "each bundle is the previous bundle plus exactly the step's one migration (nothing else added or removed)"

# ================================================================== A. the whole sequence, in order
# P. the runner's prompt table equals the apply's prompts EXACTLY: six PROMPT lines per stage, in order approve, token, password, approve2, token, password
for S in $STAGES; do
  python3 -I - "$PKG/$S/runner/stages/$S.conf" "$PKG/$S/s1-apply-$S-online/s1-apply-$S-online.sh" "$S" <<'PY' && ok "  runner prompts: $S: six PROMPT lines; the 1st and 4th APPLY prompts equal the apply's own ask texts byte for byte" || bad "  runner prompts: $S" "the conf prompt table differs from the apply"
import re, sys
conf, apply_, S = sys.argv[1:4]
c = [l.rstrip("\n") for l in open(conf) if l.startswith("PROMPT=")]
a = open(apply_).read()
asks = [("GOWORD", t) for t in re.findall(r'^ask GOWORD "([^"\n]*)"$', a, re.M)] + [("GOWORD2", t) for t in re.findall(r'-t 600 -p "([^"\n]*)" GOWORD2', a)]
assert len(c) == 6, "conf has %d PROMPT lines" % len(c)
assert [x.split("|")[0] for x in c] == ["PROMPT=approve", "PROMPT=secret-token", "PROMPT=secret-password"] * 2, c
assert [w for w, _ in asks] == ["GOWORD", "GOWORD2"], asks
for i, (w, t) in zip((0, 3), asks):
    assert c[i].split("|", 1)[1] == t + "<END>", (i, c[i], t)
PY
done
echo "# A. combined sequence"
newhome A; : > "$H/calls.log"
for S in $STAGES; do good_step "$S"; done
[ "$(hist_rows)" = "$(ex "$(echo $STAGES | awk '{print $NF}')" 'd["history_after"]["rows"]')" ] && ok "combined: final history $(hist_rows) rows, max $(hist_max) after $NSTEPS runner invocations (one migration each)" || bad "combined final history"

# ================================================================== B. negative controls
if [ "${ONLY_A:-0}" = 1 ]; then echo "# RESULT: $pass passed, $fail failed"; [ $fail = 0 ]; exit; fi
echo "# B. negative controls"
S1=$(echo $STAGES | cut -d' ' -f1); S2=$(echo $STAGES | cut -d' ' -f2); S3=$(echo $STAGES | cut -d' ' -f3)
FORWARD2=$(ex $S2 'd["migration"]')

# B1. a marker that was NOT reconciled refuses the next step (single flight)
newhome B1; install_step "$S1"; run_apply "$S1"; install_step "$S2"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S2"
[ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && [ "$(marker)" = APPLIED-UNVERIFIED ] && [ "$(hist_rows)" = "$before" ] \
  && ok "step 2 refuses to start while step 1's APPLY-STATE marker has not been reconciled: no prompt, no call, history unchanged" || bad "B1 marker gate" "rc=$RC calls=[$(calls)] consumed=$CONSUMED $(echo "$OUT" | tail -2)"

# B2. extra file (a later step's migration) in step 1's bundle, correctly pinned: the file-set gates must stop it
newhome B2; install_step "$S1"; mkvb "$S1" "$FORWARD2" "" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "EXTRA FILE: step 1's bundle also carries step 2's migration (pinned consistently): STOP before any call" "(files|holds|names|not part of this stage|differs|lines)" "$(hist_rows)"
[ "$(calls)" = "" ] && ok "  ... and it stopped before the CLI was even called" || bad "  extra file: a call was made" "$(calls)"
# B3. an extra unapplied OLD version (the include-all danger): 0255 in step 1's bundle
newhome B3; install_step "$S1"; mkvb "$S1" "0255_stray.sql" "" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "EXTRA FILE below the head (0255, would be taken by --include-all): STOP, nothing pushed" "(files|holds|names|not part of this stage|differs|lines)" "$(hist_rows)"
# B3b. count-neutral swap: the stray 0255 added and hosted 0001 dropped, so the file COUNT is right and only the NAMED-FILE gates can stop it
newhome B3b; install_step "$S1"; mkvb "$S1" "0255_stray.sql" "0001" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "SWAPPED FILE (right count): 0255 added, 0001 dropped: STOP on the named-file gates, nothing pushed" "(not part of this stage|names|holds|pending file)" "$(hist_rows)"
# B3c. count-neutral swap with a number OUTSIDE every named absent list (0158 is permanently skipped): only the embedded ALLOWLIST can stop it
newhome B3c; install_step "$S1"; mkvb "$S1" "0158_stray.sql" "0001" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "SWAPPED FILE of an unlisted number (0158 added, 0001 dropped, right count): STOP (adopted v2: at the dry-run listing, before any push), nothing pushed" "(allowlist|dry run lists)" "$(hist_rows)"
# the same swap on a GENERATED step (embedded allowlist): it must stop on the allowlist itself, earlier than the dry run
newhome B3d; advance 1; install_step "$S2"; mkvb "$S2" "0158_stray.sql" "0001" 0; install_step "$S2" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S2"; expect_stop "SWAPPED FILE of an unlisted number at step 2 (generated, embedded allowlist): STOP on the allowlist, nothing pushed" "allowlist" "$(hist_rows)"
# B6b. a hosted file CHANGED (0257), list and tar re-pinned consistently: only the allowlist / sha pins can stop it
newhome B6b; install_step "$S1"; mkvb "$S1" "" "" 0 "0257"; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "CHANGED HOSTED FILE: 0257's body altered in a consistently re-pinned bundle: STOP on the allowlist / sha pin" "(allowlist|pinned|differs|does not carry)" "$(hist_rows)"
# B6c. an EARLIER STEP's file changed in a later step's bundle
newhome B6c; install_step "$S2"; mkvb "$S2" "" "" 0 "$(ex $S1 'd["migration"][:4]')"; install_step "$S2" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S2"; expect_stop "CHANGED EARLIER STEP: step 1's migration altered inside step 2's bundle: STOP on the allowlist / sha pin" "(allowlist|pinned|differs)" "$(hist_rows)"
# B6d. every file of the bundle is unexpected: a hosted file of another number swapped for a different NAME (rename)
newhome B6d; advance 1; install_step "$S2"; python3 -I - "$D" "$PKG/$S2/s1-apply-$S2-online/migrations-stage$S2.tar" "$T/vb2" <<'PY'
import hashlib, os, sys, tarfile
d, tarp, out = sys.argv[1:4]
sys.path.insert(0, d)
import build
files = {}
with tarfile.open(tarp) as tf:
    for m in tf.getmembers():
        if m.isfile(): files[m.name.split("/")[-1]] = tf.extractfile(m).read()
old = [n for n in files if n.startswith("0002_")][0]
files["0002_renamed_file.sql"] = files.pop(old)
os.makedirs(out, exist_ok=True)
open(out + "/b.tar", "wb").write(build.ustar(files))
open(out + "/l.txt", "w").write("".join("%s  %s\n" % (hashlib.sha256(b).hexdigest(), n) for n, b in sorted(files.items())))
PY
install_step "$S2" "$T/vb2"; rm -f "$H/calls.log"; run_apply "$S2"; expect_stop "RENAMED FILE at step 2 (generated, embedded allowlist): a hosted migration under a different name (same bytes, same count): STOP on the allowlist" "allowlist" "$(hist_rows)"
# B6e. DOCUMENTED difference of the adopted v2 step 1: it has no per-name allowlist of the 247 hosted files (its LIST_SHA pin IS the allowlist). A hosted file renamed
# inside a bundle that is re-pinned in the script too (a different script) is accepted, but a same-version rename cannot change what is applied (the history keys on the version).
# B4. missing hosted file
newhome B4; install_step "$S1"; mkvb "$S1" "" "0001" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "MISSING FILE: hosted 0001 absent from the bundle: STOP before any call" "(files|missing|differs|names|lines)" "$(hist_rows)"
# B5. missing pending file
newhome B5; install_step "$S1"; mkvb "$S1" "" "$(ex $S1 'd["migration"][:4]')" 0; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "MISSING FILE: the pending migration is not in the bundle: STOP before any call" "(files|missing|does not name|differs|lines)" "$(hist_rows)"
# B6. altered pending file (sealed sha differs)
newhome B6; install_step "$S1"; mkvb "$S1" "" "" 1; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "ALTERED FILE: the pending migration differs from its sealed sha: STOP before any call" "(sealed|differs)" "$(hist_rows)"
# B7. wrong sha: a byte appended to the pinned bundle, constants untouched
newhome B7; install_step "$S1"; echo x >> "$H/hone-s1/s1-apply-$S1-online/migrations-stage$S1.tar"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "WRONG SHA: the bundle tar was changed after pinning: STOP before any call" "(sha256|sha|differs|pinned)" "$(hist_rows)"
newhome B7b; install_step "$S1"; echo x >> "$H/hone-s1/s1-apply-$S1-online/MIGRATIONS-stage$S1.sha256"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "WRONG SHA: the bundle list was changed after pinning: STOP before any call" "(sha256|sha|differs|pinned)" "$(hist_rows)"
newhome B7c; install_step "$S1"; echo x >> "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh"; rm -f "$H/calls.log"
# (the runner pins the apply script itself; run directly, a changed script is simply a different script. The conf pin is asserted below.)
# B7d. the SECOND APPLY (after the dry-run listing) is declined: nothing is pushed, receipt NOT APPLIED, no marker
newhome B7d; install_step "$S1"; rm -f "$H/calls.log"; runscript "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh" APPLY "$CTOK" "$CPW" NO "$CTOK" "$CPW"
before=$(hist_rows)
[ $RC != 0 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && ! grep -q '^push' "$H/calls.log" && [ "$(hist_rows)" = "$before" ] && [ -z "$(leaks)" ] \
  && ok "SECOND APPLY declined (answer NO after the dry-run listing): the dry run ran, NOTHING pushed, receipt NOT APPLIED, no marker, history unchanged" || bad "B7d second apply declined" "rc=$RC calls=[$(calls)] receipt=$(receipt_of) marker=$(marker)"
# B7e. the SECOND prompt TIMES OUT (the real 10-minute wait scaled to 3 s in this test copy only: `read -t 600` -> `read -t 3`): treated as declined, NOT APPLIED, credentials cleared
newhome B7e; install_step "$S1"; sed -i.bak 's/read -r -t 600 -p/read -r -t 3 -p/' "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh"; rm -f "$H/hone-s1/s1-apply-$S1-online/"*.bak
grep -q 'read -r -t 3 -p' "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh" || bad "B7e test copy" "the timeout line was not found"
rm -f "$H/calls.log"; runscript "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh" APPLY "$CTOK" "$CPW"; before=$(hist_rows)
[ $RC != 0 ] && [ "$TIMEOUT" = 0 ] && [ "$CONSUMED" = 3 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && ! grep -q '^push' "$H/calls.log" && grep -q '^dry' "$H/calls.log" \
  && echo "$OUT" | grep -Eq "(no second APPLY within 10 minutes: treated as declined|the second APPLY could not be read \(end of input\): treated as declined)\. NOTHING was applied; the credentials were cleared" && [ -z "$(leaks)" ] \
  && ok "SECOND PROMPT TIMEOUT: treated as declined, the dry run ran, NOTHING pushed, receipt NOT APPLIED, no marker, 'credentials were cleared'" || bad "B7e second prompt timeout" "rc=$RC consumed=$CONSUMED receipt=$(receipt_of) marker=$(marker) calls=[$(calls)] $(echo "$OUT" | grep STOP | tail -1)"
# B7f-h. the history differs in rows_0248 / last4 (the v2 g02 rule): STOP at the history gate, BEFORE the dry run
g02case() { # g02case NAME LABEL REGEX [forge knob] : the stub answers the g02 read with a forged field, or the history is edited first
  newhome "$1"; install_step "$S1"; [ -n "${4:-}" ] && cfgset "$4"; [ -n "${5:-}" ] && eval "$5"; rm -f "$H/calls.log"; local before; before=$(hist_rows); run_apply "$S1"
  [ $RC != 0 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && [ "$(calls)" = "query:g02-history-$S1" ] && [ "$(hist_rows)" = "$before" ] && echo "$OUT" | grep -Eq "$3" && [ -z "$(leaks)" ] \
    && ok "$2: STOP at the history gate, only the g02 read ran (before the dry run), nothing pushed" || bad "$1 $2" "rc=$RC receipt=$(receipt_of) marker=$(marker) calls=[$(calls)] $(echo "$OUT" | grep STOP | tail -1)"
}
g02case B7f "rows_0248 differs (forged rows_0248=0, everything else as expected)" "rows_0248" "G02_FORGE_ROWS0248=0"
g02case B7g "last4 differs (forged, everything else as expected)" "last4" "G02_FORGE_LAST4=0257,0248,0247,0246"
g02case B7h "history really differs: 0248 replaced by 0247 (same count and max)" "(rows_0248|last4|0247)" "" 'sed -i.bak "s/^0248\$/0247/" "$H/remote-history"; rm -f "$H/remote-history.bak"'
# B8. out of order: step 3 offered while the history is at the start (step 1 and 2 absent)
newhome B8; install_step "$S3"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S3"; expect_stop "OUT OF ORDER: step 3 run on the start history (steps 1 and 2 not applied): STOP at the history gate, nothing after it runs" "(rows|max|version set|history)" "$before"
[ "$(calls)" = "query:g02-history-$S3" ] && ok "  ... only the history read ran" || bad "  out-of-order: calls" "$(calls)"
# B9. out of order: step 2 run after step 1 has not been applied but with step 2's own bundle (which lacks step 1)
newhome B9; install_step "$S2"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S2"; expect_stop "OUT OF ORDER: step 2 on the start history (step 1 missing): STOP at the history gate" "(rows|max|version set|history)" "$before"
# B10. repeat: step 1 run a second time after it is applied
newhome B10; advance 1; install_step "$S1"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S1"; expect_stop "REPEAT: step 1 run again after it was applied: STOP at the history gate (no second push)" "(rows|max|version set|already applied|history)" "$before"
# B11. failure injected at step 2: history stops at step 1, the marker stays, the next step refuses
k=2; newhome B11; advance 1; install_step "$S2"; cfgset "FAIL_PUSH_VER=${FORWARD2%%_*}"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S2"
[ $RC != 0 ] && [ "$(marker)" = IN-FLIGHT ] && receipt_of | grep -q "^UNKNOWN" && [ "$(hist_rows)" = "$before" ] && hist_is "$S2" before && [ "$(grep -c '^push' "$H/calls.log")" = 1 ] \
  && ok "FAILURE AT STEP 2: the push failed; history is still step 1's end state ($(hist_rows) rows, max $(hist_max)); receipt UNKNOWN; marker IN-FLIGHT; exactly one push attempt, no retry" || bad "B11 failure at step 2" "rc=$RC marker=$(marker) receipt=$(receipt_of) rows=$(hist_rows) $(echo "$OUT" | tail -3)"
install_step "$S3"; rm -f "$H/calls.log"; run_apply "$S3"
[ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && [ "$(marker)" = IN-FLIGHT ] \
  && ok "  ... and the runner REFUSES TO CONTINUE: step 3 stops at the surviving marker, no prompt, no call" || bad "B11 step 3 after failure" "rc=$RC calls=[$(calls)] $(echo "$OUT" | tail -2)"
install_step "$S2"; rm -f "$H/calls.log"; run_apply "$S2"
[ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && ok "  ... and step 2 itself cannot be re-run either (no retry path): same marker refusal" || bad "B11 step 2 rerun" "rc=$RC calls=[$(calls)]"
# B12. a failure at each later step too
for kk in 3 4; do
  [ $kk -le $NSTEPS ] || continue
  Sk=$(echo $STAGES | cut -d' ' -f$kk); Vk=$(ex $Sk 'd["migration"][:4]')
  newhome B12-$kk; advance $((kk-1)); install_step "$Sk"; cfgset "FAIL_PUSH_VER=$Vk"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$Sk"
  [ $RC != 0 ] && [ "$(marker)" = IN-FLIGHT ] && [ "$(hist_rows)" = "$before" ] && hist_is "$Sk" before && ok "FAILURE AT STEP $kk ($Sk): history stops at step $((kk-1))'s end state ($(hist_rows) rows), marker IN-FLIGHT" || bad "B12 failure at step $kk" "rc=$RC marker=$(marker) rows=$(hist_rows)"
done
# B13. a failed pre-push read at step 2 (a gate fails): nothing pushed, no marker
newhome B13; advance 1; install_step "$S2"; cfgset "FAIL_QUERY=g02-history-$S2"; rm -f "$H/calls.log"; before=$(hist_rows); run_apply "$S2"; expect_stop "a failed history read at step 2 stops before the push" "failed" "$before"
# B14. the dry run must list exactly the step: a second unapplied file the bundle does not hold cannot appear; prove the stub-level rule instead (plain push of a below-head file refuses)
newhome B14; advance 1; mkdir -p "$T/pp/supabase/migrations"; rm -rf "$T/pp"; mkdir -p "$T/pp/supabase/migrations"; cp "$HOSTED"/*.sql "$T/pp/supabase/migrations/" 2>/dev/null
printf 'select 1;\n' > "$T/pp/supabase/migrations/0255_late.sql"
( cd "$T/pp" && HOME="$H" PGPASSWORD=$CPW "$H/hone-s1/supabase-cli/supabase-go" db push --db-url x --dry-run ) > "$T/pp.out" 2>&1; prc=$?
( cd "$T/pp" && HOME="$H" PGPASSWORD=$CPW "$H/hone-s1/supabase-cli/supabase-go" db push --db-url x --include-all --dry-run ) > "$T/pp2.out" 2>&1
[ $prc != 0 ] && grep -q "include-all" "$T/pp.out" && grep -q "0255_late" "$T/pp2.out" && ok "the stub follows the real CLI: a plain dry run refuses a below-head file; --include-all would take it (this is why the bundle is the control)" || bad "stub include-all semantics" "$(cat $T/pp.out)"

# ================================================================== D. stage-drop rules (plan validation before any stage runs)
echo "# D. stage-drop rules"
PC=$PKG/plan-check.sh
pc_refuse() { local name="$1" pat="$2"; shift 2; out=$("$PC" "$@" 2>&1); rc=$?; if [ $rc != 0 ] && echo "$out" | grep -Eq "PLAN REFUSED: .*($pat)"; then ok "$name"; else bad "$name" "rc=$rc $out"; fi; }
pc_accept() { local name="$1" seqname="$2"; shift 2; out=$("$PC" "$@" 2>&1); rc=$?; want=$(pj "$PKG/PLAN.json" '" ".join(d["sequences"]["'"$seqname"'"]["stages"])'); got=$(echo $out); if [ $rc = 0 ] && [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "rc=$rc got=[$got] want=[$want]"; fi; }
pc_refuse "RULE 2: 0258 without 0272 (0272 dropped, 0266 kept) is refused" "immediately followed by 0272" 0254 0258 0266 0271
pc_refuse "RULE 2: 0258 alone (0272 and 0266 dropped) is refused" "immediately followed by 0272" 0254 0258 0271
pc_refuse "RULE 2: 0272 not IMMEDIATELY after 0258 (0266 in between) is refused" "immediately followed by 0272" 0254 0258 0266 0272 0271
pc_refuse "RULE 2: 0272 before 0258 is refused" "immediately followed by 0272" 0254 0272 0258
pc_refuse "RULE 3: 0266 without 0258 (0258 and 0272 dropped) is refused" "dependency closure: 0258 is dropped, so 0266" 0254 0266
pc_refuse "RULE 1: 0266 without 0258 and 0271 kept is still refused" "dependency closure: 0258 is dropped, so 0266" 0254 0266 0271
pc_refuse "RULE 1: 0272 without 0258 is refused (dropping 0258 drops 0272)" "dependency closure: 0258 is dropped, so 0272" 0254 0272 0271
pc_refuse "RULE 3: 0266 before 0272 (0258 and 0272 after it) is refused" "(immediately followed|needs 0258)" 0254 0266 0258 0272
pc_refuse "a duplicate version is refused" "planned twice" 0254 0254
pc_refuse "a malformed version is refused" "not a four-digit" 0254 25x
pc_refuse "a rule-clean plan in an order no package was built for is refused (exact lookup)" "no pre-built stage package" 0271 0254
pc_accept "the FULL plan is accepted and names exactly the pre-built stages" full 0254 0258 0272 0266 0271
pc_accept "RULE 3: a plan with 0266 DROPPED is accepted (0258 and 0272 stay, adjacent)" drop-0266 0254 0258 0272 0271
pc_accept "RULE 4: 0254 dropped alone is accepted (independent)" drop-0254 0258 0272 0266 0271
pc_accept "RULE 4: 0271 dropped alone is accepted (independent)" drop-0271 0254 0258 0272 0266
pc_accept "RULE 4: both independent steps dropped is accepted" drop-0254+0271 0258 0272 0266
pc_accept "RULE 1: dropping 0258 with its closure {0272, 0266} is accepted" drop-0258+0272+0266 0254 0271
pc_accept "only the independent steps remain (everything with 0258 dropped) is accepted" drop-0258+0272+0266+0271 0254

# ================================================================== E. a 0272 failure after 0258 stops the session at 0258, history verified
echo "# E. 0272 failure after 0258"
idx_of() { local i=0 S; for S in $STAGES; do i=$((i+1)); [ "$(ex $S 'd["migration"][:4]')" = "$1" ] && { echo $i; return; }; done; echo 0; }
I58=$(idx_of 0258); I72=$(idx_of 0272); I66=$(idx_of 0266)
if [ "$I58" != 0 ] && [ "$I72" = $((I58+1)) ]; then
  S58=$(echo $STAGES | cut -d' ' -f$I58); S72=$(echo $STAGES | cut -d' ' -f$I72)
  newhome E; advance $I58; hist_is "$S58" after && ok "0258 is applied, read back and reconciled: history $(hist_rows) rows, max $(hist_max), 0258 once" || bad "E: 0258 state"
  install_step "$S72"; cfgset "FAIL_PUSH_VER=0272"; rm -f "$H/calls.log"; run_apply "$S72"
  if [ $RC != 0 ] && [ "$(marker)" = IN-FLIGHT ] && receipt_of | grep -q "^UNKNOWN" && [ "$(grep -c '^push' "$H/calls.log")" = 1 ] && hist_is "$S58" after && [ "$(grep -c '^0258$' "$H/remote-history")" = 1 ] && [ "$(grep -c '^0272$' "$H/remote-history")" = 0 ]; then
    ok "0272 FAILS after 0258: the session STOPS at 0258 - history verified ($(hist_rows) rows, max $(hist_max), the exact version set of 0258's end state), 0258 still applied (nothing reverted), 0272 absent, one push attempt, marker IN-FLIGHT"
  else bad "E: 0272 failure" "rc=$RC marker=$(marker) rows=$(hist_rows) max=$(hist_max) $(echo "$OUT" | tail -2)"; fi
  if [ "$I66" != 0 ]; then S66=$(echo $STAGES | cut -d' ' -f$I66); install_step "$S66"; rm -f "$H/calls.log"; run_apply "$S66"
    [ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] && ok "  ... and 0266 REFUSES to start (the surviving marker): no prompt, no call" || bad "E: 0266 after the failure" "rc=$RC calls=[$(calls)]"; fi
  # even with the marker cleared by hand, 0266's stage refuses the history (0258 applied, 0272 not)
  if [ "$I66" != 0 ]; then rm -f "$H/hone-s1/s1-apply/APPLY-STATE"; rm -f "$H/calls.log"; run_apply "$S66"
    expect_stop "  ... and with the marker cleared, 0266's stage still STOPs at the history gate (0258 without 0272 is not its expected set)" "(rows|max|version set|history)" "$(hist_rows)"; fi
else bad "E: the plan has no 0258 immediately followed by 0272"; fi

# ================================================================== C. the REAL generated read-back check (the node program inside window-s1read), on fabricated result files
echo "# C. generated read-back check"
for S in $STAGES; do
  K=$(ex $S 'd["step"]'); sc=$PKG/$S/window-reads-s1-$S/window-s1read-$S.sh; mj=$T/check-$S.mjs
  sed -n "/<<'NODE'\$/,/^NODE\$/p" "$sc" | sed '1d;$d' > "$mj"
  [ -s "$mj" ] || { bad "step $K ($S): no check program found in the read-back script"; continue; }
  mkres() { # mkres N MAX MD5 ROWS : fabricate the history result
    mkdir -p "$T/res-$S"; printf '[{"applied_count":%s,"hosted_max":"%s","list_md5":"%s","rows_%s":%s}]\n' "$1" "$2" "$3" "$(ex $S 'd["migration"][:4]')" "$4" > "$T/res-$S/s1-history-$S.json"; }
  nr=$(ex $S 'd["history_after"]["rows"]'); mx=$(ex $S 'd["history_after"]["max"]'); md=$(ex $S 'd["history_after"]["list_md5"]')
  jrun() { A_RES="$T/res-$S" node "$mj" 2>&1; }
  haspack=$(ex $S 'd["content_gates"]')
  if [ "$haspack" = False ]; then
    mkres $nr $mx $md 1; o=$(jrun); echo "$o" | grep -Fxq "$(ex $S 'd["pins"]["overall"]')" && ok "step $K ($S): the generated check PASSES on the exact planned end-state history (history-only step)" || bad "step $K ($S): generated check on the good history" "$o"
  fi
  for v in "bad rows|$((nr-1)) $mx $md 1" "bad max|$nr 9999 $md 1" "bad md5|$nr $mx 00000000000000000000000000000000 1" "migration absent|$nr $mx $md 0" "migration twice|$nr $mx $md 2"; do
    mkres $(echo "${v#*|}" | cut -d' ' -f1) $(echo "${v#*|}" | cut -d' ' -f2) $(echo "${v#*|}" | cut -d' ' -f3) $(echo "${v#*|}" | cut -d' ' -f4)
    o=$(jrun); rc=$?; if [ $rc != 0 ] && ! echo "$o" | grep -q "OVERALL PASS" && echo "$o" | grep -q "FAIL"; then ok "step $K ($S): the generated check REFUSES a history with ${v%%|*}"; else bad "step $K ($S): generated check accepted ${v%%|*}" "rc=$rc $o"; fi
  done
done

echo "# RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
