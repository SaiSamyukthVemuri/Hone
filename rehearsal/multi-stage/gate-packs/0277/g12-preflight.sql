-- ===========================================================================
-- G12 (0277 STAGE, PREPARATION ONLY / HELD): read-only PREFLIGHT for mark_appointment_complete. One SELECT over pg_catalog,
-- supabase_migrations and COUNTS of public tables. No row data, no names, no ids, nothing written.
-- RUN ONLY VIA the reviewed read-only runner. Sealed file sha256 e0f406a09c0e5561d317e9f662575bd149f8da821ecc21038706238fd671b60b.
--
-- EXPECTED PASS (booleans): at_hosted_0274 = 1 (chain guard: division by zero unless the hosted max is 0274; a different max is a STOP),
--   single_overload = true, body_is_0175 = true (md5(prosrc) = 596d2ddeb311ae0ee66fb77c3887ba31, the 0175 body: hosted equals the repository; Insurance Q-2),
--   definer_pinned_path = true, acl_service_role_only = true (anon and authenticated cannot execute, service_role can).
--   dual_role_overlap = 0 (Privacy C4; S0 was 0).
-- COUNTS (information for Sam, never a gate; no studio is named; nothing is changed): studios_total (plan: 8), studios_capacity_off,
--   open_total / open_future / open_past_unfinished, and the "check the practitioner" groups (a) NULL assignee, (b) owner-assigned in a
--   multi-practitioner studio, (c) booker-assigned where a linked session was performed by someone else, their union (check_any, split
--   future and past-unfinished) and how many of those sit in capacity-off studios. These are the appointments the owner must review
--   BEFORE 0277 is applied (Sam: existing assignments are never changed until the owner explicitly confirms a correction).
--   STARTED split (option A): started_a_null_assignee, started_b_owner_assigned_multi_practitioner, started_c_booker_assigned_session_differs and
--   started_any_in_capacity_off, for started/past-unfinished confirmed appointments only. The owner completes these; counts for Sam, never a gate.
-- STOP CONDITION: any boolean false, or dual_role_overlap <> 0.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0274' then 1 else 0 end) as at_hosted_0274
),
fn as (
  select p.* from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::pg_catalog.regnamespace and p.proname = 'mark_appointment_complete'
),
-- Impact review (Sam 1 Nov): still-OPEN appointments only (confirmed: future, or started and unfinished). Completed, cancelled and
-- no-show history is out of scope. Counts only; nothing here changes an assignment. A row is flagged when the assignee MAY be wrong:
--   (a) no practitioner; (b) assigned to an active OWNER in a studio with more than one active practitioner;
--   (c) assigned to the practitioner who BOOKED it (created_by_practitioner_id) while a linked session was performed by someone else.
open_appts as (
  select a.id, a.studio_id, a.practitioner_id, a.starts_at,
         coalesce(s.practitioner_capacity_enabled, false) = false as capacity_off,
         (a.practitioner_id is not null
            and exists (select 1 from public.practitioners o where o.id = a.practitioner_id and o.role = 'owner' and o.active)
            and (select count(*) from public.practitioners x where x.studio_id = a.studio_id and x.active) > 1) as owner_default,
         (a.practitioner_id is not null and a.created_by_practitioner_id = a.practitioner_id
            and exists (select 1 from public.sessions se
                         where se.appointment_id = a.id and se.performed_by_practitioner_id is not null
                           and se.performed_by_practitioner_id <> a.practitioner_id)) as booker_session_differs
    from public.appointments a
    join public.studios s on s.id = a.studio_id
   where a.status = 'confirmed'
)
select
  g.at_hosted_0274,
  (select count(*) from fn) = 1 as single_overload,
  coalesce((select pg_catalog.md5(prosrc) = '596d2ddeb311ae0ee66fb77c3887ba31' from fn), false) as body_is_0175,
  coalesce((select prosecdef and exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c = 'search_path=pg_catalog, pg_temp') from fn), false) as definer_pinned_path,
  coalesce((select not pg_catalog.has_function_privilege('anon', oid, 'execute')
              and not pg_catalog.has_function_privilege('authenticated', oid, 'execute')
              and pg_catalog.has_function_privilege('service_role', oid, 'execute') from fn), false) as acl_service_role_only,
  (select count(*) from public.studio_receptionists r
    where r.active and r.user_id is not null
      and exists (select 1 from public.practitioners p where p.user_id = r.user_id and p.active)) as dual_role_overlap,
  (select count(*) from public.studios) as studios_total,
  (select count(*) from public.studios s where s.practitioner_capacity_enabled is not true) as studios_capacity_off,
  (select count(*) from open_appts) as open_total,
  (select count(*) from open_appts where starts_at > now()) as open_future,
  (select count(*) from open_appts where starts_at <= now()) as open_past_unfinished,
  (select count(*) from open_appts where practitioner_id is null) as check_a_null_assignee,
  (select count(*) from open_appts where owner_default) as check_b_owner_assigned_multi_practitioner,
  (select count(*) from open_appts where booker_session_differs) as check_c_booker_assigned_session_differs,
  (select count(*) from open_appts where practitioner_id is null or owner_default or booker_session_differs) as check_any,
  (select count(*) from open_appts where (practitioner_id is null or owner_default or booker_session_differs) and starts_at > now()) as check_any_future,
  (select count(*) from open_appts where (practitioner_id is null or owner_default or booker_session_differs) and starts_at <= now()) as check_any_past_unfinished,
  (select count(*) from open_appts where (practitioner_id is null or owner_default or booker_session_differs) and capacity_off) as check_any_in_capacity_off,
  -- Sam, option A (1 Nov): STARTED / past-unfinished appointments (starts_at <= now(), still confirmed) whose assignment may be wrong. The owner
  -- completes these; no command reassigns them. COUNTS ONLY, reported to Sam with this package; nothing is reassigned or backfilled.
  (select count(*) from open_appts where starts_at <= now() and practitioner_id is null) as started_a_null_assignee,
  (select count(*) from open_appts where starts_at <= now() and owner_default) as started_b_owner_assigned_multi_practitioner,
  (select count(*) from open_appts where starts_at <= now() and booker_session_differs) as started_c_booker_assigned_session_differs,
  (select count(*) from open_appts where starts_at <= now() and capacity_off and (practitioner_id is null or owner_default or booker_session_differs)) as started_any_in_capacity_off
from chain_guard g;
