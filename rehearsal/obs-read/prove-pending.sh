#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. Gap-pending read proof, throwaway CI database at the 0246 chain.
set -euo pipefail
cd "$(dirname "$0")"
export PGPASSWORD=postgres
P="psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres"
Q=obs/obs-1035-gap-pending-payments.sql
[ "$($P -At -c 'select max(version) from supabase_migrations.schema_migrations')" = 0246 ]
echo "== 1. clean database at 0246: 17 rows, all zero"
$P --csv -f $Q | python3 prove-pending.py clean
echo "== 2. seeded: captured-but-pending charge, card setup without a saved method, retained stripe_events, clean and out-of-lookback rows"
$P -q -f seed-pending.sql >/dev/null
$P --csv -f $Q | python3 prove-pending.py seeded
echo "== 3. refuses at another history (0247 present)"
$P -q -c "insert into supabase_migrations.schema_migrations (version) values ('0247')"
if out=$($P --csv -f $Q 2>&1); then echo "NOT REFUSED"; exit 1; fi
echo "$out" | grep -qi "division by zero" && echo "refused: division by zero"
$P -q -c "delete from supabase_migrations.schema_migrations where version = '0247'"
echo "OBS-READ-PREP PROOF (gap-pending, 0246): ALL PASS"
