-- 0232 · FETT photos (HON-43): label a visit photo BEFORE or AFTER treatment.
--
-- Practitioners take a before AND an after photo every session (staff-quality
-- monitoring). This adds the label only: one nullable column and one write
-- command. No new storage, no new data class: the photo row already exists
-- and keeps every hardening it has (private bucket, studio/client-bound path,
-- EXIF/GPS strip, RLS, 60 s signed URLs). Consent and retention are the
-- EXISTING treatment-photo policy; nothing here changes either.
--
--   * capture_stage is NULL (unlabelled) for every existing row; no backfill.
--     The CHECK admits only 'before' or 'after'.
--   * Only a photo linked to a VISIT (session_id not null) can carry a stage.
--     Enforced by the command and cleanup trigger, not a table CHECK, so sessions.id's
--     ON DELETE SET NULL can never make a cascade throw.
--   * ...and KEPT true when the visit goes away (Codex 4308037526). Hard
--     deleting a session runs 0092's ON DELETE SET NULL on session_id, which
--     would leave a 'before'/'after' label on a photo that is now
--     client-scoped. One BEFORE INSERT OR UPDATE trigger clears the label
--     whenever a row has no session, including direct service_role/postgres
--     inserts (Codex 4309998087). It REPAIRS the row instead of refusing it, so
--     the FK cascade (an UPDATE) still succeeds and a session delete is never
--     blocked; a CHECK here would make that cascade fail.
--   * The label is set by its own command rather than a tenth argument on
--     create_treatment_image_metadata: an overload or a signature change would
--     break the frozen 0168 pins (privilege/definer matrices and every caller
--     of the nine-argument create). The application creates the photo, then
--     labels it; a failed label leaves it UNLABELLED, never mislabelled.
--   * The actor is resolved per studio through treatment_image_actor(studio):
--     an ACTIVE practitioner of that studio. A receptionist, a deactivated
--     practitioner or another studio gets NULL, exactly like
--     set_treatment_image_note (non-disclosing).
--   * That is the ONE trigger this adds to treatment_images, whose trigger set
--     is pinned by the 0093/0168 and 0169 guards; those pins name it.
--   * A photo on a LEGACY finalized or void session (0159 retired the signed
--     record system; the one surviving artifact stays immutable) gets NULL
--     before any write. Neither the retired snapshot builder nor the retired
--     correction appliers are extended to carry the label.

begin;

set local lock_timeout = '5s';

alter table public.treatment_images
  add column if not exists capture_stage text
    constraint treatment_images_capture_stage_check
      check (capture_stage in ('before', 'after'));

comment on column public.treatment_images.capture_stage is
  '0232. Whether a visit photo was taken BEFORE or AFTER treatment; NULL = unlabelled. Set only through set_treatment_image_capture_stage(), and only on a photo linked to a session.';

-- ---------------------------------------------------------------------------
-- set_treatment_image_capture_stage(image, client, stage | null)
-- Returns the image id on success; NULL when the photo is not this client's
-- current photo or the caller is not an active practitioner of its studio.
-- ---------------------------------------------------------------------------
create or replace function public.set_treatment_image_capture_stage(
  p_image_id  uuid,
  p_client_id uuid,
  p_stage     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio  uuid;
  v_session uuid;
  v_record  text;
  v_pract   uuid;
  v_id      uuid;
begin
  -- BACKSTOP only: the application offers exactly these two values.
  if p_stage is not null and p_stage not in ('before', 'after') then
    raise exception 'A photo stage must be before or after.'
      using errcode = 'check_violation';
  end if;

  select t.studio_id, t.session_id into v_studio, v_session
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

  -- RETIRED FINALIZATION (0159): a photo on a legacy finalized or void session
  -- is immutable (treatment_images_guard_finalized). Refuse it the same
  -- non-disclosing way BEFORE any write, instead of letting the guard raise.
  -- The retired correction paths are deliberately NOT extended to carry this.
  if v_session is not null then
    select s.record_status into v_record
      from public.sessions s
     where s.id = v_session;
    if v_record in ('finalized', 'void') then
      return null;
    end if;
  end if;

  -- Only now, with the actor proven, is the photo's scope disclosed.
  if p_stage is not null and v_session is null then
    raise exception 'Only a photo from a visit can be marked before or after.'
      using errcode = 'check_violation';
  end if;

  update public.treatment_images t
     set capture_stage = p_stage
   where t.id = p_image_id
     and t.studio_id = v_studio
     and t.client_id = p_client_id
     and t.deleted_at is null
  returning t.id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- No sessionless photo keeps a label: INSERT as well as UPDATE (4309998087).
-- The original session-delete cascade repair (4308037526) stays unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.treatment_images_clear_stage_without_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.capture_stage := null;
  return new;
end;
$$;

revoke execute on function public.treatment_images_clear_stage_without_session() from public;
revoke execute on function public.treatment_images_clear_stage_without_session() from anon;
revoke execute on function public.treatment_images_clear_stage_without_session() from authenticated;
revoke execute on function public.treatment_images_clear_stage_without_session() from service_role;

drop trigger if exists treatment_images_clear_stage_without_session on public.treatment_images;
create trigger treatment_images_clear_stage_without_session
  before insert or update on public.treatment_images
  for each row
  when (new.session_id is null and new.capture_stage is not null)
  execute function public.treatment_images_clear_stage_without_session();

revoke execute on function public.set_treatment_image_capture_stage(uuid, uuid, text) from public;
revoke execute on function public.set_treatment_image_capture_stage(uuid, uuid, text) from anon;
revoke execute on function public.set_treatment_image_capture_stage(uuid, uuid, text) from authenticated;
revoke execute on function public.set_treatment_image_capture_stage(uuid, uuid, text) from service_role;
grant execute on function public.set_treatment_image_capture_stage(uuid, uuid, text) to authenticated;

commit;
