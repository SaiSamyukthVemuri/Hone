-- 0390 DOWN: remove the Front Desk rollout key, the seat grants and their enforcement, and restore the three replaced function bodies exactly.
-- REFUSES (55000, changing nothing) while ANY seat grant exists, any studio is on the front_desk pilot list, or the front_desk mode is not off, and
-- unless the three replaced functions are still the 0390 bodies.
begin;
set local lock_timeout = '5s';

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.receptionist_actor_id(uuid)')) is distinct from 'b1b52605ad988e2c95701d195358ccda'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.set_studio_receptionist_active(uuid,uuid,uuid,boolean)')) is distinct from '7c56049af4fe808dfbc0935fc538b756'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.link_invited_membership(uuid,text,public.pending_invitations,text,timestamptz,text,timestamptz,text)')) is distinct from '13435eb871aaadbbbeee0b6ed1ec649b' then
    raise exception '0390 down: a replaced function is not the 0390 body; refusing' using errcode = '55000';
  end if;
  if exists (select 1 from public.studio_front_desk_seats) then
    raise exception '0390 down: seat grants exist; refusing (revoked grants are history and are kept)' using errcode = '55000';
  end if;
  if exists (select 1 from public.platform_rollout_studios where rollout_key = 'front_desk')
     or exists (select 1 from public.platform_rollouts where key = 'front_desk' and mode <> 'off') then
    raise exception '0390 down: the front_desk key is in use (a studio is listed or the mode is not off); refusing' using errcode = '55000';
  end if;
end;
$$;

drop trigger studio_receptionists_seat_guard_trg on public.studio_receptionists;
drop trigger pending_invitations_front_desk_guard_trg on public.pending_invitations;

