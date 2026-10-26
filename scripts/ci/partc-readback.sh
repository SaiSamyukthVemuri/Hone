#!/bin/bash
# Hone #1035 S1 PART C: the four settings read-backs on the S1 connection (Supavisor session pooler,
# aws-1-us-east-1:5432, user postgres.<ref>, password typed). Read-only: SHOW and SELECT only.
# Fail-closed: the first failure of any kind stops everything. There is NO retry anywhere in this file.
# A wrong password is ONE failed login; repeated failures can get this Mac's IP banned, and unbanning is a
# Management API write that is not authorized. So on any failure: do not retry, do not reset the password,
# do not unban.
# The password is typed privately (never echoed, never on a command line, never written), exported only to
# the CLI child that needs it, and cleared on any exit. Nothing here creates a login role.
# Hosted side: four authenticated connections through the pooler; no write; no Management API call.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b  # REHEARSAL-SUBST
REF=alhhybgqdmcdyzpybykj                                              # REHEARSAL-SUBST
HOSTPORT=aws-1-us-east-1.pooler.supabase.com:5432                     # REHEARSAL-SUBST
URL="postgresql://postgres.$REF@$HOSTPORT/postgres?sslmode=require"
OPT='&options=-c%20statement_timeout%3D120000'

# The four queries, exact bytes (the same text is hashed into each sidecar).
Q1='show statement_timeout'
Q2='show statement_timeout'
Q3="select name, setting, source from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')"
Q4="select rolname, rolconfig from pg_roles where rolname = 'postgres'"

cleanup() {
  unset PGPASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo "STOP: interrupted; password cleared. Do not retry; do not reset the password; do not unban." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
sha_str() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
NOLOGIN="STOP HERE: do not retry; do not reset the password; do not unban. Close this Terminal and report the STOP line above."

# --- Part 0: this Mac, the pinned CLI, a clean environment (NAMES only, never values), fresh private directories
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
[ -f "$BIN" ] && [ -x "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -d "$ROOT" ] || die "$ROOT does not exist (install the pinned CLI first)"
WORK=$(mktemp -d "$ROOT/partc.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; RES="$WORK/results"
mkdir -p "$LINK/supabase/.temp" "$RES" || die "mkdir failed"
chmod 700 "$LINK" "$RES" || die "chmod failed"
# The CLI re-fetches the latest release (a GitHub call) when cli-latest is missing or stale: seed it fresh.
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ "$(cat "$LINK/supabase/.temp/cli-latest")" = v2.102.0 ] || die "cli-latest is not v2.102.0"
printf '%s' "$URL" | grep -Eq '^postgresql://postgres\.[a-z0-9]+@[A-Za-z0-9.-]+:[0-9]+/postgres\?sslmode=require$' || die "the URL constant is malformed or carries a password"
[ -r /dev/tty ] || die "no terminal for private entry"

# --- the password, privately. Not exported here: only run_q exports it, to one CLI child at a time.
IFS= read -rs -p "Database password (not shown): " PGPASSWORD </dev/tty || die "could not read the password"
echo >&2
[ -n "$PGPASSWORD" ] || die "empty password"

# json_shape: a STRUCTURAL read of a whitespace-stripped JSON text (awk; no node or python needed on the Mac).
# Counts the top-level array's row objects by depth (a row may hold nested objects and arrays, e.g. a pgx array
# struct), lists each row's own keys, and returns the raw value of "rolconfig" when a row has one. Prints
#   ROWS <n> / ROW <k1,k2,..> per row / VAL <raw rolconfig> / END <final depth> <still-in-string> <negative-depth>
JSON_SHAPE_AWK='
{
  s = $0; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (ins) {
      if (esc) { esc = 0 } else if (c == "\\") { esc = 1 } else if (c == "\"") { ins = 0; laststr = buf; lastd = depth } else { buf = buf c }
      if (cap) val = val c
      continue
    }
    if (c == "\"") { ins = 1; buf = ""; if (cap) val = val c; continue }
    if (cap && depth == 2 && (c == "," || c == "}")) { cap = 0; print "VAL " val }
    if (c == "{" || c == "[") { depth++; if (c == "{" && depth == 2) { rows++; keys = "" } }
    else if (c == "}" || c == "]") { if (c == "}" && depth == 2) print "ROW " keys; depth--; if (depth < 0) neg = 1 }
    else if (c == ":" && depth == 2 && lastd == 2) {
      keys = keys (keys == "" ? "" : ",") laststr
      if (laststr == "rolconfig") { cap = 1; val = ""; lastd = -1; continue }
      lastd = -1
    }
    if (cap) val = val c
  }
}
END { print "ROWS " (rows + 0); print "END " depth " " (ins + 0) " " (neg + 0) }'
json_shape() { printf '%s' "$1" | awk "$JSON_SHAPE_AWK"; }

# run_q <id> <query> <url> <expected-rows> <required-keys, sorted, comma-separated>
#   Runs ONE query through the pinned CLI and validates and records its output. Never retried. The first
#   call in this file is the only login attempt until it has succeeded; every failure ends the script.
run_q() {
  id=$1; q=$2; u=$3; want=$4; keys=$5
  out="$RES/$id.json"; meta="$RES/$id.meta"; err="$WORK/$id.err"
  [ ! -e "$out" ] && [ ! -e "$meta" ] || die "$id: a result already exists (never overwritten)"
  qsha=$(sha_str "$q")
  started=$(utcnow)
  rc=0
  ( export PGPASSWORD; cd "$LINK" && exec env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
      "$BIN" --agent no db query --db-url "$u" -o json "$q" ) </dev/null >"$out" 2>"$err" || rc=$?
  captured=$(utcnow)
  if grep -qiE 'login role|unban|network.?ban|reset.*password' "$err"; then
    die "$id: the CLI reported a login-role / ban / password path (a hosted write may have happened). $NOLOGIN"
  fi
  if [ "$rc" != 0 ]; then
    # Authentication failures look like: password authentication failed / SQLSTATE 28P01 / 28000 / too many authentication errors.
    if grep -qiE 'authenticat|28P01|28000|password|banned|circuit' "$err"; then
      die "$id: AUTHENTICATION FAILED (exit $rc). This was the one attempt. $NOLOGIN"
    fi
    tail -n 3 "$err" | sed -E 's/postgres(ql)?:\/\/[^ ]*/<url>/g' >&2
    die "$id: the CLI exited $rc. Nothing after it was run. $NOLOGIN"
  fi
  [ -s "$out" ] || die "$id: empty output"
  c=$(LC_ALL=C tr -d '[:space:]' < "$out")
  case "$c" in "[{"*"}]") ;; *) die "$id: the output is not a JSON array of objects" ;; esac
  info=$(json_shape "$c")
  [ "$(printf '%s\n' "$info" | sed -n 's/^END //p')" = "0 0 0" ] || die "$id: the output is not balanced JSON"
  rows=$(printf '%s\n' "$info" | sed -n 's/^ROWS //p')
  [ "$rows" = "$want" ] || die "$id: expected $want row(s), got $rows"
  [ "$(printf '%s\n' "$info" | grep -c '^ROW ')" = "$want" ] || die "$id: the row count does not match"
  [ "$(printf '%s\n' "$info" | sed -n 's/^ROW //p' | while IFS= read -r k; do printf '%s\n' "$k" | tr ',' '\n' | LC_ALL=C sort | tr '\n' ',' ; echo; done | sort -u)" = "$keys," ] || die "$id: the row is not in the expected shape"
  rsha=$(sha "$out")
  printf '{"query_id":"%s","query_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0,"script_sha256":"%s"}\n' \
    "$id" "$qsha" "$rsha" "$started" "$captured" "$SELF_SHA" > "$meta" || die "$id: could not write the sidecar"
  [ "$(grep -c '' "$meta")" = 1 ] || die "$id: the sidecar is not exactly one line"
  grep -Eqx "\\{\"query_id\":\"$id\",\"query_sha256\":\"$qsha\",\"result_sha256\":\"$rsha\",\"started_at_utc\":\"$iso\",\"captured_at_utc\":\"$iso\",\"exit_code\":0,\"script_sha256\":\"[0-9a-f]{64}\"\\}" "$meta" || die "$id: the sidecar does not bind this result"
  echo "ok $id (result sha256 $rsha)" >&2
}
SELF_SHA=$(sha "${BASH_SOURCE[0]}" 2>/dev/null) || die "cannot hash this script"

# The value of column <col> in the first (or only) row of a result, from the whitespace-stripped JSON.
val() { # val <id> <col>
  LC_ALL=C tr -d '[:space:]' < "$RES/$1.json" | sed -nE "s/.*\"$2\":(\"[^\"]*\"|null|\[[^]]*\]).*/\1/p" | head -n 1 | sed -E 's/^"(.*)"$/\1/'
}
# The setting of one pg_settings row, by name.
setting_of() { # setting_of <name> -> "setting|source"
  LC_ALL=C tr -d '[:space:]' < "$RES/c3.json" | grep -oE "\\{\"name\":\"$1\",\"setting\":\"[^\"]*\",\"source\":\"[^\"]*\"\\}" | head -n 1 | sed -E 's/.*"setting":"([^"]*)","source":"([^"]*)".*/\1|\2/'
}
# Postgres prints a duration in the largest whole unit: 0, 120s, 2min, 120000ms. Anything else prints UNKNOWN.
to_ms() {
  case "$1" in
    0) echo 0 ;;
    *[!0-9a-z]*|'') echo UNKNOWN ;;
    *) n=${1%%[a-z]*}; u=${1#"$n"}
       case "$n" in ''|*[!0-9]*) echo UNKNOWN; return ;; esac
       case "$u" in ms) echo "$n" ;; s) echo $((n*1000)) ;; min) echo $((n*60000)) ;; h) echo $((n*3600000)) ;; d) echo $((n*86400000)) ;; *) echo UNKNOWN ;; esac ;;
  esac
}

