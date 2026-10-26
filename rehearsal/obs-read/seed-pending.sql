-- REHEARSAL - NEVER MERGE. Synthetic rows at the 0246 chain for the gap-pending read.
\ir seed-lib.sql
-- FK targets are random uuids: session_replication_role = replica skips FKs and triggers
-- (1) captured-but-pending charge (pending_stripe with a PaymentIntent), in the lookback
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_1'));
-- clean rows: a succeeded charge, and a pending_stripe charge OLDER than the lookback (must not count)
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b2', 'amount_cents', 5000, 'currency', 'cad', 'status', 'succeeded', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_2'));
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000b3', 'amount_cents', 5000, 'currency', 'cad', 'status', 'pending_stripe', 'stripe_livemode', true, 'stripe_account_id', 'acct_W', 'stripe_payment_intent_id', 'pi_3', 'created_at', (now() - interval '10 hours')::text, 'updated_at', (now() - interval '10 hours')::text));
-- (2) a card setup without a saved method: setup intent created, never finalized
select pg_temp.ins('pending_booking_payment_sessions', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'setup_intent_created', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'stripe_customer_id', 'cus_1', 'stripe_setup_intent_id', 'seti_1'));
-- (3) retained stripe_events: claimed, handler threw (error), not processed
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_1', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processing_claim_token', gen_random_uuid()::text, 'processing_attempt_count', 1, 'error', 'handler returned 500'));
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_2', 'event_type', 'setup_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processing_claim_token', gen_random_uuid()::text, 'processing_attempt_count', 2, 'error', 'handler returned 500'));
-- received, never claimed (not processed, no claim, no error)
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_3', 'event_type', 'account.updated', 'stripe_account_id', 'acct_W', 'stripe_livemode', true));
-- clean: processed; and an old unprocessed event outside the lookback
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_4', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'processing_started_at', now()::text, 'processed_at', now()::text));
select pg_temp.ins('stripe_events', jsonb_build_object('stripe_event_id', 'evt_5', 'event_type', 'payment_intent.succeeded', 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'created_at', (now() - interval '10 hours')::text));
