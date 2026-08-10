-- ===========================================================================
-- APPOINTMENT BOUNDARY B6 — transition integrity + explicit early completion
-- ===========================================================================
--
-- Five responsibilities, and deliberately nothing else:
--
--   A. mark_appointment_complete moves its temporal gate from ends_at to
--      starts_at, so a practitioner may explicitly complete a visit that has
--      begun rather than being made to wait for a clock that has nothing to do
--      with whether treatment finished.
--   B. a structural status-transition guard on public.appointments.
--   C. DB-authoritative appointments.updated_at.
--   D. the capacity_enabled snapshot stops being re-derived by status changes.
--   E. three caller-less legacy RPCs are dropped.
--
-- WHAT THIS FILE DOES NOT TOUCH, on purpose
-- ---------------------------------------------------------------------------
--   * `snapshot_appointment_buffer()` — STANDING PROHIBITION. Production
--     carries out-of-band GUC behaviour in that function which is not fully
--     represented in this repository's migration source, so re-emitting it
--     from repo source could delete live production behaviour. Its body is not
--     copied, referenced or replaced here. A static test asserts that.
--   * `mark_appointment_no_show` — no-show stays gated on `ends_at`. The
--     asymmetry is the point: completion is a practitioner asserting treatment
--     finished; no-show is the booked opportunity having fully elapsed.
--   * `create_or_claim_charge_attempt` — dormant, zero application callers,
--     and its stale `ends_at` guard is P3 dead-code cleanup owned elsewhere.
--   * `public_cancel_appointment_with_token` — B7 / 0176.
--   * postcare writers and the six-column service_role grant — B8 / 0177.
--
-- CAPACITY IS NOT RELEASED BY COMPLETION. Completing early changes lifecycle
-- state only. starts_at, ends_at, duration_minutes, buffer_minutes_snapshot
-- and blocked_ends_at are all untouched, so a 14:00–15:00 appointment
-- completed at 14:25 still reserves its tail through 15:00. The booked
-- interval remains scheduling truth.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- GROUP A — explicit completion becomes legal at starts_at
-- ---------------------------------------------------------------------------
-- Same signature, same authorization, same lock, same audit action. The ONLY
-- semantic change is which timestamp gates the transition, plus the refusal
-- copy that must now describe the real rule.
--
-- `marked_complete` is preserved verbatim because revert_appointment_outcome
-- (B4 / 0173) reads that audit baseline to decide what it is reverting.
-- Renaming it would silently break the repair command.
--
-- Inclusive boundary, no grace period: `starts_at > now()` refuses, so exactly
-- starts_at is allowed and starts_at minus one second is not.
create or replace function public.mark_appointment_complete(
  p_appointment_id  uuid,
  p_studio_id       uuid,
  p_practitioner_id uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_starts_at timestamptz;
begin
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_practitioner_id and p.studio_id = p_studio_id and p.active = true
  ) then
    raise exception 'practitioner is not an active member of this studio'
      using errcode = '42501';
  end if;

  select a.status, a.starts_at into v_status, v_starts_at
  from public.appointments a
  where a.id = p_appointment_id and a.studio_id = p_studio_id
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if v_status <> 'confirmed' then
    raise exception 'appointment is not confirmed (current: %)', v_status using errcode = 'P0002';
  end if;
  -- B6: the visit must have STARTED. It need not have ended — the practitioner
  -- is the authority on whether treatment finished.
  if v_starts_at > now() then
    raise exception 'appointment has not started yet' using errcode = 'P0002';
  end if;

  -- Lifecycle only. No interval, buffer or reservation column is written here,
  -- so the booked capacity survives the completion untouched.
  update public.appointments a
     set status = 'completed', updated_at = now()
   where a.id = p_appointment_id and a.studio_id = p_studio_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'marked_complete',
    jsonb_build_object('marked_at', now())
  );
end;
$$;

revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_appointment_complete(uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- GROUP B — structural status-transition guard
-- ---------------------------------------------------------------------------
-- WHAT THIS IS: a predicate over (old_status, new_status). Nothing more.
--
-- WHAT IT IS DELIBERATELY NOT: it derives no actor, infers no business action
-- and writes no appointment_audit row. The governed commands remain the sole
-- semantic authority and the sole audit-event writers; a trigger that invented
-- events would attribute an action to whoever happened to hold the connection.
-- It also has no bypass GUC and no service_role special case — WHO may write is
-- already decided by the privilege boundary B3/0172 installed, and WHICH edges
-- may exist is decided here. Two different questions, two different mechanisms.
--
-- The three terminal -> confirmed edges exist ONLY because
-- revert_appointment_outcome (B4 / 0173) is the governed repair path. Their
-- presence here is structural permission, not an application API: raw terminal
-- -> confirmed is still refused to anon/authenticated by privilege, and to
-- service_role by 0174's lifecycle revocation.
create or replace function public.appointment_transition_allowed(
  p_old_status text,
  p_new_status text
) returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select (p_old_status, p_new_status) in (
    ('confirmed', 'completed'),
    ('confirmed', 'cancelled'),
    ('confirmed', 'no_show'),
    ('completed', 'confirmed'),
    ('cancelled', 'confirmed'),
    ('no_show',   'confirmed')
  );
$$;

comment on function public.appointment_transition_allowed(text, text) is
  'B6/0175. Structural lifecycle edge predicate for public.appointments. Pure: '
  'no actor, no audit, no business meaning. terminal->confirmed exists for the '
  'governed revert_appointment_outcome repair command only.';

create or replace function public.enforce_appointment_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- BEFORE UPDATE OF status, so an INSERT of a new confirmed appointment is
  -- unaffected and an UPDATE that does not touch status never reaches here.
  if new.status is distinct from old.status then
    if not public.appointment_transition_allowed(old.status, new.status) then
      raise exception
        'illegal appointment status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  else
    -- Same-status rewrite. Explicitly refused rather than ignored: an UPDATE
    -- that names status and changes nothing is either a no-op worth removing
    -- or an attempt to re-stamp a terminal row.
    raise exception
      'illegal appointment status transition: % -> % (no-op status rewrite)',
      old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_enforce_transition_trg on public.appointments;
create trigger appointments_enforce_transition_trg
  before update of status on public.appointments
  for each row
  execute function public.enforce_appointment_transition();

-- ---------------------------------------------------------------------------
-- GROUP C — DB-authoritative updated_at
-- ---------------------------------------------------------------------------
-- Until now every appointment command assigned `updated_at = now()` by hand,
-- which means the guarantee was only as good as the next writer remembering.
-- public.set_updated_at() is this repository's established helper (0015, and
-- reused by session_blocks and others), so no second timestamp framework is
-- introduced. Being a BEFORE trigger it overwrites whatever the caller sent,
-- so a stale caller-supplied updated_at cannot suppress the server clock.
-- created_at is not touched.
drop trigger if exists appointments_set_updated_at_trg on public.appointments;
create trigger appointments_set_updated_at_trg
  before update on public.appointments
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- GROUP D — capacity_enabled stops following lifecycle
-- ---------------------------------------------------------------------------
-- The 0134 trigger fired on `update of studio_id, practitioner_id, status`, so
-- completing or cancelling an appointment re-read the studio's CURRENT
-- practitioner_capacity_enabled and overwrote the value snapshotted at booking
-- time. A studio that changed the setting after a booking would therefore see
-- that booking silently adopt the new setting merely by reaching a terminal
-- state.
--
-- capacity_enabled is booking/resource state, not lifecycle state. Only the
-- trigger DEFINITION changes: set_appointment_capacity_enabled() itself is left
-- exactly as 0134 wrote it, because the function is correct — it was being
-- called at the wrong times.
drop trigger if exists appointments_set_capacity_enabled_trg on public.appointments;
create trigger appointments_set_capacity_enabled_trg
  before insert or update of studio_id, practitioner_id
  on public.appointments
  for each row
  execute function public.set_appointment_capacity_enabled();

-- ---------------------------------------------------------------------------
-- GROUP E — retire three caller-less legacy RPCs
-- ---------------------------------------------------------------------------
-- Each has a shipped successor and ZERO application callers across app/, lib/,
-- components/ and scripts/ — a census run with positive controls that located
-- 1+ callers of each successor, so the zeros are evidence rather than a failed
-- search.
--
-- EXACT SIGNATURES, never a name-only drop: a bare `drop function foo` is
-- ambiguous under overloading and would take whatever happens to be installed.
--
--   reschedule_appointment        -> reschedule_appointment_v2      (0171)
--   practitioner_move_appointment -> move_or_reassign_appointment   (0174)
--   create_internal_appointment   -> create_internal_appointment_v2 (0174)
drop function if exists public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
);
drop function if exists public.practitioner_move_appointment(
  uuid, uuid, uuid, timestamptz, timestamptz, timestamptz
);
drop function if exists public.create_internal_appointment(
  uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text
);

commit;
