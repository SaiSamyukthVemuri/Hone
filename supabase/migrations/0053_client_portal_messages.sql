-- Migration 0053: secure client portal messages.
--
-- One-way v1: practitioner publishes a short text note that surfaces
-- in the client's portal. Client receives an email notification that
-- something is waiting; the message body is shown ONLY inside the
-- portal. The client can mark the message reviewed. There is no
-- reply path in this migration; the client_id column is read-only
-- for the client side and the only client-side write is
-- client_reviewed_at.
--
-- Strictly additive + idempotent (every CREATE uses IF NOT EXISTS;
-- constraints drop-if-exists before being added).
--
-- Why server-action-scoped (RLS-on, no policies):
--   * The same admin client serves the practitioner side (server
--     action gated by getCurrentPractitionerWithStudio) and the
--     portal side (server action gated by getCurrentPortalSession +
--     studio/client scoping). Both call sites enforce the
--     (studio_id, client_id) tuple explicitly.
--   * RLS is enabled with no policies so any user-scoped Supabase
--     client that accidentally targets this table gets zero rows.
--     The two well-known callers go through the service-role admin
--     client by design.
--   * This matches the posture migration 0052 took for
--     client_portal_magic_links and client_portal_sessions.

-- --------------------------------------------------------------------
-- 1) Table
-- --------------------------------------------------------------------

create table if not exists public.client_portal_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- Practitioner who created the message. on delete restrict because
  -- a missing author would orphan the audit trail; deactivating a
  -- practitioner is handled by the practitioners.active flag rather
  -- than a hard delete on this table.
  created_by_practitioner_id uuid not null
    references public.practitioners(id) on delete restrict,
  subject text not null,
  body text not null,
  status text not null default 'published',
  published_at timestamptz not null default now(),
  -- Stamped server-side when the client marks the message reviewed.
  -- A null value means the client has not yet acknowledged it. A
  -- non-null value means the conditional UPDATE in the portal
  -- markPortalMessageReviewedAction succeeded for this row.
  client_reviewed_at timestamptz,
  -- Notification email send state. Stamped on the practitioner-side
  -- create action only after sendEmailSafely resolves OK. A failed
  -- send leaves notification_email_sent_at null and writes a
  -- sanitized short string into notification_email_error so the
  -- practitioner card can surface the failure.
  notification_email_sent_at timestamptz,
  notification_email_error text,
  -- Soft-archive only. Hard delete is intentionally not supported so
  -- the audit trail (who said what to whom, and whether the client
  -- saw it) is preserved.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------
-- 2) CHECK constraints
-- --------------------------------------------------------------------

alter table public.client_portal_messages
  drop constraint if exists client_portal_messages_status_check;
alter table public.client_portal_messages
  add constraint client_portal_messages_status_check
  check (status in ('draft', 'published', 'archived'));

alter table public.client_portal_messages
  drop constraint if exists client_portal_messages_subject_length_check;
alter table public.client_portal_messages
  add constraint client_portal_messages_subject_length_check
  check (char_length(subject) between 1 and 160);

alter table public.client_portal_messages
  drop constraint if exists client_portal_messages_body_length_check;
alter table public.client_portal_messages
  add constraint client_portal_messages_body_length_check
  check (char_length(body) between 1 and 5000);

-- --------------------------------------------------------------------
-- 3) Indexes
-- --------------------------------------------------------------------

create index if not exists client_portal_messages_client_idx
  on public.client_portal_messages (studio_id, client_id, published_at desc);

create index if not exists client_portal_messages_studio_idx
  on public.client_portal_messages (studio_id, published_at desc);

-- Partial index for the "unreviewed and visible to the client" query
-- the portal home runs every load. Excludes archived + drafts so the
-- index stays small and only points at the rows the client actually
-- sees.
create index if not exists client_portal_messages_unreviewed_idx
  on public.client_portal_messages (studio_id, client_id)
  where client_reviewed_at is null
    and status = 'published'
    and archived_at is null;

create index if not exists client_portal_messages_author_idx
  on public.client_portal_messages
  (created_by_practitioner_id, published_at desc);

-- --------------------------------------------------------------------
-- 4) updated_at trigger
-- --------------------------------------------------------------------

create or replace function public.tg_client_portal_messages_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_client_portal_messages_set_updated_at
  on public.client_portal_messages;
create trigger tg_client_portal_messages_set_updated_at
  before update on public.client_portal_messages
  for each row execute function public.tg_client_portal_messages_set_updated_at();

-- --------------------------------------------------------------------
-- 5) RLS
-- --------------------------------------------------------------------

alter table public.client_portal_messages enable row level security;

comment on table public.client_portal_messages is
  'One-way secure messages from practitioner to client surfaced on the client portal. Practitioner-side writes are scoped by getCurrentPractitionerWithStudio() in the server action; portal-side reads/reviews are scoped by getCurrentPortalSession() + (studio_id, client_id) in the server action. RLS is enabled with no policies so user-scoped Supabase clients see zero rows; only the service-role admin client should read/write these. Message body is rendered exclusively inside the portal; the notification email never includes it.';
