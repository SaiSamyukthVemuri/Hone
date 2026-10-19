-- PROPOSAL ONLY: not in the migration chain and not authorized for production.
-- Allocate a new migration number through ops01 before promoting this repair.
-- Never amend frozen 0223 or held 0234. Finding #860 / 4309278439.
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
