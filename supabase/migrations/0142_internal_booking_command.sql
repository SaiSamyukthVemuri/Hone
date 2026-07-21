-- PR B Part 4 — canonical atomic INTERNAL booking command.
--
-- Replaces the direct `appointments` INSERT in bookAppointmentForClientAction
-- (which self-assigned the authenticated practitioner, took no capacity lock,
-- ignored the booking-acceptance flag, and was a multi-write with a TOCTOU
-- window closed only by the exclusion constraint) with ONE reviewed SECURITY
-- DEFINER transaction. Authorization is PARAMETER-based (like 0133
-- practitioner_move_appointment): the server action resolves the actor + studio
-- server-side; nothing here is trusted from the browser.
--
-- State contract (studios.practitioner_capacity_enabled = cap,
-- practitioner_capacity_booking_enabled = book):
--   Legacy (cap=false): today's behaviour exactly — the action passes
--     target = actor, eligibility is not enforced, resource_key = studio_id, the
--     studio-wide exclusion is the collision authority. Neutral + invisible.
--   Capacity-ready / booking-PAUSED (cap=true, book=false): reject creation.
--   Live (cap=true, book=true): practitioner-aware booking under the rules.
--
-- Lock order matches 0138 retirement / timezone-rebuild: the studios ROW is
-- FOR UPDATE-locked FIRST, then the studio-capacity advisory lock — so booking,
-- reassignment, retirement and the tz rebuild never deadlock.
--
-- The appointment INSERT mirrors to studio_calendar_reservations via the 0134
-- trigger, keyed by resource_key = practitioner_id (cap ON) / studio_id (OFF);
-- the per-resource GiST exclusion is the FINAL race-safe authority. A 23P01 is
-- NOT caught — it rolls the whole transaction back and reaches the server
-- adapter for safe "slot taken" mapping (no appointment, no audit row).
--
-- Migration-first, additive, flag-OFF. 0140 belongs to the SEPARATE onboarding
-- branch; this stacks on 0139 and does NOT depend on 0140. NOT hosted-applied.

begin;

create or replace function public.create_internal_appointment(
  p_studio_id               uuid,
  p_actor_practitioner_id   uuid,
  p_target_practitioner_id  uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_duration_minutes        integer,
  p_cancellation_token_hash text,
  p_notes                   text default null
) returns table (
  result         text,
  appointment_id uuid,
  starts_at      timestamptz,
  ends_at        timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cap        boolean;
  v_book       boolean;
  v_actor_role text;
  v_ends_at    timestamptz;
  v_appt_id    uuid;
  v_now        timestamptz := now();
begin
  -- 1-3. Lock the studios ROW first (order: studios-row -> advisory), confirm
  --       the studio exists, then take the shared capacity advisory lock so this
  --       command serializes with retirement / other capacity mutations.
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  -- 4. Booking-acceptance gate. Capacity ON but booking OFF = paused/draining:
  --    reject NEW creation (existing appointments remain accessible elsewhere).
  --    A browser user cannot bypass this by calling a legacy path — the legacy
  --    action now routes through this command too.
  if v_cap and not v_book then
    return query select 'booking_paused'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 5. Actor authority: the acting practitioner must be ACTIVE + in this studio.
  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id
     and pr.studio_id = p_studio_id
     and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A non-owner (member) may book ONLY for themselves; only an owner may assign
  -- an appointment to another practitioner.
  if v_actor_role <> 'owner'
     and p_target_practitioner_id is distinct from p_actor_practitioner_id then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 6. Target practitioner: same studio + active. (No composite FK exists on
  --    appointments.practitioner_id, so same-studio is enforced HERE — a
  --    cross-studio target id can never be assigned.)
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_target_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active = true
  ) then
    return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 7. Client + service must belong to the SAME studio; service must be active.
  if not exists (
    select 1 from public.clients c
     where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if not exists (
    select 1 from public.services sv
     where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true
  ) then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 6b. Service eligibility — enforced only when capacity is ON (Legacy studios
  --     have no per-practitioner eligibility; service_practitioners is the source
  --     of truth). An ineligible target can never be assigned.
  if v_cap and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id
       and sp.practitioner_id = p_target_practitioner_id
  ) then
    return query select 'not_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 8. Server-computed interval. Never trust a caller-supplied end. Reject past
  --    starts + non-positive durations.
  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then
    return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => p_duration_minutes);

  -- 11-12. Insert the appointment. buffer_minutes_snapshot / blocked_ends_at /
  --        capacity_enabled are trigger-owned; the mirror trigger keys the shadow
  --        reservation by resource_key and the per-resource GiST exclusion is the
  --        final race authority. A 23P01 here is NOT caught -> full rollback.
  insert into public.appointments
    (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
     duration_minutes, status, notes, cancellation_token_hash)
  values
    (p_studio_id, p_target_practitioner_id, p_client_id, p_service_id, p_starts_at, v_ends_at,
     p_duration_minutes, 'confirmed', p_notes, p_cancellation_token_hash)
  returning id into v_appt_id;

  -- One atomic audit row (PHI-free). An audit-insert failure rolls back the
  -- appointment in the same transaction (fixes the old orphaned-appointment gap).
  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt_id, 'practitioner', p_actor_practitioner_id, 'created',
    jsonb_build_object(
      'source', 'internal_booking_command',
      'target_practitioner_id', p_target_practitioner_id
    )
  );

  return query select 'created'::text, v_appt_id, p_starts_at, v_ends_at;
  return;
end;
$$;

-- Service_role only — the server action calls it via the admin client. Browser
-- roles can never invoke it (they also cannot read another practitioner's
-- reservation metadata through it).
revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from public;
revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from anon;
revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from authenticated;
grant execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) to service_role;

commit;
