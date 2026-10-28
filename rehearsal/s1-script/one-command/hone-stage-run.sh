#!/bin/bash
# REHEARSAL - NEVER MERGE. Hone ONE-COMMAND STAGE RUNNER (stage 0248): one entry point on Sam's Mac, production credentials stay off the VPS.
#   show the plan and its sha256 -> approved or decline -> credentials typed once, hidden -> the runner collects the values, verifies recovery
#   readiness, waits within bounded limits, applies, restores the temporary setting and verifies the outcome -> ONE result block.
# It runs the PINNED, UNMODIFIED reviewed scripts (pitr-backups, window-s0a-0248, window-row4, d3-watchdog, s1-apply-0248, window-s1read-0248)
# through a pty (phase.exp): their prompts are answered from the plan and from machine captures, never typed by a person. Every pin is checked
# before the approval prompt AND again after it. No heartbeat, no named restore point, no provider write other than the ONE role setting below,
# and that setting is a NEW route that needs its own approval sentence (printed in the plan, generated from the plan sha256).
# Fail-closed: the first failure stops. No retries. An authentication failure is a STOP.
set -u
umask 077
#CONST-BEGIN
ROOT="$HOME/hone-s1"
REF=alhhybgqdmcdyzpybykj
POOLER=aws-1-us-east-1.pooler.supabase.com
PLATFORM_CHECK=1
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
WD_SHA=1011530ffdfaddde0bb5ff54a0f0abcd19da9cf13456718f2efd9ab21f11a885
MIN_REMAIN_START_MIN=150
POLL_S=60
WAIT_LIMIT_S=1500
HB_SHA=f0db8978c0e80d47ef966cac09fd97423422ade0b817356791452908119ca523
MAX_ATTEMPTS=2
PINS='
85407d0b01d11497161c1c9d0374751ecaec80faed9609f2d4f073d71fe49413  pitr-status/pitr-backups.sh
0fd4fbe4236ff2688c7f0ea66ee9229bd6a7f60390a10ba114e88e80a8faa882  window-reads/window-row4.sh
234eb726171b4d527ee31f0ebf185d937c17715856012f4c050626d6a69b21a4  window-reads-0248/window-s0a-0248.sh
a31e048b98ccef87955425d60d32c28587bb641d884b804faf8dc6aaab403ec9  s1-apply-0248/s1-apply-0248.sh
91bbee68476e92d6bad0529a11d43c26651420f00153f4c2205a2715b7042c72  s1-apply-0248/s1-reconcile-0248.sh
6c96ff3b78bc63985003fc89771643768e9aca4121fb28e10d2e2ea9ca85cfd6  window-reads-s1-0248/window-s1read-0248.sh
1011530ffdfaddde0bb5ff54a0f0abcd19da9cf13456718f2efd9ab21f11a885  d3-watchdog.zsh
dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b  supabase-cli/supabase-go
'
#CONST-END
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP=$HERE/phase.exp
CUR_PH=""; TOK=""; PW=""; OUTCOME=""; REASON=""; RESTORE_NOTE=""; ROLE_ALTERED=0; ORIG_ROLECONF=""; RUN=""; APPLY_TYPED=0; ROLE_STATE=""
die_early() { REASON="$*"; echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
utc_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq "^$iso\$"; }
text_ok() { [ -n "$1" ] && [ "${#1}" -le 200 ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9 ._:/@+,;()=#-]+$'; }
PITR=$ROOT/pitr-status/pitr-backups.sh
ROW4=$ROOT/window-reads/window-row4.sh
S0A=$ROOT/window-reads-0248/window-s0a-0248.sh
APPLY=$ROOT/s1-apply-0248/s1-apply-0248.sh
S1READ=$ROOT/window-reads-s1-0248/window-s1read-0248.sh
WD=$ROOT/d3-watchdog.zsh
GO=$ROOT/supabase-cli/supabase-go
STATEF=$ROOT/s1-apply/APPLY-STATE
OC=$ROOT/one-command
ROLE_STATE=$OC/ROLE-STATE

verify_pins() { # every pinned file, by FULL sha256, relative to ROOT
  local l n=0 want path got
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    set -- $l; want=$1; path=$2
    [ -f "$ROOT/$path" ] && [ ! -L "$ROOT/$path" ] || { echo "pinned file missing: $path" >&2; return 1; }
    got=$(sha "$ROOT/$path"); [ "$got" = "$want" ] || { echo "pin mismatch: $path" >&2; return 1; }
    n=$((n+1))
  done <<EOF
$PINS
EOF
  [ "$n" -ge 8 ] || return 1
}

# ---- the role setting (the ONLY write the runner makes), restored and verified on EVERY exit path ----
sql_cli() { # sql_cli "SQL": one pinned-CLI statement through the pooler; the password is in the child's environment only
  local d; d=$OC/q; mkdir -p "$d"
  ( cd "$d" && PGPASSWORD="$PW" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 env -u GITHUB_TOKEN -u GH_TOKEN \
      "$GO" --agent no db query --db-url "postgresql://postgres.$REF@$POOLER:5432/postgres?sslmode=require" -o json "$1" ) </dev/null >"$RUN/sql.out" 2>"$RUN/sql.err"
}
sql_run() { # sql_run "SQL" -> prints the first scalar of the result
  sql_cli "$1" || return 1
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=Array.isArray(j)?j:(j.rows||[]);const o=r[0];console.log(o===undefined?"":String(Object.values(o)[0]===null?"":Object.values(o)[0]))' "$RUN/sql.out"
}
rolconf() { sql_run "select coalesce(array_to_string(rolconfig, ','), '') from pg_roles where rolname = 'postgres'"; }
restore_role() { # restore + verify; the credentials are still held here (cleared AFTER this)
  [ "$ROLE_ALTERED" = 1 ] || return 0
  local cur
  if printf '%s' "$ORIG_ROLECONF" | grep -q 'statement_timeout='; then
    local ov; ov=$(printf '%s' "$ORIG_ROLECONF" | tr ',' '\n' | sed -n 's/^statement_timeout=//p' | head -1)
    sql_cli "alter role postgres set statement_timeout = '$ov'" >/dev/null 2>&1
  else
    sql_cli "alter role postgres reset statement_timeout" >/dev/null 2>&1
  fi
  cur=$(rolconf 2>/dev/null) || cur="UNREADABLE"
  if [ "$cur" = "$ORIG_ROLECONF" ]; then
    ROLE_ALTERED=0; RESTORE_NOTE="role setting restored and read back ($(printf '%s' "$ORIG_ROLECONF" | sed 's/^$/no role-level setting/'))"
    mv "$ROLE_STATE" "$ROLE_STATE.restored.$(utcnow)" 2>/dev/null
  else
    RESTORE_NOTE="SETTING NOT RESTORED: the role configuration reads '$cur', the captured original was '$ORIG_ROLECONF'. Restore it by hand before anything else (record: $ROLE_STATE)"
  fi
}
result_block() {
  local txt
  txt="================================================================================
RESULT: $OUTCOME"
  [ -n "$REASON" ] && txt="$txt
reason: $REASON"
  [ -n "$RESTORE_NOTE" ] && txt="$txt
role setting: $RESTORE_NOTE"
  [ -n "$RUN" ] && txt="$txt
evidence: $RUN (plan, phase transcripts masked, phase results)"
  case "$OUTCOME" in
    UNKNOWN*) txt="$txt
next: do NOT rerun the push. Run window-s1read-0248.sh (read-only), then s1-reconcile-0248.sh; the marker $STATEF stays until then." ;;
  esac
  txt="$txt
================================================================================"
  printf '%s\n' "$txt" >&2
  [ -n "$RUN" ] && [ -d "$RUN" ] && printf '%s\n' "$txt" > "$RUN/RESULT.txt" 2>/dev/null
  return 0
}
on_exit() {
  local rc=$?
  trap - EXIT
  restore_role
  TOK=""; PW=""
  if [ -z "$OUTCOME" ]; then OUTCOME="NOT APPLIED"; REASON="${REASON:-the runner exited early (status $rc)}"; fi
  # a marker left by THIS run (the runner refuses to start when one exists) means the apply script reached the push: never "NOT APPLIED", whatever stopped us
  case "$OUTCOME" in APPLIED+VERIFIED*) ;; *) if [ -e "$STATEF" ] || [ -L "$STATEF" ]; then OUTCOME="UNKNOWN -> reconcile"; fi ;; esac
  case "$RESTORE_NOTE" in "SETTING NOT RESTORED"*) OUTCOME="$OUTCOME; SETTING NOT RESTORED" ;; esac
  result_block
  exit $rc
}
trap on_exit EXIT
on_signal() { REASON="interrupted by $1"; if [ -n "$CUR_PH" ]; then kill -TERM "$CUR_PH" 2>/dev/null; wait "$CUR_PH" 2>/dev/null; CUR_PH=""; fi; exit 130; }
trap 'on_signal INT' INT; trap 'on_signal TERM' TERM; trap 'on_signal HUP' HUP

