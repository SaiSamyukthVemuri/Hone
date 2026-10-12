-- 0218 — STUDIO-READY-02b (#824): an owner can invite a receptionist.
--
-- Stacked on 0216 (studio_receptionists). Three changes, all additive or
-- widening:
--
--   1. studio_receptionists gains the four platform-agreement evidence columns
--      that a practitioner's membership already carries, so accepting an
--      invitation records the same terms/privacy acceptance for a receptionist.
--   2. pending_invitations.role admits 'receptionist'.
--   2b. At most ONE ACTIVE front-desk membership per studio and email, enforced
--      by a partial unique index, so EVERY activation writer holds it:
--      invitation acceptance, add_studio_receptionist and
--      set_studio_receptionist_active (Codex P2 4244037190 on #850).
--   3. link_invited_membership, the ONE function that turns an accepted
--      invitation into a membership (0141), gains a receptionist branch. A
--      receptionist invitation creates or reactivates a studio_receptionists
--      row, and NEVER a practitioners row. Its practitioner path is
--      byte-identical to 0141.
--
-- The two callers, reconcile_my_pending_invitation and
-- admin_accept_pending_invitation (0141), are deliberately NOT re-emitted.
-- Their checks read the same for a receptionist invitation:
--   * a receptionist-only user holds no practitioners evidence row, so
--     reconcile always routes them to explicit acceptance, and
--     admin_accept_pending_invitation stamps FRESH acceptance (now(), current
--     versions);
--   * an ACTIVE practitioner of the target studio is answered 'already_linked'
--     and stays a practitioner. A role change is a separate owner command,
--     never a side effect of an invitation;
--   * the different-user conflict guard still applies.
--
-- No row is written at top level. Every existing invitation stays valid,
-- because the role CHECK only widens.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Agreement evidence on the receptionist membership.
-- ---------------------------------------------------------------------------
alter table public.studio_receptionists
  add column if not exists terms_accepted_at   timestamptz,
  add column if not exists terms_version       text,
  add column if not exists privacy_accepted_at timestamptz,
  add column if not exists privacy_version     text;

-- ---------------------------------------------------------------------------
-- 2) The invitation role.
-- ---------------------------------------------------------------------------
alter table public.pending_invitations
  drop constraint if exists pending_invitations_role_check;
alter table public.pending_invitations
  add constraint pending_invitations_role_check
  check (role in ('owner', 'practitioner', 'receptionist'));

-- ---------------------------------------------------------------------------
-- 2b) One ACTIVE front-desk membership per studio and email.
--     The linker's 'conflict' pre-check below gives acceptance a clean answer.
--     This index is what makes the rule hold for every OTHER writer, too:
--     reactivating an old row under an address another user now holds is
--     refused 23505. Inactive rows are history and stay unconstrained.
--     studio_receptionists arrives in 0216 in this same release, so no
--     existing row can violate it.
-- ---------------------------------------------------------------------------
create unique index if not exists studio_receptionists_active_email_uniq
  on public.studio_receptionists (studio_id, lower(email))
  where active and email is not null;

-- ---------------------------------------------------------------------------
-- 3) The linker. Signature unchanged, so create or replace swaps the body in
--    place. The receptionist branch runs first and returns; everything after
--    it is the 0141 body, byte-identical.
-- ---------------------------------------------------------------------------
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

-- Privileges restated, not assumed: service_role only, as before.
revoke execute on function public.link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text) from public;
revoke execute on function public.link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text) from anon;
revoke execute on function public.link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text) from authenticated;
grant execute on function public.link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text) to service_role;

commit;
