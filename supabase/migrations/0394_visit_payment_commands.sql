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
--   outstanding = bill total - (confirmed external + PENDING external + card attempts ready/pending_stripe/succeeded)
--                 + price reductions (succeeded price_reduction refunds only: the bill dropped with them)
-- Returned money alone (a payment_reversal, pending or succeeded) does NOT reopen a balance: a refunded, fully paid visit owes $0.00
-- (operator, 27 Nov 2026). Only a price_reduction frees capacity, and the figure never goes below zero.
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
-- Only a SUCCEEDED refund counts: a refund still with Stripe does not free capacity (it may yet fail), so a replacement tender can never take money that
-- is not provably back. This follows the never-over-collect rule.
-- PRODUCT RULE (Sam, 27 Nov 2026): refunding a fully paid visit does not, by itself, reopen a balance for collection. Only a price_reduction (the bill drops
-- with the refund, so the balance is unchanged) adds back to what is outstanding; a payment_reversal does NOT. This supersedes the 0393 header sentence that says
-- a reversal raises the balance due. refunded_cents still reports ALL money returned (the Refunded figure); outstanding_cents is what a new tender may take.
-- ---------------------------------------------------------------------------
-- WHICH CARD MONEY COUNTS (Sam, 27 Nov 2026: Stripe TEST-mode money is not real money). A studio is LIVE ("has gone live") once it has a Stripe Connect settings row in LIVE
-- mode with an account id (it connected live Stripe: no payment is needed, so cash or a transfer can be its first real money) OR a SUCCEEDED card attempt with
-- stripe_livemode = true. Before that, every card attempt counts toward capacity exactly as it always did, so test-mode environments (CI, dev, staging, the fake-Stripe
-- lane) behave unchanged. After it, an attempt that is not live no longer counts: an old pilot test charge can never block collecting real money. The mode is derived here
-- from the rows, never passed in by a caller (an owner could call the commands directly and claim any mode). ONE definition, used by the position and so by the refusal,
-- the card wall and every command. Statements and analytics are live-only regardless and are not changed by this.
create function public.studio_has_gone_live(p_studio uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.studio_payment_settings s where s.studio_id = p_studio and s.stripe_livemode = true and s.stripe_account_id is not null)
      or exists (select 1 from public.payment_charge_attempts a where a.studio_id = p_studio and a.stripe_livemode = true and a.status = 'succeeded');
