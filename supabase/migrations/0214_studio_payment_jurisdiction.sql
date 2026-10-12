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
--   2. Every existing studio is BACKFILLED to CA/cad, and every studio created
--      from now on starts CA/cad (the pre-#824 deployment default, so Canadian
--      onboarding is unchanged). A US studio is made one by an operator, with
--      the command below, before it has a payment account or any money history.
--   3. public.set_studio_payment_jurisdiction — the ONLY writer of a change,
--      service_role only, audited in public.studio_payment_jurisdiction_changes.
--      It REFUSES once the studio has a Stripe account (any mode, any status)
--      or any money history, and refuses over configured prices unless the
--      operator explicitly acknowledges them. Old prices and old transactions
--      are never silently reinterpreted as another currency.
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

  -- How the current values were set:
  --   legacy_backfill  every studio that existed when 0214 was applied
  --   studio_created   the CA/cad default given to every studio created since
  --   operator         set by set_studio_payment_jurisdiction (audited)
  source text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_payment_jurisdictions_pair_check check (
    (payment_country = 'CA' and payment_currency = 'cad')
    or (payment_country = 'US' and payment_currency = 'usd')
  ),
  constraint studio_payment_jurisdictions_source_check check (
    source in ('legacy_backfill', 'studio_created', 'operator')
  )
);

-- The audit trail of every change the command makes. Append-only by privilege:
-- no role holds INSERT, UPDATE or DELETE, and the command is its only writer.
create table if not exists public.studio_payment_jurisdiction_changes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  from_country text not null,
  from_currency text not null,
  to_country text not null,
  to_currency text not null,
  -- Who did it, as the operator names themself. Free text because the operator
  -- path is SQL as well as a future console; never a client identity.
  actor text not null,
  reason text not null,
  -- True when the studio already had configured or recorded prices and the
  -- operator explicitly accepted that those numbers now mean the new currency.
  prices_acknowledged boolean not null default false,
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
-- 2. Backfill, and the default for every studio created from now on
-- ---------------------------------------------------------------------------

-- Every studio that exists today has only ever been able to hold CAD money and
-- a CA account (the deployment default), so CA/cad is the truth about it, not
-- an assumption.
insert into public.studio_payment_jurisdictions
  (studio_id, payment_country, payment_currency, source)
select s.id, 'CA', 'cad', 'legacy_backfill'
  from public.studios s
on conflict (studio_id) do nothing;

-- A new studio starts exactly where every studio before #824 started. Studios
-- are created by an operator (the New Studio wizard, or the runbook's SQL),
-- and a US studio is switched by the command below before its owner can
-- connect Stripe.
create or replace function public.studios_payment_jurisdiction_default()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.studio_payment_jurisdictions
    (studio_id, payment_country, payment_currency, source)
  values (new.id, 'CA', 'cad', 'studio_created')
  on conflict (studio_id) do nothing;
  return new;
end;
$$;

drop trigger if exists studios_payment_jurisdiction_default on public.studios;
create trigger studios_payment_jurisdiction_default
  after insert on public.studios
  for each row execute function public.studios_payment_jurisdiction_default();

-- ---------------------------------------------------------------------------
-- 3. The protected change command
-- ---------------------------------------------------------------------------
--
-- Results (out_result):
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
  p_acknowledge_configured_prices boolean default false
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

  -- FOR UPDATE FIRST, history second. A charge attempt or settlement takes FOR
  -- SHARE on this row before it is written (section 4), so once this lock is
  -- held no first payment can slip in between the checks below and the write.
  select * into v_row
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

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

  update public.studio_payment_jurisdictions j
     set payment_country = v_country,
         payment_currency = v_currency,
         source = 'operator'
   where j.studio_id = p_studio_id;

  insert into public.studio_payment_jurisdiction_changes
    (studio_id, from_country, from_currency, to_country, to_currency,
     actor, reason, prices_acknowledged)
  values
    (p_studio_id, v_row.payment_country, v_row.payment_currency, v_country, v_currency,
     v_actor, v_reason, v_ack);

  return query select 'changed'::text, v_country, v_currency;
end;
$$;

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

revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) from public;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) from anon;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) from authenticated;
revoke execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) from service_role;
grant execute on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) to service_role;

revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from public;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from anon;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from authenticated;
revoke execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) from service_role;
grant execute on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) to service_role;

revoke all privileges on function public.studios_payment_jurisdiction_default()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_charge_attempts_jurisdiction_guard()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.payment_charge_attempts_money_immutable()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.appointment_settlements_currency_from_jurisdiction()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.studio_payment_jurisdictions is
  'PAY-CCY-02 (#824): one row per studio naming the country its payment account belongs to and the currency it charges in. Only CA/cad and US/usd. Backfilled CA/cad for every studio that existed at 0214, defaulted CA/cad for every studio created since, and changed only by set_studio_payment_jurisdiction (service_role only, audited). Read server-side; no browser grant and no RLS policy.';
comment on table public.studio_payment_jurisdiction_changes is
  'Append-only audit of set_studio_payment_jurisdiction: who changed a studio''s payment country and currency, from what, to what, why, and whether configured prices were explicitly acknowledged. Written only by that command.';
comment on column public.studio_payment_settings.stripe_account_country is
  'The connected account''s country as Stripe reported it, recorded by record_stripe_account_jurisdiction. Write-once: a later different country is a conflict, never an overwrite. Null until first observed.';
comment on column public.studio_payment_settings.stripe_account_country_conflict is
  'A later country Stripe reported for this account that contradicts stripe_account_country. While set, no charge attempt can be prepared on the account (payment_account_country_conflict) and the application treats the account as mismatched. Cleared only by operator resolution.';
comment on column public.studio_payment_settings.stripe_account_country_conflict_at is
  'When the contradicting country in stripe_account_country_conflict was last reported.';
comment on column public.studio_payment_settings.stripe_account_default_currency is
  'The connected account''s default currency as Stripe last reported it. Informational; charges use the studio''s payment currency.';
comment on column public.studio_payment_settings.stripe_account_observed_at is
  'When Stripe last reported this account''s country and default currency to Hone.';
comment on function public.set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean) is
  'The protected change of a studio''s payment country and currency (CA/cad or US/usd). Refuses once the studio has a Stripe account, provisioning attempt, saved card or Stripe customer in any mode (refused_payment_account), or any recorded money (refused_monetary_history); refuses over configured or recorded prices unless p_acknowledge_configured_prices is true (refused_priced_configuration). Locks the jurisdiction row before checking, so no first payment can interleave. Audited. service_role only.';
comment on function public.record_stripe_account_jurisdiction(uuid, text, boolean, text, text) is
  'Record the country and default currency Stripe reports for a studio''s bound connected account (studio, mode, account). The country is write-once; a different later country is persisted as stripe_account_country_conflict, returns country_conflict, and blocks charging until an operator resolves it. Returns whether the recorded country equals the studio''s payment country. service_role only.';

commit;
