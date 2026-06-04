-- ===========================================================================
-- Migration 0065: manual fee charge test-mode result fields + claim RPC.
-- ===========================================================================
--
-- What this migration does
-- ------------------------
-- Adds the columns and the SECURITY DEFINER RPC that PR #146 needs to
-- safely run a TEST-MODE-ONLY Stripe PaymentIntent against an existing
-- manual_fee_charge_attempts.status='ready' row. No live charges, no
-- automatic flow, no refund, no public booking change. The action
-- atomically claims the attempt before any Stripe call so a double-click
-- or two-tab race cannot create two PaymentIntents for the same row.
--
-- Hard test-mode gate
-- -------------------
-- The new column stripe_livemode defaults to FALSE and is CHECK-pinned
-- to FALSE. Future live charging must deliberately replace this CHECK
-- in a separate reviewed migration; the constraint name is explicit so
-- the eventual replacement is obvious in code review.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
-- * No refund columns. Refunds are a future PR.
-- * No dispute columns. Disputes are a future PR.
-- * No JSON blob storage. Only sanitized scalar fields.
-- * No client_secret column. The client_secret never persists.
-- * No card number / CVC / PaymentMethod object snapshot.
-- * No change to 0032's appointment_payments / stripe_charge_attempts
--   / stripe_refunds chain. Those stay dormant.
-- * No webhook handler change here (webhooks are deferred for v1; the
--   synchronous action records the result).
--
-- Strictly additive + idempotent. No data backfill. Applied to prod
-- BEFORE merging the code that references the new columns and RPC.
-- ===========================================================================

-- --------------------------------------------------------------------
-- 1) Add the safe Stripe result fields
-- --------------------------------------------------------------------

alter table public.manual_fee_charge_attempts
  add column if not exists stripe_account_id          text,
  add column if not exists stripe_livemode            boolean not null default false,
  add column if not exists stripe_customer_id         text,
  add column if not exists stripe_payment_method_id   text,
  add column if not exists stripe_payment_intent_id   text,
  add column if not exists stripe_charge_id           text,
  add column if not exists stripe_idempotency_key     text,
  add column if not exists stripe_status              text,
  add column if not exists charged_at                 timestamptz,
  add column if not exists failed_at                  timestamptz,
  add column if not exists failure_code               text,
  add column if not exists failure_message            text,
  add column if not exists cancelled_at               timestamptz,
  add column if not exists cancelled_by_practitioner_id uuid
    references public.practitioners(id) on delete restrict,
  add column if not exists cancelled_reason           text;

-- --------------------------------------------------------------------
-- 2) Test-mode-only CHECK (mandatory for this PR)
-- --------------------------------------------------------------------
-- Pinning stripe_livemode to false at the column level makes "this row
-- can never carry a live-mode charge" structurally true. A future live
-- mode PR must replace this CHECK with a less restrictive variant; the
-- replacement is a deliberate schema change that goes through review.

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_livemode_false_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_livemode_false_check
  check (stripe_livemode = false);

-- --------------------------------------------------------------------
-- 3) Sanitized-failure CHECKs
-- --------------------------------------------------------------------

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_failure_message_length_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_failure_message_length_check
  check (failure_message is null or char_length(failure_message) <= 1000);

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_failure_code_length_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_failure_code_length_check
  check (failure_code is null or char_length(failure_code) <= 100);

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_cancelled_reason_length_check;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_cancelled_reason_length_check
  check (cancelled_reason is null or char_length(cancelled_reason) between 1 and 500);

-- --------------------------------------------------------------------
-- 4) Partial uniques for Stripe identifiers
-- --------------------------------------------------------------------

create unique index if not exists manual_fee_charge_attempts_pi_uniq
  on public.manual_fee_charge_attempts (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create unique index if not exists manual_fee_charge_attempts_idempotency_uniq
  on public.manual_fee_charge_attempts (stripe_idempotency_key)
  where stripe_idempotency_key is not null;

-- --------------------------------------------------------------------
-- 5) claim_manual_fee_charge_attempt RPC
-- --------------------------------------------------------------------
-- Atomically transitions a 'ready' attempt to 'pending_stripe' and
-- stamps the deterministic idempotency key. Called by the charge
-- action BEFORE any Stripe network call. Locks the row FOR UPDATE so
-- a concurrent click is serialized and fails the second-comer with a
-- non-'claimed' result. Anchor result codes:
--
--   * claimed              : the caller now owns this attempt; safe to
--                            call Stripe with the returned idempotency
--                            key. Caller MUST follow up by writing
--                            stripe_payment_intent_id + status onto
--                            the row after the Stripe call resolves.
--   * not_found            : id does not exist (or studio mismatch).
--   * not_authorized       : practitioner is not active in the studio
--                            the attempt belongs to.
--   * not_ready            : status is not 'ready' and not
--                            'pending_stripe' (i.e. blocked /
--                            cancelled / failed / succeeded). The
--                            action surface refuses to retry.
--   * already_pending      : status is already 'pending_stripe'. The
--                            caller takes the reconciliation path
--                            (retrieve PI by id, or retry with same
--                            idempotency key for recent claims, or
--                            flag for manual review for old ones).
--                            The RPC also returns the existing
--                            stripe_payment_intent_id and the
--                            existing stripe_idempotency_key so the
--                            caller does not need a second SELECT.
--   * already_succeeded    : a previous claim ran the charge to
--                            completion. Caller skips Stripe entirely
--                            and surfaces the success state.
--
-- The RPC NEVER calls Stripe and NEVER moves money. It only writes
-- attempt status + idempotency key.

