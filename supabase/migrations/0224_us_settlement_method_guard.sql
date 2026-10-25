-- ===========================================================================
-- 0224 — PAY-CCY-07 (#824): A US STUDIO DOES NOT RECORD INTERAC E-TRANSFER
-- ===========================================================================
--
-- THE DECISION. On 2026-10-12 the operator chose option B for #871: a studio
-- whose payment country is US records a client's Zelle, Venmo or check as
-- `paid_other_external` ("Paid another way (Zelle, Venmo, check)"), and is not
-- offered `paid_e_transfer`, which means Interac e-Transfer, a Canadian rail.
-- Canada is unchanged.
--
-- THE LAYERS. #871 removes the option from the screen and refuses it in both
-- settlement server actions (record, and the owner's correction). This file is
-- the database backstop: a row can reach appointment_settlements only through
-- the 0187 commands, and this guard makes the rule hold for every caller of
-- them, not only the two actions that exist today.
--
-- WHAT IT DOES NOT DO.
--   * 0187's closed vocabulary and its CHECK are untouched. `paid_e_transfer`
--     stays a legal value: it is refused for a US JURISDICTION, not removed.
--   * No row is read, rewritten or deleted. Existing settlements, and the
--     append-only / no-delete triggers 0187 installs, are untouched. No US
--     studio exists at the time of writing, so there is nothing to reconcile.
--   * Canada, and every other method in either country, pass through.
--
-- SERIALIZATION. The jurisdiction row is read FOR SHARE, which
-- set_studio_payment_jurisdiction (0214) holds FOR UPDATE, so a settlement
-- cannot interleave with a CA -> US change. (0214 already refuses that change
-- once any settlement exists; this keeps the two orders consistent.)
--
-- DEPENDS ON 0187 (appointment_settlements) and 0214
-- (studio_payment_jurisdictions). Applies after 0223. Reserved in
-- ~/hone-migration-coordination.md after a fresh census.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.appointment_settlements_method_for_jurisdiction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_country text;
begin
  -- Only one method has a country rule. Every other insert returns at once
  -- and never touches the jurisdiction row.
  if new.method is distinct from 'paid_e_transfer' then
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

  if v_country = 'US' then
    raise exception
      'settlement_method_unavailable: paid_e_transfer (Interac e-Transfer) is not recorded for a studio whose payment country is US; record paid_other_external'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists appointment_settlements_method_for_jurisdiction
  on public.appointment_settlements;
create trigger appointment_settlements_method_for_jurisdiction
  before insert on public.appointment_settlements
  for each row execute function public.appointment_settlements_method_for_jurisdiction();

-- ---------------------------------------------------------------------------
-- Privileges. Supabase's ALTER DEFAULT PRIVILEGES grants a new function to
-- anon, authenticated AND service_role; a trigger function needs none of them.
-- ---------------------------------------------------------------------------
revoke all privileges on function public.appointment_settlements_method_for_jurisdiction()
  from public, anon, authenticated, service_role;

comment on function public.appointment_settlements_method_for_jurisdiction() is
  'PAY-CCY-07 (#824, option B): refuses an appointment_settlements row with method paid_e_transfer (Interac e-Transfer, a Canadian rail) for a studio whose payment jurisdiction is US; such a payment is recorded as paid_other_external. Every other method, and every CA studio, passes through. Reads the jurisdiction FOR SHARE, serializing with set_studio_payment_jurisdiction. Backstop for the same rule in the settlement server actions.';

commit;
