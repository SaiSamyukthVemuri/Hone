-- Migration 0041: structured probe fields on session_blocks.
--
-- Session Logging Phase B. The flat free-text probe_type / probe_size
-- columns (migration 0019) can't express which brand/material/piece-type/
-- shank/size/length combinations actually exist on a real electrolysis
-- probe. This adds eight additive, nullable columns so a practitioner can
-- attach a single validated probe choice to a treatment area:
--
--   probe_key         text NULL  -- stable catalog id (lib/probes.ts)
--   probe_brand       text NULL  -- "Sterex" / "Ballet" / "Pro-Tec"
--   probe_material    text NULL  -- "Stainless steel" / "Gold" / ...
--   probe_piece_type  text NULL  -- "One-piece" / "Two-piece"
--   probe_shank       text NULL  -- "F" / "K"
--   probe_size_value  text NULL  -- numeric gauge, e.g. "3"
--   probe_length      text NULL  -- "Short" / "Regular"
--   probe_label       text NULL  -- self-contained display label
--
-- Why probe_size_value (not probe_size):
--   The legacy free-text probe_size column already exists on
--   session_blocks. Reusing it would collide with the legacy display path
--   and the entry snapshot. The structured size lives in its own column.
--
-- Why no enum/CHECK on the probe dimensions:
--   Validity is a *combination* property (e.g. "Sterex gold F6" is
--   impossible even though every individual value is otherwise valid).
--   Per-column CHECKs can't express that and would lock the schema every
--   time a brand is added. The valid combinations are enforced in the
--   server action against the lib/probes.ts catalog (the source of
--   truth). The only DB-level guard here is a defensive length cap so a
--   pathological value can't bloat a row.
--
-- Untouched (hard boundaries for this phase):
--   - legacy session_blocks.probe_type / probe_size (kept, unread by the
--     new path; existing rows and the entry snapshot still use them)
--   - electrolysis_entries (including its probe_type CHECK from 0016)
--   - block_name, primary_area / side / custom_area_detail (0039)
--   - TTT calculations (lib/treatment-time/queries.ts)
--   - the public booking surface, email templates, the cron
--   - Stripe / payments, require_card_on_file
--   - every RLS policy. session_blocks RLS (session_blocks_member_all,
--     migration 0019) covers the new columns automatically.
--
-- No data backfill. No destructive statements. Existing rows stay valid
-- (all new columns are NULL). Purely additive and re-runnable.

alter table public.session_blocks
  add column if not exists probe_key text,
  add column if not exists probe_brand text,
  add column if not exists probe_material text,
  add column if not exists probe_piece_type text,
  add column if not exists probe_shank text,
  add column if not exists probe_size_value text,
  add column if not exists probe_length text,
  add column if not exists probe_label text;

-- Defensive length cap only (no value enums). Each column is either NULL
-- or at most 80 chars. Drop-then-add keeps the migration re-runnable.
alter table public.session_blocks
  drop constraint if exists session_blocks_probe_fields_length_check;
alter table public.session_blocks
  add constraint session_blocks_probe_fields_length_check
  check (
    (probe_key is null or length(probe_key) <= 80)
    and (probe_brand is null or length(probe_brand) <= 80)
    and (probe_material is null or length(probe_material) <= 80)
    and (probe_piece_type is null or length(probe_piece_type) <= 80)
    and (probe_shank is null or length(probe_shank) <= 80)
    and (probe_size_value is null or length(probe_size_value) <= 80)
    and (probe_length is null or length(probe_length) <= 80)
    and (probe_label is null or length(probe_label) <= 80)
  );
