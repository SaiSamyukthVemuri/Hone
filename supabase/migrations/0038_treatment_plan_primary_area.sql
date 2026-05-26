-- Migration 0038: optional structured primary area on treatment_plans.
--
-- Body Chart v1 Phase A. Lets practitioners attach a structured area
-- (e.g. "Chin", "Upper lip", "Underarms") to a treatment plan so that
-- multi-session work is grouped by anatomical area instead of relying on
-- a free-text plan name alone. Per-block structured area, TTT by area,
-- backfill of legacy session_blocks.block_name, and any visual body
-- chart are intentionally deferred to later phases.
--
-- Why nullable + no value-set CHECK
--   - Existing treatment_plans rows must stay valid (no data rewrite).
--   - Practitioners can leave the area blank; the legacy plan-as-target
--     flow keeps working unchanged.
--   - The canonical area list is enforced in the practitioner UI via
--     lib/constants.ts AREA_REGIONS. Allowing free-form values at the
--     DB level matches the existing flexible convention (the legacy
--     AREAS constant has no DB CHECK either, and migration 0037
--     deliberately relaxed studio_recurring_break_rules.label from an
--     enum CHECK to a length CHECK for the same reason).
--   - "Other" + custom area string is therefore supported with no extra
--     schema work.
--
-- Untouched: the treatment_plan_stages child table from 0034, the
-- session_blocks schema, TTT calculations, public booking, email
-- templates, the cron, Stripe/payments, require_card_on_file, the
-- recurring-break materialization, the double-booking GIST exclusion,
-- and every RLS policy on every other table. This migration is purely
-- additive and re-runnable.

alter table public.treatment_plans
  add column if not exists primary_area text;

alter table public.treatment_plans
  drop constraint if exists treatment_plans_primary_area_length_check;
alter table public.treatment_plans
  add constraint treatment_plans_primary_area_length_check
  check (
    primary_area is null
    or length(primary_area) between 1 and 60
  );
