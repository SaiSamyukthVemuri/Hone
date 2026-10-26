#!/bin/bash
# Hone S0b VALIDATION: read the same counts and fingerprints from PRODUCTION (rows created at or before the recovery time T)
# and from the RESTORED project (at T and unfiltered), then let the pinned comparator say S0B PASS or S0B FAIL.
# Read-only. Fail-closed: the first failed command, refusal, authentication error or invalid result stops. No retries.
# Credentials are typed privately (never echoed, never on a command line, never written) and cleared on any exit.
# Nothing here creates a login role, resets a password or unbans an IP: PREVENTION is the runner's password-present rule.
# The restored project is a NEW project: its URL, API keys and database password are new and are used for nothing but these
# reads. They are never put in Vercel, a webhook, Stripe, Google or any config file, and nothing is pointed at it.
# Exit 0 ONLY after the comparator prints the exact last line  S0B PASS .
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
S0B="$ROOT/s0b"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=e5a5f9a0e7842f9a20d282c0d3bd3313e0ec67ae111a4194f79c0609db07fa70
CMP_SHA=a54ce2e45d2c6c322ca08df61f291663baaf39726ac8f8f6bb3b1e2cc233a958
PROD_REF=alhhybgqdmcdyzpybykj
FAR=9999-12-31T00:00:00Z
TOMB="$S0B/FAILED-LOGIN"
VFILES="v1-history.sql v2-catalog.sql v3-studio-counts.sql v4-orphans.sql v5-recovery-point.sql v6-storage-meta.sql v7-id-digests.sql v8-id-buckets.sql"
FFILES="v3-studio-counts.sql v4-orphans.sql v5-recovery-point.sql v6-storage-meta.sql"

