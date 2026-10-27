#!/bin/bash
# Run as ROOT, by Sam's per-stage approval, with the person present. Every value is TYPED as an argument, copied from the REVIEWED record (the
# reviewed END and PR), never taken from this script's own output. The script then computes the same values from the inbox and REFUSES on any
# difference, prints the first and last file and the count, and only then writes /etc/hone-release/APPROVED-PACKAGE (root:root 644, single use,
# at most 60 minutes). usage (all required; key=value):
#   approve-package.sh id=<approval id> bundle_sha=<64 hex> list_sha=<64 hex> head=<40 hex> pr=<number> receipt_sha=<64 hex> first=NNNN last=NNNN count=N
#     minutes=<1..60> window_start=<UTC> window_end=<UTC> recovery_basis=row4|waiver recovery_point=<UTC>|none waiver_id=<id>|none
#     pooler_host=<host:5432> max_push_seconds=<10..1800> attestation="<Sam's words>"
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
declare -A V
for kv in "$@"; do
  case "$kv" in *=*) ;; *) echo "arguments are key=value" >&2; exit 1 ;; esac
  k=${kv%%=*}; v=${kv#*=}
  case " id bundle_sha list_sha head pr receipt_sha first last count minutes window_start window_end recovery_basis recovery_point waiver_id pooler_host max_push_seconds attestation " in *" $k "*) ;; *) echo "unknown argument: $k" >&2; exit 1 ;; esac
  [ -z "${V[$k]+x}" ] || { echo "repeated argument: $k" >&2; exit 1; }
  V[$k]=$v
done
for k in id bundle_sha list_sha head pr receipt_sha first last count minutes window_start window_end recovery_basis recovery_point waiver_id pooler_host max_push_seconds attestation; do
  [ -n "${V[$k]+x}" ] && [ -n "${V[$k]}" ] || { echo "missing argument: $k" >&2; exit 1; }
done
hex() { printf '%s' "$2" | grep -Eq "^[0-9a-f]{$1}\$"; }
hex 64 "${V[bundle_sha]}" && hex 64 "${V[list_sha]}" && hex 40 "${V[head]}" && hex 64 "${V[receipt_sha]}" || { echo "bundle_sha, list_sha, head and receipt_sha must be FULL lowercase hex (64, 64, 40, 64)" >&2; exit 1; }
printf '%s' "${V[minutes]}" | grep -Eq '^[0-9]{1,2}$' && [ "${V[minutes]}" -ge 1 ] && [ "${V[minutes]}" -le 60 ] || { echo "minutes must be 1..60" >&2; exit 1; }
if [ "${V[recovery_basis]}" = waiver ]; then printf '%s' "${V[waiver_id]}" | grep -Eq '^WAIVER-[0-9]{8}-[0-9]{1,3}$' || { echo "waiver_id must be WAIVER-YYYYMMDD-N, typed from the recorded waiver" >&2; exit 1; }; fi
IN=/srv/hone-release-inbox
[ -f "$IN/bundle.tar" ] && [ -f "$IN/list.sha256" ] && [ ! -L "$IN/bundle.tar" ] && [ ! -L "$IN/list.sha256" ] || { echo "the inbox files are missing or symlinks" >&2; exit 1; }
bundle=$(sha256sum "$IN/bundle.tar" | cut -d' ' -f1); list=$(sha256sum "$IN/list.sha256" | cut -d' ' -f1)
head_=$(head -c 2048 "$IN/bundle.tar" | LC_ALL=C grep -a -o 'comment=[0-9a-f]\{40\}' | head -1 | cut -d= -f2)
bad=0
[ "$bundle" = "${V[bundle_sha]}" ] || { echo "REFUSED: the inbox bundle's sha256 is $bundle, not the reviewed ${V[bundle_sha]}" >&2; bad=1; }
[ "$list" = "${V[list_sha]}" ] || { echo "REFUSED: the inbox list's sha256 is $list, not the reviewed ${V[list_sha]}" >&2; bad=1; }
[ "$head_" = "${V[head]}" ] || { echo "REFUSED: the bundle's commit id is '$head_', not the reviewed ${V[head]}" >&2; bad=1; }
[ "$bad" = 0 ] || { echo "nothing was approved" >&2; exit 1; }
nfiles=$(grep -c '' "$IN/list.sha256"); f1=$(awk -v f="$((10#${V[first]}))" '{v=substr($2,1,4)+0; if (v>=f) {print $2; exit}}' "$IN/list.sha256"); fl=$(awk '{n=$2} END {print n}' "$IN/list.sha256")
n=$(awk -v f="$((10#${V[first]}))" -v l="$((10#${V[last]}))" '{v=substr($2,1,4)+0; if (v>=f && v<=l) c++} END {print c+0}' "$IN/list.sha256")
[ "$n" = "${V[count]}" ] || { echo "REFUSED: the list holds $n files from ${V[first]} to ${V[last]}, not the typed count ${V[count]}" >&2; exit 1; }
ref=$(head -n 1 /etc/hone-release/PROJECT-REF)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ); exp=$(date -u -d "+${V[minutes]} minutes" +%Y-%m-%dT%H:%M:%SZ)
q="sslmode=require"
url="postgresql://postgres.$ref@${V[pooler_host]}/postgres?$q"
echo "VERIFIED against the typed reviewed values: bundle ${bundle:0:12}... list ${list:0:12}... head ${head_:0:12}... PR #${V[pr]} receipt ${V[receipt_sha]:0:12}..."
echo "package: $nfiles files in the list; pending ${V[first]}..${V[last]} = $n files; first pending $f1; last file in the list $fl"
echo "window ${V[window_start]} .. ${V[window_end]}; approval valid until $exp; recovery ${V[recovery_basis]} ${V[recovery_point]} ${V[waiver_id]}; target (no password) $url"
tmp=$(mktemp /etc/hone-release/.ap.XXXXXX)
{ echo "approval_id=${V[id]}"; echo "approved_at=$now"; echo "head=$head_"; echo "bundle_sha=$bundle"; echo "list_sha=$list"; echo "pr=${V[pr]}"; echo "pr_head=${V[head]}"; echo "receipt_sha=${V[receipt_sha]}"
  echo "project_ref=$ref"; echo "target_url=$url"; echo "pooler_host=${V[pooler_host]}"
  echo "first=${V[first]}"; echo "last=${V[last]}"; echo "count=${V[count]}"; echo "expires_at=$exp"; echo "window_start=${V[window_start]}"; echo "window_end=${V[window_end]}"
  echo "recovery_basis=${V[recovery_basis]}"; echo "recovery_point=${V[recovery_point]}"; echo "waiver_id=${V[waiver_id]}"; echo "max_push_seconds=${V[max_push_seconds]}"
  echo "timeout_residual=accepted-server-limit-only"; echo "recovery_attestation=${V[attestation]}"; echo "watchdog=waived-by-approver"; } > "$tmp"
chown root:root "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" /etc/hone-release/APPROVED-PACKAGE
echo "APPROVED-PACKAGE written (single use, consumed at the first dry-run attempt)"
