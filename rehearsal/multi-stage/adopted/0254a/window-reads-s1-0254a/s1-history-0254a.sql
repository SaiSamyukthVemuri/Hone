-- S1 read-back history (0254-AFTER-0257 ONLINE STAGE, PREPARATION ONLY / HELD). Derived from s1-history-0254.sql (412456d3). Read-only; counts and version strings only.
-- EXPECTED after the include-all push: 248 rows, max 0257 (unchanged), 0254 once, 0257 once, 0248 once, 0247 absent, nothing at 0249..0253 or 0255..0256, nothing above 0257.
select
  (select count(*) from supabase_migrations.schema_migrations)                                                                                  as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                                                                              as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version = '0254')                                                           as rows_0254,
  (select count(*) from supabase_migrations.schema_migrations where version = '0257')                                                           as rows_0257,
  (select count(*) from supabase_migrations.schema_migrations where version = '0248')                                                           as rows_0248,
  (select count(*) from supabase_migrations.schema_migrations where version = '0247')                                                           as rows_0247,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0249' and version <= '0253')                                    as versions_0249_0253,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0255' and version <= '0256')                                    as versions_0255_0256,
  (select count(*) from supabase_migrations.schema_migrations where version > '0257')                                                           as versions_above_0257,
  (select count(*) from generate_series(213, 246) g(v)
     where (select count(*) from supabase_migrations.schema_migrations m where m.version = lpad(g.v::text, 4, '0')) = 1)                         as versions_0213_0246_once_each;
