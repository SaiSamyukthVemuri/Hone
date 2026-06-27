-- Migration 0092: Secure treatment image storage V1 (PR #271).
--
-- Practitioner-only image storage so treatment memory can include visual
-- reference material. SCHEMA + STORAGE-SETUP ONLY: no annotation, no
-- drawing/sketch, no OCR, no AI extraction, no public/client exposure.
--
-- Access model (defense-in-depth):
--   * PRIVATE bucket `treatment-images` (public = false) => no public URLs.
--   * The app's ONLY object path is server actions running the SERVICE-ROLE
--     client (createAdminClient), which FIRST verify the caller is an active
--     practitioner of the row's studio, then upload / createSignedUrl. Signed
--     URLs are short-TTL and returned only to the practitioner action result.
--   * The treatment_images METADATA table carries studio-scoped RLS
--     (is_studio_member), mirroring public.photos / clinical tables: member
--     select/insert/update, NO delete (soft-delete via deleted_at), and
--     revoke truncate/delete so the soft-delete posture is enforceable.
--   * storage.objects policies below are an ADDITIONAL belt-and-braces layer
--     scoped by the first path segment (studio_id). They are wrapped in an
--     exception handler: the `storage` schema is platform-owned, so if this
--     migration role cannot manage policies on storage.objects, the migration
--     still succeeds (the private bucket + service-role server actions remain
--     the authoritative gate). Same for the bucket insert.
--
-- MANUAL FALLBACK (only if the wrapped blocks below emit a notice on apply):
--   In the Supabase dashboard create a PRIVATE bucket named `treatment-images`
--   (public = OFF). The metadata table + RLS are created unconditionally.
--
-- Additive, re-runnable (if/drop-if-exists, on conflict do nothing). No
-- payment/auth changes. No public/anon grants. Live payments remain disabled.
-- Object path convention (server-generated): <studio_id>/<client_id>/<uuid>.<ext>

-- 1. Private bucket (idempotent; public=false => no public URLs) --------------
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('treatment-images', 'treatment-images', false)
  on conflict (id) do nothing;
exception when insufficient_privilege then
  raise notice 'skipping storage.buckets insert (insufficient privilege); create a PRIVATE bucket named treatment-images manually in the Supabase dashboard';
end $$;

-- 2. treatment_images metadata table -----------------------------------------
create table if not exists public.treatment_images (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  -- client_id is REQUIRED: every image is attached to a client.
  client_id uuid not null
    references public.clients(id) on delete cascade,
  -- Optional links to the session / session block being charted.
  session_id uuid references public.sessions(id) on delete set null,
  session_block_id uuid
    references public.session_blocks(id) on delete set null,
  -- Storage location. bucket is private; path is server-generated and
  -- studio-prefixed; never trust a client-supplied path.
  storage_bucket text not null default 'treatment-images',
  storage_path text not null,
  -- Sanitized original filename (display only; never used to build the path).
  original_filename text,
  content_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft-delete (archive); no hard-delete path in V1.
  deleted_at timestamptz,
  deleted_by uuid references public.practitioners(id) on delete set null
);

create index if not exists treatment_images_studio_client_idx
  on public.treatment_images (studio_id, client_id, created_at desc);
create index if not exists treatment_images_session_idx
  on public.treatment_images (session_id);
create index if not exists treatment_images_block_idx
  on public.treatment_images (session_block_id);

-- updated_at trigger (reuse public.set_updated_at from 0015).
drop trigger if exists treatment_images_set_updated_at on public.treatment_images;
create trigger treatment_images_set_updated_at
  before update on public.treatment_images
  for each row execute function public.set_updated_at();

-- 3. RLS on the metadata table (studio member; no delete) --------------------
alter table public.treatment_images enable row level security;

drop policy if exists "treatment_images: members select" on public.treatment_images;
create policy "treatment_images: members select"
  on public.treatment_images for select to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "treatment_images: members insert" on public.treatment_images;
create policy "treatment_images: members insert"
  on public.treatment_images for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "treatment_images: members update" on public.treatment_images;
create policy "treatment_images: members update"
  on public.treatment_images for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
-- No DELETE policy: correction is soft-delete (UPDATE deleted_at) only.

-- Privilege-layer hardening: RLS does not gate TRUNCATE/DELETE and Supabase
-- grants ALL on public tables to anon/authenticated by default. Revoke so the
-- soft-delete-only posture cannot be bypassed. Service-role/postgres retain all.
revoke truncate, delete on public.treatment_images from anon, authenticated;

-- 4. storage.objects policies (defense-in-depth; studio_id = first path seg) --
-- Wrapped: the primary gate is the private bucket + service-role server
-- actions; if this role cannot manage storage.objects policies, skip cleanly.
do $$
begin
  drop policy if exists "treatment_images_objects: members select" on storage.objects;
  create policy "treatment_images_objects: members select"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'treatment-images'
      and public.is_studio_member(((storage.foldername(name))[1])::uuid)
    );

  drop policy if exists "treatment_images_objects: members insert" on storage.objects;
  create policy "treatment_images_objects: members insert"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'treatment-images'
      and public.is_studio_member(((storage.foldername(name))[1])::uuid)
    );
  -- No anon/public policy; no delete policy (object deletion is a service-role
  -- admin operation, deferred in V1).
exception when insufficient_privilege then
  raise notice 'skipping storage.objects policies (insufficient privilege); private bucket + service-role server actions remain the access gate';
end $$;
