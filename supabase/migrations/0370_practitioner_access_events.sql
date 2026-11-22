-- Practitioner access events: a record of every RESTORE of a team member's access (who restored whom, and when), written by the same database command that makes the change.
--
-- WHAT CHANGES. One new append-only table, public.practitioner_access_events, and one function replaced: public.set_practitioner_active_locked.
-- The function keeps its signature, return values, language, security setting, search_path, lock order and the unconditional update. The only addition is
-- that, under the existing row lock on the target, it compares the stored value with the requested one and, only when a RESTORE really changes the value (inactive to active), inserts one record.
-- A repeated or concurrent request finds the value already changed (the target row is locked for update before the read), so it writes no second record;
-- a request that changes nothing writes none.
--
-- WHAT THE TABLE HOLDS. studio, who did it (the owner), who it was done to, the action ('restored') and the time. No client data, no names,
-- no email, no free text. RLS is on and FORCED with no policy: no signed-in user can read or write it. Only the database owner (this function) writes.
--
-- RESTORES ONLY. Removals are deliberately not recorded here (a separate later item); the function's removal path is unchanged.
--
-- Rollback: the paired down file restores the previous function body and drops the table (its rows go with it).
begin;
set local lock_timeout = '5s';

create table public.practitioner_access_events (
  id                      uuid primary key default gen_random_uuid(),
  studio_id               uuid not null references public.studios (id) on delete cascade,
  actor_practitioner_id   uuid references public.practitioners (id) on delete set null,
  target_practitioner_id  uuid references public.practitioners (id) on delete set null,
  action                  text not null check (action in ('restored')),
  created_at              timestamptz not null default now()
);

create index practitioner_access_events_studio_idx on public.practitioner_access_events (studio_id, created_at desc);

alter table public.practitioner_access_events enable row level security;
alter table public.practitioner_access_events force row level security;

-- No policy exists. Strip every grant from every API role by name, then give the service role read-only access (the owner function writes as the table owner).
revoke all on table public.practitioner_access_events from public, anon, authenticated, service_role;
grant select on table public.practitioner_access_events to service_role;

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
  v_gate        text;
  v_target_role text;
  v_old_active  boolean;
  v_new_active  boolean;
begin
  v_gate := public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id);
  if v_gate <> 'ok' then return v_gate; end if;

  select pr.role, pr.active into v_target_role, v_old_active
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

  v_new_active := coalesce(p_active, false);

  update public.practitioners
     set active = v_new_active
   where id = p_target_practitioner_id and studio_id = p_studio_id;

  -- A record is written only when a restore really changed the value, under the row lock taken above.
  if v_new_active and v_old_active is distinct from v_new_active then
    insert into public.practitioner_access_events (studio_id, actor_practitioner_id, target_practitioner_id, action)
    values (p_studio_id, p_actor_practitioner_id, p_target_practitioner_id, 'restored');
  end if;
  return 'ok';
end;
$$;

-- Service role only, restated by name for all four roles (the platform's default privileges grant EXECUTE to anon, authenticated and service_role).
revoke execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) to service_role;

commit;
