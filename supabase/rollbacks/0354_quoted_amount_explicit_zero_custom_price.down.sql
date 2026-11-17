-- Down for 0354. Restores the 0187 body of appointment_quoted_amount_cents: a zero or negative custom price is read as "no
-- custom price recorded" and the menu price decides. Touches nothing else. Stored settlement snapshots are not rewritten by
-- either direction. Roll the application back first (the resolver would otherwise treat a $0 custom row as free while the
-- snapshot recorded the menu price).
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
    select max(cp.effective_from) into v_latest
      from public.client_pricing cp
     where cp.studio_id = p_studio_id
       and cp.client_id = v_client_id
       and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
       and cp.effective_from <= v_today
       and cp.price_cents > 0;

    if v_latest is not null then
      select count(distinct cp.price_cents), min(cp.price_cents)
        into v_distinct, v_custom
        from public.client_pricing cp
       where cp.studio_id = p_studio_id
         and cp.client_id = v_client_id
         and lower(btrim(cp.service_name)) = lower(btrim(v_service_name))
         and cp.effective_from = v_latest
         and cp.price_cents > 0;

      -- Equally current, disagreeing. Fail closed rather than guess.
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
  'The service-value snapshot for an appointment, DERIVED HERE so no caller can choose it. Reproduces resolveAuthoritativeSessionPaymentAmount step for step: current client_pricing matched by normalized service NAME beats the menu price; only rows effective on or before the STUDIO-LOCAL date qualify; newest effective_from wins; equally-current rows that disagree resolve to NULL rather than by row order; a positive menu price otherwise wins; an explicit menu 0 is an authoritative zero; a missing service, NULL price or ambiguity is NULL. A zero or negative CUSTOM price is read as no custom price recorded, never as charge nothing. Pinned against the TypeScript resolver by a parity matrix. Granted to nobody.';

commit;
