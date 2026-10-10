-- 0209 · WAIT-v4 PR0 — the SQL candidate window crosses local midnight too
--
-- WHAT THIS CLOSES. `public_booking_slot_candidates` (0170) and
-- `public_reschedule_slot_candidates` (0171) read
-- `studio_calendar_reservations` with `cr.ends_at > v_win_start` — the ACTUAL
-- end — while re-applying the studio buffer to reach the PROTECTED end. A
-- 23:50 appointment under a 30-minute buffer is protected to 00:20, so it was
-- never loaded for the following day and LOCAL MIDNIGHT WAS OFFERED. Measured
-- against the live function before this migration: it returned local midnight.
--
-- THE WRITE PATH WAS NEVER AT RISK, and that is why this is offer-truth rather
-- than a safety fix. `validate_public_booking_slot` and
-- `validate_public_reschedule_slot` read reservations with NO window filter at
-- all and test the buffered `tstzrange` overlap directly, so they already
-- refused midnight — in the booking validator the overlap check runs BEFORE the
-- candidate-membership check, so the refusal was `time_unavailable`, not
-- `not_a_public_slot`. 0152's enforce_appointment_buffer refused it too, with
-- HB001. The defect was that a client was shown a slot that would fail.
--
-- BODY-ONLY, SIGNATURE-PRESERVING. Both functions are re-created from their
-- live 0170/0171 text with exactly three edits each: one declaration, one
-- derived assignment, and the two reservation predicates. Nothing else in
-- either body is altered, so the millisecond-normalisation contract, the
-- anchor families, the closing-edge packing and the reschedule exclusion are
-- byte-identical to what they replace.
--
-- THE RESCHEDULE EXCLUSION IS NEWLY LOAD-BEARING. 0171's predicates exclude the
-- moving appointment by (source_kind, source_id) inside the same WHERE, so a
-- wider lower bound cannot re-admit the appointment's own previous-day row.
-- That exclusion was always there; it now also guards the extra buffer window.
--
-- GRANTS ARE RE-ASSERTED, NOT ASSUMED. Supabase's ALTER DEFAULT PRIVILEGES
-- grants EXECUTE to anon, authenticated AND service_role at function-create
-- time, and `create or replace` re-triggers that. Both functions are
-- service-role only, so all three roles plus PUBLIC are revoked BY NAME and
-- service_role is re-granted, exactly as 0170/0171 did.
--
-- NO SCHEMA CHANGE: no table, column, index, constraint, trigger or policy. No
-- DML. Two `create or replace function` statements, eight revokes, two grants.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.public_booking_slot_candidates — forward redefinition
-- ---------------------------------------------------------------------------

create or replace function public.public_booking_slot_candidates(
  p_studio_id        uuid,
  p_local_date       date,
  p_duration_minutes integer
)
returns setof timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz        text;
  v_buffer    integer;
  v_is_open   boolean;
  v_open      time;
  v_close     time;
  v_open_min  integer;
  v_close_min integer;
  v_open_utc  timestamptz;
  v_close_utc timestamptz;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_res_win_start timestamptz;
  v_m         integer;
  v_cands     timestamptz[] := '{}';
  r           record;
