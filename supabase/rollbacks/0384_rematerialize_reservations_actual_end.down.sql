-- Restores the 0137 body of rematerialize_studio_reservations. Function only.
-- ROLLBACK ORDER: roll back 0384 BEFORE 0152. 0152's own rollback guidance (step 2) restores buffered reservation ends with a direct
-- update (ends_at = blocked_ends_at) and restores the sync function; it does not call rematerialize. If 0152 were rolled back first, 0384's function
-- would still be live and any staff change before this file ran would write ACTUAL ends into a database that is back on the buffered model, mixing
-- the two. Rolling 0384 back first returns rematerialize to the 0137 body while the actual-end model is still in force.
begin;
set local lock_timeout = '5s';

-- PREAMBLE: refuse unless the function in this database is exactly the 0384 body (0384). A hosted body that drifted would otherwise be overwritten silently.
do $$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
   where p.oid = 'public.rematerialize_studio_reservations(uuid)'::regprocedure;
  if v_md5 is distinct from '11b009af1cd228c32fe64578081e6ae9' then
    raise exception 'rematerialize_studio_reservations is not the expected 0384 body (md5 %); refusing to replace it', v_md5
      using errcode = 'P0001';
  end if;
end
$$;

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

commit;
