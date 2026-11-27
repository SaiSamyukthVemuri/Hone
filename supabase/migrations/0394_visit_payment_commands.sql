-- ===========================================================================
-- 0394: VISIT PAYMENT COMMANDS — split payments and partial refunds (HON-123 / HON-122), step 2 of 3
-- ===========================================================================
--
-- WHAT THIS IS. The commands and guards over the 0393 ledger tables. Nothing here changes a visit that has no bill: a visit
-- is split only when a bill is created for it, and a bill can be created only for a studio whose `split_payments` rollout is
-- on (default OFF, pilot only). Existing single-payment visits, the settlement commands and Canada are untouched.
--
-- THE MONEY RULE, ONE PLACE. Under the visit's own advisory lock (appointment_settlement_lock_key, the lock the settlement
-- commands already take):
--   outstanding = bill total - (confirmed external + PENDING external + card attempts ready/pending_stripe/succeeded - refunds
--                 pending or succeeded)
-- A PENDING TRANSFER RESERVES ITS AMOUNT from the moment it is recorded (Sam, 27 Nov 2026): it shows as still owed, but no other
-- tender can take that money. A card charge or another payment that would exceed the outstanding amount is REFUSED before any
-- Stripe call: 'reserved_for_pending_transfer' when the pending transfer is what blocks it, 'exceeds_balance' otherwise. Only an
-- explicit void of the transfer makes the amount collectable again; confirming it settles it. So no click order lets a card
-- through, and the total collected can never pass the bill.
--
-- WHAT IT ADDS.
--   1. the `split_payments` platform rollout key (reuses 0362; modes off and pilot only).
--   2. payment_charge_attempts.visit_bill_id and .submission_id (a repeated prepare returns the first attempt) and the one-
--      active-card-attempt-per-session index limited to visits WITHOUT a bill (a billed visit may have several card payments;
--      the over-collection guard below is their wall).
--   3. a BEFORE INSERT guard on payment_charge_attempts for a session payment on a billed visit: it stamps the bill and
--      applies the money rule at the moment the attempt row is made, which is before any Stripe call.
--   4. commands: ensure_visit_bill, record_visit_external_payment, confirm_visit_external_payment, void_visit_external_payment,
--      request_payment_refund, finish_payment_refund (service role: records Stripe's outcome), get_visit_payment_position.
-- Every command is SECURITY DEFINER with a fixed search_path; EXECUTE is revoked from public, anon, authenticated AND
-- service_role by name, then granted to authenticated (staff commands) or service_role (the Stripe outcome) only.
--
-- WHAT IT DOES NOT DO. It does not edit 0187's settlement commands (frozen): the application does not call them for a billed
-- visit, and ensure_visit_bill refuses a visit that already has a settlement or a card payment. Webhook reconciliation of
-- partial refunds is 0395.
-- ===========================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.visit_bills') is null or to_regclass('public.payment_refunds') is null
     or to_regclass('public.visit_external_payments') is null then
    raise exception '0394: 0393 is not applied; refusing' using errcode = '55000';
  end if;
  if to_regclass('public.platform_rollouts') is null then
    raise exception '0394: platform_rollouts (0362) is missing; refusing' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The rollout key (reuses 0362). 'front_desk' (0390) is kept in the list when it exists.
-- ---------------------------------------------------------------------------
alter table public.platform_rollouts drop constraint platform_rollouts_key_check;
alter table public.platform_rollouts
  add constraint platform_rollouts_key_check check (key in ('charting_new_view_xcell', 'front_desk', 'split_payments'));
alter table public.platform_rollouts
  add constraint platform_rollouts_split_payments_mode_check check (key <> 'split_payments' or mode in ('off', 'pilot'));
insert into public.platform_rollouts (key) values ('split_payments');

-- ---------------------------------------------------------------------------
-- 2. Attempt columns and the index
-- ---------------------------------------------------------------------------
alter table public.payment_charge_attempts add column visit_bill_id uuid references public.visit_bills (id) on delete restrict;
alter table public.payment_charge_attempts add column submission_id uuid;
create unique index payment_charge_attempts_submission_key on public.payment_charge_attempts (studio_id, submission_id) where submission_id is not null;
comment on column public.payment_charge_attempts.visit_bill_id is
  '0394. The live bill of the visit when this card payment was prepared. null = a legacy single-payment visit.';
comment on column public.payment_charge_attempts.submission_id is
  '0394. Chosen by the browser once per submission and kept across retries: a repeated prepare returns the first attempt.';

drop index public.payment_charge_attempts_active_session_payment_uniq;
create unique index payment_charge_attempts_active_session_payment_uniq
  on public.payment_charge_attempts (session_id, stripe_livemode)
  where session_id is not null
    and charge_reason = 'session_payment'
    and status in ('ready', 'pending_stripe', 'succeeded')
    and visit_bill_id is null;

-- ---------------------------------------------------------------------------
-- 3. The position of a visit (one definition of "how much is still collectable")
-- ---------------------------------------------------------------------------
create function public.visit_payment_position(p_studio uuid, p_appointment uuid)
returns table (bill_id uuid, currency text, total_cents integer, confirmed_cents integer, pending_cents integer,
               card_cents integer, refunded_cents integer, outstanding_cents integer)
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select b.id, b.currency, b.total_cents,
         x.confirmed, x.pending, c.card, r.refunded,
         greatest(0, b.total_cents - x.confirmed - x.pending - c.card + r.refunded)
    from public.visit_bills b
    cross join lateral (
      select coalesce(sum(e.amount_cents) filter (where e.state = 'confirmed'), 0)::integer as confirmed,
             coalesce(sum(e.amount_cents) filter (where e.state = 'pending_confirmation'), 0)::integer as pending
        from public.visit_external_payments e
       where e.studio_id = p_studio and e.appointment_id = p_appointment) x
    cross join lateral (
      select coalesce(sum(a.amount_cents), 0)::integer as card
        from public.payment_charge_attempts a
       where a.studio_id = p_studio and a.appointment_id = p_appointment and a.charge_reason = 'session_payment'
         and a.visit_bill_id is not null and a.status in ('ready', 'pending_stripe', 'succeeded')) c
    cross join lateral (
      select coalesce(sum(f.amount_cents), 0)::integer as refunded
        from public.payment_refunds f
       where f.studio_id = p_studio and f.appointment_id = p_appointment and f.status in ('pending_stripe', 'succeeded')
         and (f.external_payment_id is not null
              or exists (select 1 from public.payment_charge_attempts a2 where a2.id = f.attempt_id and a2.visit_bill_id is not null))) r
   where b.studio_id = p_studio and b.appointment_id = p_appointment and b.superseded_at is null;
$$;
revoke all privileges on function public.visit_payment_position(uuid, uuid) from public, anon, authenticated, service_role;

-- The reason a tender of p_amount is refused, or null when it fits. Pending transfers are what 'reserved' refers to.
create function public.visit_payment_refusal(p_studio uuid, p_appointment uuid, p_amount integer)
returns text
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  p record;
begin
  select * into p from public.visit_payment_position(p_studio, p_appointment);
  if not found then return 'no_bill'; end if;
  if p_amount <= p.outstanding_cents then return null; end if;
  if p.pending_cents > 0 and p_amount <= p.outstanding_cents + p.pending_cents then return 'reserved_for_pending_transfer'; end if;
  return 'exceeds_balance';
end;
$$;
revoke all privileges on function public.visit_payment_refusal(uuid, uuid, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The card wall: stamps the bill and applies the money rule when the attempt row is made (before any Stripe call)
-- ---------------------------------------------------------------------------
create function public.payment_charge_attempts_visit_bill_guard() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_bill uuid;
  v_currency text;
  v_refusal text;
begin
  if new.charge_reason <> 'session_payment' or new.appointment_id is null or new.status not in ('ready', 'pending_stripe', 'succeeded') then
    return new;
  end if;
  select b.id, b.currency into v_bill, v_currency
    from public.visit_bills b where b.studio_id = new.studio_id and b.appointment_id = new.appointment_id and b.superseded_at is null;
  if v_bill is null then
    return new;                       -- a legacy visit: exactly the behaviour it always had
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(new.appointment_id));
  -- The bill may have been replaced while we waited for the lock: read it again under the lock.
  select b.id, b.currency into v_bill, v_currency
    from public.visit_bills b where b.studio_id = new.studio_id and b.appointment_id = new.appointment_id and b.superseded_at is null;
  if v_bill is null then
    return new;
  end if;
  if new.currency is distinct from v_currency then
    raise exception 'payment_currency_mismatch: the card amount is not in the bill currency' using errcode = 'PY003';
  end if;
  v_refusal := public.visit_payment_refusal(new.studio_id, new.appointment_id, new.amount_cents);
  if v_refusal = 'reserved_for_pending_transfer' then
    raise exception 'reserved_for_pending_transfer: This amount is reserved for a pending transfer' using errcode = 'PY001';
  elsif v_refusal is not null then
    raise exception '%: this amount is more than the balance of the visit', v_refusal using errcode = 'PY002';
  end if;
  new.visit_bill_id := v_bill;
  return new;
end;
$$;
revoke all privileges on function public.payment_charge_attempts_visit_bill_guard() from public, anon, authenticated, service_role;
create trigger payment_charge_attempts_visit_bill_guard_trg before insert on public.payment_charge_attempts
  for each row execute function public.payment_charge_attempts_visit_bill_guard();

-- ---------------------------------------------------------------------------
-- 5. Staff commands
-- ---------------------------------------------------------------------------
create function public.ensure_visit_bill(
  p_studio_id uuid, p_appointment_id uuid, p_final_cents integer, p_fee_adjustment_reason text, p_livemode boolean
) returns table (result text, bill_id uuid, total_cents integer, currency text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_status text;
  v_quote integer;
  v_total integer;
  v_ccy text;
  v_reason text := nullif(btrim(p_fee_adjustment_reason), '');
  v_new uuid;
  v_live public.visit_bills%rowtype;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if p_appointment_id is null or (p_final_cents is not null and p_final_cents not between 0 and 200000)
     or (v_reason is not null and length(v_reason) > 200) then
    return query select 'invalid_input'::text, null::uuid, null::integer, null::text; return;
  end if;
  if not public.platform_rollout_enabled_for('split_payments', p_studio_id) then
    return query select 'split_payments_off'::text, null::uuid, null::integer, null::text; return;
  end if;
  select a.status into v_status from public.appointments a where a.id = p_appointment_id and a.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));
  select * into v_live from public.visit_bills b where b.studio_id = p_studio_id and b.appointment_id = p_appointment_id and b.superseded_at is null;
  if found then
    return query select 'exists'::text, v_live.id, v_live.total_cents, v_live.currency; return;
  end if;
  select a.status into v_status from public.appointments a where a.id = p_appointment_id and a.studio_id = p_studio_id for share;
  if v_status is distinct from 'completed' then
    return query select 'not_completed'::text, null::uuid, null::integer, null::text; return;
  end if;
  if exists (select 1 from public.appointment_settlements s where s.studio_id = p_studio_id and s.appointment_id = p_appointment_id and s.superseded_at is null) then
    return query select 'already_settled'::text, null::uuid, null::integer, null::text; return;
  end if;
  if public.appointment_has_live_card_money(p_studio_id, p_appointment_id, coalesce(p_livemode, true)) then
    return query select 'card_payment_exists'::text, null::uuid, null::integer, null::text; return;
  end if;
  v_quote := public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id);
  if v_quote is null then
    return query select 'price_missing'::text, null::uuid, null::integer, null::text; return;
  end if;
  v_total := coalesce(p_final_cents, v_quote);
  if v_total is distinct from v_quote then
    if not public.is_studio_owner(p_studio_id) then
      return query select 'not_owner'::text, null::uuid, null::integer, null::text; return;
    end if;
    if v_reason is null or v_quote not between 1 and 200000 then
      return query select 'invalid_input'::text, null::uuid, null::integer, null::text; return;
    end if;
  elsif v_reason is not null then
    v_reason := null;
  end if;
  select j.payment_currency into v_ccy from public.studio_payment_jurisdictions j where j.studio_id = p_studio_id for share;
  if not found then
    return query select 'payment_jurisdiction_missing'::text, null::uuid, null::integer, null::text; return;
  end if;
  insert into public.visit_bills as b (studio_id, appointment_id, currency, total_cents, reference_fee_cents, fee_adjustment_reason, created_by_practitioner_id)
  values (p_studio_id, p_appointment_id, v_ccy, v_total, case when v_total is distinct from v_quote then v_quote end, v_reason, actor)
  returning b.id into v_new;
  return query select 'created'::text, v_new, v_total, v_ccy;
