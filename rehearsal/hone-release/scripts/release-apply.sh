#!/bin/bash
# hone-release action: apply. Linux, non-interactive. Run ONLY by the launcher, as hone-release, with the database password on
# fd 3 and a sanitised environment. Derived from the reviewed s1-apply.sh 2dfd3354 (see DELTAS.md for every difference).
# It applies ONE package that root has approved in /etc/hone-release/APPROVED-PACKAGE: the bundle sha, the list sha and the
# head (the commit id in the tar's own header) must equal the approval, which also binds the PR number, the PR head and the release
# receipt sha, the window, the recovery basis, the connection mode, the server-side timeouts and the exact target. The approval must be
# unexpired (at most 60 minutes after approved_at) and is CONSUMED at the first dry-run attempt.
# HON66-CONSOLIDATE: (T5) the CLI child gets PGSSLMODE=verify-full and PGSSLROOTCERT=<the pinned Supabase root CA>, which the vendor CLI's pgx layer
# honours because the CLI rebuilds the connection URL without any sslmode (see EVIDENCE-A). (T4) The timeout is enforced by the SERVER: on the direct
# connection through startup options (-c statement_timeout / lock_timeout / idle_in_transaction_session_timeout), on the pooler only if every
# approved file carries its own bounded `set local statement_timeout` (lexical gate). A client wall clock KILLS the CLI on overrun and maps to
# UNKNOWN-KILLED: never PASS, never retry, reconcile by the read-only `reconcile` action. (C) basis=row4 needs custody-recorded provider evidence
# (BACKUPS-EVIDENCE) plus the quiet-database proof selected by quiet_db_mode (idle | heartbeat); the script STOPs when it is missing.
# Two actions share this one reviewed script (the launcher passes the action name in HONE_RELEASE_ACTION and a different secret):
#   preflight  (read token on fd 3): runs EVERY check below that needs no database password, reads the history, the drain read check, and writes the
#              reviewable GO/NO-GO package state/GONOGO.json (sha-bound to the approval). It never consumes the approval and never touches the state word.
#   apply      (database password on fd 3): additionally requires the GO/NO-GO to be bound by root (GONOGO-BOUND), then ONE dry run, ONE push.
# After the push the state is APPLIED-UNVERIFIED; only the verify action (history, stage checks, smoke, receipt) turns it into APPLIED.
# ONE dry run, ONE push, NO retry. A durable IN-FLIGHT marker is written before the push; anything but a clean APPLIED state
# blocks the next run until root clears it. Nothing here asks for a keystroke: the root-written approval is the control.
set -u
umask 077

PREFIX=/var/lib/hone-release
STATE="$PREFIX/state"
WORKROOT="$PREFIX/work"
LOGROOT="$PREFIX/logs"
APPROVAL=/etc/hone-release/APPROVED-PACKAGE
INBOX=/srv/hone-release-inbox
BIN=/usr/local/libexec/hone-release/bin/supabase-go
CA=/usr/local/libexec/hone-release/ca/supabase-prod-ca-2021.crt
CA_SHA=700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
MAXBYTES=67108864

