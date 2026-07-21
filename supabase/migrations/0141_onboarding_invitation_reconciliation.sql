-- ===========================================================================
-- 0141 — Existing-user invitation reconciliation + one authoritative consent
-- ===========================================================================
--
-- Provisioning + LEGAL ACCEPTANCE for invited users (new AND existing Auth
-- accounts) move to sign-in time, with EXACTLY ONE authoritative acceptance
-- event. Nothing fabricates consent; nothing activates a membership merely
-- because an Auth user was created.
--
--   * handle_new_user()  — NO-OP. It no longer creates a membership or stamps
--     terms/privacy from Auth-user creation (that fabricated consent and made
--     the login/OAuth flows an implicit acceptance). Invite-only is still
--     enforced because the reconciliation RPCs only ever act on a PENDING
--     invitation for the verified Auth email.
--   * reconcile_my_pending_invitation()  — AUTHENTICATED, self-scoped. Called at
--     /auth/callback for every sign-in (magic-link OR Google OAuth, both route
--     here). Auto-links a membership ONLY by COPYING a single existing
--     current-version terms+privacy row (reused genuine consent, never now()).
--     No reusable evidence, or a same-user INACTIVE target row -> returns
--     acceptance_required (route to explicit acceptance). Never stamps fresh
--     acceptance.
--   * admin_accept_pending_invitation(p_user_id)  — SERVICE-ROLE ONLY. The one
--     authoritative acceptance command. Reachable only from the trusted
--     /accept-invitation server adapter (which validated the current-policy
--     checkbox and resolved the user from the session). Derives the verified
--     email + current versions INTERNALLY; the browser cannot call it and
--     supplies no email/studio/role/timestamps/versions. Stamps the ACTUAL
--     transaction time + current versions, and reactivates a same-user INACTIVE
--     target row in place (UPDATE, never a second INSERT).
--   * my_pending_invitation()  — self-scoped read for the acceptance page.
--
-- Policy versions are centralized (current_terms_version / current_privacy_
-- version). ADDITIVE (no table/column changes). Install as ONE transaction.
--
-- DEPLOYMENT ORDER — APP-FIRST, MIGRATION-SECOND. The reconciliation-capable app
-- (/auth/callback reconcile + /accept-invitation) MUST be live before this
-- migration makes handle_new_user a no-op. Migration-first (no-op trigger + old
-- app with no reconciliation) would land a new invited user on /no-access with
-- the invite still PENDING — safe (no data loss, fully recoverable on the next
-- sign-in once the app is live) but operationally forbidden. See
-- docs/24_ONBOARDING_V2.md. Repo max 0140 -> 0141; 0142+ = capacity Part 4.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Step 1: single source of truth for the current policy versions.
-- ---------------------------------------------------------------------------
create or replace function public.current_terms_version()
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select '2026-05-22'::text $$;

create or replace function public.current_privacy_version()
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select '2026-05-22'::text $$;

-- ---------------------------------------------------------------------------
-- Step 2: handle_new_user() is a NO-OP. Provisioning + consent happen at
-- sign-in via the reconciliation RPCs (both magic-link and OAuth route through
-- /auth/callback). Creating a membership / stamping acceptance here would
-- fabricate consent and activate a membership from Auth-user creation alone.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Intentionally does nothing. Invite-only is enforced by the reconciliation
  -- RPCs, which only act on a PENDING invitation for the verified Auth email;
  -- an uninvited Auth user (magic-link or OAuth) gets no membership and no
  -- fabricated acceptance.
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 3: self-scoped READ for the acceptance page.
-- ---------------------------------------------------------------------------
create or replace function public.my_pending_invitation()
returns jsonb
language plpgsql stable security definer
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
    'status', 'ok', 'studio_name', v_studio.name, 'role', v_invite.role);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: atomic linker. Creates the membership, OR reactivates the caller's