# --- the four reads, in order, one at a time; nothing is run after a failure
run_q c1 "$Q1" "$URL$OPT" 1 statement_timeout
run_q c2 "$Q2" "$URL" 1 statement_timeout
run_q c3 "$Q3" "$URL" 3 name,setting,source
# C3 must hold each of the three names exactly once (checked before C4 is run).
for nm in statement_timeout lock_timeout idle_in_transaction_session_timeout; do
  [ "$(LC_ALL=C tr -d '[:space:]' < "$RES/c3.json" | grep -o "\"name\":\"$nm\"" | wc -l | tr -d ' ')" = 1 ] || die "c3: the setting $nm is not present exactly once"
done
run_q c4 "$Q4" "$URL" 1 rolconfig,rolname
unset PGPASSWORD
LC_ALL=C tr -d '[:space:]' < "$RES/c4.json" | grep -q '"rolname":"postgres"' || die "c4: the row is not the postgres role"

LC_ALL=C tr -d '[:space:]' < "$RES/c4.json" | grep -q '"rolname":"postgres"' || die "c4: the row is not the postgres role"
C1=$(val c1 statement_timeout); C2=$(val c2 statement_timeout)
# C4: rolconfig may be null, a plain array, or the CLI's array struct with nested braces; read it structurally.
C4RAW=$(json_shape "$(LC_ALL=C tr -d '[:space:]' < "$RES/c4.json")" | sed -n 's/^VAL //p' | head -n 1)
[ -n "$C4RAW" ] || die "c4: no rolconfig value found"
C4=$(printf '%s' "$C4RAW" | sed -nE 's/.*"Elements":(null|\[[^]]*\]).*/\1/p')
[ -n "$C4" ] || C4=$C4RAW
case "$C4" in null|'[]') C4_EMPTY=1 ;; *) C4_EMPTY=0 ;; esac
S_ST=$(setting_of statement_timeout); S_LT=$(setting_of lock_timeout); S_IT=$(setting_of idle_in_transaction_session_timeout)
M1=$(to_ms "$C1"); M2=$(to_ms "$C2")

echo
echo "PART C READ-BACK (read-only; captured $(utcnow))"
echo "  C1  show statement_timeout, WITH options=-c statement_timeout=120000 : $C1"
echo "  C2  show statement_timeout, WITHOUT options                          : $C2"
echo "  C3  pg_settings (setting | source)"
echo "        statement_timeout                    : ${S_ST:-?}"
echo "        lock_timeout                         : ${S_LT:-?}"
echo "        idle_in_transaction_session_timeout  : ${S_IT:-?}"
echo "  C4  rolconfig for role postgres                                       : $C4"
echo
echo "INTERPRETATION"
if [ "$M1" = UNKNOWN ] || [ "$M2" = UNKNOWN ]; then
  echo "  UNREADABLE: C1 or C2 is not a duration this table knows. Report the four values as they are. Do not decide."
elif [ "$M1" = 0 ] && [ "$M2" = 0 ]; then
  echo "  C1 = C2 = 0: the pooler DROPPED the startup options on this connection, and no role default applies."
  echo "  => the 120 s watchdog IS REQUIRED for S1. Nothing on this connection will cancel a long statement."
elif [ "$M1" = 120000 ] && [ "$M2" != 0 ] && [ "$M2" != UNKNOWN ]; then
  echo "  C1 = 120 s, C2 = $C2: the startup option IS honoured, and a default of $C2 applies when it is absent."
  echo "  => a role or database default exists (see C3 'source' and C4); the 120 s limit can still be set at connect time."
elif [ "$M1" = 120000 ] && [ "$M2" = 0 ]; then
  echo "  C1 = 120 s, C2 = 0: the startup option IS honoured on hosted. No role default applies."
  echo "  => the 120 s limit can be set at connect time; the watchdog is a second line only."
elif [ "$M1" = "$M2" ] && [ "$M2" != 0 ]; then
  echo "  C1 = C2 = $C2: a non-zero default applies with or without the option (see C3 source and C4)."
  echo "  => a role or database default governs; read C3 'source' and C4 to see where it is set."
else
  echo "  C1 = $C1, C2 = $C2: a pattern this table does not list. Report the four values. Do not decide."
fi
if [ "$C4_EMPTY" = 1 ]; then echo "  C4: the postgres role has NO role-level setting (rolconfig is empty)."
else echo "  C4: the postgres role has role-level settings: $C4"; fi
echo
echo "Results and one-line sidecars: $RES (counts and setting names only; no secret, no ref in the files)."
echo "Close this Terminal. Nothing was written to the hosted project."
