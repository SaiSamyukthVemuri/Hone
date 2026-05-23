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
-- TWO ADMIN OPERATIONS retroactively touch existing reservations:
--   - studios.timezone change rebuilds full_day_blockout reservation
--     rows. Appointment- and timed-block-derived reservations are
--     not touched because their stored intervals are absolute UTC.
--   - studios.buffer_minutes change recomputes appointment-derived
--     buffer snapshots and blocked_ends_at, which cascades through
--     the appointment AFTER trigger and re-mirrors the shadow rows.
-- Either operation aborts the studios UPDATE entirely if a
-- recomputed reservation would collide with another row.
--
-- The 0029 snapshot trigger gains an additive bypass: when a
-- session-scoped flag is set, the trigger trusts NEW's explicit
-- buffer_minutes_snapshot and blocked_ends_at values rather than
-- preserving OLD. Default behavior with no flag is unchanged.
--
-- Install procedure:
--   1. Outside the txn, run Block 0 read-only diagnostics. ALL three
--      must return 0 rows: (A) confirmed appt vs full-day blockout
--      overlap, (B) blockout vs blockout overlap, (C) confirmed appt
--      vs confirmed appt overlap on buffered intervals.
--   2. Paste this file as one transaction. Source tables are locked
--      EXCLUSIVE for the migration's duration to prevent concurrent
--      writes during backfill / validation / constraint install.
--
-- Re-runnable: backfill uses ON CONFLICT DO UPDATE on the unique
-- (source_kind, source_id) constraint (NOT on the exclusion);
-- constraint and trigger creations are gated on existence; the
-- exclusion is added last and only after step-5 validators pass.

begin;

