-- Migration 0097: intake link send/expiry display metadata.
--
-- Adds three nullable / default-safe columns to client_intake_forms so the
-- practitioner UI can show a smart resend status for an in-progress intake:
-- when the current link was last emailed, when it expires, and how many times
-- a link has been issued. The signed token remains the AUTHORITATIVE expiry
-- (verifyIntakeToken enforces the embedded expires_at); these columns are a
-- DISPLAY MIRROR of the most recently issued link, stamped at each mint.
--
-- Safe by construction:
--   * All additive. No column drop/rename, no data rewrite.
--   * intake_link_last_sent_at / intake_link_expires_at are NULLABLE — existing
--     rows keep NULL and the UI falls back to the started_at heuristic until
--     the next mint stamps real values.
--   * intake_link_send_count is NOT NULL DEFAULT 0 — existing rows read 0.
--   * NO raw token / token column stored (verification stays stateless).
--   * NO RLS change, NO status enum change, NO constraint change.
--   * Re-runnable (add column if not exists).

alter table public.client_intake_forms
  add column if not exists intake_link_last_sent_at timestamptz,
  add column if not exists intake_link_expires_at timestamptz,
  add column if not exists intake_link_send_count integer not null default 0;
