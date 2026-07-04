-- 0102: Pulse delay between high-frequency pulses (charting improvement).
--
-- Chloe feedback: when multiple pulses are recorded on an electrolysis entry
-- (pulse_count > 1), the practitioner needs to log the delay between the
-- high-frequency pulses. Her machine's range is 0.03–1.90 seconds and it
-- auto-sets 0.5s. This adds one additive, nullable column to store it.
--
-- What changes:
--   * public.electrolysis_entries.pulse_delay_seconds  numeric(4,2) NULL
--     - The seconds between high-frequency pulses. numeric(4,2) gives two
--       decimal places (matches the machine's 0.01s resolution).
--     - A range CHECK bounds a non-null value to [0.03, 1.90]. NULL is always
--       allowed, so:
--         * every existing row stays valid (all NULL after this migration);
--         * a single-pulse entry (pulse_count = 1) leaves it NULL — the app
--           only writes a value when pulse_count > 1.
--
-- What this migration deliberately does NOT do:
--   * No change to pulse_count (migration 0019 / 0012) or any other reading
--     column, no backfill, no destructive statement.
--   * The "only when pulse_count > 1" rule is an application-layer concern
--     (the charting forms + block actions); the DB CHECK is only the range
--     guard, so the column stays simple and additive.
--   * No RLS change — session_blocks / electrolysis_entries RLS already covers
--     the new column. No Stripe / payments / env / other-table change.
--
-- Additive + re-runnable.

alter table public.electrolysis_entries
  add column if not exists pulse_delay_seconds numeric(4, 2);

alter table public.electrolysis_entries
  drop constraint if exists electrolysis_entries_pulse_delay_seconds_range_check;
alter table public.electrolysis_entries
  add constraint electrolysis_entries_pulse_delay_seconds_range_check
  check (
    pulse_delay_seconds is null
    or (pulse_delay_seconds >= 0.03 and pulse_delay_seconds <= 1.90)
  );

comment on column public.electrolysis_entries.pulse_delay_seconds is
  'Seconds between high-frequency pulses, recorded only when pulse_count > 1 (0.03–1.90s, machine default 0.5s). NULL for single-pulse entries and all pre-0102 rows.';

-- Verification SQL (operator runs after deploy):
--
--   select column_name, data_type, numeric_precision, numeric_scale, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'electrolysis_entries'
--     and column_name = 'pulse_delay_seconds';
--   -- expect: numeric, precision 4, scale 2, nullable YES.
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.electrolysis_entries'::regclass
--     and conname = 'electrolysis_entries_pulse_delay_seconds_range_check';
--   -- expect: CHECK ((pulse_delay_seconds IS NULL) OR ((pulse_delay_seconds >= 0.03) AND (pulse_delay_seconds <= 1.90)))
--
--   select count(*) from public.electrolysis_entries where pulse_delay_seconds is not null;
--   -- expect immediately after deploy: 0.
