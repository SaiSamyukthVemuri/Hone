-- Migration 0029: DB-level double-booking prevention + atomic
-- reschedule.
--
-- Two parts:
--
--   1. Exclusion constraint preventing overlapping confirmed
--      appointments within a single studio. Half-open interval
--      [starts_at, ends_at) so back-to-back appointments (one
--      ending at 10:00, next starting at 10:00) are allowed.
--
--   2. reschedule_appointment(): a single-transaction RPC that
--      cancels the original row, inserts the replacement, and writes
--      both audit rows. If anything in the body fails (including the
--      exclusion constraint firing on the new row), the entire
--      transaction rolls back and the original appointment stays
--      confirmed.
--
-- When the constraint fires, Postgres raises sqlstate 23P01
-- (exclusion_violation). App code catches that code specifically and
-- returns a clean "slot just taken" message. A rejected booking does
-- not trigger a confirmation email.
--
-- SOLO-PRACTITIONER SCOPE: the constraint is studio-scoped on
-- purpose for the current launch model. Before enabling concurrent
-- multi-practitioner public booking, revise the predicate to
-- constrain by practitioner_id (or a bookable-resource id). This is
-- a known limitation, documented here, not a bug.
--
-- Re-runnable: btree_gist is idempotent, the constraint is dropped
-- before being re-added, the function uses create or replace.

-- Step 1: enable btree_gist so uuid equality can participate in a
-- gist exclusion constraint alongside the tstzrange overlap check.
create extension if not exists btree_gist;

-- Step 2: exclusion constraint.
-- The predicate matches lib/booking/slots.ts which treats only
-- status = 'confirmed' as blocking availability. Cancelled,
-- completed, and no_show rows are excluded so the slot becomes
-- immediately re-bookable on cancellation or no-show flip.
alter table public.appointments
  drop constraint if exists no_overlapping_active_appointments_per_studio;
alter table public.appointments
  add constraint no_overlapping_active_appointments_per_studio
  exclude using gist (
    studio_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed');

-- Step 3: atomic reschedule RPC.
--
-- Locks the original row FOR UPDATE, cancels it, inserts the
-- replacement, writes both audit rows. All four operations live in
-- the same transaction so any failure rolls back to the
-- pre-reschedule state.
--
-- Return shape is a single-row table so the caller can branch on
-- result without parsing exception text.
--
-- Returned result values:
--   'success'                       - new appointment created
--   'appointment_not_found'         - id does not exist
--   'appointment_not_reschedulable' - status is not 'confirmed'
--   'invalid_time_range'            - new ends_at <= new starts_at
--
-- The exclusion-violation case is NOT returned as a string. Postgres
-- raises sqlstate 23P01, PostgREST surfaces it on the response, and
-- the app catches it the same way the direct INSERT paths do.
--
-- p_new_duration_minutes is accepted as an explicit parameter
-- (rather than derived from the range) so the caller stays in
-- control of slot-granularity rounding.
create or replace function public.reschedule_appointment(
  p_original_appointment_id uuid,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_duration_minutes integer,
  p_new_cancellation_token text
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
begin
  select * into v_original
  from public.appointments
  where id = p_original_appointment_id
  for update;

  if not found then
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
    cancellation_token
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
    null,
    p_new_cancellation_token
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
