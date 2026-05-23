-- Migration 0029 (part 1): DB-level double-booking prevention.
--
-- Adds an exclusion constraint preventing overlapping confirmed
-- appointments within a single studio. Half-open interval
-- [starts_at, ends_at) so back-to-back appointments (one ending at
-- 10:00, next starting at 10:00) are allowed.
--
-- When the constraint fires, Postgres raises sqlstate 23P01
-- (exclusion_violation). App code catches that code specifically and
-- returns a clean "slot just taken" message. A rejected booking does
-- not trigger a confirmation email.
--
-- SOLO-PRACTITIONER SCOPE: the constraint is studio-scoped on
-- purpose for the current launch model. Before enabling concurrent
-- multi-practitioner public booking, revise the predicate to
-- constrain by practitioner_id (or a bookable-resource id). This is
-- a known limitation, documented here, not a bug.
--
-- Re-runnable: btree_gist is idempotent, the constraint is dropped
-- before being re-added.

-- Step 1: enable btree_gist so uuid equality can participate in a
-- gist exclusion constraint alongside the tstzrange overlap check.
create extension if not exists btree_gist;

-- Step 2: exclusion constraint.
-- The predicate matches lib/booking/slots.ts which treats only
-- status = 'confirmed' as blocking availability. Cancelled,
-- completed, and no_show rows are excluded so the slot becomes
-- immediately re-bookable on cancellation or no-show flip.
alter table public.appointments
  drop constraint if exists no_overlapping_active_appointments_per_studio;
alter table public.appointments
  add constraint no_overlapping_active_appointments_per_studio
  exclude using gist (
    studio_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed');
