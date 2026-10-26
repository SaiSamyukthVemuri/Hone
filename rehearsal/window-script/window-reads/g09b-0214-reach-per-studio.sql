-- ===========================================================================
-- GATE G9 (per-studio form): 0214 setter reach by creation ordinal (S0a window
-- read; re-run of 01-ops/1035-G9-CENSUS-20261023.txt)
-- Source: general/1035-ROWS-PAYMENT.md section 8 "G9", verbatim count columns
-- and needs_ack_prices, plus a derived r2a_reachable column (all ten counts 0).
--
-- RUN ONLY VIA: run-window-read.sh g09b-0214-reach-per-studio.sql
-- One SELECT, counts and booleans only. The ordinal is row_number() over
-- (created_at, id); NO studio id or name is returned. OPS maps ordinals to
-- studios privately at S2, never in a handoff file.
--
-- EXPECTED PASS (19:00Z census): 7 rows; r2a_reachable true for ordinals 2, 4, 5
--   only; needs_ack_prices false for 2, 4, 5 and true for 1, 3, 6, 7;
--   at_hosted_0212 = 1 on every row.
-- STOP CONDITION: a different row count (ordinals may have shifted: re-map
--   privately before S2), or any change in r2a_reachable / needs_ack_prices
--   against the census. Do not issue any S2 write for a changed ordinal until
--   OPS re-derives it. chain_guard error: history not at 0212; run G2 and stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
s as (
  select st.id, row_number() over (order by st.created_at, st.id) as studio_ordinal
  from public.studios st
),
c as (
  select
    s.studio_ordinal,
    (select count(*) from public.stripe_account_provisioning_attempts a where a.studio_id = s.id)                       as acct_provisioning_rows,
    (select count(*) from public.studio_payment_settings p where p.studio_id = s.id and p.stripe_account_id is not null) as bound_account_rows,
    (select count(*) from public.client_payment_methods m where m.studio_id = s.id)                                     as saved_card_rows,
    (select count(*) from public.client_stripe_customers cs where cs.studio_id = s.id)                                  as stripe_customer_rows,
    (select count(*) from public.payment_charge_attempts x where x.studio_id = s.id)                                    as charge_attempt_rows,
    (select count(*) from public.appointment_settlements t where t.studio_id = s.id)                                    as settlement_rows,
    (select count(*) from public.manual_fee_charge_attempts f where f.studio_id = s.id)                                 as manual_fee_rows,
    (select count(*) from public.appointment_payments ap where ap.studio_id = s.id)                                     as appointment_payment_rows,
    (select count(*) from public.stripe_charge_attempts sc where sc.studio_id = s.id)                                   as stripe_charge_rows,
    (select count(*) from public.pending_booking_payment_sessions ps where ps.studio_id = s.id)                         as pending_booking_payment_rows,
    ( exists (select 1 from public.services sv where sv.studio_id = s.id and coalesce(sv.price_cents,0) > 0)
      or exists (select 1 from public.client_pricing cp where cp.studio_id = s.id)
      or exists (select 1 from public.studios z where z.id = s.id and (coalesce(z.late_cancel_fee_cents,0) > 0 or coalesce(z.no_show_fee_cents,0) > 0))
      or exists (select 1 from public.sessions se where se.studio_id = s.id and se.price_paid_cents is not null) ) as needs_ack_prices
  from s
)
select
  g.at_hosted_0212,
  c.*,
  (c.acct_provisioning_rows + c.bound_account_rows + c.saved_card_rows + c.stripe_customer_rows
   + c.charge_attempt_rows + c.settlement_rows + c.manual_fee_rows + c.appointment_payment_rows
   + c.stripe_charge_rows + c.pending_booking_payment_rows) = 0                                    as r2a_reachable
from chain_guard g cross join c
order by c.studio_ordinal;
