#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. Gap-pending read v2 proof, throwaway CI database at the 0246 chain.
set -euo pipefail
cd "$(dirname "$0")"
export PGPASSWORD=postgres
P="psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres"
Q=obs/obs-1035-gap-pending-payments-v2.sql
[ "$($P -At -c 'select max(version) from supabase_migrations.schema_migrations')" = 0246 ]
echo "== 0. file hash is the manifest line"
( cd obs && grep " obs-1035-gap-pending-payments-v2.sql\$" MANIFEST.sha256 | sha256sum -c - )
echo "== 1. clean database at 0246: 19 rows, all zero"
$P --csv -f $Q | python3 prove-pending-v2.py clean
echo "== 2. seeded: every row counts exactly its seed; old (30 h) and terminal rows do not count; 10 h rows do"
$P -q -f seed-pending-v2.sql >/dev/null
$P --csv -f $Q | python3 prove-pending-v2.py seeded
echo "== 3. refuses at another history (0247 present)"
$P -q -c "insert into supabase_migrations.schema_migrations (version) values ('0247')"
if out=$($P --csv -f $Q 2>&1); then echo "NOT REFUSED"; exit 1; fi
echo "$out" | grep -qi "division by zero" && echo "refused: division by zero"
$P -q -c "delete from supabase_migrations.schema_migrations where version = '0247'"
echo "== 4. the runner's own gates (manifest + lexical) accept the file; it stops only at the missing project ref"
out=$(cd obs && env -u HONE_WINDOW_PROJECT_REF bash run-window-read-macos.sh obs-1035-gap-pending-payments-v2.sql 2>&1 || true)
echo "$out"; echo "$out" | grep -q "HONE_WINDOW_PROJECT_REF is not set"
echo "OBS-READ-PREP PROOF (gap-pending v2, 0246): ALL PASS"