$$;
create index payment_charge_attempts_live_succeeded_idx on public.payment_charge_attempts (studio_id) where stripe_livemode = true and status = 'succeeded';
-- MONEY, one rule (Sam, 28 Nov 2026): what is STILL TO COLLECT (`outstanding_cents` in the position below) counts REAL money only (cash, transfers, LIVE card payments). A Stripe TEST payment never counts, in any studio,
-- so an old test charge can never block a genuine payment, and the visit, the statement and analytics cannot disagree. The ONE thing that still uses the live distinction is the room for a new TEST card
-- (`test_card_room_cents`, via this function): a test card counts against another test card until the studio is live, so test lanes and trial studios cannot stack test charges past the bill.
-- The mode a tender is made in comes from the row or the command, never from a caller's argument.
create function public.card_counts_toward_capacity(p_studio uuid, p_livemode boolean) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select p_livemode is true or not public.studio_has_gone_live(p_studio);
$$;
revoke all privileges on function public.studio_has_gone_live(uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.card_counts_toward_capacity(uuid, boolean) from public, anon, authenticated, service_role;

create function public.visit_payment_position(p_studio uuid, p_appointment uuid)
returns table (bill_id uuid, currency text, total_cents integer, confirmed_cents integer, pending_cents integer,
               card_cents integer, refunded_cents integer, outstanding_cents integer, review_open boolean, test_card_room_cents integer)
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select b.id, b.currency, b.total_cents,
         x.confirmed, x.pending, c.live_card, r.refunded,
         -- outstanding_cents ("still to collect") counts REAL money only: cash, transfers (confirmed or pending) and LIVE card payments. A Stripe TEST payment never counts, in ANY studio.
         greatest(0, b.total_cents - x.confirmed - x.pending - c.live_card + d.reduced_real),
         exists (select 1 from public.payment_refund_reviews v where v.studio_id = p_studio and v.appointment_id = p_appointment and v.resolved_at is null),
         -- the room a new TEST card has: test money is judged by the older rule (a test card counts until the studio is live), so test lanes and trial studios cannot stack test charges past the bill
         greatest(0, b.total_cents - x.confirmed - x.pending - c.card + d.reduced)
    from public.visit_bills b
    cross join lateral (
      select coalesce(sum(e.amount_cents) filter (where e.state = 'confirmed'), 0)::integer as confirmed,
             coalesce(sum(e.amount_cents) filter (where e.state = 'pending_confirmation'), 0)::integer as pending
        from public.visit_external_payments e
       where e.studio_id = p_studio and e.appointment_id = p_appointment) x
    cross join lateral (
      select coalesce(sum(a.amount_cents), 0)::integer as card,
             coalesce(sum(a.amount_cents) filter (where a.stripe_livemode is true), 0)::integer as live_card
        from public.payment_charge_attempts a
       where a.studio_id = p_studio and a.appointment_id = p_appointment and a.charge_reason = 'session_payment'
         and a.visit_bill_id is not null and a.status in ('ready', 'pending_stripe', 'succeeded')
         and public.card_counts_toward_capacity(p_studio, a.stripe_livemode)) c
    -- Money returned: payment_refund_money (0393), the one definition, for every settled payment of the visit.
    cross join lateral (
      select coalesce(sum(m.succeeded_cents), 0)::integer as refunded
        from (select a2.id as aid, null::uuid as eid from public.payment_charge_attempts a2
               where a2.studio_id = p_studio and a2.appointment_id = p_appointment and a2.charge_reason = 'session_payment'
                 and a2.visit_bill_id is not null and a2.status = 'succeeded'
              union all
              select null::uuid, e2.id from public.visit_external_payments e2
               where e2.studio_id = p_studio and e2.appointment_id = p_appointment and e2.state = 'confirmed') pay
        cross join lateral public.payment_refund_money(pay.aid, pay.eid) m) r
    -- Price reductions that SUCCEEDED: the only refunds that add back to what is outstanding (the bill dropped by the same amount).
    cross join lateral (
      select coalesce(sum(pr.amount_cents), 0)::integer as reduced,
             coalesce(sum(pr.amount_cents) filter (where pr.attempt_id is null or pa.stripe_livemode is true), 0)::integer as reduced_real
        from public.payment_refunds pr
        left join public.payment_charge_attempts pa on pa.id = pr.attempt_id
       where pr.studio_id = p_studio and pr.appointment_id = p_appointment and pr.kind = 'price_reduction' and pr.status = 'succeeded'
         -- a reduction on a card payment that does not count (see studio_has_gone_live) adds back nothing: the card itself was never subtracted
         and (pr.attempt_id is null or public.card_counts_toward_capacity(p_studio, pa.stripe_livemode))) d
   where b.studio_id = p_studio and b.appointment_id = p_appointment and b.superseded_at is null;
$$;
revoke all privileges on function public.visit_payment_position(uuid, uuid) from public, anon, authenticated, service_role;

-- The reason a tender of p_amount is refused, or null when it fits. Pending transfers are what 'reserved' refers to.
create function public.visit_payment_refusal(p_studio uuid, p_appointment uuid, p_amount integer, p_tender_livemode boolean default null)
returns text
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  p record;
  v_room integer;
begin
  select * into p from public.visit_payment_position(p_studio, p_appointment);
  if not found then return 'no_bill'; end if;
  -- The tender's mode: NULL = cash / a transfer / other, TRUE = a live card, FALSE = a TEST card. A real tender is judged on REAL money only (an old test charge never blocks it);
  -- a test card keeps the balance-due rule, so test lanes and trial studios behave as before.
  v_room := case when p_tender_livemode is false then p.test_card_room_cents else p.outstanding_cents end;
  if p_amount <= v_room then return null; end if;
  if p.pending_cents > 0 and p_amount <= v_room + p.pending_cents then return 'reserved_for_pending_transfer'; end if;
  return 'exceeds_balance';
end;
$$;
revoke all privileges on function public.visit_payment_refusal(uuid, uuid, integer, boolean) from public, anon, authenticated, service_role;

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
  -- The visit lock comes FIRST, before the bill is read, so an attempt racing bill creation either is stamped by the bill (it waited for it) or is
  -- seen by ensure_visit_bill under the same lock, which then refuses to make a bill over it.
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(new.appointment_id));
  select b.id, b.currency into v_bill, v_currency
    from public.visit_bills b where b.studio_id = new.studio_id and b.appointment_id = new.appointment_id and b.superseded_at is null;
  if v_bill is null then
    return new;                       -- a legacy visit: exactly the behaviour it always had
  end if;
  if new.currency is distinct from v_currency then
    raise exception 'payment_currency_mismatch: the card amount is not in the bill currency' using errcode = 'PY003';
  end if;
  v_refusal := public.visit_payment_refusal(new.studio_id, new.appointment_id, new.amount_cents, new.stripe_livemode is true);
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
-- 4b. The settlement wall: once a visit has a LIVE bill, the older single-outcome settlement (0187) can no longer be written for it
-- ---------------------------------------------------------------------------
-- ANY bill row refuses, live or superseded: a bill that was retired out of band with no successor must not reopen the door. The reverse of ensure_visit_bill's refusal (a visit with a settlement gets no bill). Both take the visit's advisory lock and then look at the other
-- side, so a settlement racing bill creation is either seen by the bill command (which refuses) or refused here. It is a trigger, not an edit of
-- 0187/0254's commands, because those bodies are applied and frozen and three different commands write settlement rows. The application also hides the
-- old controls for a billed visit; this is the wall behind that.
create function public.appointment_settlements_visit_bill_guard() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(new.appointment_id));
  if exists (select 1 from public.visit_bills b where b.studio_id = new.studio_id and b.appointment_id = new.appointment_id) then
    raise exception 'visit_is_billed: this visit is paid through split payments, so a single payment outcome cannot be recorded for it' using errcode = 'PY004';
  end if;
  return new;