cleanup() {
  unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD PW_PROD PW_REST
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
is_auth_failure() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1" | grep -qiE 'authenticat|28P01|28000|password authentication|banned|circuit|SASL|tenant or user not found'; }
tombstone() { # written BEFORE dying on an authentication failure: the UTC time and the run name, no secret
  printf 'failed login at %s in run %s\n' "$(utcnow)" "$1" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
}

# ---- Part 0: this Mac, the verified tools, a clean environment (NAMES only), fresh private dirs ---------------------
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found (the comparator needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$S0B/run-window-read-macos.sh" ] && [ "$(sha "$S0B/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner missing or sha256 mismatch"
[ -f "$S0B/MANIFEST.sha256" ] && [ "$(sha "$S0B/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
oks=$(cd "$S0B" && shasum -a 256 -c MANIFEST.sha256) || die "a pinned template does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 19 ] || die "MANIFEST.sha256 did not verify exactly 19 pinned files"
[ -f "$S0B/s0b-compare.mjs" ] && [ "$(sha "$S0B/s0b-compare.mjs")" = "$CMP_SHA" ] || die "comparator missing or sha256 mismatch"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for private entry"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then
  die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."
fi

ask() { local _v; IFS= read -r -p "$2" _v </dev/tty || die "could not read $1"; printf -v "$1" '%s' "$_v"; }
utc_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq "^$iso\$"; }

# ---- Part 1: what the operator types (non-secret), all BEFORE any hosted read -------------------------------------
echo "The time now is $(utcnow). Times are UTC, like 2026-10-27T01:00:00Z." >&2
ask T "Recovery timestamp T you gave the restore (UTC): "; utc_ok "$T" || die "T is not YYYY-MM-DDTHH:MM:SSZ"
[ "$T" \> 2026-01-01T00:00:00Z ] && [ "$T" \< "$(utcnow)" ] || die "T must be after 2026-01-01 and in the past"
ask REST_REF "Project ref of the RESTORED project (20 lower-case letters, from its dashboard URL): "
printf '%s' "$REST_REF" | LC_ALL=C grep -Eq '^[a-z]{20}$' || die "the restored ref is not 20 lower-case letters"
[ "$REST_REF" != "$PROD_REF" ] || die "the restored ref equals the production ref: this must be the NEW project"
LAST4=${REST_REF#????????????????}
echo "You typed a restored project ref ending in  $LAST4 . Production ends in  ${PROD_REF#????????????????} ." >&2
ask REF4 "Type the last 4 characters of the RESTORED project ref again to confirm it is the NEW project: "; [ "$REF4" = "$LAST4" ] || die "the last 4 characters do not match what you typed; stopped before any read"
echo "The runner only accepts the session pooler  aws-1-us-east-1.pooler.supabase.com:5432  with user  postgres.<ref> ." >&2
echo "Open the restored project, Connect, Session pooler, and read the host. If it is any other host, STOP: do not work around it." >&2
ask PHOST "Type yes only if the restored project's session pooler host is exactly aws-1-us-east-1.pooler.supabase.com: "; [ "$PHOST" = yes ] || die "restored pooler host not confirmed (the runner would refuse); stopped"
ask NEWP "Type yes: the restored project is a NEW project whose URL, keys and password are used for these reads only and are configured nowhere: "; [ "$NEWP" = yes ] || die "not confirmed"

WORK=$(mktemp -d "$ROOT/s0b-validate.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
mkdir -p "$WORK/logs" || die "mkdir failed"
mklink() { # mklink DIR REF
  mkdir -p "$1/supabase/.temp" || die "mkdir failed"
  chmod 700 "$1" || die "chmod failed"
  local url="postgresql://postgres.$2@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
  printf '%s\n' "$2" > "$1/supabase/.temp/project-ref" || die "write project-ref failed"
  # pooler-url WITHOUT a trailing newline: supabase-go v2.102.0 reads this file verbatim (incident 2026-10-25).
  printf '%s' "$url" > "$1/supabase/.temp/pooler-url" || die "write pooler-url failed"
  [ "$(cat "$1/supabase/.temp/pooler-url")" = "$url" ] && [ "$(wc -c < "$1/supabase/.temp/pooler-url" | tr -d ' ')" = "${#url}" ] || die "pooler-url is not byte-exact (no trailing newline)"
  printf '%s\n' v2.102.0 > "$1/supabase/.temp/cli-latest" || die "write cli-latest failed"
}
mklink "$WORK/link-prod" "$PROD_REF"
mklink "$WORK/link-rest" "$REST_REF"

IFS= read -rs -p "Supabase access token (not shown; the same account owns both projects): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"; echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "RESTORED project database password (not shown; set when the restore was created): " PW_REST </dev/tty || die "could not read the password"; echo >&2
IFS= read -rs -p "PRODUCTION database password (not shown): " PW_PROD </dev/tty || die "could not read the password"; echo >&2
[ -n "$PW_PROD" ] || die "empty production password"
[ -n "$PW_REST" ] || die "empty restored password"

# ---- Part 2: one run = generated dir (runner copy, files with T substituted, manifest) + result dir -----------------
do_run() { # do_run NAME LINKDIR REF PW TVALUE FILES...
  local name=$1 link=$2 ref=$3 pw=$4 tv=$5; shift 5
  local gen="$WORK/$name/gen" res="$WORK/$name/res" f stem rc r m line rs
  mkdir -p "$gen" "$res" || die "mkdir failed"
  cp "$S0B/run-window-read-macos.sh" "$gen/" || die "copy runner failed"
  [ "$(sha "$gen/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "the runner copy is not byte-identical"
  for f in "$@"; do
    if grep -q '@@T@@' "$S0B/$f"; then sed "s/@@T@@/$tv/g" "$S0B/$f" > "$gen/$f" || die "substitution failed"; else cp "$S0B/$f" "$gen/$f" || die "copy failed"; fi
  done
  (cd "$gen" && shasum -a 256 "$@" > MANIFEST.sha256) || die "manifest failed"
  for f in "$@"; do
    stem=${f%.sql}; rc=0
    ( export SUPABASE_ACCESS_TOKEN; export SUPABASE_DB_PASSWORD="$pw"; cd "$link" && env HONE_WINDOW_PROJECT_REF="$ref" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$res" \
        SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$gen/run-window-read-macos.sh" "$f" ) </dev/null 2>"$WORK/logs/$name-$stem.err" || rc=$?
    if grep -qiE 'login role|unban|network.?ban|reset.*password' "$WORK/logs/$name-$stem.err"; then
      tombstone "$name"; echo "A login-role / ban path was recorded in $TOMB: no further run is allowed until Sam decides." >&2
      die "$name $f: the CLI reported a login-role / ban / password path; stopped and REPORT it (log: $WORK/logs/$name-$stem.err)"
    fi
    if [ "$rc" != 0 ] && is_auth_failure "$WORK/logs/$name-$stem.err"; then tombstone "$name"; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; fi
    if [ "$rc" != 0 ]; then tail -n 5 "$WORK/logs/$name-$stem.err" >&2; die "$name $f failed (exit $rc): authentication error, refusal or invalid result. Nothing after it was run."; fi
    r="$res/$stem.json"; m="$res/$stem.meta.json"
    [ -f "$r" ] && [ -f "$m" ] || die "$name $f: result or sidecar missing"
    rs=$(sha "$r"); line=$(cat "$m")
    printf '%s\n' "$line" | grep -Eq "\"result_sha256\":\"$rs\"" || die "$name $f: the sidecar does not bind this result"
    echo "ok $name $f (result sha256 $rs)" >&2
    if [ "$name" = prod ] && [ "$f" = v1-history.sql ]; then
      c=$(LC_ALL=C tr -d '[:space:]' < "$r")
      printf '%s' "$c" | grep -q '"hosted_max":"0212"' || die "production history max is not 0212: this check is valid only BEFORE S1; stopped"
    fi
  done
}
echo "Restored project, rows created at or before T = $T" >&2
do_run rest "$WORK/link-rest" "$REST_REF" "$PW_REST" "$T" $VFILES
echo "Restored project, unfiltered (T replaced by $FAR)" >&2
do_run restfar "$WORK/link-rest" "$REST_REF" "$PW_REST" "$FAR" $FFILES
echo "Production (read LAST, so a swapped password or ref fails on the new project first), rows created at or before T = $T" >&2
do_run prod "$WORK/link-prod" "$PROD_REF" "$PW_PROD" "$T" $VFILES
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD PW_PROD PW_REST

# ---- Part 3: the pinned comparator, its verdict printed verbatim; exit 0 ONLY on the exact last line S0B PASS ------
VERDICT="$WORK/verdict.txt"; crc=0
node "$S0B/s0b-compare.mjs" --templates "$S0B" --t "$T" --prod "$WORK/prod" --rest "$WORK/rest" --rest-far "$WORK/restfar" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
if [ "$crc" = 0 ] && [ "$(tail -n 1 "$VERDICT")" = "S0B PASS" ] && ! grep -q '^S0B FAIL' "$VERDICT"; then
  echo "S0B PASS. Results and verdict are in $WORK. The restored project is still running: delete it only on Sam's instruction." >&2
  exit 0
fi
die "the comparator did not print S0B PASS (exit $crc). The restore is NOT validated. Evidence is in $WORK"
