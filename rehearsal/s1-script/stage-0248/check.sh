#!/bin/bash
# REHEARSAL - NEVER MERGE. CI check of the 0248-ONLY apply variant (no hosted access, no database): the committed variant equals the regenerated one,
# its pinned shas equal the regenerated bundle, Part 1 (the bundle gate) ACCEPTS the stage bundle and REFUSES five wrong bundles. N of N asserted.
set -u
D="$(cd "$(dirname "$0")" && pwd)"; S1=$(dirname "$D"); T=${RUNNER_TEMP:-/tmp}/stage0248; rm -rf "$T"; mkdir -p "$T/gen"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
python3 -I "$D/make-stage-0248.py" "$T/gen" > "$T/gen.out" || { cat "$T/gen.out"; echo "FAIL - generator"; exit 1; }
V=$D/s1-apply-0248.sh
cmp -s "$T/gen/s1-apply-0248.sh" "$V" && cmp -s "$T/gen/MIGRATIONS-stage0248.sha256" "$D/MIGRATIONS-stage0248.sha256" && ok "the committed variant and list equal the regenerated ones (deterministic)" || bad "committed variant differs from the regenerated one"
bsha=$(sha256sum "$T/gen/migrations-stage0248.tar" | cut -d' ' -f1); lsha=$(sha256sum "$T/gen/MIGRATIONS-stage0248.sha256" | cut -d' ' -f1)
grep -q "^BUNDLE_SHA=$bsha\$" "$V" && grep -q "^LIST_SHA=$lsha\$" "$V" && ok "the variant pins the regenerated bundle and list sha256" || bad "pins differ"
if grep -nE '\b34\b|0213|GO34|\b245\b' "$V" > "$T/resid.txt"; then bad "1035-stage constants remain in the variant" "$(head -3 "$T/resid.txt")"; else ok "no 0213, 34, 245 or GO34 constants remain in the variant"; fi
# Part 1 harness: the variant's own assignments and its own Part 1 text, with stubs for the Mac-only parts
mkpart() { # mkpart BUNDLE LIST OUTSCRIPT: pins taken from the files under test, so a refusal is the RULE's, not a sha mismatch
  { grep -E '^(BUNDLE|LIST|NFILES|MAXV)=' "$V"; echo "BUNDLE_SHA=$(sha256sum "$1" | cut -d' ' -f1)"; echo "LIST_SHA=$(sha256sum "$2" | cut -d' ' -f1)"
    sed -n '/^#GOPEND-BEGIN$/,/^#GOPEND-END$/p' "$V"
    echo 'die() { echo "STOP: $*" >&2; exit 1; }; sha() { sha256sum "$1" | cut -d" " -f1; }; shasum() { shift 2; sha256sum "$@"; }'
    echo 'SELF=$1; WORK=$2; mkdir -p "$WORK"; HEAD_SHA=x; GO_SHA=x; URL=x; utcnow() { date -u +%FT%TZ; }'
    sed -n '/^\[ -f "\$SELF\/\$BUNDLE" \]/,/^echo "Bundle verified/p' "$V"; } > "$3"; }
runp() { # runp BUNDLE LIST NAME -> RC, OUT
  local d=$T/$3; mkdir -p "$d"; cp "$1" "$d/migrations-stage0248.tar"; cp "$2" "$d/MIGRATIONS-stage0248.sha256"
  mkpart "$d/migrations-stage0248.tar" "$d/MIGRATIONS-stage0248.sha256" "$d/part1.sh"; OUT=$(bash "$d/part1.sh" "$d" "$d/work" 2>&1); RC=$?; }
G=$T/gen
runp "$G/migrations-stage0248.tar" "$G/MIGRATIONS-stage0248.sha256" good
[ $RC = 0 ] && echo "$OUT" | grep -q 'Bundle verified: 246 files' && ok "Part 1 ACCEPTS the 0248-only bundle (246 files, pending = sealed 0248, 0247 absent)" || bad "good bundle refused" "rc=$RC $OUT"
# tampered bundles: rebuild tar + list from the good files with one change each
python3 -I - "$G" "$T" <<'PY'
import hashlib, io, os, sys, tarfile
g, t = sys.argv[1], sys.argv[2]
src = tarfile.open(os.path.join(g, "migrations-stage0248.tar")); files = {m.name: src.extractfile(m).read() for m in src.getmembers() if m.isfile()}
def build(name, change):
    f = dict(files); change(f); os.makedirs(os.path.join(t, "v-" + name), exist_ok=True)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        for d in ("supabase", "supabase/migrations"):
            ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; tf.addfile(ti)
        for n in sorted(f):
            ti = tarfile.TarInfo(n); ti.size = len(f[n]); ti.mode = 0o644; tf.addfile(ti, io.BytesIO(f[n]))
    open(os.path.join(t, "v-" + name, "b.tar"), "wb").write(buf.getvalue())
    open(os.path.join(t, "v-" + name, "l.txt"), "w").write("".join("%s  %s\n" % (hashlib.sha256(f[n]).hexdigest(), os.path.basename(n)) for n in sorted(f)))
