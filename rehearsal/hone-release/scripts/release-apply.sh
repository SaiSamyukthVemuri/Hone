#!/bin/bash
# hone-release action: apply. Linux, non-interactive. Run ONLY by the launcher, as hone-release, with the database password on
# fd 3 and a sanitised environment. Derived from the reviewed s1-apply.sh 2dfd3354 (see DELTAS.md for every difference).
# It applies ONE package that root has approved in /etc/hone-release/APPROVED-PACKAGE: the bundle sha, the list sha and the
# head (the commit id in the tar's own header) must equal the approval, which also binds the PR number, the PR head and the release
# receipt sha, the window, the recovery basis, the timeout residual and the exact target. The approval must be unexpired (at most
# 60 minutes after approved_at) and is CONSUMED at the first dry-run attempt.
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
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
MAXBYTES=67108864

PW=""
STAGE=start
RUNDIR=""
die() { echo "STOP: $*" >&2; exit 1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sha() { sha256sum -- "$1" | cut -d' ' -f1; }
epoch() { date -u -d "$1" +%s 2>/dev/null; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#([Uu]ser|[Hh]ost|[Hh]ostaddr|[Dd]bname)=[^ ,)]*#\1=<masked>#g' -e 's#([Uu]ser|[Rr]ole) "[^"]*"#\1 <masked>#g' -e 's#[A-Za-z0-9.-]*\.supabase\.com[:0-9]*#<host>#g'; }
is_auth_failure() { grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found' "$1"; }
write_state() { # write_state WORD [detail]: durable (fsync) replacement of the state marker
  printf '%s %s %s\n' "$1" "${APPROVAL_ID:-none}" "$(utcnow)${2:+ $2}" > "$STATE/APPLY-STATE.tmp" && sync "$STATE/APPLY-STATE.tmp" && mv -f "$STATE/APPLY-STATE.tmp" "$STATE/APPLY-STATE" && sync "$STATE" 2>/dev/null
}
trap 'PW=""; unset PW' EXIT
trap 'echo >&2; echo "STOP: signal received at stage $STAGE. A running push is NOT stopped by this signal (the only way to stop a statement is the watchdog). If the stage was the push, the state is IN-FLIGHT and blocks the next run until root clears it: read back the migration history first." >&2' INT TERM HUP

[ "${HONE_RELEASE_ACTION:-}" = apply ] || die "not started by the launcher for the apply action"
[ "$(uname -s)" = Linux ] || die "not Linux"
for t in flock setsid sha256sum tar awk sed; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done

# ---- the password: fd 3 only, never argv or environment
{ IFS= read -r PW <&3; } 2>/dev/null || die "no database password on fd 3"
exec 3<&-
[ -n "$PW" ] || die "empty database password; nothing was attempted"
env | grep -E '^(PG|SUPABASE_|DATABASE_URL|GITHUB_TOKEN|GH_TOKEN|HTTPS?_PROXY|ALL_PROXY|NODE_|BASH_ENV|ENV|LD_)' >/dev/null && die "the environment holds a variable that must not be there (names withheld)"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch"

# ---- state and the single release lock
mkdir -p "$STATE/consumed" "$WORKROOT" "$LOGROOT" 2>/dev/null
exec 9>"$STATE/lock" || die "cannot open the lock file"
flock -n 9 || die "another release run holds the lock; nothing was attempted"
if [ -e "$STATE/APPLY-STATE" ]; then
  st=$(cat "$STATE/APPLY-STATE")
  case "$st" in
    APPLIED\ *) ;;
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
declare_keys="approval_id approved_at head bundle_sha list_sha pr pr_head receipt_sha project_ref target_url pooler_host first last count expires_at window_start window_end recovery_basis recovery_point waiver_id max_push_seconds timeout_residual recovery_attestation watchdog"
seen=" "
while IFS= read -r l || [ -n "$l" ]; do
  case "$l" in ''|'#'*) continue ;; esac
  printf '%s' "$l" | LC_ALL=C grep -Eq '^[a-z_]+=[A-Za-z0-9 ._:/@?&=,;()+-]{1,200}$' || die "APPROVED-PACKAGE has a malformed line"
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
case "$A_recovery_basis" in
  row4)
    printf '%s' "$A_recovery_point" | LC_ALL=C grep -Eq "^$iso\$" || die "recovery_basis=row4 needs a recovery_point in UTC"
    rp_s=$(epoch "$A_recovery_point"); [ -n "$rp_s" ] || die "cannot read recovery_point"
    [ "$rp_s" -le "$now_s" ] || die "recovery_point is in the future"
    [ "$rp_s" -ge "$ws_s" ] || die "recovery_point is before the window start"
    [ $((now_s - rp_s)) -le 2700 ] || die "recovery_point is older than 45 minutes: run the row-4 step again and re-approve"
    [ "$A_waiver_id" = none ] || die "recovery_basis=row4 must have waiver_id=none" ;;
  waiver)
    printf '%s' "$A_waiver_id" | grep -Eq '^WAIVER-[0-9]{8}-[0-9]{1,3}$' || die "recovery_basis=waiver needs a waiver_id of the form WAIVER-YYYYMMDD-N, typed from the recorded waiver"
    [ "$A_recovery_point" = none ] || die "recovery_basis=waiver must have recovery_point=none" ;;
  *) die "recovery_basis must be row4 or waiver (the idle-path result is not accepted by this script)" ;;
