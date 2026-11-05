-- 0249: PAY-001 staged-producer admission fence. SOURCE/DEPLOYMENT CONTRACT:
-- Apply FIRST under separate approval, then account/drain the finite pre-cutover
-- OLD function-body/transaction cohort BEFORE admitting any new v2 claim.
-- DDL commit does not stop an already-active PL/pgSQL invocation. Separately
-- retain queued RPC replies/paused callers/in-flight v1 SDK work per purpose and
-- mode, even if a row becomes terminal or provider-key retention has elapsed.
-- Keep this fence on application rollback. Old fresh charging intentionally
-- refuses; known-original reconciliation remains available. No backfill or
-- claim renewal, no new API/grant/table/column, no provider side effect here.
-- 0187 appointment-advisory -> attempt-row locks, authority, settlement, result
-- tuple (NO livemode column) and known-ID/terminal semantics remain unchanged.
-- 239/240/245 govern adjacent financial commands and are not replaced here.
begin;
set local lock_timeout = '5s';

-- Fail closed rather than silently creating a missing RPC or changing owner.
do $preflight$
declare p record;
begin
  select f.proowner, f.prosecdef, f.proconfig, l.lanname into p
    from pg_catalog.pg_proc f
    join pg_catalog.pg_language l on l.oid = f.prolang
   where f.oid = pg_catalog.to_regprocedure('public.claim_session_payment_charge_attempt(uuid,uuid,text)');
  if not found or pg_catalog.pg_get_userbyid(p.proowner) is distinct from 'postgres'
     or p.prosecdef is distinct from true or p.lanname is distinct from 'plpgsql'
     or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[] then
    raise exception '0249 requires the existing reviewed claim RPC owner and security contract';
  end if;
end;
$preflight$;

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
  v_appointment_id uuid;
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

  -- 0187. NON-LOCKING resolution of the appointment, so the advisory key can be
  -- computed BEFORE the `for update` below. Advisory first, row second.
  select coalesce(a.appointment_id, s.appointment_id)
    into v_appointment_id
    from public.payment_charge_attempts a
    left join public.sessions s
      on s.id = a.session_id
     and s.studio_id = a.studio_id
   where a.id = p_attempt_id;

  if v_appointment_id is not null then
    perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appointment_id));

    -- 0187. THE OTHER HALF OF THE MUTUAL EXCLUSION. A visit already recorded as
    -- paid in cash, by e-transfer, another way, or waived must not also be
    -- charged. `still_owes` deliberately does not block — see
    -- appointment_has_blocking_settlement.
    if public.appointment_has_blocking_settlement(
         (select a.studio_id from public.payment_charge_attempts a where a.id = p_attempt_id),
         v_appointment_id) then
      return query select 'settled_externally'::text, p_attempt_id, null::uuid,
        null::uuid, null::uuid, v_appointment_id, null::text, null::integer,
        null::text, null::uuid, null::uuid, null::text, null::text, null::text,
        null::text, null::text, null::text, null::timestamptz;
      return;
    end if;
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
    -- 0249: no pending missing-original row grants a create or confirm.
    -- Existing old callers understand not_ready and return before the SDK.
    -- Preserve the key, raw claim time and every ledger fact unchanged.
    if nullif(v_row.stripe_payment_intent_id, '') is null then
      return query select 'not_ready'::text, v_row.id, v_row.studio_id,
        v_row.client_id, v_row.session_id, v_row.appointment_id,
        v_row.charge_reason, v_row.amount_cents, v_row.currency,
        v_row.client_payment_method_id, v_row.card_authorization_signature_id,
        v_row.stripe_account_id, v_row.stripe_customer_id,
        v_row.stripe_payment_method_id, v_row.stripe_payment_intent_id,
        v_row.stripe_idempotency_key, v_row.status, v_row.updated_at;
      return;
    end if;
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

  -- 0249: fresh means no original, stored key, charge or charged timestamp.
  -- Derive the one admitted protocol key from this LOCKED row, never from
  -- a caller-supplied reason/UUID/version hint. Refuse without rekey/rearm.
  if v_row.stripe_payment_intent_id is not null
     or v_row.stripe_idempotency_key is not null
     or v_row.stripe_charge_id is not null
     or v_row.charged_at is not null
     or p_idempotency_key is distinct from
       ('hone:' || v_row.charge_reason || ':' || v_row.id::text || ':v2:create') then
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

-- Existing service-only surface: reset all four create-time default recipients
-- explicitly, then restore the SAME service_role EXECUTE (not a new grant).
revoke all privileges on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from public;
revoke all privileges on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from anon;
revoke all privileges on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from authenticated;
revoke all privileges on function public.claim_session_payment_charge_attempt(uuid, uuid, text) from service_role;
grant execute on function public.claim_session_payment_charge_attempt(uuid, uuid, text) to service_role;

do $verify$
declare v_function oid := pg_catalog.to_regprocedure('public.claim_session_payment_charge_attempt(uuid,uuid,text)');
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_function
       and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres' and p.prosecdef
       and p.proconfig = array['search_path=pg_catalog, pg_temp']::text[])
     or pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     or exists (
       select 1 from pg_catalog.pg_proc p,
         lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        where p.oid = v_function and
          (a.grantee not in (p.proowner, 'service_role'::regrole::oid)
           or a.privilege_type <> 'EXECUTE' or a.is_grantable)
     ) then
    raise exception '0249 claim RPC ownership or effective named-role EXECUTE contract differs';
  end if;
end;
$verify$;

commit;
