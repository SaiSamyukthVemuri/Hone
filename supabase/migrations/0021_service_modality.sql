-- Migration 0021: add modality grouping and explicit sort order to services.
-- (Spec asked for 0023; using 0021 since that's the correct sequential next
-- number in the existing migration series.)
--
-- modality stays free text: no CHECK constraint so studios can add custom
-- categories (e.g. "Brow lamination") later without another migration.
-- Existing rows pick up modality = NULL (treated as "Other" in the UI) and
-- sort_order = 100. Per the Session 16 / 17.5a lesson, the column-add and
-- the data backfill live in separate paste blocks.

-- =====================
-- Step 1: paste this first.
-- Pure additive: new columns + index. Idempotent.
-- =====================

alter table public.services
  add column if not exists modality text,
  add column if not exists sort_order integer not null default 100;

-- Partial index speeds the "active services for a studio, grouped by modality"
-- read pattern used by the booking form.
create index if not exists services_modality_sort_idx
  on public.services (studio_id, modality, sort_order)
  where active = true;

-- =====================
-- Step 2: paste this after Step 1 commits cleanly.
-- Heuristic backfill: classify existing services by name pattern. Only
-- updates rows where modality is currently NULL, so re-running is safe.
-- Expected row counts depend on the studio's current service names; verify
-- after each UPDATE to see which buckets caught how many rows.
-- =====================

update public.services
  set modality = 'electrolysis'
  where modality is null
    and (
      lower(name) like '%electrolysis%'
      or lower(name) like '%electro%'
    );

update public.services
  set modality = 'laser'
  where modality is null
    and (
      lower(name) like '%laser%'
      or lower(name) like '%ipl%'
    );

update public.services
  set modality = 'consultation'
  where modality is null
    and (
      lower(name) like '%consult%'
      or lower(name) like '%intake%'
    );

-- After Step 2: anything still with modality is null shows up under "Other"
-- in the booking page UI. Practitioner can reassign via settings.
