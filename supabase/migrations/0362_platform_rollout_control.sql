-- ===========================================================================
-- Platform rollout control (xCell MultiPlex and New view).
-- Adds the control that decides, per studio, whether the new charting view and the xCell offer are available. No backfill of existing rows; it
-- touches no studio, machine, reading, capture or block table. The one seeded row is the control itself, mode off.
--
-- Two tables and a set of service-role-only commands. The admin identity is app-level (ADMIN_EMAILS), so the DATABASE cannot verify the actor: the
-- service-role-only grant is the boundary, exactly as for every existing admin write. The caller passes the actor's user id and email, taken from
-- the authenticated session after isAdmin (never from form input). Every change writes its audit row (admin_action_events) IN THE SAME
-- TRANSACTION with constant action/target_type values and metadata built here (mode before/after, or the studio id) and nothing caller-supplied.
-- ===========================================================================
begin;
set local lock_timeout = '5s';

create table public.platform_rollouts (
  key        text primary key check (key in ('charting_new_view_xcell')),
  mode       text not null default 'off' check (mode in ('off', 'pilot', 'all')),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.platform_rollouts (key) values ('charting_new_view_xcell');

create table public.platform_rollout_studios (
  rollout_key text not null references public.platform_rollouts (key),
  studio_id   uuid not null references public.studios (id) on delete cascade,
  added_by    uuid,
  added_at    timestamptz not null default now(),
  primary key (rollout_key, studio_id)
);

alter table public.platform_rollouts enable row level security;
alter table public.platform_rollout_studios enable row level security;
revoke all on public.platform_rollouts from public, anon, authenticated, service_role;
revoke all on public.platform_rollout_studios from public, anon, authenticated, service_role;
-- No policy and no grant for any client role: the commands below are the only path.

-- The ONE read. Fails closed: an unknown key, a missing studio id or any unexpected state is false. 'all' never reads membership.
create function public.platform_rollout_enabled_for(p_key text, p_studio uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_mode text;
begin
  if p_key is null or p_studio is null then return false; end if;
  select r.mode into v_mode from public.platform_rollouts r where r.key = p_key;
  if v_mode = 'all' then return true; end if;
  if v_mode = 'pilot' then
    return exists (select 1 from public.platform_rollout_studios s where s.rollout_key = p_key and s.studio_id = p_studio);
  end if;
  return false;
end;
$$;

create function public.platform_rollout_check_actor(p_actor_user_id uuid, p_actor_email text)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if p_actor_user_id is null then
    raise exception 'platform rollout: an actor user id is required' using errcode = '23514';
  end if;
  if p_actor_email is null or length(p_actor_email) > 254 or p_actor_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$' then
    raise exception 'platform rollout: the actor email is not valid' using errcode = '23514';
  end if;
end;
$$;

create function public.set_platform_rollout_mode(p_key text, p_mode text, p_actor_user_id uuid, p_actor_email text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before text;
begin
  perform public.platform_rollout_check_actor(p_actor_user_id, p_actor_email);
  if p_mode is null or p_mode not in ('off', 'pilot', 'all') then
    raise exception 'platform rollout: unknown mode' using errcode = '23514';
  end if;
  select r.mode into v_before from public.platform_rollouts r where r.key = p_key for update;
  if not found then
    raise exception 'platform rollout: unknown key' using errcode = '23514';
  end if;
  if v_before = p_mode then return 'unchanged'; end if;
  update public.platform_rollouts set mode = p_mode, updated_by = p_actor_user_id, updated_at = now() where key = p_key;
  insert into public.admin_action_events (actor_user_id, actor_email, actor_role, target_type, target_id, action, outcome, source, metadata)
  values (p_actor_user_id, p_actor_email, 'admin', 'platform_rollout', p_key, 'platform_rollout_mode_set', 'succeeded', 'admin',
          jsonb_build_object('mode_before', v_before, 'mode_after', p_mode));
  return 'changed';
end;
$$;

create function public.add_platform_rollout_studio(p_key text, p_studio uuid, p_actor_user_id uuid, p_actor_email text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer;
begin
  perform public.platform_rollout_check_actor(p_actor_user_id, p_actor_email);
  perform 1 from public.platform_rollouts r where r.key = p_key for update;
  if not found then raise exception 'platform rollout: unknown key' using errcode = '23514'; end if;
  if p_studio is null or not exists (select 1 from public.studios s where s.id = p_studio) then return 'not_found'; end if;
  insert into public.platform_rollout_studios (rollout_key, studio_id, added_by) values (p_key, p_studio, p_actor_user_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return 'exists'; end if;
  insert into public.admin_action_events (actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, source, metadata)
  values (p_actor_user_id, p_actor_email, 'admin', p_studio, 'platform_rollout', p_key, 'platform_rollout_studio_added', 'succeeded', 'admin',
          jsonb_build_object('studio_id', p_studio::text));
  return 'added';
end;
$$;

create function public.remove_platform_rollout_studio(p_key text, p_studio uuid, p_actor_user_id uuid, p_actor_email text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  perform public.platform_rollout_check_actor(p_actor_user_id, p_actor_email);
  perform 1 from public.platform_rollouts r where r.key = p_key for update;
  if not found then raise exception 'platform rollout: unknown key' using errcode = '23514'; end if;
  delete from public.platform_rollout_studios where rollout_key = p_key and studio_id = p_studio;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then return 'absent'; end if;
  insert into public.admin_action_events (actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, source, metadata)
  values (p_actor_user_id, p_actor_email, 'admin', p_studio, 'platform_rollout', p_key, 'platform_rollout_studio_removed', 'succeeded', 'admin',
          jsonb_build_object('studio_id', p_studio::text));
  return 'removed';
end;
$$;

-- A signed-in NON-ADMIN's attempt: ONE blocked row per user per action per 10 minutes, so a loop cannot grow the table. The row carries the user id
-- only (never an email), a constant action and target_type, and no body or free text. A request with no session writes nothing (the server never calls this).
create function public.log_refused_platform_rollout_attempt(p_actor_user_id uuid, p_action text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_actor_user_id is null
     or p_action is null
     or p_action not in ('platform_rollout_mode_set', 'platform_rollout_studio_added', 'platform_rollout_studio_removed') then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform_rollout_blocked:' || p_actor_user_id::text || ':' || p_action, 0));
  if exists (select 1 from public.admin_action_events e
              where e.actor_user_id = p_actor_user_id and e.target_type = 'platform_rollout' and e.action = p_action
                and e.outcome = 'blocked' and e.created_at > now() - interval '10 minutes') then
    return false;
  end if;
  insert into public.admin_action_events (actor_user_id, target_type, action, outcome, source)
  values (p_actor_user_id, 'platform_rollout', p_action, 'blocked', 'admin');
  return true;
end;
$$;

-- Admin page read (service role): the mode, who changed it last, and the pilot studios with their names. No ids leave the server.
create function public.list_platform_rollout(p_key text)
returns table (mode text, updated_by uuid, updated_at timestamptz, studio_id uuid, studio_name text, added_by uuid, added_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.mode, r.updated_by, r.updated_at, s.studio_id, st.name, s.added_by, s.added_at
    from public.platform_rollouts r
    left join public.platform_rollout_studios s on s.rollout_key = r.key
    left join public.studios st on st.id = s.studio_id
   where r.key = p_key
   order by st.name nulls last, s.added_at;
$$;

-- Grants: ALL FOUR default-granted roles revoked by name; service_role only (the admin server path).
revoke all on function public.platform_rollout_enabled_for(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.platform_rollout_check_actor(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.set_platform_rollout_mode(text, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.add_platform_rollout_studio(text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.remove_platform_rollout_studio(text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_platform_rollout(text) from public, anon, authenticated, service_role;
revoke all on function public.log_refused_platform_rollout_attempt(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.platform_rollout_enabled_for(text, uuid) to service_role;
grant execute on function public.set_platform_rollout_mode(text, text, uuid, text) to service_role;
grant execute on function public.add_platform_rollout_studio(text, uuid, uuid, text) to service_role;
grant execute on function public.remove_platform_rollout_studio(text, uuid, uuid, text) to service_role;
grant execute on function public.list_platform_rollout(text) to service_role;
grant execute on function public.log_refused_platform_rollout_attempt(uuid, text) to service_role;
-- platform_rollout_check_actor is an internal helper: no role may call it directly (the definer commands run as the owner).

comment on table public.platform_rollouts is 'Platform feature rollout mode (off, pilot, all). Changed only by the admin commands, which audit every change.';
comment on table public.platform_rollout_studios is 'Pilot membership for a platform rollout. added_by is the operator user id only.';

commit;
