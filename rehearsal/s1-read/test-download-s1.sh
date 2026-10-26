#!/bin/bash
# REHEARSAL - NEVER MERGE. Tests the one-line download in WINDOW-S1READ-MACOS.md under the shell named in $1 (bash or zsh),
# with a FAKE scp on PATH that copies from a local directory (STUBBED: the network and the VPS). The line itself is extracted
# from the document, so what is tested is exactly what Sam pastes.
set -u
SH="${1:-bash}"
HERE="$(cd "$(dirname "$0")" && pwd)"
S1D="$HERE/window-reads-s1"
T="$(mktemp -d "${TMPDIR:-/tmp}/dls1.XXXXXX")"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
LINE=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$S1D/WINDOW-S1READ-MACOS.md" | sed 's/^    //')
[ "$(printf '%s\n' "$LINE" | grep -c '')" = 1 ] && [ -n "$LINE" ] && ok "[$SH] the document holds exactly one download line" || bad "[$SH] download line not found or not one line"
printf '%s' "$LINE" | grep -Eq '(^| )#( |$)' && bad "[$SH] the line contains a comment" || ok "[$SH] the line contains no comment (X1 class)"
printf '%s' "$LINE" | grep -qE 'alhhybg|PASSWORD|TOKEN' && bad "[$SH] the line names a ref or a secret" || ok "[$SH] the line holds no project ref and no secret (X4 class)"
FILES="window-s1read.sh run-window-read-macos.sh MANIFEST.sha256 s1-history.sql census-0213-0246.sql s1-g10.sql s1-closures.sql s1-table-privileges.sql s1-body-md5.sql"
for f in $FILES; do grep -q "$f:$(shasum -a 256 "$S1D/$f" | cut -d' ' -f1)" "$S1D/WINDOW-S1READ-MACOS.md" && printf '%s' "$LINE" | grep -q "$f:$(shasum -a 256 "$S1D/$f" | cut -d' ' -f1)" || bad "[$SH] the line does not pin the current $f"; done; ok "[$SH] the line pins the sha256 of all nine current files"
SRC="$T/src"; mkdir -p "$SRC" "$T/bin"
for f in $FILES; do cp "$S1D/$f" "$SRC/"; done
cat > "$T/bin/scp" <<'FAKE'
#!/bin/sh
[ -n "${FAKE_SCP_FAIL-}" ] && { echo "scp: simulated failure" >&2; exit 1; }
n=$#; i=0; dest=""
for a in "$@"; do i=$((i+1)); [ "$i" = "$n" ] && dest="$a"; done
i=0
for a in "$@"; do i=$((i+1)); [ "$i" -lt "$n" ] || continue
  case "$a" in sam@100.123.145.56:*) cp "$FAKE_SRC/$(basename "${a#*:}")" "$dest" || exit 1 ;; esac
done
FAKE
chmod +x "$T/bin/scp"
run() { RC=0; OUT=$(env -i PATH="$T/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$H" FAKE_SRC="$FAKE" ${FAKE_SCP_FAIL:+FAKE_SCP_FAIL=1} TMPDIR="$T" "$SH" -c "$LINE" 2>&1) || RC=$?; }
inst() { ls "$H/hone-s1/window-reads-s1" 2>/dev/null | wc -l | tr -d ' '; }
H="$T/h1"; FAKE="$SRC"; mkdir -p "$H/hone-s1"; run
case "$OUT" in *"sha256 OK, installed"*) ok "[$SH] a clean download installs and says so" ;; *) bad "[$SH] clean download: $OUT" ;; esac
[ "$(inst)" = 9 ] && ok "[$SH] exactly the nine pinned files were installed" || bad "[$SH] installed $(inst) files"
cmp -s "$SRC/window-s1read.sh" "$H/hone-s1/window-reads-s1/window-s1read.sh" && [ -x "$H/hone-s1/window-reads-s1/window-s1read.sh" ] && [ -x "$H/hone-s1/window-reads-s1/run-window-read-macos.sh" ] && ok "[$SH] the script and the runner are byte-identical and executable" || bad "[$SH] script not installed intact"
[ ! -e "$H/hone-s1/window-reads" ] && ok "[$SH] nothing was written to ~/hone-s1/window-reads (the comparator files stay where S0a put them)" || bad "[$SH] wrote into window-reads"
for victim in s1-closures.sql MANIFEST.sha256 window-s1read.sh run-window-read-macos.sh; do
  H="$T/hv-$victim"; FAKE="$T/srcv-$victim"; mkdir -p "$FAKE" "$H/hone-s1"; cp "$SRC"/* "$FAKE/"; printf 'x' >> "$FAKE/$victim"; run
  case "$OUT" in *"STOP: sha256 mismatch for $victim"*"run nothing"*) ok "[$SH] a tampered $victim is refused by name" ;; *) bad "[$SH] tampered $victim: $OUT" ;; esac
  [ "$(inst)" = 0 ] && ok "[$SH] ... and nothing was installed (stage, verify, then install)" || bad "[$SH] a file was installed despite the mismatch ($victim)"
done
H="$T/h4"; FAKE="$SRC"; mkdir -p "$H"; run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a missing ~/hone-s1 is refused" ;; *) bad "[$SH] missing dir: $OUT" ;; esac
[ ! -e "$H/hone-s1" ] && ok "[$SH] ... and ~/hone-s1 was not created" || bad "[$SH] created ~/hone-s1"
H="$T/h5"; FAKE="$SRC"; mkdir -p "$H/hone-s1"; FAKE_SCP_FAIL=1 run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a failed scp prints STOP" ;; *) bad "[$SH] scp failure: $OUT" ;; esac
[ "$(inst)" = 0 ] && ok "[$SH] ... nothing installed" || bad "[$SH] installed after scp failure"
H="$T/h6"; FAKE="$T/src6"; mkdir -p "$FAKE" "$H/hone-s1"; cp "$SRC"/* "$FAKE/"; rm "$FAKE/s1-history.sql"; run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a missing file on the source side is refused" ;; *) bad "[$SH] missing file: $OUT" ;; esac
[ "$(inst)" = 0 ] && ok "[$SH] ... nothing installed" || bad "[$SH] installed with a missing file"
echo "[$SH] passed: $pass failed: $fail"
[ "$fail" = 0 ] || exit 1
