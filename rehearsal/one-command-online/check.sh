#!/bin/bash
# REHEARSAL - NEVER MERGE. CI check of the ONE-COMMAND runner (online flow). No hosted access, no database, canary secrets only.
# It runs hone-stage-run.sh through a REAL pty (human.exp plays the person) against the REAL text of the 0254 online apply and reconcile scripts, whose constant
# blocks are swapped for test values exactly as in the 0254 rehearsal (asserted). supabase-go, the read-back script and the pinned-binary hash are stubs.
# Runs under bash 3.2 (macOS) and bash 5 (Linux). N of N asserted.
set -u
D="$(cd "$(dirname "$0")" && pwd)"; S0=$D/../stage-0254-online; T=${RUNNER_TEMP:-/tmp}/onecmd; rm -rf "$T"; mkdir -p "$T/tv"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
A=$S0/s1-apply-0254-online.sh; R=$S0/s1-reconcile-0254-online.sh; REF=$S0/reference
CTOK=canary-token-4f1c; CPW=canary-pw-9d2e
P_RUNNER=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357; P_MANIFEST=50047991f0495403a4fc0d7635bff72fb4749769e6e3389bd9100a1aacb77fbf
P_G02=98b86eff60b3905418950ac6d090a810dac6b4ac0b500de83813f0a92120c8f3; P_G12=a8cab3cfe11e818f72464b54dbcfeb946a255b049d3d900c2412fb0652be41af
P_OPEN=c35d09584f3a34fa48145826a5fbb0555e5addcd1a1231365c812f1669daba81; P_W03=a15b47e82a0b30610cea31a2728b2cac0fe5face50f5e872ae5e18476ac24dbf
P_S1MAN=a4892e374e6f7af473b6d97311de8f76c54dfb95f12dad14e213e3ac4637ea18
# the reviewed scripts the manifest pins (0254): their shas are asserted here against the shipped manifest
P_APPLY=d966c0551567c92e553ffdef1bf020eed269391f1b3190a2decb2c3421d3181f; P_REC=6d6832bf64daedc4f3f4c760b0044b06fe1f2cacc28bd2541caf25494f2e32e1; P_S1READ=7f85cb804cc66ff119279fb5ec4ff8aa6aa68eea7a0ec9570e00a14d85e2b862

TV=$T/tv; cp "$S0/stubs/supabase-go" "$TV/supabase-go"; chmod 755 "$TV/supabase-go"; STUBSHA=$(sha "$TV/supabase-go")
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$STUBSHA/" "$REF/run-window-read-macos.sh" > "$TV/run-window-read-macos.sh"; chmod 755 "$TV/run-window-read-macos.sh"
diff <(sed '/^SUPABASE_GO_SHA256=/d' "$REF/run-window-read-macos.sh") <(sed '/^SUPABASE_GO_SHA256=/d' "$TV/run-window-read-macos.sh") >/dev/null && ok "the test runner copy differs from 471ecb9d only in the pinned-binary constant (its header allows exactly that)" || bad "runner copy differs elsewhere"
TRUN=$(sha "$TV/run-window-read-macos.sh"); echo "stub s1 manifest" > "$TV/S1MAN"; TS1MAN=$(sha "$TV/S1MAN")
python3 -I - "$TV" <<'PY'
import hashlib, io, os, sys, tarfile
t = sys.argv[1]; P = "supabase/migrations/"
f = {}
for v in range(1, 249):
    if v in (100, 247): continue
    f["%s%04d_x%d.sql" % (P, v, v)] = ("select %d;\n" % v).encode()
f[P + "0254_perm_hon44_role_enforcement.sql"] = b"select 254; -- synthetic stand-in for the sealed file\n"
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
    for d in ("supabase", "supabase/migrations"):
        ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; tf.addfile(ti)
    for n in sorted(f):
        ti = tarfile.TarInfo(n); ti.size = len(f[n]); ti.mode = 0o644; tf.addfile(ti, io.BytesIO(f[n]))