PW=""
STAGE=start
RUNDIR=""
ACTION=${HONE_RELEASE_ACTION:-}
die() { echo "STOP: $*" >&2; [ "$ACTION" != preflight ] || gonogo_write NO-GO "$*"; exit 1; }
PFC="$STATE/gonogo.checks"
pf_check() { [ "$ACTION" = preflight ] || return 0; printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$PFC"; } # pf_check NAME PASS|FAIL DETAIL
gonogo_write() { # gonogo_write GO|NO-GO REASON   the reviewable package: checks + verdict + the sha of the approval it is about
  mkdir -p "$STATE" 2>/dev/null
  python3 -I - "$1" "$2" "$STATE" "${APPROVAL:-}" "$PFC" <<'PYG'
import json, sys, os, hashlib, time
verdict, reason, st, ap, pfc = sys.argv[1:6]
def sha(b): return hashlib.sha256(b).hexdigest()
asha = sha(open(ap, "rb").read()) if ap and os.path.isfile(ap) else "none"
aid = "none"
if asha != "none":
    for l in open(ap):
        if l.startswith("approval_id="): aid = l.strip().split("=", 1)[1]
checks = []
if os.path.isfile(pfc):
    for l in open(pfc):
        p = l.rstrip("\n").split("|", 2)
        if len(p) == 3: checks.append({"name": p[0], "result": p[1], "detail": p[2]})
if verdict == "GO" and any(c["result"] != "PASS" for c in checks): verdict = "NO-GO"; reason = "a check failed"
body = {"kind": "hone-release-gonogo", "approval_id": aid, "approval_sha256": asha, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "verdict": verdict, "reason": reason, "checks": checks}
canon = json.dumps(body, sort_keys=True, separators=(",", ":"))
body["sha256"] = sha(canon.encode())
tmp = os.path.join(st, "GONOGO.json.tmp")
open(tmp, "w").write(json.dumps(body, sort_keys=True, indent=1) + "\n"); os.replace(tmp, os.path.join(st, "GONOGO.json"))
print(json.dumps(body, sort_keys=True, indent=1))
PYG
}
receipt_add() { # receipt_add STAGE DETAIL   one link of the sha-chained receipt for this approval (logs/<id>/receipt.json)
  [ -n "${APPROVAL_ID:-}" ] || return 0
  mkdir -p "$LOGROOT/$APPROVAL_ID" && python3 -I - "$LOGROOT/$APPROVAL_ID/receipt.json" "$1" "$2" <<'PYR'
import json, sys, os, hashlib, time
path, stage, detail = sys.argv[1:4]
def sha(b): return hashlib.sha256(b).hexdigest()
r = json.load(open(path)) if os.path.isfile(path) else {"kind": "hone-release-receipt", "entries": []}
prev = r["entries"][-1]["sha256"] if r["entries"] else "0" * 64
e = {"seq": len(r["entries"]) + 1, "stage": stage, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "detail": detail, "prev": prev}
e["sha256"] = sha((prev + json.dumps(e, sort_keys=True, separators=(",", ":"))).encode())
r["entries"].append(e); r["head"] = e["sha256"]
tmp = path + ".tmp"; open(tmp, "w").write(json.dumps(r, sort_keys=True, indent=1) + "\n"); os.replace(tmp, path)
PYR
}
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sha() { sha256sum -- "$1" | cut -d' ' -f1; }
epoch() { date -u -d "$1" +%s 2>/dev/null; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#([Uu]ser|[Hh]ost|[Hh]ostaddr|[Dd]bname)=[^ ,)]*#\1=<masked>#g' -e 's#([Uu]ser|[Rr]ole) "[^"]*"#\1 <masked>#g' -e 's#[A-Za-z0-9.-]*\.supabase\.(com|co)[:0-9]*#<host>#g'; }
MANIFEST=/usr/local/libexec/hone-release/manifest
mgmt() { # mgmt ID [args]   the ONE pinned read helper (mgmt-read.py): sha256-checked against the root-owned manifest; the token is only in its environment
  local line msha mpath; line=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null)
  msha=${line% *}; mpath=${line#* }
  [ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || { echo "the mgmt-read helper is missing or differs from the manifest sha256" >&2; return 9; }
  HONE_READ_TOKEN="$TOKEN" python3 -I "$mpath" "$REF" "$@"
}
is_auth_failure() { grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found' "$1"; }
write_state() { # write_state WORD [detail]: durable (fsync) replacement of the state marker
  printf '%s %s %s\n' "$1" "${APPROVAL_ID:-none}" "$(utcnow)${2:+ $2}" > "$STATE/APPLY-STATE.tmp" && sync "$STATE/APPLY-STATE.tmp" && mv -f "$STATE/APPLY-STATE.tmp" "$STATE/APPLY-STATE" && sync "$STATE" 2>/dev/null
}
trap 'PW=""; unset PW' EXIT
trap 'echo >&2; echo "STOP: signal received at stage $STAGE. A running push is NOT stopped by this signal (only the server-side timeouts and the client wall clock stop it). If the stage was the push, the state is IN-FLIGHT and blocks the next run until root clears it: run the read-only reconcile action first." >&2' INT TERM HUP

case "$ACTION" in apply|preflight) ;; *) die "not started by the launcher for the apply or preflight action" ;; esac
[ "$(uname -s)" = Linux ] || die "not Linux"
for t in flock setsid sha256sum tar awk sed python3; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done

# ---- the password: fd 3 only, never argv or environment
{ IFS= read -r PW <&3; } 2>/dev/null || die "no secret on fd 3"
exec 3<&-
[ -n "$PW" ] || die "empty secret; nothing was attempted"
TOKEN=""; if [ "$ACTION" = preflight ]; then TOKEN=$PW; PW=""; : > "$PFC" 2>/dev/null || { mkdir -p "$STATE"; : > "$PFC"; }; fi
env | grep -E '^(PG|SUPABASE_|DATABASE_URL|GITHUB_TOKEN|GH_TOKEN|HTTPS?_PROXY|ALL_PROXY|NODE_|BASH_ENV|ENV|LD_)' >/dev/null && die "the environment holds a variable that must not be there (names withheld)"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch"
[ -f "$CA" ] && [ ! -L "$CA" ] && [ "$(sha "$CA")" = "$CA_SHA" ] || die "the pinned Supabase root CA is missing or its sha256 differs from the pin in this script (T5)"
if command -v openssl >/dev/null 2>&1 && ! openssl x509 -in "$CA" -noout -checkend $((180 * 86400)) >/dev/null 2>&1; then echo "WARNING: the pinned Supabase root CA expires within 180 days (or is unreadable): plan a new reviewed package" >&2; pf_check ca-expiry PASS "WARNING: the pinned CA expires within 180 days"; fi
pf_check tooling PASS "supabase-go sha256 and the pinned CA sha256 match the pins in this script"

# ---- state and the single release lock
mkdir -p "$STATE/consumed" "$WORKROOT" "$LOGROOT" 2>/dev/null
exec 9>"$STATE/lock" || die "cannot open the lock file"
flock -n 9 || die "another release run holds the lock; nothing was attempted"
if [ -e "$STATE/APPLY-STATE" ]; then
  st=$(cat "$STATE/APPLY-STATE")
  case "$st" in
    APPLIED\ *) ;;
    APPLIED-UNVERIFIED\ *) die "the last push is APPLIED-UNVERIFIED: run the verify action first (history, stage checks, smoke, receipt); only root clears a failed verification. Nothing was attempted." ;;
    IN-FLIGHT\ *) die "the previous apply outcome is UNKNOWN ($st): read back the migration history; only root clears this. Nothing was attempted." ;;
    *) die "the previous run left the state: $st. Report it to OPS; only root clears it. Nothing was attempted." ;;
  esac
fi

# ---- the approved package (written by root): strict parse
APPROVAL_ID=""
[ -f "$APPROVAL" ] && [ ! -L "$APPROVAL" ] || die "no APPROVED-PACKAGE record. Nothing was attempted."
for p in "$APPROVAL" /etc/hone-release /etc; do
  [ "$(stat -c %u "$p")" = 0 ] && [ $(( 8#$(stat -c %a "$p") & 8#022 )) = 0 ] || die "$p is not root-owned and private to root"
done
declare_keys="heartbeat_auth_sha serving_check history_before s0a_writes drain_holds drain_queues drain_people drain_max_busy drain_attestation serving_commit serving_attestation verify_sha approval_id approved_at head bundle_sha list_sha pr pr_head receipt_sha project_ref target_url connection_mode db_host first last count expires_at window_start window_end recovery_basis waiver_id recovery_stamp s0a_sha s0a_at min_span_days quiet_db_mode autonomy statement_timeout_s lock_timeout_s idle_tx_timeout_s timeout_control max_push_seconds recovery_attestation"
seen=" "
while IFS= read -r l || [ -n "$l" ]; do
  case "$l" in ''|'#'*) continue ;; esac
  printf '%s' "$l" | LC_ALL=C grep -Eq '^[a-z0-9_]+=[A-Za-z0-9 ._:/@?&=,;()%+-]{1,300}$' || die "APPROVED-PACKAGE has a malformed line"
  k=${l%%=*}; v=${l#*=}
  case " $declare_keys " in *" $k "*) ;; *) die "APPROVED-PACKAGE has an unknown key: $k" ;; esac
  case "$seen" in *" $k "*) die "APPROVED-PACKAGE repeats a key: $k" ;; esac
  seen="$seen$k "
  eval "A_$k=\$v"
