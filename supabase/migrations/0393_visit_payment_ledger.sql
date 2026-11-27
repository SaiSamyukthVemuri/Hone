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
     or to_regclass('public.practitioners') is null or to_regprocedure('public.is_studio_owner(uuid)') is null then
    raise exception '0393: a table or function this migration builds on is missing' using errcode = 'check_violation';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])')) is distinct from '34d66f66fa3572a36934d00ed124aeb7'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.initialize_studio_payment_jurisdiction_from_history_v2(uuid,text,text,text,text,text,boolean,text[],uuid[],uuid[],text)')) is distinct from 'fea675d9c166de79417f655f2dc4fac2' then
    raise exception '0393: a jurisdiction-from-history command is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public'
              and table_name in ('visit_bills', 'visit_external_payments', 'payment_refunds', 'payment_refund_reviews')) then
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
-- A card payment never has two refunds in flight at once (Stripe settles one before the next is asked for).
create unique index payment_refunds_one_pending_per_attempt on public.payment_refunds (attempt_id) where status = 'pending_stripe' and not legacy and attempt_id is not null;

-- ---------------------------------------------------------------------------
-- payment_refund_reviews (v1 of partial dashboard refunds): a refund Stripe reports that Hone did not make and cannot yet
-- place in the ledger. CLOSED FIELDS ONLY: no free text, no metadata values, no raw JSON, no notes. While one is open the
-- payment's refundable amount is frozen at 0 and the visit is not read as settled. Written only by the 0394 commands.
-- ---------------------------------------------------------------------------
create table public.payment_refund_reviews (
  id                           uuid primary key default gen_random_uuid(),
  studio_id                    uuid not null references public.studios (id) on delete cascade,
  attempt_id                   uuid not null references public.payment_charge_attempts (id) on delete restrict,
  appointment_id               uuid,
  stripe_refund_id             text not null,
  stripe_refund_status         text not null,
  amount_cents                 integer not null,
  currency                     text not null,
  stripe_event_id              text not null,
  stripe_event_created         bigint not null,
  reason_code                  text not null,
  opened_at                    timestamptz not null default now(),
  resolved_at                  timestamptz,
  resolved_by_practitioner_id  uuid,
  closed_code                  text,
  constraint payment_refund_reviews_resolver_fk foreign key (resolved_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint payment_refund_reviews_refund_id_check check (stripe_refund_id ~ '^re_[A-Za-z0-9]{1,64}$'),
  constraint payment_refund_reviews_event_id_check check (stripe_event_id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  constraint payment_refund_reviews_status_check check (stripe_refund_status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  constraint payment_refund_reviews_amount_check check (amount_cents between 1 and 200000),
  constraint payment_refund_reviews_currency_check check (currency in ('cad', 'usd')),
  constraint payment_refund_reviews_event_created_check check (stripe_event_created >= 0),
  constraint payment_refund_reviews_reason_check check (reason_code in ('partial_dashboard_refund', 'unknown_4xx_on_create', 'stuck_pending_24h')),
  constraint payment_refund_reviews_closed_check check (closed_code is null or closed_code in ('acknowledged', 'auto_failed', 'auto_canceled', 'auto_recorded')),
  constraint payment_refund_reviews_resolution_check check (
    (resolved_at is null and closed_code is null and resolved_by_practitioner_id is null)
    or (resolved_at is not null and closed_code is not null and ((closed_code = 'acknowledged') = (resolved_by_practitioner_id is not null)))
  )
);
create unique index payment_refund_reviews_stripe_refund_key on public.payment_refund_reviews (stripe_refund_id);
create index payment_refund_reviews_open_idx on public.payment_refund_reviews (attempt_id) where resolved_at is null;
create index payment_refund_reviews_studio_open_idx on public.payment_refund_reviews (studio_id, appointment_id) where resolved_at is null;

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
-- THE MONEY UNIVERSE OF THE JURISDICTION-FROM-HISTORY COMMANDS (0214 F5, 0257)
-- ---------------------------------------------------------------------------
-- Both commands FAIL CLOSED on any money-shaped table (currency, stripe_account_id or *_cents column) that is not in
-- their pinned universe: 'refused_unlisted_money_table'. The three tables above are money-shaped, so without this the
-- first verified jurisdiction could no longer be initialised from history for ANY studio once 0393 is applied. Each
-- body below is the applied body, byte for byte, with exactly two additions: the three tables join the universe, and a
-- studio whose visit ledger holds another currency is refused as refused_currency_history (same rule as the other
-- money tables). The applied bodies are asserted at the top of this file, so nothing else can have drifted.
create or replace function public.initialize_studio_payment_jurisdiction_from_history(
  p_studio_id uuid,
  p_payment_country text,
  p_payment_currency text,
  p_actor text,
  p_reason text,
  p_verification_reference text,
  p_acknowledge_configured_prices boolean default false,
  -- F2/F3: the exact test-mode evidence the operator reviewed. NULL = none.
  p_acknowledged_test_account_ids text[] default null,
  p_acknowledged_test_attempt_ids uuid[] default null
)
returns table (
  out_result text,
  out_payment_country text,
  out_payment_currency text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text := upper(btrim(coalesce(p_payment_country, '')));
  v_currency text := lower(btrim(coalesce(p_payment_currency, '')));
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ack_prices boolean := coalesce(p_acknowledge_configured_prices, false);
  v_reference text := btrim(coalesce(p_verification_reference, ''));
  v_given_accounts text[];
  v_given_attempts uuid[];
  v_need_accounts text[];
  v_need_attempts uuid[];
  v_unlisted text[];
  v_row public.studio_payment_jurisdictions%rowtype;
  -- F5: the pinned universe. Extending it is a reviewed migration.
  c_money_universe constant text[] := array[
    'appointment_payments', 'appointment_settlements', 'client_payment_methods',
    'client_pricing', 'client_stripe_customers', 'manual_fee_charge_attempts',
    'payment_charge_attempts', 'payment_recovery_tokens', 'payment_refund_reviews', 'payment_refunds',
    'pending_booking_payment_sessions', 'services', 'sessions',
    'stripe_account_provisioning_attempts', 'stripe_charge_attempts',
    'stripe_customer_provisioning_attempts', 'stripe_disputes', 'stripe_events',
    'stripe_payment_audit', 'stripe_refund_attempts', 'stripe_refunds',
    'studio_payment_settings', 'studios', 'visit_bills',
    'visit_external_payments'
  ];
begin
  if p_studio_id is null
     or not ((v_country = 'CA' and v_currency = 'cad')
             or (v_country = 'US' and v_currency = 'usd'))
     or length(v_actor) not between 1 and 200
     or length(v_reason) not between 1 and 1000
     or array_position(p_acknowledged_test_account_ids, null) is not null
     or array_position(p_acknowledged_test_attempt_ids, null) is not null then
    return query select 'invalid_input'::text, null::text, null::text;
    return;
  end if;

  if length(v_reference) not between 1 and 1000 then
    return query select 'verification_required'::text, null::text, null::text;
    return;
  end if;

  perform 1 from public.studios st where st.id = p_studio_id for no key update;
  if not found then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select * into v_row
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for update;
  if found then
    if v_row.payment_country = v_country and v_row.payment_currency = v_currency then
      return query select 'unchanged'::text, v_row.payment_country, v_row.payment_currency;
    else
      return query select 'refused_already_initialized'::text,
                          v_row.payment_country, v_row.payment_currency;
    end if;
    return;
  end if;

  perform 1 from public.studio_payment_settings s
    where s.studio_id = p_studio_id for share;
  perform 1 from public.studios st where st.id = p_studio_id for update;
  -- F4: a settings row committed between the share lock above and the studio
  -- upgrade is covered from here on.
  perform 1 from public.studio_payment_settings s
    where s.studio_id = p_studio_id for share;

  -- F5: fail closed on any money-shaped table this command does not know.
  select array_agg(c.relname::text order by c.relname)
    into v_unlisted
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not (c.relname::text = any (c_money_universe))
     and exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and (a.attname in ('currency', 'stripe_account_id')
                         or a.attname::text like '%\_cents' escape '\'));
  if v_unlisted is not null then
    return query select 'refused_unlisted_money_table'::text, null::text, null::text;
    return;
  end if;

  if exists (select 1 from public.appointment_payments ap
              where ap.studio_id = p_studio_id)
     or exists (select 1 from public.pending_booking_payment_sessions ps
                 where ps.studio_id = p_studio_id) then
    return query select 'refused_unverifiable_history'::text, null::text, null::text;
    return;
  end if;

  -- A null currency is "distinct", so it refuses too.
  if exists (select 1 from public.payment_charge_attempts p
              where p.studio_id = p_studio_id and p.currency is distinct from v_currency)
     or exists (select 1 from public.appointment_settlements t
                 where t.studio_id = p_studio_id and t.currency is distinct from v_currency)
     or exists (select 1 from public.manual_fee_charge_attempts f
                 where f.studio_id = p_studio_id and f.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_charge_attempts sc
                 where sc.studio_id = p_studio_id and sc.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_refunds r
                 where r.studio_id = p_studio_id and r.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_refund_attempts ra
                 where ra.studio_id = p_studio_id and ra.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_disputes d
                 where d.studio_id = p_studio_id and d.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_payment_audit au
                 where au.studio_id = p_studio_id and au.currency is distinct from v_currency)
     -- 0393: the visit payment ledger carries its own currency.
     or exists (select 1 from public.visit_bills vb
                 where vb.studio_id = p_studio_id and vb.currency is distinct from v_currency)
     or exists (select 1 from public.visit_external_payments vp
                 where vp.studio_id = p_studio_id and vp.currency is distinct from v_currency)
     or exists (select 1 from public.payment_refunds pr
                 where pr.studio_id = p_studio_id and pr.currency is distinct from v_currency)
     or exists (select 1 from public.payment_refund_reviews rv
                 where rv.studio_id = p_studio_id and rv.currency is distinct from v_currency) then
    return query select 'refused_currency_history'::text, null::text, null::text;
    return;
  end if;

  -- An observed country is never overridden, in either mode.
  if exists (select 1 from public.studio_payment_settings s
              where s.studio_id = p_studio_id
                and s.stripe_account_id is not null
                and s.stripe_account_country is not null
                and (s.stripe_account_country_conflict is not null
                     or s.stripe_account_country <> v_country)) then
    return query select 'refused_account_mismatch'::text, null::text, null::text;
    return;
  end if;

  -- F6: evidence NO acknowledgement can cure. Live or unknown mode must be
  -- bound and observed; a test-mode row must name a test-mode bound account
  -- (observed as this country, or never observed); only a test-mode
  -- provisioning attempt may name no account at all.
  if exists (select 1 from public.studio_payment_settings s
              where s.studio_id = p_studio_id
                and s.stripe_account_id is not null
                and s.stripe_account_country is null
                and s.stripe_livemode is distinct from false)
     or exists (select 1 from public.studio_named_stripe_accounts(p_studio_id) r
                 where case
                         when r.stripe_livemode is distinct from false then
                           not public.studio_account_acceptable_for_jurisdiction(
                                 p_studio_id, r.stripe_account_id, r.stripe_livemode, v_country, false)
                         when r.stripe_account_id is null then not r.is_attempt
                         else not public.studio_account_acceptable_for_jurisdiction(
                                p_studio_id, r.stripe_account_id, false, v_country, true)
                       end) then
    return query select 'refused_account_unverified'::text, null::text, null::text;
    return;
  end if;

  -- F2/F3: what remains needs acknowledgement, by exact id.
  select coalesce(array_agg(distinct s.stripe_account_id order by s.stripe_account_id), '{}')
    into v_need_accounts
    from public.studio_payment_settings s
   where s.studio_id = p_studio_id and s.stripe_livemode = false
     and s.stripe_account_id is not null and s.stripe_account_country is null;
  select coalesce(array_agg(a.id order by a.id), '{}')
    into v_need_attempts
    from public.stripe_account_provisioning_attempts a
   where a.studio_id = p_studio_id and a.stripe_livemode = false
     and a.stripe_account_id is null;
  select coalesce(array_agg(distinct g order by g), '{}') into v_given_accounts
    from unnest(coalesce(p_acknowledged_test_account_ids, '{}')) g;
  select coalesce(array_agg(distinct g order by g), '{}') into v_given_attempts
    from unnest(coalesce(p_acknowledged_test_attempt_ids, '{}')) g;

  if v_given_accounts is distinct from v_need_accounts
     or v_given_attempts is distinct from v_need_attempts then
    return query select
      case when cardinality(v_given_accounts) = 0 and cardinality(v_given_attempts) = 0
           then 'refused_test_account_unobserved'
           else 'refused_test_acknowledgement_stale' end,
      null::text, null::text;
    return;
  end if;

  if not v_ack_prices and (
       exists (select 1 from public.services sv
                where sv.studio_id = p_studio_id and coalesce(sv.price_cents, 0) > 0)
    or exists (select 1 from public.client_pricing cp
                where cp.studio_id = p_studio_id)
    or exists (select 1 from public.studios st
                where st.id = p_studio_id
                  and (coalesce(st.late_cancel_fee_cents, 0) > 0
                       or coalesce(st.no_show_fee_cents, 0) > 0))
    or exists (select 1 from public.sessions se
                where se.studio_id = p_studio_id and se.price_paid_cents is not null)
  ) then
    return query select 'refused_priced_configuration'::text, null::text, null::text;
    return;
  end if;

  insert into public.studio_payment_jurisdictions
    (studio_id, payment_country, payment_currency, source, verification_reference)
  values (p_studio_id, v_country, v_currency, 'operator', v_reference);

  insert into public.studio_payment_jurisdiction_changes
    (studio_id, from_country, from_currency, to_country, to_currency,
     actor, reason, prices_acknowledged, verification_reference, history_verified,
     unobserved_test_accounts_acknowledged, unbound_test_attempts_acknowledged)
  values
    (p_studio_id, null, null, v_country, v_currency,
     v_actor, v_reason, v_ack_prices, v_reference, true,
     v_need_accounts, v_need_attempts);

  return query select 'initialized'::text, v_country, v_currency;
end;
$$;

create or replace function public.initialize_studio_payment_jurisdiction_from_history_v2(
  p_studio_id uuid,
  p_payment_country text,
  p_payment_currency text,
  p_actor text,
  p_reason text,
  p_verification_reference text,
  p_acknowledge_configured_prices boolean default false,
  -- F2/F3: the exact test-mode evidence the operator reviewed. NULL = none.
  p_acknowledged_test_account_ids text[] default null,
  p_acknowledged_test_attempt_ids uuid[] default null,
  -- 0257: the failed live/unknown-mode attempts that never bound an account.
  p_acknowledged_failed_attempt_ids uuid[] default null,
  p_failed_attempts_evidence text default null
)
returns table (
  out_result text,
  out_payment_country text,
  out_payment_currency text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text := upper(btrim(coalesce(p_payment_country, '')));
  v_currency text := lower(btrim(coalesce(p_payment_currency, '')));
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ack_prices boolean := coalesce(p_acknowledge_configured_prices, false);
  v_reference text := btrim(coalesce(p_verification_reference, ''));
  v_given_accounts text[];
  v_given_attempts uuid[];
  v_need_accounts text[];
  v_need_attempts uuid[];
  v_given_failed uuid[];
  v_need_failed uuid[];
  c_failed_evidence constant text := 'stripe_live_account_census_by_studio_metadata';
  v_unlisted text[];
  v_row public.studio_payment_jurisdictions%rowtype;
  -- F5: the pinned universe. Extending it is a reviewed migration.
  c_money_universe constant text[] := array[
    'appointment_payments', 'appointment_settlements', 'client_payment_methods',
    'client_pricing', 'client_stripe_customers', 'manual_fee_charge_attempts',
    'payment_charge_attempts', 'payment_recovery_tokens', 'payment_refund_reviews', 'payment_refunds',
    'pending_booking_payment_sessions', 'services', 'sessions',
    'stripe_account_provisioning_attempts', 'stripe_charge_attempts',
    'stripe_customer_provisioning_attempts', 'stripe_disputes', 'stripe_events',
    'stripe_payment_audit', 'stripe_refund_attempts', 'stripe_refunds',
    'studio_payment_settings', 'studios', 'visit_bills',
    'visit_external_payments'
  ];
begin
  if p_studio_id is null
     or not ((v_country = 'CA' and v_currency = 'cad')
             or (v_country = 'US' and v_currency = 'usd'))
     or length(v_actor) not between 1 and 200
     or length(v_reason) not between 1 and 1000
     or array_position(p_acknowledged_test_account_ids, null) is not null
     or array_position(p_acknowledged_test_attempt_ids, null) is not null
     or array_position(p_acknowledged_failed_attempt_ids, null) is not null
     or (coalesce(cardinality(p_acknowledged_failed_attempt_ids), 0) > 0
         and p_failed_attempts_evidence is distinct from c_failed_evidence)
     or (coalesce(cardinality(p_acknowledged_failed_attempt_ids), 0) = 0
         and p_failed_attempts_evidence is not null) then
    return query select 'invalid_input'::text, null::text, null::text;
    return;
  end if;

  if length(v_reference) not between 1 and 1000 then
    return query select 'verification_required'::text, null::text, null::text;
    return;
  end if;

  perform 1 from public.studios st where st.id = p_studio_id for no key update;
  if not found then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select * into v_row
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for update;
  if found then
    if v_row.payment_country = v_country and v_row.payment_currency = v_currency then
      return query select 'unchanged'::text, v_row.payment_country, v_row.payment_currency;
    else
      return query select 'refused_already_initialized'::text,
                          v_row.payment_country, v_row.payment_currency;
    end if;
    return;
  end if;

  perform 1 from public.studio_payment_settings s
    where s.studio_id = p_studio_id for share;
  perform 1 from public.studios st where st.id = p_studio_id for update;
  -- F4: a settings row committed between the share lock above and the studio
  -- upgrade is covered from here on.
  perform 1 from public.studio_payment_settings s
    where s.studio_id = p_studio_id for share;

  -- F5: fail closed on any money-shaped table this command does not know.
  select array_agg(c.relname::text order by c.relname)
    into v_unlisted
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not (c.relname::text = any (c_money_universe))
     and exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and (a.attname in ('currency', 'stripe_account_id')
                         or a.attname::text like '%\_cents' escape '\'));
  if v_unlisted is not null then
    return query select 'refused_unlisted_money_table'::text, null::text, null::text;
    return;
  end if;

  if exists (select 1 from public.appointment_payments ap
              where ap.studio_id = p_studio_id)
     or exists (select 1 from public.pending_booking_payment_sessions ps
                 where ps.studio_id = p_studio_id) then
    return query select 'refused_unverifiable_history'::text, null::text, null::text;
    return;
  end if;

  -- A null currency is "distinct", so it refuses too.
  if exists (select 1 from public.payment_charge_attempts p
              where p.studio_id = p_studio_id and p.currency is distinct from v_currency)
     or exists (select 1 from public.appointment_settlements t
                 where t.studio_id = p_studio_id and t.currency is distinct from v_currency)
     or exists (select 1 from public.manual_fee_charge_attempts f
                 where f.studio_id = p_studio_id and f.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_charge_attempts sc
                 where sc.studio_id = p_studio_id and sc.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_refunds r
                 where r.studio_id = p_studio_id and r.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_refund_attempts ra
                 where ra.studio_id = p_studio_id and ra.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_disputes d
                 where d.studio_id = p_studio_id and d.currency is distinct from v_currency)
     or exists (select 1 from public.stripe_payment_audit au
                 where au.studio_id = p_studio_id and au.currency is distinct from v_currency)
     -- 0393: the visit payment ledger carries its own currency.
     or exists (select 1 from public.visit_bills vb
                 where vb.studio_id = p_studio_id and vb.currency is distinct from v_currency)
     or exists (select 1 from public.visit_external_payments vp
                 where vp.studio_id = p_studio_id and vp.currency is distinct from v_currency)
     or exists (select 1 from public.payment_refunds pr
                 where pr.studio_id = p_studio_id and pr.currency is distinct from v_currency)
     or exists (select 1 from public.payment_refund_reviews rv
                 where rv.studio_id = p_studio_id and rv.currency is distinct from v_currency) then
    return query select 'refused_currency_history'::text, null::text, null::text;
    return;
  end if;

  -- An observed country is never overridden, in either mode.
  if exists (select 1 from public.studio_payment_settings s
              where s.studio_id = p_studio_id
                and s.stripe_account_id is not null
                and s.stripe_account_country is not null
                and (s.stripe_account_country_conflict is not null
                     or s.stripe_account_country <> v_country)) then
    return query select 'refused_account_mismatch'::text, null::text, null::text;
    return;
  end if;

  -- F6: evidence NO acknowledgement can cure. Live or unknown mode must be
  -- bound and observed; a test-mode row must name a test-mode bound account
  -- (observed as this country, or never observed); only a test-mode
  -- provisioning attempt may name no account at all.
  -- 0257 (the only behavioural change to F6): a live or unknown-mode attempt that
  -- named no account is not a refusal here when it is failed, terminal and
  -- holds no claim token; whether the operator acknowledged exactly those is
  -- decided just below. A pending or processing one still refuses.
  if exists (select 1 from public.studio_payment_settings s
              where s.studio_id = p_studio_id
                and s.stripe_account_id is not null
                and s.stripe_account_country is null
                and s.stripe_livemode is distinct from false)
     or exists (select 1 from public.studio_named_stripe_accounts(p_studio_id) r
                 left join public.stripe_account_provisioning_attempts fa
                   on r.is_attempt and fa.id = r.attempt_id
                 where case
                         when r.stripe_livemode is distinct from false then
                           case
                             when r.is_attempt and r.stripe_account_id is null
                                  and fa.status = 'failed'
                                  and fa.terminal_at is not null
                                  and fa.processing_claim_token is null then false
                             else not public.studio_account_acceptable_for_jurisdiction(
                                    p_studio_id, r.stripe_account_id, r.stripe_livemode, v_country, false)
                           end
                         when r.stripe_account_id is null then not r.is_attempt
                         else not public.studio_account_acceptable_for_jurisdiction(
                                p_studio_id, r.stripe_account_id, false, v_country, true)
                       end) then
    return query select 'refused_account_unverified'::text, null::text, null::text;
    return;
  end if;

  -- 0257: the failed live/unknown-mode attempts that named no account must be
  -- acknowledged by exact id, together with the fixed evidence value.
  select coalesce(array_agg(a.id order by a.id), '{}')
    into v_need_failed
    from public.stripe_account_provisioning_attempts a
   where a.studio_id = p_studio_id and a.stripe_livemode is distinct from false
     and a.stripe_account_id is null
     and a.status = 'failed' and a.terminal_at is not null
     and a.processing_claim_token is null;
  select coalesce(array_agg(distinct g order by g), '{}') into v_given_failed
    from unnest(coalesce(p_acknowledged_failed_attempt_ids, '{}')) g;

  if v_given_failed is distinct from v_need_failed then
    return query select
      case when cardinality(v_given_failed) = 0
           then 'refused_failed_attempt_unacknowledged'
           else 'refused_failed_attempt_acknowledgement_stale' end,
      null::text, null::text;
    return;
  end if;

  -- F2/F3: what remains needs acknowledgement, by exact id.
  select coalesce(array_agg(distinct s.stripe_account_id order by s.stripe_account_id), '{}')
    into v_need_accounts
    from public.studio_payment_settings s
   where s.studio_id = p_studio_id and s.stripe_livemode = false
     and s.stripe_account_id is not null and s.stripe_account_country is null;
  select coalesce(array_agg(a.id order by a.id), '{}')
    into v_need_attempts
    from public.stripe_account_provisioning_attempts a
   where a.studio_id = p_studio_id and a.stripe_livemode = false
     and a.stripe_account_id is null;
  select coalesce(array_agg(distinct g order by g), '{}') into v_given_accounts
    from unnest(coalesce(p_acknowledged_test_account_ids, '{}')) g;
  select coalesce(array_agg(distinct g order by g), '{}') into v_given_attempts
    from unnest(coalesce(p_acknowledged_test_attempt_ids, '{}')) g;

  if v_given_accounts is distinct from v_need_accounts
     or v_given_attempts is distinct from v_need_attempts then
    return query select
      case when cardinality(v_given_accounts) = 0 and cardinality(v_given_attempts) = 0
           then 'refused_test_account_unobserved'
           else 'refused_test_acknowledgement_stale' end,
      null::text, null::text;
    return;
  end if;

  if not v_ack_prices and (
       exists (select 1 from public.services sv
                where sv.studio_id = p_studio_id and coalesce(sv.price_cents, 0) > 0)
    or exists (select 1 from public.client_pricing cp
                where cp.studio_id = p_studio_id)
    or exists (select 1 from public.studios st
                where st.id = p_studio_id
                  and (coalesce(st.late_cancel_fee_cents, 0) > 0
                       or coalesce(st.no_show_fee_cents, 0) > 0))
    or exists (select 1 from public.sessions se
                where se.studio_id = p_studio_id and se.price_paid_cents is not null)
  ) then
    return query select 'refused_priced_configuration'::text, null::text, null::text;
    return;
  end if;

  insert into public.studio_payment_jurisdictions
    (studio_id, payment_country, payment_currency, source, verification_reference)
  values (p_studio_id, v_country, v_currency, 'operator', v_reference);

  insert into public.studio_payment_jurisdiction_changes
    (studio_id, from_country, from_currency, to_country, to_currency,
     actor, reason, prices_acknowledged, verification_reference, history_verified,
     unobserved_test_accounts_acknowledged, unbound_test_attempts_acknowledged,
     failed_attempts_acknowledged, failed_attempts_evidence)
  values
    (p_studio_id, null, null, v_country, v_currency,
     v_actor, v_reason, v_ack_prices, v_reference, true,
     v_need_accounts, v_need_attempts,
     v_need_failed, case when cardinality(v_need_failed) = 0 then null else c_failed_evidence end);

  return query select 'initialized'::text, v_country, v_currency;
end;
$$;


-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY AND GRANTS. Read-only, and OWNER-only, exactly as payment_charge_attempts (0254) and appointment_settlements: the amounts, the free-text
-- notes and reasons here are the owner's. Every write is a 0394 command.
-- ---------------------------------------------------------------------------
alter table public.visit_bills enable row level security;
alter table public.visit_external_payments enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.payment_refund_reviews enable row level security;

create policy "visit_bills_owner_select" on public.visit_bills for select to authenticated
  using (public.is_studio_owner(visit_bills.studio_id));
create policy "visit_external_payments_owner_select" on public.visit_external_payments for select to authenticated
  using (public.is_studio_owner(visit_external_payments.studio_id));
create policy "payment_refunds_owner_select" on public.payment_refunds for select to authenticated
  using (public.is_studio_owner(payment_refunds.studio_id));
create policy "payment_refund_reviews_owner_select" on public.payment_refund_reviews for select to authenticated
  using (public.is_studio_owner(payment_refund_reviews.studio_id));

revoke all on public.visit_bills from public, anon, authenticated, service_role;
revoke all on public.visit_external_payments from public, anon, authenticated, service_role;
revoke all on public.payment_refunds from public, anon, authenticated, service_role;
revoke all on public.payment_refund_reviews from public, anon, authenticated, service_role;
grant select on public.visit_bills to authenticated;
grant select on public.visit_external_payments to authenticated;
grant select on public.payment_refunds to authenticated;
grant select on public.payment_refund_reviews to authenticated;

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
    -- Defence in depth: the payment must sit on a live bill of the same studio, visit and currency.
    if not exists (select 1 from public.visit_bills b where b.id = new.bill_id and b.studio_id = new.studio_id and b.appointment_id = new.appointment_id
                      and b.currency = new.currency and b.superseded_at is null) then
      raise exception 'visit_external_payments: the payment does not match the live bill (studio, visit or currency)' using errcode = '23514';
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

-- THE ONE DEFINITION of money returned on ONE payment. internal helper, no grants.
--   succeeded = least(payment amount, greatest(itemised succeeded, the ATTEMPT's own aggregate succeeded)): the attempt's refund columns are Stripe's
--               CUMULATIVE statement of the whole payment (0078 full only, 0240 full amount only) and the itemised rows are parts of that same money, so the
--               greater of the two, never the sum.
--   reserved  = pending itemised refunds, plus the attempt's own pending whole-payment refund, capped at what is left.
-- An external payment has only itemised, succeeded rows. null amount = the payment cannot be refunded.
create function public.payment_refund_money(p_attempt uuid, p_external uuid)
returns table (payment_cents integer, succeeded_cents integer, reserved_cents integer)
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select m.amount, m.succ, least(m.amount - m.succ, m.pend)
    from (
      select a.amount_cents as amount,
             least(a.amount_cents, greatest(
               coalesce((select sum(r.amount_cents) from public.payment_refunds r where r.attempt_id = a.id and not r.legacy and r.status = 'succeeded'), 0)::integer,
               case when a.refund_status = 'succeeded' then coalesce(a.refund_amount_cents, a.amount_cents) else 0 end)) as succ,
             (coalesce((select sum(r.amount_cents) from public.payment_refunds r where r.attempt_id = a.id and not r.legacy and r.status = 'pending_stripe'), 0)
              + case when a.refund_status = 'pending_stripe' then coalesce(a.refund_amount_cents, a.amount_cents) else 0 end)::integer as pend
        from public.payment_charge_attempts a
       where p_attempt is not null and p_external is null and a.id = p_attempt and a.status = 'succeeded'
      union all
      select e.amount_cents,
             least(e.amount_cents, coalesce((select sum(r.amount_cents) from public.payment_refunds r where r.external_payment_id = e.id and r.status = 'succeeded'), 0))::integer,
             0
        from public.visit_external_payments e
       where p_external is not null and p_attempt is null and e.id = p_external and e.state = 'confirmed'
    ) m;
$$;

-- What is still refundable on ONE payment: its amount less what has come back and what is in flight. 0 while a review is open on it (the owner must
-- acknowledge it first). null when the payment cannot be refunded (not a succeeded attempt, not a confirmed external payment).
create function public.payment_refundable_cents(p_attempt uuid, p_external uuid) returns integer
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select case
           when exists (select 1 from public.payment_refund_reviews v where v.attempt_id = p_attempt and v.resolved_at is null) then 0
           else greatest(0, m.payment_cents - m.succeeded_cents - m.reserved_cents)
         end
    from public.payment_refund_money(p_attempt, p_external) m;
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
    if new.reduced_bill_id is not null and not exists (select 1 from public.visit_bills b where b.id = new.reduced_bill_id and b.studio_id = new.studio_id
                                                         and b.appointment_id = new.appointment_id and b.currency = new.currency) then
      raise exception 'payment_refunds: the reduced bill does not match the refund (studio, visit or currency)' using errcode = '23514';
    end if;
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
    -- A refund OBSERVED in the Stripe dashboard (source stripe_dashboard) already happened: it is recorded by resolve_payment_refund_review (0394), which
    -- checks the capacity itself and refuses over it. The wall must not refuse a fact; every other row meets it.
    if new.source <> 'stripe_dashboard' and v_other + new.amount_cents > v_amount then
      raise exception 'payment_refunds: % cents is more than the % cents still refundable', new.amount_cents, v_amount - v_other
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger payment_refunds_guard_trg before insert or update or delete on public.payment_refunds
  for each row execute function public.payment_refunds_guard();

-- A review is opened by flag_payment_refund_review and closed ONCE by resolve_payment_refund_review or the attempt/refund events (0394). The only fields
-- that ever change are the Stripe status/event of an OPEN review (a newer event, never an older) and the one-time close. Never deleted.
create function public.payment_refund_reviews_guard() returns trigger
language plpgsql volatile set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_ccy text;
  v_amount integer;
  v_appt uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'payment_refund_reviews: financial history is never deleted' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    select a.studio_id, a.currency, a.amount_cents, a.appointment_id into v_studio, v_ccy, v_amount, v_appt
      from public.payment_charge_attempts a where a.id = new.attempt_id and a.status = 'succeeded';
    if not found or v_studio is distinct from new.studio_id or v_ccy is distinct from new.currency
       or new.amount_cents > v_amount or v_appt is distinct from new.appointment_id then
      raise exception 'payment_refund_reviews: the review does not match its payment (studio, visit, currency or amount)' using errcode = '23514';
    end if;
    new.opened_at := now();
    if new.resolved_at is not null or new.closed_code is not null or new.resolved_by_practitioner_id is not null then
      raise exception 'payment_refund_reviews: a review is opened unresolved' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id or new.attempt_id is distinct from old.attempt_id
     or new.appointment_id is distinct from old.appointment_id or new.stripe_refund_id is distinct from old.stripe_refund_id
     or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
     or new.reason_code is distinct from old.reason_code or new.opened_at is distinct from old.opened_at then
    raise exception 'payment_refund_reviews: a review is never edited' using errcode = '23514';
  end if;
  if old.resolved_at is not null then
    raise exception 'payment_refund_reviews: a closed review is final' using errcode = '23514';
  end if;
  if new.stripe_event_created < old.stripe_event_created then
    raise exception 'payment_refund_reviews: a stale Stripe event cannot overwrite a newer one' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger payment_refund_reviews_guard_trg before insert or update or delete on public.payment_refund_reviews
  for each row execute function public.payment_refund_reviews_guard();

-- A cumulative FULL refund landing on the attempt (0240 writes refund_status = 'succeeded') returns every cent of the payment, so any review still open on
-- it is covered: closed auto_recorded, no ledger row (the attempt's own aggregate already counts the money; payment_refund_money takes the greater, never the sum).
-- SECURITY DEFINER because no role holds a write grant on the reviews table; the review guard allows exactly this one transition.
create function public.payment_refund_reviews_cover() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if new.refund_status = 'succeeded' and old.refund_status is distinct from 'succeeded' then
    update public.payment_refund_reviews v set resolved_at = now(), closed_code = 'auto_recorded'
     where v.attempt_id = new.id and v.resolved_at is null;
  end if;
  return new;
end;
$$;
create trigger payment_refund_reviews_cover_trg after update of refund_status on public.payment_charge_attempts
  for each row execute function public.payment_refund_reviews_cover();

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
  -- A refund made through the new flow already carries this attempt's refund history in payment_refunds, row by row. A replayed webhook that touches the
  -- attempt's own refund columns must not add a legacy row on top (the over-refund wall would then refuse it and the webhook would fail): do nothing.
  -- A NEW older-code refund (refund_status becoming pending_stripe, written BEFORE its Stripe call) is different: it keeps meeting the wall, so a full
  -- refund is never started on top of a partial one.
  if new.refund_status is distinct from 'pending_stripe' and exists (select 1 from public.payment_refunds r where r.attempt_id = new.id and not r.legacy and r.status in ('pending_stripe', 'succeeded')) then
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
revoke all privileges on function public.payment_refund_money(uuid, uuid) from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_refund_reviews_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_refund_reviews_cover() from public, anon, authenticated, service_role;

comment on table public.visit_bills is
  '0393. The one bill of a visit, versioned by superseding. A visit with no bill row is a legacy visit and is read as before. Written only by the 0394 commands.';
comment on table public.visit_external_payments is
  '0393. Cash, e-transfer or other transfer payments on a visit. Cash is confirmed on entry; a transfer is pending_confirmation (not counted as paid) until confirmed once or voided. A confirmed payment is final: money returned is a refund. Written only by the 0394 commands.';
comment on table public.payment_refund_reviews is
  '0393. A refund Stripe reports on a card payment that Hone did not make (closed fields only, no free text). Open = the payment refund capacity is frozen and the visit is not read as settled. Written only by the 0394 commands.';
comment on table public.payment_refunds is
  '0393. One row per refund event against ONE payment (a Stripe attempt or an external payment). The remaining refundable amount of a payment is its amount less its pending and succeeded refunds (payment_refundable_cents). Legacy rows mirror the older single refund columns of payment_charge_attempts.';

commit;
