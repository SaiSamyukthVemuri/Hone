-- ---------------------------------------------------------------------------
-- 0170 — PUBLIC APPOINTMENT COMMAND (appointment boundary, PR 1)
-- ---------------------------------------------------------------------------
--
-- WHAT THIS CLOSES
--
-- The unauthenticated public booking route is the only appointment CREATOR that
-- still writes the row itself. Today `publicBookAppointmentAction` performs:
--
--     app/book/[slug]/actions.ts:770-792   admin.from("appointments").insert({...})
--     app/book/[slug]/actions.ts:875-881   admin.from("appointment_audit").insert({...})
--
-- Two statements, two transactions. The audit INSERT is 83 lines later and its
-- error is never inspected, so a confirmed public booking can exist with NO
-- audit row. Production carries exactly that: one appointment with zero
-- appointment_audit rows.
--
-- This migration adds ONE command that owns both halves in one transaction, and
-- derives every authoritative value from current database state instead of
-- trusting the caller.
--
-- WRITER CENSUS — public appointment creation
--   before: 1 direct INSERT (appointments) + 1 detached INSERT (appointment_audit)
--   after:  0 direct writers; public.create_public_appointment owns both
--
-- SCOPE — ADDITIVE ONLY. This migration creates five functions and nothing else.
-- It does NOT revoke any table grant, drop or create a policy, table, trigger or
-- index, backfill any row, or change any studio flag. `authenticated` keeps its
-- existing appointment DML for now; that revocation is a LATER PR and only after
-- every remaining writer has migrated.
--
-- SAFE TO APPLY BEFORE DEPLOY. All FIVE functions are new and reachable only by
-- `service_role`. Until the application caller ships, nothing calls them, so an
-- applied-but-undeployed state is inert. Deployment order is migration-first
-- (NEW app + OLD database returns 42883 and fails closed, with public booking
-- down for that window).
--
-- 25P01 — `supabase db push` does NOT wrap a file in a transaction, so a bare
-- `SET LOCAL` would emit 25P01 and never arm. This file opens its own
-- transaction and sets `lock_timeout` inside it. (`statement_timeout` is
-- deliberately not set: no migration in this repository sets it, and these are
-- two function definitions with no table rewrite.)
--
-- WHY A DEDICATED PUBLIC VALIDATOR, AND NOT THE SHARED ONE
--
-- `public.validate_appointment_availability` (0152) fences its practitioner
-- membership, service eligibility, full-day blockout and working-hours checks
-- inside `if v_cap then ... end if`, so for a studio with practitioner capacity
-- OFF it degenerates to a soft-buffer check alone. Every production studio that
-- takes public bookings runs capacity OFF, and the public slot loader is
-- unconditionally capacity-OFF regardless of the flag (it builds its StudioRow
-- without `practitioner_capacity_enabled` and passes no practitioner —
-- lib/booking/slots.ts:137-140, app/book/[slug]/actions.ts:492-503).
--
-- Extending the shared validator would silently change behaviour for
-- `create_internal_appointment_v2` and `move_or_reassign_appointment` at every
-- capacity-OFF studio, including the owner's deliberate outside-hours booking.
-- That is a large blast radius for a narrow PR, so this migration adds a
-- SEPARATE public validator and leaves every existing caller untouched.
--
-- PARITY WITH THE TYPESCRIPT SLOT ENGINE — the rules that matter
--
-- 1. THE COMMAND RE-DERIVES THE OFFER GRID AND REQUIRES EXACT MEMBERSHIP.
--    The offered set is NOT a lattice. It is {open} ∪ {open + 60m steps} ∪ {the
--    SOURCE-AWARE protected end of every conflict} ∪ {conflict.start − duration
--    − buffer} (lib/booking/slots.ts:115, 300-302, 310, 319).
--
--    An earlier revision of this migration validated only the broad rules —
--    horizon, hours, blockouts, overlap, buffer. That is NOT sufficient as the
--    authoritative boundary: a direct service-role call could submit 10:17 on an
--    open, conflict-free day and be accepted, even though the public page would
--    never offer 10:17. The application's own getAvailableSlots() re-check is
--    not the final authority and cannot be, because it runs before the studio
--    lock is taken.
--
--    public_booking_slot_candidates below therefore reproduces all three anchor
--    families and both filters, under the SAME studio lock the command holds, and
--    membership is required to millisecond precision. There is no
--    caller-supplied `p_slot_verified` escape hatch — the caller cannot assert
--    its own slot is valid.
--
-- 2. LOCAL -> UTC IS PORTED, NOT DELEGATED TO `AT TIME ZONE`.
--    Re-deriving the grid means generating candidates from LOCAL wall-clock
--    minutes, which is precisely the direction where the two engines diverge.
--    `utcInstantFromLocal` (lib/booking/tz.ts:42-68) and Postgres `AT TIME ZONE`
--    disagree by one hour on both DST edges: for a nonexistent local time TS
--    picks the earlier instant and Postgres shifts forward; for an ambiguous
--    local time TS picks the FIRST occurrence and Postgres picks the second.
--    public_booking_local_to_utc is a faithful port of the TS double-sampling
--    algorithm so the generated candidates match the offered ones on DST days.
--    Every UTC -> LOCAL projection (which IS unambiguous) still uses the native
--    `timestamptz AT TIME ZONE tz`.
--
-- 3. THE WINDOW IS CHECKED ON THE SERVICE END, NOT THE BUFFERED END.
--    lib/booking/slots.ts:324-327 fits `start + duration <= close` and states
--    that the trailing buffer MAY extend past close. Checking `ends_at + buffer`
--    here would reject the last slot of every day that the loader offers. This
--    matches `validate_appointment_availability`'s own `v_end_time > v_close`.
--
-- 4. COLLISIONS ARE READ FROM THE SAME SHADOW ROWS THE LOADER READS.
--    lib/booking/slots.ts:239-251 loads `studio_calendar_reservations` filtered
--    by `studio_id` on the capacity-OFF path — every resource_key in the studio.
--    `find_scoped_calendar_conflict` (0139) instead filters by
--    `resource_key = studio_id`, which is a strict SUBSET for any studio that
--    once ran capacity ON and retained practitioner-keyed rows. Using it would
--    accept slots the loader hides, so the overlap test below filters by
--    `studio_id` to match the loader exactly.
--    The protected end is source-aware, as in slots.ts:267-285: an appointment
--    is protected to `ends_at + buffer`; a timed block, recurring-break
--    occurrence or full-day blockout to its raw `ends_at`.
--
-- 5. RECURRING BREAKS ARE ENFORCED AS MATERIALISED, in both engines — the
--    loader never reads the rule table either, only the occurrences that reached
--    the shadow.
--
-- The GiST exclusions on `appointments` and `studio_calendar_reservations`, plus
-- the `HB001` soft-buffer trigger, remain the FINAL race-safe authority. This
-- command deliberately does NOT catch 23P01/HB001: the whole transaction rolls
-- back and the server adapter maps both to the same safe public copy, exactly as
-- app/book/[slug]/actions.ts:799-800 already does today.
--
-- Migration max 0169 -> 0170.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.public_booking_tz_offset_minutes / public_booking_local_to_utc
--
-- A FAITHFUL PORT of lib/booking/tz.ts:42-68 `utcInstantFromLocal`.
--
-- Postgres's native `timestamp AT TIME ZONE tz` cannot be used for the
-- LOCAL -> UTC direction here, because the two engines resolve DST edges
-- differently and the candidate grid below is generated in LOCAL wall-clock
-- minutes. Measured on this schema for America/Toronto:
--
--   nonexistent 2026-03-08 02:30 : Postgres -> 07:30Z (shifts forward)
--                                  TS       -> 06:30Z (one hour BEFORE)
--   ambiguous   2026-11-01 01:30 : Postgres -> 06:30Z (SECOND occurrence)
--                                  TS       -> 05:30Z (FIRST occurrence)
--
-- Using the native operator would therefore generate candidate instants an hour
-- away from the ones the page offered, and every submission on a DST boundary
-- day would be refused. This reproduces the TS double-sampling algorithm
-- exactly: treat the local string as UTC, correct by the offset sampled at that
-- naive instant, then RE-SAMPLE at the corrected instant and re-apply when the
-- two differ.
--
-- STABLE, not IMMUTABLE: `AT TIME ZONE <text>` depends on the tz database.
-- ---------------------------------------------------------------------------

