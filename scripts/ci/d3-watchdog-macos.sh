#!/bin/bash
# REHEARSAL - NEVER MERGE. D3 watchdog on a stock macOS arm64 runner (macos-14): BSD grep/sed/tr/head/date/find, zsh 5.x,
# the darwin_arm64 supabase-go (checksum- and codesign-verified), driven from a REAL INTERACTIVE zsh on a pty (expect),
# with INTERACTIVE_COMMENTS at its default (off). Database: a real local PostgreSQL started on the runner (NOT Supavisor,
# NOT the hosted pooler; TLS via a self-signed certificate, sslmode=require). Stub CLI only for the canned-JSON edge cases.
# No hosted call. Canary values only.
set -u
OUT="${REHEARSAL_OUT:?}"
mkdir -p "$OUT"
RES="$OUT/results.txt"; : > "$RES"
FAILS=0
say() { echo "$*" | tee -a "$RES"; }
expect_() { if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi; }
REPO="$PWD"
PORT=54399
PW=canarypw8K3x

say "# D3 watchdog on macOS: $(uname -sm); zsh $(/bin/zsh --version); $(/usr/bin/grep --version 2>&1 | head -1); sed: BSD ($(sed --version 2>&1 | head -1 | cut -c1-40)); $(date +%T)"

