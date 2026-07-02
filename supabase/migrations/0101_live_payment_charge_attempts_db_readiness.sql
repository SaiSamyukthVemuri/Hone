-- 0101: Live-payment DB readiness (PR #322 / PR A).
--
-- Makes public.payment_charge_attempts CAPABLE of storing live
-- (stripe_livemode = true) rows and lets claim_session_payment_charge_attempt
-- claim them. This is the DB-layer step of the controlled live-payment
-- enablement sequence (docs/16 §17.12 step 4).
--
-- INERT until PR #323/#324: this migration does NOT enable live charges.
--   * The prepare-insert (app/(app)/clients/[id]/sessions/[sessionId]/
--     payment-actions.ts) still hardcodes stripe_livemode := false, so no live
--     row is ever CREATED by runtime.
--   * The charge executor (lib/billing/session-payment-charge.ts) still returns
--     live_mode_blocked when inferStripeLivemode() is true.
--   * The env master switch (STRIPE_ALLOW_LIVE_MODE) is unset, so the live key
--     is rejected and inferStripeLivemode() is false.
-- A live row is therefore only REPRESENTABLE here, never chargeable.
--
-- What changes:
--   1. Replace the payment_charge_attempts_livemode_false_check
--      (stripe_livemode = false) — the "no live rows at all" dormancy CHECK —
--      with a NARROWER structural CHECK that still rejects malformed live rows:
--      a live row must carry a connected account id.
--   2. CREATE OR REPLACE claim_session_payment_charge_attempt to remove ONLY
--      the `if v_row.stripe_livemode <> false then return not_ready` block
--      (originally 0075, current body 0083). Every other guard is unchanged.
--
-- What this migration deliberately does NOT touch:
--   * stripe_livemode column default (stays `false`; an explicit live write is
--     a per-row decision, not a schema-wide flip).
--   * manual_fee_charge_attempts_livemode_false_check (0065) — the legacy fee
--     ledger stays dormant; live fees ride the unified payment_charge_attempts.
--   * payment_charge_attempts_reason_shape_check (0073) and all mode-lineage
--     FKs (0058) — mode-consistency safety is unchanged.
--   * Any RLS policy, runtime guard, webhook behavior, or env.

-- 1. Structural CHECK: drop the dormancy CHECK, add the account-requires CHECK.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_livemode_false_check;

alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_live_requires_account_check
  check (stripe_livemode = false or stripe_account_id is not null);

comment on constraint payment_charge_attempts_live_requires_account_check
  on public.payment_charge_attempts is
  'PR #322: replaced payment_charge_attempts_livemode_false_check. A live row (stripe_livemode=true) must carry a connected stripe_account_id, so a malformed live row with no account is rejected. Test-mode rows (livemode=false) are unconstrained (backward compatible). Live charging stays blocked at runtime + env.';

-- 2. Relax the claim RPC's live-mode refusal ONLY. Body is 0083 verbatim
--    except the removed live-mode guard block (marked below). security definer,
--    service_role-only, all other guards (reason / status / auth / PI-id /
--    idempotency / conditional claim) unchanged.
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

  -- PR #322: the live-mode refusal (`if v_row.stripe_livemode <> false then
  -- return not_ready`) that was here (0075/0083) is REMOVED so the RPC can
  -- claim live rows once they exist. Live charging is still blocked at runtime
  -- (executor live_mode_blocked + prepare-insert writes livemode=false) and env
  -- (STRIPE_ALLOW_LIVE_MODE unset). No live row is created until PR #323/#324.

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

-- Permission posture unchanged from 0083: service_role only (security definer).
revoke execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text)
  to service_role;
