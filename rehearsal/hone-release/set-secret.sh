#!/bin/bash
# Run as ROOT. usage: set-secret.sh db-password|read-pat   Reads the secret at a hidden prompt (twice), writes it to
# /var/lib/hone-release/secrets/<name> (owner hone-release, mode 600). --stdin reads one line from stdin instead (CI only).
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
name=${1:-}; case "$name" in db-password|read-pat) ;; *) echo "name must be db-password or read-pat" >&2; exit 1 ;; esac
if [ "${2:-}" = --stdin ]; then IFS= read -r v
else
  IFS= read -rs -p "$name (not shown): " v </dev/tty; echo >&2
  IFS= read -rs -p "again: " v2 </dev/tty; echo >&2
  [ "$v" = "$v2" ] || { echo "mismatch; nothing written" >&2; exit 1; }
fi
[ -n "$v" ] || { echo "empty; nothing written" >&2; exit 1; }
f=/var/lib/hone-release/secrets/$name
printf '%s\n' "$v" > "$f.new"; chown hone-release:hone-release "$f.new"; chmod 600 "$f.new"; mv -f "$f.new" "$f"
echo "$name written (owner hone-release, mode 600, $(stat -c %s "$f") bytes)"
