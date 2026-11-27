begin;
set local lock_timeout = '5s';

create or replace function public.receptionist_find_openings(
  p_studio_id uuid,
  p_service_id uuid,
  p_practitioner_id uuid,
  p_from_date date,
  p_to_date date,
  p_start timestamptz default null
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
     or (p_start is not null and (p_practitioner_id is null or p_from_date <> p_to_date)) then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  select s.timezone, s.practitioner_capacity_enabled, sv.default_duration_minutes
    into v_tz, v_capacity, v_duration
    from public.studios s
    join public.services sv on sv.studio_id = s.id and sv.id = p_service_id and sv.active
   where s.id = p_studio_id
     and (not s.practitioner_capacity_enabled or s.practitioner_capacity_booking_enabled);
  if not found or v_duration is null or v_duration <= 0 then return; end if;

  return query
  with eligible as materialized (
    select p.id, p.display_name
      from public.practitioners p
     where p.studio_id = p_studio_id and p.active and p.role in ('owner', 'practitioner')
       and (p_practitioner_id is null or p.id = p_practitioner_id)
       and (not v_capacity or exists (
         select 1 from public.service_practitioners sp
          where sp.studio_id = p_studio_id and sp.service_id = p_service_id and sp.practitioner_id = p.id
       ))
  ), days as (
    select p_from_date + n as day from generate_series(0, p_to_date - p_from_date) n
     where p_from_date + n >= (now() at time zone v_tz)::date
  )
  select offers.id, offers.display_name, offers.t, offers.t + make_interval(mins => v_duration),
         d.day, to_char(offers.t at time zone v_tz, 'HH24:MI'), offers.total > 48
    from days d cross join lateral (
      select first_offers.*, count(*) over () as total from (
        select e.id, e.display_name, slot.t
          from eligible e
          cross join lateral public.public_booking_slot_candidates_for_practitioner(
            p_studio_id, d.day, v_duration, e.id
          ) slot(t)
         where slot.t > now() and (p_start is null or slot.t = p_start)
         order by slot.t, e.display_name, e.id limit 49
      ) first_offers
      order by first_offers.t, first_offers.display_name, first_offers.id limit 48
    ) offers
   order by d.day, offers.t, offers.display_name, offers.id;
end;
$function$;

-- Confirm the preview under the scheduling command's lock order. This also
-- rechecks studio-wide hours when capacity is off, and a service duration edited
-- after the preview cannot extend a visit without the receptionist's knowledge.
create or replace function public.receptionist_book_opening(
  p_studio_id uuid, p_client_id uuid, p_service_id uuid, p_practitioner_id uuid,
  p_start timestamptz, p_expected_end timestamptz
)
returns table (result text, appointment_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_day date;
begin
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_practitioner_id is null or p_start is null or p_expected_end is null
      or not isfinite(p_start) or not isfinite(p_expected_end) or p_expected_end <= p_start then
    return query select 'opening_unavailable'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  select (p_start at time zone s.timezone)::date into v_day
    from public.studios s where s.id = p_studio_id for update;
  perform public.acquire_studio_capacity_lock(p_studio_id);
  perform 1 from public.clients c where c.studio_id = p_studio_id and c.id = p_client_id and c.archived_at is null for share;
  if not found then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- The create command takes this row FOR UPDATE too. Hold it across the read
  -- and create so the displayed end time stays authoritative during confirmation.
  perform 1 from public.services sv where sv.studio_id = p_studio_id and sv.id = p_service_id for update;
  if not exists (
    select 1 from public.receptionist_find_openings(p_studio_id, p_service_id, p_practitioner_id, v_day, v_day, p_start) o
    where o.ends_at = p_expected_end
  ) then
    return query select 'opening_unavailable'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  return query select * from public.receptionist_create_appointment(
    p_studio_id, p_practitioner_id, p_client_id, p_service_id, p_start
  );
end;
$function$;

revoke all on function public.receptionist_find_openings(uuid,uuid,uuid,date,date,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.receptionist_book_opening(uuid,uuid,uuid,uuid,timestamptz,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.receptionist_find_openings(uuid,uuid,uuid,date,date,timestamptz) to authenticated;
grant execute on function public.receptionist_book_opening(uuid,uuid,uuid,uuid,timestamptz,timestamptz) to authenticated;

commit;
