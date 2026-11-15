-- PAY-006 legacy history: a provable UPPER BOUND, not a guessed timestamp.
-- 0245 refuses (unknown_event_order) every success for a client whose same-mode
-- history holds ANY pre-0245 row (NULL success evidence), forever, so a client
-- with a pre-0245 card can never save or replace a card again (live incident
-- 2026-11-04: card_setup_active_event_order_unverified, every retry identical).
--
-- Bound. Every NULL-evidence row was inserted by a webhook PROCESSING ITS OWN
-- setup_intent.succeeded (pre-0180 direct insert, then 0180's command; both
-- hard-code added_via = 'portal' and leave created_at to its default now()).
-- Stripe created that event before delivering it, and the insert transaction
-- began after delivery, so event.created <= created_at, up to Stripe-vs-DB
-- clock skew. ceil(epoch(created_at)) + margin is therefore an upper bound on
-- that row's success-event time. Writer enumeration and proof:
-- docs/production/0300-card-legacy-event-order-bound.md.
--
-- The ONLY behaviour change: when every NULL row is a trusted 'portal' row and
-- p_success_event_created is STRICTLY greater than the greatest bound, the call
-- continues through 0245's known-evidence logic unchanged. Everything else that
-- 0245 refused as unknown_event_order still is: an event at or inside the
-- margin, an older event, a same-intent legacy row, any non-'portal' NULL row.
-- Legacy rows are not rewritten: no backfill, no evidence fabricated onto them.
-- Same signature, so the deployed app needs no change. Rollback (held):
-- supabase/rollbacks/0300_card_setup_legacy_event_order_bound.down.sql.
begin;
set local lock_timeout = '5s';

create or replace function public.save_client_card_on_file_ordered(
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
  -- Margin over Stripe-vs-DB clock skew (both NTP-disciplined: well under a
  -- second in practice) plus whole-second truncation of event.created. 900 s
  -- is three orders of magnitude above that. A larger margin would cost
  -- nothing (every legacy row predates the 2026-10-27 0245 apply), a smaller
  -- one buys nothing. An event inside it is still refused: unknown_event_order.
  c_legacy_margin_seconds constant bigint := 900;
  v_existing public.client_payment_methods%rowtype;
  v_max bigint;
  v_saved record;
  v_legacy_rows bigint;
  v_untrusted_rows bigint;
  v_legacy_bound bigint;
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
  -- It is only BOUNDED ABOVE by its own insert time (see header), active or
  -- removed alike, and only for writer-attested 'portal' rows.
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where c.added_via is distinct from 'portal'),
         pg_catalog.ceil(pg_catalog.max(extract(epoch from c.created_at)))::bigint
           + c_legacy_margin_seconds
    into v_legacy_rows, v_untrusted_rows, v_legacy_bound
    from public.client_payment_methods c
    where c.studio_id = p_studio_id and c.client_id = p_client_id
      and c.stripe_livemode = p_stripe_livemode
      and c.stripe_setup_success_event_created is null;
  if v_legacy_rows > 0 and (
    v_untrusted_rows > 0
    -- A redelivered pre-0245 success for the SAME intent stays unknown, never
    -- stale (terminal) and never idempotent.
    or (v_existing.id is not null and v_existing.stripe_setup_success_event_created is null)
    or p_success_event_created <= v_legacy_bound
  ) then
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

-- Supabase's ALTER DEFAULT PRIVILEGES does not re-fire on CREATE OR REPLACE,
-- but restate 0245's closure by name so this file alone proves the posture.
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
