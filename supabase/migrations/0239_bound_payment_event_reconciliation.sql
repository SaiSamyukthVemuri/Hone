-- PAY-001. Signed provider events must also match the durable payment identity.
-- SOURCE ONLY. Requires coordinated app rollout: the old unbound RPC is closed.
-- No backfill, historical money rewrite, tenant grant or provider side effect.
begin;
set local lock_timeout = '5s';

-- Retain the reviewed 0187 implementation as a private internal command. It
-- owns the appointment mutex/settlement refusal; old apps may no longer call it.
revoke all privileges on function public.reconcile_card_payment_succeeded(uuid,text,text)
  from public, anon, authenticated, service_role;

create or replace function public.reconcile_bound_payment_event(
  p_attempt_id uuid,
  p_event_id text,
  p_event_type text,
  p_studio_id uuid,
  p_stripe_account_id text,
  p_livemode boolean,
  p_object jsonb
)
returns table(result text, attempt_id uuid, appointment_id uuid, studio_id uuid,
              client_id uuid, status_before text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appointment_id uuid;
  v_row public.payment_charge_attempts%rowtype;
  v_result text;
  v_charge text := nullif(p_object->>'charge_id','');
  v_refund text := nullif(p_object->>'refund_id','');
begin
  if p_attempt_id is null or nullif(btrim(p_event_id),'') is null
     or p_event_type is null or p_event_type not in
       ('payment_intent.succeeded','payment_intent.payment_failed','charge.refunded')
     or jsonb_typeof(p_object) is distinct from 'object' then
    return query select 'invalid_input'::text,null::uuid,null::uuid,null::uuid,null::uuid,null::text;
    return;
  end if;

  -- Exactly the 0187 order: appointment advisory mutex BEFORE attempt row lock.
  select coalesce(a.appointment_id,s.appointment_id) into v_appointment_id
    from public.payment_charge_attempts a
    left join public.sessions s on s.id=a.session_id and s.studio_id=a.studio_id
    where a.id=p_attempt_id;
  if v_appointment_id is not null then
    perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appointment_id));
  end if;
  select * into v_row from public.payment_charge_attempts a
    where a.id=p_attempt_id for update;
  if not found then
    return query select 'not_found'::text,null::uuid,null::uuid,null::uuid,null::uuid,null::text;
    return;
  end if;

  -- Metadata is not authority. Missing original provider identity is unresolved,
  -- never permission to bind a different provider object from a signed event.
  if p_studio_id is distinct from v_row.studio_id
     or nullif(p_stripe_account_id,'') is null
     or p_stripe_account_id is distinct from v_row.stripe_account_id
     or p_livemode is null or p_livemode is distinct from v_row.stripe_livemode
     or nullif(v_row.stripe_customer_id,'') is null
     or p_object->>'customer_id' is distinct from v_row.stripe_customer_id
     or nullif(v_row.stripe_payment_intent_id,'') is null
     or p_object->>'payment_intent_id' is distinct from v_row.stripe_payment_intent_id
     or p_object->>'amount_cents' is distinct from v_row.amount_cents::text
     or p_object->>'currency' is distinct from v_row.currency
     or (v_row.stripe_charge_id is not null and v_charge is distinct from v_row.stripe_charge_id)
     or (p_event_type in ('payment_intent.succeeded','charge.refunded') and v_charge is null) then
    return query select 'identity_mismatch'::text,v_row.id,v_appointment_id,v_row.studio_id,v_row.client_id,v_row.status;
    return;
  end if;

  if p_event_type='payment_intent.succeeded' then
    -- Reentrant advisory/row locks preserve the original settlement diagnosis.
    select r.result into v_result from public.reconcile_card_payment_succeeded(
      v_row.id,v_row.stripe_payment_intent_id,v_charge) r;
    if v_result='already_succeeded' and v_row.stripe_charge_id is null then
      update public.payment_charge_attempts a set stripe_charge_id=v_charge
        where a.id=v_row.id and a.stripe_charge_id is null;
    end if;
  elsif p_event_type='payment_intent.payment_failed' then
    if v_row.status='succeeded' then v_result:='local_succeeded_mismatch';
    elsif v_row.status='failed' then v_result:='already_failed';
    elsif v_row.status in ('cancelled','blocked') then v_result:='terminal_mismatch';
    elsif v_row.status in ('ready','pending_stripe') then
      update public.payment_charge_attempts a
        set status='failed',failed_at=now(),
            failure_code=left(p_object->>'failure_code',100),
            failure_message_safe=left(p_object->>'failure_message_safe',500)
        where a.id=v_row.id and a.status in ('ready','pending_stripe');
      v_result:='reconciled';
    else v_result:='zero_rows'; end if;
  else
    -- Charge-level totals alone do not prove a particular refund succeeded.
    -- 0240 adds durable actual-status/event provenance; this command already
    -- refuses pending/requires_action/unknown or a different refund object.
    if v_row.status<>'succeeded' or v_row.stripe_charge_id is null
       or v_refund is null
       or (v_row.stripe_refund_id is not null and v_row.stripe_refund_id<>v_refund)
       or p_object->>'refund_amount_cents' is distinct from v_row.amount_cents::text
       or p_object->>'refund_currency' is distinct from v_row.currency
       or p_object->>'refund_charge_id' is distinct from v_row.stripe_charge_id
       or p_object->>'refund_status' is distinct from 'succeeded' then
      v_result:='refund_evidence_refused';
    elsif v_row.refund_status='succeeded' then v_result:='already_refunded';
    else
      update public.payment_charge_attempts a
        set refund_status='succeeded',stripe_refund_id=v_refund,
            refund_amount_cents=v_row.amount_cents,refunded_at=now(),
            refund_failure_code=null,refund_failure_message_safe=null
        where a.id=v_row.id;
      v_result:='reconciled';
    end if;
  end if;
  return query select v_result,v_row.id,v_appointment_id,v_row.studio_id,v_row.client_id,v_row.status;
end;
$$;

revoke all privileges on function public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb)
  to service_role;
comment on function public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb) is
  'PAY-001: service-only signed-event reconciliation bound to the original durable studio/account/mode/customer/PI/charge/amount/currency. Appointment mutex then attempt lock; old unbound RPC private. Missing original identity refuses; no metadata override or provider effects. Requires coordinated application rollout.';
commit;