open(os.path.join(t, "b.tar"), "wb").write(buf.getvalue())
open(os.path.join(t, "l.txt"), "w").write("".join("%s  %s\n" % (hashlib.sha256(f[n]).hexdigest(), os.path.basename(n)) for n in sorted(f)))
open(os.path.join(t, "sealed.txt"), "w").write(hashlib.sha256(f[P + "0254_perm_hon44_role_enforcement.sql"]).hexdigest())
PY
TBUN=$(sha "$TV/b.tar"); TLIST=$(sha "$TV/l.txt"); TSEAL=$(cat "$TV/sealed.txt")
[ "$(grep -c '' "$TV/l.txt")" = 247 ] && ok "the synthetic bundle has 247 files: 0001..0248 less 0100 and 0247 plus a stand-in 0254 (the gate is the real text)" || bad "synthetic bundle"

want() { [ -z "${ONLY:-}" ] || echo ",${ONLY}," | grep -q ",$1,"; }
N=0
mkdir -p "$T/bin" "$T/shim"; ln -sf "$(node -p 'process.execPath')" "$T/bin/node"; export PATH="$T/bin:$PATH"
mkvar() { # mkvar SRC DST CONSTFILE [GOPENDFILE]
  awk -v cf="$3" -v gf="${4:-}" '
    /^#CONST-BEGIN$/ {print; while ((getline l < cf) > 0) print l; skip=1; next}
    /^#CONST-END$/ {skip=0}
    gf != "" && /^#GOPEND-BEGIN$/ {print; while ((getline l < gf) > 0) print l; skip=1; next}
    /^#GOPEND-END$/ {skip=0}
    !skip {print}' "$1" > "$2"
}
# newhome: a fresh fake HOME with the installed layout. Sets H.
newhome() {
  N=$((N+1)); H=$T/h$N; local r=$H/hone-s1
  mkdir -p "$r/supabase-cli" "$r/window-reads-0254" "$r/window-reads-s1-0254" "$r/s1-apply-0254-online" "$r/s1-apply"; chmod 700 "$r" "$r/window-reads-0254" "$r/window-reads-s1-0254"
  cp "$TV/supabase-go" "$r/supabase-cli/supabase-go"
  cp "$TV/run-window-read-macos.sh" "$r/window-reads-0254/"; cp "$TV/run-window-read-macos.sh" "$r/window-reads-s1-0254/"
  cp "$REF"/MANIFEST.sha256 "$REF"/g02-history-0254.sql "$REF"/g12-0254-preflight-0254.sql "$REF"/s1-open-transactions-0254.sql "$REF"/w03-table-sizes-0254.sql "$r/window-reads-0254/"
  cp "$TV/S1MAN" "$r/window-reads-s1-0254/MANIFEST.sha256"
  sed "s#__TTY__#/dev/tty#" "$S0/stubs/window-s1read-0254.sh" > "$r/window-reads-s1-0254/window-s1read-0254.sh"; chmod 755 "$r/window-reads-s1-0254/window-s1read-0254.sh"
  cp "$TV/b.tar" "$r/s1-apply-0254-online/migrations-stage0254.tar"; cp "$TV/l.txt" "$r/s1-apply-0254-online/MIGRATIONS-stage0254.sha256"
  : > "$H/stubcfg"
}
cfgset() { printf '%s\n' "$@" >> "$H/stubcfg"; }
mkconst() { # mkconst SCRIPTKIND -> $H/const.txt for the apply (full) or g02 helper (short)
  local s1sha; s1sha=$(sha "$H/hone-s1/window-reads-s1-0254/window-s1read-0254.sh")
  { echo "PLAT_OS=$(uname -s)"; echo "PLAT_ARCH=$(uname -m)"; echo "TTY=/dev/tty"; echo "GO_SHA=$STUBSHA"
    if [ "$1" = apply ]; then echo "BUNDLE=migrations-stage0254.tar"; echo "BUNDLE_SHA=$TBUN"; echo "LIST=MIGRATIONS-stage0254.sha256"; echo "LIST_SHA=$TLIST"; echo "SEALED_SHA=$TSEAL"; fi
    echo "RUNNER_SHA=$TRUN"; echo "RMANIFEST_SHA=$P_MANIFEST"
    if [ "$1" = apply ]; then echo "S1READ_SHA=$s1sha"; echo "S1RUNNER_SHA=$TRUN"; echo "S1MANIFEST_SHA=$TS1MAN"; echo "SQL_S1H=412456d394829670f8cfe1c111dc29a62e56fd6b15c9cd4ccb2a470813f6d205"; echo "SQL_G02=$P_G02"; echo "SQL_G12=$P_G12"; echo "SQL_OPEN=$P_OPEN"; echo "SQL_W03=$P_W03"; else echo "SQL_G02=$P_G02"; fi; } > "$H/const.txt"
  echo "$TSEAL  0254_perm_hon44_role_enforcement.sql" | sed "s/^/'/; s/\$/'/" | sed "1s/^/GOPEND=/" > "$H/gopend.txt"
}
mkapply() { # mkapply [SRC] : the variant of the apply script inside the fake HOME (mutations pass another SRC)
  mkconst apply; mkvar "${1:-$A}" "$H/hone-s1/s1-apply-0254-online/s1-apply-0254-online.sh" "$H/const.txt" "$H/gopend.txt"; VAR=$H/hone-s1/s1-apply-0254-online/s1-apply-0254-online.sh
}


