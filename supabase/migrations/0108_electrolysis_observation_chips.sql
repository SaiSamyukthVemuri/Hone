-- 0108_electrolysis_observation_chips.sql
--
-- Treatment observation chips reliability (Chloe charting feedback).
--
-- Chips were stored as comma-text INSIDE electrolysis_entries.comments and the
-- "selected" state was DERIVED by re-parsing that string. Any edit that did not
-- round-trip through the parser (a comma inside free text, free text that
-- happens to match a chip label, dedup) silently de-synced a chip — an
-- observation could disappear from the structured view. This adds a STRUCTURED,
-- durable field so selected chips are stored explicitly; free-text notes stay in
-- `comments`.
--
-- Additive + backward-compatible:
--   * existing rows default to '[]' and keep rendering their `comments`
--     unchanged (no double-display, since legacy rows have no structured chips);
--   * NO backfill — we do not re-parse existing free text into structured data
--     (that is exactly the lossy inference we are removing). Legacy
--     chip-in-comments records are migrated per-record, NON-destructively, only
--     when a practitioner next edits and saves that record;
--   * `comments` is preserved and never dropped by this migration.
--
-- RLS/tenant scope is inherited from electrolysis_entries (this only adds a
-- column; no policy is created, weakened, or dropped). NOT applied to production
-- in this PR (proposal only; apply via the migration-first flow after approval).

alter table public.electrolysis_entries
  add column if not exists observation_chips jsonb not null default '[]'::jsonb;

-- Guard the shape: observation_chips is always a JSON array (never an object or
-- scalar). Mirrors the app-side normalizeChips() contract.
alter table public.electrolysis_entries
  drop constraint if exists electrolysis_entries_observation_chips_is_array;
alter table public.electrolysis_entries
  add constraint electrolysis_entries_observation_chips_is_array
  check (jsonb_typeof(observation_chips) = 'array');

comment on column public.electrolysis_entries.observation_chips is
  'Structured treatment-observation chips: a JSON array of canonical chip labels (lib/observation-chips.ts). Free-text notes stay in comments. Added 0108; default [] keeps legacy rows valid and they continue to render their comments. No backfill — legacy chip-in-comments rows migrate per-record on next edit/save. Tenant/RLS scope inherited from electrolysis_entries.';
