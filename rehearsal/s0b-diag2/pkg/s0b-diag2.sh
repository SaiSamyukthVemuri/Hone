#!/bin/bash
# Hone S0B-DIAG2: ONE read-only read of the definition of the platform function public.rls_auto_enable() and its ensure_rls trigger. Production only.
# It refuses unless the returned prosrc md5 equals EXPECT_MD5, and prints only the md5 (never the definition) if the definition mentions password, secret, token or key=. Production only.
# Runs d2-ensure-rls-definition.sql once through the verified runner (471ecb9d) and supabase-go dce26b75. No retry. Credentials are typed
# privately (never echoed, never on a command line, never written) and cleared on any exit. A failed login writes the FAILED-LOGIN
# tombstone (same rule as the other S0b scripts) and stops; while a tombstone exists here or in ~/hone-s1/s0b the script will not run.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
D="$ROOT/s0b-diag2"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=bd5c6dd6790f97d2c8ac378fd2f45a3bc12a5d0d2ad5cccab658771eec30068d
EXPECT_MD5=99be20677b456ea8d3be47bdd44fb369   # prosrc md5 of public.rls_auto_enable() the earlier diagnostic returned
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
  printf 'failed login at %s in s0b-diag2\n' "$(utcnow)" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
  [ ! -d "$ROOT/s0b" ] || printf 'failed login at %s in s0b-diag2\n' "$(utcnow)" > "$TOMB2" 2>/dev/null || true
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
oks=$(cd "$D" && shasum -a 256 -c MANIFEST.sha256) || die "d2-ensure-rls-definition.sql does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 1 ] || die "MANIFEST.sha256 did not verify exactly 1 pinned file"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for private entry"
for t in "$TOMB" "$TOMB2" "$ROOT/s0b-diag/FAILED-LOGIN"; do
  if [ -e "$t" ] || [ -L "$t" ]; then die "a previous run failed a login ($t exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."; fi
done

WORK=$(mktemp -d "$ROOT/s0b-diag2-run.XXXXXX") || die "mktemp failed"
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

f=d2-ensure-rls-definition.sql; stem=${f%.sql}; rc=0
( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$PROD_REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
    SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$D/run-window-read-macos.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then tombstone; die "the CLI reported a login-role / ban / password path; tombstone written; stopped and REPORT it (log: $LOGS/$stem.err)"; fi
if [ "$rc" != 0 ] && is_auth_failure "$LOGS/$stem.err"; then tombstone; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; die "authentication failed; stopped"; fi
[ "$rc" = 0 ] || { tail -n 5 "$LOGS/$stem.err" >&2; die "$f failed (exit $rc): a refusal or an invalid result. Not retried."; }
r="$RES/$stem.json"; m="$RES/$stem.meta.json"
[ -f "$r" ] && [ -f "$m" ] || die "result or sidecar missing"
rs=$(sha "$r"); line=$(cat "$m")
printf '%s\n' "$line" | grep -Eq "\"sql_sha256\":\"$(awk '$2 == "d2-ensure-rls-definition.sql" {print $1}' "$D/MANIFEST.sha256")\",\"result_sha256\":\"$rs\"" || die "the sidecar does not bind this result"
printf '%s\n' "$line" | grep -Eq "\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\"" || die "the sidecar does not name the pinned runner and exit 0"
echo "ok d2-ensure-rls-definition.sql (result sha256 $rs)" >&2
node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const want = process.argv[2];
if (!Array.isArray(rows) || rows.length !== 1) { console.log("STOP: expected exactly 1 row, got " + (Array.isArray(rows) ? rows.length : "a non-array")); process.exit(3); }
const r = rows[0];
const md5 = String(r.prosrc_md5);
if (md5 !== want) { console.log("STOP: prosrc_md5 " + md5 + " is not the expected " + want + "; the definition is not shown"); process.exit(3); }
const def = String(r.definition);
if (/password|secret|token|key=/i.test(def)) { console.log("STOP: the definition mentions password, secret, token or key=; only the md5 is shown: " + md5); process.exit(3); }
console.log("prosrc_md5=" + md5 + " (matches the expected)");
for (const c of ["security_definer","proconfig","provolatile","evttags","evtenabled","evtowner_role","anon_can_run","authenticated_can_run","service_role_can_run"]) console.log(c + "=" + r[c]);
console.log("----- definition -----");
console.log(def);
console.log("----- end definition -----");
console.log("S0B DIAG2 DONE: 1 row; md5 matches. Result: " + process.argv[1]);' "$r" "$EXPECT_MD5" </dev/null || die "the result was refused (see the line above)"
