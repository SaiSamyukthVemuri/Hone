-- ===========================================================================
-- 0137 — Practitioner-scoped timed blocks + recurring breaks (PR B 3C-3E, DB)
-- ===========================================================================
--
-- Adds an OPTIONAL practitioner scope to one-off timed blocks and recurring
-- break rules/occurrences. practitioner_id IS NULL = studio-wide (today);
-- practitioner_id = P = only P. Full-day blockouts stay studio-wide.
--
-- Canonical scope-aware reservation synchronizer (sync_scoped_calendar_reservation):
--   * Legacy (capacity OFF), studio-wide source  -> one studio-keyed row (today).
--   * Legacy, SCOPED source                       -> ZERO rows (retained + dormant;
--                                                    never widened to studio-wide).
--   * Capacity ON, studio-wide source             -> fan out to every practitioner.
--   * Capacity ON, SCOPED source                  -> one row keyed to that practitioner.
-- It delete-then-inserts inside the source-row transaction and does NOT catch
-- the GiST 23P01 (a conflict rolls the whole mutation back).
--
-- Every structural-reservation mutation takes the shared per-studio transaction
-- advisory lock (0136) BEFORE validating capacity/practitioner/conflicts, so a
-- scoped source cannot appear between retirement preflight and deactivation.
--
-- Additive; repo-only (hosted max stays 0133). Willow (studio-wide, capacity
-- OFF) is unaffected. Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Step 1: scoped columns + same-studio composite FKs. RESTRICT on the
-- practitioner relationship so a practitioner with scoped sources cannot be
-- hard-deleted (which would otherwise orphan/misattribute the block); the
-- studio_id FK stays ON DELETE CASCADE so dropping a whole studio still works.
-- NEVER ON DELETE SET NULL (that would silently widen a scoped block to a
-- studio-wide closure).
-- ---------------------------------------------------------------------------
alter table public.studio_timed_blocks
  add column if not exists practitioner_id uuid;
alter table public.studio_recurring_break_rules
  add column if not exists practitioner_id uuid;
