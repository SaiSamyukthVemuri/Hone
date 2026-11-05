-- GATE PACK 0274 (PRE-APPLY preflight). Read-only catalog SELECT, no writes, no table data.
-- EXPECTED PASS: at_hosted___BEFORE_MAX__ = 1 and every other column true. STOP CONDITION: any column differs.
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '__BEFORE_MAX__' then 1 else 0 end) as at_hosted___BEFORE_MAX__
)
select g.at_hosted___BEFORE_MAX__,
  coalesce((pg_catalog.to_regclass('public.client_legal_identities') is not null and pg_catalog.to_regclass('public.studio_legal_name_access') is not null and pg_catalog.to_regclass('public.client_legal_name_access_audit') is not null), false) as s1_tables_present,
  coalesce((pg_catalog.to_regprocedure('public.is_studio_member(pg_catalog.uuid)') is not null and pg_catalog.to_regprocedure('public.can_read_client_legal_identity(pg_catalog.uuid)') is not null and pg_catalog.to_regprocedure('public.receptionist_client_contacts_v2(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4)') is not null), false) as s1_functions_present,
  coalesce((pg_catalog.to_regprocedure('public.receptionist_client_directory(pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text, pg_catalog.int4, pg_catalog.int4)') is null and pg_catalog.to_regprocedure('public.receptionist_calendar_v2(pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz)') is null and pg_catalog.to_regprocedure('public.receptionist_studio_timezone(pg_catalog.uuid)') is null), false) as new_functions_absent,
  coalesce((select md5(p.prosrc) = '7a9e1da714f28081850b5913f2ad0263' and pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.receptionist_calendar(pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz)')), false) as calendar_as_0266_left_it
from chain_guard g;
