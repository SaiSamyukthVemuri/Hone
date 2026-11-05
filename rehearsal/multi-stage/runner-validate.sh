#!/bin/bash
# REHEARSAL - NEVER MERGE. Runs EVERY generated stage manifest through the REAL, UNMODIFIED reviewed runner (hone-stage-run.sh) in a validation path and asserts it gets
# PAST manifest validation: the stage id, the platform, the pins, the marker checks, up to the one place it would start the interactive driver. Nothing else is stubbed:
#   - `expect` is a stub that records "reached" and exits 5 (the runner then reports NOT APPLIED / not approved), so the interactive driver never runs, nothing connects;
#   - `uname` answers Darwin / arm64 for -s / -m (the real manifests say Darwin-arm64; this runs on Linux CI);
#   - the runner runs on a pty (script), under `env -i`, with a throwaway HOME holding the files the installer would put in ~/hone-s1.
# usage: runner-validate.sh PKGDIR      prints "ok - ..." / "FAIL - ..." lines; exit status 0 when none failed.
set -u
PKG=$(cd "${1:?usage: runner-validate.sh PKGDIR}" && pwd)
command -v script >/dev/null 2>&1 || { echo "FAIL - the script(1) pty tool is missing"; exit 1; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
printf '#!/bin/bash\necho reached >> "$STUB_LOG"\nexit 5\n' > "$W/bin/expect"
printf '#!/bin/bash\ncase "${1:-}" in -s) echo Darwin ;; -m) echo arm64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' > "$W/bin/uname"
chmod +x "$W/bin/expect" "$W/bin/uname"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
run_stage() { # run_stage HOMEDIR CONF : prints the runner's output; the stub log tells whether the driver was reached
  : > "$W/stub.log"
  env -i STUB_LOG="$W/stub.log" PATH="$W/bin:/usr/bin:/bin" HOME="$1" TERM=dumb script -qec "/bin/bash $1/hone-s1/runner/hone-stage-run.sh $2" /dev/null 2>&1 </dev/null
}
n=0
for S in $(ls "$PKG" | grep -E '^[0-9]{4}[0-9A-Za-z._-]*$'); do
  [ -f "$PKG/$S/runner/stages/$S.conf" ] || continue
  n=$((n+1))
  H="$W/h$n"; mkdir -p "$H/hone-s1"
  for d in "$PKG/$S"/s1-apply-* "$PKG/$S"/window-reads-* "$PKG/$S/runner"; do cp -R "$d" "$H/hone-s1/"; done
  stage=$(sed -n 's/^STAGE=//p' "$PKG/$S/runner/stages/$S.conf")
  [ "$stage" = "$S" ] && [ "${#S}" -le 16 ] || { bad "stage $S: the manifest STAGE is '$stage' (must equal the id and be at most 16 characters)"; continue; }
  out=$(run_stage "$H" "$H/hone-s1/runner/stages/$S.conf")
  if [ "$(wc -l < "$W/stub.log" | tr -d ' ')" = 1 ] && echo "$out" | grep -q "^reason: not approved"; then :; else bad "stage $S: the real runner did NOT get past manifest validation" "$(echo "$out" | grep -E 'STOP|reason' | head -3)"; continue; fi
done
[ "$n" -gt 0 ] && [ "$fail" = 0 ] && ok "every generated manifest ($n stages) passes the REAL runner's validation (stage id, platform, pins, markers) and reaches the driver"
# negative control 1: a 17-character stage id in an otherwise valid manifest is refused by the real runner before the driver
S1=$(ls "$PKG" | grep -E '^[0-9]{4}[0-9A-Za-z._-]*$' | head -1)
H="$W/hneg"; mkdir -p "$H/hone-s1"; for d in "$PKG/$S1"/s1-apply-* "$PKG/$S1"/window-reads-* "$PKG/$S1/runner"; do cp -R "$d" "$H/hone-s1/"; done
sed "s/^STAGE=.*/STAGE=0253-after-hosted/" "$H/hone-s1/runner/stages/$S1.conf" > "$H/hone-s1/runner/stages/long.conf"
out=$(run_stage "$H" "$H/hone-s1/runner/stages/long.conf")
{ [ ! -s "$W/stub.log" ] && echo "$out" | grep -q "manifest STAGE is missing or malformed"; } && ok "NEGATIVE CONTROL: a 17-character stage id (0253-after-hosted) is refused by the real runner before the driver" || bad "NEGATIVE CONTROL: the 17-character stage id was not refused" "$(echo "$out" | tail -3)"
# negative control 2: the builder itself refuses an id over 16 characters
D=$(cd "$(dirname "$0")" && pwd)
msg=$(python3 -I -c "import sys; sys.path.insert(0, sys.argv[1]); import build; build.check_stage_id('0272-after-0254-0258', 1, 'x.sql')" "$D" 2>&1); rc=$?
{ [ $rc != 0 ] && echo "$msg" | grep -q "Refused: .*is not 1-16 characters"; } && ok "NEGATIVE CONTROL: build.py refuses a 20-character stage id (0272-after-0254-0258)" || bad "build.py accepted a 20-character stage id" "rc=$rc $msg"
python3 -I -c "import sys; sys.path.insert(0, sys.argv[1]); import build; build.check_stage_id('0253-b00', 1, 'x.sql'); build.check_stage_id('x' * 16, 1, 'x.sql')" "$D" >/dev/null 2>&1 && ok "build.py accepts a 16-character id" || bad "build.py refused a valid id"
echo "# RESULT: $pass passed, $fail failed"; [ "$fail" = 0 ]
