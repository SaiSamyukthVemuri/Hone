-- Down for the access-events change: restore the previous body of set_practitioner_active_locked and drop the access-event table (its rows go with it). Rollback only; never run against a hosted database without approval.
begin;
set local lock_timeout = '5s';

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

revoke execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) to service_role;

drop table public.practitioner_access_events;

commit;
