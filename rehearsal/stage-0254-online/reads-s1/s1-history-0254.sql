-- S1 read-back history (0254 ONLINE STAGE). Derived from s1-history-0248.sql (a4d3c5af). Read-only; counts and version strings only.
-- EXPECTED after the push: 247 rows, max 0254, 0254 once, 0248 once, 0247 absent, nothing at 0249..0253, nothing above 0254.
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version = '0254')   as rows_0254,
  (select count(*) from supabase_migrations.schema_migrations where version = '0248')   as rows_0248,
  (select count(*) from supabase_migrations.schema_migrations where version = '0247')   as rows_0247,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0249') as versions_ge_0249,
  (select count(*) from supabase_migrations.schema_migrations where version > '0254')   as versions_above_0254,
  (select count(*) from generate_series(213, 246) g(v)
     where (select count(*) from supabase_migrations.schema_migrations m where m.version = lpad(g.v::text, 4, '0')) = 1) as versions_0213_0246_once_each;
