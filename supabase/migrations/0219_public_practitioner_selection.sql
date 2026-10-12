-- ===========================================================================
-- 0219 — G1: public practitioner selection (#824, DB/WAIT)
-- ===========================================================================
-- THE GAP THIS CLOSES. `create_public_appointment` (0170:636) takes no
-- practitioner parameter, and derives assignment from the ACTIVE-OWNER COUNT
-- (0170:790-808): 0 owners -> NULL, exactly 1 -> that owner, 2+ -> NULL. For a
-- studio of one owner plus five treating practitioners, EVERY ordinary public
-- booking is therefore attributed to the owner and none to the five. That
-- decides attribution, the notification recipient and the client-facing
-- practitioner name. `public_booking_slot_candidates` (0209:49) likewise takes
-- no practitioner.
--
-- THIS MIGRATION IS ADDITIVE AND CHANGES NO EXISTING BEHAVIOUR. It adds two
-- read-only functions. It does NOT touch `create_public_appointment`,
-- `public_booking_slot_candidates`, any table, column, constraint, index,
-- policy or trigger, and it writes no row. The booking command itself is a
-- separate slice; shipping the read side first means the picker can be built
-- and proved before anything can write a practitioner-scoped public booking.
--
-- NOTHING HERE INVENTS POLICY. Both rules are copied from existing authority:
--   * the WINDOW precedence — a practitioner-scoped availability row beats the
--     studio-wide row, override beats weekly default — is
--     `validate_appointment_availability`'s rule (0152, and 0146:127/136):
--     `where (x.practitioner_id = p_practitioner_id or x.practitioner_id is null)
--      order by (x.practitioner_id is not null) desc limit 1`;
--   * the CONFLICT resource scope is `find_scoped_calendar_conflict`'s
--     (0139:124-130): studio-wide when capacity is off, the named
--     practitioner's key when on.
--
-- A CONSEQUENCE WORTH STATING. When a studio is in the LEGACY capacity state
-- (`practitioner_capacity_enabled = false`, the default — 0134/0136), every
-- reservation is keyed to the STUDIO, so choosing a practitioner buys no
-- parallelism: another practitioner's appointment still blocks the slot. That
-- is 0136's model, not a defect here, and it is proved by test rather than
-- asserted.
--
-- RECEPTIONISTS CANNOT APPEAR. The options function filters
-- `role in ('owner','practitioner')`, and a receptionist is not a
-- `practitioners` row at all — it lives in `studio_receptionists` (0216:47).
-- They are therefore excluded twice over, which is the design: denied by
-- construction as a treating resource.
--
-- GRANTS. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
-- authenticated AND service_role at create time, so each function revokes from
-- public, anon, authenticated and service_role BY NAME and is then granted to
-- service_role only — the posture of `create_public_appointment` (0170:955-964)
-- and `public_booking_slot_candidates` (0209:210-214). The public booking route
-- reaches them through the server's service-role client, never from the browser.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) The picker's options.
--     Deterministically ordered (owner first, then display name, then id) so a
--     page render and a test agree. Returns NO email and no PII beyond the
--     display name the studio already shows publicly.
-- ---------------------------------------------------------------------------
create or replace function public.public_booking_practitioner_options(
  p_studio_id uuid
)
returns table (
  practitioner_id uuid,
  display_name    text,
  is_owner        boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.id, p.display_name, (p.role = 'owner')
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.active
     and p.role in ('owner', 'practitioner')
   order by (p.role = 'owner') desc, p.display_name, p.id;
$$;

-- ---------------------------------------------------------------------------
-- (2) Practitioner-scoped slot candidates.
--     Body deliberately mirrors public_booking_slot_candidates (0209) so the
--     two stay comparable: same buffer handling, same millisecond truncation,
--     same 36-hour read window, same opening-anchor + conflict-derived anchor
--     construction. The ONLY differences are the practitioner validation, the
--     window precedence and the resource-scoped conflict predicate.
-- ---------------------------------------------------------------------------
create or replace function public.public_booking_slot_candidates_for_practitioner(
  p_studio_id        uuid,
  p_local_date       date,
  p_duration_minutes integer,
  p_practitioner_id  uuid
)
returns setof timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz            text;
  v_buffer        integer;
  v_cap_on        boolean;
  v_is_open       boolean;
  v_open          time;
  v_close         time;
  v_open_min      integer;
  v_close_min     integer;
  v_open_utc      timestamptz;
  v_close_utc     timestamptz;
  v_win_start     timestamptz;
  v_win_end       timestamptz;
  v_res_win_start timestamptz;
  v_m             integer;
  v_cands         timestamptz[] := '{}';
  r               record;
begin
  if p_practitioner_id is null then return; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then return; end if;

  select s.timezone, greatest(coalesce(s.buffer_minutes, 0), 0)
    into v_tz, v_buffer
    from public.studios s
   where s.id = p_studio_id;
  if not found then return; end if;

  -- The practitioner must be THIS studio's, active, and a treating role. A
  -- receptionist cannot reach here: it is not a practitioners row.
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_practitioner_id
       and p.studio_id = p_studio_id
       and p.active
       and p.role in ('owner', 'practitioner')
  ) then
    return;
  end if;

  v_cap_on := public.studio_capacity_enabled(p_studio_id);

  -- A studio-wide blockout closes the day for everyone.
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= p_local_date
       and b.ends_on   >= p_local_date
  ) then
    return;
  end if;

  -- WINDOW, with 0152's precedence: a practitioner-scoped row beats the
  -- studio-wide row; a date override beats the weekly default.
  select o.is_open, o.open_time, o.close_time
    into v_is_open, v_open, v_close
    from public.studio_availability_overrides o
   where o.studio_id = p_studio_id
     and o.effective_date = p_local_date
     and (o.practitioner_id = p_practitioner_id or o.practitioner_id is null)
   order by (o.practitioner_id is not null) desc
   limit 1;
  if not found then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = extract(dow from p_local_date)::integer
       and (d.practitioner_id = p_practitioner_id or d.practitioner_id is null)
     order by (d.practitioner_id is not null) desc
     limit 1;
    if not found then return; end if;
  end if;
  if not coalesce(v_is_open, false) or v_open is null or v_close is null then
    return;
  end if;

  -- Truncate to HH:MM first, and apply the SAME truncated value to both the
  -- local-minute walk bounds and the UTC filter bounds (0209's rule).
  v_open      := date_trunc('minute', v_open);
  v_close     := date_trunc('minute', v_close);
  v_open_min  := extract(hour from v_open)::integer * 60 + extract(minute from v_open)::integer;
  v_close_min := extract(hour from v_close)::integer * 60 + extract(minute from v_close)::integer;
  v_open_utc  := public.public_booking_local_to_utc(p_local_date, v_open, v_tz);
  v_close_utc := public.public_booking_local_to_utc(p_local_date, v_close, v_tz);
  v_win_start := public.public_booking_local_to_utc(p_local_date, '00:00'::time, v_tz);
  v_win_end   := v_win_start + interval '36 hours';
  -- One buffer earlier, per 0209/WAIT-v4 PR0: reservations store the ACTUAL
  -- end and the buffer is re-applied below to reach the PROTECTED end.
  v_res_win_start := v_win_start - make_interval(mins => v_buffer);

  -- (A) opening anchor + hourly fallback, walked in LOCAL minutes.
  v_m := v_open_min;
  while v_m + p_duration_minutes <= v_close_min loop
    v_cands := v_cands || date_trunc('milliseconds', public.public_booking_local_to_utc(
      p_local_date, make_time(v_m / 60, v_m % 60, 0), v_tz
    ));
    v_m := v_m + 60;
  end loop;

  -- (B)+(C) conflict-derived anchors, from THIS practitioner's resource scope.
  for r in
    select date_trunc('milliseconds', cr.starts_at) as starts_at,
           date_trunc('milliseconds',
             case when cr.source_kind = 'appointment'
                  then cr.ends_at + make_interval(mins => v_buffer)
                  else cr.ends_at
             end) as protected_end
      from public.studio_calendar_reservations cr
     where cr.studio_id = p_studio_id
       and cr.starts_at < v_win_end
       and cr.ends_at   > v_res_win_start
       and (case
              when not v_cap_on then cr.resource_key = p_studio_id
              else cr.resource_key = p_practitioner_id
            end)
  loop
    v_cands := v_cands || r.protected_end;
    v_cands := v_cands || (r.starts_at - make_interval(mins => p_duration_minutes + v_buffer));
  end loop;

  return query
    select distinct c
      from unnest(v_cands) c
     where c >= v_open_utc
       and c + make_interval(mins => p_duration_minutes) <= v_close_utc
       and not exists (
         select 1
           from public.studio_calendar_reservations cr2
          where cr2.studio_id = p_studio_id
            and cr2.starts_at < v_win_end
            and cr2.ends_at   > v_res_win_start
            and (case
                   when not v_cap_on then cr2.resource_key = p_studio_id
                   else cr2.resource_key = p_practitioner_id
                 end)
            and c < date_trunc('milliseconds',
                      case when cr2.source_kind = 'appointment'
                           then cr2.ends_at + make_interval(mins => v_buffer)
                           else cr2.ends_at end)
            and (c + make_interval(mins => p_duration_minutes + v_buffer))
                  > date_trunc('milliseconds', cr2.starts_at)
       );
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS — revoke from all four roles BY NAME, then service_role only.
-- ---------------------------------------------------------------------------
revoke execute on function public.public_booking_practitioner_options(uuid) from public;
revoke execute on function public.public_booking_practitioner_options(uuid) from anon;
revoke execute on function public.public_booking_practitioner_options(uuid) from authenticated;
revoke execute on function public.public_booking_practitioner_options(uuid) from service_role;
grant execute on function public.public_booking_practitioner_options(uuid) to service_role;

revoke execute on function public.public_booking_slot_candidates_for_practitioner(uuid, date, integer, uuid) from public;
revoke execute on function public.public_booking_slot_candidates_for_practitioner(uuid, date, integer, uuid) from anon;
revoke execute on function public.public_booking_slot_candidates_for_practitioner(uuid, date, integer, uuid) from authenticated;
revoke execute on function public.public_booking_slot_candidates_for_practitioner(uuid, date, integer, uuid) from service_role;
grant execute on function public.public_booking_slot_candidates_for_practitioner(uuid, date, integer, uuid) to service_role;

commit;
