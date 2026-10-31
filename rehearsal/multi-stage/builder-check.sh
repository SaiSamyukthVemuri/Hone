#!/bin/bash
# REHEARSAL - NEVER MERGE. Checks of the BUILDER itself: it must REFUSE what it must refuse, and be deterministic. usage: builder-check.sh SPEC
set -u
D="$(cd "$(dirname "$0")" && pwd)"; SPEC=${1:?SPEC}; T=${RUNNER_TEMP:-/tmp}/msbuild; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
sd=$(dirname "$SPEC")
python3 "$D/build.py" "$SPEC" "$T/a" > "$T/a.log" 2>&1 && python3 "$D/build.py" "$SPEC" "$T/b" > "$T/b.log" 2>&1 \
  && [ "$(cd "$T/a" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)" = "$(cd "$T/b" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)" ] \
  && ok "DETERMINISTIC: two builds of the same list are byte-identical (every file, every pin)" || bad "builds differ" "$(cat $T/a.log $T/b.log)"
if [ -z "${GENERIC_ONLY:-}" ]; then  # the P1-specific refusals and sequence properties (a spec with another step list runs the generic checks only)
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
w dup 'spec["steps"].append(dict(spec["steps"][0]))'; refuse "DUPLICATE: the same migration listed twice is refused" "already in the hosted set or an earlier step" "$sd/.t-dup.json"
w hosted 'spec["steps"].append({"file": "sealed/0258_hon58_identity.sql", "sha256": "12c8109d41059e78fbc7df2af3a5a15b5bfcd3c17e0a5453e385cff0cc1cfd78"})'; refuse "DUPLICATE (later step repeats an earlier one) is refused" "already in the hosted set or an earlier step" "$sd/.t-hosted.json"
w rows 'spec["hosted"]["expect_rows"] = 246'; refuse "HOSTED DIRECTORY that is not the hosted set (wrong file count) is refused" "hosted directory holds" "$sd/.t-rows.json"
w nosha 'del spec["steps"][1]["sha256"]'; refuse "R5: a step with no sha256 in the spec is refused (mandatory for every step)" "carries no sha256" "$sd/.t-nosha.json"
w nodir 'del spec["hosted"]["dir_sha256"]'; refuse "R5: a hosted block with no dir_sha256 is refused" "no dir_sha256" "$sd/.t-nodir.json"
w baddir 'spec["hosted"]["dir_sha256"] = "0" * 64'; refuse "R5: a hosted set whose file hashes differ from the pin is refused (a count and a max are not enough)" "not the pinned one" "$sd/.t-baddir.json"
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
python3 -I - "$T/a" <<'PY' && ok "CONTENT GATES: 0254, 0253, 0258, 0266 and 0271 have them; steps without a gate pack are flagged in PLAN.json, README, SEQUENCE.md and the installer as NOT production-ready" || bad "content gate flags"
import json, sys
d = sys.argv[1]
p = json.load(open(d + "/PLAN.json"))
for S, s in p["stages"].items():
    if s["migration"][:4] in ("0254", "0253", "0258", "0266", "0271"):
        assert s["content_gates"] is True
    else:
        assert s["content_gates"] is False
        assert "CONTENT GATES MISSING" in open("%s/%s/README.txt" % (d, S)).read()
        assert "NOT production-ready" in open("%s/%s/install-%s-online.sh" % (d, S, S)).read()
assert "CONTENT GATES MISSING" in open(d + "/SEQUENCE.md").read()
PY
fi
# the allowlist embedded in each apply script is exactly the bundle's list
c=0; for f in "$T"/a/*/; do S=$(basename "$f"); [ -f "$f/s1-apply-$S-online/s1-apply-$S-online.sh" ] || continue
  # the adopted reviewed package has no embedded ALLOW block: its LIST_SHA pin is the allowlist (checked to equal the bundle list's sha256)
  if ! grep -q "^ALLOW='" "$f/s1-apply-$S-online/s1-apply-$S-online.sh"; then
    [ "$(sed -n 's/^LIST_SHA=\([0-9a-f]*\).*/\1/p' "$f/s1-apply-$S-online/s1-apply-$S-online.sh")" = "$(shasum -a 256 "$f/s1-apply-$S-online/MIGRATIONS-stage$S.sha256" | cut -d' ' -f1)" ] || { c=1; bad "$S: (adopted) LIST_SHA is not the bundle list's sha256"; }; continue; fi
  sed -n "/^ALLOW='/,/'\$/p" "$f/s1-apply-$S-online/s1-apply-$S-online.sh" | sed "1s/^ALLOW='//;\$s/'\$//" | LC_ALL=C sort > "$T/allow.txt"
  LC_ALL=C sort "$f/s1-apply-$S-online/MIGRATIONS-stage$S.sha256" | cmp -s - "$T/allow.txt" || { c=1; bad "$S: the embedded allowlist is not the bundle list"; }; done
