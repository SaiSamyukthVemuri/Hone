#!/bin/bash
# Hone #1035 WINDOW S0a (recovery_regime pitr): capture the 14 manifest-pinned read-only window files through the verified runner
# 471ecb9d and supabase-go dce26b75, then run the pinned comparator and print its verdict.
# Read-only. Fail-closed: the first failed command, refusal, authentication error, invalid result or non-PASS stops.
# No retries. Credentials are typed privately (never echoed, never on a command line, never written) and cleared
# on any exit. Nothing here creates a login role, resets a password or unbans an IP: PREVENTION is the runner's
# password-present rule; the log scan below is only a detector after the fact (a hit must be REPORTED, never retried).
# Exit 0 ONLY after the comparator prints the exact line "OVERALL PASS". That line does NOT cover the row-4 bracket
# (the selected pre-migration restore point and a fresh PITR reading): window-row4.sh is a separate step, and both are required.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
WR="$ROOT/window-reads"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=2b1608a9ec43caf97bd9ead3fe1d10895652a080a4b8ae0a891a17be3038cd94
CMP_SHA=147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058
LIB_SHA=636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9
BASELINE=BASELINE-W1-MACOS-CANDIDATE-3.json
BASELINE_SHA=efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd
G3_FILE=G3-CHECKSUMS-d189768b.txt
G3_SHA=bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6
REF=alhhybgqdmcdyzpybykj
POOLER_URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
HEAD_SHA=d189768b86fe1c53e330c65078f3a9f2949f8e59
FILES="g02-history.sql census-0213-0246.sql g06-payment-drain.sql g07-sms-claimed-number-duplicates.sql g09a-0214-reach-summary.sql g09b-0214-reach-per-studio.sql g09c-0214-bound-account-mode.sql g09d-0214-currency-history.sql g10-constraint-names.sql g11-0244-legacy-laser-types.sql g11b-0244-legacy-laser-classes.sql g12-0243-intake-definers.sql s1-open-transactions.sql w03-table-sizes.sql"

