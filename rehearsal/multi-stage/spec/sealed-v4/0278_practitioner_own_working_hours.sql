-- 0278: a practitioner may change ONLY their own working hours (HON-44, Sam decision 6, 2026-11-01).
-- Reserved to Team (01-ops/MIGRATION-RESERVATIONS.md). HELD, PREPARE-ONLY: never applied without
-- Sam's per-change approval. Draft; Privacy SQL review, then Insurance, come first.
--
-- RULE. An owner may change any availability (studio-wide or any practitioner's). A practitioner
-- may change their OWN per-practitioner schedule and nothing else: never the studio-wide hours, never
-- a colleague's. Everything the existing scheduling rules already require still holds: a scoped row
-- needs capacity ON and an active same-studio practitioner (validate_schedule_scope, the 0135 trigger),
-- the same locks in the same order, the same conflict checks in the app. Personal DISPLAY preferences
-- are NOT here (held 0273) and studio-wide display settings stay owner-only.
--
-- WHY A MIGRATION. 0150's four single-row commands asserted "the actor is an active OWNER"
-- (lock_studio_and_assert_owner) before doing anything, so a practitioner actor was refused by the
-- database whatever the app decided. 0149's weekly save has no actor at all (the app resolved the
-- owner). The direct-table path stays closed: studio_availability_default and _overrides remain
-- member-SELECT / owner-write under RLS (0135); this file does not touch those policies.
--
-- WHAT CHANGES (nothing else; no table, column, policy or trigger is touched, nothing is dropped):
--   1. NEW authorize_schedule_writer(studio, actor, scope): takes the same lock order as 0150's
--      preamble, reads the actor's role (active members only), and answers 'ok' for an owner (any
--      scope) or for a non-owner whose scope IS themselves (non-null and equal to the actor);
--      otherwise 'not_authorized' (studio-wide hours and a colleague's schedule are owner-only).
--   2. REPLACED with the SAME signatures and bodies as 0150, the gate swapped: upsert_availability_day_locked,
--      delete_availability_day_locked, upsert_availability_override_locked, delete_availability_override_locked.
--      The override-by-row-id delete resolves the row's own scope first; a non-owner deleting a row that is
--      not theirs, studio-wide, or absent gets 'not_authorized' (nothing is revealed).
--   3. NEW save_weekly_availability_as(studio, actor, scope, days): 0149's atomic week save behind the
--      same gate. 0149's save_weekly_availability is left exactly as it is.
--
-- GRANTS. Every function touched or created has EXECUTE revoked BY NAME from public, anon, authenticated
-- and service_role, then granted back to service_role alone; the closing block proves it.
--
-- DEPENDENCY ORDER. The app-gate PR (practitioner own-hours UI and actions) depends on this: without it a
-- practitioner's own-hours call is refused by the database (which is the safe failure). This migration alone
-- changes nothing for owners and nothing for the current app (the app still resolves an owner before every
-- call). Needs nothing above hosted 0257.
--
-- ROLLBACK. Re-apply 0150's four function definitions (lock_studio_and_assert_owner gate) and drop the two
-- new functions (authorize_schedule_writer, save_weekly_availability_as). No rows were changed.

begin;

set local lock_timeout = '5s';

-- Gate: lock order identical to lock_studio_and_assert_owner (studios row, then the capacity advisory lock).
-- Returns 'ok' | 'studio_not_found' | 'not_authorized'.
create or replace function public.authorize_schedule_writer(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_scope_practitioner_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
begin
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return 'studio_not_found';
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_role is null then
    return 'not_authorized';
  end if;
  if v_role = 'owner' then
    return 'ok';
  end if;
  -- A non-owner: only their OWN scope. A null scope is the studio-wide schedule, which is owner-only.
  if p_scope_practitioner_id is not null and p_scope_practitioner_id = p_actor_practitioner_id then
    return 'ok';
  end if;
  return 'not_authorized';
end;
$$;

-- ---- availability_default: upsert one weekday (studio-wide or practitioner) ----
create or replace function public.upsert_availability_day_locked(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_scope_practitioner_id uuid,
  p_day_of_week           integer,
  p_is_open               boolean,
  p_open_time             time,
  p_close_time            time
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_gate text;
begin
  v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  v_gate := public.validate_schedule_scope(p_studio_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  if p_day_of_week is null or p_day_of_week < 0 or p_day_of_week > 6 then
    return 'invalid_day';
  end if;

  insert into public.studio_availability_default
    (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
  values (
    gen_random_uuid(), p_studio_id, p_scope_practitioner_id, p_day_of_week,
    coalesce(p_is_open, false),
    case when p_is_open then p_open_time else null end,
    case when p_is_open then p_close_time else null end
  )
  on conflict on constraint studio_availability_default_scope_key
  do update set is_open = excluded.is_open, open_time = excluded.open_time, close_time = excluded.close_time;
  return 'ok';
end;
$$;

-- ---- availability_default: reset one weekday (or the whole week) for a practitioner ----
create or replace function public.delete_availability_day_locked(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_scope_practitioner_id uuid,
  p_day_of_week           integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_gate text;
begin
  v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  if p_scope_practitioner_id is null then
    return 'invalid_practitioner';
  end if;
  v_gate := public.validate_schedule_scope(p_studio_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  if p_day_of_week is not null and (p_day_of_week < 0 or p_day_of_week > 6) then
    return 'invalid_day';
  end if;

  delete from public.studio_availability_default d
   where d.studio_id = p_studio_id
     and d.practitioner_id = p_scope_practitioner_id
     and (p_day_of_week is null or d.day_of_week = p_day_of_week);
  return 'ok';
end;
$$;

-- ---- availability_overrides: upsert one date override (studio-wide or practitioner) ----
create or replace function public.upsert_availability_override_locked(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_scope_practitioner_id uuid,
  p_effective_date        date,
  p_is_open               boolean,
  p_open_time             time,
  p_close_time            time,
  p_note                  text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_gate text;
begin
  v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  v_gate := public.validate_schedule_scope(p_studio_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  if p_effective_date is null then
    return 'invalid_date';
  end if;

  insert into public.studio_availability_overrides
    (id, studio_id, practitioner_id, effective_date, is_open, open_time, close_time, note)
  values (
    gen_random_uuid(), p_studio_id, p_scope_practitioner_id, p_effective_date,
    coalesce(p_is_open, false),
    case when p_is_open then p_open_time else null end,
    case when p_is_open then p_close_time else null end,
    p_note
  )
  on conflict on constraint studio_availability_overrides_scope_key
  do update set is_open = excluded.is_open, open_time = excluded.open_time,
                close_time = excluded.close_time, note = excluded.note;
  return 'ok';
end;
$$;

-- ---- availability_overrides: delete a date override ----
-- By row id (p_id) the row's own scope decides who may delete it; by (scope, date) the stated scope does.
create or replace function public.delete_availability_override_locked(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_id                    uuid,
  p_scope_practitioner_id uuid,
  p_effective_date        date
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_gate text;
  v_row_scope uuid;
begin
  if p_id is not null then
    -- Take the locks first (authorize_schedule_writer re-takes them reentrantly), then read the row's scope.
    perform 1 from public.studios s where s.id = p_studio_id for update;
    if not found then return 'studio_not_found'; end if;
    perform public.acquire_studio_capacity_lock(p_studio_id);
    select o.practitioner_id into v_row_scope
      from public.studio_availability_overrides o
     where o.id = p_id and o.studio_id = p_studio_id;
    -- Absent or studio-wide rows resolve to a null scope: owner-only, and 'not_authorized' for anyone else.
    v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, v_row_scope);
    if v_gate <> 'ok' then return v_gate; end if;
    delete from public.studio_availability_overrides o
     where o.id = p_id and o.studio_id = p_studio_id;
  elsif p_effective_date is not null then
    v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id);
    if v_gate <> 'ok' then return v_gate; end if;
    delete from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.practitioner_id is not distinct from p_scope_practitioner_id
       and o.effective_date = p_effective_date;
  else
    return 'invalid_request';
  end if;
  return 'ok';
end;
$$;

-- ---- availability_default: the atomic week save, behind the same gate ----
create or replace function public.save_weekly_availability_as(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_scope_practitioner_id uuid,
  p_days                  jsonb
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_gate text;
  v_day jsonb;
begin
  v_gate := public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  v_gate := public.validate_schedule_scope(p_studio_id, p_scope_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;

  for v_day in select jsonb_array_elements(p_days)
  loop
    insert into public.studio_availability_default
      (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
    values (
      gen_random_uuid(), p_studio_id, p_scope_practitioner_id,
      (v_day->>'day_of_week')::int,
      coalesce((v_day->>'is_open')::boolean, false),
      nullif(v_day->>'open_time', '')::time,
      nullif(v_day->>'close_time', '')::time
    )
    on conflict on constraint studio_availability_default_scope_key
    do update set
      is_open    = excluded.is_open,
      open_time  = excluded.open_time,
      close_time = excluded.close_time;
  end loop;

  return 'ok';
end;
$$;

-- Service_role only, BY NAME, for every function this file creates or replaces.
do $$
declare fn text;
begin
  for fn in
    select unnest(array[
      'public.authorize_schedule_writer(uuid, uuid, uuid)',
      'public.upsert_availability_day_locked(uuid, uuid, uuid, integer, boolean, time, time)',
      'public.delete_availability_day_locked(uuid, uuid, uuid, integer)',
      'public.upsert_availability_override_locked(uuid, uuid, uuid, date, boolean, time, time, text)',
      'public.delete_availability_override_locked(uuid, uuid, uuid, uuid, date)',
      'public.save_weekly_availability_as(uuid, uuid, uuid, jsonb)'
    ])
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('revoke execute on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '0278: % must not be executable by anon or authenticated', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception '0278: % must stay executable by service_role', fn;
    end if;
  end loop;
end $$;

commit;
