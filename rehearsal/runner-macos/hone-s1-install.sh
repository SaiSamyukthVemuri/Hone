#!/bin/sh
# Fetch and verify supabase CLI v2.102.0 for macOS arm64 into ~/hone-s1/supabase-cli.
# Every download, checksum or archive-shape failure stops BEFORE extraction;
# every extracted-file failure stops BEFORE execution. The only execution is the
# final `--version`. No credentials are read or needed.
set -eu

VER=2.102.0
ARCHIVE=supabase_${VER}_darwin_arm64.tar.gz
BASE=https://github.com/supabase/cli/releases/download/v${VER}
SHA_CHECKSUMS=d8b65682838583ffc3c08d083b088c9b16ec314d5ee4e82ad02fda8f4ed3345e
SHA_ARCHIVE=567f0ce9f050ceb46ad4389ab13035e31b5b7205fcb093530f528bb208d2ce28
SHA_SUPABASE=957fc4db2abdd5db3364e8551ebb8c93feadd616130c130fc98dfa50baf98add
SHA_SUPABASE_GO=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
DEST=${HOME}/hone-s1/supabase-cli

die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
check() { # check <file> <expected> <label>
  got=$(sha "$1") || die "cannot hash $3"
  [ "$got" = "$2" ] || die "$3 sha256 mismatch (got $got)"
}

[ "$(uname -s)" = Darwin ] || die "not macOS"
[ "$(uname -m)" = arm64 ] || die "not arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
[ ! -e "$DEST" ] || die "$DEST already exists; move it aside first"

work=$(mktemp -d "${TMPDIR:-/tmp}/hone-s1.XXXXXX") || die "mktemp failed"
cd "$work"

# 1. Download. -f makes an HTTP error fatal; no partial file is used.
curl -fsSL --proto '=https' --tlsv1.2 -o "$ARCHIVE" "$BASE/$ARCHIVE" || die "archive download failed"
curl -fsSL --proto '=https' --tlsv1.2 -o checksums.txt "$BASE/checksums.txt" || die "checksums.txt download failed"

# 2. Verify, all before extraction.
check checksums.txt "$SHA_CHECKSUMS" "checksums.txt"
listed=$(grep " ${ARCHIVE}\$" checksums.txt | cut -d' ' -f1) || die "archive not listed in checksums.txt"
[ "$listed" = "$SHA_ARCHIVE" ] || die "checksums.txt does not list the recorded archive sha256"
check "$ARCHIVE" "$SHA_ARCHIVE" "archive"
members=$(tar -tzf "$ARCHIVE" | LC_ALL=C sort | tr '\n' ' ') || die "cannot list archive"
[ "$members" = "supabase supabase-go " ] || die "unexpected archive members: $members"

# 3. Extract into the work dir, verify both files, all before execution.
mkdir x
tar -xzf "$ARCHIVE" -C x || die "extraction failed"
check x/supabase "$SHA_SUPABASE" "supabase binary"
check x/supabase-go "$SHA_SUPABASE_GO" "supabase-go binary"

# 4. Install the verified pair, re-verify in place.
mkdir -p "$DEST"
mv x/supabase x/supabase-go "$DEST/"
check "$DEST/supabase" "$SHA_SUPABASE" "installed supabase"
check "$DEST/supabase-go" "$SHA_SUPABASE_GO" "installed supabase-go"
if command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$DEST/supabase" >/dev/null 2>&1; then
  die "quarantine flag present; not overriding Gatekeeper"
fi

# 5. First and only execution: no telemetry, no update check token.
unset GITHUB_TOKEN GH_TOKEN
v=$(SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$DEST/supabase" --version) || die "supabase --version failed"
[ "$v" = "$VER" ] || die "version is '$v', expected $VER"
rm -rf "$work"
echo "OK: $DEST/supabase $VER (archive $SHA_ARCHIVE)"
