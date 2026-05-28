-- Migration 0042: structured blend / galvanic readings on electrolysis_entries.
--
-- Session Logging Phase 3. The one-page charting form (PR #54) captures a
-- single generic intensity / duration plus pulse_count and hairs_treated.
-- Chloe needs the blend and galvanic readings recorded distinctly, because
-- blend combines thermolysis and galvanic and each carries its own numbers.
--
-- This adds six additive, nullable columns so a practitioner can record the
-- galvanic and thermolysis components separately:
--
--   galvanic_ma                   numeric NULL  -- galvanic current, mA
--   galvanic_duration_seconds     integer NULL  -- galvanic duration, s
--   galvanic_intensity_percent    integer NULL  -- galvanic intensity, %
--   thermolysis_intensity_percent integer NULL  -- thermolysis intensity, %
--   thermolysis_duration_seconds  integer NULL  -- thermolysis duration, s
--   units_of_lye                  numeric NULL  -- units of lye (UL)
--
-- pulse_count and hairs_treated already exist (migrations 0019 / 0012) and
-- are NOT duplicated. The legacy generic intensity / duration_seconds
-- columns (migration 0001) are left untouched — they keep rendering for old
-- entries; the new structured columns are what the updated charting form
-- writes going forward.
--
-- Value guards (all "NULL or in range") so existing rows (all NULL) stay
-- valid and no backfill is needed:
--   - galvanic_ma                   >= 0
--   - galvanic_duration_seconds     >= 0
--   - galvanic_intensity_percent    between 0 and 100
--   - thermolysis_intensity_percent between 0 and 100
--   - thermolysis_duration_seconds  >= 0
--   - units_of_lye                  >= 0
--
-- Untouched: mode/apilus_modality values and their display labels, the
-- legacy intensity/duration_seconds, pulse_count, hairs_treated, every
-- session_blocks column, TTT calculations (lib/treatment-time/queries.ts
-- reads session_blocks.minutes_performed only), probe catalog, the public
-- booking surface, email templates, the cron, Stripe / payments,
-- require_card_on_file, and every RLS policy. electrolysis_entries RLS is
-- inherited via its session (existing policies); the new columns need no
-- new policy.
--
-- Purely additive, nullable, no data rewrite, no backfill, re-runnable.

alter table public.electrolysis_entries
  add column if not exists galvanic_ma numeric,
  add column if not exists galvanic_duration_seconds integer,
  add column if not exists galvanic_intensity_percent integer,
  add column if not exists thermolysis_intensity_percent integer,
  add column if not exists thermolysis_duration_seconds integer,
  add column if not exists units_of_lye numeric;

-- Single combined value-range guard. Drop-then-add keeps it re-runnable.
alter table public.electrolysis_entries
  drop constraint if exists electrolysis_entries_blend_galvanic_check;
alter table public.electrolysis_entries
  add constraint electrolysis_entries_blend_galvanic_check
  check (
    (galvanic_ma is null or galvanic_ma >= 0)
    and (galvanic_duration_seconds is null or galvanic_duration_seconds >= 0)
    and (galvanic_intensity_percent is null
         or galvanic_intensity_percent between 0 and 100)
    and (thermolysis_intensity_percent is null
         or thermolysis_intensity_percent between 0 and 100)
    and (thermolysis_duration_seconds is null
         or thermolysis_duration_seconds >= 0)
    and (units_of_lye is null or units_of_lye >= 0)
  );
