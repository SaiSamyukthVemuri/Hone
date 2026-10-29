-- ===========================================================================
-- GATE G2 (0248-ONLY STAGE): live hosted migration history before the 0248 push
-- Derived for the 0248-only stage from g02-history.sql (the 0212/0213 form). Reads supabase_migrations.schema_migrations only.
-- One SELECT. No writes. Counts and version strings only.
--
-- RUN ONLY VIA: run-window-read-macos.sh g02-history-0248.sql (window-s0a-0248.sh does this).
--
-- EXPECTED PASS (every column):
--   applied_count    = 245          (hosted before the stage: 245 rows)
--   hosted_max       = '0246'
--   versions_ge_0247 = 0            (nothing at or above 0247, so 0248 is not applied yet and 0247 is absent)
--   rows_0245        = 1
--   rows_0246        = 1
--   last4            = '0246,0245,0244,0243'
-- STOP CONDITION: any column differs. Do not apply, do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0247') as versions_ge_0247,
  (select count(*) from supabase_migrations.schema_migrations where version = '0245')   as rows_0245,
  (select count(*) from supabase_migrations.schema_migrations where version = '0246')   as rows_0246,
  (select string_agg(t.version, ',' order by t.version desc)
     from (select m.version from supabase_migrations.schema_migrations m
           order by m.version desc limit 4) t)                                          as last4;
