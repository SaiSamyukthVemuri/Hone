-- ---------------------------------------------------------------------------
-- 0171 — PUBLIC RESCHEDULE COMMAND v2 (appointment boundary, PR 2)
-- ---------------------------------------------------------------------------
--
-- WHAT THIS CLOSES
--
-- `public.reschedule_appointment` (0029, last touched by 0091) is the only
-- remaining appointment mutation on a public surface that trusts the caller for
-- authoritative values. Its effective deployed body:
--
--   * accepts p_new_ends_at AND p_new_duration_minutes from the caller;
--   * validates only `new_starts_at > now()` and `new_ends_at > new_starts_at`;
--   * performs NO booking-horizon check;
--   * performs NO availability-window check;
--   * performs NO full-day blockout check;
--   * performs NO exact public-slot membership check;
--   * performs NO source-aware buffer validation of its own;
--   * never excludes the original's own reservation when judging a replacement;
--   * copies only studio/practitioner/client/service/notes to the successor
--     (referral_source is silently DROPPED);
--   * never sets rescheduled_from_appointment_id, rescheduled_to_appointment_id
--     or cancellation_kind;
--   * leaves the policy acknowledgement to a SEPARATE post-commit statement in
--     the route, whose failure is logged and swallowed;
--   * returns only the new appointment id, forcing the route to re-SELECT the
--     successor after commit — and that re-read currently returns {ok:false} to
--     the visitor even though the reschedule already committed, permanently
--     losing the raw successor token that only the confirmation email carries.
--
-- Two of those omissions are not merely missing validation, they are ACTIVE
-- defects against already-deployed logic:
--
--   1. cancellation_kind. `enqueue_calendar_outbound` returns early on a
--      cancellation whose `cancellation_kind = 'rescheduled'`. The legacy RPC
--      never sets it, so with Google outbound intent ON a reschedule enqueues an
--      event.delete for the original AND an event.create for the successor —
--      a destroy/recreate pair for what is one moved appointment.
--   2. rescheduled_from_appointment_id. The same trigger REBINDS the
--      predecessor's calendar_event_links row to the successor when that column
--      is set on INSERT, preserving the provider event identity. The legacy RPC
--      never sets it, so the rebind never fires.
--
-- The dormant Google transition logic is therefore already correct and already
-- deployed; it has simply never been reachable, because nothing writes the
-- lineage it keys on. This migration writes it.
--
-- WRITER CENSUS — public reschedule
--   before: 1 caller-trusting RPC + 1 detached policy-acknowledgement INSERT
--           + 1 post-commit successor SELECT the public result depends on
--   after:  0 detached writers; public.reschedule_appointment_v2 owns the
--           cancellation, the successor, both audits, both lineage directions
--           and the acknowledgement in ONE transaction, and returns enough
--           authoritative state that no post-commit read can fail the result.
--
-- SCOPE — ADDITIVE ONLY. This migration creates three functions and nothing else.
-- It does NOT revoke any table grant, drop or create a policy, table, trigger or
-- index, backfill any row, or change any studio flag. `authenticated` keeps its
-- existing appointment DML; that revocation is a LATER PR.
--
-- THE LEGACY RPC IS DELIBERATELY LEFT IN PLACE.
-- `public.reschedule_appointment` is NOT dropped, NOT re-signed and NOT revoked
-- here. Migration-first deployment means this file can be applied while the
-- CURRENTLY deployed application is still calling the legacy function; removing
-- it would take public rescheduling down for that window. The public route
-- migrates to v2 in this PR. Retirement of the legacy service-role-only RPC is a
-- later cleanup migration, after the production deployment of this PR is proven.
--
-- SAFE TO APPLY BEFORE DEPLOY. All three functions are new and reachable only by
-- `service_role`. Until the application caller ships, nothing calls them, so an
-- applied-but-undeployed state is inert.
--
-- 25P01 — `supabase db push` does NOT wrap a file in a transaction, so a bare
-- `SET LOCAL` would emit 25P01 and never arm. This file opens its own
-- transaction and sets `lock_timeout` inside it.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND CANDIDATE GENERATOR, AND NOT 0170's
--
-- `public_booking_slot_candidates` (0170) is unconditionally capacity-OFF and
-- has no concept of an appointment being moved. Rescheduling needs two things it
-- cannot express:
--
--   * ORIGINAL-RESERVATION EXCLUSION. The appointment being moved owns a
--     `studio_calendar_reservations` row. Counting it as a conflict hides
--     otherwise valid moves (including every slot adjacent to the original) and
--     does not model the final transaction, in which the original is cancelled
--     — and its reservation deleted by
--     `sync_appointment_to_calendar_reservation` — BEFORE the successor is
--     inserted. The TypeScript loader already supports exactly this exclusion
--     (`ReservationExclusion`, lib/booking/slots.ts:98-101, applied at :270-277);
--     the public reschedule surfaces simply never passed it. This PR passes it
--     on both sides.
--
--   * CAPACITY MODE. Public BOOKING is capacity-OFF by construction: its callers
--     build the StudioRow without `practitioner_capacity_enabled` and pass no
--     practitioner. Public RESCHEDULE preserves the original's practitioner, so
--     when the studio runs capacity ON the loader's capacity-ON branch is
--     reachable — practitioner-scoped availability beats studio-wide, and
--     reservations are filtered by `resource_key = practitioner` rather than by
--     `studio_id` (lib/booking/slots.ts:137-140, 168-229, 249-251).
--
-- Editing 0170 is forbidden (it is applied and frozen), and widening its helper
-- would silently change the public BOOKING boundary. So this migration adds a
-- sibling that reuses 0170's reviewed timezone helpers — there is deliberately
-- NO third DST implementation — and differs only in those two dimensions.
--
-- THE FOUR SLOT-PARITY RULES still hold and are reproduced here:
--   1. all four anchor families, exact millisecond membership;
--   2. LOCAL -> UTC is ported (public_booking_local_to_utc), never AT TIME ZONE;
--   3. the window is checked on the SERVICE end; the trailing buffer MAY spill
--      past close;
--   4. the shadow is filtered exactly as the loader filters it — by `studio_id`
--      when capacity is OFF, by `resource_key` when it is ON.
--
-- ---------------------------------------------------------------------------
-- WHY THE POLICY HASH IS RE-DERIVED, NOT TRUSTED
--
-- `p_acknowledged_policy = true` alone proves only that a checkbox was ticked,
-- not WHAT was ticked. A studio can edit `cancellation_policy_text` between the
-- page render and the submit, and the legacy flow would then record acceptance
-- of text the visitor never saw — as legal evidence, that is worse than no row.
--
-- So the page hashes the policy snapshot it actually rendered and posts that
-- hash back as a server-generated hidden field; the command independently loads
-- the CURRENT policy text, derives the current hash, and compares. A mismatch is
-- `policy_changed` and mutates nothing. The policy TEXT is never accepted as
-- mutation input from the caller — only the hash of what was displayed.
--
-- The canonical snapshot is byte-identical to buildPolicySnapshot()
-- (lib/booking/policy-acknowledgement.ts:61-75):
--
--     coalesce(cancellation_policy_text, '') || E'\n---\n' ||
--     coalesce(no_show_policy_text, '')
--
-- hashed as lowercase SHA-256 hex. NOTE the asymmetry, which is deliberate and
-- must be preserved: the REQUIREMENT predicate (`hasAnyPolicy`) TRIMS before
-- testing for emptiness, so a whitespace-only policy requires no
-- acknowledgement; the SNAPSHOT does NOT trim, so the stored evidence is the
-- exact column content. Trimming in one place and not the other is the whole
-- point — trimming the snapshot would make the stored evidence differ from what
-- was displayed.
--
-- `extensions.digest` is schema-qualified per the repository's extension policy
-- (pgcrypto lives in `extensions`; same call shape as 0079, 0090, 0119, 0120).
-- `encode` is a pg_catalog builtin and resolves under `search_path = ''`.
--
-- ---------------------------------------------------------------------------
-- FINANCIAL SAFETY — FAIL CLOSED, NEVER TRANSFER
--
-- Replacing appointment A with appointment B must not move, duplicate, rewrite
-- or orphan money. The census of every FK referencing `public.appointments`:
--
--   appointment_payments        appointment_id NOT NULL, ON DELETE RESTRICT
--   payment_charge_attempts     appointment_id,          ON DELETE RESTRICT
--   manual_fee_charge_attempts  appointment_id NOT NULL, ON DELETE RESTRICT
--
-- All three are RESTRICT, which is the schema stating that these rows belong to
-- THAT appointment. None of them has any defined reschedule semantics: there is
-- no "move the card-on-file authorisation to the successor" concept anywhere in
-- the tree, and inventing one in a public, unauthenticated command would be a
-- money-handling decision made by an availability boundary.
--
-- So the command REFUSES instead, with `payment_state_requires_studio`: the
-- original stays confirmed, no successor is created, and the route tells the
-- visitor to contact the studio in generic copy.
--
-- Measured against production at the time of writing, this gate is INERT:
-- appointment_payments = 0 rows, manual_fee_charge_attempts = 0 rows, and all 20
-- payment_charge_attempts rows are `succeeded` against appointments that are
-- already completed/cancelled/no_show — ZERO attach to a confirmed FUTURE
-- appointment. `late_cancellation_fee` and `no_show_fee` are by definition
-- post-lifecycle, and `payment_charge_attempts_reason_shape_check` only requires
-- appointment_id for those two reasons. The gate therefore cannot fire on
-- today's traffic; it exists so that enabling the card-on-file booking flow
-- later cannot silently detach a payment from the appointment it paid for.
--
-- Terminal-dead attempts (`cancelled`, `failed`) are excluded from the gate:
-- they represent no live money and blocking on them would strand a client behind
-- a failed charge forever.
--
-- ---------------------------------------------------------------------------
-- LOCK ORDER
--
--   pre-read candidate studio id (NON-AUTHORITATIVE — see below)
--     -> studios FOR UPDATE
--     -> acquire_studio_capacity_lock (advisory)
--     -> appointments FOR UPDATE, ordered by id
--     -> authoritative re-read of the original UNDER those locks
--
-- This is the order `create_public_appointment` (0170) and
-- `move_or_reassign_appointment` already use (studios -> advisory -> appts).
-- NO path in the tree acquires the advisory lock AFTER an appointment row lock,
-- so there is no cycle. 0170 additionally locks `services` between the advisory
-- lock and the appointments; this command does NOT lock services, because it
-- reads no authoritative value from the service row (duration comes from the
-- LOCKED ORIGINAL APPOINTMENT, not from the service). Taking a strict subset of
-- an existing order introduces no new edge.
--
-- THE PRE-READ IS NOT AUTHORISATION. The caller supplies an appointment id and a
-- token hash but no studio, so the studio must be discovered before it can be
-- locked. That discovery read is deliberately unauthenticated and its result is
-- used for ONE thing only: choosing which studio row to lock. Every identity,
-- state, tenancy and token check is then re-run against the row re-read UNDER
-- the locks, so a row that changed between the two reads cannot be acted on.
--
-- ---------------------------------------------------------------------------
-- SUCCESSOR COLUMN MATRIX — every column decided, none left implicit
--
--   COPIED from the locked original:
--     studio_id, client_id, service_id, practitioner_id, notes, referral_source
--       (referral_source is a FIX: the legacy RPC dropped it, so a rescheduled
--        booking silently lost its attribution.)
--   AUTHORITATIVE, derived here:
--     starts_at   = validated v_new_starts_at (millisecond-exact)
--     ends_at     = starts_at + LOCKED ORIGINAL duration
--     duration_minutes = LOCKED ORIGINAL duration (never the service default)
--     status      = 'confirmed' (literal)
--     cancellation_token_hash = p_new_cancellation_token_hash
--     id          = generated HERE, before audit construction
--   LINEAGE:
--     rescheduled_from_appointment_id = original id
--     (the reverse direction is written onto the ORIGINAL in step F)
--   TRIGGER-DERIVED — never written by this command:
--     capacity_enabled          (set_appointment_capacity_enabled)
--     buffer_minutes_snapshot   (snapshot_appointment_buffer)
--     blocked_ends_at           (snapshot_appointment_buffer)
--     sync_version              (bump_appointment_sync_version -> 1 on INSERT)
--     created_at, updated_at    (column defaults)
--     the shadow reservation    (sync_appointment_to_calendar_reservation)
--   RESET by omission — left at column default, NEVER inherited:
--     booked_outside_availability (default false, so HB001 always arms; the
--       original's manual outside-availability override is NOT carried over)
--     cancellation_reason, cancelled_at, cancelled_by, cancellation_kind
--     rescheduled_to_appointment_id
--     every send-state column: confirmation_*, reminder_24h_*, reminder_2h_*,
--       no_show_email_*, postcare_email_*, sms_confirmation_*,
--       sms_reminder_24h_*, sms_reminder_2h_*, intake_reminder_7d_*,
--       intake_reminder_3d_* (sent_at / send_attempts / claimed_at / failed_at /
--       last_error / last_attempt_at). The successor is a NEW appointment and
--       must be able to send its own confirmation; inheriting a claim would
--       silently suppress it.
--
-- Migration max 0170 -> 0171.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. public.public_reschedule_slot_candidates
--
-- The exact set of replacement starts the public RESCHEDULE page would offer for
-- a local date, ported from lib/booking/slots.ts as called by the reschedule
-- surfaces after this PR: with the original appointment's own reservation
-- excluded, at the original appointment's duration, in the studio's CURRENT
-- capacity mode.
--
-- Differences from public_booking_slot_candidates (0170), and ONLY these:
--   * p_original_appointment_id excludes exactly one shadow row —
--     (source_kind = 'appointment', source_id = original). That pair is unique.
--     Every other reservation (other appointments, timed blocks, recurring-break
--     occurrences, full-day blockouts) remains a conflict, matching
--     slots.ts:270-277.
--   * p_practitioner_id + the studio's practitioner_capacity_enabled flag select
--     the loader's capacity-ON branch: practitioner-scoped availability rows beat
--     studio-wide ones (slots.ts:168-215) and reservations are filtered by
--     resource_key rather than studio_id (slots.ts:249-251).
--
-- Capacity ON requires BOTH the studio flag AND a non-null practitioner, exactly
-- as slots.ts:137-140 computes `capacityOn`. A capacity-ON studio whose original
-- appointment has no practitioner therefore falls back to the studio-wide
-- branch, which is what the loader does with `practitionerId = null`.
--
-- Everything else — the four anchor families, the HH:MM truncation of window
-- bounds, the millisecond precision domain, the service-end-before-close rule,
-- the trailing-buffer-may-spill-past-close rule, the 36-hour reservation window,
-- the half-open overlap test, the full-day blockout short-circuit — is the
-- reviewed 0170 logic, unchanged.
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
       and cr.ends_at   > v_win_start
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
            and cr2.ends_at   > v_win_start
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

comment on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) is
  'The exact set of public RESCHEDULE slot starts for a local date: the 0170 candidate port with the original appointment''s own shadow reservation excluded and the studio''s current capacity mode honoured (practitioner-scoped availability precedence and resource_key reservations when ON). Reuses public_booking_local_to_utc rather than reimplementing DST. Service-role only.';