-- the three frozen bodies, restored verbatim (0216 and 0218)
create or replace function public.set_studio_receptionist_active(
  p_studio_id              uuid,
  p_owner_practitioner_id  uuid,
  p_receptionist_id        uuid,
  p_active                 boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row       public.studio_receptionists%rowtype;
  v_lock_user uuid;
begin
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_owner_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active
       and pr.role = 'owner'
  ) then
    return 'not_authorized';
  end if;
  if p_active is null then
    raise exception 'invalid_active' using errcode = '22004';
  end if;

  -- LOCK ORDER: the membership-kind advisory lock BEFORE the row lock, exactly
  -- as add_studio_receptionist takes them. Locking the row first would let a
  -- concurrent reactivation through add_studio_receptionist (advisory, then
  -- row) and this command (row, then the guard trigger's advisory) deadlock
  -- (40P01) instead of serializing. The user id is read unlocked only to name
  -- the lock, and the locked read below re-checks everything.
  select sr.user_id into v_lock_user
    from public.studio_receptionists sr
   where sr.id = p_receptionist_id and sr.studio_id = p_studio_id;
  if not found then
    return 'not_found';
  end if;
  if v_lock_user is not null then
    perform public.studio_membership_kind_lock(p_studio_id, v_lock_user);
  end if;

  select * into v_row
    from public.studio_receptionists sr
   where sr.id = p_receptionist_id and sr.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.user_id is distinct from v_lock_user then
    -- The membership changed between the two reads, so the lock taken above
    -- may not be the one the guard needs. Refuse rather than lock out of order.
    raise exception 'receptionist_changed_concurrently' using errcode = '40001';
  end if;
  if v_row.active = p_active then
    return 'no_change';
  end if;

  update public.studio_receptionists
     set active = p_active,
         deactivated_at = case when p_active then null else now() end
   where id = v_row.id;
  return 'updated';
end;
$$;

create or replace function public.receptionist_actor_id(p_studio_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select sr.id
    from public.studio_receptionists sr
   where sr.studio_id = p_studio_id
     and sr.user_id = auth.uid()
     and sr.active
   limit 1;
$$;

create or replace function public.link_invited_membership(
  p_uid uuid,
  p_email text,
  p_invite public.pending_invitations,
  p_studio_name text,
  p_terms_accepted_at timestamptz,
  p_terms_version text,
  p_privacy_accepted_at timestamptz,
  p_privacy_version text
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_same public.practitioners%rowtype;
  v_membership_count int;
  v_desk_id uuid;
begin
  if p_invite.role = 'receptionist' then
    -- Lock order as in 0216: the membership-kind lock, THEN the row. The
    -- dual-membership guard re-checks the practitioner side and raises 23514
    -- if this person is an active practitioner of the studio.
    perform public.studio_membership_kind_lock(p_invite.studio_id, p_uid);

    -- Safe-conflict guard, the receptionist twin of 0141's practitioner one: a
    -- DIFFERENT user already holds an ACTIVE front-desk row under the invited
    -- email in this studio. Refuse before writing anything, and leave the
    -- invitation pending for operator cleanup (Codex P2 4243953169 on #850).
    if exists (
      select 1 from public.studio_receptionists sr
       where sr.studio_id = p_invite.studio_id
         and lower(sr.email) = lower(p_email)
         and sr.user_id is distinct from p_uid
         and sr.active
    ) then
      return jsonb_build_object('status', 'conflict', 'choose_studio', false);
    end if;

    select sr.id into v_desk_id
    from public.studio_receptionists sr
    where sr.studio_id = p_invite.studio_id and sr.user_id = p_uid
    for update;

    if found then
      update public.studio_receptionists set
        email               = p_email,
        display_name        = coalesce(p_invite.display_name, display_name, p_email),
        active              = true,
        deactivated_at      = null,
        terms_accepted_at   = p_terms_accepted_at,
        terms_version       = p_terms_version,
        privacy_accepted_at = p_privacy_accepted_at,
        privacy_version     = p_privacy_version
      where id = v_desk_id;
    else
      insert into public.studio_receptionists
        (studio_id, user_id, display_name, email, active, created_by_practitioner_id,
         terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
      values
        (p_invite.studio_id, p_uid, coalesce(p_invite.display_name, p_email),
         p_email, true, p_invite.invited_by,
         p_terms_accepted_at, p_terms_version, p_privacy_accepted_at, p_privacy_version);
    end if;

    update public.pending_invitations
    set status = 'accepted', accepted_at = now()
    where id = p_invite.id;

    -- No studio_onboarding row: that state belongs to the practitioner side.
    -- choose_studio is role-aware: true when this person now works the front
    -- desk at 2+ studios, so the adapters send them to the receptionist chooser
    -- (/front-desk/select) instead of reopening a stale selection (Codex P2
    -- 4243953164 on #850). Practitioner memberships elsewhere do not count here.
    select count(*) into v_membership_count
    from public.studio_receptionists where user_id = p_uid and active;

    return jsonb_build_object(
      'status', 'linked',
      'choose_studio', v_membership_count > 1,
      'studio_name', p_studio_name, 'role', 'receptionist');
  end if;

  -- The caller's own row in the target studio (any active state).
  select * into v_same
  from public.practitioners
  where studio_id = p_invite.studio_id and user_id = p_uid
  limit 1;

  if found then
    -- Reactivate/refresh IN PLACE — never a second INSERT. Role-change policy:
    -- the invitation role wins.
    update public.practitioners set
      email               = p_email,
      display_name        = coalesce(p_invite.display_name, display_name, p_email),
      role                = p_invite.role,
      active              = true,
      terms_accepted_at   = p_terms_accepted_at,
      terms_version       = p_terms_version,
      privacy_accepted_at = p_privacy_accepted_at,
      privacy_version     = p_privacy_version
    where id = v_same.id;
  else
    insert into public.practitioners
      (studio_id, user_id, display_name, email, role, active,
       terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
    values
      (p_invite.studio_id, p_uid, coalesce(p_invite.display_name, p_email),
       p_email, p_invite.role, true,
       p_terms_accepted_at, p_terms_version, p_privacy_accepted_at, p_privacy_version);
  end if;

  update public.pending_invitations
  set status = 'accepted', accepted_at = now()
  where id = p_invite.id;

  insert into public.studio_onboarding (studio_id)
  values (p_invite.studio_id)
  on conflict (studio_id) do nothing;

  select count(*) into v_membership_count
  from public.practitioners where user_id = p_uid and active;

  return jsonb_build_object(
    'status', 'linked',
    'choose_studio', v_membership_count > 1,
    'studio_name', p_studio_name, 'role', p_invite.role);
end;
$$;

drop function public.front_desk_access();
drop function public.admin_grant_front_desk_seats(uuid, integer, text, text, timestamptz, uuid, text);
drop function public.admin_revoke_front_desk_seats(uuid, text, uuid, text);
drop function public.admin_list_front_desk(uuid);
drop function public.owner_front_desk_summary(uuid, uuid);
drop function public.pending_invitations_front_desk_guard();
drop function public.studio_receptionists_front_desk_guard();
drop function public.front_desk_is_seated(uuid, uuid);
drop function public.front_desk_seat_claim(uuid, uuid, uuid);
drop function public.front_desk_seat_limit(uuid);
drop table public.studio_front_desk_seats;
drop function public.studio_front_desk_seats_guard();

delete from public.platform_rollouts where key = 'front_desk' and mode = 'off';
alter table public.platform_rollouts drop constraint platform_rollouts_front_desk_mode_check;
alter table public.platform_rollouts drop constraint platform_rollouts_key_check;
alter table public.platform_rollouts add constraint platform_rollouts_key_check check (key = 'charting_new_view_xcell');

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.receptionist_actor_id(uuid)')) is distinct from '31fb3186a227fd39470c4670e876935a'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.set_studio_receptionist_active(uuid,uuid,uuid,boolean)')) is distinct from 'b2da4d0825f27647af1ce9b908537f72'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.link_invited_membership(uuid,text,public.pending_invitations,text,timestamptz,text,timestamptz,text)')) is distinct from 'a7d5c0d8a0af5fabf6a70dee0097f215' then
    raise exception '0390 down: a restored body does not equal the pre-0390 body' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.platform_rollouts) <> 1 then
    raise exception '0390 down: platform_rollouts is not the one 0362 row' using errcode = 'check_violation';
  end if;
end;
$$;

commit;
