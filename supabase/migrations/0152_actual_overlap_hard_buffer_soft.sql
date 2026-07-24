-- 0152 — Actual treatment overlap is a HARD database constraint; the configured
-- studios.buffer_minutes gap becomes a SOFT scheduling constraint that an
-- authenticated internal OWNER override may bypass. Fixes Chloe's manual-override
-- booking blocker: a close-but-non-overlapping override booking (e.g. 12:00–13:00
-- next to an existing 13:00–14:00 with a 30-min buffer) was wrongly rejected by
-- the buffer-EXPANDED GiST exclusion returning 23P01 → "That time is no longer
-- available", even though the treatment intervals do not overlap.
--
-- Contract (Option B):
--   * HARD, never-bypassable: actual treatment overlap tstzrange(starts_at,
--     ends_at, '[)'), resource-scoped exactly as 0134 (OFF: studio-wide; ON:
--     per-practitioner). Studio-wide blocks/blockouts/breaks unchanged (exact
--     intervals in the shadow).
--   * SOFT, override-aware: the buffer/gap. Enforced for EVERY normal writer
--     (public booking direct insert, public reschedule, member internal booking,
--     move/reassign) and bypassed ONLY when an authenticated internal OWNER sets
--     allow_outside_availability=true (create_internal_appointment_v2 /
--     move_or_reassign_appointment), which stamps
--     appointments.booked_outside_availability = true on the row.
--   * blocked_ends_at + buffer_minutes_snapshot are RETAINED (slot generation +
--     reporting) but are NO LONGER the hard-exclusion basis.
--
-- Migration-first, forward-only, additive where possible, NOT hosted-applied.
-- Service_role only for the callable commands. Rollback guidance at the bottom.

begin;

-- ---------------------------------------------------------------------------
-- 1) PREFLIGHT. Refuse to migrate if any ACTUAL treatment overlap already
--    exists (the old buffer-expanded exclusion should have prevented every one,
--    so none is expected; stop loudly if the live data disagrees rather than
--    creating a constraint the table cannot satisfy).
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.appointments a1
  join public.appointments a2
    on a1.id < a2.id
   and a1.studio_id = a2.studio_id
   and a1.status in ('confirmed', 'completed')
   and a2.status in ('confirmed', 'completed')
   and (
     (coalesce(a1.capacity_enabled, false) = false
        and coalesce(a2.capacity_enabled, false) = false)
     or (coalesce(a1.capacity_enabled, false) = true
        and coalesce(a2.capacity_enabled, false) = true
        and a1.practitioner_id = a2.practitioner_id)
   )
   and tstzrange(a1.starts_at, a1.ends_at, '[)')
       && tstzrange(a2.starts_at, a2.ends_at, '[)');
  if v_bad > 0 then
    raise exception
      '0152 preflight failed: % existing actual-overlap appointment pair(s). Resolve before migrating.',
      v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Per-row override flag. Default false; only the owner-gated internal
