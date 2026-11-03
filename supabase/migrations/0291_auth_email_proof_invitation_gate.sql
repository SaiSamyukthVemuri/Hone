-- 0291: database-level MAILBOX-PROOF gate for invitation linking.
--
-- DRAFT, HELD, PREPARE-ONLY. Never applied without Sam's per-change approval. Reservation: OPS, 0291.
-- Proposal and rationale: docs/proposals/0291-auth-email-proof-db-gate-HELD.md (Insurance S-3).
--
-- WHY. The app refuses invitation linking for a session that has not proven control of its email (lib/auth/email-proof.ts), but
-- reconcile_my_pending_invitation() and my_pending_invitation() are callable by any `authenticated` JWT over PostgREST and used
-- auth.users.email with no check of HOW the session was created. A password session on an auto-confirmed account could call them
-- directly. This migration makes both functions refuse such a session in the database.
--
-- WHAT. public.session_proves_mailbox() reads the verified JWT `amr` (PostgREST has already checked the signature):
--   * an `otp`, `magiclink` or `recovery` entry proves the mailbox. MEASURED on real GoTrue per flow: implicit links (invite, magic link,
--     signup-confirmation, recovery, email code) produce `otp`; the PKCE flow the browser uses produces `magiclink` for a magic link and
--     `recovery` for a recovery link; password sign-in AND password sign-up produce `password`. No other method counts.
--   * an `oauth` entry (GoTrue writes NO provider on it) counts only when the user has a Google identity whose email_verified is
--     true and whose email equals the account email (same rule as lib/auth/email-proof.ts).
-- An unproven caller gets {"status":"proof_required"}: no studio data is returned, nothing is written. A session with no amr (an
-- old or hand-minted token) is unproven. The two function bodies are 0141's, unchanged except for the gate that follows the
-- authentication check; signatures, security-definer and grants are unchanged (0141 step 7 is re-stated below).
--
-- NOT TOUCHED: admin_accept_pending_invitation(uuid) is service-role only and gated by its single server adapter.

begin;
set local lock_timeout = '5s';

create or replace function public.session_proves_mailbox()
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from jsonb_array_elements(
             case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
           ) as a
     where a ->> 'method' in ('otp', 'magiclink', 'recovery')
        or (a ->> 'method' = 'oauth'
            and exists (
              select 1
                from auth.identities i
                join auth.users u on u.id = i.user_id
               where i.user_id = auth.uid()
                 and i.provider = 'google'
                 and (i.identity_data ->> 'email_verified') = 'true'
                 and lower(i.identity_data ->> 'email') = lower(u.email)))
  );
$$;

comment on function public.session_proves_mailbox() is
  '0291: true when the verified JWT amr shows a one-time mailbox credential (otp, magiclink or recovery amr) or a verified-Google oauth session. Internal helper; no role may call it directly.';

revoke execute on function public.session_proves_mailbox() from public;
revoke execute on function public.session_proves_mailbox() from anon;
revoke execute on function public.session_proves_mailbox() from authenticated;
revoke execute on function public.session_proves_mailbox() from service_role;

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
  if not public.session_proves_mailbox() then
    return jsonb_build_object('status', 'proof_required');
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
  if not public.session_proves_mailbox() then
    return jsonb_build_object('status', 'proof_required', 'choose_studio', false);
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

-- 0141 step 7, re-stated (create or replace keeps grants; this makes the intended end state explicit).
revoke execute on function public.reconcile_my_pending_invitation() from public;
revoke execute on function public.reconcile_my_pending_invitation() from anon;
grant execute on function public.reconcile_my_pending_invitation() to authenticated;
revoke execute on function public.my_pending_invitation() from public;
revoke execute on function public.my_pending_invitation() from anon;
grant execute on function public.my_pending_invitation() to authenticated;

commit;
