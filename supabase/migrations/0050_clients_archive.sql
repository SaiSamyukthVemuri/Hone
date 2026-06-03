-- ===========================================================================
-- Migration 0050: client archive (test/duplicate cleanup)
-- ===========================================================================
--
-- Adds soft-archive support to public.clients so practitioners can
-- remove test clients and duplicate-entry clients from active lists
-- and searches without destroying clinical history. Archive is a
-- timestamp-based soft delete: the row stays in the table, every
-- foreign-key reference (appointments, sessions, intake forms,
-- treatment plans, etc.) keeps working, and queries that surface the
-- "active" client list filter on archived_at IS NULL.
--
-- This is intentionally NOT a hard delete. Hard delete against the
-- clinical history graph (sessions, electrolysis_entries, laser_entries,
-- audit rows on intake/postcare, treatment_plan_stages, etc.) is data
-- destruction with no operational upside for Chloe's actual use cases
-- (test clients during pilot setup and duplicate-entry clients from
-- a typo). Archive solves both without losing the clinical record.
--
-- Two columns + one index:
--
--   1. archived_at timestamptz null
--      When non-null, the client is hidden from active client lists,
--      search pickers, and birthday surfaces. The detail page
--      (/clients/[id]) intentionally still resolves so the
--      practitioner can navigate to an archived client to view their
--      historical records or to un-archive.
--
--   2. archived_by uuid null
--      Practitioner who performed the archive. ON DELETE SET NULL so a
--      practitioner row that is later removed does not cascade-delete
--      the historical archive marker on every client they touched.
--
--   3. Partial index on (studio_id, name) WHERE archived_at IS NULL
--      The active-clients query is the hot path. The partial index
--      keeps it small even as archived test rows accumulate.
--
-- This migration is ADDITIVE only:
--   * clients gains TWO nullable columns.
--   * one partial index.
--
-- It does NOT:
--   * touch any existing column or constraint
--   * touch appointments / sessions / intake / treatment plans / audit
--   * change RLS
--   * write any rows; existing rows take the column defaults (null,
--     meaning every existing client is treated as active, which is the
--     current behaviour)
--   * touch Stripe / payment / require_card_on_file
--
-- Re-runnable: ADD COLUMN uses IF NOT EXISTS, CREATE INDEX uses
-- IF NOT EXISTS. A second run is a no-op.
-- ---------------------------------------------------------------------------

alter table public.clients
  add column if not exists archived_at  timestamptz,
  add column if not exists archived_by  uuid;

-- Conditional FK add so a re-run does not error if the constraint
-- already exists. We do not use the inline REFERENCES on the ADD
-- COLUMN above because PostgreSQL's IF NOT EXISTS check is per-column,
-- not per-constraint.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_archived_by_fkey'
  ) then
    alter table public.clients
      add constraint clients_archived_by_fkey
      foreign key (archived_by)
      references public.practitioners(id)
      on delete set null;
  end if;
end
$$;

-- Hot-path index for the active clients list (Settings -> Clients,
-- ClientSearch picker in the calendar quick-book, birthday surface on
-- the dashboard). Ordered by (studio_id, name) because the list query
-- is per-studio sorted by name. The WHERE clause keeps the index small
-- as archived test rows accumulate.
create index if not exists idx_clients_active
  on public.clients (studio_id, name)
  where archived_at is null;
