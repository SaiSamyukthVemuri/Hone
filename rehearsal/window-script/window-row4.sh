#!/bin/bash
# Hone #1035 WINDOW ROW 4 (recovery_regime pitr): the selected pre-migration restore point and a FRESH PITR reading,
# checked by the pinned comparator stage `--stage row4`. Run IMMEDIATELY before S1, after window-s0a.sh passed.
# No hosted call and no secret here: you type what the dashboard or the management API shows. The script stamps the
# selected restore point itself, at the moment you ask for it, so the reading you type afterwards cannot predate it.
# Fail-closed: any bad answer or any non-PASS stops. No retries, no loop. Exit 0 ONLY after the comparator prints the
# exact line "OVERALL PASS". That line covers the row-4 bracket only; it does not replace window-s0a.sh.
set -u
umask 077

ROOT="$HOME/hone-s1"
WR="$ROOT/window-reads"
CMP_SHA=147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058
LIB_SHA=636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9
BASELINE=BASELINE-W1-MACOS-CANDIDATE-3.json
BASELINE_SHA=efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd

cleanup() { stty echo </dev/tty >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found (the comparator needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -f "$WR/compare-preflight.mjs" ] && [ "$(sha "$WR/compare-preflight.mjs")" = "$CMP_SHA" ] || die "comparator entry missing or sha256 mismatch"
[ -f "$WR/compare-preflight-lib.mjs" ] && [ "$(sha "$WR/compare-preflight-lib.mjs")" = "$LIB_SHA" ] || die "comparator lib missing or sha256 mismatch"
[ -f "$WR/$BASELINE" ] && [ "$(sha "$WR/$BASELINE")" = "$BASELINE_SHA" ] || die "baseline $BASELINE missing or sha256 mismatch"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Za-z0-9_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for entry"
WORK=$(mktemp -d "$ROOT/row4.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"

ask() { local _v; IFS= read -r -p "$2" _v </dev/tty || die "could not read $1"; printf -v "$1" '%s' "$_v"; }
text_ok() { [ -n "$1" ] && [ "${#1}" -le 200 ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9 ._:/@+,;()=#-]+$'; }
utc_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq "^$iso\$"; }
int_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq '^[1-9][0-9]{0,2}$'; }

echo "Row 4. The time now is $(utcnow). Times are UTC, like 2026-10-27T01:00:00Z. Nothing is defaulted." >&2
ask WSTART "Window start (UTC): "; utc_ok "$WSTART" || die "window start is not YYYY-MM-DDTHH:MM:SSZ"
ask WEND "Window end (UTC): "; utc_ok "$WEND" || die "window end is not YYYY-MM-DDTHH:MM:SSZ"
echo "Do this only when the holds are in place and the last read-only checks are done. Typing  select  records the pre-migration restore point as the time NOW." >&2
ask GO "Type exactly select: "; [ "$GO" = select ] || die "not selected (type exactly: select)"
T_SEL=$(utcnow)
echo "Selected pre-migration restore point: $T_SEL. Write it down. Do NOT start S1 yet." >&2
echo "Now read the PITR recovery range AFTER that time (never reuse the S0a reading). The dashboard shows LOCAL time: convert to UTC first (EDT is UTC-4, add 4 hours; EST from 2026-11-01 is UTC-5, add 5; across midnight add a day)." >&2
ask BASIS "Basis (latest_at_or_after or named_restore_point): "; case "$BASIS" in latest_at_or_after|named_restore_point) ;; *) die "basis must be latest_at_or_after or named_restore_point (an idle accept is a recorded manual decision, not an answer here)" ;; esac
RP_NAME=""; RP_STATUS=""; RP_AT=""
if [ "$BASIS" = named_restore_point ]; then
  ask RP_NAME "Restore point name: "; text_ok "$RP_NAME" || die "restore point name is empty or has unsupported characters"
  ask RP_STATUS "Restore point status (type exactly AVAILABLE): "; [ "$RP_STATUS" = AVAILABLE ] || die "restore point status must be exactly: AVAILABLE"
  ask RP_AT "Restore point completed at (UTC): "; utc_ok "$RP_AT" || die "restore point time is not YYYY-MM-DDTHH:MM:SSZ"
