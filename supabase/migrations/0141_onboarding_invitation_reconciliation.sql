-- ===========================================================================
-- 0141 — Existing-user invitation reconciliation (onboarding v2, Part 7)
-- ===========================================================================
--
-- Defect this closes: handle_new_user() (0081) only provisions the owner/member
-- practitioner row when a NEW auth.users row is inserted. An email that ALREADY
-- has a Hone account, invited to a NEW studio, signs in without inserting a new
-- auth.users row -> the trigger never fires -> the pending invitation stays
-- 'pending' and no membership is created -> the user lands on /no-access (0
-- memberships) or their existing studio, never joining the new one.
--
-- Fix: two AUTHENTICATED, SELF-SCOPED SECURITY DEFINER operations that the app
-- calls with the caller's own session. Identity is derived INTERNALLY from
-- auth.uid() + the verified auth.users email; the caller supplies NOTHING
-- (no user_id / email / studio_id / practitioner_id / role / display name /
-- timestamps / versions). There is deliberately NO generic operator cross-user
-- reconciliation RPC.
--
--   * reconcile_my_pending_invitation() — automatic path. Links the membership
--     ONLY when the user already has VALID, CURRENT-version terms+privacy
--     acceptance evidence to copy (never fabricates now()); otherwise returns
--     'acceptance_required' and leaves the invitation pending.
--   * accept_my_pending_invitation() — explicit path (called by /accept-invitation
--     after the user confirms the current policies). Stamps acceptance with the
--     ACTUAL server transaction time + the current reviewed policy versions.
--   * my_pending_invitation() — self-scoped READ for the acceptance page
--     (studio name + role only; RLS otherwise hides pending_invitations from a
--     not-yet-member).
--
-- Also centralizes the current policy versions (current_terms_version() /
-- current_privacy_version()) as the single source of truth and updates
-- handle_new_user() to use them (it previously hardcoded '2026-05-22').
--
-- ADDITIVE. No table/column changes. No data backfill. Install as ONE
-- transaction. Repo max was 0140 (studio onboarding); this is 0141. 0135-0139
-- are the PR-B branch; 0142 is the internal-booking branch (renumbered from
-- 0141 to yield this number). Supabase applies in filename order.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Step 1: single source of truth for the current policy versions. IMMUTABLE
-- constants so both the sign-up trigger and the reconciliation RPCs stamp the
-- SAME version, and a future bump happens in exactly one place.
-- ---------------------------------------------------------------------------
create or replace function public.current_terms_version()
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select '2026-05-22'::text $$;

create or replace function public.current_privacy_version()
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select '2026-05-22'::text $$;

-- ---------------------------------------------------------------------------
-- Step 2: handle_new_user() uses the centralized version source. Behaviour is
-- otherwise byte-for-byte 0081 (invite-only; NOTHING created without a pending
-- invite; terms/privacy stamped at first invited sign-in).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation record;
  acceptance_ts timestamptz := now();