end;
$$;
revoke all privileges on function public.appointment_settlements_visit_bill_guard() from public, anon, authenticated, service_role;
create trigger appointment_settlements_visit_bill_guard_trg before insert on public.appointment_settlements
  for each row execute function public.appointment_settlements_visit_bill_guard();

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
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::integer, null::text; return;
  end if;
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
  -- A card payment already PREPARED the old way (a 'ready' attempt, no bill) could still be charged on top of split tenders, so the visit is refused a
  -- bill until that attempt is finished or cancelled.
  if exists (
    select 1 from public.payment_charge_attempts a
      left join public.sessions s on s.id = a.session_id and s.studio_id = a.studio_id
     where a.studio_id = p_studio_id and a.charge_reason = 'session_payment' and a.status = 'ready' and a.visit_bill_id is null
       and coalesce(a.appointment_id, s.appointment_id) = p_appointment_id
  ) then
    return query select 'card_attempt_prepared'::text, null::uuid, null::integer, null::text; return;
  end if;
  v_quote := public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id);
  if v_quote is null then
    return query select 'price_missing'::text, null::uuid, null::integer, null::text; return;
  end if;
  v_total := coalesce(p_final_cents, v_quote);
  if v_total is distinct from v_quote then
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
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::text; return;
  end if;
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
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::text; return;
  end if;
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
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::text; return;
  end if;
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
  if p_attempt_id is not null and exists (select 1 from public.payment_refund_reviews v where v.attempt_id = p_attempt_id and v.resolved_at is null) then
    return query select 'review_open'::text, null::uuid, null::text, null::uuid; return;
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