-- own INACTIVE target row in place (UPDATE, never a second INSERT that would
-- trip unique(studio_id,user_id)). Accepts the invitation AFTER the write, and
-- initializes onboarding state. Runs inside the caller's txn (assumes the
-- per-email advisory lock + FOR UPDATE on the invite are already held).
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
begin
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
-- Step 5: automatic reconciliation (AUTHENTICATED, self-scoped, called at
-- /auth/callback). Auto-links ONLY by copying a single current-version
-- evidence row. Never stamps fresh acceptance. A same-user INACTIVE target row
-- routes to explicit acceptance.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_my_pending_invitation()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count int;
  v_invite public.pending_invitations%rowtype;
  v_studio public.studios%rowtype;
  v_same public.practitioners%rowtype;
  v_conflict public.practitioners%rowtype;
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

  -- Target-state resolution: (1) same-user row, (2) conflicting another-user row.
  select * into v_same
  from public.practitioners
  where studio_id = v_invite.studio_id and user_id = v_uid
  limit 1;
  if found then
    if v_same.active then
      -- Already an active member: accept the still-pending invite (idempotent).
      update public.pending_invitations
      set status = 'accepted', accepted_at = now() where id = v_invite.id;
      select count(*) into v_membership_count
      from public.practitioners where user_id = v_uid and active;
      return jsonb_build_object('status', 'already_linked',
        'choose_studio', v_membership_count > 1,
        'studio_name', v_studio.name, 'role', v_same.role);
    end if;
    -- Same-user INACTIVE target row -> reactivation needs explicit consent.
    -- (The safe-conflict guard against an ACTIVE another-user row is re-checked
    -- there, in admin_accept_pending_invitation, at the moment of reactivation.)
    return jsonb_build_object('status', 'acceptance_required', 'choose_studio', false,
      'studio_name', v_studio.name, 'role', v_invite.role);
  end if;

  -- Safe-conflict guard: a DIFFERENT user already holds an ACTIVE row under the
  -- invited email in this studio. Auto-linking would create a second active
  -- practitioner sharing one login email — refuse; operator cleanup required.
  select * into v_conflict
  from public.practitioners
  where studio_id = v_invite.studio_id
    and lower(email) = lower(v_email)
    and user_id is distinct from v_uid
    and active
  limit 1;
  if found then
    return jsonb_build_object('status', 'conflict', 'choose_studio', false);
  end if;

  -- No target membership. Reusable evidence = a SINGLE existing row for THIS
  -- user with BOTH current-version terms AND privacy accepted.
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
    return jsonb_build_object('status', 'acceptance_required', 'choose_studio', false,
      'studio_name', v_studio.name, 'role', v_invite.role);
  end if;

  -- Copy the four exact values (never now()).
  return public.link_invited_membership(
    v_uid, v_email, v_invite, v_studio.name,
    v_ev.terms_accepted_at, v_ev.terms_version,
    v_ev.privacy_accepted_at, v_ev.privacy_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 6: THE authoritative acceptance command. SERVICE-ROLE ONLY — the browser
-- cannot call it. Reachable only from the trusted /accept-invitation server
-- adapter, which validated the current-policy checkbox and resolved p_user_id
-- from the session. Derives the verified email + current versions internally;
-- accepts no email/studio/role/timestamps/versions from the caller.
-- ---------------------------------------------------------------------------
create or replace function public.admin_accept_pending_invitation(p_user_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_email text;
  v_count int;
  v_invite public.pending_invitations%rowtype;
  v_studio public.studios%rowtype;
  v_same public.practitioners%rowtype;
  v_conflict public.practitioners%rowtype;
  v_now timestamptz := now();
  v_membership_count int;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = '22004';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'no verified email for user' using errcode = '28000';
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

  -- Resolution: (1) same-user row already active -> already_linked; (2) an
  -- ACTIVE another-user row under the invited email -> safe conflict; (3) same-
  -- user inactive row -> reactivate in place; (4) none -> insert.
  select * into v_same
  from public.practitioners
  where studio_id = v_invite.studio_id and user_id = p_user_id
  limit 1;
  if found and v_same.active then
    update public.pending_invitations
    set status = 'accepted', accepted_at = now() where id = v_invite.id;
    select count(*) into v_membership_count
    from public.practitioners where user_id = p_user_id and active;
    return jsonb_build_object('status', 'already_linked',
      'choose_studio', v_membership_count > 1,
      'studio_name', v_studio.name, 'role', v_same.role);
  end if;

  -- Safe-conflict guard (runs whether or not the caller has an inactive same-user
  -- row): if a DIFFERENT user already holds an ACTIVE practitioner row under the
  -- invited email in this studio, accepting would put TWO active practitioners on
  -- one login email. That is not a supported product state — refuse and require
  -- operator cleanup rather than silently reactivating/inserting a second row.
  select * into v_conflict
  from public.practitioners
  where studio_id = v_invite.studio_id
    and lower(email) = lower(v_email)
    and user_id is distinct from p_user_id
    and active
  limit 1;
  if found then
    return jsonb_build_object('status', 'conflict', 'choose_studio', false);
  end if;

  -- Fresh, genuine acceptance: actual txn time + current versions. The linker
  -- reactivates the same-user inactive row in place, or inserts a new one.
  return public.link_invited_membership(
    p_user_id, v_email, v_invite, v_studio.name,
    v_now, public.current_terms_version(),
    v_now, public.current_privacy_version());
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 6b: welcome-email attempt CLAIM. Atomically flips status -> 'sending',
-- mints a FRESH attempt_id, and stamps last_attempted_at — but ONLY if no
-- attempt is already in progress (status 'sending' within the last 30s, i.e. a
-- live concurrent attempt). Returns the winning attempt_id, or NULL to a caller
-- that lost the race ('already in progress'). Concurrent claims serialize on the
-- row lock, so exactly one caller wins. Service-role only.
-- ---------------------------------------------------------------------------
create or replace function public.claim_welcome_email_attempt(p_studio_id uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_attempt uuid;
begin
  insert into public.studio_onboarding
    (studio_id, welcome_email_status, welcome_email_attempt_id, welcome_email_last_attempted_at)
  values (p_studio_id, 'sending', gen_random_uuid(), now())
  on conflict (studio_id) do update
    set welcome_email_status = 'sending',
        welcome_email_attempt_id = gen_random_uuid(),
        welcome_email_last_attempted_at = now()
    where studio_onboarding.welcome_email_status <> 'sending'
       or studio_onboarding.welcome_email_last_attempted_at is null
       or studio_onboarding.welcome_email_last_attempted_at < now() - interval '30 seconds'
  returning welcome_email_attempt_id into v_attempt;
  return v_attempt; -- NULL when a live attempt is already in progress
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 6c: welcome-email RESULT stamp (compare-and-set on attempt_id). Only the
-- caller whose attempt_id is still current may write the final status, so a
-- stale/slow attempt can never overwrite a newer retry's result. Returns whether
-- the result was applied. last_sent_at is set ONLY on a genuine 'sent'.
-- Service-role only.
-- ---------------------------------------------------------------------------
create or replace function public.record_welcome_email_result(
  p_studio_id uuid,
  p_attempt_id uuid,
  p_status text
)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_updated boolean;
begin
  if p_status not in ('not_sent', 'sent', 'failed') then
    raise exception 'invalid welcome_email result status: %', p_status
      using errcode = '22023';
  end if;
  update public.studio_onboarding set
    welcome_email_status = p_status,
    welcome_email_last_sent_at = case
      when p_status = 'sent' then now()
      else welcome_email_last_sent_at end
  where studio_id = p_studio_id
    and welcome_email_attempt_id = p_attempt_id  -- CAS: only the current attempt
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 7: authorization.
--   * reconcile / my_pending_invitation  -> authenticated (self-scoped).
--   * admin_accept_pending_invitation    -> service_role ONLY (no browser role).
--   * internal helpers + version fns + handle_new_user -> no browser execute.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.reconcile_my_pending_invitation()',
    'public.my_pending_invitation()'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  -- The authoritative acceptance command + the welcome-email claim: service-role
  -- only (the trusted server adapters). Browser roles CANNOT call them.
  foreach fn in array array[
    'public.admin_accept_pending_invitation(uuid)',
    'public.claim_welcome_email_attempt(uuid)',
    'public.record_welcome_email_result(uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;

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
