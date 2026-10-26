-- ===========================================================================
-- GATE G7: 0226 duplicate LIVE claimed SMS numbers (S0a window read)
-- Source: decision package A0 row 0226, Part II section 6 G7 ("0226 duplicate
-- live claimed-number count = 0"; last read stale, 2026-10-21).
-- Predicate mirrors 0226's index exactly (#1035 cdf8ae21, 0226:232-234):
--   create unique index studio_sms_senders_live_claimed_number_unique
--     on public.studio_sms_senders (claimed_phone_number)
--     where claimed_phone_number is not null and status <> 'released';
--
-- RUN ONLY VIA: run-window-read.sh g07-sms-claimed-number-duplicates.sql
-- One SELECT, counts only: no phone number, studio or sender id is returned.
--
-- EXPECTED PASS: duplicated_numbers = 0, rows_in_duplicates = 0, at_hosted_0212 = 1.
--   info_live_claimed_rows is information only.
-- STOP CONDITION: duplicated_numbers > 0. 0226's CREATE UNIQUE INDEX fails and
--   S1 stops at 0226. Do not start S1; the SMS owner dispositions the duplicate
--   claims privately. chain_guard error: history not at 0212; run G2 and stop.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0212'
                   then 1 else 0 end) as at_hosted_0212
),
live as (
  select s.claimed_phone_number, count(*) as n
  from public.studio_sms_senders s
  where s.claimed_phone_number is not null and s.status <> 'released'
  group by s.claimed_phone_number
)
select
  g.at_hosted_0212,
  (select count(*) from live where n > 1)                 as duplicated_numbers,
  (select coalesce(sum(n), 0) from live where n > 1)      as rows_in_duplicates,
  (select coalesce(sum(n), 0) from live)                  as info_live_claimed_rows
from chain_guard g;
