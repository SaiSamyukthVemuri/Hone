-- Migration 0075. Atomic claim RPC for session_payment execution.
-- PR #173. Mirrors migration 0065's
-- claim_manual_fee_charge_attempt almost line-for-line, adapted for
-- public.payment_charge_attempts (charge_reason='session_payment').
--
-- The RPC exists to give runSessionPaymentCharge (PR #173) an
-- atomic "claim this ready row before calling Stripe" step. Without
-- it a double-click race could land two paymentIntents.create
-- calls against the same attempt id. The RPC takes the row's
-- per-row lock (FOR UPDATE), transitions status='ready' ->
-- 'pending_stripe', and stamps the deterministic idempotency key
-- (hone:session_payment:<attempt_id>:v1) all inside one
-- transaction. The caller then calls Stripe with the returned key;
-- Stripe's 24-hour idempotency window replays the prior response
-- if the same key is reused.
--
-- Return shape (mirror of 0065 with the session_payment columns):
--   * claimed              : status was 'ready'; flipped to
--                            'pending_stripe' + idempotency key
--                            stamped. Caller now calls Stripe.
--   * already_succeeded    : a prior claim succeeded. Caller skips
--                            Stripe and surfaces the success state.
--   * already_pending      : a prior claim is still in flight (or
--                            stuck). Caller hits the reconciliation
--                            branch (retrieve PI by id, or retry
--                            with same idempotency key for recent
--                            claims, or flag for manual review for
--                            old ones). The RPC returns the existing
--                            stripe_payment_intent_id and the
--                            existing stripe_idempotency_key so the
--                            caller does not need a second SELECT.
--   * not_found            : null id or no such row.
--   * not_authorized       : practitioner is not active in the
--                            row's studio.
--   * not_ready            : row status is failed / cancelled /
--                            blocked. Future retry design is out
--                            of scope here.
--
-- The RPC NEVER calls Stripe and NEVER moves money. It only writes
-- attempt status + idempotency key.
--
-- Scope guards (RESTRICT in the strictest sense; mirror 0065):
--   * charge_reason must be 'session_payment'. The RPC will return
--     not_ready if pointed at a row of a different reason -- a
--     session-payment-only claim must never accidentally touch a
--     late_cancellation_fee or no_show_fee row even if such rows
--     existed under this table (none do today; manual_fee fees
--     live on the legacy manual_fee_charge_attempts ledger).
--   * stripe_livemode must be false. The payment_charge_attempts
--     _livemode_false_check CHECK constraint already prevents a
--     live row from existing, but the RPC also returns not_ready
--     so a future runtime that bypasses the CHECK still cannot
--     claim a live row through this code path.

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

  -- Reason guard: this RPC is session_payment only. A row of a
  -- different reason cannot be claimed here even if it ever existed
  -- in this table; a future cancellation-fee / no_show_fee runtime
  -- on this same ledger will need its own RPC (or a parameterised
  -- variant) with its own audit trail.
  if v_row.charge_reason <> 'session_payment' then
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

-- Verification (run after `supabase db push --linked`):
--
--   select proname, pg_get_function_identity_arguments(oid),
--          pg_get_function_result(oid)
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname = 'claim_session_payment_charge_attempt';
--   -- expect: one row; arguments (p_attempt_id uuid, p_practitioner_id uuid, p_idempotency_key text); return type table(...)
--
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and routine_name = 'claim_session_payment_charge_attempt'
--   order by grantee, privilege_type;
--   -- expect: service_role | EXECUTE (only)
