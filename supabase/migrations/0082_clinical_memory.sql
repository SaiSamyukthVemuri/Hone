-- 0082: Clinical memory moat, phase 1 (PR #190).
--
-- Hone captures treatment SETTINGS deeply (mode, energy, minutes,
-- structured area 0039, structured probe 0041, split readings 0042)
-- but client tolerance, skin response, and caution lived only in free
-- text, and there was no structured way to leave a note for the next
-- visit. This migration adds both halves of the returning-client
-- memory:
--
--   * per-block structured response capture on session_blocks
--     (tolerance_rating, reaction_type, reaction_notes,
--     caution_for_next_session, caution_note)
--   * a per-session forward-looking note on sessions
--     (next_session_note), surfaced on the client's NEXT visit
--
-- Everything is nullable or safely defaulted: every existing session
-- and block remains valid, old rows simply render without the new
-- lines. No RLS change: both tables keep their studio-member
-- policies, which are table-level and cover new columns
-- automatically. No index: the columns are read via existing
-- session/block lookups, never searched.

-- Step 1: session_blocks response columns.
-- ---------------------------------------------------------------------------
alter table public.session_blocks
  add column if not exists tolerance_rating smallint,
  add column if not exists reaction_type text,
  add column if not exists reaction_notes text,
  add column if not exists caution_for_next_session boolean not null default false,
  add column if not exists caution_note text;

-- Tolerance is a 1 (struggled) to 5 (very comfortable) scale.
alter table public.session_blocks
  drop constraint if exists session_blocks_tolerance_rating_check;
alter table public.session_blocks
  add constraint session_blocks_tolerance_rating_check
  check (tolerance_rating is null or tolerance_rating between 1 and 5);

-- Reaction is an allowlisted vocabulary; free detail goes in
-- reaction_notes. Kept in sync with lib/sessions/clinical-response.ts.
alter table public.session_blocks
  drop constraint if exists session_blocks_reaction_type_check;
alter table public.session_blocks
  add constraint session_blocks_reaction_type_check
  check (
    reaction_type is null
    or reaction_type in (
      'none',
      'mild_redness',
      'moderate_redness',
      'swelling',
      'sensitivity',
      'irritation',
      'other'
    )
  );

comment on column public.session_blocks.tolerance_rating is
  'How the client tolerated this block, 1 (struggled) to 5 (very comfortable). Optional.';
comment on column public.session_blocks.reaction_type is
  'Allowlisted skin/client response vocabulary; detail in reaction_notes. Optional.';
comment on column public.session_blocks.caution_for_next_session is
  'Flag: something to watch at the next visit. caution_note carries the detail.';

-- Step 2: sessions.next_session_note.
-- ---------------------------------------------------------------------------
alter table public.sessions
  add column if not exists next_session_note text;

comment on column public.sessions.next_session_note is
  'Practitioner plan for the NEXT visit, written while charting this one. Surfaced as "From last visit" context when the client returns. Optional.';