-- ---------------------------------------------------------------------------
-- 2. public.validate_public_reschedule_slot
--
-- The public RESCHEDULE availability contract. Same shape and same closed-code
-- vocabulary as validate_public_booking_slot (0170), and it exists for the same
-- reason: so the command delegates one reviewed predicate instead of open-coding
-- five checks that could drift from the candidate generator beside them.
--
-- It is NOT the 0170 validator with a parameter added, because THREE of that
-- function's checks are wrong for a reschedule:
--
--   * the WORKING-HOURS WINDOW is resolved studio-wide only. That is correct for
--     public booking (unconditionally capacity-OFF) but wrong here: a capacity-ON
--     studio with practitioner-scoped availability rows would have every
--     replacement slot refused as `outside_availability` while the reschedule
--     page happily offered them. This resolves the window with the same
--     four-probe precedence the loader uses.
--   * the COLLISION test counts every shadow row in the studio, including the
--     reservation owned by the appointment being moved — so the original's own
--     interval, and every slot adjacent to it, would come back
--     `time_unavailable`.
--   * the MEMBERSHIP test uses the BOOKING candidate set, which knows nothing
--     about the exclusion or about capacity mode.
--
-- Everything else is deliberately identical to 0170: practitioner membership and
-- service eligibility, the full-day blockout, the millisecond-precision
-- rejection, the local-midnight rule, the SERVICE-end-before-close rule (the
-- trailing buffer MAY spill past close), and the half-open overlap rule.
-- ---------------------------------------------------------------------------

