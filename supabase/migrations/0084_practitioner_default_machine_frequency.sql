-- 0084: sticky machine frequency default per practitioner (PR #203).
--
-- Chloe: "machine frequency ... pretty much always stays the same
-- unless I change it. Me and most others don't change machines
-- daily." There is no existing practitioner-preferences store, so
-- this adds ONE nullable column on practitioners: the last-used
-- machine frequency, written by the treatment-area save actions and
-- read to seed NEW treatment-area drafts. The actual value used for
-- a treatment area continues to live on session_blocks.machine_
-- frequency exactly as before; this column is a UI default only.
--
-- Why a migration (and not localStorage): the default must follow
-- the practitioner across sessions and devices (iPad + desktop);
-- localStorage is per-device. Additive + nullable + no backfill, so
-- existing rows and old app code are unaffected. Same allowed
-- values as the entries-table CHECK (0014).

alter table public.practitioners
  add column if not exists default_machine_frequency text;

alter table public.practitioners
  drop constraint if exists practitioners_default_machine_frequency_check;
alter table public.practitioners
  add constraint practitioners_default_machine_frequency_check
  check (
    default_machine_frequency is null
    or default_machine_frequency in ('13.56 MHz','27.12 MHz')
  );
