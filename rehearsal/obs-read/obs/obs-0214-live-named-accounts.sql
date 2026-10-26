-- ===========================================================================
-- OBSERVATION READ (count-only): can the Stripe-account observation clear a
-- studio for the 0214 history initializer? Studios by creation ordinal 1 (W)
-- and 7 (S), per source table. Companion to g09b / g09d (same ordinal
-- derivation: row_number() over (created_at, id)).
-- Source: insurance/OBSERVATION-STEP-PROPOSED-READ.sql, reviewed and extended by
-- Machines (OBS-READ-PREP): 0212 chain guard, one row per (ordinal, source) so
-- a zero is a row and not an absence, a bound-account count, studios_total.
--
-- RUN ONLY VIA: run-window-read-macos.sh obs-0214-live-named-accounts.sql, from
-- a directory whose MANIFEST.sha256 lists it (window-reads-obs, not window-reads).
-- One SELECT, counts only. NO account id, studio id or name is returned.
--
-- "Live" means stripe_livemode is not false: true OR unknown (null), exactly as
-- studio_named_stripe_accounts / the initializer treat it (0214 lines 839-862,
-- 1018-1031). A live row is satisfiable only if it names an account that is a
-- BOUND account of the same studio in the same mode (studio_payment_settings,
-- stripe_account_id not null, stripe_livemode not false, mode equal incl. null).
--
-- Columns, per (studio_ordinal, src):
--   live_named_rows                live rows in this source
--   live_rows_without_account      live rows naming no account (only provisioning
--                                  attempts can have none): can NEVER be satisfied
--   live_rows_on_an_unbound_account live rows naming an account that is not bound
--                                  for that studio and mode: can NEVER be satisfied
--   live_rows_on_a_bound_account   live rows on a bound account: satisfiable once
--                                  the account country is observed and equals the
--                                  proposed country (at 0212 no country is
--                                  recorded, so none are observed yet)
--   studios_total                  all studios; both ordinals 1 and 7 must exist
-- EXPECTED: 26 rows (2 ordinals x 13 sources), at_hosted_0212 = 1.
-- STOP CONDITION: any row other than 26, studios_total < 7, or a chain guard
--   error (history not at 0212: run G2 and stop).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
s as (
  select st.id, row_number() over (order by st.created_at, st.id) as studio_ordinal
  from public.studios st
),
t as (
  select s.id, s.studio_ordinal from s where s.studio_ordinal in (1, 7)
),
bound as (
  select p.studio_id, p.stripe_account_id, p.stripe_livemode
  from public.studio_payment_settings p
  where p.stripe_account_id is not null and p.stripe_livemode is distinct from false
),
sources(src) as (
  values ('provisioning_attempts'), ('client_payment_methods'), ('client_stripe_customers'),
         ('payment_charge_attempts'), ('manual_fee_charge_attempts'), ('stripe_charge_attempts'),
         ('stripe_refunds'), ('stripe_refund_attempts'), ('stripe_disputes'),
         ('stripe_payment_audit'), ('payment_recovery_tokens'),
         ('stripe_customer_provisioning_attempts'), ('studio_payment_settings')
),
named as (
  select a.studio_id, 'provisioning_attempts' as src, a.stripe_account_id, a.stripe_livemode from public.stripe_account_provisioning_attempts a
  union all select x.studio_id, 'client_payment_methods', x.stripe_account_id, x.stripe_livemode from public.client_payment_methods x where x.stripe_account_id is not null
  union all select x.studio_id, 'client_stripe_customers', x.stripe_account_id, x.stripe_livemode from public.client_stripe_customers x where x.stripe_account_id is not null
  union all select x.studio_id, 'payment_charge_attempts', x.stripe_account_id, x.stripe_livemode from public.payment_charge_attempts x where x.stripe_account_id is not null
  union all select x.studio_id, 'manual_fee_charge_attempts', x.stripe_account_id, x.stripe_livemode from public.manual_fee_charge_attempts x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_charge_attempts', x.stripe_account_id, x.stripe_livemode from public.stripe_charge_attempts x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_refunds', x.stripe_account_id, x.stripe_livemode from public.stripe_refunds x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_refund_attempts', x.stripe_account_id, x.stripe_livemode from public.stripe_refund_attempts x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_disputes', x.stripe_account_id, x.stripe_livemode from public.stripe_disputes x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_payment_audit', x.stripe_account_id, x.stripe_livemode from public.stripe_payment_audit x where x.stripe_account_id is not null
  union all select x.studio_id, 'payment_recovery_tokens', x.stripe_account_id, x.stripe_livemode from public.payment_recovery_tokens x where x.stripe_account_id is not null
  union all select x.studio_id, 'stripe_customer_provisioning_attempts', x.stripe_account_id, x.stripe_livemode from public.stripe_customer_provisioning_attempts x where x.stripe_account_id is not null
  union all select b.studio_id, 'studio_payment_settings', b.stripe_account_id, b.stripe_livemode from bound b
)
select g.at_hosted_0212,
       t.studio_ordinal,
       k.src,
       count(n.src) as live_named_rows,
       count(*) filter (where n.src is not null and n.stripe_account_id is null) as live_rows_without_account,
       count(*) filter (where n.stripe_account_id is not null
                          and not exists (select 1 from bound b where b.studio_id = n.studio_id
                                          and b.stripe_account_id = n.stripe_account_id
                                          and b.stripe_livemode is not distinct from n.stripe_livemode)) as live_rows_on_an_unbound_account,
       count(*) filter (where n.stripe_account_id is not null
                          and exists (select 1 from bound b where b.studio_id = n.studio_id
                                      and b.stripe_account_id = n.stripe_account_id
                                      and b.stripe_livemode is not distinct from n.stripe_livemode)) as live_rows_on_a_bound_account,
       (select count(*) from s) as studios_total
from chain_guard g
cross join t
cross join sources k
left join named n on n.studio_id = t.id and n.src = k.src and n.stripe_livemode is distinct from false
group by g.at_hosted_0212, t.studio_ordinal, k.src
order by t.studio_ordinal, k.src;
