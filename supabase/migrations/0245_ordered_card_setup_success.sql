-- PAY-006: signed success chronology, not intent issuance or DB arrival.
-- SOURCE ONLY. No backfill/adoption: legacy unknown history blocks replacement.
-- Migration-first closes the old service command; old apps must drain first.
begin;
set local lock_timeout = '5s';

alter table public.client_payment_methods
  add column stripe_setup_success_event_id text,
  add column stripe_setup_success_event_created bigint,
  add constraint client_payment_methods_setup_success_evidence_pair check (
    (stripe_setup_success_event_id is null and stripe_setup_success_event_created is null)
    or (stripe_setup_success_event_id is not null
      and pg_catalog.btrim(stripe_setup_success_event_id) <> ''
      and stripe_setup_success_event_created is not null
      and stripe_setup_success_event_created >= 0)
  );

-- A provider event cannot be bound twice, including concurrent different clients.
create unique index client_payment_methods_setup_success_event_uniq
  on public.client_payment_methods(stripe_account_id, stripe_livemode, stripe_setup_success_event_id)
  where stripe_setup_success_event_id is not null;

create function public.save_client_card_on_file_ordered(
  p_studio_id uuid, p_client_id uuid, p_stripe_account_id text,
  p_stripe_livemode boolean, p_stripe_customer_id text,
  p_stripe_payment_method_id text, p_stripe_setup_intent_id text,
  p_brand text, p_last4 text, p_exp_month integer, p_exp_year integer,
  p_card_authorization_signature_id uuid,
  p_success_event_id text, p_success_event_created bigint
)
returns table(outcome text, card_id uuid, previous_card_id uuid)
language plpgsql security definer set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_existing public.client_payment_methods%rowtype;
  v_max bigint;
  v_saved record;
begin
  if p_studio_id is null or p_client_id is null or p_stripe_account_id is null
    or p_stripe_livemode is null or p_stripe_customer_id is null
    or p_stripe_payment_method_id is null or p_stripe_setup_intent_id is null
    or p_brand is null or p_last4 is null or p_exp_month is null or p_exp_year is null
    or p_success_event_id is null or pg_catalog.btrim(p_success_event_id) = ''
    or p_success_event_created is null or p_success_event_created < 0 then
    raise exception 'invalid_setup_success_tuple' using errcode = '22023';
  end if;

  -- EXACT 0180 coarse mutex, shared across DIFFERENT payment methods/accounts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_studio_id::text || '|' || p_client_id::text || '|'
      || case when p_stripe_livemode then 't' else 'f' end, 0));

  -- Validate authority before duplicate/chronology outcomes, unlike old 0180.
  if not exists (select 1 from public.client_stripe_customers c
    where c.studio_id = p_studio_id and c.client_id = p_client_id
      and c.stripe_account_id = p_stripe_account_id
      and c.stripe_livemode = p_stripe_livemode
      and c.stripe_customer_id = p_stripe_customer_id) then
    raise exception 'customer_lineage_mismatch' using errcode = '22023';
  end if;
  if p_card_authorization_signature_id is not null and not exists (
    select 1 from public.client_consent_signatures s
    where s.id = p_card_authorization_signature_id
      and s.studio_id = p_studio_id and s.client_id = p_client_id) then
    raise exception 'signature_lineage_mismatch' using errcode = '22023';
  end if;

  -- Also serialize ordinary card removal against admission's active check.
  perform c.id from public.client_payment_methods c
    where c.studio_id = p_studio_id and c.client_id = p_client_id
      and c.stripe_livemode = p_stripe_livemode for update;

  select c.* into v_existing from public.client_payment_methods c
    where c.studio_id = p_studio_id and c.client_id = p_client_id
      and c.stripe_account_id = p_stripe_account_id
      and c.stripe_livemode = p_stripe_livemode
      and c.stripe_setup_intent_id = p_stripe_setup_intent_id;
  if v_existing.id is not null and (
    v_existing.stripe_customer_id is distinct from p_stripe_customer_id
    or v_existing.stripe_payment_method_id is distinct from p_stripe_payment_method_id
    or v_existing.card_authorization_signature_id is distinct from p_card_authorization_signature_id
    or (v_existing.stripe_setup_success_event_created is not null
      and v_existing.stripe_setup_success_event_created <> p_success_event_created)
  ) then
    raise exception 'setup_success_evidence_conflict' using errcode = '22023';
  end if;
  if exists (select 1 from public.client_payment_methods c
    where c.stripe_account_id = p_stripe_account_id
      and c.stripe_livemode = p_stripe_livemode
      and c.stripe_setup_success_event_id = p_success_event_id
      and (c.studio_id is distinct from p_studio_id
        or c.client_id is distinct from p_client_id
        or c.stripe_setup_intent_id is distinct from p_stripe_setup_intent_id
        or c.stripe_setup_success_event_created is distinct from p_success_event_created)) then
    raise exception 'setup_success_event_conflict' using errcode = '22023';
  end if;

  -- Removed history retains its watermark. Unknown history is never adopted
  -- from arrival times, intent issuance, lexical IDs, or this retry's timestamp.
  if exists (select 1 from public.client_payment_methods c
    where c.studio_id = p_studio_id and c.client_id = p_client_id
      and c.stripe_livemode = p_stripe_livemode
      and c.stripe_setup_success_event_created is null) then
    return query select 'unknown_event_order'::text, null::uuid, null::uuid;
    return;
  end if;
  select pg_catalog.max(c.stripe_setup_success_event_created) into v_max
    from public.client_payment_methods c where c.studio_id = p_studio_id
      and c.client_id = p_client_id and c.stripe_livemode = p_stripe_livemode;

  if v_existing.id is not null then
    if v_existing.status = 'active' and p_success_event_created = v_max then
      -- Equivalent duplicate success for the SAME intent/time: no evidence rewrite.
      return query select 'idempotent'::text, v_existing.id, null::uuid;
    else
      return query select 'stale_event'::text, null::uuid, null::uuid;
    end if;
    return;
  end if;
  if p_success_event_created < v_max then
    return query select 'stale_event'::text, null::uuid, null::uuid;
    return;
  end if;
  if p_success_event_created = v_max then
    return query select 'ambiguous_event_order'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Private 0180 implementation reuses atomic retire/insert and the SAME lock.
  select * into strict v_saved from public.save_client_card_on_file(
    p_studio_id, p_client_id, p_stripe_account_id, p_stripe_livemode,
    p_stripe_customer_id, p_stripe_payment_method_id, p_stripe_setup_intent_id,
    p_brand, p_last4, p_exp_month, p_exp_year, p_card_authorization_signature_id);
  if v_saved.outcome <> 'inserted' then
    raise exception 'unexpected_unordered_card_outcome';
  end if;
  update public.client_payment_methods c set
    stripe_setup_success_event_id = p_success_event_id,
    stripe_setup_success_event_created = p_success_event_created
    where c.id = v_saved.card_id;
  return query select 'inserted'::text, v_saved.card_id::uuid, v_saved.previous_card_id::uuid;
end;
$$;

-- Close the unordered service bypass. Only the definer can call it internally.
revoke execute on function public.save_client_card_on_file(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid
) from public, anon, authenticated, service_role;
revoke execute on function public.save_client_card_on_file_ordered(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid, text, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.save_client_card_on_file_ordered(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid, text, bigint
) to service_role;
commit;
