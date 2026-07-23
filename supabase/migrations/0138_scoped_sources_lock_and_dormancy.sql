-- ===========================================================================
-- 0138 — Scoped-source lock coverage, Legacy dormancy, lock-then-read (PR B 3E-0..4)
-- ===========================================================================
--
-- Corrects five DB-engine defects in the 0137 scoped-source engine:
--   3E-0  the scope guard runs only BEFORE INSERT/UPDATE, so DELETE (and
--         blockouts) bypass the studio capacity advisory lock. Split into a
--         lock-only trigger (INSERT/UPDATE/DELETE) on all four source tables +
--         a scope-validation trigger (INSERT/UPDATE) on timed blocks + rules.
--         Fix the lock order (studio row -> advisory) so retirement and the
--         timezone rebuild cannot deadlock.
--   3E-1  occurrence INSERT must NOT require capacity ON + an active target, so
--         a retained dormant rule can extend its horizon in Legacy (the cron no
--         longer 42501s). An integrity trigger keeps occurrence scope == rule
--         scope + same studio instead.
--   3E-2  materialize reads the rule BEFORE the lock -> stale. Lock, then re-read
--         under a row lock.
--   3E-3  one materialization horizon helper (386 = maxPublicBookingHorizonDays
--         12*31 + 14 margin) used by the timezone rebuild.
--   3E-4  owner writes scoped timed blocks through authenticated owner RLS.
--
-- Repo-only (hosted max 0133). Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 3E-3: one reviewed SQL horizon helper. Must equal the TS
-- maxPublicBookingHorizonDays() (12*31=372) + 14 margin = 386. A source test
-- fails if the TS maximum changes without this being updated.
-- ---------------------------------------------------------------------------
create or replace function public.recurring_break_horizon_days()
returns integer language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 386 $$;

-- ---------------------------------------------------------------------------
-- 3E-0: lock-only trigger for every structural calendar source. No scope
-- validation; just serializes the mutation per studio (studio-row-first order
-- is preserved because these tables are NOT the studios row).
-- ---------------------------------------------------------------------------
create or replace function public.lock_structural_calendar_source_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.acquire_studio_capacity_lock(old.studio_id);
    return old;
  end if;
  perform public.acquire_studio_capacity_lock(new.studio_id);
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'studio_timed_blocks', 'studio_recurring_break_rules',
    'studio_recurring_break_occurrences', 'studio_blockouts'
  ]
  loop
    -- Name sorts before "..._scope_guard_trg" so the lock is held first.
    execute format(
      'create or replace trigger %I before insert or update or delete on public.%I ' ||
      'for each row execute function public.lock_structural_calendar_source_mutation()',
      t || '_00_lock_trg', t);
  end loop;
end $$;

-- Scope guard (0137) becomes validation-only (no lock; the lock trigger owns it)
-- and applies to the CONFIG tables only — NOT occurrences (3E-1).
create or replace function public.guard_scoped_source_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Validate only when the scope is being SET or CHANGED to a practitioner
  -- (INSERT, or an UPDATE that changes practitioner_id). This lets the owner
  -- still toggle-off / edit an EXISTING scoped source whose practitioner later
  -- went inactive, or whose studio dropped to Legacy — without being able to
  -- (re)assign a scoped source to an inactive practitioner or create one while OFF.
  if new.practitioner_id is not null
     and (tg_op = 'INSERT' or new.practitioner_id is distinct from old.practitioner_id) then
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

drop trigger if exists studio_recurring_break_occurrences_scope_guard_trg
  on public.studio_recurring_break_occurrences;

-- ---------------------------------------------------------------------------
-- 3E-1: occurrence INTEGRITY (not a capacity gate). A non-orphan occurrence
-- must match its rule's studio + practitioner scope, so a retained dormant rule
-- can still extend its horizon while capacity is OFF and its occurrences stay
-- correctly attributed. Orphan (rule_id IS NULL) history keeps its stored scope.
-- ---------------------------------------------------------------------------
create or replace function public.guard_occurrence_integrity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rule_studio uuid;
  v_rule_pract uuid;
