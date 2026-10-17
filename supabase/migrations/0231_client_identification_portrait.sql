-- 0231 · FETT photos (HON-43): a client identification portrait.
--
-- A practitioner marks ONE of a client's own CLIENT-SCOPED treatment photos as
-- that client's identification portrait. No new storage: the portrait is a
-- pointer to an existing treatment_images row, so it inherits every hardening
-- that row already has (private bucket, studio/client-bound path, Sharp
-- re-encode that strips EXIF/GPS, RLS, 60 s signed URLs).
--
-- Consent and retention: the portrait is governed by the EXISTING
-- treatment-photo consent and retention (soft-delete archive, no hard delete).
-- Whether an identification portrait needs its own wording or rule is queued
-- for the operator; nothing here changes either policy.
--
-- Integrity is enforced in the database, not the UI:
--   * the image must be the SAME client and studio, client-scoped (no session,
--     no treatment area) and not archived (BEFORE trigger on clients);
--   * an ARCHIVED photo can never be set, and every reader filters
--     deleted_at, so an archived portrait is never shown. Deliberately NO
--     trigger on treatment_images: its trigger set is pinned by the 0093/0168
--     and 0169 guards, and the read-side filter already makes it unreachable;
--   * the one write command resolves the actor per studio through
--     treatment_image_actor(studio) — an ACTIVE practitioner of that studio,
--     so a receptionist, a deactivated practitioner or another studio is
--     refused with the same non-disclosing message.

begin;

set local lock_timeout = '5s';

alter table public.clients
  add column if not exists portrait_image_id uuid
    references public.treatment_images (id) on delete set null;

comment on column public.clients.portrait_image_id is
  '0231. The client''s identification portrait: one of their own client-scoped, unarchived treatment photos. Set only through set_client_portrait(); integrity enforced by clients_portrait_integrity.';

-- ---------------------------------------------------------------------------
-- The portrait must be a current client photo of the same client.
-- SECURITY INVOKER on purpose: on a direct UPDATE by a signed-in user the
-- lookup runs under that user's RLS, so a photo they cannot see can never be
-- referenced. Through set_client_portrait() it runs as the command's owner,
-- after the command has already resolved the actor.
-- ---------------------------------------------------------------------------
create or replace function public.clients_portrait_integrity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.portrait_image_id is null then
    return new;
  end if;
  if not exists (
    select 1
      from public.treatment_images t
     where t.id = new.portrait_image_id
       and t.client_id = new.id
       and t.studio_id = new.studio_id
       and t.session_id is null
       and t.session_block_id is null
       and t.deleted_at is null
  ) then
    raise exception 'A portrait must be a current client photo of the same client.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists clients_portrait_integrity on public.clients;
create trigger clients_portrait_integrity
  before insert or update of portrait_image_id on public.clients
  for each row execute function public.clients_portrait_integrity();

-- ---------------------------------------------------------------------------
-- COMMAND — set (p_image_id) or clear (null) a client's portrait.
-- Non-disclosing: an unknown client and a client in a studio the caller is not
-- an active practitioner of raise the same message.
-- ---------------------------------------------------------------------------
create or replace function public.set_client_portrait(
  p_client_id uuid,
  p_image_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_pract  uuid;
begin
  select c.studio_id into v_studio
    from public.clients c
   where c.id = p_client_id;

  if v_studio is not null then
    select a.practitioner_id into v_pract
      from public.treatment_image_actor(v_studio) a;
  end if;

  if v_studio is null or v_pract is null then
    raise exception 'That client is not available.'
      using errcode = 'check_violation';
  end if;

  update public.clients c
     set portrait_image_id = p_image_id
   where c.id = p_client_id
     and c.studio_id = v_studio;

  return p_image_id;
end;
$$;

comment on function public.set_client_portrait(uuid, uuid) is
  '0231. Sets (or, with null, clears) a client''s identification portrait. Actor: an ACTIVE practitioner of the client''s studio (treatment_image_actor). Integrity: clients_portrait_integrity.';

-- ---------------------------------------------------------------------------
-- PRIVILEGES. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
-- authenticated AND service_role at create time: revoke all three by name,
-- plus PUBLIC, per signature (CLAUDE.md §5; clinical-rpc-grant-guard).
-- The command is then granted to authenticated only; the trigger functions are
-- never granted back.
-- ---------------------------------------------------------------------------
revoke execute on function public.set_client_portrait(uuid, uuid) from public;
revoke execute on function public.set_client_portrait(uuid, uuid) from anon;
revoke execute on function public.set_client_portrait(uuid, uuid) from authenticated;
revoke execute on function public.set_client_portrait(uuid, uuid) from service_role;
grant execute on function public.set_client_portrait(uuid, uuid) to authenticated;

revoke execute on function public.clients_portrait_integrity() from public;
revoke execute on function public.clients_portrait_integrity() from anon;
revoke execute on function public.clients_portrait_integrity() from authenticated;
revoke execute on function public.clients_portrait_integrity() from service_role;


commit;
