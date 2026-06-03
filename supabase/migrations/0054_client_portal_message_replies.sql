-- Migration 0054: client replies to secure portal messages.
--
-- PR #129. Extends the one-way portal message model (migration 0053)
-- with a single new child table that records the client's reply to a
-- specific parent message. This is NOT a chat / inbox model:
--   * Replies hang off a specific client_portal_messages row (FK).
--   * created_by is constrained to 'client' for v1; practitioner
--     responses still go through the existing
--     createPortalMessageAction (a brand new parent row).
--   * No SMS, no two-way SMS, no attachments, no rich text, no
--     announcements, no standalone inbox, no /portal/messages route.
--
-- Strictly additive + idempotent. RLS-enabled-no-policies posture
-- mirrors migration 0053; both well-known callers (the portal-side
-- create-reply action and the practitioner-side read / mark-seen
-- action) route through the service-role admin client and scope
-- queries by (studio_id, client_id, message_id).

-- --------------------------------------------------------------------
-- 1) Table
-- --------------------------------------------------------------------

create table if not exists public.client_portal_message_replies (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  message_id uuid not null
    references public.client_portal_messages(id) on delete cascade,
  body text not null,
  -- v1 constrains this to 'client'. A future practitioner-threaded-
  -- reply PR (deferred) will widen this enum; the CHECK below is the
  -- single guardrail to keep until that work lands.
  created_by text not null default 'client',
  -- Stamped server-side when the practitioner marks the reply seen
  -- on the client profile card. Null = practitioner has not yet
  -- acknowledged it. A non-null value means the conditional UPDATE
  -- in markPortalMessageReplySeenAction succeeded for this row.
  practitioner_seen_at timestamptz,
  -- Notification email send state to the studio side. Stamped only on
  -- a successful sendEmailSafely resolution. A failed send leaves
  -- notification_email_sent_at null and writes a sanitized short
  -- string into notification_email_error so the practitioner card
  -- can surface the failure.
  notification_email_sent_at timestamptz,
  notification_email_error text,
  -- Soft-archive only. Hard delete is intentionally not supported so
  -- the audit trail (who said what to whom) is preserved.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------
-- 2) CHECK constraints
-- --------------------------------------------------------------------

alter table public.client_portal_message_replies
  drop constraint if exists client_portal_message_replies_created_by_check;
alter table public.client_portal_message_replies
  add constraint client_portal_message_replies_created_by_check
  check (created_by in ('client'));

alter table public.client_portal_message_replies
  drop constraint if exists client_portal_message_replies_body_length_check;
alter table public.client_portal_message_replies
  add constraint client_portal_message_replies_body_length_check
  check (char_length(body) between 1 and 5000);

-- --------------------------------------------------------------------
-- 3) Indexes
-- --------------------------------------------------------------------

create index if not exists client_portal_message_replies_client_idx
  on public.client_portal_message_replies
  (studio_id, client_id, created_at desc);

create index if not exists client_portal_message_replies_message_idx
  on public.client_portal_message_replies (message_id, created_at asc);

-- Partial index for the "unread reply needs the practitioner's eye"
-- query the client profile card runs. Excludes archived + already-
-- seen so the index stays small and points only at the rows that
-- need attention.
create index if not exists client_portal_message_replies_unseen_idx
  on public.client_portal_message_replies (studio_id)
  where practitioner_seen_at is null
    and archived_at is null;

-- --------------------------------------------------------------------
-- 4) updated_at trigger
-- --------------------------------------------------------------------

create or replace function public.tg_client_portal_message_replies_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_client_portal_message_replies_set_updated_at
  on public.client_portal_message_replies;
create trigger tg_client_portal_message_replies_set_updated_at
  before update on public.client_portal_message_replies
  for each row execute function public.tg_client_portal_message_replies_set_updated_at();

-- --------------------------------------------------------------------
-- 5) RLS
-- --------------------------------------------------------------------

alter table public.client_portal_message_replies enable row level security;

comment on table public.client_portal_message_replies is
  'Client replies to a specific client_portal_messages row. Portal-side writes are scoped by getCurrentPortalSession() + parent-message (studio_id, client_id, message_id) match in the server action; practitioner-side reads / mark-seen are scoped by getCurrentPractitionerWithStudio() + (studio_id, client_id) in the server action. RLS is enabled with no policies so user-scoped Supabase clients see zero rows; only the service-role admin client should read/write these. Reply body is rendered exclusively inside Hone; the notification email never includes it.';
