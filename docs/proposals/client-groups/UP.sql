begin;
set local lock_timeout = '5s';

create table public.client_groups (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
  name_key text generated always as (lower(btrim(name))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, name_key),
  unique (id, studio_id)
);
create table public.client_group_memberships (
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null,
  group_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (studio_id, client_id, group_id),
  foreign key (client_id, studio_id) references public.clients(id, studio_id) on delete cascade,
  foreign key (group_id, studio_id) references public.client_groups(id, studio_id)
);
create index client_group_memberships_filter on public.client_group_memberships(studio_id, group_id, client_id);
alter table public.client_groups enable row level security;
alter table public.client_group_memberships enable row level security;
create policy client_groups_owner_read on public.client_groups for select to authenticated
  using (public.is_studio_owner(studio_id));
create policy client_group_memberships_owner_read on public.client_group_memberships for select to authenticated
  using (public.is_studio_owner(studio_id));
revoke all on public.client_groups, public.client_group_memberships from public, anon, authenticated, service_role;
grant select (id,studio_id,name,created_at,updated_at) on public.client_groups to authenticated;
grant select (studio_id,client_id,group_id,created_at) on public.client_group_memberships to authenticated;

create function public.create_client_group(p_studio_id uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '5s' as $$
declare v_group public.client_groups%rowtype; v_name text := btrim(p_name);
begin
  if not coalesce(public.is_studio_owner(p_studio_id), false) then return jsonb_build_object('status','denied'); end if;
  if v_name is null or char_length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then return jsonb_build_object('status','invalid'); end if;
  -- Serialize catalogue commands without conflicting with membership FK key-share locks.
  perform 1 from public.studios where id = p_studio_id for no key update;
  select * into v_group from public.client_groups where studio_id = p_studio_id and name_key = lower(v_name);
  if found then return jsonb_build_object('status','exists'); end if;
  if (select count(*) from public.client_groups where studio_id = p_studio_id) >= 100 then return jsonb_build_object('status','limit'); end if;
  insert into public.client_groups(studio_id,name) values(p_studio_id,v_name);
  return jsonb_build_object('status','created');
end $$;

create function public.rename_client_group(p_studio_id uuid, p_group_id uuid, p_name text, p_expected_name text, p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '5s' as $$
declare v_group public.client_groups%rowtype; v_name text := btrim(p_name);
begin
  if not coalesce(public.is_studio_owner(p_studio_id),false) then return jsonb_build_object('status','denied'); end if;
  if v_name is null or char_length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then return jsonb_build_object('status','invalid'); end if;
  perform 1 from public.studios where id = p_studio_id for no key update;
  select * into v_group from public.client_groups where studio_id=p_studio_id and id=p_group_id for update;
  if not found then return jsonb_build_object('status','missing'); end if;
  if v_group.name is distinct from p_expected_name or v_group.updated_at is distinct from p_expected_updated_at then return jsonb_build_object('status','stale'); end if;
  if exists(select 1 from public.client_groups where studio_id=p_studio_id and name_key=lower(v_name) and id<>p_group_id) then return jsonb_build_object('status','duplicate'); end if;
  update public.client_groups set name=v_name, updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond') where id=p_group_id;
  return jsonb_build_object('status','renamed');
end $$;

create function public.set_client_group_membership(p_studio_id uuid, p_client_id uuid, p_group_id uuid, p_assigned boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '5s' as $$
begin
  if not coalesce(public.is_studio_owner(p_studio_id),false) then return jsonb_build_object('status','denied'); end if;
  if p_assigned is null then return jsonb_build_object('status','invalid'); end if;
  -- Serialize same-pair assignment/removal as well as catalogue changes.
  perform 1 from public.studios where id = p_studio_id for no key update;
  if not exists(select 1 from public.clients where id=p_client_id and studio_id=p_studio_id)
    or not exists(select 1 from public.client_groups where id=p_group_id and studio_id=p_studio_id) then return jsonb_build_object('status','missing'); end if;
  if p_assigned then
    insert into public.client_group_memberships(studio_id,client_id,group_id) values(p_studio_id,p_client_id,p_group_id) on conflict do nothing;
  else
    delete from public.client_group_memberships where studio_id=p_studio_id and client_id=p_client_id and group_id=p_group_id;
  end if;
  return jsonb_build_object('status','saved');
end $$;
revoke all on function public.create_client_group(uuid,text), public.rename_client_group(uuid,uuid,text,text,timestamptz), public.set_client_group_membership(uuid,uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.create_client_group(uuid,text), public.rename_client_group(uuid,uuid,text,text,timestamptz), public.set_client_group_membership(uuid,uuid,uuid,boolean) to authenticated;
commit;
