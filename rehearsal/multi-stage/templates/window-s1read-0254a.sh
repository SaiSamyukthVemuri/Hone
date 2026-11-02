#!/bin/bash
# 0254-AFTER-0257 ONLINE STAGE VARIANT of window-s1read-0254a.sh (7f85cb80); PREPARATION ONLY / HELD. The history end state is the only change: 248 rows, max 0257 (unchanged), 0254 once, 0257 once, 0248 once, 0247 absent, nothing at 0249..0253 or 0255..0256, nothing above 0257. The stage's checks: functions-exist = 5,
# the body md5 of the five 0254 functions (compared by the sha256 of the canonical result and by md5), and the NEGATIVE READ PROOF from the catalog: each of
# payment_charge_attempts, manual_fee_charge_attempts and appointment_settlements has exactly one SELECT policy, named *_owner_*, that calls is_studio_owner( and
# never is_studio_member(. Read-only. Fail-closed. No retries. Credentials typed privately, cleared on any exit. A failed login writes a tombstone.
# Exit 0 ONLY after this script prints the exact line "OVERALL PASS (0254 read-back ...)". That is read-back evidence; it does not promote.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"

WR1="$ROOT/window-reads-s1-0254a" # this script, the runner copy, the 0254 gate files and their manifest
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=9f6ac715286428b4832af0a230fc08b5e428302f180c94036377e58fdf228ab3




REF=alhhybgqdmcdyzpybykj
POOLER_URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
TOMB="$ROOT/s1-read/FAILED-LOGIN"
FILES="s1-history-0254a.sql c01_functions-exist.sql c02_function-bodies.sql c03_read-policies.sql"
NFILES=4

