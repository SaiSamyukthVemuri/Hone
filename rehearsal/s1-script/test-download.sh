#!/bin/bash
# Tests the one-line download command under the shell named in $1 (bash or zsh) with a FAKE scp that copies from a local directory.
# usage: test-download.sh <shell> <dir holding s1-apply.sh, migrations-d189768b.tar, MIGRATIONS-d189768b.sha256> <DOWNLOAD-COMMAND.txt>
SH="$1"; SRC="$2"; CMDF="$3"
LINE=$(grep -F '( set -u;' "$CMDF")
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
[ "$(printf '%s\n' "$LINE" | grep -c .)" = 1 ] && ok "exactly one command line" || bad "line count"
[ -z "$(printf '%s' "$LINE" | tr -d -c "'#<>")" ] && ok "no apostrophe, no hash, no angle bracket in the line" || bad "forbidden character"
printf '%s' "$LINE" | grep -q 'sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/team/s1-apply' && ok "real host, no placeholder" || bad "host"
T=$(mktemp -d)
mkdir -p "$T/bin"
cat > "$T/bin/scp" <<'FAKE'
#!/bin/sh
[ -n "${FAKE_SCP_FAIL-}" ] && { echo "scp: connection refused" >&2; exit 1; }
n=$#; i=0; dest=""
for a in "$@"; do i=$((i+1)); [ "$i" = "$n" ] && dest="$a"; done
echo "$@" >> "$FAKE_SCP_LOG"
for a in "$@"; do case "$a" in -q) ;; "$dest") ;; *:/*) cp "$FAKE_SCP_SRC/$(basename "$a")" "$dest" ;; esac; done
FAKE
chmod +x "$T/bin/scp"
run() { # run NAME  -> OUT, installed dir under $H
  H="$T/home-$1"; mkdir -p "$H"; [ "${2-}" = nohone ] || mkdir -p "$H/hone-s1"
  OUT=$(env -i HOME="$H" PATH="$T/bin:/usr/bin:/bin" TMPDIR="$T" FAKE_SCP_SRC="$FAKE_SRC" FAKE_SCP_LOG="$T/scp-$1.log" ${FAKE_SCP_FAIL:+FAKE_SCP_FAIL=1} "$SH" -c "$LINE" 2>&1)
}
nfiles() { ls "$H/hone-s1/s1-apply" 2>/dev/null | wc -l | tr -d ' '; }
FAKE_SRC="$SRC"; run good
[ "$(nfiles)" = 3 ] && printf '%s' "$OUT" | grep -q "sha256 OK, installed" && ok "$SH: good files: all three installed, OK printed" || bad "$SH good: $OUT"
[ -x "$H/hone-s1/s1-apply/s1-apply.sh" ] && [ "$(stat -c %a "$H/hone-s1/s1-apply/s1-apply.sh" 2>/dev/null || stat -f %Lp "$H/hone-s1/s1-apply/s1-apply.sh")" = 755 ] && ok "$SH: s1-apply.sh is mode 0755" || bad "$SH mode"
grep -q "sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/team/s1-apply/s1-apply.sh" "$T/scp-good.log" && ok "$SH: scp was called with the real host and the three remote paths" || bad "$SH scp args"
for f in s1-apply.sh migrations-d189768b.tar MIGRATIONS-d189768b.sha256; do
  rm -rf "$T/tamper"; mkdir "$T/tamper"; cp "$SRC"/* "$T/tamper/"; printf 'x' >> "$T/tamper/$f"; FAKE_SRC="$T/tamper"; run "t-$f"
  [ "$(nfiles)" = 0 ] && [ ! -d "$H/hone-s1/s1-apply" ] && printf '%s' "$OUT" | grep -q "^STOP: download or sha256 check failed; nothing was installed" && ok "$SH: $f altered: STOP, nothing installed (no s1-apply directory created)" || bad "$SH tamper $f: $OUT"
done
FAKE_SRC="$SRC"; FAKE_SCP_FAIL=1 run scpfail; unset FAKE_SCP_FAIL
[ ! -d "$H/hone-s1/s1-apply" ] && printf '%s' "$OUT" | grep -q "^STOP:" && ok "$SH: scp fails: STOP, nothing installed" || bad "$SH scp fail: $OUT"
FAKE_SRC="$SRC"; run nohone nohone
[ ! -d "$H/hone-s1" ] && printf '%s' "$OUT" | grep -q "^STOP:" && ok "$SH: ~/hone-s1 missing: STOP, nothing created" || bad "$SH no hone-s1: $OUT"
echo "RESULT ($SH): $pass passed, $fail failed"; rm -rf "$T"; [ "$fail" = 0 ]
