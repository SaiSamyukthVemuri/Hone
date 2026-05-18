-- Migration 0016: probe type taxonomy update.
--   - Rename 'Regular' to 'Stainless steel regular' on existing rows.
--   - Add 'Stainless steel gold' as a new allowed value.
--   - Replace CHECK constraint accordingly.
--
-- Per the Session 16 lesson, the data UPDATE and the constraint swap are
-- split into separate blocks so each row count is visible before the
-- stricter constraint takes effect. Paste them one at a time in the
-- Supabase SQL editor.

-- =====================
-- Step 1: paste this first.
-- Rewrite existing rows so they pass the new constraint.
-- Expected row count: however many electrolysis_entries currently have
-- probe_type = 'Regular'. If you see 0, that's fine (means none were set).
-- =====================

update public.electrolysis_entries
  set probe_type = 'Stainless steel regular'
  where probe_type = 'Regular';

-- =====================
-- Step 2: paste this after Step 1 commits cleanly.
-- Swap the CHECK constraint to the new vocabulary.
-- Re-runnable: drop if exists then add.
-- =====================

alter table public.electrolysis_entries
  drop constraint if exists entries_probe_type_check;
alter table public.electrolysis_entries
  add constraint entries_probe_type_check
  check (
    probe_type is null
    or probe_type in (
      'Stainless steel regular',
      'Stainless steel gold',
      'IBL',
      'ITH'
    )
  );