cleanup() {
  unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared. Do not retry; do not reset the password; do not unban." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
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
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then
  die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."
fi
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found (the check needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$WR1/run-window-read-macos.sh" ] && [ "$(sha "$WR1/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner copy missing or sha256 mismatch"
[ -f "$WR1/MANIFEST.sha256" ] && [ "$(sha "$WR1/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "S1 manifest missing or sha256 mismatch"
oks=$(cd "$WR1" && shasum -a 256 -c MANIFEST.sha256) || die "an S1 gate file does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = "$NFILES" ] || die "MANIFEST.sha256 did not verify exactly $NFILES gate files"
for f in $FILES; do awk -v f="$f" '$2 == f {n++} END {exit n == 1 ? 0 : 1}' "$WR1/MANIFEST.sha256" || die "$f is not listed exactly once in the S1 manifest"; done



bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
WORK=$(mktemp -d "$ROOT/s1read.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"; TMPD="$WORK/tmp"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" "$TMPD" || die "mkdir failed"
chmod 700 "$LINK" "$RES" "$LOGS" "$TMPD" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
# pooler-url WITHOUT a trailing newline (supabase-go v2.102.0 reads it verbatim; see window-s0a.sh).
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"
[ "$(cat "$LINK/supabase/.temp/pooler-url")" = "$POOLER_URL" ] && [ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact (no trailing newline)"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ "$(cat "$LINK/supabase/.temp/cli-latest")" = v2.102.0 ] || die "cli-latest is not v2.102.0"
[ -r /dev/tty ] || die "no terminal for private entry"
T_START=$(utcnow)
echo "S1 read-back started at $T_START (UTC). Nothing is typed except the two hidden credentials. Record the start and end times: the gap read must run within 24 h of S1." >&2

# ---------------------------------------------------------------------------------------------------------
# credentials, privately (never echoed; cleared by the EXIT/INT/TERM/HUP trap)
# ---------------------------------------------------------------------------------------------------------
IFS= read -rs -p "Supabase access token (not shown): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"
echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "Database password (not shown; only its presence is used here): " SUPABASE_DB_PASSWORD </dev/tty || die "could not read the password"
echo >&2
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"

# ---------------------------------------------------------------------------------------------------------
# Part 1: the three files, one at a time; validate each result and sidecar before the next. No retries.
# ---------------------------------------------------------------------------------------------------------
n=0
for f in $FILES; do
  stem=${f%.sql}
  want_sql=$(awk -v f="$f" '$2 == f {print $1}' "$WR1/MANIFEST.sha256")
  [ -n "$want_sql" ] || die "$f is not in the manifest"
  rc=0
  ( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
      SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$WR1/run-window-read-macos.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
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
    die "$f failed (exit $rc): a refusal, a guard (a refusal or an invalid result) or an invalid result. Nothing after it was run."
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
  if [ "$f" = s1-history-0254a.sql ]; then
    # The history is read FIRST. If it is not exactly the 0254 end state, nothing else is read.
    printf '%s' "$c" | grep -Eq '"applied_count":"?248"?[,}]' && printf '%s' "$c" | grep -q '"hosted_max":"0257"' \
      && printf '%s' "$c" | grep -Eq '"rows_0254":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0257":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0248":"?1"?[,}]' && printf '%s' "$c" | grep -Eq '"rows_0247":"?0"?[,}]' \
      && printf '%s' "$c" | grep -Eq '"versions_0249_0253":"?0"?[,}]' && printf '%s' "$c" | grep -Eq '"versions_0255_0256":"?0"?[,}]' && printf '%s' "$c" | grep -Eq '"versions_above_0257":"?0"?[,}]' \
      && printf '%s' "$c" | grep -Eq '"versions_0213_0246_once_each":"?34"?[,}]' \
      || die "s1-history: the history is not exactly 248 rows, max 0257, 0254 once, 0257 once, 0248 once, 0247 absent, nothing at 0249..0253 or 0255..0256 or above 0257, 0213..0246 once each. The 0254 stage did not reach its end state. Do NOT promote. Nothing else was read; report this result: $r"
  fi
  n=$((n+1))
  echo "ok $n/$NFILES $f (result sha256 $rs)" >&2
done
[ "$n" = "$NFILES" ] || die "only $n of $NFILES files completed"
extra=$(cd "$RES" && ls -A | grep -vE '\.(meta\.)?json$' || true)
[ -z "$extra" ] || die "unexpected files in the results directory: $extra"
[ "$(cd "$RES" && ls -A | wc -l | tr -d ' ')" = $((NFILES * 2)) ] || die "the results directory does not hold exactly the $NFILES results and $NFILES sidecars"
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
echo "Captured and validated: $NFILES results + $NFILES sidecars. Checking them against the sealed 0254 stage expectations." >&2

# ---------------------------------------------------------------------------------------------------------
# Part 2: the 0254 stage expectations (functions and bodies from the sealed 0254 source, derived and checked in the rehearsal), then the verdict.
# Functions and bodies are compared by the sha256 of their canonical result (sorted keys, no whitespace), exactly as verify.sh does. Exit 0 ONLY on the exact line.
# ---------------------------------------------------------------------------------------------------------
cat > "$TMPD/check-0254a.mjs" <<'NODE'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const e = process.env;
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
const rows = (f) => { const j = JSON.parse(readFileSync(`${e.A_RES}/${f}.json`, "utf8")); if (!Array.isArray(j) || !j.length || j.some((r) => !r || typeof r !== "object" || Array.isArray(r))) fail(`${f}: not a non-empty array of objects`); return j; };
const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const num = (v, n) => (typeof v === "number" ? v === n : typeof v === "string" && /^-?\d+$/.test(v) && Number(v) === n);
const isTrue = (v) => v === true || v === "true" || v === "t";
const EXPECT = { functions_exist: "908cd21ea57731ceda686e6869a7bb2d0aebca209130c52eba38771309ce2d5b", function_bodies: "e6dada97faf9ec4f33b90d4bb225b269c8078815a15818b31be25a6173af35a4" };
const BODY_MD5 = { audit_client_pricing_change: "f9d991d58d0c161d397d929518092d65", audit_pinned_note_delete: "2b804d4af96425de2ce9f17fffe6f805", edit_client_pinned_note: "95f0e465380e0d9a8c2c7fd030554b81", record_appointment_settlement: "141b14dafd9989618258e1f6d4af352a", set_session_price: "8b381d74783d96e896338f1f44e02aee" };
const h = rows("s1-history-0254a");
if (h.length !== 1) fail("s1-history-0254a: not exactly one row");
const r = h[0];
if (!(num(r.applied_count, 248) && r.hosted_max === "0257" && num(r.rows_0254, 1) && num(r.rows_0257, 1) && num(r.rows_0248, 1) && num(r.rows_0247, 0) && num(r.versions_0249_0253, 0) && num(r.versions_0255_0256, 0) && num(r.versions_above_0257, 0) && num(r.versions_0213_0246_once_each, 34))) fail("history is not 248 / 0257 / 0254 once / 0257 once / 0248 once / 0247 absent / nothing at 0249..0253 or 0255..0256 or above 0257 / 34 below");
console.log("PASS history: 248 rows, max 0257, 0254 once, 0257 once, 0248 once, 0247 absent, nothing at 0249..0253 or 0255..0256 or above 0257, 0213..0246 once each");
const c1 = rows("c01_functions-exist");
if (sha(canon(c1)) !== EXPECT.functions_exist) fail(`c01 functions-exist: result sha256 ${sha(canon(c1))} is not the expected ${EXPECT.functions_exist}`);
console.log("PASS functions-exist: result sha256 equals the expected one (the five 0254 functions exist)");
const c2 = rows("c02_function-bodies");
if (sha(canon(c2)) !== EXPECT.function_bodies) fail(`c02 function-bodies: result sha256 ${sha(canon(c2))} is not the expected ${EXPECT.function_bodies}`);
if (c2.length !== 5 || c2.some((x) => BODY_MD5[x.proname] !== x.md5)) fail("c02: a body md5 is not the sealed one");
console.log("PASS function-bodies: result sha256 equals the expected one; the five body md5 values are the sealed ones");
const c3 = rows("c03_read-policies");
const want = ["appointment_settlements", "manual_fee_charge_attempts", "payment_charge_attempts"];
const names = c3.map((x) => x.table_name).sort();
if (c3.length !== 3 || JSON.stringify(names) !== JSON.stringify(want)) fail("c03: the three tables do not each have exactly one SELECT policy");
for (const x of c3) {
  if (!/_owner_/.test(String(x.polname))) fail(`c03: the SELECT policy on ${x.table_name} is not an owner policy`);
  if (!isTrue(x.uses_owner) || isTrue(x.uses_member)) fail(`c03: the SELECT policy on ${x.table_name} is not owner-only (uses_owner ${x.uses_owner}, uses_member ${x.uses_member})`);
}
console.log("PASS read-policies: each of the three tables has exactly one SELECT policy, owner-gated (is_studio_owner), none uses is_studio_member");
console.log("");
console.log("OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)");
NODE
VERDICT="$WORK/verdict.txt"
crc=0
A_RES="$RES" node "$TMPD/check-0254a.mjs" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
T_END=$(utcnow)
echo "S1 read-back started $T_START and finished $T_END (UTC): record both." >&2
if [ "$crc" = 0 ] && grep -Fxq 'OVERALL PASS (0254 read-back: history, 2 verify checks and the owner-only read-policy proof; read-only, not a promotion)' "$VERDICT"; then
  echo "WINDOW S1 READ-BACK (0254): OVERALL PASS. Results and verdict are in $WORK" >&2
  echo "This is read-only evidence that the 0254 stage reached its end state. It does not promote anything." >&2
  exit 0
fi
die "the 0254 read-back did not pass (exit $crc). Do NOT promote. Evidence is in $WORK"
