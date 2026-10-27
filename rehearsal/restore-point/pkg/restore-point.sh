#!/bin/bash
# Hone RESTORE POINT (row-4 fallback, basis named_restore_point): create ONE named restore point on the hosted project and wait until the
# platform reports it AVAILABLE. THIS IS A PROVIDER WRITE (it records a name in the project's WAL stream; it changes no table or row).
# It runs only after Sam types the exact authorization phrase below. NOTHING IN THIS REPOSITORY RUNS IT: it is prepared only.
#
# supabase-go v2.102.0 has NO command for restore points (cmd/backups.go registers only `list` and `restore`; the generated client has
# V1CreateRestorePoint and V1GetRestorePoint but no cobra command calls them). So this script makes the two HTTPS calls itself with curl:
#   POST https://api.supabase.com/v1/projects/<ref>/database/backups/restore-point    body {"name":"<name>"}      -> 201 {name,status,completed_on}
#   GET  https://api.supabase.com/v1/projects/<ref>/database/backups/restore-point?name=<name>                    -> 200 {name,status,completed_on}
# status is PENDING | AVAILABLE | FAILED | REMOVED; completed_on is an ISO time or null. The name is at most 20 characters (OpenAPI maxLength).
# The access token needs the backups write permission (a personal access token has it). The token is typed privately (never echoed), is
# never on a command line (curl reads it from a config on a pipe written by the shell builtin printf), and is cleared on any exit.
#
# ONE POST, never repeated: any answer other than 201 with the same name, a timeout, or a curl failure STOPS the script, and the point may
# or may not exist - do NOT run it again; OPS reads the state first. The GET is polled a bounded number of times; a failure to reach it is
# not a reason to POST again. Exit 0 only when the platform reports the named point AVAILABLE with a completed time on or after the
# selected time you type (the UTC time window-row4.sh stamped).
set -u
umask 077

ROOT="$HOME/hone-s1"
REF=alhhybgqdmcdyzpybykj
API=https://api.supabase.com
CURL=/usr/bin/curl
PROTO="--proto =https"
POLL_MAX=60
POLL_SLEEP=5
PHRASE="I AUTHORIZE ONE NAMED RESTORE POINT ON PROJECT $REF"

tok=""
cleanup() { tok=""; stty echo </dev/tty >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted; the token was cleared. If the POST had been sent the restore point may exist: do not re-run; tell OPS." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mask() { LC_ALL=C sed -E -e 's#sbp_[A-Za-z0-9_]+#<token>#g' -e 's#([Bb]earer) +[^ "]+#\1 <token>#g' -e 's#postgres(ql)?://[^ ]*#<url>#g'; }

