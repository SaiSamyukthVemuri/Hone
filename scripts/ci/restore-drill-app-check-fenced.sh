#!/usr/bin/env bash
# DR-01A, CI only (.github/workflows/restore-drill.yml). Runs the application
# check, and the Hone server it starts, as this user but with the primary group
# hone-egress and no supplementary groups. The workflow's iptables/ip6tables
# rules LOG and REJECT every packet that group sends on any interface but
# loopback, so their counters measure the check's real egress: zero is the
# proof, and nothing can leave even if a provider guard failed.
#
# The environment is rebuilt from nothing but PATH and HOME; the check then
# gives the server its own closed environment (scripts/ops/restore-drill-app-check.mjs).
set -euo pipefail
GID="$(getent group hone-egress | cut -d: -f3)"
[ -n "$GID" ] || { echo "the hone-egress group does not exist; the workflow creates it" >&2; exit 2; }
exec sudo -n setpriv --reuid="$(id -u)" --regid="$GID" --clear-groups -- \
  env -i PATH="$PATH" HOME="$HOME" node "$(cd "$(dirname "$0")/../ops" && pwd)/restore-drill-app-check.mjs" "$@"
