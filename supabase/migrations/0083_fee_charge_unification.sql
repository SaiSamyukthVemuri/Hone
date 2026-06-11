-- 0083: Payment ledger unification (PR #196).
--
-- Fees (no_show_fee / late_cancellation_fee) move onto the canonical
-- payment_charge_attempts ledger so they inherit receipts, refunds,
-- webhook reconciliation, ops alerts, and the live-mode guards. The
-- legacy manual_fee_charge_attempts table receives NO new runtime
-- writes after this PR (historical rows preserved, read-only).
--
-- Two changes:
--   1. Three additive evidence columns the fee flow carries (policy
--      acknowledgement linkage; same audit trail the legacy table
--      kept). Nullable; session_payment rows simply leave them null.
--   2. The claim RPC's reason guard widens from session_payment-only
--      to the three canonical reasons. EVERYTHING else in the
--      function body is byte-identical to migration 0075 (row lock,
--      live-mode guard, practitioner check, status machine, claim
--      UPDATE, grants). The idempotency key stays caller-supplied;
--      the executor builds hone:<charge_reason>:<attempt_id>:v1.
--
-- No RLS change. The reason-shape CHECK from 0073 already requires
-- appointment_id (and forbids session_id) for fee reasons.

alter table public.payment_charge_attempts
  add column if not exists appointment_policy_acknowledgement_id uuid
    references public.appointment_policy_acknowledgements(id) on delete set null,
  add column if not exists policy_snapshot_hash text,
  add column if not exists timing_classification text;

comment on column public.payment_charge_attempts.appointment_policy_acknowledgement_id is
  'Fee reasons only: the policy acknowledgement evidence row backing the fee. Null for session_payment.';

create or replace function public.claim_session_payment_charge_attempt(
  p_attempt_id        uuid,
  p_practitioner_id   uuid,
  p_idempotency_key   text
) returns table (
  result                              text,
  attempt_id                          uuid,
  studio_id                           uuid,
  client_id                           uuid,
  session_id                          uuid,
  appointment_id                      uuid,
  charge_reason                       text,
  amount_cents                        integer,
  currency                            text,
  client_payment_method_id            uuid,
  card_authorization_signature_id     uuid,
  stripe_account_id                   text,
  stripe_customer_id                  text,
  stripe_payment_method_id            text,
  stripe_payment_intent_id            text,
  stripe_idempotency_key              text,
  status_before_claim                 text,
  updated_at                          timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.payment_charge_attempts%rowtype;
  v_role text;
begin
  if p_attempt_id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;

  select * into v_row
    from public.payment_charge_attempts pca
   where pca.id = p_attempt_id
   for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::integer, null::text, null::uuid,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;

  -- Reason guard (0083): the three canonical charge reasons. Any
  -- other reason refuses; fee rows claim through the same audited
  -- path as session payments.
  if v_row.charge_reason not in ('session_payment', 'no_show_fee', 'late_cancellation_fee') then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Live-mode guard. The CHECK constraint forbids a row with
  -- stripe_livemode=true today; the RPC mirrors the guarantee so a
  -- future relax of the CHECK still cannot claim through this code
  -- path until a separate live-enablement PR replaces this body.
  if v_row.stripe_livemode <> false then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
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
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-succeeded short circuit. The caller surfaces the success
  -- without touching Stripe.
  if v_row.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Already-pending: caller runs the reconciliation path. We return
  -- the existing PI id + idempotency key so the action does not need
  -- a separate SELECT.
  if v_row.status = 'pending_stripe' then
    return query select 'already_pending'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Any other non-'ready' status (blocked / cancelled / failed) is
  -- not retryable in this PR. Failed retries are a future design.
  if v_row.status <> 'ready' then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- 'ready' with a non-null stripe_payment_intent_id should be
  -- structurally impossible (we never set the PI id without also
  -- transitioning to pending_stripe), but if it ever happens we
  -- refuse rather than overwrite.
  if v_row.stripe_payment_intent_id is not null then
    return query select 'not_ready'::text, v_row.id, v_row.studio_id,
      v_row.client_id, v_row.session_id, v_row.appointment_id,
      v_row.charge_reason, v_row.amount_cents, v_row.currency,
      v_row.client_payment_method_id, v_row.card_authorization_signature_id,
      v_row.stripe_account_id, v_row.stripe_customer_id,
      v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
      v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
    return;
  end if;

  -- Claim. The conditional UPDATE on status='ready' is the second
  -- (belt + braces) protection on top of the row lock above; the
  -- partial unique on stripe_idempotency_key adds a third in case
  -- two simultaneous claims somehow both pass the FOR UPDATE.
  update public.payment_charge_attempts
     set status                 = 'pending_stripe',
         stripe_idempotency_key = p_idempotency_key,
         updated_at             = now()
   where id     = p_attempt_id
     and status = 'ready';

  -- Re-read the row so we return the updated_at the caller can use
  -- for the "recent claim" reconciliation window.
  select * into v_row
    from public.payment_charge_attempts pca
   where pca.id = p_attempt_id;

  return query select 'claimed'::text, v_row.id, v_row.studio_id,
    v_row.client_id, v_row.session_id, v_row.appointment_id,
    v_row.charge_reason, v_row.amount_cents, v_row.currency,
    v_row.client_payment_method_id, v_row.card_authorization_signature_id,
    v_row.stripe_account_id, v_row.stripe_customer_id,
    v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
    v_row.stripe_idempotency_key, 'ready'::text, v_row.updated_at;
end;
$$;

revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text)
  to service_role;
