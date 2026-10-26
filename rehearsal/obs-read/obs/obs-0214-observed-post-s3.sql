-- ===========================================================================
-- OBSERVATION READ, POST-S3 (count-only): did the Stripe-account observation
-- land? Studios by creation ordinal 1 (W) and 7 (S), LIVE mode only. Runs AFTER
-- S1 and S3 (the columns it reads are added by 0214), so its chain guard is the
-- inverse of the pre-window file: it refuses unless the history max is 0246.
-- Same ordinal derivation as g09b / g09d / obs-0214-live-named-accounts.sql:
-- row_number() over (created_at, id).
--
-- RUN ONLY VIA: run-window-read-macos.sh obs-0214-observed-post-s3.sql, from a
-- directory whose MANIFEST.sha256 lists it (window-reads-obs).
-- One SELECT, counts only. NO account id, studio id or name, and no country or
-- currency value is returned: only the counts below (the country appears only as
-- a CA / not-CA count).
--
-- "Live" = stripe_livemode true. A bound account (stripe_account_id not null)
-- always has a mode (0032 pair check), so no unknown-mode bound row exists.
--
-- Columns, per studio_ordinal:
--   bound_live_rows         bound live accounts of the studio
--   observed                of those, stripe_account_observed_at is not null
--   observed_country_ca     of those, stripe_account_country = 'CA'
--   observed_currency_cad   of those, stripe_account_default_currency = 'cad'
--   conflict_recorded       of those, a country conflict is recorded (conflict
--                           columns set; it outlives any later agreeing report)
--   jurisdiction_row_exists 1 if the studio has a studio_payment_jurisdictions row
--   studios_total           all studios; both ordinals 1 and 7 must exist
-- EXPECTED: 2 rows (ordinals 1 and 7), at_hosted_0246 = 1.
-- STOP CONDITION: any row count other than 2, studios_total < 7, or a chain
--   guard error (history max is not 0246: run G2 and stop).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
s as (
  select st.id, row_number() over (order by st.created_at, st.id) as studio_ordinal
  from public.studios st
),
t as (
  select s.id, s.studio_ordinal from s where s.studio_ordinal in (1, 7)
)
select g.at_hosted_0246,
       t.studio_ordinal,
       count(p.studio_id) as bound_live_rows,
       count(*) filter (where p.stripe_account_observed_at is not null) as observed,
       count(*) filter (where p.stripe_account_country = 'CA') as observed_country_ca,
       count(*) filter (where p.stripe_account_default_currency = 'cad') as observed_currency_cad,
       count(*) filter (where p.stripe_account_country_conflict is not null) as conflict_recorded,
       (select count(*) from public.studio_payment_jurisdictions j where j.studio_id = t.id) as jurisdiction_row_exists,
       (select count(*) from s) as studios_total
from chain_guard g
cross join t
left join public.studio_payment_settings p
  on p.studio_id = t.id and p.stripe_account_id is not null and p.stripe_livemode = true
group by g.at_hosted_0246, t.studio_ordinal, t.id
order by t.studio_ordinal;
