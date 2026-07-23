-- ===========================================================================
-- 0136 — Separate structural capacity from the booking kill-switch (PR B 3B-0)
-- ===========================================================================
--
-- Blocking defect: practitioner_capacity_enabled (0134) conflates TWO concerns —
-- the structural collision/resource-key model AND booking acceptance. Once a
-- studio has legitimate parallel appointments for different practitioners,
-- flipping practitioner_capacity_enabled ON->OFF rematerializes them into ONE
-- studio-wide resource, the studio-wide exclusion raises 23P01, and the flip
-- rolls back. So "flip it OFF instantly" is NOT a truthful rollback plan for a
-- live multi-practitioner studio.
--
-- Fix: add an operator-controlled BOOKING flag. The two booleans yield THREE
-- valid TECHNICAL states (the DB cannot distinguish "configuring" from
-- "draining" — both are capacity=true, booking=false; that is an OPERATIONAL
-- distinction reported separately from indicators like future confirmed appts):
--   LEGACY                       capacity=false booking=false (today's studio-wide)
--   CAPACITY_READY_BOOKING_PAUSED capacity=true  booking=false (config OR pause OR drain)
--   LIVE                         capacity=true  booking=true  (practitioner-aware bookings)
-- The invalid state capacity=false + booking=true is rejected by a CHECK.
--
-- EMERGENCY PAUSE = flip booking OFF: instant, safe, no rematerialization
-- (capacity is unchanged), existing parallel appointments stay valid.
-- STRUCTURAL DEACTIVATION (capacity ON->OFF) becomes a preflighted, service-
-- role-only RETIREMENT (retire_practitioner_capacity) that fails closed with
-- reason codes if parallel data would collide studio-wide.
--
-- Additive; both flags default false; repo-only (not hosted-applied). Willow
-- (both flags false) is unaffected. Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Step 1: the booking-acceptance flag. Operator-controlled, default false.
-- ---------------------------------------------------------------------------
alter table public.studios
  add column if not exists practitioner_capacity_booking_enabled boolean not null default false;

-- Reject the invalid state: booking cannot be enabled without the structural
-- model. This also enforces the ordering (enable capacity before booking;
-- disable booking before capacity). Existing rows (false/false) satisfy it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studios_capacity_booking_valid'
      and conrelid = 'public.studios'::regclass
  ) then
    alter table public.studios
      add constraint studios_capacity_booking_valid
      check (practitioner_capacity_enabled or not practitioner_capacity_booking_enabled);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 2: extend the operator-only guard (0134) to BOTH flags. SECURITY
-- INVOKER so current_user is the real caller; browser roles (anon /
-- authenticated, owners included) may not change either flag.
-- ---------------------------------------------------------------------------
create or replace function public.guard_capacity_flag_activation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (new.practitioner_capacity_enabled is distinct from old.practitioner_capacity_enabled
      or new.practitioner_capacity_booking_enabled is distinct from old.practitioner_capacity_booking_enabled)
     and current_user in ('anon', 'authenticated') then
    raise exception
      'practitioner capacity flags are operator-controlled; role % may not change them',
      current_user
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger studios_guard_capacity_flag_trg
  before update of practitioner_capacity_enabled, practitioner_capacity_booking_enabled
  on public.studios
  for each row
  execute function public.guard_capacity_flag_activation();

-- ---------------------------------------------------------------------------
-- Step 2b (3B-2): ONE named capacity-participation predicate, used identically
-- by the appointment mirror, rematerialization, the retirement preflight, the
-- blockers RPC, and the verifier. A CONFIRMED appointment always participates
-- (matching the 0029 confirmed-exclusion, which has no time bound); a COMPLETED
-- appointment participates ONLY while its protected interval has not ended.
-- Rationale (audited): 0032 added completed rows to the shadow so a confirmed->
-- completed transition does not drop the reservation and re-open the slot while
-- the appointment is still occupying the chair; an EXPIRED completed appointment
-- is historical and holds no live capacity — it must not permanently block
-- structural retirement, and (being in the past) never affects future slots.
-- The shadow remains a collision/capacity structure, NOT an audit log:
-- appointments history stays in `appointments`; only the DERIVED reservation is
-- affected. STABLE (depends on now()).
create or replace function public.appointment_participates_in_capacity(
  p_status text,
  p_blocked_ends_at timestamptz
)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select p_status = 'confirmed'
      or (p_status = 'completed' and p_blocked_ends_at > now());
