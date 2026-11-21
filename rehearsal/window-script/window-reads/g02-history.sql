-- ===========================================================================
-- GATE G2: live hosted migration history (S0a window read; rollout 0213-0246)
-- Source: 01-ops/ROLLOUT-0213-0246-DECISION-PACKAGE.md Part II section 6 (G2), A1.
-- Reference record: docs/production/migration-state.json hosted_note +
--   docs/production/migration-ledger.md "Current state" (0212 reconciliation).
--
-- RUN ONLY VIA: run-window-read.sh g02-history.sql
--   (pinned `npx --yes supabase@2.102.0 db query --linked`, project ref checked).
-- One SELECT. Reads supabase_migrations.schema_migrations only. No writes, no
-- side-effecting function. Returns counts, version strings, one name and one hash.
--
-- EXPECTED PASS (every column):
--   applied_count          = 211
--   hosted_max             = '0212'
--   versions_ge_0213       = 0
--   rows_0211, rows_0212   = 1, 1
--   name_0212              = 'email_delivery_events'
--   statements_0212        = 73
--   statements_sha256_0212 = 'bc13731bb8c36b8a1db2f5a5185d0700308e598e92347a3ab87df696814ef142'
--   last4                  = '0212,0211,0210,0209'
--
-- STOP CONDITION: any column differs. Do not apply, do not repair history,
-- do not reapply 0212. The hash is the recorded "SHA-256 of newline-joined
-- stored statements"; this file computes it as
-- sha256(array_to_string(statements, E'\n')) with no trailing newline. If ONLY
-- the hash differs, it is still a stop: the record owner recomputes it with this
-- recipe before anyone calls it drift.
-- ===========================================================================
select
  (select count(*) from supabase_migrations.schema_migrations)                          as applied_count,
  (select max(version) from supabase_migrations.schema_migrations)                      as hosted_max,
  (select count(*) from supabase_migrations.schema_migrations where version >= '0213') as versions_ge_0213,
  (select count(*) from supabase_migrations.schema_migrations where version = '0211')   as rows_0211,
  (select count(*) from supabase_migrations.schema_migrations where version = '0212')   as rows_0212,
  (select m.name from supabase_migrations.schema_migrations m where m.version = '0212') as name_0212,
  (select cardinality(m.statements) from supabase_migrations.schema_migrations m where m.version = '0212') as statements_0212,
  (select encode(sha256(convert_to(array_to_string(m.statements, E'\n'), 'UTF8')), 'hex')
     from supabase_migrations.schema_migrations m where m.version = '0212')             as statements_sha256_0212,
  (select string_agg(t.version, ',' order by t.version desc)
     from (select m.version from supabase_migrations.schema_migrations m
           order by m.version desc limit 4) t)                                          as last4;
