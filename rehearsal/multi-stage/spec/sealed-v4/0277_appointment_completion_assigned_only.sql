-- 0277: appointment COMPLETION is assigned-only for a non-owner (HON-44, Sam decision 3, 2026-11-01).
-- Reserved to Team (01-ops/MIGRATION-RESERVATIONS.md). HELD, PREPARE-ONLY: never applied without
-- Sam's per-change approval. Draft; Privacy SQL review, then Insurance, come first.
--
-- RULE. An owner may complete any appointment in their studio. A practitioner may complete ONLY an
-- appointment assigned to them (appointments.practitioner_id = the caller). An UNASSIGNED
-- appointment is owner-only. A receptionist is not a practitioners row, so it already has no path.
-- Completion never implies payment: nothing here reads or writes a settlement, charge or price.
--
-- WHAT CHANGES. Only public.mark_appointment_complete(uuid, uuid, uuid) (0032, redefined by 0175).
-- Its body below is 0175's, line for line, with ONE addition: the actor's role is read with the
-- active-member check, the appointment's practitioner_id is read under the same FOR UPDATE, and a
-- non-owner who is not the assignee is refused (42501) before any status or time check, so the
-- refusal does not depend on the appointment's state. The temporal gate (starts_at, inclusive),
-- the 'confirmed' requirement, the lifecycle-only update and the 'marked_complete' audit row are
-- unchanged. It is the ONLY database route to 'completed' (0174 revoked the direct lifecycle writes).
--
-- WHO CALLS IT. service_role only, from the app's completion action and the session-start
-- auto-complete (both gated in the app by lib/appointments/completion-authority.ts). This is the
-- database half so a raw service-role call meets the same refusal.
--
-- GRANTS. EXECUTE is revoked BY NAME from public, anon, authenticated and service_role, then
-- granted back to service_role alone. (Supabase's default privileges re-grant to all three at
-- create time; a bare CREATE OR REPLACE keeps the old ACL, so the revoke + grant-back is explicit
-- and the closing block proves it.)
--
-- DEPENDENCY ORDER. App PR (the app gate) first or alone is safe against the current database. This
-- migration alone is safe with the current app: a refusal surfaces as the action's existing
-- generic "Could not mark this appointment complete." Either order works; neither needs the other
-- to be applied. Requires nothing above 0257 (hosted max).
--
-- ROLLBACK. Re-apply 0175's definition of mark_appointment_complete (the CREATE OR REPLACE in
-- 0175 Group A) and the same revoke/grant-back. No data was changed, so there is nothing to undo
-- in rows. Dropping the added check restores "any active member may complete any confirmed,
-- started appointment".

begin;

set local lock_timeout = '5s';

create or replace function public.mark_appointment_complete(
  p_appointment_id  uuid,
  p_studio_id       uuid,
  p_practitioner_id uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_starts_at timestamptz;
  v_role text;
  v_assigned uuid;
begin
  select p.role into v_role
    from public.practitioners p
   where p.id = p_practitioner_id and p.studio_id = p_studio_id and p.active = true;
  if v_role is null then
    raise exception 'practitioner is not an active member of this studio'
      using errcode = '42501';
  end if;

  select a.status, a.starts_at, a.practitioner_id into v_status, v_starts_at, v_assigned
  from public.appointments a
  where a.id = p_appointment_id and a.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;

  -- 0277: a non-owner completes only an appointment assigned to them. An unassigned appointment
  -- (null) is never "assigned to" the caller, so it is owner-only.
  if v_role is distinct from 'owner' and v_assigned is distinct from p_practitioner_id then
    raise exception 'appointment is not assigned to this practitioner'
      using errcode = '42501';
  end if;

  if v_status <> 'confirmed' then
    raise exception 'appointment is not confirmed (current: %)', v_status using errcode = 'P0002';
  end if;
  -- B6: the visit must have STARTED. It need not have ended — the practitioner
  -- is the authority on whether treatment finished.
  if v_starts_at > now() then
    raise exception 'appointment has not started yet' using errcode = 'P0002';
  end if;

  -- Lifecycle only. No interval, buffer or reservation column is written here,
  -- so the booked capacity survives the completion untouched.
  update public.appointments a
     set status = 'completed', updated_at = now()
   where a.id = p_appointment_id and a.studio_id = p_studio_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'marked_complete',
    jsonb_build_object('marked_at', now())
  );
end;
$$;

revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid) from public;
revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid) from anon;
revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid) from authenticated;
revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid) from service_role;
grant execute on function public.mark_appointment_complete(uuid, uuid, uuid) to service_role;

-- Closing assertions: the privileges are exactly service_role-only, and the function still pins its search_path.
do $$
begin
  if has_function_privilege('anon', 'public.mark_appointment_complete(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.mark_appointment_complete(uuid, uuid, uuid)', 'execute') then
    raise exception '0277: mark_appointment_complete must not be executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.mark_appointment_complete(uuid, uuid, uuid)', 'execute') then
    raise exception '0277: mark_appointment_complete must stay executable by service_role';
  end if;
end $$;

commit;
