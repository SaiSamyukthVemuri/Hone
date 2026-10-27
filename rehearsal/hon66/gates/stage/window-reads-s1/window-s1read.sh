#!/bin/bash
# LINUX VARIANT of the reviewed Mac script (HON66-LINUX-GATES), derived by machines/linux-gates/make-linux.py with a fixed substitution
# list (see LINUX-DIFFS.txt). The PAT arrives on fd 3 from hone-release; no database password is read (fixed non-secret placeholder); nothing is prompted or on argv.
# Hone #1035 S1 READ-BACK (GO-REQUEST section 8 row 6): after s1-apply.sh, read the hosted project's migration history,
# object census, privilege closures and replaced function bodies through the verified runner ec9b7c56 and supabase-go
# 174a90e2, then run the pinned comparator (compare-preflight.mjs --stage s1) and print its verdict.
# Read-only. Fail-closed: the first failed command, refusal, authentication error, invalid result or non-PASS stops.
# No retries. The PAT arrives on fd 3 from hone-release (never printed, never on a command line, never written) and cleared on any
# exit. Nothing here creates a login role, resets a password or unbans an IP: PREVENTION is the runner's password-present
# rule; the log scan below is only a detector after the fact (a hit is REPORTED, never retried).
# A failed login writes a tombstone (s1-read/FAILED-LOGIN, no secret) and every later run refuses until Sam decides.
# Exit 0 ONLY after the comparator prints the exact line "OVERALL PASS". That is read-back evidence; it does not promote.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
WR="$ROOT/window-reads"          # comparator, lib and baseline (installed by the S0a download)
WR1="$ROOT/window-reads-s1"      # this script, the runner copy, the S1 gate files and their manifest
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
RUNNER_SHA=ec9b7c568a69d3b776ee9c643bcb52eb567639ab9cb0c995b33f59cf6d974468
MANIFEST_SHA=7862f780cf391cc942386a85f2b31597873cd2c727a7e5cc20a22f11a732b477
CMP_SHA=147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058
LIB_SHA=636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9
BASELINE=BASELINE-W1-LINUX-CANDIDATE-3.json
BASELINE_SHA=ef91480a6457965a32dbb369a4ab9a5b76aba42e3c665262abb779055611b005
REF=alhhybgqdmcdyzpybykj
POOLER_URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
TOMB="$ROOT/s1-read/FAILED-LOGIN"
FILES="s1-history.sql census-0213-0246.sql s1-g10.sql s1-closures.sql s1-table-privileges.sql s1-body-md5.sql"
NFILES=6

# The PAT arrives on FILE DESCRIPTOR 3, opened by hone-release (root-owned custody layer); it is never a file this script opens, never an
# argument, never in the environment. There is no database-password input: reads use a FIXED, NON-SECRET placeholder only so that the
# CLI never creates a login role (HON66-PROOF M9; the CI proves the read path never authenticates with it).
READ_PW_PLACEHOLDER="hone-read-placeholder-not-a-secret"
# secret_from_fd3 VAR LABEL: exactly one non-empty line of at most 4096 bytes on fd 3, then fd 3 is closed. Nothing is printed.
secret_from_fd3() {
  local _v="" _x="" _l="$2"
  { true <&3; } 2>/dev/null || die "fd 3 is not open (hone-release passes the $_l on fd 3)"
  IFS= read -r -n 4097 <&3 _v || [ -n "$_v" ] || die "could not read the $_l from fd 3"
  if IFS= read -r -t 1 -n 1 _x <&3; then die "fd 3 holds more than one line or more than 4096 bytes"; fi
  exec 3<&-
  [ -n "$_v" ] || die "the $_l on fd 3 is empty"
  [ "${#_v}" -le 4096 ] || die "the $_l on fd 3 is longer than 4096 bytes"
  printf -v "$1" '%s' "$_v"
}

