-- Migration 0031: Phase 2 recurring weekly breaks.
--
-- Adds two tables and one mirror trigger; reuses every reservation-
-- enforcement primitive from migration 0030. The migration does NOT
-- touch 0029 or 0030 in any way.
--
-- studio_recurring_break_rules     - owner-defined patterns
--   (label, days_of_week[], start/end local time, active toggle).
-- studio_recurring_break_occurrences - concrete dated instances
--   materialized within the public booking horizon (today + 90 days).
--   Each occurrence mirrors into the existing
--   studio_calendar_reservations shadow as
--   source_kind = 'recurring_break_occurrence'; the unified gist
--   exclusion (no_overlapping_calendar_reservations_per_studio,
--   installed in 0030) is the final race-safe enforcement against
--   appointments, timed blocks, and full-day blockouts.
--
-- Four RPCs:
--
--   materialize_recurring_break_rule(p_rule_id, p_horizon_end)
--     - idempotent inserts for the rule's matching weekdays from
--       today (in studio tz) through p_horizon_end. ON CONFLICT
--       DO NOTHING on (rule_id, occurrence_date) makes re-runs a
--       no-op when occurrences already exist. If any new occurrence
--       would collide with another reservation, the shadow's
--       exclusion raises 23P01 and the whole call rolls back.
--
--   create_recurring_break_rule_and_materialize(...)
--     - inserts the rule + materializes through the horizon
--       atomically. Returns the new rule id, or raises on conflict.
--
--   update_recurring_break_rule_and_rematerialize(p_rule_id,
--     p_studio_id, ...)
--     - p_studio_id is required so the admin-client caller cannot
--       touch a rule outside the asserted studio. Updates the
--       rule, deletes its future-or-in-progress occurrences, then
--       re-materializes through the horizon. All atomic.
--
--   delete_recurring_break_rule(p_rule_id, p_studio_id)
--     - same studio-scoping. Removes future-or-in-progress
--       occurrences (their shadow rows go via the AFTER DELETE
--       trigger), then deletes the rule. The FK on
--       occurrences.rule_id is ON DELETE SET NULL so past-history
--       occurrence rows survive as orphan records (their shadow
--       rows preserve audit of the protected time).
--
-- Also adds rebuild_recurring_break_occurrences_for_studio_tz, an
-- AFTER UPDATE OF timezone trigger that rebuilds future-or-in-
-- progress recurring occurrences for that studio under the new
-- timezone. Mirrors the 0030 trigger that handles full-day
-- blockouts; appointment and one-off timed-block reservations
-- store absolute UTC and are NOT touched.
--
-- Server actions authenticate the practitioner + assert owner via
-- the session client, then call the RPCs through createAdminClient()
-- (service_role) because EXECUTE is granted only to service_role.
-- The session client does NOT have permission to call these RPCs.
-- RLS allows owners/members SELECT only on the rule and occurrence
-- tables; writes are exclusively via the RPCs.
--
-- Install order:
--   1. Outside the txn, run Block 0 diagnostic (no existing
--      recurring breaks; first install).
--   2. Paste this file as one transaction.

begin;

-- ---------------------------------------------------------------------------
-- Step 0: lock the shadow + adjacent tables. Plain SELECT remains
-- allowed; writes block until commit/rollback. New tables get
-- their locks implicitly when DDL creates them.
-- ---------------------------------------------------------------------------
lock table public.studio_calendar_reservations in exclusive mode;
lock table public.appointments in exclusive mode;
lock table public.studio_blockouts in exclusive mode;
lock table public.studio_timed_blocks in exclusive mode;
lock table public.studios in exclusive mode;