P = "supabase/migrations/"
# a swap (0001 out, 0247 in) keeps the count at 246 and the list ending at 0248, so only the explicit 0247 rule can refuse it
build("plus0247", lambda f: (f.pop([k for k in f if "/0001_" in k][0]), f.__setitem__(P + "0247_x.sql", b"select 1;\n")))
build("plus0249", lambda f: f.__setitem__(P + "0249_x.sql", b"select 1;\n"))
build("no0248", lambda f: f.pop(P + "0248_intake_protected_write_enforcement.sql"))
build("altered0248", lambda f: f.__setitem__(P + "0248_intake_protected_write_enforcement.sql", f[P + "0248_intake_protected_write_enforcement.sql"] + b"-- x\n"))
build("extra0100", lambda f: f.__setitem__(P + "0100_extra.sql", b"select 1;\n"))
PY
for c in plus0247:'0247, 0249 or 0250' plus0249:'above 0248' no0248:'does not end at 0248' altered0248:'differs from the sealed 0248' extra0100:'not strictly ascending'; do
  n=${c%%:*}; pat=${c#*:}; runp "$T/v-$n/b.tar" "$T/v-$n/l.txt" "n-$n"
  [ $RC != 0 ] && echo "$OUT" | grep -Eq "$pat" && ok "Part 1 REFUSES a bundle that is wrong by '$n' (matches /$pat/)" || bad "bundle '$n' not refused as expected" "rc=$RC $(echo "$OUT" | tail -2)"
done

# ---------------------------------------------------------------------------------------------------------------------------------
# STAGE-0248-MAC-GATES: gate 1 (S0a age), gate 2 (single flight) and the reconcile script. The harness lifts the REAL text of each gate
# from the variant (markers #S0AGATE, #S0ASTART, #SINGLEFLIGHT, #SFWRITE, #SFDONE), supplies only a fake clock and a fake $HOME, and runs it.
# Every refusal asserts its specific STOP message. NOT executed by CI: the macOS-specific behaviour (BSD date/stat, bash 3.2); the text avoids
# flock, stat -c, sync FILE and bash 4 features, which the last case below checks.
# ---------------------------------------------------------------------------------------------------------------------------------
R=$D/s1-reconcile-0248.sh
blk() { sed -n "/^#$2-BEGIN\$/,/^#$2-END\$/p" "$1"; }
mkgate() { # mkgate OUT VARIANTFILE : the harness around the lifted gate text
  { echo 'set -u; umask 077'; grep -E '^(S0A_MAX_AGE_S|SEALED_SHA)=' "$2"
    echo 'iso="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"; die() { echo "STOP: $*" >&2; exit 1; }'
    echo 'shasum() { shift 2; sha256sum "$@"; }'; grep -E '^(sha|epoch)\(\)' "$2"; echo 'utcnow() { echo "$FAKE_NOW"; }'
    echo 'ROOT=$1; WSTART=$2; R4SEL=$3; ws_s=$(epoch "$WSTART"); WORK=$ROOT/work; RUN=$ROOT/run.txt; HEAD_SHA=testhead; STATEF="$ROOT/s1-apply/APPLY-STATE"; : > "$RUN"'
    blk "$2" SINGLEFLIGHT; blk "$2" S0AGATE; blk "$2" S0ASTART
    echo '[ -n "${FAKE_NOW2:-}" ] && FAKE_NOW=$FAKE_NOW2'
    echo 'mkdir -p "$ROOT/s1-apply"; [ "${PRECREATE:-}" = 1 ] && echo raced > "$STATEF"'
    blk "$2" SFWRITE; echo '[ "${DONE:-}" = 1 ] && {'; blk "$2" SFDONE; echo '}'; echo 'echo REACHED'; } > "$1"; }
mkfix() { # mkfix ROOT NAME OLDEST_START [verdict: ok|none|bare|two] [nsidecars] [sealed: yes|no]   (dir mtime = the OLDEST start, so ordering follows time)
  local d=$1/window.$2 t=$3 v=${4:-ok} ns=${5:-4} se=${6:-yes} f i=0; mkdir -p "$d/results" "$d/attest"
  for f in g02-history-0248 g12-0243-intake-definers-0248 s1-open-transactions-0248 w03-table-sizes-0248; do
    i=$((i+1)); [ $i -le "$ns" ] || break; echo '[{"x":1}]' > "$d/results/$f.json"
    printf '{"file":"%s.sql","sql_sha256":"a","result_sha256":"b","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$f" "$t" "$t" > "$d/results/$f.meta.json"; done
  [ "$se" = yes ] && echo '{"sealed":"1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3"}' > "$d/attest/attestation.json" || echo '{}' > "$d/attest/attestation.json"
  case $v in ok) echo 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)' > "$d/verdict.txt" ;; bare) printf 'OVERALL PASS\n' > "$d/verdict.txt" ;;
    two) printf 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)\nOVERALL PASS (provider range; base backup UNVERIFIED; restore not tested; idle path)\n' > "$d/verdict.txt" ;; none) ;; esac
  chmod 700 "$d"; touch -d "$t" "$d"; }
