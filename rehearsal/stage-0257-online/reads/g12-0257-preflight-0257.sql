-- ===========================================================================
-- G12 (0257 ONLINE STAGE): a read-only DRY RUN of what the sealed 0257 needs to already exist (and not exist) at hosted 0248.
-- The sealed 0257 adds two columns and a CHECK to studio_payment_jurisdiction_changes (0214) and creates one new command, the v2 of 0214's initialization
-- command. The v2 body reads six existing tables, two existing functions and the attempts table's status columns; any mismatch would make the command
-- fail when it is first called, and a clash with an existing object would abort the transaction (atomically, nothing applied). One SELECT over pg_catalog and
-- supabase_migrations; no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh g12-0257-preflight-0257.sql
--
-- EXPECTED PASS (every column):
--   at_hosted_0248        = 1     (chain guard: division by zero unless the hosted history max is 0248)
--   tables_present        = true  (the audit table, with RLS enabled, and the six tables the v2 body reads all exist)
--   helpers_ok            = true  (studio_account_acceptable_for_jurisdiction and studio_named_stripe_accounts exist)
--   v1_ok                 = true  (0214's own command exists exactly once as a definer with a pinned search_path: it stays as it is)
--   attempt_columns_ok    = true  (stripe_account_provisioning_attempts has id, studio_id, status, terminal_at, processing_claim_token, stripe_account_id, stripe_livemode)
--   new_objects_absent    = true  (the v2 command, both new columns and the new CHECK do not exist yet)
-- STOP CONDITION: any column differs. 0257 is predicted to refuse, to clash, or to run against the wrong shape.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0248'
                   then 1 else 0 end) as at_hosted_0248
)
select
  g.at_hosted_0248,
  coalesce((select count(*) = 1 from pg_catalog.pg_class c
             where c.relnamespace = 'public'::pg_catalog.regnamespace and c.relkind = 'r' and c.relrowsecurity
               and c.relname = 'studio_payment_jurisdiction_changes'), false)
    and coalesce((select count(*) = 6 from pg_catalog.pg_class c
             where c.relnamespace = 'public'::pg_catalog.regnamespace and c.relkind = 'r'
               and c.relname in ('studio_payment_jurisdictions', 'studio_payment_settings', 'stripe_account_provisioning_attempts',
                                 'studios', 'services', 'client_pricing')), false) as tables_present,
  coalesce(pg_catalog.to_regprocedure('public.studio_account_acceptable_for_jurisdiction(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text,pg_catalog.bool)') is not null
    and pg_catalog.to_regprocedure('public.studio_named_stripe_accounts(pg_catalog.uuid)') is not null, false) as helpers_ok,
  coalesce((select count(*) = 1 from pg_catalog.pg_proc p
             where p.oid = pg_catalog.to_regprocedure('public.initialize_studio_payment_jurisdiction_from_history(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.bool,pg_catalog.text[],pg_catalog.uuid[])')
               and p.prosecdef
               and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')), false) as v1_ok,
  coalesce((select count(*) = 7 from information_schema.columns k
             where k.table_schema = 'public' and k.table_name = 'stripe_account_provisioning_attempts'
               and k.column_name in ('id', 'studio_id', 'status', 'terminal_at', 'processing_claim_token', 'stripe_account_id', 'stripe_livemode')), false) as attempt_columns_ok,
  (not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'initialize_studio_payment_jurisdiction_from_history_v2')
    and not exists (select 1 from information_schema.columns k
                     where k.table_schema = 'public' and k.table_name = 'studio_payment_jurisdiction_changes'
                       and k.column_name in ('failed_attempts_acknowledged', 'failed_attempts_evidence'))
    and not exists (select 1 from pg_catalog.pg_constraint x
                     where x.conrelid = 'public.studio_payment_jurisdiction_changes'::pg_catalog.regclass
                       and x.conname = 'studio_payment_jurisdiction_changes_failed_evidence_check')) as new_objects_absent
from chain_guard g;
