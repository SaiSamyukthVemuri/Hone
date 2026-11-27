-- ===========================================================================
-- 0390: FRONT DESK ROLLOUT KEY AND STUDIO SEATS (receptionist pilot, HON-44 / HON-88)
-- ===========================================================================
--
-- WHAT THIS IS. The Front Desk (the receptionist desk) is switched on per studio, and a studio may hold only as many ACTIVE receptionists as
-- an admin has granted seats for. Both are decided by the database, not only by the application: every receptionist command derives its actor
-- from receptionist_actor_id(), and that one function now answers null unless the studio's switch is on AND the receptionist ranks inside the
-- studio's seat limit. So a switch-off, a revoked grant or an expired grant also stops a receptionist who calls an authenticated function
-- directly with their own session.
--
-- WHAT IT ADDS.
--   1. The per-studio switch REUSES 0362: platform_rollouts gets a second key, 'front_desk' (seeded in mode off), and the per-studio pilot
--      list (platform_rollout_studios) is the switch. The existing 0362 commands set the mode, add and remove a studio, and list. A new CHECK
--      refuses mode 'all' for this key, so no single action can enable every studio. 0362's functions, grants and its charting row are untouched.
--   2. studio_front_desk_seats: seat GRANTS (capacity, not one seat per person). A grant has a count (1 to 50), a source (plan_included,
--      custom_agreed or pilot), a reason (1 to 500 characters), the admin who granted it (evidence), an optional UTC expiry and a revocation stamp.
--      The studio's seat limit is the sum of its live grants (not revoked, not expired) read at the moment of use: expiry needs no job and no write.
--   3. Admin commands (service_role only; the admin identity is passed by the server after its own admin check and is EVIDENCE, not authority):
--        admin_grant_front_desk_seats, admin_revoke_front_desk_seats, admin_list_front_desk, owner_front_desk_summary.
--      Each grant and revoke writes admin_action_events in the SAME transaction (ids and numbers only: no name, email or reason).
--      REVOKING DOES NOT DEACTIVATE ANYONE AND CANCELS NO INVITATION: it only stamps the grant. Anyone ranked beyond the new limit is refused at
--      the next call by the gate, rows are kept, and the owner chooses whom to remove.
--   4. front_desk_access(): authenticated, no argument, answers about the signed-in user only: the studios where the switch is on, the
--      receptionist is active and is seated.
--   5. Seat enforcement at the three doors, under ONE per-studio advisory lock: INVITE (a BEFORE trigger on pending_invitations, receptionist
--      role only), ACCEPT (link_invited_membership, receptionist branch, returns a status) and REACTIVATE / ADD (set_studio_receptionist_active
--      returns a status; add_studio_receptionist and every other writer meet the BEFORE trigger on studio_receptionists, which raises).
--      ONE RULE EVERYWHERE: active receptionists (not counting the row being written) + pending receptionist invitations (not counting the
--      invitation being accepted or re-written) + 1 must not exceed the seat limit, and the switch must be on.
--
-- ERROR CONTRACT. Triggers and add_studio_receptionist raise SQLSTATE P0001 with the message 'front_desk_not_enabled' or
-- 'front_desk_seat_limit_reached'. set_studio_receptionist_active returns the text 'front_desk_off' or 'seat_limit'. link_invited_membership
-- returns jsonb with status 'front_desk_off' or 'seat_limit' and writes nothing (the invitation stays pending).
--
-- LOCK ORDER (every path that takes both): studio_membership_kind_lock(studio, user) FIRST, then the seat lock hone:front-desk-seats:<studio>.
-- Invite, grant and revoke take only the seat lock. The seat lock is always last, so there is no cycle.
--
-- STARTS EMPTY. No seat grant is written, no studio is added to the pilot list, and the seeded key is OFF. The migration REFUSES to run if
-- any receptionist row or any receptionist invitation exists, because those people would lose the desk at once (production held none when
-- this was written; re-read before the apply).
--
-- FROZEN BODIES REPLACED (each asserted by md5 against the body it was written against; the migration refuses if production differs):
--   receptionist_actor_id(uuid) (0216), set_studio_receptionist_active(uuid, uuid, uuid, boolean) (0216) and
--   link_invited_membership(...) (0218). Their signatures, return types and privileges are unchanged.
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.receptionist_actor_id(uuid)')) is distinct from '31fb3186a227fd39470c4670e876935a' then
    raise exception '0390: receptionist_actor_id is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.set_studio_receptionist_active(uuid,uuid,uuid,boolean)')) is distinct from 'b2da4d0825f27647af1ce9b908537f72' then
    raise exception '0390: set_studio_receptionist_active is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.link_invited_membership(uuid,text,public.pending_invitations,text,timestamptz,text,timestamptz,text)')) is distinct from 'a7d5c0d8a0af5fabf6a70dee0097f215' then
    raise exception '0390: link_invited_membership is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
  if to_regprocedure('public.platform_rollout_enabled_for(text,uuid)') is null
     or to_regprocedure('public.platform_rollout_check_actor(uuid,text)') is null
     or to_regprocedure('public.studio_membership_kind_lock(uuid,uuid)') is null then
    raise exception '0390: the 0362 rollout control or the 0216 membership lock is missing' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.platform_rollouts) <> 1
     or not exists (select 1 from public.platform_rollouts where key = 'charting_new_view_xcell') then
    raise exception '0390: platform_rollouts is not exactly the one 0362 row' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.studio_receptionists) then
    raise exception '0390: a receptionist row exists; this migration starts empty, so those people would lose the desk' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.pending_invitations where role = 'receptionist' and status = 'pending') then
    raise exception '0390: a pending receptionist invitation exists; this migration starts empty' using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The rollout key (reuses 0362)