[ $c = 0 ] && ok "every apply script embeds EXACTLY its bundle's reviewed allowlist (file name + sha256 of every migration)"
c=0; for f in $(find "$T/a" -name '*.sh'); do bash -n "$f" || { c=1; bad "syntax: $f"; }; done; [ $c = 0 ] && ok "every generated shell script parses (bash -n)"
# GATE PACKS: reproducible from mkpacks.py; the expected policy sets match the repository history and the sealed body; every expected object name is in the sealed body; every generated node check parses
mkdir -p "$T/gp"; MKPACKS_OUT="$T/gp" python3 "$D/gate-packs/mkpacks.py" && diff -r -q "$T/gp" "$D/gate-packs" 2>&1 | grep -v "Only in $D/gate-packs: \(0254\|mkpacks.py\|__pycache__\)" | grep -q . \
  && bad "gate packs are not exactly what mkpacks.py writes" "$(diff -r -q "$T/gp" "$D/gate-packs" | head -3)" || ok "the committed gate packs are exactly what mkpacks.py writes (reproducible, reviewable)"
python3 -I - "$D" "$SPEC" <<'PY' && ok "gate pack facts: the expected 0253 policy set BEFORE equals the repository history and AFTER equals the sealed body applied on it; every expected object name appears in its sealed body" || bad "gate pack facts"
import glob, json, os, re, sys
d, spec = sys.argv[1:3]
sys.path.insert(0, d + "/gate-packs")
import mkpacks
mkpacks.OUT = "/tmp/mkpacks-scratch"
mkpacks.main()
sp = json.load(open(spec)); sd = os.path.dirname(os.path.abspath(spec))
hosted = os.path.normpath(os.path.join(sd, sp["hosted"]["dir"]))
pat = re.compile(r'(create\s+policy\s+"?(\w+)"?\s+on\s+(?:public\.)?(\w+)(.*?);)|(drop\s+policy\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+(?:public\.)?(\w+))', re.S | re.I)
def policies(files, tabs):
    pol = {t: {} for t in tabs}
    for f in files:
        t = re.sub(r"--[^\n]*", "", open(f).read())
        for m in pat.finditer(t):
            if m.group(1):
                n, tb, body = m.group(2), m.group(3), m.group(4)
                if tb in pol:
                    c = re.search(r"\bfor\s+(all|select|insert|update|delete)\b", body, re.I)
                    pol[tb][n] = (c.group(1).upper() if c else "ALL")
            else:
                if m.group(7) in pol: pol[m.group(7)].pop(m.group(6), None)
    return {t: sorted(v.items()) for t, v in pol.items()}
tabs = list(mkpacks.before)
files = sorted(glob.glob(hosted + "/*.sql"))
got = policies(files, tabs)
want = {t: sorted(v) for t, v in mkpacks.before.items()}
assert got == want, ("0253 BEFORE set differs from the repository history", got, want)
s0253 = [os.path.normpath(os.path.join(sd, x["file"])) for x in sp["steps"] if os.path.basename(x["file"]).startswith("0253_")]
if s0253:
    got2 = policies(files + s0253, tabs)
    assert got2 == {t: sorted(v) for t, v in mkpacks.after.items()}, ("0253 AFTER set differs from the sealed body applied on the history", got2)
for x in sp["steps"]:
    ver = os.path.basename(x["file"])[:4]
    if ver in mkpacks.OBJECTS and x.get("gate_pack"):
        body = open(os.path.normpath(os.path.join(sd, x["file"]))).read()
        for n in mkpacks.OBJECTS[ver]:
            assert n in body, (ver, "expected object not in the sealed body", n)
PY
c=0; for f in $(find "$T/a" -path '*window-reads-s1-*' -name 'window-s1read-*.sh'); do sed -n "/<<'NODE'\$/,/^NODE\$/p" "$f" | sed '1d;$d' > "$T/chk.mjs"; node --check "$T/chk.mjs" 2>"$T/chk.err" || { c=1; bad "the generated read-back program does not parse: $f" "$(head -2 "$T/chk.err")"; }; done; [ $c = 0 ] && ok "every generated read-back node program parses (node --check)"
rm -f "$sd"/.t-*.json
# every generated manifest through the REAL reviewed runner (stage id <= 16 chars, platform, pins, markers) up to the driver, plus the 17-character negative controls
rv=$(bash "$D/runner-validate.sh" "$T/a" 2>&1); echo "$rv" | grep -E "^(ok|FAIL|       )" ; pass=$((pass+$(echo "$rv" | grep -c '^ok   - '))); fail=$((fail+$(echo "$rv" | grep -c '^FAIL - ')))
echo "# RESULT: $pass passed, $fail failed"; [ $fail = 0 ]
