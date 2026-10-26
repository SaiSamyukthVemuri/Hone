#!/bin/bash
# REHEARSAL - NEVER MERGE. restore-point.sh on macOS arm64 (macos-14) with the REAL /usr/bin/curl against a stub Management API on
# 127.0.0.1:8081. The script is a provider WRITE on the hosted project; here it only ever talks to the stub. No hosted call, no secrets.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$HERE/pkg"
W="${E2E_WORK:?E2E_WORK}"; rm -rf "$W"; mkdir -p "$W"
FAKEHOME="$W/home"; ROOT="$FAKEHOME/hone-s1"; mkdir -p "$ROOT"
TSV="$W/steps.tsv"; : > "$TSV"; PASS=0; FAIL=0; CUR=setup
TOK="sbp_$(openssl rand -hex 20)"
REF=alhhybgqdmcdyzpybykj
ok()  { PASS=$((PASS+1)); printf '%s\tok\t%s\n' "$CUR" "$1" >> "$TSV"; echo "ok   - $1"; }
bad() { FAIL=$((FAIL+1)); printf '%s\tFAIL\t%s\n' "$CUR" "$1 $2" >> "$TSV"; echo "FAIL - $1 $2"; }
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
SAFEPATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"
PHRASE="I AUTHORIZE ONE NAMED RESTORE POINT ON PROJECT $REF"

# the published constants, then the test copy (5 lines differ)
for c in 'API=https://api.supabase.com' 'CURL=/usr/bin/curl' 'PROTO="--proto =https"' 'POLL_MAX=60' 'POLL_SLEEP=5'; do grep -qxF "$c" "$PKG/restore-point.sh" || { bad "published constant $c"; }; done
ok "the PUBLISHED script holds API=https://api.supabase.com, CURL=/usr/bin/curl, PROTO=--proto =https, POLL_MAX=60, POLL_SLEEP=5"
cat > "$W/curl-argv" <<'WRAP'
#!/bin/sh
# test wrapper: logs the argument vector (never stdin) and runs the real curl with the same stdin
printf '%s\n' "$*" >> "$HOME/curl-argv.log"
exec /usr/bin/curl "$@"
WRAP
chmod 755 "$W/curl-argv"
sed -e 's#^API=.*#API=http://127.0.0.1:8081#' -e "s#^CURL=.*#CURL=$W/curl-argv#" -e 's#^PROTO=.*#PROTO=""#' -e 's#^POLL_MAX=.*#POLL_MAX=4#' -e 's#^POLL_SLEEP=.*#POLL_SLEEP=1#' "$PKG/restore-point.sh" > "$W/rp-test.sh"
[ "$(diff "$PKG/restore-point.sh" "$W/rp-test.sh" | grep -c '^>')" = 5 ] && ok "the test copy differs from the published script on exactly 5 lines (API, CURL, PROTO, POLL_MAX, POLL_SLEEP)" || bad "test copy diff"
MODE="$W/mode.txt"; LOG="$W/api.log"; echo ok > "$MODE"; : > "$LOG"
python3 -I "$HERE/stub-rp-api.py" "$MODE" "$LOG" > "$W/api.out" 2>&1 & APIPID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/nc -z 127.0.0.1 8081 2>/dev/null && break; /bin/sleep 1; done

run() { # run NAME MODE PHRASE SEL-TOKEN [extra-args...] -> RC, OUT; resets the request log
  NAME=$1; echo "$2" > "$MODE"; : > "$LOG"; : > "$FAKEHOME/curl-argv.log"
  printf '(and nothing else):\t%s\nprinted (UTC\t%s\nSupabase access token\t%s\n' "$3" "$4" "$TOK" > "$W/a-$NAME.txt"
  RC=0; python3 "$HERE/driver.py" "$W/$NAME.out" "$W/a-$NAME.txt" -- env -i PATH="$SAFEPATH" HOME="$FAKEHOME" TERM=dumb /bin/bash "$W/rp-test.sh" "${@:5}" >/dev/null 2>&1 || RC=$?
  OUT="$W/$NAME.out"; LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' "$OUT" > "$OUT.c"; mv "$OUT.c" "$OUT"
  POSTS=$(grep -c '^POST ' "$LOG"); GETS=$(grep -c '^GET ' "$LOG"); TOTAL=$(grep -c '' "$LOG")
}
SELT='{now-60}'