fi
ask PITR_ON "PITR enabled (type exactly true): "; [ "$PITR_ON" = true ] || die "PITR enabled must be exactly: true"
ask PITR_RET "PITR retention in days (a whole number, no unit): "; int_ok "$PITR_RET" || die "retention must be a whole number of days (1 to 999), digits only"
ask P_EARLY "Earliest recovery point (UTC): "; utc_ok "$P_EARLY" || die "earliest recovery point is not YYYY-MM-DDTHH:MM:SSZ"
ask P_LATE "Latest recovery point (UTC): "; utc_ok "$P_LATE" || die "latest recovery point is not YYYY-MM-DDTHH:MM:SSZ"
ask P_BSTAT "Latest base backup status (type exactly COMPLETED): "; [ "$P_BSTAT" = COMPLETED ] || die "base backup status must be exactly: COMPLETED"
ask P_BAT "Latest base backup completed at (UTC): "; utc_ok "$P_BAT" || die "base backup time is not YYYY-MM-DDTHH:MM:SSZ"
ask P_BSRC "Base backup read from (dashboard or management_api): "; case "$P_BSRC" in dashboard|management_api) ;; *) die "base backup source must be dashboard or management_api" ;; esac
ask P_READ "Time you read the recovery range (UTC): "; utc_ok "$P_READ" || die "read time is not YYYY-MM-DDTHH:MM:SSZ"
ask P_RSRC "Recovery range read from (dashboard or management_api): "; case "$P_RSRC" in dashboard|management_api) ;; *) die "read source must be dashboard or management_api" ;; esac

cat > "$WORK/mk-attest.mjs" <<'NODE'
import { writeFileSync } from "node:fs";
const e = process.env;
const point = { selected_at_utc: e.A_SEL, basis: e.A_BASIS };
if (e.A_BASIS === "named_restore_point") Object.assign(point, { restore_point_name: e.A_RP_NAME, restore_point_status: e.A_RP_STATUS, restore_point_completed_at_utc: e.A_RP_AT });
const a = {
  pre_migration_restore_point: point,
  g4_pitr: { pitr_enabled: e.A_PITR_ON === "true", retention_days: Number(e.A_PITR_RET), earliest_recovery_at_utc: e.A_P_EARLY, latest_recovery_at_utc: e.A_P_LATE, latest_base_backup_status: e.A_P_BSTAT, latest_base_backup_completed_at_utc: e.A_P_BAT, base_backup_source: e.A_P_BSRC, read_at_utc: e.A_P_READ, read_source: e.A_P_RSRC },
};
writeFileSync(e.A_OUT, JSON.stringify(a, null, 2) + "\n");
NODE
ATT="$WORK/row4-attestation.json"
A_SEL="$T_SEL" A_BASIS="$BASIS" A_RP_NAME="$RP_NAME" A_RP_STATUS="$RP_STATUS" A_RP_AT="$RP_AT" A_PITR_ON="$PITR_ON" A_PITR_RET="$PITR_RET" A_P_EARLY="$P_EARLY" A_P_LATE="$P_LATE" A_P_BSTAT="$P_BSTAT" A_P_BAT="$P_BAT" A_P_BSRC="$P_BSRC" A_P_READ="$P_READ" A_P_RSRC="$P_RSRC" A_OUT="$ATT" node "$WORK/mk-attest.mjs" || die "could not build the row-4 attestation"
[ -s "$ATT" ] || die "row-4 attestation file was not written"

VERDICT="$WORK/verdict.txt"
crc=0
node "$WR/compare-preflight.mjs" --stage row4 --baseline "$WR/$BASELINE" --attest "$ATT" --window-start "$WSTART" --window-end "$WEND" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
if [ "$crc" = 0 ] && grep -qx 'OVERALL PASS' "$VERDICT"; then
  echo "WINDOW ROW 4: OVERALL PASS for the selected restore point $T_SEL. This covers the row-4 bracket only; it does not replace window-s0a.sh. Start S1 now: a restore point older than the baseline's limit fails again." >&2
  exit 0
fi
echo "Row 4 was refused. Options (none is automatic; this script does not loop or retry): (1) a quiet database can leave the latest recovery point behind the selected time: wait, then run this script again (it selects a new time); (2) with Sam's explicit authorization, a named restore point (basis named_restore_point); (3) a recorded manual substitution decision outside the comparator. Do NOT start S1." >&2
die "the comparator did not print OVERALL PASS (exit $crc). Evidence is in $WORK"
