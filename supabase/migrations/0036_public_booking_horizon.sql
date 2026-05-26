-- Migration 0036: Public booking horizon setting.
--
-- Adds a per-studio integer column that controls how many months ahead
-- the PUBLIC booking page (/book/[slug]) shows available slots. The
-- practitioner internal calendar-first booking flow is NOT subject to
-- this limit — the comment in lib/booking/horizon.ts is the source of
-- truth.
--
-- Allowed values: 3, 4, 6 (Chloe's stated range). Default 3, matching
-- the existing hardcoded BOOKING_HORIZON_DAYS = 90 in
-- lib/booking/horizon.ts so existing studios have no behavior change
-- on day-of-deploy.
--
-- ADD COLUMN ... NOT NULL DEFAULT for a non-volatile literal is a fast
-- metadata-only change on Postgres 11+; existing rows are filled with
-- the default without a table rewrite.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS + drop-if-exists then add for
-- the check constraint.

alter table public.studios
  add column if not exists public_booking_horizon_months integer not null default 3;

alter table public.studios
  drop constraint if exists studios_public_booking_horizon_months_check;
alter table public.studios
  add constraint studios_public_booking_horizon_months_check
  check (public_booking_horizon_months in (3, 4, 6));