end;
$$;

create function public.record_visit_external_payment(
  p_studio_id uuid, p_appointment_id uuid, p_method text, p_amount_cents integer, p_submission_id uuid, p_note text
) returns table (result text, payment_id uuid, state text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_bill public.visit_bills%rowtype;
  v_country text;
  v_note text := nullif(btrim(p_note), '');
  v_state text;
  v_refusal text;
  v_prior public.visit_external_payments%rowtype;
  v_id uuid;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if p_appointment_id is null or p_submission_id is null
     or p_method is null or p_method not in ('paid_cash', 'paid_e_transfer', 'paid_other_external')
     or p_amount_cents is null or p_amount_cents not between 1 and 200000
     or (v_note is not null and length(v_note) > 500) then
    return query select 'invalid_input'::text, null::uuid, null::text; return;
  end if;
  if not public.platform_rollout_enabled_for('split_payments', p_studio_id) then
    return query select 'split_payments_off'::text, null::uuid, null::text; return;
  end if;
  if not exists (select 1 from public.appointments a where a.id = p_appointment_id and a.studio_id = p_studio_id) then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));
  -- A repeated submit (double click, retry, lost response) returns the first row and writes nothing.
  select * into v_prior from public.visit_external_payments e where e.studio_id = p_studio_id and e.submission_id = p_submission_id;
  if found then
    if v_prior.appointment_id is distinct from p_appointment_id or v_prior.method is distinct from p_method or v_prior.amount_cents is distinct from p_amount_cents then
      return query select 'submission_reused'::text, null::uuid, null::text; return;
    end if;
    return query select 'already_recorded'::text, v_prior.id, v_prior.state; return;
  end if;
  select * into v_bill from public.visit_bills b where b.studio_id = p_studio_id and b.appointment_id = p_appointment_id and b.superseded_at is null;
  if not found then
    return query select 'no_bill'::text, null::uuid, null::text; return;
  end if;
  select j.payment_country into v_country from public.studio_payment_jurisdictions j where j.studio_id = p_studio_id for share;
  if p_method = 'paid_e_transfer' and v_country = 'US' then
    return query select 'method_unavailable'::text, null::uuid, null::text; return;   -- 0224: a US studio records paid_other_external
  end if;
  v_refusal := public.visit_payment_refusal(p_studio_id, p_appointment_id, p_amount_cents);
  if v_refusal is not null then
    return query select v_refusal, null::uuid, null::text; return;
  end if;
  v_state := case when p_method = 'paid_cash' then 'confirmed' else 'pending_confirmation' end;
  insert into public.visit_external_payments as e (studio_id, appointment_id, bill_id, method, amount_cents, currency, state, submission_id,
                                                   recorded_by_practitioner_id, confirmed_by_practitioner_id, note)
  values (p_studio_id, p_appointment_id, v_bill.id, p_method, p_amount_cents, v_bill.currency, v_state, p_submission_id, actor,
          case when v_state = 'confirmed' then actor end, v_note)
  returning e.id into v_id;
  return query select 'recorded'::text, v_id, v_state;
