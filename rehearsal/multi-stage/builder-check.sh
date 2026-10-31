#!/bin/bash
# REHEARSAL - NEVER MERGE. Checks of the BUILDER itself: it must REFUSE what it must refuse, and be deterministic. usage: builder-check.sh SPEC
set -u
D="$(cd "$(dirname "$0")" && pwd)"; SPEC=${1:?SPEC}; T=${RUNNER_TEMP:-/tmp}/msbuild; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sd=$(dirname "$SPEC")
python3 "$D/build.py" "$SPEC" "$T/a" > "$T/a.log" 2>&1 && python3 "$D/build.py" "$SPEC" "$T/b" > "$T/b.log" 2>&1 \
  && [ "$(cd "$T/a" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)" = "$(cd "$T/b" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)" ] \
  && ok "DETERMINISTIC: two builds of the same list are byte-identical (every file, every pin)" || bad "builds differ" "$(cat $T/a.log $T/b.log)"
refuse() { # refuse NAME 'regex' SPECFILE
  python3 "$D/build.py" "$3" "$T/r" > "$T/r.log" 2>&1; rc=$?
  [ $rc != 0 ] && grep -Eq "BUILD REFUSED: .*($2)" "$T/r.log" && [ ! -f "$T/r/PLAN.json" ] && ok "$1" || bad "$1" "rc=$rc $(cat $T/r.log | head -3)"
}
# specs are written next to the real one so relative paths stay valid
w() { python3 -I - "$SPEC" "$sd/.t-$1.json" "$2" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1])); code = sys.argv[3]
exec(code)
json.dump(spec, open(sys.argv[2], "w"))
PY
}
w dup 'spec["steps"].append({"file": spec["steps"][0]["file"]})'; refuse "DUPLICATE: the same migration listed twice is refused" "already in the hosted set or an earlier step" "$sd/.t-dup.json"
w hosted 'spec["steps"].append({"file": "sealed/0258_hon58_identity.sql"})'; refuse "DUPLICATE (later step repeats an earlier one) is refused" "already in the hosted set or an earlier step" "$sd/.t-hosted.json"
w rows 'spec["hosted"]["expect_rows"] = 246'; refuse "HOSTED DIRECTORY that is not the hosted set (wrong file count) is refused" "hosted directory holds" "$sd/.t-rows.json"
w max 'spec["hosted"]["expect_max"] = "0256"'; refuse "HOSTED DIRECTORY with the wrong max is refused" "hosted directory max" "$sd/.t-max.json"
w pack 'spec["steps"] = spec["steps"][1:] + spec["steps"][:1]'; refuse "STALE GATE PACK: 0254's pack was reviewed at hosted max 0257; placed after the other steps it is refused" "(gate pack was reviewed for a hosted max|ADOPTED package is valid only as step 1)" "$sd/.t-pack.json"
w name 'spec["steps"][1]["file"] = "sealed/0258 bad name.sql"'; refuse "a file that is not NNNN_name.sql is refused" "is not NNNN_name.sql" "$sd/.t-name.json"
w sha 'spec["steps"][1]["sha256"] = "0" * 64'; refuse "WRONG SEALED SHA: a step file that is not the sealed one (sha256 in the spec) is refused" "is not the sealed one" "$sd/.t-sha.json"
# template drift: a template that is not the reviewed file
cp -r "$D/templates" "$T/tpl-backup"; echo "# drift" >> "$D/templates/s1-apply-0254a-online.sh"
python3 "$D/build.py" "$SPEC" "$T/r" > "$T/r.log" 2>&1; rc=$?; cp "$T/tpl-backup/s1-apply-0254a-online.sh" "$D/templates/s1-apply-0254a-online.sh"
[ $rc != 0 ] && grep -q "is not the reviewed file" "$T/r.log" && ok "TEMPLATE DRIFT: a template that is not the reviewed file (sha256) refuses the build" || bad "template drift not refused" "$(head -3 $T/r.log)"
# sequences: 0254 is in every sequence, 0266 never without 0258, every sequence chains
python3 -I - "$T/a" <<'PY' && ok "SEQUENCES (12): 0266 never appears without 0258; every sequence chains (each step starts where the previous ended); a step can be dropped without a rebuild" || bad "sequence properties"
import json, sys
d = sys.argv[1]
p = json.load(open(d + "/PLAN.json"))
assert len(p["sequences"]) == 12, len(p["sequences"])
for name, q in p["sequences"].items():
    st = [p["stages"][s] for s in q["stages"]]
    vs = [x["migration"][:4] for x in st]
    assert ("0266" not in vs) or ("0258" in vs and vs.index("0258") < vs.index("0266")), name
    for a, b in zip(st, st[1:]):
        assert a["history_after"]["list_md5"] == b["history_before"]["list_md5"], (name, a["stage"])
    for x in st: assert x["include_all"] == (x["history_before"]["max"] > x["migration"][:4])
