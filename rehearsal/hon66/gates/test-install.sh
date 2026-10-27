#!/bin/bash
# REHEARSAL - NEVER MERGE. HON66: tests install-linux-gates.sh against the assembled stage (real files), with a throw-away HOME.
# Optional: INSTALL_ARCHIVE=<real supabase_2.102.0_linux_amd64.tar.gz> additionally proves the pinned-binary extraction.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; STAGE0="$HERE/stage"; INST="$HERE/install-linux-gates.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/inst.XXXXXX")"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
MS=$(sha256sum "$STAGE0/LINUX-MANIFEST.sha256" | cut -d' ' -f1)
fresh() { rm -rf "$T/home" "$T/stage"; mkdir -p "$T/home"; cp -r "$STAGE0" "$T/stage"; }
inst() { RC=0; HOME="$T/home" bash "$INST" "$@" > "$T/out.txt" 2>&1 || RC=$?; }
refused() { if [ "$RC" != 0 ] && grep -q "install: STOP: $1" "$T/out.txt" && [ ! -e "$T/home/hone-s1/window-reads-c4" ]; then ok "$2 (nothing installed)"; else bad "$2" "rc=$RC $(cat "$T/out.txt")"; fi; }
bash -n "$INST" && ok "bash -n" || bad syntax
fresh; inst "$T/stage" "$MS"
[ "$RC" = 0 ] && grep -q "install: OK" "$T/out.txt" && ok "happy: installed under \$HOME/hone-s1" || bad "happy" "$(cat "$T/out.txt")"
R="$T/home/hone-s1"
[ "$(stat -c %a "$R")" = 700 ] && [ -x "$R/bin/hone-push-linux.sh" ] && [ -x "$R/window-reads-c4/run-window-read.sh" ] && [ -f "$R/gap-read-2/MANIFEST.sha256" ] && [ -f "$R/window-reads-s1/MANIFEST.sha256" ] && ok "layout and modes: root 700, scripts executable, gap-read-2 and window-reads-s1 manifests present" || bad "layout"
( cd "$R" && sha256sum -c --quiet "$T/stage/LINUX-MANIFEST.sha256" >/dev/null 2>&1 ) || ( cd "$T/stage" && while read -r s f; do [ "$(sha256sum "$R/$f" | cut -d' ' -f1)" = "$s" ] || exit 1; done < LINUX-MANIFEST.sha256 ) && ok "every installed file equals its manifest sha" || bad "installed files differ"
inst "$T/stage" "$MS"; [ "$RC" = 0 ] && ok "re-running on an identical install is idempotent" || bad "idempotent" "$(cat "$T/out.txt")"
fresh; inst "$T/stage" "$(printf '0%.0s' $(seq 64))"; refused "the manifest sha256 differs" "a wrong manifest sha is refused"
fresh; inst "$T/stage" "zz"; refused "the manifest sha256 must be 64 hex" "a malformed manifest sha is refused"
fresh; echo x >> "$T/stage/bin/hone-push-linux.sh"; inst "$T/stage" "$MS"; refused "a staged file fails the manifest" "a tampered staged file is refused"
fresh; echo x > "$T/stage/bin/extra.sh"; inst "$T/stage" "$MS"; refused "the stage holds a file the manifest does not list" "an unlisted extra file is refused"
fresh; ln -s /etc/passwd "$T/stage/bin/link"; inst "$T/stage" "$MS"; refused "the stage holds a symlink" "a symlink in the stage is refused"
fresh; mkdir -p "$T/home/hone-s1/bin"; echo different > "$T/home/hone-s1/bin/hone-push-linux.sh"; inst "$T/stage" "$MS"; refused ".*exists and differs" "an existing DIFFERENT file at a target is refused"
fresh; mkdir -p "$T/real"; ln -s "$T/real" "$T/home/hone-s1"; inst "$T/stage" "$MS"; if [ "$RC" != 0 ] && grep -q "is a symlink" "$T/out.txt"; then ok "a symlinked \$HOME/hone-s1 is refused"; else bad "symlinked root" "$(cat "$T/out.txt")"; fi
fresh; mkdir -p "$T/arch"; printf 'not a real binary' > "$T/arch/supabase"; tar -czf "$T/arch/fake.tar.gz" -C "$T/arch" supabase; inst "$T/stage" "$MS" --archive "$T/arch/fake.tar.gz"; refused "the extracted supabase binary is not the pinned" "a fake binary in the archive is refused"
fresh; tar -czf "$T/arch/extra.tar.gz" -C "$T/arch" supabase fake.tar.gz; inst "$T/stage" "$MS" --archive "$T/arch/extra.tar.gz"; refused "the archive holds unexpected members" "an archive with an unexpected member is refused"
if [ -n "${INSTALL_ARCHIVE:-}" ]; then
  fresh; inst "$T/stage" "$MS" --archive "$INSTALL_ARCHIVE"
  [ "$RC" = 0 ] && [ "$(sha256sum "$T/home/hone-s1/supabase-cli/supabase-go" | cut -d' ' -f1)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] && [ -x "$T/home/hone-s1/supabase-cli/supabase-go" ] && ok "the real release archive: the pinned linux_amd64 binary is extracted, verified and installed" || bad "real archive" "$(cat "$T/out.txt")"
else echo "skip - INSTALL_ARCHIVE not set (the real-archive case runs in CI)"; fi
echo; echo "passed: $pass failed: $fail"
[ "$fail" = 0 ]