$$;

-- Redefine the appointment mirror (0134) to use the predicate. Future-dated
-- completed appointments still participate; only EXPIRED completed rows drop
-- their derived reservation.
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

  if public.appointment_participates_in_capacity(new.status, new.blocked_ends_at) then
    if public.studio_capacity_enabled(new.studio_id) then
      v_rk := new.practitioner_id;
    else
      v_rk := new.studio_id;
    end if;
    insert into public.studio_calendar_reservations
      (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
    values
      (new.studio_id, new.practitioner_id, v_rk, 'appointment', new.id,
       new.starts_at, new.blocked_ends_at)
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

-- Redefine rematerialize (0134) so its appointment insert uses the SAME
-- predicate as the retirement preflight — expired completed rows are neither
-- kept nor re-created, so preflight and rematerialization agree exactly.
create or replace function public.rematerialize_studio_reservations(p_studio_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_enabled boolean := public.studio_capacity_enabled(p_studio_id);
  v_tz text;
  r record;
begin
  select coalesce(s.timezone, 'America/Toronto') into v_tz
  from public.studios s where s.id = p_studio_id;

  update public.appointments
    set capacity_enabled = v_enabled
    where studio_id = p_studio_id and capacity_enabled is distinct from v_enabled;

  delete from public.studio_calendar_reservations where studio_id = p_studio_id;

  insert into public.studio_calendar_reservations
    (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
  select a.studio_id, a.practitioner_id,
         case when v_enabled then a.practitioner_id else a.studio_id end,
         'appointment', a.id, a.starts_at, a.blocked_ends_at
  from public.appointments a
  where a.studio_id = p_studio_id
    and public.appointment_participates_in_capacity(a.status, a.blocked_ends_at);

  for r in
    select id, starts_at, ends_at from public.studio_timed_blocks where studio_id = p_studio_id
  loop
    perform public.fanout_studio_wide_reservation(p_studio_id, 'timed_block', r.id, r.starts_at, r.ends_at);
  end loop;
  for r in
    select id,
           (starts_on::timestamp) at time zone v_tz as s_at,
           ((ends_on + 1)::timestamp) at time zone v_tz as e_at
    from public.studio_blockouts where studio_id = p_studio_id
  loop
    perform public.fanout_studio_wide_reservation(p_studio_id, 'full_day_blockout', r.id, r.s_at, r.e_at);
  end loop;
  for r in
    select id, starts_at, ends_at
    from public.studio_recurring_break_occurrences where studio_id = p_studio_id
  loop
    perform public.fanout_studio_wide_reservation(p_studio_id, 'recurring_break_occurrence', r.id, r.starts_at, r.ends_at);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 2c (3B-4): ONE reviewed per-studio TRANSACTION advisory lock. Structural
-- retirement (and, in Part 4, capacity-aware booking/assignment commands)
-- acquire this BEFORE their preflight/revalidation, so no concurrent operation
-- can commit a conflicting change between blocker evaluation and the flag/insert
-- transition. Transaction-scoped: released automatically on commit/rollback. Key
-- derivation: hashtextextended('studio_capacity:' || studio_id) — a 64-bit key
-- namespaced by a fixed prefix, so ordinary studios do not collide (birthday-
-- bound at ~2^32 studios, far beyond any real tenant count). It is NOT a global
-- table lock, so ordinary bookings are unaffected.
--
-- NOTE: until Part 4 wires the booking commands to take this same lock,
-- structural retirement remains NON-PRODUCTION-READY and must not be run on an
-- enabled production studio.
create or replace function public.acquire_studio_capacity_lock(p_studio_id uuid)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('studio_capacity:' || p_studio_id::text, 0));
$$;

-- ---------------------------------------------------------------------------
-- Step 3: structural-deactivation RETIREMENT. Service-role only. Locks the
-- studio, runs the preflight transactionally, and fails closed with a reason
-- code + counts (NO client/clinical data) if retiring to studio-wide would
-- collide. Only on success does it flip capacity OFF (firing the 0134
-- studio-wide rematerialization, which then succeeds).
--
-- Preflight blockers implemented at this phase:
--   * booking still enabled (must Drain first);
--   * overlapping confirmed appointments across practitioners (would 23P01
--     studio-wide).
-- (Per-practitioner future blocks/breaks are added to this preflight in 3B/3C
-- once those scoped columns exist.)
-- ---------------------------------------------------------------------------
create or replace function public.retire_practitioner_capacity(p_studio_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cap boolean;
  v_book boolean;
  v_overlaps int;
begin
  -- 3B-4: serialize per studio BEFORE evaluating blockers, so no concurrent
  -- capacity-aware operation can commit between the preflight and the flag flip.
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select practitioner_capacity_enabled, practitioner_capacity_booking_enabled
    into v_cap, v_book
  from public.studios where id = p_studio_id for update;

  if v_cap is null then
    raise exception 'capacity_retirement_blocked:studio_not_found' using errcode = 'P0002';
  end if;
  if not v_cap then
    raise exception 'capacity_retirement_blocked:not_enabled' using errcode = 'P0001';
  end if;
  if v_book then
    raise exception 'capacity_retirement_blocked:booking_still_enabled' using errcode = 'P0001';
  end if;

  select count(*) into v_overlaps
  from public.appointments a1
  join public.appointments a2
    on a1.studio_id = a2.studio_id and a1.id < a2.id
  where a1.studio_id = p_studio_id
    and public.appointment_participates_in_capacity(a1.status, a1.blocked_ends_at)
    and public.appointment_participates_in_capacity(a2.status, a2.blocked_ends_at)
    and tstzrange(a1.starts_at, a1.blocked_ends_at, '[)')
        && tstzrange(a2.starts_at, a2.blocked_ends_at, '[)');

  if v_overlaps > 0 then
    raise exception 'capacity_retirement_blocked:overlapping_appointments:%', v_overlaps
      using errcode = '23P01';
  end if;

  update public.studios set practitioner_capacity_enabled = false where id = p_studio_id;
end;
$$;

-- Read-only preflight report for the verifier/operator (no state change, no PII).
-- 3B-3: reports studio_exists FIRST, so an unknown studio UUID is never a "safe
-- zero-blockers" result — the caller/verifier classifies it as not-found. 3B-2:
-- the overlap uses the same participation predicate as retirement.
create or replace function public.practitioner_capacity_retirement_blockers(p_studio_id uuid)
returns table (studio_exists boolean, booking_still_enabled boolean, overlapping_appointments int)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    exists (select 1 from public.studios s where s.id = p_studio_id),
    coalesce((select s.practitioner_capacity_booking_enabled from public.studios s where s.id = p_studio_id), false),
    (select count(*)::int
       from public.appointments a1
       join public.appointments a2
         on a1.studio_id = a2.studio_id and a1.id < a2.id
      where a1.studio_id = p_studio_id
        and public.appointment_participates_in_capacity(a1.status, a1.blocked_ends_at)
        and public.appointment_participates_in_capacity(a2.status, a2.blocked_ends_at)
        and tstzrange(a1.starts_at, a1.blocked_ends_at, '[)')
            && tstzrange(a2.starts_at, a2.blocked_ends_at, '[)'));
$$;

-- ---------------------------------------------------------------------------
-- Step 4: lock down. Both RPCs are operator/service-role only.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.retire_practitioner_capacity(uuid)',
    'public.practitioner_capacity_retirement_blockers(uuid)',
    'public.appointment_participates_in_capacity(text, timestamptz)',
    'public.acquire_studio_capacity_lock(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
