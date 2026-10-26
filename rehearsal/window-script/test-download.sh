#!/bin/bash
# REHEARSAL - NEVER MERGE. Tests the one-line download in WINDOW-COMMAND-MACOS.md under the shell named in $1 (bash or zsh),
# with a FAKE scp on PATH that copies from a local directory (STUBBED: the network and the VPS). The line itself is extracted
# from the document, so what is tested is exactly what Sam pastes.
set -u
SH="${1:-bash}"
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/dl.XXXXXX")"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
LINE=$(grep -E '^    \( set -u; S=\$\(mktemp -d\)' "$HERE/WINDOW-COMMAND-MACOS.md" | sed 's/^    //')
[ "$(printf '%s\n' "$LINE" | grep -c '')" = 1 ] && [ -n "$LINE" ] && ok "[$SH] the document holds exactly one download line" || bad "[$SH] download line not found or not one line"
case "$LINE" in *"
"*) bad "[$SH] the line spans several lines" ;; *) ok "[$SH] the line is a single line" ;; esac
printf '%s' "$LINE" | grep -Eq '(^| )#( |$)' && bad "[$SH] the line contains a comment" || ok "[$SH] the line contains no comment (X1 class)"
printf '%s' "$LINE" | grep -qE 'alhhybg|PASSWORD|TOKEN' && bad "[$SH] the line names a ref or a secret" || ok "[$SH] the line holds no project ref and no secret (X4 class)"

SRC="$T/src"; mkdir -p "$SRC" "$T/bin"
W="$HERE/window-reads"
for f in BASELINE-W1-MACOS-CANDIDATE-3.json G3-CHECKSUMS-d189768b.txt compare-preflight.mjs compare-preflight-lib.mjs; do cp "$W/$f" "$SRC/"; done
cp "$HERE/window-s0a.sh" "$HERE/window-row4.sh" "$SRC/"
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
run() { # run NAME  (HOME and FAKE_SRC prepared) -> OUT, RC
  RC=0; OUT=$(env -i PATH="$T/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$H" FAKE_SRC="$FAKE" ${FAKE_SCP_FAIL:+FAKE_SCP_FAIL=1} TMPDIR="$T" "$SH" -c "$LINE" 2>&1) || RC=$?
}
H="$T/h1"; FAKE="$SRC"; mkdir -p "$H/hone-s1/window-reads"; run
case "$OUT" in *"sha256 OK, installed"*) ok "[$SH] a clean download installs and says so" ;; *) bad "[$SH] clean download: $OUT" ;; esac
n=$(ls "$H/hone-s1/window-reads" | wc -l | tr -d ' ')
[ "$n" = 6 ] && ok "[$SH] exactly the six pinned files were installed" || bad "[$SH] installed $n files"
cmp -s "$SRC/window-s0a.sh" "$H/hone-s1/window-reads/window-s0a.sh" && [ -x "$H/hone-s1/window-reads/window-s0a.sh" ] && [ -x "$H/hone-s1/window-reads/window-row4.sh" ] && ok "[$SH] the two scripts are installed byte-exact and executable" || bad "[$SH] script install"
H="$T/h2"; FAKE="$T/src2"; mkdir -p "$FAKE" "$H/hone-s1/window-reads"; cp "$SRC"/* "$FAKE/"; printf 'x' >> "$FAKE/G3-CHECKSUMS-d189768b.txt"; run
case "$OUT" in *"STOP: sha256 mismatch for G3-CHECKSUMS-d189768b.txt"*"run nothing"*) ok "[$SH] a tampered G3 file is refused by name" ;; *) bad "[$SH] tampered G3: $OUT" ;; esac
[ "$(ls "$H/hone-s1/window-reads" | wc -l | tr -d ' ')" = 0 ] && ok "[$SH] ... and nothing was installed (stage, verify, then install)" || bad "[$SH] a file was installed despite the mismatch"
H="$T/h3"; FAKE="$T/src3"; mkdir -p "$FAKE" "$H/hone-s1/window-reads"; cp "$SRC"/* "$FAKE/"; printf '\n' >> "$FAKE/compare-preflight-lib.mjs"; run
case "$OUT" in *"STOP: sha256 mismatch for compare-preflight-lib.mjs"*) ok "[$SH] a tampered comparator lib is refused" ;; *) bad "[$SH] tampered lib: $OUT" ;; esac
[ "$(ls "$H/hone-s1/window-reads" | wc -l | tr -d ' ')" = 0 ] && ok "[$SH] ... nothing installed" || bad "[$SH] installed despite lib mismatch"
H="$T/h4"; FAKE="$SRC"; mkdir -p "$H/hone-s1"; run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a missing ~/hone-s1/window-reads is refused" ;; *) bad "[$SH] missing dir: $OUT" ;; esac
H="$T/h5"; FAKE="$SRC"; mkdir -p "$H/hone-s1/window-reads"; FAKE_SCP_FAIL=1 run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a failed scp prints STOP" ;; *) bad "[$SH] scp failure: $OUT" ;; esac
[ "$(ls "$H/hone-s1/window-reads" | wc -l | tr -d ' ')" = 0 ] && ok "[$SH] ... nothing installed" || bad "[$SH] installed after scp failure"
H="$T/h6"; FAKE="$T/src6"; mkdir -p "$FAKE" "$H/hone-s1/window-reads"; cp "$SRC"/* "$FAKE/"; rm "$FAKE/window-row4.sh"; run
case "$OUT" in *"STOP:"*"run nothing"*) ok "[$SH] a missing file on the source side is refused" ;; *) bad "[$SH] missing file: $OUT" ;; esac
echo "[$SH] passed: $pass failed: $fail"
[ "$fail" = 0 ] || exit 1
