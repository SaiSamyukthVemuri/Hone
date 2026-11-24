-- Owner-agreed fee for one visit. Existing settlements and their readers retain
-- their quote semantics. For an adjustment, quoted_amount_cents is the fee
-- actually agreed; reference_fee_cents is the independently resolved price.
begin;
set local lock_timeout = '5s';

alter table public.appointment_settlements
  add column reference_fee_cents integer,
  add column fee_adjustment_reason text,
  add constraint appointment_settlements_adjustment_evidence check (
    (reference_fee_cents is null and fee_adjustment_reason is null)
    or (reference_fee_cents is not null and reference_fee_cents between 1 and 200000
        and quoted_amount_cents is not null and (quoted_amount_cents <> reference_fee_cents or supersedes_id is not null)
        and fee_adjustment_reason is not null and length(btrim(fee_adjustment_reason)) between 1 and 200)
  );

-- An existing correction only replaces the disposition. It must not silently
-- reprice a negotiated fee from today's menu or lose its original quote.
create function public.preserve_settlement_fee_adjustment() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  previous public.appointment_settlements%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.reference_fee_cents is distinct from old.reference_fee_cents
       or new.fee_adjustment_reason is distinct from old.fee_adjustment_reason then
      raise exception 'Settlement fee evidence is immutable' using errcode = 'check_violation';
    end if;
  elsif new.supersedes_id is not null then
    select * into previous from public.appointment_settlements
      where id = new.supersedes_id and studio_id = new.studio_id and appointment_id = new.appointment_id;
    if previous.reference_fee_cents is not null then
      new.reference_fee_cents := previous.reference_fee_cents;
      new.fee_adjustment_reason := previous.fee_adjustment_reason;
      if previous.method = 'waived' and previous.quoted_amount_cents = 0 and new.method <> 'waived' then
        -- An explicit owner correction reverses the zero-fee waiver. Keep the
        -- original waiver in the history and restore the actual booking quote.
        new.quoted_amount_cents := previous.reference_fee_cents;
      else
        new.quoted_amount_cents := previous.quoted_amount_cents;
      end if;
      if new.amount_cents <= 0
         or (new.method <> 'waived' and new.amount_cents > new.quoted_amount_cents)
         or (new.method = 'still_owes' and new.amount_cents <> new.quoted_amount_cents)
         or (new.method = 'waived' and new.amount_cents <> coalesce(nullif(new.quoted_amount_cents, 0), previous.reference_fee_cents)) then
        raise exception 'settlement_adjusted_amount_invalid' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.preserve_settlement_fee_adjustment() from public, anon, authenticated, service_role;
create trigger preserve_settlement_fee_adjustment
before insert or update of reference_fee_cents, fee_adjustment_reason on public.appointment_settlements
for each row execute function public.preserve_settlement_fee_adjustment();

create function public.record_adjusted_appointment_settlement(
  p_studio_id uuid, p_appointment_id uuid, p_method text, p_amount_cents integer,
  p_note text, p_livemode boolean, p_reference_fee_cents integer,
  p_final_fee_cents integer, p_fee_adjustment_reason text
) returns table (result text, settlement_id uuid, recorded_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  actor uuid;
  visit_status text;
  baseline integer;
  reason text := nullif(btrim(p_fee_adjustment_reason), '');
  internal_note text := nullif(btrim(p_note), '');
  existing public.appointment_settlements%rowtype;
begin
  actor := public.session_actor_practitioner(p_studio_id);
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if p_appointment_id is null or p_method is null
     or p_method not in ('paid_cash','paid_e_transfer','paid_other_external','still_owes','waived')
     or p_reference_fee_cents is null or p_reference_fee_cents not between 1 and 200000
     or p_final_fee_cents is null or p_final_fee_cents not between 0 and 200000
     or p_reference_fee_cents = p_final_fee_cents
     or reason is null or length(reason) > 200 or length(internal_note) > 500
     or p_amount_cents is null or p_amount_cents not between 1 and 200000
     or (p_method <> 'waived' and p_amount_cents > p_final_fee_cents)
     or (p_method = 'still_owes' and p_amount_cents <> p_final_fee_cents)
     or (p_method = 'waived' and p_amount_cents <> coalesce(nullif(p_final_fee_cents, 0), p_reference_fee_cents)) then
    return query select 'invalid_input'::text, null::uuid, null::timestamptz;
    return;
  end if;
  select a.status into visit_status from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  perform pg_advisory_xact_lock(public.appointment_settlement_lock_key(p_appointment_id));
  -- Locking the appointment after the advisory lock also closes a concurrent
  -- status correction while this checkout is being committed.
  select a.status into visit_status from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id for share;
  if visit_status is distinct from 'completed' then
    return query select 'not_completed'::text, null::uuid, null::timestamptz;
    return;
  end if;
  select * into existing from public.appointment_settlements s
   where s.studio_id = p_studio_id and s.appointment_id = p_appointment_id and s.superseded_at is null;
  if found then
    return query select 'already_settled'::text, existing.id, existing.recorded_at;
    return;
  end if;
  if public.appointment_has_live_card_money(p_studio_id, p_appointment_id, coalesce(p_livemode, true)) then
    return query select 'card_payment_exists'::text, null::uuid, null::timestamptz;
    return;
  end if;
  baseline := public.appointment_quoted_amount_cents(p_studio_id, p_appointment_id);
  if baseline is distinct from p_reference_fee_cents then
    return query select 'fee_changed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- The established settlement currency trigger derives the studio currency.
  -- Retirement happens after every refusal and rolls back if the insert fails.
  perform public.retire_ready_card_attempts(p_studio_id, p_appointment_id, actor);
  return query
    insert into public.appointment_settlements as s (
      studio_id, appointment_id, method, amount_cents, quoted_amount_cents,
      recorded_by_practitioner_id, note, reference_fee_cents, fee_adjustment_reason
    ) values (
      p_studio_id, p_appointment_id, p_method, p_amount_cents, p_final_fee_cents,
      actor, internal_note, baseline, reason
    ) returning 'recorded'::text, s.id, s.recorded_at;
end;
$$;

revoke all on function public.record_adjusted_appointment_settlement(uuid,uuid,text,integer,text,boolean,integer,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.record_adjusted_appointment_settlement(uuid,uuid,text,integer,text,boolean,integer,integer,text) to authenticated;

commit;