begin
  select s.timezone, greatest(coalesce(s.buffer_minutes, 0), 0)
    into v_tz, v_buffer
    from public.studios s
   where s.id = p_studio_id;
  if not found then return; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then return; end if;

  -- Window: a date override beats the weekly default; STUDIO-WIDE rows only.
  select o.is_open, o.open_time, o.close_time
    into v_is_open, v_open, v_close
    from public.studio_availability_overrides o
   where o.studio_id = p_studio_id
     and o.effective_date = p_local_date
     and o.practitioner_id is null
   limit 1;
  if not found then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = extract(dow from p_local_date)::integer
       and d.practitioner_id is null
     limit 1;
    if not found then return; end if;
  end if;
  if not coalesce(v_is_open, false) or v_open is null or v_close is null then
    return;
  end if;

  -- A full-day blockout suppresses the entire day (slots.ts:147-155 returns []).
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= p_local_date
       and b.ends_on   >= p_local_date
  ) then
    return;
  end if;

  -- TRUNCATE TO HH:MM FIRST. lib/booking/slots.ts strips seconds from both
  -- window bounds via trimTime() (slots.ts:118-121, applied at :164-165), so the
  -- SQL must too — and it must apply the SAME truncated value to BOTH the
  -- local-minute walk bounds AND the UTC filter bounds. Deriving the minute
  -- bounds from hour+minute while deriving the UTC bounds from the full `time`
  -- made the two disagree whenever a window carried seconds: a close_time of
  -- 17:00:45 accepted a start whose service end was 17:00:30, which the page
  -- never offers; an open_time of 09:00:30 dropped the entire opening-anchor
  -- family. The app's own writers enforce HH:MM
  -- (app/(app)/settings/availability/actions.ts:221), so this is reachable only
  -- by a direct database write — but the port must not depend on that.
  v_open      := date_trunc('minute', v_open);
  v_close     := date_trunc('minute', v_close);
  v_open_min  := extract(hour from v_open)::integer * 60 + extract(minute from v_open)::integer;
  v_close_min := extract(hour from v_close)::integer * 60 + extract(minute from v_close)::integer;
  v_open_utc  := public.public_booking_local_to_utc(p_local_date, v_open, v_tz);
  v_close_utc := public.public_booking_local_to_utc(p_local_date, v_close, v_tz);
  v_win_start := public.public_booking_local_to_utc(p_local_date, '00:00'::time, v_tz);
  v_win_end   := v_win_start + interval '36 hours';

  -- WAIT-v4 PR0. The reservation read opens ONE BUFFER EARLIER than the
  -- day, because `studio_calendar_reservations` stores an appointment's
  -- ACTUAL end and this function re-applies the buffer below to reach its
  -- PROTECTED end. Filtering on the actual end dropped exactly the row
  -- whose protected end reaches into the window: a 23:50 appointment under
  -- a 30-minute buffer is protected to 00:20, but `ends_at > v_win_start`
  -- is false, so local midnight was OFFERED while validate_* and 0152's
  -- enforce_appointment_buffer both REFUSED it. Reachable only by a studio
  -- whose open time falls within `buffer` minutes of local midnight.
  --
  -- v_win_end is deliberately untouched: only the lower bound was wrong.
  -- A non-appointment reservation newly admitted by this bound is
  -- protected to its RAW end, which is at or before v_win_start, so it
  -- cannot overlap anything inside the window.
  v_res_win_start := v_win_start - make_interval(mins => v_buffer);

  -- PRECISION DOMAIN — JavaScript MILLISECONDS, by truncation, never rounding.
  --
  -- Postgres timestamptz keeps MICROseconds; a JS Date keeps milliseconds and
  -- truncates on parse (.123999 -> .123, verified against date_trunc, which
  -- truncates identically). A reservation boundary carrying microseconds would
  -- therefore make the SQL anchor .123456 while the page offers .123 — the page
  -- would offer a slot the command refused. Every boundary AND every candidate
  -- is normalised to milliseconds so both engines compare in one domain. This
  -- must be applied to the conflict boundaries too, not only to the final
  -- equality, or the overlap filter would still run in a different domain.

  -- (A) opening anchor + hourly fallback, walked in LOCAL minutes.
  v_m := v_open_min;
  while v_m + p_duration_minutes <= v_close_min loop
    v_cands := v_cands || date_trunc('milliseconds', public.public_booking_local_to_utc(
      p_local_date, make_time(v_m / 60, v_m % 60, 0), v_tz
    ));
    v_m := v_m + 60;
  end loop;

  -- (B) + (C) conflict-derived anchors, from millisecond-normalised boundaries.
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
            and c < date_trunc('milliseconds',
                      case when cr2.source_kind = 'appointment'
                           then cr2.ends_at + make_interval(mins => v_buffer)
                           else cr2.ends_at end)
            and (c + make_interval(mins => p_duration_minutes + v_buffer))
                  > date_trunc('milliseconds', cr2.starts_at)
       );
end;
$$;

revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from public;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from anon;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from authenticated;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from service_role;
grant execute on function public.public_booking_slot_candidates(uuid, date, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. public.public_reschedule_slot_candidates — forward redefinition
-- ---------------------------------------------------------------------------

create or replace function public.public_reschedule_slot_candidates(
  p_studio_id               uuid,
  p_local_date              date,
  p_duration_minutes        integer,
  p_original_appointment_id uuid,
  p_practitioner_id         uuid
)
returns setof timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz        text;
  v_buffer    integer;
  v_cap_flag  boolean;
  v_cap_on    boolean;
  v_is_open   boolean;
  v_open      time;
  v_close     time;
  v_open_min  integer;
  v_close_min integer;
  v_open_utc  timestamptz;
  v_close_utc timestamptz;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_res_win_start timestamptz;
  v_m         integer;
  v_cands     timestamptz[] := '{}';
  v_found     boolean;
  r           record;
begin
  select s.timezone,
         greatest(coalesce(s.buffer_minutes, 0), 0),
         coalesce(s.practitioner_capacity_enabled, false)
    into v_tz, v_buffer, v_cap_flag
    from public.studios s
   where s.id = p_studio_id;
  if not found then return; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then return; end if;

  -- `capacityOn` exactly as lib/booking/slots.ts:137-140 computes it: the studio
  -- flag AND an explicit practitioner. Either alone is the studio-wide branch.
  v_cap_on := v_cap_flag and p_practitioner_id is not null;

  -- Window: a date override beats the weekly default. When capacity is ON a
  -- practitioner-scoped row beats the studio-wide one AT EACH LEVEL — the
  -- loader probes practitioner-override, then studio-wide override, and only if
  -- neither exists falls through to the defaults in the same order
  -- (slots.ts:168-215). A studio-wide OVERRIDE therefore beats a
  -- practitioner-scoped DEFAULT, which is why this is two ordered probes per
  -- level and not one combined ordering.
  v_found := false;
  if v_cap_on then
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = p_local_date
       and o.practitioner_id = p_practitioner_id
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found then
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = p_local_date
       and o.practitioner_id is null
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found and v_cap_on then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = extract(dow from p_local_date)::integer
       and d.practitioner_id = p_practitioner_id
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = extract(dow from p_local_date)::integer
       and d.practitioner_id is null
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found then return; end if;

  if not coalesce(v_is_open, false) or v_open is null or v_close is null then
    return;
  end if;

  -- A full-day blockout suppresses the entire day (slots.ts:147-155 returns []).
  -- studio_blockouts has no practitioner_id, so this is studio-wide in both
  -- capacity modes, exactly as the loader treats it.
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= p_local_date
       and b.ends_on   >= p_local_date
  ) then
    return;
  end if;

  -- TRUNCATE TO HH:MM FIRST, on BOTH the local-minute walk bounds and the UTC
  -- filter bounds (see 0170's note: deriving them from different precisions is
  -- how a close_time of 17:00:45 admitted a start the page never offered).
  v_open      := date_trunc('minute', v_open);
  v_close     := date_trunc('minute', v_close);
  v_open_min  := extract(hour from v_open)::integer * 60 + extract(minute from v_open)::integer;
  v_close_min := extract(hour from v_close)::integer * 60 + extract(minute from v_close)::integer;
  v_open_utc  := public.public_booking_local_to_utc(p_local_date, v_open, v_tz);
  v_close_utc := public.public_booking_local_to_utc(p_local_date, v_close, v_tz);
  v_win_start := public.public_booking_local_to_utc(p_local_date, '00:00'::time, v_tz);
  v_win_end   := v_win_start + interval '36 hours';

  -- WAIT-v4 PR0. The reservation read opens ONE BUFFER EARLIER than the
  -- day, because `studio_calendar_reservations` stores an appointment's
  -- ACTUAL end and this function re-applies the buffer below to reach its
  -- PROTECTED end. Filtering on the actual end dropped exactly the row
  -- whose protected end reaches into the window: a 23:50 appointment under
  -- a 30-minute buffer is protected to 00:20, but `ends_at > v_win_start`
  -- is false, so local midnight was OFFERED while validate_* and 0152's
  -- enforce_appointment_buffer both REFUSED it. Reachable only by a studio
  -- whose open time falls within `buffer` minutes of local midnight.
  --
  -- v_win_end is deliberately untouched: only the lower bound was wrong.
  -- A non-appointment reservation newly admitted by this bound is
  -- protected to its RAW end, which is at or before v_win_start, so it
  -- cannot overlap anything inside the window.
  v_res_win_start := v_win_start - make_interval(mins => v_buffer);

  -- (A) opening anchor + hourly fallback, walked in LOCAL minutes.
  --     FALLBACK_GRANULARITY_MINUTES = 60 (lib/booking/slots.ts:115).
  v_m := v_open_min;
  while v_m + p_duration_minutes <= v_close_min loop
    v_cands := v_cands || date_trunc('milliseconds', public.public_booking_local_to_utc(
      p_local_date, make_time(v_m / 60, v_m % 60, 0), v_tz
    ));
    v_m := v_m + 60;
  end loop;

  -- (B) each conflict's SOURCE-AWARE protected end, and
  -- (C) conflict.starts_at - duration - buffer, the backward-packed anchor.
  --     Boundaries are millisecond-normalised BEFORE any arithmetic so both
  --     engines compare in one precision domain.
  for r in
    select date_trunc('milliseconds', cr.starts_at) as starts_at,
           date_trunc('milliseconds',
             case when cr.source_kind = 'appointment'
                  then cr.ends_at + make_interval(mins => v_buffer)
                  else cr.ends_at
             end) as protected_end
      from public.studio_calendar_reservations cr
     where (
             case when v_cap_on
                  then cr.resource_key = p_practitioner_id
                  else cr.studio_id    = p_studio_id
             end
           )
       and cr.starts_at < v_win_end
       and cr.ends_at   > v_res_win_start
       -- THE ORIGINAL'S OWN RESERVATION IS NOT A CONFLICT AGAINST ITSELF.
       -- (source_kind, source_id) is unique, so this drops exactly one row.
       and not (cr.source_kind = 'appointment'
                and p_original_appointment_id is not null
                and cr.source_id = p_original_appointment_id)
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
          where (
                  case when v_cap_on
                       then cr2.resource_key = p_practitioner_id
                       else cr2.studio_id    = p_studio_id
                  end
                )
            and cr2.starts_at < v_win_end
            and cr2.ends_at   > v_res_win_start
            and not (cr2.source_kind = 'appointment'
                     and p_original_appointment_id is not null
                     and cr2.source_id = p_original_appointment_id)
            and c < date_trunc('milliseconds',
                      case when cr2.source_kind = 'appointment'
                           then cr2.ends_at + make_interval(mins => v_buffer)
                           else cr2.ends_at end)
            and (c + make_interval(mins => p_duration_minutes + v_buffer))
                  > date_trunc('milliseconds', cr2.starts_at)
       );
end;
$$;

revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from public;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from anon;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from authenticated;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from service_role;
grant execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) to service_role;

commit;
