#!/bin/bash
# Hone S0B-DIAG: ONE read-only names-only diagnostic of every event trigger in production (identity, not source). Production only.
# Runs d1-event-trigger-identity.sql once through the verified runner (471ecb9d) and supabase-go dce26b75. No retry. Credentials are typed
# privately (never echoed, never on a command line, never written) and cleared on any exit. A failed login writes the FAILED-LOGIN
# tombstone (same rule as the other S0b scripts) and stops; while a tombstone exists here or in ~/hone-s1/s0b the script will not run.
# It prints one line per event trigger: names, an md5 of the function source and booleans. No source text.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
D="$ROOT/s0b-diag"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=4ddb357e0f70cde550e81935adae9d326072a014ac4658e34d41049d3eb4f257
PROD_REF=alhhybgqdmcdyzpybykj
TOMB="$D/FAILED-LOGIN"
TOMB2="$ROOT/s0b/FAILED-LOGIN"

cleanup() { unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; stty echo </dev/tty >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
is_auth_failure() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1" | grep -qiE 'authenticat|28P01|28000|password authentication|banned|circuit|SASL|tenant or user not found'; }
tombstone() { # written BEFORE dying: the UTC time, no secret
  printf 'failed login at %s in s0b-diag\n' "$(utcnow)" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
  [ ! -d "$ROOT/s0b" ] || printf 'failed login at %s in s0b-diag\n' "$(utcnow)" > "$TOMB2" 2>/dev/null || true
}

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
for t in shasum node sed grep tr cut; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$D/run-window-read-macos.sh" ] && [ "$(sha "$D/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner missing or sha256 mismatch"
[ -f "$D/MANIFEST.sha256" ] && [ "$(sha "$D/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
oks=$(cd "$D" && shasum -a 256 -c MANIFEST.sha256) || die "d1-event-trigger-identity.sql does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 1 ] || die "MANIFEST.sha256 did not verify exactly 1 pinned file"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for private entry"
for t in "$TOMB" "$TOMB2"; do
  if [ -e "$t" ] || [ -L "$t" ]; then die "a previous run failed a login ($t exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."; fi
done

WORK=$(mktemp -d "$ROOT/s0b-diag-run.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" || die "mkdir failed"
POOLER_URL="postgresql://postgres.$PROD_REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
printf '%s\n' "$PROD_REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"   # no trailing newline (incident 2026-10-25)
[ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"

IFS= read -rs -p "Supabase access token (not shown): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"; echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "PRODUCTION database password (not shown): " SUPABASE_DB_PASSWORD </dev/tty || die "could not read the password"; echo >&2
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"

f=d1-event-trigger-identity.sql; stem=${f%.sql}; rc=0
( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$PROD_REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
    SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$D/run-window-read-macos.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then tombstone; die "the CLI reported a login-role / ban / password path; tombstone written; stopped and REPORT it (log: $LOGS/$stem.err)"; fi
if [ "$rc" != 0 ] && is_auth_failure "$LOGS/$stem.err"; then tombstone; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; die "authentication failed; stopped"; fi
[ "$rc" = 0 ] || { tail -n 5 "$LOGS/$stem.err" >&2; die "$f failed (exit $rc): a refusal or an invalid result. Not retried."; }
r="$RES/$stem.json"; m="$RES/$stem.meta.json"
[ -f "$r" ] && [ -f "$m" ] || die "result or sidecar missing"
rs=$(sha "$r"); line=$(cat "$m")
printf '%s\n' "$line" | grep -Eq "\"sql_sha256\":\"$(awk '$2 == "d1-event-trigger-identity.sql" {print $1}' "$D/MANIFEST.sha256")\",\"result_sha256\":\"$rs\"" || die "the sidecar does not bind this result"
printf '%s\n' "$line" | grep -Eq "\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\"" || die "the sidecar does not name the pinned runner and exit 0"
echo "ok d1-event-trigger-identity.sql (result sha256 $rs)" >&2
node -e '
const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cols = ["evtname","evtevent","evtenabled","evttags_count","trigger_owner_role","function_name","function_owner_role","language","function_is_extension_member","prosrc_md5","source_mentions_callout","source_mentions_enable_rls","source_has_execute_dynamic","is_exact_platform_name"];
console.log(`event triggers: ${rows.length}`);
for (const r of rows) console.log(cols.map((c) => `${c}=${r[c]}`).join(" "));
console.log(`S0B DIAG DONE: ${rows.length} event trigger(s); names, hashes and booleans only. Result: ${process.argv[1]}`);' "$r" </dev/null || die "could not print the result"
