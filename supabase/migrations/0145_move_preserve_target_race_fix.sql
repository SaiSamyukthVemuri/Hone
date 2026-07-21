-- PR B Part 4 — remove the time-only move stale-target race (Item 1).
--
-- Defect: both the 0133 compatibility wrapper AND the internal move action read
-- the appointment's current practitioner BEFORE move_or_reassign_appointment
-- acquires the studios-row / advisory / appointment locks, then pass it back as
-- the target. A concurrent A->B reassignment between that read and the lock made
-- the target STALE, so an intended TIME-ONLY move could silently reassign the
-- appointment back to the stale practitioner.
--
-- Fix (Option B): a NULL p_target_practitioner_id now means "preserve the CURRENT
-- practitioner", resolved from the LOCKED appointment row inside the transaction.
-- A time-only move (wrapper or app) passes NULL and can NEVER change the
-- practitioner, even under a concurrent reassignment — the concurrent reassign
-- either commits first (this move then re-reads the new current under the lock,
-- still a no-reassign time move) or waits behind the advisory lock. An explicit
-- (non-NULL) target is still a reassignment. Final-target integrity (0144),
-- booking-pause, optimistic concurrency, duration-preservation and the shadow
-- GiST authority are all preserved. The old 6-column wrapper shape is unchanged.
--
-- Migration-first, additive, flag-OFF. Stacks on 0144 (0140/0141 = onboarding).
-- NOT hosted-applied. Service_role only.

begin;

create or replace function public.move_or_reassign_appointment(
  p_appointment_id        uuid,
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_target_practitioner_id uuid,
  p_expected_starts_at    timestamptz,
  p_expected_ends_at      timestamptz,
  p_new_starts_at         timestamptz
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

  -- Resolve the effective target from the LOCKED row: NULL = preserve current
  -- (a time-only move that can never reassign, even under a concurrent
  -- reassignment); a non-NULL value is an explicit target (reassignment).
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
      'new_practitioner_id', v_target
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

-- The wrapper no longer PRE-READS the current practitioner (that read was the
-- race). It delegates with a NULL target so move_or_reassign_appointment
-- resolves the current practitioner from the LOCKED row — a time-only move that
-- can never become a reassignment.
create or replace function public.practitioner_move_appointment(
  p_appointment_id uuid,
  p_studio_id uuid,
  p_practitioner_id uuid,
  p_expected_starts_at timestamptz,
  p_expected_ends_at timestamptz,
  p_new_starts_at timestamptz
) returns table (
  result text,
  appointment_id uuid,
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  new_starts_at timestamptz,
  new_ends_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return query
    select r.result, r.appointment_id, r.previous_starts_at, r.previous_ends_at,
           r.new_starts_at, r.new_ends_at
    from public.move_or_reassign_appointment(
      p_appointment_id, p_studio_id, p_practitioner_id,
      null,  -- NULL = preserve current, resolved from the LOCKED row (race-safe)
      p_expected_starts_at, p_expected_ends_at, p_new_starts_at
    ) r;
end;
$$;

revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;

commit;
