-- ===========================================================================
-- 0134 — Practitioner-capacity foundation (PR A)
-- ===========================================================================
--
-- Goal: make a studio capable of modelling per-practitioner capacity so three
-- practitioners can work in parallel WITHOUT double-booking a practitioner or a
-- studio-wide resource. This migration is the ADDITIVE, DEFAULT-OFF foundation
-- only. It changes NO booking/assignment behaviour by itself; practitioner
-- availability (PR B) and public selection/assignment (PR C) build on it.
--
-- PRIME DIRECTIVE — while studios.practitioner_capacity_enabled = false (every
-- production studio, Willow included, by default) the observable collision and
-- availability behaviour must be byte-for-byte today's studio-wide behaviour.
-- Parallelism is strictly opt-in.
--
-- The design (see docs/roadmap/PRACTITIONER_CAPACITY_ARCHITECTURE.md):
--   * studio_calendar_reservations gains a `resource_key uuid not null` GiST
--     partition key. For an OFF studio EVERY row's resource_key = studio_id, so
--     the single re-keyed exclusion reproduces today's studio-wide semantics
--     exactly. For an ON studio an appointment's resource_key = practitioner_id
--     (parallelism), and a studio-wide block (timed_block / full_day_blockout /
--     recurring_break_occurrence) FANS OUT into one row per active practitioner
--     so it still blocks everyone.
--   * appointments gains a denormalized `capacity_enabled` mirror + a CHECK that
--     an ON appointment must carry a practitioner_id (closes the NULL-GiST hole,
--     guarantees same-practitioner race safety), and its studio-wide exclusion
--     is split into two partial exclusions (studio-wide when OFF, per-
--     practitioner when ON).
--   * service_practitioners: additive eligibility join, same-studio enforced via
--     composite FKs, backfilled so every active practitioner is eligible for
--     every service (= today's unrestricted assignment).
--
-- Rollback: flip the flag off (instant, per-studio). The forward migration
-- deletes/rewrites no source-of-truth row; the shadow is fully derivable and is
-- rebuilt by public.rematerialize_studio_reservations().
--
-- Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

lock table public.studio_calendar_reservations in exclusive mode;
lock table public.appointments in exclusive mode;

-- btree_gist is required for uuid equality inside a GiST exclusion. Created in
-- 0029; repeated here idempotently so this file stands alone on a fresh DB.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Step 1: per-studio capacity flag. Additive, default false, read as
-- `studio.practitioner_capacity_enabled === true` — the proven 0119/0120/0121
-- pattern. No UPDATE runs, so Willow and every existing studio stay false.
-- ---------------------------------------------------------------------------
alter table public.studios
  add column if not exists practitioner_capacity_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Step 2: denormalized capacity mirror on appointments + integrity CHECK.
-- The mirror lets the appointment-level partial exclusions be evaluated purely
-- from the row (partial-index predicates cannot join to studios). A BEFORE
-- trigger keeps it in sync on every appointment write; the studios flag-flip
-- path (Step 9) bulk-updates it. The CHECK guarantees no ON appointment that
-- participates in collisions (status confirmed/completed — the only statuses
-- that enter the per-practitioner exclusion or get a per-practitioner shadow
-- row) can carry a NULL practitioner_id (which would escape the per-practitioner
-- GiST / null the resource_key). Non-participating statuses (cancelled,
-- no_show) are deliberately exempt: the public path legitimately writes
-- practitioner_id = owner?.id ?? null and such a row must never block
-- activation or the removal of a practitioner.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists capacity_enabled boolean not null default false;

create or replace function public.set_appointment_capacity_enabled()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  select coalesce(s.practitioner_capacity_enabled, false)
    into new.capacity_enabled
  from public.studios s
  where s.id = new.studio_id;
  if new.capacity_enabled is null then
    new.capacity_enabled := false;
  end if;
  return new;
end;
$$;

create or replace trigger appointments_set_capacity_enabled_trg
  before insert or update of studio_id, practitioner_id, status
  on public.appointments
  for each row
  execute function public.set_appointment_capacity_enabled();

-- Existing rows: every studio is OFF, so capacity_enabled = false everywhere.
update public.appointments set capacity_enabled = false where capacity_enabled is distinct from false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_capacity_requires_practitioner'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_capacity_requires_practitioner
      check (
        capacity_enabled = false
        or practitioner_id is not null
        or status not in ('confirmed', 'completed')
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 3: resource dimension on the shadow. practitioner_id is provenance;
-- resource_key is the GiST partition key. Backfill every existing row to
-- studio_id (all studios OFF) BEFORE making resource_key NOT NULL.
-- ---------------------------------------------------------------------------
alter table public.studio_calendar_reservations
  add column if not exists practitioner_id uuid references public.practitioners(id) on delete cascade;

alter table public.studio_calendar_reservations
  add column if not exists resource_key uuid;

update public.studio_calendar_reservations
  set resource_key = studio_id
  where resource_key is null;

alter table public.studio_calendar_reservations
  alter column resource_key set not null;

create index if not exists studio_calendar_reservations_practitioner_idx
  on public.studio_calendar_reservations (practitioner_id);

-- Backward-compat default: any inserter that does NOT specify resource_key
-- (external code, tests, future call sites) gets studio-wide keying
-- (resource_key = studio_id) — the pre-0134 semantics. The 0134 trigger writers
-- always set resource_key explicitly, so this is a no-op for them. Runs BEFORE
-- the NOT NULL check, so the column stays NOT NULL without breaking such inserts.
create or replace function public.set_reservation_resource_key_default()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.resource_key is null then
    new.resource_key := new.studio_id;
  end if;
  return new;
end;
$$;

create or replace trigger studio_calendar_reservations_resource_key_default_trg
  before insert on public.studio_calendar_reservations
  for each row
  execute function public.set_reservation_resource_key_default();

-- ---------------------------------------------------------------------------
-- Step 4: widen the upsert arbiter. Fan-out produces N rows per studio-wide
-- source (one per active practitioner), so (source_kind, source_id) is no
-- longer unique — key it by resource_key too. Keep the SAME constraint name so
-- the sync functions' `on conflict on constraint ..._source_unique` still bind.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'studio_calendar_reservations_source_unique'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      drop constraint studio_calendar_reservations_source_unique;
  end if;
  alter table public.studio_calendar_reservations
    add constraint studio_calendar_reservations_source_unique
    unique (source_kind, source_id, resource_key);
end $$;

-- ---------------------------------------------------------------------------
-- Step 5: swap the studio-wide shadow exclusion for a resource-keyed one.
-- OFF studios: resource_key = studio_id  => identical to today. ON studios:
-- resource_key = practitioner_id (appointments) or fanned per-practitioner
-- (blocks) => same-practitioner + block-blocks-everyone, different
-- practitioners run in parallel.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_calendar_reservations_per_studio'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      drop constraint no_overlapping_calendar_reservations_per_studio;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_calendar_reservations_per_resource'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      add constraint no_overlapping_calendar_reservations_per_resource
      exclude using gist (
        resource_key with =,
        tstzrange(starts_at, ends_at, '[)') with &&
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 6: split the appointments exclusion into two partials. Defense in depth
-- (the shadow already enforces the same rule) AND it carries the ON-studio
-- per-practitioner guarantee directly on the source table.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_active_appointments_per_studio'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      drop constraint no_overlapping_active_appointments_per_studio;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_appointments_studio_wide'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint no_overlapping_appointments_studio_wide
      exclude using gist (
        studio_id with =,
        tstzrange(starts_at, blocked_ends_at, '[)') with &&
      ) where (status = 'confirmed' and capacity_enabled = false);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_appointments_per_practitioner'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint no_overlapping_appointments_per_practitioner
      exclude using gist (
        practitioner_id with =,
        tstzrange(starts_at, blocked_ends_at, '[)') with &&
      ) where (status = 'confirmed' and capacity_enabled = true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 7: capacity-aware shadow writers.
--
-- 7a. Studio-capacity probe. STABLE, SECURITY DEFINER, hardened path.
-- ---------------------------------------------------------------------------
create or replace function public.studio_capacity_enabled(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    (select s.practitioner_capacity_enabled from public.studios s where s.id = p_studio_id),
    false
  );
$$;

-- 7b. Fan-out helper for studio-WIDE sources (blocks/blockouts/breaks). These
-- carry no practitioner. OFF: one row keyed by studio_id (today). ON: one row
-- per practitioner keyed by that practitioner_id, so the block collides with
-- every practitioner's per-practitioner appointments. Fans to ALL practitioners
-- in the studio, NOT just active ones: an appointment's shadow row is keyed by
-- its practitioner_id regardless of that practitioner's active state (a
-- practitioner can be deactivated while holding confirmed appointments), so the
-- block must cover inactive-but-appointment-holding and later-reactivated
-- practitioners too. This makes a studio-wide block collide with any overlapping
-- appointment exactly as the pre-0134 studio-wide exclusion did. Delete-then-
-- insert because the row count varies. A studio with zero practitioners yields
-- zero rows (truly degenerate — it can hold no appointments to block).
create or replace function public.fanout_studio_wide_reservation(
  p_studio_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  delete from public.studio_calendar_reservations
    where source_kind = p_source_kind and source_id = p_source_id;

  if public.studio_capacity_enabled(p_studio_id) then
    insert into public.studio_calendar_reservations
      (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
    select p_studio_id, pr.id, pr.id, p_source_kind, p_source_id, p_starts_at, p_ends_at
    from public.practitioners pr
    where pr.studio_id = p_studio_id;
  else
    insert into public.studio_calendar_reservations
      (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
    values
      (p_studio_id, null, p_studio_id, p_source_kind, p_source_id, p_starts_at, p_ends_at);
  end if;
end;
$$;

-- 7c. Appointments -> shadow. Single row. OFF: resource_key = studio_id. ON:
-- resource_key = practitioner_id (CHECK guarantees NOT NULL when ON).
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
      v_rk := new.practitioner_id;   -- NOT NULL guaranteed by the appointments CHECK
    else
      v_rk := new.studio_id;
    end if;

    -- Upsert (NOT delete+insert) so a reschedule/move keeps the SAME reservation
    -- row id — the stable-reservation-identity contract the move RPC relies on.
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
    -- Clean up a stale row keyed to a PREVIOUS resource_key (practitioner
    -- reassignment changes v_rk; the upsert above inserts a fresh row, this
    -- removes the orphan).
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id and resource_key <> v_rk;
  else
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id;
  end if;

  return null;
end;
$$;

-- 7d/e/f. Studio-wide sources now route through the fan-out helper.
create or replace function public.sync_timed_block_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'timed_block' and source_id = old.id;
    return null;
  end if;
  perform public.fanout_studio_wide_reservation(
    new.studio_id, 'timed_block', new.id, new.starts_at, new.ends_at);
  return null;
end;
$$;

create or replace function public.sync_blockout_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end   timestamptz;
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'full_day_blockout' and source_id = old.id;
    return null;
  end if;

  select coalesce(s.timezone, 'America/Toronto') into v_tz
  from public.studios s where s.id = new.studio_id;

  v_start := (new.starts_on::timestamp) at time zone v_tz;
  v_end   := ((new.ends_on + 1)::timestamp) at time zone v_tz;

  perform public.fanout_studio_wide_reservation(
    new.studio_id, 'full_day_blockout', new.id, v_start, v_end);
  return null;
end;
$$;

create or replace function public.sync_recurring_break_occurrence_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'recurring_break_occurrence' and source_id = old.id;
    return null;
  end if;
  perform public.fanout_studio_wide_reservation(
    new.studio_id, 'recurring_break_occurrence', new.id, new.starts_at, new.ends_at);
  return null;
end;
$$;

-- The full_day_blockout tz-rebuild function (0030) needs no change: it updates
-- starts_at/ends_at by source_id and leaves resource_key untouched, so it
-- correctly re-times all fanned rows for a blockout at once.

-- ---------------------------------------------------------------------------
-- Step 8: forward-safe re-sync on practitioner reassignment. Add
-- practitioner_id to the appointment mirror trigger's column list so a future
-- reassignment (PR C) re-keys the shadow. capacity_enabled is deliberately NOT
-- in the list — the flag-flip path (Step 9) owns that transition authoritatively.
-- ---------------------------------------------------------------------------
create or replace trigger appointments_sync_calendar_reservation_trg
  after insert or delete
  or update of status, studio_id, starts_at, ends_at, blocked_ends_at, practitioner_id
  on public.appointments
  for each row
  execute function public.sync_appointment_to_calendar_reservation();

-- ---------------------------------------------------------------------------
-- Step 9: authoritative studio rebuild + structural-change triggers.
--
-- rematerialize_studio_reservations rebuilds a studio's ENTIRE shadow from the
-- source tables under the CURRENT flag. Used at activation (flag flip) and when
-- the active-practitioner set changes on an ON studio. Idempotent.
-- ---------------------------------------------------------------------------
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

  -- Keep the appointment mirror consistent with the flag. This UPDATE targets
  -- only capacity_enabled, which is in NEITHER the BEFORE nor the AFTER
  -- appointment trigger's column list, so it sets the value directly without
  -- re-firing either. It is CHECK-gated: activating a studio whose confirmed
  -- appointment lacks a practitioner_id fails here (fail-closed activation).
  update public.appointments
    set capacity_enabled = v_enabled
    where studio_id = p_studio_id and capacity_enabled is distinct from v_enabled;

  delete from public.studio_calendar_reservations where studio_id = p_studio_id;

  -- Appointments (confirmed + completed), one row each.
  insert into public.studio_calendar_reservations
    (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
  select a.studio_id, a.practitioner_id,
         case when v_enabled then a.practitioner_id else a.studio_id end,
         'appointment', a.id, a.starts_at, a.blocked_ends_at
  from public.appointments a
  where a.studio_id = p_studio_id and a.status in ('confirmed', 'completed');

  -- Studio-wide sources, fanned per active practitioner when ON.
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

-- Flag flip -> rebuild. OFF->ON is always safe on existing data (rows that were
-- non-overlapping studio-wide are trivially non-overlapping per-practitioner).
-- ON->OFF re-imposes the studio-wide exclusion and will raise 23P01 if two
-- practitioners hold overlapping appointments — deactivation must resolve those
-- first (a separately-authorized concern; never reached while default OFF).
create or replace function public.on_studio_capacity_flag_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.practitioner_capacity_enabled is distinct from old.practitioner_capacity_enabled then
    perform public.rematerialize_studio_reservations(new.id);
  end if;
  return new;
end;
$$;

create or replace trigger studios_capacity_flag_change_trg
  after update of practitioner_capacity_enabled
  on public.studios
  for each row
  execute function public.on_studio_capacity_flag_change();

-- Practitioner-set change on an ON studio -> re-fan its studio-wide blocks. A
-- newly-added practitioner must inherit existing blocks; a removed one has their
-- fanned rows dropped by the shadow.practitioner_id ON DELETE CASCADE and the
-- rebuild here re-derives the rest. Fires on INSERT/DELETE/studio move only:
-- because fan-out covers ALL practitioners (Step 7b), a mere active-state toggle
-- does not change the fan set, so it needs no re-fan. No-op for OFF studios.
create or replace function public.on_practitioner_change_refan()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.studio_capacity_enabled(old.studio_id) then
      perform public.rematerialize_studio_reservations(old.studio_id);
    end if;
    return null;
  end if;

  -- INSERT, or UPDATE that moved the practitioner between studios
  -- (unique(studio_id,user_id) makes the latter rare): re-fan both studios.
  if tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id
     and public.studio_capacity_enabled(old.studio_id) then
    perform public.rematerialize_studio_reservations(old.studio_id);
  end if;
  if public.studio_capacity_enabled(new.studio_id) then
    perform public.rematerialize_studio_reservations(new.studio_id);
  end if;
  return null;
end;
$$;

create or replace trigger practitioners_capacity_refan_trg
  after insert or delete or update of studio_id
  on public.practitioners
  for each row
  execute function public.on_practitioner_change_refan();

-- ---------------------------------------------------------------------------
-- Step 10: service -> practitioner eligibility. Additive. Same-studio enforced
-- via composite FKs to the 0032 companion uniques (services_id_studio_id_unique,
-- practitioners_id_studio_id_unique). Owner-managed, active practitioners only,
-- never invented at booking time.
-- ---------------------------------------------------------------------------
create table if not exists public.service_practitioners (
  id              uuid primary key default gen_random_uuid(),
  studio_id       uuid not null references public.studios(id) on delete cascade,
  service_id      uuid not null,
  practitioner_id uuid not null,
  created_at      timestamptz not null default now(),
  constraint service_practitioners_service_fk
    foreign key (service_id, studio_id)
    references public.services (id, studio_id) on delete cascade,
  constraint service_practitioners_practitioner_fk
    foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete cascade,
  constraint service_practitioners_unique unique (service_id, practitioner_id)
);

create index if not exists service_practitioners_studio_idx
  on public.service_practitioners (studio_id);
create index if not exists service_practitioners_practitioner_idx
  on public.service_practitioners (practitioner_id);

alter table public.service_practitioners enable row level security;

drop policy if exists "service_practitioners_owner_all" on public.service_practitioners;
create policy "service_practitioners_owner_all"
  on public.service_practitioners
  for all
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

drop policy if exists "service_practitioners_member_select" on public.service_practitioners;
create policy "service_practitioners_member_select"
  on public.service_practitioners
  for select
  using (public.is_studio_member(studio_id));

-- Backfill = every ACTIVE practitioner eligible for every service in the same
-- studio. This is behaviourally identical to today, where booking ignores
-- service when choosing a practitioner. Re-runnable.
insert into public.service_practitioners (studio_id, service_id, practitioner_id)
select s.studio_id, s.id, p.id
from public.services s
join public.practitioners p
  on p.studio_id = s.studio_id and p.active = true
on conflict on constraint service_practitioners_unique do nothing;

-- Keep the permissive default going forward: a NEW service is eligible for
-- every active practitioner in its studio, and a newly-added/reactivated
-- practitioner is eligible for every service. This preserves today's
-- unrestricted assignment as the default so a studio can never end up with a
-- service that has no eligible practitioner; PR C's owner UI RESTRICTS from
-- this permissive baseline. Eligibility is ignored entirely while the capacity
-- flag is OFF, so these triggers are behaviour-neutral for Willow.
create or replace function public.default_eligibility_for_service()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.service_practitioners (studio_id, service_id, practitioner_id)
  select new.studio_id, new.id, p.id
  from public.practitioners p
  where p.studio_id = new.studio_id and p.active = true
  on conflict on constraint service_practitioners_unique do nothing;
  return null;
end;
$$;

create or replace trigger services_default_eligibility_trg
  after insert on public.services
  for each row
  execute function public.default_eligibility_for_service();

create or replace function public.default_eligibility_for_practitioner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.active = true then
    insert into public.service_practitioners (studio_id, service_id, practitioner_id)
    select new.studio_id, s.id, new.id
    from public.services s
    where s.studio_id = new.studio_id
    on conflict on constraint service_practitioners_unique do nothing;
  end if;
  return null;
end;
$$;

create or replace trigger practitioners_default_eligibility_trg
  after insert or update of active on public.practitioners
  for each row
  execute function public.default_eligibility_for_practitioner();

-- ---------------------------------------------------------------------------
-- Step 11: lock down the new/redefined SECURITY DEFINER functions. Match the
-- 0030/0031 posture — no direct client execute; they run only inside triggers /
-- authorized server RPCs.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.set_appointment_capacity_enabled()',
    'public.studio_capacity_enabled(uuid)',
    'public.fanout_studio_wide_reservation(uuid, text, uuid, timestamptz, timestamptz)',
    'public.sync_appointment_to_calendar_reservation()',
    'public.sync_timed_block_to_calendar_reservation()',
    'public.sync_blockout_to_calendar_reservation()',
    'public.sync_recurring_break_occurrence_to_calendar_reservation()',
    'public.rematerialize_studio_reservations(uuid)',
    'public.on_studio_capacity_flag_change()',
    'public.on_practitioner_change_refan()',
    'public.default_eligibility_for_service()',
    'public.default_eligibility_for_practitioner()',
    'public.set_reservation_resource_key_default()'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;
end $$;

commit;
