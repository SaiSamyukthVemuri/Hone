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
echo "RESULT: $pass passed, $fail failed"
EXPECT=9; [ $((pass + fail)) = $EXPECT ] || { echo "FAIL - $((pass + fail)) of $EXPECT cases ran"; exit 1; }
[ "$fail" = 0 ]
