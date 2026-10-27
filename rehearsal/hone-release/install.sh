#!/bin/bash
# hone-release installer. Run as ROOT, once. usage: install.sh <agent-user> <project-ref> <supabase-go-binary>
# Creates the system user, the directories and modes, installs the launcher, the scripts (pinned in a root-owned manifest by sha256),
# the verified supabase-go, and the exact sudoers line (validated with visudo before it is put in place). It writes NO secret and NO
# approval: secrets come from set-secret.sh, approvals from approve-package.sh, both run by root.
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
AGENT=$1; REF=$2; GOBIN_SRC=$3
printf '%s' "$AGENT" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || { echo "bad agent user" >&2; exit 1; }
printf '%s' "$REF" | grep -Eq '^[a-z0-9]{20}$' || { echo "bad project ref" >&2; exit 1; }
id "$AGENT" >/dev/null
GO_SHA=$(sed -n 's/^GO_SHA=//p' "$HERE/scripts/release-apply.sh" | head -1)
[ "$(sha256sum "$GOBIN_SRC" | cut -d' ' -f1)" = "$GO_SHA" ] || { echo "supabase-go sha256 differs from the scripts' pin $GO_SHA" >&2; exit 1; }
id hone-release >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hone-release/home --no-create-home --shell /usr/sbin/nologin --user-group hone-release
passwd -l hone-release >/dev/null 2>&1 || true
install -d -m 700 -o hone-release -g hone-release /var/lib/hone-release /var/lib/hone-release/secrets /var/lib/hone-release/state /var/lib/hone-release/work /var/lib/hone-release/logs /var/lib/hone-release/home
install -d -m 755 -o root -g root /usr/local/libexec/hone-release /usr/local/libexec/hone-release/scripts /usr/local/libexec/hone-release/bin /etc/hone-release
install -m 755 -o root -g root "$HERE/launcher" /usr/local/libexec/hone-release/launcher
install -m 755 -o root -g root "$GOBIN_SRC" /usr/local/libexec/hone-release/bin/supabase-go
: > /usr/local/libexec/hone-release/manifest.new
grep -Ev '^[[:space:]]*(#|$)' "$HERE/actions.conf" | while read -r action file secret; do
  install -m 755 -o root -g root "$HERE/scripts/$file" "/usr/local/libexec/hone-release/scripts/$file"
  printf '%s %s %s %s\n' "$action" "$(sha256sum "/usr/local/libexec/hone-release/scripts/$file" | cut -d' ' -f1)" "/usr/local/libexec/hone-release/scripts/$file" "$secret" >> /usr/local/libexec/hone-release/manifest.new
done
chown root:root /usr/local/libexec/hone-release/manifest.new; chmod 644 /usr/local/libexec/hone-release/manifest.new
mv -f /usr/local/libexec/hone-release/manifest.new /usr/local/libexec/hone-release/manifest
printf '%s\n' "$REF" > /etc/hone-release/PROJECT-REF.new; chown root:root /etc/hone-release/PROJECT-REF.new; chmod 644 /etc/hone-release/PROJECT-REF.new; mv -f /etc/hone-release/PROJECT-REF.new /etc/hone-release/PROJECT-REF
install -d -m 755 -o "$AGENT" -g "$AGENT" /srv/hone-release-inbox
tmp=$(mktemp /etc/sudoers.d/.hone-release.XXXXXX); sed "s/@AGENT@/$AGENT/g" "$HERE/sudoers.hone-release" > "$tmp"; chown root:root "$tmp"; chmod 440 "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; echo "sudoers file did not validate; nothing installed" >&2; exit 1; }
mv -f "$tmp" /etc/sudoers.d/hone-release
visudo -c >/dev/null
echo "installed. manifest:"; cat /usr/local/libexec/hone-release/manifest
echo "launcher sha256 $(sha256sum /usr/local/libexec/hone-release/launcher | cut -d' ' -f1)"
echo "next (root): set-secret.sh db-password ; set-secret.sh read-pat ; approve-package.sh ..."
