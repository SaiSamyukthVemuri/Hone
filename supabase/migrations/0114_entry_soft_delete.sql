-- 0114_entry_soft_delete.sql
--
-- Audited soft-delete ("Remove/void pass") for treatment PASSES.
--
-- A treatment AREA is a session_block (soft-deletable via deleted_at/deleted_by/
-- delete_reason since 0019). A single PASS within an area is an
-- electrolysis_entries / laser_entries row. Until now those pass rows had NO
-- soft-delete column, so the only way to remove a mistaken pass was a HARD
-- delete (deleteElectrolysisEntryAction / deleteLaserEntryAction) that
-- permanently destroyed the clinical record with no audit trail. This migration
-- gives pass rows the SAME audited soft-delete triad as session_blocks so a
-- practitioner can remove one pass without losing the record, the area, or the
-- session.
--
-- SAFE BY DEFAULT:
--   * Fully ADDITIVE — three nullable columns per table, plus two partial
--     indexes. No existing row is touched (deleted_at defaults NULL = active).
--   * NO backfill.
--   * NO RLS change here. (The app reads entries via `select *` / explicit
--     column lists; before this migration the columns are simply absent and the
--     code treats every existing row as active. The read paths that must now
--     filter `deleted_at is null` are updated in the accompanying code PR, which
--     ships AFTER this migration is applied and verified — migration-first.)
--   * NO hard delete is introduced or required; the code PR converts the entry
--     delete actions to soft-delete updates.
--
-- deleted_by references practitioners(id) ON DELETE SET NULL so removing a
-- practitioner never cascades away a clinical pass row (matches session_blocks,
-- 0019:36). delete_reason mirrors session_blocks.delete_reason.
--
-- Idempotent via `if not exists` everywhere. Migration max 0113 -> 0114.

alter table public.electrolysis_entries
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid references public.practitioners(id) on delete set null,
  add column if not exists delete_reason text;

alter table public.laser_entries
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid references public.practitioners(id) on delete set null,
  add column if not exists delete_reason text;

-- Active-row lookup indexes (mirror the session_blocks partial-index pattern,
-- 0019:43-49): the common read is "active passes for this block / session".
create index if not exists electrolysis_entries_active_idx
  on public.electrolysis_entries (block_id)
  where deleted_at is null;

create index if not exists laser_entries_active_idx
  on public.laser_entries (session_id)
  where deleted_at is null;
