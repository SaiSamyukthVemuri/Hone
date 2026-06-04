-- ===========================================================================
-- Migration 0064: manual cancellation/no-show fee protection stack.
-- ===========================================================================
--
-- What this migration does
-- ------------------------
-- Adds the data plane the practitioner UI needs to safely DECIDE whether
-- to charge a manual cancellation or no-show fee, and to RECORD that
-- decision atomically with all of its evidence. This migration does NOT
-- create any Stripe charge, PaymentIntent, refund, or invoice; the
-- charge call lives in a future PR. PR #145 only builds the protection
-- stack on top of which a later charge call can run.
--
-- Why a new manual_fee_charge_attempts table rather than reusing 0032's
-- stripe_charge_attempts
-- ----------------------------------------------------------------------
-- 0032's stripe_charge_attempts has a hard FK to appointment_payments
-- (the row that records a card collected DURING booking via
-- pending_booking_payment_sessions + finalize_card_required_public_booking).
-- For the manual fee scenario, the card was collected POST-BOOKING via
-- the portal SetupIntent flow (PR #135 / migration 0058) into
-- client_payment_methods, and the appointment has no appointment_payments
-- row. Reusing stripe_charge_attempts would force us to either:
--   (a) synthesize an appointment_payments row, which violates the
--       table's pending_session/payment_consent/setup_intent NOT NULL
--       lineage; or
--   (b) loosen 0032's FK chain, which breaks the dormant-but-safe
--       Stripe charge backend that 0032 deliberately installs.
-- The new table sits parallel to stripe_charge_attempts with a status
-- machine that starts at 'ready' (the only state this PR writes) and
-- reserves the Stripe-result states for the future charge PR.
--
-- Late-cancel classification (timing_classification column)
-- ---------------------------------------------------------
-- Hone has cancellation_policy_text and no_show_policy_text on studios
-- as free-form text; there is NO structured threshold (e.g.
-- cancellation_window_hours) yet. The system therefore cannot mechanically
-- classify whether a particular cancellation crossed the studio's late
-- window. v1 stores the practitioner's manual assertion of the charge_type
-- in 'practitioner_asserted'; a future PR that adds structured threshold
-- settings can set 'system_derived' instead.
--
-- Strictly additive + idempotent. No data backfill. No destructive change.
-- Migration applied to prod BEFORE merging the application code that
-- queries these new columns and table.
-- ===========================================================================

-- --------------------------------------------------------------------
-- 1) Fee amount columns on studios
-- --------------------------------------------------------------------
-- Stored on studios (not on studio_payment_settings) because:
--   * Every studio has a row in `studios`; rows in `studio_payment_settings`
--     are created lazily during Stripe Connect onboarding (0032), so
--     a studio that has not begun Connect onboarding would have nowhere
--     to write the fee.
--   * Cancellation policy text already lives on `studios`. Co-locating
--     the amounts with the policy text keeps the "what does this studio
--     charge for a late cancel" surface in one row.
-- Both columns are nullable. NULL means 'not configured'; the eligibility
-- helper treats either NULL as a hard block reason. The 20000-cent ceiling
-- ($200) matches Sam's launch ceiling; the CHECK prevents a typo from
-- writing $20000 worth of cents.

alter table public.studios
  add column if not exists late_cancel_fee_cents integer,
  add column if not exists no_show_fee_cents     integer;

alter table public.studios
  drop constraint if exists studios_late_cancel_fee_cents_range_check;
alter table public.studios
  add constraint studios_late_cancel_fee_cents_range_check
  check (late_cancel_fee_cents is null
         or (late_cancel_fee_cents >= 0 and late_cancel_fee_cents <= 20000));

alter table public.studios
  drop constraint if exists studios_no_show_fee_cents_range_check;
alter table public.studios
  add constraint studios_no_show_fee_cents_range_check
  check (no_show_fee_cents is null
         or (no_show_fee_cents >= 0 and no_show_fee_cents <= 20000));

-- --------------------------------------------------------------------
-- 2) manual_fee_charge_attempts table
-- --------------------------------------------------------------------
-- Real-world object: one practitioner-prepared attempt to charge a
-- manual cancellation or no-show fee against a specific appointment.
-- Class: MUTABLE state with a forward-only status machine. This PR
-- writes 'ready' (the prepared/queued state) and 'cancelled' (the
-- practitioner-aborted state). The remaining states are reserved for
-- the future Stripe-charge PR.
--
-- Status machine
--   ready          -> the only state this PR creates on success.
--                     Records that the practitioner reviewed evidence
--                     and confirmed intent. No Stripe call yet.
--   blocked        -> reserved. NOT written by this PR; the action
--                     refuses to create a row at all when eligibility
--                     blocks, so a blocked row is structurally absent
--                     in v1. Future PR may decide to record blocked
--                     attempts; the value is allowed by the CHECK so
--                     that future change does not require a constraint
--                     drop.
--   cancelled      -> the practitioner withdraws a 'ready' attempt
--                     before it ever reaches Stripe.
--   pending_stripe -> reserved for the future PR. Set when the
--                     PaymentIntent has been created but no terminal
--                     response yet.
--   succeeded      -> reserved.
--   failed         -> reserved.
--
-- Lineage FKs
--   * (appointment_id, studio_id) -> appointments(id, studio_id):
--     a row cannot point at an appointment outside its studio.
--   * (client_id, studio_id) -> clients(id, studio_id): same protection
--     on the client side.
--   * (confirmed_by_practitioner_id, studio_id) -> practitioners(id, studio_id):
--     the practitioner must belong to the studio the row claims.
--   * client_payment_method_id -> client_payment_methods(id) ON DELETE
--     RESTRICT: cannot drop the card row underneath an unresolved attempt.
--     The application action also checks studio_id + client_id match.
--   * card_authorization_signature_id -> client_consent_signatures(id)
--     ON DELETE RESTRICT: the signature row is immutable per PR #134;
--     RESTRICT ensures we never lose the link from a charge attempt
--     to its authorization evidence.
--   * appointment_policy_acknowledgement_id ->
--     appointment_policy_acknowledgements(id) ON DELETE RESTRICT.
--   * policy_snapshot_hash text NOT NULL: copy of
--     appointment_policy_acknowledgements.policy_snapshot_hash captured
--     at prepare time so a later DROP of the ack row (currently blocked
--     by RESTRICT, but defence in depth) still preserves what policy
--     hash was in scope when the attempt was created.

