#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. Prepares the S3 (0277/0278) builder input on a runner. Team's s3.json reads the hosted dir as the 249 files the production
# tree held when the package was built (0258, 0266, 0272 and 0274 arrive as the sealed "extra" files). Production now carries those four files, so the
# hosted dir is the checkout's supabase/migrations MINUS them. It first proves the four production files are byte-equal to the sealed extras the package pins.
# usage: prepare-s3.sh HOSTED249_DIR     writes rehearsal/multi-stage/spec/s3.ci.json (the same spec, only "dir" rewritten)
set -euo pipefail
H="${1:?HOSTED249_DIR}"
SPEC=rehearsal/multi-stage/spec
rm -rf "$H"; mkdir -p "$H"
python3 -I - "$SPEC/s3.json" "$H" <<'PY'
import hashlib, json, os, re, shutil, sys
spec, dest = json.load(open(sys.argv[1])), sys.argv[2]
extra = {os.path.basename(e["file"]): e["sha256"] for e in spec["hosted"]["extra"]}
mig = "supabase/migrations"
for name, want in sorted(extra.items()):
    got = hashlib.sha256(open(os.path.join(mig, name), "rb").read()).hexdigest()
    if got != want:
        sys.exit("FAIL production's %s (%s) is not the sealed extra the package pins (%s)" % (name, got, want))
    print("ok   production's %s is byte-equal to the pinned sealed extra" % name)
n = 0
for f in sorted(os.listdir(mig)):
    if re.match(r"^\d{4}_.*\.sql$", f) and f not in extra:
        shutil.copy(os.path.join(mig, f), dest); n += 1
print("hosted dir: %d files (production %d minus the %d extras)" % (n, n + len(extra), len(extra)))
if n != 249:
    sys.exit("FAIL expected 249 files in the hosted dir, got %d" % n)
spec["hosted"]["dir"] = os.path.abspath(dest)
json.dump(spec, open(os.path.join(os.path.dirname(sys.argv[1]), "s3.ci.json"), "w"), indent=1)
PY
# The FIXED variant: Team's pack.json lists the chain-guard column (at_hosted_0274 / at_hosted_0277) among the boolean "fields", but the generated rule already
# checks that column as the NUMBER 1 and then also demands isTrue(), which a number never satisfies, so the generated preflight rule refuses every correct
# hosted state. The 0272 and 0274 packs do not list it. The variant removes exactly that one entry per pack; everything else is byte-identical.
python3 -I - "$SPEC" <<'PY'
import json, os, shutil, sys
spec_dir = sys.argv[1]
gp = os.path.join(os.path.dirname(spec_dir), "gate-packs"); fx = os.path.join(os.path.dirname(spec_dir), "gate-packs-fixed")
shutil.rmtree(fx, ignore_errors=True); os.makedirs(fx)
for n in ("0277", "0278"):
    shutil.copytree(os.path.join(gp, n), os.path.join(fx, n))
    pj = os.path.join(fx, n, "pack.json"); d = json.load(open(pj))
    before = list(d["preflight"]["fields"]); d["preflight"]["fields"] = [f for f in before if not f.startswith("at_hosted_")]
    assert len(before) - len(d["preflight"]["fields"]) == 1, before
    json.dump(d, open(pj, "w"), indent=1)
spec = json.load(open(os.path.join(spec_dir, "s3.ci.json")))
for st in spec["steps"]:
    st["gate_pack"] = st["gate_pack"].replace("../gate-packs/", "../gate-packs-fixed/")
json.dump(spec, open(os.path.join(spec_dir, "s3.fixed.json"), "w"), indent=1)
print("ok   fixed variant written: spec/s3.fixed.json + gate-packs-fixed/ (one entry removed per pack)")
PY
