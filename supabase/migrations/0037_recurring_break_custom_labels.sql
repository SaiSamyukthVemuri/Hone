-- Migration 0037: Allow custom labels on recurring break rules.
--
-- The original migration (0031_recurring_breaks.sql) restricted
-- studio_recurring_break_rules.label to the enum
--   ('lunch', 'break', 'admin', 'other').
--
-- Practitioner feedback (Chloe): a late workday needs "Dinner", not
-- "Other". The label is private to the practitioner (clients only see
-- the slot as unavailable), so widening the value set has no privacy
-- impact.
--
-- This migration:
--   1. Drops the enum CHECK constraint.
--   2. Adds a length-based CHECK (1..60 chars). Every existing row
--      ('lunch' / 'break' / 'admin' / 'other' — all 1..6 chars)
--      trivially satisfies the new constraint, so no data rewrite is
--      needed and no row becomes invalid.
--
-- Untouched: column type (still text NOT NULL), the materialization
-- RPCs from 0031, the daily cron, the studio_calendar_reservations
-- exclusion, RLS policies, recurring-break conflict detection. This
-- is a constraint relaxation only.
--
-- Re-runnable.

alter table public.studio_recurring_break_rules
  drop constraint if exists studio_recurring_break_rules_label_check;

alter table public.studio_recurring_break_rules
  drop constraint if exists studio_recurring_break_rules_label_length_check;
alter table public.studio_recurring_break_rules
  add constraint studio_recurring_break_rules_label_length_check
  check (length(label) between 1 and 60);