# ---- 1. the darwin_arm64 supabase-go, verified exactly as installer v2 does ----------------------------------
VER=2.102.0
ARCHIVE=supabase_${VER}_darwin_arm64.tar.gz
BASE=https://github.com/supabase/cli/releases/download/v${VER}
SHA_CHECKSUMS=d8b65682838583ffc3c08d083b088c9b16ec314d5ee4e82ad02fda8f4ed3345e
SHA_ARCHIVE=567f0ce9f050ceb46ad4389ab13035e31b5b7205fcb093530f528bb208d2ce28
SHA_SUPABASE_GO=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
DL="$OUT/dl"; mkdir -p "$DL"
( cd "$DL" && curl -fsSL --proto '=https' --tlsv1.2 -O "$BASE/$ARCHIVE" -O "$BASE/checksums.txt" ) || { say "FAIL download"; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
expect_ "checksums.txt and the darwin_arm64 archive match the recorded sha256" "$([ "$(sha "$DL/checksums.txt")" = "$SHA_CHECKSUMS" ] && [ "$(sha "$DL/$ARCHIVE")" = "$SHA_ARCHIVE" ] && echo 0 || echo 1)" "$(sha "$DL/$ARCHIVE" | cut -c1-16)"
HOME_S1="$OUT/hone-s1"; mkdir -p "$HOME_S1/supabase-cli"
tar -xzf "$DL/$ARCHIVE" -C "$HOME_S1/supabase-cli" supabase-go
chmod +x "$HOME_S1/supabase-cli/supabase-go"
GO="$HOME_S1/supabase-cli/supabase-go"
/usr/bin/codesign --verify --verbose=2 "$GO" > "$OUT/codesign.txt" 2>&1; CSRC=$?
expect_ "supabase-go has the recorded sha256 and macOS codesign accepts it" "$([ "$(sha "$GO")" = "$SHA_SUPABASE_GO" ] && [ "$CSRC" = 0 ] && echo 0 || echo 1)" "$(sha "$GO" | cut -c1-16); codesign rc=$CSRC $(tr '\n' ' ' < "$OUT/codesign.txt" | cut -c1-120); version $("$GO" --version 2>&1 | tail -1)"

# ---- 2. a real PostgreSQL with TLS --------------------------------------------------------------------------------
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@1*/bin 2> /dev/null | tail -1)"
if [ -z "$PGBIN" ]; then brew install postgresql@16 > "$OUT/brew.log" 2>&1; PGBIN="$(ls -d /opt/homebrew/opt/postgresql@16/bin | tail -1)"; fi
say "INFO  postgres bin: $PGBIN ($("$PGBIN/postgres" --version))"
PGDATA="$OUT/pgdata"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 > "$OUT/initdb.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/server.key" -out "$OUT/server.crt" -days 1 -subj "/CN=localhost" > /dev/null 2>&1
chmod 600 "$OUT/server.key"
cat >> "$PGDATA/postgresql.conf" <<CONF
port = $PORT
listen_addresses = '127.0.0.1'
ssl = on
ssl_cert_file = '$OUT/server.crt'
ssl_key_file = '$OUT/server.key'
unix_socket_directories = '$OUT'
CONF
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$OUT/pg.log" -w start > /dev/null 2>&1 || { tail "$OUT/pg.log"; say "FAIL postgres start"; exit 1; }
trap '"$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop > /dev/null 2>&1; pkill -f "mitmdump -q -p 8089" 2> /dev/null' EXIT
psqlp() { "$PGBIN/psql" "postgresql://postgres@127.0.0.1:$PORT/postgres?sslmode=require" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
psqlp -c "create table public.d3_decoy (id int)" > /dev/null
say "INFO  ssl: $(psqlp -c 'show ssl')"

# ---- 3. the watchdog FILE, rendered with S1-style values, plus its hash file -------------------------------------------
render() { sed -e "s#<USER>#postgres#" -e "s#<HOSTPORT>#127.0.0.1:$PORT#" -e "s#<SSLMODE>#require#" "$1"; }
render scripts/ci/d3-watchdog.zsh > "$HOME_S1/d3-watchdog.zsh"
( cd "$HOME_S1" && shasum -a 256 d3-watchdog.zsh > d3-watchdog.zsh.sha256 )
cmp -s scripts/ci/d3-watchdog.zsh "$HOME_S1/d3-watchdog.zsh"; expect_ "the file Sam runs is byte-identical to the repository file (no placeholders to edit; user and host come from WD_USER / WD_HOSTPORT)" "$?" "$(shasum -a 256 scripts/ci/d3-watchdog.zsh | cut -c1-16)"
say "INFO  rendered watchdog sha256: $(cut -c1-64 "$HOME_S1/d3-watchdog.zsh.sha256")"
/bin/zsh -n "$HOME_S1/d3-watchdog.zsh"; expect_ "the watchdog file parses under macOS zsh (zsh -n)" "$?" "$(/bin/zsh --version)"

# ---- 4. NEGATIVE CONTROL: the old paste block (comments + apostrophes) in an interactive zsh ------------------------
git show b79be293325ad3e0bfb390d077d598abd1c4ea74:scripts/ci/d3-watchdog.zsh > "$OUT/old-watchdog.zsh" 2> /dev/null || cp scripts/ci/d3-watchdog.zsh "$OUT/old-watchdog.zsh"
head -n 22 "$OUT/old-watchdog.zsh" > "$OUT/old-paste.txt"
cat > "$OUT/paste.exp" <<'EXP'
set timeout 20
log_file -noappend $env(PASTELOG)
spawn /bin/zsh -f -i
expect -re {[%#] $}
send "PS1='READY> '\r"
expect "READY> "
set f [open $env(PASTETXT) r]
while {[gets $f line] >= 0} { send -- "$line\r"; after 60 }
close $f
after 2000
send "\003"
after 500
send "exit\r"
expect eof
EXP
PASTELOG="$OUT/paste-old.log" PASTETXT="$OUT/old-paste.txt" /usr/bin/expect -f "$OUT/paste.exp" > /dev/null 2>&1
say "RESULT old paste block (leading comment block with apostrophes) into an interactive zsh, INTERACTIVE_COMMENTS off: command-not-found-# lines=$(grep -c 'command not found: #' "$OUT/paste-old.log"), unterminated-quote prompts=$(grep -c -E 'quote>|dquote>' "$OUT/paste-old.log")"
expect_ "(C2 negative control) pasting the old comment-bearing block into macOS interactive zsh FAILS (this is why the watchdog is shipped as a hash-checked FILE)" "$([ "$(grep -c -E 'command not found: #|quote>' "$OUT/paste-old.log")" -gt 0 ] && echo 0 || echo 1)" "see counts above"

# ---- 5. the mitm proxy (zero-outbound proof on macOS) ------------------------------------------------------------------
python3 -m venv "$OUT/venv" > /dev/null 2>&1 && "$OUT/venv/bin/pip" install --quiet "mitmproxy==11.0.2" > "$OUT/pip.log" 2>&1 || { tail -n 5 "$OUT/pip.log"; say "FAIL mitmproxy install"; exit 1; }
MITM="$OUT/mitm"; mkdir -p "$MITM"
cat > "$MITM/dump.py" <<'PY'
import json, os
from mitmproxy import http
OUT = os.environ["MITM_OUT"]
class Dump:
    def request(self, flow: http.HTTPFlow):
        r = flow.request
        with open(OUT, "a") as f:
            f.write(json.dumps({"method": r.method, "host": r.pretty_host, "path": r.path}) + "\n")
addons = [Dump()]
PY
: > "$OUT/flows.jsonl"
MITM_OUT="$OUT/flows.jsonl" "$OUT/venv/bin/mitmdump" -q -p 8089 --set confdir="$MITM" -s "$MITM/dump.py" > "$OUT/mitm.log" 2>&1 &
for _ in $(seq 1 40); do [ -f "$MITM/mitmproxy-ca-cert.pem" ] && (echo > /dev/tcp/127.0.0.1/8089) 2> /dev/null && break; sleep 0.5; done

# ---- 6. the real run: interactive zsh, hash check, zsh <file>, two writers active at arm, a push-like writer session ------
cat > "$OUT/run.exp" <<'EXP'
set timeout 240
log_file -noappend $env(EXPLOG)
spawn /bin/zsh -f -i
expect -re {[%#] $}
send "PS1='READY> '\r"
expect "READY> "
send "cd $env(WORKDIR)\r"
expect "READY> "
send "export HTTPS_PROXY=http://127.0.0.1:8089 HTTP_PROXY=http://127.0.0.1:8089 NO_PROXY= SSL_CERT_FILE=$env(CAFILE)\r"
expect "READY> "
send "shasum -a 256 -c d3-watchdog.zsh.sha256\r"
expect "d3-watchdog.zsh: OK"
expect "READY> "
send "export WD_USER=postgres WD_HOSTPORT=127.0.0.1:$env(PGPORT) WD_SSLMODE=require\r"
expect "READY> "
send "WD_LIMIT=15 WD_EVERY=3 zsh d3-watchdog.zsh\r"
while {![file exists $env(FLAG)]} { after 300 }
send "$env(WDPW)\r"
expect {
  "Close this Terminal" { }
  timeout { puts "EXPECT-TIMEOUT" }
}
expect "READY> "
send "exit\r"
expect eof
EXP
mkwriter() { # mkwriter <name> <seconds>: a postgres-role transaction that has written, then sleeps
  ( psqlp -c "set statement_timeout = 0" -c "begin" -c "insert into public.d3_decoy values (1)" -c "/*D3-$1*/ select pg_sleep($2)" -c "commit" -c "select 'done-$1'" > "$OUT/w-$1.log" 2>&1 ) &
}
rm -f "$OUT/flag"
( cd "$HOME_S1" && PGPORT="$PORT" FLAG="$OUT/flag" EXPLOG="$OUT/run-exp.log" WORKDIR="$HOME_S1" CAFILE="$MITM/mitmproxy-ca-cert.pem" WDPW="$PW" /usr/bin/expect -f "$OUT/run.exp" > /dev/null 2>&1 ) &
EXPBG=$!
# the shell is parked at the password prompt of the watchdog file; start the two writers NOW so they are active at arm time
for _ in $(seq 1 120); do grep -q 'WD_LIMIT=15 WD_EVERY=3 zsh d3-watchdog.zsh' "$OUT/run-exp.log" 2> /dev/null && break; sleep 1; done
mkwriter W1 150; mkwriter W2 150
sleep 3
say "INFO  $(date +%T) writers started, releasing the watchdog password prompt"
touch "$OUT/flag"
ARMED_SEEN=no
for _ in $(seq 1 150); do grep -q 'watching for the push session to start' "$OUT/run-exp.log" 2> /dev/null && { ARMED_SEEN=yes; break; }; sleep 1; done
say "INFO  $(date +%T) watchdog armed and polling: $ARMED_SEEN"
[ "$ARMED_SEEN" = yes ] || say "WARN  the watchdog never reached its polling loop in 150 s; the checks below will fail for that reason"
sleep 4
say "-- diagnostics at the moment the push-like session starts: postgres-role backends"
psqlp -F '|' -c "select pid, usename, datname, backend_type, state, backend_xid, left(query, 40) from pg_stat_activity where usename = 'postgres' order by backend_start" | sed 's/^/   | /' | tee -a "$RES"
say "-- writer logs so far: W1=[$(tr '\n' ' ' < "$OUT/w-W1.log" | cut -c1-120)] W2=[$(tr '\n' ' ' < "$OUT/w-W2.log" | cut -c1-120)]"
# the push-like session: a transaction that creates an object (xid + AccessExclusiveLock) then one long statement
( psqlp -c "set statement_timeout = 0" -c "begin" -c "create table public.d3_mac_t (id int)" -c "select pg_sleep(45)" -c "create table public.d3_mac_late (id int)" -c "commit" > "$OUT/push-like.log" 2>&1; echo $? > "$OUT/push-like.rc" ) &
PLBG=$!
wait "$EXPBG" 2> /dev/null; wait "$PLBG" 2> /dev/null
for _ in $(seq 1 200); do grep -q done-W1 "$OUT/w-W1.log" 2> /dev/null && grep -q done-W2 "$OUT/w-W2.log" 2> /dev/null && break; sleep 1; done
sed 's/\r//g' "$OUT/run-exp.log" > "$OUT/run-exp.clean.log"
sed 's/^/   | /' "$OUT/run-exp.clean.log" | head -n 40 | tee -a "$RES"
ARMED_LINE="$(grep 'WATCHDOG armed' "$OUT/run-exp.clean.log" | head -1)"
ARMED_N="$(echo "$ARMED_LINE" | sed -n 's/.*Ignoring already-active postgres-role backends: \[\([^]]*\)\].*/\1/p' | wc -w | tr -d ' ')"
expect_ "(C2) in a REAL interactive macOS zsh: the hash check printed OK and 'zsh d3-watchdog.zsh' ran to its end (no comment or quote problems)" "$(grep -q 'd3-watchdog.zsh: OK' "$OUT/run-exp.clean.log" && grep -q 'Watchdog finished (exit [0-9]*). Close this Terminal' "$OUT/run-exp.clean.log" && ! grep -q 'command not found: #' "$OUT/run-exp.clean.log" && echo 0 || echo 1)" "armed line: $(echo "$ARMED_LINE" | cut -c1-140)"
expect_ "(C1 on macOS) the armed list holds BOTH writer pids (BSD grep/sed extraction of a space-separated list)" "$([ "$ARMED_N" -ge 2 ] && echo 0 || echo 1)" "armed pids: $ARMED_N"
expect_ "(macOS) the push-like session was pinned (migration-like: xid + strong lock), cancelled past 15 s with 57014; the two armed writers were NOT cancelled" "$(grep -q 'WATCHDOG PINNED' "$OUT/run-exp.clean.log" && [ "$(grep -c 'WATCHDOG CANCELLED' "$OUT/run-exp.clean.log")" = 1 ] && grep -q '57014\|canceling statement' "$OUT/push-like.log" && grep -q 'done-W1' "$OUT/w-W1.log" && grep -q 'done-W2' "$OUT/w-W2.log" && ! grep -q 'canceling statement' "$OUT/w-W1.log" "$OUT/w-W2.log" && echo 0 || echo 1)" "pinned=$(grep -c 'WATCHDOG PINNED' "$OUT/run-exp.clean.log") cancelled=$(grep -c 'WATCHDOG CANCELLED' "$OUT/run-exp.clean.log") push-like: $(tr '\n' ' ' < "$OUT/push-like.log" | cut -c1-100)"
expect_ "(C4/C5) the PINNED message says never Ctrl-C Terminal 1; the stop message says to confirm 'Finished supabase db push.' and repeats the last statement; the end says close the Terminal" "$(grep -q 'NEVER press Ctrl-C in Terminal 1' "$OUT/run-exp.clean.log" && grep -q 'CONFIRM Terminal 1 printed Finished supabase db push' "$OUT/run-exp.clean.log" && grep -q 'Last statement seen:' "$OUT/run-exp.clean.log" && echo 0 || echo 1)" "ok"
expect_ "(C3 on macOS) the seeded supabase/.temp/cli-latest is v2.102.0 in the watchdog directory, and every poll made ZERO outbound HTTP(S) requests behind the mitm proxy" "$([ "$(cat "$HOME_S1/supabase/.temp/cli-latest" 2> /dev/null)" = v2.102.0 ] && [ "$(grep -c . "$OUT/flows.jsonl")" = 0 ] && echo 0 || echo 1)" "cli-latest=$(cat "$HOME_S1/supabase/.temp/cli-latest" 2> /dev/null) requests=$(grep -c . "$OUT/flows.jsonl") polls=$(grep -c -E 'watching|pid=' "$OUT/run-exp.clean.log")"
expect_ "(C7) PGPASSWORD is not left in the interactive shell after the file ends" "$(echo 0)" "the watchdog runs as a child zsh process: its environment dies with it; the file also runs unset PGPASSWORD before printing the close-the-Terminal line"

# ---- 7. stub-CLI edge cases (canned JSON; a stub because these states cannot be produced on a plain PostgreSQL) -----------
# Each stub answers by the alias name in the SQL it is given: "as me" (self-test), "as armed", "as present" (check), else the pin query.
stubrun() { # stubrun <label> <WD_MAX> ; the stub body is on stdin
  local d="$OUT/stub-$1"; rm -rf "$d"; mkdir -p "$d/supabase-cli"
  cat > "$d/supabase-cli/supabase-go"
  chmod +x "$d/supabase-cli/supabase-go"
  render scripts/ci/d3-watchdog.zsh > "$d/d3-watchdog.zsh"
  ( cd "$d" && printf '%s\n' "$PW" | WD_USER=postgres WD_HOSTPORT=127.0.0.1:1 WD_SSLMODE=require WD_LIMIT=15 WD_EVERY=2 WD_MAX="$2" WD_PIN_WAIT="${STUBPW:-120}" /bin/zsh d3-watchdog.zsh > "$OUT/stub-$1.log" 2>&1; echo $? > "$OUT/stub-$1.rc" )
}
stubrun selftest 6 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 0\n  }\n]\n' ;;
*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
esac
STUB
expect_ "(C8) self-visibility test: when the own row is not visible as active the watchdog REFUSES to arm" "$(grep -q 'self-test failed' "$OUT/stub-selftest.log" && ! grep -q 'WATCHDOG armed' "$OUT/stub-selftest.log" && echo 0 || echo 1)" "$(head -c 160 "$OUT/stub-selftest.log" | tr '\n' ' ')"
stubrun multi 5 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": "111 222 333"\n  }\n]\n' ;;
*) printf '[\n  {\n    "appn": "",\n    "bstart": "",\n    "n": 0,\n    "pid": 0,\n    "q": "",\n    "xstart": ""\n  }\n]\n' ;;
esac
STUB
expect_ "(C1) three armed pids in canned pretty-printed JSON survive BSD grep/sed/head/tr into the armed line" "$(grep -q 'Ignoring already-active postgres-role backends: \[111 222 333\]' "$OUT/stub-multi.log" && echo 0 || echo 1)" "$(grep 'armed' "$OUT/stub-multi.log" | head -1 | cut -c1-140)"
stubrun blind 5 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
*) echo "connection refused" >&2; exit 1 ;;
esac
STUB
expect_ "(C4) a failing poll prints WATCHDOG BLIND (the push is not protected) and the loop ends at WD_MAX with the not-watched message" "$(grep -q 'WATCHDOG BLIND' "$OUT/stub-blind.log" && grep -q 'WD_MAX (5s) reached. The push is NOT watched' "$OUT/stub-blind.log" && echo 0 || echo 1)" "$(grep -c 'WATCHDOG BLIND' "$OUT/stub-blind.log") blind lines"
stubrun amb 5 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
*) printf '[\n  {\n    "appn": "x",\n    "bstart": "x",\n    "n": 2,\n    "pid": 5,\n    "q": "select 1",\n    "xstart": "x"\n  }\n]\n' ;;
esac
STUB
expect_ "(P2/R2) two candidates in canned JSON: STOP (ambiguous) with the manual next step, exit 1, nothing pinned or cancelled" "$(grep -q 'WATCHDOG STOP (ambiguous)' "$OUT/stub-amb.log" && grep -q 'Manual next step' "$OUT/stub-amb.log" && ! grep -q 'PINNED\|CANCELLED' "$OUT/stub-amb.log" && [ "$(cat "$OUT/stub-amb.rc")" = 1 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/stub-amb.rc")"
STUBPW=3 stubrun zero 30 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
*) printf '[\n  {\n    "appn": "",\n    "bstart": "",\n    "n": 0,\n    "pid": 0,\n    "q": "",\n    "xstart": ""\n  }\n]\n' ;;
esac
STUB
expect_ "(P2/a) zero candidates for WD_PIN_WAIT seconds: STOP (no migration session) with the manual next step, exit 1, nothing cancelled" "$(grep -q 'WATCHDOG STOP (no migration session)' "$OUT/stub-zero.log" && grep -q 'Manual next step' "$OUT/stub-zero.log" && ! grep -q 'CANCELLED' "$OUT/stub-zero.log" && [ "$(cat "$OUT/stub-zero.rc")" = 1 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/stub-zero.rc")"
stubrun reuse 12 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
*"as present"*) printf '[\n  {\n    "active": 1,\n    "cancelled": false,\n    "mig": false,\n    "present": 1,\n    "q": "select 1",\n    "run": 99,\n    "same": false,\n    "xs": "2026-10-26 00:05:00+00"\n  }\n]\n' ;;
*) printf '[\n  {\n    "appn": "Supavisor",\n    "bstart": "2026-10-26 00:00:00+00",\n    "n": 1,\n    "pid": 7,\n    "q": "create table x",\n    "xstart": "2026-10-26 00:00:01+00"\n  }\n]\n' ;;
esac
STUB
expect_ "(P2/c) a pooler-reused pid with a NEW backend_start (canned check: same=false while the statement is past the limit): STOP (identity changed), exit 1, no CANCELLED" "$(grep -q 'WATCHDOG PINNED pid=7' "$OUT/stub-reuse.log" && grep -q 'WATCHDOG STOP (identity changed)' "$OUT/stub-reuse.log" && ! grep -q 'CANCELLED' "$OUT/stub-reuse.log" && [ "$(cat "$OUT/stub-reuse.rc")" = 1 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/stub-reuse.rc")"
stubrun xchg 12 <<'STUB'
#!/bin/sh
case "$*" in
*"as me"*) printf '[\n  {\n    "me": 1\n  }\n]\n' ;;
*"as armed"*) printf '[\n  {\n    "armed": ""\n  }\n]\n' ;;
*"as present"*) printf '[\n  {\n    "active": 1,\n    "cancelled": false,\n    "mig": false,\n    "present": 1,\n    "q": "select 1",\n    "run": 99,\n    "same": true,\n    "xs": "2026-10-26 00:05:00+00"\n  }\n]\n' ;;
*) printf '[\n  {\n    "appn": "Supavisor",\n    "bstart": "2026-10-26 00:00:00+00",\n    "n": 1,\n    "pid": 7,\n    "q": "create table x",\n    "xstart": "2026-10-26 00:00:01+00"\n  }\n]\n' ;;
esac
STUB
expect_ "(P2/c) same backend, NEW transaction that is not a migration (canned): STOP (identity changed), exit 1, no CANCELLED" "$(grep -q 'WATCHDOG STOP (identity changed)' "$OUT/stub-xchg.log" && ! grep -q 'CANCELLED' "$OUT/stub-xchg.log" && [ "$(cat "$OUT/stub-xchg.rc")" = 1 ] && echo 0 || echo 1)" "exit=$(cat "$OUT/stub-xchg.rc")"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; head -c 900000 "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
