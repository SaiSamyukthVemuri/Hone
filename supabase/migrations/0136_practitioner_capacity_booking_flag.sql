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
-- Fix: add an operator-controlled BOOKING flag. The two flags yield four states:
--   Legacy               capacity=false booking=false  (today's studio-wide)
--   Configuring          capacity=true  booking=false  (owner sets up schedules)
--   Live                 capacity=true  booking=true   (practitioner-aware bookings)
--   Draining / pause     capacity=true  booking=false  (stop NEW bookings; keep
--                                                       existing parallel appts)
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
    and a1.status = 'confirmed' and a2.status = 'confirmed'
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
create or replace function public.practitioner_capacity_retirement_blockers(p_studio_id uuid)
returns table (booking_still_enabled boolean, overlapping_appointments int)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    coalesce((select s.practitioner_capacity_booking_enabled from public.studios s where s.id = p_studio_id), false),
    (select count(*)::int
       from public.appointments a1
       join public.appointments a2
         on a1.studio_id = a2.studio_id and a1.id < a2.id
      where a1.studio_id = p_studio_id
        and a1.status = 'confirmed' and a2.status = 'confirmed'
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
    'public.practitioner_capacity_retirement_blockers(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