stop() { REASON="$*"; echo "STOP: $*" >&2; exit 1; }

# ---- 0. this Mac, the tools, a clean environment ----
[ $# -eq 1 ] || die_early "usage: hone-stage-run.sh PLAN-FILE"
PLANF=$1
if [ "$PLATFORM_CHECK" = 1 ]; then [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die_early "not macOS arm64"; fi
for c in shasum node expect zsh awk sed; do command -v "$c" >/dev/null 2>&1 || die_early "$c not found"; done
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|DYLD_[A-Za-z0-9_]*|LD_PRELOAD|HONE_[A-Z_]*|GITHUB_TOKEN|GH_TOKEN)$' | tr '\n' ' ')
[ -z "$bad" ] || die_early "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die_early "no terminal"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die_early "$ROOT is missing or a symlink"
verify_pins || die_early "a pinned file is missing or its sha256 differs (C1: only the pinned scripts may be on this Mac)"
[ -f "$HERE/hb-emit.sh" ] && [ "$(sha "$HERE/hb-emit.sh")" = "$HB_SHA" ] || die_early "hb-emit.sh is missing or differs from its pinned sha256"
[ -f "$PLANF" ] && [ ! -L "$PLANF" ] || die_early "the plan file is missing"
mkdir -p "$OC" && chmod 700 "$OC" || die_early "cannot create $OC"
[ ! -e "$STATEF" ] && [ ! -L "$STATEF" ] || die_early "an APPLY-STATE marker exists ($STATEF): a previous push is UNKNOWN or unverified. Run s1-reconcile-0248.sh, not this."
[ ! -e "$ROLE_STATE" ] || die_early "a previous run left the role setting captured but not confirmed restored ($ROLE_STATE). Read the file, restore the setting, then move it aside."
RUN=$(mktemp -d "$OC/run.XXXXXX") || die_early "mktemp failed"; chmod 700 "$RUN"

# ---- 1. the plan: strict fields, then the printed block and its sha256 ----
plan_get() { sed -n "s/^$1=\(.*\)\$/\1/p" "$PLANF" | head -1; }
for k in STAGE WSTART WEND OPERATOR MFLAG PITR_RET R6CHOICE R6TEXT R6REF ROLE_LIMIT; do eval "P_$k=\$(plan_get $k)"; done
P_HEARTBEAT=$(plan_get HEARTBEAT); P_HB_MAX=$(plan_get HEARTBEAT_MAX); P_HB_AFTER=$(plan_get HEARTBEAT_AFTER_POLLS)
[ -n "$P_HEARTBEAT" ] || P_HEARTBEAT=off; [ -n "$P_HB_MAX" ] || P_HB_MAX=3; [ -n "$P_HB_AFTER" ] || P_HB_AFTER=3
case "$P_HEARTBEAT" in off|wal_message) ;; *) die_early "plan HEARTBEAT must be off or wal_message" ;; esac
printf '%s' "$P_HB_MAX" | grep -Eq '^[1-5]$' && printf '%s' "$P_HB_AFTER" | grep -Eq '^[1-9][0-9]?$' || die_early "plan HEARTBEAT_MAX must be 1 to 5 and HEARTBEAT_AFTER_POLLS a whole number"
[ "$P_STAGE" = 0248 ] || die_early "plan STAGE must be 0248"
utc_ok "$P_WSTART" && utc_ok "$P_WEND" || die_early "plan window times must be YYYY-MM-DDTHH:MM:SSZ"
text_ok "$P_OPERATOR" && text_ok "$P_R6TEXT" && text_ok "$P_R6REF" || die_early "plan text fields are empty or have unsupported characters"
case "$P_MFLAG" in no_flag|flag_on) ;; *) die_early "plan MFLAG must be no_flag or flag_on" ;; esac
case "$P_R6CHOICE" in S0b|accept_rpo) ;; *) die_early "plan R6CHOICE must be S0b or accept_rpo" ;; esac
printf '%s' "$P_PITR_RET" | grep -Eq '^[1-9][0-9]{0,2}$' || die_early "plan PITR_RET must be a whole number of days"
printf '%s' "$P_ROLE_LIMIT" | grep -Eq '^[1-9][0-9]{1,4}s$' || die_early "plan ROLE_LIMIT must look like 120s"
ws_s=$(epoch "$P_WSTART"); we_s=$(epoch "$P_WEND"); now_s=$(date -u +%s)
case "$ws_s$we_s" in *[!0-9]*|'') die_early "cannot read the window times" ;; esac
[ "$we_s" -gt "$ws_s" ] && [ "$now_s" -ge "$ws_s" ] || die_early "now is not inside the planned window"
[ $(( (we_s - now_s) / 60 )) -ge "$MIN_REMAIN_START_MIN" ] || die_early "fewer than $MIN_REMAIN_START_MIN minutes of the window remain: book a window with at least $MIN_REMAIN_START_MIN minutes remaining at S0a"
AF=$OC/ATTEMPTS-$(printf '%s' "$P_WSTART" | tr -d ':-')
na=0; [ -f "$AF" ] && na=$(grep -c '' "$AF")
[ "$na" -lt "$MAX_ATTEMPTS" ] || die_early "this window already had $na row-4 attempts (limit $MAX_ATTEMPTS: one rerun per window). The stage ends with nothing pushed."

