#!/bin/bash
# REHEARSAL - NEVER MERGE. Runs every SQL file of the two 0248 window variants against a REAL schema (CI only, no hosted access, canary data only):
# a fresh local Supabase database holding the repository chain 0001..0246 (the hosted history before the stage), then the sealed 0248.
#   PRE   at 0246: the S0a read set (parameterised g02, the g12 dry run of 0248's preflight, open transactions, table sizes) -> variant comparator: all PASS.
#   ROGUE a callable SECURITY DEFINER that reads client_intake_forms: g12 must predict a refusal AND the sealed 0248 must really refuse (parity).
#   S1PRE the S1 read-back set BEFORE 0248: the verdict program must refuse (history still 245, the old function body).
#   POST  the sealed 0248 applied (a history row recorded as the CLI would): the S1 read-back set -> verdict program: OVERALL PASS.
set -uo pipefail
cd "$(dirname "$0")"
: "${DB:?DB container name required}"
V=$PWD/variants; T=${RUNNER_TEMP:-/tmp}/window-0248-chain; rm -rf "$T"; mkdir -p "$T"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
pq() { docker exec -i "$DB" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
psqlj() { { echo "select coalesce(json_agg(t), '[]'::json) from ("; sed 's/;[[:space:]]*$//' "$1"; echo ") t;"; } | pq -f -; }
capture() { local d=$1; shift; mkdir -p "$d"; local f; for f in "$@"; do psqlj "$f" > "$d/$(basename "${f%.sql}").json" || return 1; done; }
SEALED="$PWD/src/verify/0248_intake_protected_write_enforcement.sql"
S0A="$V/s0a/g02-history-0248.sql $V/s0a/g12-0243-intake-definers-0248.sql $V/s0a/s1-open-transactions-0248.sql $V/s0a/w03-table-sizes-0248.sql"
S1="$V/s1read/s1-history-0248.sql $V/s1read/c01_functions-exist.sql $V/s1read/c02_function-bodies.sql"
awk "/cat > \"\\\$TMPD\\/check-0248.mjs\" <<'NODE'/{f=1;next} /^NODE\$/{f=0} f" "$V/s1read/window-s1read-0248.sh" > "$T/check-0248.mjs"
[ -s "$T/check-0248.mjs" ] && ok "the verdict program was extracted from window-s1read-0248.sh" || { bad "verdict program extraction"; exit 1; }
verdict() { A_RES="$1" node "$T/check-0248.mjs" 2>&1; }

echo "== PRE: the repository chain 0001..0246, nothing of 0248"
echo "history: $(pq -c "select count(*) || ' rows, max ' || max(version) from supabase_migrations.schema_migrations")"
capture "$T/pre" $S0A && ok "the four S0a files ran on a real schema (each one SELECT through the runner's own shape)" || bad "an S0a file failed to run"
node tests/chain-eval.mjs "$T/pre" pass && ok "PRE: S0-2, S0-6c, S0-7, S0-W3, S0-13, S0-14 all PASS on the real 0246 database" || bad "PRE: the variant comparator did not pass on the real database"
echo "g12 columns at 0246: $(cat "$T/pre/g12-0243-intake-definers-0248.json" | tr -d '\n ')"

echo "== S1PRE: the read-back before 0248 must refuse"
capture "$T/s1pre" $S1 && ok "the three S1 files ran on a real schema" || bad "an S1 file failed to run"
out=$(verdict "$T/s1pre"); rc=$?
[ "$rc" != 0 ] && ! printf '%s' "$out" | grep -q 'OVERALL PASS' && ok "S1PRE: refused ($(printf '%s' "$out" | grep -m1 FAIL | cut -c1-110))" || bad "S1PRE: the verdict program passed before 0248 was applied" "$out"

echo "== ROGUE: a callable definer that reads client_intake_forms"
pq -c "create function public.rogue_intake_reader() returns integer language sql security definer set search_path = '' as \$\$ select count(*)::int from public.client_intake_forms \$\$" >/dev/null
echo "rogue callable by authenticated: $(pq -c "select has_function_privilege('authenticated', 'public.rogue_intake_reader()', 'execute')")"
capture "$T/rogue" $S0A
node tests/chain-eval.mjs "$T/rogue" g12-fails && ok "ROGUE: g12 predicts a refusal (unexpected_callable_definers > 0) and nothing else changed" || bad "ROGUE: g12 did not flag the rogue definer"
err=$(pq -f - < "$SEALED" 2>&1 >/dev/null); rc=$?
[ "$rc" != 0 ] && printf '%s' "$err" | grep -q 'Unexpected callable intake definer requires review' && ok "ROGUE: the sealed 0248 really refuses ('Unexpected callable intake definer requires review.'), so g12 and 0248 agree" || bad "ROGUE: the sealed 0248 did not refuse as g12 predicted" "$err"
pq -c "drop function public.rogue_intake_reader()" >/dev/null

echo "== APPLY: the sealed 0248 on the clean 0246 database (what g12 predicted would pass)"
err=$(pq -f - < "$SEALED" 2>&1 >/dev/null); rc=$?
[ "$rc" = 0 ] && ok "the sealed 0248 applied (g12 had predicted a pass)" || bad "the sealed 0248 refused although g12 predicted a pass" "$err"
pq -c "insert into supabase_migrations.schema_migrations (version, name) values ('0248', 'intake_protected_write_enforcement')" >/dev/null && ok "history row recorded as the CLI would (246 rows)"

echo "== POST: the S1 read-back set after 0248"
capture "$T/post" $S1 && ok "the three S1 files ran again" || bad "an S1 file failed to run"
out=$(verdict "$T/post"); rc=$?
echo "$out"
[ "$rc" = 0 ] && printf '%s\n' "$out" | grep -Fxq 'OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)' && ok "POST: OVERALL PASS on the real database (functions-exist and the body md5 equal the verify bundle's)" || bad "POST: the verdict program did not pass on the real database" "$out"
echo "integer typing in the real capture: $(tr -d '\n ' < "$T/post/c01_functions-exist.json")  $(tr -d '\n ' < "$T/post/s1-history-0248.json" | cut -c1-120)"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
