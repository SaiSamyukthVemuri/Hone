#!/bin/bash
# REHEARSAL - NEVER MERGE. Runs the REAL candidate-4 window-row4.sh (0fd4fbe4, unmodified), its REAL comparator and lib (c9b0f102, 813425d4)
# and REAL baseline 4 (5f713678) on macOS arm64 through a pty, with a SYNTHETIC pitr-backups capture taken after the selection (gen-capture.mjs,
# bound to the real pins), and leaves the row-4 result directory it writes (row4.XXXXXX with row4-attestation.json and verdict.txt) under
# <home>/hone-s1. usage: gen-row4.sh <home-dir>. Exit 0 only if the run exited 0 and verdict.txt holds the labelled line L1.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
F="$1"; WRD="$F/hone-s1/window-reads-c4"
mkdir -p "$WRD" "$F/hone-s1"; chmod 700 "$F/hone-s1"
cp "$HERE/compare-preflight.mjs" "$HERE/compare-preflight-lib.mjs" "$HERE/BASELINE-W1-MACOS-CANDIDATE-4.json" "$WRD/"
nowplus() { python3 -c 'import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
WS=$(nowplus -10); WE=$(nowplus 150)
python3 - "$WS" "$WE" <<'PY' || { echo "SKIP: the 160-minute window overlaps 07:45-10:00 UTC (the comparator refuses it); no real row-4 run"; exit 3; }
import sys, datetime as d
p=lambda s:d.datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ")
a,b=p(sys.argv[1]),p(sys.argv[2])
day=a.replace(hour=0,minute=0,second=0)-d.timedelta(days=1)
while day<=b:
    if a<day+d.timedelta(hours=10) and b>day+d.timedelta(hours=7,minutes=45): sys.exit(1)
    day+=d.timedelta(days=1)
PY
{ printf 'Window start\t%s\nWindow end\t%s\nType exactly select\tselect\n' "$WS" "$WE"
  printf 'Type ready when\t{sleep:14}ready\nBasis (\tlatest_at_or_after\n'
  printf 'PITR enabled\ttrue\nPITR retention\t7\nEarliest recovery point\t{cat:%s/early.txt}\nLatest recovery point\t{cat:%s/late.txt}\n' "$F" "$F"; } > "$F/answers.txt"
( /bin/sleep 6; node "$HERE/gen-capture.mjs" "$F/hone-s1/pitr-backups.r4" -1 0 real-layout > "$F/cap.txt" 2>&1; cut -d' ' -f1 "$F/cap.txt" > "$F/early.txt"; cut -d' ' -f2 "$F/cap.txt" > "$F/late.txt" ) &
BG=$!
RC=0
python3 "$HERE/c4-driver.py" "$F/out.txt" "$F/answers.txt" -- env -i PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$(dirname "$(command -v node)") HOME="$F" TERM=dumb /bin/bash "$HERE/window-row4.sh" || RC=$?
wait $BG
L1=$(sed -n "s/^L1='\(.*\)'$/\1/p" "$HERE/window-row4.sh")
D=$(ls -d "$F"/hone-s1/row4.* 2>/dev/null | head -1)
tail -n 12 "$F/out.txt"
[ "$RC" = 0 ] && [ -n "$D" ] && grep -Fxq -- "$L1" "$D/verdict.txt" && ! grep -qx 'OVERALL PASS' "$D/verdict.txt" && echo "REAL ROW 4 RUN: exit 0, verdict.txt carries L1 only: $D" && exit 0
echo "REAL ROW 4 RUN FAILED (rc=$RC)"; exit 1