PLANBLOCK=$RUN/PLAN.txt
{
  echo "HONE ONE-COMMAND STAGE PLAN (stage 0248; nothing here has run yet)"
  echo "stage: migration 0248 only (the sealed file; 0247, 0249, 0250 are NOT in this stage); expected history after: 246 rows, max 0248"
  echo "target: project $REF through the session pooler (port 5432)"
  echo "window: $P_WSTART to $P_WEND (UTC); needs >= $MIN_REMAIN_START_MIN minutes remaining now; row 4 itself needs >= 90"
  echo "operator: $P_OPERATOR; maintenance flag: $P_MFLAG; R-6: $P_R6CHOICE ($P_R6REF): $P_R6TEXT; PITR retention days: $P_PITR_RET"
  echo "holds (owner-confirmed below): cron-job.org reminders paused; people hold in place"
  echo "recovery: PITR range from the Management API capture (pitr-backups, read only); restore point = the time row 4 stamps at 'select'; the latest point must reach it"
  echo "bounded waiting: poll every ${POLL_S}s up to ${WAIT_LIMIT_S}s; then STOP, nothing pushed. No named restore point."
  if [ "$P_HEARTBEAT" = wal_message ]; then
    echo "PRODUCTION WRITE (disclosed, needs Insurance review and Sam's own approval): ONLY if the latest recovery point has not reached the selection after $P_HB_AFTER polls, up to $P_HB_MAX calls of  select pg_logical_emit_message(true, 'hone-stage-0248', '<run label>')  - one write-ahead-log record each; no table, no row, no function, no schema change, no customer data, no migration; each is followed by a poll; if the point never catches up the run STOPs and nothing is pushed"
  else
    echo "heartbeat: NONE (a recovery point that does not catch up STOPs the run; no write is made to move it)"
  fi
  echo "attempts: at most $MAX_ATTEMPTS row-4 attempts for this window (this is attempt $((na+1)))"
  echo "settings write: ALTER ROLE postgres SET statement_timeout = '$P_ROLE_LIMIT' through the pooler, captured/verified/restored on every exit path (production writes in this plan: that setting$( [ "$P_HEARTBEAT" = wal_message ] && echo ', and the disclosed heartbeat above' ), the migration 0248 itself, and nothing else)"
  echo "stop conditions: any pin mismatch; authentication failure (no retry); S0a or row 4 not PASS; PITR stalled; setting not verified; watchdog not armed; any unexpected prompt"
  echo "outcomes: APPLIED+VERIFIED | NOT APPLIED | UNKNOWN -> reconcile (never a rerun)"
  echo "pins (full sha256, re-checked after approval):"
  printf '%s\n' "$PINS" | sed '/^$/d;s/^/  /'
} > "$PLANBLOCK"
PLAN_SHA=$(sha "$PLANBLOCK")
cat "$PLANBLOCK" >&2
echo "plan sha256: $PLAN_SHA" >&2
echo >&2
HBS="I approve no other write."
[ "$P_HEARTBEAT" = wal_message ] && HBS="I also approve, only if the recovery point has not caught up after $P_HB_AFTER polls, at most $P_HB_MAX calls of select pg_logical_emit_message(true, 'hone-stage-0248', ...) (write-ahead-log records only: no table, row, function, schema change or customer data); I approve no other write."
echo "New-route approval sentence (generated from the plan sha256 above; typing 'approved' below is the stage approval, it is NOT Sam's approval of these new write routes - Sam and Insurance decide this sentence separately):" >&2
echo "  \"I approve ONE runner-executed hosted settings write for stage 0248 only, ALTER ROLE postgres SET statement_timeout = '$P_ROLE_LIMIT' through the session pooler, to be restored to its captured original on every exit path, under plan sha256 $PLAN_SHA. $HBS\"" >&2
echo >&2

