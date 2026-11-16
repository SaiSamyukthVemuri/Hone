-- 0354: the service-value snapshot (appointment_quoted_amount_cents) now agrees with the TypeScript resolver on an explicitly
-- recorded $0 client-specific price. NOT APPLIED. Hosted apply needs the platform operator's per-change approval and its
-- own package. Order: 0351, then 0352, then 0354, then the application merge. Number reserved in MIGRATION-NUMBER-CLAIMS.
--
-- WHY. Decision (platform operator): an explicitly recorded client-specific $0 price takes precedence over a positive menu
-- price and produces a zero fee/charge; missing pricing remains a refusal. resolveAuthoritativeSessionPaymentAmount now
-- returns `free` for a current $0 custom row. Migration 0187's helper still read a zero custom row as "no custom price
-- recorded" and fell through to the menu price, so the settlement snapshot (quoted_amount_cents) would have recorded the
-- menu price for a client the application treats as free. Two implementations of one pricing rule must not disagree
-- (tests/db/appointment-quoted-amount-parity.db.test.ts).
--
-- WHAT. CREATE OR REPLACE of ONE function with the SAME signature, return type, security definer and search_path. Only the
-- custom-price rule changes:
--   * a current custom row of exactly 0 gives 0 (was: ignored, the menu price won);
--   * a negative current custom price gives NULL (was: ignored). The column CHECK (price_cents >= 0) forbids it, so this is
--     defence for a hand-built row; it must agree with the resolver's invalid_custom_pricing refusal;
--   * a 0 and a positive row equally current DISAGREE: NULL (was: the 0 row was ignored and the positive one won);
--   * everything else (date rule, newest wins, name normalisation, missing -> NULL, menu 0 -> 0) is the 0187 body unchanged.
-- Grants are re-stated by name for public, anon, authenticated and service_role (granted to nobody), as in 0187.
--
-- EFFECT ON EXISTING DATA. None directly: the function derives a value at the moment a settlement is RECORDED. Stored
-- appointment_settlements.quoted_amount_cents values are never rewritten (that table is append-only). A visit settled before
-- this migration keeps the snapshot it was recorded with. Callers: record_appointment_settlement, waive_appointment_fee and
-- supersede_appointment_settlement (0187, 0254). A quoted 0 is already a legal, already-stored value (an explicit $0 menu price
-- gives 0; the column CHECK allows 0), and every reader tolerates it: settlementCoverage compares with >=, unpaid-attention
-- keeps any value >= 0. No reader divides by it.

begin;

set local lock_timeout = '5s';

create or replace function public.appointment_quoted_amount_cents(
  p_studio_id uuid,
  p_appointment_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_service_name  text;
  v_service_price integer;
  v_client_id     uuid;
  v_today         date;
  v_latest        date;
  v_distinct      integer;
  v_custom        integer;
begin
  select s.name, s.price_cents, a.client_id,
         (now() at time zone st.timezone)::date
    into v_service_name, v_service_price, v_client_id, v_today
    from public.appointments a
    join public.studios st
      on st.id = a.studio_id
    left join public.services s
      on s.id = a.service_id
     and s.studio_id = a.studio_id
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;

  -- No appointment, or no booked service: nothing to price. NULL, never 0.
  if not found or v_service_name is null then
    return null;
  end if;

  if v_client_id is not null then
    -- Every CURRENT row for this service, including a recorded 0. A recorded 0 is a decided price (it resolves to an
    -- authoritative zero, like an explicit menu 0), so it is no longer filtered out.
    select max(cp.effective_from) into v_latest
      from public.client_pricing cp
     where cp.studio_id = p_studio_id
       and cp.client_id = v_client_id
       and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
       and cp.effective_from <= v_today;

    if v_latest is not null then
      select count(distinct cp.price_cents), min(cp.price_cents)
        into v_distinct, v_custom
        from public.client_pricing cp
       where cp.studio_id = p_studio_id
         and cp.client_id = v_client_id
         and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
         and cp.effective_from = v_latest;

      -- An unusable (negative) price among the equally-current winners refuses. The column CHECK forbids it; this is
      -- belt and braces and agrees with the TypeScript resolver (invalid_custom_pricing). It never falls through.
      if v_custom < 0 then
        return null;
      end if;
      -- Equally current, disagreeing (a 0 and a positive count as disagreeing). Fail closed rather than guess.
      if v_distinct > 1 then
        return null;
      end if;
      return v_custom;
    end if;
  end if;

  if v_service_price is not null and v_service_price > 0 then
    return v_service_price;
  end if;
  -- An explicit 0 is a decision the studio made. NULL is not.
  if v_service_price = 0 then
    return 0;
  end if;
  return null;
end;
$$;

revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from public;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from anon;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from authenticated;
revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from service_role;

comment on function public.appointment_quoted_amount_cents(uuid, uuid) is
  'The service-value snapshot for an appointment, DERIVED HERE so no caller can choose it. Reproduces resolveAuthoritativeSessionPaymentAmount step for step: current client_pricing matched by normalized service NAME beats the menu price; only rows effective on or before the STUDIO-LOCAL date qualify; newest effective_from wins; equally-current rows that disagree resolve to NULL rather than by row order; a recorded custom price of exactly 0 is an authoritative zero (0354); a negative custom price is NULL, never a fall-through to the menu price; otherwise a positive menu price wins; an explicit menu 0 is an authoritative zero; a missing service, NULL price or ambiguity is NULL. Pinned against the TypeScript resolver by a parity matrix. Granted to nobody.';

commit;
