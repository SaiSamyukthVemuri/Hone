#!/bin/bash
# REHEARSAL - NEVER MERGE. Part C read-back (scripts/ci/partc-readback.sh) on a stock macOS arm64 runner (macos-14): bash 3.2,
# BSD grep/sed/tr/stat/date, the darwin_arm64 supabase-go (checksum- and codesign-verified), a REAL pty (expect) for the
# private password prompt. Database: a real local PostgreSQL with TLS and scram password authentication, started on the runner
# (NOT Supavisor: Supavisor needs docker, which a macos-14 runner does not have). Stub CLI only for the cases a plain
# PostgreSQL cannot produce (a pooler that drops startup options, malformed output). No hosted call. Canary values only.
#
# The script under test is run BYTE-FOR-BYTE except three lines tagged REHEARSAL-SUBST in a TEST COPY (project ref, host:port,
# and the supabase-go sha for the stub cases); the harness proves the copy differs from the real file only on those lines.
set -u
OUT="${REHEARSAL_OUT:?}"
LOGS="$OUT/logs"
mkdir -p "$OUT" "$LOGS"
RES="$LOGS/results.txt"; : > "$RES"
FAILS=0
say() { echo "$*" | tee -a "$RES"; }
expect_() { if [ "$2" = "0" ]; then say "PASS  $1  [$3]"; else say "FAIL  $1  [$3]"; FAILS=$((FAILS + 1)); fi; }
t() { if "$@"; then echo 0; else echo 1; fi; }   # t <test...> -> 0 or 1
REPO="$PWD"
REAL="$REPO/scripts/ci/partc-readback.sh"
PORT=54398
PW=canarypw8K3x
BADPW=wrongpw5Z9q
FREF=rehearsalrefabcdefgh
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
shas() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

say "# Part C on macOS: $(uname -sm); /bin/bash $(/bin/bash --version | head -1); $(date +%T)"
expect_ "the script under test parses under macOS /bin/bash 3.2 (bash -n)" "$(t /bin/bash -n "$REAL")" "sha256 $(sha "$REAL" | cut -c1-16)"

# ---- 1. the darwin_arm64 supabase-go, verified exactly as installer v2 does ----------------------------------------------
VER=2.102.0
ARCHIVE=supabase_${VER}_darwin_arm64.tar.gz
BASE=https://github.com/supabase/cli/releases/download/v${VER}
SHA_CHECKSUMS=d8b65682838583ffc3c08d083b088c9b16ec314d5ee4e82ad02fda8f4ed3345e
SHA_ARCHIVE=567f0ce9f050ceb46ad4389ab13035e31b5b7205fcb093530f528bb208d2ce28
SHA_SUPABASE_GO=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
DL="$OUT/dl"; mkdir -p "$DL"
( cd "$DL" && curl -fsSL --proto '=https' --tlsv1.2 -O "$BASE/$ARCHIVE" -O "$BASE/checksums.txt" ) || { say "FAIL download"; exit 1; }
expect_ "checksums.txt and the darwin_arm64 archive match the recorded sha256" "$([ "$(sha "$DL/checksums.txt")" = "$SHA_CHECKSUMS" ] && [ "$(sha "$DL/$ARCHIVE")" = "$SHA_ARCHIVE" ] && echo 0 || echo 1)" "$(sha "$DL/$ARCHIVE" | cut -c1-16)"
mkdir -p "$OUT/cli"
tar -xzf "$DL/$ARCHIVE" -C "$OUT/cli" supabase-go
chmod +x "$OUT/cli/supabase-go"
GO="$OUT/cli/supabase-go"
/usr/bin/codesign --verify --verbose=2 "$GO" > "$OUT/codesign.txt" 2>&1; CSRC=$?
expect_ "supabase-go has the recorded sha256 (the one the script pins) and macOS codesign accepts it" "$([ "$(sha "$GO")" = "$SHA_SUPABASE_GO" ] && [ "$CSRC" = 0 ] && echo 0 || echo 1)" "codesign rc=$CSRC"
expect_ "the script's pinned GO_SHA is the verified supabase-go sha" "$(grep -q "^GO_SHA=$SHA_SUPABASE_GO " "$REAL" && echo 0 || echo 1)" "$SHA_SUPABASE_GO"