-- The Stripe refund id, written once when Stripe has accepted the request (before the outcome is known), so a retry retrieves it instead of creating again.
create function public.record_refund_sent(p_refund_id uuid, p_stripe_refund_id text)
returns table (result text, refund_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt uuid;
  r public.payment_refunds%rowtype;
begin
  if p_refund_id is null or p_stripe_refund_id is null or p_stripe_refund_id !~ '^re_[A-Za-z0-9]{1,64}$' then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;
  select x.appointment_id into v_appt from public.payment_refunds x where x.id = p_refund_id and x.attempt_id is not null and not x.legacy;
  if not found then return query select 'not_found'::text, null::uuid; return; end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appt));
  select * into r from public.payment_refunds x where x.id = p_refund_id for update;
  if r.stripe_refund_id is not null then
    return query select case when r.stripe_refund_id = p_stripe_refund_id then 'already_recorded' else 'conflict' end, r.id; return;
  end if;
  if r.status <> 'pending_stripe' then return query select 'already_settled'::text, r.id; return; end if;
  update public.payment_refunds set stripe_refund_id = p_stripe_refund_id where id = r.id;
  return query select 'recorded'::text, r.id;
end;
$$;

-- A refund Stripe reports on a BILLED card payment that Hone did not make. The service role calls it from the webhook with raw closed values; the
-- known/unknown decision is made HERE, under the visit lock, never in the caller. Writes NOTHING for a legacy visit ('not_billed'), for the non-row reasons
-- ('billed'), for an attempt that is already fully refunded ('covered') or for a refund that failed/was canceled ('ignored').
-- KNOWN (not flagged) only if (a) the ledger or the attempt already holds this Stripe refund id, or (c) the strict locator names a PENDING Hone row of this
-- attempt with the same amount and currency. An equal amount alone never makes a refund known.
create function public.flag_payment_refund_review(
  p_attempt_id uuid, p_stripe_refund_id text, p_stripe_refund_status text, p_amount_cents integer, p_currency text,
  p_event_id text, p_event_created bigint, p_reason_code text, p_hone_refund_id text
) returns table (result text, review_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  a public.payment_charge_attempts%rowtype;
  v_appt uuid;
  v_review public.payment_refund_reviews%rowtype;
  v_hone uuid;
  v_id uuid;
begin
  if p_attempt_id is null or p_reason_code is null
     or p_reason_code not in ('partial_dashboard_refund', 'unknown_4xx_on_create', 'stuck_pending_24h', 'list_incomplete', 'refund_evidence_refused') then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;
  select x.appointment_id into v_appt from public.payment_charge_attempts x where x.id = p_attempt_id and x.visit_bill_id is not null;
  if not found then
    -- no such attempt, or a legacy visit: the existing application path and its alert are unchanged
    return query select case when exists (select 1 from public.payment_charge_attempts x where x.id = p_attempt_id) then 'not_billed' else 'unknown_payment' end::text, null::uuid;
    return;
  end if;
  if v_appt is null then return query select 'unknown_payment'::text, null::uuid; return; end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appt));
  select * into a from public.payment_charge_attempts x where x.id = p_attempt_id for update;
  if p_reason_code in ('list_incomplete', 'refund_evidence_refused') then
    return query select 'billed'::text, null::uuid; return;           -- the caller raises the operator alert; nothing is stored, nothing is frozen
  end if;
  if p_stripe_refund_id is null or p_stripe_refund_id !~ '^re_[A-Za-z0-9]{1,64}$'
     or p_stripe_refund_status is null or p_stripe_refund_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
     or p_amount_cents is null or p_amount_cents not between 1 and 200000 or p_currency is null or p_currency not in ('cad', 'usd')
     or p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]{1,64}$' or p_event_created is null or p_event_created < 0 then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;
  if a.status <> 'succeeded' or a.currency is distinct from p_currency or p_amount_cents > a.amount_cents then
    return query select 'unknown_payment'::text, null::uuid; return;
  end if;
  select * into v_review from public.payment_refund_reviews v where v.stripe_refund_id = p_stripe_refund_id;
  if found then
    if v_review.attempt_id is distinct from a.id then return query select 'unknown_payment'::text, null::uuid; return; end if;
    if v_review.resolved_at is null and p_event_created >= v_review.stripe_event_created then
      update public.payment_refund_reviews
         set stripe_refund_status = p_stripe_refund_status, stripe_event_id = p_event_id, stripe_event_created = p_event_created,
             resolved_at = case when p_stripe_refund_status in ('failed', 'canceled') then now() end,
             closed_code = case p_stripe_refund_status when 'failed' then 'auto_failed' when 'canceled' then 'auto_canceled' end
       where id = v_review.id;
      if p_stripe_refund_status in ('failed', 'canceled') then
        return query select 'auto_closed'::text, v_review.id; return;
      end if;
    end if;
    return query select 'already_flagged'::text, v_review.id; return;
  end if;
  if p_stripe_refund_status in ('failed', 'canceled') then
    return query select 'ignored'::text, null::uuid; return;
  end if;
  if a.refund_status = 'succeeded' then
    return query select 'covered'::text, null::uuid; return;           -- the whole payment is already back; nothing to acknowledge
  end if;
  if exists (select 1 from public.payment_refunds r where r.stripe_refund_id = p_stripe_refund_id) or a.stripe_refund_id = p_stripe_refund_id then
    return query select 'known'::text, null::uuid; return;
  end if;
  if p_hone_refund_id is not null and p_hone_refund_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_hone := p_hone_refund_id::uuid;
    if exists (select 1 from public.payment_refunds r where r.id = v_hone and r.attempt_id = a.id and r.studio_id = a.studio_id and not r.legacy
                  and r.status = 'pending_stripe' and r.amount_cents = p_amount_cents and r.currency = p_currency) then
      return query select 'known'::text, null::uuid; return;
    end if;
  end if;
  insert into public.payment_refund_reviews (studio_id, attempt_id, appointment_id, stripe_refund_id, stripe_refund_status, amount_cents, currency,
                                             stripe_event_id, stripe_event_created, reason_code)
  values (a.studio_id, a.id, a.appointment_id, p_stripe_refund_id, p_stripe_refund_status, p_amount_cents, p_currency, p_event_id, p_event_created, p_reason_code)
  returning id into v_id;
  -- OPERATOR-ONLY alert (studio NULL: no practitioner policy can read it). Fixed event, fixed message, closed keys; no studio, client or visit.
  insert into public.ops_alerts (severity, event, message, studio_id, route, safe_details)
  values ('critical', 'payment_refund_review_opened', 'A refund was made outside Hone on a split-payment card payment and needs review.', null, '/api/stripe/webhook',
          jsonb_build_object('review_id', v_id, 'attempt_id', a.id, 'stripe_refund_id', p_stripe_refund_id, 'amount_cents', p_amount_cents,
                             'currency', p_currency, 'reason_code', p_reason_code));
  return query select 'flagged'::text, v_id;
