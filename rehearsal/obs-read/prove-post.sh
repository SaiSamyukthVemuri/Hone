#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. OBS-READ-PREP post-S3 proof, on a throwaway CI database at the 0246 chain.
set -euo pipefail
cd "$(dirname "$0")"
export PGPASSWORD=postgres
P="psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres"
POST=obs/obs-0214-observed-post-s3.sql
[ "$($P -At -c 'select max(version) from supabase_migrations.schema_migrations')" = 0246 ]
[ "$($P -At -c 'select count(*) from public.studios')" = 0 ]
echo "== 1. runs at 0246 with no studios: no rows"
[ "$($P --csv -f $POST | tail -n +2 | wc -l)" = 0 ]
echo "== 2. observed-CA (ordinal 1) and unobserved (ordinal 7)"
$P -q -f seed-post.sql >/dev/null
$P --csv -f $POST | python3 prove-post.py observed-ca-and-unobserved
echo "== 3. observed non-CA (ordinal 1) and observed CA with a recorded conflict (ordinal 7)"
$P -q -f mutate-post.sql
$P --csv -f $POST | python3 prove-post.py non-ca-and-conflict
echo "== 4. the post file refuses at another history (0247 present)"
$P -q -c "insert into supabase_migrations.schema_migrations (version) values ('0247')"
if out=$($P --csv -f $POST 2>&1); then echo "NOT REFUSED"; exit 1; fi
echo "$out" | grep -q "division by zero" && echo "refused: division by zero"
$P -q -c "delete from supabase_migrations.schema_migrations where version = '0247'"
echo "== 5. the pre-window file refuses at 0246 (its guard is 0212)"
if out=$($P --csv -f obs/obs-0214-live-named-accounts.sql 2>&1); then echo "NOT REFUSED"; exit 1; fi
echo "$out" | grep -q "division by zero" && echo "pre-window file refused at 0246: division by zero"
echo "OBS-READ-PREP PROOF (0246): ALL PASS"