# ---- 2. a real PostgreSQL: TLS, scram password authentication, connection and statement logging --------------------------
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@1*/bin 2> /dev/null | tail -1)"
if [ -z "$PGBIN" ]; then brew install postgresql@16 > "$OUT/brew.log" 2>&1; PGBIN="$(ls -d /opt/homebrew/opt/postgresql@16/bin | tail -1)"; fi
say "INFO  postgres: $("$PGBIN/postgres" --version)"
PGDATA="$OUT/pgdata"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 > "$OUT/initdb.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/server.key" -out "$OUT/server.crt" -days 1 -subj "/CN=localhost" > /dev/null 2>&1
chmod 600 "$OUT/server.key"
cat >> "$PGDATA/postgresql.conf" <<CONF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$OUT'
ssl = on
ssl_cert_file = '$OUT/server.crt'
ssl_key_file = '$OUT/server.key'
password_encryption = scram-sha-256
log_connections = on
log_statement = 'all'
log_line_prefix = '%u|'
CONF
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$OUT/pg.log" -w start > /dev/null 2>&1 || { tail "$OUT/pg.log"; say "FAIL postgres start"; exit 1; }
MITMPID=""
trap '"$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop > /dev/null 2>&1; [ -n "$MITMPID" ] && kill "$MITMPID" 2> /dev/null; cp "$OUT/pg.log" "$LOGS/pg.log" 2> /dev/null' EXIT
su_psql() { "$PGBIN/psql" -h "$OUT" -p "$PORT" -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
su_psql -c "create role \"postgres.$FREF\" login password '$PW'" > /dev/null
say "INFO  ssl: $(su_psql -c 'show ssl'); login role created with a canary password (scram)"
plog_mark() { wc -l < "$OUT/pg.log" | tr -d ' '; }
plog_since() { tail -n +$(($1 + 1)) "$OUT/pg.log"; }

# ---- 3. the test copy: only the REHEARSAL-SUBST lines differ -------------------------------------------------------------
mkcopy() { # mkcopy <dest> <go-sha> -> a copy of the script with REF, HOSTPORT and GO_SHA substituted
  sed -e "s#^REF=[a-z0-9]*  #REF=$FREF  #" -e "s#^HOSTPORT=[^ ]*  #HOSTPORT=127.0.0.1:$PORT  #" -e "s#^GO_SHA=[0-9a-f]*  #GO_SHA=$2  #" "$REAL" > "$1"
}
mkcopy "$OUT/copy-real.sh" "$SHA_SUPABASE_GO"
CHANGED="$(diff "$REAL" "$OUT/copy-real.sh" | grep -c '^>')"
UNTAGGED="$(diff "$REAL" "$OUT/copy-real.sh" | grep '^>' | grep -vc 'REHEARSAL-SUBST')"
expect_ "the test copy differs from the real script on exactly the REHEARSAL-SUBST lines (ref and host:port; GO_SHA is unchanged for the real binary), nothing else" "$([ "$CHANGED" = 2 ] && [ "$UNTAGGED" = 0 ] && echo 0 || echo 1)" "changed lines=$CHANGED untagged=$UNTAGGED"

# ---- 4. the pty driver --------------------------------------------------------------------------------------------------
cat > "$OUT/drive.exp" <<'EXP'
set timeout 90
log_file -noappend $env(XLOG)
spawn /usr/bin/env -i HOME=$env(XHOME) PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm {*}$env(XEXTRA) /bin/bash $env(XSCRIPT)
expect {
  "Database password" { if {$env(XPW) ne "NONE"} { send "$env(XPW)\r" } ; exp_continue }
  eof { }
  timeout { puts "EXPECT-TIMEOUT" }
}
lassign [wait] pid spawnid oserr rc
exit $rc
EXP
mkhome() { # mkhome <name> [real|copy-of-go-file]: a HOME holding hone-s1/supabase-cli/supabase-go
  h="$OUT/h-$1"; rm -rf "$h"; mkdir -p "$h/hone-s1/supabase-cli"
  if [ "${2:-real}" = real ]; then ln -s "$GO" "$h/hone-s1/supabase-cli/supabase-go"; else cp "$2" "$h/hone-s1/supabase-cli/supabase-go"; chmod +x "$h/hone-s1/supabase-cli/supabase-go"; fi
  echo "$h"
}
# runpty <name> <home> <script> <password|NONE> [KEY=VAL ...] -> exit code on stdout; transcript in $LOGS/tx-<name>.log (CRs removed)
runpty() {
  n=$1; h=$2; s=$3; p=$4; shift 4
  XLOG="$LOGS/tx-$n.raw" XHOME="$h" XSCRIPT="$s" XPW="$p" XEXTRA="$*" /usr/bin/expect -f "$OUT/drive.exp" > /dev/null 2>&1
  rc=$?
  tr -d '\r' < "$LOGS/tx-$n.raw" > "$LOGS/tx-$n.log"; rm -f "$LOGS/tx-$n.raw"
  echo "$rc"
}
rdir() { ls -d "$1"/hone-s1/partc.*/results 2> /dev/null | head -1; }
nolines() { grep -c "$1" "$2" | tr -d ' '; }
no_secret() { # no_secret <transcript> : neither password canary nor the (fake) ref appears
  ! grep -q -e "$PW" -e "$BADPW" -e "$FREF" "$1"
}

# ---- 5. HAPPY PATH against the real binary and a real PostgreSQL: C1=2min (options honoured), C2=0 ---------------------------
H=$(mkhome happy); M0=$(plog_mark)
RC=$(runpty happy "$H" "$OUT/copy-real.sh" "$PW")
TX="$LOGS/tx-happy.log"; D=$(rdir "$H"); SLICE="$LOGS/pg-happy.log"; plog_since "$M0" > "$SLICE"
say "-- happy path transcript"; sed 's/^/   | /' "$TX" | tee -a "$RES" > /dev/null; sed 's/^/   | /' "$TX" | head -n 40
expect_ "happy path: exit 0, four 'ok' lines, the four values and the interpretation are printed" "$([ "$RC" = 0 ] && [ "$(grep -c '^ok c[1-4] ' "$TX")" = 4 ] && grep -q '^PART C READ-BACK' "$TX" && grep -q '^INTERPRETATION' "$TX" && echo 0 || echo 1)" "exit=$RC"
expect_ "happy path: C1 (with options) read back 2min and C2 (without) read back 0 on a real server, and the table says the option IS honoured" "$(grep -q 'WITH options=-c statement_timeout=120000 : 2min' "$TX" && grep -q 'WITHOUT options *: 0$' "$TX" && grep -q 'the startup option IS honoured' "$TX" && echo 0 || echo 1)" "$(grep -E 'C1 |C2 ' "$TX" | tr '\n' ' ' | cut -c1-200)"
expect_ "happy path: C3 shows all three settings with their source; C4 reports no role-level setting (real CLI shape, nested braces handled)" "$(grep -q 'statement_timeout  *: 0|' "$TX" && grep -q 'lock_timeout  *: 0|' "$TX" && grep -q 'idle_in_transaction_session_timeout  *: 0|' "$TX" && grep -q 'the postgres role has NO role-level setting' "$TX" && echo 0 || echo 1)" "$(grep -E '^        (statement|lock|idle)' "$TX" | tr '\n' ' ' | cut -c1-200)"
expect_ "happy path: neither the password nor the project ref appears anywhere in the terminal transcript" "$(t no_secret "$TX")" "transcript lines=$(wc -l < "$TX" | tr -d ' ')"
expect_ "happy path: server saw exactly 4 authorized connections (one per query) and zero failures" "$([ "$(grep -c 'connection authorized' "$SLICE")" = 4 ] && [ "$(grep -c 'authentication failed' "$SLICE")" = 0 ] && echo 0 || echo 1)" "authorized=$(grep -c 'connection authorized' "$SLICE") received=$(grep -c 'connection received' "$SLICE")"
STM="$(grep "^postgres.$FREF|LOG:" "$SLICE" | sed -E "s/^[^|]*\|LOG: +//" | sort -u)"
say "INFO  distinct statements the login role ran (server log):"; echo "$STM" | sed 's/^/   | /' | tee -a "$RES"
expect_ "happy path: no write, DDL or role keyword in anything the login role ran (read-only on the server's own log)" "$([ -n "$STM" ] && ! echo "$STM" | grep -iwE 'insert|update|delete|create|alter|drop|grant|revoke|truncate|copy|call|do|vacuum|lock' > /dev/null && echo 0 || echo 1)" "statements=$(echo "$STM" | grep -c .)"
expect_ "happy path: the results directory is 0700, holds exactly 4 results + 4 one-line sidecars, all 0600" "$([ "$(stat -f %Lp "$D")" = 700 ] && [ "$(ls "$D" | wc -l | tr -d ' ')" = 8 ] && [ "$(for f in "$D"/*; do stat -f %Lp "$f"; done | sort -u)" = 600 ] && [ "$(cat "$D"/*.meta | grep -c '')" = 4 ] && echo 0 || echo 1)" "dir=$(stat -f %Lp "$D") files=$(ls "$D" | wc -l | tr -d ' ')"
OKS=0
for i in c1 c2 c3 c4; do
  case $i in c1|c2) Q='show statement_timeout' ;; c3) Q="select name, setting, source from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')" ;; c4) Q="select rolname, rolconfig from pg_roles where rolname = 'postgres'" ;; esac
  grep -q "\"query_sha256\":\"$(shas "$Q")\"" "$D/$i.meta" && grep -q "\"result_sha256\":\"$(sha "$D/$i.json")\"" "$D/$i.meta" && grep -q '"exit_code":0' "$D/$i.meta" && OKS=$((OKS + 1))
done
expect_ "happy path: each sidecar binds the query text sha, the result sha and exit 0 (recomputed here independently)" "$([ "$OKS" = 4 ] && echo 0 || echo 1)" "bound=$OKS/4; $(cat "$D/c1.meta" | cut -c1-120)..."
say "INFO  C4 raw CLI JSON has $(tr -d '\n ' < "$D/c4.json" | tr -cd '{' | wc -c | tr -d ' ') opening braces (nested struct when more than 1)"
say "INFO  raw CLI JSON shapes (real binary): $(tr -d '\n ' < "$D/c1.json") $(tr -d '\n ' < "$D/c3.json" | cut -c1-120) $(tr -d '\n ' < "$D/c4.json")"
expect_ "happy path: the password variable is not in the script's environment after it ends (the script ran as a child of env -i; its exit cleared it)" "0" "child process; the EXIT trap also runs unset PGPASSWORD"

# ---- 6. ROLE DEFAULT: C2 shows it, C4 shows rolconfig ---------------------------------------------------------------------
su_psql -c "alter role \"postgres.$FREF\" set statement_timeout = '30s'" -c "alter role postgres set statement_timeout = '30s'" > /dev/null
H=$(mkhome roledef); RC=$(runpty roledef "$H" "$OUT/copy-real.sh" "$PW"); TX="$LOGS/tx-roledef.log"
sed 's/^/   | /' "$TX" | sed -n '/PART C READ-BACK/,/^Results/p' | tee -a "$RES"
expect_ "role default: C1=2min, C2=30s; the table says the option is honoured and a default of 30s applies; C4 shows the role-level setting" "$([ "$RC" = 0 ] && grep -q 'WITH options=-c statement_timeout=120000 : 2min' "$TX" && grep -q 'WITHOUT options *: 30s' "$TX" && grep -q 'a default of 30s applies' "$TX" && grep -q 'the postgres role has role-level settings: .*statement_timeout=30s' "$TX" && echo 0 || echo 1)" "exit=$RC"
su_psql -c "alter role \"postgres.$FREF\" reset statement_timeout" -c "alter role postgres reset statement_timeout" > /dev/null

# ---- 7. WRONG PASSWORD: exactly one attempt, then the script dies ---------------------------------------------------------
H=$(mkhome wrongpw); M0=$(plog_mark)
RC=$(runpty wrongpw "$H" "$OUT/copy-real.sh" "$BADPW"); TX="$LOGS/tx-wrongpw.log"; SLICE="$LOGS/pg-wrongpw.log"; plog_since "$M0" > "$SLICE"
sed 's/^/   | /' "$TX" | tee -a "$RES"
expect_ "wrong password: the server saw EXACTLY ONE connection attempt and ONE failed authentication (the CLI makes no second login), no connection authorized" "$([ "$(grep -c 'connection received' "$SLICE")" = 1 ] && [ "$(grep -c 'password authentication failed' "$SLICE")" = 1 ] && [ "$(grep -c 'connection authorized' "$SLICE")" = 0 ] && echo 0 || echo 1)" "received=$(grep -c 'connection received' "$SLICE") failed=$(grep -c 'password authentication failed' "$SLICE") authorized=$(grep -c 'connection authorized' "$SLICE")"
expect_ "wrong password: exit 1, the STOP line says AUTHENTICATION FAILED and 'do not retry; do not reset the password; do not unban', no PART C output, no c2 line" "$([ "$RC" = 1 ] && grep -q 'STOP: c1: AUTHENTICATION FAILED' "$TX" && grep -q 'do not retry; do not reset the password; do not unban' "$TX" && ! grep -q 'PART C READ-BACK' "$TX" && ! grep -q '^ok c' "$TX" && echo 0 || echo 1)" "exit=$RC"
expect_ "wrong password: neither password (right or wrong) nor the ref is in the transcript" "$(t no_secret "$TX")" "ok"
D=$(rdir "$H")
expect_ "wrong password: no result file and no sidecar was kept for the failed query (the results directory holds nothing)" "$([ -z "$(ls "$D" 2> /dev/null)" ] && echo 0 || echo 1)" "files=$(ls "$D" 2> /dev/null | wc -l | tr -d ' ')"

# ---- 8. ENV LEFTOVER: dies before the password prompt, names only, nothing hosted ----------------------------------------
M0=$(plog_mark); ENVOK=0; ENVN=0
for v in PGPASSWORD SUPABASE_ACCESS_TOKEN HTTPS_PROXY SUPABASE_DB_PASSWORD PGHOST; do
  H=$(mkhome env-$v); RC=$(runpty env-$v "$H" "$OUT/copy-real.sh" "$PW" "$v=envleftover-value-xyz"); TX="$LOGS/tx-env-$v.log"
  ENVN=$((ENVN + 1))
  [ "$RC" = 1 ] && grep -q "STOP: unset these variables first (names only): $v " "$TX" && ! grep -q 'envleftover-value-xyz' "$TX" && ! grep -q 'Database password' "$TX" && ENVOK=$((ENVOK + 1))
done
SLICE="$LOGS/pg-env.log"; plog_since "$M0" > "$SLICE"
expect_  "env leftover: each of PGPASSWORD, SUPABASE_ACCESS_TOKEN, HTTPS_PROXY, SUPABASE_DB_PASSWORD, PGHOST stops the script before the password prompt, naming the variable but never its value" "$([ "$ENVOK" = "$ENVN" ] && echo 0 || echo 1)" "stopped $ENVOK/$ENVN"
expect_ "env leftover: the server saw no connection from any of those runs" "$([ "$(grep -c 'connection received' "$SLICE")" = 0 ] && echo 0 || echo 1)" "received=$(grep -c 'connection received' "$SLICE")"

# ---- 9. TAMPERED BINARY ---------------------------------------------------------------------------------------------------
cp "$GO" "$OUT/go-tampered"; printf 'x' >> "$OUT/go-tampered"; chmod +x "$OUT/go-tampered"
H=$(mkhome tamper "$OUT/go-tampered"); M0=$(plog_mark)
RC=$(runpty tamper "$H" "$OUT/copy-real.sh" "$PW"); TX="$LOGS/tx-tamper.log"; SLICE="$LOGS/pg-tamper.log"; plog_since "$M0" > "$SLICE"
expect_ "tampered binary (one byte appended): the sha256 gate stops the script before the prompt; the binary is never executed; no connection" "$([ "$RC" = 1 ] && grep -q 'STOP: supabase-go missing or sha256 mismatch' "$TX" && ! grep -q 'Database password' "$TX" && [ "$(grep -c 'connection received' "$SLICE")" = 0 ] && echo 0 || echo 1)" "exit=$RC"
H=$(mkhome nobin); rm -f "$H/hone-s1/supabase-cli/supabase-go"; RC=$(runpty nobin "$H" "$OUT/copy-real.sh" "$PW")
expect_ "missing binary: stops with the same message, exit 1" "$([ "$RC" = 1 ] && grep -q 'STOP: supabase-go missing or sha256 mismatch' "$LOGS/tx-nobin.log" && echo 0 || echo 1)" "exit=$RC"
H=$(mkhome empty); RC=$(runpty empty "$H" "$OUT/copy-real.sh" "")
expect_ "empty password typed: stops (STOP: empty password), exit 1, no connection" "$([ "$RC" = 1 ] && grep -q 'STOP: empty password' "$LOGS/tx-empty.log" && echo 0 || echo 1)" "exit=$RC"

# ---- 10. STUB CLI: what a plain PostgreSQL cannot produce ------------------------------------------------------------------
# mkstub <name> <c1> <c2> <c3> <c4> [failc]: a supabase-go stand-in that answers by the query it is given and logs each call.
J1() { printf '[\n  {\n    "statement_timeout": "%s"\n  }\n]\n' "$1"; }
C3_OK='[
  {
    "name": "idle_in_transaction_session_timeout",
    "setting": "0",
    "source": "default"
  },
  {
    "name": "lock_timeout",
    "setting": "0",
    "source": "default"
  },
  {
    "name": "statement_timeout",
    "setting": "0",
    "source": "default"
  }
]'
C4_OK='[
  {
    "rolconfig": null,
    "rolname": "postgres"
  }
]'
mkstub() { # mkstub <name> <c1-out> <c2-out> <c3-out> <c4-out> [failc [failtext]]
  d="$OUT/stub-$1"; rm -rf "$d"; mkdir -p "$d"
  printf '%s\n' "${7:-FATAL: connection refused}" > "$d/failtext"; printf '%s' "$2" > "$d/c1"; printf '%s' "$3" > "$d/c2"; printf '%s' "$4" > "$d/c3"; printf '%s' "$5" > "$d/c4"
  cat > "$d/supabase-go" <<STUB
#!/bin/sh
D="$d"
echo "\$*" >> "\$D/calls"
case "\$*" in
  *options=*) id=c1 ;;
  *pg_settings*) id=c3 ;;
  *pg_roles*) id=c4 ;;
  *) id=c2 ;;
esac
if [ "\$id" = "${6:-none}" ]; then cat "\$D/failtext" >&2; exit 1; fi
cat "\$D/\$id"
STUB
  chmod +x "$d/supabase-go"
  mkcopy "$d/script.sh" "$(sha "$d/supabase-go")"
}
stubrun() { # stubrun <name> -> exit code; transcript tx-stub-<name>.log
  H=$(mkhome "stub-$1" "$OUT/stub-$1/supabase-go"); runpty "stub-$1" "$H" "$OUT/stub-$1/script.sh" "$PW"
}
ncalls() { [ -f "$OUT/stub-$1/calls" ] && grep -c '' "$OUT/stub-$1/calls" | tr -d ' ' || echo 0; }

mkstub zero "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_OK"; RC=$(stubrun zero); TX="$LOGS/tx-stub-zero.log"
expect_ "C1 = C2 = 0 (the pooler drops the options): the table says the options were dropped and the 120 s watchdog IS REQUIRED" "$([ "$RC" = 0 ] && grep -q 'C1 = C2 = 0: the pooler DROPPED the startup options' "$TX" && grep -q 'the 120 s watchdog IS REQUIRED' "$TX" && echo 0 || echo 1)" "exit=$RC calls=$(ncalls zero)"
mkstub same "$(J1 2min)" "$(J1 2min)" "$C3_OK" "$C4_OK"; RC=$(stubrun same); TX="$LOGS/tx-stub-same.log"
expect_ "C1 = C2 = 2min (a default applies either way): the table points at C3 source and C4" "$([ "$RC" = 0 ] && grep -q 'C1 = C2 = 2min: a non-zero default applies' "$TX" && echo 0 || echo 1)" "exit=$RC"
mkstub odd "$(J1 weird)" "$(J1 0)" "$C3_OK" "$C4_OK"; RC=$(stubrun odd); TX="$LOGS/tx-stub-odd.log"
expect_ "an unreadable duration: the table says UNREADABLE and refuses to decide" "$([ "$RC" = 0 ] && grep -q 'UNREADABLE' "$TX" && echo 0 || echo 1)" "exit=$RC"

# malformed output: each dies at the named query, exit 1, and NO later query is run
chk_malformed() { # chk_malformed <label> <stub-name> <die-id> <calls-expected> <message-regex>
  RC=$(stubrun "$2"); TX="$LOGS/tx-stub-$2.log"
  expect_ "malformed output ($1): dies at $3 with exit 1, no later query was run, no PART C output" "$([ "$RC" = 1 ] && grep -qE "STOP: $3: $5" "$TX" && [ "$(ncalls "$2")" = "$4" ] && ! grep -q 'PART C READ-BACK' "$TX" && echo 0 || echo 1)" "exit=$RC calls=$(ncalls "$2") $(grep '^STOP' "$TX" | head -1 | cut -c1-110)"
}
mkstub m1 'ERROR: something went wrong' "$(J1 0)" "$C3_OK" "$C4_OK";                  chk_malformed "non-JSON text, exit 0" m1 c1 1 'the output is not a JSON array'
mkstub m2 '[]' "$(J1 0)" "$C3_OK" "$C4_OK";                                           chk_malformed "empty array" m2 c1 1 'the output is not a JSON array'
mkstub m3 "$(J1 0)$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_OK";                               chk_malformed "two JSON documents" m3 c1 1 '(expected 1 row|the output is not a JSON array|the row is not in the expected shape)'
mkstub m4 "$(J1 0)" '[
  {
    "other_column": "0"
  }
]' "$C3_OK" "$C4_OK";                                                                 chk_malformed "wrong column" m4 c2 2 'the row is not in the expected shape'
mkstub m5 "$(J1 0)" '[
  {
    "statement_timeout": "0"
  },
  {
    "statement_timeout": "0"
  }
]' "$C3_OK" "$C4_OK";                                                                 chk_malformed "two rows where one is expected" m5 c2 2 'expected 1 row'
mkstub m6 "$(J1 0)" "$(J1 0)" '[
  {
    "name": "lock_timeout",
    "setting": "0",
    "source": "default"
  }
]' "$C4_OK";                                                                          chk_malformed "C3 with one setting of three" m6 c3 3 'expected 3 row'
mkstub m7 "$(J1 0)" "$(J1 0)" '[
  {
    "name": "lock_timeout",
    "setting": "0",
    "source": "default"
  },
  {
    "name": "lock_timeout",
    "setting": "0",
    "source": "default"
  },
  {
    "name": "statement_timeout",
    "setting": "0",
    "source": "default"
  }
]' "$C4_OK";                                                                          chk_malformed "C3 repeats a name and misses one" m7 c3 3 'the setting idle_in_transaction_session_timeout is not present exactly once'
mkstub m8 "$(J1 0)" "$(J1 0)" "$C3_OK" '[
  {
    "rolconfig": null,
    "rolname": "someone_else"
  }
]';                                                                                   chk_malformed "C4 for a different role" m8 c4 4 'the row is not the postgres role'
C4_STRUCT_NULL='[
  {
    "rolconfig": {
      "Elements": null,
      "Dimensions": null,
      "Status": 1
    },
    "rolname": "postgres"
  }
]'
C4_STRUCT_SET='[
  {
    "rolconfig": {
      "Elements": [
        "statement_timeout=30s"
      ],
      "Dimensions": [
        {
          "Length": 1,
          "LowerBound": 1
        }
      ],
      "Status": 2
    },
    "rolname": "postgres"
  }
]'
mkstub s1 "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_STRUCT_NULL"; RC=$(stubrun s1); TX="$LOGS/tx-stub-s1.log"
expect_ "C4 as a nested struct with null elements (pgx array shape): accepted, reported as no role-level setting (Insurance F2)" "$([ "$RC" = 0 ] && grep -q 'the postgres role has NO role-level setting' "$TX" && echo 0 || echo 1)" "exit=$RC"
mkstub s2 "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_STRUCT_SET"; RC=$(stubrun s2); TX="$LOGS/tx-stub-s2.log"
expect_ "C4 as a nested struct with elements: accepted, the setting is shown" "$([ "$RC" = 0 ] && grep -q 'role-level settings: .*statement_timeout=30s' "$TX" && echo 0 || echo 1)" "exit=$RC"
mkstub s3 "$(J1 0)" "$(J1 0)" "$C3_OK" "$(printf '%s\n%s' "$C4_STRUCT_SET" "$C4_STRUCT_SET" | tr -d '\n' | sed 's/\]\[/,/')"; RC=$(stubrun s3); TX="$LOGS/tx-stub-s3.log"
expect_ "C4 with two rows (nested): counted by top-level object, rejected as 2 rows, dies at c4" "$([ "$RC" = 1 ] && grep -qE 'STOP: c4: (expected 1 row|the output is not a JSON array)' "$TX" && echo 0 || echo 1)" "exit=$RC $(grep '^STOP' "$TX" | head -1 | cut -c1-80)"
mkstub s4 "$(J1 0)" "$(J1 0)" "$C3_OK" '[
  {
    "rolconfig": {
      "Elements": [
    "rolname": "postgres"
  }
]'; RC=$(stubrun s4); TX="$LOGS/tx-stub-s4.log"
expect_ "C4 with unbalanced nested braces: rejected, dies at c4" "$([ "$RC" = 1 ] && grep -q 'STOP: c4: ' "$TX" && ! grep -q 'PART C READ-BACK' "$TX" && echo 0 || echo 1)" "exit=$RC $(grep '^STOP' "$TX" | head -1 | cut -c1-80)"

mkstub m9 "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_OK" c1 'FATAL: password authentication failed for user "x"'; RC=$(stubrun m9); TX="$LOGS/tx-stub-m9.log"
expect_ "CLI exits 1 with an authentication error on the FIRST query: dies at once, one call only, the exact 'do not retry...' line" "$([ "$RC" = 1 ] && grep -q 'STOP: c1: AUTHENTICATION FAILED' "$TX" && grep -q 'do not retry; do not reset the password; do not unban' "$TX" && [ "$(ncalls m9)" = 1 ] && echo 0 || echo 1)" "exit=$RC calls=$(ncalls m9)"
mkstub m10 "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_OK" c3 'FATAL: connection refused'; RC=$(stubrun m10); TX="$LOGS/tx-stub-m10.log"
expect_ "CLI exits 1 on a LATER query (c3, not an auth error): dies, three calls only, still the 'do not retry' line, no PART C output" "$([ "$RC" = 1 ] && grep -q 'STOP: c3: the CLI exited 1' "$TX" && grep -q 'do not retry; do not reset the password; do not unban' "$TX" && [ "$(ncalls m10)" = 3 ] && ! grep -q 'PART C READ-BACK' "$TX" && echo 0 || echo 1)" "exit=$RC calls=$(ncalls m10)"
mkstub m11 "$(J1 0)" "$(J1 0)" "$C3_OK" "$C4_OK" c1 'Initialising login role...'; RC=$(stubrun m11); TX="$LOGS/tx-stub-m11.log"
expect_ "CLI reports a login-role path (stderr): the script stops and says a hosted write may have happened; exit 1; one call" "$([ "$RC" = 1 ] && grep -q 'a hosted write may have happened' "$TX" && [ "$(ncalls m11)" = 1 ] && echo 0 || echo 1)" "exit=$RC"
# a successful stub run must have made exactly four calls in the documented order and shapes
CALLS="$OUT/stub-zero/calls"
expect_ "the four CLI calls are exactly: --agent no db query --db-url <url>[&options] -o json <query>, in the order C1 C2 C3 C4, with no --linked, no --local and no password in argv" "$([ "$(ncalls zero)" = 4 ] && [ "$(sed -n 1p "$CALLS" | grep -c -- "^--agent no db query --db-url postgresql://postgres.$FREF@127.0.0.1:$PORT/postgres?sslmode=require&options=-c%20statement_timeout%3D120000 -o json show statement_timeout\$")" = 1 ] && [ "$(sed -n 2p "$CALLS" | grep -c -- "^--agent no db query --db-url postgresql://postgres.$FREF@127.0.0.1:$PORT/postgres?sslmode=require -o json show statement_timeout\$")" = 1 ] && sed -n 3p "$CALLS" | grep -q "pg_settings" && sed -n 4p "$CALLS" | grep -q "pg_roles" && ! grep -qE -e '--linked|--local|canarypw|password' "$CALLS" && echo 0 || echo 1)" "$(sed -n 1p "$CALLS" | cut -c1-150)"

# ---- 11. outbound silence: the same CLI call behind a TLS-intercepting proxy sends nothing outbound ------------------------------
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
MITMPID=$!
for _ in $(seq 1 40); do [ -f "$MITM/mitmproxy-ca-cert.pem" ] && (echo > /dev/tcp/127.0.0.1/8089) 2> /dev/null && break; sleep 0.5; done
PROBE="$OUT/probe"; mkdir -p "$PROBE/supabase/.temp"; printf 'v2.102.0\n' > "$PROBE/supabase/.temp/cli-latest"
PURL="postgresql://postgres.$FREF@127.0.0.1:$PORT/postgres?sslmode=require"
( cd "$PROBE" && env -i HOME="$OUT/h-happy" PATH=/usr/bin:/bin PGPASSWORD="$PW" HTTPS_PROXY=http://127.0.0.1:8089 HTTP_PROXY=http://127.0.0.1:8089 NO_PROXY= SSL_CERT_FILE="$MITM/mitmproxy-ca-cert.pem" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
    "$GO" --agent no db query --db-url "$PURL&options=-c%20statement_timeout%3D120000" -o json "show statement_timeout" > "$OUT/probe1.out" 2> "$OUT/probe1.err"; echo $? > "$OUT/probe1.rc"
  env -i HOME="$OUT/h-happy" PATH=/usr/bin:/bin PGPASSWORD="$PW" HTTPS_PROXY=http://127.0.0.1:8089 HTTP_PROXY=http://127.0.0.1:8089 NO_PROXY= SSL_CERT_FILE="$MITM/mitmproxy-ca-cert.pem" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
    "$GO" --agent no db query --db-url "$PURL" -o json "select rolname, rolconfig from pg_roles where rolname = 'postgres'" > "$OUT/probe2.out" 2> "$OUT/probe2.err"; echo $? > "$OUT/probe2.rc" )
sleep 2
expect_ "outbound silence: the same CLI call (with and without options) succeeds behind a TLS-intercepting proxy and makes ZERO outbound HTTP(S) requests (no update check, no telemetry, no Management API)" "$([ "$(cat "$OUT/probe1.rc")" = 0 ] && [ "$(cat "$OUT/probe2.rc")" = 0 ] && [ "$(grep -c . "$OUT/flows.jsonl")" = 0 ] && echo 0 || echo 1)" "rc1=$(cat "$OUT/probe1.rc") rc2=$(cat "$OUT/probe2.rc") requests=$(grep -c . "$OUT/flows.jsonl") stderr=$(tr '\n' ' ' < "$OUT/probe1.err" | cut -c1-100)"

say "# verdict: $([ "$FAILS" = 0 ] && echo 'ALL EXPECTATIONS MET' || echo "$FAILS EXPECTATION(S) FAILED")"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; head -c 900000 "$RES"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit "$([ "$FAILS" = 0 ] && echo 0 || echo 1)"