done < "$APPROVAL"
for k in $declare_keys; do case "$seen" in *" $k "*) ;; *) die "APPROVED-PACKAGE lacks the key: $k" ;; esac; done
APPROVAL_ID=$A_approval_id
now_s=$(epoch "$(utcnow)")
printf '%s' "$A_approval_id" | grep -Eq '^[A-Za-z0-9._-]{4,64}$' || die "approval_id is malformed"
printf '%s' "$A_head$A_pr_head" | grep -Eq '^[0-9a-f]{80}$' || die "head or pr_head is not a 40-hex commit id"
[ "$A_head" = "$A_pr_head" ] || die "the approval's pr_head is not its head: the bundle must be an archive of the reviewed PR head"
printf '%s' "$A_pr" | grep -Eq '^[0-9]{1,6}$' || die "pr is not a PR number"
printf '%s%s%s' "$A_bundle_sha" "$A_list_sha" "$A_receipt_sha" | grep -Eq '^[0-9a-f]{192}$' || die "bundle_sha, list_sha or receipt_sha is malformed"
printf '%s' "$A_project_ref" | grep -Eq '^[a-z0-9]{20}$' || die "project_ref is malformed"
printf '%s%s%s' "$A_first" "$A_last" "$A_count" | grep -Eq '^[0-9]{4}[0-9]{4}[0-9]{1,3}$' || die "first, last or count is malformed"
for k in approved_at expires_at window_start window_end; do eval "v=\$A_$k"; printf '%s' "$v" | LC_ALL=C grep -Eq "^$iso\$" || die "$k is not YYYY-MM-DDTHH:MM:SSZ"; done
ap_s=$(epoch "$A_approved_at"); ex_s=$(epoch "$A_expires_at"); ws_s=$(epoch "$A_window_start"); we_s=$(epoch "$A_window_end")
case "$now_s$ap_s$ex_s$ws_s$we_s" in *[!0-9]*|'') die "cannot read the approval times" ;; esac
[ "$ap_s" -le "$now_s" ] || die "approved_at is in the future"
[ "$ex_s" -gt "$now_s" ] || die "the approval has expired (expires_at $A_expires_at)"
[ $((ex_s - ap_s)) -le 3600 ] || die "the approval lives more than 60 minutes (approved_at to expires_at)"
[ "$ws_s" -lt "$we_s" ] || die "the approved window ends before it starts"
[ "$now_s" -ge "$ws_s" ] || die "the approved window has not opened (window_start $A_window_start): no apply outside the window"
[ "$now_s" -lt "$we_s" ] || die "the approved window has closed (window_end $A_window_end): no apply outside the window"
[ $(( (we_s - now_s) / 60 )) -ge 75 ] || die "fewer than 75 minutes of the approved window remain ($(( (we_s - now_s) / 60 )) left; the steps after the apply need them). Nothing was attempted."
pf_check window PASS "inside the approved window with at least 75 minutes left"
printf '%s' "$A_s0a_sha" | grep -Eq '^[0-9a-f]{64}$' || die "s0a_sha must be the 64-hex sha256 of the S0a result record"
printf '%s' "$A_s0a_at" | LC_ALL=C grep -Eq "^$iso\$" || die "s0a_at is not YYYY-MM-DDTHH:MM:SSZ"
s0_s=$(epoch "$A_s0a_at"); [ -n "$s0_s" ] && [ "$s0_s" -le "$now_s" ] || die "s0a_at is in the future"
[ "$s0_s" -ge "$ws_s" ] || die "the S0a result is older than the window start: run S0a inside the window (S0a freshness)"
[ $((now_s - s0_s)) -le 10800 ] || die "the S0a result is older than 3 hours (S0a freshness): run it again and re-approve"
printf '%s' "$A_min_span_days" | grep -Eq '^[0-9]{1,2}$' && [ "$A_min_span_days" -ge 6 ] || die "min_span_days must be 6 or more (S0-10)"
case "$A_quiet_db_mode" in idle|heartbeat) ;; *) die "quiet_db_mode must be idle or heartbeat (Sam's selection)" ;; esac
check_recovery() { # check_recovery MAXAGE   the custody-recorded provider evidence; every missing piece is a STOP
  local maxage=$1 f="$STATE/BACKUPS-EVIDENCE" t now2 ra la sp k v
  [ -f "$f" ] && [ ! -L "$f" ] || die "no BACKUPS-EVIDENCE: run the read-backups action first (the unattended path needs the provider's own recovery evidence)"
  for k in read_at pitr_enabled earliest latest span_seconds; do v=$(sed -n "s/^$k=//p" "$f" | head -1); eval "E_$k=\$v"; done
  now2=$(epoch "$(utcnow)")
  printf '%s' "$E_read_at" | LC_ALL=C grep -Eq "^$iso\$" || die "BACKUPS-EVIDENCE is malformed"
  ra=$(epoch "$E_read_at"); [ $((now2 - ra)) -le "$maxage" ] || die "BACKUPS-EVIDENCE is older than $maxage s: run read-backups again"
  [ "$ra" -ge "$ws_s" ] || die "BACKUPS-EVIDENCE was read before the window start"
  [ "$E_pitr_enabled" = true ] || die "the provider reports PITR not enabled: no supported recovery path"
  printf '%s' "$E_latest" | LC_ALL=C grep -Eq "^$iso\$" || die "the provider reports no latest recovery point"
  la=$(epoch "$E_latest"); sp=$E_span_seconds
  printf '%s' "$sp" | grep -Eq '^[0-9]+$' && [ "$sp" -ge $((A_min_span_days * 86400)) ] || die "the recovery span ($sp s) is below the approved minimum ($A_min_span_days days)"
  if [ "$A_quiet_db_mode" = heartbeat ]; then
    [ "$A_recovery_stamp" = none ] && [ "$A_s0a_writes" = none ] || die "quiet_db_mode=heartbeat must have recovery_stamp=none and s0a_writes=none (the stamp is the recorded heartbeat)"
    local hf="$STATE/HEARTBEAT" ha
    [ -f "$hf" ] && [ ! -L "$hf" ] || die "quiet_db_mode=heartbeat but no HEARTBEAT was recorded: run the heartbeat action, then read-backups after the recovery point advances"
    ha=$(sed -n 's/^HEARTBEAT at=\([^ ]*\) approval=.*/\1/p' "$hf" | head -1); printf '%s' "$ha" | LC_ALL=C grep -Eq "^$iso\$" || die "HEARTBEAT is malformed"
    [ "$(sed -n 's/^HEARTBEAT at=[^ ]* approval=\([^ ]*\).*/\1/p' "$hf" | head -1)" = "$APPROVAL_ID" ] || die "the HEARTBEAT belongs to another approval"
    grep -q ' settings=ok$' "$hf" || die "the HEARTBEAT did not confirm the startup options on the real endpoint (settings is not ok)"
    ha=$(epoch "$ha"); [ $((now2 - ha)) -le 3600 ] || die "the HEARTBEAT is older than 60 minutes"
    [ "$ha" -ge "$ws_s" ] || die "the HEARTBEAT is before the window start"
    [ "$ra" -ge "$ha" ] || die "BACKUPS-EVIDENCE was read before the heartbeat: read-backups again after the recovery point advances"
    [ "$la" -ge "$ha" ] || die "the provider's latest recovery point ($E_latest) is older than the heartbeat: the recovery point has not advanced past the stamp"
  else
    [ "$A_s0a_writes" != none ] && printf '%s' "$A_s0a_writes" | grep -Eq '^[0-9]{1,18}$' || die "quiet_db_mode=idle needs s0a_writes: the user-table write counter seen at S0a (digits)"
    printf '%s' "$A_recovery_stamp" | LC_ALL=C grep -Eq "^$iso\$" || die "quiet_db_mode=idle needs recovery_stamp in UTC (the latest recovery point seen at S0a)"
    # a quiet database has a recovery point OLDER than the window: that is the case this option exists for. The stamp is the point S0a saw; it may predate the
    # window but not S0a, and the provider's latest point must not have gone back past it.
    local st; st=$(epoch "$A_recovery_stamp"); [ "$st" -le "$s0_s" ] && [ "$st" -ge $((s0_s - 604800)) ] || die "recovery_stamp must be the recovery point S0a saw: not after s0a_at and not more than 7 days before it"
    [ "$la" -ge "$st" ] || die "the provider's latest recovery point ($E_latest) is older than the recovery_stamp: the recovery point went backwards"
    local pf="$STATE/IDLE-PROOF" pa pw
    [ -f "$pf" ] && [ ! -L "$pf" ] || die "quiet_db_mode=idle but no IDLE-PROOF: run the idle-probe action"
    grep -q '^IDLE-PROOF result=idle ' "$pf" || die "the idle proof says the database is NOT idle"
    pa=$(sed -n 's/.* second_at=\([^ ]*\) .*/\1/p' "$pf" | head -1); printf '%s' "$pa" | LC_ALL=C grep -Eq "^$iso\$" || die "IDLE-PROOF is malformed"
    pa=$(epoch "$pa"); [ $((now2 - pa)) -le "$maxage" ] || die "IDLE-PROOF is older than $maxage s: run idle-probe again"
    grep -q ' wal=ok ' "$pf" || die "the idle proof carries no WAL evidence (current WAL archived, archiver not failing, archive_timeout known): a write counter alone is not accepted for the autonomous path"
    pw=$(sed -n 's/.* writes=\([0-9]*\)$/\1/p' "$pf" | head -1)
    [ -n "$pw" ] && [ "$pw" = "$A_s0a_writes" ] || die "the user-table write counter ($pw) differs from the one at S0a ($A_s0a_writes): writes happened since S0a, so the quiet-database claim fails"
  fi
}
# drain / hold preconditions and the compatible-serving attestations: typed at approval, a launcher refusal, not an OPS-only step
for k in drain_holds drain_queues drain_people; do eval "v=\$A_$k"; [ "$v" = yes ] || die "drain precondition $k is not attested yes (reminder/cron holds paused, queues drained, people hold): nothing was attempted"; done
printf '%s' "$A_drain_max_busy" | grep -Eq '^[0-9]{1,2}$' || die "drain_max_busy must be 0..99"
[ "${#A_drain_attestation}" -ge 12 ] && [ "${#A_serving_attestation}" -ge 12 ] || die "drain_attestation and serving_attestation must be the approver's own words (12 characters or more)"
printf '%s' "$A_serving_commit" | grep -Eq '^[0-9a-f]{40}$' || die "serving_commit must be the 40-hex commit of the compatible application deployment"
case "$A_serving_check" in readback|attested-only) ;; *) die "serving_check must be readback or attested-only" ;; esac
printf '%s' "$A_verify_sha" | grep -Eq '^([0-9a-f]{64}|none)$' || die "verify_sha must be 64 hex or none"
printf '%s' "$A_history_before" | grep -Eq '^[0-9]{1,5}$' || die "history_before must be the number of history rows before the stage"
pf_check drain-attestations PASS "holds paused, queues drained, people hold: attested yes by the approver; max busy sessions $A_drain_max_busy"
case "$A_recovery_basis" in
  row4)
    [ "$A_waiver_id" = none ] || die "recovery_basis=row4 must have waiver_id=none"
    [ "$A_autonomy" = autonomous ] || die "recovery_basis=row4 is the AUTONOMOUS path: autonomy=autonomous"
    check_recovery 900 ;;
  waiver)
    printf '%s' "$A_waiver_id" | grep -Eq '^WAIVER-[0-9]{8}-[0-9]{1,3}$' || die "recovery_basis=waiver needs a waiver_id of the form WAIVER-YYYYMMDD-N, typed from the recorded waiver"
    [ "$A_autonomy" = attended-fallback ] || die "a waiver is the ATTENDED FALLBACK, never the autonomous path: autonomy=attended-fallback" ;;
  *) die "recovery_basis must be row4 or waiver" ;;