create or replace function public.claim_manual_fee_charge_attempt(
  p_attempt_id        uuid,
  p_practitioner_id   uuid,
  p_idempotency_key   text
) returns table (
  result                      text,
  attempt_id                  uuid,
  studio_id                   uuid,
  appointment_id              uuid,
  client_id                   uuid,
  charge_type                 text,
  amount_cents                integer,
  currency                    text,
  client_payment_method_id    uuid,
  stripe_payment_intent_id    text,
  stripe_idempotency_key      text,
  status_before_claim         text,
  updated_at                  timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.manual_fee_charge_attempts%rowtype;
  v_role text;
begin
  if p_attempt_id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::text, null::integer, null::text, null::uuid,
      null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::text, null::integer, null::text, null::uuid,
      null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_row
    from public.manual_fee_charge_attempts mfa
   where mfa.id = p_attempt_id
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::text, null::integer, null::text, null::uuid,
      null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  -- Practitioner must be active in the row's studio. The application
  -- already verifies the session practitioner belongs to a studio,
  -- but we re-check here so the RPC is safe even if a future caller
  -- forgets to pre-check.
  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_practitioner_id
     and pr.studio_id = v_row.studio_id
     and pr.active = true;
  if not found then
    return query select 'not_authorized'::text, v_row.id, v_row.studio_id,
      v_row.appointment_id, v_row.client_id, v_row.charge_type,
      v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
      v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
      v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-succeeded short circuit. The caller surfaces the success
  -- without touching Stripe.
  if v_row.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_row.id, v_row.studio_id,
      v_row.appointment_id, v_row.client_id, v_row.charge_type,
      v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
      v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
      v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-pending: caller runs the reconciliation path. We return
  -- the existing PI id + idempotency key so the action does not need
  -- a separate SELECT.
  if v_row.status = 'pending_stripe' then
    return query select 'already_pending'::text, v_row.id, v_row.studio_id,
      v_row.appointment_id, v_row.client_id, v_row.charge_type,
      v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
      v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
      v_row.status, v_row.updated_at;
    return;
  end if;

  -- Any other non-'ready' status (blocked / cancelled / failed) is
  -- not retryable in this PR. Failed retries are a future design.
  if v_row.status <> 'ready' then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.appointment_id, v_row.client_id, v_row.charge_type,
      v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
      v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
      v_row.status, v_row.updated_at;
    return;
  end if;

  -- 'ready' with a non-null stripe_payment_intent_id should be
  -- structurally impossible (we never set the PI id without also
  -- transitioning to pending_stripe), but if it ever happens we
  -- refuse rather than overwrite.
  if v_row.stripe_payment_intent_id is not null then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.appointment_id, v_row.client_id, v_row.charge_type,
      v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
      v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
      v_row.status, v_row.updated_at;
    return;
  end if;

  -- Claim. The conditional UPDATE on status='ready' is the second
  -- (belt + braces) protection on top of the row lock above; the
  -- partial unique on stripe_idempotency_key adds a third in case
  -- two simultaneous claims somehow both pass the FOR UPDATE.
  update public.manual_fee_charge_attempts
     set status                 = 'pending_stripe',
         stripe_idempotency_key = p_idempotency_key,
         updated_at             = now()
   where id     = p_attempt_id
     and status = 'ready';

  -- Re-read the row so we return the updated_at the caller can use
  -- for the "recent claim" reconciliation window.
  select * into v_row
    from public.manual_fee_charge_attempts mfa
   where mfa.id = p_attempt_id;

  return query select 'claimed'::text, v_row.id, v_row.studio_id,
    v_row.appointment_id, v_row.client_id, v_row.charge_type,
    v_row.amount_cents, v_row.currency, v_row.client_payment_method_id,
    v_row.stripe_payment_intent_id, v_row.stripe_idempotency_key,
    'ready'::text, v_row.updated_at;
end;
$$;

revoke execute on function public.claim_manual_fee_charge_attempt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_manual_fee_charge_attempt(uuid, uuid, text)
  to service_role;
