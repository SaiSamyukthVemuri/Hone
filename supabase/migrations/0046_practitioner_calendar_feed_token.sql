-- ===========================================================================
-- Migration 0046: practitioner calendar feed token (read-only ICS feed)
-- ===========================================================================
--
-- Purpose
-- -------
-- Per-practitioner secret token used as the path segment for a private
-- iCal/ICS subscription feed at /calendar-feed/<token>.ics. The feed is
-- one-way and read-only; nothing is imported from Google Calendar, no
-- OAuth, no Google API keys, no two-way sync.
--
-- Token semantics
-- ---------------
--   * High-entropy random string (base64url of 32 random bytes) generated
--     in app code via Node's crypto module.
--   * Stored verbatim in this column. Anyone who possesses the token can
--     fetch the feed (Google Calendar fetches it server-side, unauthenticated).
--   * Unique across practitioners so the feed route can resolve token -> row.
--   * Nullable: a practitioner has no feed until they explicitly create one.
--     Rotating the token is implemented as an UPDATE that replaces the
--     value; the old token immediately stops resolving.
--
-- This migration is ADDITIVE only:
--   * practitioners gains ONE nullable unique text column.
--
-- It does NOT:
--   * add any Google OAuth / Google API / refresh-token / access-token field
--   * add any external event id, sync status, or conflict-detection field
--   * touch Stripe / payment tables
--   * change appointments / sessions / treatment / TTT / postcare tables
--   * change RLS on practitioners (token is read by the feed route via the
--     service-role admin client; RLS for authenticated reads is unchanged)
--
-- Re-runnable: ADD COLUMN uses IF NOT EXISTS; the unique constraint is
-- guarded by a CREATE UNIQUE INDEX IF NOT EXISTS.
-- ---------------------------------------------------------------------------

alter table public.practitioners
  add column if not exists calendar_feed_token text;

-- Unique partial index. Postgres treats multiple NULLs as distinct under
-- a plain UNIQUE constraint, so a partial unique index over non-null
-- values is the right enforcement primitive when most rows will have
-- token = NULL.
create unique index if not exists practitioners_calendar_feed_token_uniq
  on public.practitioners (calendar_feed_token)
  where calendar_feed_token is not null;
