-- 0358: a per-refund history for a card charge, keyed by the provider's refund id, and the one command that records it from a
-- signed provider event.
--
-- WHY. Today a refund that is not the whole charge is not recorded anywhere: the webhook raises an alert and changes nothing, so
-- the panel and the owner's balance keep reading the charge as fully kept. This records every refund the provider tells us about,
-- one row per refund, so the amount refunded and the amount still refundable can be derived from the rows.
--
-- WHAT.
--   1. public.payment_charge_refunds: one row per provider refund of one card charge. Written ONLY by the command below.
--   2. Four columns on public.payment_charge_attempts that summarise the rows for one charge:
--        refund_history_event_id / refund_history_event_created  the signed event whose COMPLETE refund list first established the
--                                                                history (both NULL until then, both set together)
--        refunds_succeeded_cents                                  money the provider has returned in total; NULL until established
--        refunds_inflight_count                                   refunds still pending or needing action (NOT NULL, default 0)
--      NULL means "the history was never established for this charge" and is NEVER read as "nothing was refunded".
--   3. public.record_charge_refund_history(...): the single writer. Security definer, EXECUTE for service_role only.
--   4. The two studio-jurisdiction initialisers (0214 and its 0257 v2) are re-created with ONE change, the new table added to their pinned
--      money-table list (section 4 explains why without it they would refuse for every studio).
--
-- WHAT THIS DOES NOT DO. It changes no existing column or value, backfills nothing, writes nothing for a charge until a signed event
-- for that charge arrives, calls no provider, and does not change reconcile_bound_payment_event (0240), the refund action, the
-- webhook route, the panel or the balance, and it changes the two jurisdiction initialisers only by that one list entry.
--
-- RULES THE COMMAND ENFORCES (each is a result string, never a silent write):
--   * identity: studio, connected account, mode, customer, payment intent, charge, amount and currency must equal the stored
--     attempt, exactly as reconcile_bound_payment_event requires (metadata is not authority);
--   * the evidence must be a signed event (evidence_kind = signed_event) of type charge.refunded, refund.created, refund.updated or
--     refund.failed;
--   * every component: a distinct non-blank refund id, an integer amount above zero and not above the charge, the attempt's currency,
--     the attempt's charge and payment intent, and a status of pending, requires_action, succeeded, failed or canceled;
--   * a refund's amount and currency never change, a terminal status (succeeded, failed, canceled) never changes, and a later or
--     older nonterminal observation never undoes a terminal one; a conflicting terminal status is refused (terminal_refund_mismatch);
--   * the succeeded refunds together never exceed the charge, and for a complete list the charge's own refunded total must sit
--     between the succeeded total and the succeeded plus in-flight total;
--   * the same event replayed, or an older event, changes nothing that is already recorded (already_recorded);
--   * rows are never deleted, so a summary can only be stale-low (a refund whose event was missed), never invented.
--
-- LOCK ORDER. The appointment settlement advisory lock BEFORE the attempt row lock, exactly the 0187/0240 order.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Summary columns on the attempt.
-- ---------------------------------------------------------------------------
alter table public.payment_charge_attempts
  add column if not exists refund_history_event_id text,
  add column if not exists refund_history_event_created bigint,
  add column if not exists refunds_succeeded_cents integer,
  add column if not exists refunds_inflight_count integer not null default 0;

-- NOT VALID first, then VALIDATE in a separate statement: adding a CHECK validates every existing row while holding the table's
-- exclusive lock; NOT VALID takes the lock only briefly and VALIDATE scans under a weaker lock. The new columns are all NULL or zero
-- on existing rows, so validation cannot fail on existing data.
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_refund_history_check check (
    (refund_history_event_id is null and refund_history_event_created is null and refunds_succeeded_cents is null)
    or (refund_history_event_id is not null and length(refund_history_event_id) > 0
        and refund_history_event_created is not null and refund_history_event_created >= 0
        and refunds_succeeded_cents is not null and refunds_succeeded_cents >= 0)
  ) not valid,
  add constraint payment_charge_attempts_refunds_succeeded_bound_check check (
    refunds_succeeded_cents is null or amount_cents is null or refunds_succeeded_cents <= amount_cents
  ) not valid,
  add constraint payment_charge_attempts_refunds_inflight_check check (refunds_inflight_count >= 0) not valid;

