-- ===========================================================================
-- 0393: VISIT PAYMENT LEDGER — bills, cash/transfer payments and per-payment refunds (HON-123 / HON-122)
-- ===========================================================================
--
-- WHAT THIS IS. The tables that let one visit have one bill, several payments (card through Stripe, cash, a transfer
-- that is confirmed later) and several partial refunds against a chosen payment. It is the FIRST of three steps:
--   0393 (this file)  tables, constraints, guards, the legacy-refund backfill. NO command, NO behaviour change: nothing
--                     can write these tables yet except the legacy-refund mirror below.
--   0394              the commands (record / confirm / void a payment, refund, bill versions), the over-collection and
--                     over-refund decisions, the relaxed one-card-attempt-per-visit rule, the split_payments rollout key.
--   0395              the webhook reconciliation that understands partial refunds (needs 0392, the platform fee columns).
--
-- WHY NEW TABLES AND NOT MORE COLUMNS. Until now a refund was a set of columns ON payment_charge_attempts: one refund,
-- the full amount (0078), and the webhook only adopts a full refund (0240). A visit's cash/transfer money lived in
-- appointment_settlements, which allows ONE live row per appointment (0187). Neither can hold several payments or several
-- refunds. Those two tables are LEFT AS THEY ARE; a visit with no bill row is a legacy visit and is read exactly as before.
--
-- WHAT EACH TABLE MEANS.
--   visit_bills             the one bill of a visit (versioned by superseding, like settlements). Created at the first
--                           tender of a visit; a visit with no bill row is legacy.
--   visit_external_payments cash, e-transfer or other transfer. Cash is confirmed on entry. A transfer starts
--                           pending_confirmation (the money is NOT counted as paid) and is then confirmed once or voided.
--                           A confirmed payment is final: money returned later is a refund, not a void.
--   payment_refunds         one row per refund event against ONE selected payment: a Stripe attempt or an external payment.
--                           kind price_reduction (the bill drops with it, the balance is unchanged) or payment_reversal
--                           (the bill stays, the balance due rises: a mistaken payment). Failed rows consume nothing.
--
-- THE LEGACY REFUND. Every attempt that already carries a refund gets ONE payment_refunds row (legacy = true), inserted
-- here, so there is a single source for "how much is still refundable". After this file an UPDATE of an attempt's refund
-- columns by the older code is mirrored into that row by a trigger, so a refund made between this apply and the
-- application deploy cannot be missed. The attempt columns are kept and not rewritten.
--
-- WRITES. No role holds a write grant on any of the three tables (revoked from all four roles, by name); 0394's SECURITY
-- DEFINER commands are the only writers. Members of the studio may read their own studio's rows (RLS). The triggers
-- below are the second wall: financial history is append-only and never deleted.
--
-- ROLLBACK. supabase/rollbacks/0393_visit_payment_ledger.down.sql refuses once any bill, any external payment or any
-- non-legacy refund exists.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.payment_charge_attempts') is null or to_regclass('public.appointments') is null
     or to_regclass('public.practitioners') is null or to_regprocedure('public.is_studio_member(uuid)') is null then
    raise exception '0393: a table or function this migration builds on is missing' using errcode = 'check_violation';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public'
              and table_name in ('visit_bills', 'visit_external_payments', 'payment_refunds')) then
    raise exception '0393: one of the new tables already exists' using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- visit_bills