end;
$$;

create function public.confirm_visit_external_payment(p_studio_id uuid, p_payment_id uuid)
returns table (result text, payment_id uuid, state text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_appt uuid;
  e public.visit_external_payments%rowtype;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if p_payment_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text; return;
  end if;
  select x.appointment_id into v_appt from public.visit_external_payments x where x.id = p_payment_id and x.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appt));
  select * into e from public.visit_external_payments x where x.id = p_payment_id and x.studio_id = p_studio_id for update;
  if e.state = 'confirmed' then
    return query select 'already_confirmed'::text, e.id, e.state; return;
  elsif e.state = 'voided' then
    return query select 'voided'::text, e.id, e.state; return;
  end if;
  -- The amount was reserved when the transfer was recorded, so confirming never adds to what is committed.
  update public.visit_external_payments set state = 'confirmed', confirmed_by_practitioner_id = actor where id = e.id;
  return query select 'confirmed'::text, e.id, 'confirmed'::text;
end;
$$;

create function public.void_visit_external_payment(p_studio_id uuid, p_payment_id uuid, p_reason text)
returns table (result text, payment_id uuid, state text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_appt uuid;
  v_reason text := nullif(btrim(p_reason), '');
  e public.visit_external_payments%rowtype;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if p_payment_id is null or v_reason is null or length(v_reason) > 500 then
    return query select 'invalid_input'::text, null::uuid, null::text; return;
  end if;
  select x.appointment_id into v_appt from public.visit_external_payments x where x.id = p_payment_id and x.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appt));
  select * into e from public.visit_external_payments x where x.id = p_payment_id and x.studio_id = p_studio_id for update;
  if e.state = 'confirmed' then
    return query select 'confirmed_is_final'::text, e.id, e.state; return;   -- money returned later is a refund, not a void
  elsif e.state = 'voided' then
    return query select 'already_voided'::text, e.id, e.state; return;
  end if;
  update public.visit_external_payments set state = 'voided', voided_by_practitioner_id = actor, void_reason = v_reason where id = e.id;
  return query select 'voided'::text, e.id, 'voided'::text;
