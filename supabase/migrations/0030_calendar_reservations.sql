-- Migration 0030: unified calendar reservations.
--
-- Adds a shadow table studio_calendar_reservations that holds every
-- concrete unavailable interval for a studio. Three source kinds
-- mirror into it via AFTER triggers:
--   - 'appointment'         -> appointments.status = 'confirmed',
--                              using [starts_at, blocked_ends_at)
--                              so the migration 0029 trailing buffer
--                              composes with blocks.
--   - 'timed_block'         -> studio_timed_blocks (new) raw range.
--   - 'full_day_blockout'   -> studio_blockouts, projected to
--                              [local midnight starts_on,
--                               local midnight ends_on + 1 day)
--                              using the studio's current timezone.
--
-- A single gist exclusion constraint on the shadow enforces non-
-- overlap across ALL three kinds. Migration 0029's appointment-
-- only exclusion is preserved as-is; the shadow's exclusion is
-- the cross-type layer added on top.
--
-- 'recurring_break_occurrence' is included in the source_kind check
-- now so Phase 2 can begin inserting occurrences without a schema
-- change. No occurrences are generated in this migration.
--
-- A trigger on public.studios rebuilds full_day_blockout reservation
-- rows when timezone changes; if the recalculated intervals would
-- conflict with any other reservation, the UPDATE rolls back.
--
-- Install procedure:
--   1. Run the read-only diagnostics in Block 0 outside the txn.
--      Both must return 0 rows.
--   2. Paste this file as a single transaction.
--
-- Re-runnable: backfill uses ON CONFLICT DO UPDATE; constraint and
-- trigger creations are gated on existence; the exclusion is added
-- last and only after the backfill validates clean.

begin;

