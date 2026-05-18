-- Migration 0013: soft-delete fields for sessions.
-- Hard deletes are dangerous for healthcare-adjacent records (audit,
-- insurance dispute, regulatory). Soft delete preserves the row while
-- hiding it from normal queries.
--
-- Re-runnable: add column if not exists, drop constraint/index if exists.

alter table public.sessions
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.practitioners(id) on delete set null,
  add column if not exists delete_reason text;

-- Partial index so "list active sessions" queries stay fast.
drop index if exists sessions_deleted_at_idx;
create index sessions_deleted_at_idx
  on public.sessions (deleted_at)
  where deleted_at is null;
