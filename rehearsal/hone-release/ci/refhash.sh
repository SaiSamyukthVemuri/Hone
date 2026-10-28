#!/bin/bash
# REHEARSAL - NEVER MERGE. HON66-REFHASH: closes the verify bundle's `needs-reference` gap in CI ONLY. On a fresh CI database that holds the chain 0001-0246 PLUS the sealed
# 0247-0250 (copied read-only from templates/stage-0247-0250/sealed/, byte-identical to the sealed set, checked by sha256 below; NO migration file in supabase/migrations is edited),
# it computes the function-body md5 expectations, builds the bundle WITH them through the existing tool (--capture), checks the build is reproducible, and then RUNS EVERY CHECK OF THE
# BUNDLE against the database and compares each result's sha256 with the bundle's expected one (the same comparison `verify` makes). usage: refhash.sh DB-CONTAINER
set -u
HR="$(cd "$(dirname "$0")/.." && pwd)"; DB=$1; T=${RUNNER_TEMP:-/tmp}/refhash; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
psqld() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
TPL=$HR/templates/stage-0247-0250
# 1. the sealed files are exactly the ones the reviewed template lists
all=1; for f in "$TPL"/sealed/*.sql; do n=$(basename "$f"); s=$(sha256sum "$f" | cut -d' ' -f1); grep -q "\`$n\` $s" "$TPL/review.md" || { all=0; echo "sealed file differs from review.md: $n"; }; done
[ "$all" = 1 ] && [ "$(ls "$TPL"/sealed/*.sql | wc -l)" = 4 ] && ok "the four sealed 0247-0250 files equal the sha256 list in the reviewed review.md" || bad "sealed files"
# 2. the database holds the stage
[ "$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version in ('0247','0248','0249','0250')")" = 4 ] && [ "$(psqld -c "select max(version) from supabase_migrations.schema_migrations")" = 0250 ] && ok "the fresh CI database holds the chain through 0250 (history max 0250, 0247-0250 present)" || { bad "the database does not hold 0247-0250 (history: $(psqld -c "select count(*)||' rows, max '||max(version) from supabase_migrations.schema_migrations"))"; echo "RESULT: $pass passed, $fail failed"; exit 1; }
# 3. capture the function-body expectations with the SQL the tool itself wrote for this purpose
SQLF=$TPL/needs-reference/function-bodies.sql
psqld -c "select coalesce(json_agg(t), '[]'::json) from ($(sed 's/;[[:space:]]*$//' "$SQLF")) t" > "$T/fb.json" || bad "capture query"
python3 -I - "$T/fb.json" "$T/capture.json" <<'PY' && ok "captured the function-body md5 of 13 functions (all present, each once)" || bad "capture shape"
import json, sys
rows = json.load(open(sys.argv[1])); assert len(rows) == 13 and len({r["proname"] for r in rows}) == 13 and all(len(r["md5"]) == 32 for r in rows), rows
json.dump({"function-bodies": rows}, open(sys.argv[2], "w"))
PY
# 4. build the bundle with the captured expectations, twice, from the sealed bytes
python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first 0247 --last 0250 --out "$T/a" --capture "$T/capture.json" > /dev/null && python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first 0247 --last 0250 --out "$T/b" --capture "$T/capture.json" > /dev/null && cmp -s "$T/a/verify.tar" "$T/b/verify.tar" && ok "the bundle with the captured body hashes is reproducible" || bad "bundle build"
python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first 0247 --last 0250 --out "$T/n" > /dev/null; cmp -s "$T/n/verify.tar" "$TPL/verify.tar" && ok "the bundle WITHOUT captures equals the committed template (verify_sha $(cat "$T/n/verify_sha.txt"))" || bad "template differs"
# 5. run every check of the bundle against the database; the result sha256 must equal the bundle's expected one (what verify compares)
n=0; m=0
while IFS=$'\t' read -r cid fn ssha esha; do
  n=$((n+1)); [ "$(sha256sum "$T/a/$fn" | cut -d' ' -f1)" = "$ssha" ] || { bad "$cid: sql sha"; continue; }
  psqld -c "select coalesce(json_agg(t), '[]'::json) from ($(sed 's/;[[:space:]]*$//' "$T/a/$fn")) t" > "$T/r-$cid.json" 2> "$T/r-$cid.err" || { bad "$cid: query failed" "$(head -c 300 "$T/r-$cid.err")"; continue; }
  got=$(python3 -I -c 'import json,sys,hashlib; r=json.load(open(sys.argv[1])); print(hashlib.sha256(json.dumps(r,sort_keys=True,separators=(",",":")).encode()).hexdigest())' "$T/r-$cid.json")
  if [ "$got" = "$esha" ]; then m=$((m+1)); ok "check $cid: the database result equals the bundle's expectation (sha256 ${got:0:16}...)"; else bad "check $cid: MISMATCH" "got ${got:0:16} expected ${esha:0:16}; rows $(head -c 400 "$T/r-$cid.json")"; fi
done < "$T/a/checks.list"
echo "CHECKS: $m of $n match the bundle"
echo "VERIFY_SHA_WITH_BODY_HASHES=$(cat "$T/a/verify_sha.txt")"
echo "CAPTURE_JSON=$(cat "$T/capture.json")"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