begin
  if new.rule_id is null then
    return new; -- historical orphan: keep its stored scope
  end if;
  select studio_id, practitioner_id into v_rule_studio, v_rule_pract
  from public.studio_recurring_break_rules where id = new.rule_id;
  if v_rule_studio is distinct from new.studio_id then
    raise exception 'occurrence studio must match its rule' using errcode = '23514';
  end if;
  if new.practitioner_id is distinct from v_rule_pract then
    raise exception 'occurrence practitioner scope must match its rule' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace trigger studio_recurring_break_occurrences_integrity_trg
  before insert or update on public.studio_recurring_break_occurrences
  for each row execute function public.guard_occurrence_integrity();

-- ---------------------------------------------------------------------------
-- 3E-2: materialize — lock, THEN re-read the rule under a row lock. No stale
-- pre-lock snapshot. Occurrences copy the post-lock rule scope.
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
  v_studio     uuid;
  v_rule       public.studio_recurring_break_rules%rowtype;
  v_studio_tz  text;
  v_iter       date;
  v_dow        integer;
  v_starts_at  timestamptz;
  v_ends_at    timestamptz;
begin
  select studio_id into v_studio from public.studio_recurring_break_rules where id = p_rule_id;
  if v_studio is null then
    return;
  end if;
  perform public.acquire_studio_capacity_lock(v_studio);

  -- Re-read under a row lock AFTER the advisory lock: a concurrent update/delete
  -- committed before the lock is now visible.
  select * into v_rule from public.studio_recurring_break_rules
    where id = p_rule_id for update;
  if not found or not v_rule.active then
    return;
  end if;

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

-- ---------------------------------------------------------------------------
-- 3E-0/3E-2: delete RPC — lock BEFORE the row lock + deletes.
-- ---------------------------------------------------------------------------
create or replace function public.delete_recurring_break_rule(
  p_rule_id   uuid,
  p_studio_id uuid
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
  delete from public.studio_recurring_break_occurrences
    where rule_id = p_rule_id and ends_at > now();
  delete from public.studio_recurring_break_rules
    where id = p_rule_id and studio_id = p_studio_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3E-0/3E-3: timezone rebuild uses the horizon helper (was 90) and holds the
-- studio lock. The studios row is already row-locked by the UPDATE that fires
-- this trigger, so the order is studio-row -> advisory (matching retirement).
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
  perform public.acquire_studio_capacity_lock(new.id);

  delete from public.studio_recurring_break_occurrences
    where studio_id = new.id and ends_at > now();

  v_horizon_end := ((now() at time zone v_tz)::date) + public.recurring_break_horizon_days();

  for r_rule in
    select * from public.studio_recurring_break_rules
    where studio_id = new.id and active = true
  loop
    perform public.materialize_recurring_break_rule(r_rule.id, v_horizon_end);
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3E-0: retirement — lock the studios ROW first, then the advisory lock, so it
-- shares the studio-row->advisory order with the timezone rebuild (no deadlock).
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
  from public.studios where id = p_studio_id for update;   -- studio ROW lock first

  if v_cap is null then
    raise exception 'capacity_retirement_blocked:studio_not_found' using errcode = 'P0002';
  end if;

  perform public.acquire_studio_capacity_lock(p_studio_id);  -- then the advisory lock

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

-- ---------------------------------------------------------------------------
-- 3E-4: the OWNER writes scoped timed blocks through authenticated owner RLS
-- (INSERT/UPDATE/DELETE). Defense in depth over the 0030 owner "for all" policy
-- and unambiguous for the scoped case; member INSERT stays studio-wide-only.
-- ---------------------------------------------------------------------------
drop policy if exists "studio_timed_blocks_owner_scoped_write" on public.studio_timed_blocks;
create policy "studio_timed_blocks_owner_scoped_write"
  on public.studio_timed_blocks
  for all
  to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

-- ---------------------------------------------------------------------------
-- Lock down new/redefined functions.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.recurring_break_horizon_days()',
    'public.lock_structural_calendar_source_mutation()',
    'public.guard_occurrence_integrity()'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;
end $$;

commit;