CUR=refusals
run wrongphrase ok "I authorize one named restore point" "$SELT"
[ $RC != 0 ] && has "$OUT" "the authorization phrase did not match: nothing was sent" && [ "$TOTAL" = 0 ] && ok "a wrong authorization phrase: STOP, ZERO requests" || bad "wrong phrase" "rc=$RC total=$TOTAL"
run badsel ok "$PHRASE" "yesterday"
[ $RC != 0 ] && has "$OUT" "not a UTC time" && [ "$TOTAL" = 0 ] && ok "a malformed selected time: STOP, zero requests" || bad "bad selected time"
run futuresel ok "$PHRASE" "{now+600}"
[ $RC != 0 ] && has "$OUT" "in the future" && [ "$TOTAL" = 0 ] && ok "a selected time in the future: STOP, zero requests" || bad "future selected time"
run oldsel ok "$PHRASE" "{now-4000}"
[ $RC != 0 ] && has "$OUT" "more than 60 minutes old" && [ "$TOTAL" = 0 ] && ok "a selected time over 60 minutes old: STOP, zero requests" || bad "old selected time"
run argcase ok "$PHRASE" "$SELT" extra
[ $RC != 0 ] && has "$OUT" "takes no arguments" && [ "$TOTAL" = 0 ] && ok "an argument is refused before anything is asked" || bad "arg refusal"
env -i PATH="$SAFEPATH" HOME="$FAKEHOME" SUPABASE_ACCESS_TOKEN=zzz-secret-value /bin/bash "$W/rp-test.sh" > "$W/envcase.out" 2>&1; rc=$?
[ $rc != 0 ] && has "$W/envcase.out" "unset these variables first (names only): SUPABASE_ACCESS_TOKEN" && ! has "$W/envcase.out" "zzz-secret-value" && ok "SUPABASE_ACCESS_TOKEN in the environment: refused by name, value not printed" || bad "env refusal"

CUR=happy
run happy ok "$PHRASE" "$SELT"; tail -n 8 "$OUT"; cat "$LOG"
[ $RC = 0 ] && has "$OUT" "ROW 4 VALUES (basis named_restore_point): restore_point_name=hs1-" && has "$OUT" "restore_point_status=AVAILABLE" && has "$OUT" "RESTORE POINT CREATED AND AVAILABLE" && ok "happy path: exit 0 and the row-4 values (name, AVAILABLE, completed time in UTC) are printed" || bad "happy" "rc=$RC"
[ "$POSTS" = 1 ] && [ "$GETS" -ge 2 ] && ok "exactly ONE POST, then $GETS polling GETs until AVAILABLE" || bad "post/get counts" "posts=$POSTS gets=$GETS"
PNAME=$(sed -n 's/.*restore_point_name=\([^ ]*\) .*/\1/p' "$OUT" | head -n 1)
[ -n "$PNAME" ] && [ ${#PNAME} -le 20 ] && grep -q "^POST /v1/projects/$REF/database/backups/restore-point auth=yes body={\"name\":\"$PNAME\"}$" "$LOG" && ok "the POST went to /v1/projects/<ref>/database/backups/restore-point with body {\"name\":\"$PNAME\"} (${#PNAME} chars, limit 20) and a Bearer token" || bad "post shape" "$PNAME"
grep -q "restore-point?name=$PNAME auth=yes" "$LOG" && ok "the polling GETs carry ?name=<name> and a Bearer token" || bad "get shape"
! grep -qF -- "$TOK" "$FAKEHOME/curl-argv.log" && [ -s "$FAKEHOME/curl-argv.log" ] && ok "the token never appears on curl's command line (argv logged for every call)" || bad "token on argv"
RPD=$(ls -d "$ROOT"/restore-point.* | tail -n 1)
[ "$(stat -f %Lp "$RPD")" = 700 ] && [ -s "$RPD/restore-point.meta.json" ] && ok "evidence is in a private (0700) folder with a one-line sidecar" || bad "evidence folder"
! grep -rIlF -- "$TOK" "$FAKEHOME" "$W"/*.out "$LOG" 2>/dev/null | grep -q . && ok "the token appears in no transcript, saved file or request log" || bad "token leak"

CUR=failures
run failed failed "$PHRASE" "$SELT"
[ $RC != 0 ] && has "$OUT" "the platform reports status FAILED" && [ "$POSTS" = 1 ] && ok "status FAILED: STOP, still exactly one POST" || bad "failed" "rc=$RC posts=$POSTS"
run pending pending "$PHRASE" "$SELT"
[ $RC != 0 ] && has "$OUT" "still PENDING after 4 checks" && [ "$POSTS" = 1 ] && [ "$GETS" = 4 ] && ok "PENDING forever: a bounded number of checks (4 in the test copy; 60 published), then STOP; no second POST" || bad "pending" "rc=$RC posts=$POSTS gets=$GETS"
run post500 post500 "$PHRASE" "$SELT"
[ $RC != 0 ] && has "$OUT" "the POST answered HTTP 500" && has "$OUT" "Do NOT run this again" && [ "$POSTS" = 1 ] && [ "$GETS" = 0 ] && ok "POST answered 500: STOP with 'do not run again', one POST, no polling, no retry" || bad "post500" "rc=$RC posts=$POSTS gets=$GETS"
run othername othername "$PHRASE" "$SELT"
[ $RC != 0 ] && has "$OUT" "another name" && [ "$POSTS" = 1 ] && ok "the platform answers with another name: STOP" || bad "othername"
run early early "$PHRASE" "$SELT"
[ $RC != 0 ] && has "$OUT" "is BEFORE the selected time" && has "$OUT" "Do NOT use it as the basis" && ok "completed time before the selected time: STOP; the point is not accepted as the basis" || bad "early" "rc=$RC"
! grep -rIlF -- "$TOK" "$FAKEHOME" "$W"/*.out "$LOG" 2>/dev/null | grep -q . && ok "the token appears in no output or file of any case" || bad "token leak (all cases)"
kill $APIPID 2>/dev/null; wait $APIPID 2>/dev/null
echo; echo "passed: $PASS failed: $FAIL"
[ "$FAIL" = 0 ]