esac
printf '%s' "$A_max_push_seconds" | grep -Eq '^[0-9]{2,4}$' && [ "$A_max_push_seconds" -ge 10 ] && [ "$A_max_push_seconds" -le 1800 ] || die "max_push_seconds must be 10..1800"
for k in statement_timeout_s lock_timeout_s idle_tx_timeout_s; do eval "v=\$A_$k"; printf '%s' "$v" | grep -Eq '^[0-9]{1,4}$' && [ "$v" -ge 1 ] || die "$k must be a positive number of seconds"; done
[ "$A_statement_timeout_s" -le 600 ] && [ "$A_lock_timeout_s" -le 30 ] && [ "$A_idle_tx_timeout_s" -le 300 ] || die "a timeout is above its ceiling (statement 600 s, lock 30 s, idle-in-transaction 300 s)"
# T5/T4: the exact target, built here from the approval's fields, never accepted from the record's text alone
case "$A_connection_mode" in
  direct)
    [ "$A_db_host" = "db.$A_project_ref.supabase.co:5432" ] || die "db_host is not the exact direct host db.<ref>.supabase.co:5432 for this project"
    [ "$A_timeout_control" = server-startup-options ] || die "connection_mode=direct has timeout_control=server-startup-options"
    want_url="postgresql://postgres@$A_db_host/postgres?options=-c%20statement_timeout%3D$((A_statement_timeout_s * 1000))%20-c%20lock_timeout%3D$((A_lock_timeout_s * 1000))%20-c%20idle_in_transaction_session_timeout%3D$((A_idle_tx_timeout_s * 1000))%20-c%20client_connection_check_interval%3D5000" ;;
  pooler)
    printf '%s' "$A_db_host" | grep -Eq '^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com:5432$' || die "db_host is not a Supabase session pooler host on port 5432"
    [ "$A_timeout_control" = server-per-file-set-local ] || die "connection_mode=pooler has timeout_control=server-per-file-set-local (every file carries a bounded set local statement_timeout; the pooler ignores startup options)"
    want_url="postgresql://postgres.$A_project_ref@$A_db_host/postgres" ;;
  *) die "connection_mode must be direct or pooler" ;;
