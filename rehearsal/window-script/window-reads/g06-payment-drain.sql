-- ===========================================================================
-- GATE G6: payment / queued-work drain, D1-D4 (S0a window read; rollout 0213-0246)
-- Source: general/1035-ROWS-PAYMENT.md section 8 "G6-D", PRE-0245 form as the
-- decision package A1 requires ("drop its last column before 0245"): the
-- post-0245 column client_payment_methods.stripe_setup_success_event_id does
-- not exist at hosted 0212 and is replaced by an info-only total.
-- Package: A4 "Queued payment work", Part II section 6 G6.
--
-- RUN ONLY VIA: run-window-read.sh g06-payment-drain.sql, AT THE WINDOW
-- (a read from hours earlier does not stand in for this gate).
-- One SELECT, counts only: no ids, names, emails or amounts. No writes.
-- PRE-APPLY ONLY: chain_guard raises "division by zero" unless the history
-- max is 0212. The S4 re-run after 0245 is General's original post-0245 form.
--
-- EXPECTED PASS: every d1_*, d2_*, d3_*, d4_* column = 0. at_hosted_0212 = 1.
--   info_* columns are receipt information, not gates.
-- STOP CONDITION:
--   d1_pending_unbindable > 0 : guaranteed strand after 0239; resolve BEFORE S1.
--   any other d1_/d2_/d3_/d4_ > 0 : do not start S1 until each row is listed
--     privately (never in a handoff file) and dispositioned by the payment owner.
--   chain_guard error: hosted history is not at 0212; run G2 and stop.
-- D5 (open SetupIntents) cannot be counted from the DB: D3 + the quiet window.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
)
select
  g.at_hosted_0212,
  (select count(*) from public.payment_charge_attempts where status = 'ready')                                   as d1_ready,
  (select count(*) from public.payment_charge_attempts where status = 'pending_stripe')                          as d1_pending_stripe,
  (select count(*) from public.payment_charge_attempts where status = 'pending_stripe'
      and (stripe_payment_intent_id is null or stripe_customer_id is null))                                       as d1_pending_unbindable,
  (select count(*) from public.payment_charge_attempts where refund_status = 'pending_stripe')                   as d2_refund_pending,
  (select count(*) from public.stripe_events where processed_at is null and processing_claim_token is not null
      and (event_type like 'payment_intent.%' or event_type = 'charge.refunded' or event_type like 'refund.%' or event_type like 'setup_intent.%')) as d3_claimed_inflight,
  (select count(*) from public.stripe_events where processed_at is null and processing_claim_token is null
      and (event_type like 'payment_intent.%' or event_type = 'charge.refunded' or event_type like 'refund.%' or event_type like 'setup_intent.%')) as d3_unprocessed_unclaimed,
  (select count(*) from public.stripe_events where processed_at is null and error is not null)                   as d3_errored_any_type,
  (select count(*) from public.stripe_account_provisioning_attempts where status in ('pending','processing'))   as d4_account_provisioning_open,
  (select count(*) from public.stripe_customer_provisioning_attempts where status in ('pending','processing'))  as d4_customer_provisioning_open,
  (select count(*) from public.payment_charge_attempts where receipt_status = 'sending')                         as info_receipt_sending,
  (select count(*) from public.client_payment_methods)                                                           as info_saved_cards_total_pre_0245
from chain_guard g;
