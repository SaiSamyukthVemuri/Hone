#!/bin/bash
# Hone STAGE 0257-ONLINE: ONE standalone READ of the pinned g02-history-0257.sql (a023ca5e) through the verified runner run-window-read-macos.sh (471ecb9d), saved with its sidecar
# in a new $HOME/hone-s1/online.* directory. It is the fresh history read that s1-reconcile-0257-online.sh accepts on the NONE route when it was taken at least 1200 s after the APPLY-STATE marker.
# READ-ONLY: one SELECT over supabase_migrations.schema_migrations. No push, no settings write, no marker change. It may run while a marker exists (that is its purpose).
# Fail-closed: no retry; a failed login writes the FAILED-LOGIN tombstone. The access token and database password are typed hidden, once, and cleared.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
#CONST-BEGIN
PLAT_OS=Darwin
PLAT_ARCH=arm64
TTY=/dev/tty
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
RMANIFEST_SHA=92a0ca77298a9dfa6f7dfc7a875962d5334f91183aa118196c0ae6f3dfe3b476
SQL_G02=a023ca5e56d9832ca9495636cffbc43e51e02dbcc4bedd0b8bba7aeb3ef68ba4
#CONST-END
REF=alhhybgqdmcdyzpybykj
POOLER_URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
TOMB="$ROOT/s1-apply/FAILED-LOGIN"
WR="$ROOT/window-reads-0257"
F=g02-history-0257.sql
STEM=g02-history-0257

TOK=""; PW=""
cleanup() { TOK=""; PW=""; unset TOK PW SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; { [ ! -c "$TTY" ] || stty echo <"$TTY" >/dev/null 2>&1; } || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
strip() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1"; }
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#([Uu]ser|[Hh]ost|[Hh]ostaddr|[Dd]bname)=[^ ,)]*#\1=<masked>#g' -e 's#([Uu]ser|[Rr]ole) "[^"]*"#\1 <masked>#g' -e 's#[A-Za-z0-9.-]*\.supabase\.com[:0-9]*#<host>#g'; }
is_auth_failure() { strip "$1" | grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found'; }
tombstone() { mkdir -p "$ROOT/s1-apply" 2>/dev/null; printf 'failed login at %s in phase %s\n' "$(utcnow)" "$1" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2; }

[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(uname -s)" = "$PLAT_OS" ] && [ "$(uname -m)" = "$PLAT_ARCH" ] || die "not macOS arm64"
for t in shasum sed grep find mktemp cut tr; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
[ -r "$TTY" ] || die "no terminal for private entry"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] && [ -n "$(find "$ROOT" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || die "$ROOT is missing, a symlink, or not a private directory of yours"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -d "$WR" ] && [ ! -L "$WR" ] || die "$WR is missing or a symlink"
[ -f "$WR/run-window-read-macos.sh" ] && [ "$(sha "$WR/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner missing or sha256 mismatch"
[ -f "$WR/MANIFEST.sha256" ] && [ "$(sha "$WR/MANIFEST.sha256")" = "$RMANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
[ -f "$WR/$F" ] && [ ! -L "$WR/$F" ] && [ "$(sha "$WR/$F")" = "$SQL_G02" ] || die "$F is missing or is not the pinned query"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run. Nothing was attempted."; fi

D=$(mktemp -d "$ROOT/online.XXXXXX") || die "mktemp failed"
chmod 700 "$D" || die "chmod failed"
LINK="$D/linked"; RES="$D/results"; LOGS="$D/logs"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" || die "mkdir failed"
chmod 700 "$LINK" "$RES" "$LOGS" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"
[ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact (no trailing newline)"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"

IFS= read -rs -p "Supabase access token (not shown): " TOK <"$TTY" || die "could not read the access token"
echo >&2
[ -n "$TOK" ] || die "empty access token"
IFS= read -rs -p "Database password (not shown; only its presence is used here): " PW <"$TTY" || die "could not read the password"
echo >&2
[ -n "$PW" ] || die "empty password"

rc=0
( export SUPABASE_ACCESS_TOKEN="$TOK" SUPABASE_DB_PASSWORD="$PW"; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
    SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$WR/run-window-read-macos.sh" "$F" ) </dev/null 2>"$LOGS/$STEM.err" || rc=$?
mask < "$LOGS/$STEM.err" > "$LOGS/$STEM.err.m" 2>/dev/null && mv -f "$LOGS/$STEM.err.m" "$LOGS/$STEM.err"
if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$STEM.err"; then tombstone g02-read; die "the CLI reported a login-role / ban / password path; recorded in $TOMB; REPORT it (log: $LOGS/$STEM.err)"; fi
if [ "$rc" != 0 ]; then
  tail -n 5 "$LOGS/$STEM.err" >&2
  if is_auth_failure "$LOGS/$STEM.err"; then tombstone g02-read; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; fi
  die "the g02 read failed (exit $rc). Not retried. Log: $LOGS/$STEM.err"
fi
r="$RES/$STEM.json"; m="$RES/$STEM.meta.json"
[ -f "$r" ] && [ ! -L "$r" ] && [ -f "$m" ] && [ ! -L "$m" ] && [ "$(grep -c '' "$m")" = 1 ] || die "result or sidecar missing"
rs=$(sha "$r")
printf '%s\n' "$(cat "$m")" | grep -Eqx "\\{\"file\":\"$F\",\"sql_sha256\":\"$SQL_G02\",\"result_sha256\":\"$rs\",\"started_at_utc\":\"$iso\",\"captured_at_utc\":\"$iso\",\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\",\"manifest_sha256\":\"$RMANIFEST_SHA\"\\}" \
  || die "the sidecar does not bind this result (file, sql, result hash, exit code, runner or manifest)"
c=$(LC_ALL=C tr -d '[:space:]' < "$r")
case "$c" in "[{"*"}]") ;; *) die "the result is not a non-empty JSON array of objects" ;; esac
echo "g02 history read saved: $D (result sha256 $rs, captured $(sed -E 's/.*"captured_at_utc":"([^"]*)".*/\1/' "$m"))." >&2
printf '%s' "$c" | grep -Eo '"(applied_count|hosted_max|versions_ge_0249)":"?[0-9]+"?' | tr '\n' ' ' >&2; echo >&2
echo "This read is evidence for s1-reconcile-0257-online.sh only if it was taken at least 1200 s after the marker. Next: run s1-reconcile-0257-online.sh (no connection, no credentials)." >&2
exit 0
