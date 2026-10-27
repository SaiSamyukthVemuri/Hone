#!/bin/bash
# hone-release installer. Run as ROOT, once, FROM A ROOT-OWNED COPY of the package. usage: install.sh <agent-user> <project-ref> <supabase-go> <pins-file>
#
# T1: nothing is installed unless EVERY file of the package matches a sha256 that root typed from the REVIEWED record into <pins-file>
# ("<64 hex>  <relative path>" per line). The pins file must be root-owned, not group/other-writable, outside the package directory, and must
# list exactly the files of the package (no extra file, none missing, no symlink, nothing group/other-writable). The manifest is built from the
# pinned values and the installed copies are re-hashed against them. Before running, check this file itself:  sha256sum install.sh
#
# It writes NO secret and NO approval: secrets come from set-secret.sh, approvals from approve-package.sh, both run by root.
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd -P)
AGENT=${1:?agent user}; REF=${2:?project ref}; GOBIN_SRC=${3:?supabase-go}; PINS=${4:?pins file}
die() { echo "REFUSED: $*; nothing was installed" >&2; exit 1; }
printf '%s' "$AGENT" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "bad agent user"
printf '%s' "$REF" | grep -Eq '^[a-z0-9]{20}$' || die "bad project ref"
id "$AGENT" >/dev/null 2>&1 || die "no such agent user"
# the package directory and pins file
[ -f "$PINS" ] && [ ! -L "$PINS" ] || die "the pins file is missing or a symlink"
PINS=$(realpath -e -- "$PINS")
case "$PINS" in "$HERE"/*) die "the pins file is inside the package directory" ;; esac
chain_ok() { local p="$1" m; while :; do [ ! -L "$p" ] && [ "$(stat -c %u "$p")" = 0 ] || return 1; m=$(stat -c %a "$p"); [ $(( 8#$m & 8#022 )) = 0 ] || return 1; [ "$p" != / ] || break; p=$(dirname "$p"); done; }
chain_ok "$PINS" || die "the pins file or a parent directory is not root-owned and private to root"
chain_ok "$HERE" || die "the package directory or a parent is not root-owned and private to root (copy the package to a root-owned directory first)"
[ -z "$(find "$HERE" -type l | head -1)" ] || die "the package contains a symlink"
[ -z "$(find "$HERE" ! -user root | head -1)" ] || die "the package contains a file not owned by root"
[ -z "$(find "$HERE" -perm /022 ! -type l | head -1)" ] || die "the package contains a group- or other-writable file or directory"
grep -Eqv '^[0-9a-f]{64}  [A-Za-z0-9._/-]+$' "$PINS" && die "the pins file has a malformed line"
awk '{print $2}' "$PINS" | sort | uniq -d | head -1 | grep -q . && die "the pins file lists a path twice"
TMPD=$(mktemp -d /root/.hr-install.XXXXXX 2>/dev/null || mktemp -d) ; chmod 700 "$TMPD"
(cd "$HERE" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$TMPD/actual" || die "cannot list the package"
awk '{print $2}' "$PINS" | LC_ALL=C sort > "$TMPD/pinned"
extra=$(LC_ALL=C comm -23 "$TMPD/actual" "$TMPD/pinned" | head -3 | tr '\n' ' '); missing=$(LC_ALL=C comm -13 "$TMPD/actual" "$TMPD/pinned" | head -3 | tr '\n' ' ')
rm -rf "$TMPD"
[ -z "$extra" ] || die "files in the package that the pins do not list: $extra"
[ -z "$missing" ] || die "files the pins list that are not in the package: $missing"
while read -r want name; do
  [ "$(sha256sum "$HERE/$name" | cut -d' ' -f1)" = "$want" ] || die "$name does not match its pinned sha256 (the package was changed after review)"
done < "$PINS"
pin_of() { awk -v n="$1" '$2 == n {print $1}' "$PINS"; }
for need in launcher install.sh set-secret.sh approve-package.sh actions.conf sudoers.hone-release scripts/release-apply.sh scripts/read-backups.sh scripts/status.sh; do [ -n "$(pin_of "$need")" ] || die "the pins file lacks $need"; done
[ "$(sha256sum "$0" | cut -d' ' -f1)" = "$(pin_of install.sh)" ] || die "this installer is not the pinned install.sh"
GO_SHA=$(sed -n 's/^GO_SHA=//p' "$HERE/scripts/release-apply.sh" | head -1)
[ "$(sha256sum "$GOBIN_SRC" | cut -d' ' -f1)" = "$GO_SHA" ] || die "supabase-go sha256 differs from the scripts' pin $GO_SHA"

id hone-release >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hone-release/home --no-create-home --shell /usr/sbin/nologin --user-group hone-release
passwd -l hone-release >/dev/null 2>&1 || true
install -d -m 700 -o hone-release -g hone-release /var/lib/hone-release /var/lib/hone-release/secrets /var/lib/hone-release/state /var/lib/hone-release/work /var/lib/hone-release/logs /var/lib/hone-release/home
install -d -m 755 -o root -g root /usr/local/libexec/hone-release /usr/local/libexec/hone-release/scripts /usr/local/libexec/hone-release/bin /etc/hone-release
install -m 755 -o root -g root "$HERE/launcher" /usr/local/libexec/hone-release/launcher
install -m 755 -o root -g root "$GOBIN_SRC" /usr/local/libexec/hone-release/bin/supabase-go
: > /usr/local/libexec/hone-release/manifest.new
grep -Ev '^[[:space:]]*(#|$)' "$HERE/actions.conf" | while read -r action file secret; do
  install -m 755 -o root -g root "$HERE/scripts/$file" "/usr/local/libexec/hone-release/scripts/$file"
  want=$(pin_of "scripts/$file")
  [ "$(sha256sum "/usr/local/libexec/hone-release/scripts/$file" | cut -d' ' -f1)" = "$want" ] || { echo "REFUSED: installed $file differs from its pin" >&2; exit 1; }
  printf '%s %s %s %s\n' "$action" "$want" "/usr/local/libexec/hone-release/scripts/$file" "$secret" >> /usr/local/libexec/hone-release/manifest.new
done
[ "$(sha256sum /usr/local/libexec/hone-release/launcher | cut -d' ' -f1)" = "$(pin_of launcher)" ] || { echo "REFUSED: installed launcher differs from its pin" >&2; exit 1; }
chown root:root /usr/local/libexec/hone-release/manifest.new; chmod 644 /usr/local/libexec/hone-release/manifest.new
mv -f /usr/local/libexec/hone-release/manifest.new /usr/local/libexec/hone-release/manifest
printf '%s\n' "$REF" > /etc/hone-release/PROJECT-REF.new; chown root:root /etc/hone-release/PROJECT-REF.new; chmod 644 /etc/hone-release/PROJECT-REF.new; mv -f /etc/hone-release/PROJECT-REF.new /etc/hone-release/PROJECT-REF
install -d -m 755 -o "$AGENT" -g "$AGENT" /srv/hone-release-inbox
tmp=$(mktemp /etc/sudoers.d/.hone-release.XXXXXX); sed "s/@AGENT@/$AGENT/g" "$HERE/sudoers.hone-release" > "$tmp"; chown root:root "$tmp"; chmod 440 "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; echo "sudoers file did not validate; nothing further installed" >&2; exit 1; }
mv -f "$tmp" /etc/sudoers.d/hone-release
visudo -c >/dev/null 2>&1 || echo "note: visudo -c reports a problem elsewhere in the sudoers configuration (not in /etc/sudoers.d/hone-release, which validated)" >&2
echo "installed from pinned files. manifest:"; cat /usr/local/libexec/hone-release/manifest
echo "launcher sha256 $(sha256sum /usr/local/libexec/hone-release/launcher | cut -d' ' -f1)"
echo "next (root): set-secret.sh db-password ; set-secret.sh read-pat  ; approve-package.sh ..."