G=$T/gates; mkdir -p "$G"; mkgate "$G/h.sh" "$V"
gate() { # gate NAME NOW NOW2 WSTART R4SEL (fixture built by the caller in $G/NAME); env DONE/PRECREATE pass through -> RC OUT
  local r=$G/$1; OUT=$(FAKE_NOW=$2 FAKE_NOW2=$3 bash "$G/h.sh" "$r" "$4" "$5" 2>&1); RC=$?; }
refuses() { # refuses LABEL PATTERN  (uses RC OUT)
  [ $RC != 0 ] && ! echo "$OUT" | grep -q REACHED && echo "$OUT" | grep -Eq "$2" && ok "$1 (STOP matches /$2/)" || bad "$1 not refused as expected" "rc=$RC $(echo "$OUT" | tail -2)"; }
NOW=2026-10-28T12:00:00Z
# --- gate 1: S0a age
mkdir -p "$G/a1"; mkfix "$G/a1" x 2026-10-28T11:30:00Z; gate a1 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z
[ $RC = 0 ] && echo "$OUT" | grep -q REACHED && grep -q 'S0a record bound' "$G/a1/run.txt" && ok "gate 1 ACCEPTS a fresh S0a (30 min old) and binds s0a_at/verdict sha into the run record" || bad "fresh S0a refused" "rc=$RC $OUT"
mkdir -p "$G/a2"; mkfix "$G/a2" x 2026-10-28T09:50:00Z; gate a2 $NOW $NOW 2026-10-28T09:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES an S0a older than 120 min at the start" 'minutes old at the start check'
mkdir -p "$G/a3"; mkfix "$G/a3" x 2026-10-28T10:10:00Z; gate a3 $NOW 2026-10-28T12:20:00Z 2026-10-28T10:00:00Z 2026-10-28T11:50:00Z
refuses "gate 1 REFUSES at the confirm when the S0a has aged past 120 min since the start" 'minutes old at the confirm check'; [ ! -e "$G/a3/s1-apply/APPLY-STATE" ] && ok "  and no IN-FLIGHT marker was written on that refusal" || bad "marker written despite refusal"
mkdir -p "$G/a3b"; mkfix "$G/a3b" x 2026-10-28T10:00:00Z; gate a3b $NOW $NOW 2026-10-28T10:00:00Z 2026-10-28T11:50:00Z
[ $RC = 0 ] && ok "gate 1 boundary: exactly 120 minutes old is accepted (121 is refused in the next case)" || bad "120 min refused" "$OUT"
mkdir -p "$G/a3c"; mkfix "$G/a3c" x 2026-10-28T09:59:00Z; gate a3c $NOW $NOW 2026-10-28T09:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 boundary: 121 minutes old is refused" 'minutes old at the start check'
mkdir -p "$G/a4"; mkfix "$G/a4" x 2026-10-28T10:30:00Z; gate a4 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES an S0a that starts before the window start" 'before the window start'
mkdir -p "$G/a5"; mkfix "$G/a5" old 2026-10-28T11:00:00Z ok; mkfix "$G/a5" new 2026-10-28T11:40:00Z none; gate a5 $NOW $NOW 2026-10-28T10:00:00Z 2026-10-28T11:50:00Z
refuses "gate 1 REFUSES when the NEWEST S0a attempt failed, and does not fall back to an older pass" 'has no verdict.*older pass is NOT used'
mkdir -p "$G/a6"; mkfix "$G/a6" x 2026-10-28T11:30:00Z bare; gate a6 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES a bare OVERALL PASS line" 'did not print exactly one accepted OVERALL PASS'
mkdir -p "$G/a6b"; mkfix "$G/a6b" x 2026-10-28T11:30:00Z two; gate a6b $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES two accepted PASS lines" 'did not print exactly one accepted OVERALL PASS'
mkdir -p "$G/a7"; mkfix "$G/a7" x 2026-10-28T11:30:00Z ok 3; gate a7 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES an S0a with 3 capture sidecars" 'holds 3 capture sidecars, expected exactly 4'
mkdir -p "$G/a8"; mkfix "$G/a8" x 2026-10-28T11:30:00Z ok 4 no; gate a8 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES an S0a whose attestation does not name the sealed 0248" 'not a 0248-only S0a'
mkdir -p "$G/a9"; gate a9 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 1 REFUSES when there is no S0a record at all" 'no S0a record was found'
mkdir -p "$G/a10"; mkfix "$G/a10" x 2026-10-28T11:30:00Z; gate a10 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:00:00Z; refuses "gate 1 REFUSES a row-4 selection that predates the S0a record" 'BEFORE the S0a record'
mkdir -p "$G/a11"; mkfix "$G/a11" x 2026-10-28T12:30:00Z; gate a11 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T12:40:00Z; refuses "gate 1 REFUSES an S0a time in the future" 'is in the future'
mkdir -p "$G/a12"; mkfix "$G/a12" x 2026-10-28T11:30:00Z; sed -i 's/2026-10-28T11:30:00Z/2026-10-28T09:30:00Z/g' "$G/a12/window.x/results/g02-history-0248.meta.json"; gate a12 $NOW $NOW 2026-10-28T09:00:00Z 2026-10-28T11:50:00Z
refuses "gate 1 measures the OLDEST capture of the S0a record (one stale file makes the record stale)" 'minutes old at the start check'
# --- gate 2: single flight
mkdir -p "$G/b1"; mkfix "$G/b1" x 2026-10-28T11:30:00Z; DONE=0 gate b1 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z
m=$(cat "$G/b1/s1-apply/APPLY-STATE"); case "$m" in "IN-FLIGHT 2026-10-28T12:00:00Z head=testhead run="*) ok "gate 2 writes the IN-FLIGHT marker before the push (time, head, run directory)" ;; *) bad "marker content wrong" "$m" ;; esac
gate b1 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 2: an IN-FLIGHT (UNKNOWN) outcome REFUSES any new start" 'UNKNOWN or not yet verified'
mkdir -p "$G/b2"; mkfix "$G/b2" x 2026-10-28T11:30:00Z; DONE=1 gate b2 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z
case "$(cat "$G/b2/s1-apply/APPLY-STATE")" in "APPLIED-UNVERIFIED "*) ok "gate 2: a clean push moves the marker to APPLIED-UNVERIFIED" ;; *) bad "marker not moved" ;; esac
gate b2 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 2: APPLIED-UNVERIFIED also REFUSES a new start (only a recorded reconcile clears it)" 'UNKNOWN or not yet verified'
mkdir -p "$G/b3/s1-apply"; echo garbage > "$G/b3/s1-apply/APPLY-STATE"; mkfix "$G/b3" x 2026-10-28T11:30:00Z; gate b3 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 2: ANY marker content refuses (not only the two known words)" 'UNKNOWN or not yet verified'
mkdir -p "$G/b4/s1-apply"; echo target > "$G/b4/t"; ln -s "$G/b4/t" "$G/b4/s1-apply/APPLY-STATE"; mkfix "$G/b4" x 2026-10-28T11:30:00Z; gate b4 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 2: a symlink at the marker path refuses too" 'UNKNOWN or not yet verified'
mkdir -p "$G/b5"; mkfix "$G/b5" x 2026-10-28T11:30:00Z; PRECREATE=1 gate b5 $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z; refuses "gate 2: a marker created after the start check (a second terminal) refuses the exclusive create; nothing applied" 'cannot create the IN-FLIGHT marker'
[ "$(cat "$G/b5/s1-apply/APPLY-STATE")" = raced ] && ok "  and the racing marker was left untouched" || bad "racing marker was overwritten"
# --- the reconcile script
mkrc() { { echo 'set -u; umask 077'; grep -E '^(NONE_WAIT_S|SEALED_SHA|SQL_S1H|SQL_G02)=' "$R"; echo 'pgrep() { return ${PGREP_RC:-1}; }'; echo 'iso="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"; die() { echo "STOP: $*" >&2; exit 1; }'
    echo 'shasum() { shift 2; sha256sum "$@"; }'; grep -E '^(sha|epoch)\(\)' "$R"; echo 'utcnow() { echo "$FAKE_NOW"; }'; echo 'ROOT=$1; STATEF="$ROOT/s1-apply/APPLY-STATE"'
    blk "$R" RECONCILE; echo 'reconcile; echo "CLASS=$RECONCILE_CLASS"'; } > "$G/rc.sh"; }
