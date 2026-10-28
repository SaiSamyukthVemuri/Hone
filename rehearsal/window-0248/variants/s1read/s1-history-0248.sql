-- ===========================================================================
-- S1 READ-BACK (0248-ONLY STAGE, window-s1read-0248.sh): live hosted migration history AFTER the 0248 push
-- Derived from s1-history.sql (the 0246 form). Reads supabase_migrations.schema_migrations only. One SELECT. No writes.
-- Counts and version strings only; no identifiers, no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-history-0248.sql (window-s1read-0248.sh does this).
-- NO chain guard, on purpose: this file IS the history read, and window-s1read-0248.sh checks it before it reads anything else.
--
-- EXPECTED PASS (every column):
--   applied_count                  = 246   (245 before the stage + 0248)
--   hosted_max                     = '0248'
--   rows_0248                      = 1     (0248 present exactly once)
--   rows_0247                      = 0     (0247 absent)
--   versions_ge_0247               = 1     (only 0248 is at or above 0247)
--   versions_above_0248            = 0     (nothing above 0248)
--   versions_0213_0246_once_each   = 34    (the chain below the stage is intact)
-- STOP CONDITION: any column differs. Do not promote. Do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version = '0248')   as rows_0248,
  (select count(*) from supabase_migrations.schema_migrations where version = '0247')   as rows_0247,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0247') as versions_ge_0247,
  (select count(*) from supabase_migrations.schema_migrations where version > '0248')   as versions_above_0248,
  (select count(*) from generate_series(213, 246) g(v)
     where (select count(*) from supabase_migrations.schema_migrations m where m.version = lpad(g.v::text, 4, '0')) = 1) as versions_0213_0246_once_each;
