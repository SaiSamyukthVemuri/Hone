-- Migration 0012: Add hairs_treated to electrolysis_entries.
-- Some Apilus machines report total hairs treated per session segment; this
-- is a manual entry field where the machine doesn't auto-track it.
-- Re-runnable: drop constraint preceded by drop-if-exists.

alter table public.electrolysis_entries
  add column if not exists hairs_treated integer;

alter table public.electrolysis_entries
  drop constraint if exists entries_hairs_treated_check;
alter table public.electrolysis_entries
  add constraint entries_hairs_treated_check
  check (hairs_treated is null or hairs_treated >= 0);