create table if not exists public.manual_fee_charge_attempts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null,
  client_id uuid not null,
  confirmed_by_practitioner_id uuid not null,
  charge_type text not null,
  amount_cents integer not null,
  currency text not null default 'cad',
  status text not null default 'ready',
  client_payment_method_id uuid not null
    references public.client_payment_methods(id) on delete restrict,
  card_authorization_signature_id uuid not null
    references public.client_consent_signatures(id) on delete restrict,
  appointment_policy_acknowledgement_id uuid not null
    references public.appointment_policy_acknowledgements(id) on delete restrict,
  policy_snapshot_hash text not null,
  internal_note text not null,
  timing_classification text not null default 'practitioner_asserted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete restrict,
  foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  foreign key (confirmed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- --------------------------------------------------------------------
-- 3) CHECK constraints
-- --------------------------------------------------------------------

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_charge_type_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_charge_type_check
  check (charge_type in ('late_cancel', 'no_show'));

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_amount_range_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_amount_range_check
  check (amount_cents >= 0 and amount_cents <= 20000);

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_currency_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_currency_check
  check (currency in ('cad'));

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_status_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_status_check
  check (status in (
    'ready',
    'blocked',
    'cancelled',
    'pending_stripe',
    'succeeded',
    'failed'
  ));

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_timing_classification_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_timing_classification_check
  check (timing_classification in ('practitioner_asserted', 'system_derived'));

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_internal_note_length_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_internal_note_length_check
  check (char_length(internal_note) between 1 and 1000);

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_policy_hash_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_policy_hash_check
  check (char_length(policy_snapshot_hash) > 0);

-- --------------------------------------------------------------------
-- 4) Indexes (incl. duplicate-protection partial unique)
-- --------------------------------------------------------------------

create index if not exists manual_fee_charge_attempts_studio_appointment_idx
  on public.manual_fee_charge_attempts (studio_id, appointment_id, created_at desc);

create index if not exists manual_fee_charge_attempts_studio_client_idx
  on public.manual_fee_charge_attempts (studio_id, client_id, created_at desc);

-- The duplicate-protection index. At most ONE active attempt per
-- (appointment, charge_type) may exist in states that represent
-- "this charge is on the runway or already landed":
--   * ready: prepared, awaiting the future Stripe-charge action.
--   * pending_stripe: PaymentIntent in flight (reserved).
--   * succeeded: the charge already cleared (reserved).
-- A 'cancelled', 'blocked', or 'failed' row does NOT participate so
-- the practitioner can re-prepare after a withdrawn or failed attempt.
-- This prevents the double-click / two-tab race that would otherwise
-- create two ready rows; the second INSERT raises a unique violation
-- which the action surface translates to a calm error.

create unique index if not exists manual_fee_charge_attempts_active_per_appt_type
  on public.manual_fee_charge_attempts (appointment_id, charge_type)
  where status in ('ready', 'pending_stripe', 'succeeded');

-- --------------------------------------------------------------------
-- 5) RLS
-- --------------------------------------------------------------------
-- Match the posture used by 0058 (client_payment_methods) and the
-- broader consent/payment lineage: studio-member SELECT only;
-- service-role admin writes. The application calls all mutations
-- via createAdminClient() because the action layer needs to verify
-- the practitioner is studio-active before writing the row, and
-- because the FK validation against client_payment_methods is
-- service-role-readable. There is no DELETE policy; soft-cancel via
-- status='cancelled' is the only retirement path.

alter table public.manual_fee_charge_attempts enable row level security;

drop policy if exists "manual_fee_charge_attempts_member_read"
  on public.manual_fee_charge_attempts;
create policy "manual_fee_charge_attempts_member_read"
  on public.manual_fee_charge_attempts
  for select
  using (public.is_studio_member(studio_id));

-- Application path uses service_role for inserts/updates. No
-- authenticated/anon INSERT or UPDATE policy is granted.

-- --------------------------------------------------------------------
-- 6) updated_at trigger
-- --------------------------------------------------------------------

create or replace function public._touch_manual_fee_charge_attempts_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists manual_fee_charge_attempts_touch_updated_at
  on public.manual_fee_charge_attempts;
create trigger manual_fee_charge_attempts_touch_updated_at
  before update on public.manual_fee_charge_attempts
  for each row execute function public._touch_manual_fee_charge_attempts_updated_at();