-- ---------------------------------------------------------------------------
-- Step 1: rules table.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_recurring_break_rules (
  id               uuid primary key default gen_random_uuid(),
  studio_id        uuid not null references public.studios(id) on delete cascade,
  label            text not null,
  days_of_week     integer[] not null,
  start_local_time time not null,
  end_local_time   time not null,
  active           boolean not null default true,
  created_by       uuid references public.practitioners(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_recurring_break_rules_label_check'
      and conrelid = 'public.studio_recurring_break_rules'::regclass
  ) then
    alter table public.studio_recurring_break_rules
      add constraint studio_recurring_break_rules_label_check
      check (label in ('lunch','break','admin','other'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_recurring_break_rules_times_check'
      and conrelid = 'public.studio_recurring_break_rules'::regclass
  ) then
    alter table public.studio_recurring_break_rules
      add constraint studio_recurring_break_rules_times_check
      check (end_local_time > start_local_time);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_recurring_break_rules_days_check'
      and conrelid = 'public.studio_recurring_break_rules'::regclass
  ) then
    alter table public.studio_recurring_break_rules
      add constraint studio_recurring_break_rules_days_check
      check (
        array_length(days_of_week, 1) >= 1
        and days_of_week <@ array[0,1,2,3,4,5,6]
      );
  end if;
end $$;

create index if not exists studio_recurring_break_rules_studio_idx
  on public.studio_recurring_break_rules (studio_id);

alter table public.studio_recurring_break_rules enable row level security;

-- SELECT only. Direct INSERT/UPDATE/DELETE intentionally have no
-- policy (default-deny). A direct write would create a rule row
-- without its companion occurrences and shadow rows, leaving the
-- owner UI showing an "active" rule while clients can still book
-- over it. Every mutation MUST flow through the SECURITY DEFINER
-- RPCs (create_recurring_break_rule_and_materialize, etc.) which
-- run as service_role inside one transaction.
drop policy if exists "studio_recurring_break_rules_owner_all"
  on public.studio_recurring_break_rules;
drop policy if exists "studio_recurring_break_rules_member_select"
  on public.studio_recurring_break_rules;
create policy "studio_recurring_break_rules_member_select"
  on public.studio_recurring_break_rules
  for select
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- Step 2: occurrences table. ON DELETE SET NULL on rule_id so a
-- rule delete preserves past-history occurrences (and their shadow
-- rows) as orphans while removing future ones via the RPC.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_recurring_break_occurrences (
  id              uuid primary key default gen_random_uuid(),
  rule_id         uuid references public.studio_recurring_break_rules(id)
                       on delete set null,
  studio_id       uuid not null references public.studios(id) on delete cascade,
  occurrence_date date not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  created_at      timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_recurring_break_occurrences_range_check'
      and conrelid = 'public.studio_recurring_break_occurrences'::regclass
  ) then
    alter table public.studio_recurring_break_occurrences
      add constraint studio_recurring_break_occurrences_range_check
      check (ends_at > starts_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_recurring_break_occurrences_rule_date_unique'
      and conrelid = 'public.studio_recurring_break_occurrences'::regclass
  ) then
    alter table public.studio_recurring_break_occurrences
      add constraint studio_recurring_break_occurrences_rule_date_unique
      unique (rule_id, occurrence_date);
  end if;
end $$;

create index if not exists studio_recurring_break_occurrences_studio_starts_idx
  on public.studio_recurring_break_occurrences (studio_id, starts_at);

alter table public.studio_recurring_break_occurrences enable row level security;

-- SELECT only. INSERT/UPDATE/DELETE intentionally have no policy
-- (default-deny). The RPCs run as SECURITY DEFINER and bypass RLS.
drop policy if exists "studio_recurring_break_occurrences_member_select"
  on public.studio_recurring_break_occurrences;
create policy "studio_recurring_break_occurrences_member_select"
  on public.studio_recurring_break_occurrences
  for select
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- Step 3: mirror trigger. Same shape as the other three mirror
-- functions from migration 0030. Hardened search_path, schema-
-- qualified, SECURITY DEFINER.
-- ---------------------------------------------------------------------------
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

  insert into public.studio_calendar_reservations
    (studio_id, source_kind, source_id, starts_at, ends_at)
  values
    (new.studio_id, 'recurring_break_occurrence', new.id, new.starts_at, new.ends_at)
  on conflict on constraint studio_calendar_reservations_source_unique
  do update set
    studio_id = excluded.studio_id,
    starts_at = excluded.starts_at,
    ends_at   = excluded.ends_at;

  return null;
end;
$$;

create or replace trigger studio_recurring_break_occurrences_sync_calendar_reservation_trg
  after insert or delete
  or update of studio_id, starts_at, ends_at
  on public.studio_recurring_break_occurrences
  for each row
  execute function public.sync_recurring_break_occurrence_to_calendar_reservation();

revoke execute on function public.sync_recurring_break_occurrence_to_calendar_reservation()
  from public;
revoke execute on function public.sync_recurring_break_occurrence_to_calendar_reservation()
  from anon;
revoke execute on function public.sync_recurring_break_occurrence_to_calendar_reservation()
  from authenticated;

-- ---------------------------------------------------------------------------
-- Step 4: materialize_recurring_break_rule. Idempotent generator.
-- Re-runs are no-ops because of the ON CONFLICT DO NOTHING on the
-- unique (rule_id, occurrence_date) constraint.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_recurring_break_rule(
  p_rule_id      uuid,
  p_horizon_end  date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rule       public.studio_recurring_break_rules%rowtype;
  v_studio_tz  text;
  v_today_loc  date;
  v_iter       date;
  v_dow        integer;
  v_starts_at  timestamptz;
  v_ends_at    timestamptz;
begin
  select * into v_rule
  from public.studio_recurring_break_rules
  where id = p_rule_id;

  if not found or not v_rule.active then
    return;
  end if;

  select coalesce(s.timezone, 'America/Toronto') into v_studio_tz
  from public.studios s
  where s.id = v_rule.studio_id;

  v_today_loc := (now() at time zone v_studio_tz)::date;
  v_iter := v_today_loc;

  while v_iter <= p_horizon_end loop
    v_dow := extract(dow from v_iter)::integer;  -- 0=Sun..6=Sat
    if v_dow = any (v_rule.days_of_week) then
      v_starts_at := (v_iter::text || ' ' || v_rule.start_local_time::text)::timestamp
                     at time zone v_studio_tz;
      v_ends_at   := (v_iter::text || ' ' || v_rule.end_local_time::text)::timestamp
                     at time zone v_studio_tz;

      -- Skip occurrences whose entire interval has already passed.
      -- This protects today's completed lunch history when a rule
      -- is rematerialized later the same day, and prevents the
      -- cron from re-inserting yesterday's already-completed
      -- occurrence after history was preserved.
      if v_ends_at > now() then
        insert into public.studio_recurring_break_occurrences
          (rule_id, studio_id, occurrence_date, starts_at, ends_at)
        values
          (p_rule_id, v_rule.studio_id, v_iter, v_starts_at, v_ends_at)
        on conflict on constraint studio_recurring_break_occurrences_rule_date_unique
        do nothing;
      end if;
      -- AFTER INSERT trigger fires for new rows and upserts the
      -- shadow. A shadow exclusion raise (23P01) aborts this
      -- function and the outer transaction.
    end if;
    v_iter := v_iter + 1;
  end loop;
end;
$$;

revoke execute on function public.materialize_recurring_break_rule(uuid, date) from public;
revoke execute on function public.materialize_recurring_break_rule(uuid, date) from anon;
revoke execute on function public.materialize_recurring_break_rule(uuid, date) from authenticated;
grant execute on function public.materialize_recurring_break_rule(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Step 5: create + materialize RPC.
-- ---------------------------------------------------------------------------
create or replace function public.create_recurring_break_rule_and_materialize(
  p_studio_id        uuid,
  p_label            text,
  p_days_of_week     integer[],
  p_start_local_time time,
  p_end_local_time   time,
  p_active           boolean,
  p_created_by       uuid,
  p_horizon_end      date
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rule_id uuid;
begin
  insert into public.studio_recurring_break_rules
    (studio_id, label, days_of_week, start_local_time, end_local_time,
     active, created_by)
  values
    (p_studio_id, p_label, p_days_of_week, p_start_local_time,
     p_end_local_time, p_active, p_created_by)
  returning id into v_rule_id;

  if p_active then
    perform public.materialize_recurring_break_rule(v_rule_id, p_horizon_end);
  end if;

  return v_rule_id;
end;
$$;

revoke execute on function public.create_recurring_break_rule_and_materialize(
  uuid, text, integer[], time, time, boolean, uuid, date
) from public;
revoke execute on function public.create_recurring_break_rule_and_materialize(
  uuid, text, integer[], time, time, boolean, uuid, date
) from anon;
revoke execute on function public.create_recurring_break_rule_and_materialize(
  uuid, text, integer[], time, time, boolean, uuid, date
) from authenticated;
grant execute on function public.create_recurring_break_rule_and_materialize(
  uuid, text, integer[], time, time, boolean, uuid, date
) to service_role;

-- ---------------------------------------------------------------------------
-- Step 6: update + re-materialize RPC. Past occurrences are
-- preserved; only future ones are regenerated. The FOR UPDATE on
-- the rule row blocks concurrent edits.
-- ---------------------------------------------------------------------------
-- p_studio_id is required so the caller (admin client) cannot
-- accidentally or maliciously touch a rule owned by a different
-- studio. The lock + UPDATE both filter on (id, studio_id).
create or replace function public.update_recurring_break_rule_and_rematerialize(
  p_rule_id          uuid,
  p_studio_id        uuid,
  p_label            text,
  p_days_of_week     integer[],
  p_start_local_time time,
  p_end_local_time   time,
  p_active           boolean,
  p_horizon_end      date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_exists boolean;
begin
  select true into v_exists
  from public.studio_recurring_break_rules
  where id = p_rule_id
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'recurring break rule not found' using errcode = 'P0002';
  end if;

  update public.studio_recurring_break_rules
  set label = p_label,
      days_of_week = p_days_of_week,
      start_local_time = p_start_local_time,
      end_local_time = p_end_local_time,
      active = p_active,
      updated_at = now()
  where id = p_rule_id
    and studio_id = p_studio_id;

  -- Future or in-progress occurrences only: ends_at > now() so
  -- today's already-completed lunch history is preserved. The
  -- AFTER DELETE trigger removes the corresponding shadow rows.
  delete from public.studio_recurring_break_occurrences
  where rule_id = p_rule_id
    and ends_at > now();

  if p_active then
    perform public.materialize_recurring_break_rule(p_rule_id, p_horizon_end);
  end if;
end;
$$;

revoke execute on function public.update_recurring_break_rule_and_rematerialize(
  uuid, uuid, text, integer[], time, time, boolean, date
) from public;
revoke execute on function public.update_recurring_break_rule_and_rematerialize(
  uuid, uuid, text, integer[], time, time, boolean, date
) from anon;
revoke execute on function public.update_recurring_break_rule_and_rematerialize(
  uuid, uuid, text, integer[], time, time, boolean, date
) from authenticated;
grant execute on function public.update_recurring_break_rule_and_rematerialize(
  uuid, uuid, text, integer[], time, time, boolean, date
) to service_role;

-- ---------------------------------------------------------------------------
-- Step 7: delete RPC. Removes future occurrences (and their
-- shadow rows via trigger), then deletes the rule. Past
-- occurrences survive as orphans via ON DELETE SET NULL on
-- occurrences.rule_id, preserving their shadow rows.
-- ---------------------------------------------------------------------------
-- p_studio_id is required for the same reason as the update RPC:
-- the admin client must never delete a rule owned by another studio.
create or replace function public.delete_recurring_break_rule(
  p_rule_id   uuid,
  p_studio_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_exists boolean;
begin
  select true into v_exists
  from public.studio_recurring_break_rules
  where id = p_rule_id
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'recurring break rule not found' using errcode = 'P0002';
  end if;

  -- Future or in-progress occurrences only; past history is
  -- preserved as orphans (rule_id SET NULL on rule delete).
  delete from public.studio_recurring_break_occurrences
  where rule_id = p_rule_id
    and ends_at > now();

  delete from public.studio_recurring_break_rules
  where id = p_rule_id
    and studio_id = p_studio_id;
end;
$$;

revoke execute on function public.delete_recurring_break_rule(uuid, uuid) from public;
revoke execute on function public.delete_recurring_break_rule(uuid, uuid) from anon;
revoke execute on function public.delete_recurring_break_rule(uuid, uuid) from authenticated;
grant execute on function public.delete_recurring_break_rule(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Step 8: studio timezone change rebuilds future recurring break
-- occurrences for that studio. Migration 0030's
-- rebuild_blockout_reservations_for_studio_tz handles full-day
-- blockouts; this trigger does the same for recurring occurrences.
-- Appointment and one-off timed-block reservations are absolute UTC
-- and are NOT touched.
--
-- If any regenerated occurrence collides with another reservation
-- under the new timezone, the shadow exclusion raises 23P01 inside
-- materialize_recurring_break_rule and the entire studios.timezone
-- UPDATE rolls back, keeping the previous timezone and previous
-- occurrence rows.
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_recurring_break_occurrences_for_studio_tz()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz text := coalesce(new.timezone, 'America/Toronto');
  v_horizon_end date;
  r_rule public.studio_recurring_break_rules%rowtype;
begin
  if new.timezone is not distinct from old.timezone then
    return new;
  end if;

  -- Delete every future or in-progress occurrence for this studio.
  -- The AFTER DELETE trigger removes the matching shadow rows.
  -- Past occurrences (ends_at <= now()) survive as audit history.
  delete from public.studio_recurring_break_occurrences
  where studio_id = new.id
    and ends_at > now();

  -- 90 days in the studio's NEW local calendar.
  v_horizon_end := ((now() at time zone v_tz)::date) + 90;

  for r_rule in
    select * from public.studio_recurring_break_rules
    where studio_id = new.id
      and active = true
  loop
    perform public.materialize_recurring_break_rule(r_rule.id, v_horizon_end);
  end loop;

  return new;
end;
$$;

revoke execute on function public.rebuild_recurring_break_occurrences_for_studio_tz()
  from public;
revoke execute on function public.rebuild_recurring_break_occurrences_for_studio_tz()
  from anon;
revoke execute on function public.rebuild_recurring_break_occurrences_for_studio_tz()
  from authenticated;

create or replace trigger studios_rebuild_recurring_break_occurrences_on_tz_change_trg
  after update of timezone
  on public.studios
  for each row
  execute function public.rebuild_recurring_break_occurrences_for_studio_tz();

commit;
