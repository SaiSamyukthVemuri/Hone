-- S1 (0258+0266+0272) HISTORY (run BEFORE apply and AFTER apply). READ-ONLY, ONE STATEMENT. Catalog metadata and counts only; no client row, no name, no id.
-- DRAFT, unreviewed. Run only through run-window-read-macos.sh under the operator per-run approval.
-- Hosted migration history: total rows, the highest version, and every version above 0257 (version
-- strings only), plus how many of 0258, 0266, 0272 are present. Before apply: 249 rows, max 0257, none
-- of the three. After a correct apply: 252 rows, max 0272, each of the three exactly once.
select 'total rows' as item, count(*)::text as value from supabase_migrations.schema_migrations
union all
select 'highest version', max(version) from supabase_migrations.schema_migrations
union all
select 'version above 0257', version from supabase_migrations.schema_migrations where version > '0257'
union all
select 'present of 0258, 0266, 0272', count(*)::text from supabase_migrations.schema_migrations
 where version in ('0258', '0266', '0272')
union all
select 'rows with a duplicate version', count(*)::text
  from (select version from supabase_migrations.schema_migrations group by version having count(*) > 1) d
 order by 1, 2;
