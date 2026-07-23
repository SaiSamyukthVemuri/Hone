-- PR B Part 4 — move final-target integrity (Item 1) + 0133 legacy wrapper (Item 3).
--
-- (A) 0143's move_or_reassign_appointment validated the target's activity +
--     eligibility ONLY on a reassignment (v_reassign). A TIME-ONLY move could
--     therefore commit a NEW interval while retaining a now-INACTIVE or now-
--     INELIGIBLE practitioner. This replaces the command so the RESULTING
--     practitioner (p_target_practitioner_id — the current practitioner for a
--     time-only move, the new one for a reassignment) is validated on EVERY
--     move when capacity is ON. A time-only move that would keep an invalid
--     practitioner returns 'practitioner_reassignment_required' (the owner must
--     move AND assign an active, eligible target atomically). No existing
--     appointment changes merely because activity/eligibility changed — only a
--     new mutation is gated. Service policy: a NULL service_id is not eligibility-
--     gated (legacy/serviceless rows); a present service is checked via
--     service_practitioners. Legacy (capacity OFF) keeps today's behaviour (no
--     per-practitioner target validation).
--
-- (B) The old time-only practitioner_move_appointment (0133) is redefined as a
--     COMPATIBILITY WRAPPER that resolves the appointment's current practitioner
--     and delegates to move_or_reassign_appointment (target = current). It thus
--     inherits studios-row/advisory locking, booking-pause enforcement, and the
--     final-target integrity checks, while preserving its old return shape for
--     an older app deployment during deploy skew. No app source calls it after
--     the new deploy; its removal is gated on retiring every pre-0143 deployment.
--
-- Migration-first, additive, flag-OFF. Stacks on 0143 (0140/0141 = onboarding).
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

  v_reassign  := p_target_practitioner_id is distinct from v_appt.practitioner_id;
  v_time_move := p_new_starts_at is distinct from v_appt.starts_at;

  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  -- A member may move ONLY their own appointment and may NOT reassign it. (A
  -- member whose own membership became inactive fails the active-actor check
  -- above and can no longer move anything.)
  if v_actor_role <> 'owner'
     and (v_appt.practitioner_id is distinct from p_actor_practitioner_id or v_reassign) then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  -- FINAL-TARGET integrity (capacity ON) — validated on EVERY move/reassign.
  if v_cap then
    if p_target_practitioner_id is null
       or not exists (
         select 1 from public.practitioners pr
          where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
       ) then
      -- On a reassignment the owner chose a bad new target; on a time-only move
      -- the CURRENT practitioner is no longer valid -> the owner must reassign.
      return query select
        case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_appt.service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = v_appt.service_id and sp.practitioner_id = p_target_practitioner_id
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
         practitioner_id = p_target_practitioner_id,
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
      'new_practitioner_id', p_target_practitioner_id
    )
  );

  return query select
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    v_appt.id, v_appt.starts_at, v_appt.ends_at, p_new_starts_at, v_new_ends,
    v_appt.practitioner_id, p_target_practitioner_id;
  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- (B) Legacy time-only RPC -> thin compatibility wrapper. p_practitioner_id was
-- the ACTOR; the target is the appointment's CURRENT practitioner (a time-only
-- move). Preserves the old 6-column return shape. New rejection codes
-- (booking_paused / practitioner_reassignment_required / not_eligible) pass
-- through and an older app maps them to its safe generic-failure default.
-- ---------------------------------------------------------------------------
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
declare
  v_current uuid;
begin
  select a.practitioner_id into v_current
    from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id;
  return query
    select r.result, r.appointment_id, r.previous_starts_at, r.previous_ends_at,
           r.new_starts_at, r.new_ends_at
    from public.move_or_reassign_appointment(
      p_appointment_id, p_studio_id, p_practitioner_id,
      coalesce(v_current, p_practitioner_id),  -- time-only move: target = current
      p_expected_starts_at, p_expected_ends_at, p_new_starts_at
    ) r;
end;
$$;

-- Both remain service_role only (grants unchanged from 0133/0143; reasserted).
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;

commit;
