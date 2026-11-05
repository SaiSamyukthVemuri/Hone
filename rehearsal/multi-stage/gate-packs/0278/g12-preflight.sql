-- ===========================================================================
-- G12 (0278 STAGE, PREPARATION ONLY / HELD): read-only PREFLIGHT for the six availability functions. One SELECT over pg_catalog,
-- supabase_migrations and COUNTS of public tables. No row data, no names, no ids, nothing written.
-- Sealed file sha256 4f10f79d4ca997f179c38fc267de037c0cdd209d068e8874a74e2edd7fbc2d9b.
--
-- EXPECTED PASS: at_hosted_0277 = 1 (chain guard), four_bodies_are_0150 = true (each of the four 0150 writers exists exactly once and its
--   md5(prosrc) equals the 0150 value; Insurance W-1), two_new_absent = true (authorize_schedule_writer and save_weekly_availability_as do not
--   exist: create or replace would silently replace a stray one), acl_four_service_role_only = true, helpers_present = true
--   (validate_schedule_scope, acquire_studio_capacity_lock, studio_capacity_enabled exist).
-- COUNTS (information, never a gate; no studio is named): studios_total, studios_capacity_off and nonowner_active_in_capacity_off
--   (Insurance W-2: in a capacity-off studio a practitioner can change nothing; these are the practitioners it affects).
-- STOP CONDITION: any boolean false.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0277' then 1 else 0 end) as at_hosted_0277
),
expected(proname, md5) as (
  values
    ('upsert_availability_day_locked', '231463a71331cfc9b71499b653101cbb'),
    ('delete_availability_day_locked', '9301b466f9f9a3b5935b8392c0a7c347'),
    ('upsert_availability_override_locked', '587f5ad0aaf8f5d722b805a68d03aa07'),
    ('delete_availability_override_locked', 'c90c24569a3a4f51add0840c2c511ea8')
),
state as (
  select e.proname, e.md5,
         (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::pg_catalog.regnamespace and p.proname = e.proname) as n,
         (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.pronamespace = 'public'::pg_catalog.regnamespace and p.proname = e.proname limit 1) as have,
         (select p.oid from pg_catalog.pg_proc p where p.pronamespace = 'public'::pg_catalog.regnamespace and p.proname = e.proname limit 1) as oid
    from expected e
)
select
  g.at_hosted_0277,
  (select bool_and(n = 1 and have = md5) from state) as four_bodies_are_0150,
  not exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'public'::pg_catalog.regnamespace
                and p.proname in ('authorize_schedule_writer', 'save_weekly_availability_as')) as two_new_absent,
  (select bool_and(not pg_catalog.has_function_privilege('anon', oid, 'execute')
                   and not pg_catalog.has_function_privilege('authenticated', oid, 'execute')
                   and pg_catalog.has_function_privilege('service_role', oid, 'execute')) from state) as acl_four_service_role_only,
  (select count(distinct p.proname) = 3 from pg_catalog.pg_proc p where p.pronamespace = 'public'::pg_catalog.regnamespace
     and p.proname in ('validate_schedule_scope', 'acquire_studio_capacity_lock', 'studio_capacity_enabled')) as helpers_present,
  (select count(*) from public.studios) as studios_total,
  (select count(*) from public.studios s where s.practitioner_capacity_enabled is not true) as studios_capacity_off,
  (select count(*) from public.practitioners p join public.studios s on s.id = p.studio_id
    where p.active and p.role is distinct from 'owner' and s.practitioner_capacity_enabled is not true) as nonowner_active_in_capacity_off
from chain_guard g;
