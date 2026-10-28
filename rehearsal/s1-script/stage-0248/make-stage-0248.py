#!/usr/bin/env python3 -I
"""REHEARSAL - NEVER MERGE. Builds the 0248-ONLY stage inputs from the pinned #1035 S1 material, with CONSTANT edits to s1-apply.sh PLUS three REVIEWED GATES (STAGE-0248-MAC-GATES), each inside #NAME-BEGIN/#NAME-END markers so the CI harness runs the real text.
usage: make-stage-0248.py OUTDIR. Every replacement must match exactly once (or the stated number of times) or the build stops, so the diff
against the pinned base (2dfd3354) is exactly this table. Stage: hosted 0001..0246 (245 rows) + sealed 0248 -> 246 rows, max 0248, 0247 absent."""
import hashlib, io, os, sys, tarfile
HERE = os.path.dirname(os.path.abspath(__file__)); S1 = os.path.dirname(HERE); HR = os.path.join(S1, "..", "hone-release")
SEALED = os.path.join(HR, "templates", "stage-0248", "sealed", "0248_intake_protected_write_enforcement.sql")
SEALED_SHA = "1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3"
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
sha = lambda b: hashlib.sha256(b).hexdigest()
body = open(SEALED, "rb").read(); assert sha(body) == SEALED_SHA, "the sealed 0248 file is not the reviewed one"
# 1. bundle: the pinned 0001..0246 files + sealed 0248, deterministic (sorted, fixed mtime, root owner)
base = tarfile.open(os.path.join(S1, "migrations-d189768b.tar")); files = {}
for m in base.getmembers():
    if m.isfile(): files[m.name] = base.extractfile(m).read()
