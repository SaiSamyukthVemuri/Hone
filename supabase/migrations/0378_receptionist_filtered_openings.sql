begin;
set local lock_timeout = '5s';

-- Filter in studio time before ranking. Reserve each eligible practitioner's
-- earliest match before using the rest of the result budget on later starts.
create function public.receptionist_find_openings_v2(
  p_studio_id uuid, p_service_id uuid, p_practitioner_ids uuid[],
  p_from_date date, p_to_date date, p_earliest time, p_latest_end time
)
returns table (
  practitioner_id uuid, practitioner_name text, starts_at timestamptz, ends_at timestamptz,
  local_date date, local_time text, has_more boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_tz text;
  v_capacity boolean;
  v_duration integer;
begin
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from_date is null or p_to_date is null or not isfinite(p_from_date) or not isfinite(p_to_date)
     or p_to_date < p_from_date or p_to_date - p_from_date > 6
     or p_practitioner_ids is null or cardinality(p_practitioner_ids) not between 1 and 100
     or p_earliest is null or (p_latest_end is not null and p_latest_end <= p_earliest) then
    raise exception 'invalid_search' using errcode = '22023';
  end if;

  select s.timezone, s.practitioner_capacity_enabled, sv.default_duration_minutes
    into v_tz, v_capacity, v_duration
    from public.studios s
    join public.services sv on sv.studio_id = s.id and sv.id = p_service_id and sv.active
   where s.id = p_studio_id and (not s.practitioner_capacity_enabled or s.practitioner_capacity_booking_enabled);
  if not found or v_duration is null or v_duration <= 0 then return; end if;

  return query
  with eligible as materialized (
    select p.id, p.display_name from public.practitioners p
     where p.studio_id = p_studio_id and p.active and p.role in ('owner', 'practitioner')
       and p.id = any(p_practitioner_ids)
       and (not v_capacity or exists (
         select 1 from public.service_practitioners sp
          where sp.studio_id = p_studio_id and sp.service_id = p_service_id and sp.practitioner_id = p.id
       ))
  ), days as (
    select p_from_date + n as day from generate_series(0, p_to_date - p_from_date) n
     where p_from_date + n >= (now() at time zone v_tz)::date
  ), offers as (
    select e.id, e.display_name, d.day, slot.t,
           slot.t + make_interval(mins => v_duration) as finish,
           row_number() over (partition by e.id order by slot.t) as person_rank
      from eligible e cross join days d
      cross join lateral public.public_booking_slot_candidates_for_practitioner(p_studio_id, d.day, v_duration, e.id) slot(t)
     where slot.t > now() and (slot.t at time zone v_tz)::time >= p_earliest
       and (p_latest_end is null or
         ((slot.t + make_interval(mins => v_duration)) at time zone v_tz) <= d.day + p_latest_end)
  ), bounded as (
    select o.*, count(*) over () > 336 as truncated from offers o
     order by o.person_rank, o.t, o.id limit 336
  )
  select b.id, b.display_name, b.t, b.finish, b.day, to_char(b.t at time zone v_tz, 'HH24:MI'), b.truncated
    from bounded b order by b.t, b.display_name, b.id;
end;
$function$;
revoke all on function public.receptionist_find_openings_v2(uuid,uuid,uuid[],date,date,time,time) from public, anon, authenticated, service_role;
grant execute on function public.receptionist_find_openings_v2(uuid,uuid,uuid[],date,date,time,time) to authenticated;
commit;