end;
$$;

-- The owner acknowledges a SETTLED dashboard refund. No amount is passed: the signed amount Stripe reported is already on the review.
-- Single use, closed codes only. A refund still pending with Hone is never failed to make room.
create function public.resolve_payment_refund_review(p_review_id uuid)
returns table (result text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v public.payment_refund_reviews%rowtype;
  a public.payment_charge_attempts%rowtype;
  m record;
  actor uuid;
begin
  select * into v from public.payment_refund_reviews x where x.id = p_review_id;
  if not found or not public.is_studio_owner(v.studio_id) then
    return query select 'not_found'::text; return;                    -- a missing review and a stranger look the same
  end if;
  actor := public.session_actor_practitioner(v.studio_id);
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v.appointment_id));
  select * into v from public.payment_refund_reviews x where x.id = p_review_id for update;
  if v.resolved_at is not null then return query select 'already_resolved'::text; return; end if;
  select * into a from public.payment_charge_attempts x where x.id = v.attempt_id for update;
  if a.refund_status = 'succeeded' or exists (select 1 from public.payment_refunds r where r.stripe_refund_id = v.stripe_refund_id) then
    update public.payment_refund_reviews set resolved_at = now(), closed_code = 'auto_recorded' where id = v.id;
    return query select 'already_covered'::text; return;
  end if;
  if v.stripe_refund_status <> 'succeeded' then return query select 'not_settled'::text; return; end if;
  if a.refund_status = 'pending_stripe' or exists (select 1 from public.payment_refunds r where r.attempt_id = a.id and not r.legacy and r.status = 'pending_stripe') then
    return query select 'refund_pending'::text; return;
  end if;
  select * into m from public.payment_refund_money(a.id, null);
  if m.succeeded_cents + m.reserved_cents + v.amount_cents > m.payment_cents then
    return query select 'over_capacity'::text; return;                -- left open for support
  end if;
  insert into public.payment_refunds (studio_id, appointment_id, attempt_id, amount_cents, currency, kind, reason, status,
                                      stripe_refund_id, stripe_refund_status, stripe_refund_event_created, stripe_refund_event_id,
                                      source, requested_by_practitioner_id)
  values (v.studio_id, v.appointment_id, v.attempt_id, v.amount_cents, v.currency, 'payment_reversal', 'Refunded in the Stripe dashboard', 'succeeded',
          v.stripe_refund_id, 'succeeded', v.stripe_event_created, v.stripe_event_id, 'stripe_dashboard', actor);
  update public.payment_refund_reviews set resolved_at = now(), resolved_by_practitioner_id = actor, closed_code = 'acknowledged' where id = v.id;
  return query select 'resolved'::text;
