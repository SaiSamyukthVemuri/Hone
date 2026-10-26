set session_replication_role = replica;
delete from public.stripe_account_provisioning_attempts where idempotency_key in ('k2', 'k4');
delete from public.client_stripe_customers where studio_id = '00000000-0000-0000-0000-000000000007';
