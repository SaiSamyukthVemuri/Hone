#!/bin/bash
# Run as ROOT, by Sam's per-stage approval. usage: approve-package.sh <approval_id> <first> <last> <count> <expires_at_UTC> <target_url> <recovery_attestation> [--yes]
# Computes the bundle sha, list sha and head from /srv/hone-release-inbox/{bundle.tar,list.sha256}, prints them, and (after the root
# operator types the first 8 characters of the bundle sha, or --yes in CI) writes /etc/hone-release/APPROVED-PACKAGE (root:root 644).
# The record is single-use: the apply action consumes the approval_id.
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
id_=$1; first=$2; last=$3; count=$4; exp=$5; url=$6; att=$7
IN=/srv/hone-release-inbox
bundle=$(sha256sum "$IN/bundle.tar" | cut -d' ' -f1); list=$(sha256sum "$IN/list.sha256" | cut -d' ' -f1)
head_=$(head -c 2048 "$IN/bundle.tar" | LC_ALL=C grep -a -o 'comment=[0-9a-f]\{40\}' | head -1 | cut -d= -f2)
ref=$(head -n 1 /etc/hone-release/PROJECT-REF)
echo "approval_id=$id_ head=$head_ bundle=$bundle list=$list versions=$first..$last count=$count expires=$exp ref=$ref"
echo "target (no password): $url"; echo "recovery attestation: $att"
if [ "${8:-}" != --yes ]; then read -r -p "type the first 8 characters of the bundle sha to approve: " t </dev/tty; [ "$t" = "${bundle:0:8}" ] || { echo "not approved" >&2; exit 1; }; fi
tmp=$(mktemp /etc/hone-release/.ap.XXXXXX)
{ echo "approval_id=$id_"; echo "head=$head_"; echo "bundle_sha=$bundle"; echo "list_sha=$list"; echo "project_ref=$ref"; echo "target_url=$url"
  echo "first=$first"; echo "last=$last"; echo "count=$count"; echo "expires_at=$exp"; echo "recovery_attestation=$att"; echo "watchdog=waived-by-approver"; } > "$tmp"
chown root:root "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" /etc/hone-release/APPROVED-PACKAGE
echo "APPROVED-PACKAGE written"
