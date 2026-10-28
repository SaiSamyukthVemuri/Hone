#!/bin/bash
# REHEARSAL - NEVER MERGE. The whole 0248 window-variant proof, offline: no database, no hosted call, no credential.
set -euo pipefail
cd "$(dirname "$0")"
T=$(mktemp -d)
python3 -I make-window-0248.py --out "$T" >/dev/null
diff -r "$T" variants && echo "ok: the committed variants equal the regenerated ones (deterministic, head_sha $(python3 -c 'import json;print(json.load(open("variants/SHAS.json"))["head_sha"])'))"
bash -n variants/s0a/window-s0a-0248.sh && bash -n variants/s1read/window-s1read-0248.sh && echo "ok: both scripts parse"
node --check variants/s0a/compare-preflight-lib.mjs && node --check variants/s0a/compare-preflight.mjs && echo "ok: the comparator parses"
node --test tests/window-0248.test.mjs
echo "--- sha256 of every generated file"
(cd variants && find . -type f ! -name '*.diff' | sort | xargs sha256sum)