cleanup() {
  unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------------------------------------
# Part 0: this Mac, the verified tools, a clean environment (NAMES only, never values), fresh private dirs
# ---------------------------------------------------------------------------------------------------------
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found (the comparator needs Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$WR/run-window-read-macos.sh" ] && [ "$(sha "$WR/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner missing or sha256 mismatch"
[ -f "$WR/MANIFEST.sha256" ] && [ "$(sha "$WR/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
oks=$(cd "$WR" && shasum -a 256 -c MANIFEST.sha256) || die "a gate file does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 14 ] || die "MANIFEST.sha256 did not verify exactly 14 gate files"
[ -f "$WR/compare-preflight.mjs" ] && [ "$(sha "$WR/compare-preflight.mjs")" = "$CMP_SHA" ] || die "comparator entry missing or sha256 mismatch"
[ -f "$WR/compare-preflight-lib.mjs" ] && [ "$(sha "$WR/compare-preflight-lib.mjs")" = "$LIB_SHA" ] || die "comparator lib missing or sha256 mismatch"
[ -f "$WR/$BASELINE" ] && [ "$(sha "$WR/$BASELINE")" = "$BASELINE_SHA" ] || die "baseline $BASELINE missing or sha256 mismatch"
[ -f "$WR/$G3_FILE" ] && [ "$(sha "$WR/$G3_FILE")" = "$G3_SHA" ] || die "G3 checksums file $G3_FILE missing or sha256 mismatch"
# Every name the runner refuses, plus what could redirect a child (shell start-up files, node, loaders, proxies, CA).
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
WORK=$(mktemp -d "$ROOT/window.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"; ATD="$WORK/attest"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" "$ATD" || die "mkdir failed"
chmod 700 "$LINK" "$RES" "$LOGS" "$ATD" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
# pooler-url WITHOUT a trailing newline: supabase-go v2.102.0 reads this file verbatim; a newline makes the URL
# unparsable and it silently falls back to the direct IPv6 host (incident 2026-10-25, reproduced).
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"
[ "$(cat "$LINK/supabase/.temp/pooler-url")" = "$POOLER_URL" ] && [ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact (no trailing newline)"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ "$(cat "$LINK/supabase/.temp/cli-latest")" = v2.102.0 ] || die "cli-latest is not v2.102.0"
[ -r /dev/tty ] || die "no terminal for private entry"

# ---------------------------------------------------------------------------------------------------------
# Part 1: what the operator types (non-secret), all BEFORE any hosted read. Nothing is guessed or defaulted.
# ---------------------------------------------------------------------------------------------------------
ask() { # ask VAR "prompt"
  local _v
  IFS= read -r -p "$2" _v </dev/tty || die "could not read $1"
  printf -v "$1" '%s' "$_v"
}
text_ok() { [ -n "$1" ] && [ "${#1}" -le 200 ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9 ._:/@+,;()=#-]+$'; }
utc_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq "^$iso\$"; }
int_ok() { printf '%s' "$1" | LC_ALL=C grep -Eq '^[1-9][0-9]{0,2}$'; }
echo "The time now is $(utcnow). Type each answer and press Return. Nothing is defaulted. Times are UTC, like 2026-10-27T01:00:00Z." >&2
ask OPERATOR "Operator label (your initials or a short label, no names of customers): "; text_ok "$OPERATOR" || die "operator label is empty or has characters outside letters, digits and . _ : / @ + , ; ( ) = # -"
ask WSTART "Window start (UTC): "; utc_ok "$WSTART" || die "window start is not YYYY-MM-DDTHH:MM:SSZ"
ask WEND "Window end (UTC): "; utc_ok "$WEND" || die "window end is not YYYY-MM-DDTHH:MM:SSZ"
echo "The three holds. Type the word  yes  only if the hold is in place right now." >&2
ask H1 "Cron-job.org reminders paused: "; [ "$H1" = yes ] || die "hold 1 not confirmed (type exactly: yes)"; T1=$(utcnow)
ask H2 "People hold in place (no archive/export/charges/manual fee/portal card setup): "; [ "$H2" = yes ] || die "hold 2 not confirmed (type exactly: yes)"; T2=$(utcnow)
ask MFLAG "Maintenance flag decision (no_flag or flag_on): "; case "$MFLAG" in no_flag|flag_on) ;; *) die "maintenance flag decision must be no_flag or flag_on" ;; esac; T3=$(utcnow)
echo "G3: the head is the pinned final head $HEAD_SHA and its 34 checksums come from the pinned file $G3_FILE (sha256 checked above); the comparator compares them to the baseline. Nothing to type." >&2
echo "G4 under PITR. Read these now, from the dashboard or the management API. The dashboard shows LOCAL time: convert to UTC first (EDT is UTC-4, so add 4 hours; EST from 2026-11-01 is UTC-5, add 5; across midnight add a day). Type UTC like 2026-10-27T01:00:00Z. An empty or malformed answer stops the script before any hosted read." >&2
ask PITR_ON "PITR enabled (type exactly true): "; [ "$PITR_ON" = true ] || die "PITR enabled must be exactly: true"
ask PITR_RET "PITR retention in days (a whole number, no unit): "; int_ok "$PITR_RET" || die "retention must be a whole number of days (1 to 999), digits only"
ask P_EARLY "Earliest recovery point (UTC): "; utc_ok "$P_EARLY" || die "earliest recovery point is not YYYY-MM-DDTHH:MM:SSZ"
ask P_LATE "Latest recovery point (UTC): "; utc_ok "$P_LATE" || die "latest recovery point is not YYYY-MM-DDTHH:MM:SSZ"
ask P_BSTAT "Latest base backup status (type exactly COMPLETED): "; [ "$P_BSTAT" = COMPLETED ] || die "base backup status must be exactly: COMPLETED"
ask P_BAT "Latest base backup completed at (UTC): "; utc_ok "$P_BAT" || die "base backup time is not YYYY-MM-DDTHH:MM:SSZ"
ask P_BSRC "Base backup read from (dashboard or management_api): "; case "$P_BSRC" in dashboard|management_api) ;; *) die "base backup source must be dashboard or management_api" ;; esac
ask P_READ "Time you read the recovery range (UTC): "; utc_ok "$P_READ" || die "read time is not YYYY-MM-DDTHH:MM:SSZ"
ask P_RSRC "Recovery range read from (dashboard or management_api): "; case "$P_RSRC" in dashboard|management_api) ;; *) die "read source must be dashboard or management_api" ;; esac
ask R6CHOICE "R-6 choice (S0b or accept_rpo): "; case "$R6CHOICE" in S0b|accept_rpo) ;; *) die "R-6 choice must be S0b or accept_rpo" ;; esac
ask R6TEXT "R-6 answer (your words, one line): "; text_ok "$R6TEXT" || die "R-6 answer is empty or has unsupported characters"
ask R6REF "R-6 decision reference: "; text_ok "$R6REF" || die "R-6 reference is empty or has unsupported characters"
ask D0242 "0242 disposition (bridge_ready or R-3): "; case "$D0242" in bridge_ready|R-3) ;; *) die "0242 disposition must be bridge_ready or R-3" ;; esac
ask D0242REF "0242 disposition reference: "; text_ok "$D0242REF" || die "0242 reference is empty or has unsupported characters"
# denial_files ([]) and runner_refusals (0) are not typed: they are DERIVED below, and any refusal or permission
# denial during capture stops the script before the comparator is reached.

