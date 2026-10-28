#!/bin/bash
ME=apply; . "$HOME/hone-s1/stub-common.sh"
sask WSTART "Window start (UTC): " "$X_WSTART"
sask WEND "Window end (UTC): " "$X_WEND"
sask RPOINT "Type the selected restore point exactly as row 4 printed it (UTC): " "$(cat "$S/stub.tsel")"
ssecret PW "Database password (not shown): " "$PWH"
[ -z "${X_BOGUS_PROMPT:-}" ] || sask Z "Something the table does not know: "
echo "Dry run OK: exactly 1 migration, 0248." >&2
echo "START THE WATCHDOG NOW in Terminal 2" >&2
sask W1 "Terminal 2 printed  WATCHDOG armed  (type yes): " yes
sask W2 "Terminal 2 printed  watching for the push session to start  (type yes): " yes
sask GOWORD "Type  APPLY  to run the single push of that 1 migration (0248) now: " APPLY
mkdir -p "$S/s1-apply"; printf 'IN-FLIGHT %s head=x run=y\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$S/s1-apply/APPLY-STATE"
echo 1 >> "$S/push.count"
[ "${PUSH_MODE:-ok}" != killed ] || kill -9 $$
mv "$S/s1-apply/APPLY-STATE" "$S/s1-apply/APPLY-STATE.t" && printf 'APPLIED-UNVERIFIED x\n' > "$S/s1-apply/APPLY-STATE"; rm -f "$S/s1-apply/APPLY-STATE.t"
echo "STAGE 0248 APPLIED: exactly 1 migration (0248)"
