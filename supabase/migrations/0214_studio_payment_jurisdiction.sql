-- ===========================================================================
-- 0214 — PAY-CCY-02 (#824): EACH STUDIO CHARGES IN ITS OWN COUNTRY'S CURRENCY
-- ===========================================================================
--
-- BEFORE THIS FILE, CANADA WAS A CONSTANT. Every ledger that holds money pinned
-- its currency to a single legal value — payment_charge_attempts (0073),
-- appointment_settlements (0187), manual_fee_charge_attempts (0064) and the
-- dormant 0032 tables all CHECK `currency in ('cad')` — the application wrote
-- the literal "cad" when it prepared a charge, and every Stripe Express account
-- was created in whatever country one deployment-wide environment variable
-- named (CA by default). A studio in Los Angeles could not be described.
--
-- WHAT THIS FILE ADDS
--
--   1. public.studio_payment_jurisdictions — ONE ROW PER STUDIO naming its
--      payment country and its currency as two explicit values. Only the pairs
--      CA/cad and US/usd exist. Nothing infers them: not the timezone, not the
--      address, not the phone number.
--   2. No studio is assigned a country or currency by migration or creation.
--      Missing verified onboarding evidence remains a MISSING row (UNKNOWN).
--      An operator must verify BOTH the business country and intended charge
--      currency and supply the evidence reference to the governed command.
--   3. public.set_studio_payment_jurisdiction — the ONLY writer of a change,
--      service_role only, audited in public.studio_payment_jurisdiction_changes.
--      It REFUSES once the studio has a Stripe account (any mode, any status)
--      or any money history, and refuses over configured prices unless the
--      operator explicitly acknowledges them. Old prices and old transactions
--      are never silently reinterpreted as another currency.
--   3b. public.initialize_studio_payment_jurisdiction_from_history — the one
--       other writer, service_role only, audited in the same table. It
--       INITIALIZES a studio that already has a Stripe account or money
--       history, and only when every money row states the operator's verified
--       currency and every account checks out (section 3b). It never changes
--       an existing pair and rewrites no row.
--   4. The two LIVE ledgers widen their currency CHECK to ('cad','usd') and gain
--      a database guard tying each row to its studio:
--        * payment_charge_attempts: an attempt must be prepared in the studio's
--          currency, on an account whose observed country is the studio's
--          country (or, for a Canadian studio only, an account Hone has never
--          observed — every pre-#824 account was created in CA). Its
--          amount_cents and currency are then IMMUTABLE.
--        * appointment_settlements: currency is a SERVER-OWNED fact, set from
--          the studio like recorded_at is, because none of the 0187 commands
--          ever passed one.
--   5. studio_payment_settings gains what Stripe says about each connected
--      account — its country and default currency — and
--      public.record_stripe_account_jurisdiction records it, write-once for
--      the country. A known mismatch fails closed at every charge; nothing
--      here ever replaces an account.
--
-- HISTORICAL AMOUNTS ARE UNTOUCHED. Every existing ledger row is already CAD:
-- the CHECKs above have never admitted anything else, so no row can be
-- anything other than CAD and this file rewrites none of them. The census in
-- #824 (counts only) confirms the shape; it is not needed to know the currency.
--
-- WHAT DOES NOT CHANGE
--   * manual_fee_charge_attempts (legacy, no runtime writer since 0083) and the
--     dormant 0032 tables keep their CAD-only CHECKs. Nothing writes them.
--   * The 0103 provisioning and status RPCs are not redefined. The account
--     country is recorded by the new command, called after them.
--   * studio_payment_settings.default_charge_currency (0032) stays CAD-only
--     and unread: the charge currency is the studio's, below, not a column on
--     a per-mode settings row.
--   * No FX, no conversion, no payout or provider change, and no consent,
--     idempotency, readiness or recovery rule.
--
-- LOCK ORDER. A charge attempt or a settlement takes FOR SHARE on its studio's
-- jurisdiction row before it is written; the change command takes FOR UPDATE
-- and only then looks for history. So a change and a first payment cannot
-- interleave: whichever commits second sees the other.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The jurisdiction
-- ---------------------------------------------------------------------------

create table if not exists public.studio_payment_jurisdictions (
  studio_id uuid primary key
    references public.studios(id) on delete cascade,

  -- ISO 3166-1 alpha-2, upper case. The country of the studio's BUSINESS, which
  -- is the country its Stripe connected account must be created in.
  payment_country text not null,

  -- ISO 4217, lower case, as Stripe and every ledger spell it.
  payment_currency text not null,

  -- operator: explicit verified onboarding/change through the audited command.
  source text not null,
  verification_reference text not null check (length(btrim(verification_reference)) between 1 and 1000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_payment_jurisdictions_pair_check check (
    (payment_country = 'CA' and payment_currency = 'cad')
    or (payment_country = 'US' and payment_currency = 'usd')
  ),
  constraint studio_payment_jurisdictions_source_check check (
    source = 'operator'
  )
);

-- The audit trail of every change the command makes. Append-only by privilege:
-- no role holds INSERT, UPDATE or DELETE, and the command is its only writer.
create table if not exists public.studio_payment_jurisdiction_changes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  -- NULL only for the first verified pair; no guessed previous jurisdiction.
  from_country text,
  from_currency text,
  to_country text not null,
  to_currency text not null,
  -- Who did it, as the operator names themself. Free text because the operator
  -- path is SQL as well as a future console; never a client identity.
  actor text not null,
  reason text not null,
  verification_reference text not null check (length(btrim(verification_reference)) between 1 and 1000),
  -- True when the studio already had configured or recorded prices and the
  -- operator explicitly accepted that those numbers now mean the new currency.
  prices_acknowledged boolean not null default false,
  -- True when initialize_studio_payment_jurisdiction_from_history
  -- recorded the first pair over history it verified consistent.
  history_verified boolean not null default false,
  -- The exact TEST-mode bound accounts (never observed by this
  -- deployment) and unbound TEST-mode provisioning attempts the
  -- operator reviewed and acknowledged. Empty unless acknowledged.
  unobserved_test_accounts_acknowledged text[] not null default '{}',
  unbound_test_attempts_acknowledged uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint studio_payment_jurisdiction_changes_actor_check
    check (length(btrim(actor)) between 1 and 200),
  constraint studio_payment_jurisdiction_changes_reason_check
    check (length(btrim(reason)) between 1 and 1000)
);

create index if not exists studio_payment_jurisdiction_changes_studio_idx
  on public.studio_payment_jurisdiction_changes (studio_id, created_at);

drop trigger if exists studio_payment_jurisdictions_set_updated_at
  on public.studio_payment_jurisdictions;
create trigger studio_payment_jurisdictions_set_updated_at
  before update on public.studio_payment_jurisdictions
  for each row execute function public.set_updated_at();

alter table public.studio_payment_jurisdictions enable row level security;
alter table public.studio_payment_jurisdiction_changes enable row level security;

-- ---------------------------------------------------------------------------
-- 2. No backfill and no automatic jurisdiction/default trigger
-- ---------------------------------------------------------------------------
-- Sam's 2026-10-21 policy: existing and future studios remain UNKNOWN until
-- BOTH country and charge currency have verified evidence. Existing recorded
-- money is never rewritten or treated as onboarding evidence. There is no
-- implicit CA/cad fallback, including for a new studio.

-- ---------------------------------------------------------------------------
-- 3. The protected change command
-- ---------------------------------------------------------------------------
--
-- Results (out_result):
--   initialized                   the first explicitly verified pair was recorded
--   verification_required         no evidence reference; UNKNOWN is unchanged
--   changed                       the studio now charges in the new pair
--   unchanged                     it already did; nothing written
--   refused_payment_account       a Stripe account, provisioning attempt, saved
--                                 card or Stripe customer exists, in any mode
--   refused_monetary_history      a charge attempt, settlement or any legacy or
--                                 dormant payment row exists
--   refused_priced_configuration  services, client prices, studio fees or
--                                 recorded session prices exist and the caller
--                                 did not acknowledge them
--   not_found                     no such studio
--   invalid_input                 not an allowed pair, or no actor or reason
create or replace function public.set_studio_payment_jurisdiction(
  p_studio_id uuid,
  p_payment_country text,
  p_payment_currency text,
  p_actor text,
  p_reason text,
  p_acknowledge_configured_prices boolean default false,
  p_verification_reference text default null
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
  v_ack boolean := coalesce(p_acknowledge_configured_prices, false);
  v_reference text := btrim(coalesce(p_verification_reference, ''));
  v_initial boolean;
  v_row public.studio_payment_jurisdictions%rowtype;
begin
  if p_studio_id is null
     or not ((v_country = 'CA' and v_currency = 'cad')
             or (v_country = 'US' and v_currency = 'usd'))
     or length(v_actor) not between 1 and 200
     or length(v_reason) not between 1 and 1000 then
    return query select 'invalid_input'::text, null::text, null::text;
    return;
  end if;

  if length(v_reference) not between 1 and 1000 then
    return query select 'verification_required'::text, null::text, null::text;
    return;
  end if;

  -- Serialize first initialization on the existing studio, then its jurisdiction.
  -- NO KEY UPDATE still serializes initializers but permits the KEY SHARE
  -- needed by a payment FK after its jurisdiction SHARE lock; FOR UPDATE here
  -- would create a parent/jurisdiction lock cycle. We never change the parent key.
  -- Missing evidence never creates a placeholder/default row. Existing money
  -- and account refusals below also apply to initialization, not just changes.
  perform 1 from public.studios st where st.id = p_studio_id for no key update;
  if not found then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- FOR UPDATE FIRST, history second. A charge attempt or settlement takes FOR
  -- SHARE on this row before it is written (section 4), so once this lock is
  -- held no first payment can slip in between the checks below and the write.
  select * into v_row
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for update;
  v_initial := not found;

  -- Only upgrade the parent AFTER acquiring the jurisdiction lock. This waits
  -- for in-flight price inserts' FK KEY SHARE before checking their committed
  -- rows, and prevents new inserts until the currency decision commits. Taking
  -- this stronger lock before the jurisdiction would deadlock a payer that
  -- already holds jurisdiction SHARE and still needs its parent FK KEY SHARE.
  perform 1 from public.studios st where st.id = p_studio_id for update;

  if v_row.payment_country = v_country and v_row.payment_currency = v_currency then
    return query select 'unchanged'::text, v_row.payment_country, v_row.payment_currency;
    return;
  end if;

  -- AN ACCOUNT FIXES THE COUNTRY. A Stripe connected account cannot change
  -- country, and a provisioning attempt may already have created one, so any
  -- trace of one — in either mode, in any state — ends the question here. The
  -- saved cards and customers are bound to such an account by construction.
  if exists (select 1 from public.stripe_account_provisioning_attempts a
              where a.studio_id = p_studio_id)
     or exists (select 1 from public.studio_payment_settings s
                 where s.studio_id = p_studio_id and s.stripe_account_id is not null)
     or exists (select 1 from public.client_payment_methods m
                 where m.studio_id = p_studio_id)
     or exists (select 1 from public.client_stripe_customers c
                 where c.studio_id = p_studio_id) then
    return query select 'refused_payment_account'::text,
                        v_row.payment_country, v_row.payment_currency;
    return;
  end if;

  -- MONEY ALREADY RECORDED IS RECORDED IN ITS CURRENCY. Changing the studio's
  -- currency under it would reinterpret every amount it holds.
  if exists (select 1 from public.payment_charge_attempts p
              where p.studio_id = p_studio_id)
     or exists (select 1 from public.appointment_settlements t
                 where t.studio_id = p_studio_id)
     or exists (select 1 from public.manual_fee_charge_attempts f
                 where f.studio_id = p_studio_id)
     or exists (select 1 from public.appointment_payments ap
                 where ap.studio_id = p_studio_id)
     or exists (select 1 from public.stripe_charge_attempts sc
                 where sc.studio_id = p_studio_id)
     or exists (select 1 from public.pending_booking_payment_sessions ps
                 where ps.studio_id = p_studio_id) then
    return query select 'refused_monetary_history'::text,
                        v_row.payment_country, v_row.payment_currency;
    return;
  end if;

  -- PRICES ARE NUMBERS WITHOUT A CURRENCY OF THEIR OWN. They mean the studio's
  -- currency, so changing it changes what they mean. That is often exactly
  -- right — an American studio set up as Canadian by default typed its prices
  -- in dollars it meant as US dollars — but it must be said out loud.
  if not v_ack and (
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
    return query select 'refused_priced_configuration'::text,
                        v_row.payment_country, v_row.payment_currency;
    return;
  end if;

  if v_initial then
    insert into public.studio_payment_jurisdictions
      (studio_id, payment_country, payment_currency, source, verification_reference)
    values (p_studio_id, v_country, v_currency, 'operator', v_reference);
  else
    update public.studio_payment_jurisdictions j
       set payment_country = v_country,
           payment_currency = v_currency,
           source = 'operator',
           verification_reference = v_reference
     where j.studio_id = p_studio_id;
  end if;

  insert into public.studio_payment_jurisdiction_changes
    (studio_id, from_country, from_currency, to_country, to_currency,
     actor, reason, prices_acknowledged, verification_reference)
  values
    (p_studio_id, v_row.payment_country, v_row.payment_currency, v_country, v_currency,
     v_actor, v_reason, v_ack, v_reference);

  return query select case when v_initial then 'initialized' else 'changed' end, v_country, v_currency;
end;
$$;

-- Price-only UPDATE does not repeat a foreign-key check. Take the same parent
-- lock explicitly for every relevant price write, including UNKNOWN studios.
-- No jurisdiction/evidence is required to configure clinical prices. The setter
-- upgrades its parent lock only after the jurisdiction lock, so these writers
-- serialize with its price snapshot without reintroducing the payment FK cycle.
create or replace function public.studio_price_write_jurisdiction_lock()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Known prices take the same first lock as a subsequent payment in this
  -- transaction. Otherwise a price FK followed by payment could invert the
  -- setter's jurisdiction/parent-upgrade order.
  perform 1 from public.studio_payment_jurisdictions j
    where j.studio_id = new.studio_id for share;
  if found then
    perform 1 from public.studios st where st.id = new.studio_id for key share;
  else
    -- There is no jurisdiction row to lock yet. SHARE conflicts with the
    -- initializer's initial NO KEY UPDATE, without inventing a default row.
    perform 1 from public.studios st where st.id = new.studio_id for share;
  end if;
  return new;
end;
$$;

create trigger services_price_jurisdiction_lock
before insert or update of studio_id, price_cents on public.services
for each row execute function public.studio_price_write_jurisdiction_lock();
create trigger client_pricing_jurisdiction_lock
before insert or update of studio_id on public.client_pricing
for each row execute function public.studio_price_write_jurisdiction_lock();
create trigger sessions_price_jurisdiction_lock
before insert or update of studio_id, price_paid_cents on public.sessions
for each row execute function public.studio_price_write_jurisdiction_lock();
-- Studio fee UPDATE already locks this same parent row and conflicts with the
-- setter's initial NO KEY UPDATE lock; it needs no additional trigger.

-- ---------------------------------------------------------------------------
-- 4. The ledgers follow the studio
-- ---------------------------------------------------------------------------

-- 4a. Widen the two LIVE ledgers' currency CHECKs. The constraint names are the
-- ones 0073 (inline column check, named by PostgreSQL) and 0187 created.
alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_currency_check;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_currency_check
  check (currency in ('cad', 'usd'));

alter table public.appointment_settlements
  drop constraint if exists appointment_settlements_currency_check;
alter table public.appointment_settlements
  add constraint appointment_settlements_currency_check
  check (currency in ('cad', 'usd'));

-- 4b. What Stripe says about each connected account. Recorded by
-- record_stripe_account_jurisdiction (section 5); null until first observed.
alter table public.studio_payment_settings
  add column if not exists stripe_account_country text,
  add column if not exists stripe_account_default_currency text,
  add column if not exists stripe_account_observed_at timestamptz,
  add column if not exists stripe_account_country_conflict text,
  add column if not exists stripe_account_country_conflict_at timestamptz;

alter table public.studio_payment_settings
  drop constraint if exists studio_payment_settings_account_country_check;
alter table public.studio_payment_settings
  add constraint studio_payment_settings_account_country_check
  check (stripe_account_country is null or stripe_account_country ~ '^[A-Z]{2}$');

alter table public.studio_payment_settings
  drop constraint if exists studio_payment_settings_account_default_currency_check;
alter table public.studio_payment_settings
  add constraint studio_payment_settings_account_default_currency_check
  check (stripe_account_default_currency is null
         or stripe_account_default_currency ~ '^[a-z]{3}$');

-- An observation names an account; a placeholder row has none.
alter table public.studio_payment_settings
  drop constraint if exists studio_payment_settings_account_observation_check;
alter table public.studio_payment_settings
  add constraint studio_payment_settings_account_observation_check
  check (stripe_account_country is null or stripe_account_id is not null);

-- A conflict is a later, different report about an account whose country is
-- already recorded. It is kept, and it blocks charging, until an operator
-- resolves the account; no observation clears it.
alter table public.studio_payment_settings
  drop constraint if exists studio_payment_settings_account_country_conflict_check;
alter table public.studio_payment_settings
  add constraint studio_payment_settings_account_country_conflict_check
  check (
    case when stripe_account_country_conflict is null
         then stripe_account_country_conflict_at is null
         else stripe_account_country_conflict ~ '^[A-Z]{2}$'
              and stripe_account_country_conflict_at is not null
              and stripe_account_country is not null
              and stripe_account_country_conflict <> stripe_account_country
    end
  );

-- 4c. A charge attempt is prepared in its studio's currency, on an account in
-- its studio's country.
--
-- SECURITY DEFINER so the FOR SHARE below does not depend on the inserting
-- role's privileges on a table no application role can read.
create or replace function public.payment_charge_attempts_jurisdiction_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text;
  v_currency text;
  v_account_country text;
  v_account_conflict text;
begin
  select j.payment_country, j.payment_currency
    into v_country, v_currency
    from public.studio_payment_jurisdictions j
   where j.studio_id = new.studio_id
     for share;
  if not found then
    raise exception
      'payment_jurisdiction_missing: studio % has no payment jurisdiction', new.studio_id
      using errcode = 'check_violation';
  end if;

  -- STALE CONFIGURATION FAILS HERE. An application that read the studio's
  -- currency before an operator changed it cannot prepare the old currency.
  if new.currency is distinct from v_currency then
    raise exception
      'payment_currency_mismatch: an attempt in % cannot be prepared for a studio that charges in %',
      new.currency, v_currency
      using errcode = 'check_violation';
  end if;

  if new.stripe_account_id is not null then
    select s.stripe_account_country, s.stripe_account_country_conflict
      into v_account_country, v_account_conflict
      from public.studio_payment_settings s
     where s.studio_id = new.studio_id
       and s.stripe_account_id = new.stripe_account_id
       and s.stripe_livemode is not distinct from new.stripe_livemode;
  end if;

  -- STRIPE CONTRADICTED ITSELF. Neither report is trusted until an operator
  -- resolves the account, whichever of them matches the studio.
  if v_account_conflict is not null then
    raise exception
      'payment_account_country_conflict: Stripe has reported the studio''s account as both % and %',
      v_account_country, v_account_conflict
      using errcode = 'check_violation';
  end if;

  if v_account_country is not null and v_account_country <> v_country then
    raise exception
      'payment_account_country_mismatch: the studio''s Stripe account is in %, but the studio charges in %',
      v_account_country, v_country
      using errcode = 'check_violation';
  end if;

  -- AN UNOBSERVED ACCOUNT IS ACCEPTED ONLY WHERE EVERY PRE-#824 ACCOUNT WAS
  -- MADE: CANADA. A US studio's account is observed when it is created, so a
  -- US attempt on an account Hone has never seen state its country is refused.
  if v_account_country is null and v_country <> 'CA' then
    raise exception
      'payment_account_country_unverified: the studio''s Stripe account country has not been confirmed as %',
      v_country
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists payment_charge_attempts_jurisdiction_guard
  on public.payment_charge_attempts;
create trigger payment_charge_attempts_jurisdiction_guard
  before insert on public.payment_charge_attempts
  for each row execute function public.payment_charge_attempts_jurisdiction_guard();

-- 4d. The prepared money never changes afterwards. No writer updates either
-- column today (the claim, outcome, refund and receipt writers all touch
-- status columns only); this makes that a rule rather than a habit.
create or replace function public.payment_charge_attempts_money_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency then
    raise exception
      'payment_charge_attempts: amount_cents and currency are fixed when the attempt is prepared and never change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_charge_attempts_money_immutable
  on public.payment_charge_attempts;
create trigger payment_charge_attempts_money_immutable
  before update of amount_cents, currency on public.payment_charge_attempts
  for each row execute function public.payment_charge_attempts_money_immutable();

-- 4e. A settlement is recorded in its studio's currency. Server-owned, like
-- recorded_at (0187): no 0187 command passes a currency, so before this the
-- column default decided it, and the default was Canada. The append-only
-- guard (0187) already freezes it after insert.
create or replace function public.appointment_settlements_currency_from_jurisdiction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_currency text;
begin
  select j.payment_currency
    into v_currency
    from public.studio_payment_jurisdictions j
   where j.studio_id = new.studio_id
     for share;
  if not found then
    raise exception
      'payment_jurisdiction_missing: studio % has no payment jurisdiction', new.studio_id
      using errcode = 'check_violation';
  end if;
  new.currency := v_currency;
  return new;
end;
$$;

drop trigger if exists appointment_settlements_currency_from_jurisdiction
  on public.appointment_settlements;
create trigger appointment_settlements_currency_from_jurisdiction
  before insert on public.appointment_settlements
  for each row execute function public.appointment_settlements_currency_from_jurisdiction();

-- 4f. A Stripe account is created in the country its provisioning claim was
-- stamped with (Codex P1 4244982189).
--
-- The application used to read the studio's country BEFORE
-- create_or_claim_stripe_account_provisioning, so an operator change from CA
-- to US committed between that read and the claim let the account be created
-- for the stale country. The claim's row is now stamped under FOR SHARE on the
-- jurisdiction row, which the change command (section 3) holds FOR UPDATE:
--   * a change that commits first is waited for, and the stamp is the NEW
--     country;
--   * a claim that commits first makes the change command see the attempt and
--     return refused_payment_account.
-- The application creates the account in the stamped country only. A row is
-- stamped when it is inserted and whenever a new claim token is issued (the
-- claim RPC's retry of a failed or abandoned attempt), so a pre-0214 attempt
-- is stamped the first time it is claimed again; its stamp can never go stale,
-- because an existing attempt refuses every later change.
alter table public.stripe_account_provisioning_attempts
  add column if not exists payment_country text;
alter table public.stripe_account_provisioning_attempts
  drop constraint if exists stripe_account_provisioning_attempts_payment_country_check;
alter table public.stripe_account_provisioning_attempts
  add constraint stripe_account_provisioning_attempts_payment_country_check
  check (payment_country is null or payment_country in ('CA', 'US'));

create or replace function public.stripe_account_provisioning_payment_country()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text;
begin
  if tg_op = 'UPDATE'
     and new.processing_claim_token is not distinct from old.processing_claim_token then
    new.payment_country := old.payment_country;
    return new;
  end if;
  select j.payment_country
    into v_country
    from public.studio_payment_jurisdictions j
   where j.studio_id = new.studio_id
     for share;
  if not found then
    raise exception
      'payment_jurisdiction_missing: studio % has no payment jurisdiction', new.studio_id
      using errcode = 'check_violation';
  end if;
  new.payment_country := v_country;
  return new;
end;
$$;

drop trigger if exists stripe_account_provisioning_payment_country
  on public.stripe_account_provisioning_attempts;
create trigger stripe_account_provisioning_payment_country
  before insert or update on public.stripe_account_provisioning_attempts
  for each row execute function public.stripe_account_provisioning_payment_country();

-- ---------------------------------------------------------------------------
-- 5. Recording what Stripe says about an account
-- ---------------------------------------------------------------------------
--
-- Called by the application after it creates an account, refreshes one, or
-- receives account.updated. A connected account's country never changes, so
-- the first observation is kept. A later, different country does not
-- overwrite it: the contradicting country is PERSISTED as a conflict, which
-- blocks every charge on the account (section 4c and the application) until an
-- operator resolves it. A later report that agrees again does not clear it.
-- The default currency can change and is refreshed.
--
-- Results (out_result): recorded | refreshed | country_conflict | not_bound |
-- invalid_input. out_matches is true only when the recorded account country
-- equals the studio's payment country AND no conflict is recorded; the
-- application fails closed when it is false.
create or replace function public.record_stripe_account_jurisdiction(
  p_studio_id uuid,
  p_stripe_account_id text,
  p_stripe_livemode boolean,
  p_country text,
  p_default_currency text
)
returns table (
  out_result text,
  out_account_country text,
  out_payment_country text,
  out_matches boolean
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_currency text := nullif(lower(btrim(coalesce(p_default_currency, ''))), '');
  v_settings public.studio_payment_settings%rowtype;
  v_payment_country text;
begin
  if p_studio_id is null
     or coalesce(btrim(p_stripe_account_id), '') = ''
     or p_stripe_livemode is null
     or v_country !~ '^[A-Z]{2}$'
     or (v_currency is not null and v_currency !~ '^[a-z]{3}$') then
    return query select 'invalid_input'::text, null::text, null::text, null::boolean;
    return;
  end if;

  select j.payment_country into v_payment_country
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id;

  select * into v_settings
    from public.studio_payment_settings s
   where s.studio_id = p_studio_id
     and s.stripe_livemode = p_stripe_livemode
     and s.stripe_account_id = p_stripe_account_id
   for update;
  if not found then
    return query select 'not_bound'::text, null::text, v_payment_country, null::boolean;
    return;
  end if;

  if v_settings.stripe_account_country is not null
     and v_settings.stripe_account_country <> v_country then
    update public.studio_payment_settings s
       set stripe_account_country_conflict = v_country,
           stripe_account_country_conflict_at = now(),
           stripe_account_observed_at = now()
     where s.id = v_settings.id;
    return query select 'country_conflict'::text, v_settings.stripe_account_country,
                        v_payment_country, false;
    return;
  end if;

  update public.studio_payment_settings s
     set stripe_account_country = v_country,
         stripe_account_default_currency = v_currency,
         stripe_account_observed_at = now()
   where s.id = v_settings.id;

  -- A recorded conflict outlives any later agreeing report.
  return query select
    case when v_settings.stripe_account_country_conflict is not null
         then 'country_conflict'
         when v_settings.stripe_account_country is null
         then 'recorded' else 'refreshed' end,
    v_country,
    v_payment_country,
    v_settings.stripe_account_country_conflict is null
      and v_country = v_payment_country;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Initialization from verified evidence over existing history (R-2(c1))
-- ---------------------------------------------------------------------------
--
-- set_studio_payment_jurisdiction refuses to initialize a studio that already
-- has an account or money, so every payment-active studio is unreachable by
-- it and refuses every settlement and charge (payment_jurisdiction_missing).
-- This command records the operator's verified pair ONLY when what the
-- database already holds agrees with it. It rewrites no row and infers no
-- currency or country. It only INITIALIZES.
--
-- THE MONEY-TABLE UNIVERSE (F5). Every public table with a currency, a
-- stripe_account_id or a *_cents column, as of 0246, and how it is treated:
--   currency checked     payment_charge_attempts, appointment_settlements,
--                        manual_fee_charge_attempts, stripe_charge_attempts,
--                        stripe_refunds, stripe_refund_attempts,
--                        stripe_disputes, stripe_payment_audit
--   refused on presence  appointment_payments, pending_booking_payment_sessions
--                        (amounts with no currency column: unverifiable)
--   account checked      every table above that names an account, plus
--                        stripe_account_provisioning_attempts,
--                        client_payment_methods, client_stripe_customers,
--                        payment_recovery_tokens,
--                        stripe_customer_provisioning_attempts and the
--                        bindings in studio_payment_settings
--   prices (acknowledge) services, client_pricing, sessions, studios
--   exempt               stripe_events: an inbox of provider REPORTS, neither
--                        money nor a binding; an event never names a currency
--                        the studio holds
-- Any other public table with such a column makes the command refuse
-- (refused_unlisted_money_table) until this list and its checks are extended.
--
-- MODE (F-1, Insurance A8 K4). A deployment observes only its own Stripe mode,
-- so a TEST-mode account of a live deployment may never be observed.
--   * live or unknown mode: the account must be bound and OBSERVED as this
--     country with no conflict. Nothing waives it.
--   * test mode: a bound account never observed, or a provisioning attempt
--     that never bound an account, is accepted only when the operator lists
--     exactly those ids (p_acknowledged_test_account_ids,
--     p_acknowledged_test_attempt_ids). The audit records the lists.
--   * an observed mismatch or a recorded conflict refuses in either mode.
--
-- Results (out_result):
--   initialized                       recorded and audited (history_verified)
--   unchanged                         the studio already has exactly this pair
--   refused_already_initialized       it has a different pair; nothing written
--   verification_required             no evidence reference
--   refused_unlisted_money_table      a money-shaped table outside the pinned
--                                     universe exists (F5)
--   refused_unverifiable_history      a money row with no currency of its own
--   refused_currency_history          a money row in another currency, or none
--   refused_account_mismatch          an account observed in another country,
--                                     or with a recorded country conflict
--   refused_account_unverified        evidence no acknowledgement can cure: a
--                                     live/unknown-mode account not observed,
--                                     or a row naming an account that is not
--                                     bound in its mode
--   refused_test_account_unobserved   only acknowledgeable test-mode evidence
--                                     stands in the way and none was given
--   refused_test_acknowledgement_stale  an acknowledgement was given but is
--                                     not exactly the set that needs it
--   refused_priced_configuration      prices exist and were not acknowledged
--   not_found / invalid_input         as for set_studio_payment_jurisdiction
--
-- LOCK ORDER (F4). studio NO KEY UPDATE, jurisdiction FOR UPDATE, settings
-- FOR SHARE, studio FOR UPDATE, settings FOR SHARE again. After the studio
-- FOR UPDATE no FK child of the studio (money row, binding, settings row) can
-- be inserted, because its KEY SHARE conflicts; the second share lock covers a
-- settings row committed between the first share lock and that upgrade. The
-- observer (record_stripe_account_jurisdiction) never locks the studio, so it
-- cannot deadlock with this; it waits for our commit.

-- True when (account, mode) is a bound account of the studio in that mode,
-- with no conflict, and either OBSERVED as p_country or (p_accept_unobserved_test
-- and test mode) never observed. A null account id never matches.
create or replace function public.studio_account_acceptable_for_jurisdiction(
  p_studio_id uuid,
  p_stripe_account_id text,
  p_stripe_livemode boolean,
  p_country text,
  p_accept_unobserved_test boolean
)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from public.studio_payment_settings s
     where s.studio_id = p_studio_id
       and s.stripe_account_id = p_stripe_account_id
       and s.stripe_livemode is not distinct from p_stripe_livemode
       and s.stripe_account_country_conflict is null
       and (s.stripe_account_country = p_country
            or (p_accept_unobserved_test
                and s.stripe_livemode = false
                and s.stripe_account_country is null))
  );
$$;

-- Every (account, mode) the studio's rows name, one row per naming row.
-- is_attempt marks provisioning attempts, the only rows whose account may be
-- null (an attempt that never bound one). Other tables contribute only rows
-- that name an account; a charge row with no account involves none.
create or replace function public.studio_named_stripe_accounts(p_studio_id uuid)
returns table (stripe_account_id text, stripe_livemode boolean, is_attempt boolean, attempt_id uuid)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select a.stripe_account_id, a.stripe_livemode, true, a.id
    from public.stripe_account_provisioning_attempts a where a.studio_id = p_studio_id
  union all
  select x.stripe_account_id, x.stripe_livemode, false, null::uuid from (
    select m.stripe_account_id, m.stripe_livemode from public.client_payment_methods m where m.studio_id = p_studio_id
    union all select c.stripe_account_id, c.stripe_livemode from public.client_stripe_customers c where c.studio_id = p_studio_id
    union all select p.stripe_account_id, p.stripe_livemode from public.payment_charge_attempts p where p.studio_id = p_studio_id
    union all select f.stripe_account_id, f.stripe_livemode from public.manual_fee_charge_attempts f where f.studio_id = p_studio_id
    union all select sc.stripe_account_id, sc.stripe_livemode from public.stripe_charge_attempts sc where sc.studio_id = p_studio_id
    union all select r.stripe_account_id, r.stripe_livemode from public.stripe_refunds r where r.studio_id = p_studio_id
    union all select ra.stripe_account_id, ra.stripe_livemode from public.stripe_refund_attempts ra where ra.studio_id = p_studio_id
    union all select d.stripe_account_id, d.stripe_livemode from public.stripe_disputes d where d.studio_id = p_studio_id
    union all select au.stripe_account_id, au.stripe_livemode from public.stripe_payment_audit au where au.studio_id = p_studio_id
    union all select t.stripe_account_id, t.stripe_livemode from public.payment_recovery_tokens t where t.studio_id = p_studio_id
    union all select cp.stripe_account_id, cp.stripe_livemode from public.stripe_customer_provisioning_attempts cp where cp.studio_id = p_studio_id
  ) x
  where x.stripe_account_id is not null;
$$;

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
    'payment_charge_attempts', 'payment_recovery_tokens',
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

-- ---------------------------------------------------------------------------
-- Privileges (F1). Supabase's default privileges grant EXECUTE on a new
-- function to anon, authenticated AND service_role, so each is revoked BY
-- NAME (the 0129 / 0164 failure class). The helpers get no grant: they run
-- only inside the security definer command, as its owner.
-- ---------------------------------------------------------------------------
revoke execute on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) from public;
revoke execute on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) from anon;
revoke execute on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) from authenticated;
revoke execute on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) from service_role;

revoke execute on function public.studio_named_stripe_accounts(uuid) from public;
revoke execute on function public.studio_named_stripe_accounts(uuid) from anon;
revoke execute on function public.studio_named_stripe_accounts(uuid) from authenticated;
revoke execute on function public.studio_named_stripe_accounts(uuid) from service_role;

revoke execute on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) from public;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) from anon;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) from authenticated;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) from service_role;
grant execute on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants a new table and every new
-- function to anon, authenticated AND service_role at create time. Each is
-- revoked BY NAME before anything is granted — the 0129 (`anon`) and 0164
-- (`service_role`) failure class.

