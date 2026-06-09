-- ---------------------------------------------------------------------------
-- PR #182 phase 1. Calendar feed token hash-at-rest on practitioners.
-- ---------------------------------------------------------------------------
--
-- Today (migration 0046) `practitioners.calendar_feed_token` holds the
-- raw bearer token that the private iCal subscription route reads as
-- its credential. A DB compromise would expose every active feed
-- subscription. PR #182 introduces a SHA-256 hash column alongside
-- the raw column and migrates the runtime lookup path to hash-only.
--
-- Phase 1 (this PR) is intentionally additive:
--   * NEW column: practitioners.calendar_feed_token_hash text (nullable).
--   * NEW CHECK:  64 lowercase hex chars or NULL.
--   * NEW partial unique:
--       (calendar_feed_token_hash) WHERE calendar_feed_token_hash IS NOT NULL.
--   * BACKFILL:   every existing row whose calendar_feed_token IS NOT NULL
--                  gets its hash computed via pgcrypto digest. This must
--                  run BEFORE the partial unique becomes load-bearing
--                  for the new route; doing it inside the same migration
--                  keeps it atomic.
--   * The raw column public.practitioners.calendar_feed_token is
--     KEPT for rollout safety. The settings/profile UI renders the
--     existing URL by reading the raw column on page render; nulling
--     the raw column in this PR would silently break that UI on the
--     deploy boundary. Phase 2 (a separate PR) refactors the UI to
--     show the URL only at rotation time and then nulls the raw
--     column + drops the partial unique on it. The decision is
--     recorded in docs/13 (PR #182 entry).
--
-- pgcrypto note: Supabase installs pgcrypto in the `extensions`
-- schema. The schema-qualified `extensions.digest(...)` call follows
-- the precedent from migration 0032 (finalize_card_required_public
-- _booking) and is safe under the hardened search_path. pgcrypto
-- itself is created in migration 0001 (`create extension if not
-- exists "pgcrypto"`), so this migration does NOT re-create it.
--
-- Safety:
--   * NO destructive DML. The only UPDATE writes the hash on existing
--     rows where it is null; the raw token is read but not modified.
--   * NO RLS change. The feed route + settings actions already use
--     the service-role admin client.
--   * NO payment table touched. paymentIntents.create / refunds.create
--     gates remain at 2 / 1 (lib/billing/manual-fee-charge.ts +
--     lib/billing/session-payment-charge.ts + lib/billing/payment-
--     refund.ts).
--   * NO live-mode CHECK relaxed.
--   * Re-runnable: add column uses IF NOT EXISTS; the CHECK uses
--     DROP+ADD; the partial unique uses CREATE UNIQUE INDEX IF NOT
--     EXISTS; the UPDATE backfill is idempotent because it filters on
--     calendar_feed_token_hash IS NULL.
--
-- Migration ledger: latest in tree was 0078 (PR #178 refund columns).
-- This is 0079.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) Column.
-- ============================================================
alter table public.practitioners
  add column if not exists calendar_feed_token_hash text;

-- ============================================================
-- 2) Backfill from existing raw tokens. Uses pgcrypto digest in the
--    extensions schema (Supabase default install location). The
--    encoded hex is lowercase by Postgres convention. The WHERE
--    clause keeps the migration re-runnable: rerunning is a no-op
--    because every row that has a non-null raw token will already
--    have its hash populated after the first run.
-- ============================================================
update public.practitioners
   set calendar_feed_token_hash =
       encode(extensions.digest(calendar_feed_token, 'sha256'), 'hex')
 where calendar_feed_token is not null
   and calendar_feed_token_hash is null;

-- ============================================================
-- 3) Format CHECK constraint. 64 lowercase hex characters or NULL.
--    DROP+ADD keeps the migration re-runnable.
-- ============================================================
alter table public.practitioners
  drop constraint if exists practitioners_calendar_feed_token_hash_check;
alter table public.practitioners
  add constraint practitioners_calendar_feed_token_hash_check
    check (
      calendar_feed_token_hash is null
      or calendar_feed_token_hash ~ '^[a-f0-9]{64}$'
    );

-- ============================================================
-- 4) Partial unique on the hash. Same shape as the existing
--    practitioners_calendar_feed_token_uniq on the raw column
--    (migration 0046). The runtime feed route looks up rows by
--    this index after PR #182 phase 1's code merge.
-- ============================================================
create unique index if not exists practitioners_calendar_feed_token_hash_uniq
  on public.practitioners (calendar_feed_token_hash)
  where calendar_feed_token_hash is not null;
