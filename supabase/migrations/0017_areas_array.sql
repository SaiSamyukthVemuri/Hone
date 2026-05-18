-- Migration 0017: multi-area entries.
--   - Add a text[] column `areas` so one entry can cover multiple body areas
--     treated with the same settings.
--   - Backfill `areas` from existing `area` values so old rows render normally.
--   - Keep the legacy `area` column populated by app writes for now; a later
--     migration will drop it once all reads consume `areas`.
--
-- Per the Session 16 lesson, the column-add and the data-backfill are split.
-- Paste them one at a time in the Supabase SQL editor and verify row counts
-- between steps.

-- =====================
-- Step 1: paste this first.
-- Add the new column. Idempotent.
-- =====================

alter table public.electrolysis_entries
  add column if not exists areas text[];

-- =====================
-- Step 2: paste this after Step 1 commits cleanly.
-- Expected row count: every electrolysis_entries row that has a non-null
-- `area` but no `areas` set yet. Re-running is safe (the WHERE clause
-- prevents double-write).
-- =====================

update public.electrolysis_entries
  set areas = array[area]
  where area is not null and (areas is null or array_length(areas, 1) is null);