-- ---------------------------------------------------------------------------
-- Step 0: lock source tables. EXCLUSIVE mode prevents concurrent
-- INSERT/UPDATE/DELETE during the migration window while still
-- allowing plain SELECT. The new studio_timed_blocks and
-- studio_calendar_reservations don't exist yet, so they get no
-- lock here (they'll be created and locked implicitly by DDL).
-- ---------------------------------------------------------------------------
lock table public.appointments in exclusive mode;
lock table public.studio_blockouts in exclusive mode;
lock table public.studios in exclusive mode;

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
-- ON CONFLICT arbiter is the unique (source_kind, source_id), NOT
-- the exclusion constraint added in step 6.
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

-- SELECT only. INSERT/UPDATE/DELETE have no policy and the table
-- default-denies; only the SECURITY DEFINER trigger functions write
-- to the shadow.
drop policy if exists "studio_calendar_reservations_member_select"
  on public.studio_calendar_reservations;
create policy "studio_calendar_reservations_member_select"
  on public.studio_calendar_reservations
  for select
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- Step 3: trigger functions. All SECURITY DEFINER, hardened
-- search_path = pg_catalog, pg_temp, with every non-pg_catalog
-- reference schema-qualified as public.* .
-- ---------------------------------------------------------------------------

-- 3a. Re-define the 0029 snapshot trigger with an ADDITIVE bypass
-- branch. When app.bypass_appointment_buffer_snapshot = 'on',
-- the trigger trusts NEW's explicit values instead of preserving
-- OLD. This lets the studios buffer-change trigger (3e) issue
-- direct UPDATE on appointments to retroactively resync snapshots.
-- Default behavior (flag unset) is UNCHANGED from migration 0029.
create or replace function public.snapshot_appointment_buffer()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_buffer integer;
begin
  if current_setting('app.bypass_appointment_buffer_snapshot', true) = 'on' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.studio_id = old.studio_id
     and new.starts_at = old.starts_at
     and new.ends_at   = old.ends_at
     and old.buffer_minutes_snapshot is not null
     and old.blocked_ends_at is not null
  then
    new.buffer_minutes_snapshot := old.buffer_minutes_snapshot;
    new.blocked_ends_at := old.blocked_ends_at;
    return new;
  end if;

  select coalesce(s.buffer_minutes, 0) into v_buffer
  from public.studios s
  where s.id = new.studio_id;

  if v_buffer is null then
    v_buffer := 0;
  end if;

  new.buffer_minutes_snapshot := v_buffer;
  new.blocked_ends_at := new.ends_at + make_interval(mins => v_buffer);
  return new;
end;
$$;

-- 3b. Appointments -> reservations mirror.
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
    on conflict on constraint studio_calendar_reservations_source_unique
    do update set
      studio_id = excluded.studio_id,
      starts_at = excluded.starts_at,
      ends_at   = excluded.ends_at;
  else
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id;
  end if;

  return null;
end;
$$;

-- 3c. Timed blocks -> reservations mirror.
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
  on conflict on constraint studio_calendar_reservations_source_unique
  do update set
    studio_id = excluded.studio_id,
    starts_at = excluded.starts_at,
    ends_at   = excluded.ends_at;

  return null;
end;
$$;

-- 3d. Full-day blockouts -> reservations mirror. UTC instants
-- derived from studio.timezone at write time.
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
  on conflict on constraint studio_calendar_reservations_source_unique
  do update set
    studio_id = excluded.studio_id,
    starts_at = excluded.starts_at,
    ends_at   = excluded.ends_at;

  return null;
end;
$$;

-- 3e. Studio timezone change -> rebuild full_day_blockout
-- reservations only. Appointment- and timed-block-derived
-- reservation rows store absolute UTC instants and are NOT touched.
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

-- 3f. Studio buffer_minutes change -> retroactively resync confirmed
-- appointments' buffer_minutes_snapshot and blocked_ends_at. Cascades
-- through the appointments AFTER trigger (3b) which re-upserts each
-- shadow row with the new interval. If any new interval collides with
-- another reservation, the shadow's exclusion raises sqlstate 23P01
-- and the entire studios UPDATE rolls back.
--
-- The bypass flag is set with is_local=true so it lives only for
-- this transaction; commit or rollback resets it.
create or replace function public.resync_appointments_on_studio_buffer_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_new_buffer integer := coalesce(new.buffer_minutes, 0);
begin
  if new.buffer_minutes is not distinct from old.buffer_minutes then
    return new;
  end if;

  perform set_config('app.bypass_appointment_buffer_snapshot', 'on', true);

  begin
    update public.appointments
    set buffer_minutes_snapshot = v_new_buffer,
        blocked_ends_at = ends_at + make_interval(mins => v_new_buffer),
        updated_at = now()
    where studio_id = new.id
      and status = 'confirmed';
  exception when others then
    perform set_config('app.bypass_appointment_buffer_snapshot', 'off', true);
    raise;
  end;

  perform set_config('app.bypass_appointment_buffer_snapshot', 'off', true);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: backfill existing data. ON CONFLICT arbiter is the unique
-- (source_kind, source_id), not the exclusion. Safe to re-run.
-- ---------------------------------------------------------------------------
insert into public.studio_calendar_reservations
  (studio_id, source_kind, source_id, starts_at, ends_at)
select a.studio_id, 'appointment', a.id, a.starts_at, a.blocked_ends_at
from public.appointments a
where a.status = 'confirmed'
on conflict on constraint studio_calendar_reservations_source_unique
do update set
  studio_id = excluded.studio_id,
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
on conflict on constraint studio_calendar_reservations_source_unique
do update set
  studio_id = excluded.studio_id,
  starts_at = excluded.starts_at,
  ends_at   = excluded.ends_at;

-- ---------------------------------------------------------------------------
-- Step 5: validators. Each raises -> entire transaction rolls back.
-- Order: structural -> overlap -> parity (presence / absence /
-- interval calculation).
-- ---------------------------------------------------------------------------

-- 5a. Structural integrity.
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

-- 5b. No within-studio overlap among reservation rows.
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

-- 5c. Parity: every confirmed appointment has an appointment reservation.
do $$
begin
  if exists (
    select 1 from public.appointments a
    where a.status = 'confirmed'
      and not exists (
        select 1 from public.studio_calendar_reservations r
        where r.source_kind = 'appointment' and r.source_id = a.id
      )
  ) then
    raise exception 'Backfill parity failed: confirmed appointment missing reservation';
  end if;
end $$;

-- 5d. Parity: no non-confirmed appointment retains a reservation.
do $$
begin
  if exists (
    select 1 from public.studio_calendar_reservations r
    join public.appointments a on a.id = r.source_id
    where r.source_kind = 'appointment'
      and a.status <> 'confirmed'
  ) then
    raise exception 'Backfill parity failed: non-confirmed appointment has reservation';
  end if;
end $$;

-- 5e. Parity: every full-day blockout has a reservation.
do $$
begin
  if exists (
    select 1 from public.studio_blockouts b
    where not exists (
      select 1 from public.studio_calendar_reservations r
      where r.source_kind = 'full_day_blockout' and r.source_id = b.id
    )
  ) then
    raise exception 'Backfill parity failed: full-day blockout missing reservation';
  end if;
end $$;

-- 5f. Parity: no orphan reservation rows.
do $$
begin
  if exists (
    select 1 from public.studio_calendar_reservations r
    where r.source_kind = 'appointment'
      and not exists (select 1 from public.appointments a where a.id = r.source_id)
  ) or exists (
    select 1 from public.studio_calendar_reservations r
    where r.source_kind = 'full_day_blockout'
      and not exists (select 1 from public.studio_blockouts b where b.id = r.source_id)
  ) or exists (
    select 1 from public.studio_calendar_reservations r
    where r.source_kind = 'timed_block'
      and not exists (
        select 1 from public.studio_timed_blocks tb where tb.id = r.source_id
      )
  ) then
    raise exception 'Backfill parity failed: orphan reservation rows';
  end if;
end $$;

-- 5g. Parity: reservation intervals exactly match source calculation.
do $$
begin
  if exists (
    select 1
    from public.studio_calendar_reservations r
    join public.appointments a on a.id = r.source_id
    where r.source_kind = 'appointment'
      and (r.starts_at <> a.starts_at or r.ends_at <> a.blocked_ends_at)
  ) then
    raise exception 'Backfill parity failed: appointment reservation interval drift';
  end if;

  if exists (
    select 1
    from public.studio_calendar_reservations r
    join public.studio_blockouts b on b.id = r.source_id
    join public.studios s on s.id = b.studio_id
    where r.source_kind = 'full_day_blockout'
      and (
        r.starts_at <> (b.starts_on::timestamp)
                       at time zone coalesce(s.timezone, 'America/Toronto')
        or
        r.ends_at <> ((b.ends_on + 1)::timestamp)
                     at time zone coalesce(s.timezone, 'America/Toronto')
      )
  ) then
    raise exception 'Backfill parity failed: full_day_blockout reservation interval drift';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 6: unified cross-type exclusion constraint.
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
-- Step 7: triggers. Narrow UPDATE column lists so irrelevant column
-- changes (email send timestamps, intake notes, audit columns) do
-- not re-fire the mirror.
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

create or replace trigger studios_resync_appointments_on_buffer_change_trg
  after update of buffer_minutes
  on public.studios
  for each row
  execute function public.resync_appointments_on_studio_buffer_change();

-- ---------------------------------------------------------------------------
-- Step 8: revoke direct execute on every trigger function. They run
-- via the trigger machinery as SECURITY DEFINER; no PostgREST caller
-- should be able to invoke them directly.
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

revoke execute on function public.resync_appointments_on_studio_buffer_change() from public;
revoke execute on function public.resync_appointments_on_studio_buffer_change() from anon;
revoke execute on function public.resync_appointments_on_studio_buffer_change() from authenticated;

commit;
