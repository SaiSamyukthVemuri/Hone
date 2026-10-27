#!/bin/bash
# Hone PITR STATUS (2 of 2): read the database's WAL-archiver state TWICE through the verified runner 471ecb9d and supabase-go dce26b75,
# N seconds apart, and print both readings with what changed. N = max(600, T + 180) seconds, T = archive_timeout in seconds as read in the
# FIRST reading (Insurance PITR-IDLE-RULE); never shorter than 10 minutes, at most 1800. If T is 0 or above 1200 the idle path is closed:
# the first reading is printed, no second reading is taken, and the script exits 3.
# Read-only; usable at any time (the SQL reads no user table and carries no chain guard). It prints OBSERVATIONS and an INDICATION that
# follows Insurance's rule A0-A4 / B; it does NOT promote anything: the comparator (a later candidate) evaluates the two result files.
# Exit 0 means two valid readings were captured. Fail-closed: the first failed command, refusal, authentication error or invalid result
# stops. No retries. Credentials are typed privately (never echoed, never on a command line, never written) and cleared on any exit.
# Nothing here creates a login role, resets a password or unbans an IP: PREVENTION is the runner's password-present rule; the log scan is
# only a detector after the fact. A failed login writes a tombstone (pitr-status/FAILED-LOGIN) and every later run refuses until Sam decides.
# Each reading is TWO logins: the main file, then pitr-ready-count.sql (optional: a permission refusal there is recorded as "not readable").
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
PS="$ROOT/pitr-status"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=089226bd6fee358c73e0ada7202362ed492e73778ca450b27ecaa625c62b371e
SQL=pitr-wal-status.sql
SQL_SHA=c91d7a497ce3b04b88aedd72c8b2729694b65c3c5cc2f051837e3f2365ad8cd5
READY=pitr-ready-count.sql
READY_SHA=339dd620685294375450206a312483165e3de938ee7eed54756ad5d33d2a523d
N_FLOOR=600
N_MARGIN=180
N_MAX=1800
T_MAX=1200
REF=alhhybgqdmcdyzpybykj
POOLER_URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
TOMB="$PS/FAILED-LOGIN"

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
mask_file() { mask < "$1" > "$1.m" && mv "$1.m" "$1"; }
is_auth_failure() { strip "$1" | grep -qiE 'authenticat|28P01|28000|password|banned|circuit|SASL|tenant or user not found'; }
tombstone() {
  mkdir -p "$PS" 2>/dev/null
  printf 'failed login at %s on %s\n' "$(utcnow)" "$1" > "$TOMB" 2>/dev/null || echo "WARNING: could not write $TOMB; do not re-run anyway." >&2
}
NOLOGIN="STOP HERE: do not retry; do not reset the password; do not unban. Close this Terminal and report the STOP line above."
# N for a given archive_timeout T (seconds): max(N_FLOOR, T + N_MARGIN); "closed" when T is not an integer, is 0 or exceeds T_MAX.
interval_for_T() {
  case "$1" in ''|*[!0-9]*) echo closed; return ;; esac
  if [ "$1" -gt 0 ] && [ "$1" -le "$T_MAX" ]; then
    n=$(( $1 + N_MARGIN )); [ "$n" -lt "$N_FLOOR" ] && n=$N_FLOOR
    [ "$n" -le "$N_MAX" ] && { echo "$n"; return; }
  fi
  echo closed
}

