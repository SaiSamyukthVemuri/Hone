-- ===========================================================================
-- Migration 0045: studio cancellation / no-show policy fields (C2a-core)
-- ===========================================================================
--
-- Purpose
-- -------
-- Per-studio policy text shown to clients before card-on-file collection
-- is enabled in a future release. Card collection is NOT enabled in this
-- migration. This is the policy foundation only.
--
-- Why now: the C2 SetupIntent audit identified that any saved-card flow
-- requires the studio's cancellation and no-show policy to be displayed
-- and consented to before card entry. Hone needs the policy fields to
-- exist before the consent text hash referenced by payment_consents
-- (migration 0032) has anything real to hash.
--
-- This migration is ADDITIVE only:
--   * studios gains four nullable columns
--
-- It does NOT:
--   * change studio_payment_settings or require_card_on_file
--   * write payment_consents rows
--   * touch any payment table
--   * change appointments / sessions / treatment-plan tables
--   * affect booking / public booking
--   * enable card collection
--   * change Stripe behavior in any way
--
-- Re-runnable: every ADD COLUMN uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists cancellation_policy_text  text,
  add column if not exists no_show_policy_text       text,
  add column if not exists policy_version            text,
  add column if not exists policy_updated_at         timestamptz;

-- No index here: these columns are read on per-studio settings pages
-- and on the per-studio payments readiness card, both of which already
-- filter by studio_id and never use these columns in a WHERE clause.
