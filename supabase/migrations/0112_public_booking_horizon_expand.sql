-- Migration 0112: widen the public booking horizon presets (Booking Horizon v2).
--
-- Migration 0036 constrained studios.public_booking_horizon_months to (3, 4, 6).
-- Chloe wants more flexibility, so this widens the CHECK to any whole month from
-- 1 to 12. Nothing else changes:
--   * column type (integer), NOT NULL, and DEFAULT 3 are all unchanged;
--   * existing studios keep their current value — 3/4/6 remain valid (a subset
--     of 1..12), so there is NO data change and no behavior change on deploy;
--   * the floor stays at 1 month and the ceiling at 12 months (a deliberate,
--     safe maximum — the app's next-available scan cap and recurring-break
--     materialization window derive from this same 12-month maximum, see
--     lib/booking/horizon.ts maxPublicBookingHorizonDays()).
--
-- Re-runnable: drop-if-exists then re-add the check (same idempotent pattern as
-- 0036). Additive only; no column add, no data backfill, no payment/auth tables,
-- no RLS change.

alter table public.studios
  drop constraint if exists studios_public_booking_horizon_months_check;
alter table public.studios
  add constraint studios_public_booking_horizon_months_check
  check (public_booking_horizon_months in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12));