esac
[ "$A_watchdog" = waived-by-approver ] || die "watchdog readiness is not enforced by this script; the approval must say watchdog=waived-by-approver (recorded as such)"
[ "$A_timeout_residual" = accepted-server-limit-only ] || die "the approval must say timeout_residual=accepted-server-limit-only: the pooler ignores timeout options, the files carry their own lock_timeout, and no other bound exists (accepted residual)"
printf '%s' "$A_max_push_seconds" | grep -Eq '^[0-9]{2,4}$' && [ "$A_max_push_seconds" -ge 10 ] && [ "$A_max_push_seconds" -le 1800 ] || die "max_push_seconds must be 10..1800"
# the exact target: the pinned pooler host:5432, user postgres.<ref>, and ONE of two exact TLS forms
printf '%s' "$A_pooler_host" | grep -Eq '^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com:5432$' || die "pooler_host is not a Supabase session pooler host on port 5432"
want_q="sslmode=require"   # NOTE: supabase-go 2.102.0 PARSES sslmode/sslrootcert but then rebuilds the connection URL (ToPostgresURL) without them, so TLS is used but the server certificate is NOT verified (CI probe); the control is the exact pooler host below (accepted residual)
want_url="postgresql://postgres.$A_project_ref@$A_pooler_host/postgres?$want_q"
[ "$A_target_url" = "$want_url" ] || die "target_url is not exactly the approved form for this project and pooler host (no other host, port, user or parameter is accepted)"
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
mkdir -p "$PROJ/supabase/.temp" && printf '%s\n' v2.102.0 > "$PROJ/supabase/.temp/cli-latest" || die "cannot seed cli-latest"
RUN="$RUNDIR/run.txt"
{ echo "release apply run started $(utcnow) approval $APPROVAL_ID"; echo "script sha256 ${HONE_RELEASE_SCRIPT_SHA:-unknown}"; echo "head $A_head bundle $A_bundle_sha list $A_list_sha"; echo "versions $A_first..$A_last count $A_count; files $NFILES"; echo "bound to PR $A_pr head $A_pr_head receipt sha256 $A_receipt_sha"; echo "window $A_window_start .. $A_window_end; recovery basis $A_recovery_basis point $A_recovery_point waiver $A_waiver_id"; echo "tls form: $want_q (host $A_pooler_host)"; echo "timeout residual: $A_timeout_residual; client-side bounded wait $A_max_push_seconds s"; echo "target (no password): $A_target_url"; echo "recovery attestation (root-written, NOT verified here): $A_recovery_attestation"; echo "watchdog: $A_watchdog (readiness NOT enforced by this script)"; } > "$RUN"

