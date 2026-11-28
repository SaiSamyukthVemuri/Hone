-- Opt-in portal copy. No backfill, client/session changes, or default activation.
begin;
set local lock_timeout = '5s';

create table if not exists public.studio_portal_presentations (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  revision integer not null check (revision > 0),
  draft jsonb not null check (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 32768),
  published jsonb check (published is null or (jsonb_typeof(published) = 'object' and octet_length(published::text) <= 32768))
);
alter table public.studio_portal_presentations enable row level security;
revoke all on public.studio_portal_presentations from public, anon, authenticated, service_role;
grant select on public.studio_portal_presentations to authenticated;
-- The server rendering a client's portal cannot query any studio's unpublished draft.
grant select (studio_id, published) on public.studio_portal_presentations to service_role;
drop policy if exists "owners read their portal presentation" on public.studio_portal_presentations;
create policy "owners read their portal presentation" on public.studio_portal_presentations
  for select to authenticated using (public.is_studio_owner(studio_id));

-- Owned writes serialize at the row and check the revision displayed in the editor.
-- The first draft is insert-only; two first saves cannot overwrite one another.
-- Publish copies the saved draft in the database; classic removes only the published copy.
create or replace function public.edit_studio_portal_presentation(
  p_studio_id uuid, p_revision integer, p_operation text, p_draft jsonb default null
) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  next_revision integer;
begin
  -- Lock the active membership against concurrent demotion or retirement until the write commits.
  perform 1 from public.practitioners p
    where p.studio_id = p_studio_id and p.user_id = auth.uid() and p.role = 'owner' and p.active
    for share;
  if not found then raise exception 'Owner access required' using errcode = '42501'; end if;

  if p_operation is null or p_operation not in ('save', 'publish', 'classic')
     or p_revision is null or p_revision < 0 then
    raise exception 'Invalid portal change' using errcode = '22023';
  end if;
  if p_operation = 'save' then
    if p_draft is null or jsonb_typeof(p_draft) <> 'object' or octet_length(p_draft::text) > 32768
       or (jsonb_typeof(p_draft->'ownerName') = 'string' and length(p_draft->>'ownerName') <= 80) is not true
       or (jsonb_typeof(p_draft->'welcomeHeading') = 'string' and length(p_draft->>'welcomeHeading') <= 120 and length(btrim(p_draft->>'welcomeHeading')) > 0) is not true
       or (jsonb_typeof(p_draft->'welcomeMessage') = 'string' and length(p_draft->>'welcomeMessage') <= 600) is not true
       or jsonb_typeof(p_draft->'sections') is distinct from 'array' then
      raise exception 'Invalid portal copy' using errcode = '22023';
    end if;
    if jsonb_array_length(p_draft->'sections') <> 6
       or (select count(distinct s->>'id') from jsonb_array_elements(p_draft->'sections') s) <> 6
       or exists (select 1 from jsonb_array_elements(p_draft->'sections') s where
         (s->>'id' in ('appointments','tasks','booking','care','records','payment') and
          jsonb_typeof(s->'visible') = 'boolean' and jsonb_typeof(s->'title') = 'string' and
          length(s->>'title') <= 120 and length(btrim(s->>'title')) > 0 and jsonb_typeof(s->'description') = 'string'
          and length(s->>'description') <= 600) is not true) then
      raise exception 'Invalid portal sections' using errcode = '22023';
    end if;
  elsif p_draft is not null then
    raise exception 'Unexpected draft' using errcode = '22023';
  end if;

  if p_revision = 0 and p_operation = 'save' then
    insert into public.studio_portal_presentations(studio_id, revision, draft)
      values (p_studio_id, 1, p_draft) on conflict (studio_id) do nothing
      returning revision into next_revision;
  else
    update public.studio_portal_presentations
       set draft = case when p_operation = 'save' then p_draft else draft end,
           published = case p_operation when 'publish' then draft when 'classic' then null else published end,
           revision = revision + 1
     where studio_id = p_studio_id and revision = p_revision
     returning revision into next_revision;
  end if;
  if next_revision is null then
    raise exception 'The portal settings have changed' using errcode = '40001';
  end if;
  return next_revision;
end;
$$;
revoke all on function public.edit_studio_portal_presentation(uuid,integer,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.edit_studio_portal_presentation(uuid,integer,text,jsonb) to authenticated;
commit;
