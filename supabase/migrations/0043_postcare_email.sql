-- ===========================================================================
-- Migration 0043: postcare email v1
-- ===========================================================================
--
-- Purpose
-- -------
-- Enables a practitioner-triggered postcare email after a treatment
-- appointment. Owner-driven, manual, decoupled from any appointment
-- completion event (none exists in Hone today; introducing one is
-- explicitly out of scope per the postcare audit).
--
-- This migration is ADDITIVE only:
--   * appointments gains two columns for send tracking + atomic claim
--   * studios gains four columns for per-studio postcare content
--
-- It does NOT:
--   * change appointments.status semantics or values
--   * add completed_at / appointment_completed_at / session_completed_at
--   * link sessions to appointments (no sessions.appointment_id)
--   * touch public.mark_appointment_complete or revive its UI path
--   * change public.record_email_attempt (postcare bookkeeping is
--     handled inline by the send action's conditional UPDATE, which
--     also serves as the first-send race lock)
--   * affect Stripe / payments / require_card_on_file
--
-- Re-runnable: every ADD COLUMN uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- appointments: postcare send tracking
-- ---------------------------------------------------------------------------
--
-- postcare_email_sent_at IS NULL means "no postcare send has ever been
-- attempted for this appointment." The send action's atomic claim is a
-- single conditional UPDATE WHERE postcare_email_sent_at IS NULL: only
-- one of N concurrent first-send clicks finds 1 row, the rest 0.
--
-- postcare_email_send_attempts is incremented by the same UPDATE
-- (first-send) and by the unconditional resend UPDATE. Mirrors the
-- existing no_show_email_send_attempts pattern from migration 0028.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists postcare_email_sent_at        timestamptz,
  add column if not exists postcare_email_send_attempts  integer not null default 0;

-- ---------------------------------------------------------------------------
-- studios: per-studio postcare content
-- ---------------------------------------------------------------------------
--
-- All four columns are nullable text. The send action requires at least
-- postcare_aftercare_text to be non-empty before allowing a send (so a
-- studio with no postcare content set cannot send empty emails).
--
-- postcare_review_url is intentionally optional. When non-null, the
-- template renders a neutral "If you had a good experience, reviews help
-- small businesses" line + the link. There is no discount or review-
-- reward logic in v1 (see the audit).
-- ---------------------------------------------------------------------------
alter table public.studios
  add column if not exists postcare_aftercare_text               text,
  add column if not exists postcare_warning_signs_text           text,
  add column if not exists postcare_product_recommendations_text text,
  add column if not exists postcare_review_url                   text;