for n in ("full", "drop-0266", "drop-0254", "drop-0271", "drop-0254+0271", "drop-0266+0271", "drop-0258+0272+0266"): assert n in p["sequences"], n
for n in ("drop-0258", "drop-0272", "drop-0258+0272", "drop-0272+0266"): assert n in p["skipped_sequences"], n
# 0254 and 0271 are independent: every sequence is valid with or without them, and neither appears in a rule
r = p["rules"]
assert "0254" not in str(r["closure"]) + str(r["adjacent"]) + str(r["requires_earlier"]) and "0271" not in str(r["closure"]) + str(r["adjacent"]) + str(r["requires_earlier"])
PY
# no content gates: the plan says so loudly
python3 -I - "$T/a" <<'PY' && ok "CONTENT GATES: 0254 has them; steps without a gate pack are flagged in PLAN.json, README, SEQUENCE.md and the installer as NOT production-ready" || bad "content gate flags"
import json, sys
d = sys.argv[1]
p = json.load(open(d + "/PLAN.json"))
for S, s in p["stages"].items():
    if s["migration"].startswith("0254_"):
        assert s["content_gates"] is True
    else:
        assert s["content_gates"] is False
        assert "CONTENT GATES MISSING" in open("%s/%s/README.txt" % (d, S)).read()
        assert "NOT production-ready" in open("%s/%s/install-%s-online.sh" % (d, S, S)).read()
assert "CONTENT GATES MISSING" in open(d + "/SEQUENCE.md").read()
PY
# the allowlist embedded in each apply script is exactly the bundle's list
c=0; for f in "$T"/a/*/; do S=$(basename "$f"); [ -f "$f/s1-apply-$S-online/s1-apply-$S-online.sh" ] || continue
  # the adopted reviewed package has no embedded ALLOW block: its LIST_SHA pin is the allowlist (checked to equal the bundle list's sha256)
  if ! grep -q "^ALLOW='" "$f/s1-apply-$S-online/s1-apply-$S-online.sh"; then
    [ "$(sed -n 's/^LIST_SHA=\([0-9a-f]*\).*/\1/p' "$f/s1-apply-$S-online/s1-apply-$S-online.sh")" = "$(shasum -a 256 "$f/s1-apply-$S-online/MIGRATIONS-stage$S.sha256" | cut -d' ' -f1)" ] || { c=1; bad "$S: (adopted) LIST_SHA is not the bundle list's sha256"; }; continue; fi
  sed -n "/^ALLOW='/,/'\$/p" "$f/s1-apply-$S-online/s1-apply-$S-online.sh" | sed "1s/^ALLOW='//;\$s/'\$//" | LC_ALL=C sort > "$T/allow.txt"
  LC_ALL=C sort "$f/s1-apply-$S-online/MIGRATIONS-stage$S.sha256" | cmp -s - "$T/allow.txt" || { c=1; bad "$S: the embedded allowlist is not the bundle list"; }; done
[ $c = 0 ] && ok "every apply script embeds EXACTLY its bundle's reviewed allowlist (file name + sha256 of every migration)"
c=0; for f in $(find "$T/a" -name '*.sh'); do bash -n "$f" || { c=1; bad "syntax: $f"; }; done; [ $c = 0 ] && ok "every generated shell script parses (bash -n)"
rm -f "$sd"/.t-*.json
echo "# RESULT: $pass passed, $fail failed"; [ $fail = 0 ]