# ---- 2. holds (yes/no), then ONE approval prompt ----
ans() { local _v; IFS= read -r -p "$2" _v </dev/tty || stop "could not read $1"; printf -v "$1" '%s' "$_v"; }
ans H1 "Cron-job.org reminders paused (yes or no): "; [ "$H1" = yes ] || stop "hold 1 not confirmed (type exactly: yes)"
ans H2 "People hold in place (yes or no): "; [ "$H2" = yes ] || stop "hold 2 not confirmed (type exactly: yes)"
ans APPR "Type approved or decline: "
[ "$APPR" = approved ] || stop "not approved (you typed '$APPR'); nothing was run"
echo "$PLAN_SHA  approved $(utcnow)" > "$RUN/APPROVAL.txt"
echo "$P_WSTART $(utcnow)" >> "$AF"

# ---- 3. credentials: read once, hidden, held only here and in the children's pty; cleared in the exit trap ----
IFS= read -rs -p "Supabase access token (not shown): " TOK </dev/tty || stop "could not read the access token"; echo >&2
IFS= read -rs -p "Database password (not shown): " PW </dev/tty || stop "could not read the password"; echo >&2
[ -n "$TOK" ] && [ -n "$PW" ] || stop "empty credential"
verify_pins || stop "a pinned file changed after the approval"
[ "$(sha "$HERE/hb-emit.sh")" = "$HB_SHA" ] || stop "hb-emit.sh differs from its pinned sha256"
[ "$(sha "$PLANBLOCK")" = "$PLAN_SHA" ] || stop "the plan changed after the approval"

