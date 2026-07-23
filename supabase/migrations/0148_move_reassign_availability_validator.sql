-- PR B Part 4 — wire the shared availability validator into move/reassign (Item 4).
--
-- move_or_reassign_appointment (0143/0144/0145) enforced final-target membership +
-- eligibility and delegated interval collisions to the per-resource GiST, but it
-- never checked whether the final practitioner is actually WORKING at the
-- resulting interval. A move onto a closed day / outside the practitioner's hours
-- committed silently. This routes every capacity-ON move through
-- validate_appointment_availability on the FINAL target + resulting interval, so
-- date overrides, weekly fallback, blockouts, activity, eligibility and booking
-- pause all apply. The per-resource GiST exclusion stays the FINAL interval
-- authority (23P01 → rollback).
--
-- A new p_allow_outside_availability boolean (default false, 8th arg) lets a
-- trusted OWNER server adapter move outside the working-hour windows ONLY. It is
-- re-authorized here against the SERVER-RESOLVED actor role, so a member can never
-- forge it, and it bypasses NOTHING else — blockouts, timed blocks, recurring
-- breaks, appointments, buffers, inactivity, ineligibility and booking pause all
-- still apply. Legacy (capacity OFF) is unchanged: the validator returns 'ok'.
--
-- Deployment compatibility: the old 7-arg call sites (the 0133/0145 wrapper and
-- the move action) resolve to this 8-arg definition via the default, so no stale
-- caller breaks. The wrapper's NULL-target preserve-current semantics are intact.
--
-- Migration-first, additive, flag-OFF. Stacks on 0147. NOT hosted-applied.
-- Service_role only.

begin;

-- Replace the 7-arg signature with an 8-arg one (added trailing default). Drop
-- first because adding a defaulted parameter is a NEW signature, not a REPLACE.
drop function if exists public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz);

create function public.move_or_reassign_appointment(
  p_appointment_id         uuid,
  p_studio_id              uuid,
  p_actor_practitioner_id  uuid,
  p_target_practitioner_id uuid,
  p_expected_starts_at     timestamptz,
  p_expected_ends_at       timestamptz,
  p_new_starts_at          timestamptz,
  p_allow_outside_availability boolean default false
) returns table (
  result                   text,
  appointment_id           uuid,
  previous_starts_at       timestamptz,
  previous_ends_at         timestamptz,
  new_starts_at            timestamptz,
  new_ends_at              timestamptz,
  previous_practitioner_id uuid,
  new_practitioner_id      uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cap        boolean;
  v_book       boolean;
  v_actor_role text;
  v_appt       public.appointments%rowtype;
  v_target     uuid;
  v_new_ends   timestamptz;
  v_reassign   boolean;
  v_time_move  boolean;
  v_avail      text;
  v_now        timestamptz := now();
begin
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;

  -- NULL target = preserve current (resolved from the LOCKED row, race-safe);
  -- non-NULL = explicit reassignment target.
  v_target := coalesce(p_target_practitioner_id, v_appt.practitioner_id);

  if v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now then
    return query select 'appointment_not_movable'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if v_appt.starts_at is distinct from p_expected_starts_at
     or v_appt.ends_at is distinct from p_expected_ends_at then
    return query select 'stale_appointment'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if p_new_starts_at is null or p_new_starts_at <= v_now then
    return query select 'invalid_time'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_reassign  := v_target is distinct from v_appt.practitioner_id;
  v_time_move := p_new_starts_at is distinct from v_appt.starts_at;

  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  if v_actor_role <> 'owner'
     and (v_appt.practitioner_id is distinct from p_actor_practitioner_id or v_reassign) then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  -- The outside-availability bypass is OWNER-ONLY, re-authorized on the
  -- server-resolved role — a member can never forge it.
  if p_allow_outside_availability and v_actor_role <> 'owner' then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  -- Final-target integrity (capacity ON) — validated on EVERY move on the
  -- resolved target (current practitioner for a time-only move).
  if v_cap then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = v_target and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return query select
        case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_appt.service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = v_appt.service_id and sp.practitioner_id = v_target
    ) then
      return query select
        case when v_reassign then 'not_eligible' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
  end if;

  if not v_time_move and not v_reassign then
    return query select 'no_change'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      v_appt.starts_at, v_appt.ends_at, v_appt.practitioner_id, v_appt.practitioner_id;
    return;
  end if;

  if v_cap and not v_book then
    return query select 'booking_paused'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_new_ends := p_new_starts_at + make_interval(mins => v_appt.duration_minutes);

  -- Shared availability authority on the FINAL target + resulting interval
  -- (Legacy => 'ok'). Membership/eligibility already passed above, so at this
  -- point only a working-hours / blockout code can come back. The owner override
  -- bypasses ONLY the working-hours window; blockouts + the GiST collision
  -- authority below still hold.
  v_avail := public.validate_appointment_availability(
    p_studio_id, v_target, v_appt.service_id,
    p_new_starts_at, v_new_ends, v_appt.id, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  update public.appointments
     set starts_at       = p_new_starts_at,
         ends_at         = v_new_ends,
         practitioner_id = v_target,
         updated_at      = v_now
   where id = v_appt.id and studio_id = p_studio_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt.id, 'practitioner', p_actor_practitioner_id,
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    jsonb_build_object(
      'source', 'internal_move_reassign_command',
      'previous_starts_at', v_appt.starts_at,
      'previous_ends_at', v_appt.ends_at,
      'new_starts_at', p_new_starts_at,
      'new_ends_at', v_new_ends,
      'previous_practitioner_id', v_appt.practitioner_id,
      'new_practitioner_id', v_target,
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    v_appt.id, v_appt.starts_at, v_appt.ends_at, p_new_starts_at, v_new_ends,
    v_appt.practitioner_id, v_target;
  return;
end;
$$;

revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from public;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from anon;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from authenticated;
grant execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) to service_role;

commit;
