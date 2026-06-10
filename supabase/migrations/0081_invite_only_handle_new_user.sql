-- 0081: Invite-only auth provisioning (PR #189, pilot safety).
--
-- handle_new_user()'s no-invite fallback (0007, re-affirmed by 0027)
-- created a brand-new studio + owner practitioner for ANY new auth
-- user. The magic-link path is now gated app-side (shouldCreateUser
-- only for invited emails), but Google OAuth cannot pass
-- shouldCreateUser, so an uninvited first OAuth login still created
-- an auth user and, through this fallback, a fresh studio. Hone is
-- invite-only during the pilot, so the fallback is removed at the
-- source: an uninvited new auth user may exist in auth.users, but
-- gets NO studio, NO practitioner row, and therefore no dashboard or
-- data access (every (app) surface resolves the practitioner row via
-- getCurrentPractitionerWithStudio and denies when it is absent).
--
-- The invited path is unchanged from 0027, including the terms /
-- privacy acceptance stamping. Studio creation for new pilots
-- happens deliberately via service role (docs/09), never via signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation record;
  acceptance_ts timestamptz := now();
  acceptance_version text := '2026-05-22';
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
      acceptance_ts, acceptance_version,
      acceptance_ts, acceptance_version
    );

    update public.pending_invitations
    set status = 'accepted', accepted_at = now()
    where id = invitation.id;
  end if;

  -- No invitation: invite-only during the pilot. Deliberately create
  -- NOTHING. The auth user exists but has no Hone studio,
  -- practitioner profile, or data access.
  return new;
end;
$$;