revoke all on public.studio_payment_jurisdictions
  from public, anon, authenticated, service_role;
revoke all on public.studio_payment_jurisdiction_changes
  from public, anon, authenticated, service_role;
-- The application reads both server-side. Writes go only through the
-- security definer functions above.
grant select on public.studio_payment_jurisdictions to service_role;
grant select on public.studio_payment_jurisdiction_changes to service_role;

revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) from public;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) from anon;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) from authenticated;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) from service_role;
grant execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) to service_role;

revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from public;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from anon;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from authenticated;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from service_role;
grant execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) to service_role;

revoke all privileges on function public.studio_price_write_jurisdiction_lock()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_charge_attempts_jurisdiction_guard()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_charge_attempts_money_immutable()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.appointment_settlements_currency_from_jurisdiction()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.stripe_account_provisioning_payment_country()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.studio_payment_jurisdictions is
  'PAY-CCY-02 (#824): one row per studio naming the country its payment account belongs to and the currency it charges in. Only CA/cad and US/usd. No backfill or creation default. A missing row is UNKNOWN. Initialized or changed only with verified country AND charge currency plus an evidence reference through set_studio_payment_jurisdiction (service_role only, audited). Read server-side; no browser grant and no RLS policy.';
comment on table public.studio_payment_jurisdiction_changes is
  'Append-only audit of set_studio_payment_jurisdiction: who initialized or changed a studio''s payment country and currency, evidence reference, previous pair (NULL for initialization), new pair, reason, and whether configured prices were explicitly acknowledged. Written only by that command.';
