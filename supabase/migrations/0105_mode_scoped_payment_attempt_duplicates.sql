-- 0105: mode-scope active payment-attempt duplicate protection.
--
-- 0103 made Stripe Connect settings mode-scoped. 0104 did the same for active
-- card rows. This migration applies the remaining mode-isolation fix to the
-- canonical payment_charge_attempts duplicate backstops:
--
--   * one active session_payment per (session_id, stripe_livemode)
--   * one active fee attempt per (appointment_id, charge_reason, stripe_livemode)
--
-- A TEST attempt must not block or masquerade as a LIVE attempt, and a LIVE
-- attempt must not interfere with TEST mode. Same-mode duplicate protection is
-- preserved for the active statuses that can move or represent money:
-- ready, pending_stripe, succeeded.
--
-- Re-runnable. No Stripe calls, env changes, table rewrites, policies, RPCs,
-- refunds, receipts, or webhook logic are touched.

drop index if exists public.payment_charge_attempts_active_fee_per_appointment_uniq;
create unique index payment_charge_attempts_active_fee_per_appointment_uniq
  on public.payment_charge_attempts (appointment_id, charge_reason, stripe_livemode)
  where appointment_id is not null
    and charge_reason in ('late_cancellation_fee', 'no_show_fee')
    and status in ('ready', 'pending_stripe', 'succeeded');

drop index if exists public.payment_charge_attempts_active_session_payment_uniq;
create unique index payment_charge_attempts_active_session_payment_uniq
  on public.payment_charge_attempts (session_id, stripe_livemode)
  where session_id is not null
    and charge_reason = 'session_payment'
    and status in ('ready', 'pending_stripe', 'succeeded');

-- Verification SQL (operator runs after deploy):
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and indexname in (
--       'payment_charge_attempts_active_fee_per_appointment_uniq',
--       'payment_charge_attempts_active_session_payment_uniq'
--     )
--   order by indexname;
--   -- expect both definitions to include stripe_livemode.
--
--   select session_id, stripe_livemode, count(*)
--   from public.payment_charge_attempts
--   where charge_reason = 'session_payment'
--     and session_id is not null
--     and status in ('ready', 'pending_stripe', 'succeeded')
--   group by 1,2 having count(*) > 1;
--   -- expect: zero rows.
--
--   select appointment_id, charge_reason, stripe_livemode, count(*)
--   from public.payment_charge_attempts
--   where appointment_id is not null
--     and charge_reason in ('late_cancellation_fee', 'no_show_fee')
--     and status in ('ready', 'pending_stripe', 'succeeded')
--   group by 1,2,3 having count(*) > 1;
--   -- expect: zero rows.
