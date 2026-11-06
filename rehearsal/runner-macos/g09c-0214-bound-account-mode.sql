-- ===========================================================================
-- GATE G9 (account-mode form): bound Stripe accounts per studio ordinal, by
-- mode, and whether any can carry an observed country (S0a window read; input
-- for D-E and Insurance's A9 sheet). Companion to g09b; same ordinal derivation
-- (row_number() over (created_at, id)) and the same chain guard.
-- Verified at #1035 cdf8ae21 / production migrations <= 0212:
--   - 0032:418-444 + 0103:76-116: studio_payment_settings holds one row per
--     (studio_id, stripe_livemode) (unique nulls not distinct), plus at most one
--     null-mode placeholder. CHECK studio_payment_settings_account_mode_pair_check
--     (0032:433, unchanged by 0103): stripe_account_id is null <=> stripe_livemode
--     is null. No later migration <= 0212 alters the table.
--   - A "bound account" is a settings row with stripe_account_id not null: the
--     same predicate as g09b's bound_account_rows and 0214's acct refusal set,
--     which refuses on a bound account in EITHER mode.
--   - Observed country: 0214:383-387 ADDS stripe_account_country /
--     stripe_account_observed_at with NO backfill; only
--     record_stripe_account_jurisdiction (0214:643-744, UPDATEs at 692/702)
--     writes them (0238 only reads them). At hosted
--     0212 the column does not exist, so no bound account has an observed
--     country. This file cannot reference the column (it would not parse at
--     0212); it reports the column's presence instead (expected false).
--
-- RUN ONLY VIA: run-window-read.sh g09c-0214-bound-account-mode.sql
-- One SELECT, counts and booleans only: no studio id, no acct_ value, no name.
--
-- EXPECTED: one row per studio (7 at the 19:00Z census). bound_unknown_mode = 0
--   on every row (the pair CHECK makes it impossible). observed_country_column_present
--   = false on every row (no account has an observed country before 0214 + an
--   observation). bound_live + bound_test = g09b bound_account_rows for that
--   ordinal. at_hosted_0212 = 1.
-- STOP / ESCALATE: a different row count (ordinals may have shifted: re-map
--   privately), bound_unknown_mode > 0 (constraint drift: stop and report),
--   observed_country_column_present = true (impossible with the chain guard:
--   stop), or chain_guard error (history not at 0212: run G2 and stop).
-- READING IT FOR D-E (decided by OPS/Sam, not here): a studio whose only bound
--   account is test-mode (bound_live = 0) has no live account to observe.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
s as (
  select st.id, row_number() over (order by st.created_at, st.id) as studio_ordinal
  from public.studios st
),
col as (
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'studio_payment_settings'
       and column_name = 'stripe_account_country') as present
)
select
  g.at_hosted_0212,
  s.studio_ordinal,
  (select count(*) from public.studio_payment_settings p
    where p.studio_id = s.id and p.stripe_account_id is not null and p.stripe_livemode is true)   as bound_live,
  (select count(*) from public.studio_payment_settings p
    where p.studio_id = s.id and p.stripe_account_id is not null and p.stripe_livemode is false)  as bound_test,
  (select count(*) from public.studio_payment_settings p
    where p.studio_id = s.id and p.stripe_account_id is not null and p.stripe_livemode is null)   as bound_unknown_mode,
  (select count(*) from public.studio_payment_settings p
    where p.studio_id = s.id and p.stripe_account_id is null)                                     as info_settings_rows_without_account,
  (select count(*) from public.stripe_account_provisioning_attempts a
    where a.studio_id = s.id and a.stripe_livemode is true)                                       as info_provisioning_live,
  (select count(*) from public.stripe_account_provisioning_attempts a
    where a.studio_id = s.id and a.stripe_livemode is false)                                      as info_provisioning_test,
  (select count(*) from public.stripe_account_provisioning_attempts a
    where a.studio_id = s.id and a.stripe_livemode is null)                                       as info_provisioning_unknown_mode,
  c.present                                                                                       as observed_country_column_present
from chain_guard g cross join col c cross join s
order by s.studio_ordinal;
