#!/bin/bash
# INSTALLER-V2-SIGNATURE (1) and (5): signature evidence on the binaries EXACTLY AS EXTRACTED (nothing re-signed,
# nothing unquarantined), plus the npm darwin-arm64 package's copies for comparison. Read-only; no hosted call.
set -u
W="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sig.XXXXXX")"; cd "$W"
ARCH=supabase_2.102.0_darwin_arm64.tar.gz
curl -fsSL --proto '=https' --tlsv1.2 -o "$ARCH" "https://github.com/supabase/cli/releases/download/v2.102.0/$ARCH" || { echo "download failed"; exit 1; }
echo "archive sha256: $(shasum -a 256 "$ARCH" | cut -d' ' -f1)"
[ "$(shasum -a 256 "$ARCH" | cut -d' ' -f1)" = 567f0ce9f050ceb46ad4389ab13035e31b5b7205fcb093530f528bb208d2ce28 ] || { echo "archive sha differs"; exit 1; }
mkdir gh; tar -xzf "$ARCH" -C gh
report() { # report <dir> <name>
  f="$1/$2"; echo; echo "================ $2 ($1)"
  echo "sha256: $(shasum -a 256 "$f" | cut -d' ' -f1)"
  echo "xattr -l: [$(xattr -l "$f")]"
  echo "--- codesign -dv --verbose=4"; codesign -dv --verbose=4 "$f" 2>&1; echo "(exit $?)"
  echo "--- codesign --verify --verbose=2"; codesign --verify --verbose=2 "$f" 2>&1; echo "(exit $?)"
  echo "--- codesign --verify --strict --verbose=2"; codesign --verify --strict --verbose=2 "$f" 2>&1; echo "(exit $?)"
  echo "--- spctl --assess --type execute -vv"; spctl --assess --type execute -vv "$f" 2>&1; echo "(exit $?)"
}
report gh supabase
report gh supabase-go
echo; echo "================ Gatekeeper with a NON-quarantined CLI binary: plain execution"
echo "supabase-go --version: [$(gh/supabase-go --version 2>&1)] (exit $?)"
echo "supabase (Bun wrapper) --version: [$(gh/supabase --version 2>&1)] (exit $?)  [informational]"
echo; echo "================ npm @supabase/cli-darwin-arm64@2.102.0 (vendor distribution; compare bytes)"
curl -fsSL --proto '=https' --tlsv1.2 -o npm.tgz "https://registry.npmjs.org/@supabase/cli-darwin-arm64/-/cli-darwin-arm64-2.102.0.tgz" || { echo "npm download failed"; exit 1; }
echo "npm tarball sha1: $(shasum -a 1 npm.tgz | cut -d' ' -f1)  (registry says 3a7f493739dfb20ffe544e332e89a414bc660fd2)"
mkdir npm; tar -xzf npm.tgz -C npm
for n in supabase supabase-go; do
  a="$(shasum -a 256 gh/$n | cut -d' ' -f1)"; b="$(shasum -a 256 npm/package/bin/$n | cut -d' ' -f1)"
  [ "$a" = "$b" ] && echo "$n: npm copy is byte-identical to the GitHub release ($a)" || echo "$n: DIFFERENT github=$a npm=$b"
done
echo "--- codesign --verify on the npm copy of supabase"; codesign --verify --verbose=2 npm/package/bin/supabase 2>&1; echo "(exit $?)"
echo "--- any Developer ID / notarization on either release binary?"
for f in gh/supabase gh/supabase-go; do echo "$f: $(codesign -dv --verbose=4 "$f" 2>&1 | grep -E 'Authority|TeamIdentifier|Timestamp|Notarization|flags=' | tr '\n' ';')"; done
echo "--- stapler (notarization ticket) on a bare Mach-O: expected N/A"; xcrun stapler validate gh/supabase-go 2>&1 | head -3; true
