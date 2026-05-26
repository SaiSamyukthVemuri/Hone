-- Migration 0039: optional structured area metadata on session_blocks.
--
-- Body Chart v1 Phase B. Adds three additive nullable columns to
-- public.session_blocks so practitioners can attach a structured
-- anatomical area to a treatment block (alongside the existing
-- free-text block_name). The columns are:
--
--   primary_area        text NULL   -- e.g. "Chin", "Underarms"
--   side                text NULL   -- 'center'/'left'/'right'/'bilateral'/'n/a'
--   custom_area_detail  text NULL   -- e.g. "midline glabella", "under-chin"
--
-- Why nullable + permissive value sets
--   - Existing session_blocks rows must stay valid (no data rewrite).
--   - Practitioners can leave the area blank; the legacy block_name
--     flow keeps working exactly as today.
--   - The canonical area list is enforced in the practitioner UI via
--     lib/constants.ts AREA_REGIONS. Allowing free-form primary_area at
--     the DB level matches the existing flexible convention (see the
--     equivalent treatment_plans.primary_area from migration 0038 and
--     the studio_recurring_break_rules.label relaxation from 0037).
--   - "Other" + custom_area_detail is therefore supported with no extra
--     schema work.
--
-- The side column DOES use a small enum CHECK (5 values + NULL) because
-- side is genuinely closed-vocabulary and analytics queries will pivot
-- on exact-string equality.
--
-- Untouched: block_name (legacy, still the heading source), every
-- existing column on session_blocks, electrolysis_entries.areas[] (the
-- per-entry multi-area data added in migration 0017), TTT calculations
-- in lib/treatment-time/queries.ts (still uses bucketize(block_name)),
-- the public booking surface, email templates, the cron, Stripe /
-- payments, require_card_on_file, the recurring-break materialization,
-- the double-booking GIST exclusion, and every RLS policy on every
-- other table. RLS on session_blocks already exists from migration 0019
-- (session_blocks_member_all using is_studio_member(studio_id)); the
-- new columns inherit that policy automatically — no new policy needed.
--
-- This migration is purely additive and re-runnable.

-- Primary area
alter table public.session_blocks
  add column if not exists primary_area text;

alter table public.session_blocks
  drop constraint if exists session_blocks_primary_area_length_check;
alter table public.session_blocks
  add constraint session_blocks_primary_area_length_check
  check (
    primary_area is null
    or length(primary_area) between 1 and 60
  );

-- Side
alter table public.session_blocks
  add column if not exists side text;

alter table public.session_blocks
  drop constraint if exists session_blocks_side_value_check;
alter table public.session_blocks
  add constraint session_blocks_side_value_check
  check (
    side is null
    or side in ('center', 'left', 'right', 'bilateral', 'n/a')
  );

-- Custom area detail
alter table public.session_blocks
  add column if not exists custom_area_detail text;

alter table public.session_blocks
  drop constraint if exists session_blocks_custom_area_detail_length_check;
alter table public.session_blocks
  add constraint session_blocks_custom_area_detail_length_check
  check (
    custom_area_detail is null
    or length(custom_area_detail) between 1 and 60
  );
