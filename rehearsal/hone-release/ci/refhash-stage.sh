#!/bin/bash
# REHEARSAL - NEVER MERGE. Same proof as refhash.sh, parameterised for ONE stage whose files are a subset of the chain already applied in the CI database
# (CI only, no hosted access). usage: refhash-stage.sh DB-CONTAINER TEMPLATE-DIR FIRST LAST N_SEALED N_FUNCTIONS N_CHECKS
# The database holds the chain through 0250; a subset stage's function-body hashes are valid only if no OTHER applied file redefines the same function, so that is asserted below.
set -u
HR="$(cd "$(dirname "$0")/.." && pwd)"; DB=$1; TPL=$HR/$2; FIRST=$3; LAST=$4; NSEALED=$5; NFUNC=$6; NCHECKS=$7
T=${RUNNER_TEMP:-/tmp}/refhash-$FIRST-$LAST; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0; ok() { pass=$((pass+1)); echo "ok   - $1"; }; bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
psqld() { docker exec "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
# 1. the sealed files are exactly the ones the reviewed template lists, and there are exactly N_SEALED
all=1; for f in "$TPL"/sealed/*.sql; do n=$(basename "$f"); s=$(sha256sum "$f" | cut -d' ' -f1); grep -q "\`$n\` $s" "$TPL/review.md" || { all=0; echo "sealed file differs from review.md: $n"; }; done
[ "$all" = 1 ] && [ "$(ls "$TPL"/sealed/*.sql | wc -l)" = "$NSEALED" ] && ok "the $NSEALED sealed file(s) equal the sha256 list in the reviewed review.md" || bad "sealed files"
# 2. the database holds the stage's versions
have=$(psqld -c "select count(*) from supabase_migrations.schema_migrations where version between '$FIRST' and '$LAST'")
[ "$have" -ge "$NSEALED" ] && ok "the fresh CI database holds the stage versions $FIRST..$LAST" || { bad "the database does not hold $FIRST..$LAST ($have rows)"; echo "RESULT: $pass passed, $fail failed"; exit 1; }
# 3. no applied file other than the stage's own redefines the stage's functions
fnames=$(grep -o "('public', '[a-z_0-9]*')" "$TPL/needs-reference/function-bodies.sql" | sed "s/.*, '\(.*\)')/\1/" | sort -u)
other=0; for fn in $fnames; do
  for f in "$HR"/../../supabase/migrations/*.sql; do b=$(basename "$f"); [ -e "$TPL/sealed/$b" ] && continue
    grep -qiE "function[[:space:]]+(public\.)?$fn[[:space:]]*\(" "$f" && { other=$((other+1)); echo "also defined in $b"; [[ "${b%%_*}" > "$LAST" ]] && bad "a LATER file ($b) redefines $fn: the body hash would not be the stage-only one"; }
  done
done
[ -n "$fnames" ] && ok "functions of the stage: $(echo $fnames | tr '\n' ' ')" || bad "no function names parsed from needs-reference"
echo "(info) $other other applied file(s) mention these functions; earlier definitions are replaced by the stage, later ones would invalidate the hash"
# 4. capture the function-body expectations with the SQL the tool itself wrote
psqld -c "select coalesce(json_agg(t), '[]'::json) from ($(sed 's/;[[:space:]]*$//' "$TPL/needs-reference/function-bodies.sql")) t" > "$T/fb.json" || bad "capture query"
python3 -I - "$T/fb.json" "$T/capture.json" "$NFUNC" <<'PY' && ok "captured the function-body md5 of $NFUNC function(s) (all present, each once)" || bad "capture shape"
import json, sys
rows = json.load(open(sys.argv[1])); n = int(sys.argv[3]); assert len(rows) == n and len({r["proname"] for r in rows}) == n and all(len(r["md5"]) == 32 for r in rows), rows
json.dump({"function-bodies": rows}, open(sys.argv[2], "w"))
PY
# 5. build with the captured expectations twice (reproducible); the build without captures equals the committed template
python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first "$FIRST" --last "$LAST" --out "$T/a" --capture "$T/capture.json" > /dev/null && python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first "$FIRST" --last "$LAST" --out "$T/b" --capture "$T/capture.json" > /dev/null && cmp -s "$T/a/verify.tar" "$T/b/verify.tar" && ok "the bundle with body hashes is reproducible (verify_sha $(cat "$T/a/verify_sha.txt"))" || bad "with-captures build differs between two runs"
python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$TPL/sealed" --first "$FIRST" --last "$LAST" --out "$T/n" > /dev/null; cmp -s "$T/n/verify.tar" "$TPL/verify.tar" && ok "the bundle WITHOUT captures equals the committed template (verify_sha $(cat "$T/n/verify_sha.txt"))" || bad "template differs"
# 6. run every check against the database; N of N must run and match
n=0; m=0
while IFS=$'\t' read -r cid fn ssha esha; do
  n=$((n+1)); [ "$(sha256sum "$T/a/$fn" | cut -d' ' -f1)" = "$ssha" ] || { bad "$cid: sql sha"; continue; }
  psqld -c "select coalesce(json_agg(t), '[]'::json) from ($(sed 's/;[[:space:]]*$//' "$T/a/$fn")) t" < /dev/null > "$T/r-$cid.json" 2> "$T/r-$cid.err" || { bad "$cid: query failed" "$(head -c 300 "$T/r-$cid.err")"; continue; }
  got=$(python3 -I -c 'import json,sys,hashlib; r=json.load(open(sys.argv[1])); print(hashlib.sha256(json.dumps(r,sort_keys=True,separators=(",",":")).encode()).hexdigest())' "$T/r-$cid.json")
  if [ "$got" = "$esha" ]; then m=$((m+1)); ok "check $cid: the database result equals the bundle's expectation (sha256 ${got:0:16}...)"; else bad "check $cid: MISMATCH" "got ${got:0:16} expected ${esha:0:16}; rows $(head -c 400 "$T/r-$cid.json")"; fi
done < "$T/a/checks.list"
echo "CHECKS: $m of $n match the bundle"
want=$(grep -c . "$T/a/checks.list"); [ "$n" = "$want" ] && [ "$n" = "$NCHECKS" ] && [ "$m" = "$n" ] && ok "all $n checks of the bundle ran and match" || bad "checks run: $n of $want, matched $m (expected $NCHECKS of $NCHECKS)"
echo "VERIFY_SHA_WITH_BODY_HASHES=$(cat "$T/a/verify_sha.txt")"
echo "CAPTURE_JSON=$(cat "$T/capture.json")"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
