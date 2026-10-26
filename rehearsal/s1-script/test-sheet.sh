#!/bin/bash
# REHEARSAL - NEVER MERGE. Runs the lines of 01-ops/watchdog-operator/WATCHDOG-OPERATOR.txt (a verbatim copy) pasted into an INTERACTIVE shell
# (bash 3.2 or zsh; echo off, no rc files) with a FAKE scp, as test-download.sh does. The watchdog is a STUB; its sha256 is swapped into the
# lines for the test only. usage: test-sheet.sh <shell> <dir with WATCHDOG-OPERATOR.txt and drive-sheet.py>
SH="$1"; HERE="$2"
SHEET="$HERE/WATCHDOG-OPERATOR.txt"; REALSHA=1011530ffdfaddde0bb5ff54a0f0abcd19da9cf13456718f2efd9ab21f11a885
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
echo "shell: $SH $("$SH" --version 2>&1 | head -1); sheet sha256: $(shasum -a 256 "$SHEET" | cut -d' ' -f1)"
getline() { grep -F -- "$1" "$SHEET"; }
L5=$(getline '( set -u; S=$(mktemp -d)'); L9=$(getline 'cd "$HOME/hone-s1" && [ "$(shasum'); L10=$(getline 'export WD_USER='); L11=$(getline 'if [ "$(shasum')
for v in L5 L9 L10 L11; do [ "$(printf '%s\n' "${!v}" | grep -c .)" = 1 ] && ok "$v found exactly once in the sheet" || bad "$v not found exactly once"; done
[ -z "$(printf '%s%s%s%s' "$L5" "$L9" "$L10" "$L11" | tr -d -c "'#<>")" ] && ok "the four lines hold no apostrophe, hash or angle bracket" || bad "forbidden character in a sheet line"
T=$(mktemp -d); mkdir -p "$T/bin" "$T/src"
cat > "$T/bin/scp" <<'FAKE'
#!/bin/sh
[ -n "${FAKE_SCP_FAIL-}" ] && { echo "scp: connection refused" >&2; exit 1; }
n=$#; i=0; dest=""
for a in "$@"; do i=$((i+1)); [ "$i" = "$n" ] && dest="$a"; done
echo "$@" >> "$FAKE_SCP_LOG"
for a in "$@"; do case "$a" in -q) ;; "$dest") ;; *:/*) cp "$FAKE_SCP_SRC/$(basename "$a")" "$dest" ;; esac; done
FAKE
chmod +x "$T/bin/scp"
cat > "$T/src/d3-watchdog.zsh" <<'STUB'
#!/bin/zsh
echo "STUB WATCHDOG RAN WD_USER=$WD_USER WD_HOSTPORT=$WD_HOSTPORT WD_SSLMODE=$WD_SSLMODE WD_MAX=$WD_MAX WD_PIN_WAIT=$WD_PIN_WAIT"
: > "$STUB_MARK"
exit ${STUB_EXIT:-0}
STUB
STUBSHA=$(shasum -a 256 "$T/src/d3-watchdog.zsh" | cut -d' ' -f1)
WRONG=$(printf '%s' "$STUBSHA" | sed 's/.$/0/'); [ "$WRONG" = "$STUBSHA" ] && WRONG=$(printf '%s' "$STUBSHA" | sed 's/.$/1/')
sw() { printf '%s' "$1" | sed "s/$REALSHA/$2/g"; }
session() { # session NAME HOMEOPTS(none|nocli) SRCDIR SHA EXTRAENV lines...   -> OUT, H
  local name="$1" mode="$2" src="$3" sha="$4"; shift 4
  H="$T/home-$name"; mkdir -p "$H/hone-s1"; [ "$mode" = nocli ] || mkdir -p "$H/hone-s1/supabase-cli"
  OUT="$T/out-$name.txt"; local lines=() l
  for l in "$@"; do lines+=("$(sw "$l" "$sha")"); done
  case "$name" in t-*) cp "$T/src/d3-watchdog.zsh" "$H/hone-s1/d3-watchdog.zsh" ;; esac
  env HOME="$H" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=dumb TMPDIR="$T" FAKE_SCP_SRC="$src" FAKE_SCP_LOG="$T/scp-$name.log" STUB_MARK="$T/mark-$name" ${SESSION_ENV:+"$SESSION_ENV"} \
    python3 -I "$HERE/drive-sheet.py" "$OUT" "$SH" -- "${lines[@]}"
}
out() { tr -d '\r' < "$OUT"; }
# ---- (1) the download line
session dl-good ok "$T/src" "$STUBSHA" "$L5"
out | grep -q "^d3-watchdog.zsh: sha256 OK, installed" && [ "$(shasum -a 256 "$H/hone-s1/d3-watchdog.zsh" | cut -d' ' -f1)" = "$STUBSHA" ] && ok "$SH download line, good: installed into ~/hone-s1 with the matching sha256" || bad "download good" "$(out | tail -5)"
grep -q "sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/general/d3-watchdog.zsh" "$T/scp-dl-good.log" && ok "$SH download line: scp was asked for the real host and path" || bad "scp args"
mkdir -p "$T/tamper"; { cat "$T/src/d3-watchdog.zsh"; echo "# tampered"; } > "$T/tamper/d3-watchdog.zsh"
session dl-tamper ok "$T/tamper" "$STUBSHA" "$L5"
out | grep -q "^STOP: download or sha256 check failed; nothing was installed" && [ ! -e "$H/hone-s1/d3-watchdog.zsh" ] && ok "$SH download line, tampered file: STOP, nothing installed" || bad "download tamper" "$(out | tail -5)"
SESSION_ENV=FAKE_SCP_FAIL=1 session dl-scpfail ok "$T/src" "$STUBSHA" "$L5"
out | grep -q "^STOP: download or sha256 check failed" && [ ! -e "$H/hone-s1/d3-watchdog.zsh" ] && ok "$SH download line, scp failure: STOP, nothing installed" || bad "download scp failure" "$(out | tail -5)"
session dl-nocli nocli "$T/src" "$STUBSHA" "$L5"
out | grep -q "^STOP: download or sha256 check failed" && [ ! -e "$H/hone-s1/d3-watchdog.zsh" ] && [ ! -d "$H/hone-s1/supabase-cli" ] && ok "$SH download line, no ~/hone-s1/supabase-cli: STOP, nothing installed (the directory is not created)" || bad "download no cli" "$(out | tail -5)"
# ---- (2) Terminal 2 lines 9-11 (the stub is already in ~/hone-s1)
session t-good ok "$T/src" "$STUBSHA" "$L9" "$L10" "$L11"
out | grep -q "^watchdog sha256 OK" && out | grep -q "^STUB WATCHDOG RAN WD_USER=postgres.alhhybgqdmcdyzpybykj WD_HOSTPORT=aws-1-us-east-1.pooler.supabase.com:5432 WD_SSLMODE=require WD_MAX=1800 WD_PIN_WAIT=600" && [ -e "$T/mark-t-good" ] && ! out | grep -q "mismatch" && ok "$SH Terminal 2, good sha: sha OK printed, the stub ran with the exported WD_ values, no STOP" || bad "terminal good" "$(out | tail -6)"
rm -f "$T/mark-t-bad"
session t-bad ok "$T/src" "$WRONG" "$L9" "$L10" "$L11"
[ "$(out | grep -c 'watchdog sha256 mismatch')" = 2 ] && out | grep -q "^STOP: watchdog sha256 mismatch$" && out | grep -q "^STOP: watchdog sha256 mismatch; do not start the push" && ! out | grep -q "STUB WATCHDOG RAN" && [ ! -e "$T/mark-t-bad" ] && ok "$SH Terminal 2, mismatched sha: both STOP lines printed and the stub did NOT run" || bad "terminal mismatch" "$(out | tail -6)"
SESSION_ENV=STUB_EXIT=1 session t-exit1 ok "$T/src" "$STUBSHA" "$L9" "$L10" "$L11"
out | grep -q "^STUB WATCHDOG RAN" && ! out | grep -q "mismatch" && ok "$SH Terminal 2, stub exits 1: it ran and NO sha-mismatch message was printed (the if form)" || bad "terminal exit1" "$(out | tail -6)"
echo "RESULT ($SH): $pass passed, $fail failed"; rm -rf "$T"; [ "$fail" = 0 ]