# ------------------------------------------------------------------ harness pieces
mkrecv() { echo "RUNNER_SHA=$TRUN" > "$H/rconst.txt"; mkvar "$R" "$H/hone-s1/s1-apply-0254-online/s1-reconcile-0254-online.sh" "$H/rconst.txt"; }
mkmanifest() { # mkmanifest [IDLE_S] : the shipped manifest with test pins (the variants installed in this fake HOME) and a short idle limit
  sed -e "s/^IDLE_S=.*/IDLE_S=${1:-6}/" -e "s/^PLATFORM=.*/PLATFORM=any/" -e '/^PIN=/d' "$D/stages/0254.conf" > "$H/stage.conf"
  for rel in s1-apply-0254-online/s1-apply-0254-online.sh s1-apply-0254-online/s1-reconcile-0254-online.sh window-reads-s1-0254/window-s1read-0254.sh; do echo "PIN=$(sha "$H/hone-s1/$rel")  $rel" >> "$H/stage.conf"; done
}
home1() { newhome; [ $# -eq 0 ] || cfgset "$@"; mkapply; mkrecv; mkmanifest; RUNNER=$D/hone-stage-run.sh; }
Q_APPROVE=">>> To run this stage now, type exactly APPLY (anything else cancels, nothing has connected): "
Q_TOK=">>> Supabase access token (typed ONCE, not shown): "; Q_PW=">>> Database password (typed ONCE, not shown): "
answers() { : > "$H/ans"; for a in "$@"; do case "$a" in approve) printf '%s\t%s\t0\n' "$Q_APPROVE" APPLY ;; no) printf '%s\t%s\t0\n' "$Q_APPROVE" no ;; tok) printf '%s\t%s\t1\n' "$Q_TOK" "$CTOK" ;; pw) printf '%s\t%s\t1\n' "$Q_PW" "$CPW" ;; esac >> "$H/ans"; done; }
hrun() { # hrun [FLAGFILE] -> RC OUT (the transcript the person saw)
  rm -f "$H/hout"; ( cd "$H" && expect -f "$D/human.exp" "$H/ans" "$H/hout" "$RUNNER" "$H/stage.conf" "$H" "${1:-}" ); RC=$?
  OUT=$(cat "$H/hout" 2>/dev/null | tr -d '\r')
}
calls() { [ -f "$H/calls.log" ] && sed -E 's/ sql=.*//' "$H/calls.log" | tr '\n' ' ' | sed 's/ $//' || true; }
marker() { [ -f "$H/hone-s1/s1-apply/APPLY-STATE" ] && awk '{print $1}' "$H/hone-s1/s1-apply/APPLY-STATE" || echo none; }
result_of() { echo "$OUT" | sed -n 's/^ONE-COMMAND RESULT: //p' | head -1; }
nrec() { ls "$H"/hone-s1/s1-apply/RECONCILE-* 2>/dev/null | wc -l | tr -d ' '; }
pushes() { [ -f "$H/calls.log" ] && grep -c '^push$' "$H/calls.log" || echo 0; }
leaks() { { [ -f "$H/leak.log" ] && cat "$H/leak.log"; grep -rIl -e "$CTOK" -e "$CPW" "$H" 2>/dev/null | grep -v -e '/stubcfg$' -e '/supabase-cli/supabase-go$' -e '/ans$'; echo "$OUT" | grep -e "$CTOK" -e "$CPW"; } | head -3; }
READS4="query:g02-history-0254 query:g12-0254-preflight-0254 query:s1-open-transactions-0254 query:w03-table-sizes-0254"
# expectations for a run that must end without a push
nopush() { # nopush NAME REASONPAT WANTCALLS : NOT APPLIED, marker none, no push, no reconcile, no secret anywhere
  local g; g=$(calls)
  if [ $RC != 0 ] && [ "$(result_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && [ "$(pushes)" = 0 ] && [ "$(nrec)" = 0 ] && echo "$OUT" | grep -Eq "$2" && [ "$g" = "$3" ] && [ -z "$(leaks)" ]; then ok "$1"
  else bad "$1" "rc=$RC result=$(result_of) marker=$(marker) pushes=$(pushes) calls=[$g] want=[$3] leaks=$(leaks) $(echo "$OUT" | grep -E 'STOP|reason' | head -3)"; fi
}
unknown() { # unknown NAME REASONPAT : UNKNOWN, the marker stays, ONE push at most, the reconcile did NOT run by itself
  if [ $RC != 0 ] && echo "$(result_of)" | grep -q '^UNKNOWN' && [ "$(marker)" != none ] && [ "$(pushes)" = 1 ] && [ "$(nrec)" = 0 ] && echo "$OUT" | grep -Eq "$2" && [ -z "$(leaks)" ]; then ok "$1"
  else bad "$1" "rc=$RC result=$(result_of) marker=$(marker) pushes=$(pushes) rec=$(nrec) leaks=$(leaks) $(echo "$OUT" | grep -E 'STOP|reason' | head -3)"; fi
}

# ------------------------------------------------------------------ static facts
home1
diff <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d;/^#GOPEND-BEGIN$/,/^#GOPEND-END$/d' "$A") <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d;/^#GOPEND-BEGIN$/,/^#GOPEND-END$/d' "$VAR") >/dev/null && ok "the apply script under test differs from the shipped 0254 online script ONLY inside its constant blocks" || bad "apply variant differs outside the constants"
diff <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d' "$R") <(sed '/^#CONST-BEGIN$/,/^#CONST-END$/d' "$H/hone-s1/s1-apply-0254-online/s1-reconcile-0254-online.sh") >/dev/null && ok "the reconcile script under test differs from the shipped one ONLY inside its constant block" || bad "reconcile variant differs outside the constant"
[ "$(sha "$A")" = "$P_APPLY" ] && [ "$(sha "$R")" = "$P_REC" ] && [ "$(sha "$S0/reads-s1/window-s1read-0254.sh")" = "$P_S1READ" ] && ok "the reviewed scripts the runner runs are byte-identical to the reviewed pins (apply d966c055, reconcile 6d6832bf, read-back 7f85cb80): the runner changes none of them" || bad "reviewed script pins"
M=$D/stages/0254.conf
grep -q "^PIN=$P_APPLY  " "$M" && grep -q "^PIN=$P_REC  " "$M" && grep -q "^PIN=$P_S1READ  " "$M" && ok "stages/0254.conf pins exactly those three scripts by full sha256" || bad "manifest pins"
[ "$(grep -c '^PROMPT=' "$M")" = 5 ] && grep -q '^PROMPT=approve|Type  APPLY  to run this now (nothing has connected yet): <END>$' "$M" && ok "the manifest's prompt table has the five prompts of the reviewed scripts, in order" || bad "manifest prompts"
c=0; for t in "$(sed -n 's/^PROMPT=[a-z-]*|//p' "$M" | sort -u)"; do :; done
sed -n 's/^PROMPT=[a-z-]*|\(.*\)<END>$/\1/p' "$M" | while IFS= read -r t; do grep -rqF -e "$t" "$A" "$S0/reads-s1/window-s1read-0254.sh" || echo MISSING; done | grep -q MISSING && bad "a manifest prompt is not a prompt of the pinned scripts" || ok "every manifest prompt text appears verbatim in the pinned apply script or the pinned read-back script"
if grep -vE '^[[:space:]]*#' "$D/hone-stage-run.sh" "$D/run.exp" | grep -Ev 'echo "settings write|settings write: none|no ALTER ROLE' | grep -Eiq 'alter role|statement_timeout|supabase-go|psql|db query|PGPASSWORD|db-url|pg_[a-z_]+\('; then bad "the runner or driver contains a database statement or client"; else ok "settings untouched (static): neither the runner nor the driver names a database client, statement or setting"; fi

# ------------------------------------------------------------------ H. the happy path
home1; answers approve tok pw; hrun
w="$READS4 dry push"
if [ $RC = 0 ] && [ "$(result_of)" = "APPLIED+VERIFIED" ] && [ "$(calls)" = "$w" ] && [ "$(pushes)" = 1 ] && [ "$(marker)" = none ] && [ "$(nrec)" = 1 ] && [ -f "$H/s1read-called" ] && [ -z "$(leaks)" ]; then
  ok "HAPPY: summary -> approve -> credentials ONCE -> four reads, one dry run, ONE push, read-back -> automatic reconcile -> ONE result APPLIED+VERIFIED (marker archived, 1 record)"
else bad "happy path" "rc=$RC result=$(result_of) calls=[$(calls)] marker=$(marker) rec=$(nrec) leaks=$(leaks) $(echo "$OUT" | tail -12)"; fi
ls "$H"/hone-s1/s1-apply/APPLY-STATE.cleared.* >/dev/null 2>&1 && echo "$OUT" | grep -q 'reconcile: done: ALL' && ok "the marker was archived by the automatic reconcile on read-back evidence (class ALL)" || bad "reconcile ALL"
[ "$(grep -c "typed ONCE" <<<"$OUT")" = 2 ] && [ "$(wc -l < "$H/ans" | tr -d ' ')" = 3 ] && ok "the person typed exactly three lines (approval, token, password); the read-back's own token/password prompts were answered by the runner (the harness would have hung on a fourth prompt)" || bad "credentials entered more than once"
echo "$OUT" | grep -q 'STAGE 0254 ONLINE APPLY: what this run does' && echo "$OUT" | grep -q 'NO settings write' && ok "the reviewed script's own summary is shown to the person before the approval prompt" || bad "summary not shown"
SUMLN=$(echo "$OUT" | grep -n 'what this run does' | head -1 | cut -d: -f1); APLN=$(echo "$OUT" | grep -n 'type exactly APPLY' | head -1 | cut -d: -f1)
[ -n "$SUMLN" ] && [ -n "$APLN" ] && [ "$SUMLN" -lt "$APLN" ] && ok "order: summary, then approval, then credentials" || bad "summary/approval order"
[ -z "$(grep -vE '^query:(g02-history-0254|g12-0254-preflight-0254|s1-open-transactions-0254|w03-table-sizes-0254) |^(dry|push)$' "$H/calls.log")" ] && ! grep -qiE 'alter|role|set ' "$H/calls.log" && ok "settings untouched: the only calls the CLI saw were the four pinned reads, one dry run and one push" || bad "unexpected CLI call"
RUNDIR=$(ls -d "$H"/hone-s1/one-command/run.* | head -1)
[ -f "$RUNDIR/RESULT.txt" ] && [ -f "$RUNDIR/driver.transcript" ] && ! grep -rqF -e "$CTOK" -e "$CPW" "$RUNDIR" && ok "the evidence directory has the result and a masked transcript; no canary secret in any file" || bad "evidence directory"
[ "$(stat -f %Lp "$RUNDIR" 2>/dev/null || stat -c %a "$RUNDIR")" = 700 ] && ok "the run directory is mode 700" || bad "run dir mode"

# ------------------------------------------------------------------ D. the person does not approve
home1; answers no; hrun
nopush "declined: the person typed something other than APPLY -> NOT APPLIED, no credential asked, no CLI call" "not approved" ""
# ------------------------------------------------------------------ refusals before any prompt
home1; echo x >> "$H/hone-s1/s1-apply-0254-online/s1-reconcile-0254-online.sh"; answers approve tok pw; hrun
nopush "a changed reconcile script is refused before any prompt (pin mismatch), nothing called" "pin mismatch" ""
home1; echo x >> "$H/hone-s1/window-reads-s1-0254/window-s1read-0254.sh"; answers approve tok pw; hrun
nopush "a changed read-back script is refused before any prompt" "pin mismatch" ""
home1; rm "$H/hone-s1/s1-apply-0254-online/s1-reconcile-0254-online.sh"; answers approve tok pw; hrun
nopush "a missing pinned script is refused" "pinned file missing" ""
home1; printf 'IN-FLIGHT 2026-10-29T10:00:00Z head=x run=y\n' > "$H/hone-s1/s1-apply/APPLY-STATE"; answers approve tok pw; hrun
g=$(calls); if [ $RC != 0 ] && [ "$g" = "" ] && echo "$OUT" | grep -q 'APPLY-STATE marker exists' && [ "$(marker)" = IN-FLIGHT ] && [ "$(pushes)" = 0 ]; then ok "an APPLY-STATE marker refuses the start: no prompt, no call, marker untouched"; else bad "marker refusal" "rc=$RC calls=$g"; fi
home1; echo "failed login" > "$H/hone-s1/s1-apply/FAILED-LOGIN"; answers approve tok pw; hrun
g=$(calls); if [ $RC != 0 ] && [ "$g" = "" ] && echo "$OUT" | grep -q 'FAILED-LOGIN tombstone exists'; then ok "a FAILED-LOGIN tombstone refuses the start"; else bad "tombstone refusal" "rc=$RC calls=$g"; fi
home1; sed -i.bak '/^PROMPT=/d' "$H/stage.conf"; answers approve tok pw; hrun
nopush "a manifest with no prompt table is refused" "no PROMPT lines" ""
home1; sed -i.bak 's/^APPROVE_WORD=.*/APPROVE_WORD=x/' "$H/stage.conf"; answers approve tok pw; hrun
nopush "a malformed manifest field is refused" "APPROVE_WORD" ""

# ------------------------------------------------------------------ stalls (idle limit 6 s in the test manifest; 600 s shipped)
home1 "QUERY_HANG=g12-0254-preflight-0254"; answers approve tok pw; hrun
nopush "STALL before the push (a read hangs): idle limit -> STOP, child told to stop, NOT APPLIED, nothing pushed" "no output for 6 s" "query:g02-history-0254 query:g12-0254-preflight-0254"
home1 "S1READ=hang"; answers approve tok pw; hrun
unknown "STALL after the push (the read-back hangs): STOP -> UNKNOWN, marker stays, ONE push, NO automatic reconcile" "no output for 6 s"
# an unexpected prompt: the child asks something the manifest does not know
sed 's/^IFS= read -rs -p "Supabase access token (not shown): " TOK/IFS= read -r -p "Unexpected extra question: " XQ <"$TTY"\n&/' "$A" > "$T/a-extra.sh"
grep -q 'Unexpected extra question' "$T/a-extra.sh" || bad "mutated apply script was not built"
home1; mkapply "$T/a-extra.sh"; mkmanifest; answers approve tok pw; hrun
nopush "an UNEXPECTED PROMPT is never answered: the run STOPs (no output limit), no credential reaches the child, nothing called, NOT APPLIED" "Unexpected extra question" ""

# ------------------------------------------------------------------ authentication failures: one attempt, no retry
home1 "READ_AUTH=fail"; answers approve tok pw; hrun
n=$(grep -c '^query:' "$H/calls.log" 2>/dev/null)
if [ $RC != 0 ] && [ "$(result_of)" = "NOT APPLIED" ] && [ "$n" = 1 ] && [ "$(pushes)" = 0 ] && [ -f "$H/hone-s1/s1-apply/FAILED-LOGIN" ] && [ "$(nrec)" = 0 ] && [ -z "$(leaks)" ]; then ok "AUTH FAILURE on the first read: ONE attempt, FAILED-LOGIN tombstone, nothing pushed, no retry, NOT APPLIED"; else bad "auth failure" "rc=$RC result=$(result_of) queries=$n tomb=$(ls $H/hone-s1/s1-apply 2>/dev/null | tr '\n' ' ')"; fi
home1 "PUSH=authfail"; answers approve tok pw; hrun
if [ $RC != 0 ] && [ "$(pushes)" = 1 ] && [ ! -f "$H/s1read-called" ] && [ "$(nrec)" = 0 ] && ! echo "$(result_of)" | grep -q '^APPLIED'; then ok "AUTH FAILURE at the push: ONE push attempt, no read-back, no automatic reconcile, never reported applied ($(result_of))"; else bad "push auth failure" "rc=$RC result=$(result_of) pushes=$(pushes)"; fi
home1 "PUSH=killed"; answers approve tok pw; hrun
unknown "a KILLED push -> UNKNOWN, the marker stays, ONE push, NO automatic reconcile" "UNKNOWN"
home1 "S1READ=history246"; answers approve tok pw; hrun
unknown "the read-back shows 246 rows after the push -> UNKNOWN (never reported verified), NO automatic reconcile" "UNKNOWN"

# ------------------------------------------------------------------ interruption (a real Ctrl-C on the runner's terminal)
home1 "QUERY_HANG=g12-0254-preflight-0254"; answers approve tok pw; hrun "$H/query-started"
nopush "Ctrl-C DURING the pre-push reads: nothing pushed, NOT APPLIED, no marker, credentials never written" "interrupted by" "query:g02-history-0254 query:g12-0254-preflight-0254"
home1 "S1READ=hang"; answers approve tok pw; hrun "$H/s1read-started"
unknown "Ctrl-C AFTER the push (during the read-back): UNKNOWN, the marker stays, ONE push, NO automatic reconcile" "interrupted by"

# ------------------------------------------------------------------ generic over stage manifests: a different stage, different paths, a shorter prompt table
G=$T/gen; rm -rf "$G"; mkdir -p "$G/hone-s1/stage-x" "$G/hone-s1/s1-apply"; chmod 700 "$G/hone-s1"
cat > "$G/hone-s1/stage-x/apply-x.sh" <<'XE'
#!/bin/bash
IFS= read -r -p "Go ahead with X? " W </dev/tty
[ "$W" = GO ] || { echo "RESULT: NOT APPLIED"; exit 1; }
IFS= read -rs -p "Access token: " T </dev/tty; echo
IFS= read -rs -p "Password: " P </dev/tty; echo
[ -n "$T" ] && [ -n "$P" ] || exit 1
printf 'APPLIED-UNVERIFIED 2026-10-29T10:00:00Z head=x run=y\n' > "$HOME/hone-s1/s1-apply/APPLY-STATE"
echo "RESULT: APPLIED+VERIFIED"
XE
cat > "$G/hone-s1/stage-x/reconcile-x.sh" <<'XE'
#!/bin/bash
mv "$HOME/hone-s1/s1-apply/APPLY-STATE" "$HOME/hone-s1/s1-apply/APPLY-STATE.cleared.x" && echo "RECONCILED ALL: archived" >&2
XE
{ echo "STAGE=X1"; echo "PLATFORM=any"; echo "APPLY=stage-x/apply-x.sh"; echo "RECONCILE=stage-x/reconcile-x.sh"; echo "MARKER=s1-apply/APPLY-STATE"; echo "TOMBSTONE=s1-apply/FAILED-LOGIN"
  echo "APPROVE_WORD=GO"; echo "VERIFIED_LINE=RESULT: APPLIED+VERIFIED"; echo "IDLE_S=6"; echo "HARD_S=60"
  echo "PIN=$(sha "$G/hone-s1/stage-x/apply-x.sh")  stage-x/apply-x.sh"; echo "PIN=$(sha "$G/hone-s1/stage-x/reconcile-x.sh")  stage-x/reconcile-x.sh"
  echo "PROMPT=approve|Go ahead with X? <END>"; echo "PROMPT=secret-token|Access token: <END>"; echo "PROMPT=secret-password|Password: <END>"; } > "$G/stage.conf"
H=$G; RUNNER=$D/hone-stage-run.sh; printf '%s\t%s\t0\n' ">>> To run this stage now, type exactly GO (anything else cancels, nothing has connected): " GO > "$H/ans"; printf '%s\t%s\t1\n' "$Q_TOK" "$CTOK" >> "$H/ans"; printf '%s\t%s\t1\n' "$Q_PW" "$CPW" >> "$H/ans"
hrun
if [ $RC = 0 ] && [ "$(result_of)" = "APPLIED+VERIFIED" ] && [ "$(marker)" = none ] && echo "$OUT" | grep -q 'stage: X1'; then ok "GENERIC: the same runner runs a different stage (other approval word, paths and prompt table) from its manifest alone"; else bad "generic stage" "rc=$RC result=$(result_of) $(echo "$OUT" | tail -6)"; fi

# ------------------------------------------------------------------ mutation pass: the checks above must FAIL on a broken runner
mutate() { # mutate NAME 'sed script' : a broken copy of the runner must make the targeted scenario fail
  local name=$1 sedx=$2; sed "$sedx" "$D/hone-stage-run.sh" > "$T/mut-runner.sh"; cp "$D/run.exp" "$T/run.exp"; chmod 755 "$T/mut-runner.sh"
  cmp -s "$D/hone-stage-run.sh" "$T/mut-runner.sh" && { bad "mutation $name did not change the runner"; return; }
  home1 "S1READ=hang"; RUNNER=$T/mut-runner.sh; answers approve tok pw; hrun
  if [ "$(nrec)" != 0 ] || ! echo "$(result_of)" | grep -q '^UNKNOWN'; then ok "mutation caught: $name (the stall-after-push scenario no longer yields UNKNOWN without a reconcile)"; else bad "mutation NOT caught: $name"; fi
  RUNNER=$D/hone-stage-run.sh
}
mutate "reconcile runs even though the push was not verified" 's/if \[ "\$DRC" = 0 \] \&\& \[ "\$VER" = 1 \] \&\& \[ "\$word" = APPLIED-UNVERIFIED \]; then/if [ -n "$word" ]; then/'
mutate "an unverified push is reported as not applied" 's/^  OUTCOME="UNKNOWN -> reconcile"; REASON=/  OUTCOME="NOT APPLIED"; REASON=/'

echo
echo "RESULT: $pass passed, $fail failed"
if [ -n "${EXPECT_N:-}" ] && [ "$((pass+fail))" != "$EXPECT_N" ]; then echo "FAIL - expected $EXPECT_N checks, ran $((pass+fail))"; exit 1; fi
[ $fail = 0 ]
