-- REHEARSAL - NEVER MERGE. Synthetic rows at the 0246 chain for the gap-pending read v2.
\ir seed-lib.sql
-- FK targets are random uuids: session_replication_role = replica skips FKs and triggers.
-- "old" rows are 30 h old (outside the 24 h lookback); "mid" rows are 10 h old (inside it; outside v1's 6 h).
-- ---- payment_charge_attempts: captured-but-pending charges
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_1'));
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b2', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_2'));
-- mid: 10 h old pending charge now counts (v1 would not)
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b3', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_3', 'created_at', (now() - interval '10 hours')::text, 'updated_at', (now() - interval '10 hours')::text));
-- old: 30 h old pending charge does not count
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b4', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_4', 'created_at', (now() - interval '30 hours')::text, 'updated_at', (now() - interval '30 hours')::text));
-- ---- payment_charge_attempts: session-payment refunds
-- r1: refund requested, no provider status yet
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000c1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_r1', 'refund_status', 'pending_stripe'));
-- r2: pending locally and pending at the provider
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000c2', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_r2', 'refund_status', 'pending_stripe', 'stripe_refund_status', 'pending'));
-- r3: provider says requires_action (local status already failed): counted only by the provider-status row
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000c3', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_r3', 'refund_status', 'failed', 'stripe_refund_status', 'requires_action'));
-- r4 clean: refunded
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000c4', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_r4', 'refund_status', 'succeeded', 'stripe_refund_status', 'succeeded'));
-- r5 old: a 30 h old pending refund does not count
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000c5', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_r5', 'refund_status', 'pending_stripe', 'stripe_refund_status', 'pending', 'created_at', (now() - interval '30 hours')::text, 'updated_at', (now() - interval '30 hours')::text));
-- ---- the eight rows that never counted a row before: one counted row each, plus a terminal row that must not count
select pg_temp.ins('manual_fee_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_type', 'no_show', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe'));
select pg_temp.ins('manual_fee_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_type', 'no_show', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded'));
select pg_temp.ins('stripe_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'status', 'pending', 'idempotency_key', 'k_sca_1'));
select pg_temp.ins('stripe_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'status', 'failed', 'idempotency_key', 'k_sca_2'));
select pg_temp.ins('stripe_refund_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending', 'idempotency_key', 'k_sra_1'));
select pg_temp.ins('stripe_refund_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'idempotency_key', 'k_sra_2'));
select pg_temp.ins('stripe_refunds', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'currency', 'cad', 'source', 'stripe_dashboard_observed', 'status', 'pending', 'stripe_refund_id', 're_1'));
select pg_temp.ins('stripe_refunds', jsonb_build_object('studio_id', pg_temp.sid(1), 'amount_cents', 5000, 'currency', 'cad', 'source', 'stripe_dashboard_observed', 'status', 'succeeded', 'stripe_refund_id', 're_2'));
select pg_temp.ins('appointment_payments', jsonb_build_object('studio_id', pg_temp.sid(1), 'payment_status', 'reconciliation_required', 'stripe_setup_intent_id', 'seti_ap1'));
select pg_temp.ins('appointment_payments', jsonb_build_object('studio_id', pg_temp.sid(1), 'payment_status', 'charged', 'stripe_setup_intent_id', 'seti_ap2'));
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'pending', 'idempotency_key', 'k_sap_1'));
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(2), 'status', 'succeeded', 'idempotency_key', 'k_sap_2'));
select pg_temp.ins('stripe_customer_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'pending', 'idempotency_key', 'k_scp_1'));
select pg_temp.ins('stripe_customer_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'succeeded', 'idempotency_key', 'k_scp_2'));
select pg_temp.ins('client_payment_methods', jsonb_build_object('studio_id', pg_temp.sid(1), 'brand', 'visa', 'last4', '4242', 'exp_month', 1, 'exp_year', 2030, 'stripe_payment_method_id', 'pm_1', 'stripe_setup_intent_id', 'seti_pm1'));
select pg_temp.ins('client_payment_methods', jsonb_build_object('studio_id', pg_temp.sid(1), 'brand', 'visa', 'last4', '4242', 'exp_month', 1, 'exp_year', 2030, 'status', 'removed', 'removed_at', now()::text, 'stripe_payment_method_id', 'pm_2', 'stripe_setup_intent_id', 'seti_pm2'));
-- ---- (2) a card setup without a saved method: setup intent created, never finalized
select pg_temp.ins('pending_booking_payment_sessions', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'setup_intent_created', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'stripe_customer_id', 'cus_1', 'stripe_setup_intent_id', 'seti_1', 'requested_duration_minutes', 30, 'requested_starts_at', (now() + interval '1 day')::text, 'requested_ends_at', (now() + interval '1 day 30 minutes')::text));
-- ---- (3) stripe_events: claimed, handler threw (error), released claim, not processed
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_1', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processing_attempt_count', 1, 'error', 'handler returned 500'));
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_2', 'event_type', 'setup_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processing_attempt_count', 2, 'error', 'handler returned 500'));
-- received, never claimed (not processed, no claim, no error)
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_3', 'event_type', 'account.updated', 'stripe_account_id', 'acct_W', 'stripe_livemode', true));
-- clean: processed
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_4', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processed_at', now()::text));
-- old: 30 h old unprocessed event does not count
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_5', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'created_at', (now() - interval '30 hours')::text));
-- mid: 10 h old attempted-with-error charge event counts under 24 h
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_6', 'event_type', 'charge.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'created_at', (now() - interval '10 hours')::text, 'processing_started_at', (now() - interval '10 hours')::text, 'processing_attempt_count', 3, 'error', 'handler returned 500'));
