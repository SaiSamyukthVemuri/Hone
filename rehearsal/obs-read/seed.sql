-- REHEARSAL - NEVER MERGE. Synthetic data on a throwaway CI database at the 0212 chain. Never a production read.
\ir seed-lib.sql
select pg_temp.ins('studios', jsonb_build_object('id', pg_temp.sid(i), 'name', 'Studio ' || i, 'owner_email', 'o' || i || '@example.test', 'created_at', ('2026-01-0' || i || 'T00:00:00Z')))
from generate_series(1, 7) i;

-- bound accounts: ordinal 1 live acct_W (+ a test-mode one), ordinal 7 live acct_S
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(1), 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true));
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(1), 'stripe_account_id', 'acct_Wtest', 'stripe_livemode', false, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true));
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(7), 'stripe_account_id', 'acct_S', 'stripe_livemode', true, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true));

-- provisioning attempts
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'failed', 'idempotency_key', 'k1', 'stripe_account_id', 'acct_W', 'stripe_livemode', true));
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'failed', 'idempotency_key', 'k2', 'stripe_account_id', null, 'stripe_livemode', true));   -- live, no account id: never satisfiable
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'status', 'failed', 'idempotency_key', 'k3', 'stripe_account_id', null, 'stripe_livemode', false));  -- test mode: not counted
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(7), 'status', 'failed', 'idempotency_key', 'k4', 'stripe_account_id', 'acct_other', 'stripe_livemode', true)); -- names another account
select pg_temp.ins('stripe_account_provisioning_attempts', jsonb_build_object('studio_id', pg_temp.sid(2), 'status', 'failed', 'idempotency_key', 'k5', 'stripe_account_id', null, 'stripe_livemode', true));   -- ordinal 2: never read

-- charge attempts
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000a1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'ready', 'stripe_livemode', true, 'stripe_account_id', 'acct_W'));
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(1), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000a1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'ready', 'stripe_livemode', false, 'stripe_account_id', 'acct_Wtest'));
select pg_temp.ins('payment_charge_attempts', jsonb_build_object('studio_id', pg_temp.sid(7), 'charge_reason', 'no_show_fee', 'appointment_id', '00000000-0000-0000-0000-0000000000a1', 'amount_cents', 5000, 'currency', 'cad', 'status', 'ready', 'stripe_livemode', true, 'stripe_account_id', 'acct_S'));

-- unknown-mode (null) customer on a live-bound account: the initializer treats unknown like live and needs an unknown-mode bound row, so this is unbound
select pg_temp.ins('client_stripe_customers', jsonb_build_object('studio_id', pg_temp.sid(7), 'stripe_account_id', 'acct_S', 'stripe_livemode', null));
