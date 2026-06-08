-- Migration 0073. Canonical payment_charge_attempts table.
-- PR #171. Creates a NEW dormant table that will become the
-- canonical charge ledger for all three reasons defined in PR
-- #169:
--
--   session_payment        -- charge after a completed treatment
--                             session; practitioner-confirmed
--                             amount; off-session against the
--                             saved card.
--   late_cancellation_fee  -- charge per the studio's policy when
--                             the client cancels inside the
--                             cancellation window.
--   no_show_fee            -- charge per the studio's policy when
--                             the client does not attend.
--
-- Why a separate table from manual_fee_charge_attempts:
--   The patched PR #171 prompt is explicit: do NOT touch the
--   existing manual_fee_charge_attempts runtime. Migrating the
--   proven test-mode path (lib/billing/manual-fee-charge.ts +
--   the 0064/0065 row shape) into this new table would be a
--   parallel data-migration PR with its own risk surface, and
--   the patched prompt forbids that here. PR #171 ships the
--   canonical table dormant; PR #181 (future) will write the
--   first rows; the migration that unifies the two tables (or
--   formally deprecates manual_fee_charge_attempts) is a
--   separate PR that must land BEFORE live late_cancellation_fee
--   or no_show_fee charging is enabled. Docs/13 and docs/16
--   carry the dated checkpoint that gates the future live PR.
--
-- This migration changes ZERO runtime behavior. Manual fee
-- charging stays on manual_fee_charge_attempts (test-mode only
-- per migration 0065's CHECK). The new table is the schema
-- destination for the v1 session payment path (PR #181+) and
-- the eventual unified ledger. While the two tables coexist,
-- runtime fee charging stays on manual_fee_charge_attempts.
--
-- Three structural dormancy guards remain unchanged after this
-- migration:
--   1. lib/stripe/server.ts: sk_live_ keys throw unless
--      STRIPE_ALLOW_LIVE_MODE=true (unset in production).
--   2. lib/billing/manual-fee-charge.ts: runManualFeeCharge
--      short-circuits with outcome="live_mode_blocked".
--   3. manual_fee_charge_attempts.stripe_livemode = false CHECK.
-- This migration adds a fourth defense for the new table:
--   4. payment_charge_attempts.stripe_livemode = false CHECK
--      (named payment_charge_attempts_livemode_false_check so
--      the future live-enablement PR can drop or relax it
--      deliberately).

-- ============================================================
-- Table definition
-- ============================================================

create table if not exists public.payment_charge_attempts (
  id uuid primary key default gen_random_uuid(),

  -- Studio scope. ON DELETE CASCADE matches the existing payment
  -- tables (studio_payment_settings, client_payment_methods,
  -- manual_fee_charge_attempts all CASCADE on studio_id). Studio
  -- deletion is hypothetical in v1 (no code path performs it),
  -- but if it ever happens the charge attempt row is part of the
  -- studio's history and goes with it.
  studio_id uuid not null
    references public.studios(id) on delete cascade,

  -- Charge reason. The system supports exactly these three;
  -- adding a fourth (deposit, package, store credit) requires a
  -- product decision recorded in docs/13.
  charge_reason text not null
    check (charge_reason in (
      'session_payment',
      'late_cancellation_fee',
      'no_show_fee'
    )),

  -- Client + appointment + session linkage. The CHECK below
  -- enforces the per-reason rule:
  --
  --   session_payment        -> session_id required
  --                             appointment_id OPTIONAL
  --                             (see docs/16 §12.13 for the
  --                              freeform-session caveat: most
  --                              v1 session payments are
  --                              appointment-linked but the
  --                              schema does not force it so a
  --                              future chargeable freeform
  --                              session does not require a new
  --                              migration to relax the FK).
  --   late_cancellation_fee  -> appointment_id required, session_id null
  --   no_show_fee            -> appointment_id required, session_id null
  --
  client_id uuid not null,
  appointment_id uuid,
  session_id uuid
    references public.sessions(id) on delete set null,

  -- The practitioner who confirmed the charge attempt. Composite
  -- FK ties the practitioner to the studio for the same lineage
  -- guarantee manual_fee_charge_attempts uses. RESTRICT prevents
  -- losing the audit pointer to who created the attempt.
  created_by_practitioner_id uuid not null,

  -- Amount + currency. The $2,000 CAD ceiling is the patched
  -- PR #171 prompt's recommended bound; it is intentionally
  -- LARGER than manual_fee_charge_attempts' $200 cap because
  -- session payments represent the full treatment amount (which
  -- can exceed manual cancellation fees). The lower bound is
  -- strict > 0 (not >= 0 like manual_fee) because a zero-amount
  -- session_payment row is not meaningful; if there is no charge
  -- to take, no attempt row should exist.
  amount_cents integer not null
    check (amount_cents > 0 and amount_cents <= 200000),
  currency text not null default 'cad'
    check (currency in ('cad')),

  -- Status machine. Mirrors manual_fee_charge_attempts exactly
  -- (CHECK list copied from migration 0064). The future
  -- runChargeAttempt helper (PR #181) reuses the proven status
  -- transitions: ready -> pending_stripe -> succeeded|failed,
  -- plus terminal cancelled and reserved blocked.
  status text not null default 'ready'
    check (status in (
      'ready',
      'blocked',
      'cancelled',
      'pending_stripe',
      'succeeded',
      'failed'
    )),

  -- Card-on-file pointer. RESTRICT matches manual_fee. The
  -- column is nullable because the patched PR #171 prompt
  -- preserves a future practitioner-recovery path; the
  -- application action layer enforces non-null on every normal
  -- charge prepare.
  client_payment_method_id uuid
    references public.client_payment_methods(id) on delete restrict,

  -- Card authorization signature pointer. RESTRICT matches
  -- manual_fee. Nullable per the patched PR #171 prompt: this
  -- migration only ships the schema; PR #181 (execution) refuses
  -- to charge unless lib/consent/current-card-authorization
  -- :getCardAuthorizationStatus returns signed_current AND
  -- stamps the matching signature id on the row.
  card_authorization_signature_id uuid
    references public.client_consent_signatures(id) on delete restrict,

  -- Stripe identifiers. All nullable; populated by the charge
  -- helper as the lifecycle progresses. The partial unique
  -- indexes below enforce duplicate-prevention.
  stripe_account_id text,
  stripe_livemode boolean not null default false,
  stripe_customer_id text,
  stripe_payment_method_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  -- Deterministic idempotency key built by the future helper as
  -- 'hone:<charge_reason>:<attempt_id>:v1'. The shape mirrors
  -- lib/billing/manual-fee-charge.ts:buildIdempotencyKey but
  -- carries the reason in the namespace so the same Stripe
  -- account cannot accidentally see two reasons share a key.
  stripe_idempotency_key text,
  stripe_status text,

  -- Lifecycle timestamps. Mirror manual_fee.
  charged_at timestamptz,
  failed_at timestamptz,
  failure_code text
    check (failure_code is null or char_length(failure_code) <= 100),
  failure_message_safe text
    check (failure_message_safe is null or char_length(failure_message_safe) <= 1000),
  cancelled_at timestamptz,
  cancelled_by_practitioner_id uuid
    references public.practitioners(id) on delete restrict,
  cancelled_reason text
    check (cancelled_reason is null or char_length(cancelled_reason) between 1 and 500),

  -- Operator note. The future practitioner-side Prepare flow
  -- requires a short note explaining why the charge is being
  -- prepared (same shape as manual_fee.internal_note).
  internal_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite client FK ties the client to the studio for the
  -- same lineage guarantee manual_fee uses. RESTRICT prevents
  -- losing the audit pointer.
  constraint payment_charge_attempts_client_studio_fk
    foreign key (client_id, studio_id)
    references public.clients(id, studio_id) on delete restrict,

  -- Composite appointment FK (nullable column; deferred to row
  -- existence by Postgres). RESTRICT prevents losing the
  -- appointment audit pointer for fee rows; on session_payment
  -- rows the column may be null and the FK simply does not
  -- evaluate.
  constraint payment_charge_attempts_appointment_studio_fk
    foreign key (appointment_id, studio_id)
    references public.appointments(id, studio_id) on delete restrict,

  -- Composite practitioner FK matches the pattern from
  -- manual_fee.confirmed_by_practitioner_id.
  constraint payment_charge_attempts_created_by_practitioner_studio_fk
    foreign key (created_by_practitioner_id, studio_id)
    references public.practitioners(id, studio_id) on delete restrict,

  -- ============================================================
  -- The patched PR #171 prompt's CHECK exactly. Pins the v1
  -- charge-shape invariant:
  --   session_payment        -> session_id required
  --                             appointment_id optional (freeform
  --                             sessions allowed)
  --   late_cancellation_fee  -> appointment_id required, session_id null
  --   no_show_fee            -> appointment_id required, session_id null
  -- ============================================================
  constraint payment_charge_attempts_reason_shape_check check (
    (
      charge_reason = 'session_payment'
      and session_id is not null
    )
    or
    (
      charge_reason in ('late_cancellation_fee', 'no_show_fee')
      and appointment_id is not null
      and session_id is null
    )
  ),

  -- ============================================================
  -- Named livemode dormancy CHECK. The future live-enablement
  -- PR (per docs/16 §11 + §12.13: PR #178 for fees, PR #183 for
  -- session_payment) must drop or replace THIS constraint
  -- deliberately. The constraint name is the search anchor.
  -- ============================================================
  constraint payment_charge_attempts_livemode_false_check
    check (stripe_livemode = false)
);

comment on table public.payment_charge_attempts is
  'Canonical charge ledger for session_payment, late_cancellation_fee, no_show_fee. DORMANT in PR #171; first writes land in PR #181 (test mode only). Runtime fee charging stays on manual_fee_charge_attempts until a future PR migrates or formally deprecates it; live fee charging is gated until that unification ships. See docs/16 §12.';
comment on column public.payment_charge_attempts.appointment_id is
  'Nullable for session_payment by design (freeform sessions not blocked by schema). Required for late_cancellation_fee and no_show_fee via the reason_shape_check CHECK constraint.';
comment on column public.payment_charge_attempts.session_id is
  'Required for session_payment. Forbidden (must be null) for late_cancellation_fee and no_show_fee.';
comment on column public.payment_charge_attempts.card_authorization_signature_id is
  'Nullable in this dormant schema PR. Execution PR (PR #181) must refuse to charge unless lib/consent/current-card-authorization:getCardAuthorizationStatus returns signed_current AND stamps the matching signature id on the row at prepare time.';

-- ============================================================
-- Indexes
-- ============================================================

-- Studio-scoped timeline. Supports "all charge attempts for this
-- studio, newest first" for an operator dashboard.
create index if not exists payment_charge_attempts_studio_created_idx
  on public.payment_charge_attempts (studio_id, created_at desc);

-- Per-client timeline.
create index if not exists payment_charge_attempts_studio_client_idx
  on public.payment_charge_attempts (studio_id, client_id, created_at desc);

-- Per-appointment lookup (fees + appointment-linked session
-- payments). Partial on the nullable column so freeform-session
-- rows do not pay an index hit.
create index if not exists payment_charge_attempts_studio_appointment_idx
  on public.payment_charge_attempts (studio_id, appointment_id, created_at desc)
  where appointment_id is not null;

-- Per-session lookup (session_payment).
create index if not exists payment_charge_attempts_studio_session_idx
  on public.payment_charge_attempts (studio_id, session_id, created_at desc)
  where session_id is not null;

-- Status + reason dashboard query: "all ready session_payment
-- attempts for this studio."
create index if not exists payment_charge_attempts_studio_status_reason_idx
  on public.payment_charge_attempts (studio_id, status, charge_reason);

-- Stripe idempotency key partial unique. Deterministic key shape
-- (hone:<reason>:<attempt_id>:v1) means a re-attempt with the
-- same id always produces the same key; Stripe's 24h replay plus
-- this unique constraint give three-layer duplicate protection
-- matching manual_fee.
create unique index if not exists payment_charge_attempts_idempotency_uniq
  on public.payment_charge_attempts (stripe_idempotency_key)
  where stripe_idempotency_key is not null;

-- Stripe PaymentIntent partial unique. One Hone row per Stripe
-- PaymentIntent.
create unique index if not exists payment_charge_attempts_pi_uniq
  on public.payment_charge_attempts (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- Stripe Charge id (non-unique because a PaymentIntent can
-- produce multiple charges in some edge cases; the PI uniq above
-- is the load-bearing dedup).
create index if not exists payment_charge_attempts_charge_id_idx
  on public.payment_charge_attempts (stripe_charge_id)
  where stripe_charge_id is not null;

-- Card-on-file pointer (for "which attempts used this card?").
create index if not exists payment_charge_attempts_payment_method_idx
  on public.payment_charge_attempts (client_payment_method_id)
  where client_payment_method_id is not null;

-- Card authorization signature pointer (for "which attempts
-- used this signature?" -- audit trail for legal review).
create index if not exists payment_charge_attempts_card_auth_sig_idx
  on public.payment_charge_attempts (card_authorization_signature_id)
  where card_authorization_signature_id is not null;

-- Duplicate-prepare protection for fee reasons. Partial unique
-- on (appointment_id, charge_reason) where the row is in an
-- "active" status -- matches the manual_fee_charge_attempts
-- _active_per_appt_type pattern. Scoped to fee reasons only so
-- a session_payment row that also has an appointment_id does
-- not collide with a fee row on the same appointment.
create unique index if not exists payment_charge_attempts_active_fee_per_appointment_uniq
  on public.payment_charge_attempts (appointment_id, charge_reason)
  where appointment_id is not null
    and charge_reason in ('late_cancellation_fee', 'no_show_fee')
    and status in ('ready', 'pending_stripe', 'succeeded');

-- Duplicate-prepare protection for session_payment. One active
-- session_payment per session. The future helper enforces this
-- at the application layer too; the partial unique is the
-- structural backstop.
create unique index if not exists payment_charge_attempts_active_session_payment_uniq
  on public.payment_charge_attempts (session_id)
  where session_id is not null
    and charge_reason = 'session_payment'
    and status in ('ready', 'pending_stripe', 'succeeded');

-- ============================================================
-- updated_at touch trigger. Mirrors manual_fee_charge_attempts.
-- ============================================================

create or replace function public.payment_charge_attempts_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_charge_attempts_touch_updated_at_trg
  on public.payment_charge_attempts;
create trigger payment_charge_attempts_touch_updated_at_trg
  before update on public.payment_charge_attempts
  for each row
  execute function public.payment_charge_attempts_touch_updated_at();

-- ============================================================
-- RLS. Mirrors manual_fee_charge_attempts (0064):
--   * studio members can SELECT.
--   * No INSERT/UPDATE/DELETE policy: all mutations go through
--     the service_role admin client in the future helper.
--   * Soft-cancel via status='cancelled' is the only retirement
--     path; no row is ever deleted under normal operation.
-- ============================================================

alter table public.payment_charge_attempts enable row level security;

drop policy if exists "payment_charge_attempts_member_read"
  on public.payment_charge_attempts;
create policy "payment_charge_attempts_member_read"
  on public.payment_charge_attempts
  for select
  using (public.is_studio_member(studio_id));

-- ============================================================
-- Verification (run manually after `supabase db push --linked`):
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='payment_charge_attempts'
--   order by ordinal_position;
--   -- expect: every column above, with the nullability shown
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid='public.payment_charge_attempts'::regclass
--   order by conname;
--   -- expect: the named CHECKs + FKs
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname='public' and tablename='payment_charge_attempts'
--   order by indexname;
--   -- expect: every index above
--
--   select count(*) from public.payment_charge_attempts;
--   -- expect: 0 (table is dormant; first writes land in PR #181)
--
--   select polname, polcmd, polqual::text
--   from pg_policy
--   where polrelid='public.payment_charge_attempts'::regclass;
--   -- expect: payment_charge_attempts_member_read | r | is_studio_member(studio_id)
-- ============================================================