alter table public.studio_recurring_break_occurrences
  add column if not exists practitioner_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_timed_blocks_practitioner_fk') then
    alter table public.studio_timed_blocks
      add constraint studio_timed_blocks_practitioner_fk
      foreign key (practitioner_id, studio_id)
      references public.practitioners (id, studio_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_recurring_break_rules_practitioner_fk') then
    alter table public.studio_recurring_break_rules
      add constraint studio_recurring_break_rules_practitioner_fk
      foreign key (practitioner_id, studio_id)
      references public.practitioners (id, studio_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_recurring_break_occurrences_practitioner_fk') then
    alter table public.studio_recurring_break_occurrences
      add constraint studio_recurring_break_occurrences_practitioner_fk
      foreign key (practitioner_id, studio_id)
      references public.practitioners (id, studio_id) on delete restrict;
  end if;
end $$;

create index if not exists studio_timed_blocks_practitioner_idx
  on public.studio_timed_blocks (practitioner_id);
create index if not exists studio_recurring_break_rules_practitioner_idx
  on public.studio_recurring_break_rules (practitioner_id);
create index if not exists studio_recurring_break_occurrences_practitioner_idx
  on public.studio_recurring_break_occurrences (practitioner_id);

-- ---------------------------------------------------------------------------
-- Step 2: scope guard for these sources. Takes the shared studio lock FIRST,
-- then (for a scoped row) requires capacity ON + an active target. Same-studio
-- is the composite FK. Fires BEFORE INSERT/UPDATE.
-- ---------------------------------------------------------------------------
create or replace function public.guard_scoped_source_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Serialize per studio before any capacity/validity check (3B-4 contract).
  perform public.acquire_studio_capacity_lock(new.studio_id);
  if new.practitioner_id is not null then
    if not public.studio_capacity_enabled(new.studio_id) then
      raise exception 'per-practitioner block/break requires practitioner capacity to be enabled'
        using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.practitioners p
      where p.id = new.practitioner_id and p.active = true
    ) then
      raise exception 'practitioner is not active' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger studio_timed_blocks_scope_guard_trg
  before insert or update on public.studio_timed_blocks
  for each row execute function public.guard_scoped_source_capacity();
create or replace trigger studio_recurring_break_rules_scope_guard_trg
  before insert or update on public.studio_recurring_break_rules
  for each row execute function public.guard_scoped_source_capacity();
create or replace trigger studio_recurring_break_occurrences_scope_guard_trg
  before insert or update on public.studio_recurring_break_occurrences
  for each row execute function public.guard_scoped_source_capacity();

-- ---------------------------------------------------------------------------
-- Step 3: owner-only SCOPED writes on timed blocks. The 0061 member-INSERT
-- (drag-to-block) stays for studio-wide rows; a practitioner-scoped block may
-- only be written by the owner. (Recurring rules/occurrences are already
-- service-role-RPC-only.)
-- ---------------------------------------------------------------------------
drop policy if exists "studio_timed_blocks_member_insert" on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_insert"
  on public.studio_timed_blocks
  for insert
  to authenticated
  with check (public.is_studio_member(studio_id) and practitioner_id is null);

-- ---------------------------------------------------------------------------
-- Step 4: the canonical scope-aware synchronizer (see header state table).
-- ---------------------------------------------------------------------------
create or replace function public.sync_scoped_calendar_reservation(
  p_studio_id uuid,
  p_practitioner_id uuid,
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

  if p_practitioner_id is not null then
    -- SCOPED source. Capacity OFF => retained but DORMANT (zero reservations).
    if public.studio_capacity_enabled(p_studio_id) then
      insert into public.studio_calendar_reservations
        (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
      values
        (p_studio_id, p_practitioner_id, p_practitioner_id, p_source_kind, p_source_id, p_starts_at, p_ends_at);
    end if;
  else
    -- STUDIO-WIDE source.
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
  end if;
end;
$$;

-- fanout (0134) now delegates to the synchronizer with a NULL practitioner, so
-- full-day blockouts keep their exact studio-wide fan-out behaviour.
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
  perform public.sync_scoped_calendar_reservation(
    p_studio_id, null, p_source_kind, p_source_id, p_starts_at, p_ends_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 5: scope-aware source mirrors (pass practitioner_id to the synchronizer).
-- ---------------------------------------------------------------------------
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
  perform public.sync_scoped_calendar_reservation(
    new.studio_id, new.practitioner_id, 'timed_block', new.id, new.starts_at, new.ends_at);
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
  perform public.sync_scoped_calendar_reservation(
    new.studio_id, new.practitioner_id, 'recurring_break_occurrence', new.id, new.starts_at, new.ends_at);
  return null;
end;
$$;

-- Widen the mirror triggers' UPDATE column lists so a scope (or time) change
-- re-syncs the shadow.
create or replace trigger studio_timed_blocks_sync_calendar_reservation_trg
  after insert or delete
  or update of studio_id, starts_at, ends_at, practitioner_id
  on public.studio_timed_blocks
  for each row execute function public.sync_timed_block_to_calendar_reservation();

create or replace trigger studio_recurring_break_occurrences_sync_calendar_reservation_trg
  after insert or delete
  or update of studio_id, starts_at, ends_at, practitioner_id
  on public.studio_recurring_break_occurrences
  for each row execute function public.sync_recurring_break_occurrence_to_calendar_reservation();

-- ---------------------------------------------------------------------------
-- Step 6: rematerialize passes each source's own scope to the synchronizer.
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
  -- Serialize the full rebuild with scoped-source mutations, so a capacity flip
  -- (this runs inside the flag-flip trigger AND the retirement RPC) cannot race
  -- a concurrent block/occurrence write.
  perform public.acquire_studio_capacity_lock(p_studio_id);

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
    select id, practitioner_id, starts_at, ends_at
    from public.studio_timed_blocks where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, r.practitioner_id, 'timed_block', r.id, r.starts_at, r.ends_at);
  end loop;
  for r in
    select id,
           (starts_on::timestamp) at time zone v_tz as s_at,
           ((ends_on + 1)::timestamp) at time zone v_tz as e_at
    from public.studio_blockouts where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, null, 'full_day_blockout', r.id, r.s_at, r.e_at);
  end loop;
  for r in
    select id, practitioner_id, starts_at, ends_at
    from public.studio_recurring_break_occurrences where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, r.practitioner_id, 'recurring_break_occurrence', r.id, r.starts_at, r.ends_at);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 7: recurring-break RPCs become scope-aware. Occurrences COPY the rule's
-- practitioner_id at materialization; the create/update RPCs gain an optional
-- p_practitioner_id (default NULL => studio-wide, so existing callers are
-- unchanged). All take the studio lock first.
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
  v_iter       date;
  v_dow        integer;
  v_starts_at  timestamptz;
  v_ends_at    timestamptz;
begin
  select * into v_rule from public.studio_recurring_break_rules where id = p_rule_id;
  if not found or not v_rule.active then
    return;
  end if;
  perform public.acquire_studio_capacity_lock(v_rule.studio_id);

  select coalesce(s.timezone, 'America/Toronto') into v_studio_tz
  from public.studios s where s.id = v_rule.studio_id;

  v_iter := (now() at time zone v_studio_tz)::date;
  while v_iter <= p_horizon_end loop
    v_dow := extract(dow from v_iter)::integer;
    if v_dow = any (v_rule.days_of_week) then
      v_starts_at := (v_iter::text || ' ' || v_rule.start_local_time::text)::timestamp at time zone v_studio_tz;
      v_ends_at   := (v_iter::text || ' ' || v_rule.end_local_time::text)::timestamp at time zone v_studio_tz;
      if v_ends_at > now() then
        insert into public.studio_recurring_break_occurrences
          (rule_id, studio_id, practitioner_id, occurrence_date, starts_at, ends_at)
        values
          (p_rule_id, v_rule.studio_id, v_rule.practitioner_id, v_iter, v_starts_at, v_ends_at)
        on conflict on constraint studio_recurring_break_occurrences_rule_date_unique
        do nothing;
      end if;
    end if;
    v_iter := v_iter + 1;
  end loop;
end;
$$;

drop function if exists public.create_recurring_break_rule_and_materialize(
  uuid, text, integer[], time, time, boolean, uuid, date);
create or replace function public.create_recurring_break_rule_and_materialize(
  p_studio_id        uuid,
  p_label            text,
  p_days_of_week     integer[],
  p_start_local_time time,
  p_end_local_time   time,
  p_active           boolean,
  p_created_by       uuid,
  p_horizon_end      date,
  p_practitioner_id  uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rule_id uuid;
begin
  perform public.acquire_studio_capacity_lock(p_studio_id);
  insert into public.studio_recurring_break_rules
    (studio_id, label, days_of_week, start_local_time, end_local_time,
     active, created_by, practitioner_id)
  values
    (p_studio_id, p_label, p_days_of_week, p_start_local_time,
     p_end_local_time, p_active, p_created_by, p_practitioner_id)
  returning id into v_rule_id;
  if p_active then
    perform public.materialize_recurring_break_rule(v_rule_id, p_horizon_end);
  end if;
  return v_rule_id;
end;
$$;

drop function if exists public.update_recurring_break_rule_and_rematerialize(
  uuid, uuid, text, integer[], time, time, boolean, date);
create or replace function public.update_recurring_break_rule_and_rematerialize(
  p_rule_id          uuid,
  p_studio_id        uuid,
  p_label            text,
  p_days_of_week     integer[],
  p_start_local_time time,
  p_end_local_time   time,
  p_active           boolean,
  p_horizon_end      date,
  p_practitioner_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.acquire_studio_capacity_lock(p_studio_id);
  perform 1 from public.studio_recurring_break_rules
    where id = p_rule_id and studio_id = p_studio_id for update;
  if not found then
    raise exception 'recurring break rule not found' using errcode = 'P0002';
  end if;

  update public.studio_recurring_break_rules
  set label = p_label, days_of_week = p_days_of_week,
      start_local_time = p_start_local_time, end_local_time = p_end_local_time,
      active = p_active, practitioner_id = p_practitioner_id, updated_at = now()
  where id = p_rule_id and studio_id = p_studio_id;

  -- Future/in-progress occurrences only (preserve completed history). A scope
  -- change therefore replaces every future occurrence under the NEW scope.
  delete from public.studio_recurring_break_occurrences
  where rule_id = p_rule_id and ends_at > now();

  if p_active then
    perform public.materialize_recurring_break_rule(p_rule_id, p_horizon_end);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 8: lock down new/redefined functions.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.guard_scoped_source_capacity()',
    'public.sync_scoped_calendar_reservation(uuid, uuid, text, uuid, timestamptz, timestamptz)',
    'public.create_recurring_break_rule_and_materialize(uuid, text, integer[], time, time, boolean, uuid, date, uuid)',
    'public.update_recurring_break_rule_and_rematerialize(uuid, uuid, text, integer[], time, time, boolean, date, uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;
  -- The two RPCs are operator/service-role (called by owner-gated server actions
  -- via the admin client), matching the 0031 posture.
  execute 'grant execute on function public.create_recurring_break_rule_and_materialize(uuid, text, integer[], time, time, boolean, uuid, date, uuid) to service_role';
  execute 'grant execute on function public.update_recurring_break_rule_and_rematerialize(uuid, uuid, text, integer[], time, time, boolean, date, uuid) to service_role';
end $$;

commit;