[ $# -eq 0 ] || die "this script takes no arguments"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
if [ -e "$TOMB" ] || [ -L "$TOMB" ]; then
  die "a previous run failed a login ($TOMB exists): report it to OPS; do not re-run; delete the file only after Sam decides. Nothing was attempted."
fi
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found (Node 18 or newer)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$PS/run-window-read-macos.sh" ] && [ "$(sha "$PS/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner copy missing or sha256 mismatch"
[ -f "$PS/MANIFEST.sha256" ] && [ "$(sha "$PS/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
[ -f "$PS/$SQL" ] && [ "$(sha "$PS/$SQL")" = "$SQL_SHA" ] || die "$SQL missing or sha256 mismatch"
[ -f "$PS/$READY" ] && [ "$(sha "$PS/$READY")" = "$READY_SHA" ] || die "$READY missing or sha256 mismatch"
oks=$(cd "$PS" && shasum -a 256 -c MANIFEST.sha256) || die "a gate file does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 2 ] || die "MANIFEST.sha256 did not verify exactly two gate files"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
WORK=$(mktemp -d "$ROOT/pitr-wal.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; LOGS="$WORK/logs"; TMPD="$WORK/tmp"
mkdir -p "$LINK/supabase/.temp" "$WORK/r1" "$WORK/r2" "$WORK/r1ready" "$WORK/r2ready" "$LOGS" "$TMPD" || die "mkdir failed"
chmod 700 "$LINK" "$WORK/r1" "$WORK/r2" "$WORK/r1ready" "$WORK/r2ready" "$LOGS" "$TMPD" || die "chmod failed"
printf '%s\n' "$REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"
[ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact (no trailing newline)"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ -r /dev/tty ] || die "no terminal for private entry"
echo "WAL status read started at $(utcnow) (UTC): two readings N seconds apart, N = max($N_FLOOR, T + $N_MARGIN) from the first reading (about 10 to 23 minutes). Keep this terminal open until it finishes." >&2

IFS= read -rs -p "Supabase access token (not shown): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"
echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "Database password (not shown; only its presence is used here): " SUPABASE_DB_PASSWORD </dev/tty || die "could not read the password"
echo >&2
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"

run_gate() { # run_gate FILE RESDIR LOGTAG: one run through the runner; sets GRC; stops on a login-role / ban / password path
  GRC=0
  ( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$2" \
      SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$PS/run-window-read-macos.sh" "$1" ) </dev/null 2>"$LOGS/$3.err" || GRC=$?
  mask_file "$LOGS/$3.err" || die "could not mask the log of $3"
  if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$3.err"; then
    tombstone "$3"
    die "$3: the CLI reported a login-role / ban / password path; recorded in $TOMB and stopped; REPORT it (log: $LOGS/$3.err). $NOLOGIN"
  fi
}
validate_result() { # validate_result FILE WANTSQLSHA RESDIR LABEL: result is a non-empty array of objects and the sidecar binds it
  stem=${1%.sql}; r="$3/$stem.json"; m="$3/$stem.meta.json"
  [ -f "$r" ] && [ -f "$m" ] || die "$4: result or sidecar missing"
  c=$(LC_ALL=C tr -d '[:space:]' < "$r")
  case "$c" in "[{"*"}]") ;; *) die "$4: the result is not a non-empty JSON array of objects" ;; esac
  rs=$(sha "$r")
  [ "$(grep -c '' "$m")" = 1 ] || die "$4: the sidecar is not exactly one line"
  line=$(cat "$m")
  printf '%s\n' "$line" | grep -Eqx "\\{\"file\":\"$1\",\"sql_sha256\":\"$2\",\"result_sha256\":\"$rs\",\"started_at_utc\":\"$iso\",\"captured_at_utc\":\"$iso\",\"exit_code\":0,\"runner_sha256\":\"$RUNNER_SHA\",\"manifest_sha256\":\"$MANIFEST_SHA\"\\}" \
    || die "$4: the sidecar does not bind this result (file, sql, result hash, exit code, runner or manifest)"
  VR="$rs"
}
read_once() { # read_once N: the main file (mandatory), then the ready count (optional)
  N=$1
  echo "mac_before=$(utcnow)" >> "$WORK/stamps-$N.txt"
  run_gate "$SQL" "$WORK/r$N" "r$N"
  echo "mac_after=$(utcnow)" >> "$WORK/stamps-$N.txt"
  if [ "$GRC" != 0 ]; then
    if grep -qiE 'permission denied|42501' "$LOGS/r$N.err"; then
      tail -n 5 "$LOGS/r$N.err" >&2
      die "reading $N: a permission refusal was reported: the connecting role cannot read part of the WAL status. This closes the idle path. Stopped (log: $LOGS/r$N.err). Report which function or view."
    fi
    if is_auth_failure "$LOGS/r$N.err"; then
      tombstone "r$N"; strip "$LOGS/r$N.err" | tail -n 4 | mask >&2
      die "reading $N: an authentication failure was recorded in $TOMB. $NOLOGIN"
    fi
    tail -n 5 "$LOGS/r$N.err" >&2
    die "reading $N failed (exit $GRC): a refusal or an invalid result."
  fi
  validate_result "$SQL" "$SQL_SHA" "$WORK/r$N" "reading $N"
  echo "ok reading $N at $(utcnow) (result sha256 $VR)" >&2
  run_gate "$READY" "$WORK/r${N}ready" "r${N}ready"
  if [ "$GRC" != 0 ]; then
    if grep -qiE 'permission denied|42501' "$LOGS/r${N}ready.err"; then
      echo "not readable" > "$WORK/r${N}ready/UNREADABLE"
      echo "note: reading $N ready count is not readable by this role (permission refusal); recorded, not a stop." >&2
    elif is_auth_failure "$LOGS/r${N}ready.err"; then
      tombstone "r${N}ready"; strip "$LOGS/r${N}ready.err" | tail -n 4 | mask >&2
      die "reading $N ready count: an authentication failure was recorded in $TOMB. $NOLOGIN"
    else
      tail -n 5 "$LOGS/r${N}ready.err" >&2
      die "reading $N ready count failed (exit $GRC) for a reason other than a permission refusal."
    fi
  else
    validate_result "$READY" "$READY_SHA" "$WORK/r${N}ready" "reading $N ready count"
  fi
}

read_once 1
T=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=j[0].archive_timeout_s;process.stdout.write(Number.isInteger(t)?String(t):"")' "$WORK/r1/pitr-wal-status.json") || die "could not read archive_timeout_s from reading 1"
NSEC=$(interval_for_T "$T")
T1=$(date +%s)
if [ "$NSEC" = closed ]; then
  unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  echo "IDLE PATH CLOSED: archive_timeout read as '$T' seconds (the idle proof needs 0 < T <= $T_MAX). No second reading was taken. The first reading is in $WORK/r1." >&2
  echo "The route is the named restore point (needs Sam's authorization). Exit 3." >&2
  exit 3
fi
echo "archive_timeout T = $T s, so N = $NSEC s between the readings. Second reading at about $(date -u -r $(( T1 + NSEC + 3 )) +%H:%M:%SZ) (UTC)." >&2
while :; do
  left=$(( NSEC + 3 - ($(date +%s) - T1) ))
  [ "$left" -le 0 ] && break
  s=60; [ "$left" -lt 60 ] && s=$left
  echo "waiting: $left s until the second reading" >&2
  sleep "$s"
done
read_once 2
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
extra=$(cd "$WORK" && ls -A r1 r2 r1ready r2ready | grep -vE '\.(meta\.)?json$|^UNREADABLE$|^r[12](ready)?:$|^$' || true)
[ -z "$extra" ] || die "unexpected files in the results directories: $extra"

# ---------------------------------------------------------------------------------------------------------
# print both readings, what changed, and an INDICATION that follows Insurance's rule; the comparator decides
# ---------------------------------------------------------------------------------------------------------
cat > "$TMPD/show.mjs" <<'NODE'
import { readFileSync, existsSync } from "node:fs";
const e = process.env;
const fail = (m) => { console.error(m); process.exit(1); };
const one = (n) => { const j = JSON.parse(readFileSync(`${e.A_WORK}/r${n}/pitr-wal-status.json`, "utf8")); if (!Array.isArray(j) || j.length !== 1 || !j[0] || typeof j[0] !== "object") fail(`reading ${n}: not exactly one row`); return j[0]; };
const ready = (n) => { if (existsSync(`${e.A_WORK}/r${n}ready/UNREADABLE`)) return null; const j = JSON.parse(readFileSync(`${e.A_WORK}/r${n}ready/pitr-ready-count.json`, "utf8")); return (Array.isArray(j) && j.length === 1) ? j[0] : null; };
const a = one(1), b = one(2), ra = ready(1), rb = ready(2);
const REQ = ["db_now_utc", "postmaster_start_utc", "in_recovery", "lsn_write", "lsn_insert", "lsn_flush", "cur_wal_file", "cur_wal_offset", "archived_count", "last_archived_wal", "last_archived_utc", "failed_count", "archiver_stats_reset_utc", "archive_mode", "archive_timeout_s", "wal_level", "checkpoint_timeout", "wal_segment_size", "next_xid"];
const why = [];
for (const [n, r] of [[1, a], [2, b]]) for (const k of REQ) if (r[k] === null || r[k] === undefined || r[k] === "") why.push(`reading ${n}: ${k} is missing or null`);
const cols = [...REQ, "wal_segment_size_bytes", "last_failed_wal", "last_failed_utc", "xact_commit", "xact_rollback"];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("column", 26) + pad("reading 1", 34) + "reading 2");
for (const c of cols) console.log(pad(c, 26) + pad(a[c] === null ? "null" : a[c], 34) + (b[c] === null ? "null" : b[c]));
console.log(pad("ready_count (.ready files)", 26) + pad(ra ? ra.ready_count : "not readable", 34) + (rb ? rb.ready_count : "not readable"));
const gap = (Date.parse(b.db_now_utc) - Date.parse(a.db_now_utc)) / 1000;
const N = Number(e.A_N);
const skew = (n, r) => { const t = readFileSync(`${e.A_WORK}/stamps-${n}.txt`, "utf8").split("\n"); const g = (k) => Date.parse((t.find((x) => x.startsWith(k + "=")) || "").split("=")[1]); const mid = (g("mac_before") + g("mac_after")) / 2; return Math.round((Date.parse(r.db_now_utc) - mid) / 1000); };
const s1 = skew(1, a), s2 = skew(2, b);
console.log("");
console.log(`interval by the database clock: ${gap} s (required N = ${N} s, at most 1800); Mac-versus-database clock difference: ${s1} s and ${s2} s (the idle proof needs each within 60)`);
if (!(gap >= N && gap <= 1800)) why.push(`interval ${gap} s is outside N=${N}..1800`);
if (Math.abs(s1) > 60 || Math.abs(s2) > 60) why.push("Mac and database clocks differ by more than 60 s");
const big = (x) => (x === null || x === undefined || x === "") ? null : BigInt(String(x));
const dd = (c) => { const x = big(a[c]), y = big(b[c]); return (x === null || y === null) ? null : y - x; };
const lsnEq = (r) => r.lsn_write === r.lsn_insert && r.lsn_insert === r.lsn_flush;
const lsnSame = lsnEq(a) && lsnEq(b) && a.lsn_write === b.lsn_write;
const dArch = dd("archived_count"), dFail = dd("failed_count");
console.log(`difference: archived_count +${dArch}, failed_count +${dFail}; lsn_write/insert/flush equal to each other and across readings: ${lsnSame}; next_xid equal: ${a.next_xid === b.next_xid}; last_archived_wal changed: ${a.last_archived_wal !== b.last_archived_wal}; xact_commit +${dd("xact_commit")} (diagnostic only)`);
const sameServer = a.postmaster_start_utc === b.postmaster_start_utc && a.archiver_stats_reset_utc === b.archiver_stats_reset_utc && a.in_recovery === false && b.in_recovery === false && String(a.cur_wal_file).slice(0, 8) === String(b.cur_wal_file).slice(0, 8);
if (!sameServer) why.push("the server restarted, changed timeline, reset its archiver statistics or is in recovery between the readings");
const T = a.archive_timeout_s;
const cfgOK = ["on", "always"].includes(a.archive_mode) && Number.isInteger(T) && T > 0 && T <= 1200 && ["replica", "logical"].includes(a.wal_level);
if (!cfgOK) why.push("archiving is not configured as the idle proof needs (archive_mode on/always, 0 < archive_timeout <= 1200, wal_level replica/logical)");
const plain = (w) => /^[0-9A-F]{24}$/.test(w || "");
const perLog = (r) => (Number.isInteger(Number(r.wal_segment_size_bytes)) && Number(r.wal_segment_size_bytes) > 0) ? 4294967296n / BigInt(r.wal_segment_size_bytes) : null;
const idx = (w, pl) => BigInt("0x" + w.slice(8, 16)) * pl + BigInt("0x" + w.slice(16, 24));
const rel = (r) => { const pl = perLog(r); if (!plain(r.last_archived_wal)) return /\.(backup|history)$/.test(r.last_archived_wal || "") || /\.backup$/.test(r.last_archived_wal || "") ? "label" : "unknown"; if (pl === null || !plain(r.cur_wal_file)) return "unknown"; if (r.last_archived_wal.slice(0, 8) !== r.cur_wal_file.slice(0, 8)) return "other-timeline"; return String(idx(r.cur_wal_file, pl) - idx(r.last_archived_wal, pl)); };
const rl1 = rel(a), rl2 = rel(b);
console.log(`WAL segments from the last archived file to the current file: reading 1 = ${rl1}, reading 2 = ${rl2} ("1" means the open segment is exactly the next one; "label" means the last archived item is a .backup/.history label)`);
const readyZero = (rr) => rr !== null && Number(rr.ready_count) === 0;
const readyPos = (rr) => rr !== null && Number(rr.ready_count) > 0;
let cls;
const failing = (dFail !== null && dFail > 0n) || (b.last_failed_utc && b.last_archived_utc && b.last_failed_utc > b.last_archived_utc);
const backlog = [rl1, rl2].some((x) => /^[0-9]+$/.test(x) && Number(x) >= 2) || readyPos(ra) || readyPos(rb);
if (why.length && !sameServer) cls = "UNKNOWN";
else if (failing) { cls = "STALLED"; why.push("the archiver is failing (failed_count rose, or the last failure is later than the last archive)"); }
else if (!lsnSame && dArch === 0n && a.last_archived_wal === b.last_archived_wal) { cls = "STALLED"; why.push("WAL position moved but nothing was shipped within the interval"); }
else if (backlog) { cls = "STALLED"; why.push("completed WAL segments are waiting (two or more segments ahead of the last archived file, or .ready files exist)"); }
else if (why.length) cls = "UNKNOWN";
else {
  const archOK = Number(b.archived_count) >= 1 && b.last_archived_utc && b.last_archived_wal;
  const noShip = dArch === 0n && a.last_archived_wal === b.last_archived_wal;
  const segOK = (rl1 === "1" && rl2 === "1") || (rl1 === "label" && rl2 === "label" && readyZero(ra) && readyZero(rb));
  if (archOK && lsnSame && noShip && a.next_xid === b.next_xid && segOK) cls = "IDLE_PROVEN";
  else if (archOK && dArch > 0n && dFail === 0n) cls = "ACTIVE_HEALTHY";
  else { cls = "UNKNOWN"; why.push("the readings fit neither an idle nor an active-and-archiving server (for example the label case with no readable zero .ready count)"); }
}
console.log(`INDICATION: ${cls}${why.length ? " - " + why.join("; ") : ""}`);
console.log("This is an indication from the two readings, not the gate: Insurance's rule (A0-A8, B) is evaluated by the comparator, and it also needs the provider horizon L from pitr-backups.sh.");
NODE
A_WORK="$WORK" A_N="$NSEC" node "$TMPD/show.mjs" </dev/null || die "could not read the two readings (see the line above); results are in $WORK"
echo "PITR WAL STATUS READ COMPLETE at $(utcnow) (UTC): two valid readings $NSEC s apart; observation only. Results are in $WORK" >&2
exit 0