begin
  select * into invitation
  from public.pending_invitations
  where lower(email) = lower(new.email) and status = 'pending'
  limit 1;

  if found then
    insert into public.practitioners (
      studio_id, user_id, display_name, email, role, active,
      terms_accepted_at, terms_version,
      privacy_accepted_at, privacy_version
    )
    values (
      invitation.studio_id, new.id,
      coalesce(invitation.display_name, new.email),
      new.email, invitation.role, true,
      acceptance_ts, public.current_terms_version(),
      acceptance_ts, public.current_privacy_version()
    );

    update public.pending_invitations
    set status = 'accepted', accepted_at = now()
    where id = invitation.id;
  end if;

  -- No invitation: invite-only. Deliberately create NOTHING.
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 3: self-scoped READ for the acceptance page. Returns ONLY the studio
-- name + invited role for the caller's single pending invite (safe, self-scoped
-- info). status: 'ok' | 'no_invitation' | 'ambiguous'.
-- ---------------------------------------------------------------------------
create or replace function public.my_pending_invitation()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count int;
  v_invite public.pending_invitations%rowtype;
  v_studio public.studios%rowtype;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    return jsonb_build_object('status', 'no_invitation');
  end if;

  select count(*) into v_count
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending';
  if v_count = 0 then
    return jsonb_build_object('status', 'no_invitation');
  elsif v_count > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  select * into v_invite
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending';
  select * into v_studio from public.studios where id = v_invite.studio_id;
  if not found then
    return jsonb_build_object('status', 'no_invitation');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'studio_name', v_studio.name,
    'role', v_invite.role
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: shared internal linker. Creates the membership + accepts the invite
-- inside the caller's transaction, using the acceptance evidence handed to it
-- (either copied current-version evidence, or fresh now()+current versions).
-- Returns the post-link result jsonb. Assumes the per-email advisory lock is
-- already held and the (single, pending) invite row is locked.
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
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_membership_count int;
begin
  insert into public.practitioners
    (studio_id, user_id, display_name, email, role, active,
     terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
  values
    (p_invite.studio_id, p_uid, coalesce(p_invite.display_name, p_email),
     p_email, p_invite.role, true,
     p_terms_accepted_at, p_terms_version, p_privacy_accepted_at, p_privacy_version);

  -- Accept the invite AFTER the practitioner insert. accepted_at is the
  -- CONSUMPTION time, distinct from the legal terms_accepted_at above.
  update public.pending_invitations
  set status = 'accepted', accepted_at = now()
  where id = p_invite.id;

  -- Initialize onboarding state idempotently (harmless while the flag is off).
  insert into public.studio_onboarding (studio_id)
  values (p_invite.studio_id)
  on conflict (studio_id) do nothing;

  select count(*) into v_membership_count
  from public.practitioners where user_id = p_uid and active;

  return jsonb_build_object(
    'status', 'linked',
    'choose_studio', v_membership_count > 1,
    'studio_name', p_studio_name,
    'role', p_invite.role
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 5: automatic reconciliation (no consent screen) — ONLY when valid
-- current-version evidence exists to copy.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_my_pending_invitation()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count int;
  v_invite public.pending_invitations%rowtype;
  v_studio public.studios%rowtype;
  v_existing public.practitioners%rowtype;
  v_ev public.practitioners%rowtype;
  v_membership_count int;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'no verified email for caller' using errcode = '28000';
  end if;

  -- Serialize all reconcile/accept calls for this email (concurrency safety).
  perform pg_advisory_xact_lock(hashtext('hone:invite:' || lower(v_email))::bigint);

  select count(*) into v_count
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending';
  if v_count = 0 then
    return jsonb_build_object('status', 'no_invitation', 'choose_studio', false);
  elsif v_count > 1 then
    return jsonb_build_object('status', 'ambiguous', 'choose_studio', false);
  end if;

  -- The single pending invite, row-locked.
  select * into v_invite
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending'
  for update;

  select * into v_studio from public.studios where id = v_invite.studio_id;
  if not found then
    return jsonb_build_object('status', 'no_invitation', 'choose_studio', false);
  end if;

  -- Existing membership for the target studio? Prefer the caller's own row.
  select * into v_existing
  from public.practitioners
  where studio_id = v_invite.studio_id and lower(email) = lower(v_email)
  order by (user_id = v_uid) desc
  limit 1;

  if found then
    if v_existing.user_id is distinct from v_uid then
      -- Belongs to ANOTHER user — never overwrite user_id.
      return jsonb_build_object('status', 'conflict', 'choose_studio', false);
    end if;
    if v_existing.active then
      -- Same user, already an active member: accept the still-pending invite
      -- (idempotent), touch nothing else.
      update public.pending_invitations
      set status = 'accepted', accepted_at = now()
      where id = v_invite.id;
      select count(*) into v_membership_count
      from public.practitioners where user_id = v_uid and active;
      return jsonb_build_object(
        'status', 'already_linked',
        'choose_studio', v_membership_count > 1,
        'studio_name', v_studio.name, 'role', v_existing.role);
    end if;
    -- Same user but an inactive/unresolved membership — route to explicit accept.
    return jsonb_build_object(
      'status', 'acceptance_required', 'choose_studio', false,
      'studio_name', v_studio.name, 'role', v_invite.role);
  end if;

  -- No membership yet. Find a SINGLE existing practitioner row for THIS user
  -- with BOTH current-version terms AND privacy accepted (never split across
  -- rows, never stale, never null).
  select * into v_ev
  from public.practitioners
  where user_id = v_uid
    and terms_accepted_at is not null
    and terms_version = public.current_terms_version()
    and privacy_accepted_at is not null
    and privacy_version = public.current_privacy_version()
  order by terms_accepted_at desc, id
  limit 1;

  if not found then
    -- No reusable evidence -> explicit acceptance required. Insert NOTHING;
    -- leave the invite pending/recoverable.
    return jsonb_build_object(
      'status', 'acceptance_required', 'choose_studio', false,
      'studio_name', v_studio.name, 'role', v_invite.role);
  end if;

  -- Copy the EXACT four values from that one row (no now()).
  return public.link_invited_membership(
    v_uid, v_email, v_invite, v_studio.name,
    v_ev.terms_accepted_at, v_ev.terms_version,
    v_ev.privacy_accepted_at, v_ev.privacy_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 6: explicit acceptance — the user has just confirmed the CURRENT terms +
-- privacy on /accept-invitation. Stamps acceptance with the ACTUAL transaction
-- time + the current reviewed versions.
-- ---------------------------------------------------------------------------
create or replace function public.accept_my_pending_invitation()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count int;
  v_invite public.pending_invitations%rowtype;
  v_studio public.studios%rowtype;
  v_existing public.practitioners%rowtype;
  v_now timestamptz := now();
  v_membership_count int;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'no verified email for caller' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtext('hone:invite:' || lower(v_email))::bigint);

  select count(*) into v_count
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending';
  if v_count = 0 then
    return jsonb_build_object('status', 'no_invitation', 'choose_studio', false);
  elsif v_count > 1 then
    return jsonb_build_object('status', 'ambiguous', 'choose_studio', false);
  end if;

  select * into v_invite
  from public.pending_invitations
  where lower(email) = lower(v_email) and status = 'pending'
  for update;

  select * into v_studio from public.studios where id = v_invite.studio_id;
  if not found then
    return jsonb_build_object('status', 'no_invitation', 'choose_studio', false);
  end if;

  -- Conflicting / existing membership guard (never overwrite another user).
  select * into v_existing
  from public.practitioners
  where studio_id = v_invite.studio_id and lower(email) = lower(v_email)
  order by (user_id = v_uid) desc
  limit 1;
  if found then
    if v_existing.user_id is distinct from v_uid then
      return jsonb_build_object('status', 'conflict', 'choose_studio', false);
    end if;
    if v_existing.active then
      update public.pending_invitations
      set status = 'accepted', accepted_at = now()
      where id = v_invite.id;
      select count(*) into v_membership_count
      from public.practitioners where user_id = v_uid and active;
      return jsonb_build_object(
        'status', 'already_linked',
        'choose_studio', v_membership_count > 1,
        'studio_name', v_studio.name, 'role', v_existing.role);
    end if;
  end if;

  -- Fresh, genuine acceptance: now() + current versions.
  return public.link_invited_membership(
    v_uid, v_email, v_invite, v_studio.name,
    v_now, public.current_terms_version(),
    v_now, public.current_privacy_version());
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 7: authorization. The self-service RPCs are for the AUTHENTICATED role
-- only. The internal helpers (linker + version constants) are execute-locked
-- from every browser role (they run only inside the SECURITY DEFINER RPCs /
-- the trigger, which execute as the owner).
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  -- Self-service: revoke from public+anon, grant to authenticated.
  foreach fn in array array[
    'public.reconcile_my_pending_invitation()',
    'public.accept_my_pending_invitation()',
    'public.my_pending_invitation()'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  -- Internal-only: no browser role may call these directly.
  foreach fn in array array[
    'public.current_terms_version()',
    'public.current_privacy_version()',
    'public.link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;
end $$;

commit;