create or replace function public.public_booking_tz_offset_minutes(
  p_instant timestamptz,
  p_tz      text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (extract(epoch from
            ((p_instant at time zone p_tz) - (p_instant at time zone 'UTC'))
          ) / 60)::integer;
$$;

comment on function public.public_booking_tz_offset_minutes(timestamptz, text) is
  'Signed UTC offset in minutes for an instant in a timezone. Port of tzOffsetMinutes (lib/booking/tz.ts).';

create or replace function public.public_booking_local_to_utc(
  p_local_date date,
  p_local_time time,
  p_tz         text
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_naive_utc timestamptz;
  v_off1      integer;
  v_off2      integer;
  v_corrected timestamptz;
begin
  -- First read: pretend the local wall clock is UTC.
  v_naive_utc := (p_local_date + p_local_time) at time zone 'UTC';
  v_off1      := public.public_booking_tz_offset_minutes(v_naive_utc, p_tz);
  v_corrected := v_naive_utc - make_interval(mins => v_off1);
  -- Re-sample: a single pass is wrong when the naive and corrected instants
  -- straddle a transition (the TS comment at tz.ts:49-59 documents exactly this).
  v_off2 := public.public_booking_tz_offset_minutes(v_corrected, p_tz);
  if v_off2 <> v_off1 then
    v_corrected := v_naive_utc - make_interval(mins => v_off2);
  end if;
  return v_corrected;
end;
$$;

comment on function public.public_booking_local_to_utc(date, time, text) is
  'Local wall clock -> UTC instant, matching lib/booking/tz.ts utcInstantFromLocal INCLUDING its DST edge conventions. Postgres AT TIME ZONE resolves those edges differently and must not be substituted.';

-- ---------------------------------------------------------------------------
-- 2. public.public_booking_slot_candidates
--
-- The exact candidate set the public slot loader would offer for a local date,
-- ported from lib/booking/slots.ts:236-340. The offered set is NOT a lattice —
-- re-deriving it is only safe because this reproduces all three anchor families
-- and both filters verbatim:
--
--   (A) the opening anchor plus an hourly fallback walk in LOCAL minutes.
--       FALLBACK_GRANULARITY_MINUTES = 60 (lib/booking/slots.ts:115) — NOT 15.
--       Generated per-step through public_booking_local_to_utc so a DST day
--       steps on the local clock exactly as the loader does.
--   (B) the SOURCE-AWARE protected end of every conflict: an appointment is
--       protected to ends_at + the CURRENT studio buffer; a timed block,
--       recurring-break occurrence or full-day blockout to its RAW ends_at.
--   (C) conflict.starts_at - duration - buffer, the backward-packed anchor.
--
-- Filters, matching slots.ts:326-335: start >= open, start + duration <= close
-- (the TRAILING BUFFER MAY SPILL PAST CLOSE), and the candidate's protected
-- interval [start, start + duration + buffer) must not overlap any conflict's
-- protected interval. Half-open on both sides; touching is allowed.
--
-- Reservations are loaded over the same [local-midnight, +36h) window and the
-- same studio-wide `studio_id` filter the public loader uses (slots.ts:239-251)
-- — the public surface is unconditionally capacity-OFF.
--
-- Returns the empty set for a closed day or a full-day blockout, exactly as the
-- loader returns [].
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
       and cr.ends_at   > v_win_start
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
            and cr2.ends_at   > v_win_start
            and c < date_trunc('milliseconds',
                      case when cr2.source_kind = 'appointment'
                           then cr2.ends_at + make_interval(mins => v_buffer)
                           else cr2.ends_at end)
            and (c + make_interval(mins => p_duration_minutes + v_buffer))
                  > date_trunc('milliseconds', cr2.starts_at)
       );
end;
$$;

comment on function public.public_booking_slot_candidates(uuid, date, integer) is
  'The exact set of public slot starts for a local date, ported from lib/booking/slots.ts (opening + hourly fallback anchors, source-aware post-conflict anchors, backward-packed pre-conflict anchors, window and overlap filters). Service-role only.';

-- ---------------------------------------------------------------------------
-- 3. public.validate_public_booking_slot

--
-- The public-surface availability contract, enforced identically in BOTH
-- capacity modes. Returns a closed result code; never raises, never leaks a row
-- identifier, and never reveals whether a neighbouring studio exists.
-- ---------------------------------------------------------------------------

create or replace function public.validate_public_booking_slot(
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_service_id      uuid,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz          text;
  v_buffer      integer;
  v_local_start timestamp;
  v_local_end   timestamp;
  v_local_date  date;
  v_end_date    date;
  v_dow         integer;
  v_start_time  time;
  v_end_time    time;
  v_is_open     boolean;
  v_open        time;
  v_close       time;
  v_found       boolean;
begin
  select s.timezone, greatest(coalesce(s.buffer_minutes, 0), 0)
    into v_tz, v_buffer
    from public.studios s
   where s.id = p_studio_id;
  if not found then
    return 'invalid_studio';
  end if;

  -- A NULL practitioner is legitimate here. Public booking attributes the
  -- appointment to the studio's active owner, but when a studio has no active
  -- owner the pre-0170 route inserted `practitioner_id: null` and SUCCEEDED
  -- (app/book/[slug]/actions.ts used `owner?.id ?? null`, and
  -- appointments_capacity_requires_practitioner permits NULL while
  -- capacity_enabled is false). Refusing here would take public booking down
  -- for such a studio while the page kept offering slots, so the membership and
  -- eligibility checks are skipped rather than failed when there is no
  -- practitioner to check them against.
  if p_practitioner_id is not null then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = p_practitioner_id
         and pr.studio_id = p_studio_id
         and pr.active = true
    ) then
      return 'invalid_practitioner';
    end if;

    -- Service eligibility is enforced only when the service HAS an eligibility
    -- list. A studio that has never configured `service_practitioners` keeps
    -- working; one that has (Willow does) has it honoured in both capacity modes.
    if p_service_id is not null
       and exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = p_service_id
       )
       and not exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = p_service_id
            and sp.practitioner_id = p_practitioner_id
       )
    then
      return 'not_eligible';
    end if;
  end if;

  -- Defensive: the command always passes ends_at > starts_at, but this function
  -- is independently grantable and its contract says it never raises. A
  -- non-positive interval would otherwise reach make_interval(mins => negative)
  -- in the membership check and raise 22000.
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    return 'invalid_time';
  end if;

  -- UTC -> local wall clock. This direction only (see header note 2).
  v_local_start := p_starts_at at time zone v_tz;
  v_local_end   := p_ends_at   at time zone v_tz;
  v_local_date  := v_local_start::date;
  v_end_date    := v_local_end::date;
  v_dow         := extract(dow from v_local_start)::int;
  v_start_time  := v_local_start::time;
  v_end_time    := v_local_end::time;

  -- Full-day blockout. Studio-wide by schema (studio_blockouts has no
  -- practitioner_id) and never bypassable on the public surface.
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= v_local_date
       and b.ends_on   >= v_local_date
  ) then
    return 'studio_closed';
  end if;

  -- Working-hours window: a date-specific override beats the weekly default.
  --
  -- STUDIO-WIDE ROWS ONLY (`practitioner_id is null`). This deliberately does
  -- NOT copy the shared validator's practitioner-beats-studio-wide precedence
  -- (0152:322-352). The public slot loader is unconditionally capacity-OFF and
  -- reads studio-wide rows only — getStudioWideOverrideDaySafe /
  -- getStudioWideDaySafe both filter `.is("practitioner_id", null)`
  -- (lib/booking/studio-wide-availability.ts:110,136).
  --
  -- Preferring a scoped row here would break real bookings: a studio that has
  -- ever had practitioner capacity ON can hold BOTH rows
  -- (studio_availability_default_scope_key is UNIQUE NULLS NOT DISTINCT on
  -- (studio_id, day_of_week, practitioner_id)), and those scoped rows are
  -- RETAINED across a capacity rollback by design. The page would offer the
  -- studio-wide window while the command refused every slot in it, forever.
  -- The readiness gate below uses the same studio-wide form, so both halves of
  -- this migration agree.
  v_found := false;
  select o.is_open, o.open_time, o.close_time
    into v_is_open, v_open, v_close
    from public.studio_availability_overrides o
   where o.studio_id = p_studio_id
     and o.effective_date = v_local_date
     and o.practitioner_id is null
   limit 1;
  if found then v_found := true; end if;

  if not v_found then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = v_dow
       and d.practitioner_id is null
     limit 1;
    if found then v_found := true; end if;
  end if;

  if not v_found or not coalesce(v_is_open, false) or v_open is null or v_close is null then
    return 'studio_closed';
  end if;

  -- A booking may not straddle local midnight.
  if v_end_date <> v_local_date then
    return 'outside_availability';
  end if;

  -- NOTE: the SERVICE end, not the buffered end (see header note 3).
  -- Same HH:MM truncation as the candidate generator (see its note): the window
  -- comparison must not be sensitive to seconds the loader never sees.
  v_open  := date_trunc('minute', v_open);
  v_close := date_trunc('minute', v_close);
  if v_start_time < v_open or v_end_time > v_close then
    return 'outside_availability';
  end if;

  -- Collisions, read from the same shadow rows the loader reads, filtered by
  -- studio_id to match it exactly (see header note 4). The candidate's own
  -- protected interval carries the trailing buffer, as in slots.ts:332-335;
  -- the conflict's protected end is source-aware.
  -- MILLISECOND DOMAIN on BOTH sides. Normalising only the membership equality
  -- while leaving this filter in Postgres's microsecond domain reintroduced the
  -- very mismatch it was meant to close: a reservation ending .456789 made the
  -- millisecond-normalised candidate .456 overlap it by 789 microseconds, so a
  -- slot the page offered came back 'time_unavailable'.
  if exists (
    select 1
      from public.studio_calendar_reservations r
     where r.studio_id = p_studio_id
       and tstzrange(
             date_trunc('milliseconds', p_starts_at),
             date_trunc('milliseconds', p_ends_at) + make_interval(mins => v_buffer),
             '[)'
           )
           && tstzrange(
             date_trunc('milliseconds', r.starts_at),
             date_trunc('milliseconds',
               case when r.source_kind = 'appointment'
                    then r.ends_at + make_interval(mins => v_buffer)
                    else r.ends_at
               end),
             '[)'
           )
  ) then
    return 'time_unavailable';
  end if;

  -- EXACT PUBLIC-SLOT MEMBERSHIP (see header rule 1). Everything above proves
  -- the interval is legal; this proves it is one the public page would actually
  -- OFFER. Without it a direct service-role call could book 10:17 on an open,
  -- conflict-free day. Millisecond precision, under the caller's studio lock.
  if not exists (
    select 1
      from public.public_booking_slot_candidates(
             p_studio_id,
             v_local_date,
             (extract(epoch from (p_ends_at - p_starts_at)) / 60)::integer
           ) c
     -- Both sides in the millisecond domain (see the generator's note). The
     -- candidates are already normalised; p_starts_at arrives from a JS ISO
     -- string and so is already millisecond-precise, but it is truncated here
     -- too so a direct caller cannot smuggle microseconds past the comparison.
     where c = date_trunc('milliseconds', p_starts_at)
  ) then
    return 'not_a_public_slot';
  end if;

  return 'ok';
end;
$$;

comment on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Public-surface availability contract. Enforces practitioner membership, service eligibility, full-day blockouts, the working-hours window and shadow-row collisions in BOTH capacity modes, unlike validate_appointment_availability which fences those checks behind practitioner capacity. RE-DERIVES the current public slot candidate set under the command''s lock protocol and requires exact millisecond-normalised membership. Service-role only.';

-- ---------------------------------------------------------------------------
-- 4. public.create_public_appointment
--
-- The single authoritative creator for unauthenticated public bookings. Writes
-- the appointment AND its mandatory appointment_audit row in one transaction.
--
-- The caller supplies only server-prepared identifiers. Duration, end time,
-- status, practitioner, capacity and buffer fields are all derived here. There
-- is no parameter that can request a custom duration, an owner-only
-- outside-hours override, a different status, or arbitrary audit JSON.
-- ---------------------------------------------------------------------------

create or replace function public.create_public_appointment(
  p_studio_id               uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text,
  p_notes                   text default null,
  p_referral_source         text default null
)
returns table (
  result           text,
  appointment_id   uuid,
  starts_at        timestamptz,
  ends_at          timestamptz,
  duration_minutes integer,
  practitioner_id  uuid,
  created_at       timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz          text;
  v_horizon     integer;
  v_now         timestamptz := now();
  v_service_dur integer;
  v_ends_at     timestamptz;
  v_owner_id    uuid;
  v_avail       text;
  v_appt_id     uuid;
  v_email       text;
  v_local_date  date;
  v_today       date;
  v_created_at  timestamptz;
  v_owner_count integer;
  v_win_start   timestamptz;
  v_win_end     timestamptz;
begin
  -- Lock order matches create_internal_appointment_v2 (0152:13-23): the studio
  -- row first, then the studio capacity advisory lock, then the service row.
  select s.timezone, coalesce(s.public_booking_horizon_months, 3)
    into v_tz, v_horizon
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  -- Public-booking readiness: at least one active service AND at least one open
  -- studio-wide weekly day. This mirrors isPubliclyBookable (lib/booking/
  -- readiness.ts:145-150) and adopts the STRICTER `practitioner_id is null`
  -- form the slot loader uses, so the gate cannot pass on a day the loader
  -- would refuse to build slots for.
  if not exists (
        select 1 from public.services sv
         where sv.studio_id = p_studio_id and sv.active = true
      )
     or not exists (
        select 1 from public.studio_availability_default d
         where d.studio_id = p_studio_id
           and d.practitioner_id is null
           and d.is_open = true
           and d.open_time is not null
           and d.close_time is not null
      )
  then
    return query select 'public_booking_unavailable'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Future instant. The loader's past-time filter lives in its CALLERS
  -- (lib/booking/slots.ts:34-53), so the command carries its own.
  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Booking horizon, in the studio's local calendar. DAYS_PER_HORIZON_MONTH is
  -- 31 in lib/booking/horizon.ts:28; both bounds are inclusive there.
  v_today      := (v_now at time zone v_tz)::date;
  v_local_date := (p_starts_at at time zone v_tz)::date;
  if v_local_date < v_today or v_local_date > (v_today + (v_horizon * 31)) then
    return query select 'outside_horizon'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Client must belong to this studio and must not be archived. A cross-studio
  -- id returns the SAME code as a missing one — no enumeration.
  select c.email into v_email
    from public.clients c
   where c.id = p_client_id
     and c.studio_id = p_studio_id
     and c.archived_at is null;
  if not found then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Duration is derived from the LOCKED service row. The caller cannot supply
  -- it, and cannot supply an end time.
  select sv.default_duration_minutes into v_service_dur
    from public.services sv
   where sv.id = p_service_id
     and sv.studio_id = p_studio_id
     and sv.active = true
   for update;
  if not found then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;
  if v_service_dur is null or v_service_dur <= 0 then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_service_dur);

  -- Practitioner assignment is SERVER-DERIVED. The public surface offers no
  -- practitioner selection and this command takes no practitioner parameter, so
  -- it cannot be asked to assign one.
  --
  -- EXACTLY ONE ACTIVE OWNER, OR NULL. The schema does not guarantee a single
  -- active owner per studio. An earlier revision used
  -- `order by created_at asc limit 1`, which silently invented a product rule
  -- ("the oldest active owner receives all public bookings") that nothing else
  -- in the system declares, and which would decide appointment attribution, the
  -- notification recipient and the client-facing practitioner name by row
  -- creation order.
  --
  -- The pre-0170 route used `.maybeSingle()`, which ERRORS on multiple rows and
  -- left `owner` null — i.e. it already treated ambiguity as "no practitioner".
  -- This reproduces that outcome deterministically without failing the booking:
  --   0 active owners -> NULL   (unchanged; a studio with no owner still books)
  --   1 active owner  -> that owner
  --   2+ active owners -> NULL  (ambiguous; no arbitrary winner is invented)
  select count(*) into v_owner_count
    from public.practitioners pr
   where pr.studio_id = p_studio_id
     and pr.active = true
     and pr.role = 'owner';
  if v_owner_count = 1 then
    select pr.id into v_owner_id
      from public.practitioners pr
     where pr.studio_id = p_studio_id
       and pr.active = true
       and pr.role = 'owner';
  else
    v_owner_id := null;
  end if;

  -- SERIALIZE AGAINST APPOINTMENT-SOURCE MUTATION (the candidate-set race).
  --
  -- Structural calendar writers (timed blocks, breaks, blockouts, availability)
  -- all take the studio capacity advisory lock this command already holds. The
  -- appointment LIFECYCLE writers do not: public_cancel_appointment_with_token,
  -- practitioner_cancel_appointment, mark_appointment_complete,
  -- mark_appointment_no_show and reschedule_appointment each lock only their own
  -- appointment row and never acquire the advisory lock at all.
  --
  -- That left a real race. A conflict-derived candidate exists only BECAUSE some
  -- appointment generates it: an appointment ending 14:00 with a 30-minute
  -- buffer is what makes 14:30 an offered start. If that appointment is
  -- cancelled after this command validated membership but before it inserted,
  -- 14:30 stops being a public candidate — and nothing else rejects it, because
  -- with the conflict gone there is no overlap for the GiST exclusion and no gap
  -- for HB001. The command would commit an appointment at a time the final
  -- candidate set does not offer.
  --
  -- So the appointment rows that can affect this candidate window are locked
  -- FOR UPDATE, in deterministic id order, BEFORE the candidate set is derived.
  -- A concurrent cancellation of one of them now blocks until this transaction
  -- commits; a cancellation that gets there first makes the candidate vanish and
  -- membership correctly refuses.
  --
  -- LOCK ORDER — studios -> advisory -> services -> appointments. This is the
  -- same order move_or_reassign_appointment uses (studios -> advisory -> appts),
  -- and NO path in the tree acquires the advisory lock AFTER an appointment row
  -- lock, so this introduces no cycle. Only the window's own sources are locked,
  -- never the whole table.
  v_win_start := public.public_booking_local_to_utc(v_local_date, '00:00'::time, v_tz);
  v_win_end   := v_win_start + interval '36 hours';
  perform 1
     from public.appointments a
    where a.studio_id = p_studio_id
      and a.status in ('confirmed', 'completed')
      and a.starts_at < v_win_end
      and a.ends_at   > v_win_start - make_interval(mins => 24 * 60)
    order by a.id
      for update;

  v_avail := public.validate_public_booking_slot(
    p_studio_id, v_owner_id, p_service_id, p_starts_at, v_ends_at
  );
  if v_avail <> 'ok' then
    return query select v_avail, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- The appointment. Status is a literal; capacity_enabled, buffer_minutes_
  -- snapshot, blocked_ends_at and sync_version are all trigger-derived, and
  -- booked_outside_availability is left at its FALSE default so the soft-buffer
  -- trigger (HB001) always arms. A 23P01 exclusion violation is deliberately not
  -- caught: it must roll the whole transaction back.
  -- Aliased as `a` because this function's RETURNS TABLE puts `created_at` (and
  -- the other output column names) in scope as PL/pgSQL variables; an unqualified
  -- RETURNING would be ambiguous.
  insert into public.appointments as a
    (studio_id, practitioner_id, client_id, service_id,
     starts_at, ends_at, duration_minutes, status,
     notes, cancellation_token_hash, referral_source)
  values
    (p_studio_id, v_owner_id, p_client_id, p_service_id,
     p_starts_at, v_ends_at, v_service_dur, 'confirmed',
     p_notes, p_cancellation_token_hash, p_referral_source)
  returning a.id, a.created_at into v_appt_id, v_created_at;

  -- The mandatory audit row, same transaction. Shape is byte-for-byte the one
  -- the route writes today (app/book/[slug]/actions.ts:875-881); the email is
  -- READ FROM the client row rather than accepted from the caller, so no PII
  -- crosses the command boundary and no arbitrary audit JSON can be injected.
  insert into public.appointment_audit
    (appointment_id, actor_type, actor_id, action, details)
  values
    (v_appt_id, 'client', null, 'created',
     jsonb_build_object(
       'source', 'public_booking',
       'email',  v_email,
       'notes',  p_notes
     ));

  return query select 'created'::text, v_appt_id, p_starts_at, v_ends_at,
                      v_service_dur, v_owner_id, v_created_at;
  return;
