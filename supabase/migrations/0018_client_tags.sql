-- Migration 0018: client tags.
-- Reusable client-specific notes that travel with the client across sessions.
-- These differ from session/entry comments, which capture observations from
-- one specific treatment.
--
-- Soft-delete pattern matches sessions (see migration 0013): a removed tag
-- stays in the row with deleted_at set, so a re-added tag with the same
-- label does not conflict (no unique constraint).

create table if not exists public.client_tags (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  label text not null,
  -- Optional color hint. v1 ignores it in the UI; reserved for a future
  -- per-tag color picker.
  color text,

  created_at timestamptz not null default now(),
  created_by uuid references public.practitioners(id) on delete set null,

  deleted_at timestamptz,
  deleted_by uuid references public.practitioners(id) on delete set null,
  delete_reason text
);

drop index if exists client_tags_client_id_idx;
create index client_tags_client_id_idx
  on public.client_tags (client_id)
  where deleted_at is null;

drop index if exists client_tags_studio_id_idx;
create index client_tags_studio_id_idx
  on public.client_tags (studio_id)
  where deleted_at is null;

alter table public.client_tags enable row level security;

drop policy if exists "client_tags_member_all" on public.client_tags;
create policy "client_tags_member_all"
  on public.client_tags
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
