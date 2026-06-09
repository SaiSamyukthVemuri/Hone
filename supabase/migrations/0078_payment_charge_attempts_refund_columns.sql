-- ---------------------------------------------------------------------------
-- PR #178. Add refund state columns to payment_charge_attempts.
-- ---------------------------------------------------------------------------
--
-- Adds nine nullable columns + three CHECK constraints + one partial
-- unique on stripe_refund_id + one partial unique on
-- refund_idempotency_key + one partial index for the
-- "pending refunds" operator dashboard.
--
-- Reason-agnostic: today only `session_payment` rows exist in
-- payment_charge_attempts, but the same columns work for
-- `late_cancellation_fee` and `no_show_fee` when those reasons
-- start writing rows. No code change is needed in the refund
-- helper to support additional reasons.
--
-- Lifecycle (managed by lib/billing/payment-refund.ts):
--   refund_status: null
--     -> 'pending_stripe' (claim conditional UPDATE before Stripe call)
--     -> 'succeeded'      (Stripe refund returned ok)
--     -> 'failed'         (Stripe refund returned error; can retry)
--
-- v1 scope:
--   * full refund only (helper sets refund_amount_cents = amount_cents)
--   * one refund per attempt (stripe_refund_id partial unique)
--   * the schema's CHECK refund_amount_cents <= amount_cents leaves
--     room for a future partial-refund PR to NOT require migration
--   * the helper rejects in-flight + already-refunded states; failed
--     refunds can be retried
--
-- Safety:
--   * Every column nullable; idempotency key partial unique only.
--   * All CHECK adds use DROP+ADD so the migration is re-runnable.
--   * No live-mode invariant relaxed.
--   * No DML against manual_fee_charge_attempts, payment_charge
--     _attempts (this migration only ALTERs the table), or any
--     other table.
--   * No CHECK constraint dropped without a replacement.
--   * No Stripe call. No PaymentIntent create. No money movement.
--
-- Migration ledger: latest in tree was 0077 (PR #177 pointer
-- refresh backfill). This is 0078.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) Columns. All nullable.
-- ============================================================
alter table public.payment_charge_attempts
  add column if not exists refund_status text,
  add column if not exists refund_amount_cents integer,
  add column if not exists refunded_at timestamptz,
  add column if not exists stripe_refund_id text,
  add column if not exists refund_failure_code text,
  add column if not exists refund_failure_message_safe text,
  add column if not exists refund_internal_note text,
  add column if not exists refund_idempotency_key text,
  add column if not exists refund_initiated_by_practitioner_id uuid;

-- ============================================================
-- 2) FK on the practitioner (composite to stay scoped to the
--    same studio as the row's studio_id). Mirrors the existing
--    created_by_practitioner_studio_fk shape.
-- ============================================================
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_initiated_by_practitioner_studio_fk;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_initiated_by_practitioner_studio_fk
    foreign key (refund_initiated_by_practitioner_id, studio_id)
    references public.practitioners(id, studio_id) on delete restrict;

-- ============================================================
-- 3) CHECK constraints. DROP+ADD so the migration is re-runnable.
-- ============================================================

-- Status enum.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_status_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_status_check
    check (
      refund_status is null
      or refund_status in ('pending_stripe', 'succeeded', 'failed')
    );

-- Refund amount bounds. CHECK refund_amount_cents > 0 AND
-- refund_amount_cents <= amount_cents. The upper bound leaves
-- room for a future partial-refund PR to write a smaller value
-- without a migration; v1 helper writes the full amount only.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_amount_bounds_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_amount_bounds_check
    check (
      refund_amount_cents is null
      or (refund_amount_cents > 0 and refund_amount_cents <= amount_cents)
    );

-- Failure-code length cap (matches receipt_failure_code cap).
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_failure_code_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_failure_code_check
    check (
      refund_failure_code is null
      or char_length(refund_failure_code) <= 100
    );

-- Failure-message length cap (matches receipt_failure_message_safe cap).
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_failure_message_safe_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_failure_message_safe_check
    check (
      refund_failure_message_safe is null
      or char_length(refund_failure_message_safe) <= 1000
    );

-- Internal-note length cap. Practitioner-supplied free text.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_refund_internal_note_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_internal_note_check
    check (
      refund_internal_note is null
      or char_length(refund_internal_note) <= 500
    );

-- ============================================================
-- 4) Partial unique indexes.
-- ============================================================

-- One Hone row per Stripe refund object. Mirrors the existing
-- payment_charge_attempts_pi_uniq pattern.
create unique index if not exists payment_charge_attempts_refund_id_uniq
  on public.payment_charge_attempts (stripe_refund_id)
  where stripe_refund_id is not null;

-- Deterministic idempotency key uniqueness. Shape:
--   hone:payment_refund:<attemptId>:v1
-- A retry produces the same key; the partial unique catches a
-- programmer error that produces two distinct keys for the same
-- attempt.
create unique index if not exists payment_charge_attempts_refund_idempotency_uniq
  on public.payment_charge_attempts (refund_idempotency_key)
  where refund_idempotency_key is not null;

-- ============================================================
-- 5) Partial index for the operator "stuck pending refunds"
--    dashboard. Mirrors the PR #175 receipt-pending index shape.
-- ============================================================
create index if not exists payment_charge_attempts_refund_pending_idx
  on public.payment_charge_attempts (studio_id, updated_at)
  where refund_status = 'pending_stripe';
