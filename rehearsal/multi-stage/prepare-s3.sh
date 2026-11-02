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