-- ---------------------------------------------------------------------------
create table public.visit_bills (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios (id) on delete cascade,
  appointment_id              uuid not null,
  currency                    text not null,
  total_cents                 integer not null,
  -- The agreed price before a staff adjustment, with the reason (the 0381 evidence, carried so a split visit keeps it).
  reference_fee_cents         integer,
  fee_adjustment_reason       text,
  created_by_practitioner_id  uuid not null,
  created_at                  timestamptz not null default now(),
  supersedes_id               uuid references public.visit_bills (id) on delete restrict,
  superseded_at               timestamptz,
  superseded_by_id            uuid,
  supersede_reason            text,
  constraint visit_bills_appointment_fk foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete restrict,
  constraint visit_bills_actor_fk foreign key (created_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint visit_bills_superseded_by_fk foreign key (superseded_by_id)
    references public.visit_bills (id) on delete restrict deferrable initially deferred,
  constraint visit_bills_currency_check check (currency in ('cad', 'usd')),
  constraint visit_bills_total_check check (total_cents between 0 and 200000),
  constraint visit_bills_reference_check check (
    (reference_fee_cents is null and fee_adjustment_reason is null)
    or (reference_fee_cents between 1 and 200000 and char_length(btrim(coalesce(fee_adjustment_reason, ''))) between 1 and 200)
  ),
  constraint visit_bills_supersede_check check (
    (supersedes_id is null and supersede_reason is null)
    or (supersedes_id is not null and supersedes_id <> id and char_length(btrim(coalesce(supersede_reason, ''))) between 1 and 500)
  ),
  constraint visit_bills_superseded_evidence_check check (
    (superseded_at is null and superseded_by_id is null)
    or (superseded_at is not null and superseded_by_id is not null and superseded_by_id <> id)
  )
);
create unique index visit_bills_one_live_per_appointment on public.visit_bills (studio_id, appointment_id) where superseded_at is null;
create unique index visit_bills_one_successor on public.visit_bills (supersedes_id) where supersedes_id is not null;
create index visit_bills_appointment_idx on public.visit_bills (studio_id, appointment_id, created_at);

-- ---------------------------------------------------------------------------
-- visit_external_payments
-- ---------------------------------------------------------------------------
create table public.visit_external_payments (
  id                           uuid primary key default gen_random_uuid(),
  studio_id                    uuid not null references public.studios (id) on delete cascade,
  appointment_id               uuid not null,
  bill_id                      uuid not null references public.visit_bills (id) on delete restrict,
  method                       text not null,
  amount_cents                 integer not null,
  currency                     text not null,
  state                        text not null,
  -- Chosen by the browser once per submission and kept across retries: a repeated submit returns the first row.
  submission_id                uuid not null,
  recorded_by_practitioner_id  uuid not null,
  recorded_at                  timestamptz not null default now(),
  confirmed_by_practitioner_id uuid,
  confirmed_at                 timestamptz,
  voided_by_practitioner_id    uuid,
  voided_at                    timestamptz,
  void_reason                  text,
  note                         text,
  constraint visit_external_payments_appointment_fk foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete restrict,
  constraint visit_external_payments_recorder_fk foreign key (recorded_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint visit_external_payments_confirmer_fk foreign key (confirmed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint visit_external_payments_voider_fk foreign key (voided_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint visit_external_payments_id_studio_key unique (id, studio_id),
  constraint visit_external_payments_method_check check (method in ('paid_cash', 'paid_e_transfer', 'paid_other_external')),
  constraint visit_external_payments_amount_check check (amount_cents between 1 and 200000),
  constraint visit_external_payments_currency_check check (currency in ('cad', 'usd')),
  constraint visit_external_payments_state_check check (state in ('confirmed', 'pending_confirmation', 'voided')),
  -- Cash is in the till when it is entered: it is never "pending".
  constraint visit_external_payments_cash_check check (method <> 'paid_cash' or state = 'confirmed'),
  constraint visit_external_payments_note_check check (note is null or char_length(btrim(note)) between 1 and 500),
  constraint visit_external_payments_state_evidence_check check (
    (state = 'pending_confirmation' and confirmed_at is null and confirmed_by_practitioner_id is null
       and voided_at is null and voided_by_practitioner_id is null and void_reason is null)
    or (state = 'confirmed' and confirmed_at is not null and confirmed_by_practitioner_id is not null
       and voided_at is null and voided_by_practitioner_id is null and void_reason is null)
    or (state = 'voided' and confirmed_at is null and confirmed_by_practitioner_id is null
       and voided_at is not null and voided_by_practitioner_id is not null
       and char_length(btrim(coalesce(void_reason, ''))) between 1 and 500)
  )
);
create unique index visit_external_payments_submission_key on public.visit_external_payments (studio_id, submission_id);
create index visit_external_payments_appointment_idx on public.visit_external_payments (studio_id, appointment_id, recorded_at);
create index visit_external_payments_pending_idx on public.visit_external_payments (studio_id, appointment_id) where state = 'pending_confirmation';

-- ---------------------------------------------------------------------------
-- payment_refunds
-- ---------------------------------------------------------------------------
create table public.payment_refunds (
  id                           uuid primary key default gen_random_uuid(),
  studio_id                    uuid not null references public.studios (id) on delete cascade,
  -- The visit, when the payment has one (a freeform-session attempt may not). Must equal the payment's own appointment.
  appointment_id               uuid,
  -- EXACTLY ONE payment is named.
  attempt_id                   uuid references public.payment_charge_attempts (id) on delete restrict,
  external_payment_id          uuid references public.visit_external_payments (id) on delete restrict,
  amount_cents                 integer not null,
  currency                     text not null,
  kind                         text not null,
  reason                       text not null,
  status                       text not null,
  -- Stripe (attempt refunds only). Event ordering mirrors 0240 so a stale event can never overwrite a newer one.
  stripe_refund_id             text,
  stripe_refund_status         text,
  stripe_refund_event_created  bigint,
  stripe_refund_event_id       text,
  failure_code                 text,
  failure_message_safe         text,
  -- The Hone platform fee returned to the studio with THIS refund (Stripe's own cumulative figure, read after the
  -- refund). null = the attempt carried no fee. Written by the fee code (migration 0392 owns the attempt-side columns).
  platform_fee_returned_cents  integer,
  -- A price_reduction lowers the bill; this is the bill version that records it.
  reduced_bill_id              uuid references public.visit_bills (id) on delete restrict,
  submission_id                uuid,
  source                       text not null default 'hone',
  legacy                       boolean not null default false,
  requested_by_practitioner_id uuid,
  requested_at                 timestamptz not null default now(),
  confirmed_by_practitioner_id uuid,
  confirmed_at                 timestamptz,
  constraint payment_refunds_requester_fk foreign key (requested_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint payment_refunds_confirmer_fk foreign key (confirmed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint payment_refunds_one_payment_check check ((attempt_id is not null) <> (external_payment_id is not null)),
  constraint payment_refunds_amount_check check (amount_cents between 1 and 200000),
  constraint payment_refunds_currency_check check (currency in ('cad', 'usd')),
  constraint payment_refunds_kind_check check (kind in ('price_reduction', 'payment_reversal')),
  constraint payment_refunds_reason_check check (char_length(btrim(reason)) between 1 and 500),
  constraint payment_refunds_status_check check (status in ('pending_stripe', 'succeeded', 'failed')),
  constraint payment_refunds_source_check check (source in ('hone', 'stripe_dashboard')),
  -- Money handed back from the till or the bank is recorded after the fact: there is nothing pending or failed about it.
  constraint payment_refunds_external_status_check check (external_payment_id is null or status = 'succeeded'),
  constraint payment_refunds_external_stripe_check check (
    external_payment_id is null
    or (stripe_refund_id is null and stripe_refund_status is null and stripe_refund_event_created is null
        and stripe_refund_event_id is null and platform_fee_returned_cents is null and source = 'hone')
  ),
  constraint payment_refunds_stripe_status_check check (
    stripe_refund_status is null or stripe_refund_status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
  ),
  constraint payment_refunds_event_pair_check check (
    (stripe_refund_event_created is null and stripe_refund_event_id is null)
    or (stripe_refund_event_created is not null and stripe_refund_event_created >= 0
        and stripe_refund_event_id is not null and char_length(stripe_refund_event_id) > 0)
  ),
  constraint payment_refunds_failure_check check (
    (failure_code is null or char_length(failure_code) <= 100)
    and (failure_message_safe is null or char_length(failure_message_safe) <= 1000)
  ),
  constraint payment_refunds_fee_check check (platform_fee_returned_cents is null or platform_fee_returned_cents between 0 and amount_cents),
  constraint payment_refunds_reduction_check check (kind <> 'price_reduction' or legacy = false and reduced_bill_id is not null),
  constraint payment_refunds_confirmed_check check (
    (status = 'succeeded' and external_payment_id is not null and confirmed_at is not null and confirmed_by_practitioner_id is not null)
    or (external_payment_id is null)
  ),
  -- A new (non-legacy, Hone-made) refund always carries its submission id so a retried submit is recognised.
  constraint payment_refunds_submission_check check (legacy or source = 'stripe_dashboard' or submission_id is not null)
);
create unique index payment_refunds_stripe_refund_key on public.payment_refunds (stripe_refund_id) where stripe_refund_id is not null;
create unique index payment_refunds_submission_key on public.payment_refunds (studio_id, submission_id) where submission_id is not null;
create unique index payment_refunds_one_legacy_per_attempt on public.payment_refunds (attempt_id) where legacy;
create index payment_refunds_attempt_idx on public.payment_refunds (attempt_id) where attempt_id is not null;
create index payment_refunds_external_idx on public.payment_refunds (external_payment_id) where external_payment_id is not null;
create index payment_refunds_appointment_idx on public.payment_refunds (studio_id, appointment_id) where appointment_id is not null;
create index payment_refunds_pending_idx on public.payment_refunds (studio_id, requested_at) where status = 'pending_stripe';

-- ---------------------------------------------------------------------------
-- BACKFILL: one legacy row per attempt that already carries a refund. Inserted BEFORE the guards exist (they describe
-- new writes), from the attempt's own columns, deterministic and idempotent.
-- ---------------------------------------------------------------------------
insert into public.payment_refunds (
  studio_id, appointment_id, attempt_id, amount_cents, currency, kind, reason, status,
  stripe_refund_id, stripe_refund_status, stripe_refund_event_created, stripe_refund_event_id,
  failure_code, failure_message_safe, source, legacy, requested_by_practitioner_id, requested_at
)
select a.studio_id, a.appointment_id, a.id, coalesce(a.refund_amount_cents, a.amount_cents), a.currency, 'payment_reversal',
       'Refund recorded before partial refunds existed', a.refund_status,
       a.stripe_refund_id, a.stripe_refund_status, a.stripe_refund_event_created, a.stripe_refund_event_id,
       a.refund_failure_code, a.refund_failure_message_safe, 'hone', true, a.refund_initiated_by_practitioner_id,
       coalesce(a.refunded_at, a.updated_at, a.created_at)
  from public.payment_charge_attempts a
 where a.refund_status is not null;

-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY AND GRANTS. Read-only for members; every write is a 0394 command.
-- ---------------------------------------------------------------------------
alter table public.visit_bills enable row level security;
alter table public.visit_external_payments enable row level security;
alter table public.payment_refunds enable row level security;

create policy "visit_bills_member_select" on public.visit_bills for select to authenticated
  using (public.is_studio_member(visit_bills.studio_id));
create policy "visit_external_payments_member_select" on public.visit_external_payments for select to authenticated
  using (public.is_studio_member(visit_external_payments.studio_id));
create policy "payment_refunds_member_select" on public.payment_refunds for select to authenticated
  using (public.is_studio_member(payment_refunds.studio_id));

revoke all on public.visit_bills from public, anon, authenticated, service_role;
revoke all on public.visit_external_payments from public, anon, authenticated, service_role;
revoke all on public.payment_refunds from public, anon, authenticated, service_role;
grant select on public.visit_bills to authenticated;
grant select on public.visit_external_payments to authenticated;
grant select on public.payment_refunds to authenticated;

-- ---------------------------------------------------------------------------
-- GUARDS: server timestamps, append-only, never deleted
-- ---------------------------------------------------------------------------
create function public.visit_bills_guard() returns trigger
language plpgsql volatile set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.superseded_at := null;
    new.superseded_by_id := null;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'visit_bills: financial history is never deleted' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id or new.appointment_id is distinct from old.appointment_id
     or new.currency is distinct from old.currency or new.total_cents is distinct from old.total_cents
     or new.reference_fee_cents is distinct from old.reference_fee_cents or new.fee_adjustment_reason is distinct from old.fee_adjustment_reason
     or new.created_by_practitioner_id is distinct from old.created_by_practitioner_id or new.created_at is distinct from old.created_at
     or new.supersedes_id is distinct from old.supersedes_id or new.supersede_reason is distinct from old.supersede_reason then
    raise exception 'visit_bills: a bill version is never edited; correct it by superseding' using errcode = '23514';
  end if;
  if old.superseded_at is not null
     and (new.superseded_at is distinct from old.superseded_at or new.superseded_by_id is distinct from old.superseded_by_id) then
    raise exception 'visit_bills: a superseded bill is retired once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger visit_bills_guard_trg before insert or update or delete on public.visit_bills
  for each row execute function public.visit_bills_guard();

create function public.visit_external_payments_guard() returns trigger
language plpgsql volatile set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_at := now();
    if new.state = 'confirmed' then new.confirmed_at := now(); end if;
    if new.state = 'voided' then
      raise exception 'visit_external_payments: a payment is never created voided' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'visit_external_payments: financial history is never deleted' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id or new.appointment_id is distinct from old.appointment_id
     or new.bill_id is distinct from old.bill_id or new.method is distinct from old.method
     or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
     or new.submission_id is distinct from old.submission_id or new.recorded_by_practitioner_id is distinct from old.recorded_by_practitioner_id
     or new.recorded_at is distinct from old.recorded_at or new.note is distinct from old.note then
    raise exception 'visit_external_payments: a payment is never edited' using errcode = '23514';
  end if;
  -- The only moves: pending -> confirmed, pending -> voided. A confirmed payment is final (money returned is a refund).
  if old.state is distinct from new.state then
    if not (old.state = 'pending_confirmation' and new.state in ('confirmed', 'voided')) then
      raise exception 'visit_external_payments: % -> % is not allowed', old.state, new.state using errcode = '23514';
    end if;
    if new.state = 'confirmed' then new.confirmed_at := now(); end if;
    if new.state = 'voided' then new.voided_at := now(); end if;
  elsif new.confirmed_at is distinct from old.confirmed_at or new.confirmed_by_practitioner_id is distinct from old.confirmed_by_practitioner_id
        or new.voided_at is distinct from old.voided_at or new.voided_by_practitioner_id is distinct from old.voided_by_practitioner_id
        or new.void_reason is distinct from old.void_reason then
    raise exception 'visit_external_payments: confirmation and void evidence is written once, with the state move' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger visit_external_payments_guard_trg before insert or update or delete on public.visit_external_payments
  for each row execute function public.visit_external_payments_guard();

-- What is still refundable on ONE payment: its amount less its live refunds (pending or succeeded; a failed refund
-- consumes nothing). null when the payment cannot be refunded (not a succeeded attempt, not a confirmed external payment).
create function public.payment_refundable_cents(p_attempt uuid, p_external uuid) returns integer
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select case
           when (p_attempt is null) = (p_external is null) then null
           when p_attempt is not null then
             (select a.amount_cents from public.payment_charge_attempts a where a.id = p_attempt and a.status = 'succeeded')
           else
             (select e.amount_cents from public.visit_external_payments e where e.id = p_external and e.state = 'confirmed')
         end
         - coalesce((select sum(r.amount_cents)::integer from public.payment_refunds r
                      where r.status in ('pending_stripe', 'succeeded')
                        and ((p_attempt is not null and r.attempt_id = p_attempt)
                             or (p_external is not null and r.external_payment_id = p_external))), 0);
$$;

-- The over-refund wall. It runs for every new or re-activated refund and takes the PAYMENT ROW lock first, so two
-- refunds racing on one payment are serialised and the second one sees the first.
create function public.payment_refunds_guard() returns trigger
language plpgsql volatile set search_path = pg_catalog, pg_temp
as $$
declare
  v_amount integer;
  v_studio uuid;
  v_appointment uuid;
  v_currency text;
  v_other integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'payment_refunds: financial history is never deleted' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.requested_at := now();
    if new.status = 'succeeded' and new.external_payment_id is not null then new.confirmed_at := now(); end if;
  else
    if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id or new.appointment_id is distinct from old.appointment_id
       or new.attempt_id is distinct from old.attempt_id or new.external_payment_id is distinct from old.external_payment_id
       or new.currency is distinct from old.currency or new.kind is distinct from old.kind or new.reason is distinct from old.reason
       or new.submission_id is distinct from old.submission_id or new.source is distinct from old.source or new.legacy is distinct from old.legacy
       or new.requested_at is distinct from old.requested_at or new.requested_by_practitioner_id is distinct from old.requested_by_practitioner_id
       or new.reduced_bill_id is distinct from old.reduced_bill_id then
      raise exception 'payment_refunds: a refund record is never edited' using errcode = '23514';
    end if;
    -- A legacy row is a MIRROR of the attempt's own refund columns and follows them (only the mirror trigger writes it).
    if not new.legacy then
      if new.amount_cents is distinct from old.amount_cents then
        raise exception 'payment_refunds: the amount is fixed when the refund is requested' using errcode = '23514';
      end if;
      -- pending_stripe -> succeeded | failed once; a settled refund does not move (a failed one is retried as a NEW row).
      if old.status is distinct from new.status and old.status <> 'pending_stripe' then
        raise exception 'payment_refunds: a settled refund is final' using errcode = '23514';
      end if;
      if old.stripe_refund_id is not null and new.stripe_refund_id is distinct from old.stripe_refund_id then
        raise exception 'payment_refunds: the Stripe refund id is written once' using errcode = '23514';
      end if;
      if old.platform_fee_returned_cents is not null and new.platform_fee_returned_cents is distinct from old.platform_fee_returned_cents then
        raise exception 'payment_refunds: the fee returned with a refund is written once' using errcode = '23514';
      end if;
      if old.status = 'succeeded' and (new.confirmed_at is distinct from old.confirmed_at
         or new.confirmed_by_practitioner_id is distinct from old.confirmed_by_practitioner_id) then
        raise exception 'payment_refunds: confirmation is written once' using errcode = '23514';
      end if;
    elsif pg_trigger_depth() < 2 then
      raise exception 'payment_refunds: a legacy row follows the attempt and is written only by the mirror' using errcode = '23514';
    end if;
  end if;

  if new.status in ('pending_stripe', 'succeeded') and (tg_op = 'INSERT' or old.status = 'failed' or new.legacy) then
    if new.attempt_id is not null then
      select a.amount_cents, a.studio_id, a.appointment_id, a.currency into v_amount, v_studio, v_appointment, v_currency
        from public.payment_charge_attempts a where a.id = new.attempt_id and a.status = 'succeeded' for update;
    else
      select e.amount_cents, e.studio_id, e.appointment_id, e.currency into v_amount, v_studio, v_appointment, v_currency
        from public.visit_external_payments e where e.id = new.external_payment_id and e.state = 'confirmed' for update;
    end if;
    if not found then
      raise exception 'payment_refunds: the payment is not a settled payment, so it cannot be refunded' using errcode = '23514';
    end if;
    if v_studio is distinct from new.studio_id or v_appointment is distinct from new.appointment_id or v_currency is distinct from new.currency then
      raise exception 'payment_refunds: the refund does not match its payment (studio, visit or currency)' using errcode = '23514';
    end if;
    select coalesce(sum(r.amount_cents), 0)::integer into v_other
      from public.payment_refunds r
     where r.id is distinct from new.id and r.status in ('pending_stripe', 'succeeded')
       and not (new.legacy and r.legacy)
       and ((new.attempt_id is not null and r.attempt_id = new.attempt_id)
            or (new.external_payment_id is not null and r.external_payment_id = new.external_payment_id));
    if v_other + new.amount_cents > v_amount then
      raise exception 'payment_refunds: % cents is more than the % cents still refundable', new.amount_cents, v_amount - v_other
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger payment_refunds_guard_trg before insert or update or delete on public.payment_refunds
  for each row execute function public.payment_refunds_guard();

-- The mirror: while the older refund code still writes an attempt's refund columns, keep that attempt's legacy row true.
create function public.payment_refunds_mirror_attempt() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if new.refund_status is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.refund_status is not distinct from new.refund_status
     and old.refund_amount_cents is not distinct from new.refund_amount_cents
     and old.stripe_refund_id is not distinct from new.stripe_refund_id
     and old.stripe_refund_status is not distinct from new.stripe_refund_status
     and old.stripe_refund_event_id is not distinct from new.stripe_refund_event_id then
    return new;
  end if;
  insert into public.payment_refunds (
    studio_id, appointment_id, attempt_id, amount_cents, currency, kind, reason, status,
    stripe_refund_id, stripe_refund_status, stripe_refund_event_created, stripe_refund_event_id,
    failure_code, failure_message_safe, source, legacy, requested_by_practitioner_id
  ) values (
    new.studio_id, new.appointment_id, new.id, coalesce(new.refund_amount_cents, new.amount_cents), new.currency, 'payment_reversal',
    'Refund recorded before partial refunds existed', new.refund_status,
    new.stripe_refund_id, new.stripe_refund_status, new.stripe_refund_event_created, new.stripe_refund_event_id,
    new.refund_failure_code, new.refund_failure_message_safe, 'hone', true, new.refund_initiated_by_practitioner_id
  )
  on conflict (attempt_id) where legacy do update
    set amount_cents = excluded.amount_cents, status = excluded.status,
        stripe_refund_id = excluded.stripe_refund_id, stripe_refund_status = excluded.stripe_refund_status,
        stripe_refund_event_created = excluded.stripe_refund_event_created, stripe_refund_event_id = excluded.stripe_refund_event_id,
        failure_code = excluded.failure_code, failure_message_safe = excluded.failure_message_safe;
  return new;
end;
$$;
create trigger payment_charge_attempts_refund_mirror_trg
  after insert or update of refund_status, refund_amount_cents, stripe_refund_id, stripe_refund_status, stripe_refund_event_id
  on public.payment_charge_attempts
  for each row execute function public.payment_refunds_mirror_attempt();

revoke all privileges on function public.visit_bills_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.visit_external_payments_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_refunds_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_refunds_mirror_attempt() from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_refundable_cents(uuid, uuid) from public, anon, authenticated, service_role;

comment on table public.visit_bills is
  '0393. The one bill of a visit, versioned by superseding. A visit with no bill row is a legacy visit and is read as before. Written only by the 0394 commands.';
comment on table public.visit_external_payments is
  '0393. Cash, e-transfer or other transfer payments on a visit. Cash is confirmed on entry; a transfer is pending_confirmation (not counted as paid) until confirmed once or voided. A confirmed payment is final: money returned is a refund. Written only by the 0394 commands.';
comment on table public.payment_refunds is
  '0393. One row per refund event against ONE payment (a Stripe attempt or an external payment). The remaining refundable amount of a payment is its amount less its pending and succeeded refunds (payment_refundable_cents). Legacy rows mirror the older single refund columns of payment_charge_attempts.';

commit;
