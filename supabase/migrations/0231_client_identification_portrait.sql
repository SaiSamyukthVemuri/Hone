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
--   * archiving the portrait photo clears the pointer ATOMICALLY, inside
--     archive_treatment_image itself (redefined here, same body plus one
--     scoped UPDATE), so the column never points at an archived photo
--     (Codex P2 4302494067). Deliberately NO trigger on treatment_images: its
--     trigger set is pinned by the 0093/0168 and 0169 guards;
--   * the integrity check takes FOR SHARE on the photo row, so a concurrent
--     archive waits for the setting transaction and then clears the pointer;
--   * the one write command resolves the actor per studio through
--     treatment_image_actor(studio) — an ACTIVE practitioner of that studio,
--     so a receptionist, a deactivated practitioner or another studio is
--     refused with the same non-disclosing message.

begin;

set local lock_timeout = '5s';

alter table public.clients
  add column if not exists portrait_image_id uuid
    references public.treatment_images (id) on delete set null;

-- The archive path looks clients up by this pointer.
create index if not exists clients_portrait_image_id_idx
  on public.clients (portrait_image_id)
  where portrait_image_id is not null;

comment on column public.clients.portrait_image_id is
  '0231. The client''s identification portrait: one of their own client-scoped, unarchived treatment photos. Set only through set_client_portrait(); integrity enforced by clients_portrait_integrity.';

-- ---------------------------------------------------------------------------
-- The portrait must be a current client photo of the same client.
-- SECURITY INVOKER on purpose: on a direct UPDATE by a signed-in user the
-- lookup runs under that user's RLS, so a photo they cannot see can never be
-- referenced. Through set_client_portrait() it runs as the command's owner,
-- after the command has already resolved the actor.
-- It also fires on a studio_id change (Codex P2 4301792066): moving a client
-- WITH a portrait to another studio is refused, because the photo stays in the
-- old studio. A client with no portrait moves freely (early return below).
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
  -- FOR SHARE: a concurrent archive of this photo waits until this
  -- transaction ends, then archive_treatment_image clears the pointer.
  perform 1
    from public.treatment_images t
   where t.id = new.portrait_image_id
     and t.client_id = new.id
     and t.studio_id = new.studio_id
     and t.session_id is null
     and t.session_block_id is null
     and t.deleted_at is null
     for share;
  if not found then
    raise exception 'A portrait must be a current client photo of the same client.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists clients_portrait_integrity on public.clients;
create trigger clients_portrait_integrity
  before insert or update of portrait_image_id, studio_id on public.clients
  for each row execute function public.clients_portrait_integrity();

-- ---------------------------------------------------------------------------
-- archive_treatment_image, redefined: 0178's body, unchanged, plus ONE scoped
-- UPDATE that clears the client's portrait when the archived photo is it.
-- Same signature, SECURITY DEFINER, empty search_path, no DELETE, no storage
-- (the 0168 guards), and its grants are restated below by name.
-- ---------------------------------------------------------------------------
create or replace function public.archive_treatment_image(
  p_image_id  uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_pract  uuid;
  v_id     uuid;
begin
  select t.studio_id into v_studio
    from public.treatment_images t
   where t.id = p_image_id
     and t.client_id = p_client_id
     and t.deleted_at is null;
  if v_studio is null then
    return null;
  end if;

  select a.practitioner_id into v_pract
    from public.treatment_image_actor(v_studio) a;
  if v_pract is null then
    return null;
  end if;

  update public.treatment_images t
     set deleted_at = now(),
         deleted_by = v_pract
   where t.id = p_image_id
     and t.studio_id = v_studio
     and t.client_id = p_client_id
     and t.deleted_at is null
  returning t.id into v_id;

  -- 0231: an archived photo is never a client's portrait.
  if v_id is not null then
    update public.clients c
       set portrait_image_id = null
     where c.id = p_client_id
       and c.studio_id = v_studio
       and c.portrait_image_id = v_id;
  end if;

  return v_id;
end;
$$;

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
  v_id     uuid;
begin
  -- FOR UPDATE (Codex P2 4302682030): the studio the actor is authorized
  -- against cannot change under us. A concurrent move waits for this
  -- transaction, or this waits for it and then authorizes the NEW studio.
  select c.studio_id into v_studio
    from public.clients c
   where c.id = p_client_id
     for update;

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
     and c.studio_id = v_studio
  returning c.id into v_id;

  -- Never report success for a write that did not happen.
  if v_id is null then
    raise exception 'That client is not available.'
      using errcode = 'check_violation';
  end if;

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

revoke execute on function public.archive_treatment_image(uuid, uuid) from public;
revoke execute on function public.archive_treatment_image(uuid, uuid) from anon;
revoke execute on function public.archive_treatment_image(uuid, uuid) from authenticated;
revoke execute on function public.archive_treatment_image(uuid, uuid) from service_role;
grant execute on function public.archive_treatment_image(uuid, uuid) to authenticated;

revoke execute on function public.clients_portrait_integrity() from public;
revoke execute on function public.clients_portrait_integrity() from anon;
revoke execute on function public.clients_portrait_integrity() from authenticated;
revoke execute on function public.clients_portrait_integrity() from service_role;


commit;
