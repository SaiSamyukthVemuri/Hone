-- 0105: mode-scope the active payment-attempt duplicate protection.
--
-- Companion to 0103 (mode-scoped Connect provisioning) and 0104 (one active
-- card per (studio, client, mode)). Live billing is proven; the remaining
-- mode-isolation gap (adversarial review) is the pair of 0073 partial
-- uniques on payment_charge_attempts:
--
--   payment_charge_attempts_active_session_payment_uniq
--     UNIQUE (session_id)                    WHERE ... active statuses
--   payment_charge_attempts_active_fee_per_appointment_uniq
--     UNIQUE (appointment_id, charge_reason) WHERE ... active statuses
--
-- Neither includes stripe_livemode, so an active TEST attempt (e.g. a
-- succeeded pilot test charge) structurally BLOCKS preparing a LIVE attempt
-- for the same session/appointment/reason — and vice versa. This migration
-- rescopes both indexes per mode:
--
--   * same-mode duplicate protection is PRESERVED (one active attempt per
--     session / per (appointment, reason) within a mode);
--   * one test and one live attempt may now coexist for the same
--     session/appointment/reason when the modes differ.
--
-- Safety:
--   * stripe_livemode is NOT NULL on payment_charge_attempts (0073), so
--     there is no null-mode subtlety.
--   * Adding a column to a unique index is STRICTLY LOOSER — any data that
--     satisfied the 0073 indexes satisfies these, so the swap applies
--     cleanly on production and on the from-scratch CI chain.
--   * The Stripe-id-keyed uniques (idempotency key, PaymentIntent id,
--     refund id/idempotency) are untouched — Stripe ids are inherently
--     mode-distinct.
--   * The legacy manual_fee_charge_attempts table (0064) is untouched: it
--     receives no runtime writes (fees ride the canonical ledger since PR
--     #196) and its rows are pinned test-mode by its own CHECK.
--   * No table/RPC/policy/env change; no charge execution change. The
--     matching read-side fix (eligibility existing-attempt queries filter
--     by the deployment mode) ships in the same PR.

drop index if exists public.payment_charge_attempts_active_session_payment_uniq;
create unique index payment_charge_attempts_active_session_payment_uniq
  on public.payment_charge_attempts (session_id, stripe_livemode)
  where session_id is not null
    and charge_reason = 'session_payment'
    and status in ('ready', 'pending_stripe', 'succeeded');

drop index if exists public.payment_charge_attempts_active_fee_per_appointment_uniq;
create unique index payment_charge_attempts_active_fee_per_appointment_uniq
  on public.payment_charge_attempts (appointment_id, charge_reason, stripe_livemode)
  where appointment_id is not null
    and charge_reason in ('late_cancellation_fee', 'no_show_fee')
    and status in ('ready', 'pending_stripe', 'succeeded');

-- Verification SQL (operator runs after deploy):
--
--   select indexname, indexdef from pg_indexes
--   where tablename = 'payment_charge_attempts'
--     and indexname in (
--       'payment_charge_attempts_active_session_payment_uniq',
--       'payment_charge_attempts_active_fee_per_appointment_uniq');
--   -- expect: (session_id, stripe_livemode) and
--   --         (appointment_id, charge_reason, stripe_livemode),
--   --         both with the unchanged active-status predicates.
--
--   select session_id, stripe_livemode, count(*)
--   from public.payment_charge_attempts
--   where session_id is not null and charge_reason = 'session_payment'
--     and status in ('ready','pending_stripe','succeeded')
--   group by 1,2 having count(*) > 1;
--   -- expect: zero rows (same-mode protection intact).
