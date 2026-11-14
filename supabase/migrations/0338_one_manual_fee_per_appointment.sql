-- 0338 — ONE manual fee per appointment, across BOTH fee types, enforced by the database
-- (Sam's standard, 12 Nov 2026: "Do not treat 'no migration' as a reason to accept weaker duplicate-charge protection."
-- Insurance final631: an application check cannot close the cross-type race). DRAFT: not applied, not reviewed.
--
-- WHAT THIS DOES. One partial UNIQUE index on payment_charge_attempts (appointment_id, stripe_livemode) over the two fee
-- reasons. Two fee attempts of DIFFERENT types for the same appointment and mode can no longer both be in the active or
-- collected set: the second insert (or the second status transition into the set) raises 23505, whatever the order and however
-- the two requests interleave. The 0105 index (appointment_id, charge_reason, stripe_livemode) stays: it is the same-type rule.
--
-- THE SET, classified (payment_charge_attempts.status CHECK, 0073: ready, blocked, cancelled, pending_stripe, succeeded, failed):
--   ready           IN  (prepared; owner has not charged yet)
--   pending_stripe  IN  (in flight, or UNCLEAR after the window: the same status, so the index cannot tell them apart and holds both)
--   succeeded       IN  (collected; a REFUNDED fee is still status 'succeeded' with refund_* columns, so it is covered)
--   failed          OUT (a definite refusal; frees the appointment)
--   cancelled       OUT (withdrawn before charging; frees the appointment)
--   blocked         OUT (reserved terminal status, never written by application code; the runner and settlement treat it as terminal non-success)
-- NOT in the index, by design: a failed attempt with failure_code 'requires_action_canceled' (needs the client's action). The
-- PaymentIntent was cancelled and nothing was taken, so there is no financial effect for the database to prevent; the APPLICATION
-- keeps treating it as holding the appointment (Sam's rule), and that refusal is not race-sensitive because no money moved.
--
-- WHAT IT DOES NOT TOUCH. No data is written or deleted. No column, trigger, policy, grant or function changes. session_payment
-- rows are outside the predicate. Test-mode and live-mode rows are independent (stripe_livemode is in the key).
--
-- FAIL-CLOSED PRE-CHECK. If any appointment already holds more than one row in the predicate (for example test-mode fees from
-- before the one-fee rule), the index could not be built; the block below raises a plain message listing the COUNT and stops the
-- transaction, so nothing changes. Run the hosted duplicate scan (read-only) before applying: expect zero.
--
-- LOCKING. CREATE UNIQUE INDEX takes a SHARE lock on payment_charge_attempts for the build: writes wait, reads continue. The table
-- is small (fee and session payment attempts only); the scan read prints its row count. lock_timeout bounds the wait to GET the lock.
-- Rollback is the down file (drops the index only); an approved rollback re-opens the cross-type race.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes from (
    select appointment_id, stripe_livemode
      from public.payment_charge_attempts
     where appointment_id is not null
       and charge_reason in ('late_cancellation_fee', 'no_show_fee')
       and status in ('ready', 'pending_stripe', 'succeeded')
     group by appointment_id, stripe_livemode
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception '0338: % appointment(s) already hold more than one active or collected manual fee; resolve them before applying', v_dupes;
  end if;
end
$$;

create unique index payment_charge_attempts_one_fee_per_appointment_uniq
  on public.payment_charge_attempts (appointment_id, stripe_livemode)
  where appointment_id is not null
    and charge_reason in ('late_cancellation_fee', 'no_show_fee')
    and status in ('ready', 'pending_stripe', 'succeeded');

comment on index public.payment_charge_attempts_one_fee_per_appointment_uniq is
  '0338: at most one active or collected manual fee (late_cancellation_fee or no_show_fee) per appointment and mode, across both types. Failed and cancelled attempts free the appointment; a refunded fee is still succeeded and still holds it.';

commit;
