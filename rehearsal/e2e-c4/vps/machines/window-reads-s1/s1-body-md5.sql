-- ===========================================================================
-- S1 READ-BACK (window-s1read.sh): md5(prosrc) of the functions the S1 migrations REPLACE
-- (0227 claim_email_provider_events / process_email_provider_event, 0228 create_public_appointment_for_new_client,
-- 0236 owner_delivery_incidents, 0241 start_session). One SELECT over pg_catalog only. No writes, no table data.
-- The name list is EXACTLY baseline BASELINE-W1-MACOS-CANDIDATE-3.json (efc94a51...) s1.body_md5; window-s1read.sh
-- refuses if the two ever differ. Only a hash of each function body leaves the database, never the body.
-- start_session has TWO overloads at 0246 (the 4-argument wrapper and the 5-argument command that 0241 replaces): the
-- baseline md5 44e7cf6e... is the 5-argument one (proved on a synthetic database built from the d189768b chain), so only
-- that overload is read. Every other name has one overload. window-s1read.sh needs exactly one row per name and refuses an
-- ambiguous one. args is the identity argument list.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-body-md5.sql (window-s1read.sh does this)
-- Chain guard: an error "division by zero" means history max is not 0246: stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
)
select
  g.at_hosted_0246,
  p.proname as fn,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
  pg_catalog.md5(p.prosrc) as body_md5
from chain_guard g
cross join pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('claim_email_provider_events', 'process_email_provider_event', 'create_public_appointment_for_new_client', 'owner_delivery_incidents', 'start_session')
  and (p.proname <> 'start_session'
       or pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_client_id uuid, p_modality text, p_appointment_id uuid, p_coalesce_minutes integer, p_studio_id uuid')
order by p.proname, args;
