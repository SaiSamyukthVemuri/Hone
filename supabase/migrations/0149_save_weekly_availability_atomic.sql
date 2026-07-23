-- PR B Part 4 — atomic full-week availability save under the capacity lock (Item 2).
--
-- saveWeeklyDefaultsAction wrote the seven weekday rows with SEVEN independent
-- upserts (its own comment claimed the opposite): a failure on day 4 left days 0-3
-- committed and 4-6 not — a half-applied week. It also took no studios-row /
-- capacity advisory lock, so it never serialized with booking / retirement / the
-- timezone rebuild.
--
-- save_weekly_availability writes ALL supplied days in ONE transaction (a bad row
-- rolls the whole week back) after taking the canonical lock order:
--   1. studios row FOR UPDATE   2. studio capacity advisory lock.
-- Studio-wide scope = p_scope_practitioner_id NULL (today's behaviour, unchanged);
-- a non-NULL scope is validated active + same-studio first. The table's own CHECK
-- (is_open=false OR open<close) remains the final shape guard.
--
-- Service_role only — the owner is resolved SERVER-SIDE by the action (assertOwner)
-- before the admin client calls this, matching the Part 4 command pattern. This
-- does NOT change which rows are written for a flag-OFF studio, so Legacy /
-- studio-wide (incl every current studio) behaviour is byte-for-byte preserved.
--
-- Migration-first, additive, flag-OFF. Stacks on 0148. NOT hosted-applied.

begin;

create or replace function public.save_weekly_availability(
  p_studio_id            uuid,
  p_scope_practitioner_id uuid,
  p_days                 jsonb
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_day jsonb;
begin
  -- Lock order: studios row FIRST, then the capacity advisory lock.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return 'studio_not_found';
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  -- A practitioner-scoped save requires an active, same-studio target.
  if p_scope_practitioner_id is not null and not exists (
    select 1 from public.practitioners pr
     where pr.id = p_scope_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return 'invalid_practitioner';
  end if;

  -- Atomic full-week upsert: every day in one transaction. A CHECK violation on
  -- any day aborts the whole function → no half-applied week.
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

revoke execute on function public.save_weekly_availability(uuid, uuid, jsonb) from public;
revoke execute on function public.save_weekly_availability(uuid, uuid, jsonb) from anon;
revoke execute on function public.save_weekly_availability(uuid, uuid, jsonb) from authenticated;
grant execute on function public.save_weekly_availability(uuid, uuid, jsonb) to service_role;

commit;