-- ---------------------------------------------------------------------------
alter table public.platform_rollouts drop constraint platform_rollouts_key_check;
alter table public.platform_rollouts
  add constraint platform_rollouts_key_check check (key in ('charting_new_view_xcell', 'front_desk'));
alter table public.platform_rollouts
  add constraint platform_rollouts_front_desk_mode_check check (key <> 'front_desk' or mode in ('off', 'pilot'));
insert into public.platform_rollouts (key) values ('front_desk');

-- ---------------------------------------------------------------------------
-- 2. Seat grants
-- ---------------------------------------------------------------------------
create table public.studio_front_desk_seats (
  id               uuid primary key default gen_random_uuid(),
  studio_id        uuid not null references public.studios (id) on delete cascade,
  seats            integer not null,
  source           text not null,
  reason           text not null,
  granted_at       timestamptz not null default now(),
  granted_by_admin text not null,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by_admin text,
  revoke_reason    text,
  constraint studio_front_desk_seats_seats_check check (seats between 1 and 50),
  constraint studio_front_desk_seats_source_check check (source in ('plan_included', 'custom_agreed', 'pilot')),
  constraint studio_front_desk_seats_reason_check check (char_length(btrim(reason)) between 1 and 500),
  constraint studio_front_desk_seats_admin_check check (char_length(btrim(granted_by_admin)) between 1 and 320),
  constraint studio_front_desk_seats_expiry_check check (expires_at is null or expires_at > granted_at),
  constraint studio_front_desk_seats_revoked_check check (
    (revoked_at is null and revoked_by_admin is null and revoke_reason is null)
    or (revoked_at is not null and char_length(btrim(coalesce(revoked_by_admin, ''))) between 1 and 320
        and char_length(btrim(coalesce(revoke_reason, ''))) between 1 and 500)
  )
);
create index studio_front_desk_seats_studio_idx on public.studio_front_desk_seats (studio_id) where revoked_at is null;

alter table public.studio_front_desk_seats enable row level security;
revoke all on public.studio_front_desk_seats from public, anon, authenticated, service_role;
-- No policy and no grant for any role: the commands below are the only path.

comment on table public.studio_front_desk_seats is
  '0390. Front Desk seat grants (capacity). A studio''s seat limit is the sum of its live grants (not revoked, not expired). Written only by the admin commands; a grant is never edited except to revoke it once.';

