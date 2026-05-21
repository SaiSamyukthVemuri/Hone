-- Migration 0022: client pinned notes.
-- Short practitioner-authored notes pinned to a client record. Display on
-- the client profile, appointment detail, and today's roster. Safety-relevant
-- (allergies, treatment plan reminders). No edit-in-place to keep the audit
-- trail clean: remove and re-add to change.
--
-- Single paste block, safe to re-run.

create table if not exists public.client_pinned_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  text text not null check (length(text) > 0 and length(text) <= 200),
  created_by_practitioner_id uuid references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists client_pinned_notes_client_idx
  on public.client_pinned_notes (client_id, created_at desc);

create index if not exists client_pinned_notes_studio_idx
  on public.client_pinned_notes (studio_id);

alter table public.client_pinned_notes enable row level security;

drop policy if exists "client_pinned_notes_studio_member_read"
  on public.client_pinned_notes;
create policy "client_pinned_notes_studio_member_read"
  on public.client_pinned_notes for select
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

drop policy if exists "client_pinned_notes_studio_member_insert"
  on public.client_pinned_notes;
create policy "client_pinned_notes_studio_member_insert"
  on public.client_pinned_notes for insert
  with check (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

drop policy if exists "client_pinned_notes_studio_member_delete"
  on public.client_pinned_notes;
create policy "client_pinned_notes_studio_member_delete"
  on public.client_pinned_notes for delete
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );
