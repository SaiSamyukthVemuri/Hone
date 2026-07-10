-- 0116_drop_calendar_feed_raw_token.sql
--
-- Store the calendar-feed credential HASH-ONLY at rest.
--
-- Migration 0079 added practitioners.calendar_feed_token_hash and BACKFILLED it
-- from the raw token, and the feed route (app/calendar-feed/[token]/route.ts)
-- authenticates by HASH only (it hashes the raw token from the URL and matches
-- calendar_feed_token_hash). So dropping the raw calendar_feed_token column:
--   * does NOT break existing subscription URLs — the URL still carries the raw
--     token, the route hashes it and matches the stored hash — and forces NO
--     reconnect; and
--   * removes the only same-studio-member-readable feed CREDENTIAL. The
--     surviving hash is one-way (not a usable URL), so a peer can no longer
--     read another practitioner's usable feed token.
-- The raw token is now surfaced only ONCE, at generate/rotate, from the server
-- action's return value (never re-read from the DB, never logged/exported).
--
-- This is the planned follow-up to 0079 (see its header). Destructive of the
-- raw column ONLY. Idempotent. Migration max 0115 -> 0116.
--
-- >>> ORDERING (migration-first exception): this is a DESTRUCTIVE drop of a
-- column the PREVIOUSLY-DEPLOYED code still WRITES (rotate/clear set
-- calendar_feed_token). Apply this migration ONLY AFTER the accompanying
-- hash-only code is merged + deployed, otherwise the old code's rotate/clear
-- UPDATE would error on the dropped column in the apply→deploy window. Existing
-- feed subscriptions keep working regardless (route reads the hash). <<<

-- The partial unique index on the raw column (0046) goes with the column.
drop index if exists public.practitioners_calendar_feed_token_uniq;

alter table public.practitioners
  drop column if exists calendar_feed_token;