create or replace function public.validate_public_reschedule_slot(
  p_studio_id               uuid,
  p_practitioner_id         uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_ends_at                 timestamptz,
  p_original_appointment_id uuid
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
  v_cap_flag    boolean;
  v_cap_on      boolean;
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
  select s.timezone,
         greatest(coalesce(s.buffer_minutes, 0), 0),
         coalesce(s.practitioner_capacity_enabled, false)
    into v_tz, v_buffer, v_cap_flag
    from public.studios s
   where s.id = p_studio_id;
  if not found then
    return 'invalid_studio';
  end if;

  v_cap_on := v_cap_flag and p_practitioner_id is not null;

  -- Practitioner membership + service eligibility, identical to 0170. A NULL
  -- practitioner is legitimate for a capacity-OFF studio whose original was
  -- booked without one; the command enforces the capacity-ON requirement
  -- separately, before this is ever called.
  if p_practitioner_id is not null then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = p_practitioner_id
         and pr.studio_id = p_studio_id
         and pr.active = true
    ) then
      return 'invalid_practitioner';
    end if;

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

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    return 'invalid_time';
  end if;

  -- Sub-millisecond input is REJECTED, never truncated (0170's fourth
  -- amendment: validating a truncated value while persisting the raw one is two
  -- precision domains).
  if p_starts_at is distinct from date_trunc('milliseconds', p_starts_at)
     or p_ends_at is distinct from date_trunc('milliseconds', p_ends_at)
  then
    return 'invalid_time';
  end if;

  -- UTC -> local wall clock. This direction only; it is unambiguous.
  v_local_start := p_starts_at at time zone v_tz;
  v_local_end   := p_ends_at   at time zone v_tz;
  v_local_date  := v_local_start::date;
  v_end_date    := v_local_end::date;
  v_dow         := extract(dow from v_local_start)::int;
  v_start_time  := v_local_start::time;
  v_end_time    := v_local_end::time;

  -- Full-day blockout. studio_blockouts has no practitioner_id, so this is
  -- studio-wide in both capacity modes, exactly as the loader treats it.
  if exists (
    select 1 from public.studio_blockouts b
     where b.studio_id = p_studio_id
       and b.starts_on <= v_local_date
       and b.ends_on   >= v_local_date
  ) then
    return 'studio_closed';
  end if;

  -- Working-hours window, resolved with the loader's FOUR-PROBE precedence:
  -- practitioner override, studio-wide override, practitioner default,
  -- studio-wide default (lib/booking/slots.ts:168-229). A studio-wide OVERRIDE
  -- beats a practitioner-scoped DEFAULT, which is why this is ordered by level
  -- first and by scope second — the same order the candidate generator uses, so
  -- the two halves of this migration cannot disagree.
  v_found := false;
  if v_cap_on then
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = v_local_date
       and o.practitioner_id = p_practitioner_id
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found then
    select o.is_open, o.open_time, o.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_overrides o
     where o.studio_id = p_studio_id
       and o.effective_date = v_local_date
       and o.practitioner_id is null
     limit 1;
    if found then v_found := true; end if;
  end if;
  if not v_found and v_cap_on then
    select d.is_open, d.open_time, d.close_time
      into v_is_open, v_open, v_close
      from public.studio_availability_default d
     where d.studio_id = p_studio_id
       and d.day_of_week = v_dow
       and d.practitioner_id = p_practitioner_id
     limit 1;
    if found then v_found := true; end if;
  end if;
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

  -- The SERVICE end, not the buffered end; same HH:MM truncation the candidate
  -- generator applies to both its walk bounds and its UTC bounds.
  v_open  := date_trunc('minute', v_open);
  v_close := date_trunc('minute', v_close);
  if v_start_time < v_open or v_end_time > v_close then
    return 'outside_availability';
  end if;

  -- Collisions, read from the same shadow rows the RESCHEDULE loader reads:
  -- filtered by resource_key when capacity is ON and by studio_id when it is
  -- OFF, and with the original appointment's OWN reservation excluded. The
  -- candidate's protected interval carries the trailing buffer; the conflict's
  -- protected end is source-aware. Millisecond domain on BOTH sides.
  if exists (
    select 1
      from public.studio_calendar_reservations r
     where (
             case when v_cap_on
                  then r.resource_key = p_practitioner_id
                  else r.studio_id    = p_studio_id
             end
           )
       and not (r.source_kind = 'appointment'
                and p_original_appointment_id is not null
                and r.source_id = p_original_appointment_id)
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

  -- EXACT REPLACEMENT-SLOT MEMBERSHIP. Everything above proves the interval is
  -- legal; this proves it is one the reschedule page would actually OFFER.
  -- Both sides are already millisecond-normalised, so this is an exact equality
  -- and deliberately not a truncating comparison.
  if not exists (
    select 1
      from public.public_reschedule_slot_candidates(
             p_studio_id,
             v_local_date,
             (extract(epoch from (p_ends_at - p_starts_at)) / 60)::integer,
             p_original_appointment_id,
             p_practitioner_id
           ) c
     where c = p_starts_at
  ) then
    return 'not_a_public_slot';
  end if;

  return 'ok';
end;
$$;

comment on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
  'Public RESCHEDULE availability contract. Same closed-code vocabulary as validate_public_booking_slot, but resolves the working-hours window with the loader''s practitioner-scoped precedence, excludes the original appointment''s own shadow reservation from the collision test, and requires exact membership of the reschedule candidate set. Service-role only.';

-- ---------------------------------------------------------------------------
-- 3. public.reschedule_appointment_v2
--
-- The single authoritative mutation for a public token reschedule. Cancels the
-- original, creates the successor, writes both lineage directions, both audit
-- rows and the required policy acknowledgement — all in one transaction — and
-- returns enough authoritative state that the application never needs to re-read
-- the successor.
--
-- The caller supplies ONLY: which appointment, proof it holds that appointment's
-- current token, the requested new start, the successor's token hash, and the
-- acknowledgement pair. It cannot supply an end time, a duration, a studio, a
-- client, a service, a practitioner, a status, an outside-availability override,
-- a lineage id, audit JSON, policy text, or a cancellation kind.
-- ---------------------------------------------------------------------------

create or replace function public.reschedule_appointment_v2(
  p_original_appointment_id       uuid,
  p_current_cancellation_token_hash text,
  p_new_starts_at                 timestamptz,
  p_new_cancellation_token_hash   text,
  p_acknowledged_policy           boolean,
  p_presented_policy_snapshot_hash text default null
)
returns table (
  result                    text,
  original_appointment_id   uuid,
  new_appointment_id        uuid,
  studio_id                 uuid,
  client_id                 uuid,
  service_id                uuid,
  practitioner_id           uuid,
  original_starts_at        timestamptz,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  duration_minutes          integer,
  created_at                timestamptz,
  policy_acknowledgement_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_studio_id   uuid;
  v_orig        public.appointments%rowtype;
  v_tz          text;
  v_horizon     integer;
  v_cap_flag    boolean;
  v_cancel_text text;
  v_noshow_text text;
  v_now         timestamptz := now();
  v_new_starts  timestamptz;
  v_new_ends    timestamptz;
  v_duration    integer;
  v_local_date  date;
  v_today       date;
  v_win_start   timestamptz;
  v_win_end     timestamptz;
  v_new_id      uuid;
  v_created_at  timestamptz;
  v_ack_id      uuid;
  v_needs_ack   boolean;
  v_current_hash text;
  v_avail       text;
begin
  -- =========================================================================
  -- STEP A — RESOLVE, LOCK, AND AUTHENTICATE THE ORIGINAL
  -- =========================================================================

  -- Nothing is authorised yet. The caller gives an appointment id but no studio,
  -- so the studio has to be discovered before it can be locked. This read is
  -- used for exactly ONE purpose: choosing the studio row to lock. It proves
  -- nothing and is never trusted again.
  if p_original_appointment_id is null then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  select a.studio_id into v_studio_id
    from public.appointments a
   where a.id = p_original_appointment_id;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- LOCK ORDER: studios -> advisory -> appointments. Same order as 0170 and
  -- move_or_reassign_appointment; no path acquires the advisory lock after an
  -- appointment row lock, so no cycle exists.
  select s.timezone,
         coalesce(s.public_booking_horizon_months, 3),
         coalesce(s.practitioner_capacity_enabled, false),
         s.cancellation_policy_text,
         s.no_show_policy_text
    into v_tz, v_horizon, v_cap_flag, v_cancel_text, v_noshow_text
    from public.studios s
   where s.id = v_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(v_studio_id);

  -- SERIALIZE AGAINST APPOINTMENT-SOURCE MUTATION (the candidate-set race, and
  -- the duplicate-submit race).
  --
  -- A conflict-derived candidate exists only BECAUSE some appointment generates
  -- it. If that appointment is cancelled between validation and insert, the
  -- candidate silently stops being offered and nothing else rejects the write:
  -- with the conflict gone there is no GiST overlap and no HB001 gap. 0170
  -- documents this at length; the same hazard applies here.
  --
  -- This lock ALSO serialises two concurrent reschedules of the SAME original.
  -- The original is inside this set by construction — the predicate is a plain
  -- OR on its id, so it is locked even when its current start lies outside the
  -- replacement date window (moving an appointment from next month to next week
  -- is the normal case, and the window-only form would not have locked it).
  -- The second caller therefore blocks here, and when it proceeds its
  -- authoritative re-read below sees status = 'cancelled' and refuses with
  -- `appointment_not_reschedulable`.
  --
  -- SCOPE: the REPLACEMENT day's candidate window, plus the original. Not the
  -- whole studio, and not a wide fixed span — locking every future appointment
  -- would serialise unrelated work and, worse, would make the explicit
  -- `a.id = p_original_appointment_id` disjunct below redundant, so nothing
  -- would ever prove the original is locked at all.
  --
  -- The window matches public_reschedule_slot_candidates exactly: local
  -- midnight of the target date through +36 hours, which is the span over which
  -- it loads reservations. A 24-hour back-off catches an appointment that
  -- STARTED before that window but whose protected interval reaches into it.
  --
  -- THE ORIGINAL IS INCLUDED BY ID, UNCONDITIONALLY. Its current start is
  -- usually NOT in the replacement window — moving an appointment from next
  -- month to next week is the ordinary case — so a window-only predicate would
  -- leave the very row being mutated unlocked, and a concurrent cancel/
  -- complete/no-show could interleave between this command's validation and its
  -- UPDATE.
  --
  -- Deterministic id order prevents lock-order inversion between two callers
  -- locking overlapping sets.
  --
  -- p_new_starts_at is still unvalidated here; only its timezone projection is
  -- used, and a null simply yields a null date whose comparisons exclude every
  -- row, leaving the original locked on its own. Validation happens below.
  v_local_date := (coalesce(p_new_starts_at, v_now) at time zone v_tz)::date;
  v_win_start  := public.public_booking_local_to_utc(v_local_date, '00:00'::time, v_tz);
  v_win_end    := v_win_start + interval '36 hours';
  perform 1
     from public.appointments a
    where a.studio_id = v_studio_id
      and (
        a.id = p_original_appointment_id
        or (a.status in ('confirmed', 'completed')
            and a.starts_at < v_win_end
            and a.ends_at   > v_win_start - make_interval(mins => 24 * 60))
      )
    order by a.id
      for update;

  -- AUTHORITATIVE RE-READ, UNDER THE LOCKS. Every check below runs against this
  -- row, never against the pre-read. Identity AND token are re-verified together
  -- so a row that changed hands between the two reads cannot be acted on.
  select * into v_orig
    from public.appointments a
   where a.id = p_original_appointment_id
     and a.studio_id = v_studio_id;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- TOKEN. A wrong hash, a null hash, and a hash belonging to a DIFFERENT
  -- appointment all collapse to the same code as "no such appointment" — the
  -- public surface must not distinguish "valid token, wrong state" from
  -- "unknown token". `is distinct from` so a null stored hash never matches a
  -- null input.
  if p_current_cancellation_token_hash is null
     or v_orig.cancellation_token_hash is null
     or v_orig.cancellation_token_hash is distinct from p_current_cancellation_token_hash
  then
    return query select 'appointment_not_found'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- STATE. Cancelled / completed / no_show / already-started all collapse to one
  -- code. This is also the arm that refuses the LOSER of a duplicate submit.
  if v_orig.status <> 'confirmed' or v_orig.starts_at <= v_now then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- THE BOOKED CONTRACT. Duration comes from the LOCKED ORIGINAL, never from the
  -- service default and never from the caller: a reschedule MOVES a booking, it
  -- does not silently relength it because the studio edited the service after
  -- the client booked.
  v_duration := v_orig.duration_minutes;
  if v_duration is null or v_duration <= 0 then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- The client must still exist, belong to this studio, and not be archived.
  -- Rescheduling onto an archived client would resurrect a hidden record into
  -- the active calendar.
  if not exists (
    select 1 from public.clients c
     where c.id = v_orig.client_id
       and c.studio_id = v_studio_id
       and c.archived_at is null
  ) then
    return query select 'appointment_not_reschedulable'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- The successor's token hash must be well-formed. The column CHECK
  -- (`^[a-f0-9]{64}$`) would raise on a bad value; raising here would roll the
  -- transaction back with a raw constraint name, so it is refused cleanly first.
  if p_new_cancellation_token_hash is null
     or p_new_cancellation_token_hash !~ '^[a-f0-9]{64}$'
  then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- STEP B — VALIDATE THE REQUESTED NEW START
  -- =========================================================================

  -- ONE AUTHORITATIVE START VALUE. Sub-millisecond input is REJECTED, never
  -- truncated: validating a truncated value while persisting the raw one is two
  -- precision domains, which is exactly the defect 0170's fourth amendment
  -- closed. A browser ISO string is always millisecond-precise.
  if p_new_starts_at is null
     or p_new_starts_at is distinct from date_trunc('milliseconds', p_new_starts_at)
  then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;
  v_new_starts := p_new_starts_at;
  v_new_ends   := v_new_starts + make_interval(mins => v_duration);

  -- SAME-TIME NO-OP. Excluding the original's own reservation makes its current
  -- start legally free again, so without this it would be a valid candidate and
  -- the command would cancel-and-recreate purely to rotate the token — churning
  -- the audit trail, the Google event and the client's links for no change.
  -- Checked BEFORE the future/horizon rules so the visitor gets the accurate
  -- reason.
  if v_new_starts = v_orig.starts_at then
    return query select 'same_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  if v_new_starts <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- Booking horizon in the studio's LOCAL calendar. DAYS_PER_HORIZON_MONTH = 31
  -- (lib/booking/horizon.ts:28); both bounds inclusive there.
  v_today      := (v_now at time zone v_tz)::date;
  v_local_date := (v_new_starts at time zone v_tz)::date;
  if v_local_date < v_today or v_local_date > (v_today + (v_horizon * 31)) then
    return query select 'outside_horizon'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- POLICY FRESHNESS — prove WHAT was displayed, not merely that a box was
  -- ticked.
  -- =========================================================================
  --
  -- `hasAnyPolicy` semantics: TRIMMED emptiness decides whether an
  -- acknowledgement is required at all, so null / '' / whitespace-only all mean
  -- "no policy". The SNAPSHOT that gets hashed and stored is deliberately
  -- UNTRIMMED — it must be the exact column content the page rendered.
  --
  -- THE PREDICATE MUST MATCH JAVASCRIPT `String.prototype.trim()`, NOT
  -- `btrim()`. This is not pedantry: `hasAnyPolicy` decides on the PAGE whether
  -- to render the checkbox at all, and this decides in the COMMAND whether to
  -- demand one. If they disagree, the page renders no checkbox, the form posts
  -- no acknowledgement, and the command refuses every submission — public
  -- rescheduling is permanently broken for that studio with no way for the
  -- visitor to satisfy it.
  --
  -- Postgres `btrim(x)` with no second argument strips ONLY U+0020 spaces, so
  -- a policy of "   \n\t  " survives it non-empty while JS trims it to "".
  -- Measured on this schema: btrim(E'   \n\t  ') = E'\t'.
  --
  -- `[^[:space:]]` is the right family — in this UTF-8 database it covers
  -- space, tab, LF, CR, VT, FF and U+00A0 NBSP, matching JS on all of them.
  -- It does NOT cover U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM), which JS
  -- `trim()` DOES treat as whitespace, so U+FEFF is added to the class
  -- explicitly. Written as U&'\FEFF' rather than a literal character because a
  -- raw BOM in a .sql file is invisible and editors strip or relocate it.
  --
  -- Verified against JS for: whitespace mixes, NBSP-only, BOM-only, BOM+text,
  -- ordinary text and the empty string (tests/db/public-reschedule-command.db.test.ts).
  v_needs_ack := coalesce(v_cancel_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']')
              or coalesce(v_noshow_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']');

  if v_needs_ack then
    if coalesce(p_acknowledged_policy, false) is not true then
      return query select 'policy_ack_required'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;

    -- Byte-identical to buildPolicySnapshot(): coalesce each side to '' (NO
    -- trim), join with a literal LF, three hyphens, LF, and hash as lowercase
    -- SHA-256 hex. `encode` is a pg_catalog builtin; `digest` is pgcrypto, which
    -- this database installs into the `extensions` schema.
    v_current_hash := encode(
      extensions.digest(
        coalesce(v_cancel_text, '') || E'\n---\n' || coalesce(v_noshow_text, ''),
        'sha256'
      ),
      'hex'
    );

    -- A missing presented hash is treated as a mismatch, not as consent. An
    -- older client that posts only the checkbox must NOT be able to acknowledge
    -- unseen policy text.
    if p_presented_policy_snapshot_hash is null
       or lower(p_presented_policy_snapshot_hash) is distinct from v_current_hash
    then
      return query select 'policy_changed'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- =========================================================================
  -- FINANCIAL SAFETY — refuse rather than move money. See the header census.
  -- =========================================================================
  if exists (
        select 1 from public.appointment_payments ap
         where ap.appointment_id = v_orig.id
      )
     or exists (
        select 1 from public.payment_charge_attempts pca
         where pca.appointment_id = v_orig.id
           and pca.status not in ('cancelled', 'failed')
      )
     or exists (
        select 1 from public.manual_fee_charge_attempts mfa
         where mfa.appointment_id = v_orig.id
           and mfa.status not in ('cancelled', 'failed')
      )
  then
    return query select 'payment_state_requires_studio'::text, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- PRESERVED PRACTITIONER — never silently reassign.
  -- =========================================================================
  --
  -- The successor keeps the original's practitioner. There is no public
  -- practitioner selection, no "current owner" lookup, and no fallback to
  -- another practitioner: a client who booked with one person must not be moved
  -- to another by a self-service reschedule.
  --
  -- Under capacity ON the schema REQUIRES a practitioner on a confirmed row
  -- (appointments_capacity_requires_practitioner), and the preserved one must
  -- still be a valid, active member of this studio. When it is not, the command
  -- refuses — it does not pick a replacement. Under capacity OFF a null
  -- practitioner is preserved as null, exactly as the original was booked.
  if v_cap_flag then
    if v_orig.practitioner_id is null
       or not exists (
         select 1 from public.practitioners pr
          where pr.id = v_orig.practitioner_id
            and pr.studio_id = v_studio_id
            and pr.active = true
       )
    then
      return query select 'practitioner_unavailable'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;

    -- Service eligibility, only when the service HAS an eligibility list —
    -- identical shape to validate_public_booking_slot (0170), so a studio that
    -- never configured service_practitioners is unaffected.
    if v_orig.service_id is not null
       and exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = v_orig.service_id
       )
       and not exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = v_orig.service_id
            and sp.practitioner_id = v_orig.practitioner_id
       )
    then
      return query select 'practitioner_unavailable'::text, null::uuid, null::uuid, null::uuid,
                          null::uuid, null::uuid, null::uuid, null::timestamptz,
                          null::timestamptz, null::timestamptz, null::integer,
                          null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- =========================================================================
  -- AVAILABILITY + EXACT REPLACEMENT-SLOT MEMBERSHIP
  -- =========================================================================
  --
  -- ONE delegated predicate, evaluated UNDER the locks this command already
  -- holds. It enforces the full-day blockout, the working-hours window with the
  -- loader's practitioner-scoped precedence, the local-midnight rule, the
  -- SERVICE-end-before-close rule, the exclusion-aware collision test, and
  -- exact membership of the current reschedule candidate set — all with the
  -- PRESERVED practitioner and the original's reservation excluded.
  --
  -- Its membership arm is the authority that the requested instant is one the
  -- page would OFFER, not merely one that is legal. Without it a direct
  -- service-role call could move an appointment to 10:17 on an open,
  -- conflict-free day.
  v_avail := public.validate_public_reschedule_slot(
    v_studio_id, v_orig.practitioner_id, v_orig.service_id,
    v_new_starts, v_new_ends, v_orig.id
  );
  if v_avail <> 'ok' then
    -- `invalid_practitioner` and `not_eligible` are collapsed into the single
    -- practitioner code so the public surface never learns which of the two
    -- internal conditions failed. `invalid_studio` cannot occur — the studio row
    -- was locked above — but is mapped defensively rather than passed through as
    -- a code the route has no mapping for.
    if v_avail in ('invalid_practitioner', 'not_eligible') then
      v_avail := 'practitioner_unavailable';
    elsif v_avail = 'invalid_studio' then
      v_avail := 'appointment_not_found';
    end if;
    return query select v_avail, null::uuid, null::uuid, null::uuid,
                        null::uuid, null::uuid, null::uuid, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::integer,
                        null::timestamptz, null::uuid;
    return;
  end if;

  -- =========================================================================
  -- STEP C — GENERATE THE SUCCESSOR ID
  -- =========================================================================
  -- Generated HERE, before any audit is constructed, so the cancellation audit
  -- can name the successor and the successor audit can name the original without
  -- a second pass. The caller cannot supply it.
  v_new_id := extensions.gen_random_uuid();

  -- =========================================================================
  -- STEP D — CANCEL THE ORIGINAL
  -- =========================================================================
  -- cancellation_kind = 'rescheduled' is set in the SAME statement that flips
  -- the status. This is load-bearing, not cosmetic: enqueue_calendar_outbound
  -- inspects NEW.cancellation_kind on the cancelled-status branch and returns
  -- early when it is 'rescheduled'. Setting it in a later UPDATE would let the
  -- trigger see NULL and enqueue an event.delete for an appointment that is
  -- being MOVED, destroying the Google event the successor is about to adopt.
  update public.appointments a
     set status              = 'cancelled',
         cancelled_at        = v_now,
         cancelled_by        = 'client',
         cancellation_reason = 'Rescheduled via email link',
         cancellation_kind   = 'rescheduled',
         updated_at          = v_now
   where a.id = v_orig.id;

  -- =========================================================================
  -- STEP E — INSERT THE SUCCESSOR
  -- =========================================================================
  -- Column-by-column rationale is in the header matrix. Everything not listed
  -- here is either trigger-derived or deliberately reset to its default.
  --
  -- Aliased as `a` because this function's RETURNS TABLE puts `created_at`,
  -- `starts_at`, `ends_at` and the other output names in scope as PL/pgSQL
  -- variables; an unqualified RETURNING would be ambiguous.
  --
  -- 23P01 (GiST overlap) and HB001 (soft buffer) are deliberately NOT caught:
  -- they must roll the entire transaction back, leaving the original confirmed
  -- with its reservation and token intact. The route maps both to the same safe
  -- "that time is no longer available" copy.
  insert into public.appointments as a
    (id, studio_id, practitioner_id, client_id, service_id,
     starts_at, ends_at, duration_minutes, status,
     notes, referral_source, cancellation_token_hash,
     rescheduled_from_appointment_id)
  values
    (v_new_id, v_studio_id, v_orig.practitioner_id, v_orig.client_id, v_orig.service_id,
     v_new_starts, v_new_ends, v_duration, 'confirmed',
     v_orig.notes, v_orig.referral_source, p_new_cancellation_token_hash,
     v_orig.id)
  returning a.created_at into v_created_at;

  -- =========================================================================
  -- STEP F — COMPLETE THE REVERSE LINEAGE
  -- =========================================================================
  -- Must follow the successor INSERT: rescheduled_to_appointment_id is a FK to
  -- appointments(id), so the row has to exist first.
  --
  -- NO GOOGLE CHURN. bump_appointment_sync_version only bumps when starts_at,
  -- ends_at or status changes, and none of them changes here — so sync_version
  -- is unchanged. enqueue_calendar_outbound's cancelled-status branch requires
  -- (old.status <> 'cancelled' OR new.sync_version > old.sync_version); the
  -- original is already cancelled and the version is static, so BOTH are false
  -- and the trigger falls through to `return new` without enqueuing anything.
  -- The cancellation_kind guard is a second, independent line of defence.
  update public.appointments a
     set rescheduled_to_appointment_id = v_new_id,
         updated_at = v_now
   where a.id = v_orig.id;

  -- =========================================================================
  -- STEP G — BOTH AUDIT ROWS
  -- =========================================================================
  -- Shapes preserve the legacy canonical vocabulary exactly
  -- (`reason: rescheduled` + `new_appointment_id` on the original;
  -- `source: reschedule_link` + `original_appointment_id` on the successor) so
  -- existing readers are unaffected. `source: reschedule_link` is ADDED to the
  -- cancellation details for symmetry with every other audit row, which all
  -- carry a source.
  insert into public.appointment_audit
    (appointment_id, actor_type, actor_id, action, details)
  values
    (v_orig.id, 'client', null, 'cancelled',
     jsonb_build_object(
       'reason',             'rescheduled',
       'source',             'reschedule_link',
       'new_appointment_id', v_new_id
     ));

  insert into public.appointment_audit
    (appointment_id, actor_type, actor_id, action, details)
  values
    (v_new_id, 'client', null, 'created',
     jsonb_build_object(
       'source',                  'reschedule_link',
       'original_appointment_id', v_orig.id
     ));

  -- =========================================================================
  -- STEP H — THE POLICY ACKNOWLEDGEMENT, IN THIS TRANSACTION
  -- =========================================================================
  -- Linked to the ORIGINAL appointment, preserving the existing semantic: "the
  -- client accepted these policies before rescheduling appointment X", and X is
  -- what the token referenced. The snapshots stored are the exact current column
  -- values, and the hash is the one just proven to match what was displayed.
  --
  -- The route used to write this AFTER the RPC committed, in a statement whose
  -- error was logged and swallowed — so a confirmed reschedule could exist with
  -- no acknowledgement, which is precisely the evidence a fee dispute needs.
  if v_needs_ack then
    insert into public.appointment_policy_acknowledgements
      (studio_id, appointment_id, client_id, action,
       cancellation_policy_text_snapshot, no_show_policy_text_snapshot,
       policy_snapshot_hash)
    values
      (v_studio_id, v_orig.id, v_orig.client_id, 'reschedule',
       coalesce(v_cancel_text, ''), coalesce(v_noshow_text, ''),
       v_current_hash)
    returning id into v_ack_id;
  end if;

  -- =========================================================================
  -- STEP I — RETURN AUTHORITATIVE STATE
  -- =========================================================================
  -- Everything the caller needs to send the confirmation, notify the correct
  -- practitioner and build the management links comes straight from what was
  -- just written. No post-commit re-read of the successor is required, and
  -- therefore no post-commit read failure can turn a committed reschedule into
  -- a reported failure — which matters because the raw successor token lives
  -- only in the caller's memory and only its SHA-256 is persisted, so a lost
  -- confirmation email is unrecoverable.
  return query select 'success'::text, v_orig.id, v_new_id, v_studio_id,
                      v_orig.client_id, v_orig.service_id, v_orig.practitioner_id,
                      v_orig.starts_at, v_new_starts, v_new_ends, v_duration,
                      v_created_at, v_ack_id;
  return;
