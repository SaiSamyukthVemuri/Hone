-- 0257: initialize a studio's payment jurisdiction from verified history
--       (the R-2(c1) follow-up to 0214).
--
-- WHY THIS EXISTS. 0214 creates set_studio_payment_jurisdiction, which refuses
-- to initialize a studio that already has a Stripe account or any recorded
-- money. Every payment-active studio is therefore unreachable by it and refuses
-- every settlement and charge (payment_jurisdiction_missing) until it holds a
-- jurisdiction row. The amended 0214 (a8bdcefe...) carried a second, governed
-- writer for exactly that case. When the UNAMENDED 0214 (8ff9350e...) ships,
-- that writer is absent, so this migration adds it, after the fact, as a
-- reviewed migration of its own.
--
-- REUSED, NOT REDESIGNED. Everything below the ALTER TABLE is the T-0214-1 text
-- of the amended 0214 (section 3b). Its 19 statements (the two internal
-- helpers and the command, 12 revokes by name, the one service_role grant, 3
-- comments) are byte-identical to that file's. The block below the ALTER TABLE
-- is pinned by checksum in
-- tests/migrations/0257-payment-jurisdiction-history-init.test.ts, so an edit
-- here is a visible, reviewed change.
--
-- WHAT IT DOES NOT DO. It never invents a currency or a country, never
-- rewrites a money row, never changes an existing pair. A money row with a NULL
-- currency makes the command REFUSE (refused_currency_history); history is
-- left exactly as it is. It adds no table, trigger, policy or data, and it
-- initializes no studio: running it is a separate, operator-authorised,
-- service_role call per studio.
--
-- IDEMPOTENT OVER THE AMENDED 0214. The three columns use ADD COLUMN IF NOT
-- EXISTS and the functions use CREATE OR REPLACE with identical text, so
-- applying this over a database that already ran the amended 0214 changes
-- nothing (the column order differs: the amended 0214 places them before
-- created_at, this appends them).
--
-- ORDER. Depends only on 0214 (the changes table, the jurisdictions table and
-- the 0214 stripe_account_country columns). Nothing in 0215-0256 is read.
begin;

set local lock_timeout = '5s';

-- The three audit columns the command writes. The default makes the addition
-- metadata-only; existing audit rows read false / empty.
alter table public.studio_payment_jurisdiction_changes
  add column if not exists history_verified boolean not null default false,
  add column if not exists unobserved_test_accounts_acknowledged text[] not null default '{}',
  add column if not exists unbound_test_attempts_acknowledged uuid[] not null default '{}';

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

comment on function public.initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[]) is
  'R-2(c1): first verified initialization of a studio that already has a Stripe account or recorded money. Records the operator''s pair (CA/cad or US/usd; actor, reason and verification reference required) only when every money row in the pinned universe states that currency, no money row lacks one, every live- or unknown-mode account is bound and observed in that country, no observed account disagrees or conflicts, and any test-mode account never observed (or unbound test-mode provisioning attempt) is listed exactly in the acknowledgement arrays. Refuses on any money-shaped table outside the pinned universe. Never changes an existing pair, never rewrites a row, never infers a currency or country. Prices need p_acknowledge_configured_prices. Audited with history_verified and the acknowledged ids. service_role only.';
comment on function public.studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean) is
  'Internal to initialize_studio_payment_jurisdiction_from_history: is (account, mode) a bound, conflict-free account of the studio observed as the country, or (test mode, when allowed) never observed. No role holds EXECUTE.';
comment on function public.studio_named_stripe_accounts(uuid) is
  'Internal to initialize_studio_payment_jurisdiction_from_history: every (account, mode) the studio''s money, card, customer, token and provisioning rows name. No role holds EXECUTE.';

commit;
