-- Migration 0051: treatment plans multi-area + month timeline.
--
-- Chloe's pilot review reframed treatment plans around timeline/months
-- and total treatment time, away from the legacy visit-count framing
-- (sessions vary widely in length, so "estimated visits" was misleading
-- as the primary model). This migration is the schema half of the
-- reframing: it adds optional structured multi-area + month-window
-- columns and gives suggested_visit_count a benign default so the new
-- create surface no longer has to ask for a visit count.
--
-- Safety rules honored:
--   * Strictly additive. No existing columns are dropped, renamed, or
--     made stricter.
--   * No data is rewritten. Existing rows remain valid: treatment_areas
--     stays NULL on legacy rows (the app reads primary_area as the
--     fallback when treatment_areas is NULL or empty), and
--     estimated_timeline_months_min/max stay NULL.
--   * suggested_visit_count keeps its NOT NULL stance for backward
--     compatibility with the legacy "X of Y estimated visits" banner
--     line; the new default of 12 only affects inserts that omit the
--     column, not any existing row.
--   * Idempotent. Every ADD COLUMN uses IF NOT EXISTS; every
--     constraint is dropped-if-exists before being added. The migration
--     can be re-run without error.
--
-- The accompanying app changes:
--   * UI multi-area picker writes treatment_areas[] and mirrors the
--     first entry into primary_area for backward compatibility (the
--     session-detail area-defaulting and the banner area chip both
--     fall through to primary_area when treatment_areas is empty).
--   * Create form drops Estimated visits as a required input and
--     relies on the new column default (12).
--   * Plan card + banner lead with timeline/months + TTT planned vs
--     actual; the legacy visit-count line is demoted to a muted
--     footnote.

-- --------------------------------------------------------------------
-- 1) Columns
-- --------------------------------------------------------------------

alter table public.treatment_plans
  add column if not exists treatment_areas text[];

comment on column public.treatment_plans.treatment_areas is
  'Optional structured multi-area list for this plan. NULL or empty means use the legacy single primary_area column. App-side writers must mirror the first entry into primary_area for backward compatibility with surfaces that still read primary_area (session area defaulting, banner fallback, data export).';

alter table public.treatment_plans
  add column if not exists estimated_timeline_months_min integer;

comment on column public.treatment_plans.estimated_timeline_months_min is
  'Optional minimum months estimate for the whole treatment plan. Reminder/display only; not a clinical guarantee. Paired with estimated_timeline_months_max.';

alter table public.treatment_plans
  add column if not exists estimated_timeline_months_max integer;

comment on column public.treatment_plans.estimated_timeline_months_max is
  'Optional maximum months estimate for the whole treatment plan. Reminder/display only; not a clinical guarantee. Must be >= estimated_timeline_months_min when both are set.';

-- --------------------------------------------------------------------
-- 2) CHECK constraints
-- --------------------------------------------------------------------

-- Months range. 1..60 covers the realistic window for permanent hair
-- removal (electrolysis plans typically run 12-36 months; the upper
-- guard catches typos like 600 or accidental day-counts).

alter table public.treatment_plans
  drop constraint if exists treatment_plans_timeline_months_min_range_check;
alter table public.treatment_plans
  add constraint treatment_plans_timeline_months_min_range_check
  check (
    estimated_timeline_months_min is null
    or estimated_timeline_months_min between 1 and 60
  );

alter table public.treatment_plans
  drop constraint if exists treatment_plans_timeline_months_max_range_check;
alter table public.treatment_plans
  add constraint treatment_plans_timeline_months_max_range_check
  check (
    estimated_timeline_months_max is null
    or estimated_timeline_months_max between 1 and 60
  );

-- Ordering: min <= max when both are present. Either side may be NULL
-- (one-sided estimates are allowed for "at least 18 months" or
-- "about 24 months" UI patterns).
alter table public.treatment_plans
  drop constraint if exists treatment_plans_timeline_months_order_check;
alter table public.treatment_plans
  add constraint treatment_plans_timeline_months_order_check
  check (
    estimated_timeline_months_min is null
    or estimated_timeline_months_max is null
    or estimated_timeline_months_min <= estimated_timeline_months_max
  );

-- Multi-area count guard. Caps the array at 12 entries so a runaway
-- form post can't write a thousand-element list. NULL passes. Empty
-- arrays also pass (array_length on an empty array returns NULL,
-- which CHECK treats as not-failed); the app layer normalizes empty
-- arrays to NULL before writing, but the constraint is permissive
-- either way so a partial UI write does not error.
alter table public.treatment_plans
  drop constraint if exists treatment_plans_treatment_areas_count_check;
alter table public.treatment_plans
  add constraint treatment_plans_treatment_areas_count_check
  check (
    treatment_areas is null
    or array_length(treatment_areas, 1) is null
    or array_length(treatment_areas, 1) between 1 and 12
  );

-- --------------------------------------------------------------------
-- 3) Default for the legacy visit-count column
-- --------------------------------------------------------------------
--
-- The new create surface no longer asks for an Estimated visits
-- number. To keep suggested_visit_count NOT NULL (which legacy
-- readers, the data export, and the banner still depend on) we give
-- the column a benign default of 12 so inserts that omit it produce
-- a sensible row. Existing rows are not rewritten; ALTER ... SET
-- DEFAULT only changes what future NULL inserts produce.

alter table public.treatment_plans
  alter column suggested_visit_count set default 12;