end;
$$;

-- The batch read for the money readers: the position of up to 200 visits of ONE studio, owner only, with review_open.
create function public.get_visit_payment_positions(p_studio_id uuid, p_appointment_ids uuid[])
returns table (appointment_id uuid, bill_id uuid, currency text, total_cents integer, confirmed_cents integer, pending_cents integer,
               card_cents integer, refunded_cents integer, outstanding_cents integer, review_open boolean, test_card_room_cents integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    return;
  end if;
  if p_appointment_ids is null or cardinality(p_appointment_ids) > 200 then
    raise exception 'get_visit_payment_positions: at most 200 visits per call' using errcode = '22023';
  end if;
  return query select u.id, p.bill_id, p.currency, p.total_cents, p.confirmed_cents, p.pending_cents, p.card_cents, p.refunded_cents,
                      p.outstanding_cents, p.review_open, p.test_card_room_cents
                 from unnest(p_appointment_ids) as u(id)
                 cross join lateral public.visit_payment_position(p_studio_id, u.id) p;
end;
$$;

-- The one read the screens use. The studio's OWNER only, as the tables themselves (0393).
create function public.get_visit_payment_position(p_studio_id uuid, p_appointment_id uuid)
returns table (bill_id uuid, currency text, total_cents integer, confirmed_cents integer, pending_cents integer,
               card_cents integer, refunded_cents integer, outstanding_cents integer, review_open boolean, test_card_room_cents integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if not public.is_studio_owner(p_studio_id) then
    return;
  end if;
  return query select * from public.visit_payment_position(p_studio_id, p_appointment_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants: all four default-granted roles revoked BY NAME, then only what is needed
-- ---------------------------------------------------------------------------
-- An abandoned card payment: prepared (the row exists, so its amount is held against the balance) but never sent to Stripe. The owner can cancel it, which
-- releases the amount. Only a split attempt that is still 'ready' with no PaymentIntent can be cancelled; anything that reached Stripe is not touched.
create function public.cancel_split_card_attempt(p_studio_id uuid, p_attempt_id uuid, p_reason text)
returns table (result text, attempt_id uuid, status text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_appt uuid;
  a public.payment_charge_attempts%rowtype;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::text; return;
  end if;
  if p_attempt_id is null or (v_reason is not null and length(v_reason) > 500) then
    return query select 'invalid_input'::text, null::uuid, null::text; return;
  end if;
  select x.appointment_id into v_appt from public.payment_charge_attempts x
   where x.id = p_attempt_id and x.studio_id = p_studio_id and x.visit_bill_id is not null;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;
  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appt));
  select * into a from public.payment_charge_attempts x where x.id = p_attempt_id and x.studio_id = p_studio_id for update;
  if a.status = 'cancelled' then
    return query select 'already_cancelled'::text, a.id, a.status; return;
  end if;
  if a.status <> 'ready' or a.stripe_payment_intent_id is not null or a.charged_at is not null then
    return query select 'not_cancellable'::text, a.id, a.status; return;
  end if;
  update public.payment_charge_attempts t
     set status = 'cancelled', cancelled_at = now(), cancelled_by_practitioner_id = actor,
         cancelled_reason = coalesce(v_reason, 'Cancelled before it was sent to the card network.')
   where t.id = a.id and t.status = 'ready' and t.stripe_payment_intent_id is null;
  return query select 'cancelled'::text, a.id, 'cancelled'::text;
end;
$$;

revoke all privileges on function public.ensure_visit_bill(uuid, uuid, integer, text, boolean) from public, anon, authenticated, service_role;
revoke all privileges on function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.confirm_visit_external_payment(uuid, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.void_visit_external_payment(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.finish_payment_refund(uuid, text, text, text, text, text, integer) from public, anon, authenticated, service_role;
revoke all privileges on function public.get_visit_payment_position(uuid, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.cancel_split_card_attempt(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.ensure_visit_bill(uuid, uuid, integer, text, boolean) to authenticated;
grant execute on function public.record_visit_external_payment(uuid, uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.confirm_visit_external_payment(uuid, uuid) to authenticated;
grant execute on function public.void_visit_external_payment(uuid, uuid, text) to authenticated;
grant execute on function public.request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid) to authenticated;
grant execute on function public.get_visit_payment_position(uuid, uuid) to authenticated;
grant execute on function public.cancel_split_card_attempt(uuid, uuid, text) to authenticated;
grant execute on function public.finish_payment_refund(uuid, text, text, text, text, text, integer) to service_role;
revoke all privileges on function public.record_refund_sent(uuid, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.flag_payment_refund_review(uuid, text, text, integer, text, text, bigint, text, text) from public, anon, authenticated, service_role;
revoke all privileges on function public.resolve_payment_refund_review(uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.get_visit_payment_positions(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.record_refund_sent(uuid, text) to service_role;
grant execute on function public.flag_payment_refund_review(uuid, text, text, integer, text, text, bigint, text, text) to service_role;
grant execute on function public.resolve_payment_refund_review(uuid) to authenticated;
grant execute on function public.get_visit_payment_positions(uuid, uuid[]) to authenticated;
comment on function public.record_refund_sent(uuid, text) is '0394. Service role: stores the Stripe refund id once, before the outcome is known.';
comment on function public.flag_payment_refund_review(uuid, text, text, integer, text, text, bigint, text, text) is '0394. Service role: opens a review for a refund Stripe reports that Hone did not make. Closed fields only; the known/unknown decision is made under the visit lock.';
comment on function public.resolve_payment_refund_review(uuid) is '0394. Owner only: acknowledges a settled dashboard refund (no amount argument) and records it in the ledger once.';
comment on function public.get_visit_payment_positions(uuid, uuid[]) is '0394. Owner only: the position of up to 200 visits, with review_open.';

comment on function public.visit_payment_position(uuid, uuid) is '0394. The one definition of how much of a billed visit is still collectable. Internal.';
comment on function public.visit_payment_refusal(uuid, uuid, integer, boolean) is '0394. Why a tender of this amount is refused (reserved_for_pending_transfer, exceeds_balance, no_bill) or null. Internal.';
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
    'public.record_refund_sent(uuid,text)',
    'public.flag_payment_refund_review(uuid,text,text,integer,text,text,bigint,text,text)',
    'public.resolve_payment_refund_review(uuid)',
    'public.get_visit_payment_positions(uuid,uuid[])',
    'public.visit_payment_position(uuid,uuid)',
    'public.visit_payment_refusal(uuid,uuid,integer,boolean)',
    'public.visit_bill_supersede(uuid,uuid,integer,text,uuid)',
    'public.payment_charge_attempts_visit_bill_guard()'] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0394: anon can execute %', f using errcode = '55000';
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.finish_payment_refund(uuid,text,text,text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.visit_payment_position(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.flag_payment_refund_review(uuid,text,text,integer,text,text,bigint,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_refund_sent(uuid,text)', 'execute')
     or has_function_privilege('service_role', 'public.resolve_payment_refund_review(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.ensure_visit_bill(uuid,uuid,integer,text,boolean)', 'execute') then
    raise exception '0394: a command is executable by a role it was not granted to' using errcode = '55000';
  end if;
end;
$$;
commit;