-- ---------------------------------------------------------------------------
-- Step 1: studio_timed_blocks. One-off time-specific blocks.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_timed_blocks (
  id           uuid primary key default gen_random_uuid(),
  studio_id    uuid not null references public.studios(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  category     text not null,
  private_note text,
  created_by   uuid references public.practitioners(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_timed_blocks_range_check'
      and conrelid = 'public.studio_timed_blocks'::regclass
  ) then
    alter table public.studio_timed_blocks
      add constraint studio_timed_blocks_range_check
      check (ends_at > starts_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_timed_blocks_category_check'
      and conrelid = 'public.studio_timed_blocks'::regclass
  ) then
    alter table public.studio_timed_blocks
      add constraint studio_timed_blocks_category_check
      check (category in (
        'lunch','break','meeting','emergency',
        'personal','training','admin','other'
      ));
  end if;
end $$;

create index if not exists studio_timed_blocks_studio_starts_idx
  on public.studio_timed_blocks (studio_id, starts_at);

alter table public.studio_timed_blocks enable row level security;

drop policy if exists "studio_timed_blocks_owner_all" on public.studio_timed_blocks;
create policy "studio_timed_blocks_owner_all"
  on public.studio_timed_blocks
  for all
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

drop policy if exists "studio_timed_blocks_member_select" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_select"
  on public.studio_timed_blocks
  for select
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- Step 2: studio_calendar_reservations. Cross-type shadow.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_calendar_reservations (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references public.studios(id) on delete cascade,
  source_kind text not null,
  source_id   uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_calendar_reservations_kind_check'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      add constraint studio_calendar_reservations_kind_check
      check (source_kind in (
        'appointment',
        'timed_block',
        'full_day_blockout',
        'recurring_break_occurrence'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_calendar_reservations_range_check'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      add constraint studio_calendar_reservations_range_check
      check (ends_at > starts_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_calendar_reservations_source_unique'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      add constraint studio_calendar_reservations_source_unique
      unique (source_kind, source_id);
  end if;
end $$;

create index if not exists studio_calendar_reservations_studio_starts_idx
  on public.studio_calendar_reservations (studio_id, starts_at);

alter table public.studio_calendar_reservations enable row level security;

drop policy if exists "studio_calendar_reservations_member_select"
  on public.studio_calendar_reservations;
create policy "studio_calendar_reservations_member_select"
  on public.studio_calendar_reservations
  for select
  using (public.is_studio_member(studio_id));

-- INSERT/UPDATE/DELETE intentionally have no policy. Only the
-- SECURITY DEFINER trigger functions write to this table; they
-- bypass RLS via function-owner privileges. Direct writes from any
-- application client are forbidden by default-deny.

-- ---------------------------------------------------------------------------
-- Step 3: trigger functions. SECURITY DEFINER, hardened search_path,
-- schema-qualified throughout.
-- ---------------------------------------------------------------------------

-- Appointments -> reservations.
create or replace function public.sync_appointment_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = old.id;
    return null;
  end if;

  if new.status = 'confirmed' then
    insert into public.studio_calendar_reservations
      (studio_id, source_kind, source_id, starts_at, ends_at)
    values
      (new.studio_id, 'appointment', new.id, new.starts_at, new.blocked_ends_at)
    on conflict (source_kind, source_id) do update
      set studio_id = excluded.studio_id,
          starts_at = excluded.starts_at,
          ends_at   = excluded.ends_at;
  else
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id;
  end if;

  return null;
end;
$$;

-- Timed blocks -> reservations.
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

  insert into public.studio_calendar_reservations
    (studio_id, source_kind, source_id, starts_at, ends_at)
  values
    (new.studio_id, 'timed_block', new.id, new.starts_at, new.ends_at)
  on conflict (source_kind, source_id) do update
    set studio_id = excluded.studio_id,
        starts_at = excluded.starts_at,
        ends_at   = excluded.ends_at;

  return null;
end;
$$;

-- Full-day blockouts -> reservations. UTC instants derived from
-- studio.timezone at write time. Stored explicitly so a later
-- timezone change must be reconciled via the studio-timezone
-- trigger (step 7) rather than silently drifting.
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
  from public.studios s
  where s.id = new.studio_id;

  v_start := (new.starts_on::timestamp) at time zone v_tz;
  v_end   := ((new.ends_on + 1)::timestamp) at time zone v_tz;

  insert into public.studio_calendar_reservations
    (studio_id, source_kind, source_id, starts_at, ends_at)
  values
    (new.studio_id, 'full_day_blockout', new.id, v_start, v_end)
  on conflict (source_kind, source_id) do update
    set studio_id = excluded.studio_id,
        starts_at = excluded.starts_at,
        ends_at   = excluded.ends_at;

  return null;
end;
$$;

-- Studio timezone change -> recompute that studio's full_day_blockout
-- reservation rows. If the recalculated intervals collide with any
-- other reservation, the UPDATE on studios fails and rolls back the
-- entire transaction.
create or replace function public.rebuild_blockout_reservations_for_studio_tz()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz text := coalesce(new.timezone, 'America/Toronto');
begin
  if new.timezone is not distinct from old.timezone then
    return new;
  end if;

  update public.studio_calendar_reservations r
  set starts_at = (b.starts_on::timestamp) at time zone v_tz,
      ends_at   = ((b.ends_on + 1)::timestamp) at time zone v_tz
  from public.studio_blockouts b
  where r.source_kind = 'full_day_blockout'
    and r.source_id = b.id
    and r.studio_id = new.id;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: backfill existing confirmed appointments and existing
-- full-day blockouts into the shadow. UPSERT so a re-run is a no-op.
-- The shadow's exclusion constraint is NOT in place yet; we install
-- it in step 6 after step 5 validates clean.
-- ---------------------------------------------------------------------------
insert into public.studio_calendar_reservations
  (studio_id, source_kind, source_id, starts_at, ends_at)
select a.studio_id, 'appointment', a.id, a.starts_at, a.blocked_ends_at
from public.appointments a
where a.status = 'confirmed'
on conflict (source_kind, source_id) do update
  set studio_id = excluded.studio_id,
      starts_at = excluded.starts_at,
      ends_at   = excluded.ends_at;

insert into public.studio_calendar_reservations
  (studio_id, source_kind, source_id, starts_at, ends_at)
select b.studio_id,
       'full_day_blockout',
       b.id,
       (b.starts_on::timestamp) at time zone coalesce(s.timezone, 'America/Toronto'),
       ((b.ends_on + 1)::timestamp) at time zone coalesce(s.timezone, 'America/Toronto')
from public.studio_blockouts b
join public.studios s on s.id = b.studio_id
on conflict (source_kind, source_id) do update
  set studio_id = excluded.studio_id,
      starts_at = excluded.starts_at,
      ends_at   = excluded.ends_at;

-- ---------------------------------------------------------------------------
-- Step 5: validate the materialized shadow before adding the
-- exclusion constraint. Two checks:
--   5a. No NULLs, all ranges positive, all source_kinds known.
--   5b. No two shadow rows overlap within a studio. If either
--       check fails, the entire transaction rolls back.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.studio_calendar_reservations
    where studio_id is null
       or source_kind is null
       or source_id is null
       or starts_at is null
       or ends_at is null
       or ends_at <= starts_at
       or source_kind not in (
            'appointment','timed_block','full_day_blockout',
            'recurring_break_occurrence'
          )
  ) then
    raise exception
      'Backfill validation failed: studio_calendar_reservations has nulls, bad ranges, or unknown source_kind';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from public.studio_calendar_reservations r1
    join public.studio_calendar_reservations r2
      on r1.studio_id = r2.studio_id
     and r1.id < r2.id
     and tstzrange(r1.starts_at, r1.ends_at, '[)')
         && tstzrange(r2.starts_at, r2.ends_at, '[)')
  ) then
    raise exception
      'Existing reservations overlap within a studio; resolve before installing exclusion';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 6: btree_gist (idempotent, may already be installed by 0029)
-- + the unified cross-type exclusion constraint.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_calendar_reservations_per_studio'
      and conrelid = 'public.studio_calendar_reservations'::regclass
  ) then
    alter table public.studio_calendar_reservations
      add constraint no_overlapping_calendar_reservations_per_studio
      exclude using gist (
        studio_id with =,
        tstzrange(starts_at, ends_at, '[)') with &&
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 7: install AFTER triggers. UPDATE column lists are narrow so
-- irrelevant column changes (email send timestamps, intake notes,
-- audit columns) do not re-run the mirror.
-- ---------------------------------------------------------------------------
create or replace trigger appointments_sync_calendar_reservation_trg
  after insert or delete
  or update of status, studio_id, starts_at, ends_at, blocked_ends_at
  on public.appointments
  for each row
  execute function public.sync_appointment_to_calendar_reservation();

create or replace trigger studio_timed_blocks_sync_calendar_reservation_trg
  after insert or delete
  or update of studio_id, starts_at, ends_at
  on public.studio_timed_blocks
  for each row
  execute function public.sync_timed_block_to_calendar_reservation();

create or replace trigger studio_blockouts_sync_calendar_reservation_trg
  after insert or delete
  or update of studio_id, starts_on, ends_on
  on public.studio_blockouts
  for each row
  execute function public.sync_blockout_to_calendar_reservation();

create or replace trigger studios_rebuild_blockout_reservations_on_tz_change_trg
  after update of timezone
  on public.studios
  for each row
  execute function public.rebuild_blockout_reservations_for_studio_tz();

-- ---------------------------------------------------------------------------
-- Step 8: revoke direct execute on the trigger functions. They run
-- via the trigger machinery as SECURITY DEFINER; no caller should
-- invoke them directly via PostgREST.
-- ---------------------------------------------------------------------------
revoke execute on function public.sync_appointment_to_calendar_reservation() from public;
revoke execute on function public.sync_appointment_to_calendar_reservation() from anon;
revoke execute on function public.sync_appointment_to_calendar_reservation() from authenticated;

revoke execute on function public.sync_timed_block_to_calendar_reservation() from public;
revoke execute on function public.sync_timed_block_to_calendar_reservation() from anon;
revoke execute on function public.sync_timed_block_to_calendar_reservation() from authenticated;

revoke execute on function public.sync_blockout_to_calendar_reservation() from public;
revoke execute on function public.sync_blockout_to_calendar_reservation() from anon;
revoke execute on function public.sync_blockout_to_calendar_reservation() from authenticated;

revoke execute on function public.rebuild_blockout_reservations_for_studio_tz() from public;
revoke execute on function public.rebuild_blockout_reservations_for_studio_tz() from anon;
revoke execute on function public.rebuild_blockout_reservations_for_studio_tz() from authenticated;

commit;
