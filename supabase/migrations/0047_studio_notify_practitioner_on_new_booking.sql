-- ===========================================================================
-- Migration 0047: per-studio practitioner new-booking notification toggle
-- ===========================================================================
--
-- Adds a single column controlling whether the practitioner/owner
-- receives the "New booking" notification email when a booking is
-- created. Default true preserves existing behavior; studios that
-- find the operational email noisy can turn it off.
--
-- This setting controls ONLY the practitioner notification. It does
-- not affect:
--   * client confirmation email (gated by send_confirmation_emails)
--   * intake link inside the confirmation email
--   * 24h / 2h reminder emails
--   * cancellation / reschedule emails
--   * postcare emails
--   * any booking-creation behavior
--
-- This migration is ADDITIVE only:
--   * studios gains ONE non-nullable boolean column with default true,
--     so existing rows backfill to true automatically.
--
-- It does NOT:
--   * touch Stripe / payment tables
--   * touch require_card_on_file
--   * change appointments / sessions / treatment / TTT / postcare tables
--   * change RLS
--
-- Re-runnable: ADD COLUMN uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

alter table public.studios
  add column if not exists notify_practitioner_on_new_booking
    boolean not null default true;
