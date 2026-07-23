-- PR B Part 4 — authoritative in-DB duration (Item 2) + one shared, target-aware
-- availability validator (Item 3).
--
-- Item 2 — the 0142 create_internal_appointment trusts a caller-supplied
--   p_duration_minutes. A forged POST could book any length. The v2 command below
--   derives the duration from the LOCKED, revalidated service row inside the
--   transaction. An OWNER-only explicit override (15..360, multiple of 15) is the
--   single sanctioned way to book a non-default length; a member cannot forge it
--   (the command re-checks the SERVER-RESOLVED actor role), and it never bypasses
--   collision / block / break / blockout / booking-pause rules.
--
-- Item 3 — validate_appointment_availability is the ONE shared, target-aware
--   schedule-window authority. It enforces the dimension the per-resource GiST
--   exclusion CANNOT see: is the FINAL practitioner actually working at that local
--   time? It checks active same-studio membership, service eligibility, full-day
--   blockouts, and the practitioner's own working-hours window (date override wins
--   over weekly default; a practitioner-specific row wins over the studio-wide
--   NULL row; studio timezone). The OWNER outside-availability override bypasses
--   ONLY the weekly/date working-hour windows — never membership, eligibility,
--   blockouts, or (below) the collision authority.
--
--   Interval collisions — appointments+buffers, timed blocks, recurring breaks,
--   and the full-day-blockout interval — are DELEGATED to the per-resource GiST
--   exclusion on studio_calendar_reservations (0134), which is the FINAL
--   race-safe authority (a 23P01 rolls the whole transaction back → "slot taken").
--   The validator does NOT duplicate that buffer/interval math, so the two can
--   never disagree; the validator owns the schedule-window dimension the
--   constraint is blind to.
--
--   Legacy (capacity OFF) is byte-for-byte unchanged: the validator returns 'ok'
--   immediately (no per-practitioner availability exists; the studio-wide app
--   policy + the studio-keyed exclusion remain exactly as today).
--
-- Migration-first, additive, flag-OFF. Stacks on 0145 (0140/0141 = onboarding).
-- NOT hosted-applied. Service_role only.

begin;