alter table public.payment_charge_attempts validate constraint payment_charge_attempts_refund_history_check;
alter table public.payment_charge_attempts validate constraint payment_charge_attempts_refunds_succeeded_bound_check;
alter table public.payment_charge_attempts validate constraint payment_charge_attempts_refunds_inflight_check;

comment on column public.payment_charge_attempts.refunds_succeeded_cents is
  '0358. Total the provider has returned on this charge, summed from payment_charge_refunds. NULL means the refund history was never established for this charge (a complete signed refund list has not been recorded); it is never "nothing refunded".';
comment on column public.payment_charge_attempts.refunds_inflight_count is
  '0358. Refunds recorded as pending or requiring action. While above zero the amount still refundable is unknown.';
comment on column public.payment_charge_attempts.refund_history_event_id is
  '0358. The signed event whose complete refund list first established the history. Set once with its creation time; never rewritten.';
comment on column public.payment_charge_attempts.refund_history_event_created is
  '0358. Provider creation time (seconds) of refund_history_event_id.';

-- ---------------------------------------------------------------------------
-- 2. The history table.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_charge_refunds (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.payment_charge_attempts(id) on delete restrict,
  studio_id uuid not null references public.studios(id) on delete restrict,
  stripe_refund_id text not null check (length(btrim(stripe_refund_id)) > 0),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (length(currency) > 0),
  status text not null check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  first_event_id text not null check (length(first_event_id) > 0),
  last_event_id text not null check (length(last_event_id) > 0),
  last_event_created bigint not null check (last_event_created >= 0),
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_charge_refunds_attempt_refund_key unique (attempt_id, stripe_refund_id)
);

create index if not exists payment_charge_refunds_studio_attempt_idx
  on public.payment_charge_refunds (studio_id, attempt_id);

comment on table public.payment_charge_refunds is
  '0358. One row per provider refund of one card charge, written only by record_charge_refund_history from a signed event. Amount and currency never change and a terminal status never changes. Rows are never deleted.';

alter table public.payment_charge_refunds enable row level security;

drop policy if exists "payment_charge_refunds: owners read" on public.payment_charge_refunds;
create policy "payment_charge_refunds: owners read"
  on public.payment_charge_refunds
  for select to authenticated
  using (public.is_studio_owner(studio_id));

revoke all on public.payment_charge_refunds from public;
revoke all on public.payment_charge_refunds from anon;
revoke all on public.payment_charge_refunds from authenticated;
revoke all on public.payment_charge_refunds from service_role;
grant select on public.payment_charge_refunds to authenticated;
grant select on public.payment_charge_refunds to service_role;

-- A refund row is append-and-advance only: identity, amount and currency are fixed, and a terminal status is final.
create or replace function public.payment_charge_refunds_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment_charge_refunds: rows are never deleted' using errcode = 'check_violation';
  end if;
  if new.attempt_id is distinct from old.attempt_id
     or new.studio_id is distinct from old.studio_id
     or new.stripe_refund_id is distinct from old.stripe_refund_id
     or new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency
     or new.first_event_id is distinct from old.first_event_id
     or new.recorded_at is distinct from old.recorded_at then
    raise exception 'payment_charge_refunds: identity, amount and currency of a refund never change'
      using errcode = 'check_violation';
  end if;
  if old.status in ('succeeded', 'failed', 'canceled') and new.status is distinct from old.status then
    raise exception 'payment_charge_refunds: a terminal refund status never changes'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.payment_charge_refunds_guard() from public;
revoke execute on function public.payment_charge_refunds_guard() from anon;
revoke execute on function public.payment_charge_refunds_guard() from authenticated;
revoke execute on function public.payment_charge_refunds_guard() from service_role;

drop trigger if exists payment_charge_refunds_guard on public.payment_charge_refunds;
create trigger payment_charge_refunds_guard
  before update or delete on public.payment_charge_refunds
  for each row execute function public.payment_charge_refunds_guard();