cleanup() {
  unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared. Do not retry; do not reset the password; do not unban." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { sha256sum -- "$1" | cut -d' ' -f1; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
strip() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1"; }
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#([Uu]ser|[Hh]ost|[Hh]ostaddr|[Dd]bname)=[^ ,)]*#\1=<masked>#g' -e 's#([Uu]ser|[Rr]ole) "[^"]*"#\1 <masked>#g' -e 's#[A-Za-z0-9.-]*\.supabase\.com[:0-9]*#<host>#g'; }
# the CLI's stderr may quote a connection URL: it is masked in place before anything reads or keeps it
mask_file() { mask < "$1" > "$1.m" && mv "$1.m" "$1"; }
is_auth_failure() { strip "$1" | grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found'; }
tombstone() { # tombstone FILE: written BEFORE dying on a failed login; holds the UTC time and the file name, no secret
  mkdir -p "$ROOT/s1-read" 2>/dev/null
  printf 'failed login at %s on file %s\n' "$(utcnow)" "$1" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
}
NOLOGIN="STOP HERE: do not retry; do not reset the password; do not unban. Close this Terminal and report the STOP line above."

# ---------------------------------------------------------------------------------------------------------
# Part 0: this Mac, the verified tools, a clean environment (NAMES only, never values), fresh private dirs
# ---------------------------------------------------------------------------------------------------------
[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "not Linux x86_64 (the pinned supabase-go is linux_amd64)"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then
  die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."
fi
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found"
command -v node >/dev/null 2>&1 || die "node not found (the comparator needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the installer check first)"
[ -f "$WR1/run-window-read.sh" ] && [ "$(sha "$WR1/run-window-read.sh")" = "$RUNNER_SHA" ] || die "runner copy missing or sha256 mismatch"
[ -f "$WR1/MANIFEST.sha256" ] && [ "$(sha "$WR1/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "S1 manifest missing or sha256 mismatch"
oks=$(cd "$WR1" && sha256sum -c MANIFEST.sha256) || die "an S1 gate file does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = "$NFILES" ] || die "MANIFEST.sha256 did not verify exactly $NFILES gate files"
for f in $FILES; do awk -v f="$f" '$2 == f {n++} END {exit n == 1 ? 0 : 1}' "$WR1/MANIFEST.sha256" || die "$f is not listed exactly once in the S1 manifest"; done
[ -f "$WR/compare-preflight.mjs" ] && [ "$(sha "$WR/compare-preflight.mjs")" = "$CMP_SHA" ] || die "comparator entry missing or sha256 mismatch"
[ -f "$WR/compare-preflight-lib.mjs" ] && [ "$(sha "$WR/compare-preflight-lib.mjs")" = "$LIB_SHA" ] || die "comparator lib missing or sha256 mismatch"
[ -f "$WR/$BASELINE" ] && [ "$(sha "$WR/$BASELINE")" = "$BASELINE_SHA" ] || die "baseline $BASELINE missing or sha256 mismatch"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
WORK=$(mktemp -d "$ROOT/s1read.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"

# The ORIGINAL Linux runner (run-window-read.sh, unchanged) calls `npx --yes supabase@2.102.0 db query ...`, which would download and run
# unverified bytes. This shim is first on PATH for that one child: it accepts ONLY that exact invocation, requires a non-empty database
# password (the password-present rule that prevents the CLI's hosted login-role write), re-checks the pinned supabase-go sha256 and execs it.
SHIM="$WORK/shim"; mkdir -p "$SHIM" && chmod 700 "$SHIM" || die "mkdir shim failed"
cat > "$SHIM/npx" <<'SHIMEOF'
#!/bin/bash
GO_SHA=@GO_SHA@
[ "$#" -eq 9 ] && [ "$1" = --yes ] && [ "$2" = supabase@2.102.0 ] && [ "$3" = db ] && [ "$4" = query ] && [ "$5" = --linked ] && [ "$6" = -o ] && [ "$7" = json ] && [ "$8" = -f ] || { echo "npx shim: REFUSED: not the reviewed db query invocation" >&2; exit 97; }
[ -n "${SUPABASE_DB_PASSWORD:-}" ] || { echo "npx shim: REFUSED: no database password (it would let the CLI create a login role)" >&2; exit 97; }
[ -n "${HONE_SUPABASE_BIN:-}" ] && [ -f "$HONE_SUPABASE_BIN" ] && [ "$(sha256sum "$HONE_SUPABASE_BIN" | cut -d' ' -f1)" = "$GO_SHA" ] || { echo "npx shim: REFUSED: supabase-go missing or sha256 mismatch" >&2; exit 97; }
exec env -u GITHUB_TOKEN -u GH_TOKEN "$HONE_SUPABASE_BIN" --agent no db query --linked -o json -f "$9"
SHIMEOF
sed -i "s/@GO_SHA@/$GO_SHA/" "$SHIM/npx" && chmod 700 "$SHIM/npx" || die "shim write failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"; TMPD="$WORK/tmp"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" "$TMPD" || die "mkdir failed"
chmod 700 "$LINK" "$RES" "$LOGS" "$TMPD" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
# pooler-url WITHOUT a trailing newline (supabase-go v2.102.0 reads it verbatim; see window-s0a.sh).
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"
[ "$(cat "$LINK/supabase/.temp/pooler-url")" = "$POOLER_URL" ] && [ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact (no trailing newline)"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ "$(cat "$LINK/supabase/.temp/cli-latest")" = v2.102.0 ] || die "cli-latest is not v2.102.0"
T_START=$(utcnow)
echo "S1 read-back started at $T_START (UTC). The PAT arrives on fd 3; nothing is typed. Record the start and end times: the gap read must run within 24 h of S1." >&2

# ---------------------------------------------------------------------------------------------------------
# credentials, privately (never echoed; cleared by the EXIT/INT/TERM/HUP trap)
# ---------------------------------------------------------------------------------------------------------
secret_from_fd3 SUPABASE_ACCESS_TOKEN "access token"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
SUPABASE_DB_PASSWORD="$READ_PW_PLACEHOLDER"
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"

# ---------------------------------------------------------------------------------------------------------
# Part 1: the six files, one at a time; validate each result and sidecar before the next. No retries.
# ---------------------------------------------------------------------------------------------------------
n=0
for f in $FILES; do
  stem=${f%.sql}
  want_sql=$(awk -v f="$f" '$2 == f {print $1}' "$WR1/MANIFEST.sha256")
  [ -n "$want_sql" ] || die "$f is not in the manifest"
  rc=0
  ( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
      SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PATH="$SHIM:$PATH" /bin/bash "$WR1/run-window-read.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
  mask_file "$LOGS/$stem.err" || die "could not mask the log of $f"
  if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then
    tombstone "$f"
    die "$f: the CLI reported a login-role / ban / password path; recorded in $TOMB and stopped; REPORT it (log: $LOGS/$stem.err). $NOLOGIN"
  fi
  if grep -qiE 'permission denied|42501' "$LOGS/$stem.err"; then
    die "$f: a permission refusal was reported (denial); stopped (log: $LOGS/$stem.err)"
  fi
  if [ "$rc" != 0 ]; then
    if is_auth_failure "$LOGS/$stem.err"; then
      tombstone "$f"
      strip "$LOGS/$stem.err" | tail -n 4 | mask >&2
      die "$f: an authentication failure was recorded in $TOMB. $NOLOGIN"
    fi
    tail -n 5 "$LOGS/$stem.err" | mask >&2
    die "$f failed (exit $rc): a refusal, a guard (division by zero means the history max is not 0246) or an invalid result. Nothing after it was run."
  fi
  r="$RES/$stem.json"; m="$RES/$stem.meta.json"
  [ -f "$r" ] && [ -f "$m" ] || die "$f: result or sidecar missing"
  c=$(LC_ALL=C tr -d '[:space:]' < "$r")
  case "$c" in "[{"*"}]") ;; *) die "$f: the result is not a non-empty JSON array of objects" ;; esac
  rs=$(sha "$r")
  [ "$(grep -c '' "$m")" = 1 ] || die "$f: the sidecar is not exactly one line"
  line=$(cat "$m")
  printf '%s\n' "$line" | grep -Eqx "\\{\"file\":\"$f\",\"sql_sha256\":\"$want_sql\",\"result_sha256\":\"$rs\",\"started_at_utc\":\"$iso\",\"captured_at_utc\":\"$iso\",\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\",\"manifest_sha256\":\"$MANIFEST_SHA\"\\}" \
    || die "$f: the sidecar does not bind this result (file, sql, result hash, exit code, runner or manifest)"
  st=$(printf '%s' "$line" | sed -E 's/.*"started_at_utc":"([^"]*)".*/\1/'); ca=$(printf '%s' "$line" | sed -E 's/.*"captured_at_utc":"([^"]*)".*/\1/')
  [ "$st" \< "$ca" ] || [ "$st" = "$ca" ] || die "$f: capture time precedes start time"
  if [ "$f" = s1-history.sql ]; then
    # The history is read FIRST. If it is not exactly the S1 end state, nothing else is read: the guarded files would refuse.
    printf '%s' "$c" | grep -Eq '"applied_count":"?245"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0246"' \
      && printf '%s' "$c" | grep -Eq '"distinct_versions_ge_0213":"?34"?[,}]' && printf '%s' "$c" | grep -Eq '"versions_ge_0213":"?34"?[,}]' \
      && printf '%s' "$c" | grep -Eq '"versions_0213_0246_once_each":"?34"?[,}]' && printf '%s' "$c" | grep -Eq '"versions_above_0246":"?0"?[,}]' \
      || die "s1-history: the history is not exactly 245 rows, max 0246, 0213..0246 once each, nothing above. S1 did not reach its end state. Do NOT promote. Nothing else was read; report this result: $r"
  fi
  n=$((n+1))
  echo "ok $n/$NFILES $f (result sha256 $rs)" >&2
done
[ "$n" = "$NFILES" ] || die "only $n of $NFILES files completed"
extra=$(cd "$RES" && ls -A | grep -vE '\.(meta\.)?json$' || true)
[ -z "$extra" ] || die "unexpected files in the results directory: $extra"
[ "$(cd "$RES" && ls -A | wc -l | tr -d ' ')" = $((NFILES * 2)) ] || die "the results directory does not hold exactly the $NFILES results and $NFILES sidecars"
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
echo "Captured and validated: $NFILES results + $NFILES sidecars. Assembling the read-back and running the comparator." >&2

# ---------------------------------------------------------------------------------------------------------
# Part 2: assemble the --readback JSON from the validated results (names compared with the baseline), then the
# pinned comparator, its verdict printed verbatim; exit 0 ONLY on the exact line OVERALL PASS
# ---------------------------------------------------------------------------------------------------------
cat > "$TMPD/mk-readback.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const e = process.env;
const fail = (m) => { console.error(m); process.exit(1); };
const rows = (f) => { const j = JSON.parse(readFileSync(`${e.A_RES}/${f}.json`, "utf8")); if (!Array.isArray(j) || !j.length || j.some((r) => !r || typeof r !== "object" || Array.isArray(r))) fail(`${f}: not a non-empty array of objects`); return j; };
const base = JSON.parse(readFileSync(e.A_BASE, "utf8")).s1;
if (!base || !Array.isArray(base.closures) || !Array.isArray(base.table_privileges) || !base.body_md5 || typeof base.body_md5 !== "object") fail("the baseline has no s1 section");
const guardOk = (r, f) => { if (!(r.at_hosted_0246 === 1 || r.at_hosted_0246 === "1")) fail(`${f}: the chain guard value is not 1`); };
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// history
const h = rows("s1-history");
if (h.length !== 1) fail("s1-history: not exactly one row");
const history = { applied_count: h[0].applied_count, hosted_max: h[0].hosted_max, distinct_versions_ge_0213: h[0].distinct_versions_ge_0213 };
// closures: one entry per baseline name; a role is true if ANY overload is executable by it
const cr = rows("s1-closures");
cr.forEach((r) => { guardOk(r, "s1-closures"); for (const k of ["anon", "authenticated", "service_role"]) if (typeof r[k] !== "boolean") fail(`s1-closures: ${r.fn}.${k} is not a boolean`); });
const wantFns = base.closures.map((c) => c.fn);
if (!sameSet([...new Set(cr.map((r) => r.fn))], wantFns)) fail(`s1-closures: the functions read are not exactly the baseline closures (read: ${[...new Set(cr.map((r) => r.fn))].sort().join(",")})`);
const closures = wantFns.map((fn) => { const rs = cr.filter((r) => r.fn === fn); return { fn, anon: rs.some((r) => r.anon), authenticated: rs.some((r) => r.authenticated), service_role: rs.some((r) => r.service_role) }; });
// table privileges
const tr = rows("s1-table-privileges");
tr.forEach((r) => { guardOk(r, "s1-table-privileges"); if (typeof r.held !== "boolean") fail(`s1-table-privileges: ${r.table_name}.${r.role_name}.${r.privilege} is not a boolean`); });
const key = (t, r, p) => `${t}|${r}|${p}`;
const wantTp = base.table_privileges.map((t) => key(t.table, t.role, t.privilege));
if (!sameSet(tr.map((r) => key(r.table_name, r.role_name, r.privilege)), wantTp)) fail("s1-table-privileges: the (table, role, privilege) list is not exactly the baseline list");
const table_privileges = tr.map((r) => ({ table: r.table_name, role: r.role_name, privilege: r.privilege, held: r.held }));
// body md5: exactly one row per baseline name
const br = rows("s1-body-md5");
br.forEach((r) => guardOk(r, "s1-body-md5"));
const wantBodies = Object.keys(base.body_md5);
if (!sameSet([...new Set(br.map((r) => r.fn))], wantBodies)) fail("s1-body-md5: the functions read are not exactly the baseline body list");
const body_md5 = {};
for (const fn of wantBodies) {
  const rs = br.filter((r) => r.fn === fn);
  if (rs.length !== 1) fail(`s1-body-md5: ${fn} has ${rs.length} overloads; the baseline names a single body`);
  if (typeof rs[0].body_md5 !== "string" || !/^[0-9a-f]{32}$/.test(rs[0].body_md5)) fail(`s1-body-md5: ${fn} md5 is not 32 hex`);
  body_md5[fn] = rs[0].body_md5;
}
writeFileSync(e.A_OUT, JSON.stringify({ history, closures, table_privileges, body_md5 }, null, 2) + "\n");
NODE
READBACK="$WORK/readback.json"
A_RES="$RES" A_BASE="$WR/$BASELINE" A_OUT="$READBACK" node "$TMPD/mk-readback.mjs" </dev/null || die "could not assemble the read-back (see the line above)"
[ -s "$READBACK" ] || die "the read-back file was not written"
VERDICT="$WORK/verdict.txt"
crc=0
node "$WR/compare-preflight.mjs" --stage s1 --census "$RES/census-0213-0246.json" --g10 "$RES/s1-g10.json" --readback "$READBACK" --baseline "$WR/$BASELINE" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
T_END=$(utcnow)
echo "S1 read-back started $T_START and finished $T_END (UTC): record both." >&2
if [ "$crc" = 0 ] && grep -qx 'OVERALL PASS' "$VERDICT"; then
  echo "WINDOW S1 READ-BACK: OVERALL PASS. Results, read-back and verdict are in $WORK" >&2
  echo "This is read-only evidence that S1 reached its end state. It does not promote anything." >&2
  exit 0
fi
die "the comparator did not print OVERALL PASS (exit $crc). Do NOT promote. Evidence is in $WORK"