esac
# the URL carries NO sslmode: the vendor CLI drops it anyway; TLS verification is the child's PGSSLMODE=verify-full + PGSSLROOTCERT (pinned CA), proved in CI
[ "$A_target_url" = "$want_url" ] || die "target_url is not exactly the approved form for this project, connection mode and timeouts (no other host, port, user or parameter is accepted)"
pf_check target PASS "connection $A_connection_mode, the target was rebuilt from the approval fields and equals the record"
pf_check recovery PASS "basis $A_recovery_basis, path $A_autonomy"
GNG_SHA=none
[ ! -e "$STATE/consumed/$APPROVAL_ID" ] || die "approval $APPROVAL_ID was already used (single use). Nothing was attempted."

# ---- intake: copy from the inbox (anything the caller can write) into the private work dir FIRST, hash the COPY
mkdir -p "$WORKROOT" && RUNDIR=$(mktemp -d "$WORKROOT/run.XXXXXX") || die "cannot create the work dir"
chmod 700 "$RUNDIR"; PROJ="$RUNDIR/project"; LOGS="$RUNDIR/logs"; mkdir "$PROJ" "$LOGS"
for f in bundle.tar list.sha256; do
  [ -f "$INBOX/$f" ] && [ ! -L "$INBOX/$f" ] || die "$INBOX/$f is missing or a symlink"
  [ "$(stat -c %s "$INBOX/$f")" -le "$MAXBYTES" ] || die "$INBOX/$f is too large"
  cat -- "$INBOX/$f" > "$RUNDIR/$f" || die "cannot copy $f"
