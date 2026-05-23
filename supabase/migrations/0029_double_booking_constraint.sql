-- Migration 0029: DB-level double-booking prevention + atomic
-- reschedule, using snapshotted buffer-aware blocked windows.
--
-- The earlier draft of this migration constrained the raw
-- [starts_at, ends_at) window. That did NOT match the real conflict
-- rule used by lib/booking/slots.ts, which expands each appointment
-- by studio.buffer_minutes on both sides before checking overlap.
-- Result: two appointments could satisfy the raw constraint while
-- still violating the buffer rule (e.g. 10:00 to 11:00 and 11:10 to
-- 11:40 with a 15 minute buffer).
--
-- This revision stores the buffered window per appointment so the
-- DB exclusion constraint enforces the same rule the UI does, AND
-- so existing appointments keep their original protected window if
-- the studio later changes its buffer_minutes setting.
--
-- Pieces, in order:
--
--   1. blocked_starts_at / blocked_ends_at columns on appointments.
--   2. Backfill from each studio's current buffer_minutes.
--   3. Diagnostic (manual paste; must return 0 rows).
--   4. NOT NULL + range/containment check constraints.
--   5. btree_gist extension.
--   6. Exclusion constraint on the BLOCKED window per studio.
--   7. reschedule_appointment RPC with token verification, buffer-
--      aware blocked-window computation, and notes preservation.
--   8. Revoke execute from public/anon/authenticated; grant to
--      service_role only.
--
-- Half-open interval [blocked_starts_at, blocked_ends_at) so an
-- appointment whose blocked window ends at 11:15 does NOT conflict
-- with one whose blocked window starts at 11:15.
--
-- SOLO-PRACTITIONER SCOPE: the constraint is studio-scoped on
-- purpose. Before multi-practitioner concurrent booking, revise to
-- constrain by practitioner_id or a bookable-resource id.
--
-- Re-runnable: every alter is guarded with drop constraint if exists
-- or add column if not exists; backfill is guarded by `is null`;
-- function uses create or replace with explicit drops of any prior
-- signatures.

-- ---------------------------------------------------------------------------
-- Step 1: blocked-window columns. Nullable initially so the backfill
-- in step 2 can populate existing rows before NOT NULL tightens.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists blocked_starts_at timestamptz,
  add column if not exists blocked_ends_at timestamptz;

-- ---------------------------------------------------------------------------
-- Step 2: backfill from studios.buffer_minutes. Guarded by `is null`
-- so re-running the migration does not reset values for rows that
-- already received the columns.
-- ---------------------------------------------------------------------------
update public.appointments a
set blocked_starts_at = a.starts_at - (s.buffer_minutes || ' minutes')::interval,
    blocked_ends_at   = a.ends_at   + (s.buffer_minutes || ' minutes')::interval
from public.studios s
where a.studio_id = s.id
  and a.blocked_starts_at is null;

-- ---------------------------------------------------------------------------
-- Step 3 (manual): run the diagnostic below and confirm 0 rows
-- before continuing. If it returns anything, stop and investigate
-- before tightening NOT NULL or adding the exclusion constraint.
--
-- select id, studio_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at
-- from public.appointments
-- where blocked_starts_at is null
--    or blocked_ends_at is null
--    or blocked_ends_at <= blocked_starts_at
--    or blocked_starts_at > starts_at
--    or blocked_ends_at < ends_at;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Step 4: tighten the blocked-window columns to NOT NULL plus
-- invariant checks. The window must be positive and must fully
-- contain the raw appointment window.
-- ---------------------------------------------------------------------------
alter table public.appointments
  alter column blocked_starts_at set not null,
  alter column blocked_ends_at set not null;

alter table public.appointments
  drop constraint if exists appointments_blocked_window_valid;
alter table public.appointments
  add constraint appointments_blocked_window_valid
  check (blocked_ends_at > blocked_starts_at);

alter table public.appointments
  drop constraint if exists appointments_blocked_window_contains_appointment;
alter table public.appointments
  add constraint appointments_blocked_window_contains_appointment
  check (blocked_starts_at <= starts_at and blocked_ends_at >= ends_at);

