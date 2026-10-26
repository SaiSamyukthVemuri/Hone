#!/bin/bash
# Hone #1035 WINDOW ROW 4 (recovery_regime pitr): the selected pre-migration restore point and a FRESH PITR reading,
# checked by the pinned comparator stage `--stage row4`. Run IMMEDIATELY before S1, after window-s0a.sh passed.
# CANDIDATE 4. No hosted call and no secret here. The script stamps the selected restore point itself, at the moment you
# ask for it. AFTER that you run pitr-backups.sh (and, for the idle basis, pitr-wal-twice.sh) in another Terminal; this
# script takes the newest capture(s) after ownership and mode checks and the COMPARATOR reads the recovery range from them
# (the dashboard values you type are only cross-checked, to 1 s). No base backup is asked for or accepted: the Management
# API lists none under PITR. You select ONCE. Fail-closed: any bad answer or any non-PASS stops. No retries, no loop.
# Exit 0 ONLY after the comparator prints one of the two exact lines
#   OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)
#   OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path, restore target L)
# The second means the recovery target is the provider latest point L (see the R4-2 row), valid until the printed time.
# That line covers the row-4 bracket only; it does not replace window-s0a.sh.
set -u
umask 077

ROOT="$HOME/hone-s1"
WR="$ROOT/window-reads-c4"          # candidate 4 lives apart from window-reads: window-s1read.sh pins the candidate-3 comparator there
CMP_SHA=c9b0f102980104d5bd1d59c2127439dacc419ed1c7db235ad7f5acedf9205825
LIB_SHA=813425d4ad786c2e4b87f853a18c37065baf1ccec004fea2fd5c4542c37670f2
BASELINE=BASELINE-W1-MACOS-CANDIDATE-4.json
MIN_REMAIN_MIN=90
SELECT_MAX_AGE_S=1800
BASELINE_SHA=5f713678e5b51f34c498f119cec5ae05b33abe181f342410e6a0d4e4f013795d

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
# The captured result directories: the newest one, a real directory owned by you with mode 700, holding exactly the expected
# regular files (no links). Copied into the private work dir so what the comparator reads cannot change underneath it.
newest_dir() { local d; d=$(ls -1dt "$ROOT"/"$1".* 2>/dev/null | head -n 1); [ -n "$d" ] && printf '%s' "$d"; }
dir_ok() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -f '%u %Lp' "$1" 2>/dev/null)" = "$(id -u) 700" ]; }
file_ok() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -f '%u' "$1" 2>/dev/null)" = "$(id -u)" ]; }
take_api() {
  dir_ok "$1" || die "$1 is not a private (mode 700) directory owned by you"
  # the real capture also holds backups.err and a cwd/ directory (the CLI working dir): only the two named files are copied
  file_ok "$1/backups.json" && file_ok "$1/backups.meta.json" || die "backups.json / backups.meta.json is not a regular file owned by you"
  mkdir -p "$2" && chmod 700 "$2" && cp "$1/backups.json" "$1/backups.meta.json" "$2/" || die "could not copy the pitr-backups result"
}
take_idle() {
  dir_ok "$1" || die "$1 is not a private (mode 700) directory owned by you"
  local sub f
  mkdir -p "$2" && chmod 700 "$2" || die "mkdir failed"
  for sub in r1 r2 r1ready r2ready; do
    dir_ok "$1/$sub" || die "$1/$sub is not a private (mode 700) directory owned by you"
    mkdir -p "$2/$sub" && chmod 700 "$2/$sub" || die "mkdir failed"
    for f in $(ls -A "$1/$sub"); do
      case "$f" in pitr-wal-status.json|pitr-wal-status.meta.json|pitr-ready-count.json|pitr-ready-count.meta.json|UNREADABLE) ;; *) die "$1/$sub holds an unexpected file: $f" ;; esac
      file_ok "$1/$sub/$f" || die "$1/$sub/$f is not a regular file owned by you"
      cp "$1/$sub/$f" "$2/$sub/$f" || die "copy failed"
    done
  done
}

