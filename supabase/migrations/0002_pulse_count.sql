-- Adds pulse_count to electrolysis entries. Practitioners may apply multiple pulses per hair.
-- Default 1 preserves the existing behavior for rows already inserted.

alter table public.electrolysis_entries
  add column pulse_count int not null default 1
  check (pulse_count between 1 and 10);
