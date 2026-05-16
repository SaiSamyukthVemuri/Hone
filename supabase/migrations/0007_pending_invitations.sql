-- Pending invitations + auto-attach on signup.
--
-- When an owner invites a teammate, a row lands in pending_invitations.
-- When that teammate signs up through Supabase auth (magic link or Google),
-- the handle_new_user() trigger looks up a matching pending invite by email:
--   match found    -> create practitioner in the inviting studio + mark invite accepted
--   no match       -> create a fresh studio (the legacy behavior; keeps self-signups working)

create table public.pending_invitations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade not null,
  email text not null,
  invited_by uuid references public.practitioners(id) on delete set null,
  role text default 'practitioner' check (role in ('owner', 'practitioner')),
  display_name text,
  status text default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

-- Only one *pending* invitation per email can exist at a time, across all studios.
-- Accepted or revoked rows don't count, so the same email can be re-invited later.
create unique index pending_invitations_email_pending_unique
  on public.pending_invitations (lower(email))
  where status = 'pending';

alter table public.pending_invitations enable row level security;

create policy "invitations_studio_member_read"
  on public.pending_invitations for select
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

create policy "invitations_owner_insert"
  on public.pending_invitations for insert
  with check (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true and role = 'owner'
    )
  );

create policy "invitations_owner_update"
  on public.pending_invitations for update
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true and role = 'owner'
    )
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_studio_id uuid;
  invitation record;
begin
  select * into invitation
  from public.pending_invitations
  where lower(email) = lower(new.email) and status = 'pending'
  limit 1;

  if found then
    insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
    values (
      invitation.studio_id, new.id,
      coalesce(invitation.display_name, new.email),
      new.email, invitation.role, true
    );

    update public.pending_invitations
    set status = 'accepted', accepted_at = now()
    where id = invitation.id;
  else
    insert into public.studios (name, legal_entity_name, owner_email)
    values ('My Studio', 'My Studio', new.email)
    returning id into new_studio_id;

    insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
    values (new_studio_id, new.id, new.email, new.email, 'owner', true);
  end if;

  return new;
end;
$$;

-- Trigger that calls the function on each new auth.users insert.
-- Idempotent: drop-if-exists first so the migration can be re-run safely.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
