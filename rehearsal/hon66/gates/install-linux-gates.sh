#!/bin/bash
# HON66 installer for the Linux gate scripts (Linux x86_64). It verifies BEFORE it installs anything:
#   - the staged manifest has the sha256 you passed (typed from the reviewed END file / download line, not from the stage itself)
#   - every file in the manifest verifies, and the stage holds no file the manifest does not list
#   - optional --archive: a supabase CLI 2.102.0 linux_amd64 release tarball; its single member `supabase` must have the pinned sha256
# It installs into $HOME/hone-s1 (mode 700), refuses to overwrite a DIFFERENT existing file (move it away first), never edits a
# credential file, never runs a gate, never touches a database or the network.
#   install-linux-gates.sh STAGE-DIR MANIFEST-SHA256 [--archive supabase_2.102.0_linux_amd64.tar.gz]
set -u
GOSHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
die() { echo "install: STOP: $*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "not Linux x86_64"
[ $# -ge 2 ] || die "usage: install-linux-gates.sh STAGE-DIR MANIFEST-SHA256 [--archive TARBALL]"
STAGE=$1; MSHA=$2; shift 2; ARCH=""
if [ $# -gt 0 ]; then [ "$1" = --archive ] && [ $# -eq 2 ] || die "only --archive TARBALL may follow"; ARCH=$2; fi
case "$MSHA" in *[!0-9a-f]*|'') die "the manifest sha256 must be 64 hex digits" ;; esac
[ "${#MSHA}" = 64 ] || die "the manifest sha256 must be 64 hex digits"
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] && [ -f "$STAGE/LINUX-MANIFEST.sha256" ] || die "STAGE-DIR (a real directory with LINUX-MANIFEST.sha256) is required"
[ "$(sha256sum -- "$STAGE/LINUX-MANIFEST.sha256" | cut -d' ' -f1)" = "$MSHA" ] || die "the manifest sha256 differs from the one you passed: nothing installed"
( cd "$STAGE" && sha256sum -c --quiet LINUX-MANIFEST.sha256 ) > /dev/null 2>&1 || die "a staged file fails the manifest: nothing installed"
listed=$(cd "$STAGE" && awk '{print $2}' LINUX-MANIFEST.sha256 | sed 's#^\./##' | sort)
actual=$(cd "$STAGE" && find . -type f ! -name LINUX-MANIFEST.sha256 | sed 's#^\./##' | sort)
[ "$listed" = "$actual" ] || die "the stage holds a file the manifest does not list (or the reverse): nothing installed"
[ -z "$(cd "$STAGE" && find . -type l)" ] || die "the stage holds a symlink: nothing installed"
ROOT="$HOME/hone-s1"
[ ! -L "$ROOT" ] || die "$ROOT is a symlink"
# existing, DIFFERENT file at a target? refuse before copying anything
while IFS= read -r f; do
  [ -e "$ROOT/$f" ] || continue
  cmp -s "$STAGE/$f" "$ROOT/$f" || die "$ROOT/$f exists and differs: move it away first (nothing installed)"
done <<< "$actual"
BIN=""
if [ -n "$ARCH" ]; then
  [ -f "$ARCH" ] && [ ! -L "$ARCH" ] || die "the archive is missing or a symlink"
  [ "$(tar -tzf "$ARCH" 2>/dev/null | grep -vx 'supabase' | grep -vx 'supabase-go' | grep -vx 'LICENSE' | grep -vx 'README.md' | wc -l)" = 0 ] || die "the archive holds unexpected members"
  TMP=$(mktemp -d) || die "mktemp failed"; trap 'rm -rf "$TMP"' EXIT
  M=$(tar -tzf "$ARCH" | grep -xE 'supabase-go|supabase' | head -1); [ -n "$M" ] || die "the archive has no supabase member"
  tar -xzf "$ARCH" -C "$TMP" "$M" 2> /dev/null || die "the archive has no supabase member"
  [ "$(sha256sum -- "$TMP/$M" | cut -d' ' -f1)" = "$GOSHA" ] || die "the extracted supabase binary is not the pinned linux_amd64 2.102.0 build (sha256 mismatch): nothing installed"
  BIN="$TMP/$M"
  if [ -e "$ROOT/supabase-cli/supabase-go" ]; then [ "$(sha256sum -- "$ROOT/supabase-cli/supabase-go" | cut -d' ' -f1)" = "$GOSHA" ] || die "$ROOT/supabase-cli/supabase-go exists and is not the pinned build: move it away first"; fi
fi
mkdir -p "$ROOT" && chmod 700 "$ROOT" || die "cannot create $ROOT"
n=0
while IFS= read -r f; do
  d="$ROOT/$(dirname "$f")"; mkdir -p "$d" && chmod 700 "$d"
  case "$f" in *.sh|*.mjs|*.py) m=755 ;; *) m=644 ;; esac
  [ -e "$ROOT/$f" ] || { install -m "$m" "$STAGE/$f" "$ROOT/$f" || die "could not install $f"; }
  n=$((n + 1))
done <<< "$actual"
if [ -n "$BIN" ]; then mkdir -p "$ROOT/supabase-cli" && chmod 700 "$ROOT/supabase-cli"; [ -e "$ROOT/supabase-cli/supabase-go" ] || install -m 755 "$BIN" "$ROOT/supabase-cli/supabase-go" || die "could not install supabase-go"; fi
echo "install: OK: $n files verified against manifest $MSHA and installed under $ROOT${BIN:+; supabase-go verified ($GOSHA)}"
