-- ===========================================================================
-- 0180 — CARD-ON-FILE REPLACEMENT INTEGRITY
-- ===========================================================================
-- Card replacement becomes ONE transaction.
--
-- WHY A DATABASE BOUNDARY IS NECESSARY (this was proven before the migration
-- was written, not assumed):
--
--   `client_payment_methods_one_active_per_pair` (migration 0058, made
--   mode-scoped by 0104) is a PARTIAL UNIQUE index on
--   (studio_id, client_id, stripe_livemode) WHERE status = 'active'. A second
--   active row therefore cannot exist, so a replacement MUST retire the old
--   active row before inserting the new one — insert-then-retire is impossible.
--
--   The setup_intent.succeeded webhook did exactly that, but as TWO
--   INDEPENDENT PostgREST writes:
--
--       UPDATE … SET status='removed'   -- commits on its own
--       INSERT … status='active'        -- separate round trip
--
--   PostgREST gives each request its own transaction, so there is no way to
--   make those two writes atomic from the application. Any failure of the
--   INSERT that is not 23505 — a check violation, an FK failure, a dropped
--   connection, a statement timeout — leaves the client with ZERO ACTIVE
--   CARDS while their previous, working card has already been retired. The
--   webhook then throws, Stripe retries, and the retry re-runs the same
--   destructive ordering.
--
--   No application-level ordering fixes this. The retire and the insert have
--   to commit together or not at all, which is what this command does.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   * it does not change the partial unique index, the table, or any column;
--   * it does not touch RLS or any existing policy;
--   * it does not change subscription billing, manual fees, appointments,
--     cancellation, Google Calendar, SMS or public booking;
--   * it mutates ZERO business rows.
--
-- The command is service_role-only. The webhook is its only caller.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- save_client_card_on_file
-- ---------------------------------------------------------------------------
-- Caller authority: service_role only (the Stripe webhook's admin client).
--
-- Validates every lineage dimension INSIDE the transaction, then retires the
-- same-mode active card and inserts the new active card atomically.
--
-- Outcomes (returned, never raised, for the two expected non-error cases):
--   'inserted'   — new active card persisted; previous same-mode active card
--                  retired in the same transaction (previous_card_id names it).
--   'idempotent' — a row already exists for this SetupIntent; nothing written.
--
-- Everything else RAISES, so the caller treats it as a retryable failure and
-- the whole transaction — including the retire — rolls back. A failed
-- replacement therefore leaves the OLD CARD ACTIVE, which is the entire point.
--
-- Lineage validation raises with errcode 22023 (invalid_parameter_value) so a
-- caller can distinguish "this payload can never be admitted" from a transient
-- database failure.
-- ---------------------------------------------------------------------------
create or replace function public.save_client_card_on_file(
  p_studio_id                        uuid,
  p_client_id                        uuid,
  p_stripe_account_id                text,
  p_stripe_livemode                  boolean,
  p_stripe_customer_id               text,
  p_stripe_payment_method_id         text,
  p_stripe_setup_intent_id           text,
  p_brand                            text,
  p_last4                            text,
  p_exp_month                        integer,
  p_exp_year                         integer,
  p_card_authorization_signature_id  uuid
)
returns table (
  outcome          text,
  card_id          uuid,
  previous_card_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_id uuid;
  v_prev_id     uuid;
  v_new_id      uuid;
  v_lock_key    bigint;
begin
  -- 1. Every tuple component is required. A NULL here means the caller did not
  --    validate its own input; refuse rather than write a partial row.
  if p_studio_id is null or p_client_id is null
     or p_stripe_account_id is null or p_stripe_livemode is null
     or p_stripe_customer_id is null or p_stripe_payment_method_id is null
     or p_stripe_setup_intent_id is null
     or p_brand is null or p_last4 is null
     or p_exp_month is null or p_exp_year is null then
    raise exception 'save_client_card_on_file requires all card tuple components to be non-null'
      using errcode = '22023';
  end if;

  -- 2. Serialise concurrent replacements for the SAME (studio, client, mode).
  --    Two Stripe deliveries for two DIFFERENT SetupIntents can arrive at once;
  --    claim_stripe_event only serialises redeliveries of the SAME event id.
  --    Without this lock both could pass their idempotency check, both retire
  --    the other's row, and the pair could end with zero active cards or a
  --    unique violation. Mirrors the existing
  --    _acquire_payment_method_tuple_xact_lock idiom from 0032.
  v_lock_key := pg_catalog.hashtextextended(
    p_studio_id::text || '|' || p_client_id::text || '|'
      || case when p_stripe_livemode then 't' else 'f' end,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  -- 3. Idempotency, re-checked under the lock. A prior delivery of this
  --    SetupIntent may already have persisted the card.
  select cpm.id into v_existing_id
  from public.client_payment_methods cpm
  where cpm.studio_id = p_studio_id
    and cpm.client_id = p_client_id
    and cpm.stripe_account_id = p_stripe_account_id
    and cpm.stripe_livemode = p_stripe_livemode
    and cpm.stripe_setup_intent_id = p_stripe_setup_intent_id;

  if v_existing_id is not null then
    outcome := 'idempotent';
    card_id := v_existing_id;
    previous_card_id := null;
    return next;
    return;
  end if;

  -- 4. Customer lineage. Forged metadata that names another studio's client
  --    cannot satisfy the (studio, client, account, mode, customer) tuple.
  if not exists (
    select 1 from public.client_stripe_customers csc
    where csc.studio_id = p_studio_id
      and csc.client_id = p_client_id
      and csc.stripe_account_id = p_stripe_account_id
      and csc.stripe_livemode = p_stripe_livemode
      and csc.stripe_customer_id = p_stripe_customer_id
  ) then
    raise exception 'customer_lineage_mismatch' using errcode = '22023';
  end if;

  -- 5. Card-authorization signature lineage, when one is supplied. NULL is
  --    admitted deliberately: 0058 made the column nullable for future
  --    practitioner-recovery rows.
  if p_card_authorization_signature_id is not null and not exists (
    select 1 from public.client_consent_signatures ccs
    where ccs.id = p_card_authorization_signature_id
      and ccs.studio_id = p_studio_id
      and ccs.client_id = p_client_id
  ) then
    raise exception 'signature_lineage_mismatch' using errcode = '22023';
  end if;

  -- 6. Retire the same-mode active card. Mode-scoped: saving a live card must
  --    not retire the client's test card, and vice versa.
  update public.client_payment_methods cpm
     set status = 'removed',
         removed_at = pg_catalog.now()
   where cpm.studio_id = p_studio_id
     and cpm.client_id = p_client_id
     and cpm.stripe_livemode = p_stripe_livemode
     and cpm.status = 'active'
  returning cpm.id into v_prev_id;

  -- 7. Insert the new active card. Same transaction as step 6 — if this fails,
  --    the retire above rolls back with it and the old card stays active.
  insert into public.client_payment_methods (
    studio_id, client_id, stripe_account_id, stripe_livemode,
    stripe_customer_id, stripe_payment_method_id, stripe_setup_intent_id,
    brand, last4, exp_month, exp_year, status,
    card_authorization_signature_id, added_via
  ) values (
    p_studio_id, p_client_id, p_stripe_account_id, p_stripe_livemode,
    p_stripe_customer_id, p_stripe_payment_method_id, p_stripe_setup_intent_id,
    p_brand, p_last4, p_exp_month, p_exp_year, 'active',
    p_card_authorization_signature_id, 'portal'
  )
  returning id into v_new_id;

  outcome := 'inserted';
  card_id := v_new_id;
  previous_card_id := v_prev_id;
  return next;
  return;
end;
$$;

comment on function public.save_client_card_on_file(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid
) is
  'Atomically persists a card-on-file for (studio, client, mode): validates customer and signature lineage, retires the same-mode active card and inserts the new active card in ONE transaction. Exists because client_payment_methods_one_active_per_pair forces retire-before-insert and PostgREST cannot span the two writes — a failure between them previously left the client with zero active cards. Returns outcome inserted|idempotent; every other condition raises so the caller retries and the retire rolls back. Serialised per (studio, client, mode) by an advisory xact lock. service_role only. Migration 0180.';

-- Supabase''s ALTER DEFAULT PRIVILEGES grants EXECUTE to PUBLIC, anon,
-- authenticated AND service_role at create time. This command writes card
-- rows, so revoke from all of them by name and grant back only service_role.
revoke execute on function public.save_client_card_on_file(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid
) from public, anon, authenticated, service_role;

grant execute on function public.save_client_card_on_file(
  uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid
) to service_role;

commit;
