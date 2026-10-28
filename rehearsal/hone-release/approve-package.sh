#!/bin/bash
# Run as ROOT, by Sam's per-stage approval, with the person present. Every value is TYPED as an argument, copied from the REVIEWED record (the
# reviewed END and PR), never taken from this script's own output. The script then computes the same values from the inbox and REFUSES on any
# difference, prints the first and last file and the count, and only then writes /etc/hone-release/APPROVED-PACKAGE (root:root 644, single use,
# at most 60 minutes). usage (all required; key=value):
#   approve-package.sh id=<approval id> bundle_sha=<64 hex> list_sha=<64 hex> head=<40 hex> pr=<number> receipt_sha=<64 hex> first=NNNN last=NNNN count=N
#     minutes=<1..60> window_start=<UTC> window_end=<UTC> recovery_basis=row4|waiver waiver_id=WAIVER-YYYYMMDD-N|none
#     recovery_stamp=<UTC>|none s0a_writes=<digits>|none s0a_sha=<64 hex> s0a_at=<UTC> min_span_days=<6..99> quiet_db=idle|heartbeat   (Sam's one-word E4 selection)
#     history_before=<rows> drain_holds=yes drain_queues=yes drain_people=yes drain_max_busy=<0..99> drain_attestation="<words>" serving_commit=<40 hex> serving_attestation="<words>" serving_check=readback|attested-only heartbeat_auth="<the exact sentence for this approval id, or none>" verify_sha=<64 hex>|none
#     connection_mode=direct|pooler pooler_host=<aws-N-region.pooler.supabase.com:5432>|none
#     statement_timeout_s=<1..600> lock_timeout_s=<1..30> idle_tx_timeout_s=<1..300> max_push_seconds=<10..1800> attestation="<Sam's words>"
# recovery_basis=row4 is the AUTONOMOUS path (needs the custody-recorded provider evidence at apply time); waiver is the ATTENDED FALLBACK (a recorded waiver id).
set -eu
umask 022
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
declare -A V
for kv in "$@"; do
  case "$kv" in *=*) ;; *) echo "arguments are key=value" >&2; exit 1 ;; esac
  k=${kv%%=*}; v=${kv#*=}
  case " id bundle_sha list_sha head pr receipt_sha first last count minutes window_start window_end recovery_basis waiver_id recovery_stamp s0a_writes s0a_sha s0a_at min_span_days quiet_db connection_mode pooler_host history_before drain_holds drain_queues drain_people drain_max_busy drain_attestation serving_commit serving_attestation serving_check heartbeat_auth verify_sha statement_timeout_s lock_timeout_s idle_tx_timeout_s max_push_seconds attestation " in *" $k "*) ;; *) echo "unknown argument: $k" >&2; exit 1 ;; esac
  [ -z "${V[$k]+x}" ] || { echo "repeated argument: $k" >&2; exit 1; }
  V[$k]=$v
done
for k in id bundle_sha list_sha head pr receipt_sha first last count minutes window_start window_end recovery_basis waiver_id recovery_stamp s0a_writes s0a_sha s0a_at min_span_days quiet_db connection_mode pooler_host history_before drain_holds drain_queues drain_people drain_max_busy drain_attestation serving_commit serving_attestation serving_check heartbeat_auth verify_sha statement_timeout_s lock_timeout_s idle_tx_timeout_s max_push_seconds attestation; do
  [ -n "${V[$k]+x}" ] && [ -n "${V[$k]}" ] || { echo "missing argument: $k" >&2; exit 1; }
done
hex() { printf '%s' "$2" | grep -Eq "^[0-9a-f]{$1}\$"; }
hex 64 "${V[bundle_sha]}" && hex 64 "${V[list_sha]}" && hex 40 "${V[head]}" && hex 64 "${V[receipt_sha]}" || { echo "bundle_sha, list_sha, head and receipt_sha must be FULL lowercase hex (64, 64, 40, 64)" >&2; exit 1; }
printf '%s' "${V[minutes]}" | grep -Eq '^[0-9]{1,2}$' && [ "${V[minutes]}" -ge 1 ] && [ "${V[minutes]}" -le 60 ] || { echo "minutes must be 1..60" >&2; exit 1; }
hex 64 "${V[s0a_sha]}" || { echo "s0a_sha must be the FULL 64-hex sha256 of the S0a result record" >&2; exit 1; }
case "${V[quiet_db]}" in idle|heartbeat) ;; *) echo "quiet_db must be idle or heartbeat" >&2; exit 1 ;; esac
case "${V[connection_mode]}" in direct|pooler) ;; *) echo "connection_mode must be direct or pooler" >&2; exit 1 ;; esac
case "${V[recovery_basis]}" in row4) AUTON=autonomous ;; waiver) AUTON=attended-fallback ;; *) echo "recovery_basis must be row4 or waiver" >&2; exit 1 ;; esac
if [ "${V[recovery_basis]}" = waiver ]; then printf '%s' "${V[waiver_id]}" | grep -Eq '^WAIVER-[0-9]{8}-[0-9]{1,3}$' || { echo "waiver_id must be WAIVER-YYYYMMDD-N, typed from the recorded waiver" >&2; exit 1; }; fi
SENT_T='I authorize ONE heartbeat write to the production database: a single pg_logical_emit_message WAL message (no table, no row, no schema change) over the verify-full direct connection as the postgres role, once for approval %s.'
if [ "${V[quiet_db]}" = heartbeat ]; then
  want_sent=$(printf "$SENT_T" "${V[id]}"); [ "${V[heartbeat_auth]}" = "$want_sent" ] || { echo "REFUSED: quiet_db=heartbeat is a HOSTED WRITE; heartbeat_auth must be Sam's exact sentence for this approval id:" >&2; echo "  $want_sent" >&2; exit 1; }
  HBSHA=$(printf '%s' "$want_sent" | sha256sum | cut -d' ' -f1)