done
[ "$(sha "$RUNDIR/bundle.tar")" = "$A_bundle_sha" ] || die "the bundle sha256 is not the approved one"
[ "$(sha "$RUNDIR/list.sha256")" = "$A_list_sha" ] || die "the list sha256 is not the approved one"
tarhead=$(head -c 2048 "$RUNDIR/bundle.tar" | LC_ALL=C grep -a -o 'comment=[0-9a-f]\{40\}' | head -1 | cut -d= -f2)
[ -n "$tarhead" ] || die "the bundle has no commit id in its header (it must be a git archive of a commit)"
[ "$tarhead" = "$A_head" ] || die "the bundle's commit id is not the approved head"
NFILES=$(grep -c '' "$RUNDIR/list.sha256")
prev=0
while IFS= read -r l; do
  printf '%s' "$l" | grep -Eq '^[0-9a-f]{64}  [0-9]{4}_[A-Za-z0-9_]+\.sql$' || die "list.sha256 has a malformed line"
  v=${l#*  }; v=${v%%_*}; vn=$((10#$v))
  [ "$vn" -le "$((10#$A_last))" ] || die "list.sha256 names a file above the approved last version $A_last: $v"
  [ "$vn" -gt "$prev" ] || die "list.sha256 is not strictly ascending at $v"
  prev=$vn
done < "$RUNDIR/list.sha256"
[ "$prev" = "$((10#$A_last))" ] || die "list.sha256 does not end at the approved last version $A_last"
awk -v f="$((10#$A_first))" -v l="$((10#$A_last))" '{v=substr($2,1,4)+0; if (v>=f && v<=l) print $2}' "$RUNDIR/list.sha256" > "$RUNDIR/pending.txt"
[ "$(grep -c '' "$RUNDIR/pending.txt")" = "$((10#$A_count))" ] || die "the number of files from $A_first to $A_last in the list is not the approved count $A_count"
WANT=$(cat "$RUNDIR/pending.txt")
tar -tf "$RUNDIR/bundle.tar" > /dev/null 2>&1 || die "the bundle is not a readable tar"
ents=$(tar -tf "$RUNDIR/bundle.tar" 2>/dev/null | sed 's#/$##')
printf '%s\n' "$ents" | grep -Evx 'supabase|supabase/migrations|supabase/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql' | head -1 | grep -q . && die "the bundle holds an entry that is not supabase/migrations/NNNN_name.sql"
tar -tvf "$RUNDIR/bundle.tar" 2>/dev/null | cut -c1 | grep -Evx '[-d]' | head -1 | grep -q . && die "the bundle holds a link or special entry"
printf '%s\n' "$ents" | sed -n 's#^supabase/migrations/##p' | LC_ALL=C sort > "$RUNDIR/names-tar.txt"
awk '{print $2}' "$RUNDIR/list.sha256" | LC_ALL=C sort > "$RUNDIR/names-list.txt"
[ -z "$(LC_ALL=C comm -23 "$RUNDIR/names-tar.txt" "$RUNDIR/names-list.txt" | head -1)" ] || die "the bundle has files that the list does not list"
[ -z "$(LC_ALL=C comm -13 "$RUNDIR/names-tar.txt" "$RUNDIR/names-list.txt" | head -1)" ] || die "the bundle is missing files that the list lists"
tar -xf "$RUNDIR/bundle.tar" -C "$PROJ" || die "could not extract the bundle"
[ -z "$(find "$PROJ" -type l | head -1)" ] || die "the extracted bundle contains a link"
[ "$(find "$PROJ" -type f | wc -l | tr -d ' ')" = "$NFILES" ] || die "the extracted bundle does not hold exactly $NFILES files"
vout=$(cd "$PROJ/supabase/migrations" && sha256sum -c "$RUNDIR/list.sha256" 2>&1) || die "an extracted migration differs from the list"
[ "$(printf '%s\n' "$vout" | grep -c ': OK$')" = "$NFILES" ] || die "the extracted migrations did not verify $NFILES files"
pf_check package PASS "bundle sha, list sha, head, $NFILES files, exactly $A_count pending $A_first..$A_last verified from a private copy"
mkdir -p "$PROJ/supabase/.temp" && printf '%s\n' v2.102.0 > "$PROJ/supabase/.temp/cli-latest" || die "cannot seed cli-latest"
# T4 (lexical gate, both modes): no approved file may weaken or remove a server-side timeout; on the pooler every file must carry its own bounded ones
python3 -I - "$PROJ/supabase/migrations" "$RUNDIR/pending.txt" "$A_connection_mode" "$A_statement_timeout_s" "$A_lock_timeout_s" "$A_idle_tx_timeout_s" <<'PYGATE' > "$RUNDIR/gate.txt" 2>&1 || { tail -n 6 "$RUNDIR/gate.txt" >&2; die "an approved file fails the timeout gate (T4). Nothing was attempted."; }
import re, sys, os
d, lst, mode = sys.argv[1], sys.argv[2], sys.argv[3]
ceil = {"statement_timeout": int(sys.argv[4]), "lock_timeout": int(sys.argv[5]), "idle_in_transaction_session_timeout": int(sys.argv[6])}
names = [l.split()[-1] for l in open(lst) if l.strip()]
name_re = re.compile(r"(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)")
ok_re = re.compile(r"set\s+(local\s+)?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\s*(?:=|to)\s*'?(\d+)\s*(ms|s|min)?'?(?![0-9a-z])")
cfg_re = re.compile(r"'(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)=(\d+)(ms|s|min)?'")
bad = 0
for n in names:
    t = open(os.path.join(d, n), encoding="utf-8", errors="replace").read().lower()
    allowed = list(ok_re.finditer(t)); covered_cfg = set()
    for m in cfg_re.finditer(t):   # a bounded setting named inside a string (e.g. a proconfig check): same bounds, never counts as `set local`
        v = int(m.group(2)); u = m.group(3) or "ms"; sec = v / 1000.0 if u == "ms" else (v if u == "s" else v * 60)
        if sec <= 0 or sec > ceil[m.group(1)]:
            print("%s: a %s of %s%s is zero or above the approved ceiling %ds" % (n, m.group(1), m.group(2), m.group(3) or "", ceil[m.group(1)])); bad += 1
        covered_cfg.add(m.start(1))
    covered = set()
    for m in allowed:
        v = int(m.group(3)); u = m.group(4) or "ms"
        sec = v / 1000.0 if u == "ms" else (v if u == "s" else v * 60)
        if sec <= 0 or sec > ceil[m.group(2)]:
            print("%s: a %s of %s%s is zero or above the approved ceiling %ds" % (n, m.group(2), m.group(3), m.group(4) or "", ceil[m.group(2)])); bad += 1
        covered.add(m.start(2))
    for m in name_re.finditer(t):
        if m.start(1) not in covered and m.start(1) not in covered_cfg:
            print("%s: mentions %s other than as a bounded `set local`" % (n, m.group(1))); bad += 1
    if mode == "pooler":
        kinds = {m.group(2) for m in allowed if m.group(1)}
        for need in ("statement_timeout", "lock_timeout"):
            if need not in kinds:
                print("%s: the pooler path needs `set local %s` in every approved file" % (n, need)); bad += 1
print("timeout gate: %d files, %d problems (mode %s)" % (len(names), bad, mode))
sys.exit(1 if bad else 0)
PYGATE
pf_check timeout-gate PASS "no approved file weakens a server-side timeout (mode $A_connection_mode)"
RUN="$RUNDIR/run.txt"
{ echo "release apply run started $(utcnow) approval $APPROVAL_ID"; echo "script sha256 ${HONE_RELEASE_SCRIPT_SHA:-unknown}"; echo "head $A_head bundle $A_bundle_sha list $A_list_sha"; echo "versions $A_first..$A_last count $A_count; files $NFILES"; echo "bound to PR $A_pr head $A_pr_head receipt sha256 $A_receipt_sha"; echo "window $A_window_start .. $A_window_end; recovery basis $A_recovery_basis stamp $A_recovery_stamp waiver $A_waiver_id; path $A_autonomy; quiet-db mode $A_quiet_db_mode"; echo "s0a sha256 $A_s0a_sha at $A_s0a_at; min span $A_min_span_days days"; echo "connection mode $A_connection_mode host $A_db_host; TLS verify-full against the pinned CA sha256 $CA_SHA"; echo "timeouts (server side): $A_timeout_control statement ${A_statement_timeout_s}s lock ${A_lock_timeout_s}s idle-in-tx ${A_idle_tx_timeout_s}s; client wall clock ${A_max_push_seconds}s then KILL -> UNKNOWN-KILLED"; echo "target (no password): $A_target_url"; echo "recovery attestation (root-written): $A_recovery_attestation"; } > "$RUN"

run_cli() { # run_cli LOG SECONDS args...   the password and the TLS settings are in the one child's environment only.
  # On overrun the CLI is KILLED (TERM, then KILL after 10 s): the client connection closes, the server aborts the open transaction, and the caller maps the
  # result to UNKNOWN. A kill never means PASS and never leads to a retry.
  local lf="$1" maxs="$2"; shift 2
  local pf="$RUNDIR/cli.pid"; rm -f "$pf"
  ( cd "$PROJ" && PGPASSWORD="$PW" PGSSLMODE=verify-full PGSSLROOTCERT="$CA" SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
      setsid -w sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pf" "$BIN" "$@" ) </dev/null >"$lf" 2>&1 &
  local cpid=$! waited=0 kp
  while kill -0 "$cpid" 2>/dev/null; do
    if [ "$waited" -ge "$maxs" ]; then
      kp=$(cat "$pf" 2>/dev/null)
      if printf '%s' "$kp" | grep -Eq '^[0-9]+$'; then
        kill -TERM "$kp" 2>/dev/null
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$kp" 2>/dev/null || break; sleep 1; done
        kill -0 "$kp" 2>/dev/null && kill -KILL "$kp" 2>/dev/null
      fi
      wait "$cpid" 2>/dev/null
      return 124
    fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$cpid"
}
scan_log() { if grep -qiE 'login role|initialising|unban|network.?ban|reset.*password|api\.supabase\.com' "$1"; then
  [ "$STAGE" != push ] || write_state FAILED "log-scan-hit"
  [ "$STAGE" != push ] || die "the CLI reported a login-role / ban / password / Management API path DURING the push. The push may already have applied: do the read-back before anything else. Do not retry."
  die "the CLI reported a login-role / ban / password / Management API path. Stopped; REPORT it. Do not retry."; fi; }

if [ "$ACTION" = apply ]; then # the approver binds to the reviewed GO/NO-GO package: root wrote GONOGO-BOUND after reading state/GONOGO.json
  GB=/etc/hone-release/GONOGO-BOUND
  [ -f "$GB" ] && [ ! -L "$GB" ] && [ "$(stat -c %u "$GB")" = 0 ] && [ $(( 8#$(stat -c %a "$GB") & 8#022 )) = 0 ] || die "no root-written GONOGO-BOUND: run the preflight action, have the approver read the GO/NO-GO package and bind it with bind-gonogo.sh. Nothing was attempted."
  gb() { sed -n "s/^$1=//p" "$GB" | head -1; }
  [ "$(gb approval_id)" = "$APPROVAL_ID" ] || die "the GO/NO-GO binding is for another approval"
  bat=$(epoch "$(gb bound_at)"); [ -n "$bat" ] && [ $((now_s - bat)) -le 1800 ] && [ "$bat" -le "$now_s" ] || die "the GO/NO-GO binding is older than 30 minutes: run preflight again and re-bind"
  GNG="$STATE/GONOGO.json"; [ -f "$GNG" ] && [ ! -L "$GNG" ] || die "no GONOGO.json in the release state"
  GNG_SHA=$(python3 -I - "$GNG" "$APPROVAL" <<'PYV'
import json, sys, hashlib
j = json.load(open(sys.argv[1])); sh = j.pop("sha256", "")
canon = json.dumps(j, sort_keys=True, separators=(",", ":"))
ok = hashlib.sha256(canon.encode()).hexdigest() == sh and j.get("verdict") == "GO" and j.get("approval_sha256") == hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
print(sh if ok else "BAD")
PYV
)
  [ "$GNG_SHA" != BAD ] && [ "$GNG_SHA" = "$(gb gonogo_sha)" ] || die "GONOGO.json is not the bound package (its sha256, verdict GO or the approval it is about differ from the binding)"
fi
# ---- preflight stops here: the reads that need the READ token, then the reviewable GO/NO-GO package
if [ "$ACTION" = preflight ]; then
  STAGE=preflight
  PFW="$RUNDIR/pf"; mkdir -p "$PFW"; REF=$A_project_ref
  pjson() { python3 -I -c 'import json,sys; j=json.load(sys.stdin); r=j if isinstance(j,list) else j.get("rows",j.get("result",[])); print(" ".join(str(r[0][k]) for k in sys.argv[1:]))' "$@"; }
  h=$(mgmt history 2> "$PFW/err.txt" | pjson n mx) || die "the history read failed (preflight): NO-GO"
  hn=${h%% *}; hx=${h#* }
  if [ "$hn" = "$A_history_before" ] && [ -n "$hx" ] && [ "$hx" \< "$A_first" ]; then pf_check history PASS "history rows $hn (approved $A_history_before), max version $hx is below the first approved version $A_first: no drift"
  else pf_check history FAIL "history rows $hn (approved $A_history_before), max $hx, first approved $A_first: DRIFT"; fi
  b=$(mgmt busy 2> "$PFW/err.txt" | pjson busy) || die "the drain read failed (preflight): NO-GO"
  if [ "$b" -le "$A_drain_max_busy" ]; then pf_check drain-read PASS "$b busy client sessions (allowed $A_drain_max_busy)"; else pf_check drain-read FAIL "$b busy client sessions exceed the allowed $A_drain_max_busy"; fi
  TOKEN=""; unset TOKEN
  gonogo_write GO "all checks recorded"
  grep -q '|FAIL|' "$PFC" && exit 1
  exit 0
fi

# ---- ONE dry run
STAGE=dry-run
DRY="$LOGS/dry-run.log"; rc=0
# the approval is consumed at the FIRST dry-run attempt, and a state that only root clears is written before the first login
mkdir "$STATE/consumed/$APPROVAL_ID" 2>/dev/null || die "approval $APPROVAL_ID was consumed by another run. Nothing was attempted."
receipt_add bound "gonogo $GNG_SHA; approval $(sha "$APPROVAL"); bundle $A_bundle_sha; list $A_list_sha; head $A_head; pr $A_pr; receipt $A_receipt_sha; path $A_autonomy; mode $A_connection_mode"
write_state DRYRUN-STARTED || die "cannot write the DRYRUN-STARTED state. Nothing was attempted."
# FX2/FX4: the first login. Over the SAME connection form the push will use (direct + verify-full + startup options), ONE read-back statement returns the history
# (rows, max), the busy client sessions and the four timeout settings the endpoint actually applied. Anything other than the approval is a refusal BEFORE the dry run.
STAGE=precheck
PRE="$LOGS/precheck.log"; rc=0
SQLPRE="select (select count(*) from supabase_migrations.schema_migrations)::int as n, (select coalesce(max(version), '') from supabase_migrations.schema_migrations) as mx, (select count(*)::int from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() and state <> 'idle' and datname = current_database()) as busy, (select setting from pg_settings where name = 'statement_timeout') as st, (select setting from pg_settings where name = 'lock_timeout') as lt, (select setting from pg_settings where name = 'idle_in_transaction_session_timeout') as it, (select setting from pg_settings where name = 'client_connection_check_interval') as cc"
run_cli "$PRE" 60 db query --db-url "$A_target_url" -o json "$SQLPRE" || rc=$?
if [ "$rc" = 124 ]; then write_state FAILED-DRYRUN "precheck-killed-after-60s"; die "the connection-phase read-back did not finish in 60 s; the CLI was KILLED. Nothing was applied; state FAILED-DRYRUN until root clears it."; fi
scan_log "$PRE"
if [ "$rc" != 0 ]; then
  tail -n 6 "$PRE" | mask >&2
  if is_auth_failure "$PRE"; then write_state FAILED-LOGIN precheck; die "authentication failed at the first login (connection-phase read-back). NOTHING was applied; state FAILED-LOGIN blocks every further run until root clears it."; fi
  write_state FAILED-DRYRUN "precheck-exit-$rc"; die "the connection-phase read-back failed (exit $rc). NOTHING was applied; the state stands until root clears it."
fi
pre=$(python3 -I - "$PRE" "$A_connection_mode" "$A_history_before" "$A_first" "$A_drain_max_busy" "$((A_statement_timeout_s * 1000))" "$((A_lock_timeout_s * 1000))" "$((A_idle_tx_timeout_s * 1000))" <<'PYP'
import json, re, sys
t = open(sys.argv[1], errors="replace").read(); m = re.search(r"(\[.*\])", t, re.S)
try: r = json.loads(m.group(1)); r = r[0]
except Exception: print("BAD:the read-back answer could not be parsed"); sys.exit(0)
mode, hb, first, maxbusy = sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
want = [int(x) for x in sys.argv[6:9]] + [5000]
why = []
if int(r["n"]) != hb or not r["mx"] or not str(r["mx"]) < first: why.append("history drift: %s rows (approved %d), max %s, first approved %s" % (r["n"], hb, r["mx"], first))
if int(r["busy"]) > maxbusy: why.append("%s busy client sessions exceed the allowed %d" % (r["busy"], maxbusy))
got = [int(r["st"]), int(r["lt"]), int(r["it"]), int(r["cc"])]
if mode == "direct" and got != want: why.append("the endpoint applied statement/lock/idle-in-tx/connection-check ms %s, the approval says %s (startup options not honoured)" % (got, want))
print("BAD:" + "; ".join(why) if why else "OK:history %s rows max %s; busy %s; settings ms %s%s" % (r["n"], r["mx"], r["busy"], got, "" if mode == "direct" else " (pooler: startup options do not apply, per-file set local is the control)"))
PYP
)
case "$pre" in OK:*) echo "connection-phase read-back ${pre#OK:}" >> "$RUN"; receipt_add precheck "${pre#OK:}" ;; *) write_state FAILED-DRYRUN "precheck-mismatch"; receipt_add precheck-refused "${pre#BAD:}"; die "the connection-phase read-back refuses: ${pre#BAD:}. NOTHING was applied; the state stands until root clears it." ;; esac
STAGE=dry-run
run_cli "$DRY" 120 db push --db-url "$A_target_url" --dry-run || rc=$?
if [ "$rc" = 124 ]; then write_state FAILED-DRYRUN "killed-after-120s"; die "the dry run did not finish in 120 s; the CLI was KILLED (client wall clock). A dry run writes nothing. State FAILED-DRYRUN stands until root clears it. Nothing was pushed."; fi
echo "dry run finished $(utcnow) exit $rc" >> "$RUN"
scan_log "$DRY"
if [ "$rc" != 0 ]; then
  tail -n 6 "$DRY" | mask >&2
  if is_auth_failure "$DRY"; then write_state FAILED-LOGIN dry-run; echo "An authentication failure was recorded in the state: no further run until root clears it." >&2; fi
  is_auth_failure "$DRY" || write_state FAILED-DRYRUN "exit-$rc"
  die "the dry run failed (exit $rc). NOTHING was applied. The approval is consumed and the state ($(cut -d' ' -f1 "$STATE/APPLY-STATE")) stands until root clears it: no retry from this script."
fi
grep -qx 'DRY RUN: migrations will \*not\* be pushed to the database.' "$DRY" || die "the dry run did not announce itself as a dry run"
grep -qx 'Would push these migrations:' "$DRY" || die "the dry run did not print 'Would push these migrations:'"
grep -q 'Applying migration' "$DRY" && die "the dry run printed 'Applying migration'"
got=$(LC_ALL=C grep -E '^ *[^ ]+ +[0-9]{4}_[A-Za-z0-9_]+\.sql *$' "$DRY" | LC_ALL=C sed -E 's/^.* ([0-9]{4}_[A-Za-z0-9_]+\.sql) *$/\1/')
[ "$got" = "$WANT" ] || die "the dry run does not list exactly the approved versions $A_first..$A_last in order ($(printf '%s\n' "$got" | grep -c .) listed, $A_count approved). NOTHING was applied."
echo "dry run listed exactly the approved $A_count versions in order" >> "$RUN"
receipt_add dry-run "log sha256 $(sha "$DRY"); exactly $A_count approved versions listed in order"

# ---- ONE push: consume the approval, write the durable IN-FLIGHT marker, then push
STAGE=push
# the gates are checked again immediately before the push (the dry run and the intake take time)
now_s=$(epoch "$(utcnow)")
[ "$now_s" -lt "$ex_s" ] || die "the approval expired during the dry run. NOTHING was applied."
[ "$now_s" -lt "$we_s" ] && [ $(( (we_s - now_s) / 60 )) -ge 75 ] || die "fewer than 75 minutes of the approved window remain before the push. NOTHING was applied."
if [ "$A_recovery_basis" = row4 ]; then check_recovery 1800; fi
write_state IN-FLIGHT || die "cannot write the IN-FLIGHT marker. NOTHING was applied."
echo "push started $(utcnow)" >> "$RUN"
PUSH="$LOGS/push.log"; rc=0
trap '' INT TERM HUP
run_cli "$PUSH" "$A_max_push_seconds" db push --db-url "$A_target_url" --yes || rc=$?
if [ "$rc" = 124 ]; then
  PW=""; unset PW
  write_state UNKNOWN-KILLED "after-${A_max_push_seconds}s"
  receipt_add push-unknown-killed "killed at the client wall clock after ${A_max_push_seconds}s; log sha256 $(sha "$PUSH"); outcome UNKNOWN"
  echo "push killed at the client wall clock $(utcnow)" >> "$RUN"
  tail -n 6 "$PUSH" | mask >&2
  die "the push did not finish in ${A_max_push_seconds} s; the CLI was KILLED (client wall clock). The outcome is UNKNOWN: files that completed are applied; the open file's transaction is rolled back when the server notices the closed connection (on the direct form client_connection_check_interval makes it abort the running statement within seconds; on the pooler the statement runs until its own per-file statement_timeout). This is NOT a pass and nothing is retried. Run the read-only reconcile action; only root clears the state UNKNOWN-KILLED."
fi
echo "push finished $(utcnow) exit $rc" >> "$RUN"
PW=""; unset PW
fail() {
  tail -n 12 "$PUSH" | mask >&2
  if [ "$rc" != 0 ] && is_auth_failure "$PUSH"; then write_state FAILED-LOGIN push; else write_state FAILED "push-exit-$rc"; fi
  grep -qE '57014|canceling statement due to user request' "$PUSH" && echo "A statement was cancelled (SQLSTATE 57014): follow the D3 operator runbook, section 5, After a cancel." >&2
  die "$1 The push may already have applied: do the read-back before anything else. Do NOT rerun. State left for root."
}
scan_log "$PUSH"
napp=$(grep -c '^Applying migration ' "$PUSH")
[ "$rc" = 0 ] || fail "the push failed (exit $rc)."
[ "$napp" = "$((10#$A_count))" ] || fail "the push logged $napp 'Applying migration' lines, expected $A_count."
applied=$(LC_ALL=C grep -E '^Applying migration [0-9]{4}_[A-Za-z0-9_]+\.sql\.\.\.$' "$PUSH" | LC_ALL=C sed -E 's/^Applying migration ([0-9]{4}_[A-Za-z0-9_]+\.sql)\.\.\.$/\1/')
[ "$applied" = "$WANT" ] || fail "the applied migrations are not exactly the approved versions in order."
grep -qx 'Finished supabase db push.' "$PUSH" || fail "the 'Finished supabase db push.' line is missing."
write_state APPLIED-UNVERIFIED "versions-$A_first-$A_last"
receipt_add push "log sha256 $(sha "$PUSH"); $A_count Applying migration lines in order; finish line present; exit 0; state APPLIED-UNVERIFIED until verify"
{ echo "APPLIED $(utcnow): $A_count migrations $A_first..$A_last in order, finish line present, exit 0"; echo "dry-run log sha256 $(sha "$DRY")"; echo "push log sha256 $(sha "$PUSH")"; } >> "$RUN"
mkdir -p "$LOGROOT/$APPROVAL_ID" && cp "$RUN" "$LOGROOT/$APPROVAL_ID/run.txt" && cp "$DRY" "$PUSH" "$LOGROOT/$APPROVAL_ID/" 2>/dev/null
echo "APPLIED: exactly $A_count migrations ($A_first .. $A_last) in order; 'Finished supabase db push.'; exit 0. Approval $APPROVAL_ID is consumed." >&2
echo "NEXT: run the verify action (history read-back, stage checks, smoke, receipt). The state stays APPLIED-UNVERIFIED until it passes; a mismatch stops the release." >&2
exit 0
