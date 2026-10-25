-- Machines allocation 0235: finite readings only (#860 / 4309278439).
-- Frozen 0223 and held #920/0234 remain unchanged. No clinical backfill.
begin;
set local lock_timeout = '5s';

-- NOT VALID avoids rewriting or deleting an immutable historical observation.
-- PostgreSQL still enforces this constraint on every NEW row, including rows
-- inserted through either granted recording RPC and the atomic create path.
-- Existing non-finite records, if any, require an operator-led clinical review;
-- do not manufacture replacement values or silently validate the old corpus.
alter table public.treatment_setup_readings
  add constraint treatment_setup_readings_finite_value
  check (value_numeric is null or value_numeric not in
    ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) not valid;

commit;
