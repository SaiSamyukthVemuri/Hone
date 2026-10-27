-- ===========================================================================
-- GAP-PENDING READ v2, POST-S3 (count-only): payment and card-setup rows the old app
-- (7610fd70) may have left unreconciled while it served a 0246 database between
-- S1 and S3. Source of the failure: Team BOLD-FULL-COMPAT (#1188): 0239 removed
-- service_role EXECUTE on reconcile_card_payment_succeeded, so the old webhook
-- throws, Stripe retries, and the attempt stays pending_stripe although the charge
-- exists at Stripe; 0245 did the same to save_client_card_on_file, so a card the
-- client entered is not saved. Both end as a stripe_events row received but not
-- processed. On a handler throw the claim is RELEASED (release_stripe_event_claim_
-- with_error clears the claim token and sets error), so the event can be re-claimed
-- at once: read 'attempted' as "tried and failed", and 'with_error' as the replay signal.
--
-- Changes from v1 (ee055dcf): (1) two session-payment refund rows (19 rows, was 17);
-- (2) lookback 24 hours (was 6); (3) received_not_processed_claimed_retained renamed
-- received_not_processed_attempted (same predicate); (4) stripe_refund_status is read
-- through to_jsonb(x) so that, on a database that lacks the column (0240 not applied,
-- e.g. 0212), the chain guard raises first instead of a missing-column error.
--
-- RUN ONLY VIA: run-window-read-macos.sh obs-1035-gap-pending-payments-v2.sql, from a
-- directory whose MANIFEST.sha256 lists it (window-reads-obs).
-- One SELECT, counts only. NO id, amount, account, name or message is returned.
-- Parameterized by NOTHING: the lookback is fixed at 24 hours, applied to
-- greatest(created_at, updated_at) (stripe_events: created_at or processing start).
-- Chain guard: refuses unless the history max is 0246 (it runs after S1).
--
-- Rows (src, state), always all of them, a zero is a row: 19 expected.
-- States named *_informational are context, not findings.
-- NOT COUNTED HERE: client archive/unarchive audit-row loss (a missing row, not a
-- pending row); export refusals (clean refusal, no state); anything older than 24 hours;
-- a status added after 0246.
-- STOP CONDITION: any row count other than 19, or a chain guard error (history max
--   is not 0246: run G2 and stop).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
counts as (
  select 'payment_charge_attempts' as src, 'pending_stripe' as state, count(*) as rows_in_lookback from public.payment_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status = 'pending_stripe' union all
  select 'payment_charge_attempts' as src, 'pending_stripe_with_payment_intent' as state, count(*) as rows_in_lookback from public.payment_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status = 'pending_stripe' and x.stripe_payment_intent_id is not null union all
  select 'payment_charge_attempts' as src, 'refund_pending_stripe' as state, count(*) as rows_in_lookback from public.payment_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.refund_status = 'pending_stripe' union all
  select 'payment_charge_attempts' as src, 'provider_refund_pending_or_requires_action' as state, count(*) as rows_in_lookback from public.payment_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and to_jsonb(x) ->> 'stripe_refund_status' in ('pending', 'requires_action') union all
  select 'manual_fee_charge_attempts' as src, 'pending_stripe' as state, count(*) as rows_in_lookback from public.manual_fee_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status = 'pending_stripe' union all
  select 'stripe_charge_attempts' as src, 'pending_processing_or_authentication_required' as state, count(*) as rows_in_lookback from public.stripe_charge_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'processing', 'authentication_required') union all
  select 'stripe_refund_attempts' as src, 'pending_processing_or_requires_action' as state, count(*) as rows_in_lookback from public.stripe_refund_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'processing', 'requires_action') union all
  select 'stripe_refunds' as src, 'pending_or_requires_action' as state, count(*) as rows_in_lookback from public.stripe_refunds x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'requires_action') union all
  select 'appointment_payments' as src, 'authentication_required_reconciliation_required_or_double_charged' as state, count(*) as rows_in_lookback from public.appointment_payments x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.payment_status in ('authentication_required', 'reconciliation_required', 'double_charged') union all
  select 'pending_booking_payment_sessions' as src, 'card_setup_not_finalized' as state, count(*) as rows_in_lookback from public.pending_booking_payment_sessions x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'consent_recorded', 'setup_intent_created', 'payment_method_saved_pending_finalization', 'finalization_failed', 'cleanup_required') union all
  select 'stripe_account_provisioning_attempts' as src, 'pending_or_processing' as state, count(*) as rows_in_lookback from public.stripe_account_provisioning_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'processing') union all
  select 'stripe_customer_provisioning_attempts' as src, 'pending_or_processing' as state, count(*) as rows_in_lookback from public.stripe_customer_provisioning_attempts x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status in ('pending', 'processing') union all
  select 'client_payment_methods' as src, 'saved_in_lookback_informational' as state, count(*) as rows_in_lookback from public.client_payment_methods x where greatest(x.created_at, x.updated_at) >= now() - interval '24 hours' and x.status = 'active' union all
  select 'stripe_events' as src, 'received_total_informational' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and true union all
  select 'stripe_events' as src, 'received_not_processed' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and x.processed_at is null union all
  select 'stripe_events' as src, 'received_not_processed_attempted' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and x.processed_at is null and x.processing_started_at is not null union all
  select 'stripe_events' as src, 'received_not_processed_with_error' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and x.processed_at is null and x.error is not null union all
  select 'stripe_events' as src, 'received_not_processed_setup_intent' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and x.processed_at is null and x.event_type like 'setup_intent.%' union all
  select 'stripe_events' as src, 'received_not_processed_payment_intent_or_charge' as state, count(*) as rows_in_lookback from public.stripe_events x where greatest(x.created_at, coalesce(x.processing_started_at, x.created_at)) >= now() - interval '24 hours' and x.processed_at is null and (x.event_type like 'payment_intent.%' or x.event_type like 'charge.%')
)
select g.at_hosted_0246, c.src, c.state, c.rows_in_lookback
from chain_guard g
cross join counts c
order by c.src, c.state;
