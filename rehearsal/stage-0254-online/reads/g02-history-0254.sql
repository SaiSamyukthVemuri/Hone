-- ===========================================================================
-- GATE G2 (0254 ONLINE STAGE): live hosted migration history before the 0254 push
-- Derived from g02-history-0248.sql (19e4e057); only the expected values differ. Reads supabase_migrations.schema_migrations only.
-- One SELECT. No writes. Counts and version strings only.
--
-- RUN ONLY VIA: run-window-read-macos.sh g02-history-0254.sql
--
-- EXPECTED PASS (every column):
--   applied_count    = 246          (hosted before the stage: 246 rows, 0001..0248 without the skipped 0158 and the unhosted 0247)
--   hosted_max       = '0248'
--   versions_ge_0249 = 0            (nothing at or above 0249, so 0254 is not applied yet)
--   rows_0246        = 1
--   rows_0248        = 1
--   last4            = '0248,0246,0245,0244'   (0247 is absent by design)
-- STOP CONDITION: any column differs. Do not apply, do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0249') as versions_ge_0249,
  (select count(*) from supabase_migrations.schema_migrations where version = '0246')   as rows_0246,
  (select count(*) from supabase_migrations.schema_migrations where version = '0248')   as rows_0248,
  (select string_agg(t.version, ',' order by t.version desc)
     from (select m.version from supabase_migrations.schema_migrations m
           order by m.version desc limit 4) t)                                          as last4;
