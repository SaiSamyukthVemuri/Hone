-- ===========================================================================
-- Migration 0032: Stripe Connect Phase 1 (Hone)
-- ===========================================================================
--
-- Purpose
-- -------
-- Installs the database foundation for the first payments milestone:
-- collecting a card on file at booking, then charging the saved card
-- after the practitioner marks the appointment complete.
--
-- Architecture
-- ------------
-- * Direct Charges on legacy Stripe Express connected accounts
--   (type='express').
-- * V1 omits application_fee_amount from the PaymentIntent body:
--   create_or_claim_charge_attempt enforces application_fee_cents=0
--   in SQL, and the application MUST NOT pass application_fee_amount
--   when calling stripe.paymentIntents.create.
-- * V1 currency is CAD only; enforced in studio_payment_settings
--   default_charge_currency and re-checked at charge creation.
-- * Stripe processing fees are borne by the studio per legacy
--   Express + Direct Charge fee economics.
-- * Dispute fee allocation is INTENTIONALLY NOT ASSUMED by this
--   migration. It remains a live-launch verification item; do not
--   add code or comments that claim a specific side bears dispute
--   fees until verified end-to-end against a Stripe live test.
--
-- Data isolation and access boundary
-- ----------------------------------
-- * All Stripe-aware state lives in 14 dedicated payment tables
--   created below. RLS is enabled on every one with NO policies for
--   anon or authenticated. There are NO direct authenticated table
--   reads or writes against raw payment tables.
-- * Mutation RPCs are SECURITY DEFINER, schema-qualify every
--   reference as public.* / pg_catalog.* / extensions.*, run under
--   set search_path = pg_catalog, pg_temp, and grant EXECUTE only
--   to service_role.
-- * Display-safe read RPCs check is_studio_owner internally and
--   grant EXECUTE to authenticated.
-- * Private helpers (_append_stripe_payment_audit,
--   _recompute_payment_status) revoke EXECUTE from EVERY role
--   including service_role; they are reachable only via the
--   SECURITY DEFINER chain from other RPCs in this file.
--
-- Charging model
-- --------------
-- * Owner-triggered charge ONLY. create_or_claim_charge_attempt
--   re-checks the active-owner predicate in SQL; do not rely on
--   the application layer alone.
-- * The appointment must be in status='completed' (a deliberate
--   two-action separation: mark_appointment_complete first, then
--   create_or_claim_charge_attempt). The treatment end time must
--   have already passed.
-- * Card-on-file is collected at booking via SetupIntent. Consent
--   is persisted BEFORE the SetupIntent client_secret reaches the
--   browser (APPLICATION CONTRACT).
-- * Recovery for authentication_required charges happens on a
--   Hone-hosted PaymentElement page using the existing
--   PaymentIntent. Recovery URLs carry a hashed lookup token and
--   NEVER carry a Stripe client_secret.
--
-- Refund model
-- ------------
-- * Hone UI supports FULL REFUNDS ONLY in V1.
--   create_or_claim_refund_attempt refuses if any refund attempt
--   or stored Stripe refund row is pending / requires_action /
--   succeeded on the target charge, and refuses to refund a
--   remainder after any external partial refund.
-- * Refunds initiated outside Hone (Stripe Dashboard, support
--   actions) are reflected through stripe_refunds with
--   source='stripe_dashboard_observed' so the local ledger stays
--   complete without overstepping into application-initiated
--   semantics.
--
-- Failure-mode coverage
-- ---------------------
-- * Double charges: detected via partial unique index
--   one_primary_success_per_appointment. The losing INSERT becomes
--   succeeded_duplicate, never a second 'succeeded'. Resolution
--   requires PROOF (a full refund of the exact duplicate
--   stripe_charge_id) before status flips out of double_charged.
-- * Disputes: stripe_disputes models the full dispute lifecycle.
-- * Abandoned SetupIntents and orphaned saved PaymentMethods:
--   pending_booking_payment_sessions.status = 'cleanup_required'
--   is the SINGLE DURABLE RETRY QUEUE that owns every Stripe
--   paymentMethods.detach. Expiry sweep, late-SetupIntent webhook
--   (including after the row was previously marked cleaned with
--   no PM), missing-consent webhook, AND finalization failure ALL
--   route into 'cleanup_required'. A claim_payment_method_cleanup_sessions
--   call stamps a claim_token, the worker calls Stripe detach,
--   and mark_session_cleaned (with that exact token) records the
--   outcome. Failed detach leaves the row 'cleanup_required' and
--   instantly re-claimable. No code path performs Stripe detach
--   outside this loop.
-- * Recovery links: payment_recovery_tokens are hashed, bound to
--   exactly one charge attempt in 'authentication_required'
--   state, carry the full (account, mode) lineage as FK columns,
--   and are single-use.
--
-- APPLICATION CONTRACT (NOT enforced in SQL)
-- ------------------------------------------
-- * Webhook router: reconcile_refund_event is fed ONLY by
--   refund.created / refund.updated / refund.failed events.
--   charge.refunded is a SUMMARY / recheck event; the router MUST
--   NOT iterate its embedded refunds list into
--   reconcile_refund_event. (See dependency checklist at end of
--   file.)
-- * SetupIntent client_secret is delivered to the browser only
--   AFTER record_payment_consent_for_session has succeeded.
-- * application_fee_amount is omitted from the PaymentIntent body
--   in V1.
-- * Money infrastructure is reviewed (Sam + ChatGPT SQL-level
--   review) before apply. This file is intentionally applied via
--   the Supabase SQL editor; the Supabase CLI is NOT in the loop.
--
-- Migrations 0029, 0030, 0031 are NOT modified by this migration.
--
-- ===========================================================================
-- Payment status precedence (encoded in _recompute_payment_status)
-- ===========================================================================
--   reconciliation_required  (any structural impossibility)
--   > double_charged         (unresolved succeeded_duplicate exists)
--   > disputed               (open dispute exists)
--   > charged | partially_refunded | refunded
--                            (derived from net captured vs intended)
--   > authentication_required
--   > failed
--   > method_saved
--
-- An unresolved duplicate charge outranks disputes and refunds
-- because it is a guaranteed client-impacting incident that demands
-- operator attention even if a dispute or refund is already moving
-- against the primary charge.
--
-- Double-charge state machine
-- ---------------------------
--   - One primary 'succeeded' row per appointment (partial unique
--     index one_primary_success_per_appointment).
--   - Concurrent reconcile attempts that would produce a second
--     'succeeded' catch unique_violation and mark themselves
--     'succeeded_duplicate' (NEVER a second 'succeeded').
--   - Identifier conflicts (PI/Charge ID collision) route to
--     'identifier_conflict' result, NEVER to succeeded_duplicate.
--   - resolve_double_charge_incident requires PROOF: a full refund
--     of the exact duplicate stripe_charge_id must exist before
--     status flips out of double_charged.

begin;

-- ===========================================================================
-- Block 0: extension schema diagnostic.
-- ===========================================================================
-- pgcrypto's gen_random_bytes is called from
-- finalize_card_required_public_booking under hardened
-- search_path = pg_catalog, pg_temp, so the reference MUST be
-- schema-qualified. Supabase's default install places pgcrypto in
-- the 'extensions' schema; this block asserts that assumption at
-- migration apply time. If a future install places pgcrypto
-- elsewhere, edit BOTH this assertion and the
-- extensions.gen_random_bytes(...) call site below.
do $block0$
declare
  v_pgcrypto_schema name;
begin
  select n.nspname into v_pgcrypto_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';
  if not found then
    raise exception 'pgcrypto extension is not installed; required for gen_random_bytes'
      using errcode = '42704';
  end if;
  if v_pgcrypto_schema <> 'extensions' then
    raise exception
      'pgcrypto is installed in schema %, but migration 0032 expects ''extensions''. Edit gen_random_bytes references and this assertion before applying.',
      v_pgcrypto_schema
      using errcode = '42704';
  end if;
end
$block0$;

-- ===========================================================================
-- Block 0.1: appointments.status must permit 'completed'.
-- ===========================================================================
-- mark_appointment_complete (defined below) writes
-- appointments.status = 'completed'. If a prior migration installed
-- a CHECK constraint on appointments.status whose allowed-value set
-- does not include 'completed', that UPDATE will fail at run time
-- under an obscure error message.
--
-- This block asserts apply-time that EITHER no CHECK constraint
-- restricts appointments.status, OR the existing constraint's
-- definition contains the literal 'completed'. The second check is
-- a string match against pg_get_constraintdef and is conservative:
-- it will accept any constraint that mentions 'completed' as a
-- permitted value (e.g. status in (...,'completed',...)) and will
-- reject silent-deny constraints that do not.
--
-- If this assertion fires you MUST add a separate migration that
-- updates the appointments.status CHECK before applying 0032. We
-- deliberately do NOT alter appointments.status here because the
-- constraint's allowed-value set is owned by an earlier migration
-- and a money-safe migration should not silently extend it.
do $block0_1$
declare
  v_constraint_count integer;
  v_violating_constraint text;
begin
  select count(*) into v_constraint_count
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'appointments'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%';

  if v_constraint_count = 0 then
    -- No status CHECK constraint at all: 'completed' is permitted
    -- structurally (the column is plain text). OK.
    return;
  end if;

  select string_agg(c.conname, ', ') into v_violating_constraint
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'appointments'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
    and pg_get_constraintdef(c.oid) not ilike '%''completed''%'
    and pg_get_constraintdef(c.oid) not ilike '%"completed"%';

  if v_violating_constraint is not null then
    raise exception
      'appointments.status CHECK constraint(s) % do not permit ''completed''. Add a separate migration to update the allowed-value set before applying 0032.',
      v_violating_constraint
      using errcode = '23514';
  end if;
end
$block0_1$;

-- ===========================================================================
-- Section 1.1: locks on existing tables
-- ===========================================================================
lock table public.studios in exclusive mode;
lock table public.practitioners in exclusive mode;
lock table public.clients in exclusive mode;
lock table public.services in exclusive mode;
lock table public.appointments in exclusive mode;
lock table public.appointment_audit in exclusive mode;
lock table public.studio_calendar_reservations in exclusive mode;

-- ===========================================================================
-- Section 1.2: composite uniques on existing tables (FK targets)
-- ===========================================================================
-- Postgres requires an explicit UNIQUE constraint (not just a unique
-- INDEX) as the target of a FOREIGN KEY. The composite uniques below
-- become FK targets for payment tables that bind to
-- (appointment, studio) or (appointment, client, studio) so that a
-- payment row can never reference an appointment from a different
-- studio (tenant escape), or an appointment-client pair that does
-- not match the underlying appointment row (row swap).
alter table public.appointments
  add constraint appointments_id_studio_id_unique unique (id, studio_id);
alter table public.appointments
  add constraint appointments_id_client_id_studio_id_unique
  unique (id, client_id, studio_id);
alter table public.clients
  add constraint clients_id_studio_id_unique unique (id, studio_id);
alter table public.practitioners
  add constraint practitioners_id_studio_id_unique unique (id, studio_id);
alter table public.services
  add constraint services_id_studio_id_unique unique (id, studio_id);

-- ===========================================================================
-- Section 1.3: clients.normalized_email + studio-scoped unique index.
-- Block 0.2 dedupe diagnostic must have returned 0 rows.
-- ===========================================================================
-- normalized_email is a generated, stored column so that payment
-- identity (find-or-create client during a card-required booking)
-- uses an exact, case-folded, whitespace-trimmed match. Without
-- this we would risk creating a duplicate client during the
-- booking flow under a near-duplicate email (e.g. with surrounding
-- whitespace or differing case), then provisioning a NEW Stripe
-- Customer for that duplicate, then saving a card under the wrong
-- client. The partial unique index enforces at most one
-- normalized_email per studio while permitting NULL/empty emails
-- (legacy practitioner-entered clients without email).
-- ===========================================================================
-- Block 0.2: normalized-email duplicate preflight (P0 v4)
-- ===========================================================================
-- The unique index below would fail to build if any existing
-- (studio_id, lower(trim(email))) tuple has count > 1 in the
-- current data. Raising a clear error BEFORE the CREATE UNIQUE
-- INDEX gives the operator a specific instruction set instead of
-- a generic 'could not create unique index' message that buries
-- the studio_id and the colliding email.
do $block0_2$
declare
  v_count integer;
  v_first_studio uuid;
  v_first_email text;
begin
  select count(*) into v_count
  from (
    select c.studio_id, lower(trim(c.email)) as norm
    from public.clients c
    where c.email is not null and trim(c.email) <> ''
    group by c.studio_id, lower(trim(c.email))
    having count(*) > 1
  ) dup;

  if v_count > 0 then
    select dup.studio_id, dup.norm
      into v_first_studio, v_first_email
    from (
      select c.studio_id, lower(trim(c.email)) as norm
      from public.clients c
      where c.email is not null and trim(c.email) <> ''
      group by c.studio_id, lower(trim(c.email))
      having count(*) > 1
      order by 1, 2
      limit 1
    ) dup;
    raise exception
      'Block 0.2: % duplicate normalized-email tuple(s) in public.clients prevent the unique index. Resolve before applying 0032. First duplicate: studio_id=%, normalized_email=%. Investigate with: select id, email, created_at from public.clients where studio_id = % and lower(trim(email)) = %::text order by created_at;',
      v_count, v_first_studio, v_first_email, v_first_studio, v_first_email
      using errcode = '23505';
  end if;
end
$block0_2$;

alter table public.clients
  add column normalized_email text
  generated always as (
    case
      when email is null or trim(email) = '' then null
      else lower(trim(email))
    end
  ) stored;

create unique index clients_studio_normalized_email_uniq
  on public.clients (studio_id, normalized_email)
  where normalized_email is not null;

-- ===========================================================================
-- Section 1.4: P0 4 fix - sync_appointment_to_calendar_reservation
-- now mirrors BOTH 'confirmed' and 'completed' status.
-- ===========================================================================
-- Migration 0030's version only mirrored 'confirmed', which would
-- have caused mark_appointment_complete to silently free the slot:
-- the appointment row stays around for charging and history, but
-- its shadow reservation in studio_calendar_reservations would
-- vanish on the transition to 'completed', re-opening the time
-- window for double-booking the cool-down/buffer minutes before
-- the next appointment can safely start. Completed appointments
-- MUST keep their reservation and buffer so the calendar grid
-- stays accurate retrospectively.
create or replace function public.sync_appointment_to_calendar_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = old.id;
    return null;
  end if;

  if new.status in ('confirmed', 'completed') then
    insert into public.studio_calendar_reservations
      (studio_id, source_kind, source_id, starts_at, ends_at)
    values
      (new.studio_id, 'appointment', new.id, new.starts_at, new.blocked_ends_at)
    on conflict on constraint studio_calendar_reservations_source_unique
    do update set
      studio_id = excluded.studio_id,
      starts_at = excluded.starts_at,
      ends_at   = excluded.ends_at;
  else
    delete from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = new.id;
  end if;

  return null;
end;
$$;

revoke execute on function public.sync_appointment_to_calendar_reservation()
  from public, anon, authenticated;

-- ===========================================================================
-- Section 1.5: 14 payment tables
-- All ENABLE ROW LEVEL SECURITY at section 1.6. NO policies for anon
-- or authenticated. All access via SECURITY DEFINER RPCs.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- studio_payment_settings
-- ---------------------------------------------------------------------------
-- Real-world object: the studio's payment configuration. One row per
-- studio (PK = studio_id).
-- Class: MUTABLE state. The Stripe account binding portion
-- (stripe_account_id, stripe_livemode) is treated as
-- write-once-on-link (only sync_studio_account_status may update
-- status fields after binding; complete_stripe_account_provisioning
-- is the sole RPC that may establish the initial binding).
-- Role: IDENTITY ROOT for the studio's Stripe presence. Every other
-- payment table that names a (studio_id, stripe_account_id,
-- stripe_livemode) tuple ultimately FKs back to the unique
-- constraint declared here, so it is structurally impossible to
-- write a payment row against a Stripe account the studio has
-- never owned.
create table public.studio_payment_settings (
  studio_id                       uuid primary key references public.studios(id) on delete cascade,
  stripe_account_id               text unique,
  stripe_account_status           text check (stripe_account_status in
                                    ('pending','restricted','enabled','rejected')),
  stripe_charges_enabled          boolean not null default false,
  stripe_payouts_enabled          boolean not null default false,
  stripe_onboarding_completed_at  timestamptz,
  require_card_on_file            boolean not null default false,
  stripe_application_fee_bps      integer check (stripe_application_fee_bps between 0 and 1000),
  default_charge_currency         text not null default 'cad'
                                    check (default_charge_currency in ('cad')),
  stripe_livemode                 boolean,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint studio_payment_settings_account_mode_pair_check check (
    (stripe_account_id is null and stripe_livemode is null)
    or (stripe_account_id is not null and stripe_livemode is not null)
  ),
  -- FK target for downstream payment tables that bind to
  -- (studio_id, stripe_account_id, stripe_livemode). studio_id is
  -- already PK so this UNIQUE is structurally redundant; it exists
  -- only because Postgres requires an explicit unique constraint
  -- (not just an index) as a FK reference.
  constraint studio_payment_settings_account_mode_unique
    unique (studio_id, stripe_account_id, stripe_livemode)
);

-- ---------------------------------------------------------------------------
-- client_stripe_customers
-- ---------------------------------------------------------------------------
-- Real-world object: the mapping from a (client, studio) pair to a
-- Stripe Customer object on the studio's connected account, in a
-- specific (account, mode). A given client may have separate Stripe
-- Customer records under test vs live mode and under different
-- connected accounts if the studio ever re-onboards.
-- Class: MUTABLE state, but stripe_customer_id is treated as
-- write-once-per-(client, studio, account, mode).
-- Note: the full lineage UNIQUE is the FK target used by
-- pending_booking_payment_sessions so a session can never reference
-- a customer mapping the studio does not actually own.
create table public.client_stripe_customers (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null,
  studio_id           uuid not null,
  stripe_account_id   text not null,
  stripe_livemode     boolean not null,
  stripe_customer_id  text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint client_stripe_customers_client_studio_fk
    foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  -- Binds this customer mapping to the studio's actually configured
  -- Stripe account + mode. Prevents a row that references an
  -- account the studio has never owned.
  constraint client_stripe_customers_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict,
  constraint client_stripe_customers_client_account_mode_uniq
    unique (client_id, studio_id, stripe_account_id, stripe_livemode),
  constraint client_stripe_customers_customer_account_mode_uniq
    unique (stripe_account_id, stripe_livemode, stripe_customer_id),
  constraint client_stripe_customers_full_lineage_uniq
    unique (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
);

-- ---------------------------------------------------------------------------
-- pending_booking_payment_sessions
-- ---------------------------------------------------------------------------
-- Real-world object: a single client's in-flight booking attempt
-- that requires a card on file. Created when the client lands on
-- the booking page and progresses through consent, SetupIntent,
-- saved-PaymentMethod, and either finalization into an appointment
-- or cleanup if abandoned.
-- Class: MUTABLE state with a strict status machine. Stored
-- statuses are exactly:
--   'pending', 'consent_recorded', 'setup_intent_created',
--   'payment_method_saved_pending_finalization',
--   'finalized', 'finalization_failed',
--   'cleanup_required', 'cleaned',
--   'expired_without_payment_method'.
-- ('cleaned_pm_in_use' is NOT a stored status; it is a cleanup
-- OUTCOME passed to mark_session_cleaned that collapses to
-- status='cleaned' with audit metadata recording the in-use
-- detach-skip reason.)
--
-- Cleanup-queue invariant (P0 v3):
--   * 'cleanup_required' is the SINGLE DURABLE RETRY QUEUE for
--     every saved PaymentMethod that must be detached. Expiry
--     sweep, late-SetupIntent webhook, missing-consent webhook,
--     and finalization failure ALL route into this status.
--     Every Stripe paymentMethods.detach happens exclusively
--     through the claim_payment_method_cleanup_sessions ->
--     Stripe detach -> mark_session_cleaned(<claim_token>) loop.
--   * 'finalization_failed' is RETAINED only as a legacy /
--     unused status today. mark_session_finalization_failed
--     writes 'cleanup_required' for sessions with a saved PM
--     (which is the only case it accepts). 'finalization_failed'
--     therefore remains in the CHECK only so historical inserts
--     remain valid; no code path in this migration writes it.
--   * 'expired_without_payment_method' means no PM exists; no
--     Stripe-side cleanup is needed. A late SetupIntent webhook
--     that proves a PM DOES exist re-routes the row to
--     'cleanup_required' via reconcile_setup_intent_succeeded.
-- Invariant: the saved (account, mode, customer) on this row is
-- the binding the resulting appointment_payments row MUST inherit
-- via the six-tuple lineage FK below.
-- quoted_price_cents_snapshot is a DISPLAY / REFERENCE-ONLY snapshot
-- of the service price at session start. It is NEITHER an
-- authorization cap NOR a maximum charge; the authoritative final
-- charge amount is the owner-entered amount passed to
-- create_or_claim_charge_attempt at completion time. The snapshot
-- is shown to the client at booking with the phrasing
-- 'quoted service price at booking: $X' and is retained so the
-- operator can spot price drift between booking and charging.
-- Do NOT display cap-implying charge language - the snapshot
-- does not and cannot provide an authorization cap.
create table public.pending_booking_payment_sessions (
  id                                uuid primary key default gen_random_uuid(),
  token_hash                        text not null unique,
  studio_id                         uuid not null references public.studios(id) on delete cascade,
  service_id                        uuid not null,
  practitioner_id                   uuid,
  client_id                         uuid not null,
  client_created_during_session     boolean not null default false,
  requested_starts_at               timestamptz not null,
  requested_ends_at                 timestamptz not null,
  requested_duration_minutes        integer not null check (requested_duration_minutes > 0),
  quoted_price_cents_snapshot       integer check (quoted_price_cents_snapshot >= 0),
  stripe_account_id                 text not null,
  stripe_livemode                   boolean not null,
  stripe_customer_id                text not null,
  stripe_setup_intent_id            text,
  stripe_payment_method_id          text,
  studio_name_snapshot              text,
  status                            text not null default 'pending' check (status in (
    'pending', 'consent_recorded', 'setup_intent_created',
    'payment_method_saved_pending_finalization',
    'finalized', 'finalization_failed',
    'cleanup_required', 'cleaned', 'expired_without_payment_method'
  )),
  finalization_error_code           text,
  finalization_error_message        text,
  -- Cleanup claim infrastructure (P0 #3 v2).
  -- cleanup_processing_started_at + cleanup_claim_token serialize
  -- concurrent cleanup workers against the same cleanup_required
  -- session, exactly like the charge/refund attempts pattern. A
  -- stale claim (>5 minutes without terminal cleanup outcome) may
  -- be taken over by a fresh worker; the same Stripe idempotency
  -- behavior on paymentMethods.detach makes the takeover safe.
  cleanup_processing_started_at     timestamptz,
  cleanup_claim_token               uuid,
  -- Cleanup detach state (P0 v7 #3).
  -- DURABLE detach-vs-finalization guard. Set by
  -- check_claimed_payment_method_cleanup_safety AFTER it decides
  -- whether the PaymentMethod is safe to detach, and BEFORE the
  -- application calls Stripe paymentMethods.detach. Visible to
  -- finalize_card_required_public_booking under the same
  -- PaymentMethod-tuple advisory lock, which uses the persisted
  -- value to refuse finalization for any PM that is mid-detach or
  -- already detached.
  --   'detach_authorized'        - safety check passed; worker is
  --                                authorized to call Stripe detach.
  --                                Finalization MUST refuse this PM.
  --   'detach_failed_retryable'  - Stripe detach failed transiently;
  --                                row stays cleanup_required and is
  --                                eligible for re-claim. Finalization
  --                                MUST still refuse this PM (the
  --                                detach intent persists across
  --                                worker retries).
  --   'detached'                 - Stripe detach succeeded. PM is
  --                                gone on Stripe's side. Finalization
  --                                MUST refuse this PM.
  --   'skip_detach_pm_in_use'    - safety check found the PM is
  --                                already referenced by a finalized
  --                                appointment_payments row; no
  --                                Stripe call is made.
  cleanup_detach_state              text check (cleanup_detach_state in (
    'detach_authorized', 'detached', 'detach_failed_retryable',
    'skip_detach_pm_in_use'
  )),
  cleanup_detach_decided_at         timestamptz,
  cleanup_detached_at               timestamptz,
  cleanup_attempted_at              timestamptz,
  cleanup_completed_at              timestamptz,
  cleanup_error_code                text,
  cleanup_error_message             text,
  expires_at                        timestamptz not null default (now() + interval '20 minutes'),
  consumed_at                       timestamptz,
  consumed_appointment_id           uuid,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  -- P0 v7 #4: time-range integrity. The session's
  -- (requested_starts_at, requested_ends_at, requested_duration_minutes)
  -- tuple is the basis for the appointment row and the calendar
  -- reservation; the three values MUST agree exactly so payment,
  -- appointment, and reservation intervals cannot drift apart.
  constraint pending_booking_payment_sessions_range_positive_check
    check (requested_ends_at > requested_starts_at),
  constraint pending_booking_payment_sessions_duration_exact_check
    check (requested_ends_at = requested_starts_at
           + make_interval(mins => requested_duration_minutes)),
  -- P0 v7 #2: session-state integrity. Once the session reaches
  -- setup_intent_created, the SetupIntent ID must be stored.
  -- Once the session reaches a saved-PM or terminal-cleanup state,
  -- BOTH IDs must be stored. The 'expired_without_payment_method'
  -- state intentionally requires NEITHER (it is the
  -- 'never had a card' branch).
  constraint pending_booking_payment_sessions_si_required_check
    check (
      status not in ('setup_intent_created',
                     'payment_method_saved_pending_finalization',
                     'finalized', 'cleanup_required', 'cleaned',
                     'finalization_failed')
      or stripe_setup_intent_id is not null
    ),
  constraint pending_booking_payment_sessions_pm_required_check
    check (
      status not in ('payment_method_saved_pending_finalization',
                     'finalized', 'cleanup_required', 'cleaned',
                     'finalization_failed')
      or stripe_payment_method_id is not null
    ),
  unique (id, studio_id),
  unique (id, client_id, studio_id),
  -- FK target for appointment_payments: a finalized payment must
  -- bind to the same Stripe (account, mode, customer) the session
  -- was started with. Prevents identity drift between session and
  -- appointment_payments rows.
  constraint pending_booking_payment_sessions_full_lineage_unique
    unique (id, client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id),
  foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  foreign key (service_id, studio_id)
    references public.services (id, studio_id) on delete restrict,
  foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  -- Binds the session to the studio's actual Stripe account+mode.
  constraint pending_booking_payment_sessions_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict,
  foreign key (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
    references public.client_stripe_customers
      (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
    on delete restrict
);

create index pending_booking_payment_sessions_studio_expires_idx
  on public.pending_booking_payment_sessions (studio_id, expires_at);
create index pending_booking_payment_sessions_status_idx
  on public.pending_booking_payment_sessions (status);
create unique index pending_booking_payment_sessions_setup_intent_account_mode_uniq
  on public.pending_booking_payment_sessions
    (stripe_account_id, stripe_livemode, stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;

-- Cleanup-claim sweep index: lets claim_payment_method_cleanup_sessions
-- find unclaimed or stale-claim cleanup_required rows quickly.
create index pending_booking_payment_sessions_cleanup_claim_idx
  on public.pending_booking_payment_sessions
    (studio_id, cleanup_processing_started_at)
  where status = 'cleanup_required';

-- ---------------------------------------------------------------------------
-- payment_consents
-- ---------------------------------------------------------------------------
-- Real-world object: the legal record that a specific client, at
-- a specific moment, accepted Hone's card-on-file + treatment-
-- charge consent for a specific booking session.
-- Class: IMMUTABLE EVIDENCE. An UPDATE/DELETE trigger raises
-- insufficient_privilege. Append-only by construction.
-- Bound to a session via the (id, pending_booking_payment_session_id,
-- client_id, studio_id) UNIQUE which is the FK target referenced
-- by appointment_payments to prove consent at finalization.
create table public.payment_consents (
  id                                  uuid primary key default gen_random_uuid(),
  pending_booking_payment_session_id  uuid not null unique,
  studio_id                           uuid not null,
  client_id                           uuid not null,
  consent_type                        text not null check (consent_type in
                                        ('card_on_file_and_treatment_charge')),
  policy_version                      text not null,
  rendered_consent_text_hash          text not null,
  studio_name_snapshot                text not null,
  accepted_at                         timestamptz not null,
  created_at                          timestamptz not null default now(),
  unique (id, client_id, studio_id),
  unique (id, pending_booking_payment_session_id, client_id, studio_id),
  foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  foreign key (pending_booking_payment_session_id, client_id, studio_id)
    references public.pending_booking_payment_sessions (id, client_id, studio_id)
    on delete restrict
);

create index payment_consents_studio_idx on public.payment_consents (studio_id);

create or replace function public.reject_payment_consents_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'payment_consents is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger payment_consents_immutable
  before update or delete on public.payment_consents
  for each row execute function public.reject_payment_consents_mutation();

-- ---------------------------------------------------------------------------
-- appointment_payments
-- ---------------------------------------------------------------------------
-- Real-world object: the persistent payment record for one
-- appointment. One row per appointment (PK = appointment_id).
-- Class: MUTABLE state (payment_status is recomputed by
-- _recompute_payment_status; payment_completed_at moves forward
-- only).
-- Role: FINANCIAL ROOT. Every stripe_charge_attempts,
-- stripe_refund_attempts, stripe_refunds, stripe_disputes,
-- payment_recovery_tokens row ultimately FKs back to this row, and
-- inherits the (account, mode) lineage stamped here. The session
-- six-tuple FK proves provenance from the original consented
-- booking; the consent four-tuple FK proves consent at the moment
-- of finalization; the studio four-tuple FK proves the studio
-- actually owns the Stripe (account, mode) being used.
create table public.appointment_payments (
  appointment_id                      uuid primary key references public.appointments(id) on delete restrict,
  studio_id                           uuid not null,
  client_id                           uuid not null,
  pending_booking_payment_session_id  uuid not null,
  payment_consent_id                  uuid not null,
  stripe_account_id                   text not null,
  stripe_livemode                     boolean not null,
  stripe_customer_id                  text not null,
  stripe_setup_intent_id              text unique not null,
  stripe_payment_method_id            text not null,
  payment_status                      text not null default 'method_saved' check (payment_status in (
    'method_saved', 'charged', 'authentication_required',
    'failed', 'partially_refunded', 'refunded', 'disputed',
    'double_charged', 'reconciliation_required'
  )),
  payment_completed_at                timestamptz,
  booked_price_cents_snapshot         integer check (booked_price_cents_snapshot >= 0),
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),
  unique (appointment_id, studio_id),
  -- FK target for charge/refund/dispute tables. Including (account,
  -- mode) in the FK target means a charge row cannot land against
  -- this appointment under a Stripe (account, mode) that differs
  -- from the binding stamped here at finalization.
  constraint appointment_payments_appointment_account_mode_unique
    unique (appointment_id, studio_id, stripe_account_id, stripe_livemode),
  -- One-pending-session-to-one-finalized-appointment.
  -- finalize_card_required_public_booking already locks the
  -- session row and refuses to finalize a session whose status is
  -- not 'payment_method_saved_pending_finalization', but this
  -- unique is structural belt-and-suspenders: if any future code
  -- path were to bypass the status check, the unique violation
  -- here would still prevent a second appointment_payments row
  -- being created from the same in-flight saved-card session.
  constraint appointment_payments_pending_session_unique
    unique (pending_booking_payment_session_id),
  foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete restrict,
  foreign key (appointment_id, client_id, studio_id)
    references public.appointments (id, client_id, studio_id) on delete restrict,
  foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  -- Six-tuple lineage FK to the booking session. Prevents identity
  -- drift between (client, studio, account, mode, customer) on the
  -- session and the corresponding payment row. Without this it
  -- would be possible (under a bug) to create an appointment_payments
  -- row that claims a different Stripe Customer than the one whose
  -- card was actually saved during the session.
  foreign key (pending_booking_payment_session_id, client_id, studio_id,
               stripe_account_id, stripe_livemode, stripe_customer_id)
    references public.pending_booking_payment_sessions
      (id, client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
    on delete restrict,
  -- Four-tuple consent FK. The (consent, session, client, studio)
  -- tuple must match the same session this payment row claims as
  -- its origin, which prevents 'consent from session A applied to
  -- payment row created against session B' under any bug.
  foreign key (payment_consent_id, pending_booking_payment_session_id, client_id, studio_id)
    references public.payment_consents (id, pending_booking_payment_session_id, client_id, studio_id)
    on delete restrict,
  -- Studio account/mode lineage. The (studio, account, mode) tuple
  -- must equal a row in studio_payment_settings, so a payment row
  -- can never reference a Stripe account the studio has not
  -- actually onboarded.
  constraint appointment_payments_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict
);

create index appointment_payments_studio_status_idx
  on public.appointment_payments (studio_id, payment_status);
create index appointment_payments_payment_method_idx
  on public.appointment_payments (studio_id, stripe_payment_method_id)
  where stripe_payment_method_id is not null;

-- ---------------------------------------------------------------------------
-- stripe_account_provisioning_attempts
-- ---------------------------------------------------------------------------
-- Real-world object: one create-or-claim attempt to onboard the
-- studio onto a Stripe Connect Express account.
-- Class: OPERATIONAL EVENT INTAKE. The partial unique index
-- stripe_account_provisioning_active_uniq ensures at most one
-- active attempt per studio so we cannot accidentally call
-- accounts.create twice in parallel and end up with two connected
-- accounts on Stripe with no clear primary.
create table public.stripe_account_provisioning_attempts (
  id                       uuid primary key default gen_random_uuid(),
  studio_id                uuid not null references public.studios(id) on delete restrict,
  status                   text not null check (status in ('pending','processing','succeeded','failed')),
  stripe_account_id        text,
  stripe_livemode          boolean,
  idempotency_key          text not null unique,
  processing_started_at    timestamptz,
  processing_claim_token   uuid,
  error_code               text,
  error_message            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  terminal_at              timestamptz
);

create unique index stripe_account_provisioning_active_uniq
  on public.stripe_account_provisioning_attempts (studio_id)
  where status in ('pending', 'processing', 'succeeded');

-- ---------------------------------------------------------------------------
-- stripe_customer_provisioning_attempts
-- ---------------------------------------------------------------------------
-- Real-world object: one create-or-claim attempt to create a
-- Stripe Customer on the connected account for a (client, studio,
-- account, mode) tuple.
-- Class: OPERATIONAL EVENT INTAKE. Partial unique index ensures
-- at most one active attempt per tuple so we cannot fork two
-- Stripe Customer objects in parallel against the same client.
create table public.stripe_customer_provisioning_attempts (
  id                       uuid primary key default gen_random_uuid(),
  client_id                uuid not null,
  studio_id                uuid not null,
  stripe_account_id        text not null,
  stripe_livemode          boolean not null,
  status                   text not null check (status in ('pending','processing','succeeded','failed')),
  stripe_customer_id       text,
  idempotency_key          text not null unique,
  processing_started_at    timestamptz,
  processing_claim_token   uuid,
  error_code               text,
  error_message            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  terminal_at              timestamptz,
  foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete restrict,
  -- Bind to studio's configured Stripe account+mode.
  constraint stripe_customer_provisioning_attempts_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict
);

create unique index stripe_customer_provisioning_active_uniq
  on public.stripe_customer_provisioning_attempts
    (client_id, studio_id, stripe_account_id, stripe_livemode)
  where status in ('pending', 'processing', 'succeeded');

-- ---------------------------------------------------------------------------
-- stripe_charge_attempts
-- ---------------------------------------------------------------------------
-- Real-world object: one attempt by the studio to charge a saved
-- card on file for a completed appointment.
-- Class: MUTABLE state with a strict status machine, but the
-- terminal states are write-once (terminal_at + status are set
-- exactly once when reconcile_payment_intent_by_charge_attempt
-- routes a Stripe outcome back into the row).
-- Lineage: the (id, appointment, studio, account, mode, charge_id)
-- six-tuple is the FK target referenced by stripe_refund_attempts,
-- stripe_refunds, and stripe_disputes so refunds and disputes can
-- never claim a charge that lives under a different Stripe context
-- than they do.
create table public.stripe_charge_attempts (
  id                                       uuid primary key default gen_random_uuid(),
  appointment_id                           uuid not null,
  studio_id                                uuid not null,
  stripe_account_id                        text not null,
  stripe_livemode                          boolean not null,
  initiated_by_practitioner_id             uuid references public.practitioners(id) on delete set null,
  amount_cents                             integer not null check (amount_cents > 0),
  currency                                 text not null default 'cad',
  application_fee_cents                    integer not null default 0 check (application_fee_cents >= 0),
  stripe_payment_intent_id                 text,
  stripe_charge_id                         text,
  status                                   text not null check (status in (
    'pending', 'processing', 'authentication_required',
    'succeeded', 'succeeded_duplicate',
    'card_declined', 'failed', 'canceled'
  )),
  stripe_decline_code                      text,
  stripe_error_message                     text,
  idempotency_key                          text not null unique,
  processing_started_at                    timestamptz,
  processing_claim_token                   uuid,
  duplicate_resolved_at                    timestamptz,
  -- LOCAL RETRY FIX: name the allowed-values CHECK explicitly.
  -- Without this name, PostgreSQL auto-names the inline column CHECK
  -- stripe_charge_attempts_duplicate_resolution_check, which collides
  -- with the table-level all-or-nothing resolution CHECK below and
  -- aborts CREATE TABLE before the rest of migration 0032 can run.
  duplicate_resolution                     text
    constraint stripe_charge_attempts_duplicate_resolution_values_check
      check (duplicate_resolution in ('refunded_duplicate', 'all_charges_refunded')),
  duplicate_resolved_by_practitioner_id    uuid,
  created_at                               timestamptz not null default now(),
  updated_at                               timestamptz not null default now(),
  terminal_at                              timestamptz,
  -- Charge ID may exist ONLY for recorded successful charge states.
  -- PaymentIntent ID may exist in any status >= authentication_required
  -- (because Stripe returns a PI when we call .create even on auth fail).
  constraint stripe_charge_attempts_charge_id_status_check check (
    (
      status in ('succeeded', 'succeeded_duplicate')
      and stripe_payment_intent_id is not null
      and stripe_charge_id is not null
      and terminal_at is not null
    )
    or
    (
      status not in ('succeeded', 'succeeded_duplicate')
      and stripe_charge_id is null
    )
  ),
  -- The three duplicate_resolution fields move from all-null
  -- (unresolved) to all-set (resolved) atomically in
  -- resolve_double_charge_incident. Forbidding the half-set state
  -- prevents 'silently marked resolved without recording who
  -- resolved it or how' and 'recorded resolution without recording
  -- it actually happened'. Outside succeeded_duplicate all three
  -- columns MUST be null so no other status can be silently treated
  -- as a resolved duplicate.
  constraint stripe_charge_attempts_duplicate_resolution_check check (
    (status <> 'succeeded_duplicate'
       and duplicate_resolved_at is null
       and duplicate_resolution is null
       and duplicate_resolved_by_practitioner_id is null)
    or (status = 'succeeded_duplicate'
       and duplicate_resolved_at is null
       and duplicate_resolution is null
       and duplicate_resolved_by_practitioner_id is null)
    or (status = 'succeeded_duplicate'
       and duplicate_resolved_at is not null
       and duplicate_resolution is not null
       and duplicate_resolved_by_practitioner_id is not null)
  ),
  constraint stripe_charge_attempts_full_lineage_unique
    unique (id, appointment_id, studio_id, stripe_account_id,
            stripe_livemode, stripe_charge_id),
  constraint stripe_charge_attempts_id_lineage_unique
    unique (id, appointment_id, studio_id, stripe_account_id, stripe_livemode),
  -- Replaces the prior (appointment_id, studio_id) FK with the full
  -- (appointment_id, studio_id, account, mode) lineage so a charge
  -- attempt can only land against an appointment whose payment row
  -- already binds to the same Stripe (account, mode).
  foreign key (appointment_id, studio_id, stripe_account_id, stripe_livemode)
    references public.appointment_payments
      (appointment_id, studio_id, stripe_account_id, stripe_livemode)
    on delete restrict,
  -- Bind to studio's configured Stripe account+mode.
  constraint stripe_charge_attempts_studio_account_mode_fk
    foreign key (studio_id, stripe_account_id, stripe_livemode)
    references public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
    on delete restrict,
  foreign key (duplicate_resolved_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

create index stripe_charge_attempts_appointment_status_idx
  on public.stripe_charge_attempts (appointment_id, status);
create unique index stripe_charge_attempts_pi_account_mode_uniq
  on public.stripe_charge_attempts
    (stripe_account_id, stripe_livemode, stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create unique index stripe_charge_attempts_charge_account_mode_uniq
  on public.stripe_charge_attempts
    (stripe_account_id, stripe_livemode, stripe_charge_id)
  where stripe_charge_id is not null;
create unique index stripe_charge_attempts_active_per_appointment
  on public.stripe_charge_attempts (appointment_id)
  where status in ('pending', 'processing', 'authentication_required');
create unique index stripe_charge_attempts_one_primary_success_per_appointment
  on public.stripe_charge_attempts (appointment_id, studio_id)
  where status = 'succeeded';

-- ---------------------------------------------------------------------------
-- stripe_refund_attempts
-- ---------------------------------------------------------------------------
-- Real-world object: one Hone-initiated attempt to refund a
-- specific stripe_charge_attempts row. V1 issues exactly ONE full
-- refund of the ORIGINAL captured amount on the target charge.
-- Hone does not refund a remainder after an external partial.
-- Class: MUTABLE state with a strict status machine; terminal
-- states (succeeded / failed / canceled) are set once and stamped
-- with terminal_at.
-- Lineage: the (id, appointment, studio) and the six-tuple FK to
-- stripe_charge_attempts (id, appointment, studio, account, mode,
-- charge_id) make it structurally impossible for a refund attempt
-- to point at a charge from a different studio, appointment,
-- account, mode, or even a different stripe_charge_id than the
-- one stored on this attempt.
create table public.stripe_refund_attempts (
  id                              uuid primary key default gen_random_uuid(),
  appointment_id                  uuid not null,
  studio_id                       uuid not null,
  stripe_account_id               text not null,
  stripe_livemode                 boolean not null,
  charge_attempt_id               uuid not null,
  target_stripe_charge_id         text not null,
  initiated_by_practitioner_id    uuid references public.practitioners(id) on delete set null,
  amount_cents                    integer not null check (amount_cents > 0),
  currency                        text not null,
  stripe_payment_intent_id        text not null,
  stripe_refund_id                text,
  status                          text not null check (status in (
    'pending', 'processing', 'requires_action',
    'succeeded', 'failed', 'canceled'
  )),
  stripe_failure_reason           text,
  stripe_error_message            text,
  idempotency_key                 text not null unique,
  processing_started_at           timestamptz,
  processing_claim_token          uuid,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  terminal_at                     timestamptz,
  unique (id, appointment_id, studio_id),
  -- Full lineage UNIQUE used as the FK target by stripe_refunds.
  -- A stripe_refunds row whose refund_attempt_id IS NOT NULL must
  -- reference an attempt under the SAME charge_attempt, appointment,
  -- studio, account, mode and target Stripe Charge - so a stored
  -- refund row can never claim a refund_attempt that actually
  -- belongs to a different charge / studio / Stripe context. id
  -- is already PK so this UNIQUE is structurally trivial; it exists
  -- only because Postgres requires an explicit unique constraint
  -- (not just an index) as a FK reference target.
  constraint stripe_refund_attempts_full_lineage_unique
    unique (id, charge_attempt_id, appointment_id, studio_id,
            stripe_account_id, stripe_livemode, target_stripe_charge_id),
  foreign key (appointment_id, studio_id)
    references public.appointment_payments (appointment_id, studio_id)
    on delete restrict,
  constraint stripe_refund_attempts_target_charge_lineage_fk
    foreign key (charge_attempt_id, appointment_id, studio_id,
                 stripe_account_id, stripe_livemode, target_stripe_charge_id)
    references public.stripe_charge_attempts
      (id, appointment_id, studio_id, stripe_account_id, stripe_livemode, stripe_charge_id)
    on delete restrict
);

create index stripe_refund_attempts_appointment_status_idx
  on public.stripe_refund_attempts (appointment_id, status);
create unique index stripe_refund_attempts_refund_account_mode_uniq
  on public.stripe_refund_attempts
    (stripe_account_id, stripe_livemode, stripe_refund_id)
  where stripe_refund_id is not null;
create unique index stripe_refund_attempts_active_per_charge_attempt
  on public.stripe_refund_attempts (charge_attempt_id)
  where status in ('pending', 'processing', 'requires_action', 'succeeded');

-- ---------------------------------------------------------------------------
-- stripe_refunds
-- ---------------------------------------------------------------------------
-- Real-world object: the studio-visible ledger of every refund
-- observed against a charge, whether initiated from Hone
-- (source='hone_initiated', linked to a stripe_refund_attempts
-- row) or observed from the Stripe Dashboard / out-of-band
-- (source='stripe_dashboard_observed', no refund_attempt_id).
-- Class: MUTABLE state, but stripe_refund_id is write-once per
-- (account, mode) and status moves only into terminal
-- (succeeded / failed / canceled).
-- Source integrity: stripe_refunds_source_attempt_check makes the
-- presence of refund_attempt_id necessary-and-sufficient for
-- source='hone_initiated'. Without it a Dashboard-observed refund
-- could be silently mis-labeled as Hone-initiated (changing
-- _recompute_payment_status semantics and double-charge
-- resolution authority).
create table public.stripe_refunds (
  id                              uuid primary key default gen_random_uuid(),
  studio_id                       uuid not null,
  stripe_account_id               text not null,
  stripe_livemode                 boolean not null,
  appointment_id                  uuid not null,
  charge_attempt_id               uuid not null,
  refund_attempt_id               uuid,
  source                          text not null check (source in
                                    ('hone_initiated', 'stripe_dashboard_observed')),
  stripe_refund_id                text not null,
  stripe_charge_id                text not null,
  stripe_payment_intent_id        text,
  amount_cents                    integer not null check (amount_cents > 0),
  currency                        text not null,
  status                          text not null check (status in
                                    ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  failure_reason                  text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint stripe_refunds_source_attempt_check check (
    (source = 'hone_initiated' and refund_attempt_id is not null)
    or (source = 'stripe_dashboard_observed' and refund_attempt_id is null)
  ),
  foreign key (appointment_id, studio_id)
    references public.appointment_payments (appointment_id, studio_id)
    on delete restrict,
  constraint stripe_refunds_charge_lineage_fk
    foreign key (charge_attempt_id, appointment_id, studio_id,
                 stripe_account_id, stripe_livemode, stripe_charge_id)
    references public.stripe_charge_attempts
      (id, appointment_id, studio_id, stripe_account_id, stripe_livemode, stripe_charge_id)
    on delete restrict,
  -- Strengthened refund-attempt lineage FK (P0 #4 v2). When
  -- refund_attempt_id is non-null it MUST reference an attempt
  -- under the EXACT same charge_attempt_id / appointment / studio
  -- / account / mode / target Charge ID this refund claims. A
  -- mis-routed Dashboard refund cannot be silently promoted to
  -- hone_initiated by writing a refund_attempt_id that belongs to
  -- some other charge.
  constraint stripe_refunds_refund_attempt_full_lineage_fk
    foreign key (refund_attempt_id, charge_attempt_id, appointment_id, studio_id,
                 stripe_account_id, stripe_livemode, stripe_charge_id)
    references public.stripe_refund_attempts
      (id, charge_attempt_id, appointment_id, studio_id,
       stripe_account_id, stripe_livemode, target_stripe_charge_id)
    on delete restrict
);

create index stripe_refunds_appointment_idx
  on public.stripe_refunds (appointment_id, created_at desc);
create unique index stripe_refunds_refund_account_mode_uniq
  on public.stripe_refunds (stripe_account_id, stripe_livemode, stripe_refund_id);

-- ---------------------------------------------------------------------------
-- stripe_disputes
-- ---------------------------------------------------------------------------
-- Real-world object: one Stripe dispute (chargeback / early
-- warning) tied to a specific stripe_charge_attempts row via the
-- full charge lineage FK.
-- Class: MUTABLE state. We update status / evidence_due_by /
-- closed_outcome from webhook events; we never delete a dispute
-- row (history is part of the ledger).
-- The charge-lineage FK enforces that the dispute's
-- (account, mode, charge_id) matches the original charge it claims
-- to dispute; without it a Stripe Dashboard event for a different
-- account could be mis-attributed to a Hone charge with a
-- collision-prone short_id.
create table public.stripe_disputes (
  id                              uuid primary key default gen_random_uuid(),
  studio_id                       uuid not null,
  stripe_account_id               text not null,
  stripe_livemode                 boolean not null,
  appointment_id                  uuid not null,
  charge_attempt_id               uuid not null,
  stripe_dispute_id               text not null,
  stripe_charge_id                text not null,
  stripe_payment_intent_id        text,
  amount_cents                    integer not null check (amount_cents > 0),
  currency                        text not null,
  reason                          text,
  status                          text not null check (status in (
    'warning_needs_response', 'warning_under_review', 'warning_closed',
    'needs_response', 'under_review', 'won', 'lost', 'prevented'
  )),
  evidence_due_by                 timestamptz,
  closed_outcome                  text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  foreign key (appointment_id, studio_id)
    references public.appointment_payments (appointment_id, studio_id)
    on delete restrict,
  constraint stripe_disputes_charge_lineage_fk
    foreign key (charge_attempt_id, appointment_id, studio_id,
                 stripe_account_id, stripe_livemode, stripe_charge_id)
    references public.stripe_charge_attempts
      (id, appointment_id, studio_id, stripe_account_id, stripe_livemode, stripe_charge_id)
    on delete restrict
);

create index stripe_disputes_studio_status_idx
  on public.stripe_disputes (studio_id, status, evidence_due_by);
create unique index stripe_disputes_dispute_account_mode_uniq
  on public.stripe_disputes (stripe_account_id, stripe_livemode, stripe_dispute_id);

-- ---------------------------------------------------------------------------
-- payment_recovery_tokens
-- ---------------------------------------------------------------------------
-- Real-world object: a single-use, hashed URL token a client can
-- redeem on a Hone-hosted recovery page to complete an
-- authentication_required PaymentIntent. The URL itself NEVER
-- contains a Stripe client_secret.
-- Class: MUTABLE state - token rows are created live, then either
-- consumed (paid) or invalidated (expired / superseded).
-- Lineage: the (charge_attempt, appointment, studio, account, mode)
-- five-tuple FK to stripe_charge_attempts prevents a token from
-- pointing at a charge under a different (account, mode) than the
-- token claims. This is the structural backing for the
-- defense-in-depth re-check in lookup_payment_recovery_token.
-- Open-token uniqueness: the partial index
-- payment_recovery_tokens_one_open_per_attempt ensures at most one
-- live (non-consumed, non-invalidated) token per charge attempt,
-- so a previous unused token must be invalidated before a new one
-- is issued. Without this, two recovery URLs could race against
-- the same authentication_required PaymentIntent.
create table public.payment_recovery_tokens (
  id                  uuid primary key default gen_random_uuid(),
  token_hash          text not null unique,
  charge_attempt_id   uuid not null,
  appointment_id      uuid not null,
  studio_id           uuid not null,
  stripe_account_id   text not null,
  stripe_livemode     boolean not null,
  expires_at          timestamptz not null default (now() + interval '48 hours'),
  consumed_at         timestamptz,
  invalidated_at      timestamptz,
  created_at          timestamptz not null default now(),
  foreign key (charge_attempt_id, appointment_id, studio_id,
               stripe_account_id, stripe_livemode)
    references public.stripe_charge_attempts
      (id, appointment_id, studio_id, stripe_account_id, stripe_livemode)
    on delete cascade
);

create index payment_recovery_tokens_charge_attempt_idx
  on public.payment_recovery_tokens (charge_attempt_id);
create unique index payment_recovery_tokens_one_open_per_attempt
  on public.payment_recovery_tokens (charge_attempt_id)
  where consumed_at is null and invalidated_at is null;

-- ---------------------------------------------------------------------------
-- stripe_events
-- ---------------------------------------------------------------------------
-- Real-world object: one Stripe webhook event the application has
-- received, scoped by (account, mode, stripe_event_id).
-- Class: OPERATIONAL EVENT INTAKE. The composite unique on
-- (account, mode, event_id) plus the claim_stripe_event RPC
-- guarantee at-most-once successful processing across concurrent
-- webhook deliveries; processing_claim_token + 5-minute lease
-- recovers from a worker crashing mid-process without ever
-- silently leaving a duplicate in flight.
create table public.stripe_events (
  id                          uuid primary key default gen_random_uuid(),
  stripe_event_id             text not null,
  event_type                  text not null,
  stripe_account_id           text not null,
  stripe_livemode             boolean not null,
  studio_id                   uuid references public.studios(id) on delete set null,
  processing_started_at       timestamptz,
  processing_claim_token      uuid,
  processing_attempt_count    integer not null default 0,
  processed_at                timestamptz,
  error                       text,
  payload_summary             jsonb,
  created_at                  timestamptz not null default now()
);

create index stripe_events_type_processed_idx
  on public.stripe_events (event_type, processed_at);
create index stripe_events_studio_created_idx
  on public.stripe_events (studio_id, created_at);
create unique index stripe_events_account_mode_event_uniq
  on public.stripe_events (stripe_account_id, stripe_livemode, stripe_event_id);

-- ---------------------------------------------------------------------------
-- stripe_payment_audit
-- ---------------------------------------------------------------------------
-- Real-world object: the immutable, semantic event history for
-- every payment-relevant action Hone has taken or observed for a
-- specific appointment or session. This is the human-and-machine
-- readable money log, separate from the raw stripe_events
-- webhook intake.
-- Class: IMMUTABLE EVIDENCE. UPDATE/DELETE raises
-- insufficient_privilege via stripe_payment_audit_immutable
-- trigger. Append-only by construction.
-- Dedup: the partial unique index stripe_payment_audit_event_action_uniq
-- on (stripe_event_id, action) WHERE stripe_event_id IS NOT NULL
-- means a webhook retry that re-routes the same Stripe event into
-- the same semantic action will not create a duplicate log entry.
-- Rows whose stripe_event_id is NULL (Hone-initiated actions like
-- charge_attempted, refund_attempted) bypass the dedup because no
-- single Stripe event uniquely identifies them.
create table public.stripe_payment_audit (
  id                                  uuid primary key default gen_random_uuid(),
  appointment_id                      uuid,
  pending_booking_payment_session_id  uuid,
  studio_id                           uuid not null,
  stripe_account_id                   text,
  stripe_livemode                     boolean,
  practitioner_id                     uuid references public.practitioners(id) on delete set null,
  action                              text not null check (action in (
    'charge_attempted', 'charge_succeeded', 'charge_failed',
    'charge_authentication_required',
    'refund_attempted', 'refund_succeeded', 'refund_failed',
    'external_refund_observed',
    'refund_stale_ignored',
    -- P0 v6: identity-conflict guards for refunds and disputes.
    -- Emitted when an existing row is found by stripe_*_id but
    -- its stored immutable lineage does not match the resolved
    -- charge for the incoming event.
    'refund_identifier_conflict',
    'dispute_created', 'dispute_updated', 'dispute_closed',
    'dispute_stale_ignored',
    'dispute_identifier_conflict',
    -- P0 v5 (truthful cleanup audit):
    -- payment_method_cleanup_queued = a session was routed into
    --   the cleanup_required queue (no Stripe contact yet).
    -- payment_method_cleanup_attempted = the cleanup row was
    --   actually claimed by claim_payment_method_cleanup_sessions
    --   for Stripe detach / safe-skip work.
    -- payment_method_cleanup_safety_checked = the safety-check
    --   RPC was called against a claimed cleanup row, recording
    --   the decision (safe_to_detach vs skip_detach_pm_in_use).
    -- payment_method_cleanup_succeeded / _failed = terminal
    --   outcomes of the claimed work.
    'payment_method_cleanup_queued',
    'payment_method_cleanup_attempted',
    'payment_method_cleanup_safety_checked',
    'payment_method_cleanup_succeeded',
    'payment_method_cleanup_failed',
    'webhook_received',
    'double_charge_detected', 'double_charge_resolved',
    'double_charge_resolution_failed'
  )),
  stripe_event_id                     text,
  amount_cents                        integer,
  currency                            text,
  stripe_payment_intent_id            text,
  stripe_charge_id                    text,
  stripe_refund_id                    text,
  stripe_dispute_id                   text,
  stripe_charge_attempt_id            uuid references public.stripe_charge_attempts(id) on delete set null,
  stripe_refund_attempt_id            uuid references public.stripe_refund_attempts(id) on delete set null,
  error_code                          text,
  error_message                       text,
  metadata                            jsonb not null default '{}'::jsonb,
  created_at                          timestamptz not null default now(),
  check (appointment_id is not null or pending_booking_payment_session_id is not null),
  constraint stripe_payment_audit_account_mode_pair_check check (
    (stripe_account_id is null and stripe_livemode is null)
    or (stripe_account_id is not null and stripe_livemode is not null)
  ),
  constraint stripe_payment_audit_event_requires_binding_check check (
    stripe_event_id is null
    or (stripe_account_id is not null and stripe_livemode is not null)
  ),
  foreign key (appointment_id, studio_id)
    references public.appointment_payments (appointment_id, studio_id)
    on delete restrict,
  foreign key (pending_booking_payment_session_id, studio_id)
    references public.pending_booking_payment_sessions (id, studio_id)
    on delete restrict
);

create index stripe_payment_audit_appointment_idx
  on public.stripe_payment_audit (appointment_id, created_at desc)
  where appointment_id is not null;
create index stripe_payment_audit_session_idx
  on public.stripe_payment_audit (pending_booking_payment_session_id, created_at desc)
  where pending_booking_payment_session_id is not null;
create index stripe_payment_audit_payment_intent_idx
  on public.stripe_payment_audit (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create index stripe_payment_audit_charge_idx
  on public.stripe_payment_audit (stripe_charge_id)
  where stripe_charge_id is not null;
create index stripe_payment_audit_refund_idx
  on public.stripe_payment_audit (stripe_refund_id)
  where stripe_refund_id is not null;
create unique index stripe_payment_audit_event_action_uniq
  on public.stripe_payment_audit (stripe_event_id, action)
  where stripe_event_id is not null;

create or replace function public.reject_payment_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'stripe_payment_audit is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger stripe_payment_audit_immutable
  before update or delete on public.stripe_payment_audit
  for each row execute function public.reject_payment_audit_mutation();

-- ===========================================================================
-- Section 1.6: enable RLS on all 14 payment tables, NO policies
-- ===========================================================================
alter table public.studio_payment_settings              enable row level security;
alter table public.client_stripe_customers              enable row level security;
alter table public.pending_booking_payment_sessions     enable row level security;
alter table public.payment_consents                     enable row level security;
alter table public.appointment_payments                 enable row level security;
alter table public.stripe_account_provisioning_attempts enable row level security;
alter table public.stripe_customer_provisioning_attempts enable row level security;
alter table public.stripe_charge_attempts               enable row level security;
alter table public.stripe_refund_attempts               enable row level security;
alter table public.stripe_refunds                       enable row level security;
alter table public.stripe_disputes                      enable row level security;
alter table public.payment_recovery_tokens              enable row level security;
alter table public.stripe_events                        enable row level security;
alter table public.stripe_payment_audit                 enable row level security;

-- ===========================================================================
-- Section 1.7: RPCs
-- ===========================================================================

-- ---- Private helpers (revoked from ALL roles, including service_role) ----

-- ---------------------------------------------------------------------------
-- _append_stripe_payment_audit
-- ---------------------------------------------------------------------------
-- Purpose: write one semantic event into stripe_payment_audit.
-- Authority: callable only through the SECURITY DEFINER chain from
-- other RPCs in this file; EXECUTE is revoked from every role
-- including service_role.
-- Idempotency: partial unique index on (stripe_event_id, action)
-- means a webhook retry that re-routes the same Stripe event into
-- the same semantic action will land as ON CONFLICT DO NOTHING
-- (no duplicate semantic row). Callers MUST omit
-- p_stripe_event_id (pass NULL) on no-op / already-applied branches
-- so we never emit a misleading 'charge_succeeded' for a request
-- that was actually idempotent on the local state machine.
create or replace function public._append_stripe_payment_audit(
  p_appointment_id                      uuid,
  p_pending_booking_payment_session_id  uuid,
  p_studio_id                           uuid,
  p_practitioner_id                     uuid,
  p_action                              text,
  p_stripe_event_id                     text,
  p_amount_cents                        integer,
  p_currency                            text,
  p_stripe_payment_intent_id            text,
  p_stripe_charge_id                    text,
  p_stripe_refund_id                    text,
  p_stripe_dispute_id                   text,
  p_stripe_charge_attempt_id            uuid,
  p_stripe_refund_attempt_id            uuid,
  p_error_code                          text,
  p_error_message                       text,
  p_metadata                            jsonb,
  p_stripe_account_id                   text,
  p_stripe_livemode                     boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.stripe_payment_audit (
    appointment_id, pending_booking_payment_session_id, studio_id,
    stripe_account_id, stripe_livemode,
    practitioner_id, action, stripe_event_id,
    amount_cents, currency,
    stripe_payment_intent_id, stripe_charge_id,
    stripe_refund_id, stripe_dispute_id,
    stripe_charge_attempt_id, stripe_refund_attempt_id,
    error_code, error_message, metadata
  ) values (
    p_appointment_id, p_pending_booking_payment_session_id, p_studio_id,
    p_stripe_account_id, p_stripe_livemode,
    p_practitioner_id, p_action, p_stripe_event_id,
    p_amount_cents, p_currency,
    p_stripe_payment_intent_id, p_stripe_charge_id,
    p_stripe_refund_id, p_stripe_dispute_id,
    p_stripe_charge_attempt_id, p_stripe_refund_attempt_id,
    p_error_code, p_error_message, coalesce(p_metadata, '{}'::jsonb)
  )
  -- Partial unique INDEX (stripe_event_id, action) WHERE
  -- stripe_event_id IS NOT NULL: inference clause must repeat the
  -- predicate so PostgreSQL selects the correct arbiter. Rows with
  -- stripe_event_id NULL skip conflict checking entirely (the
  -- partial index excludes them) and INSERT normally.
  on conflict (stripe_event_id, action)
    where stripe_event_id is not null
    do nothing;
end;
$$;

revoke execute on function public._append_stripe_payment_audit(
  uuid, uuid, uuid, uuid, text, text, integer, text, text, text, text, text,
  uuid, uuid, text, text, jsonb, text, boolean
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- _recompute_payment_status
-- ---------------------------------------------------------------------------
-- Purpose: derive appointment_payments.payment_status from the
-- current state of charge attempts, refunds and disputes for the
-- given (appointment, studio).
-- Authority: callable only through the SECURITY DEFINER chain;
-- EXECUTE revoked from every role including service_role. Called
-- after every Stripe-side state transition routed into this
-- migration's reconcile_* RPCs.
-- Precedence (from highest priority to lowest):
--   reconciliation_required (any structural impossibility - e.g.
--     more refunded than captured, two succeeded primaries, or a
--     duplicate present without any primary)
--   > double_charged   - any unresolved succeeded_duplicate exists.
--                        Outranks disputes and refunds because an
--                        unresolved duplicate is a guaranteed
--                        client-impacting incident demanding human
--                        attention even if a dispute or refund is
--                        already moving against the primary.
--   > disputed
--   > charged | partially_refunded | refunded (derived from net
--     captured vs intended)
--   > authentication_required
--   > failed
--   > method_saved
create or replace function public._recompute_payment_status(
  p_appointment_id uuid,
  p_studio_id      uuid
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_unresolved_duplicates integer;
  v_open_disputes integer;
  v_primary_succeeded_count integer;
  v_intended_amount_cents bigint;
  v_total_captured_cents bigint;
  v_total_refunded_cents bigint;
  v_net_captured_cents bigint;
  v_auth_required_exists boolean;
  v_failed_exists boolean;
  v_final text;
begin
  -- P0 v4 SERIALIZATION: lock the financial root row BEFORE
  -- reading any charge/refund/dispute totals. Without this lock,
  -- two concurrent webhooks (e.g. refund.succeeded and
  -- charge.dispute.created landing in the same instant) could
  -- both read totals that exclude the other's pending write and
  -- both compute the SAME payment_status, then race the UPDATE -
  -- silently dropping one of the two state transitions. The
  -- appointment_payments row is the single financial root for an
  -- appointment, so a row-level FOR UPDATE here forces concurrent
  -- recomputes to serialize through one writer at a time.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = p_appointment_id
    and ap.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment payment not found for status recompute'
      using errcode = 'P0002';
  end if;

  select count(*) into v_unresolved_duplicates
  from public.stripe_charge_attempts
  where appointment_id = p_appointment_id
    and studio_id = p_studio_id
    and status = 'succeeded_duplicate'
    and duplicate_resolved_at is null;

  select count(*) into v_open_disputes
  from public.stripe_disputes
  where appointment_id = p_appointment_id
    and studio_id = p_studio_id
    and status not in ('warning_closed', 'won', 'lost', 'prevented');

  select count(*)::integer, max(amount_cents)::bigint
    into v_primary_succeeded_count, v_intended_amount_cents
  from public.stripe_charge_attempts
  where appointment_id = p_appointment_id
    and studio_id = p_studio_id
    and status = 'succeeded';

  if v_primary_succeeded_count > 1 then
    v_final := 'reconciliation_required';
    update public.appointment_payments
       set payment_status = v_final, updated_at = now()
     where appointment_id = p_appointment_id and studio_id = p_studio_id;
    return v_final;
  end if;

  if v_unresolved_duplicates > 0 and v_primary_succeeded_count = 0 then
    v_final := 'reconciliation_required';
    update public.appointment_payments
       set payment_status = v_final, updated_at = now()
     where appointment_id = p_appointment_id and studio_id = p_studio_id;
    return v_final;
  end if;

  select coalesce(sum(amount_cents)::bigint, 0) into v_total_captured_cents
  from public.stripe_charge_attempts
  where appointment_id = p_appointment_id
    and studio_id = p_studio_id
    and status in ('succeeded', 'succeeded_duplicate');

  select coalesce(sum(amount_cents)::bigint, 0) into v_total_refunded_cents
  from public.stripe_refunds
  where appointment_id = p_appointment_id
    and studio_id = p_studio_id
    and status = 'succeeded';

  if v_total_refunded_cents > v_total_captured_cents then
    v_final := 'reconciliation_required';
    update public.appointment_payments
       set payment_status = v_final, updated_at = now()
     where appointment_id = p_appointment_id and studio_id = p_studio_id;
    return v_final;
  end if;

  if v_primary_succeeded_count = 0 and v_total_captured_cents > 0 then
    v_final := 'reconciliation_required';
    update public.appointment_payments
       set payment_status = v_final, updated_at = now()
     where appointment_id = p_appointment_id and studio_id = p_studio_id;
    return v_final;
  end if;

  v_net_captured_cents := v_total_captured_cents - v_total_refunded_cents;

  if v_unresolved_duplicates > 0 then
    v_final := 'double_charged';
  elsif v_open_disputes > 0 then
    v_final := 'disputed';
  elsif v_primary_succeeded_count = 1 and v_intended_amount_cents is not null then
    if v_net_captured_cents = v_intended_amount_cents then
      v_final := 'charged';
    elsif v_net_captured_cents > 0 and v_net_captured_cents < v_intended_amount_cents then
      v_final := 'partially_refunded';
    elsif v_net_captured_cents = 0 then
      v_final := 'refunded';
    else
      v_final := 'reconciliation_required';
    end if;
  else
    select exists(select 1 from public.stripe_charge_attempts
      where appointment_id = p_appointment_id and studio_id = p_studio_id
        and status = 'authentication_required')
      into v_auth_required_exists;
    if v_auth_required_exists then
      v_final := 'authentication_required';
    else
      select exists(select 1 from public.stripe_charge_attempts
        where appointment_id = p_appointment_id and studio_id = p_studio_id
          and status in ('card_declined', 'failed', 'canceled'))
        into v_failed_exists;
      if v_failed_exists then
        v_final := 'failed';
      else
        v_final := 'method_saved';
      end if;
    end if;
  end if;

  update public.appointment_payments
     set payment_status = v_final,
         payment_completed_at = case when v_final = 'charged'
                                     then coalesce(payment_completed_at, now())
                                     else payment_completed_at end,
         updated_at = now()
   where appointment_id = p_appointment_id and studio_id = p_studio_id;

  return v_final;
end;
$$;

revoke execute on function public._recompute_payment_status(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- _retire_superseded_charge_attempts  (P0 v4 - new private helper)
-- ---------------------------------------------------------------------------
-- Purpose: when one charge attempt for an appointment becomes the
-- accepted success (status flips to 'succeeded' or
-- 'succeeded_duplicate'), every OTHER non-terminal attempt on
-- the same (appointment, studio) is structurally superseded and
-- MUST be retired so it cannot independently become a second
-- primary success. We retire by flipping their status to
-- 'canceled' with stripe_error_message='superseded_by_succeeded_attempt'.
-- The constraint stripe_charge_attempts_charge_id_status_check
-- already guarantees retired attempts hold NULL stripe_charge_id,
-- so the partial unique one_primary_success_per_appointment is
-- preserved.
-- A retired attempt whose underlying PaymentIntent later does
-- succeed in Stripe will arrive at reconcile_payment_intent_by_charge_attempt
-- on the 'succeeded' branch, be promoted through the UPDATE, hit
-- the partial-unique-violation on one_primary_success_per_appointment,
-- and be routed to 'succeeded_duplicate' by the existing
-- duplicate-detection branch - exactly the same handling as any
-- other double-charge event. Retirement therefore does NOT lose
-- the duplicate-detection guarantee.
-- Each retired attempt gets a 'charge_failed' audit row with
-- error_code='superseded_by_succeeded_attempt' so the audit
-- timeline shows what happened to it.
-- P0 v5: any open payment_recovery_tokens rows associated with a
-- retired attempt are invalidated (invalidated_at=now()) - NOT
-- consumed (consumed_at remains NULL). A superseded
-- authentication-required flow cannot remain represented by an
-- open recovery URL once another attempt has succeeded against
-- the same appointment; the client never completed THIS flow's
-- 3DS, so the truthful terminal state of the token is
-- 'invalidated', not 'consumed'.
-- Authority: callable only through the SECURITY DEFINER chain;
-- EXECUTE revoked from every role including service_role.
create or replace function public._retire_superseded_charge_attempts(
  p_appointment_id          uuid,
  p_studio_id               uuid,
  p_succeeding_attempt_id   uuid,
  p_stripe_account_id       text,
  p_stripe_livemode         boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row record;
begin
  for v_row in
    update public.stripe_charge_attempts sca
       set status = 'canceled',
           stripe_error_message = 'superseded_by_succeeded_attempt',
           stripe_decline_code = null,
           processing_claim_token = null,
           terminal_at = now(),
           updated_at = now()
     where sca.appointment_id = p_appointment_id
       and sca.studio_id = p_studio_id
       and sca.id <> p_succeeding_attempt_id
       and sca.status in ('pending', 'processing', 'authentication_required')
    returning sca.id, sca.amount_cents, sca.currency,
              sca.stripe_payment_intent_id, sca.stripe_charge_id
  loop
    -- Invalidate (NOT consume) any open recovery tokens for the
    -- retired attempt. The token never resolved through a
    -- successful authenticated payment; its truthful terminal
    -- state is 'invalidated'.
    update public.payment_recovery_tokens prt
       set invalidated_at = now()
     where prt.charge_attempt_id = v_row.id
       and prt.studio_id = p_studio_id
       and prt.consumed_at is null
       and prt.invalidated_at is null;

    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, null,
      'charge_failed', null,
      v_row.amount_cents, v_row.currency,
      v_row.stripe_payment_intent_id, v_row.stripe_charge_id,
      null, null, v_row.id, null,
      'superseded_by_succeeded_attempt', null,
      jsonb_build_object(
        'superseded_by_attempt_id', p_succeeding_attempt_id
      ),
      p_stripe_account_id, p_stripe_livemode
    );
  end loop;
end;
$$;

revoke execute on function public._retire_superseded_charge_attempts(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- _acquire_payment_method_tuple_xact_lock  (P0 v7 #3 - new helper)
-- ---------------------------------------------------------------------------
-- Purpose: take a transaction-scoped advisory lock keyed on a
-- specific PaymentMethod tuple
--   (studio_id, client_id, stripe_account_id, stripe_livemode,
--    stripe_customer_id, stripe_payment_method_id).
-- This is the shared lock that serializes
-- check_claimed_payment_method_cleanup_safety AND
-- finalize_card_required_public_booking against each other for
-- the SAME PaymentMethod, closing the detach-vs-finalize race
-- documented in P0 v7 #3.
--
-- Implementation: pg_advisory_xact_lock(bigint) takes a 64-bit
-- key. We hash the tuple with hashtextextended (stable, well
-- distributed). Hash collisions only OVER-serialize unrelated
-- tuples; they NEVER weaken safety because the durable
-- cleanup_detach_state column on the session row is the actual
-- guard. The lock is just the synchronization point for reading
-- and writing that guard atomically.
--
-- The lock is released automatically at end of transaction.
-- Authority: private helper, EXECUTE revoked from every role.
create or replace function public._acquire_payment_method_tuple_xact_lock(
  p_studio_id              uuid,
  p_client_id              uuid,
  p_stripe_account_id      text,
  p_stripe_livemode        boolean,
  p_stripe_customer_id     text,
  p_stripe_payment_method_id text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_key bigint;
begin
  if p_studio_id is null or p_client_id is null
     or p_stripe_account_id is null or p_stripe_livemode is null
     or p_stripe_customer_id is null or p_stripe_payment_method_id is null then
    raise exception '_acquire_payment_method_tuple_xact_lock requires all tuple components to be non-null'
      using errcode = '22023';
  end if;
  v_key := hashtextextended(
    p_studio_id::text || '|'
    || p_client_id::text || '|'
    || p_stripe_account_id || '|'
    || case when p_stripe_livemode then 't' else 'f' end || '|'
    || p_stripe_customer_id || '|'
    || p_stripe_payment_method_id,
    0
  );
  perform pg_advisory_xact_lock(v_key);
end;
$$;

revoke execute on function public._acquire_payment_method_tuple_xact_lock(uuid, uuid, text, boolean, text, text)
  from public, anon, authenticated, service_role;

-- ---- Account provisioning ----

-- ---------------------------------------------------------------------------
-- create_or_claim_stripe_account_provisioning
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only (granted below). The caller
-- (server action) is responsible for confirming the active studio
-- owner before invoking this RPC; the call itself does not carry
-- the owner identity.
-- Locks / verifies: takes FOR UPDATE on any in-flight attempt row
-- so two concurrent callers cannot both decide to call
-- accounts.create. Returns already_provisioned=true if the studio
-- already has a Stripe account configured in
-- studio_payment_settings.
-- Invariant: at most one attempt row per studio is non-terminal
-- (status in pending/processing/succeeded) due to partial unique
-- index stripe_account_provisioning_active_uniq.
-- Retry handling: a stale claim token (>5 minutes old without
-- completion) may be taken over by a new caller, which gets a
-- fresh claim_token and the SAME idempotency_key so Stripe sees a
-- single accounts.create request.
create or replace function public.create_or_claim_stripe_account_provisioning(
  p_studio_id        uuid,
  p_stripe_livemode  boolean
) returns table (
  attempt_id                    uuid,
  out_status                    text,
  out_stripe_account_id         text,
  out_stripe_livemode           boolean,
  out_idempotency_key           text,
  out_processing_claim_token    uuid,
  should_execute_stripe_call    boolean,
  already_provisioned           boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.stripe_account_provisioning_attempts%rowtype;
  v_settings_account text;
  v_settings_mode boolean;
  v_new_id uuid;
  v_new_claim uuid;
  v_new_key text;
begin
  if p_stripe_livemode is null then
    raise exception 'p_stripe_livemode must be non-null' using errcode = '22023';
  end if;

  -- Already-bound studio: short-circuit before touching any
  -- attempts table to keep the success path cheap. Mode mismatch
  -- (existing binding is live, request is test, or vice versa)
  -- is a hard refusal - a studio has exactly one configured mode
  -- at a time in V1.
  select sps.stripe_account_id, sps.stripe_livemode
    into v_settings_account, v_settings_mode
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id
    and sps.stripe_account_id is not null;
  if found then
    if v_settings_mode is distinct from p_stripe_livemode then
      raise exception 'studio % is already bound to mode %, refusing to provision mode %', p_studio_id, v_settings_mode, p_stripe_livemode
        using errcode = 'P0002';
    end if;
    return query
      select null::uuid, 'succeeded'::text, v_settings_account, v_settings_mode,
             null::text, null::uuid, false, true;
    return;
  end if;

  -- Find the most recent non-terminal attempt under FOR UPDATE so
  -- concurrent callers serialize through the claim decision.
  -- Table aliased and columns qualified to avoid shadowing by the
  -- RETURNS TABLE output-column variables of the same name.
  select * into v_existing
  from public.stripe_account_provisioning_attempts spa
  where spa.studio_id = p_studio_id
    and spa.status in ('pending', 'processing', 'succeeded')
  order by spa.created_at desc
  limit 1
  for update;

  if found then
    -- P0 #7 v2: mode mismatch on a reclaim/return path. The active
    -- attempt was opened for a different (livemode) and would,
    -- if returned, hand back a Stripe-side account whose mode
    -- does not match what this caller asked for. Hard refusal.
    if v_existing.stripe_livemode is not null
       and v_existing.stripe_livemode is distinct from p_stripe_livemode then
      raise exception 'in-flight provisioning attempt % is for mode %, cannot be returned for mode %', v_existing.id, v_existing.stripe_livemode, p_stripe_livemode
        using errcode = 'P0002';
    end if;
    -- succeeded or actively processing: no new Stripe call.
    if v_existing.status in ('succeeded', 'processing') then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_account_id,
               v_existing.stripe_livemode, v_existing.idempotency_key,
               v_existing.processing_claim_token, false, false;
      return;
    end if;
    -- Fresh claim within 5-minute lease window: another worker
    -- is already running accounts.create; we wait, do not race.
    if v_existing.processing_claim_token is not null
       and v_existing.processing_started_at > now() - interval '5 minutes' then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_account_id,
               v_existing.stripe_livemode, v_existing.idempotency_key,
               v_existing.processing_claim_token, false, false;
      return;
    end if;
    -- Stale claim: take it over. Reuse the SAME idempotency_key so
    -- Stripe's idempotency layer collapses our retry with the prior
    -- accounts.create request, even if the previous worker had
    -- already managed to create the account on Stripe's side.
    v_new_claim := gen_random_uuid();
    update public.stripe_account_provisioning_attempts spa
       set processing_claim_token = v_new_claim,
           processing_started_at = now(),
           updated_at = now()
     where spa.id = v_existing.id;
    return query
      select v_existing.id, v_existing.status, v_existing.stripe_account_id,
             v_existing.stripe_livemode, v_existing.idempotency_key,
             v_new_claim, true, false;
    return;
  end if;

  -- No prior attempt: create a fresh pending one and hand the
  -- caller a brand-new idempotency_key + claim token. Mode is
  -- stamped on the row so a future reclaim can refuse a
  -- mode-mismatched takeover (P0 #7 v2).
  v_new_id := gen_random_uuid();
  v_new_claim := gen_random_uuid();
  v_new_key := 'acct_' || p_studio_id::text || '_' || gen_random_uuid()::text;

  insert into public.stripe_account_provisioning_attempts (
    id, studio_id, stripe_livemode, status, idempotency_key,
    processing_started_at, processing_claim_token,
    created_at, updated_at
  ) values (
    v_new_id, p_studio_id, p_stripe_livemode, 'pending', v_new_key,
    now(), v_new_claim, now(), now()
  );

  return query
    select v_new_id, 'pending'::text, null::text, p_stripe_livemode,
           v_new_key, v_new_claim, true, false;
end;
$$;

revoke execute on function public.create_or_claim_stripe_account_provisioning(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.create_or_claim_stripe_account_provisioning(uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- complete_stripe_account_provisioning
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called by the server after
-- Stripe accounts.create returns successfully (or after polling
-- confirms an existing account from the prior idempotency key).
-- Locks / verifies: requires a matching (p_attempt_id, p_claim_token)
-- in a non-terminal state - rejecting late completions from a
-- worker whose claim was already taken over by another caller.
-- Invariant: this RPC is the SOLE place that may establish the
-- initial (studio, stripe_account, stripe_livemode) binding in
-- studio_payment_settings. The ON CONFLICT clause refuses to
-- overwrite an existing binding (the partial WHERE guards against
-- silently swapping accounts on an already-onboarded studio).
create or replace function public.complete_stripe_account_provisioning(
  p_attempt_id          uuid,
  p_claim_token         uuid,
  p_stripe_account_id   text,
  p_stripe_livemode     boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_id uuid;
  v_attempt_mode boolean;
  v_existing_settings public.studio_payment_settings%rowtype;
begin
  -- P0 FINAL_FIXED #3: reject blank-string Stripe Account IDs in
  -- addition to NULL. A blank string would still satisfy the
  -- prior `is not null` guard but would corrupt the studio's
  -- configured binding (subsequent webhooks/RPCs would treat ''
  -- as the account identifier and never match the real account).
  if nullif(trim(coalesce(p_stripe_account_id, '')), '') is null
     or p_stripe_livemode is null then
    raise exception 'p_stripe_account_id and p_stripe_livemode must be supplied (non-blank)'
      using errcode = '22023';
  end if;

  -- Read studio_id + stored attempt mode under the claim lock
  -- WITHOUT writing yet (P0 #7 v2). We need to validate the
  -- existing settings binding before flipping the attempt to
  -- 'succeeded' so a conflicting binding aborts cleanly.
  select spa.studio_id, spa.stripe_livemode
    into v_studio_id, v_attempt_mode
  from public.stripe_account_provisioning_attempts spa
  where spa.id = p_attempt_id
    and spa.processing_claim_token is not distinct from p_claim_token
    and spa.status in ('pending', 'processing')
  for update;
  if not found then
    raise exception 'account provisioning claim mismatch or terminal'
      using errcode = 'P0002';
  end if;

  -- Stored attempt mode must match the completing caller's mode.
  -- (NULL stored mode is permitted only for legacy rows; the
  -- v2 create_or_claim path always stamps the mode at insert.)
  if v_attempt_mode is not null
     and v_attempt_mode is distinct from p_stripe_livemode then
    raise exception 'attempt % was opened for mode %, cannot be completed as mode %', p_attempt_id, v_attempt_mode, p_stripe_livemode
      using errcode = 'P0002';
  end if;

  -- Lock the (possible) existing settings row. If a binding
  -- already exists and disagrees with the Stripe result, ABORT
  -- and roll back - we never silently swap an established binding.
  select * into v_existing_settings
  from public.studio_payment_settings sps
  where sps.studio_id = v_studio_id
  for update;
  if found
     and v_existing_settings.stripe_account_id is not null then
    if v_existing_settings.stripe_account_id is distinct from p_stripe_account_id
       or v_existing_settings.stripe_livemode is distinct from p_stripe_livemode then
      raise exception
        'studio % already bound to (%, livemode=%); refusing to complete provisioning as (%, livemode=%)',
        v_studio_id,
        v_existing_settings.stripe_account_id, v_existing_settings.stripe_livemode,
        p_stripe_account_id, p_stripe_livemode
        using errcode = 'P0002';
    end if;
  end if;

  -- Safe to flip the attempt to succeeded now.
  update public.stripe_account_provisioning_attempts spa
     set status                 = 'succeeded',
         stripe_account_id      = p_stripe_account_id,
         stripe_livemode        = p_stripe_livemode,
         processing_claim_token = null,
         terminal_at            = now(),
         updated_at             = now()
   where spa.id = p_attempt_id;

  -- Establish or confirm the binding. ON CONFLICT path with the
  -- partial WHERE means: if a binding existed and equalled this
  -- result we already validated above and the UPDATE is a no-op;
  -- if the existing binding was NULL we install ours.
  insert into public.studio_payment_settings
    (studio_id, stripe_account_id, stripe_livemode, created_at, updated_at)
  values (v_studio_id, p_stripe_account_id, p_stripe_livemode, now(), now())
  on conflict (studio_id) do update set
    stripe_account_id = excluded.stripe_account_id,
    stripe_livemode   = excluded.stripe_livemode,
    updated_at        = now()
    where public.studio_payment_settings.stripe_account_id is null;
end;
$$;

revoke execute on function public.complete_stripe_account_provisioning(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_stripe_account_provisioning(uuid, uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_stripe_account_provisioning_failed
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Records a terminal failure
-- on an in-flight account provisioning attempt. Requires the
-- caller's claim_token to match (rejects late writes from a worker
-- whose claim was taken over). Does NOT touch studio_payment_settings,
-- because no binding was ever established on a failed attempt.
create or replace function public.mark_stripe_account_provisioning_failed(
  p_attempt_id      uuid,
  p_claim_token     uuid,
  p_error_code      text,
  p_error_message   text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.stripe_account_provisioning_attempts spa
     set status            = 'failed',
         error_code        = p_error_code,
         error_message     = p_error_message,
         processing_claim_token = null,
         terminal_at       = now(),
         updated_at        = now()
   where spa.id = p_attempt_id
     and spa.processing_claim_token is not distinct from p_claim_token
     and spa.status in ('pending', 'processing');
  if not found then
    raise exception 'account provisioning claim mismatch or terminal'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_stripe_account_provisioning_failed(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_stripe_account_provisioning_failed(uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- sync_studio_account_status
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called from
-- account.updated webhook handlers and from explicit refresh
-- buttons in studio settings.
-- Locks / verifies: takes FOR UPDATE on the studio_payment_settings
-- row and refuses to proceed if (a) no binding exists, (b) the
-- caller's (account, mode) tuple does not match the stored
-- binding. The RPC may update ONLY status / charges_enabled /
-- payouts_enabled / onboarding_completed_at; it MUST NOT create
-- a binding (that is exclusively complete_stripe_account_provisioning's
-- job).
-- Invariant prevented: a webhook for a stale or rogue
-- (account, mode) cannot install or overwrite the studio's
-- configured Stripe binding behind the user's back.
create or replace function public.sync_studio_account_status(
  p_studio_id                       uuid,
  p_stripe_account_id               text,
  p_stripe_livemode                 boolean,
  p_status                          text,
  p_charges_enabled                 boolean,
  p_payouts_enabled                 boolean,
  p_onboarding_completed_at         timestamptz
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.studio_payment_settings%rowtype;
begin
  if p_status is not null
     and p_status not in ('pending','restricted','enabled','rejected') then
    raise exception 'invalid stripe_account_status: %', p_status
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id
  for update;

  -- Hard refusal: this RPC will never create a binding. If the
  -- studio has not been onboarded yet, the only legitimate route
  -- to a binding is via complete_stripe_account_provisioning.
  if not found then
    raise exception 'studio % has no Stripe binding; sync_studio_account_status will not create one', p_studio_id
      using errcode = 'P0002';
  end if;

  -- Hard refusal: caller's claimed (account, mode) MUST match the
  -- stored binding exactly. Null-safe (we forbid null on either
  -- side - a webhook that lacks the account or mode has no
  -- business updating the status fields).
  if p_stripe_account_id is null
     or v_existing.stripe_account_id is distinct from p_stripe_account_id then
    raise exception 'stripe_account_id mismatch for studio %', p_studio_id
      using errcode = 'P0002';
  end if;
  if p_stripe_livemode is null
     or v_existing.stripe_livemode is distinct from p_stripe_livemode then
    raise exception 'stripe_livemode mismatch for studio %', p_studio_id
      using errcode = 'P0002';
  end if;

  -- Status fields only. We intentionally do NOT write
  -- stripe_account_id / stripe_livemode here.
  update public.studio_payment_settings sps
     set stripe_account_status            = p_status,
         stripe_charges_enabled           = coalesce(p_charges_enabled, false),
         stripe_payouts_enabled           = coalesce(p_payouts_enabled, false),
         stripe_onboarding_completed_at   = coalesce(p_onboarding_completed_at,
                                                     sps.stripe_onboarding_completed_at),
         updated_at                       = now()
   where sps.studio_id = p_studio_id;
end;
$$;

revoke execute on function public.sync_studio_account_status(uuid, text, boolean, text, boolean, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function public.sync_studio_account_status(uuid, text, boolean, text, boolean, boolean, timestamptz)
  to service_role;

-- ---- Customer provisioning ----

-- ---------------------------------------------------------------------------
-- find_or_create_client_for_booking
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Used inside
-- start_card_required_booking_session to resolve the client
-- identity for a public booking with an email address.
-- Verifies: exact-normalized-email match per studio. Returns the
-- pre-existing client if any; otherwise inserts a new client row.
-- Race handling: a concurrent insert that loses the
-- clients_studio_normalized_email_uniq race is caught and we
-- re-read the winning row, preventing duplicate-client + duplicate-
-- Stripe-Customer creation under a near-simultaneous double booking.
create or replace function public.find_or_create_client_for_booking(
  p_studio_id  uuid,
  p_email      text,
  p_name       text,
  p_phone      text
) returns table (
  client_id                  uuid,
  client_created_during_call boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_norm text;
  v_id uuid;
begin
  v_norm := nullif(lower(trim(coalesce(p_email, ''))), '');

  if v_norm is not null then
    select c.id into v_id
    from public.clients c
    where c.studio_id = p_studio_id and c.normalized_email = v_norm;
    if found then
      return query select v_id, false;
      return;
    end if;
  end if;

  insert into public.clients (studio_id, name, email, phone)
  values (p_studio_id, p_name, p_email, p_phone)
  returning id into v_id;

  return query select v_id, true;
exception
  when unique_violation then
    -- Concurrent insert race against
    -- clients_studio_normalized_email_uniq: re-read the winner.
    select c.id into v_id
    from public.clients c
    where c.studio_id = p_studio_id and c.normalized_email = v_norm;
    if not found then
      raise;
    end if;
    return query select v_id, false;
end;
$$;

revoke execute on function public.find_or_create_client_for_booking(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.find_or_create_client_for_booking(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- find_or_create_client_for_booking_payment_strict  (P0 v6 - new helper)
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. The STRICT variant used by
-- the card-required booking flow.
-- Difference from find_or_create_client_for_booking:
--   * Rejects blank / null email. The card-required path needs a
--     usable email for recovery URLs, charge receipts, and
--     dispute correspondence; creating a client without one
--     would silently produce a row that the card flow cannot
--     contact and that the cleanup retention path cannot tell
--     was created for payment purposes only.
--   * Otherwise identical: exact normalized-email match per
--     studio, race-safe insert with unique_violation re-read,
--     returns (client_id, client_created_during_call).
-- Application contract: Stripe Customer provisioning and
-- start_card_required_booking_session MUST use this strict helper.
-- The non-strict find_or_create_client_for_booking remains
-- available for non-payment booking flows where email is optional.
create or replace function public.find_or_create_client_for_booking_payment_strict(
  p_studio_id  uuid,
  p_email      text,
  p_name       text,
  p_phone      text
) returns table (
  client_id                  uuid,
  client_created_during_call boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_norm text;
  v_id uuid;
begin
  v_norm := nullif(lower(trim(coalesce(p_email, ''))), '');
  if v_norm is null then
    raise exception 'card-required booking requires a non-blank client email'
      using errcode = '22023';
  end if;

  select c.id into v_id
  from public.clients c
  where c.studio_id = p_studio_id and c.normalized_email = v_norm;
  if found then
    return query select v_id, false;
    return;
  end if;

  insert into public.clients (studio_id, name, email, phone)
  values (p_studio_id, p_name, p_email, p_phone)
  returning id into v_id;

  return query select v_id, true;
exception
  when unique_violation then
    select c.id into v_id
    from public.clients c
    where c.studio_id = p_studio_id and c.normalized_email = v_norm;
    if not found then
      raise;
    end if;
    return query select v_id, false;
end;
$$;

revoke execute on function public.find_or_create_client_for_booking_payment_strict(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.find_or_create_client_for_booking_payment_strict(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- create_or_claim_stripe_customer_provisioning
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only.
-- Locks / verifies: short-circuits to already_provisioned=true if a
-- mapping exists in client_stripe_customers for the
-- (client, studio, account, mode) tuple. Otherwise FOR UPDATE-locks
-- the latest non-terminal attempt row and serializes the claim
-- decision so two callers cannot both hit customers.create.
-- Invariant: at most one non-terminal attempt per
-- (client, studio, account, mode) due to partial unique index
-- stripe_customer_provisioning_active_uniq.
-- Retry handling: stale-claim takeover preserves the original
-- idempotency_key so Stripe deduplicates concurrent
-- customers.create requests.
create or replace function public.create_or_claim_stripe_customer_provisioning(
  p_client_id        uuid,
  p_studio_id        uuid,
  p_stripe_account_id text,
  p_stripe_livemode  boolean
) returns table (
  attempt_id                    uuid,
  out_status                    text,
  out_stripe_customer_id        text,
  out_idempotency_key           text,
  out_processing_claim_token    uuid,
  should_execute_stripe_call    boolean,
  already_provisioned           boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing public.stripe_customer_provisioning_attempts%rowtype;
  v_existing_cust text;
  v_new_id uuid;
  v_new_claim uuid;
  v_new_key text;
begin
  -- P0 v7 #8: payment-identity rule enforced in SQL.
  -- The card-required path requires a usable email on the client.
  -- Without this check, application code that bypasses
  -- find_or_create_client_for_booking_payment_strict could still
  -- provision a Stripe Customer against an email-less client and
  -- silently produce an uncontactable payment record.
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id
      and c.studio_id = p_studio_id
      and c.normalized_email is not null
  ) then
    raise exception 'client % does not belong to studio % or has no normalized_email (required for Stripe Customer provisioning)', p_client_id, p_studio_id
      using errcode = 'P0002';
  end if;

  select csc.stripe_customer_id into v_existing_cust
  from public.client_stripe_customers csc
  where csc.client_id = p_client_id
    and csc.studio_id = p_studio_id
    and csc.stripe_account_id = p_stripe_account_id
    and csc.stripe_livemode is not distinct from p_stripe_livemode;
  if found then
    return query
      select null::uuid, 'succeeded'::text, v_existing_cust, null::text,
             null::uuid, false, true;
    return;
  end if;

  -- Aliased + qualified to avoid output-column shadowing.
  select * into v_existing
  from public.stripe_customer_provisioning_attempts scpa
  where scpa.client_id = p_client_id
    and scpa.studio_id = p_studio_id
    and scpa.stripe_account_id = p_stripe_account_id
    and scpa.stripe_livemode is not distinct from p_stripe_livemode
    and scpa.status in ('pending', 'processing', 'succeeded')
  order by scpa.created_at desc
  limit 1
  for update;

  if found then
    if v_existing.status in ('succeeded', 'processing') then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_customer_id,
               v_existing.idempotency_key, v_existing.processing_claim_token,
               false, false;
      return;
    end if;
    if v_existing.processing_claim_token is not null
       and v_existing.processing_started_at > now() - interval '5 minutes' then
      return query
        select v_existing.id, v_existing.status, v_existing.stripe_customer_id,
               v_existing.idempotency_key, v_existing.processing_claim_token,
               false, false;
      return;
    end if;
    -- Stale-claim takeover: same idempotency key, fresh claim
    -- token. See identical pattern in account provisioning above.
    v_new_claim := gen_random_uuid();
    update public.stripe_customer_provisioning_attempts scpa
       set processing_claim_token = v_new_claim,
           processing_started_at = now(),
           updated_at = now()
     where scpa.id = v_existing.id;
    return query
      select v_existing.id, v_existing.status, v_existing.stripe_customer_id,
             v_existing.idempotency_key, v_new_claim, true, false;
    return;
  end if;

  v_new_id := gen_random_uuid();
  v_new_claim := gen_random_uuid();
  v_new_key := 'cust_' || p_client_id::text || '_' || gen_random_uuid()::text;

  insert into public.stripe_customer_provisioning_attempts (
    id, client_id, studio_id, stripe_account_id, stripe_livemode,
    status, idempotency_key,
    processing_started_at, processing_claim_token, created_at, updated_at
  ) values (
    v_new_id, p_client_id, p_studio_id, p_stripe_account_id, p_stripe_livemode,
    'pending', v_new_key,
    now(), v_new_claim, now(), now()
  );

  return query
    select v_new_id, 'pending'::text, null::text, v_new_key,
           v_new_claim, true, false;
end;
$$;

revoke execute on function public.create_or_claim_stripe_customer_provisioning(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_or_claim_stripe_customer_provisioning(uuid, uuid, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- complete_stripe_customer_provisioning
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called after Stripe
-- customers.create returns successfully.
-- Verifies: matching (p_attempt_id, p_claim_token) on a non-terminal
-- attempt row; rejects late writes from a worker whose claim was
-- taken over.
-- Invariant: this RPC is the sole place that establishes a row in
-- client_stripe_customers. The (client, studio, account, mode)
-- UNIQUE on client_stripe_customers means a race that double-runs
-- this RPC will land as unique_violation rather than silently
-- creating a duplicate Stripe Customer mapping.
create or replace function public.complete_stripe_customer_provisioning(
  p_attempt_id            uuid,
  p_claim_token           uuid,
  p_stripe_customer_id    text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_client_id uuid;
  v_studio_id uuid;
  v_account_id text;
  v_livemode boolean;
begin
  -- P0 FINAL_FIXED #3: reject blank-string Stripe Customer IDs
  -- BEFORE the attempt UPDATE so we never persist a blank ID
  -- onto stripe_customer_provisioning_attempts or write a
  -- mapping row in client_stripe_customers with an empty
  -- stripe_customer_id (which would corrupt all subsequent
  -- session and charge lookups for that client).
  if nullif(trim(coalesce(p_stripe_customer_id, '')), '') is null then
    raise exception 'p_stripe_customer_id is required and must be non-blank'
      using errcode = '22023';
  end if;

  update public.stripe_customer_provisioning_attempts scpa
     set status                 = 'succeeded',
         stripe_customer_id     = p_stripe_customer_id,
         processing_claim_token = null,
         terminal_at            = now(),
         updated_at             = now()
   where scpa.id = p_attempt_id
     and scpa.processing_claim_token is not distinct from p_claim_token
     and scpa.status in ('pending', 'processing')
  returning scpa.client_id, scpa.studio_id, scpa.stripe_account_id, scpa.stripe_livemode
       into v_client_id, v_studio_id, v_account_id, v_livemode;
  if not found then
    raise exception 'customer provisioning claim mismatch or terminal'
      using errcode = 'P0002';
  end if;

  insert into public.client_stripe_customers (
    client_id, studio_id, stripe_account_id, stripe_livemode,
    stripe_customer_id, created_at, updated_at
  ) values (
    v_client_id, v_studio_id, v_account_id, v_livemode,
    p_stripe_customer_id, now(), now()
  );
end;
$$;

revoke execute on function public.complete_stripe_customer_provisioning(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_stripe_customer_provisioning(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_stripe_customer_provisioning_failed
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Records a terminal failure
-- on a customer provisioning attempt. Same claim-token guard as
-- the account variant: late writes from a taken-over claim are
-- rejected.
create or replace function public.mark_stripe_customer_provisioning_failed(
  p_attempt_id      uuid,
  p_claim_token     uuid,
  p_error_code      text,
  p_error_message   text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.stripe_customer_provisioning_attempts scpa
     set status            = 'failed',
         error_code        = p_error_code,
         error_message     = p_error_message,
         processing_claim_token = null,
         terminal_at       = now(),
         updated_at        = now()
   where scpa.id = p_attempt_id
     and scpa.processing_claim_token is not distinct from p_claim_token
     and scpa.status in ('pending', 'processing');
  if not found then
    raise exception 'customer provisioning claim mismatch or terminal'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_stripe_customer_provisioning_failed(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_stripe_customer_provisioning_failed(uuid, uuid, text, text)
  to service_role;

-- ---- Session lifecycle ----

-- ---------------------------------------------------------------------------
-- start_card_required_booking_session
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called from the public
-- booking server action AFTER:
--   (a) client identity has been resolved exactly ONCE upstream
--       via find_or_create_client_for_booking (the caller passes
--       in p_client_id + p_client_created_during_session); AND
--   (b) the studio's Stripe Customer for that client has been
--       provisioned successfully.
-- Why this split (P0 #9 v2): the caller MUST resolve canonical
-- client identity before Stripe Customer provisioning, then pass
-- the same (client_id, created-in-this-flow) into both
-- provisioning AND this RPC. Otherwise an abandoned booking that
-- created the client row purely for the payment flow would lose
-- the 'newly created' signal needed by privacy-retention cleanup
-- of orphan client rows.
-- Verifies: that a client_stripe_customers row exists for the
-- (client, studio, account, mode, customer) tuple - the session
-- cannot be born referencing a Stripe Customer mapping that does
-- not exist yet.
-- Snapshot: the service's current price_cents is snapped onto the
-- session as quoted_price_cents_snapshot for DISPLAY/REFERENCE
-- only (NOT a charge cap; see table comment). The booking page
-- renders this snapshot as 'quoted service price at booking: $X'
-- and MUST NOT display cap-implying charge language.
create or replace function public.start_card_required_booking_session(
  p_studio_id                       uuid,
  p_service_id                      uuid,
  p_practitioner_id                 uuid,
  p_client_id                       uuid,
  p_client_created_during_session   boolean,
  p_requested_starts_at             timestamptz,
  p_requested_ends_at               timestamptz,
  p_requested_duration_minutes      integer,
  p_stripe_account_id               text,
  p_stripe_livemode                 boolean,
  p_stripe_customer_id              text,
  p_token_hash                      text
) returns table (
  session_id                    uuid,
  out_client_id                 uuid,
  out_client_created_during_session boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session_id uuid;
  v_quoted_price integer;
  v_studio_name text;
  v_settings public.studio_payment_settings%rowtype;
begin
  if p_client_id is null then
    raise exception 'p_client_id must be provided; resolve client identity upstream via find_or_create_client_for_booking_payment_strict'
      using errcode = '22023';
  end if;
  if p_client_created_during_session is null then
    raise exception 'p_client_created_during_session must be non-null'
      using errcode = '22023';
  end if;

  -- P0 v7 #4 PREFLIGHT: time-range integrity.
  --   * non-null timestamps
  --   * end > start
  --   * positive duration
  --   * EXACT equality:
  --       requested_ends_at = requested_starts_at + duration minutes
  -- The exact-equality rule prevents a session, an appointment row,
  -- and a calendar reservation from each carrying a slightly
  -- different effective interval.
  if p_requested_starts_at is null or p_requested_ends_at is null then
    raise exception 'requested_starts_at and requested_ends_at are required'
      using errcode = '22023';
  end if;
  if p_requested_ends_at <= p_requested_starts_at then
    raise exception 'requested_ends_at must be strictly after requested_starts_at'
      using errcode = '22023';
  end if;
  if p_requested_duration_minutes is null or p_requested_duration_minutes <= 0 then
    raise exception 'requested_duration_minutes must be positive'
      using errcode = '22023';
  end if;
  if p_requested_ends_at <> p_requested_starts_at + make_interval(mins => p_requested_duration_minutes) then
    raise exception
      'requested time range (% to %) does not exactly equal % minutes',
      p_requested_starts_at, p_requested_ends_at, p_requested_duration_minutes
      using errcode = '22023';
  end if;

  -- P0 v6 PREFLIGHT: studio Stripe binding + card-required flag.
  -- The studio must have onboarded, be charges-enabled, and have
  -- explicitly turned on require_card_on_file, AND the caller's
  -- (account, mode) must match the configured binding. We refuse
  -- to create a card-required session against a misconfigured /
  -- mis-routed Stripe binding.
  select * into v_settings
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id;
  if not found
     or v_settings.stripe_account_id is null
     or v_settings.stripe_livemode is null then
    raise exception 'studio % has no Stripe binding; cannot start card-required booking', p_studio_id
      using errcode = 'P0002';
  end if;
  if v_settings.stripe_account_id is distinct from p_stripe_account_id
     or v_settings.stripe_livemode is distinct from p_stripe_livemode then
    raise exception 'requested (account, mode) does not match studio % stored binding', p_studio_id
      using errcode = 'P0002';
  end if;
  if v_settings.require_card_on_file is distinct from true then
    raise exception 'studio % has not enabled require_card_on_file', p_studio_id
      using errcode = 'P0002';
  end if;
  if v_settings.stripe_charges_enabled is distinct from true then
    raise exception 'studio % Stripe account is not charges_enabled', p_studio_id
      using errcode = 'P0002';
  end if;

  -- P0 v6 PREFLIGHT: service belongs to studio AND is active.
  -- The services.active column is the source of truth for whether
  -- the studio is offering the service publicly.
  if not exists (
    select 1 from public.services s
    where s.id = p_service_id
      and s.studio_id = p_studio_id
      and s.active = true
  ) then
    raise exception 'service % does not belong to studio % or is inactive', p_service_id, p_studio_id
      using errcode = 'P0002';
  end if;

  -- P0 v6 PREFLIGHT: practitioner belongs to studio AND is active.
  if not exists (
    select 1 from public.practitioners pr
    where pr.id = p_practitioner_id
      and pr.studio_id = p_studio_id
      and pr.active = true
  ) then
    raise exception 'practitioner % does not belong to studio % or is inactive', p_practitioner_id, p_studio_id
      using errcode = 'P0002';
  end if;

  -- Validate the client belongs to this studio (defense in depth;
  -- the FK below would catch it too) AND has a non-blank
  -- normalized email. The card-required path REQUIRES a usable
  -- email so the client can receive recovery URLs, charge
  -- receipts, and dispute notices.
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id
      and c.studio_id = p_studio_id
      and c.normalized_email is not null
  ) then
    raise exception 'client % does not belong to studio % or has no normalized_email (required for card-required booking)', p_client_id, p_studio_id
      using errcode = 'P0002';
  end if;

  -- Stripe Customer mapping must exist before the session is born.
  if not exists (
    select 1 from public.client_stripe_customers csc
    where csc.client_id = p_client_id
      and csc.studio_id = p_studio_id
      and csc.stripe_account_id = p_stripe_account_id
      and csc.stripe_livemode is not distinct from p_stripe_livemode
      and csc.stripe_customer_id = p_stripe_customer_id
  ) then
    raise exception 'stripe customer not provisioned for (client, studio, account, mode)'
      using errcode = 'P0002';
  end if;

  select s.price_cents into v_quoted_price
  from public.services s
  where s.id = p_service_id and s.studio_id = p_studio_id;

  -- Snapshot the studio name from a server-trusted source for the
  -- consent text; this is what record_payment_consent_for_session
  -- reads later, so the consent always uses a name the database
  -- chose, never a name the browser proposed.
  select s.name into v_studio_name
  from public.studios s
  where s.id = p_studio_id;

  v_session_id := gen_random_uuid();
  insert into public.pending_booking_payment_sessions (
    id, token_hash, studio_id, service_id, practitioner_id,
    client_id, client_created_during_session,
    requested_starts_at, requested_ends_at, requested_duration_minutes,
    quoted_price_cents_snapshot,
    stripe_account_id, stripe_livemode, stripe_customer_id,
    studio_name_snapshot,
    status, created_at, updated_at
  ) values (
    v_session_id, p_token_hash, p_studio_id, p_service_id, p_practitioner_id,
    p_client_id, p_client_created_during_session,
    p_requested_starts_at, p_requested_ends_at, p_requested_duration_minutes,
    v_quoted_price,
    p_stripe_account_id, p_stripe_livemode, p_stripe_customer_id,
    v_studio_name,
    'pending', now(), now()
  );

  return query select v_session_id, p_client_id, p_client_created_during_session;
end;
$$;

revoke execute on function public.start_card_required_booking_session(
  uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, integer,
  text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.start_card_required_booking_session(
  uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, integer,
  text, boolean, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- record_payment_consent_for_session
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called from the public
-- booking page consent step.
-- Invariant: the SetupIntent client_secret is NEVER delivered to
-- the browser before this RPC succeeds. The application contract
-- is that the consent step renders, the user clicks 'I agree',
-- this RPC writes the immutable consent row, then and only then
-- does the page request the SetupIntent for the saved-card UI.
-- Locks the session FOR UPDATE so a concurrent attempt to skip
-- consent cannot race past status='pending'.
-- P0 #8 v2:
--   * accepted_at is set to now() inside SQL. A browser-provided
--     acceptance time would let a caller stamp an arbitrary
--     historical timestamp on an immutable consent row.
--   * studio_name_snapshot is read from the session row's
--     server-trusted studio_name_snapshot (which
--     start_card_required_booking_session populated from the
--     studios table), NOT from a parameter. The browser cannot
--     influence the name on the consent record.
--   * session expires_at MUST still be in the future.
create or replace function public.record_payment_consent_for_session(
  p_session_id                    uuid,
  p_policy_version                text,
  p_rendered_consent_text_hash    text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_id uuid;
  v_client_id uuid;
  v_consent_id uuid;
  v_studio_name text;
begin
  select pps.studio_id, pps.client_id, pps.studio_name_snapshot
    into v_studio_id, v_client_id, v_studio_name
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id
    and pps.status = 'pending'
    and pps.expires_at > now()
  for update;
  if not found then
    raise exception 'session not in consent-collectable state (expired or wrong status)'
      using errcode = 'P0002';
  end if;
  if v_studio_name is null then
    -- Session was created by an older code path; refuse rather
    -- than silently letting the browser fill this in.
    raise exception 'session % has no server-trusted studio_name_snapshot', p_session_id
      using errcode = 'P0002';
  end if;

  v_consent_id := gen_random_uuid();
  insert into public.payment_consents (
    id, pending_booking_payment_session_id, studio_id, client_id,
    consent_type, policy_version, rendered_consent_text_hash,
    studio_name_snapshot, accepted_at, created_at
  ) values (
    v_consent_id, p_session_id, v_studio_id, v_client_id,
    'card_on_file_and_treatment_charge',
    p_policy_version, p_rendered_consent_text_hash,
    v_studio_name, now(), now()
  );

  update public.pending_booking_payment_sessions pps
     set status = 'consent_recorded', updated_at = now()
   where pps.id = p_session_id;

  return v_consent_id;
end;
$$;

revoke execute on function public.record_payment_consent_for_session(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_payment_consent_for_session(uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_session_setup_intent_created
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Stamps the SetupIntent ID
-- on the session row, advancing it from consent_recorded to
-- setup_intent_created.
-- P0 #2 v2 / P0 #8 v2 callback-race + expiry handling:
--   * Session must still be unexpired (expires_at > now()).
--   * If the same SetupIntent ID was already stored by
--     reconcile_setup_intent_succeeded (the webhook beat the
--     server response), we treat the call as an idempotent
--     no-op rather than rejecting a legitimate callback race.
--   * Different stored SetupIntent ID on the same session is a
--     hard refusal - identity drift is never silent.
create or replace function public.mark_session_setup_intent_created(
  p_session_id              uuid,
  p_stripe_setup_intent_id  text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
begin
  -- P0 v7 #2: never accept a null/blank SetupIntent ID. Storing
  -- one would create a 'setup_intent_created' session row that
  -- the constraint pending_booking_payment_sessions_si_required_check
  -- would reject; we surface the cause early with a clearer error.
  if nullif(trim(coalesce(p_stripe_setup_intent_id, '')), '') is null then
    raise exception 'p_stripe_setup_intent_id is required and must be non-blank'
      using errcode = '22023';
  end if;

  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'session % is expired; cannot stamp SetupIntent', p_session_id
      using errcode = 'P0002';
  end if;

  -- Idempotent callback race: webhook already stored the same
  -- SetupIntent via reconcile_setup_intent_succeeded.
  if v_session.stripe_setup_intent_id is not null
     and v_session.stripe_setup_intent_id = p_stripe_setup_intent_id
     and v_session.status in ('setup_intent_created',
                              'payment_method_saved_pending_finalization') then
    return;
  end if;
  if v_session.stripe_setup_intent_id is not null
     and v_session.stripe_setup_intent_id <> p_stripe_setup_intent_id then
    raise exception 'session % already has a different SetupIntent stored', p_session_id
      using errcode = 'P0002';
  end if;

  update public.pending_booking_payment_sessions pps
     set stripe_setup_intent_id = p_stripe_setup_intent_id,
         status                 = 'setup_intent_created',
         updated_at             = now()
   where pps.id = p_session_id
     and pps.status = 'consent_recorded';
  if not found then
    raise exception 'session not in consent_recorded state' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_session_setup_intent_created(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_session_setup_intent_created(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_session_payment_method_saved
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Records the resolved
-- PaymentMethod ID for the saved card and advances the session
-- to payment_method_saved_pending_finalization (ready for
-- finalize_card_required_public_booking).
-- P0 #2 v2 / P0 #8 v2:
--   * Session must still be unexpired (this RPC routes into
--     FINALIZATION, not cleanup).
--   * If the session is already
--     payment_method_saved_pending_finalization with the SAME
--     stored PaymentMethod ID, we treat the call as an idempotent
--     no-op (webhook already wrote it via reconcile_setup_intent_succeeded).
--   * Different stored PaymentMethod ID is a hard refusal.
create or replace function public.mark_session_payment_method_saved(
  p_session_id                uuid,
  p_stripe_payment_method_id  text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
begin
  -- P0 v7 #2: never accept a null/blank PaymentMethod ID.
  if nullif(trim(coalesce(p_stripe_payment_method_id, '')), '') is null then
    raise exception 'p_stripe_payment_method_id is required and must be non-blank'
      using errcode = '22023';
  end if;

  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  -- P0 v7 #2: the SetupIntent ID MUST already be stored before
  -- we can record a PaymentMethod for this session. Without it
  -- the row would land in payment_method_saved_pending_finalization
  -- without lineage to the SetupIntent that produced the PM.
  if v_session.stripe_setup_intent_id is null then
    raise exception 'session % has no stored SetupIntent; cannot stamp PaymentMethod', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'session % is expired; finalization path requires an unexpired session', p_session_id
      using errcode = 'P0002';
  end if;

  -- Idempotent callback race.
  if v_session.status = 'payment_method_saved_pending_finalization'
     and v_session.stripe_payment_method_id is not null
     and v_session.stripe_payment_method_id = p_stripe_payment_method_id then
    return;
  end if;
  if v_session.stripe_payment_method_id is not null
     and v_session.stripe_payment_method_id <> p_stripe_payment_method_id then
    raise exception 'session % already has a different PaymentMethod stored', p_session_id
      using errcode = 'P0002';
  end if;

  update public.pending_booking_payment_sessions pps
     set stripe_payment_method_id = p_stripe_payment_method_id,
         status = 'payment_method_saved_pending_finalization',
         updated_at = now()
   where pps.id = p_session_id
     and pps.status = 'setup_intent_created';
  if not found then
    raise exception 'session not in setup_intent_created state' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_session_payment_method_saved(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_session_payment_method_saved(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- finalize_card_required_public_booking
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. The application MUST verify
-- with Stripe (via setupIntents.retrieve) that the PaymentMethod
-- and Customer match the session BEFORE invoking this RPC; the
-- p_verified_* parameters are the result of that verification.
-- Locks: session FOR UPDATE under a strict WHERE that requires
-- consumed_at IS NULL, expires_at IN THE FUTURE,
-- status = payment_method_saved_pending_finalization, and
-- exact SetupIntent + PaymentMethod identity match. This is the
-- structural guard against re-using a token whose session was
-- already consumed or whose PM was swapped under us.
-- Invariant: the appointment_payments row inherits the FULL
-- (account, mode, customer) lineage from the session via the
-- six-tuple FK declared on the table. The new
-- appointment_payments_pending_session_unique constraint
-- additionally ensures one pending session can only finalize one
-- appointment.
-- Token: cancellation_token is generated from
-- extensions.gen_random_bytes; schema-qualified because we run
-- under hardened search_path = pg_catalog, pg_temp. Block 0
-- asserted pgcrypto's schema at apply time.
create or replace function public.finalize_card_required_public_booking(
  p_token_hash                 text,
  p_studio_id                  uuid,
  p_verified_setup_intent_id   text,
  p_verified_payment_method_id text,
  p_notes                      text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
  v_consent_id uuid;
  v_service public.services%rowtype;
  v_settings public.studio_payment_settings%rowtype;
  v_appointment_id uuid;
  v_appt_token text;
  v_detach_in_progress boolean;
begin
  -- P0 v7 #2: hard-refuse null/blank verified IDs. The application
  -- must have already verified these with Stripe before calling.
  if nullif(trim(coalesce(p_verified_setup_intent_id, '')), '') is null then
    raise exception 'p_verified_setup_intent_id is required and must be non-blank'
      using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_verified_payment_method_id, '')), '') is null then
    raise exception 'p_verified_payment_method_id is required and must be non-blank'
      using errcode = '22023';
  end if;

  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.token_hash = p_token_hash
    and pps.studio_id  = p_studio_id
    and pps.consumed_at is null
    and pps.expires_at > now()
    and pps.status = 'payment_method_saved_pending_finalization'
    and pps.stripe_setup_intent_id is not distinct from p_verified_setup_intent_id
    and pps.stripe_payment_method_id is not distinct from p_verified_payment_method_id
  for update;
  if not found then
    raise exception 'booking session not in finalizable state' using errcode = 'P0002';
  end if;

  select pc.id into v_consent_id
  from public.payment_consents pc
  where pc.pending_booking_payment_session_id = v_session.id;
  if not found then
    raise exception 'missing consent for session %', v_session.id using errcode = 'P0002';
  end if;

  -- P0 v7 #5: re-check service exists, belongs to studio, AND is
  -- still active. The booking page may have stayed open while the
  -- owner deactivated or deleted the service.
  select * into v_service
  from public.services s
  where s.id = v_session.service_id
    and s.studio_id = v_session.studio_id
    and s.active = true;
  if not found then
    raise exception 'service % no longer available or inactive on studio %', v_session.service_id, v_session.studio_id
      using errcode = 'P0002';
  end if;

  -- P0 v7 #5: re-check practitioner exists, belongs to studio, AND
  -- is still active.
  if not exists (
    select 1 from public.practitioners pr
    where pr.id = v_session.practitioner_id
      and pr.studio_id = v_session.studio_id
      and pr.active = true
  ) then
    raise exception 'practitioner % no longer available or inactive on studio %', v_session.practitioner_id, v_session.studio_id
      using errcode = 'P0002';
  end if;

  -- P0 v7 #5: re-check studio Stripe binding still matches session,
  -- require_card_on_file still true, charges_enabled still true.
  select * into v_settings
  from public.studio_payment_settings sps
  where sps.studio_id = v_session.studio_id;
  if not found
     or v_settings.stripe_account_id is null
     or v_settings.stripe_livemode is null
     or v_settings.stripe_account_id is distinct from v_session.stripe_account_id
     or v_settings.stripe_livemode is distinct from v_session.stripe_livemode then
    raise exception 'studio % Stripe binding no longer matches session (account/mode swap or unset)', v_session.studio_id
      using errcode = 'P0002';
  end if;
  if v_settings.require_card_on_file is distinct from true then
    raise exception 'studio % no longer requires card on file', v_session.studio_id
      using errcode = 'P0002';
  end if;
  if v_settings.stripe_charges_enabled is distinct from true then
    raise exception 'studio % Stripe account is not charges_enabled', v_session.studio_id
      using errcode = 'P0002';
  end if;

  -- P0 v7 #4: re-check time-range integrity as defense in depth.
  if v_session.requested_ends_at <> v_session.requested_starts_at
       + make_interval(mins => v_session.requested_duration_minutes) then
    raise exception 'session % time range (% to %) does not exactly equal % minutes',
      v_session.id, v_session.requested_starts_at, v_session.requested_ends_at,
      v_session.requested_duration_minutes
      using errcode = '22023';
  end if;

  -- P0 v7 #3: acquire the shared PaymentMethod-tuple advisory lock
  -- AND check the durable cleanup_detach_state guard for this PM.
  -- If any pending-session row for the EXACT same PM tuple is
  -- mid-detach or already detached, we must NOT finalize against
  -- that PM. The check covers detach_authorized,
  -- detach_failed_retryable, and detached states. Either:
  --   - finalization wins first and proceeds: the cleanup-safety
  --     RPC will subsequently see the new appointment_payments row
  --     and return skip_detach_pm_in_use.
  --   - cleanup-safety wins first and persists detach_authorized:
  --     finalization arrives here, takes the lock, observes the
  --     detach guard, and refuses with payment_method_cleanup_in_progress_or_completed.
  perform public._acquire_payment_method_tuple_xact_lock(
    v_session.studio_id, v_session.client_id,
    v_session.stripe_account_id, v_session.stripe_livemode,
    v_session.stripe_customer_id, v_session.stripe_payment_method_id
  );
  select exists (
    select 1
    from public.pending_booking_payment_sessions pps
    where pps.studio_id                = v_session.studio_id
      and pps.client_id                = v_session.client_id
      and pps.stripe_account_id        = v_session.stripe_account_id
      and pps.stripe_livemode is not distinct from v_session.stripe_livemode
      and pps.stripe_customer_id       = v_session.stripe_customer_id
      and pps.stripe_payment_method_id = v_session.stripe_payment_method_id
      and pps.cleanup_detach_state in (
        'detach_authorized', 'detach_failed_retryable', 'detached'
      )
  ) into v_detach_in_progress;
  if v_detach_in_progress then
    raise exception 'payment_method_cleanup_in_progress_or_completed for PM on session %', v_session.id
      using errcode = 'P0002';
  end if;

  -- Schema-qualified to survive hardened search_path. See Block 0
  -- assertion at the top of this migration.
  v_appt_token := encode(extensions.gen_random_bytes(24), 'base64');

  insert into public.appointments (
    studio_id, practitioner_id, client_id, service_id,
    starts_at, ends_at, duration_minutes,
    status, notes, cancellation_token
  ) values (
    v_session.studio_id, v_session.practitioner_id, v_session.client_id, v_session.service_id,
    v_session.requested_starts_at, v_session.requested_ends_at,
    v_session.requested_duration_minutes,
    'confirmed', p_notes, v_appt_token
  )
  returning id into v_appointment_id;

  -- The (account, mode, customer) tuple comes from the session
  -- row, not from RPC parameters, so a malicious caller cannot
  -- bind this payment row to a Stripe context different from the
  -- one that actually held the consent + saved PaymentMethod.
  insert into public.appointment_payments (
    appointment_id, studio_id, client_id,
    pending_booking_payment_session_id, payment_consent_id,
    stripe_account_id, stripe_livemode, stripe_customer_id,
    stripe_setup_intent_id, stripe_payment_method_id,
    payment_status, booked_price_cents_snapshot, created_at, updated_at
  ) values (
    v_appointment_id, v_session.studio_id, v_session.client_id,
    v_session.id, v_consent_id,
    v_session.stripe_account_id, v_session.stripe_livemode, v_session.stripe_customer_id,
    p_verified_setup_intent_id, p_verified_payment_method_id,
    'method_saved', v_session.quoted_price_cents_snapshot, now(), now()
  );

  update public.pending_booking_payment_sessions pps
     set status = 'finalized',
         consumed_at = now(),
         consumed_appointment_id = v_appointment_id,
         updated_at = now()
   where pps.id = v_session.id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appointment_id, 'client', null, 'created',
    jsonb_build_object('source', 'public_booking_card_required',
                       'session_id', v_session.id::text)
  );

  return v_appointment_id;
end;
$$;

revoke execute on function public.finalize_card_required_public_booking(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_card_required_public_booking(text, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_session_finalization_failed
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called when
-- finalize_card_required_public_booking has already returned a
-- saved PM but the appointment row could not be created (e.g.
-- the slot was taken concurrently).
-- P0 v3 (cleanup-queue unification):
--   The PM is guaranteed to exist on the source row (we only
--   accept the transition from payment_method_saved_pending_finalization,
--   where the PM was already saved during the SetupIntent).
--   Because a PM exists, this RPC routes the session directly into
--   the durable cleanup retry queue:
--     * status = 'cleanup_required'
--     * cleanup_claim_token = NULL (claimable by the next
--       claim_payment_method_cleanup_sessions sweep)
--     * cleanup_processing_started_at = NULL
--     * finalization_error_code / finalization_error_message stored
--       on the row for diagnostics.
--   The server MUST NOT call Stripe paymentMethods.detach
--   directly off the back of this RPC. All Stripe detach
--   operations happen exclusively through the claim/retry loop:
--     claim_payment_method_cleanup_sessions -> Stripe detach ->
--     mark_session_cleaned(<claim_token>).
--   This guarantees a saved card is never stranded outside the
--   retryable queue if the server crashes between
--   mark_session_finalization_failed and Stripe detach.
-- The RPC returns no Stripe identifiers any more: the cleanup
-- worker will read them under its claim token.
create or replace function public.mark_session_finalization_failed(
  p_session_id      uuid,
  p_error_code      text,
  p_error_message   text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
begin
  update public.pending_booking_payment_sessions pps
     set status = 'cleanup_required',
         finalization_error_code = p_error_code,
         finalization_error_message = p_error_message,
         cleanup_claim_token = null,
         cleanup_processing_started_at = null,
         cleanup_error_code = coalesce(pps.cleanup_error_code, 'finalization_failed'),
         updated_at = now()
   where pps.id = p_session_id
     and pps.status = 'payment_method_saved_pending_finalization'
     and pps.consumed_at is null
     and pps.stripe_payment_method_id is not null
  returning * into v_session;
  if not found then
    raise exception 'session not in finalizable-error state with saved PaymentMethod'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_session_finalization_failed(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_session_finalization_failed(uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- claim_payment_method_cleanup_sessions  (P0 v3 - unified-queue claim)
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Cron / worker entry point
-- for the SOLE durable cleanup retry queue. Every row routed into
-- status='cleanup_required' is claimed here regardless of how it
-- got there - expiry sweep, late-SetupIntent webhook, missing
-- consent, or finalization failure - so there is exactly one
-- code path that touches Stripe paymentMethods.detach.
-- Behaviour: claims a batch of cleanup_required sessions for this
-- worker by stamping cleanup_processing_started_at +
-- cleanup_claim_token. Both fresh (never-claimed) rows and stale
-- (>5 minute) prior claims become eligible. The returned claim
-- token MUST be passed to mark_session_cleaned along with the
-- session_id; mismatched tokens are rejected.
-- Audit: every claimed row appends 'payment_method_cleanup_attempted'
-- with origin metadata derived from the session's
-- cleanup_error_code or finalization_error_code, so the audit
-- timeline records WHY this cleanup is being attempted.
-- Why this exists: without claiming, two concurrent cron workers
-- could both call Stripe paymentMethods.detach against the same
-- PM, and a transient failure on one worker could mask the work
-- of another. Without unification, a row that landed in
-- 'finalization_failed' would never appear in this queue and a
-- crash mid-detach would strand the saved card.
create or replace function public.claim_payment_method_cleanup_sessions(
  p_studio_id  uuid,
  p_batch_size integer default 25
) returns table (
  out_session_id                uuid,
  out_stripe_customer_id        text,
  out_stripe_payment_method_id  text,
  out_cleanup_claim_token       uuid,
  out_stripe_account_id         text,
  out_stripe_livemode           boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row record;
  v_origin text;
begin
  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 200 then
    raise exception 'p_batch_size out of range' using errcode = '22023';
  end if;

  for v_row in
    with cte as (
      select pps.id
      from public.pending_booking_payment_sessions pps
      where pps.studio_id = p_studio_id
        and pps.status = 'cleanup_required'
        and pps.stripe_payment_method_id is not null
        -- P0 v7 #3: re-claim eligible rows include never-claimed
        -- P0 FINAL #2: claim eligibility extended for crash
        -- recovery. We claim:
        --   * fresh rows (cleanup_detach_state IS NULL) - never
        --     decided yet, safety check will run.
        --   * 'detach_failed_retryable' rows - previous detach
        --     failed transiently; reset to null on re-claim so
        --     the safety check runs again from scratch.
        --   * STALE 'detach_authorized' rows - safety decision
        --     was made but the previous worker crashed before
        --     mark_session_cleaned. Preserve the durable guard
        --     ('detach_authorized'); the retry worker reads it
        --     and resolves (call Stripe retrieve to learn whether
        --     detach already completed, then mark_session_cleaned).
        --     The PaymentMethod stays finalization-blocked until
        --     the retry worker writes terminal cleanup.
        --   * STALE 'skip_detach_pm_in_use' rows - safety decided
        --     skip but the previous worker crashed before writing
        --     the terminal cleanup record. Preserve the durable
        --     guard; the retry worker performs NO Stripe call and
        --     immediately completes mark_session_cleaned with
        --     outcome='cleaned_pm_in_use' under the new token.
        -- We DO NOT re-claim rows already in 'detached' -
        -- that is a terminal cleanup decision and there is no
        -- Stripe work left to do.
        --
        -- Staleness is enforced by the cleanup_processing_started_at
        -- 5-minute lease check below: a row whose previous claim
        -- is still fresh remains owned by the previous worker.
        and pps.cleanup_detach_state is distinct from 'detached'
        and (
          pps.cleanup_processing_started_at is null
          or pps.cleanup_processing_started_at <= now() - interval '5 minutes'
        )
      order by pps.cleanup_processing_started_at nulls first, pps.updated_at
      limit p_batch_size
      for update skip locked
    )
    update public.pending_booking_payment_sessions pps
       set cleanup_processing_started_at = now(),
           cleanup_claim_token           = gen_random_uuid(),
           -- P0 FINAL #2: re-claiming a detach_failed_retryable
           -- row clears the failed marker so the safety check
           -- re-evaluates. 'detach_authorized' and
           -- 'skip_detach_pm_in_use' are PRESERVED so the
           -- durable finalization block stays in force and the
           -- retry worker honours the pre-existing decision.
           cleanup_detach_state          = case
             when pps.cleanup_detach_state = 'detach_failed_retryable'
               then null
             else pps.cleanup_detach_state
           end,
           updated_at                    = now()
      from cte
     where pps.id = cte.id
    returning pps.id, pps.stripe_customer_id, pps.stripe_payment_method_id,
              pps.cleanup_claim_token, pps.stripe_account_id, pps.stripe_livemode,
              pps.studio_id, pps.cleanup_error_code, pps.finalization_error_code
  loop
    -- Origin label for the audit row: stable categorization of why
    -- this row landed in the cleanup queue, derived from existing
    -- session columns. (Finalization failures land with
    -- cleanup_error_code = 'finalization_failed' set by
    -- mark_session_finalization_failed.)
    v_origin := coalesce(
      v_row.cleanup_error_code,
      case when v_row.finalization_error_code is not null
           then 'finalization_failed'
           else 'unknown' end
    );
    perform public._append_stripe_payment_audit(
      null, v_row.id, v_row.studio_id, null,
      'payment_method_cleanup_attempted', null,
      null, null,
      null, null, null, null,
      null, null, null, null,
      jsonb_build_object(
        'trigger', 'claim_payment_method_cleanup_sessions',
        'origin', v_origin
      ),
      v_row.stripe_account_id, v_row.stripe_livemode
    );
    out_session_id := v_row.id;
    out_stripe_customer_id := v_row.stripe_customer_id;
    out_stripe_payment_method_id := v_row.stripe_payment_method_id;
    out_cleanup_claim_token := v_row.cleanup_claim_token;
    out_stripe_account_id := v_row.stripe_account_id;
    out_stripe_livemode := v_row.stripe_livemode;
    return next;
  end loop;
end;
$$;

revoke execute on function public.claim_payment_method_cleanup_sessions(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_payment_method_cleanup_sessions(uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- check_claimed_payment_method_cleanup_safety  (P0 v6 - new RPC)
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. MUST be called by the
-- cleanup worker between claim_payment_method_cleanup_sessions
-- and any Stripe paymentMethods.detach call.
--
-- Why this RPC exists (P0 v6 #1):
--   mark_session_cleaned accepts the 'cleaned_pm_in_use' outcome,
--   but nothing in SQL previously proved whether the claimed
--   PaymentMethod is still legitimately referenced by a
--   finalized payment workflow. A worker could therefore call
--   stripe.paymentMethods.detach against a PM that an existing
--   appointment_payments row still depends on for off-session
--   charging, silently breaking a future charge.
--
-- Verifies (under FOR UPDATE on the session row):
--   * session.status = 'cleanup_required';
--   * stored cleanup_claim_token is non-null AND equals
--     p_cleanup_claim_token;
--   * session has a non-null stripe_payment_method_id.
--
-- Then queries appointment_payments for any FINALIZED row that
-- references the SAME
--   (studio_id, client_id, stripe_account_id, stripe_livemode,
--    stripe_payment_method_id)
-- tuple. A 'finalized' appointment_payments row exists by
-- construction the moment finalize_card_required_public_booking
-- inserts it, so the existence of any such row proves the PM is
-- in use.
--
-- Returns one row with structured outcome:
--   decision IN ('safe_to_detach', 'skip_detach_pm_in_use')
--   stripe_account_id / stripe_livemode / stripe_customer_id /
--   stripe_payment_method_id - identifiers the worker needs to
--     pass to Stripe (only revealed after claim + safety check
--     have both validated).
--
-- Application contract (P0 v6 unified cleanup loop):
--   1. claim_payment_method_cleanup_sessions returns claim_token.
--   2. check_claimed_payment_method_cleanup_safety with that
--      token returns decision.
--   3a. decision = 'skip_detach_pm_in_use' -> DO NOT call Stripe;
--       call mark_session_cleaned(... 'cleaned_pm_in_use' ...,
--       claim_token).
--   3b. decision = 'safe_to_detach' -> call stripe.paymentMethods.detach,
--       then mark_session_cleaned(... 'cleaned' ..., claim_token)
--       on success or mark_session_cleaned(... 'cleanup_required' ...,
--       claim_token) on retryable failure.
--   No Stripe detach may occur without both a matching claim
--   token AND a 'safe_to_detach' outcome from this RPC.
--
-- Audit: appends 'payment_method_cleanup_safety_checked' with
-- metadata.decision so the audit timeline records the safety
-- decision and the application's compliance with the contract
-- is auditable.
create or replace function public.check_claimed_payment_method_cleanup_safety(
  p_session_id          uuid,
  p_cleanup_claim_token uuid
) returns table (
  decision                  text,
  out_stripe_account_id     text,
  out_stripe_livemode       boolean,
  out_stripe_customer_id    text,
  out_stripe_payment_method_id text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
  v_in_use boolean;
  v_decision text;
begin
  if p_cleanup_claim_token is null then
    raise exception 'p_cleanup_claim_token must be non-null'
      using errcode = '22023';
  end if;

  -- Lock the session row first to read its PM tuple and validate
  -- claim. We need the tuple to compute the advisory lock key.
  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id
  for update;
  if not found then
    raise exception 'session % not found', p_session_id using errcode = 'P0002';
  end if;

  if v_session.status <> 'cleanup_required' then
    raise exception 'session % is in status %, not cleanup_required', p_session_id, v_session.status
      using errcode = 'P0002';
  end if;
  if v_session.cleanup_claim_token is null
     or v_session.cleanup_claim_token is distinct from p_cleanup_claim_token then
    raise exception 'cleanup claim token mismatch on session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.stripe_payment_method_id is null then
    raise exception 'session % has no stored PaymentMethod to check', p_session_id
      using errcode = 'P0002';
  end if;

  -- P0 v7 #3: acquire the shared PaymentMethod-tuple advisory lock
  -- BEFORE checking finalized rows and BEFORE writing the durable
  -- detach guard. Any concurrent finalize_card_required_public_booking
  -- for the same PM tuple must serialize through this lock, so
  -- exactly one path wins:
  --   - if finalize wins first, its appointment_payments row is
  --     present here and we return skip_detach_pm_in_use;
  --   - if we win first, we persist cleanup_detach_state=
  --     'detach_authorized' and any later finalize that takes the
  --     same lock will observe that durable guard and refuse.
  perform public._acquire_payment_method_tuple_xact_lock(
    v_session.studio_id, v_session.client_id,
    v_session.stripe_account_id, v_session.stripe_livemode,
    v_session.stripe_customer_id, v_session.stripe_payment_method_id
  );

  -- Re-read the session row now that we hold the advisory lock,
  -- in case another transaction modified it between the SELECT
  -- FOR UPDATE above and the advisory acquisition. (The row-level
  -- lock kept it stable; this read just refreshes our local copy.)
  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id;

  -- Already-decided idempotent paths: a re-run of the safety
  -- check on the same row returns the same decision without
  -- toggling state.
  if v_session.cleanup_detach_state = 'detach_authorized' then
    perform public._append_stripe_payment_audit(
      null, v_session.id, v_session.studio_id, null,
      'payment_method_cleanup_safety_checked', null,
      null, null, null, null, null, null, null, null, null, null,
      jsonb_build_object('decision', 'safe_to_detach', 'reauthorized', true),
      v_session.stripe_account_id, v_session.stripe_livemode
    );
    return query
      select 'safe_to_detach'::text,
             v_session.stripe_account_id, v_session.stripe_livemode,
             v_session.stripe_customer_id, v_session.stripe_payment_method_id;
    return;
  end if;
  if v_session.cleanup_detach_state = 'skip_detach_pm_in_use' then
    return query
      select 'skip_detach_pm_in_use'::text,
             v_session.stripe_account_id, v_session.stripe_livemode,
             v_session.stripe_customer_id, v_session.stripe_payment_method_id;
    return;
  end if;

  -- detach_failed_retryable can be re-authorized by a retry claim
  -- after the safety check passes; we treat this as a fresh
  -- decision below.

  -- Is this PM referenced by ANY finalized appointment_payments
  -- row for the same (studio, client, account, mode, PM)? Any
  -- such row means the PM is still load-bearing for a future
  -- charge and MUST NOT be detached.
  select exists (
    select 1
    from public.appointment_payments ap
    where ap.studio_id                = v_session.studio_id
      and ap.client_id                = v_session.client_id
      and ap.stripe_account_id        = v_session.stripe_account_id
      and ap.stripe_livemode is not distinct from v_session.stripe_livemode
      and ap.stripe_payment_method_id = v_session.stripe_payment_method_id
  ) into v_in_use;

  v_decision := case when v_in_use
                     then 'skip_detach_pm_in_use'
                     else 'safe_to_detach' end;

  -- P0 FINAL #1: the function's external return vocabulary
  -- ('safe_to_detach' / 'skip_detach_pm_in_use') is the worker
  -- contract and MUST NOT change. The persisted durable guard,
  -- however, uses the table-CHECK vocabulary: the safe-to-detach
  -- branch writes 'detach_authorized' (not 'safe_to_detach',
  -- which is not in pending_booking_payment_sessions.cleanup_detach_state's
  -- allowed value set). v7 incorrectly tried to write the worker
  -- return value into the column, which would have failed the
  -- table CHECK at apply time on every safe-to-detach path.
  update public.pending_booking_payment_sessions pps
     set cleanup_detach_state      = case
           when v_in_use
             then 'skip_detach_pm_in_use'
             else 'detach_authorized'
         end,
         cleanup_detach_decided_at = now(),
         updated_at                = now()
   where pps.id = p_session_id;

  perform public._append_stripe_payment_audit(
    null, v_session.id, v_session.studio_id, null,
    'payment_method_cleanup_safety_checked', null,
    null, null,
    null, null, null, null,
    null, null, null, null,
    jsonb_build_object('decision', v_decision),
    v_session.stripe_account_id, v_session.stripe_livemode
  );

  return query
    select v_decision,
           v_session.stripe_account_id,
           v_session.stripe_livemode,
           v_session.stripe_customer_id,
           v_session.stripe_payment_method_id;
end;
$$;

revoke execute on function public.check_claimed_payment_method_cleanup_safety(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.check_claimed_payment_method_cleanup_safety(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_session_cleaned
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Records the outcome of a
-- PaymentMethod cleanup attempt against an abandoned session.
-- P0 v3 unified-cleanup-queue rule:
--   * The ONLY acceptable source status is 'cleanup_required'.
--     'finalization_failed' is no longer accepted here because
--     mark_session_finalization_failed now routes into
--     'cleanup_required' directly (the saved card lands in the
--     same durable retry queue as expiry-triggered cleanup).
--   * A matching p_cleanup_claim_token is ALWAYS required. There
--     is no claim-token-less direct cleanup path - every Stripe
--     detach is owned by the same claim/retry workflow so a
--     worker crash cannot lose the row, and two workers cannot
--     race the same detach.
--   * On terminal cleanup outcome (cleaned or retryable failure)
--     both cleanup_claim_token and cleanup_processing_started_at
--     are cleared. After a failure the row stays
--     'cleanup_required' and is immediately eligible for the next
--     claim_payment_method_cleanup_sessions call (the stale-lease
--     timer is irrelevant once the claim is cleared).
-- p_outcome semantics:
--   'cleaned'           - Stripe paymentMethods.detach succeeded.
--   'cleaned_pm_in_use' - detach was deliberately skipped because
--                         the PM is referenced by a valid finalized
--                         payment workflow we must not touch.
--                         Stored as status='cleaned' with audit
--                         metadata recording the skip reason.
--                         ('cleaned_pm_in_use' is NOT a stored
--                         status; it is an outcome label.)
--   'cleanup_required'  - detach failed; session stays
--                         'cleanup_required' so the next claim
--                         sweep retries with a fresh token.
create or replace function public.mark_session_cleaned(
  p_session_id        uuid,
  p_outcome           text,
  p_error_code        text,
  p_error_message     text,
  p_cleanup_claim_token uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_session public.pending_booking_payment_sessions%rowtype;
  v_audit_action text;
  v_audit_meta jsonb;
  v_existing public.pending_booking_payment_sessions%rowtype;
begin
  if p_outcome not in ('cleaned', 'cleanup_required', 'cleaned_pm_in_use') then
    raise exception 'invalid cleanup outcome' using errcode = '22023';
  end if;
  v_status := case
    when p_outcome in ('cleaned', 'cleaned_pm_in_use') then 'cleaned'
    else 'cleanup_required'
  end;

  select * into v_existing
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  -- Source-status gate: ONLY 'cleanup_required' is acceptable
  -- here (P0 v3). 'finalization_failed' is rejected because that
  -- legacy status path no longer exists for saved-PM sessions -
  -- mark_session_finalization_failed now writes 'cleanup_required'.
  if v_existing.status <> 'cleanup_required' then
    raise exception 'session % is in status %, not eligible for cleanup completion (only cleanup_required is accepted)', p_session_id, v_existing.status
      using errcode = 'P0002';
  end if;

  -- Claim-token gate is mandatory and applies to every cleanup
  -- completion. There is no token-less direct path.
  if p_cleanup_claim_token is null
     or v_existing.cleanup_claim_token is null
     or v_existing.cleanup_claim_token is distinct from p_cleanup_claim_token then
    raise exception 'cleanup claim token mismatch on session %', p_session_id
      using errcode = 'P0002';
  end if;

  -- P0 v7 #3: the recorded outcome MUST match the stored durable
  -- detach state set by check_claimed_payment_method_cleanup_safety.
  -- Without this gate, a worker could call mark_session_cleaned
  -- with an outcome inconsistent with the safety decision (e.g.
  -- recording 'cleaned' when the safety decision was
  -- skip_detach_pm_in_use, or recording cleaned_pm_in_use when
  -- the decision was safe_to_detach).
  if p_outcome = 'cleaned_pm_in_use' then
    if v_existing.cleanup_detach_state is distinct from 'skip_detach_pm_in_use' then
      raise exception 'cleaned_pm_in_use outcome requires cleanup_detach_state=skip_detach_pm_in_use (got %)', coalesce(v_existing.cleanup_detach_state, 'NULL')
        using errcode = 'P0002';
    end if;
  elsif p_outcome in ('cleaned', 'cleanup_required') then
    if v_existing.cleanup_detach_state is distinct from 'detach_authorized' then
      raise exception 'cleaned/cleanup_required outcome requires cleanup_detach_state=detach_authorized (got %)', coalesce(v_existing.cleanup_detach_state, 'NULL')
        using errcode = 'P0002';
    end if;
  end if;

  update public.pending_booking_payment_sessions pps
     set status = v_status,
         cleanup_attempted_at = now(),
         cleanup_completed_at = case when v_status = 'cleaned' then now() else null end,
         cleanup_error_code = p_error_code,
         cleanup_error_message = p_error_message,
         -- P0 v7 #3: advance the durable detach guard.
         --   'cleaned' from safe_to_detach -> 'detached'
         --     (Stripe detach succeeded; cleanup_detached_at stamped)
         --   'cleaned' from skip path      -> stays
         --     'skip_detach_pm_in_use'
         --   'cleanup_required' (retryable failure)
         --                                -> 'detach_failed_retryable'
         --     (finalization MUST still refuse this PM)
         cleanup_detach_state = case
           when p_outcome = 'cleaned_pm_in_use'
             then 'skip_detach_pm_in_use'
           when p_outcome = 'cleaned'
             then 'detached'
           else 'detach_failed_retryable'
         end,
         cleanup_detached_at = case
           when p_outcome = 'cleaned'
             then now()
           else pps.cleanup_detached_at
         end,
         -- Clear the claim fields on every terminal outcome.
         -- After a retryable failure (v_status='cleanup_required')
         -- this leaves the row instantly eligible for the next
         -- claim_payment_method_cleanup_sessions call.
         cleanup_claim_token  = null,
         cleanup_processing_started_at = null,
         updated_at = now()
   where pps.id = p_session_id
  returning * into v_session;

  -- Emit cleanup audit.
  if v_status = 'cleaned' then
    if p_outcome = 'cleaned_pm_in_use' then
      v_audit_action := 'payment_method_cleanup_succeeded';
      v_audit_meta := jsonb_build_object('detach_skipped_reason', 'payment_method_in_use');
    else
      v_audit_action := 'payment_method_cleanup_succeeded';
      v_audit_meta := '{}'::jsonb;
    end if;
  else
    v_audit_action := 'payment_method_cleanup_failed';
    v_audit_meta := '{}'::jsonb;
  end if;

  perform public._append_stripe_payment_audit(
    null, v_session.id, v_session.studio_id, null,
    v_audit_action, null,
    null, null,
    null, null, null, null,
    null, null, p_error_code, p_error_message, v_audit_meta,
    v_session.stripe_account_id, v_session.stripe_livemode
  );
end;
$$;

revoke execute on function public.mark_session_cleaned(uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_session_cleaned(uuid, text, text, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- expire_pending_sessions
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Cron-driven sweep that
-- transitions expired sessions out of in-flight state.
-- Routing rule (P0 v3): sessions that already saved a
-- PaymentMethod move to 'cleanup_required' and ENTER the single
-- durable cleanup retry queue.
-- P0 v6: this RPC NO LONGER returns Stripe Customer or
-- PaymentMethod identifiers. Every Stripe detach is owned by the
-- claim_payment_method_cleanup_sessions / mark_session_cleaned
-- loop, which reads identifiers from the claimed row under its
-- claim token. Returning identifiers from the cron sweep would
-- (a) leak Stripe IDs to a code path that does not need them and
-- (b) tempt callers to call Stripe directly off the back of this
-- RPC's output, which is forbidden by the unified cleanup
-- contract.
-- Sessions without a saved PM move to
-- 'expired_without_payment_method' (no Stripe-side cleanup
-- needed). The setup_intent_created status gets a 10-minute grace
-- so a webhook that confirms the SetupIntent can still be applied
-- if the user completed payment right before the timer fired
-- (handled in reconcile_setup_intent_succeeded).
-- Returns one row per transitioned session: just the metrics
-- needed by the cron caller (session id, status it landed in,
-- whether a cleanup claim will be needed in the next sweep).
-- Audit: emitted by claim_payment_method_cleanup_sessions when
-- the cleanup work is actually claimed, NOT here.
create or replace function public.expire_pending_sessions(
  p_studio_id uuid
) returns table (
  out_session_id            uuid,
  out_new_status            text,
  out_requires_pm_cleanup   boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row record;
begin
  for v_row in
    update public.pending_booking_payment_sessions pps
       set status = case
                      when pps.stripe_payment_method_id is not null
                        then 'cleanup_required'
                      else 'expired_without_payment_method'
                    end,
           updated_at = now()
     where pps.studio_id = p_studio_id
       and pps.consumed_at is null
       and (
         (pps.status in ('pending', 'consent_recorded',
                         'payment_method_saved_pending_finalization',
                         'finalization_failed')
            and pps.expires_at <= now())
         or
         -- setup_intent_created gets a 10-minute grace window so
         -- a delayed setup_intent.succeeded webhook can still land
         -- (see reconcile_setup_intent_succeeded).
         (pps.status = 'setup_intent_created'
            and pps.expires_at + interval '10 minutes' <= now())
       )
    returning pps.id, pps.status
  loop
    out_session_id := v_row.id;
    out_new_status := v_row.status;
    out_requires_pm_cleanup := (v_row.status = 'cleanup_required');
    return next;
  end loop;
end;
$$;

revoke execute on function public.expire_pending_sessions(uuid)
  from public, anon, authenticated;
grant execute on function public.expire_pending_sessions(uuid)
  to service_role;

-- ---- Settings ----

-- ---------------------------------------------------------------------------
-- set_studio_require_card_on_file
-- ---------------------------------------------------------------------------
-- Caller authority: re-checks active-owner predicate in SQL
-- (only the practitioner with role='owner' and active=true on
-- this studio may toggle the flag).
-- Verifies (when enabling): Stripe Connect onboarding is complete
-- and charges_enabled - we will not let a studio flip on the
-- mandatory-card behavior if their Stripe account cannot accept
-- charges, since that would create an unbookable funnel.
create or replace function public.set_studio_require_card_on_file(
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_value           boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_charges boolean;
  v_livemode boolean;
begin
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_practitioner_id and p.studio_id = p_studio_id
       and p.role = 'owner' and p.active = true
  ) then
    raise exception 'only the studio owner can change require_card_on_file'
      using errcode = '42501';
  end if;

  if p_value = true then
    select sps.stripe_account_status, sps.stripe_charges_enabled, sps.stripe_livemode
      into v_status, v_charges, v_livemode
    from public.studio_payment_settings sps
    where sps.studio_id = p_studio_id;
    if not found
       or v_status is distinct from 'enabled'
       or coalesce(v_charges, false) = false
       or v_livemode is null then
      raise exception 'Stripe Connect onboarding must be complete and charges enabled before requiring card on file'
        using errcode = 'P0002';
    end if;
  end if;

  insert into public.studio_payment_settings (studio_id, require_card_on_file, created_at, updated_at)
  values (p_studio_id, p_value, now(), now())
  on conflict (studio_id) do update set
    require_card_on_file = excluded.require_card_on_file,
    updated_at = now();
end;
$$;

revoke execute on function public.set_studio_require_card_on_file(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_studio_require_card_on_file(uuid, uuid, boolean)
  to service_role;

-- ---- Appointment lifecycle ----

-- ---------------------------------------------------------------------------
-- mark_appointment_complete
-- ---------------------------------------------------------------------------
-- Caller authority: any active practitioner of the studio (re-checked
-- in SQL). This is the first half of the deliberate two-action
-- separation: marking complete and charging are distinct RPCs so
-- the act of finishing a treatment cannot accidentally trigger a
-- charge.
-- Locks the appointment row FOR UPDATE and rejects unless:
--   * appointment status is 'confirmed' (no double-complete, no
--     marking cancelled/no_show appointments complete)
--   * ends_at has already passed (no completing future
--     appointments)
-- Writes an appointment_audit row with the marking actor; that
-- audit is the audit trail Hone uses to attribute charges later.
create or replace function public.mark_appointment_complete(
  p_appointment_id  uuid,
  p_studio_id       uuid,
  p_practitioner_id uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_ends_at timestamptz;
begin
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_practitioner_id and p.studio_id = p_studio_id and p.active = true
  ) then
    raise exception 'practitioner is not an active member of this studio'
      using errcode = '42501';
  end if;

  select a.status, a.ends_at into v_status, v_ends_at
  from public.appointments a
  where a.id = p_appointment_id and a.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if v_status <> 'confirmed' then
    raise exception 'appointment is not confirmed (current: %)', v_status using errcode = 'P0002';
  end if;
  if v_ends_at > now() then
    raise exception 'appointment has not yet ended' using errcode = 'P0002';
  end if;

  update public.appointments a
     set status = 'completed', updated_at = now()
   where a.id = p_appointment_id and a.studio_id = p_studio_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'marked_complete',
    jsonb_build_object('marked_at', now())
  );
end;
$$;

revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  to service_role;

-- ---- Charge attempts (create-or-claim only; transitions via reconcile) ----

-- ---------------------------------------------------------------------------
-- create_or_claim_charge_attempt
-- ---------------------------------------------------------------------------
-- Caller authority: re-checks active-OWNER predicate in SQL (the
-- caller MUST be the studio's active owner, not just any active
-- practitioner). The server action MUST also confirm the same; this
-- function is the structural backstop, not the only line of defense.
-- Locks: appointment_payments row + appointment row + the most
-- recent non-terminal charge attempt (if any), all FOR UPDATE, so
-- two concurrent charges cannot both pass the precondition checks.
-- Preconditions (all enforced in SQL; P0 #2):
--   * Active OWNER of this studio.
--   * appointment.status = 'completed' AND appointment.ends_at <= now().
--     Two-action separation: mark complete first, then charge.
--   * appointment_payments.payment_status is in a chargeable set
--     (method_saved / authentication_required / failed). Anything
--     in charged / partially_refunded / refunded / disputed /
--     double_charged / reconciliation_required is rejected.
--   * studio_payment_settings binding matches the appointment_payments
--     (account, mode) tuple. Hard refusal otherwise (a settings
--     swap mid-flight is treated as misconfiguration).
--   * stripe_charges_enabled = true. We do NOT call Stripe if the
--     account cannot accept charges; the user sees a clear refusal
--     instead of a Stripe error.
--   * Currency is CAD only (V1).
--   * application_fee_cents = 0 (V1). The application MUST also
--     omit application_fee_amount in the PaymentIntent body; the
--     two together are the V1 zero-fee invariant.
-- Idempotency: existing in-flight attempts are returned with the
-- same idempotency_key + a fresh claim token only when the prior
-- claim is stale (>5 min). 'succeeded' attempts are a hard
-- refusal - never start a fresh attempt against an already-charged
-- appointment from this entry point (use refunds + new appointment).
create or replace function public.create_or_claim_charge_attempt(
  p_appointment_id    uuid,
  p_studio_id         uuid,
  p_practitioner_id   uuid,
  p_amount_cents      integer
) returns table (
  attempt_id                  uuid,
  out_status                  text,
  out_amount_cents            integer,
  out_currency                text,
  out_stripe_account_id       text,
  out_stripe_livemode         boolean,
  out_idempotency_key         text,
  out_stripe_payment_intent_id text,
  out_processing_claim_token  uuid,
  should_execute_stripe_call  boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pay public.appointment_payments%rowtype;
  v_appt public.appointments%rowtype;
  v_settings public.studio_payment_settings%rowtype;
  v_existing public.stripe_charge_attempts%rowtype;
  v_new_id uuid;
  v_new_claim uuid;
  v_new_key text;
  v_currency text;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_cents must be positive' using errcode = '22023';
  end if;

  -- Active OWNER check (NOT just active practitioner).
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.role = 'owner'
       and pr.active = true
  ) then
    raise exception 'only the active studio owner may initiate charges'
      using errcode = '42501';
  end if;

  -- Lock appointment + payment row together.
  select * into v_appt
  from public.appointments a
  where a.id = p_appointment_id and a.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if v_appt.status <> 'completed' then
    raise exception 'appointment is not completed (current: %); mark complete before charging', v_appt.status
      using errcode = 'P0002';
  end if;
  if v_appt.ends_at > now() then
    raise exception 'appointment end time has not yet passed'
      using errcode = 'P0002';
  end if;

  select * into v_pay
  from public.appointment_payments ap
  where ap.appointment_id = p_appointment_id and ap.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment has no saved payment method'
      using errcode = 'P0002';
  end if;
  if v_pay.payment_status not in ('method_saved', 'authentication_required', 'failed') then
    raise exception 'appointment_payments.payment_status=% prevents new charge', v_pay.payment_status
      using errcode = 'P0002';
  end if;

  -- Studio binding must match the appointment_payments tuple
  -- exactly. The composite FK on appointment_payments already
  -- enforces this on write, but re-checking on read closes the
  -- window where a row was created before a hypothetical bug
  -- altered studio_payment_settings out from under it, and lets
  -- us additionally enforce the live charges_enabled requirement
  -- here without giving the application a way to bypass it.
  select * into v_settings
  from public.studio_payment_settings sps
  where sps.studio_id = p_studio_id;
  if not found
     or v_settings.stripe_account_id is null
     or v_settings.stripe_account_id is distinct from v_pay.stripe_account_id
     or v_settings.stripe_livemode is distinct from v_pay.stripe_livemode then
    raise exception 'studio Stripe binding does not match appointment_payments (account, mode)'
      using errcode = 'P0002';
  end if;
  if v_settings.stripe_charges_enabled is distinct from true then
    raise exception 'studio Stripe account is not charges_enabled'
      using errcode = 'P0002';
  end if;
  v_currency := lower(coalesce(v_settings.default_charge_currency, 'cad'));
  if v_currency <> 'cad' then
    raise exception 'V1 currency must be CAD (got: %)', v_currency
      using errcode = 'P0002';
  end if;

  -- Aliased to avoid output-column shadowing on status / amount_cents
  -- / currency / stripe_account_id / stripe_livemode / idempotency_key
  -- / stripe_payment_intent_id / processing_claim_token.
  select * into v_existing
  from public.stripe_charge_attempts sca
  where sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
    and sca.status in ('pending', 'processing', 'authentication_required', 'succeeded')
  order by sca.created_at desc
  limit 1
  for update;

  if found then
    -- Hard refusal: already succeeded. The caller must not loop
    -- here against a charged appointment.
    if v_existing.status = 'succeeded' then
      raise exception 'appointment already has a succeeded charge' using errcode = 'P0002';
    end if;
    -- Active state: return the in-flight handle, no new Stripe
    -- call. The application reconciles via webhooks.
    if v_existing.status in ('processing', 'authentication_required') then
      return query
        select v_existing.id, v_existing.status, v_existing.amount_cents, v_existing.currency,
               v_existing.stripe_account_id, v_existing.stripe_livemode,
               v_existing.idempotency_key, v_existing.stripe_payment_intent_id,
               v_existing.processing_claim_token, false;
      return;
    end if;
    -- pending with a fresh claim (<5 min): another worker is
    -- already running. We do not race; the caller waits.
    if v_existing.processing_claim_token is not null
       and v_existing.processing_started_at > now() - interval '5 minutes' then
      return query
        select v_existing.id, v_existing.status, v_existing.amount_cents, v_existing.currency,
               v_existing.stripe_account_id, v_existing.stripe_livemode,
               v_existing.idempotency_key, v_existing.stripe_payment_intent_id,
               v_existing.processing_claim_token, false;
      return;
    end if;
    -- pending with a stale claim: take it over. Reuse the same
    -- idempotency_key so Stripe collapses our retry.
    v_new_claim := gen_random_uuid();
    update public.stripe_charge_attempts sca
       set processing_claim_token = v_new_claim,
           processing_started_at = now(),
           updated_at = now()
     where sca.id = v_existing.id;
    return query
      select v_existing.id, v_existing.status, v_existing.amount_cents, v_existing.currency,
             v_existing.stripe_account_id, v_existing.stripe_livemode,
             v_existing.idempotency_key, v_existing.stripe_payment_intent_id,
             v_new_claim, true;
    return;
  end if;

  -- Fresh attempt. application_fee_cents fixed at 0 for V1.
  v_new_id := gen_random_uuid();
  v_new_claim := gen_random_uuid();
  v_new_key := 'appt_' || p_appointment_id::text || '_' || gen_random_uuid()::text;

  insert into public.stripe_charge_attempts (
    id, appointment_id, studio_id, stripe_account_id, stripe_livemode,
    initiated_by_practitioner_id,
    amount_cents, currency, application_fee_cents,
    status, idempotency_key,
    processing_started_at, processing_claim_token,
    created_at, updated_at
  ) values (
    v_new_id, p_appointment_id, p_studio_id, v_settings.stripe_account_id, v_settings.stripe_livemode,
    p_practitioner_id,
    p_amount_cents, v_currency, 0,
    'pending', v_new_key,
    now(), v_new_claim, now(), now()
  );

  perform public._append_stripe_payment_audit(
    p_appointment_id, null, p_studio_id, p_practitioner_id,
    'charge_attempted', null,
    p_amount_cents, v_currency,
    null, null, null, null,
    v_new_id, null, null, null, '{}'::jsonb,
    v_settings.stripe_account_id, v_settings.stripe_livemode
  );

  return query
    select v_new_id, 'pending'::text, p_amount_cents, v_currency,
           v_settings.stripe_account_id, v_settings.stripe_livemode,
           v_new_key, null::text, v_new_claim, true;
end;
$$;

revoke execute on function public.create_or_claim_charge_attempt(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.create_or_claim_charge_attempt(uuid, uuid, uuid, integer)
  to service_role;

-- ---- Refund attempts (create-or-claim only; transitions via reconcile_refund_event) ----

-- ---------------------------------------------------------------------------
-- create_or_claim_refund_attempt
-- ---------------------------------------------------------------------------
-- Caller authority: re-checks active-OWNER predicate in SQL.
-- Refund policy: Hone V1 is FULL REFUND ONLY. A new refund attempt
-- is permitted if and only if:
--   * the target charge attempt is succeeded or succeeded_duplicate
--   * NO other refund_attempt row exists on this charge in
--     pending / processing / requires_action / succeeded (P0 #3)
--   * NO stripe_refunds row exists on this charge in
--     pending / requires_action / succeeded - covers
--     Dashboard-observed partials that the studio may have issued
--     out-of-band; V1 has no remainder-refund concept, so any
--     such row closes out the Hone full-refund option.
-- Amount: the refund attempt is created for the FULL captured
-- amount on the target stripe_charge_id (v_target.amount_cents).
-- Any pre-existing partial (recorded via stripe_dashboard_observed)
-- makes the remainder check fail above, so amount_cents here is
-- always the un-touched full charge.
-- Account / mode lineage is inherited from the target charge row
-- via the FK declared on stripe_refund_attempts, so the new row
-- can never reference a charge under a different Stripe context.
create or replace function public.create_or_claim_refund_attempt(
  p_appointment_id          uuid,
  p_studio_id               uuid,
  p_practitioner_id         uuid,
  p_target_charge_attempt_id uuid
) returns table (
  attempt_id                   uuid,
  out_status                   text,
  out_amount_cents             integer,
  out_currency                 text,
  out_stripe_payment_intent_id text,
  out_target_stripe_charge_id  text,
  out_stripe_account_id        text,
  out_stripe_livemode          boolean,
  out_idempotency_key          text,
  out_stripe_refund_id         text,
  out_processing_claim_token   uuid,
  should_execute_stripe_call   boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_target public.stripe_charge_attempts%rowtype;
  v_payment public.appointment_payments%rowtype;
  v_blocking_attempt_id uuid;
  v_blocking_refund_id text;
  v_existing public.stripe_refund_attempts%rowtype;
  v_new_id uuid;
  v_new_claim uuid;
  v_new_key text;
begin
  -- Active OWNER re-check.
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.role = 'owner'
       and pr.active = true
  ) then
    raise exception 'only the active studio owner may initiate refunds'
      using errcode = '42501';
  end if;

  -- P0 v6 LOCK ORDER: lock the financial root BEFORE the target
  -- charge attempt. This matches reconcile_refund_event's lock
  -- order, so an external refund reconciliation already in
  -- progress against this appointment will block this RPC until
  -- the reconcile commits. Once unblocked we will read the
  -- updated stripe_refunds state and the "existing Stripe refund
  -- blocks" check below will correctly reject the stale Hone
  -- attempt instead of silently double-refunding.
  -- P0 FINAL_FIXED #2: load the payment_status under this lock
  -- so the state-gate check below operates on the same snapshot
  -- the rest of the function reads.
  select * into v_payment
  from public.appointment_payments ap
  where ap.appointment_id = p_appointment_id
    and ap.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment_payments missing for refund attempt creation'
      using errcode = 'P0002';
  end if;

  select * into v_target
  from public.stripe_charge_attempts sca
  where sca.id = p_target_charge_attempt_id
    and sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
  for update;
  if not found or v_target.status not in ('succeeded', 'succeeded_duplicate') then
    raise exception 'target charge attempt is not in a refundable state'
      using errcode = 'P0002';
  end if;

  -- P0 FINAL_FIXED #2: gate by appointment_payments.payment_status.
  -- Owner-initiated refund creation is allowed only in the
  -- specific combinations below; all other states are rejected to
  -- prevent a generic full-refund attempt from being created when
  -- the appointment is already in an incident state that demands
  -- a different operational path.
  --   * 'charged'           -> ordinary full refund of the
  --                            primary 'succeeded' charge only.
  --   * 'double_charged'    -> refund the DUPLICATE charge only.
  --                            After Stripe confirms the refund,
  --                            the owner must run
  --                            resolve_double_charge_incident.
  --                            We must NOT permit a refund attempt
  --                            against the primary 'succeeded'
  --                            charge from this RPC while the
  --                            incident is unresolved - that path
  --                            risks operator confusion about
  --                            which charge is being refunded.
  --   * 'reconciliation_required' | 'disputed'
  --     | 'partially_refunded' | 'refunded'
  --                         -> rejected. These states require
  --                            non-owner-initiated handling
  --                            (Stripe Dashboard refund reflection,
  --                            dispute response, or are already
  --                            refunded).
  --   * anything else (e.g. method_saved / authentication_required
  --     / failed)           -> rejected: there is no captured
  --                            charge to refund.
  if v_payment.payment_status = 'charged' then
    if v_target.status <> 'succeeded' then
      raise exception 'target charge attempt is not the primary succeeded charge for charged appointment (got %)', v_target.status
        using errcode = 'P0002';
    end if;
  elsif v_payment.payment_status = 'double_charged' then
    if v_target.status <> 'succeeded_duplicate' then
      raise exception 'appointment is double_charged; refund attempt must target the succeeded_duplicate charge (got target status %)', v_target.status
        using errcode = 'P0002';
    end if;
  elsif v_payment.payment_status in ('reconciliation_required', 'disputed',
                                     'partially_refunded', 'refunded') then
    raise exception 'appointment_payments.payment_status=% does not permit owner-initiated refund creation', v_payment.payment_status
      using errcode = 'P0002';
  else
    raise exception 'appointment_payments.payment_status=% has no captured charge to refund', v_payment.payment_status
      using errcode = 'P0002';
  end if;

  -- Full-refund-only invariant: any in-flight or succeeded refund
  -- ATTEMPT on this charge blocks a new one. We do not stack
  -- refund attempts in V1.
  select sra.id into v_blocking_attempt_id
  from public.stripe_refund_attempts sra
  where sra.charge_attempt_id = p_target_charge_attempt_id
    and sra.status in ('pending', 'processing', 'requires_action', 'succeeded')
  limit 1;
  if found then
    raise exception 'a refund attempt (%) is already in-flight or succeeded for this charge', v_blocking_attempt_id
      using errcode = 'P0002';
  end if;

  -- Full-refund-only invariant (P0 v6 wording fix): Hone UI
  -- permits exactly ONE full refund of the original captured
  -- amount per appointment. Any observed Stripe REFUND row on
  -- this charge (Hone-initiated or Dashboard-observed) in
  -- pending / requires_action / succeeded blocks a new Hone
  -- attempt. We DO NOT attempt to refund a remaining captured
  -- balance after an external partial refund - V1 has no
  -- partial-refund concept; the external partial closes out the
  -- Hone full-refund option entirely.
  select sr.stripe_refund_id into v_blocking_refund_id
  from public.stripe_refunds sr
  where sr.charge_attempt_id = p_target_charge_attempt_id
    and sr.stripe_charge_id = v_target.stripe_charge_id
    and sr.status in ('pending', 'requires_action', 'succeeded')
  limit 1;
  if found then
    raise exception 'an existing Stripe refund (%) blocks new refund attempts on this charge', v_blocking_refund_id
      using errcode = 'P0002';
  end if;

  -- Re-check for concurrency: a parallel call may have inserted a
  -- refund attempt between our two reads above. The active-per-
  -- charge_attempt partial unique index also enforces this on
  -- write, so a race lands as a clean unique_violation. We take
  -- FOR UPDATE here mainly to serialize the decision.
  select * into v_existing
  from public.stripe_refund_attempts sra
  where sra.charge_attempt_id = p_target_charge_attempt_id
    and sra.status in ('pending', 'processing', 'requires_action', 'succeeded')
  order by sra.created_at desc
  limit 1
  for update;
  if found then
    raise exception 'a refund attempt (%) is already in-flight or succeeded for this charge', v_existing.id
      using errcode = 'P0002';
  end if;

  v_new_id := gen_random_uuid();
  v_new_claim := gen_random_uuid();
  v_new_key := 'refund_' || p_appointment_id::text || '_' || gen_random_uuid()::text;

  -- Full refund of the target charge's captured amount.
  insert into public.stripe_refund_attempts (
    id, appointment_id, studio_id, stripe_account_id, stripe_livemode,
    charge_attempt_id, target_stripe_charge_id,
    initiated_by_practitioner_id, amount_cents, currency,
    stripe_payment_intent_id, status, idempotency_key,
    processing_started_at, processing_claim_token, created_at, updated_at
  ) values (
    v_new_id, p_appointment_id, p_studio_id, v_target.stripe_account_id, v_target.stripe_livemode,
    p_target_charge_attempt_id, v_target.stripe_charge_id,
    p_practitioner_id, v_target.amount_cents, v_target.currency,
    v_target.stripe_payment_intent_id, 'pending', v_new_key,
    now(), v_new_claim, now(), now()
  );

  perform public._append_stripe_payment_audit(
    p_appointment_id, null, p_studio_id, p_practitioner_id,
    'refund_attempted', null,
    v_target.amount_cents, v_target.currency,
    v_target.stripe_payment_intent_id, v_target.stripe_charge_id, null, null,
    p_target_charge_attempt_id, v_new_id, null, null, '{}'::jsonb,
    v_target.stripe_account_id, v_target.stripe_livemode
  );

  return query
    select v_new_id, 'pending'::text, v_target.amount_cents, v_target.currency,
           v_target.stripe_payment_intent_id, v_target.stripe_charge_id,
           v_target.stripe_account_id, v_target.stripe_livemode,
           v_new_key, null::text, v_new_claim, true;
end;
$$;

revoke execute on function public.create_or_claim_refund_attempt(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_or_claim_refund_attempt(uuid, uuid, uuid, uuid)
  to service_role;

-- ---- Reconcile: PaymentIntent transitions (sole entry point) ----

-- ---------------------------------------------------------------------------
-- reconcile_payment_intent_by_charge_attempt
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Sole SQL entry point for
-- PaymentIntent state transitions. Called either from
-- payment_intents.create response handlers or from
-- payment_intent.* webhook handlers.
--
-- Account/mode invariant (P0 #1 v2 - HARDENED): mutation REQUIRES
-- non-null p_stripe_account_id AND non-null p_stripe_livemode.
-- A null on either side returns 'missing_account_binding' WITHOUT
-- mutation. The webhook handler is responsible for recording the
-- raw event in stripe_events and alerting operations; an unbound
-- event must never silently flip a money-bearing row.
-- After the non-null check, both values MUST equal the stored
-- attempt's binding exactly; a mismatch returns
-- 'identifier_conflict' WITHOUT mutation.
--
-- Same-row identifier conflict (P0 #1 v2 - new): if the target
-- attempt is already terminal (succeeded / succeeded_duplicate)
-- and the inbound PaymentIntent or Charge ID differs from what
-- the SAME row already stored, we (a) append a critical
-- 'webhook_received' audit row with metadata flagging the
-- conflict and (b) return 'identifier_conflict' WITHOUT mutation.
-- This is the structural fence against a Stripe webhook silently
-- overwriting our previously-recorded PI/Charge identity on a
-- terminal row.
--
-- Different-row identifier collision (P0 #5): pre-mutation check
-- against (account, mode, PI) and (account, mode, Charge) finds
-- a DIFFERENT attempt already owning the same identifier and
-- routes to 'identifier_conflict'. Also covered by the
-- post-update unique_violation catch on the same partial indexes.
--
-- Different-attempt double charge: only the
-- one_primary_success_per_appointment unique violation routes to
-- 'succeeded_duplicate' on THIS attempt. The current attempt
-- being non-succeeded is the precondition for this branch; an
-- already-succeeded attempt can never re-promote itself to
-- succeeded_duplicate (that path is dead code by construction).
--
-- Return semantics (P0 #1 v2 - tightened):
--   * 'state_transitioned' for ANY first success from a
--     non-terminal state (pending / processing / authentication_required).
--   * 'override_succeeded' ONLY when the stored attempt status was
--     a local TERMINAL failure (card_declined / failed / canceled)
--     and Stripe success is overriding it.
--   * 'idempotent_no_op' on exact identity restatement.
--   * 'identifier_conflict' on any account/mode/PI/Charge ID
--     mismatch (same row or different row), no mutation.
--   * 'missing_account_binding' when account/mode were not supplied.
--   * 'ignored_terminal_failure_event' for a card_declined /
--     failed / canceled inbound on an already-succeeded row.
--   * 'double_charge_detected' on the
--     one_primary_success_per_appointment unique-violation branch.
--   * 'unknown_attempt' if the attempt id does not exist under
--     this studio.
--
-- Recovery tokens: consumed on BOTH 'succeeded' and
-- 'succeeded_duplicate' transitions.
--
-- LOCK ORDER (P0 v5):
--   1. appointment_payments financial-root row
--   2. stripe_charge_attempts (target attempt)
-- This matches the lock order used by create_or_claim_charge_attempt
-- (appointments -> appointment_payments -> stripe_charge_attempts)
-- so concurrent reconciliation and new charge creation cannot
-- deadlock. It is also the structural fence that prevents a new
-- chargeable attempt from being born after an accepted success
-- begins processing: create_or_claim_charge_attempt blocks on
-- appointment_payments until this RPC commits the recompute and
-- releases the lock.
create or replace function public.reconcile_payment_intent_by_charge_attempt(
  p_charge_attempt_id   uuid,
  p_studio_id           uuid,
  p_stripe_account_id   text,
  p_stripe_livemode     boolean,
  p_payment_intent_id   text,
  p_charge_id           text,
  p_status              text,
  p_decline_code        text,
  p_error_message       text,
  p_stripe_event_id     text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_attempt public.stripe_charge_attempts%rowtype;
  v_appointment_id uuid;
  v_constraint text;
  v_audit_event_id text;
  v_audit_account text;
  v_audit_mode boolean;
  v_meta jsonb;
  v_pi_owner_attempt uuid;
  v_charge_owner_attempt uuid;
begin
  -- Mandatory non-null account/mode for any mutation. Checked
  -- before any read so the cheap-rejection path stays cheap.
  if p_stripe_account_id is null or p_stripe_livemode is null then
    return 'missing_account_binding';
  end if;

  -- Unlocked peek to learn appointment lineage so we can lock
  -- appointment_payments BEFORE the charge attempt row.
  select sca.appointment_id into v_appointment_id
  from public.stripe_charge_attempts sca
  where sca.id = p_charge_attempt_id and sca.studio_id = p_studio_id;
  if not found then
    return 'unknown_attempt';
  end if;

  -- P0 v5: lock the financial root FIRST. This blocks any
  -- concurrent create_or_claim_charge_attempt (which also locks
  -- this row first) so new charge attempts cannot be born using
  -- the stale chargeable payment_status while we are accepting a
  -- Stripe success.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = v_appointment_id
    and ap.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment_payments missing for charge attempt % under studio %', p_charge_attempt_id, p_studio_id
      using errcode = 'P0002';
  end if;

  -- Now take the attempt row lock.
  select * into v_attempt
  from public.stripe_charge_attempts sca
  where sca.id = p_charge_attempt_id and sca.studio_id = p_studio_id
  for update;
  -- Existence was just confirmed in the peek above; if the row
  -- disappeared between peek and lock (a delete during the same
  -- transaction window, which our FKs forbid), surface it as
  -- unknown_attempt rather than dereference a null record.
  if not found then
    return 'unknown_attempt';
  end if;

  -- Account / mode mismatch: hard refusal, no mutation.
  if v_attempt.stripe_account_id is distinct from p_stripe_account_id then
    return 'identifier_conflict';
  end if;
  if v_attempt.stripe_livemode is distinct from p_stripe_livemode then
    return 'identifier_conflict';
  end if;

  -- Audit lineage. We can now always populate stripe_event_id with
  -- account/mode binding because both are required above.
  v_audit_event_id := p_stripe_event_id;
  v_audit_account := v_attempt.stripe_account_id;
  v_audit_mode := v_attempt.stripe_livemode;
  v_meta := '{}'::jsonb;

  -- P0 v4 - PaymentIntent / Charge ID IMMUTABILITY from ANY
  -- state (previously this check only fired for terminal-success
  -- rows). Once a PaymentIntent ID has been written to this row -
  -- even at authentication_required - Stripe must not be allowed
  -- to swap it. A swap means we have either a webhook routed to
  -- the wrong attempt or a Stripe-side duplicate PI for the same
  -- intended charge, both of which require operator review. Same
  -- rule for the Charge ID.
  -- Behaviour: append a critical webhook_received audit with the
  -- conflict detail in metadata and return 'identifier_conflict'
  -- without any mutation.
  if p_payment_intent_id is not null
     and v_attempt.stripe_payment_intent_id is not null
     and v_attempt.stripe_payment_intent_id is distinct from p_payment_intent_id then
    perform public._append_stripe_payment_audit(
      v_attempt.appointment_id, null, v_attempt.studio_id, null,
      'webhook_received', v_audit_event_id,
      v_attempt.amount_cents, v_attempt.currency,
      v_attempt.stripe_payment_intent_id, v_attempt.stripe_charge_id,
      null, null, v_attempt.id, null, 'same_row_identifier_conflict', null,
      jsonb_build_object(
        'same_row_identifier_conflict', true,
        'attempt_status_at_conflict', v_attempt.status,
        'conflicting_field', 'stripe_payment_intent_id',
        'stored_payment_intent_id', v_attempt.stripe_payment_intent_id,
        'stored_charge_id', v_attempt.stripe_charge_id,
        'incoming_payment_intent_id', p_payment_intent_id,
        'incoming_charge_id', p_charge_id
      ),
      v_audit_account, v_audit_mode
    );
    return 'identifier_conflict';
  end if;
  if p_charge_id is not null
     and v_attempt.stripe_charge_id is not null
     and v_attempt.stripe_charge_id is distinct from p_charge_id then
    perform public._append_stripe_payment_audit(
      v_attempt.appointment_id, null, v_attempt.studio_id, null,
      'webhook_received', v_audit_event_id,
      v_attempt.amount_cents, v_attempt.currency,
      v_attempt.stripe_payment_intent_id, v_attempt.stripe_charge_id,
      null, null, v_attempt.id, null, 'same_row_identifier_conflict', null,
      jsonb_build_object(
        'same_row_identifier_conflict', true,
        'attempt_status_at_conflict', v_attempt.status,
        'conflicting_field', 'stripe_charge_id',
        'stored_payment_intent_id', v_attempt.stripe_payment_intent_id,
        'stored_charge_id', v_attempt.stripe_charge_id,
        'incoming_payment_intent_id', p_payment_intent_id,
        'incoming_charge_id', p_charge_id
      ),
      v_audit_account, v_audit_mode
    );
    return 'identifier_conflict';
  end if;

  -- Different-row identifier collision: pre-mutation detection.
  if p_payment_intent_id is not null
     and v_attempt.stripe_payment_intent_id is distinct from p_payment_intent_id then
    select sca.id into v_pi_owner_attempt
    from public.stripe_charge_attempts sca
    where sca.stripe_account_id = v_attempt.stripe_account_id
      and sca.stripe_livemode is not distinct from v_attempt.stripe_livemode
      and sca.stripe_payment_intent_id = p_payment_intent_id
      and sca.id <> v_attempt.id
    limit 1;
    if found then
      return 'identifier_conflict';
    end if;
  end if;
  if p_charge_id is not null then
    select sca.id into v_charge_owner_attempt
    from public.stripe_charge_attempts sca
    where sca.stripe_account_id = v_attempt.stripe_account_id
      and sca.stripe_livemode is not distinct from v_attempt.stripe_livemode
      and sca.stripe_charge_id = p_charge_id
      and sca.id <> v_attempt.id
    limit 1;
    if found then
      return 'identifier_conflict';
    end if;
  end if;

  -- Terminal-failure event arriving for a succeeded attempt:
  -- ignore (do not flip 'succeeded' to 'failed' under any
  -- circumstance, even a delayed canceled webhook).
  if v_attempt.status in ('succeeded', 'succeeded_duplicate')
     and p_status in ('card_declined', 'failed', 'canceled') then
    perform public._append_stripe_payment_audit(
      v_attempt.appointment_id, null, v_attempt.studio_id, null,
      'webhook_received', v_audit_event_id,
      v_attempt.amount_cents, v_attempt.currency,
      v_attempt.stripe_payment_intent_id, v_attempt.stripe_charge_id,
      null, null, v_attempt.id, null, null, null,
      v_meta || jsonb_build_object('ignored', 'terminal_failure_after_success'),
      v_audit_account, v_audit_mode
    );
    return 'ignored_terminal_failure_event';
  end if;

  -- Already-terminal idempotent retries (exact restatement).
  if v_attempt.status = p_status
     and v_attempt.stripe_payment_intent_id is not distinct from p_payment_intent_id
     and (p_charge_id is null
          or v_attempt.stripe_charge_id is not distinct from p_charge_id) then
    return 'idempotent_no_op';
  end if;
  if v_attempt.status = 'succeeded_duplicate'
     and p_status = 'succeeded'
     and v_attempt.stripe_payment_intent_id is not distinct from p_payment_intent_id
     and v_attempt.stripe_charge_id is not distinct from p_charge_id then
    return 'idempotent_no_op';
  end if;

  if p_status = 'succeeded' then
    -- P0 v4: BOTH PaymentIntent ID AND Charge ID are required for
    -- any succeeded transition. Stripe always emits both on a
    -- captured charge; a missing one means our webhook router fed
    -- this RPC partial data and we refuse the mutation rather
    -- than store an attempt row that would violate
    -- stripe_charge_attempts_charge_id_status_check anyway.
    if p_payment_intent_id is null or p_charge_id is null then
      raise exception 'p_payment_intent_id and p_charge_id are both required for status=succeeded'
        using errcode = '22023';
    end if;
    begin
      update public.stripe_charge_attempts sca
         set status = 'succeeded',
             stripe_payment_intent_id = coalesce(sca.stripe_payment_intent_id, p_payment_intent_id),
             stripe_charge_id = coalesce(sca.stripe_charge_id, p_charge_id),
             processing_claim_token = null,
             terminal_at = now(),
             updated_at = now()
       where sca.id = p_charge_attempt_id;

      perform public._append_stripe_payment_audit(
        v_attempt.appointment_id, null, v_attempt.studio_id, null,
        'charge_succeeded', v_audit_event_id,
        v_attempt.amount_cents, v_attempt.currency,
        coalesce(v_attempt.stripe_payment_intent_id, p_payment_intent_id),
        coalesce(v_attempt.stripe_charge_id, p_charge_id),
        null, null, v_attempt.id, null, null, null, v_meta,
        v_audit_account, v_audit_mode
      );

      -- P0 v4 RETIREMENT: any other charge attempt for the same
      -- (appointment, studio) that is still pending / processing
      -- / authentication_required is now superseded. Retire each
      -- one with status='canceled' so it can never independently
      -- become a primary 'succeeded'. We keep the constraint
      -- contract (canceled rows must have stripe_charge_id NULL),
      -- which is automatic because pending/processing/authentication_required
      -- rows are already null-charge-id by stripe_charge_attempts_charge_id_status_check.
      -- A retired attempt whose underlying PaymentIntent does
      -- still succeed in Stripe later will arrive here on the
      -- 'succeeded' branch and be routed to 'succeeded_duplicate'
      -- via the partial-unique violation, exactly as for any
      -- other double-charge event.
      perform public._retire_superseded_charge_attempts(
        v_attempt.appointment_id, v_attempt.studio_id, v_attempt.id,
        v_attempt.stripe_account_id, v_attempt.stripe_livemode
      );

      perform public._recompute_payment_status(v_attempt.appointment_id, v_attempt.studio_id);

      -- Consume any open recovery tokens on this attempt: the
      -- client no longer needs to re-authenticate.
      perform public.consume_payment_recovery_tokens_for_charge_attempt(
        v_attempt.id, v_attempt.studio_id
      );

      -- Return classification (P0 #1 v2):
      --   override_succeeded ONLY if we overrode a stored local
      --   terminal failure (card_declined/failed/canceled);
      --   otherwise this is the ordinary first-success path from
      --   pending/processing/authentication_required.
      if v_attempt.status in ('card_declined', 'failed', 'canceled') then
        return 'override_succeeded';
      else
        return 'state_transitioned';
      end if;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'stripe_charge_attempts_one_primary_success_per_appointment' then
          -- Different-attempt double charge: another row already
          -- holds the primary success crown for this appointment.
          -- Mark OURSELVES (this attempt) as the duplicate. The
          -- precondition here is that v_attempt.status was NOT
          -- 'succeeded' (an already-succeeded attempt cannot
          -- collide with the partial unique that excludes itself);
          -- only a different non-succeeded attempt becomes
          -- 'succeeded_duplicate'.
          update public.stripe_charge_attempts sca
             set status = 'succeeded_duplicate',
                 stripe_payment_intent_id = coalesce(sca.stripe_payment_intent_id, p_payment_intent_id),
                 stripe_charge_id = coalesce(sca.stripe_charge_id, p_charge_id),
                 processing_claim_token = null,
                 terminal_at = now(),
                 updated_at = now()
           where sca.id = p_charge_attempt_id;
          perform public._append_stripe_payment_audit(
            v_attempt.appointment_id, null, v_attempt.studio_id, null,
            'double_charge_detected', v_audit_event_id,
            v_attempt.amount_cents, v_attempt.currency,
            coalesce(v_attempt.stripe_payment_intent_id, p_payment_intent_id),
            coalesce(v_attempt.stripe_charge_id, p_charge_id),
            null, null, v_attempt.id, null, null, null,
            v_meta || jsonb_build_object('detected_via', v_constraint),
            v_audit_account, v_audit_mode
          );
          -- Also retire any other still-active attempts on this
          -- appointment. The primary's retirement should have
          -- already covered everything that existed at the time,
          -- but we re-run defensively in case new attempts were
          -- created in the window.
          perform public._retire_superseded_charge_attempts(
            v_attempt.appointment_id, v_attempt.studio_id, v_attempt.id,
            v_attempt.stripe_account_id, v_attempt.stripe_livemode
          );
          perform public._recompute_payment_status(v_attempt.appointment_id, v_attempt.studio_id);
          perform public.consume_payment_recovery_tokens_for_charge_attempt(
            v_attempt.id, v_attempt.studio_id
          );
          return 'double_charge_detected';
        elsif v_constraint in ('stripe_charge_attempts_pi_account_mode_uniq',
                                'stripe_charge_attempts_charge_account_mode_uniq') then
          return 'identifier_conflict';
        else
          raise;
        end if;
    end;
  end if;

  if p_status = 'authentication_required' then
    -- P0 v7 #1: a PaymentIntent ID is REQUIRED for any
    -- authentication_required transition. The Hone-hosted recovery
    -- page resumes an existing PaymentIntent; without an ID stored
    -- on the row, the recovery flow has nothing to resume against
    -- and a recovery_token issued for this attempt would be
    -- unusable.
    if p_payment_intent_id is null then
      raise exception 'p_payment_intent_id is required for authentication_required'
        using errcode = '22023';
    end if;
    update public.stripe_charge_attempts sca
       set status = 'authentication_required',
           stripe_payment_intent_id = coalesce(sca.stripe_payment_intent_id, p_payment_intent_id),
           processing_claim_token = null,
           updated_at = now()
     where sca.id = p_charge_attempt_id
       and sca.status in ('pending', 'processing');
    if found then
      perform public._append_stripe_payment_audit(
        v_attempt.appointment_id, null, v_attempt.studio_id, null,
        'charge_authentication_required', v_audit_event_id,
        v_attempt.amount_cents, v_attempt.currency,
        coalesce(v_attempt.stripe_payment_intent_id, p_payment_intent_id),
        null, null, null, v_attempt.id, null, null, null, v_meta,
        v_audit_account, v_audit_mode
      );
      perform public._recompute_payment_status(v_attempt.appointment_id, v_attempt.studio_id);
      return 'state_transitioned';
    end if;
    return 'idempotent_no_op';
  end if;

  if p_status in ('card_declined', 'failed', 'canceled') then
    update public.stripe_charge_attempts sca
       set status = p_status,
           stripe_decline_code = p_decline_code,
           stripe_error_message = p_error_message,
           stripe_payment_intent_id = coalesce(sca.stripe_payment_intent_id, p_payment_intent_id),
           processing_claim_token = null,
           terminal_at = now(),
           updated_at = now()
     where sca.id = p_charge_attempt_id
       and sca.status in ('pending', 'processing', 'authentication_required');
    if found then
      perform public._append_stripe_payment_audit(
        v_attempt.appointment_id, null, v_attempt.studio_id, null,
        'charge_failed', v_audit_event_id,
        v_attempt.amount_cents, v_attempt.currency,
        coalesce(v_attempt.stripe_payment_intent_id, p_payment_intent_id),
        null, null, null, v_attempt.id, null, p_decline_code, p_error_message, v_meta,
        v_audit_account, v_audit_mode
      );
      perform public._recompute_payment_status(v_attempt.appointment_id, v_attempt.studio_id);
      return 'state_transitioned';
    end if;
    return 'idempotent_no_op';
  end if;

  raise exception 'unexpected status: %', p_status using errcode = '22023';
end;
$$;

revoke execute on function public.reconcile_payment_intent_by_charge_attempt(
  uuid, uuid, text, boolean, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.reconcile_payment_intent_by_charge_attempt(
  uuid, uuid, text, boolean, text, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_setup_intent_succeeded
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Webhook handler for
-- setup_intent.succeeded events.
-- Invariant: a PROVEN saved PaymentMethod must never be left in a
-- state with no clear future. This RPC NEVER creates an
-- appointment or authorizes a charge; it only routes the session
-- forward into either finalization-eligible or cleanup-required.
-- Legitimate outcomes (P0 #2 v2):
--   * applied:
--     unexpired session in status consent_recorded or
--     setup_intent_created -> stamp the SetupIntent + PaymentMethod
--     IDs and advance to payment_method_saved_pending_finalization.
--     The consent_recorded path is the CRASH RECOVERY case: the
--     server died between webhook fire and mark_session_setup_intent_created;
--     stamping here closes the gap without losing the saved card.
--   * already_applied:
--     unexpired session already in
--     payment_method_saved_pending_finalization with matching IDs.
--   * missing_consent_cleanup_required:
--     SetupIntent succeeded but no payment_consents row exists -
--     MUST NOT finalize. Flip to cleanup_required and stamp the
--     PM IDs so the cleanup claim sweep has what it needs.
--   * delayed_setup_intent_cleanup_required:
--     Session was previously moved to
--     'expired_without_payment_method' OR 'cleaned-without-PM'
--     (we now learn a PM does exist and is attached). Re-route to
--     cleanup_required and stamp the IDs so the PM is detached.
--     Otherwise the PM would be silently stranded on the connected
--     Stripe account.
--   * terminal_session_conflict:
--     finalized (appointment already exists; nothing to do),
--     cleanup_required / finalization_failed / cleaned (already
--     PM-tracked; we update the IDs in case Stripe sent slightly
--     different identifiers but do not change state).
-- Audit semantics (P0 v5 - truthful cleanup events):
--   * This RPC only QUEUES a session into cleanup_required. It
--     never contacts Stripe paymentMethods.detach. Queueing
--     emits 'payment_method_cleanup_queued' so the timeline
--     truthfully records a queue transition, not an attempted
--     detach.
--   * 'payment_method_cleanup_attempted' is emitted ONLY by
--     claim_payment_method_cleanup_sessions when a worker
--     actually claims the row for Stripe detach / safe-skip work.
--   * 'payment_method_cleanup_succeeded' / '_failed' are
--     emitted by mark_session_cleaned on terminal outcome.
create or replace function public.reconcile_setup_intent_succeeded(
  p_session_id           uuid,
  p_studio_id            uuid,
  p_stripe_customer_id   text,
  p_connected_account_id text,
  p_stripe_livemode      boolean,
  p_setup_intent_id      text,
  p_payment_method_id    text,
  p_stripe_event_id      text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session public.pending_booking_payment_sessions%rowtype;
  v_has_consent boolean;
begin
  -- P0 v7 #2: webhook handler MUST pass non-null/non-blank
  -- SetupIntent ID, PaymentMethod ID, connected account, customer,
  -- and livemode. A null on any of these binding fields means we
  -- have an untrusted event we cannot route safely. Return a
  -- structured outcome WITHOUT mutating any session row.
  if nullif(trim(coalesce(p_setup_intent_id, '')), '') is null then
    return 'missing_setup_intent_id';
  end if;
  if nullif(trim(coalesce(p_payment_method_id, '')), '') is null then
    return 'missing_payment_method_id';
  end if;
  if nullif(trim(coalesce(p_connected_account_id, '')), '') is null then
    return 'missing_connected_account_id';
  end if;
  if p_stripe_livemode is null then
    return 'missing_livemode';
  end if;
  if nullif(trim(coalesce(p_stripe_customer_id, '')), '') is null then
    return 'missing_customer_id';
  end if;

  select * into v_session
  from public.pending_booking_payment_sessions pps
  where pps.id = p_session_id and pps.studio_id = p_studio_id
  for update;
  if not found then return 'unknown_session'; end if;

  if v_session.stripe_account_id is distinct from p_connected_account_id then
    return 'connected_account_mismatch';
  end if;
  if v_session.stripe_livemode is distinct from p_stripe_livemode then
    return 'livemode_mismatch';
  end if;
  if v_session.stripe_customer_id is distinct from p_stripe_customer_id then
    return 'customer_mismatch';
  end if;
  if v_session.stripe_setup_intent_id is not null
     and v_session.stripe_setup_intent_id is distinct from p_setup_intent_id then
    return 'setup_intent_mismatch';
  end if;
  if v_session.stripe_payment_method_id is not null
     and v_session.stripe_payment_method_id is distinct from p_payment_method_id then
    return 'payment_method_mismatch';
  end if;

  select exists (
    select 1 from public.payment_consents pc
    where pc.pending_booking_payment_session_id = p_session_id
  ) into v_has_consent;

  -- finalized: appointment already exists. Nothing else to do.
  if v_session.status = 'finalized' then
    return 'terminal_session_conflict';
  end if;

  -- expired_without_payment_method: we now learn a PM exists.
  -- Re-route to cleanup_required.
  if v_session.status = 'expired_without_payment_method' then
    update public.pending_booking_payment_sessions pps
       set status = 'cleanup_required',
           stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
           stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
           cleanup_error_code = 'delayed_setup_intent_after_expiry',
           cleanup_processing_started_at = null,
           cleanup_claim_token = null,
           updated_at = now()
     where pps.id = p_session_id;
    perform public._append_stripe_payment_audit(
      null, v_session.id, v_session.studio_id, null,
      'payment_method_cleanup_queued', p_stripe_event_id,
      null, null,
      null, null, null, null,
      null, null, null, null,
      jsonb_build_object('trigger', 'reconcile_setup_intent_succeeded_after_expiry'),
      v_session.stripe_account_id, v_session.stripe_livemode
    );
    return 'delayed_setup_intent_cleanup_required';
  end if;

  -- cleaned-without-PM late discovery (P0 #2 v2 new path). A late
  -- successful SetupIntent has arrived after the session was
  -- previously marked 'cleaned' but no PM was ever stored. We MUST
  -- re-route to cleanup_required so the now-known PM is actually
  -- detached, instead of silently abandoning it on the Stripe side.
  if v_session.status = 'cleaned'
     and v_session.stripe_payment_method_id is null then
    update public.pending_booking_payment_sessions pps
       set status = 'cleanup_required',
           stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
           stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
           cleanup_error_code = 'late_setup_intent_after_cleaned_without_pm',
           cleanup_processing_started_at = null,
           cleanup_claim_token = null,
           updated_at = now()
     where pps.id = p_session_id;
    perform public._append_stripe_payment_audit(
      null, v_session.id, v_session.studio_id, null,
      'payment_method_cleanup_queued', p_stripe_event_id,
      null, null,
      null, null, null, null,
      null, null, 'late_setup_intent_after_cleaned_without_pm', null,
      jsonb_build_object('trigger', 'reconcile_setup_intent_succeeded_after_cleaned'),
      v_session.stripe_account_id, v_session.stripe_livemode
    );
    return 'delayed_setup_intent_cleanup_required';
  end if;

  -- cleanup_required / finalization_failed / cleaned (with PM
  -- already known): keep status, fill in any null IDs.
  if v_session.status in ('cleanup_required', 'finalization_failed', 'cleaned') then
    update public.pending_booking_payment_sessions pps
       set stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
           stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
           updated_at = now()
     where pps.id = p_session_id;
    return 'terminal_session_conflict';
  end if;

  -- Missing-consent cleanup path. If the user never recorded
  -- consent but Stripe saved a PM (browser bypass, partial flow,
  -- etc.), we MUST NOT finalize. Move to cleanup_required AND
  -- stamp the IDs so the cleanup claim sweep can detach.
  if not v_has_consent then
    update public.pending_booking_payment_sessions pps
       set status = 'cleanup_required',
           stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
           stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
           cleanup_error_code = 'missing_consent_at_setup_intent',
           cleanup_processing_started_at = null,
           cleanup_claim_token = null,
           updated_at = now()
     where pps.id = p_session_id;
    perform public._append_stripe_payment_audit(
      null, v_session.id, v_session.studio_id, null,
      'payment_method_cleanup_queued', p_stripe_event_id,
      null, null,
      null, null, null, null,
      null, null, 'missing_consent_at_setup_intent', null,
      jsonb_build_object('trigger', 'reconcile_setup_intent_succeeded_missing_consent'),
      v_session.stripe_account_id, v_session.stripe_livemode
    );
    return 'missing_consent_cleanup_required';
  end if;

  -- Idempotent already-applied path.
  if v_session.status = 'payment_method_saved_pending_finalization'
     and v_session.stripe_setup_intent_id = p_setup_intent_id
     and v_session.stripe_payment_method_id = p_payment_method_id then
    return 'already_applied';
  end if;

  -- Apply (or crash-recover) path. We refuse if the session is
  -- already expired - the application MUST cancel the SetupIntent
  -- and detach the PM in that case rather than finalize.
  if v_session.expires_at <= now() then
    update public.pending_booking_payment_sessions pps
       set status = 'cleanup_required',
           stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
           stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
           cleanup_error_code = 'setup_intent_after_session_expired',
           cleanup_processing_started_at = null,
           cleanup_claim_token = null,
           updated_at = now()
     where pps.id = p_session_id;
    perform public._append_stripe_payment_audit(
      null, v_session.id, v_session.studio_id, null,
      'payment_method_cleanup_queued', p_stripe_event_id,
      null, null,
      null, null, null, null,
      null, null, 'setup_intent_after_session_expired', null,
      jsonb_build_object('trigger', 'reconcile_setup_intent_succeeded_after_expiry'),
      v_session.stripe_account_id, v_session.stripe_livemode
    );
    return 'delayed_setup_intent_cleanup_required';
  end if;

  -- Crash recovery: status='consent_recorded' means the server
  -- never got to mark_session_setup_intent_created. Treat as a
  -- direct setup_intent_created -> payment_method_saved_pending_finalization
  -- promotion in one step.
  update public.pending_booking_payment_sessions pps
     set stripe_setup_intent_id = coalesce(pps.stripe_setup_intent_id, p_setup_intent_id),
         stripe_payment_method_id = coalesce(pps.stripe_payment_method_id, p_payment_method_id),
         status = case
                    when pps.status in ('consent_recorded', 'setup_intent_created')
                      then 'payment_method_saved_pending_finalization'
                    else pps.status
                  end,
         updated_at = now()
   where pps.id = p_session_id;

  return 'applied';
end;
$$;

revoke execute on function public.reconcile_setup_intent_succeeded(
  uuid, uuid, text, text, boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.reconcile_setup_intent_succeeded(
  uuid, uuid, text, text, boolean, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_refund_event
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Webhook handler for
-- refund.created / refund.updated / refund.failed events. NOTHING
-- else feeds this RPC: see dependency checklist below; charge.refunded
-- is a SUMMARY/RECHECK event and the router MUST NOT iterate its
-- embedded refunds into here.
--
-- Charge lookup (P0 #4 v2 - HARDENED): p_stripe_charge_id is the
-- AUTHORITATIVE lookup key. We resolve a charge attempt ONLY where:
--   * sca.stripe_charge_id = p_stripe_charge_id (exact, not OR)
--   * sca.studio_id, sca.stripe_account_id, sca.stripe_livemode all
--     equal the inbound (studio, account, mode)
--   * sca.status IN ('succeeded', 'succeeded_duplicate')
-- If p_stripe_payment_intent_id is supplied we additionally require
-- it to match the same charge attempt. This is verification only -
-- a Charge ID is the source of truth on a refund event; the PI is
-- a sanity cross-check.
--
-- Refund-attempt linkage (proof-only): a refund row is classified
-- 'hone_initiated' ONLY when we can prove it came from one of our
-- refund attempts:
--   (a) exact metadata refund_attempt_id (set at attempt creation)
--       AND that attempt's full lineage matches this charge; OR
--   (b) an existing stripe_refund_attempts row whose
--       stripe_refund_id already equals the inbound p_stripe_refund_id.
-- Any other case is 'stripe_dashboard_observed'. No NULL fallback.
--
-- ON CONFLICT source-upgrade fix (P0 #4 v2): the previous version
-- could set refund_attempt_id on an existing
-- stripe_dashboard_observed row without flipping source to
-- 'hone_initiated', violating stripe_refunds_source_attempt_check.
-- The new logic upgrades source AND refund_attempt_id TOGETHER only
-- when proof is present on the incoming event, OR leaves the row
-- untouched on this dimension (status / failure_reason / amount /
-- currency are updated either way). It never produces a row that
-- violates the source/attempt check.
--
-- Refund attempt state mapping (P0 #4 v2 - new): when a Hone-
-- initiated proof match is present, map inbound Stripe status into
-- the local refund attempt lifecycle:
--   requires_action -> requires_action
--   succeeded       -> succeeded (terminal_at set)
--   failed          -> failed    (terminal_at set, failure_reason stored)
--   canceled        -> canceled  (terminal_at set)
-- Repeat / idempotent retries are absorbed: a no-op transition
-- emits no audit row. Semantic audit ('refund_succeeded' /
-- 'refund_failed' / 'external_refund_observed') is appended ONLY
-- on an actual lifecycle change, never on a webhook echo whose
-- effect was already captured by the direct response.
create or replace function public.reconcile_refund_event(
  p_studio_id                  uuid,
  p_stripe_account_id          text,
  p_stripe_livemode            boolean,
  p_stripe_charge_id           text,
  p_stripe_refund_id           text,
  p_stripe_payment_intent_id   text,
  p_amount_cents               integer,
  p_currency                   text,
  p_status                     text,
  p_failure_reason             text,
  p_metadata_refund_attempt_id uuid,
  p_stripe_event_id            text
) returns table (
  resolved      boolean,
  error_reason  text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_charge public.stripe_charge_attempts%rowtype;
  v_attempt public.stripe_refund_attempts%rowtype;
  v_existing_refund public.stripe_refunds%rowtype;
  v_audit_event_id text;
  v_audit_account text;
  v_audit_mode boolean;
  v_meta jsonb := '{}'::jsonb;
  v_source text;
  v_new_attempt_status text;
  v_attempt_lifecycle_changed boolean := false;
  v_refund_was_succeeded_before boolean := false;
  v_refund_row_existed_before boolean := false;
begin
  if p_stripe_account_id is null or p_stripe_livemode is null then
    return query select false, 'missing_account_binding'::text;
    return;
  end if;
  if p_stripe_charge_id is null then
    return query select false, 'missing_charge_id'::text;
    return;
  end if;

  -- Authoritative Charge-ID lookup. NO OR with payment_intent_id.
  -- Must be a refundable charge (succeeded / succeeded_duplicate).
  select * into v_charge
  from public.stripe_charge_attempts sca
  where sca.studio_id = p_studio_id
    and sca.stripe_account_id = p_stripe_account_id
    and sca.stripe_livemode is not distinct from p_stripe_livemode
    and sca.stripe_charge_id = p_stripe_charge_id
    and sca.status in ('succeeded', 'succeeded_duplicate');
  if not found then
    return query select false, 'charge_attempt_not_found'::text;
    return;
  end if;

  -- Optional PI verification.
  if p_stripe_payment_intent_id is not null
     and v_charge.stripe_payment_intent_id is distinct from p_stripe_payment_intent_id then
    return query select false, 'payment_intent_id_mismatch'::text;
    return;
  end if;

  -- P0 FINAL #4: refund currency MUST match the original successful
  -- charge AND must be CAD (V1 currency invariant). A mismatch
  -- here means the inbound event is for a refund denominated in
  -- a currency that cannot legitimately apply to this charge, OR
  -- the application has somehow surfaced a non-CAD refund (V1
  -- charges are CAD-only - see create_or_claim_charge_attempt).
  -- We append an identifier-conflict audit and refuse the event.
  if p_currency is null
     or lower(p_currency) is distinct from lower(v_charge.currency)
     or lower(p_currency) <> 'cad' then
    perform public._append_stripe_payment_audit(
      v_charge.appointment_id, null, v_charge.studio_id, null,
      'refund_identifier_conflict',
      p_stripe_event_id, v_charge.amount_cents, v_charge.currency,
      v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
      p_stripe_refund_id, null,
      v_charge.id, null,
      'currency_mismatch', null,
      jsonb_build_object(
        'reason', 'refund_currency_mismatch',
        'stored_charge_currency', v_charge.currency,
        'incoming_refund_currency', p_currency,
        'v1_required_currency', 'cad'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return query select false, 'refund_identifier_conflict'::text;
    return;
  end if;

  -- P0 v6 LOCK ORDER: lock the financial root BEFORE touching
  -- any refund / refund-attempt rows. This serializes refund
  -- reconciliation against create_or_claim_refund_attempt and
  -- against other concurrent refund webhooks for the same
  -- appointment - a Hone owner cannot initiate a full refund
  -- using stale "no refund exists" state while an external
  -- refund event is still being reconciled.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = v_charge.appointment_id
    and ap.studio_id = v_charge.studio_id
  for update;
  if not found then
    return query select false, 'appointment_payments_missing'::text;
    return;
  end if;

  -- Refund-attempt linkage: PROOF-BASED ONLY.
  -- Attempt 1: explicit metadata refund_attempt_id.
  if p_metadata_refund_attempt_id is not null then
    select * into v_attempt
    from public.stripe_refund_attempts sra
    where sra.id = p_metadata_refund_attempt_id
      and sra.charge_attempt_id = v_charge.id
      and sra.appointment_id    = v_charge.appointment_id
      and sra.studio_id         = v_charge.studio_id
      and sra.stripe_account_id = v_charge.stripe_account_id
      and sra.stripe_livemode is not distinct from v_charge.stripe_livemode
      and sra.target_stripe_charge_id = v_charge.stripe_charge_id;
  end if;
  -- Attempt 2: an existing refund attempt whose stripe_refund_id
  -- already equals the inbound ID.
  if v_attempt.id is null then
    select * into v_attempt
    from public.stripe_refund_attempts sra
    where sra.charge_attempt_id = v_charge.id
      and sra.stripe_refund_id is not null
      and sra.stripe_refund_id = p_stripe_refund_id
    limit 1;
  end if;

  -- Source classification.
  v_source := case when v_attempt.id is not null then 'hone_initiated'
                   else 'stripe_dashboard_observed' end;

  v_audit_event_id := p_stripe_event_id;
  v_audit_account := p_stripe_account_id;
  v_audit_mode := p_stripe_livemode;

  -- P0 v6 ATTEMPT-LEVEL Refund ID IMMUTABILITY: if we matched a
  -- Hone refund attempt by metadata and that attempt already has
  -- a different stripe_refund_id stored, that is a hard conflict
  -- (this is a NON-MUTATING read-only check against v_attempt).
  if v_attempt.id is not null
     and v_attempt.stripe_refund_id is not null
     and v_attempt.stripe_refund_id is distinct from p_stripe_refund_id then
    perform public._append_stripe_payment_audit(
      v_charge.appointment_id, null, v_charge.studio_id, null,
      'refund_identifier_conflict',
      p_stripe_event_id, v_attempt.amount_cents, v_attempt.currency,
      v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
      p_stripe_refund_id, null,
      v_charge.id, v_attempt.id,
      'refund_identifier_conflict', null,
      jsonb_build_object(
        'reason', 'attempt_refund_id_immutable',
        'stored_refund_id', v_attempt.stripe_refund_id,
        'incoming_refund_id', p_stripe_refund_id
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return query select false, 'refund_identifier_conflict'::text;
    return;
  end if;

  -- P0 v7 #6: DO NOT eager-persist stripe_refund_id yet. The
  -- previous v6 ordering wrote p_stripe_refund_id onto the
  -- matched Hone refund_attempt BEFORE validating the existing
  -- stripe_refunds row's identity. A misrouted event with a
  -- conflicting stored Refund ID would still poison the attempt
  -- even though the function returned 'refund_identifier_conflict'.
  -- We now look up + validate the existing refund row first, then
  -- (only if everything passes) persist the attempt-level
  -- stripe_refund_id at the bottom of this block.

  -- Look up any existing refund row for this (account, mode, refund_id).
  select * into v_existing_refund
  from public.stripe_refunds sr
  where sr.stripe_account_id = p_stripe_account_id
    and sr.stripe_livemode is not distinct from p_stripe_livemode
    and sr.stripe_refund_id = p_stripe_refund_id
  for update;
  if found then
    v_refund_row_existed_before := true;
    v_refund_was_succeeded_before := (v_existing_refund.status = 'succeeded');
  end if;

  -- P0 v6 IDENTITY IMMUTABILITY: if an existing stripe_refunds
  -- row was found, its stored immutable lineage (studio, account,
  -- mode, appointment, charge_attempt, charge_id, optional PI,
  -- amount, currency) MUST match the resolved (v_charge,
  -- p_amount_cents, p_currency, p_stripe_payment_intent_id when
  -- supplied) for this event. A mismatch means the Stripe Refund
  -- ID has been mis-routed to a different charge / studio /
  -- appointment - we must NOT overwrite stored truth with the
  -- mis-routed event AND we must NOT have already poisoned the
  -- candidate Hone refund attempt (P0 v7 #6).
  if v_refund_row_existed_before then
    if v_existing_refund.studio_id          is distinct from v_charge.studio_id
       or v_existing_refund.stripe_account_id is distinct from v_charge.stripe_account_id
       or v_existing_refund.stripe_livemode  is distinct from v_charge.stripe_livemode
       or v_existing_refund.appointment_id   is distinct from v_charge.appointment_id
       or v_existing_refund.charge_attempt_id is distinct from v_charge.id
       or v_existing_refund.stripe_charge_id is distinct from v_charge.stripe_charge_id
       or (p_stripe_payment_intent_id is not null
           and v_existing_refund.stripe_payment_intent_id is not null
           and v_existing_refund.stripe_payment_intent_id is distinct from p_stripe_payment_intent_id)
       or v_existing_refund.amount_cents     is distinct from p_amount_cents
       or v_existing_refund.currency         is distinct from p_currency then
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'refund_identifier_conflict',
        v_audit_event_id, v_existing_refund.amount_cents, v_existing_refund.currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        p_stripe_refund_id, null,
        v_charge.id, v_existing_refund.refund_attempt_id,
        'refund_identifier_conflict', null,
        jsonb_build_object(
          'reason', 'existing_refund_lineage_mismatch',
          'stored_studio_id',          v_existing_refund.studio_id,
          'stored_appointment_id',     v_existing_refund.appointment_id,
          'stored_charge_attempt_id',  v_existing_refund.charge_attempt_id,
          'stored_charge_id',          v_existing_refund.stripe_charge_id,
          'stored_payment_intent_id',  v_existing_refund.stripe_payment_intent_id,
          'stored_amount_cents',       v_existing_refund.amount_cents,
          'stored_currency',           v_existing_refund.currency,
          'resolved_charge_attempt_id', v_charge.id,
          'resolved_charge_id',        v_charge.stripe_charge_id,
          'resolved_payment_intent_id', v_charge.stripe_payment_intent_id,
          'incoming_amount_cents',     p_amount_cents,
          'incoming_currency',         p_currency,
          'incoming_payment_intent_id', p_stripe_payment_intent_id
        ),
        v_audit_account, v_audit_mode
      );
      return query select false, 'refund_identifier_conflict'::text;
      return;
    end if;
  end if;

  -- FINAL REVIEW FIX: Do not persist stripe_refund_id onto a
  -- candidate Hone refund attempt until BOTH:
  --   (a) any existing stripe_refunds row has passed immutable
  --       charge/amount/currency validation; and
  --   (b) any existing Hone-linked refund row has been confirmed
  --       to point at this same refund attempt.
  -- Otherwise an event carrying the wrong refund_attempt metadata
  -- on the same valid charge would poison that attempt with a
  -- Refund ID even though the RPC returns an identity conflict.

  -- Branch on the saved boolean, NOT on PL/pgSQL FOUND. This
  -- remains correct even if later validation or persistence
  -- statements execute before this insert/update decision.
  if not v_refund_row_existed_before then
    -- Fresh refund row: insert with full lineage from the matched
    -- charge attempt. Account/mode/charge_id come from the charge,
    -- never from p_*.
    insert into public.stripe_refunds (
      studio_id, stripe_account_id, stripe_livemode,
      appointment_id, charge_attempt_id, refund_attempt_id,
      source, stripe_refund_id, stripe_charge_id, stripe_payment_intent_id,
      amount_cents, currency, status, failure_reason, created_at, updated_at
    ) values (
      p_studio_id, v_charge.stripe_account_id, v_charge.stripe_livemode,
      v_charge.appointment_id, v_charge.id,
      v_attempt.id,
      v_source,
      p_stripe_refund_id, v_charge.stripe_charge_id, v_charge.stripe_payment_intent_id,
      p_amount_cents, p_currency, p_status, p_failure_reason, now(), now()
    );
  else
    -- ON CONFLICT path. Two distinct safety rules apply:
    --
    -- (a) P0 #4 v2 source-safe upgrade: source AND
    --     refund_attempt_id flip TOGETHER only when proof is on
    --     this event; never set refund_attempt_id without
    --     flipping source.
    --
    -- (b) P0 v5 SUCCEEDED-NEVER-REGRESSES: once
    --     stripe_refunds.status = 'succeeded' has been observed,
    --     it cannot be moved to any non-succeeded state by a
    --     subsequently-delivered older event. A regression event
    --     is recorded as 'refund_stale_ignored' in the audit
    --     timeline (NOT as 'refund_failed' or similar, which
    --     would imply a real transition) and the RPC returns
    --     (resolved=false, error_reason='stale_event_ignored').
    --     _recompute_payment_status is NOT re-run because the
    --     persisted truth did not change.
    --
    -- Application contract: when a webhook handler suspects
    -- out-of-order delivery, it should refresh the Stripe Refund
    -- object before calling this RPC. SQL still enforces the
    -- non-regression rule below as a structural backstop.

    if v_existing_refund.status = 'succeeded'
       and p_status is distinct from 'succeeded' then
      -- Regression attempt. Record a non-mutating audit row and
      -- return stale-ignored. We do NOT update amount/currency/
      -- failure_reason from the older event either: those would
      -- semantically misrepresent the successful refund.
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'refund_stale_ignored',
        v_audit_event_id, v_existing_refund.amount_cents, v_existing_refund.currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        p_stripe_refund_id, null,
        v_charge.id, v_existing_refund.refund_attempt_id,
        'stale_event_ignored',
        null,
        jsonb_build_object(
          'stored_status', v_existing_refund.status,
          'incoming_status', p_status,
          'reason', 'succeeded_never_regresses'
        ),
        v_audit_account, v_audit_mode
      );
      return query select false, 'stale_event_ignored'::text;
      return;
    end if;

    if v_existing_refund.source = 'stripe_dashboard_observed'
       and v_attempt.id is not null then
      update public.stripe_refunds sr
         set source            = 'hone_initiated',
             refund_attempt_id = v_attempt.id,
             status            = p_status,
             failure_reason    = p_failure_reason,
             amount_cents      = p_amount_cents,
             currency          = p_currency,
             updated_at        = now()
       where sr.id = v_existing_refund.id;
    elsif v_existing_refund.source = 'hone_initiated'
          and v_attempt.id is not null
          and v_existing_refund.refund_attempt_id is distinct from v_attempt.id then
      -- P0 FINAL_FIXED #1: NON-MUTATING identity conflict. The
      -- previous behaviour mutated financial truth (status,
      -- failure_reason, amount_cents, currency) on the existing
      -- stripe_refunds row AND skipped _recompute_payment_status,
      -- which could leave the appointment payment summary stale
      -- while emitting a misleading 'refund_failed' audit. We now:
      --   * do NOT update stripe_refunds at all on this branch;
      --   * do NOT update stripe_refund_attempts;
      --   * emit 'refund_identifier_conflict' (the correct identity
      --     audit action, NOT 'refund_failed' which would imply a
      --     real lifecycle transition);
      --   * return (false, 'refund_attempt_link_conflict') so the
      --     webhook router can escalate.
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'refund_identifier_conflict', v_audit_event_id,
        v_existing_refund.amount_cents, v_existing_refund.currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        p_stripe_refund_id, null,
        v_charge.id, v_attempt.id,
        'refund_attempt_link_conflict', null,
        jsonb_build_object(
          'existing_refund_attempt_id', v_existing_refund.refund_attempt_id,
          'incoming_refund_attempt_id', v_attempt.id,
          'reason', 'existing_hone_refund_link_conflicts_with_incoming_metadata'
        ),
        v_audit_account, v_audit_mode
      );
      return query select false, 'refund_attempt_link_conflict'::text;
      return;
    else
      -- No proof on this event OR same attempt as before: leave
      -- source / refund_attempt_id untouched; refresh value fields.
      update public.stripe_refunds sr
         set status            = p_status,
             failure_reason    = p_failure_reason,
             amount_cents      = p_amount_cents,
             currency          = p_currency,
             updated_at        = now()
       where sr.id = v_existing_refund.id;
    end if;
  end if;

  -- FINAL REVIEW FIX: Only now, after existing-row source/link
  -- conflict checks have returned safely or passed, may a
  -- previously-unbound Hone refund attempt learn Stripe's
  -- Refund ID. If this UPDATE or any later statement fails, the
  -- surrounding transaction rolls back the stripe_refunds
  -- mutation as well.
  if v_attempt.id is not null
     and v_attempt.stripe_refund_id is null then
    update public.stripe_refund_attempts sra
       set stripe_refund_id = p_stripe_refund_id,
           updated_at = now()
     where sra.id = v_attempt.id;
    v_attempt.stripe_refund_id := p_stripe_refund_id;
  end if;

  -- Map Stripe status to local refund attempt state (proof match
  -- required). Lifecycle change detection (v_attempt_lifecycle_changed)
  -- gates whether we emit semantic audit below.
  if v_attempt.id is not null then
    if p_status = 'requires_action' then
      v_new_attempt_status := 'requires_action';
    elsif p_status = 'succeeded' then
      v_new_attempt_status := 'succeeded';
    elsif p_status = 'failed' then
      v_new_attempt_status := 'failed';
    elsif p_status = 'canceled' then
      v_new_attempt_status := 'canceled';
    else
      v_new_attempt_status := null;
    end if;

    if v_new_attempt_status is not null
       and v_attempt.status is distinct from v_new_attempt_status
       and v_attempt.status not in ('succeeded', 'failed', 'canceled') then
      update public.stripe_refund_attempts sra
         set status                = v_new_attempt_status,
             stripe_refund_id      = coalesce(sra.stripe_refund_id, p_stripe_refund_id),
             stripe_failure_reason = case when v_new_attempt_status in ('failed', 'canceled')
                                          then coalesce(p_failure_reason, sra.stripe_failure_reason)
                                          else sra.stripe_failure_reason end,
             processing_claim_token = case when v_new_attempt_status in ('succeeded', 'failed', 'canceled')
                                           then null
                                           else sra.processing_claim_token end,
             terminal_at = case when v_new_attempt_status in ('succeeded', 'failed', 'canceled')
                                then now() else sra.terminal_at end,
             updated_at = now()
       where sra.id = v_attempt.id;
      v_attempt_lifecycle_changed := true;
    end if;
  end if;

  -- Audit emission rules:
  --   * Emit only on an actual lifecycle change, or on first
  --     observation of a stripe_dashboard_observed refund (i.e.
  --     when we just inserted the row above).
  --   * Webhook echo of an already-recorded local state is a no-op
  --     (the partial-index dedup on event_id+action further
  --     guarantees the audit row does not duplicate).
  if v_attempt.id is not null then
    if v_attempt_lifecycle_changed and p_status = 'succeeded' then
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'refund_succeeded',
        v_audit_event_id, p_amount_cents, p_currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        p_stripe_refund_id, null,
        v_charge.id, v_attempt.id, null, null, v_meta,
        v_audit_account, v_audit_mode
      );
    elsif v_attempt_lifecycle_changed and p_status = 'failed' then
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'refund_failed', v_audit_event_id, p_amount_cents, p_currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        p_stripe_refund_id, null,
        v_charge.id, v_attempt.id, p_failure_reason, null, v_meta,
        v_audit_account, v_audit_mode
      );
    end if;
  else
    -- Dashboard refund. P0 v6: emit external_refund_observed
    -- ONLY on first insert OR an actual lifecycle transition
    -- to succeeded. Repeated identical 'succeeded' events with
    -- different webhook IDs (a real possibility under Stripe's
    -- redelivery / observability semantics) do NOT spam the
    -- audit timeline. The partial-index dedup on
    -- (event_id, action) covers same-event_id retries; this
    -- gate covers DIFFERENT event_ids restating the same state.
    if p_status = 'succeeded' then
      if (not v_refund_row_existed_before)
         or (v_refund_row_existed_before and not v_refund_was_succeeded_before) then
        perform public._append_stripe_payment_audit(
          v_charge.appointment_id, null, v_charge.studio_id, null,
          'external_refund_observed',
          v_audit_event_id, p_amount_cents, p_currency,
          v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
          p_stripe_refund_id, null,
          v_charge.id, null, null, null, v_meta,
          v_audit_account, v_audit_mode
        );
      end if;
    elsif p_status = 'failed' then
      -- Similar dedup for failed: only emit on first insert or
      -- transition into failed from a different state.
      if (not v_refund_row_existed_before)
         or (v_refund_row_existed_before and v_existing_refund.status is distinct from 'failed') then
        perform public._append_stripe_payment_audit(
          v_charge.appointment_id, null, v_charge.studio_id, null,
          'refund_failed', v_audit_event_id, p_amount_cents, p_currency,
          v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
          p_stripe_refund_id, null,
          v_charge.id, null, p_failure_reason, null, v_meta,
          v_audit_account, v_audit_mode
        );
      end if;
    end if;
  end if;

  perform public._recompute_payment_status(v_charge.appointment_id, v_charge.studio_id);
  return query select true, null::text;
end;
$$;

revoke execute on function public.reconcile_refund_event(
  uuid, text, boolean, text, text, text, integer, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.reconcile_refund_event(
  uuid, text, boolean, text, text, text, integer, text, text, text, uuid, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Dispute reconciliation (P0 v5 - state-aware and order-safe)
-- ---------------------------------------------------------------------------
-- The three RPCs below (reconcile_dispute_created /
-- reconcile_dispute_updated / reconcile_dispute_closed) all
-- enforce the following common invariants in v5:
--
--   * Charge lookup: exact (studio, account, mode, stripe_charge_id)
--     with status in ('succeeded', 'succeeded_duplicate'). Never
--     OR-with-PaymentIntent. PaymentIntent is verification only.
--
--   * Terminal-state non-regression: once a stored dispute is in
--     a TERMINAL outcome ('warning_closed', 'won', 'lost',
--     'prevented'), a subsequently-delivered older event must
--     NOT reopen or downgrade it. The stale event is recorded
--     as 'dispute_stale_ignored' (a non-mutating audit) and the
--     RPC returns 'stale_event_ignored'.
--
--   * No-op detection: if the persisted dispute row's status +
--     evidence_due_by + closed_outcome would not actually change
--     under this event, NO semantic audit row is appended and
--     the RPC returns 'idempotent_no_op'. (The partial-index
--     dedup on stripe_payment_audit (event_id, action) is the
--     deeper backstop; this short-circuit avoids unnecessary
--     work and noisier timelines.)
--
--   * Unknown-dispute on update/close: returns a STRUCTURED
--     non-success outcome ('unknown_dispute') instead of
--     silently no-opping. The webhook router must escalate.
--     reconcile_dispute_created remains the only auto-creator
--     (a dispute we do not know is most safely created by
--     replaying the create event after the router retrieves the
--     current Stripe Dispute object).
--
--   * Recompute: _recompute_payment_status runs ONLY when the
--     persisted dispute state actually changed.
--
-- Application contract: when webhook delivery order is uncertain,
-- the router should retrieve the current Stripe Dispute object
-- before calling these RPCs. SQL still enforces the
-- non-regression rule below as the structural backstop.
--
-- Dispute fee allocation is INTENTIONALLY NOT MODELED here; it
-- remains a live-launch verification item.

-- ---------------------------------------------------------------------------
-- reconcile_dispute_created
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_dispute_created(
  p_studio_id          uuid,
  p_stripe_account_id  text,
  p_stripe_livemode    boolean,
  p_charge_id          text,
  p_dispute_id         text,
  p_payment_intent_id  text,
  p_amount_cents       integer,
  p_currency           text,
  p_reason             text,
  p_status             text,
  p_evidence_due_by    timestamptz,
  p_stripe_event_id    text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_charge public.stripe_charge_attempts%rowtype;
  v_existing public.stripe_disputes%rowtype;
  v_changed boolean;
begin
  if p_stripe_account_id is null or p_stripe_livemode is null then
    raise exception 'p_stripe_account_id and p_stripe_livemode must be non-null'
      using errcode = '22023';
  end if;
  if p_charge_id is null then
    raise exception 'p_charge_id must be non-null for dispute reconciliation'
      using errcode = '22023';
  end if;

  select * into v_charge
  from public.stripe_charge_attempts sca
  where sca.studio_id = p_studio_id
    and sca.stripe_account_id = p_stripe_account_id
    and sca.stripe_livemode is not distinct from p_stripe_livemode
    and sca.stripe_charge_id = p_charge_id
    and sca.status in ('succeeded', 'succeeded_duplicate');
  if not found then return 'charge_attempt_not_found'; end if;

  if p_payment_intent_id is not null
     and v_charge.stripe_payment_intent_id is distinct from p_payment_intent_id then
    return 'payment_intent_id_mismatch';
  end if;

  -- P0 FINAL #4: dispute currency MUST match the original charge
  -- AND be CAD (V1 currency invariant). A mismatch indicates a
  -- mis-routed event or non-CAD ledger state and must NOT mutate
  -- stripe_disputes or recompute payment status.
  if p_currency is null
     or lower(p_currency) is distinct from lower(v_charge.currency)
     or lower(p_currency) <> 'cad' then
    perform public._append_stripe_payment_audit(
      v_charge.appointment_id, null, v_charge.studio_id, null,
      'dispute_identifier_conflict', p_stripe_event_id,
      v_charge.amount_cents, v_charge.currency,
      v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
      null, p_dispute_id, v_charge.id, null,
      'currency_mismatch', null,
      jsonb_build_object(
        'reason', 'dispute_currency_mismatch',
        'event', 'dispute_created',
        'stored_charge_currency', v_charge.currency,
        'incoming_dispute_currency', p_currency,
        'v1_required_currency', 'cad'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'dispute_identifier_conflict';
  end if;

  -- P0 v6 LOCK ORDER: lock financial root BEFORE the dispute row.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = v_charge.appointment_id
    and ap.studio_id = v_charge.studio_id
  for update;
  if not found then
    return 'appointment_payments_missing';
  end if;

  -- Lock any existing dispute row for non-regression + no-op
  -- detection.
  select * into v_existing
  from public.stripe_disputes sd
  where sd.stripe_account_id = p_stripe_account_id
    and sd.stripe_livemode is not distinct from p_stripe_livemode
    and sd.stripe_dispute_id = p_dispute_id
  for update;

  if found then
    -- P0 v6 DISPUTE IDENTITY IMMUTABILITY: stored row's immutable
    -- lineage (studio, account, mode, appointment, charge_attempt,
    -- charge_id, optional PI, amount, currency) MUST match the
    -- resolved charge / event. A mismatch means the Stripe
    -- Dispute ID has been mis-routed - we MUST NOT overwrite
    -- stored truth.
    if v_existing.studio_id          is distinct from v_charge.studio_id
       or v_existing.stripe_account_id is distinct from v_charge.stripe_account_id
       or v_existing.stripe_livemode  is distinct from v_charge.stripe_livemode
       or v_existing.appointment_id   is distinct from v_charge.appointment_id
       or v_existing.charge_attempt_id is distinct from v_charge.id
       or v_existing.stripe_charge_id is distinct from v_charge.stripe_charge_id
       or (p_payment_intent_id is not null
           and v_existing.stripe_payment_intent_id is not null
           and v_existing.stripe_payment_intent_id is distinct from p_payment_intent_id)
       or v_existing.amount_cents     is distinct from p_amount_cents
       or v_existing.currency         is distinct from p_currency then
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'dispute_identifier_conflict', p_stripe_event_id,
        v_existing.amount_cents, v_existing.currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        null, p_dispute_id, v_charge.id, null,
        'dispute_identifier_conflict', null,
        jsonb_build_object(
          'reason', 'existing_dispute_lineage_mismatch',
          'stored_studio_id',           v_existing.studio_id,
          'stored_appointment_id',      v_existing.appointment_id,
          'stored_charge_attempt_id',   v_existing.charge_attempt_id,
          'stored_charge_id',           v_existing.stripe_charge_id,
          'stored_payment_intent_id',   v_existing.stripe_payment_intent_id,
          'stored_amount_cents',        v_existing.amount_cents,
          'stored_currency',            v_existing.currency,
          'resolved_charge_attempt_id', v_charge.id,
          'resolved_charge_id',         v_charge.stripe_charge_id,
          'resolved_payment_intent_id', v_charge.stripe_payment_intent_id,
          'incoming_amount_cents',      p_amount_cents,
          'incoming_currency',          p_currency,
          'incoming_payment_intent_id', p_payment_intent_id
        ),
        p_stripe_account_id, p_stripe_livemode
      );
      return 'dispute_identifier_conflict';
    end if;

    -- Terminal-state non-regression: a closed/won/lost/prevented
    -- dispute MUST NOT be re-opened by a stale created event.
    if v_existing.status in ('warning_closed', 'won', 'lost', 'prevented')
       and p_status not in ('warning_closed', 'won', 'lost', 'prevented') then
      perform public._append_stripe_payment_audit(
        v_charge.appointment_id, null, v_charge.studio_id, null,
        'dispute_stale_ignored', p_stripe_event_id,
        v_existing.amount_cents, v_existing.currency,
        v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
        null, p_dispute_id, v_charge.id, null,
        'stale_event_ignored', null,
        jsonb_build_object(
          'reason', 'terminal_dispute_cannot_reopen',
          'stored_status', v_existing.status,
          'incoming_status', p_status,
          'incoming_event', 'dispute_created'
        ),
        p_stripe_account_id, p_stripe_livemode
      );
      return 'stale_event_ignored';
    end if;

    v_changed := (v_existing.status is distinct from p_status)
              or (v_existing.evidence_due_by is distinct from p_evidence_due_by);
    if not v_changed then
      return 'idempotent_no_op';
    end if;

    update public.stripe_disputes sd
       set status          = p_status,
           evidence_due_by = p_evidence_due_by,
           updated_at      = now()
     where sd.id = v_existing.id;
  else
    insert into public.stripe_disputes (
      studio_id, stripe_account_id, stripe_livemode,
      appointment_id, charge_attempt_id,
      stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id,
      amount_cents, currency, reason, status, evidence_due_by,
      created_at, updated_at
    ) values (
      p_studio_id, v_charge.stripe_account_id, v_charge.stripe_livemode,
      v_charge.appointment_id, v_charge.id,
      p_dispute_id, v_charge.stripe_charge_id, v_charge.stripe_payment_intent_id,
      p_amount_cents, p_currency, p_reason, p_status, p_evidence_due_by,
      now(), now()
    );
    v_changed := true;
  end if;

  perform public._append_stripe_payment_audit(
    v_charge.appointment_id, null, v_charge.studio_id, null,
    'dispute_created', p_stripe_event_id,
    p_amount_cents, p_currency,
    v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
    null, p_dispute_id, v_charge.id, null, null, null, '{}'::jsonb,
    p_stripe_account_id, p_stripe_livemode
  );

  perform public._recompute_payment_status(v_charge.appointment_id, v_charge.studio_id);
  return 'state_transitioned';
end;
$$;

revoke execute on function public.reconcile_dispute_created(
  uuid, text, boolean, text, text, text, integer, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.reconcile_dispute_created(
  uuid, text, boolean, text, text, text, integer, text, text, text, timestamptz, text
) to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_dispute_updated
-- ---------------------------------------------------------------------------
-- P0 v6: signature now accepts full Charge identity (charge_id,
-- payment_intent_id, amount_cents, currency) so the RPC can
-- verify the stored dispute's lineage against the resolved Charge
-- before any mutation. Application contract: the webhook router
-- MUST retrieve the current Stripe Dispute object before calling.
-- Returns 'unknown_dispute' if the dispute is not known locally
-- (the router must escalate / replay the create event).
-- Returns 'dispute_identifier_conflict' if the stored row's
-- immutable lineage does not match the resolved Charge.
-- Otherwise enforces terminal non-regression + no-op detection.
create or replace function public.reconcile_dispute_updated(
  p_studio_id          uuid,
  p_stripe_account_id  text,
  p_stripe_livemode    boolean,
  p_charge_id          text,
  p_dispute_id         text,
  p_payment_intent_id  text,
  p_amount_cents       integer,
  p_currency           text,
  p_status             text,
  p_evidence_due_by    timestamptz,
  p_stripe_event_id    text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_charge public.stripe_charge_attempts%rowtype;
  v_disp public.stripe_disputes%rowtype;
  v_changed boolean;
begin
  if p_stripe_account_id is null or p_stripe_livemode is null then
    raise exception 'p_stripe_account_id and p_stripe_livemode must be non-null'
      using errcode = '22023';
  end if;
  if p_charge_id is null then
    raise exception 'p_charge_id must be non-null for dispute_updated reconciliation'
      using errcode = '22023';
  end if;

  -- Resolve the Charge by exact stripe_charge_id (NO OR with PI).
  select * into v_charge
  from public.stripe_charge_attempts sca
  where sca.studio_id = p_studio_id
    and sca.stripe_account_id = p_stripe_account_id
    and sca.stripe_livemode is not distinct from p_stripe_livemode
    and sca.stripe_charge_id = p_charge_id
    and sca.status in ('succeeded', 'succeeded_duplicate');
  if not found then
    return 'charge_attempt_not_found';
  end if;
  if p_payment_intent_id is not null
     and v_charge.stripe_payment_intent_id is distinct from p_payment_intent_id then
    return 'payment_intent_id_mismatch';
  end if;

  -- P0 FINAL #4: dispute currency MUST match the original charge
  -- AND be CAD (V1 currency invariant).
  if p_currency is null
     or lower(p_currency) is distinct from lower(v_charge.currency)
     or lower(p_currency) <> 'cad' then
    perform public._append_stripe_payment_audit(
      v_charge.appointment_id, null, v_charge.studio_id, null,
      'dispute_identifier_conflict', p_stripe_event_id,
      v_charge.amount_cents, v_charge.currency,
      v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
      null, p_dispute_id, v_charge.id, null,
      'currency_mismatch', null,
      jsonb_build_object(
        'reason', 'dispute_currency_mismatch',
        'event', 'dispute_updated',
        'stored_charge_currency', v_charge.currency,
        'incoming_dispute_currency', p_currency,
        'v1_required_currency', 'cad'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'dispute_identifier_conflict';
  end if;

  -- Lock financial root first.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = v_charge.appointment_id
    and ap.studio_id = v_charge.studio_id
  for update;
  if not found then
    return 'appointment_payments_missing';
  end if;

  select * into v_disp
  from public.stripe_disputes sd
  where sd.stripe_dispute_id = p_dispute_id
    and sd.studio_id = p_studio_id
    and sd.stripe_account_id = p_stripe_account_id
    and sd.stripe_livemode is not distinct from p_stripe_livemode
  for update;
  if not found then
    return 'unknown_dispute';
  end if;

  -- IDENTITY IMMUTABILITY (P0 v6 #4).
  if v_disp.appointment_id   is distinct from v_charge.appointment_id
     or v_disp.charge_attempt_id is distinct from v_charge.id
     or v_disp.stripe_charge_id is distinct from v_charge.stripe_charge_id
     or (p_payment_intent_id is not null
         and v_disp.stripe_payment_intent_id is not null
         and v_disp.stripe_payment_intent_id is distinct from p_payment_intent_id)
     or v_disp.amount_cents     is distinct from p_amount_cents
     or v_disp.currency         is distinct from p_currency then
    perform public._append_stripe_payment_audit(
      v_disp.appointment_id, null, v_disp.studio_id, null,
      'dispute_identifier_conflict', p_stripe_event_id,
      v_disp.amount_cents, v_disp.currency,
      v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
      null, p_dispute_id, v_disp.charge_attempt_id, null,
      'dispute_identifier_conflict', null,
      jsonb_build_object(
        'reason', 'existing_dispute_lineage_mismatch',
        'event', 'dispute_updated',
        'stored_appointment_id',      v_disp.appointment_id,
        'stored_charge_attempt_id',   v_disp.charge_attempt_id,
        'stored_charge_id',           v_disp.stripe_charge_id,
        'stored_payment_intent_id',   v_disp.stripe_payment_intent_id,
        'stored_amount_cents',        v_disp.amount_cents,
        'stored_currency',            v_disp.currency,
        'resolved_charge_attempt_id', v_charge.id,
        'resolved_charge_id',         v_charge.stripe_charge_id,
        'resolved_payment_intent_id', v_charge.stripe_payment_intent_id,
        'incoming_amount_cents',      p_amount_cents,
        'incoming_currency',          p_currency,
        'incoming_payment_intent_id', p_payment_intent_id
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'dispute_identifier_conflict';
  end if;

  if v_disp.status in ('warning_closed', 'won', 'lost', 'prevented')
     and p_status not in ('warning_closed', 'won', 'lost', 'prevented') then
    perform public._append_stripe_payment_audit(
      v_disp.appointment_id, null, v_disp.studio_id, null,
      'dispute_stale_ignored', p_stripe_event_id,
      v_disp.amount_cents, v_disp.currency,
      v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
      null, p_dispute_id, v_disp.charge_attempt_id, null,
      'stale_event_ignored', null,
      jsonb_build_object(
        'reason', 'terminal_dispute_cannot_reopen',
        'stored_status', v_disp.status,
        'incoming_status', p_status,
        'incoming_event', 'dispute_updated'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'stale_event_ignored';
  end if;

  v_changed := (v_disp.status is distinct from p_status)
            or (v_disp.evidence_due_by is distinct from p_evidence_due_by);
  if not v_changed then
    return 'idempotent_no_op';
  end if;

  update public.stripe_disputes sd
     set status = p_status,
         evidence_due_by = p_evidence_due_by,
         updated_at = now()
   where sd.id = v_disp.id;

  perform public._append_stripe_payment_audit(
    v_disp.appointment_id, null, v_disp.studio_id, null,
    'dispute_updated', p_stripe_event_id,
    v_disp.amount_cents, v_disp.currency,
    v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
    null, p_dispute_id, v_disp.charge_attempt_id, null, null, null, '{}'::jsonb,
    p_stripe_account_id, p_stripe_livemode
  );

  perform public._recompute_payment_status(v_disp.appointment_id, v_disp.studio_id);
  return 'state_transitioned';
end;
$$;

revoke execute on function public.reconcile_dispute_updated(
  uuid, text, boolean, text, text, text, integer, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.reconcile_dispute_updated(
  uuid, text, boolean, text, text, text, integer, text, text, timestamptz, text
) to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_dispute_closed
-- ---------------------------------------------------------------------------
-- Records the terminal outcome (won/lost/closed/prevented).
-- Returns 'unknown_dispute' if the dispute is not known locally,
-- 'idempotent_no_op' if the stored state already matches.
-- Terminal-state non-regression: if the stored dispute is already
-- terminal and the incoming status would change it to a different
-- terminal, we still record the new terminal (e.g. an open
-- dispute may legitimately transition from won to lost via
-- chargeback reversal); but a terminal -> non-terminal flip is
-- rejected as stale.
create or replace function public.reconcile_dispute_closed(
  p_studio_id          uuid,
  p_stripe_account_id  text,
  p_stripe_livemode    boolean,
  p_charge_id          text,
  p_dispute_id         text,
  p_payment_intent_id  text,
  p_amount_cents       integer,
  p_currency           text,
  p_status             text,
  p_closed_outcome     text,
  p_stripe_event_id    text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_charge public.stripe_charge_attempts%rowtype;
  v_disp public.stripe_disputes%rowtype;
  v_changed boolean;
begin
  if p_stripe_account_id is null or p_stripe_livemode is null then
    raise exception 'p_stripe_account_id and p_stripe_livemode must be non-null'
      using errcode = '22023';
  end if;
  if p_charge_id is null then
    raise exception 'p_charge_id must be non-null for dispute_closed reconciliation'
      using errcode = '22023';
  end if;

  -- Resolve the Charge by exact stripe_charge_id (NO OR with PI).
  select * into v_charge
  from public.stripe_charge_attempts sca
  where sca.studio_id = p_studio_id
    and sca.stripe_account_id = p_stripe_account_id
    and sca.stripe_livemode is not distinct from p_stripe_livemode
    and sca.stripe_charge_id = p_charge_id
    and sca.status in ('succeeded', 'succeeded_duplicate');
  if not found then
    return 'charge_attempt_not_found';
  end if;
  if p_payment_intent_id is not null
     and v_charge.stripe_payment_intent_id is distinct from p_payment_intent_id then
    return 'payment_intent_id_mismatch';
  end if;

  -- P0 FINAL #4: dispute currency MUST match the original charge
  -- AND be CAD (V1 currency invariant).
  if p_currency is null
     or lower(p_currency) is distinct from lower(v_charge.currency)
     or lower(p_currency) <> 'cad' then
    perform public._append_stripe_payment_audit(
      v_charge.appointment_id, null, v_charge.studio_id, null,
      'dispute_identifier_conflict', p_stripe_event_id,
      v_charge.amount_cents, v_charge.currency,
      v_charge.stripe_payment_intent_id, v_charge.stripe_charge_id,
      null, p_dispute_id, v_charge.id, null,
      'currency_mismatch', null,
      jsonb_build_object(
        'reason', 'dispute_currency_mismatch',
        'event', 'dispute_closed',
        'stored_charge_currency', v_charge.currency,
        'incoming_dispute_currency', p_currency,
        'v1_required_currency', 'cad'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'dispute_identifier_conflict';
  end if;

  -- Lock financial root first.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = v_charge.appointment_id
    and ap.studio_id = v_charge.studio_id
  for update;
  if not found then
    return 'appointment_payments_missing';
  end if;

  select * into v_disp
  from public.stripe_disputes sd
  where sd.stripe_dispute_id = p_dispute_id
    and sd.studio_id = p_studio_id
    and sd.stripe_account_id = p_stripe_account_id
    and sd.stripe_livemode is not distinct from p_stripe_livemode
  for update;
  if not found then
    return 'unknown_dispute';
  end if;

  -- IDENTITY IMMUTABILITY (P0 v6 #4).
  if v_disp.appointment_id   is distinct from v_charge.appointment_id
     or v_disp.charge_attempt_id is distinct from v_charge.id
     or v_disp.stripe_charge_id is distinct from v_charge.stripe_charge_id
     or (p_payment_intent_id is not null
         and v_disp.stripe_payment_intent_id is not null
         and v_disp.stripe_payment_intent_id is distinct from p_payment_intent_id)
     or v_disp.amount_cents     is distinct from p_amount_cents
     or v_disp.currency         is distinct from p_currency then
    perform public._append_stripe_payment_audit(
      v_disp.appointment_id, null, v_disp.studio_id, null,
      'dispute_identifier_conflict', p_stripe_event_id,
      v_disp.amount_cents, v_disp.currency,
      v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
      null, p_dispute_id, v_disp.charge_attempt_id, null,
      'dispute_identifier_conflict', null,
      jsonb_build_object(
        'reason', 'existing_dispute_lineage_mismatch',
        'event', 'dispute_closed',
        'stored_appointment_id',      v_disp.appointment_id,
        'stored_charge_attempt_id',   v_disp.charge_attempt_id,
        'stored_charge_id',           v_disp.stripe_charge_id,
        'stored_payment_intent_id',   v_disp.stripe_payment_intent_id,
        'stored_amount_cents',        v_disp.amount_cents,
        'stored_currency',            v_disp.currency,
        'resolved_charge_attempt_id', v_charge.id,
        'resolved_charge_id',         v_charge.stripe_charge_id,
        'resolved_payment_intent_id', v_charge.stripe_payment_intent_id,
        'incoming_amount_cents',      p_amount_cents,
        'incoming_currency',          p_currency,
        'incoming_payment_intent_id', p_payment_intent_id
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'dispute_identifier_conflict';
  end if;

  if v_disp.status in ('warning_closed', 'won', 'lost', 'prevented')
     and p_status not in ('warning_closed', 'won', 'lost', 'prevented') then
    perform public._append_stripe_payment_audit(
      v_disp.appointment_id, null, v_disp.studio_id, null,
      'dispute_stale_ignored', p_stripe_event_id,
      v_disp.amount_cents, v_disp.currency,
      v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
      null, p_dispute_id, v_disp.charge_attempt_id, null,
      'stale_event_ignored', null,
      jsonb_build_object(
        'reason', 'terminal_dispute_cannot_reopen',
        'stored_status', v_disp.status,
        'incoming_status', p_status,
        'incoming_event', 'dispute_closed'
      ),
      p_stripe_account_id, p_stripe_livemode
    );
    return 'stale_event_ignored';
  end if;

  v_changed := (v_disp.status is distinct from p_status)
            or (v_disp.closed_outcome is distinct from p_closed_outcome);
  if not v_changed then
    return 'idempotent_no_op';
  end if;

  update public.stripe_disputes sd
     set status = p_status,
         closed_outcome = p_closed_outcome,
         updated_at = now()
   where sd.id = v_disp.id;

  perform public._append_stripe_payment_audit(
    v_disp.appointment_id, null, v_disp.studio_id, null,
    'dispute_closed', p_stripe_event_id,
    v_disp.amount_cents, v_disp.currency,
    v_disp.stripe_payment_intent_id, v_disp.stripe_charge_id,
    null, p_dispute_id, v_disp.charge_attempt_id, null, null, null,
    jsonb_build_object('closed_outcome', p_closed_outcome),
    p_stripe_account_id, p_stripe_livemode
  );

  perform public._recompute_payment_status(v_disp.appointment_id, v_disp.studio_id);
  return 'state_transitioned';
end;
$$;

revoke execute on function public.reconcile_dispute_closed(
  uuid, text, boolean, text, text, text, integer, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.reconcile_dispute_closed(
  uuid, text, boolean, text, text, text, integer, text, text, text, text
) to service_role;

-- ---- Double-charge resolution ----

-- ---------------------------------------------------------------------------
-- resolve_double_charge_incident
-- ---------------------------------------------------------------------------
-- Caller authority: re-checks ACTIVE OWNER predicate in SQL
-- (p_resolving_practitioner_id must be an active owner of
-- p_studio_id) - the resolution audit row attributes blame, and
-- only the owner may write that attribution.
-- INVARIANT: this RPC is the ONLY way to flip payment_status out
-- of double_charged. It REQUIRES PROOF that the duplicate has
-- been fully refunded against the exact duplicate stripe_charge_id
-- (not just any refund, not a partial refund). Without this
-- proof we never set duplicate_resolved_at, and the precedence
-- in _recompute_payment_status keeps payment_status pinned to
-- double_charged so the operator dashboard keeps showing the
-- incident.
-- Failure audit (P0 #6 v2): every failure path
-- ('unresolved_under_refunded', 'unresolved_over_refunded',
-- 'unresolved_inconsistent') emits a
-- 'double_charge_resolution_failed' audit row before returning,
-- so the operator timeline shows the attempted resolutions and
-- the reasons they did not stick.
-- Resolution variants:
--   * refunded_duplicate    - only the duplicate was fully refunded;
--                             primary still net captured
--   * all_charges_refunded  - primary was also fully refunded
create or replace function public.resolve_double_charge_incident(
  p_appointment_id                 uuid,
  p_studio_id                      uuid,
  p_duplicate_charge_attempt_id    uuid,
  p_resolving_practitioner_id      uuid
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_dup public.stripe_charge_attempts%rowtype;
  v_primary public.stripe_charge_attempts%rowtype;
  v_dup_refunded integer;
  v_primary_refunded integer;
  v_unresolved_remaining integer;
  v_resolution text;
  v_recomputed text;
  v_final text;
begin
  -- Active OWNER re-check (P0 #6 v2).
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_resolving_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.role = 'owner'
       and pr.active = true
  ) then
    raise exception 'only the active studio owner may resolve double-charge incidents'
      using errcode = '42501';
  end if;

  -- P0 v6 LOCK ORDER: lock the financial root BEFORE the charge
  -- attempt row, matching the rest of the payment RPCs. This
  -- serializes resolution against concurrent reconcile_*_event
  -- recomputes for the same appointment.
  perform 1
  from public.appointment_payments ap
  where ap.appointment_id = p_appointment_id
    and ap.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment_payments missing for double-charge resolution'
      using errcode = 'P0002';
  end if;

  select * into v_dup
  from public.stripe_charge_attempts sca
  where sca.id = p_duplicate_charge_attempt_id
    and sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
  for update;
  if not found or v_dup.status <> 'succeeded_duplicate' then
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolution_failed', null,
      null, null,
      null, null, null, null,
      p_duplicate_charge_attempt_id, null,
      'unresolved_inconsistent', null,
      jsonb_build_object('reason', 'attempt_not_found_or_not_duplicate'),
      null, null
    );
    return 'unresolved_inconsistent';
  end if;
  if v_dup.duplicate_resolved_at is not null then
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolution_failed', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null,
      'unresolved_inconsistent', null,
      jsonb_build_object('reason', 'already_resolved'),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    return 'unresolved_inconsistent';
  end if;

  -- Duplicate refund proof.
  select coalesce(sum(sr.amount_cents), 0) into v_dup_refunded
  from public.stripe_refunds sr
  where sr.studio_id = p_studio_id
    and sr.charge_attempt_id = p_duplicate_charge_attempt_id
    and sr.stripe_charge_id = v_dup.stripe_charge_id
    and sr.status = 'succeeded';

  if v_dup_refunded < v_dup.amount_cents then
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolution_failed', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null,
      'unresolved_under_refunded', null,
      jsonb_build_object(
        'duplicate_amount_cents', v_dup.amount_cents,
        'refunded_so_far_cents', v_dup_refunded
      ),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    return 'unresolved_under_refunded';
  end if;
  if v_dup_refunded > v_dup.amount_cents then
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolution_failed', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null,
      'unresolved_over_refunded', null,
      jsonb_build_object(
        'duplicate_amount_cents', v_dup.amount_cents,
        'refunded_so_far_cents', v_dup_refunded
      ),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    return 'unresolved_over_refunded';
  end if;

  -- Determine if primary is also refunded.
  select * into v_primary
  from public.stripe_charge_attempts sca
  where sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
    and sca.status = 'succeeded';

  v_primary_refunded := 0;
  if found then
    select coalesce(sum(sr.amount_cents), 0) into v_primary_refunded
    from public.stripe_refunds sr
    where sr.studio_id = p_studio_id
      and sr.charge_attempt_id = v_primary.id
      and sr.stripe_charge_id = v_primary.stripe_charge_id
      and sr.status = 'succeeded';
  end if;

  if v_primary_refunded >= coalesce(v_primary.amount_cents, 0) and found then
    v_resolution := 'all_charges_refunded';
  else
    v_resolution := 'refunded_duplicate';
  end if;

  -- P0 v7 #7: TENTATIVE write of duplicate-resolution fields. We
  -- update the row so _recompute_payment_status can observe the
  -- tentative resolved state and decide whether it is consistent.
  -- If the recompute returns a valid resolved state we KEEP the
  -- fields and emit the success audit. If it returns something
  -- unexpected (reconciliation_required, an unresolved
  -- double_charged for any reason, or an unmapped status), we
  -- REVERT the fields to NULL and emit only the failure audit -
  -- never leaving a 'double_charge_resolved' audit row for a
  -- resolution that did not actually stick.
  update public.stripe_charge_attempts sca
     set duplicate_resolved_at = now(),
         duplicate_resolution = v_resolution,
         duplicate_resolved_by_practitioner_id = p_resolving_practitioner_id,
         updated_at = now()
   where sca.id = p_duplicate_charge_attempt_id;

  v_recomputed := public._recompute_payment_status(p_appointment_id, p_studio_id);

  -- Count remaining unresolved duplicates AFTER the tentative
  -- update (this attempt is now resolved, so it should be 0
  -- unless ANOTHER unresolved duplicate exists for the same
  -- appointment).
  select count(*) into v_unresolved_remaining
  from public.stripe_charge_attempts sca
  where sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
    and sca.status = 'succeeded_duplicate'
    and sca.duplicate_resolved_at is null;

  if v_unresolved_remaining > 0 and v_recomputed = 'double_charged' then
    -- P0 FINAL_FIXED #4: 'resolved_double_charged_remaining' is
    -- accepted ONLY when both predicates are true:
    --   * another unresolved succeeded_duplicate exists for this
    --     appointment (so SOME duplicate-charge incident remains
    --     legitimately unresolved); AND
    --   * _recompute_payment_status returned 'double_charged',
    --     which is the precedence-correct status for that
    --     remaining-incident state.
    -- This combination proves: THIS resolution actually stuck,
    -- and the appointment payment summary reflects the
    -- still-unresolved sibling incident. Without the second
    -- predicate, a recompute that returned
    -- 'reconciliation_required' (or any other inconsistent
    -- status) would be silently mapped to
    -- 'resolved_double_charged_remaining' and the tentative
    -- resolution would be incorrectly committed.
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolved', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null, null, null,
      jsonb_build_object(
        'resolution', v_resolution,
        'remaining_unresolved_duplicates', v_unresolved_remaining,
        'recomputed', v_recomputed
      ),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    v_final := 'resolved_double_charged_remaining';
  elsif v_recomputed in ('charged', 'partially_refunded', 'refunded', 'disputed') then
    -- Tentative resolution stuck. Emit the success audit now.
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolved', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null, null, null,
      jsonb_build_object('resolution', v_resolution),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    if v_recomputed = 'charged' then
      v_final := 'resolved_charged';
    elsif v_recomputed = 'partially_refunded' then
      v_final := 'resolved_partially_refunded';
    elsif v_recomputed = 'refunded' then
      v_final := 'resolved_refunded';
    else
      v_final := 'resolved_disputed';
    end if;
  else
    -- P0 v7 #7: recompute came back with an inconsistent /
    -- unexpected status. REVERT the tentative resolution write,
    -- recompute again so unresolved-duplicate precedence pins
    -- payment_status back to 'double_charged', and emit ONLY the
    -- failure audit. Never leave a 'double_charge_resolved'
    -- audit for a resolution that did not stick.
    update public.stripe_charge_attempts sca
       set duplicate_resolved_at = null,
           duplicate_resolution = null,
           duplicate_resolved_by_practitioner_id = null,
           updated_at = now()
     where sca.id = p_duplicate_charge_attempt_id;
    perform public._recompute_payment_status(p_appointment_id, p_studio_id);
    perform public._append_stripe_payment_audit(
      p_appointment_id, null, p_studio_id, p_resolving_practitioner_id,
      'double_charge_resolution_failed', null,
      v_dup.amount_cents, v_dup.currency,
      v_dup.stripe_payment_intent_id, v_dup.stripe_charge_id,
      null, null, v_dup.id, null,
      'unresolved_inconsistent', null,
      jsonb_build_object(
        'reason', 'recompute_returned_unexpected_status',
        'recomputed', v_recomputed,
        'tentative_resolution_reverted', true
      ),
      v_dup.stripe_account_id, v_dup.stripe_livemode
    );
    v_final := 'unresolved_inconsistent';
  end if;

  return v_final;
end;
$$;

revoke execute on function public.resolve_double_charge_incident(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_double_charge_incident(uuid, uuid, uuid, uuid)
  to service_role;

-- ---- Webhook claim ----

-- ---------------------------------------------------------------------------
-- claim_stripe_event
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. The webhook entry point
-- calls this RPC FIRST, before doing any business-logic routing,
-- to decide whether to process the event.
-- Three-way return:
--   * claimed_by_this_request=true: caller owns processing now,
--     must follow up with mark_stripe_event_processed or
--     release_stripe_event_claim_with_error.
--   * already_processed=true: this exact event was already
--     processed previously; skip.
--   * currently_processing_elsewhere=true: another worker has a
--     fresh claim on this event; skip (the other worker will
--     handle it).
-- Stale-claim takeover at 5 minutes prevents a crashed worker
-- from permanently blocking re-processing.
create or replace function public.claim_stripe_event(
  p_event_id           text,
  p_event_type         text,
  p_stripe_account_id  text,
  p_stripe_livemode    boolean,
  p_studio_id          uuid
) returns table (
  claimed_by_this_request         boolean,
  already_processed               boolean,
  currently_processing_elsewhere  boolean,
  claim_token                     uuid
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_token uuid;
  v_existing public.stripe_events%rowtype;
  v_inserted boolean;
begin
  v_token := gen_random_uuid();

  insert into public.stripe_events (
    stripe_event_id, event_type, stripe_account_id, stripe_livemode, studio_id,
    processing_started_at, processing_claim_token,
    processing_attempt_count, created_at
  ) values (
    p_event_id, p_event_type, p_stripe_account_id, p_stripe_livemode, p_studio_id,
    now(), v_token, 1, now()
  )
  on conflict (stripe_account_id, stripe_livemode, stripe_event_id) do nothing
  returning true into v_inserted;

  if v_inserted then
    return query select true, false, false, v_token;
    return;
  end if;

  select * into v_existing
  from public.stripe_events se
  where se.stripe_account_id = p_stripe_account_id
    and se.stripe_livemode is not distinct from p_stripe_livemode
    and se.stripe_event_id = p_event_id
  for update;

  if v_existing.processed_at is not null then
    return query select false, true, false, null::uuid;
    return;
  end if;
  if v_existing.processing_claim_token is not null
     and v_existing.processing_started_at > now() - interval '5 minutes' then
    return query select false, false, true, null::uuid;
    return;
  end if;
  update public.stripe_events se
     set processing_claim_token = v_token,
         processing_started_at = now(),
         processing_attempt_count = se.processing_attempt_count + 1,
         error = null
   where se.id = v_existing.id;
  return query select true, false, false, v_token;
end;
$$;

revoke execute on function public.claim_stripe_event(text, text, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_event(text, text, text, boolean, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- mark_stripe_event_processed
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Marks an event as
-- successfully processed and stores a small payload_summary
-- (event_type-specific fields the application chose to retain for
-- audit). Requires matching claim_token; rejects late writes
-- from a stale worker whose claim was taken over.
create or replace function public.mark_stripe_event_processed(
  p_event_id           text,
  p_claim_token        uuid,
  p_payload_summary    jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Aliased so the WHERE references the table column, not the
  -- p_event_id parameter, even though they would resolve the
  -- same here.
  update public.stripe_events se
     set processed_at = now(),
         processing_claim_token = null,
         payload_summary = p_payload_summary
   where se.stripe_event_id = p_event_id
     and se.processing_claim_token is not distinct from p_claim_token;
  if not found then
    raise exception 'event claim mismatch; not processed' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.mark_stripe_event_processed(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.mark_stripe_event_processed(text, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- release_stripe_event_claim_with_error
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Releases the claim token
-- on an event AFTER a processing failure, so a future webhook
-- retry (or the next cron sweep) can pick it up. The error text
-- is preserved for diagnostics.
create or replace function public.release_stripe_event_claim_with_error(
  p_event_id     text,
  p_claim_token  uuid,
  p_error        text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.stripe_events se
     set processing_claim_token = null,
         error = p_error
   where se.stripe_event_id = p_event_id
     and se.processing_claim_token is not distinct from p_claim_token;
end;
$$;

revoke execute on function public.release_stripe_event_claim_with_error(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_stripe_event_claim_with_error(text, uuid, text)
  to service_role;

-- ---- Recovery tokens ----

-- ---------------------------------------------------------------------------
-- create_payment_recovery_token
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Issues a single-use
-- recovery URL token bound to one specific charge attempt.
-- Invariants enforced (P0 #9):
--   * The charge attempt must exist under the claimed
--     (appointment, studio).
--   * The claimed (account, mode) must equal the charge
--     attempt's stored (account, mode); the FK on
--     payment_recovery_tokens enforces the same on write, but
--     re-checking here gives a clean error before insert.
--   * The charge attempt MUST currently be in
--     'authentication_required' state. Tokens for any other
--     state would either be redundant (already succeeded) or
--     misleading (would resolve to a Stripe error in the
--     PaymentElement). This is the structural reason a recovery
--     link is meaningful only for 3DS recovery flows.
-- Open-token uniqueness is provided by partial index
-- payment_recovery_tokens_one_open_per_attempt; we proactively
-- invalidate any already-expired open token for the same
-- attempt before inserting, so the unique-index check sees a
-- clean state.
create or replace function public.create_payment_recovery_token(
  p_charge_attempt_id  uuid,
  p_appointment_id     uuid,
  p_studio_id          uuid,
  p_stripe_account_id  text,
  p_stripe_livemode    boolean,
  p_token_hash         text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_attempt_account text;
  v_attempt_mode boolean;
  v_attempt_status text;
begin
  -- Verify the attempt belongs under (appointment, studio) and
  -- read its account/mode + status atomically.
  select sca.stripe_account_id, sca.stripe_livemode, sca.status
    into v_attempt_account, v_attempt_mode, v_attempt_status
  from public.stripe_charge_attempts sca
  where sca.id = p_charge_attempt_id
    and sca.appointment_id = p_appointment_id
    and sca.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'charge attempt not found' using errcode = 'P0002';
  end if;
  if v_attempt_account is distinct from p_stripe_account_id
     or v_attempt_mode is distinct from p_stripe_livemode then
    raise exception 'recovery token account/mode does not match charge attempt'
      using errcode = 'P0002';
  end if;
  -- P0 #9: state guard.
  if v_attempt_status <> 'authentication_required' then
    raise exception 'recovery tokens may only be issued for authentication_required charges (current: %)', v_attempt_status
      using errcode = 'P0002';
  end if;

  -- Invalidate any currently-open token for this attempt that
  -- has expired, so the unique-index check has a clean slate.
  update public.payment_recovery_tokens prt
     set invalidated_at = now()
   where prt.charge_attempt_id = p_charge_attempt_id
     and prt.consumed_at is null
     and prt.invalidated_at is null
     and prt.expires_at <= now();

  insert into public.payment_recovery_tokens (
    token_hash, charge_attempt_id, appointment_id, studio_id,
    stripe_account_id, stripe_livemode
  ) values (
    p_token_hash, p_charge_attempt_id, p_appointment_id, p_studio_id,
    p_stripe_account_id, p_stripe_livemode
  );
end;
$$;

revoke execute on function public.create_payment_recovery_token(uuid, uuid, uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.create_payment_recovery_token(uuid, uuid, uuid, text, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- lookup_payment_recovery_token
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Validates an inbound
-- recovery URL token hash and returns the bound charge identity
-- so the recovery page can show the right amount and post to the
-- existing PaymentIntent.
-- Returns is_valid=false with a reason for every failure mode
-- (not_found / consumed / invalidated / expired /
-- attempt_not_recoverable / account_mode_mismatch). The token
-- itself is opaque; this RPC is the only place that resolves it
-- to a charge.
-- Defense in depth: the token row's (account, mode) is matched
-- against the charge attempt's (account, mode) here, even though
-- the FK on payment_recovery_tokens enforces the same on write.
-- Closes any post-migration drift window.
create or replace function public.lookup_payment_recovery_token(
  p_token_hash text
) returns table (
  out_charge_attempt_id   text,
  out_appointment_id      uuid,
  out_studio_id           uuid,
  out_stripe_account_id   text,
  out_stripe_livemode     boolean,
  is_valid                boolean,
  reason                  text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.payment_recovery_tokens%rowtype;
  v_charge public.stripe_charge_attempts%rowtype;
begin
  select * into v_row
  from public.payment_recovery_tokens prt
  where prt.token_hash = p_token_hash;
  if not found then
    return query select null::text, null::uuid, null::uuid, null::text, null::boolean, false, 'not_found'::text;
    return;
  end if;
  if v_row.consumed_at is not null then
    return query select null::text, v_row.appointment_id, v_row.studio_id,
                        v_row.stripe_account_id, v_row.stripe_livemode, false, 'consumed'::text;
    return;
  end if;
  if v_row.invalidated_at is not null then
    return query select null::text, v_row.appointment_id, v_row.studio_id,
                        v_row.stripe_account_id, v_row.stripe_livemode, false, 'invalidated'::text;
    return;
  end if;
  if v_row.expires_at <= now() then
    return query select null::text, v_row.appointment_id, v_row.studio_id,
                        v_row.stripe_account_id, v_row.stripe_livemode, false, 'expired'::text;
    return;
  end if;
  select * into v_charge from public.stripe_charge_attempts sca where sca.id = v_row.charge_attempt_id;
  if not found or v_charge.status <> 'authentication_required' then
    return query select null::text, v_row.appointment_id, v_row.studio_id,
                        v_row.stripe_account_id, v_row.stripe_livemode, false, 'attempt_not_recoverable'::text;
    return;
  end if;
  -- Defense in depth: token's (account, mode) must still equal
  -- the charge's (account, mode). FK enforces this on write but
  -- re-checking on read closes any drift window.
  if v_charge.stripe_account_id is distinct from v_row.stripe_account_id
     or v_charge.stripe_livemode is distinct from v_row.stripe_livemode then
    return query select null::text, v_row.appointment_id, v_row.studio_id,
                        v_row.stripe_account_id, v_row.stripe_livemode, false, 'account_mode_mismatch'::text;
    return;
  end if;
  return query
    select v_row.charge_attempt_id::text, v_row.appointment_id, v_row.studio_id,
           v_row.stripe_account_id, v_row.stripe_livemode, true, null::text;
end;
$$;

revoke execute on function public.lookup_payment_recovery_token(text)
  from public, anon, authenticated;
grant execute on function public.lookup_payment_recovery_token(text)
  to service_role;

-- ---------------------------------------------------------------------------
-- consume_payment_recovery_tokens_for_charge_attempt
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only. Called from
-- reconcile_payment_intent_by_charge_attempt on both 'succeeded'
-- and 'succeeded_duplicate' transitions.
-- Semantics (P0 v3 - token state vocabulary clarified):
--   * consumed_at  - the token's authenticated payment flow
--                    actually SUCCEEDED. This RPC stamps
--                    consumed_at = now() so that
--                    lookup_payment_recovery_token returns
--                    is_valid=false / reason='consumed' on any
--                    future redemption attempt. A consumed token
--                    is a permanent record of a successful use.
--   * invalidated_at - the token is being retired WITHOUT a
--                      successful use (e.g. it expired and is
--                      being replaced by a fresh token in
--                      create_payment_recovery_token). Different
--                      semantic class from consumed_at: a future
--                      redemption returns reason='invalidated'.
-- Both consumed and invalidated tokens are excluded from the
-- open-token uniqueness index so a fresh token can be issued
-- against the same charge attempt.
-- Without this consumption on successful payment, an old
-- recovery URL could be redeemed after the underlying
-- PaymentIntent has already terminated, leading to a confusing
-- client experience and a possible spurious charge.
create or replace function public.consume_payment_recovery_tokens_for_charge_attempt(
  p_charge_attempt_id uuid,
  p_studio_id         uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Stamp consumed_at (NOT invalidated_at) - the underlying
  -- payment actually succeeded, so the token's truthful terminal
  -- state is 'consumed', which is what
  -- lookup_payment_recovery_token reports back as the rejection
  -- reason on any future redemption.
  update public.payment_recovery_tokens prt
     set consumed_at = now()
   where prt.charge_attempt_id = p_charge_attempt_id
     and prt.studio_id = p_studio_id
     and prt.consumed_at is null
     and prt.invalidated_at is null;
end;
$$;

revoke execute on function public.consume_payment_recovery_tokens_for_charge_attempt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.consume_payment_recovery_tokens_for_charge_attempt(uuid, uuid)
  to service_role;

-- ---- Display-safe READ RPCs (authenticated, internal owner check) ----
--
-- The display-safe read RPCs below are the ONLY way authenticated
-- users may read payment state. Each function:
--   * Re-checks is_studio_owner(p_studio_id) inside the RPC.
--   * Returns only display-relevant columns (no Stripe IDs, no
--     idempotency keys, no claim tokens, no raw Stripe error
--     strings, no PaymentMethod identifiers).
--   * Has EXECUTE revoked from public/anon and granted to
--     authenticated; service_role retains EXECUTE only via
--     supabase defaults (no explicit grant needed).

-- ---------------------------------------------------------------------------
-- get_studio_payment_settings_display
-- ---------------------------------------------------------------------------
-- Returns the studio's payment settings (status, charges_enabled,
-- payouts_enabled, onboarding_completed_at, require_card_on_file,
-- livemode) for the settings page. NEVER returns stripe_account_id.
create or replace function public.get_studio_payment_settings_display(
  p_studio_id uuid
) returns table (
  account_status              text,
  charges_enabled             boolean,
  payouts_enabled             boolean,
  onboarding_completed_at     timestamptz,
  require_card_on_file        boolean,
  livemode                    boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select sps.stripe_account_status, sps.stripe_charges_enabled,
           sps.stripe_payouts_enabled, sps.stripe_onboarding_completed_at,
           sps.require_card_on_file, sps.stripe_livemode
      from public.studio_payment_settings sps
     where sps.studio_id = p_studio_id;
end;
$$;

revoke execute on function public.get_studio_payment_settings_display(uuid) from public, anon;
grant execute on function public.get_studio_payment_settings_display(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_appointment_payment_display
-- ---------------------------------------------------------------------------
-- Returns derived display fields for one appointment's payment
-- card on the session page: status, completed-at, has-PM bool,
-- aggregate captured + refunded amounts, and dispute / duplicate
-- flags. The application uses these to render badges and CTAs.
create or replace function public.get_appointment_payment_display(
  p_appointment_id uuid,
  p_studio_id      uuid
) returns table (
  payment_status              text,
  payment_completed_at        timestamptz,
  has_payment_method          boolean,
  succeeded_amount_cents      integer,
  refunded_amount_cents       integer,
  has_active_dispute          boolean,
  has_unresolved_duplicate    boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_succeeded integer := 0;
  v_refunded integer := 0;
  v_disputed boolean := false;
  v_dup boolean := false;
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(sum(amount_cents),0) into v_succeeded
    from public.stripe_charge_attempts
   where appointment_id = p_appointment_id and studio_id = p_studio_id
     and status in ('succeeded', 'succeeded_duplicate');
  select coalesce(sum(amount_cents),0) into v_refunded
    from public.stripe_refunds
   where appointment_id = p_appointment_id and studio_id = p_studio_id
     and status = 'succeeded';
  select exists(select 1 from public.stripe_disputes
    where appointment_id = p_appointment_id and studio_id = p_studio_id
      and status not in ('warning_closed','won','lost','prevented'))
    into v_disputed;
  select exists(select 1 from public.stripe_charge_attempts
    where appointment_id = p_appointment_id and studio_id = p_studio_id
      and status = 'succeeded_duplicate' and duplicate_resolved_at is null)
    into v_dup;

  return query
    select ap.payment_status, ap.payment_completed_at,
           (ap.stripe_payment_method_id is not null),
           v_succeeded, v_refunded, v_disputed, v_dup
      from public.appointment_payments ap
     where ap.appointment_id = p_appointment_id and ap.studio_id = p_studio_id;
end;
$$;

revoke execute on function public.get_appointment_payment_display(uuid, uuid) from public, anon;
grant execute on function public.get_appointment_payment_display(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_disputes_for_studio
-- ---------------------------------------------------------------------------
-- Returns open and recent disputes for the owner's dispute queue
-- view, ordered by evidence_due_by asc nulls last so the most
-- urgent items surface first.
-- P1 v7: raw stripe_dispute_id REMOVED from the owner display
-- output. The display surface needs only the internal Hone
-- dispute_id (for deep-linking back into the operator dashboard)
-- plus amount/currency/reason/status/evidence_due_by/closed_outcome.
-- Raw Stripe IDs remain server-side and may be read by
-- service_role queries against stripe_disputes directly.
create or replace function public.get_disputes_for_studio(
  p_studio_id uuid
) returns table (
  dispute_id         uuid,
  appointment_id     uuid,
  amount_cents       integer,
  currency           text,
  reason             text,
  status             text,
  evidence_due_by    timestamptz,
  closed_outcome     text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select d.id, d.appointment_id, d.amount_cents,
           d.currency, d.reason, d.status, d.evidence_due_by, d.closed_outcome
      from public.stripe_disputes d
     where d.studio_id = p_studio_id
     order by d.evidence_due_by nulls last, d.created_at desc;
end;
$$;

revoke execute on function public.get_disputes_for_studio(uuid) from public, anon;
grant execute on function public.get_disputes_for_studio(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_refunds_for_appointment
-- ---------------------------------------------------------------------------
-- Returns the refund ledger for one appointment, labelled by
-- source so the UI can distinguish Hone-initiated refunds from
-- Dashboard-observed ones.
create or replace function public.get_refunds_for_appointment(
  p_appointment_id uuid,
  p_studio_id      uuid
) returns table (
  source        text,
  amount_cents  integer,
  currency      text,
  status        text,
  created_at    timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select r.source, r.amount_cents, r.currency, r.status, r.created_at
      from public.stripe_refunds r
     where r.appointment_id = p_appointment_id and r.studio_id = p_studio_id
     order by r.created_at desc;
end;
$$;

revoke execute on function public.get_refunds_for_appointment(uuid, uuid) from public, anon;
grant execute on function public.get_refunds_for_appointment(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_payment_audit_for_appointment
-- ---------------------------------------------------------------------------
-- Returns the semantic audit history for one appointment
-- (charge_attempted / succeeded / failed / refund_* /
-- dispute_* / double_charge_*) for the operator-facing payment
-- timeline.
-- P1 v2 - display-safety: raw stripe_payment_audit.error_message
-- is NEVER returned. The error_code identifier is exposed (e.g.
-- 'card_declined', 'authentication_required', 'refund_attempt_link_conflict')
-- so the UI can render a known sanitized label. A deliberately
-- sanitized display_message is composed in SQL from a small
-- whitelist of error_code values; everything else collapses to
-- NULL. Raw Stripe / internal error text stays server-side only
-- (queryable directly from stripe_payment_audit by service_role).
create or replace function public.get_payment_audit_for_appointment(
  p_appointment_id uuid,
  p_studio_id      uuid
) returns table (
  action            text,
  amount_cents      integer,
  currency          text,
  error_code        text,
  display_message   text,
  created_at        timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select a.action,
           a.amount_cents,
           a.currency,
           a.error_code,
           case a.error_code
             when 'card_declined' then 'Card was declined.'
             when 'authentication_required' then 'Card authentication required.'
             when 'insufficient_funds' then 'Card had insufficient funds.'
             when 'expired_card' then 'Card is expired.'
             when 'processing_error' then 'Card network reported a processing error.'
             when 'missing_consent_at_setup_intent' then 'Saved-card flow missing consent; cleanup queued.'
             when 'delayed_setup_intent_after_expiry' then 'Late saved-card webhook after session expiry; cleanup queued.'
             when 'late_setup_intent_after_cleaned_without_pm' then 'Late saved-card webhook after cleanup; cleanup queued.'
             when 'setup_intent_after_session_expired' then 'Saved-card webhook arrived after session expired; cleanup queued.'
             when 'refund_attempt_link_conflict' then 'Refund event linked to a different refund attempt.'
             when 'unresolved_under_refunded' then 'Resolution attempted before duplicate was fully refunded.'
             when 'unresolved_over_refunded' then 'Resolution attempted with more refunded than charged.'
             when 'unresolved_inconsistent' then 'Resolution attempt could not reconcile state.'
             when 'same_row_identifier_conflict' then 'Stripe sent a conflicting PaymentIntent/Charge ID for this row.'
             else null
           end as display_message,
           a.created_at
      from public.stripe_payment_audit a
     where a.appointment_id = p_appointment_id and a.studio_id = p_studio_id
     order by a.created_at desc;
end;
$$;

revoke execute on function public.get_payment_audit_for_appointment(uuid, uuid) from public, anon;
grant execute on function public.get_payment_audit_for_appointment(uuid, uuid) to authenticated;

-- ===========================================================================
-- Section 1.8: updated_at triggers
-- ===========================================================================
create or replace function public.set_updated_at_now()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

create trigger studio_payment_settings_updated_at
  before update on public.studio_payment_settings
  for each row execute function public.set_updated_at_now();
create trigger client_stripe_customers_updated_at
  before update on public.client_stripe_customers
  for each row execute function public.set_updated_at_now();
create trigger pending_booking_payment_sessions_updated_at
  before update on public.pending_booking_payment_sessions
  for each row execute function public.set_updated_at_now();
create trigger appointment_payments_updated_at
  before update on public.appointment_payments
  for each row execute function public.set_updated_at_now();
create trigger stripe_account_provisioning_attempts_updated_at
  before update on public.stripe_account_provisioning_attempts
  for each row execute function public.set_updated_at_now();
create trigger stripe_customer_provisioning_attempts_updated_at
  before update on public.stripe_customer_provisioning_attempts
  for each row execute function public.set_updated_at_now();
create trigger stripe_charge_attempts_updated_at
  before update on public.stripe_charge_attempts
  for each row execute function public.set_updated_at_now();
create trigger stripe_refund_attempts_updated_at
  before update on public.stripe_refund_attempts
  for each row execute function public.set_updated_at_now();
create trigger stripe_refunds_updated_at
  before update on public.stripe_refunds
  for each row execute function public.set_updated_at_now();
create trigger stripe_disputes_updated_at
  before update on public.stripe_disputes
  for each row execute function public.set_updated_at_now();

-- ===========================================================================
-- APPLICATION CONTRACT: webhook routing dependency checklist
-- ===========================================================================
-- The application layer that feeds this migration's RPCs MUST
-- route Stripe events as follows. None of these are enforced by
-- the database; this comment block is the source of truth the
-- webhook handler is built against.
--
-- account.updated
--   -> sync_studio_account_status
--      (status / charges_enabled / payouts_enabled fields only;
--      MUST NOT create a binding - that path is exclusively
--      complete_stripe_account_provisioning).
--
-- setup_intent.succeeded
--   -> reconcile_setup_intent_succeeded
--      (after webhook signature verification; the application
--      already knows the session_id via SetupIntent metadata).
--
-- payment_intent.succeeded
-- payment_intent.payment_failed
-- payment_intent.requires_action
-- payment_intent.canceled
--   -> reconcile_payment_intent_by_charge_attempt
--      (the application resolves the charge_attempt_id from
--      PaymentIntent metadata or from the local table by
--      stripe_payment_intent_id).
--
-- refund.created
-- refund.updated
-- refund.failed
--   -> reconcile_refund_event
--      These are the ONLY events that feed reconcile_refund_event.
--      Each represents the lifecycle of a SINGLE Stripe Refund
--      object, which is the granularity reconcile_refund_event
--      expects (one refund row per call).
--
-- charge.refunded
--   -> SUMMARY / RECHECK ONLY. This event fires on the parent
--      charge when its refund total changes. It carries the FULL
--      array of refunds on that charge in payload.data.object.refunds.
--      The webhook router MUST NOT iterate that array into
--      reconcile_refund_event. Doing so would (a) duplicate
--      processing already covered by refund.* events, (b) lose
--      refund.created/updated lifecycle granularity, and (c) on
--      legacy charges produce duplicate stripe_refunds writes
--      that the ON CONFLICT clause would only partially absorb.
--      Treat charge.refunded as a trigger to RE-FETCH each
--      affected refund.id and pass it through the same code path
--      that handles refund.updated, or simply log it for
--      reconciliation reports. Never iterate-into the RPC.
--
-- charge.dispute.created     -> reconcile_dispute_created
-- charge.dispute.updated     -> reconcile_dispute_updated
-- charge.dispute.closed      -> reconcile_dispute_closed
-- radar.early_warning.created -> reconcile_dispute_created
--   (with status='warning_needs_response')
--
-- All event handlers MUST claim_stripe_event FIRST and then call
-- mark_stripe_event_processed (or release_stripe_event_claim_with_error)
-- on the way out. Claim_stripe_event provides the only at-most-
-- once-success guarantee across concurrent webhook deliveries.
--
-- All application_express, application_fee_amount, dispute fee
-- routing, and connected-account fee economics references in this
-- file are derived from Stripe documentation as of Phase 1
-- planning. Live-launch verification is a separate gating item;
-- DO NOT add code or comments here that hard-claim a specific
-- side bears dispute fees, or that the app fee model has been
-- end-to-end-proven.
--
-- ---------------------------------------------------------------------------
-- APPLICATION CONTRACT: PaymentMethod cleanup worker (P0 v6 addendum)
-- ---------------------------------------------------------------------------
-- The cleanup worker MUST follow this exact ordering for every
-- session it processes. Skipping the safety-check step is forbidden.
--
--   1. session_ids, claim_tokens, customer_ids, pm_ids :=
--        claim_payment_method_cleanup_sessions(p_studio_id, batch_size)
--      -> emits 'payment_method_cleanup_attempted' audit per row.
--
--   2. For each claimed session:
--        decision, account, mode, customer, pm :=
--          check_claimed_payment_method_cleanup_safety(session_id, claim_token)
--        -> emits 'payment_method_cleanup_safety_checked' audit
--           with metadata.decision recorded.
--
--   3a. decision = 'skip_detach_pm_in_use':
--          DO NOT call Stripe paymentMethods.detach.
--          mark_session_cleaned(session_id, 'cleaned_pm_in_use',
--                               null, null, claim_token)
--          -> emits 'payment_method_cleanup_succeeded' with
--             metadata.detach_skipped_reason='payment_method_in_use'.
--
--   3b. decision = 'safe_to_detach':
--          Call stripe.paymentMethods.detach(pm, { stripeAccount: account }).
--          On success:
--            mark_session_cleaned(session_id, 'cleaned',
--                                 null, null, claim_token)
--            -> emits 'payment_method_cleanup_succeeded'.
--          On retryable failure:
--            mark_session_cleaned(session_id, 'cleanup_required',
--                                 <error_code>, <error_message>, claim_token)
--            -> emits 'payment_method_cleanup_failed'. The row
--               stays cleanup_required and is immediately
--               re-claimable.
--
-- NO Stripe paymentMethods.detach call may occur without both a
-- matching claim token AND a 'safe_to_detach' decision from the
-- safety-check RPC. The audit timeline reflects every step.
--
-- ---------------------------------------------------------------------------
-- APPLICATION CONTRACT: cleanup retry / crash recovery (FINAL_FIXED #5)
-- ---------------------------------------------------------------------------
-- claim_payment_method_cleanup_sessions intentionally re-claims
-- stale 'detach_authorized' and 'skip_detach_pm_in_use' sessions
-- so cleanup work that was interrupted by a worker crash is not
-- stranded. The retry worker MUST handle the reclaimed durable
-- state correctly:
--
--   * Reclaimed 'detach_authorized':
--       A previous worker decided 'safe_to_detach' and persisted
--       the guard. That worker may or may not have called Stripe
--       paymentMethods.detach before crashing. The retry worker
--       MUST resolve the Stripe-side outcome before writing a
--       terminal local result. Examples of acceptable resolution:
--         - Call stripe.paymentMethods.retrieve(pm) under the
--           connected account; if the PM is no longer attached,
--           detach already succeeded - call
--           mark_session_cleaned(... 'cleaned' ..., new_claim_token).
--         - If still attached, call stripe.paymentMethods.detach
--           idempotently; on success call
--           mark_session_cleaned(... 'cleaned' ...); on retryable
--           failure call mark_session_cleaned(... 'cleanup_required'
--           ..., error_code, error_message, new_claim_token) so
--           the next claim sweep retries.
--       The retry worker MUST NOT clear cleanup_detach_state out
--       of band, and MUST NOT issue any other RPC that would
--       allow finalization against this PaymentMethod while the
--       Stripe-side outcome is unknown. The durable guard remains
--       in force - finalize_card_required_public_booking will
--       continue raising 'payment_method_cleanup_in_progress_or_completed'
--       for the entire window between reclaim and terminal
--       mark_session_cleaned.
--
--   * Reclaimed 'skip_detach_pm_in_use':
--       A previous safety decision determined the PM is still
--       referenced by a finalized appointment_payments row. The
--       retry worker MUST NOT call Stripe and MUST close the
--       session by calling mark_session_cleaned(...
--       'cleaned_pm_in_use', null, null, new_claim_token). The
--       outcome-vs-stored-decision gate on mark_session_cleaned
--       enforces this.
--
--   * Reclaimed 'detach_failed_retryable':
--       The previous detach failed transiently. The reclaim path
--       clears cleanup_detach_state to NULL so the safety check
--       re-evaluates against the current
--       appointment_payments state.
--
-- Until a terminal mark_session_cleaned (cleaned / cleaned_pm_in_use
-- / cleanup_required+retry) is recorded, the PaymentMethod stays
-- finalization-blocked. Worker code MUST NEVER bypass this guard
-- by direct UPDATE on pending_booking_payment_sessions.

-- ===========================================================================
-- Block 2: structural smoke tests (run inside the apply transaction)
-- ===========================================================================
-- These checks raise an exception (aborting the transactional
-- install) if any structural invariant covered by the v2 P0 fixes
-- is missing. They do NOT exercise the runtime money paths; that
-- testing happens against a non-production Stripe account after
-- the migration is applied.
do $block2$
declare
  v_count integer;
  v_def text;
begin
  -- P0 #3 v2: cleanup-claim columns + index on pending_booking_payment_sessions
  perform 1
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'pending_booking_payment_sessions'
     and column_name  in ('cleanup_processing_started_at', 'cleanup_claim_token', 'studio_name_snapshot');
  get diagnostics v_count = row_count;
  if v_count <> 3 then
    raise exception 'Block 2: pending_booking_payment_sessions is missing one of (cleanup_processing_started_at, cleanup_claim_token, studio_name_snapshot)'
      using errcode = '23514';
  end if;
  perform 1 from pg_indexes
   where schemaname = 'public'
     and tablename  = 'pending_booking_payment_sessions'
     and indexname  = 'pending_booking_payment_sessions_cleanup_claim_idx';
  if not found then
    raise exception 'Block 2: cleanup-claim sweep index missing'
      using errcode = '23514';
  end if;

  -- P0 #4 v2: strengthened FKs on stripe_refunds and the lineage
  -- UNIQUE on stripe_refund_attempts.
  perform 1 from pg_constraint
   where conname = 'stripe_refunds_refund_attempt_full_lineage_fk';
  if not found then
    raise exception 'Block 2: stripe_refunds_refund_attempt_full_lineage_fk missing'
      using errcode = '23514';
  end if;
  perform 1 from pg_constraint
   where conname = 'stripe_refund_attempts_full_lineage_unique';
  if not found then
    raise exception 'Block 2: stripe_refund_attempts_full_lineage_unique missing'
      using errcode = '23514';
  end if;

  -- P0 #10 v1 (kept): appointment_payments one-pending-session unique.
  perform 1 from pg_constraint
   where conname = 'appointment_payments_pending_session_unique';
  if not found then
    raise exception 'Block 2: appointment_payments_pending_session_unique missing'
      using errcode = '23514';
  end if;

  -- P0 #3 v2 / P0 #6 v2 / P0 #9 v2: required RPC signatures exist.
  -- claim_payment_method_cleanup_sessions(uuid, integer)
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'claim_payment_method_cleanup_sessions'
     and pg_get_function_identity_arguments(p.oid) = 'p_studio_id uuid, p_batch_size integer';
  if not found then
    raise exception 'Block 2: claim_payment_method_cleanup_sessions(uuid, integer) missing'
      using errcode = '42883';
  end if;
  -- mark_session_cleaned(uuid, text, text, text, uuid)
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_cleaned'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_session_id uuid, p_outcome text, p_error_code text, p_error_message text, p_cleanup_claim_token uuid';
  if not found then
    raise exception 'Block 2: mark_session_cleaned with cleanup-claim-token signature missing'
      using errcode = '42883';
  end if;
  -- start_card_required_booking_session signature now accepts
  -- p_client_id + p_client_created_during_session, NOT email/name/phone.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'start_card_required_booking_session'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_client_id uuid%'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_client_created_during_session boolean%';
  if not found then
    raise exception 'Block 2: start_card_required_booking_session not on the v2 (p_client_id, p_client_created_during_session) signature'
      using errcode = '42883';
  end if;
  -- record_payment_consent_for_session must NOT take p_accepted_at
  -- or p_studio_name_snapshot any more.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'record_payment_consent_for_session'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_session_id uuid, p_policy_version text, p_rendered_consent_text_hash text';
  if not found then
    raise exception 'Block 2: record_payment_consent_for_session is not on the server-set-accepted_at signature'
      using errcode = '42883';
  end if;

  -- P1 v2: display-safe audit RPC must NOT expose error_message
  -- and MUST expose display_message.
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'get_payment_audit_for_appointment'
     and pg_get_function_identity_arguments(p.oid) = 'p_appointment_id uuid, p_studio_id uuid';
  if v_def is null then
    raise exception 'Block 2: get_payment_audit_for_appointment missing'
      using errcode = '42883';
  end if;
  if v_def ilike '%error_message%' then
    raise exception 'Block 2: get_payment_audit_for_appointment still exposes raw error_message'
      using errcode = '42501';
  end if;
  if v_def not ilike '%display_message%' then
    raise exception 'Block 2: get_payment_audit_for_appointment must return display_message column'
      using errcode = '23514';
  end if;

  -- =======================================================================
  -- P0 v3 cleanup-queue unification: signature + return-type checks.
  -- =======================================================================
  -- mark_session_finalization_failed must now be a VOID-returning RPC
  -- (returns NO Stripe identifiers). The v2 RETURNS TABLE form is
  -- replaced because the worker reads identifiers under its claim
  -- token instead.
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_finalization_failed'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_session_id uuid, p_error_code text, p_error_message text';
  if v_def is null then
    raise exception 'Block 2: mark_session_finalization_failed missing'
      using errcode = '42883';
  end if;
  if v_def is distinct from 'void' then
    raise exception 'Block 2: mark_session_finalization_failed must return void (got %); v2 RETURNS TABLE form is forbidden under the v3 unified cleanup queue', v_def
      using errcode = '42883';
  end if;

  -- mark_session_cleaned LOGIC-PATTERN check (P0 v5 #1 fix).
  -- The v4 check `v_def ilike '%''finalization_failed''%'`
  -- self-failed because the function's own explanatory comment
  -- truthfully names the retired legacy status. We replace it
  -- with three pattern proofs that target the actual ACCEPT/REJECT
  -- LOGIC, not the commentary:
  --   (a) The accept-list narrow gate references only
  --       'cleanup_required' (a status equality / IN clause).
  --   (b) The old v2 accept-list which also allowed
  --       'finalization_failed' (the pattern
  --       "status in ('cleanup_required', 'finalization_failed')")
  --       no longer appears in any executable form.
  --   (c) A non-null claim-token equality predicate exists.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_cleaned'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_session_id uuid, p_outcome text, p_error_code text, p_error_message text, p_cleanup_claim_token uuid';
  if v_def is null then
    raise exception 'Block 2: mark_session_cleaned 5-arg signature missing'
      using errcode = '42883';
  end if;
  -- (a) accept-list logic explicitly compares status to 'cleanup_required'.
  if v_def !~* '\mstatus\M[[:space:]]*<>[[:space:]]*''cleanup_required''' then
    raise exception 'Block 2: mark_session_cleaned must restrict accepted source status to cleanup_required (expected: status <> ''cleanup_required'' check)'
      using errcode = '23514';
  end if;
  -- (b) old v2 dual-accept predicate must not appear in code.
  --     Match either ordering of the IN-list values.
  if v_def ~* '\mstatus\M[[:space:]]+in[[:space:]]*\([^)]*''cleanup_required''[^)]*''finalization_failed''[^)]*\)'
     or v_def ~* '\mstatus\M[[:space:]]+in[[:space:]]*\([^)]*''finalization_failed''[^)]*''cleanup_required''[^)]*\)' then
    raise exception 'Block 2: mark_session_cleaned still contains the v2 dual-accept logic (status IN cleanup_required, finalization_failed); v5 unified queue accepts only cleanup_required'
      using errcode = '42501';
  end if;
  -- (c) mandatory claim-token equality predicate.
  if v_def !~* 'cleanup_claim_token[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+p_cleanup_claim_token' then
    raise exception 'Block 2: mark_session_cleaned must enforce a matching non-null cleanup_claim_token (expected: cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token check)'
      using errcode = '23514';
  end if;

  -- consume_payment_recovery_tokens_for_charge_attempt body must
  -- stamp consumed_at (NOT invalidated_at) for successful payment.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'consume_payment_recovery_tokens_for_charge_attempt';
  if v_def is null then
    raise exception 'Block 2: consume_payment_recovery_tokens_for_charge_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mset\M[[:space:]]+\mconsumed_at\M' then
    raise exception 'Block 2: consume_payment_recovery_tokens_for_charge_attempt does not stamp consumed_at on successful payment'
      using errcode = '23514';
  end if;
  if v_def ~* '\mset\M[[:space:]]+\minvalidated_at\M' then
    raise exception 'Block 2: consume_payment_recovery_tokens_for_charge_attempt must NOT set invalidated_at (use consumed_at for successful payment)'
      using errcode = '23514';
  end if;
end
$block2$;

-- ===========================================================================
-- Block 2 (v3) - cleanup-queue structural and body-pattern checks
-- ===========================================================================
-- Goal: detect any drift from the v3 unified-cleanup-queue
-- contract at apply time. Full behavioural smoke tests (which
-- require synthetic studios / clients / services / appointments)
-- live in the APPLICATION CONTRACT smoke-test plan below and run
-- against a non-production Supabase project, NOT inside the
-- install transaction (we refuse to pollute live tables with
-- test data even temporarily).
--
-- This block enforces the following structural rules:
--   * mark_session_finalization_failed returns void AND its body
--     writes status='cleanup_required' (NOT 'finalization_failed').
--   * mark_session_cleaned 5-arg signature exists AND its body
--     does not still mention the legacy 'finalization_failed'
--     source path (covered in the preceding block).
--   * claim_payment_method_cleanup_sessions returns a claim token
--     column.
--
-- Any drift fails the install transaction; ROLLBACK leaves the
-- database untouched.
do $block2_v3$
declare
  v_def text;
begin
  -- mark_session_finalization_failed body must write
  -- status='cleanup_required' (P0 v3 unified queue). The previous
  -- v2 version wrote status='finalization_failed' and returned a
  -- (customer, payment_method) tuple, which left the saved card
  -- outside the retry queue.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_finalization_failed';
  if v_def is null then
    raise exception 'Block 2 v3: mark_session_finalization_failed missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'status[[:space:]]*=[[:space:]]*''cleanup_required''' then
    raise exception 'Block 2 v3: mark_session_finalization_failed must write status=''cleanup_required'' to route saved-PM failures into the unified cleanup queue'
      using errcode = '23514';
  end if;
  if v_def ~* 'status[[:space:]]*=[[:space:]]*''finalization_failed''' then
    raise exception 'Block 2 v3: mark_session_finalization_failed must NOT write status=''finalization_failed'' (saved-PM cleanup must land in the cleanup_required queue)'
      using errcode = '23514';
  end if;

  -- claim_payment_method_cleanup_sessions return type must
  -- include the cleanup claim token output column (used by the
  -- worker to feed mark_session_cleaned).
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'claim_payment_method_cleanup_sessions'
     and pg_get_function_identity_arguments(p.oid) = 'p_studio_id uuid, p_batch_size integer';
  if v_def is null then
    raise exception 'Block 2 v3: claim_payment_method_cleanup_sessions missing or has wrong signature'
      using errcode = '42883';
  end if;
  if v_def not ilike '%out_cleanup_claim_token uuid%' then
    raise exception 'Block 2 v3: claim_payment_method_cleanup_sessions must return out_cleanup_claim_token uuid'
      using errcode = '23514';
  end if;

  raise notice 'Block 2 v3: structural cleanup-queue checks passed. Behavioural smoke tests (T1-T5 below) MUST be run against a non-production Supabase project before any live data flows through this migration.';
end
$block2_v3$;

-- ===========================================================================
-- Block 2 (v4) - serialization, identifier-immutability and retirement
-- ===========================================================================
-- These structural checks enforce the new v4 P0 invariants.
do $block2_v4$
declare
  v_def text;
begin
  -- 1. _recompute_payment_status MUST lock appointment_payments
  --    FOR UPDATE BEFORE reading totals.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = '_recompute_payment_status';
  if v_def is null then
    raise exception 'Block 2 v4: _recompute_payment_status missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mfrom\M[[:space:]]+\mpublic\M\.\mappointment_payments\M[^;]*\mfor[[:space:]]+update\M' then
    raise exception 'Block 2 v4: _recompute_payment_status must FOR UPDATE-lock appointment_payments before reading totals'
      using errcode = '23514';
  end if;

  -- 2. reconcile_payment_intent_by_charge_attempt body MUST check
  --    same-row identifier conflict OUTSIDE a terminal-status
  --    gate. Easiest body-pattern proof: the conflict-detection
  --    audit row must NOT be wrapped under a status-IN-succeeded
  --    branch. We assert the conflict check happens before the
  --    succeeded-branch IF statement by string position.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_payment_intent_by_charge_attempt';
  if v_def is null then
    raise exception 'Block 2 v4: reconcile_payment_intent_by_charge_attempt missing'
      using errcode = '42883';
  end if;
  if position('same_row_identifier_conflict' in v_def) = 0 then
    raise exception 'Block 2 v4: reconcile_payment_intent_by_charge_attempt must emit same_row_identifier_conflict audits'
      using errcode = '23514';
  end if;
  -- The same_row_identifier_conflict text must appear BEFORE the
  -- "if p_status = 'succeeded'" branch label, proving the check
  -- applies in all states (not only terminal success).
  if position('same_row_identifier_conflict' in v_def)
     > position($s$if p_status = 'succeeded' then$s$ in v_def) then
    raise exception 'Block 2 v4: same-row identifier conflict check must run BEFORE the succeeded branch (applies to all states, not only terminal success)'
      using errcode = '23514';
  end if;

  -- 3. reconcile_payment_intent_by_charge_attempt MUST require
  --    both PaymentIntent ID and Charge ID on a succeeded
  --    transition.
  if v_def !~* 'p_payment_intent_id[[:space:]]+is[[:space:]]+null[[:space:]]+or[[:space:]]+p_charge_id[[:space:]]+is[[:space:]]+null' then
    raise exception 'Block 2 v4: reconcile_payment_intent_by_charge_attempt must reject status=succeeded when either p_payment_intent_id or p_charge_id is null'
      using errcode = '23514';
  end if;

  -- 4. _retire_superseded_charge_attempts MUST exist with the
  --    expected signature and be invoked from
  --    reconcile_payment_intent_by_charge_attempt.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = '_retire_superseded_charge_attempts'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_appointment_id uuid, p_studio_id uuid, p_succeeding_attempt_id uuid, p_stripe_account_id text, p_stripe_livemode boolean';
  if not found then
    raise exception 'Block 2 v4: _retire_superseded_charge_attempts(uuid, uuid, uuid, text, boolean) missing'
      using errcode = '42883';
  end if;
  if v_def !~* '_retire_superseded_charge_attempts' then
    raise exception 'Block 2 v4: reconcile_payment_intent_by_charge_attempt must invoke _retire_superseded_charge_attempts after accepted success'
      using errcode = '23514';
  end if;

  -- 5. Block 0.2 normalized-email duplicate preflight must exist.
  --    (We can only assert the do-block by string-searching the
  --    function-source store; instead we re-run the duplicate
  --    query here as a defensive double-check. If duplicates
  --    exist we will already have aborted in Block 0.2; this
  --    block is structurally redundant but cheap.)
  perform 1 from (
    select c.studio_id, lower(trim(c.email)) as norm
    from public.clients c
    where c.email is not null and trim(c.email) <> ''
    group by c.studio_id, lower(trim(c.email))
    having count(*) > 1
  ) dup;
  if found then
    raise exception 'Block 2 v4: normalized-email duplicates detected; Block 0.2 should have caught this earlier'
      using errcode = '23505';
  end if;

  -- 6. Quote-snapshot wording must NOT contain the misleading
  --    'charged up to' phrase in any of our function bodies.
  --    P0 v5 #1 fix: function comments previously included a
  --    "do not phrase as 'you will be charged up to $X'" warning,
  --    which itself contained the forbidden literal and tripped
  --    this check. The function-comment text has been reworded
  --    to use "cap-implying charge language" instead. This grep
  --    is retained as a defensive backstop for future drift.
  select string_agg(p.proname, ', ') into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ilike '%charged up to%';
  if v_def is not null then
    raise exception 'Block 2 v4: stale quote wording ''charged up to'' found in function bodies: %', v_def
      using errcode = '23514';
  end if;
end
$block2_v4$;

-- ===========================================================================
-- Block 2 (v5) - non-regression, lock ordering, truthful cleanup audit,
--                token invalidation on retirement
-- ===========================================================================
do $block2_v5$
declare
  v_def text;
begin
  -- 1. reconcile_payment_intent_by_charge_attempt body must lock
  --    appointment_payments FOR UPDATE before locking the charge
  --    attempt. We assert the substring order: an
  --    "appointment_payments ... for update" clause appears
  --    BEFORE the first "stripe_charge_attempts ... for update"
  --    clause.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_payment_intent_by_charge_attempt';
  if v_def is null then
    raise exception 'Block 2 v5: reconcile_payment_intent_by_charge_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mappointment_payments\M[^;]+\mfor[[:space:]]+update\M' then
    raise exception 'Block 2 v5: reconcile_payment_intent_by_charge_attempt must FOR UPDATE-lock appointment_payments'
      using errcode = '23514';
  end if;
  -- Lock-order assertion: everything up to and including the FIRST
  -- 'for update' clause in the function body must reference
  -- 'appointment_payments'. (This proves the appointment_payments
  -- lock is taken BEFORE any FOR UPDATE on stripe_charge_attempts.)
  declare
    v_first_for_update integer;
  begin
    v_first_for_update := position(lower('for update') in lower(v_def));
    if v_first_for_update = 0 then
      raise exception 'Block 2 v5: reconcile_payment_intent_by_charge_attempt has no FOR UPDATE clause; this is unexpected'
        using errcode = '23514';
    end if;
    if lower(substring(v_def from 1 for v_first_for_update + length('for update')))
       not like '%appointment_payments%' then
      raise exception 'Block 2 v5: reconcile_payment_intent_by_charge_attempt must lock appointment_payments BEFORE the target charge attempt row (lock-order violation invites deadlock)'
        using errcode = '23514';
    end if;
  end;

  -- 2. reconcile_refund_event body must enforce
  --    succeeded-never-regresses. Look for the explicit
  --    stale_event_ignored branch and the
  --    'refund_stale_ignored' audit action.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_refund_event';
  if v_def is null then
    raise exception 'Block 2 v5: reconcile_refund_event missing'
      using errcode = '42883';
  end if;
  if v_def !~* '''refund_stale_ignored''' then
    raise exception 'Block 2 v5: reconcile_refund_event must emit refund_stale_ignored audit on succeeded-never-regresses path'
      using errcode = '23514';
  end if;
  if v_def !~* '\mv_existing_refund\.status\M[[:space:]]*=[[:space:]]*''succeeded''[[:space:]]+and[[:space:]]+p_status[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+''succeeded''' then
    raise exception 'Block 2 v5: reconcile_refund_event must reject any non-succeeded incoming status when the stored refund row is already succeeded'
      using errcode = '23514';
  end if;

  -- 3. Dispute RPCs must enforce terminal non-regression and
  --    return a structured outcome (TEXT). Verify each returns
  --    text and the body emits 'dispute_stale_ignored'.
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname in ('reconcile_dispute_created',
                        'reconcile_dispute_updated',
                        'reconcile_dispute_closed')
  loop
    if v_def !~* '''dispute_stale_ignored''' then
      raise exception 'Block 2 v5: dispute reconcile RPC bodies must emit dispute_stale_ignored on terminal-state regression'
        using errcode = '23514';
    end if;
  end loop;
  -- And the action CHECK constraint must permit
  -- 'dispute_stale_ignored' and 'refund_stale_ignored' and
  -- 'payment_method_cleanup_queued'.
  select string_agg(quote_literal(con.conname), ', ') into v_def
  from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'stripe_payment_audit'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%''dispute_stale_ignored''%'
    and pg_get_constraintdef(con.oid) ilike '%''refund_stale_ignored''%'
    and pg_get_constraintdef(con.oid) ilike '%''payment_method_cleanup_queued''%';
  if v_def is null then
    raise exception 'Block 2 v5: stripe_payment_audit.action CHECK must permit dispute_stale_ignored, refund_stale_ignored, payment_method_cleanup_queued'
      using errcode = '23514';
  end if;

  -- 4. reconcile_setup_intent_succeeded must NOT emit
  --    'payment_method_cleanup_attempted'. The queue-vs-attempt
  --    distinction means SetupIntent queueing emits
  --    'payment_method_cleanup_queued' instead.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_setup_intent_succeeded';
  if v_def is null then
    raise exception 'Block 2 v5: reconcile_setup_intent_succeeded missing'
      using errcode = '42883';
  end if;
  if v_def ~* '''payment_method_cleanup_attempted''' then
    raise exception 'Block 2 v5: reconcile_setup_intent_succeeded must not emit payment_method_cleanup_attempted (queueing emits payment_method_cleanup_queued; the attempted audit belongs to claim_payment_method_cleanup_sessions)'
      using errcode = '23514';
  end if;
  if v_def !~* '''payment_method_cleanup_queued''' then
    raise exception 'Block 2 v5: reconcile_setup_intent_succeeded must emit payment_method_cleanup_queued on cleanup-routing branches'
      using errcode = '23514';
  end if;

  -- 5. claim_payment_method_cleanup_sessions must continue to be
  --    the SOLE emitter of payment_method_cleanup_attempted.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'claim_payment_method_cleanup_sessions';
  if v_def is null then
    raise exception 'Block 2 v5: claim_payment_method_cleanup_sessions missing'
      using errcode = '42883';
  end if;
  if v_def !~* '''payment_method_cleanup_attempted''' then
    raise exception 'Block 2 v5: claim_payment_method_cleanup_sessions must emit payment_method_cleanup_attempted on every claimed row'
      using errcode = '23514';
  end if;

  -- 6. _retire_superseded_charge_attempts must invalidate
  --    (NOT consume) any open payment_recovery_tokens rows for
  --    retired attempts.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = '_retire_superseded_charge_attempts';
  if v_def is null then
    raise exception 'Block 2 v5: _retire_superseded_charge_attempts missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mupdate\M[[:space:]]+public\.payment_recovery_tokens\M[^;]+\minvalidated_at\M[[:space:]]*=[[:space:]]*now\(\)' then
    raise exception 'Block 2 v5: _retire_superseded_charge_attempts must set payment_recovery_tokens.invalidated_at on retired attempts'
      using errcode = '23514';
  end if;
  -- Defensive: must NOT set consumed_at on retired attempts.
  -- (consumed_at is reserved for successful payment completion;
  -- a retired attempt's open token was never successfully used.)
  if v_def ~* '\mupdate\M[[:space:]]+public\.payment_recovery_tokens\M[^;]+\mconsumed_at\M[[:space:]]*=[[:space:]]*now\(\)' then
    raise exception 'Block 2 v5: _retire_superseded_charge_attempts must NOT set consumed_at (use invalidated_at; consumed_at is reserved for successful authenticated payment)'
      using errcode = '23514';
  end if;

  raise notice 'Block 2 v5: non-regression, lock-order, truthful cleanup audit, and retirement-token-invalidation checks passed. Behavioural smoke tests T12-T18 below MUST be run against a non-production Supabase project before live data flows.';
end
$block2_v5$;

-- ===========================================================================
-- Block 2 (v6) - cleanup safety, refund/dispute identity immutability,
--                refund-reconcile lock order, card-required preflight,
--                strict client helper, expire_pending_sessions PII reduction
-- ===========================================================================
do $block2_v6$
declare
  v_def text;
begin
  -- 1. check_claimed_payment_method_cleanup_safety RPC exists
  --    with the expected signature and is service_role-only.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'check_claimed_payment_method_cleanup_safety'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_session_id uuid, p_cleanup_claim_token uuid';
  if not found then
    raise exception 'Block 2 v6: check_claimed_payment_method_cleanup_safety(uuid, uuid) missing'
      using errcode = '42883';
  end if;

  -- 2. action CHECK constraint includes refund_identifier_conflict,
  --    dispute_identifier_conflict, payment_method_cleanup_safety_checked.
  select string_agg(quote_literal(con.conname), ', ') into v_def
  from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'stripe_payment_audit'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%''refund_identifier_conflict''%'
    and pg_get_constraintdef(con.oid) ilike '%''dispute_identifier_conflict''%'
    and pg_get_constraintdef(con.oid) ilike '%''payment_method_cleanup_safety_checked''%';
  if v_def is null then
    raise exception 'Block 2 v6: stripe_payment_audit.action CHECK must permit refund_identifier_conflict, dispute_identifier_conflict, payment_method_cleanup_safety_checked'
      using errcode = '23514';
  end if;

  -- 3. reconcile_refund_event body must contain the identity
  --    immutability check (refund_identifier_conflict) and the
  --    attempt-level Refund ID immutability check.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_refund_event';
  if v_def is null then
    raise exception 'Block 2 v6: reconcile_refund_event missing'
      using errcode = '42883';
  end if;
  if v_def !~* '''refund_identifier_conflict''' then
    raise exception 'Block 2 v6: reconcile_refund_event must emit refund_identifier_conflict audit on lineage mismatch'
      using errcode = '23514';
  end if;
  if v_def !~* 'attempt_refund_id_immutable' then
    raise exception 'Block 2 v6: reconcile_refund_event must contain attempt-level Refund ID immutability check'
      using errcode = '23514';
  end if;
  -- And lock order: appointment_payments lock must precede any
  -- stripe_refunds row mutation. Verified by checking that the
  -- function body contains a FOR UPDATE on appointment_payments
  -- BEFORE any reference to stripe_refunds.
  declare
    v_pos_appointment integer;
    v_pos_refunds integer;
  begin
    v_pos_appointment := position(lower('appointment_payments ap') in lower(v_def));
    v_pos_refunds := position(lower('stripe_refunds sr') in lower(v_def));
    if v_pos_appointment = 0
       or v_pos_refunds = 0
       or v_pos_appointment >= v_pos_refunds then
      raise exception 'Block 2 v6: reconcile_refund_event must lock appointment_payments BEFORE touching stripe_refunds'
        using errcode = '23514';
    end if;
  end;

  -- 4. create_or_claim_refund_attempt must lock appointment_payments
  --    BEFORE the target charge attempt (same lock order as
  --    reconcile_refund_event to avoid deadlock).
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'create_or_claim_refund_attempt';
  if v_def is null then
    raise exception 'Block 2 v6: create_or_claim_refund_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mappointment_payments\M[^;]+\mfor[[:space:]]+update\M' then
    raise exception 'Block 2 v6: create_or_claim_refund_attempt must FOR UPDATE-lock appointment_payments'
      using errcode = '23514';
  end if;
  declare
    v_first_for_update integer;
  begin
    v_first_for_update := position(lower('for update') in lower(v_def));
    if v_first_for_update = 0
       or lower(substring(v_def from 1 for v_first_for_update + length('for update')))
          not like '%appointment_payments%' then
      raise exception 'Block 2 v6: create_or_claim_refund_attempt must lock appointment_payments BEFORE the target charge attempt'
        using errcode = '23514';
    end if;
  end;

  -- 5. resolve_double_charge_incident must lock appointment_payments
  --    first.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'resolve_double_charge_incident';
  if v_def is null then
    raise exception 'Block 2 v6: resolve_double_charge_incident missing'
      using errcode = '42883';
  end if;
  declare
    v_first_for_update integer;
  begin
    v_first_for_update := position(lower('for update') in lower(v_def));
    if v_first_for_update = 0
       or lower(substring(v_def from 1 for v_first_for_update + length('for update')))
          not like '%appointment_payments%' then
      raise exception 'Block 2 v6: resolve_double_charge_incident must lock appointment_payments BEFORE the duplicate charge attempt'
        using errcode = '23514';
    end if;
  end;

  -- 6. All three dispute RPCs must emit dispute_identifier_conflict.
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname in ('reconcile_dispute_created',
                        'reconcile_dispute_updated',
                        'reconcile_dispute_closed')
  loop
    if v_def !~* '''dispute_identifier_conflict''' then
      raise exception 'Block 2 v6: all dispute reconcile RPCs must emit dispute_identifier_conflict on lineage mismatch'
        using errcode = '23514';
    end if;
  end loop;

  -- 7. reconcile_dispute_updated / _closed signatures must now
  --    include p_charge_id (text) so the Charge can be verified.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_dispute_updated'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_charge_id text%'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_amount_cents integer%'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_currency text%';
  if not found then
    raise exception 'Block 2 v6: reconcile_dispute_updated signature must include p_charge_id, p_amount_cents, p_currency for identity verification'
      using errcode = '42883';
  end if;
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_dispute_closed'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_charge_id text%'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_amount_cents integer%'
     and pg_get_function_identity_arguments(p.oid) ilike '%p_currency text%';
  if not found then
    raise exception 'Block 2 v6: reconcile_dispute_closed signature must include p_charge_id, p_amount_cents, p_currency for identity verification'
      using errcode = '42883';
  end if;

  -- 8. start_card_required_booking_session must contain explicit
  --    preflight checks for require_card_on_file, charges_enabled,
  --    service.active, practitioner.active, and a non-blank email
  --    on the client.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'start_card_required_booking_session';
  if v_def is null then
    raise exception 'Block 2 v6: start_card_required_booking_session missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'require_card_on_file' then
    raise exception 'Block 2 v6: start_card_required_booking_session must check studio_payment_settings.require_card_on_file'
      using errcode = '23514';
  end if;
  if v_def !~* 'stripe_charges_enabled' then
    raise exception 'Block 2 v6: start_card_required_booking_session must check stripe_charges_enabled'
      using errcode = '23514';
  end if;
  if v_def !~* '\ms\.active\M[[:space:]]*=[[:space:]]*true' then
    raise exception 'Block 2 v6: start_card_required_booking_session must verify service.active = true'
      using errcode = '23514';
  end if;
  if v_def !~* '\mpr\.active\M[[:space:]]*=[[:space:]]*true' then
    raise exception 'Block 2 v6: start_card_required_booking_session must verify practitioner.active = true'
      using errcode = '23514';
  end if;
  if v_def !~* '\mc\.normalized_email\M[[:space:]]+is[[:space:]]+not[[:space:]]+null' then
    raise exception 'Block 2 v6: start_card_required_booking_session must require non-null normalized_email on the client (card-required path)'
      using errcode = '23514';
  end if;

  -- 9. Strict client identity helper for card-required path exists.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'find_or_create_client_for_booking_payment_strict'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_studio_id uuid, p_email text, p_name text, p_phone text';
  if not found then
    raise exception 'Block 2 v6: find_or_create_client_for_booking_payment_strict(uuid, text, text, text) missing'
      using errcode = '42883';
  end if;

  -- 10. expire_pending_sessions return type must NOT expose Stripe
  --     Customer or PaymentMethod identifiers any more.
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'expire_pending_sessions'
     and pg_get_function_identity_arguments(p.oid) = 'p_studio_id uuid';
  if v_def is null then
    raise exception 'Block 2 v6: expire_pending_sessions missing'
      using errcode = '42883';
  end if;
  if v_def ilike '%stripe_customer_id%' or v_def ilike '%stripe_payment_method_id%' then
    raise exception 'Block 2 v6: expire_pending_sessions return type must NOT expose Stripe Customer / PaymentMethod identifiers (cleanup goes through claim sweep)'
      using errcode = '23514';
  end if;

  raise notice 'Block 2 v6: cleanup safety, refund/dispute identity, refund-lock-order, card-required preflight, strict client helper, and PII-reduction checks passed. Behavioural smoke tests T19-T24 MUST be run against a non-production Supabase project before live data flows.';
end
$block2_v6$;

-- ===========================================================================
-- Block 2 (v7) - authentication_required PI required, session ID structural
--                integrity, durable detach guard, exact duration, finalize
--                re-checks, refund-ID ordering, double-charge tentative
--                resolution, strict-email in customer provisioning, and
--                display-safe dispute output
-- ===========================================================================
do $block2_v7$
declare
  v_def text;
  v_count integer;
begin
  -- 1. reconcile_payment_intent_by_charge_attempt body must reject
  --    authentication_required when p_payment_intent_id is null.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_payment_intent_by_charge_attempt';
  if v_def is null then
    raise exception 'Block 2 v7: reconcile_payment_intent_by_charge_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'p_payment_intent_id[[:space:]]+is[[:space:]]+required[[:space:]]+for[[:space:]]+authentication_required' then
    raise exception 'Block 2 v7: reconcile_payment_intent_by_charge_attempt must reject authentication_required with null p_payment_intent_id'
      using errcode = '23514';
  end if;

  -- 2. pending_booking_payment_sessions structural checks for SI
  --    and PM IDs at the right statuses, plus the new
  --    cleanup_detach_state and duration-equality constraints.
  perform 1 from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'pending_booking_payment_sessions'
     and con.conname = 'pending_booking_payment_sessions_si_required_check';
  if not found then
    raise exception 'Block 2 v7: pending_booking_payment_sessions_si_required_check missing'
      using errcode = '23514';
  end if;
  perform 1 from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'pending_booking_payment_sessions'
     and con.conname = 'pending_booking_payment_sessions_pm_required_check';
  if not found then
    raise exception 'Block 2 v7: pending_booking_payment_sessions_pm_required_check missing'
      using errcode = '23514';
  end if;
  perform 1 from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'pending_booking_payment_sessions'
     and con.conname = 'pending_booking_payment_sessions_duration_exact_check';
  if not found then
    raise exception 'Block 2 v7: pending_booking_payment_sessions_duration_exact_check missing'
      using errcode = '23514';
  end if;
  perform 1 from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'pending_booking_payment_sessions'
     and con.conname = 'pending_booking_payment_sessions_range_positive_check';
  if not found then
    raise exception 'Block 2 v7: pending_booking_payment_sessions_range_positive_check missing'
      using errcode = '23514';
  end if;

  -- 3. New cleanup-detach columns and the durable guard plumbing.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'pending_booking_payment_sessions'
    and column_name in ('cleanup_detach_state', 'cleanup_detach_decided_at', 'cleanup_detached_at');
  if v_count <> 3 then
    raise exception 'Block 2 v7: pending_booking_payment_sessions missing one of cleanup_detach_state / cleanup_detach_decided_at / cleanup_detached_at (got %)', v_count
      using errcode = '23514';
  end if;
  -- _acquire_payment_method_tuple_xact_lock helper must exist.
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = '_acquire_payment_method_tuple_xact_lock'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_studio_id uuid, p_client_id uuid, p_stripe_account_id text, p_stripe_livemode boolean, p_stripe_customer_id text, p_stripe_payment_method_id text';
  if not found then
    raise exception 'Block 2 v7: _acquire_payment_method_tuple_xact_lock missing'
      using errcode = '42883';
  end if;
  -- check_claimed_payment_method_cleanup_safety body must invoke
  -- the advisory-lock helper AND must write cleanup_detach_state.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'check_claimed_payment_method_cleanup_safety';
  if v_def is null
     or v_def !~* '_acquire_payment_method_tuple_xact_lock'
     or v_def !~* 'cleanup_detach_state[[:space:]]*=' then
    raise exception 'Block 2 v7: check_claimed_payment_method_cleanup_safety must take the PM-tuple advisory lock AND persist cleanup_detach_state'
      using errcode = '23514';
  end if;
  -- finalize_card_required_public_booking body must invoke the
  -- advisory-lock helper AND check cleanup_detach_state.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'finalize_card_required_public_booking';
  if v_def is null
     or v_def !~* '_acquire_payment_method_tuple_xact_lock'
     or v_def !~* 'cleanup_detach_state'
     or v_def !~* 'payment_method_cleanup_in_progress_or_completed' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must acquire the PM-tuple lock AND refuse on persisted cleanup_detach_state'
      using errcode = '23514';
  end if;
  -- mark_session_cleaned body must enforce
  -- decision-vs-outcome consistency.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_cleaned';
  if v_def is null
     or v_def !~* 'cleaned_pm_in_use[^;]+requires[[:space:]]+cleanup_detach_state=skip_detach_pm_in_use'
     or v_def !~* 'cleaned/cleanup_required[^;]+requires[[:space:]]+cleanup_detach_state=detach_authorized' then
    raise exception 'Block 2 v7: mark_session_cleaned must enforce outcome-vs-cleanup_detach_state consistency'
      using errcode = '23514';
  end if;

  -- 4. finalize_card_required_public_booking body must re-check
  --    service.active, practitioner.active, require_card_on_file,
  --    stripe_charges_enabled, AND the duration-equality.
  if v_def !~* '_acquire_payment_method_tuple_xact_lock'
     or v_def !~* 'cleanup_detach_state' then
    -- (already covered above; placeholder ensures we hit the
    -- subsequent finalize-specific checks against v_def from the
    -- finalize body, not mark_session_cleaned.)
    null;
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'finalize_card_required_public_booking';
  if v_def !~* 's\.active[[:space:]]*=[[:space:]]*true' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must re-check service.active'
      using errcode = '23514';
  end if;
  if v_def !~* 'pr\.active[[:space:]]*=[[:space:]]*true' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must re-check practitioner.active'
      using errcode = '23514';
  end if;
  if v_def !~* 'require_card_on_file' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must re-check require_card_on_file'
      using errcode = '23514';
  end if;
  if v_def !~* 'stripe_charges_enabled' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must re-check stripe_charges_enabled'
      using errcode = '23514';
  end if;
  if v_def !~* 'make_interval\(mins[[:space:]]*=>[[:space:]]*v_session\.requested_duration_minutes\)' then
    raise exception 'Block 2 v7: finalize_card_required_public_booking must re-check duration-equality of session time range'
      using errcode = '23514';
  end if;

  -- 5. reconcile_refund_event body must persist stripe_refund_id
  --    on a candidate Hone refund attempt ONLY after the
  --    existing-row identity check and Hone-link-conflict branch
  --    have already returned without mutation. We verify by
  --    string-position against EXECUTABLE anchors (NOT
  --    developer-comment text), so a later edit that removes a
  --    comment cannot trip this check spuriously.
  select lower(pg_get_functiondef(p.oid))
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname = 'reconcile_refund_event';
  if v_def is null then
    raise exception 'Block 2 v7: reconcile_refund_event function missing'
      using errcode = '23514';
  end if;
  if position('existing_refund_lineage_mismatch' in v_def) = 0
     or position('return query select false, ''refund_attempt_link_conflict''::text' in v_def) = 0
     or position('update public.stripe_refund_attempts sra' in v_def) = 0 then
    raise exception 'Block 2 v7: reconcile_refund_event verification anchors missing'
      using errcode = '23514';
  end if;
  if position('update public.stripe_refund_attempts sra' in v_def)
       < position('return query select false, ''refund_attempt_link_conflict''::text' in v_def) then
    raise exception 'Block 2 v7: reconcile_refund_event persists stripe_refund_id before Hone-link identity conflict is ruled out'
      using errcode = '23514';
  end if;
  if position('update public.stripe_refund_attempts sra' in v_def)
       < position('existing_refund_lineage_mismatch' in v_def) then
    raise exception 'Block 2 v7: reconcile_refund_event persists stripe_refund_id before existing refund lineage validation'
      using errcode = '23514';
  end if;

  -- 6. resolve_double_charge_incident body must REVERT the
  --    tentative resolution write on a recompute_returned_unexpected_status
  --    path and emit only the failure audit, NOT 'double_charge_resolved'.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'resolve_double_charge_incident';
  if v_def is null then
    raise exception 'Block 2 v7: resolve_double_charge_incident missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'tentative_resolution_reverted' then
    raise exception 'Block 2 v7: resolve_double_charge_incident must revert tentative resolution fields when recompute returns an unexpected status'
      using errcode = '23514';
  end if;
  if v_def !~* 'duplicate_resolved_at[[:space:]]*=[[:space:]]*null' then
    raise exception 'Block 2 v7: resolve_double_charge_incident must set duplicate_resolved_at = null on revert'
      using errcode = '23514';
  end if;

  -- 7. create_or_claim_stripe_customer_provisioning body must
  --    require the client's normalized_email is non-null.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'create_or_claim_stripe_customer_provisioning';
  if v_def is null then
    raise exception 'Block 2 v7: create_or_claim_stripe_customer_provisioning missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'c\.normalized_email[[:space:]]+is[[:space:]]+not[[:space:]]+null' then
    raise exception 'Block 2 v7: create_or_claim_stripe_customer_provisioning must require non-null normalized_email on the client'
      using errcode = '23514';
  end if;

  -- 8. get_disputes_for_studio return type must NOT include
  --    stripe_dispute_id (raw Stripe ID).
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'get_disputes_for_studio'
     and pg_get_function_identity_arguments(p.oid) = 'p_studio_id uuid';
  if v_def is null then
    raise exception 'Block 2 v7: get_disputes_for_studio missing'
      using errcode = '42883';
  end if;
  if v_def ilike '%stripe_dispute_id%' then
    raise exception 'Block 2 v7: get_disputes_for_studio return type must NOT expose stripe_dispute_id (raw Stripe ID is server-side only)'
      using errcode = '23514';
  end if;

  -- 9. mark_session_setup_intent_created and
  --    mark_session_payment_method_saved must reject null/blank
  --    input IDs.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_setup_intent_created';
  if v_def is null
     or v_def !~* 'p_stripe_setup_intent_id[[:space:]]+is[[:space:]]+required[[:space:]]+and[[:space:]]+must[[:space:]]+be[[:space:]]+non-blank' then
    raise exception 'Block 2 v7: mark_session_setup_intent_created must reject null/blank SetupIntent ID'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'mark_session_payment_method_saved';
  if v_def is null
     or v_def !~* 'p_stripe_payment_method_id[[:space:]]+is[[:space:]]+required[[:space:]]+and[[:space:]]+must[[:space:]]+be[[:space:]]+non-blank'
     or v_def !~* 'no[[:space:]]+stored[[:space:]]+SetupIntent' then
    raise exception 'Block 2 v7: mark_session_payment_method_saved must reject null/blank PaymentMethod ID AND require stored SetupIntent'
      using errcode = '23514';
  end if;

  -- 10. start_card_required_booking_session body must enforce
  --     exact duration-equality on the input range.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'start_card_required_booking_session';
  if v_def is null
     or v_def !~* 'make_interval\(mins[[:space:]]*=>[[:space:]]*p_requested_duration_minutes\)' then
    raise exception 'Block 2 v7: start_card_required_booking_session must enforce exact duration-equality (end = start + duration mins)'
      using errcode = '23514';
  end if;

  raise notice 'Block 2 v7: PI-required, session-ID structural integrity, durable detach guard, exact-duration, finalize re-checks, refund-ID ordering, tentative-resolution revert, strict-email customer provisioning, and display-safe dispute output checks passed. Behavioural smoke tests T25-T34 MUST be run against a non-production Supabase project before live data flows.';
end
$block2_v7$;

-- ===========================================================================
-- Block 2 (FINAL) - cleanup-state CHECK fix, claim re-eligibility,
--                   reconcile_refund_event FOUND-safe branching, and
--                   refund/dispute currency identity
-- ===========================================================================
do $block2_FINAL$
declare
  v_def text;
  v_allowed text;
begin
  -- 1. Table CHECK on cleanup_detach_state must permit
  --    'detach_authorized' AND NOT contain the broken
  --    'safe_to_detach' literal (which is the worker return
  --    vocabulary, never the persisted vocabulary).
  select pg_get_constraintdef(con.oid) into v_allowed
  from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'pending_booking_payment_sessions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%cleanup_detach_state%'
  limit 1;
  if v_allowed is null then
    raise exception 'Block 2 FINAL: no CHECK constraint on cleanup_detach_state found'
      using errcode = '23514';
  end if;
  if v_allowed not ilike '%''detach_authorized''%' then
    raise exception 'Block 2 FINAL: cleanup_detach_state CHECK must permit ''detach_authorized'''
      using errcode = '23514';
  end if;
  if v_allowed ilike '%''safe_to_detach''%' then
    raise exception 'Block 2 FINAL: cleanup_detach_state CHECK must NOT contain ''safe_to_detach'' (worker-return vocabulary, never persisted)'
      using errcode = '23514';
  end if;

  -- 2. check_claimed_payment_method_cleanup_safety body must
  --    persist 'detach_authorized' on the safe-to-detach branch
  --    (NOT 'safe_to_detach'), while continuing to return
  --    'safe_to_detach' to the worker. We assert both: the
  --    function contains the literal 'detach_authorized' near a
  --    cleanup_detach_state assignment, AND it still returns
  --    'safe_to_detach' as part of its return-query.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'check_claimed_payment_method_cleanup_safety';
  if v_def is null then
    raise exception 'Block 2 FINAL: check_claimed_payment_method_cleanup_safety missing'
      using errcode = '42883';
  end if;
  if v_def !~* '''detach_authorized''' then
    raise exception 'Block 2 FINAL: check_claimed_payment_method_cleanup_safety must persist ''detach_authorized'' on the safe-to-detach branch'
      using errcode = '23514';
  end if;
  if v_def !~* '''safe_to_detach''' then
    raise exception 'Block 2 FINAL: check_claimed_payment_method_cleanup_safety must still return ''safe_to_detach'' to the worker'
      using errcode = '23514';
  end if;

  -- 3. claim_payment_method_cleanup_sessions body must enable
  --    crash-recovery re-claim of stale 'detach_authorized' and
  --    stale 'skip_detach_pm_in_use', and must NOT re-claim
  --    'detached'.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'claim_payment_method_cleanup_sessions';
  if v_def is null then
    raise exception 'Block 2 FINAL: claim_payment_method_cleanup_sessions missing'
      using errcode = '42883';
  end if;
  -- Eligibility filter must mention all three reclaimable states
  -- (NULL/fresh, detach_failed_retryable for reset semantics,
  -- detach_authorized and skip_detach_pm_in_use for crash recovery).
  -- We assert via the exclusion-of-detached pattern.
  if v_def !~* 'cleanup_detach_state[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+''detached''' then
    raise exception 'Block 2 FINAL: claim_payment_method_cleanup_sessions must exclude only ''detached'' (must allow re-claim of detach_authorized and skip_detach_pm_in_use)'
      using errcode = '23514';
  end if;
  -- Re-claim must preserve detach_authorized (no reset to null
  -- for that state); only detach_failed_retryable is reset.
  if v_def !~* 'when[[:space:]]+pps\.cleanup_detach_state[[:space:]]*=[[:space:]]*''detach_failed_retryable''' then
    raise exception 'Block 2 FINAL: claim_payment_method_cleanup_sessions must reset cleanup_detach_state ONLY for detach_failed_retryable'
      using errcode = '23514';
  end if;

  -- 4. reconcile_refund_event body must branch on
  --    v_refund_row_existed_before (the saved boolean), NOT on
  --    PL/pgSQL FOUND, when deciding insert vs update of the
  --    stripe_refunds row.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_refund_event';
  if v_def is null then
    raise exception 'Block 2 FINAL: reconcile_refund_event missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'if[[:space:]]+not[[:space:]]+v_refund_row_existed_before[[:space:]]+then' then
    raise exception 'Block 2 FINAL: reconcile_refund_event must branch insert/update on v_refund_row_existed_before (NOT on FOUND, which the prior UPDATE on stripe_refund_attempts overwrites)'
      using errcode = '23514';
  end if;

  -- 5. Currency identity check exists in refund + all three
  --    dispute RPCs.
  if v_def !~* 'refund_currency_mismatch' then
    raise exception 'Block 2 FINAL: reconcile_refund_event must enforce refund currency identity against the original charge'
      using errcode = '23514';
  end if;
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname in ('reconcile_dispute_created',
                        'reconcile_dispute_updated',
                        'reconcile_dispute_closed')
  loop
    if v_def !~* 'dispute_currency_mismatch' then
      raise exception 'Block 2 FINAL: all three dispute reconcile RPCs must enforce dispute currency identity against the original charge'
        using errcode = '23514';
    end if;
    if v_def !~* 'v1_required_currency' then
      raise exception 'Block 2 FINAL: dispute reconcile RPCs must record the V1 required currency in the conflict audit metadata'
        using errcode = '23514';
    end if;
  end loop;

  raise notice 'Block 2 FINAL: cleanup-state CHECK fix, claim re-eligibility (incl crash recovery), FOUND-safe refund branching, and refund/dispute currency identity checks passed. Behavioural smoke tests T35-T39 MUST be run against a non-production Supabase project before live data flows.';
end
$block2_FINAL$;

-- ===========================================================================
-- Block 2 (FINAL_FIXED) - non-mutating refund link conflict, owner-refund
--                        state gate, blank-Stripe-ID rejection in completion
--                        RPCs, and tightened double-charge-remaining branch
-- ===========================================================================
do $block2_FINAL_FIXED$
declare
  v_def text;
  v_def_exec text;
  v_link_branch_body text;
  v_link_branch_start integer;
  v_link_branch_end integer;
begin
  -- 1. reconcile_refund_event: existing-Hone-link conflict branch
  --    must be NON-MUTATING. Load the function body into v_def,
  --    strip SQL line comments into v_def_exec, slice the elsif
  --    Hone-link conflict branch body, and assert against the
  --    executable text only.
  --
  --    Why the comment strip is essential: pg_get_functiondef
  --    returns the function body including comments. Truthful
  --    explanatory comments inside the link-conflict branch that
  --    reference the rejected old behaviour (literal 'refund_failed')
  --    used to trip an earlier version of this check, even though
  --    the executable audit action is 'refund_identifier_conflict'.
  --    All FINAL_FIXED check-1 assertions therefore inspect
  --    v_def_exec (comment-stripped), never v_def.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'reconcile_refund_event';
  if v_def is null then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event missing'
      using errcode = '42883';
  end if;
  -- Strip every SQL line comment ("--" to end of line). The
  -- function body contains no string literals that include "--",
  -- so this is safe.
  v_def_exec := regexp_replace(v_def, '--[^\n]*', '', 'g');

  -- Slice the elsif Hone-link conflict branch out of v_def_exec.
  -- Start anchor: the unique elsif label
  --   `elsif v_existing_refund.source = 'hone_initiated'`
  -- End anchor: the unique link-conflict return statement
  --   `return query select false, 'refund_attempt_link_conflict'::text;`
  -- Both occur exactly once in the executable function body, so
  -- this slice is unambiguous.
  v_link_branch_start := position('elsif v_existing_refund.source = ''hone_initiated''' in v_def_exec);
  v_link_branch_end := position('return query select false, ''refund_attempt_link_conflict''::text;' in v_def_exec);
  if v_link_branch_start = 0
     or v_link_branch_end = 0
     or v_link_branch_end <= v_link_branch_start then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch anchors missing or out of order'
      using errcode = '23514';
  end if;
  v_link_branch_body := substring(
    v_def_exec
    from v_link_branch_start
    for (v_link_branch_end - v_link_branch_start)
        + length('return query select false, ''refund_attempt_link_conflict''::text;')
  );

  -- Slice integrity: the jsonb_build_object metadata key for this
  -- branch must be present in the slice. Proves the slice actually
  -- covers the link-conflict branch and not a degenerate region.
  if position('existing_hone_refund_link_conflicts_with_incoming_metadata' in v_link_branch_body) = 0 then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch must reference metadata key existing_hone_refund_link_conflicts_with_incoming_metadata'
      using errcode = '23514';
  end if;

  -- Executable audit action must be 'refund_identifier_conflict'.
  if position('''refund_identifier_conflict''' in v_link_branch_body) = 0 then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch must emit refund_identifier_conflict audit action'
      using errcode = '23514';
  end if;

  -- Executable audit action MUST NOT be 'refund_failed' in this
  -- branch.
  if position('''refund_failed''' in v_link_branch_body) > 0 then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch must NOT emit refund_failed audit (use refund_identifier_conflict)'
      using errcode = '23514';
  end if;

  -- Branch MUST NOT mutate the Stripe Refund ledger row.
  if v_link_branch_body ~* 'update[[:space:]]+public\.stripe_refunds\M' then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch must be NON-MUTATING (no update on public.stripe_refunds before return)'
      using errcode = '23514';
  end if;

  -- Branch MUST NOT mutate the candidate Hone refund-attempt row
  -- (a prior version left stripe_refunds unchanged but still
  -- poisoned the candidate stripe_refund_attempts row with the
  -- incoming Refund ID before the conflict was ruled out).
  if v_link_branch_body ~* 'update[[:space:]]+public\.stripe_refund_attempts\M' then
    raise exception 'Block 2 FINAL_FIXED: reconcile_refund_event Hone-link conflict branch must be NON-MUTATING (no update on public.stripe_refund_attempts before return)'
      using errcode = '23514';
  end if;

  -- 2. create_or_claim_refund_attempt must gate by
  --    appointment_payments.payment_status. The body must load
  --    the row into v_payment and contain the four explicit
  --    state checks against payment_status.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'create_or_claim_refund_attempt';
  if v_def is null then
    raise exception 'Block 2 FINAL_FIXED: create_or_claim_refund_attempt missing'
      using errcode = '42883';
  end if;
  if v_def !~* '\mv_payment\M[[:space:]]+public\.appointment_payments%rowtype' then
    raise exception 'Block 2 FINAL_FIXED: create_or_claim_refund_attempt must load appointment_payments into v_payment under the financial-root lock'
      using errcode = '23514';
  end if;
  if v_def !~* 'v_payment\.payment_status[[:space:]]*=[[:space:]]*''charged''' then
    raise exception 'Block 2 FINAL_FIXED: create_or_claim_refund_attempt must allow refund creation only against the primary succeeded charge when payment_status=''charged'''
      using errcode = '23514';
  end if;
  if v_def !~* 'v_payment\.payment_status[[:space:]]*=[[:space:]]*''double_charged''' then
    raise exception 'Block 2 FINAL_FIXED: create_or_claim_refund_attempt must restrict refund target to succeeded_duplicate when payment_status=''double_charged'''
      using errcode = '23514';
  end if;
  if v_def !~* 'reconciliation_required[^;]+disputed[^;]+partially_refunded[^;]+refunded' then
    raise exception 'Block 2 FINAL_FIXED: create_or_claim_refund_attempt must reject owner-initiated refund creation for reconciliation_required / disputed / partially_refunded / refunded'
      using errcode = '23514';
  end if;

  -- 3. complete_stripe_account_provisioning and
  --    complete_stripe_customer_provisioning must reject blank
  --    Stripe identifiers (in addition to null).
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'complete_stripe_account_provisioning';
  if v_def is null then
    raise exception 'Block 2 FINAL_FIXED: complete_stripe_account_provisioning missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'nullif\(trim\(coalesce\(p_stripe_account_id' then
    raise exception 'Block 2 FINAL_FIXED: complete_stripe_account_provisioning must reject blank p_stripe_account_id (nullif/trim/coalesce check)'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'complete_stripe_customer_provisioning';
  if v_def is null then
    raise exception 'Block 2 FINAL_FIXED: complete_stripe_customer_provisioning missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'nullif\(trim\(coalesce\(p_stripe_customer_id' then
    raise exception 'Block 2 FINAL_FIXED: complete_stripe_customer_provisioning must reject blank p_stripe_customer_id (nullif/trim/coalesce check)'
      using errcode = '23514';
  end if;

  -- 4. resolve_double_charge_incident: the
  --    'resolved_double_charged_remaining' branch must be guarded
  --    by BOTH v_unresolved_remaining > 0 AND
  --    v_recomputed = 'double_charged'. Any inconsistent recompute
  --    while unresolved duplicates remain must fall through to the
  --    revert/failure branch.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname = 'resolve_double_charge_incident';
  if v_def is null then
    raise exception 'Block 2 FINAL_FIXED: resolve_double_charge_incident missing'
      using errcode = '42883';
  end if;
  if v_def !~* 'v_unresolved_remaining[[:space:]]*>[[:space:]]*0[[:space:]]+and[[:space:]]+v_recomputed[[:space:]]*=[[:space:]]*''double_charged''' then
    raise exception 'Block 2 FINAL_FIXED: resolve_double_charge_incident must require v_recomputed = ''double_charged'' AS WELL AS v_unresolved_remaining > 0 for the resolved_double_charged_remaining branch'
      using errcode = '23514';
  end if;

  raise notice 'Block 2 FINAL_FIXED: non-mutating refund-link conflict, owner-refund state gate, blank-Stripe-ID rejection in completion RPCs, and tightened double-charge-remaining branch checks passed. Behavioural smoke tests T40-T46 MUST be run against a non-production Supabase project before live data flows.';
end
$block2_FINAL_FIXED$;

-- ===========================================================================
-- APPLICATION CONTRACT: behavioural smoke tests (run against test project)
-- ===========================================================================
-- The following five behavioural tests MUST be executed against a
-- non-production Supabase project before this migration is allowed
-- to handle live payment data. They are NOT run inside the install
-- transaction because they require real studios / clients /
-- services / appointments rows whose creation would pollute live
-- tables.
--
--   T1. Finalization failure routes saved-PM into cleanup_required.
--       Setup:   a session in payment_method_saved_pending_finalization
--                with non-null stripe_payment_method_id.
--       Action:  call mark_session_finalization_failed.
--       Expect:  status = 'cleanup_required',
--                cleanup_claim_token IS NULL,
--                cleanup_processing_started_at IS NULL,
--                finalization_error_code and finalization_error_message stored.
--
--   T2. mark_session_cleaned rejects unclaimed cleanup_required row.
--       Setup:   a session in cleanup_required with cleanup_claim_token IS NULL
--                (e.g. directly from T1).
--       Action:  call mark_session_cleaned(<session>, 'cleaned', null, null, null).
--       Expect:  exception 'cleanup claim token mismatch on session ...'.
--                Row unchanged.
--
--   T3. mark_session_cleaned rejects wrong claim token.
--       Setup:   a session in cleanup_required already claimed (token=A).
--       Action:  call mark_session_cleaned(<session>, 'cleaned', null, null, B).
--       Expect:  exception 'cleanup claim token mismatch on session ...'.
--                Row unchanged; original claim token (A) preserved.
--
--   T4. claim_payment_method_cleanup_sessions claims a finalization-
--       failure row.
--       Setup:   a session in cleanup_required from a T1 finalization
--                failure.
--       Action:  call claim_payment_method_cleanup_sessions(<studio>, 25).
--       Expect:  returns exactly one row whose out_session_id matches
--                the T1 session; out_cleanup_claim_token is non-null;
--                an audit row with action='payment_method_cleanup_attempted'
--                and metadata.origin='finalization_failed' is appended.
--
--   T5. Failed detach leaves row retryable.
--       Setup:   a session claimed in T4 (token=A).
--       Action:  call mark_session_cleaned(<session>, 'cleanup_required',
--                'transient_stripe_error', 'connection reset', A).
--       Expect:  status = 'cleanup_required',
--                cleanup_claim_token IS NULL,
--                cleanup_processing_started_at IS NULL,
--                a 'payment_method_cleanup_failed' audit row appended,
--                AND a subsequent claim_payment_method_cleanup_sessions
--                call returns this row again with a NEW claim token (B != A).
--
--   T6. Successful recovery payment sets consumed_at.
--       Setup:   an authentication_required charge attempt with a
--                payment_recovery_tokens row (consumed_at IS NULL,
--                invalidated_at IS NULL).
--       Action:  call reconcile_payment_intent_by_charge_attempt with
--                p_status='succeeded'.
--       Expect:  the recovery_tokens row has consumed_at = now()
--                AND invalidated_at IS NULL. (The runtime
--                lookup_payment_recovery_token must then return
--                is_valid=false, reason='consumed' on any future
--                redemption attempt.)
--
--   T7. PaymentIntent immutability fires from authentication_required.
--       Setup:   an attempt in authentication_required with
--                stripe_payment_intent_id='pi_A'.
--       Action:  call reconcile_payment_intent_by_charge_attempt
--                with p_payment_intent_id='pi_B' (any p_status).
--       Expect:  RPC returns 'identifier_conflict', no row mutation,
--                and a webhook_received audit with
--                error_code='same_row_identifier_conflict' and
--                metadata.attempt_status_at_conflict='authentication_required'.
--
--   T8. Accepted success retires other active attempts.
--       Setup:   on one appointment, charge attempts A (pending),
--                B (authentication_required) and C (processing) all
--                with distinct PaymentIntent IDs.
--       Action:  call reconcile_payment_intent_by_charge_attempt
--                on A with p_status='succeeded', valid PI and Charge.
--       Expect:  A.status='succeeded'. B and C both have
--                status='canceled' and
--                stripe_error_message='superseded_by_succeeded_attempt'.
--                Each of B and C has a charge_failed audit row with
--                error_code='superseded_by_succeeded_attempt' and
--                metadata.superseded_by_attempt_id=A.id.
--
--   T9. Retired attempt that later succeeds in Stripe becomes
--       succeeded_duplicate (not silently dropped).
--       Setup:   apply T8. B is now 'canceled' with PaymentIntent
--                ID 'pi_B'.
--       Action:  call reconcile_payment_intent_by_charge_attempt
--                on B with p_status='succeeded', p_payment_intent_id='pi_B',
--                p_charge_id='ch_B_new'.
--       Expect:  B.status='succeeded_duplicate', terminal_at set,
--                a double_charge_detected audit on B, and the
--                appointment_payments.payment_status becomes
--                'double_charged'.
--
--   T10. Required-both-IDs on succeeded.
--        Action: call reconcile_payment_intent_by_charge_attempt
--                with p_status='succeeded' and p_charge_id=NULL.
--        Expect: SQL exception (errcode 22023) raised; no row
--                mutation.
--
--   T11. _recompute_payment_status concurrent serialization.
--        Setup:  two psql sessions begin transactions concurrently
--                that will both end in a _recompute_payment_status
--                call against the same appointment (e.g. inject a
--                refund.succeeded and a charge.dispute.created at
--                the same wall-clock instant).
--        Expect: the second session blocks on the row lock acquired
--                by the first, then proceeds. Neither transition is
--                silently dropped; the final payment_status reflects
--                BOTH updates.
--
--   T12. Accepted Stripe success serializes against concurrent
--        create_or_claim_charge_attempt.
--        Setup:   appointment with payment_status='authentication_required'
--                 and a charge attempt A in status='authentication_required'.
--        Session 1: begin tx; call reconcile_payment_intent_by_charge_attempt(A, ..., p_status='succeeded', p_charge_id='ch_A_ok').
--                   Do NOT commit yet (the appointment_payments lock
--                   is now held).
--        Session 2: begin tx; call create_or_claim_charge_attempt
--                   on the same appointment. This MUST block.
--        Session 1: commit.
--        Session 2: unblocks. It MUST observe
--                   appointment_payments.payment_status='charged'
--                   (or whatever _recompute returned) and refuse to
--                   create a new attempt. should_execute_stripe_call
--                   MUST NOT be true.
--
--   T13. Stripe Refund row 'succeeded' is never regressed.
--        Setup:    stripe_refunds row with status='succeeded' for a
--                  Stripe Refund ID 're_X'.
--        Action:   call reconcile_refund_event(... 're_X' ...,
--                  p_status='requires_action' OR 'failed' OR
--                  'canceled' OR 'pending').
--        Expect:   RPC returns (resolved=false,
--                  error_reason='stale_event_ignored'). The
--                  stripe_refunds row's status is still 'succeeded'.
--                  An audit row with action='refund_stale_ignored'
--                  is appended. No 'refund_failed' / 'refund_succeeded'
--                  semantic audit is appended.
--                  _recompute_payment_status is NOT re-run.
--
--   T14. Terminal dispute cannot be reopened by a stale event.
--        Setup:    stripe_disputes row with status='won' (or 'lost'
--                  / 'warning_closed' / 'prevented') for Stripe
--                  Dispute ID 'dp_X'.
--        Action:   call reconcile_dispute_updated(... 'dp_X' ...,
--                  p_status='needs_response', ...).
--        Expect:   RPC returns 'stale_event_ignored'. dispute row
--                  status unchanged. A 'dispute_stale_ignored' audit
--                  is appended. No 'dispute_updated' semantic audit.
--                  _recompute_payment_status NOT re-run.
--
--   T15. Unknown dispute on update/close returns structured outcome.
--        Setup:    no stripe_disputes row exists for 'dp_unknown'.
--        Action:   call reconcile_dispute_updated / _closed for
--                  'dp_unknown'.
--        Expect:   RPC returns 'unknown_dispute'. No mutation, no
--                  audit row, no recompute. Webhook router must
--                  escalate (replay the create event after retrieving
--                  the current Stripe Dispute object).
--
--   T16. SetupIntent queueing emits 'payment_method_cleanup_queued'.
--        Setup:    session in 'consent_recorded' with no consent row
--                  (simulate missing-consent branch by deleting the
--                  consent row beforehand).
--        Action:   call reconcile_setup_intent_succeeded.
--        Expect:   session status='cleanup_required'. An audit row
--                  with action='payment_method_cleanup_queued' is
--                  appended. NO audit row with
--                  action='payment_method_cleanup_attempted' yet.
--        Then call claim_payment_method_cleanup_sessions.
--        Expect:   the session is claimed and an audit row with
--                  action='payment_method_cleanup_attempted' is
--                  appended.
--
--   T17. Retired authentication_required attempt invalidates its
--        open recovery token.
--        Setup:    two attempts on the same appointment:
--                  A in 'authentication_required' with an open
--                  payment_recovery_tokens row (consumed_at=NULL,
--                  invalidated_at=NULL); B in 'pending'.
--        Action:   call reconcile_payment_intent_by_charge_attempt
--                  on B with p_status='succeeded'.
--        Expect:   B becomes 'succeeded'. A is retired to 'canceled'
--                  with stripe_error_message='superseded_by_succeeded_attempt'.
--                  A's open recovery token has invalidated_at=now()
--                  AND consumed_at=NULL. A subsequent
--                  lookup_payment_recovery_token call returns
--                  is_valid=false, reason='invalidated'.
--
--   T18. Block 2 self-failure regression guards (P0 v5 #1).
--        Action:   re-apply the migration into a fresh database (no
--                  drift). The full install transaction must COMMIT
--                  without raising any 'Block 2:' or 'Block 2 v3/v4/v5:'
--                  exception. In particular:
--                  - the mark_session_cleaned logic-pattern check
--                    must NOT fire on the truthful explanatory
--                    comment that names the retired legacy
--                    'finalization_failed' status; and
--                  - the 'charged up to' quote-wording grep must NOT
--                    fire on the start_card_required_booking_session
--                    function comment.
--
--   T19. Cleanup safety: finalized appointment_payments row
--        prevents detach.
--        Setup:    appointment X finalized with appointment_payments
--                  row referencing (studio S, client C, account A,
--                  mode false, stripe_payment_method_id 'pm_X').
--                  Separately, a different abandoned session for the
--                  same (S, C, A, false, 'pm_X') tuple sits in
--                  status='cleanup_required'.
--        Action:   claim the cleanup session via
--                  claim_payment_method_cleanup_sessions, then call
--                  check_claimed_payment_method_cleanup_safety with
--                  the returned claim token.
--        Expect:   RPC returns decision='skip_detach_pm_in_use'
--                  with the (account, mode, customer, PM)
--                  identifiers the worker would otherwise pass to
--                  Stripe. A 'payment_method_cleanup_safety_checked'
--                  audit row records the decision. The worker then
--                  calls mark_session_cleaned(... 'cleaned_pm_in_use'
--                  ..., claim_token); no Stripe detach happens.
--
--   T20. Refund identity immutability blocks a misrouted event.
--        Setup:    a stripe_refunds row exists for Refund ID 're_X'
--                  with stored (charge ch_A, amount 5000, currency cad,
--                  studio S, account A, mode false).
--        Action:   call reconcile_refund_event(... 're_X' ...) with
--                  p_stripe_charge_id='ch_B' (which resolves to a
--                  DIFFERENT charge under the same studio/account/mode).
--        Expect:   RPC returns (false, 'refund_identifier_conflict').
--                  A 'refund_identifier_conflict' audit row is
--                  appended with stored vs incoming lineage in
--                  metadata. The stripe_refunds row is unchanged.
--                  _recompute_payment_status is NOT re-run.
--
--   T21. Refund creation serializes against external refund
--        reconciliation.
--        Setup:    appointment X with one succeeded charge ch_A.
--                  No refunds exist.
--        Session 1: begin tx; call reconcile_refund_event for a new
--                   external Refund 're_X' on ch_A with p_status='succeeded'.
--                   Do NOT commit yet.
--        Session 2: begin tx; call create_or_claim_refund_attempt
--                   on X. This MUST block on the appointment_payments
--                   lock.
--        Session 1: commit (stripe_refunds row now stored).
--        Session 2: unblocks. The "existing Stripe refund blocks new
--                   refund attempts" check rejects with a clean
--                   exception; no second refund attempt is created.
--
--   T22. Terminal dispute identity mismatch on update/close.
--        Setup:    stripe_disputes row for Dispute ID 'dp_X' bound
--                  to charge ch_A.
--        Action:   call reconcile_dispute_updated(... 'dp_X' ...)
--                  with p_charge_id='ch_B' (resolves to a different
--                  charge attempt).
--        Expect:   RPC returns 'dispute_identifier_conflict'. A
--                  'dispute_identifier_conflict' audit row is
--                  appended. dispute row unchanged. Same applies
--                  for reconcile_dispute_closed with mismatched
--                  charge.
--
--   T23. Card-required booking preflight rejects misconfigured studio.
--        Setup:    studio S without onboarded Stripe binding.
--        Action:   call start_card_required_booking_session with any
--                  valid (service, practitioner, client, future time
--                  range).
--        Expect:   raises 'studio % has no Stripe binding' (errcode
--                  P0002). No session row is inserted. The same is
--                  true if require_card_on_file is false,
--                  charges_enabled is false, the service is
--                  inactive, the practitioner is inactive, the
--                  client has no normalized_email, or the time
--                  range is invalid (each path raises its specific
--                  error).
--
--   T24. find_or_create_client_for_booking_payment_strict rejects
--        blank email.
--        Action:   call the strict helper with p_email=NULL or '   '.
--        Expect:   raises 'card-required booking requires a non-blank
--                  client email' (errcode 22023). No client row is
--                  inserted. Stripe Customer provisioning never
--                  begins.
--
--   T25. authentication_required cannot be stored without a PI.
--        Setup:   charge attempt A in status='pending', no PI.
--        Action:  reconcile_payment_intent_by_charge_attempt(A,
--                 ..., p_status='authentication_required',
--                 p_payment_intent_id=NULL).
--        Expect:  raises 'p_payment_intent_id is required for
--                 authentication_required' (errcode 22023). Row
--                 unchanged. No recovery token can be issued
--                 against this attempt.
--        Then call again with a valid PI.
--        Expect:  attempt status='authentication_required' with
--                 stripe_payment_intent_id stored. A subsequent
--                 create_payment_recovery_token call succeeds.
--
--   T26. Session-state structural rejection of null SI/PM at
--        saved/finalized/cleanup states.
--        Action:  any direct UPDATE attempting to set
--                 status='payment_method_saved_pending_finalization'
--                 with stripe_payment_method_id=NULL (e.g. a
--                 service_role bug) is rejected by
--                 pending_booking_payment_sessions_pm_required_check.
--                 Equivalent for SI and the four covered statuses.
--        Expect:  PG constraint violation; no row mutation.
--
--   T27. Detach guard prevents finalization (cleanup wins first).
--        Setup:   abandoned session S1 for (studio, client, PM) is
--                 in cleanup_required. A NEW separate session S2
--                 for the same client lands in
--                 payment_method_saved_pending_finalization with
--                 the SAME PM stored. (This is the abuse-recovery
--                 race the v7 guard exists for.)
--        Action:  worker claims S1 and calls
--                 check_claimed_payment_method_cleanup_safety,
--                 which returns 'safe_to_detach' AND persists
--                 cleanup_detach_state='detach_authorized'. Do NOT
--                 commit the cleanup transaction yet.
--        Action (separate session): call
--                 finalize_card_required_public_booking on S2.
--        Expect:  finalize blocks on the PaymentMethod-tuple
--                 advisory lock until the cleanup tx commits.
--                 After the lock releases, finalize reads
--                 cleanup_detach_state='detach_authorized' and
--                 raises 'payment_method_cleanup_in_progress_or_completed'.
--                 NO appointment_payments row is inserted for S2.
--
--   T28. Finalize wins first.
--        Setup:   abandoned S1 in cleanup_required with PM. S2
--                 ready to finalize with the same PM.
--        Action:  finalize_card_required_public_booking on S2,
--                 commits.
--        Then:    worker claims S1 and calls safety check.
--        Expect:  safety check returns 'skip_detach_pm_in_use'
--                 (a finalized appointment_payments row now
--                 references the PM) AND persists
--                 cleanup_detach_state='skip_detach_pm_in_use'.
--                 Worker calls mark_session_cleaned(... 'cleaned_pm_in_use'
--                 ..., claim_token); no Stripe detach.
--
--   T29. Exact duration mismatch is rejected.
--        Action:  start_card_required_booking_session with
--                 requested_starts_at = 09:00, requested_ends_at
--                 = 10:30, requested_duration_minutes = 30.
--        Expect:  raises 'requested time range ... does not
--                 exactly equal 30 minutes' (errcode 22023). No
--                 session row inserted. The same input as a
--                 direct INSERT against pending_booking_payment_sessions
--                 is rejected by
--                 pending_booking_payment_sessions_duration_exact_check.
--
--   T30. Finalization re-checks: stale configuration is rejected.
--        Setup:   session S in payment_method_saved_pending_finalization
--                 was created when service.active=true. Owner
--                 deactivates the service afterwards.
--        Action:  finalize_card_required_public_booking on S.
--        Expect:  raises 'service % no longer available or inactive
--                 on studio %' (errcode P0002). Same for inactive
--                 practitioner / disabled require_card_on_file /
--                 disabled stripe_charges_enabled / account-mode
--                 swap.
--
--   T31. Refund identity conflict does NOT poison the Hone
--        refund attempt.
--        Setup:   stripe_refunds row 're_X' exists for charge ch_A
--                 with stored amount=5000, currency=cad. A new
--                 Hone refund attempt B has just been created on
--                 charge ch_B with metadata pointing at 're_X'.
--        Action:  reconcile_refund_event(... charge_id='ch_B'
--                 ... refund_id='re_X' ... metadata_refund_attempt_id=B).
--        Expect:  RPC returns (false, 'refund_identifier_conflict').
--                 The stripe_refund_attempts row B still has
--                 stripe_refund_id IS NULL (NOT poisoned with
--                 're_X'). A subsequent legitimate refund attempt
--                 on B can complete normally.
--
--   T32. Double-charge resolution reverts on inconsistent recompute.
--        Setup:   appointment with a duplicate charge that is
--                 fully refunded, BUT some other structural
--                 inconsistency exists (e.g. a second unresolved
--                 succeeded_duplicate created concurrently). The
--                 recompute would return 'double_charged' or
--                 'reconciliation_required'.
--        Action:  resolve_double_charge_incident.
--        Expect:  RPC returns 'unresolved_inconsistent'. The
--                 duplicate row's duplicate_resolved_at,
--                 duplicate_resolution, and
--                 duplicate_resolved_by_practitioner_id are ALL
--                 NULL (no resolution persisted). A
--                 'double_charge_resolution_failed' audit row is
--                 appended. NO 'double_charge_resolved' audit
--                 row exists for this attempt. payment_status is
--                 'double_charged'.
--
--   T33. Stripe Customer provisioning rejects email-less client.
--        Setup:   client with email IS NULL or trim(email) = ''.
--        Action:  create_or_claim_stripe_customer_provisioning
--                 for that client.
--        Expect:  raises 'client % does not belong to studio % or
--                 has no normalized_email (required for Stripe
--                 Customer provisioning)' (errcode P0002). No
--                 attempt row inserted; no Stripe Customer is
--                 provisioned.
--
--   T34. get_disputes_for_studio no longer exposes raw
--        Stripe Dispute IDs.
--        Action:  call get_disputes_for_studio as authenticated
--                 owner.
--        Expect:  result columns are {dispute_id, appointment_id,
--                 amount_cents, currency, reason, status,
--                 evidence_due_by, closed_outcome}. NO
--                 stripe_dispute_id column.
--
--   T35. Cleanup safety persists 'detach_authorized' (not the
--        worker return literal).
--        Setup:   session S in cleanup_required with PM, no
--                 finalized appointment_payments row referencing
--                 the PM. Claim the session.
--        Action:  check_claimed_payment_method_cleanup_safety(S,
--                 claim_token).
--        Expect:  RPC returns decision='safe_to_detach'. Row's
--                 pending_booking_payment_sessions.cleanup_detach_state
--                 is exactly 'detach_authorized'. Reading the row
--                 back from PG must NOT raise a CHECK violation.
--                 (Without this fix v7 would have raised
--                 'new row for relation ... violates check
--                 constraint' at apply time.)
--
--   T36. Crash-recovery re-claim of stale 'detach_authorized'.
--        Setup:   session S in cleanup_required with PM. First
--                 worker claims S, calls safety (which writes
--                 'detach_authorized'), then crashes WITHOUT
--                 calling Stripe and WITHOUT mark_session_cleaned.
--                 Wait > 5 minutes so the claim lease goes stale.
--        Action:  claim_payment_method_cleanup_sessions(<studio>).
--        Expect:  S is re-claimed with a NEW claim_token.
--                 cleanup_detach_state IS STILL 'detach_authorized'
--                 (durable finalization block preserved). The
--                 retry worker can either retry Stripe detach or
--                 call mark_session_cleaned(...'cleaned',
--                 ...,new_claim_token) if Stripe shows the PM is
--                 already detached.
--        Cross-check: while S is being resolved by the retry
--                 worker, a concurrent finalize attempt with the
--                 same PM still raises
--                 'payment_method_cleanup_in_progress_or_completed'.
--
--   T37. Stale 'skip_detach_pm_in_use' is reclaimable.
--        Setup:   session S in cleanup_required with PM that IS
--                 referenced by a finalized appointment_payments
--                 row. First worker claims S, calls safety
--                 (which writes 'skip_detach_pm_in_use'), then
--                 crashes WITHOUT mark_session_cleaned. Wait
--                 stale.
--        Action:  claim_payment_method_cleanup_sessions.
--        Expect:  S is re-claimed with a NEW claim_token.
--                 cleanup_detach_state IS STILL
--                 'skip_detach_pm_in_use' (preserved). The retry
--                 worker performs NO Stripe call and immediately
--                 calls mark_session_cleaned(... 'cleaned_pm_in_use'
--                 ..., new_claim_token), which succeeds.
--
--   T38. First Hone-initiated refund.succeeded inserts exactly
--        one stripe_refunds row (FOUND-safe branching).
--        Setup:   succeeded charge attempt A with no stripe_refunds
--                 row for the Refund ID 're_X'. A Hone refund
--                 attempt B exists on A with metadata pointing at
--                 the upcoming refund (no stripe_refund_id stored
--                 yet).
--        Action:  reconcile_refund_event(... 're_X' ... p_status='succeeded'
--                 ... metadata_refund_attempt_id=B).
--        Expect:  exactly one stripe_refunds row exists for
--                 (account, mode, 're_X') with source='hone_initiated'
--                 and refund_attempt_id=B. B.stripe_refund_id is
--                 stored as 're_X'. B.status='succeeded'. A
--                 'refund_succeeded' audit row is appended.
--                 appointment_payments.payment_status recomputes
--                 to 'refunded' (or 'partially_refunded' for a
--                 partial). (Without this fix the v7 branching
--                 on overwritten FOUND would skip the INSERT and
--                 the refund row would never be persisted.)
--
--   T39. Refund/dispute currency mismatch rejected.
--        Setup:   succeeded charge attempt A with currency='cad'.
--        Action 1: reconcile_refund_event(... p_currency='usd').
--        Expect:   RPC returns (false, 'refund_identifier_conflict').
--                  A 'refund_identifier_conflict' audit with
--                  metadata.reason='refund_currency_mismatch' is
--                  appended. No stripe_refunds row inserted.
--        Action 2: reconcile_dispute_created(... p_currency='usd').
--        Expect:   RPC returns 'dispute_identifier_conflict'. A
--                  'dispute_identifier_conflict' audit with
--                  metadata.reason='dispute_currency_mismatch' is
--                  appended. No stripe_disputes row inserted.
--                  Same expectations for reconcile_dispute_updated
--                  and reconcile_dispute_closed.
--
-- These tests are owned by the application-level integration suite.
--   T40. Refund link-conflict branch is NON-MUTATING.
--        Setup:    succeeded charge ch_A on appointment X with a
--                  stripe_refunds row 're_X' currently linked to
--                  Hone refund_attempt B1 (source='hone_initiated',
--                  status='pending', amount_cents=5000, currency='cad').
--                  A second Hone refund_attempt B2 exists on the
--                  same charge.
--        Action:   reconcile_refund_event(... 're_X' ...,
--                  p_metadata_refund_attempt_id=B2,
--                  p_amount_cents=5000, p_currency='cad',
--                  p_status='failed').
--                  The amount/currency intentionally MATCH the
--                  stored refund and original charge so the test
--                  reaches the Hone-attempt-link conflict branch
--                  rather than failing earlier on currency/amount
--                  identity validation.
--        Expect:   RPC returns (false, 'refund_attempt_link_conflict').
--                  stripe_refunds row 're_X' is UNCHANGED: status
--                  still 'pending', amount_cents still 5000,
--                  currency still 'cad', refund_attempt_id still
--                  B1. Audit row appended with action
--                  'refund_identifier_conflict' (NOT 'refund_failed'),
--                  metadata.reason =
--                  'existing_hone_refund_link_conflicts_with_incoming_metadata'.
--                  appointment_payments.payment_status NOT
--                  re-recomputed.
--
--   T41. Owner-initiated refund rejected when payment_status='double_charged'
--        and the target is the primary 'succeeded' charge.
--        Setup:    appointment X with primary succeeded charge A
--                  and unresolved succeeded_duplicate B; payment
--                  root in 'double_charged'.
--        Action:   create_or_claim_refund_attempt(X, ..., target=A).
--        Expect:   raises 'appointment is double_charged; refund
--                  attempt must target the succeeded_duplicate
--                  charge ...' (errcode P0002). No attempt row
--                  inserted.
--
--   T42. Owner-initiated refund ALLOWED when payment_status='double_charged'
--        and the target is the duplicate ('succeeded_duplicate').
--        Setup:    same as T41.
--        Action:   create_or_claim_refund_attempt(X, ..., target=B).
--        Expect:   attempt row inserted; should_execute_stripe_call=true.
--                  Owner is then expected to run
--                  resolve_double_charge_incident after Stripe
--                  confirms the refund.
--
--   T43. Owner-initiated refund rejected when payment_status in
--        ('reconciliation_required', 'disputed', 'partially_refunded',
--         'refunded').
--        Action:   for each of those states, attempt
--                  create_or_claim_refund_attempt against the
--                  primary succeeded charge.
--        Expect:   each raises 'appointment_payments.payment_status=%
--                  does not permit owner-initiated refund creation'
--                  (errcode P0002).
--
--   T44. Completion RPCs reject blank Stripe identifiers.
--        Action 1: complete_stripe_account_provisioning with
--                  p_stripe_account_id = '   '.
--        Expect 1: raises 'p_stripe_account_id and p_stripe_livemode
--                  must be supplied (non-blank)' (errcode 22023).
--                  No attempt row mutated; no studio_payment_settings
--                  row written.
--        Action 2: complete_stripe_customer_provisioning with
--                  p_stripe_customer_id = '   '.
--        Expect 2: raises 'p_stripe_customer_id is required and
--                  must be non-blank' (errcode 22023). No attempt
--                  row mutated; no client_stripe_customers row
--                  written.
--
--   T45. Double-charge resolution: multi-duplicate + inconsistent
--        recompute is REVERTED, not falsely accepted.
--        Setup:    appointment X with primary succeeded A and
--                  succeeded_duplicates B and C, both with FULL
--                  refunds in place. Additionally inject a
--                  structural inconsistency (e.g. an extra
--                  succeeded_duplicate D with no resolution and
--                  no refund) that will cause
--                  _recompute_payment_status to return
--                  'reconciliation_required' instead of
--                  'double_charged'.
--        Action:   resolve_double_charge_incident(X, ..., duplicate=B).
--        Expect:   RPC returns 'unresolved_inconsistent'.
--                  B.duplicate_resolved_at IS NULL,
--                  duplicate_resolution IS NULL,
--                  duplicate_resolved_by_practitioner_id IS NULL
--                  (tentative resolution reverted).
--                  A 'double_charge_resolution_failed' audit row
--                  is appended; NO 'double_charge_resolved' audit
--                  exists for B.
--                  payment_status remains 'double_charged' (or
--                  whatever _recompute returns after revert).
--        Cross-check: T45 is the contrast case for T11; previously
--        the function would have FALSELY emitted
--        'double_charge_resolved' here because v_unresolved_remaining
--        was > 0 regardless of recompute outcome.
--
--   T46. Reclaimed 'detach_authorized' keeps finalization blocked
--        across worker retries.
--        Setup:    session S in 'cleanup_required'; first worker
--                  claims S, safety RPC persists 'detach_authorized'.
--                  Worker crashes BEFORE calling Stripe. Wait > 5
--                  minutes for claim lease to go stale. Second
--                  worker calls claim_payment_method_cleanup_sessions
--                  and gets S with a NEW claim token; the durable
--                  guard is preserved.
--        Action 1: while second worker is still resolving the
--                  Stripe-side state, a different request tries
--                  finalize_card_required_public_booking against a
--                  session that uses the SAME PaymentMethod.
--        Expect 1: finalize raises
--                  'payment_method_cleanup_in_progress_or_completed
--                  for PM on session ...' (errcode P0002). No
--                  appointment_payments row inserted for the
--                  competing session.
--        Action 2: second worker calls stripe.paymentMethods.retrieve
--                  to learn detach already succeeded; calls
--                  mark_session_cleaned(... 'cleaned' ...,
--                  new_claim_token).
--        Expect 2: cleanup_detach_state='detached'. The PM is now
--                  finalization-blocked permanently (as it should
--                  be - the card no longer exists on Stripe).
--
-- These tests are owned by the application-level integration suite.
-- They are NOT optional - they verify the core money-safety
-- guarantees of the unified cleanup queue, identifier immutability,
-- retirement of superseded attempts, refund / dispute non-regression
-- AND identity immutability, refund-creation serialization against
-- external refund reconciliation, truthful cleanup audit semantics,
-- recovery-token state vocabulary, lock-ordered serialization,
-- card-required preflight checks, strict client identity,
-- claim-checked PaymentMethod cleanup safety, durable
-- detach-vs-finalization guard with correct CHECK vocabulary,
-- crash-recovery re-claim of authorized cleanup work with
-- preserved durable guard, FOUND-safe refund insert/update
-- branching, currency identity for refund and dispute events,
-- NON-MUTATING refund-link conflict resolution,
-- payment_status-gated owner-refund creation, blank-Stripe-ID
-- rejection in completion RPCs, tightened double-charge
-- remaining-incident branch, structural session integrity, and
-- display-safe owner output. Do not allow this migration to
-- handle live payment data before T1-T46 pass.

commit;