cat > "$ATD/mk-attest.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const e = process.env;
const lines = readFileSync(e.A_G3FILE, "utf8").split("\n").filter((l) => l.trim() !== "");
const checksums = {};
for (const l of lines) {
  const m = /^([0-9a-f]{64}) [ *](?:\.\/)?(?:.*\/)?(02[0-9]{2})_[^/]*\.sql$/.exec(l);
  if (!m) { console.error("unreadable checksums line"); process.exit(1); }
  if (checksums[m[2]]) { console.error("duplicate version " + m[2]); process.exit(1); }
  checksums[m[2]] = m[1];
}
const want = []; for (let v = 213; v <= 246; v++) want.push(String(v).padStart(4, "0"));
if (Object.keys(checksums).length !== 34 || want.some((v) => !checksums[v])) { console.error("checksums are not exactly 0213..0246 once each"); process.exit(1); }
const sorted = Object.fromEntries(want.map((v) => [v, checksums[v]]));
const a = {
  operator: e.A_OPERATOR,
  project_ref_sha256: createHash("sha256").update(e.A_REF, "utf8").digest("hex"),
  holds: {
    cron_job_org_paused: { confirmed_by: e.A_OPERATOR, at_utc: e.A_T1 },
    people_hold_in_place: { confirmed_by: e.A_OPERATOR, at_utc: e.A_T2 },
    maintenance_flag_decision: { choice: e.A_MFLAG, confirmed_by: e.A_OPERATOR, at_utc: e.A_T3 },
  },
  g3: { head_sha: e.A_HEAD, checksums: sorted },
  g4_pitr: {
    pitr_enabled: e.A_PITR_ON === "true",
    retention_days: Number(e.A_PITR_RET),
    earliest_recovery_at_utc: e.A_P_EARLY,
    latest_recovery_at_utc: e.A_P_LATE,
    latest_base_backup_status: e.A_P_BSTAT,
    latest_base_backup_completed_at_utc: e.A_P_BAT,
    base_backup_source: e.A_P_BSRC,
    read_at_utc: e.A_P_READ,
    read_source: e.A_P_RSRC,
  },
  r6: { choice: e.A_R6CHOICE, answer_text: e.A_R6TEXT, reference: e.A_R6REF },
  disposition_0242: { choice: e.A_D0242, reference: e.A_D0242REF },
  denial_files: [],
  runner_refusals: 0,
};
writeFileSync(e.A_OUT, JSON.stringify(a, null, 2) + "\n");
NODE
ATT="$ATD/attestation.json"
A_G3FILE="$WR/$G3_FILE" A_OPERATOR="$OPERATOR" A_REF="$REF" A_T1="$T1" A_T2="$T2" A_T3="$T3" A_MFLAG="$MFLAG" A_HEAD="$HEAD_SHA" A_PITR_ON="$PITR_ON" A_PITR_RET="$PITR_RET" A_P_EARLY="$P_EARLY" A_P_LATE="$P_LATE" A_P_BSTAT="$P_BSTAT" A_P_BAT="$P_BAT" A_P_BSRC="$P_BSRC" A_P_READ="$P_READ" A_P_RSRC="$P_RSRC" \
  A_R6CHOICE="$R6CHOICE" A_R6TEXT="$R6TEXT" A_R6REF="$R6REF" A_D0242="$D0242" A_D0242REF="$D0242REF" A_OUT="$ATT" node "$ATD/mk-attest.mjs" || die "could not build the attestation (see the line above)"
[ -s "$ATT" ] || die "attestation file was not written"

