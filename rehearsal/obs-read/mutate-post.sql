set session_replication_role = replica;
-- ordinal 1 becomes observed NON-CA (US/usd); ordinal 7 becomes observed CA with a recorded conflict
update public.studio_payment_settings set stripe_account_country = 'US', stripe_account_default_currency = 'usd' where studio_id = '00000000-0000-0000-0000-000000000001' and stripe_livemode = true;
update public.studio_payment_settings set stripe_account_country = 'CA', stripe_account_default_currency = 'cad', stripe_account_observed_at = now(), stripe_account_country_conflict = 'US', stripe_account_country_conflict_at = now() where studio_id = '00000000-0000-0000-0000-000000000007';
