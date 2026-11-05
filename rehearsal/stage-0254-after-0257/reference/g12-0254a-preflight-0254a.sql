-- ===========================================================================
-- G12 (0254-AFTER-0257 ONLINE STAGE, PREPARATION ONLY / HELD): a read-only DRY RUN of what the sealed 0254 needs to already exist (and not exist) at hosted 0257.
-- The sealed 0254 uses plain CREATE FUNCTION for three objects, CREATE OR REPLACE for two, and calls six existing helpers; any mismatch
-- would make the transaction abort (atomically, nothing applied) or replace the wrong function. One SELECT over pg_catalog and
-- supabase_migrations; no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh g12-0254a-preflight-0254a.sql
--
-- EXPECTED PASS (every column):
--   at_hosted_0257        = 1     (chain guard: division by zero unless the hosted history max is 0257)
--   tables_present        = true  (the five tables 0254 changes policies on all exist, and RLS is enabled on each)
--   helpers_ok            = true  (is_studio_owner(uuid) and the helpers the two replaced commands call exist)
--   replaced_ok           = true  (set_session_price and record_appointment_settlement exist exactly once as definers with a pinned search_path)
--   new_objects_absent    = true  (edit_client_pinned_note, audit_pinned_note_delete, audit_client_pricing_change and both triggers do not exist yet)
--   columns_ok            = true  (client_pinned_notes.created_by_practitioner_id, audit_logs.actor_id/metadata exist)
-- STOP CONDITION: any column differs. 0254 is predicted to refuse or to replace the wrong thing.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0257'
                   then 1 else 0 end) as at_hosted_0257
)
select
  g.at_hosted_0257,
  coalesce((select count(*) = 5 from pg_catalog.pg_class c
             where c.relnamespace = 'public'::pg_catalog.regnamespace and c.relkind = 'r' and c.relrowsecurity
               and c.relname in ('payment_charge_attempts', 'manual_fee_charge_attempts', 'appointment_settlements',
                                 'client_pricing', 'client_pinned_notes')), false) as tables_present,
  coalesce(pg_catalog.to_regprocedure('public.is_studio_owner(pg_catalog.uuid)') is not null
    and pg_catalog.to_regprocedure('public.assert_session_writable(pg_catalog.uuid,pg_catalog.uuid)') is not null
    and pg_catalog.to_regprocedure('public.session_actor_practitioner(pg_catalog.uuid)') is not null
    and pg_catalog.to_regprocedure('public.appointment_settlement_lock_key(pg_catalog.uuid)') is not null
    and pg_catalog.to_regprocedure('public.appointment_has_live_card_money(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.bool)') is not null
    and pg_catalog.to_regprocedure('public.appointment_quoted_amount_cents(pg_catalog.uuid,pg_catalog.uuid)') is not null
    and pg_catalog.to_regprocedure('public.retire_ready_card_attempts(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid)') is not null,
    false) as helpers_ok,
  coalesce((select count(*) = 2 from pg_catalog.pg_proc p
             where p.oid in (pg_catalog.to_regprocedure('public.set_session_price(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int4)'),
                             pg_catalog.to_regprocedure('public.record_appointment_settlement(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.int4,pg_catalog.text,pg_catalog.bool)'))
               and p.prosecdef
               and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')), false) as replaced_ok,
  (pg_catalog.to_regprocedure('public.edit_client_pinned_note(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text)') is null
    and pg_catalog.to_regprocedure('public.audit_pinned_note_delete()') is null
    and pg_catalog.to_regprocedure('public.audit_client_pricing_change()') is null
    and not exists (select 1 from pg_catalog.pg_trigger t
                     where not t.tgisinternal and t.tgname in ('client_pinned_notes_audit_delete_trg', 'client_pricing_audit_trg'))) as new_objects_absent,
  coalesce((select count(*) = 3 from information_schema.columns k
             where k.table_schema = 'public'
               and ((k.table_name = 'client_pinned_notes' and k.column_name = 'created_by_practitioner_id')
                 or (k.table_name = 'audit_logs' and k.column_name in ('actor_id', 'metadata')))), false) as columns_ok
from chain_guard g;