end;
$$;

-- Bill versions: retire the live bill, then insert its successor (the live-bill unique index is immediate; the superseded_by FK is deferred).
create function public.visit_bill_supersede(p_studio uuid, p_appointment uuid, p_new_total integer, p_reason text, p_actor uuid)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  o public.visit_bills%rowtype;
  v_new uuid := gen_random_uuid();
begin
  select * into o from public.visit_bills b where b.studio_id = p_studio and b.appointment_id = p_appointment and b.superseded_at is null for update;
  if not found then raise exception 'visit_bills: no live bill to supersede' using errcode = '23514'; end if;
  update public.visit_bills set superseded_at = now(), superseded_by_id = v_new where id = o.id;
  insert into public.visit_bills (id, studio_id, appointment_id, currency, total_cents, reference_fee_cents, fee_adjustment_reason,
                                  created_by_practitioner_id, supersedes_id, supersede_reason)
  values (v_new, o.studio_id, o.appointment_id, o.currency, p_new_total, o.reference_fee_cents, o.fee_adjustment_reason,
          p_actor, o.id, p_reason);
  return v_new;
end;
$$;
revoke all privileges on function public.visit_bill_supersede(uuid, uuid, integer, text, uuid) from public, anon, authenticated, service_role;

create function public.request_payment_refund(
  p_studio_id uuid, p_appointment_id uuid, p_attempt_id uuid, p_external_payment_id uuid,
  p_amount_cents integer, p_kind text, p_reason text, p_submission_id uuid
) returns table (result text, refund_id uuid, status text, bill_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_ccy text;
  v_appt uuid;
  v_refundable integer;
  v_bill public.visit_bills%rowtype;
  v_new_bill uuid;
  v_status text;
  v_prior public.payment_refunds%rowtype;
  v_id uuid;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::text, null::uuid; return;
  end if;
  if p_appointment_id is null or p_submission_id is null or (p_attempt_id is null) = (p_external_payment_id is null)
     or p_amount_cents is null or p_amount_cents not between 1 and 200000
     or p_kind is null or p_kind not in ('price_reduction', 'payment_reversal')
     or v_reason is null or length(v_reason) > 500 then
    return query select 'invalid_input'::text, null::uuid, null::text, null::uuid; return;
  end if;
  if not public.platform_rollout_enabled_for('split_payments', p_studio_id) then
    return query select 'split_payments_off'::text, null::uuid, null::text, null::uuid; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));
  select * into v_prior from public.payment_refunds r where r.studio_id = p_studio_id and r.submission_id = p_submission_id;
  if found then
    if v_prior.amount_cents is distinct from p_amount_cents or v_prior.appointment_id is distinct from p_appointment_id
       or v_prior.attempt_id is distinct from p_attempt_id or v_prior.external_payment_id is distinct from p_external_payment_id then
      return query select 'submission_reused'::text, null::uuid, null::text, null::uuid; return;
    end if;
    return query select 'already_requested'::text, v_prior.id, v_prior.status, v_prior.reduced_bill_id; return;
  end if;
  select * into v_bill from public.visit_bills b where b.studio_id = p_studio_id and b.appointment_id = p_appointment_id and b.superseded_at is null;
  if not found then
    return query select 'no_bill'::text, null::uuid, null::text, null::uuid; return;
  end if;
  if p_attempt_id is not null then
    select a.appointment_id, a.currency into v_appt, v_ccy from public.payment_charge_attempts a
     where a.id = p_attempt_id and a.studio_id = p_studio_id and a.status = 'succeeded' and a.visit_bill_id is not null;
  else
    select e.appointment_id, e.currency into v_appt, v_ccy from public.visit_external_payments e
     where e.id = p_external_payment_id and e.studio_id = p_studio_id and e.state = 'confirmed';
  end if;
  if not found or v_appt is distinct from p_appointment_id then
    return query select 'payment_not_refundable'::text, null::uuid, null::text, null::uuid; return;
  end if;
  v_refundable := public.payment_refundable_cents(p_attempt_id, p_external_payment_id);
  if v_refundable is null or p_amount_cents > v_refundable then
    return query select 'exceeds_refundable'::text, null::uuid, null::text, null::uuid; return;
  end if;
  if p_kind = 'price_reduction' then
    if p_amount_cents > v_bill.total_cents then
      return query select 'exceeds_bill'::text, null::uuid, null::text, null::uuid; return;
    end if;
    v_new_bill := public.visit_bill_supersede(p_studio_id, p_appointment_id, v_bill.total_cents - p_amount_cents, v_reason, actor);
  end if;
  v_status := case when p_attempt_id is not null then 'pending_stripe' else 'succeeded' end;
  insert into public.payment_refunds as r (studio_id, appointment_id, attempt_id, external_payment_id, amount_cents, currency, kind, reason, status,
                                           reduced_bill_id, submission_id, requested_by_practitioner_id, confirmed_by_practitioner_id)
  values (p_studio_id, p_appointment_id, p_attempt_id, p_external_payment_id, p_amount_cents, v_ccy, p_kind, v_reason, v_status,
          v_new_bill, p_submission_id, actor, case when p_external_payment_id is not null then actor end)
  returning r.id into v_id;
  return query select 'requested'::text, v_id, v_status, v_new_bill;