echo "Row 4. The time now is $(utcnow). Times are UTC, like 2026-10-27T01:00:00Z. Nothing is defaulted." >&2
ask WSTART "Window start (UTC): "; utc_ok "$WSTART" || die "window start is not YYYY-MM-DDTHH:MM:SSZ"
ask WEND "Window end (UTC): "; utc_ok "$WEND" || die "window end is not YYYY-MM-DDTHH:MM:SSZ"
now_s=$(date -u +%s)
we_s=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$WEND" +%s 2>/dev/null || date -u -d "$WEND" +%s 2>/dev/null) || die "cannot read the window end"
case "$we_s" in ''|*[!0-9]*) die "cannot read the window end" ;; esac
[ $(( (we_s - now_s) / 60 )) -ge "$MIN_REMAIN_MIN" ] || die "fewer than $MIN_REMAIN_MIN minutes of the window remain: S1 and the steps after it do not fit. Do not start S1."
echo "Run this only after window-s0a.sh printed OVERALL PASS in this window." >&2
echo "Do this only when the holds are in place and the last read-only checks are done. Typing  select  records the pre-migration restore point as the time NOW." >&2
ask GO "Type exactly select: "; [ "$GO" = select ] || die "not selected (type exactly: select)"
T_SEL=$(utcnow)
T_SEL_S=$(date -u +%s)
dl_s=$((T_SEL_S + SELECT_MAX_AGE_S))
DEADLINE=$(date -u -r "$dl_s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$dl_s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || DEADLINE="30 minutes after $T_SEL"
echo "Selected pre-migration restore point: $T_SEL. Write it down. Do NOT start S1 yet." >&2
echo "Now, in ANOTHER Terminal and only AFTER $T_SEL: run pitr-backups.sh (read-only) to capture the recovery range. Then wait until the dashboard's latest recovery point is AT OR AFTER $T_SEL (on a quiet database expect about 15 minutes) and capture again; this script uses the NEWEST capture, and the comparator refuses one that started before $T_SEL. Do not select again." >&2
echo "If the database is quiet and the latest point cannot catch up, the alternative is the idle proof: run pitr-wal-twice.sh AFTER $T_SEL (both of its reads must come after it), then answer idle_proven_latest below. The recovery target is then the provider latest point L, not $T_SEL." >&2
echo "Everything must be answered by $DEADLINE (30 minutes after the selection). If it is still behind after about 25 minutes, stop: the named restore point route is a provider write and needs Sam's explicit authorization. If $DEADLINE passes, stop and run this script again from the start." >&2
echo "The dashboard shows LOCAL time: convert to UTC first (EDT is UTC-4, add 4 hours; EST from 2026-11-01 is UTC-5, add 5; across midnight add a day)." >&2
ask READY "Type ready when the newest pitr-backups capture was taken after $T_SEL and the dashboard's latest recovery point is at or after $T_SEL (or abort): "
case "$READY" in ready) ;; abort) die "aborted by the operator; S1 was not started" ;; *) die "type exactly ready or abort" ;; esac
[ $(( $(date -u +%s) - T_SEL_S )) -le "$SELECT_MAX_AGE_S" ] || die "more than 30 minutes passed since the selection $T_SEL: stop and run this script again from the start. Do NOT start S1."
[ $(( (we_s - $(date -u +%s)) / 60 )) -ge "$MIN_REMAIN_MIN" ] || die "fewer than $MIN_REMAIN_MIN minutes of the window remain: do not start S1"
ask BASIS "Basis (latest_at_or_after, named_restore_point or idle_proven_latest): "; case "$BASIS" in latest_at_or_after|named_restore_point|idle_proven_latest) ;; *) die "basis must be latest_at_or_after, named_restore_point or idle_proven_latest (a bare idle accept is a recorded manual decision, not an answer here)" ;; esac
RP_NAME=""; RP_STATUS=""; RP_AT=""
if [ "$BASIS" = named_restore_point ]; then
  ask RP_NAME "Restore point name: "; text_ok "$RP_NAME" || die "restore point name is empty or has unsupported characters"
  ask RP_STATUS "Restore point status (type exactly AVAILABLE): "; [ "$RP_STATUS" = AVAILABLE ] || die "restore point status must be exactly: AVAILABLE"
  ask RP_AT "Restore point completed at (UTC): "; utc_ok "$RP_AT" || die "restore point time is not YYYY-MM-DDTHH:MM:SSZ"
fi
PAPI_SRC=$(newest_dir pitr-backups) || true
[ -n "${PAPI_SRC:-}" ] || die "no $ROOT/pitr-backups.* directory: run pitr-backups.sh after $T_SEL"
take_api "$PAPI_SRC" "$WORK/pitr-api"
echo "Using the pitr-backups capture in $PAPI_SRC." >&2
IDLE_ARGS=""
if [ "$BASIS" = idle_proven_latest ]; then
  PIDLE_SRC=$(newest_dir pitr-wal) || true
  [ -n "${PIDLE_SRC:-}" ] || die "no $ROOT/pitr-wal.* directory: run pitr-wal-twice.sh after $T_SEL"
  take_idle "$PIDLE_SRC" "$WORK/pitr-idle"
  echo "Using the idle evidence in $PIDLE_SRC." >&2
  IDLE_ARGS="--pitr-idle $WORK/pitr-idle"
fi
ask PITR_ON "PITR enabled on the dashboard (type exactly true): "; [ "$PITR_ON" = true ] || die "PITR enabled must be exactly: true"
ask PITR_RET "PITR retention in days (a whole number, no unit): "; int_ok "$PITR_RET" || die "retention must be a whole number of days (1 to 999), digits only"
ask P_EARLY "Earliest recovery point on the dashboard (UTC): "; utc_ok "$P_EARLY" || die "earliest recovery point is not YYYY-MM-DDTHH:MM:SSZ"
ask P_LATE "Latest recovery point on the dashboard (UTC): "; utc_ok "$P_LATE" || die "latest recovery point is not YYYY-MM-DDTHH:MM:SSZ"

cat > "$WORK/mk-attest.mjs" <<'NODE'
import { writeFileSync } from "node:fs";
const e = process.env;
const point = { selected_at_utc: e.A_SEL, basis: e.A_BASIS };
if (e.A_BASIS === "named_restore_point") Object.assign(point, { restore_point_name: e.A_RP_NAME, restore_point_status: e.A_RP_STATUS, restore_point_completed_at_utc: e.A_RP_AT });
const a = {
  pre_migration_restore_point: point,
  g4_pitr: { pitr_enabled: e.A_PITR_ON === "true", retention_days: Number(e.A_PITR_RET), earliest_recovery_at_utc: e.A_P_EARLY, latest_recovery_at_utc: e.A_P_LATE },
};
writeFileSync(e.A_OUT, JSON.stringify(a, null, 2) + "\n");
NODE
ATT="$WORK/row4-attestation.json"
A_SEL="$T_SEL" A_BASIS="$BASIS" A_RP_NAME="$RP_NAME" A_RP_STATUS="$RP_STATUS" A_RP_AT="$RP_AT" A_PITR_ON="$PITR_ON" A_PITR_RET="$PITR_RET" A_P_EARLY="$P_EARLY" A_P_LATE="$P_LATE" A_OUT="$ATT" node "$WORK/mk-attest.mjs" || die "could not build the row-4 attestation"
[ -s "$ATT" ] || die "row-4 attestation file was not written"

VERDICT="$WORK/verdict.txt"
crc=0
node "$WR/compare-preflight.mjs" --stage row4 --baseline "$WR/$BASELINE" --attest "$ATT" --window-start "$WSTART" --window-end "$WEND" --pitr-api "$WORK/pitr-api" $IDLE_ARGS </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
L1='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)'
L2='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path, restore target L)'
if [ "$crc" = 0 ] && grep -Fxq -e "$L1" -e "$L2" "$VERDICT" && ! grep -qx 'OVERALL PASS' "$VERDICT"; then
  echo "WINDOW ROW 4: $(grep -Fx -e "$L1" -e "$L2" "$VERDICT" | head -n 1) for the selected restore point $T_SEL. This covers the row-4 bracket only; it does not replace window-s0a.sh." >&2
  if [ "$BASIS" = idle_proven_latest ]; then
    echo "IDLE PATH: the recovery target is the provider latest point L, NOT $T_SEL (see restore_target in the R4-2 row above). Start S1 BEFORE the valid_until time printed in that row; after it, run this script again from the start." >&2
  else
    echo "Start S1 within 10 minutes (by $(date -u -r $(( $(date -u +%s) + 600 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)); after that, run this script again from the start." >&2
  fi
  echo "A base backup is UNVERIFIED and no restore was tested." >&2
  exit 0
fi
echo "Row 4 was refused. Do NOT start S1. This script does not loop or retry. If the latest recovery point was behind the selected time, it was not ready: stop. If it is still behind about 25 minutes after the selection, use the named restore point route (a provider write; it needs Sam's explicit authorization) or a recorded manual substitution decision outside the comparator. If more than 30 minutes have passed since the selection, run this script again from the start." >&2
die "the comparator did not print one of the two accepted PASS lines (exit $crc). Evidence is in $WORK"
