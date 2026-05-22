-- Migration 0027: terms / privacy acceptance tracking on practitioners.
--
-- Adds four columns recording when each practitioner accepted the Terms
-- of Service and Privacy Policy, plus the version string (YYYY-MM-DD)
-- they accepted. Update the version string whenever the policy text
-- changes materially; that's how we know which version a user accepted.
--
-- Existing practitioners who signed up before the consent flow stay
-- NULL on these columns. A follow-up session can surface a banner
-- asking them to accept; this migration doesn't gate access.
--
-- Also updates handle_new_user() to stamp acceptance on insert, so any
-- practitioner created via the trigger (which only runs after the login
-- page's required consent checkbox is checked) gets a timestamped row.

alter table public.practitioners
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists privacy_accepted_at timestamptz,
  add column if not exists privacy_version text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_studio_id uuid;
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
  else
    insert into public.studios (name, legal_entity_name, owner_email)
    values ('My Studio', 'My Studio', new.email)
    returning id into new_studio_id;

    insert into public.practitioners (
      studio_id, user_id, display_name, email, role, active,
      terms_accepted_at, terms_version,
      privacy_accepted_at, privacy_version
    )
    values (
      new_studio_id, new.id, new.email, new.email, 'owner', true,
      acceptance_ts, acceptance_version,
      acceptance_ts, acceptance_version
    );
  end if;

  return new;
end;
$$;