-- ---------------------------------------------------------------------------
-- Step 5: btree_gist for uuid equality inside the gist exclusion.
-- Idempotent.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Step 6: exclusion constraint on the BLOCKED window per studio.
-- The predicate matches lib/booking/slots.ts: only confirmed rows
-- block availability. Cancelled, completed, and no_show rows do
-- not, so cancellation re-opens the slot immediately.
-- ---------------------------------------------------------------------------
alter table public.appointments
  drop constraint if exists no_overlapping_active_appointments_per_studio;
alter table public.appointments
  add constraint no_overlapping_active_appointments_per_studio
  exclude using gist (
    studio_id with =,
    tstzrange(blocked_starts_at, blocked_ends_at, '[)') with &&
  ) where (status = 'confirmed');

-- ---------------------------------------------------------------------------
-- Step 7: atomic reschedule RPC.
--
-- Cancels the original, inserts the replacement with computed
-- blocked window, writes both audit rows. All four DB operations
-- live in one transaction so any failure (including the exclusion
-- constraint firing) rolls back to the pre-reschedule state.
--
-- Token verification: the caller must supply the current
-- cancellation_token alongside the id. Mismatched tokens or missing
-- rows both return 'appointment_not_found' so a probing caller
-- cannot distinguish them.
--
-- Returned result values:
--   'success'                       - new appointment created
--   'appointment_not_found'         - id missing OR token mismatch
--   'appointment_not_reschedulable' - status is not 'confirmed'
--   'invalid_time_range'            - new ends_at <= new starts_at
--
-- The exclusion-violation case is NOT returned as a string. Postgres
-- raises sqlstate 23P01 (exclusion_violation), PostgREST surfaces it
-- on the response, and the application catches it.
-- ---------------------------------------------------------------------------
drop function if exists public.reschedule_appointment(
  uuid, timestamptz, timestamptz, integer, text
);
drop function if exists public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
);

create or replace function public.reschedule_appointment(
  p_original_appointment_id uuid,
  p_current_cancellation_token text,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_duration_minutes integer,
  p_new_cancellation_token text,
  p_studio_buffer_minutes integer
) returns table (
  result text,
  new_appointment_id uuid,
  error_detail text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.appointments%rowtype;
  v_new_id uuid;
  v_blocked_start timestamptz;
  v_blocked_end timestamptz;
begin
  select * into v_original
  from public.appointments
  where id = p_original_appointment_id
  for update;

  if not found
     or v_original.cancellation_token is null
     or v_original.cancellation_token <> p_current_cancellation_token
  then
    return query select 'appointment_not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_original.status <> 'confirmed' then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        format('current status: %s', v_original.status);
    return;
  end if;

  if p_new_ends_at <= p_new_starts_at then
    return query select 'invalid_time_range'::text, null::uuid, null::text;
    return;
  end if;

  v_blocked_start := p_new_starts_at - (p_studio_buffer_minutes || ' minutes')::interval;
  v_blocked_end   := p_new_ends_at   + (p_studio_buffer_minutes || ' minutes')::interval;

  update public.appointments
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = 'client',
        cancellation_reason = 'Rescheduled via email link',
        updated_at = now()
    where id = p_original_appointment_id;

  insert into public.appointments (
    studio_id,
    practitioner_id,
    client_id,
    service_id,
    starts_at,
    ends_at,
    duration_minutes,
    status,
    notes,
    cancellation_token,
    blocked_starts_at,
    blocked_ends_at
  )
  values (
    v_original.studio_id,
    v_original.practitioner_id,
    v_original.client_id,
    v_original.service_id,
    p_new_starts_at,
    p_new_ends_at,
    p_new_duration_minutes,
    'confirmed',
    v_original.notes,
    p_new_cancellation_token,
    v_blocked_start,
    v_blocked_end
  )
  returning id into v_new_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    p_original_appointment_id,
    'client',
    null,
    'cancelled',
    jsonb_build_object(
      'reason', 'rescheduled',
      'new_appointment_id', v_new_id
    )
  );

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    v_new_id,
    'client',
    null,
    'created',
    jsonb_build_object(
      'source', 'reschedule_link',
      'original_appointment_id', p_original_appointment_id
    )
  );

  return query select 'success'::text, v_new_id, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 8: tighten execute permissions. The RPC is service_role only.
-- Token verification inside the function is defense in depth; the
-- grant model is the primary access control.
-- ---------------------------------------------------------------------------
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
) from public;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
) from anon;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
) from authenticated;
grant execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
) to service_role;