end;
$$;

comment on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) is
  'Atomic public reschedule: authenticates the original by token under the studio lock, preserves its duration/service/practitioner, requires exact membership of the CURRENT reschedule candidate set (original reservation excluded), proves the acknowledged policy is the one displayed, then cancels the original with cancellation_kind=rescheduled, inserts the successor with rescheduled_from_appointment_id, completes the reverse lineage, writes both audits and the acknowledgement — all in one transaction — and returns authoritative successor state so no post-commit re-read is needed. Refuses rather than moving payment state. Service-role only.';

-- ---------------------------------------------------------------------------
-- 3. PRIVILEGES
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time, so all three are revoked BY NAME (plus
-- PUBLIC) before service_role is granted back. Missing one of these is how 0129
-- (anon) and 0164 (service_role) each shipped a hole. Written as literal
-- per-signature statements — never a DO-block with format() — because the grant
-- guards read them textually.
--
-- The legacy public.reschedule_appointment is deliberately untouched: its
-- service_role EXECUTE remains so the currently deployed application keeps
-- working if this migration is applied before the deploy.
-- ---------------------------------------------------------------------------

revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from public;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from anon;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from authenticated;
revoke execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) from service_role;

revoke execute on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from anon;
revoke execute on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from authenticated;
revoke execute on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from service_role;

revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from public;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from anon;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from authenticated;
revoke execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) from service_role;

grant execute on function public.public_reschedule_slot_candidates(uuid, date, integer, uuid, uuid) to service_role;
grant execute on function public.validate_public_reschedule_slot(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.reschedule_appointment_v2(uuid, text, timestamptz, text, boolean, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION (run manually; nothing below is executed)
-- ---------------------------------------------------------------------------
--
-- -- 1. all three functions exist, are SECURITY DEFINER, pin an empty
-- --    search_path, and carry the exact identity arguments granted below.
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid) as identity_args,
--        p.prosecdef                               as security_definer,
--        array_to_string(p.proconfig, ',')         as config
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('public_reschedule_slot_candidates',
--                      'validate_public_reschedule_slot',
--                      'reschedule_appointment_v2')
--  order by 1;
-- -- EXPECT 3 rows; security_definer = t; config = search_path="" for each.
--
-- -- 2. EXECUTE reaches service_role ONLY, for all three.
-- select p.proname, r.rolname,
--        has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   cross join pg_roles r
--  where n.nspname = 'public'
--    and p.proname in ('public_reschedule_slot_candidates',
--                      'validate_public_reschedule_slot',
--                      'reschedule_appointment_v2')
--    and r.rolname in ('anon', 'authenticated', 'service_role')
--  order by 1, 2;
-- -- EXPECT 9 rows: anon = f and authenticated = f everywhere,
-- --                service_role = t everywhere.
--
-- -- 3. the LEGACY RPC is still present and still service-role executable.
-- select p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'reschedule_appointment';
-- -- EXPECT 1 row, true. Retirement is a LATER migration.
--
-- -- 4. appointment table grants are UNCHANGED by this migration.
-- select r.rolname,
--        has_table_privilege(r.oid, 'public.appointments', 'INSERT') as ins,
--        has_table_privilege(r.oid, 'public.appointments', 'UPDATE') as upd,
--        has_table_privilege(r.oid, 'public.appointments', 'DELETE') as del
--   from pg_roles r where r.rolname in ('anon', 'authenticated');
-- -- EXPECT both roles still TRUE on all three. This migration revokes NOTHING.
-- ---------------------------------------------------------------------------
