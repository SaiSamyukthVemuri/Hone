-- Migration 0076. Receipt-state columns on payment_charge_attempts.
-- PR #175. Adds the persisted receipt-send state so the
-- practitioner UI can show "already sent on DATE" survival
-- across a page refresh (mirroring the PR #174 pattern where the
-- persisted row drives every render path), AND so the
-- sendPaymentChargeReceipt helper can use an atomic
-- `receipt_status IS NULL` -> 'sending' -> 'sent' / 'failed'
-- claim for race-protection against double-send.
--
-- Why a new migration vs. reusing ops_alerts:
--   ops_alerts (migration 0067) is the operator-facing alert
--   surface; it is append-only and not designed for
--   transactional dedup. The receipt path needs (a) a column
--   we can scope a partial unique to in the future, (b) a
--   refresh-survival state for the UI, and (c) a symmetric
--   place alongside the existing payment_charge_attempts
--   failure columns (`failure_code`, `failure_message_safe`,
--   `failed_at`). Five columns colocated on the same row is
--   the cleanest shape.
--
-- Why test-mode-only:
--   PR #175 is reason-agnostic but explicitly test-mode only.
--   Receipts for live charges are a separate live-enablement
--   PR (the docs/16 §11 sequence). Live mode is still
--   structurally blocked by the four dormancy guards from PR
--   #168 + PR #171, plus the per-row stripe_livemode CHECK on
--   payment_charge_attempts. This migration does not relax any
--   live-mode guard.
--
-- Idempotency:
--   IF NOT EXISTS on every ADD COLUMN so a re-run is a no-op.
--   No DML; the receipt columns are nullable and populated only
--   when an action runs. Existing rows (currently 0 in prod;
--   the prepare/execute flows have not produced a succeeded
--   row yet on this branch) remain valid: every new column
--   defaults to null.
--
-- Receipt status state machine (enforced by CHECK + claim
-- pattern in lib/billing/payment-receipt.ts):
--   * null         -> never attempted yet (the default).
--   * 'sending'    -> claim taken; the action is calling the
--                     email helper.
--   * 'sent'       -> sendEmailSafely returned ok; the receipt
--                     was delivered. receipt_sent_at and
--                     receipt_email_to are populated.
--   * 'failed'     -> sendEmailSafely returned ok=false with
--                     retryable=false, or the row was parked
--                     after a network timeout the action could
--                     not resolve safely. receipt_failure_code
--                     and receipt_failure_message_safe carry
--                     the sanitised detail.
--
-- The UI surfaces "not sent" when the column is null and
-- "already sent on <receipt_sent_at>" when status='sent'.
-- 'failed' surfaces the safe message + a Try again affordance
-- (the action accepts a failed row as eligible for retry by
-- clearing the status to null in the claim transition).

alter table public.payment_charge_attempts
  add column if not exists receipt_status text;

alter table public.payment_charge_attempts
  add column if not exists receipt_sent_at timestamptz;

alter table public.payment_charge_attempts
  add column if not exists receipt_email_to text;

alter table public.payment_charge_attempts
  add column if not exists receipt_failure_code text;

alter table public.payment_charge_attempts
  add column if not exists receipt_failure_message_safe text;

-- Status CHECK. The set is closed so a typo in the action
-- layer cannot land a row in an unknown receipt_status that
-- the UI does not know how to render. Drop-and-re-add so the
-- migration is safe to re-run after a future relaxation.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_receipt_status_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_receipt_status_check
    check (
      receipt_status is null
      or receipt_status in ('sending', 'sent', 'failed')
    );

-- Failure-detail length CHECKs mirror the existing
-- failure_code / failure_message_safe bounds on the same row
-- so a paste-bomb cannot fill the receipt audit column.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_receipt_failure_code_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_receipt_failure_code_check
    check (
      receipt_failure_code is null
      or char_length(receipt_failure_code) <= 100
    );

alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_receipt_failure_message_safe_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_receipt_failure_message_safe_check
    check (
      receipt_failure_message_safe is null
      or char_length(receipt_failure_message_safe) <= 1000
    );

-- Partial index for "stuck receipts" dashboards. A
-- receipt_status='sending' row past N minutes is the
-- operator's signal to reconcile by hand. The same shape
-- ops_alerts uses for unresolved rows (partial on
-- resolved_at IS NULL) is borrowed here.
create index if not exists payment_charge_attempts_receipt_sending_idx
  on public.payment_charge_attempts (studio_id, updated_at)
  where receipt_status = 'sending';

comment on column public.payment_charge_attempts.receipt_status is
  'Receipt-send state: null / sending / sent / failed. Populated only after the receipt action claims the row. PR #175.';
comment on column public.payment_charge_attempts.receipt_sent_at is
  'Timestamp the receipt email was successfully delivered via Resend. Populated only on a successful send. PR #175.';
comment on column public.payment_charge_attempts.receipt_email_to is
  'Recipient email address the receipt was sent to. Stored so the practitioner UI can show "already sent to <email> on <date>" across refreshes. PR #175.';

-- Verification (run manually after `supabase db push --linked`):
--
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='payment_charge_attempts'
--     and column_name like 'receipt%'
--   order by ordinal_position;
--   -- expect: 5 rows, all text/timestamptz, all nullable
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid='public.payment_charge_attempts'::regclass
--     and conname like '%receipt%'
--   order by conname;
--   -- expect: 3 CHECK constraints (receipt_status,
--   --         receipt_failure_code, receipt_failure_message_safe)
--
--   select indexname
--   from pg_indexes
--   where schemaname='public' and tablename='payment_charge_attempts'
--     and indexname = 'payment_charge_attempts_receipt_sending_idx';
--   -- expect: one row.
--
--   select count(*) from public.payment_charge_attempts;
--   -- expect: same row count as before the migration (no DML).