assert len(files) == 245 and not any(("/0247_" in n or "/0248_" in n or "/0249_" in n or "/0250_" in n) for n in files), "base is not 0001..0246"
files["supabase/migrations/0248_intake_protected_write_enforcement.sql"] = body
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
    for d in ("supabase", "supabase/migrations"):
        ti = tarfile.TarInfo(d + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; ti.mtime = 0; t.addfile(ti)
    for n in sorted(files):
        ti = tarfile.TarInfo(n); ti.size = len(files[n]); ti.mode = 0o644; ti.mtime = 0; t.addfile(ti, io.BytesIO(files[n]))
bundle = buf.getvalue(); open(os.path.join(out, "migrations-stage0248.tar"), "wb").write(bundle)
lst = "".join("%s  %s\n" % (sha(files[n]), os.path.basename(n)) for n in sorted(files)).encode()
open(os.path.join(out, "MIGRATIONS-stage0248.sha256"), "wb").write(lst)
# 2. s1-apply-0248.sh: the constant-only transform
src = open(os.path.join(S1, "s1-apply.sh")).read(); assert sha(src.encode())[:8] == "2dfd3354", "the base s1-apply.sh is not the reviewed 2dfd3354"
go34_start = src.index("#GO34-BEGIN\n"); go34_end = src.index("#GO34-END\n") + len("#GO34-END\n")
src = src[:go34_start] + "#GOPEND-BEGIN\nGOPEND='%s  0248_intake_protected_write_enforcement.sql'\n#GOPEND-END\n" % SEALED_SHA + src[go34_end:]
src = src.replace("# The 34 pending files and their sha256, from the GO package (FINAL-GO-PACKAGE-1035 section B; 0214 = a8bdcefe).", "# The ONE pending file and its sha256 (sealed 0248; templates/stage-0248/review.md). 0247, 0249 and 0250 are NOT in this stage.")
def rep(old, new, n=1):
    global src
    assert src.count(old) == n, (src.count(old), old[:70]); src = src.replace(old, new)
rep("# Hone #1035 S1 (row 4): apply migrations 0213..0246 (34 files) to the hosted project", "# Hone STAGE 0248-ONLY (variant of the #1035 S1 apply 2dfd3354; reviewed constants plus three reviewed gates: S0a age, single-flight marker, reconcile): apply migration 0248 (1 file) to the hosted project")
rep("and ONLY the migration bundle committed at d189768b. ONE dry run, then ONE push.", "and ONLY the stage bundle (0001..0246 + sealed 0248, no 0247). ONE dry run, then ONE push.")
rep('# Exit 0 ONLY after the push log shows exactly 34 "Applying migration" lines in order,', '# Exit 0 ONLY after the push log shows exactly 1 "Applying migration" line (0248),')
rep("# and the CLI exited 0. That does NOT replace the read-back (history = 245 rows, max 0246) and the post-S1 checks.", "# and the CLI exited 0. That does NOT replace the read-back (history = 246 rows, max 0248, 0247 absent) and the stage checks.")
rep("BUNDLE=migrations-d189768b.tar", "BUNDLE=migrations-stage0248.tar")
rep("BUNDLE_SHA=599adf08712f6c702f5921ee54f7a83c653ee9faba60604d501aba7af841527b", "BUNDLE_SHA=%s" % sha(bundle))
rep("LIST=MIGRATIONS-d189768b.sha256", "LIST=MIGRATIONS-stage0248.sha256")
rep("LIST_SHA=513035041c76717b5f8df1e2133cf2951c1b03c58d0cde5ce1e5dcdf5492c069", "LIST_SHA=%s" % sha(lst))
rep("HEAD_SHA=d189768b86fe1c53e330c65078f3a9f2949f8e59", "HEAD_SHA=REHEARSAL-NOT-A-COMMIT  # OPEN: the real stage names the carrying commit (production chain + sealed 0248 only), which does not exist yet")
rep("H0214=a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b\n", "")
rep("NFILES=245\nMAXV=246\n", "NFILES=246\nMAXV=248\n")
rep("GO34", "GOPEND", n=src.count("GO34") - 0 if False else src.count("GO34"))
rep("awk '{v=substr($2,1,4)+0; if (v>=213 && v<=246) print}'", "awk '{v=substr($2,1,4)+0; if (v>=248 && v<=248) print}'")
rep("the 34 pending files in $LIST differ from the GO package list", "the pending file in $LIST differs from the sealed 0248")
rep("""[ "$(printf '%s\\n' "$GOPEND" | grep -c '')" = 34 ] || die "internal: the embedded GO list is not 34 lines"
printf '%s\\n' "$GOPEND" | grep -q "^$H0214  0214_" || die "0214 is not $H0214"
""", """[ "$(printf '%s\\n' "$GOPEND" | grep -c '')" = 1 ] || die "internal: the embedded pending list is not 1 line"
# STAGE 0248-ONLY: 0247 (and 0249/0250) must be ABSENT from the list and the tar. Left in the directory, the same push would apply 0247 with 0248 (CI run 40710819431).
grep -Eq '^[0-9a-f]{64}  (0247|0249|0250)_' "$SELF/$LIST" && die "$LIST names 0247, 0249 or 0250: they are not part of the 0248-only stage"
tar -tf "$SELF/$BUNDLE" 2>/dev/null | grep -Eq 'supabase/migrations/(0247|0249|0250)_' && die "$BUNDLE holds 0247, 0249 or 0250: they are not part of the 0248-only stage"
grep -Eq '^[0-9a-f]{64}  0248_' "$SELF/$LIST" || die "$LIST does not name 0248"
""")
rep("# the 34 pending files equal the GO package list, byte for byte (names and hashes)", "# the pending file equals the sealed 0248, byte for byte (name and hash)")
rep("pending 34 (0213..0246)", "pending 1 (0248; 0247 absent)")
rep("the 34 pending files equal the GO package list. Working directory", "the pending file equals the sealed 0248, 0247 absent. Working directory")
rep('[ "$ngot" = 34 ] || die "the dry run lists $ngot migrations, expected exactly 34.', '[ "$ngot" = 1 ] || die "the dry run lists $ngot migrations, expected exactly 1.')
rep("the dry run lists 34 migrations but not the expected 0213..0246 in order.", "the dry run lists 1 migration but not the expected 0248.")
rep("Dry run OK: exactly 34 migrations, 0213 .. 0246, in order.", "Dry run OK: exactly 1 migration, 0248.")
rep("dry run listed exactly the 34 expected versions in order", "dry run listed exactly the 1 expected version")
rep("The log must show 34 \"Applying migration\" lines in order, then the", "The log must show 1 \"Applying migration\" line, then the")
rep("push of those 34 migrations now", "push of that 1 migration (0248) now")
rep("Applying-migration lines seen: $napp of 34.", "Applying-migration lines seen: $napp of 1.")
rep('[ "$napp" = 34 ] || fail_report "the push logged $napp \'Applying migration\' lines, expected 34."', '[ "$napp" = 1 ] || fail_report "the push logged $napp \'Applying migration\' lines, expected 1."')
rep("the 34 applied migrations are not exactly 0213..0246 in order.", "the applied migration is not exactly 0248.")
rep("S1 APPLIED $(utcnow): 34 migrations 0213..0246 in order, finish line present, exit 0", "STAGE 0248 APPLIED $(utcnow): 1 migration (0248), finish line present, exit 0")
rep("S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order; 'Finished supabase db push.'; exit 0.", "STAGE 0248 APPLIED: exactly 1 migration (0248); 'Finished supabase db push.'; exit 0.")
rep("migration history must be 245 rows with max 0246, and the post-S1 checks.", "migration history must be 246 rows with max 0248 (0247 absent), and the 0248 verify checks.")

# 3. STAGE-0248-MAC-GATES: three gates inserted at single-match anchors (the diff against the 34e40830 variant is the Insurance delta).
rep("HEAD_SHA=REHEARSAL-NOT-A-COMMIT  # OPEN: the real stage names the carrying commit (production chain + sealed 0248 only), which does not exist yet", "HEAD_SHA=91a28fb006fdd00baff80381a52c29d0e672a633  # the apply head: #1224 (production chain + sealed 0248 only), pinned by the S0a variant too")
rep("NFILES=246\nMAXV=248\n", "NFILES=246\nMAXV=248\nS0A_MAX_AGE_S=7200  # OPS value: S0a must be no older than 120 minutes at the push confirm (the S0-8 floor is 110)\nSEALED_SHA=1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3\nSTATEF=\"$ROOT/s1-apply/APPLY-STATE\"\n")
GATE_SF = """#SINGLEFLIGHT-BEGIN
# GATE 2 (single flight): ANY marker refuses a start. This script never clears it and no trap does: an UNKNOWN push can never be rerun.
# Only s1-reconcile-0248.sh clears it, with read-back evidence newer than the marker, and it archives the marker rather than deleting it.
if [ -e "$STATEF" ] || [ -L "$STATEF" ]; then
  die "a previous run left $STATEF ($(head -c 160 "$STATEF" 2>/dev/null | tr -d '\\n')): the outcome of that push is UNKNOWN or not yet verified, so this script will not start. Read back the migration history (window-s1read-0248.sh), then clear the marker ONLY with s1-reconcile-0248.sh. Nothing was attempted."
fi
#SINGLEFLIGHT-END
"""
rep('case "$URL" in postgresql://*) ;; *) die "internal: the URL is not a postgresql:// URL" ;; esac\n', GATE_SF + 'case "$URL" in postgresql://*) ;; *) die "internal: the URL is not a postgresql:// URL" ;; esac\n')
GATE_S0A = """#S0AGATE-BEGIN
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
  nsc=$(ls "$d/results" 2>/dev/null | grep -c '\\.meta\\.json$')
  [ "$nsc" = 4 ] || die "the newest S0a run ($d) holds $nsc capture sidecars, expected exactly 4. Nothing was attempted."
  oldest=""
  for m in "$d"/results/*.meta.json; do
    [ -f "$m" ] && [ ! -L "$m" ] && [ "$(grep -c '' "$m")" = 1 ] || die "an S0a sidecar is not a single plain line ($m). Nothing was attempted."
    line=$(cat "$m")
    st=$(printf '%s' "$line" | sed -n 's/.*"started_at_utc":"\\([^"]*\\)".*/\\1/p')
    printf '%s' "$st" | LC_ALL=C grep -Eq "^$iso\\$" || die "an S0a sidecar has no readable started_at_utc ($m). Nothing was attempted."
    if [ -z "$oldest" ] || [ "$st" \\< "$oldest" ]; then oldest=$st; fi
  done
  nowt=$(utcnow); nows=$(epoch "$nowt"); as_s=$(epoch "$oldest")
  case "$nows$as_s" in *[!0-9]*|'') die "cannot read the S0a times" ;; esac
  [ "$as_s" -le "$nows" ] || die "s0a_at ($oldest) is in the future. Nothing was attempted."
  [ "$as_s" -ge "$ws_s" ] || die "s0a_at ($oldest) is before the window start $WSTART: the S0a record predates this window. Run window-s0a-0248.sh inside the window. Nothing was attempted."
  [ $((nows - as_s)) -le "$S0A_MAX_AGE_S" ] || die "the S0a record is $(( (nows - as_s) / 60 )) minutes old at the $when check (limit $((S0A_MAX_AGE_S / 60))): run window-s0a-0248.sh again. NOTHING was applied."
  S0A_DIR=$d; S0A_AT=$oldest; S0A_VSHA=$(sha "$d/verdict.txt")
}
#S0AGATE-END
"""
rep('STAGE=restore-point\nask() {', GATE_S0A + 'STAGE=restore-point\nask() {')
rep('echo "Restore point accepted: $RPOINT ($(( (now_s - rp_s) / 60 )) minutes old)." >&2\n', 'echo "Restore point accepted: $RPOINT ($(( (now_s - rp_s) / 60 )) minutes old)." >&2\n#S0ASTART-BEGIN\ns0a_gate start\n[ "$R4SEL" \\> "$S0A_AT" ] || [ "$R4SEL" = "$S0A_AT" ] || die "row 4 selected the restore point ($R4SEL) BEFORE the S0a record ($S0A_AT): row 4 runs after S0a. Nothing was attempted."\nS0A_VSHA_START=$S0A_VSHA\necho "S0a record bound: $S0A_DIR (s0a_at $S0A_AT, verdict sha256 $S0A_VSHA, limit $((S0A_MAX_AGE_S / 60)) minutes at the push confirm)" >> "$RUN"\necho "S0a record accepted: s0a_at $S0A_AT." >&2\n#S0ASTART-END\n')
GATE_W = """#SFWRITE-BEGIN
s0a_gate confirm
[ "$S0A_VSHA" = "$S0A_VSHA_START" ] || die "the S0a verdict changed since the start of this run. NOTHING was applied."
mkdir -p "$ROOT/s1-apply" 2>/dev/null
( set -C; printf 'IN-FLIGHT %s head=%s run=%s\\n' "$(utcnow)" "$HEAD_SHA" "$WORK" > "$STATEF" ) 2>/dev/null || die "cannot create the IN-FLIGHT marker $STATEF (it already exists, or the directory is not writable). NOTHING was applied."
sync 2>/dev/null || true
echo "IN-FLIGHT marker written $(utcnow); s0a_at $S0A_AT bound at the confirm" >> "$RUN"
#SFWRITE-END
"""
rep('STAGE=push\necho "push started $(utcnow)" >> "$RUN"', GATE_W + 'STAGE=push\necho "push started $(utcnow)" >> "$RUN"')
GATE_DONE = """#SFDONE-BEGIN
# the push passed every check: the marker moves to APPLIED-UNVERIFIED (still refuses a start). If this write fails it stays IN-FLIGHT, which is also safe.
{ printf 'APPLIED-UNVERIFIED %s head=%s run=%s\\n' "$(utcnow)" "$HEAD_SHA" "$WORK" > "$STATEF.tmp" && mv -f "$STATEF.tmp" "$STATEF"; } 2>/dev/null || echo "WARNING: could not move $STATEF to APPLIED-UNVERIFIED; it stays IN-FLIGHT, which also refuses a rerun." >&2
#SFDONE-END
"""
rep('{ echo "STAGE 0248 APPLIED $(utcnow)', GATE_DONE + '{ echo "STAGE 0248 APPLIED $(utcnow)')
open(os.path.join(out, "s1-apply-0248.sh"), "w").write(src)
print("bundle_sha=%s list_sha=%s script_sha=%s files=%d" % (sha(bundle), sha(lst), sha(src.encode()), len(files)))
