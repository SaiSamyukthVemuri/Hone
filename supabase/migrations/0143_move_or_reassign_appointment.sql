-- PR B Part 4 — atomic MOVE + REASSIGNMENT command (Item 5).
--
-- One SAME-RECORD transaction that can change an appointment's TIME, its
-- PRACTITIONER, or BOTH, preserving the appointment id and every relationship.
-- Supersedes the time-only practitioner_move_appointment (0133) for the internal
-- move surface: it adds practitioner reassignment, takes the shared studio
-- capacity advisory lock (0138 order: studios-row -> advisory), and enforces the
-- per-practitioner authorization + eligibility + booking-pause contract.
--
-- Authorization (parameter-based; the server action resolves actor + studio
-- server-side, never from the browser):
--   * owner may move/reassign any confirmed future appointment to any ACTIVE,
--     same-studio, service-ELIGIBLE practitioner;
--   * a member may move ONLY an appointment assigned to themselves, and may NOT
--     reassign it (target must stay themselves);
--   * cross-studio / inactive / ineligible targets are rejected.
--
-- Duration is PRESERVED from the locked appointment row (a move/reassign never
-- changes the length); buffer_minutes_snapshot / blocked_ends_at / the shadow
-- reservation re-key are trigger-owned. The per-resource shadow GiST exclusion
-- remains the FINAL race authority (23P01 -> full rollback, no partial move, no
-- orphan audit row). Optimistic concurrency (expected start/end) makes two
-- concurrent moves from the same snapshot mutually exclusive.
--
-- Booking-pause policy: while capacity is ON but booking is PAUSED, any operation
-- that commits a NEW occupied interval or a NEW target is rejected (a stricter,
-- safe default). Cancellation and non-capacity admin changes are out of scope
-- here and unaffected.
--
-- Migration-first, additive, flag-OFF. Stacks on 0142 (0140/0141 = onboarding).
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
  -- 3-4. Lock the studios ROW first (studios-row -> advisory order), read flags,
  --      then take the shared capacity advisory lock.
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

  -- 1-2. Lock the appointment (id + studio; a foreign/missing row is
  --      indistinguishable -> appointment_not_found, no cross-studio leak).
  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;

  -- 6. Movable iff confirmed AND the ORIGINAL start is still in the future.
  if v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now then
    return query select 'appointment_not_movable'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  -- Optimistic concurrency: BOTH stored endpoints must still match the caller's
  -- snapshot; any drift -> stale_appointment (mutually excludes concurrent moves).
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

  -- 5. Actor authority.
  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  -- A member may move ONLY their own appointment and may NOT reassign it.
  if v_actor_role <> 'owner'
     and (v_appt.practitioner_id is distinct from p_actor_practitioner_id or v_reassign) then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  -- 7-8. Target practitioner (only meaningful on reassign): same studio + active,
  --      and (capacity ON) eligible for THIS appointment's service.
  if v_reassign then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return query select 'invalid_practitioner'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_cap and v_appt.service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = v_appt.service_id and sp.practitioner_id = p_target_practitioner_id
    ) then
      return query select 'not_eligible'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
  end if;

  -- 12. No-op guard.
  if not v_time_move and not v_reassign then
    return query select 'no_change'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      v_appt.starts_at, v_appt.ends_at, v_appt.practitioner_id, v_appt.practitioner_id;
    return;
  end if;

  -- Booking-pause: reject any op that commits a NEW occupied interval or target.
  if v_cap and not v_book then
    return query select 'booking_paused'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  -- Preserve duration from the locked row; compute the authoritative new end.
  v_new_ends := p_new_starts_at + make_interval(mins => v_appt.duration_minutes);

  -- 11. Update ONLY time + practitioner on the SAME row. The buffer-snapshot
  --     (BEFORE) + reservation re-key/orphan-cleanup (AFTER) + sync-version-bump
  --     triggers own everything else. A GiST 23P01 is NOT caught -> the whole
  --     transaction (incl. the audit row) rolls back: no partial reassignment.
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

revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;

commit;