-- ---------------------------------------------------------------------------
-- 3. The single writer.
-- ---------------------------------------------------------------------------
create or replace function public.record_charge_refund_history(
  p_attempt_id uuid,
  p_event_id text,
  p_event_type text,
  p_studio_id uuid,
  p_stripe_account_id text,
  p_livemode boolean,
  p_object jsonb
)
returns table(result text, out_attempt_id uuid, out_studio_id uuid, out_succeeded_cents integer, out_inflight_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appointment_id uuid;
  v_row public.payment_charge_attempts%rowtype;
  v_charge text := nullif(p_object->>'charge_id','');
  v_event_created bigint;
  v_complete boolean;
  v_component jsonb;
  v_amount bigint;
  v_status text;
  v_refund text;
  v_ids text[] := array[]::text[];
  v_existing public.payment_charge_refunds%rowtype;
  v_effective text;
  v_merged_succeeded bigint := 0;
  v_merged_inflight integer := 0;
  v_incoming_succeeded bigint := 0;
  v_incoming_inflight bigint := 0;
  v_event_succeeded bigint := 0;
  v_event_inflight_amount bigint := 0;
  v_others_succeeded bigint;
  v_others_inflight integer;
  v_changed boolean := false;
  v_established boolean;
  v_charge_refunded bigint;
begin
  if p_attempt_id is null or nullif(btrim(p_event_id),'') is null
     or p_event_type is null
     or p_event_type not in ('charge.refunded','refund.created','refund.updated','refund.failed')
     or jsonb_typeof(p_object) is distinct from 'object'
     or p_object->>'evidence_kind' is distinct from 'signed_event'
     or coalesce(p_object->>'event_created','') !~ '^[0-9]{1,12}$'
     or jsonb_typeof(p_object->'components') is distinct from 'array'
     or jsonb_array_length(p_object->'components') = 0
     or jsonb_array_length(p_object->'components') > 100 then
    return query select 'invalid_input'::text, null::uuid, null::uuid, null::integer, null::integer;
    return;
  end if;
  v_event_created := (p_object->>'event_created')::bigint;

  -- The 0187/0240 order: appointment advisory mutex BEFORE the attempt row lock.
  select coalesce(a.appointment_id, s.appointment_id) into v_appointment_id
    from public.payment_charge_attempts a
    left join public.sessions s on s.id = a.session_id and s.studio_id = a.studio_id
    where a.id = p_attempt_id;
  if v_appointment_id is not null then
    perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(v_appointment_id));
  end if;
  select * into v_row from public.payment_charge_attempts a where a.id = p_attempt_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::integer, null::integer;
    return;
  end if;

  -- Metadata is not authority: every identity field must equal what was stored when the charge was made.
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
     or nullif(v_row.stripe_charge_id,'') is null
     or v_charge is distinct from v_row.stripe_charge_id then
    return query select 'identity_mismatch'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
    return;
  end if;
  if v_row.status <> 'succeeded' or v_row.amount_cents is null or v_row.amount_cents <= 0 then
    return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
    return;
  end if;

  v_complete := p_event_type = 'charge.refunded'
    and p_object->'charge_refund_list_complete' = 'true'::jsonb
    and jsonb_typeof(p_object->'charge_amount_refunded') = 'number'
    and coalesce(p_object->>'charge_amount_refunded','') ~ '^[0-9]{1,12}$';

  -- Pass 1: validate every component and compute what the totals WOULD be. Nothing is written yet.
  for v_component in select value from jsonb_array_elements(p_object->'components') loop
    v_refund := nullif(btrim(v_component->>'refund_id'),'');
    v_status := v_component->>'refund_status';
    if jsonb_typeof(v_component) is distinct from 'object'
       or v_refund is null
       or v_refund = any(v_ids)
       or jsonb_typeof(v_component->'amount_cents') is distinct from 'number'
       or coalesce(v_component->>'amount_cents','') !~ '^[0-9]{1,12}$'
       or v_status is null
       or v_status not in ('pending','requires_action','succeeded','failed','canceled')
       or v_component->>'currency' is distinct from v_row.currency
       or v_component->>'charge_id' is distinct from v_row.stripe_charge_id
       or v_component->>'payment_intent_id' is distinct from v_row.stripe_payment_intent_id then
      return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
      return;
    end if;
    v_amount := (v_component->>'amount_cents')::bigint;
    if v_amount <= 0 or v_amount > v_row.amount_cents then
      return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
      return;
    end if;
    v_ids := array_append(v_ids, v_refund);
    -- The event's own account of itself, by the statuses the event states (used only for the cross-check below).
    if v_status = 'succeeded' then v_event_succeeded := v_event_succeeded + v_amount;
    elsif v_status in ('pending','requires_action') then v_event_inflight_amount := v_event_inflight_amount + v_amount;
    end if;

    select * into v_existing from public.payment_charge_refunds r
      where r.attempt_id = v_row.id and r.stripe_refund_id = v_refund;
    if found then
      if v_existing.amount_cents <> v_amount or v_existing.currency <> v_row.currency then
        return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
        return;
      end if;
      if v_existing.status in ('succeeded','failed','canceled') then
        if v_status in ('succeeded','failed','canceled') and v_status <> v_existing.status then
          return query select 'terminal_refund_mismatch'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
          return;
        end if;
        v_effective := v_existing.status;           -- a terminal fact is never undone by a later or older observation
      elsif v_status in ('succeeded','failed','canceled') then
        v_effective := v_status;
      else
        v_effective := case when v_existing.status = 'requires_action' then 'requires_action' else v_status end;
      end if;
    else
      v_effective := v_status;
    end if;

    if v_effective = 'succeeded' then v_incoming_succeeded := v_incoming_succeeded + v_amount;
    elsif v_effective in ('pending','requires_action') then v_incoming_inflight := v_incoming_inflight + 1;
    end if;
  end loop;

  -- Rows already recorded for this charge that the event does not mention are kept as they are.
  select coalesce(sum(r.amount_cents) filter (where r.status = 'succeeded'), 0),
         coalesce(count(*) filter (where r.status in ('pending','requires_action')), 0)
    into v_others_succeeded, v_others_inflight
    from public.payment_charge_refunds r
    where r.attempt_id = v_row.id and not (r.stripe_refund_id = any(v_ids));
  v_merged_succeeded := v_others_succeeded + v_incoming_succeeded;
  v_merged_inflight := v_others_inflight + v_incoming_inflight::integer;

  if v_merged_succeeded > v_row.amount_cents then
    return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
    return;
  end if;
  if v_complete then
    v_charge_refunded := (p_object->>'charge_amount_refunded')::bigint;
    -- The charge's own refunded total must be accounted for by the components: at least the succeeded money, at most the succeeded
    -- plus the in-flight refunds that the event lists. Anything else means the list and the total do not describe the same charge.
    if v_charge_refunded < v_event_succeeded
       or v_charge_refunded > v_event_succeeded + v_event_inflight_amount
       or v_charge_refunded > v_row.amount_cents then
      return query select 'refund_evidence_refused'::text, v_row.id, v_row.studio_id, null::integer, null::integer;
      return;
    end if;
  end if;

  -- Pass 2: write. Insert new refunds, advance nonterminal ones, never touch a terminal one.
  for v_component in select value from jsonb_array_elements(p_object->'components') loop
    v_refund := btrim(v_component->>'refund_id');
    v_status := v_component->>'refund_status';
    v_amount := (v_component->>'amount_cents')::bigint;
    select * into v_existing from public.payment_charge_refunds r
      where r.attempt_id = v_row.id and r.stripe_refund_id = v_refund for update;
    if not found then
      insert into public.payment_charge_refunds
        (attempt_id, studio_id, stripe_refund_id, amount_cents, currency, status, first_event_id, last_event_id, last_event_created)
      values (v_row.id, v_row.studio_id, v_refund, v_amount::integer, v_row.currency, v_status, p_event_id, p_event_id, v_event_created);
      v_changed := true;
    elsif v_existing.status not in ('succeeded','failed','canceled')
          and v_status is distinct from v_existing.status
          and not (v_existing.status = 'requires_action' and v_status = 'pending') then
      update public.payment_charge_refunds r
        set status = v_status, last_event_id = p_event_id,
            last_event_created = greatest(r.last_event_created, v_event_created), updated_at = now()
        where r.id = v_existing.id;
      v_changed := true;
    end if;
  end loop;

  -- The summary is always recomputed from the rows, never from the event.
  v_established := v_row.refund_history_event_id is not null;
  if v_complete and not v_established then
    v_established := true;
    v_changed := true;
  end if;
  if v_established then
    update public.payment_charge_attempts a
      set refunds_succeeded_cents = v_merged_succeeded::integer,
          refunds_inflight_count = v_merged_inflight,
          refund_history_event_id = coalesce(a.refund_history_event_id, p_event_id),
          refund_history_event_created = coalesce(a.refund_history_event_created, v_event_created)
      where a.id = v_row.id
        and (a.refunds_succeeded_cents is distinct from v_merged_succeeded::integer
             or a.refunds_inflight_count is distinct from v_merged_inflight
             or a.refund_history_event_id is null);
  elsif v_merged_inflight is distinct from v_row.refunds_inflight_count then
    update public.payment_charge_attempts a set refunds_inflight_count = v_merged_inflight where a.id = v_row.id;
    v_changed := true;
  end if;

  return query select (case when v_changed then 'recorded' else 'already_recorded' end)::text,
    v_row.id, v_row.studio_id,
    (case when v_established then v_merged_succeeded::integer else null end),
    v_merged_inflight;
