-- Contact details for one appointment selected in the receptionist calendar.
begin;
set local lock_timeout = '5s';

create or replace function public.receptionist_appointment_contact(p_studio_id uuid, p_appointment_id uuid)
returns table (phone text, email text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null or public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
    select c.phone, c.email
      from public.appointments a
      join public.clients c on c.studio_id = a.studio_id and c.id = a.client_id
     where a.studio_id = p_studio_id and a.id = p_appointment_id and c.archived_at is null;
end;
$$;

revoke all on function public.receptionist_appointment_contact(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.receptionist_appointment_contact(uuid, uuid) to authenticated;

commit;
