-- Migration 0014: correct the Apilus operating frequency label.
-- ISM band thermolysis equipment runs at 13.56 MHz, not 13.5 MHz.
-- This migration:
--   1. updates existing rows that recorded "13.5 MHz"
--   2. replaces the CHECK constraint to allow the new label and reject the old
-- Re-runnable: every alter table add constraint is preceded by drop constraint
-- if exists; the UPDATE is idempotent (only rows still on the old label match).

update public.electrolysis_entries
  set machine_frequency = '13.56 MHz'
  where machine_frequency = '13.5 MHz';

alter table public.electrolysis_entries
  drop constraint if exists entries_machine_frequency_check;
alter table public.electrolysis_entries
  add constraint entries_machine_frequency_check
  check (
    machine_frequency is null
    or machine_frequency in ('13.56 MHz','27.12 MHz')
  );
