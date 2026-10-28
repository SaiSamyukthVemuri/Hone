#!/bin/bash
# Hone STAGE 0248-ONLY (variant of the #1035 S1 apply 2dfd3354; reviewed constants plus three reviewed gates: S0a age, single-flight marker, reconcile): apply migration 0248 (1 file) to the hosted project through the SESSION POOLER, with the
# vendor supabase-go (dce26b75) and ONLY the stage bundle (0001..0246 + sealed 0248, no 0247). ONE dry run, then ONE push.
# Fail-closed: the first failed check, refusal, authentication error or unexpected output stops. No step is retried.
# Nothing here creates a login role, resets a password or unbans an IP. PREVENTION: --db-url never reaches those code
# paths in CLI v2.102.0, and the database password is always present. The log scan below is only a detector after the
# fact (a hit must be REPORTED, never retried). The password is typed with read -rs from /dev/tty, never echoed, never
# on a command line, never written, and handed only to the one CLI child that needs it.
# Exit 0 ONLY after the push log shows exactly 1 "Applying migration" line (0248), then "Finished supabase db push.",
# and the CLI exited 0. That does NOT replace the read-back (history = 246 rows, max 0248, 0247 absent) and the stage checks.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
BUNDLE=migrations-stage0248.tar
BUNDLE_SHA=c9ebfcec810cf1fe49119c38e64beb0eba63230a21be502531464818a79c7fc7
LIST=MIGRATIONS-stage0248.sha256
LIST_SHA=c71fb7674fdaad384bfabb42185df7b3240207afabc9c4e641760eb5ce376c80
REF=alhhybgqdmcdyzpybykj
URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
HEAD_SHA=91a28fb006fdd00baff80381a52c29d0e672a633  # the apply head: #1224 (production chain + sealed 0248 only), pinned by the S0a variant too
TOMB="$ROOT/s1-apply/FAILED-LOGIN"
NFILES=246
MAXV=248
S0A_MAX_AGE_S=7200  # OPS value: S0a must be no older than 120 minutes at the push confirm (the S0-8 floor is 110)
SEALED_SHA=1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3
STATEF="$ROOT/s1-apply/APPLY-STATE"

# The ONE pending file and its sha256 (sealed 0248; templates/stage-0248/review.md). 0247, 0249 and 0250 are NOT in this stage.
#GOPEND-BEGIN
GOPEND='1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3  0248_intake_protected_write_enforcement.sql'
#GOPEND-END

PW=""
STAGE=start
cleanup() {
  PW=""
  unset PW PGPASSWORD SUPABASE_DB_PASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo >&2; echo "STOP: interrupted at stage $STAGE; credentials cleared. Do not press Ctrl-C or close this window during the push; the only way to stop a statement is the watchdog. If the stage was the push, the database state is UNKNOWN: do the S1 read-back before anything else, and do NOT rerun this script." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
epoch() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null; }
strip() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1"; }

