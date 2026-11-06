-- ===========================================================================
-- GATE G9 (summary form): 0214 setter reach (S0a window read; re-run of the
-- 19:00Z census, 01-ops/1035-G9-CENSUS-20261023.txt)
-- Source: decision package A1 "G9 (0214 reach)", verbatim predicates, which
-- mirror the setter's refusal checks at 0214:244-276. Per-studio form: g09b.
--
-- RUN ONLY VIA: run-window-read.sh g09a-0214-reach-summary.sql
-- One SELECT, counts only. No studio id or name is returned.
--
-- EXPECTED PASS (matches the 19:00Z census): studios = 7, reachable_by_setter = 3,
--   refused_account = 3, refused_money_only = 1, at_hosted_0212 = 1.
-- STOP CONDITION: any value differs from the 19:00Z census. Reachability is not
--   stable (one card setup, Connect onboarding, charge or settlement makes a
--   studio unreachable): do not proceed to S2 for any studio until g09b is read
--   and OPS re-derives the R-2(a) set privately. chain_guard error: history not
--   at 0212; run G2 and stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
s as (
  select st.id,
    (exists(select 1 from public.stripe_account_provisioning_attempts a where a.studio_id=st.id)
     or exists(select 1 from public.studio_payment_settings p where p.studio_id=st.id and p.stripe_account_id is not null)
     or exists(select 1 from public.client_payment_methods m where m.studio_id=st.id)
     or exists(select 1 from public.client_stripe_customers c where c.studio_id=st.id)) as acct,
    (exists(select 1 from public.payment_charge_attempts x where x.studio_id=st.id)
     or exists(select 1 from public.appointment_settlements x where x.studio_id=st.id)
     or exists(select 1 from public.manual_fee_charge_attempts x where x.studio_id=st.id)
     or exists(select 1 from public.appointment_payments x where x.studio_id=st.id)
     or exists(select 1 from public.stripe_charge_attempts x where x.studio_id=st.id)
     or exists(select 1 from public.pending_booking_payment_sessions x where x.studio_id=st.id)) as money
  from public.studios st
)
select
  g.at_hosted_0212,
  (select count(*) from s)                                        as studios,
  (select count(*) from s where not acct and not money)           as reachable_by_setter,
  (select count(*) from s where acct)                             as refused_account,
  (select count(*) from s where money and not acct)               as refused_money_only
from chain_guard g;