[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
[ -x "$CURL" ] || die "$CURL not found"
command -v node >/dev/null 2>&1 || die "node not found (Node 18 or newer is used to read the JSON)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|CURL_[A-Z_]*|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for private entry"

cat >&2 <<MSG
This creates ONE named restore point on the hosted project $REF. It is a write on the provider side (a name in the WAL stream); it changes
no table or row. It runs once and is never repeated by this script.
To authorize it, type this line exactly (and nothing else):
  $PHRASE
MSG
IFS= read -r -p "> " typed </dev/tty || die "could not read the authorization"
[ "$typed" = "$PHRASE" ] || die "the authorization phrase did not match: nothing was sent"
iso='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
IFS= read -r -p "The selected time window-row4.sh printed (UTC, like 2026-10-26T14:30:00Z): " SEL </dev/tty || die "could not read the selected time"
printf '%s\n' "$SEL" | grep -Eq "$iso" || die "the selected time is not a UTC time (YYYY-MM-DDTHH:MM:SSZ): nothing was sent"
NOW=$(date -u +%s); SELS=$(node -e 'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)))' "$SEL") || die "cannot read the selected time"
[ "$SELS" -le $(( NOW + 60 )) ] || die "the selected time is in the future: nothing was sent"
[ $(( NOW - SELS )) -le 3600 ] || die "the selected time is more than 60 minutes old: run window-row4.sh again first; nothing was sent"
NAME="hs1-$(date -u +%Y%m%d%H%M%S)"
[ ${#NAME} -le 20 ] || die "internal: the restore point name is longer than 20 characters"
IFS= read -rs -p "Supabase access token (not shown): " tok </dev/tty || die "could not read the access token"
echo >&2
[ -n "$tok" ] || die "empty access token"

OUT=$(mktemp -d "$ROOT/restore-point.XXXXXX") || die "mktemp failed"
chmod 700 "$OUT" || die "chmod failed"
URL="$API/v1/projects/$REF/database/backups/restore-point"
http() { # http METHOD URL [BODYFILE] OUTFILE -> prints the HTTP status code (000 on a transport failure); token only via a config on a pipe
  m=$1; u=$2
  if [ "$m" = POST ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$tok" | "$CURL" -q -sS $PROTO --max-time 30 --config - -X POST -H 'Content-Type: application/json' --data-binary @"$3" -o "$4" -w '%{http_code}' "$u" 2>>"$OUT/curl.err"
  else
    printf 'header = "Authorization: Bearer %s"\n' "$tok" | "$CURL" -q -sS $PROTO --max-time 30 --config - -o "$4" -w '%{http_code}' "$u" 2>>"$OUT/curl.err"
  fi
}
printf '{"name":"%s"}' "$NAME" > "$OUT/post-body.json"
T0=$(utcnow)
echo "sending the ONE POST for restore point '$NAME' at $T0 (UTC)" >&2
code=$(http POST "$URL" "$OUT/post-body.json" "$OUT/post.json") || code=000
mask < "$OUT/curl.err" > "$OUT/curl.err.m" && mv "$OUT/curl.err.m" "$OUT/curl.err"
parse() { # parse FILE -> "name status completed_on_utc|null"
  node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!j || typeof j !== "object" || Array.isArray(j)) process.exit(2);
const c = j.completed_on == null ? "null" : (isNaN(Date.parse(j.completed_on)) ? "bad" : new Date(Date.parse(j.completed_on)).toISOString().replace(/\.\d+Z$/, "Z"));
process.stdout.write([String(j.name), String(j.status), c].join(" "));' "$1"
}
if [ "$code" != 201 ]; then
  head -c 300 "$OUT/post.json" 2>/dev/null | mask >&2; echo >&2
  tail -n 3 "$OUT/curl.err" >&2
  die "the POST answered HTTP $code (not 201). The restore point may or may not exist. Do NOT run this again; tell OPS. Evidence: $OUT"
fi
rp=$(parse "$OUT/post.json") || die "the POST answer is not the expected JSON. Do NOT run this again; tell OPS. Evidence: $OUT"
set -- $rp
[ "$1" = "$NAME" ] || die "the platform answered with another name. Do NOT run this again; tell OPS. Evidence: $OUT"
echo "created: name=$1 status=$2 (POST HTTP 201). Waiting for AVAILABLE (up to $POLL_MAX checks, $POLL_SLEEP s apart)." >&2

i=0; st="$2"; done_at="$3"
while [ "$st" = PENDING ] && [ $i -lt $POLL_MAX ]; do
  sleep "$POLL_SLEEP"; i=$((i+1))
  code=$(http GET "$URL?name=$NAME" "" "$OUT/get.json") || code=000
  if [ "$code" = 200 ]; then
    rp=$(parse "$OUT/get.json") || { echo "check $i: not the expected JSON" >&2; continue; }
    set -- $rp
    if [ "$1" != "$NAME" ]; then echo "check $i: another name in the answer" >&2; continue; fi
    st="$2"; done_at="$3"; echo "check $i: status=$st" >&2
  else
    echo "check $i: HTTP $code (the POST is NOT repeated)" >&2
  fi
done
mask < "$OUT/curl.err" > "$OUT/curl.err.m" && mv "$OUT/curl.err.m" "$OUT/curl.err"
T1=$(utcnow)
printf '{"restore_point_name":"%s","status":"%s","completed_on":"%s","post_http":201,"posted_at_utc":"%s","finished_at_utc":"%s","script_sha256":"%s"}\n' "$NAME" "$st" "$done_at" "$T0" "$T1" "$(sha "${BASH_SOURCE[0]}")" > "$OUT/restore-point.meta.json"
case "$st" in
  AVAILABLE) ;;
  PENDING) die "still PENDING after $POLL_MAX checks. Do NOT create another; tell OPS. Evidence: $OUT" ;;
  *) die "the platform reports status $st for $NAME. Do NOT create another without OPS. Evidence: $OUT" ;;
esac
case "$done_at" in null|bad|'') die "AVAILABLE but completed_on is $done_at. Tell OPS. Evidence: $OUT" ;; esac
DS=$(node -e 'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)))' "$done_at")
[ "$DS" -ge "$SELS" ] || die "completed_on $done_at is BEFORE the selected time $SEL: this point does not cover the selection. Do NOT use it as the basis; tell OPS. Evidence: $OUT"
echo "ROW 4 VALUES (basis named_restore_point): restore_point_name=$NAME  restore_point_status=AVAILABLE  restore_point_completed_at_utc=$done_at  (selected time $SEL)"
echo "RESTORE POINT CREATED AND AVAILABLE at $T1 (UTC). Evidence (private, mode 0700): $OUT"
exit 0
