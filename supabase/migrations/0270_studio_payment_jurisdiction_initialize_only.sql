-- ===========================================================================
-- 0270 -- JURISDICTION OWNER CONFIRMATION: AN INITIALIZE-ONLY COMMAND
-- ===========================================================================
--
-- 0214's set_studio_payment_jurisdiction is a "set" command: when a row already
-- exists and differs, it UPDATES it (returns 'changed'). The owner's own
-- confirmation must never do that. Two concurrent confirmations with different
-- pairs for a studio with no row both pass the application's "missing" read, and
-- the second then overwrites the first (Codex P2 on #1233; Insurance
-- PEER-STACKED-PAY-FINDINGS, option a). Compare-and-set cannot be expressed
-- through 0214's arguments, so this adds a SECOND command that can only
-- initialize. 0214 is not edited and stays the operator's change path.
--
-- public.initialize_studio_payment_jurisdiction_owner(...)
--   Same studio-row serialization as 0214 (FOR NO KEY UPDATE on the studio, FOR
--   UPDATE on the jurisdiction row, then FOR UPDATE on the studio), so a first
--   payment cannot interleave. Then:
--     row exists, same pair        -> 'unchanged'   (nothing written)
--     row exists, different pair   -> 'already_set' (nothing written, never UPDATE)
--     no row                       -> the same refusals as 0214 with no price
--                                     acknowledgement, else insert the row and
--                                     its audit row -> 'initialized'
--   Other results: invalid_input, verification_required, not_found,
--   refused_payment_account, refused_monetary_history,
--   refused_priced_configuration (the owner path never acknowledges prices).
--
-- Catalog-only: one function, no table, no rewrite, no data change. service_role
-- only: EXECUTE is revoked from public, anon, authenticated AND service_role by
-- name, then granted to service_role (the 0129 / 0164 failure class).

begin;

set local lock_timeout = '5s';

create or replace function public.initialize_studio_payment_jurisdiction_owner(
  p_studio_id uuid,
  p_payment_country text,
  p_payment_currency text,
  p_actor text,
  p_reason text,
  p_verification_reference text
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
  v_reference text := btrim(coalesce(p_verification_reference, ''));
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

  -- Identical lock order to set_studio_payment_jurisdiction (0214): studio NO
  -- KEY UPDATE, jurisdiction FOR UPDATE, then the studio upgrade. See 0214 for
  -- why this order avoids the payment foreign-key lock cycle.
  perform 1 from public.studios st where st.id = p_studio_id for no key update;
  if not found then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select * into v_row
    from public.studio_payment_jurisdictions j
   where j.studio_id = p_studio_id
   for update;

  perform 1 from public.studios st where st.id = p_studio_id for update;

  -- A stored pair is never replaced by this command.
  if v_row.studio_id is not null then
    if v_row.payment_country = v_country and v_row.payment_currency = v_currency then
      return query select 'unchanged'::text, v_row.payment_country, v_row.payment_currency;
    else
      return query select 'already_set'::text, v_row.payment_country, v_row.payment_currency;
    end if;
    return;
  end if;

  -- No row: the 0214 refusals, unchanged in substance.
  if exists (select 1 from public.stripe_account_provisioning_attempts a
              where a.studio_id = p_studio_id)
     or exists (select 1 from public.studio_payment_settings s
                 where s.studio_id = p_studio_id and s.stripe_account_id is not null)
     or exists (select 1 from public.client_payment_methods m
                 where m.studio_id = p_studio_id)
     or exists (select 1 from public.client_stripe_customers c
                 where c.studio_id = p_studio_id) then
    return query select 'refused_payment_account'::text, null::text, null::text;
    return;
  end if;

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
    return query select 'refused_monetary_history'::text, null::text, null::text;
    return;
  end if;

  if exists (select 1 from public.services sv
              where sv.studio_id = p_studio_id and coalesce(sv.price_cents, 0) > 0)
     or exists (select 1 from public.client_pricing cp
                 where cp.studio_id = p_studio_id)
     or exists (select 1 from public.studios st
                 where st.id = p_studio_id
                   and (coalesce(st.late_cancel_fee_cents, 0) > 0
                        or coalesce(st.no_show_fee_cents, 0) > 0))
     or exists (select 1 from public.sessions se
                 where se.studio_id = p_studio_id and se.price_paid_cents is not null) then
    return query select 'refused_priced_configuration'::text, null::text, null::text;
    return;
  end if;

  insert into public.studio_payment_jurisdictions
    (studio_id, payment_country, payment_currency, source, verification_reference)
  values (p_studio_id, v_country, v_currency, 'operator', v_reference);

  insert into public.studio_payment_jurisdiction_changes
    (studio_id, from_country, from_currency, to_country, to_currency,
     actor, reason, prices_acknowledged, verification_reference)
  values
    (p_studio_id, null, null, v_country, v_currency, v_actor, v_reason, false, v_reference);

  return query select 'initialized'::text, v_country, v_currency;
end;
$$;

revoke execute on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) from public;
revoke execute on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) from anon;
revoke execute on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) from authenticated;
revoke execute on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) from service_role;
grant execute on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) to service_role;

comment on function public.initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text) is
  'Initialize-only owner confirmation of a studio''s payment country and charge currency (CA/cad or US/usd). Serializes on the studio and jurisdiction rows exactly as set_studio_payment_jurisdiction. An existing row is NEVER updated: same pair returns unchanged, a different pair returns already_set. With no row it applies the 0214 account, monetary-history and configured-price refusals (no price acknowledgement exists on this path), else inserts the row and its audit row. service_role only.';

-- Self-check: the command exists, is security definer with a pinned search_path,
-- and only service_role may execute it.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'initialize_studio_payment_jurisdiction_owner'
       and p.prosecdef
       and p.proconfig::text like '%search_path=pg_catalog, pg_temp%'
  ) then
    raise exception '0270: initialize_studio_payment_jurisdiction_owner missing or not pinned';
  end if;
  if has_function_privilege('anon', 'public.initialize_studio_payment_jurisdiction_owner(uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.initialize_studio_payment_jurisdiction_owner(uuid,text,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.initialize_studio_payment_jurisdiction_owner(uuid,text,text,text,text,text)', 'EXECUTE') then
    raise exception '0270: unexpected EXECUTE grants';
  end if;
end;
$$;

commit;