end;
$$;

-- Stripe's outcome of a card refund (the application calls this after the Stripe call, with the service role).
create function public.finish_payment_refund(
  p_refund_id uuid, p_outcome text, p_stripe_refund_id text, p_stripe_refund_status text,
  p_failure_code text, p_failure_message_safe text, p_platform_fee_returned_cents integer
) returns table (result text, refund_id uuid, status text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  r public.payment_refunds%rowtype;
  v_live public.visit_bills%rowtype;
begin
  if p_refund_id is null or p_outcome is null or p_outcome not in ('succeeded', 'failed') then
    return query select 'invalid_input'::text, null::uuid, null::text; return;
  end if;
  select x.appointment_id into r.appointment_id from public.payment_refunds x where x.id = p_refund_id and x.attempt_id is not null and not x.legacy;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(r.appointment_id));
  select * into r from public.payment_refunds x where x.id = p_refund_id for update;
  if r.status <> 'pending_stripe' then
    return query select 'already_settled'::text, r.id, r.status; return;     -- a replayed outcome changes nothing
  end if;
  if p_outcome = 'succeeded' then
    update public.payment_refunds
       set status = 'succeeded', stripe_refund_id = p_stripe_refund_id, stripe_refund_status = p_stripe_refund_status,
           platform_fee_returned_cents = p_platform_fee_returned_cents
     where id = r.id;
  else
    update public.payment_refunds
       set status = 'failed', stripe_refund_id = p_stripe_refund_id, stripe_refund_status = p_stripe_refund_status,
           failure_code = left(p_failure_code, 100), failure_message_safe = left(p_failure_message_safe, 1000)
     where id = r.id;
    -- A failed price reduction gives the price back: the bill returns by the same amount (a new version, never an edit).
    if r.kind = 'price_reduction' then
      select * into v_live from public.visit_bills b where b.studio_id = r.studio_id and b.appointment_id = r.appointment_id and b.superseded_at is null;
      if found then
        perform public.visit_bill_supersede(r.studio_id, r.appointment_id, least(200000, v_live.total_cents + r.amount_cents),
                                            'Card refund failed: the price reduction was reversed', r.requested_by_practitioner_id);
      end if;
    end if;
  end if;
  return query select p_outcome, r.id, p_outcome;