# ---- 4. phases ----
vf=$RUN/values.txt
{ echo "WSTART=$P_WSTART"; echo "WEND=$P_WEND"; echo "OPERATOR=$P_OPERATOR"; echo "MFLAG=$P_MFLAG"; echo "PITR_RET=$P_PITR_RET"
  echo "R6CHOICE=$P_R6CHOICE"; echo "R6TEXT=$P_R6TEXT"; echo "R6REF=$P_R6REF"; echo "PITR_SCRIPT=$PITR"; echo "POLL_S=$POLL_S"; echo "WAIT_LIMIT_S=$WAIT_LIMIT_S"
  echo "WD_SCRIPT=$WD"; echo "WD_ENV=WD_USER=postgres.$REF WD_HOSTPORT=$POOLER:5432 WD_SSLMODE=require WD_MAX=1800 WD_PIN_WAIT=600"
  echo "APPROVED_PLAN_SHA=$PLAN_SHA"
  echo "HB_MODE=$P_HEARTBEAT"; echo "HB_MAX=$P_HB_MAX"; echo "HB_AFTER_POLLS=$P_HB_AFTER"; echo "HB_SCRIPT=$HERE/hb-emit.sh"; echo "HB_GO=$GO"; echo "HB_REF=$REF"; echo "HB_POOLER=$POOLER"; echo "RUN_LABEL=$(basename "$RUN")"; } > "$vf"
run_phase() { # run_phase PHASE CHILD [ARGS]  -> exit status of the driver; result in $RUN/PHASE.result. Run in the background and WAITED for, so a signal reaches the trap at once
  local ph=$1; shift
  ( exec expect -f "$EXP" "$ph" "$vf" "$RUN" "$@" < <(printf '%s\n%s\n' "$TOK" "$PW") ) &
  CUR_PH=$!
  wait "$CUR_PH"; local prc=$?
  CUR_PH=""
  return $prc
}
res() { sed -n "s/^$2=\(.*\)\$/\1/p" "$RUN/$1.result" 2>/dev/null | head -1; }

