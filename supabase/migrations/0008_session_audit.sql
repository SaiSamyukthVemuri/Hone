-- Adds the original-time column and the per-session audit log used by the
-- Edit time feature on the session detail page.

alter table public.sessions
  add column if not exists started_at_original timestamptz;

update public.sessions
  set started_at_original = started_at
  where started_at_original is null;

-- Default `now()` so future inserts don't need to set the column explicitly;
-- it's filled from the same clock that fills started_at.
alter table public.sessions
  alter column started_at_original set default now(),
  alter column started_at_original set not null;

create table if not exists public.session_audit (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions(id) on delete cascade not null,
  edited_by_practitioner_id uuid references public.practitioners(id) on delete set null,
  field text not null,
  old_value text,
  new_value text,
  edited_at timestamptz not null default now()
);

create index if not exists session_audit_session_id_idx
  on public.session_audit (session_id, edited_at desc);

alter table public.session_audit enable row level security;

create policy "session_audit_studio_member_read"
  on public.session_audit for select
  using (
    session_id in (
      select s.id from public.sessions s
      join public.clients c on s.client_id = c.id
      where c.studio_id in (
        select studio_id from public.practitioners
        where user_id = auth.uid() and active = true
      )
    )
  );

create policy "session_audit_studio_member_insert"
  on public.session_audit for insert
  with check (
    edited_by_practitioner_id in (
      select id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );
