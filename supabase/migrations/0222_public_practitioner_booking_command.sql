-- ===========================================================================
-- 0222 — G1 write side: practitioner-aware public booking (#824)
-- ===========================================================================
-- 0219 added the READ side: public_booking_practitioner_options (the picker)
-- and public_booking_slot_candidates_for_practitioner (that practitioner's real
-- availability). This adds the WRITE side, so a client's choice is honoured
-- rather than offered and then discarded.
--
-- WHY A PRACTITIONER PARAMETER IS NOT PRACTITIONER SELECTION. An earlier
-- revision of this migration added p_practitioner_id to the command and stopped
-- there. It was wrong, and its own test caught it: two clients choosing two
-- DIFFERENT practitioners for the SAME instant got 'time_unavailable' — exactly
-- the five-practitioner case the feature exists for. The reason is that
-- validate_public_booking_slot is STUDIO-WIDE BY CONSTRUCTION in two places,
-- each documented in 0170:
--   * its collision filter reads studio_calendar_reservations "filtered by
--     studio_id to match [the loader] exactly";
--   * its final gate is EXACT MEMBERSHIP in public_booking_slot_candidates —
--     "this proves it is one the public page would actually OFFER" — and that
--     loader is unconditionally studio-wide.
-- Both were correct while the only loader was studio-wide. 0219 added a scoped
-- loader, so the validator had to move with it or the page and the command
-- would disagree — the very failure 0170's comment guards against, in the
-- other direction.
--
-- THIS MIGRATION THEREFORE ADDS TWO FUNCTIONS:
--
-- 1. validate_public_booking_slot_v2 — 0170's validator with exactly three
--    changes, each pinned by test:
--      (1) COLLISION SCOPE: the capacity-aware resource predicate from
--          find_scoped_calendar_conflict (0139:124-130) — studio-wide when
--          capacity is off, the named practitioner's resource_key when on;
--      (2) WINDOW: a practitioner-scoped availability row beats the studio-wide
--          row (0152's precedence) BUT ONLY WHILE CAPACITY IS ON. Scoped rows
--          are RETAINED ACROSS A CAPACITY ROLLBACK BY DESIGN, so an
--          unconditional preference would let a stale row decide a
--          capacity-OFF studio's public window "forever" (0170's words). Same
--          gate 0219 carries.
--      (3) MEMBERSHIP GATE: reads
--          public_booking_slot_candidates_for_practitioner, so the command
--          accepts exactly what the page offered.
--
-- 2. create_public_appointment_v2 — 0170's command carried VERBATIM with a
--    trailing p_practitioner_id uuid default null, a two-path assignment block,
--    and the availability authority routed by that parameter.
--
-- WHAT IS DELIBERATELY NOT CHANGED, because it is a SHARED studio constraint
-- that genuinely applies to everyone:
--   * STUDIO BLOCKOUTS stay studio-wide. studio_blockouts has no practitioner
--     column — it is studio-wide by schema — so a full-day blockout closes the
--     day for every practitioner, and a scoped booking must not escape it.
--   * The public-booking READINESS gate (an active service AND an open
--     studio-wide window), the booking HORIZON, the studio TIMEZONE and BUFFER,
--     the no-straddling-local-midnight rule, the client-belongs-to-studio and
--     service checks, the millisecond precision domain, the appointment-row
--     FOR UPDATE serialisation and the mandatory audit row are all unchanged.
--   * The service_practitioners allow-list was ALREADY practitioner-aware in
--     0170 and is untouched.
--
-- p_practitioner_id => NULL REPRODUCES 0170 EXACTLY: the legacy owner-count
-- derivation runs verbatim AND the legacy validator is called, so an existing
-- public booking is validated by precisely the authority it is validated by
-- today. That is what makes adopting v2 safe before any UI changes.
--
-- 0170's create_public_appointment AND validate_public_booking_slot ARE LEFT IN
-- PLACE AND UNCHANGED. Nothing live changes until a separate application change
-- points the route at v2. This migration is additive and inert on its own.
--
-- RECEPTIONISTS CANNOT BE BOOKED, twice over: the role filter excludes them and
-- a receptionist is not a practitioners row at all (studio_receptionists,
-- 0216:47). Denied by construction.
--
-- GRANTS. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
-- authenticated AND service_role at create time, so all four are revoked BY
-- NAME before EXECUTE is granted to service_role only — the posture of
-- 0170:950-963 for both of these functions. The public route reaches them
-- through the server's service-role client, never from the browser.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) The practitioner-scoped validator.
-- ---------------------------------------------------------------------------
create or replace function public.validate_public_booking_slot_v2(
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
  v_cap_on      boolean;
begin
  -- THE SCOPED VALIDATOR REQUIRES A PRACTITIONER. A NULL practitioner is a
  -- legitimate public booking (0170's own note), but it is the LEGACY shape and
  -- its authority is the legacy validator. create_public_appointment_v2 routes
  -- NULL there, so reaching this function without one is a caller error.
  if p_practitioner_id is null then
    return 'invalid_practitioner';
  end if;

  select s.timezone, greatest(coalesce(s.buffer_minutes, 0), 0)
    into v_tz, v_buffer
    from public.studios s
   where s.id = p_studio_id;
  if not found then
    return 'invalid_studio';
  end if;

  -- ONE capacity read, used by BOTH the window source and the conflict scope
  -- below, so the two cannot disagree with each other.
  --
  -- NOT OPTIONAL, and a missing assignment is silent: with v_cap_on left NULL,
  -- `if v_cap_on then` takes the capacity-OFF branch while
  -- `case when not v_cap_on ...` falls through to the practitioner arm — so the
  -- window and the conflict scope would describe DIFFERENT resources, and the
  -- function would still appear to work because the scoped candidate loader
  -- computes its own flag correctly and compensates. The source-contract test
  -- asserts this call exists for exactly that reason.
  v_cap_on := public.studio_capacity_enabled(p_studio_id);

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

  -- EXACT MILLISECOND PRECISION IS REQUIRED — sub-millisecond input is REJECTED,
  -- not truncated.
  --
  -- Public booking is a browser surface and a JS ISO timestamp is always
  -- millisecond-precise, so there is no legitimate microsecond input here.
  -- Truncating for the comparison alone would let a direct service-role caller
  -- match a legitimate candidate with a value that is NOT that candidate — and
  -- this function is independently grantable, so it must not claim a
  -- sub-millisecond interval is a valid public interval.
  if p_starts_at is distinct from date_trunc('milliseconds', p_starts_at)
     or p_ends_at is distinct from date_trunc('milliseconds', p_ends_at)
  then
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
  -- WINDOW — CHANGE 2 of 3. A practitioner-scoped row beats the studio-wide
  -- row (0152's precedence), but ONLY WHILE CAPACITY IS ON.
  --
  -- 0170's validator reads studio-wide rows ONLY and explains why: a studio
  -- that has ever had capacity ON can hold BOTH rows
  -- (studio_availability_default_scope_key is UNIQUE NULLS NOT DISTINCT), and
  -- the scoped rows are RETAINED ACROSS A CAPACITY ROLLBACK BY DESIGN.
  -- Preferring one unconditionally lets a stale row from a past capacity-ON
  -- period decide a capacity-OFF studio's public window, so "the page would
  -- offer the studio-wide window while the command refused every slot in it,
  -- forever". The gate is what makes a scoped preference safe rather than that
  -- hazard, and it is the same gate 0219 carries.
  v_found := false;
  if v_cap_on then
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = v_local_date
       and (o.practitioner_id = p_practitioner_id or o.practitioner_id is null)
     order by (o.practitioner_id is not null) desc
     limit 1;
  else
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = v_local_date
       and o.practitioner_id is null
     limit 1;
  end if;
  if found then v_found := true; end if;

  if not v_found then
    if v_cap_on then
      select d.is_open, d.open_time, d.close_time
        into v_is_open, v_open, v_close
        from public.studio_availability_default d
       where d.studio_id = p_studio_id
         and d.day_of_week = v_dow
         and (d.practitioner_id = p_practitioner_id or d.practitioner_id is null)
       order by (d.practitioner_id is not null) desc
       limit 1;
    else
      select d.is_open, d.open_time, d.close_time
        into v_is_open, v_open, v_close
        from public.studio_availability_default d
       where d.studio_id = p_studio_id
         and d.day_of_week = v_dow
         and d.practitioner_id is null
       limit 1;
    end if;
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
       -- CHANGE 1 of 3. 0170's filter is `studio_id` only, deliberately, "to
       -- match [the loader] exactly" while that loader is studio-wide. 0219
       -- made a practitioner-scoped loader, so this validator must move with
       -- it or the page and the command disagree — which is the very failure
       -- 0170's comment was guarding against, just in the other direction.
       -- Predicate copied from find_scoped_calendar_conflict (0139:124-130):
       -- studio-wide when capacity is off, the named practitioner's key when on.
       --
       -- A TRAP, found while mutation-testing this change. Writing
       -- `resource_key = p_studio_id` under capacity-ON looks like a scoped
       -- predicate and is in fact VACUOUS: when capacity is on, NO reservation
       -- is keyed to the studio, so the filter matches nothing and this whole
       -- conflict check FAILS OPEN. The booking is then refused only by the
       -- membership gate below. Both arms of the case must therefore name the
       -- resource that actually holds the rows in that mode — which is the
       -- studio when capacity is off, and the practitioner when it is on.
       and (case
              when not v_cap_on then r.resource_key = p_studio_id
              else r.resource_key = p_practitioner_id
            end)
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
      -- CHANGE 3 of 3. The membership gate is what makes "it is a slot the
      -- page would actually OFFER" true, so it must read the SAME candidate
      -- set the page read. For a chosen practitioner that is 0219's scoped
      -- loader, not the studio-wide one; pointing it at the studio-wide set
      -- would refuse every parallel slot the page correctly offered.
      from public.public_booking_slot_candidates_for_practitioner(
             p_studio_id,
             v_local_date,
             (extract(epoch from (p_ends_at - p_starts_at)) / 60)::integer,
             p_practitioner_id
           ) c
     -- Both sides are already in the millisecond domain: the candidates are
     -- generated normalised, and p_starts_at was REJECTED above if it carried a
     -- sub-millisecond remainder. A plain equality is therefore exact — this is
     -- deliberately NOT a truncating comparison, because truncating here while
     -- persisting the raw value elsewhere is precisely the gap that let a
     -- microsecond-bearing input match a candidate it was not equal to.
     where c = p_starts_at
  ) then
    return 'not_a_public_slot';
  end if;

  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- (2) The practitioner-aware command.
-- ---------------------------------------------------------------------------
create or replace function public.create_public_appointment_v2(
  p_studio_id               uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text,
  p_notes                   text default null,
  p_referral_source         text default null,
  -- G1. NULL preserves the pre-0222 behaviour EXACTLY: assignment is derived
  -- from the active-owner count. Non-NULL is a client's chosen practitioner,
  -- validated below before it is trusted.
  p_practitioner_id         uuid default null
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
  v_starts_at   timestamptz;
  v_ends_at     timestamptz;
  v_owner_id    uuid;
  v_avail       text;
  v_appt_id     uuid;
  v_email       text;
  v_local_date  date;
  v_today       date;
  v_created_at  timestamptz;
  v_booking_on  boolean;
  v_win_start   timestamptz;
  v_win_end     timestamptz;
begin
  -- Lock order matches create_internal_appointment_v2 (0152:13-23): the studio
  -- row first, then the studio capacity advisory lock, then the service row.
  -- G1 / CODEX P1 — THE KILL SWITCH IS READ IN THE LOCKING SELECT ITSELF.
  --
  -- `practitioner_capacity_booking_enabled` (0136) is the operator's control
  -- over whether the PUBLIC path may assign a practitioner. The application
  -- also checks it, and an application check CANNOT close this race: an
  -- operator disabling the switch after the TypeScript read but before this
  -- RPC wins the row lock would leave the booking accepted. Reading it HERE,
  -- in the same `for update` that takes the studio row lock, means the value
  -- used is the one committed as of this transaction's lock acquisition and it
  -- cannot change while the transaction lives.
  select s.timezone, coalesce(s.public_booking_horizon_months, 3),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_tz, v_horizon, v_booking_on
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

  -- ONE AUTHORITATIVE START VALUE, ESTABLISHED HERE AND USED END TO END.
  --
  -- Public booking accepts ONLY JavaScript-millisecond timestamps. A browser ISO
  -- string is always millisecond-precise, so a sub-millisecond remainder can
  -- only come from a direct service-role caller — and it is REJECTED, never
  -- silently truncated.
  --
  -- An earlier revision truncated inside the membership comparison but then
  -- derived, persisted and returned the RAW p_starts_at. That split validation
  -- and persistence into two precision domains: `...123999Z` matched the
  -- legitimate `...123000Z` candidate and was then stored as `...123999Z` — an
  -- instant the browser never offered. Rejecting up front makes the value that
  -- passed membership the exact value that is derived from, persisted and
  -- returned.
  if p_starts_at is null
     or p_starts_at is distinct from date_trunc('milliseconds', p_starts_at)
  then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;
  v_starts_at := p_starts_at;

  -- Future instant. The loader's past-time filter lives in its CALLERS
  -- (lib/booking/slots.ts:34-53), so the command carries its own.
  if v_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz,
                        null::timestamptz, null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Booking horizon, in the studio's local calendar. DAYS_PER_HORIZON_MONTH is
  -- 31 in lib/booking/horizon.ts:28; both bounds are inclusive there.
  v_today      := (v_now at time zone v_tz)::date;
  v_local_date := (v_starts_at at time zone v_tz)::date;
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

  -- Derived from the AUTHORITATIVE start, so the end inherits its exact
  -- millisecond precision.
  v_ends_at := v_starts_at + make_interval(mins => v_service_dur);

  -- =====================================================================
  -- PRACTITIONER ASSIGNMENT — two paths. The legacy one is preserved VERBATIM.
  -- =====================================================================
  if p_practitioner_id is not null then
    -- THE SWITCH, FIRST, AND UNDER THE LOCK TAKEN AT THE TOP. A disabled
    -- studio may not receive a practitioner-scoped booking at all, so this
    -- precedes every other practitioner check: there is nothing to validate
    -- about an assignment that is not permitted. Refusing rather than silently
    -- dropping to "any available" is deliberate -- a caller that named a
    -- practitioner must not be told the booking succeeded as something else.
    if not v_booking_on then
      return query select 'practitioner_assignment_disabled'::text,
                          null::uuid, null::timestamptz,
                          null::timestamptz, null::integer, null::uuid, null::timestamptz;
      return;
    end if;

    -- CHOSEN BY THE CLIENT. Validated before it is trusted: it must be THIS
    -- studio's, active, and a treating role. A receptionist cannot reach here
    -- twice over — the role filter excludes it, and a receptionist is not a
    -- `practitioners` row at all (`studio_receptionists`, 0216:47).
    --
    -- Read inside this transaction, which already holds the studio row lock
    -- taken at the top, so a concurrent deactivation cannot slip between this
    -- check and the insert.
    if not exists (
      select 1
        from public.practitioners pr
       where pr.id = p_practitioner_id
         and pr.studio_id = p_studio_id
         and pr.active
         and pr.role in ('owner', 'practitioner')
    ) then
      return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz,
                          null::timestamptz, null::integer, null::uuid, null::timestamptz;
      return;
    end if;
    v_owner_id := p_practitioner_id;
  else
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
    --
    -- ONE STATEMENT, ONE SNAPSHOT. A previous revision counted the active owners
    -- and then re-selected the id in a SECOND statement. Under READ COMMITTED each
    -- statement takes a fresh snapshot, so a concurrent activation/insert/promotion
    -- committing between them could leave the count seeing 1 while the lookup saw
    -- 2 — and a non-STRICT `select ... into` then assigns one unspecified row,
    -- recreating exactly the arbitrary assignment this rule exists to prevent.
    --
    -- `limit 2` is sufficient: the decision only distinguishes zero, one and
    -- more-than-one. The `order by pr.id` is for deterministic materialisation
    -- ONLY — it never picks a winner, because two rows always resolve to NULL.
    with active_owners as materialized (
      select pr.id
        from public.practitioners pr
       where pr.studio_id = p_studio_id
         and pr.active = true
         and pr.role = 'owner'
       order by pr.id
       limit 2
    )
    -- `(array_agg(id))[1]` rather than `min(id)`: uuid has no min/max aggregate in
    -- Postgres. It is only ever read when count(*) = 1, so the array holds exactly
    -- one element and no ordering decides anything.
    select case when count(*) = 1 then (array_agg(id))[1] else null end
      into v_owner_id
      from active_owners;
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

  -- ROUTE THE AVAILABILITY AUTHORITY BY WHETHER A PRACTITIONER WAS CHOSEN.
  --
  -- This is the difference between a practitioner parameter and practitioner
  -- SELECTION. An earlier revision of this command passed the practitioner and
  -- still called the legacy validator; because that validator is studio-wide by
  -- construction, two clients choosing two different practitioners for the same
  -- instant got 'time_unavailable' — precisely the five-practitioner case the
  -- feature exists for. A parameter alone is not selection.
  --
  -- NULL keeps the LEGACY validator, verbatim, so an existing public booking is
  -- validated by exactly the authority it is validated by today.
  if p_practitioner_id is not null then
    v_avail := public.validate_public_booking_slot_v2(
      p_studio_id, v_owner_id, p_service_id, v_starts_at, v_ends_at
    );
  else
    v_avail := public.validate_public_booking_slot(
      p_studio_id, v_owner_id, p_service_id, v_starts_at, v_ends_at
    );
  end if;
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
     v_starts_at, v_ends_at, v_service_dur, 'confirmed',
     p_notes, p_cancellation_token_hash, p_referral_source)
  returning a.id, a.created_at into v_appt_id, v_created_at;

  -- The mandatory audit row, same transaction. Shape is byte-for-byte the one
  -- the route writes today (app/book/[slug]/actions.ts:875-881); the email is
  -- READ FROM the client row rather than accepted from the caller, so no PII
  -- crosses the command boundary and no arbitrary audit JSON can be injected.
  -- AUDIT, through the SHARED HELPER rather than an inlined INSERT.
  --
  -- This is the one place v2 deliberately departs from carrying 0170 verbatim,
  -- and it is a deviation TOWARDS this schema's own convention.
  -- tests/db/appointment-audit-invariant.db.test.ts PINS the exact set of
  -- functions that insert into appointment_audit, and an inlined INSERT here
  -- would make v2 a NINTH writer. That guard exists because appointment_audit
  -- is append-only history: growing the writer census must be a conscious act,
  -- and it caught this.
  --
  -- The repair commands of 0173 already took this route, and that file records
  -- why: "a future audit change has one insertion point to migrate, and this
  -- list stays legible". write_appointment_audit is a pure pass-through insert
  -- of exactly these five columns, so THE ROW IS IDENTICAL — same
  -- appointment_id, actor_type 'client', null actor_id, action 'created' and
  -- the same details object. studio_id is trigger-derived in both shapes.
  perform public.write_appointment_audit(
    v_appt_id,
    'client',
    null,
    'created',
    jsonb_build_object(
      'source', 'public_booking',
      'email',  v_email,
      'notes',  p_notes
    )
  );

  return query select 'created'::text, v_appt_id, v_starts_at, v_ends_at,
                      v_service_dur, v_owner_id, v_created_at;
  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS — revoke from all four roles BY NAME, then service_role only.
-- ---------------------------------------------------------------------------
revoke execute on function public.validate_public_booking_slot_v2(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function public.validate_public_booking_slot_v2(uuid, uuid, uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.validate_public_booking_slot_v2(uuid, uuid, uuid, timestamptz, timestamptz) from authenticated;
revoke execute on function public.validate_public_booking_slot_v2(uuid, uuid, uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.validate_public_booking_slot_v2(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;

revoke execute on function public.create_public_appointment_v2(uuid, uuid, uuid, timestamptz, text, text, text, uuid) from public;
revoke execute on function public.create_public_appointment_v2(uuid, uuid, uuid, timestamptz, text, text, text, uuid) from anon;
revoke execute on function public.create_public_appointment_v2(uuid, uuid, uuid, timestamptz, text, text, text, uuid) from authenticated;
revoke execute on function public.create_public_appointment_v2(uuid, uuid, uuid, timestamptz, text, text, text, uuid) from service_role;
grant execute on function public.create_public_appointment_v2(uuid, uuid, uuid, timestamptz, text, text, text, uuid) to service_role;

commit;