comment on column public.studio_payment_settings.stripe_account_country is
  'The connected account''s country as Stripe reported it, recorded by record_stripe_account_jurisdiction. Write-once: a later different country is a conflict, never an overwrite. Null until first observed.';
comment on column public.studio_payment_settings.stripe_account_country_conflict is
  'A later country Stripe reported for this account that contradicts stripe_account_country. While set, no charge attempt can be prepared on the account (payment_account_country_conflict) and the application treats the account as mismatched. Cleared only by operator resolution.';
comment on column public.studio_payment_settings.stripe_account_country_conflict_at is
  'When the contradicting country in stripe_account_country_conflict was last reported.';
comment on column public.studio_payment_settings.stripe_account_default_currency is
  'The connected account''s default currency as Stripe last reported it. Informational; charges use the studio''s payment currency.';
comment on column public.stripe_account_provisioning_attempts.payment_country is
  'The studio''s payment country at the moment this attempt was claimed, stamped under a share lock on its jurisdiction row so it serializes with set_studio_payment_jurisdiction. Stripe accounts.create uses this country and no earlier read. Null only on a pre-0214 attempt never claimed since.';
comment on column public.studio_payment_settings.stripe_account_observed_at is
  'When Stripe last reported this account''s country and default currency to Hone.';
comment on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text) is
  'The protected verified initialization/change of a studio''s payment country and charge currency (CA/cad or US/usd); requires actor, reason and verification reference. Refuses once the studio has a Stripe account, provisioning attempt, saved card or Stripe customer in any mode (refused_payment_account), or any recorded money (refused_monetary_history); refuses over configured or recorded prices unless p_acknowledge_configured_prices is true (refused_priced_configuration). Locks the studio then jurisdiction row before checking, serializing initializers; no first payment can interleave. Audited. service_role only.';
