-- 0257_studio_payment_jurisdiction_failed_attempt_ack.sql
--
-- Reconciles a studio whose payment history contains a FAILED live-mode
-- Stripe account provisioning attempt that never bound an account, so that the
-- first verified jurisdiction can be recorded over it without editing 0214.
--
-- Why 0214 cannot: in initialize_studio_payment_jurisdiction_from_history the
-- F6 check refuses any live or unknown-mode row that names no account, because
-- a null account is never "bound and observed". Only TEST-mode attempts can be
-- acknowledged (p_acknowledged_test_attempt_ids). No command annotates or
-- supersedes a terminal attempt.
--
-- This migration is additive:
--   1. two audit columns on studio_payment_jurisdiction_changes;
--   2. a v2 command whose body is 0214's body with ONE behavioural difference,
--      in F6 and the check right after it (marked "0257" below).
-- 0214's command, its helpers and every grant on them are untouched. The v2
-- command calls the two 0214 helpers as its owner; no role holds EXECUTE on
-- them, and none is granted here.
--
-- The operator establishes, outside this database and before calling v2, a
-- census of the live connected accounts by studio metadata. The fixed evidence
-- value names that basis; no free text is stored. What the census shows:
-- "No additional matching Stripe account is currently visible; the historical
-- outcome of the 5 July request remains uncertain."
--
-- Results added to 0214's set:
--   refused_failed_attempt_unacknowledged        qualifying attempts exist and
--                                                 none was acknowledged
--   refused_failed_attempt_acknowledgement_stale  the acknowledged ids are not
--                                                 exactly the qualifying set
-- A qualifying attempt: live or unknown mode, no account, status 'failed',
-- terminal_at set, no processing claim token. Anything else still refuses as
-- refused_account_unverified, acknowledged or not.
-- invalid_input: ids without the evidence value, or the evidence value
-- without ids.

begin;
set local lock_timeout = '5s';

alter table public.studio_payment_jurisdiction_changes
  add column if not exists failed_attempts_acknowledged uuid[] not null default '{}',
  add column if not exists failed_attempts_evidence text;

alter table public.studio_payment_jurisdiction_changes
  drop constraint if exists studio_payment_jurisdiction_changes_failed_evidence_check;
alter table public.studio_payment_jurisdiction_changes
  add constraint studio_payment_jurisdiction_changes_failed_evidence_check check (
    (cardinality(failed_attempts_acknowledged) = 0 and failed_attempts_evidence is null)
    or (cardinality(failed_attempts_acknowledged) > 0
        and failed_attempts_evidence = 'stripe_live_account_census_by_studio_metadata')
  );

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
  -- 0257 (the ONLY difference from 0214): a live or unknown-mode attempt that
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

revoke execute on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) from public;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) from anon;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) from authenticated;
revoke execute on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) from service_role;
grant execute on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) to service_role;

comment on column public.studio_payment_jurisdiction_changes.failed_attempts_acknowledged is
  'Ids of failed live or unknown-mode provisioning attempts that named no account, acknowledged by the operator when the first pair was recorded over them. Empty unless acknowledged.';
comment on column public.studio_payment_jurisdiction_changes.failed_attempts_evidence is
  'The basis of that acknowledgement: only stripe_live_account_census_by_studio_metadata. NULL exactly when no attempt was acknowledged.';
comment on function public.initialize_studio_payment_jurisdiction_from_history_v2(uuid, text, text, text, text, text, boolean, text[], uuid[], uuid[], text) is
  '0214''s initialize_studio_payment_jurisdiction_from_history with one difference: a failed, terminal, claim-free live or unknown-mode provisioning attempt that named no account is accepted when the operator acknowledges exactly those ids with the fixed census evidence value. Every other refusal is unchanged. Audited with both new fields. service_role only.';

commit;