run_cli() { # run_cli LOG SECONDS args...   the password is in the one child's environment only; the CLI is NEVER killed on overrun
  local lf="$1" maxs="$2"; shift 2
  ( cd "$PROJ" && PGPASSWORD="$PW" SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 setsid -w "$BIN" "$@" ) </dev/null >"$lf" 2>&1 &
  local cpid=$! waited=0
  while kill -0 "$cpid" 2>/dev/null; do
    [ "$waited" -lt "$maxs" ] || return 124
    sleep 1; waited=$((waited + 1))
  done
  wait "$cpid"
}
scan_log() { if grep -qiE 'login role|initialising|unban|network.?ban|reset.*password|api\.supabase\.com' "$1"; then
  [ "$STAGE" != push ] || write_state FAILED "log-scan-hit"
  [ "$STAGE" != push ] || die "the CLI reported a login-role / ban / password / Management API path DURING the push. The push may already have applied: do the read-back before anything else. Do not retry."
  die "the CLI reported a login-role / ban / password / Management API path. Stopped; REPORT it. Do not retry."; fi; }

# ---- ONE dry run
STAGE=dry-run
DRY="$LOGS/dry-run.log"; rc=0
# the approval is consumed at the FIRST dry-run attempt, and a state that only root clears is written before the first login
mkdir "$STATE/consumed/$APPROVAL_ID" 2>/dev/null || die "approval $APPROVAL_ID was consumed by another run. Nothing was attempted."
write_state DRYRUN-STARTED || die "cannot write the DRYRUN-STARTED state. Nothing was attempted."
run_cli "$DRY" 120 db push --db-url "$A_target_url" --dry-run || rc=$?
[ "$rc" != 124 ] || die "the dry run is still running after 120 s; this script stopped waiting and did NOT stop the CLI. State DRYRUN-STARTED stands until root clears it. Nothing was pushed by this script."
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

# ---- ONE push: consume the approval, write the durable IN-FLIGHT marker, then push
STAGE=push
# the gates are checked again immediately before the push (the dry run and the intake take time)
now_s=$(epoch "$(utcnow)")
[ "$now_s" -lt "$ex_s" ] || die "the approval expired during the dry run. NOTHING was applied."
[ "$now_s" -lt "$we_s" ] && [ $(( (we_s - now_s) / 60 )) -ge 75 ] || die "fewer than 75 minutes of the approved window remain before the push. NOTHING was applied."
if [ "$A_recovery_basis" = row4 ]; then [ $((now_s - rp_s)) -le 3600 ] || die "recovery_point is now older than 60 minutes. NOTHING was applied."; fi
write_state IN-FLIGHT || die "cannot write the IN-FLIGHT marker. NOTHING was applied."
echo "push started $(utcnow)" >> "$RUN"
PUSH="$LOGS/push.log"; rc=0
trap '' INT TERM HUP
run_cli "$PUSH" "$A_max_push_seconds" db push --db-url "$A_target_url" --yes || rc=$?
if [ "$rc" = 124 ]; then
  PW=""; unset PW
  write_state IN-FLIGHT-OVERDUE "after-${A_max_push_seconds}s"
  echo "push overdue $(utcnow)" >> "$RUN"
  tail -n 6 "$PUSH" | mask >&2
  die "the push is still running after ${A_max_push_seconds} s. This script stopped WAITING; it did not stop the CLI (the only way to stop a statement is the watchdog or the database's own limit: the accepted residual). State IN-FLIGHT-OVERDUE: read back the migration history before anything else. Only root clears the state."
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
write_state APPLIED "versions-$A_first-$A_last"
{ echo "APPLIED $(utcnow): $A_count migrations $A_first..$A_last in order, finish line present, exit 0"; echo "dry-run log sha256 $(sha "$DRY")"; echo "push log sha256 $(sha "$PUSH")"; } >> "$RUN"
mkdir -p "$LOGROOT/$APPROVAL_ID" && cp "$RUN" "$LOGROOT/$APPROVAL_ID/run.txt" && cp "$DRY" "$PUSH" "$LOGROOT/$APPROVAL_ID/" 2>/dev/null
echo "APPLIED: exactly $A_count migrations ($A_first .. $A_last) in order; 'Finished supabase db push.'; exit 0. Approval $APPROVAL_ID is consumed." >&2
echo "NEXT (read back before anything else): the migration history and the post-apply checks." >&2
exit 0
