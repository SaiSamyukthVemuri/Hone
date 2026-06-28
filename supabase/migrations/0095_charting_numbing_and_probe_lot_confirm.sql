-- Migration 0095: Charting feedback fields (PR #279) — numbing + probe-lot confirmation.
--
-- Chloe's real-charting feedback added two charting facts the schema could not
-- store:
--   1. Whether the client used numbing before treatment (an explicit, factual
--      record — not advice/dosing). session_blocks.numbing_status:
--        NULL  -> "Not recorded" (every legacy row; the safe default)
--        'none'-> "No numbing used"
--        'used'-> "Numbing used"
--   2. Whether the practitioner CONFIRMED the probe lot/batch number for this
--      treatment (vs a value merely suggested from records or typed but not
--      checked). session_blocks.probe_lot_confirmed boolean.
--
-- Both are ADDITIVE and safely defaulted: numbing_status defaults to NULL
-- ("Not recorded"), probe_lot_confirmed defaults to false ("not confirmed").
-- Legacy rows read correctly with no backfill. No RLS change. No payment /
-- live-mode / storage change. No data rewrite.
--
-- PREFLIGHT (read-only; both expected to be the legacy default after apply):
--   select count(*) from session_blocks where numbing_status is not null;       -- 0 before apply
--   select count(*) from session_blocks where probe_lot_confirmed is true;      -- 0 before apply
--
-- Idempotent (add column if not exists; drop+add the CHECK). DO NOT apply to
-- production until explicitly approved after merge.

alter table public.session_blocks
  add column if not exists numbing_status text,
  add column if not exists probe_lot_confirmed boolean not null default false;

-- numbing_status allowlist (NULL = not recorded). Mirrors the app vocabulary in
-- lib/sessions/clinical-response.ts.
alter table public.session_blocks drop constraint if exists session_blocks_numbing_status_check;
alter table public.session_blocks add constraint session_blocks_numbing_status_check
  check (numbing_status is null or numbing_status in ('none', 'used'));