mkrc
rcrun() { OUT=$(FAKE_NOW=$2 bash "$G/rc.sh" "$G/$1" 2>&1); RC=$?; }
mkmark() { mkdir -p "$G/$1/s1-apply"; echo "IN-FLIGHT 2026-10-28T11:00:00Z head=x run=y" > "$G/$1/s1-apply/APPLY-STATE"; }
SQLPIN_S1H=a4d3c5afad277cef9c720ea534309b6e6843d92e8ecf15b5232e180f03246e2a; SQLPIN_G02=19e4e05793e5fa033921ac35cd2a7337b7a6477d0f6a25747134791f7b317cfe
sidecar() { # sidecar DIR NAME PIN TIME : the REAL single-line sidecar shape of the read runner; SQLBAD=1 names another query, TAMPER=1 changes the result after the sidecar was written
  local j=$1/results/$2.json pin=$3; [ "${SQLBAD:-}" = 1 ] && pin=0000000000000000000000000000000000000000000000000000000000000000
  printf '{"file":"%s.sql","sql_sha256":"%s","result_sha256":"%s","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0,"runner_sha256":"r","manifest_sha256":"m"}\n' "$2" "$pin" "$(sha256sum "$j" | cut -d' ' -f1)" "$4" "$4" > "$1/results/$2.meta.json"
  [ "${TAMPER:-}" = 1 ] && sed -i 's/"rows_0247":"0"/"rows_0247":"0" /;s/"versions_ge_0247":"0"/"versions_ge_0247":"0" /' "$j"; return 0; }
