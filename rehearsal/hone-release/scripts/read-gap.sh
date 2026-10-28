#!/bin/bash
# TEAM VARIANT (HON66 final batch): the reads go through the ONE pinned mgmt-read.py (provider read-only endpoint); no supabase CLI, no database password, no login role.
# LINUX VARIANT of the reviewed Mac script (HON66-LINUX-GATES), derived by machines/linux-gates/make-linux.py with a fixed substitution
# list (see LINUX-DIFFS.txt). The PAT arrives on fd 3 from hone-release; no database password is read (fixed non-secret placeholder); nothing is prompted or on argv.
# Hone #1035 POST-S3 GAP READ (obs-1035-gap-pending-payments-v2.sql, 5aa510c0): count-only read of payment and card-setup rows
# the old app may have left unreconciled between S1 and S3. ONE read-only file through the verified runner ec9b7c56 and
# supabase-go 174a90e2; ONE login; no comparator (the rows are counts, read by a person). Must run within 24 h of S3
# (by 2026-10-28T02:43Z): the SQL's lookback is a fixed 24 hours from NOW.
# Fail-closed: the first failed command, refusal, authentication error or invalid result stops. No retry. Credentials are
# received on fd 3 (never printed, never on a command line, never written) and cleared on any exit. Nothing here creates a
# login role, resets a password or unbans an IP (PREVENTION is the runner's password-present rule; the log scan is only a
# detector after the fact: a hit is REPORTED, never retried). A failed login writes a tombstone (gap-read/FAILED-LOGIN, no
# secret); every later run of this script refuses, and so does a FAILED-LOGIN left by s1-read or s1-apply.
# READING RULES (from the SQL): read_first: exactly 19 rows and at_hosted_0246 = 1 on every row, else STOP and report.
# A zero is a row. States named *_informational are context, not findings. No id, amount, account, name or message is read.
# Exit 0 ONLY after the 19 rows validated and were printed. The counts are evidence for a person; this script judges nothing.
set -u
umask 077

ROOT=/var/lib/hone-release
REFFILE=/etc/hone-release/PROJECT-REF
MANIFEST=/usr/local/libexec/hone-release/manifest
RUNNER_SHA=ec9b7c568a69d3b776ee9c643bcb52eb567639ab9cb0c995b33f59cf6d974468
MANIFEST_SHA=a9ea6308a113bc5de2bfe8a2519993006dd6f8e4f3b408f782aa43b1c800731c
SQL=obs-1035-gap-pending-payments-v2.sql
SQL_SHA=5aa510c082e0484202d90503c5266a3c534250b90952e9b0a3a9d051e51e0086
NROWS=19

# The PAT arrives on FILE DESCRIPTOR 3, opened by hone-release (root-owned custody layer); it is never a file this script opens, never an
# argument, never in the environment. There is no database-password input: reads use a FIXED, NON-SECRET placeholder only so that the
# CLI never creates a login role (HON66-PROOF M9; the CI proves the read path never authenticates with it).
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
  TOKEN=""; unset TOKEN
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
NOLOGIN="STOP HERE: do not retry. Report the STOP line above."

# ---------------------------------------------------------------------------------------------------------
# Part 0: this Mac, the verified tools, a clean environment (NAMES only, never values), fresh private dirs
# ---------------------------------------------------------------------------------------------------------

[ "${HONE_RELEASE_ACTION:-}" = read-gap ] || { echo "STOP: not started by the launcher for the read-gap action" >&2; exit 1; }
[ -f "$REFFILE" ] && [ ! -L "$REFFILE" ] && [ "$(stat -c %u "$REFFILE")" = 0 ] && [ $(( 8#$(stat -c %a "$REFFILE") & 8#022 )) = 0 ] || die "PROJECT-REF is missing or not root-owned"
REF=$(head -n 1 "$REFFILE"); printf '%s' "$REF" | grep -Eq '^[a-z0-9]{20}$' || die "PROJECT-REF is malformed"
# the data (gate SQL, runners, comparator, baseline) is ONE root-pinned tar in the manifest; it is extracted into a fresh private directory and every inner file is
# still checked against the sha256 pins below (the reviewed Machines pins are unchanged)
mline=$(awk '$1 == "w1-data" {print $2 " " $3}' "$MANIFEST" 2>/dev/null); dsha=${mline% *}; dpath=${mline#* }
[ -n "$mline" ] && [ -f "$dpath" ] && [ ! -L "$dpath" ] && [ "$(sha "$dpath")" = "$dsha" ] || die "the w1-data bundle is missing or differs from the manifest sha256"
mline=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null); MSHA=${mline% *}; MPATH=${mline#* }
[ -n "$mline" ] && [ -f "$MPATH" ] && [ ! -L "$MPATH" ] && [ "$(sha "$MPATH")" = "$MSHA" ] || die "the mgmt-read helper is missing or differs from the manifest sha256"
WORK=$(mktemp -d "$ROOT/work/gap.XXXXXX") || die "mktemp failed"; chmod 700 "$WORK" || die "chmod failed"
mkdir "$WORK/data" && tar -xf "$dpath" -C "$WORK/data" --no-same-owner --no-same-permissions || die "could not extract the w1-data bundle"
GR="$WORK/data/gap-read-2"
[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "not Linux x86_64 (the launcher host is Linux x86_64)"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found"
command -v node >/dev/null 2>&1 || die "node not found (the row check needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$GR" ] && [ ! -L "$GR" ] || die "$GR is missing or a symlink (run the download line first)"
[ -f "$GR/run-window-read.sh" ] && [ "$(sha "$GR/run-window-read.sh")" = "$RUNNER_SHA" ] || die "runner copy missing or sha256 mismatch"
[ -f "$GR/MANIFEST.sha256" ] && [ "$(sha "$GR/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
awk -v f="$SQL" -v s="$SQL_SHA" '$2 == f && $1 == s {n++} $2 == f && $1 != s {m++} END {exit (n == 1 && m == 0) ? 0 : 1}' "$GR/MANIFEST.sha256" || die "$SQL is not listed exactly once, with the pinned sha256, in the manifest"
[ -f "$GR/$SQL" ] && [ ! -L "$GR/$SQL" ] && [ "$(sha "$GR/$SQL")" = "$SQL_SHA" ] || die "$SQL missing or sha256 mismatch"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"

# The ORIGINAL Linux runner (run-window-read.sh, unchanged) calls `npx --yes supabase@2.102.0 db query --linked -o json -f FILE`. This shim is first on PATH for that one child and
# accepts ONLY that exact invocation; it does NOT run the supabase CLI: it hands the file to the pinned mgmt-read.py, which sends it to the provider's read-only query endpoint
# (its own lexical gate applies on top of the runner's) and prints the JSON array of rows, the same shape the runner stores.
SHIM="$WORK/shim"; mkdir -p "$SHIM" && chmod 700 "$SHIM" || die "mkdir shim failed"
cat > "$SHIM/npx" <<'SHIMEOF'
#!/bin/bash
[ "$#" -eq 9 ] && [ "$1" = --yes ] && [ "$2" = supabase@2.102.0 ] && [ "$3" = db ] && [ "$4" = query ] && [ "$5" = --linked ] && [ "$6" = -o ] && [ "$7" = json ] && [ "$8" = -f ] || { echo "npx shim: REFUSED: not the reviewed invocation" >&2; exit 97; }
[ -n "${HONE_MGMT_PATH:-}" ] && [ -n "${HONE_WINDOW_PROJECT_REF:-}" ] && [ -n "${HONE_READ_TOKEN:-}" ] || { echo "npx shim: REFUSED: the helper, ref or token is missing" >&2; exit 97; }
exec python3 -I "$HONE_MGMT_PATH" "$HONE_WINDOW_PROJECT_REF" file "$9"
SHIMEOF
chmod 700 "$SHIM/npx" || die "shim write failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"; TMPD="$WORK/tmp"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" "$TMPD" || die "mkdir failed"
chmod 700 "$LINK" "$RES" "$LOGS" "$TMPD" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
T_START=$(utcnow)
echo "Gap read started at $T_START (UTC). The PAT arrives on fd 3; nothing is typed. It must run by 2026-10-28T02:43Z (24 h after S3); the SQL looks back a fixed 24 hours from now."  >&2

# ---------------------------------------------------------------------------------------------------------
# credentials, privately (never echoed; cleared by the EXIT/INT/TERM/HUP trap)
# ---------------------------------------------------------------------------------------------------------
secret_from_fd3 TOKEN "read-only access token"
[ -n "$TOKEN" ] || die "empty access token"

# ---------------------------------------------------------------------------------------------------------
# Part 1: the one file, one login. Validate the result and the sidecar. No retry.
# ---------------------------------------------------------------------------------------------------------
f=$SQL; stem=${f%.sql}
rc=0
( cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_MGMT_PATH="$MPATH" HONE_READ_TOKEN="$TOKEN" HONE_WINDOW_RESULT_DIR="$RES" \
    SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PATH="$SHIM:$PATH" /bin/bash "$GR/run-window-read.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
TOKEN=""; unset TOKEN
mask_file "$LOGS/$stem.err" || die "could not mask the log of $f"
if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then
  die "$f: a login-role / ban / password path was reported; stopped; REPORT it (log: $LOGS/$stem.err). $NOLOGIN"
fi
if grep -qiE 'permission denied|42501' "$LOGS/$stem.err"; then
  die "$f: a permission refusal was reported (denial); stopped (log: $LOGS/$stem.err)"
fi
if [ "$rc" != 0 ]; then
  if is_auth_failure "$LOGS/$stem.err"; then
    strip "$LOGS/$stem.err" | tail -n 4 | mask >&2
    die "$f: an authentication failure was reported. $NOLOGIN"
  fi
  tail -n 5 "$LOGS/$stem.err" | mask >&2
  die "$f failed (exit $rc): a refusal, a guard (division by zero means the history max is not 0246: STOP, run G2) or an invalid result. Nothing else was run."
fi
r="$RES/$stem.json"; m="$RES/$stem.meta.json"
[ -f "$r" ] && [ -f "$m" ] || die "$f: result or sidecar missing"
[ "$(cd "$RES" && ls -A | wc -l | tr -d ' ')" = 2 ] || die "the results directory does not hold exactly the result and its sidecar"
c=$(LC_ALL=C tr -d '[:space:]' < "$r")
case "$c" in "[{"*"}]") ;; *) die "$f: the result is not a non-empty JSON array of objects" ;; esac
rs=$(sha "$r")
[ "$(grep -c '' "$m")" = 1 ] || die "$f: the sidecar is not exactly one line"
line=$(cat "$m")
printf '%s\n' "$line" | grep -Eqx "\\{\"file\":\"$f\",\"sql_sha256\":\"$SQL_SHA\",\"result_sha256\":\"$rs\",\"started_at_utc\":\"$iso\",\"captured_at_utc\":\"$iso\",\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\",\"manifest_sha256\":\"$MANIFEST_SHA\"\\}" \
  || die "$f: the sidecar does not bind this result (file, sql, result hash, exit code, runner or manifest)"
st=$(printf '%s' "$line" | sed -E 's/.*"started_at_utc":"([^"]*)".*/\1/'); ca=$(printf '%s' "$line" | sed -E 's/.*"captured_at_utc":"([^"]*)".*/\1/')
[ "$st" \< "$ca" ] || [ "$st" = "$ca" ] || die "$f: capture time precedes start time"
echo "ok 1/1 $f (result sha256 $rs)" >&2

# ---------------------------------------------------------------------------------------------------------
# Part 2: the reading rules. Exactly 19 rows, the (src, state) pairs exactly those the pinned SQL names, each once,
# at_hosted_0246 = 1 on every row, every count a non-negative integer. Else STOP. Then print the counts.
# ---------------------------------------------------------------------------------------------------------
cat > "$TMPD/rows.mjs" <<'NODE'
import { readFileSync } from "node:fs";
const e = process.env;
const fail = (m) => { console.error("STOP: " + m); process.exit(1); };
let j; try { j = JSON.parse(readFileSync(e.A_RES, "utf8")); } catch { fail("the result is not JSON"); }
if (!Array.isArray(j)) fail("the result is not an array");
const sql = readFileSync(e.A_SQL, "utf8");
const want = [...sql.matchAll(/select '([a-z_]+)' as src, '([a-z_]+)' as state,/g)].map((m) => m[1] + "|" + m[2]);
if (want.length !== Number(e.A_N) || new Set(want).size !== want.length) fail(`the pinned SQL names ${want.length} (src, state) pairs, expected ${e.A_N}`);
if (j.length !== Number(e.A_N)) fail(`read_first: ${j.length} rows, expected exactly ${e.A_N}. STOP and report.`);
const seen = new Set(); const out = [];
for (const r of j) {
  if (!r || typeof r !== "object" || Array.isArray(r)) fail("a row is not an object");
  const ks = Object.keys(r).sort().join(",");
  if (ks !== "at_hosted_0246,rows_in_lookback,src,state") fail(`a row has unexpected columns: ${ks}`);
  if (!(r.at_hosted_0246 === 1 || r.at_hosted_0246 === "1")) fail("read_first: at_hosted_0246 is not 1 on every row. STOP and report.");
  const n = typeof r.rows_in_lookback === "string" && /^[0-9]+$/.test(r.rows_in_lookback) ? Number(r.rows_in_lookback) : r.rows_in_lookback;
  if (!Number.isInteger(n) || n < 0) fail(`${r.src}/${r.state}: the count is not a non-negative integer`);
  const k = r.src + "|" + r.state;
  if (seen.has(k)) fail(`duplicate row ${k}`);
  seen.add(k);
  out.push([r.src, r.state, n]);
}
for (const k of seen) if (!want.includes(k)) fail(`the row ${k} is not one the pinned SQL names`);
for (const k of want) if (!seen.has(k)) fail(`the row ${k} is missing`);
out.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
const w = Math.max(...out.map((o) => o[0].length)), w2 = Math.max(...out.map((o) => o[1].length));
console.log("GAP READ: 19 rows, at_hosted_0246 = 1 on every row. Counts within the last 24 hours (a zero is a row):");
for (const [s, t, n] of out) console.log(`  ${s.padEnd(w)}  ${t.padEnd(w2)}  ${String(n).padStart(6)}${t.endsWith("_informational") || t === "received_total_informational" ? "   (informational)" : ""}`);
const nz = out.filter(([, t, n]) => n > 0 && !t.includes("informational"));
console.log(nz.length ? `NON-ZERO non-informational rows: ${nz.length}. Report this whole table to OPS; do not act on it from here.` : "All non-informational rows are zero.");
NODE
A_RES="$r" A_SQL="$GR/$SQL" A_N="$NROWS" node "$TMPD/rows.mjs" </dev/null || die "the 19-row reading rules failed (see the line above). Report this result: $r"
T_END=$(utcnow)
echo "Gap read started $T_START and finished $T_END (UTC). Result, sidecar and log: $WORK" >&2
echo "This is read-only count evidence. It does not change anything." >&2
exit 0
