#!/bin/bash
# REHEARSAL - NEVER MERGE. Runs ON A LOCAL TEST STACK ONLY (CI, ubuntu): executes the REAL S1 read-back gate files
# (machines/window-reads-s1) with psql against a synthetic database built from the d189768b migration chain and writes
# their results as JSON arrays of objects, the shape the hosted `db query --linked -o json` returns.
# usage: db-fixtures.sh <s1-gate-dir> <out-dir> before|after   (before: the database is at 0212; after: it is at 0246)
# Scenarios: at0212 (before S1), ok (after the 34 files), closure_bad (one closure wrong), body_bad (one replaced body wrong).
set -u
GATE="$1"; OUT="$2"; PHASE="$3"
export PGPASSWORD=postgres
PSQL="psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres"
FILES="s1-history census-0213-0246 s1-g10 s1-closures s1-table-privileges s1-body-md5"
cap() { # cap SCENARIO
  mkdir -p "$OUT/$1"
  for stem in $FILES; do
    body=$(sed -e 's/--.*$//' "$GATE/$stem.sql" | tr '\n' ' ' | sed -e 's/;[[:space:]]*$//')
    if $PSQL -c "select coalesce(json_agg(t), '[]'::json) from ($body) t" > "$OUT/$1/$stem.json" 2> "$OUT/$1/$stem.error"; then rm -f "$OUT/$1/$stem.error"; else rm -f "$OUT/$1/$stem.json"; fi
  done
  echo "== $1: $(ls "$OUT/$1" | tr '\n' ' ')"
}
sql() { $PSQL -c "$1" >/dev/null; }
echo "history: $($PSQL -c 'select count(*), max(version) from supabase_migrations.schema_migrations')"
case "$PHASE" in
before) cap at0212 ;;
after)
  cap ok
  # closure wrong: the new studio_named_stripe_accounts becomes executable by authenticated (every overload)
  sql "do \$\$ declare r record; n int := 0; begin for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'studio_named_stripe_accounts' loop execute format('grant execute on function %s to authenticated', r.f); n := n + 1; end loop; if n = 0 then raise exception 'no such function'; end if; end \$\$"
  cap closure_bad
  sql "do \$\$ declare r record; begin for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'studio_named_stripe_accounts' loop execute format('revoke execute on function %s from authenticated', r.f); end loop; end \$\$"
  # body wrong: claim_email_provider_events (replaced by 0227) gets one extra statement; the function is re-created from its own definition
  sql "do \$\$ declare d text; o oid; begin select p.oid into strict o from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'claim_email_provider_events'; d := pg_get_functiondef(o); if position('begin' in d) = 0 then raise exception 'no begin'; end if; execute regexp_replace(d, 'begin', 'begin null;'); end \$\$"
  cap body_bad ;;
*) echo "usage: db-fixtures.sh <s1-gate-dir> <out-dir> before|after" >&2; exit 2 ;;
esac
