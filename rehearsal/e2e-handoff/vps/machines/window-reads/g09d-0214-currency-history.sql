-- ===========================================================================
-- GATE G9d: 0214 history-initialization PREDICTION per studio ordinal (S0a
-- window read). Predicts what initialize_studio_payment_jurisdiction_from_history
-- (A's a8bdcefe 0214, or the unamended 0214 plus 0257) would return for each
-- studio, for each of the two pairs it accepts, from the studio's existing rows.
--
-- RUN ONLY VIA: run-window-read.sh g09d-0214-currency-history.sql
-- One SELECT, counts and booleans only. The ordinal is row_number() over
-- (created_at, id), the same as g09b; NO studio id or name is returned. Every
-- table and column used exists at hosted 0212 (the chain guard below stops the
-- read at any other history).
--
-- THE PREDICATE, copied from the command body (supabase/migrations/
-- 0257_payment_jurisdiction_history_init.sql; the same text is in the amended
-- 0214), in the command's own order:
--   lines 211-219  c_money_universe (the pinned table list)      -> unlisted_money_table_present
--   lines 266-282  refused_unlisted_money_table                  -> same catalog query
--   lines 283-290  refused_unverifiable_history: any appointment_payments or
--                  pending_booking_payment_sessions row          -> *_rows below
--   lines 291-311  refused_currency_history: any row of the 8 checked tables
--                  whose currency IS DISTINCT FROM the pair's currency; a NULL
--                  currency is distinct, so it refuses either pair
--                                                                 -> <t>_rows / _null / _non_cad / _non_usd
--   lines 312-322  refused_account_mismatch: needs an OBSERVED country; none exists at 0212, so never
--   lines 323-344  refused_account_unverified: a live-or-unknown-mode bound
--                  account (nothing is observed before 0214), a named live/unknown row, or a
--                  named test row whose account is not the studio's bound test account
--   lines 345-370  test-mode acknowledgement (bound test accounts / unbound test attempts)
--   lines 371-386  prices (services, client_pricing, studio fees, sessions)
--
-- predicted_ca_cad / predicted_us_usd (first refusal in that order):
--   refused_unlisted_money_table | refused_unverifiable_history |
--   refused_currency_history | refused_account_unverified | needs_ack | initializable
-- needs_ack = the command would refuse until the operator acknowledges prices or
-- lists the exact test-mode accounts/attempts (refused_priced_configuration or
-- refused_test_account_unobserved). initializable = the command would initialize
-- with those acknowledgements given as needed. Outside this prediction: an
-- observed country that disagrees (only exists after 0214).
--
-- NULL-CURRENCY HISTORY NEVER INITIALIZES: any <t>_null above 0 makes BOTH pairs
-- refused_currency_history, permanently, because the command never infers a currency.
--
-- EXPECTED: a row count equal to g09b's. No pass value is asserted: this read
-- exists to find out. STOP CONDITION: chain_guard error (history not at 0212):
-- run G2 and stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
s as (
  select st.id, row_number() over (order by st.created_at, st.id) as studio_ordinal
  from public.studios st
),
unlisted as (
  select exists (
    select 1 from pg_catalog.pg_class k
    join pg_catalog.pg_namespace n on n.oid = k.relnamespace
    where n.nspname = 'public' and k.relkind in ('r', 'p')
      and not (k.relname::text = any (array['appointment_payments', 'appointment_settlements', 'client_payment_methods', 'client_pricing', 'client_stripe_customers', 'manual_fee_charge_attempts', 'payment_charge_attempts', 'payment_recovery_tokens', 'pending_booking_payment_sessions', 'services', 'sessions', 'stripe_account_provisioning_attempts', 'stripe_charge_attempts', 'stripe_customer_provisioning_attempts', 'stripe_disputes', 'stripe_events', 'stripe_payment_audit', 'stripe_refund_attempts', 'stripe_refunds', 'studio_payment_settings', 'studios']))
      and exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = k.oid and a.attnum > 0 and not a.attisdropped
                     and (a.attname in ('currency', 'stripe_account_id')
                          or a.attname::text like '%\_cents' escape '\'))
  ) as unlisted_money_table_present
),
c as (
  select
    s.studio_ordinal,
    (select count(*) from public.payment_charge_attempts x where x.studio_id = s.id) as pca_rows,
    (select count(*) from public.payment_charge_attempts x where x.studio_id = s.id and x.currency is null) as pca_null,
    (select count(*) from public.payment_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'cad') as pca_non_cad,
    (select count(*) from public.payment_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'usd') as pca_non_usd,
    (select count(*) from public.appointment_settlements x where x.studio_id = s.id) as aps_rows,
    (select count(*) from public.appointment_settlements x where x.studio_id = s.id and x.currency is null) as aps_null,
    (select count(*) from public.appointment_settlements x where x.studio_id = s.id and x.currency is distinct from 'cad') as aps_non_cad,
    (select count(*) from public.appointment_settlements x where x.studio_id = s.id and x.currency is distinct from 'usd') as aps_non_usd,
    (select count(*) from public.manual_fee_charge_attempts x where x.studio_id = s.id) as mfa_rows,
    (select count(*) from public.manual_fee_charge_attempts x where x.studio_id = s.id and x.currency is null) as mfa_null,
    (select count(*) from public.manual_fee_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'cad') as mfa_non_cad,
    (select count(*) from public.manual_fee_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'usd') as mfa_non_usd,
    (select count(*) from public.stripe_charge_attempts x where x.studio_id = s.id) as sca_rows,
    (select count(*) from public.stripe_charge_attempts x where x.studio_id = s.id and x.currency is null) as sca_null,
    (select count(*) from public.stripe_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'cad') as sca_non_cad,
    (select count(*) from public.stripe_charge_attempts x where x.studio_id = s.id and x.currency is distinct from 'usd') as sca_non_usd,
    (select count(*) from public.stripe_refunds x where x.studio_id = s.id) as srf_rows,
    (select count(*) from public.stripe_refunds x where x.studio_id = s.id and x.currency is null) as srf_null,
    (select count(*) from public.stripe_refunds x where x.studio_id = s.id and x.currency is distinct from 'cad') as srf_non_cad,
    (select count(*) from public.stripe_refunds x where x.studio_id = s.id and x.currency is distinct from 'usd') as srf_non_usd,
    (select count(*) from public.stripe_refund_attempts x where x.studio_id = s.id) as sra_rows,
    (select count(*) from public.stripe_refund_attempts x where x.studio_id = s.id and x.currency is null) as sra_null,
    (select count(*) from public.stripe_refund_attempts x where x.studio_id = s.id and x.currency is distinct from 'cad') as sra_non_cad,
    (select count(*) from public.stripe_refund_attempts x where x.studio_id = s.id and x.currency is distinct from 'usd') as sra_non_usd,
    (select count(*) from public.stripe_disputes x where x.studio_id = s.id) as sdp_rows,
    (select count(*) from public.stripe_disputes x where x.studio_id = s.id and x.currency is null) as sdp_null,
    (select count(*) from public.stripe_disputes x where x.studio_id = s.id and x.currency is distinct from 'cad') as sdp_non_cad,
    (select count(*) from public.stripe_disputes x where x.studio_id = s.id and x.currency is distinct from 'usd') as sdp_non_usd,
    (select count(*) from public.stripe_payment_audit x where x.studio_id = s.id) as spa_rows,
    (select count(*) from public.stripe_payment_audit x where x.studio_id = s.id and x.currency is null) as spa_null,
    (select count(*) from public.stripe_payment_audit x where x.studio_id = s.id and x.currency is distinct from 'cad') as spa_non_cad,
    (select count(*) from public.stripe_payment_audit x where x.studio_id = s.id and x.currency is distinct from 'usd') as spa_non_usd,
    (select count(*) from public.appointment_payments ap where ap.studio_id = s.id) as appointment_payment_rows,
    (select count(*) from public.pending_booking_payment_sessions ps where ps.studio_id = s.id) as pending_booking_payment_rows,
    (select count(*) from public.studio_payment_settings p where p.studio_id = s.id and p.stripe_account_id is not null and p.stripe_livemode is distinct from false) as live_bound_account_rows,
    (select count(*) from public.studio_payment_settings p where p.studio_id = s.id and p.stripe_account_id is not null and p.stripe_livemode = false) as test_bound_account_rows,
    (select count(*) from public.stripe_account_provisioning_attempts a where a.studio_id = s.id and a.stripe_livemode = false and a.stripe_account_id is null) as unbound_test_attempt_rows,
    ( exists (
        select 1 from (
    select a.stripe_account_id, a.stripe_livemode, true as is_attempt from public.stripe_account_provisioning_attempts a where a.studio_id = s.id
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.client_payment_methods x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.client_stripe_customers x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.payment_charge_attempts x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.manual_fee_charge_attempts x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_charge_attempts x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_refunds x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_refund_attempts x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_disputes x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_payment_audit x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.payment_recovery_tokens x where x.studio_id = s.id and x.stripe_account_id is not null
    union all
    select x.stripe_account_id, x.stripe_livemode, false from public.stripe_customer_provisioning_attempts x where x.studio_id = s.id and x.stripe_account_id is not null
        ) r
        where r.stripe_livemode is distinct from false
           or (r.stripe_account_id is not null and r.stripe_livemode = false
               and not exists (select 1 from public.studio_payment_settings p2
                                where p2.studio_id = s.id and p2.stripe_account_id = r.stripe_account_id
                                  and p2.stripe_livemode = false))
           or (r.stripe_account_id is null and not r.is_attempt)
    ) ) as named_account_unverified,
    ( exists (select 1 from public.services sv where sv.studio_id = s.id and coalesce(sv.price_cents, 0) > 0)
      or exists (select 1 from public.client_pricing cp where cp.studio_id = s.id)
      or exists (select 1 from public.studios z where z.id = s.id and (coalesce(z.late_cancel_fee_cents, 0) > 0 or coalesce(z.no_show_fee_cents, 0) > 0))
      or exists (select 1 from public.sessions se where se.studio_id = s.id and se.price_paid_cents is not null) ) as needs_ack_prices
  from s
),
p as (
  select c.*, u.unlisted_money_table_present,
    (c.appointment_payment_rows + c.pending_booking_payment_rows) > 0 as unverifiable_history,
    (c.pca_non_cad + c.aps_non_cad + c.mfa_non_cad + c.sca_non_cad + c.srf_non_cad + c.sra_non_cad + c.sdp_non_cad + c.spa_non_cad) > 0 as currency_blocks_cad,
    (c.pca_non_usd + c.aps_non_usd + c.mfa_non_usd + c.sca_non_usd + c.srf_non_usd + c.sra_non_usd + c.sdp_non_usd + c.spa_non_usd) > 0 as currency_blocks_usd,
    (c.pca_null + c.aps_null + c.mfa_null + c.sca_null + c.srf_null + c.sra_null + c.sdp_null + c.spa_null) > 0 as any_null_currency_row,
    (c.live_bound_account_rows > 0 or c.named_account_unverified) as account_unverified,
    (c.test_bound_account_rows > 0 or c.unbound_test_attempt_rows > 0 or c.needs_ack_prices) as ack_needed
  from c cross join unlisted u
)
select
  g.at_hosted_0212,
  p.*,
  case when p.unlisted_money_table_present then 'refused_unlisted_money_table'
       when p.unverifiable_history then 'refused_unverifiable_history'
       when p.currency_blocks_cad then 'refused_currency_history'
       when p.account_unverified then 'refused_account_unverified'
       when p.ack_needed then 'needs_ack'
       else 'initializable' end as predicted_ca_cad,
  case when p.unlisted_money_table_present then 'refused_unlisted_money_table'
       when p.unverifiable_history then 'refused_unverifiable_history'
       when p.currency_blocks_usd then 'refused_currency_history'
       when p.account_unverified then 'refused_account_unverified'
       when p.ack_needed then 'needs_ack'
       else 'initializable' end as predicted_us_usd
from chain_guard g cross join p
order by p.studio_ordinal;