end;
$$;

comment on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) is
  'Atomic public booking: creates the appointment AND its mandatory appointment_audit row in one transaction. Derives duration, end time, status, practitioner (the active owner), capacity and buffer fields from database state; the caller cannot request a custom duration, an outside-hours override, a status, or arbitrary audit details. Service-role only.';

-- ---------------------------------------------------------------------------
-- 5. PRIVILEGES
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time, so all three are revoked BY NAME (plus
-- PUBLIC) before service_role is granted back. Missing one of these is how 0129
-- and 0164 each shipped a hole. Written as literal per-signature statements —
-- never a DO-block with format() — because the grant guards read them textually.
-- ---------------------------------------------------------------------------

revoke execute on function public.public_booking_tz_offset_minutes(timestamptz, text) from public;
revoke execute on function public.public_booking_tz_offset_minutes(timestamptz, text) from anon;
revoke execute on function public.public_booking_tz_offset_minutes(timestamptz, text) from authenticated;
revoke execute on function public.public_booking_tz_offset_minutes(timestamptz, text) from service_role;

revoke execute on function public.public_booking_local_to_utc(date, time, text) from public;
revoke execute on function public.public_booking_local_to_utc(date, time, text) from anon;
revoke execute on function public.public_booking_local_to_utc(date, time, text) from authenticated;
revoke execute on function public.public_booking_local_to_utc(date, time, text) from service_role;

revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from public;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from anon;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from authenticated;
revoke execute on function public.public_booking_slot_candidates(uuid, date, integer) from service_role;

revoke execute on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) from authenticated;
revoke execute on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) from service_role;

revoke execute on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) from public;
revoke execute on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) from anon;
revoke execute on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) from authenticated;
revoke execute on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) from service_role;

grant execute on function public.public_booking_tz_offset_minutes(timestamptz, text) to service_role;
grant execute on function public.public_booking_local_to_utc(date, time, text) to service_role;
grant execute on function public.public_booking_slot_candidates(uuid, date, integer) to service_role;
grant execute on function public.validate_public_booking_slot(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.create_public_appointment(uuid, uuid, uuid, timestamptz, text, text, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION (run manually; nothing below is executed)
-- ---------------------------------------------------------------------------
--
-- This migration creates FIVE functions. Verify every one of them.
--
-- -- 1. all five exist, are SECURITY DEFINER, pin an empty search_path, and
-- --    carry the exact identity arguments this migration granted.
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid) as identity_args,
--        p.prosecdef                               as security_definer,
--        array_to_string(p.proconfig, ',')         as config
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('public_booking_tz_offset_minutes',
--                      'public_booking_local_to_utc',
--                      'public_booking_slot_candidates',
--                      'validate_public_booking_slot',
--                      'create_public_appointment')
--  order by 1;
-- -- EXPECT 5 rows; security_definer = t; config = search_path="" for each; and
-- --   public_booking_tz_offset_minutes  timestamp with time zone, text
-- --   public_booking_local_to_utc       date, time without time zone, text
-- --   public_booking_slot_candidates    uuid, date, integer
-- --   validate_public_booking_slot      uuid, uuid, uuid, timestamp with time zone, timestamp with time zone
-- --   create_public_appointment         uuid, uuid, uuid, timestamp with time zone, text, text, text
--
-- -- 2. EXECUTE reaches service_role ONLY, for all five.
-- select p.proname, r.rolname,
--        has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   cross join pg_roles r
--  where n.nspname = 'public'
--    and p.proname in ('public_booking_tz_offset_minutes',
--                      'public_booking_local_to_utc',
--                      'public_booking_slot_candidates',
--                      'validate_public_booking_slot',
--                      'create_public_appointment')
--    and r.rolname in ('anon', 'authenticated', 'service_role')
--  order by 1, 2;
-- -- EXPECT 15 rows: anon = f and authenticated = f everywhere,
-- --                 service_role = t everywhere.
--
-- -- 3. appointment table grants are UNCHANGED by this migration.
-- select r.rolname,
--        has_table_privilege(r.oid, 'public.appointments', 'INSERT') as ins,
--        has_table_privilege(r.oid, 'public.appointments', 'UPDATE') as upd,
--        has_table_privilege(r.oid, 'public.appointments', 'DELETE') as del
--   from pg_roles r where r.rolname in ('anon', 'authenticated');
-- -- EXPECT both roles still TRUE on all three. This migration revokes NOTHING;
-- -- the appointment DML revocation is a LATER PR.
-- ---------------------------------------------------------------------------
