-- Scheduling uses the client's preferred or regular profile name. Legal identity
-- is a separate record and is outside both of these projections.
begin;
set local lock_timeout = '5s';

create or replace function public.receptionist_calendar_v3(
  p_studio_id uuid, p_from timestamptz, p_to timestamptz
)
returns table (
  appointment_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
  practitioner_id uuid, practitioner_display_name text, practitioner_color text,
  service_name text, display_name text, duration_minutes integer, studio_timezone text
)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  -- v2 enforces active membership, validates the window and resolves the
  -- studio clock. Keep that schedule as the single owner of visit selection.
  select v.appointment_id, v.starts_at, v.ends_at, v.status,
         v.practitioner_id, v.practitioner_display_name, v.practitioner_color,
         v.service_name,
         coalesce(nullif(btrim(c.preferred_name), ''), nullif(btrim(c.name), ''), 'Name on file'),
         v.duration_minutes, v.studio_timezone
    from public.receptionist_calendar_v2(p_studio_id, p_from, p_to) v
    left join public.clients c on c.id = v.client_id and c.studio_id = p_studio_id
   order by v.starts_at, v.appointment_id;
$$;

create or replace function public.receptionist_booking_clients_v3(p_studio_id uuid, p_query text, p_limit integer)
returns table (client_id uuid, display_name text, contact_hint text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  term text := lower(btrim(coalesce(p_query, '')));
  -- Phone search compares digits only, so "5550188" finds "(416) 555-0188". A lone digit never searches phones.
  term_digits text := regexp_replace(term, '[^0-9]', '', 'g');
begin
  if auth.uid() is null or public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if length(term) not between 2 and 80 then
    raise exception 'invalid_query' using errcode = '22023';
  end if;
  -- Matches the displayed name (preferred, else regular), the email (any case) or the phone's digits.
  -- The legal identity lives in its own table and is never read here. Full contact values never leave this
  -- function: each row carries a masked hint, and the full phone and email come from the visit itself.
  return query
    select c.id, coalesce(c.label, 'Name on file'),
           nullif(concat_ws(' · ',
             case when c.email like '%@%' then '•••@' || lower(left(split_part(c.email, '@', 2), 2)) || '…' || lower(right(split_part(c.email, '@', 2), 3)) end,
             case when length(c.phone_digits) >= 4 then '•••' || right(c.phone_digits, 4) end), '')
      from (
        select c.id, coalesce(nullif(btrim(c.preferred_name), ''), nullif(btrim(c.name), '')) as label,
               btrim(c.email) as email, regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') as phone_digits
          from public.clients c
         where c.studio_id = p_studio_id and c.archived_at is null
      ) c
     where strpos(lower(c.label), term) > 0 or strpos(lower(c.email), term) > 0
        or (length(term_digits) >= 2 and strpos(c.phone_digits, term_digits) > 0)
     order by c.label nulls last, c.id
     limit least(greatest(coalesce(p_limit, 11), 1), 11);
end;
$$;

revoke all on function public.receptionist_calendar_v3(uuid,timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.receptionist_booking_clients_v3(uuid,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.receptionist_calendar_v3(uuid,timestamptz,timestamptz) to authenticated;
grant execute on function public.receptionist_booking_clients_v3(uuid,text,integer) to authenticated;
commit;