create function public.studio_front_desk_seats_guard()
returns trigger
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id or new.seats is distinct from old.seats
     or new.source is distinct from old.source or new.reason is distinct from old.reason
     or new.granted_at is distinct from old.granted_at or new.granted_by_admin is distinct from old.granted_by_admin
     or new.expires_at is distinct from old.expires_at then
    raise exception 'studio_front_desk_seats: a grant is only ever revoked, never edited' using errcode = '23514';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoked_by_admin is distinct from old.revoked_by_admin
          or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'studio_front_desk_seats: a revoked grant is final' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger studio_front_desk_seats_guard_trg
  before update on public.studio_front_desk_seats
  for each row execute function public.studio_front_desk_seats_guard();
revoke all privileges on function public.studio_front_desk_seats_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no role may call them; definers call them as the owner)
-- ---------------------------------------------------------------------------
create function public.front_desk_seat_limit(p_studio uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(sum(g.seats), 0)::integer
    from public.studio_front_desk_seats g
   where g.studio_id = p_studio
     and g.revoked_at is null
     and (g.expires_at is null or g.expires_at > now());
$$;

create function public.front_desk_is_seated(p_studio uuid, p_receptionist uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select public.platform_rollout_enabled_for('front_desk', p_studio)
     and exists (
       select 1
         from (select sr.id, row_number() over (order by sr.created_at, sr.id) as rn
                 from public.studio_receptionists sr
                where sr.studio_id = p_studio and sr.active) r
        where r.id = p_receptionist
          and r.rn <= public.front_desk_seat_limit(p_studio)
     );
$$;

-- The one claim rule. Takes the per-studio seat lock (always LAST in the lock order), then returns 'ok', 'front_desk_off' or 'seat_limit'.
create function public.front_desk_seat_claim(p_studio uuid, p_exclude_receptionist uuid, p_exclude_invitation uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit    integer;
  v_active   integer;
  v_reserved integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('hone:front-desk-seats:' || p_studio::text, 0));
  if not public.platform_rollout_enabled_for('front_desk', p_studio) then
    return 'front_desk_off';
  end if;
  v_limit := public.front_desk_seat_limit(p_studio);
  select count(*) into v_active
    from public.studio_receptionists sr
   where sr.studio_id = p_studio and sr.active and sr.id is distinct from p_exclude_receptionist;
  select count(*) into v_reserved
    from public.pending_invitations pi
   where pi.studio_id = p_studio and pi.role = 'receptionist' and pi.status = 'pending'
     and pi.id is distinct from p_exclude_invitation;
  if v_active + v_reserved + 1 > v_limit then
    return 'seat_limit';
  end if;
  return 'ok';
end;
$$;

revoke all privileges on function public.front_desk_seat_limit(uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.front_desk_is_seated(uuid, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.front_desk_seat_claim(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The database gate: receptionist_actor_id answers null unless the switch is on and the receptionist is seated
--    (same signature, same return type, privileges untouched: create or replace keeps them)
-- ---------------------------------------------------------------------------
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
     and public.front_desk_is_seated(sr.studio_id, sr.id)
   limit 1;
$$;

-- The desk's one read: which studios can the signed-in user open the Front Desk for.
create function public.front_desk_access()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select sr.studio_id
    from public.studio_receptionists sr
   where sr.user_id = auth.uid()
     and sr.active
     and public.front_desk_is_seated(sr.studio_id, sr.id);
$$;
revoke all privileges on function public.front_desk_access() from public, anon, authenticated, service_role;
grant execute on function public.front_desk_access() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Enforcement at the doors
-- ---------------------------------------------------------------------------
-- INVITE: a receptionist invitation entering 'pending' reserves a seat.
create function public.pending_invitations_front_desk_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_claim text;
begin
  if new.role = 'receptionist' and new.status = 'pending'
     and (tg_op = 'INSERT'
          or old.role is distinct from 'receptionist'
          or old.status is distinct from 'pending'
          or old.studio_id is distinct from new.studio_id) then
    v_claim := public.front_desk_seat_claim(new.studio_id, null, new.id);
    if v_claim = 'front_desk_off' then
      raise exception 'front_desk_not_enabled' using errcode = 'P0001';
    elsif v_claim = 'seat_limit' then
      raise exception 'front_desk_seat_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all privileges on function public.pending_invitations_front_desk_guard() from public, anon, authenticated, service_role;
create trigger pending_invitations_front_desk_guard_trg
  before insert or update of status, role, studio_id on public.pending_invitations
  for each row execute function public.pending_invitations_front_desk_guard();

-- ADD / REACTIVATE: the backstop for every writer of studio_receptionists. Its name sorts after studio_receptionists_membership_guard_trg, so the
-- membership-kind lock is taken before the seat lock.
create function public.studio_receptionists_front_desk_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_claim text;
begin
  if new.active
     and (tg_op = 'INSERT' or old.active is not true or old.studio_id is distinct from new.studio_id) then
    v_claim := public.front_desk_seat_claim(new.studio_id, new.id, null);
    if v_claim = 'front_desk_off' then
      raise exception 'front_desk_not_enabled' using errcode = 'P0001';
    elsif v_claim = 'seat_limit' then
      raise exception 'front_desk_seat_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all privileges on function public.studio_receptionists_front_desk_guard() from public, anon, authenticated, service_role;
create trigger studio_receptionists_seat_guard_trg
  before insert or update of active, studio_id on public.studio_receptionists
  for each row execute function public.studio_receptionists_front_desk_guard();

-- REACTIVATE through the owner command: a status instead of a raise.
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
  v_claim     text;
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

  -- 0390: a reactivation needs the Front Desk switch on and a free seat (a status, not a raise; the BEFORE trigger on
  -- studio_receptionists is the backstop for every other writer). The membership-kind lock is already held: the seat lock comes after it.
  if p_active then
    v_claim := public.front_desk_seat_claim(p_studio_id, v_row.id, null);
    if v_claim = 'front_desk_off' then
      return 'front_desk_off';
    elsif v_claim = 'seat_limit' then
      return 'seat_limit';
    end if;
  end if;

  update public.studio_receptionists
     set active = p_active,
         deactivated_at = case when p_active then null else now() end
   where id = v_row.id;
  return 'updated';
end;
$$;

-- ACCEPT: link_invited_membership, receptionist branch, returns a status and writes nothing when refused.
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
  v_claim text;
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

    -- 0390: the Front Desk switch must be on and a seat free. Nothing has been written, so a refusal leaves the invitation pending. The
    -- invitation's own reservation is released first (marked accepted), then the same one rule as everywhere else is applied, under the seat lock.
    v_claim := public.front_desk_seat_claim(p_invite.studio_id, v_desk_id, p_invite.id);
    if v_claim = 'front_desk_off' then
      return jsonb_build_object('status', 'front_desk_off', 'choose_studio', false);
    elsif v_claim = 'seat_limit' then
      return jsonb_build_object('status', 'seat_limit', 'choose_studio', false);
    end if;
    update public.pending_invitations
    set status = 'accepted', accepted_at = now()
    where id = p_invite.id;

    -- (FOUND now describes the UPDATE above, so the earlier lookup is tested through v_desk_id.)
    if v_desk_id is not null then
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

-- ---------------------------------------------------------------------------
-- 6. Admin commands (service_role only)
-- ---------------------------------------------------------------------------
create function public.admin_grant_front_desk_seats(
  p_studio_id     uuid,
  p_seats         integer,
  p_source        text,
  p_reason        text,
  p_expires_at    timestamptz,
  p_actor_user_id uuid,
  p_actor_email   text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id     uuid;
  v_before integer;
  v_after  integer;
  v_active integer;
begin
  perform public.platform_rollout_check_actor(p_actor_user_id, p_actor_email);
  if p_studio_id is null or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'front desk: unknown studio' using errcode = '23503';
  end if;
  if p_seats is null or p_seats not between 1 and 50 then
    raise exception 'front desk: seats must be between 1 and 50' using errcode = '23514';
  end if;
  if p_source is null or p_source not in ('plan_included', 'custom_agreed', 'pilot') then
    raise exception 'front desk: unknown source' using errcode = '23514';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'front desk: a reason of 1 to 500 characters is required' using errcode = '23514';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'front desk: the expiry must be in the future' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hone:front-desk-seats:' || p_studio_id::text, 0));
  v_before := public.front_desk_seat_limit(p_studio_id);
  insert into public.studio_front_desk_seats (studio_id, seats, source, reason, granted_by_admin, expires_at)
  values (p_studio_id, p_seats, p_source, btrim(p_reason), btrim(p_actor_email), p_expires_at)
  returning id into v_id;
  v_after := public.front_desk_seat_limit(p_studio_id);
  select count(*) into v_active from public.studio_receptionists sr where sr.studio_id = p_studio_id and sr.active;

  insert into public.admin_action_events (actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, source, metadata)
  values (p_actor_user_id, p_actor_email, 'admin', p_studio_id, 'front_desk_seats', v_id::text, 'front_desk_seats_granted', 'succeeded', 'admin',
          jsonb_build_object('studio_id', p_studio_id, 'seat_id', v_id, 'seats', p_seats, 'source', p_source,
                             'has_expiry', p_expires_at is not null, 'limit_before', v_before, 'limit_after', v_after,
                             'over_limit', greatest(0, v_active - v_after)));
  return v_id;
end;
$$;

create function public.admin_revoke_front_desk_seats(
  p_seat_id       uuid,
  p_reason        text,
  p_actor_user_id uuid,
  p_actor_email   text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_seat   public.studio_front_desk_seats%rowtype;
  v_before integer;
  v_after  integer;
  v_active integer;
begin
  perform public.platform_rollout_check_actor(p_actor_user_id, p_actor_email);
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'front desk: a reason of 1 to 500 characters is required' using errcode = '23514';
  end if;
  select * into v_seat from public.studio_front_desk_seats g where g.id = p_seat_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hone:front-desk-seats:' || v_seat.studio_id::text, 0));
  select * into v_seat from public.studio_front_desk_seats g where g.id = p_seat_id for update;
  if v_seat.revoked_at is not null then
    return jsonb_build_object('status', 'already_revoked');
  end if;
  v_before := public.front_desk_seat_limit(v_seat.studio_id);
  update public.studio_front_desk_seats
     set revoked_at = now(), revoked_by_admin = btrim(p_actor_email), revoke_reason = btrim(p_reason)
   where id = v_seat.id;
  v_after := public.front_desk_seat_limit(v_seat.studio_id);
  select count(*) into v_active from public.studio_receptionists sr where sr.studio_id = v_seat.studio_id and sr.active;

  insert into public.admin_action_events (actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, source, metadata)
  values (p_actor_user_id, p_actor_email, 'admin', v_seat.studio_id, 'front_desk_seats', v_seat.id::text, 'front_desk_seats_revoked', 'succeeded', 'admin',
          jsonb_build_object('studio_id', v_seat.studio_id, 'seat_id', v_seat.id, 'seats', v_seat.seats,
                             'limit_before', v_before, 'limit_after', v_after, 'over_limit', greatest(0, v_active - v_after)));
  return jsonb_build_object('status', 'revoked', 'seat_limit_after', v_after, 'seats_over_limit', greatest(0, v_active - v_after));
end;
$$;

create function public.admin_list_front_desk(p_studio_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit    integer := public.front_desk_seat_limit(p_studio_id);
  v_active   integer;
  v_reserved integer;
begin
  select count(*) into v_active from public.studio_receptionists sr where sr.studio_id = p_studio_id and sr.active;
  select count(*) into v_reserved from public.pending_invitations pi
   where pi.studio_id = p_studio_id and pi.role = 'receptionist' and pi.status = 'pending';
  return jsonb_build_object(
    'switch_on', public.platform_rollout_enabled_for('front_desk', p_studio_id),
    'seat_limit', v_limit,
    'seats_active', v_active,
    'seats_reserved', v_reserved,
    'seats_available', greatest(0, v_limit - v_active - v_reserved),
    'seats_over_limit', greatest(0, v_active - v_limit),
    'seats', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'seats', g.seats, 'source', g.source, 'reason', g.reason, 'granted_at', g.granted_at,
               'expires_at', g.expires_at, 'revoked_at', g.revoked_at,
               'state', case when g.revoked_at is not null then 'revoked'
                             when g.expires_at is not null and g.expires_at <= now() then 'expired'
                             else 'live' end)
             order by g.granted_at desc, g.id)
        from public.studio_front_desk_seats g where g.studio_id = p_studio_id), '[]'::jsonb));
end;
$$;

create function public.owner_front_desk_summary(p_studio_id uuid, p_owner_practitioner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit    integer;
  v_active   integer;
  v_reserved integer;
begin
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_owner_practitioner_id and pr.studio_id = p_studio_id and pr.active and pr.role = 'owner'
  ) then
    return jsonb_build_object('status', 'not_authorized');
  end if;
  v_limit := public.front_desk_seat_limit(p_studio_id);
  select count(*) into v_active from public.studio_receptionists sr where sr.studio_id = p_studio_id and sr.active;
  select count(*) into v_reserved from public.pending_invitations pi
   where pi.studio_id = p_studio_id and pi.role = 'receptionist' and pi.status = 'pending';
  return jsonb_build_object(
    'status', 'ok',
    'switch_on', public.platform_rollout_enabled_for('front_desk', p_studio_id),
    'seat_limit', v_limit,
    'seats_active', v_active,
    'seats_reserved', v_reserved,
    'seats_available', greatest(0, v_limit - v_active - v_reserved),
    'seats_over_limit', greatest(0, v_active - v_limit));
end;
$$;

revoke all privileges on function public.admin_grant_front_desk_seats(uuid, integer, text, text, timestamptz, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.admin_revoke_front_desk_seats(uuid, text, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.admin_list_front_desk(uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.owner_front_desk_summary(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_grant_front_desk_seats(uuid, integer, text, text, timestamptz, uuid, text) to service_role;
grant execute on function public.admin_revoke_front_desk_seats(uuid, text, uuid, text) to service_role;
grant execute on function public.admin_list_front_desk(uuid) to service_role;
grant execute on function public.owner_front_desk_summary(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Self-check: the end state is exactly what is claimed
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  if not exists (select 1 from public.platform_rollouts where key = 'front_desk' and mode = 'off')
     or exists (select 1 from public.platform_rollout_studios where rollout_key = 'front_desk')
     or exists (select 1 from public.studio_front_desk_seats) then
    raise exception '0390 self-check: the front_desk key must exist in mode off with no studio and no seat' using errcode = 'check_violation';
  end if;
  -- no role other than the intended one may execute any new function
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.front_desk_seat_limit(uuid)', 'execute')
       or has_function_privilege(r, 'public.front_desk_is_seated(uuid,uuid)', 'execute')
       or has_function_privilege(r, 'public.front_desk_seat_claim(uuid,uuid,uuid)', 'execute')
       or has_function_privilege(r, 'public.pending_invitations_front_desk_guard()', 'execute')
       or has_function_privilege(r, 'public.studio_receptionists_front_desk_guard()', 'execute')
       or has_function_privilege(r, 'public.studio_front_desk_seats_guard()', 'execute')
       or has_function_privilege(r, 'public.receptionist_actor_id(uuid)', 'execute') then
      raise exception '0390 self-check: role % can execute an internal function', r using errcode = 'check_violation';
    end if;
  end loop;
  if has_function_privilege('anon', 'public.front_desk_access()', 'execute')
     or has_function_privilege('service_role', 'public.front_desk_access()', 'execute')
     or not has_function_privilege('authenticated', 'public.front_desk_access()', 'execute') then
    raise exception '0390 self-check: front_desk_access must be authenticated only' using errcode = 'check_violation';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.admin_grant_front_desk_seats(uuid,integer,text,text,timestamptz,uuid,text)', 'execute')
       or has_function_privilege(r, 'public.admin_revoke_front_desk_seats(uuid,text,uuid,text)', 'execute')
       or has_function_privilege(r, 'public.admin_list_front_desk(uuid)', 'execute')
       or has_function_privilege(r, 'public.owner_front_desk_summary(uuid,uuid)', 'execute') then
      raise exception '0390 self-check: role % can execute an admin command', r using errcode = 'check_violation';
    end if;
  end loop;
  if has_table_privilege('anon', 'public.studio_front_desk_seats', 'select')
     or has_table_privilege('authenticated', 'public.studio_front_desk_seats', 'select')
     or has_table_privilege('service_role', 'public.studio_front_desk_seats', 'select') then
    raise exception '0390 self-check: the seats table must be closed to every role' using errcode = 'check_violation';
  end if;
end;
$$;

commit;