--    commands below ever set it true. Public/anon callers never write it.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists booked_outside_availability boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3) HARD actual-overlap exclusions. Replace the two buffer-EXPANDED partial
--    exclusions (which used blocked_ends_at) with ACTUAL-interval ones. Same
--    resource scoping + partial predicates as 0134.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint
             where conname = 'no_overlapping_appointments_studio_wide'
               and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments drop constraint no_overlapping_appointments_studio_wide;
  end if;
  alter table public.appointments
    add constraint no_overlapping_appointments_studio_wide
    exclude using gist (
      studio_id with =,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (status = 'confirmed' and capacity_enabled = false);

  if exists (select 1 from pg_constraint
             where conname = 'no_overlapping_appointments_per_practitioner'
               and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments drop constraint no_overlapping_appointments_per_practitioner;
  end if;
  alter table public.appointments
    add constraint no_overlapping_appointments_per_practitioner
    exclude using gist (
      practitioner_id with =,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (status = 'confirmed' and capacity_enabled = true);
end $$;

-- ---------------------------------------------------------------------------
-- 4) Shadow reservation is the FINAL race-safe authority (0134). Its per-resource
--    GiST is already on tstzrange(starts_at, ends_at); the appointment writer
--    used to mirror ends_at = blocked_ends_at (buffer-expanded). Store the ACTUAL
--    ends_at so the shadow enforces true overlap only. Blocks/blockouts/breaks
--    are unaffected (they never carried a buffer). Then rematerialize existing
--    appointment shadow rows to the actual interval (no appointment times move).
-- ---------------------------------------------------------------------------
create or replace function public.sync_appointment_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rk uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = old.id;
    return null;
  end if;

  if new.status in ('confirmed', 'completed') then
    if public.studio_capacity_enabled(new.studio_id) then
      v_rk := new.practitioner_id;
    else
      v_rk := new.studio_id;
    end if;

    insert into public.studio_calendar_reservations
      (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
    values
      (new.studio_id, new.practitioner_id, v_rk, 'appointment', new.id,
       new.starts_at, new.ends_at)   -- ACTUAL interval (0152): no buffer expansion.
    on conflict on constraint studio_calendar_reservations_source_unique
    do update set
      studio_id       = excluded.studio_id,
      practitioner_id = excluded.practitioner_id,
      starts_at       = excluded.starts_at,
      ends_at         = excluded.ends_at;

    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id and resource_key <> v_rk;
  else
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id;
  end if;

  return null;
end;
$$;

-- Rematerialize existing appointment shadow rows to the ACTUAL interval. This
-- narrows reservations (buffer-expanded -> actual); it can never create an
-- overlap the preflight above did not already rule out.
update public.studio_calendar_reservations r
   set ends_at = a.ends_at
  from public.appointments a
 where r.source_kind = 'appointment'
   and r.source_id = a.id
   and r.ends_at is distinct from a.ends_at;

-- ---------------------------------------------------------------------------
-- 5) Canonical SOFT-buffer helper. Does the candidate [starts, ends+buffer)
--    window overlap another CONFIRMED/COMPLETED appointment's [starts, ends+buffer)
--    window on the SAME resource? Buffer = studios.buffer_minutes (the value that
--    built blocked_ends_at). One definition, shared by the validator (RPC paths)
--    and the trigger (all writers).
-- ---------------------------------------------------------------------------
create or replace function public.appointment_buffer_conflict(
  p_studio_id              uuid,
  p_practitioner_id        uuid,
  p_capacity_enabled       boolean,
  p_starts_at              timestamptz,
  p_ends_at                timestamptz,
  p_exclude_appointment_id uuid default null
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with cfg as (
    select coalesce(s.buffer_minutes, 0) as buf
      from public.studios s where s.id = p_studio_id
  )
  select exists (
    select 1
      from public.appointments a, cfg
     where a.studio_id = p_studio_id
       and a.status in ('confirmed', 'completed')
       and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
       and (
         p_capacity_enabled = false
         or (p_capacity_enabled = true and a.practitioner_id = p_practitioner_id)
       )
       -- buffer-expanded windows overlap (a gap violation) ...
       and tstzrange(p_starts_at, p_ends_at + make_interval(mins => cfg.buf), '[)')
           && tstzrange(a.starts_at, a.ends_at + make_interval(mins => cfg.buf), '[)')
       -- ... but the ACTUAL treatment intervals do NOT (a true overlap is the
       -- HARD GiST exclusion's job → 23P01, never the soft buffer). With buffer=0
       -- this makes the soft check a no-op, so overlap tests keep getting 23P01.
       and not (
         tstzrange(p_starts_at, p_ends_at, '[)')
             && tstzrange(a.starts_at, a.ends_at, '[)')
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- 6) Uniform SOFT-buffer trigger. Fires for EVERY appointment writer (including
--    the direct public-booking insert), so no normal writer can silently lose
--    buffer enforcement. Bypassed only for a row flagged booked_outside_availability
--    (set solely by the owner-gated commands). Distinct SQLSTATE 'HB001' so the
--    app maps it to fixed safe buffer copy — never a raw 23P01/SQLSTATE.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_appointment_buffer()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cap boolean;
begin
  if new.status = 'confirmed'
     and coalesce(new.booked_outside_availability, false) = false then
    v_cap := public.studio_capacity_enabled(new.studio_id);
    if public.appointment_buffer_conflict(
         new.studio_id, new.practitioner_id, v_cap,
         new.starts_at, new.ends_at, new.id
       ) then
      raise exception 'appointment_buffer_conflict' using errcode = 'HB001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_enforce_buffer_trg on public.appointments;
create trigger appointments_enforce_buffer_trg
  before insert or update of starts_at, ends_at, status, practitioner_id,
                             booked_outside_availability, capacity_enabled
  on public.appointments
  for each row
  execute function public.enforce_appointment_buffer();

-- ---------------------------------------------------------------------------
-- 7) Canonical availability validator (0146) + the SOFT buffer, override-gated.
--    Unchanged except the new buffer check just before the collision delegation.
-- ---------------------------------------------------------------------------
create or replace function public.validate_appointment_availability(
  p_studio_id                 uuid,
  p_practitioner_id           uuid,
  p_service_id                uuid,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_exclude_appointment_id    uuid    default null,
  p_allow_outside_availability boolean default false
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz          text;
  v_cap         boolean;
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

  -- Legacy (capacity OFF): no per-practitioner working-hours window. The buffer
  -- soft-check below still runs (studio-wide) so OFF studios keep their gap.
  if v_cap then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = p_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return 'invalid_practitioner';
    end if;

    if p_service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = p_service_id and sp.practitioner_id = p_practitioner_id
    ) then
      return 'not_eligible';
    end if;

    v_local_start := p_starts_at at time zone v_tz;
    v_local_end   := p_ends_at   at time zone v_tz;
    v_local_date  := v_local_start::date;
    v_end_date    := v_local_end::date;
    v_dow         := extract(dow from v_local_start)::int;
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
      if v_end_date <> v_local_date then
        return 'outside_availability';
      end if;
      if v_start_time < v_open or v_end_time > v_close then
        return 'outside_availability';
      end if;
    end if;
  end if;

  -- SOFT buffer/gap (0152). Enforced for normal bookings on BOTH capacity modes;
  -- bypassed only for an authenticated internal owner override. Actual-interval
  -- overlap is NOT checked here — the per-resource GiST exclusion is the final
  -- race-safe authority (23P01) and is never bypassable.
  if not p_allow_outside_availability then
    if public.appointment_buffer_conflict(
         p_studio_id, p_practitioner_id, v_cap,
         p_starts_at, p_ends_at, p_exclude_appointment_id
       ) then
      return 'buffer_conflict';
    end if;
  end if;

  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Internal booking command (0146) — stamp the override flag on the row so the
--    trigger honours the owner bypass. Everything else is byte-for-byte 0146.
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

  if v_cap and not v_book then
    return query select 'booking_paused'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_actor_role <> 'owner'
     and p_target_practitioner_id is distinct from p_actor_practitioner_id then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_actor_role <> 'owner'
     and (p_duration_override_minutes is not null or p_allow_outside_availability) then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select sv.default_duration_minutes into v_service_dur
    from public.services sv
   where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true
   for update;
  if not found then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_cap and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_target_practitioner_id
  ) then
    return query select 'not_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

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

  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  v_avail := public.validate_appointment_availability(
    p_studio_id, p_target_practitioner_id, p_service_id,
    p_starts_at, v_ends_at, null, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.appointments
    (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
     duration_minutes, status, notes, cancellation_token_hash,
     booked_outside_availability)
  values
    (p_studio_id, p_target_practitioner_id, p_client_id, p_service_id, p_starts_at, v_ends_at,
     v_duration, 'confirmed', p_notes, p_cancellation_token_hash,
     p_allow_outside_availability)
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

-- ---------------------------------------------------------------------------
-- 9) Move/reassign command (0148) — stamp the override flag on the moved row so
--    the buffer trigger honours the owner bypass. Only the UPDATE column list
--    changes vs 0148.
-- ---------------------------------------------------------------------------
create or replace function public.move_or_reassign_appointment(
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
  if p_allow_outside_availability and v_actor_role <> 'owner' then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

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
     set starts_at                   = p_new_starts_at,
         ends_at                     = v_new_ends,
         practitioner_id             = v_target,
         booked_outside_availability = p_allow_outside_availability,
         updated_at                  = v_now
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

-- ---------------------------------------------------------------------------
-- 10) Grants. create-or-replace preserves existing privileges; re-assert the
--     service_role-only posture for the callable commands + helper, and lock the
--     buffer helper down to service_role (definer functions call it).
-- ---------------------------------------------------------------------------
revoke execute on function public.appointment_buffer_conflict(uuid, uuid, boolean, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant  execute on function public.appointment_buffer_conflict(uuid, uuid, boolean, timestamptz, timestamptz, uuid) to service_role;

revoke execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.validate_appointment_availability(uuid, uuid, uuid, timestamptz, timestamptz, uuid, boolean) to service_role;

revoke execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) from public, anon, authenticated;
grant  execute on function public.create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean) to service_role;

revoke execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant  execute on function public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean) to service_role;

commit;

-- ===========================================================================
-- ROLLBACK GUIDANCE (do NOT apply to a hosted database as part of this PR)
-- ---------------------------------------------------------------------------
-- To revert 0152 on a throwaway/local DB:
--   1. Restore the buffer-EXPANDED exclusions:
--        alter table public.appointments drop constraint no_overlapping_appointments_studio_wide;
--        alter table public.appointments drop constraint no_overlapping_appointments_per_practitioner;
--        -- recreate both using tstzrange(starts_at, blocked_ends_at, '[)') (see 0134).
--   2. Restore public.sync_appointment_to_calendar_reservation() to mirror
--      (new.starts_at, new.blocked_ends_at) and rematerialize:
--        update public.studio_calendar_reservations r set ends_at = a.blocked_ends_at
--          from public.appointments a
--         where r.source_kind='appointment' and r.source_id=a.id;
--   3. drop trigger appointments_enforce_buffer_trg on public.appointments;
--      drop function public.enforce_appointment_buffer();
--      drop function public.appointment_buffer_conflict(uuid,uuid,boolean,timestamptz,timestamptz,uuid);
--   4. Restore validate_appointment_availability / create_internal_appointment_v2
--      / move_or_reassign_appointment to their 0146/0148 bodies.
--   5. alter table public.appointments drop column booked_outside_availability;
-- No appointment START/END times are changed by 0152, so no time-data rollback
-- is required.
-- ===========================================================================