[ $# -eq 0 ] || die "this script takes no arguments"
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#([Uu]ser|[Hh]ost|[Hh]ostaddr|[Dd]bname)=[^ ,)]*#\1=<masked>#g' -e 's#([Uu]ser|[Rr]ole) "[^"]*"#\1 <masked>#g' -e 's#[A-Za-z0-9.-]*\.supabase\.com[:0-9]*#<host>#g'; }
is_auth_failure() { strip "$1" | grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found'; }
tombstone() { # tombstone PHASE: written BEFORE dying on an authentication failure; holds the UTC time and the phase, no secret
  mkdir -p "$ROOT/s1-apply" 2>/dev/null
  printf 'failed login at %s in phase %s\n' "$(utcnow)" "$1" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
}

# ---------------------------------------------------------------------------------------------------------
# Part 0: this Mac, the verified binary, a clean environment (NAMES only, never values)
# ---------------------------------------------------------------------------------------------------------
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
for t in shasum tar awk sed grep find mktemp cut sort diff wc tr; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
[ -r /dev/tty ] || die "no terminal for private entry"
SELF=$(cd "$(dirname "$0")" && pwd -P) || die "cannot resolve the script directory"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink (run the Mac installer check first)"
[ -n "$(find "$ROOT" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || die "$ROOT must be owned by you and not writable by group or others"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -n "$(find "$BIN" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || die "supabase-go must be owned by you and not writable by group or others"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then
  die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."
fi
#SINGLEFLIGHT-BEGIN
# GATE 2 (single flight): ANY marker refuses a start. This script never clears it and no trap does: an UNKNOWN push can never be rerun.
# Only s1-reconcile-0248.sh clears it, with read-back evidence newer than the marker, and it archives the marker rather than deleting it.
if [ -e "$STATEF" ] || [ -L "$STATEF" ]; then
  die "a previous run left $STATEF ($(head -c 160 "$STATEF" 2>/dev/null | tr -d '\n')): the outcome of that push is UNKNOWN or not yet verified, so this script will not start. Read back the migration history (window-s1read-0248.sh), then clear the marker ONLY with s1-reconcile-0248.sh. Nothing was attempted."
fi
#SINGLEFLIGHT-END
case "$URL" in postgresql://*) ;; *) die "internal: the URL is not a postgresql:// URL" ;; esac
userinfo=${URL#postgresql://}; userinfo=${userinfo%%@*}
case "$userinfo" in *:*|*%*) die "internal: the URL carries a password-like userinfo" ;; esac
case "$URL" in *password=*|*Password=*) die "internal: the URL carries a password parameter" ;; esac
case "$URL" in *:6543/*) die "internal: the transaction pooler (6543) is never used" ;; esac
case "$URL" in *sslmode=require*) ;; *) die "internal: the URL does not require TLS" ;; esac

mkdir -p "$ROOT" || die "mkdir failed"
WORK=$(mktemp -d "$ROOT/s1apply.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"

# ---------------------------------------------------------------------------------------------------------
# Part 1: the bundle. Both files are pinned by sha256; the tar is checked entry by entry BEFORE extraction.
# 0247 and above cannot be in the bundle, and any extra, missing or altered file stops here.
# ---------------------------------------------------------------------------------------------------------
[ -f "$SELF/$BUNDLE" ] && [ ! -L "$SELF/$BUNDLE" ] || die "$BUNDLE is not next to this script"
[ -f "$SELF/$LIST" ] && [ ! -L "$SELF/$LIST" ] || die "$LIST is not next to this script"
[ "$(sha "$SELF/$BUNDLE")" = "$BUNDLE_SHA" ] || die "$BUNDLE sha256 mismatch (tampered or wrong file)"
[ "$(sha "$SELF/$LIST")" = "$LIST_SHA" ] || die "$LIST sha256 mismatch (tampered or wrong file)"
grep -Eqv '^[0-9a-f]{64}  [0-9]{4}_[A-Za-z0-9_]+\.sql$' "$SELF/$LIST" && die "$LIST has a malformed line"
prev=0
while IFS= read -r l; do
  v=${l#*  }; v=${v%%_*}
  case "$v" in [0-9][0-9][0-9][0-9]) ;; *) die "$LIST: a malformed version" ;; esac
  vn=$((10#$v))
  [ "$vn" -le "$MAXV" ] || die "$LIST names a file above $(printf '%04d' "$MAXV"): $v"
  [ "$vn" -gt "$prev" ] || die "$LIST is not strictly ascending at $v"
  prev=$vn
done < "$SELF/$LIST"
[ "$prev" = "$MAXV" ] || die "$LIST does not end at $(printf '%04d' "$MAXV")"
n=$(grep -c '' "$SELF/$LIST"); [ "$n" = "$NFILES" ] || die "$LIST has $n lines, expected $NFILES"
# the pending file equals the sealed 0248, byte for byte (name and hash)
awk '{v=substr($2,1,4)+0; if (v>=248 && v<=248) print}' "$SELF/$LIST" > "$WORK/pending-from-list.txt" || die "cannot derive the pending list"
printf '%s\n' "$GOPEND" | diff -q - "$WORK/pending-from-list.txt" >/dev/null 2>&1 || die "the pending file in $LIST differs from the sealed 0248"
[ "$(printf '%s\n' "$GOPEND" | grep -c '')" = 1 ] || die "internal: the embedded pending list is not 1 line"
# STAGE 0248-ONLY: 0247 (and 0249/0250) must be ABSENT from the list and the tar. Left in the directory, the same push would apply 0247 with 0248 (CI run 40710819431).
grep -Eq '^[0-9a-f]{64}  (0247|0249|0250)_' "$SELF/$LIST" && die "$LIST names 0247, 0249 or 0250: they are not part of the 0248-only stage"
tar -tf "$SELF/$BUNDLE" 2>/dev/null | grep -Eq 'supabase/migrations/(0247|0249|0250)_' && die "$BUNDLE holds 0247, 0249 or 0250: they are not part of the 0248-only stage"
grep -Eq '^[0-9a-f]{64}  0248_' "$SELF/$LIST" || die "$LIST does not name 0248"
# tar entries: names, types, nothing else
tar -tf "$SELF/$BUNDLE" > /dev/null 2>&1 || die "$BUNDLE is not a readable tar"
ents=$(tar -tf "$SELF/$BUNDLE" 2>/dev/null | sed 's#/$##') || die "cannot list $BUNDLE"
printf '%s\n' "$ents" | grep -Evx 'supabase|supabase/migrations|supabase/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql' | head -3 | grep -q . && die "$BUNDLE holds an entry that is not supabase/migrations/NNNN_name.sql"
tar -tvf "$SELF/$BUNDLE" 2>/dev/null | cut -c1 | grep -Evx '[-d]' | head -1 | grep -q . && die "$BUNDLE holds a link or special entry"
over=$(printf '%s\n' "$ents" | sed -n 's#^supabase/migrations/\([0-9][0-9][0-9][0-9]\)_.*#\1#p' | awk -v m="$MAXV" '$1+0>m' | head -1)
[ -z "$over" ] || die "$BUNDLE holds a file above $(printf '%04d' "$MAXV"): version $over"
printf '%s\n' "$ents" | sed -n 's#^supabase/migrations/##p' | LC_ALL=C sort > "$WORK/names-from-tar.txt"
awk '{print $2}' "$SELF/$LIST" | LC_ALL=C sort > "$WORK/names-from-list.txt"
extra=$(LC_ALL=C comm -23 "$WORK/names-from-tar.txt" "$WORK/names-from-list.txt" | head -3 | tr '\n' ' ')
missing=$(LC_ALL=C comm -13 "$WORK/names-from-tar.txt" "$WORK/names-from-list.txt" | head -3 | tr '\n' ' ')
[ -z "$extra" ] || die "$BUNDLE has files that $LIST does not list: $extra"
[ -z "$missing" ] || die "$BUNDLE is missing files that $LIST lists: $missing"

# a fresh private project dir made from the bundle ONLY (no config.toml, no .env, no pooler-url, no linked project)
PROJ="$WORK/project"; LOGS="$WORK/logs"
mkdir "$PROJ" "$LOGS" || die "mkdir failed"
chmod 700 "$PROJ" "$LOGS" || die "chmod failed"
tar -xf "$SELF/$BUNDLE" -C "$PROJ" || die "could not extract $BUNDLE"
[ -z "$(find "$PROJ" -type l | head -1)" ] || die "the extracted bundle contains a link"
[ "$(find "$PROJ" -type f | wc -l | tr -d ' ')" = "$NFILES" ] || die "the extracted bundle does not hold exactly $NFILES files"
[ -z "$(find "$PROJ" -type f ! -path "$PROJ/supabase/migrations/*" | head -1)" ] || die "the extracted bundle holds a file outside supabase/migrations"
vout=$(cd "$PROJ/supabase/migrations" && shasum -a 256 -c "$SELF/$LIST" 2>&1) || die "an extracted migration differs from $LIST"
[ "$(printf '%s\n' "$vout" | grep -c ': OK$')" = "$NFILES" ] || die "the extracted migrations did not verify $NFILES files"
mkdir -p "$PROJ/supabase/.temp" || die "mkdir failed"
printf '%s\n' v2.102.0 > "$PROJ/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ ! -e "$PROJ/supabase/config.toml" ] && [ ! -e "$PROJ/supabase/.temp/pooler-url" ] && [ ! -e "$PROJ/supabase/.temp/project-ref" ] || die "internal: the project dir has linked-project files"
RUN="$WORK/run.txt"
{
  echo "S1 apply run started $(utcnow)"
  echo "script sha256 $(sha "$0")"
  echo "bundle sha256 $BUNDLE_SHA ($BUNDLE) list sha256 $LIST_SHA"
  echo "head $HEAD_SHA; files $NFILES; pending 1 (0248; 0247 absent)"
  echo "supabase-go sha256 $GO_SHA"
  echo "target pooler URL (no password): $URL"
} > "$RUN" || die "cannot write the run record"
echo "Bundle verified: $NFILES files, 0001..$(printf '%04d' "$MAXV"), the pending file equals the sealed 0248, 0247 absent. Working directory: $WORK" >&2

# ---------------------------------------------------------------------------------------------------------
# Part 2: the restore point gate (BEFORE any connection). Row 4 (window-row4.sh) leaves its result on this Mac; the
# restore point is READ from it and the operator must type it exactly as row 4 printed it. Nothing is guessed.
# ---------------------------------------------------------------------------------------------------------
#S0AGATE-BEGIN
# GATE 1 (S0a age): bind s0a_at from the NEWEST S0a record and refuse a missing, failed, pre-window or stale one. Not the OLDEST-first fallback:
# if the newest window.* directory is not a passing 0248 S0a, the answer is "run S0a again", never an older pass.
# s0a_at = the OLDEST started_at_utc among the 4 captured files (the conservative reading: the whole record is at least this fresh).
S0A_L1='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)'
S0A_L2='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path)'
s0a_gate() { # s0a_gate WHEN(start|confirm): sets S0A_DIR S0A_AT S0A_VSHA; dies on any refusal
  local when="$1" d f m line st nsc oldest nowt nows as_s
  d=$(ls -dt "$ROOT"/window.* 2>/dev/null | head -1)
  [ -n "$d" ] || die "no S0a record was found under $ROOT (a window.* directory). Run window-s0a-0248.sh inside the window first. Nothing was attempted."
  if [ ! -d "$d" ] || [ -L "$d" ] || [ -z "$(find "$d" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ]; then
    die "the newest S0a directory $d is not a private directory of yours. Nothing was attempted."
  fi
  [ -f "$d/verdict.txt" ] && [ ! -L "$d/verdict.txt" ] || die "the newest S0a run ($d) has no verdict: it was refused or did not finish, and an older pass is NOT used. Run window-s0a-0248.sh again. Nothing was attempted."
  [ -f "$d/attest/attestation.json" ] && grep -q "$SEALED_SHA" "$d/attest/attestation.json" || die "the newest S0a run ($d) is not a 0248-only S0a (its attestation does not name the sealed 0248). Nothing was attempted."
  if [ "$(grep -cFx -e "$S0A_L1" -e "$S0A_L2" "$d/verdict.txt")" != 1 ] || grep -qx 'OVERALL PASS' "$d/verdict.txt"; then
    die "the newest S0a run ($d) did not print exactly one accepted OVERALL PASS line: do not start S1. Run window-s0a-0248.sh again. Nothing was attempted."
  fi
  nsc=$(ls "$d/results" 2>/dev/null | grep -c '\.meta\.json$')
  [ "$nsc" = 4 ] || die "the newest S0a run ($d) holds $nsc capture sidecars, expected exactly 4. Nothing was attempted."
  oldest=""
  for m in "$d"/results/*.meta.json; do
    [ -f "$m" ] && [ ! -L "$m" ] && [ "$(grep -c '' "$m")" = 1 ] || die "an S0a sidecar is not a single plain line ($m). Nothing was attempted."
    line=$(cat "$m")
    st=$(printf '%s' "$line" | sed -n 's/.*"started_at_utc":"\([^"]*\)".*/\1/p')
    printf '%s' "$st" | LC_ALL=C grep -Eq "^$iso\$" || die "an S0a sidecar has no readable started_at_utc ($m). Nothing was attempted."
    if [ -z "$oldest" ] || [ "$st" \< "$oldest" ]; then oldest=$st; fi
  done
  nowt=$(utcnow); nows=$(epoch "$nowt"); as_s=$(epoch "$oldest")
  case "$nows$as_s" in *[!0-9]*|'') die "cannot read the S0a times" ;; esac
  [ "$as_s" -le "$nows" ] || die "s0a_at ($oldest) is in the future. Nothing was attempted."
  [ "$as_s" -ge "$ws_s" ] || die "s0a_at ($oldest) is before the window start $WSTART: the S0a record predates this window. Run window-s0a-0248.sh inside the window. Nothing was attempted."
  [ $((nows - as_s)) -le "$S0A_MAX_AGE_S" ] || die "the S0a record is $(( (nows - as_s) / 60 )) minutes old at the $when check (limit $((S0A_MAX_AGE_S / 60))): run window-s0a-0248.sh again. NOTHING was applied."
  S0A_DIR=$d; S0A_AT=$oldest; S0A_VSHA=$(sha "$d/verdict.txt")
}
#S0AGATE-END
STAGE=restore-point
ask() { # ask VAR "prompt"
  local _v
  IFS= read -r -p "$2" _v </dev/tty || die "could not read $1"
  printf -v "$1" '%s' "$_v"
}
echo "The time now is $(utcnow). Times are UTC, like 2026-10-27T01:00:00Z. Nothing is defaulted." >&2
ask WSTART "Window start (UTC): "
printf '%s' "$WSTART" | LC_ALL=C grep -Eq "^$iso\$" || die "window start is not YYYY-MM-DDTHH:MM:SSZ"
ask WEND "Window end (UTC): "
printf '%s' "$WEND" | LC_ALL=C grep -Eq "^$iso\$" || die "window end is not YYYY-MM-DDTHH:MM:SSZ"
[ "$WEND" \> "$WSTART" ] || die "the window end is not after the window start"
R4DIR=$(ls -dt "$ROOT"/row4.* 2>/dev/null | head -1)
[ -n "$R4DIR" ] || die "no row-4 result was found under $ROOT (a row4.* directory). Run window-row4.sh first. Nothing was attempted."
L1='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)'
L2='OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path, restore target L)'
if [ ! -d "$R4DIR" ] || [ -L "$R4DIR" ] || [ -z "$(find "$R4DIR" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || [ ! -f "$R4DIR/row4-attestation.json" ] || [ ! -f "$R4DIR/verdict.txt" ]; then
  die "the latest row-4 run was refused (or did not finish): do not start S1. Latest: $R4DIR. Run window-row4.sh again from the start. Nothing was attempted."
fi
if grep -Fxq -- "$L2" "$R4DIR/verdict.txt"; then
  die "the idle-path row-4 result is not accepted by this S1 script; use the named restore point. Latest: $R4DIR. Nothing was attempted."
fi
if ! grep -Fxq -- "$L1" "$R4DIR/verdict.txt" || grep -qx 'OVERALL PASS' "$R4DIR/verdict.txt" || [ "$(grep -c '^OVERALL PASS' "$R4DIR/verdict.txt")" != 1 ]; then
  die "the latest row-4 run was refused (or did not finish): do not start S1. This script accepts only the candidate-4 line: $L1. Latest: $R4DIR. Nothing was attempted."
fi
R4SEL=$(sed -n 's/^ *"selected_at_utc": "\([^"]*\)".*/\1/p' "$R4DIR/row4-attestation.json" | head -1)
printf '%s' "$R4SEL" | LC_ALL=C grep -Eq "^$iso\$" || die "the latest row-4 run has no readable selected restore point. Nothing was attempted."
echo "Row 4 result found: $R4DIR" >&2
ask RPOINT "Type the selected restore point exactly as row 4 printed it (UTC): "
printf '%s' "$RPOINT" | LC_ALL=C grep -Eq "^$iso\$" || die "the restore point is not YYYY-MM-DDTHH:MM:SSZ"
[ "$RPOINT" = "$R4SEL" ] || die "the restore point you typed is not the one in the row-4 result. Nothing was attempted."
now_s=$(epoch "$(utcnow)"); rp_s=$(epoch "$RPOINT"); ws_s=$(epoch "$WSTART"); we_s=$(epoch "$WEND")
case "$now_s$rp_s$ws_s$we_s" in *[!0-9]*|'') die "cannot read the times" ;; esac
[ "$rp_s" -le "$now_s" ] || die "the restore point is in the future"
[ $((now_s - rp_s)) -le 2700 ] || die "the restore point is older than 45 minutes: run window-row4.sh again from the start. Nothing was attempted."
[ "$rp_s" -ge "$ws_s" ] || die "the restore point is before the window start. Nothing was attempted."
echo "restore point $RPOINT (row-4 result $R4DIR; window $WSTART to $WEND)" >> "$RUN"
echo "Restore point accepted: $RPOINT ($(( (now_s - rp_s) / 60 )) minutes old)." >&2
#S0ASTART-BEGIN
s0a_gate start
[ "$R4SEL" \> "$S0A_AT" ] || [ "$R4SEL" = "$S0A_AT" ] || die "row 4 selected the restore point ($R4SEL) BEFORE the S0a record ($S0A_AT): row 4 runs after S0a. Nothing was attempted."
S0A_VSHA_START=$S0A_VSHA
echo "S0a record bound: $S0A_DIR (s0a_at $S0A_AT, verdict sha256 $S0A_VSHA, limit $((S0A_MAX_AGE_S / 60)) minutes at the push confirm)" >> "$RUN"
echo "S0a record accepted: s0a_at $S0A_AT." >&2
#S0ASTART-END

# ---------------------------------------------------------------------------------------------------------
# Part 3: the password (typed, never echoed), then ONE dry run. No retry: a failed login stops the script.
# ---------------------------------------------------------------------------------------------------------
STAGE=password
IFS= read -rs -p "Database password (not shown): " PW </dev/tty || die "could not read the password"
echo >&2
[ -n "$PW" ] || die "empty password; nothing was attempted"

run_cli() { # run_cli LOGFILE args...  (the password is in the child's environment only)
  local lf="$1"; shift
  ( cd "$PROJ" && PGPASSWORD="$PW" SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$BIN" "$@" ) </dev/null >"$lf" 2>&1
}
scan_log() { # scan_log FILE: a login-role / ban / password-reset path means the CLI left the plan
  if strip "$1" | grep -qiE 'login role|initialising|unban|network.?ban|reset.*password|api\.supabase\.com'; then
    if [ "$STAGE" = push ]; then
      die "the CLI reported a login-role / ban / password / Management API path DURING the push. The push may already have applied: do the S1 read-back before anything else. REPORT it (log: $1). Do not retry."
    fi
    die "the CLI reported a login-role / ban / password / Management API path. Stopped; REPORT it (log: $1). Do not retry."
  fi
}
WANT=$(printf '%s\n' "$GOPEND" | awk '{print $2}')

STAGE=dry-run
echo "dry run started $(utcnow)" >> "$RUN"
echo "Running the dry run (one connection attempt)..." >&2
DRY="$LOGS/dry-run.log"
rc=0; run_cli "$DRY" db push --db-url "$URL" --dry-run || rc=$?
echo "dry run finished $(utcnow) exit $rc" >> "$RUN"
scan_log "$DRY"
if [ "$rc" != 0 ]; then
  strip "$DRY" | tail -n 6 | mask >&2
  if is_auth_failure "$DRY"; then tombstone dry-run; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; fi
  die "the dry run failed (exit $rc), for example a connection or authentication error. NOTHING was applied. Do not retry from this script; report the log: $DRY"
fi
dsum=$(strip "$DRY")
printf '%s\n' "$dsum" | grep -qx 'DRY RUN: migrations will \*not\* be pushed to the database.' || die "the dry run did not announce itself as a dry run"
printf '%s\n' "$dsum" | grep -qx 'Would push these migrations:' || die "the dry run did not print 'Would push these migrations:'"
printf '%s\n' "$dsum" | grep -q 'Applying migration' && die "the dry run printed 'Applying migration': stopped"
got=$(printf '%s\n' "$dsum" | LC_ALL=C grep -E '^ *[^ ]+ +[0-9]{4}_[A-Za-z0-9_]+\.sql *$' | LC_ALL=C sed -E 's/^.* ([0-9]{4}_[A-Za-z0-9_]+\.sql) *$/\1/')
ngot=$(printf '%s\n' "$got" | grep -c '.')
[ "$ngot" = 1 ] || die "the dry run lists $ngot migrations, expected exactly 1. NOTHING was applied (log: $DRY)"
[ "$got" = "$WANT" ] || die "the dry run lists 1 migration but not the expected 0248. NOTHING was applied (log: $DRY)"
echo "Dry run OK: exactly 1 migration, 0248." >&2
echo "dry run listed exactly the 1 expected version" >> "$RUN"

# ---------------------------------------------------------------------------------------------------------
# Part 4: ONE push. The operator types APPLY. The log must show 1 "Applying migration" line, then the
# finish line, and the CLI must exit 0.
# ---------------------------------------------------------------------------------------------------------
STAGE=watchdog
echo "START THE WATCHDOG NOW in Terminal 2 (D3 operator runbook, section 2). It cancels a statement running past 120 seconds. Wait until it has printed BOTH: WATCHDOG armed (self-test ok)  and  watching for the push session to start." >&2
ask W1 "Terminal 2 printed  WATCHDOG armed  (type yes): "; [ "$W1" = yes ] || die "watchdog 'armed' not confirmed (type exactly: yes). NOTHING was applied."
ask W2 "Terminal 2 printed  watching for the push session to start  (type yes): "; [ "$W2" = yes ] || die "watchdog 'watching' not confirmed (type exactly: yes). NOTHING was applied."
echo "watchdog armed and watching confirmed $(utcnow)" >> "$RUN"
STAGE=confirm
echo "Do not press Ctrl-C or close this window during the push; the only way to stop a statement is the watchdog." >&2
ask GOWORD "Type  APPLY  to run the single push of that 1 migration (0248) now: "
[ "$GOWORD" = APPLY ] || die "not confirmed (type exactly: APPLY). NOTHING was applied."
now_s=$(epoch "$(utcnow)")
case "$now_s" in ''|*[!0-9]*) die "cannot read the time" ;; esac
[ $(( (we_s - now_s) / 60 )) -ge 75 ] || die "fewer than 75 minutes of the window remain ($(( (we_s - now_s) / 60 )) left; the steps after S1 need read-back 10, promote 10, watch 35, export guard 5 and lifting the holds 15). NOTHING was applied. Do not start the push."
[ $((now_s - rp_s)) -le 3600 ] || die "the restore point is now more than 60 minutes old: run window-row4.sh again from the start. NOTHING was applied."
#SFWRITE-BEGIN
s0a_gate confirm
[ "$S0A_VSHA" = "$S0A_VSHA_START" ] || die "the S0a verdict changed since the start of this run. NOTHING was applied."
mkdir -p "$ROOT/s1-apply" 2>/dev/null
( set -C; printf 'IN-FLIGHT %s head=%s run=%s\n' "$(utcnow)" "$HEAD_SHA" "$WORK" > "$STATEF" ) 2>/dev/null || die "cannot create the IN-FLIGHT marker $STATEF (it already exists, or the directory is not writable). NOTHING was applied."
sync 2>/dev/null || true
echo "IN-FLIGHT marker written $(utcnow); s0a_at $S0A_AT bound at the confirm" >> "$RUN"
#SFWRITE-END
STAGE=push
echo "push started $(utcnow)" >> "$RUN"
echo "Running the push (one connection attempt)..." >&2
PUSH="$LOGS/push.log"
rc=0; run_cli "$PUSH" db push --db-url "$URL" --yes || rc=$?
echo "push finished $(utcnow) exit $rc" >> "$RUN"
PW=""; unset PW
psum=$(strip "$PUSH")
napp=$(printf '%s\n' "$psum" | grep -c '^Applying migration ')
scan_log "$PUSH"
fail_report() {
  strip "$PUSH" | tail -n 12 | mask >&2
  if [ "$rc" != 0 ] && is_auth_failure "$PUSH"; then tombstone push; echo "An authentication failure was recorded in $TOMB: no further run is allowed until Sam decides." >&2; fi
  echo "Applying-migration lines seen: $napp of 1." >&2
  if strip "$PUSH" | grep -qE '57014|canceling statement due to user request'; then
    echo "A statement was cancelled (SQLSTATE 57014): follow the D3 operator runbook, section 5, After a cancel." >&2
  fi
  die "$1 The push may already have applied: do the S1 read-back before anything else. Files before the failing one are recorded and the failing file did not commit, but verify by reading the migration history. Do NOT rerun this script. Report the log: $PUSH"
}
[ "$rc" = 0 ] || fail_report "the push failed (exit $rc)."
[ "$napp" = 1 ] || fail_report "the push logged $napp 'Applying migration' lines, expected 1."
applied=$(printf '%s\n' "$psum" | LC_ALL=C grep -E '^Applying migration [0-9]{4}_[A-Za-z0-9_]+\.sql\.\.\.$' | LC_ALL=C sed -E 's/^Applying migration ([0-9]{4}_[A-Za-z0-9_]+\.sql)\.\.\.$/\1/')
[ "$applied" = "$WANT" ] || fail_report "the applied migration is not exactly 0248."
printf '%s\n' "$psum" | grep -qx 'Finished supabase db push.' || fail_report "the 'Finished supabase db push.' line is missing."

#SFDONE-BEGIN
# the push passed every check: the marker moves to APPLIED-UNVERIFIED (still refuses a start). If this write fails it stays IN-FLIGHT, which is also safe.
{ printf 'APPLIED-UNVERIFIED %s head=%s run=%s\n' "$(utcnow)" "$HEAD_SHA" "$WORK" > "$STATEF.tmp" && mv -f "$STATEF.tmp" "$STATEF"; } 2>/dev/null || echo "WARNING: could not move $STATEF to APPLIED-UNVERIFIED; it stays IN-FLIGHT, which also refuses a rerun." >&2
#SFDONE-END
{ echo "STAGE 0248 APPLIED $(utcnow): 1 migration (0248), finish line present, exit 0"; echo "dry-run log sha256 $(sha "$DRY")"; echo "push log sha256 $(sha "$PUSH")"; } >> "$RUN"
echo "STAGE 0248 APPLIED: exactly 1 migration (0248); 'Finished supabase db push.'; exit 0." >&2
echo "NEXT (read back before anything else): migration history must be 246 rows with max 0248 (0247 absent), and the 0248 verify checks. Run record and logs: $WORK" >&2
exit 0