end;
$$;

revoke all privileges on function public.record_charge_refund_history(uuid, text, text, uuid, text, boolean, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_charge_refund_history(uuid, text, text, uuid, text, boolean, jsonb) to service_role;

comment on function public.record_charge_refund_history(uuid, text, text, uuid, text, boolean, jsonb) is
  '0358. The only writer of payment_charge_refunds and of the refund-history summary columns. Signed-event evidence only; identity must equal the stored attempt; amounts and terminal statuses never change; replays and older events change nothing.';

-- ---------------------------------------------------------------------------
-- 4. The jurisdiction initialisers' money-table list.
-- ---------------------------------------------------------------------------
-- initialize_studio_payment_jurisdiction_from_history (0214) and its v2 (0257) refuse with 'refused_unlisted_money_table' when ANY
-- public table has a currency, stripe_account_id or *_cents column and is not in their pinned list ("Extending it is a reviewed
-- migration"). payment_charge_refunds has amount_cents and currency, so without this section applying 0358 would make both
-- commands refuse for every studio. The table holds no money of its own that the jurisdiction check does not already see through its
-- parent: every row's currency is the attempt's (the recording command enforces it), and the attempts are checked as before.
-- The two functions below are 0214's and 0257's bodies BYTE FOR BYTE, with the single change of adding 'payment_charge_refunds' to
-- c_money_universe. tests/migrations/0358-payment-charge-refund-history.test.ts proves that equality. Grants are untouched (CREATE OR
-- REPLACE keeps them).

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
    'payment_charge_attempts', 'payment_charge_refunds', 'payment_recovery_tokens',
    'pending_booking_payment_sessions', 'services', 'sessions',
    'stripe_account_provisioning_attempts', 'stripe_charge_attempts',
    'stripe_customer_provisioning_attempts', 'stripe_disputes', 'stripe_events',
    'stripe_payment_audit', 'stripe_refund_attempts', 'stripe_refunds',
    'studio_payment_settings', 'studios'
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
                 where au.studio_id = p_studio_id and au.currency is distinct from v_currency) then
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
    'payment_charge_attempts', 'payment_charge_refunds', 'payment_recovery_tokens',
    'pending_booking_payment_sessions', 'services', 'sessions',
    'stripe_account_provisioning_attempts', 'stripe_charge_attempts',
    'stripe_customer_provisioning_attempts', 'stripe_disputes', 'stripe_events',
    'stripe_payment_audit', 'stripe_refund_attempts', 'stripe_refunds',
    'studio_payment_settings', 'studios'
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
                 where au.studio_id = p_studio_id and au.currency is distinct from v_currency) then
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

commit;
