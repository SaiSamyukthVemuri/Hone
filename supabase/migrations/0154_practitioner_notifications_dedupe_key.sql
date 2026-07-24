-- 0154: durable external-event dedupe key for practitioner_notifications.
--
-- The setup_intent.succeeded webhook arm (app/api/stripe/webhook/route.ts) now
-- writes a studio-wide practitioner notification when a client adds or replaces
-- a card on file (card_added / card_replaced). The webhook may re-deliver the
-- same Stripe event (Stripe's at-least-once contract), and a card insert can
-- succeed while the notification write fails and is retried. To make the
-- notification write idempotent across those retries WITHOUT rewriting any
-- existing row, we key it on the authoritative Stripe event id.
--
-- What this adds (additive-only, no backfill, no policy change):
--   * practitioner_notifications.dedupe_key text, NULLABLE. Existing rows and
--     every current writer (booking / cancel / reschedule / intake) leave it
--     NULL — they are not deduped and are unaffected.
--   * A length CHECK (defence-in-depth; the app writes "stripe:<event.id>",
--     ~70 chars — 200 is a comfortable ceiling that still rejects abuse).
--   * A PARTIAL UNIQUE index on (studio_id, dedupe_key) WHERE dedupe_key is not
--     null. Two deliveries of the same Stripe event resolve to the same
--     (studio_id, dedupe_key) and the second INSERT hits 23505, which the
--     durable writer treats as idempotent success. NULL dedupe_key rows are
--     outside the index, so existing writers keep inserting freely.
--
-- The dedupe_key is an internal idempotency token. It is NEVER rendered to a
-- user (the notification list selects only title/body/href/read_at/created_at).
--
-- No RLS change: the existing member-read / member-update policies and the
-- deliberate absence of an INSERT policy (service-role-only writes) are
-- untouched. No trigger, RPC, or other table is touched. Re-runnable.

alter table public.practitioner_notifications
  add column if not exists dedupe_key text;

alter table public.practitioner_notifications
  drop constraint if exists practitioner_notifications_dedupe_key_len;
alter table public.practitioner_notifications
  add constraint practitioner_notifications_dedupe_key_len
  check (dedupe_key is null or char_length(dedupe_key) <= 200);

create unique index if not exists practitioner_notifications_studio_dedupe_uniq
  on public.practitioner_notifications (studio_id, dedupe_key)
  where dedupe_key is not null;

-- Verification SQL (operator runs after apply):
--
--   select column_name, is_nullable, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'practitioner_notifications'
--     and column_name = 'dedupe_key';
--
--   select indexdef from pg_indexes
--   where indexname = 'practitioner_notifications_studio_dedupe_uniq';
