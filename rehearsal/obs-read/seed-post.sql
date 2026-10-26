-- REHEARSAL - NEVER MERGE. Synthetic data at the 0246 chain (post-S3 read).
\ir seed-lib.sql
select pg_temp.ins('studios', jsonb_build_object('id', pg_temp.sid(i), 'name', 'Studio ' || i, 'owner_email', 'o' || i || '@example.test', 'created_at', ('2026-01-0' || i || 'T00:00:00Z')))
from generate_series(1, 7) i;
-- ordinal 1 live bound account observed CA/cad, with a jurisdiction row; plus a test-mode account (ignored)
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(1), 'stripe_account_id', 'acct_W', 'stripe_livemode', true, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true, 'stripe_account_country', 'CA', 'stripe_account_default_currency', 'cad', 'stripe_account_observed_at', now()::text));
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(1), 'stripe_account_id', 'acct_Wtest', 'stripe_livemode', false, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true, 'stripe_account_country', 'CA', 'stripe_account_default_currency', 'cad', 'stripe_account_observed_at', now()::text));
select pg_temp.ins('studio_payment_jurisdictions', jsonb_build_object('studio_id', pg_temp.sid(1), 'payment_country', 'CA', 'payment_currency', 'cad', 'source', 'operator', 'verification_reference', 'ref'));
-- ordinal 7 live bound account, NOT observed, no jurisdiction row
select pg_temp.ins('studio_payment_settings', jsonb_build_object('studio_id', pg_temp.sid(7), 'stripe_account_id', 'acct_S', 'stripe_livemode', true, 'stripe_account_status', 'enabled', 'stripe_charges_enabled', true, 'stripe_payouts_enabled', true));
