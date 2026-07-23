-- PR B Part 4 — lock the single-row schedule writers (Item 2, completion).
--
-- The full-week save (0149) already takes the studios-row + advisory lock. The
-- SINGLE-ROW availability writers (weekday upsert, weekday reset, date-override
-- upsert/delete — studio-wide + practitioner) and the practitioner-active writer
-- wrote their rows directly from the browser-role client under no capacity lock,
-- so a schedule edit could interleave with a booking/move that had already
-- validated the old window. These narrow, typed, SECURITY DEFINER commands take
-- the canonical lock order (studios row FOR UPDATE → capacity advisory lock) so
-- every schedule mutation serializes with booking / move / retirement / the
-- timezone rebuild. The lock gives SERIAL ORDER — see
-- docs/reviews/part4-lock-order-and-race-matrix.md for the ordered outcomes.
--
-- Scope of this migration (from the Phase-1 audit):
--   * availability_default   — upsert_availability_day_locked / delete_availability_day_locked
--   * availability_overrides — upsert_availability_override_locked / delete_availability_override_locked
--   * service_practitioners  — set_service_practitioner_eligibility_locked (READY; no UI writer today,
--                              so a future eligibility surface is lock-safe from day one)
--   * practitioners.active    — set_practitioner_active_locked (replaces the raw active=false update)
-- NOT here (reuse existing, already correct): studios.timezone has no app writer
--   (operator/migration-only rebuild); the capacity flags have no app writer
--   (operator-only retire_practitioner_capacity, 0138, already locked); blockouts /
--   timed blocks / recurring breaks already lock via the 0138 trigger.
--
-- Authorization: active OWNER only, resolved from the SERVER-supplied actor id;
-- studio + actor come from the trusted server adapter; scoped rows require capacity
-- ON + an active same-studio target; studio-wide (Legacy) writes stay supported;
-- browser roles are revoked. Every command returns a stable safe code, never raw
-- SQL. Migration-first, additive, flag-OFF. Stacks on 0149. NOT hosted-applied.

begin;

-- Shared preamble: take the lock order and assert the actor is an active owner.
-- The locks are transaction-scoped, so they persist in the CALLER's transaction
-- after this returns. Returns 'ok' | 'studio_not_found' | 'not_authorized'.
create or replace function public.lock_studio_and_assert_owner(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid
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
  if v_role is distinct from 'owner' then
    return 'not_authorized';
  end if;
  return 'ok';
end;
$$;

-- Validates a scoped target: NULL scope = studio-wide (always allowed). A non-NULL
-- scope requires capacity ON + an active same-studio practitioner. Returns
-- 'ok' | 'capacity_disabled' | 'invalid_practitioner'.
create or replace function public.validate_schedule_scope(
  p_studio_id             uuid,
  p_scope_practitioner_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_scope_practitioner_id is null then
    return 'ok';
  end if;
  if not public.studio_capacity_enabled(p_studio_id) then
    return 'capacity_disabled';
  end if;
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_scope_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return 'invalid_practitioner';
  end if;
  return 'ok';
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
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
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
-- p_day_of_week NULL = reset the practitioner's entire week. Scope is required
-- (studio-wide rows are overwritten via upsert / the full-week save, never reset).
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
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
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
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
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
-- Studio-wide UI deletes by row id (p_id); a practitioner reset deletes by
-- (scope, date). Exactly one path is taken; both are studio-scoped.
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
declare v_gate text;
begin
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;

  if p_id is not null then
    delete from public.studio_availability_overrides o
     where o.id = p_id and o.studio_id = p_studio_id;
  elsif p_effective_date is not null then
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

-- ---- service_practitioners: add/remove eligibility (READY; no UI writer today) ----
create or replace function public.set_service_practitioner_eligibility_locked(
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_service_id            uuid,
  p_practitioner_id       uuid,
  p_eligible              boolean
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_gate text;
begin
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;
  if not exists (
    select 1 from public.services sv where sv.id = p_service_id and sv.studio_id = p_studio_id
  ) then
    return 'invalid_service';
  end if;
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_practitioner_id and pr.studio_id = p_studio_id
  ) then
    return 'invalid_practitioner';
  end if;

  if coalesce(p_eligible, false) then
    insert into public.service_practitioners (studio_id, service_id, practitioner_id)
    values (p_studio_id, p_service_id, p_practitioner_id)
    on conflict on constraint service_practitioners_unique do nothing;
  else
    delete from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_practitioner_id;
  end if;
  return 'ok';
end;
$$;

-- ---- practitioners.active: set active (replaces the raw active=false update) ----
-- Preserves the existing per-practitioner deactivation contract: no preflight, the
-- target's appointments are left intact (an inactive practitioner keeps their
-- appointments; new bookings/moves already reject an inactive target). This is NOT
-- studio structural retirement (retire_practitioner_capacity, 0138).
create or replace function public.set_practitioner_active_locked(
  p_studio_id              uuid,
  p_actor_practitioner_id  uuid,
  p_target_practitioner_id uuid,
  p_active                 boolean
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_gate       text;
  v_target_role text;
begin
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;

  select pr.role into v_target_role
    from public.practitioners pr
   where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id
   for update;
  if v_target_role is null then
    return 'invalid_practitioner';
  end if;
  if v_target_role = 'owner' then
    return 'cannot_modify_owner';
  end if;
  if p_target_practitioner_id = p_actor_practitioner_id then
    return 'cannot_modify_owner'; -- an owner cannot deactivate themselves
  end if;

  update public.practitioners
     set active = coalesce(p_active, false)
   where id = p_target_practitioner_id and studio_id = p_studio_id;
  return 'ok';
end;
$$;

-- Service_role only for every new command.
do $$
declare fn text;
begin
  for fn in
    select unnest(array[
      'public.lock_studio_and_assert_owner(uuid, uuid)',
      'public.validate_schedule_scope(uuid, uuid)',
      'public.upsert_availability_day_locked(uuid, uuid, uuid, integer, boolean, time, time)',
      'public.delete_availability_day_locked(uuid, uuid, uuid, integer)',
      'public.upsert_availability_override_locked(uuid, uuid, uuid, date, boolean, time, time, text)',
      'public.delete_availability_override_locked(uuid, uuid, uuid, uuid, date)',
      'public.set_service_practitioner_eligibility_locked(uuid, uuid, uuid, uuid, boolean)',
      'public.set_practitioner_active_locked(uuid, uuid, uuid, boolean)'
    ])
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
