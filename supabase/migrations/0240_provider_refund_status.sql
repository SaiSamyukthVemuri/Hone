-- PAY-002: actual provider refund evidence; nullable legacy rows are untouched.
-- SOURCE ONLY; ordered after 0239. No backfill/default/provider effect.
begin;
set local lock_timeout = '5s';
alter table public.payment_charge_attempts
  add column stripe_refund_status text,
  add column stripe_refund_event_created bigint,
  add column stripe_refund_event_id text,
  add constraint payment_charge_attempts_provider_refund_status_check check (
    stripe_refund_status is null or stripe_refund_status in ('pending','requires_action','succeeded','failed','canceled')
  ),
  add constraint payment_charge_attempts_refund_event_pair_check check (
    (stripe_refund_event_created is null and stripe_refund_event_id is null)
    or (stripe_refund_event_created is not null and stripe_refund_event_created>=0 and stripe_refund_event_id is not null and length(stripe_refund_event_id)>0)
  );
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
  v_status text := nullif(p_object->>'refund_status','');
  v_event_created bigint;
  v_charge text := nullif(p_object->>'charge_id','');
  v_refund text := nullif(p_object->>'refund_id','');
begin
  if p_attempt_id is null or nullif(btrim(p_event_id),'') is null
     or p_event_type is null or p_event_type not in
       ('payment_intent.succeeded','payment_intent.payment_failed','charge.refunded',
        'refund.created','refund.updated','refund.failed','refund.observed')
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
     or (p_event_type in ('payment_intent.succeeded','charge.refunded','refund.created','refund.updated','refund.failed','refund.observed') and v_charge is null) then
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
    if v_row.status<>'succeeded' or v_row.stripe_charge_id is null
       or v_refund is null
       or (v_row.stripe_refund_id is not null and v_row.stripe_refund_id<>v_refund)
       or p_object->>'refund_amount_cents' is distinct from v_row.amount_cents::text
       or p_object->>'refund_currency' is distinct from v_row.currency
       or p_object->>'refund_charge_id' is distinct from v_row.stripe_charge_id
       or (v_status is not null and v_status not in ('pending','requires_action','succeeded','failed','canceled'))
       or (v_status is null and p_event_type<>'refund.observed') then
      v_result:='refund_evidence_refused';
    else
      if p_event_type='refund.observed' then
        if p_object->>'evidence_kind' is distinct from 'action_response' then
          return query select 'invalid_input'::text,v_row.id,v_appointment_id,v_row.studio_id,v_row.client_id,v_row.status;
          return;
        end if;
      else
        if p_object->>'evidence_kind' is distinct from 'signed_event'
           or coalesce(p_object->>'event_created','') !~ '^[0-9]{1,12}$' then
          return query select 'invalid_input'::text,v_row.id,v_appointment_id,v_row.studio_id,v_row.client_id,v_row.status;
          return;
        end if;
        v_event_created:=(p_object->>'event_created')::bigint;
      end if;

      -- Refund objects are terminal once succeeded/failed/canceled. A delayed
      -- nonterminal event or synchronous response may not undo that fact.
      if v_event_created is not null and v_row.stripe_refund_event_id=p_event_id then
        v_result:=case when v_row.refund_status='succeeded' then 'already_refunded' else 'already_observed' end;
      elsif v_row.refund_status='succeeded' and v_status is distinct from 'succeeded' then
        v_result:='stale_observation';
      elsif v_row.stripe_refund_event_created is not null
            and (v_event_created is null or v_event_created<v_row.stripe_refund_event_created
                 or (v_event_created=v_row.stripe_refund_event_created
                     and v_status in ('pending','requires_action')
                     and v_status is distinct from v_row.stripe_refund_status)) then
        v_result:='stale_observation';
      elsif v_row.stripe_refund_status in ('succeeded','failed','canceled')
            and v_status is distinct from v_row.stripe_refund_status then
        v_result:='terminal_refund_mismatch';
      elsif v_status is null and v_row.stripe_refund_status is not null then
        v_result:='stale_observation';
      else
        update public.payment_charge_attempts a
          set stripe_refund_id=v_refund,
              stripe_refund_status=v_status,
              stripe_refund_event_id=case when v_event_created is null then a.stripe_refund_event_id else p_event_id end,
              stripe_refund_event_created=coalesce(v_event_created,a.stripe_refund_event_created),
              refund_status=case when v_status='succeeded' then 'succeeded'
                                 when v_status in ('failed','canceled') then 'failed' else 'pending_stripe' end,
              refund_amount_cents=v_row.amount_cents,
              refunded_at=case when v_status='succeeded' then coalesce(a.refunded_at,now()) else null end,
              refund_failure_code=case when v_status in ('failed','canceled') then 'provider_refund_'||v_status else null end,
              refund_failure_message_safe=case when v_status in ('failed','canceled') then 'Stripe did not complete this refund.' else null end
          where a.id=v_row.id;
        v_result:=case when v_status='succeeded' and v_row.refund_status='succeeded' then 'already_refunded'
                       when v_status='succeeded' then 'reconciled'
                       when v_status in ('failed','canceled') then 'refund_failed' else 'refund_pending' end;
      end if;
    end if;
  end if;
  return query select v_result,v_row.id,v_appointment_id,v_row.studio_id,v_row.client_id,v_row.status;
end;
$$;

revoke all privileges on function public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb) to service_role;
comment on column public.payment_charge_attempts.stripe_refund_status is
  'Actual allowlisted provider Refund status, bound to the stored original account/customer/PI/charge/refund. NULL is unobserved legacy or unknown action response, never implicit success. Local refund_status retains existing reader semantics.';
comment on column public.payment_charge_attempts.stripe_refund_event_created is
  'Signed provider event creation seconds; nullable for legacy/action-only observation. Older events and unordered action responses cannot regress newer evidence or terminal truth.';
commit;
