-- S2 (0274) HISTORY (run BEFORE apply and AFTER apply). READ-ONLY, ONE STATEMENT. Catalog metadata and counts only; no client row, no name, no id.
-- Before apply: 252 rows, max 0272, 0274 absent. After a correct apply: 253 rows, max 0274, 0274 exactly once.
select 'total rows' as item, count(*)::text as value from supabase_migrations.schema_migrations
union all
select 'highest version', max(version) from supabase_migrations.schema_migrations
union all
select 'version above 0272', version from supabase_migrations.schema_migrations where version > '0272'
union all
select 'present of 0258, 0266, 0272', count(*)::text from supabase_migrations.schema_migrations
 where version in ('0258', '0266', '0272')
union all
select 'present of 0274', count(*)::text from supabase_migrations.schema_migrations where version = '0274'
union all
select 'rows with a duplicate version', count(*)::text
  from (select version from supabase_migrations.schema_migrations group by version having count(*) > 1) d
 order by 1, 2;
