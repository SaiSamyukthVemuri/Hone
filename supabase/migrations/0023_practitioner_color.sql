-- Migration 0023: practitioner color token for calendar appointment pills.
-- Practitioners pick from a curated palette (8 tokens). Defaults to 'neutral'
-- which renders as the current black pill. Stored as free text so the palette
-- can grow without another migration.
--
-- Single paste block, safe to re-run.

alter table public.practitioners
  add column if not exists color text not null default 'neutral';
