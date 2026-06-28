-- Migration 0093: Harden treatment image storage trust boundary (PR #276).
--
-- 0092 shipped the right SHAPE (private bucket, metadata table, signed URLs) but
-- the trust boundary was too loose:
--   * storage.objects carried AUTHENTICATED select/insert policies for
--     treatment-images, so a studio member could read/write objects DIRECTLY
--     (Supabase storage API), bypassing the server actions.
--   * the metadata insert RLS only checked is_studio_member(studio_id); a member
--     could insert a forged row with an arbitrary storage_path / storage_bucket
--     / cross-studio client_id|session_id|session_block_id, and the service-role
--     signer would then sign that forged path (cross-studio object exfiltration).
--   * path-bearing identity columns were mutable post-insert.
--
-- This migration:
--   1. ensures the bucket stays PRIVATE (public=false);
--   2. makes objects SERVICE-ROLE ONLY (drops authenticated storage.objects
--      policies for treatment-images) — the app never used direct authenticated
--      object access, so this only removes the bypass;
--   3. binds storage_bucket + storage_path to THIS row's studio_id/client_id via
--      CHECK constraints (fixed bucket; path = <studio_id>/<client_id>/<file>.<ext>);
--   4. enforces parent consistency (client∈studio; session∈studio+client;
--      block∈session+studio) and freezes identity columns post-insert, via one
--      BEFORE INSERT OR UPDATE trigger.
--
-- PREFLIGHT: production has no treatment_images rows yet (no production uploads),
-- so the new CHECK/trigger cannot reject existing valid rows. If that ever
-- changes, validate existing rows against the path regex BEFORE applying:
--   select id, storage_path from public.treatment_images
--    where storage_path !~ ('^' || studio_id::text || '/' || client_id::text
--                           || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$');
--
-- Additive + idempotent. No payment/auth change. No public/anon grants. Live
-- payments remain disabled. DO NOT apply to production until explicitly approved
-- after merge.

-- 1. Keep the bucket PRIVATE (idempotent). -----------------------------------
do $$
begin
  update storage.buckets set public = false
   where id = 'treatment-images' and public is distinct from false;
exception when insufficient_privilege then
  raise notice 'skipping storage.buckets privacy enforce (insufficient privilege); ensure treatment-images is PRIVATE (public=off) in the Supabase dashboard';
end $$;

-- 2. Remove DIRECT authenticated storage.objects access for treatment-images.
-- Objects are now reachable ONLY via the service-role server actions, which
-- verify studio ownership + validate the path before uploading/signing. The
-- private bucket + service-role gate is authoritative; this closes the bypass.
do $$
begin
  drop policy if exists "treatment_images_objects: members select" on storage.objects;
  drop policy if exists "treatment_images_objects: members insert" on storage.objects;
  drop policy if exists "treatment_images_objects: members update" on storage.objects;
  drop policy if exists "treatment_images_objects: members delete" on storage.objects;
exception when insufficient_privilege then
  raise notice 'skipping storage.objects policy drop (insufficient privilege); confirm in the dashboard that NO authenticated treatment-images object policies exist';
end $$;

-- 3. Metadata bucket/path CHECK constraints. ---------------------------------
-- bucket is fixed; path is bound to THIS row's studio_id + client_id, a single
-- non-traversal filename segment, and an allowed image extension. studio_id /
-- client_id render as UUID text (only [0-9a-f-]), so they are regex-safe.
alter table public.treatment_images
  drop constraint if exists treatment_images_bucket_fixed_chk;
alter table public.treatment_images
  add constraint treatment_images_bucket_fixed_chk
  check (storage_bucket = 'treatment-images');

alter table public.treatment_images
  drop constraint if exists treatment_images_path_shape_chk;
alter table public.treatment_images
  add constraint treatment_images_path_shape_chk
  check (
    storage_path ~ (
      '^' || studio_id::text || '/' || client_id::text
          || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
    )
  );

-- NOTE: an immediate "block requires session" CHECK is intentionally NOT used.
-- session_id and session_block_id are independent FK ON DELETE SET NULL columns,
-- so deleting a parent session nulls them in SEPARATE row updates and a transient
-- state has session_id NULL while session_block_id is still set — an immediate
-- CHECK (which cannot be deferred in Postgres) would reject that legal cascade.
-- "A block must belong to its session" is enforced on INSERT by the trigger
-- below instead. (drop-if-exists keeps re-runs / partial applies clean.)
alter table public.treatment_images
  drop constraint if exists treatment_images_block_requires_session_chk;

-- 4. Parent consistency + identity immutability (one trigger). ---------------
-- SECURITY INVOKER (default): on the app's RLS-client insert this runs as the
-- authenticated member, but validation is by EXPLICIT studio_id/client_id
-- equality (not RLS visibility), so it is correct for service-role too.
create or replace function public.enforce_treatment_image_integrity()
returns trigger
language plpgsql
as $$
begin
  -- Identity columns are immutable after insert: no role may move a row to a
  -- different bucket/path/studio/client/session/block (archive only flips
  -- deleted_at/deleted_by + updated_at).
  if tg_op = 'UPDATE' then
    -- studio/client/bucket/path are strictly frozen (studio_id/client_id are
    -- ON DELETE CASCADE, so a parent delete removes the whole row, never an
    -- UPDATE). session_id/session_block_id may only be CLEARED to NULL by the
    -- FK ON DELETE SET NULL (parent session/block hard-deleted); they may never
    -- be re-pointed to a DIFFERENT session/block.
    if NEW.studio_id      is distinct from OLD.studio_id
       or NEW.client_id      is distinct from OLD.client_id
       or NEW.storage_bucket is distinct from OLD.storage_bucket
       or NEW.storage_path   is distinct from OLD.storage_path
       or (NEW.session_id is distinct from OLD.session_id
           and NEW.session_id is not null)
       or (NEW.session_block_id is distinct from OLD.session_block_id
           and NEW.session_block_id is not null) then
      raise exception 'treatment_images identity columns are immutable (id=%)', NEW.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Parent consistency is validated on INSERT only. On UPDATE the identity
  -- columns are frozen above (they can never be RE-POINTED, only cleared to
  -- NULL by an FK ON DELETE SET NULL cascade), so an UPDATE can never introduce
  -- an invalid parent — and re-validating here would FAIL on the transient
  -- cascade state where session_id is already NULL but session_block_id is not
  -- yet nulled (the two SET NULLs run as separate row updates). A block whose
  -- session_id is NULL matches no session_blocks row, so a block-without-session
  -- INSERT is still rejected here (this replaces the dropped block-requires-
  -- session CHECK, which — being immediate — could not tolerate that cascade).
  if tg_op = 'INSERT' then
    -- client must belong to the row's studio.
    if not exists (
      select 1 from public.clients c
       where c.id = NEW.client_id and c.studio_id = NEW.studio_id
    ) then
      raise exception 'treatment_images.client_id % must belong to studio_id %',
        NEW.client_id, NEW.studio_id using errcode = 'foreign_key_violation';
    end if;

    -- session (if present) must belong to the same studio + client.
    if NEW.session_id is not null and not exists (
      select 1 from public.sessions s
       where s.id = NEW.session_id
         and s.studio_id = NEW.studio_id
         and s.client_id = NEW.client_id
    ) then
      raise exception 'treatment_images.session_id % must belong to studio % + client %',
        NEW.session_id, NEW.studio_id, NEW.client_id using errcode = 'foreign_key_violation';
    end if;

    -- block (if present) must belong to the same session + studio (also rejects
    -- a block with a NULL session: it matches no session_blocks row).
    if NEW.session_block_id is not null and not exists (
      select 1 from public.session_blocks b
       where b.id = NEW.session_block_id
         and b.session_id = NEW.session_id
         and b.studio_id = NEW.studio_id
    ) then
      raise exception 'treatment_images.session_block_id % must belong to session % + studio %',
        NEW.session_block_id, NEW.session_id, NEW.studio_id using errcode = 'foreign_key_violation';
    end if;
  end if;

  return NEW;
end $$;

drop trigger if exists treatment_images_enforce_integrity on public.treatment_images;
create trigger treatment_images_enforce_integrity
  before insert or update on public.treatment_images
  for each row execute function public.enforce_treatment_image_integrity();