mks1() { local d=$G/$1/s1read.x t=$2 rows=${3:-246} mx=${4:-0248}; mkdir -p "$d/results"; chmod 700 "$d"; echo "[{\"applied_count\":\"$rows\",\"hosted_max\":\"$mx\",\"rows_0248\":\"1\",\"rows_0247\":\"0\"}]" > "$d/results/s1-history-0248.json"
  sidecar "$d" s1-history-0248 $SQLPIN_S1H "$t"; echo 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' > "$d/verdict.txt"; }
mkdir -p "$G/c1"; mkmark c1; mks1 c1 2026-10-28T11:40:00Z; rcrun c1 $NOW
[ $RC = 0 ] && echo "$OUT" | grep -q 'CLASS=ALL' && [ ! -e "$G/c1/s1-apply/APPLY-STATE" ] && ls "$G"/c1/s1-apply/APPLY-STATE.cleared.* >/dev/null 2>&1 && ls "$G"/c1/s1-apply/RECONCILE-* >/dev/null 2>&1 && ok "reconcile ALL: a passing s1read newer than the marker archives the marker (renamed, not deleted) and writes a record" || bad "reconcile ALL failed" "rc=$RC $OUT"
mkdir -p "$G/c2"; mkmark c2; mks1 c2 2026-10-28T10:50:00Z; rcrun c2 $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence newer than the marker' && [ -e "$G/c2/s1-apply/APPLY-STATE" ] && ok "reconcile REFUSES evidence older than the marker and leaves the marker" || bad "old evidence accepted" "$OUT"
mkdir -p "$G/c3"; mkmark c3; mks1 c3 2026-10-28T11:40:00Z 245 0246; rcrun c3 $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence' && [ -e "$G/c3/s1-apply/APPLY-STATE" ] && ok "reconcile REFUSES an s1read whose history is not the 0248 end state" || bad "wrong history accepted" "$OUT"
mks0() { local d=$G/$1/window.x t=$2 rows=${3:-245} mx=${4:-0246}; mkdir -p "$d/results" "$d/attest"; chmod 700 "$d"; echo "[{\"applied_count\":\"$rows\",\"hosted_max\":\"$mx\",\"versions_ge_0247\":\"0\"}]" > "$d/results/g02-history-0248.json"
  sidecar "$d" g02-history-0248 $SQLPIN_G02 "$t"; echo '{"s":"1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3"}' > "$d/attest/attestation.json"
  echo 'OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)' > "$d/verdict.txt"; }
mkdir -p "$G/c4"; mkmark c4; mks0 c4 2026-10-28T11:10:00Z; rcrun c4 $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'at least 1200 s after the marker' && [ -e "$G/c4/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES a history read taken only 10 minutes after the marker (the push could still be running)" || bad "early NONE accepted" "$OUT"
mkdir -p "$G/c5"; mkmark c5; mks0 c5 2026-10-28T11:25:00Z; rcrun c5 $NOW; [ $RC = 0 ] && echo "$OUT" | grep -q 'CLASS=NONE' && [ ! -e "$G/c5/s1-apply/APPLY-STATE" ] && ok "reconcile NONE accepts a passing S0a history read taken 25 minutes after the marker (245 rows, max 0246)" || bad "NONE refused" "$OUT"
mkdir -p "$G/c6"; mkmark c6; mks0 c6 2026-10-28T11:25:00Z 246 0248; rcrun c6 $NOW; [ $RC != 0 ] && [ -e "$G/c6/s1-apply/APPLY-STATE" ] && ok "reconcile REFUSES an S0a-shaped read that shows 246 rows (it is not NONE; ALL needs the s1read evidence)" || bad "246-row S0a accepted as NONE" "$OUT"
mkdir -p "$G/c7"; rcrun c7 $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'there is no APPLY-STATE marker' && ok "reconcile REFUSES when there is no marker" || bad "no-marker case" "$OUT"
# H1: the evidence must be BOUND: the sidecar names the pinned query and the result's own sha256
mkdir -p "$G/h1a"; mkmark h1a; SQLBAD=1 mks1 h1a 2026-10-28T11:40:00Z; rcrun h1a $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence' && [ -e "$G/h1a/s1-apply/APPLY-STATE" ] && ok "reconcile ALL REFUSES an s1read sidecar that names another query (sql_sha256 is not the pinned a4d3c5af)" || bad "ALL accepted a wrong sql_sha256" "$OUT"
mkdir -p "$G/h1b"; mkmark h1b; TAMPER=1 mks1 h1b 2026-10-28T11:40:00Z; rcrun h1b $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence' && [ -e "$G/h1b/s1-apply/APPLY-STATE" ] && ok "reconcile ALL REFUSES an s1read result changed after its sidecar (result_sha256 does not match the JSON)" || bad "ALL accepted a tampered result" "$OUT"
mkdir -p "$G/h1c"; mkmark h1c; SQLBAD=1 mks0 h1c 2026-10-28T11:25:00Z; rcrun h1c $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence' && [ -e "$G/h1c/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES a g02 sidecar that names another query (not the pinned 19e4e057)" || bad "NONE accepted a wrong sql_sha256" "$OUT"
mkdir -p "$G/h1d"; mkmark h1d; TAMPER=1 mks0 h1d 2026-10-28T11:25:00Z; rcrun h1d $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'no usable read-back evidence' && [ -e "$G/h1d/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES a g02 result changed after its sidecar (result_sha256 does not match the JSON)" || bad "NONE accepted a tampered result" "$OUT"
# H2: NONE is the one route that allows a second push
mkdir -p "$G/h2a"; mkmark h2a; echo "APPLIED-UNVERIFIED 2026-10-28T11:00:00Z head=x run=y" > "$G/h2a/s1-apply/APPLY-STATE"; mks0 h2a 2026-10-28T11:25:00Z; rcrun h2a $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'marker word is not IN-FLIGHT' && [ -e "$G/h2a/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES an APPLIED-UNVERIFIED marker even with a passing 245-row read" || bad "NONE cleared APPLIED-UNVERIFIED" "$OUT"
mkdir -p "$G/h2b"; mkmark h2b; mks0 h2b 2026-10-28T11:25:00Z; PGREP_RC=0 rcrun h2b $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'a supabase or s1-apply-0248 process is running' && [ -e "$G/h2b/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES while a supabase or s1-apply-0248 process is running" || bad "NONE cleared with a process running" "$OUT"
mkdir -p "$G/h2c"; mkmark h2c; mks0 h2c 2026-10-28T11:25:00Z; PGREP_RC=127 rcrun h2c $NOW; [ $RC != 0 ] && echo "$OUT" | grep -q 'cannot be ruled out' && [ -e "$G/h2c/s1-apply/APPLY-STATE" ] && ok "reconcile NONE REFUSES when the process check itself cannot run (status 127)" || bad "NONE cleared with the process check broken" "$OUT"
# --- portability of the lifted text (macOS bash 3.2 / BSD tools): none of the Linux-only or bash-4 constructs
cat "$V" | sed -n '/^#S0AGATE-BEGIN$/,/^#S0AGATE-END$/p;/^#SINGLEFLIGHT-BEGIN$/,/^#SINGLEFLIGHT-END$/p;/^#SFWRITE-BEGIN$/,/^#SFWRITE-END$/p;/^#SFDONE-BEGIN$/,/^#SFDONE-END$/p;/^#S0ASTART-BEGIN$/,/^#S0ASTART-END$/p' > "$G/lifted.txt"; blk "$R" RECONCILE >> "$G/lifted.txt"
if grep -nE 'flock|stat -c|sync [^2 ]|declare -A|mapfile|readarray|\[\[|\$\{[a-z_A-Z0-9]+(,,|\^\^)|date -d|sha256sum|readlink -f' "$G/lifted.txt" > "$G/port.txt"; then bad "a non-portable construct is in the gate text" "$(head -3 "$G/port.txt")"; else ok "the gate and reconcile text uses no flock, stat -c, sync FILE, bash 4 construct, GNU date -d or sha256sum"; fi


# --- mutation run: each NEW refusal is mutated by one single-line edit and its negative control must then FAIL to refuse as specified
MUT=$T/mut; mkdir -p "$MUT"; mcaught=0; mtotal=0
mg() { # mg ID SEDEXPR SETUP NOW NOW2 WSTART R4SEL PATTERN : SETUP builds the fixture in $r; caught = the mutated gate no longer refuses with PATTERN
  local id=$1 r=$MUT/r-$1 o rc
  rm -rf "$r"; mkdir -p "$r"; sed "$2" "$V" > "$MUT/$id.var"
  cmp -s "$V" "$MUT/$id.var" && { bad "mutation $id did not change the text"; return; }
  mkgate "$MUT/$id.sh" "$MUT/$id.var"; eval "$3"
  o=$(FAKE_NOW=$4 FAKE_NOW2=$5 bash "$MUT/$id.sh" "$r" "$6" "$7" 2>&1); rc=$?; mtotal=$((mtotal+1))
  if [ $rc != 0 ] && ! echo "$o" | grep -q REACHED && echo "$o" | grep -Eq "$8"; then bad "mutation $id SURVIVED (the control still refuses as specified)" "$2"; else mcaught=$((mcaught+1)); ok "mutation $id caught"; fi; }
F1='mkfix "$r" x 2026-10-28T11:30:00Z'
mg age   's/-le "\$S0A_MAX_AGE_S"/-le 99999999/'              'mkfix "$r" x 2026-10-28T09:59:00Z' $NOW $NOW 2026-10-28T09:00:00Z 2026-10-28T11:50:00Z 'minutes old at the start check'
mg window 's/-ge "\$ws_s" \]/-ge 0 ]/'                          'mkfix "$r" x 2026-10-28T10:30:00Z' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'before the window start'
mg nofall 's/ls -dt "\$ROOT"\/window/ls -dtr "$ROOT"\/window/' 'mkfix "$r" old 2026-10-28T11:00:00Z ok; mkfix "$r" new 2026-10-28T11:40:00Z none' $NOW $NOW 2026-10-28T10:00:00Z 2026-10-28T11:50:00Z 'older pass is NOT used'
mg novrd  's/\] && \[ ! -L "\$d\/verdict.txt" \] || die/] || true || die/;s/\[ -f "\$d\/verdict.txt" \]/true/' 'mkfix "$r" x 2026-10-28T11:30:00Z none' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'has no verdict'
mg sidec  's/\[ "\$nsc" = 4 \]/[ "$nsc" -ge 0 ]/'              'mkfix "$r" x 2026-10-28T11:30:00Z ok 3' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'expected exactly 4'
mg oldest 's/\[ "\$st" \\< "\$oldest" \]/[ "$st" \\> "$oldest" ]/' 'mkfix "$r" x 2026-10-28T11:30:00Z; sed -i "s/2026-10-28T11:30:00Z/2026-10-28T09:30:00Z/g" "$r/window.x/results/g02-history-0248.meta.json"' $NOW $NOW 2026-10-28T09:00:00Z 2026-10-28T11:50:00Z 'minutes old at the start check'
mg recheck 's/^s0a_gate confirm$/:/'                            'mkfix "$r" x 2026-10-28T10:10:00Z' $NOW 2026-10-28T12:20:00Z 2026-10-28T10:00:00Z 2026-10-28T11:50:00Z 'minutes old at the confirm check'
mg row4   's/\[ "\$R4SEL" \\> "\$S0A_AT" \] ||/true ||/'          'mkfix "$r" x 2026-10-28T11:30:00Z' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:00:00Z 'BEFORE the S0a record'
mg start  's/^if \[ -e "\$STATEF" \] || \[ -L "\$STATEF" \]; then$/if false; then/' 'mkfix "$r" x 2026-10-28T11:30:00Z; mkdir -p "$r/s1-apply"; echo "IN-FLIGHT 2026-10-28T11:00:00Z" > "$r/s1-apply/APPLY-STATE"' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'UNKNOWN or not yet verified'
mg excl   's/( set -C; printf/( printf/'                         'mkfix "$r" x 2026-10-28T11:30:00Z; export PRECREATE=1' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'cannot create the IN-FLIGHT marker'
unset PRECREATE
mg symlink 's/ || \[ -L "\$STATEF" \]//'                         'mkfix "$r" x 2026-10-28T11:30:00Z; mkdir -p "$r/s1-apply"; ln -s /nonexistent "$r/s1-apply/APPLY-STATE"' $NOW $NOW 2026-10-28T11:00:00Z 2026-10-28T11:50:00Z 'UNKNOWN or not yet verified'
mr() { # mr ID SEDEXPR SETUP NOW PATTERN : reconcile mutation
  local id=$1 r=$MUT/rr-$1 o rc; rm -rf "$r"; mkdir -p "$r"; sed "$2" "$R" > "$MUT/$id.rvar"; cmp -s "$R" "$MUT/$id.rvar" && { bad "mutation $id did not change the text"; return; }
  { echo 'set -u; umask 077'; grep -E '^(NONE_WAIT_S|SEALED_SHA|SQL_S1H|SQL_G02)=' "$MUT/$id.rvar"; echo 'pgrep() { return ${PGREP_RC:-1}; }'; echo 'iso="[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"; die() { echo "STOP: $*" >&2; exit 1; }; shasum() { shift 2; sha256sum "$@"; }'
    grep -E '^(sha|epoch)\(\)' "$R"; echo 'utcnow() { echo "$FAKE_NOW"; }; ROOT=$1; STATEF="$ROOT/s1-apply/APPLY-STATE"'; blk "$MUT/$id.rvar" RECONCILE; echo 'reconcile; echo "CLASS=$RECONCILE_CLASS"'; } > "$MUT/$id.rsh"
  G2=$G; G=$MUT; eval "$3"; G=$G2
  o=$(FAKE_NOW=$4 bash "$MUT/$id.rsh" "$r" 2>&1); rc=$?; mtotal=$((mtotal+1))
  if [ $rc != 0 ] && echo "$o" | grep -Eq "$5" && [ -e "$r/s1-apply/APPLY-STATE" ]; then bad "mutation $id SURVIVED (reconcile still refuses and keeps the marker)" "$2"; else mcaught=$((mcaught+1)); ok "mutation $id caught"; fi; }
mr nonewait 's/^NONE_WAIT_S=1200$/NONE_WAIT_S=0/'              'mkmark "rr-$id"; mks0 "rr-$id" 2026-10-28T11:10:00Z' $NOW 'at least 1200 s after the marker'
mr older    's/"\$at_s" -gt "\$mt_s"/"$at_s" -gt 0/'              'mkmark "rr-$id"; mks1 "rr-$id" 2026-10-28T10:50:00Z' $NOW 'no usable read-back evidence newer than the marker'
mr hist     's/"hosted_max":"0248"/"hosted_max"/'                'mkmark "rr-$id"; mks1 "rr-$id" 2026-10-28T11:40:00Z 246 0246' $NOW 'no usable read-back evidence'
mr nopin    's/ \&\& meta_ok "\$d\/results\/s1-history-0248.meta.json" "\$f" s1-history-0248.sql "\$SQL_S1H"//' 'mkmark "rr-$id"; SQLBAD=1 mks1 "rr-$id" 2026-10-28T11:40:00Z' $NOW 'no usable read-back evidence'
mr norsha   's/grep -Fq -e "\\"result_sha256\\":\\"\$rs\\","/true/' 'mkmark "rr-$id"; TAMPER=1 mks1 "rr-$id" 2026-10-28T11:40:00Z' $NOW 'no usable read-back evidence'
mr noword   's/= IN-FLIGHT \] || die/= IN-FLIGHT -o 1 = 1 ] || die/' 'mkmark "rr-$id"; echo "APPLIED-UNVERIFIED 2026-10-28T11:00:00Z head=x run=y" > "$G/rr-$id/s1-apply/APPLY-STATE"; mks0 "rr-$id" 2026-10-28T11:25:00Z' $NOW 'marker word is not IN-FLIGHT'
mr noproc   's/\[ "\$pr" = 1 \] || die/true || die/' 'mkmark "rr-$id"; mks0 "rr-$id" 2026-10-28T11:25:00Z; export PGREP_RC=0' $NOW 'process is running'
unset PGREP_RC
echo "MUTATIONS: $mcaught of $mtotal caught"
[ "$mcaught" = "$mtotal" ] && ok "every new refusal's negative control caught its mutation (N of N: $mcaught of $mtotal)" || bad "$((mtotal - mcaught)) mutation(s) survived"

echo "RESULT: $pass passed, $fail failed"
EXPECT=67; [ $((pass + fail)) = $EXPECT ] || { echo "FAIL - $((pass + fail)) of $EXPECT cases ran"; exit 1; }
[ "$fail" = 0 ]