else
  [ "${V[heartbeat_auth]}" = none ] || { echo "REFUSED: heartbeat_auth must be none unless quiet_db=heartbeat" >&2; exit 1; }
  HBSHA=none
fi
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
S=${V[statement_timeout_s]}; L=${V[lock_timeout_s]}; I=${V[idle_tx_timeout_s]}
for tv in "$S" "$L" "$I"; do printf '%s' "$tv" | grep -Eq '^[0-9]{1,4}$' && [ "$tv" -ge 1 ] || { echo "the three timeouts must be positive whole seconds" >&2; exit 1; }; done
if [ "${V[connection_mode]}" = direct ]; then
  host="db.$ref.supabase.co:5432"; TC=server-startup-options
  url="postgresql://postgres@$host/postgres?options=-c%20statement_timeout%3D$((S * 1000))%20-c%20lock_timeout%3D$((L * 1000))%20-c%20idle_in_transaction_session_timeout%3D$((I * 1000))%20-c%20client_connection_check_interval%3D5000"
else
  host=${V[pooler_host]}; TC=server-per-file-set-local
  url="postgresql://postgres.$ref@$host/postgres"
fi
echo "VERIFIED against the typed reviewed values: bundle ${bundle:0:12}... list ${list:0:12}... head ${head_:0:12}... PR #${V[pr]} receipt ${V[receipt_sha]:0:12}..."
echo "package: $nfiles files in the list; pending ${V[first]}..${V[last]} = $n files; first pending $f1; last file in the list $fl"
echo "window ${V[window_start]} .. ${V[window_end]}; approval valid until $exp; recovery ${V[recovery_basis]} ($AUTON) stamp ${V[recovery_stamp]} waiver ${V[waiver_id]}; quiet-database mode ${V[quiet_db]}; S0a ${V[s0a_sha]:0:12}... at ${V[s0a_at]}"
echo "connection ${V[connection_mode]}; timeouts (server side, $TC) statement ${S}s lock ${L}s idle-in-transaction ${I}s; client wall clock ${V[max_push_seconds]}s then KILL; target (no password) $url"
tmp=$(mktemp /etc/hone-release/.ap.XXXXXX)
{ echo "approval_id=${V[id]}"; echo "approved_at=$now"; echo "head=$head_"; echo "bundle_sha=$bundle"; echo "list_sha=$list"; echo "pr=${V[pr]}"; echo "pr_head=${V[head]}"; echo "receipt_sha=${V[receipt_sha]}"
  echo "project_ref=$ref"; echo "target_url=$url"; echo "connection_mode=${V[connection_mode]}"; echo "db_host=$host"
  echo "first=${V[first]}"; echo "last=${V[last]}"; echo "count=${V[count]}"; echo "expires_at=$exp"; echo "window_start=${V[window_start]}"; echo "window_end=${V[window_end]}"
  echo "recovery_basis=${V[recovery_basis]}"; echo "waiver_id=${V[waiver_id]}"; echo "recovery_stamp=${V[recovery_stamp]}"; echo "s0a_sha=${V[s0a_sha]}"; echo "s0a_at=${V[s0a_at]}"; echo "min_span_days=${V[min_span_days]}"
  echo "quiet_db_mode=${V[quiet_db]}"; echo "autonomy=$AUTON"; echo "statement_timeout_s=$S"; echo "lock_timeout_s=$L"; echo "idle_tx_timeout_s=$I"; echo "timeout_control=$TC"
  echo "max_push_seconds=${V[max_push_seconds]}"; echo "recovery_attestation=${V[attestation]}"
  echo "s0a_writes=${V[s0a_writes]}"; echo "history_before=${V[history_before]}"; echo "drain_holds=${V[drain_holds]}"; echo "drain_queues=${V[drain_queues]}"; echo "drain_people=${V[drain_people]}"; echo "drain_max_busy=${V[drain_max_busy]}"; echo "drain_attestation=${V[drain_attestation]}"
  echo "serving_commit=${V[serving_commit]}"; echo "serving_attestation=${V[serving_attestation]}"; echo "serving_check=${V[serving_check]}"; echo "heartbeat_auth_sha=$HBSHA"; echo "verify_sha=${V[verify_sha]}"; } > "$tmp"
chown root:root "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" /etc/hone-release/APPROVED-PACKAGE
echo "APPROVED-PACKAGE written (single use, consumed at the first dry-run attempt)"
