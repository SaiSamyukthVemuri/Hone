-- Migration 0074. Corrective patch to migration 0073.
--
-- PR #171 review caught a hidden inconsistency in the
-- payment_charge_attempts FK declaration: 0073 declared
--   session_id uuid references public.sessions(id) on delete set null
-- but the same migration added
--   constraint payment_charge_attempts_reason_shape_check check (
--     (charge_reason = 'session_payment' and session_id is not null)
--     or
--     (charge_reason in ('late_cancellation_fee', 'no_show_fee')
--      and appointment_id is not null and session_id is null)
--   );
-- For a session_payment row, an ON DELETE SET NULL on the parent
-- sessions row would try to null session_id and then the CHECK
-- constraint would reject the resulting state. The DELETE on
-- sessions fails with a check_violation, not a clean SET NULL.
-- That makes SET NULL a confusing hidden RESTRICT: the runtime
-- behavior is identical to RESTRICT, but the FK declaration
-- claims a different intent. The honest declaration is
-- ON DELETE RESTRICT.
--
-- The patched-prompt rationale (from the original 0073 audit)
-- still holds: sessions are immutable clinical artefacts and
-- should not be deletable while financial records reference
-- them. RESTRICT enforces that explicitly: an attempt to delete
-- a session that is the target of an active charge attempt
-- fails with the standard FK violation message, not with a
-- check_violation that obscures the real cause.
--
-- This migration drops the existing FK and re-creates it with
-- the corrected ON DELETE rule. The constraint name stays the
-- same (Postgres auto-name from 0073:
-- payment_charge_attempts_session_id_fkey) so any future PR
-- that searches for the FK by name finds the corrected
-- definition.
--
-- 0073's literal source text in the repo is preserved as the
-- historical record (it represents what was actually applied
-- on 2026-06-08); this migration is the layered correction.
-- The combined effective state after both migrations:
-- session_id is FK with ON DELETE RESTRICT.
--
-- No row-data change. The new table is dormant (0 rows in
-- production confirmed before and after this migration). No
-- runtime behavior change. No Stripe call. No PaymentIntent
-- path. No live-mode change. Manual_fee_charge_attempts
-- runtime stays untouched.
--
-- Verification (run after `supabase db push --linked`):
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.payment_charge_attempts'::regclass
--     and conname = 'payment_charge_attempts_session_id_fkey';
--   -- expect: FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT

alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_session_id_fkey;

alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_session_id_fkey
    foreign key (session_id) references public.sessions(id)
    on delete restrict;