end;
$$;

-- The one read the screens use. Members of the studio only.
create function public.get_visit_payment_position(p_studio_id uuid, p_appointment_id uuid)
returns table (bill_id uuid, currency text, total_cents integer, confirmed_cents integer, pending_cents integer,
               card_cents integer, refunded_cents integer, outstanding_cents integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_member(p_studio_id) then
    return;
  end if;
  return query select * from public.visit_payment_position(p_studio_id, p_appointment_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants: all four default-granted roles revoked BY NAME, then only what is needed
-- ---------------------------------------------------------------------------
revoke all privileges on function public.ensure_visit_bill(uuid, uuid, integer, text, boolean) from public, anon, authenticated, service_role;
revoke all privileges on function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.confirm_visit_external_payment(uuid, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.void_visit_external_payment(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.finish_payment_refund(uuid, text, text, text, text, text, integer) from public, anon, authenticated, service_role;
revoke all privileges on function public.get_visit_payment_position(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.ensure_visit_bill(uuid, uuid, integer, text, boolean) to authenticated;
grant execute on function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.confirm_visit_external_payment(uuid, uuid) to authenticated;
grant execute on function public.void_visit_external_payment(uuid, uuid, text) to authenticated;
grant execute on function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid) to authenticated;
grant execute on function public.get_visit_payment_position(uuid, uuid) to authenticated;
grant execute on function public.finish_payment_refund(uuid, text, text, text, text, text, integer) to service_role;

comment on function public.visit_payment_position(uuid, uuid) is '0394. The one definition of how much of a billed visit is still collectable. Internal.';
comment on function public.visit_payment_refusal(uuid, uuid, integer) is '0394. Why a tender of this amount is refused (reserved_for_pending_transfer, exceeds_balance, no_bill) or null. Internal.';
comment on function public.ensure_visit_bill(uuid, uuid, integer, text, boolean) is '0394. Creates the one bill of a completed visit (split_payments studios only); idempotent.';
comment on function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text) is '0394. Records cash (confirmed) or a transfer (pending, amount reserved); a repeated submission returns the first row.';
comment on function public.confirm_visit_external_payment(uuid, uuid) is '0394. Confirms a pending transfer once.';
comment on function public.void_visit_external_payment(uuid, uuid, text) is '0394. Voids a pending transfer, which releases its amount; a confirmed payment is final.';
comment on function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid) is '0394. Owner-only. One refund against one selected payment; card refunds start pending_stripe, external refunds are recorded at once.';
comment on function public.finish_payment_refund(uuid, text, text, text, text, text, integer) is '0394. Service role: records Stripe''s outcome of a card refund once; a replay changes nothing.';
comment on function public.get_visit_payment_position(uuid, uuid) is '0394. Members of the studio read the collectable position of a billed visit.';

-- Self-check: nothing is executable by anon or public; only the intended roles can run each command.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ensure_visit_bill(uuid,uuid,integer,text,boolean)',
    'public.record_visit_external_payment(uuid,uuid,text,integer,uuid,text)',
    'public.confirm_visit_external_payment(uuid,uuid)',
    'public.void_visit_external_payment(uuid,uuid,text)',
    'public.request_payment_refund(uuid,uuid,uuid,uuid,integer,text,text,uuid)',
    'public.get_visit_payment_position(uuid,uuid)',
    'public.finish_payment_refund(uuid,text,text,text,text,text,integer)',
    'public.visit_payment_position(uuid,uuid)',
    'public.visit_payment_refusal(uuid,uuid,integer)',
    'public.visit_bill_supersede(uuid,uuid,integer,text,uuid)',
    'public.payment_charge_attempts_visit_bill_guard()'] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0394: anon can execute %', f using errcode = '55000';
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.finish_payment_refund(uuid,text,text,text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.visit_payment_position(uuid,uuid)', 'execute')
     or has_function_privilege('service_role', 'public.ensure_visit_bill(uuid,uuid,integer,text,boolean)', 'execute') then
    raise exception '0394: a command is executable by a role it was not granted to' using errcode = '55000';
  end if;
end;
$$;
commit;
