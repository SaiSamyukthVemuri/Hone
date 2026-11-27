-- ===========================================================================
-- S1 READ-BACK (window-s1read.sh): live hosted migration history AFTER the S1 apply
-- Reads supabase_migrations.schema_migrations only. One SELECT. No writes. Counts and
-- version strings only; no identifiers, no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-history.sql (window-s1read.sh does this).
-- NO chain guard, on purpose: this file IS the history read. window-s1read.sh checks it
-- before it reads anything else, and every other S1 file carries its own max = 0246 guard.
--
-- EXPECTED PASS (every column):
--   applied_count                  = 245   (211 before S1 + the 34 files 0213..0246)
--   hosted_max                     = '0246'
--   distinct_versions_ge_0213      = 34
--   versions_ge_0213               = 34    (no duplicate row)
--   versions_0213_0246_once_each   = 34    (each of 0213..0246 present exactly once)
--   versions_above_0246            = 0
-- STOP CONDITION: any column differs. Do not promote. Do not repair history.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(distinct version) from supabase_migrations.schema_migrations where version >= '0213') as distinct_versions_ge_0213,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0213') as versions_ge_0213,
  (select count(*) from generate_series(213, 246) g(v)
     where (select count(*) from supabase_migrations.schema_migrations m where m.version = lpad(g.v::text, 4, '0')) = 1) as versions_0213_0246_once_each,
  (select count(*) from supabase_migrations.schema_migrations where version > '0246')  as versions_above_0246;