# Pre-check, BEFORE any hosted read: the comparator on an empty results directory. Its attestation rows must already
# PASS (operator, window and blackout, G3, G4, R-6, 0242, denials). One source of logic: the comparator itself.
EMPTY="$ATD/empty"; mkdir -p "$EMPTY" || die "mkdir failed"
pre=$(node "$WR/compare-preflight.mjs" --results "$EMPTY" --baseline "$WR/$BASELINE" --attest "$ATT" --window-start "$WSTART" --window-end "$WEND" --manifest "$WR/MANIFEST.sha256" 2>&1 </dev/null) || true
for id in S0-1 S0-8 S0-9 S0-10 S0-11 S0-12; do
  printf '%s\n' "$pre" | grep -Eq "^PASS +$id " || {
    printf '%s\n' "$pre" | grep -E " $id " >&2
    [ "$id" = S0-10 ] && echo "The PITR reading was refused. Options (none is automatic; this script does not loop or retry): (1) wait, read the recovery range again and start this script again; (2) with Sam's explicit authorization, a named restore point; (3) a recorded manual substitution decision outside the comparator." >&2
    die "attestation check $id does not pass; nothing was read from the hosted project"; }
done
echo "Attestation pre-check passed (S0-1, S0-8, S0-9, S0-10, S0-11, S0-12). Starting the hosted reads." >&2

# ---------------------------------------------------------------------------------------------------------
# credentials, privately (never echoed; cleared by the EXIT/INT/TERM/HUP trap)
# ---------------------------------------------------------------------------------------------------------
IFS= read -rs -p "Supabase access token (not shown): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"
echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "Database password (not shown; only its presence is used here): " SUPABASE_DB_PASSWORD </dev/tty || die "could not read the password"
echo >&2
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"
# Not exported here: only the runner subshell below exports them, so no other child inherits them.

# ---------------------------------------------------------------------------------------------------------
# Part 2: the 14 files, one at a time; validate each result and sidecar before the next. No retries.
# ---------------------------------------------------------------------------------------------------------
n=0
for f in $FILES; do
  stem=${f%.sql}
  want_sql=$(awk -v f="$f" '$2 == f {print $1}' "$WR/MANIFEST.sha256")
  [ -n "$want_sql" ] || die "$f is not in the manifest"
  rc=0
  ( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
      SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$WR/run-window-read-macos.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
  if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then
    die "$f: the CLI reported a login-role / ban / password path; stopped and REPORT it (log: $LOGS/$stem.err)"
  fi
  if grep -qiE 'permission denied|42501' "$LOGS/$stem.err"; then
    die "$f: a permission refusal was reported (denial); stopped (log: $LOGS/$stem.err)"
  fi
  if [ "$rc" != 0 ]; then
    tail -n 5 "$LOGS/$stem.err" >&2
    die "$f failed (exit $rc): an authentication error, a refusal or an invalid result. Nothing after it was run."
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
  if [ "$f" = g02-history.sql ]; then
    printf '%s' "$c" | grep -q '"hosted_max":"0212"' || die "g02: hosted history max is not 0212; the guarded files would refuse; stopped"
    printf '%s' "$c" | grep -Eq '"versions_ge_0213":"?0"?[,}]' || die "g02: versions at or above 0213 exist; stopped"
  fi
  n=$((n+1))
  echo "ok $n/14 $f (result sha256 $rs)" >&2
done
[ "$n" = 14 ] || die "only $n of 14 files completed"
extra=$(cd "$RES" && ls -A | grep -vE '\.(meta\.)?json$' || true)
[ -z "$extra" ] || die "unexpected files in the results directory: $extra"
[ "$(cd "$RES" && ls -A | wc -l | tr -d ' ')" = 28 ] || die "the results directory does not hold exactly the 14 results and 14 sidecars"
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
echo "Captured and validated: 14 results + 14 sidecars (the comparator compares 13; g09d is read by you). Running the comparator." >&2

# ---------------------------------------------------------------------------------------------------------
# Part 3: the pinned comparator, its verdict printed verbatim; exit 0 ONLY on the exact line OVERALL PASS
# ---------------------------------------------------------------------------------------------------------
VERDICT="$WORK/verdict.txt"
crc=0
node "$WR/compare-preflight.mjs" --results "$RES" --baseline "$WR/$BASELINE" --attest "$ATT" --window-start "$WSTART" --window-end "$WEND" --manifest "$WR/MANIFEST.sha256" </dev/null >"$VERDICT" 2>&1 || crc=$?
cat "$VERDICT"
if [ "$crc" = 0 ] && grep -qx 'OVERALL PASS' "$VERDICT"; then
  echo "WINDOW S0a: OVERALL PASS. Results, attestation and verdict are in $WORK" >&2
  echo "This does NOT cover the row-4 bracket (the selected pre-migration restore point and a fresh PITR reading). Run window-row4.sh immediately before S1; both are required." >&2
  exit 0
fi
die "the comparator did not print OVERALL PASS (exit $crc). STOP THE CUTOVER. Evidence is in $WORK"