-- ---------------------------------------------------------------------------
-- Item 3 — shared, target-aware availability validator.
-- Returns 'ok' or a safe machine code. No raw SQL text ever reaches a caller.
-- ---------------------------------------------------------------------------
create or replace function public.validate_appointment_availability(
  p_studio_id                 uuid,
  p_practitioner_id           uuid,       -- the FINAL target practitioner
  p_service_id                uuid,       -- nullable
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz, -- service end (no buffer)
  p_exclude_appointment_id    uuid    default null,
  p_allow_outside_availability boolean default false
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz         text;
  v_cap        boolean;
  v_local_start timestamp;
  v_local_end   timestamp;
  v_local_date  date;
  v_end_date    date;
  v_dow         integer;
  v_start_time  time;
  v_end_time    time;
  v_is_open     boolean;
  v_open        time;
  v_close       time;
  v_found       boolean;
begin
  select s.timezone, coalesce(s.practitioner_capacity_enabled, false)
    into v_tz, v_cap
    from public.studios s
   where s.id = p_studio_id;
  if not found then
    return 'invalid_studio';
  end if;

  -- Legacy: no per-practitioner availability. The studio-wide app policy + the
  -- studio-keyed exclusion are the authority, exactly as today. No-op.
  if not v_cap then
    return 'ok';
  end if;

  -- Membership: the final target must be active + in THIS studio.
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return 'invalid_practitioner';
  end if;

  -- Service eligibility (row present in service_practitioners = eligible).
  if p_service_id is not null and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_practitioner_id
  ) then
    return 'not_eligible';
  end if;

  -- Local wall-clock projection in the studio timezone.
  v_local_start := p_starts_at at time zone v_tz;
  v_local_end   := p_ends_at   at time zone v_tz;
  v_local_date  := v_local_start::date;
  v_end_date    := v_local_end::date;
  v_dow         := extract(dow from v_local_start)::int; -- 0=Sun..6=Sat
  v_start_time  := v_local_start::time;
  v_end_time    := v_local_end::time;

  -- Full-day blockout — NEVER bypassed by the owner override.
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= v_local_date and b.ends_on >= v_local_date
  ) then
    return 'practitioner_closed';
  end if;

  -- Working-hours window — the ONLY thing the owner override may bypass.
  if not p_allow_outside_availability then
    -- Date override wins over the weekly default; within each, a
    -- practitioner-specific row wins over the studio-wide (NULL) row.
    v_found := false;
    select o.is_open, o.open_time, o.close_time into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id and o.effective_date = v_local_date
       and (o.practitioner_id = p_practitioner_id or o.practitioner_id is null)
     order by (o.practitioner_id is not null) desc
     limit 1;
    if found then v_found := true; end if;

    if not v_found then
      select d.is_open, d.open_time, d.close_time into v_is_open, v_open, v_close
        from public.studio_availability_default d
       where d.studio_id = p_studio_id and d.day_of_week = v_dow
         and (d.practitioner_id = p_practitioner_id or d.practitioner_id is null)
       order by (d.practitioner_id is not null) desc
       limit 1;
      if found then v_found := true; end if;
    end if;

    if not v_found or not coalesce(v_is_open, false) or v_open is null or v_close is null then
      return 'practitioner_closed';
    end if;
    -- Whole service interval must sit inside the window on the SAME local day.
    if v_end_date <> v_local_date then
      return 'outside_availability';
    end if;
    if v_start_time < v_open or v_end_time > v_close then
      return 'outside_availability';
    end if;
  end if;

  -- Interval collisions (appointments+buffers / timed blocks / recurring breaks /
  -- blockout intervals) are the per-resource GiST exclusion's job; not duplicated
  -- here. p_exclude_appointment_id documents the self-exclusion the exclusion
  -- constraint already honours via the shadow upsert (stable reservation id).
  perform 1 where p_exclude_appointment_id is null; -- referenced; no-op
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Item 2 — v2 booking command: authoritative duration + owner-only override.
-- No p_duration_minutes; the duration comes from the locked service row.
-- ---------------------------------------------------------------------------
create or replace function public.create_internal_appointment_v2(
  p_studio_id                 uuid,
  p_actor_practitioner_id     uuid,
  p_target_practitioner_id    uuid,
  p_client_id                 uuid,
  p_service_id                uuid,
  p_starts_at                 timestamptz,
  p_cancellation_token_hash   text,
  p_notes                     text    default null,
  p_duration_override_minutes integer default null,
  p_allow_outside_availability boolean default false
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
  v_cap          boolean;
  v_book         boolean;
  v_actor_role   text;
  v_service_dur  integer;
  v_duration     integer;
  v_ends_at      timestamptz;
  v_avail        text;
  v_appt_id      uuid;
  v_now          timestamptz := now();
begin
  -- Lock order (0138): studios ROW first, then the capacity advisory lock.
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

  -- Booking-acceptance gate (paused/draining) — never bypassable.
  if v_cap and not v_book then
    return query select 'booking_paused'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Actor authority: active + in this studio.
  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A member books ONLY for themselves; only an owner assigns to another.
  if v_actor_role <> 'owner'
     and p_target_practitioner_id is distinct from p_actor_practitioner_id then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- The custom-duration override AND the availability bypass are OWNER-ONLY,
  -- enforced on the SERVER-RESOLVED role — a member cannot forge either.
  if v_actor_role <> 'owner'
     and (p_duration_override_minutes is not null or p_allow_outside_availability) then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Target: same studio + active (no composite FK on appointments.practitioner_id).
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Client tenancy.
  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Service: same studio + active. LOCK + read the authoritative duration from
  -- the row itself — never trust a caller-supplied length.
  select sv.default_duration_minutes into v_service_dur
    from public.services sv
   where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true
   for update;
  if not found then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Eligibility (capacity ON) — an ineligible target can never be assigned.
  if v_cap and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_target_practitioner_id
  ) then
    return query select 'not_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Authoritative duration: the service default, OR an OWNER-approved override
  -- (already role-gated above). Validate the override shape here so a bad value
  -- can never reach the interval math.
  if p_duration_override_minutes is not null then
    if p_duration_override_minutes < 15 or p_duration_override_minutes > 360
       or (p_duration_override_minutes % 15) <> 0 then
      return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    v_duration := p_duration_override_minutes;
  else
    v_duration := v_service_dur;
  end if;
  if v_duration is null or v_duration <= 0 then
    return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Time guard.
  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  -- Shared, target-aware availability authority (Legacy => 'ok'). The owner
  -- override bypasses ONLY the working-hours window; blockouts + collisions hold.
  v_avail := public.validate_appointment_availability(
    p_studio_id, p_target_practitioner_id, p_service_id,
    p_starts_at, v_ends_at, null, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Insert. The mirror trigger keys the shadow by resource_key; the per-resource
  -- GiST exclusion is the FINAL race authority (23P01 → full rollback, uncaught).
  insert into public.appointments
    (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
     duration_minutes, status, notes, cancellation_token_hash)
  values
    (p_studio_id, p_target_practitioner_id, p_client_id, p_service_id, p_starts_at, v_ends_at,
     v_duration, 'confirmed', p_notes, p_cancellation_token_hash)
  returning id into v_appt_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt_id, 'practitioner', p_actor_practitioner_id, 'created',
    jsonb_build_object(
      'source', 'internal_booking_command_v2',
      'target_practitioner_id', p_target_practitioner_id,
      'duration_minutes', v_duration,
      'duration_overridden', (p_duration_override_minutes is not null),
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select 'created'::text, v_appt_id, p_starts_at, v_ends_at;
  return;
end;
$$;

revoke execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) from public;
revoke execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) from anon;
revoke execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) from authenticated;
grant execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) to service_role;
revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from public;
revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from anon;
revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from authenticated;
grant execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) to service_role;

commit;
