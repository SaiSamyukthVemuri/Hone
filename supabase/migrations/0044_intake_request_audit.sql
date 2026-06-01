-- Migration 0044: practitioner-triggered intake reissue audit columns.
--
-- Adds two nullable columns to client_intake_forms so a row that was
-- created by a practitioner clicking "Request intake update" can be
-- distinguished from a row created by the booking-confirmation flow,
-- and the practitioner who triggered it can be surfaced in history.
--
-- Both columns are NULLABLE. Existing rows keep their values (null);
-- the booking-confirmation path is NOT changed to populate them. A
-- null requested_at means "client-driven" (booking flow); a non-null
-- value means "practitioner-driven".
--
-- No status enum change. No token format change. No RLS change. No
-- delete/archive system. No constraint changes. Re-runnable.

alter table public.client_intake_forms
  add column if not exists requested_at timestamptz,
  add column if not exists requested_by uuid
    references public.practitioners(id) on delete set null;

-- No index here: the new columns are read on per-client history pages
-- (which already filter by studio_id + client_id and read every row)
-- and never used in a WHERE clause that needs an index.