comment on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) is
  'Record the country and default currency Stripe reports for a studio''s bound connected account (studio, mode, account). The country is write-once; a different later country is persisted as stripe_account_country_conflict, returns country_conflict, and blocks charging until an operator resolves it. Returns whether the recorded country equals the studio''s payment country. service_role only.';
comment on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) is
  'R-2(c1): first verified initialization of a studio that already has a Stripe account or recorded money. Records the operator''s pair (CA/cad or US/usd; actor, reason and verification reference required) only when every money row in the pinned universe states that currency, no money row lacks one, every live- or unknown-mode account is bound and observed in that country, no observed account disagrees or conflicts, and any test-mode account never observed (or unbound test-mode provisioning attempt) is listed exactly in the acknowledgement arrays. Refuses on any money-shaped table outside the pinned universe. Never changes an existing pair, never rewrites a row, never infers a currency or country. Prices need p_acknowledge_configured_prices. Audited with history_verified and the acknowledged ids. service_role only.';
comment on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) is
  'Internal to initialize_studio_payment_jurisdiction_from_history: is (account, mode) a bound, conflict-free account of the studio observed as the country, or (test mode, when allowed) never observed. No role holds EXECUTE.';
comment on function public.studio_named_stripe_accounts(uuid) is
  'Internal to initialize_studio_payment_jurisdiction_from_history: every (account, mode) the studio''s money, card, customer, token and provisioning rows name. No role holds EXECUTE.';

commit;