echo "== phase 1: PITR capture (read only, one Management API call)" >&2
run_phase pitr bash "$PITR"; rc=$?
[ "$rc" = 0 ] || stop "the PITR capture failed (driver status $rc: $(res pitr DRIVER_STOP)). An authentication failure is never retried."
echo "== phase 2: S0a (read only)" >&2
PD=$(res pitr PITR_DIR); [ -d "$PD" ] || stop "no PITR capture directory"
{ echo "PITR_DIR=$PD"; node -e '
const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1]+"/backups.json","utf8"));const p=j.physical_backup_data||{};
const u=s=>typeof s==="number"?new Date(s*1000).toISOString().replace(".000Z","Z"):"";
console.log("PITR_ON="+(j.pitr_enabled===true?"true":"false"));console.log("P_EARLY="+u(p.earliest_physical_backup_date_unix));console.log("P_LATE="+u(p.latest_physical_backup_date_unix));' "$PD"; } >> "$vf"
run_phase s0a bash "$S0A"; rc=$?
[ "$rc" = 0 ] || stop "S0a was not PASS (driver status $rc: $(res s0a DRIVER_STOP) verdict $(res s0a VERDICT)). Nothing was pushed."
echo "== phase 3: row 4 (select, bounded wait on the API capture)" >&2
run_phase row4 bash "$ROW4"; rc=$?
if [ "$rc" = 4 ]; then stop "PITR stalled: the latest recovery point $(res row4 LAST_POLL_LATEST) never reached the selection $(res row4 SELECTED_AT) within ${WAIT_LIMIT_S}s. Nothing was pushed. A second attempt in this window is allowed only if row 4's 90-minute rule holds at its start."; fi
[ "$rc" = 0 ] || stop "row 4 was not PASS (driver status $rc: $(res row4 DRIVER_STOP))"
echo "SELECTED_AT=$(res row4 SELECTED_AT)" >> "$vf"
echo "== phase 4: role setting (capture, apply, verify through a NEW pooler session)" >&2
ORIG_ROLECONF=$(rolconf) || stop "cannot read the role configuration (nothing was changed)"
printf 'captured %s\noriginal_rolconfig=%s\nstate=ALTER-PENDING\nplan=%s\n' "$(utcnow)" "$ORIG_ROLECONF" "$PLAN_SHA" > "$ROLE_STATE" || stop "cannot write the role state record"
ROLE_ALTERED=1
sql_cli "alter role postgres set statement_timeout = '$P_ROLE_LIMIT'" || stop "the ALTER ROLE was refused or failed; restoring"
cur=$(rolconf) || stop "cannot read the role configuration after the ALTER; restoring"
printf '%s' "$cur" | grep -q "statement_timeout=$P_ROLE_LIMIT" || stop "the catalog does not show statement_timeout=$P_ROLE_LIMIT after the ALTER ($cur); restoring"
seen=$(sql_run "show statement_timeout") || stop "cannot read statement_timeout through a new pooler session; restoring"
[ "$seen" = "$P_ROLE_LIMIT" ] || stop "a NEW pooler session reads statement_timeout '$seen', not '$P_ROLE_LIMIT' (the setting reaches only new backends; held ones are not recycled by this runner); restoring"
echo "== phase 5: apply (dry run, reviewed watchdog started by the runner, ONE push)" >&2
run_phase apply bash "$APPLY"; rc=$?
[ "$(res apply APPLY_TYPED)" = 1 ] && APPLY_TYPED=1
if [ "$APPLY_TYPED" = 1 ] && [ "$rc" != 0 ]; then OUTCOME="UNKNOWN -> reconcile"; stop "the push was started and did not finish cleanly (driver status $rc). The IN-FLIGHT marker stays."; fi
[ "$rc" = 0 ] || stop "the apply script stopped before the push (driver status $rc: $(res apply DRIVER_STOP)). Nothing was applied."
echo "== phase 6: read-back (read only)" >&2
run_phase s1read bash "$S1READ"; rc=$?
if [ "$rc" != 0 ] || [ "$(res s1read VERDICT)" != PASS ]; then OUTCOME="UNKNOWN -> reconcile"; stop "the push finished but the read-back was not PASS (status $rc). Treat as UNKNOWN."; fi
REASON="history 246 rows, max 0248 read back by window-s1read-0248"
echo "== phase 7: reconcile (clears the marker only on the read-back evidence; read only)" >&2
( cd "$ROOT" && bash "$ROOT/s1-apply-0248/s1-reconcile-0248.sh" ) </dev/null >"$RUN/reconcile.out" 2>&1; rcr=$?
if [ "$rcr" = 0 ] && [ ! -e "$STATEF" ]; then OUTCOME="APPLIED+VERIFIED"; else OUTCOME="APPLIED+VERIFIED (marker NOT cleared: run s1-reconcile-0248.sh, see $RUN/reconcile.out)"; fi
exit 0
